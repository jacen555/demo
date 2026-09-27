/**
 * S10 — subtitle sidecars from the measured timeline.
 *
 * `timing.json` already carries WORD-LEVEL boundaries (`segments[].audio.words[]` with
 * `{word, startMs, endMs}`), written by voice.mjs from the TTS word-boundary metadata. So
 * subtitles need no ASR, no alignment pass and no guessing — cue times come straight off
 * the timeline and cannot drift from the audio.
 *
 * Emits WebVTT and SRT beside timing.json. Optionally muxes an `mov_text` track into the
 * MP4 as a second output, because sidecars get separated from the file when it is shared.
 *
 * Cue shaping follows the caption-reading-speed guidance in references/planning.md §3:
 * <=2 lines, ~42 chars/line, and <= ~20 characters per second of cue time. That number is
 * distinct from narration pacing (~120-150 wpm) and measures a different thing.
 *
 * Usage:
 *   node write-subtitles.mjs                 # -> <project>.vtt and <project>.srt
 *   node write-subtitles.mjs --embed         # also mux mov_text into <project>-with-music.mp4
 *   node write-subtitles.mjs --max-cps 18    # tighten the reading-speed ceiling
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EXIT, CliError, guard, parseBoundedNumber } from './cli-support.mjs';
import { isSilentSegment, silentSegmentProblems, silentCaption } from './silent-segment.mjs';

const projectDir = process.cwd();
const argv = process.argv.slice(2);
const flag = n => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};

// VALIDATE, DO NOT COERCE. `Number('abc')` is NaN, and every comparison against NaN is
// false — so a bad --max-line disabled the over-width check AND the wrappability check
// while the report cheerfully said "all within". Measured: `--max-line abc` reported
// "limit NaN, all within" on a run whose longest line was 120 characters. That is a check
// that cannot fail, in the file whose wrapping bug this same round fixed.
const num = (name, dflt, min, max) => guard(() =>
  parseBoundedNumber(String(opt(name, dflt)), { name: `--${name}`, min, max }));

const MAX_LINE = num('max-line', 42, 10, 120);
const MAX_LINES = 2;
const MAX_CPS = num('max-cps', 20, 5, 60);
const MIN_CUE_MS = num('min-cue', 900, 100, 10000);

const safeFileBase = (name, fallback) => {
  const base = path.basename(String(name ?? '')).replace(/[^A-Za-z0-9._-]+/g, '').replace(/^[-.]+|[-.]+$/g, '');
  return base || fallback;
};
const timing = JSON.parse(fs.readFileSync(path.join(projectDir, 'timing.json'), 'utf8'));
const projectName = safeFileBase(timing.project?.name, safeFileBase(path.basename(projectDir), 'video'));

// ---- collect words, and fail loudly if the timeline was never synthesised -------------
// The TTS word-boundary metadata carries BARE words — punctuation is stripped. Cueing on
// those directly never sees a sentence end, so cues break mid-clause and read badly. Walk
// the segment's own voiceoverText in parallel and emit the SOURCE token (with its
// punctuation) against the measured timing of the metadata token.
function restorePunctuation(sourceText, metaWords) {
  const src = sourceText.trim().split(/\s+/);
  const bare = s => s.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  const out = [];
  let si = 0;
  for (const mw of metaWords) {
    const target = bare(mw.word);
    let hit = -1;
    // Look ahead a short way: TTS occasionally splits or merges a token.
    for (let k = si; k < Math.min(si + 4, src.length); k++) {
      if (bare(src[k]) === target || (target && bare(src[k]).startsWith(target))) { hit = k; break; }
    }
    if (hit === -1) { out.push({ ...mw, text: mw.word }); continue; }
    // Any tokens skipped over belong to this cue too — attach them rather than dropping.
    const text = src.slice(si, hit + 1).join(' ');
    si = hit + 1;
    out.push({ ...mw, text });
  }
  if (si < src.length && out.length) out.at(-1).text += ' ' + src.slice(si).join(' ');
  return out;
}

const words = [];
const silentCues = [];
for (const seg of timing.segments ?? []) {
  // A DELIBERATELY SILENT SEGMENT IS NOT AN UNSYNTHESISED ONE.
  //
  // Both have no `audio.words`, so the error below used to fire on both — naming a cause
  // ("run voice.mjs") that is simply wrong for an intermission, and telling the author to
  // re-run a stage that would not have helped. The declaration separates them.
  //
  // There are no measured word boundaries to caption from, so the cue text is AUTHORED on
  // the segment and spans its whole window. That is the accessibility contract: a viewer
  // reading captions is told "[music]" rather than being shown nothing at all and left to
  // wonder whether the captions broke.
  if (isSilentSegment(seg)) {
    const problems = silentSegmentProblems(seg);
    if (problems.length) throw new CliError(problems[0], EXIT.FAILED);
    silentCues.push({ startMs: seg.startMs, endMs: seg.endMs, text: silentCaption(seg), silent: true });
    continue;
  }
  const w = seg.audio?.words;
  if (!Array.isArray(w) || !w.length) {
    throw new Error(
      `segment "${seg.id}" has no audio.words — run voice.mjs (S3) first. ` +
      `Subtitles are generated from measured word boundaries, not from the script. ` +
      `(If this segment is meant to be silent, declare it with a "silence" block instead.)`);
  }
  for (const x of restorePunctuation(seg.voiceoverText, w)) words.push({ ...x, seg: seg.id });
}
words.sort((a, b) => a.startMs - b.startMs);

// ---- split into cues at sentence and clause boundaries, not fixed windows -------------
// A cue that breaks mid-clause is harder to read than a slightly long one, so break points
// are punctuation first, then reading speed, then length. Never cross a segment boundary —
// a cue spanning a 1.8s gap would sit on screen through silence.
const ENDS_SENTENCE = /[.!?]["')\]]?$/;
const ENDS_CLAUSE = /[,;:—–]["')\]]?$/;

const cues = [];
let cur = [];
const cueText = ws => ws.map(w => w.text).join(' ').replace(/\s+([,.;:!?])/g, '$1').trim();
const flush = () => {
  if (!cur.length) return;
  cues.push({ startMs: cur[0].startMs, endMs: cur.at(-1).endMs, text: cueText(cur) });
  cur = [];
};

for (let i = 0; i < words.length; i++) {
  const w = words[i], next = words[i + 1];
  cur.push(w);
  const text = cueText(cur);
  const spanMs = Math.max(w.endMs - cur[0].startMs, 1);
  const cps = text.length / (spanMs / 1000);

  const segmentBreak = next && next.seg !== w.seg;
  const sentence = ENDS_SENTENCE.test(w.text);
  // Break early enough that the NEXT word will not push the cue over either ceiling.
  const projected = next ? text.length + 1 + next.text.length : text.length;
  const projectedCps = next ? projected / (Math.max(next.endMs - cur[0].startMs, 1) / 1000) : cps;
  const wouldOverflow = projected > MAX_LINE * MAX_LINES;
  // WRAPPABILITY, NOT JUST LENGTH. A cue is allowed up to MAX_LINE * MAX_LINES on the
  // assumption it wraps to two legal lines — but that assumption fails when a long word
  // sits near the midpoint and no split lands inside the window. Measured case: an
  // 82-character cue whose only candidate splits were 35 and 44, with nothing in 39..42.
  // Checking the raw length accepts it; checking whether it can actually wrap rejects it
  // one word earlier and produces two clean cues instead of one over-wide line.
  const wouldNotWrap = next && projected > MAX_LINE
    && wrap(`${text} ${next.text}`).split('\n').some(l => l.length > MAX_LINE);
  // Only split on reading speed once the cue is already substantial — splitting a short
  // cue does not help, because display time shrinks with it and cps barely moves.
  const wouldOutrun = projectedCps > MAX_CPS && text.length > MAX_LINE * 1.4;
  // Clause breaks only once the cue is long enough that the break buys readability.
  // Firing at every comma fragments dense narration into many short cues, each of which
  // then gets less display time — which makes reading speed WORSE, not better.
  const clause = ENDS_CLAUSE.test(w.text) && text.length > MAX_LINE * 1.2;

  if (!next || segmentBreak || sentence || clause || wouldOverflow || wouldNotWrap || wouldOutrun) flush();
}
flush();

// Silent segments contribute exactly one cue each, spanning their authored window, and
// are merged in by time so the sidecar reads in order.
cues.push(...silentCues);
cues.sort((a, b) => a.startMs - b.startMs);

// Hold each cue into the pause that follows it. A viewer reads for as long as the cue is
// ON SCREEN, not for as long as the words were spoken, so reading speed must be measured
// against display duration — and extending into the natural pause is free readability.
// Never run into the next cue, and never past the end of the timeline.
//
// A SILENT CUE IS NOT HELD. Its window is authored, not measured, so stretching it would
// make the sidecar disagree with the timeline it was derived from — and "[music]" is not
// text a viewer needs extra time to read.
const HOLD_MS = Number(opt('hold', 1200));
for (let i = 0; i < cues.length; i++) {
  if (cues[i].silent) continue;
  const next = cues[i + 1];
  const ceiling = next ? next.startMs - 40 : timing.durationMs;
  cues[i].endMs = Math.min(Math.max(cues[i].endMs + HOLD_MS, cues[i].startMs + MIN_CUE_MS), ceiling);
  if (cues[i].endMs <= cues[i].startMs) cues[i].endMs = cues[i].startMs + 200;
}

// ---- wrap to <=2 balanced lines -------------------------------------------------------
// DEGRADE, DO NOT GIVE UP. An earlier version returned the text unwrapped whenever no
// split put BOTH halves under MAX_LINE — so a cue whose word boundaries straddle the limit
// was emitted as a single line of double the width, which is the worst available outcome
// and looked like the wrapper had simply not run.
//
// It happens in a narrow band: cue grouping accepts anything up to MAX_LINE * MAX_LINES,
// but a long word near the midpoint can leave no legal split inside that. Real case at 82
// chars: the candidate splits were 35 and 44, with nothing in the 39..42 window.
//
// So: prefer a split where both lines fit; otherwise take the split that minimises the
// LONGEST line, and let the caller report that the ceiling was missed. Two lines of 35/45
// read far better than one of 82, and an honest report beats a silent overrun.
function wrap(text) {
  if (text.length <= MAX_LINE) return text;
  const parts = text.split(' ');
  let legal = null, fallback = null;
  for (let i = 1; i < parts.length; i++) {
    const a = parts.slice(0, i).join(' '), b = parts.slice(i).join(' ');
    const longest = Math.max(a.length, b.length);
    const balance = Math.abs(a.length - b.length);
    if (a.length <= MAX_LINE && b.length <= MAX_LINE) {
      if (!legal || balance < legal.balance) legal = { a, b, balance };
    }
    if (!fallback || longest < fallback.longest
      || (longest === fallback.longest && balance < fallback.balance)) {
      fallback = { a, b, longest, balance };
    }
  }
  const pick = legal ?? fallback;
  return pick ? `${pick.a}\n${pick.b}` : text;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const stamp = (ms, sep) => {
  const h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000);
  const s = Math.floor(ms % 60000 / 1000), f = Math.floor(ms % 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(f, 3)}`;
};

const vtt = 'WEBVTT\n\n' + cues.map((c, i) =>
  `${i + 1}\n${stamp(c.startMs, '.')} --> ${stamp(c.endMs, '.')}\n${wrap(c.text)}\n`).join('\n');
const srt = cues.map((c, i) =>
  `${i + 1}\n${stamp(c.startMs, ',')} --> ${stamp(c.endMs, ',')}\n${wrap(c.text)}\n`).join('\n');

// PLAN BY DEFAULT, like every other writing stage in this engine. A bare run used to
// overwrite both sidecars, which is how a good pair was silently replaced by output from
// an experimental flag. --apply writes; --replace permits overwriting.
const apply = flag('apply');
const replace = flag('replace');
const vttPath = path.join(projectDir, `${projectName}.vtt`);
const srtPath = path.join(projectDir, `${projectName}.srt`);
const existing = [vttPath, srtPath].filter(p => fs.existsSync(p));

if (apply && existing.length && !replace) {
  console.error(`error: ${existing.map(p => path.basename(p)).join(' and ')} already exist(s). `
    + 'Pass --replace to overwrite, or choose another --name.');
  process.exit(EXIT.USAGE);
}
if (apply) {
  fs.writeFileSync(vttPath, vtt);
  fs.writeFileSync(srtPath, srt);
}

// Reading speed is reported against DISPLAY duration, which is what a viewer actually has.
//
// SILENT CUES ARE EXCLUDED FROM THE READING-SPEED STATISTICS. "[music]" held across a
// four-second intermission is ~2 cps, which is not a fast or a slow reading speed — it is
// not a reading speed at all, and averaging it in would drag the median toward a number
// that describes no cue a viewer has to keep up with.
//
// Every aggregate below is also guarded against an EMPTY population: `Math.max(...[])` is
// -Infinity and `undefined.toFixed(1)` throws, so a project with no spoken cues used to
// crash in its own summary line — reachable as soon as an entire project is silent, which
// is now an authorable thing.
const cpsOf = c => c.text.length / ((c.endMs - c.startMs) / 1000);
const spokenCues = cues.filter(c => !c.silent);
const silentCueCount = cues.length - spokenCues.length;
const linesOf = c => wrap(c.text).split('\n').map(l => l.length);
const over = spokenCues.filter(c => cpsOf(c) > MAX_CPS);
const longest = spokenCues.length ? Math.max(...spokenCues.map(c => c.text.length)) : 0;
// Report the longest rendered LINE, not the longest cue. A cue is allowed to be twice
// MAX_LINE because it wraps to two; measuring the cue therefore cannot see a line that
// failed to wrap, which is exactly how an 82-character line shipped under a "longest cue
// 82 chars" report that looked like it was describing the limit being respected.
//
// Line width IS checked across every cue, silent ones included: an over-wide accessibility
// cue is just as unreadable as an over-wide spoken one.
const longestLine = cues.length ? Math.max(...cues.flatMap(linesOf)) : 0;
const wideLines = cues.filter(c => linesOf(c).some(l => l > MAX_LINE)).length;
const cpsSorted = spokenCues.map(cpsOf).sort((a, b) => a - b);
const median = cpsSorted.length ? cpsSorted[Math.floor(cpsSorted.length / 2)] : null;
const medianText = median === null ? 'n/a (no spoken cues)' : `${median.toFixed(1)} cps`;
const silentNote = silentCueCount ? ` + ${silentCueCount} silent-segment cue(s)` : '';
console.log(`${apply ? 'wrote' : 'plan:'} ${projectName}.vtt and ${projectName}.srt — ${cues.length} cues from ${words.length} measured word boundaries${silentNote}`);
console.log(`  longest line ${longestLine} chars (limit ${MAX_LINE}${wideLines ? `, ${wideLines} cue(s) over` : ', all within'}) · longest cue ${longest} chars · median ${medianText} · ceiling ${MAX_CPS} cps · ${over.length} cue(s) over`);

// Narration rate sets a FLOOR on caption reading speed, and no amount of re-splitting
// escapes it: display time tracks speech time, so verbatim cues run at roughly the rate
// the words arrive. Report that floor so a high cps is read as a property of the pacing
// rather than a defect in the cueing.
//
// With no measured words there is no narration rate to report — `words.at(-1)` on an
// empty list is undefined — so the floor is skipped and said to be skipped, rather than
// printed as a number derived from nothing.
if (words.length) {
  const speechChars = words.reduce((n, w) => n + w.text.length + 1, 0);
  const speechMs = words.at(-1).endMs - words[0].startMs;
  const floorCps = speechMs > 0 ? speechChars / (speechMs / 1000) : null;
  if (floorCps === null) {
    console.log('  narration floor: not computed — the measured words span no time.');
  } else {
    console.log(`  narration delivers ~${floorCps.toFixed(1)} cps of text — that is the FLOOR for verbatim cues.`);
    if (floorCps > MAX_CPS * 0.9) {
      console.log(`  At this pace verbatim captions cannot sit far below ${MAX_CPS} cps. Slower narration or`);
      console.log(`  condensed (non-verbatim) cues are the only levers; re-splitting will not help.`);
    }
  }
} else {
  console.log('  narration floor: none — every segment is declared silent, so there is no speech rate to report.');
}
if (over.length) for (const c of over.slice(0, 5)) {
  console.log(`    ${stamp(c.startMs, '.')} ${cpsOf(c).toFixed(1)} cps — ${c.text.slice(0, 60)}${c.text.length > 60 ? '…' : ''}`);
}

// ---- optional: embed as a soft mov_text track ----------------------------------------
if (flag('embed')) {
  const ff = fs.readFileSync(path.join(projectDir, 'ffmpeg-path.txt'), 'utf8').trim();
  const src = `${projectName}-with-music.mp4`;
  const out = `${projectName}-with-music-subtitled.mp4`;
  if (!fs.existsSync(path.join(projectDir, src))) throw new Error(`not found: ${src} — run S9 first`);
  if (!apply) {
    console.log(`\nplan: would embed ${projectName}.srt into ${src} as a soft mov_text track`);
    console.log(`  output ${out}${fs.existsSync(path.join(projectDir, out)) ? ' — EXISTS, would need --replace' : ''}`);
  } else {
    if (fs.existsSync(path.join(projectDir, out)) && !replace) {
      console.error(`error: ${out} already exists. Pass --replace to overwrite it.`);
      process.exit(EXIT.USAGE);
    }
    // -n, not -y: the overwrite decision belongs to --replace, checked above, not to a
    // flag that makes ffmpeg clobber whatever it finds.
    execFileSync(ff, [replace ? '-y' : '-n', '-hide_banner', '-loglevel', 'error',
      '-i', src, '-i', `${projectName}.srt`,
      '-map', '0', '-map', '1', '-c', 'copy', '-c:s', 'mov_text',
      '-metadata:s:s:0', 'language=eng',
      out], { stdio: 'inherit' });
    console.log(`wrote ${out} — soft mov_text track, video and audio copied untouched`);
    console.log('  soft subtitles can be turned OFF by the viewer. Burned-in hardsubs cannot,');
    console.log('  so they are deliberately not the default.');
  }
}

if (!apply) {
  console.log('\nnothing was written. Re-run with --apply to write the sidecars.');
}
