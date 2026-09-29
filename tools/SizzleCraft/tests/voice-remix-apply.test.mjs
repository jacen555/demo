// S3 voice and S4 remix, run with --apply against controlled audio.
//
// WHY THIS FILE EXISTS
//
// Both stages were tested only in plan mode, because their apply paths reach a network
// TTS service (voice) and a real browser's audio decoder (remix). The logic that shapes
// the deliverable had no test:
//   - generating a declared silent segment's clip instead of synthesising it;
//   - refusing to pad a seam that touches a silent segment;
//   - reflowing the timeline onto the audio that exists.
// Deleting any of it turned nothing red.
//
// fixtures/fake-audio.mjs swaps `msedge-tts` and `playwright` for deterministic fakes in
// the child process only. The engine source is untouched. Every clip is a run of 24 ms
// marker frames, so the engine's real probe (music-metadata) measures each one exactly
// and any output can be read back frame by frame.
//
// THE NUMBERS
//
// Every expectation is derived here from the fake's frame model, not copied from a run,
// so it can be checked by hand. One frame is 24 ms, and alignUp rounds to the nearest
// frame.
//
// A fake clip is 5 silent frames, then 10 voiced frames per word, then 5 silent frames:
//   one   "alpha beta gamma"      3 words   40 frames    960 ms
//   two   "delta epsilon"         2 words   30 frames    720 ms
//   four  "zeta eta theta iota"   4 words   50 frames   1200 ms
// The intermission is declared silent, with a 960 ms window: 40 generated silent frames.
// intake: leadInMs 480, perceivedGapMs 720.
//
// voice reads head and tail from the WORD-BOUNDARY metadata. It rescales the boundaries
// by durationMs / lastWordEnd, which pins the last word to the end of the clip. So every
// tail reads 0, and each head reads as 120 ms scaled up:
//   heads          one 120×960/840 = 137 · two 120×720/600 = 144 · four 120×1200/1080 = 133
//   lead-in        alignUp(480 − 137)        = 336   (14 frames)
//   after one      alignUp(720 − 0 − 144)    = 576   (24 frames)
//   after two      none: the seam touches the declared silent segment
//   after interm.  none: the same seam rule
//   timeline       one [336,1296] · two [1872,2592] · intermission [2592,3552] · four [3552,4752]
//
// remix reads head and tail by DECODING, so it sees the real 120 ms at both ends:
//   lead-in        alignUp(480 − 120)        = 360   (15 frames)
//   after one      alignUp(720 − 120 − 120)  = 480   (20 frames)
//   after two, after intermission: none
//   timeline       one [360,1320] · two [1800,2520] · intermission [2520,3480] · four [3480,4680]

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';

import { EXIT } from '../src/cli-support.mjs';
import { FAKE_AUDIO, brandTokens, makeProject, makeOutsideDir, runScript, assertCleanExit } from './_helpers.mjs';
import { FRAME_BYTES, FRAME_MS, frames, readFrames, ttsClip } from './fixtures/fake-audio-backends.mjs';

const NARRATION = { one: 'alpha beta gamma', two: 'delta epsilon', four: 'zeta eta theta iota' };
const INTAKE = { voice: 'en-US-AvaNeural', speed: 1, silenceMs: 0, toleranceMs: 750, leadInMs: 480, perceivedGapMs: 720 };

function timingBody(segments, extra = {}) {
  return JSON.stringify({
    project: { name: 'demo', fps: 30, width: 1280, height: 720, lede: 'a lede' },
    durationMs: segments.at(-1).endMs,
    endCard: { enabled: false },
    intake: INTAKE,
    segments,
    ...extra,
  });
}

/**
 * A readable, exact description of a marker MP3: its payload bytes, run-length encoded
 * ("19×00 30×74 …"). The encoding is lossless, and readFrames rejects any byte that is
 * not part of a whole marker frame. So two equal descriptions mean two identical files,
 * and a failure diff shows WHERE the audio differs rather than two buffer dumps.
 */
function runs(bytes) {
  const out = [];
  for (const p of readFrames(bytes)) {
    const hex = p.toString(16).padStart(2, '0');
    if (out.length && out.at(-1).hex === hex) out.at(-1).n++;
    else out.push({ hex, n: 1 });
  }
  return out.map(({ n, hex }) => `${n}×${hex}`).join(' ');
}

/** The frames of `track` between two timeline instants, which are whole frames here. */
function slice(track, startMs, endMs) {
  return track.subarray((startMs / FRAME_MS) * FRAME_BYTES, (endMs / FRAME_MS) * FRAME_BYTES);
}

const windows = (timing) => Object.fromEntries(timing.segments.map((s) => [s.id, [s.startMs, s.endMs]]));

/**
 * One expensive run shared by a suite's tests. The house helpers take a test context for
 * cleanup, so this stands in for one and cleans up when the suite ends.
 */
function suiteScope() {
  const cleanups = [];
  after(() => { for (const fn of cleanups.reverse()) fn(); });
  return { after: (fn) => cleanups.push(fn) };
}

// ---------------------------------------------------------------------------
// The harness is only as good as its premise: the engine's own probe must measure a
// marker clip at exactly its frame length. Every number above rests on this.
// ---------------------------------------------------------------------------
describe('the fake audio harness', () => {
  test('fakeAudio_markerClips_probeToTheirFrameLengthWithTheEnginesOwnProbe', async (t) => {
    const dir = makeProject(t, {
      'one.mp3': ttsClip(NARRATION.one),
      'two.mp3': ttsClip(NARRATION.two),
      'four.mp3': ttsClip(NARRATION.four),
      'lead.mp3': frames(14),
    });
    const probe = async (f) => Math.round((await parseFile(path.join(dir, f), { duration: true })).format.duration * 1000);

    assert.deepEqual(
      { one: await probe('one.mp3'), two: await probe('two.mp3'), four: await probe('four.mp3'), lead: await probe('lead.mp3') },
      { one: 960, two: 720, four: 1200, lead: 336 },
    );
  });

  test('fakeAudio_decoder_rejectsBytesThatAreNotMarkerFrames', () => {
    // A fake decoder that accepted anything would let a corrupt concatenation measure as
    // silence and pass. It must fail the way a real decoder does.
    assert.throws(() => readFrames(Buffer.from('not audio')), /whole 288-byte marker frames/);
    const torn = Buffer.concat([frames(2), Buffer.from([0xff, 0xf3])]);
    assert.throws(() => readFrames(torn), /whole 288-byte marker frames/);
    const unsynced = frames(2);
    unsynced[FRAME_BYTES] = 0x00;
    assert.throws(() => readFrames(unsynced), /no marker frame header at byte 288/);
  });
});

// ---------------------------------------------------------------------------
// S3 voice: synthesis, silent-clip generation, the gap solve and the reflow.
// ---------------------------------------------------------------------------
describe('voice --apply against a controlled TTS service', () => {
  const scope = suiteScope();
  const AUTHORED = [
    { id: 'one', startMs: 0, endMs: 960, voiceoverText: NARRATION.one },
    { id: 'two', startMs: 960, endMs: 1680, voiceoverText: NARRATION.two },
    { id: 'intermission', startMs: 1680, endMs: 2640, voiceoverText: '', silence: { caption: '[music]' } },
    { id: 'four', startMs: 2640, endMs: 3840, voiceoverText: NARRATION.four },
  ];
  let dir;
  let r;
  let requests;
  const read = (f) => fs.readFileSync(path.join(dir, f));
  const timing = () => JSON.parse(fs.readFileSync(path.join(dir, 'timing.json'), 'utf8'));

  before(() => {
    dir = makeProject(scope, { 'timing.json': timingBody(AUTHORED), 'brand/tokens.json': brandTokens });
    // The request log lives outside the project, so it cannot collide with a stage output.
    const log = path.join(makeOutsideDir(scope), 'tts.jsonl');
    r = runScript('voice.mjs', ['--apply', '--replace'], dir, {
      nodeArgs: ['--import', FAKE_AUDIO],
      env: { FAKE_TTS_LOG: log },
    });
    requests = fs.existsSync(log)
      ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : [];
  });

  test('voice_applyWithDeclaredSilentSegment_sendsOnlyNarrationToTheTtsService', () => {
    assertCleanExit(r, EXIT.OK, 'voice must complete against the fake service: ');
    // The real service answers "" with an empty stream. voice rejects that as a
    // zero-duration clip, four times with backoff, and then fails the whole run.
    assert.deepEqual(requests.map((q) => q.text), [NARRATION.one, NARRATION.two, NARRATION.four],
      'a declared silent segment must never be sent to TTS');
    assert.ok(requests.every((q) => q.voice === INTAKE.voice && q.rate === '+0%'), JSON.stringify(requests));
  });

  test('voice_applyWithDeclaredSilentSegment_generatesItsClipAtTheAuthoredLength', () => {
    assertCleanExit(r, EXIT.OK);
    assert.equal(runs(read('segment_03.mp3')), runs(frames(40)),
      'the intermission clip must be its whole 960 ms window of generated silence');
    // The narrated clips are the service's bytes, unaltered.
    assert.equal(runs(read('segment_01.mp3')), runs(ttsClip(NARRATION.one)));
    assert.equal(runs(read('segment_02.mp3')), runs(ttsClip(NARRATION.two)));
    assert.equal(runs(read('segment_04.mp3')), runs(ttsClip(NARRATION.four)));
  });

  test('voice_applyWithDeclaredSilentSegment_insertsNoGapAtItsSeams', () => {
    assertCleanExit(r, EXIT.OK);
    assert.equal(runs(read('lead.mp3')), runs(frames(14)), 'lead-in: alignUp(480 − 137) = 336 ms');
    assert.equal(runs(read('gap_01.mp3')), runs(frames(24)), 'after one: alignUp(720 − 0 − 144) = 576 ms');
    for (const name of ['gap_02.mp3', 'gap_03.mp3']) {
      assert.equal(fs.existsSync(path.join(dir, name)), false,
        `${name} pads a seam touching the declared silent segment — the authored silence already is the pause`);
    }
    assert.match(read('sync-mapping.md').toString('utf8'), /^insertedGapsMs=576,0,0$/m);
  });

  test('voice_applyWithDeclaredSilentSegment_reflowsEverySegmentOntoTheMeasuredAudio', () => {
    assertCleanExit(r, EXIT.OK);
    const produced = timing();
    assert.deepEqual(windows(produced), {
      one: [336, 1296], two: [1872, 2592], intermission: [2592, 3552], four: [3552, 4752],
    });
    assert.equal(produced.leadInMs, 336);
    assert.equal(produced.durationMs, 4752, 'a disabled end card ends the timeline at the content');
    const silent = produced.segments.find((s) => s.id === 'intermission');
    assert.deepEqual(
      { file: silent.audio.file, durationMs: silent.audio.durationMs, headMs: silent.audio.headMs, tailMs: silent.audio.tailMs, words: silent.audio.words },
      { file: 'segment_03.mp3', durationMs: 960, headMs: 0, tailMs: 0, words: [] },
    );
    // Word boundaries land inside their own segment's window, on the reflowed clock.
    for (const s of produced.segments) {
      for (const w of s.audio.words) {
        assert.ok(w.startMs >= s.startMs && w.endMs <= s.endMs, `${s.id}: "${w.word}" ${w.startMs}-${w.endMs} is outside [${s.startMs}, ${s.endMs}]`);
      }
    }
  });

  test('voice_apply_voiceoverIsTheClipsAndGapsConcatenatedAtTheirTimelineOffsets', () => {
    assertCleanExit(r, EXIT.OK);
    const track = read('voiceover.mp3');
    assert.equal(runs(track), runs(Buffer.concat([
      frames(14), ttsClip(NARRATION.one), frames(24), ttsClip(NARRATION.two), frames(40), ttsClip(NARRATION.four),
    ])));
    // The timeline describes the audio that exists: each window holds exactly its clip.
    for (const s of timing().segments) {
      assert.equal(runs(slice(track, s.startMs, s.endMs)), runs(read(s.audio.file)),
        `${s.id} [${s.startMs}, ${s.endMs}] does not hold ${s.audio.file} in voiceover.mp3`);
    }
  });
});

// ---------------------------------------------------------------------------
// S4 remix: decoded edge measurement, the gap re-solve and the reflow. The clips on disk
// are reused byte for byte.
// ---------------------------------------------------------------------------
describe('remix --apply against a controlled decoder', () => {
  const scope = suiteScope();
  const words = (list) => list.map(([word, startMs, endMs]) => ({ word, startMs, endMs }));
  // The timeline exactly as the voice suite above leaves it.
  const VOICED = [
    { id: 'one', startMs: 336, endMs: 1296, voiceoverText: NARRATION.one,
      audio: { file: 'segment_01.mp3', durationMs: 960, headMs: 137, tailMs: 0, words: words([['alpha', 473, 747], ['beta', 747, 1022], ['gamma', 1022, 1296]]) } },
    { id: 'two', startMs: 1872, endMs: 2592, voiceoverText: NARRATION.two,
      audio: { file: 'segment_02.mp3', durationMs: 720, headMs: 144, tailMs: 0, words: words([['delta', 2016, 2304], ['epsilon', 2304, 2592]]) } },
    { id: 'intermission', startMs: 2592, endMs: 3552, voiceoverText: '', silence: { caption: '[music]' },
      audio: { file: 'segment_03.mp3', durationMs: 960, headMs: 0, tailMs: 0, words: [] } },
    { id: 'four', startMs: 3552, endMs: 4752, voiceoverText: NARRATION.four,
      audio: { file: 'segment_04.mp3', durationMs: 1200, headMs: 133, tailMs: 0, words: words([['zeta', 3685, 3952], ['eta', 3952, 4219], ['theta', 4219, 4485], ['iota', 4485, 4752]]) } },
  ];
  const CLIPS = {
    'segment_01.mp3': ttsClip(NARRATION.one),
    'segment_02.mp3': ttsClip(NARRATION.two),
    'segment_03.mp3': frames(40),
    'segment_04.mp3': ttsClip(NARRATION.four),
  };
  let dir;
  let r;
  const read = (f) => fs.readFileSync(path.join(dir, f));
  const timing = () => JSON.parse(fs.readFileSync(path.join(dir, 'timing.json'), 'utf8'));

  before(() => {
    dir = makeProject(scope, {
      'timing.json': timingBody(VOICED, { leadInMs: 336 }),
      ...CLIPS,
      'voiceover.mp3': 'the previous narration',
    });
    r = runScript('remix.mjs', ['--apply', '--replace'], dir, { nodeArgs: ['--import', FAKE_AUDIO] });
  });

  test('remix_apply_measuresHeadAndTailFromTheDecodedAudio', () => {
    assertCleanExit(r, EXIT.OK, 'remix must complete against the fake decoder: ');
    const edges = Object.fromEntries(timing().segments.map((s) => [s.id, [s.audio.headMs, s.audio.tailMs]]));
    assert.deepEqual(edges, { one: [120, 120], two: [120, 120], intermission: [0, 0], four: [120, 120] });
  });

  test('remix_applyWithDeclaredSilentSegment_insertsNoGapAtItsSeams', () => {
    assertCleanExit(r, EXIT.OK);
    assert.equal(runs(read('lead.mp3')), runs(frames(15)), 'lead-in: alignUp(480 − 120) = 360 ms');
    assert.equal(runs(read('gap_01.mp3')), runs(frames(20)), 'after one: alignUp(720 − 120 − 120) = 480 ms');
    for (const name of ['gap_02.mp3', 'gap_03.mp3']) {
      assert.equal(fs.existsSync(path.join(dir, name)), false,
        `${name} pads a seam touching the declared silent segment — remix must solve pacing exactly as voice does`);
    }
  });

  test('remix_applyWithDeclaredSilentSegment_reflowsEverySegmentOntoTheResolvedPacing', () => {
    assertCleanExit(r, EXIT.OK);
    const produced = timing();
    assert.deepEqual(windows(produced), {
      one: [360, 1320], two: [1800, 2520], intermission: [2520, 3480], four: [3480, 4680],
    });
    assert.equal(produced.leadInMs, 360);
    assert.equal(produced.durationMs, 4680);
    // Every word moves with its segment, by exactly the segment's own shift.
    for (const prior of VOICED) {
      const now = produced.segments.find((s) => s.id === prior.id);
      const shift = now.startMs - prior.startMs;
      assert.deepEqual(now.audio.words, prior.audio.words.map((w) => ({ ...w, startMs: w.startMs + shift, endMs: w.endMs + shift })),
        `${prior.id}: words must shift by ${shift} ms with their segment`);
    }
  });

  test('remix_apply_reusesTheClipsAndConcatenatesThemAtTheirTimelineOffsets', () => {
    assertCleanExit(r, EXIT.OK);
    for (const [name, bytes] of Object.entries(CLIPS)) {
      assert.ok(read(name).equals(bytes), `${name} must be reused byte for byte, not rewritten`);
    }
    const track = read('voiceover.mp3');
    assert.equal(runs(track), runs(Buffer.concat([
      frames(15), CLIPS['segment_01.mp3'], frames(20), CLIPS['segment_02.mp3'], CLIPS['segment_03.mp3'], CLIPS['segment_04.mp3'],
    ])));
    for (const s of timing().segments) {
      assert.equal(runs(slice(track, s.startMs, s.endMs)), runs(read(s.audio.file)),
        `${s.id} [${s.startMs}, ${s.endMs}] does not hold ${s.audio.file} in voiceover.mp3`);
    }
  });
});
