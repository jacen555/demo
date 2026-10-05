// FAIL RENAME: a test-only preload that makes the first `fs.renameSync` of a matching path
// fail, and changes nothing else — the control for substitute-on-rename.mjs.
//
// Where substitute-on-rename also withholds the identity of the name being renamed from,
// this leaves it intact, so the caller's cleanup CAN confirm the temp is still its own.
// The pair separates "a failed publish leaves a stranger's file alone" from "a failed
// publish strands its own temp".
//
//   nodeArgs: ['--import', failRename({ dir, fragment: 'music.wav.part-' })]
//
// It never writes, moves or removes anything. Bounded as the other fixtures are: the
// directory must be a suite-owned temp directory (see test-owned-path.mjs). It announces
// itself and the failure on stderr, so a test can prove the failure was staged.
//
// It is a TEST fixture. Nothing in src/ may import it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEST_DIR_PREFIX } from './test-owned-path.mjs';

const params = new URL(import.meta.url).searchParams;
const fragment = params.get('fragment');
if (!params.get('dir') || !fragment) {
  throw new Error('fail-rename: its --import URL must carry dir and fragment');
}
const dir = fs.realpathSync.native(params.get('dir'));
const tmp = fs.realpathSync.native(os.tmpdir());
if (path.dirname(dir) !== tmp || !path.basename(dir).startsWith(TEST_DIR_PREFIX)) {
  throw new Error(`fail-rename: ${dir} is not a ${TEST_DIR_PREFIX}* directory directly under ${tmp}`);
}

let failed = false;
const renameSync = fs.renameSync;
fs.renameSync = (from, ...rest) => {
  const targeted =
    typeof from === 'string' && from.includes(fragment) && path.dirname(path.resolve(from)) === dir;
  if (failed || !targeted) return renameSync(from, ...rest);
  failed = true;
  process.stderr.write(`fail-rename: failed the rename of ${path.resolve(from)}\n`);
  const err = new Error(`EPERM: operation not permitted, rename '${from}'`);
  err.code = 'EPERM';
  throw err;
};

process.stderr.write(`fail-rename: armed — the first rename of ${fragment}* inside ${dir} fails\n`);
