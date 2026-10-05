// voice.mjs refusals — every way this stage can stop, and how it reports stopping.
//
// WHY THIS FILE EXISTS
//
// voice.mjs had ten places where it ended by THROWING: nine bare `throw new Error(...)`
// and one unguarded `JSON.parse(fs.readFileSync(...))` on brand/tokens.json. All ten
// surfaced as an uncaught exception with a stack trace, and exited 1 only because that is
// Node's default for an uncaught throw — not because anything chose 1.
//
// That matters here more than in most stages. voice.mjs calls a network TTS service and
// rewrites the approved timeline, and MEASURED, two of those throws fired after
// irreversible writes: the C-10 fit gate after every clip was on disk, and the end-card
// check after voiceover.mp3 had been written over.
//
// THE CONTRACT IS THE FILE'S OWN. voice.mjs's USAGE header already publishes it:
//   "Exit codes: 0 success/plan · 1 synthesis failed · 2 bad usage, a refused timeline or
//    a refused overwrite"
// Nothing here invents a code. These tests pin the stage to the header it already ships,
// which the code did not obey. `assertCleanExit` asserts the code AND that no stack trace
// escaped — the second half is the point, since a crash already exited non-zero.
//
// NOT COVERED HERE, deliberately, and both are reported rather than hidden:
//   - The end-card/builderVersion throw. It fires after voiceover.mp3 is overwritten and
//     is the defect a parallel stream is fixing; touching it would collide.
//   - The C-6 drift throw. `normalizeEndCardFields` (end-card.mjs:29) ALWAYS overwrites
//     `timing.durationMs` immediately before the comparison, so an authored value cannot
//     reach it. No input I could construct makes it fire.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { EXIT } from '../src/cli-support.mjs';
import { makeProject, makeOutsideDir, runScript, assertCleanExit, tryMakeFileLink, FAKE_AUDIO, brandTokens } from './_helpers.mjs';

/** Two narrated segments whose windows comfortably fit the fake service's output. */
const narrated = () => [
  { id: 'one', startMs: 0, endMs: 3000, voiceoverText: 'Hello there friend.' },
  { id: 'two', startMs: 3000, endMs: 6000, voiceoverText: 'Second segment here now.' },
];

function timingJson({ segments = narrated(), intake = {}, ...rest } = {}) {
  return JSON.stringify({
    project: { name: 'probe', fps: 30, width: 1920, height: 1080 },
    endCard: { enabled: false },
    intake: {
      leadInMs: 2000, perceivedGapMs: 2000, toleranceMs: 750, silenceMs: 2000,
      voice: 'en-US-AvaNeural', speed: 1, ...intake,
    },
    segments,
    ...rest,
  }, null, 2);
}

/** A project that voice.mjs can run to completion, unless a case breaks one thing. */
const project = (t, { timing = timingJson(), tokens = brandTokens } = {}) =>
  makeProject(t, tokens === null ? { 'timing.json': timing } : { 'timing.json': timing, 'brand/tokens.json': tokens });

/** Runs the real CLI with the fake TTS service and audio decoder. */
const voice = (dir, args = ['--apply', '--replace']) =>
  runScript('voice.mjs', ['--project', dir, ...args], dir, { nodeArgs: ['--import', FAKE_AUDIO] });

/**
 * A stack frame in either shape Node emits.
 *
 * `assertCleanExit` in _helpers.mjs matches `/^\s*at .*\(.*:\d+:\d+\)/m`, which REQUIRES
 * parentheses. A throw at the top level of an ESM module produces
 * `    at file:///C:/.../voice.mjs:239:28` — no parentheses — so that regex does not match
 * it, and a test using `assertCleanExit` alone passes against a full crash dump.
 *
 * MEASURED: `segmentOverrunningItsWindow_isReportedAsAFitFailure` passed against the
 * unfixed source for exactly this reason, while the real output carried the source line,
 * a caret, the Error, the frame and Node's version trailer.
 *
 * This is a hole in a SHARED helper, reported to its owner rather than patched here —
 * _helpers.mjs is outside this task's file scope.
 */
const STACK_FRAME = /^\s*at\s+\(?(?:file:\/\/|[A-Za-z]:\\|\/)\S*:\d+:\d+\)?/m;

/** Exited with the documented code, and did NOT crash to get there. */
function assertRefused(r, expected, message = '') {
  assertCleanExit(r, expected, message);
  assert.doesNotMatch(r.all, STACK_FRAME, `${message}a stack frame escaped\n${r.all}`);
  assert.doesNotMatch(r.all, /^Node\.js v\d/m, `${message}Node's uncaught-exception trailer escaped\n${r.all}`);
}

const filesIn = (dir) => fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isFile()).sort();

describe('voice.mjs · the control, without which nothing below is readable', () => {
  test('cleanProject_apply_succeedsAndWritesTheVoiceTrack', (t) => {
    // THE POSITIVE CONTROL. Every refusal test below asserts a non-zero exit, and a
    // non-zero exit is trivially achievable by breaking the harness instead of the input.
    // If this row is not green, every other row in this file is unreadable.
    const dir = project(t);
    const r = voice(dir);
    assertCleanExit(r, EXIT.OK);
    assert.ok(filesIn(dir).includes('voiceover.mp3'), `the control must actually produce audio\n${r.all}`);
  });

  test('cleanProject_plan_writesNothing', (t) => {
    const dir = project(t);
    const before = filesIn(dir);
    const r = voice(dir, []);
    assertCleanExit(r, EXIT.OK);
    assert.deepEqual(filesIn(dir), before, `the safe default must write nothing\n${r.all}`);
  });
});

describe('voice.mjs · the brand allow-list (C-11) refuses rather than crashes', () => {
  // All four of these are "a missing prerequisite" in cli-support's words, so they are
  // USAGE(2) under the header voice.mjs already publishes. All four crashed before.

  test('brandTokensMissing_isRefusedNotCrashed', (t) => {
    // The one that was not a `throw` at all: `JSON.parse(fs.readFileSync(...))` on a file
    // that is not there raises an uncaught ENOENT, with a stack and an absolute path.
    const dir = project(t, { tokens: null });
    const r = voice(dir);
    assertRefused(r, EXIT.USAGE);
    assert.doesNotMatch(r.all, /ENOENT/, `the raw filesystem error escaped\n${r.all}`);
    assert.match(r.all, /brand[\\/]tokens\.json/, `the refusal must name the file it needs\n${r.all}`);
  });

  test('brandTokensUnparseable_isRefusedNotCrashed', (t) => {
    const dir = project(t, { tokens: '{ not json' });
    const r = voice(dir);
    assertRefused(r, EXIT.USAGE);
    assert.doesNotMatch(r.all, /SyntaxError/, `the raw parse error escaped\n${r.all}`);
  });

  test('brandTokensWithAnEmptyVoiceList_isRefusedNotCrashed', (t) => {
    const dir = project(t, { tokens: JSON.stringify({ audio: { ttsVoices: [] } }) });
    assertRefused(voice(dir), EXIT.USAGE);
  });

  test('brandTokensWithNoVoiceList_isRefusedNotCrashed', (t) => {
    const dir = project(t, { tokens: JSON.stringify({ audio: {} }) });
    assertRefused(voice(dir), EXIT.USAGE);
  });

  test('voiceNotOnTheAllowList_isRefusedAndNamesBothSides', (t) => {
    const dir = project(t, { timing: timingJson({ intake: { voice: 'en-GB-SoniaNeural' } }) });
    const r = voice(dir);
    assertRefused(r, EXIT.USAGE);
    assert.match(r.all, /en-GB-SoniaNeural/, `name the voice that was asked for\n${r.all}`);
    assert.match(r.all, /en-US-AvaNeural/, `and what is permitted, or the remedy is a guess\n${r.all}`);
  });

  test('voiceOnTheAllowList_isNotRefused', (t) => {
    // The discriminating control for the five above: the guard must refuse a bad list
    // WITHOUT refusing a good one. Without this, "always refuse" passes all five.
    const dir = project(t, { tokens: JSON.stringify({ audio: { ttsVoices: ['en-US-AvaNeural', 'en-GB-SoniaNeural'] } }) });
    assertCleanExit(voice(dir), EXIT.OK);
  });

  test('brandTokensThatIsALink_isRefusedRatherThanFollowed', (t) => {
    // This path is ENGINE-CHOSEN — the caller never names brand/tokens.json — so a link
    // there was planted, not requested, and following it reads a file nobody asked for.
    // The original code did a bare `path.join` with no boundary at all, which is the same
    // confinement gap found in validate-scene's optional-manifest read.
    const outside = makeOutsideDir(t, { 'tokens.json': brandTokens });
    const dir = project(t, { tokens: null });
    fs.mkdirSync(path.join(dir, 'brand'), { recursive: true });
    if (!tryMakeFileLink(path.join(dir, 'brand', 'tokens.json'), path.join(outside, 'tokens.json'))) {
      t.skip('this platform/account cannot create symlinks');
      return;
    }
    const r = voice(dir);
    assertRefused(r, EXIT.USAGE);
    assert.doesNotMatch(r.all, /en-US-AvaNeural/, `it read the allow-list through the link\n${r.all}`);
  });

  test('brandTokensLinkedWithinTheProject_isAlsoRefused', (t) => {
    // The DISCRIMINATING half. The outside-root test above is passed by any merely
    // CONFINING resolver — resolveWithinRoot would refuse it too, because the target is
    // outside the root. Only an in-root link separates the two: resolveWithinRoot permits
    // it (the caller named their own path), resolveInternalArtifact refuses it (the engine
    // chose this path, so a link here was planted, not requested).
    //
    // Verified to discriminate by swapping the resolver in the source: with
    // resolveWithinRoot this test fails and the outside-root one still passes.
    const dir = project(t, { tokens: null });
    fs.mkdirSync(path.join(dir, 'brand'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'brand', 'real-tokens.json'), brandTokens);
    if (!tryMakeFileLink(path.join(dir, 'brand', 'tokens.json'), path.join(dir, 'brand', 'real-tokens.json'))) {
      t.skip('this platform/account cannot create symlinks');
      return;
    }
    const r = voice(dir);
    assertRefused(r, EXIT.USAGE);
    assert.doesNotMatch(r.all, /en-US-AvaNeural/, `it read the allow-list through an in-root link\n${r.all}`);
  });

  test('brandTokensThatCannotBeRead_isNotReportedAsBadJson', (t) => {
    // A directory where the file belongs fails at READ, not at PARSE. Collapsing every
    // non-ENOENT failure into "it is not valid JSON" hands the author a remedy for a
    // problem they do not have — the same wrong-diagnosis shape as naming the wrong file.
    const dir = project(t, { tokens: null });
    fs.mkdirSync(path.join(dir, 'brand', 'tokens.json'), { recursive: true });
    const r = voice(dir);
    assertRefused(r, EXIT.USAGE);
    assert.doesNotMatch(r.all, /not valid JSON/, `a read failure was reported as a parse failure\n${r.all}`);
  });
});

describe('voice.mjs · synthesis and fit failures report rather than crash', () => {
  test('narrationTheServiceCannotSynthesise_isReportedAsASynthesisFailure', (t) => {
    // Punctuation-only narration returns an empty stream with no word boundaries. synth()
    // retries four times and then rethrew the raw Error. This is "the work ran and the
    // result is bad" — FAILED(1) by cli-support's definition, and "1 synthesis failed" by
    // voice.mjs's own header.
    const dir = project(t, {
      timing: timingJson({ segments: [{ id: 'one', startMs: 0, endMs: 3000, voiceoverText: '...' }, narrated()[1]] }),
    });
    const r = voice(dir);
    assertRefused(r, EXIT.FAILED);
    assert.match(r.all, /\bone\b/, `the failure must name the segment\n${r.all}`);
  });

  test('segmentOverrunningItsWindow_isReportedAsAFitFailure', (t) => {
    // C-10. MEASURED: this fires AFTER every clip is already on disk, so the report is the
    // only thing standing between the author and a silent mess. It must name which segment
    // and by how much.
    const dir = project(t, {
      timing: timingJson({
        segments: [
          { id: 'one', startMs: 0, endMs: 120, voiceoverText: 'This narration is far too long for its window.' },
          { id: 'two', startMs: 120, endMs: 3000, voiceoverText: 'Second.' },
        ],
      }),
    });
    const r = voice(dir);
    assertRefused(r, EXIT.FAILED);
    assert.match(r.all, /C-10/, `the refusal must name the constraint\n${r.all}`);
    assert.match(r.all, /\bone\b/, `and the segment that broke it\n${r.all}`);
  });

  test('segmentsThatFitTheirWindows_areNotReportedAsAFitFailure', (t) => {
    // The discriminating control for C-10: the gate must not fire on a timeline that fits.
    const dir = project(t);
    const r = voice(dir);
    assertCleanExit(r, EXIT.OK);
    assert.doesNotMatch(r.all, /C-10/, `C-10 fired on a timeline that fits\n${r.all}`);
  });
});
