// Behavioural tests for the safety and honesty contract of the engine's CLI scripts.
//
// The property under test, across every case here:
//   "if a script exits 0, it did the job it was asked to do — and if it was not
//    explicitly told to destroy something, it destroyed nothing."
//
// These scripts execute on import (they are CLI entry points), so they are exercised
// as subprocesses in a throwaway project directory and asserted on their exit code
// plus the observable filesystem, which is the contract their callers actually rely on.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { EXIT, resolveWithinRoot, parseBoundedNumber, requirePositiveNumber, CliError } from '../src/cli-support.mjs';
import { assertCleanExit } from './_helpers.mjs';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Creates a throwaway project dir, removed when the test ends. */
function makeProject(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sizzlecraft-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  return dir;
}

/** Runs an engine script as a real CLI in `cwd` and returns its exit code + streams. */
function runScript(script, args, cwd) {
  const r = spawnSync(process.execPath, [path.join(srcDir, script), ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', all: (r.stdout ?? '') + (r.stderr ?? '') };
}

const timingFixture = (segments, extra = {}) =>
  JSON.stringify({
    project: { name: 'demo', fps: 30, width: 1280, height: 720 },
    durationMs: segments.at(-1).endMs,
    contentMs: segments.at(-1).endMs,
    segments,
    ...extra,
  });

/** An absolute path that is guaranteed not to be an executable, for the "ffmpeg never ran" cases. */
const MISSING_FFMPEG = path.join(os.tmpdir(), 'sizzlecraft-no-such-dir', 'no-such-ffmpeg-binary.exe');

// Schema validation needs ajv. The contract holds either way — with ajv a bad shape must
// fail, without it the verifier must refuse to report a pass — so the suite asserts
// whichever half this environment can actually reach rather than assuming one.
const ajvAvailable = await import('ajv/dist/2020.js').then(() => true, () => false);

const contiguousSegments = [
  { id: 'one', startMs: 0, endMs: 2000, voiceoverText: 'hello there' },
  { id: 'two', startMs: 2000, endMs: 4000, voiceoverText: 'second segment here' },
];

// ---------------------------------------------------------------------------
// frame-capture.mjs — the highest-value guard in this suite.
// A no-flag run used to recursively delete the project's frames/ directory before
// it had done a single useful thing.
// ---------------------------------------------------------------------------
describe('frame-capture safe default', () => {
  const project = (t) =>
    makeProject(t, {
      'timing.json': timingFixture(contiguousSegments),
      'video-auto.html': '<html><body><div id="stage"></div></body></html>',
      'frames/frame_00000.png': 'EXISTING FRAME ZERO',
      'frames/frame_00001.png': 'EXISTING FRAME ONE',
    });

  test('frameCapture_noFlags_preservesExistingFramesAndExitsZero', (t) => {
    const dir = project(t);
    const r = runScript('frame-capture.mjs', [], dir);

    assert.equal(r.code, EXIT.OK, `expected a clean plan exit, got ${r.code}\n${r.all}`);
    assert.equal(
      fs.readFileSync(path.join(dir, 'frames', 'frame_00000.png'), 'utf8'),
      'EXISTING FRAME ZERO',
      'a default (no-flag) run must not destroy existing frames',
    );
    assert.ok(fs.existsSync(path.join(dir, 'frames', 'frame_00001.png')));
  });

  test('frameCapture_noFlags_printsPlanAndDoesNotCapture', (t) => {
    const dir = project(t);
    const r = runScript('frame-capture.mjs', [], dir);

    assert.match(r.all, /plan/i, 'the default run must announce that it is only planning');
    assert.match(r.all, /--apply/, 'the plan must name the flag that would actually perform the capture');
  });

  test('frameCapture_applyWithLockHeldByLiveOwner_exitsSkippedNotZero', (t) => {
    const dir = project(t);
    // A live PID (this test process) owns the lock, so the capture must not run.
    fs.writeFileSync(path.join(dir, 'frames.lock'), String(process.pid));

    const r = runScript('frame-capture.mjs', ['--apply'], dir);

    assert.equal(r.code, EXIT.SKIPPED, `a skipped capture must not report success, got ${r.code}\n${r.all}`);
    assert.equal(
      fs.readFileSync(path.join(dir, 'frames', 'frame_00000.png'), 'utf8'),
      'EXISTING FRAME ZERO',
      'a capture that never ran must leave the existing frames alone',
    );
  });
});

// ---------------------------------------------------------------------------
// silence-gen.mjs — wrote to an unchecked, unconfined output path on any invocation.
// ---------------------------------------------------------------------------
describe('silence-gen safe default', () => {
  test('silenceGen_noFlags_doesNotWriteOutputAndExitsZero', (t) => {
    const dir = makeProject(t);
    const r = runScript('silence-gen.mjs', ['--out', 'silence.mp3', '--ms', '500'], dir);

    assert.equal(r.code, EXIT.OK, `planning is a success, got ${r.code}\n${r.all}`);
    assert.equal(fs.existsSync(path.join(dir, 'silence.mp3')), false, 'a default run must not write');
  });

  test('silenceGen_applyOverExistingFileWithoutReplace_refusesAndPreservesBytes', (t) => {
    const dir = makeProject(t, { 'silence.mp3': 'DO NOT CLOBBER ME' });
    const r = runScript('silence-gen.mjs', ['--out', 'silence.mp3', '--ms', '500', '--apply'], dir);

    assert.equal(r.code, EXIT.USAGE, `expected a refusal, got ${r.code}\n${r.all}`);
    assert.equal(fs.readFileSync(path.join(dir, 'silence.mp3'), 'utf8'), 'DO NOT CLOBBER ME');
    assert.match(r.all, /--replace/, 'the refusal must name the flag that would allow the overwrite');
  });

  test('silenceGen_applyReplace_writesFrameAlignedSilence', (t) => {
    const dir = makeProject(t, { 'silence.mp3': 'OLD' });
    const r = runScript('silence-gen.mjs', ['--out', 'silence.mp3', '--ms', '480', '--apply', '--replace'], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    const buf = fs.readFileSync(path.join(dir, 'silence.mp3'));
    // 480ms / 24ms per frame = 20 frames of 288 bytes.
    assert.equal(buf.length, 20 * 288);
    assert.deepEqual([...buf.subarray(0, 4)], [0xff, 0xf3, 0xa4, 0xc0], 'MPEG-2 L3 24kHz 96kbps mono header');
  });

  test('silenceGen_outPathEscapingProjectRoot_exitsUsageErrorAndWritesNothing', (t) => {
    const dir = makeProject(t);
    const escape = path.join('..', 'escaped-silence.mp3');
    const r = runScript('silence-gen.mjs', ['--out', escape, '--ms', '500', '--apply', '--replace'], dir);

    assert.equal(r.code, EXIT.USAGE, `expected a refusal, got ${r.code}\n${r.all}`);
    assert.equal(fs.existsSync(path.resolve(dir, escape)), false, 'must never write outside the project root');
  });

  test('silenceGen_nonNumericDuration_exitsUsageError', (t) => {
    const dir = makeProject(t);
    const r = runScript('silence-gen.mjs', ['--out', 'x.mp3', '--ms', '3500; rm -rf /', '--apply'], dir);

    assert.equal(r.code, EXIT.USAGE, r.all);
    assert.equal(fs.existsSync(path.join(dir, 'x.mp3')), false);
  });
});

// ---------------------------------------------------------------------------
// validate-timing.mjs — a verifier that printed failures and exited 0 is a green
// light nobody earned.
// ---------------------------------------------------------------------------
describe('validate-timing exit contract', () => {
  test('validateTiming_contiguousSegments_exitsZero', (t) => {
    const dir = makeProject(t, { 'timing.json': timingFixture(contiguousSegments) });
    const r = runScript('validate-timing.mjs', ['--no-schema'], dir);

    assert.equal(r.code, EXIT.OK, `a valid timing file must pass, got ${r.code}\n${r.all}`);
  });

  test('validateTiming_segmentGap_exitsFailureNotZero', (t) => {
    const gapped = [
      { id: 'one', startMs: 0, endMs: 2000, voiceoverText: 'hello there' },
      { id: 'two', startMs: 2500, endMs: 4000, voiceoverText: 'gap before me' },
    ];
    const dir = makeProject(t, { 'timing.json': timingFixture(gapped) });
    const r = runScript('validate-timing.mjs', ['--no-schema'], dir);

    assert.equal(r.code, EXIT.FAILED, `a contiguity break must fail the build, got ${r.code}\n${r.all}`);
    assert.match(r.all, /gap|overlap/i);
  });

  test('validateTiming_noSchemaFlag_marksShapeAsNotVerified', (t) => {
    const dir = makeProject(t, { 'timing.json': timingFixture(contiguousSegments) });
    const r = runScript('validate-timing.mjs', ['--no-schema'], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(r.all, /skipped/i, 'a skipped check must say it was skipped');
    assert.match(r.all, /NOT verified/i, 'and must not let the reader assume the shape was checked');
  });

  test('validateTiming_validTimingWithSchema_exitsZero', { skip: ajvAvailable ? false : 'ajv not installed' }, (t) => {
    const dir = makeProject(t, { 'timing.json': timingFixture(contiguousSegments) });
    const r = runScript('validate-timing.mjs', [], dir);

    assert.equal(r.code, EXIT.OK, `the shipped schema must accept a well-formed timing file\n${r.all}`);
    assert.match(r.all, /SCHEMA: valid/);
  });

  test('validateTiming_schemaViolation_exitsFailureNotZero', { skip: ajvAvailable ? false : 'ajv not installed' }, (t) => {
    // `voiceoverText` is required by the shipped schema; contiguity is intact, so this
    // isolates the schema check.
    const missingText = [
      { id: 'one', startMs: 0, endMs: 2000 },
      { id: 'two', startMs: 2000, endMs: 4000, voiceoverText: 'fine' },
    ];
    const dir = makeProject(t, { 'timing.json': timingFixture(missingText) });
    const r = runScript('validate-timing.mjs', [], dir);

    assert.equal(r.code, EXIT.FAILED, `a schema violation must fail the build, got ${r.code}\n${r.all}`);
    assert.match(r.all, /SCHEMA: INVALID/);
  });

  test('validateTiming_schemaUnavailable_exitsNonZeroRatherThanSkipping', { skip: ajvAvailable ? 'ajv is installed' : false }, (t) => {
    const dir = makeProject(t, { 'timing.json': timingFixture(contiguousSegments) });
    const r = runScript('validate-timing.mjs', [], dir);

    assertCleanExit(r, EXIT.USAGE, 'schema validation that did not happen must never look like a pass: ');
    assert.match(r.all, /ajv|--no-schema/i, 'the failure must tell the user what to do');
  });

  test('validateTiming_schemaFileMissing_exitsUsageError', (t) => {
    const dir = makeProject(t, { 'timing.json': timingFixture(contiguousSegments) });
    const r = runScript('validate-timing.mjs', ['--schema', 'no-such-schema.json'], dir);

    assert.equal(r.code, EXIT.USAGE, r.all);
  });
});

// ---------------------------------------------------------------------------
// check-levels.mjs — ignored ffmpeg's exit status and printed NaN as if measured.
// ---------------------------------------------------------------------------
describe('check-levels exit contract', () => {
  test('checkLevels_ffmpegFailsToRun_exitsNonZeroInsteadOfReportingNaN', (t) => {
    const dir = makeProject(t, {
      'ffmpeg-path.txt': MISSING_FFMPEG,
      'clip.mp4': 'not really an mp4',
    });
    const r = runScript('check-levels.mjs', ['--file', 'clip=clip.mp4'], dir);

    assertCleanExit(r, EXIT.FAILED, 'ffmpeg never ran, so this must not report success: ');
    assert.doesNotMatch(r.stdout, /NaN/, 'must not print NaN measurements as if they were real');
  });
});

// ---------------------------------------------------------------------------
// remux-music.mjs — unconditional -y overwrite, unvalidated gains interpolated
// straight into an ffmpeg filter graph, and a video-hash mismatch that only warned.
// ---------------------------------------------------------------------------
describe('remux-music safety', () => {
  const project = (t) =>
    makeProject(t, {
      'ffmpeg-path.txt': MISSING_FFMPEG,
      'in.mp4': 'video bytes',
      'voiceover.mp3': 'voice bytes',
      'music.wav': 'music bytes',
    });

  test('remuxMusic_noFlags_doesNotWriteOutputAndExitsZero', (t) => {
    const dir = project(t);
    const r = runScript(
      'remux-music.mjs',
      ['--video', 'in.mp4', '--voice', 'voiceover.mp3', '--music', 'music.wav', '--out', 'out.mp4'],
      dir,
    );

    assert.equal(r.code, EXIT.OK, `planning is a success, got ${r.code}\n${r.all}`);
    assert.equal(fs.existsSync(path.join(dir, 'out.mp4')), false, 'a default run must not produce output');
    assert.match(r.all, /--apply/, 'the plan must name the flag that would perform the remux');
  });

  test('remuxMusic_gainCarryingFilterGraphInjection_refusedBeforeFfmpegIsInvoked', (t) => {
    const dir = project(t);
    const r = runScript(
      'remux-music.mjs',
      [
        '--video', 'in.mp4', '--voice', 'voiceover.mp3', '--music', 'music.wav', '--out', 'out.mp4',
        '--voice-gain', '1.0,volume=40',
        '--apply',
      ],
      dir,
    );

    assert.equal(r.code, EXIT.USAGE, `a malformed gain must be refused, got ${r.code}\n${r.all}`);
    assert.equal(fs.existsSync(path.join(dir, 'out.mp4')), false);
  });

  test('remuxMusic_gainOutsideAllowedRange_exitsUsageError', (t) => {
    const dir = project(t);
    const r = runScript(
      'remux-music.mjs',
      [
        '--video', 'in.mp4', '--voice', 'voiceover.mp3', '--music', 'music.wav', '--out', 'out.mp4',
        '--music-gain', '9999',
        '--apply',
      ],
      dir,
    );

    assert.equal(r.code, EXIT.USAGE, r.all);
  });

  test('remuxMusic_applyOverExistingOutputWithoutReplace_refusesAndPreservesIt', (t) => {
    const dir = project(t);
    fs.writeFileSync(path.join(dir, 'out.mp4'), 'APPROVED DELIVERABLE');
    const r = runScript(
      'remux-music.mjs',
      ['--video', 'in.mp4', '--voice', 'voiceover.mp3', '--music', 'music.wav', '--out', 'out.mp4', '--apply'],
      dir,
    );

    assert.equal(r.code, EXIT.USAGE, `expected a refusal, got ${r.code}\n${r.all}`);
    assert.equal(fs.readFileSync(path.join(dir, 'out.mp4'), 'utf8'), 'APPROVED DELIVERABLE');
  });
});

// ---------------------------------------------------------------------------
// encode-mp4.mjs — a lock-skip that exited 0 told the pipeline an encode happened.
// ---------------------------------------------------------------------------
describe('encode-mp4 exit contract', () => {
  test('encodeMp4_lockHeldByLiveOwner_exitsSkippedNotZero', (t) => {
    const dir = makeProject(t, {
      'timing.json': timingFixture(contiguousSegments),
      'demo.mp4.lock': String(process.pid),
      'frames/frame_00000.png': 'frame',
    });
    // --apply: a plan never takes the lock, because planning is read-only.
    const r = runScript('encode-mp4.mjs', ['--apply'], dir);

    assert.equal(r.code, EXIT.SKIPPED, `a skipped encode must not report success, got ${r.code}\n${r.all}`);
  });
});

// ---------------------------------------------------------------------------
// cli-support.mjs — the shared validation primitives.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// cli-support.mjs — numeric validation. Path confinement is covered in
// path-boundary.test.mjs, against real directories and real links.
// ---------------------------------------------------------------------------
describe('cli-support primitives', () => {
  test('parseBoundedNumber_plainDecimal_returnsNumber', () => {
    assert.equal(parseBoundedNumber('1.14', { name: 'voice gain', min: 0, max: 8 }), 1.14);
  });

  test('parseBoundedNumber_valueWithFilterGraphSuffix_throws', () => {
    for (const hostile of ['1.0,volume=40', '1.0[a]', '1;x', '1e3', '0x10', 'Infinity', '']) {
      assert.throws(
        () => parseBoundedNumber(hostile, { name: 'voice gain', min: 0, max: 8 }),
        CliError,
        `"${hostile}" must be refused`,
      );
    }
  });

  test('parseBoundedNumber_valueOutOfRange_throws', () => {
    assert.throws(() => parseBoundedNumber('9999', { name: 'music gain', min: 0, max: 8 }), CliError);
    assert.throws(() => parseBoundedNumber('-1', { name: 'music gain', min: 0, max: 8 }), CliError);
  });

  test('requirePositiveNumber_zeroNegativeOrNaN_throws', () => {
    for (const bad of [0, -5, 'thirty', NaN, Infinity, null, undefined]) {
      assert.throws(() => requirePositiveNumber(bad, { name: 'fps' }), CliError, `${bad} must be refused`);
    }
  });

  test('requirePositiveNumber_validValue_returnsNumber', () => {
    assert.equal(requirePositiveNumber('30', { name: 'fps' }), 30);
  });

  test('requirePositiveNumber_nonIntegerWhenIntegerRequired_throws', () => {
    assert.throws(() => requirePositiveNumber(12.5, { name: 'totalFrames', integer: true }), CliError);
  });
});
