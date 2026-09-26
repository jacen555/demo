/*
 * Review round 6 — four global fixes plus two segment rebuilds.
 *
 * The important instruction was structural: these were reported per-segment but they are
 * DEFAULTS, so patching the reported segments would have left the next one wrong. Two of
 * the four are fixed in the engine (arrowhead size, the sustained-emphasis action) and
 * apply everywhere at once; the two below are layout and content, which are genuinely
 * per-project.
 *
 * Trigger RE-TIMING is deliberately not done here. Segments 2 and 8 change narration, so
 * their measured word boundaries do not exist yet. Anchoring beats to words that are about
 * to be resynthesised would bake in the drift this round exists to remove — re-anchor after
 * S3, not before.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const timingPath = path.join(dir, 'timing.json');
const timing = JSON.parse(fs.readFileSync(timingPath, 'utf8'));
const seg = id => {
  const s = timing.segments.find(x => x.id === id);
  if (!s) throw new Error(`segment "${id}" not found`);
  return s;
};

// ---------------------------------------------------------------------------
// GLOBAL FIX 1 — no full-screen darkening, but keep the signalling.
//
// Mayer's signalling principle is doing real work here: the viewer needs to know which
// element the narration is on. The defect was the IMPLEMENTATION — dimming the whole
// frame reads as a glitch. `emphasize` with `hold` marks the target locally (thicker
// stroke + halo + slight scale) and leaves the rest of the frame alone.
// ---------------------------------------------------------------------------
let despotlit = 0;
for (const s of timing.segments) {
  for (const t of s.triggers || []) {
    if (t.action === 'spotlight' || t.action === 'zoomFocus') {
      t.action = 'emphasize';
      t.payload = { ...(t.payload || {}), hold: true, scale: 1.06 };
      delete t.payload.release;
      despotlit += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// SEGMENT 2 — two additions to the scenario JSON.
// `description` goes at the BOTTOM and keeps only its first sentence: the full field is
// ~50 words of taxonomy prose that would dominate the frame and push the rest off it.
// ---------------------------------------------------------------------------
const s2 = seg('scenario');
const j = s2.visual.json;
j.facts = [
  'I am using the mail app on my iPhone.',
  'I can still send messages, nothing new ever arrives.',
  'I checked junk and the mailbox is not full.',
  'I still have space left in my inbox.',
];
// Rebuild so `description` lands last regardless of original key order.
const { assertions, ...rest } = j;
s2.visual.json = {
  ...rest,
  assertions,
  description:
    'This node addresses issues where users of Outlook for iOS are unable to receive any '
    + 'incoming emails, despite verifying common causes like spam filters, inbox capacity, '
    + 'or account settings.',
};

// ---------------------------------------------------------------------------
// SEGMENT 8 — narration, and a layout that stops the loop overlapping itself.
//
// The user has now seen it rendered and wants the prompt-injection callout replaced by a
// general regression claim. That drops a node and a claim, which is also what frees the
// vertical room the layout needed.
//
// `open the pull request` moves OUTSIDE the cycle, far right, fed from `fix` — it is the
// OUTPUT of fixing, not a step within the loop. The old placement sat inside the cycle and
// read as another stage.
// ---------------------------------------------------------------------------
const s8 = seg('loop');
s8.voiceoverText =
  'We deploy the pull-request branch, point the harness at it, and run it three times. '
  + 'Then the same suite against main, and we diff the two. The comparison exists before '
  + 'the review does. On one real change, routing got clearly better. Cases reaching the '
  + 'right support area went from twenty-seven to thirty-five out of sixty-seven. Cases '
  + 'where the interview came back with nothing were almost halved. Twenty-six fewer '
  + 'failed assertions. And when something regresses, we see it immediately — in the same '
  + 'report, on the same run, while the change is still a branch. Not in production. Not '
  + 'in review. Before the pull request was ever opened. That is what this buys. Run it '
  + 'against your branch first.';

s8.visual.nodes = [
  // the cycle, left two-thirds
  { id: 'n1', label: 'deploy the branch', x: 36, y: 14, w: 250, h: 76 },
  { id: 'n2', label: 'run the suite × 3', x: 326, y: 14, w: 250, h: 76 },
  { id: 'n3', label: 'read the delta', x: 616, y: 14, w: 250, h: 76 },
  { id: 'n4', label: 'fix', x: 906, y: 14, w: 170, h: 76 },
  { id: 'n5', label: 're-run', x: 906, y: 124, w: 170, h: 70 },
  // outside the cycle, fed from `fix`
  { id: 'marker', label: 'open the pull request', x: 1200, y: 14, w: 364, h: 76 },
  // measured deltas, left column
  { id: 'm1', label: 'right support area   27 → 35  of 67', x: 36, y: 240, w: 690, h: 56 },
  { id: 'm2', label: 'came back with nothing — almost halved', x: 36, y: 306, w: 690, h: 56 },
  { id: 'm3', label: 'assertions failed   − 26', x: 36, y: 372, w: 690, h: 56 },
  { id: 'm4', label: '3 runs per arm', x: 36, y: 438, w: 690, h: 56 },
  // the claim and the closing triad, right column
  { id: 'c1', label: 'REGRESSIONS SURFACE ON THE SAME RUN', x: 790, y: 240, w: 774, h: 60 },
  { id: 't1', label: 'Not in production.', x: 790, y: 330, w: 774, h: 50 },
  { id: 't2', label: 'Not in review.', x: 790, y: 390, w: 774, h: 50 },
  { id: 't3', label: 'Before the pull request was ever opened.', x: 790, y: 450, w: 774, h: 50 },
];
s8.visual.edges = [
  { from: 'n1', to: 'n2' },
  { from: 'n2', to: 'n3' },
  { from: 'n3', to: 'n4' },
  { from: 'n4', to: 'n5' },
  { from: 'n5', to: 'n2' },
  { from: 'n4', to: 'marker' },
];
// The caveat is no longer spoken, so the claim that sourced it must go with it — a claim
// register that outlives its narration is how an unsupported figure survives a rewrite.
s8.claims = (s8.claims || []).filter(c => (c.claimId ?? c.id) !== 'c-caveat');
// Stale: every trigger here addressed the old node set and the old narration.
delete s8.triggers;
delete s2.triggers;

fs.writeFileSync(timingPath, `${JSON.stringify(timing, null, 2)}\n`);

console.log(`spotlight/zoomFocus -> emphasize+hold: ${despotlit} trigger(s)`);
console.log(`segment "scenario": facts now ${j.facts.length}, description appended last`);
console.log(`segment "loop": ${s8.visual.nodes.length} nodes (was 15), ${s8.visual.edges.length} edges`);
console.log('  marker moved outside the cycle, fed from n4 (fix)');
console.log(`  narration now ${s8.voiceoverText.trim().split(/\s+/).length} words`);
console.log('triggers cleared on scenario + loop — re-anchor after S3');
