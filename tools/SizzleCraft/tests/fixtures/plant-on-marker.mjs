// PLANT ON MARKER: a test-only preload that creates one file the moment the script under
// test logs a line containing a marker — synchronously, inside that console.log call — so
// the file exists before the script's next statement runs, whatever the timing.
//
// It is for contracts that live between two points in one run, such as a no-clobber check
// made up front and the write it guards minutes later. runScriptPlantingOnMarker plants
// from the PARENT once the marker arrives on a pipe, which races the child; this cannot.
//
//   import { plantOnMarker, runScript } from './_helpers.mjs';
//   const r = runScript('make-music.mjs', ['--apply'], dir, {
//     nodeArgs: ['--import', plantOnMarker({ marker: 'raw peak', target, body: 'PLANTED' })],
//   });
//
// It takes none of its settings from the environment: it is armed only by being imported
// with them in the query string of its URL. But that URL can come from a NODE_OPTIONS a
// parent shell passes down as well as from the command line, so how it is armed bounds
// nothing. What bounds it is that the target must lie inside a suite-owned temp directory
// (see suite-owned-path.mjs; os.tmpdir() itself comes from the environment, TEMP on
// Windows), and that it is created with `wx`, so the plant can never overwrite anything.
// The plant is announced on stdout, so a test can prove the collision was staged rather
// than passing because it never was.
//
// It is a TEST fixture. Nothing in src/ may import it.
import fs from 'node:fs';
import { requireTestOwnedPath } from './suite-owned-path.mjs';

const params = new URL(import.meta.url).searchParams;
const marker = params.get('marker');
const body = params.get('body');
if (!marker || body === null || !params.get('target')) {
  throw new Error('plant-on-marker: its --import URL must carry marker, target and body');
}
const target = requireTestOwnedPath(params.get('target'), 'plant-on-marker target', { mayBeAbsent: true });

const log = console.log;
let planted = false;
console.log = (...args) => {
  log(...args);
  if (planted || !args.map(String).join(' ').includes(marker)) return;
  planted = true;
  fs.writeFileSync(target, body, { flag: 'wx' });
  log(`plant-on-marker: planted ${target}`);
};
