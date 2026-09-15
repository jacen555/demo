// Remix — re-solve the inserted silences using REAL head/tail measured from decoded audio,
// then re-concatenate and reflow the timeline. Does NOT re-synthesize: the segment_*.mp3
// clips already on disk are reused byte-for-byte, so only the pacing changes.
//
// Why this exists: msedge-tts word-boundary metadata cannot reveal trailing silence, because
// the scale factor (durationMs / lastWordEnd) pins the final word boundary to the clip end.
// Decoding is the only way to see the real tail.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { parseFile } from 'music-metadata';
import { canonicalBytes } from './canonical-json.mjs';

const dir = process.cwd();
const timingPath = path.join(dir, 'timing.json');
const timing = JSON.parse(fs.readFileSync(timingPath, 'utf8'));
const stable = timing.intake;

const LEAD_IN_MS = Number(stable.leadInMs ?? 2000);
const GAP_DEFAULT_MS = Number(stable.perceivedGapMs ?? 2000);
const GAP_OVERRIDES = stable.perceivedGapOverrides || {};
const FRAME_MS = 24;
const alignUp = ms => Math.max(0, Math.round(ms / FRAME_MS) * FRAME_MS);
const probeMs = async f => Math.round(((await parseFile(f, { duration: true })).format.duration ?? 0) * 1000);

// ---- 1. measure REAL head/tail silence by decoding each clip --------------------------------
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

const segs = timing.segments;
const measured = [];
console.log('measured clip edges (decoded):');
for (let i = 0; i < segs.length; i++) {
  const file = path.join(dir, segs[i].audio.file);
  const e = await edges(file);
  measured.push({ file, ...e });
  console.log(`  ${segs[i].id.padEnd(11)} ${String(e.totalMs).padStart(6)}ms  head ${String(e.headMs).padStart(4)}ms  tail ${String(e.tailMs).padStart(4)}ms`);
}
await browser.close();

// ---- 2. re-solve inserted silences -----------------------------------------------------------
const leadInserted = alignUp(Math.max(0, LEAD_IN_MS - measured[0].headMs));
const gapsInserted = [];
console.log('\nre-solved pacing:');
console.log(`  lead-in       target ${LEAD_IN_MS}ms - head ${measured[0].headMs} -> insert ${leadInserted}ms`);
for (let i = 0; i < segs.length - 1; i++) {
  const target = Number(GAP_OVERRIDES[segs[i].id] ?? GAP_DEFAULT_MS);
  const tail = measured[i].tailMs, head = measured[i + 1].headMs;
  const inserted = alignUp(Math.max(0, target - tail - head));
  gapsInserted.push(inserted);
  console.log(`  after ${segs[i].id.padEnd(10)} target ${String(target).padStart(4)} - tail ${String(tail).padStart(4)} - head ${String(head).padStart(4)} -> insert ${String(inserted).padStart(4)}ms  (predict ${tail + inserted + head}ms)`);
}

const gen = (ms, name) => { if (ms <= 0) return null; execFileSync(process.execPath, ['silence-gen.mjs', name, String(ms)], { cwd: dir, stdio: 'pipe' }); return path.join(dir, name); };
const leadFile = gen(leadInserted, 'lead.mp3');
const gapFiles = gapsInserted.map((ms, i) => gen(ms, `gap_${String(i + 1).padStart(2, '0')}.mp3`));
const outroFile = timing.endCard.enabled ? gen(Number(timing.outroMs), 'outro.mp3') : null;
const leadRealMs = leadFile ? await probeMs(leadFile) : 0;
const gapRealMs = []; for (const f of gapFiles) gapRealMs.push(f ? await probeMs(f) : 0);
const outroRealMs = outroFile ? await probeMs(outroFile) : 0;

// ---- 3. reflow the timeline ------------------------------------------------------------------
let cursor = leadRealMs;
for (let i = 0; i < segs.length; i++) {
  const s = segs[i], oldStart = s.startMs, dur = s.audio.durationMs;
  s.startMs = cursor; s.endMs = cursor + dur;
  const delta = s.startMs - oldStart;
  s.audio.headMs = measured[i].headMs;
  s.audio.tailMs = measured[i].tailMs;
  s.audio.words = (s.audio.words || []).map(w => ({ word: w.word, startMs: w.startMs + delta, endMs: w.endMs + delta }));
  cursor = s.endMs + (i < segs.length - 1 ? gapRealMs[i] : 0);
}
const contentMs = segs[segs.length - 1].endMs;

// ---- 4. re-concatenate -----------------------------------------------------------------------
function audioStart(b) {
  if (b.length >= 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33)
    return 10 + (((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f));
  return 0;
}
const parts = [];
if (leadFile) parts.push(leadFile);
for (let i = 0; i < segs.length; i++) { parts.push(measured[i].file); if (i < segs.length - 1 && gapFiles[i]) parts.push(gapFiles[i]); }
if (outroFile) parts.push(outroFile);
fs.writeFileSync(path.join(dir, 'voiceover.mp3'),
  Buffer.concat(parts.map((p, i) => { const b = fs.readFileSync(p); return i === 0 ? b : b.subarray(audioStart(b)); })));

timing.contentMs = contentMs;
timing.outroMs = outroRealMs;
timing.durationMs = contentMs + outroRealMs;
timing.leadInMs = leadRealMs;

const voiceMs = await probeMs(path.join(dir, 'voiceover.mp3'));
const driftMs = Math.abs(voiceMs - timing.durationMs);
if (driftMs > Math.max(Number(stable.toleranceMs), 1500)) throw new Error(`C-6 voice drift ${driftMs}ms`);

delete timing.timingHash;
timing.timingHash = crypto.createHash('sha256').update(canonicalBytes(timing)).digest('hex');
fs.writeFileSync(timingPath, JSON.stringify(timing, null, 2));

const mm = ms => `${Math.floor(ms / 60000)}:${String(Math.round(ms % 60000 / 1000)).padStart(2, '0')}`;
console.log(`\nvoiceover ${voiceMs}ms | timeline ${timing.durationMs}ms | drift ${driftMs}ms`);
console.log(`final length ${mm(timing.durationMs)}`);
