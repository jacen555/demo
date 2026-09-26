// Blank-segment canary. Samples one frame at each segment's midpoint and compares hashes.
// A repeated hash across segments that render different content means a segment is blank
// or frozen - the failure that produced four byte-identical preview frames on `code` mode,
// and which reports no error because every trigger resolves and animates happily against
// an invisible element.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const timing = JSON.parse(fs.readFileSync('timing.json', 'utf8'));
const fps = 30;
const seen = new Map();
let dupes = 0;

console.log('segment        midMs   frame  hash');
for (const s of timing.segments) {
  const mid = Math.round((s.startMs + s.endMs) / 2);
  const n = Math.max(1, Math.round((mid / 1000) * fps));
  const f = path.join('frames', `frame_${String(n).padStart(5, '0')}.jpg`);
  if (!fs.existsSync(f)) { console.log(`${s.id.padEnd(13)} ${String(mid).padStart(7)} ${String(n).padStart(6)}  MISSING`); continue; }
  const h = crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex').slice(0, 12);
  const dupe = seen.has(h);
  if (dupe) dupes += 1; else seen.set(h, s.id);
  console.log(`${s.id.padEnd(13)} ${String(mid).padStart(7)} ${String(n).padStart(6)}  ${h}${dupe ? `  <-- IDENTICAL to ${seen.get(h)}` : ''}`);
}

console.log(dupes === 0
  ? `\nOK: ${timing.segments.length} segments, ${seen.size} distinct frames - no blank or frozen segment`
  : `\nFAIL: ${dupes} segment(s) render identically to another - investigate before shipping`);
process.exitCode = dupes === 0 ? 0 : 1;
