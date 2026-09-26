/*
 * Blank-segment canary (post-S6).
 *
 * Samples frames across the captured sequence and fails when two DIFFERENT segments
 * render identically. That is the signature of a segment which never became visible:
 * every trigger resolves, animates and reports success against a hidden element, so
 * nothing errors and the only evidence is that the pixels did not change.
 *
 * It was written after `code` mode rendered a completely blank segment and the sole
 * symptom was four preview frames, taken at four different timestamps, coming back
 * byte-identical.
 *
 * Two distinct signals, deliberately not conflated:
 *   FAIL  two different segments produced the same frame -> at least one is not rendering
 *   INFO  one segment looked identical at every point sampled -> static, which is fine
 *         for a title card and suspicious for anything that should animate
 *
 * Byte-identity is only meaningful ACROSS segments. Within a segment a deterministic
 * renderer legitimately produces identical frames whenever nothing is moving.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    frames: { type: 'string' },
    samples: { type: 'string' },
    help: { type: 'boolean' },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log(`blank-segment-canary — prove every segment actually rendered (post-S6).

  node blank-segment-canary.mjs
  node blank-segment-canary.mjs --samples 5

Options
  --project <dir>   project root (default: current directory)
  --frames <dir>    frame directory, relative to the project (default: frames)
  --samples <n>     sample points per segment, 1..20 (default: 3)
  --help            show this message

Exit codes: 0 every segment distinct · 1 two segments render identically · 2 bad usage`);
  process.exit(0);
}

const dir = path.resolve(values.project ?? process.cwd());
const framesDir = path.resolve(dir, values.frames ?? 'frames');
const samples = Number(values.samples ?? 3);

if (!Number.isInteger(samples) || samples < 1 || samples > 20) {
  console.error(`error: --samples must be an integer 1..20, got ${values.samples}`);
  process.exit(2);
}
for (const [label, p] of [['timing.json', path.join(dir, 'timing.json')], ['frames directory', framesDir]]) {
  if (!fs.existsSync(p)) {
    console.error(`error: ${label} not found at ${p}`);
    process.exit(2);
  }
}

const timing = JSON.parse(fs.readFileSync(path.join(dir, 'timing.json'), 'utf8'));
const fps = timing.project?.fps ?? 30;
const segs = timing.segments ?? [];
if (segs.length === 0) {
  console.error('error: timing.json has no segments');
  process.exit(2);
}

const ts = (ms) => {
  const t = Math.max(0, Math.round(ms));
  return `${String(Math.floor(t / 60000)).padStart(2, '0')}:` +
    `${String(Math.floor((t % 60000) / 1000)).padStart(2, '0')}.` +
    `${String(t % 1000).padStart(3, '0')}`;
};

const findFrame = (n) => {
  for (const ext of ['jpg', 'jpeg', 'png']) {
    const f = path.join(framesDir, `frame_${String(n).padStart(5, '0')}.${ext}`);
    if (fs.existsSync(f)) return f;
  }
  return null;
};

// hash -> first occurrence, so a collision can name BOTH sides with timestamps. Reporting
// only that "two frames matched" sends the reader back to comparing frames by eye, which
// is the work this check exists to replace.
const firstSeen = new Map();
const collisions = [];
const staticSegs = [];
let missing = 0;

console.log(`sampling ${samples} point(s) per segment across ${segs.length} segments at ${fps} fps\n`);
console.log('segment        at            frame  hash');

for (const s of segs) {
  const span = s.endMs - s.startMs;
  const hashes = new Set();
  for (let i = 0; i < samples; i += 1) {
    // Interior points only: the first and last frames of a segment can legitimately match
    // a neighbour mid-transition, which would be a false alarm.
    const atMs = s.startMs + (span * (i + 1)) / (samples + 1);
    const n = Math.max(1, Math.round((atMs / 1000) * fps));
    const f = findFrame(n);
    if (!f) {
      missing += 1;
      console.log(`${s.id.padEnd(13)} ${ts(atMs)} ${String(n).padStart(8)}  MISSING`);
      continue;
    }
    const h = crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex').slice(0, 12);
    hashes.add(h);
    const prior = firstSeen.get(h);
    if (prior && prior.segId !== s.id) {
      collisions.push({ a: prior, b: { segId: s.id, atMs, frame: n } });
      console.log(`${s.id.padEnd(13)} ${ts(atMs)} ${String(n).padStart(8)}  ${h}  <-- matches ${prior.segId}`);
    } else {
      if (!prior) firstSeen.set(h, { segId: s.id, atMs, frame: n });
      console.log(`${s.id.padEnd(13)} ${ts(atMs)} ${String(n).padStart(8)}  ${h}`);
    }
  }
  if (samples > 1 && hashes.size === 1) staticSegs.push(s.id);
}

if (staticSegs.length > 0) {
  console.log(`\nINFO: identical at every sampled point — ${staticSegs.join(', ')}`);
  console.log('      Expected for a static card; investigate if it should be animating.');
}

if (missing > 0) console.log(`\nWARNING: ${missing} sample(s) had no frame on disk — capture may be incomplete.`);

if (collisions.length === 0) {
  console.log(`\nOK: no two segments render identically (${firstSeen.size} distinct frames).`);
  process.exit(0);
}

console.error(`\nFAILED: ${collisions.length} cross-segment frame collision(s) — at least one segment is not rendering.\n`);
for (const c of collisions) {
  console.error(`  "${c.b.segId}" at ${ts(c.b.atMs)} (frame ${c.b.frame}) is byte-identical to`);
  console.error(`  "${c.a.segId}" at ${ts(c.a.atMs)} (frame ${c.a.frame})\n`);
}
console.error('Two different segments cannot legitimately produce the same pixels. The usual cause');
console.error('is an element that never became visible: a trigger whose target resolves and animates');
console.error('happily against a hidden ancestor reports success and renders nothing.');
console.error(`Open ${path.basename(framesDir)}/frame_${String(collisions[0].b.frame).padStart(5, '0')} to see what was actually captured.`);
process.exit(1);
