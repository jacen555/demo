/**
 * One-off migration: apply storyboard-edit.md back into timing.json.
 *
 * Kept as a file (not an inline -e) because it is a reviewable record of exactly what was
 * applied from the authored storyboard, and because it is idempotent — it rebuilds the
 * segment list from scratch rather than patching in place.
 *
 * Run from the project dir:  node qc/apply-storyboard.mjs
 */
import fs from 'node:fs';

const t = JSON.parse(fs.readFileSync('timing.json', 'utf8'));
const by = Object.fromEntries(t.segments.map(s => [s.id, s]));

const words = s => s.trim().split(/\s+/).length;
const WPS = 3.492;
const node = (id, label, x, y, w, h) => ({ id, label, x, y, w, h });
const trig = (id, atMs, semanticClass, target, action, payload) =>
  payload ? { id, atMs, semanticClass, target, action, payload } : { id, atMs, semanticClass, target, action };

// ---- 1 · hard — narration edited; diagram re-laid out --------------------------------
// The user reported clipped arrowheads and compressed animation. Cause: stacked nodes sat
// ~20 px apart and the tree's last column ran close to the right edge, so arrow markers had
// no room to draw. Gaps widened to ~50 px vertical / ~110-140 px horizontal.
by.hard.voiceoverText =
  'A unit test is easy. One input, one answer; and the same answer every time. Now try testing a conversation. ' +
  'On the right of the screen, the interview branches for each turn. When you run it again, a different branch occurs. ' +
  'There is no single assert to check. So how did we check it? One case at a time. ' +
  'Type an opening into Postman, read the reply, type the next. ' +
  'Or deploy it all the way to PPE and test the larger interface by hand. ' +
  'It was so slow that customers were finding the regressions before we did.';
by.hard.visual.nodes = [
  node('u1', 'one input', 50, 40, 250, 74),
  node('u2', 'one assert', 50, 165, 250, 74),
  node('u3', 'the same answer every time', 50, 290, 250, 74),
  node('c0', 'the opening turn', 400, 30, 230, 74),
  node('c1a', 'turn 2', 740, 120, 200, 74),
  node('c1b', 'turn 2', 740, 240, 200, 74),
  node('c2a', 'turn 3', 1080, 40, 230, 74),
  node('c2b', 'turn 3', 1080, 160, 230, 74),
  node('c2c', 'turn 3', 1080, 280, 230, 74),
  node('s1', 'one case at a time', 400, 408, 320, 80),
  node('s2', 'Postman, or by hand', 830, 408, 320, 80),
];
by.hard.visual.note =
  '**Animated split diagram.** Left column, a three-node unit test revealed and settled instantly. ' +
  'Right, the interview tree branches from the opening turn; the active path pulses once, then pulses again ' +
  'down a DIFFERENT branch to show the same input taking a different route. Below, a two-node loop cycles ' +
  'slowly with low-density particles. No numbers on screen. ' +
  'RE-LAID OUT: node gaps widened to ~50 px vertical and ~110-140 px horizontal because arrowheads were being ' +
  'clipped between tightly-stacked boxes and the tree crowded the right edge.';

// ---- 2 · scenario — expanded, re-pointed at outlook-ios-not-receiving ------------------
by.scenario.voiceoverText =
  "Let's look at one specific scenario definition. The opening is what the conversation starts with: " +
  'my email has just stopped working. That is deliberately vague, because that is how people actually write. ' +
  'Underneath it sits the target: Outlook, on iOS, not receiving email. The interview never sees that, ' +
  'we are using it to grade once the conversation ends. Then we have the knowledge bank. ' +
  'Three authored facts this customer knows and will say if asked: that they are using the mail app on an iPhone; ' +
  'that they can still send messages, but nothing new ever arrives; and that they have checked junk, ' +
  'and the mailbox is not full. Notice the second one. Can send, cannot receive — that is the detail separating ' +
  'this from a dozen neighbouring categories, and the interview only learns it if it thinks to ask. ' +
  'Then a pool of alternative phrasings, so the customer can choose different phrasings to not repeat every time. ' +
  'And last, the assertions this scenario has to satisfy. That is what makes it a conversation and not a prompt. ' +
  'We have defined nearly two-hundred of them.';
by.scenario.visual.subtitle = 'Real object from scenarios.json — id: outlook-ios-not-receiving';
by.scenario.visual.items = [
  { label: 'opening', value: '', text: '"My email has just stopped working."' },
  { label: 'target  \ud83d\udd12 locked', value: '', text: 'Outlook \u00b7 iOS \u00b7 Not receiving email — never shown to the system under test' },
  { label: 'fact 1', value: '', text: 'I am using the mail app on my iPhone.' },
  { label: 'fact 2', value: '', text: 'I can still send messages, nothing new ever arrives.' },
  { label: 'fact 3', value: '', text: 'I checked junk and the mailbox is not full.' },
  { label: 'phrasings + assertions', value: '', text: 'alternative wordings, and what this scenario must satisfy' },
];
by.scenario.visual.note =
  '**Field-by-field reveal of one real scenario object**, in the order the narration names the fields. ' +
  'As each field is named the previously-revealed fields dim and the named one highlights, so the eye is on ' +
  'the field being spoken about. The lock is a padlock glyph AND the word "locked" — never colour alone. ' +
  'The beat lands on fact 2: at "notice the second one" it highlights on its own. Every value on screen is spoken.';

// ---- 3 · freeform — NEW segment -------------------------------------------------------
const freeform = {
  id: 'freeform',
  title: 'It writes its own questions. The customer has to cope.',
  startMs: 0,
  endMs: 0,
  plannedDurationMs: 0,
  voiceoverText:
    'But here is the hard part: the thing being tested is a language model. It writes its own questions, ' +
    'and it will ask things nobody anticipated. A script of canned answers can fall apart on the first ' +
    'unexpected turn. So the simulated customer answers by rule, in priority order. ' +
    'If the question offers choices, and those choices carry routing data, it picks the one whose route ' +
    'runs closest to its own target. If the choices are platforms, it answers with the platform it is actually on. ' +
    'If it is any other multiple choice, it scores each option against its own vocabulary. ' +
    'And if the question has no choices at all — free text, invented on the spot — it draws the next unused line ' +
    'from its knowledge bank. One guard matters more than the rest. The customer will never name a platform it is not on. ' +
    'Those phrasings are harvested from real support data, so an iPhone case can inherit a Windows sentence, ' +
    'and handing the interview a contradiction would grade our own test data instead of the product. ' +
    'Matching is on word boundaries — which is why Xbox Game Studios is not an iOS case.',
  visual: {
    mode: 'diagram',
    kicker: 'The hard part',
    title: 'The interview invents the questions. The customer still has to answer.',
    subtitle: 'A priority ladder, not a script.',
    note:
      '**A priority ladder builds top to bottom**, one rung per rule as the narration names it. The free-text rung ' +
      'highlights and holds — it is the one the segment is really about, and the only rung that reaches into the ' +
      'knowledge bank. Then the guard lands underneath as three stacked panels, with the Xbox Game Studios example ' +
      'legible as text — the joke only works if it can be read.',
    viewBox: '0 0 1600 520',
    nodes: [
      node('q', 'the interview asks — often something nobody anticipated', 320, 14, 960, 52),
      node('r1', 'choices carry routing \u2192 pick the route closest to my target', 120, 82, 1360, 50),
      node('r2', 'choices are platforms \u2192 answer with the platform I am on', 120, 142, 1360, 50),
      node('r3', 'any other multiple choice \u2192 score options against my vocabulary', 120, 202, 1360, 50),
      node('r4', 'no choices at all \u2192 next unused line from my knowledge bank', 120, 262, 1360, 50),
      node('g1', 'GUARD \u00b7 never name a platform I am not on', 120, 336, 1360, 50),
      node('g2', 'phrasings come from real support data — an iPhone case can inherit a Windows sentence', 120, 396, 1360, 50),
      node('g3', 'matched on word boundaries — Xbox Game Stud\u200bios is not an iOS case', 120, 456, 1360, 50),
    ],
    edges: [
      { from: 'q', to: 'r1', id: 'qr1' },
      { from: 'r1', to: 'r2', id: 'r1r2' },
      { from: 'r2', to: 'r3', id: 'r2r3' },
      { from: 'r3', to: 'r4', id: 'r3r4' },
    ],
  },
  triggers: [],
  claims: [
    { claimId: 'c-strategies', type: 'direct', provenanceIds: ['interview-eval/README.md:What it does — strategy table (route, family, platform, leafRoute, overlap, freeText)'] },
    { claimId: 'c-platformguard', type: 'direct', provenanceIds: ['interview-eval/README.md:If you regenerate the suite — match on word boundaries, Xbox Game Studios is not an iOS case', 'contextlayer-eval/README.md:The scripted customer — one guard carries over verbatim'] },
  ],
};

// ---- 4-8 · narration edits ------------------------------------------------------------
// "we run every scenario runs three times" in the authored copy is a transcription slip
// (double verb). Corrected to "we run every scenario three times" — this is a typo fix,
// not an edit of intent, and it is reported.
by.many.voiceoverText =
  'Each of the hundreds of scenarios opens its own conversation and shares no state with any other, ' +
  'so they can go out in parallel. And we run every scenario three times, because the same input ' +
  "doesn't give the same answer twice. On screen, three result strips for one scenario land on three " +
  'different grades, and an average line resolves between them. Replication across this suite showed ' +
  'the same scenario changing grade from one run to the next, for no reason at all. So we average across ' +
  "three runs, and a real change is separated from the model's own noise.";

by.twotier.voiceoverText =
  'Two harnesses, and the lanes on screen fill against the same clock. The upper lane, labelled U I, ' +
  'clears thirteen scenarios in three runs each — about three and a half minutes. The lower lane, labelled A P I, ' +
  'clears all hundred and sixty-two in less time than that. So the fast tier is the pull-request gate; ' +
  'the interface harness cannot target a pull-request build at all.';
by.twotier.visual.nodes.find(n => n.id === 'lane_ui').label = 'U I \u00b7 13 scenarios \u00d7 3 runs \u00b7 ~3.5 min';

by.blindspot.voiceoverText =
  'But the slow tier sees something the fast one is structurally blind to. Watch it drive the real U I, ' +
  'and a stage trace surfaces: running Outlook Q and A agent, agent completed, workflow failed. ' +
  'The interview got the category right, the right agent was picked, and resolution failed anyway. ' +
  'The customer got a canned refusal. The fast tier stops at the category and cannot say any of that. ' +
  'Different data, not just slower data.';

// ---- rebuild the segment list ---------------------------------------------------------
const order = ['hard', 'scenario', 'freeform', 'many', 'dimensions', 'twotier', 'blindspot', 'loop'];
const segs = order.map(id => (id === 'freeform' ? freeform : by[id]));

// ---- retime: provisional windows at the measured rate; voice.mjs reflows onto real audio
const LEAD = t.intake.leadInMs, GAP = t.intake.perceivedGapMs;
let cursor = LEAD;
for (const s of segs) {
  const ms = Math.round((words(s.voiceoverText) / WPS) * 1000);
  s.plannedDurationMs = ms;
  s.startMs = cursor;
  s.endMs = cursor + ms;
  cursor = s.endMs + GAP;
}

// ---- triggers for the new / restructured segments -------------------------------------
// Anchored to word position in the narration, converted at the measured rate. voice.mjs
// does NOT reflow trigger times (reported engine gap), so these are re-scaled after S3 by
// the same measured/planned factor the earlier cut used.
const at = w => Math.max(0, Math.round((w / WPS) * 1000));

by.scenario.triggers = [
  trig('scenario-t0', at(8), 'quote', 'scenario-item-0', 'rise'),
  trig('scenario-t1', at(33), 'card', 'scenario-item-1', 'rise'),
  trig('scenario-t2', at(36), 'card', 'scenario-item-1', 'emphasize'),
  trig('scenario-t3', at(76), 'card', 'scenario-item-2', 'rise'),
  trig('scenario-t4', at(86), 'card', 'scenario-item-3', 'rise'),
  trig('scenario-t5', at(97), 'card', 'scenario-item-4', 'rise'),
  // "Notice the second one." — fact 2 highlights ALONE. spotlight dims everything else.
  trig('scenario-t6', at(109), 'card', 'scenario-item-3', 'spotlight'),
  trig('scenario-t7', at(137), 'body', 'scenario-item-3', 'spotlight', { release: true }),
  trig('scenario-t8', at(139), 'card', 'scenario-item-5', 'rise'),
];

freeform.triggers = [
  trig('freeform-t0', at(1), 'heading', 'freeform-node-q', 'revealNode'),
  trig('freeform-t1', at(50), 'list', 'freeform-node-r1', 'revealNode'),
  trig('freeform-e0', at(51), 'chart', 'freeform-edge-qr1', 'drawEdge'),
  trig('freeform-t2', at(73), 'list', 'freeform-node-r2', 'revealNode'),
  trig('freeform-e1', at(74), 'chart', 'freeform-edge-r1r2', 'drawEdge'),
  trig('freeform-t3', at(87), 'list', 'freeform-node-r3', 'revealNode'),
  trig('freeform-e2', at(88), 'chart', 'freeform-edge-r2r3', 'drawEdge'),
  trig('freeform-t4', at(102), 'list', 'freeform-node-r4', 'revealNode'),
  trig('freeform-e3', at(103), 'chart', 'freeform-edge-r3r4', 'drawEdge'),
  // The free-text rung is what the segment is really about — hold it.
  trig('freeform-t5', at(115), 'body', 'freeform-node-r4', 'spotlight'),
  trig('freeform-t6', at(131), 'body', 'freeform-node-r4', 'spotlight', { release: true }),
  trig('freeform-t7', at(135), 'card', 'freeform-node-g1', 'revealNode'),
  trig('freeform-t8', at(146), 'card', 'freeform-node-g2', 'revealNode'),
  trig('freeform-t9', at(179), 'code', 'freeform-node-g3', 'revealNode'),
  trig('freeform-t10', at(188), 'body', 'freeform-node-g3', 'emphasize'),
];

// Clamp every trigger inside its (provisional) window, and keep them ordered.
for (const s of segs) {
  const dur = s.endMs - s.startMs;
  for (const tr of s.triggers ?? []) tr.atMs = Math.min(tr.atMs, Math.max(0, dur - 600));
  (s.triggers ?? []).sort((a, b) => a.atMs - b.atMs);
}

t.segments = segs;
t.durationMs = segs.at(-1).endMs;
delete t.timingHash;

fs.writeFileSync('timing.json', JSON.stringify(t, null, 2));

const total = segs.reduce((n, s) => n + words(s.voiceoverText), 0);
const mm = ms => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
console.log(`${segs.length} segments · ${total} words · projected ${mm(t.durationMs)} at ${WPS} wps`);
for (const s of segs) console.log(`  ${s.id.padEnd(11)} ${String(words(s.voiceoverText)).padStart(4)}w  ${(s.plannedDurationMs / 1000).toFixed(1)}s`);
