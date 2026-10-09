// FAIL LSTAT: a test-only preload that makes fs.lstatSync fail with EPERM for named entries
// of one directory — as an entry whose permissions deny the caller can on Windows.
//
// It is for contracts about what a script concludes when an entry cannot be inspected: a
// search that could not look at every entry has not shown what the entries it missed are.
//
//   import { failLstat, runScript } from './_helpers.mjs';
//   const r = runScript('concat-audio.mjs', [], dir, {
//     nodeArgs: ['--import', failLstat({ dir, names: ['segment_001.mp3'] })],
//   });
//
// A path is refused when its basename is exactly one of the names and its parent resolves to
// the directory. Only fs.lstatSync is wrapped, and only for a path given as a string; every
// other call passes through.
//
// It takes none of its settings from the environment: it is armed only by being imported
// with them in the query string of its URL. But that URL can come from a NODE_OPTIONS a
// parent shell passes down as well as from the command line, so how it is armed bounds
// nothing. What bounds it is that the directory must be a suite-owned temp directory (see
// suite-owned-path.mjs; os.tmpdir() itself comes from the environment, TEMP on Windows),
// and that it never writes, moves or removes anything — all it can do is make an lstat
// fail. It is announced on stderr once armed, and so is each refusal, so a test can prove
// the failure was staged rather than passing because it never was.
//
// It is a TEST fixture. Nothing in src/ may import it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TEST_DIR_PREFIX } from "./suite-owned-path.mjs";

const params = new URL(import.meta.url).searchParams;
const names = params.getAll("name");
if (
    !params.get("dir") ||
    names.length === 0 ||
    names.some((n) => n === "" || n !== path.basename(n))
) {
    throw new Error(
        "fail-lstat: its --import URL must carry dir and at least one name, each a bare entry name",
    );
}
const dir = fs.realpathSync.native(params.get("dir"));
const tmp = fs.realpathSync.native(os.tmpdir());
if (
    path.dirname(dir) !== tmp ||
    !path.basename(dir).startsWith(TEST_DIR_PREFIX)
) {
    throw new Error(
        `fail-lstat: ${dir} is not a ${TEST_DIR_PREFIX}* directory directly under ${tmp}`,
    );
}

// Whether `candidate` is one of the named entries of the directory. Its parent is resolved,
// not the path itself, so the entry is matched whatever it is. Asked for every lstat, so it
// must not throw.
const refused = (candidate) => {
    if (typeof candidate !== "string" || candidate === "") return false;
    const abs = path.resolve(candidate);
    if (!names.includes(path.basename(abs))) return false;
    try {
        return fs.realpathSync.native(path.dirname(abs)) === dir;
    } catch {
        return false;
    }
};

const lstatSync = fs.lstatSync;
fs.lstatSync = (candidate, ...rest) => {
    if (refused(candidate)) {
        process.stderr.write(`fail-lstat: refused ${candidate}\n`);
        throw Object.assign(
            new Error(`EPERM: operation not permitted, lstat '${candidate}'`),
            {
                code: "EPERM",
                syscall: "lstat",
                path: candidate,
            },
        );
    }
    return lstatSync(candidate, ...rest);
};

process.stderr.write(
    `fail-lstat: armed — lstat fails for ${names.join(", ")} inside ${dir}\n`,
);
