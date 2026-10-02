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
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';

import { EXIT } from '../src/cli-support.mjs';
import { renderBlocker, voiceBlocker } from '../src/silent-segment.mjs';
import { FAKE_AUDIO, brandTokens, makeProject, makeOutsideDir, runScript, assertCleanExit, tryMakeFileLink, shortNameOf, zeroFileIds, ZERO_FILE_IDS_ARMED } from './_helpers.mjs';
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
const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

  // validate-timing fails a silent window its record does not describe. That check is only
  // right if the timeline voice itself produces passes it.
  test('validateTiming_afterVoiceApply_findsTheSilentRecordReflowed', () => {
    assertCleanExit(r, EXIT.OK);

    const v = runScript('validate-timing.mjs', [], dir);

    assertCleanExit(v, EXIT.OK, 'the timeline voice produced must validate: ');
    assert.match(v.all, /declared silence: OK \(1 segment\(s\): intermission\)/, v.all);
    assert.doesNotMatch(v.all, /NOT REFLOWED|INCOMPLETE RECORD|UNCHECKED/, v.all);
  });

  test('validateTiming_afterVoiceApplyWithANonFrameAlignedSilentWindow_findsTheSilentRecordReflowed', (t) => {
    // 1000 ms generates 42 frames, 1008 ms: voice probes that clip and reflows onto it.
    const segments = structuredClone(AUTHORED);
    segments[2].endMs = 2680;
    segments[3].startMs = 2680;
    segments[3].endMs = 3880;
    const own = makeProject(t, { 'timing.json': timingBody(segments), 'brand/tokens.json': brandTokens });
    assertCleanExit(runScript('voice.mjs', ['--apply', '--replace'], own, { nodeArgs: ['--import', FAKE_AUDIO] }), EXIT.OK);
    const silent = JSON.parse(fs.readFileSync(path.join(own, 'timing.json'), 'utf8')).segments[2];
    assert.deepEqual([silent.endMs - silent.startMs, silent.audio.durationMs], [1008, 1008]);

    const v = runScript('validate-timing.mjs', [], own);

    assertCleanExit(v, EXIT.OK, 'the timeline voice produced must validate: ');
    assert.match(v.all, /declared silence: OK/, v.all);
    assert.doesNotMatch(v.all, /NOT REFLOWED/, v.all);
  });
});

// ---------------------------------------------------------------------------
// S4 remix: decoded edge measurement, the gap re-solve and the reflow. Narrated clips on
// disk are reused byte for byte; a declared silent segment's clip is regenerated from its
// authored window, which here is unchanged, so its bytes are too.
// ---------------------------------------------------------------------------
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

describe('remix --apply against a controlled decoder', () => {
  const scope = suiteScope();
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
    // The narrated clips are decoded and reused byte for byte, never rewritten. The silent
    // segment's clip IS rewritten, from its 960 ms window, which gives back the same 40
    // frames because that window has not been edited since voice generated them.
    for (const [name, bytes] of Object.entries(CLIPS)) {
      assert.ok(read(name).equals(bytes), `${name} must hold the same bytes after a remix that edited nothing`);
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

  test('validateTiming_afterRemixApply_findsTheSilentRecordReflowed', () => {
    assertCleanExit(r, EXIT.OK);

    const v = runScript('validate-timing.mjs', [], dir);

    assertCleanExit(v, EXIT.OK, 'the timeline remix produced must validate: ');
    assert.match(v.all, /declared silence: OK \(1 segment\(s\): intermission\)/, v.all);
    assert.doesNotMatch(v.all, /NOT REFLOWED|INCOMPLETE RECORD|UNCHECKED/, v.all);
  });
});

/** Every file in a project, by name, as a content hash: the "nothing was written" check. */
function snapshot(dir) {
  const out = {};
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    out[path.relative(dir, file)] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  return out;
}

// ---------------------------------------------------------------------------
// The pause assets. lead.mp3, gap_NN.mp3 and outro.mp3 are names the ENGINE chose, so
// a link at one is refused rather than followed, and the plan lists each one before
// anything is written. They used to be written by a silence-gen child process, through
// the resolver that follows in-root links, and the plan never named them: a gap_01.mp3
// planted as a link to music.wav had MPEG silence written into music.wav, at exit 0.
// ---------------------------------------------------------------------------
describe('voice writes its pause assets as engine-chosen outputs', () => {
  // lead-in alignUp(480 − 137) = 336 ms; after one alignUp(720 − 0 − 144) = 576 ms.
  const TWO = [
    { id: 'one', startMs: 0, endMs: 960, voiceoverText: NARRATION.one },
    { id: 'two', startMs: 960, endMs: 1680, voiceoverText: NARRATION.two },
  ];
  const TARGET = 'MUST SURVIVE: a file the voice stage was never asked to write';

  for (const [scenario, asset, target] of [
    ['GapAsset', 'gap_01.mp3', 'music.wav'],
    ['LeadAsset', 'lead.mp3', 'knobs.json'],
  ]) {
    test(`voice_applyWith${scenario}LinkedToAnInRootFile_refusesBeforeAnyWrite`, (t) => {
      const timingText = timingBody(TWO);
      const dir = makeProject(t, { 'timing.json': timingText, 'brand/tokens.json': brandTokens, [target]: TARGET });
      if (!tryMakeFileLink(path.join(dir, asset), path.join(dir, target))) {
        return t.skip('platform refused to create a file link');
      }
      const log = path.join(makeOutsideDir(t), 'tts.jsonl');

      const r = runScript('voice.mjs', ['--apply', '--replace'], dir, {
        nodeArgs: ['--import', FAKE_AUDIO],
        env: { FAKE_TTS_LOG: log },
      });

      assertCleanExit(r, EXIT.USAGE, `a link at ${asset} must be refused, not written through: `);
      assert.match(r.all, new RegExp(`${asset.replace('.', '\\.')}.*is a link`), r.all);
      assert.equal(fs.readFileSync(path.join(dir, target), 'utf8'), TARGET, `${target} must keep its bytes`);
      assert.equal(fs.existsSync(log), false, 'the refusal must come before the TTS service is called');
      assert.equal(fs.existsSync(path.join(dir, 'segment_01.mp3')), false, 'and before any clip is written');
      assert.equal(fs.readFileSync(path.join(dir, 'timing.json'), 'utf8'), timingText);
    });
  }

  test('voice_plan_listsEveryPauseAssetItMayWrite', (t) => {
    const enabled = makeProject(t, {
      'timing.json': timingBody(TWO, { endCard: { enabled: true }, outroMs: 2500 }),
      'brand/tokens.json': brandTokens,
    });
    const r = runScript('voice.mjs', [], enabled);

    assertCleanExit(r, EXIT.OK, 'the plan must succeed: ');
    assert.match(r.all, /^\s+lead\.mp3\s+would CREATE \(written only if the solve inserts a lead-in\)$/m, r.all);
    assert.match(r.all, /^\s+gap_01\.mp3\s+would CREATE \(written only if the solve inserts a pause after segment "one"\)$/m, r.all);
    assert.match(r.all, /^\s+outro\.mp3\s+would CREATE$/m, r.all);
    assert.match(r.all, /solved to 0ms writes nothing/, 'the plan must say a zero pause writes nothing');
    assert.deepEqual(fs.readdirSync(enabled).sort(), ['brand', 'timing.json'], 'a plan writes nothing');

    // A disabled end card has no outro; a seam touching a declared silent segment never
    // gets a pause, and a silent first segment never gets a lead-in, whatever the solve.
    const silentFirst = [
      { id: 'title', startMs: 0, endMs: 960, voiceoverText: '', silence: { caption: '[title]' } },
      ...TWO.map((s) => ({ ...s, startMs: s.startMs + 960, endMs: s.endMs + 960 })),
    ];
    const disabled = makeProject(t, { 'timing.json': timingBody(silentFirst), 'brand/tokens.json': brandTokens });
    const d = runScript('voice.mjs', [], disabled);

    assertCleanExit(d, EXIT.OK);
    assert.match(d.all, /^\s+gap_02\.mp3\s+would CREATE \(written only if the solve inserts a pause after segment "one"\)$/m, d.all);
    for (const never of ['lead.mp3', 'gap_01.mp3', 'outro.mp3']) {
      assert.doesNotMatch(d.all, new RegExp(never.replace('.', '\\.')), `${never} can never be written here\n${d.all}`);
    }
  });
});

// ---------------------------------------------------------------------------
// voice refuses a timeline its gate refuses, in its plan and under --apply, before it writes
// anything or calls the TTS service. It used to make two of the gate's timeline checks, both
// only under --apply and both late: a silence declaration's, inside its loop, after writing
// the clips before that segment; and the all-silent one, in buildCalibration, after writing
// every clip and the voice track, as an uncaught error. So its plan promised runs that
// --apply refused or crashed on, and --apply could overwrite the previous narration before
// it stopped. Each segment clip and the voice track are seeded with a distinct marker clip,
// and the snapshot hashes every file, so it shows an overwrite as well as an addition.
// ---------------------------------------------------------------------------
describe('voice refuses a timeline its gate refuses before it writes anything', () => {
  const authored = () => [
    { id: 'one', startMs: 0, endMs: 960, voiceoverText: NARRATION.one },
    { id: 'two', startMs: 960, endMs: 1680, voiceoverText: NARRATION.two },
    { id: 'intermission', startMs: 1680, endMs: 2640, voiceoverText: '', silence: { caption: '[music]' } },
    { id: 'four', startMs: 2640, endMs: 3840, voiceoverText: NARRATION.four },
  ];
  const SENTINELS = {
    'segment_01.mp3': frames(1),
    'segment_02.mp3': frames(2),
    'segment_03.mp3': frames(3),
    'segment_04.mp3': frames(4),
    'voiceover.mp3': frames(5),
  };
  // timingBody takes durationMs from the last segment, which a timeline with no segment list,
  // or an empty one, does not have. So this states it: 3840 ms, where `four` ends.
  const body = (segments) => JSON.stringify({
    project: { name: 'demo', fps: 30, width: 1280, height: 720, lede: 'a lede' },
    durationMs: 3840,
    endCard: { enabled: false },
    intake: INTAKE,
    ...(segments === undefined ? {} : { segments }),
  });

  // The gate is asked first, about the project exactly as voice will find it.
  function runVoice(t, segments, args) {
    const timingText = body(segments);
    const dir = makeProject(t, { 'timing.json': timingText, 'brand/tokens.json': brandTokens, ...SENTINELS });
    const log = path.join(makeOutsideDir(t), 'tts.jsonl');
    const gate = voiceBlocker(dir, JSON.parse(timingText));
    const before = snapshot(dir);
    const r = runScript('voice.mjs', args, dir, { nodeArgs: ['--import', FAKE_AUDIO], env: { FAKE_TTS_LOG: log } });
    // One comparison, so a failure shows every file written AND whether the service was called.
    const outcome = { files: snapshot(dir), ttsCalled: fs.existsSync(log) };
    return { gate, before, r, log, outcome };
  }

  const MODES = [['plan', []], ['apply', ['--apply', '--replace']]];

  for (const [scenario, segments, pinned] of [
    ['AMalformedDeclaration', () => { const s = authored(); s[2].silence = false; return s; },
      /^error: segment "intermission" declares `silence` as false — it must be an object, e\.g\. \{"caption": "\[music\]"\}$/m],
    // No id: labelled by its 0-based index, as the gate labels it. Pinned as printed, not endorsed.
    ['AnIdlessMalformedDeclaration', () => { const s = authored(); s[2].silence = false; delete s[2].id; return s; },
      /^error: segment "2" declares `silence` as false — it must be an object, e\.g\. \{"caption": "\[music\]"\}$/m],
    ['ANarratedSegmentWithNoText', () => { const s = authored(); delete s[2].silence; return s; },
      /\. Write its narration, or, if it is meant to be silent, declare it silent \(a `silence` block with a caption, and no narration text\)\.$/m],
    ['EverySegmentSilent', () => authored().map((s) => ({ ...s, voiceoverText: '', silence: { caption: '[music]' } })), null],
    ['NoSegmentList', () => undefined, null],
    ['AnEmptySegmentList', () => [], null],
    ['ANullSegment', () => { const s = authored(); s[1] = null; return s; }, null],
  ]) {
    for (const [mode, args] of MODES) {
      test(`voice_${mode}With${scenario}_refusesBeforeAnyWriteOrTtsCall`, (t) => {
        const { gate, before, r, outcome } = runVoice(t, segments(), args);

        assert.ok(gate, 'the gate refuses this timeline');
        assert.deepEqual(outcome, { files: before, ttsCalled: false }, 'a refusal writes nothing and calls no TTS service');
        assertCleanExit(r, EXIT.USAGE, 'a timeline the gate refuses must be refused: ');
        assert.doesNotMatch(r.all, /^\s+at \S/m, `the refusal must print no stack\n${r.all}`);
        // The stage must give its gate's reason, in its gate's words, so the two cannot drift apart.
        assert.ok(r.stderr.includes(gate.fact), `voice must refuse for the gate's reason: ${gate.fact}\n${r.all}`);
        const line = gate.declaration ? `error: ${gate.fact}` : `error: ${renderBlocker(gate)}.`;
        assert.match(r.stderr, new RegExp(`^${esc(line)}$`, 'm'), r.all);
        if (pinned) assert.match(r.stderr, pinned, r.all);
      });
    }
  }

  // The same project, harness and assertions on a timeline the gate accepts: they can see a
  // write and a call to the TTS service, so their silence above means none happened.
  test('voice_planWithAValidTimeline_exitsZeroAndWritesNothing', (t) => {
    const { gate, before, r, outcome } = runVoice(t, authored(), []);

    assert.equal(gate, null, 'the gate accepts this timeline');
    assert.deepEqual(outcome, { files: before, ttsCalled: false }, 'a plan writes nothing and calls no TTS service');
    assertCleanExit(r, EXIT.OK, 'the plan must succeed: ');
    assert.doesNotMatch(r.stderr, /^error:/m, r.all);
  });

  test('voice_applyWithAValidTimeline_callsTheTtsServiceAndOverwritesEveryClip', (t) => {
    const { gate, before, r, log, outcome } = runVoice(t, authored(), ['--apply', '--replace']);

    assert.equal(gate, null, 'the gate accepts this timeline');
    assert.notDeepEqual(outcome.files, before, 'the run must write');
    assert.deepEqual(Object.keys(SENTINELS).filter((f) => !(f in outcome.files) || outcome.files[f] === before[f]), [],
      'every seeded clip, and the voice track, must be overwritten');
    assert.equal(outcome.ttsCalled, true, 'the TTS service must be called');
    assert.ok(fs.statSync(log).size > 0, 'and the call logged');
    assertCleanExit(r, EXIT.OK, 'a valid timeline must be voiced: ');
    assert.doesNotMatch(r.stderr, /^error:/m, r.all);
  });
});

describe('pause assets are generated in-process, byte-identical to silence-gen', () => {
  test('silenceAssetBytes_durationsSilenceGenAccepts_areTheBytesSilenceGenWrites', async (t) => {
    const { silenceAssetBytes } = await import('../src/silent-segment.mjs');
    assert.equal(typeof silenceAssetBytes, 'function', 'silent-segment.mjs must export silenceAssetBytes');
    const dir = makeProject(t);
    for (const ms of [24, 336, 480, 576, 1000, 1500.5, 0.5, 2500]) {
      const g = runScript('silence-gen.mjs', ['--out', 'x.mp3', '--ms', String(ms), '--apply', '--replace'], dir);
      assertCleanExit(g, EXIT.OK, `silence-gen must accept ${ms}: `);
      assert.ok(silenceAssetBytes(ms, 'gap_01.mp3').equals(fs.readFileSync(path.join(dir, 'x.mp3'))),
        `${ms} ms must produce exactly the bytes silence-gen writes`);
    }
    assert.equal(silenceAssetBytes(3_600_000, 'outro.mp3').length, 150_000 * FRAME_BYTES, 'the upper bound silence-gen accepts');
  });

  test('silenceAssetBytes_durationsSilenceGenRefuses_throwNamingTheAsset', async (t) => {
    const { silenceAssetBytes } = await import('../src/silent-segment.mjs');
    assert.equal(typeof silenceAssetBytes, 'function', 'silent-segment.mjs must export silenceAssetBytes');
    const dir = makeProject(t);
    for (const ms of [NaN, Infinity, 1e21, 3_600_001, 0, -24]) {
      const g = runScript('silence-gen.mjs', ['--out', 'x.mp3', `--ms=${String(ms)}`, '--apply'], dir);
      assert.equal(g.code, EXIT.USAGE, `silence-gen refuses ${ms}\n${g.all}`);
      assert.throws(() => silenceAssetBytes(ms, 'outro.mp3'),
        (err) => err.name === 'CliError' && err.exitCode === EXIT.FAILED && /outro\.mp3/.test(err.message),
        `${ms} ms must be refused the way silence-gen refuses it, naming the asset`);
    }
    assert.equal(fs.existsSync(path.join(dir, 'x.mp3')), false);
  });
});

// ---------------------------------------------------------------------------
// S4 silence edits. A silence edit — a gap, a lead-in, an intermission's length — is
// routed to S4, so remix must honour it without re-voicing: a declared silent segment's
// audio is generated from its CURRENT authored window, never taken from the clip voice
// generated for an older one. Every number below uses the decoded edges from the header:
// lead-in 360 ms (15 frames) and, after one, 480 ms (20 frames).
// ---------------------------------------------------------------------------
describe('remix regenerates declared silence from the authored window', () => {
  const remixProject = (t, edit, files = {}) => {
    const segments = structuredClone(VOICED);
    edit(segments);
    return makeProject(t, {
      'timing.json': timingBody(segments, { leadInMs: 336 }),
      ...CLIPS,
      'voiceover.mp3': 'the previous narration',
      ...files,
    });
  };
  const remix = (dir, args = ['--apply', '--replace']) =>
    runScript('remix.mjs', args, dir, { nodeArgs: ['--import', FAKE_AUDIO] });
  const readText = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
  const readBytes = (dir, f) => fs.readFileSync(path.join(dir, f));
  const byId = (timing) => Object.fromEntries(timing.segments.map((s) => [s.id, s]));
  const shifted = (list, ms) => list.map((w) => ({ ...w, startMs: w.startMs + ms, endMs: w.endMs + ms }));
  // One whole line of output, from a literal start to a literal end. Anchored at both ends, it
  // fails when the advice that ends a refusal loses its tail or gains one.
  const wholeLine = (start, end) => new RegExp(`^${esc(start)}[^\\n]*${esc(end)}\\r?$`, 'm');

  test('remix_applyAfterASilentWindowIsWidened_generatesTheAuthoredWindowAndReflowsOntoIt', (t) => {
    // The intermission is widened from 960 to 3000 ms after voice ran, and four moves with it.
    const dir = remixProject(t, (s) => {
      s[2].endMs = 5592;
      s[3].startMs = 5592;
      s[3].endMs = 6792;
      s[3].audio.words = shifted(s[3].audio.words, 2040);
    });

    const r = remix(dir);

    assertCleanExit(r, EXIT.OK, 'a silence edit must remix without re-voicing: ');
    const produced = JSON.parse(readText(dir, 'timing.json'));
    assert.deepEqual(windows(produced), { one: [360, 1320], two: [1800, 2520], intermission: [2520, 5520], four: [5520, 6720] },
      'the intermission must keep its authored 3000 ms, not snap back to the 960 ms clip voice made for its old window');
    assert.equal(produced.durationMs, 6720);
    const silent = byId(produced).intermission;
    assert.deepEqual({ ...silent.audio }, { file: 'segment_03.mp3', durationMs: 3000, headMs: 0, tailMs: 0, words: [] },
      'the record must describe the audio that now exists');
    assert.equal(silent.plannedDurationMs, 3000, 'the authored window is the planned one, as voice records it');
    assert.equal(runs(readBytes(dir, 'segment_03.mp3')), runs(frames(125)), 'the clip the record names must hold the 3000 ms');
    assert.equal(runs(readBytes(dir, 'voiceover.mp3')), runs(Buffer.concat([
      frames(15), CLIPS['segment_01.mp3'], frames(20), CLIPS['segment_02.mp3'], frames(125), CLIPS['segment_04.mp3'],
    ])));
  });

  test('remix_applyTwiceAfterANonFrameAlignedSilentWindow_isAFixedPoint', (t) => {
    // A 1000 ms window generates 42 frames, 1008 ms. The first remix reflows the window
    // onto the 1008 ms that exist; the second must find nothing left to change.
    const dir = remixProject(t, (s) => {
      s[2].endMs = 3592;
      s[3].startMs = 3592;
      s[3].endMs = 4792;
      s[3].audio.words = shifted(s[3].audio.words, 40);
    });

    const first = remix(dir);

    assertCleanExit(first, EXIT.OK);
    const once = { timing: readText(dir, 'timing.json'), voice: readBytes(dir, 'voiceover.mp3'), clip: readBytes(dir, 'segment_03.mp3') };
    const t1 = JSON.parse(once.timing);
    assert.deepEqual(windows(t1).intermission, [2520, 3528], 'the window must describe the 1008 ms of silence that exists');
    assert.equal(byId(t1).intermission.audio.durationMs, 1008);
    assert.equal(runs(once.clip), runs(frames(42)));

    const second = remix(dir);

    assertCleanExit(second, EXIT.OK);
    assert.equal(readText(dir, 'timing.json'), once.timing, 'a second remix must change nothing in the timeline');
    assert.ok(readBytes(dir, 'voiceover.mp3').equals(once.voice), 'or in the voice track');
    assert.ok(readBytes(dir, 'segment_03.mp3').equals(once.clip), 'or in the silent clip');
  });

  test('remix_applyAfterANarratedSegmentIsDeclaredSilent_replacesItsSpeechWithGeneratedSilence', (t) => {
    // two is silenced in timing.json alone: its record still names the 720 ms speech clip
    // and still carries that clip's words.
    const dir = remixProject(t, (s) => {
      s[1].voiceoverText = '';
      s[1].silence = { caption: '[pause]' };
    });

    const r = remix(dir);

    assertCleanExit(r, EXIT.OK, 'silencing a narrated segment is a silence edit, handled in S4: ');
    const produced = JSON.parse(readText(dir, 'timing.json'));
    assert.deepEqual(windows(produced), { one: [360, 1320], two: [1320, 2040], intermission: [2040, 3000], four: [3000, 4200] });
    assert.deepEqual({ ...byId(produced).two.audio }, { file: 'segment_02.mp3', durationMs: 720, headMs: 0, tailMs: 0, words: [] },
      'the speech clip\'s words must not survive the declaration');
    assert.equal(runs(readBytes(dir, 'segment_02.mp3')), runs(frames(30)), 'the speech clip is replaced by 720 ms of generated silence');
    assert.equal(runs(readBytes(dir, 'voiceover.mp3')), runs(Buffer.concat([
      frames(15), CLIPS['segment_01.mp3'], frames(30), frames(40), CLIPS['segment_04.mp3'],
    ])), 'the voice track must not play the old speech in a segment declared silent');
    assert.equal(fs.existsSync(path.join(dir, 'gap_01.mp3')), false, 'no pause is inserted beside a declared silent segment');
  });

  test('remix_silenceDeclaredAsFalse_isRefusedBeforeAnyWrite', (t) => {
    const dir = remixProject(t, (s) => { s[2].silence = false; });
    const before = snapshot(dir);

    for (const args of [[], ['--apply', '--replace']]) {
      const r = remix(dir, args);

      assertCleanExit(r, EXIT.USAGE, `remix ${args.join(' ') || '(plan)'} must refuse a malformed declaration before writing anything: `);
      assert.match(r.all, /segment "intermission" declares `silence` as false/, r.all);
      assert.deepEqual(snapshot(dir), before, 'nothing may be written');
    }
  });

  for (const [scenario, edit] of [
    ['EmptyWords', (audio) => { audio.words = []; }],
    ['NoWords', (audio) => { delete audio.words; }],
  ]) {
    test(`remix_narratedSegmentWith${scenario}_isRefusedNamingTheVoiceStage`, (t) => {
      // The intermission's declaration is removed and narration added, in timing.json
      // only. Its clip is still the generated silence and its record still says so.
      const dir = remixProject(t, (s) => {
        delete s[2].silence;
        s[2].voiceoverText = 'now it speaks';
        edit(s[2].audio);
      });
      const before = snapshot(dir);

      for (const args of [[], ['--apply', '--replace']]) {
        const r = remix(dir, args);

        assertCleanExit(r, EXIT.USAGE, `remix ${args.join(' ') || '(plan)'} must refuse narration that was never synthesised: `);
        assert.match(r.all, /segment "intermission"/, r.all);
        assert.match(r.all, /voice\.mjs \(S3\)/, 'the refusal must name the stage that can synthesise it');
        assert.deepEqual(snapshot(dir), before, 'nothing may be written');
      }
    });
  }

  test('remix_silentSegmentWhoseClipNameANarratedSegmentStillUses_isRefusedBeforeAnyWrite', (t) => {
    // Reordered after voice ran: the intermission is now second, so the clip name remix
    // gives it by position is segment_02.mp3, which two still names.
    const dir = remixProject(t, (s) => {
      const [intermission] = s.splice(2, 1);
      s.splice(1, 0, intermission);
      s[1].startMs = 1296; s[1].endMs = 2256;
      s[2].startMs = 2256; s[2].endMs = 2976; s[2].audio.words = shifted(s[2].audio.words, 384);
      s[3].startMs = 2976; s[3].endMs = 4176; s[3].audio.words = shifted(s[3].audio.words, -576);
    });
    const before = snapshot(dir);

    for (const args of [[], ['--apply', '--replace']]) {
      const r = remix(dir, args);

      assertCleanExit(r, EXIT.USAGE, `remix ${args.join(' ') || '(plan)'} must not regenerate silence over a narrated clip: `);
      assert.match(r.all, /segment_02\.mp3/, r.all);
      assert.match(r.all, /segment "two"/, r.all);
      assert.deepEqual(snapshot(dir), before, 'nothing may be written');
    }
  });

  for (const [scenario, asset] of [['GapAsset', 'gap_01.mp3'], ['LeadAsset', 'lead.mp3'], ['SilentClip', 'segment_03.mp3']]) {
    test(`remix_applyWith${scenario}LinkedToAnInRootFile_refusesBeforeAnyWrite`, (t) => {
      // The target holds valid marker frames, so a stage that followed the link could
      // also decode through it.
      const dir = remixProject(t, () => {}, { 'music.wav': frames(40) });
      fs.rmSync(path.join(dir, asset), { force: true });
      if (!tryMakeFileLink(path.join(dir, asset), path.join(dir, 'music.wav'))) {
        return t.skip('platform refused to create a file link');
      }
      const before = snapshot(dir);

      const r = remix(dir);

      assertCleanExit(r, EXIT.USAGE, `a link at ${asset} must be refused, not written through: `);
      assert.match(r.all, new RegExp(`${asset.replace('.', '\\.')}.*is a link`), r.all);
      assert.deepEqual(snapshot(dir), before, 'nothing may be written, least of all the link target');
    });
  }

  test('remix_plan_listsEveryFileItMayWriteAndTheClipsItReuses', (t) => {
    const dir = remixProject(t, () => {});
    const before = snapshot(dir);

    const r = remix(dir, []);

    assertCleanExit(r, EXIT.OK, 'the plan must succeed: ');
    for (const name of ['voiceover.mp3', 'timing.json', 'segment_03.mp3', 'lead.mp3', 'gap_01.mp3']) {
      assert.match(r.all, new RegExp(`^\\s+${name.replace('.', '\\.')}\\s{2,}(would CREATE|would REPLACE|EXISTS)`, 'm'),
        `the plan must list ${name} with what would happen to it\n${r.all}`);
    }
    assert.match(r.all, /segment_03\.mp3.*segment "intermission" is declared silent: regenerated from its 960ms authored window/, r.all);
    for (const never of ['gap_02.mp3', 'gap_03.mp3', 'outro.mp3']) {
      assert.doesNotMatch(r.all, new RegExp(never.replace('.', '\\.')), `${never} can never be written here\n${r.all}`);
    }
    assert.match(r.all, /reused as they are.*segment_01\.mp3, segment_02\.mp3, segment_04\.mp3/, r.all);
    assert.deepEqual(snapshot(dir), before, 'a plan writes nothing');
  });

  test('remix_planWithSegmentsVoiceHasNotRunFor_saysApplyRefusesRatherThanPromisingThem', (t) => {
    // The intermission (declared silent) and four (narrated) have no audio record: voice has
    // not run for them, and --apply refuses the whole run for that. The plan must say so
    // rather than promise a regeneration that will never happen.
    const dir = remixProject(t, (s) => { delete s[2].audio; delete s[3].audio; });
    const before = snapshot(dir);

    const plan = remix(dir, []);

    assertCleanExit(plan, EXIT.OK, 'the plan must succeed: ');
    assert.doesNotMatch(plan.all, /regenerated from its/, `nothing is regenerated when --apply refuses\n${plan.all}`);
    assert.match(plan.all, /segment_03\.mp3.*segment "intermission" is declared silent, but voice\.mjs \(S3\) has not run for it/, plan.all);
    assert.match(plan.all, /not voiced yet[^\n]*voice\.mjs \(S3\)[^\n]*: intermission, four$/m, plan.all);
    assert.match(plan.all, /reused as they are.*: segment_01\.mp3, segment_02\.mp3$/m, plan.all);

    const apply = remix(dir);

    assertCleanExit(apply, EXIT.USAGE, 'the run the plan warned about must be refused: ');
    assert.match(apply.all, /segment "intermission" has no audio\.file[^\n]*voice stage \(S3\) must have run first/, apply.all);
    assert.deepEqual(snapshot(dir), before, 'neither the plan nor the refused run writes anything');
  });

  // A hard link is another name for the same file, so comparing names cannot see it; the
  // volume's file ID can. remix publishes each output by rename, which would leave the
  // narration in place under its own name, but it refuses to write any name it finds a
  // narrated clip under, and must not claim the narration would be destroyed. fs.linkSync
  // needs no privilege on NTFS or on a POSIX filesystem.
  for (const [name, asset, clip, owner, arm] of [
    ['remix_silentClipHardLinkedToANarratedClip_isRefusedBeforeAnyWrite', 'segment_03.mp3', 'segment_02.mp3', 'two',
      `Then run remix.mjs --apply --replace: --replace because segment_03.mp3 is still there, and this run overwrites it with segment "intermission"'s silence.`],
    ['remix_pauseAssetHardLinkedToANarratedClip_isRefusedBeforeAnyWrite', 'gap_01.mp3', 'segment_04.mp3', 'four',
      `Then run remix.mjs --apply --replace: --replace because gap_01.mp3 is still there, and this run overwrites it if the solve inserts a pause after segment "one".`],
  ]) {
    test(name, (t) => {
      const dir = remixProject(t, () => {});
      fs.rmSync(path.join(dir, asset), { force: true });
      fs.linkSync(path.join(dir, clip), path.join(dir, asset));
      const before = snapshot(dir);

      for (const args of [[], ['--apply', '--replace']]) {
        const r = remix(dir, args);

        assertCleanExit(r, EXIT.USAGE, `remix ${args.join(' ') || '(plan)'} must not write narration's file under another name: `);
        assert.match(r.all, new RegExp(`${esc(asset)} is a hard link of ${esc(clip)}, which narrated segment "${owner}" is read from`), r.all);
        assert.match(r.all, wholeLine('error: ', arm), r.all);
        assert.doesNotMatch(r.all, /destroy/, `publishing ${asset} by rename leaves ${clip} holding its narration\n${r.all}`);
        assert.ok(readBytes(dir, clip).equals(CLIPS[clip]), `${clip} must still hold its narration`);
        assert.deepEqual(snapshot(dir), before, 'nothing may be written');
      }
    });
  }

  // The advice's third ending. outro.mp3 is the one pause asset no solve decides: remix writes
  // it whenever the end card is enabled, so the advice names neither a silence nor a solve.
  test('remix_narratedRecordNamingTheOutroAsset_isRefusedEndingWithTheReplaceRunAndWhatItOverwrites', (t) => {
    const segments = structuredClone(VOICED);
    segments[3].audio.file = 'outro.mp3';
    const { 'segment_04.mp3': four, ...clips } = CLIPS;
    const dir = makeProject(t, {
      'timing.json': timingBody(segments, { leadInMs: 336, endCard: { enabled: true }, outroMs: 2500 }),
      'brand/tokens.json': brandTokens,
      ...clips,
      'outro.mp3': four,
      'voiceover.mp3': 'the previous narration',
    });
    const before = snapshot(dir);

    for (const args of [[], ['--apply', '--replace']]) {
      const r = remix(dir, args);

      assertCleanExit(r, EXIT.USAGE, `remix ${args.join(' ') || '(plan)'} must not write the outro over a narrated clip: `);
      assert.match(r.all, wholeLine('error: remix writes outro.mp3, and segment "four" is narrated and its record names that file.',
        'Then run remix.mjs --apply --replace: --replace because outro.mp3 is still there, and this run overwrites it.'), r.all);
      assert.ok(readBytes(dir, 'outro.mp3').equals(CLIPS['segment_04.mp3']), 'outro.mp3 must still hold its narration');
      assert.deepEqual(snapshot(dir), before, 'nothing may be written');
    }
  });

  // ---- R6-6: the guard matches by canonical name too, and says how the record reaches the file ----
  // two's only narration is moved to segment_03.mp3, the intermission's positional clip,
  // which remix writes; two's record names it by its 8.3 short name. With no file IDs the
  // guard used to read "identity unknown" as "another file", and remix replaced the
  // narration at exit 0.
  const narrationAtTheSilentClipByItsShortName = (t) => {
    const dir = remixProject(t, () => {});
    fs.writeFileSync(path.join(dir, 'segment_03.mp3'), CLIPS['segment_02.mp3']);
    fs.rmSync(path.join(dir, 'segment_02.mp3'));
    const alias = shortNameOf(path.join(dir, 'segment_03.mp3'));
    if (alias === null) {
      t.skip('no 8.3 short name here: not Windows, or this volume does not generate them');
      return null;
    }
    const edited = JSON.parse(readText(dir, 'timing.json'));
    byId(edited).two.audio.file = alias;
    fs.writeFileSync(path.join(dir, 'timing.json'), JSON.stringify(edited));
    return { dir, alias };
  };
  const withoutFileIds = (dir) => ({ nodeArgs: ['--import', FAKE_AUDIO, '--import', zeroFileIds({ dir })] });

  test('remix_narratedRecordNamingTheShortNameOfASilentClipWhereTheVolumeReportsNoFileIds_isRefusedBeforeAnyWrite', (t) => {
    const built = narrationAtTheSilentClipByItsShortName(t);
    if (built === null) return;
    const { dir, alias } = built;
    const before = snapshot(dir);

    for (const args of [[], ['--apply', '--replace']]) {
      const r = runScript('remix.mjs', args, dir, withoutFileIds(dir));

      assert.match(r.all, ZERO_FILE_IDS_ARMED, `the volume must report no file IDs\n${r.all}`);
      assertCleanExit(r, EXIT.USAGE, `remix ${args.join(' ') || '(plan)'} must not write two's narration under its long name: `);
      assert.match(r.all, new RegExp(`its record names ${esc(alias)}, another name for segment_03\\.mp3`), r.all);
      assert.ok(readBytes(dir, 'segment_03.mp3').equals(CLIPS['segment_02.mp3']), 'segment_03.mp3 must still hold two\'s narration');
      assert.deepEqual(snapshot(dir), before, 'nothing may be written');
    }
  });

  test('remix_narratedRecordNamingTheShortNameOfASilentClip_saysItIsAnotherNameNotAHardLink', (t) => {
    const built = narrationAtTheSilentClipByItsShortName(t);
    if (built === null) return;
    const { dir, alias } = built;

    for (const args of [[], ['--apply', '--replace']]) {
      const r = remix(dir, args);

      assertCleanExit(r, EXIT.USAGE);
      assert.match(r.all, new RegExp(`remix writes segment_03\\.mp3, and segment "two" is narrated and its record names ${esc(alias)}, ` +
        'another name for segment_03\\.mp3\\. Writing it would destroy that narration'), r.all);
      assert.doesNotMatch(r.all, /hard link/, `${alias} is the same directory entry, which a rename replaces\n${r.all}`);
      assert.ok(readBytes(dir, 'segment_03.mp3').equals(CLIPS['segment_02.mp3']), 'segment_03.mp3 must still hold two\'s narration');
    }
  });

  test('remix_narratedRecordNamingALinkToASilentClip_namesTheLinkAndNoOtherRecord', (t) => {
    const dir = remixProject(t, () => {});
    fs.writeFileSync(path.join(dir, 'segment_03.mp3'), CLIPS['segment_02.mp3']);
    fs.rmSync(path.join(dir, 'segment_02.mp3'));
    if (!tryMakeFileLink(path.join(dir, 'two.mp3'), 'segment_03.mp3')) return t.skip('platform refused to create a file link');
    const edited = JSON.parse(readText(dir, 'timing.json'));
    byId(edited).two.audio.file = 'two.mp3';
    fs.writeFileSync(path.join(dir, 'timing.json'), JSON.stringify(edited));
    const before = snapshot(dir);

    for (const args of [[], ['--apply', '--replace']]) {
      const r = remix(dir, args);

      assertCleanExit(r, EXIT.USAGE);
      assert.match(r.all, /narrated segment "two"'s record names two\.mp3, a link to segment_03\.mp3\. Writing the silence would destroy that narration/, r.all);
      assert.match(r.all, /copy two\.mp3 under a name remix does not write and point segment "two"'s audio\.file at the copy/, r.all);
      assert.doesNotMatch(r.all, /leave two\.mp3 where it is|"intermission"'s record names it/,
        `the intermission's record names segment_03.mp3, not two.mp3\n${r.all}`);
      assert.deepEqual(snapshot(dir), before, 'nothing may be written');
    }
  });

  test('remix_silentClipHardLinkedToANarratedClipWhereTheVolumeReportsNoFileIds_publishesBesideTheNarration', (t) => {
    // CHARACTERIZATION (passes before and after): with no file IDs a hard link cannot be told
    // from another file, so the guard does not fire. Publishing by rename replaces the
    // segment_03.mp3 entry and leaves the narration at segment_02.mp3, its own name.
    const dir = remixProject(t, () => {});
    fs.rmSync(path.join(dir, 'segment_03.mp3'));
    fs.linkSync(path.join(dir, 'segment_02.mp3'), path.join(dir, 'segment_03.mp3'));

    const r = runScript('remix.mjs', ['--apply', '--replace'], dir, withoutFileIds(dir));

    assert.match(r.all, ZERO_FILE_IDS_ARMED, `the volume must report no file IDs\n${r.all}`);
    assertCleanExit(r, EXIT.OK);
    assert.ok(readBytes(dir, 'segment_02.mp3').equals(CLIPS['segment_02.mp3']), 'segment_02.mp3 must still hold two\'s narration');
    assert.equal(runs(readBytes(dir, 'segment_03.mp3')), runs(frames(40)), 'segment_03.mp3 holds the regenerated 960 ms of silence');
    assert.equal(byId(JSON.parse(readText(dir, 'timing.json'))).two.audio.file, 'segment_02.mp3');
  });

  // Every file is staged and checked before any is published. A C-6 failure used to exit
  // with a stack trace after the silent clips, the pauses and the voice track had already
  // been overwritten, leaving new audio beside a timeline that described the old.
  const sentinels = {
    'segment_03.mp3': 'the silent clip before this run',
    'lead.mp3': 'the lead-in before this run',
    'gap_01.mp3': 'the pause before this run',
  };
  const partFiles = (dir) => fs.readdirSync(dir).filter((n) => n.includes('.part-'));

  test('remix_applyWhoseVoiceTrackDriftsFromTheTimeline_publishesNothing', (t) => {
    // one's record claims 9000 ms for its 960 ms clip, so the reflowed timeline runs 8040 ms
    // past the voice track, far outside the drift tolerance.
    const dir = remixProject(t, (s) => { s[0].audio.durationMs = 9000; }, sentinels);
    const before = snapshot(dir);

    const r = remix(dir);

    assert.deepEqual(snapshot(dir), before, 'a run that fails C-6 must leave every file exactly as it was');
    assertCleanExit(r, EXIT.FAILED, 'a drift failure is a reported failure, not a crash: ');
    assert.match(r.all, /C-6 voice drift 8040ms/, r.all);
    assert.match(r.all, /[Nn]othing was written/, r.all);
    assert.match(r.all, /voice\.mjs \(S3\)/, 'the remedy must name the stage that re-measures narration');
    assert.deepEqual(partFiles(dir), [], 'no staged file may be left behind');
  });

  test('remix_applyWhoseRenameFailsPartway_namesWhatWasPublishedAndLeavesTheTimeline', (t) => {
    // Windows refuses a rename over a read-only file, which fails the publish at gap_01.mp3
    // with no seam in the engine. POSIX permits that rename, so there is no way to force the
    // failure there.
    if (process.platform !== 'win32') return t.skip('only Windows refuses a rename over a read-only file');
    const dir = remixProject(t, () => {}, sentinels);
    const gap = path.join(dir, 'gap_01.mp3');
    const before = { timing: readText(dir, 'timing.json'), voice: readBytes(dir, 'voiceover.mp3') };
    fs.chmodSync(gap, 0o444);
    let r;
    try {
      r = remix(dir);
    } finally {
      fs.chmodSync(gap, 0o666);
    }

    assertCleanExit(r, EXIT.FAILED, 'a failed publish is a reported failure, not a crash: ');
    assert.match(r.all, /could not publish gap_01\.mp3 \((EPERM|EACCES)\)/, r.all);
    assert.match(r.all, /Published: segment_03\.mp3, lead\.mp3\. Not published: gap_01\.mp3, voiceover\.mp3, timing\.json\./, r.all);
    assert.match(r.all, /timing\.json was not updated/, r.all);
    assert.equal(readText(dir, 'timing.json'), before.timing, 'the timeline must be left as it was');
    assert.ok(readBytes(dir, 'voiceover.mp3').equals(before.voice), 'an unpublished voice track must be left as it was');
    assert.equal(readText(dir, 'gap_01.mp3'), sentinels['gap_01.mp3']);
    assert.equal(runs(readBytes(dir, 'segment_03.mp3')), runs(frames(40)), 'what the report says was published, was');
    assert.equal(runs(readBytes(dir, 'lead.mp3')), runs(frames(15)));
    assert.deepEqual(partFiles(dir), [], 'no staged file may be left behind');
  });

  test('remix_planAfterTwoSilentSegmentsSwapPlaces_saysThisRunRewritesEachOldClip', (t) => {
    // two is silenced, then it and the intermission swap places. Each now gets the other's
    // clip name, so neither old clip is "left as it is": this run rewrites both.
    const dir = remixProject(t, (s) => {
      s[1].voiceoverText = '';
      s[1].silence = { caption: '[pause]' };
      s[1].audio.words = [];
      const [two] = s.splice(1, 1);
      s.splice(2, 0, two); // one, intermission, two, four
      s[1].startMs = 1296; s[1].endMs = 2256;
      s[2].startMs = 2256; s[2].endMs = 2976;
      s[3].startMs = 2976; s[3].endMs = 4176; s[3].audio.words = shifted(s[3].audio.words, -576);
    });
    const before = snapshot(dir);

    const r = remix(dir, []);

    assertCleanExit(r, EXIT.OK, 'the plan must succeed: ');
    assert.match(r.all,
      /segment_02\.mp3 .*segment "intermission" is declared silent: regenerated[^\n]*; its record named segment_03\.mp3, which this run rewrites as segment "two"'s silence$/m, r.all);
    assert.match(r.all,
      /segment_03\.mp3 .*segment "two" is declared silent: regenerated[^\n]*; its record named segment_02\.mp3, which this run rewrites as segment "intermission"'s silence$/m, r.all);
    assert.doesNotMatch(r.all, /leaves as it is/, r.all);
    assert.deepEqual(snapshot(dir), before, 'a plan writes nothing');
  });

  for (const [scenario, edit, remove, expect] of [
    ['its own name', () => {}, 'segment_03.mp3', /segment_03\.mp3 .*segment "intermission" is declared silent, but --apply refuses the run rather than regenerating it: segment intermission audio not found/],
    ['another name', (s) => { s[2].audio.file = 'intermission_old.mp3'; }, null, /segment_03\.mp3 .*segment "intermission" is declared silent, but --apply refuses the run rather than regenerating it: segment intermission audio not found/],
    ['a narrated clip', () => {}, 'segment_04.mp3', /not found in the project, so --apply refuses the run: segment_04\.mp3 \(segment "four"\)$/m],
  ]) {
    test(`remix_planWhoseRecordNamesAMissingClip_saysApplyRefuses (${scenario})`, (t) => {
      const dir = remixProject(t, edit);
      if (remove) fs.rmSync(path.join(dir, remove));
      const before = snapshot(dir);

      const plan = remix(dir, []);

      assertCleanExit(plan, EXIT.OK, 'the plan must succeed: ');
      assert.match(plan.all, expect, plan.all);
      assert.doesNotMatch(plan.all, /leaves as it is/, `a clip that is not there is not left as it is\n${plan.all}`);
      if (remove === 'segment_04.mp3') {
        assert.match(plan.all, /reused as they are[^\n]*: segment_01\.mp3, segment_02\.mp3$/m, plan.all);
      } else {
        assert.doesNotMatch(plan.all, /regenerated from its/, `nothing is regenerated when --apply refuses\n${plan.all}`);
      }

      const apply = remix(dir);

      // The refusal is the inherited prerequisite check. It still surfaces as an uncaught
      // error (a recorded follow-up), so only the exit, the reason and the writes are pinned.
      assert.notEqual(apply.code, EXIT.OK, `the run the plan warned about must be refused\n${apply.all}`);
      assert.match(apply.all, /audio not found/, apply.all);
      assert.deepEqual(snapshot(dir), before, 'neither the plan nor the refused run writes anything');
    });
  }

  // validate-timing fails a silent window its record does not describe, naming remix. That
  // is only a remedy if the timeline remix produces then passes.
  for (const [scenario, windowEndMs, shiftMs] of [['Widened', 5592, 2040], ['NonFrameAligned', 3592, 40]]) {
    test(`validateTiming_silentWindow${scenario}ThenRemixed_failsBeforeAndPassesAfter`, (t) => {
      const dir = remixProject(t, (s) => {
        s[2].endMs = windowEndMs;
        s[3].startMs = windowEndMs;
        s[3].endMs = windowEndMs + 1200;
        s[3].audio.words = shifted(s[3].audio.words, shiftMs);
      });

      const stale = runScript('validate-timing.mjs', [], dir);

      assertCleanExit(stale, EXIT.FAILED, 'an edited silent window its record does not describe must fail: ');
      assert.match(stale.all, /declared silence: NOT REFLOWED/, stale.all);
      assert.match(stale.all, /remix\.mjs \(S4\)/, stale.all);

      assertCleanExit(remix(dir), EXIT.OK);
      const v = runScript('validate-timing.mjs', [], dir);

      assertCleanExit(v, EXIT.OK, 'the timeline remix produced must validate: ');
      assert.match(v.all, /declared silence: OK \(1 segment\(s\): intermission\)/, v.all);
      assert.doesNotMatch(v.all, /NOT REFLOWED/, v.all);
    });
  }

  // Nothing stops two narrated records naming one clip. Silencing the segment in that clip's
  // position, in place, then collides with the other's input with no reorder at all. Renaming
  // the clip removes the file the silent record names, and remix refuses a record whose clip
  // is missing, so the remedy is a COPY for the narration, with the shared file left in place.
  const sharedClipSilencedInPlace = (s) => {
    s[3].voiceoverText = NARRATION.two;
    s[3].endMs = s[3].startMs + 720;
    s[3].audio = { ...structuredClone(s[1].audio), words: shifted(s[1].audio.words, s[3].startMs - s[1].startMs) };
    s[1].voiceoverText = '';
    s[1].silence = { caption: '[pause]' };
    s[1].audio.words = [];
  };

  test('remix_silencingInPlaceASegmentWhoseClipAnotherNarratedSegmentShares_advisesACopyNotAReorder', (t) => {
    const dir = remixProject(t, sharedClipSilencedInPlace);
    const before = snapshot(dir);

    for (const args of [[], ['--apply', '--replace']]) {
      const r = remix(dir, args);

      assertCleanExit(r, EXIT.USAGE, `remix ${args.join(' ') || '(plan)'} must not regenerate silence over a narrated clip: `);
      assert.match(r.all,
        /segment "two" is declared silent, so remix regenerates its clip as segment_02\.mp3[^\n]*narrated segment "four"'s record names that file/, r.all);
      assert.match(r.all, /copy segment_02\.mp3 under a name remix does not write and point segment "four"'s audio\.file at the copy/, r.all);
      assert.match(r.all, /leave segment_02\.mp3 where it is/, r.all);
      assert.match(r.all, wholeLine('error: ',
        `Then run remix.mjs --apply --replace: --replace because segment_02.mp3 is still there, and this run overwrites it with segment "two"'s silence.`), r.all);
      assert.doesNotMatch(r.all, /reorder|rename/i, `no reorder happened, and a rename is a dead end\n${r.all}`);
      assert.doesNotMatch(r.all, /voice\.mjs/, r.all);
      assert.deepEqual(snapshot(dir), before, 'nothing may be written');
    }
  });

  test('remix_sharedClipCopyRemedy_runsAndRegeneratesTheSilenceBesideTheNarration', (t) => {
    const dir = remixProject(t, sharedClipSilencedInPlace);
    const refused = remix(dir);
    assertCleanExit(refused, EXIT.USAGE, 'the shared clip must be refused first: ');
    assert.match(refused.all, /copy segment_02\.mp3 under a name remix does not write/, refused.all);

    // The advice, followed: a copy for the narration, its record pointed at it, and the file
    // the silent record names left where it is.
    fs.copyFileSync(path.join(dir, 'segment_02.mp3'), path.join(dir, 'four.mp3'));
    const edited = JSON.parse(readText(dir, 'timing.json'));
    byId(edited).four.audio.file = 'four.mp3';
    fs.writeFileSync(path.join(dir, 'timing.json'), JSON.stringify(edited));
    const narration = readBytes(dir, 'four.mp3');

    const r = remix(dir, ['--apply', '--replace']);

    assertCleanExit(r, EXIT.OK, 'the remedy the refusal names must run: ');
    assert.ok(readBytes(dir, 'four.mp3').equals(narration), 'the narration copy must be byte-identical afterwards');
    assert.ok(narration.equals(CLIPS['segment_02.mp3']), 'and it must be the narration');
    assert.equal(runs(readBytes(dir, 'segment_02.mp3')), runs(frames(30)), 'two\'s clip is regenerated as 720 ms of silence');
    assert.deepEqual(windows(JSON.parse(readText(dir, 'timing.json'))),
      { one: [360, 1320], two: [1320, 2040], intermission: [2040, 3000], four: [3000, 3720] });
  });

  // A silent window field that is not a number is named with the bound that leaves a positive
  // window, and with any other field that must change too; remix is named after those edits.
  // That is a remedy only if, with exactly those edits made, remix runs.
  for (const [scenario, bad, edit, named] of [
    ['StartNotANumberWithAnEndOfZero', { startMs: 'oops', endMs: 0 }, { startMs: 2592, endMs: 4512 },
      /startMs is a string \(4 characters\) — write it as a number of milliseconds, >= 0\. endMs \(0\) must change too: [^\n]*write endMs as a number of milliseconds greater than startMs\. Once both are corrected, if that changes the window's length, remix\.mjs \(S4\) reflows the timeline onto it/],
    ['EndNotANumber', { endMs: 'oops' }, { endMs: 4512 },
      /endMs is a string \(4 characters\) — write it as a number of milliseconds, >= 0 and greater than startMs \(2592\)\. If that changes the window's length, remix\.mjs \(S4\) reflows the timeline onto it/],
  ]) {
    test(`remix_silentWindow${scenario}CorrectedAsTheMessageSays_runsAndRegeneratesTheSilence`, (t) => {
      const dir = remixProject(t, (s) => { Object.assign(s[2], bad); });

      const message = runScript('write-chapters.mjs', ['--list'], dir);

      assertCleanExit(message, EXIT.FAILED, 'a window that is not a number must fail: ');
      assert.match(message.all, named, message.all);
      assert.doesNotMatch(message.all, /voice\.mjs/, message.all);

      // Exactly the edits the message names, with values that meet its bounds.
      const edited = JSON.parse(readText(dir, 'timing.json'));
      Object.assign(byId(edited).intermission, edit);
      fs.writeFileSync(path.join(dir, 'timing.json'), JSON.stringify(edited));

      const r = remix(dir);

      assertCleanExit(r, EXIT.OK, 'the remedy the message names must run: ');
      assert.equal(runs(readBytes(dir, 'segment_03.mp3')), runs(frames(80)), 'the intermission is regenerated as 1920 ms of silence');
      assert.deepEqual({ ...byId(JSON.parse(readText(dir, 'timing.json'))).intermission.audio },
        { file: 'segment_03.mp3', durationMs: 1920, headMs: 0, tailMs: 0, words: [] });
    });
  }

  test('remix_sharedClipThatIsNotInTheProject_doesNotAdviseCopyingIt', (t) => {
    // With no file at that name there is no narration to copy, so the copy remedy would fail.
    const dir = remixProject(t, sharedClipSilencedInPlace);
    fs.rmSync(path.join(dir, 'segment_02.mp3'));
    const before = snapshot(dir);

    const r = remix(dir, []);

    assertCleanExit(r, EXIT.USAGE);
    assert.match(r.all, /narrated segment "four"'s record names that file, which is not in the project/, r.all);
    assert.doesNotMatch(r.all, /copy segment_02\.mp3/, r.all);
    assert.match(r.all, /run voice\.mjs \(S3\)/, 'the voice stage can synthesise the missing narration');
    // "two"'s record names the missing file too, so restoring four's narration elsewhere is not enough.
    assert.match(r.all, /remix would still refuse this timeline: segment_02\.mp3 is not in the project/, r.all);
    assert.deepEqual(snapshot(dir), before, 'nothing may be written');
  });

  test('remix_sharedClipCopyRemedyWhereRemixWouldStillRefuse_saysWhyInsteadOfSendingThere', (t) => {
    const dir = remixProject(t, sharedClipSilencedInPlace);
    fs.rmSync(path.join(dir, 'segment_01.mp3'));

    const r = remix(dir, []);

    assertCleanExit(r, EXIT.USAGE);
    assert.match(r.all, /Even then, remix would refuse this timeline: segment_01\.mp3 is not in the project/, r.all);
    assert.match(r.all, /copy segment_02\.mp3 under a name remix does not write/, r.all);
    assert.doesNotMatch(r.all, /then run remix/i, `a run that would be refused is not a next step\n${r.all}`);
  });

  test('remix_entirelySilentTimelineWhoseDurationIsNotANumber_isMeasuredByTheRemixTheWritersName', (t) => {
    // Every segment silent: voice.mjs has no narration to synthesise, so a duration that is
    // not a number is sent to remix, which generates the silence and measures the timeline.
    const dir = remixProject(t, (s) => {
      for (const seg of s) {
        seg.voiceoverText = '';
        seg.silence = { caption: '[music]' };
        seg.audio.words = [];
      }
    });
    const edited = JSON.parse(readText(dir, 'timing.json'));
    edited.durationMs = 'unknown';
    fs.writeFileSync(path.join(dir, 'timing.json'), JSON.stringify(edited));

    const named = runScript('write-chapters.mjs', ['--list'], dir);
    assertCleanExit(named, EXIT.FAILED, 'a duration that is not a number must fail: ');
    assert.match(named.all, /every segment is declared silent, so there is no narration to measure: run remix\.mjs \(S4\)/, named.all);
    assert.doesNotMatch(named.all, /voice\.mjs/, named.all);

    const r = remix(dir);

    assertCleanExit(r, EXIT.OK, 'the remedy the writers name must run: ');
    const timing = JSON.parse(readText(dir, 'timing.json'));
    assert.equal(typeof timing.durationMs, 'number', 'remix measured the duration');
    assert.ok(timing.durationMs >= timing.segments.at(-1).endMs, 'no shorter than the last window');
    assertCleanExit(runScript('write-chapters.mjs', ['--list'], dir), EXIT.OK, 'and the writers then accept the timeline: ');
  });

  test('remix_malformedDeclarationBesideUnvoicedNarration_reportsTheDeclarationFirst', (t) => {
    // remix checks every declaration first, and refuses a malformed one before writing anything.
    // Reporting the unvoiced segment first sent the author to voice.mjs, which, once its own
    // earlier checks pass, refuses the same declaration (exit 2).
    const dir = remixProject(t, (s) => { s[0].audio.words = []; s[2].silence = false; });

    for (const args of [[], ['--apply', '--replace']]) {
      const r = remix(dir, args);

      assertCleanExit(r, EXIT.USAGE);
      assert.match(r.all, /segment "intermission" declares `silence` as false/, r.all);
      assert.doesNotMatch(r.all, /segment "one" is narrated/, r.all);
    }
  });

  test('remix_unvoicedNarrationWithNoTextToSynthesise_saysWhyTheVoiceStageWouldRefuse', (t) => {
    const dir = remixProject(t, (s) => { delete s[2].silence; }); // its voiceoverText stays ''

    const r = remix(dir, []);

    assertCleanExit(r, EXIT.USAGE);
    assert.match(r.all, /segment "intermission" is narrated, but its audio record holds an empty word list/, r.all);
    assert.match(r.all, /refuses this timeline as it stands: segment "intermission" is narrated but has no narration text/, r.all);
    assert.doesNotMatch(r.all, /run voice\.mjs/, r.all);
  });

  test('remix_unvoicedSegmentWithNoNarrationText_planAndApplySayWhyTheVoiceStageWouldRefuse', (t) => {
    const dir = remixProject(t, (s) => { delete s[3].audio; s[3].voiceoverText = ''; });
    const before = snapshot(dir);

    const plan = remix(dir, []);

    assertCleanExit(plan, EXIT.OK, 'the plan must succeed: ');
    assert.match(plan.all, /not voiced yet[^\n]*: four$/m, plan.all);
    assert.match(plan.all, /^\s+voice\.mjs \(S3\) refuses this timeline as it stands: segment "four" is narrated but has no narration text/m, plan.all);

    const apply = remix(dir);

    assertCleanExit(apply, EXIT.USAGE);
    assert.match(apply.all,
      /segment "four" has no audio\.file[^\n]*voice\.mjs \(S3\) refuses this timeline as it stands: segment "four" is narrated but has no narration text/, apply.all);
    assert.deepEqual(snapshot(dir), before, 'neither the plan nor the refused run writes anything');
  });

  test('remix_applyWhoseVoiceTrackDriftsWhereTheVoiceStageWouldRefuse_saysWhyRatherThanSendingThere', (t) => {
    const dir = remixProject(t, (s) => { s[0].audio.durationMs = 9000; s[1].voiceoverText = ''; }, sentinels);
    const before = snapshot(dir);

    const r = remix(dir);

    assertCleanExit(r, EXIT.FAILED);
    assert.match(r.all, /C-6 voice drift 8040ms/, r.all);
    assert.match(r.all, /refuses this timeline as it stands: segment "two" is narrated but has no narration text/, r.all);
    assert.doesNotMatch(r.all, /run voice\.mjs/, r.all);
    assert.deepEqual(snapshot(dir), before, 'a run that fails C-6 publishes nothing');
  });
});
