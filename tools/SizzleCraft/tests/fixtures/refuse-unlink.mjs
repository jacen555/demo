// REFUSE UNLINK: a test-only preload that makes fs.unlinkSync fail with EPERM for the
// entries of one directory whose names contain a fragment — as a scanner or an indexer
// holding a file open can make a removal fail on Windows.
//
// It is for contracts about what a script does when it cannot tidy up after itself, such
// as a published ducking record whose temp name will not go away.
//
//   import { refuseUnlink, runScript } from './_helpers.mjs';
//   const r = runScript('make-music.mjs', ['--apply'], dir, {
//     nodeArgs: ['--import', refuseUnlink({ dir, fragment: 'music.wav.duck.json.part-' })],
//   });
//
// It takes none of its settings from the environment: it is armed only by being imported
// with them in the query string of its URL. But that URL can come from a NODE_OPTIONS a
// parent shell passes down as well as from the command line, so how it is armed bounds
// nothing. What bounds it is that the directory must be a suite-owned temp directory (see
// suite-owned-path.mjs; os.tmpdir() itself comes from the environment, TEMP on Windows),
// and that it never writes, moves or removes anything itself — all it can do is make a
// removal fail. Each refusal is announced on stderr, so a test can prove the failure was
// staged rather than passing because it never was.
//
// It is a TEST fixture. Nothing in src/ may import it.
import fs from 'node:fs';
import path from 'node:path';
import { requireTestOwnedDir } from './suite-owned-path.mjs';

const params = new URL(import.meta.url).searchParams;
const fragment = params.get('fragment');
if (!params.get('dir') || !fragment) throw new Error('refuse-unlink: its --import URL must carry dir and fragment');
const dir = requireTestOwnedDir(params.get('dir'), 'refuse-unlink');

const unlinkSync = fs.unlinkSync;
fs.unlinkSync = (candidate, ...rest) => {
  const name = String(candidate);
  if (path.basename(name).includes(fragment) && fs.realpathSync.native(path.dirname(name)) === dir) {
    process.stderr.write(`refuse-unlink: refused ${name}\n`);
    throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${name}'`), {
      code: 'EPERM',
      syscall: 'unlink',
      path: name,
    });
  }
  return unlinkSync(candidate, ...rest);
};
