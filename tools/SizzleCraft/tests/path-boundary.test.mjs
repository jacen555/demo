// Path confinement.
//
// Round one resolved the root through the filesystem and then trusted a lexical prefix
// check on the candidate. That is not containment: a junction sitting INSIDE the root
// satisfies the string test while pointing anywhere on the volume, so
// `silence-gen --out link/out.mp3 --apply` wrote outside the project.
//
// libs/EvalEngine's PathBoundary exists because this repo has been here before. These
// tests pin the three rules it encodes: refuse on the text before any I/O, apply the
// boundary to every link target while it is still text, and fail closed when a segment
// cannot be inspected.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  createBoundary,
  resolveWithinRoot,
  resolveOutput,
  resolveEngineOutput,
  resolveInternalArtifact,
  openExclusiveEngineFile,
  requireSafeFilename,
  CliError,
  EXIT,
} from '../src/cli-support.mjs';
import { makeProject, makeOutsideDir, runScript, tryMakeDirLink, tryMakeFileLink, MISSING_FFMPEG } from './_helpers.mjs';

const SENTINEL = 'SENTINEL — MUST SURVIVE AN ENGINE-CHOSEN WRITE';

describe('path boundary', () => {
  test('resolve_nestedRelativePath_returnsAbsolutePathInsideRoot', (t) => {
    const root = makeProject(t);
    assert.equal(resolveWithinRoot(root, 'frames/out.png'), path.join(fs.realpathSync.native(root), 'frames', 'out.png'));
  });

  test('resolve_parentTraversal_refusedOnTextBeforeAnyIo', (t) => {
    const root = makeProject(t);
    assert.throws(
      () => resolveWithinRoot(root, '../evil.mp3'),
      (e) => e instanceof CliError && e.exitCode === EXIT.USAGE,
    );
  });

  test('resolve_siblingSharingRootPrefix_isRefused', (t) => {
    // `<root>-backup` starts with the root as a string but is not inside it.
    const root = makeProject(t);
    const sibling = `${path.basename(root)}-backup`;
    assert.throws(() => resolveWithinRoot(root, path.join('..', sibling, 'x.mp3')), CliError);
  });

  test('resolve_absolutePathOutsideRoot_isRefused', (t) => {
    const root = makeProject(t);
    const outside = makeOutsideDir(t);
    assert.throws(() => resolveWithinRoot(root, path.join(outside, 'x.mp3')), CliError);
  });

  test('resolve_rootItself_returnsRootMatchingPathBoundarySemantics', (t) => {
    // The boundary's job is containment, and the root is contained in itself. Refusing a
    // write TO the root belongs to resolveOutput, which is asserted below — keeping the
    // two concerns apart is what lets `resolveWithinRoot(root, 'frames')` work.
    const root = makeProject(t);
    assert.equal(resolveWithinRoot(root, '.'), fs.realpathSync.native(root));
  });

  test('resolveOutput_targetIsAnExistingDirectory_isRefused', (t) => {
    const root = makeProject(t, { 'frames/x.png': 'f' });
    assert.throws(
      () => resolveOutput(root, 'frames', { apply: true, replace: true, label: 'output' }),
      (e) => e instanceof CliError && /is a directory/.test(e.message),
    );
  });

  test('resolveOutput_planOverExistingFile_doesNotRefuse', (t) => {
    // A plan must be able to describe replacing an existing file; refusing during a plan
    // would make the safe default fail exactly when there is something to protect.
    const root = makeProject(t, { 'out.mp3': 'existing' });
    assert.doesNotThrow(() => resolveOutput(root, 'out.mp3', { apply: false, replace: false, label: 'output' }));
    assert.throws(() => resolveOutput(root, 'out.mp3', { apply: true, replace: false, label: 'output' }), CliError);
  });

  test('resolve_absentSegment_isKeptAsWrittenRatherThanRefused', (t) => {
    // A segment confirmed absent cannot be a link, so a not-yet-created output path
    // must resolve normally — otherwise nothing could ever be written.
    const root = makeProject(t);
    const resolved = resolveWithinRoot(root, 'does/not/exist/yet.mp3');
    assert.ok(resolved.startsWith(fs.realpathSync.native(root)));
  });

  test('resolve_linkInsideRootPointingOutside_isRefused', (t) => {
    const root = makeProject(t);
    const outside = makeOutsideDir(t, { 'victim.txt': 'ORIGINAL' });
    const link = path.join(root, 'escape');
    if (!tryMakeDirLink(link, outside)) return t.skip('platform refused to create a directory link');

    assert.throws(
      () => resolveWithinRoot(root, 'escape/victim.txt'),
      (e) => e instanceof CliError && /outside the project root/i.test(e.message),
      'a junction inside the root that points out must not pass the lexical check',
    );
  });

  test('resolve_linkInsideRootPointingInside_isAllowed', (t) => {
    const root = makeProject(t, { 'real/keep.txt': 'ok' });
    const link = path.join(root, 'alias');
    if (!tryMakeDirLink(link, path.join(root, 'real'))) return t.skip('platform refused to create a directory link');

    const resolved = resolveWithinRoot(root, 'alias/keep.txt');
    assert.ok(resolved.startsWith(fs.realpathSync.native(root)));
  });

  test('resolve_danglingFinalLinkPointingOutside_isRefused', (t) => {
    const root = makeProject(t);
    const outside = makeOutsideDir(t);
    const missingTarget = path.join(outside, 'not-created-yet');
    const link = path.join(root, 'dangling');
    if (!tryMakeDirLink(link, missingTarget)) return t.skip('platform refused to create a directory link');

    // The target does not exist, so inspecting it proves nothing. The target is judged
    // as text, which is enough to refuse it.
    assert.throws(() => resolveWithinRoot(root, 'dangling/out.mp3'), CliError);
  });

  test('createBoundary_exposesCanonicalRoot', (t) => {
    const root = makeProject(t);
    assert.equal(createBoundary(root).root, fs.realpathSync.native(root));
  });
});

describe('filename validation', () => {
  test('requireSafeFilename_plainName_isAccepted', () => {
    assert.equal(requireSafeFilename('segment_001.mp3', 'name'), 'segment_001.mp3');
  });

  test('requireSafeFilename_pathSeparatorOrTraversal_throws', () => {
    for (const hostile of ['../escape', 'a/b', 'a\\b', '..', '.', '', 'x\u0000y']) {
      assert.throws(() => requireSafeFilename(hostile, 'segment id'), CliError, `"${hostile}" must be refused`);
    }
  });
});

// ---------------------------------------------------------------------------
// Engine-chosen destinations.
//
// resolveOutput deliberately FOLLOWS an in-root link: the caller named that path, so
// following their own link inside their own project is what they asked for. None of the
// destinations below were named by the caller — the engine picked them — so a link at
// one of them redirects a write nobody requested. Same containment, different question,
// different answer.
// ---------------------------------------------------------------------------
describe('engine-chosen writes refuse links rather than following them', () => {
  test('resolveEngineOutput_inRootLink_isRefusedWhereResolveOutputFollowsIt', (t) => {
    // Pins the distinction itself, and the divergence that made the publish guard only
    // accidentally correct: resolveOutput returns the link's TARGET, while the rename it
    // guards replaces the link ENTRY. Guard and action were describing different files.
    const root = makeProject(t, { 'real.mp4': 'original' });
    const linkEntry = path.join(root, 'demo.mp4');
    if (!tryMakeFileLink(linkEntry, path.join(root, 'real.mp4'))) return t.skip('platform refused to create a file link');

    const followed = resolveOutput(root, 'demo.mp4', { apply: true, replace: true, label: 'output' });
    assert.equal(
      followed,
      path.join(fs.realpathSync.native(root), 'real.mp4'),
      'resolveOutput resolves the canonical target, not the entry a rename would replace',
    );

    assert.throws(
      () => resolveEngineOutput(root, 'demo.mp4', { apply: true, replace: true, label: 'output MP4' }),
      (e) => e instanceof CliError && /link/i.test(e.message),
      'an engine-chosen output must refuse the link outright, so guard and action cannot diverge',
    );
  });

  test('resolveEngineOutput_returnsTheEntryTheActionWillReplace', (t) => {
    // The positive half: what the guard hands back is exactly the lexical entry the
    // rename operates on, so "guarded" and "written" are the same path by construction.
    const root = makeProject(t);
    assert.equal(
      resolveEngineOutput(root, 'demo.mp4', { apply: true, replace: true, label: 'output MP4' }),
      path.join(fs.realpathSync.native(root), 'demo.mp4'),
    );
  });

  test('resolveEngineOutput_encoderPageIsLinkToOutsideVictim_refusesWithoutClobberingIt', (t) => {
    // copyFileSync FOLLOWS a destination link and overwrites what it points at, so the
    // refusal has to happen before the copy — there is no post-hoc recovery.
    const root = makeProject(t, { 'encoder/placeholder.txt': 'x' });
    const outside = makeOutsideDir(t, { 'victim.html': SENTINEL });
    const victim = path.join(outside, 'victim.html');
    if (!tryMakeFileLink(path.join(root, 'encoder', 'encoder-page.html'), victim)) {
      return t.skip('platform refused to create a file link');
    }

    assert.throws(
      () => resolveEngineOutput(root, path.join('encoder', 'encoder-page.html'), { apply: true, replace: true, label: 'encoder page' }),
      (e) => e instanceof CliError && /link/i.test(e.message),
    );
    assert.equal(fs.readFileSync(victim, 'utf8'), SENTINEL, 'the victim must not be clobbered through the link');
  });

  test('resolveEngineOutput_muxerDestinationIsLinkToOutsideVictim_refusesWithoutClobberingIt', (t) => {
    const root = makeProject(t, { 'encoder/placeholder.txt': 'x' });
    const outside = makeOutsideDir(t, { 'victim.js': SENTINEL });
    const victim = path.join(outside, 'victim.js');
    if (!tryMakeFileLink(path.join(root, 'encoder', 'mp4-muxer.js'), victim)) {
      return t.skip('platform refused to create a file link');
    }

    assert.throws(
      () => resolveEngineOutput(root, path.join('encoder', 'mp4-muxer.js'), { apply: true, replace: true, label: 'encoder muxer' }),
      (e) => e instanceof CliError && /link/i.test(e.message),
    );
    assert.equal(fs.readFileSync(victim, 'utf8'), SENTINEL);
  });

  test('resolveInternalArtifact_encoderDirIsJunctionOutsideRoot_isRefused', (t) => {
    const root = makeProject(t);
    const outside = makeOutsideDir(t, { 'victim.txt': SENTINEL });
    if (!tryMakeDirLink(path.join(root, 'encoder'), outside)) return t.skip('platform refused to create a directory link');

    assert.throws(() => resolveInternalArtifact(root, 'encoder', 'encoder directory'), CliError);
    assert.equal(fs.readFileSync(path.join(outside, 'victim.txt'), 'utf8'), SENTINEL);
  });

  test('resolveEngineOutput_destinationUnderAnEscapingJunction_isRefused', (t) => {
    // The directory guard and the file guard are not redundant: with the directory guard
    // removed, every file installed into it still has to be refused on its own.
    const root = makeProject(t);
    const outside = makeOutsideDir(t, { 'victim.html': SENTINEL });
    if (!tryMakeDirLink(path.join(root, 'encoder'), outside)) return t.skip('platform refused to create a directory link');

    assert.throws(
      () => resolveEngineOutput(root, path.join('encoder', 'victim.html'), { apply: true, replace: true, label: 'encoder page' }),
      (e) => e instanceof CliError && /outside the project root/i.test(e.message),
    );
    assert.equal(fs.readFileSync(path.join(outside, 'victim.html'), 'utf8'), SENTINEL);
  });
});

// ---------------------------------------------------------------------------
// The encode temp file.
//
// Resolving the path and THEN opening it with 'w+' leaves the decision and the action
// in two places: 'w+' follows a link and truncates whatever it points at, so anything
// planted between the check and the open wins. 'wx+' makes the refusal the open itself.
// ---------------------------------------------------------------------------
describe('engine temp files are created exclusively', () => {
  test('openExclusiveEngineFile_destinationAbsent_createsAndReturnsTheEntryItOpened', (t) => {
    const root = makeProject(t);
    const { fd, path: opened } = openExclusiveEngineFile(root, 'demo.mp4.part-1', 'encode temp file');
    fs.closeSync(fd);

    assert.equal(opened, path.join(fs.realpathSync.native(root), 'demo.mp4.part-1'));
    assert.equal(fs.existsSync(opened), true, 'the temp file must actually be created');
  });

  test('openExclusiveEngineFile_destinationIsLinkToOutsideVictim_refusesWithoutTruncatingIt', (t) => {
    const root = makeProject(t);
    const outside = makeOutsideDir(t, { 'victim.bin': SENTINEL });
    const victim = path.join(outside, 'victim.bin');
    if (!tryMakeFileLink(path.join(root, 'demo.mp4.part-1'), victim)) return t.skip('platform refused to create a file link');

    assert.throws(() => openExclusiveEngineFile(root, 'demo.mp4.part-1', 'encode temp file'), CliError);
    assert.equal(fs.readFileSync(victim, 'utf8'), SENTINEL, "'w+' would have truncated this to zero bytes");
  });

  test('openExclusiveEngineFile_destinationAlreadyExists_refusesRatherThanTruncating', (t) => {
    const root = makeProject(t, { 'demo.mp4.part-1': SENTINEL });

    assert.throws(
      () => openExclusiveEngineFile(root, 'demo.mp4.part-1', 'encode temp file'),
      (e) => e instanceof CliError && /already exists/i.test(e.message),
    );
    assert.equal(fs.readFileSync(path.join(root, 'demo.mp4.part-1'), 'utf8'), SENTINEL);
  });

  test('openExclusiveEngineFile_pathEscapingRoot_isRefused', (t) => {
    const root = makeProject(t);
    assert.throws(() => openExclusiveEngineFile(root, '../escape.part', 'encode temp file'), CliError);
  });

  test('cleanup_successfulRemoval_reportsNoFailure', (t) => {
    const root = makeProject(t);
    const handle = openExclusiveEngineFile(root, 'demo.mp4.part-1', 'encode temp file');

    assert.equal(handle.cleanup(), null, 'a removal that worked has nothing to report');
    assert.equal(fs.existsSync(handle.path), false);
  });

  test('cleanup_calledTwice_isIdempotentAndStillReportsNothing', (t) => {
    const root = makeProject(t);
    const handle = openExclusiveEngineFile(root, 'demo.mp4.part-1', 'encode temp file');

    assert.equal(handle.cleanup(), null);
    assert.equal(handle.cleanup(), null, 'the second call must not invent a failure');
  });

  test('cleanup_removalFails_reportsTheLeftoverInsteadOfSwallowingIt', (t) => {
    // The guarantee "no partial is left behind" was reported as honoured whether or not the
    // removal succeeded, so a failed encode could leave an unreported .part-* artifact.
    // A non-empty directory at the path makes rmSync fail deterministically.
    const root = makeProject(t);
    const handle = openExclusiveEngineFile(root, 'demo.mp4.part-1', 'encode temp file');
    fs.closeSync(handle.fd);
    fs.rmSync(handle.path);
    fs.mkdirSync(handle.path);
    fs.writeFileSync(path.join(handle.path, 'blocker'), 'x');

    const failure = handle.cleanup();

    assert.notEqual(failure, null, 'a removal that failed must be reported, not swallowed');
    assert.equal(failure.path, handle.path, 'and must name the artifact left behind');
    assert.match(failure.message, /demo\.mp4\.part-1/, 'the message must be printable as-is');
    assert.match(failure.message, /by hand|manually|remove/i, 'and must say what the operator has to do');
  });
});

describe('path confinement reaches the CLI', () => {
  test('silenceGen_outThroughLinkEscapingRoot_writesNothingOutside', (t) => {

    const root = makeProject(t);
    const outside = makeOutsideDir(t);
    const link = path.join(root, 'escape');
    if (!tryMakeDirLink(link, outside)) return t.skip('platform refused to create a directory link');

    const r = runScript('silence-gen.mjs', ['--out', 'escape/out.mp3', '--ms', '480', '--apply', '--replace'], root);

    assert.equal(r.code, EXIT.USAGE, `expected a refusal, got ${r.code}\n${r.all}`);
    assert.equal(fs.existsSync(path.join(outside, 'out.mp3')), false, 'must never write outside the project root');
  });

  // remux-music's gain lock is ENGINE-CHOSEN: the caller names --music and --out, never
  // `music-gain.lock.json`. The engine picks that name on its own initiative, so an
  // in-root link at it redirects a write the caller never asked for — which is exactly
  // the distinction resolveInternalArtifact draws and resolveOutput deliberately does not.
  const remuxProject = (t, files = {}) =>
    makeProject(t, {
      'ffmpeg-path.txt': MISSING_FFMPEG,
      'in.mp4': 'video bytes',
      'voiceover.mp3': 'voice bytes',
      'music.wav': 'music bytes',
      ...files,
    });

  const runRemux = (dir, extra = []) =>
    runScript(
      'remux-music.mjs',
      ['--video', 'in.mp4', '--voice', 'voiceover.mp3', '--music', 'music.wav', '--out', 'out.mp4', ...extra],
      dir,
    );

  test('remuxMusic_gainLockIsLinkToOutsideVictim_refusesWithoutClobberingIt', (t) => {
    const root = remuxProject(t);
    const outside = makeOutsideDir(t, { 'victim.json': 'ORIGINAL VICTIM' });
    const link = path.join(root, 'music-gain.lock.json');
    if (!tryMakeFileLink(link, path.join(outside, 'victim.json'))) {
      return t.skip('platform refused to create a file link');
    }

    const r = runRemux(root, ['--apply', '--confirm-gain']);

    assert.equal(r.code, EXIT.USAGE, `expected a refusal, got ${r.code}\n${r.all}`);
    assert.match(r.all, /link/i, 'the refusal must say the pin path is a link');
    assert.equal(
      fs.readFileSync(path.join(outside, 'victim.json'), 'utf8'),
      'ORIGINAL VICTIM',
      'a link at an engine-chosen path must never be written through',
    );
  });

  // timing.json is read on the engine's own initiative too. An unconfined read through a
  // link put the first bytes of whatever it pointed at into the JSON parser's error,
  // which the PLAN then printed while exiting 0 — a read primitive with a report channel.
  test('remuxMusic_timingIsLinkToOutsideSecret_refusesWithoutDisclosingItsContents', (t) => {
    const root = remuxProject(t);
    const outside = makeOutsideDir(t, { 'secret.txt': 'SQUIRRELTOKEN-do-not-disclose' });
    const link = path.join(root, 'timing.json');
    if (!tryMakeFileLink(link, path.join(outside, 'secret.txt'))) {
      return t.skip('platform refused to create a file link');
    }

    const r = runRemux(root);

    assert.doesNotMatch(r.all, /SQUIRRELTOKEN/, 'the contents of a refused read must never reach the output');
    assert.equal(r.code, EXIT.USAGE, `a planted link must be refused, not planned around, got ${r.code}\n${r.all}`);
    assert.match(r.all, /link/i, 'and the refusal must say why');
  });
});
