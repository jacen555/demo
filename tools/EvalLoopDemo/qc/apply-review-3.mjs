/**
 * Review round 3 — segment 8 reframed as a win, segment 5 counts rounded.
 *
 * Both change narration, so S3 re-synthesis follows. Also restores the 4K render target,
 * which the draft pass had temporarily dropped to render.preview dimensions.
 *
 * Run from the project dir:  node qc/apply-review-3.mjs
 */
import fs from 'node:fs';

const t = JSON.parse(fs.readFileSync('timing.json', 'utf8'));
const by = Object.fromEntries(t.segments.map(s => [s.id, s]));
const node = (id, label, x, y, w, h) => ({ id, label, x, y, w, h });
const trig = (id, atMs, semanticClass, target, action, payload) =>
  payload ? { id, atMs, semanticClass, target, action, payload } : { id, atMs, semanticClass, target, action };

// ---- 8 · loop — the catch IS the win --------------------------------------------------
// The old framing treated the prompt-injection probe as a caveat appended to a metrics
// recap. It is the opposite: a build that improved every headline number was also less
// safe, and the harness caught it before the pull request existed. That is the thesis.
const loop = by.loop;
loop.title = 'The comparison exists before the pull request does';
loop.voiceoverText =
  'We deploy the pull-request branch, point the harness at it, and run it three times. ' +
  'Then the same suite against main, and we diff the two. The comparison exists before the review does. ' +
  'On one real change, routing got clearly better. Cases reaching the right support area went from ' +
  'twenty-seven to thirty-five out of sixty-seven. Cases where the interview came back with nothing were ' +
  'almost halved. Twenty-six fewer failed assertions. And then the harness flagged something the totals ' +
  'would have buried. A prompt-injection probe — one that exists to be refused — had quietly started ' +
  'getting answered. Every headline number said this build was better. It was also less safe, and one ' +
  'line caught it. Not in production. Not in review. Before the pull request was ever opened. ' +
  'That is what this buys. Run it against your branch first.';
loop.visual.title = 'The comparison exists before the pull request does';
loop.visual.subtitle = 'Every headline number said better. One line said less safe.';

loop.visual.nodes = [
  node('n1', 'deploy the branch', 60, 20, 270, 74),
  node('n2', 'run the suite \u00d7 3', 390, 20, 270, 74),
  node('n3', 'read the delta', 720, 20, 270, 74),
  node('n4', 'fix', 1050, 20, 200, 74),
  node('n5', 're-run', 1050, 112, 200, 74),
  node('marker', '\u2192 open the pull request', 700, 112, 290, 74),
  node('m1', 'right support area   27.0 \u2192 35.0  of 67', 60, 215, 620, 52),
  // Narration now says "almost halved" rather than the two means, so the label matches
  // what is spoken (G226) — the exact figures stay in script.md claims and render-log.
  node('m2', 'came back with nothing \u2014 almost halved', 60, 272, 620, 52),
  node('m3', 'assertions failed   \u2212 26.0', 60, 329, 620, 52),
  node('m4', '3 runs per arm', 60, 386, 620, 52),
  node('c1', 'CAUGHT BEFORE THE PULL REQUEST', 760, 215, 780, 56),
  node('c2', 'prompt-injection probe (must be refused)   3 of 3  \u2192  1 of 3', 760, 278, 780, 74),
  // The closing triad lands one beat at a time with the narration — the rhythm IS the
  // punch, so it must not play over a static frame.
  node('t1', 'Not in production.', 760, 366, 780, 44),
  node('t2', 'Not in review.', 760, 417, 780, 44),
  node('t3', 'Before the pull request was ever opened.', 760, 468, 780, 44),
];
loop.visual.note =
  '**The loop builds first** — deploy, run x3, read the delta, fix, re-run — and completes one revolution, ' +
  "with the 'open the pull request' marker attaching on the way OUT. Then three metric rows animate up. " +
  'Beat. Then the flagged panel slides in, retitled CAUGHT BEFORE THE PULL REQUEST because the probe ' +
  'getting through is the harness succeeding, not the product failing. Finally the closing triad lands ' +
  'ONE BEAT AT A TIME with the narration — not in production, not in review, before the pull request was ' +
  'ever opened. NO END CARD. These rows are rendered natively, never cropped from the source report, ' +
  'which carries a deployment endpoint and pull-request ids in its own markup.';

const W = 3.535;
const at = w => Math.max(0, Math.round((w / W) * 1000));
loop.triggers = [
  trig('loop-t0', at(1), 'card', 'loop-node-n1', 'revealNode'),
  trig('loop-t1', at(9), 'card', 'loop-node-n2', 'revealNode'),
  trig('loop-e0', at(10), 'chart', 'loop-edge-0', 'drawEdge'),
  trig('loop-t2', at(17), 'card', 'loop-node-n3', 'revealNode'),
  trig('loop-e1', at(18), 'chart', 'loop-edge-1', 'drawEdge'),
  trig('loop-t3', at(20), 'card', 'loop-node-n4', 'revealNode'),
  trig('loop-e2', at(21), 'chart', 'loop-edge-2', 'drawEdge'),
  trig('loop-t4', at(22), 'card', 'loop-node-n5', 'revealNode'),
  trig('loop-e3', at(23), 'chart', 'loop-edge-3', 'drawEdge'),
  trig('loop-e4', at(24), 'chart', 'loop-edge-4', 'drawEdge'),
  trig('loop-t5', at(25), 'chart', 'loop-node-n2', 'pulsePath', { chain: ['loop-node-n1', 'loop-node-n2', 'loop-node-n3', 'loop-node-n4', 'loop-node-n5'] }),
  trig('loop-t6', at(26), 'label', 'loop-node-marker', 'revealNode'),
  trig('loop-e5', at(27), 'chart', 'loop-edge-5', 'drawEdge'),
  trig('loop-t7', at(38), 'stat', 'loop-node-m1', 'rise'),
  trig('loop-t8', at(52), 'stat', 'loop-node-m2', 'rise'),
  trig('loop-t9', at(60), 'stat', 'loop-node-m3', 'rise'),
  trig('loop-t10', at(64), 'label', 'loop-node-m4', 'rise'),
  trig('loop-t11', at(72), 'card', 'loop-node-c1', 'left'),
  trig('loop-t12', at(80), 'stat', 'loop-node-c2', 'left'),
  trig('loop-t13', at(107), 'body', 'loop-node-t1', 'pop'),
  trig('loop-t14', at(111), 'body', 'loop-node-t2', 'pop'),
  trig('loop-t15', at(114), 'body', 'loop-node-t3', 'pop'),
];
loop.claims = [
  { claimId: 'c-win', type: 'direct', provenanceIds: ['report-1602086-vs-1601897.html:L3 or better 27.0->35.0/67 (ranges 24-29 vs 34-37)', 'report-1602086-vs-1601897.html:Returned NO path 21.3->11.7/67 — spoken as "almost halved"', 'report-1602086-vs-1601897.html:Assertions failed delta -26.0', 'report-1602086-vs-1601897.html:3 runs per arm'] },
  { claimId: 'c-caveat', type: 'direct', provenanceIds: ['report-1602086-vs-1601897.html:Out-of-scope probes stopped being refused — scope-prompt-injection 3/3 -> 1/3'] },
];

// ---- 5 · dimensions — round, without asserting anything false -------------------------
// Rounding 7 to the nearest 5 would state 5, a 29% error asserted as fact. "A handful"
// satisfies the intent — stop being precise — without being wrong. 0 is exact and is the
// punchline, so it is untouched.
const dim = by.dimensions;
dim.voiceoverText = dim.voiceoverText.replace(
  'Across all hundred and sixty-two scenarios: seven must refuse, a hundred and thirty-four must not, twenty-one where the question does not apply, and zero counted in both.',
  'Across all hundred and sixty-two scenarios: around a hundred and thirty-five must not refuse, a handful must, and zero counted in both.');
const lab = { k1: 'a handful must refuse', k2: '~135 must not refuse', k3: '~20 not applicable', k4: '0 counted in both' };
for (const n of dim.visual.nodes) if (lab[n.id]) n.label = lab[n.id];
dim.claims = dim.claims.map(c => c.claimId !== 'c-polarity' ? c : {
  claimId: 'c-polarity', type: 'derived',
  provenanceIds: ['contextlayer-eval/README.md:Validated across all 162 scenarios — 0 conflicts, 7 / 134 / 21. SPOKEN ROUNDED at user request: 134 as "around a hundred and thirty-five", 21 as "~20" on screen, 7 as "a handful" (rounding 7 to 5 would assert a 29% error). 0 conflicts is exact and unrounded.'],
});

// ---- restore the 4K render target -----------------------------------------------------
t.project.width = 3840; t.project.height = 2160; t.project.fps = 30;

// ---- retime provisionally; voice.mjs reflows onto measured audio ----------------------
const words = s => s.trim().split(/\s+/).length;
let cursor = t.intake.leadInMs;
for (const s of t.segments) {
  if (s.id === 'loop' || s.id === 'dimensions') { s.plannedDurationMs = Math.round((words(s.voiceoverText) / W) * 1000); delete s.audio; }
  const ms = s.audio?.durationMs ?? s.plannedDurationMs;
  s.startMs = cursor; s.endMs = cursor + ms; cursor = s.endMs + t.intake.perceivedGapMs;
}
t.durationMs = t.segments.at(-1).endMs;
t.intake.perSegmentToleranceMs = 15000;
delete t.timingHash;
for (const s of t.segments) {
  const dur = s.endMs - s.startMs;
  for (const tr of s.triggers ?? []) tr.atMs = Math.min(tr.atMs, Math.max(0, dur - 600));
  (s.triggers ?? []).sort((a, b) => a.atMs - b.atMs);
}

fs.writeFileSync('timing.json', JSON.stringify(t, null, 2));
const mm = ms => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
console.log(`loop ${words(loop.voiceoverText)}w · dimensions ${words(dim.voiceoverText)}w`);
console.log(`target restored: ${t.project.width}x${t.project.height} @ ${t.project.fps}fps`);
console.log(`projected ${mm(t.durationMs)} — S3 re-synthesis required`);
