// CONFUSE AFTER RENAME: a test-only preload that lets one `fs.renameSync` SUCCEED and then
// makes the name it renamed TO stop being confirmable as the file the caller holds open —
// in whichever of the four ways the identity check can fail.
//
// It is the companion to substitute-on-rename.mjs, which fails the rename itself. This one
// is for the window after: a publish that landed, and a name that can no longer be shown
// to hold what was published there. A run must report WHICH of those it found —
// "another entry took its place" and "this volume gives no file identity" are not the same
// fact — and must not delete or overwrite anything on the strength of a guess.
//
//   nodeArgs: ['--import', confuseAfterRename({ dir, name: 'music.wav', verdict: 'different' })]
//
// `verdict` selects what the lstat of that name reports afterwards:
//   different   — a plausible entry with an inode that is not the caller's
//   absent      — nothing at the name
//   unavailable — inode 0, as a volume that gives no file ID reports
//   unchecked   — the stat itself fails
//
// It never writes, moves or removes anything: the real rename happens, and all that is
// altered afterwards is what ONE path's lstat reports. Bounded as the other fixtures are:
// the directory must be a suite-owned temp directory (see suite-owned-path.mjs). It
// announces itself and the rename on stderr, so a test can prove the condition was staged.
//
// It is a TEST fixture. Nothing in src/ may import it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEST_DIR_PREFIX } from './suite-owned-path.mjs';

const VERDICTS = new Set(['different', 'absent', 'unavailable', 'unchecked']);

const params = new URL(import.meta.url).searchParams;
const name = params.get('name');
const verdict = params.get('verdict');
if (!params.get('dir') || !name || !VERDICTS.has(verdict)) {
  throw new Error(
    `confuse-after-rename: its --import URL must carry dir, name and verdict (${[...VERDICTS].join(', ')})`,
  );
}
const dir = fs.realpathSync.native(params.get('dir'));
const tmp = fs.realpathSync.native(os.tmpdir());
if (path.dirname(dir) !== tmp || !path.basename(dir).startsWith(TEST_DIR_PREFIX)) {
  throw new Error(`confuse-after-rename: ${dir} is not a ${TEST_DIR_PREFIX}* directory directly under ${tmp}`);
}

/** The destination path whose lstat is altered, once the rename onto it has happened. */
let confused = null;

const lstatSync = fs.lstatSync;
fs.lstatSync = (candidate, ...rest) => {
  if (confused === null || typeof candidate !== 'string' || path.resolve(candidate) !== confused) {
    return lstatSync(candidate, ...rest);
  }
  if (verdict === 'unchecked') {
    const err = new Error(`EPERM: operation not permitted, lstat '${candidate}'`);
    err.code = 'EPERM';
    throw err;
  }
  if (verdict === 'absent') return undefined;
  const st = lstatSync(candidate, ...rest);
  if (st !== null && typeof st === 'object' && 'ino' in st) {
    const zero = typeof st.ino === 'bigint' ? 0n : 0;
    const next = typeof st.ino === 'bigint' ? st.ino + 1n : st.ino + 1;
    st.ino = verdict === 'unavailable' ? zero : next;
  }
  return st;
};

const renameSync = fs.renameSync;
fs.renameSync = (from, to, ...rest) => {
  const result = renameSync(from, to, ...rest);
  const targeted =
    confused === null &&
    typeof to === 'string' &&
    path.basename(to) === name &&
    path.dirname(path.resolve(to)) === dir;
  if (targeted) {
    confused = path.resolve(to);
    process.stderr.write(`confuse-after-rename: renamed onto ${confused}, now reporting it as ${verdict}\n`);
  }
  return result;
};

process.stderr.write(
  `confuse-after-rename: armed — the first rename onto ${name} inside ${dir} reports ${verdict} after\n`,
);
