// ZERO FILE IDS: a test-only preload that makes the stat calls report inode 0 for every
// path inside one directory — as Node reports for a file on a volume that gives it no
// file ID, so that two names cannot be told to be one file by identity.
//
// It is for contracts about what a script concludes when identity cannot be asked: an
// unknown identity is not a different file, and a claim that rests on it is qualified.
//
//   import { zeroFileIds, runScript } from './_helpers.mjs';
//   const r = runScript('concat-audio.mjs', [], dir, { nodeArgs: ['--import', zeroFileIds({ dir })] });
//
// It withholds the inode, in both the bigint and the number forms, from fs.lstatSync and
// fs.statSync of a string path inside the directory, and from fs.fstatSync of a descriptor
// it holds an entry for. It sees descriptors only as fs.openSync and fs.closeSync do: an
// entry is made when fs.openSync returns a number for a string path inside, and dropped
// when fs.openSync returns that number for any other path or fs.closeSync is given it. So
// a number closed by any other call keeps its entry, and if anything but fs.openSync then
// reopens it, fs.fstatSync of it reports inode 0, whatever it now names. The engine reads
// an inode from no other call. It also opens descriptors other ways (a read stream in
// envelope-ducking.mjs, fs.promises.readFile in vo-envelope.mjs), but gives fs.fstatSync
// only descriptors fs.openSync returned that are still open (openExclusiveEngineFile in
// cli-support.mjs, and encode-mp4.mjs): for each of those, an entry is held exactly when
// the path opened is inside.
//
// It takes none of its settings from the environment: it is armed only by being imported
// with them in the query string of its URL. But that URL can come from a NODE_OPTIONS a
// parent shell passes down as well as from the command line, so how it is armed bounds
// nothing. What bounds it is that the directory must be a suite-owned temp directory (see
// suite-owned-path.mjs; os.tmpdir() itself comes from the environment, TEMP on Windows),
// and that it never writes, moves or removes anything — all it can do is withhold an
// inode. It is announced on stderr once armed, so a test can prove the IDs were withheld
// rather than passing because they never were.
//
// It is a TEST fixture. Nothing in src/ may import it.
import fs from 'node:fs';
import path from 'node:path';
import { requireTestOwnedDir } from './suite-owned-path.mjs';

const params = new URL(import.meta.url).searchParams;
if (!params.get('dir')) throw new Error('zero-file-ids: its --import URL must carry dir');
const dir = requireTestOwnedDir(params.get('dir'), 'zero-file-ids');

// Whether `candidate` names something strictly inside the directory. Its parent is
// resolved, not the path itself, so a link inside the directory counts wherever it points:
// it is the name the caller asked about. Asked for every stat, so it must not throw.
const inside = (candidate) => {
  if (typeof candidate !== 'string' || candidate === '') return false;
  const abs = path.resolve(candidate);
  let parent;
  try {
    parent = fs.realpathSync.native(path.dirname(abs));
  } catch {
    return false;
  }
  const relative = path.relative(dir, path.join(parent, path.basename(abs)));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const withoutId = (st) => {
  if (st !== undefined && st !== null && typeof st === 'object' && 'ino' in st) {
    st.ino = typeof st.ino === 'bigint' ? 0n : 0;
  }
  return st;
};

for (const name of ['lstatSync', 'statSync']) {
  const real = fs[name];
  fs[name] = (candidate, ...rest) => {
    const st = real(candidate, ...rest);
    return inside(candidate) ? withoutId(st) : st;
  };
}

// A number fs.openSync has just returned is open under no other name, so an entry still
// held for it is stale (the number was closed by a call other than fs.closeSync) and is set
// afresh here from the path just opened. Until fs.openSync or fs.closeSync next sees the
// number, a stale entry stands (see above).
const opened = new Set();
const openSync = fs.openSync;
fs.openSync = (candidate, ...rest) => {
  const fd = openSync(candidate, ...rest);
  if (inside(candidate)) opened.add(fd);
  else opened.delete(fd);
  return fd;
};
const closeSync = fs.closeSync;
fs.closeSync = (fd, ...rest) => {
  opened.delete(fd);
  return closeSync(fd, ...rest);
};
const fstatSync = fs.fstatSync;
fs.fstatSync = (fd, ...rest) => {
  const st = fstatSync(fd, ...rest);
  return opened.has(fd) ? withoutId(st) : st;
};

process.stderr.write(`zero-file-ids: armed — inode 0 for every path inside ${dir}\n`);
