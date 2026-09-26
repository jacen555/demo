/*
 * Review round 5 — re-time segment 4 (`many`) against its narration.
 *
 * The canary reported 16.5 s motionless, 57% of the window. Investigating that found a
 * worse problem underneath: the visual ran roughly 5.5 seconds AHEAD of the narration
 * describing it. `avg` and all three edges landed at ~10.7 s, while the sentence "and an
 * average line resolves between them" is spoken at 16.2 s. The viewer saw the answer,
 * then watched a frozen frame while it was explained.
 *
 * That is an accessibility failure, not only a pacing one. Narration is the only audio
 * track (WCAG G226), so a diagram state change has to BE the transition the narration is
 * describing at that moment. Revealing early breaks the correspondence just as badly as
 * revealing late, and it is harder to notice because nothing looks broken.
 *
 * The substantive claim of the segment — "the same scenario changing grade from one run
 * to the next, for no reason at all", 18.0 s to 23.7 s — had NO visual at all. That is
 * the segment's whole point and it played over a still frame.
 *
 * Beats are anchored to spoken words rather than hardcoded offsets, so the alignment is
 * derived from the measured audio and survives a narration edit rather than silently
 * drifting from it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const timingPath = path.join(dir, 'timing.json');
const timing = JSON.parse(fs.readFileSync(timingPath, 'utf8'));

const seg = timing.segments.find(s => s.id === 'many');
if (!seg) throw new Error('segment "many" not found');

const words = seg.audio?.words ?? [];
if (words.length === 0) throw new Error('segment "many" has no measured word boundaries — run S3 first');

/** Segment-relative ms of the nth occurrence of `word`. Throws rather than guessing. */
function at(word, nth = 1) {
  const want = word.toLowerCase();
  let seen = 0;
  for (const w of words) {
    if (w.word.toLowerCase().replace(/[^a-z']/g, '') === want) {
      seen += 1;
      if (seen === nth) return w.startMs - seg.startMs;
    }
  }
  throw new Error(`segment "many": narration does not contain "${word}" #${nth} — re-anchor this beat`);
}

const span = seg.endMs - seg.startMs;

const triggers = [
  // "…opens its own conversation and shares no state with any other, so they can go out
  // in parallel."
  { atMs: 409, target: 'many-node-suite', action: 'revealNode' },
  // "in parallel" — the claim the node is making, and it keeps the opening sentence from
  // playing over 7.7 s of a single static box.
  { atMs: at('parallel'), target: 'many-node-suite', action: 'emphasize' },

  // "And we run every scenario three times…" — the three runs appear as they are claimed.
  { atMs: at('three', 1) + 120, target: 'many-node-r1', action: 'revealNode' },
  { atMs: at('three', 1) + 900, target: 'many-node-r2', action: 'revealNode' },
  { atMs: at('three', 1) + 1680, target: 'many-node-r3', action: 'revealNode' },

  // "…land on three different outputs" — the DIVERGENCE is the point of the sentence, so
  // draw the eye to the one that differs rather than re-revealing all three.
  { atMs: at('different'), target: 'many-node-r3', action: 'emphasize' },

  // "and an average line resolves between them" — edges need an explicit drawEdge;
  // revealNode does not draw them.
  { atMs: at('average', 1), target: 'many-node-avg', action: 'revealNode' },
  { atMs: at('line'), target: 'many-edge-0', action: 'drawEdge' },
  { atMs: at('line') + 320, target: 'many-edge-1', action: 'drawEdge' },
  { atMs: at('line') + 640, target: 'many-edge-2', action: 'drawEdge' },

  // "Replication … showed the same scenario changing grade from one run to the next, for
  // no reason at all." The segment's substantive finding, previously silent on screen.
  // Walk run 1 -> run 3 so the viewer sees the same scenario landing differently.
  { atMs: at('changing'), target: 'many-node-r1', action: 'emphasize' },
  { atMs: at('next'), target: 'many-node-r3', action: 'emphasize' },

  // "So we average across three runs…"
  { atMs: at('average', 2), target: 'many-node-avg', action: 'emphasize' },

  // "…and a real change is separated from the model's own noise."
  { atMs: at('separated'), target: 'many-node-avg', action: 'emphasize' },
];

// A trigger past the measured end never fires, and reports nothing when it doesn't.
const past = triggers.filter(t => t.atMs >= span);
if (past.length) {
  throw new Error(`re-timing put ${past.length} trigger(s) past the ${span}ms window: ` +
    past.map(t => `${t.target}@${t.atMs}`).join(', '));
}

seg.triggers = triggers.sort((a, b) => a.atMs - b.atMs);

fs.writeFileSync(timingPath, `${JSON.stringify(timing, null, 2)}\n`);

console.log(`segment "many" re-timed: ${triggers.length} triggers across ${span}ms`);
let prev = 0;
for (const t of seg.triggers) {
  console.log(`  ${String(t.atMs).padStart(6)} ms  ${t.action.padEnd(11)} ${t.target}`);
  prev = t.atMs;
}
console.log(`  longest silent stretch now ~${((span - prev) / 1000).toFixed(1)}s at the tail`);
