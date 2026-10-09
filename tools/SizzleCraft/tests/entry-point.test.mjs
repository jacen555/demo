// "Am I the entry point?" must not be answered by comparing path strings.
//
// Three modules both export functions and run as CLIs. Each compared path spellings
// (path.resolve vs fileURLToPath; endsWith; pathToFileURL().href). Node keeps the caller's
// spelling in process.argv[1] but resolves import.meta.url through links, so invoked
// through a directory junction all three comparisons were false: the CLI block was skipped
// and the tool exited 0 with no output.
//
// A case-flipped path does NOT reproduce this (both sides keep the given spelling), so a
// case-flip test cannot fail against the defect. These tests use a real junction.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isEntryPoint } from '../src/entry-point.mjs';

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const DUAL_PURPOSE_CLIS = ['audio-probe.mjs', 'canonical-json.mjs', 'coach-rulings.mjs'];

const run = (args, input = '') =>
  spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60_000, input });
const output = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}`;

/**
 * Runs `fn` with a directory junction to src/. Removal is non-recursive (unlink/rmdir):
 * a recursive remove aimed at a junction can follow it and empty the real src/.
 */
function withSrcJunction(t, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sizzlecraft-entry-'));
  const link = path.join(dir, 'src');
  try {
    fs.symlinkSync(SRC_DIR, link, 'junction');
  } catch {
    t.skip('could not create a directory junction on this platform');
    return;
  }
  try {
    fn(link);
  } finally {
    try {
      fs.unlinkSync(link);
    } catch {
      fs.rmdirSync(link);
    }
    fs.rmdirSync(dir);
  }
}

describe('entry-point detection: identity, not spelling', () => {
  for (const script of DUAL_PURPOSE_CLIS) {
    test(`${script}_invokedThroughAJunction_stillRunsItsCli`, (t) => {
      withSrcJunction(t, (link) => {
        const direct = run([path.join(SRC_DIR, script), '--help']);
        const viaLink = run([path.join(link, script), '--help']);

        // Positive control: the real path must print something, or silence via the
        // junction would prove nothing.
        assert.ok(output(direct).trim().length > 0, `${script} --help printed nothing by its real path`);
        assert.equal(
          output(viaLink).trim(),
          output(direct).trim(),
          `${script} through a junction (exit ${viaLink.status}) did not behave as it does by its real path`,
        );
      });
    });
  }

  test('canonicalJson_invokedThroughAJunction_performsItsWork', (t) => {
    // --help only shows the block ran; this shows the work happened.
    withSrcJunction(t, (link) => {
      const input = '{"b":1,"a":2}';
      const direct = run([path.join(SRC_DIR, 'canonical-json.mjs')], input);
      const viaLink = run([path.join(link, 'canonical-json.mjs')], input);
      assert.equal(direct.status, 0, output(direct));
      assert.match(direct.stdout, /"a":2,"b":1/, 'control: the real path must canonicalise the input');
      assert.equal(viaLink.stdout, direct.stdout);
    });
  });

  test('isEntryPoint_forTheFileNodeExecuted_isTrue', () => {
    // node --test runs each test file as the entry point. Also the positive control that
    // an always-false helper would fail.
    assert.equal(isEntryPoint(import.meta.url), true);
  });

  test('isEntryPoint_forAMerelyImportedModule_isFalse', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sizzlecraft-import-'));
    try {
      const importer = path.join(dir, 'importer.mjs');
      const lines = DUAL_PURPOSE_CLIS.map(
        (f) => `await import(${JSON.stringify(pathToFileURL(path.join(SRC_DIR, f)).href)});`,
      );
      fs.writeFileSync(importer, `${lines.join('\n')}\nconsole.log('IMPORT-OK');\n`);
      const r = run([importer]);
      // Importing must complete without any CLI running (a CLI reading stdin or
      // demanding arguments would show up as extra output or a non-zero exit).
      assert.equal(r.status, 0, output(r));
      assert.equal(output(r).trim(), 'IMPORT-OK');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('isEntryPoint_whenThereIsNoEntryScript_isFalse', () => {
    const target = JSON.stringify(pathToFileURL(path.join(SRC_DIR, 'entry-point.mjs')).href);
    const r = run(['-e', `import(${target}).then((m) => console.log(String(m.isEntryPoint(${target}))))`]);
    assert.equal(r.stdout.trim(), 'false', output(r));
  });

  test('isEntryPoint_whenAFileCannotBeStatted_isFalseRatherThanThrowingOrMatchingNulls', () => {
    const missing = path.join(os.tmpdir(), 'sizzlecraft-does-not-exist.mjs');
    const probe = (entry, url) => {
      const mod = JSON.stringify(pathToFileURL(path.join(SRC_DIR, 'entry-point.mjs')).href);
      const code = `import(${mod}).then((m) => { process.argv[1] = ${JSON.stringify(entry)}; console.log(String(m.isEntryPoint(${JSON.stringify(url)}))); })`;
      return run(['-e', code]);
    };
    const real = pathToFileURL(path.join(SRC_DIR, 'entry-point.mjs')).href;
    assert.equal(probe(missing, real).stdout.trim(), 'false', 'unstattable argv[1]');
    assert.equal(probe(path.join(SRC_DIR, 'entry-point.mjs'), pathToFileURL(missing).href).stdout.trim(), 'false', 'unstattable caller');
    assert.equal(probe(missing, pathToFileURL(missing).href).stdout.trim(), 'false', 'both unstattable must not compare equal');
    // Control: the same harness answers true when both sides are the same real file.
    assert.equal(probe(path.join(SRC_DIR, 'entry-point.mjs'), real).stdout.trim(), 'true');
  });

  test('entryPointModule_importsOnlyNodeBuiltins_soNoCycleIsPossible', () => {
    // cli-support.mjs and canonical-json.mjs already import each other; the helper must
    // stay outside that cycle.
    const body = fs.readFileSync(path.join(SRC_DIR, 'entry-point.mjs'), 'utf8');
    const specifiers = [...body.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    assert.ok(specifiers.length > 0);
    assert.deepEqual(specifiers.filter((s) => !s.startsWith('node:')), []);
  });

  test('srcModules_otherThanTheHelper_doNotCompareProcessArgv1Themselves', () => {
    const offenders = fs
      .readdirSync(SRC_DIR)
      .filter((f) => f.endsWith('.mjs') && f !== 'entry-point.mjs')
      .filter((f) => /process\.argv\[1\]/.test(fs.readFileSync(path.join(SRC_DIR, f), 'utf8')));
    assert.deepEqual(offenders, []);
  });
});
