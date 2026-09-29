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
  wordedSegments,
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
  //
  // PROBEABLE music and --video-seconds are both load-bearing. With undecodable bytes,
  // probeDurationSeconds throws first and resolveFfmpeg is never reached — so exit 1, a
  // non-empty message and the absence of "VIDEO STREAM IDENTICAL" were all satisfied by
  // an unrelated failure, and this test passed without ever exercising ffmpeg at all.
  // The diagnostic assertion below is what makes it non-vacuous: it can only be produced
  // by the path this test is named for.
  function frameAlignedMp3(frames = 200) {
    const buf = Buffer.alloc(288 * frames);
    for (let i = 0; i < frames; i++) {
      const o = i * 288;
      buf[o] = 0xff; buf[o + 1] = 0xf3; buf[o + 2] = 0xa4; buf[o + 3] = 0xc0;
    }
    return buf;
  }

  test('remuxMusic_ffmpegMissing_failsNamingTheBinaryItCouldNotRun', (t) => {
    const dir = makeProject(t, {
      'ffmpeg-path.txt': MISSING_FFMPEG,
      'in.mp4': 'video',
      'voiceover.mp3': 'voice',
    });
    fs.writeFileSync(path.join(dir, 'music.mp3'), frameAlignedMp3());

    const r = runScript(
      'remux-music.mjs',
      ['--video', 'in.mp4', '--music', 'music.mp3', '--out', 'out.mp4',
        '--video-seconds', '30', '--apply', '--confirm-gain'],
      dir,
    );

    assert.equal(r.code, EXIT.FAILED, r.all);
    assert.match(r.all, /no-such-ffmpeg/, 'the diagnostic must name the executable it could not run');
    assert.doesNotMatch(r.all, /VIDEO STREAM IDENTICAL/, 'and must never claim the guarantee it could not check');
    assert.equal(fs.existsSync(path.join(dir, 'out.mp4')), false);
    assert.equal(
      fs.existsSync(path.join(dir, 'music-gain.lock.json')), false,
      'a failed remux must not leave a pin behind claiming the gain was used',
    );
  });
});

// ---------------------------------------------------------------------------
// write-chapters (S11) and write-subtitles (S10) — the last two stages still parsing argv
// by hand. write-chapters had no plan at all: a bare run wrote chapters.ffmeta (before
// checking its input existed) and handed ffmpeg `-y` over the MP4. write-subtitles planned
// by default, but ignored --help and typos, let `--hold abc` through as NaN timestamps,
// and wrote its sidecars before refusing the embed output.
// ---------------------------------------------------------------------------

/** The ffmpeg command line a plan says it would run, or '' when the plan shows none. */
const plannedCommand = (r) => r.stdout.match(/would run:\s*\r?\n\s*(.+)/)?.[1] ?? '';
const hasToken = (cmd, token) => new RegExp(`(?:^|\\s)${token}(?:\\s|$)`).test(cmd);

describe('write-chapters destroy-by-default', () => {
  const chaptersFiles = {
    'timing.json': timingFixture(),
    'demo-with-music.mp4': 'video bytes',
    'ffmpeg-path.txt': MISSING_FFMPEG,
  };
  const CHAPTERED = 'demo-with-music-chaptered.mp4';
  const META = 'chapters.ffmeta';

  // The metadata file is the first thing a bare run destroyed.
  itPlansByDefault({ script: 'write-chapters.mjs', files: chaptersFiles, output: META });

  test('writeChapters_noFlags_preservesExistingChapteredMp4AndWritesNoMetadata', (t) => {
    const dir = makeProject(t, { ...chaptersFiles, [CHAPTERED]: SENTINEL });
    const r = runScript('write-chapters.mjs', [], dir);

    assertCleanExit(r, EXIT.OK, 'a bare run must plan: ');
    assert.equal(fs.readFileSync(path.join(dir, CHAPTERED), 'utf8'), SENTINEL);
    assert.equal(fs.existsSync(path.join(dir, META)), false, 'a plan must not write the chapter metadata either');
    assert.match(r.all, /--apply/, 'the plan must name the flag that would perform the work');
  });

  test('writeChapters_applyWithoutReplaceOverExistingChapteredMp4_refusesBeforeWritingAnything', (t) => {
    const dir = makeProject(t, { ...chaptersFiles, [CHAPTERED]: SENTINEL });
    const r = runScript('write-chapters.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.USAGE, 'an existing output must be refused: ');
    assert.match(r.all, /--replace/, 'the refusal must name the flag that would allow the overwrite');
    assert.equal(fs.readFileSync(path.join(dir, CHAPTERED), 'utf8'), SENTINEL);
    assert.equal(fs.existsSync(path.join(dir, META)), false, 'the refusal must come before the metadata is written');
  });

  test('writeChapters_helpWithApplyAndReplace_printsUsageAndWritesNothing', (t) => {
    const dir = makeProject(t, { ...chaptersFiles, [META]: SENTINEL });
    const r = runScript('write-chapters.mjs', ['--help', '--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.OK, '--help must succeed: ');
    assert.match(r.stdout, /write-chapters/, 'the usage must be printed');
    assert.equal(fs.readFileSync(path.join(dir, META), 'utf8'), SENTINEL, '--help must never write, whatever else is passed');
  });

  test('writeChapters_unknownOption_exitsUsageAndWritesNothing', (t) => {
    const dir = makeProject(t, chaptersFiles);
    // A typo of --output. The hand-rolled parser ignored it and wrote the default name.
    const r = runScript('write-chapters.mjs', ['--ouptut', 'mine.mp4', '--apply'], dir);

    assertCleanExit(r, EXIT.USAGE, 'an unknown option must be refused, not ignored: ');
    assert.equal(fs.existsSync(path.join(dir, META)), false);
  });

  test('writeChapters_list_printsChaptersWithoutVideoOrFfmpegAndLeavesMetadataUntouched', (t) => {
    // REGRESSION GUARD (passed before this change too): --list is the path that works on
    // every player, so the rewrite must keep it free of every prerequisite the embed needs.
    const dir = makeProject(t, { 'timing.json': timingFixture(), [META]: SENTINEL });
    const r = runScript('write-chapters.mjs', ['--list'], dir);

    assertCleanExit(r, EXIT.OK, '--list must succeed with no video and no ffmpeg: ');
    assert.match(r.stdout, /^0:00\s+one$/m);
    assert.match(r.stdout, /^0:02\s+two$/m);
    assert.equal(fs.readFileSync(path.join(dir, META), 'utf8'), SENTINEL, '--list writes nothing');
  });

  test('writeChapters_listWithApply_isRefusedRatherThanIgnoringEitherFlag', (t) => {
    const dir = makeProject(t, chaptersFiles);
    const r = runScript('write-chapters.mjs', ['--list', '--apply'], dir);

    assertCleanExit(r, EXIT.USAGE, '--list and --apply ask for contradictory things: ');
    assert.match(r.all, /--list/);
    assert.equal(fs.existsSync(path.join(dir, META)), false);
  });

  test('writeChapters_plan_decidesTheOverwriteBeforeFfmpegRuns', (t) => {
    const dir = makeProject(t, chaptersFiles);

    const plan = runScript('write-chapters.mjs', [], dir);
    assertCleanExit(plan, EXIT.OK);
    const cmd = plannedCommand(plan);
    assert.ok(cmd, `the plan must show the ffmpeg command it would run\n${plan.all}`);
    assert.ok(hasToken(cmd, '-n'), `without --replace, ffmpeg must be told never to overwrite\n${cmd}`);
    assert.ok(!hasToken(cmd, '-y'), `-y hands the overwrite decision to ffmpeg\n${cmd}`);

    const replacing = runScript('write-chapters.mjs', ['--replace'], dir);
    assertCleanExit(replacing, EXIT.OK);
    assert.ok(hasToken(plannedCommand(replacing), '-y'), `--replace is what permits -y\n${replacing.all}`);
  });

  test('writeChapters_applyReplace_reachesFfmpegAndReportsItsFailureCleanly', (t) => {
    // POSITIVE CONTROL for every refusal above: with both opt-ins the guards let the run
    // through to ffmpeg, which is missing here. So: exit 1, the binary named, no stack.
    const dir = makeProject(t, { ...chaptersFiles, [META]: SENTINEL, [CHAPTERED]: SENTINEL });
    const r = runScript('write-chapters.mjs', ['--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.FAILED, 'a failed ffmpeg must be reported, not thrown: ');
    assert.match(r.all, /no-such-ffmpeg/, 'the diagnostic must name the executable it could not run');
    assert.doesNotMatch(r.all, /^wrote /m, 'and must not claim the output was written');
    assert.match(fs.readFileSync(path.join(dir, META), 'utf8'), /^;FFMETADATA1/, '--replace permits rewriting the metadata');
    assert.equal(fs.readFileSync(path.join(dir, CHAPTERED), 'utf8'), SENTINEL);
  });

  test('writeChapters_inputMissing_refusesBeforeWritingAnything', (t) => {
    const dir = makeProject(t, { 'timing.json': timingFixture(), 'ffmpeg-path.txt': MISSING_FFMPEG });
    const r = runScript('write-chapters.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.USAGE, 'a missing input is a usage error: ');
    assert.match(r.all, /demo-with-music\.mp4/, 'the diagnostic must name the file it looked for');
    assert.equal(fs.existsSync(path.join(dir, META)), false, 'the metadata used to be written before the input was checked');
  });

  test('writeChapters_ffmpegPointerMissing_planRefusesNamingIt', (t) => {
    const dir = makeProject(t, { 'timing.json': timingFixture(), 'demo-with-music.mp4': 'video bytes' });
    const r = runScript('write-chapters.mjs', [], dir);

    assertCleanExit(r, EXIT.USAGE, 'a plan must check its prerequisites, not crash on them: ');
    assert.match(r.all, /ffmpeg-path\.txt/);
    assert.equal(fs.existsSync(path.join(dir, META)), false);
  });

  // An input that exists is not necessarily a video. `--input .` resolves to the project
  // root, which exists, so the metadata was written and only ffmpeg then refused it.
  for (const [scenario, args, makeInputADirectory] of [
    ['inputIsProjectDirectory', ['--input', '.'], () => {}],
    ['defaultInputIsDirectory', [], (dir) => {
      fs.rmSync(path.join(dir, 'demo-with-music.mp4'));
      fs.mkdirSync(path.join(dir, 'demo-with-music.mp4'));
    }],
  ]) {
    test(`writeChapters_${scenario}_refusesBeforeWritingMetadata`, (t) => {
      const dir = makeProject(t, { ...chaptersFiles, [META]: SENTINEL });
      makeInputADirectory(dir);

      const r = runScript('write-chapters.mjs', [...args, '--apply', '--replace'], dir);

      assertCleanExit(r, EXIT.USAGE, 'a directory is not a video: ');
      assert.match(r.all, /input video .+ is a directory/);
      assert.doesNotMatch(r.all, /ffmpeg failed/, 'the refusal must come before ffmpeg is reached');
      assert.equal(fs.readFileSync(path.join(dir, META), 'utf8'), SENTINEL, 'the refusal must come before the metadata is written');
    });
  }

  // A timeline chapters cannot be cut from still reached chapters.ffmeta: with no durationMs
  // the last chapter was written as END=undefined, and an unordered timeline as a chapter
  // that ends where it starts — before ffmpeg ran, so its failure was the only report and the
  // metadata had already been replaced. The windows are validated before anything is planned.
  const withSegments = (edit) => {
    const segments = structuredClone(contiguousSegments);
    edit(segments);
    return timingFixture(segments);
  };
  for (const [scenario, timing, reason] of [
    ['durationMsMissing', timingFixture(contiguousSegments, { durationMs: undefined }), /durationMs is missing/],
    ['durationMsNotFinite', timingFixture().replace('"durationMs":4000', '"durationMs":1e400'), /durationMs is Infinity/],
    ['durationMsBeforeLastChapterStarts', timingFixture(contiguousSegments, { durationMs: 1000 }), /durationMs is 1000/],
    ['durationMsBeforeLastSegmentEnds', timingFixture(contiguousSegments, { durationMs: 3000 }), /durationMs is 3000/],
    ['segmentsOutOfOrder', timingFixture([...contiguousSegments].reverse(), { durationMs: 4000 }), /in time order/],
    ['segmentsOverlap', withSegments((s) => { s[1].startMs = 1500; }), /in time order/],
    ['segmentWindowEmpty', withSegments((s) => { s[0].endMs = 0; }), /window is 0ms/],
    ['segmentWithoutTitle', withSegments((s) => { delete s[0].id; }), /no visual\.title, title or id/],
    // REGRESSION GUARD (passed before this change too).
    ['timingIsJsonNull', 'null', /timing/],
  ]) {
    test(`writeChapters_${scenario}_exitsFailedWithoutWritingMetadata`, (t) => {
      const dir = makeProject(t, { ...chaptersFiles, 'timing.json': timing, [META]: SENTINEL, [CHAPTERED]: SENTINEL });

      const r = runScript('write-chapters.mjs', ['--apply', '--replace'], dir);

      assertCleanExit(r, EXIT.FAILED, 'a timeline chapters cannot be cut from must be refused: ');
      assert.match(r.all, reason);
      assert.doesNotMatch(r.all, /ffmpeg failed/, 'the refusal must come before ffmpeg is reached');
      assert.equal(fs.readFileSync(path.join(dir, META), 'utf8'), SENTINEL, 'the metadata must be untouched');
      assert.equal(fs.readFileSync(path.join(dir, CHAPTERED), 'utf8'), SENTINEL);
    });
  }

  test('writeChapters_listWithUnorderedTimeline_refusesRatherThanPrintingIt', (t) => {
    // --list is validated too: a chapter list pasted into a description is published.
    const dir = makeProject(t, { 'timing.json': timingFixture([...contiguousSegments].reverse(), { durationMs: 4000 }) });

    const r = runScript('write-chapters.mjs', ['--list'], dir);

    assertCleanExit(r, EXIT.FAILED);
    assert.match(r.all, /in time order/);
    assert.doesNotMatch(r.stdout, /^0:0\d\s+(one|two)$/m, 'no chapter list may be printed');
  });
});

describe('write-subtitles destroy-by-default', () => {
  const subtitleFiles = { 'timing.json': timingFixture(wordedSegments) };
  const VTT = 'demo.vtt';
  const SRT = 'demo.srt';

  itPlansByDefault({ script: 'write-subtitles.mjs', files: subtitleFiles, output: VTT });

  test('writeSubtitles_applyWithOnlySrtPresent_refusesAndWritesNeitherSidecar', (t) => {
    const dir = makeProject(t, { ...subtitleFiles, [SRT]: SENTINEL });
    const r = runScript('write-subtitles.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.USAGE, 'an existing sidecar must be refused: ');
    assert.match(r.all, /--replace/);
    assert.equal(fs.readFileSync(path.join(dir, SRT), 'utf8'), SENTINEL);
    assert.equal(fs.existsSync(path.join(dir, VTT)), false, 'a refused pair must not be half-written');
  });

  test('writeSubtitles_applyReplace_overwritesBothSidecars', (t) => {
    const dir = makeProject(t, { ...subtitleFiles, [VTT]: SENTINEL, [SRT]: SENTINEL });
    const r = runScript('write-subtitles.mjs', ['--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.OK, '--apply --replace is the documented way to regenerate: ');
    assert.match(fs.readFileSync(path.join(dir, VTT), 'utf8'), /^WEBVTT\r?\n/);
    assert.match(fs.readFileSync(path.join(dir, SRT), 'utf8'), /^1\r?\n00:00:00,100 --> /);
  });

  test('writeSubtitles_refusal_namesOnlyOptionsThatExist', (t) => {
    const dir = makeProject(t, { ...subtitleFiles, [VTT]: SENTINEL, [SRT]: SENTINEL });
    const r = runScript('write-subtitles.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.USAGE);
    assert.match(r.all, /--replace/);
    // It used to suggest "choose another --name" — an option this script has never read.
    assert.doesNotMatch(r.all, /--name/);
  });

  test('writeSubtitles_helpWithApply_printsUsageAndWritesNothing', (t) => {
    const dir = makeProject(t, subtitleFiles);
    const r = runScript('write-subtitles.mjs', ['--help', '--apply'], dir);

    assertCleanExit(r, EXIT.OK, '--help must succeed: ');
    assert.match(r.stdout, /write-subtitles/, 'the usage must be printed');
    assert.equal(fs.existsSync(path.join(dir, VTT)), false, '--help must never write, whatever else is passed');
    assert.equal(fs.existsSync(path.join(dir, SRT)), false);
  });

  test('writeSubtitles_unknownOption_exitsUsageAndWritesNothing', (t) => {
    const dir = makeProject(t, subtitleFiles);
    // A typo of --max-line. The hand-rolled parser ignored it and wrote at the default.
    const r = runScript('write-subtitles.mjs', ['--max-lnie', '30', '--apply'], dir);

    assertCleanExit(r, EXIT.USAGE, 'an unknown option must be refused, not ignored: ');
    assert.equal(fs.existsSync(path.join(dir, VTT)), false);
  });

  // C-2. `Number('abc')` is NaN and every comparison with NaN is false, so the cue-end
  // arithmetic wrote "NaN:NaN:NaN.NaN" into both sidecars and exited 0. A missing value
  // quietly became the default instead.
  for (const [scenario, args] of [
    ['nonNumericHold', ['--hold', 'abc']],
    ['holdWithoutValue', ['--apply', '--hold']],
    ['negativeHold', ['--hold=-200']],
    ['holdAboveCeiling', ['--hold', '10001']],
  ]) {
    test(`writeSubtitles_${scenario}_exitsUsageAndWritesNothing`, (t) => {
      const dir = makeProject(t, subtitleFiles);
      const r = runScript('write-subtitles.mjs', args.includes('--apply') ? args : [...args, '--apply'], dir);

      assertCleanExit(r, EXIT.USAGE, 'an invalid --hold must be refused, not written: ');
      assert.match(r.all, /--hold/, 'the refusal must name the option');
      assert.equal(fs.existsSync(path.join(dir, VTT)), false);
      assert.equal(fs.existsSync(path.join(dir, SRT)), false);
    });
  }

  test('writeSubtitles_malformedNumericOption_explainsTheRuleInCaptionTermsNotFfmpegTerms', (t) => {
    // The shared parser explains its strict grammar as "Levels are interpolated into an
    // ffmpeg filter graph". That is true for remux-music's gains and false for every
    // caption knob here. A refusal that gives the wrong reason sends the author looking
    // for an ffmpeg problem they do not have.
    const dir = makeProject(t, subtitleFiles);
    for (const [option, value, range] of [['--hold', 'abc', '0 and 10000'], ['--max-line', '4x', '10 and 120']]) {
      const r = runScript('write-subtitles.mjs', [option, value], dir);

      assertCleanExit(r, EXIT.USAGE);
      assert.match(r.all, new RegExp(`${option} must be a plain number between ${range} — got "${value}"`));
      assert.doesNotMatch(r.all, /ffmpeg|filter graph|Levels/, `${option}: the refusal must not blame ffmpeg\n${r.all}`);
    }
  });

  test('writeSubtitles_validHold_isHonouredAndDefaultsTo1200', (t) => {
    // "Hello there." is spoken 100..1100 and the next cue starts at 2100. The default
    // 1200 ms hold carries it to 2060 (40 ms short of the next cue); --hold 0 ends it on
    // its last word. Pinned so validation cannot quietly replace a legal value.
    const dir = makeProject(t, subtitleFiles);

    const held = runScript('write-subtitles.mjs', ['--apply'], dir);
    assertCleanExit(held, EXIT.OK);
    assert.match(fs.readFileSync(path.join(dir, VTT), 'utf8'), /00:00:00\.100 --> 00:00:02\.060\r?\nHello there\./);

    const unheld = runScript('write-subtitles.mjs', ['--hold', '0', '--apply', '--replace'], dir);
    assertCleanExit(unheld, EXIT.OK);
    assert.match(fs.readFileSync(path.join(dir, VTT), 'utf8'), /00:00:00\.100 --> 00:00:01\.100\r?\nHello there\./);
  });

  // --embed muxes the SRT into a copy of <name>-with-music.mp4.
  const embedFiles = { ...subtitleFiles, 'demo-with-music.mp4': 'video bytes', 'ffmpeg-path.txt': MISSING_FFMPEG };
  const SUBTITLED = 'demo-with-music-subtitled.mp4';

  test('writeSubtitles_embedOverExistingOutputWithoutReplace_refusesBeforeWritingSidecars', (t) => {
    const dir = makeProject(t, { ...embedFiles, [SUBTITLED]: SENTINEL });
    const r = runScript('write-subtitles.mjs', ['--embed', '--apply'], dir);

    assertCleanExit(r, EXIT.USAGE, 'an existing embed output must be refused: ');
    assert.match(r.all, /--replace/);
    assert.equal(fs.readFileSync(path.join(dir, SUBTITLED), 'utf8'), SENTINEL);
    // The refusal used to come AFTER both sidecars were written, so a refused run still
    // changed the project.
    assert.equal(fs.existsSync(path.join(dir, VTT)), false, 'the refusal must come before any write');
    assert.equal(fs.existsSync(path.join(dir, SRT)), false);
  });

  test('writeSubtitles_embedSourceMissing_refusesBeforeWritingSidecars', (t) => {
    const dir = makeProject(t, { ...subtitleFiles, 'ffmpeg-path.txt': MISSING_FFMPEG });
    const r = runScript('write-subtitles.mjs', ['--embed', '--apply'], dir);

    assertCleanExit(r, EXIT.USAGE, 'a missing embed source is a usage error: ');
    assert.match(r.all, /demo-with-music\.mp4/, 'the diagnostic must name the file it looked for');
    assert.equal(fs.existsSync(path.join(dir, VTT)), false, 'the refusal must come before any write');
  });

  test('writeSubtitles_embedPlanWithoutFfmpegPointer_refusesCleanlyNamingIt', (t) => {
    const dir = makeProject(t, { ...subtitleFiles, 'demo-with-music.mp4': 'video bytes' });
    const r = runScript('write-subtitles.mjs', ['--embed'], dir);

    assertCleanExit(r, EXIT.USAGE, 'a plan must check its prerequisites, not crash on them: ');
    assert.match(r.all, /ffmpeg-path\.txt/);
  });

  test('writeSubtitles_embedPlan_decidesTheOverwriteBeforeFfmpegRuns', (t) => {
    const dir = makeProject(t, embedFiles);

    const plan = runScript('write-subtitles.mjs', ['--embed'], dir);
    assertCleanExit(plan, EXIT.OK);
    const cmd = plannedCommand(plan);
    assert.ok(cmd, `the plan must show the ffmpeg command it would run\n${plan.all}`);
    assert.ok(hasToken(cmd, '-n'), `without --replace, ffmpeg must be told never to overwrite\n${cmd}`);
    assert.ok(!hasToken(cmd, '-y'), cmd);
    assert.equal(fs.existsSync(path.join(dir, VTT)), false, 'an embed plan writes nothing either');

    const replacing = runScript('write-subtitles.mjs', ['--embed', '--replace'], dir);
    assertCleanExit(replacing, EXIT.OK);
    assert.ok(hasToken(plannedCommand(replacing), '-y'), `--replace is what permits -y\n${replacing.all}`);
  });

  test('writeSubtitles_embedApplyReplace_reachesFfmpegAndReportsItsFailureCleanly', (t) => {
    const dir = makeProject(t, embedFiles);
    const r = runScript('write-subtitles.mjs', ['--embed', '--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.FAILED, 'a failed ffmpeg must be reported, not thrown: ');
    assert.match(r.all, /no-such-ffmpeg/, 'the diagnostic must name the executable it could not run');
    assert.doesNotMatch(r.all, /^wrote demo-with-music-subtitled/m, 'and must not claim the embed happened');
    assert.equal(fs.existsSync(path.join(dir, SUBTITLED)), false);
  });

  test('writeSubtitles_embedSourceIsDirectory_refusesBeforeWritingSidecars', (t) => {
    // The same gap as write-chapters' --input: the source existed, so both sidecars were
    // replaced and only ffmpeg then refused a directory as a video.
    const dir = makeProject(t, { ...subtitleFiles, 'ffmpeg-path.txt': MISSING_FFMPEG, [VTT]: SENTINEL, [SRT]: SENTINEL });
    fs.mkdirSync(path.join(dir, 'demo-with-music.mp4'));

    const r = runScript('write-subtitles.mjs', ['--embed', '--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.USAGE, 'a directory is not a video: ');
    assert.match(r.all, /embed source .+ is a directory/);
    assert.doesNotMatch(r.all, /ffmpeg failed/, 'the refusal must come before ffmpeg is reached');
    assert.equal(fs.readFileSync(path.join(dir, VTT), 'utf8'), SENTINEL, 'the refusal must come before any write');
    assert.equal(fs.readFileSync(path.join(dir, SRT), 'utf8'), SENTINEL);
  });

  // A timeline that cannot be captioned was captioned anyway. With no durationMs the last
  // cue's hold ceiling was NaN, and "NaN:NaN:NaN.NaN" was written into both sidecars at exit
  // 0; an empty timeline wrote two empty sidecars as success; and a segment with no words, a
  // malformed silence declaration or a null timeline escaped as a stack trace. Every case is
  // refused before either sidecar is touched — even under --replace, which permits
  // overwriting a sidecar, not replacing a good one with garbage.
  const wordedWith = (edit) => {
    const segments = structuredClone(wordedSegments);
    edit(segments);
    return timingFixture(segments);
  };
  for (const [scenario, timing, reason] of [
    ['durationMsMissing', timingFixture(wordedSegments, { durationMs: undefined }), /durationMs is missing/],
    ['durationMsNotFinite', timingFixture(wordedSegments).replace('"durationMs":4000', '"durationMs":1e400'), /durationMs is Infinity/],
    ['durationMsBeforeLastSegmentEnds', timingFixture(wordedSegments, { durationMs: 3000 }), /durationMs is 3000/],
    ['segmentsEmpty', timingFixture(wordedSegments, { segments: [] }), /segments is empty/],
    ['segmentsMissing', timingFixture(wordedSegments, { segments: undefined }), /segments is missing/],
    ['segmentIsNotAnObject', timingFixture(wordedSegments, { segments: [1] }), /segments\[0\] is 1, not a segment/],
    ['segmentsOutOfOrder', timingFixture([...wordedSegments].reverse(), { durationMs: 4000 }), /in time order/],
    ['segmentWithoutStartMs', wordedWith((s) => { delete s[1].startMs; }), /startMs is missing/],
    ['segmentWindowEmpty', wordedWith((s) => { s[1].endMs = 2000; }), /window is 0ms/],
    ['wordWithoutEndMs', wordedWith((s) => { delete s[0].audio.words[1].endMs; }), /words\[1\]\.endMs is missing/],
    ['wordEndsBeforeItStarts', wordedWith((s) => { s[0].audio.words[1].endMs = 500; }), /words\[1\] ends before it starts/],
    ['wordStartsBeforeZero', wordedWith((s) => { s[0].audio.words[0].startMs = -100; }), /words\[0\]\.startMs is -100/],
    ['wordTextNotAString', wordedWith((s) => { s[0].audio.words[0].word = 42; }), /words\[0\]\.word is 42/],
    ['spokenSegmentWithoutWords', wordedWith((s) => { delete s[1].audio.words; }), /run voice\.mjs/],
    ['voiceoverTextMissing', wordedWith((s) => { delete s[0].voiceoverText; }), /voiceoverText/],
    ['silentSegmentWithoutCaption', wordedWith((s) => {
      s[1] = { id: 'two', startMs: 2000, endMs: 4000, voiceoverText: '', silence: {} };
    }), /caption/],
    ['timingIsJsonNull', 'null', /not a timeline object/],
  ]) {
    test(`writeSubtitles_${scenario}_exitsFailedWithoutWritingEitherSidecar`, (t) => {
      const dir = makeProject(t, { 'timing.json': timing, [VTT]: SENTINEL, [SRT]: SENTINEL });
      const before = fs.readdirSync(dir).sort();

      const r = runScript('write-subtitles.mjs', ['--apply', '--replace'], dir);

      assertCleanExit(r, EXIT.FAILED, 'a timeline that cannot be captioned must be refused: ');
      assert.match(r.all, reason);
      assert.doesNotMatch(r.all, /NaN/);
      assert.equal(fs.readFileSync(path.join(dir, VTT), 'utf8'), SENTINEL, 'the WebVTT sidecar must be untouched');
      assert.equal(fs.readFileSync(path.join(dir, SRT), 'utf8'), SENTINEL, 'the SRT sidecar must be untouched');
      assert.deepEqual(fs.readdirSync(dir).sort(), before, 'nothing may be created either');
    });
  }
});

// S-m3(a). The usage is the one place a user checks before running a script, and it said a
// bare invocation writes both sidecars — while --help was not an option at all. Pinned for
// both S10 and S11, which share the plan-by-default contract.
describe('write-subtitles and write-chapters usage', () => {
  for (const [method, script, applyWrites, replaceLine] of [
    ['writeSubtitles', 'write-subtitles.mjs', 'write <project>.vtt and <project>.srt', 'overwrite existing sidecars'],
    ['writeChapters', 'write-chapters.mjs', 'write chapters.ffmeta and the chaptered MP4', 'overwrite either one if it already exists'],
  ]) {
    const line = (flags, text) =>
      new RegExp(`^\\s*node ${script.replace('.', '\\.')}${flags}\\s+${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');

    test(`${method}_help_describesABareRunAsPlanOnlyAndApplyAsTheWrite`, (t) => {
      const dir = makeProject(t);
      const r = runScript(script, ['--help'], dir);

      assertCleanExit(r, EXIT.OK, '--help must succeed: ');
      assert.match(r.stdout, line('', 'plan only (default)'), `a bare run must be documented as a plan\n${r.stdout}`);
      assert.match(r.stdout, line(' --apply', applyWrites), `--apply must be documented as the write\n${r.stdout}`);
      assert.match(r.stdout, line(' --apply --replace', replaceLine), r.stdout);
      assert.match(r.stdout, /--apply\s+actually write\. Without it nothing is written\./, r.stdout);
      assert.match(r.stdout.replace(/\s+/g, ' '), /Exit codes: 0 success\/plan\S* · 1 unusable timeline or ffmpeg failed · 2 bad usage/, r.stdout);
      assert.deepEqual(fs.readdirSync(dir), [], '--help writes nothing');
    });
  }
});
