/*
 * A null entry in `timing.segments` must be REFUSED, not crashed on.
 *
 * Measured before the fix, plan path, nothing written, at b375d95:
 *
 *   frame-capture.mjs     TypeError: Cannot read properties of null (reading 'endMs')   exit 1
 *   write-storyboard.mjs  TypeError: Cannot read properties of null (reading 'visual')  exit 1
 *   concat-audio.mjs      TypeError: Cannot read properties of null (reading 'audio')   exit 1
 *
 * Exit 1 there is Node's default for an uncaught exception, not a designed refusal — the
 * path had no exit code at all. EXIT.USAGE is therefore naming a code for a path that
 * never had one, and is what cli-support.mjs's own semantics require: a null where a
 * segment object belongs is bad input, refused before any work runs.
 *
 * THE RULE HAS ONE STATEMENT. `segmentEntryBlocker` (silent-segment.mjs) is the whole-list
 * form of the predicate `shapeBlocker` itself calls, so these three stages and the two
 * gates cannot drift into separate accounts of what a segment entry is.
 *
 * WHAT THIS DELIBERATELY DOES NOT CHANGE, and why each is pinned below rather than
 * asserted in a comment:
 *   - an ID-LESS segment stays accepted in all three. frame-capture.mjs tolerates one ON
 *     PURPOSE and labels it by index, because `segment "1"` would send an author to the
 *     wrong line when another segment really carries the id "1". Adopting shapeBlocker
 *     wholesale to fix the crash would have silently reversed that — and no test would
 *     have caught it, which is why these pins exist.
 *   - an EMPTY, ABSENT or NON-ARRAY list keeps exactly the behaviour each stage has today,
 *     including concat-audio's own wording and its exit 1. `segmentEntryBlocker` returns
 *     null for a non-array by design: it refuses entries and has no opinion about lists.
 *
 * This file is separate from silent-segments.test.mjs on purpose: that file is edited by
 * another stream, and these tests span three stages rather than belonging to any one of
 * the existing per-stage suites.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { EXIT } from '../src/cli-support.mjs';
import { makeProject, runScript } from './_helpers.mjs';
import { ttsClip, ttsWords, FRAME_MS, HEAD_FRAMES, TAIL_FRAMES, FRAMES_PER_WORD } from './fixtures/fake-audio-backends.mjs';

// --------------------------------------------------------------------------------------
// Fixtures — a timeline every one of the three stages can read, with real marker-frame
// clips whose measured duration matches what the timeline declares. The control MUST plan
// cleanly in all three, or a refusal below proves only that the fixture is broken.
// --------------------------------------------------------------------------------------

const clipMs = (text) => (HEAD_FRAMES + ttsWords(text).length * FRAMES_PER_WORD + TAIL_FRAMES) * FRAME_MS;

function segment(id, startMs, file, text) {
  const durationMs = clipMs(text);
  return {
    id,
    startMs,
    endMs: startMs + durationMs,
    voiceoverText: text,
    audio: {
      file,
      durationMs,
      headMs: HEAD_FRAMES * FRAME_MS,
      tailMs: TAIL_FRAMES * FRAME_MS,
      words: ttsWords(text).map((word, k) => ({
        word,
        startMs: startMs + (HEAD_FRAMES + k * FRAMES_PER_WORD) * FRAME_MS,
        endMs: startMs + (HEAD_FRAMES + (k + 1) * FRAMES_PER_WORD) * FRAME_MS,
      })),
    },
  };
}

const ONE = segment('one', 0, 'segment_000.mp3', 'hello there friend');
const TWO = segment('two', ONE.endMs, 'segment_001.mp3', 'second segment here');

const timing = (segments, durationMs = TWO.endMs) =>
  JSON.stringify({
    project: { name: 'demo', fps: 30, width: 1280, height: 720, lede: 'a lede' },
    durationMs,
    contentMs: durationMs,
    outroMs: 2500,
    endCard: { enabled: true },
    intake: { leadInMs: 2000, perceivedGapMs: 2000, toleranceMs: 750, voice: 'en-US-AvaNeural', speed: 1, silenceMs: 2000 },
    segments,
  });

/** The same two segments, with the second carrying no id at all. */
const idless = () => {
  const s = structuredClone(TWO);
  delete s.id;
  return [ONE, s];
};

/** A project every one of the three stages can plan in. */
const project = (t, segments, durationMs) =>
  makeProject(t, {
    'timing.json': timing(segments, durationMs),
    'brand/tokens.json': JSON.stringify({ audio: { ttsVoices: ['en-US-AvaNeural'] } }),
    'video-auto.html': '<html></html>',
    'segment_000.mp3': ttsClip('hello there friend'),
    'segment_001.mp3': ttsClip('second segment here'),
    'silence.mp3': ttsClip('pause'),
  });

/** A segment whose `silence` declaration is malformed — `silence: null` is an own property. */
const badlyDeclaredSilence = () => ({ ...structuredClone(ONE), silence: null });

const STAGES = ['frame-capture.mjs', 'write-storyboard.mjs', 'concat-audio.mjs'];

/** Everything the run printed, and whether it ended in an uncaught exception. */
function plan(t, stage, segments, durationMs) {
  return planWith(t, stage, timing(segments, durationMs));
}

/** The same, for a timing document that cannot be expressed as a segment array. */
function planWith(t, stage, body) {
  const dir = makeProject(t, {
    'timing.json': body,
    'brand/tokens.json': JSON.stringify({ audio: { ttsVoices: ['en-US-AvaNeural'] } }),
    'video-auto.html': '<html></html>',
    'segment_000.mp3': ttsClip('hello there friend'),
    'segment_001.mp3': ttsClip('second segment here'),
    'silence.mp3': ttsClip('pause'),
  });
  const before = new Set(fs.readdirSync(dir));
  const r = runScript(stage, [], dir);
  return { ...r, dir, wrote: fs.readdirSync(dir).filter((f) => !before.has(f)) };
}

/** The control timing with its segment list replaced by something that is not a list. */
const listShaped = (replacement) => {
  const doc = JSON.parse(timing([ONE, TWO]));
  if (replacement === undefined) delete doc.segments;
  else doc.segments = replacement;
  return JSON.stringify(doc);
};

const crashed = (r) => /^(TypeError|ReferenceError)\b/m.test(r.all) && /\n\s+at /.test(r.all);

// --------------------------------------------------------------------------------------
// The control. Every assertion below is only worth something if this passes.
// --------------------------------------------------------------------------------------

describe('the control timeline plans cleanly in every stage', () => {
  for (const stage of STAGES) {
    test(`${stage.replace('.mjs', '')}_wellFormedTimeline_plansCleanlyWritingNothing`, (t) => {
      const r = plan(t, stage, [ONE, TWO]);

      assert.equal(r.code, EXIT.OK, `the control must plan cleanly or nothing here proves anything\n${r.all}`);
      assert.equal(crashed(r), false, r.all);
      assert.deepEqual(r.wrote, [], 'and a plan writes nothing');
    });
  }
});

// --------------------------------------------------------------------------------------
// R4: the null entry
// --------------------------------------------------------------------------------------

describe('a null entry in timing.segments is refused, not crashed on', () => {
  for (const stage of STAGES) {
    test(`${stage.replace('.mjs', '')}_timelineWithANullSegmentEntry_refusesNamingTheIndex`, (t) => {
      const r = plan(t, stage, [ONE, null]);

      assert.equal(crashed(r), false, `a malformed timeline must not reach an uncaught exception\n${r.all}`);
      assert.equal(r.code, EXIT.USAGE, `bad input is a usage refusal, not a failed run\n${r.all}`);
      assert.match(
        r.all,
        /timing\.segments\[1\] is not a segment object/,
        'the refusal must name the entry by its index, since it has no id to be named by',
      );
      assert.deepEqual(r.wrote, [], 'and nothing may be written');
    });
  }

  // The index is read off the list, not guessed: a null in a different position must be
  // named for where it actually is.
  test('frameCapture_nullEntryAtTheHeadOfTheList_namesIndexZeroNotIndexOne', (t) => {
    const r = plan(t, 'frame-capture.mjs', [null, TWO]);

    assert.equal(crashed(r), false, r.all);
    assert.match(r.all, /timing\.segments\[0\] is not a segment object/, r.all);
  });

  // An array and a string are not segment objects either, and must not be coerced into
  // one — `typeof [] === 'object'` is exactly the hole the predicate closes.
  for (const [label, entry] of [['anArray', []], ['aString', 'two'], ['aNumber', 7]]) {
    test(`writeStoryboard_entryThatIs_${label}_isRefusedAsNotASegmentObject`, (t) => {
      const r = plan(t, 'write-storyboard.mjs', [ONE, entry]);

      assert.equal(crashed(r), false, r.all);
      assert.equal(r.code, EXIT.USAGE, r.all);
      assert.match(r.all, /timing\.segments\[1\] is not a segment object/, r.all);
    });
  }
});

// --------------------------------------------------------------------------------------
// What this change must NOT touch. These pin the decisions that wholesale adoption of
// shapeBlocker would have reversed — six behaviour changes that no test covered.
// --------------------------------------------------------------------------------------

describe('the entry rule does not bring the id rule or the list rule with it', () => {
  for (const stage of STAGES) {
    test(`${stage.replace('.mjs', '')}_segmentWithNoId_isStillAccepted`, (t) => {
      const r = plan(t, stage, idless());

      assert.equal(crashed(r), false, r.all);
      assert.equal(
        r.code,
        EXIT.OK,
        `an id-less segment is tolerated on purpose and labelled by index — refusing it here would ` +
          `reverse frame-capture's documented decision\n${r.all}`,
      );
    });
  }

  // Each stage answers the list question its own way, today. The entry rule has no opinion
  // about lists, so every one of these must read exactly as it did before.
  test('frameCapture_emptySegmentList_isStillTolerated', (t) => {
    const r = plan(t, 'frame-capture.mjs', [], 4000);

    assert.equal(crashed(r), false, r.all);
    assert.equal(r.code, EXIT.OK, r.all);
  });

  test('writeStoryboard_emptySegmentList_isStillTolerated', (t) => {
    const r = plan(t, 'write-storyboard.mjs', [], 4000);

    assert.equal(crashed(r), false, r.all);
    assert.equal(r.code, EXIT.OK, r.all);
  });

  // concat-audio already refuses an empty list, with its own wording and its own code.
  // Both are shipped, and the wording is better than the shared gate's. Left alone.
  test('concatAudio_emptySegmentList_keepsItsOwnRefusalAndItsOwnExitCode', (t) => {
    const r = plan(t, 'concat-audio.mjs', [], 4000);

    assert.equal(crashed(r), false, r.all);
    assert.equal(r.code, EXIT.FAILED, `concat-audio's own exit code for this is 1, and it is shipped\n${r.all}`);
    assert.match(
      r.all,
      /timing\.json declares no segments — there is nothing to concatenate/,
      'and its own longer wording survives',
    );
  });
});

// --------------------------------------------------------------------------------------
// PRECEDENCE. The entry guard was placed BEFORE write-storyboard's silence-declaration
// check on purpose, which changes which refusal a timeline carrying BOTH defects gets.
// That is a contract, so it is pinned rather than left to the placement.
//
// The reason for the order: `isSilentSegment(null)` is false, so the declaration check
// SKIPS a null entry and then refuses something else — reporting a caption problem on one
// segment while another entry is not a segment at all. Shape first means the reader is
// told what is actually wrong with the file.
// --------------------------------------------------------------------------------------

describe('a malformed entry is reported before a malformed silence declaration', () => {
  test('writeStoryboard_timelineWithBothANullEntryAndABadSilenceDeclaration_reportsTheEntry', (t) => {
    const r = plan(t, 'write-storyboard.mjs', [badlyDeclaredSilence(), null]);

    assert.equal(crashed(r), false, r.all);
    assert.equal(r.code, EXIT.USAGE, r.all);
    assert.match(r.all, /timing\.segments\[1\] is not a segment object/, 'the shape must be reported first');
    assert.doesNotMatch(
      r.all,
      /declares `silence`/,
      'and the declaration problem must not be what a reader is sent to fix while an entry is not a segment',
    );
  });

  // THE CONTROL FOR THAT ORDERING. With no null entry, the declaration check still runs
  // and still refuses — the guard must not have swallowed it.
  test('writeStoryboard_timelineWithOnlyABadSilenceDeclaration_stillReportsTheDeclaration', (t) => {
    const r = plan(t, 'write-storyboard.mjs', [badlyDeclaredSilence(), TWO]);

    assert.equal(crashed(r), false, r.all);
    assert.notEqual(r.code, EXIT.OK, r.all);
    assert.match(r.all, /declares `silence`/, 'the declaration check must still fire when nothing shadows it');
  });
});

// --------------------------------------------------------------------------------------
// THE LIST RULE IS NOT THIS RULE — including where that leaves a crash in place.
//
// `segmentEntryBlocker` returns null for a non-array, so an absent or non-array list keeps
// exactly the behaviour each stage had. For two of them that behaviour is an uncaught
// TypeError, which this task deliberately does NOT fix: it is a different defect, in the
// same files, logged to shape-first-everywhere. Pinned here so the next reader knows it is
// known and scoped out rather than overlooked — and so that fixing it has to come here and
// change these expectations deliberately.
// --------------------------------------------------------------------------------------

describe('an absent or non-array segment list keeps each stage exactly as it was', () => {
  test('concatAudio_absentSegmentList_keepsItsOwnRefusal', (t) => {
    const r = planWith(t, 'concat-audio.mjs', listShaped(undefined));

    assert.equal(crashed(r), false, r.all);
    assert.equal(r.code, EXIT.FAILED, r.all);
    assert.match(r.all, /timing\.json declares no segments — there is nothing to concatenate/, r.all);
  });

  test('concatAudio_nonArraySegmentList_keepsItsOwnRefusal', (t) => {
    const r = planWith(t, 'concat-audio.mjs', listShaped('two of them'));

    assert.equal(crashed(r), false, r.all);
    assert.equal(r.code, EXIT.FAILED, r.all);
    assert.match(r.all, /timing\.json declares no segments — there is nothing to concatenate/, r.all);
  });

  test('frameCapture_absentSegmentList_isStillTolerated', (t) => {
    const r = planWith(t, 'frame-capture.mjs', listShaped(undefined));

    assert.equal(crashed(r), false, r.all);
    assert.equal(r.code, EXIT.OK, r.all);
  });

  // OUT OF SCOPE, AND STILL BROKEN. `(timing.segments || []).map` — the `||` idiom guards
  // ABSENCE and not TYPE, because a non-empty string is truthy. Recorded, not fixed here.
  test('frameCapture_nonArraySegmentList_stillCrashes_knownAndScopedOut', (t) => {
    const r = planWith(t, 'frame-capture.mjs', listShaped('two of them'));

    assert.equal(crashed(r), true, 'if this ever stops crashing, it was fixed — update this expectation');
    assert.match(r.all, /\.map is not a function/, r.all);
  });

  for (const [label, replacement, pattern] of [
    ['absent', undefined, /reading 'length'/],
    ['nonArray', 'two of them', /\.filter is not a function/],
  ]) {
    test(`writeStoryboard_${label}SegmentList_stillCrashes_knownAndScopedOut`, (t) => {
      const r = planWith(t, 'write-storyboard.mjs', listShaped(replacement));

      assert.equal(crashed(r), true, 'if this ever stops crashing, it was fixed — update this expectation');
      assert.match(r.all, pattern, r.all);
    });
  }
});