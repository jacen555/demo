// Destroy-by-default.
//
// Round one fixed the scripts that *claimed* to have done work they had not, and ranked
// six scripts "Low — fails honestly" because they reported their failures accurately.
// That was the wrong axis. The property has two halves:
//
//   a script must not do something irreversible without being asked,
//   and must not claim to have done something it did not.
//
// Overwriting a storyboard on a bare invocation and then reporting the failure
// accurately has still overwritten the storyboard. These tests pin the first half for
// every script in the engine that writes, plus the cases where an unvalidated argument
// lets a script skip its work and still report success.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { EXIT } from '../src/cli-support.mjs';
import {
  makeProject,
  makeOutsideDir,
  runScript,
  timingFixture,
  contiguousSegments,
  brandTokens,
  MISSING_FFMPEG,
  assertCleanExit,
} from './_helpers.mjs';

const SENTINEL = 'SENTINEL — MUST SURVIVE A BARE INVOCATION';

/**
 * The shape every writing script in this engine must satisfy.
 * `files` seeds the project; `output` is the artifact a bare run must not touch.
 */
function itPlansByDefault({ script, args = [], files, output, extraAssert }) {
  test(`${script.replace('.mjs', '')}_noFlags_preservesExistingOutputAndExitsZero`, (t) => {
    const dir = makeProject(t, { ...files, [output]: SENTINEL });
    const r = runScript(script, args, dir);

    assert.equal(r.code, EXIT.OK, `a plan run must succeed, got ${r.code}\n${r.all}`);
    assert.equal(
      fs.readFileSync(path.join(dir, output), 'utf8'),
      SENTINEL,
      `${script} overwrote ${output} without being asked`,
    );
    assert.match(r.all, /--apply/, 'the plan must name the flag that would perform the work');
    if (extraAssert) extraAssert({ dir, r });
  });

  test(`${script.replace('.mjs', '')}_applyWithoutReplaceOverExistingOutput_refuses`, (t) => {
    const dir = makeProject(t, { ...files, [output]: SENTINEL });
    const r = runScript(script, [...args, '--apply'], dir);

    assert.equal(r.code, EXIT.USAGE, `expected a refusal, got ${r.code}\n${r.all}`);
    assert.equal(fs.readFileSync(path.join(dir, output), 'utf8'), SENTINEL);
    assert.match(r.all, /--replace/, 'the refusal must name the flag that would allow the overwrite');
  });
}

// ---------------------------------------------------------------------------
// The six ranked "Low" in round one. Each destroys by default.
// ---------------------------------------------------------------------------
describe('write-storyboard destroy-by-default', () => {
  itPlansByDefault({
    script: 'write-storyboard.mjs',
    files: { 'timing.json': timingFixture() },
    output: 'storyboard.html',
  });
});

describe('write-build-html destroy-by-default', () => {
  itPlansByDefault({
    script: 'write-build-html.mjs',
    files: {
      'timing.json': timingFixture(),
      // Every on-screen asset must resolve beneath the approved evidence pack, and GSAP
      // is inlined from the project's own node_modules so the render runs offline (C-8).
      'evidence-pack/evidence-pack.json': JSON.stringify({ assets: [] }),
      'node_modules/gsap/dist/gsap.min.js': '/* stub gsap */',
    },
    output: 'video-auto.html',
  });
});

describe('concat-audio destroy-by-default', () => {
  itPlansByDefault({
    script: 'concat-audio.mjs',
    files: {
      'timing.json': timingFixture(),
      'silence.mp3': 'silence-bytes',
      'segment_000.mp3': 'seg-zero',
      'segment_001.mp3': 'seg-one',
    },
    output: 'voiceover.mp3',
  });
});

describe('vo-envelope destroy-by-default', () => {
  itPlansByDefault({
    script: 'vo-envelope.mjs',
    files: { 'voiceover.mp3': 'voice-bytes' },
    output: 'vo-envelope.json',
  });
});

describe('make-music destroy-by-default', () => {
  itPlansByDefault({
    script: 'make-music.mjs',
    args: ['--out', 'music.wav', '--seconds', '2'],
    files: {},
    output: 'music.wav',
  });

  test('makeMusic_outPathEscapingProjectRoot_refusesAndWritesNothing', (t) => {
    const dir = makeProject(t);
    const outside = makeOutsideDir(t);
    const r = runScript(
      'make-music.mjs',
      ['--out', path.join(outside, 'stolen.wav'), '--seconds', '2', '--apply', '--replace'],
      dir,
    );

    assert.equal(r.code, EXIT.USAGE, r.all);
    assert.equal(fs.existsSync(path.join(outside, 'stolen.wav')), false);
  });
});

describe('preview-seg destroy-by-default', () => {
  itPlansByDefault({
    script: 'preview-seg.mjs',
    args: ['--id', 'one'],
    files: {
      'timing.json': timingFixture(),
      'video-auto.html': '<html><body><div id="stage"></div></body></html>',
    },
    output: 'preview/one-50.png',
  });

  test('previewSeg_segmentIdWithPathTraversal_isRefused', (t) => {
    const dir = makeProject(t, {
      'timing.json': timingFixture(),
      'video-auto.html': '<html></html>',
    });
    const r = runScript('preview-seg.mjs', ['--id', '../../escape', '--apply'], dir);

    assert.equal(r.code, EXIT.USAGE, r.all);
  });
});

// ---------------------------------------------------------------------------
// preview.mjs — writes by default AND disagrees with capture about whether a
// layout issue is fatal.
// ---------------------------------------------------------------------------
describe('preview', () => {
  const files = {
    'timing.json': timingFixture(),
    'video-auto.html': '<html><body><div id="stage"></div></body></html>',
  };

  test('preview_noFlags_writesNoScreenshotsAndExitsZero', (t) => {
    const dir = makeProject(t, files);
    const r = runScript('preview.mjs', [], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.equal(fs.existsSync(path.join(dir, 'preview')), false, 'a bare run must not create preview output');
    assert.match(r.all, /--apply/);
  });

  test('preview_segmentIdWithPathTraversal_isRefused', (t) => {
    const hostile = [{ id: '../../escape', startMs: 0, endMs: 2000, voiceoverText: 'x' }];
    const dir = makeProject(t, { ...files, 'timing.json': timingFixture(hostile) });
    const r = runScript('preview.mjs', ['--apply'], dir);

    assert.equal(r.code, EXIT.USAGE, `a timing-derived id must not become an arbitrary path\n${r.all}`);
  });

  test('preview_layoutIssuesFound_exitsNonZeroLikeCaptureDoes', (t) => {
    // frame-capture treats a failing layout audit as fatal. preview printing the same
    // condition and exiting 0 means two stages disagree about whether it is a failure.
    const dir = makeProject(t, {
      ...files,
      'video-auto.html':
        '<html><body><div id="stage"></div>' +
        '<script>window.auditLayout=()=>[{el:"#title",issue:"overflows safe area"}];</script>' +
        '</body></html>',
    });
    const r = runScript('preview.mjs', ['--apply'], dir);

    assert.equal(r.code, EXIT.FAILED, `layout issues must fail the preview, got ${r.code}\n${r.all}`);
    assert.match(r.all, /layout/i);
  });
});

// ---------------------------------------------------------------------------
// append-outro — the worst of the set: --help itself mutated voiceover.mp3.
// ---------------------------------------------------------------------------
describe('append-outro', () => {
  const files = { 'silence.mp3': Buffer.alloc(288 * 200, 0).fill(Buffer.from([0xff, 0xf3, 0xa4, 0xc0]), 0, 4).toString('latin1') };

  function outroProject(t) {
    const dir = makeProject(t, { 'voiceover.mp3': SENTINEL });
    // A real frame-aligned silence asset so the parse succeeds and the only thing
    // stopping the append is the guard under test.
    const frames = 200;
    const buf = Buffer.alloc(288 * frames);
    for (let i = 0; i < frames; i++) {
      const o = i * 288;
      buf[o] = 0xff; buf[o + 1] = 0xf3; buf[o + 2] = 0xa4; buf[o + 3] = 0xc0;
    }
    fs.writeFileSync(path.join(dir, 'silence.mp3'), buf);
    return dir;
  }

  test('appendOutro_helpFlag_mutatesNothing', (t) => {
    const dir = outroProject(t);
    const r = runScript('append-outro.mjs', ['--help'], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.equal(
      fs.readFileSync(path.join(dir, 'voiceover.mp3'), 'utf8'),
      SENTINEL,
      '--help must never mutate anything, ever',
    );
  });

  test('appendOutro_noFlags_doesNotAppendAndExitsZero', (t) => {
    const dir = outroProject(t);
    const r = runScript('append-outro.mjs', ['--ms', '2500'], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.equal(fs.readFileSync(path.join(dir, 'voiceover.mp3'), 'utf8'), SENTINEL);
  });

  test('appendOutro_invalidDuration_exitsUsageErrorInsteadOfDefaulting', (t) => {
    const dir = outroProject(t);
    const r = runScript('append-outro.mjs', ['--ms', 'not-a-number', '--apply'], dir);

    assert.equal(r.code, EXIT.USAGE, `an invalid duration must be rejected, not replaced by 2500\n${r.all}`);
    assert.equal(fs.readFileSync(path.join(dir, 'voiceover.mp3'), 'utf8'), SENTINEL);
  });

  test('appendOutro_zeroDuration_isANoOpAndExitsZero', (t) => {
    // outroMs=0 means "no outro was requested"; doing nothing IS the job.
    const dir = outroProject(t);
    const r = runScript('append-outro.mjs', ['--ms', '0', '--apply'], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.equal(fs.readFileSync(path.join(dir, 'voiceover.mp3'), 'utf8'), SENTINEL);
  });

  test('appendOutro_applyWithValidDuration_appendsFrames', (t) => {
    const dir = outroProject(t);
    const r = runScript('append-outro.mjs', ['--ms', '480', '--apply'], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    const after = fs.readFileSync(path.join(dir, 'voiceover.mp3'));
    assert.ok(after.length > SENTINEL.length, 'an explicit --apply must actually append');
  });
});

// ---------------------------------------------------------------------------
// frame-capture — the plan undercounted what --apply destroys, and an unvalidated
// fps let a capture wipe the frames, capture nothing, and report success.
// ---------------------------------------------------------------------------
describe('frame-capture plan accuracy', () => {
  const baseFiles = {
    'video-auto.html': '<html><body><div id="stage"></div></body></html>',
  };

  test('frameCapture_planWithNonFrameEntries_countsEverythingApplyWouldDelete', (t) => {
    const dir = makeProject(t, {
      ...baseFiles,
      'timing.json': timingFixture(),
      'frames/frame_00000.png': 'a frame',
      'frames/notes.txt': 'hand-written notes',
      'frames/subdir/keep.bin': 'nested artifact',
    });
    const r = runScript('frame-capture.mjs', [], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    // --apply removes the directory recursively, so all four entries are in scope:
    // the frame, the notes, the nested file, and the subdirectory holding it.
    assert.match(r.all, /4 entr/i, `the plan must count every entry --apply destroys\n${r.all}`);
    assert.match(r.all, /notes\.txt/, 'and name the non-frame entries');
    assert.match(r.all, /subdir/, 'including directories');
  });

  test('frameCapture_planWhenFramesDirUnreadable_failsRatherThanReportingEmpty', (t) => {
    // A directory-read error is not "there is nothing here". Simulated by putting a
    // FILE where frames/ must be: reading it as a directory fails with ENOTDIR.
    const dir = makeProject(t, {
      ...baseFiles,
      'timing.json': timingFixture(),
      frames: 'not a directory',
    });
    const r = runScript('frame-capture.mjs', [], dir);

    assertCleanExit(r, EXIT.USAGE, 'an unreadable frames/ must not plan as empty: ');
  });

  test('frameCapture_invalidFps_preservesFramesAndExitsNonZero', (t) => {
    const dir = makeProject(t, {
      ...baseFiles,
      'timing.json': timingFixture(contiguousSegments, { project: { name: 'demo', fps: -5, width: 1280, height: 720 } }),
      'frames/frame_00000.png': SENTINEL,
    });
    const r = runScript('frame-capture.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.USAGE, 'an invalid fps must fail, not report a completed capture: ');
    assert.equal(
      fs.readFileSync(path.join(dir, 'frames', 'frame_00000.png'), 'utf8'),
      SENTINEL,
      'validation must happen before the wipe',
    );
  });

  test('frameCapture_nonNumericFps_preservesFramesAndExitsNonZero', (t) => {
    const dir = makeProject(t, {
      ...baseFiles,
      'timing.json': timingFixture(contiguousSegments, { project: { name: 'demo', fps: 'thirty', width: 1280, height: 720 } }),
      'frames/frame_00000.png': SENTINEL,
    });
    const r = runScript('frame-capture.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.USAGE, 'a non-numeric fps must fail, not report a completed capture: ');
    assert.equal(fs.readFileSync(path.join(dir, 'frames', 'frame_00000.png'), 'utf8'), SENTINEL);
  });
});

// ---------------------------------------------------------------------------
// encode-mp4 — the publish path renamed over an existing deliverable unguarded.
// ---------------------------------------------------------------------------
describe('encode-mp4 publish guard', () => {
  test('encodeMp4_noFlags_doesNotTouchExistingDeliverable', (t) => {
    const dir = makeProject(t, {
      'timing.json': timingFixture(),
      'frames/frame_00000.png': 'frame',
      'demo.mp4': SENTINEL,
    });
    const r = runScript('encode-mp4.mjs', [], dir);

    assert.equal(r.code, EXIT.OK, `a plan run must succeed, got ${r.code}\n${r.all}`);
    assert.equal(
      fs.readFileSync(path.join(dir, 'demo.mp4'), 'utf8'),
      SENTINEL,
      'a bare encode must not publish over an approved deliverable',
    );
    assert.match(r.all, /--apply/);
  });

  test('encodeMp4_applyWithoutReplaceOverExistingDeliverable_refuses', (t) => {
    const dir = makeProject(t, {
      'timing.json': timingFixture(),
      'frames/frame_00000.png': 'frame',
      'demo.mp4': SENTINEL,
    });
    const r = runScript('encode-mp4.mjs', ['--apply'], dir);

    assert.equal(r.code, EXIT.USAGE, r.all);
    assert.equal(fs.readFileSync(path.join(dir, 'demo.mp4'), 'utf8'), SENTINEL);
  });
});

// ---------------------------------------------------------------------------
// remix / voice — round one taught them to forward --apply --replace to silence-gen
// unconditionally, which moved the destroy-by-default defect up one level.
// ---------------------------------------------------------------------------
describe('parent stages have their own safe default', () => {
  const voiceFiles = {
    'timing.json': timingFixture(),
    'voiceover.mp3': SENTINEL,
    'segment_000.mp3': 'seg-zero',
    'segment_001.mp3': 'seg-one',
    'brand/tokens.json': brandTokens,
  };

  test('remix_noFlags_writesNothingAndExitsZero', (t) => {
    const dir = makeProject(t, voiceFiles);
    const r = runScript('remix.mjs', [], dir);

    assert.equal(r.code, EXIT.OK, `remix must plan by default, got ${r.code}\n${r.all}`);
    assert.equal(fs.readFileSync(path.join(dir, 'voiceover.mp3'), 'utf8'), SENTINEL);
    assert.match(r.all, /--apply/);
  });

  test('voice_noFlags_writesNothingAndExitsZero', (t) => {
    const dir = makeProject(t, voiceFiles);
    const r = runScript('voice.mjs', [], dir);

    assert.equal(r.code, EXIT.OK, `voice must plan by default, got ${r.code}\n${r.all}`);
    assert.equal(fs.readFileSync(path.join(dir, 'voiceover.mp3'), 'utf8'), SENTINEL);
    assert.match(r.all, /--apply/);
  });

  test('remix_planRun_doesNotInvokeSilenceGenAtAll', (t) => {
    // The call-site contract: a parent that was not asked to write must not hand a
    // child the flags that make it write.
    const dir = makeProject(t, voiceFiles);
    const r = runScript('remix.mjs', [], dir);

    assert.equal(fs.existsSync(path.join(dir, 'lead.mp3')), false, 'no silence asset may be generated by a plan run');
    assert.equal(fs.existsSync(path.join(dir, 'gap_01.mp3')), false);
    assert.equal(r.code, EXIT.OK, r.all);
  });
});

// ---------------------------------------------------------------------------
// The silence-gen call-site contract, in the direction that matters: when the parent
// IS asked to write, the child must actually write. Round one's fix would otherwise
// regress into a silent no-op.
// ---------------------------------------------------------------------------
describe('silence-gen call-site contract', () => {
  test('silenceGen_invokedTheWayParentsInvokeIt_actuallyWrites', (t) => {
    const dir = makeProject(t);
    const r = runScript(
      'silence-gen.mjs',
      ['--project', dir, '--out', 'gap_01.mp3', '--ms', '480', '--apply', '--replace'],
      dir,
    );

    assert.equal(r.code, EXIT.OK, r.all);
    assert.equal(fs.statSync(path.join(dir, 'gap_01.mp3')).size, 20 * 288);
  });

  test('silenceGen_invokedWithoutWriteFlags_producesNoFileSoParentsMustOptIn', (t) => {
    const dir = makeProject(t);
    const r = runScript('silence-gen.mjs', ['--project', dir, '--out', 'gap_01.mp3', '--ms', '480'], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.equal(fs.existsSync(path.join(dir, 'gap_01.mp3')), false);
  });
});

// ---------------------------------------------------------------------------
// remux-music — the hash-mismatch branch was named as tested and could not be reached,
// because every remux test pointed at a nonexistent ffmpeg.
// ---------------------------------------------------------------------------
describe('remux-music video stream verdict', () => {
  // The verdict's own input validation lives in guard-inputs.test.mjs, which owns the
  // "equal but unparsed is not a match" contract. This keeps the integration case.
  test('remuxMusic_ffmpegMissing_failsBeforeClaimingSuccess', (t) => {
    const dir = makeProject(t, {
      'ffmpeg-path.txt': MISSING_FFMPEG,
      'in.mp4': 'video',
      'voiceover.mp3': 'voice',
      'music.wav': 'music',
    });
    const r = runScript(
      'remux-music.mjs',
      ['--video', 'in.mp4', '--out', 'out.mp4', '--apply'],
      dir,
    );

    assert.equal(r.code, EXIT.FAILED, r.all);
    assert.equal(fs.existsSync(path.join(dir, 'out.mp4')), false);
  });
});
