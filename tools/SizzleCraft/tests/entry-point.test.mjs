// ---------------------------------------------------------------------------
// "Am I the entry point?" must not be answered by comparing path strings.
//
// Three modules in this engine export functions AND run as CLIs, so each needs to know
// whether it was executed or imported. Each had answered that question with its own
// string comparison, and all three were wrong in the same way:
//
//   coach-rulings.mjs   path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
//   audio-probe.mjs     import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
//   canonical-json.mjs  import.meta.url === pathToFileURL(process.argv[1]).href
//
// Node leaves the spelling the caller used in `process.argv[1]` but resolves
// `import.meta.url` through to the real file. So any path that reaches the same file by a
// different spelling makes all three comparisons false, the CLI block never runs, and the
// tool EXITS 0 HAVING DONE NOTHING. For a validator or a hashing backbone, a failure mode
// indistinguishable from a clean pass is the worst one available.
//
// Measured before the fix, all three, invoked through a directory junction:
//   exit 0, zero bytes of output, on `--help`.
//
// WHY A JUNCTION AND NOT A CASE-FLIPPED PATH. A case-flipped path does NOT reproduce this.
// Node keeps the given spelling in BOTH argv[1] and import.meta.url, so the comparison
// matches and a case-flip test passes against the live defect — a control that cannot
// fail. That was shipped once in this domain and caught only by neutering it. A junction
// is the cheapest spelling Node genuinely resolves differently on the two sides.
//
// WHAT THIS FILE DOES NOT COVER: it pins the decision and the three call sites. It does
// not prove the three CLIs are correct in any other respect, and it says nothing about
// modules that are not dual-purpose.
// ---------------------------------------------------------------------------
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isEntryPoint } from '../src/cli-support.mjs';

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * Runs `fn` with a directory junction pointing at src/, and removes it afterwards.
 *
 * The link's lifetime is a try/finally rather than a t.after hook, and removal is
 * NON-RECURSIVE on purpose: fs.rmdirSync takes the reparse point away and leaves the
 * target alone. A recursive remove aimed at a junction can follow it and empty the real
 * src/ — this domain destroyed a node_modules exactly that way. A junction is a reparse
 * point rather than an open handle, so it has none of the EBUSY exposure that the
 * retrying removal in fixture-teardown.test.mjs exists to absorb.
 */
function withSrcJunction(t, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sizzlecraft-entry-'));
  const link = path.join(dir, 'src');
  try {
    fs.symlinkSync(SRC_DIR, link, 'junction');
  } catch {
    t.skip('could not create a directory junction on this platform');
    return null;
  }
  try {
    return fn(link);
  } finally {
    try {
      fs.unlinkSync(link);
    } catch {
      fs.rmdirSync(link);
    }
    fs.rmdirSync(dir);
  }
}

const DUAL_PURPOSE_CLIS = ['audio-probe.mjs', 'canonical-json.mjs', 'coach-rulings.mjs'];

describe('entry-point detection: identity, not spelling', () => {
  for (const script of DUAL_PURPOSE_CLIS) {
    test(`${script}_invokedThroughAJunction_stillRunsItsCli`, (t) => {
      withSrcJunction(t, (link) => {
        const direct = spawnSync(process.execPath, [path.join(SRC_DIR, script), '--help'], {
          encoding: 'utf8',
          timeout: 60_000, input: '',
        });
        const viaLink = spawnSync(process.execPath, [path.join(link, script), '--help'], {
          encoding: 'utf8',
          timeout: 60_000, input: '',
        });

        // The control: --help must genuinely produce something by the ordinary path, or
        // "produced nothing via the junction" would prove nothing about the junction.
        const directOut = (direct.stdout ?? '') + (direct.stderr ?? '');
        assert.ok(
          directOut.trim().length > 0,
          `${script} --help produced no output even by its real path, so this test cannot ` +
            `discriminate. Fix the control before trusting the case below.`,
        );

        // THE DEFECT. Not just a non-zero exit — the tool exits 0 and does NOTHING, so the
        // work itself has to be asserted.
        const linkOut = (viaLink.stdout ?? '') + (viaLink.stderr ?? '');
        assert.ok(
          linkOut.trim().length > 0,
          `${script} invoked through a junction produced NO output and exited ` +
            `${viaLink.status}. The CLI block did not run: an "am I the entry point?" ` +
            `check rejected a spelling that reaches the same file.`,
        );
        assert.equal(
          linkOut.trim(),
          directOut.trim(),
          `${script} behaved differently depending on how its path was spelled`,
        );
      });
    });
  }

  test('importingCliSupport_doesNotExecuteAnyCliInItsImportGraph', () => {
    // Why this test exists, in its own right: cli-support.mjs imports canonicalBytes from
    // canonical-json.mjs, which is ALSO a CLI — and that CLI reads stdin. If its
    // entry-point check ever answers true on import, every module that imports
    // cli-support (which is all of them) blocks forever on fd 0.
    //
    // I measured that. Mutating isEntryPoint to `return true` did not fail the suite — it
    // HUNG it, at import, before a single test ran, so no per-test timeout could catch it.
    // A regression that hangs is worse than one that fails, and this repo has been bitten
    // by a blocking call bounded only by a timeout it cannot interrupt before.
    //
    // Running it in a child with stdin already at EOF bounds THIS check: a CLI that runs
    // on import and prints, or one that blocks, is caught here as a failure rather than a
    // hang.
    //
    // HONEST LIMIT, measured and not argued away: this test does NOT kill the
    // `isEntryPoint = () => true` mutant. Under that mutant the test runner itself blocks
    // while importing this very file, before any test executes, so the suite hangs and
    // reports nothing — I tried feeding the runner EOF stdin and it hung anyway, because
    // the per-file child's stdin is a pipe that is never closed. What kills always-true is
    // `isEntryPoint_forAModuleThatIsOnlyImported_isFalse` BELOW, and only when the blocking
    // module is not in the runner's own import graph. A reviewer should treat
    // "always-true" as detected-by-hang, not detected-by-assertion.
    const target = pathToFileURL(path.join(SRC_DIR, 'cli-support.mjs')).href;
    const r = spawnSync(
      process.execPath,
      ['-e', `import(${JSON.stringify(target)}).then(() => console.log('IMPORTED-CLEANLY'))`],
      { encoding: 'utf8', timeout: 60_000, input: '' },
    );
    const out = (r.stdout ?? '') + (r.stderr ?? '');
    assert.ok(
      !r.error || r.error.code !== 'ETIMEDOUT',
      `importing cli-support.mjs did not finish — a CLI in its import graph is running on ` +
        `import and blocking\n${out}`,
    );
    assert.match(out, /IMPORTED-CLEANLY/, `importing cli-support.mjs failed\n${out}`);
    assert.equal(
      out.replace(/IMPORTED-CLEANLY\s*/, '').trim(),
      '',
      `importing cli-support.mjs produced CLI output — a module in its import graph ran ` +
        `its CLI on import\n${out}`,
    );
  });

  test('isEntryPoint_forTheFileNodeActuallyExecuted_isTrue', () => {
    // The positive control for the two tests below. Without it, an isEntryPoint that
    // always returned false would satisfy both of them — and would also silently disable
    // every CLI in the engine, which is the exact failure this task exists to remove.
    //
    // `node --test` executes each test file as the entry point, so argv[1] IS this file.
    // That is measured, not assumed: asserting the opposite here is what first told me so.
    assert.equal(
      isEntryPoint(import.meta.url),
      true,
      'node --test runs this file as the entry point, so isEntryPoint must say so',
    );
  });

  test('isEntryPoint_forAModuleThatIsOnlyImported_isFalse_soTheCliDoesNotRun', (t) => {
    // The other direction, and the one that keeps these guards worth having at all: a
    // module that is IMPORTED must not run its CLI. Without this, a "fix" that simply
    // returned true would pass every junction test above.
    //
    // Note the construction. The obvious version — calling isEntryPoint(import.meta.url)
    // from inside this test file — asserts the opposite of the truth: `node --test` runs
    // each test file AS the entry point, so argv[1] IS this file and true is the correct
    // answer. I wrote that test first and it failed, which is how I learned it. A real
    // importer process is the only shape that actually exercises the imported case.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sizzlecraft-import-'));
    try {
      const importer = path.join(dir, 'importer.mjs');
      const target = pathToFileURL(path.join(SRC_DIR, 'coach-rulings.mjs')).href;
      fs.writeFileSync(importer, `await import(${JSON.stringify(target)});\nconsole.log('IMPORT-OK');\n`);

      const r = spawnSync(process.execPath, [importer], { encoding: 'utf8', timeout: 60_000, input: '' });
      const out = (r.stdout ?? '') + (r.stderr ?? '');

      // Control first: the import itself has to have happened, or "no CLI output" would be
      // satisfied by a module that failed to load at all.
      assert.match(out, /IMPORT-OK/, `the importer did not complete, so this proves nothing\n${out}`);
      assert.equal(r.status, 0, `importing a dual-purpose module must not fail\n${out}`);
      // coach-rulings' CLI refuses without --report, so if the CLI ran we would see that.
      assert.ok(
        !/--report is required/.test(out),
        `importing the module RAN ITS CLI — the entry-point check answered true for a ` +
          `module that was merely imported\n${out}`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('isEntryPoint_whenThereIsNoEntryPointAtAll_isFalseRatherThanThrowing', () => {
    // `node -e` and the REPL leave argv[1] undefined. Throwing there would turn an
    // importable module into one that cannot be loaded at all in those contexts.
    const target = pathToFileURL(path.join(SRC_DIR, 'cli-support.mjs')).href;
    const probe = spawnSync(
      process.execPath,
      ['-e', `import(${JSON.stringify(target)}).then(m => console.log(String(m.isEntryPoint(${JSON.stringify(target)}))))`],
      { encoding: 'utf8', timeout: 60_000, input: '' },
    );
    assert.equal(
      (probe.stdout ?? '').trim(),
      'false',
      `isEntryPoint must answer false, not throw, when there is no entry point.\n` +
        `stdout: ${probe.stdout}\nstderr: ${probe.stderr}`,
    );
  });

  test('everyDualPurposeModule_asksTheQuestionThroughTheSharedHelper', () => {
    // The consolidation half. Three spellings of one broken question is the duplication
    // this sweep exists to remove, so a fourth must not appear quietly. This fails if any
    // src module grows its own argv[1] comparison again.
    const offenders = [];
    for (const name of fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.mjs'))) {
      const body = fs.readFileSync(path.join(SRC_DIR, name), 'utf8');
      // cli-support.mjs is where the one honest answer lives.
      if (name === 'cli-support.mjs') continue;
      if (/process\.argv\[1\]/.test(body)) offenders.push(name);
    }
    assert.deepEqual(
      offenders,
      [],
      `these modules compare process.argv[1] themselves instead of calling isEntryPoint ` +
        `from cli-support.mjs: ${offenders.join(', ')}`,
    );
  });
});
