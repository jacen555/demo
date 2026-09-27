/*
 * Review round 6, part 2 — re-anchor triggers to the MEASURED word boundaries of the
 * narration that was just resynthesised.
 *
 * GLOBAL FIX 4 — temporal contiguity. `dimensions` and `twotier` were landing their last
 * structural reveal at 98% and 97% of their window: the diagram finished as the narration
 * ended, so every element arrived after the sentence describing it had passed. That is
 * successive presentation, which Mayer's temporal-contiguity principle warns against
 * specifically.
 *
 * The fix is NOT "show everything first" — that is the opposite error and costs working
 * memory. The rule applied here is: establish the structure briefly, then signal each
 * element in sync with the words that name it. So nodes are revealed on an establishing
 * beat, and `emphasize` with `hold` marks each one as it is spoken.
 *
 * Every time below is derived from seg.audio.words. Nothing is estimated, and a word that
 * is not in the narration throws rather than silently placing a beat at zero.
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

/** Segment-relative ms of the nth occurrence of a word. Throws rather than guessing. */
const anchor = (s) => (word, nth = 1) => {
  const want = word.toLowerCase();
  let seen = 0;
  for (const w of s.audio?.words ?? []) {
    if (w.word.toLowerCase().replace(/[^a-z0-9']/g, '') === want) {
      seen += 1;
      if (seen === nth) return w.startMs - s.startMs;
    }
  }
  throw new Error(`segment "${s.id}": narration has no "${word}" #${nth} — re-anchor this beat`);
};

const applied = [];
function setTriggers(s, triggers) {
  const span = s.endMs - s.startMs;
  const past = triggers.filter(t => t.atMs >= span);
  if (past.length) {
    throw new Error(`segment "${s.id}": ${past.length} trigger(s) past the ${span}ms window: `
      + past.map(t => `${t.target}@${t.atMs}`).join(', '));
  }
  s.triggers = triggers.sort((a, b) => a.atMs - b.atMs);
  const structural = triggers.filter(t => /reveal|drawEdge/.test(t.action));
  const last = structural.length ? Math.max(...structural.map(t => t.atMs)) : 0;
  applied.push({ id: s.id, n: triggers.length, span, lastPct: Math.round((last / span) * 100) });
}

const mark = (atMs, target) => ({ atMs, target, action: 'emphasize', payload: { hold: true, scale: 1.06 } });

// ---------------------------------------------------------------------------
// SEGMENT 2 — scenario JSON. Highlights follow the narration field by field.
// ---------------------------------------------------------------------------
{
  const s = seg('scenario');
  const at = anchor(s);
  s.visual.highlights = [
    { path: 'opening', atMs: at('opening') },
    { path: 'targetPath', atMs: at('target') },
    { path: 'facts', atMs: at('facts') },
    { path: 'facts[1]', atMs: at('notice') },
    { path: 'answerPool', atMs: at('pool') },
    { path: 'assertions', atMs: at('assertions') },
  ];
  delete s.triggers;   // autoTriggers derives code-mode beats from visual.highlights
  applied.push({ id: s.id, n: s.visual.highlights.length, span: s.endMs - s.startMs, lastPct: null });
}

// ---------------------------------------------------------------------------
// SEGMENT 5 — dimensions. Establish the three graded dimensions early, then mark each as
// it is named; the refusal example builds during the sentence that sets it up.
// ---------------------------------------------------------------------------
{
  const s = seg('dimensions');
  const at = anchor(s);
  setTriggers(s, [
    { atMs: 260, target: 'dimensions-node-d1', action: 'revealNode' },
    { atMs: 520, target: 'dimensions-node-d2', action: 'revealNode' },
    { atMs: 780, target: 'dimensions-node-d3', action: 'revealNode' },
    mark(at('category'), 'dimensions-node-d1'),
    mark(at('context'), 'dimensions-node-d2'),
    mark(at('repeat'), 'dimensions-node-d3'),
    { atMs: at('outlook'), target: 'dimensions-node-e1', action: 'revealNode' },
    { atMs: at('pizza'), target: 'dimensions-node-e2', action: 'revealNode' },
    // These edges carry no id, so the builder names them by index. revealNode does not
    // draw an edge — it has to be asked for explicitly, or the nodes appear unconnected.
    { atMs: at('pizza') + 260, target: 'dimensions-edge-0', action: 'drawEdge' },
    { atMs: at('clarify'), target: 'dimensions-node-e3', action: 'revealNode' },
    { atMs: at('clarify') + 260, target: 'dimensions-edge-1', action: 'drawEdge' },
    { atMs: at('overriding'), target: 'dimensions-node-g1', action: 'revealNode' },
    { atMs: at('hundred', 2), target: 'dimensions-node-k2', action: 'revealNode' },
    { atMs: at('handful'), target: 'dimensions-node-k1', action: 'revealNode' },
    // k3 ("~20 not applicable") is NOT named anywhere in the narration. Under G226 that is
    // an open accessibility question — narration is the only audio track, so a figure on
    // screen that is never spoken is unavailable to a listener. Pending the user's call it
    // at least must not land as a late standalone claim: it appears with the group it
    // belongs to rather than after the sentence has finished.
    { atMs: at('hundred', 2) + 350, target: 'dimensions-node-k3', action: 'revealNode' },
    { atMs: at('zero'), target: 'dimensions-node-k4', action: 'revealNode' },
  ]);
}

// ---------------------------------------------------------------------------
// SEGMENT 6 — twotier. Both lanes exist from the start (the sentence is about them
// filling against the SAME clock, so revealing one late would misstate the comparison);
// each is marked as it is described.
// ---------------------------------------------------------------------------
{
  const s = seg('twotier');
  const at = anchor(s);
  setTriggers(s, [
    { atMs: 240, target: 'twotier-node-lane_ui', action: 'revealNode' },
    { atMs: 480, target: 'twotier-node-lane_api', action: 'revealNode' },
    // An edge must not be drawn before both endpoints exist, or it animates to a point
    // nothing occupies. These two are the lane end-caps the lanes fill toward.
    { atMs: 700, target: 'twotier-node-ui_end', action: 'revealNode' },
    { atMs: 860, target: 'twotier-node-api_end', action: 'revealNode' },
    // Edge ids are AUTHORED here ("uilane"/"apilane"), so the builder emits
    // `twotier-edge-uilane`, not `-0`. Index-based targets resolve to null and animate
    // nothing, silently — the trap this project keeps rediscovering.
    { atMs: at('upper'), target: 'twotier-edge-uilane', action: 'drawEdge' },
    mark(at('upper'), 'twotier-node-lane_ui'),
    { atMs: at('lower'), target: 'twotier-edge-apilane', action: 'drawEdge' },
    mark(at('lower'), 'twotier-node-lane_api'),
    { atMs: at('fast'), target: 'twotier-node-gate', action: 'revealNode' },
  ]);
}

// ---------------------------------------------------------------------------
// SEGMENT 8 — loop. New narration, new node set.
// ---------------------------------------------------------------------------
{
  const s = seg('loop');
  const at = anchor(s);
  setTriggers(s, [
    { atMs: at('deploy'), target: 'loop-node-n1', action: 'revealNode' },
    { atMs: at('run', 1), target: 'loop-node-n2', action: 'revealNode' },
    { atMs: at('run', 1) + 300, target: 'loop-edge-0', action: 'drawEdge' },
    { atMs: at('diff'), target: 'loop-node-n3', action: 'revealNode' },
    { atMs: at('diff') + 300, target: 'loop-edge-1', action: 'drawEdge' },
    // the cycle closes while "the comparison exists before the review does" is spoken
    { atMs: at('comparison'), target: 'loop-node-n4', action: 'revealNode' },
    { atMs: at('comparison') + 260, target: 'loop-edge-2', action: 'drawEdge' },
    { atMs: at('comparison') + 520, target: 'loop-node-n5', action: 'revealNode' },
    { atMs: at('comparison') + 780, target: 'loop-edge-3', action: 'drawEdge' },
    { atMs: at('comparison') + 1040, target: 'loop-edge-4', action: 'drawEdge' },
    // the measured deltas, each as it is spoken
    { atMs: at('routing'), target: 'loop-node-m1', action: 'revealNode' },
    { atMs: at('halved'), target: 'loop-node-m2', action: 'revealNode' },
    { atMs: at('assertions'), target: 'loop-node-m3', action: 'revealNode' },
    { atMs: at('assertions') + 600, target: 'loop-node-m4', action: 'revealNode' },
    // the general regression claim replaces the prompt-injection callout
    { atMs: at('regresses'), target: 'loop-node-c1', action: 'revealNode' },
    mark(at('immediately'), 'loop-node-c1'),
    // closing triad, three separate beats
    { atMs: at('production'), target: 'loop-node-t1', action: 'revealNode' },
    { atMs: at('review', 2), target: 'loop-node-t2', action: 'revealNode' },
    { atMs: at('opened'), target: 'loop-node-t3', action: 'revealNode' },
    // the pull request is the OUTPUT of fixing — drawn last, outside the cycle
    { atMs: at('buys'), target: 'loop-node-marker', action: 'revealNode' },
    { atMs: at('buys') + 300, target: 'loop-edge-5', action: 'drawEdge' },
  ]);
}

fs.writeFileSync(timingPath, `${JSON.stringify(timing, null, 2)}\n`);

console.log('re-anchored to measured word boundaries:\n');
for (const a of applied) {
  console.log(`  ${a.id.padEnd(12)} ${String(a.n).padStart(3)} beats over ${String(a.span).padStart(6)}ms`
    + (a.lastPct === null ? '' : `  — last structural reveal at ${a.lastPct}%`));
}
