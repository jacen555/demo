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

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { EXIT, CliError, createBoundary, readLockOwner } from '../src/cli-support.mjs';
import { videoStreamVerdict } from '../src/remux-verify.mjs';
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
} from './_helpers.mjs';

const SENTINEL = 'SENTINEL — MUST SURVIVE';
const captureFiles = { 'video-auto.html': '<html><body><div id="stage"></div></body></html>' };

// ---------------------------------------------------------------------------
// frame-capture: the containment check permits an IN-ROOT link, but the value it
// guards is a recursive delete. In-root is not the same as safe-to-delete.
// ---------------------------------------------------------------------------
describe('frame-capture deletion target', () => {
  test('frameCapture_framesLinkedToProjectRoot_refusesWithoutDeleting', (t) => {
    const dir = makeProject(t, { ...captureFiles, 'timing.json': timingFixture(), 'keepme.txt': SENTINEL });
    if (!tryMakeDirLink(path.join(dir, 'frames'), dir)) return t.skip('platform refused to create a directory link');

    const r = runScript('frame-capture.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.USAGE, 'deleting through a link to the project root must be refused: ');
    assert.equal(fs.readFileSync(path.join(dir, 'keepme.txt'), 'utf8'), SENTINEL);
    assert.equal(fs.existsSync(path.join(dir, 'timing.json')), true, 'the project root must still be intact');
  });

  test('frameCapture_framesLinkedToAnotherInRootDirectory_refusesWithoutDeleting', (t) => {
    const dir = makeProject(t, {
      ...captureFiles,
      'timing.json': timingFixture(),
      'assets/precious.bin': SENTINEL,
    });
    if (!tryMakeDirLink(path.join(dir, 'frames'), path.join(dir, 'assets'))) {
      return t.skip('platform refused to create a directory link');
    }

    const r = runScript('frame-capture.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.USAGE, 'the wipe target must be the real frames directory: ');
    assert.equal(fs.readFileSync(path.join(dir, 'assets', 'precious.bin'), 'utf8'), SENTINEL);
  });

  test('frameCapture_framesLinkedInRoot_refusedOnAPlanRunToo', (t) => {
    const dir = makeProject(t, { ...captureFiles, 'timing.json': timingFixture(), 'assets/x.bin': 'x' });
    if (!tryMakeDirLink(path.join(dir, 'frames'), path.join(dir, 'assets'))) {
      return t.skip('platform refused to create a directory link');
    }

    const r = runScript('frame-capture.mjs', [], dir);

    assertCleanExit(r, EXIT.USAGE, 'a plan cannot honestly describe deleting a link target: ');
  });

  test('frameCapture_planWithOnlyAnEmptySubdirectory_doesNotReportNone', (t) => {
    const dir = makeProject(t, { ...captureFiles, 'timing.json': timingFixture() });
    fs.mkdirSync(path.join(dir, 'frames', 'stills'), { recursive: true });

    const r = runScript('frame-capture.mjs', [], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.doesNotMatch(
      r.all,
      /existing\s+none/,
      `--apply removes the directory recursively, so an empty subdirectory is in scope\n${r.all}`,
    );
    assert.match(r.all, /stills/, 'the plan should name the directory it would delete');
  });

  test('frameCapture_applyWithUnloadablePlaywright_preservesFrames', (t) => {
    // A real module-resolution failure, in isolation. The previous version of this test
    // installed a live lock, which stops the run BEFORE the import for a different
    // reason — so it could not detect a regression moving the wipe ahead of the import.
    const dir = makeProject(t, {
      ...captureFiles,
      'timing.json': timingFixture(),
      'frames/frame_00000.png': SENTINEL,
    });

    const r = runScript('frame-capture.mjs', ['--apply'], dir, { nodeArgs: ['--import', BLOCK_PLAYWRIGHT] });

    assertCleanExit(r, EXIT.USAGE, 'a missing browser dependency must fail: ');
    assert.equal(
      fs.readFileSync(path.join(dir, 'frames', 'frame_00000.png'), 'utf8'),
      SENTINEL,
      'the dependency must fail while the frames are still on disk',
    );
  });
});

// ---------------------------------------------------------------------------
// remux-verify: extracted so the mismatch branch could be tested, and it inherited
// the defect — equality of two unvalidated strings is not the property.
// ---------------------------------------------------------------------------
describe('video stream verdict input validation', () => {
  const MD5_A = 'MD5=0123456789abcdef0123456789abcdef';
  const MD5_B = 'MD5=fedcba9876543210fedcba9876543210';

  test('videoStreamVerdict_wellFormedEqualDigests_passes', () => {
    const v = videoStreamVerdict(MD5_A, MD5_A, 'out.mp4');
    assert.equal(v.identical, true);
    assert.equal(v.exitCode, EXIT.OK);
  });

  test('videoStreamVerdict_wellFormedDifferentDigests_fails', () => {
    const v = videoStreamVerdict(MD5_A, MD5_B, 'out.mp4');
    assert.equal(v.identical, false);
    assert.equal(v.exitCode, EXIT.FAILED);
    assert.match(v.message, /CHANGED/);
  });

  test('videoStreamVerdict_equalButMalformedOutput_failsRatherThanDeclaringIdentical', () => {
    // Two equal strings are not evidence that either MD5 was computed.
    for (const junk of ['oops', '', 'MD5=', 'MD5=zzzz', '0123456789abcdef0123456789abcdef']) {
      const v = videoStreamVerdict(junk, junk, 'out.mp4');
      assert.equal(v.identical, false, `${JSON.stringify(junk)} must not be accepted as a digest`);
      assert.equal(v.exitCode, EXIT.FAILED);
    }
  });

  test('videoStreamVerdict_oneSideMalformed_fails', () => {
    assert.equal(videoStreamVerdict(MD5_A, 'oops', 'out.mp4').identical, false);
    assert.equal(videoStreamVerdict('oops', MD5_A, 'out.mp4').identical, false);
  });

  test('videoStreamVerdict_surroundingWhitespaceAndCase_stillCompares', () => {
    assert.equal(videoStreamVerdict(`${MD5_A}\n`, ` ${MD5_A.toUpperCase()} `, 'out.mp4').identical, true);
  });
});

// ---------------------------------------------------------------------------
// Final write targets: the boundary was applied to the output DIRECTORY, not to the
// path actually written.
// ---------------------------------------------------------------------------
describe('final write target confinement', () => {
  test('voice_segmentTargetLinkedOutsideRoot_refusesAndPreservesVictim', (t) => {
    const dir = makeProject(t, {
      'timing.json': timingFixture(),
      'brand/tokens.json': brandTokens,
      'voiceover.mp3': 'vo',
    });
    const outside = makeOutsideDir(t, { 'victim.mp3': SENTINEL });
    if (!tryMakeFileLink(path.join(dir, 'segment_01.mp3'), path.join(outside, 'victim.mp3'))) {
      return t.skip('platform refused to create a file link');
    }

    const r = runScript('voice.mjs', ['--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.USAGE, 'a segment target escaping the root must be refused: ');
    assert.equal(fs.readFileSync(path.join(outside, 'victim.mp3'), 'utf8'), SENTINEL);
  });

  test('preview_screenshotTargetLinkedOutsideRoot_refusesAndPreservesVictim', (t) => {
    const dir = makeProject(t, {
      'timing.json': timingFixture(),
      'video-auto.html': '<html><body><div id="stage"></div></body></html>',
      'preview/.keep': '',
    });
    const outside = makeOutsideDir(t, { 'victim.png': SENTINEL });
    if (!tryMakeFileLink(path.join(dir, 'preview', 'one.png'), path.join(outside, 'victim.png'))) {
      return t.skip('platform refused to create a file link');
    }

    const r = runScript('preview.mjs', ['--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.USAGE, 'a screenshot target escaping the root must be refused: ');
    assert.equal(fs.readFileSync(path.join(outside, 'victim.png'), 'utf8'), SENTINEL);
  });

  test('voice_segmentTargetExistsWithoutReplace_refuses', (t) => {
    // Proves the per-segment destinations are preflighted at all, independent of links.
    const dir = makeProject(t, {
      'timing.json': timingFixture(),
      'brand/tokens.json': brandTokens,
      'segment_01.mp3': SENTINEL,
    });
    const r = runScript('voice.mjs', ['--apply'], dir);

    assert.equal(r.code, EXIT.USAGE, r.all);
    assert.equal(fs.readFileSync(path.join(dir, 'segment_01.mp3'), 'utf8'), SENTINEL);
  });
});

// ---------------------------------------------------------------------------
// Duplicate normalised destinations: two valid inputs, one file.
// ---------------------------------------------------------------------------
describe('distinct output destinations', () => {
  test('preview_segmentIdNamedEndcard_isRefusedRatherThanOverwritingSilently', (t) => {
    const segments = [
      { id: 'endcard', startMs: 0, endMs: 2000, voiceoverText: 'collides with the end-card shot' },
    ];
    const dir = makeProject(t, {
      'timing.json': timingFixture(segments),
      'video-auto.html': '<html><body><div id="stage"></div></body></html>',
    });

    const r = runScript('preview.mjs', ['--apply'], dir);

    assert.equal(r.code, EXIT.USAGE, `two shots writing one path must be refused, got ${r.code}\n${r.all}`);
  });

  test('previewSeg_fractionsRoundingToTheSameFilename_areRefused', (t) => {
    const dir = makeProject(t, {
      'timing.json': timingFixture(),
      'video-auto.html': '<html><body><div id="stage"></div></body></html>',
    });

    // 0.501 and 0.504 both round to 50.
    const r = runScript('preview-seg.mjs', ['--id', 'one', '--at', '0.501,0.504', '--apply'], dir);

    assert.equal(r.code, EXIT.USAGE, `distinct fractions must not collapse to one file\n${r.all}`);
  });

  test('previewSeg_distinctFractions_arePermitted', (t) => {
    const dir = makeProject(t, {
      'timing.json': timingFixture(),
      'video-auto.html': '<html><body><div id="stage"></div></body></html>',
    });
    const r = runScript('preview-seg.mjs', ['--id', 'one', '--at', '0.5,0.9'], dir);

    assert.equal(r.code, EXIT.OK, r.all);
  });
});

// ---------------------------------------------------------------------------
// validate-timing: the threshold that decides the check arrived as NaN, so even
// --strict could not fail. The verifier-that-cannot-fail, a third time.
// ---------------------------------------------------------------------------
describe('calibration input validation', () => {
  const overBudget = [
    { id: 'one', startMs: 0, endMs: 1000, voiceoverText: 'far too many words for a single second of narration here' },
  ];

  // The fixtures below deliberately match `voice.mjs`'s OWN output shape
  // (`aggregate.observedEffWps`, nested). They used to hand-write
  // `{ wordsPerSecond, wpsSafetyMargin }` at the top level — a shape voice.mjs has never
  // emitted. Those tests passed while the reader they "covered" missed on every real
  // project, which is precisely how the defect survived: when the red and the green come
  // from different bodies, the red proves nothing about what ships.
  // `tests/_realistic-fixture.mjs` builds the real shape; see `tests/word-rate.test.mjs`.
  test('validateTiming_calibrationRateNotANumber_failsRatherThanPassing', (t) => {
    const dir = makeProject(t, {
      'timing.json': timingFixture(overBudget),
      'calibration-observed.json': JSON.stringify({ aggregate: { observedEffWps: 'oops' } }),
    });
    const r = runScript('validate-timing.mjs', ['--no-schema', '--strict'], dir);

    assertCleanExit(r, EXIT.USAGE, 'a NaN budget must not silently pass --strict: ');
  });

  test('validateTiming_intakeMarginNotANumber_failsRatherThanPassing', (t) => {
    // Deliberately WITHIN budget and contiguous: the only thing that can fail this run is
    // the margin guard, so a pass cannot be mistaken for the budget check firing.
    // The margin lives in `intake` — timing-schema.json declares it there and nowhere
    // else, and it is an authoring hedge rather than something that can be observed.
    const dir = makeProject(t, {
      'timing.json': timingFixture(contiguousSegments, { intake: { wpsSafetyMargin: null } }),
      'calibration-observed.json': JSON.stringify({ aggregate: { observedEffWps: 3 } }),
    });
    const r = runScript('validate-timing.mjs', ['--no-schema', '--strict'], dir);

    assertCleanExit(r, EXIT.USAGE, 'a present-but-null margin must not silently take the default: ');
    assert.match(r.all, /wpsSafetyMargin/, 'the failure must name the value that was invalid');
  });

  test('validateTiming_calibrationFileMalformed_failsRatherThanFallingBack', (t) => {
    const dir = makeProject(t, {
      'timing.json': timingFixture(contiguousSegments),
      'calibration-observed.json': '{ not json',
    });
    const r = runScript('validate-timing.mjs', ['--no-schema'], dir);

    assertCleanExit(r, EXIT.USAGE, 'only an ABSENT calibration file may be ignored: ');
  });

  test('validateTiming_calibrationFileAbsent_usesTheDefaultAndPasses', (t) => {
    const dir = makeProject(t, { 'timing.json': timingFixture(contiguousSegments) });
    const r = runScript('validate-timing.mjs', ['--no-schema'], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(r.all, /source: default/);
  });

  test('validateTiming_validCalibration_isUsed', (t) => {
    const dir = makeProject(t, {
      'timing.json': timingFixture(contiguousSegments),
      'calibration-observed.json': JSON.stringify({
        voiceId: 'en-US-AvaNeural',
        roundedSpeed: 1.2,
        aggregate: { words: 370, speechMs: 101236, observedEffWps: 3.655, observedSafeWps: 3.046 },
        segments: [],
      }),
    });
    const r = runScript('validate-timing.mjs', ['--no-schema'], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(r.all, /calibration-observed\.json/);
  });
});

// ---------------------------------------------------------------------------
// Drift tolerances: an unparseable toleranceMs makes `drift > NaN` false, disabling
// the comparison entirely.
// ---------------------------------------------------------------------------
describe('drift tolerance validation', () => {
  test('voice_nonNumericToleranceMs_exitsUsageError', (t) => {
    const dir = makeProject(t, {
      'timing.json': timingFixture(contiguousSegments, {
        intake: { leadInMs: 2000, perceivedGapMs: 2000, toleranceMs: 'oops', voice: 'en-US-AvaNeural', speed: 1, silenceMs: 2000 },
      }),
      'brand/tokens.json': brandTokens,
    });
    const r = runScript('voice.mjs', [], dir);

    assert.equal(r.code, EXIT.USAGE, `a NaN tolerance disables the drift check entirely\n${r.all}`);
  });

  test('remix_nonNumericToleranceMs_exitsUsageError', (t) => {
    const dir = makeProject(t, {
      'timing.json': timingFixture(contiguousSegments, {
        intake: { leadInMs: 2000, perceivedGapMs: 2000, toleranceMs: 'oops' },
      }),
    });
    const r = runScript('remix.mjs', [], dir);

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
  file: 'voiceover.mp3',
  bytes: voice.length,
  sha256: crypto.createHash('sha256').update(voice).digest('hex'),
});

describe('envelope input validation', () => {
  // EACH FIXTURE REACHES THE CHECK IT IS NAMED FOR. These three used to carry no binding
  // and no voiceover.mp3, so all three stopped at "voice track not found" — exit 2, the
  // code they asserted — and deleting the rms validation left them green. Each is now
  // bound to narration on disk, and each asserts the rms refusal itself.
  const voice = Buffer.from('narration bytes');
  const boundEnvelopeProject = (t, envelope) =>
    makeProject(t, {
      'voiceover.mp3': voice,
      'env.json': JSON.stringify({ ...envelope, measuredFrom: boundTo(voice) }),
    });

  test('makeMusic_envelopeWithEmptyRms_refusesBeforeWriting', (t) => {
    const dir = boundEnvelopeProject(t, { rms: [] });
    const r = runScript('make-music.mjs', ['--out', 'bed.wav', '--seconds', '2', '--envelope', 'env.json', '--apply'], dir);

    assertCleanExit(r, EXIT.USAGE, 'an empty envelope must not produce NaN samples: ');
    assert.match(r.stderr, /has an empty "rms" array/, 'and the refusal must be the rms check, not an earlier one');
    assert.equal(fs.existsSync(path.join(dir, 'bed.wav')), false);
  });

  test('makeMusic_envelopeWithNonNumericSamples_refusesBeforeWriting', (t) => {
    const dir = boundEnvelopeProject(t, { rms: [0.1, 'x', 0.2] });
    const r = runScript('make-music.mjs', ['--out', 'bed.wav', '--seconds', '2', '--envelope', 'env.json', '--apply'], dir);

    assertCleanExit(r, EXIT.USAGE, 'a non-numeric envelope sample must be refused: ');
    assert.match(r.stderr, /"rms"\[1\] is "x"/, 'the refusal must name the sample');
    assert.match(r.stderr, /finite non-negative number/, 'and the rule it breaks');
    assert.equal(fs.existsSync(path.join(dir, 'bed.wav')), false);
  });

  test('makeMusic_envelopeMissingRmsArray_refusesBeforeWriting', (t) => {
    const dir = boundEnvelopeProject(t, { durationMs: 100 });
    const r = runScript('make-music.mjs', ['--out', 'bed.wav', '--seconds', '2', '--envelope', 'env.json', '--apply'], dir);

    assertCleanExit(r, EXIT.USAGE, 'an envelope without an rms array must be refused: ');
    assert.match(r.stderr, /must contain an "rms" array/, 'and the refusal must be the rms check');
    assert.equal(fs.existsSync(path.join(dir, 'bed.wav')), false);
  });

  test('makeMusic_validEnvelope_writesFiniteSamples', (t) => {
    const rms = Array.from({ length: 120 }, (_, i) => (i % 20 < 10 ? 0.2 : 0.001));
    const voice = Buffer.from('narration bytes');
    const dir = makeProject(t, {
      'voiceover.mp3': voice,
      'env.json': JSON.stringify({ rms, hopMs: 20, durationMs: 2400, measuredFrom: boundTo(voice) }),
    });
    const r = runScript('make-music.mjs', ['--out', 'bed.wav', '--seconds', '2', '--envelope', 'env.json', '--apply'], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    const buf = fs.readFileSync(path.join(dir, 'bed.wav'));
    for (let o = 44; o + 4 <= buf.length; o += 4) {
      assert.ok(Number.isFinite(buf.readFloatLE(o)), `NaN sample at byte ${o}`);
    }
  });
});

// ---------------------------------------------------------------------------
// The guard handler gaps: CliError thrown at module scope above `guard`.
// ---------------------------------------------------------------------------
describe('module-scope failures use the documented exit codes', () => {
  for (const script of ['voice.mjs', 'remix.mjs', 'frame-capture.mjs']) {
    test(`${script.replace('.mjs', '')}_missingTimingFile_exitsUsageNotAnUncaughtStack`, (t) => {
      const dir = makeProject(t, { 'brand/tokens.json': brandTokens });
      const r = runScript(script, [], dir);

      assert.equal(r.code, EXIT.USAGE, `expected the documented usage exit, got ${r.code}\n${r.all}`);
      assert.doesNotMatch(r.all, /^\s*at .*\(.*:\d+:\d+\)/m, 'a missing prerequisite must not surface as a stack trace');
    });
  }
});

// ---------------------------------------------------------------------------
// Sweep findings: "for every guard, what value decides it, and is that value
// validated?" These are the guards whose deciding value was still unchecked.
// ---------------------------------------------------------------------------
describe('sweep: values that decide a guard', () => {
  const captureProject = (t, extra = {}) =>
    makeProject(t, {
      ...captureFiles,
      'timing.json': timingFixture(),
      'frames/frame_00000.png': SENTINEL,
      ...extra,
    });

  test('frameCapture_lockFileWithUnparseablePid_skipsRatherThanStealingTheLock', (t) => {
    // `Number('not-a-pid')` is NaN, `!NaN` is true, so the lock was declared stale and
    // taken over — the single-writer guard defeated by the value that decides it.
    const dir = captureProject(t, { 'frames.lock': 'not-a-pid' });

    const r = runScript('frame-capture.mjs', ['--apply'], dir);

    assert.equal(r.code, EXIT.SKIPPED, `an unreadable lock owner must not be assumed dead\n${r.all}`);
    assert.equal(fs.readFileSync(path.join(dir, 'frames', 'frame_00000.png'), 'utf8'), SENTINEL);
  });

  test('encodeMp4_lockFileWithUnparseablePid_skipsRatherThanStealingTheLock', (t) => {
    const dir = makeProject(t, {
      'timing.json': timingFixture(),
      'frames/frame_00000.png': 'frame',
      'demo.mp4.lock': '   ',
    });

    const r = runScript('encode-mp4.mjs', ['--apply'], dir);

    assert.equal(r.code, EXIT.SKIPPED, r.all);
  });
  test('frameCapture_resumeWithUninspectableFingerprint_refusesRatherThanWiping', (t) => {
    // An unreadable fingerprint is not a mismatch. Treating it as one discards the frames
    // the user asked to resume from.
    const dir = captureProject(t);
    // A directory where the fingerprint file belongs: reading it fails with EISDIR.
    fs.mkdirSync(path.join(dir, 'frames', '.capture-meta.json'));

    const r = runScript('frame-capture.mjs', ['--apply', '--resume'], dir);

    assert.equal(r.code, EXIT.USAGE, `an uninspectable fingerprint must not authorise a wipe\n${r.all}`);
    assert.doesNotMatch(r.all, /^\s*at .*\(.*:\d+:\d+\)/m, 'and must not surface as an uncaught stack');
    assert.equal(fs.readFileSync(path.join(dir, 'frames', 'frame_00000.png'), 'utf8'), SENTINEL);
  });

  test('frameCapture_invalidJpegQuality_exitsUsageBeforeCapturing', (t) => {
    const dir = captureProject(t);

    const r = runScript('frame-capture.mjs', ['--apply'], dir, {
      env: { SIZZLECRAFT_FRAME_FORMAT: 'jpeg', SIZZLECRAFT_JPEG_QUALITY: 'high' },
    });

    assert.equal(r.code, EXIT.USAGE, r.all);
    assert.equal(fs.readFileSync(path.join(dir, 'frames', 'frame_00000.png'), 'utf8'), SENTINEL);
  });

  test('encodeMp4_unknownMode_exitsUsageRatherThanSilentlyPickingOne', (t) => {
    const dir = makeProject(t, {
      'timing.json': timingFixture(contiguousSegments, {
        project: { name: 'demo', fps: 30, width: 1280, height: 720, mode: 'turbo' },
      }),
      'frames/frame_00000.png': 'frame',
    });

    const r = runScript('encode-mp4.mjs', [], dir);

    assert.equal(r.code, EXIT.USAGE, `an unrecognised mode silently became 'quality'\n${r.all}`);
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
describe('lock files are never read through a link', () => {
  const SECRET = 'SENTINEL-c0ffee-THIS-MUST-NEVER-BE-ECHOED';

  test('readLockOwner_linkedLock_reportsUnreadableWithoutDisclosingContents', (t) => {
    const dir = makeProject(t);
    const outside = makeOutsideDir(t, { 'secret.txt': SECRET });
    const lockPath = path.join(dir, 'frames.lock');
    if (!tryMakeFileLink(lockPath, path.join(outside, 'secret.txt'))) {
      return t.skip('platform refused to create a file link');
    }

    const owner = readLockOwner(lockPath);

    assert.equal(owner.state, 'unreadable');
    assert.doesNotMatch(owner.detail, /SENTINEL/, 'the link target must not be read, let alone reported');
  });

  test('readLockOwner_regularLockWithJunk_doesNotEchoItsContents', (t) => {
    const dir = makeProject(t, { 'frames.lock': SECRET });

    const owner = readLockOwner(path.join(dir, 'frames.lock'));

    assert.equal(owner.state, 'unreadable');
    assert.doesNotMatch(owner.detail, /SENTINEL/, 'untrusted lock contents must never reach a diagnostic');
  });

  test('frameCapture_lockLinkedOutsideRoot_skipsWithoutDisclosingTheTarget', (t) => {
    const dir = makeProject(t, {
      'video-auto.html': '<html><body><div id="stage"></div></body></html>',
      'timing.json': timingFixture(),
      'frames/frame_00000.png': SENTINEL,
    });
    const outside = makeOutsideDir(t, { 'secret.txt': SECRET });
    if (!tryMakeFileLink(path.join(dir, 'frames.lock'), path.join(outside, 'secret.txt'))) {
      return t.skip('platform refused to create a file link');
    }

    const r = runScript('frame-capture.mjs', ['--apply'], dir);

    assert.doesNotMatch(r.all, /SENTINEL-c0ffee/, 'the contents of an outside file must not appear in any output');
    assert.equal(r.code, EXIT.SKIPPED, `an unreadable lock must fail closed\n${r.all}`);
    assert.equal(fs.readFileSync(path.join(dir, 'frames', 'frame_00000.png'), 'utf8'), SENTINEL);
  });

  test('encodeMp4_lockLinkedOutsideRoot_skipsWithoutDisclosingTheTarget', (t) => {
    const dir = makeProject(t, {
      'timing.json': timingFixture(),
      'frames/frame_00000.png': 'frame',
    });
    const outside = makeOutsideDir(t, { 'secret.txt': SECRET });
    if (!tryMakeFileLink(path.join(dir, 'demo.mp4.lock'), path.join(outside, 'secret.txt'))) {
      return t.skip('platform refused to create a file link');
    }

    const r = runScript('encode-mp4.mjs', ['--apply'], dir);

    assert.doesNotMatch(r.all, /SENTINEL-c0ffee/, 'the contents of an outside file must not appear in any output');
    assert.equal(r.code, EXIT.SKIPPED, r.all);
  });
});

// ---------------------------------------------------------------------------
// The write SET, not the individual write. Distinctness and confinement were each
// applied to one collection; a stage writes several.
// ---------------------------------------------------------------------------
describe('complete write set', () => {
  const voiceFiles = { 'timing.json': timingFixture(), 'brand/tokens.json': brandTokens };

  test('voice_voiceoverLinkedToASegmentClip_isRefusedBeforeSynthesis', (t) => {
    const dir = makeProject(t, { ...voiceFiles, 'segment_01.mp3': 'clip one' });
    if (!tryMakeFileLink(path.join(dir, 'voiceover.mp3'), path.join(dir, 'segment_01.mp3'))) {
      return t.skip('platform refused to create a file link');
    }
    const r = runScript('voice.mjs', ['--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.USAGE, 'two outputs resolving to one file must be refused: ');
    assert.equal(fs.readFileSync(path.join(dir, 'segment_01.mp3'), 'utf8'), 'clip one');
  });

  test('remix_voiceoverLinkedToTiming_isRefusedBeforeWriting', (t) => {
    // Worded, so the timeline is one remix accepts and the refusal is the link's.
    const dir = makeProject(t, { 'timing.json': timingFixture(wordedSegments) });
    if (!tryMakeFileLink(path.join(dir, 'voiceover.mp3'), path.join(dir, 'timing.json'))) {
      return t.skip('platform refused to create a file link');
    }
    const before = fs.readFileSync(path.join(dir, 'timing.json'), 'utf8');
    const r = runScript('remix.mjs', ['--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.USAGE, 'voiceover and timing resolving to one file must be refused: ');
    assert.match(r.all, /is a link/, r.all);
    assert.equal(fs.readFileSync(path.join(dir, 'timing.json'), 'utf8'), before);
  });

  test('voice_secondaryOutputLinkedOutsideRoot_isRefused', (t) => {
    const dir = makeProject(t, voiceFiles);
    const outside = makeOutsideDir(t, { 'victim.json': SENTINEL });
    if (!tryMakeFileLink(path.join(dir, 'calibration-observed.json'), path.join(outside, 'victim.json'))) {
      return t.skip('platform refused to create a file link');
    }
    const r = runScript('voice.mjs', ['--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.USAGE, 'a secondary output escaping the root must be refused: ');
    assert.equal(fs.readFileSync(path.join(outside, 'victim.json'), 'utf8'), SENTINEL);
  });

  test('frameCapture_resumeWithLinkedDedupStats_isRefusedAndVictimSurvives', (t) => {
    // With a matching fingerprint the directory is NOT wiped, so a link planted inside
    // frames/ survives and the engine's own metadata write follows it out of the project.
    const html = '<html><body><div id="stage"></div></body></html>';
    const dir = makeProject(t, { 'video-auto.html': html, 'timing.json': timingFixture(), 'frames/frame_00000.png': 'f' });
    const outside = makeOutsideDir(t, { 'victim.json': SENTINEL });

    fs.writeFileSync(
      path.join(dir, 'frames', '.capture-meta.json'),
      JSON.stringify({
        htmlHash: crypto.createHash('sha256').update(Buffer.from(html)).digest('hex'),
        fps: 30, width: 1280, height: 720, frameFormat: 'png', jpegQuality: 88,
        totalFrames: Math.ceil(((4000 + 1000) / 1000) * 30), v: 1,
      }),
    );
    if (!tryMakeFileLink(path.join(dir, 'frames', '.dedup-stats.json'), path.join(outside, 'victim.json'))) {
      return t.skip('platform refused to create a file link');
    }
    const r = runScript('frame-capture.mjs', ['--apply', '--resume'], dir);

    assertCleanExit(r, EXIT.USAGE, 'engine metadata must not be written through a link: ');
    assert.equal(fs.readFileSync(path.join(outside, 'victim.json'), 'utf8'), SENTINEL);
  });

  test('frameCapture_resumePlan_disclosesTheMetadataItRewrites', (t) => {
    const dir = makeProject(t, {
      'video-auto.html': '<html><body><div id="stage"></div></body></html>',
      'timing.json': timingFixture(),
      'frames/frame_00000.png': 'f',
    });
    const r = runScript('frame-capture.mjs', ['--resume'], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(r.all, /capture-meta\.json/, 'a resume plan still rewrites the engine metadata; say so');
  });
});

// ---------------------------------------------------------------------------
// More invalid-value-to-false-success.
// ---------------------------------------------------------------------------
describe('present-but-invalid is not absent', () => {
  test('encodeMp4_nonNumericToleranceMs_exitsUsageBeforeEncoding', (t) => {
    const dir = makeProject(t, {
      'timing.json': timingFixture(contiguousSegments, { intake: { toleranceMs: 'oops' } }),
      'frames/frame_00000.png': 'frame',
      'voiceover.mp3': 'x'.repeat(4096),
    });
    const r = runScript('encode-mp4.mjs', ['--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.USAGE, 'a NaN A/V tolerance disables the sync gate: ');
  });

  test('encodeMp4_planWithMissingNarration_doesNotPromiseAVideoOnlyRender', (t) => {
    const dir = makeProject(t, { 'timing.json': timingFixture(), 'frames/frame_00000.png': 'frame' });
    const r = runScript('encode-mp4.mjs', [], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.doesNotMatch(r.all, /video-only/i, 'only an intentional silent render is video-only');
    assert.match(r.all, /refuse|missing/i, 'the plan must say the apply path would refuse');
  });

  test('encodeMp4_planWithIntentionalSilentRender_saysSilent', (t) => {
    const dir = makeProject(t, {
      'timing.json': timingFixture(contiguousSegments, { intake: { toleranceMs: 750, silent: true } }),
      'frames/frame_00000.png': 'frame',
    });
    const r = runScript('encode-mp4.mjs', [], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(r.all, /silent/i);
  });

  test('makeMusic_durationRoundingToZeroSamples_isRefused', (t) => {
    const dir = makeProject(t);
    const r = runScript('make-music.mjs', ['--out', 'bed.wav', '--seconds', '0.000001', '--apply'], dir);

    assertCleanExit(r, EXIT.USAGE, 'a zero-sample bed must be refused: ');
    assert.equal(fs.existsSync(path.join(dir, 'bed.wav')), false);
  });

  test('makeMusic_envelopeRemovedBetweenPreflightAndRead_failsRatherThanGoingFlat', async (t) => {
    // The discriminating case. A directory at env.json does NOT discriminate: the old
    // `existsSync` returned true for it too, then failed the read exactly as the new code
    // does. The only behaviour that changed is the one where existsSync returns FALSE —
    // the file is gone by the time the late read happens — which old code answered by
    // silently producing un-ducked music and exiting 0.
    //
    // make-music reads the envelope after synthesising the pad, so deleting it once the
    // preset line appears lands inside a multi-second window, well before the read.
    const rms = Array.from({ length: 600 }, (_, i) => (i % 20 < 10 ? 0.2 : 0.001));
    // The envelope must be BOUND to a voice track on disk, or the lineage pre-flight
    // refuses it before the preset line and the deletion below never lands in the window
    // this test exists to open.
    const voice = Buffer.from('narration bytes');
    const dir = makeProject(t, {
      'voiceover.mp3': voice,
      'env.json': JSON.stringify({ rms, hopMs: 20, durationMs: 12000, measuredFrom: boundTo(voice) }),
    });
    const envPath = path.join(dir, 'env.json');

    const r = await runScriptDeletingOnMarker(
      'make-music.mjs',
      ['--out', 'bed.wav', '--seconds', '30', '--envelope', 'env.json', '--apply'],
      dir,
      'music preset:',
      envPath,
    );

    assert.equal(r.deleted, true, 'the envelope must actually have been removed mid-run for this to test anything');
    assert.equal(r.code, EXIT.USAGE, `a vanished envelope must fail, not silently go flat\n${r.all}`);
    assert.match(r.all, /env\.json/, 'and must name the envelope it could not read');
    assert.equal(fs.existsSync(path.join(dir, 'bed.wav')), false, 'no bed may be written');
  });

  test('makeMusic_envelopeUnreadableAtPreflight_isRefused', (t) => {
    const dir = makeProject(t);
    fs.mkdirSync(path.join(dir, 'env.json'));
    const r = runScript('make-music.mjs', ['--out', 'bed.wav', '--seconds', '2', '--envelope', 'env.json', '--apply'], dir);

    assertCleanExit(r, EXIT.USAGE, 'an unreadable envelope must be refused: ');
    assert.equal(fs.existsSync(path.join(dir, 'bed.wav')), false);
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
describe('encode-mp4 engine-chosen writes', () => {
  const encodableProject = (t, extra = {}) =>
    makeProject(t, {
      'timing.json': timingFixture(),
      'frames/frame_00000.png': 'frame',
      'voiceover.mp3': 'x'.repeat(4096),
      ...extra,
    });

  test('encodeMp4_encoderDirLinkedOutsideRoot_refusesBeforeInstallingAnything', (t) => {
    const dir = encodableProject(t);
    const outside = makeOutsideDir(t, { 'victim.html': SENTINEL });
    if (!tryMakeDirLink(path.join(dir, 'encoder'), outside)) return t.skip('platform refused to create a directory link');

    const r = runScript('encode-mp4.mjs', ['--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.USAGE, 'a junction at the engine-chosen encoder dir must be refused: ');
    assert.equal(fs.readFileSync(path.join(outside, 'victim.html'), 'utf8'), SENTINEL);
    assert.equal(fs.existsSync(path.join(outside, 'encoder-page.html')), false, 'nothing may be installed through the junction');
    assert.equal(fs.existsSync(path.join(outside, 'mp4-muxer.js')), false);
    assert.doesNotMatch(r.all, /MUST SURVIVE/, 'and the victim must never be echoed');
  });

  test('encodeMp4_encoderPageLinkedOutsideRoot_refusesWithoutClobberingTheVictim', (t) => {
    const dir = encodableProject(t);
    const outside = makeOutsideDir(t, { 'victim.html': SENTINEL });
    const victim = path.join(outside, 'victim.html');
    fs.mkdirSync(path.join(dir, 'encoder'));
    if (!tryMakeFileLink(path.join(dir, 'encoder', 'encoder-page.html'), victim)) {
      return t.skip('platform refused to create a file link');
    }

    const r = runScript('encode-mp4.mjs', ['--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.USAGE, 'copyFileSync follows a destination link, so the guard must fire first: ');
    assert.equal(fs.readFileSync(victim, 'utf8'), SENTINEL);
    assert.doesNotMatch(r.all, /MUST SURVIVE/);
  });

  test('encodeMp4_muxerDestinationLinkedOutsideRoot_refusesWithoutClobberingTheVictim', (t) => {
    const dir = encodableProject(t);
    const outside = makeOutsideDir(t, { 'victim.js': SENTINEL });
    const victim = path.join(outside, 'victim.js');
    fs.mkdirSync(path.join(dir, 'encoder'));
    if (!tryMakeFileLink(path.join(dir, 'encoder', 'mp4-muxer.js'), victim)) {
      return t.skip('platform refused to create a file link');
    }

    const r = runScript('encode-mp4.mjs', ['--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.USAGE, 'the muxer copy has the same destination-link problem: ');
    assert.equal(fs.readFileSync(victim, 'utf8'), SENTINEL);
    assert.doesNotMatch(r.all, /MUST SURVIVE/);
  });

  test('encodeMp4_outputMp4IsAnInRootLink_refusesRatherThanGuardingADifferentEntry', (t) => {
    // The publish guard resolved the link's TARGET while renameSync replaces the link
    // ENTRY. Not an outside-root clobber today — but guard and action referred to
    // different files, which is "correct for a reason nothing enforces".
    const dir = encodableProject(t, { 'real.mp4': SENTINEL });
    if (!tryMakeFileLink(path.join(dir, 'demo.mp4'), path.join(dir, 'real.mp4'))) {
      return t.skip('platform refused to create a file link');
    }

    const r = runScript('encode-mp4.mjs', ['--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.USAGE, 'an engine-chosen publish target must not be a link: ');
    assert.equal(fs.readFileSync(path.join(dir, 'real.mp4'), 'utf8'), SENTINEL);
  });

  test('encodeMp4_outputMp4LinkedOutsideRoot_stillRefusesWithoutClobbering', (t) => {
    // Regression cover: containment already refused this before the change, and it must
    // keep doing so now that the policy resolving it is a different one.
    const dir = encodableProject(t);
    const outside = makeOutsideDir(t, { 'victim.mp4': SENTINEL });
    const victim = path.join(outside, 'victim.mp4');
    if (!tryMakeFileLink(path.join(dir, 'demo.mp4'), victim)) return t.skip('platform refused to create a file link');

    const r = runScript('encode-mp4.mjs', ['--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.USAGE);
    assert.equal(fs.readFileSync(victim, 'utf8'), SENTINEL);
    assert.doesNotMatch(r.all, /MUST SURVIVE/);
  });

  test('encodeMp4_timingJsonLinkedOutsideRoot_refusesWithoutDisclosingIt', (t) => {
    // A path that is written is also a path that is read, and the two need separate
    // verdicts. Every other stage resolves timing.json through requireExistingFile;
    // encode-mp4 alone joined it raw, so a planted link was followed and JSON.parse put
    // the first line of the target into its error message — the same shape as the lock
    // file disclosure, reached on the DEFAULT no-flag path.
    //
    // The exit code is non-zero either way, so it proves nothing here. The sentinel does.
    const dir = makeProject(t);
    const outside = makeOutsideDir(t, { 'secret.txt': `AKIA${SENTINEL}` });
    if (!tryMakeFileLink(path.join(dir, 'timing.json'), path.join(outside, 'secret.txt'))) {
      return t.skip('platform refused to create a file link');
    }

    const r = runScript('encode-mp4.mjs', [], dir);

    assert.doesNotMatch(r.all, /MUST SURVIVE/, 'the contents of a file outside the project must never be echoed');
    assertCleanExit(r, EXIT.USAGE, 'a timing.json link escaping the root must be refused: ');
  });

  test('encodeMp4_encoderPathIsARegularFile_refusesCleanlyRatherThanCrashing', (t) => {
    // `encoder` occupied by an ordinary file made mkdirSync throw a raw EEXIST stack and
    // exit 1. The entry is engine-chosen and the situation is recoverable, so it deserves
    // the documented usage code and a message saying what to do.
    const dir = encodableProject(t, { encoder: 'not a directory' });

    const r = runScript('encode-mp4.mjs', ['--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.USAGE, 'a non-directory at encoder/ must be refused, not crash mkdirSync: ');
    assert.match(r.all, /encoder/i, 'and the refusal must name the entry it refused');
  });

  test('encodeMp4_partFileCollision_refusesWithoutDeletingTheExistingEntry', async (t) => {
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
      'encode-mp4.mjs',
      ['--apply', '--replace'],
      dir,
      'silent render requested',
      (pid) => {
        victim = path.join(dir, `demo.mp4.part-${pid}`);
        fs.writeFileSync(victim, SENTINEL);
      },
    );

    assert.equal(r.planted, true, 'the collision must actually have been staged for this to test anything');
    assert.notEqual(victim, null);
    assert.equal(fs.existsSync(victim), true, 'the refused entry must still exist — a refusal must not delete what it declined to create');
    assert.equal(fs.readFileSync(victim, 'utf8'), SENTINEL, 'and its contents must be untouched');
    assertCleanExit(r, EXIT.USAGE, 'a refused temp-file collision must exit with the documented usage code: ');
  });

  test('encodeMp4_cleanProject_completesEveryGuardedWriteAndPublishes', (t) => {
    // Replaces a test that accepted any exit other than 2 and matched the
    // missing-encoder-page error — so it passed on an unrelated prerequisite failure and
    // never established that a single guarded write was reached. The guards must not fire
    // on a legitimate project, and the only way to show that is to let the writes happen.
    const engineDir = makeEngineCopy(t);
    const dir = operableProject(t);

    const r = runEngineScript(engineDir, 'encode-mp4.mjs', ['--apply', '--replace'], dir);

    assert.equal(r.code, EXIT.OK, `a legitimate project must clear every guard and publish\n${r.all}`);
    assert.equal(fs.existsSync(path.join(dir, 'encoder', 'encoder-page.html')), true, 'the guarded encoder-page copy must have executed');
    assert.equal(fs.existsSync(path.join(dir, 'encoder', 'mp4-muxer.js')), true, 'the guarded muxer copy must have executed');
    assert.equal(fs.existsSync(path.join(dir, 'demo.mp4')), true, 'the guarded publish must have executed');
    assert.equal(
      fs.readdirSync(dir).filter((n) => n.includes('.part-')).length,
      0,
      'and no temp file may survive a successful publish',
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
describe('write-build-html engine-chosen reads', () => {
  // An OPERABLE scene project. An under-specified fixture made the refusal tests below
  // pass on a missing evidence-pack rather than on the guard — the same free pass this
  // round was opened to remove, reproduced in the tests for it.
  const sceneProject = (t, extra = {}) =>
    makeProject(t, {
      'timing.json': timingFixture(),
      'evidence-pack/.keep': '',
      'node_modules/gsap/dist/gsap.min.js': '/* gsap stub */',
      ...extra,
    });

  test('writeBuildHtml_fixtureIsOperable_buildsTheSceneBeforeAnyGuardIsTested', (t) => {
    // Pins the fixture itself. If this stops passing, every refusal assertion below has
    // become unfalsifiable and must not be trusted.
    const dir = sceneProject(t);

    const r = runScript('write-build-html.mjs', ['--apply', '--replace'], dir);

    assert.equal(r.code, EXIT.OK, `the scene fixture must build, or the guard tests prove nothing\n${r.all}`);
    assert.equal(fs.existsSync(path.join(dir, 'video-auto.html')), true);
  });

  test('writeBuildHtml_timingJsonLinkedOutsideRoot_refusesWithoutDisclosingIt', (t) => {
    const dir = makeProject(t);
    const outside = makeOutsideDir(t, { 'secret.txt': `AKIA${SENTINEL}` });
    if (!tryMakeFileLink(path.join(dir, 'timing.json'), path.join(outside, 'secret.txt'))) {
      return t.skip('platform refused to create a file link');
    }

    const r = runScript('write-build-html.mjs', [], dir);

    assert.doesNotMatch(r.all, /MUST SURVIVE/, 'the contents of a file outside the project must never be echoed');
    assertCleanExit(r, EXIT.USAGE, 'a timing.json link escaping the root must be refused: ');
  });

  test('writeBuildHtml_manifestLinkedOutsideRoot_refusesRatherThanReadingThroughIt', (t) => {
    // Swallowing the error hides the message, not the read — valid outside JSON still
    // influences the page. The refusal has to happen before the read.
    const dir = sceneProject(t);
    const outside = makeOutsideDir(t, { 'planted.json': JSON.stringify({ title: SENTINEL }) });
    if (!tryMakeFileLink(path.join(dir, 'manifest.json'), path.join(outside, 'planted.json'))) {
      return t.skip('platform refused to create a file link');
    }

    const r = runScript('write-build-html.mjs', ['--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.USAGE, 'an optional input redirected outside the root must be refused: ');
    assert.doesNotMatch(r.all, /MUST SURVIVE/);
    const built = path.join(dir, 'video-auto.html');
    if (fs.existsSync(built)) {
      assert.doesNotMatch(fs.readFileSync(built, 'utf8'), /MUST SURVIVE/, 'and must never reach the rendered page');
    }
  });

  test('writeBuildHtml_absentOptionalFile_isTreatedAsAbsentNotAsAnError', (t) => {
    // The state that legitimately means "nothing to add". Confining the read must not
    // turn an ordinary project into a failure.
    const dir = sceneProject(t);

    const r = runScript('write-build-html.mjs', ['--apply', '--replace'], dir);

    assert.equal(r.code, EXIT.OK, `an absent optional input is not an error\n${r.all}`);
    assert.equal(fs.existsSync(path.join(dir, 'video-auto.html')), true);
  });
  test('writeBuildHtml_unreadableOptionalFile_failsRatherThanTreatingItAsAbsent', (t) => {
    // "I could not read your manifest" and "you have no manifest" are different facts and
    // only one of them is safe to assume. A directory at the path makes the read fail with
    // EISDIR, which the old `catch {}` rendered as absence.
    const dir = sceneProject(t);
    fs.mkdirSync(path.join(dir, 'manifest.json'));

    const r = runScript('write-build-html.mjs', ['--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.USAGE, 'an unreadable optional input must not render as an absent one: ');
    assert.match(r.all, /manifest\.json/, 'and must name the file it could not read');
  });

  test('writeBuildHtml_malformedOptionalFile_failsRatherThanSilentlyDroppingContent', (t) => {
    const dir = sceneProject(t, { 'manifest.json': '{ not valid json' });

    const r = runScript('write-build-html.mjs', ['--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.USAGE, 'a corrupt optional input silently removed content: ');
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
  test('writeBuildHtml_footageFixtureIsOperable_loadsRealFramesAtTheStartAndLaterInTheClip', async (t) => {
    // The positive control, and the thing it controls for is narrow: that footage actually
    // RENDERS. The previous version asserted only that "myclip" appeared in the HTML, which
    // proves the clip was selected into the scene and nothing more — it passed over frames
    // that were text rather than JPEG and zero-based rather than one-based, so every load
    // failed. A control that cannot see a broken render cannot certify a refused one.
    //
    // Two points are checked because asserting only the first frame would pass on a fixture
    // with exactly one usable frame — close to the shape that was wrong before.
    const dir = footageProject(t);

    const r = runScript('write-build-html.mjs', ['--apply', '--replace'], dir);
    assert.equal(r.code, EXIT.OK, `the footage fixture must build\n${r.all}`);

    const [atStart, later] = await probeFootageFrames(path.join(dir, 'video-auto.html'), [0, 100]);

    assert.equal(atStart.loaded, true, `the first footage frame must decode and be applied, got ${JSON.stringify(atStart)}`);
    assert.equal(atStart.applied, 'frame_00001.jpg', 'the runtime is one-based: the clip starts at frame_00001.jpg');
    assert.equal(later.loaded, true, `a later footage frame must decode too, got ${JSON.stringify(later)}`);
    assert.equal(later.applied, 'frame_00004.jpg', 'and a later time must advance to a different frame');
  });

  test('writeBuildHtml_footageControlFails_whenTheFramesCannotDecode', async (t) => {
    // Proves the control's alarm can actually fire. A control whose alarm has never been
    // heard is indistinguishable from one that cannot ring: this deliberately degrades the
    // render path — frames present, digests correct, bytes not an image — and asserts the
    // control goes red. That is exactly the fixture defect the previous version shipped.
    const dir = footageProject(t, { frameBytes: Buffer.from('not a jpeg at all') });

    const r = runScript('write-build-html.mjs', ['--apply', '--replace'], dir);
    assert.equal(r.code, EXIT.OK, `the build still succeeds — that is the point of this case\n${r.all}`);

    const [atStart] = await probeFootageFrames(path.join(dir, 'video-auto.html'), [0]);

    assert.equal(atStart.loaded, false, 'undecodable frames must be visible to the control, not silently tolerated');
    assert.equal(atStart.applied, null, 'and nothing may be applied as the background');
  });

  test('writeBuildHtml_footageControlFails_whenTheSceneThrowsAfterInitialising', async (t) => {
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
    const dir = footageProject(t, { gsapStub: gsapStubWithout('totalProgress') });

    const r = runScript('write-build-html.mjs', ['--apply', '--replace'], dir);
    assert.equal(r.code, EXIT.OK, `the build still succeeds — that is the point of this case\n${r.all}`);

    await assert.rejects(
      () => probeFootageFrames(path.join(dir, 'video-auto.html'), [0]),
      (err) => {
        assert.equal(err.stage, 'post-init', `the alarm must fire on the post-sampling check, not initialisation (got ${err.stage}: ${err.message})`);
        assert.equal(err.frames?.[0]?.loaded, true, 'and it must fire despite the frame loading perfectly');
        assert.equal(err.frames?.[0]?.applied, 'frame_00001.jpg', 'with the frame actually applied');
        assert.ok(err.pageErrors.some((m) => /totalProgress/.test(m)), `the removed method must be what broke it, got ${JSON.stringify(err.pageErrors)}`);
        return true;
      },
    );
  });

  test('writeBuildHtml_footageControlFails_whenTheSceneNeverInitialises', async (t) => {
    // The third distinct failure, pinned separately so the two can never satisfy each other:
    // gsap absent entirely kills the script block before __setFootageFrame is assigned.
    const dir = footageProject(t, { gsapStub: '/* nothing at all */' });

    const r = runScript('write-build-html.mjs', ['--apply', '--replace'], dir);
    assert.equal(r.code, EXIT.OK, r.all);

    await assert.rejects(
      () => probeFootageFrames(path.join(dir, 'video-auto.html'), [0]),
      (err) => {
        assert.equal(err.stage, 'init', `expected the initialisation failure, got ${err.stage}: ${err.message}`);
        return true;
      },
    );
  });

  test('writeBuildHtml_clipsJsonContainingNull_isRefusedRatherThanSilentlyDroppingFootage', (t) => {
    // The signature of this bug is exit 0 with content missing, so the exit code alone
    // proves nothing — the scene is checked too.
    const dir = footageProject(t, { clipsJson: 'null' });

    const r = runScript('write-build-html.mjs', ['--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.USAGE, 'a present file whose content is null is not an absent file: ');
    assert.match(r.all, /clips\.json/, 'and the refusal must name the file');
    const built = path.join(dir, 'video-auto.html');
    if (fs.existsSync(built)) {
      assert.match(fs.readFileSync(built, 'utf8'), /myclip/, 'a scene must never be published with the footage silently dropped');
    }
  });

  test('writeBuildHtml_evidencePackContainingNull_isRefused', (t) => {
    const dir = footageProject(t, { evidenceJson: 'null' });

    const r = runScript('write-build-html.mjs', ['--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.USAGE, 'the approval gate must not be emptied by a null file: ');
  });

  test('writeBuildHtml_clipsJsonContainingAnArray_isRefused', (t) => {
    // `typeof [] === 'object'`, so an array reached callers that index it by property and
    // read undefined everywhere — absence again, wearing a different shape.
    const dir = footageProject(t, { clipsJson: '[]' });

    const r = runScript('write-build-html.mjs', ['--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.USAGE, 'a JSON array is not the object the caller requires: ');
  });

  test('writeBuildHtml_clipsJsonContainingAScalar_isRefused', (t) => {
    const dir = footageProject(t, { clipsJson: '42' });

    const r = runScript('write-build-html.mjs', ['--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.USAGE, 'a JSON scalar is not the object the caller requires: ');
  });

  test('writeBuildHtml_clipsPropertyWithWrongType_isRefused', (t) => {
    // The shape the caller actually relies on: `(FOOTAGE.clips || []).find(...)`. A string
    // `clips` has a .find of undefined, and an object has none at all.
    const dir = footageProject(t, { clipsJson: JSON.stringify({ clips: 'not-an-array' }) });

    const r = runScript('write-build-html.mjs', ['--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.USAGE, 'clips must be an array where the caller iterates it: ');
    assert.match(r.all, /clips/, 'and the refusal must name the property');
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
describe('validate-timing refuses to judge malformed timing', () => {
  test('validateTiming_finalSegmentEndMsNotNumeric_failsRatherThanExitingZero', (t) => {
    const segments = [
      { id: 'one', startMs: 0, endMs: 2000, voiceoverText: 'a word or two' },
      { id: 'two', startMs: 2000, endMs: 'bad', voiceoverText: 'b word or two' },
    ];
    const dir = makeProject(t, { 'timing.json': timingFixture(segments) });
    const r = runScript('validate-timing.mjs', ['--no-schema', '--strict'], dir);

    assertCleanExit(r, EXIT.FAILED, 'a verifier must not pass timing it could not evaluate: ');
    assert.match(r.all, /two/, 'the failure must name the offending segment');
  });

  test('validateTiming_middleSegmentStartMsNotNumeric_failsRatherThanExitingZero', (t) => {
    const segments = [
      { id: 'one', startMs: 0, endMs: 2000, voiceoverText: 'a' },
      { id: 'two', startMs: 'nope', endMs: 4000, voiceoverText: 'b' },
      { id: 'three', startMs: 4000, endMs: 6000, voiceoverText: 'c' },
    ];
    const dir = makeProject(t, { 'timing.json': timingFixture(segments) });
    const r = runScript('validate-timing.mjs', ['--no-schema'], dir);

    assertCleanExit(r, EXIT.FAILED, 'malformed timing must fail: ');
  });

  test('validateTiming_nonPositiveWindow_failsRatherThanProducingAZeroBudget', (t) => {
    // startMs 0 so contiguity is intact — the zero-length window is the only defect,
    // and without --strict an over-budget segment is only advisory, so pre-fix this
    // exits 0 with narration that cannot possibly fit.
    const segments = [{ id: 'one', startMs: 0, endMs: 0, voiceoverText: 'a b c' }];
    const dir = makeProject(t, { 'timing.json': timingFixture(segments) });
    const r = runScript('validate-timing.mjs', ['--no-schema'], dir);

    assertCleanExit(r, EXIT.FAILED, 'a zero-length window cannot carry narration: ');
  });

  test('validateTiming_malformedTiming_saysTheLaterChecksWereNotEvaluated', (t) => {
    const segments = [{ id: 'one', startMs: 0, endMs: 'bad', voiceoverText: 'a' }];
    const dir = makeProject(t, { 'timing.json': timingFixture(segments) });
    const r = runScript('validate-timing.mjs', ['--no-schema'], dir);

    assert.match(r.all, /not evaluated|NOT evaluated/i, 'a check that did not run must say so, not stay silent');
  });

  test('validateTiming_wellFormedTiming_stillPasses', (t) => {
    const dir = makeProject(t, { 'timing.json': timingFixture(contiguousSegments) });
    const r = runScript('validate-timing.mjs', ['--no-schema'], dir);

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
describe('engine-chosen outputs refuse links', () => {
  const voiceFiles = { 'timing.json': timingFixture(), 'brand/tokens.json': brandTokens };

  test('voice_syncMappingLinkedToAnUnrelatedInRootFile_isRefused', (t) => {
    // Distinctness cannot see this: only one output maps to notes.md.
    const dir = makeProject(t, { ...voiceFiles, 'notes.md': SENTINEL });
    if (!tryMakeFileLink(path.join(dir, 'sync-mapping.md'), path.join(dir, 'notes.md'))) {
      return t.skip('platform refused to create a file link');
    }
    const r = runScript('voice.mjs', ['--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.USAGE, 'an engine-chosen output must not be redirected by a link: ');
    assert.equal(fs.readFileSync(path.join(dir, 'notes.md'), 'utf8'), SENTINEL);
  });

  test('voice_healLogLinkedToAnUnrelatedInRootFile_isRefused', (t) => {
    const dir = makeProject(t, { ...voiceFiles, 'notes.txt': SENTINEL });
    if (!tryMakeFileLink(path.join(dir, 'heal-log.txt'), path.join(dir, 'notes.txt'))) {
      return t.skip('platform refused to create a file link');
    }
    const r = runScript('voice.mjs', ['--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.USAGE, 'an appended engine log must not be redirected by a link: ');
    assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), SENTINEL);
  });

  test('remix_voiceoverLinkedToAnUnrelatedInRootFile_isRefused', (t) => {
    const dir = makeProject(t, { 'timing.json': timingFixture(wordedSegments), 'notes.txt': SENTINEL });
    if (!tryMakeFileLink(path.join(dir, 'voiceover.mp3'), path.join(dir, 'notes.txt'))) {
      return t.skip('platform refused to create a file link');
    }
    const r = runScript('remix.mjs', ['--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.USAGE, 'remix output must not be redirected by a link: ');
    assert.match(r.all, /is a link/, r.all);
    assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), SENTINEL);
  });

  test('silenceGen_userNamedOutputThroughAnInRootLink_isStillPermitted', (t) => {
    // The counterpart: a path the caller NAMED may legitimately resolve through an
    // in-root link. Tightening engine outputs must not tighten this.
    const dir = makeProject(t, { 'real/target.mp3': 'old' });
    if (!tryMakeDirLink(path.join(dir, 'alias'), path.join(dir, 'real'))) {
      return t.skip('platform refused to create a directory link');
    }
    const r = runScript('silence-gen.mjs', ['--out', 'alias/target.mp3', '--ms', '480', '--apply', '--replace'], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.equal(fs.statSync(path.join(dir, 'real', 'target.mp3')).size, 20 * 288);
  });
});

// ---------------------------------------------------------------------------
// The plan must disclose the write set it now preflights.
// ---------------------------------------------------------------------------
describe('voice plan discloses every output', () => {
  test('voice_plan_listsSecondaryArtifactsWithReplaceStatus', (t) => {
    const dir = makeProject(t, {
      'timing.json': timingFixture(),
      'brand/tokens.json': brandTokens,
      'calibration-observed.json': SENTINEL,
      'sync-mapping.md': SENTINEL,
    });
    const r = runScript('voice.mjs', [], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(r.all, /calibration-observed\.json/, 'the plan must name every file --apply rewrites');
    assert.match(r.all, /sync-mapping\.md/);
    assert.match(r.all, /heal-log\.txt/, 'including the conditional append');
    assert.match(r.all, /EXISTS|REPLACE/, 'and say what would happen to the ones already there');
  });
});

describe('boundary root canonicalisation', () => {
  test('createBoundary_absentRoot_isPermittedForNotYetCreatedProjects', (t) => {
    const dir = makeProject(t);
    const missing = path.join(dir, 'not-created-yet');
    assert.doesNotThrow(() => createBoundary(missing));
  });

  test('createBoundary_rootIsAFile_isRefused', (t) => {
    const dir = makeProject(t, { 'a-file.txt': 'x' });
    assert.throws(() => createBoundary(path.join(dir, 'a-file.txt')), CliError);
  });

  test('createBoundary_rootInspectionFails_isRefusedRatherThanFallingBackToLexical', (t) => {
    // A link cycle: realpath reports ELOOP, which proves nothing about containment.
    const dir = makeProject(t);
    const a = path.join(dir, 'loop-a');
    const b = path.join(dir, 'loop-b');
    if (!tryMakeDirLink(a, b) || !tryMakeDirLink(b, a)) return t.skip('platform refused to create the link cycle');
    let failed = false;
    try {
      fs.realpathSync.native(a);
    } catch (err) {
      failed = err.code !== 'ENOENT';
    }
    if (!failed) return t.skip('this platform resolves the cycle without an inspection error');

    assert.throws(() => createBoundary(a), CliError, 'an uninspectable root must not degrade to a lexical boundary');
  });
});

// ---------------------------------------------------------------------------
// JSON has no `undefined`, so an absent timestamp is often written as null. `Number(null)`
// is 0, which is finite, so a null endMs was read as "ends at zero". It lost the
// Math.max that sizes the capture, and the render stopped before that segment's
// narration: no error, and a frame count that looked measured.
// ---------------------------------------------------------------------------
describe('a null timestamp is absent, not zero', () => {
  const timingWithSecondSegment = (second) => JSON.stringify({
    project: { name: 'demo', fps: 30, width: 320, height: 240 },
    endCard: { enabled: false },
    segments: [
      { id: 'one', startMs: 0, endMs: 2000, voiceoverText: 'hello', audio: { durationMs: 2000 } },
      { id: 'two', voiceoverText: 'second segment', ...second },
    ],
  });

  test('frameCapture_segmentEndMsNull_derivesItsEndFromTheMeasuredClip', (t) => {
    const dir = makeProject(t, {
      ...captureFiles,
      'timing.json': timingWithSecondSegment({ startMs: 2000, endMs: null, audio: { durationMs: 2000 } }),
    });

    const r = runScript('frame-capture.mjs', [], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    // (2000 start + 2000 measured + 1000 tail) ms at 30 fps. A null read as 0 gives 90.
    assert.match(r.all, /frames\s+150 at 30 fps/, `the capture must cover the segment whose endMs is null\n${r.all}`);
  });

  for (const [scenario, second] of [
    ['StartMsNull', { startMs: null, audio: { durationMs: 2000 } }],
    ['MeasuredDurationNull', { startMs: 2000, audio: { durationMs: null } }],
  ]) {
    test(`frameCapture_segmentWith${scenario}AndNoEndMs_namesTheSegmentItCannotPlace`, (t) => {
      const dir = makeProject(t, { ...captureFiles, 'timing.json': timingWithSecondSegment(second) });

      const r = runScript('frame-capture.mjs', [], dir);

      assertCleanExit(r, EXIT.USAGE, 'a segment placed by a null must be refused, not placed at zero: ');
      assert.match(r.all, /"two"/, 'the refusal must name the segment');
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
describe('write-build-html refuses a segment it cannot place', () => {
  const TOO_LARGE = 987654321; // written as 1e400, which JSON.parse reads as Infinity
  const sceneWith = (t, segments) =>
    makeProject(t, {
      'timing.json': timingFixture(segments, { durationMs: 4000, contentMs: 4000 }).replace(String(TOO_LARGE), '1e400'),
      'evidence-pack/.keep': '',
      'node_modules/gsap/dist/gsap.min.js': '/* gsap stub */',
    });
  const withSecond = (second) => [contiguousSegments[0], { ...contiguousSegments[1], ...second }];

  test('writeBuildHtml_finiteSegmentTimes_buildsTheScene', (t) => {
    // The control: the fixture the refusals below are built from must build.
    const dir = sceneWith(t, withSecond({}));

    const r = runScript('write-build-html.mjs', ['--apply'], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.equal(fs.existsSync(path.join(dir, 'video-auto.html')), true);
  });

  for (const [scenario, second, field] of [
    ['startMsMissing', { startMs: undefined }, /startMs/],
    ['endMsNull', { endMs: null }, /endMs/],
    ['startMsNonNumericString', { startMs: 'soon' }, /startMs/],
    ['startMsNumericString', { startMs: '2000' }, /startMs/],
    ['endMsOverflowingToInfinity', { endMs: TOO_LARGE }, /endMs/],
  ]) {
    for (const [mode, args] of [['InPlan', []], ['UnderApply', ['--apply']]]) {
      test(`writeBuildHtml_${scenario}${mode}_exitsUsageNamingTheSegmentAndWritesNothing`, (t) => {
        const dir = sceneWith(t, withSecond(second));

        const r = runScript('write-build-html.mjs', args, dir);

        assertCleanExit(r, EXIT.USAGE, `a segment with ${scenario} must be refused: `);
        assert.match(r.all, /"two"/, 'the refusal must name the segment');
        assert.match(r.all, field, 'and the time it cannot use');
        assert.equal(fs.existsSync(path.join(dir, 'video-auto.html')), false, 'and nothing may be written');
      });
    }
  }

  test('writeBuildHtml_twoSegmentsWithUnusableTimes_namesBothInOneRefusal', (t) => {
    const dir = sceneWith(t, [{ ...contiguousSegments[0], endMs: undefined }, { ...contiguousSegments[1], startMs: null }]);

    const r = runScript('write-build-html.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.USAGE, 'unusable segment times must be refused: ');
    assert.match(r.all, /"one"[^\n]*endMs/, 'the first segment must be named with its field');
    assert.match(r.all, /"two"[^\n]*startMs/, 'and so must the second, in the same refusal');
    assert.equal(fs.existsSync(path.join(dir, 'video-auto.html')), false);
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

describe('an unparseable timing.json is refused as bad input, by every stage', () => {
  // frame-capture is the model: it already does this, so it is the control. If it ever
  // stops, the thing being copied has moved and these tests are measuring a new target.
  for (const stage of ['remix.mjs', 'write-storyboard.mjs', 'concat-audio.mjs', 'frame-capture.mjs']) {
    test(`${stage.replace(/\W/g, '_')}_unparseableTimingJson_isRefusedAsBadInput`, (t) => {
      const dir = makeProject(t, { 'timing.json': '{ not json' });

      const r = runScript(stage, [], dir);

      // assertCleanExit also rejects a stack trace, which is half the defect here: an
      // uncaught SyntaxError exits non-zero too, so `notEqual(code, 0)` would pass against
      // the crash this exists to remove.
      assertCleanExit(r, EXIT.USAGE, `${stage}: unreadable input is the caller's fault: `);
      assert.doesNotMatch(r.all, /SyntaxError/, `${stage}: the raw parser error escaped\n${r.all}`);
      assert.match(r.all, /timing\.json is not valid JSON/, `${stage}: the refusal must name the file\n${r.all}`);
    });
  }

  test('unparseableTimingJson_isRefusedBeforeAnythingIsWritten', (t) => {
    // STATE, NOT JUST THE CODE. A clean exit code with half-written output is not a clean
    // refusal. Nothing can legitimately be produced from a file that never parsed, so the
    // directory must hold exactly what it held before.
    const dir = makeProject(t, { 'timing.json': '{ not json' });
    const before = fs.readdirSync(dir).sort();

    for (const stage of ['remix.mjs', 'write-storyboard.mjs', 'concat-audio.mjs', 'frame-capture.mjs']) {
      const r = runScript(stage, ['--apply'], dir);
      assert.notEqual(r.code, EXIT.OK, `${stage} must refuse\n${r.all}`);
      assert.deepEqual(fs.readdirSync(dir).sort(), before, `${stage} wrote something from a file it could not read\n${r.all}`);
    }
  });

  test('unparseableTimingJson_isRefusedWithoutQuotingItsContents', (t) => {
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
    const SENTINEL = 'LEAK7f3a';
    // frame-capture.mjs:63 has the SAME disclosure and is NOT in this task's scope, so it is
    // excluded here and reported rather than quietly fixed. It remains in every other case
    // above as the exit-code control.
    for (const stage of ['remix.mjs', 'write-storyboard.mjs', 'concat-audio.mjs']) {
      const dir = makeProject(t, { 'timing.json': `${SENTINEL}: 1` });

      const r = runScript(stage, [], dir);

      assertCleanExit(r, EXIT.USAGE, `${stage}: `);
      assert.ok(!r.all.includes(SENTINEL), `${stage}: the refusal quoted the file's contents\n${r.all}`);
      assert.doesNotMatch(r.all, /Unexpected token/, `${stage}: the parser's message was forwarded\n${r.all}`);
      assert.match(r.all, /timing\.json is not valid JSON/, `${stage}: it must still name the file\n${r.all}`);
    }
  });

  test('aParseableTimingJson_isNotRefusedAsBadInput', (t) => {
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
    const dir = makeProject(t, { 'timing.json': timingFixture(wordedSegments) });

    for (const stage of ['remix.mjs', 'write-storyboard.mjs']) {
      const r = runScript(stage, [], dir);
      assertCleanExit(r, EXIT.OK, `${stage} must plan a well-formed timeline: `);
    }
    for (const [stage, code, reached] of [
      ['concat-audio.mjs', EXIT.FAILED, /segment_000\.mp3 is missing/],
      ['frame-capture.mjs', EXIT.USAGE, /video-auto\.html not found/],
    ]) {
      const r = runScript(stage, [], dir);
      assertCleanExit(r, code, `${stage}: `);
      assert.match(r.all, reached, `${stage} must get past the parse to its own prerequisite\n${r.all}`);
      assert.doesNotMatch(r.all, /is not valid JSON/, `${stage} refused a well-formed file\n${r.all}`);
    }
  });
});

