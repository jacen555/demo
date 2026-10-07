// Remix — re-solve the inserted silences using REAL head/tail measured from decoded audio,
// then re-concatenate and reflow the timeline. Does NOT re-synthesize: every NARRATED
// segment_*.mp3 clip on disk is reused byte-for-byte, so its speech never changes. A
// DECLARED SILENT segment's clip is regenerated from its CURRENT authored window, which is
// what lets a silence edit — a gap, an intermission's length, silencing a segment — stay
// in S4 without re-voicing.
//
// Why this exists: msedge-tts word-boundary metadata cannot reveal trailing silence, because
// the scale factor (durationMs / lastWordEnd) pins the final word boundary to the clip end.
// Decoding is the only way to see the real tail.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { parseFile } from 'music-metadata';
import { normalizeEndCardFields } from './end-card.mjs';
import { EXIT, CliError, guard, parseCli, requireExistingFile, resolveEngineOutput, resolveWithinRoot, describeWrite, planFooter, requireFiniteNumber, assertDistinctDestinations, timingSeal, openExclusiveEngineFile } from './cli-support.mjs';
import {
  isSilentSegment, silentSegmentProblems, silentDurationMs, silentMp3, silentMp3DurationMs, silenceAssetBytes,
  silentRecordState, hasAudioFile, unvoicedNarrationProblem, segmentClipName, gapAssetName, remixWriteSet,
  remixCollisionBlocker, renderBlocker, voiceBlocker, gatedRemedy, stageRefusal, canonicalName, sameName, shapeBlocker,
  segmentLabel,
} from './silent-segment.mjs';

const USAGE = `
remix — re-solve inserted silences from REAL measured audio and reflow the timeline
(pipeline stage S4). Does not re-synthesise: narrated clips on disk are reused as they
are, and a declared silent segment's clip is regenerated from its authored window, so a
silence edit needs no re-voice.

  node remix.mjs                       plan only (default)
  node remix.mjs --apply --replace     re-solve, rewrite voiceover.mp3 and timing.json

Options
  --project <dir>   project root; no path may escape it (default: current directory)
  --apply           actually write. Without it nothing is written.
  --replace         permit overwriting voiceover.mp3, timing.json, the lead-in, gap and
                    outro silences, and declared silent segments' clips
  --help            show this message

This stage rewrites the approved timeline and the concatenated narration, and regenerates
the silence it inserts and every declared silent segment's clip, so it writes nothing
without both flags. A narrated segment whose record holds no measured words is refused:
arranging existing audio cannot create speech, so it needs voice.mjs (S3). So is a run
that would write over a narrated clip, under its own name or another (a hard link).

Every output is staged to a temporary file beside it and checked — the voice track
against the reflowed timeline (C-6) — before any is renamed into place, timing.json last.
A failed check publishes nothing; a failed rename says what was and was not published.

Exit codes: 0 success/plan · 1 remix failed (voice drift, or a file it could not publish) · 2 bad usage, a refused timeline or a refused overwrite
`.trimStart();

const cli = (() => {
  try {
    return parseCli({ usage: USAGE });
  } catch (err) {
    if (err.name === 'HelpRequested') { console.log(err.usage); process.exit(EXIT.OK); }
    console.error(`error: ${err.message}`);
    process.exit(err.exitCode ?? EXIT.FAILED);
  }
})();

const dir = cli.projectDir;
const timingPath = guard(() => requireExistingFile(dir, 'timing.json', 'timing file'));
// Refused, not crashed. This was a bare JSON.parse: an unparseable timing.json escaped as
// an uncaught SyntaxError with a stack and exit 1 — a crash dressed as a result, naming a
// character offset rather than the file. Unreadable input is the caller's fault, which is
// EXIT.USAGE by cli-support's own definition (a missing prerequisite), and it is what
// frame-capture and concat-audio already say. CliError defaults to USAGE.
const timing = guard(() => {
  const text = fs.readFileSync(timingPath, 'utf8');
  try {
    return JSON.parse(text);
  } catch {
    // The parser's message is NOT forwarded. V8 quotes about 17 bytes of the input back —
    // `Unexpected token 'S', "{ "k": SECRET-VAL"... is not valid JSON` — so passing
    // err.message through copies the file into stdout and from there into CI logs. The
    // file is reported by its SIZE instead, which is what write-chapters.mjs:197 settled on
    // after a link at timing.json made a parse error quote the bytes it led to.
    throw new CliError(`${timingPath} is not valid JSON (${text.length} characters)`);
  }
});
const stable = timing.intake ?? {};

// Validated, not coerced — see voice.mjs for why. `Number(stable.toleranceMs)` reaching
// the C-6 drift comparison as NaN makes `driftMs > Math.max(NaN, 1500)` always false,
// removing the only check that the remixed narration still matches the timeline.
const TOLERANCE_MS = guard(() =>
  requireFiniteNumber(stable.toleranceMs ?? 750, { name: 'intake.toleranceMs', min: 0, max: 600_000 }));
const LEAD_IN_MS = guard(() =>
  requireFiniteNumber(stable.leadInMs ?? 2000, { name: 'intake.leadInMs', min: 0, max: 600_000 }));
const GAP_DEFAULT_MS = guard(() =>
  requireFiniteNumber(stable.perceivedGapMs ?? 2000, { name: 'intake.perceivedGapMs', min: 0, max: 600_000 }));
const GAP_OVERRIDES = stable.perceivedGapOverrides || {};
const FRAME_MS = 24;
const alignUp = ms => Math.max(0, Math.round(ms / FRAME_MS) * FRAME_MS);
const probeMs = async f => Math.round(((await parseFile(f, { duration: true })).format.duration ?? 0) * 1000);

// ---- 0. what the timeline asks for --------------------------------------------------------
// Each refusal here is decided from timing.json and the project directory alone, so the
// plan makes it too rather than promising a run that --apply would refuse. A segment with
// no audio record at all is still refused under --apply, below, as before.
const segs = timing.segments;
const segList = Array.isArray(segs) ? segs : [];
// UNREACHABLE WITH AN ID-LESS SEGMENT, AND CORRECTED ANYWAY. This restated
// `segment "${s?.id ?? i}"`, which formats a 0-based index as a quoted id. Measured: every
// path into it asks this stage's gate first, and the gate asks shapeBlocker, which refuses
// a segment with no usable id — so the `?? i` branch cannot be reached from here. The
// statement is still wrong, and one wrong statement of a rule is how the next caller learns
// it wrong, so it reads the shared symbol. Pinned by segmentLabel's own unit tests rather
// than by an integration test over a branch no input can reach.
const labelOf = segmentLabel;
// The plan's accounting of what this run does to a file a record named, compared by
// canonical name: the resolver keeps an 8.3 short name as typed, and read as text, a short
// name of a file this run writes was another file it "leaves as it is". Never by identity:
// a hard link of a file this run replaces is another entry, which a rename leaves as it is.
// A name that cannot be asked about is compared as typed: this is accounting, not a guard.
const nameOf = (p) => { try { return canonicalName(p); } catch { return p; } };
const sameFile = (a, b) => sameName(nameOf(a), nameOf(b));
// The timeline's shape first, as remixBlocker asks it: a list of segment objects, each with a
// non-empty string id. Every check below reads the list as one, and names a segment by its id.
const shape = shapeBlocker(timing);
if (shape) { console.error(`error: ${renderBlocker(shape)}.`); process.exit(EXIT.USAGE); }
// Then every declaration, as remixBlocker asks them next: a malformed one is refused here,
// before anything is written, and that gate finds it ahead of all but the shape.
for (const s of segList) {
  // A declared silent segment is regenerated from its declaration, so the declaration
  // must be one voice.mjs accepts: the same rules, from the same function, the same exit.
  const [problem] = isSilentSegment(s) ? silentSegmentProblems(s) : [];
  if (problem) { console.error(`error: ${problem}`); process.exit(EXIT.USAGE); }
}
for (const [i, s] of segList.entries()) {
  // A narrated segment's clip is reused as it is, so its record must describe speech.
  // One that holds no measured words carries a clip voice did not synthesise as its
  // narration, and arranging audio cannot create speech.
  const unvoiced = !isSilentSegment(s) && hasAudioFile(s) ? unvoicedNarrationProblem(s, labelOf(s, i), dir, timing, labelOf) : null;
  if (unvoiced) { console.error(`error: ${unvoiced}`); process.exit(EXIT.USAGE); }
}

// ---- the write set ----------------------------------------------------------------------------
// Declared once and used for the plan, the distinctness check and the writes. Every entry
// is an ENGINE-chosen name, so each resolves with links refused, not followed. That
// includes the pause assets, which a silence-gen child used to write through the resolver
// that FOLLOWS an in-root link, and which the plan never named.
//
// A declared silent segment's clip is written under the name voice.mjs gives it, and its
// record is pointed there, so `audio.file` always names a clip holding exactly the silence
// the record describes. A narrated segment's clip is never written. The list is built in
// silent-segment.mjs, where the gate other stages ask before naming remix builds it too.
const WRITE_SET = remixWriteSet(timing);
// Resolved without the replace guard first, so the plan can describe replacing a file
// rather than refusing to talk about it. voiceover and timing resolving to one file
// passes both individual guards, hence the distinctness check.
const writeSet = WRITE_SET.map((o) => ({
  ...o,
  path: guard(() => resolveEngineOutput(dir, o.key, { apply: false, replace: cli.replace, label: o.label })),
}));
guard(() => assertDistinctDestinations(writeSet.map(({ key, path: p }) => ({ key, path: p })), 'output'));
const pathFor = (key) => writeSet.find((o) => o.key === key).path;

// Resolved the way the decode below resolves it; null when that would refuse, which it
// then does under --apply.
const recordPath = (s) => {
  try { return resolveWithinRoot(dir, s.audio.file, `segment ${s.id} audio`); } catch { return null; }
};

// ---- what the write set must not touch ------------------------------------------------------
// A narrated segment's clip is read and never written, so no destination may be that clip.
// Names are not enough: on Windows a case variant and an 8.3 short name are other names for
// one entry, and the text of every path differs. So a destination is compared by name, by
// canonical name — which needs no file IDs — and, where the volume reports file IDs, by
// identity, which catches a hard link. Publishing by rename would leave a hard link holding
// its narration; remix refuses it all the same. The check, and the edit its refusal
// advises, are in silent-segment.mjs, where the gate other stages ask before naming remix as
// a remedy makes the same check.
const collision = guard(() => remixCollisionBlocker(dir, timing, labelOf, writeSet));
if (collision) { console.error(`error: ${renderBlocker(collision)}.`); process.exit(EXIT.USAGE); }

// Whether voice.mjs (S3) would run on this timeline, asked before anything is reflowed: a
// refusal below that names it says why it would refuse rather than sending anyone there.
const voiceGate = voiceBlocker(dir, timing, labelOf);

// ---- the safe default -----------------------------------------------------------------------
// Nothing above this point has written anything. A bare run stops here rather than
// launching a browser, regenerating silence and rewriting the timeline.
if (!cli.apply) {
  // The check --apply makes of every recorded clip before it writes anything, asked here
  // so the plan does not promise a run that --apply refuses. null when it would pass.
  const recordedClipProblem = (s) => {
    try { requireExistingFile(dir, s.audio.file, `segment ${s.id} audio`); return null; } catch (err) { return err.message; }
  };
  // What this run does to a file a silent segment's record named, when that is not the
  // segment's own clip: after a reorder it is typically another silent segment's clip, so
  // "left as it is" is said only when nothing in the write set writes it.
  const fateOf = (named) => {
    const w = writeSet.find((x) => sameFile(x.path, named));
    if (!w) return 'which remix leaves as it is';
    if (w.silent) return `which this run rewrites as segment "${w.silent.id}"'s silence`;
    return w.solved ? `which this run overwrites if the solve inserts ${w.solved}` : 'which this run overwrites';
  };
  console.log(`plan: re-solve inserted silences for ${timing.segments?.length ?? 0} segment(s)`);
  for (const o of writeSet) {
    let note = o.solved ? ` (written only if the solve inserts ${o.solved})` : '';
    if (o.silent && !hasAudioFile(o.silent)) {
      note = ` — segment "${o.silent.id}" is declared silent, but voice.mjs (S3) has not run for it: ` +
        '--apply refuses the run rather than regenerating it';
    } else if (o.silent && recordedClipProblem(o.silent) !== null) {
      note = ` — segment "${o.silent.id}" is declared silent, but --apply refuses the run rather than regenerating it: ` +
        recordedClipProblem(o.silent);
    } else if (o.silent) {
      const windowMs = silentDurationMs(o.silent);
      const realMs = silentMp3DurationMs(windowMs);
      const named = recordPath(o.silent);
      note = ` — segment "${o.silent.id}" is declared silent: regenerated from its ${windowMs}ms authored window` +
        (realMs === windowMs ? '' : ` (frame-quantised to ${realMs}ms, which the timeline is reflowed onto)`) +
        (sameFile(named, o.path) ? '' : `; its record named ${o.silent.audio.file}, ${fateOf(named)}`);
    }
    console.log(`  ${o.key.padEnd(26)} ${describeWrite(o.path, cli.replace)}${note}`);
  }
  const narrated = segList.filter((s) => !isSilentSegment(s) && hasAudioFile(s));
  const reused = narrated.filter((s) => recordedClipProblem(s) === null).map((s) => s.audio.file);
  if (reused.length) console.log(`  reused as they are (decoded to re-measure their edges, never rewritten): ${reused.join(', ')}`);
  const missing = narrated.filter((s) => recordedClipProblem(s) !== null).map((s) => `${s.audio.file} (segment "${s.id}")`);
  if (missing.length) console.log(`  not found in the project, so --apply refuses the run: ${missing.join(', ')}`);
  // Refused under --apply below, as it always was; the plan discloses that refusal here.
  const unvoicedIds = segList.filter((s) => !hasAudioFile(s)).map((s) => s?.id);
  if (unvoicedIds.length) {
    console.log(`  not voiced yet, so --apply refuses the run until voice.mjs (S3) has run: ${unvoicedIds.join(', ')}`);
    if (voiceGate !== null) console.log(`  ${stageRefusal('voice.mjs (S3)', voiceGate)}.`);
  }
  if (writeSet.some((o) => o.solved)) {
    console.log('  note: a lead-in or pause solved to 0ms writes nothing and leaves any existing file of that');
    console.log('  name as it is. Each is still held to --replace, because the solve is known only after decoding.');
  }
  // The two disclosures above each say --apply refuses this run. Inviting --apply in the
  // next breath contradicts them, so the footer says what it actually knows.
  planFooter('apply', { blocked: missing.length > 0 || unvoicedIds.length > 0 });
  process.exit(EXIT.OK);
}
// Now that we are writing, enforce the replace guard across the whole set before any work
// starts, so the run cannot get halfway through and then refuse.
for (const o of writeSet) guard(() => resolveEngineOutput(dir, o.key, { apply: true, replace: cli.replace, label: o.label }));

// ---- 1. measure REAL head/tail silence by decoding each clip --------------------------------
const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('about:blank');
async function edges(file) {
  const b64 = fs.readFileSync(file).toString('base64');
  return page.evaluate(async (b64) => {
    const bin = atob(b64); const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const ctx = new OfflineAudioContext(1, 48000, 48000);
    const buf = await ctx.decodeAudioData(u8.buffer);
    const d = buf.getChannelData(0), sr = buf.sampleRate;
    const win = Math.round(sr * 0.01);            // 10ms resolution
    const THRESH = 0.004;
    let first = -1, last = -1;
    for (let i = 0, k = 0; i < d.length; i += win, k++) {
      let s = 0, n = 0;
      for (let j = i; j < Math.min(i + win, d.length); j++) { s += d[j] * d[j]; n++; }
      if (Math.sqrt(s / n) > THRESH) { if (first < 0) first = k; last = k; }
    }
    const totalMs = Math.round(buf.duration * 1000);
    return first < 0
      ? { totalMs, headMs: 0, tailMs: 0 }
      : { totalMs, headMs: first * 10, tailMs: Math.max(0, totalMs - (last + 1) * 10) };
  }, b64);
}

const measured = [];
console.log('measured clip edges (decoded):');
for (let i = 0; i < segs.length; i++) {
  // `audio.file` is written by the voice stage for EVERY segment, silent ones included —
  // a declared silent segment has a real generated-silence clip on disk. So an absent
  // `audio.file` means the voice stage has not run, for silent and narrated segments
  // alike, and remix has nothing to re-measure. Said explicitly rather than surfacing as
  // "Cannot read properties of undefined (reading 'file')".
  if (typeof segs[i].audio?.file !== 'string' || segs[i].audio.file.trim() === '') {
    await browser.close();
    console.error(
      `error: segment "${segs[i].id}" has no audio.file — remix re-measures clips that already exist, ` +
      'so the voice stage (S3) must have run first.' +
      (isSilentSegment(segs[i]) ? ' A declared silent segment still gets a generated clip from that stage.' : '') +
      (voiceGate === null ? '' : ` ${stageRefusal('voice.mjs (S3)', voiceGate)}.`));
    process.exit(EXIT.USAGE);
  }
  // segs[i].audio.file comes from timing.json and is opened directly — authored input is
  // not trusted input, so it is confined to the project root before it is read.
  const file = requireExistingFile(dir, segs[i].audio.file, `segment ${segs[i].id} audio`);
  if (isSilentSegment(segs[i])) {
    // Not decoded and not used. A declared silent segment's audio is generated from its
    // CURRENT authored window, whatever the clip on disk holds: that clip was made for the
    // window or declaration voice saw, and a silence edit since then is exactly what this
    // stage exists to honour. Head and tail are 0 — there is no speech to bracket.
    const windowMs = silentDurationMs(segs[i]);
    const totalMs = silentMp3DurationMs(windowMs);
    measured.push({ key: segmentClipName(i), totalMs, headMs: 0, tailMs: 0, silent: true, bytes: silentMp3(windowMs) });
    console.log(`  ${segs[i].id.padEnd(11)} ${String(totalMs).padStart(6)}ms  head    0ms  tail    0ms  (declared silent: generated from its ${windowMs}ms authored window, not decoded)`);
    continue;
  }
  const e = await edges(file);
  measured.push({ file, ...e, silent: false });
  console.log(`  ${segs[i].id.padEnd(11)} ${String(e.totalMs).padStart(6)}ms  head ${String(e.headMs).padStart(4)}ms  tail ${String(e.tailMs).padStart(4)}ms`);
}
await browser.close();

// ---- 2. re-solve inserted silences -----------------------------------------------------------
const leadInserted = measured[0].silent ? 0 : alignUp(Math.max(0, LEAD_IN_MS - measured[0].headMs));
const gapsInserted = [];
console.log('\nre-solved pacing:');
console.log(`  lead-in       target ${LEAD_IN_MS}ms - head ${measured[0].headMs} -> insert ${leadInserted}ms${measured[0].silent ? '  (suppressed: segment 1 is declared silent)' : ''}`);
for (let i = 0; i < segs.length - 1; i++) {
  // No inserted gap at a seam touching a declared silent segment — the authored silence
  // is the pause. Kept identical to the voice stage's rule: if the two solved pacing
  // differently, a remix would silently move every segment after the first silent one.
  if (measured[i].silent || measured[i + 1].silent) {
    gapsInserted.push(0);
    console.log(`  after ${segs[i].id.padEnd(10)} no gap inserted — a declared silent segment adjoins this seam`);
    continue;
  }
  const target = Number(GAP_OVERRIDES[segs[i].id] ?? GAP_DEFAULT_MS);
  const tail = measured[i].tailMs, head = measured[i + 1].headMs;
  const inserted = alignUp(Math.max(0, target - tail - head));
  gapsInserted.push(inserted);
  console.log(`  after ${segs[i].id.padEnd(10)} target ${String(target).padStart(4)} - tail ${String(tail).padStart(4)} - head ${String(head).padStart(4)} -> insert ${String(inserted).padStart(4)}ms  (predict ${tail + inserted + head}ms)`);
}

// ---- 3. stage the silence: declared silent segments and the solved pauses -------------------
// Pause bytes are silence-gen's (see silenceAssetBytes), and every asset is computed before
// any is staged, so a pause silence-gen would have refused fails the run with nothing
// written. A pause solved to 0ms writes nothing, as before.
//
// No destination is written until every output has been checked. Each is staged to a
// temporary file beside it — an engine-chosen name, created exclusively — then the voice
// track is probed from its staged bytes and held to the reflowed timeline (C-6), and only
// then is each renamed into place, timing.json last. So a failed check leaves every file
// as it was. A rename replaces the directory entry rather than writing through it, so
// publishing cannot reach a narrated clip through a hard link either; that was refused
// before the plan all the same.
const pauseAsset = (ms, key) => (ms <= 0 ? null : { key, bytes: guard(() => silenceAssetBytes(ms, key)) });
const leadAsset = pauseAsset(leadInserted, 'lead.mp3');
const gapAssets = gapsInserted.map((ms, i) => pauseAsset(ms, gapAssetName(i)));
const outroAsset = timing.endCard.enabled ? pauseAsset(Number(timing.outroMs), 'outro.mp3') : null;
const silentAssets = measured.filter((m) => m.silent).map((m) => ({ key: m.key, bytes: m.bytes }));

const staged = [];
// A failure here is a failed run, not bad usage, and it is reported like the C-6 check:
// nothing has been published, and the catch below removes what was staged.
const stage = (key, bytes) => {
  let handle;
  try {
    handle = openExclusiveEngineFile(dir, `${key}.part-${process.pid}-${crypto.randomBytes(8).toString('hex')}`, `${key} staging file`);
  } catch (err) {
    throw new CliError(`could not stage ${key}: ${err.message}. Nothing was written to any of this run's outputs.`, EXIT.FAILED);
  }
  const entry = { key, dest: pathFor(key), path: handle.path, handle, closed: false, published: false };
  staged.push(entry);
  try {
    fs.writeFileSync(handle.fd, bytes);
    fs.closeSync(handle.fd);
  } catch (err) {
    throw new CliError(`could not write the ${key} staging file (${err.code ?? err.message}). Nothing was written to any of this run's outputs.`, EXIT.FAILED);
  }
  entry.closed = true;
  return entry.path;
};
// Removes every staging file not yet published, and says which could not be removed
// rather than claiming a clean abort. A closed descriptor is not closed again: its number
// may belong to another file by now.
const discardStaged = () => {
  const leftovers = [];
  for (const e of staged.filter((x) => !x.published)) {
    if (!e.closed) {
      const left = e.handle.cleanup();
      if (left) leftovers.push(left.message);
      continue;
    }
    try {
      fs.rmSync(e.path, { force: true });
    } catch (err) {
      leftovers.push(`${e.key} staging file ${e.path} could not be removed (${err.code ?? err.message}) — delete it by hand`);
    }
  }
  return leftovers;
};

let voiceMs, driftMs;
try {
  for (const a of silentAssets) stage(a.key, a.bytes);
  const leadFile = leadAsset ? stage(leadAsset.key, leadAsset.bytes) : null;
  const gapFiles = gapAssets.map((a) => (a ? stage(a.key, a.bytes) : null));
  const outroFile = outroAsset ? stage(outroAsset.key, outroAsset.bytes) : null;
  const leadRealMs = leadFile ? await probeMs(leadFile) : 0;
  const gapRealMs = []; for (const f of gapFiles) gapRealMs.push(f ? await probeMs(f) : 0);
  const outroRealMs = outroFile ? await probeMs(outroFile) : 0;

  // ---- 4. reflow the timeline ----------------------------------------------------------------
  // A narrated segment keeps the duration voice measured for its clip, which is reused as it
  // is. A declared silent segment takes the duration of the silence just generated, and its
  // record is rewritten to describe that clip: no words, no head or tail. plannedDurationMs
  // follows voice's rule, so a window that was edited since voice ran becomes the planned
  // one, and a second remix finds nothing left to change. "Edited since" is decided by the
  // same function validate-timing applies, so the two stages cannot disagree about it. A
  // record that gives no length vouches for no window, so it keeps nothing; it is not
  // refused either, because rewriting it here is its repair.
  let cursor = leadRealMs;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i], oldStart = s.startMs, silent = measured[i].silent;
    const dur = silent ? measured[i].totalMs : s.audio.durationMs;
    if (silent) {
      const stillReflowed = Number.isFinite(s.plannedDurationMs) && silentRecordState(s).state === 'matches';
      s.plannedDurationMs = stillReflowed ? s.plannedDurationMs : silentDurationMs(s);
      s.audio.file = segmentClipName(i);
      s.audio.durationMs = dur;
    }
    s.startMs = cursor; s.endMs = cursor + dur;
    const delta = s.startMs - oldStart;
    s.audio.headMs = measured[i].headMs;
    s.audio.tailMs = measured[i].tailMs;
    s.audio.words = silent ? [] : (s.audio.words || []).map(w => ({ word: w.word, startMs: w.startMs + delta, endMs: w.endMs + delta }));
    cursor = s.endMs + (i < segs.length - 1 ? gapRealMs[i] : 0);
  }
  const contentMs = segs[segs.length - 1].endMs;

  // ---- 5. re-concatenate ---------------------------------------------------------------------
  // From the bytes just staged, held in memory, and the narrated clips, which are only read:
  // no destination is published yet, so none is read back.
  function audioStart(b) {
    if (b.length >= 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33)
      return 10 + (((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f));
    return 0;
  }
  const parts = [];
  if (leadAsset) parts.push(leadAsset.bytes);
  for (let i = 0; i < segs.length; i++) {
    parts.push(measured[i].silent ? measured[i].bytes : fs.readFileSync(measured[i].file));
    if (i < segs.length - 1 && gapAssets[i]) parts.push(gapAssets[i].bytes);
  }
  if (outroAsset) parts.push(outroAsset.bytes);
  const voiceFile = stage('voiceover.mp3', Buffer.concat(parts.map((b, i) => (i === 0 ? b : b.subarray(audioStart(b))))));

  // remix is the second producer of a timing file, and it wrote these unconditionally — so a
  // disabled end card still shipped contentMs/outroMs/builderVersion and the result failed the
  // schema that forbids them. Same rule, same helper as voice.mjs: state it once, apply it at
  // every producer. `outroRealMs` is already 0 when the end card is off, so durationMs is
  // unchanged; what changes is that the end-card-only fields are no longer left behind.
  normalizeEndCardFields(timing, { contentMs, outroMs: outroRealMs });
  timing.leadInMs = leadRealMs;

  voiceMs = await probeMs(voiceFile);
  driftMs = Math.abs(voiceMs - timing.durationMs);
  const driftLimitMs = Math.max(TOLERANCE_MS, 1500);
  if (driftMs > driftLimitMs) {
    throw new CliError(
      `C-6 voice drift ${driftMs}ms: the new voice track is ${voiceMs}ms, but the reflowed timeline says ` +
      `${timing.durationMs}ms, beyond the ${driftLimitMs}ms tolerance. The narrated clips on disk are not the length ` +
      'their records give — typically a clip was replaced, or a record edited, since voice.mjs ran. Nothing was ' +
      "written to any of this run's outputs: each is as it was. Restore the clips their records describe, or " +
      gatedRemedy(voiceGate, {
        open: 'run voice.mjs (S3) to re-synthesise and re-measure the narration',
        stem: 'voice.mjs (S3) re-synthesises and re-measures the narration',
      }) + '.',
      EXIT.FAILED);
  }

  delete timing.timingHash;
  timing.timingHash = timingSeal(timing);
  stage('timing.json', JSON.stringify(timing, null, 2));
} catch (err) {
  for (const left of discardStaged()) console.error(`warning: ${left}`);
  if (!(err instanceof CliError)) throw err;
  console.error(`error: ${err.message}`);
  process.exit(err.exitCode);
}

// ---- 6. publish ------------------------------------------------------------------------------
// Renamed in the order staged, timing.json last, so the timeline is never updated to
// describe audio that is not in place. Nothing is rolled back: a rename that fails leaves
// those before it published, so the report names exactly which were and which were not.
for (const e of staged) {
  try {
    fs.renameSync(e.path, e.dest);
    e.published = true;
  } catch (err) {
    const published = staged.filter((x) => x.published).map((x) => x.key);
    const unpublished = staged.filter((x) => !x.published).map((x) => x.key);
    for (const left of discardStaged()) console.error(`warning: ${left}`);
    console.error(
      `error: could not publish ${e.key} (${err.code ?? err.message}). ` +
      `Published: ${published.length ? published.join(', ') : 'nothing'}. Not published: ${unpublished.join(', ')}. ` +
      'timing.json was not updated, so it still describes the audio from before this run' +
      (published.length ? ', while the files published above hold this run\'s' : '') +
      '. Fix the cause and re-run remix.mjs --apply --replace, which regenerates each of them from timing.json.');
    process.exit(EXIT.FAILED);
  }
}

const mm = ms => `${Math.floor(ms / 60000)}:${String(Math.round(ms % 60000 / 1000)).padStart(2, '0')}`;
console.log(`\nvoiceover ${voiceMs}ms | timeline ${timing.durationMs}ms | drift ${driftMs}ms`);
console.log(`final length ${mm(timing.durationMs)}`);
