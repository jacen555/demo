// SUBSTITUTE ON RENAME: a test-only preload that makes one `fs.renameSync` fail AND makes
// the name it was renaming from stop identifying the file the caller holds open — as a
// substitution at that name would, between the open and the cleanup.
//
// It is for one contract: what a failed publish removes. Cleanup that deletes by NAME
// deletes whatever is at the name, including an entry the run was never told it owned, so
// a guard that exists to protect a stranger's file performs the destruction instead. The
// run must leave an unconfirmable temp name alone and say so.
//
//   nodeArgs: ['--import', substituteOnRename({ dir, fragment: 'music.wav.part-' })]
//
// It never writes, moves or removes anything: all it does is withhold the identity of ONE
// path, after one rename, and fail that rename. The real file stays exactly where it is,
// so a test can assert it was left behind rather than deleted.
//
// Bounded as the other fixtures are: the directory must be a suite-owned temp directory
// (see test-owned-path.mjs), so an inherited NODE_OPTIONS cannot aim it elsewhere. It
// announces itself and the substitution on stderr, so a test can prove the collision was
// staged rather than passing because it never was.
//
// It is a TEST fixture. Nothing in src/ may import it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEST_DIR_PREFIX } from './test-owned-path.mjs';

const params = new URL(import.meta.url).searchParams;
const fragment = params.get('fragment');
if (!params.get('dir') || !fragment) {
  throw new Error('substitute-on-rename: its --import URL must carry dir and fragment');
}
const dir = fs.realpathSync.native(params.get('dir'));
const tmp = fs.realpathSync.native(os.tmpdir());
if (path.dirname(dir) !== tmp || !path.basename(dir).startsWith(TEST_DIR_PREFIX)) {
  throw new Error(`substitute-on-rename: ${dir} is not a ${TEST_DIR_PREFIX}* directory directly under ${tmp}`);
}

const targeted = (candidate) =>
  typeof candidate === 'string' &&
  candidate.includes(fragment) &&
  path.dirname(path.resolve(candidate)) === dir;

/** The path whose identity is withheld once the rename has failed. */
let substituted = null;

const lstatSync = fs.lstatSync;
fs.lstatSync = (candidate, ...rest) => {
  const st = lstatSync(candidate, ...rest);
  if (substituted === null || typeof candidate !== 'string' || path.resolve(candidate) !== substituted) return st;
  // A different file at the same name: same kind, an inode that is not the caller's.
  if (st !== null && typeof st === 'object' && 'ino' in st) {
    st.ino = typeof st.ino === 'bigint' ? st.ino + 1n : st.ino + 1;
  }
  return st;
};

const renameSync = fs.renameSync;
fs.renameSync = (from, ...rest) => {
  if (substituted !== null || !targeted(from)) return renameSync(from, ...rest);
  substituted = path.resolve(from);
  process.stderr.write(`substitute-on-rename: failed the rename of ${substituted} and substituted it\n`);
  const err = new Error(`EPERM: operation not permitted, rename '${from}'`);
  err.code = 'EPERM';
  throw err;
};

process.stderr.write(`substitute-on-rename: armed — the first rename of ${fragment}* inside ${dir} fails\n`);
