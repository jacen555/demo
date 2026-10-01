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
 * Usage: see USAGE below, or run with --help. A bare run plans and writes nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  EXIT,
  CliError,
  guard,
  parseCli,
  parseBoundedNumber,
  resolveWithinRoot,
  resolveInternalArtifact,
  resolveEngineOutput,
  assertDistinctDestinations,
  describeWrite,
  planFooter,
} from './cli-support.mjs';
import {
  isSilentSegment, silentSegmentProblems, silentCaption, durationShortfallRemedy, durationMeasureRemedy,
  silentWindowFieldProblem, narratedWindowFieldRemedy, voiceBlocker, remixBlocker, gatedRemedy, declareSilentRemedy,
} from './silent-segment.mjs';

const USAGE = `
write-subtitles — WebVTT and SRT caption sidecars cut from the measured word timings in
timing.json (pipeline stage S10). No ASR and no estimates: cue times come off the timeline.

  node write-subtitles.mjs                      plan only (default)
  node write-subtitles.mjs --apply              write <project>.vtt and <project>.srt
  node write-subtitles.mjs --apply --replace    overwrite existing sidecars
  node write-subtitles.mjs --embed --apply      also mux the captions into a copy of the S9 video

Options
  --max-line <n>    characters per caption line, 10..120 (default: 42)
  --max-cps <n>     reading-speed ceiling in characters per second, 5..60 (default: 20)
  --min-cue <ms>    shortest time a cue stays on screen, 100..10000 (default: 900)
  --hold <ms>       how long a cue stays up into the pause after its last word, 0..10000
                    (default: 1200). Never past the end of the timeline or into a
                    silent segment's cue. It stops at least 40 ms short of a spoken cue,
                    except that a cue starting within 40 ms of the next spoken one still
                    gets 200 ms on screen, which overlaps it.
  --embed           also write <project>-with-music-subtitled.mp4: <project>-with-music.mp4
                    with the SRT muxed in as a soft mov_text track. Reads ffmpeg from
                    ffmpeg-path.txt in the project root.
  --project <dir>   project root; no path may escape it (default: current directory)
  --apply           actually write. Without it nothing is written.
  --replace         permit overwriting existing sidecars and the --embed output
  --help            show this message

Exit codes: 0 success/plan · 1 unusable timeline or ffmpeg failed · 2 bad usage,
a missing or refused path, or a refused overwrite
`.trimStart();

// STRICT PARSING. A hand-rolled parser ignored --help (so `--help --apply` wrote both
// sidecars), ignored typos, and quietly turned a --hold with no value into the default.
const { values, projectDir, apply, replace } = guard(() => parseCli({
  usage: USAGE,
  options: {
    'max-line': { type: 'string' },
    'max-cps': { type: 'string' },
    'min-cue': { type: 'string' },
    hold: { type: 'string' },
    embed: { type: 'boolean', default: false },
  },
}));

// VALIDATE, DO NOT COERCE. `Number('abc')` is NaN, and every comparison against NaN is
// false — so a bad --max-line disabled the over-width check AND the wrappability check
// while the report cheerfully said "all within". Measured: `--max-line abc` reported
// "limit NaN, all within" on a run whose longest line was 120 characters. That is a check
// that cannot fail, in the file whose wrapping bug this same round fixed.
// The shared parser's strictness is kept; only its explanation is replaced — it justifies
// the grammar with ffmpeg filter graphs, which is true of remux-music's gains and false of
// every caption knob here.
const num = (name, dflt, min, max) => guard(() => {
  const raw = values[name] ?? String(dflt);
  try {
    return parseBoundedNumber(raw, { name: `--${name}`, min, max });
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    throw new CliError(`--${name} must be a plain number between ${min} and ${max} — got "${raw}"`);
  }
});

const MAX_LINE = num('max-line', 42, 10, 120);
const MAX_LINES = 2;
const MAX_CPS = num('max-cps', 20, 5, 60);
const MIN_CUE_MS = num('min-cue', 900, 100, 10000);
// --hold was the one knob parsed with a bare Number(): `--hold abc` made every held cue end
// at NaN, written into both sidecars as "NaN:NaN:NaN.NaN" at exit 0. Bounded like its
// neighbours. 0 is legitimate — a cue that ends with its last word. The ceiling matches
// --min-cue's, the other knob that sets display time: the hold is capped at the next cue's
// start anyway, so a value past ten seconds changes nothing but a typo's reach.
const HOLD_MS = num('hold', 1200, 0, 10000);

const safeFileBase = (name, fallback) => {
  const base = path.basename(String(name ?? '')).replace(/[^A-Za-z0-9._-]+/g, '').replace(/^[-.]+|[-.]+$/g, '');
  return base || fallback;
};
// VALIDATED BEFORE A SINGLE CUE IS COMPUTED. Cue times are arithmetic on the timeline, and
// arithmetic on a missing value does not fail: with no durationMs the last cue's hold
// ceiling was NaN, and "NaN:NaN:NaN.NaN" was written into both sidecars at exit 0. An empty
// timeline wrote two empty sidecars as success, and a malformed word escaped as a stack
// trace. readTimeline refuses all of them, so everything below may take the shape as given.
const timing = guard(() => readTimeline(projectDir));
const projectName = safeFileBase(timing.project?.name, safeFileBase(path.basename(projectDir), 'video'));

// ---- collect words (readTimeline has already refused a timeline never synthesised) ----
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
for (const seg of timing.segments) {
  // There are no measured word boundaries to caption a deliberately silent segment from,
  // so its cue text is AUTHORED on the segment and spans its whole window. That is the
  // accessibility contract: a viewer reading captions is told "[music]" rather than being
  // shown nothing at all and left to wonder whether the captions broke.
  if (isSilentSegment(seg)) {
    silentCues.push({ startMs: seg.startMs, endMs: seg.endMs, text: silentCaption(seg), silent: true });
    continue;
  }
  for (const x of restorePunctuation(seg.voiceoverText, seg.audio.words)) words.push({ ...x, seg: seg.id });
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
// Never past the end of the timeline, and never into a silent cue. A spoken cue stops 40 ms
// short of the next spoken one, except where it starts within 40 ms of it: it still gets
// 200 ms on screen, and overlaps it.
//
// A SILENT CUE IS NOT HELD. Its window is authored, not measured, so stretching it would
// make the sidecar disagree with the timeline it was derived from — and "[music]" is not
// text a viewer needs extra time to read.
//
// A cue BEFORE a silent cue keeps its 40 ms clearance only where that does not cut its own
// last word short. No gap is inserted at a seam that touches a silent segment, so a spoken
// cue's last word can end right where the silent cue begins; the clearance kept from a
// spoken neighbour would then take the end of that word off screen while it is still being
// said. It never runs past the silent cue's start either: a word that would has already
// been refused by timelineProblems, because no cue can show it without overlapping one
// that is authored. A spoken neighbour keeps exactly the rule it always had.
for (let i = 0; i < cues.length; i++) {
  if (cues[i].silent) continue;
  const next = cues[i + 1];
  const spokenEndMs = cues[i].endMs;
  const ceiling = !next ? timing.durationMs
    : next.silent ? Math.max(next.startMs - 40, Math.min(spokenEndMs, next.startMs))
    : next.startMs - 40;
  cues[i].endMs = Math.min(Math.max(cues[i].endMs + HOLD_MS, cues[i].startMs + MIN_CUE_MS), ceiling);
  if (cues[i].endMs <= cues[i].startMs) {
    cues[i].endMs = next?.silent ? Math.min(cues[i].startMs + 200, next.startMs) : cues[i].startMs + 200;
  }
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
//
// EVERY PATH IS RESOLVED, AND EVERY REFUSAL MADE, BEFORE THE FIRST WRITE. The sidecars were
// joined onto the project directory and written with writeFileSync, which follows a link
// wherever it points, so `--apply --replace` over a demo.vtt linked outside the project
// overwrote the link's target. And --embed refused an existing output only after both
// sidecars had been written, so a refused run had still changed the project. Every name
// written here is chosen by the engine, not the caller, so a link at any of them is refused.
const { vttPath, srtPath, embed } = guard(() => {
  const sidecars = {
    vttPath: resolveEngineOutput(projectDir, `${projectName}.vtt`, { apply, replace, label: 'WebVTT sidecar' }),
    srtPath: resolveEngineOutput(projectDir, `${projectName}.srt`, { apply, replace, label: 'SRT sidecar' }),
  };
  if (!values.embed) return { ...sidecars, embed: null };

  const source = resolveWithinRoot(projectDir, `${projectName}-with-music.mp4`, 'embed source');
  requireRegularFile(source, 'embed source', 'run S9 (remux-music) first');
  const out = resolveEngineOutput(projectDir, `${projectName}-with-music-subtitled.mp4`, {
    apply,
    replace,
    label: 'subtitled video',
  });
  // ffmpeg reading and writing one file destroys it; an in-root link can make them one.
  assertDistinctDestinations(
    [
      { key: 'WebVTT sidecar', path: sidecars.vttPath },
      { key: 'SRT sidecar', path: sidecars.srtPath },
      { key: 'embed source', path: source },
      { key: 'subtitled video', path: out },
    ],
    'write-subtitles --embed',
  );
  return { ...sidecars, embed: { source, out, ff: resolveFfmpeg(projectDir) } };
});

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
if (!apply) {
  console.log(`  output ${vttPath} — ${describeWrite(vttPath, replace)}`);
  console.log(`  output ${srtPath} — ${describeWrite(srtPath, replace)}`);
}

// ---- optional: embed as a soft mov_text track ----------------------------------------
// Everything it touches was resolved and refused-or-permitted above, before the sidecars
// were written; this block only describes or performs the mux.
if (embed) {
  // -n, not -y: the overwrite decision belongs to --replace, checked above, not to a
  // flag that makes ffmpeg clobber whatever it finds.
  const ffArgs = [replace ? '-y' : '-n', '-hide_banner', '-loglevel', 'error',
    '-i', embed.source, '-i', srtPath,
    '-map', '0', '-map', '1', '-c', 'copy', '-c:s', 'mov_text',
    '-metadata:s:s:0', 'language=eng',
    embed.out];
  if (!apply) {
    console.log(`\nplan: embed ${path.basename(srtPath)} into ${path.basename(embed.source)} as a soft mov_text track`);
    console.log(`  output ${embed.out} — ${describeWrite(embed.out, replace)}`);
    console.log(`\nwould run:\n  ${embed.ff} ${ffArgs.join(' ')}`);
  } else {
    let failure = null;
    try {
      execFileSync(embed.ff, ffArgs, { stdio: 'inherit' });
    } catch (err) {
      failure = err;
    }
    if (failure) {
      // Reported, not thrown: an uncaught throw here printed a stack trace for what is an
      // ordinary, expected failure. exitCode rather than exit() so stdout is flushed.
      console.error(`error: ffmpeg failed while embedding subtitles (${failure.message}) — `
        + `${embed.out} may be missing or incomplete. The sidecars were written.`);
      process.exitCode = EXIT.FAILED;
    } else {
      console.log(`wrote ${embed.out} — soft mov_text track, video and audio copied untouched`);
      console.log('  soft subtitles can be turned OFF by the viewer. Burned-in hardsubs cannot,');
      console.log('  so they are deliberately not the default.');
    }
  }
}

if (!apply) planFooter();

/**
 * Reads timing.json and refuses a timeline that cannot be captioned, before any cue is
 * computed and before either sidecar is resolved.
 *
 * READ, NOT FOLLOWED. A link at timing.json was followed, so an in-root link made the run
 * caption a timeline nobody named, and a malformed file escaped as a SyntaxError whose
 * report printed the file's whole first line. It is now described by its size, never
 * quoted.
 */
function readTimeline(root) {
  const { file, text } = readEngineFile(root, 'timing.json', 'timing file');
  if (text === null) throw new CliError(`timing file not found: ${file}`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError(
      `${file} is not valid JSON (${text.length} characters) — refusing to caption from it`,
      EXIT.FAILED,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError(`timing.json holds ${describeValue(parsed)}, not a timeline object`, EXIT.FAILED);
  }
  const problems = timelineProblems(parsed, root);
  if (problems.length) throw new CliError(summarise(problems), EXIT.FAILED);
  return parsed;
}

/**
 * Everything that would put a wrong or unreadable cue into the sidecars, as human-readable
 * lines: segment windows that are unmeasured, empty or out of order; a duration that
 * cannot bound the last cue; and measured words that are not finite, ordered times.
 *
 * A stage named as a remedy is asked first whether it would run on this project (see
 * silent-segment.mjs), which is why the project root is passed. Each is asked once, and
 * only if a remedy needs it.
 */
function timelineProblems(t, root) {
  const segs = t.segments;
  if (!Array.isArray(segs) || !segs.length) {
    return [`timing.segments is ${Array.isArray(segs) ? 'empty' : describeValue(segs)} — there is nothing to caption`];
  }
  const gate = {};
  const gates = {
    voice: () => (gate.voice !== undefined ? gate.voice : (gate.voice = voiceBlocker(root, t, segmentLabel))),
    remix: () => (gate.remix !== undefined ? gate.remix : (gate.remix = remixBlocker(root, t, segmentLabel))),
  };
  const problems = [];
  let prev = null;
  let lastEndMs = null;
  let lastIndex = null; // the segment that ends last: what it holds decides which stage re-measures the duration
  segs.forEach((s, i) => {
    const where = segmentLabel(s, i);
    if (s === null || typeof s !== 'object' || Array.isArray(s)) {
      problems.push(`${where} is ${describeValue(s)}, not a segment object`);
      return;
    }
    const unmeasured = ['startMs', 'endMs'].filter(k => !isMs(s[k]));
    for (const k of unmeasured) {
      // A declared silent window is authored, not measured: it is corrected by hand, and
      // re-voicing is never its repair.
      problems.push(isSilentSegment(s)
        ? silentWindowFieldProblem({
          dir: root, timing: t, index: i, field: k, fields: unmeasured, shown: describeValue(s[k]), labelOf: segmentLabel,
        })
        : `${where}: ${k} is ${describeValue(s[k])} — it must be a finite number of milliseconds, >= 0. ` +
          narratedWindowFieldRemedy(root, t, segmentLabel),
      );
    }
    if (unmeasured.length) return;
    if (s.endMs <= s.startMs) {
      problems.push(`${where}: window is ${s.endMs - s.startMs}ms (${s.startMs} -> ${s.endMs}) — it must be positive`);
      return;
    }
    if (prev && s.startMs < prev.endMs) {
      problems.push(
        `${where} starts at ${s.startMs} ms, before ${prev.where} ends at ${prev.endMs} ms — ` +
          'segments must be in time order and must not overlap',
      );
    }
    prev = { where, endMs: s.endMs };
    if (lastEndMs === null || s.endMs >= lastEndMs) lastIndex = i;
    lastEndMs = Math.max(lastEndMs ?? 0, s.endMs);
    problems.push(...(isSilentSegment(s) ? silentSegmentProblems(s, where) : wordProblems(s, where, gates)));
  });
  problems.push(...spokenWordsInSilentWindows(segs, gates));

  const d = t.durationMs;
  if (!isMs(d) || (lastEndMs !== null && d < lastEndMs)) {
    const floor = lastEndMs === null ? '' : `, no shorter than the last segment (which ends at ${lastEndMs} ms)`;
    // A measured duration short of the last window means some window changed after the
    // audio was measured. silent-segment.mjs decides which stage re-measures it — remix
    // for a silence edit, voice otherwise, each only where it would run — for
    // write-chapters too, so the two agree.
    const remedy = !isMs(d)
      ? durationMeasureRemedy('It bounds the last cue', root, t, segmentLabel)
      : durationShortfallRemedy('It bounds the last cue', root, t, lastIndex, segmentLabel);
    problems.push(
      `timing.durationMs is ${describeValue(d)} — it must be a finite number of milliseconds${floor}. ${remedy}`,
    );
  }
  return problems;
}

/**
 * What is wrong with a narrated segment's measured words.
 *
 * A DELIBERATELY SILENT SEGMENT IS NOT AN UNSYNTHESISED ONE. Both have no `audio.words`, so
 * the no-words refusal used to fire on both — naming a cause ("run voice.mjs") that is
 * simply wrong for an intermission. The `silence` declaration separates them, and only an
 * undeclared segment reaches this. The voice stage is named as the step only where it
 * would run, and the declaration it offers instead is one every stage accepts.
 */
function wordProblems(seg, where, gates) {
  const w = seg.audio?.words;
  if (!Array.isArray(w) || !w.length) {
    const voice = gates.voice();
    return [
      `${where} has no audio.words — ${voice === null ? 'run voice.mjs (S3) first'
        : gatedRemedy(voice, { stem: 'voice.mjs (S3) measures them' }, { factOnly: true })}. ` +
        'Subtitles are generated from measured word boundaries, not from the script. ' +
        `(If this segment is meant to be silent, ${declareSilentRemedy(seg)} instead.)`,
    ];
  }
  const problems = [];
  if (typeof seg.voiceoverText !== 'string') {
    problems.push(
      `${where} has measured words but its voiceoverText is ${describeValue(seg.voiceoverText)} — ` +
        'the captions restore their punctuation from it',
    );
  }
  w.forEach((x, j) => {
    const at = `${where}: audio.words[${j}]`;
    if (x === null || typeof x !== 'object' || Array.isArray(x)) {
      problems.push(`${at} is ${describeValue(x)}, not a measured word`);
      return;
    }
    if (typeof x.word !== 'string') problems.push(`${at}.word is ${describeValue(x.word)} — it must be text`);
    const unmeasured = ['startMs', 'endMs'].filter(k => !isMs(x[k]));
    for (const k of unmeasured) {
      problems.push(`${at}.${k} is ${describeValue(x[k])} — it must be a finite number of milliseconds, >= 0`);
    }
    if (!unmeasured.length && x.endMs < x.startMs) {
      problems.push(`${at} ends before it starts (${x.startMs} -> ${x.endMs} ms)`);
    }
  });
  return problems;
}

function isMs(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * Measured spoken words that fall inside a declared silent window.
 *
 * A silent window is authored and is captioned by its own cue, so a spoken word inside it
 * cannot be shown without overlapping that cue, and trimming the word's cue to fit would
 * hide a contradiction in the timeline rather than caption it. A zero-length word AT the
 * window's start counts as inside; a word ending exactly where the window starts does not.
 * Only well-formed words and windows are compared — anything else is reported elsewhere.
 * Each stage it names is named as the step only where it would run.
 */
function spokenWordsInSilentWindows(segs, gates) {
  const windows = segs.flatMap((q, k) =>
    isSilentSegment(q) && isMs(q.startMs) && isMs(q.endMs) && q.endMs > q.startMs ? [{ q, k }] : []);
  if (!windows.length) return [];
  const problems = [];
  segs.forEach((s, i) => {
    if (s === null || typeof s !== 'object' || isSilentSegment(s) || !Array.isArray(s.audio?.words)) return;
    s.audio.words.forEach((w, j) => {
      if (w === null || typeof w !== 'object' || !isMs(w.startMs) || !isMs(w.endMs) || w.endMs < w.startMs) return;
      const hit = windows.find(({ q }) => w.startMs < q.endMs && (w.endMs > q.startMs || w.startMs >= q.startMs));
      if (!hit) return;
      problems.push(
        `${segmentLabel(s, i)}: audio.words[${j}] (${w.startMs} -> ${w.endMs} ms) runs into ` +
          `${segmentLabel(hit.q, hit.k)}, which is declared silent from ${hit.q.startMs} to ${hit.q.endMs} ms — ` +
          'a spoken word cannot be captioned inside an authored silent window. If the silent window was edited, ' +
          `${gatedRemedy(gates.remix(), {
            open: 'run remix.mjs (S4) to reflow the timeline around it',
            stem: 'remix.mjs (S4) reflows the timeline around it',
          }, { factOnly: true })}; if the narration changed, ${gatedRemedy(gates.voice(), {
            open: 'run voice.mjs (S3)',
            stem: 'voice.mjs (S3) re-measures it',
          }, { factOnly: true })}`,
      );
    });
  });
  return problems;
}

function segmentLabel(s, i) {
  const id = s !== null && typeof s === 'object' && typeof s.id === 'string' ? ` ("${s.id}")` : '';
  return `timing.segments[${i}]${id}`;
}

/**
 * Names a value for a diagnostic. A string is described by its length, never quoted: this
 * is about a file's shape, and its contents are not this message's to repeat.
 */
function describeValue(v) {
  if (v === undefined) return 'missing';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return `a string (${v.length} characters)`;
  return typeof v === 'object' ? 'an object' : `a ${typeof v}`;
}

function summarise(problems) {
  if (problems.length === 1) return problems[0];
  const shown = problems.slice(0, 5).map(p => `\n  - ${p}`).join('');
  const more = problems.length > 5 ? `\n  … and ${problems.length - 5} more` : '';
  return `timing.json has ${problems.length} problems:${shown}${more}`;
}

/**
 * Reads a file the engine looks for on its own initiative, refusing a link at it wherever
 * it points and anything that is not a regular file. The caller never named this path, so
 * a link there is not an instruction to read something else.
 *
 * @returns {{file: string, text: string|null}} `text` is null only when nothing is there
 */
function readEngineFile(root, name, label) {
  const file = resolveInternalArtifact(root, name, label, 'read');
  let st;
  try {
    st = fs.statSync(file, { throwIfNoEntry: false });
  } catch (err) {
    throw new CliError(`${label}: could not inspect ${file} (${err.code ?? err.message}) — refusing`);
  }
  if (st === undefined) return { file, text: null };
  if (!st.isFile()) throw new CliError(`${label} ${file} is not a regular file — refusing to read it`);
  try {
    return { file, text: fs.readFileSync(file, 'utf8') };
  } catch (err) {
    throw new CliError(`${label}: could not read ${file} (${err.code ?? err.message}) — refusing`);
  }
}

/**
 * Refuses an input that is absent or not a regular file, before anything is written.
 * Existence alone let a directory at the embed source through: both sidecars were
 * replaced and only ffmpeg then refused a directory as a video.
 */
function requireRegularFile(abs, label, hint) {
  let st;
  try {
    st = fs.statSync(abs, { throwIfNoEntry: false });
  } catch (err) {
    throw new CliError(`${label}: could not inspect ${abs} (${err.code ?? err.message}) — refusing`);
  }
  if (st === undefined) throw new CliError(`${label} not found: ${abs} — ${hint}`);
  if (st.isDirectory()) throw new CliError(`${label} ${abs} is a directory, not a video file`);
  if (!st.isFile()) throw new CliError(`${label} ${abs} is not a regular file`);
}

/**
 * Reads the ffmpeg binary from the project's ffmpeg-path.txt.
 *
 * The plan prints what this returns in its "would run" line, so the pointer is read like
 * timing.json: a link at it is refused, wherever it points. Followed, a link to any file in
 * the project put that file's contents into the plan.
 */
function resolveFfmpeg(root) {
  const { text } = readEngineFile(root, 'ffmpeg-path.txt', 'ffmpeg pointer');
  if (text === null) throw new CliError(`ffmpeg-path.txt not found in ${root} — create it containing the path to ffmpeg`);
  const ff = text.trim();
  if (!ff) throw new CliError(`ffmpeg-path.txt in ${root} is empty`);
  return ff;
}
