// FAIL ONE PUBLISH RENAME, DETERMINISTICALLY.
//
// The partial-publish path in voice.mjs exists only between two points in a run: after the
// earlier artifacts have been renamed into place and before the timeline is. Reaching it
// from the parent process — watching stdout and planting an obstruction — is a RACE: the
// child keeps running while the pipe is delivered, so it can stage and publish before the
// plant lands, and the test then asserts against an ordinary successful run.
//
// This preload removes the race by failing inside the child itself. `fs.renameSync` is a
// property of the single `node:fs` namespace object every importer shares, so replacing it
// here replaces it for the stage under test.
//
//   nodeArgs: ['--import', FAKE_AUDIO, '--import', FAIL_RENAME]
//   env: { FAIL_RENAME_DEST: 'sync-mapping.md' }
//
// With FAIL_RENAME_DEST unset it does nothing, so an inherited environment cannot arm it
// in an unrelated run.
//
// SIBLING: fail-rename.mjs fails the first rename whose SOURCE contains a fragment, inside a
// suite-owned directory, armed through its --import URL. This one matches the DESTINATION
// basename. Two streams independently created a fixture called fail-rename.mjs and collided
// on merge; the names now say which end each one matches.
import fs from "node:fs";
import path from "node:path";

const target = process.env.FAIL_RENAME_DEST;
if (target) {
    const real = fs.renameSync.bind(fs);
    fs.renameSync = (from, to) => {
        if (path.basename(String(to)) === target) {
            const err = new Error(`fail-rename: refusing to publish ${target}`);
            err.code = "EPERM";
            throw err;
        }
        return real(from, to);
    };
}
