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
  brandTokens,
  tryMakeDirLink,
  tryMakeFileLink,
  BLOCK_PLAYWRIGHT,
  assertCleanExit,
  runScriptDeletingOnMarker,
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

  test('validateTiming_calibrationWordsPerSecondNotANumber_failsRatherThanPassing', (t) => {
    const dir = makeProject(t, {
      'timing.json': timingFixture(overBudget),
      'calibration-observed.json': JSON.stringify({ wordsPerSecond: 'oops' }),
    });
    const r = runScript('validate-timing.mjs', ['--no-schema', '--strict'], dir);

    assertCleanExit(r, EXIT.USAGE, 'a NaN budget must not silently pass --strict: ');
  });

  test('validateTiming_calibrationMarginNotANumber_failsRatherThanPassing', (t) => {
    // Deliberately WITHIN budget and contiguous: the only thing that can fail this run is
    // the margin guard, so a pass cannot be mistaken for the budget check firing.
    const dir = makeProject(t, {
      'timing.json': timingFixture(contiguousSegments),
      'calibration-observed.json': JSON.stringify({ wordsPerSecond: 3, wpsSafetyMargin: null }),
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
      'calibration-observed.json': JSON.stringify({ wordsPerSecond: 3.43, wpsSafetyMargin: 0.97 }),
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
describe('envelope input validation', () => {
  test('makeMusic_envelopeWithEmptyRms_refusesBeforeWriting', (t) => {
    const dir = makeProject(t, { 'env.json': JSON.stringify({ rms: [] }) });
    const r = runScript('make-music.mjs', ['--out', 'bed.wav', '--seconds', '2', '--envelope', 'env.json', '--apply'], dir);

    assertCleanExit(r, EXIT.USAGE, 'an empty envelope must not produce NaN samples: ');
    assert.equal(fs.existsSync(path.join(dir, 'bed.wav')), false);
  });

  test('makeMusic_envelopeWithNonNumericSamples_refusesBeforeWriting', (t) => {
    const dir = makeProject(t, { 'env.json': JSON.stringify({ rms: [0.1, 'x', 0.2] }) });
    const r = runScript('make-music.mjs', ['--out', 'bed.wav', '--seconds', '2', '--envelope', 'env.json', '--apply'], dir);

    assertCleanExit(r, EXIT.USAGE, 'a non-numeric envelope sample must be refused: ');
    assert.equal(fs.existsSync(path.join(dir, 'bed.wav')), false);
  });

  test('makeMusic_envelopeMissingRmsArray_refusesBeforeWriting', (t) => {
    const dir = makeProject(t, { 'env.json': JSON.stringify({ durationMs: 100 }) });
    const r = runScript('make-music.mjs', ['--out', 'bed.wav', '--seconds', '2', '--envelope', 'env.json', '--apply'], dir);

    assertCleanExit(r, EXIT.USAGE, 'an envelope without an rms array must be refused: ');
  });

  test('makeMusic_validEnvelope_writesFiniteSamples', (t) => {
    const rms = Array.from({ length: 120 }, (_, i) => (i % 20 < 10 ? 0.2 : 0.001));
    const dir = makeProject(t, { 'env.json': JSON.stringify({ rms, hopMs: 20, durationMs: 2400 }) });
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
    const dir = makeProject(t, { 'timing.json': timingFixture() });
    if (!tryMakeFileLink(path.join(dir, 'voiceover.mp3'), path.join(dir, 'timing.json'))) {
      return t.skip('platform refused to create a file link');
    }
    const before = fs.readFileSync(path.join(dir, 'timing.json'), 'utf8');
    const r = runScript('remix.mjs', ['--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.USAGE, 'voiceover and timing resolving to one file must be refused: ');
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
    const dir = makeProject(t, { 'env.json': JSON.stringify({ rms, hopMs: 20, durationMs: 12000 }) });
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
    const dir = makeProject(t, { 'timing.json': timingFixture(), 'notes.txt': SENTINEL });
    if (!tryMakeFileLink(path.join(dir, 'voiceover.mp3'), path.join(dir, 'notes.txt'))) {
      return t.skip('platform refused to create a file link');
    }
    const r = runScript('remix.mjs', ['--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.USAGE, 'remix output must not be redirected by a link: ');
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