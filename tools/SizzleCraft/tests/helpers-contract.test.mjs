// The shared test helpers are themselves load-bearing: assertCleanExit guards roughly 356 call
// sites across ten test files, and its whole purpose is to catch the case `assert.notEqual(code, 0)`
// misses — a script that exits with the right-looking code AND prints a stack. A hole in it does not
// fail a test; it silently stops a whole class of defect from being seen. Its own comment says "that
// is how one of these defects survived a round", so these tests pin the helper against the frame
// shapes Node actually emits.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { fileURLToPath } from 'node:url';

import { assertCleanExit, fixtureUrl } from './_helpers.mjs';

const ran = (code, all) => ({ code, all });

describe('assertCleanExit sees every stack frame shape, not only parenthesised ones', () => {
  // Node emits a frame WITHOUT parentheses when the throw is at module top level, which is exactly
  // where a CLI's argument handling and its first file reads live — the most likely place for an
  // uncaught crash in this engine, and the shape the original assertion could not see.
  const FRAMES = {
    ATopLevelEsmFrame: 'error: boom\n    at file:///C:/dev/x/voice.mjs:239:28\n',
    APosixTopLevelFrame: 'error: boom\n    at /home/u/x.mjs:12:3\n',
    ARelativePathFrame: 'error: boom\n    at ./src/voice.mjs:5:1\n',
    AParenthesisedFrame: 'error: boom\n    at refuse (file:///C:/dev/x/voice.mjs:94:9)\n',
    ANodeInternalFrame: 'error: boom\n    at ModuleJob.run (node:internal/modules/esm/module_job:271:25)\n',
    AnAsyncFrame: 'error: boom\n    at async ModuleJob.run (node:internal/modules/esm/module_job:271:25)\n',
  };

  for (const [scenario, output] of Object.entries(FRAMES)) {
    test(`assertCleanExit_outputCarrying${scenario}_isRefusedAsAnUncaughtStack`, () => {
      assert.throws(
        () => assertCleanExit(ran(2, output), 2),
        /uncaught stack trace/,
        'a stack in the output must fail the assertion whatever shape the frame takes',
      );
    });
  }

  // The positive controls. Without these, an assertion that threw unconditionally would satisfy
  // every row above — the helper would "detect" stacks by failing everything, and every refusal test
  // in the suite would turn red for the wrong reason.
  const CLEAN = {
    APlainRefusal: 'error: brand/tokens.json is missing — run build-brand first\n',
    APathInNormalOutput: 'wrote C:/dev/x/out.mp4\n',
    NoOutputAtAll: '',
  };

  for (const [scenario, output] of Object.entries(CLEAN)) {
    test(`assertCleanExit_outputCarrying${scenario}_isAccepted`, () => {
      assert.doesNotThrow(() => assertCleanExit(ran(2, output), 2));
    });
  }

  // A handled refusal is free to print a time, and a time has the same colon-number-colon-number
  // shape as a frame's line and column. Pinned because the obvious widening — anything ending in
  // `:n:n` — accepts `at 10:30:00` as a stack frame and would fail honest tests. A frame's location
  // always carries a path separator or a `node:` scheme; a clock does not.
  const CLOCKS = {
    ABareClockAtLineEnd: 'rendering\n    at 10:30:00\n',
    ADurationAtLineEnd: 'finished at 1:02:03\n',
  };

  for (const [scenario, output] of Object.entries(CLOCKS)) {
    test(`assertCleanExit_outputCarrying${scenario}_isNotMistakenForAStack`, () => {
      assert.doesNotThrow(() => assertCleanExit(ran(2, output), 2));
    });
  }

  // The two halves are independent: the code check must still fire on its own, so widening the stack
  // check cannot quietly become the only thing the helper tests.
  test('assertCleanExit_theWrongExitCodeWithCleanOutput_isStillRefused', () => {
    assert.throws(() => assertCleanExit(ran(1, 'error: refused\n'), 2), /expected exit 2, got 1/);
  });
});

// Every preload is armed by the query string of this URL alone, so its shape is the contract.
describe('fixtureUrl builds the --import URL a preload is armed by', () => {
  test('fixtureUrl_givenOnlyAName_isTheBareFileUrlOfThatFixture', () => {
    const url = new URL(fixtureUrl('fake-audio.mjs'));
    assert.equal(url.search, '', 'a preload with no settings must not carry a "?"');
    assert.match(fileURLToPath(url), /[\\/]tests[\\/]fixtures[\\/]fake-audio\.mjs$/);
  });

  test('fixtureUrl_givenSettingsWithReservedCharacters_roundTripsThemThroughTheQueryString', () => {
    const settings = { dir: 'C:\\a b\\c&d=e', fragment: 'x?y#z' };
    const params = new URL(fixtureUrl('fail-close.mjs', settings)).searchParams;
    assert.deepEqual(Object.fromEntries(params), settings);
  });

  test('fixtureUrl_givenARepeatedKeyAsPairs_keepsEveryValueInOrder', () => {
    const params = new URL(fixtureUrl('fail-lstat.mjs', [['dir', 'd'], ['name', 'a'], ['name', 'b']])).searchParams;
    assert.deepEqual(params.getAll('name'), ['a', 'b']);
    assert.equal(params.get('dir'), 'd');
  });
});