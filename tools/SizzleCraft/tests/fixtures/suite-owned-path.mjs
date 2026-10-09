// Confines a path a test fixture acts on to a directory the suite itself created.
//
// A fixture armed by its caller can be armed by accident. runScript hands the child the
// parent's whole environment, so a variable inherited from a shell arms a fixture in every
// run that loads it. Anything a fixture copies or writes must therefore land inside a
// `sizzlecraft-test-*` directory directly under the real temp dir — what makeProject and
// makeOutsideDir create — and the comparison is on REAL paths, so a link cannot walk out.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TEST_DIR_PREFIX = "sizzlecraft-test-";

/**
 * The real path of `candidate`, which must lie inside a `sizzlecraft-test-*` directory
 * directly under realpath(os.tmpdir()). It must be a regular file, or absent when
 * `mayBeAbsent`, and never a link. Anything else throws, loudly: a fixture that skipped
 * silently would let the test it serves pass on a run where it never acted.
 */
export function requireTestOwnedPath(
    candidate,
    label,
    { mayBeAbsent = false } = {},
) {
    const refuse = (why) => {
        throw new Error(
            `${label}: ${JSON.stringify(candidate)} ${why} — refusing to touch it`,
        );
    };
    if (typeof candidate !== "string" || !path.isAbsolute(candidate))
        refuse("is not an absolute path");

    const st = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (st === undefined) {
        if (!mayBeAbsent) refuse("does not exist");
    } else if (st.isSymbolicLink()) {
        refuse("is a link");
    } else if (!st.isFile()) {
        refuse("is not a regular file");
    }

    let real;
    try {
        real =
            st === undefined
                ? path.join(
                      fs.realpathSync.native(path.dirname(candidate)),
                      path.basename(candidate),
                  )
                : fs.realpathSync.native(candidate);
    } catch (err) {
        refuse(`could not be resolved (${err.code ?? err.message})`);
    }

    const tmp = fs.realpathSync.native(os.tmpdir());
    const relative = path.relative(tmp, real);
    const [owner, ...rest] = relative.split(path.sep);
    if (
        path.isAbsolute(relative) ||
        !owner.startsWith(TEST_DIR_PREFIX) ||
        rest.length === 0
    ) {
        refuse(
            `is not inside a ${TEST_DIR_PREFIX}* directory directly under ${tmp}`,
        );
    }
    return real;
}
