import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  makeProject,
  tryMakeFileLink,
  zeroFileIds,
  ZERO_FILE_IDS_ARMED,
} from "./_helpers.mjs";

// fixtures/zero-file-ids.mjs is what every no-file-ID test stands on: each one is only as
// good as the fixture's claim to withhold an inode where it says it does, and nowhere else.
// This pins that claim, by path and by descriptor, as its header states it. The fixture
// patches fs for the whole process it is loaded into, so each case runs in a child of its
// own, armed for one directory, beside a second directory that is not armed.
//
// Its header also states a limit: a number closed and reopened by calls it does not see
// keeps a stale entry. That is not a contract, and is not pinned here.

// One case, run under the armed fixture. It prints what it measured as JSON: a bigint
// inode as a string, a number inode as a number. A descriptor case also reports the number
// it closed and the number it reopened, so the test can show the second reused the first.
const CHILD = `
import fs from 'node:fs';
const [which, inside, outside, link] = process.argv.slice(1);
const asyncOpen = (p) => new Promise((resolve, reject) => fs.open(p, 'r', (e, fd) => (e ? reject(e) : resolve(fd))));
const asyncClose = (fd) => new Promise((resolve, reject) => fs.close(fd, (e) => (e ? reject(e) : resolve())));
const inodes = (stat) => ({ big: String(stat({ bigint: true }).ino), num: stat({}).ino });
const byFd = (fd) => inodes((o) => fs.fstatSync(fd, o));
let out;
if (which === 'paths') {
  out = {};
  for (const [side, p] of [['inside', inside], ['outside', outside]]) {
    out[side] = { lstat: inodes((o) => fs.lstatSync(p, o)), stat: inodes((o) => fs.statSync(p, o)) };
  }
} else if (which === 'link') {
  out = inodes((o) => fs.statSync(link, o));
} else if (which === 'c1' || which === 'c2') {
  const fd = fs.openSync(which === 'c1' ? inside : outside, 'r');
  out = byFd(fd);
  fs.closeSync(fd);
} else if (which === 'c3') {
  const closed = fs.openSync(inside, 'r');
  fs.closeSync(closed);
  const fd = await asyncOpen(outside);
  out = { closed, reopened: fd, ...byFd(fd) };
  await asyncClose(fd);
} else if (which === 'c4') {
  const closed = fs.openSync(inside, 'r');
  await asyncClose(closed);
  const fd = fs.openSync(outside, 'r');
  out = { closed, reopened: fd, ...byFd(fd) };
  fs.closeSync(fd);
} else {
  throw new Error('unknown case ' + which);
}
process.stdout.write(JSON.stringify(out));
`;

describe("zero-file-ids fixture", () => {
  // A file inside the armed directory, one outside it, and the outside file's real inode,
  // read here where nothing is armed. Where the volume gives no file IDs, or gives the two
  // files one, no case below could tell a withheld inode from a real one.
  const twoFiles = (t) => {
    const dir = makeProject(t, { "inside.bin": "in" });
    const inside = path.join(dir, "inside.bin");
    const outside = path.join(
      makeProject(t, { "outside.bin": "out" }),
      "outside.bin",
    );
    const realIn = fs.statSync(inside, { bigint: true }).ino;
    const realOut = fs.statSync(outside, { bigint: true }).ino;
    if (realIn === 0n || realOut === 0n || realIn === realOut) {
      t.skip(
        `this volume gives no distinct file IDs (inside ${realIn}, outside ${realOut})`,
      );
      return null;
    }
    return {
      dir,
      inside,
      outside,
      real: { big: String(realOut), num: Number(realOut) },
    };
  };

  // Runs one case with the fixture armed for `dir`, and returns what the child measured.
  const measure = (dir, which, ...paths) => {
    const r = spawnSync(
      process.execPath,
      [
        "--import",
        zeroFileIds({ dir }),
        "--input-type=module",
        "-e",
        CHILD,
        "--",
        which,
        ...paths,
      ],
      { encoding: "utf8" },
    );
    assert.equal(
      r.status,
      0,
      `the ${which} case must run\n${r.stdout}\n${r.stderr}`,
    );
    assert.match(
      r.stderr,
      ZERO_FILE_IDS_ARMED,
      `the fixture must be armed for ${dir}\n${r.stderr}`,
    );
    return JSON.parse(r.stdout);
  };
  const ZERO = { big: "0", num: 0 };

  test("zeroFileIds_statByPath_reportsInodeZeroInsideAndTheRealInodeOutside", (t) => {
    const files = twoFiles(t);
    if (files === null) return;
    const { dir, inside, outside, real } = files;

    const m = measure(dir, "paths", inside, outside);

    assert.deepEqual(
      m.inside,
      { lstat: ZERO, stat: ZERO },
      "by path: a file inside must report inode 0",
    );
    assert.deepEqual(
      m.outside,
      { lstat: real, stat: real },
      "by path: a file outside must report its real inode",
    );
  });

  test("zeroFileIds_statThroughALinkInsideToAFileOutside_reportsInodeZero", (t) => {
    // The name asked about is inside, wherever it points.
    const files = twoFiles(t);
    if (files === null) return;
    const { dir, inside, outside, real } = files;
    const link = path.join(dir, "link.bin");
    if (!tryMakeFileLink(link, outside))
      return t.skip("platform refused to create a file link");
    assert.equal(
      String(fs.statSync(link, { bigint: true }).ino),
      real.big,
      "unarmed, the link must lead to the file outside",
    );

    const m = measure(dir, "link", inside, outside, link);

    assert.deepEqual(
      m,
      ZERO,
      "by path: stat through a link inside must report inode 0, though the file it leads to is outside",
    );
  });

  test("zeroFileIds_fstatOfADescriptorOpenSyncOpenedInside_reportsInodeZero", (t) => {
    const files = twoFiles(t);
    if (files === null) return;
    const { dir, inside, outside } = files;

    const m = measure(dir, "c1", inside, outside);

    assert.deepEqual(
      m,
      ZERO,
      "c1: fstatSync of a descriptor fs.openSync opened inside must report inode 0",
    );
  });

  test("zeroFileIds_fstatOfADescriptorOpenSyncOpenedOutside_reportsTheRealInode", (t) => {
    const files = twoFiles(t);
    if (files === null) return;
    const { dir, inside, outside, real } = files;

    const m = measure(dir, "c2", inside, outside);

    assert.deepEqual(
      m,
      real,
      "c2: fstatSync of a descriptor fs.openSync opened outside must report its real inode",
    );
  });

  test("zeroFileIds_fstatOfANumberCloseSyncClosedInsideThenAsyncOpenReopenedOutside_reportsTheRealInode", (t) => {
    const files = twoFiles(t);
    if (files === null) return;
    const { dir, inside, outside, real } = files;

    const { closed, reopened, ...m } = measure(dir, "c3", inside, outside);
    if (reopened !== closed)
      return t.skip(
        `descriptor ${closed} was not reused (reopened as ${reopened})`,
      );

    assert.deepEqual(
      m,
      real,
      "c3: fs.closeSync must drop the entry for the number it closes, so a file outside reopened under that number reports its real inode",
    );
  });

  test("zeroFileIds_fstatOfANumberAsyncCloseClosedInsideThenOpenSyncReopenedOutside_reportsTheRealInode", (t) => {
    const files = twoFiles(t);
    if (files === null) return;
    const { dir, inside, outside, real } = files;

    const { closed, reopened, ...m } = measure(dir, "c4", inside, outside);
    if (reopened !== closed)
      return t.skip(
        `descriptor ${closed} was not reused (reopened as ${reopened})`,
      );

    assert.deepEqual(
      m,
      real,
      "c4: fs.openSync must drop the entry for a number it returns for a path outside, so that file reports its real inode",
    );
  });
});
