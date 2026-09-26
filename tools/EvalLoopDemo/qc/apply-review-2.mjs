/**
 * Review round 2 — applies the user's video-review feedback to timing.json.
 *
 * Visual-only changes leave the measured audio untouched. NARRATION changes force S3
 * re-synthesis, and those segments are marked below so the length can be re-checked
 * against the 5:00 ceiling afterwards.
 *
 * Run from the project dir:  node qc/apply-review-2.mjs
 */
import fs from 'node:fs';

const t = JSON.parse(fs.readFileSync('timing.json', 'utf8'));
const by = Object.fromEntries(t.segments.map(s => [s.id, s]));
const node = (id, label, x, y, w, h) => ({ id, label, x, y, w, h });
const narrationChanged = [];

// ---- 1 · hard — SECOND report: bubbles still too close, arrowheads too big ----------
// Previous pass widened gaps from ~20px to ~50px; still reported as cramped. The unit-test
// column is the specific complaint, so it goes to ~96px gaps — nearly double again — and
// the whole diagram drops arrowSize from 10 to 6 so the heads stop dominating short edges.
by.hard.visual.arrowSize = 6;
by.hard.visual.nodes = [
  node('u1', 'one input', 40, 26, 250, 74),
  node('u2', 'one assert', 40, 196, 250, 74),
  node('u3', 'the same answer every time', 40, 366, 250, 74),
  node('c0', 'the opening turn', 420, 26, 230, 74),
  node('c1a', 'turn 2', 760, 120, 200, 74),
  node('c1b', 'turn 2', 760, 248, 200, 74),
  node('c2a', 'turn 3', 1090, 40, 230, 74),
  node('c2b', 'turn 3', 1090, 168, 230, 74),
  node('c2c', 'turn 3', 1090, 296, 230, 74),
  node('s1', 'one case at a time', 420, 424, 320, 74),
  node('s2', 'Postman, or by hand', 850, 424, 320, 74),
];
by.hard.visual.note = by.hard.visual.note.replace(
  /RE-LAID OUT:.*$/,
  'RE-LAID OUT TWICE: the unit-test column now sits at ~96px vertical gaps (was ~50, originally ~20) ' +
  'and arrowSize drops to 6, because the heads were visually dominating the short edges between ' +
  'tightly-stacked boxes. Verify against a rendered frame at 1:1 — the storyboard letterboxes differently.');

// ---- 2 · many — progress bar out, runs earlier and higher, grade -> output ----------
// NARRATION CHANGE.
narrationChanged.push('many');
by.many.voiceoverText = by.many.voiceoverText
  .replace('three result strips for one scenario land on three different grades',
           'three result strips for one scenario land on three different outputs');

by.many.visual.nodes = [
  node('suite', '162 scenarios \u00b7 running in parallel', 480, 30, 640, 84),
  node('r1', 'run 1 \u00b7 output A', 140, 170, 340, 84),
  node('r2', 'run 2 \u00b7 output A', 630, 170, 340, 84),
  node('r3', 'run 3 \u00b7 output B', 1120, 170, 340, 84),
  node('avg', 'averaged across three runs', 480, 380, 640, 84),
];
// Drop the progress triggers entirely; bring the run strips forward so they land with the
// narration's second sentence rather than trailing it.
by.many.triggers = by.many.triggers.filter(tr => tr.action !== 'progress');
const manyAt = { 'many-node-r1': 6200, 'many-node-r2': 7000, 'many-node-r3': 7800, 'many-node-avg': 10200 };
for (const tr of by.many.triggers) if (manyAt[tr.target] !== undefined && tr.action === 'revealNode') tr.atMs = manyAt[tr.target];
by.many.visual.note =
  '**Three run strips for ONE scenario reveal early**, landing with the narration\'s second sentence, ' +
  'labelled output A / output A / output B so the divergence is carried by a letter rather than a colour. ' +
  'An average node resolves beneath them. The progress bar was removed at review — it was not earning ' +
  'its place. Run bubbles sit high to give the edges room.';

// ---- 3 · freeform — drop the spotlight, shorten the guard line ----------------------
// NARRATION CHANGE.
narrationChanged.push('freeform');
by.freeform.triggers = by.freeform.triggers.filter(tr => tr.action !== 'spotlight');
by.freeform.voiceoverText = by.freeform.voiceoverText.replace(
  'Those phrasings are harvested from real support data, so an iPhone case can inherit a Windows sentence, ' +
  'and handing the interview a contradiction would grade our own test data instead of the product. ',
  'Those phrasings come from real support data. ');
by.freeform.visual.nodes.find(n => n.id === 'g2').label = 'phrasings come from real support data';
by.freeform.visual.note = by.freeform.visual.note.replace(
  'The free-text rung highlights and holds — it is the one the segment is really about, and the only rung that reaches into the knowledge bank.',
  'The free-text rung is the one the segment is really about. The screen-dimming spotlight was removed at review.');

// ---- 4 · dimensions — "stops and asks" -> "clarifies scope" -------------------------
// NARRATION CHANGE. Count rounding is still with the user — untouched.
narrationChanged.push('dimensions');
by.dimensions.voiceoverText = by.dimensions.voiceoverText.replace(
  'The interview must notice and stop.', 'The interview must notice and clarify scope.');
by.dimensions.visual.nodes.find(n => n.id === 'e3').label = 'interview: clarifies scope';

// ---- retime provisionally; voice.mjs reflows onto measured audio --------------------
const WPS = 3.535;
const words = s => s.trim().split(/\s+/).length;
let cursor = t.intake.leadInMs;
for (const s of t.segments) {
  if (narrationChanged.includes(s.id)) {
    s.plannedDurationMs = Math.round((words(s.voiceoverText) / WPS) * 1000);
    delete s.audio;                       // force re-synthesis
  }
  const ms = s.audio?.durationMs ?? s.plannedDurationMs;
  s.startMs = cursor;
  s.endMs = cursor + ms;
  cursor = s.endMs + t.intake.perceivedGapMs;
}
t.durationMs = t.segments.at(-1).endMs;
t.intake.perSegmentToleranceMs = 15000;   // changed segments have estimate windows again
delete t.timingHash;

for (const s of t.segments) {
  const dur = s.endMs - s.startMs;
  for (const tr of s.triggers ?? []) tr.atMs = Math.min(tr.atMs, Math.max(0, dur - 600));
  (s.triggers ?? []).sort((a, b) => a.atMs - b.atMs);
}

fs.writeFileSync('timing.json', JSON.stringify(t, null, 2));
const total = t.segments.reduce((n, s) => n + words(s.voiceoverText), 0);
const mm = ms => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
console.log(`narration changed: ${narrationChanged.join(', ')} -> S3 re-synthesis required`);
console.log(`${t.segments.length} segments · ${total} words · projected ${mm(t.durationMs)}`);
