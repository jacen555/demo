import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeProject, removeFixture } from "./_helpers.mjs";

// Seven fixture preloads confine the directory they are armed for to a `sizzlecraft-test-*`
// directory directly under the real temp dir, through the one requireTestOwnedDir. Each
// preload's own tests only ever arm it for a legitimate directory, so nothing else pins that
// the refusal still reaches each of them, under its own label. Each case loads the preload
// into a child of its own, as `--import` does.

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const PRELOADS = {
  "fail-close": { fragment: "x" },
  "fail-lstat": { name: "x" },
  "fail-rename": { fragment: "x" },
  "refuse-unlink": { fragment: "x" },
  "substitute-on-rename": { fragment: "x" },
  "confuse-after-rename": { name: "x", verdict: "different" },
  "zero-file-ids": {},
};

function load(preload, dir) {
  const url = pathToFileURL(path.join(fixturesDir, `${preload}.mjs`));
  url.search = new URLSearchParams({ dir, ...PRELOADS[preload] }).toString();
  const r = spawnSync(process.execPath, ["--import", url.href, "-e", ""], {
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status, stderr: r.stderr ?? "" };
}

describe("every directory-armed preload confines its directory to a suite-owned temp directory", () => {
  for (const preload of Object.keys(PRELOADS)) {
    test(`${preload}_armedForASuiteOwnedDirectory_loadsCleanly`, (t) => {
      const r = load(preload, makeProject(t));
      assert.equal(
        r.code,
        0,
        `the positive control: a suite-owned directory must be accepted\n${r.stderr}`,
      );
    });

    test(`${preload}_armedForTheTempDirItself_refusesUnderItsOwnLabel`, () => {
      const tmp = fs.realpathSync.native(os.tmpdir());
      const r = load(preload, tmp);
      assert.notEqual(r.code, 0);
      assert.ok(
        r.stderr.includes(
          `${preload}: ${tmp} is not a sizzlecraft-test-* directory directly under ${tmp}`,
        ),
        r.stderr,
      );
    });

    test(`${preload}_armedForADirectoryBelowASuiteOwnedOne_refusesUnderItsOwnLabel`, (t) => {
      const nested = path.join(makeProject(t), "sizzlecraft-test-nested");
      fs.mkdirSync(nested);
      const r = load(preload, nested);
      assert.notEqual(r.code, 0);
      assert.match(
        r.stderr,
        new RegExp(
          `${preload}: .* is not a sizzlecraft-test-\\* directory directly under`,
        ),
      );
    });

    test(`${preload}_armedForATempChildWithoutThePrefix_refusesUnderItsOwnLabel`, (t) => {
      const other = fs.mkdtempSync(path.join(os.tmpdir(), "not-the-suite-"));
      t.after(() => removeFixture(other));
      const r = load(preload, other);
      assert.notEqual(r.code, 0);
      assert.match(
        r.stderr,
        new RegExp(
          `${preload}: .* is not a sizzlecraft-test-\\* directory directly under`,
        ),
      );
    });
  }
});
