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
import { makeProject, makeOutsideDir, runScript, assertCleanExit, tryMakeFileLink, FAKE_AUDIO, brandTokens, fixtureUrl } from './_helpers.mjs';

/** Makes music-metadata's parseFile throw after N real calls. */
const FAIL_PROBE = fixtureUrl('fail-probe.mjs');
/** Makes one publish rename fail, inside the child, with no race. */
const FAIL_RENAME = fixtureUrl('fail-rename-dest.mjs');

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

describe('voice.mjs · a failed run publishes nothing (stage-then-publish)', () => {
  // MEASURED BEFORE THIS CHANGE: a C-10 failure and an end-card failure each left new
  // audio on disk beside a timeline still describing the old. That is the sentence
  // remix.mjs's own test uses for the defect it already fixed
  // (voice-remix-apply.test.mjs:1086) — this stage simply never got the same treatment.
  //
  // Two fixture facts, both learned by getting them wrong first:
  //   - The fake TTS is deterministic, so re-synthesising UNCHANGED text produces
  //     byte-identical clips. A test that does not change the narration cannot see whether
  //     a clip was rewritten.
  //   - voice REFLOWS the timeline, so after any successful run every window equals its
  //     measured clip exactly. Any text edit therefore overruns C-10, which fires before
  //     the end-card check — so a test for the end-card path must NOT edit narration.

  const ARTIFACTS = ['timing.json', 'voiceover.mp3', 'segment_01.mp3', 'segment_02.mp3', 'calibration-observed.json', 'sync-mapping.md'];
  const snapshot = (dir) => Object.fromEntries(ARTIFACTS.map((f) => {
    const p = path.join(dir, f);
    return [f, fs.existsSync(p) ? fs.readFileSync(p).toString('base64') : null];
  }));
  const partFiles = (dir) => fs.readdirSync(dir).filter((n) => n.includes('.part-'));

  /** A project whose prior voice run completed, so every artifact is in place. */
  function completed(t) {
    const dir = project(t);
    const first = voice(dir);
    assertCleanExit(first, EXIT.OK, 'the prior run must succeed or the fixture proves nothing: ');
    return dir;
  }

  const editTiming = (dir, fn) => {
    const p = path.join(dir, 'timing.json');
    const timing = JSON.parse(fs.readFileSync(p, 'utf8'));
    fn(timing);
    fs.writeFileSync(p, JSON.stringify(timing, null, 2));
  };

  test('applyThatFailsTheFitGate_publishesNothing', (t) => {
    const dir = completed(t);
    // The narration changes so the new clips genuinely differ from the ones on disk, and
    // the window shrinks so C-10 fires after they have been synthesised.
    editTiming(dir, (timing) => {
      timing.segments[1].voiceoverText = 'A completely different second line of narration entirely.';
      timing.segments[0].endMs = timing.segments[0].startMs + 80;
    });
    const before = snapshot(dir);

    const r = voice(dir);

    assertRefused(r, EXIT.FAILED);
    assert.deepEqual(snapshot(dir), before, 'a run that fails C-10 must leave every file exactly as it was');
    assert.deepEqual(partFiles(dir), [], 'no staging file may be left behind');
  });

  // SUPERSEDED BY F7, AND THAT IS AN IMPROVEMENT. This case used to be the second
  // post-synthesis failure: the end card was checked only after every clip and voiceover.mp3
  // had been overwritten, so staging is what kept the project consistent. F7 (127f2a8) moved
  // that check into voiceTimelineBlocker, the PRE-WRITE gate, so the run is now refused at
  // EXIT.USAGE before a single TTS call — cheaper than staging and strictly better.
  //
  // It is kept, renamed, and deliberately NOT left asserting EXIT.FAILED: it no longer
  // reaches the staging path, so inside this describe block it would be an inert guard,
  // green for a reason unrelated to what the block claims. Post-synthesis staging is covered
  // by applyThatFailsTheFitGate_publishesNothing above, which fires C-10 after the clips
  // exist. If this test ever starts failing with EXIT.FAILED again, the pre-write gate has
  // regressed and the end card is being judged late once more.
  test('applyWithAnUnusableEndCard_isRefusedBeforeAnythingIsSynthesised', (t) => {
    const dir = completed(t);
    // No narration edit — see the note above. Enabling the end card alone still diverges
    // the audio, because the outro is concatenated into voiceover.mp3.
    editTiming(dir, (timing) => {
      timing.endCard = { enabled: true };
      timing.outroMs = 2500;
      delete timing.builderVersion;
    });
    const before = snapshot(dir);

    const r = voice(dir);

    assertRefused(r, EXIT.USAGE);
    assert.deepEqual(snapshot(dir), before, 'a refused end card must leave every file as it was');
    assert.deepEqual(partFiles(dir), [], 'no staging file may be left behind');
  });

  test('applyWhoseProbeFailsAfterAClipIsStaged_leavesNoStagingFile', (t) => {
    // THE WINDOW THE PER-ATTEMPT CLEANUP EXISTS FOR, and nothing else could reach it: every
    // failure the fake TTS can raise (empty stream, no word boundaries) happens BEFORE the
    // clip is staged. So `discardFrom(mark)` was unreachable from the tests that claimed to
    // cover it — a cleanup path that could not be made to run.
    //
    // fail-probe substitutes music-metadata so parseFile throws after N real calls, putting
    // a genuine failure between stage() and the measurement. The run must still end with
    // the project exactly as it was and no `.part-` file left behind.
    const dir = completed(t);
    const before = snapshot(dir);

    const r = runScript('voice.mjs', ['--project', dir, '--apply', '--replace'], dir, {
      nodeArgs: ['--import', FAKE_AUDIO, '--import', FAIL_PROBE],
      env: { FAIL_PROBE_AFTER: '0' },   // throw on the very first probe, after staging
    });

    assert.notEqual(r.code, 0, `the run must fail\n${r.all}`);
    assert.deepEqual(snapshot(dir), before, 'a probe failure must leave every file exactly as it was');
    assert.deepEqual(partFiles(dir), [], `no staging file may survive a probe failure\n${r.all}`);
  });

  test('applyWhoseProbeFailsPartWayThrough_leavesNoStagingFile', (t) => {
    // The same window, reached later: the first clip measures, the second does not. This is
    // the case where staging files from EARLIER successful work are already accumulated, so
    // it exercises discardFrom(0) over a non-empty set rather than a single entry.
    const dir = completed(t);
    const before = snapshot(dir);

    const r = runScript('voice.mjs', ['--project', dir, '--apply', '--replace'], dir, {
      nodeArgs: ['--import', FAKE_AUDIO, '--import', FAIL_PROBE],
      env: { FAIL_PROBE_AFTER: '1' },
    });

    assert.notEqual(r.code, 0, `the run must fail\n${r.all}`);
    assert.deepEqual(snapshot(dir), before, 'a later probe failure must still leave every file as it was');
    assert.deepEqual(partFiles(dir), [], `no staging file may survive a probe failure\n${r.all}`);
  });

  test('applyWhoseFirstProbeFailsThenRecovers_publishesOneCleanResult', (t) => {
    // Retry RECOVERY, which the two tests above cannot reach: FAIL_PROBE_AFTER throws on
    // every later call, so the run can only exhaust its attempts. One-shot failure lets
    // attempt 1 fail after its clip is staged and attempt 2 succeed.
    //
    // DISCLOSED: this does not prove `discardFrom(mark)` is NECESSARY. I removed that line
    // and the two probe-failure tests above still passed, because the outer handler's
    // discardFrom(0) cleans up at the end regardless. What the per-attempt call prevents is
    // narrower — a failed attempt's staging file surviving in `staged` and being renamed
    // onto the live destination just before the good one — and that is not observable from
    // outside the process. Recorded rather than implied by a passing test.
    const dir = completed(t);
    // The narration must change for "did it publish" to be answerable at all — the fake is
    // deterministic, so re-running the same text republishes identical bytes and the
    // snapshot cannot tell a successful publish from a no-op. The window is widened with
    // it, because the prior run reflowed every window onto its measured clip and a longer
    // line would otherwise trip C-10 before the probe is reached. I hit exactly that
    // writing the first version of this test, which is the third time this fixture's
    // determinism has caught me.
    editTiming(dir, (timing) => {
      timing.segments[1].voiceoverText = 'A completely different second line of narration entirely.';
      timing.segments[1].endMs = timing.segments[1].startMs + 8000;
    });
    const before = snapshot(dir);

    const r = runScript('voice.mjs', ['--project', dir, '--apply', '--replace'], dir, {
      nodeArgs: ['--import', FAKE_AUDIO, '--import', FAIL_PROBE],
      env: { FAIL_PROBE_ONLY: '1' },
    });

    assertCleanExit(r, EXIT.OK, 'the retry must recover: ');
    assert.match(r.all, /attempt 1 failed/, `the first attempt must actually have failed\n${r.all}`);
    assert.notDeepEqual(snapshot(dir), before, 'a recovered run must still publish its work');
    assert.deepEqual(partFiles(dir), [], `no staging file may survive a recovered run\n${r.all}`);
  });

  test('applyWhoseLaterPublishFails_namesWhatLandedAndLeavesTheTimeline', (t) => {
    // The partial-publish report had no test. The lever must make ONE late rename fail
    // while earlier ones succeed — deterministically, on any platform.
    //
    // Two earlier attempts were rejected for good reasons, both recorded because each is a
    // way this test could have passed for the wrong reason:
    //   - A read-only destination is NOT portable: it fails rename on Windows but not on
    //     POSIX, where replacement is governed by the directory's permission.
    //   - Planting a directory mid-run from the PARENT, triggered by a marker in the
    //     child's output, is a RACE: the child keeps running while the pipe is delivered,
    //     so it can publish before the plant lands and the test then asserts against an
    //     ordinary successful run.
    // Failing the rename inside the child removes both problems.
    const dir = completed(t);
    editTiming(dir, (timing) => {
      timing.segments[1].voiceoverText = 'A completely different second line of narration entirely.';
      timing.segments[1].endMs = timing.segments[1].startMs + 8000;
    });
    const timingBefore = fs.readFileSync(path.join(dir, 'timing.json'), 'utf8');

    const r = runScript('voice.mjs', ['--project', dir, '--apply', '--replace'], dir, {
      nodeArgs: ['--import', FAKE_AUDIO, '--import', FAIL_RENAME],
      env: { FAIL_RENAME_DEST: 'sync-mapping.md' },
    });

    assertRefused(r, EXIT.FAILED);
    assert.match(r.all, /could not publish sync-mapping\.md/, `it must name the artifact that failed\n${r.all}`);
    assert.match(r.all, /Published: .*voiceover\.mp3/, `it must name what DID land\n${r.all}`);
    assert.match(r.all, /timing\.json was not updated/, `the timeline's state is the recovery decision\n${r.all}`);
    assert.equal(
      fs.readFileSync(path.join(dir, 'timing.json'), 'utf8'), timingBefore,
      'the timeline must still describe the audio from before this run',
    );
    assert.deepEqual(partFiles(dir), [], `no staging file may be left behind\n${r.all}`);
  });

  test('applyWhoseOutroIsRefusedAfterClipsAreStaged_leavesNoStagingFile', (t) => {
    // `silenceAssetBytes` refuses a pause outside its limits, and it is called AFTER every
    // clip has been staged. That refusal used to go through `guard()`, which calls
    // process.exit() itself and so walked straight past the outer handler, stranding every
    // staged clip — a refusal leaving exactly the mess it exists to prevent.
    const dir = completed(t);
    editTiming(dir, (timing) => {
      timing.endCard = { enabled: true };
      timing.builderVersion = '1.2.3';
      timing.outroMs = 7_200_000;            // two hours of outro
    });
    const before = snapshot(dir);

    const r = voice(dir);

    assert.notEqual(r.code, 0, `the run must fail\n${r.all}`);
    assert.deepEqual(snapshot(dir), before, 'a refused pause must leave every file exactly as it was');
    assert.deepEqual(partFiles(dir), [], `no staging file may survive a refused pause\n${r.all}`);
  });

  test('applyThatSucceeds_publishesEverythingAndLeavesNoStagingFiles', (t) => {
    // THE CONTROL. Every test above asserts that nothing moved, which is exactly what a
    // stage that silently published nothing would also produce. This is what separates
    // "refused safely" from "quietly did nothing".
    const dir = completed(t);
    editTiming(dir, (timing) => {
      timing.segments[1].voiceoverText = 'A completely different second line of narration entirely.';
      timing.segments[1].endMs = timing.segments[1].startMs + 8000;
    });
    const before = snapshot(dir);

    const r = voice(dir);

    assertCleanExit(r, EXIT.OK);
    assert.notDeepEqual(snapshot(dir), before, 'a successful run must actually publish its work');
    assert.deepEqual(partFiles(dir), [], 'no staging file may survive a successful run');
  });

  test('applyThatFailsSynthesis_stillWritesTheHealLog', (t) => {
    // THE DELIBERATE EXCEPTION. heal-log.txt records the retry attempts, so it is written
    // DURING the failure and must survive it — a log of what went wrong is worthless if it
    // is rolled back with everything else. This is why this stage cannot copy remix's
    // phrasing that "nothing was written": here something was, on purpose.
    const dir = completed(t);
    editTiming(dir, (timing) => { timing.segments[0].voiceoverText = '...'; });
    const before = snapshot(dir);

    const r = voice(dir);

    assertRefused(r, EXIT.FAILED);
    assert.deepEqual(snapshot(dir), before, 'the audio and the timeline must be untouched');
    assert.ok(fs.existsSync(path.join(dir, 'heal-log.txt')), `the heal log must survive the failure it records\n${r.all}`);
    assert.deepEqual(partFiles(dir), [], 'no staging file may be left behind');
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
