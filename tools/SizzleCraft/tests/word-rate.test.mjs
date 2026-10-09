// The word budget, the calibration key, and the difference between a guess and a measurement.
//
// Three defects met here, and they had to be fixed together:
//
//   1. `pick('wordsPerSecond')` looked for a TOP-LEVEL key. `voice.mjs` writes the rate
//      NESTED, at `aggregate.observedEffWps`. The lookup missed on every real project, so
//      the calibration file was read, parsed, validated — and silently discarded.
//
//   2. The budget compared `words / window` against that rate minus a 5% safety margin.
//      But `voice.mjs` sets each window FROM the measured audio, so `words / window` IS
//      the observed rate by construction. A margin hedges a GUESS; applied to a
//      MEASUREMENT it is a threshold set below the mean of the thing it measures, which
//      half the population must exceed by definition.
//
//   3. Repairing (1) alone is the most convincing wrong answer available: the budget then
//      compares a measurement against itself minus 5%, warnings drop from 4/4 to 2/4 on
//      the fixture below, and the wrongness moves from visible to plausible. Worse than
//      leaving it alone. `wordBudget_measuredWindowsAndMeasuredRate_isNotEvaluated` is the
//      test that fails for a key-only fix.
//
// The distinction that resolves it is not "is there a calibration file" but "is the
// reference rate a measurement OF THE SAME AUDIO that defines the windows":
//
//   measured rate + measured windows  -> self-comparison. No budget. Report variance.
//   measured rate + authored windows  -> a real prediction. Budget WITH margin.
//   estimate/default rate             -> a guess. Budget WITH margin.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { EXIT } from "../src/cli-support.mjs";
import { narrationFingerprint } from "../src/cli-support.mjs";
import {
  makeProject,
  runScript,
  timingFixture,
  contiguousSegments,
  assertCleanExit,
} from "./_helpers.mjs";
import { measuredProject } from "./_realistic-fixture.mjs";

/** Words, counted exactly as voice.mjs and validate-timing count them. */
const wordCount = (s) =>
  String(s ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

/**
 * Four segments straddling their own mean, with the spread the real project measured
 * (3.235 .. 3.797 wps). Two sit above the mean and two below — so a budget built from
 * that mean MUST flag the top half, which is the whole point.
 */
const REAL = measuredProject(
  [
    { id: "hard", words: 93, clipMs: 24936 },
    { id: "bdd", words: 68, clipMs: 20208 },
    { id: "scenario", words: 147, clipMs: 38808 },
    { id: "twotier", words: 62, clipMs: 19300 },
  ],
  { gapsMs: [1416, 1920, 1416] },
);

const realProject = (t, overrides = {}) =>
  makeProject(t, {
    "timing.json": JSON.stringify(REAL.timing),
    "calibration-observed.json": JSON.stringify(REAL.calibration),
    ...overrides,
  });

// ---------------------------------------------------------------------------
// 1. The key.
// ---------------------------------------------------------------------------
describe("calibration key resolution", () => {
  test("resolveWordRate_calibrationInTheShapeVoiceWrites_isActuallyUsed", (t) => {
    const dir = realProject(t);
    const r = runScript("validate-timing.mjs", ["--no-schema"], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(
      r.all,
      new RegExp(`word rate: ${REAL.observedEffWps}`),
      "the measured rate voice.mjs wrote must be the rate the budget reasons about",
    );
    assert.doesNotMatch(
      r.all,
      /source: default/,
      "a calibration file that was read, parsed and validated must not then be discarded",
    );
  });

  test("resolveWordRate_everyRun_namesTheRateAndWhereItCameFrom", (t) => {
    const dir = realProject(t);
    const r = runScript("validate-timing.mjs", ["--no-schema"], dir);

    // The defect survived for as long as it did because a silent fallback rendered
    // identically to a measurement. It must never again be possible to confuse them.
    assert.match(r.all, /MEASURED/, "the run must say the rate was measured");
    assert.match(
      r.all,
      /calibration-observed\.json/,
      "and name the file it came from",
    );
    assert.match(
      r.all,
      /aggregate\.observedEffWps/,
      "and the exact key, so a rename is visible",
    );
  });

  // The third state. The doc comment reasoned that "I could not read your calibration"
  // and "you have no calibration" are different facts — correct, but a THIRD state
  // existed that neither branch named: read fine, key never written. It rendered
  // identically to absent, which is exactly how this defect stayed invisible.
  // Keying the guard on the invariant (a calibration file must yield a rate) rather
  // than on the symptom (one particular key name) means a future rename in voice.mjs
  // surfaces here instead of silently reverting to the estimate.
  test("resolveWordRate_calibrationPresentButCarriesNoRate_failsRatherThanLookingAbsent", (t) => {
    const dir = realProject(t, {
      "calibration-observed.json": JSON.stringify({
        voiceId: "en-US-AvaNeural",
        roundedSpeed: 1.2,
        segments: [],
      }),
    });
    const r = runScript("validate-timing.mjs", ["--no-schema"], dir);

    assertCleanExit(
      r,
      EXIT.USAGE,
      'a calibration file that yields no rate must not render as "no calibration": ',
    );
    assert.match(
      r.all,
      /aggregate\.observedEffWps/,
      "the refusal must name the key it expected",
    );
  });

  test("resolveWordRate_calibrationRateNotANumber_failsRatherThanPassing", (t) => {
    const dir = realProject(t, {
      "calibration-observed.json": JSON.stringify({
        aggregate: { observedEffWps: "oops" },
      }),
    });
    const r = runScript(
      "validate-timing.mjs",
      ["--no-schema", "--strict"],
      dir,
    );

    assertCleanExit(
      r,
      EXIT.USAGE,
      "a NaN rate must not silently pass --strict: ",
    );
    assert.match(
      r.all,
      /observedEffWps/,
      "the failure must name the value that was invalid",
    );
  });
});
// ---------------------------------------------------------------------------
// 2. The budget. This is the group that a key-only fix cannot satisfy.
// ---------------------------------------------------------------------------
describe("word budget vs measured audio", () => {
  test("wordBudget_measuredWindowsAndMeasuredRate_isNotEvaluated", (t) => {
    const dir = realProject(t);
    const r = runScript("validate-timing.mjs", ["--no-schema"], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    // `hard` and `scenario` are above the mean, so BOTH the pre-fix estimate budget
    // (4/4 over) and a key-only fix (2/4 over) flag them. Neither is a defect: the
    // audio exists and fits its own window by construction.
    assert.doesNotMatch(
      r.all,
      /<-- OVER/,
      "a segment cannot overrun a window that was measured from it",
    );
    assert.doesNotMatch(
      r.all,
      /over the word budget/,
      "and must not be warned about as though it could",
    );
    assert.match(
      r.all,
      /word budget: NOT EVALUATED/,
      "the run must say the budget was skipped",
    );
  });

  test("wordBudget_measuredWindowsAndMeasuredRate_saysWhyItWasNotEvaluated", (t) => {
    const dir = realProject(t);
    const r = runScript("validate-timing.mjs", ["--no-schema"], dir);

    // A check that is silently skipped is indistinguishable from a check that passed.
    assert.match(r.all, /measured/i);
    assert.match(
      r.all,
      /by construction/i,
      "the reason must be stated, not left to the reader",
    );
  });

  test("wordBudget_measuredWindowsAndMeasuredRate_reportsRateVarianceInstead", (t) => {
    const dir = realProject(t);
    const r = runScript("validate-timing.mjs", ["--no-schema"], dir);

    // "hard is 4.1% above the mean rate" is true and actionable.
    // "hard is over budget" is false when the audio exists and fits.
    assert.match(r.all, /vs mean/, "the variance column must be present");
    assert.match(
      r.all,
      /hard\s+\S+\s+\S+\s+\S+\s+\+4\.1%/,
      `hard runs 4.1% above the measured mean\n${r.all}`,
    );
    assert.match(
      r.all,
      /twotier\s+\S+\s+\S+\s+\S+\s+-9\.8%/,
      `twotier runs 9.8% below it\n${r.all}`,
    );
  });

  test("wordBudget_strictWithMeasuredWindows_reportsThatThereIsNoBudgetToEnforce", (t) => {
    const dir = realProject(t);
    const r = runScript(
      "validate-timing.mjs",
      ["--no-schema", "--strict"],
      dir,
    );

    // --strict must not quietly become a no-op. It says so, and still exits 0 —
    // there is nothing here that is wrong.
    assert.equal(
      r.code,
      EXIT.OK,
      `measured audio that fits its own windows is not a failure\n${r.all}`,
    );
    assert.match(
      r.all,
      /--strict/,
      "--strict must account for itself rather than silently doing nothing",
    );
  });

  // The margin is legitimate where the number is still a guess. These two cases prove
  // the fix narrowed the budget rather than deleting it.
  test("wordBudget_authoredWindowsAndDefaultRate_stillAppliesTheMarginAndWarns", (t) => {
    const overBudget = [
      {
        id: "one",
        startMs: 0,
        endMs: 1000,
        voiceoverText:
          "far too many words for a single second of narration here",
      },
    ];
    const dir = makeProject(t, {
      "timing.json": timingFixture(overBudget),
    });
    const r = runScript("validate-timing.mjs", ["--no-schema"], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(r.all, /margin/, "a guess is still hedged");
    assert.match(
      r.all,
      /<-- OVER/,
      "and an authored window that cannot hold its words is still flagged",
    );
  });

  test("wordBudget_authoredWindowsAndMeasuredRate_stillAppliesTheBudget", (t) => {
    // A measured rate from a PREVIOUS run against FRESH authored windows is a real
    // prediction, not a self-comparison — so the budget and its margin still apply.
    const authored = [
      {
        id: "one",
        startMs: 0,
        endMs: 1000,
        voiceoverText:
          "far too many words for a single second of narration here",
      },
    ];
    const dir = makeProject(t, {
      "timing.json": timingFixture(authored),
      "calibration-observed.json": JSON.stringify(REAL.calibration),
    });
    const r = runScript(
      "validate-timing.mjs",
      ["--no-schema", "--strict"],
      dir,
    );

    assert.equal(
      r.code,
      EXIT.FAILED,
      `an authored window that cannot hold its words must still fail --strict\n${r.all}`,
    );
    assert.match(
      r.all,
      /AUTHORED/,
      "and the run must say the windows were estimates",
    );
    assert.match(
      r.all,
      /over the word budget/,
      "and fail FOR that reason, not an unrelated one",
    );
  });

  test("wordBudget_measuredWindowsAndDefaultRate_stillAppliesTheBudget", (t) => {
    // Measured windows against a PLANNING estimate is also a real comparison: it says
    // the audio came out faster than planned. Only measurement-against-itself is void.
    const dir = makeProject(t, {
      "timing.json": JSON.stringify(REAL.timing),
    });
    const r = runScript("validate-timing.mjs", ["--no-schema"], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(
      r.all,
      /source: default/,
      "no calibration file means the rate is still a guess",
    );
    assert.match(r.all, /<-- OVER/, "and a guess can be exceeded");
  });
});

// ---------------------------------------------------------------------------
// 2b. Lineage — the reason the suppression above is safe.
//
// `endMs - startMs === audio.durationMs` proves the windows came from SOME audio. It does
// NOT prove the calibration measures the text now in the file. Edit a segment's narration
// without re-running voice and both predicates still hold, so a suppression keyed on them
// alone waves through exactly the case the budget exists to catch: new text, stale audio.
// ---------------------------------------------------------------------------
describe("calibration lineage", () => {
  /** REAL, with one segment's narration rewritten and the audio left untouched. */
  const editedText = (t, { id, words, text }) => {
    const timing = structuredClone(REAL.timing);
    const seg = timing.segments.find((s) => s.id === id);
    seg.voiceoverText =
      text ?? Array.from({ length: words }, (_, i) => `newword${i}`).join(" ");
    return makeProject(t, {
      "timing.json": JSON.stringify(timing),
      "calibration-observed.json": JSON.stringify(REAL.calibration),
    });
  };

  test("wordBudget_textEditedWithoutRerunningVoice_isEvaluatedNotSuppressed", (t) => {
    // `hard` was measured at 93 words in a 24.936s window. At 200 words that window is a
    // stale prediction, not a measurement of this text — and the budget must fire.
    const dir = editedText(t, { id: "hard", words: 200 });
    const r = runScript("validate-timing.mjs", ["--no-schema"], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.doesNotMatch(
      r.all,
      /word budget: NOT EVALUATED/,
      "stale audio must not suppress the budget",
    );
    assert.match(
      r.all,
      /<-- OVER/,
      "the segment that no longer fits must be flagged",
    );
    assert.match(
      r.all,
      /calibration lineage: STALE/,
      "and the run must say why the rate is a prediction",
    );
    assert.match(
      r.all,
      /200 word\(s\); the calibration measured 93/,
      "naming both sides of the divergence",
    );
  });

  test("wordBudget_textEditedWithoutRerunningVoice_failsUnderStrict", (t) => {
    const dir = editedText(t, { id: "hard", words: 200 });
    const r = runScript(
      "validate-timing.mjs",
      ["--no-schema", "--strict"],
      dir,
    );

    assert.equal(
      r.code,
      EXIT.FAILED,
      `--strict must catch new text against stale audio\n${r.all}`,
    );
    assert.match(r.all, /over the word budget/, "and fail FOR that reason");
  });

  // A rewrite that preserves BOTH the word count and the character count. This is the
  // case `{words, chars, clipMs}` cannot see: "word0 word1 word2 word3" and
  // "other word1 word2 word3" agree on all three — 4 words, 23 chars, same clip — while
  // being different scripts needing different audio. Only the fingerprint separates them.
  //
  // The test this replaces appended "x" to every word, which moved the character count
  // from 23 to 27. It was named for the collision and exercised the adjacent case instead,
  // so it validated a weaker property than its name claimed.
  test("wordBudget_rewriteAtEqualWordAndCharCount_isStillDetectedAsStale", (t) => {
    const timing = structuredClone(REAL.timing);
    const seg = timing.segments.find((s) => s.id === "bdd");
    const before = seg.voiceoverText;
    const words = before.split(/\s+/);
    // "word0" -> "other": same five characters, different text.
    seg.voiceoverText = ["other", ...words.slice(1)].join(" ");

    assert.equal(
      seg.voiceoverText.split(/\s+/).length,
      words.length,
      "fixture must hold word count",
    );
    assert.equal(
      seg.voiceoverText.length,
      before.length,
      "fixture must hold character count",
    );
    assert.notEqual(seg.voiceoverText, before, "and still be different text");

    const dir = makeProject(t, {
      "timing.json": JSON.stringify(timing),
      "calibration-observed.json": JSON.stringify(REAL.calibration),
    });
    const r = runScript(
      "validate-timing.mjs",
      ["--no-schema", "--strict"],
      dir,
    );

    assert.match(
      r.all,
      /calibration lineage: STALE/,
      `an equal-length rewrite is still a different script\n${r.all}`,
    );
    assert.match(
      r.all,
      /does not match the fingerprint/,
      "and the fingerprint is what must catch it",
    );
    assert.doesNotMatch(
      r.all,
      /word budget: NOT EVALUATED/,
      "the budget must not be suppressed",
    );
  });

  // A calibration written before fingerprinting must not be read as proof of lineage.
  test("wordBudget_calibrationWithoutFingerprint_isUnprovenNotIntact", (t) => {
    const calibration = structuredClone(REAL.calibration);
    for (const c of calibration.segments) delete c.textHash;
    const dir = makeProject(t, {
      "timing.json": JSON.stringify(REAL.timing),
      "calibration-observed.json": JSON.stringify(calibration),
    });
    const r = runScript("validate-timing.mjs", ["--no-schema"], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.doesNotMatch(
      r.all,
      /word budget: NOT EVALUATED/,
      "suppression requires positive proof of lineage",
    );
    assert.match(r.all, /no narration fingerprint/);
    assert.match(
      r.all,
      /UNPROVEN/,
      "and it must be named as unproven, not as a mismatch",
    );
  });

  test("wordBudget_segmentsReordered_isDetectedAsStale", (t) => {
    const timing = structuredClone(REAL.timing);
    // Swap the narration of two segments, leaving every window and duration untouched.
    const a = timing.segments[0],
      b = timing.segments[1];
    [a.id, b.id] = [b.id, a.id];
    const dir = makeProject(t, {
      "timing.json": JSON.stringify(timing),
      "calibration-observed.json": JSON.stringify(REAL.calibration),
    });
    const r = runScript("validate-timing.mjs", ["--no-schema"], dir);

    assert.match(r.all, /calibration lineage: STALE/, r.all);
    assert.match(
      r.all,
      /renamed or reordered/,
      "the same segments in a different order is a different video",
    );
  });

  // The id comparison must be positional, not a joined string. `["a\0b", "c"]` and
  // `["a", "b\0c"]` join to the identical delimiter-separated string, and the schema
  // permits both id forms — so a joined comparison reports lineage intact across a rename.
  test("wordBudget_idsCollidingUnderADelimiterJoin_areStillDetected", (t) => {
    const text = "identical narration in both segments";
    const clipMs = 4000;
    const mkSeg = (id, startMs) => ({
      id,
      startMs,
      endMs: startMs + clipMs,
      voiceoverText: text,
      audio: {
        file: `${id}.mp3`,
        durationMs: clipMs,
        headMs: 240,
        tailMs: 264,
        words: [],
      },
    });
    // Timeline ids and calibration ids differ, but join to the same string.
    const timing = {
      project: { name: "demo", fps: 30, width: 1280, height: 720 },
      durationMs: 10000,
      contentMs: 10000,
      segments: [mkSeg("a", 0), mkSeg("b\u0000c", 6000)],
    };
    const calSeg = (id) => ({
      id,
      words: wordCount(text),
      chars: text.length,
      clipMs,
      speechMs: clipMs - 504,
      effWps: 3,
      textHash: narrationFingerprint(text),
    });
    const calibration = {
      voiceId: "en-US-AvaNeural",
      roundedSpeed: 1.2,
      aggregate: {
        words: 2 * wordCount(text),
        speechMs: 2 * (clipMs - 504),
        observedEffWps: 3,
        observedSafeWps: 2.5,
      },
      segments: [calSeg("a\u0000b"), calSeg("c")],
    };

    assert.equal(
      timing.segments.map((s) => s.id).join("\u0000"),
      calibration.segments.map((c) => c.id).join("\u0000"),
      "fixture must actually collide under a joined comparison, or it proves nothing",
    );

    const dir = makeProject(t, {
      "timing.json": JSON.stringify(timing),
      "calibration-observed.json": JSON.stringify(calibration),
    });
    const r = runScript("validate-timing.mjs", ["--no-schema"], dir);

    assert.match(
      r.all,
      /calibration lineage: STALE/,
      `a join is not injective — ids must be compared one at a time\n${r.all}`,
    );
    assert.doesNotMatch(
      r.all,
      /word budget: NOT EVALUATED/,
      "suppression must not claim proof it does not have",
    );
  });

  test("wordBudget_segmentAddedSinceVoiceRan_isDetectedAsStale", (t) => {
    const timing = structuredClone(REAL.timing);
    const last = timing.segments.at(-1);
    timing.segments.push({
      id: "newbie",
      startMs: last.endMs + 1416,
      endMs: last.endMs + 1416 + 5000,
      voiceoverText: "a segment the voice stage has never seen",
      audio: {
        file: "segment_05.mp3",
        durationMs: 5000,
        headMs: 240,
        tailMs: 264,
        words: [],
      },
    });
    const dir = makeProject(t, {
      "timing.json": JSON.stringify(timing),
      "calibration-observed.json": JSON.stringify(REAL.calibration),
    });
    const r = runScript("validate-timing.mjs", ["--no-schema"], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(r.all, /calibration lineage: STALE/);
    assert.match(r.all, /5 segment\(s\) but the calibration measured 4/);
  });

  test("wordBudget_untouchedProject_hasIntactLineageAndKeepsTheSuppression", (t) => {
    // The control. Without it, the four tests above would pass if lineage NEVER held.
    const dir = realProject(t);
    const r = runScript("validate-timing.mjs", ["--no-schema"], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.doesNotMatch(
      r.all,
      /STALE/,
      "an unedited project must not be reported stale",
    );
    assert.match(r.all, /word budget: NOT EVALUATED/);
  });
});
// ---------------------------------------------------------------------------
// 3. The margin is an authoring input. It is not, and has never been, an observable.
// ---------------------------------------------------------------------------
describe("safety margin provenance", () => {
  test("resolveWordRate_configuredMarginNotAppliedToAMeasurement_saysSo", (t) => {
    // A configured value that is silently ignored is the same class of defect as a
    // calibration file that is silently discarded: the author believes it is in force.
    const dir = makeProject(t, {
      "timing.json": JSON.stringify({
        ...REAL.timing,
        intake: { wpsSafetyMargin: 0.9 },
      }),
      "calibration-observed.json": JSON.stringify(REAL.calibration),
    });
    const r = runScript("validate-timing.mjs", ["--no-schema"], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(
      r.all,
      /wpsSafetyMargin \(0\.9\) is NOT applied/,
      "a configured value that is ignored must say so",
    );
  });

  test("resolveWordRate_marginInCalibrationFile_isNotConsultedThere", (t) => {
    // `voice.mjs` writes no margin-like key at any depth — `observedSafeWps` is the rate
    // normalised to 1.0x speed (effWps / roundedSpeed), not a margin. timing-schema.json
    // declares wpsSafetyMargin under `intake` only. So the calibration file is not a
    // place a margin can come from, and looking for one there is the same mistake in a
    // second location.
    const dir = makeProject(t, {
      "timing.json": timingFixture(contiguousSegments),
      "calibration-observed.json": JSON.stringify({
        aggregate: { observedEffWps: 3 },
        wpsSafetyMargin: "this is not a place a margin comes from",
      }),
    });
    const r = runScript("validate-timing.mjs", ["--no-schema"], dir);

    assert.equal(
      r.code,
      EXIT.OK,
      `a stray key in the calibration file must not be read as the margin\n${r.all}`,
    );
  });
});
