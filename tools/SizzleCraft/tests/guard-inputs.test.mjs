// Guards fed unvalidated input.
//
// Round 1 was no guards. Round 2 was guards in the wrong place. This suite covers the
// third shape: a correct check reached through a value nobody checked.
//
//   NaN, undefined, an empty array, a link target, a duplicate normalised path, and an
//   unparsed subprocess line are one property — a check is only as good as the value it
//   is given.
//
// None of these were reachable until the checks existed, which is why they surface now.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import {
  EXIT,
  CliError,
  createBoundary,
  readLockOwner,
} from "../src/cli-support.mjs";
import { videoStreamVerdict } from "../src/remux-verify.mjs";
import {
  makeProject,
  makeOutsideDir,
  runScript,
  timingFixture,
  contiguousSegments,
  wordedSegments,
  brandTokens,
  tryMakeDirLink,
  tryMakeFileLink,
  BLOCK_PLAYWRIGHT,
  assertCleanExit,
  runScriptDeletingOnMarker,
  makeEngineCopy,
  operableProject,
  runEngineScript,
  runScriptPlantingOnMarker,
  footageProject,
  probeFootageFrames,
  gsapStubWithout,
} from "./_helpers.mjs";

const SENTINEL = "SENTINEL — MUST SURVIVE";
const captureFiles = {
  "video-auto.html": '<html><body><div id="stage"></div></body></html>',
};

// ---------------------------------------------------------------------------
// frame-capture: the containment check permits an IN-ROOT link, but the value it
// guards is a recursive delete. In-root is not the same as safe-to-delete.
// ---------------------------------------------------------------------------
describe("frame-capture deletion target", () => {
  test("frameCapture_framesLinkedToProjectRoot_refusesWithoutDeleting", (t) => {
    const dir = makeProject(t, {
      ...captureFiles,
      "timing.json": timingFixture(),
      "keepme.txt": SENTINEL,
    });
    if (!tryMakeDirLink(path.join(dir, "frames"), dir))
      return t.skip("platform refused to create a directory link");

    const r = runScript("frame-capture.mjs", ["--apply"], dir);

    assertCleanExit(
      r,
      EXIT.USAGE,
      "deleting through a link to the project root must be refused: ",
    );
    assert.equal(
      fs.readFileSync(path.join(dir, "keepme.txt"), "utf8"),
      SENTINEL,
    );
    assert.equal(
      fs.existsSync(path.join(dir, "timing.json")),
      true,
      "the project root must still be intact",
    );
  });

  test("frameCapture_framesLinkedToAnotherInRootDirectory_refusesWithoutDeleting", (t) => {
    const dir = makeProject(t, {
      ...captureFiles,
      "timing.json": timingFixture(),
      "assets/precious.bin": SENTINEL,
    });
    if (!tryMakeDirLink(path.join(dir, "frames"), path.join(dir, "assets"))) {
      return t.skip("platform refused to create a directory link");
    }

    const r = runScript("frame-capture.mjs", ["--apply"], dir);

    assertCleanExit(
      r,
      EXIT.USAGE,
      "the wipe target must be the real frames directory: ",
    );
    assert.equal(
      fs.readFileSync(path.join(dir, "assets", "precious.bin"), "utf8"),
      SENTINEL,
    );
  });

  test("frameCapture_framesLinkedInRoot_refusedOnAPlanRunToo", (t) => {
    const dir = makeProject(t, {
      ...captureFiles,
      "timing.json": timingFixture(),
      "assets/x.bin": "x",
    });
    if (!tryMakeDirLink(path.join(dir, "frames"), path.join(dir, "assets"))) {
      return t.skip("platform refused to create a directory link");
    }

    const r = runScript("frame-capture.mjs", [], dir);

    assertCleanExit(
      r,
      EXIT.USAGE,
      "a plan cannot honestly describe deleting a link target: ",
    );
  });

  test("frameCapture_planWithOnlyAnEmptySubdirectory_doesNotReportNone", (t) => {
    const dir = makeProject(t, {
      ...captureFiles,
      "timing.json": timingFixture(),
    });
    fs.mkdirSync(path.join(dir, "frames", "stills"), { recursive: true });

    const r = runScript("frame-capture.mjs", [], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.doesNotMatch(
      r.all,
      /existing\s+none/,
      `--apply removes the directory recursively, so an empty subdirectory is in scope\n${r.all}`,
    );
    assert.match(
      r.all,
      /stills/,
      "the plan should name the directory it would delete",
    );
  });

  test("frameCapture_applyWithUnloadablePlaywright_preservesFrames", (t) => {
    // A real module-resolution failure, in isolation. The previous version of this test
    // installed a live lock, which stops the run BEFORE the import for a different
    // reason — so it could not detect a regression moving the wipe ahead of the import.
    const dir = makeProject(t, {
      ...captureFiles,
      "timing.json": timingFixture(),
      "frames/frame_00000.png": SENTINEL,
    });

    const r = runScript("frame-capture.mjs", ["--apply"], dir, {
      nodeArgs: ["--import", BLOCK_PLAYWRIGHT],
    });

    assertCleanExit(r, EXIT.USAGE, "a missing browser dependency must fail: ");
    assert.equal(
      fs.readFileSync(path.join(dir, "frames", "frame_00000.png"), "utf8"),
      SENTINEL,
      "the dependency must fail while the frames are still on disk",
    );
  });
});

// ---------------------------------------------------------------------------
// remux-verify: extracted so the mismatch branch could be tested, and it inherited
// the defect — equality of two unvalidated strings is not the property.
// ---------------------------------------------------------------------------
describe("video stream verdict input validation", () => {
  const MD5_A = "MD5=0123456789abcdef0123456789abcdef";
  const MD5_B = "MD5=fedcba9876543210fedcba9876543210";

  test("videoStreamVerdict_wellFormedEqualDigests_passes", () => {
    const v = videoStreamVerdict(MD5_A, MD5_A, "out.mp4");
    assert.equal(v.identical, true);
    assert.equal(v.exitCode, EXIT.OK);
  });

  test("videoStreamVerdict_wellFormedDifferentDigests_fails", () => {
    const v = videoStreamVerdict(MD5_A, MD5_B, "out.mp4");
    assert.equal(v.identical, false);
    assert.equal(v.exitCode, EXIT.FAILED);
    assert.match(v.message, /CHANGED/);
  });

  test("videoStreamVerdict_equalButMalformedOutput_failsRatherThanDeclaringIdentical", () => {
    // Two equal strings are not evidence that either MD5 was computed.
    for (const junk of [
      "oops",
      "",
      "MD5=",
      "MD5=zzzz",
      "0123456789abcdef0123456789abcdef",
    ]) {
      const v = videoStreamVerdict(junk, junk, "out.mp4");
      assert.equal(
        v.identical,
        false,
        `${JSON.stringify(junk)} must not be accepted as a digest`,
      );
      assert.equal(v.exitCode, EXIT.FAILED);
    }
  });

  test("videoStreamVerdict_oneSideMalformed_fails", () => {
    assert.equal(videoStreamVerdict(MD5_A, "oops", "out.mp4").identical, false);
    assert.equal(videoStreamVerdict("oops", MD5_A, "out.mp4").identical, false);
  });

  test("videoStreamVerdict_surroundingWhitespaceAndCase_stillCompares", () => {
    assert.equal(
      videoStreamVerdict(`${MD5_A}\n`, ` ${MD5_A.toUpperCase()} `, "out.mp4")
        .identical,
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Final write targets: the boundary was applied to the output DIRECTORY, not to the
// path actually written.
// ---------------------------------------------------------------------------
describe("final write target confinement", () => {
  test("voice_segmentTargetLinkedOutsideRoot_refusesAndPreservesVictim", (t) => {
    const dir = makeProject(t, {
      "timing.json": timingFixture(),
      "brand/tokens.json": brandTokens,
      "voiceover.mp3": "vo",
    });
    const outside = makeOutsideDir(t, { "victim.mp3": SENTINEL });
    if (
      !tryMakeFileLink(
        path.join(dir, "segment_01.mp3"),
        path.join(outside, "victim.mp3"),
      )
    ) {
      return t.skip("platform refused to create a file link");
    }

    const r = runScript("voice.mjs", ["--apply", "--replace"], dir);

    assertCleanExit(
      r,
      EXIT.USAGE,
      "a segment target escaping the root must be refused: ",
    );
    assert.equal(
      fs.readFileSync(path.join(outside, "victim.mp3"), "utf8"),
      SENTINEL,
    );
  });

  test("preview_screenshotTargetLinkedOutsideRoot_refusesAndPreservesVictim", (t) => {
    const dir = makeProject(t, {
      "timing.json": timingFixture(),
      "video-auto.html": '<html><body><div id="stage"></div></body></html>',
      "preview/.keep": "",
    });
    const outside = makeOutsideDir(t, { "victim.png": SENTINEL });
    if (
      !tryMakeFileLink(
        path.join(dir, "preview", "one.png"),
        path.join(outside, "victim.png"),
      )
    ) {
      return t.skip("platform refused to create a file link");
    }

    const r = runScript("preview.mjs", ["--apply", "--replace"], dir);

    assertCleanExit(
      r,
      EXIT.USAGE,
      "a screenshot target escaping the root must be refused: ",
    );
    assert.equal(
      fs.readFileSync(path.join(outside, "victim.png"), "utf8"),
      SENTINEL,
    );
  });

  test("voice_segmentTargetExistsWithoutReplace_refuses", (t) => {
    // Proves the per-segment destinations are preflighted at all, independent of links.
    const dir = makeProject(t, {
      "timing.json": timingFixture(),
      "brand/tokens.json": brandTokens,
      "segment_01.mp3": SENTINEL,
    });
    const r = runScript("voice.mjs", ["--apply"], dir);

    assert.equal(r.code, EXIT.USAGE, r.all);
    assert.equal(
      fs.readFileSync(path.join(dir, "segment_01.mp3"), "utf8"),
      SENTINEL,
    );
  });
});

// ---------------------------------------------------------------------------
// Duplicate normalised destinations: two valid inputs, one file.
// ---------------------------------------------------------------------------
describe("distinct output destinations", () => {
  test("preview_segmentIdNamedEndcard_isRefusedRatherThanOverwritingSilently", (t) => {
    const segments = [
      {
        id: "endcard",
        startMs: 0,
        endMs: 2000,
        voiceoverText: "collides with the end-card shot",
      },
    ];
    const dir = makeProject(t, {
      "timing.json": timingFixture(segments),
      "video-auto.html": '<html><body><div id="stage"></div></body></html>',
    });

    const r = runScript("preview.mjs", ["--apply"], dir);

    assert.equal(
      r.code,
      EXIT.USAGE,
      `two shots writing one path must be refused, got ${r.code}\n${r.all}`,
    );
  });

  test("previewSeg_fractionsRoundingToTheSameFilename_areRefused", (t) => {
    const dir = makeProject(t, {
      "timing.json": timingFixture(),
      "video-auto.html": '<html><body><div id="stage"></div></body></html>',
    });

    // 0.501 and 0.504 both round to 50.
    const r = runScript(
      "preview-seg.mjs",
      ["--id", "one", "--at", "0.501,0.504", "--apply"],
      dir,
    );

    assert.equal(
      r.code,
      EXIT.USAGE,
      `distinct fractions must not collapse to one file\n${r.all}`,
    );
  });

  test("previewSeg_distinctFractions_arePermitted", (t) => {
    const dir = makeProject(t, {
      "timing.json": timingFixture(),
      "video-auto.html": '<html><body><div id="stage"></div></body></html>',
    });
    const r = runScript(
      "preview-seg.mjs",
      ["--id", "one", "--at", "0.5,0.9"],
      dir,
    );

    assert.equal(r.code, EXIT.OK, r.all);
  });
});

// ---------------------------------------------------------------------------
// validate-timing: the threshold that decides the check arrived as NaN, so even
// --strict could not fail. The verifier-that-cannot-fail, a third time.
// ---------------------------------------------------------------------------
describe("calibration input validation", () => {
  const overBudget = [
    {
      id: "one",
      startMs: 0,
      endMs: 1000,
      voiceoverText: "far too many words for a single second of narration here",
    },
  ];

  // The fixtures below deliberately match `voice.mjs`'s OWN output shape
  // (`aggregate.observedEffWps`, nested). They used to hand-write
  // `{ wordsPerSecond, wpsSafetyMargin }` at the top level — a shape voice.mjs has never
  // emitted. Those tests passed while the reader they "covered" missed on every real
  // project, which is precisely how the defect survived: when the red and the green come
  // from different bodies, the red proves nothing about what ships.
  // `tests/_realistic-fixture.mjs` builds the real shape; see `tests/word-rate.test.mjs`.
  test("validateTiming_calibrationRateNotANumber_failsRatherThanPassing", (t) => {
    const dir = makeProject(t, {
      "timing.json": timingFixture(overBudget),
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
      "a NaN budget must not silently pass --strict: ",
    );
  });

  test("validateTiming_intakeMarginNotANumber_failsRatherThanPassing", (t) => {
    // Deliberately WITHIN budget and contiguous: the only thing that can fail this run is
    // the margin guard, so a pass cannot be mistaken for the budget check firing.
    // The margin lives in `intake` — timing-schema.json declares it there and nowhere
    // else, and it is an authoring hedge rather than something that can be observed.
    const dir = makeProject(t, {
      "timing.json": timingFixture(contiguousSegments, {
        intake: { wpsSafetyMargin: null },
      }),
      "calibration-observed.json": JSON.stringify({
        aggregate: { observedEffWps: 3 },
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
      "a present-but-null margin must not silently take the default: ",
    );
    assert.match(
      r.all,
      /wpsSafetyMargin/,
      "the failure must name the value that was invalid",
    );
  });

  test("validateTiming_calibrationFileMalformed_failsRatherThanFallingBack", (t) => {
    const dir = makeProject(t, {
      "timing.json": timingFixture(contiguousSegments),
      "calibration-observed.json": "{ not json",
    });
    const r = runScript("validate-timing.mjs", ["--no-schema"], dir);

    assertCleanExit(
      r,
      EXIT.USAGE,
      "only an ABSENT calibration file may be ignored: ",
    );
  });

  test("validateTiming_calibrationFileAbsent_usesTheDefaultAndPasses", (t) => {
    const dir = makeProject(t, {
      "timing.json": timingFixture(contiguousSegments),
    });
    const r = runScript("validate-timing.mjs", ["--no-schema"], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(r.all, /source: default/);
  });

  test("validateTiming_validCalibration_isUsed", (t) => {
    const dir = makeProject(t, {
      "timing.json": timingFixture(contiguousSegments),
      "calibration-observed.json": JSON.stringify({
        voiceId: "en-US-AvaNeural",
        roundedSpeed: 1.2,
        aggregate: {
          words: 370,
          speechMs: 101236,
          observedEffWps: 3.655,
          observedSafeWps: 3.046,
        },
        segments: [],
      }),
    });
    const r = runScript("validate-timing.mjs", ["--no-schema"], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(r.all, /calibration-observed\.json/);
  });
});

// ---------------------------------------------------------------------------
// Drift tolerances: an unparseable toleranceMs makes `drift > NaN` false, disabling
// the comparison entirely.
// ---------------------------------------------------------------------------
describe("drift tolerance validation", () => {
  test("voice_nonNumericToleranceMs_exitsUsageError", (t) => {
    const dir = makeProject(t, {
      "timing.json": timingFixture(contiguousSegments, {
        intake: {
          leadInMs: 2000,
          perceivedGapMs: 2000,
          toleranceMs: "oops",
          voice: "en-US-AvaNeural",
          speed: 1,
          silenceMs: 2000,
        },
      }),
      "brand/tokens.json": brandTokens,
    });
    const r = runScript("voice.mjs", [], dir);

    assert.equal(
      r.code,
      EXIT.USAGE,
      `a NaN tolerance disables the drift check entirely\n${r.all}`,
    );
  });

  test("remix_nonNumericToleranceMs_exitsUsageError", (t) => {
    const dir = makeProject(t, {
      "timing.json": timingFixture(contiguousSegments, {
        intake: { leadInMs: 2000, perceivedGapMs: 2000, toleranceMs: "oops" },
      }),
    });
    const r = runScript("remix.mjs", [], dir);

    assert.equal(r.code, EXIT.USAGE, r.all);
  });
});

// ---------------------------------------------------------------------------
// make-music: an empty envelope produced undefined gains, NaN samples, and a
// "success" that replaced a good bed with silence-shaped garbage.
// ---------------------------------------------------------------------------

/**
 * The input fingerprint an envelope must carry to be usable.
 *
 * An envelope is bound to the audio it MEASURED, so a consumer can tell whether it still
 * describes the narration in play — a stale one parses perfectly and ducks against a cut
 * that no longer exists. Computed here rather than pasted, so these fixtures stay valid
 * envelopes instead of becoming a second, divergent idea of one.
 */
const boundTo = (voice) => ({
  file: "voiceover.mp3",
  bytes: voice.length,
  sha256: crypto.createHash("sha256").update(voice).digest("hex"),
});

describe("envelope input validation", () => {
  // EACH FIXTURE REACHES THE CHECK IT IS NAMED FOR. These three used to carry no binding
  // and no voiceover.mp3, so all three stopped at "voice track not found" — exit 2, the
  // code they asserted — and deleting the rms validation left them green. Each is now
  // bound to narration on disk, and each asserts the rms refusal itself.
  const voice = Buffer.from("narration bytes");
  const boundEnvelopeProject = (t, envelope) =>
    makeProject(t, {
      "voiceover.mp3": voice,
      "env.json": JSON.stringify({ ...envelope, measuredFrom: boundTo(voice) }),
    });

  test("makeMusic_envelopeWithEmptyRms_refusesBeforeWriting", (t) => {
    const dir = boundEnvelopeProject(t, { rms: [] });
    const r = runScript(
      "make-music.mjs",
      [
        "--out",
        "bed.wav",
        "--seconds",
        "2",
        "--envelope",
        "env.json",
        "--apply",
      ],
      dir,
    );

    assertCleanExit(
      r,
      EXIT.USAGE,
      "an empty envelope must not produce NaN samples: ",
    );
    assert.match(
      r.stderr,
      /has an empty "rms" array/,
      "and the refusal must be the rms check, not an earlier one",
    );
    assert.equal(fs.existsSync(path.join(dir, "bed.wav")), false);
  });

  test("makeMusic_envelopeWithNonNumericSamples_refusesBeforeWriting", (t) => {
    const dir = boundEnvelopeProject(t, { rms: [0.1, "x", 0.2] });
    const r = runScript(
      "make-music.mjs",
      [
        "--out",
        "bed.wav",
        "--seconds",
        "2",
        "--envelope",
        "env.json",
        "--apply",
      ],
      dir,
    );

    assertCleanExit(
      r,
      EXIT.USAGE,
      "a non-numeric envelope sample must be refused: ",
    );
    assert.match(
      r.stderr,
      /"rms"\[1\] is "x"/,
      "the refusal must name the sample",
    );
    assert.match(
      r.stderr,
      /finite non-negative number/,
      "and the rule it breaks",
    );
    assert.equal(fs.existsSync(path.join(dir, "bed.wav")), false);
  });

  test("makeMusic_envelopeMissingRmsArray_refusesBeforeWriting", (t) => {
    const dir = boundEnvelopeProject(t, { durationMs: 100 });
    const r = runScript(
      "make-music.mjs",
      [
        "--out",
        "bed.wav",
        "--seconds",
        "2",
        "--envelope",
        "env.json",
        "--apply",
      ],
      dir,
    );

    assertCleanExit(
      r,
      EXIT.USAGE,
      "an envelope without an rms array must be refused: ",
    );
    assert.match(
      r.stderr,
      /must contain an "rms" array/,
      "and the refusal must be the rms check",
    );
    assert.equal(fs.existsSync(path.join(dir, "bed.wav")), false);
  });

  test("makeMusic_validEnvelope_writesFiniteSamples", (t) => {
    const rms = Array.from({ length: 120 }, (_, i) =>
      i % 20 < 10 ? 0.2 : 0.001,
    );
    const voice = Buffer.from("narration bytes");
    const dir = makeProject(t, {
      "voiceover.mp3": voice,
      "env.json": JSON.stringify({
        rms,
        hopMs: 20,
        durationMs: 2400,
        measuredFrom: boundTo(voice),
      }),
    });
    const r = runScript(
      "make-music.mjs",
      [
        "--out",
        "bed.wav",
        "--seconds",
        "2",
        "--envelope",
        "env.json",
        "--apply",
      ],
      dir,
    );

    assert.equal(r.code, EXIT.OK, r.all);
    const buf = fs.readFileSync(path.join(dir, "bed.wav"));
    for (let o = 44; o + 4 <= buf.length; o += 4) {
      assert.ok(Number.isFinite(buf.readFloatLE(o)), `NaN sample at byte ${o}`);
    }
  });
});

// ---------------------------------------------------------------------------
// The guard handler gaps: CliError thrown at module scope above `guard`.
// ---------------------------------------------------------------------------
describe("module-scope failures use the documented exit codes", () => {
  for (const script of ["voice.mjs", "remix.mjs", "frame-capture.mjs"]) {
    test(`${script.replace(".mjs", "")}_missingTimingFile_exitsUsageNotAnUncaughtStack`, (t) => {
      const dir = makeProject(t, { "brand/tokens.json": brandTokens });
      const r = runScript(script, [], dir);

      assert.equal(
        r.code,
        EXIT.USAGE,
        `expected the documented usage exit, got ${r.code}\n${r.all}`,
      );
      assert.doesNotMatch(
        r.all,
        /^\s*at .*\(.*:\d+:\d+\)/m,
        "a missing prerequisite must not surface as a stack trace",
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Sweep findings: "for every guard, what value decides it, and is that value
// validated?" These are the guards whose deciding value was still unchecked.
// ---------------------------------------------------------------------------
describe("sweep: values that decide a guard", () => {
  const captureProject = (t, extra = {}) =>
    makeProject(t, {
      ...captureFiles,
      "timing.json": timingFixture(),
      "frames/frame_00000.png": SENTINEL,
      ...extra,
    });

  test("frameCapture_lockFileWithUnparseablePid_skipsRatherThanStealingTheLock", (t) => {
    // `Number('not-a-pid')` is NaN, `!NaN` is true, so the lock was declared stale and
    // taken over — the single-writer guard defeated by the value that decides it.
    const dir = captureProject(t, { "frames.lock": "not-a-pid" });

    const r = runScript("frame-capture.mjs", ["--apply"], dir);

    assert.equal(
      r.code,
      EXIT.SKIPPED,
      `an unreadable lock owner must not be assumed dead\n${r.all}`,
    );
    assert.equal(
      fs.readFileSync(path.join(dir, "frames", "frame_00000.png"), "utf8"),
      SENTINEL,
    );
  });

  test("encodeMp4_lockFileWithUnparseablePid_skipsRatherThanStealingTheLock", (t) => {
    const dir = makeProject(t, {
      "timing.json": timingFixture(),
      "frames/frame_00000.png": "frame",
      "demo.mp4.lock": "   ",
    });

    const r = runScript("encode-mp4.mjs", ["--apply"], dir);

    assert.equal(r.code, EXIT.SKIPPED, r.all);
  });
  test("frameCapture_resumeWithUninspectableFingerprint_refusesRatherThanWiping", (t) => {
    // An unreadable fingerprint is not a mismatch. Treating it as one discards the frames
    // the user asked to resume from.
    const dir = captureProject(t);
    // A directory where the fingerprint file belongs: reading it fails with EISDIR.
    fs.mkdirSync(path.join(dir, "frames", ".capture-meta.json"));

    const r = runScript("frame-capture.mjs", ["--apply", "--resume"], dir);

    assert.equal(
      r.code,
      EXIT.USAGE,
      `an uninspectable fingerprint must not authorise a wipe\n${r.all}`,
    );
    assert.doesNotMatch(
      r.all,
      /^\s*at .*\(.*:\d+:\d+\)/m,
      "and must not surface as an uncaught stack",
    );
    assert.equal(
      fs.readFileSync(path.join(dir, "frames", "frame_00000.png"), "utf8"),
      SENTINEL,
    );
  });

  test("frameCapture_invalidJpegQuality_exitsUsageBeforeCapturing", (t) => {
    const dir = captureProject(t);

    const r = runScript("frame-capture.mjs", ["--apply"], dir, {
      env: {
        SIZZLECRAFT_FRAME_FORMAT: "jpeg",
        SIZZLECRAFT_JPEG_QUALITY: "high",
      },
    });

    assert.equal(r.code, EXIT.USAGE, r.all);
    assert.equal(
      fs.readFileSync(path.join(dir, "frames", "frame_00000.png"), "utf8"),
      SENTINEL,
    );
  });

  test("encodeMp4_unknownMode_exitsUsageRatherThanSilentlyPickingOne", (t) => {
    const dir = makeProject(t, {
      "timing.json": timingFixture(contiguousSegments, {
        project: {
          name: "demo",
          fps: 30,
          width: 1280,
          height: 720,
          mode: "turbo",
        },
      }),
      "frames/frame_00000.png": "frame",
    });

    const r = runScript("encode-mp4.mjs", [], dir);

    assert.equal(
      r.code,
      EXIT.USAGE,
      `an unrecognised mode silently became 'quality'\n${r.all}`,
    );
  });
});

// ---------------------------------------------------------------------------
// The lock file is untrusted input, and reading it is an action taken on the caller's
// behalf.
//
// `flag: 'wx'` correctly refuses to WRITE through an existing link — I verified that and
// stopped there. On EEXIST the reader then follows the same link, reads whatever it
// points at, and puts the contents into a diagnostic the script prints. A frames.lock
// symlinked at a file outside the project discloses that file before Playwright loads.
//
// The exit code is unchanged by the fix, so an exit-code assertion would pass while the
// contents leaked. These assert on the SENTINEL's absence.
// ---------------------------------------------------------------------------
describe("lock files are never read through a link", () => {
  const SECRET = "SENTINEL-c0ffee-THIS-MUST-NEVER-BE-ECHOED";

  test("readLockOwner_linkedLock_reportsUnreadableWithoutDisclosingContents", (t) => {
    const dir = makeProject(t);
    const outside = makeOutsideDir(t, { "secret.txt": SECRET });
    const lockPath = path.join(dir, "frames.lock");
    if (!tryMakeFileLink(lockPath, path.join(outside, "secret.txt"))) {
      return t.skip("platform refused to create a file link");
    }

    const owner = readLockOwner(lockPath);

    assert.equal(owner.state, "unreadable");
    assert.doesNotMatch(
      owner.detail,
      /SENTINEL/,
      "the link target must not be read, let alone reported",
    );
  });

  test("readLockOwner_regularLockWithJunk_doesNotEchoItsContents", (t) => {
    const dir = makeProject(t, { "frames.lock": SECRET });

    const owner = readLockOwner(path.join(dir, "frames.lock"));

    assert.equal(owner.state, "unreadable");
    assert.doesNotMatch(
      owner.detail,
      /SENTINEL/,
      "untrusted lock contents must never reach a diagnostic",
    );
  });

  test("frameCapture_lockLinkedOutsideRoot_skipsWithoutDisclosingTheTarget", (t) => {
    const dir = makeProject(t, {
      "video-auto.html": '<html><body><div id="stage"></div></body></html>',
      "timing.json": timingFixture(),
      "frames/frame_00000.png": SENTINEL,
    });
    const outside = makeOutsideDir(t, { "secret.txt": SECRET });
    if (
      !tryMakeFileLink(
        path.join(dir, "frames.lock"),
        path.join(outside, "secret.txt"),
      )
    ) {
      return t.skip("platform refused to create a file link");
    }

    const r = runScript("frame-capture.mjs", ["--apply"], dir);

    assert.doesNotMatch(
      r.all,
      /SENTINEL-c0ffee/,
      "the contents of an outside file must not appear in any output",
    );
    assert.equal(
      r.code,
      EXIT.SKIPPED,
      `an unreadable lock must fail closed\n${r.all}`,
    );
    assert.equal(
      fs.readFileSync(path.join(dir, "frames", "frame_00000.png"), "utf8"),
      SENTINEL,
    );
  });

  test("encodeMp4_lockLinkedOutsideRoot_skipsWithoutDisclosingTheTarget", (t) => {
    const dir = makeProject(t, {
      "timing.json": timingFixture(),
      "frames/frame_00000.png": "frame",
    });
    const outside = makeOutsideDir(t, { "secret.txt": SECRET });
    if (
      !tryMakeFileLink(
        path.join(dir, "demo.mp4.lock"),
        path.join(outside, "secret.txt"),
      )
    ) {
      return t.skip("platform refused to create a file link");
    }

    const r = runScript("encode-mp4.mjs", ["--apply"], dir);

    assert.doesNotMatch(
      r.all,
      /SENTINEL-c0ffee/,
      "the contents of an outside file must not appear in any output",
    );
    assert.equal(r.code, EXIT.SKIPPED, r.all);
  });
});

// ---------------------------------------------------------------------------
// The write SET, not the individual write. Distinctness and confinement were each
// applied to one collection; a stage writes several.
// ---------------------------------------------------------------------------
describe("complete write set", () => {
  const voiceFiles = {
    "timing.json": timingFixture(),
    "brand/tokens.json": brandTokens,
  };

  test("voice_voiceoverLinkedToASegmentClip_isRefusedBeforeSynthesis", (t) => {
    const dir = makeProject(t, { ...voiceFiles, "segment_01.mp3": "clip one" });
    if (
      !tryMakeFileLink(
        path.join(dir, "voiceover.mp3"),
        path.join(dir, "segment_01.mp3"),
      )
    ) {
      return t.skip("platform refused to create a file link");
    }
    const r = runScript("voice.mjs", ["--apply", "--replace"], dir);

    assertCleanExit(
      r,
      EXIT.USAGE,
      "two outputs resolving to one file must be refused: ",
    );
    assert.equal(
      fs.readFileSync(path.join(dir, "segment_01.mp3"), "utf8"),
      "clip one",
    );
  });

  test("remix_voiceoverLinkedToTiming_isRefusedBeforeWriting", (t) => {
    // Worded, so the timeline is one remix accepts and the refusal is the link's.
    const dir = makeProject(t, {
      "timing.json": timingFixture(wordedSegments),
    });
    if (
      !tryMakeFileLink(
        path.join(dir, "voiceover.mp3"),
        path.join(dir, "timing.json"),
      )
    ) {
      return t.skip("platform refused to create a file link");
    }
    const before = fs.readFileSync(path.join(dir, "timing.json"), "utf8");
    const r = runScript("remix.mjs", ["--apply", "--replace"], dir);

    assertCleanExit(
      r,
      EXIT.USAGE,
      "voiceover and timing resolving to one file must be refused: ",
    );
    assert.match(r.all, /is a link/, r.all);
    assert.equal(
      fs.readFileSync(path.join(dir, "timing.json"), "utf8"),
      before,
    );
  });

  test("voice_secondaryOutputLinkedOutsideRoot_isRefused", (t) => {
    const dir = makeProject(t, voiceFiles);
    const outside = makeOutsideDir(t, { "victim.json": SENTINEL });
    if (
      !tryMakeFileLink(
        path.join(dir, "calibration-observed.json"),
        path.join(outside, "victim.json"),
      )
    ) {
      return t.skip("platform refused to create a file link");
    }
    const r = runScript("voice.mjs", ["--apply", "--replace"], dir);

    assertCleanExit(
      r,
      EXIT.USAGE,
      "a secondary output escaping the root must be refused: ",
    );
    assert.equal(
      fs.readFileSync(path.join(outside, "victim.json"), "utf8"),
      SENTINEL,
    );
  });

  test("frameCapture_resumeWithLinkedDedupStats_isRefusedAndVictimSurvives", (t) => {
    // With a matching fingerprint the directory is NOT wiped, so a link planted inside
    // frames/ survives and the engine's own metadata write follows it out of the project.
    const html = '<html><body><div id="stage"></div></body></html>';
    const dir = makeProject(t, {
      "video-auto.html": html,
      "timing.json": timingFixture(),
      "frames/frame_00000.png": "f",
    });
    const outside = makeOutsideDir(t, { "victim.json": SENTINEL });

    fs.writeFileSync(
      path.join(dir, "frames", ".capture-meta.json"),
      JSON.stringify({
        htmlHash: crypto
          .createHash("sha256")
          .update(Buffer.from(html))
          .digest("hex"),
        fps: 30,
        width: 1280,
        height: 720,
        frameFormat: "png",
        jpegQuality: 88,
        totalFrames: Math.ceil(((4000 + 1000) / 1000) * 30),
        v: 1,
      }),
    );
    if (
      !tryMakeFileLink(
        path.join(dir, "frames", ".dedup-stats.json"),
        path.join(outside, "victim.json"),
      )
    ) {
      return t.skip("platform refused to create a file link");
    }
    const r = runScript("frame-capture.mjs", ["--apply", "--resume"], dir);

    assertCleanExit(
      r,
      EXIT.USAGE,
      "engine metadata must not be written through a link: ",
    );
    assert.equal(
      fs.readFileSync(path.join(outside, "victim.json"), "utf8"),
      SENTINEL,
    );
  });

  test("frameCapture_resumePlan_disclosesTheMetadataItRewrites", (t) => {
    const dir = makeProject(t, {
      "video-auto.html": '<html><body><div id="stage"></div></body></html>',
      "timing.json": timingFixture(),
      "frames/frame_00000.png": "f",
    });
    const r = runScript("frame-capture.mjs", ["--resume"], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(
      r.all,
      /capture-meta\.json/,
      "a resume plan still rewrites the engine metadata; say so",
    );
  });
});

// ---------------------------------------------------------------------------
// More invalid-value-to-false-success.
// ---------------------------------------------------------------------------
describe("present-but-invalid is not absent", () => {
  test("encodeMp4_nonNumericToleranceMs_exitsUsageBeforeEncoding", (t) => {
    const dir = makeProject(t, {
      "timing.json": timingFixture(contiguousSegments, {
        intake: { toleranceMs: "oops" },
      }),
      "frames/frame_00000.png": "frame",
      "voiceover.mp3": "x".repeat(4096),
    });
    const r = runScript("encode-mp4.mjs", ["--apply", "--replace"], dir);

    assertCleanExit(
      r,
      EXIT.USAGE,
      "a NaN A/V tolerance disables the sync gate: ",
    );
  });

  test("encodeMp4_planWithMissingNarration_doesNotPromiseAVideoOnlyRender", (t) => {
    const dir = makeProject(t, {
      "timing.json": timingFixture(),
      "frames/frame_00000.png": "frame",
    });
    const r = runScript("encode-mp4.mjs", [], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.doesNotMatch(
      r.all,
      /video-only/i,
      "only an intentional silent render is video-only",
    );
    assert.match(
      r.all,
      /refuse|missing/i,
      "the plan must say the apply path would refuse",
    );
  });

  test("encodeMp4_planWithIntentionalSilentRender_saysSilent", (t) => {
    const dir = makeProject(t, {
      "timing.json": timingFixture(contiguousSegments, {
        intake: { toleranceMs: 750, silent: true },
      }),
      "frames/frame_00000.png": "frame",
    });
    const r = runScript("encode-mp4.mjs", [], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(r.all, /silent/i);
  });

  test("makeMusic_durationRoundingToZeroSamples_isRefused", (t) => {
    const dir = makeProject(t);
    const r = runScript(
      "make-music.mjs",
      ["--out", "bed.wav", "--seconds", "0.000001", "--apply"],
      dir,
    );

    assertCleanExit(r, EXIT.USAGE, "a zero-sample bed must be refused: ");
    assert.equal(fs.existsSync(path.join(dir, "bed.wav")), false);
  });

  test("makeMusic_envelopeRemovedBetweenPreflightAndRead_failsRatherThanGoingFlat", async (t) => {
    // The discriminating case. A directory at env.json does NOT discriminate: the old
    // `existsSync` returned true for it too, then failed the read exactly as the new code
    // does. The only behaviour that changed is the one where existsSync returns FALSE —
    // the file is gone by the time the late read happens — which old code answered by
    // silently producing un-ducked music and exiting 0.
    //
    // make-music reads the envelope after synthesising the pad, so deleting it once the
    // preset line appears lands inside a multi-second window, well before the read.
    const rms = Array.from({ length: 600 }, (_, i) =>
      i % 20 < 10 ? 0.2 : 0.001,
    );
    // The envelope must be BOUND to a voice track on disk, or the lineage pre-flight
    // refuses it before the preset line and the deletion below never lands in the window
    // this test exists to open.
    const voice = Buffer.from("narration bytes");
    const dir = makeProject(t, {
      "voiceover.mp3": voice,
      "env.json": JSON.stringify({
        rms,
        hopMs: 20,
        durationMs: 12000,
        measuredFrom: boundTo(voice),
      }),
    });
    const envPath = path.join(dir, "env.json");

    const r = await runScriptDeletingOnMarker(
      "make-music.mjs",
      [
        "--out",
        "bed.wav",
        "--seconds",
        "30",
        "--envelope",
        "env.json",
        "--apply",
      ],
      dir,
      "music preset:",
      envPath,
    );

    assert.equal(
      r.deleted,
      true,
      "the envelope must actually have been removed mid-run for this to test anything",
    );
    assert.equal(
      r.code,
      EXIT.USAGE,
      `a vanished envelope must fail, not silently go flat\n${r.all}`,
    );
    assert.match(
      r.all,
      /env\.json/,
      "and must name the envelope it could not read",
    );
    assert.equal(
      fs.existsSync(path.join(dir, "bed.wav")),
      false,
      "no bed may be written",
    );
  });

  test("makeMusic_envelopeUnreadableAtPreflight_isRefused", (t) => {
    const dir = makeProject(t);
    fs.mkdirSync(path.join(dir, "env.json"));
    const r = runScript(
      "make-music.mjs",
      [
        "--out",
        "bed.wav",
        "--seconds",
        "2",
        "--envelope",
        "env.json",
        "--apply",
      ],
      dir,
    );

    assertCleanExit(r, EXIT.USAGE, "an unreadable envelope must be refused: ");
    assert.equal(fs.existsSync(path.join(dir, "bed.wav")), false);
  });
});

// ---------------------------------------------------------------------------
// encode-mp4: four writes the ENGINE chose, none of them named by the caller.
//
// These were unreachable only because encoder-page.html shipped nowhere, so the script
// threw before touching them. An accident of brokenness is not a guard, and it stopped
// being true the moment the first real consumer extracted the page.
//
// Each guard is asserted on the victim's CONTENTS and on the sentinel's absence from the
// output, not on the exit code alone — for several of these the code is unchanged either
// way, so an exit-code assertion passes while the file is destroyed.
// ---------------------------------------------------------------------------
describe("encode-mp4 engine-chosen writes", () => {
  const encodableProject = (t, extra = {}) =>
    makeProject(t, {
      "timing.json": timingFixture(),
      "frames/frame_00000.png": "frame",
      "voiceover.mp3": "x".repeat(4096),
      ...extra,
    });

  test("encodeMp4_encoderDirLinkedOutsideRoot_refusesBeforeInstallingAnything", (t) => {
    const dir = encodableProject(t);
    const outside = makeOutsideDir(t, { "victim.html": SENTINEL });
    if (!tryMakeDirLink(path.join(dir, "encoder"), outside))
      return t.skip("platform refused to create a directory link");

    const r = runScript("encode-mp4.mjs", ["--apply", "--replace"], dir);

    assertCleanExit(
      r,
      EXIT.USAGE,
      "a junction at the engine-chosen encoder dir must be refused: ",
    );
    assert.equal(
      fs.readFileSync(path.join(outside, "victim.html"), "utf8"),
      SENTINEL,
    );
    assert.equal(
      fs.existsSync(path.join(outside, "encoder-page.html")),
      false,
      "nothing may be installed through the junction",
    );
    assert.equal(fs.existsSync(path.join(outside, "mp4-muxer.js")), false);
    assert.doesNotMatch(
      r.all,
      /MUST SURVIVE/,
      "and the victim must never be echoed",
    );
  });

  test("encodeMp4_encoderPageLinkedOutsideRoot_refusesWithoutClobberingTheVictim", (t) => {
    const dir = encodableProject(t);
    const outside = makeOutsideDir(t, { "victim.html": SENTINEL });
    const victim = path.join(outside, "victim.html");
    fs.mkdirSync(path.join(dir, "encoder"));
    if (
      !tryMakeFileLink(path.join(dir, "encoder", "encoder-page.html"), victim)
    ) {
      return t.skip("platform refused to create a file link");
    }

    const r = runScript("encode-mp4.mjs", ["--apply", "--replace"], dir);

    assertCleanExit(
      r,
      EXIT.USAGE,
      "copyFileSync follows a destination link, so the guard must fire first: ",
    );
    assert.equal(fs.readFileSync(victim, "utf8"), SENTINEL);
    assert.doesNotMatch(r.all, /MUST SURVIVE/);
  });

  test("encodeMp4_muxerDestinationLinkedOutsideRoot_refusesWithoutClobberingTheVictim", (t) => {
    const dir = encodableProject(t);
    const outside = makeOutsideDir(t, { "victim.js": SENTINEL });
    const victim = path.join(outside, "victim.js");
    fs.mkdirSync(path.join(dir, "encoder"));
    if (!tryMakeFileLink(path.join(dir, "encoder", "mp4-muxer.js"), victim)) {
      return t.skip("platform refused to create a file link");
    }

    const r = runScript("encode-mp4.mjs", ["--apply", "--replace"], dir);

    assertCleanExit(
      r,
      EXIT.USAGE,
      "the muxer copy has the same destination-link problem: ",
    );
    assert.equal(fs.readFileSync(victim, "utf8"), SENTINEL);
    assert.doesNotMatch(r.all, /MUST SURVIVE/);
  });

  test("encodeMp4_outputMp4IsAnInRootLink_refusesRatherThanGuardingADifferentEntry", (t) => {
    // The publish guard resolved the link's TARGET while renameSync replaces the link
    // ENTRY. Not an outside-root clobber today — but guard and action referred to
    // different files, which is "correct for a reason nothing enforces".
    const dir = encodableProject(t, { "real.mp4": SENTINEL });
    if (
      !tryMakeFileLink(path.join(dir, "demo.mp4"), path.join(dir, "real.mp4"))
    ) {
      return t.skip("platform refused to create a file link");
    }

    const r = runScript("encode-mp4.mjs", ["--apply", "--replace"], dir);

    assertCleanExit(
      r,
      EXIT.USAGE,
      "an engine-chosen publish target must not be a link: ",
    );
    assert.equal(fs.readFileSync(path.join(dir, "real.mp4"), "utf8"), SENTINEL);
  });

  test("encodeMp4_outputMp4LinkedOutsideRoot_stillRefusesWithoutClobbering", (t) => {
    // Regression cover: containment already refused this before the change, and it must
    // keep doing so now that the policy resolving it is a different one.
    const dir = encodableProject(t);
    const outside = makeOutsideDir(t, { "victim.mp4": SENTINEL });
    const victim = path.join(outside, "victim.mp4");
    if (!tryMakeFileLink(path.join(dir, "demo.mp4"), victim))
      return t.skip("platform refused to create a file link");

    const r = runScript("encode-mp4.mjs", ["--apply", "--replace"], dir);

    assertCleanExit(r, EXIT.USAGE);
    assert.equal(fs.readFileSync(victim, "utf8"), SENTINEL);
    assert.doesNotMatch(r.all, /MUST SURVIVE/);
  });

  test("encodeMp4_timingJsonLinkedOutsideRoot_refusesWithoutDisclosingIt", (t) => {
    // A path that is written is also a path that is read, and the two need separate
    // verdicts. Every other stage resolves timing.json through requireExistingFile;
    // encode-mp4 alone joined it raw, so a planted link was followed and JSON.parse put
    // the first line of the target into its error message — the same shape as the lock
    // file disclosure, reached on the DEFAULT no-flag path.
    //
    // The exit code is non-zero either way, so it proves nothing here. The sentinel does.
    const dir = makeProject(t);
    const outside = makeOutsideDir(t, { "secret.txt": `AKIA${SENTINEL}` });
    if (
      !tryMakeFileLink(
        path.join(dir, "timing.json"),
        path.join(outside, "secret.txt"),
      )
    ) {
      return t.skip("platform refused to create a file link");
    }

    const r = runScript("encode-mp4.mjs", [], dir);

    assert.doesNotMatch(
      r.all,
      /MUST SURVIVE/,
      "the contents of a file outside the project must never be echoed",
    );
    assertCleanExit(
      r,
      EXIT.USAGE,
      "a timing.json link escaping the root must be refused: ",
    );
  });

  test("encodeMp4_encoderPathIsARegularFile_refusesCleanlyRatherThanCrashing", (t) => {
    // `encoder` occupied by an ordinary file made mkdirSync throw a raw EEXIST stack and
    // exit 1. The entry is engine-chosen and the situation is recoverable, so it deserves
    // the documented usage code and a message saying what to do.
    const dir = encodableProject(t, { encoder: "not a directory" });

    const r = runScript("encode-mp4.mjs", ["--apply", "--replace"], dir);

    assertCleanExit(
      r,
      EXIT.USAGE,
      "a non-directory at encoder/ must be refused, not crash mkdirSync: ",
    );
    assert.match(
      r.all,
      /encoder/i,
      "and the refusal must name the entry it refused",
    );
  });

  test("encodeMp4_partFileCollision_refusesWithoutDeletingTheExistingEntry", async (t) => {
    // The inversion: the exclusive open refuses a pre-existing entry precisely so it is
    // not written through — and the cleanup path then deleted it anyway. The guard
    // performed the destruction it exists to prevent.
    //
    // The temp file is `<out>.part-<pid>`, so the collision cannot be staged before the
    // run. It is planted from the child's own PID once the run announces itself, inside
    // the window Chromium's launch provides.
    const engineDir = makeEngineCopy(t);
    const dir = operableProject(t);
    let victim = null;

    const r = await runScriptPlantingOnMarker(
      engineDir,
      "encode-mp4.mjs",
      ["--apply", "--replace"],
      dir,
      "silent render requested",
      (pid) => {
        victim = path.join(dir, `demo.mp4.part-${pid}`);
        fs.writeFileSync(victim, SENTINEL);
      },
    );

    assert.equal(
      r.planted,
      true,
      "the collision must actually have been staged for this to test anything",
    );
    assert.notEqual(victim, null);
    assert.equal(
      fs.existsSync(victim),
      true,
      "the refused entry must still exist — a refusal must not delete what it declined to create",
    );
    assert.equal(
      fs.readFileSync(victim, "utf8"),
      SENTINEL,
      "and its contents must be untouched",
    );
    assertCleanExit(
      r,
      EXIT.USAGE,
      "a refused temp-file collision must exit with the documented usage code: ",
    );
  });

  test("encodeMp4_cleanProject_completesEveryGuardedWriteAndPublishes", (t) => {
    // Replaces a test that accepted any exit other than 2 and matched the
    // missing-encoder-page error — so it passed on an unrelated prerequisite failure and
    // never established that a single guarded write was reached. The guards must not fire
    // on a legitimate project, and the only way to show that is to let the writes happen.
    const engineDir = makeEngineCopy(t);
    const dir = operableProject(t);

    const r = runEngineScript(
      engineDir,
      "encode-mp4.mjs",
      ["--apply", "--replace"],
      dir,
    );

    assert.equal(
      r.code,
      EXIT.OK,
      `a legitimate project must clear every guard and publish\n${r.all}`,
    );
    assert.equal(
      fs.existsSync(path.join(dir, "encoder", "encoder-page.html")),
      true,
      "the guarded encoder-page copy must have executed",
    );
    assert.equal(
      fs.existsSync(path.join(dir, "encoder", "mp4-muxer.js")),
      true,
      "the guarded muxer copy must have executed",
    );
    assert.equal(
      fs.existsSync(path.join(dir, "demo.mp4")),
      true,
      "the guarded publish must have executed",
    );
    assert.equal(
      fs.readdirSync(dir).filter((n) => n.includes(".part-")).length,
      0,
      "and no temp file may survive a successful publish",
    );
  });
});

// ---------------------------------------------------------------------------
// write-build-html reads four engine-chosen files and confined none of them.
//
// `:35` is the live one: timing.json joined raw, handed to JSON.parse, whose message
// quotes what it parsed — the same disclosure just closed in encode-mp4, on the bare
// invocation path.
//
// The other three are wrapped in `try { ... } catch {}`, which stops the MESSAGE
// disclosure but not the read: valid JSON from outside the project still reaches the
// rendered page. Swallowing also collapses three different states — absent, unreadable,
// and unsafe — into "not present", so a corrupted manifest silently removes content and
// a planted one silently adds it.
// ---------------------------------------------------------------------------
describe("write-build-html engine-chosen reads", () => {
  // An OPERABLE scene project. An under-specified fixture made the refusal tests below
  // pass on a missing evidence-pack rather than on the guard — the same free pass this
  // round was opened to remove, reproduced in the tests for it.
  const sceneProject = (t, extra = {}) =>
    makeProject(t, {
      "timing.json": timingFixture(),
      "evidence-pack/.keep": "",
      "node_modules/gsap/dist/gsap.min.js": "/* gsap stub */",
      ...extra,
    });

  test("writeBuildHtml_fixtureIsOperable_buildsTheSceneBeforeAnyGuardIsTested", (t) => {
    // Pins the fixture itself. If this stops passing, every refusal assertion below has
    // become unfalsifiable and must not be trusted.
    const dir = sceneProject(t);

    const r = runScript("write-build-html.mjs", ["--apply", "--replace"], dir);

    assert.equal(
      r.code,
      EXIT.OK,
      `the scene fixture must build, or the guard tests prove nothing\n${r.all}`,
    );
    assert.equal(fs.existsSync(path.join(dir, "video-auto.html")), true);
  });

  test("writeBuildHtml_timingJsonLinkedOutsideRoot_refusesWithoutDisclosingIt", (t) => {
    const dir = makeProject(t);
    const outside = makeOutsideDir(t, { "secret.txt": `AKIA${SENTINEL}` });
    if (
      !tryMakeFileLink(
        path.join(dir, "timing.json"),
        path.join(outside, "secret.txt"),
      )
    ) {
      return t.skip("platform refused to create a file link");
    }

    const r = runScript("write-build-html.mjs", [], dir);

    assert.doesNotMatch(
      r.all,
      /MUST SURVIVE/,
      "the contents of a file outside the project must never be echoed",
    );
    assertCleanExit(
      r,
      EXIT.USAGE,
      "a timing.json link escaping the root must be refused: ",
    );
  });

  test("writeBuildHtml_manifestLinkedOutsideRoot_refusesRatherThanReadingThroughIt", (t) => {
    // Swallowing the error hides the message, not the read — valid outside JSON still
    // influences the page. The refusal has to happen before the read.
    const dir = sceneProject(t);
    const outside = makeOutsideDir(t, {
      "planted.json": JSON.stringify({ title: SENTINEL }),
    });
    if (
      !tryMakeFileLink(
        path.join(dir, "manifest.json"),
        path.join(outside, "planted.json"),
      )
    ) {
      return t.skip("platform refused to create a file link");
    }

    const r = runScript("write-build-html.mjs", ["--apply", "--replace"], dir);

    assertCleanExit(
      r,
      EXIT.USAGE,
      "an optional input redirected outside the root must be refused: ",
    );
    assert.doesNotMatch(r.all, /MUST SURVIVE/);
    const built = path.join(dir, "video-auto.html");
    if (fs.existsSync(built)) {
      assert.doesNotMatch(
        fs.readFileSync(built, "utf8"),
        /MUST SURVIVE/,
        "and must never reach the rendered page",
      );
    }
  });

  test("writeBuildHtml_absentOptionalFile_isTreatedAsAbsentNotAsAnError", (t) => {
    // The state that legitimately means "nothing to add". Confining the read must not
    // turn an ordinary project into a failure.
    const dir = sceneProject(t);

    const r = runScript("write-build-html.mjs", ["--apply", "--replace"], dir);

    assert.equal(
      r.code,
      EXIT.OK,
      `an absent optional input is not an error\n${r.all}`,
    );
    assert.equal(fs.existsSync(path.join(dir, "video-auto.html")), true);
  });
  test("writeBuildHtml_unreadableOptionalFile_failsRatherThanTreatingItAsAbsent", (t) => {
    // "I could not read your manifest" and "you have no manifest" are different facts and
    // only one of them is safe to assume. A directory at the path makes the read fail with
    // EISDIR, which the old `catch {}` rendered as absence.
    const dir = sceneProject(t);
    fs.mkdirSync(path.join(dir, "manifest.json"));

    const r = runScript("write-build-html.mjs", ["--apply", "--replace"], dir);

    assertCleanExit(
      r,
      EXIT.USAGE,
      "an unreadable optional input must not render as an absent one: ",
    );
    assert.match(
      r.all,
      /manifest\.json/,
      "and must name the file it could not read",
    );
  });

  test("writeBuildHtml_malformedOptionalFile_failsRatherThanSilentlyDroppingContent", (t) => {
    const dir = sceneProject(t, { "manifest.json": "{ not valid json" });

    const r = runScript("write-build-html.mjs", ["--apply", "--replace"], dir);

    assertCleanExit(
      r,
      EXIT.USAGE,
      "a corrupt optional input silently removed content: ",
    );
  });

  // -------------------------------------------------------------------------
  // The fourth state, created inside the separation of the other three.
  //
  // `null` was returned for an ABSENT file and for a PRESENT file whose JSON is `null`,
  // and both callers map it to `{}`. So a present clips.json containing `null` suppressed
  // approved footage, rendered the synthetic fallback, and exited 0 — the exact outcome
  // the three-state split was written to remove, reachable through the sentinel that
  // performed the split.
  // -------------------------------------------------------------------------
  test("writeBuildHtml_footageFixtureIsOperable_loadsRealFramesAtTheStartAndLaterInTheClip", async (t) => {
    // The positive control, and the thing it controls for is narrow: that footage actually
    // RENDERS. The previous version asserted only that "myclip" appeared in the HTML, which
    // proves the clip was selected into the scene and nothing more — it passed over frames
    // that were text rather than JPEG and zero-based rather than one-based, so every load
    // failed. A control that cannot see a broken render cannot certify a refused one.
    //
    // Two points are checked because asserting only the first frame would pass on a fixture
    // with exactly one usable frame — close to the shape that was wrong before.
    const dir = footageProject(t);

    const r = runScript("write-build-html.mjs", ["--apply", "--replace"], dir);
    assert.equal(r.code, EXIT.OK, `the footage fixture must build\n${r.all}`);

    const [atStart, later] = await probeFootageFrames(
      path.join(dir, "video-auto.html"),
      [0, 100],
    );

    assert.equal(
      atStart.loaded,
      true,
      `the first footage frame must decode and be applied, got ${JSON.stringify(atStart)}`,
    );
    assert.equal(
      atStart.applied,
      "frame_00001.jpg",
      "the runtime is one-based: the clip starts at frame_00001.jpg",
    );
    assert.equal(
      later.loaded,
      true,
      `a later footage frame must decode too, got ${JSON.stringify(later)}`,
    );
    assert.equal(
      later.applied,
      "frame_00004.jpg",
      "and a later time must advance to a different frame",
    );
  });

  test("writeBuildHtml_footageControlFails_whenTheFramesCannotDecode", async (t) => {
    // Proves the control's alarm can actually fire. A control whose alarm has never been
    // heard is indistinguishable from one that cannot ring: this deliberately degrades the
    // render path — frames present, digests correct, bytes not an image — and asserts the
    // control goes red. That is exactly the fixture defect the previous version shipped.
    const dir = footageProject(t, {
      frameBytes: Buffer.from("not a jpeg at all"),
    });

    const r = runScript("write-build-html.mjs", ["--apply", "--replace"], dir);
    assert.equal(
      r.code,
      EXIT.OK,
      `the build still succeeds — that is the point of this case\n${r.all}`,
    );

    const [atStart] = await probeFootageFrames(
      path.join(dir, "video-auto.html"),
      [0],
    );

    assert.equal(
      atStart.loaded,
      false,
      "undecodable frames must be visible to the control, not silently tolerated",
    );
    assert.equal(
      atStart.applied,
      null,
      "and nothing may be applied as the background",
    );
  });

  test("writeBuildHtml_footageControlFails_whenTheSceneThrowsAfterInitialising", async (t) => {
    // The alarm for a failure the decode alarm cannot see: the scene initialises, the frames
    // are real, one-based and decodable, every frame assertion passes — and the scene throws
    // on every trigger. That was this control's actual state two rounds ago.
    //
    // The broken stub is DERIVED from the working one by removing a single method, so the
    // only possible cause of failure is that method. A hand-written second stub differs in
    // ways nobody enumerated, and could fail through the initialisation path instead — which
    // would leave the post-sampling check unpinned while this test still went green.
    //
    // And the assertion is on the tagged stage, not on a phrase both failures share.
    const dir = footageProject(t, {
      gsapStub: gsapStubWithout("totalProgress"),
    });

    const r = runScript("write-build-html.mjs", ["--apply", "--replace"], dir);
    assert.equal(
      r.code,
      EXIT.OK,
      `the build still succeeds — that is the point of this case\n${r.all}`,
    );

    await assert.rejects(
      () => probeFootageFrames(path.join(dir, "video-auto.html"), [0]),
      (err) => {
        assert.equal(
          err.stage,
          "post-init",
          `the alarm must fire on the post-sampling check, not initialisation (got ${err.stage}: ${err.message})`,
        );
        assert.equal(
          err.frames?.[0]?.loaded,
          true,
          "and it must fire despite the frame loading perfectly",
        );
        assert.equal(
          err.frames?.[0]?.applied,
          "frame_00001.jpg",
          "with the frame actually applied",
        );
        assert.ok(
          err.pageErrors.some((m) => /totalProgress/.test(m)),
          `the removed method must be what broke it, got ${JSON.stringify(err.pageErrors)}`,
        );
        return true;
      },
    );
  });

  test("writeBuildHtml_footageControlFails_whenTheSceneNeverInitialises", async (t) => {
    // The third distinct failure, pinned separately so the two can never satisfy each other:
    // gsap absent entirely kills the script block before __setFootageFrame is assigned.
    const dir = footageProject(t, { gsapStub: "/* nothing at all */" });

    const r = runScript("write-build-html.mjs", ["--apply", "--replace"], dir);
    assert.equal(r.code, EXIT.OK, r.all);

    await assert.rejects(
      () => probeFootageFrames(path.join(dir, "video-auto.html"), [0]),
      (err) => {
        assert.equal(
          err.stage,
          "init",
          `expected the initialisation failure, got ${err.stage}: ${err.message}`,
        );
        return true;
      },
    );
  });

  test("writeBuildHtml_clipsJsonContainingNull_isRefusedRatherThanSilentlyDroppingFootage", (t) => {
    // The signature of this bug is exit 0 with content missing, so the exit code alone
    // proves nothing — the scene is checked too.
    const dir = footageProject(t, { clipsJson: "null" });

    const r = runScript("write-build-html.mjs", ["--apply", "--replace"], dir);

    assertCleanExit(
      r,
      EXIT.USAGE,
      "a present file whose content is null is not an absent file: ",
    );
    assert.match(r.all, /clips\.json/, "and the refusal must name the file");
    const built = path.join(dir, "video-auto.html");
    if (fs.existsSync(built)) {
      assert.match(
        fs.readFileSync(built, "utf8"),
        /myclip/,
        "a scene must never be published with the footage silently dropped",
      );
    }
  });

  test("writeBuildHtml_evidencePackContainingNull_isRefused", (t) => {
    const dir = footageProject(t, { evidenceJson: "null" });

    const r = runScript("write-build-html.mjs", ["--apply", "--replace"], dir);

    assertCleanExit(
      r,
      EXIT.USAGE,
      "the approval gate must not be emptied by a null file: ",
    );
  });

  test("writeBuildHtml_clipsJsonContainingAnArray_isRefused", (t) => {
    // `typeof [] === 'object'`, so an array reached callers that index it by property and
    // read undefined everywhere — absence again, wearing a different shape.
    const dir = footageProject(t, { clipsJson: "[]" });

    const r = runScript("write-build-html.mjs", ["--apply", "--replace"], dir);

    assertCleanExit(
      r,
      EXIT.USAGE,
      "a JSON array is not the object the caller requires: ",
    );
  });

  test("writeBuildHtml_clipsJsonContainingAScalar_isRefused", (t) => {
    const dir = footageProject(t, { clipsJson: "42" });

    const r = runScript("write-build-html.mjs", ["--apply", "--replace"], dir);

    assertCleanExit(
      r,
      EXIT.USAGE,
      "a JSON scalar is not the object the caller requires: ",
    );
  });

  test("writeBuildHtml_clipsPropertyWithWrongType_isRefused", (t) => {
    // The shape the caller actually relies on: `(FOOTAGE.clips || []).find(...)`. A string
    // `clips` has a .find of undefined, and an object has none at all.
    const dir = footageProject(t, {
      clipsJson: JSON.stringify({ clips: "not-an-array" }),
    });

    const r = runScript("write-build-html.mjs", ["--apply", "--replace"], dir);

    assertCleanExit(
      r,
      EXIT.USAGE,
      "clips must be an array where the caller iterates it: ",
    );
    assert.match(r.all, /clips/, "and the refusal must name the property");
  });
});

// ---------------------------------------------------------------------------
// A check that cannot fire is indistinguishable from a check that passed.
//
// With --no-schema, a FINAL segment carrying a non-numeric endMs produced no contiguity
// break (nothing follows it to compare against) and a NaN word budget (`words > NaN` is
// always false). Neither check fired and the verifier exited 0 on malformed timing.
//
// I previously reported this as "a spurious failure, safe direction". That was reasoning
// about the middle of the list; the end of the list behaves differently.
// ---------------------------------------------------------------------------
describe("validate-timing refuses to judge malformed timing", () => {
  test("validateTiming_finalSegmentEndMsNotNumeric_failsRatherThanExitingZero", (t) => {
    const segments = [
      { id: "one", startMs: 0, endMs: 2000, voiceoverText: "a word or two" },
      {
        id: "two",
        startMs: 2000,
        endMs: "bad",
        voiceoverText: "b word or two",
      },
    ];
    const dir = makeProject(t, { "timing.json": timingFixture(segments) });
    const r = runScript(
      "validate-timing.mjs",
      ["--no-schema", "--strict"],
      dir,
    );

    assertCleanExit(
      r,
      EXIT.FAILED,
      "a verifier must not pass timing it could not evaluate: ",
    );
    assert.match(r.all, /two/, "the failure must name the offending segment");
  });

  test("validateTiming_middleSegmentStartMsNotNumeric_failsRatherThanExitingZero", (t) => {
    const segments = [
      { id: "one", startMs: 0, endMs: 2000, voiceoverText: "a" },
      { id: "two", startMs: "nope", endMs: 4000, voiceoverText: "b" },
      { id: "three", startMs: 4000, endMs: 6000, voiceoverText: "c" },
    ];
    const dir = makeProject(t, { "timing.json": timingFixture(segments) });
    const r = runScript("validate-timing.mjs", ["--no-schema"], dir);

    assertCleanExit(r, EXIT.FAILED, "malformed timing must fail: ");
  });

  test("validateTiming_nonPositiveWindow_failsRatherThanProducingAZeroBudget", (t) => {
    // startMs 0 so contiguity is intact — the zero-length window is the only defect,
    // and without --strict an over-budget segment is only advisory, so pre-fix this
    // exits 0 with narration that cannot possibly fit.
    const segments = [
      { id: "one", startMs: 0, endMs: 0, voiceoverText: "a b c" },
    ];
    const dir = makeProject(t, { "timing.json": timingFixture(segments) });
    const r = runScript("validate-timing.mjs", ["--no-schema"], dir);

    assertCleanExit(
      r,
      EXIT.FAILED,
      "a zero-length window cannot carry narration: ",
    );
  });

  test("validateTiming_malformedTiming_saysTheLaterChecksWereNotEvaluated", (t) => {
    const segments = [
      { id: "one", startMs: 0, endMs: "bad", voiceoverText: "a" },
    ];
    const dir = makeProject(t, { "timing.json": timingFixture(segments) });
    const r = runScript("validate-timing.mjs", ["--no-schema"], dir);

    assert.match(
      r.all,
      /not evaluated|NOT evaluated/i,
      "a check that did not run must say so, not stay silent",
    );
  });

  test("validateTiming_wellFormedTiming_stillPasses", (t) => {
    const dir = makeProject(t, {
      "timing.json": timingFixture(contiguousSegments),
    });
    const r = runScript("validate-timing.mjs", ["--no-schema"], dir);

    assert.equal(r.code, EXIT.OK, r.all);
  });
});

// ---------------------------------------------------------------------------
// Engine-chosen outputs vs user-named outputs.
//
// The boundary deliberately permits an in-root link for a path the CALLER named. It is
// never right for a path the ENGINE chose: following it writes to a file nobody asked
// for. resolveInternalArtifact was introduced for capture metadata and then not applied
// to the other engine-chosen outputs in the same round.
// ---------------------------------------------------------------------------
describe("engine-chosen outputs refuse links", () => {
  const voiceFiles = {
    "timing.json": timingFixture(),
    "brand/tokens.json": brandTokens,
  };

  test("voice_syncMappingLinkedToAnUnrelatedInRootFile_isRefused", (t) => {
    // Distinctness cannot see this: only one output maps to notes.md.
    const dir = makeProject(t, { ...voiceFiles, "notes.md": SENTINEL });
    if (
      !tryMakeFileLink(
        path.join(dir, "sync-mapping.md"),
        path.join(dir, "notes.md"),
      )
    ) {
      return t.skip("platform refused to create a file link");
    }
    const r = runScript("voice.mjs", ["--apply", "--replace"], dir);

    assertCleanExit(
      r,
      EXIT.USAGE,
      "an engine-chosen output must not be redirected by a link: ",
    );
    assert.equal(fs.readFileSync(path.join(dir, "notes.md"), "utf8"), SENTINEL);
  });

  test("voice_healLogLinkedToAnUnrelatedInRootFile_isRefused", (t) => {
    const dir = makeProject(t, { ...voiceFiles, "notes.txt": SENTINEL });
    if (
      !tryMakeFileLink(
        path.join(dir, "heal-log.txt"),
        path.join(dir, "notes.txt"),
      )
    ) {
      return t.skip("platform refused to create a file link");
    }
    const r = runScript("voice.mjs", ["--apply", "--replace"], dir);

    assertCleanExit(
      r,
      EXIT.USAGE,
      "an appended engine log must not be redirected by a link: ",
    );
    assert.equal(
      fs.readFileSync(path.join(dir, "notes.txt"), "utf8"),
      SENTINEL,
    );
  });

  test("remix_voiceoverLinkedToAnUnrelatedInRootFile_isRefused", (t) => {
    const dir = makeProject(t, {
      "timing.json": timingFixture(wordedSegments),
      "notes.txt": SENTINEL,
    });
    if (
      !tryMakeFileLink(
        path.join(dir, "voiceover.mp3"),
        path.join(dir, "notes.txt"),
      )
    ) {
      return t.skip("platform refused to create a file link");
    }
    const r = runScript("remix.mjs", ["--apply", "--replace"], dir);

    assertCleanExit(
      r,
      EXIT.USAGE,
      "remix output must not be redirected by a link: ",
    );
    assert.match(r.all, /is a link/, r.all);
    assert.equal(
      fs.readFileSync(path.join(dir, "notes.txt"), "utf8"),
      SENTINEL,
    );
  });

  test("silenceGen_userNamedOutputThroughAnInRootLink_isStillPermitted", (t) => {
    // The counterpart: a path the caller NAMED may legitimately resolve through an
    // in-root link. Tightening engine outputs must not tighten this.
    const dir = makeProject(t, { "real/target.mp3": "old" });
    if (!tryMakeDirLink(path.join(dir, "alias"), path.join(dir, "real"))) {
      return t.skip("platform refused to create a directory link");
    }
    const r = runScript(
      "silence-gen.mjs",
      ["--out", "alias/target.mp3", "--ms", "480", "--apply", "--replace"],
      dir,
    );

    assert.equal(r.code, EXIT.OK, r.all);
    assert.equal(
      fs.statSync(path.join(dir, "real", "target.mp3")).size,
      20 * 288,
    );
  });
});

// ---------------------------------------------------------------------------
// The plan must disclose the write set it now preflights.
// ---------------------------------------------------------------------------
describe("voice plan discloses every output", () => {
  test("voice_plan_listsSecondaryArtifactsWithReplaceStatus", (t) => {
    const dir = makeProject(t, {
      "timing.json": timingFixture(),
      "brand/tokens.json": brandTokens,
      "calibration-observed.json": SENTINEL,
      "sync-mapping.md": SENTINEL,
    });
    const r = runScript("voice.mjs", [], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(
      r.all,
      /calibration-observed\.json/,
      "the plan must name every file --apply rewrites",
    );
    assert.match(r.all, /sync-mapping\.md/);
    assert.match(r.all, /heal-log\.txt/, "including the conditional append");
    assert.match(
      r.all,
      /EXISTS|REPLACE/,
      "and say what would happen to the ones already there",
    );
  });
});

describe("boundary root canonicalisation", () => {
  test("createBoundary_absentRoot_isPermittedForNotYetCreatedProjects", (t) => {
    const dir = makeProject(t);
    const missing = path.join(dir, "not-created-yet");
    assert.doesNotThrow(() => createBoundary(missing));
  });

  test("createBoundary_rootIsAFile_isRefused", (t) => {
    const dir = makeProject(t, { "a-file.txt": "x" });
    assert.throws(() => createBoundary(path.join(dir, "a-file.txt")), CliError);
  });

  test("createBoundary_rootInspectionFails_isRefusedRatherThanFallingBackToLexical", (t) => {
    // A link cycle: realpath reports ELOOP, which proves nothing about containment.
    const dir = makeProject(t);
    const a = path.join(dir, "loop-a");
    const b = path.join(dir, "loop-b");
    if (!tryMakeDirLink(a, b) || !tryMakeDirLink(b, a))
      return t.skip("platform refused to create the link cycle");
    let failed = false;
    try {
      fs.realpathSync.native(a);
    } catch (err) {
      failed = err.code !== "ENOENT";
    }
    if (!failed)
      return t.skip(
        "this platform resolves the cycle without an inspection error",
      );

    assert.throws(
      () => createBoundary(a),
      CliError,
      "an uninspectable root must not degrade to a lexical boundary",
    );
  });
});

// ---------------------------------------------------------------------------
// JSON has no `undefined`, so an absent timestamp is often written as null. `Number(null)`
// is 0, which is finite, so a null endMs was read as "ends at zero". It lost the
// Math.max that sizes the capture, and the render stopped before that segment's
// narration: no error, and a frame count that looked measured.
// ---------------------------------------------------------------------------
describe("a null timestamp is absent, not zero", () => {
  const timingWithSecondSegment = (second) =>
    JSON.stringify({
      project: { name: "demo", fps: 30, width: 320, height: 240 },
      endCard: { enabled: false },
      segments: [
        {
          id: "one",
          startMs: 0,
          endMs: 2000,
          voiceoverText: "hello",
          audio: { durationMs: 2000 },
        },
        { id: "two", voiceoverText: "second segment", ...second },
      ],
    });

  test("frameCapture_segmentEndMsNull_derivesItsEndFromTheMeasuredClip", (t) => {
    const dir = makeProject(t, {
      ...captureFiles,
      "timing.json": timingWithSecondSegment({
        startMs: 2000,
        endMs: null,
        audio: { durationMs: 2000 },
      }),
    });

    const r = runScript("frame-capture.mjs", [], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    // (2000 start + 2000 measured + 1000 tail) ms at 30 fps. A null read as 0 gives 90.
    assert.match(
      r.all,
      /frames\s+150 at 30 fps/,
      `the capture must cover the segment whose endMs is null\n${r.all}`,
    );
  });

  for (const [scenario, second] of [
    ["StartMsNull", { startMs: null, audio: { durationMs: 2000 } }],
    ["MeasuredDurationNull", { startMs: 2000, audio: { durationMs: null } }],
  ]) {
    test(`frameCapture_segmentWith${scenario}AndNoEndMs_namesTheSegmentItCannotPlace`, (t) => {
      const dir = makeProject(t, {
        ...captureFiles,
        "timing.json": timingWithSecondSegment(second),
      });

      const r = runScript("frame-capture.mjs", [], dir);

      assertCleanExit(
        r,
        EXIT.USAGE,
        "a segment placed by a null must be refused, not placed at zero: ",
      );
      assert.match(r.all, /"two"/, "the refusal must name the segment");
    });
  }
});

// ---------------------------------------------------------------------------
// C-3 caps each slide's hold at the NEXT segment's start, and write-build-html does not
// run validate-timing, so that start was never checked. A missing startMs became NaN,
// JSON wrote it as null, and Math.min(hold, null) is 0: the slide before it was switched
// away at t=0 and the build exited 0. A numeric string is no safer, because the trigger
// times add to it ("2000" + 500). Only a finite JSON number places a segment.
// ---------------------------------------------------------------------------
describe("write-build-html refuses a segment it cannot place", () => {
  const TOO_LARGE = 987654321; // written as 1e400, which JSON.parse reads as Infinity
  const sceneWith = (t, segments) =>
    makeProject(t, {
      "timing.json": timingFixture(segments, {
        durationMs: 4000,
        contentMs: 4000,
      }).replace(String(TOO_LARGE), "1e400"),
      "evidence-pack/.keep": "",
      "node_modules/gsap/dist/gsap.min.js": "/* gsap stub */",
    });
  const withSecond = (second) => [
    contiguousSegments[0],
    { ...contiguousSegments[1], ...second },
  ];

  test("writeBuildHtml_finiteSegmentTimes_buildsTheScene", (t) => {
    // The control: the fixture the refusals below are built from must build.
    const dir = sceneWith(t, withSecond({}));

    const r = runScript("write-build-html.mjs", ["--apply"], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.equal(fs.existsSync(path.join(dir, "video-auto.html")), true);
  });

  for (const [scenario, second, field] of [
    ["startMsMissing", { startMs: undefined }, /startMs/],
    ["endMsNull", { endMs: null }, /endMs/],
    ["startMsNonNumericString", { startMs: "soon" }, /startMs/],
    ["startMsNumericString", { startMs: "2000" }, /startMs/],
    ["endMsOverflowingToInfinity", { endMs: TOO_LARGE }, /endMs/],
  ]) {
    for (const [mode, args] of [
      ["InPlan", []],
      ["UnderApply", ["--apply"]],
    ]) {
      test(`writeBuildHtml_${scenario}${mode}_exitsUsageNamingTheSegmentAndWritesNothing`, (t) => {
        const dir = sceneWith(t, withSecond(second));

        const r = runScript("write-build-html.mjs", args, dir);

        assertCleanExit(
          r,
          EXIT.USAGE,
          `a segment with ${scenario} must be refused: `,
        );
        assert.match(r.all, /"two"/, "the refusal must name the segment");
        assert.match(r.all, field, "and the time it cannot use");
        assert.equal(
          fs.existsSync(path.join(dir, "video-auto.html")),
          false,
          "and nothing may be written",
        );
      });
    }
  }

  test("writeBuildHtml_twoSegmentsWithUnusableTimes_namesBothInOneRefusal", (t) => {
    const dir = sceneWith(t, [
      { ...contiguousSegments[0], endMs: undefined },
      { ...contiguousSegments[1], startMs: null },
    ]);

    const r = runScript("write-build-html.mjs", ["--apply"], dir);

    assertCleanExit(r, EXIT.USAGE, "unusable segment times must be refused: ");
    assert.match(
      r.all,
      /"one"[^\n]*endMs/,
      "the first segment must be named with its field",
    );
    assert.match(
      r.all,
      /"two"[^\n]*startMs/,
      "and so must the second, in the same refusal",
    );
    assert.equal(fs.existsSync(path.join(dir, "video-auto.html")), false);
  });
});

// ===========================================================================
// UNREADABLE INPUT IS THE CALLER'S FAULT — EXIT 2, EVERYWHERE.
//
// cli-support defines 2 as "the caller's fault: bad arguments, a path outside the project
// root, a missing prerequisite", and a timing.json that will not parse is a missing
// prerequisite: no stage can begin without it. MEASURED on one unparseable file, before
// this change:
//
//   remix.mjs             exit 1, UNCAUGHT SyntaxError with a stack
//   write-storyboard.mjs  exit 1, UNCAUGHT SyntaxError with a stack
//   concat-audio.mjs      exit 1, clean refusal naming the file
//   frame-capture.mjs     exit 2, clean refusal naming the file
//
// Four stages, three answers, one input. The first two are the crash-instead-of-refusal
// class; the third is a deliberate EXIT.FAILED that simply predates the ruling. The exit
// code is the only part a pipeline driver can act on without parsing prose, so the stages
// disagreeing about it is the defect — not the wording, which two of them already get right.
// ===========================================================================

describe("an unparseable timing.json is refused as bad input, by every stage", () => {
  // frame-capture is the model: it already does this, so it is the control. If it ever
  // stops, the thing being copied has moved and these tests are measuring a new target.
  for (const stage of [
    "remix.mjs",
    "write-storyboard.mjs",
    "concat-audio.mjs",
    "frame-capture.mjs",
  ]) {
    test(`${stage.replace(/\W/g, "_")}_unparseableTimingJson_isRefusedAsBadInput`, (t) => {
      const dir = makeProject(t, { "timing.json": "{ not json" });

      const r = runScript(stage, [], dir);

      // assertCleanExit also rejects a stack trace, which is half the defect here: an
      // uncaught SyntaxError exits non-zero too, so `notEqual(code, 0)` would pass against
      // the crash this exists to remove.
      assertCleanExit(
        r,
        EXIT.USAGE,
        `${stage}: unreadable input is the caller's fault: `,
      );
      assert.doesNotMatch(
        r.all,
        /SyntaxError/,
        `${stage}: the raw parser error escaped\n${r.all}`,
      );
      assert.match(
        r.all,
        /timing\.json is not valid JSON/,
        `${stage}: the refusal must name the file\n${r.all}`,
      );
    });
  }

  test("unparseableTimingJson_isRefusedBeforeAnythingIsWritten", (t) => {
    // STATE, NOT JUST THE CODE. A clean exit code with half-written output is not a clean
    // refusal. Nothing can legitimately be produced from a file that never parsed, so the
    // directory must hold exactly what it held before.
    const dir = makeProject(t, { "timing.json": "{ not json" });
    const before = fs.readdirSync(dir).sort();

    for (const stage of [
      "remix.mjs",
      "write-storyboard.mjs",
      "concat-audio.mjs",
      "frame-capture.mjs",
    ]) {
      const r = runScript(stage, ["--apply"], dir);
      assert.notEqual(r.code, EXIT.OK, `${stage} must refuse\n${r.all}`);
      assert.deepEqual(
        fs.readdirSync(dir).sort(),
        before,
        `${stage} wrote something from a file it could not read\n${r.all}`,
      );
    }
  });

  test("unparseableTimingJson_isRefusedWithoutQuotingItsContents", (t) => {
    // MEASURED: V8's "Unexpected token" message quotes ~17 bytes of the file verbatim —
    //   Unexpected token 'S', "{ "k": SENTINEL-L"... is not valid JSON
    // so forwarding err.message copies the input into stdout and from there into CI logs.
    // Not every malformed file triggers that form, which is exactly why this needs a
    // sentinel rather than an eyeball: my first probe used a shape that does NOT quote and
    // came back clean, and I nearly concluded the message was safe.
    //
    // write-chapters.mjs:197 already solved this — it reports the file and its SIZE and
    // says why — after a link at timing.json made a parse error quote the opening bytes of
    // whatever the link led to.
    // The sentinel is SHORT and sits EARLY, because V8 truncates its quotation at about 17
    // characters: `Unexpected token 'S', "{ "k": SENTINEL-L"... is not valid JSON`. My first
    // version of this test used an 18-character sentinel placed after a key, so the leaked
    // text was `SENTINEL-L` and `includes(SENTINEL)` was false — the assertion tested for a
    // string the disclosure is incapable of containing, and passed against the leak it was
    // written to catch. Verified by mutation: `assert.ok(false)` in its place also passed,
    // which is what proved the body was not measuring what it claimed.
    const SENTINEL = "LEAK7f3a";
    // ONE SHAPE IS NOT A MEASUREMENT. V8 quotes the input only for its "Unexpected token"
    // form; measured over six malformed shapes, two quote and four do not. A test using a
    // non-quoting shape passes against the leak — which is how frame-capture's own
    // disclosure survived until a reviewer looked. Both quoting shapes are used here, and
    // the non-quoting ones are covered by the length-independent assertion below.
    const QUOTING_SHAPES = [`${SENTINEL}: 1`, `{ "k": ${SENTINEL} }`];
    for (const stage of [
      "remix.mjs",
      "write-storyboard.mjs",
      "concat-audio.mjs",
      "frame-capture.mjs",
    ]) {
      for (const body of QUOTING_SHAPES) {
        const dir = makeProject(t, { "timing.json": body });

        const r = runScript(stage, [], dir);

        assertCleanExit(r, EXIT.USAGE, `${stage} (${body}): `);
        assert.ok(
          !r.all.includes(SENTINEL),
          `${stage} (${body}): the refusal quoted the file's contents\n${r.all}`,
        );
        assert.doesNotMatch(
          r.all,
          /Unexpected token/,
          `${stage} (${body}): the parser's message was forwarded\n${r.all}`,
        );
        assert.match(
          r.all,
          /timing\.json is not valid JSON/,
          `${stage} (${body}): it must still name the file\n${r.all}`,
        );
      }
    }
  });

  test("aParseableTimingJson_isNotRefusedAsBadInput", (t) => {
    // THE DISCRIMINATING CONTROL. Every assertion above expects a refusal, and "refuse
    // everything" satisfies all of them. A well-formed timeline must still reach each
    // stage's own work.
    //
    // It asserts EXIT.OK where a plan can legitimately succeed from a timeline alone, which
    // is remix and write-storyboard. MEASURED: concat-audio needs the clips on disk
    // ("segment_000.mp3 is missing") and frame-capture needs a built scene
    // ("video-auto.html not found"). Those are their own preconditions, nothing to do with
    // parsing, so demanding EXIT.OK from them would pin an unrelated contract — and a
    // fixture built to satisfy it would be testing the fixture.
    //
    // For those two the assertion is narrower, and pins what was MEASURED rather than a
    // claim about reaching their work: the exact exit code, the specific missing-artifact
    // diagnostic that proves the parse was passed and the stage got as far as its own
    // prerequisite, and no stack of any kind. An earlier version rejected only two strings,
    // which an unrelated early refusal or an uncaught TypeError would have satisfied.
    const dir = makeProject(t, {
      "timing.json": timingFixture(wordedSegments),
    });

    for (const stage of ["remix.mjs", "write-storyboard.mjs"]) {
      const r = runScript(stage, [], dir);
      assertCleanExit(
        r,
        EXIT.OK,
        `${stage} must plan a well-formed timeline: `,
      );
    }
    for (const [stage, code, reached] of [
      ["concat-audio.mjs", EXIT.FAILED, /segment_000\.mp3 is missing/],
      ["frame-capture.mjs", EXIT.USAGE, /video-auto\.html not found/],
    ]) {
      const r = runScript(stage, [], dir);
      assertCleanExit(r, code, `${stage}: `);
      assert.match(
        r.all,
        reached,
        `${stage} must get past the parse to its own prerequisite\n${r.all}`,
      );
      assert.doesNotMatch(
        r.all,
        /is not valid JSON/,
        `${stage} refused a well-formed file\n${r.all}`,
      );
    }
  });
});

// ===========================================================================
// ONE STATEMENT OF WHAT `project.noGoPatterns` MAY BE.
//
// Two stages read the field and disagreed about it. MEASURED end to end, before this
// change, on the same timing.json:
//
//   noGoPatterns          write-build-html   validate-scene
//   [123]  (a number)     exit 0 ACCEPTED    exit 2 refused
//   300 patterns          exit 0 ACCEPTED    exit 2 refused
//   a 600-char pattern    exit 0 ACCEPTED    exit 2 refused
//   ['x']                 exit 0             exit 0
//
// `write-build-html` checked only `Array.isArray` and then called `new RegExp(src, 'i')`,
// so a number was coerced to its decimal form and silently became a pattern. The bounds
// existed in `validate-scene` alone. Neither stage validates against timing-schema.json —
// nothing invokes a validator — so declaring the field there would have recorded the
// divergence rather than closing it.
//
// The rule now has ONE statement, in cli-support.mjs, imported by both. These cases are
// the specification, and both stages must answer them identically.
// ===========================================================================

describe("project.noGoPatterns has one shape, and both stages enforce it", () => {
  // write-build-html reaches the field ONLY on the code-mode path — the mode that renders
  // source data into the frame — so the fixture is code mode. Widening that reach is a
  // different decision and is deliberately not made here.
  const codeProject = (t, noGoPatterns) => {
    const seg = {
      id: "scenario",
      startMs: 0,
      endMs: 6000,
      voiceoverText: "one scenario field by field",
      visual: { mode: "code", title: "One scenario", json: { k: "v" } },
    };
    const timing = JSON.parse(timingFixture([seg]));
    timing.project.noGoPatterns = noGoPatterns;
    return makeProject(t, {
      "timing.json": JSON.stringify(timing),
      "evidence-pack/.gitkeep": "",
      // gsap resolves from the PROJECT, not the engine; without the stub every case below
      // exits non-zero on the missing dependency and the refusal tests pass for the wrong
      // reason.
      "node_modules/gsap/dist/gsap.min.js": "/* stub */",
    });
  };

  for (const [scenario, patterns, needle] of [
    ["ANonStringElement", [123], /string/i],
    ["AMixOfStringsAndANumber", ["ok", 7], /string/i],
    ["MorePatternsThanTheBound", Array(300).fill("x"), /256/],
    ["APatternLongerThanTheBound", ["y".repeat(600)], /512/],
  ]) {
    for (const stage of ["validate-scene.mjs", "write-build-html.mjs"]) {
      test(`${stage.replace(/\W/g, "_")}_noGoPatternsWith${scenario}_isRefused`, (t) => {
        const dir = codeProject(t, patterns);

        const r = runScript(stage, [], dir);

        assertCleanExit(r, EXIT.USAGE, `${stage}: `);
        assert.match(
          r.all,
          /noGoPatterns/,
          `${stage}: the refusal must name the field\n${r.all}`,
        );
        assert.match(
          r.all,
          needle,
          `${stage}: the refusal must say what is wrong\n${r.all}`,
        );
      });
    }
  }

  // THE DISCRIMINATING CONTROLS. Every case above expects a refusal, and "refuse every
  // pattern list" satisfies all of them. A usable list must still build, and `[]` must
  // remain the explicit opt-out both stages already honour.
  for (const [scenario, patterns] of [
    ["AUsableStringList", ["https?://", "\\bPR \\d+\\b"]],
    ["TheEmptyOptOut", []],
    ["ExactlyTheBounds", [...Array(255).fill("x"), "z".repeat(512)]],
  ]) {
    // Each stage asserts a POSITIVE signal that the no-go path actually ran and passed,
    // not merely the absence of a refusal phrase. An earlier version of these controls
    // asserted only `doesNotMatch`, which any unrelated failure — a crash, a missing
    // dependency, a non-zero exit — satisfies just as well as success does. Measured
    // success here is exit 0 plus: D1's own row reporting `ok` for the report stage, and
    // the planned segment for the render stage, which is only printed after the code
    // block (and so the pattern scan) has been walked.
    for (const [stage, succeeded] of [
      ["validate-scene.mjs", /D1\b[^\n]*\bok\b/],
      ["write-build-html.mjs", /plan: build the scene for 1 segment/],
    ]) {
      test(`${stage.replace(/\W/g, "_")}_noGoPatternsWith${scenario}_isAccepted`, (t) => {
        const dir = codeProject(t, patterns);

        const r = runScript(stage, [], dir);

        assertCleanExit(r, EXIT.OK, `${stage}: `);
        assert.match(
          r.all,
          succeeded,
          `${stage} did not get through the no-go scan\n${r.all}`,
        );
        assert.doesNotMatch(
          r.all,
          /noGoPatterns must be|above the bound/,
          `${stage} refused a usable list\n${r.all}`,
        );
      });
    }
  }
});

// ===========================================================================
// A NO-GO PATTERN IS ITSELF THE SECRET.
//
// The field is a list of the strings an author does not want reaching a frame, so the
// list is by construction a list of sensitive strings. `validate-scene` already ruled on
// this in writing (src/validate-scene.mjs:748-754): "NEITHER THE MATCH NOR THE PATTERN IS
// EVER PRINTED ... The pattern is no safer than the match." `write-build-html` stated the
// same principle at :479 — "the log should not carry it" — applied it to the matched
// value, and then printed the pattern anyway, on both of its refusal paths.
//
// MEASURED on the real sample project (tools/EvalLoopDemo/timing.json), whose patterns
// include `microsoft-ppe\.com` and `cortex-supportgraph`: those strings were written to
// stdout and from there into any CI log, at the exact moment the guard succeeded.
//
// The sentinel below is chosen so the PATTERN SOURCE is textually distinguishable from
// the TEXT IT MATCHES: the source contains `\-`, the matched value contains a plain `-`.
// A test that asserted absence of the bare word could not tell the two leaks apart, and
// the matched value was already withheld before this change.
// ===========================================================================

describe("a no-go pattern is never echoed, on either refusal path", () => {
  const PATTERN_SOURCE = "cortex\\-supportgraph"; // what the author wrote: has a backslash
  const MATCHED_VALUE = "cortex-supportgraph"; // what it matches: no backslash

  const codeProject = (t, noGoPatterns, json) => {
    const seg = {
      id: "scenario",
      startMs: 0,
      endMs: 6000,
      voiceoverText: "one scenario field by field",
      visual: { mode: "code", title: "One scenario", json },
    };
    const timing = JSON.parse(timingFixture([seg]));
    timing.project.noGoPatterns = noGoPatterns;
    return makeProject(t, {
      "timing.json": JSON.stringify(timing),
      "evidence-pack/.gitkeep": "",
      "node_modules/gsap/dist/gsap.min.js": "/* stub */",
    });
  };

  test("writeBuildHtml_whenAPatternMatches_refusesWithoutEchoingThePatternSource", (t) => {
    const dir = codeProject(t, [PATTERN_SOURCE], { host: MATCHED_VALUE });

    const r = runScript("write-build-html.mjs", [], dir);

    // THE LEAK ASSERTION.
    assert.doesNotMatch(
      r.all,
      /cortex\\-supportgraph/,
      `the pattern SOURCE was echoed into output\n${r.all}`,
    );
    // POSITIVE CONTROLS — an absence assertion alone is satisfied by a stage that printed
    // nothing at all, or crashed, or never reached the scan.
    assert.notEqual(
      r.code,
      EXIT.OK,
      `a no-go match must refuse, got ${r.code}\n${r.all}`,
    );
    assert.match(
      r.all,
      /noGoPatterns\[0\]/,
      `the refusal must still say WHICH pattern, by index\n${r.all}`,
    );
    assert.match(
      r.all,
      /\bhost\b/,
      `the refusal must still say WHERE it matched\n${r.all}`,
    );
  });

  test("writeBuildHtml_whenAPatternMatches_stillWithholdsTheMatchedValue", (t) => {
    const dir = codeProject(t, [PATTERN_SOURCE], { host: MATCHED_VALUE });

    const r = runScript("write-build-html.mjs", [], dir);

    // This held before the change and must keep holding: fixing one leak must not open
    // the other by, say, reporting the hit instead of the pattern.
    assert.doesNotMatch(
      r.all,
      /cortex-supportgraph/,
      `the MATCHED VALUE was echoed into output\n${r.all}`,
    );
  });

  test("writeBuildHtml_whenAPatternWillNotCompile_refusesWithoutEchoingThePatternSource", (t) => {
    const dir = codeProject(t, ["SECRETHOST(unclosed"], { k: "v" });

    const r = runScript("write-build-html.mjs", [], dir);

    assert.doesNotMatch(
      r.all,
      /SECRETHOST/,
      `the uncompilable pattern's SOURCE was echoed into output\n${r.all}`,
    );
    assert.notEqual(
      r.code,
      EXIT.OK,
      `an uncompilable pattern must refuse, got ${r.code}\n${r.all}`,
    );
    assert.match(
      r.all,
      /noGoPatterns\[0\]/,
      `the refusal must still say WHICH pattern, by index\n${r.all}`,
    );
  });

  test("writeBuildHtml_whenALaterPatternWillNotCompile_namesThatPatternsIndexNotTheFirst", (t) => {
    const dir = codeProject(t, ["fine", "alsofine", "SECRETHOST(unclosed"], {
      k: "v",
    });

    const r = runScript("write-build-html.mjs", [], dir);

    // The index is the only handle the author gets now, so it has to be the RIGHT index.
    assert.match(
      r.all,
      /noGoPatterns\[2\]/,
      `the refusal must name the offending index, not a placeholder\n${r.all}`,
    );
    assert.doesNotMatch(r.all, /SECRETHOST/, `and still not echo it\n${r.all}`);
  });
});

// A MATCHING KEY **IS** THE MATCHED VALUE.
//
// The walk reports a hit by its JSON path, and the engine has deliberately ruled that
// path printable — the author needs it and it is normally structure, not content
// (tests/safe-defaults.test.mjs:222). But when the pattern matches an object KEY, that
// key IS the text that matched, so putting it in the path printed the matched value in
// the very message that promises to withhold it:
//
//   timing.project.noGoPatterns[0] matched at SUPERSECRET4471
//   The matched text and the pattern are both withheld deliberately
//
// MEASURED end to end on a copy of the real sample project, before the fix. The key's
// ORDINAL is the handle, exactly as the pattern's index is: it says which key without
// saying what it is.
describe("a no-go pattern that matches a KEY does not print that key", () => {
  const codeProject = (t, noGoPatterns, json) => {
    const seg = {
      id: "scenario",
      startMs: 0,
      endMs: 6000,
      voiceoverText: "one scenario field by field",
      visual: { mode: "code", title: "One scenario", json },
    };
    const timing = JSON.parse(timingFixture([seg]));
    timing.project.noGoPatterns = noGoPatterns;
    return makeProject(t, {
      "timing.json": JSON.stringify(timing),
      "evidence-pack/.gitkeep": "",
      "node_modules/gsap/dist/gsap.min.js": "/* stub */",
    });
  };

  test("writeBuildHtml_whenAPatternMatchesAKey_doesNotEchoThatKey", (t) => {
    const dir = codeProject(t, ["SUPERSECRET[0-9]+"], {
      SUPERSECRET4471: "harmless",
    });

    const r = runScript("write-build-html.mjs", [], dir);

    assert.doesNotMatch(
      r.all,
      /SUPERSECRET4471/,
      `the matching KEY is the matched value and must not be echoed\n${r.all}`,
    );
    // POSITIVE CONTROLS — absence alone is satisfied by a stage that never reached the scan.
    assert.notEqual(
      r.code,
      EXIT.OK,
      `a key match must still refuse, got ${r.code}\n${r.all}`,
    );
    assert.match(
      r.all,
      /noGoPatterns\[0\]/,
      `it must still say WHICH pattern\n${r.all}`,
    );
    assert.match(
      r.all,
      /key/i,
      `and that the hit was on a key, not a value\n${r.all}`,
    );
  });

  test("writeBuildHtml_whenAPatternMatchesALaterKey_givesThatKeysOrdinal", (t) => {
    const dir = codeProject(t, ["SUPERSECRET[0-9]+"], {
      alpha: "a",
      beta: "b",
      SUPERSECRET4471: "harmless",
    });

    const r = runScript("write-build-html.mjs", [], dir);

    // The ordinal is the only handle the author gets, so it must be the RIGHT one.
    assert.match(
      r.all,
      /#2\b/,
      `the refusal must give the matching key's ordinal\n${r.all}`,
    );
    assert.doesNotMatch(
      r.all,
      /SUPERSECRET4471/,
      `and still not echo it\n${r.all}`,
    );
  });

  test("writeBuildHtml_whenAPatternMatchesAValue_stillNamesTheKeyPath", (t) => {
    const dir = codeProject(t, ["SUPERSECRET[0-9]+"], {
      host: "SUPERSECRET4471",
    });

    const r = runScript("write-build-html.mjs", [], dir);

    // The path stays for a VALUE match — that is the ruled, tested behaviour and it is
    // what makes the refusal actionable. Withholding it too would fix nothing and cost
    // the author the only locator they have.
    assert.match(
      r.all,
      /\bhost\b/,
      `a value match must still report its path\n${r.all}`,
    );
    assert.doesNotMatch(
      r.all,
      /SUPERSECRET4471/,
      `without the matched value\n${r.all}`,
    );
  });
});

// A KEY IS DISCLOSED BY EVERY HIT BENEATH IT, NOT JUST ITS OWN.
//
// The first fix for the matching-key leak substituted an ordinal for that key's OWN hit,
// and the recursion went on carrying the real key name into the paths of its descendants.
// MEASURED, with the incomplete fix in place, on one object — the same run both withheld
// the key and leaked it, two lines apart:
//
//   timing.project.noGoPatterns[0] matched at key #0 under (root)
//   timing.project.noGoPatterns[0] matched at SUPERSECRET4471.host
//
// So the decision to print a key cannot depend on which pattern is being walked when it is
// reached. It is now taken once, against every pattern, before the walk.
describe("a no-go pattern is not disclosed through an ancestor path", () => {
  const codeProject = (t, noGoPatterns, json) => {
    const seg = {
      id: "scenario",
      startMs: 0,
      endMs: 6000,
      voiceoverText: "one scenario field by field",
      visual: { mode: "code", title: "One scenario", json },
    };
    const timing = JSON.parse(timingFixture([seg]));
    timing.project.noGoPatterns = noGoPatterns;
    return makeProject(t, {
      "timing.json": JSON.stringify(timing),
      "evidence-pack/.gitkeep": "",
      "node_modules/gsap/dist/gsap.min.js": "/* stub */",
    });
  };

  test("writeBuildHtml_whenAHitSitsBeneathAMatchingKey_doesNotEchoThatAncestorKey", (t) => {
    const dir = codeProject(t, ["SUPERSECRET[0-9]+"], {
      SUPERSECRET4471: { host: "SUPERSECRET9999" },
    });

    const r = runScript("write-build-html.mjs", [], dir);

    assert.doesNotMatch(
      r.all,
      /SUPERSECRET4471/,
      `the matching ANCESTOR key leaked through a descendant's path\n${r.all}`,
    );
    assert.doesNotMatch(
      r.all,
      /SUPERSECRET9999/,
      `nor may the matched value appear\n${r.all}`,
    );
    assert.notEqual(
      r.code,
      EXIT.OK,
      `it must still refuse, got ${r.code}\n${r.all}`,
    );
    assert.match(
      r.all,
      /noGoPatterns\[0\]/,
      `and still say which pattern\n${r.all}`,
    );
  });

  test("writeBuildHtml_whenAnAncestorKeyCarriesAPatternsSourceText_doesNotEchoIt", (t) => {
    // The key does NOT match the pattern — it IS the pattern's source, backslash and all.
    // Printing it would hand over the regex itself, which is the thing being protected.
    const dir = codeProject(t, ["cortex\\-supportgraph"], {
      "cortex\\-supportgraph": { host: "cortex-supportgraph" },
    });

    const r = runScript("write-build-html.mjs", [], dir);

    assert.doesNotMatch(
      r.all,
      /cortex\\-supportgraph/,
      `the pattern SOURCE leaked through an ancestor key name\n${r.all}`,
    );
    assert.notEqual(
      r.code,
      EXIT.OK,
      `it must still refuse, got ${r.code}\n${r.all}`,
    );
  });

  test("writeBuildHtml_whenAnOrdinaryKeyIsAnAncestor_keepsItSoThePathStaysUsable", (t) => {
    // THE COUNTER-CASE. Withholding every key would make the refusal unactionable, which
    // is its own defect — only keys that would disclose something are replaced.
    const dir = codeProject(t, ["SUPERSECRET[0-9]+"], {
      config: { endpoint: "SUPERSECRET4471" },
    });

    const r = runScript("write-build-html.mjs", [], dir);

    assert.match(
      r.all,
      /config\.endpoint/,
      `an ordinary path must survive intact, or the author cannot find the hit\n${r.all}`,
    );
    assert.doesNotMatch(
      r.all,
      /SUPERSECRET4471/,
      `without the matched value\n${r.all}`,
    );
  });

  test("writeBuildHtml_whenKeysAreIntegerLike_theOrdinalIsEnumerationOrderAndSaysSo", (t) => {
    // V8 enumerates integer-like keys FIRST, so `key #N` is not the Nth key in the file.
    // Measured: Object.keys({"b":1,"2":2,"a":3}) === ["2","b","a"]. The refusal states
    // this rather than letting the number read as a position in the source text.
    const dir = codeProject(t, ["SUPERSECRET[0-9]+"], {
      b: 1,
      2: "SUPERSECRET4471",
      a: 3,
    });

    const r = runScript("write-build-html.mjs", [], dir);

    assert.match(
      r.all,
      /enumeration order/,
      `the refusal must say what the ordinal counts\n${r.all}`,
    );
    assert.match(
      r.all,
      /integer-like keys first/,
      `and warn that it is not the order in the file\n${r.all}`,
    );
  });
});

// AN ARRAY INDEX IS A PATH COMPONENT TOO.
//
// Keys were screened; `[i]` was not. MEASURED with pattern source `10` and an array whose
// element 10 is the string "10": the refusal printed `matched at items[10]`, which carries
// both the pattern source and the matched value.
//
// Unlike a key there is no non-disclosing substitute that is still a locator — the index
// IS the digits that collide — so the component is withheld. The author keeps the pattern's
// index and the rest of the path, which is enough to find it in their own file.
describe("a no-go pattern is not disclosed through an array index", () => {
  const codeProject = (t, noGoPatterns, json) => {
    const seg = {
      id: "scenario",
      startMs: 0,
      endMs: 6000,
      voiceoverText: "one scenario field by field",
      visual: { mode: "code", title: "One scenario", json },
    };
    const timing = JSON.parse(timingFixture([seg]));
    timing.project.noGoPatterns = noGoPatterns;
    return makeProject(t, {
      "timing.json": JSON.stringify(timing),
      "evidence-pack/.gitkeep": "",
      "node_modules/gsap/dist/gsap.min.js": "/* stub */",
    });
  };

  test("writeBuildHtml_whenAnArrayIndexWouldDiscloseThePattern_withholdsThatComponent", (t) => {
    const items = [...Array(10).fill("x"), "10"];
    const dir = codeProject(t, ["10"], { items });

    const r = runScript("write-build-html.mjs", [], dir);

    assert.doesNotMatch(
      r.all,
      /items\[10\]/,
      `the array index disclosed the pattern source and the matched value\n${r.all}`,
    );
    assert.notEqual(
      r.code,
      EXIT.OK,
      `it must still refuse, got ${r.code}\n${r.all}`,
    );
    assert.match(
      r.all,
      /\bitems\b/,
      `the containing array must still be named, or the refusal is unactionable\n${r.all}`,
    );
    assert.match(
      r.all,
      /noGoPatterns\[0\]/,
      `and still say which pattern\n${r.all}`,
    );
  });

  test("writeBuildHtml_whenAnArrayIndexIsHarmless_keepsItSoThePathStaysUsable", (t) => {
    // THE COUNTER-CASE. Withholding every index would cost the author their locator.
    const dir = codeProject(t, ["SUPERSECRET[0-9]+"], {
      items: ["a", "b", "SUPERSECRET4471"],
    });

    const r = runScript("write-build-html.mjs", [], dir);

    assert.match(
      r.all,
      /items\[2\]/,
      `an ordinary index must survive intact\n${r.all}`,
    );
    assert.doesNotMatch(
      r.all,
      /SUPERSECRET4471/,
      `without the matched value\n${r.all}`,
    );
  });
});

// A PATH CAN DISCLOSE WHAT NONE OF ITS COMPONENTS DOES.
//
// Screening each component is not the same as screening what gets printed. With pattern
// `foo.bar` and nested keys `foo` and `bar`, neither key matches on its own and neither
// carries the source text — but the path they ASSEMBLE INTO does. MEASURED before the fix:
//
//   timing.project.noGoPatterns[0] matched at foo.bar
//
// So the finished string is screened too, immediately before it is emitted.
describe("a no-go pattern is not disclosed by an assembled path", () => {
  const codeProject = (t, noGoPatterns, json) => {
    const seg = {
      id: "scenario",
      startMs: 0,
      endMs: 6000,
      voiceoverText: "one scenario field by field",
      visual: { mode: "code", title: "One scenario", json },
    };
    const timing = JSON.parse(timingFixture([seg]));
    timing.project.noGoPatterns = noGoPatterns;
    return makeProject(t, {
      "timing.json": JSON.stringify(timing),
      "evidence-pack/.gitkeep": "",
      "node_modules/gsap/dist/gsap.min.js": "/* stub */",
    });
  };

  test("writeBuildHtml_whenThePathItselfMatchesAPattern_withholdsThePath", (t) => {
    const dir = codeProject(t, ["foo.bar"], { foo: { bar: "foo.bar" } });

    const r = runScript("write-build-html.mjs", [], dir);

    assert.doesNotMatch(
      r.all,
      /foo\.bar/,
      `the assembled path matched the pattern and was printed anyway\n${r.all}`,
    );
    assert.notEqual(
      r.code,
      EXIT.OK,
      `it must still refuse, got ${r.code}\n${r.all}`,
    );
    assert.match(
      r.all,
      /noGoPatterns\[0\]/,
      `and still say which pattern\n${r.all}`,
    );
  });

  test("writeBuildHtml_whenThePathIsHarmless_printsItInFull", (t) => {
    // THE COUNTER-CASE — screening the whole path must not swallow ordinary ones.
    const dir = codeProject(t, ["SUPERSECRET[0-9]+"], {
      foo: { bar: "SUPERSECRET4471" },
    });

    const r = runScript("write-build-html.mjs", [], dir);

    assert.match(
      r.all,
      /foo\.bar/,
      `an ordinary path must survive intact\n${r.all}`,
    );
    assert.doesNotMatch(
      r.all,
      /SUPERSECRET4471/,
      `without the matched value\n${r.all}`,
    );
  });
});

// ===========================================================================
// AN IDENTIFIER IS AUTHOR CONTENT THAT SHIPS.
//
// The frame-level guard scans `visual.json`. It never sees the structure around it — and
// segment, node, edge, field and hotspot ids are interpolated into the rendered HTML as DOM
// element ids. MEASURED: `seg.id` alone has 54 interpolations in this stage, and `jsonHtml`,
// the animation targets and the SVG marker refs carry the rest. So an id containing a no-go
// string reaches `video-auto.html` on a SUCCESSFUL build — the one path the guard cannot
// refuse, because every VALUE passed.
//
// `TOKEN_RE` already gated these ids, but only for DOM safety: `cortex-supportgraph` is a
// perfectly valid token. Screening them is the same rule applied to the same list.
//
// The refusal names the identifier BY POSITION and never quotes it. Quoting it would do the
// damage the screen exists to prevent, in the message announcing it — which is exactly the
// defect this task started from.
// ===========================================================================

describe("an author-controlled identifier is screened before it can ship", () => {
  const projectWith = (t, noGoPatterns, mutate) => {
    const seg = {
      id: "scenario",
      startMs: 0,
      endMs: 6000,
      voiceoverText: "one scenario field by field",
      visual: { mode: "code", title: "One scenario", json: { k: "v" } },
    };
    mutate(seg);
    const timing = JSON.parse(timingFixture([seg]));
    timing.project.noGoPatterns = noGoPatterns;
    return makeProject(t, {
      "timing.json": JSON.stringify(timing),
      "evidence-pack/.gitkeep": "",
      "node_modules/gsap/dist/gsap.min.js": "/* stub */",
    });
  };

  // Every id-shaped field the stage interpolates, not just the one that was reported.
  for (const [what, mutate, where] of [
    [
      "aSegmentId",
      (s) => {
        s.id = "cortex-supportgraph";
      },
      /segments\[0\]\.id/,
    ],
    [
      "ANodeId",
      (s) => {
        s.visual.nodes = [
          {
            id: "cortex-supportgraph",
            label: "n",
            x: 10,
            y: 10,
            w: 100,
            h: 40,
          },
        ];
      },
      /segments\[0\]\.visual\.nodes\[0\]\.id/,
    ],
    [
      "AnEdgeEndpoint",
      (s) => {
        s.visual.nodes = [{ id: "a", label: "n", x: 10, y: 10, w: 100, h: 40 }];
        s.visual.edges = [{ id: "e1", from: "cortex-supportgraph", to: "a" }];
      },
      /segments\[0\]\.visual\.edges\[0\]\.from/,
    ],
    [
      "AFieldId",
      (s) => {
        s.visual.fields = [{ id: "cortex-supportgraph", x: 10, y: 10 }];
      },
      /segments\[0\]\.visual\.fields\[0\]\.id/,
    ],
    [
      "AHotspotId",
      (s) => {
        s.visual.hotspots = [{ id: "cortex-supportgraph", x: 10, y: 10 }];
      },
      /segments\[0\]\.visual\.hotspots\[0\]\.id/,
    ],
  ]) {
    test(`writeBuildHtml_when${what}MatchesANoGoPattern_refusesByPositionWithoutQuotingIt`, (t) => {
      const dir = projectWith(t, ["cortex-supportgraph"], mutate);

      const r = runScript("write-build-html.mjs", [], dir);

      // A CRASH ALSO SATISFIES `notEqual(code, OK)`. The first version of this screen threw
      // a CliError at module top level, outside guard(), and exited 1 with a stack — and
      // this assertion passed. assertCleanExit pins the code AND the absence of a stack.
      assertCleanExit(r, EXIT.USAGE, `${where}: `);
      assert.doesNotMatch(
        r.all,
        /cortex-supportgraph/,
        `the identifier was quoted in the refusal that screens it\n${r.all}`,
      );
      assert.match(
        r.all,
        where,
        `and it must say WHICH identifier, by position\n${r.all}`,
      );
      assert.equal(
        fs.existsSync(path.join(dir, "video-auto.html")),
        false,
        "and nothing may be written",
      );
    });
  }

  test("writeBuildHtml_whenIdentifiersAreOrdinary_stillBuilds", (t) => {
    // THE COUNTER-CASE. "Refuse every id" satisfies all of the above just as well.
    const dir = projectWith(t, ["cortex-supportgraph"], (s) => {
      s.visual.nodes = [{ id: "svc", label: "n", x: 10, y: 10, w: 100, h: 40 }];
    });

    const r = runScript("write-build-html.mjs", [], dir);

    assert.equal(
      r.code,
      EXIT.OK,
      `an ordinary project must still build\n${r.all}`,
    );
  });

  test("writeBuildHtml_whenNoGoPatternsIsAbsent_theIdentifierScreenIsInert", (t) => {
    // REACH IS NOT WIDENED. Absence is codeBlock's to judge on the code-mode path; this
    // screen must not turn it into a whole-stage refusal, and must not issue a shape
    // verdict of its own.
    const seg = {
      id: "cortex-supportgraph",
      startMs: 0,
      endMs: 6000,
      voiceoverText: "a plain slide",
      visual: { mode: "statement", title: "Plain" },
    };
    const timing = JSON.parse(timingFixture([seg]));
    delete timing.project.noGoPatterns;
    const dir = makeProject(t, {
      "timing.json": JSON.stringify(timing),
      "evidence-pack/.gitkeep": "",
      "node_modules/gsap/dist/gsap.min.js": "/* stub */",
    });

    const r = runScript("write-build-html.mjs", [], dir);

    assert.equal(
      r.code,
      EXIT.OK,
      `no patterns configured means nothing to screen against\n${r.all}`,
    );
  });
});

// THE WALK'S STATED LIMITATION, PINNED.
//
// The no-go walk tests strings and numbers only. A pattern matching the literal `true`,
// `false` or `null` does not refuse. That is deliberate, not pending: those three tokens are
// the ENTIRE set a boolean or null can render as, so none can carry author content. It is
// pinned here so the next reader meets a measured limitation rather than an absence, and so
// that changing it is a deliberate act with a failing test attached.
describe("the no-go walk does not detect booleans or null, and that is stated", () => {
  const codeProject = (t, noGoPatterns, json) => {
    const seg = {
      id: "scenario",
      startMs: 0,
      endMs: 6000,
      voiceoverText: "one scenario field by field",
      visual: { mode: "code", title: "One scenario", json },
    };
    const timing = JSON.parse(timingFixture([seg]));
    timing.project.noGoPatterns = noGoPatterns;
    return makeProject(t, {
      "timing.json": JSON.stringify(timing),
      "evidence-pack/.gitkeep": "",
      "node_modules/gsap/dist/gsap.min.js": "/* stub */",
    });
  };

  test("writeBuildHtml_aPatternMatchingAStringValue_refuses_theControl", (t) => {
    // THE POSITIVE CONTROL. Without it, the test below passes on any stage that never
    // reached the scan at all — which is how the first measurement of this got it wrong.
    const dir = codeProject(t, ["plain"], { note: "plain" });

    const r = runScript("write-build-html.mjs", [], dir);

    assert.match(
      r.all,
      /no-go match/,
      `the scan must be reached and working\n${r.all}`,
    );
  });

  test("writeBuildHtml_aPatternMatchingABooleanOrNull_isNowRefusedToo", (t) => {
    // THIS PINNED A LIMITATION AND NO LONGER DOES. The walk tests strings and numbers only,
    // so a pattern matching the literal `true`/`false`/`null` did not refuse — MEASURED,
    // with the control above as proof the scan was reached. Emission-point screening closed
    // it without touching the walk: `jsonHtml` renders every scalar through `esc(value, …)`.
    //
    // Repointed rather than deleted. A stale limitation left asserted after it is closed is
    // the prose-drift defect in test form, and it would read as proof the gap still exists.
    const dir = codeProject(t, ["true"], { enabled: true });

    const r = runScript("write-build-html.mjs", [], dir);

    assert.notEqual(
      r.code,
      EXIT.OK,
      `a boolean reaching the frame is text on the screen like any other\n${r.all}`,
    );
  });

  test("writeBuildHtml_aPatternMatchingNullAlone_isRefused", (t) => {
    // SPLIT FROM THE TEST ABOVE BECAUSE IT COULD NOT DISCRIMINATE. The original used
    // `['true','null']` against `{enabled:true, missing:null}` — `true` alone triggers the
    // refusal, so the assertion passed whether or not `null` was screened. It was not:
    // `jsonHtml` returned the literal `<span class="j-null">null</span>` without calling
    // `esc()`, so a project whose only pattern was `null` published that token.
    const dir = codeProject(t, ["null"], { missing: null });

    const r = runScript("write-build-html.mjs", [], dir);

    assert.notEqual(
      r.code,
      EXIT.OK,
      `the rendered null literal must be screened like any other emitted token\n${r.all}`,
    );
  });
});

// FOUR MORE ROUTES, EACH MEASURED BEFORE IT WAS CLOSED.
//
// Every one of these was reachable with the identifier screen already in place, which is the
// argument for screening by RULE rather than by the example that prompted it.
describe("the remaining author-controlled routes to a diagnostic or the artefact", () => {
  const projectWith = (t, noGoPatterns, mutate, mode = "code") => {
    const seg = {
      id: "scenario",
      startMs: 0,
      endMs: 6000,
      voiceoverText: "one scenario field by field",
      visual: { mode, title: "One scenario", json: { k: "v" } },
    };
    mutate(seg);
    const timing = JSON.parse(timingFixture([seg]));
    timing.project.noGoPatterns = noGoPatterns;
    return makeProject(t, {
      "timing.json": JSON.stringify(timing),
      "evidence-pack/.gitkeep": "",
      "node_modules/gsap/dist/gsap.min.js": "/* stub */",
    });
  };

  test("writeBuildHtml_anIdentifierThatIsBothAnInvalidTokenAndANoGoMatch_isNotQuotedByTheTokenError", (t) => {
    // ORDER MATTERS AS MUCH AS WORDING. assertTok used to quote the offending value, and it
    // ran FIRST — so a value failing both checks was disclosed by the shape error before the
    // screen ever saw it.
    const dir = projectWith(t, ["cortex-supportgraph"], (s) => {
      s.id = "cortex-supportgraph has spaces";
    });

    const r = runScript("write-build-html.mjs", [], dir);

    assert.doesNotMatch(
      r.all,
      /cortex-supportgraph/,
      `the token error quoted a value the screen exists to withhold\n${r.all}`,
    );
    assertCleanExit(r, EXIT.USAGE, "both-invalid: ");
    assert.match(
      r.all,
      /segments\[0\]\.id/,
      `and it must still say which field\n${r.all}`,
    );
  });

  test("writeBuildHtml_aFieldIdThatIsNotADomToken_isRefusedRatherThanInterpolatedIntoAnIdAttribute", (t) => {
    // fields/hotspots are interpolated into `id="…"` UNESCAPED at :422/:424 and assertTok
    // never covered them, so a quote could close the attribute.
    const dir = projectWith(t, [], (s) => {
      s.visual.fields = [{ id: 'a" onload="x', x: 10, y: 10 }];
    });

    const r = runScript("write-build-html.mjs", [], dir);

    assertCleanExit(r, EXIT.USAGE, "field-token: ");
    assert.match(
      r.all,
      /segments\[0\]\.visual\.fields\[0\]\.id/,
      `named by position\n${r.all}`,
    );
    assert.equal(fs.existsSync(path.join(dir, "video-auto.html")), false);
  });

  test("writeBuildHtml_aFootageClipIdMatchingANoGoPattern_isRefusedBeforeItShipsAsDataClip", (t) => {
    const dir = projectWith(t, ["cortex-supportgraph"], (s) => {
      s.visual.footage = { clipId: "cortex-supportgraph" };
    });

    const r = runScript("write-build-html.mjs", [], dir);

    assert.doesNotMatch(
      r.all,
      /cortex-supportgraph/,
      `clipId was quoted\n${r.all}`,
    );
    assertCleanExit(r, EXIT.USAGE, "clipId: ");
    assert.match(
      r.all,
      /segments\[0\]\.visual\.footage\.clipId/,
      `named by position\n${r.all}`,
    );
  });

  test("writeBuildHtml_aTriggerTargetMatchingANoGoPattern_isRefusedBeforeItIsQuotedOrShipped", (t) => {
    const dir = projectWith(t, ["cortex-supportgraph"], (s) => {
      s.triggers = [
        { atMs: 100, target: "cortex-supportgraph", action: "rise" },
      ];
    });

    const r = runScript("write-build-html.mjs", [], dir);

    assert.doesNotMatch(
      r.all,
      /cortex-supportgraph/,
      `the trigger target was quoted\n${r.all}`,
    );
    assertCleanExit(r, EXIT.USAGE, "trigger: ");
    assert.match(
      r.all,
      /segments\[0\]\.triggers\[0\]\.target/,
      `named by position\n${r.all}`,
    );
  });

  test("writeBuildHtml_anAssembledJsonPathMatchingAPattern_doesNotShipInTheRenderedHtml", (t) => {
    // MEASURED before this check: pattern `foo.bar`, data {foo:{bar:"safe"}} — no key and no
    // value matches, the build exited 0, and `data-path="foo.bar"` was written into
    // video-auto.html by jsonHtml at :441.
    const dir = projectWith(t, ["foo.bar"], (s) => {
      s.visual.json = { foo: { bar: "safe" } };
    });

    const r = runScript("write-build-html.mjs", ["--apply"], dir);

    assert.notEqual(
      r.code,
      EXIT.OK,
      `the assembled path must refuse, got ${r.code}\n${r.all}`,
    );
    const out = path.join(dir, "video-auto.html");
    assert.equal(fs.existsSync(out), false, "and nothing may be written");
  });

  test("writeBuildHtml_anOrdinaryAssembledPath_stillShipsNormally", (t) => {
    // THE COUNTER-CASE — screening assembled paths must not refuse ordinary nesting.
    const dir = projectWith(t, ["cortex-supportgraph"], (s) => {
      s.visual.json = { foo: { bar: "safe" } };
    });

    const r = runScript("write-build-html.mjs", ["--apply"], dir);

    assert.equal(
      r.code,
      EXIT.OK,
      `an ordinary project must still build\n${r.all}`,
    );
    const html = fs.readFileSync(path.join(dir, "video-auto.html"), "utf8");
    assert.match(
      html,
      /data-path="foo\.bar"/,
      "and the path still ships, because it discloses nothing",
    );
  });
});

// ===========================================================================
// THE CEILING IS CLOSED. THESE WERE ITS PINS; THEY ARE NOW ITS REGRESSION SUITE.
//
// These tests previously asserted that a DERIVED string ships at EXIT.OK, because screening
// contributing inputs could not see one. Emission-point screening closed that, so they are
// repointed rather than deleted: the same inputs, the opposite expectation. They are the
// tests that fail if the closure is ever reverted.
//
// THE GUARD IS BEST-EFFORT BY DECISION. Closing this ceiling did not make screening
// complete, and it is not intended to become complete — 23 routes were closed across seven
// review rounds and the counts did not converge (4, 4, 3, 3, 2, 3, 4). Asked whether what
// remained was a finite tail, the reviewer answered "the remaining routes are not a finite
// tail closed by those chokepoints", and the owner ruled to stop there. See the POLICY block
// in src/write-build-html.mjs for the open classes. **Adding a new emission path without
// routing it through a screen reopens disclosure silently.**
//
// The controls are NOT duplicates of the refusal tests. Two tests asserting refusal would
// both be satisfied by a stage that refuses unconditionally, so they cannot tell "the
// ceiling is gone because screening works" from "everything refuses because screening
// broke". The controls prove a build whose pattern matches only engine scaffolding still
// succeeds. When the closure landed, the refusal tests flipped to red and the controls
// stayed green — exactly the signal they exist to give.
// ===========================================================================

describe("the closed ceiling: derived strings are screened where they are formed", () => {
  const build = (t, noGoPatterns, mutate) => {
    const seg = {
      id: "scenario",
      startMs: 0,
      endMs: 6000,
      voiceoverText: "one scenario field by field",
      visual: { mode: "code", title: "One scenario", json: { k: "v" } },
    };
    mutate(seg);
    const timing = JSON.parse(timingFixture([seg]));
    timing.project.noGoPatterns = noGoPatterns;
    const dir = makeProject(t, {
      "timing.json": JSON.stringify(timing),
      "evidence-pack/.gitkeep": "",
      "node_modules/gsap/dist/gsap.min.js": "/* stub */",
    });
    return {
      dir,
      run: () => runScript("write-build-html.mjs", ["--apply"], dir),
    };
  };

  test("aDerivedIdentifier_isNowScreenedWhereItIsFormed", (t) => {
    // THE WORKED EXAMPLE, REPOINTED. `scenario-label` never appears in timing.json: the id
    // is `scenario` and the engine concatenates the suffix at render time. No input screen
    // could ever see it; `elId()` screens the string at the moment it is formed, which is
    // the only place it exists. This test asserted EXIT.OK until that landed.
    const { dir, run } = build(t, ["scenario-label"], () => {});

    const r = run();

    assert.notEqual(
      r.code,
      EXIT.OK,
      `a derived identifier must be screened where it is formed\n${r.all}`,
    );
    assert.equal(
      fs.existsSync(path.join(dir, "video-auto.html")),
      false,
      "and the artefact that would have carried it is not written",
    );
  });

  test("anAssembledArrayPath_isNowScreenedBeforeItShips", (t) => {
    // The object-path form was already screened; the array branch was not. Both are now.
    const { dir, run } = build(t, ["foo\\[0\\]"], (s) => {
      s.visual.json = { foo: ["safe"] };
    });

    const r = run();

    assert.notEqual(
      r.code,
      EXIT.OK,
      `data-path="foo[0]" must not ship\n${r.all}`,
    );
    assert.equal(fs.existsSync(path.join(dir, "video-auto.html")), false);
  });

  test("screeningStillDiscriminates_aPatternMatchingOnlyScaffoldingStillBuilds", (t) => {
    // THE CONTROL, and it is doing more work now than it was.
    //
    // The two tests above assert REFUSAL, and a stage that refused unconditionally would
    // satisfy both — so on their own they cannot tell "the ceiling closed" from "screening
    // broke and now everything refuses". This distinguishes them: the real project's
    // `https?://` matches the generated document 62 times, every one of them engine
    // scaffolding, and it must still build.
    const { dir, run } = build(t, ["https?://"], () => {});

    const r = run();

    assert.equal(
      r.code,
      EXIT.OK,
      `scaffolding must never trip the guard, or the closure above is worthless\n${r.all}`,
    );
    const html = fs.readFileSync(path.join(dir, "video-auto.html"), "utf8");
    assert.match(
      html,
      /xmlns=['"]http/,
      "and the scaffolding it matched is still in the artefact",
    );
  });

  test("screeningStillDiscriminates_anOrdinaryObjectPathStillRefuses", (t) => {
    // The second half of the control: a route that was ALREADY screened before this change
    // must still be screened after it.
    const { run } = build(t, ["foo.bar"], (s) => {
      s.visual.json = { foo: { bar: "safe" } };
    });

    const r = run();

    assert.notEqual(
      r.code,
      EXIT.OK,
      `the assembled OBJECT path was screened before and must still be\n${r.all}`,
    );
  });
});

// ===========================================================================
// SCREENING AT THE POINT OF EMISSION.
//
// The ceiling was: screening CONTRIBUTING INPUTS cannot catch a DERIVED string, because the
// matching text exists nowhere in timing.json. The fix is NOT to scan the finished document
// — MEASURED, that is worse than doing nothing: the real project's own `https?://` pattern
// matches the generated HTML 62 times, and 62 of 62 are engine scaffolding (61 SVG `xmlns`
// + 1 w3.org ref) with ZERO author hits. A whole-document scan refuses the only real
// project we have, for nothing.
//
// Instead both author surfaces are screened where they are EMITTED, which is also the last
// place provenance still exists:
//   - `esc(value, where)` — every author string reaching the HTML. MEASURED: the 62
//     scaffolding matches never pass through it, so they cannot produce a false positive.
//   - `elId(value, where)` — the CONCATENATED identifier, screened as it is formed.
//
// BOTH DIRECTIONS ARE PROVEN BELOW. A suite that only proved refusals would be satisfied by
// a stage that refuses everything — the exact failure mode measured above.
// ===========================================================================

describe("author content is screened where it is emitted, and scaffolding is not", () => {
  const build = (t, noGoPatterns, mutate) => {
    const seg = {
      id: "scenario",
      startMs: 0,
      endMs: 6000,
      voiceoverText: "one scenario field by field",
      visual: { mode: "code", title: "One scenario", json: { k: "v" } },
    };
    mutate(seg);
    const timing = JSON.parse(timingFixture([seg]));
    timing.project.noGoPatterns = noGoPatterns;
    const dir = makeProject(t, {
      "timing.json": JSON.stringify(timing),
      "evidence-pack/.gitkeep": "",
      "node_modules/gsap/dist/gsap.min.js": "/* stub */",
    });
    return {
      dir,
      run: () => runScript("write-build-html.mjs", ["--apply"], dir),
    };
  };

  // ---- DIRECTION 1: protected text must be refused, wherever it is emitted ----

  test("writeBuildHtml_aProtectedStringInAVisibleTitle_isRefusedByPositionWithoutQuotingIt", (t) => {
    const { dir, run } = build(t, ["cortex-supportgraph"], (s) => {
      s.visual.title = "cortex-supportgraph rollout";
    });

    const r = run();

    assertCleanExit(r, EXIT.USAGE, "title: ");
    assert.doesNotMatch(
      r.all,
      /cortex-supportgraph/,
      `the title was quoted back\n${r.all}`,
    );
    assert.match(r.all, /segments\[0\]/, `named by position\n${r.all}`);
    assert.equal(fs.existsSync(path.join(dir, "video-auto.html")), false);
  });

  test("writeBuildHtml_aProtectedStringInAnAssembledArrayPath_isRefused", (t) => {
    const { run } = build(t, ["foo\\[0\\]"], (s) => {
      s.visual.json = { foo: ["safe"] };
    });

    const r = run();

    assert.notEqual(
      r.code,
      EXIT.OK,
      `data-path="foo[0]" must not ship\n${r.all}`,
    );
  });

  test("writeBuildHtml_aProtectedStringInAShotSource_isRefused", (t) => {
    // The file must EXIST, or `checkedSrc` drops the shot and nothing is emitted — in which
    // case not refusing is correct, and this test would be red for a reason that has
    // nothing to do with screening. It was, on the first attempt.
    const seg = {
      id: "scenario",
      startMs: 0,
      endMs: 6000,
      voiceoverText: "one scenario field by field",
      visual: {
        mode: "statement",
        title: "One scenario",
        shots: [
          { src: "evidence-pack/cortex-supportgraph.png", label: "a shot" },
        ],
      },
    };
    const timing = JSON.parse(timingFixture([seg]));
    timing.project.noGoPatterns = ["cortex-supportgraph"];
    const dir = makeProject(t, {
      "timing.json": JSON.stringify(timing),
      "evidence-pack/.gitkeep": "",
      "evidence-pack/cortex-supportgraph.png": "PNG",
      "node_modules/gsap/dist/gsap.min.js": "/* stub */",
    });

    const r = runScript("write-build-html.mjs", ["--apply"], dir);

    assert.notEqual(
      r.code,
      EXIT.OK,
      `an evidence src must not ship unscreened\n${r.all}`,
    );
    assert.doesNotMatch(
      r.all,
      /cortex-supportgraph/,
      `nor be quoted\n${r.all}`,
    );
  });

  // ---- DIRECTION 2: the engine's own scaffolding must NOT be refused ----

  test("writeBuildHtml_theRealProjectsOwnNinePatterns_stillBuild", (t) => {
    // The full realistic list, not a representative one. Eight match nothing; the ninth
    // (`https?://`) matches 62 scaffolding sites and must still build.
    const { run } = build(
      t,
      [
        "cortex-supportgraph",
        "[-.]ppe\\b",
        "\\bppe[-.]",
        "\\btest[12]\\b",
        "microsoft-ppe\\.com",
        "frontieragentcatalog",
        "https?://",
        "\\b[a-z0-9-]+\\.(com|net|io|azure|microsoft)\\b",
        "\\b!?16\\d{5}\\b",
      ],
      () => {},
    );

    const r = run();

    assert.equal(
      r.code,
      EXIT.OK,
      `the real project's own pattern list must still build\n${r.all}`,
    );
  });

  test("writeBuildHtml_anEngineFallbackIsScreenedToo_becauseItShipsInTheArtefact", (t) => {
    // A DELIBERATE DECISION. `v.title || seg.title || 'Demo'` renders the engine's own word
    // when the author supplies none. The line is not visibility — `data-path` is screened
    // and is never visible — it is PROVENANCE PLUS SHIPPING: author text, or engine text
    // standing in for it, all of which is written into the artefact. `xmlns` is neither.
    const { run } = build(t, ["SizzleCraft"], (s) => {
      s.visual.mode = "statement";
      delete s.visual.title;
    });

    const r = run();

    assert.notEqual(
      r.code,
      EXIT.OK,
      `fallback text still ships in the artefact\n${r.all}`,
    );
  });
});

// ===========================================================================
// THE COMPLETENESS GUARD — AND IT IS A GUARD, NOT A PROOF.
//
// Emission-point screening is only as complete as its call sites. A site that interpolates
// author text into the HTML without going through `esc()` or `elId()` is a silent hole, and
// a silent hole is the same defect class as the ceiling this replaced.
//
// IT DOES NOT DETECT:
//   1. Anything on its own allowlist. The check must skip genuinely safe interpolations —
//      numeric geometry, engine-computed fragments, loop counters. That allowlist is
//      HAND-MAINTAINED, so a name added to it silently widens what the guard ignores. THIS
//      HAS ALREADY HAPPENED ONCE: `codePathId` was listed as a screening helper when it only
//      BUILDS an id, so the guard waved through `id="${codePathId(segId, p)}"`. A reviewer
//      found it, not the guard. An allowlist rots exactly like the prose it replaced.
//   2. Author text reaching the artefact other than through a template interpolation in this
//      file — a value written via `jsonScript`, or assembled in a helper and returned whole.
//   3. Whether the `where` label at a site is ACCURATE. It checks that provenance is
//      supplied, not that it is correct.
//
// So: it makes a regression loud, and it does not make the screening complete.
// ===========================================================================

describe("every author interpolation into the HTML goes through a screening helper", () => {
  const SAFE = new Set([
    "x",
    "y",
    "nw",
    "nh",
    "w",
    "h",
    "ax",
    "ay",
    "bx",
    "by",
    "i",
    "j",
    "k",
    "idx",
    "n",
    "depth",
    "inner",
    "cards",
    "shots",
    "fields",
    "hotspots",
    "slideHtml",
    "endCardSlide",
    "runtime",
    "css",
    "gsapInline",
    "block",
    "marker",
    "arrowDims",
    "st",
    "cstyle",
    "items",
    "seq",
    "out",
    "paths",
    "hs",
    "at",
    "base",
    "eid",
    "prefix",
    "m",
    "mode",
    "pad(depth)",
    "statCls",
    "fit",
  ]);
  // ONLY ACTUAL SCREENING HELPERS BELONG HERE. `codePathId` was listed once — it BUILDS an
  // id and screens nothing — and the guard waved its bypass through. `String(` and `Number(`
  // were listed for the same bad reason: they convert, they do not screen, so
  // `id="${String(seg.id)}"` would have passed. Both rounds of that mistake were caught by a
  // reviewer rather than by this guard, which is note 1 of its DOES NOT DETECT list earning
  // its place twice over. Removing them was free — measured: no site relies on either.
  const SCREENED = /^(esc|elId)\(/;

  test("everyGeneratedElementId_goesThroughTheScreeningHelpers", () => {
    const stage = new URL("../src/write-build-html.mjs", import.meta.url);
    const src = fs.readFileSync(stage, "utf8").split(/\r?\n/);
    const bypasses = [];
    src.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (!/id="\$\{/.test(line)) return;
      for (const m of line.matchAll(/id="\$\{([^}]+)\}/g)) {
        const expr = m[1].trim();
        if (SCREENED.test(expr) || SAFE.has(expr)) continue;
        bypasses.push(`:${i + 1}  ${expr.slice(0, 60)}`);
      }
    });

    assert.deepEqual(
      bypasses,
      [],
      "these element ids are emitted without passing through elId()/esc():\n  " +
        bypasses.join("\n  "),
    );
  });

  test("theCompletenessGuardItself_failsWhenABypassIsIntroduced", () => {
    // THE POSITIVE CONTROL. A guard that cannot fail is decoration — and this one scans
    // text, so it is exactly the kind that silently matches nothing.
    //
    // The `String(...)` case is here because it was a REAL hole: `String` sat in the
    // allowlist as though it screened something, when it only converts.
    const planted = [
      'const a = `<div id="${seg.id}-planted">`;',
      'const b = `<div id="${String(seg.id)}">`;',
    ];
    const bypasses = [];
    planted.forEach((line) => {
      for (const m of line.matchAll(/id="\$\{([^}]+)\}/g)) {
        const expr = m[1].trim();
        if (SCREENED.test(expr) || SAFE.has(expr)) continue;
        bypasses.push(expr);
      }
    });

    assert.equal(
      bypasses.length,
      2,
      "the guard must report both planted bypasses",
    );
    assert.match(bypasses[0], /seg\.id/);
    assert.match(
      bypasses[1],
      /^String\(/,
      "a converter is not a screening helper",
    );
  });
});

// THREE ROUTES A REVIEWER FOUND AFTER THE FIRST EMISSION PASS, each measured.
//
// Each was reachable WITH emission screening already in place, and one was waved through by
// my own completeness guard — see its allowlist note.
describe("emission screening reaches the derived id, the payload and the null literal", () => {
  const build = (t, noGoPatterns, mutate) => {
    const seg = {
      id: "scenario",
      startMs: 0,
      endMs: 6000,
      voiceoverText: "one scenario field by field",
      visual: { mode: "code", title: "One scenario", json: { safe: "v" } },
    };
    mutate(seg);
    const timing = JSON.parse(timingFixture([seg]));
    timing.project.noGoPatterns = noGoPatterns;
    const dir = makeProject(t, {
      "timing.json": JSON.stringify(timing),
      "evidence-pack/.gitkeep": "",
      "node_modules/gsap/dist/gsap.min.js": "/* stub */",
    });
    return {
      dir,
      run: () => runScript("write-build-html.mjs", ["--apply"], dir),
    };
  };

  test("writeBuildHtml_aPatternMatchingOnlyTheDerivedCodePathId_isRefused", (t) => {
    // `scenario-path-safe` matches neither the segment id, nor the key, nor the JSON path —
    // only the id `codePathId()` assembles from them. It shipped at exit 0 before this.
    const { dir, run } = build(t, ["scenario-path-safe"], () => {});

    const r = run();

    assert.notEqual(
      r.code,
      EXIT.OK,
      `a derived code-path id must be screened\n${r.all}`,
    );
    assert.equal(fs.existsSync(path.join(dir, "video-auto.html")), false);
  });

  test("writeBuildHtml_aPatternMatchingAnExplicitTriggerPayload_isRefused", (t) => {
    // The payload is serialised into `elementTriggers` and the runtime paints it into a
    // callout. `jsonScript` makes that embedding script-safe; it says nothing about whether
    // the text belongs on screen.
    const { run } = build(t, ["cortex-supportgraph"], (s) => {
      s.triggers = [
        {
          atMs: 100,
          target: "scenario-label",
          action: "callout",
          payload: { text: "cortex-supportgraph" },
        },
      ];
    });

    const r = run();

    assertCleanExit(r, EXIT.USAGE, "payload: ");
    assert.doesNotMatch(
      r.all,
      /cortex-supportgraph/,
      `and must not be quoted back\n${r.all}`,
    );
    assert.match(
      r.all,
      /segments\[0\]\.triggers\[0\]\.payload\.text/,
      `named by position\n${r.all}`,
    );
  });

  test("writeBuildHtml_anOrdinaryTriggerPayload_stillBuilds", (t) => {
    // THE CONTROL — screening payloads must not refuse every project that uses one.
    const { run } = build(t, ["cortex-supportgraph"], (s) => {
      s.triggers = [
        {
          atMs: 100,
          target: "scenario-label",
          action: "callout",
          payload: { text: "a harmless caption" },
        },
      ];
    });

    const r = run();

    assert.equal(
      r.code,
      EXIT.OK,
      `an ordinary payload must still build\n${r.all}`,
    );
  });
});

// TWO MORE, BOTH FOUND BY THE REVIEWER AFTER THE PAYLOAD AND ID ROUTES WERE CLOSED.
describe("screening covers non-string payloads and unwalked diagnostic paths", () => {
  const build = (t, noGoPatterns, mutate) => {
    const seg = {
      id: "scenario",
      startMs: 0,
      endMs: 6000,
      voiceoverText: "one scenario field by field",
      visual: { mode: "code", title: "One scenario", json: { safe: "v" } },
    };
    mutate(seg);
    const timing = JSON.parse(timingFixture([seg]));
    timing.project.noGoPatterns = noGoPatterns;
    const dir = makeProject(t, {
      "timing.json": JSON.stringify(timing),
      "evidence-pack/.gitkeep": "",
      "node_modules/gsap/dist/gsap.min.js": "/* stub */",
    });
    return {
      dir,
      run: () => runScript("write-build-html.mjs", ["--apply"], dir),
    };
  };

  test("writeBuildHtml_aNumericTriggerPayload_isScreenedLikeAString", (t) => {
    // The runtime stringifies whatever it paints, so `4471` reaches the frame as "4471".
    // Screening only `typeof === 'string'` would repeat the coercion bug the shape predicate
    // exists to prevent, in a new place.
    const { run } = build(t, ["4471"], (s) => {
      s.triggers = [
        {
          atMs: 100,
          target: "scenario-label",
          action: "callout",
          payload: { text: 4471 },
        },
      ];
    });

    const r = run();

    assert.notEqual(
      r.code,
      EXIT.OK,
      `a numeric payload still reaches the frame\n${r.all}`,
    );
  });

  test("writeBuildHtml_aNonexistentHighlightPath_isScreenedBeforeItIsQuoted", (t) => {
    // This path does NOT exist in the JSON, so the no-go walk never saw it — and the
    // "does not exist" diagnostic quotes it back.
    const { run } = build(t, ["cortex-supportgraph"], (s) => {
      s.visual.highlights = [{ path: "cortex-supportgraph" }];
    });

    const r = run();

    assert.notEqual(r.code, EXIT.OK, `it must refuse\n${r.all}`);
    assert.doesNotMatch(
      r.all,
      /cortex-supportgraph/,
      `an unwalked path must not be quoted into the diagnostic\n${r.all}`,
    );
  });

  test("writeBuildHtml_anOrdinaryNonexistentHighlightPath_stillSaysWhatIsWrong", (t) => {
    // THE CONTROL — screening must not turn a helpful "does not exist" error into silence.
    const { run } = build(t, ["cortex-supportgraph"], (s) => {
      s.visual.highlights = [{ path: "nope" }];
    });

    const r = run();

    assert.notEqual(r.code, EXIT.OK, `a bad path must still refuse\n${r.all}`);
    assert.match(
      r.all,
      /does not exist/,
      `and must still explain itself\n${r.all}`,
    );
  });
});

// THREE MORE FROM REVIEW ROUND 3. Two are the SAME CLASS — an author value quoted in a
// diagnostic that the no-go walk never ran on — which is why the fix for each is "screen it
// before the message is built", not "stop quoting it".
//
// WHY THERE IS NO STATIC GUARD FOR THIS CLASS, unlike the element-id one: MEASURED, seven
// author-shaped values are interpolated into CliError messages in this stage, and all seven
// are SAFE because they are screened upstream. A scanner cannot see an upstream screen, so it
// would report all seven as violations. A guard that flags correct code gets switched off,
// and an allowlist of the seven is the same rot one level up. The invariant is therefore held
// by the tests below and by the comments at each screening site, and that is stated plainly
// rather than dressed up as automation.
describe("author values are screened before any diagnostic quotes them", () => {
  const build = (t, noGoPatterns, mutate) => {
    const seg = {
      id: "scenario",
      startMs: 0,
      endMs: 6000,
      voiceoverText: "one scenario field by field",
      visual: { mode: "code", title: "One scenario", json: { safe: "v" } },
    };
    mutate(seg);
    const timing = JSON.parse(timingFixture([seg]));
    timing.project.noGoPatterns = noGoPatterns;
    const dir = makeProject(t, {
      "timing.json": JSON.stringify(timing),
      "evidence-pack/.gitkeep": "",
      "node_modules/gsap/dist/gsap.min.js": "/* stub */",
    });
    return {
      dir,
      run: () => runScript("write-build-html.mjs", ["--apply"], dir),
    };
  };

  test("writeBuildHtml_anArrayTriggerPayload_isScreenedOnWhatTheRuntimeWouldPaint", (t) => {
    // MEASURED: String(['protected-value']) === 'protected-value'. Skipping arrays because
    // they are `typeof 'object'` let the painted text through unscreened.
    const { run } = build(t, ["cortex-supportgraph"], (s) => {
      s.triggers = [
        {
          atMs: 100,
          target: "scenario-label",
          action: "callout",
          payload: { text: ["cortex-supportgraph"] },
        },
      ];
    });

    const r = run();

    assert.notEqual(
      r.code,
      EXIT.OK,
      `an array payload paints its contents\n${r.all}`,
    );
    assert.doesNotMatch(
      r.all,
      /cortex-supportgraph/,
      `and must not be quoted back\n${r.all}`,
    );
  });

  test("writeBuildHtml_aDisclosingJsonFilePath_isScreenedBeforeTheNotFoundMessageQuotesIt", (t) => {
    // A MISSING file is exactly the case where the no-go walk never runs, and the refusal
    // names the path.
    const { run } = build(t, ["cortex-supportgraph"], (s) => {
      delete s.visual.json;
      s.visual.jsonFile = "cortex-supportgraph.json";
    });

    const r = run();

    assert.notEqual(r.code, EXIT.OK, `it must refuse\n${r.all}`);
    assert.doesNotMatch(
      r.all,
      /cortex-supportgraph/,
      `the jsonFile path was quoted into the diagnostic unscreened\n${r.all}`,
    );
  });

  test("writeBuildHtml_anOrdinaryMissingJsonFile_stillSaysWhatIsWrong", (t) => {
    // THE CONTROL — screening must not turn a useful "not found" into silence.
    const { run } = build(t, ["cortex-supportgraph"], (s) => {
      delete s.visual.json;
      s.visual.jsonFile = "absent.json";
    });

    const r = run();

    assert.notEqual(
      r.code,
      EXIT.OK,
      `a missing file must still refuse\n${r.all}`,
    );
    assert.match(
      r.all,
      /not found|jsonFile/,
      `and must still explain itself\n${r.all}`,
    );
  });

  test("writeBuildHtml_aNonNumericFrameDimension_isRefusedRatherThanInterpolated", (t) => {
    // `|| 3840` accepted any truthy value, so a string reached a CSS rule and a `content=`
    // attribute — markup injection as well as an unscreened author string. Same "truthy is
    // not valid" shape as the no-go list once accepting `[123]`.
    const seg = {
      id: "scenario",
      startMs: 0,
      endMs: 6000,
      voiceoverText: "one scenario field by field",
      visual: { mode: "code", title: "One scenario", json: { safe: "v" } },
    };
    const timing = JSON.parse(timingFixture([seg]));
    timing.project.noGoPatterns = [];
    timing.project.width = '3840"><script>x</script>';
    const dir = makeProject(t, {
      "timing.json": JSON.stringify(timing),
      "evidence-pack/.gitkeep": "",
      "node_modules/gsap/dist/gsap.min.js": "/* stub */",
    });

    const r = runScript("write-build-html.mjs", ["--apply"], dir);

    assertCleanExit(r, EXIT.USAGE, "width: ");
    assert.match(r.all, /project\.width/, `named by position\n${r.all}`);
    assert.equal(fs.existsSync(path.join(dir, "video-auto.html")), false);
  });

  test("writeBuildHtml_ordinaryFrameDimensions_stillBuild", (t) => {
    // THE CONTROL — a real project sets these, and they must keep working.
    const { run } = build(t, [], () => {});

    const r = run();

    assert.equal(
      r.code,
      EXIT.OK,
      `ordinary dimensions must still build\n${r.all}`,
    );
  });
});

// ROUND 4. Two of these are again "a diagnostic quotes an author value the walk never saw",
// which is why the fix this time is MECHANISM, not another site: `quoted(value, where)`
// screens by the act of formatting, so forgetting to screen first is unrepresentable rather
// than merely discouraged. The reviewer proposed it after I had measured and rejected a
// static scanner for the same class — the scanner could not see upstream screens and flagged
// all seven safe sites.
describe("screening is enforced by the act of quoting, and covers action and dimensions", () => {
  const build = (t, noGoPatterns, mutate) => {
    const seg = {
      id: "scenario",
      startMs: 0,
      endMs: 6000,
      voiceoverText: "one scenario field by field",
      visual: { mode: "code", title: "One scenario", json: { safe: "v" } },
    };
    mutate(seg);
    const timing = JSON.parse(timingFixture([seg]));
    timing.project.noGoPatterns = noGoPatterns;
    const dir = makeProject(t, {
      "timing.json": JSON.stringify(timing),
      "evidence-pack/.gitkeep": "",
      "node_modules/gsap/dist/gsap.min.js": "/* stub */",
    });
    return {
      dir,
      run: () => runScript("write-build-html.mjs", ["--apply"], dir),
    };
  };

  test("writeBuildHtml_aDisclosingStartMs_isScreenedBeforeTheTimelineDiagnosticQuotesIt", (t) => {
    const { run } = build(t, ["cortex-supportgraph"], (s) => {
      s.startMs = "cortex-supportgraph";
    });

    const r = run();

    assert.notEqual(r.code, EXIT.OK, `an unusable time must refuse\n${r.all}`);
    assert.doesNotMatch(
      r.all,
      /cortex-supportgraph/,
      `the timeline diagnostic quoted an unscreened author value\n${r.all}`,
    );
  });

  test("writeBuildHtml_anOrdinaryBadStartMs_stillSaysWhatIsWrong", (t) => {
    // THE CONTROL — screening must not turn a useful diagnostic into silence.
    const { run } = build(t, ["cortex-supportgraph"], (s) => {
      s.startMs = "not-a-number";
    });

    const r = run();

    assert.notEqual(r.code, EXIT.OK, `it must still refuse\n${r.all}`);
    assert.match(r.all, /startMs/, `and must still name the field\n${r.all}`);
  });

  test("writeBuildHtml_aDisclosingTriggerAction_isRefusedBeforeItShipsAsKind", (t) => {
    // `action` is serialised as `kind` into elementTriggers and ships; the payload is not the
    // only part of a trigger that leaves the build.
    const { run } = build(t, ["cortex-supportgraph"], (s) => {
      s.triggers = [
        { atMs: 100, target: "scenario-label", action: "cortex-supportgraph" },
      ];
    });

    const r = run();

    assert.notEqual(
      r.code,
      EXIT.OK,
      `a disclosing action must refuse\n${r.all}`,
    );
    assert.doesNotMatch(
      r.all,
      /cortex-supportgraph/,
      `and must not be quoted\n${r.all}`,
    );
  });

  test("writeBuildHtml_anOrdinaryTriggerAction_stillBuilds", (t) => {
    // THE CONTROL — every project uses actions.
    const { run } = build(t, ["cortex-supportgraph"], (s) => {
      s.triggers = [{ atMs: 100, target: "scenario-label", action: "rise" }];
    });

    const r = run();

    assert.equal(
      r.code,
      EXIT.OK,
      `an ordinary action must still build\n${r.all}`,
    );
  });

  test("writeBuildHtml_aFractionalFrameDimension_isRefusedBecauseTheMessageSaysWholePixels", (t) => {
    // The bound and its own wording disagreed: `raw <= 0` admitted 0.5 while the refusal
    // promised 1..16384. A message that is not true of the check is the prose-drift defect
    // in executable form.
    const seg = {
      id: "scenario",
      startMs: 0,
      endMs: 6000,
      voiceoverText: "one scenario field by field",
      visual: { mode: "code", title: "One scenario", json: { safe: "v" } },
    };
    const timing = JSON.parse(timingFixture([seg]));
    timing.project.noGoPatterns = [];
    timing.project.width = 0.5;
    const dir = makeProject(t, {
      "timing.json": JSON.stringify(timing),
      "evidence-pack/.gitkeep": "",
      "node_modules/gsap/dist/gsap.min.js": "/* stub */",
    });

    const r = runScript("write-build-html.mjs", ["--apply"], dir);

    assertCleanExit(r, EXIT.USAGE, "fractional width: ");
    assert.match(
      r.all,
      /whole number of pixels/,
      `and the message must match the check\n${r.all}`,
    );
  });
});

// ROUND 5. Both of these are the SAME ROOT as `[123]` becoming the live pattern `/123/i`:
// trusting a coercion, or a hand-written list, instead of the thing that actually ships.
// The fixes REMOVE the lists rather than extending them.
describe("everything serialised into the trigger data is screened, not a list of field names", () => {
  const build = (t, noGoPatterns, mutate) => {
    const seg = {
      id: "scenario",
      startMs: 0,
      endMs: 6000,
      voiceoverText: "one scenario field by field",
      visual: { mode: "code", title: "One scenario", json: { safe: "v" } },
    };
    mutate(seg);
    const timing = JSON.parse(timingFixture([seg]));
    timing.project.noGoPatterns = noGoPatterns;
    const dir = makeProject(t, {
      "timing.json": JSON.stringify(timing),
      "evidence-pack/.gitkeep": "",
      "node_modules/gsap/dist/gsap.min.js": "/* stub */",
    });
    return {
      dir,
      run: () => runScript("write-build-html.mjs", ["--apply"], dir),
    };
  };

  test("writeBuildHtml_aPayloadFieldOutsideTheOldFieldList_isScreened", (t) => {
    // `extra` was in no list, and the WHOLE payload is serialised into elementTriggers.
    const { run } = build(t, ["cortex-supportgraph"], (s) => {
      s.triggers = [
        {
          atMs: 100,
          target: "scenario-label",
          action: "callout",
          payload: { extra: "cortex-supportgraph" },
        },
      ];
    });

    const r = run();

    assert.notEqual(
      r.code,
      EXIT.OK,
      `an unlisted payload field still ships\n${r.all}`,
    );
    assert.doesNotMatch(
      r.all,
      /cortex-supportgraph/,
      `and must not be quoted\n${r.all}`,
    );
  });

  test("writeBuildHtml_aPayloadNestedInsideAnArrayInsideAnObject_isScreened", (t) => {
    const { run } = build(t, ["cortex-supportgraph"], (s) => {
      s.triggers = [
        {
          atMs: 100,
          target: "scenario-label",
          action: "callout",
          payload: { chain: [{ deep: "cortex-supportgraph" }] },
        },
      ];
    });

    const r = run();

    assert.notEqual(r.code, EXIT.OK, `nesting is not a hiding place\n${r.all}`);
  });

  test("writeBuildHtml_anObjectValuedTriggerTarget_isRefusedRatherThanCoerced", (t) => {
    // `String({id:'…'})` is `[object Object]`, which discloses nothing and passes — while the
    // object's properties serialise unchanged and ship.
    const { run } = build(t, ["cortex-supportgraph"], (s) => {
      s.triggers = [
        { atMs: 100, target: { id: "cortex-supportgraph" }, action: "rise" },
      ];
    });

    const r = run();

    assertCleanExit(r, EXIT.USAGE, "object target: ");
    assert.doesNotMatch(
      r.all,
      /cortex-supportgraph/,
      `and must not be quoted\n${r.all}`,
    );
    assert.match(
      r.all,
      /must be a string/,
      `and must say what is wrong\n${r.all}`,
    );
  });

  test("writeBuildHtml_anOrdinaryRichPayload_stillBuilds", (t) => {
    // THE CONTROL. Recursive screening must not refuse every project that uses a payload —
    // and this one has an unlisted field, a nested object and an array, all harmless.
    const { run } = build(t, ["cortex-supportgraph"], (s) => {
      s.triggers = [
        {
          atMs: 100,
          target: "scenario-label",
          action: "callout",
          payload: {
            text: "a caption",
            extra: "fine",
            chain: [{ deep: "also fine" }],
            n: 7,
          },
        },
      ];
    });

    const r = run();

    assert.equal(
      r.code,
      EXIT.OK,
      `an ordinary rich payload must still build\n${r.all}`,
    );
  });
});

// ROUND 6. All three are the same family again: a derived or structural string that ships,
// and that the screen reached only by coincidence of where it was looked for.
describe("keys, modes and every serialised trigger target are screened", () => {
  const build = (t, noGoPatterns, mutate) => {
    const seg = {
      id: "scenario",
      startMs: 0,
      endMs: 6000,
      voiceoverText: "one scenario field by field",
      visual: { mode: "code", title: "One scenario", json: { safe: "v" } },
    };
    mutate(seg);
    const timing = JSON.parse(timingFixture([seg]));
    timing.project.noGoPatterns = noGoPatterns;
    const dir = makeProject(t, {
      "timing.json": JSON.stringify(timing),
      "evidence-pack/.gitkeep": "",
      "node_modules/gsap/dist/gsap.min.js": "/* stub */",
    });
    return {
      dir,
      run: () => runScript("write-build-html.mjs", ["--apply"], dir),
    };
  };

  test("writeBuildHtml_aProtectedPayloadKeyWithAHarmlessValue_isScreened", (t) => {
    // The KEY serialises verbatim. Walking only values repeats, in the payload, the
    // matching-key defect already fixed in the code-block walk.
    const { run } = build(t, ["cortex-supportgraph"], (s) => {
      s.triggers = [
        {
          atMs: 100,
          target: "scenario-label",
          action: "callout",
          payload: { "cortex-supportgraph": "safe" },
        },
      ];
    });

    const r = run();

    assert.notEqual(r.code, EXIT.OK, `a payload KEY ships too\n${r.all}`);
    assert.doesNotMatch(
      r.all,
      /cortex-supportgraph/,
      `and must not be quoted\n${r.all}`,
    );
  });

  test("writeBuildHtml_anUnknownVisualMode_isRefusedRatherThanInterpolated", (t) => {
    // `v.mode` reached `data-mode` and a class name unescaped, so an unknown value was both
    // injection and an unscreened author string.
    const { run } = build(t, [], (s) => {
      s.visual.mode = 'code" onload="x';
    });

    const r = run();

    assertCleanExit(r, EXIT.USAGE, "mode: ");
    assert.match(r.all, /visual\.mode/, `named by position\n${r.all}`);
  });

  test("writeBuildHtml_anOrdinaryVisualMode_stillBuilds", (t) => {
    // THE CONTROL — every project sets a mode.
    const { run } = build(t, [], (s) => {
      s.visual.mode = "statement";
    });

    const r = run();

    assert.equal(
      r.code,
      EXIT.OK,
      `a supported mode must still build\n${r.all}`,
    );
  });

  test("writeBuildHtml_aDerivedTriggerTargetWithNoRenderedElement_isStillScreened", (t) => {
    // `${seg.id}-title` is serialised into elementTriggers by autoTriggers whether or not a
    // title element is rendered, so screening at `elId()` reached only the subset that
    // became DOM. Screening now happens where they are serialised.
    const { run } = build(t, ["scenario-title"], () => {});

    const r = run();

    assert.notEqual(
      r.code,
      EXIT.OK,
      `a derived trigger target ships regardless\n${r.all}`,
    );
  });

  test("writeBuildHtml_ordinaryDerivedTriggerTargets_stillBuild", (t) => {
    // THE CONTROL — every segment generates these targets, so over-screening them would
    // refuse every project.
    const { run } = build(t, ["cortex-supportgraph"], () => {});

    const r = run();

    assert.equal(
      r.code,
      EXIT.OK,
      `ordinary generated targets must still build\n${r.all}`,
    );
  });
});

// ROUND 7. The reviewer's verdict on my own question was that these are NOT a finite tail —
// and these four bear that out: a coercion the target fix did not cover, a disclosure inside
// the screen's own label, and two more unguarded top-level throws.
describe("round 7: coercion, the screens own label, and unguarded top-level throws", () => {
  const build = (t, noGoPatterns, mutate) => {
    const seg = {
      id: "scenario",
      startMs: 0,
      endMs: 6000,
      voiceoverText: "one scenario field by field",
      visual: { mode: "code", title: "One scenario", json: { safe: "v" } },
    };
    mutate(seg);
    const timing = JSON.parse(timingFixture([seg]));
    timing.project.noGoPatterns = noGoPatterns;
    const dir = makeProject(t, {
      "timing.json": JSON.stringify(timing),
      "evidence-pack/.gitkeep": "",
      "node_modules/gsap/dist/gsap.min.js": "/* stub */",
    });
    return {
      dir,
      run: () => runScript("write-build-html.mjs", ["--apply"], dir),
    };
  };

  test("writeBuildHtml_anObjectValuedTriggerAction_isRefusedRatherThanCoerced", (t) => {
    // `String({…})` is `[object Object]` — discloses nothing, passes, ships with keys intact.
    // The same rule as `target`, which this fix did not originally cover.
    const { run } = build(t, ["cortex-supportgraph"], (s) => {
      s.triggers = [
        {
          atMs: 100,
          target: "scenario-label",
          action: { "cortex-supportgraph": 1 },
        },
      ];
    });

    const r = run();

    assertCleanExit(r, EXIT.USAGE, "object action: ");
    assert.doesNotMatch(
      r.all,
      /cortex-supportgraph/,
      `and must not be quoted\n${r.all}`,
    );
  });

  test("writeBuildHtml_aNestedPayloadRefusal_doesNotDiscloseThePathInItsOwnMessage", (t) => {
    // The screen built its location label from the keys it walked, so refusing
    // `{foo:{bar:"foo.bar"}}` under pattern `foo.bar` printed the match in the message
    // announcing it. A guard that discloses what it refuses — inside the guard.
    const { run } = build(t, ["foo\\.bar"], (s) => {
      s.triggers = [
        {
          atMs: 100,
          target: "scenario-label",
          action: "callout",
          payload: { foo: { bar: "foo.bar" } },
        },
      ];
    });

    const r = run();

    assert.notEqual(r.code, EXIT.OK, `it must refuse\n${r.all}`);
    assert.doesNotMatch(
      r.all,
      /foo\.bar/,
      `the screen's own label disclosed the match\n${r.all}`,
    );
  });

  test("writeBuildHtml_anUnparseableTimingJson_refusesBySizeWithoutQuotingBytes", (t) => {
    // V8's SyntaxError quotes bytes of the input, and this parse was at module top level, so
    // the first thing the stage reads could disclose through a stack.
    const dir = makeProject(t, {
      "timing.json": "LEAKSENTINEL7f3a: not json at all",
      "evidence-pack/.gitkeep": "",
      "node_modules/gsap/dist/gsap.min.js": "/* stub */",
    });

    const r = runScript("write-build-html.mjs", [], dir);

    assertCleanExit(r, EXIT.USAGE, "unparseable: ");
    assert.doesNotMatch(
      r.all,
      /LEAKSENTINEL/,
      `the parser quoted input bytes\n${r.all}`,
    );
    assert.match(
      r.all,
      /characters/,
      `and it must report the file by size\n${r.all}`,
    );
  });

  test("writeBuildHtml_anOrdinaryProject_stillBuilds_afterAllOfThis", (t) => {
    // THE STANDING CONTROL for the whole task: every refusal added above must leave a
    // correct project building.
    const { run } = build(t, ["cortex-supportgraph"], () => {});

    const r = run();

    assert.equal(
      r.code,
      EXIT.OK,
      `a correct project must still build\n${r.all}`,
    );
  });
});
