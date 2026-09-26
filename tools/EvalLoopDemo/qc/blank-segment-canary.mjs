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
    'dead-air': { type: 'boolean' },
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
  --dead-air        also report each segment's longest motionless stretch
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
// Confine both reads. A planted link named timing.json or frames/ would otherwise have this
// script parse and hash files outside the project, and the parser error quotes what it read.
for (const [label, p] of [['timing.json', path.join(dir, 'timing.json')], ['frames directory', framesDir]]) {
  let real;
  try { real = fs.realpathSync(p); }
  catch {
    console.error(`error: ${label} not found at ${p}`);
    process.exit(2);
  }
  const root = fs.realpathSync(dir);
  const rel = path.relative(root, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    console.error(`error: ${label} resolves outside the project root once links are followed — refusing`);
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
  // A SEGMENT THAT NEVER MOVES WHILE ITS TRIGGERS FIRE IS A FAILURE, NOT A NOTE.
  //
  // The cross-segment check compares WHOLE frames, and every segment carries a distinct
  // title — so hiding only the body still produces frames that differ from every other
  // segment and the collision alarm stays silent. That is the exact failure this script
  // exists to catch, reachable through `code` mode, which was added after it was written.
  //
  // Scheduled triggers are the discriminator: a static title card legitimately never
  // moves, but a segment with content triggers spread across its window and zero pixel
  // change has had those triggers resolve against something invisible.
  const contentless = [];
  for (const id of staticSegs) {
    const s = segs.find(x => x.id === id);
    const trig = (s?.triggers ?? []).filter(t => t.atMs > 0);
    if (trig.length >= 2) contentless.push({ id, count: trig.length });
  }
  const benign = staticSegs.filter(id => !contentless.some(c => c.id === id));

  if (benign.length) {
    console.log(`\nINFO: identical at every sampled point — ${benign.join(', ')}`);
    console.log('      No content triggers scheduled, so a static card is expected here.');
  }
  if (contentless.length) {
    for (const c of contentless) {
      collisions.push({
        a: { segId: c.id, atMs: segs.find(x => x.id === c.id).startMs, frame: 0 },
        b: { segId: c.id, atMs: segs.find(x => x.id === c.id).endMs, frame: 0 },
        reason: `${c.count} content triggers fired but nothing on screen changed`,
      });
    }
  }
}

// AN INCOMPLETE RUN CANNOT CERTIFY ANYTHING. Missing frames used to be a warning followed
// by exit 0, so a capture that died halfway reported "no two segments render identically"
// — true, and meaningless, because most of them were never compared.
if (missing > 0) {
  console.error(`\nFAILED: ${missing} sample(s) had no frame on disk — the capture is incomplete,`);
  console.error('so this run proves nothing about the segments it could not read.');
  process.exit(1);
}

// DEAD AIR. A separate question from "did it render": a segment can render perfectly and
// still sit motionless for most of its narration, which reads as a stalled video. Measured
// by walking consecutive frames rather than inferred from trigger times, because a trigger
// can fire and change nothing.
if (values['dead-air']) {
  console.log('\nsegment        longest still  at            share of segment');
  for (const s of segs) {
    const from = Math.max(1, Math.round((s.startMs / 1000) * fps));
    const to = Math.max(from, Math.round((s.endMs / 1000) * fps));
    let prev = null, run = 0, best = 0, bestEnd = from;
    for (let n = from; n <= to; n += 1) {
      const f = findFrame(n);
      if (!f) { prev = null; run = 0; continue; }
      const h = crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
      if (h === prev) { run += 1; if (run > best) { best = run; bestEnd = n; } }
      else { run = 0; }
      prev = h;
    }
    const stillMs = (best / fps) * 1000;
    const startedMs = ((bestEnd - best) / fps) * 1000;
    const share = Math.round((stillMs / (s.endMs - s.startMs)) * 100);
    const flag = share >= 40 ? '  <-- over 40% motionless' : '';
    console.log(
      `${s.id.padEnd(13)} ${(stillMs / 1000).toFixed(1).padStart(13)}s ${ts(startedMs).padStart(13)} ` +
      `${String(share).padStart(16)}%${flag}`);
  }
  console.log('\nDead air is advisory, not a failure — a held diagram under continuing narration is');
  console.log('a legitimate choice. It is reported so the choice is deliberate rather than accidental.');
}

if (collisions.length === 0) {
  console.log(`\nOK: no two segments render identically (${firstSeen.size} distinct frames).`);
  process.exit(0);
}

console.error(`\nFAILED: ${collisions.length} finding(s) — at least one segment is not rendering.\n`);
for (const c of collisions) {
  if (c.reason) {
    console.error(`  "${c.b.segId}" never changed between ${ts(c.a.atMs)} and ${ts(c.b.atMs)}`);
    console.error(`  — ${c.reason}\n`);
    continue;
  }
  console.error(`  "${c.b.segId}" at ${ts(c.b.atMs)} (frame ${c.b.frame}) is byte-identical to`);
  console.error(`  "${c.a.segId}" at ${ts(c.a.atMs)} (frame ${c.a.frame})\n`);
}
const crossSegment = collisions.filter(c => !c.reason);
if (crossSegment.length) {
  console.error('Two different segments cannot legitimately produce the same pixels. The usual cause');
  console.error('is an element that never became visible: a trigger whose target resolves and animates');
  console.error('happily against a hidden ancestor reports success and renders nothing.');
  console.error(`Open ${path.basename(framesDir)}/frame_${String(crossSegment[0].b.frame).padStart(5, '0')} to see what was actually captured.`);
} else {
  console.error('A segment whose triggers all fired while nothing changed on screen has had those');
  console.error('triggers resolve against something invisible. Note that a distinct title keeps the');
  console.error('cross-segment check quiet, so a hidden BODY only shows up as this.');
}
process.exit(1);
