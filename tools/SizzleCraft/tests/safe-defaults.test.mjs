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
import { normalizeEndCardFields } from '../src/end-card.mjs';
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
// The schema IS the rule, and a rule that cannot fail reads exactly like a rule that
// passed.
//
// As shipped, `required` listed only `segments`: `version` was unconstrained, `theme`
// was undeclared, and the end-card rule was absent entirely. Round 1 made the validator
// able to REPORT schema errors and then handed it a schema that barely checked anything,
// so a timing.json with four real violations validated clean.
// ---------------------------------------------------------------------------
describe('the shipped schema enforces the timing contract', { skip: ajvAvailable ? false : 'ajv not installed' }, () => {
  const validate = (t, extra) => {
    const dir = makeProject(t, { 'timing.json': timingFixture(contiguousSegments, extra) });
    return runScript('validate-timing.mjs', [], dir);
  };
  const assertRejected = (r, why) => {
    assert.equal(r.code, EXIT.FAILED, `${why}\n${r.all}`);
    assert.match(r.all, /SCHEMA: INVALID/, why);
  };
  const assertAccepted = (r, why) => {
    assert.equal(r.code, EXIT.OK, `${why}\n${r.all}`);
    assert.match(r.all, /SCHEMA: valid/, why);
  };

  test('validateTiming_numericVersion_isRejected', (t) => {
    assertRejected(validate(t, { version: 1 }), 'version must be a string, not a number');
  });

  test('validateTiming_floatVersion_isRejected', (t) => {
    // `1.0` in JSON is the number 1 — the version "1.10" and the version "1.1" are the
    // same value once a float has eaten them.
    assertRejected(validate(t, { version: 1.0 }), 'a float version must be rejected');
  });

  test('validateTiming_stringVersion_isAccepted', (t) => {
    assertAccepted(validate(t, { version: '1.0' }), 'a string version is the contract');
  });

  test('validateTiming_themeAsObject_isRejected', (t) => {
    // `THEMES[{}]` is undefined and the lookup falls back to midnight, so an object here
    // silently rendered the wrong theme rather than failing.
    assertRejected(validate(t, { theme: {} }), 'an object theme must be rejected');
  });

  test('validateTiming_unknownThemeName_isRejected', (t) => {
    assertRejected(validate(t, { theme: 'neon' }), 'an unknown theme silently becomes midnight');
  });

  test('validateTiming_knownThemeName_isAccepted', (t) => {
    assertAccepted(validate(t, { theme: 'slate' }), 'every shipped theme must still validate');
  });

  test('validateTiming_projectThemeAsObject_isRejected', (t) => {
    // project.theme is the FIRST lookup write-build-html tries, so constraining only the
    // top-level copy would leave the one that actually wins unchecked.
    assertRejected(
      validate(t, { project: { name: 'demo', fps: 30, width: 1280, height: 720, theme: {} } }),
      'project.theme is read before the top-level one',
    );
  });

  test('validateTiming_intakeThemeUnknown_isRejected', (t) => {
    assertRejected(validate(t, { intake: { theme: 'neon' } }), 'intake.theme is the third lookup and is read too');
  });

  test('validateTiming_disabledEndCardWithStrayBuilderVersion_isRejected', (t) => {
    assertRejected(
      validate(t, { endCard: { enabled: false }, contentMs: undefined, builderVersion: '1.2.3' }),
      'a disabled end card must not carry a builderVersion',
    );
  });

  test('validateTiming_disabledEndCardWithPresentButValidFields_isRejected', (t) => {
    // Isolates the absence rule: 4000/2500 satisfy every type constraint they have, so
    // the ONLY thing that can reject this timeline is "a disabled end card carries none
    // of its fields".
    assertRejected(
      validate(t, { endCard: { enabled: false }, contentMs: 4000, outroMs: 2500 }),
      'contentMs/outroMs must be ABSENT when the end card is off',
    );
  });

  test('validateTiming_disabledEndCardWithZeroedFields_isRejectedBySchema', (t) => {
    // Present-and-zero is not absent. Zero reads as "measured it, got nothing", which is
    // a different claim from "there is no end card".
    //
    // Asserted on the SCHEMA verdict rather than the exit code: zero additionally trips
    // the contentMs >= 1 range guard, which throws EXIT.USAGE before the verdict is
    // computed. The code is a symptom of the earlier guard; the schema's judgement is
    // the property under test.
    const r = validate(t, { endCard: { enabled: false }, contentMs: 0, outroMs: 0 });

    assert.match(r.all, /SCHEMA: INVALID/, `present-and-zero must not satisfy the rule\n${r.all}`);
    assert.notEqual(r.code, EXIT.OK, 'and it must never be reported as a pass');
  });

  test('validateTiming_disabledEndCardWithNoEndCardFields_isAccepted', (t) => {
    assertAccepted(
      validate(t, { endCard: { enabled: false }, contentMs: undefined }),
      'a correctly-stripped disabled end card must still validate',
    );
  });

  test('validateTiming_enabledEndCardWithItsFields_isAccepted', (t) => {
    // The rule must not misfire on the case it does not govern.
    assertAccepted(
      validate(t, { endCard: { enabled: true }, contentMs: 4000, outroMs: 2500, builderVersion: '1.2.3' }),
      'an enabled end card legitimately carries all three fields',
    );
  });
});

// ---------------------------------------------------------------------------
// Enforcing the end-card rule exposes a real defect rather than fixing one: voice.mjs
// stripped contentMs and outroMs when the end card was disabled and left builderVersion
// behind, so once the rule is enforced NO run could produce a schema-valid disabled
// end-card timeline. Enforcing the schema without this turns a silent defect into a
// broken pipeline for every consumer that disables the end card.
// ---------------------------------------------------------------------------
describe('end-card field normalisation', () => {
  const base = () => ({
    builderVersion: '1.2.3',
    contentMs: 999,
    outroMs: 999,
    durationMs: 999,
    endCard: { enabled: false },
  });

  test('normalizeEndCardFields_endCardDisabled_stripsEveryEndCardOnlyField', () => {
    const timing = normalizeEndCardFields(base(), { contentMs: 4000, outroMs: 2500 });

    assert.equal(Object.hasOwn(timing, 'builderVersion'), false, 'builderVersion is an end-card field too');
    assert.equal(Object.hasOwn(timing, 'contentMs'), false);
    assert.equal(Object.hasOwn(timing, 'outroMs'), false);
    assert.equal(timing.durationMs, 4000, 'a disabled end card ends at the content');
  });

  test('normalizeEndCardFields_endCardEnabled_populatesAllThreeFields', () => {
    const timing = normalizeEndCardFields({ ...base(), endCard: { enabled: true } }, { contentMs: 4000, outroMs: 2500 });

    assert.equal(timing.builderVersion, '1.2.3', 'an enabled end card keeps the version it displays');
    assert.equal(timing.contentMs, 4000);
    assert.equal(timing.outroMs, 2500);
    assert.equal(timing.durationMs, 6500, 'content plus outro');
  });

  test('normalizeEndCardFields_disabledEndCardResult_validatesAgainstTheShippedSchema', { skip: ajvAvailable ? false : 'ajv not installed' }, async () => {
    // The direction that matters: what a real run PRODUCES must satisfy the rule the
    // validator now enforces. Asserting the rejection alone would have shipped a schema
    // no pipeline output could pass.
    const { default: Ajv } = await import('ajv/dist/2020.js');
    const schema = JSON.parse(fs.readFileSync(path.join(srcDir, 'timing-schema.json'), 'utf8'));
    const validateSchema = new Ajv({ allErrors: true, strict: false }).compile(schema);

    const timing = normalizeEndCardFields({ ...base(), segments: contiguousSegments }, { contentMs: 4000, outroMs: 2500 });

    assert.equal(validateSchema(timing), true, `voice.mjs output must satisfy the schema: ${JSON.stringify(validateSchema.errors)}`);
  });
});

// ---------------------------------------------------------------------------
// remix is the OTHER producer of a timing file, and it wrote contentMs/outroMs
// unconditionally — so it exited 0 having produced a file the restored schema rejects.
//
// normalizeEndCardFields was extracted this round to be reusable and then applied to one
// of its two call sites. This domain's record: assertDistinctDestinations applied to one
// collection, resolveInternalArtifact to capture metadata only, and now this. The newest
// mechanism is the least applied.
// ---------------------------------------------------------------------------
describe('every producer of a timing file obeys the end-card rule', { skip: ajvAvailable ? false : 'ajv not installed' }, () => {
  /** Real, probeable MP3s built with the engine's own generator — remix measures them. */
  const remixableProject = (t, endCardEnabled) => {
    const dir = makeProject(t);
    for (const name of ['segment_000.mp3', 'segment_001.mp3']) {
      const g = runScript('silence-gen.mjs', ['--out', name, '--ms', '2000', '--apply'], dir);
      assert.equal(g.code, EXIT.OK, `fixture audio must build for this test to mean anything\n${g.all}`);
    }
    const segments = [
      { id: 'one', startMs: 0, endMs: 2000, voiceoverText: 'hello there', audio: { file: 'segment_000.mp3', durationMs: 2000 } },
      { id: 'two', startMs: 2000, endMs: 4000, voiceoverText: 'second segment here', audio: { file: 'segment_001.mp3', durationMs: 2000 } },
    ];
    fs.writeFileSync(
      path.join(dir, 'timing.json'),
      JSON.stringify({
        project: { name: 'demo', fps: 30, width: 320, height: 240 },
        durationMs: 4000,
        contentMs: 4000,
        outroMs: 2500,
        endCard: { enabled: endCardEnabled },
        builderVersion: '9.9.9',
        intake: { toleranceMs: 60_000, leadInMs: 0, perceivedGapMs: 0 },
        segments,
      }),
    );
    return dir;
  };

  test('remix_disabledEndCard_producesTimingTheShippedSchemaAccepts', (t) => {
    const dir = remixableProject(t, false);

    const remix = runScript('remix.mjs', ['--apply', '--replace'], dir);
    assert.equal(remix.code, EXIT.OK, `remix must succeed for its output to be judged\n${remix.all}`);

    // Judged by the shipped schema, not by an expectation restated here.
    const check = runScript('validate-timing.mjs', [], dir);
    assert.match(check.all, /SCHEMA: valid/, `remix produced a timing file its own validator rejects\n${check.all}`);

    const produced = JSON.parse(fs.readFileSync(path.join(dir, 'timing.json'), 'utf8'));
    assert.equal(Object.hasOwn(produced, 'builderVersion'), false, 'builderVersion is an end-card field');
    assert.equal(Object.hasOwn(produced, 'contentMs'), false);
    assert.equal(Object.hasOwn(produced, 'outroMs'), false);
  });

  test('remix_enabledEndCard_stillPopulatesTheEndCardFields', (t) => {
    // The rule must not misfire on the case it does not govern.
    const dir = remixableProject(t, true);

    const remix = runScript('remix.mjs', ['--apply', '--replace'], dir);
    assert.equal(remix.code, EXIT.OK, remix.all);

    const produced = JSON.parse(fs.readFileSync(path.join(dir, 'timing.json'), 'utf8'));
    assert.equal(produced.builderVersion, '9.9.9', 'an enabled end card keeps the version it displays');
    assert.equal(typeof produced.contentMs, 'number');
    assert.equal(typeof produced.outroMs, 'number');
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
