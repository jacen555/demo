// PLANT A LINK ON MARKER: the sibling of plant-on-marker.mjs. It creates a SYMLINK, not a
// file, the moment the script under test logs a line containing a marker — synchronously,
// inside that console.log call — so the link exists before the script's next statement
// runs, whatever the timing.
//
// It exists for one contract plant-on-marker cannot stage: a path the engine resolved up
// front, with links REFUSED, and wrote to minutes later. A check that is not the write
// leaves a window, and a link is what walks through it — an ordinary file planted in that
// window is refused by any no-clobber write, while a link is followed by one that opens
// with 'w'.
//
//   const r = runScript('make-music.mjs', ['--apply', '--replace'], dir, {
//     nodeArgs: ['--import', plantLinkOnMarker({ marker: 'raw peak', target, victim })],
//   });
//
// Bounded exactly as plant-on-marker is: BOTH the link's name and what it points at must
// lie inside a suite-owned temp directory (see suite-owned-path.mjs), so an inherited
// NODE_OPTIONS cannot aim it at anything the suite does not own. The link is created with
// symlinkSync, which fails if anything is already at the name, so the plant can never
// replace anything. It is announced on stdout, so a test can prove the collision was
// staged rather than passing because it never was.
//
// It is a TEST fixture. Nothing in src/ may import it.
import fs from 'node:fs';
import { requireTestOwnedPath } from './suite-owned-path.mjs';

const params = new URL(import.meta.url).searchParams;
const marker = params.get('marker');
if (!marker || !params.get('target') || !params.get('victim')) {
  throw new Error('plant-link-on-marker: its --import URL must carry marker, target and victim');
}
const target = requireTestOwnedPath(params.get('target'), 'plant-link-on-marker target', { mayBeAbsent: true });
const victim = requireTestOwnedPath(params.get('victim'), 'plant-link-on-marker victim');

const log = console.log;
let planted = false;
console.log = (...args) => {
  log(...args);
  if (planted || !args.map(String).join(' ').includes(marker)) return;
  planted = true;
  try {
    fs.symlinkSync(victim, target, 'file');
  } catch (err) {
    // Announced, never swallowed: a test that asserts the plant landed must be able to
    // tell "the platform refused to make a link" from "the engine refused to follow one".
    log(`plant-link-on-marker: could not plant ${target} (${err.code ?? err.message})`);
    return;
  }
  log(`plant-link-on-marker: planted ${target} -> ${victim}`);
};
