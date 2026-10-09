// --------------------------------------------------------------------------------------
// THE INSTRUMENT HAS TO AGREE WITH ITSELF.
//
// Two commands are prescribed for this domain and they must select the same files:
//
//   .github/domains.yaml  test_cmd : node --test "tools/SizzleCraft/tests/**/*.test.mjs"
//   package.json          test     : node --test        (from tools/SizzleCraft)
//
// They drifted once. `tests/fixtures/test-owned-path.mjs` is a FIXTURE — it exports path
// helpers and registers nothing — but its name matches Node's default `test-*.mjs` pattern,
// so the bare `node --test` ran it and scored it `ok` with ZERO assertions, while the
// registry glob never matched it. The two commands reported 1556 and 1555, and the
// disagreement stood long enough for a wrong theory to be built on top of it.
//
// A passing test that cannot fail, living inside the instrument used to measure this repo.
//
// Renaming that one file fixed the instance. This file fixes the CLASS: the next fixture
// named `test-*.mjs`, `*-test.mjs`, `*_test.mjs` or `test.mjs`, or any file dropped into a
// directory called `test/`, is picked up by one command and not the other, and this fails
// before anyone builds on the number.
// --------------------------------------------------------------------------------------
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.join(TESTS_DIR, "..");

/**
 * Node's own default test-file patterns, as documented for the runner:
 *   **\/*.test.?(c|m)js  **\/*-test.?(c|m)js  **\/*_test.?(c|m)js
 *   **\/test-*.?(c|m)js  **\/test.?(c|m)js    **\/test\/**\/*.?(c|m)js
 * Written out rather than imported because Node exposes no predicate for it; the control
 * below pins each clause so a wrong transcription fails here instead of going unnoticed.
 */
export function matchesNodeDefaultDiscovery(relPath) {
  const parts = relPath.split(/[\\/]/);
  const base = parts.at(-1);
  if (!/\.(c|m)?js$/.test(base)) return false;
  if (parts.slice(0, -1).includes("test")) return true;
  return (
    /\.test\.(c|m)?js$/.test(base) ||
    /-test\.(c|m)?js$/.test(base) ||
    /_test\.(c|m)?js$/.test(base) ||
    /^test-.*\.(c|m)?js$/.test(base) ||
    /^test\.(c|m)?js$/.test(base)
  );
}

/**
 * THERE IS NO HOLLOW-FILE CHECK HERE, AND THAT IS A DECISION, NOT AN OMISSION.
 *
 * The brief for this file asked for two things: that the two prescribed commands select the
 * same files, and that nothing which asserts nothing be counted as a test. The first is
 * pure filename logic and is audited below. The second was attempted four times and each
 * version was wrong in a different direction:
 *
 *   1. "imports node:test"            — passed a file that imports the runner and registers
 *                                       nothing, i.e. the exact defect it was written for.
 *   2. strip comments, then look      — a string literal holding `/*` swallowed a real
 *                                       registration, reporting a VALID file hollow.
 *   3. line-anchored `test(`          — reported `test.skip(…)` hollow. Valid file, failed.
 *   4. "mentions a registration"      — reported `import { test as check }` hollow. Same.
 *
 * Versions 2, 3 and 4 FAILED CORRECT FILES. A guard that fails valid work is worse than the
 * leniency it replaces, and each fix moved the error rather than removing it. Deciding this
 * from source needs a parser; deciding it honestly needs to execute every file and ask the
 * runner how many tests it registered, which is a second full suite on every run.
 *
 * So it is left out. If someone adds it later: it must handle aliased imports, `test.skip`
 * and `test.only`, registrations inside loops and `await`, and comment delimiters appearing
 * inside string literals — and it must be measured against valid files first, because every
 * version of this that shipped a bug shipped it in that direction.
 *
 * The defect that was actually found — a FIXTURE named `test-*.mjs` being scored `ok` with
 * zero assertions by one command and invisible to the other — is caught by the filename
 * audit below, which has no heuristic in it.
 */

/** The registry's glob, `tests/**\/*.test.mjs`, applied to a package-relative path. */
export function matchesRegistryGlob(relPath) {
  const parts = relPath.split(/[\\/]/);
  return (
    parts[0] === "tests" &&
    parts.length >= 2 &&
    /\.test\.mjs$/.test(parts.at(-1))
  );
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // Generated and vendored trees are not part of the suite's own file set.
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(path.relative(PKG_DIR, full).split(path.sep).join("/"));
  }
  return out;
}

describe("the two prescribed test commands select the same files", () => {
  // The predicate is hand-written, so it is pinned before anything leans on it. Without
  // this, a mistyped clause would make the audit below silently vacuous.
  test("discoveryPredicates_matchTheDocumentedPatterns", () => {
    for (const yes of [
      "a.test.mjs",
      "a-test.js",
      "a_test.cjs",
      "test-a.mjs",
      "test.mjs",
      "test/any.mjs",
      "deep/test/any.js",
    ]) {
      assert.equal(
        matchesNodeDefaultDiscovery(yes),
        true,
        `node --test should pick up ${yes}`,
      );
    }
    for (const no of [
      "helpers.mjs",
      "a.testing.mjs",
      "attest.mjs",
      "fixtures/fake-audio.mjs",
      "tests/README.md",
    ]) {
      assert.equal(
        matchesNodeDefaultDiscovery(no),
        false,
        `node --test should NOT pick up ${no}`,
      );
    }
    assert.equal(matchesRegistryGlob("tests/a.test.mjs"), true);
    assert.equal(matchesRegistryGlob("tests/fixtures/a.test.mjs"), true);
    assert.equal(
      matchesRegistryGlob("tests/fixtures/test-a.mjs"),
      false,
      "the glob needs the .test.mjs suffix",
    );
    assert.equal(
      matchesRegistryGlob("src/a.test.mjs"),
      false,
      "the glob is rooted at tests/",
    );
  });

  test("everyFileTheBareRunnerWouldPickUp_isAlsoMatchedByTheRegistryGlob", () => {
    const files = walk(PKG_DIR);
    const onlyNode = files.filter(
      (f) => matchesNodeDefaultDiscovery(f) && !matchesRegistryGlob(f),
    );

    assert.deepEqual(
      onlyNode,
      [],
      "these are run by `node --test` but not by the registry test_cmd, so the two commands " +
        "report different totals. A fixture must not be named test-*.mjs, *-test.mjs, *_test.mjs " +
        "or test.mjs, and must not live in a directory called test/.",
    );
  });

  test("everyFileTheRegistryGlobMatches_isAlsoPickedUpByTheBareRunner", () => {
    const files = walk(PKG_DIR);
    const onlyGlob = files.filter(
      (f) => !matchesNodeDefaultDiscovery(f) && matchesRegistryGlob(f),
    );

    assert.deepEqual(
      onlyGlob,
      [],
      "the registry test_cmd runs these and `node --test` does not",
    );
  });
});
