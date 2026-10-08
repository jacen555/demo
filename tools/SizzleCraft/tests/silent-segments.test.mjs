// Deliberately silent segments — an intro slide, a gap, an intermission.
//
// THE DISTINCTION THIS FILE EXISTS TO PIN
//
// Before this change, a segment with no `audio` meant exactly one thing: "voice.mjs has
// not run yet." Every stage that needed a duration got it from TTS, so a segment with no
// narration had no duration, no clip, and no way to say it was silent ON PURPOSE.
//
// A silent segment also has no narration. So "deliberately silent" and "not yet
// synthesised" were the SAME STATE, and the pipeline had to guess. Guessing either way is
// a defect: infer silence and a project that forgot to run the voice stage renders mute;
// infer "not synthesised" and a legitimate intermission can never be authored at all.
//
// The resolution is that silence is DECLARED — `segments[].silence` — never inferred from
// absence. So:
//
//   silence declared + audio present  -> a silent segment, synthesised
//   silence declared + audio absent   -> a silent segment, voice has not run
//   silence absent   + audio absent   -> voice has not run. STILL FAILS. (unchanged)
//
// and the authored window `endMs - startMs` is the duration every stage honours. There is
// deliberately NO second duration field: two sources of truth for one number is the exact
// in-band-divergence defect class this engine keeps re-shipping.
//
// THE DANGEROUS ONE
//
// `concat-audio` discovers `segment_*.mp3` by globbing and concatenates what it finds. A
// silent segment has no clip, so it was silently omitted — and every later segment moved
// EARLIER by that segment's whole duration, with no error and exit 0. That is why the
// concat tests below assert the output's byte layout (total duration AND each segment's
// offset) rather than the exit code: a stage that exits 0 having corrupted the timeline
// is precisely the failure being fixed, so exit 0 cannot be the assertion.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { EXIT, narrationFingerprint } from '../src/cli-support.mjs';
import {
  FAKE_AUDIO, makeProject, runScript, assertCleanExit, tryMakeFileLink, timingFixture, wordedSegments, shortNameOf, zeroFileIds,
  ZERO_FILE_IDS_ARMED, failLstat, FAIL_LSTAT_ARMED, BLOCK_PLAYWRIGHT,
} from './_helpers.mjs';

// ---------------------------------------------------------------------------
// Frame-exact MP3 fixtures.
//
// The engine's silence profile is MPEG-2 Layer III, 24 kHz, 96 kbps, mono: 288 bytes and
// 24 ms per frame (see silence-gen.mjs). Byte offsets in a concatenation are therefore
// EXACTLY convertible to milliseconds, which is what makes a real timeline assertion
// possible here without ffmpeg.
//
// Each clip's frame HEADERS are valid so the concatenator's frame-sync scan behaves as it
// does on real audio, while the payload is filled with a per-clip marker byte so the
// output can be read back as "which clip is playing at millisecond N". Generated silence
// has a zero payload, so it is distinguishable from every authored clip.
// ---------------------------------------------------------------------------
const FRAME_BYTES = 288;
const FRAME_MS = 24;
const framesFor = (ms) => Math.round(ms / FRAME_MS);
const msToBytes = (ms) => framesFor(ms) * FRAME_BYTES;

function clipBytes(ms, marker) {
  const frames = framesFor(ms);
  const buf = Buffer.alloc(FRAME_BYTES * frames, marker);
  for (let i = 0; i < frames; i++) {
    const o = i * FRAME_BYTES;
    buf[o] = 0xff; buf[o + 1] = 0xf3; buf[o + 2] = 0xa4; buf[o + 3] = 0xc0;
  }
  return buf;
}

/** The marker byte playing at `ms` in a concatenated track — i.e. which clip is audible. */
function markerAtMs(outBytes, ms) {
  const frame = framesFor(ms);
  const payloadOffset = frame * FRAME_BYTES + 4; // past the 4-byte frame header
  assert.ok(
    payloadOffset < outBytes.length,
    `no audio at ${ms}ms: the track is only ${(outBytes.length / FRAME_BYTES) * FRAME_MS}ms long`,
  );
  return outBytes[payloadOffset];
}

const SILENT_MARKER = 0x00;
const MARKER_ONE = 0x11;
const MARKER_THREE = 0x33;

// ---------------------------------------------------------------------------
// Timelines.
// ---------------------------------------------------------------------------

/** A three-segment timeline whose MIDDLE segment is a declared intermission. */
function silentMiddleSegments({ caption = '[music]' } = {}) {
  return [
    { id: 'one', startMs: 0, endMs: 480, voiceoverText: 'hello there friend', audio: { file: 'segment_000.mp3', durationMs: 480, headMs: 0, tailMs: 0, words: [{ word: 'hello', startMs: 0, endMs: 160 }, { word: 'there', startMs: 160, endMs: 320 }, { word: 'friend', startMs: 320, endMs: 480 }] } },
    { id: 'intermission', startMs: 480, endMs: 1440, voiceoverText: '', silence: { caption } },
    { id: 'three', startMs: 1440, endMs: 2160, voiceoverText: 'and we are back', audio: { file: 'segment_002.mp3', durationMs: 720, headMs: 0, tailMs: 0, words: [{ word: 'and', startMs: 1440, endMs: 1620 }, { word: 'we', startMs: 1620, endMs: 1800 }, { word: 'are', startMs: 1800, endMs: 1980 }, { word: 'back', startMs: 1980, endMs: 2160 }] } },
  ];
}

// The end card is ENABLED here purely so `contentMs` may be present: timing-schema.json
// requires a disabled end card to carry none of builderVersion/contentMs/outroMs, and
// several stages below report `contentMs`. Leaving it disabled made these fixtures fail
// schema validation for a reason that has nothing to do with silence.
function timingWith(segments, extra = {}) {
  return JSON.stringify({
    project: { name: 'demo', fps: 30, width: 1280, height: 720, lede: 'a lede' },
    durationMs: segments.at(-1).endMs,
    contentMs: segments.at(-1).endMs,
    outroMs: 0,
    builderVersion: '0.0.1-test',
    endCard: { enabled: true },
    intake: { leadInMs: 0, perceivedGapMs: 0, toleranceMs: 750, voice: 'en-US-AvaNeural', speed: 1, silenceMs: 0 },
    segments,
    ...extra,
  });
}

/**
 * silentMiddleSegments as the voice stage leaves them: the silent segment carries the
 * record of the clip it generated for its 960 ms window, with no words.
 */
function voicedSilentMiddle() {
  const segments = silentMiddleSegments();
  segments[1].audio = { file: 'segment_001.mp3', durationMs: 960, headMs: 0, tailMs: 0, words: [] };
  return segments;
}

/**
 * The clips voicedSilentMiddle()'s records name. A remedy names a stage only where that
 * stage would accept the timeline, and remix requires every clip a record names, so a
 * fixture that expects remix to be named carries them.
 */
const voicedClips = () => ({
  'segment_000.mp3': clipBytes(480, MARKER_ONE),
  'segment_001.mp3': clipBytes(960, SILENT_MARKER),
  'segment_002.mp3': clipBytes(720, MARKER_THREE),
});

/** Word boundaries moved by `ms`, as a reflow moves them with their segment. */
const shiftWords = (list, ms) => list.map((w) => ({ ...w, startMs: w.startMs + ms, endMs: w.endMs + ms }));

/**
 * voicedSilentMiddle() after a silence edit made by hand and not yet reflowed: the
 * intermission's window now ends at `endMs` (3000 ms long by default, from 960) and "three"
 * has been moved after it. The intermission's record still describes the 960 ms of silence
 * voice generated.
 */
function widenedIntermission(endMs = 3480) {
  const segments = voicedSilentMiddle();
  const shift = endMs - segments[1].endMs;
  segments[1].endMs = endMs;
  segments[2].startMs += shift;
  segments[2].endMs += shift;
  segments[2].audio.words = shiftWords(segments[2].audio.words, shift);
  return segments;
}

/**
 * calibration-observed.json exactly as voice.mjs writes it for voicedSilentMiddle(): real
 * narration fingerprints, and `silent: true` on the silent row. `rows` replaces a row by id.
 */
function voiceCalibration(rows = {}) {
  return JSON.stringify({
    voiceId: 'en-US-AvaNeural',
    roundedSpeed: 1,
    aggregate: { words: 7, speechMs: 1200, observedEffWps: 5.833, observedSafeWps: 5.833 },
    segments: [
      { id: 'one', words: 3, chars: 18, clipMs: 480, speechMs: 480, effWps: 6.25, textHash: narrationFingerprint('hello there friend') },
      { id: 'intermission', words: 0, chars: 0, clipMs: 960, speechMs: 0, silent: true, textHash: narrationFingerprint('') },
      { id: 'three', words: 4, chars: 15, clipMs: 720, speechMs: 720, effWps: 5.556, textHash: narrationFingerprint('and we are back') },
    ].map((row) => rows[row.id] ?? row),
  });
}

/** The cues of a WebVTT sidecar, in order, with their times in milliseconds. */
function vttCues(vtt) {
  const ms = (clock) => {
    const [h, m, s] = clock.split(':');
    return Math.round((Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000);
  };
  return [...vtt.matchAll(/(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})[^\r\n]*\r?\n((?:[^\r\n]+\r?\n?)+)/g)]
    .map(([, a, b, text]) => ({ startMs: ms(a), endMs: ms(b), text: text.trim().replace(/\s*\r?\n\s*/g, ' ') }));
}

/**
 * A narrated segment [0, 960] followed by a declared silent one [960, 1920]. No gap sits
 * between them: none is ever inserted at a seam that touches a silent segment.
 */
function spokenThenSilent(voiceoverText, words) {
  return [
    { id: 'one', startMs: 0, endMs: 960, voiceoverText,
      audio: { file: 'segment_01.mp3', durationMs: 960, headMs: words[0].startMs, tailMs: 0, words } },
    { id: 'break', startMs: 960, endMs: 1920, voiceoverText: '', silence: { caption: '[music]' } },
  ];
}

// ===========================================================================
// R1 — the declaration, and the absence that must still fail
// ===========================================================================
describe('silence is declared, never inferred', () => {
  test('writeSubtitles_segmentWithNoAudioAndNoSilenceDeclaration_stillFailsNamingTheVoiceStage', (t) => {
    // REGRESSION GUARD (passed before this change too). The whole design rests on absence
    // of `audio` continuing to mean "voice has not run", so it is pinned explicitly: if a
    // later refactor makes silence inferable from absence, this is the test that catches
    // a forgotten voice stage rendering mute instead of failing.
    const segments = [{ id: 'one', startMs: 0, endMs: 2000, voiceoverText: 'hello there' }];
    const dir = makeProject(t, { 'timing.json': timingWith(segments) });

    const r = runScript('write-subtitles.mjs', [], dir);

    assert.notEqual(r.code, EXIT.OK, `a project whose voice stage never ran must fail\n${r.all}`);
    assert.match(r.all, /run voice\.mjs/i, 'the message must name the stage that was skipped');
  });

  test('writeSubtitles_aRefusalWhoseRemedyAlreadySaysInstead_doesNotSayItTwice', (t) => {
    // MEASURED, by running it: when the voice gate returns a malformed-declaration blocker,
    // gatedRemedy's fact ends "...is reported here INSTEAD: ..." and the trailing
    // parenthetical then added a second "instead" to the same line:
    //
    //   timing.segments[1] ("two") has no audio.words — a malformed silence declaration is
    //   reported here INSTEAD: ... (If this segment is meant to be silent, declare it
    //   silent (...) INSTEAD.)
    //
    // Two independently-correct sentences composing into one that reads as a mistake. The
    // contract pinned here is the composition, not either wording: no line of a refusal
    // repeats "instead", however the halves are reworded later.
    const segments = [
      { id: 'one', startMs: 0, endMs: 960, voiceoverText: 'hello there', silence: { caption: '[x]' } },
      { id: 'two', startMs: 960, endMs: 1920, voiceoverText: 'second line here' },
    ];
    const dir = makeProject(t, { 'timing.json': timingWith(segments) });

    const r = runScript('write-subtitles.mjs', [], dir);

    assert.notEqual(r.code, EXIT.OK, `this timeline must be refused\n${r.all}`);
    const doubled = r.all.split(/\r?\n/).filter((line) => (line.match(/\binstead\b/gi) ?? []).length > 1);
    assert.deepEqual(doubled, [], `no line may say "instead" twice\n${doubled.join('\n')}`);
    // The control: the line must still BE there and still carry its remedy, or "never say
    // instead at all" would satisfy the assertion above.
    assert.match(r.all, /has no audio\.words/, `the refusal itself must survive\n${r.all}`);
    assert.match(r.all, /meant to be silent/, `and so must its silent-segment advice\n${r.all}`);
  });

  test('validateTiming_silentSegmentCarryingNarrationText_isRejected', (t) => {
    // A segment that declares silence AND carries narration is a contradiction with no
    // safe resolution — whichever one a stage honours, the other was a lie. Refuse it.
    const segments = [
      { id: 'one', startMs: 0, endMs: 1000, voiceoverText: 'hello', audio: { durationMs: 1000 } },
      { id: 'two', startMs: 1000, endMs: 2000, voiceoverText: 'this text will never be spoken', silence: { caption: '[music]' } },
    ];
    const dir = makeProject(t, { 'timing.json': timingWith(segments) });

    const r = runScript('validate-timing.mjs', [], dir);

    assertCleanExit(r, EXIT.FAILED, 'a silent segment with narration text must fail: ');
    assert.match(r.all, /silence/i);
    assert.match(r.all, /"two"|'two'|\btwo\b/, 'the failure must name the offending segment');
  });

  test('validateTiming_silentSegmentWithBlankCaption_refusesRatherThanEmittingABlankCue', (t) => {
    // An absent or blank cue is not "no cue" — it is a cue that renders as an empty box
    // on screen. The accessibility cue is the ONLY thing a deaf viewer gets from a silent
    // segment, so a missing one is a refusal, not a default.
    const segments = [
      { id: 'one', startMs: 0, endMs: 1000, voiceoverText: 'hello', audio: { durationMs: 1000 } },
      { id: 'gap', startMs: 1000, endMs: 2000, voiceoverText: '', silence: { caption: '   ' } },
    ];
    const dir = makeProject(t, { 'timing.json': timingWith(segments) });

    const r = runScript('validate-timing.mjs', [], dir);

    assertCleanExit(r, EXIT.FAILED, 'a blank accessibility cue must fail: ');
    assert.match(r.all, /caption/i, 'the failure must name the field that is blank');
  });

  test('validateTiming_declaredSilentSegment_passesAndReportsItAsSilent', (t) => {
    const dir = makeProject(t, { 'timing.json': timingWith(silentMiddleSegments()) });

    const r = runScript('validate-timing.mjs', [], dir);

    assertCleanExit(r, EXIT.OK, 'a well-formed silent segment must validate: ');
    // "n/a" says the rate could not be measured. "silent" says there is no rate to
    // measure. They are different facts and only the second one is true here.
    assert.match(r.all, /intermission\s+\S+\s+silent/i, `the report must mark the segment silent, not n/a\n${r.all}`);
  });
});

// ===========================================================================
// R2 — subtitles: an authored accessibility cue spanning the window
// ===========================================================================
describe('subtitles for silent segments', () => {
  test('writeSubtitles_declaredSilentSegment_emitsItsCaptionCueSpanningTheAuthoredWindow', (t) => {
    const dir = makeProject(t, { 'timing.json': timingWith(silentMiddleSegments({ caption: '[music]' })) });

    const r = runScript('write-subtitles.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.OK, 'a silent segment must not break subtitle generation: ');
    const vtt = fs.readFileSync(path.join(dir, 'demo.vtt'), 'utf8');
    assert.match(vtt, /\[music\]/, `the authored accessibility cue must appear in the sidecar\n${vtt}`);
    // Spans the segment window EXACTLY: 480ms -> 1440ms. A silent cue is not held into the
    // following pause the way a spoken cue is — its window is authored, not measured, so
    // stretching it would make the sidecar disagree with the timeline.
    assert.match(vtt, /00:00:00\.480 --> 00:00:01\.440\s*\r?\n\[music\]/, `the cue must span the authored window\n${vtt}`);
  });

  test('writeSubtitles_projectWithEverySegmentSilent_emitsCuesInsteadOfCrashing', (t) => {
    // With no measured words anywhere, the reporting maths ran over an empty cue list:
    // `Math.max(...[])` is -Infinity and `median.toFixed(1)` throws on undefined. Captions
    // are exactly what such a project needs most, so it must produce them.
    const segments = [
      { id: 'slide', startMs: 0, endMs: 1000, voiceoverText: '', silence: { caption: '[title card]' } },
      { id: 'gap', startMs: 1000, endMs: 2000, voiceoverText: '', silence: { caption: '[music]' } },
    ];
    const dir = makeProject(t, { 'timing.json': timingWith(segments) });

    const r = runScript('write-subtitles.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.OK, 'an entirely silent project must still produce sidecars: ');
    const vtt = fs.readFileSync(path.join(dir, 'demo.vtt'), 'utf8');
    assert.match(vtt, /\[title card\]/);
    assert.match(vtt, /\[music\]/);
    assert.doesNotMatch(r.all, /Infinity|NaN/, `the report must not print a non-number\n${r.all}`);
  });

  // A narrated segment and a silent one meet with no gap between them: none is ever
  // inserted at a seam touching a silent segment. So the last spoken word can end exactly
  // where the silent cue starts, and the 40 ms clearance a cue keeps from a SPOKEN
  // neighbour would cut that word's own cue short.
  test('writeSubtitles_lastWordEndsWhereASilentCueStarts_cueRunsToTheEndOfThatWord', (t) => {
    const words = [{ word: 'Alpha', startMs: 100, endMs: 500 }, { word: 'go', startMs: 500, endMs: 960 }];
    const dir = makeProject(t, { 'timing.json': timingWith(spokenThenSilent('Alpha go.', words)) });

    const r = runScript('write-subtitles.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.OK);
    const cues = vttCues(fs.readFileSync(path.join(dir, 'demo.vtt'), 'utf8'));
    assert.deepEqual(cues, [
      { startMs: 100, endMs: 960, text: 'Alpha go.' },
      { startMs: 960, endMs: 1920, text: '[music]' },
    ], 'the spoken cue must stay on screen until its last word has been said, and no longer');
  });

  test('writeSubtitles_shortCueJustBeforeASilentCue_neverOverlapsIt', (t) => {
    // "Go." starts 30 ms before the silent cue. Clamped 40 ms short of it, its end fell
    // before its start, and the 200 ms fallback then ran it into the silent cue.
    const words = [{ word: 'Alpha', startMs: 100, endMs: 900 }, { word: 'Go', startMs: 930, endMs: 960 }];
    const dir = makeProject(t, { 'timing.json': timingWith(spokenThenSilent('Alpha. Go.', words)) });

    const r = runScript('write-subtitles.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.OK);
    const cues = vttCues(fs.readFileSync(path.join(dir, 'demo.vtt'), 'utf8'));
    assert.deepEqual(cues.slice(1), [
      { startMs: 930, endMs: 960, text: 'Go.' },
      { startMs: 960, endMs: 1920, text: '[music]' },
    ]);
    for (let i = 1; i < cues.length; i++) {
      assert.ok(cues[i - 1].endMs <= cues[i].startMs,
        `cue ${i - 1} ends at ${cues[i - 1].endMs} ms, after cue ${i} starts at ${cues[i].startMs} ms`);
    }
  });

  test('writeSubtitles_spokenWordRunningIntoASilentWindow_failsInsteadOfClampingIt', (t) => {
    // "go" ends 40 ms inside the silent window. No cue can both show that word and leave
    // the authored silent cue alone, so the contradiction is reported, not trimmed away.
    const words = [{ word: 'Alpha', startMs: 100, endMs: 500 }, { word: 'go', startMs: 500, endMs: 1000 }];
    const dir = makeProject(t, { 'timing.json': timingWith(spokenThenSilent('Alpha go.', words)) });

    const r = runScript('write-subtitles.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.FAILED, 'a spoken word inside a silent window must fail: ');
    assert.match(r.all, /timing\.segments\[0\] \("one"\): audio\.words\[1\]/, r.all);
    assert.match(r.all, /timing\.segments\[1\] \("break"\)/, 'the message must name the silent segment it runs into');
    assert.match(r.all, /remix\.mjs \(S4\)/, r.all);
    assert.doesNotMatch(r.all, /\bgo\b/, 'the narration is not repeated in a diagnostic');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['timing.json'], 'no sidecar may be written');
  });

  test('writeSubtitles_cueFollowedByASpokenCue_keepsItsClearance', (t) => {
    // REGRESSION GUARD (passes before and after). Only a cue followed by a SILENT cue
    // changed; a spoken neighbour still gets its 40 ms clearance.
    const dir = makeProject(t, { 'timing.json': timingWith(structuredClone(wordedSegments)) });

    const r = runScript('write-subtitles.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.OK);
    const [first] = vttCues(fs.readFileSync(path.join(dir, 'demo.vtt'), 'utf8'));
    assert.deepEqual(first, { startMs: 100, endMs: 2060, text: 'Hello there.' });
  });

  // timing.durationMs bounds the last cue. When the last window outruns it, the remedy
  // depends on what that window is: a silent one is a silence edit, which remix (S4)
  // reflows with no re-voice; a narrated one needs its clip measured by voice (S3).
  test('writeSubtitles_durationShorterThanAWidenedFinalSilentWindow_namesRemixNotVoice', (t) => {
    const words = [{ word: 'Alpha', startMs: 100, endMs: 500 }, { word: 'go', startMs: 500, endMs: 960 }];
    const segments = spokenThenSilent('Alpha go.', words);
    segments[1].endMs = 3960; // widened from 960 to 3000 ms; nothing has reflowed it
    segments[1].audio = { file: 'segment_02.mp3', durationMs: 960, headMs: 0, tailMs: 0, words: [] };
    // The clips the records name: remix requires them, and is named as the step only where it would run.
    const dir = makeProject(t, {
      'timing.json': timingWith(segments, { durationMs: 1920, contentMs: 1920 }),
      'segment_01.mp3': clipBytes(960, MARKER_ONE),
      'segment_02.mp3': clipBytes(960, SILENT_MARKER),
    });
    const before = fs.readdirSync(dir).sort();

    const r = runScript('write-subtitles.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.FAILED, 'a duration shorter than the last window must fail: ');
    assert.match(r.all, /no shorter than the last segment \(which ends at 3960 ms\)/, r.all);
    assert.match(r.all, /timing\.segments\[1\] \("break"\) is declared silent[^\n]*run remix\.mjs \(S4\)/, r.all);
    assert.doesNotMatch(r.all, /voice\.mjs/, `a silence edit never needs a re-voice\n${r.all}`);
    assert.deepEqual(fs.readdirSync(dir).sort(), before, 'no sidecar may be written');
  });

  test('writeSubtitles_durationShorterThanTheFinalNarratedWindow_namesTheVoiceStage', (t) => {
    const dir = makeProject(t, {
      'timing.json': timingWith(structuredClone(wordedSegments), { durationMs: 3000, contentMs: 3000 }),
    });

    const r = runScript('write-subtitles.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.FAILED, 'a duration shorter than the last window must fail: ');
    assert.match(r.all, /It bounds the last cue; run voice\.mjs \(S3\) to measure it/, r.all);
    assert.doesNotMatch(r.all, /remix/, r.all);
  });
});

// ===========================================================================
// R3 — chapters (verify the claim that this is already free, and pin it)
// ===========================================================================
describe('chapters for silent segments', () => {
  test('writeChapters_declaredSilentSegment_getsItsOwnChapterAtTheAuthoredStart', (t) => {
    // The silent segment starts at 2.4 s, so its chapter timestamp is distinguishable from
    // the first chapter's forced 0:00. At 480 ms both printed `0:00`, and a chapter wrongly
    // pinned to zero could not be told apart from a correct one.
    const segments = silentMiddleSegments();
    segments[0].endMs = 2400;
    segments[1].startMs = 2400;
    segments[1].endMs = 3360;
    segments[1].visual = { title: 'Intermission' };
    segments[2].startMs = 3360;
    segments[2].endMs = 4080;
    segments[2].audio.words = shiftWords(segments[2].audio.words, 1920);
    const dir = makeProject(t, { 'timing.json': timingWith(segments) });

    // --list needs no ffmpeg and no rendered MP4, so this pins the chapter maths itself.
    const r = runScript('write-chapters.mjs', ['--list'], dir);

    assertCleanExit(r, EXIT.OK, 'chapters must not need narration: ');
    assert.match(r.all, /^0:00\s+one$/m);
    assert.match(r.all, /^0:02\s+Intermission$/m, `the silent segment's chapter must start at its authored 2.4 s\n${r.all}`);
    assert.match(r.all, /^0:03\s+three$/m, r.all);
  });
});

// ===========================================================================
// A durationMs short of the last window: which stage re-measures it. write-subtitles and
// write-chapters are both bounded by it, and both ask silent-segment.mjs, so one edit is
// never sent to two different stages.
// ===========================================================================
describe('the remedy for a durationMs short of the timeline', () => {
  const alphaGo = [{ word: 'Alpha', startMs: 100, endMs: 500 }, { word: 'go', startMs: 500, endMs: 960 }];

  test('writeChapters_durationShorterThanAWidenedFinalSilentWindow_namesRemixNotVoice', (t) => {
    const segments = spokenThenSilent('Alpha go.', alphaGo);
    segments[1].endMs = 3960; // widened from 960 to 3000 ms; nothing has reflowed it
    segments[1].audio = { file: 'segment_02.mp3', durationMs: 960, headMs: 0, tailMs: 0, words: [] };
    const dir = makeProject(t, {
      'timing.json': timingWith(segments, { durationMs: 1920, contentMs: 1920 }),
      'segment_01.mp3': clipBytes(960, MARKER_ONE),
      'segment_02.mp3': clipBytes(960, SILENT_MARKER),
    });

    const r = runScript('write-chapters.mjs', ['--list'], dir);

    assertCleanExit(r, EXIT.FAILED, 'a duration shorter than the last window must fail: ');
    assert.match(r.all, /no shorter than the last segment \(which ends at 3960 ms\)/, r.all);
    assert.match(r.all, /It closes the last chapter, and timing\.segments\[1\] \("break"\) is declared silent[^\n]*run remix\.mjs \(S4\)/, r.all);
    assert.doesNotMatch(r.all, /voice\.mjs/, `a silence edit never needs a re-voice\n${r.all}`);
  });

  test('writeChapters_durationShorterThanTheFinalNarratedWindow_namesTheVoiceStage', (t) => {
    const dir = makeProject(t, {
      'timing.json': timingWith(structuredClone(wordedSegments), { durationMs: 3000, contentMs: 3000 }),
    });

    const r = runScript('write-chapters.mjs', ['--list'], dir);

    assertCleanExit(r, EXIT.FAILED, 'a duration shorter than the last window must fail: ');
    assert.match(r.all, /It closes the last chapter; run voice\.mjs \(S3\) to measure it/, r.all);
    assert.doesNotMatch(r.all, /remix/, r.all);
  });

  for (const [stage, script, args] of [
    ['writeSubtitles', 'write-subtitles.mjs', ['--apply']],
    ['writeChapters', 'write-chapters.mjs', ['--list']],
  ]) {
    // A silence edit need not touch the last window: widen the intermission and move what
    // follows it, and the window that outruns durationMs is a narrated one.
    test(`${stage}_durationShortAfterAMiddleSilentWindowWasWidened_namesRemixNotVoice`, (t) => {
      const dir = makeProject(t, { 'timing.json': timingWith(widenedIntermission(), { durationMs: 2160, contentMs: 2160 }), ...voicedClips() });
      const before = fs.readdirSync(dir).sort();

      const r = runScript(script, args, dir);

      assertCleanExit(r, EXIT.FAILED, 'a duration shorter than the last window must fail: ');
      assert.match(r.all, /no shorter than the last segment \(which ends at 4200 ms\)/, r.all);
      assert.match(r.all, /timing\.segments\[1\] \("intermission"\) is declared silent[^\n]*run remix\.mjs \(S4\)/, r.all);
      assert.doesNotMatch(r.all, /voice\.mjs/, `a silence edit never needs a re-voice\n${r.all}`);
      assert.deepEqual(fs.readdirSync(dir).sort(), before, 'nothing may be written');
    });

    // The same edit where the intermission's record names its clip but gives no length: it
    // cannot show the window was edited, and it cannot show it was not. remix is still the
    // repair — it regenerates that silence and writes the length — and it is the stage
    // validate-timing names for that record, so this stage must not send it to a re-voice.
    test(`${stage}_durationShortAfterAMiddleSilentWindowWhoseRecordHasNoLength_namesRemixNotVoice`, (t) => {
      const segments = widenedIntermission();
      delete segments[1].audio.durationMs;
      const dir = makeProject(t, { 'timing.json': timingWith(segments, { durationMs: 2160, contentMs: 2160 }), ...voicedClips() });
      const before = fs.readdirSync(dir).sort();

      const r = runScript(script, args, dir);

      assertCleanExit(r, EXIT.FAILED, 'a duration shorter than the last window must fail: ');
      assert.match(r.all,
        /timing\.segments\[1\] \("intermission"\) is declared silent, but its audio record has no durationMs[^\n]*run remix\.mjs \(S4\)/, r.all);
      assert.doesNotMatch(r.all, /voice\.mjs/, `remix repairs this record with no re-voice\n${r.all}`);
      assert.doesNotMatch(r.all, /window no longer holds/, `nothing shows the window was edited\n${r.all}`);
      assert.deepEqual(fs.readdirSync(dir).sort(), before, 'nothing may be written');
    });

    // A silent segment whose record names no clip is one the voice stage has not run for,
    // and remix refuses it: naming remix would send the author to a refusal.
    test(`${stage}_durationShortOfAFinalSilentWindowNamingNoClip_namesTheVoiceStage`, (t) => {
      const segments = spokenThenSilent('Alpha go.', alphaGo);
      segments[1].endMs = 3960;
      const dir = makeProject(t, { 'timing.json': timingWith(segments, { durationMs: 1920, contentMs: 1920 }) });

      const r = runScript(script, args, dir);

      assertCleanExit(r, EXIT.FAILED, 'a duration shorter than the last window must fail: ');
      assert.match(r.all, /timing\.segments\[1\] \("break"\) is declared silent but no audio\.file names its clip[^\n]*voice\.mjs \(S3\)/, r.all);
      assert.doesNotMatch(r.all, /remix/, r.all);
    });
  }

  // The remix remedy named above, run: it reflows the timeline and rewrites durationMs with
  // it, and both stages then accept the timeline. For a record that describes the old window
  // and for one that gives no length.
  for (const [record, audio] of [
    ['DescribingTheOldWindow', { file: 'segment_001.mp3', durationMs: 960, headMs: 0, tailMs: 0, words: [] }],
    ['WithNoLength', { file: 'segment_001.mp3', words: [] }],
  ]) {
    test(`durationShortfall_middleSilentRecord${record}_isRepairedByTheRemixItNames`, (t) => {
      const segments = widenedIntermission();
      segments[1].audio = audio;
      const dir = makeProject(t, {
        'timing.json': timingWith(segments, { durationMs: 2160, contentMs: 2160 }),
        'calibration-observed.json': voiceCalibration(),
        'segment_000.mp3': clipBytes(480, MARKER_ONE),
        'segment_001.mp3': clipBytes(960, SILENT_MARKER),
        'segment_002.mp3': clipBytes(720, MARKER_THREE),
      });
      const stages = [['write-subtitles.mjs', ['--apply']], ['write-chapters.mjs', ['--list']]];
      for (const [script, args] of stages) {
        const before = runScript(script, args, dir);
        assertCleanExit(before, EXIT.FAILED, `${script} must refuse the short duration first: `);
        assert.match(before.all, /timing\.segments\[1\] \("intermission"\) is declared silent[^\n]*remix\.mjs \(S4\)/, before.all);
      }

      assertCleanExit(runScript('remix.mjs', ['--apply', '--replace'], dir, { nodeArgs: ['--import', FAKE_AUDIO] }), EXIT.OK,
        'the named remedy must run: ');
      const produced = JSON.parse(fs.readFileSync(path.join(dir, 'timing.json'), 'utf8'));
      assert.ok(produced.durationMs >= produced.segments.at(-1).endMs,
        `durationMs ${produced.durationMs} must cover the last window, which ends at ${produced.segments.at(-1).endMs}`);

      for (const [script, args] of stages) {
        assertCleanExit(runScript(script, args, dir), EXIT.OK, `${script} after the remedy: `);
      }
    });
  }
});

// ===========================================================================
// R4 — audio timeline integrity. The hard requirement.
// ===========================================================================
describe('concat-audio timeline integrity', () => {
  /**
   * segment_000 480ms (marker 0x11) | intermission 960ms, NO CLIP | segment_002 720ms (0x33)
   *
   * The silent segment must occupy its authored 960ms as generated digital silence, so
   * `three` still starts at 1440ms. Omitting it would start `three` at 480ms — audible as
   * the whole back half of the video being a second early against the picture.
   */
  function silentGapProject(t, extra = {}) {
    return makeProject(t, {
      'timing.json': timingWith(silentMiddleSegments()),
      'silence.mp3': clipBytes(240, 0x77),
      'segment_000.mp3': clipBytes(480, MARKER_ONE),
      'segment_002.mp3': clipBytes(720, MARKER_THREE),
      ...extra,
    });
  }

  test('concatAudio_declaredSilentSegmentWithNoClip_occupiesItsAuthoredDurationAsGeneratedSilence', (t) => {
    const dir = silentGapProject(t);

    const r = runScript('concat-audio.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.OK, 'a declared silent segment must concatenate: ');
    const out = fs.readFileSync(path.join(dir, 'voiceover.mp3'));

    // TOTAL DURATION: 480 + 960 + 720 = 2160ms. No inter-segment silence is inserted
    // beside a declared silent segment — the authored silence IS the gap, and inserting
    // more would make the audio longer than the timeline that describes it.
    assert.equal(out.length, msToBytes(480) + msToBytes(960) + msToBytes(720),
      `total voice-track duration is ${(out.length / FRAME_BYTES) * FRAME_MS}ms, expected 2160ms`);

    // EVERY SEGMENT'S OFFSET, read back off the track itself.
    assert.equal(markerAtMs(out, 0), MARKER_ONE, 'segment one must start at 0ms');
    assert.equal(markerAtMs(out, 456), MARKER_ONE, 'segment one must still be playing at 456ms');
    assert.equal(markerAtMs(out, 480), SILENT_MARKER, 'the intermission must begin at 480ms');
    assert.equal(markerAtMs(out, 1416), SILENT_MARKER, 'the intermission must still be silent at 1416ms');
    assert.equal(markerAtMs(out, 1440), MARKER_THREE, 'segment three must begin at 1440ms, not earlier');
    assert.equal(markerAtMs(out, 2136), MARKER_THREE, 'segment three must run to the end of the track');
  });

  test('concatAudio_narratedSegmentWithNoClip_failsRatherThanShiftingEverySegmentAfterIt', (t) => {
    // The same hole, NOT declared. Dropping it silently is the corruption above; the only
    // safe response is to refuse, because nothing on disk says how long it should be.
    const segments = silentMiddleSegments();
    delete segments[1].silence;
    segments[1].voiceoverText = 'this segment was never synthesised';
    const dir = makeProject(t, {
      'timing.json': timingWith(segments),
      'silence.mp3': clipBytes(240, 0x77),
      'segment_000.mp3': clipBytes(480, MARKER_ONE),
      'segment_002.mp3': clipBytes(720, MARKER_THREE),
    });

    const r = runScript('concat-audio.mjs', ['--apply'], dir);

    assert.notEqual(r.code, EXIT.OK, `a missing narrated clip must not concatenate\n${r.all}`);
    assert.match(r.all, /intermission/, 'the failure must name the segment with no clip');
    assert.equal(fs.existsSync(path.join(dir, 'voiceover.mp3')), false,
      'a refused concatenation must not leave a corrupt voiceover.mp3 behind');
  });

  test('concatAudio_noFlags_planNamesTheGeneratedSilenceWithoutWritingIt', (t) => {
    const dir = silentGapProject(t);

    const r = runScript('concat-audio.mjs', [], dir);

    assert.equal(r.code, EXIT.OK, `a plan run must succeed\n${r.all}`);
    assert.equal(fs.existsSync(path.join(dir, 'voiceover.mp3')), false, 'a plan run must write nothing');
    assert.match(r.all, /intermission/, 'the plan must disclose the segment it will generate silence for');
    assert.match(r.all, /960\s*ms/i, `the plan must state the duration it will generate\n${r.all}`);
  });

  test('concatAudio_authoredWindowNotAWholeNumberOfFrames_disclosesTheQuantisationDelta', (t) => {
    // Generated silence lands on whole 24ms frames, so a 1000ms window becomes 1008ms.
    // Across several silent segments that accumulates into real drift against the
    // timeline, so the stage must SAY so rather than absorb it: drift nothing prints is
    // drift nobody finds.
    const segments = [
      { id: 'one', startMs: 0, endMs: 480, voiceoverText: 'hello there friend', audio: { file: 'segment_000.mp3', durationMs: 480, words: silentMiddleSegments()[0].audio.words } },
      { id: 'gap', startMs: 480, endMs: 1480, voiceoverText: '', silence: { caption: '[music]' } },
    ];
    const dir = makeProject(t, {
      'timing.json': timingWith(segments),
      'silence.mp3': clipBytes(240, 0x77),
      'segment_000.mp3': clipBytes(480, MARKER_ONE),
    });

    const r = runScript('concat-audio.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.OK, 'a non-frame-aligned window must still concatenate: ');
    assert.match(r.all, /\+8ms/, `the 1000ms window becomes 1008ms and that must be disclosed\n${r.all}`);
    // A silence edit is routed to S4: the stage that reflows the timeline onto the audio
    // without re-voicing is remix. Sending the author to the voice stage would re-synthesise
    // every clip to fix a number that has nothing to do with narration.
    assert.match(r.all, /remix\.mjs \(S4\)/, `the note must name the S4 stage that reflows\n${r.all}`);
    assert.doesNotMatch(r.all, /voice\.mjs/, 'a silence-only edit must never be sent to the voice stage');
    const out = fs.readFileSync(path.join(dir, 'voiceover.mp3'));
    assert.equal(out.length, msToBytes(480) + msToBytes(1008), 'the track must contain the silence that was actually generated');
  });

  test('concatAudio_silentWindowWidenedAfterVoiceRan_generatesTheAuthoredWindowNotTheOldClip', (t) => {
    // voice generated segment_001.mp3 for a 960 ms window; the window is now 3000 ms.
    const segments = voicedSilentMiddle();
    segments[1].endMs = 3480;
    segments[2].startMs = 3480;
    segments[2].endMs = 4200;
    segments[2].audio.words = shiftWords(segments[2].audio.words, 2040);
    const oldClip = clipBytes(960, SILENT_MARKER);
    const dir = makeProject(t, {
      'timing.json': timingWith(segments),
      'silence.mp3': clipBytes(240, 0x77),
      'segment_000.mp3': clipBytes(480, MARKER_ONE),
      'segment_001.mp3': oldClip,
      'segment_002.mp3': clipBytes(720, MARKER_THREE),
    });

    const r = runScript('concat-audio.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.OK, 'a widened silent window must concatenate: ');
    const out = fs.readFileSync(path.join(dir, 'voiceover.mp3'));
    assert.equal(out.length, msToBytes(480) + msToBytes(3000) + msToBytes(720),
      `the track is ${(out.length / FRAME_BYTES) * FRAME_MS}ms; the timeline says 4200ms`);
    assert.equal(markerAtMs(out, 480), SILENT_MARKER, 'the intermission must begin at 480ms');
    assert.equal(markerAtMs(out, 3456), SILENT_MARKER, 'and still be silent at 3456ms');
    assert.equal(markerAtMs(out, 3480), MARKER_THREE, 'segment three must begin where the timeline puts it, at 3480ms');
    assert.ok(fs.readFileSync(path.join(dir, 'segment_001.mp3')).equals(oldClip), 'concat writes only its --out');
  });

  test('concatAudio_narratedSegmentDeclaredSilentAfterVoiceRan_generatesSilenceInsteadOfTheOldSpeech', (t) => {
    // Declared silent in timing.json alone: the record still names the speech clip voice
    // made for it, and still carries that clip's words.
    const segments = silentMiddleSegments();
    segments[1].audio = { file: 'segment_001.mp3', durationMs: 960, headMs: 0, tailMs: 0, words: [{ word: 'old', startMs: 480, endMs: 1440 }] };
    const MARKER_SPEECH = 0x22;
    const dir = makeProject(t, {
      'timing.json': timingWith(segments),
      'silence.mp3': clipBytes(240, 0x77),
      'segment_000.mp3': clipBytes(480, MARKER_ONE),
      'segment_001.mp3': clipBytes(960, MARKER_SPEECH),
      'segment_002.mp3': clipBytes(720, MARKER_THREE),
    });

    const plan = runScript('concat-audio.mjs', [], dir);

    assertCleanExit(plan, EXIT.OK);
    assert.match(plan.all,
      /\+ segment "intermission" — GENERATE 960ms of digital silence from its authored window \(declared silent; segment_001\.mp3, which its record names, is not used and is left as it is\)/,
      plan.all);
    assert.doesNotMatch(plan.all, /^\s+\+ segment_001\.mp3/m, 'the speech clip must not be planned into the track');
    assert.doesNotMatch(plan.all, /segment_001\.mp3 is on disk but no segment claims it/, 'a clip a segment still names is not an orphan');

    const r = runScript('concat-audio.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.OK);
    const out = fs.readFileSync(path.join(dir, 'voiceover.mp3'));
    assert.equal(out.length, msToBytes(480) + msToBytes(960) + msToBytes(720));
    for (const ms of [480, 960, 1416]) {
      assert.equal(markerAtMs(out, ms), SILENT_MARKER, `a segment declared silent must be silent at ${ms}ms`);
    }
    assert.equal(out.includes(Buffer.alloc(8, MARKER_SPEECH)), false, 'the old speech must not be anywhere in the track');
  });

  test('concatAudio_narratedSegmentWhoseRecordHoldsNoWords_isRefusedNamingTheVoiceStage', (t) => {
    // The intermission's declaration is removed and narration added in timing.json only.
    // Its clip is still the silence voice generated: there is no narration to play.
    for (const edit of [(audio) => { audio.words = []; }, (audio) => { delete audio.words; }]) {
      const segments = voicedSilentMiddle();
      delete segments[1].silence;
      segments[1].voiceoverText = 'now it speaks';
      edit(segments[1].audio);
      const dir = makeProject(t, {
        'timing.json': timingWith(segments),
        'silence.mp3': clipBytes(240, 0x77),
        'segment_000.mp3': clipBytes(480, MARKER_ONE),
        'segment_001.mp3': clipBytes(960, SILENT_MARKER),
        'segment_002.mp3': clipBytes(720, MARKER_THREE),
      });

      for (const args of [[], ['--apply']]) {
        const r = runScript('concat-audio.mjs', args, dir);

        assertCleanExit(r, EXIT.USAGE, `concat ${args.join(' ') || '(plan)'} must refuse narration that was never synthesised: `);
        assert.match(r.all, /segment "intermission"/, r.all);
        assert.match(r.all, /voice\.mjs \(S3\)/, r.all);
        assert.equal(fs.existsSync(path.join(dir, 'voiceover.mp3')), false, 'nothing may be written');
      }
    }
  });

  test('concatAudio_positionalProjectWithASilentSegment_isRefusedBeforeAnyWrite', (t) => {
    // No segment names its clip, so clips can only be matched to segments by position —
    // and once a segment is silent, a directory listing cannot say which clip is whose.
    const segments = silentMiddleSegments();
    for (const s of segments) delete s.audio;
    const dir = makeProject(t, {
      'timing.json': timingWith(segments),
      'silence.mp3': clipBytes(240, 0x77),
      'segment_01.mp3': clipBytes(480, MARKER_ONE),
      'segment_02.mp3': clipBytes(960, 0x22),
      'segment_03.mp3': clipBytes(720, MARKER_THREE),
    });

    for (const args of [[], ['--apply']]) {
      const r = runScript('concat-audio.mjs', args, dir);

      assertCleanExit(r, EXIT.USAGE, `concat ${args.join(' ') || '(plan)'} must refuse to guess: `);
      assert.match(r.all, /segment "intermission"/, r.all);
      assert.match(r.all, /audio\.file/, 'the refusal must offer naming each clip');
      assert.match(r.all, /voice\.mjs \(S3\)/, 'and the voice stage');
      assert.equal(fs.existsSync(path.join(dir, 'voiceover.mp3')), false, 'nothing may be written');
    }
  });

  test('concatAudio_positionalProjectWithNoSilentSegment_concatenatesInOrderAsBefore', (t) => {
    // REGRESSION GUARD (passes before and after): positional mode without silence is
    // unchanged, orphan report included.
    const segments = [
      { id: 'one', startMs: 0, endMs: 480, voiceoverText: 'hello there friend' },
      { id: 'two', startMs: 720, endMs: 1440, voiceoverText: 'and we are back' },
    ];
    const dir = makeProject(t, {
      'timing.json': timingWith(segments),
      'silence.mp3': clipBytes(240, 0x77),
      'segment_01.mp3': clipBytes(480, MARKER_ONE),
      'segment_02.mp3': clipBytes(720, MARKER_THREE),
      'segment_03.mp3': clipBytes(240, 0x22),
    });

    const r = runScript('concat-audio.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.OK);
    assert.match(r.all, /warning: segment_03\.mp3 is on disk but no segment claims it — it was NOT included/);
    const out = fs.readFileSync(path.join(dir, 'voiceover.mp3'));
    assert.ok(out.equals(Buffer.concat([clipBytes(480, MARKER_ONE), clipBytes(240, 0x77), clipBytes(720, MARKER_THREE)])));
  });

  test('concatAudio_defaultOutputIsALink_isRefusedButANamedOutFollowsIt', (t) => {
    // voiceover.mp3 is a name the ENGINE chose when --out is omitted, so a link there is
    // refused. Naming --out is the caller choosing the destination, link and all.
    const TARGET = 'MUST SURVIVE';
    const dir = silentGapProject(t, { 'music.wav': TARGET });
    if (!tryMakeFileLink(path.join(dir, 'voiceover.mp3'), path.join(dir, 'music.wav'))) {
      return t.skip('platform refused to create a file link');
    }

    const refused = runScript('concat-audio.mjs', ['--apply', '--replace'], dir);

    assertCleanExit(refused, EXIT.USAGE, 'the default output must not be written through a link: ');
    assert.match(refused.all, /voiceover\.mp3.*is a link/, refused.all);
    assert.equal(fs.readFileSync(path.join(dir, 'music.wav'), 'utf8'), TARGET, 'the link target must keep its bytes');

    const named = runScript('concat-audio.mjs', ['--apply', '--replace', '--out', 'voiceover.mp3'], dir);

    assertCleanExit(named, EXIT.OK, 'a caller-named --out is resolved as it always was: ');
    assert.equal(fs.readFileSync(path.join(dir, 'music.wav')).length, msToBytes(2160), 'the named output follows the link');
  });

  test('concatAudio_positionalProjectWithAnEarlierMissingClip_isRefusedAsAmbiguousNotAsMissing', (t) => {
    // No clip is on disk, so segment one — narrated, and first — has none. The positional
    // refusal does not depend on reaching the silent segment: once any segment is silent,
    // no clip can be matched by position, so that is the reason, and it is exit 2.
    const segments = silentMiddleSegments();
    for (const s of segments) delete s.audio;
    const dir = makeProject(t, { 'timing.json': timingWith(segments), 'silence.mp3': clipBytes(240, 0x77) });

    for (const args of [[], ['--apply']]) {
      const r = runScript('concat-audio.mjs', args, dir);

      assertCleanExit(r, EXIT.USAGE, `concat ${args.join(' ') || '(plan)'} must refuse to guess before consuming any clip: `);
      assert.match(r.all, /segment "intermission" is declared silent, but no segment in timing\.json names its clip/, r.all);
      assert.doesNotMatch(r.all, /has no clip to concatenate/, r.all);
      assert.equal(fs.existsSync(path.join(dir, 'voiceover.mp3')), false, 'nothing may be written');
    }
  });

  test('concatAudio_positionalProjectWithAMalformedSilentDeclaration_stillFailsOnTheDeclaration', (t) => {
    // REGRESSION GUARD (passes before and after): the declaration is checked before the
    // positional refusal, so a malformed one is still reported as such, with exit 1.
    const segments = silentMiddleSegments({ caption: '   ' });
    for (const s of segments) delete s.audio;
    const dir = makeProject(t, {
      'timing.json': timingWith(segments),
      'silence.mp3': clipBytes(240, 0x77),
      'segment_01.mp3': clipBytes(480, MARKER_ONE),
      'segment_02.mp3': clipBytes(720, MARKER_THREE),
    });

    const r = runScript('concat-audio.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.FAILED);
    assert.match(r.all, /segment "intermission" is declared silent but its `silence\.caption` is "   "/, r.all);
  });

  // A clip a record names is claimed under the name discovery lists, so it is never called an
  // orphan. When that name is a link, the file it resolves to is claimed too: the link plays
  // it, and reporting it as unclaimed invites deleting what the link needs.
  const orphanLine = (name) => new RegExp(`${name.replace('.', '\\.')} is on disk but no segment claims it`);

  test('concatAudio_silentRecordNamingAnInRootLink_claimsTheLinkAndItsTarget', (t) => {
    for (const [recordNames, linkAt, target] of [
      ['segment_001.mp3', 'segment_001.mp3', 'clips/intermission.mp3'],
      ['intermission-link.mp3', 'intermission-link.mp3', 'segment_001.mp3'],
    ]) {
      const segments = voicedSilentMiddle();
      segments[1].audio.file = recordNames;
      const dir = makeProject(t, {
        'timing.json': timingWith(segments),
        'silence.mp3': clipBytes(240, 0x77),
        'segment_000.mp3': clipBytes(480, MARKER_ONE),
        [target]: clipBytes(960, SILENT_MARKER),
        'segment_002.mp3': clipBytes(720, MARKER_THREE),
      });
      if (!tryMakeFileLink(path.join(dir, linkAt), path.join(dir, target))) {
        return t.skip('platform refused to create a file link');
      }
      // The record names the link, so the link is the name printed, with its target beside it.
      const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const named = `${escape(recordNames)} \\(a link to ${escape(path.join(...target.split('/')))}\\), which its record names`;

      for (const args of [[], ['--apply']]) {
        const r = runScript('concat-audio.mjs', args, dir);

        assertCleanExit(r, EXIT.OK);
        assert.doesNotMatch(r.all, orphanLine('segment_001.mp3'), `${recordNames} -> ${target}: a clip a record names is not an orphan\n${r.all}`);
        assert.doesNotMatch(r.all, / is on disk but no segment claims it/, r.all);
        assert.match(r.all,
          new RegExp(args.length ? `; ${named}, was not used\\)` : `\\(declared silent; ${named}, is not used and is left as it is\\)`), r.all);
      }
    }
  });

  test('concatAudio_narratedRecordNamingAnInRootLink_claimsTheLinkAndItsTarget', (t) => {
    for (const [recordNames, linkAt, target] of [
      ['segment_000.mp3', 'segment_000.mp3', 'clips/one.mp3'],
      ['one-link.mp3', 'one-link.mp3', 'segment_000.mp3'],
    ]) {
      const segments = voicedSilentMiddle();
      segments[0].audio.file = recordNames;
      const dir = makeProject(t, {
        'timing.json': timingWith(segments),
        'silence.mp3': clipBytes(240, 0x77),
        [target]: clipBytes(480, MARKER_ONE),
        'segment_001.mp3': clipBytes(960, SILENT_MARKER),
        'segment_002.mp3': clipBytes(720, MARKER_THREE),
      });
      if (!tryMakeFileLink(path.join(dir, linkAt), path.join(dir, target))) {
        return t.skip('platform refused to create a file link');
      }

      for (const args of [[], ['--apply']]) {
        const r = runScript('concat-audio.mjs', args, dir);

        assertCleanExit(r, EXIT.OK);
        assert.doesNotMatch(r.all, orphanLine('segment_000.mp3'), `${recordNames} -> ${target}: a clip a record names is not an orphan\n${r.all}`);
        assert.doesNotMatch(r.all, / is on disk but no segment claims it/, r.all);
      }
    }
  });

  test('concatAudio_recordNamingItsClipInAnotherCase_claimsTheClipDiscoveryLists', (t) => {
    // Windows file names are case-insensitive: SEGMENT_000.MP3 opens segment_000.mp3.
    if (process.platform !== 'win32') return t.skip('file names are case-sensitive on this platform');
    const segments = voicedSilentMiddle();
    segments[0].audio.file = 'SEGMENT_000.MP3';
    segments[1].audio.file = 'Segment_001.MP3';
    const dir = makeProject(t, {
      'timing.json': timingWith(segments),
      'silence.mp3': clipBytes(240, 0x77),
      'segment_000.mp3': clipBytes(480, MARKER_ONE),
      'segment_001.mp3': clipBytes(960, SILENT_MARKER),
      'segment_002.mp3': clipBytes(720, MARKER_THREE),
    });

    const r = runScript('concat-audio.mjs', [], dir);

    assertCleanExit(r, EXIT.OK);
    assert.doesNotMatch(r.all, / is on disk but no segment claims it/, r.all);
  });
});

// ===========================================================================
// R5 — calibration excludes silent segments (the NaN -> null poison)
// ===========================================================================
describe('calibration excludes silent segments', () => {
  test('buildCalibration_silentSegment_isExcludedFromTheAggregateWordRate', async () => {
    const { buildCalibration } = await import('../src/silent-segment.mjs');
    const segments = silentMiddleSegments();
    const clips = [
      { durationMs: 480, headMs: 0, tailMs: 0 },
      { durationMs: 960, headMs: 0, tailMs: 0 },
      { durationMs: 720, headMs: 0, tailMs: 0 },
    ];

    const cal = buildCalibration(segments, clips, { voiceId: 'en-US-AvaNeural', roundedSpeed: 1 });

    // 3 words in 480ms + 4 words in 720ms = 7 words in 1200ms of speech. The silent
    // segment's 960ms is NOT speech and its 0 words are NOT a slow rate, so including
    // either would drag the measured rate down with a number that measures nothing.
    assert.equal(cal.aggregate.words, 7, 'the silent segment must not contribute words');
    assert.equal(cal.aggregate.speechMs, 1200, 'the silent segment must not contribute speech time');
    assert.equal(cal.aggregate.observedEffWps, 5.833);
  });

  test('buildCalibration_silentSegment_carriesNoWordRateAtAllRatherThanZeroOrNull', async () => {
    const { buildCalibration } = await import('../src/silent-segment.mjs');
    const segments = silentMiddleSegments();
    const clips = [
      { durationMs: 480, headMs: 0, tailMs: 0 },
      { durationMs: 960, headMs: 0, tailMs: 0 },
      { durationMs: 720, headMs: 0, tailMs: 0 },
    ];

    const cal = buildCalibration(segments, clips, { voiceId: 'en-US-AvaNeural', roundedSpeed: 1 });
    const silent = cal.segments.find((s) => s.id === 'intermission');

    assert.equal(silent.silent, true, 'the calibration entry must say WHY it carries no rate');
    assert.equal(Object.hasOwn(silent, 'effWps'), false,
      'a rate over zero words is not a slow rate — the key must be absent, not 0/NaN');

    // The poison this pins: `+(0/(0/1000)).toFixed(3)` is NaN, and JSON.stringify writes
    // NaN as `null`. validate-timing then requires that value finite and reports a
    // DIFFERENT failure than the one that happened, in a file the author never edited.
    const roundTripped = JSON.parse(JSON.stringify(cal));
    const nulls = JSON.stringify(roundTripped).match(/:null/g) ?? [];
    assert.equal(nulls.length, 0, `calibration must contain no null-from-NaN values: ${JSON.stringify(roundTripped)}`);
    assert.ok(Number.isFinite(roundTripped.aggregate.observedEffWps));
    assert.ok(Number.isFinite(roundTripped.aggregate.observedSafeWps));
  });

  test('buildCalibration_everySegmentSilent_refusesInsteadOfWritingANullRate', async () => {
    const { buildCalibration } = await import('../src/silent-segment.mjs');
    const segments = [
      { id: 'slide', startMs: 0, endMs: 1000, voiceoverText: '', silence: { caption: '[title]' } },
    ];

    // 0 words / 0ms is NaN, serialises as null, and validate-timing then reports "carries
    // no aggregate.observedEffWps" — a true statement about a cause that is not the real
    // one. Refusing here names the actual situation.
    assert.throws(
      () => buildCalibration(segments, [{ durationMs: 1000, headMs: 0, tailMs: 0 }], { voiceId: 'v', roundedSpeed: 1 }),
      /silent/i,
    );
  });

  test('validateTiming_calibrationCoveringASilentSegment_keepsLineageIntact', (t) => {
    // Silent segments stay in the calibration POSITIONALLY so the lineage check — which
    // compares segment-by-segment by index — still lines up. Dropping them would make
    // every silent project report "the timeline has 3 segment(s) but the calibration
    // measured 2", which is a lineage failure caused by the fix rather than by the data.
    //
    // Real fingerprints, exactly as voice.mjs writes them, so lineage CAN be intact — and
    // the test asserts that it is, rather than only that nothing crashed.
    const segments = voicedSilentMiddle();
    const dir = makeProject(t, { 'timing.json': timingWith(segments), 'calibration-observed.json': voiceCalibration() });

    const r = runScript('validate-timing.mjs', [], dir);

    assertCleanExit(r, EXIT.OK, 'a calibration covering a silent segment must validate: ');
    assert.doesNotMatch(r.all, /the timeline has \d+ segment\(s\) but the calibration measured/,
      `silent segments must not be read as a segment-count mismatch\n${r.all}`);
    assert.doesNotMatch(r.all, /calibration lineage:/, `lineage must be intact, neither STALE nor UNPROVEN\n${r.all}`);
    assert.match(r.all, /word budget: NOT EVALUATED — these windows were measured FROM this audio/, r.all);

    // The same files, with the declaration removed: the calibration measured silence where
    // the timeline now expects narration, so it no longer covers the timeline.
    delete segments[1].silence;
    fs.writeFileSync(path.join(dir, 'timing.json'), timingWith(segments));

    const undeclared = runScript('validate-timing.mjs', [], dir);

    assert.match(undeclared.all, /calibration lineage: STALE — segment "intermission"[^\n]*declar/, undeclared.all);
    assert.doesNotMatch(undeclared.all, /word budget: NOT EVALUATED/, undeclared.all);
  });
});

// ===========================================================================
// S4 silence edits and the records validate-timing reads
// ===========================================================================
describe('validate-timing after a silence edit', () => {
  test('validateTiming_silentSegmentWhoseRecordStillCarriesWords_failsNamingRemix', (t) => {
    // A narrated segment declared silent and then concatenated WITHOUT remix: the
    // voice track is right, but the record still carries the old speech's words.
    const segments = voicedSilentMiddle();
    segments[1].audio.words = [{ word: 'old', startMs: 480, endMs: 1440 }];
    const dir = makeProject(t, { 'timing.json': timingWith(segments) });

    const r = runScript('validate-timing.mjs', [], dir);

    assertCleanExit(r, EXIT.FAILED, 'a record contradicting its declaration must fail: ');
    assert.match(r.all, /declared silence: STALE RECORD/, r.all);
    assert.match(r.all, /segment "intermission"[^\n]*1 measured word/, r.all);
    assert.match(r.all, /remix\.mjs \(S4\)/, r.all);
    assert.doesNotMatch(r.all, /declared silence: OK/, r.all);
    assert.doesNotMatch(r.all, /\bold\b/, 'the stale word itself is not repeated');
  });

  test('validateTiming_silentWindowWidenedThenRemixed_keepsLineageIntact', (t) => {
    // A silence edit followed by remix: the window and the record now say 3000 ms, the
    // calibration still says 960. The calibration measures NARRATION, and none changed.
    const segments = voicedSilentMiddle();
    segments[1].endMs = 3480;
    segments[1].audio.durationMs = 3000;
    segments[2].startMs = 3480;
    segments[2].endMs = 4200;
    segments[2].audio.words = shiftWords(segments[2].audio.words, 2040);
    const dir = makeProject(t, { 'timing.json': timingWith(segments), 'calibration-observed.json': voiceCalibration() });

    const r = runScript('validate-timing.mjs', [], dir);

    assertCleanExit(r, EXIT.OK);
    assert.doesNotMatch(r.all, /calibration lineage: STALE/, `an authored silent window is not stale narration\n${r.all}`);
    assert.doesNotMatch(r.all, /Re-run the\s+voice stage/, r.all);
    assert.match(r.all, /word budget: NOT EVALUATED/, r.all);
  });

  test('validateTiming_narratedWindowChangedSinceMeasured_isStillStale', (t) => {
    // REGRESSION GUARD (passes before and after): only a SILENT window stopped counting.
    const segments = voicedSilentMiddle();
    segments[2].endMs = 2400;
    segments[2].audio.durationMs = 960;
    const dir = makeProject(t, { 'timing.json': timingWith(segments), 'calibration-observed.json': voiceCalibration() });

    const r = runScript('validate-timing.mjs', [], dir);

    assert.match(r.all, /calibration lineage: STALE — segment "three" window is 960ms but the measured clip was 720ms/, r.all);
    assert.match(r.all, /Re-run the\s+voice stage/, r.all);
  });

  test('validateTiming_segmentDeclaredSilentSinceMeasured_isStaleNamingTheDeclarationAndRemix', (t) => {
    // three is silenced and remixed: its record now describes generated silence, but the
    // calibration row voice wrote measured it as narration. The words differ too, but
    // the cause is the declaration, and the remedy for a silence edit is S4, not S3.
    const segments = voicedSilentMiddle();
    segments[2].voiceoverText = '';
    segments[2].silence = { caption: '[applause]' };
    segments[2].audio = { file: 'segment_002.mp3', durationMs: 720, headMs: 0, tailMs: 0, words: [] };
    const dir = makeProject(t, { 'timing.json': timingWith(segments), 'calibration-observed.json': voiceCalibration() });

    const r = runScript('validate-timing.mjs', [], dir);

    assertCleanExit(r, EXIT.OK, 'lineage is advisory: ');
    assert.match(r.all, /calibration lineage: STALE — segment "three" is declared silent now, but the calibration measured it as narration/, r.all);
    assert.match(r.all, /remix\.mjs \(S4\)/, r.all);
    assert.doesNotMatch(r.all, /Re-run the\s+voice stage/, 'a silence edit never needs a re-voice');
  });

  test('validateTiming_silenceEditBeforeANarrationChange_reportsTheNarrationChange', (t) => {
    // "one" is silenced (S4 work) and "three" is re-worded (S3 work). The silence edit is
    // found first, but its "no re-voice" advice must not mask the change that needs one.
    const segments = voicedSilentMiddle();
    segments[0].voiceoverText = '';
    segments[0].silence = { caption: '[applause]' };
    segments[0].audio = { file: 'segment_000.mp3', durationMs: 480, headMs: 0, tailMs: 0, words: [] };
    segments[2].voiceoverText = 'and we are home';
    const dir = makeProject(t, { 'timing.json': timingWith(segments), 'calibration-observed.json': voiceCalibration() });

    const r = runScript('validate-timing.mjs', [], dir);

    assert.match(r.all, /calibration lineage: STALE — segment "three" narration does not match the fingerprint/, r.all);
    assert.match(r.all, /Re-run the\s+voice stage/, r.all);
    assert.doesNotMatch(r.all, /No re-voice is/, r.all);
  });

  test('validateTiming_textEmptySegmentDeclaredSilentSinceMeasured_isStale', (t) => {
    // A row with no `silent` field means "measured as narration" — absence is not
    // permission. Only a hand-made or pre-silence calibration has such a row for a
    // text-empty segment; voice.mjs itself refuses to synthesise empty narration.
    const segments = voicedSilentMiddle();
    const dir = makeProject(t, {
      'timing.json': timingWith(segments),
      'calibration-observed.json': voiceCalibration({
        intermission: { id: 'intermission', words: 0, chars: 0, clipMs: 960, speechMs: 960, effWps: 0, textHash: narrationFingerprint('') },
      }),
    });

    const r = runScript('validate-timing.mjs', [], dir);

    assert.match(r.all, /calibration lineage: STALE — segment "intermission" is declared silent now, but the calibration measured it as narration/, r.all);
    assert.doesNotMatch(r.all, /word budget: NOT EVALUATED/, r.all);
  });

  test('validateTiming_textEmptySegmentNoLongerDeclaredSilent_isStaleNamingTheVoiceStage', (t) => {
    // The other direction: the row says silent, the segment no longer does.
    const segments = voicedSilentMiddle();
    delete segments[1].silence;
    const dir = makeProject(t, { 'timing.json': timingWith(segments), 'calibration-observed.json': voiceCalibration() });

    const r = runScript('validate-timing.mjs', [], dir);

    assert.match(r.all, /calibration lineage: STALE — segment "intermission" is no longer declared silent, but the calibration measured it as silence/, r.all);
    assert.match(r.all, /voice\.mjs \(S3\)/, r.all);
    assert.doesNotMatch(r.all, /word budget: NOT EVALUATED/, r.all);
  });

  // A silent window is authored, and the silence in the track is generated from it. When the
  // record's generated length and the window disagree, the window was edited after that
  // silence was made and nothing has reflowed the timeline onto it: the track still holds
  // the old length. Before, that edit validated completely green.
  test('validateTiming_silentWindowWidenedWithoutRemix_failsNamingRemix', (t) => {
    const segments = voicedSilentMiddle();
    segments[1].endMs = 3480; // widened from 960 to 3000 ms; the record still says 960
    segments[2].startMs = 3480;
    segments[2].endMs = 4200;
    segments[2].audio.words = shiftWords(segments[2].audio.words, 2040);
    const dir = makeProject(t, { 'timing.json': timingWith(segments), 'calibration-observed.json': voiceCalibration() });

    const r = runScript('validate-timing.mjs', [], dir);

    assertCleanExit(r, EXIT.FAILED, 'a silent window its record does not describe must fail: ');
    assert.match(r.all, /declared silence: NOT REFLOWED/, r.all);
    assert.match(r.all, /segment "intermission" window is 3000ms, but its audio record describes 960ms of generated silence/, r.all);
    assert.match(r.all, /remix\.mjs \(S4\)/, r.all);
    assert.doesNotMatch(r.all, /declared silence: OK/, r.all);
    assert.doesNotMatch(r.all, /Re-run the\s+voice stage/, 'a silence edit never needs a re-voice');
  });

  test('validateTiming_silentSegmentWithNoRecordYet_isReportedUncheckedNotFailed', (t) => {
    // Declared before voice ran, or after it and handled by concat alone: there is no
    // record, so no generated length to compare with and nothing that can disagree. It is
    // not failed — and not counted as OK either, because nothing about it was checked.
    const dir = makeProject(t, { 'timing.json': timingWith(silentMiddleSegments()) });

    const r = runScript('validate-timing.mjs', [], dir);

    assertCleanExit(r, EXIT.OK, 'a silent segment with no record is not a mismatch: ');
    assert.match(r.all, /declared silence: UNCHECKED \(1 segment\(s\): intermission\) — no audio record yet/, r.all);
    assert.doesNotMatch(r.all, /declared silence: OK/, `nothing was checked, so nothing is OK\n${r.all}`);
    assert.doesNotMatch(r.all, /NOT REFLOWED|INCOMPLETE RECORD/, r.all);
  });

  test('validateTiming_checkedAndUncheckedSilentSegments_countsOnlyTheCheckedOnesAsOk', (t) => {
    // "three" is silenced with no record yet; the intermission's record matches its window.
    const segments = voicedSilentMiddle();
    segments[2].voiceoverText = '';
    segments[2].silence = { caption: '[applause]' };
    delete segments[2].audio;
    const dir = makeProject(t, { 'timing.json': timingWith(segments) });

    const r = runScript('validate-timing.mjs', [], dir);

    assertCleanExit(r, EXIT.OK, 'a silent segment with no record is not a failure: ');
    assert.match(r.all, /^declared silence: OK \(1 segment\(s\): intermission\)$/m, r.all);
    assert.match(r.all, /^declared silence: UNCHECKED \(1 segment\(s\): three\) — no audio record yet/m, r.all);
  });

  // A record that is THERE but gives no generated length is not "no record". voice.mjs and
  // remix.mjs both record the length of every silent clip they generate, so a record without
  // one was made or edited by other means, and the window it cannot vouch for may be stale.
  // It fails, naming the stage that can rewrite it: remix when the record names the clip,
  // voice when it names none, because remix refuses a segment whose record names no clip.
  test('validateTiming_silentRecordWithNoLengthUnderAWidenedWindow_failsIncompleteNamingRemix', (t) => {
    const segments = widenedIntermission();
    segments[1].audio = { file: 'segment_001.mp3', words: [] };
    const dir = makeProject(t, { 'timing.json': timingWith(segments), ...voicedClips() });

    const r = runScript('validate-timing.mjs', [], dir);

    assertCleanExit(r, EXIT.FAILED, 'a present record with no generated length must fail: ');
    assert.match(r.all, /declared silence: INCOMPLETE RECORD/, r.all);
    assert.match(r.all, /segment "intermission"[^\n]*has no durationMs[^\n]*Run remix\.mjs \(S4\)/, r.all);
    assert.doesNotMatch(r.all, /voice\.mjs/, `the record names its clip, so no re-voice is needed\n${r.all}`);
    assert.doesNotMatch(r.all, /declared silence: OK|OK: all checks passed/, r.all);
    assert.doesNotMatch(r.all, /no audio record/, `a record that is there is not "no record"\n${r.all}`);
  });

  for (const [scenario, record] of [['AnEmptyObject', {}], ['Null', null]]) {
    test(`validateTiming_silentRecordThatIs${scenario}_failsIncompleteNamingTheVoiceStage`, (t) => {
      const segments = voicedSilentMiddle();
      segments[1].audio = record;
      const dir = makeProject(t, { 'timing.json': timingWith(segments) });

      // The schema refuses `null` too (`audio` must be an object); --no-schema shows the
      // declared-silence check refusing both on its own.
      for (const args of [[], ['--no-schema']]) {
        const r = runScript('validate-timing.mjs', args, dir);

        assertCleanExit(r, EXIT.FAILED, `${args.join(' ') || 'with the schema'}: a present record with no length must fail: `);
        if (record === null && args.length === 0) assert.match(r.all, /SCHEMA: INVALID/, r.all);
        assert.match(r.all, /declared silence: INCOMPLETE RECORD/, r.all);
        assert.match(r.all, /segment "intermission"[^\n]*voice\.mjs \(S3\)/, r.all);
        assert.doesNotMatch(r.all, /remix/, `remix refuses a segment whose record names no clip\n${r.all}`);
        assert.doesNotMatch(r.all, /declared silence: OK|OK: all checks passed/, r.all);
      }
    });
  }

  for (const [scenario, durationMs, shown] of [
    ['ANumericString', '960', /durationMs is a string/],
    ['Null', null, /durationMs is null/],
    ['Negative', -960, /durationMs is -960/],
  ]) {
    test(`validateTiming_silentRecordWhoseLengthIs${scenario}_failsIncompleteNamingRemix`, (t) => {
      const segments = voicedSilentMiddle();
      segments[1].audio.durationMs = durationMs;
      const dir = makeProject(t, { 'timing.json': timingWith(segments) });

      // The schema refuses each of these too; --no-schema shows the declared-silence check
      // refusing it on its own, rather than reading '960' as the window's 960.
      for (const args of [[], ['--no-schema']]) {
        const r = runScript('validate-timing.mjs', args, dir);

        assertCleanExit(r, EXIT.FAILED, `${args.join(' ') || 'with the schema'}: a length that is not a number must fail: `);
        assert.match(r.all, /declared silence: INCOMPLETE RECORD/, r.all);
        assert.match(r.all, shown, r.all);
        assert.match(r.all, /segment "intermission"[^\n]*remix\.mjs \(S4\)/, r.all);
        assert.doesNotMatch(r.all, /declared silence: OK|OK: all checks passed/, r.all);
      }
    });
  }

  test('validateTiming_silentRecordNamingNoClipAndNoLength_failsIncompleteNamingTheVoiceStage', (t) => {
    const segments = voicedSilentMiddle();
    segments[1].audio = { headMs: 0, tailMs: 0, words: [] };
    const dir = makeProject(t, { 'timing.json': timingWith(segments) });

    const r = runScript('validate-timing.mjs', [], dir);

    assertCleanExit(r, EXIT.FAILED, 'a present record with no length must fail: ');
    assert.match(r.all, /declared silence: INCOMPLETE RECORD/, r.all);
    assert.match(r.all, /segment "intermission"[^\n]*voice\.mjs \(S3\)/, r.all);
    assert.doesNotMatch(r.all, /remix/, `remix refuses a segment whose record names no clip\n${r.all}`);
  });

  test('validateTiming_staleOrUnreflowedSilentRecordNamingNoClip_namesTheVoiceStageNotRemix', (t) => {
    // The same rule for the other two record failures: remix is named only where it runs.
    const staleWords = () => {
      const segments = voicedSilentMiddle();
      segments[1].audio.words = [{ word: 'old', startMs: 480, endMs: 1440 }];
      return segments;
    };
    for (const [block, segments] of [['STALE RECORD', staleWords()], ['NOT REFLOWED', widenedIntermission()]]) {
      delete segments[1].audio.file;
      const dir = makeProject(t, { 'timing.json': timingWith(segments) });

      const r = runScript('validate-timing.mjs', [], dir);

      assertCleanExit(r, EXIT.FAILED, `${block}: `);
      assert.match(r.all, new RegExp(`declared silence: ${block}`), r.all);
      assert.match(r.all, /segment "intermission"[^\n]*voice\.mjs \(S3\)/, r.all);
      assert.doesNotMatch(r.all, /remix/, `${block}: remix refuses a segment whose record names no clip\n${r.all}`);
    }
  });

  // The remedy INCOMPLETE RECORD names, run: remix regenerates the silence from the window,
  // writes its frame-quantised length into the record, and the timeline then validates.
  for (const [scenario, windowEndMs] of [['Widened', 3480], ['NonFrameAligned', 3490]]) {
    test(`validateTiming_silentRecordWithNoLength${scenario}ThenRemixed_failsBeforeAndPassesAfter`, (t) => {
      const segments = widenedIntermission(windowEndMs);
      segments[1].audio = { file: 'segment_001.mp3', words: [] };
      const dir = makeProject(t, {
        'timing.json': timingWith(segments),
        'calibration-observed.json': voiceCalibration(),
        'segment_000.mp3': clipBytes(480, MARKER_ONE),
        'segment_001.mp3': clipBytes(960, SILENT_MARKER),
        'segment_002.mp3': clipBytes(720, MARKER_THREE),
      });

      const incomplete = runScript('validate-timing.mjs', [], dir);

      assertCleanExit(incomplete, EXIT.FAILED, 'the record with no length must fail first: ');
      assert.match(incomplete.all, /declared silence: INCOMPLETE RECORD[\s\S]*remix\.mjs \(S4\)/, incomplete.all);

      assertCleanExit(runScript('remix.mjs', ['--apply', '--replace'], dir, { nodeArgs: ['--import', FAKE_AUDIO] }), EXIT.OK,
        'the named remedy must run: ');
      const produced = JSON.parse(fs.readFileSync(path.join(dir, 'timing.json'), 'utf8'));
      // 3000 ms is 125 frames of 24 ms; 3010 ms is 125.4, so it too becomes 125 frames.
      assert.deepEqual(produced.segments.map((s) => [s.id, s.startMs, s.endMs]),
        [['one', 0, 480], ['intermission', 480, 3480], ['three', 3480, 4200]]);
      assert.equal(produced.segments[1].audio.durationMs, 3000, 'the record must carry the frame-quantised window');
      const v = runScript('validate-timing.mjs', [], dir);

      assertCleanExit(v, EXIT.OK, 'the timeline remix produced must validate: ');
      assert.match(v.all, /declared silence: OK \(1 segment\(s\): intermission\)/, v.all);
      assert.doesNotMatch(v.all, /INCOMPLETE RECORD|NOT REFLOWED|UNCHECKED/, v.all);
    });
  }

  for (const [scenario, calibration] of [['MeasuredRate', true], ['EstimatedRate', false]]) {
    test(`validateTiming_measuredWindowsBesideASilentSegment_${scenario}_claimsOnlyTheNarratedWindows`, (t) => {
      const files = { 'timing.json': timingWith(voicedSilentMiddle()) };
      if (calibration) files['calibration-observed.json'] = voiceCalibration();
      const dir = makeProject(t, files);

      const r = runScript('validate-timing.mjs', [], dir);

      assertCleanExit(r, EXIT.OK);
      assert.match(r.all,
        /segment windows: MEASURED from synthesised audio — narrated windows only \(1 declared-silent segment\(s\) excluded/, r.all);
    });
  }
});

// ===========================================================================
// R6 / R7 — the silent-wrong reporting sites
// ===========================================================================
describe('reporting a silent segment honestly', () => {
  test('writeStoryboard_declaredSilentSegment_reportsZeroWordsNotOne', (t) => {
    // `''.split(/\s+/)` is `['']` — length 1. An empty segment reported "1 word", which is
    // the kind of number that looks measured and is not.
    const segments = silentMiddleSegments();
    // A fourth segment with empty narration and NO silence declaration: an unwritten
    // draft, which is a normal thing for S2 (which runs before the voice stage) to see.
    segments.push({ id: 'unwritten', startMs: 2160, endMs: 3160, voiceoverText: '' });
    const dir = makeProject(t, { 'timing.json': timingWith(segments, { aspectRatio: '16:9', intake: { voice: 'v', speed: 1 } }) });

    const r = runScript('write-storyboard.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.OK, 'the storyboard must render a silent segment: ');
    const html = fs.readFileSync(path.join(dir, 'storyboard.html'), 'utf8');
    // The declared silent segment states its silence rather than a word count, and shows
    // the cue a caption reader will actually see. (The 960ms window renders as "1.0s" —
    // the panel has always shown one decimal place.)
    assert.match(html, /1\.0s · silent/, `the silent segment must be labelled silent\n`);
    assert.match(html, /\[music\]/, 'the storyboard must show the accessibility cue that will be displayed');
    // And the underlying count is fixed for ANY empty narration, not only declared
    // silence: `''.split(/\s+/)` is `['']`, so an unwritten segment reported "1 words".
    // S2 runs before the voice stage, so an empty draft segment is a normal thing to see.
    assert.match(html, /1\.0s · 0 words/, `an unwritten segment must report zero words, not one\n`);
  });

  // The storyboard is where an author approves the cue a caption reader will see. Every
  // later stage refuses a blank cue, so rendering one here approved an empty caption box
  // that the pipeline would reject further on.
  for (const [scenario, caption] of [['EmptyCaption', ''], ['WhitespaceCaption', '   '], ['NullCaption', null]]) {
    test(`writeStoryboard_silentSegmentWith${scenario}_refusesRatherThanRenderingABlankCue`, (t) => {
      const timing = timingWith(silentMiddleSegments({ caption }), { aspectRatio: '16:9', intake: { voice: 'v', speed: 1 } });
      const dir = makeProject(t, { 'timing.json': timing });

      const plan = runScript('write-storyboard.mjs', [], dir);
      const r = runScript('write-storyboard.mjs', ['--apply'], dir);

      assertCleanExit(plan, EXIT.USAGE, 'the plan must say the apply path would refuse: ');
      assertCleanExit(r, EXIT.USAGE, 'a blank accessibility cue must be refused: ');
      assert.match(r.all, /segment "intermission"/, 'the refusal must name the segment');
      assert.equal(fs.existsSync(path.join(dir, 'storyboard.html')), false, 'no storyboard may be written');
    });
  }

  test('frameCapture_segmentWithNeitherEndMsNorMeasuredDuration_namesTheSegmentItCannotPlace', (t) => {
    // Contributing 0 to the derived duration let a segment be effectively ignored without
    // any segment-specific error — the same in-band absence, one stage over.
    const segments = [
      { id: 'one', startMs: 0, endMs: 1000, voiceoverText: 'hello', audio: { durationMs: 1000 } },
      { id: 'unplaceable', startMs: 1000, voiceoverText: 'no end and no measured clip' },
    ];
    const dir = makeProject(t, {
      'timing.json': JSON.stringify({
        project: { name: 'demo', fps: 30, width: 320, height: 240 },
        endCard: { enabled: false },
        segments,
      }),
    });

    const r = runScript('frame-capture.mjs', [], dir);

    assert.notEqual(r.code, EXIT.OK, `an unplaceable segment must fail\n${r.all}`);
    assert.match(r.all, /unplaceable/, 'the failure must name the segment it could not place');
  });
});

// ===========================================================================
// A named remedy is one its stage accepts
//
// A diagnostic that names a stage is only giving a remedy if that stage would run: on the
// timeline as it stands, or, where the remedy is an edit, on the timeline after the edit.
// remix.mjs, concat-audio.mjs and voice.mjs each refuse a whole timeline whose silence
// declarations are malformed; remix refuses a record whose clip is not there, and the TTS
// service cannot synthesise narration that has no text. A message that sends the author to a
// stage that refuses is a dead end, so where the named stage would refuse, it says why.
// ===========================================================================
describe('a named remedy is one its stage accepts', () => {
  const alphaGo = [{ word: 'Alpha', startMs: 100, endMs: 500 }, { word: 'go', startMs: 500, endMs: 960 }];
  const unclaimed = (name) => new RegExp(`${name.replace('.', '\\.')} is on disk but no segment claims it`);
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rewriteTiming = (dir, edit) => {
    const file = path.join(dir, 'timing.json');
    const timing = JSON.parse(fs.readFileSync(file, 'utf8'));
    edit(timing);
    fs.writeFileSync(file, JSON.stringify(timing));
  };

  // ---- R4-1: a record naming a clip by its 8.3 short name ---------------------------------
  // The resolver keeps the alias it was given, while discovery lists the long name, so a
  // clip a record names that way was reported as unclaimed: an orphan, inviting its deletion.
  test('concatAudio_silentRecordNamingTheShortNameOfItsClip_doesNotCallTheClipAnOrphan', (t) => {
    const dir = makeProject(t, { 'timing.json': timingWith(voicedSilentMiddle()), 'silence.mp3': clipBytes(240, 0x77), ...voicedClips() });
    const alias = shortNameOf(path.join(dir, 'segment_001.mp3'));
    if (alias === null) return t.skip('no 8.3 short name here: not Windows, or this volume does not generate them');
    rewriteTiming(dir, (timing) => { timing.segments[1].audio.file = alias; });

    for (const args of [[], ['--apply']]) {
      const r = runScript('concat-audio.mjs', args, dir);

      assertCleanExit(r, EXIT.OK);
      assert.doesNotMatch(r.all, unclaimed('segment_001.mp3'), `${alias} is segment_001.mp3, which the record claims\n${r.all}`);
      assert.doesNotMatch(r.all, / is on disk but no segment claims it/, r.all);
      assert.match(r.all, new RegExp(`${escape(alias)}, which its record names, (is not used and is left as it is|was not used)`), r.all);
    }
  });

  test('concatAudio_narratedRecordNamingTheShortNameOfItsClip_warnsOfNoOrphanUnderApply', (t) => {
    const dir = makeProject(t, { 'timing.json': timingWith(voicedSilentMiddle()), 'silence.mp3': clipBytes(240, 0x77), ...voicedClips() });
    const alias = shortNameOf(path.join(dir, 'segment_000.mp3'));
    if (alias === null) return t.skip('no 8.3 short name here: not Windows, or this volume does not generate them');
    rewriteTiming(dir, (timing) => { timing.segments[0].audio.file = alias; });

    const r = runScript('concat-audio.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.OK);
    assert.doesNotMatch(r.all, unclaimed('segment_000.mp3'), `${alias} is segment_000.mp3, which the record claims\n${r.all}`);
    assert.doesNotMatch(r.all, / is on disk but no segment claims it/, r.all);
    assert.equal(markerAtMs(fs.readFileSync(path.join(dir, 'voiceover.mp3')), 0), MARKER_ONE, 'the clip the alias names is the one played');
  });

  // ---- R5-1: a record naming the 8.3 short name of a LINK --------------------------------------
  // Every name the resolver gives back follows the link to its target, so none of them is the
  // link's own directory entry: the link a record named that way was reported as unclaimed.

  /**
   * voicedSilentMiddle()'s project with segment_00`index`.mp3 made a link to its clip's bytes,
   * which are moved to store_00`index`.bin, and the record naming the link by its 8.3 short
   * name. null, with the test skipped saying why, where that cannot be built here.
   */
  function projectNamingALinkByItsShortName(t, index) {
    if (process.platform !== 'win32') {
      t.skip('8.3 short names are a Windows feature');
      return null;
    }
    const link = `segment_00${index}.mp3`;
    const store = `store_00${index}.bin`;
    const clips = Object.entries(voicedClips()).map(([name, bytes]) => [name === link ? store : name, bytes]);
    const dir = makeProject(t, { 'timing.json': timingWith(voicedSilentMiddle()), 'silence.mp3': clipBytes(240, 0x77), ...Object.fromEntries(clips) });
    if (!tryMakeFileLink(path.join(dir, link), path.join(dir, store))) {
      t.skip('platform refused to create a file link');
      return null;
    }
    const alias = shortNameOf(path.join(dir, link));
    if (alias === null) {
      t.skip('no 8.3 short name for the link: this volume does not generate them');
      return null;
    }
    rewriteTiming(dir, (timing) => { timing.segments[index].audio.file = alias; });
    return { dir, link, alias };
  }

  test('concatAudio_silentRecordNamingTheShortNameOfALink_doesNotCallTheLinkAnOrphan', (t) => {
    const built = projectNamingALinkByItsShortName(t, 1);
    if (built === null) return;
    const { dir, link, alias } = built;

    for (const args of [[], ['--apply']]) {
      const r = runScript('concat-audio.mjs', args, dir);

      assertCleanExit(r, EXIT.OK);
      assert.doesNotMatch(r.all, unclaimed(link), `${alias} is the link ${link}, which the record claims\n${r.all}`);
      assert.doesNotMatch(r.all, / is on disk but no segment claims it/, r.all);
      assert.match(r.all,
        new RegExp(`${escape(alias)} \\(a link to store_001\\.bin\\), which its record names, (is not used and is left as it is|was not used)`), r.all);
    }
  });

  test('concatAudio_narratedRecordNamingTheShortNameOfALink_doesNotCallTheLinkAnOrphan', (t) => {
    const built = projectNamingALinkByItsShortName(t, 0);
    if (built === null) return;
    const { dir, link, alias } = built;

    for (const args of [[], ['--apply']]) {
      const r = runScript('concat-audio.mjs', args, dir);

      assertCleanExit(r, EXIT.OK);
      assert.doesNotMatch(r.all, unclaimed(link), `${alias} is the link ${link}, which the record claims\n${r.all}`);
      assert.doesNotMatch(r.all, / is on disk but no segment claims it/, r.all);
    }
    assert.equal(markerAtMs(fs.readFileSync(path.join(dir, 'voiceover.mp3')), 0), MARKER_ONE, 'the clip the link names is the one played');
  });

  test('concatAudio_recordNamingTheShortNameOfOneOfTwoHardLinksOfALink_claimsNeitherAndSaysWhy', (t) => {
    // Two names for one link share its identity, so which of them the short name belongs to
    // cannot be told. Neither is claimed, and neither is called unclaimed either.
    const built = projectNamingALinkByItsShortName(t, 1);
    if (built === null) return;
    const { dir, link, alias } = built;
    const twin = 'segment_009.mp3';
    try {
      fs.linkSync(path.join(dir, link), path.join(dir, twin));
    } catch {
      return t.skip('platform refused to hard-link the link');
    }
    if (!fs.lstatSync(path.join(dir, twin)).isSymbolicLink()) return t.skip('platform hard-linked the target, not the link');

    for (const [args, lead] of [[[], '  ! '], [['--apply'], 'warning: ']]) {
      const r = runScript('concat-audio.mjs', args, dir);

      assertCleanExit(r, EXIT.OK);
      for (const [name, other] of [[link, twin], [twin, link]]) {
        assert.doesNotMatch(r.all, unclaimed(name), `${name} may be the file the record names\n${r.all}`);
        assert.match(r.all, new RegExp(`${escape(lead)}${escape(name)} may be the file segment "intermission" names by the short ` +
          `name ${escape(alias)} — it and ${escape(other)} are hard links of one link, so which of them that short name ` +
          'belongs to cannot be told'), r.all);
      }
    }
  });

  // ---- R6-2: a volume that reports no file IDs -------------------------------------------------
  // The link's own entry is found by identity, so with no file IDs it is not found. That is
  // not evidence that no record names it: no link is then called unclaimed, and the line
  // says why. A regular file is claimed by its canonical name, so it keeps the plain line.
  const noFileIds = (name, label, alias) => new RegExp(`${escape(name)} may be the file ${escape(label)} names by the ` +
    `short name ${escape(alias)} — this volume reports no file IDs, so whether that short name belongs to it cannot be told`);
  for (const [kind, index, label] of [['Silent', 1, 'segment "intermission"'], ['Narrated', 0, 'segment "one"']]) {
    test(`concatAudio_${kind.toLowerCase()}RecordNamingTheShortNameOfALinkWhereTheVolumeReportsNoFileIds_saysItMayBeTheLink`, (t) => {
      const built = projectNamingALinkByItsShortName(t, index);
      if (built === null) return;
      const { dir, link, alias } = built;

      for (const [args, lead] of [[[], '  ! '], [['--apply'], 'warning: ']]) {
        const r = runScript('concat-audio.mjs', args, dir, { nodeArgs: ['--import', zeroFileIds({ dir })] });

        assert.match(r.all, ZERO_FILE_IDS_ARMED, `the volume must report no file IDs\n${r.all}`);
        assertCleanExit(r, EXIT.OK);
        assert.doesNotMatch(r.all, unclaimed(link), `with no file IDs, ${alias} may be ${link}\n${r.all}`);
        assert.doesNotMatch(r.all, / is on disk but no segment claims it/, r.all);
        assert.match(r.all, new RegExp(`^${escape(lead)}${noFileIds(link, label, alias).source}$`, 'm'), r.all);
      }
    });
  }

  test('concatAudio_recordNamingALinkByItsLongNameWhereTheVolumeReportsNoFileIds_claimsItWithNothingToQualify', (t) => {
    // GUARD (passes before and after): the long name is the entry discovery lists, so no
    // identity is needed to claim it.
    const clips = Object.entries(voicedClips()).map(([name, bytes]) => [name === 'segment_001.mp3' ? 'store_001.bin' : name, bytes]);
    const dir = makeProject(t, { 'timing.json': timingWith(voicedSilentMiddle()), 'silence.mp3': clipBytes(240, 0x77), ...Object.fromEntries(clips) });
    if (!tryMakeFileLink(path.join(dir, 'segment_001.mp3'), path.join(dir, 'store_001.bin'))) return t.skip('platform refused to create a file link');

    for (const args of [[], ['--apply']]) {
      const r = runScript('concat-audio.mjs', args, dir, { nodeArgs: ['--import', zeroFileIds({ dir })] });

      assert.match(r.all, ZERO_FILE_IDS_ARMED, `the volume must report no file IDs\n${r.all}`);
      assertCleanExit(r, EXIT.OK);
      assert.doesNotMatch(r.all, / is on disk but no segment claims it| may be the file /, r.all);
    }
  });

  test('concatAudio_regularFileOrphanBesideAShortNamedLinkWhereTheVolumeReportsNoFileIds_isStillCalledUnclaimed', (t) => {
    // The regular file's line is a GUARD (it passes before and after): an alias of a regular
    // file is claimed by its canonical name, so no short name can be a regular file left
    // over. Only the link is qualified.
    const built = projectNamingALinkByItsShortName(t, 1);
    if (built === null) return;
    const { dir, link, alias } = built;
    fs.writeFileSync(path.join(dir, 'segment_009.mp3'), clipBytes(240, 0x99));

    for (const [args, lead, fate] of [[[], '  ! ', 'it will NOT be included'], [['--apply'], 'warning: ', 'it was NOT included']]) {
      const r = runScript('concat-audio.mjs', args, dir, { nodeArgs: ['--import', zeroFileIds({ dir })] });

      assert.match(r.all, ZERO_FILE_IDS_ARMED, `the volume must report no file IDs\n${r.all}`);
      assertCleanExit(r, EXIT.OK);
      assert.match(r.all, new RegExp(`^${escape(lead)}segment_009\\.mp3 is on disk but no segment claims it — ${fate}$`, 'm'), r.all);
      assert.doesNotMatch(r.all, unclaimed(link), r.all);
      assert.match(r.all, new RegExp(`^${escape(lead)}${noFileIds(link, 'segment "intermission"', alias).source}$`, 'm'), r.all);
    }
  });

  // ---- R7-1: an entry that cannot be inspected -------------------------------------------------
  // The link's own entry is found by inspecting every entry, so a search that could not inspect
  // one has not shown that no record names the link: whichever entry it was, and even where the
  // link was found before it. No link is then called unclaimed, and the line says why.
  const notInspected = (name, label, alias) => new RegExp(`${escape(name)} may be the file ${escape(label)} names by the ` +
    `short name ${escape(alias)} — not every entry here could be inspected, so whether that short name belongs to it cannot be told`);
  const refusedLstat = (name) => new RegExp(`^fail-lstat: refused .*[\\\\/]${escape(name)}$`, 'm');
  for (const [kind, index, label] of [['Silent', 1, 'segment "intermission"'], ['Narrated', 0, 'segment "one"']]) {
    test(`concatAudio_${kind.toLowerCase()}RecordNamingTheShortNameOfALinkWhoseOwnEntryCannotBeInspected_saysItMayBeTheLink`, (t) => {
      const built = projectNamingALinkByItsShortName(t, index);
      if (built === null) return;
      const { dir, link, alias } = built;

      for (const [args, lead] of [[[], '  ! '], [['--apply'], 'warning: ']]) {
        const r = runScript('concat-audio.mjs', args, dir, { nodeArgs: ['--import', failLstat({ dir, names: [link] })] });

        assert.match(r.all, FAIL_LSTAT_ARMED, `${link} must be made uninspectable\n${r.all}`);
        assert.match(r.all, refusedLstat(link), `the search must have tried to inspect ${link}\n${r.all}`);
        assertCleanExit(r, EXIT.OK);
        assert.doesNotMatch(r.all, / is on disk but no segment claims it/, `${alias} may be ${link}\n${r.all}`);
        assert.match(r.all, new RegExp(`^${escape(lead)}${notInspected(link, label, alias).source}$`, 'm'), r.all);
      }
    });
  }

  test('concatAudio_silentRecordNamingTheShortNameOfALinkWhereALaterEntryCannotBeInspected_claimsNothingAndSaysItMayBeTheLink', (t) => {
    // The search fails closed: the link's entry, listed before the one that cannot be
    // inspected, is not claimed, because an unfinished search has not shown it is the only
    // entry the short name can belong to.
    const built = projectNamingALinkByItsShortName(t, 1);
    if (built === null) return;
    const { dir, link, alias } = built;
    const later = 'zz_notes.txt';
    fs.writeFileSync(path.join(dir, later), 'not a clip');
    const order = fs.readdirSync(dir);
    if (!order.includes(link) || order.indexOf(later) < order.indexOf(link)) {
      return t.skip(`this volume does not list ${link} before ${later}: ${order.join(', ')}`);
    }

    for (const [args, lead] of [[[], '  ! '], [['--apply'], 'warning: ']]) {
      const r = runScript('concat-audio.mjs', args, dir, { nodeArgs: ['--import', failLstat({ dir, names: [later] })] });

      assert.match(r.all, FAIL_LSTAT_ARMED, `${later} must be made uninspectable\n${r.all}`);
      assert.match(r.all, refusedLstat(later), `the search must have reached ${later}\n${r.all}`);
      assertCleanExit(r, EXIT.OK);
      assert.doesNotMatch(r.all, / is on disk but no segment claims it/, `${alias} may be ${link}\n${r.all}`);
      assert.match(r.all, new RegExp(`^${escape(lead)}${notInspected(link, 'segment "intermission"', alias).source}$`, 'm'), r.all);
    }
  });

  // ---- R5 sweep, table D: remix's plan, where a silent record names a clip by its short name ----
  // The plan says what this run does to the file a silent segment's record named. Compared as
  // text, a short name of a file this run writes read as another file, which it "leaves as it is".
  for (const [scenario, target, expect] of [
    ['ItsOwnClip', 'segment_02.mp3', null],
    ['TheVoiceTrack', 'voiceover.mp3', /segment_02\.mp3 [^\n]*; its record named [^\n]*, which this run overwrites$/m],
  ]) {
    test(`remix_planWhereASilentRecordNamesTheShortNameOf${scenario}_doesNotSayItIsLeftAsItIs`, (t) => {
      const dir = makeProject(t, {
        'timing.json': timingWith(voicedSilentMiddle()),
        ...voicedClips(),
        'segment_02.mp3': clipBytes(960, SILENT_MARKER),
        'voiceover.mp3': 'the previous narration',
      });
      const alias = shortNameOf(path.join(dir, target));
      if (alias === null) return t.skip('no 8.3 short name here: not Windows, or this volume does not generate them');
      rewriteTiming(dir, (timing) => { timing.segments[1].audio.file = alias; });

      const r = runScript('remix.mjs', [], dir);

      assertCleanExit(r, EXIT.OK, 'the plan must succeed: ');
      assert.match(r.all, /segment_02\.mp3 [^\n]*segment "intermission" is declared silent: regenerated from its 960ms authored window/, r.all);
      assert.doesNotMatch(r.all, /leaves as it is/, `${alias} is ${target}, which this run writes\n${r.all}`);
      if (expect === null) assert.doesNotMatch(r.all, /its record named/, `the record names the segment's own clip\n${r.all}`);
      else assert.match(r.all, expect, r.all);
    });
  }

  test('remix_planWhereASilentRecordNamesAHardLinkOfTheVoiceTrack_saysItIsLeftAsItIs', (t) => {
    // The guard on the fix above, which compares names, never identity: a hard link is another
    // entry, and publishing by rename replaces the voice track's entry, not the file they share.
    const dir = makeProject(t, {
      'timing.json': timingWith(voicedSilentMiddle()),
      ...voicedClips(),
      'segment_02.mp3': clipBytes(960, SILENT_MARKER),
      'voiceover.mp3': 'the previous narration',
    });
    try {
      fs.linkSync(path.join(dir, 'voiceover.mp3'), path.join(dir, 'old_voice.mp3'));
    } catch {
      return t.skip('platform refused to hard-link');
    }
    rewriteTiming(dir, (timing) => { timing.segments[1].audio.file = 'old_voice.mp3'; });

    const r = runScript('remix.mjs', [], dir);

    assertCleanExit(r, EXIT.OK, 'the plan must succeed: ');
    assert.match(r.all, /segment_02\.mp3 [^\n]*; its record named old_voice\.mp3, which remix leaves as it is$/m, r.all);
  });

  // ---- R6-3: remix's plan, where a silent record names a LINK the resolver follows -----------
  // The plan's account of a file a record named compares canonical names, so a link to a
  // file this run writes is that file however the link spells its target. The link is never
  // written: each output is published by rename, so the link reads the new file afterwards.
  const projectWhoseSilentRecordNamesALink = (t, link, target) => {
    const dir = makeProject(t, {
      'timing.json': timingWith(voicedSilentMiddle()),
      ...voicedClips(),
      'segment_02.mp3': clipBytes(960, 0x5a),
      'voiceover.mp3': 'the previous narration',
    });
    const spelled = target(dir);
    if (spelled === null) {
      t.skip('no 8.3 short name here: not Windows, or this volume does not generate them');
      return null;
    }
    if (!tryMakeFileLink(path.join(dir, link), spelled)) {
      t.skip('platform refused to create a file link');
      return null;
    }
    rewriteTiming(dir, (timing) => { timing.segments[1].audio.file = link; });
    return dir;
  };
  const read = (dir, f) => fs.readFileSync(path.join(dir, f));

  test('remix_silentRecordNamingALinkToTheVoiceTrack_saysThisRunOverwritesItAndTheLinkThenReadsTheNewTrack', (t) => {
    const dir = projectWhoseSilentRecordNamesALink(t, 'old_voice.mp3', () => 'voiceover.mp3');
    if (dir === null) return;

    const plan = runScript('remix.mjs', [], dir);

    assertCleanExit(plan, EXIT.OK, 'the plan must succeed: ');
    assert.match(plan.all, /^ {2}segment_02\.mp3 [^\n]*; its record named old_voice\.mp3, which this run overwrites$/m, plan.all);
    assert.doesNotMatch(plan.all, /leaves as it is/, plan.all);

    assertCleanExit(runScript('remix.mjs', ['--apply', '--replace'], dir, { nodeArgs: ['--import', FAKE_AUDIO] }), EXIT.OK);

    assert.ok(fs.lstatSync(path.join(dir, 'old_voice.mp3')).isSymbolicLink(), 'the link itself is never written');
    assert.ok(read(dir, 'old_voice.mp3').equals(read(dir, 'voiceover.mp3')), 'the link reads the voice track this run published');
    assert.notEqual(read(dir, 'voiceover.mp3').toString('latin1'), 'the previous narration');
    assert.equal(JSON.parse(read(dir, 'timing.json')).segments[1].audio.file, 'segment_02.mp3');
  });

  test('remix_silentRecordNamingALinkToItsOwnClip_saysNothingOfItAndTheLinkThenReadsTheNewSilence', (t) => {
    const dir = projectWhoseSilentRecordNamesALink(t, 'own.mp3', () => 'segment_02.mp3');
    if (dir === null) return;
    const old = read(dir, 'segment_02.mp3');

    const plan = runScript('remix.mjs', [], dir);

    assertCleanExit(plan, EXIT.OK, 'the plan must succeed: ');
    assert.match(plan.all, /segment_02\.mp3 [^\n]*segment "intermission" is declared silent: regenerated from its 960ms authored window$/m, plan.all);
    assert.doesNotMatch(plan.all, /its record named|leaves as it is/, `own.mp3 is the clip this run regenerates\n${plan.all}`);

    assertCleanExit(runScript('remix.mjs', ['--apply', '--replace'], dir, { nodeArgs: ['--import', FAKE_AUDIO] }), EXIT.OK);

    assert.equal(JSON.parse(read(dir, 'timing.json')).segments[1].audio.file, 'segment_02.mp3');
    assert.ok(fs.lstatSync(path.join(dir, 'own.mp3')).isSymbolicLink(), 'the link itself is never written');
    assert.ok(read(dir, 'own.mp3').equals(read(dir, 'segment_02.mp3')), 'the link reads the clip this run regenerated');
    assert.ok(!read(dir, 'segment_02.mp3').equals(old), 'and that clip is the new silence, not the old clip');
  });

  // The link's target spelled by its 8.3 short name: read as text, the name the resolver
  // gives back is another file, which this run "leaves as it is".
  for (const [scenario, link, target, expect] of [
    ['TheVoiceTrack', 'old_voice.mp3', 'voiceover.mp3', /; its record named old_voice\.mp3, which this run overwrites$/m],
    ['ItsOwnClip', 'own.mp3', 'segment_02.mp3', null],
  ]) {
    test(`remix_planWhereASilentRecordNamesALinkToTheShortNameOf${scenario}_saysWhatThisRunDoesToIt`, (t) => {
      const dir = projectWhoseSilentRecordNamesALink(t, link, (d) => shortNameOf(path.join(d, target)));
      if (dir === null) return;

      const plan = runScript('remix.mjs', [], dir);

      assertCleanExit(plan, EXIT.OK, 'the plan must succeed: ');
      assert.match(plan.all, /segment_02\.mp3 [^\n]*segment "intermission" is declared silent: regenerated from its 960ms authored window/, plan.all);
      assert.doesNotMatch(plan.all, /leaves as it is/, `the link leads to ${target}, which this run writes\n${plan.all}`);
      if (expect === null) assert.doesNotMatch(plan.all, /its record named/, `the link leads to the segment's own clip\n${plan.all}`);
      else assert.match(plan.all, expect, plan.all);
    });
  }

  // ---- R4-3: a silent window that is not a number is an authored field to correct ----------
  for (const [stage, script, args] of [
    ['writeChapters', 'write-chapters.mjs', ['--list']],
    ['writeSubtitles', 'write-subtitles.mjs', ['--apply']],
  ]) {
    test(`${stage}_silentWindowEndWrittenAsAString_namesTheFieldAndRemixNotTheVoiceStage`, (t) => {
      const segments = voicedSilentMiddle();
      segments[1].endMs = '5000';
      const dir = makeProject(t, { 'timing.json': timingWith(segments), ...voicedClips() });
      const files = fs.readdirSync(dir).sort();

      const r = runScript(script, args, dir);

      assertCleanExit(r, EXIT.FAILED, 'a window that is not a number must fail: ');
      assert.match(r.all,
        /timing\.segments\[1\] \("intermission"\) is declared silent, so its window is authored, not measured: endMs is a string \(4 characters\) — write it as a number of milliseconds, >= 0/, r.all);
      assert.match(r.all, /If that changes the window's length, remix\.mjs \(S4\) reflows the timeline onto it, with no re-voice/, r.all);
      assert.doesNotMatch(r.all, /voice\.mjs/, `an authored window is corrected by hand, never by a re-voice\n${r.all}`);
      assert.deepEqual(fs.readdirSync(dir).sort(), files, 'nothing may be written');
    });
  }

  test('writeChapters_silentWindowWithNoEnd_namesTheFieldAndRemixNotTheVoiceStage', (t) => {
    const segments = voicedSilentMiddle();
    delete segments[1].endMs;
    const dir = makeProject(t, { 'timing.json': timingWith(segments), ...voicedClips() });

    const r = runScript('write-chapters.mjs', ['--list'], dir);

    assertCleanExit(r, EXIT.FAILED, 'a window with no end must fail: ');
    assert.match(r.all, /timing\.segments\[1\] \("intermission"\) is declared silent, so its window is authored, not measured: endMs is missing — write it as a number of milliseconds/, r.all);
    assert.match(r.all, /If that changes the window's length, remix\.mjs \(S4\) reflows the timeline onto it, with no re-voice/, r.all);
    assert.doesNotMatch(r.all, /voice\.mjs/, r.all);
  });

  test('writeSubtitles_silentWindowEndNullWhereRemixWouldRefuse_namesTheFieldAndWhyRemixWouldRefuse', (t) => {
    // No clip is on disk, so remix would refuse even once the field is corrected: it is named
    // as the stage that reflows, with the reason it would not run, and never as a step to take.
    const segments = voicedSilentMiddle();
    segments[1].endMs = null;
    const dir = makeProject(t, { 'timing.json': timingWith(segments) });

    const r = runScript('write-subtitles.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.FAILED, 'a window with a null end must fail: ');
    assert.match(r.all, /timing\.segments\[1\] \("intermission"\) is declared silent, so its window is authored, not measured: endMs is null — write it as a number of milliseconds/, r.all);
    assert.match(r.all,
      /remix\.mjs \(S4\) is the stage that reflows the timeline onto it, with no re-voice, but it would refuse this timeline even then: segment_000\.mp3 is not in the project/, r.all);
    assert.doesNotMatch(r.all, /voice\.mjs/, r.all);
    assert.doesNotMatch(r.all, /[Rr]un remix/, r.all);
  });

  test('writeChapters_narratedWindowEndWrittenAsAString_stillNamesTheVoiceStage', (t) => {
    // REGRESSION GUARD (passes before and after): a narrated window is measured by voice.
    const segments = voicedSilentMiddle();
    segments[2].endMs = '2160';
    const dir = makeProject(t, { 'timing.json': timingWith(segments, { durationMs: 2160, contentMs: 2160 }), ...voicedClips() });

    const r = runScript('write-chapters.mjs', ['--list'], dir);

    assertCleanExit(r, EXIT.FAILED);
    assert.match(r.all, /timing\.segments\[2\] \("three"\): endMs is a string \(4 characters\) — it must be a finite number of milliseconds, >= 0\. Run voice\.mjs \(S3\/S4\) first/, r.all);
  });

  // ---- R5-3: the remedy is asked of exactly the edit the message names ------------------------
  // Correcting startMs alone, to any number >= 0, leaves a window that ends at 0 with no
  // positive length, which remix refuses: so endMs is named too, and remix only after both.
  for (const [stage, script, args] of [
    ['writeChapters', 'write-chapters.mjs', ['--list']],
    ['writeSubtitles', 'write-subtitles.mjs', ['--apply']],
  ]) {
    test(`${stage}_silentWindowStartNotANumberWithAnEndOfZero_namesTheEndTooAndRemixOnlyAfterBoth`, (t) => {
      const segments = voicedSilentMiddle();
      segments[1].startMs = 'oops';
      segments[1].endMs = 0;
      const dir = makeProject(t, { 'timing.json': timingWith(segments), ...voicedClips() });

      const r = runScript(script, args, dir);

      assertCleanExit(r, EXIT.FAILED, 'a window that is not a number must fail: ');
      assert.match(r.all,
        /startMs is a string \(4 characters\) — write it as a number of milliseconds, >= 0\. endMs \(0\) must change too: no startMs >= 0 gives a window that ends at 0 a positive length, so write endMs as a number of milliseconds greater than startMs/, r.all);
      assert.match(r.all, /Once both are corrected, if that changes the window's length, remix\.mjs \(S4\) reflows the timeline onto it, with no re-voice/, r.all);
      assert.doesNotMatch(r.all, /write it as a number of milliseconds, >= 0\. If that changes the window's length, remix/,
        `remix refuses the window correcting startMs alone leaves, so it is not the step after that edit\n${r.all}`);
      assert.doesNotMatch(r.all, /voice\.mjs/, r.all);
    });
  }

  test('writeChapters_silentWindowWithNeitherFieldANumber_givesEachFieldTheBoundThatMakesTheWindowPositive', (t) => {
    const segments = voicedSilentMiddle();
    segments[1].startMs = 'start';
    segments[1].endMs = null;
    const dir = makeProject(t, { 'timing.json': timingWith(segments), ...voicedClips() });

    const r = runScript('write-chapters.mjs', ['--list'], dir);

    assertCleanExit(r, EXIT.FAILED, 'a window that is not a number must fail: ');
    assert.match(r.all, /startMs is a string \(5 characters\) — write it as a number of milliseconds, >= 0 and less than endMs\. Once both are corrected, if that changes the window's length, remix\.mjs \(S4\) reflows/, r.all);
    assert.match(r.all, /endMs is null — write it as a number of milliseconds, >= 0 and greater than startMs\. Once both are corrected, if that changes the window's length, remix\.mjs \(S4\) reflows/, r.all);
    assert.doesNotMatch(r.all, /voice\.mjs/, r.all);
  });

  for (const [field, bound] of [['startMs', 'less than endMs \\(1440\\)'], ['endMs', 'greater than startMs \\(480\\)']]) {
    test(`writeSubtitles_silentWindow${field === 'startMs' ? 'Start' : 'End'}NotANumber_boundsItByTheFieldItKeeps`, (t) => {
      const segments = voicedSilentMiddle();
      segments[1][field] = 'later';
      const dir = makeProject(t, { 'timing.json': timingWith(segments), ...voicedClips() });

      const r = runScript('write-subtitles.mjs', ['--apply'], dir);

      assertCleanExit(r, EXIT.FAILED, 'a window that is not a number must fail: ');
      assert.match(r.all, new RegExp(`${field} is a string \\(5 characters\\) — write it as a number of milliseconds, >= 0 and ${bound}\\. ` +
        "If that changes the window's length, remix\\.mjs \\(S4\\) reflows"), r.all);
    });
  }

  // ---- R4-4: a malformed declaration is reported in place of the remedy, and names no stage -----
  for (const [scenario, audio, files] of [
    ['WithAClip', { file: 'segment_02.mp3', durationMs: 960, headMs: 0, tailMs: 0, words: [] },
      { 'segment_01.mp3': clipBytes(960, MARKER_ONE), 'segment_02.mp3': clipBytes(960, SILENT_MARKER) }],
    ['WithNoClip', undefined, { 'segment_01.mp3': clipBytes(960, MARKER_ONE) }],
  ]) {
    test(`writeChapters_durationShortOfAFinalWindowDeclaredSilentAsFalse${scenario}_namesTheDeclarationAndNoStage`, (t) => {
      const segments = spokenThenSilent('Alpha go.', alphaGo);
      segments[1].endMs = 3960;
      segments[1].silence = false;
      if (audio) segments[1].audio = audio;
      const dir = makeProject(t, { 'timing.json': timingWith(segments, { durationMs: 1920, contentMs: 1920 }), ...files });

      const r = runScript('write-chapters.mjs', ['--list'], dir);

      assertCleanExit(r, EXIT.FAILED, 'a duration shorter than the last window must fail: ');
      assert.match(r.all, /no shorter than the last segment \(which ends at 3960 ms\)/, r.all);
      assert.match(r.all,
        /It closes the last chapter, but a malformed silence declaration is reported here instead: timing\.segments\[1\] \("break"\) declares `silence` as false/, r.all);
      assert.doesNotMatch(r.all, /voice\.mjs|remix\.mjs/, `remix and voice each refuse a malformed declaration, so neither is named\n${r.all}`);
    });
  }

  test('writeSubtitles_durationShortWithAMalformedMiddleDeclaration_namesTheDeclarationNotTheVoiceStage', (t) => {
    const segments = widenedIntermission();
    segments[1].silence.caption = '   ';
    const dir = makeProject(t, { 'timing.json': timingWith(segments, { durationMs: 2160, contentMs: 2160 }), ...voicedClips() });

    const r = runScript('write-subtitles.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.FAILED, 'a duration shorter than the last window must fail: ');
    assert.match(r.all,
      /It bounds the last cue, but a malformed silence declaration is reported here instead: timing\.segments\[1\] \("intermission"\) is declared silent but its `silence\.caption` is "   "/, r.all);
    assert.doesNotMatch(r.all, /voice\.mjs|remix\.mjs/, `remix and voice each refuse a malformed declaration, so neither is named\n${r.all}`);
  });

  // ---- the class sweep: concat-audio ----------------------------------------------------------
  test('concatAudio_positionalRefusalWhereTheVoiceStageWouldRefuse_saysWhyRatherThanSendingThere', (t) => {
    const segments = silentMiddleSegments();
    for (const s of segments) delete s.audio;
    segments[2].voiceoverText = '';
    const dir = makeProject(t, {
      'timing.json': timingWith(segments),
      'silence.mp3': clipBytes(240, 0x77),
      'segment_01.mp3': clipBytes(480, MARKER_ONE),
      'segment_02.mp3': clipBytes(720, MARKER_THREE),
    });

    const r = runScript('concat-audio.mjs', [], dir);

    assertCleanExit(r, EXIT.USAGE, 'a positional project with a silent segment is still refused: ');
    assert.match(r.all, /no segment in timing\.json names its clip/, r.all);
    assert.match(r.all, /voice\.mjs \(S3\)[^\n]*refuses this timeline as it stands: segment "three" is narrated but has no narration text/, r.all);
    assert.doesNotMatch(r.all, /run voice\.mjs/, r.all);
    // An appended refusal does not retract an instruction, so none is given: the message says
    // what the voice stage would do, why it refuses, and the edit that clears it.
    assert.doesNotMatch(r.all, /\bhave voice\.mjs/, `no instruction to have the voice stage do it\n${r.all}`);
    assert.match(r.all, /voice\.mjs \(S3\) would name every clip it writes, but it refuses this timeline as it stands/, r.all);
    assert.match(r.all, /Write its narration, or, if it is meant to be silent, declare it silent/, r.all);
  });

  test('concatAudio_positionalProjectWhoseEverySegmentIsSilent_generatesEveryWindowAsBefore', (t) => {
    // No segment needs a clip, so there is nothing to match by position and no ambiguity to
    // refuse. Refused, it had no remedy at all: there is no narrated clip to name, and
    // voice.mjs refuses a timeline with no narration.
    const segments = [
      { id: 'slide', startMs: 0, endMs: 960, voiceoverText: '', silence: { caption: '[title card]' } },
      { id: 'gap', startMs: 960, endMs: 1920, voiceoverText: '', silence: { caption: '[music]' } },
    ];
    const dir = makeProject(t, { 'timing.json': timingWith(segments), 'segment_01.mp3': clipBytes(480, MARKER_ONE) });

    const r = runScript('concat-audio.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.OK, 'an entirely silent project concatenates, as at HEAD: ');
    assert.match(r.all, /warning: segment_01\.mp3 is on disk but no segment claims it — it was NOT included/, r.all);
    const out = fs.readFileSync(path.join(dir, 'voiceover.mp3'));
    assert.equal(out.length, msToBytes(1920), 'both windows, as generated silence');
    assert.equal(out.includes(Buffer.alloc(8, MARKER_ONE)), false, 'no clip plays in a silent window');
  });

  test('concatAudio_missingNarratedClipWhereTheVoiceStageWouldRefuse_saysWhyRatherThanSendingThere', (t) => {
    const segments = silentMiddleSegments();
    segments[0].voiceoverText = '';
    const dir = makeProject(t, {
      'timing.json': timingWith(segments),
      'silence.mp3': clipBytes(240, 0x77),
      'segment_000.mp3': clipBytes(480, MARKER_ONE),
    });

    const r = runScript('concat-audio.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.FAILED, 'a missing narrated clip still fails: ');
    assert.match(r.all, /segment "three" has no clip to concatenate \(segment_002\.mp3 is missing\)/, r.all);
    assert.match(r.all, /refuses this timeline as it stands: segment "one" is narrated but has no narration text/, r.all);
    assert.match(r.all, /if this segment is meant to be a gap, declare it silent \(a `silence` block with a caption, and no narration text\)/, r.all);
    assert.doesNotMatch(r.all, /run voice\.mjs/, r.all);
  });

  test('concatAudio_unvoicedNarrationWithNoTextToSynthesise_saysWhyTheVoiceStageWouldRefuse', (t) => {
    const segments = voicedSilentMiddle();
    delete segments[1].silence; // its voiceoverText stays ''
    const dir = makeProject(t, { 'timing.json': timingWith(segments), 'silence.mp3': clipBytes(240, 0x77), ...voicedClips() });

    const r = runScript('concat-audio.mjs', [], dir);

    assertCleanExit(r, EXIT.USAGE);
    assert.match(r.all, /segment "intermission" is narrated, but its audio record holds an empty word list/, r.all);
    assert.match(r.all, /refuses this timeline as it stands: segment "intermission" is narrated but has no narration text/, r.all);
    assert.doesNotMatch(r.all, /run voice\.mjs/, r.all);
  });

  test('concatAudio_quantisationNoteWhereRemixWouldRefuse_saysWhyRatherThanSendingThere', (t) => {
    const segments = [
      { id: 'one', startMs: 0, endMs: 480, voiceoverText: 'hello there friend', audio: { file: 'segment_000.mp3', durationMs: 480, words: silentMiddleSegments()[0].audio.words } },
      { id: 'gap', startMs: 480, endMs: 1480, voiceoverText: '', silence: { caption: '[music]' } },
    ];
    const dir = makeProject(t, { 'timing.json': timingWith(segments), 'silence.mp3': clipBytes(240, 0x77), 'segment_000.mp3': clipBytes(480, MARKER_ONE) });

    const r = runScript('concat-audio.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.OK);
    assert.match(r.all, /\+8ms/, r.all);
    assert.match(r.all, /remix\.mjs \(S4\)[^\n]*refuses this timeline as it stands: segment "gap" has no audio\.file/, r.all);
    assert.doesNotMatch(r.all, /[Rr]un remix/, r.all);
    assert.doesNotMatch(r.all, /voice\.mjs/, 'a quantisation note never sends a silence matter to a re-voice');
  });

  test('concatAudio_quantisationNoteWhereRemixWouldRun_namesIt', (t) => {
    // REGRESSION GUARD (passes before and after).
    const dir = makeProject(t, { 'timing.json': timingWith(widenedIntermission(1480)), 'silence.mp3': clipBytes(240, 0x77), ...voicedClips() });

    const r = runScript('concat-audio.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.OK);
    assert.match(r.all, /\+8ms against their authored length\. Run remix\.mjs \(S4\) to reflow the timeline onto the audio that exists/, r.all);
  });

  // ---- the class sweep: write-subtitles and write-chapters --------------------------------------
  test('writeSubtitles_durationNotANumberInAnEntirelySilentTimeline_saysToSetItByHand', (t) => {
    // voice.mjs refuses a timeline with no narration, and remix refuses records that name no
    // clip, so no stage measures this one.
    const segments = [
      { id: 'slide', startMs: 0, endMs: 1000, voiceoverText: '', silence: { caption: '[title card]' } },
      { id: 'gap', startMs: 1000, endMs: 2000, voiceoverText: '', silence: { caption: '[music]' } },
    ];
    const dir = makeProject(t, { 'timing.json': timingWith(segments, { durationMs: '2000' }) });

    const r = runScript('write-subtitles.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.FAILED);
    assert.match(r.all, /set timing\.durationMs by hand, no shorter than the last segment's end/, r.all);
    assert.doesNotMatch(r.all, /voice\.mjs/, r.all);
  });

  test('writeSubtitles_unvoicedSegmentWhereTheVoiceStageWouldRefuse_saysWhyRatherThanSendingThere', (t) => {
    const segments = silentMiddleSegments();
    segments[2].voiceoverText = '';
    delete segments[2].audio;
    const dir = makeProject(t, { 'timing.json': timingWith(segments) });

    const r = runScript('write-subtitles.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.FAILED);
    assert.match(r.all, /timing\.segments\[2\] \("three"\) has no audio\.words/, r.all);
    assert.match(r.all, /refuses this timeline as it stands: timing\.segments\[2\] \("three"\) is narrated but has no narration text/, r.all);
    assert.doesNotMatch(r.all, /run voice\.mjs/, r.all);
  });

  test('writeSubtitles_spokenWordInASilentWindowWhereRemixWouldRefuse_saysWhyRatherThanSendingThere', (t) => {
    const words = [{ word: 'Alpha', startMs: 100, endMs: 500 }, { word: 'go', startMs: 500, endMs: 1000 }];
    const dir = makeProject(t, { 'timing.json': timingWith(spokenThenSilent('Alpha go.', words)), 'segment_01.mp3': clipBytes(960, MARKER_ONE) });

    const r = runScript('write-subtitles.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.FAILED);
    assert.match(r.all,
      /remix\.mjs \(S4\) reflows the timeline around it, but it refuses this timeline as it stands: timing\.segments\[1\] \("break"\) has no audio\.file/, r.all);
    assert.doesNotMatch(r.all, /run remix\.mjs/, r.all);
  });

  test('writeChapters_unmeasuredNarratedWindowWhereTheVoiceStageWouldRefuse_saysWhyRatherThanSendingThere', (t) => {
    const segments = silentMiddleSegments();
    segments[0].endMs = '480';
    segments[2].voiceoverText = '';
    const dir = makeProject(t, { 'timing.json': timingWith(segments) });

    const r = runScript('write-chapters.mjs', ['--list'], dir);

    assertCleanExit(r, EXIT.FAILED);
    assert.match(r.all, /timing\.segments\[0\] \("one"\): endMs is a string \(3 characters\)/, r.all);
    assert.match(r.all, /refuses this timeline as it stands: timing\.segments\[2\] \("three"\) is narrated but has no narration text/, r.all);
    assert.doesNotMatch(r.all, /Run voice\.mjs/, r.all);
  });

  // ---- the class sweep: calibration ------------------------------------------------------------
  test('buildCalibration_everySegmentSilent_offersAnEditTheVoiceStageWouldAccept', async () => {
    // Removing a declaration alone leaves a narrated segment with no text, which the TTS
    // service cannot synthesise, so the edit must give that segment its narration too.
    const { buildCalibration } = await import('../src/silent-segment.mjs');
    const segments = [{ id: 'slide', startMs: 0, endMs: 1000, voiceoverText: '', silence: { caption: '[title]' } }];

    assert.throws(
      () => buildCalibration(segments, [{ durationMs: 1000, headMs: 0, tailMs: 0 }], { voiceId: 'v', roundedSpeed: 1 }),
      /[Gg]ive a segment its narration text and remove its `silence` declaration/,
    );
  });

  // ---- the class sweep: validate-timing -------------------------------------------------------
  test('validateTiming_unreflowedSilentWindowWhereRemixWouldRefuse_saysWhy', (t) => {
    const dir = makeProject(t, { 'timing.json': timingWith(widenedIntermission()) });

    const r = runScript('validate-timing.mjs', [], dir);

    assertCleanExit(r, EXIT.FAILED);
    assert.match(r.all, /declared silence: NOT REFLOWED/, r.all);
    assert.match(r.all, /remix\.mjs \(S4\)[^\n]*refuses this timeline as it stands: segment_000\.mp3 is not in the project/, r.all);
    assert.doesNotMatch(r.all, /Run remix\.mjs/, r.all);
  });

  test('validateTiming_unreflowedRecordNamingNoClipInAnEntirelySilentTimeline_doesNotSendItToTheVoiceStage', (t) => {
    const segments = [
      { id: 'slide', startMs: 0, endMs: 1000, voiceoverText: '', silence: { caption: '[title card]' }, audio: { durationMs: 960, headMs: 0, tailMs: 0, words: [] } },
      { id: 'gap', startMs: 1000, endMs: 2000, voiceoverText: '', silence: { caption: '[music]' } },
    ];
    const dir = makeProject(t, { 'timing.json': timingWith(segments) });

    const r = runScript('validate-timing.mjs', [], dir);

    assertCleanExit(r, EXIT.FAILED);
    assert.match(r.all, /declared silence: NOT REFLOWED/, r.all);
    assert.match(r.all, /every segment is declared silent/, r.all);
    assert.doesNotMatch(r.all, /run voice\.mjs/i, r.all);
  });

  test('validateTiming_staleLineageWhereTheVoiceStageWouldRefuse_saysWhy', (t) => {
    const segments = voicedSilentMiddle();
    segments[0].voiceoverText = '';
    const dir = makeProject(t, { 'timing.json': timingWith(segments), 'calibration-observed.json': voiceCalibration(), ...voicedClips() });

    const r = runScript('validate-timing.mjs', [], dir);

    assert.match(r.all, /calibration lineage: STALE — segment "one" now has 0 word\(s\)/, r.all);
    // A refusal appended after an instruction does not retract it: the instruction goes.
    assert.doesNotMatch(r.all, /Re-run the\s+voice stage/, `voice refuses this timeline, so re-running it is not the step\n${r.all}`);
    assert.match(r.all,
      /voice\.mjs \(S3\) re-synthesises and re-measures it, but it refuses this timeline as it stands: segment "one" is narrated but has no narration text/, r.all);
    assert.match(r.all, /Write its narration, or, if it is meant to be silent, declare it silent/, r.all);
  });

  test('validateTiming_silencedLineageWhereRemixWouldRefuse_saysWhy', (t) => {
    const segments = voicedSilentMiddle();
    segments[2].voiceoverText = '';
    segments[2].silence = { caption: '[applause]' };
    segments[2].audio = { file: 'segment_002.mp3', durationMs: 720, headMs: 0, tailMs: 0, words: [] };
    const dir = makeProject(t, { 'timing.json': timingWith(segments), 'calibration-observed.json': voiceCalibration() });

    const r = runScript('validate-timing.mjs', [], dir);

    assert.match(r.all, /calibration lineage: STALE — segment "three" is declared silent now/, r.all);
    assert.match(r.all, /remix\.mjs \(S4\) refuses this timeline as it stands: segment_000\.mp3 is not in the project/, r.all);
  });

  test('validateTiming_unprovenLineageWhereTheVoiceStageWouldRefuse_saysWhy', (t) => {
    const segments = voicedSilentMiddle();
    segments[2].voiceoverText = '';
    const { textHash, ...unfingerprinted } = JSON.parse(voiceCalibration()).segments[0];
    assert.ok(textHash, 'the row had a fingerprint to remove');
    const dir = makeProject(t, {
      'timing.json': timingWith(segments),
      'calibration-observed.json': voiceCalibration({ one: unfingerprinted }),
      ...voicedClips(),
    });

    const r = runScript('validate-timing.mjs', [], dir);

    assert.match(r.all, /calibration lineage: UNPROVEN/, r.all);
    assert.match(r.all, /voice\.mjs \(S3\) refuses this timeline as it stands: segment "three" is narrated but has no narration text/, r.all);
  });

  test('validateTiming_calibrationWithNoRateWhereTheVoiceStageWouldRefuse_saysWhy', (t) => {
    const segments = voicedSilentMiddle();
    segments[0].voiceoverText = '';
    const dir = makeProject(t, {
      'timing.json': timingWith(segments),
      'calibration-observed.json': JSON.stringify({ voiceId: 'en-US-AvaNeural', roundedSpeed: 1, aggregate: {}, segments: [] }),
    });

    const r = runScript('validate-timing.mjs', [], dir);

    assert.notEqual(r.code, EXIT.OK, r.all);
    assert.match(r.all, /carries no `aggregate\.observedEffWps`/, r.all);
    assert.doesNotMatch(r.all, /Re-run the voice stage/, `voice refuses this timeline, so re-running it is not the step\n${r.all}`);
    assert.match(r.all, /Delete it to fall back to intake\.wordsPerSecond deliberately/, r.all);
    assert.match(r.all,
      /voice\.mjs \(S3\) regenerates it, but it refuses this timeline as it stands: segment "one" is narrated but has no narration text/, r.all);
    assert.match(r.all, /Write its narration, or, if it is meant to be silent, declare it silent/, r.all);
  });

  test('validateTiming_unsilencedLineageWithTextWhereTheVoiceStageWouldRefuse_saysWhy', (t) => {
    const segments = voicedSilentMiddle();
    delete segments[1].silence;
    segments[1].voiceoverText = 'now it speaks';
    segments[2].voiceoverText = '';
    const dir = makeProject(t, { 'timing.json': timingWith(segments), 'calibration-observed.json': voiceCalibration(), ...voicedClips() });

    const r = runScript('validate-timing.mjs', [], dir);

    assert.match(r.all, /calibration lineage: STALE — segment "intermission" is no longer declared silent/, r.all);
    // Restoring the declaration while the text is there would leave it malformed (a silent
    // segment must carry no narration text), so removing the text is named with it.
    assert.match(r.all, /restore its `silence` declaration \(with a caption\)\s+and remove its narration text/, r.all);
    assert.doesNotMatch(r.all, /Run that stage/, `voice refuses this timeline, so running it is not the step\n${r.all}`);
    assert.match(r.all,
      /voice\.mjs \(S3\) synthesises it, but it refuses this timeline as it stands: segment "three" is narrated but has no narration text/, r.all);
    assert.match(r.all, /Write its narration, or, if it is meant to be silent, declare it silent/, r.all);
  });

  test('validateTiming_unsilencedLineageWithNoTextWhereTheVoiceStageWouldRefuse_saysWhy', (t) => {
    // Asked of the timeline once the segment has its narration text: "three" still has none.
    const segments = voicedSilentMiddle();
    delete segments[1].silence;
    segments[2].voiceoverText = '';
    const dir = makeProject(t, { 'timing.json': timingWith(segments), 'calibration-observed.json': voiceCalibration(), ...voicedClips() });

    const r = runScript('validate-timing.mjs', [], dir);

    assert.match(r.all, /calibration lineage: STALE — segment "intermission" is no longer declared silent/, r.all);
    assert.doesNotMatch(r.all, /run that stage/i, `voice refuses this timeline, so running it is not the step\n${r.all}`);
    assert.match(r.all, /restore its `silence` declaration\s+\(with a caption\)/, r.all);
    assert.match(r.all,
      /give it its narration text; voice\.mjs \(S3\) synthesises it, but it refuses this timeline as it stands: segment "three" is narrated but has no narration text/, r.all);
    assert.match(r.all, /Write its narration, or, if it is meant to be silent, declare it silent/, r.all);
  });

  // REGRESSION GUARDS (pass before and after): where the voice stage would run, each of the
  // four instructions above is printed exactly as it always was.
  test('validateTiming_unsilencedLineageWithTextWhereTheVoiceStageWouldRun_keepsItsInstruction', (t) => {
    const segments = voicedSilentMiddle();
    delete segments[1].silence;
    segments[1].voiceoverText = 'now it speaks';
    const dir = makeProject(t, { 'timing.json': timingWith(segments), 'calibration-observed.json': voiceCalibration(), ...voicedClips() });

    const r = runScript('validate-timing.mjs', [], dir);

    assert.match(r.all,
      /\n  Run that stage, or restore its `silence` declaration \(with a caption\)\r?\n  and remove its narration text if it is meant to be silent\.\r?\n/, r.all);
    assert.doesNotMatch(r.all, /refuses this timeline/, r.all);
  });

  test('validateTiming_unsilencedLineageWithNoTextWhereTheVoiceStageWouldRun_keepsItsInstruction', (t) => {
    const segments = voicedSilentMiddle();
    delete segments[1].silence;
    const dir = makeProject(t, { 'timing.json': timingWith(segments), 'calibration-observed.json': voiceCalibration(), ...voicedClips() });

    const r = runScript('validate-timing.mjs', [], dir);

    assert.match(r.all,
      /\n  Give it its narration text and run that stage, or restore its `silence` declaration\r?\n  \(with a caption\) if it is meant to be silent\.\r?\n/, r.all);
    assert.doesNotMatch(r.all, /refuses this timeline/, r.all);
  });

  test('validateTiming_staleLineageWhereTheVoiceStageWouldRun_keepsItsInstruction', (t) => {
    const segments = voicedSilentMiddle();
    segments[0].voiceoverText = 'hello there my friend';
    const dir = makeProject(t, { 'timing.json': timingWith(segments), 'calibration-observed.json': voiceCalibration(), ...voicedClips() });

    const r = runScript('validate-timing.mjs', [], dir);

    assert.match(r.all, /calibration lineage: STALE — segment "one" now has 4 word\(s\)/, r.all);
    assert.match(r.all,
      /PREDICTION against these windows, with the safety margin restored\. Re-run the\r?\n  voice stage to re-measure before rendering — here that IS the right move, because\r?\n  the narration really has changed and the audio on disk is for the old text\.\r?\n/, r.all);
    assert.doesNotMatch(r.all, /refuses this timeline/, r.all);
  });

  test('validateTiming_calibrationWithNoRateWhereTheVoiceStageWouldRun_keepsItsInstruction', (t) => {
    const dir = makeProject(t, {
      'timing.json': timingWith(voicedSilentMiddle()),
      'calibration-observed.json': JSON.stringify({ voiceId: 'en-US-AvaNeural', roundedSpeed: 1, aggregate: {}, segments: [] }),
      ...voicedClips(),
    });

    const r = runScript('validate-timing.mjs', [], dir);

    assert.notEqual(r.code, EXIT.OK, r.all);
    assert.match(r.all,
      /used\. Re-run the voice stage to regenerate it, or delete it to fall back to intake\.wordsPerSecond deliberately\.\r?\n/, r.all);
    assert.doesNotMatch(r.all, /refuses this timeline/, r.all);
  });

  // ---- the class sweep: every branch of the duration remedies -----------------------------------
  // A duration short of the last window, or not a number at all, names the stage that
  // re-measures it. Each branch below is one where that stage would refuse.
  test('writeChapters_durationShortOfAFinalSilentWindowInAnEntirelySilentTimeline_saysToSetItByHand', (t) => {
    // No segment is narrated, so voice.mjs has nothing to synthesise, and no record names a
    // clip, so remix refuses: no stage measures this timeline.
    const segments = [
      { id: 'slide', startMs: 0, endMs: 960, voiceoverText: '', silence: { caption: '[title card]' } },
      { id: 'gap', startMs: 960, endMs: 3960, voiceoverText: '', silence: { caption: '[music]' } },
    ];
    const dir = makeProject(t, { 'timing.json': timingWith(segments, { durationMs: 1920, contentMs: 1920 }) });

    const r = runScript('write-chapters.mjs', ['--list'], dir);

    assertCleanExit(r, EXIT.FAILED, 'a duration shorter than the last window must fail: ');
    assert.match(r.all, /every segment is declared silent, so no stage measures the timeline: set timing\.durationMs by hand, no shorter than the last segment's end/, r.all);
    assert.doesNotMatch(r.all, /voice\.mjs|remix\.mjs/, r.all);
  });

  test('writeChapters_durationShortOfAFinalSilentWindowNamingNoClipWhereTheVoiceStageWouldRefuse_saysWhy', (t) => {
    const segments = spokenThenSilent('', alphaGo);
    segments[1].endMs = 3960;
    const dir = makeProject(t, { 'timing.json': timingWith(segments, { durationMs: 1920, contentMs: 1920 }) });

    const r = runScript('write-chapters.mjs', ['--list'], dir);

    assertCleanExit(r, EXIT.FAILED, 'a duration shorter than the last window must fail: ');
    assert.match(r.all,
      /voice\.mjs \(S3\) generates its clip and re-measures the timeline, but it refuses this timeline as it stands: timing\.segments\[0\] \("one"\) is narrated but has no narration text/, r.all);
    assert.doesNotMatch(r.all, /run voice\.mjs/i, r.all);
  });

  test('writeChapters_durationShortOfAWidenedFinalSilentWindowWhereRemixWouldRefuse_saysWhy', (t) => {
    // segment_01.mp3, which narrated "one" names, is not on disk, so remix would refuse.
    const segments = spokenThenSilent('Alpha go.', alphaGo);
    segments[1].endMs = 3960;
    segments[1].audio = { file: 'segment_02.mp3', durationMs: 960, headMs: 0, tailMs: 0, words: [] };
    const dir = makeProject(t, {
      'timing.json': timingWith(segments, { durationMs: 1920, contentMs: 1920 }),
      'segment_02.mp3': clipBytes(960, SILENT_MARKER),
    });

    const r = runScript('write-chapters.mjs', ['--list'], dir);

    assertCleanExit(r, EXIT.FAILED, 'a duration shorter than the last window must fail: ');
    assert.match(r.all,
      /remix\.mjs \(S4\) regenerates that silence and reflows the timeline onto it, with no re-voice, but it refuses this timeline as it stands: segment_01\.mp3 is not in the project/, r.all);
    assert.doesNotMatch(r.all, /run remix\.mjs/i, r.all);
  });

  test('writeSubtitles_durationShortAfterAMiddleSilentWindowWasWidenedWhereRemixWouldRefuse_saysWhy', (t) => {
    const dir = makeProject(t, { 'timing.json': timingWith(widenedIntermission(), { durationMs: 2160, contentMs: 2160 }) });

    const r = runScript('write-subtitles.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.FAILED, 'a duration shorter than the last window must fail: ');
    assert.match(r.all,
      /remix\.mjs \(S4\) regenerates that silence and reflows the timeline onto it, with no re-voice, but it refuses this timeline as it stands: segment_000\.mp3 is not in the project/, r.all);
    assert.doesNotMatch(r.all, /run remix\.mjs/i, r.all);
  });

  test('writeChapters_durationShortOfANarratedWindowWhereTheVoiceStageWouldRefuse_saysWhy', (t) => {
    const segments = silentMiddleSegments();
    segments[0].voiceoverText = '';
    const dir = makeProject(t, { 'timing.json': timingWith(segments, { durationMs: 2000, contentMs: 2000 }) });

    const r = runScript('write-chapters.mjs', ['--list'], dir);

    assertCleanExit(r, EXIT.FAILED, 'a duration shorter than the last window must fail: ');
    assert.match(r.all,
      /It closes the last chapter; voice\.mjs \(S3\) measures it, but it refuses this timeline as it stands: timing\.segments\[0\] \("one"\) is narrated but has no narration text/, r.all);
    assert.doesNotMatch(r.all, /run voice\.mjs/i, r.all);
  });

  test('writeSubtitles_durationNotANumberWithAMalformedDeclaration_namesTheDeclarationAndNoStage', (t) => {
    const segments = voicedSilentMiddle();
    segments[1].silence.caption = '';
    const dir = makeProject(t, { 'timing.json': timingWith(segments, { durationMs: 'unknown' }), ...voicedClips() });

    const r = runScript('write-subtitles.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.FAILED);
    assert.match(r.all,
      /It bounds the last cue, but a malformed silence declaration is reported here instead: timing\.segments\[1\] \("intermission"\) is declared silent but its `silence\.caption` is ""/, r.all);
    assert.doesNotMatch(r.all, /voice\.mjs|remix\.mjs/, `remix and voice each refuse a malformed declaration, so neither is named\n${r.all}`);
  });

  test('writeChapters_durationNotANumberInAnEntirelySilentTimelineWhereRemixWouldRun_namesRemix', (t) => {
    const segments = [
      { id: 'slide', startMs: 0, endMs: 960, voiceoverText: '', silence: { caption: '[title card]' },
        audio: { file: 'segment_01.mp3', durationMs: 960, headMs: 0, tailMs: 0, words: [] } },
      { id: 'gap', startMs: 960, endMs: 1920, voiceoverText: '', silence: { caption: '[music]' },
        audio: { file: 'segment_02.mp3', durationMs: 960, headMs: 0, tailMs: 0, words: [] } },
    ];
    const dir = makeProject(t, {
      'timing.json': timingWith(segments, { durationMs: 'unknown' }),
      'segment_01.mp3': clipBytes(960, SILENT_MARKER),
      'segment_02.mp3': clipBytes(960, SILENT_MARKER),
    });

    const r = runScript('write-chapters.mjs', ['--list'], dir);

    assertCleanExit(r, EXIT.FAILED);
    assert.match(r.all,
      /It closes the last chapter; every segment is declared silent, so there is no narration to measure: run remix\.mjs \(S4\), which generates the silence and measures the timeline, with no re-voice/, r.all);
    assert.doesNotMatch(r.all, /voice\.mjs/, r.all);
  });

  test('writeChapters_durationNotANumberWhereTheVoiceStageWouldRefuse_saysWhy', (t) => {
    const segments = silentMiddleSegments();
    segments[0].voiceoverText = '';
    const dir = makeProject(t, { 'timing.json': timingWith(segments, { durationMs: 'unknown' }) });

    const r = runScript('write-chapters.mjs', ['--list'], dir);

    assertCleanExit(r, EXIT.FAILED);
    assert.match(r.all,
      /It closes the last chapter; voice\.mjs \(S3\/S4\) measures it, but it refuses this timeline as it stands: timing\.segments\[0\] \("one"\) is narrated but has no narration text/, r.all);
    assert.doesNotMatch(r.all, /run voice\.mjs/i, r.all);
  });

  test('writeChapters_silentWindowEndWrittenAsAStringWithAMalformedDeclaration_namesTheDeclarationAndNoStage', (t) => {
    // Correcting the field alone leaves a malformed declaration (a blank caption), so the
    // message reports it instead of naming remix as the stage that reflows the window.
    const segments = voicedSilentMiddle();
    segments[1].endMs = '5000';
    segments[1].silence.caption = '';
    const dir = makeProject(t, { 'timing.json': timingWith(segments), ...voicedClips() });

    const r = runScript('write-chapters.mjs', ['--list'], dir);

    assertCleanExit(r, EXIT.FAILED);
    assert.match(r.all,
      /endMs is a string \(4 characters\) — write it as a number of milliseconds, >= 0 and greater than startMs \(480\)\. A malformed silence declaration is reported here instead: timing\.segments\[1\] \("intermission"\) is declared silent but its `silence\.caption` is ""/, r.all);
    assert.doesNotMatch(r.all, /voice\.mjs|remix\.mjs/, r.all);
  });

  // ---- R8-1: the advice that ends a remix collision refusal, on its routes outside remix -------
  // Each fixture below was measured to print that advice: write-chapters and write-subtitles in
  // a duration remedy, validate-timing in a lineage note and in a NOT REFLOWED repair. Each pin
  // matches one whole line, from where the route starts it to the end of the advice. Anchored at
  // both ends, it fails when the advice loses its tail or gains one.
  const wholeLine = (start, end) => new RegExp(`^${escape(start)}[^\\n]*${escape(end)}\\r?$`, 'm');
  // Names, sizes and mtimes: the "nothing was written" check.
  const listing = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort()
    .map((f) => { const s = fs.statSync(path.join(dir, f)); return `${f}:${s.size}:${s.mtimeMs}`; });

  for (const [stage, script, argSets] of [
    ['writeChapters', 'write-chapters.mjs', [[], ['--list'], ['--apply']]],
    ['writeSubtitles', 'write-subtitles.mjs', [[], ['--apply']]],
  ]) {
    test(`${stage}_durationShortWhereANarratedRecordNamesTheSilentClip_endsWithTheReplaceRunAndWhatItOverwrites`, (t) => {
      // Narrated "one" names segment_02.mp3, the name that belongs to silent "break"'s
      // position, as if the timeline was reordered after voice ran.
      const segments = spokenThenSilent('Alpha go.', alphaGo);
      segments[0].audio.file = 'segment_02.mp3';
      segments[1].audio = { file: 'segment_01.mp3', durationMs: 960, headMs: 0, tailMs: 0, words: [] };
      const dir = makeProject(t, {
        'timing.json': timingWith(segments, { durationMs: 1000 }),
        'segment_01.mp3': clipBytes(960, SILENT_MARKER),
        'segment_02.mp3': clipBytes(960, MARKER_ONE),
      });
      const before = listing(dir);

      for (const args of argSets) {
        const r = runScript(script, args, dir);

        assertCleanExit(r, EXIT.FAILED, `${script} ${args.join(' ') || '(plan)'}: a duration shorter than the last window must fail: `);
        assert.match(r.all, wholeLine('error: timing.durationMs is 1000 — ',
          `Then run remix.mjs --apply --replace: --replace because segment_02.mp3 is still there, and this run overwrites it with timing.segments[1] ("break")'s silence`), r.all);
        assert.equal(r.all.trimEnd().split(/\r?\n/).length, 1, `one line of output\n${r.all}`);
        assert.deepEqual(listing(dir), before, 'nothing may be written');
      }
    });
  }

  // "three" silenced in place, as validateTiming_segmentDeclaredSilentSinceMeasured_* silences
  // it, while narrated "one"'s record names segment_03.mp3: the name remix gives three's clip.
  const threeSilencedOverOnesClip = () => {
    const segments = voicedSilentMiddle();
    segments[2].voiceoverText = '';
    segments[2].silence = { caption: '[applause]' };
    segments[2].audio = { file: 'segment_002.mp3', durationMs: 720, headMs: 0, tailMs: 0, words: [] };
    segments[0].audio.file = 'segment_03.mp3';
    return segments;
  };
  const threesArm =
    `Then run remix.mjs --apply --replace: --replace because segment_03.mp3 is still there, and this run overwrites it with segment "three"'s silence.`;

  test('validateTiming_silencedLineageWhereANarratedRecordNamesTheSilentClip_endsWithTheReplaceRunAndWhatItOverwrites', (t) => {
    const dir = makeProject(t, {
      'timing.json': timingWith(threeSilencedOverOnesClip()),
      'calibration-observed.json': voiceCalibration(),
      'segment_001.mp3': clipBytes(960, SILENT_MARKER),
      'segment_002.mp3': clipBytes(720, SILENT_MARKER),
      'segment_03.mp3': clipBytes(480, MARKER_ONE),
    });
    const before = listing(dir);

    const r = runScript('validate-timing.mjs', [], dir);

    assertCleanExit(r, EXIT.OK, 'lineage is advisory: ');
    assert.match(r.all, wholeLine('  remix.mjs (S4) refuses this timeline as it stands: ', threesArm), r.all);
    assert.equal(r.all.split(threesArm).length - 1, 1, `the lineage note alone prints it\n${r.all}`);
    assert.deepEqual(listing(dir), before, 'nothing may be written');
  });

  test('validateTiming_unreflowedSilentWindowWhereANarratedRecordNamesItsClip_endsWithTheReplaceRunAndWhatItOverwrites', (t) => {
    const segments = threeSilencedOverOnesClip();
    segments[2].endMs += 240; // a 960 ms window against a record of 720 ms
    const dir = makeProject(t, {
      'timing.json': timingWith(segments),
      'segment_001.mp3': clipBytes(960, SILENT_MARKER),
      'segment_002.mp3': clipBytes(720, SILENT_MARKER),
      'segment_03.mp3': clipBytes(480, MARKER_ONE),
    });
    const before = listing(dir);

    const r = runScript('validate-timing.mjs', [], dir);

    assertCleanExit(r, EXIT.FAILED, 'a silent window its record does not describe must fail: ');
    assert.match(r.all, /declared silence: NOT REFLOWED/, r.all);
    assert.match(r.all,
      wholeLine('  segment "three" window is 960ms, but its audio record describes 720ms of generated silence', threesArm), r.all);
    assert.equal(r.all.split(threesArm).length - 1, 1, `the NOT REFLOWED repair alone prints it\n${r.all}`);
    assert.deepEqual(listing(dir), before, 'nothing may be written');
  });

  // ---- R5-4: the stages read the project's timing.json, whatever file --timing selects -------
  // A stage named as the step for another file would read a different timeline, or none.
  const installStep = /The stages read [^\n]*timing\.json, not [^\n]*alt\.json\. To act on the file this run checked, install it as timing\.json( \(replacing the timing\.json there now\))? and run validate-timing again without --timing: that run decides the stage\./;

  test('validateTiming_alternateTimingFileWithNoProjectTiming_namesNoStageAndSaysToInstallIt', (t) => {
    const dir = makeProject(t, { 'alt.json': timingWith(widenedIntermission()), ...voicedClips() });

    const r = runScript('validate-timing.mjs', ['--timing', 'alt.json'], dir);

    assertCleanExit(r, EXIT.FAILED, 'an unreflowed silent window fails in whichever file it is: ');
    assert.match(r.all, /declared silence: NOT REFLOWED/, r.all);
    assert.doesNotMatch(r.all, /remix\.mjs|voice\.mjs/, `remix and voice read timing.json, and there is none\n${r.all}`);
    assert.match(r.all, installStep, r.all);
    assert.doesNotMatch(r.all, /replacing/, `there is no timing.json to replace\n${r.all}`);
  });

  test('validateTiming_alternateTimingFileBesideADifferentProjectTiming_saysTheInstallReplacesIt', (t) => {
    const dir = makeProject(t, {
      'timing.json': timingWith(voicedSilentMiddle()),
      'alt.json': timingWith(widenedIntermission()),
      ...voicedClips(),
    });

    const r = runScript('validate-timing.mjs', ['--timing', 'alt.json'], dir);

    assertCleanExit(r, EXIT.FAILED);
    assert.match(r.all, /declared silence: NOT REFLOWED/, r.all);
    assert.doesNotMatch(r.all, /remix\.mjs|voice\.mjs/, `remix and voice would act on the timing.json beside it\n${r.all}`);
    assert.match(r.all, installStep, r.all);
    assert.match(r.all, /install it as timing\.json \(replacing the timing\.json there now\)/, r.all);
  });

  test('validateTiming_alternateTimingFileWithStaleLineage_namesNoStage', (t) => {
    // The lineage branches and the missing-rate error go through the same decision.
    const stale = voicedSilentMiddle();
    stale[0].voiceoverText = 'hello there my friend';
    const dir = makeProject(t, {
      'timing.json': timingWith(voicedSilentMiddle()),
      'alt.json': timingWith(stale),
      'calibration-observed.json': voiceCalibration(),
      ...voicedClips(),
    });

    const r = runScript('validate-timing.mjs', ['--timing', 'alt.json'], dir);

    assert.match(r.all, /calibration lineage: STALE — segment "one" now has 4 word\(s\)/, r.all);
    assert.doesNotMatch(r.all, /Re-run the\s+voice stage|voice\.mjs|remix\.mjs/, r.all);
    assert.match(r.all, installStep, r.all);

    fs.writeFileSync(path.join(dir, 'calibration-observed.json'),
      JSON.stringify({ voiceId: 'en-US-AvaNeural', roundedSpeed: 1, aggregate: {}, segments: [] }));
    const rate = runScript('validate-timing.mjs', ['--timing', 'alt.json'], dir);

    assert.match(rate.all, /carries no `aggregate\.observedEffWps`/, rate.all);
    assert.doesNotMatch(rate.all, /Re-run the voice stage|voice\.mjs \(S3\)/, rate.all);
    assert.match(rate.all, /Delete it to fall back to intake\.wordsPerSecond deliberately/, rate.all);
    assert.match(rate.all, installStep, rate.all);
  });

  // REGRESSION GUARD (passes before and after): every spelling of the project's own
  // timing.json names the file the stages read, before remix republishes it and after, so it
  // is the default. Each runs the stage the default names, and is asked again.
  const projectWhoseTimingRemixWouldReflow = (t) => makeProject(t, {
    'timing.json': timingWith(widenedIntermission()),
    'calibration-observed.json': voiceCalibration(),
    ...voicedClips(),
  });
  for (const [spelled, spell, unavailable] of [
    ['AsTheDefault', () => 'timing.json'],
    ['AsAnAbsolutePath', (dir) => path.join(dir, 'timing.json')],
    ['InUpperCase', () => (process.platform === 'win32' ? 'TIMING.JSON' : null), 'names differ by case off Windows'],
    ['DotRelativeInUpperCase', () => (process.platform === 'win32' ? '.\\TIMING.JSON' : null), 'names differ by case off Windows'],
    ['ByItsShortName', (dir) => shortNameOf(path.join(dir, 'timing.json')),
      'no 8.3 short name here: not Windows, or this volume does not generate them'],
    ['ThroughAnInRootLink', (dir) => (tryMakeFileLink(path.join(dir, 'link.json'), 'timing.json') ? 'link.json' : null),
      'platform refused to create a file link'],
  ]) {
    test(`validateTiming_timingFlagNamingTheProjectTimingFile${spelled}_printsWhatARunWithoutItPrintsBeforeAndAfterRemix`, (t) => {
      const dir = projectWhoseTimingRemixWouldReflow(t);
      const spelling = spell(dir);
      if (spelling === null) return t.skip(unavailable);
      const plain = runScript('validate-timing.mjs', [], dir);
      assertCleanExit(plain, EXIT.FAILED, 'the widened window fails until remix reflows it: ');
      assert.match(plain.all, /Run remix\.mjs \(S4\)/, `the run without --timing names remix\n${plain.all}`);

      const r = runScript('validate-timing.mjs', ['--timing', spelling], dir);

      assert.equal(r.code, plain.code, `--timing ${spelling}\n${r.all}`);
      assert.equal(r.all, plain.all, `--timing ${spelling} is the project's timing.json`);

      assertCleanExit(runScript('remix.mjs', ['--apply', '--replace'], dir, { nodeArgs: ['--import', FAKE_AUDIO] }), EXIT.OK,
        'the stage the default named must run: ');
      const after = runScript('validate-timing.mjs', ['--timing', spelling], dir);

      assert.doesNotMatch(after.all, /NOT REFLOWED/, `--timing ${spelling} must read the timeline remix published\n${after.all}`);
      if (spelled === 'ByItsShortName' && !fs.existsSync(path.join(dir, spelling))) {
        // Measured both ways: a short name can follow the replaced file's name, or go with it.
        t.diagnostic(`${spelling} went with the file remix replaced; validate reports it missing`);
        assertCleanExit(after, EXIT.USAGE, 'a short name that names nothing is a missing file: ');
        assert.match(after.all, /timing file not found: /, after.all);
      } else {
        if (spelled === 'ByItsShortName') t.diagnostic(`${spelling} now names the timing.json remix published`);
        assertCleanExit(after, EXIT.OK, `--timing ${spelling} after remix: `);
      }
    });
  }

  test('validateTiming_timingFlagNamingAHardLinkOfTheProjectTimingFile_namesNoStageAndSaysWhatARenameLeavesIt', (t) => {
    // A hard link is the project's timing.json only until a stage republishes it by rename,
    // so the stage a run without --timing names would repair a file the link no longer reads.
    const dir = projectWhoseTimingRemixWouldReflow(t);
    try {
      fs.linkSync(path.join(dir, 'timing.json'), path.join(dir, 'same-file.json'));
    } catch {
      return t.skip('platform refused to hard-link');
    }
    const hardLink = new RegExp('[^\\n]*same-file\\.json is a hard link to [^\\n]*timing\\.json, the file the stages read\\. ' +
      'A stage that rewrites the timeline can replace that file with a new one rather than write through it, which would ' +
      'leave [^\\n]*same-file\\.json holding the timeline this run checked\\. Run validate-timing again without --timing: ' +
      'that run decides the stage, on the file the stages read\\.');

    const r = runScript('validate-timing.mjs', ['--timing', 'same-file.json'], dir);

    assertCleanExit(r, EXIT.FAILED, 'an unreflowed silent window fails in whichever file it is: ');
    assert.match(r.all, /declared silence: NOT REFLOWED/, r.all);
    assert.doesNotMatch(r.all, /remix\.mjs|voice\.mjs/, `remix would replace timing.json and leave the link behind\n${r.all}`);
    assert.match(r.all, hardLink, r.all);
    assert.doesNotMatch(r.all, /install/, `installing the link as timing.json would copy a file onto itself\n${r.all}`);

    const plain = runScript('validate-timing.mjs', [], dir);
    assertCleanExit(plain, EXIT.FAILED);
    assert.match(plain.all, /Run remix\.mjs \(S4\)/, plain.all);
    assertCleanExit(runScript('remix.mjs', ['--apply', '--replace'], dir, { nodeArgs: ['--import', FAKE_AUDIO] }), EXIT.OK,
      'the stage the default named must run: ');
    assertCleanExit(runScript('validate-timing.mjs', [], dir), EXIT.OK, 'remix repaired the file the stages read: ');

    const left = runScript('validate-timing.mjs', ['--timing', 'same-file.json'], dir);

    assertCleanExit(left, EXIT.FAILED, 'the link kept the timeline it was checked with, as the sentence said: ');
    assert.match(left.all, /declared silence: NOT REFLOWED/, left.all);
  });

  test('validateTiming_timingFlagNamingAHardLinkWhereTheVolumeReportsNoFileIds_saysToInstallIt', (t) => {
    // CHARACTERIZATION (passes before and after): with no file IDs a hard link cannot be told
    // from another file, so it is given the install step another file gets.
    const dir = projectWhoseTimingRemixWouldReflow(t);
    try {
      fs.linkSync(path.join(dir, 'timing.json'), path.join(dir, 'same-file.json'));
    } catch {
      return t.skip('platform refused to hard-link');
    }

    const r = runScript('validate-timing.mjs', ['--timing', 'same-file.json'], dir, { nodeArgs: ['--import', zeroFileIds({ dir })] });

    assert.match(r.all, ZERO_FILE_IDS_ARMED, `the volume must report no file IDs\n${r.all}`);
    assertCleanExit(r, EXIT.FAILED);
    assert.doesNotMatch(r.all, /remix\.mjs|voice\.mjs/, r.all);
    assert.doesNotMatch(r.all, /is a hard link/, `with no file IDs a hard link cannot be told\n${r.all}`);
    assert.match(r.all, /The stages read [^\n]*timing\.json, not [^\n]*same-file\.json\. To act on the file this run checked, install it as timing\.json \(replacing the timing\.json there now\)/, r.all);
  });
});

// ---------------------------------------------------------------------------
// canonicalName: the ONE answer to "what is this file called", shared by validate's
// --timing decision, remix's plan accounting and remix's narrated-clip guard. Each caller
// states its own policy for a failure; the function reports one rather than guessing.
// ---------------------------------------------------------------------------
describe('canonicalName', () => {
  const load = async () => (await import('../src/silent-segment.mjs')).canonicalName;

  test('canonicalName_pathThatDoesNotExist_isReturnedAsTyped', async (t) => {
    const canonicalName = await load();
    const dir = makeProject(t);
    const absent = path.join(dir, 'Not-Here.MP3');

    assert.equal(canonicalName(absent), absent, 'nothing exists to name, so the caller compares the text it has');
  });

  test('canonicalName_shortNameOrCaseVariantOfAFile_isItsLongName', async (t) => {
    const canonicalName = await load();
    const dir = makeProject(t, { 'voiceover.mp3': 'bytes' });
    const long = canonicalName(path.join(dir, 'voiceover.mp3'));
    assert.equal(path.basename(long), 'voiceover.mp3');
    const spellings = [];
    if (process.platform === 'win32') spellings.push('VOICEOVER.MP3');
    const alias = shortNameOf(path.join(dir, 'voiceover.mp3'));
    if (alias !== null) spellings.push(alias);
    if (spellings.length === 0) return t.skip('names differ by case off Windows, and no 8.3 short name is generated here');

    for (const spelling of spellings) assert.equal(canonicalName(path.join(dir, spelling)), long, spelling);
  });

  test('canonicalName_linkInsideTheProject_isTheNameOfTheFileItLeadsTo', async (t) => {
    const canonicalName = await load();
    const dir = makeProject(t, { 'voiceover.mp3': 'bytes' });
    if (!tryMakeFileLink(path.join(dir, 'link.mp3'), 'voiceover.mp3')) return t.skip('platform refused to create a file link');

    assert.equal(canonicalName(path.join(dir, 'link.mp3')), canonicalName(path.join(dir, 'voiceover.mp3')));
  });

  test('canonicalName_failureOtherThanAbsence_isThrownForTheCallerToDecide', async (t) => {
    const canonicalName = await load();
    const dir = makeProject(t);

    assert.throws(() => canonicalName(path.join(dir, 'nul\0byte.mp3')), (err) => err.code === 'ERR_INVALID_ARG_VALUE',
      'a name the platform cannot ask about is not an absent one');
    const looped = tryMakeFileLink(path.join(dir, 'a.mp3'), 'b.mp3') && tryMakeFileLink(path.join(dir, 'b.mp3'), 'a.mp3');
    if (!looped) return t.skip('platform refused to create a file link');
    assert.throws(() => canonicalName(path.join(dir, 'a.mp3')), (err) => err.code === 'ELOOP',
      'a loop of links names no file, and is not an absent one either');
  });
});

// ===========================================================================
// The timeline's shape, and a silent segment's window and caption
//
// Every segment has a non-empty string id, as timing-schema.json says: a stage names a
// segment by its id, and one with none was named "undefined", or crashed the stage. A silent
// segment's window is authored and is all of its duration, so each bound is a finite number:
// a null, a string or an array was coerced into a window. The window is at most the hour of
// silence the engine generates, past which silentMp3 allocated whatever it was asked for. And
// the caption is written into the subtitle sidecars as one cue, so it holds no line break and
// no "-->", either of which can forge another cue.
// ===========================================================================
const load = () => import('../src/silent-segment.mjs');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const FORGED_CUE = '[music]\n\n00:00.000 --> 00:05.000\nX';
const HOUR_MS = 3_600_000;

describe('segmentLabel', () => {
  const load2 = () => import('../src/silent-segment.mjs');

  test('voiceTimelineBlocker_anAllSilentTimeline_carriesARemedyNotJustAFact', async () => {
    // renderBlocker prints the fact ALONE when `then` is absent (silent-segment.mjs:1176), so
    // this refusal reached the author as a statement of the problem with no way out. Every
    // other refusal in this gate carries one, and write-chapters already words this exact
    // situation with a remedy — "run remix.mjs (S4)" — so the engine has the answer; the gate
    // simply did not say it.
    const { voiceTimelineBlocker, renderBlocker } = await load2();
    const silent = (id) => ({ id, startMs: 0, endMs: 960, silence: { caption: '[intermission]' } });
    // endCard is explicit because F7 moved the end-card check INTO this gate, and it runs
    // last — a fixture omitting it is refused for that instead, which is what caught me here.
    const b = voiceTimelineBlocker({ endCard: { enabled: false }, segments: [silent('one'), silent('two')] });

    assert.ok(b, 'an all-silent timeline must still be refused');
    assert.match(b.fact, /every segment is declared silent/);
    assert.ok(b.then, `the refusal must carry a remedy\n${JSON.stringify(b)}`);
    assert.notEqual(renderBlocker(b), b.fact.replace(/\.$/, ''), 'the rendered refusal must include the remedy');
  });

  test('voiceTimelineBlocker_anAllSilentTimelineWithNoClips_doesNotSendTheAuthorToRemix', async () => {
    // MEASURED LOOP. The first version of this remedy said "run remix.mjs (S4)"
    // unconditionally. For an all-silent timeline that has never been voiced, remix refuses
    // with `segment "one" has no audio.file ...` and its own remedy names voice.mjs — the
    // stage that just refused. The author is handed a circle.
    //
    // `hasAudioFile` reads the timing object, so the gate can tell the two cases apart
    // without touching the filesystem.
    const { voiceTimelineBlocker } = await load2();
    const silent = (id) => ({ id, startMs: 0, endMs: 960, silence: { caption: '[intermission]' } });
    const b = voiceTimelineBlocker({ endCard: { enabled: false }, segments: [silent('one'), silent('two')] });

    assert.ok(b?.then, 'the refusal must still carry a remedy');
    // "Do not SEND them to remix", not "do not mention it". Naming remix to rule it out is
    // better than silence: it stops the author trying the obvious thing and bouncing off a
    // second refusal. My first version of this assertion banned the word outright and failed
    // against the correct message.
    assert.doesNotMatch(b.then, /run remix/i, `remix refuses this timeline, so it must not be offered\n${b.then}`);
    assert.match(b.then, /remix\.mjs \(S4\) cannot/i, `say why remix is not the way out\n${b.then}`);
    assert.match(b.then, /narration/i, `the only way forward is narration\n${b.then}`);
  });

  test('voiceTimelineBlocker_anAllSilentTimeline_remedyAlsoSaysToRemoveTheSilenceDeclaration', async () => {
    // MEASURED: "write narration for at least one segment" does NOT clear this refusal.
    // isSilentSegment is "has a `silence` key", so adding narration while leaving the
    // declaration in place lands on the next gate instead:
    //   `segment "one" is declared silent but carries narration text`
    // A remedy that produces a different refusal is not a remedy. Removing the declaration
    // as well is what actually works — verified by running both edits through the gate.
    const { voiceTimelineBlocker } = await load2();
    const silent = (id) => ({ id, startMs: 0, endMs: 960, silence: { caption: '[intermission]' } });
    const b = voiceTimelineBlocker({ endCard: { enabled: false }, segments: [silent('one'), silent('two')] });

    assert.match(b.then, /remove .*silence declaration/i, `the edit must be complete, not half of one\n${b.then}`);
  });

  test('voiceTimelineBlocker_anAllSilentTimelineWithSomeClips_doesNotClaimNoSegmentHasOne', async () => {
    // The partial case: one segment carries a clip record and the other does not. "no segment
    // has one" is simply false there, and a false reason invites the author to disbelieve the
    // true part of the message.
    const { voiceTimelineBlocker } = await load2();
    const silent = (id) => ({ id, startMs: 0, endMs: 960, silence: { caption: '[intermission]' } });
    const withClip = (id, f) => ({ ...silent(id), audio: { file: f, durationMs: 960 } });
    const b = voiceTimelineBlocker({
      endCard: { enabled: false },
      segments: [withClip('one', 'segment_01.mp3'), silent('two')],
    });

    assert.ok(b?.then, 'the refusal must carry a remedy');
    assert.doesNotMatch(b.then, /no segment has one/i, `one segment DOES have one\n${b.then}`);
    assert.match(b.then, /not every segment has one/i, `say what is actually true\n${b.then}`);
  });

  test('voiceTimelineBlocker_anAllSilentTimelineWhoseClipsExist_offersRemix', async () => {
    // The other branch: every segment already carries a measured clip, so remix CAN arrange
    // the timeline from its authored windows without synthesising anything. Without this
    // pair, "never mention remix" would satisfy the test above.
    const { voiceTimelineBlocker } = await load2();
    const voiced = (id, file) => ({
      id, startMs: 0, endMs: 960,
      silence: { caption: '[intermission]' },
      audio: { file, durationMs: 960 },
    });
    const b = voiceTimelineBlocker({
      endCard: { enabled: false },
      segments: [voiced('one', 'segment_01.mp3'), voiced('two', 'segment_02.mp3')],
    });

    assert.ok(b?.then, 'the refusal must still carry a remedy');
    assert.match(b.then, /run remix\.mjs \(S4\)/, `with clips in place remix is the stage that can do this\n${b.then}`);
    // A RECORD IS NOT A FILE. `hasAudioFile` tests the string in the timeline, not whether the
    // clip is on disk — measured: remix refuses `segment_01.mp3 is not in the project` for a
    // record naming a file that is absent. So the offer must carry its precondition rather
    // than promise a run that can still bounce.
    assert.match(b.then, /still in the project|if .*clip/i, `the remix offer must state its precondition\n${b.then}`);
  });

  test('voiceTimelineBlocker_aTimelineWithNarration_isNotRefusedAsAllSilent', async () => {
    // The discriminating control: a gate that always returned this refusal would satisfy the
    // test above.
    const { voiceTimelineBlocker } = await load2();
    const b = voiceTimelineBlocker({
      endCard: { enabled: false },
      segments: [
        { id: 'one', startMs: 0, endMs: 960, silence: { caption: '[intermission]' } },
        { id: 'two', startMs: 960, endMs: 1920, voiceoverText: 'hello there friend' },
      ],
    });
    assert.equal(b, null, `a timeline with narration must pass the gate\n${JSON.stringify(b)}`);
  });

  test('segmentLabel_aSegmentWithAnId_namesItByThatId', async () => {
    const { segmentLabel } = await load2();
    assert.equal(typeof segmentLabel, 'function', 'silent-segment.mjs must export segmentLabel');
    assert.equal(segmentLabel({ id: 'intro' }, 0), 'segment "intro"');
    assert.equal(segmentLabel({ id: '2' }, 5), 'segment "2"', 'an id that looks like an index is still an id');
  });

  for (const [scenario, seg] of [
    ['AMissingId', {}],
    ['AnEmptyId', { id: '' }],
    ['ANullId', { id: null }],
    ['ANumericId', { id: 7 }],
    ['ANullSegment', null],
  ]) {
    test(`segmentLabel_${scenario}_namesItByIndexNotAsAQuotedId`, async () => {
      // `segment "2"` for the segment AT INDEX 2 sends an author looking for a segment
      // genuinely called "2" — and one may exist, which is the whole problem. The engine
      // already says so in two places: frame-capture.mjs:123 picks `timing.segments[i]` for
      // exactly this case, and segmentEntryFact's own doc explains that `segment "1"` would
      // send an author to the wrong line when another segment really carries the id "1".
      // This is that rule as ONE statement rather than a sixth restatement of it.
      const { segmentLabel } = await load2();
      assert.equal(segmentLabel(seg, 2), 'timing.segments[2]');
    });
  }

  test('segmentLabel_isTheFormTheShapeCheckAlreadyUses', async () => {
    // Pins the two statements together: if either moves, this fails. Without it the extracted
    // symbol could drift from the shape refusal it was extracted to agree with.
    const { segmentLabel, shapeBlocker } = await load2();
    const fact = shapeBlocker({ segments: [{ id: 'one', startMs: 0, endMs: 1, voiceoverText: 'x' }, null] }).fact;
    assert.ok(
      fact.startsWith(`${segmentLabel(null, 1)} `),
      `the shape refusal and the label must name an id-less segment identically\n  fact:  ${fact}\n  label: ${segmentLabel(null, 1)}`,
    );
  });
});

describe('shapeBlocker', () => {
  const ok = (id) => ({ id, startMs: 0, endMs: 960, voiceoverText: 'hello there friend' });
  const idless = () => ({ startMs: 0, endMs: 960, voiceoverText: 'hello there friend' });
  const ID_RULE = 'every segment needs a non-empty string id';
  // ONLY THE NO-SEGMENTS FACT CARRIES A REMEDY. The other two name the field and the rule
  // it breaks in one sentence; this one names an absence and stops, so it is the only one
  // where "what do I do now" is not already answered.
  const NO_SEGMENTS_REMEDY = (name = 'timing.json') =>
    `write the timeline's segments into ${name} — each needs a non-empty string id`;
  const CASES = [
    ['NoSegmentList', {}, 'timing.json declares no segments', NO_SEGMENTS_REMEDY()],
    ['AnEmptySegmentList', { segments: [] }, 'timing.json declares no segments', NO_SEGMENTS_REMEDY()],
    // One pass in index order: the first entry that is not a segment object, or has no id.
    ['AnIdlessSegmentBeforeANullOne', { segments: [ok('one'), idless(), null] }, `timing.segments[1]'s id is missing — ${ID_RULE}`],
    ['ANullSegmentBeforeAnIdlessOne', { segments: [null, idless()] }, 'timing.segments[0] is not a segment object'],
    ['AnEmptyId', { segments: [ok('one'), ok('')] }, `timing.segments[1]'s id is empty — ${ID_RULE}`],
    ['ANumericId', { segments: [ok(7), ok('two')] }, `timing.segments[0]'s id is 7 — ${ID_RULE}`],
    ['ANullId', { segments: [ok('one'), ok(null)] }, `timing.segments[1]'s id is null — ${ID_RULE}`],
    ['ABooleanId', { segments: [ok('one'), ok('two'), ok(true)] }, `timing.segments[2]'s id is a boolean — ${ID_RULE}`],
    ['AnArrayEntry', { segments: [ok('one'), []] }, 'timing.segments[1] is not a segment object'],
  ];

  // CHANGED DELIBERATELY. This was `_isRefusedWithTheFactAlone`, asserting `{ fact }` and
  // nothing else, with the note "the fact, naming the index, and no remedy". Two of the nine
  // cases now carry a remedy, so the name and the assertion say so. The other seven still
  // assert the fact ALONE — an extra key on any of them fails here, so the exemption cannot
  // spread by accident.
  for (const [scenario, timing, fact, then] of CASES) {
    test(`shapeBlocker_${scenario}_isRefusedWithExactlyTheFactAndRemedyItDeclares`, async () => {
      const { shapeBlocker } = await load();
      assert.equal(typeof shapeBlocker, 'function', 'silent-segment.mjs must export shapeBlocker');

      assert.deepEqual(
        shapeBlocker(timing),
        then === undefined ? { fact } : { fact, then },
        then === undefined ? 'the fact, naming the index, and no remedy' : 'the fact and the remedy it declares',
      );
    });
  }

  test('shapeBlocker_segmentsEachWithANonEmptyStringId_isAccepted', async () => {
    const { shapeBlocker } = await load();
    assert.equal(typeof shapeBlocker, 'function', 'silent-segment.mjs must export shapeBlocker');

    assert.equal(shapeBlocker({ segments: [ok('one'), ok('2'), ok(' ')] }), null);
  });

  // ---- the input name -------------------------------------------------------------------
  // The no-segments fact hardcoded the literal 'timing.json', so a caller reading a
  // differently-named file was told about a file it never mentioned — the same
  // wrong-diagnosis shape as naming knobs.json when the caller passed manifest.json.
  //
  // The CONSTRAINT is what makes this delicate: voice.mjs and remix.mjs both hardcode
  // timing.json as their input and call shapeBlocker with one argument, so their message is
  // correct today and must not move by a byte. The name is therefore additive and defaults
  // to the only value those two can mean.

  test('shapeBlocker_withNoNameGiven_keepsTheShippedWordingByteForByte', async () => {
    // A CONTROL, not evidence: this passes before the change as well. It is here because it
    // is the thing the change must not break, and two shipped stages depend on it.
    const { shapeBlocker } = await load();
    assert.deepEqual(shapeBlocker({ segments: [] }), { fact: 'timing.json declares no segments', then: NO_SEGMENTS_REMEDY() });
    assert.deepEqual(shapeBlocker({}), { fact: 'timing.json declares no segments', then: NO_SEGMENTS_REMEDY() });
  });

  // THE REMEDY FOLLOWS THE NAME TOO. It tells an author which file to write into, so a
  // remedy that always said "timing.json" would send the caller of a differently-named file
  // to edit one it never opened — the very defect the name parameter exists to fix, moved
  // one clause to the right.
  test('shapeBlocker_givenTheNameItRead_namesThatFileInsteadOfTimingJson', async () => {
    const { shapeBlocker } = await load();
    assert.deepEqual(shapeBlocker({ segments: [] }, 'custom.json'),
      { fact: 'custom.json declares no segments', then: NO_SEGMENTS_REMEDY('custom.json') });
    assert.deepEqual(shapeBlocker({}, 'scene-b.json'),
      { fact: 'scene-b.json declares no segments', then: NO_SEGMENTS_REMEDY('scene-b.json') });
  });

  test('shapeBlocker_givenAName_leavesTheEntryAndIdFactsAlone', async () => {
    // `timing.segments[1]` is a JSON PATH into the parsed object, not a filename, so it does
    // not move with the input's name. Without this control, "replace every occurrence of
    // timing" would pass the test above and corrupt every other fact in this gate.
    const { shapeBlocker } = await load();
    assert.deepEqual(
      shapeBlocker({ segments: [ok('one'), null] }, 'custom.json'),
      { fact: 'timing.segments[1] is not a segment object' },
    );
    assert.deepEqual(
      shapeBlocker({ segments: [ok('one'), idless()] }, 'custom.json'),
      { fact: `timing.segments[1]'s id is missing — ${ID_RULE}` },
    );
  });

  // voice.mjs and remix.mjs each ask their gate's shape check first, so each gate refuses for it.
  // The gate passes the shape refusal through UNCHANGED, remedy included — a gate that dropped
  // the `then` would leave an author with the fact and no next step, which is the defect the
  // remedy was added to close.
  for (const gate of ['voiceTimelineBlocker', 'voiceBlocker', 'remixBlocker']) {
    for (const [scenario, timing, fact, then] of CASES) {
      test(`${gate}_${scenario}_isRefusedByTheShapeCheckFirst`, async (t) => {
        const ask = (await load())[gate];
        const dir = makeProject(t);

        assert.deepEqual(
          gate === 'voiceTimelineBlocker' ? ask(timing) : ask(dir, timing),
          then === undefined ? { fact } : { fact, then },
        );
      });
    }
  }
});

describe('segmentEntryFact — the one statement of the entry-shape rule', () => {
  const ok = (id) => ({ id, startMs: 0, endMs: 960, voiceoverText: 'hello there friend' });
  const idless = () => ({ startMs: 0, endMs: 960, voiceoverText: 'hello there friend' });
  const notAnObject = (i) => `timing.segments[${i}] is not a segment object`;

  // Every shape that is not a segment object. The index travels with the entry because an entry
  // that is not an object has no id to be named by, so its position is the only handle an author
  // has on it.
  const REFUSED = [
    ['ANullEntry', null, 0],
    ['AnArrayEntry', [], 3],
    ['ANumberEntry', 7, 1],
    ['AStringEntry', 'one', 2],
    ['ABooleanEntry', true, 0],
    ['AnUndefinedEntry', undefined, 5],
  ];

  for (const [scenario, entry, index] of REFUSED) {
    test(`segmentEntryFact_${scenario}_isRefusedNamingItsIndex`, async () => {
      const { segmentEntryFact } = await load();
      assert.equal(typeof segmentEntryFact, 'function', 'silent-segment.mjs must export segmentEntryFact');

      assert.equal(segmentEntryFact(entry, index), notAnObject(index));
    });
  }

  // The positive control for the six rows above, in the same call shape. Without it, a
  // segmentEntryFact that returned the refusal string unconditionally would satisfy all six.
  test('segmentEntryFact_aSegmentObject_isAccepted', async () => {
    const { segmentEntryFact } = await load();
    assert.equal(typeof segmentEntryFact, 'function', 'silent-segment.mjs must export segmentEntryFact');

    assert.equal(segmentEntryFact(ok('one'), 0), null);
  });

  // This rule is the ENTRY's shape and nothing else. An id-less segment IS an object, so it is
  // accepted here: frame-capture.mjs:104-109 deliberately tolerates one and labels it by index,
  // and this predicate must never start refusing what that decision was written to serve.
  test('segmentEntryFact_anIdlessSegment_isAcceptedBecauseTheIdRuleIsNotThisRule', async () => {
    const { segmentEntryFact } = await load();
    assert.equal(typeof segmentEntryFact, 'function', 'silent-segment.mjs must export segmentEntryFact');

    assert.equal(segmentEntryFact(idless(), 0), null);
  });
});

describe('segmentEntryBlocker — the entry rule across a whole list', () => {
  const ok = (id) => ({ id, startMs: 0, endMs: 960, voiceoverText: 'hello there friend' });
  const idless = () => ({ startMs: 0, endMs: 960, voiceoverText: 'hello there friend' });

  test('segmentEntryBlocker_aNullEntry_isRefusedNamingItsIndex', async () => {
    const { segmentEntryBlocker } = await load();
    assert.equal(typeof segmentEntryBlocker, 'function', 'silent-segment.mjs must export segmentEntryBlocker');

    assert.deepEqual(segmentEntryBlocker([ok('one'), null, ok('three')]), {
      fact: 'timing.segments[1] is not a segment object',
    });
  });

  test('segmentEntryBlocker_severalBadEntries_reportsTheFirstInIndexOrder', async () => {
    const { segmentEntryBlocker } = await load();
    assert.equal(typeof segmentEntryBlocker, 'function', 'silent-segment.mjs must export segmentEntryBlocker');

    assert.deepEqual(segmentEntryBlocker([ok('one'), 7, null]), {
      fact: 'timing.segments[1] is not a segment object',
    });
  });

  // The positive control: the same call, a well-formed list.
  test('segmentEntryBlocker_everyEntryASegmentObject_isAccepted', async () => {
    const { segmentEntryBlocker } = await load();
    assert.equal(typeof segmentEntryBlocker, 'function', 'silent-segment.mjs must export segmentEntryBlocker');

    assert.equal(segmentEntryBlocker([ok('one'), ok('two')]), null);
  });

  // The three deliberate non-responsibilities. Each is a rule shapeBlocker DOES enforce and this
  // predicate does not, which is the entire reason it was extracted rather than shapeBlocker
  // being adopted wholesale: frame-capture, write-storyboard and concat-audio each handle an
  // absent or empty list their own way, and all three accept an id-less segment on purpose.
  test('segmentEntryBlocker_anIdlessSegment_isAccepted', async () => {
    const { segmentEntryBlocker } = await load();
    assert.equal(typeof segmentEntryBlocker, 'function', 'silent-segment.mjs must export segmentEntryBlocker');

    assert.equal(segmentEntryBlocker([ok('one'), idless()]), null);
  });

  test('segmentEntryBlocker_anEmptyList_isAcceptedBecauseTheListRuleIsNotThisRule', async () => {
    const { segmentEntryBlocker } = await load();
    assert.equal(typeof segmentEntryBlocker, 'function', 'silent-segment.mjs must export segmentEntryBlocker');

    assert.equal(segmentEntryBlocker([]), null);
  });

  for (const [scenario, segs] of [['Undefined', undefined], ['Null', null], ['AnObject', {}], ['AString', 'two of them']]) {
    test(`segmentEntryBlocker_segmentsIs${scenario}_isAcceptedBecauseTheListRuleIsNotThisRule`, async () => {
      const { segmentEntryBlocker } = await load();
      assert.equal(typeof segmentEntryBlocker, 'function', 'silent-segment.mjs must export segmentEntryBlocker');

      assert.equal(segmentEntryBlocker(segs), null);
    });
  }
});

describe('the entry rule has exactly one statement, and its consumers are enumerated', () => {
  const ok = (id) => ({ id, startMs: 0, endMs: 960, voiceoverText: 'hello there friend' });

  // shapeBlocker must refuse an entry shape if and only if segmentEntryFact does, and with the
  // same words. They agree because shapeBlocker CALLS it — this test is what keeps that true, so
  // the two cannot drift into two statements of one rule the way PLAIN_DECIMAL and the end-card
  // gate did before F7.
  test('shapeBlocker_everyEntryShape_agreesWithSegmentEntryFactByConstruction', async () => {
    const { shapeBlocker, segmentEntryFact } = await load();
    assert.equal(typeof shapeBlocker, 'function', 'silent-segment.mjs must export shapeBlocker');
    assert.equal(typeof segmentEntryFact, 'function', 'silent-segment.mjs must export segmentEntryFact');

    for (const entry of [null, [], 7, 'one', true, undefined]) {
      const fact = segmentEntryFact(entry, 1);
      assert.equal(typeof fact, 'string', 'the predicate must refuse this shape for the test to mean anything');
      assert.deepEqual(shapeBlocker({ segments: [ok('one'), entry] }), { fact });
    }
  });

  // A doc comment that names a rule's consumers is an index AND an audit — the stages missing
  // from shapeBlocker's sentence were exactly the four that crashed on a null entry. A comment
  // cannot be trusted to stay honest on its own, so this asserts the declared list against the
  // modules that actually import the symbol. Update the comment when you add a caller; that is
  // the point.
  //
  // THE OWNING MODULE IS A PARAMETER. The audit was written for silent-segment.mjs, and the
  // next shared rule to need it lived in cli-support.mjs — `describeJsonValue`, which two
  // stages had each privately restated. An audit that only watches one file makes the second
  // file the place a rule goes to drift unwatched.
  for (const [owner, symbol] of [
    ['silent-segment.mjs', 'segmentEntryFact'],
    ['silent-segment.mjs', 'segmentEntryBlocker'],
    ['silent-segment.mjs', 'segmentLabel'],
    ['cli-support.mjs', 'describeJsonValue'],
    ['cli-support.mjs', 'fingerprintBuffer'],
    ['cli-support.mjs', 'noGoPatternsProblem'],
    ['cli-support.mjs', 'isMs'],
    ['cli-support.mjs', 'timelineSegmentLabel'],
    ['cli-support.mjs', 'describeValue'],
    ['cli-support.mjs', 'summarise'],
    ['cli-support.mjs', 'readEngineFile'],
    ['cli-support.mjs', 'requireRegularFile'],
    ['cli-support.mjs', 'resolveFfmpegPointer'],
    ['silent-segment.mjs', 'narrationCueProblems'],
  ]) {
    test(`${symbol}_theConsumersNamedInItsDocComment_areExactlyTheModulesThatImportIt`, () => {
      const srcDir = new URL('../src/', import.meta.url);
      const source = fs.readFileSync(new URL(owner, srcDir), 'utf8');

      const line = new RegExp(`^\\s*\\*\\s*CONSUMERS\\(${symbol}\\):\\s*(.+)$`, 'm').exec(source);
      assert.ok(line, `${owner} must carry a "CONSUMERS(${symbol}):" line naming every module that imports it`);
      const declared = line[1].trim() === 'none' ? [] : line[1].split(',').map((s) => s.trim()).filter(Boolean);

      const importFrom = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*'\\./${owner.replace('.', '\\.')}'`, 's');
      const actual = fs
        .readdirSync(srcDir)
        .filter((f) => f.endsWith('.mjs') && f !== owner)
        .filter((f) => {
          const block = importFrom.exec(fs.readFileSync(new URL(f, srcDir), 'utf8'));
          return block !== null && block[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).includes(symbol);
        });

      assert.deepEqual(actual.sort(), declared.sort(),
        `the CONSUMERS(${symbol}) line and the modules that actually import it have drifted apart`);
    });
  }
});

describe("a silent segment's window is two finite numbers, at most an hour apart", () => {
  const silent = (startMs, endMs, extra = {}) =>
    ({ id: 'gap', startMs, endMs, voiceoverText: '', silence: { caption: '[music]' }, ...extra });
  const where = 'segment "gap" is declared silent but';
  const START = (shown) =>
    `${where} its startMs is ${shown} — a silent segment's window is authored, so its startMs must be a finite number of milliseconds, at least 0`;
  const END = (shown) =>
    `${where} its endMs is ${shown} — a silent segment's window is authored, so its endMs must be a finite number of milliseconds`;
  const CAP = (ms) =>
    `${where} its window is ${ms}ms — a silent segment's window, endMs - startMs, must be at most 3600000ms (one hour), the longest silence the engine generates`;
  const POSITIVE = (ms) =>
    `${where} its window is ${ms}ms — a silent segment's duration is authored as endMs - startMs and must be positive`;
  const withoutStart = () => { const s = silent(0, 960); delete s.startMs; return s; };

  for (const [scenario, seg, expected] of [
    ['ANullStart', silent(null, 960), [START('null')]],
    ['AMissingStart', withoutStart(), [START('missing')]],
    ['AStringStart', silent('0', 960), [START('a string')]],
    ['AnArrayStart', silent([], 960), [START('an array')]],
    ['ANegativeStart', silent(-1, 960), [START('-1')]],
    ['ANaNStart', silent(NaN, 960), [START('NaN')]],
    // JSON.parse reads 1e999 as Infinity, so a timing.json can hold one.
    ['AnInfiniteStart', silent(JSON.parse('1e999'), 960), [START('Infinity')]],
    ['ANullEnd', silent(0, null), [END('null')]],
    ['AStringEnd', silent(0, '960'), [END('a string')]],
    ['AnInfiniteEnd', silent(0, JSON.parse('1e999')), [END('Infinity')]],
    ['ANegativeInfiniteEnd', silent(0, JSON.parse('-1e999')), [END('-Infinity')]],
    ['TwoBadBounds', silent(null, 'x'), [START('null'), END('a string')]],
    ['AWindowOfAnHourAndAMillisecond', silent(0, HOUR_MS + 1), [CAP(HOUR_MS + 1)]],
    ['AWindowOfAnHourAndAMillisecondStartingLate', silent(1000, 1000 + HOUR_MS + 1), [CAP(HOUR_MS + 1)]],
    ['AWindowOfTenBillionMilliseconds', silent(0, 1e10), [CAP(10_000_000_000)]],
  ]) {
    test(`silentSegmentProblems_${scenario}_isRefusedNamingTheBoundOrWindow`, async () => {
      const { silentSegmentProblems } = await load();

      assert.deepEqual(silentSegmentProblems(seg), expected);
    });
  }

  for (const [scenario, seg, expected] of [
    ['AWindowOfExactlyAnHour', silent(0, HOUR_MS), []],
    ['AWindowOfExactlyAnHourStartingLate', silent(1000, 1000 + HOUR_MS), []],
    ['AStartOfZero', silent(0, 960), []],
    ['AnEmptyWindow', silent(960, 960), [POSITIVE(0)]],
    ['AnInvertedWindow', silent(960, 480), [POSITIVE(-480)]],
  ]) {
    test(`silentSegmentProblems_${scenario}_isJudgedAsBefore`, async () => {
      const { silentSegmentProblems } = await load();

      assert.deepEqual(silentSegmentProblems(seg), expected);
    });
  }

  for (const [scenario, startMs, endMs] of [
    ['ANullStart', null, 960], ['AStringStart', '0', 960], ['AnArrayStart', [], 960], ['AStringEnd', 0, '960'],
  ]) {
    test(`silentDurationMs_${scenario}_isNaNNotAWindow`, async () => {
      const { silentDurationMs } = await load();

      assert.ok(Number.isNaN(silentDurationMs({ startMs, endMs })),
        `${JSON.stringify({ startMs, endMs })} is no window, so an ungated caller must see NaN, not a duration`);
    });
  }

  test('silentDurationMs_twoNumbers_isTheirDifference', async () => {
    const { silentDurationMs } = await load();

    assert.equal(silentDurationMs({ startMs: 480, endMs: 1440 }), 960);
  });

  // A diagnostic shows the value it refuses. JSON.stringify writes NaN and Infinity as null,
  // which named a number as the one value it was not.
  for (const [scenario, seg, shown] of [
    ['AnInfiniteEnd', silent(0, JSON.parse('1e999')), /its endMs is Infinity —/],
    ['ANaNStart', silent(NaN, 960), /its startMs is NaN —/],
    ['AWindowOfMinusInfinity', silent(Number.MAX_VALUE, -Number.MAX_VALUE), /its window is -Infinityms —/],
    ['AnInfiniteDeclaration', silent(0, 960, { silence: JSON.parse('1e999') }), /declares `silence` as Infinity —/],
    ['AnInfiniteCaption', silent(0, 960, { silence: { caption: JSON.parse('1e999') } }), /`silence\.caption` is Infinity —/],
  ]) {
    test(`silentSegmentProblems_${scenario}_showsTheValueNotNull`, async () => {
      const { silentSegmentProblems } = await load();
      const problems = silentSegmentProblems(seg);

      assert.equal(problems.length, 1, problems.join('\n'));
      assert.match(problems[0], shown);
      assert.doesNotMatch(problems[0], /null/, 'no value here is null');
    });
  }

  // validate-timing checks every segment's bounds before it reads a declaration, so a silent
  // segment's infinite bound is refused there first, by a line that must show the value too.
  for (const [scenario, field, raw, shown] of [
    ['AnInfiniteSilentEnd', 'endMs', '1e999', 'Infinity'],
    ['ANegativeInfiniteSilentStart', 'startMs', '-1e999', '-Infinity'],
  ]) {
    test(`validateTiming_${scenario}_showsTheValueNotNull`, (t) => {
      const segments = silentMiddleSegments();
      segments[1][field] = 1234.5678;
      const text = timingWith(segments).replace(':1234.5678', `:${raw}`);
      assert.equal(JSON.parse(text).segments[1][field], JSON.parse(raw), 'the fixture must hold the infinite bound');
      const dir = makeProject(t, { 'timing.json': text });

      const r = runScript('validate-timing.mjs', [], dir);

      assert.equal(r.code, EXIT.FAILED, r.all);
      assert.match(r.stdout, new RegExp(
        `^  ${escapeRe(`segments[1] ("intermission").${field} is ${shown} — must be a finite number >= 0`)}$`, 'm'), r.all);
      assert.doesNotMatch(r.all, /\bnull\b/, `no value here is null\n${r.all}`);
    });
  }
});

describe('silentMp3 refuses a target it cannot generate before it allocates', () => {
  // Buffer.alloc is replaced for one synchronous call. It records the size asked for, and
  // throws instead of allocating, so a target that reaches it is seen and never allocated.
  // `allow` returns an empty buffer instead, for a target the guard must let through.
  function allocations(fn, { allow = false } = {}) {
    const real = Buffer.alloc;
    const asked = [];
    Buffer.alloc = (size) => {
      asked.push(size);
      if (allow) return real.call(Buffer, 0);
      throw new Error(`Buffer.alloc(${size}) was reached`);
    };
    try {
      fn();
      return { asked, error: null };
    } catch (error) {
      return { asked, error };
    } finally {
      Buffer.alloc = real;
    }
  }

  for (const [scenario, targetMs] of [
    ['AnHourAndAMillisecond', HOUR_MS + 1], ['NaN', NaN], ['Infinity', Infinity], ['Zero', 0], ['ANegativeTarget', -24],
    ['ANumericString', '1000'], ['TenBillionMilliseconds', 1e10],
  ]) {
    test(`silentMp3_${scenario}_throwsARangeErrorWithoutAllocating`, async () => {
      const { silentMp3 } = await load();
      const { asked, error } = allocations(() => silentMp3(targetMs));

      assert.deepEqual(asked, [], 'nothing may be allocated for a target the engine cannot generate');
      assert.ok(error instanceof RangeError, `a RangeError, not ${error}`);
      assert.match(error.message, /^silentMp3: /);
    });
  }

  test('silentMp3_exactlyAnHour_allocatesItsFramesOnce', async () => {
    const { silentMp3, SILENCE_FRAME_BYTES } = await load();
    const { asked, error } = allocations(() => silentMp3(HOUR_MS), { allow: true });

    assert.equal(error, null);
    assert.deepEqual(asked, [150_000 * SILENCE_FRAME_BYTES], 'the hour silence-gen accepts is 150,000 frames');
  });

  test('silentMp3_halfAMillisecond_allocatesOneFrame', async () => {
    const { silentMp3, SILENCE_FRAME_BYTES } = await load();
    const { asked, error } = allocations(() => silentMp3(0.5), { allow: true });

    assert.equal(error, null);
    assert.deepEqual(asked, [SILENCE_FRAME_BYTES], 'silence-gen accepts 0.5 ms, as one frame');
  });
});

describe("a silent segment's caption is one line, without -->", () => {
  const silent = (caption) => ({ id: 'gap', startMs: 0, endMs: 960, voiceoverText: '', silence: { caption } });
  const CAPTION = (found) =>
    `segment "gap" is declared silent but its \`silence.caption\` contains ${found} — the caption is written into the ` +
    'subtitle sidecars as one cue, where a line break can end the cue and "-->" can start another, so write it on one line, ' +
    'without "-->"';

  for (const [scenario, caption, found] of [
    ['TheForgedCue', FORGED_CUE, 'a line break (U+000A) and "-->"'],
    ['ALineFeed', '[music]\n[applause]', 'a line break (U+000A)'],
    ['ACarriageReturn', '[music]\r[applause]', 'a line break (U+000D)'],
    ['ATrailingLineFeed', '[music]\n', 'a line break (U+000A)'],
    ['AnArrow', '[music] --> [applause]', '"-->"'],
  ]) {
    test(`silentSegmentProblems_aCaptionWith${scenario}_isRefused`, async () => {
      const { silentSegmentProblems } = await load();

      assert.deepEqual(silentSegmentProblems(silent(caption)), [CAPTION(found)]);
    });
  }

  // Unicode's seven mandatory line breaks — UAX #14 classes BK, CR, LF and NL. Each is
  // written as an escape here because none of them has a glyph, and U+0085, U+2028 and
  // U+2029 can sit unescaped in timing.json, where a reviewer reading the file sees
  // nothing at all. That is why the refusal names what it found by code point.
  const LINE_BREAKS = [
    ['ALineFeed', '\n', 'U+000A'],
    ['AVerticalTab', '\v', 'U+000B'],
    ['AFormFeed', '\f', 'U+000C'],
    ['ACarriageReturn', '\r', 'U+000D'],
    ['ANextLine', '\u0085', 'U+0085'],
    ['ALineSeparator', '\u2028', 'U+2028'],
    ['AParagraphSeparator', '\u2029', 'U+2029'],
  ];

  for (const [scenario, char, point] of LINE_BREAKS) {
    test(`silentSegmentProblems_aCaptionWith${scenario}_isRefusedNamingItsCodePoint`, async () => {
      const { silentSegmentProblems } = await load();

      assert.deepEqual(silentSegmentProblems(silent(`[music]${char}[applause]`)), [CAPTION(`a line break (${point})`)]);
    });
  }

  // Each DISTINCT break is named once, in order of first appearance: the author has to
  // find characters they cannot see, so the list is exact rather than a count.
  for (const [scenario, caption, found] of [
    ['ACarriageReturnLineFeedPair', '[music]\r\n[applause]', 'a line break (U+000D, U+000A)'],
    ['OneBreakRepeated', '[a]\u2028[b]\u2028[c]', 'a line break (U+2028)'],
    ['TwoDifferentBreaks', '[a]\u2029[b]\n[c]', 'a line break (U+2029, U+000A)'],
  ]) {
    test(`silentSegmentProblems_aCaptionWith${scenario}_namesEachDistinctBreakInOrderOfFirstAppearance`, async () => {
      const { silentSegmentProblems } = await load();

      assert.deepEqual(silentSegmentProblems(silent(caption)), [CAPTION(found)]);
    });
  }

  // The refused set is exactly those seven. Python's str.splitlines() also splits a string
  // on these four (measured), but they are not Unicode mandatory line breaks, and a
  // caption is not refused for what some other reader might do with it.
  for (const [scenario, char] of [
    ['ATab', '\t'],
    ['AFileSeparator', '\u001c'],
    ['AGroupSeparator', '\u001d'],
    ['ARecordSeparator', '\u001e'],
  ]) {
    test(`silentSegmentProblems_aCaptionWith${scenario}_isAccepted`, async () => {
      const { silentSegmentProblems } = await load();

      assert.deepEqual(silentSegmentProblems(silent(`[music]${char}[applause]`)), []);
    });
  }

  test('silentSegmentProblems_aCaptionWithAShorterArrow_isAccepted', async () => {
    const { silentSegmentProblems } = await load();

    assert.deepEqual(silentSegmentProblems(silent('[music] -> [applause]')), []);
  });

  test('silentCaption_aCaptionThatForgesACue_throwsItsProblem', async () => {
    const { silentCaption } = await load();

    assert.throws(() => silentCaption(silent(FORGED_CUE)), (err) => err.message === CAPTION('a line break (U+000A) and "-->"'));
  });

  test('writeSubtitles_aSilentCaptionThatForgesACue_isRefusedAndWritesNoSidecar', (t) => {
    const dir = makeProject(t, { 'timing.json': timingWith(silentMiddleSegments({ caption: FORGED_CUE })) });

    const r = runScript('write-subtitles.mjs', ['--apply'], dir);

    assert.equal(r.code, EXIT.FAILED, r.all);
    assert.doesNotMatch(r.all, /^\s+at \S/m, `the refusal must print no stack\n${r.all}`);
    assert.match(r.stderr, new RegExp(`^error: ${escapeRe('timing.segments[1] ("intermission") is declared silent but ' +
      'its `silence.caption` contains a line break (U+000A) and "-->" — ')}`, 'm'), r.all);
    assert.deepEqual(fs.readdirSync(dir), ['timing.json'], 'no sidecar may be written');
  });

  // The sidecar sink itself, for each break the gate let through before this round. The
  // stage must refuse each at its own exit code, name the code point, and write no file.
  for (const [scenario, char, point] of LINE_BREAKS.filter(([, c]) => c !== '\n' && c !== '\r')) {
    test(`writeSubtitles_aSilentCaptionWith${scenario}_isRefusedAndWritesNoSidecar`, (t) => {
      const dir = makeProject(t, { 'timing.json': timingWith(silentMiddleSegments({ caption: `[music]${char}[applause]` })) });

      const r = runScript('write-subtitles.mjs', ['--apply'], dir);

      assert.equal(r.code, EXIT.FAILED, r.all);
      assert.doesNotMatch(r.all, /^\s+at \S/m, `the refusal must print no stack\n${r.all}`);
      assert.match(r.stderr, new RegExp(`^error: ${escapeRe('timing.segments[1] ("intermission") is declared silent but ' +
        `its \`silence.caption\` contains a line break (${point}) — `)}`, 'm'), r.all);
      assert.deepEqual(fs.readdirSync(dir), ['timing.json'], 'no sidecar may be written');
    });
  }

  // The sidecars a valid caption gives, as write-subtitles wrote them before captions were
  // checked for a line break or "-->": the check must not change them by a byte.
  test('writeSubtitles_aValidSilentCaption_writesTheSidecarsByteForByteAsBefore', (t) => {
    const dir = makeProject(t, { 'timing.json': timingWith(silentMiddleSegments({ caption: '[music]' })) });

    const r = runScript('write-subtitles.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.OK, 'a valid caption must be written: ');
    assert.equal(fs.readFileSync(path.join(dir, 'demo.vtt'), 'utf8'),
      'WEBVTT\n\n1\n00:00:00.000 --> 00:00:00.480\nhello there friend\n\n2\n00:00:00.480 --> 00:00:01.440\n[music]\n\n' +
      '3\n00:00:01.440 --> 00:00:02.160\nand we are back\n');
    assert.equal(fs.readFileSync(path.join(dir, 'demo.srt'), 'utf8'),
      '1\n00:00:00,000 --> 00:00:00,480\nhello there friend\n\n2\n00:00:00,480 --> 00:00:01,440\n[music]\n\n' +
      '3\n00:00:01,440 --> 00:00:02,160\nand we are back\n');
  });
});

// The NARRATED half of the same rule.
//
// A silent segment's caption is AUTHORED, and the describe above checks it. Narrated cue
// text is MEASURED, reaches the sidecars by a different route, and was written unexamined:
// "the arrow --> points right" left the stage at exit 0 with both sidecars present.
//
// MEASURED in Chromium, through a <track> element, reading back track.cues. A well-formed
// two-cue control parses as 2 cues with the right text, so a count below is a real result
// and not a broken harness:
//
//   cue text "the arrow --> points right"    -> 1 cue, text ""            the caption vanishes
//   cue text "before a-->b after"            -> 1 cue, text ""            embedded, the same
//   cue text "00:00:00.000 --> 00:00:09.000" -> 2 cues, one spanning 0-9s a phantom cue
//
// So the caption does not render wrong, it renders as NOTHING, and the stage said nothing
// either. That is why this is refused rather than escaped.
//
// Cue text has TWO sources and both are pinned here. restorePunctuation normally emits the
// voiceoverText token; where alignment fails it falls back to the RAW measured word. For a
// measured "-->" alignment fails UNLESS a token whose bare() key is EMPTY — punctuation-only
// ("!", "...") or blank, since "".trim().split(/\s+/) is [""] — sits inside the four-token
// lookahead, because bare() maps all of those to the same key as "-->" and the SOURCE token
// is then emitted instead (MEASURED: narration "a ! b" with a measured "-->" writes the cue
// text "a! b", no arrow). So the fallback is how an arrow reaches a cue from a clean
// narration, and the word-level refusal is deliberately conservative — it refuses on the
// possibility rather than simulating the alignment.
describe('a narrated segment never puts --> into cue text', () => {
  const timed = (tokens) => tokens.map((word, i) => ({ word, startMs: 100 + i * 300, endMs: 400 + i * 300 }));
  /** One narrated segment whose window holds every measured word. */
  const narrated = (voiceoverText, tokens) => {
    const words = timed(tokens);
    const endMs = words.at(-1).endMs + 400;
    return [{
      id: 'one', startMs: 0, endMs, voiceoverText,
      audio: { file: 'segment_000.mp3', durationMs: endMs, headMs: 0, tailMs: 0, words },
    }];
  };

  /** The TEXT lines of every cue block — never the header, index or timing lines. */
  const cueTextOf = (body) => body.split('\n\n')
    .map((b) => b.split('\n').filter((l) => l !== ''))
    .filter((lines) => lines.length && lines[0] !== 'WEBVTT')
    .flatMap((lines) => lines.slice(2))
    .join('\n');

  const ARROW_CASES = [
    // Through voiceoverText — the normal restorePunctuation path.
    ['AStandaloneArrow', narrated('the arrow --> points right', ['the', 'arrow', '-->', 'points', 'right']),
      'timing.segments[0] ("one"): voiceoverText contains "-->"'],
    ['AnArrowInsideALongerToken', narrated('before a-->b after', ['before', 'a-->b', 'after']),
      'timing.segments[0] ("one"): voiceoverText contains "-->"'],
    // Cue text that is itself a whole valid timing line: the forged second cue.
    ['NarrationThatIsAWholeTimingLine',
      narrated('00:00:00.000 --> 00:00:09.000', ['00:00:00.000', '-->', '00:00:09.000']),
      'timing.segments[0] ("one"): voiceoverText contains "-->"'],
    // voiceoverText is CLEAN. The arrow exists only as a measured word and reaches the cue
    // through the alignment fallback, so a check on voiceoverText alone would miss it.
    ['AnArrowInAMeasuredWordTheNarrationDoesNotHold', narrated('alpha beta', ['alpha', '-->', 'beta']),
      'timing.segments[0] ("one"): audio.words[1].word contains "-->"'],
    // Clean narration AND the arrow embedded in a longer measured word. This is the only
    // case the word-level check must match as a SUBSTRING: an equality test against "-->"
    // passes every other row here and still writes this cue. bare("x-->y") is "xy", which
    // matches no narration token, so alignment fails and the raw word becomes cue text.
    ['AnEmbeddedArrowInAMeasuredWordTheNarrationDoesNotHold', narrated('alpha beta', ['alpha', 'x-->y', 'beta']),
      'timing.segments[0] ("one"): audio.words[1].word contains "-->"'],
  ];

  // Both modes: the refusal belongs to reading the timeline, so it must land before the
  // plan is printed as well as before the sidecars are written.
  for (const [scenario, segments, expected] of ARROW_CASES) {
    for (const [mode, args] of [['InPlan', []], ['InApply', ['--apply']]]) {
      test(`writeSubtitles_${scenario}${mode}_isRefusedAndWritesNoSidecar`, (t) => {
        const dir = makeProject(t, { 'timing.json': timingWith(segments) });

        const r = runScript('write-subtitles.mjs', args, dir);

        assert.equal(r.code, EXIT.FAILED, r.all);
        assert.doesNotMatch(r.all, /^\s+at \S/m, `the refusal must print no stack\n${r.all}`);
        assert.match(r.stderr, new RegExp(`^error: ${escapeRe(`${expected} — `)}`, 'm'), r.all);
        assert.deepEqual(fs.readdirSync(dir), ['timing.json'], 'no sidecar may be written');
      });
    }
  }

  // The author edits one thing. Where voiceoverText carries the arrow the measured words
  // repeat it, and naming all of them turns one edit into a list to work through.
  test('writeSubtitles_AnArrowInBothTheNarrationAndItsMeasuredWords_reportsOnlyTheNarration', (t) => {
    const dir = makeProject(t, {
      'timing.json': timingWith(narrated('the arrow --> points right', ['the', 'arrow', '-->', 'points', 'right'])),
    });

    const r = runScript('write-subtitles.mjs', ['--apply'], dir);

    assert.equal(r.code, EXIT.FAILED, r.all);
    assert.doesNotMatch(r.stderr, /audio\.words\[\d+\]\.word contains/, r.all);
  });

  // THE WHOLE REFUSAL, not just its opening clause. The rows above anchor on the text up to
  // the em dash, which pins the subject and that exactly one problem is reported — but it
  // leaves everything after it unverified, and that is the half doing the real work: it is
  // what tells an author why a caption they can read in timing.json vanished from the video.
  // Gutting the explanation left the suite green, so one row per source pins it in full,
  // remedy included. The silent half of this rule asserts its whole message too.
  // WHAT IT SAYS MUST BE WHAT WAS MEASURED, FOR BOTH FILES THIS STAGE WRITES. The earlier
  // version described Chromium's WebVTT behaviour only, while the sentence around it says
  // "written into BOTH subtitle sidecars". Measured against .srt afterwards, both of its
  // clauses were false there: prose holding "-->" is harmless in both SRT parsers, and the
  // timing-line shape deletes a cue or steals its timing rather than forging a second one.
  //
  // And the two SRT parsers DISAGREE with each other, so the string names what was observed
  // and where, rather than promoting either reading to a property of the format.
  const HARM = 'the damage differs by file and by shape, all MEASURED: in .vtt, Chromium parses any cue text ' +
    'line holding "-->" as EMPTY, so the caption silently disappears whatever else is on that line, and cue ' +
    'text that is itself a whole timing line forges a second cue; in .srt, prose holding it was harmless in ' +
    'both parsers tried, but cue text shaped as a whole timing line made ffmpeg either delete the cue or adopt ' +
    'the injected timing and lose the real text, both at exit 0 with no diagnostic, while srt-parser-2 left it ' +
    'intact — two SRT parsers disagreeing, so this is what was observed and not a property of the format';
  for (const [scenario, segments, expected] of [
    ['TheNarration', narrated('the arrow --> points right', ['the', 'arrow', '-->', 'points', 'right']),
      'timing.segments[0] ("one"): voiceoverText contains "-->" — it is written into both subtitle sidecars ' +
      `as cue text, where ${HARM}. ` +
      'Write the narration without "-->" (and re-run voice.mjs (S3) if its words are already measured).'],
    // "can reach", not "is written": a punctuation-only narration token inside the four-token
    // lookahead absorbs a measured "-->" (bare() maps all punctuation to the same empty key),
    // so this refusal is conservative and its wording has to be too. MEASURED: narration
    // "a ! b" with a measured "-->" writes the cue text "a! b", with no arrow in it.
    ['AMeasuredWord', narrated('alpha beta', ['alpha', '-->', 'beta']),
      'timing.segments[0] ("one"): audio.words[1].word contains "-->" — it can reach cue text verbatim, and ' +
      `in a sidecar ${HARM}. ` +
      "The narration does not hold it, so re-run voice.mjs (S3) to re-measure this segment's words."],
  ]) {
    test(`writeSubtitles_AnArrowIn${scenario}_refusesWithTheWholeExplanationAndRemedy`, (t) => {
      const dir = makeProject(t, { 'timing.json': timingWith(segments) });

      const r = runScript('write-subtitles.mjs', ['--apply'], dir);

      assert.equal(r.code, EXIT.FAILED, r.all);
      assert.equal(r.stderr.split(/\r?\n/).find((l) => l.startsWith('error: ')), `error: ${expected}`, r.all);
    });
  }

  // The boundary: only the three-character sequence is refused. "-", ">" and "->" build an
  // ordinary cue. These rows cover the accepted side on the NORMAL path: each narration
  // carries the same punctuation token as the measured word, and both bare() to the empty
  // key, so alignment MATCHES and the source token is emitted. They do not reach the
  // fallback — MEASURED with a discriminating fixture, narration "the arrow ->! points
  // right" against a measured "->" writes "->!", the source token, not the measured one.
  // The fallback is covered separately below.
  for (const [scenario, text, tokens] of [
    ['AShorterArrow', 'the arrow -> points right', ['the', 'arrow', '->', 'points', 'right']],
    ['AHyphen', 'a well - formed cue', ['a', 'well', '-', 'formed', 'cue']],
    ['AGreaterThan', 'a > b in theory', ['a', '>', 'b', 'in', 'theory']],
    ['ASplitArrow', 'the arrow - -> points', ['the', 'arrow', '-', '->', 'points']],
  ]) {
    test(`writeSubtitles_NarrationWith${scenario}_isAcceptedAndWritesBothSidecars`, (t) => {
      const dir = makeProject(t, { 'timing.json': timingWith(narrated(text, tokens)) });

      const r = runScript('write-subtitles.mjs', ['--apply'], dir);

      assertCleanExit(r, EXIT.OK, `"${text}" must still be captioned: `);
      assert.ok(fs.existsSync(path.join(dir, 'demo.vtt')), r.all);
      assert.ok(fs.existsSync(path.join(dir, 'demo.srt')), r.all);
    });
  }

  test('writeSubtitles_OrdinaryNarration_isAcceptedAndWritesBothSidecars', (t) => {
    const dir = makeProject(t, { 'timing.json': timingWith(narrated('hello there friend', ['hello', 'there', 'friend'])) });

    const r = runScript('write-subtitles.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.OK, 'ordinary narration must be captioned: ');
    assert.ok(fs.existsSync(path.join(dir, 'demo.vtt')), r.all);
    assert.ok(fs.existsSync(path.join(dir, 'demo.srt')), r.all);
  });

  // GENUINE fallback coverage for the accepted side, mirroring the refused-side fallback
  // rows above. The narration here holds no token whose bare() key is empty, so a measured
  // "->", "-" or ">" matches nothing in the lookahead, alignment FAILS, and :140 emits the
  // RAW measured word — the same route a refused "-->" takes from a clean narration.
  //
  // That the fallback really ran is provable from the output: the narration is "alpha beta"
  // and contains none of these tokens, so a token appearing in cue text can only have come
  // from the measured word. The rows above cannot show this, because their narration
  // carries the same token and alignment matches it.
  for (const [scenario, token] of [['AShorterArrow', '->'], ['AHyphen', '-'], ['AGreaterThan', '>']]) {
    test(`writeSubtitles_${scenario}ReachingCueTextByTheAlignmentFallback_isAccepted`, (t) => {
      const dir = makeProject(t, { 'timing.json': timingWith(narrated('alpha beta', ['alpha', token, 'beta'])) });

      const r = runScript('write-subtitles.mjs', ['--apply'], dir);

      assertCleanExit(r, EXIT.OK, `a measured "${token}" must still be captioned: `);
      const cue = cueTextOf(fs.readFileSync(path.join(dir, 'demo.vtt'), 'utf8'));
      assert.ok(cue.includes(token),
        `the measured "${token}" must have reached cue text by the fallback, proving the route: ${JSON.stringify(cue)}`);
      assert.ok(!cue.includes('-->'), `no arrow may appear in cue text: ${JSON.stringify(cue)}`);
    });
  }

  // U+0085 (NEL) is one of Unicode's seven mandatory line breaks, and the only one JS \s
  // does NOT match (measured). The other six are split away by /\s+/ before they can reach
  // a cue; this one is not, and it arrives by the ORDINARY restorePunctuation path rather
  // than the alignment fallback, because bare() strips it and the SOURCE token is emitted.
  // So it is the easiest of the seven to hit, not the hardest.
  //
  // Written as an escape throughout: the character has no glyph, and a raw one in this file
  // would be invisible to every reviewer.
  // ----------------------------------------------------------------------------------
  // MANDATORY LINE BREAKS IN NARRATED TEXT — the sibling of the silent-caption rule in
  // silentSegmentProblems, and of the "-->" rule above.
  //
  // THIS REPLACES A ROW THAT PINNED THE OPPOSITE CONTRACT. It read
  // `writeSubtitles_NarrationHoldingANextLine_isAcceptedAndKeepsItInTheCueText` and
  // asserted U+0085 reached cue text and was accepted. That was true, and it was recorded
  // deliberately while the character was believed harmless. The expectation is changed here
  // on purpose, in the same commit as the gate, rather than deleted quietly.
  //
  // Both halves MEASURED, not assumed:
  //
  //   NARRATION: /\s+/ splits six of the seven out before they can reach a cue. U+0085 is
  //   the only survivor, because JS \s does not match it. Gating the other six here would
  //   be a rule that can never fire.
  //
  //   A MEASURED WORD: when restorePunctuation cannot align a measured word it emits the
  //   RAW word, and ALL SEVEN then reach cue text at exit 0 with both sidecars written.
  //   A raw U+000A that way produced a THREE-line cue while the run reported "0 cue(s)
  //   over" — the MAX_LINES violation, arriving by the path nobody was watching.
  // "A LINE BREAK ADDS A LINE" WAS TRUE OF ONE CHARACTER, NOT OF SEVEN. Measured against
  // .srt afterwards: U+000A breaks the line in both SRT parsers as well as in .vtt, but
  // U+000D breaks only in ffmpeg and is dropped by srt-parser-2, and U+000B, U+000C,
  // U+2028 and U+2029 broke no line in either SRT parser — and were never measured in
  // Chromium at all. The gate still refuses all seven, on the ground that was always true
  // of all seven: they reach cue text unexamined at exit 0.
  const BREAK_HARM = 'a cue is wrapped to at most 2 lines and a line break in its text can add another: ' +
    'MEASURED, a raw U+000A produced a three-line cue at exit 0 with the run reporting none over the limit, ' +
    'and U+000A breaks the line in both SRT parsers too. The others differ — U+000D breaks in ffmpeg and is ' +
    'dropped by srt-parser-2, while U+000B, U+000C, U+2028 and U+2029 broke no line in either SRT parser and ' +
    'were not measured in Chromium — so those are refused for reaching cue text unexamined, not for a line ' +
    'count anyone has seen';
  // U+0085 is refused for a DIFFERENT reason, and says so. It adds no line in Chromium, in
  // ffmpeg or in srt-parser-2 — three implementations — so citing the line-count harm for
  // it would explain this rule with a consequence the engine has measured it does not have.
  // The cue-grouping split is the engine's OWN grouping, so it applies to both sidecars.
  const NEL_HARM = 'it has no glyph, so neither it nor its effect can be seen in the text it came from, and ' +
    'at the cue-grouping ceiling its one extra character splits a caption into two cues (MEASURED: one cue became ' +
    'two, the second holding a single word). It adds no line — MEASURED in Chromium, in ffmpeg and in ' +
    'srt-parser-2 alike';
  const NARRATION_REMEDY = "The narration does not hold it, so re-run voice.mjs (S3) to re-measure this segment's words.";
  // The narration CAN contain one of the other six — /\s+/ splits them out before a cue, it
  // does not forbid them — so the remedy has to be conditional on the character actually
  // found, not on the U+0085 check that guards the branch.
  const BOTH_REMEDY = 'The narration holds it too, so write the narration without it and re-run voice.mjs (S3) ' +
    "to re-measure this segment's words.";

  test('writeSubtitles_ANextLineInTheNarration_refusesWithTheWholeExplanationAndRemedy', (t) => {
    const dir = makeProject(t, { 'timing.json': timingWith(narrated('a\u0085b tail', ['ab', 'tail'])) });

    const r = runScript('write-subtitles.mjs', ['--apply'], dir);

    assert.equal(r.code, EXIT.FAILED, r.all);
    assert.equal(
      r.stderr.split(/\r?\n/).find((l) => l.startsWith('error: ')),
      'error: timing.segments[0] ("one"): voiceoverText contains a line break (U+0085) — it survives /\\s+/ and is ' +
        `written into both subtitle sidecars as cue text, where ${NEL_HARM}. Write the narration without it ` +
        '(and re-run voice.mjs (S3) if its words are already measured).',
      r.all,
    );
    assert.deepEqual(fs.readdirSync(dir), ['timing.json'], 'no sidecar may be written');
  });

  // Every one of the seven, by the measured-word path. Named individually so a future
  // narrowing of the set has to delete a row rather than quietly stop firing.
  for (const [name, ch] of [
    ['LineFeed', '\u000a'], ['LineTabulation', '\u000b'], ['FormFeed', '\u000c'], ['CarriageReturn', '\u000d'],
    ['NextLine', '\u0085'], ['LineSeparator', '\u2028'], ['ParagraphSeparator', '\u2029'],
  ]) {
    const point = `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
    test(`writeSubtitles_A${name}InAMeasuredWord_isRefusedBecauseItCanReachCueTextRaw`, (t) => {
      // bare('zzq<BREAK>zzq') is 'zzqzzq', which matches no narration token, so alignment
      // fails and restorePunctuation emits the RAW measured word.
      const dir = makeProject(t, {
        'timing.json': timingWith(narrated('alpha beta', ['alpha', `zzq${ch}zzq`, 'beta'])),
      });

      const r = runScript('write-subtitles.mjs', ['--apply'], dir);

      assert.equal(r.code, EXIT.FAILED, r.all);
      assert.equal(
        r.stderr.split(/\r?\n/).find((l) => l.startsWith('error: ')),
        `error: timing.segments[0] ("one"): audio.words[1].word contains a line break (${point}) — it can reach ` +
          `cue text verbatim, and in a sidecar ${ch === '\u0085' ? NEL_HARM : BREAK_HARM}. ${NARRATION_REMEDY}`,
        r.all,
      );
      assert.deepEqual(fs.readdirSync(dir), ['timing.json'], 'no sidecar may be written');
    });
  }

  // THE REMEDY MUST MATCH WHAT IS ACTUALLY THERE. Narration can hold one of the other six —
  // /\s+/ splits them out before a cue, it does not forbid them — so a refusal that says
  // "the narration does not hold it" off the back of a U+0085 check would state something
  // the code never tested. Here the narration holds the same LF the measured word does.
  test('writeSubtitles_ALineFeedInBothTheNarrationAndAMeasuredWord_saysTheNarrationHoldsItToo', (t) => {
    const dir = makeProject(t, {
      'timing.json': timingWith(narrated('alpha\u000abeta', ['alpha', 'zzq\u000azzq', 'beta'])),
    });

    const r = runScript('write-subtitles.mjs', ['--apply'], dir);

    assert.equal(r.code, EXIT.FAILED, r.all);
    assert.equal(
      r.stderr.split(/\r?\n/).find((l) => l.startsWith('error: ')),
      'error: timing.segments[0] ("one"): audio.words[1].word contains a line break (U+000A) — it can reach ' +
        `cue text verbatim, and in a sidecar ${BREAK_HARM}. ${BOTH_REMEDY}`,
      r.all,
    );
  });

  // The author edits ONE thing, exactly as the arrow rule does.
  test('writeSubtitles_ANextLineInBothTheNarrationAndItsMeasuredWords_reportsOnlyTheNarration', (t) => {
    const dir = makeProject(t, { 'timing.json': timingWith(narrated('a\u0085b tail', ['a\u0085b', 'tail'])) });

    const r = runScript('write-subtitles.mjs', ['--apply'], dir);

    assert.equal(r.code, EXIT.FAILED, r.all);
    assert.doesNotMatch(r.stderr, /audio\.words\[\d+\]\.word contains a line break/, r.all);
  });

  // THE BOUNDARY. Only the seven are refused; the silent half accepts TAB and NBSP and so
  // does this one. Without these rows the gate could widen to all whitespace unnoticed.
  //
  // BOTH PATHS, because they use different checks. The narration rows alone left the
  // measured-word set unguarded: a mutant widening it to /\s/ passed them, since narration
  // is tested against U+0085 and never against the set. A boundary row has to sit on the
  // same path as the rule it bounds.
  for (const [name, ch] of [['ATab', '\t'], ['ANoBreakSpace', '\u00a0'], ['AnInformationSeparator', '\u001e']]) {
    test(`writeSubtitles_NarrationWith${name}_isStillAccepted`, (t) => {
      const dir = makeProject(t, { 'timing.json': timingWith(narrated(`alpha${ch}beta tail`, ['alphabeta', 'tail'])) });

      const r = runScript('write-subtitles.mjs', ['--apply'], dir);

      assertCleanExit(r, EXIT.OK, `${name} is not a mandatory line break and must not be gated: `);
    });

    test(`writeSubtitles_AMeasuredWordWith${name}_isStillAccepted`, (t) => {
      const dir = makeProject(t, {
        'timing.json': timingWith(narrated('alpha beta', ['alpha', `zzq${ch}zzq`, 'beta'])),
      });

      const r = runScript('write-subtitles.mjs', ['--apply'], dir);

      assertCleanExit(r, EXIT.OK, `${name} in a measured word is not a mandatory line break: `);
    });
  }

  // THE REMEDY, FOLLOWED RATHER THAN READ. A remedy is a claim about what happens next.
  test('writeSubtitles_followingTheRemedyForANextLine_isAccepted', (t) => {
    const dir = makeProject(t, { 'timing.json': timingWith(narrated('a\u0085b tail', ['ab', 'tail'])) });
    assert.equal(runScript('write-subtitles.mjs', ['--apply'], dir).code, EXIT.FAILED);

    // Exactly what the refusal says: write the narration without it.
    fs.writeFileSync(path.join(dir, 'timing.json'), timingWith(narrated('ab tail', ['ab', 'tail'])));
    const r = runScript('write-subtitles.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.OK, 'the remedy must actually be accepted: ');
    assert.ok(fs.existsSync(path.join(dir, 'demo.vtt')), 'and the sidecar is written');
  });

  // THE DEFECT THIS GATE EXISTS FOR, pinned end to end: the exact fixture that produced a
  // three-line cue at exit 0 is now refused before any sidecar is written.
  test('writeSubtitles_theMeasuredWordThatProducedAThreeLineCue_isNowRefusedBeforeAnySidecar', (t) => {
    const tokens = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota'];
    const measured = ['alpha', 'zzq\u000azzq', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota'];
    const dir = makeProject(t, { 'timing.json': timingWith(narrated(tokens.join(' '), measured)) });

    const r = runScript('write-subtitles.mjs', ['--apply'], dir);

    assert.equal(r.code, EXIT.FAILED, `this fixture wrote a 3-line cue at exit 0 before the gate\n${r.all}`);
    assert.match(r.stderr, /contains a line break \(U\+000A\)/, r.all);
    assert.deepEqual(fs.readdirSync(dir), ['timing.json'], 'and nothing is written');
  });

  /**
   * The property the gate exists to guarantee, asserted on the BYTES that were written and
   * independently of how the gate is implemented: in a sidecar "-->" is a timing separator
   * and nothing else.
   *
   * POSITIONAL, not shape-based. The first version of this check only asserted that every
   * arrow-bearing line LOOKED like a timing line — which `00:00:00.000 --> 00:00:09.000`
   * does, the exact payload the forged-timing row above exists to keep out. It would have
   * passed a sidecar built entirely out of the thing being refused. A cue block is
   * "index / timing / text...", so the arrow is legal on the block's timing line and
   * nowhere else, whatever the text happens to look like.
   */
  const TIMING = /^\d{2}:\d{2}:\d{2}[.,]\d{3} --> \d{2}:\d{2}:\d{2}[.,]\d{3}$/;
  const assertArrowsOnlyOnTimingLines = (body, what) => {
    const blocks = body.split('\n\n')
      .map((b) => b.split('\n').filter((l) => l !== ''))
      .filter((lines) => lines.length && lines[0] !== 'WEBVTT');
    assert.ok(blocks.length, `${what}: no cue blocks to check — the invariant would be vacuous`);
    for (const lines of blocks) {
      assert.match(lines[0], /^\d+$/, `${what}: cue block does not open with an index: ${JSON.stringify(lines[0])}`);
      assert.match(lines[1] ?? '', TIMING, `${what}: no timing line where one belongs: ${JSON.stringify(lines[1])}`);
      for (const text of lines.slice(2)) {
        assert.ok(!text.includes('-->'), `${what}: "-->" inside cue TEXT: ${JSON.stringify(text)}`);
      }
    }
  };

  // The control for the check itself. Without it the invariant could silently degrade to
  // vacuous again — a check that cannot fail proves nothing, and this one already did.
  test('assertArrowsOnlyOnTimingLines_aSidecarWhoseCueTextIsATimingLine_isRejected', () => {
    const forged = 'WEBVTT\n\n1\n00:00:00.100 --> 00:00:02.500\n00:00:00.000 --> 00:00:09.000\n';

    assert.throws(() => assertArrowsOnlyOnTimingLines(forged, 'forged'), /"-->" inside cue TEXT/);
  });

  test('assertArrowsOnlyOnTimingLines_aWellFormedSidecar_isAccepted', () => {
    const good = 'WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\nfirst cue\n\n2\n00:00:02.000 --> 00:00:04.000\nsecond cue\n';

    assert.doesNotThrow(() => assertArrowsOnlyOnTimingLines(good, 'control'));
  });

  test('writeSubtitles_aValidTimeline_writesArrowsOnlyOnTimingLinesInBothSidecars', (t) => {
    const dir = makeProject(t, {
      'timing.json': timingWith([
        ...narrated('the arrow -> points right - -> onward', ['the', 'arrow', '->', 'points', 'right', '-', '->', 'onward']),
        { id: 'gap', startMs: 2900, endMs: 3860, voiceoverText: '', silence: { caption: '[music]' } },
      ]),
    });

    const r = runScript('write-subtitles.mjs', ['--apply'], dir);

    assertCleanExit(r, EXIT.OK, 'a valid timeline must be captioned: ');
    assertArrowsOnlyOnTimingLines(fs.readFileSync(path.join(dir, 'demo.vtt'), 'utf8'), 'demo.vtt');
    assertArrowsOnlyOnTimingLines(fs.readFileSync(path.join(dir, 'demo.srt'), 'utf8'), 'demo.srt');
  });
});

describe("frame-capture checks a silent segment's window and never derives its end from audio", () => {
  const timingOf = (segments) => JSON.stringify({
    project: { name: 'demo', fps: 30, width: 320, height: 240 },
    endCard: { enabled: false },
    segments,
  });
  const narrated = { id: 'one', startMs: 0, endMs: 960, voiceoverText: 'hello', audio: { durationMs: 960 } };
  const files = (dir) => Object.fromEntries(fs.readdirSync(dir, { recursive: true })
    .filter((f) => fs.statSync(path.join(dir, f)).isFile())
    .map((f) => [f, fs.readFileSync(path.join(dir, f)).toString('base64')]));
  const project = (t, gap) => makeProject(t, { 'timing.json': timingOf([narrated, gap]), 'video-auto.html': '<!doctype html><title>x</title>' });
  const MODES = [['plan', [], []], ['apply', ['--apply'], ['--import', BLOCK_PLAYWRIGHT]]];

  for (const [scenario, gap] of [
    // A stale clip length is the only way to derive an end, and it is not the window.
    ['AnEndThatIsNullAndAStaleClipLength',
      { id: 'gap', startMs: 960, endMs: null, voiceoverText: '', silence: { caption: '[music]' }, audio: { durationMs: 960 } }],
    ['AnEndThatIsANumericString', { id: 'gap', startMs: 960, endMs: '1920', voiceoverText: '', silence: { caption: '[music]' } }],
  ]) {
    for (const [mode, args, nodeArgs] of MODES) {
      test(`frameCapture_${mode}WithASilentSegmentWith${scenario}_isRefusedBeforeAnythingRuns`, async (t) => {
        const { silentSegmentProblems } = await load();
        const dir = project(t, gap);
        const before = files(dir);

        const r = runScript('frame-capture.mjs', args, dir, { nodeArgs });

        const [problem] = silentSegmentProblems(gap, 'segment "gap"');
        assert.ok(problem, 'the silence check refuses this segment');
        assert.deepEqual(files(dir), before, 'nothing may be written');
        assert.equal(r.code, EXIT.USAGE, r.all);
        assert.doesNotMatch(r.all, /^\s+at \S/m, `the refusal must print no stack\n${r.all}`);
        assert.match(r.stderr, new RegExp(`^${escapeRe(`error: ${problem}`)}$`, 'm'), `the stage must give its check's words\n${r.all}`);
        assert.doesNotMatch(r.all, /^plan:/m, 'refused before any plan is printed');
        assert.doesNotMatch(r.all, /playwright/i, 'refused before the browser is loaded');
      });
    }
  }

  // An index is not an id. A segment with no valid id — the schema requires a non-empty
  // string — is named by its position, as the shape check names one. Calling it
  // `segment "1"` states an id, and another segment in the same timeline may really carry
  // the id "1", so the author is sent to the wrong line of the file.
  const INDEXED_PROBLEM = 'timing.segments[1] is declared silent but its endMs is null — ' +
    "a silent segment's window is authored, so its endMs must be a finite number of milliseconds";

  for (const [scenario, idField] of [
    ['NoId', {}],
    ['AnEmptyId', { id: '' }],
    ['ANumberForAnId', { id: 7 }],
  ]) {
    const gap = { ...idField, startMs: 960, endMs: null, voiceoverText: '', silence: { caption: '[music]' } };
    for (const [mode, args, nodeArgs] of MODES) {
      test(`frameCapture_${mode}WithAMalformedSilentSegmentWith${scenario}_namesItByItsIndexNotAsAnId`, async (t) => {
        const { silentSegmentProblems } = await load();
        const dir = project(t, gap);
        const before = files(dir);

        const r = runScript('frame-capture.mjs', args, dir, { nodeArgs });

        assert.equal(`error: ${silentSegmentProblems(gap, 'timing.segments[1]')[0]}`, `error: ${INDEXED_PROBLEM}`,
          "the stage's line must be the gate's line, so the two cannot drift apart");
        assert.deepEqual(files(dir), before, 'nothing may be written');
        assert.equal(r.code, EXIT.USAGE, r.all);
        assert.doesNotMatch(r.all, /^\s+at \S/m, `the refusal must print no stack\n${r.all}`);
        assert.match(r.stderr, new RegExp(`^${escapeRe(`error: ${INDEXED_PROBLEM}`)}$`, 'm'),
          `the segment must be named by its index\n${r.all}`);
        assert.doesNotMatch(r.all, /segment "/, `no index may be printed as an id\n${r.all}`);
        assert.doesNotMatch(r.all, /^plan:/m, 'refused before any plan is printed');
        assert.doesNotMatch(r.all, /playwright/i, 'refused before the browser is loaded');
      });
    }
  }

  test('frameCapture_planWithAValidSilentSegment_plansItsAuthoredWindow', (t) => {
    const dir = project(t, { id: 'gap', startMs: 960, endMs: 1920, voiceoverText: '', silence: { caption: '[music]' }, audio: { durationMs: 4800 } });

    const r = runScript('frame-capture.mjs', [], dir);

    assertCleanExit(r, EXIT.OK, 'a valid silent segment must be planned: ');
    // (1920 + 1000) ms at 30 fps: the authored end, not the 960 + 4800 a stale clip length gives.
    assert.match(r.stdout, /^ {2}frames {10}88 at 30 fps/m, r.all);
  });
});


  // ----------------------------------------------------------------------------------
  // THE EARLY AND LATE GATES ASK ONE PREDICATE, so they cannot drift about what narration
  // may not carry — the isGenerablePause pattern, where the refusal stays the predicate's
  // and each site words its own message.
  //
  // Asserted on the PREDICATE and on both stages, because agreement between two gates is
  // not something either gate's own rows can show.
  describe('one statement of what narrated text may not carry', () => {
    const load = () => import('../src/silent-segment.mjs');

    test('narrationCueProblems_namesEachReasonInReportingOrder', async () => {
      const { narrationCueProblems } = await load();

      assert.deepEqual(narrationCueProblems('an ordinary line'), []);
      assert.deepEqual(narrationCueProblems('the arrow --> points'), ['arrow']);
      assert.deepEqual(narrationCueProblems('a\u0085b'), ['nel']);
      assert.deepEqual(narrationCueProblems('both --> and a\u0085b'), ['arrow', 'nel']);
      // Not a string is not a problem to report here; the shape gate owns that.
      assert.deepEqual(narrationCueProblems(null), []);
      assert.deepEqual(narrationCueProblems(7), []);
    });

    // THE SIX THAT CANNOT REACH A CUE FROM NARRATION ARE NOT HERE, and that is deliberate:
    // /\s+/ splits them out before cue text, so refusing them in narration would be a rule
    // that could never fire. They ARE refused in a measured word, by write-subtitles.
    test('narrationCueProblems_ignoresTheSixBreaksNarrationCannotDeliverToACue', async () => {
      const { narrationCueProblems } = await load();

      for (const ch of ['\u000a', '\u000b', '\u000c', '\u000d', '\u2028', '\u2029']) {
        assert.deepEqual(narrationCueProblems(`a${ch}b`), [],
          `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} is split away by /\\s+/ before a cue`);
      }
    });

    // BOTH GATES, ONE RULE. voice.mjs (S3) refuses before synthesising; write-subtitles
    // (S10) refuses again, because narration can be edited after voice has run and S10 does
    // not re-run that gate. Neither is redundant and neither is dead — the S10 half is
    // reached here without voice.mjs ever running, which is the proof it is still live.
    for (const [name, text, tokens] of [
      ['AnArrow', 'the arrow --> points right', ['the', 'arrow', '-->', 'points', 'right']],
      ['ANextLine', 'a\u0085b tail', ['ab', 'tail']],
    ]) {
      test(`bothGates_refuseNarrationHolding${name}`, async (t) => {
        const { voiceTimelineBlocker } = await load();
        const plain = [{ id: 'one', startMs: 0, endMs: 1800, voiceoverText: text }];

        assert.notEqual(voiceTimelineBlocker({ segments: plain, endCard: { enabled: false } }), null,
          'the pre-TTS gate must refuse it');

        const words = tokens.map((w, i) => ({ word: w, startMs: i * 400, endMs: (i + 1) * 400 }));
        const measured = [{
          id: 'one', startMs: 0, endMs: words.at(-1).endMs + 400, voiceoverText: text,
          audio: { file: 'segment_000.mp3', durationMs: words.at(-1).endMs + 400, headMs: 0, tailMs: 0, words },
        }];
        const dir = makeProject(t, { 'timing.json': timingWith(measured) });

        const r = runScript('write-subtitles.mjs', ['--apply'], dir);

        assert.equal(r.code, EXIT.FAILED, `S10 must still refuse it on its own\n${r.all}`);
      });
    }
  });