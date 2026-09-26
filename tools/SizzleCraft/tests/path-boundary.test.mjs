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

import { createBoundary, resolveWithinRoot, resolveOutput, requireSafeFilename, CliError, EXIT } from '../src/cli-support.mjs';
import { makeProject, makeOutsideDir, runScript, tryMakeDirLink } from './_helpers.mjs';

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
});
