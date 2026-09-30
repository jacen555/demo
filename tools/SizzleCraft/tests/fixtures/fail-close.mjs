// FAIL CLOSE: a test-only preload that makes fs.closeSync fail with EIO for the descriptors
// fs.openSync opened on entries of one directory whose names contain a fragment — as
// close(2) can report an error from an earlier write, over NFS or against a disk quota.
// The descriptor is really closed first, then the error is thrown: close(2) releases it
// even when it reports one, and a leaked handle would keep the file open on Windows.
//
// It is for contracts about what a script does when a file it wrote cannot be closed, such
// as a published ducking record whose bytes cannot be confirmed.
//
//   import { failClose, runScript } from './_helpers.mjs';
//   const r = runScript('make-music.mjs', ['--apply'], dir, {
//     nodeArgs: ['--import', failClose({ dir, fragment: 'music.wav.duck.json.part-' })],
//   });
//
// It takes none of its settings from the environment: it is armed only by being imported
// with them in the query string of its URL. But that URL can come from a NODE_OPTIONS a
// parent shell passes down as well as from the command line, so how it is armed bounds
// nothing. What bounds it is that the directory must be a suite-owned temp directory (see
// test-owned-path.mjs; os.tmpdir() itself comes from the environment, TEMP on Windows),
// and that it never writes, moves or removes anything itself — all it can do is report a
// close that has happened as failed. Each failure is announced on stderr, so a test can
// prove the failure was staged rather than passing because it never was.
//
// It is a TEST fixture. Nothing in src/ may import it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEST_DIR_PREFIX } from './test-owned-path.mjs';

const params = new URL(import.meta.url).searchParams;
const fragment = params.get('fragment');
if (!params.get('dir') || !fragment) throw new Error('fail-close: its --import URL must carry dir and fragment');
const dir = fs.realpathSync.native(params.get('dir'));
const tmp = fs.realpathSync.native(os.tmpdir());
if (path.dirname(dir) !== tmp || !path.basename(dir).startsWith(TEST_DIR_PREFIX)) {
  throw new Error(`fail-close: ${dir} is not a ${TEST_DIR_PREFIX}* directory directly under ${tmp}`);
}

// Checked after the open has succeeded, so it must not throw: that would leak the descriptor.
const staged = (name) => {
  try {
    return path.basename(name).includes(fragment) && fs.realpathSync.native(path.dirname(name)) === dir;
  } catch {
    return false;
  }
};

// A descriptor number open has just returned is not open under any other name, so an entry
// still held for it is stale (closed some other way) and must not fail an unrelated close.
const opened = new Map();
const openSync = fs.openSync;
fs.openSync = (candidate, ...rest) => {
  const fd = openSync(candidate, ...rest);
  const name = String(candidate);
  if (staged(name)) opened.set(fd, name);
  else opened.delete(fd);
  return fd;
};

const closeSync = fs.closeSync;
fs.closeSync = (fd, ...rest) => {
  const name = opened.get(fd);
  if (name === undefined) return closeSync(fd, ...rest);
  opened.delete(fd);
  closeSync(fd, ...rest);
  process.stderr.write(`fail-close: failed the close of ${name}\n`);
  throw Object.assign(new Error(`EIO: i/o error, close '${name}'`), { code: 'EIO', syscall: 'close' });
};
