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

import { EXIT } from '../src/cli-support.mjs';
import { makeProject, runScript, assertCleanExit } from './_helpers.mjs';

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
});

// ===========================================================================
// R3 — chapters (verify the claim that this is already free, and pin it)
// ===========================================================================
describe('chapters for silent segments', () => {
  test('writeChapters_declaredSilentSegment_getsItsOwnChapterAtTheAuthoredStart', (t) => {
    const segments = silentMiddleSegments();
    segments[1].visual = { title: 'Intermission' };
    const dir = makeProject(t, { 'timing.json': timingWith(segments) });

    // --list needs no ffmpeg and no rendered MP4, so this pins the chapter maths itself.
    const r = runScript('write-chapters.mjs', ['--list'], dir);

    assertCleanExit(r, EXIT.OK, 'chapters must not need narration: ');
    assert.match(r.all, /0:00\s+one/);
    assert.match(r.all, /0:00\s+Intermission/, `the silent segment must get a chapter\n${r.all}`);
  });
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
      { id: 'one', startMs: 0, endMs: 480, voiceoverText: 'hello there friend', audio: { file: 'segment_000.mp3', durationMs: 480 } },
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
    const out = fs.readFileSync(path.join(dir, 'voiceover.mp3'));
    assert.equal(out.length, msToBytes(480) + msToBytes(1008), 'the track must contain the silence that was actually generated');
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
    const segments = silentMiddleSegments();
    const dir = makeProject(t, {
      'timing.json': timingWith(segments),
      'calibration-observed.json': JSON.stringify({
        voiceId: 'en-US-AvaNeural',
        roundedSpeed: 1,
        aggregate: { words: 7, speechMs: 1200, observedEffWps: 5.833, observedSafeWps: 5.833 },
        segments: [
          { id: 'one', words: 3, chars: 18, clipMs: 480, speechMs: 480, effWps: 6.25, textHash: 'x' },
          { id: 'intermission', words: 0, chars: 0, clipMs: 960, speechMs: 0, silent: true, textHash: 'x' },
          { id: 'three', words: 4, chars: 15, clipMs: 720, speechMs: 720, effWps: 5.556, textHash: 'x' },
        ],
      }),
    });

    const r = runScript('validate-timing.mjs', [], dir);

    assertCleanExit(r, EXIT.OK, 'a calibration covering a silent segment must validate: ');
    assert.doesNotMatch(r.all, /the timeline has \d+ segment\(s\) but the calibration measured/,
      `silent segments must not be read as a segment-count mismatch\n${r.all}`);
  });
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
