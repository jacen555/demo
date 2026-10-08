// validate-scene: the pre-capture refusal.
//
// Every check here exists because a real render produced a wrong frame and reported
// success. The stage is pure data over timing.json — no browser, no ffmpeg, no frames —
// so it costs milliseconds against a capture that costs ~11 minutes at 4K.
//
// Two shapes of test appear throughout, and BOTH are required:
//
//   POSITIVE CONTROL — feed a deliberately broken input and assert the check reports it.
//     Without this, "0 problems" is indistinguishable from a check that cannot fire. That
//     is the exact defect class this engine has spent weeks removing: a guard that passes
//     because it is inert. Asserting exit 0 on a good project proves nothing on its own.
//
//   NEGATIVE CONTROL — feed a CORRECT input of the shape the check is most likely to
//     over-reach on, and assert silence. C1 earned this one: an earlier contiguity check
//     asserted segment ADJACENCY and so failed all 8 segments of a correct project,
//     because voice.mjs deliberately inserts inter-segment silence.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { EXIT } from '../src/cli-support.mjs';
import { classifyScanOutcome } from '../src/validate-scene.mjs';
import { makeProject, runScript, assertCleanExit } from './_helpers.mjs';

// ---------------------------------------------------------------------------
// Fixtures
//
// One diagram segment and one narrative segment that pass every check, so any single
// mutation below isolates exactly one check. Deliberate properties:
//   - viewBox 1600x520 = 3.08, above the 2.70 CSS-derived floor (B1)
//   - nodes inside the box and non-overlapping (B2, B3)
//   - a GAP between segments: 8000 -> 8500. Legal, and the C1 negative control.
//   - project.noGoPatterns is NON-EMPTY, so the clean run exercises D1's matcher rather
//     than its opt-out. A D1 control that supplies [] proves only that [] matches nothing.
// ---------------------------------------------------------------------------

const diagramSeg = () => ({
  id: 'flow',
  startMs: 0,
  endMs: 8000,
  voiceoverText: 'The request enters the gateway and reaches the service.',
  visual: {
    mode: 'diagram',
    title: 'Request flow',
    viewBox: '0 0 1600 520',
    nodes: [
      { id: 'gw', label: 'Gateway', x: 80, y: 180, w: 240, h: 96 },
      { id: 'svc', label: 'Service', x: 700, y: 180, w: 240, h: 96 },
    ],
    edges: [{ id: 'hop', from: 'gw', to: 'svc', label: 'https' }],
    note: 'Sourced from https://internal.example.com/runbook — authoring prose, never rendered.',
  },
  triggers: [
    { atMs: 600, target: 'flow-node-gw', action: 'revealNode' },
    { atMs: 1200, target: 'flow-node-svc', action: 'revealNode' },
    { atMs: 1800, target: 'flow-edge-hop', action: 'drawEdge' },
    { atMs: 2400, target: 'flow-edge-hop', action: 'flowEdge' },
  ],
});

const narrativeSeg = () => ({
  id: 'intro',
  startMs: 8500,
  endMs: 14000,
  voiceoverText: 'Here is what changed in this release.',
  visual: {
    mode: 'narrative',
    title: 'What changed',
    items: [{ label: 'Scope', text: 'Two services and one library.' }],
  },
  triggers: [{ atMs: 500, target: 'intro-item-0', action: 'pop' }],
});

/** A timing.json body that passes every check in the stage. */
function scene({ segments, project = {}, ...extra } = {}) {
  const segs = segments ?? [diagramSeg(), narrativeSeg()];
  return JSON.stringify(
    {
      project: {
        name: 'demo',
        fps: 30,
        width: 1920,
        height: 1080,
        // Non-empty on purpose: D1's mechanism is only exercised when something could match.
        noGoPatterns: ['https?://', '\\bPR \\d+\\b', 'SAP path'],
        ...project,
      },
      durationMs: segs.at(-1).endMs,
      endCard: { enabled: true },
      intake: { leadInMs: 2000, perceivedGapMs: 2000, voice: 'en-US-AvaNeural', speed: 1 },
      segments: segs,
      ...extra,
    },
    null,
    2,
  );
}

/** A knobs.json that agrees with `scene()` everywhere the two files overlap. */
function knobs(extra = {}) {
  return JSON.stringify(
    {
      render: { fps: 30, width: 1920, height: 1080 },
      voice: { voice: 'en-US-AvaNeural', speed: 1 },
      timing: { leadInMs: 2000, perceivedGapMs: 2000 },
      audio: { music: { generated: true, preset: 'calm-bed', attribution: null } },
      ...extra,
    },
    null,
    2,
  );
}

// The suite pins the scan budget generously rather than inheriting the 5000 ms default.
// That default is a judgement about a machine, and these tests run on CI boxes and on
// 12-worker local load rigs where an innocent scan was MEASURED crossing it — producing a
// refusal that had nothing to do with the check under test. Tests that are specifically
// about the budget override this explicitly; `scanTimeout_withAGenuinelyPathologicalPattern`
// deliberately does not, so the 5000 ms default itself stays pinned by one test.
const SCAN_TIMEOUT_KNOB = 'SIZZLECRAFT_SCAN_TIMEOUT_MS';
const GENEROUS_SCAN_BUDGET_MS = '60000';

const run = (dir, args = []) =>
  runScript('validate-scene.mjs', ['--project', dir, ...args], dir, {
    env: { [SCAN_TIMEOUT_KNOB]: GENEROUS_SCAN_BUDGET_MS },
  });

/**
 * Runs with the knob explicitly CLEARED from the child environment, so the engine's own
 * default is what is under test.
 *
 * `runScript` spreads `process.env` into the child, so merely omitting an override is not
 * the same as testing the default: an operator who has exported
 * SIZZLECRAFT_SCAN_TIMEOUT_MS in their shell would have these tests silently measuring
 * their value instead of 5000. Node drops `undefined` entries when building the child
 * environment, which is how the variable is removed rather than blanked — and a blank
 * string would not do, since resolveKnob treats an empty variable as unset anyway.
 */
const runAtDefaultBudget = (dir, args = []) =>
  runScript('validate-scene.mjs', ['--project', dir, ...args], dir, {
    env: { [SCAN_TIMEOUT_KNOB]: undefined },
  });

/**
 * Asserts the run refused, that THE NAMED CHECK is the one that refused, and that the
 * failure did not escape as a stack trace.
 *
 * The regex is anchored to the report's `FAIL` marker on that check's own row, and that
 * precision is load-bearing: the report lists every evaluated check by id, including the
 * ones that passed, so a bare `\bE2\b` match is satisfied by `E2 ... ok`. Written that
 * way, this helper waved through a test whose scene was actually being refused by E3 —
 * a green assertion about a check that never fired.
 */
function assertFlags(r, checkId, message = '') {
  assertCleanExit(r, EXIT.FAILED, message);
  assert.match(
    r.all,
    new RegExp(`^\\s*${checkId}\\s+.*\\sFAIL\\b`, 'm'),
    `${message}expected ${checkId} to be the check that failed\n${r.all}`,
  );
}

/** Asserts the run was clean AND that the named check actually ran (not silently skipped). */
function assertClean(r, message = '') {
  assertCleanExit(r, EXIT.OK, message);
  assert.match(r.all, /0 problems/, `${message}expected a "0 problems" summary\n${r.all}`);
}

// ---------------------------------------------------------------------------

describe('validate-scene: the clean baseline', () => {
  test('cleanScene_everyCheck_reportsNoProblems', (t) => {
    const dir = makeProject(t, { 'timing.json': scene(), 'knobs.json': knobs() });
    assertClean(run(dir));
  });

  test('cleanScene_everyCheck_reportsEachCheckAsEvaluated', (t) => {
    // The summary must account for every check by name. A stage that silently drops a
    // check reports the same "0 problems" as one that ran them all.
    //
    // Anchored to an EVALUATED status row (`ok` or `FAIL`), not to the id appearing
    // anywhere: the report also prints `NOT evaluated` rows carrying the same ids, so a
    // loose match was satisfied by a check that explicitly did not run.
    const dir = makeProject(t, { 'timing.json': scene(), 'knobs.json': knobs() });
    const r = run(dir);
    assertCleanExit(r, EXIT.OK);
    for (const id of ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3', 'C1', 'C4', 'C5', 'D1', 'E1', 'E2', 'E3']) {
      assert.match(
        r.all,
        new RegExp(`^\\s*${id}\\s+.*\\s(?:ok|FAIL\\b)`, 'm'),
        `check ${id} has no evaluated status row in the report\n${r.all}`,
      );
    }
  });

  test('missingTimingJson_isACallerError_notAFailedCheck', (t) => {
    const dir = makeProject(t, {});
    assertCleanExit(run(dir), EXIT.USAGE);
  });

  test('unparseableTimingJson_isACallerError', (t) => {
    const dir = makeProject(t, { 'timing.json': '{ not json' });
    assertCleanExit(run(dir), EXIT.USAGE);
  });
});

// ---------------------------------------------------------------------------
// R4 · a malformed segment entry
//
// A null entry crashed with `TypeError: Cannot read properties of null (reading
// 'visual')` and a stack trace: no index, no remedy, and a failure that looks like a bug
// in the tool rather than a refusal of the input. Every other malformed shape — a number,
// an array, a string, a boolean — was already handled cleanly, which is why the controls
// below matter as much as the fix: they are the evidence that `null` was fixed
// specifically, rather than a guard being widened until the symptom disappeared.
//
// The rule itself is NOT restated here. `shapeBlocker` in `silent-segment.mjs:839` owns
// it, and `voice` and `remix` already refuse exactly what it refuses before any other
// check of their segments. A third statement of one rule is how two of them drift.
// ---------------------------------------------------------------------------

describe('R4 · a malformed segment entry is refused, not crashed on', () => {
  /** A timing.json whose second segment is whatever the case supplies. */
  const withSecond = (raw) =>
    `{ "project": { "name": "r4", "fps": 30, "width": 1920, "height": 1080, "noGoPatterns": [] },
       "durationMs": 8000, "endCard": { "enabled": true },
       "segments": [
         { "id": "a", "startMs": 0, "endMs": 4000, "voiceoverText": "Hi.",
           "visual": { "mode": "narrative", "title": "T" }, "triggers": [] },
         ${raw}
       ] }`;

  test('nullSegmentEntry_isRefusedByIndexWithNoStackTrace', (t) => {
    const dir = makeProject(t, { 'timing.json': withSecond('null') });
    const r = run(dir);
    // assertCleanExit also asserts no stack trace escaped, which is the whole defect:
    // the old behaviour exited non-zero AND printed a stack, so a test written as
    // `notEqual(code, 0)` would have passed while the tool reported a bug in itself.
    assertCleanExit(r, EXIT.USAGE);
    assert.match(r.all, /segments\[1\]/, `the refusal must name the index\n${r.all}`);
    assert.doesNotMatch(r.all, /TypeError/, `it still crashed rather than refusing\n${r.all}`);
  });

  test('nullSegmentEntry_namesTheFirstBadIndexNotTheLast', (t) => {
    const dir = makeProject(t, { 'timing.json': withSecond('null, null') });
    const r = run(dir);
    assertCleanExit(r, EXIT.USAGE);
    assert.match(r.all, /segments\[1\]/, `expected the FIRST bad entry\n${r.all}`);
    assert.doesNotMatch(r.all, /segments\[2\]/, `it named a later entry than the first\n${r.all}`);
  });

  // CONTROLS — but NOT unchanged ones, and the distinction matters. Before the fix each of
  // these was already handled *cleanly*: no crash, exit 1, counted as an ordinary check
  // failure. Adopting shapeBlocker reclassifies them as what they actually are — a
  // malformed entry, refused by index at exit 2, the same as voice and remix.
  //
  // I described these as "already work and must keep working" at the approval gate. That
  // was wrong: their exit code moves from 1 to 2. Recorded here rather than quietly
  // absorbed, because a control whose behaviour changes is not a control until you say so.
  for (const [label, raw] of [['a number', '7'], ['an array', '[]'], ['a string', '"text"'], ['a boolean', 'true']]) {
    test(`segmentEntryThatIs${label.replace(/\W/g, '')}_isRefusedByIndex`, (t) => {
      const dir = makeProject(t, { 'timing.json': withSecond(raw) });
      const r = run(dir);
      assertCleanExit(r, EXIT.USAGE);
      assert.match(r.all, /segments\[1\]/, `${label}: the refusal must name the index\n${r.all}`);
    });
  }

  test('segmentWithNoId_isRefused', (t) => {
    // Accepted at the approval gate as a deliberate widening beyond the null crash:
    // `timing-schema.json:64,66` requires a non-empty string id, and without one every
    // emitted target becomes `undefined-node-…`, so the scene cannot render anyway.
    const dir = makeProject(t, {
      'timing.json': withSecond('{ "startMs": 4000, "endMs": 8000, "voiceoverText": "Yo.", "visual": { "mode": "narrative", "title": "U" } }'),
    });
    const r = run(dir);
    assertCleanExit(r, EXIT.USAGE);
    assert.match(r.all, /segments\[1\]/, `the refusal must name the index — it has no id to be named by\n${r.all}`);
  });

  test('segmentWithAnEmptyStringId_isRefused', (t) => {
    const dir = makeProject(t, {
      'timing.json': withSecond('{ "id": "", "startMs": 4000, "endMs": 8000, "voiceoverText": "Yo.", "visual": { "mode": "narrative", "title": "U" } }'),
    });
    assertCleanExit(run(dir), EXIT.USAGE);
  });

  test('segmentWithANonStringId_isRefused', (t) => {
    // shapeBlocker's id clause has three branches — missing, empty, and wrong type — and
    // the first two were covered while this one was not. An untested branch of a guard I
    // newly adopted is a branch I am asserting works on the strength of having read it.
    const dir = makeProject(t, {
      'timing.json': withSecond('{ "id": 7, "startMs": 4000, "endMs": 8000, "voiceoverText": "Yo.", "visual": { "mode": "narrative", "title": "U" } }'),
    });
    const r = run(dir);
    assertCleanExit(r, EXIT.USAGE);
    assert.match(r.all, /segments\[1\]/, `the refusal must name the index\n${r.all}`);
  });

  test('wellFormedSegments_areStillAccepted', (t) => {
    // The control that keeps the whole block honest: if this ever fails, the refusal is
    // rejecting valid input and every test above is passing for the wrong reason.
    const dir = makeProject(t, {
      'timing.json': withSecond('{ "id": "b", "startMs": 4000, "endMs": 8000, "voiceoverText": "Yo.", "visual": { "mode": "narrative", "title": "U" }, "triggers": [] }'),
    });
    assertClean(run(dir));
  });

  test('emptySegmentList_isRefusedByTheSameRule', (t) => {
    // Previously a bespoke check in this file's entry point, stating a rule shapeBlocker
    // already owned. Same refusal, now from one place.
    const dir = makeProject(t, {
      'timing.json': '{ "project": { "name": "r4", "noGoPatterns": [] }, "segments": [] }',
    });
    assertCleanExit(run(dir), EXIT.USAGE);
  });
});

// ---------------------------------------------------------------------------
// A · Trigger and element integrity
// ---------------------------------------------------------------------------

describe('A · trigger and element integrity', () => {
  test('A1_triggerTargetingAnElementNoModeEmits_isRefused', (t) => {
    // CAUGHT: a whole segment rendered blank. Triggers resolved to null, animated
    // nothing, and reported success.
    const seg = diagramSeg();
    seg.triggers.push({ atMs: 3000, target: 'flow-item-0', action: 'pop' });
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertFlags(run(dir), 'A1');
  });

  test('A1_bareUnqualifiedTargetId_isRefused', (t) => {
    // Target ids are segment-qualified: `flow-node-gw`, never `node-gw`. The bare form is
    // the most common authoring error and produces exactly the silent failure above.
    const seg = diagramSeg();
    seg.triggers[0].target = 'node-gw';
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertFlags(run(dir), 'A1');
  });

  test('A1_targetQualifiedWithAnotherSegmentsId_isRefused', (t) => {
    const seg = diagramSeg();
    seg.triggers[0].target = 'intro-node-gw';
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertFlags(run(dir), 'A1');
  });

  test('A1_codeModePathTarget_isNotRefusedHere', (t) => {
    // Highlight-path resolution is already a build-time refusal in write-build-html.mjs,
    // which has the parsed object in hand. Re-deriving it from data would be a second,
    // weaker copy of a rule that is already enforced where the evidence lives.
    const seg = {
      id: 'config',
      startMs: 0,
      endMs: 6000,
      voiceoverText: 'The configuration pins every knob.',
      visual: { mode: 'code', title: 'Configuration', json: { render: { fps: 30 } }, highlights: [{ path: 'render.fps' }] },
      triggers: [
        { atMs: 300, target: 'config-code', action: 'rise' },
        { atMs: 900, target: 'config-path-render-fps', action: 'codeFocus' },
      ],
    };
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg] }) });
    assertClean(run(dir));
  });

  test('A2_flowEdgeTargetingANode_isRefused', (t) => {
    // flowEdge animates particles along a path. Pointed at a node it does nothing, which
    // is indistinguishable from a correctly-wired segment that simply has no motion.
    const seg = diagramSeg();
    seg.triggers.push({ atMs: 3000, target: 'flow-node-gw', action: 'flowEdge' });
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertFlags(run(dir), 'A2');
  });

  test('A3_declaredEdgeWithNoDrawEdge_isRefused', (t) => {
    // CAUGHT: `dimensions` declared two edges that were never drawn. revealNode does NOT
    // draw an edge, and a diagram of disconnected boxes still looks plausible.
    const seg = diagramSeg();
    seg.triggers = seg.triggers.filter((x) => x.action !== 'drawEdge' && x.action !== 'flowEdge');
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertFlags(run(dir), 'A3');
  });

  test('A3_declaredNodeWithNoReveal_isRefused', (t) => {
    const seg = diagramSeg();
    seg.visual.nodes.push({ id: 'db', label: 'Database', x: 1300, y: 180, w: 240, h: 96 });
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertFlags(run(dir), 'A3');
  });

  test('A3_segmentWithNoAuthoredTargets_isNotRefused', (t) => {
    // NEGATIVE CONTROL. write-build-html.mjs:577 derives a full reveal sequence ONLY when
    // no authored trigger carries a target. Flagging those segments would fail every
    // correct auto-driven project — the C1-adjacency mistake in a new costume.
    const seg = diagramSeg();
    seg.triggers = [];
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertClean(run(dir));
  });

  test('A4_edgeDrawnBeforeItsEndpointIsRevealed_isRefused', (t) => {
    // CAUGHT: `twotier` drew lane edges to end-caps that were never revealed, so the edge
    // animated to a point nothing occupied.
    const seg = diagramSeg();
    seg.triggers.find((x) => x.target === 'flow-node-svc').atMs = 3000; // after the drawEdge at 1800
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertFlags(run(dir), 'A4');
  });

  test('A4_indexedEdgeIdConvention_isResolvedNotMissed', (t) => {
    // An edge WITHOUT an `id` emits `<seg>-edge-<index>`; with one it emits
    // `<seg>-edge-<id>`. Mixing the conventions is a silent miss — it was hit on `twotier`.
    const seg = diagramSeg();
    delete seg.visual.edges[0].id;
    seg.triggers = [
      { atMs: 600, target: 'flow-node-gw', action: 'revealNode' },
      { atMs: 1200, target: 'flow-node-svc', action: 'revealNode' },
      { atMs: 900, target: 'flow-edge-0', action: 'drawEdge' }, // before svc at 1200
    ];
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertFlags(run(dir), 'A4');
  });

  test('A5_triggerPastItsSegmentEnd_isRefused', (t) => {
    // CAUGHT: a lost card. voice.mjs reflows segment windows onto measured audio, so any
    // narration edit can push authored beats past the new end, where they never fire and
    // never error. An author can also do it with no reflow involved at all.
    const seg = diagramSeg();
    seg.triggers.push({ atMs: 9000, target: 'flow-node-gw', action: 'revealNode' }); // window is 8000
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertFlags(run(dir), 'A5');
  });

  test('A5_triggerExactlyAtSegmentEnd_isRefused', (t) => {
    // The bound is strict: atMs < (endMs - startMs). A beat ON the boundary fires as the
    // NEXT slide takes over, which is the defect, not an edge case of it.
    const seg = diagramSeg();
    seg.triggers.push({ atMs: 8000, target: 'flow-node-gw', action: 'revealNode' });
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertFlags(run(dir), 'A5');
  });
});

// ---------------------------------------------------------------------------
// B · Diagram geometry
// ---------------------------------------------------------------------------

describe('B · diagram geometry', () => {
  test('B1_sixteenByNineViewBoxWithNodes_isRefused', (t) => {
    // CAUGHT: a 16:9 viewBox rendered small enough that labels legible in the storyboard
    // were unreadable in the frame. MEASURED: a 16:9 viewBox draws at ~58% of the width a
    // wide one gets (3379px at 3.08 vs 1952px at 1.78).
    const seg = diagramSeg();
    seg.visual.viewBox = '0 0 1600 900'; // 1.78
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertFlags(run(dir), 'B1');
  });

  test('B1_engineDefaultViewBoxWhenNoneIsDeclared_isRefused', (t) => {
    // write-build-html.mjs:355 defaults to `0 0 1600 900` — 1.78. Every project that does
    // not override it letterboxes every diagram. Omitting the key must not buy a pass.
    const seg = diagramSeg();
    delete seg.visual.viewBox;
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertFlags(run(dir), 'B1');
  });

  test('B1_aspectJustBelowTheCssDerivedFloor_isRefused', (t) => {
    // The floor is 2.70, derived from 0.88*W / (fit * 0.58 * H) at 16:9 and fit 1 — not
    // the round 2.8 that was guessed. 1600/600 = 2.667.
    const seg = diagramSeg();
    seg.visual.viewBox = '0 0 1600 600';
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertFlags(run(dir), 'B1');
  });

  test('B1_segmentWithoutNodes_isNotEvaluated', (t) => {
    // NEGATIVE CONTROL. The threshold is about diagram legibility; a code-mode segment has
    // no viewBox at all and must not be dragged into it.
    const seg = {
      id: 'config',
      startMs: 0,
      endMs: 6000,
      voiceoverText: 'The configuration pins every knob.',
      visual: { mode: 'code', title: 'Configuration', json: { fps: 30 } },
      triggers: [{ atMs: 300, target: 'config-code', action: 'rise' }],
    };
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg] }) });
    assertClean(run(dir));
  });

  test('B2_nodeOverflowingItsViewBox_isRefused', (t) => {
    // CAUGHT: overlapping, clipped nodes in `loop` — 15 nodes in a 1600x520 box.
    const seg = diagramSeg();
    seg.visual.nodes[1] = { id: 'svc', label: 'Service', x: 1400, y: 180, w: 300, h: 96 };
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertFlags(run(dir), 'B2');
  });

  test('B2_negativeNodeOrigin_isRefused', (t) => {
    const seg = diagramSeg();
    seg.visual.nodes[0].x = -40;
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertFlags(run(dir), 'B2');
  });

  test('B3_overlappingNodes_isRefused', (t) => {
    // B2 catches overflow of the box, never overlap WITHIN it. `loop`'s nodes were inside
    // the viewBox and still unreadable, and that defect was reported twice.
    const seg = diagramSeg();
    seg.visual.nodes[1].x = 200; // gw spans 80..320; svc would span 200..440
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertFlags(run(dir), 'B3');
  });

  test('B3_nodesTouchingAtTheEdge_isNotRefused', (t) => {
    // NEGATIVE CONTROL. Shared borders are a legitimate layout. Only a positive-area
    // intersection is a defect; `>=` here would flag every flush-stacked diagram.
    const seg = diagramSeg();
    seg.visual.nodes[1].x = 320; // gw ends exactly where svc begins
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertClean(run(dir));
  });
});

// ---------------------------------------------------------------------------
// C · Timeline shape
// ---------------------------------------------------------------------------

describe('C · timeline shape', () => {
  test('C1_overlappingSegments_isRefused', (t) => {
    const a = diagramSeg();
    const b = narrativeSeg();
    b.startMs = 7000; // inside a's 0..8000 window
    const dir = makeProject(t, { 'timing.json': scene({ segments: [a, b] }) });
    assertFlags(run(dir), 'C1');
  });

  test('C1_zeroLengthSegment_isRefused', (t) => {
    const a = diagramSeg();
    a.endMs = a.startMs;
    const dir = makeProject(t, { 'timing.json': scene({ segments: [a, narrativeSeg()] }) });
    assertFlags(run(dir), 'C1');
  });

  test('C1_gapBetweenSegments_isNotRefused', (t) => {
    // NEGATIVE CONTROL, and the most important one in the file. An earlier contiguity
    // check asserted ADJACENCY and failed all 8 segments of a correct project, because
    // voice.mjs deliberately inserts inter-segment silence. A gap is not an error.
    const a = diagramSeg();
    const b = narrativeSeg();
    b.startMs = 20000;
    b.endMs = 26000;
    const dir = makeProject(t, { 'timing.json': scene({ segments: [a, b] }) });
    assertClean(run(dir));
  });

  test('C2_withCalibrationPresent_segmentMissingMeasuredWords_isRefused', (t) => {
    // CAUGHT: stale state after a partial re-synthesis.
    const a = diagramSeg();
    a.audio = { file: 'segment_000.mp3', durationMs: 8000, words: [{ word: 'The', startMs: 0, endMs: 300 }] };
    const b = narrativeSeg();
    b.audio = { file: 'segment_001.mp3', durationMs: 5500 }; // no words[]
    const dir = makeProject(t, {
      'timing.json': scene({ segments: [a, b] }),
      'calibration-observed.json': JSON.stringify({ aggregate: { observedEffWps: 3.4 } }),
    });
    assertFlags(run(dir), 'C2');
  });

  test('C2_withNoCalibration_isReportedAsNotEvaluatedRatherThanPassed', (t) => {
    // A pre-synthesis timeline legitimately carries no audio. Silence here would read as
    // a clean bill of health for a check that never ran.
    const dir = makeProject(t, { 'timing.json': scene() });
    const r = run(dir);
    assertCleanExit(r, EXIT.OK);
    assert.match(r.all, /calibration-observed\.json: ABSENT/, `expected the absence to be reported\n${r.all}`);
    assert.match(r.all, /NOT evaluated/, `expected "NOT evaluated" rather than a pass\n${r.all}`);
  });

  test('C3_endCardCanonicalForm_isDelegatedToTheSchemaNotRestatedHere', (t) => {
    // end-card.mjs PRODUCES this invariant and timing-schema.json CHECKS it. A copy here
    // would be a third statement of one rule, which is how two of them drift.
    const dir = makeProject(t, { 'timing.json': scene({ endCard: { enabled: false, builderVersion: '1.0' } }) });
    const r = run(dir);
    assert.doesNotMatch(r.all, /\bC3\b/, `C3 must not be re-stated in this stage\n${r.all}`);
    assert.match(r.all, /validate-timing/, `expected a pointer to the stage that owns it\n${r.all}`);
  });

  test('C5_nonSixteenByNineRenderTarget_isRefused', (t) => {
    // B1's threshold is derived from a 16:9 stage. A 4:3 target silently invalidates every
    // diagram layout in the project.
    const dir = makeProject(t, { 'timing.json': scene({ project: { width: 1440, height: 1080 } }) });
    assertFlags(run(dir), 'C5');
  });
});

// ---------------------------------------------------------------------------
// D · Content safety
// ---------------------------------------------------------------------------

describe('D · content safety', () => {
  test('D1_missingNoGoPatternsKey_isRefused', (t) => {
    // Absence must not be permission. A missing key previously defaulted to allow-all, so
    // the guarantee was inert in the only project that used it — and the tests passed
    // because they supplied their own patterns, which proves the mechanism works and
    // never that it is switched on. `[]` is the explicit opt-out.
    const dir = makeProject(t, { 'timing.json': scene({ project: { noGoPatterns: undefined } }) });
    assertFlags(run(dir), 'D1');
  });

  test('D1_emptyPatternListIsTheExplicitOptOut_isNotRefused', (t) => {
    const dir = makeProject(t, { 'timing.json': scene({ project: { noGoPatterns: [] } }) });
    assertClean(run(dir));
  });

  test('D1_titleMatchingANoGoPattern_isRefused', (t) => {
    // CAUGHT: this is the guard that kept deployment hostnames and ADO pull-request ids
    // out of the shipped video.
    const seg = diagramSeg();
    seg.visual.title = 'See https://internal.example.com for the runbook';
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertFlags(run(dir), 'D1');
  });

  test('D1_narrationMatchingANoGoPattern_isRefused', (t) => {
    const seg = diagramSeg();
    seg.voiceoverText = 'We shipped this in PR 4821 last week.';
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertFlags(run(dir), 'D1');
  });

  test('D1_retiredJargonInAnItemLabel_isRefused', (t) => {
    // D2 is the same mechanism against a project's own glossary of retired terms.
    const seg = narrativeSeg();
    seg.visual.items[0].label = 'SAP path';
    const dir = makeProject(t, { 'timing.json': scene({ segments: [diagramSeg(), seg] }) });
    assertFlags(run(dir), 'D1');
  });

  test('D1_codeModePayloadMatchingANoGoPattern_isRefused', (t) => {
    // code mode is the only mode that puts SOURCE DATA on screen rather than authored
    // copy, so it is the likeliest route for a hostname to reach a frame.
    const seg = {
      id: 'config',
      startMs: 0,
      endMs: 6000,
      voiceoverText: 'The configuration pins every knob.',
      visual: { mode: 'code', title: 'Configuration', json: { endpoint: 'https://internal.example.com' } },
      triggers: [{ atMs: 300, target: 'config-code', action: 'rise' }],
    };
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg] }) });
    assertFlags(run(dir), 'D1');
  });

  test('D1_visualNoteAndClaims_areExcludedFromTheScan', (t) => {
    // NEGATIVE CONTROL. `visual.note` and `claims` are authoring prose and provenance.
    // They never reach a frame and they are ALLOWED to name sources — the clean fixture's
    // note carries an https:// URL precisely so this exclusion is exercised on every run.
    const seg = diagramSeg();
    seg.claims = [{ text: 'Measured at 3379px', source: 'https://internal.example.com/run/42' }];
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertClean(run(dir));
  });

  test('D1_unparseablePattern_isACallerErrorNotASilentPass', (t) => {
    // An invalid regex must not be swallowed into "nothing matched".
    const dir = makeProject(t, { 'timing.json': scene({ project: { noGoPatterns: ['('] } }) });
    assertCleanExit(run(dir), EXIT.USAGE);
  });
});

// ---------------------------------------------------------------------------
// knobs.json · optional, absence reported rather than skipped
// ---------------------------------------------------------------------------

describe('knobs.json · C4 and E1-E3', () => {
  test('knobsAbsent_isReportedAsNotEvaluatedRatherThanPassed', (t) => {
    // The decision on record: treat knobs.json as optional, but never let a missing file
    // read as a clean bill of health. This engine distinguishes `passed` from `could not
    // run`, and that distinction is the whole value of the option.
    const dir = makeProject(t, { 'timing.json': scene() });
    const r = run(dir);
    assertCleanExit(r, EXIT.OK);
    assert.match(
      r.all,
      /knobs\.json: ABSENT — 4 checks NOT evaluated/,
      `expected the exact absence report\n${r.all}`,
    );
  });

  test('knobsAbsent_doesNotCountTheFourChecksAsPassed', (t) => {
    const dir = makeProject(t, { 'timing.json': scene() });
    const withoutKnobs = run(dir);
    fs.writeFileSync(path.join(dir, 'knobs.json'), knobs());
    const withKnobs = run(dir);
    assertCleanExit(withoutKnobs, EXIT.OK);
    assertCleanExit(withKnobs, EXIT.OK);
    const evaluated = (out) => Number(/(\d+) checks evaluated/.exec(out)?.[1] ?? -1);
    assert.equal(
      evaluated(withKnobs.all) - evaluated(withoutKnobs.all),
      4,
      `supplying knobs.json must raise the evaluated count by exactly 4\n--- without ---\n${withoutKnobs.all}\n--- with ---\n${withKnobs.all}`,
    );
  });

  test('knobsAbsent_namesTheFileTheCallerActuallyAskedFor', (t) => {
    // Found while verifying the README's own `--knobs` example. With a named file that is
    // missing, the absence line said `knobs.json: ABSENT` — naming a file the caller never
    // mentioned, while the one they DID name went unreported. The author then goes looking
    // for knobs.json, finds it legitimately absent, and never learns that the path they
    // passed is what did not resolve.
    //
    // Same class as the progress-marker parse that blamed pattern 0 for pattern 1's stall:
    // a confident, specific, wrong diagnosis, which is worse than a vague one because it
    // sends someone to the wrong place with conviction.
    const dir = makeProject(t, { 'timing.json': scene() });
    const r = run(dir, ['--knobs', 'manifest.json']);
    assertCleanExit(r, EXIT.OK);
    assert.match(r.all, /manifest\.json: ABSENT — 4 checks NOT evaluated/, `expected the named file\n${r.all}`);
    assert.doesNotMatch(r.all, /knobs\.json: ABSENT/, `it named a file the caller never asked for\n${r.all}`);
    // The per-check rows carry the same name and are changed by the same fix. Asserting
    // only the summary would let those four regress to "knobs.json is absent" silently —
    // and they are what a reader actually scans.
    for (const id of ['C4', 'E1', 'E2', 'E3']) {
      assert.match(
        r.all,
        new RegExp(`^\\s*${id}\\s+.*NOT evaluated — manifest\\.json is absent`, 'm'),
        `the ${id} row must name the file the caller asked for\n${r.all}`,
      );
    }
    assert.doesNotMatch(r.all, /NOT evaluated — knobs\.json is absent/, `a per-check row named the wrong file\n${r.all}`);
  });

  test('C4_fpsDriftBetweenTheTwoFiles_isRefused', (t) => {
    // CAUGHT: drift after editing one file and not the other; also the 24 dB music-gain
    // divergence, where knobs recorded 0.055 and the shipped mix used 0.85.
    const dir = makeProject(t, {
      'timing.json': scene(),
      'knobs.json': knobs({ render: { fps: 15, width: 1920, height: 1080 } }),
    });
    assertFlags(run(dir), 'C4');
  });

  test('C4_voiceDriftBetweenTheTwoFiles_isRefused', (t) => {
    const dir = makeProject(t, {
      'timing.json': scene(),
      'knobs.json': knobs({ voice: { voice: 'en-GB-SoniaNeural', speed: 1 } }),
    });
    assertFlags(run(dir), 'C4');
  });

  test('C4_valuePresentInOnlyOneFile_isNotRefused', (t) => {
    // NEGATIVE CONTROL. The assertion is "equal WHERE THEY OVERLAP". A key only one file
    // carries is not drift, and refusing it would make the check unusable.
    const dir = makeProject(t, {
      'timing.json': scene(),
      'knobs.json': knobs({ render: { fps: 30 } }), // no width/height at all
    });
    assertClean(run(dir));
  });

  test('E1_musicAttributionWithTheEndCardDisabled_isRefused', (t) => {
    // The end card is the only credit surface. A swap to a track whose licence requires
    // attribution must not land silently while the card is off — that ships an
    // uncredited work.
    const dir = makeProject(t, {
      'timing.json': scene({ endCard: { enabled: false } }),
      'knobs.json': knobs({
        audio: { music: { generated: false, file: 'bed.mp3', licence: 'CC-BY-4.0', durationSeconds: 300, attribution: 'Kai Engel — Idle Ways' } },
      }),
    });
    assertFlags(run(dir), 'E1');
  });

  test('E2_licensedTrackMissingItsLicence_isRefused', (t) => {
    // CAUGHT: a half-switched config after moving from the synth bed to a licensed track.
    const dir = makeProject(t, {
      'timing.json': scene(),
      'knobs.json': knobs({ audio: { music: { generated: false, file: 'bed.mp3', durationSeconds: 300, attribution: null } } }),
    });
    assertFlags(run(dir), 'E2');
  });

  test('E2_generatedBedWithNoPreset_isRefused', (t) => {
    const dir = makeProject(t, {
      'timing.json': scene(),
      'knobs.json': knobs({ audio: { music: { generated: true, attribution: null } } }),
    });
    assertFlags(run(dir), 'E2');
  });

  test('E3_trackShorterThanTheVideoAndNotFlaggedForLooping_isRefused', (t) => {
    // bug-ledger 15: `amix duration=longest` does NOT extend a short input, so 92 seconds
    // played with no bed at all and nothing reported it.
    const dir = makeProject(t, {
      'timing.json': scene(), // 14000 ms
      'knobs.json': knobs({
        audio: { music: { generated: false, file: 'bed.mp3', licence: 'CC0', durationSeconds: 9, attribution: null } },
      }),
    });
    assertFlags(run(dir), 'E3');
  });

  test('E3_shortTrackExplicitlyFlaggedForLooping_isNotRefused', (t) => {
    // NEGATIVE CONTROL. Looping is the sanctioned remedy, not a workaround.
    const dir = makeProject(t, {
      'timing.json': scene(),
      'knobs.json': knobs({
        audio: {
          music: { generated: false, file: 'bed.mp3', licence: 'CC0', durationSeconds: 9, attribution: null, loop: { required: true } },
        },
      }),
    });
    assertClean(run(dir));
  });

  test('unparseableKnobsJson_isACallerErrorNotATreatedAsAbsent', (t) => {
    // Absent and broken are different. Falling back to "absent" would let a corrupted
    // manifest buy the same silence as never having written one.
    const dir = makeProject(t, { 'timing.json': scene(), 'knobs.json': '{ not json' });
    assertCleanExit(run(dir), EXIT.USAGE);
  });
});

// ---------------------------------------------------------------------------
// Counterexamples raised by the independent review.
//
// Every test below FAILED against the first implementation. They are kept together
// because they share one shape: the guard ran, reported "0 problems", and was WRONG —
// which is the precise defect class this whole stage exists to remove, reproduced inside
// the stage itself.
// ---------------------------------------------------------------------------

describe('counterexamples · a guard that runs and is still wrong', () => {
  test('A3_edgeTargetedOnlyByRevealNode_isRefused', (t) => {
    // The first implementation accepted ANY reveal-class action for ANY element, so an
    // edge addressed by `revealNode` counted as revealed. That is the exact sentence A3's
    // own rationale rejects: revealNode does NOT draw an edge. The guard contradicted the
    // defect it was written for, and the original positive control missed it because it
    // stripped every edge-targeted trigger instead of leaving a wrong one in place.
    const seg = diagramSeg();
    seg.triggers = [
      { atMs: 600, target: 'flow-node-gw', action: 'revealNode' },
      { atMs: 1200, target: 'flow-node-svc', action: 'revealNode' },
      { atMs: 1800, target: 'flow-edge-hop', action: 'revealNode' }, // not a draw
    ];
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertFlags(run(dir), 'A3');
  });

  test('A3_nodeRevealedByDrawEdge_isNotRefused', (t) => {
    // CORRECTED. This test originally asserted the opposite — that a node addressed only
    // by `drawEdge` is refused — on the symmetry argument that "drawEdge does not reveal a
    // node". The renderer disproves it: write-build-html.mjs:895 `drawEdge(id)` calls
    // `show(el)` BEFORE any path work, with `getTotalLength()` inside a try/catch. Pointed
    // at a node it reveals the node; only the stroke animation is lost.
    //
    // It is kept, inverted, rather than deleted: it is the record that this rule was
    // settled by reading the renderer instead of by reasoning about what the action names
    // ought to mean. Both times that reasoning was applied here it produced a false
    // positive against working authoring.
    const seg = diagramSeg();
    seg.triggers = [
      { atMs: 600, target: 'flow-node-gw', action: 'drawEdge' },
      { atMs: 1200, target: 'flow-node-svc', action: 'revealNode' },
      { atMs: 1800, target: 'flow-edge-hop', action: 'drawEdge' },
    ];
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertClean(run(dir));
  });

  test('A1_footageSegment_isNotEvaluatedRatherThanCertified', (t) => {
    // The real mode() consults footageUsable(), which reads clips.json and an approval
    // manifest. A data-only stage cannot know whether the clip is usable, and therefore
    // cannot know whether the builder emits `-footage` or falls back to synthetic content
    // with an entirely different id set. The first implementation ASSUMED footage and so
    // certified a trigger that may address nothing. Certifying what it cannot know is the
    // one thing this stage must never do.
    const seg = {
      id: 'clip',
      startMs: 0,
      endMs: 6000,
      voiceoverText: 'Here is the recording.',
      visual: { mode: 'footage', title: 'Recording', footage: { clipId: 'demo-001' } },
      triggers: [{ atMs: 400, target: 'clip-footage', action: 'rise' }],
    };
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg] }) });
    const r = run(dir);
    assertCleanExit(r, EXIT.OK);
    assert.match(
      r.all,
      /clip.*footage mode/s,
      `expected the footage segment to be named as not evaluated\n${r.all}`,
    );
    assert.match(r.all, /NOT evaluated/, `expected "NOT evaluated", not a silent pass\n${r.all}`);
  });

  test('E2_nonNumericDurationSeconds_isRefused', (t) => {
    // E2 checked only that the key was PRESENT, and E3 returned early on a non-finite
    // value "because E2 already reported it". Neither reported it: `"unknown"` sailed
    // through both and exited 0. Two guards, one hole, each assuming the other.
    const dir = makeProject(t, {
      'timing.json': scene(),
      'knobs.json': knobs({
        audio: { music: { generated: false, file: 'bed.mp3', licence: 'CC0', durationSeconds: 'unknown', attribution: null } },
      }),
    });
    assertFlags(run(dir), 'E2');
  });

  test('E2_negativeDurationSeconds_isRefused', (t) => {
    const dir = makeProject(t, {
      'timing.json': scene(),
      'knobs.json': knobs({
        audio: { music: { generated: false, file: 'bed.mp3', licence: 'CC0', durationSeconds: -3, attribution: null } },
      }),
    });
    assertFlags(run(dir), 'E2');
  });

  test('B2_nonZeroViewBoxOrigin_isHonoured', (t) => {
    // parseViewBox discarded minX/minY and then compared node coordinates against
    // 0..width. A viewBox with a negative origin is valid SVG, and every node inside it
    // was refused — a false positive that would make the check unusable for anyone who
    // uses an offset origin.
    const seg = diagramSeg();
    seg.visual.viewBox = '-200 -100 1600 520';
    seg.visual.nodes = [
      { id: 'gw', label: 'Gateway', x: -150, y: -60, w: 240, h: 96 },
      { id: 'svc', label: 'Service', x: 700, y: 180, w: 240, h: 96 },
    ];
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertClean(run(dir));
  });

  test('B2_nodeOutsideANonZeroOriginViewBox_isRefused', (t) => {
    // The positive control for the fix above: the origin must be honoured in BOTH
    // directions, or "respect minX" degrades into "never refuse anything".
    const seg = diagramSeg();
    seg.visual.viewBox = '-200 -100 1600 520';
    seg.visual.nodes = [
      { id: 'gw', label: 'Gateway', x: -400, y: -60, w: 240, h: 96 }, // left of minX
      { id: 'svc', label: 'Service', x: 700, y: 180, w: 240, h: 96 },
    ];
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertFlags(run(dir), 'B2');
  });

  test('C2_synthesisedSilentSegment_isNotRefusedForHavingNoWords', (t) => {
    // A silent segment is DECLARED, never inferred (it carries `silence`), and it has no
    // narration — so it has no measured words by definition. Demanding them flagged every
    // correct project that uses one. Same family as the adjacency bug: a check that
    // cannot pass on a valid input.
    const a = diagramSeg();
    a.audio = { file: 'segment_000.mp3', durationMs: 8000, words: [{ word: 'The', startMs: 0, endMs: 300 }] };
    const pause = { id: 'beat', startMs: 8000, endMs: 10000, silence: { reason: 'let the diagram land' } };
    const b = narrativeSeg();
    b.startMs = 10000;
    b.endMs = 15500;
    b.audio = { file: 'segment_001.mp3', durationMs: 5500, words: [{ word: 'Here', startMs: 10000, endMs: 10400 }] };
    const dir = makeProject(t, {
      'timing.json': scene({ segments: [a, pause, b] }),
      'calibration-observed.json': JSON.stringify({ aggregate: { observedEffWps: 3.4 } }),
    });
    assertClean(run(dir));
  });

  test('D1_theMatchedSecretIsNotEchoedInTheReport', (t) => {
    // D1 printed the matched text. The guard whose entire job is to stop a deployment
    // hostname reaching a frame was copying that hostname into stdout and therefore into
    // CI logs. The finding must identify WHERE and WHICH PATTERN, never the value.
    const seg = diagramSeg();
    seg.visual.title = 'See https://internal.example.com/secret-runbook';
    const dir = makeProject(t, {
      'timing.json': scene({
        segments: [seg, narrativeSeg()],
        // A pattern whose MATCH is the secret itself. The clean fixture's `https?://`
        // matches only the scheme, so a test built on it would "prove" non-disclosure
        // while the report happily echoed every hostname a real project cares about.
        project: { noGoPatterns: ['internal\\.[a-z0-9.-]+'] },
      }),
    });
    const r = run(dir);
    assertFlags(r, 'D1');
    assert.doesNotMatch(r.all, /internal\.example\.com/, `the matched secret was echoed\n${r.all}`);
    assert.match(r.all, /visual\.title/, `the finding must still say where it is\n${r.all}`);
  });

  test('knobsPathOutsideTheProjectRoot_isRefused', (t) => {
    // --timing went through the project boundary; --knobs was a bare path.join. A caller
    // could read, and have parsed, a JSON file anywhere on disk. Worse, a path that
    // escaped and did not exist was reported as "knobs.json: ABSENT" — a boundary breach
    // degrading into a clean bill of health.
    const dir = makeProject(t, { 'timing.json': scene() });
    assertCleanExit(run(dir, ['--knobs', '../outside-knobs.json']), EXIT.USAGE);
  });

  test('noGoPatternBeyondTheLengthBound_isACallerError', (t) => {
    // The patterns are compiled from a file on disk and run against every rendered string.
    // Node offers no regex timeout, so the bound on catastrophic backtracking is a bound
    // on the inputs. An unbounded pattern must be refused rather than quietly run.
    const dir = makeProject(t, { 'timing.json': scene({ project: { noGoPatterns: ['a'.repeat(5000)] } }) });
    assertCleanExit(run(dir), EXIT.USAGE);
  });
});

// ---------------------------------------------------------------------------
// Round-2 counterexamples.
//
// Four of these came from the second independent review. The two marked PUSH-BACK are
// regression guards for findings the review raised that the RENDERER'S SOURCE disproves —
// they are pinned here so the claim is settled by evidence and cannot be re-litigated
// from memory.
// ---------------------------------------------------------------------------

describe('round 2 · reveal semantics read from the renderer', () => {
  test('D1_theNoGoPatternItselfIsNotEchoed', (t) => {
    // Withholding the MATCH is not enough. A pattern is routinely a literal: an author who
    // writes `internal\.example\.com` to keep that host off the screen would have the
    // report print the host back. Findings identify the pattern BY INDEX.
    const seg = diagramSeg();
    seg.visual.title = 'See internal.example.com for the runbook';
    const dir = makeProject(t, {
      'timing.json': scene({ segments: [seg, narrativeSeg()], project: { noGoPatterns: ['internal\\.example\\.com'] } }),
    });
    const r = run(dir);
    assertFlags(r, 'D1');
    assert.doesNotMatch(r.all, /example\.com/, `the pattern source leaked the secret\n${r.all}`);
    assert.match(r.all, /noGoPatterns\[0\]/, `the finding must still say WHICH pattern\n${r.all}`);
  });

  test('A3_nodeRevealedByPop_isNotRefused', (t) => {
    // write-build-html.mjs:935 `apply()` sends any unrecognised action to
    // `reveal(tr.a, tr.kind)`, and `reveal()` at :894 is target-agnostic — it calls
    // show(el) and uses `kind` only to pick a tween. So `pop` on a node genuinely reveals
    // it, and the first class split refused a legitimate authoring pattern.
    const seg = diagramSeg();
    seg.triggers[0] = { atMs: 600, target: 'flow-node-gw', action: 'pop' };
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertClean(run(dir));
  });

  test('A3_itemRevealedByAnUnrecognisedAction_isNotRefused', (t) => {
    // `flip` is not in apply()'s switch at all, so it falls to the default and reveals.
    // Enumerating an allow-list of action NAMES was the wrong model; the renderer has an
    // effective deny-list, and anything outside it reveals.
    const seg = narrativeSeg();
    seg.triggers = [{ atMs: 500, target: 'intro-item-0', action: 'flip' }];
    const dir = makeProject(t, { 'timing.json': scene({ segments: [diagramSeg(), seg] }) });
    assertClean(run(dir));
  });

  test('A3_itemRevealedByStepBadge_isNotRefused', (t) => {
    // CORRECTED. This was a `stepBadge` POSITIVE control asserting that a decorating
    // action does not reveal. Reading the runtime shows that is false: `stepBadge` at
    // write-build-html.mjs:933 does `const r=fxRect(id); if(!r)return; show(r.el);`.
    // Nearly every special-cased action calls show() on its own target — clickAt:897,
    // typeInto:898, spotlight:903, emphasize:920, callout:929, flowEdge:931,
    // pulsePath:932, stepBadge:933. The "decorates something already visible" story was
    // my own invention; the code reveals first and decorates second.
    const seg = narrativeSeg();
    seg.triggers = [{ atMs: 500, target: 'intro-item-0', action: 'stepBadge' }];
    const dir = makeProject(t, { 'timing.json': scene({ segments: [diagramSeg(), seg] }) });
    assertClean(run(dir));
  });

  test('A3_itemRevealedByFlowEdge_isNotRefused', (t) => {
    // write-build-html.mjs:931 `flowEdge(id)` calls `show(path)` before anything else.
    // (A2 still refuses flowEdge on a non-edge — that is a separate finding about motion,
    // not about visibility, and the two must not be conflated.)
    const seg = narrativeSeg();
    seg.triggers = [
      { atMs: 500, target: 'intro-item-0', action: 'flowEdge' },
      { atMs: 600, target: 'intro-item-0', action: 'pop' },
    ];
    const dir = makeProject(t, { 'timing.json': scene({ segments: [diagramSeg(), seg] }) });
    const r = run(dir);
    // A2 fires on the flowEdge, but A3 must NOT: the item is visible.
    assertFlags(r, 'A2');
    assert.doesNotMatch(r.all, /^\s*A3\s+.*\sFAIL\b/m, `A3 must not claim a shown item is hidden\n${r.all}`);
  });

  test('A3_itemTargetedOnlyByProgress_isRefused', (t) => {
    // `progressBar` at write-build-html.mjs:934 resolves its host with `fxHost(tr, null)`
    // and never looks its target up at all, so it draws a slide-level bar and leaves the
    // element hidden.
    const seg = narrativeSeg();
    seg.triggers = [{ atMs: 500, target: 'intro-item-0', action: 'progress' }];
    const dir = makeProject(t, { 'timing.json': scene({ segments: [diagramSeg(), seg] }) });
    assertFlags(run(dir), 'A3');
  });

  test('A3_itemTargetedOnlyByZoomFocus_isRefused', (t) => {
    // `zoomFocus` at write-build-html.mjs:928 scales the SURFACE. It calls `fxRect(id)`
    // only to compute an offset and never shows the element — so a reader skimming for
    // `fxRect(id)` would conclude it reveals, which is how it survived the previous pass.
    const seg = narrativeSeg();
    seg.triggers = [{ atMs: 500, target: 'intro-item-0', action: 'zoomFocus' }];
    const dir = makeProject(t, { 'timing.json': scene({ segments: [diagramSeg(), seg] }) });
    assertFlags(run(dir), 'A3');
  });

  test('A3_itemTargetedOnlyByASpotlightRelease_isRefused', (t) => {
    // REVELATION DEPENDS ON THE PAYLOAD, not just the action name. `spotlight`:903 and
    // `codeFocus`:904 both return early when `payload.release` is set, BEFORE their
    // `show()` call. A release is a teardown; it cannot be the thing that first shows an
    // element. Classifying by action name alone certified a hidden item.
    const seg = narrativeSeg();
    seg.triggers = [{ atMs: 500, target: 'intro-item-0', action: 'spotlight', payload: { release: true } }];
    const dir = makeProject(t, { 'timing.json': scene({ segments: [diagramSeg(), seg] }) });
    assertFlags(run(dir), 'A3');
  });

  test('A3_itemRevealedBySpotlightWithoutRelease_isNotRefused', (t) => {
    // The other half: the ordinary spotlight DOES show its target (`show(r.el)` at :903),
    // so the payload test must discriminate rather than condemn the whole action.
    const seg = narrativeSeg();
    seg.triggers = [{ atMs: 500, target: 'intro-item-0', action: 'spotlight' }];
    const dir = makeProject(t, { 'timing.json': scene({ segments: [diagramSeg(), seg] }) });
    assertClean(run(dir));
  });

  test('A3_itemTargetedOnlyByHoverWithNoToId_isRefused', (t) => {
    // `hover`:930 shows the cursor through `moveCursor` only when `payload.toId` is set,
    // and returns at `if(!r)return` otherwise. Nothing is ever shown.
    const seg = narrativeSeg();
    seg.triggers = [{ atMs: 500, target: 'intro-item-0', action: 'hover' }];
    const dir = makeProject(t, { 'timing.json': scene({ segments: [diagramSeg(), seg] }) });
    assertFlags(run(dir), 'A3');
  });

  test('A3_itemTargetedByHoverWhoseToIdResolvesToNothing_isRefused', (t) => {
    // A PRESENT `toId` is not a RESOLVING one. `moveCursor`:899 is
    // `const c=byId(cursorId),t=byId(toId); if(!c||!t)return; show(c);` — so a dangling
    // destination means even the cursor is never shown. Checking only that the key exists
    // accepts a payload that points at nothing, which is the same silent-null failure A1
    // exists to catch, one level down in the payload where A1 does not look.
    const seg = narrativeSeg();
    seg.triggers = [{ atMs: 500, target: 'intro-item-0', action: 'hover', payload: { toId: 'intro-item-9' } }];
    const dir = makeProject(t, { 'timing.json': scene({ segments: [diagramSeg(), seg] }) });
    assertFlags(run(dir), 'A3');
  });

  test('A3_itemTargetedByHoverWhoseToIdResolves_isNotRefused', (t) => {
    const seg = narrativeSeg();
    seg.triggers = [{ atMs: 500, target: 'intro-item-0', action: 'hover', payload: { toId: 'intro-item-0' } }];
    const dir = makeProject(t, { 'timing.json': scene({ segments: [diagramSeg(), seg] }) });
    assertClean(run(dir));
  });

  test('A3_nodeTargetedByPulsePathWithAChainExcludingIt_isRefused', (t) => {
    // `pulsePath`:932 shows the ids in `payload.chain`, falling back to `[tr.a]` only when
    // no chain is supplied. With a chain that omits the target, the target is never shown
    // — so the trigger addresses an element it does not reveal.
    const seg = diagramSeg();
    seg.triggers = [
      { atMs: 600, target: 'flow-node-gw', action: 'pulsePath', payload: { chain: ['flow-node-svc'] } },
      { atMs: 1200, target: 'flow-node-svc', action: 'revealNode' },
      { atMs: 1800, target: 'flow-edge-hop', action: 'drawEdge' },
    ];
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertFlags(run(dir), 'A3');
  });

  test('A3_nodeRevealedByPulsePathWithNoChain_isNotRefused', (t) => {
    // The fallback branch: no chain means `[tr.a]`, so the target IS shown.
    const seg = diagramSeg();
    seg.triggers = [
      { atMs: 600, target: 'flow-node-gw', action: 'pulsePath' },
      { atMs: 1200, target: 'flow-node-svc', action: 'revealNode' },
      { atMs: 1800, target: 'flow-edge-hop', action: 'drawEdge' },
    ];
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertClean(run(dir));
  });

  test('A3_nodeRevealedByMoveCursorWithNoToId_isNotRefused', (t) => {
    // `moveCursor` and `hover` differ, and the difference is in the DISPATCHER, not the
    // handler. `apply()`:935 calls `moveCursor(tr.a, (tr.payload&&tr.payload.toId)||tr.a)`
    // — the destination falls back to the target itself. `hover`:930 has no such fallback:
    // `const toId=tr.payload&&tr.payload.toId; if(toId)moveCursor(...)`.
    //
    // Treating the two alike refused a legitimate authored scene. Reading the handlers was
    // not enough here; the fallback is only visible at the call site.
    const seg = diagramSeg();
    seg.triggers = [
      { atMs: 600, target: 'flow-node-gw', action: 'moveCursor' },
      { atMs: 1200, target: 'flow-node-svc', action: 'revealNode' },
      { atMs: 1800, target: 'flow-edge-hop', action: 'drawEdge' },
    ];
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertClean(run(dir));
  });

  test('A3_nodeTargetedByMoveCursorThatResolvesToNothing_isRefused', (t) => {
    // The fallback is still a RESOLUTION, not a free pass: `moveCursor` returns at
    // `if(!c||!t)return` when either end is missing.
    const seg = diagramSeg();
    seg.triggers = [
      { atMs: 600, target: 'flow-node-gw', action: 'moveCursor', payload: { toId: 'flow-node-nope' } },
      { atMs: 1200, target: 'flow-node-svc', action: 'revealNode' },
      { atMs: 1800, target: 'flow-edge-hop', action: 'drawEdge' },
    ];
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertFlags(run(dir), 'A3');
  });

  test('A3_itemTargetedOnlyByCodeFocus_isRefused', (t) => {
    // `codeFocus`:904 does `const blk=el.closest('.codeblock'); if(!blk)return;` before any
    // `show()`. On a narrative card there is no code block, so it reveals nothing. The
    // non-release branch reveals only targets that live INSIDE a code block.
    const seg = narrativeSeg();
    seg.triggers = [{ atMs: 500, target: 'intro-item-0', action: 'codeFocus' }];
    const dir = makeProject(t, { 'timing.json': scene({ segments: [diagramSeg(), seg] }) });
    assertFlags(run(dir), 'A3');
  });

  test('D1_anInvalidPatternIsReportedWithoutEchoingItsSource', (t) => {
    // `new RegExp` puts the offending pattern into err.message, so forwarding that message
    // reintroduced the leak the index-only reporting had just closed — by the back door,
    // through the error path nobody looks at.
    const dir = makeProject(t, {
      // Unescaped dots on purpose: the point is that the SOURCE TEXT appears verbatim in
      // the error. An escaped `internal\.example\.com` reads as `example\.com`, which a
      // naive `/example\.com/` assertion does not match — so the first version of this
      // test passed while the leak it describes was wide open.
      'timing.json': scene({ project: { noGoPatterns: ['internal.example.com('] } }),
    });
    const r = run(dir);
    assertCleanExit(r, EXIT.USAGE);
    assert.doesNotMatch(r.all, /example\.com/, `the invalid-pattern error echoed the source\n${r.all}`);
    assert.match(r.all, /noGoPatterns\[0\]/, `it must still say which pattern\n${r.all}`);
  });

  test('catastrophicallyBacktrackingPattern_isStoppedByABoundedScan', (t) => {
    // `(a|aa){30}$` is 12 characters, so neither the length bound nor a nested-quantifier
    // heuristic touches it, and against a non-matching subject it backtracks exponentially.
    // Node cannot time-limit a regex in-process, so the scan runs under a real bound and
    // the refusal names the pattern that stalled it.
    const seg = diagramSeg();
    seg.voiceoverText = `${'a'.repeat(40)}b`;
    const dir = makeProject(t, {
      // The stalling pattern is deliberately NOT first. The stderr progress marker is a
      // running log, so a parser that takes the FIRST match names pattern 0 every time —
      // a precise-looking diagnosis that is wrong whenever it matters.
      'timing.json': scene({
        segments: [seg, narrativeSeg()],
        project: { noGoPatterns: ['PR \\d+', '(a|aa){30}$'] },
      }),
    });
    // At the ENGINE default budget: this test is about the bound firing, so overriding it
    // from the suite would change the very thing under test.
    const r = runAtDefaultBudget(dir);
    assertCleanExit(r, EXIT.USAGE);
    assert.match(r.all, /noGoPatterns\[1\]/, `the refusal must name the pattern that stalled\n${r.all}`);
  });

  test('groupedAlternationWithAQuantifier_isStillAccepted', (t) => {
    // `(foo|bar)+` is an ordinary, safe pattern that the nested-quantifier heuristic
    // refused. A regex guard that rejects everyday patterns gets switched off, and then
    // the no-go check is gone entirely.
    const dir = makeProject(t, {
      'timing.json': scene({ project: { noGoPatterns: ['(foo|bar)+', '(internal|staging)-host', 'PR \\d+'] } }),
    });
    assertClean(run(dir));
  });

  test('A3_edgeRevealedOnlyByRise_isStillRefused', (t) => {
    // DELIBERATELY STRICTER THAN THE RENDERER, and the divergence is recorded rather than
    // hidden: `reveal()` would make the edge VISIBLE, just never DRAWN. The spec's minimal
    // failing input for A3 is "edges declared with no drawEdge trigger", so an edge that
    // pops into existence undrawn is the defect this check was written for.
    const seg = diagramSeg();
    seg.triggers = [
      { atMs: 600, target: 'flow-node-gw', action: 'revealNode' },
      { atMs: 1200, target: 'flow-node-svc', action: 'revealNode' },
      { atMs: 1800, target: 'flow-edge-hop', action: 'rise' },
    ];
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertFlags(run(dir), 'A3');
  });

  test('A4_endpointRevealedByDrawEdge_isNotRefused', (t) => {
    // PUSH-BACK, pinned. Round 2 reported that counting `drawEdge` as an endpoint reveal
    // lets an edge be drawn toward an invisible node. The renderer disproves it:
    // write-build-html.mjs:895 `drawEdge(id)` calls `show(el)` BEFORE the path-specific
    // work, and `getTotalLength()` is inside a try/catch. Pointed at a node it reveals the
    // node. So the endpoint IS visible and refusing this would be a false positive.
    const seg = diagramSeg();
    seg.triggers = [
      { atMs: 600, target: 'flow-node-gw', action: 'revealNode' },
      { atMs: 700, target: 'flow-node-svc', action: 'drawEdge' }, // odd, but it does reveal
      { atMs: 1800, target: 'flow-edge-hop', action: 'drawEdge' },
    ];
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg, narrativeSeg()] }) });
    assertClean(run(dir));
  });

  test('C2_silentSegmentWithAudioDriftingFromItsWindow_isRefused', (t) => {
    // Exempting silent segments from the WORDS requirement is correct; exempting them from
    // the window-versus-clip comparison was not. A silent segment that carries a measured
    // clip must still describe the audio its window was solved from.
    const a = diagramSeg();
    a.audio = { file: 'segment_000.mp3', durationMs: 8000, words: [{ word: 'The', startMs: 0, endMs: 300 }] };
    const pause = {
      id: 'beat',
      startMs: 8000,
      endMs: 10000,
      silence: { reason: 'let the diagram land' },
      audio: { file: 'silence_000.mp3', durationMs: 4000 }, // 4000 against a 2000 ms window
    };
    const dir = makeProject(t, {
      'timing.json': scene({ segments: [a, pause] }),
      'calibration-observed.json': JSON.stringify({ aggregate: { observedEffWps: 3.4 } }),
    });
    assertFlags(run(dir), 'C2');
  });

  test('A1_footageSegmentWithFallbackContent_stillRefusesATargetNeitherBranchEmits', (t) => {
    // Pulling footage segments out of A1 entirely was too blunt. The clip's usability is
    // unknowable here, but the UNION of the two possible id sets is not — and a target in
    // neither branch is wrong under every outcome, so it can be refused with certainty.
    const seg = {
      id: 'clip',
      startMs: 0,
      endMs: 6000,
      voiceoverText: 'Here is the recording.',
      visual: {
        mode: 'footage',
        title: 'Recording',
        footage: { clipId: 'demo-001' },
        items: [{ label: 'Scope', text: 'The fallback content.' }],
      },
      triggers: [{ atMs: 400, target: 'clip-item-7', action: 'pop' }],
    };
    const dir = makeProject(t, { 'timing.json': scene({ segments: [seg] }) });
    assertFlags(run(dir), 'A1');
  });

  test('A1_footageSegment_acceptsATargetFromEitherBranch', (t) => {
    // The other half of the union: both the footage id and the fallback id are legitimate,
    // because either outcome is possible and this stage cannot tell which.
    const base = {
      id: 'clip',
      startMs: 0,
      endMs: 6000,
      voiceoverText: 'Here is the recording.',
      visual: { mode: 'footage', title: 'Recording', footage: { clipId: 'demo-001' }, items: [{ label: 'Scope', text: 'Fallback.' }] },
    };
    for (const target of ['clip-footage', 'clip-item-0']) {
      const seg = { ...base, triggers: [{ atMs: 400, target, action: 'pop' }] };
      const dir = makeProject(t, { 'timing.json': scene({ segments: [seg] }) });
      assertClean(run(dir), `target ${target}: `);
    }
  });

  test('noGoPatternBeyondTheLengthBound_isACallerError', (t) => {
    // A length bound is a weak control — `(a|aa){30}$` is twelve characters — but it is a
    // cheap one, and it bounds the cost of the scan that actually enforces the limit.
    const dir = makeProject(t, { 'timing.json': scene({ project: { noGoPatterns: ['a'.repeat(5000)] } }) });
    assertCleanExit(run(dir), EXIT.USAGE);
  });
});

// ---------------------------------------------------------------------------
// D1 · the no-go scan's timeout
//
// A TIMEOUT BOUNDS COST. IT DOES NOT ESTABLISH CAUSE. The stage already knows this
// about one failure shape and says so at validate-scene.mjs:710-715 — ENOBUFS also
// kills the child, so classifying by signal reported a buffer overflow as catastrophic
// backtracking and "sends the author to rewrite an innocent pattern". One branch later
// it committed the same error in a new direction: an ETIMEDOUT was asserted, flatly, to
// BE catastrophic backtracking.
//
// It is not. A child killed at the budget proves the scan did not finish; it says
// nothing about why. Measured on this repo's own suite under a 12-worker load, innocent
// scans crossed 5000 ms purely from CPU contention.
//
// THE POSITIVE CONTROL IS THIS FILE'S OWN FIXTURE. scene() ships
// noGoPatterns[2] = 'SAP path' — a LITERAL. No quantifier, no alternation, no
// backreference: structurally incapable of backtracking at all. A refusal that blames
// backtracking here is not merely unproven, it is false about a pattern that cannot do
// the thing it is accused of.
//
// So the contract these tests pin is: report the MEASUREMENT (what was bounded, where it
// stopped) and name every candidate cause WITH AN ACTION, rather than picking one and
// asserting it. That is the standard already stated for this engine's other guards at
// envelope-ducking.mjs:418-420 — "a guard that invents a cause is worse than one that
// reports a difference."
// ---------------------------------------------------------------------------

const runWithEnv = (dir, env, args = []) =>
  runScript('validate-scene.mjs', ['--project', dir, ...args], dir, { env });

/**
 * A pattern that really is expensive: a nested quantifier against a long non-matching run.
 *
 * Deliberately NOT `(a+)+$`. The refusal text names `(a+)+$` as a constant example of the
 * shape to look for, and `scanTimeout_neverPrintsThePatternSource` asserts the refusal does
 * not contain the project's pattern. With the two identical, that assertion could not tell
 * a real leak from the engine's own fixed example — it failed under load for exactly that
 * reason, and a leak check that cannot discriminate is worse than none.
 */
const PATHOLOGICAL = '(zz+)+$';
const PATHOLOGICAL_BAIT = 'z'.repeat(50) + 'q';

describe('D1 scan timeout: a bound on cost, not a diagnosis', () => {
  test('scanTimeout_withStructurallyInnocentPatterns_doesNotBlameBacktracking', (t) => {
    // Every pattern in scene() is innocent and [2] is a bare literal, so ANY backtracking
    // claim this run makes is provably wrong. The budget is driven to 1 ms to make the
    // timeout certain without depending on how loaded the machine is — the alternative,
    // a pattern tuned to straddle the default budget, is a wall-clock race.
    const dir = makeProject(t, { 'timing.json': scene() });
    const r = runWithEnv(dir, { [SCAN_TIMEOUT_KNOB]: '1' });
    assert.equal(r.code, EXIT.USAGE, `expected the unmeasurable scan to refuse as USAGE\n${r.all}`);
    // The word check below is an ABSENCE assertion, and any other USAGE refusal would
    // satisfy it without the timeout branch ever running. Pin the branch first.
    assert.match(r.all, /did not finish within 1 ms/, `expected the timeout refusal, not some other USAGE error\n${r.all}`);
    assert.ok(
      !/catastrophic|backtracking|exponential/i.test(r.all),
      `the scan was stopped, which does not establish WHY. These patterns cannot backtrack:\n${r.all}`,
    );
  });

  test('scanTimeout_namesContentionAndPattern_asCandidateCauses_withAnActionForEach', (t) => {
    // Both causes are live and this code cannot tell them apart. Naming one is a guess;
    // naming neither is a bound without a remedy. Name both, with what to do about each.
    const dir = makeProject(t, { 'timing.json': scene() });
    const r = runWithEnv(dir, { [SCAN_TIMEOUT_KNOB]: '1' });
    assert.match(r.all, /\bload\b|\bcontention\b|\bbusy\b/i, `expected the load cause to be named\n${r.all}`);
    assert.match(r.all, /pattern/i, `expected the pattern cause to be named\n${r.all}`);
    assert.match(
      r.all,
      new RegExp(SCAN_TIMEOUT_KNOB),
      `expected the raise-the-budget remedy to be actionable by name\n${r.all}`,
    );
  });

  test('scanTimeout_statesTheBudgetItExceeded', (t) => {
    const dir = makeProject(t, { 'timing.json': scene() });
    const r = runWithEnv(dir, { [SCAN_TIMEOUT_KNOB]: '1' });
    assert.match(r.all, /\b1 ms\b/, `expected the refusal to state the budget in force\n${r.all}`);
  });

  test('scanTimeout_doesNotReportItselfAsAnExternalSignal', (t) => {
    // The other half of the signal/timeout split. A child stopped by an EXTERNAL signal
    // gets a different refusal that makes no claim about cost, because this stage did not
    // stop it and measured nothing. This pins the classification from the side that CAN
    // be produced deterministically: a real budget timeout must take the budget branch and
    // not the signal one. If the two branches were merged back, this fails.
    const dir = makeProject(t, { 'timing.json': scene() });
    const r = runWithEnv(dir, { [SCAN_TIMEOUT_KNOB]: '1' });
    assert.match(r.all, /did not finish within 1 ms/, `expected the budget refusal\n${r.all}`);
    assert.ok(
      !/was stopped by/.test(r.all),
      `a scan stopped BY THIS BUDGET was reported as an external signal\n${r.all}`,
    );
  });

  test('scanTimeout_withAGenuinelyPathologicalPattern_stillNamesWhereItStopped', (t) => {
    // Direction A. The useful half of the old message must survive: an author needs the
    // index to act. What changes is that the index is reported as WHERE THE SCAN WAS when
    // it was stopped — a fact — rather than as the proven culprit.
    const dir = makeProject(t, {
      'timing.json': scene({ project: { noGoPatterns: [PATHOLOGICAL] }, segments: [
        { ...diagramSeg(), voiceoverText: PATHOLOGICAL_BAIT },
        narrativeSeg(),
      ] }),
    });
    const r = runAtDefaultBudget(dir);
    assert.equal(r.code, EXIT.USAGE, `expected a stopped scan to refuse as USAGE\n${r.all}`);
    assert.match(r.all, /within 5000 ms/, `expected the ENGINE default budget to be in force\n${r.all}`);
    assert.match(r.all, /noGoPatterns\[0\]/, `expected the in-flight pattern index\n${r.all}`);
    assert.ok(
      !/catastrophic|backtracking|exponential/i.test(r.all),
      `even when backtracking IS the cause, this code did not measure that\n${r.all}`,
    );
  });

  test('runAtDefaultBudget_withTheKnobExportedInTheParent_stillMeasuresTheEngineDefault', (t) => {
    // THE CONTROL FOR runAtDefaultBudget's CLEARING. runScript spreads process.env into
    // the child, so "pass no override" is NOT the same as "use the default": an operator
    // with the variable exported would have the default-budget tests quietly measuring
    // their number. Export a 1 ms budget here and assert 5000 is still what bounds the
    // run — if the clearing were inert this reports "within 1 ms" and fails.
    const previous = process.env[SCAN_TIMEOUT_KNOB];
    process.env[SCAN_TIMEOUT_KNOB] = '1';
    t.after(() => {
      if (previous === undefined) delete process.env[SCAN_TIMEOUT_KNOB];
      else process.env[SCAN_TIMEOUT_KNOB] = previous;
    });
    const dir = makeProject(t, {
      'timing.json': scene({
        project: { noGoPatterns: [PATHOLOGICAL] },
        segments: [{ ...diagramSeg(), voiceoverText: PATHOLOGICAL_BAIT }, narrativeSeg()],
      }),
    });
    const r = runAtDefaultBudget(dir);
    assert.match(r.all, /within 5000 ms/, `the exported budget leaked into a default-budget run\n${r.all}`);
  });

  test('scanTimeout_neverPrintsThePatternSource', (t) => {
    // scanMain() withholds the pattern and the match on purpose: a no-go pattern is as
    // sensitive as the string it hides. The timeout path must not become the leak.
    const dir = makeProject(t, {
      'timing.json': scene({ project: { noGoPatterns: [PATHOLOGICAL] }, segments: [
        { ...diagramSeg(), voiceoverText: PATHOLOGICAL_BAIT },
        narrativeSeg(),
      ] }),
    });
    const r = runAtDefaultBudget(dir);
    // Pin that this invocation actually REACHED the refusal. Both assertions below are
    // absence checks, and a scan that simply completed would satisfy them without ever
    // exercising the path under test — a test that passes for the wrong reason.
    assert.equal(r.code, EXIT.USAGE, `expected this run to reach the timeout refusal\n${r.all}`);
    assert.match(r.all, /within 5000 ms/, `expected the timeout refusal, not some other error\n${r.all}`);
    assert.ok(!r.all.includes(PATHOLOGICAL), `the pattern source leaked into the refusal\n${r.all}`);
    assert.ok(!r.all.includes(PATHOLOGICAL_BAIT), `the scanned text leaked into the refusal\n${r.all}`);
  });

  test('scanTimeoutKnob_raisingTheBudget_letsTheSameProjectPass', (t) => {
    // The remedy has to WORK, not merely be mentioned. Same project, same patterns: a
    // budget of 1 ms refuses it and the default budget clears it. Without this pair the
    // knob could be inert and the message would still read well.
    const dir = makeProject(t, { 'timing.json': scene(), 'knobs.json': knobs() });
    // The refusing half has to refuse FOR THE REASON UNDER TEST. A bare USAGE check would
    // be satisfied by any other refusal, and the pair would then prove nothing about the
    // budget: the "before" would be an unrelated error and the "after" merely a clean run.
    const refused = runWithEnv(dir, { [SCAN_TIMEOUT_KNOB]: '1' });
    assert.equal(refused.code, EXIT.USAGE, `expected a 1 ms budget to stop the scan\n${refused.all}`);
    assert.match(refused.all, /did not finish within 1 ms/, `expected the timeout refusal\n${refused.all}`);
    assertClean(runWithEnv(dir, { [SCAN_TIMEOUT_KNOB]: '60000' }));
  });

  test('scanTimeoutKnob_nonPositiveValue_isRefusedRatherThanIgnored', (t) => {
    // An unusable budget read as "use the default" is how a typo silently disables the
    // thing the operator was trying to set — the defect resolveBooleanKnob already names.
    const dir = makeProject(t, { 'timing.json': scene() });
    for (const bad of ['0', '-1', 'soon']) {
      const r = runWithEnv(dir, { [SCAN_TIMEOUT_KNOB]: bad });
      assert.equal(r.code, EXIT.USAGE, `expected ${JSON.stringify(bad)} to be refused\n${r.all}`);
      // Naming the variable does NOT discriminate here: the timeout refusal names it too,
      // as its raise-the-budget remedy. So assert the knob refusal's own words, otherwise
      // a value that was quietly read as the default and then timed out would pass this.
      assert.match(
        r.all,
        /must be a positive whole number of milliseconds/,
        `expected the knob to be refused outright, not read as the default\n${r.all}`,
      );
      assert.match(r.all, new RegExp(SCAN_TIMEOUT_KNOB), `expected the variable to be named\n${r.all}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Classifying HOW the scan child ended.
//
// These go through the exported classifier rather than a real run, because the case that
// matters here — an EXTERNAL kill, with a signal and no error — cannot be produced from a
// harness without polling the process table for a grandchild and racing to kill it. That
// is the load-sensitive test shape this domain removed earlier, so it is not reintroduced
// to test a six-line branch. The classifier is the seam; the reachable cases below are
// also asserted through it so the whole decision is covered by one mechanism.
// ---------------------------------------------------------------------------
describe('scan outcome classification: report the ending that happened', () => {
  const BUDGET = { ms: 5000, variable: SCAN_TIMEOUT_KNOB };
  const ok = { error: undefined, signal: null, status: 0, stdout: '[]', stderr: '' };

  const thrownBy = (result) => {
    try {
      classifyScanOutcome(result, BUDGET);
    } catch (err) {
      return err;
    }
    return null;
  };

  test('classify_externalSignalWithNoError_namesTheSignalAndClaimsNothingAboutCost', () => {
    const err = thrownBy({ ...ok, signal: 'SIGKILL', status: null });
    assert.ok(err, 'a child killed by an external signal must be refused, not read as success');
    assert.match(err.message, /stopped by SIGKILL/, err.message);
    // THE WHOLE POINT. This stage did not stop the child and timed nothing, so it must not
    // report a budget overrun -- the defect this change set exists to remove.
    assert.ok(!/did not finish within/.test(err.message), `an external kill was reported as a budget overrun\n${err.message}`);
    assert.ok(
      !/catastrophic|backtracking|exponential/i.test(err.message),
      `an external kill was blamed on a pattern\n${err.message}`,
    );
    // ...and it must not assert the complementary timing fact either. "The budget was not
    // reached" is just as unmeasured as "the budget was exceeded": nothing here read a clock.
    assert.ok(
      !/not reached|had not elapsed|before the budget/i.test(err.message),
      `the refusal asserted how much of the budget had elapsed, which nothing here measured\n${err.message}`,
    );
  });

  test('classify_externalSignal_namesNoPatternIndex', () => {
    // The timeout branch names an index because it has one. This branch has no deadline and
    // no in-flight marker it can trust, so naming an index would be an invention.
    const err = thrownBy({ ...ok, signal: 'SIGKILL', status: null, stderr: 'scanning 0\nscanning 1\n' });
    assert.ok(!/noGoPatterns\[/.test(err.message), `an external kill named a pattern index\n${err.message}`);
  });

  test('classify_timeout_isStillReportedAsABudgetOverrun', () => {
    const err = thrownBy({ ...ok, error: { code: 'ETIMEDOUT' }, signal: 'SIGTERM', status: null });
    assert.ok(err, 'a timeout must be refused');
    // A real timeout arrives WITH a signal set. It must take the budget branch regardless,
    // or the split would have broken the case it was meant to leave alone.
    assert.match(err.message, /did not finish within 5000 ms/, err.message);
    assert.ok(!/stopped by SIGTERM/.test(err.message), `a budget timeout was reported as an external kill\n${err.message}`);
  });

  test('classify_bufferOverflow_isReportedByItsErrorCode_notAsATimeout', () => {
    // The ordering this file already fixed once: ENOBUFS also kills the child, so it
    // arrives with a signal. Classify by error code first.
    const err = thrownBy({ ...ok, error: { code: 'ENOBUFS' }, signal: 'SIGTERM', status: null });
    assert.match(err.message, /could not run: ENOBUFS/, err.message);
    assert.ok(!/did not finish within/.test(err.message), `a buffer overflow was reported as a timeout\n${err.message}`);
  });

  test('classify_aCleanRun_isNotRefused', () => {
    // The control for all four refusals above: if this threw, they would pass for free.
    assert.equal(thrownBy(ok), null, 'a clean scan must not be refused');
  });
});