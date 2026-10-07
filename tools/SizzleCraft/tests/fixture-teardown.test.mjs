// --------------------------------------------------------------------------------------
// TEST CLEANUP MUST NOT FAIL A TEST THAT PASSED.
//
// Measured, under 12 concurrent ffmpeg encodes on Windows, in a full-suite run that was
// otherwise green:
//
//   not ok 18 - coachPack_coachFolderItselfIsALink_refusesWithoutWritingThroughIt
//     failureType: 'hookFailed'
//     EBUSY: resource busy or locked, unlink '...\.tool-fixture-kuTT3z\src\encoder-page.html'
//     at unlinkSync -> rimrafSync
//
// The test body had already passed. The `t.after` teardown then tried to remove a fixture
// that a spawned child process still held a handle to, and Windows refused. One red test,
// in a hook, from a machine that was busy — not from anything the suite asserts.
//
// `{ force: true }` does NOT cover this. `force` suppresses ENOENT (the path is already
// gone) and nothing else; EBUSY/EPERM still throw. That is why every teardown in this
// package looked defended and was not.
//
// WHY THIS IS WORTH A FILE OF ITS OWN. A flaky cleanup is the worst shape of red there is:
// it fails a test whose subject is fine, so it teaches the reader that reds are noise. The
// repo has already paid for that lesson once -- `coach-rulings.test.mjs:667` records a
// fixture flake that "failed or passed on inter-file ordering".
//
// WHAT IS PINNED HERE, AND WHY EACH ONE EXISTS:
//   1. The retry actually fires against a REAL EBUSY, not a simulated one.
//   2. A POSITIVE CONTROL of the same shape: the identical held directory, removed without
//      the retry budget, genuinely fails. Without this, test 1 passes just as happily if
//      the directory was never locked at all -- a green that proves nothing.
//   3. Exhaustion still THROWS. A retry that gives up quietly is a swallow, and a swallow
//      here leaves fixtures accumulating inside the package while every run reports clean.
//   4. The budget is the repo's own stated self-heal convention, not a number chosen to
//      make this file pass.
//   5. A class audit: no teardown anywhere in tests/ may go back to a bare recursive rm.
//
// WINDOWS-ONLY BY NATURE. POSIX unlinks an open file happily, so there is no EBUSY to
// retry and the control in test 2 cannot fail. These skip rather than pretend elsewhere.
// --------------------------------------------------------------------------------------
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { removeFixture, FIXTURE_REMOVAL } from './_helpers.mjs';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const windowsOnly = process.platform !== 'win32' ? 'EBUSY on a held handle is Windows behaviour' : false;

/**
 * A directory a live child process is sitting in, which Windows will not let anyone remove.
 *
 * This is the real mechanism from the captured failure, not an approximation of it: the
 * coach fixtures copy `src/` and then run the engine against the copy, so a child holding
 * the fixture IS the production shape. `holdMs` is how long the child lives; the caller
 * races a removal against it.
 */
/** `assert.throws` returns undefined, so the error has to be caught to be inspected. */
function captureError(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
}

function heldDirectory(t, { holdMs, holdAt = 'root' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sizzlecraft-held-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'encoder-page.html'), '<!doctype html>');

  // `root` is what runScript produces (cwd = the fixture); `inner` is the shape of the
  // captured failure, which named a file under src/.
  const cwd = holdAt === 'root' ? dir : path.join(dir, 'src');
  const child = spawn(process.execPath, ['-e', `process.stdout.write('held'); setTimeout(() => {}, ${holdMs})`], {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  // THE CHILD ITSELF SAYS WHEN IT HOLDS THE DIRECTORY, and the first draft of this got it
  // wrong in the direction that matters. Resolving on the 'spawn' event made the removal
  // win the race against a directory nothing was holding yet: the control below reported
  // "Missing expected exception" on some runs and EBUSY on others — a flaky test inside
  // the fix for flaky tests. The OS sets a process's working directory before that
  // process runs any code, so a byte written BY the child proves the handle is held. A
  // fixed sleep would only have made the same race less likely to be noticed.
  const ready = new Promise((resolve) => child.stdout.once('data', resolve));

  t.after(() => {
    if (child.exitCode === null) child.kill();
    removeFixture(dir);
  });
  return { dir, child, ready };
}

/** This file, which the audit must skip; see suiteSources. */
const AUDIT_SELF = fileURLToPath(import.meta.url);

/**
 * Finds teardown hooks that remove a path without a retry budget.
 *
 * REGEX OVER A HOOK NAME IS NOT ENOUGH, and the reviewer was right to say so. An earlier
 * draft matched only `t.after(() => fs.rmSync(`, so a block body, a bare `after`, or an
 * `afterEach` could reintroduce the exact defect this file exists to prevent and the audit
 * would have reported clean. This scans the balanced body of every hook instead, which is
 * why the negative controls below plant each of those forms.
 */
export function bareTeardownRemovals(source) {
  const hook = /(?:^|[^.\w])(?:t\.)?(after|afterEach)\s*\(/g;
  const found = [];
  for (let m = hook.exec(source); m; m = hook.exec(source)) {
    let depth = 1;
    let i = hook.lastIndex;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') depth--;
    }
    const body = source.slice(hook.lastIndex, i);
    if (/\bfs\.rm(?:dir)?Sync\s*\(/.test(body)) found.push(`${m[1]}: ${body.trim().slice(0, 60)}`);
  }
  return found;
}

/** The suite's own sources. Generated fixture trees are deliberately excluded — see below. */
function suiteSources(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // GENERATED TREES ARE NOT SUITE SOURCE. `makeEngineCopy` creates `.engine-*` copies of
    // src/ under tests/, and another test may remove one between this walk and the read —
    // an audit that recursed into them would invent its own intermittent ENOENT, which is
    // precisely the class of defect this file was opened to remove.
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...suiteSources(full));
    // THIS FILE IS EXCLUDED, AND THAT IS A REAL LIMITATION, not a convenience. The
    // controls above are literal source text of the very forms being detected, so the
    // audit flags itself. The cost is that a bare teardown added to THIS file would not be
    // caught; the alternative — obfuscating the controls so they no longer look like the
    // thing they control for — would make them stop proving anything.
    else if (entry.name.endsWith('.mjs') && full !== AUDIT_SELF) out.push(full);
  }
  return out;
}

describe('fixture teardown survives a busy machine', () => {
  for (const holdAt of ['root', 'inner']) {
    test(`removeFixture_directoryHeldByALiveChildProcessAtThe${holdAt === 'root' ? 'Root' : 'Inner'}Path_succeedsOnceTheHandleIsReleased`, async (t) => {
      const { dir, ready } = heldDirectory(t, { holdMs: 2500, holdAt });
      await ready;

      // The handle outlives the first attempt by seconds, so this can only pass by retrying.
      removeFixture(dir);

      assert.equal(fs.existsSync(dir), false, 'the fixture must actually be gone');
    }, { skip: windowsOnly, timeout: 60_000 });

    test(`removeFixture_theSameHeldDirectoryAtThe${holdAt === 'root' ? 'Root' : 'Inner'}PathWithoutTheRetryBudget_failsWithEbusy`, async (t) => {
      // THE POSITIVE CONTROL. Identical setup, retry budget removed. If this ever passes,
      // the directory was not locked and the test above is vacuous.
      const { dir, ready } = heldDirectory(t, { holdMs: 2500, holdAt });
      await ready;

      const err = captureError(() => fs.rmSync(dir, { recursive: true, force: true }));

      assert.equal(err?.code, 'EBUSY', `the held directory must genuinely refuse removal, got ${err?.code}`);
    }, { skip: windowsOnly, timeout: 60_000 });
  }

  test('removeFixture_rootHeldDirectory_isNotCoveredByTheRuntimesOwnRetryOption', async (t) => {
    // WHY THIS PACKAGE CANNOT JUST PASS `maxRetries` TO fs.rmSync. Measured: the runtime
    // retries a busy entry INSIDE the tree, but rethrows EBUSY on the ROOT rmdir without
    // waiting at all. `runScript` spawns every engine CLI with cwd set to the fixture, so
    // the root is precisely what this suite holds. Relying on the built-in option would
    // have shipped a retry that cannot fire on the most likely case — the signature
    // failure this repo keeps paying for.
    const { dir, ready } = heldDirectory(t, { holdMs: 2500, holdAt: 'root' });
    await ready;

    // NO WALL CLOCK. An earlier draft asserted "gave up in under retryDelay ms", which the
    // reviewer correctly rejected: on the loaded machine this change is verified against,
    // scheduling delay alone can exceed 1500ms without the runtime having retried
    // anything, so the test could fail for a reason that is not the property under test.
    // This asserts the OUTCOME instead. The budget below would wait ~55s if the runtime
    // honoured it on the root, which is twenty times the 2500ms hold — so a removal that
    // still raises EBUSY can only mean the retry never happened. Nothing is timed.
    const generous = { maxRetries: 10, retryDelay: 1000 };
    const err = captureError(() => fs.rmSync(dir, { recursive: true, force: true, ...generous }));

    assert.equal(err?.code, 'EBUSY', 'the runtime must not have ridden out a hold its budget easily covered');
    assert.equal(fs.existsSync(dir), true, 'and the fixture must still be there');

    // The same hold, the same wait available, through this package's loop instead: gone.
    // That difference is the whole justification for hand-rolling the retry.
    removeFixture(dir);
    assert.equal(fs.existsSync(dir), false);
  }, { skip: windowsOnly, timeout: 60_000 });

  test('removeFixture_aHandleThatIsNeverReleased_throwsRatherThanSilentlyGivingUp', async (t) => {
    // A retry that gives up quietly is a swallow: the fixture stays on disk inside the
    // package, and every later run reports clean while the tree fills up. Exhaustion is a
    // real failure and must still reach the runner.
    const { dir, ready } = heldDirectory(t, { holdMs: 60_000 });
    await ready;

    // An explicit short budget: the point is what happens AT exhaustion, not how long the
    // shipped budget waits. The shipped values are pinned separately below.
    const err = captureError(() => removeFixture(dir, { maxRetries: 1, retryDelay: 50 }));

    assert.equal(err?.code, 'EBUSY', `exhaustion must surface the real error, got ${err?.code}`);
  }, { skip: windowsOnly, timeout: 60_000 });

  test('removeFixture_aFailureNothingCanRelease_isRaisedImmediatelyRatherThanWaitedOut', () => {
    // Not every error is a busy handle. Waiting out a failure no amount of time can clear
    // would turn a clear fault into a slow one, so only the releasable codes are retried.
    //
    // THE FIRST DRAFT OF THIS TEST WAS WRONG AND THE RUN SAID SO. It used a path whose
    // parent is a file, assuming ENOTDIR; measured, that path raises ENOENT, which
    // `force: true` suppresses entirely — the call did not throw at all. A bad argument is
    // the honest version: a failure that is categorically not a handle anyone will release.
    // NO WALL CLOCK HERE EITHER, for the reason given above. The budget is set so that a
    // single retry would take ten minutes: if this returns at all, the loop did not retry.
    // The test timeout is the bound, not a measured duration.
    const err = captureError(() => removeFixture(123, { maxRetries: 3, retryDelay: 600_000 }));

    assert.equal(err?.code, 'ERR_INVALID_ARG_TYPE');
  }, { timeout: 10_000 });

  test('fixtureRemoval_theRetryBudget_mirrorsTheRepoSelfHealConvention', () => {
    // NOT A NUMBER PICKED TO MAKE THIS FILE PASS. voice.mjs:300-315 is the repo's stated
    // shape for a bounded self-heal over a transient failure: four attempts, linear
    // backoff of 1500ms * attempt, ~9s total, then fail honestly. One attempt plus three
    // retries at 1500ms is that same convention.
    assert.deepEqual(
      FIXTURE_REMOVAL,
      { maxRetries: 3, retryDelay: 1500 },
      'changing this is changing how long every teardown tolerates a busy machine',
    );
  });

  test('theTeardownAudit_detectsEveryHookFormItClaimsToCover', () => {
    // THE AUDIT'S OWN POSITIVE CONTROL. An audit that reports clean because it cannot see
    // the defect is worse than no audit: it certifies the thing it failed to look at. Each
    // of these is a form the first draft of the detector missed.
    const offenders = {
      'arrow, immediate': `t.after(() => fs.rmSync(dir, { recursive: true, force: true }));`,
      'arrow, block body': `t.after(() => {\n  fs.rmSync(dir, { recursive: true });\n});`,
      'bare after': `after(() => fs.rmSync(dir, { force: true }));`,
      afterEach: `afterEach(() => { fs.rmSync(dir, { recursive: true }); });`,
      rmdirSync: `t.after(() => fs.rmdirSync(dir, { recursive: true }));`,
    };
    for (const [form, src] of Object.entries(offenders)) {
      assert.equal(bareTeardownRemovals(src).length, 1, `the audit must catch: ${form}`);
    }

    // And must not accuse the correct idiom, or a removal that is not a teardown at all.
    assert.deepEqual(bareTeardownRemovals(`t.after(() => removeFixture(dir));`), []);
    assert.deepEqual(bareTeardownRemovals(`t.after(() => {\n  child.kill();\n  removeFixture(dir);\n});`), []);
    assert.deepEqual(bareTeardownRemovals(`const err = captureError(() => fs.rmSync(dir, { force: true }));`), []);
  });

  test('everyTeardownInTheSuite_goesThroughTheRetryingRemoval', () => {
    // THE CLASS, NOT THE INSTANCE. coach-pack was the one that failed under load, but
    // every teardown that removes a directory a child may hold has the same defect. A new
    // one must not be able to reintroduce it quietly.
    const offenders = [];
    for (const file of suiteSources(TESTS_DIR)) {
      for (const hit of bareTeardownRemovals(fs.readFileSync(file, 'utf8'))) {
        offenders.push(`${path.relative(TESTS_DIR, file).split(path.sep).join('/')} — ${hit}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      'these remove a fixture in teardown without a retry budget, so a handle Windows has ' +
        'not released yet fails a test that already passed. Use removeFixture() from _helpers.mjs.',
    );
  });
});
