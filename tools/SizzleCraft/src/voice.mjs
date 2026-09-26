// Voice stage v2 — ffmpeg-free, with PERCEIVED-gap control.
//
// The audible gap between two segments is not just the silence we insert: it is
//     tail_silence(segment N) + inserted_silence + head_silence(segment N+1)
// Every TTS clip carries its own leading/trailing silence (~0.2-0.3s each), so this stage
// measures that from the word-boundary metadata and solves each inserted gap so the
// PERCEIVED gap hits its target exactly.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFile } from 'music-metadata';
import { canonicalBytes } from './canonical-json.mjs';
import { EXIT, guard, parseCli, requireExistingFile, resolveEngineOutput, describeWrite, planFooter, requireFiniteNumber, assertDistinctDestinations } from './cli-support.mjs';

const USAGE = `
voice — synthesise narration per segment and concatenate it (pipeline stage S3).

  node voice.mjs                       plan only (default)
  node voice.mjs --apply --replace     synthesise and rewrite voiceover.mp3 + timing.json

Options
  --project <dir>   project root; no path may escape it (default: current directory)
  --apply           actually synthesise and write. Without it nothing is written.
  --replace         permit overwriting the segment clips, voiceover.mp3 and timing.json
  --help            show this message

This stage calls a network TTS service and rewrites the approved timeline, so it does
nothing without an explicit opt-in.

Exit codes: 0 success/plan · 1 synthesis failed · 2 bad usage or refused overwrite
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
const timing = JSON.parse(fs.readFileSync(timingPath, 'utf8'));
const stable = timing.intake || {};
for (const k of ['voice', 'speed', 'silenceMs', 'toleranceMs']) {
  if (stable[k] === undefined || stable[k] === null) {
    console.error(`error: pre-approval stable timing input missing: intake.${k}`);
    process.exit(EXIT.USAGE);
  }
}
if (!timing.endCard || typeof timing.endCard.enabled !== 'boolean') {
  console.error('error: pre-approval endCard decision missing (timing.endCard.enabled must be a boolean)');
  process.exit(EXIT.USAGE);
}

const voice = stable.voice;
// Validated, not coerced. `Number('oops')` is NaN, and `drift > Math.max(NaN, 1500)`
// is `drift > NaN` — always false. The C-6 drift check below would still be written,
// still be reached, and never fire. A threshold that cannot be compared does not relax
// the check, it deletes it.
const speed = guard(() => requireFiniteNumber(stable.speed, { name: 'intake.speed', min: 0.5, max: 2 }));
const toleranceMs = guard(() => requireFiniteNumber(stable.toleranceMs, { name: 'intake.toleranceMs', min: 0, max: 600_000 }));
const perSegToleranceMs = guard(() =>
  requireFiniteNumber(stable.perSegmentToleranceMs ?? 150, { name: 'intake.perSegmentToleranceMs', min: 0, max: 600_000 }));

// --- PERCEIVED pacing targets (ms) ----------------------------------------------------------
const LEAD_IN_MS = guard(() => requireFiniteNumber(stable.leadInMs ?? 2000, { name: 'intake.leadInMs', min: 0, max: 600_000 }));
const GAP_DEFAULT_MS = guard(() => requireFiniteNumber(stable.perceivedGapMs ?? 2000, { name: 'intake.perceivedGapMs', min: 0, max: 600_000 }));
const GAP_OVERRIDES = stable.perceivedGapOverrides || {};     // { "<afterSegmentId>": ms }
const FRAME_MS = 24;                                          // one MPEG-2 L3 frame @ 24 kHz
const alignUp = ms => Math.max(0, Math.round(ms / FRAME_MS) * FRAME_MS);

// --- C-11: voice must be on the brand allow-list ---------------------------------------------
const allowVoices = JSON.parse(fs.readFileSync(path.join(dir, 'brand', 'tokens.json'), 'utf8'))?.audio?.ttsVoices;
if (!Array.isArray(allowVoices) || !allowVoices.length) throw new Error('C-11: cannot load audio.ttsVoices allow-list');
if (!allowVoices.includes(voice)) throw new Error(`C-11: voice "${voice}" not on allow-list [${allowVoices.join(', ')}]`);

const probeMs = async f => Math.round(((await parseFile(f, { duration: true })).format.duration ?? 0) * 1000);
const ratePct = (speed >= 1 ? '+' : '') + Math.round((speed - 1) * 100) + '%';

// ---- the write set --------------------------------------------------------------------------
// Declared once and used for three things: the plan, the distinctness check, and the
// actual writes. Every entry is an ENGINE-chosen artifact — the caller names none of
// these — so each resolves with links refused, not followed.
const segmentName = (i) => `segment_${String(i + 1).padStart(2, '0')}.mp3`;
const WRITE_SET = [
  ...timing.segments.map((seg, i) => ({ key: segmentName(i), label: `segment ${seg.id} output`, append: false })),
  { key: 'voiceover.mp3', label: 'voiceover.mp3', append: false },
  { key: 'timing.json', label: 'timing.json', append: false },
  { key: 'calibration-observed.json', label: 'calibration-observed.json', append: false },
  { key: 'sync-mapping.md', label: 'sync-mapping.md', append: false },
  // Appended to on a synthesis retry, so it carries no --replace requirement — but it is
  // still a write, and still an engine-chosen name.
  { key: 'heal-log.txt', label: 'heal-log.txt', append: true },
];
// Resolved without the replace guard first, so the plan can describe replacing a file
// rather than refusing to talk about it.
const writeSet = WRITE_SET.map((o) => ({
  ...o,
  path: guard(() => resolveEngineOutput(dir, o.key, { apply: false, replace: cli.replace, label: o.label })),
}));
guard(() => assertDistinctDestinations(writeSet.map(({ key, path: p }) => ({ key, path: p })), 'output'));

// ---- the safe default -----------------------------------------------------------------------
// Prerequisites and the write set are established first, so the plan reports the truth
// about every file --apply touches. Nothing has been written; a bare run stops here
// rather than calling the TTS service and rewriting the timeline.
if (!cli.apply) {
  console.log(`plan: synthesise ${timing.segments?.length ?? 0} segment(s) with voice "${voice}" at ${ratePct}`);
  for (const o of writeSet) {
    const status = o.append ? 'would APPEND on a synthesis retry' : describeWrite(o.path, cli.replace);
    console.log(`  ${o.key.padEnd(26)} ${status}`);
  }
  planFooter();
  process.exit(EXIT.OK);
}
// Now that we are writing, enforce the replace guard across the whole set.
for (const o of writeSet) {
  if (!o.append) guard(() => resolveEngineOutput(dir, o.key, { apply: true, replace: cli.replace, label: o.label }));
}

const pathFor = (key) => writeSet.find((o) => o.key === key).path;
const segmentTargets = timing.segments.map((seg, i) => ({ key: seg.id, path: pathFor(segmentName(i)) }));
const voiceOutPath = pathFor('voiceover.mp3');
const timingOutPath = pathFor('timing.json');
const calibrationPath = pathFor('calibration-observed.json');
const syncMappingPath = pathFor('sync-mapping.md');
const healLogPath = pathFor('heal-log.txt');

// Loaded only on the --apply path: a plan must not need the TTS client.
const { MsEdgeTTS } = await import('msedge-tts');

async function synthOnce(text, file) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, 'audio-24khz-96kbitrate-mono-mp3', { wordBoundaryEnabled: true });
  const { audioStream, metadataStream } = tts.toStream(text, { rate: ratePct });
  const chunks = [], words = [];
  metadataStream.on('data', buf => {
    try {
      const p = JSON.parse(Buffer.from(buf).toString('utf8'));
      for (const m of p.Metadata || []) if (m.Type === 'WordBoundary') words.push({
        word: m.Data.text.Text,
        localStartMs: Math.round(m.Data.Offset / 10000),
        localEndMs: Math.round((m.Data.Offset + m.Data.Duration) / 10000),
      });
    } catch { }
  });
  audioStream.on('data', c => chunks.push(c));
  await new Promise((r, j) => { audioStream.on('end', r); audioStream.on('error', j); });
  await new Promise(r => setTimeout(r, 400));
  const buf = Buffer.concat(chunks);
  if (!buf.length) throw new Error('empty TTS stream');
  fs.writeFileSync(file, buf);
  const durationMs = await probeMs(file);
  if (!durationMs) throw new Error('zero-duration TTS output');
  if (!words.length) throw new Error('no word boundaries returned');
  const computedMs = words[words.length - 1].localEndMs;
  const scale = computedMs > 0 ? durationMs / computedMs : 1;
  // head/tail silence, in the REAL (scaled) timebase
  const headMs = Math.max(0, Math.round(words[0].localStartMs * scale));
  const tailMs = Math.max(0, durationMs - Math.round(words[words.length - 1].localEndMs * scale));
  return { file, durationMs, words, scale, headMs, tailMs };
}

async function synth(text, file, id) {                      // C-14 bounded self-heal
  for (let attempt = 1; attempt <= 4; attempt++) {
    try { return await synthOnce(text, file); }
    catch (e) {
      fs.appendFileSync(healLogPath, `[voice] ${id} attempt ${attempt}: ${e.message}\n`);
      console.log(`[voice] ${id} attempt ${attempt} failed: ${e.message}`);
      if (attempt === 4) throw e;
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
}

// ---- 1. synthesize -------------------------------------------------------------------------
console.log(`voice=${voice} rate=${ratePct} (speed ${speed})\n`);
const results = [];
for (let i = 0; i < timing.segments.length; i++) {
  const seg = timing.segments[i];
  const r = await synth(seg.voiceoverText, segmentTargets[i].path, seg.id);
  results.push(r);
  console.log(`synth ${seg.id.padEnd(11)} ${String(r.durationMs).padStart(6)}ms  head ${String(r.headMs).padStart(4)}ms  tail ${String(r.tailMs).padStart(4)}ms`);
}

// ---- 2. per-segment fit gate (C-10) --------------------------------------------------------
const overruns = timing.segments
  .map((s, i) => ({ id: s.id, over: results[i].durationMs - (s.endMs - s.startMs) }))
  .filter(f => f.over > perSegToleranceMs);
if (overruns.length) throw new Error(`C-10 per-segment fit failed: ${overruns.map(o => `${o.id} (+${o.over}ms)`).join(', ')}`);

// ---- 3. solve inserted silences so PERCEIVED pacing hits its targets ------------------------
const leadInsertedMs = alignUp(Math.max(0, LEAD_IN_MS - results[0].headMs));
const gaps = [];   // gaps[i] = silence inserted AFTER segment i
console.log('\nperceived-gap solve:');
console.log(`  lead-in       target ${String(LEAD_IN_MS).padStart(5)}ms  - head ${String(results[0].headMs).padStart(4)}ms  -> insert ${leadInsertedMs}ms`);
for (let i = 0; i < timing.segments.length - 1; i++) {
  const after = timing.segments[i].id;
  const target = Number(GAP_OVERRIDES[after] ?? GAP_DEFAULT_MS);
  const tail = results[i].tailMs, head = results[i + 1].headMs;
  const inserted = alignUp(Math.max(0, target - tail - head));
  gaps.push(inserted);
  console.log(`  after ${after.padEnd(10)} target ${String(target).padStart(5)}ms  - tail ${String(tail).padStart(4)} - head ${String(head).padStart(4)}  -> insert ${String(inserted).padStart(5)}ms  (perceived ~${tail + inserted + head}ms)`);
}

// materialise the silence assets we actually need.
// Resolve the generator next to THIS script rather than relative to the project dir.
// The write flags are FORWARDED from this stage's own opt-in, never hardcoded: a parent
// that was not asked to write must not hand a child the flags that make it write.
const SILENCE_GEN = fileURLToPath(new URL('./silence-gen.mjs', import.meta.url));
const childWriteFlags = [...(cli.apply ? ['--apply'] : []), ...(cli.replace ? ['--replace'] : [])];
const silenceFor = (ms, name) => {
  if (ms <= 0) return null;
  execFileSync(process.execPath, [SILENCE_GEN, '--project', dir, '--out', name, '--ms', String(ms), ...childWriteFlags], { cwd: dir, stdio: 'pipe' });
  return path.join(dir, name);
};
const leadFile = silenceFor(leadInsertedMs, 'lead.mp3');
const gapFiles = gaps.map((ms, i) => silenceFor(ms, `gap_${String(i + 1).padStart(2, '0')}.mp3`));
const outroTargetMs = timing.endCard.enabled ? Number(timing.outroMs) : 0;
const outroFile = outroTargetMs > 0 ? silenceFor(outroTargetMs, 'outro.mp3') : null;

const leadRealMs = leadFile ? await probeMs(leadFile) : 0;
const gapRealMs = [];
for (const f of gapFiles) gapRealMs.push(f ? await probeMs(f) : 0);
const outroRealMs = outroFile ? await probeMs(outroFile) : 0;

// ---- 4. reflow the timeline onto measured audio + solved gaps -------------------------------
let cursor = leadRealMs;
for (let i = 0; i < timing.segments.length; i++) {
  const seg = timing.segments[i], r = results[i];
  const authoredWindowMs = seg.endMs - seg.startMs;
  const priorMeasuredMs = Number(seg.audio?.durationMs);
  const stillReflowed = Number.isFinite(seg.plannedDurationMs) && Number.isFinite(priorMeasuredMs) && authoredWindowMs === priorMeasuredMs;
  seg.plannedDurationMs = stillReflowed ? seg.plannedDurationMs : authoredWindowMs;
  seg.startMs = cursor;
  seg.endMs = cursor + r.durationMs;
  seg.audio = {
    file: path.basename(r.file), durationMs: r.durationMs,
    headMs: r.headMs, tailMs: r.tailMs,
    words: r.words.map(w => ({ word: w.word, startMs: cursor + Math.round(w.localStartMs * r.scale), endMs: cursor + Math.round(w.localEndMs * r.scale) })),
  };
  cursor = seg.endMs + (i < timing.segments.length - 1 ? gapRealMs[i] : 0);
}
const contentMs = timing.segments[timing.segments.length - 1].endMs;

// ---- 5. concatenate ------------------------------------------------------------------------
function audioStart(buffer) {
  if (buffer.length >= 10 && buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
    return 10 + (((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f));
  }
  return 0;
}
const parts = [];
if (leadFile) parts.push(leadFile);
for (let i = 0; i < results.length; i++) {
  parts.push(results[i].file);
  if (i < results.length - 1 && gapFiles[i]) parts.push(gapFiles[i]);
}
if (outroFile) parts.push(outroFile);
fs.writeFileSync(voiceOutPath,
  Buffer.concat(parts.map((p, i) => { const b = fs.readFileSync(p); return i === 0 ? b : b.subarray(audioStart(b)); })));

// ---- 6. end-card fields + drift gate (C-6) --------------------------------------------------
const bvOk = typeof timing.builderVersion === 'string' && timing.builderVersion.trim() !== ''
  && !['undefined', 'null'].includes(timing.builderVersion.trim().toLowerCase());
if (timing.endCard.enabled && !bvOk) throw new Error('approved enabled endCard requires a valid builderVersion');
if (timing.endCard.enabled) { timing.contentMs = contentMs; timing.outroMs = outroRealMs; timing.durationMs = contentMs + outroRealMs; }
else { delete timing.contentMs; delete timing.outroMs; timing.durationMs = contentMs; }
timing.leadInMs = leadRealMs;

const voiceMs = await probeMs(path.join(dir, 'voiceover.mp3'));
const driftMs = Math.abs(voiceMs - timing.durationMs);
console.log(`\nvoiceover ${voiceMs}ms | timeline ${timing.durationMs}ms | drift ${driftMs}ms`);
if (driftMs > Math.max(toleranceMs, 1500)) throw new Error(`C-6 voice drift ${driftMs}ms exceeds tolerance`);

// ---- 7. calibration evidence + timing hash --------------------------------------------------
const roundedSpeed = 1 + Math.round((speed - 1) * 100) / 100;
const calSegs = timing.segments.map((s, i) => {
  const words = s.voiceoverText.trim().split(/\s+/).filter(Boolean).length;
  const speechMs = results[i].durationMs - results[i].headMs - results[i].tailMs;
  return { id: s.id, words, chars: s.voiceoverText.length, clipMs: results[i].durationMs, speechMs, effWps: +(words / (speechMs / 1000)).toFixed(3) };
});
const totW = calSegs.reduce((a, c) => a + c.words, 0), totMs = calSegs.reduce((a, c) => a + c.speechMs, 0);
const obsEff = totW / (totMs / 1000);
fs.writeFileSync(calibrationPath, JSON.stringify({
  voiceId: voice, roundedSpeed,
  aggregate: { words: totW, speechMs: totMs, observedEffWps: +obsEff.toFixed(3), observedSafeWps: +(obsEff / roundedSpeed).toFixed(3) },
  segments: calSegs,
}, null, 2));

delete timing.timingHash;
timing.timingHash = crypto.createHash('sha256').update(canonicalBytes(timing)).digest('hex');
fs.writeFileSync(timingOutPath, JSON.stringify(timing, null, 2));

fs.writeFileSync(syncMappingPath,
  `# Sync Mapping\n\nvoice=${voice}\nrate=${ratePct}\nvoiceoverMs=${voiceMs}\ntimingMs=${timing.durationMs}\n` +
  `contentMs=${contentMs}\nleadInMs=${leadRealMs}\noutroMs=${outroRealMs}\n` +
  `perceivedGapTargetMs=${GAP_DEFAULT_MS}\ninsertedGapsMs=${gapRealMs.join(',')}\ndriftMs=${driftMs}\n` +
  `observedEffWps=${obsEff.toFixed(3)}\nstatus=pass\n`);

const mm = ms => `${Math.floor(ms / 60000)}:${String(Math.round(ms % 60000 / 1000)).padStart(2, '0')}`;
console.log(`\nwrote voiceover.mp3 — final length ${mm(timing.durationMs)} (${timing.durationMs}ms)`);
console.log(`speech-only rate ${obsEff.toFixed(2)} words/sec at ${speed}x`);
