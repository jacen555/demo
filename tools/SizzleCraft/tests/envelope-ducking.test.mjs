/*
 * Two features, one dependency chain.
 *
 * 1. `vo-envelope.json` had NO BINDING to the audio it describes. A measured case:
 *    envelope durationMs 291984, timeline durationMs 276528 — 15,456 ms of drift from a
 *    cut two rounds old, and the file parsed fine. Ducking calibrated against it would be
 *    progressively misaligned with no signal at all.
 *
 * 2. Ducking for FILE-SOURCED music did not exist. `musicInGapsDb` was a knob with no
 *    effect for any project using a licensed track, and the calibration that makes it
 *    have one is read OFF the envelope — so a stale envelope silently mis-calibrates the
 *    duck. That is why (1) gates (2), and why both live in one suite.
 *
 * The property under test throughout is NOT "the numbers are right". It is:
 *
 *   an envelope that does not describe the audio in play STOPS THE RUN, naming what
 *   differs and nothing it cannot prove; and every value the duck puts into the filter
 *   graph is declared, so the gain pin covers it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { EXIT, CliError, resolveEngineOutput } from '../src/cli-support.mjs';
import { createMixAudit, MIX_PARAMETERS } from '../src/mix-parameters.mjs';
import {
  SPEECH_RMS_THRESHOLD,
  SIDECHAIN_THRESHOLD_MIN,
  REFERENCE_ATTACK_MS,
  REFERENCE_RELEASE_MS,
  REFERENCE_DUCK_GAIN,
  duckGainTrajectory,
  recoveryShortfallDb,
  timeToWithinDb,
  measureSpeech,
  calibrateDuckThreshold,
  classifyEnvelopeLineage,
  describeEnvelopeRefusal,
  publishBedDuckRecord,
  isOpenedAt,
  openedAtState,
} from '../src/envelope-ducking.mjs';
import {
  makeProject, makeOutsideDir, runScript, assertCleanExit, tryMakeFileLink, pcmWav, plantOnMarker, MISSING_FFMPEG,
  FAKE_AUDIO, refuseUnlink, failClose, tryMakeDirLink, removeFixture, fixtureUrl,
} from './_helpers.mjs';
import { frames, VOICED_LEVEL } from './fixtures/fake-audio-backends.mjs';

// --------------------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------------------

const VOICE_BYTES = Buffer.from('a fake narration track — only its bytes matter here');
const VOICE_SHA = crypto.createHash('sha256').update(VOICE_BYTES).digest('hex');

const sha256Of = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** An envelope bound to VOICE_BYTES, in 20 ms hops. Defaults to two phrases with a gap between them. */
function boundEnvelope({ rms = speechGapSpeech(), file = 'voiceover.mp3', sha256 = VOICE_SHA } = {}) {
  return JSON.stringify({
    durationMs: rms.length * 20,
    hopMs: 20,
    rms,
    measuredFrom: { file, bytes: VOICE_BYTES.length, sha256 },
  });
}

/** `ms` of narration at a realistic level, in 20 ms hops. */
const voiced = (ms, level = 0.09) => Array.from({ length: ms / 20 }, () => level);
/** `ms` at digital-silence level, in 20 ms hops. */
const quiet = (ms) => Array.from({ length: ms / 20 }, () => 0.0001);

/** 2 s of speech at a realistic level, then 2 s of silence that nothing follows. */
function speechThenGap(speechMs = 2000, gapMs = 2000, level = 0.09) {
  return [...voiced(speechMs, level), ...quiet(gapMs)];
}

/** Two 1 s phrases with a 2 s gap BETWEEN them — the shape the bed has to recover in. */
function speechGapSpeech() {
  return [...voiced(1000), ...quiet(2000), ...voiced(1000)];
}

/** A project remux-music can PLAN in: stub media, a timeline, no real ffmpeg needed. */
function remuxProject(t, extra = {}) {
  return makeProject(t, {
    'render.mp4': 'stub video',
    'voiceover.mp3': VOICE_BYTES,
    'music.wav': 'stub licensed master',
    'timing.json': JSON.stringify({ project: { fps: 30 }, durationMs: 4000 }),
    ...extra,
  });
}

const PLAN_ARGS = ['--video', 'render.mp4', '--out', 'out.mp4', '--ffmpeg', MISSING_FFMPEG];

// --------------------------------------------------------------------------------------
// R1..R4 — the envelope is bound to its input, and absent/stale/unreadable stay distinct
// --------------------------------------------------------------------------------------

describe('vo-envelope lineage binding', () => {
  // THE FINGERPRINT IS OVER THE INPUT. The envelope is derived from the voice audio, so
  // the voice audio is what it is bound to — not the envelope's own bytes. A fingerprint
  // over the output would certify only that nobody edited the artefact, which is
  // self-consistency, not lineage (see cli-support.timingSeal, which says so about
  // itself). It would also weld lineage to the deliverable: restoring the audio that
  // produced a shipped render could no longer restore a valid envelope.
  test('classifyEnvelopeLineage_envelopeMeasuredFromTheVoiceOnDisk_isCurrent', () => {
    const verdict = classifyEnvelopeLineage(JSON.parse(boundEnvelope()), {
      file: 'voiceover.mp3',
      bytes: VOICE_BYTES.length,
      sha256: VOICE_SHA,
    });

    assert.equal(verdict.state, 'current');
    assert.deepEqual(verdict.differences, []);
  });

  test('classifyEnvelopeLineage_voiceRegeneratedAfterTheEnvelope_isStaleAndNamesTheField', () => {
    const verdict = classifyEnvelopeLineage(JSON.parse(boundEnvelope()), {
      file: 'voiceover.mp3',
      bytes: VOICE_BYTES.length + 4096,
      sha256: 'f'.repeat(64),
    });

    assert.equal(verdict.state, 'stale');
    assert.deepEqual(
      verdict.differences.map((d) => d.field).sort(),
      ['bytes', 'sha256'],
      'the refusal must be able to name every field that differs, not just the first',
    );
  });

  // ABSENCE MUST NOT READ AS PERMISSION. An envelope written before this guard existed
  // carries no binding, and "no binding" is not "binding matches" — treating it as
  // permission is the exact shape of the defect, one layer up.
  test('classifyEnvelopeLineage_envelopeWithNoBindingAtAll_isUnboundNotCurrent', () => {
    const verdict = classifyEnvelopeLineage({ durationMs: 100, hopMs: 20, rms: [0.1] }, {
      file: 'voiceover.mp3',
      bytes: VOICE_BYTES.length,
      sha256: VOICE_SHA,
    });

    assert.equal(verdict.state, 'unbound', 'a missing binding must be its own state');
    assert.notEqual(verdict.state, 'current');
  });

  test('classifyEnvelopeLineage_bindingPresentButMalformed_isUnreadableNotUnbound', () => {
    for (const measuredFrom of [null, 'voiceover.mp3', { file: 'voiceover.mp3' }, { sha256: 12 }]) {
      const verdict = classifyEnvelopeLineage({ rms: [0.1], measuredFrom }, {
        file: 'voiceover.mp3',
        bytes: 1,
        sha256: VOICE_SHA,
      });
      assert.equal(
        verdict.state,
        'unreadable',
        `a binding that is present but cannot be read is not an absent one: ${JSON.stringify(measuredFrom)}`,
      );
    }
  });

  // THE REFUSAL MAY NOT NAME A CAUSE IT CANNOT PROVE. "The voiceover was regenerated on
  // the 26th" is a story about a mtime; nothing here can know who wrote either file or
  // when. Naming an unprovable cause is an error this codebase has already made.
  test('describeEnvelopeRefusal_staleEnvelope_namesTheDifferenceAndNotTheCause', () => {
    const verdict = classifyEnvelopeLineage(JSON.parse(boundEnvelope()), {
      file: 'voiceover.mp3',
      bytes: 999,
      sha256: 'f'.repeat(64),
    });
    const text = describeEnvelopeRefusal(verdict, {
      envelopePath: 'vo-envelope.json',
      voicePath: 'voiceover.mp3',
    });

    assert.match(text, /vo-envelope\.json/);
    assert.match(text, /sha256/, 'it must name the field that differs');
    assert.match(text, /vo-envelope\.mjs .*--apply .*--replace/, 'and tell the operator the command to run');
    assert.doesNotMatch(
      text,
      /regenerat(ed|ion)\b|\bwrote\b|\bwritten by\b|\bre-?ran\b|\byesterday\b|\bmtime\b|\bmodified at\b/i,
      'the refusal must not assert who changed the file or when — it cannot know',
    );
  });

  test('describeEnvelopeRefusal_eachState_producesADistinctMessage', () => {
    const fingerprint = { file: 'voiceover.mp3', bytes: 1, sha256: VOICE_SHA };
    const messages = [
      classifyEnvelopeLineage({ rms: [0.1] }, fingerprint),
      classifyEnvelopeLineage({ rms: [0.1], measuredFrom: null }, fingerprint),
      classifyEnvelopeLineage(JSON.parse(boundEnvelope()), { ...fingerprint, sha256: 'e'.repeat(64) }),
    ].map((v) => describeEnvelopeRefusal(v, { envelopePath: 'e.json', voicePath: 'v.mp3' }));

    assert.equal(new Set(messages).size, 3, 'absent, unreadable and stale must not share a message');
  });
});

describe('vo-envelope writes the binding', () => {
  test('voEnvelope_planWithNoEnvelopeYet_writesNothingAndSaysSo', (t) => {
    const dir = makeProject(t, { 'voiceover.mp3': VOICE_BYTES });
    const r = runScript('vo-envelope.mjs', [], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.equal(fs.existsSync(path.join(dir, 'vo-envelope.json')), false, 'a plan must write nothing');
    assert.match(r.all, /nothing was written/);
  });

  // The plan is where an operator finds out the envelope on disk no longer describes the
  // narration — before the stage that consumes it refuses.
  test('voEnvelope_planWithAStaleEnvelopeOnDisk_reportsItAsStale', (t) => {
    const dir = makeProject(t, {
      'voiceover.mp3': VOICE_BYTES,
      'vo-envelope.json': boundEnvelope({ sha256: 'a'.repeat(64) }),
    });
    const r = runScript('vo-envelope.mjs', [], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(r.all, /STALE/i, 'the plan must say the existing envelope no longer matches the voice');
  });

  test('voEnvelope_planWithACurrentEnvelopeOnDisk_reportsItAsCurrent', (t) => {
    const dir = makeProject(t, {
      'voiceover.mp3': VOICE_BYTES,
      'vo-envelope.json': boundEnvelope(),
    });
    const r = runScript('vo-envelope.mjs', [], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(r.all, /current/i);
  });
});

// --------------------------------------------------------------------------------------
// R2/R5 — every consumer refuses a stale envelope rather than using it
// --------------------------------------------------------------------------------------

describe('consumers refuse a stale envelope', () => {
  test('makeMusic_envelopeNotMeasuredFromTheVoiceOnDisk_refusesWithoutWritingABed', (t) => {
    const dir = makeProject(t, {
      'voiceover.mp3': VOICE_BYTES,
      'env.json': boundEnvelope({ sha256: 'b'.repeat(64) }),
    });
    const r = runScript(
      'make-music.mjs',
      ['--out', 'bed.wav', '--seconds', '2', '--envelope', 'env.json', '--apply'],
      dir,
    );

    assertCleanExit(r, EXIT.USAGE, 'a stale envelope must not be ducked against: ');
    assert.equal(fs.existsSync(path.join(dir, 'bed.wav')), false, 'and no bed may be written');
    assert.match(r.all, /sha256/i);
  });

  test('makeMusic_envelopeWithNoBinding_refusesRatherThanTreatingAbsenceAsPermission', (t) => {
    const dir = makeProject(t, {
      'voiceover.mp3': VOICE_BYTES,
      'env.json': JSON.stringify({ rms: [0.2, 0.001], hopMs: 20, durationMs: 40 }),
    });
    const r = runScript(
      'make-music.mjs',
      ['--out', 'bed.wav', '--seconds', '2', '--envelope', 'env.json', '--apply'],
      dir,
    );

    assertCleanExit(r, EXIT.USAGE, 'an unbound envelope must be refused: ');
    assert.equal(fs.existsSync(path.join(dir, 'bed.wav')), false);
  });

  test('remuxMusic_duckingAgainstAStaleEnvelope_refusesRatherThanMiscalibrating', (t) => {
    const dir = remuxProject(t, { 'vo-envelope.json': boundEnvelope({ sha256: 'c'.repeat(64) }) });
    const r = runScript(
      'remux-music.mjs',
      [...PLAN_ARGS, '--duck-db', '11', '--duck-envelope', 'vo-envelope.json'],
      dir,
    );

    assertCleanExit(r, EXIT.FAILED, 'a stale envelope must stop the run, not calibrate the duck: ');
    assert.match(r.all, /sha256/i);
  });

  test('remuxMusic_duckDbWithNoEnvelope_refusesBecauseItCannotCalibrate', (t) => {
    const dir = remuxProject(t);
    const r = runScript('remux-music.mjs', [...PLAN_ARGS, '--duck-db', '11'], dir);

    assertCleanExit(r, EXIT.USAGE, 'ducking without a calibration input must be refused: ');
    assert.match(r.all, /--duck-envelope/);
  });
});

// --------------------------------------------------------------------------------------
// R7/R8 — the gain trajectory, and the tolerance that must not be discovered later
// --------------------------------------------------------------------------------------

describe('duck gain trajectory', () => {
  // ONE BEHAVIOUR, NOT TWO. make-music bakes its duck into the synthesised bed and
  // remux-music asks ffmpeg to do it in-graph. Both are described by this one function,
  // at the reference constants, so the two paths cannot drift into different ducks.
  test('duckGainTrajectory_atTheReferenceConstants_reproducesTheSynthesisedBedCurve', () => {
    const rms = [0.2, 0.2, 0.2, 0.001, 0.001, 0.001];
    const got = duckGainTrajectory({
      rms,
      hopMs: 20,
      duckGain: REFERENCE_DUCK_GAIN,
      attackMs: REFERENCE_ATTACK_MS,
      releaseMs: REFERENCE_RELEASE_MS,
      threshold: SPEECH_RMS_THRESHOLD,
    });

    // The literal loop make-music.mjs shipped, kept here as the oracle.
    const atk = Math.exp(-20 / 150);
    const rel = Math.exp(-20 / 800);
    const want = [];
    let cur = 1;
    for (const v of rms) {
      const target = v > 0.004 ? REFERENCE_DUCK_GAIN : 1.0;
      cur = target + (cur - target) * (target < cur ? atk : rel);
      want.push(cur);
    }

    assert.deepEqual([...got], want, 'the shared model must be the reference loop, exactly');
  });

  // THE TOLERANCE IS THE DELIVERABLE, NOT THE CONSTANT. With a one-pole release the bed
  // APPROACHES the gaps level asymptotically — it never arrives. So the honest question
  // is how far short it is when narration resumes, and that number has to be computed,
  // asserted, and printed rather than left to be discovered in a render.
  test('recoveryShortfallDb_defaultReleaseAcrossAMeasuredGap_isUnderOneDecibel', () => {
    // 1.83 s is the consuming project's measured inter-segment gap.
    const shortfall = recoveryShortfallDb({ duckDb: 11, releaseMs: 800, gapMs: 1830 });

    assert.ok(shortfall > 0, 'a one-pole release never actually arrives — the shortfall is never zero');
    assert.ok(
      Math.abs(shortfall - 0.66) < 0.02,
      `expected ~0.66 dB short of the gaps level at the end of a 1.83 s gap, got ${shortfall.toFixed(3)}`,
    );
  });

  test('recoveryShortfallDb_longerGap_isAlwaysCloserToTheTarget', () => {
    const at = (gapMs) => recoveryShortfallDb({ duckDb: 11, releaseMs: 800, gapMs });

    assert.ok(at(3000) < at(1830), 'a longer gap must land closer');
    assert.ok(at(1830) < at(500), 'and a shorter one further away');
  });

  test('timeToWithinDb_defaultRelease_reachesOneDecibelOfTargetInsideAMeasuredGap', () => {
    const ms = timeToWithinDb({ duckDb: 11, releaseMs: 800, withinDb: 1 });

    assert.ok(ms < 1830, `1 dB of the gaps level must be reached inside a 1.83 s gap, took ${ms.toFixed(0)} ms`);
    assert.ok(Math.abs(ms - 1511) < 15, `expected ~1511 ms, got ${ms.toFixed(0)}`);
  });

  // A DUCK SHALLOWER THAN THE TOLERANCE NEVER LEAVES IT. Asked how long the bed takes to
  // rise to within 0.1 dB of a level it never dropped 0.1 dB below, the formula answered
  // with a NEGATIVE time, and the plan printed it as a settle time. The answer is zero.
  test('timeToWithinDb_duckShallowerThanTheTolerance_isZeroRatherThanNegative', () => {
    const ms = timeToWithinDb({ duckDb: 0.05, releaseMs: 800, withinDb: 0.1 });

    assert.equal(ms, 0, `a bed that never left the tolerance is within it at once, got ${ms} ms`);
  });

  // A SHORTER RELEASE IS THE OTHER RESOLUTION, AND IT MUST ACTUALLY WORK. The knob exists
  // so an operator who wants the target reached inside a real gap can have it; this pins
  // that the knob does what the help says.
  test('recoveryShortfallDb_shortenedRelease_reachesTheTargetWithinTheSameGap', () => {
    assert.ok(recoveryShortfallDb({ duckDb: 11, releaseMs: 400, gapMs: 1830 }) < 0.1);
  });

  // SILENT SEGMENTS — intro slides, intermissions. Sustained silence must let the bed ride
  // UP to the gaps level and STAY there. Any hold or hysteresis added to stop word-gap
  // pumping is the same mechanism at a different timescale, so this asserts that nothing
  // caps how long the excursion may last.
  test('duckGainTrajectory_multiSecondSilence_reachesTheGapsLevelAndHoldsIt', () => {
    const rms = [
      ...Array.from({ length: 50 }, () => 0.09), // 1 s of speech
      ...Array.from({ length: 500 }, () => 0.0001), // 10 s of silence — an intermission
    ];
    const g = duckGainTrajectory({
      rms,
      hopMs: 20,
      duckGain: 10 ** (-11 / 20),
      attackMs: 150,
      releaseMs: 800,
      threshold: SPEECH_RMS_THRESHOLD,
    });

    const atFourSeconds = g[50 + 200];
    const atTheEnd = g[g.length - 1];

    assert.ok(
      20 * Math.log10(atFourSeconds) > -0.1,
      `4 s into a silent segment the bed must be at the gaps level, was ${(20 * Math.log10(atFourSeconds)).toFixed(3)} dB under`,
    );
    assert.ok(atTheEnd >= atFourSeconds, 'and it must STAY there — nothing may cap the excursion length');
    assert.ok(20 * Math.log10(atTheEnd) > -0.01);
  });
});

// --------------------------------------------------------------------------------------
// Calibration read off the envelope
// --------------------------------------------------------------------------------------

describe('duck calibration', () => {
  test('measureSpeech_envelopeWithSpeechAndGaps_separatesThemAtTheReferenceThreshold', () => {
    const m = measureSpeech({ rms: speechGapSpeech(), hopMs: 20, threshold: SPEECH_RMS_THRESHOLD });

    assert.equal(m.speechFrames, 100, '2 s of speech at 20 ms hops');
    assert.ok(Math.abs(m.speechRms - 0.09) < 1e-9);
    assert.equal(m.gaps.count, 1);
    assert.equal(m.gaps.longestMs, 2000);
  });

  // THE LEAD-IN AND THE TAIL ARE NOT GAPS. A gap is where the bed recovers BETWEEN two
  // phrases and has to be back down when the next one starts. Silence before the first
  // word has no duck to recover from, and silence after the last has no phrase to be
  // ready for — so counting either made NO GAP impossible on any project with a lead-in,
  // and let an intro or an outro drag the median.
  test('measureSpeech_silenceBeforeTheFirstWordAndAfterTheLast_isNotCountedAsAGap', () => {
    const m = measureSpeech({ rms: [...quiet(2000), ...voiced(3000), ...quiet(1500)], hopMs: 20 });

    assert.equal(m.gaps.count, 0, 'a lead-in and a tail are not gaps between speech');
    assert.equal(m.gaps.medianMs, null);
    assert.equal(m.gaps.longestMs, null);
  });

  test('measureSpeech_internalGapsBetweenALeadInAndATail_medianIsOverTheInternalGapsOnly', () => {
    const rms = [
      ...quiet(3000), // lead-in
      ...voiced(1000), ...quiet(600),
      ...voiced(1000), ...quiet(800),
      ...voiced(1000), ...quiet(1000),
      ...voiced(1000),
      ...quiet(5000), // tail
    ];

    const m = measureSpeech({ rms, hopMs: 20 });

    assert.equal(m.gaps.count, 3, 'three gaps between four phrases');
    assert.equal(m.gaps.medianMs, 800, 'the median of 600, 800 and 1000');
    assert.equal(m.gaps.longestMs, 1000, 'the 5 s tail is not the longest gap — it is not a gap');
  });

  test('measureSpeech_envelopeWithNoFrameAboveThreshold_reportsNoSpeechRatherThanZeroLevel', () => {
    const m = measureSpeech({ rms: [0.0001, 0.0001], hopMs: 20, threshold: SPEECH_RMS_THRESHOLD });

    assert.equal(m.speechFrames, 0);
    assert.equal(m.speechRms, null, 'an absent measurement must not be reported as a level of zero');
  });

  // The threshold is solved so the compressor's gain reduction lands ON the requested
  // depth at the measured speech level, rather than being a constant hoped to land near
  // it. GR = (L - T) * (1 - 1/ratio), so T = L - depth / (1 - 1/ratio).
  test('calibrateDuckThreshold_solvedThreshold_yieldsTheRequestedDepthAtTheMeasuredLevel', () => {
    const speechRms = 0.09;
    const voiceGain = 1.4;
    const ratio = 4;
    const threshold = calibrateDuckThreshold({ speechRms, voiceGain, duckDb: 11, ratio });

    const levelDb = 20 * Math.log10(speechRms * voiceGain);
    const thresholdDb = 20 * Math.log10(threshold);
    const gainReduction = (levelDb - thresholdDb) * (1 - 1 / ratio);

    assert.ok(
      Math.abs(gainReduction - 11) < 0.05,
      `the solved threshold must produce 11 dB of duck, produced ${gainReduction.toFixed(3)}`,
    );
  });

  // A DEPTH THE THRESHOLD FLOOR CANNOT DELIVER IS REFUSED, NOT DELIVERED AS SOMETHING
  // ELSE. ffmpeg takes no sidechaincompress threshold below 0.000976563, so a solve that
  // landed under it used to be clamped there in silence: the bed ducked by whatever the
  // floor allowed, while the pin recorded the depth that had been asked for.
  //   20 dB at ratio 1.5, narration 0.1 x voice gain 1.4 -> at most 14.37 dB.
  test('calibrateDuckThreshold_depthDeeperThanTheThresholdFloorAllows_refusesNamingTheReachableMaximum', () => {
    assert.throws(
      () => calibrateDuckThreshold({ speechRms: 0.1, voiceGain: 1.4, duckDb: 20, ratio: 1.5 }),
      (err) => {
        assert.ok(err instanceof CliError, `expected a refusal, got ${err}`);
        assert.equal(err.exitCode, EXIT.USAGE, 'the operator fixes this by changing a parameter');
        assert.match(err.message, /unreachable at ratio 1\.5 for this narration: max 14\.37 dB/);
        assert.match(err.message, /Raise --duck-ratio or lower --duck-db/);
        return true;
      },
    );
  });

  // Was `..._clampsRatherThanEmittingAnIllegalValue`. The clamp kept the value legal for
  // ffmpeg and made the delivered depth a number nobody asked for; the refusal keeps both.
  test('calibrateDuckThreshold_narrationBelowTheThresholdFloor_refusesRatherThanClamping', () => {
    assert.throws(
      () => calibrateDuckThreshold({ speechRms: 0.0005, voiceGain: 1, duckDb: 40, ratio: 2 }),
      (err) => err instanceof CliError && err.exitCode === EXIT.USAGE && /max 0\.00 dB/.test(err.message),
      'narration below the floor cannot be ducked at any depth, and the refusal must say so',
    );
  });

  // The tolerance is 0.1 dB either side: a request the floor misses by less than that is
  // delivered to within rounding and must not be refused; one it misses by more is.
  test('calibrateDuckThreshold_depthWithinATenthOfADecibelOfTheFloor_isStillSolved', () => {
    const args = { speechRms: 0.1, voiceGain: 1.4, ratio: 1.5 };

    assert.equal(calibrateDuckThreshold({ ...args, duckDb: 14.45 }), SIDECHAIN_THRESHOLD_MIN, '0.08 dB short is delivered');
    assert.throws(() => calibrateDuckThreshold({ ...args, duckDb: 14.5 }), CliError, '0.13 dB short is refused');
  });

  // THE MIRROR CASE. A threshold solved above full scale is clamped to 1, and the bed then
  // ducks DEEPER than asked — the same defect, pointing the other way.
  test('calibrateDuckThreshold_depthShallowerThanTheThresholdCeilingAllows_refusesNamingTheMinimum', () => {
    const speechRms = 0.9;
    const voiceGain = 8;
    const ratio = 4;
    const minimum = 20 * Math.log10(speechRms * voiceGain) * (1 - 1 / ratio);

    assert.throws(
      () => calibrateDuckThreshold({ speechRms, voiceGain, duckDb: 1, ratio }),
      (err) =>
        err instanceof CliError &&
        err.exitCode === EXIT.USAGE &&
        err.message.includes(`min ${minimum.toFixed(2)} dB`),
      'a depth the ceiling cannot deliver must be refused, not delivered deeper',
    );
  });
});

// --------------------------------------------------------------------------------------
// R6/R9 — the graph, and the registry that refuses an undeclared value in it
// --------------------------------------------------------------------------------------

describe('ducking reaches the filter graph under the registry', () => {
  // duckDb is PINNED AS THE dB THE OPERATOR TYPED AND RENDERED AS THE SOLVED THRESHOLD —
  // the `--ceiling` shape exactly. Pinning the derived threshold instead would make the
  // pin churn on every narration re-run (the threshold is solved against the measured
  // speech level), and a confirmation that fires constantly stops being a confirmation.
  // What the operator agreed to is "11 dB under speech", and that is what is recorded.
  test('MIX_PARAMETERS_everyDuckValueThatReachesTheGraph_isRegisteredAndPinned', () => {
    const byName = new Map(MIX_PARAMETERS.map((p) => [p.name, p]));

    for (const required of ['duckDb', 'duckRatio', 'duckAttack', 'duckRelease']) {
      assert.ok(byName.has(required), `${required} reaches the filter graph and must be declared`);
      assert.equal(byName.get(required).pinned, true, `${required} moves the delivered bed level`);
    }
  });

  test('declare_duckDb_pinsTheDecibelsAndRendersTheSolvedThreshold', () => {
    const mix = createMixAudit();
    mix.declare('duckDb', { value: 11, rendered: 0.023286 });

    assert.equal(mix.use('duckDb', 'mud'), '0.023286', 'the graph carries the solved threshold');
  });

  // A pinned knob has to be accounted for on EVERY run, including the runs where it is
  // switched off — otherwise "ducking was off" is a fact the pin cannot record, and
  // turning ducking on later moves the delivered mix behind a pin still reporting valid.
  test('declareAbsent_pinnedParameterNotInForce_isRecordedByThePinRatherThanOmitted', () => {
    const mix = createMixAudit();
    mix.declare('voiceGain', { value: 1.4 });
    mix.declare('musicGain', { value: 0.117 });
    mix.declare('ceiling', { value: 2, rendered: 0.794328 });
    mix.declareAbsent('crossfade'); // pinned too, and not in force on a bed that does not loop
    for (const n of ['duckDb', 'duckRatio', 'duckAttack', 'duckRelease']) mix.declareAbsent(n);

    const pinned = mix.pinnedValues();
    assert.equal(pinned.duckDb, 0, 'not-in-force must be recorded as a value the pin can compare');
    assert.ok(Number.isFinite(pinned.duckDb), 'the pin classifier only reads finite numbers');
  });

  test('use_parameterDeclaredAbsent_refusesBecauseItMustNotReachTheGraph', () => {
    const mix = createMixAudit();
    mix.declareAbsent('duckDb');

    assert.throws(
      () => mix.use('duckDb'),
      (err) => err instanceof CliError && err.exitCode === EXIT.FAILED,
      'a knob declared not-in-force cannot then be interpolated into the graph',
    );
  });

  test('audit_sidechainGraphWithAnUndeclaredDuckValue_stopsTheRun', () => {
    const mix = createMixAudit();
    mix.declare('voiceGain', { value: 1.4 });
    mix.declare('musicGain', { value: 0.117 });
    mix.declare('ceiling', { value: 2, rendered: 0.794328 });
    mix.declare('duckDb', { value: 11, rendered: 0.023286 });
    mix.declare('duckRatio', { value: 4 });
    mix.declare('duckAttack', { value: 150 });
    mix.declare('duckRelease', { value: 800 });

    // `knee=2.5` is the smuggled one: a real sidechaincompress option, never declared.
    const graph =
      `[1:a]volume=${mix.use('voiceGain', 'vo')},pan=stereo|c0=c0|c1=c0,${mix.structural('asplit=2')}[vo][vosc];` +
      `[vosc]apad[vop];` +
      `[2:a]asetpts=N/SR/TB,volume=${mix.use('musicGain', 'mu')}[mu];` +
      `[mu][vop]sidechaincompress=threshold=${mix.use('duckDb', 'mud')}:ratio=${mix.use('duckRatio', 'mud')}` +
      `:attack=${mix.use('duckAttack', 'mud')}:release=${mix.use('duckRelease', 'mud')}:knee=2.5[mud];` +
      `[vo][mud]${mix.structural('amix=inputs=2:duration=longest:normalize=0')}[mx];` +
      `[mx]alimiter=limit=${mix.use('ceiling', 'out')}:level=disabled[out]`;

    assert.throws(
      () => mix.audit(graph),
      (err) => err instanceof CliError && /2\.5/.test(err.message),
      'an undeclared sidechaincompress option must stop the run',
    );
  });
});

describe('remux-music ducking plan', () => {
  const DUCK_ARGS = ['--duck-db', '11', '--duck-envelope', 'vo-envelope.json'];

  test('remuxMusic_duckDbWithACurrentEnvelope_putsSidechaincompressInTheAuditedGraph', (t) => {
    const dir = remuxProject(t, { 'vo-envelope.json': boundEnvelope() });
    const r = runScript(
      'remux-music.mjs',
      [...PLAN_ARGS, '--duck-db', '11', '--duck-envelope', 'vo-envelope.json'],
      dir,
    );

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(r.all, /sidechaincompress=/, 'the duck must happen IN the graph');
    assert.match(r.all, /threshold=/);
    assert.equal(fs.existsSync(path.join(dir, 'out.mp4')), false, 'a plan must write nothing');
  });

  // THE DETECTOR LEG IS PADDED, AND bug-ledger 15 SAYS WHY. sidechaincompress ends when
  // EITHER input ends, so narration shorter than the trimmed bed would cut the bed off at
  // the last word for the whole tail — silently. Removing the apad passed the full suite.
  test('remuxMusic_duckingGraph_padsTheSidechainSoTheBedOutlivesTheLastWord', (t) => {
    const dir = remuxProject(t, { 'vo-envelope.json': boundEnvelope() });
    const r = runScript('remux-music.mjs', [...PLAN_ARGS, ...DUCK_ARGS], dir);

    assertCleanExit(r, EXIT.OK);
    assert.match(
      r.all,
      /\[vosc\]apad\[vop\];\[mu\]\[vop\]sidechaincompress=/,
      'the sidechain must be fed from the PADDED voice leg, or the bed stops at the last word',
    );
  });

  // THE TOLERANCE MUST BE STATED WHERE IT IS ACTED ON. Not only in a README nobody reads
  // at 2am — in the plan output, for the release actually in force, measured against the
  // gaps this project actually has.
  test('remuxMusic_duckingPlan_statesTheGapsLevelIsApproachedNotReached', (t) => {
    const dir = remuxProject(t, { 'vo-envelope.json': boundEnvelope() });
    const r = runScript(
      'remux-music.mjs',
      [...PLAN_ARGS, '--duck-db', '11', '--duck-envelope', 'vo-envelope.json'],
      dir,
    );

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(r.all, /APPROACHED|within .* dB/i, 'the plan must state the tolerance, not imply an exact landing');
  });

  // CLAIM ONLY WHAT WAS MEASURED. The plan called the model a "PESSIMISTIC UPPER BOUND"
  // and said sidechaincompress "recovers FASTER" — true of the one release measured at
  // 800 ms, and false at 1500 and 2500 ms, where the measured shortfall was LARGER than
  // modelled. The regex above still passes with the MODELLED label deleted (B-19), so
  // the label and the measurement are pinned here.
  test('remuxMusic_duckingPlan_labelsTheFigureModelledAndClaimsNoBoundInEitherDirection', (t) => {
    const dir = remuxProject(t, { 'vo-envelope.json': boundEnvelope() });
    const r = runScript('remux-music.mjs', [...PLAN_ARGS, ...DUCK_ARGS], dir);

    assertCleanExit(r, EXIT.OK);
    assert.match(r.all, /APPROACHED, NOT REACHED — MODELLED, NOT MEASURED/, 'the figure must be labelled modelled');
    assert.match(r.all, /NOT A BOUND in either direction/, 'and must not be offered as a bound');
    assert.match(r.all, /release {2}800 ms {2}model 0\.67 dB {2}measured 0\.05-0\.12 dB/);
    assert.match(r.all, /release 1500 ms {2}model 2\.09 dB {2}measured 2\.0-3\.5 dB/);
    assert.match(r.all, /release 2500 ms {2}model 3\.70 dB {2}measured 6\.1-8\.7 dB/);
    assert.match(r.all, /Nothing was measured below 800 ms/, 'and must not extend the measurement past its range');
    assert.doesNotMatch(r.all, /UPPER BOUND|PESSIMISTIC|recovers FASTER/i, 'the falsified claims must be gone');
  });

  // A LEAD-IN IS NOT A GAP. Continuous narration after an intro has nowhere for the bed to
  // recover, and the plan has a line for exactly that — which the lead-in used to suppress.
  //
  // AND THE LINE CLAIMS ONLY WHAT WAS COUNTED. It said the bed "never returns to the gaps
  // level anywhere in this video" — but the lead-in starts at that level, the tail returns
  // towards it, and a gap under 500 ms can recover under a fast release. What was counted
  // is no inter-speech gap of 500 ms or more, so no between-phrase recovery is modelled.
  test('remuxMusic_leadInThenContinuousNarration_plansNoGapRatherThanCountingTheLeadIn', (t) => {
    const dir = remuxProject(t, { 'vo-envelope.json': boundEnvelope({ rms: [...quiet(2000), ...voiced(4000)] }) });
    const r = runScript('remux-music.mjs', [...PLAN_ARGS, ...DUCK_ARGS], dir);

    assertCleanExit(r, EXIT.OK);
    const said = r.all.replace(/\s+/g, ' ');
    assert.match(said, /NO GAP of 500 ms or more/, 'continuous narration must be reported as having no gap');
    assert.doesNotMatch(said, /never returns to the gaps level/, 'the lead-in and the tail are at that level');
    assert.doesNotMatch(said, /--music-gain alone does not describe it/, 'which --music-gain does describe');
    assert.match(said, /NO GAP of 500 ms or more BETWEEN PHRASES in this envelope, so no between-phrase recovery is modelled/);
    assert.match(said, /not the lead-in or the tail/, 'and it must say what was not counted');
    assert.match(said, /not any gap under 500 ms, which a fast release may still recover in/);
    assert.doesNotMatch(said, /median gap/, 'and the lead-in must not be reported as one');
  });

  test('remuxMusic_duckShallowerThanTheTolerance_neverPrintsANegativeSettleTime', (t) => {
    const dir = remuxProject(t, { 'vo-envelope.json': boundEnvelope() });
    const r = runScript(
      'remux-music.mjs',
      [...PLAN_ARGS, '--duck-db', '0.05', '--duck-envelope', 'vo-envelope.json'],
      dir,
    );

    assertCleanExit(r, EXIT.OK);
    assert.match(r.all, /within 0\.1 dB after 0\.00s/, 'a duck inside the tolerance settles at once');
    assert.doesNotMatch(r.all, /after -/, 'a negative settle time is not a duration');
  });

  // 40 dB at ratio 4 against narration at 0.09 x the default voice gain 1.14 is past what
  // ffmpeg's threshold floor can deliver. The run used to plan it — and --apply to ship
  // it — at whatever depth the clamp allowed, with the pin recording 40.
  test('remuxMusic_duckDeeperThanTheNarrationAllows_exitsUsageNamingTheMaximum', (t) => {
    const dir = remuxProject(t, { 'vo-envelope.json': boundEnvelope() });
    const maximum =
      (20 * Math.log10(0.09 * 1.14) - 20 * Math.log10(SIDECHAIN_THRESHOLD_MIN)) * (1 - 1 / 4);

    const r = runScript('remux-music.mjs', [...PLAN_ARGS, '--duck-db', '40', '--duck-envelope', 'vo-envelope.json'], dir);

    assertCleanExit(r, EXIT.USAGE, 'an unreachable depth must be refused: ');
    assert.ok(r.all.includes(`max ${maximum.toFixed(2)} dB`), `the refusal must name the reachable maximum\n${r.all}`);
    assert.doesNotMatch(r.all, /would run:/, 'and nothing may be planned at a depth that would not be delivered');
  });

  // hopMs converts frame counts into the gap lengths the plan reports. vo-envelope always
  // writes 20; `Number(hopMs) || 20` let a hand-edited -20 report NO GAP, let 1e9 report
  // gaps of eleven days, and quietly read 0, "20" and an absent field as 20.
  for (const [label, hopMs] of [
    ['negative', -20],
    ['huge', 1e9],
    ['zero', 0],
    ['aString', '20'],
    ['absent', undefined],
  ]) {
    test(`remuxMusic_envelopeHopMs_${label}_isRefusedAsAMalformedEnvelope`, (t) => {
      const envelope = JSON.parse(boundEnvelope());
      if (hopMs === undefined) delete envelope.hopMs;
      else envelope.hopMs = hopMs;
      const dir = remuxProject(t, { 'vo-envelope.json': JSON.stringify(envelope) });

      const r = runScript('remux-music.mjs', [...PLAN_ARGS, ...DUCK_ARGS], dir);

      assertCleanExit(r, EXIT.FAILED, 'a malformed envelope is a failed input, not a usage error: ');
      assert.match(r.all, /"hopMs"/, 'the refusal must name the field');
    });
  }

  // A DUCK KNOB WITHOUT --duck-db WAS SILENTLY IGNORED, and never range-checked: --duck-ratio
  // 999 planned at exit 0. --duck-db without --duck-envelope is refused; the other
  // direction has to be too, or an operator who forgot --duck-db believes the bed is ducked.
  for (const [flag, value] of [
    ['--duck-envelope', 'vo-envelope.json'],
    ['--duck-ratio', '999'],
    ['--duck-attack', '5'],
    ['--duck-release', '800'],
  ]) {
    const name = flag.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase());
    test(`remuxMusic_${name}WithoutDuckDb_isRefusedRatherThanIgnored`, (t) => {
      const dir = remuxProject(t, { 'vo-envelope.json': boundEnvelope() });

      const r = runScript('remux-music.mjs', [...PLAN_ARGS, flag, value], dir);

      assertCleanExit(r, EXIT.USAGE, `${flag} without --duck-db must be refused: `);
      assert.ok(r.all.includes(flag), `the refusal must name ${flag}\n${r.all}`);
      assert.match(r.all, /--duck-db/, 'and the flag that switches ducking on');
    });
  }

  test('remuxMusic_duckOptionWithDuckDbZero_isRefusedBecauseDuckingIsOff', (t) => {
    const dir = remuxProject(t, { 'vo-envelope.json': boundEnvelope() });

    const r = runScript('remux-music.mjs', [...PLAN_ARGS, '--duck-db', '0', '--duck-ratio', '4'], dir);

    assertCleanExit(r, EXIT.USAGE, '--duck-db 0 is ducking off, so a ratio for it is ignored input: ');
  });

  // The apply line is the one line an --apply run prints before ffmpeg. It named both gains
  // and said nothing about the duck, so a log could not tell a ducked mix from a flat one.
  // ffmpeg is missing here on purpose: the line is printed before it runs. This bed has no
  // ducking record, so "off" is claimed for the graph only — see the B-1 block below.
  test('remuxMusic_applyLine_saysWhetherDuckingIsOn', (t) => {
    const dir = remuxProject(t, { 'music.wav': pcmWav(10), 'vo-envelope.json': boundEnvelope() });

    const flat = runScript('remux-music.mjs', [...PLAN_ARGS, '--apply', '--confirm-gain'], dir);
    assertCleanExit(flat, EXIT.FAILED, 'ffmpeg is missing, so the run fails after the apply line: ');
    assert.match(flat.all, /^voice 1\.14 · music 1\.5 · duck off in the graph; the bed has no ducking record$/m);

    const ducked = runScript('remux-music.mjs', [...PLAN_ARGS, ...DUCK_ARGS, '--apply', '--confirm-gain'], dir);
    assertCleanExit(ducked, EXIT.FAILED, 'ffmpeg is missing, so the run fails after the apply line: ');
    assert.match(ducked.all, /^voice 1\.14 · music 1\.5 · duck -11 dB$/m);
  });

  test('remuxMusic_noDuckDb_leavesTheGraphExactlyAsItWas', (t) => {
    const dir = remuxProject(t);
    const r = runScript('remux-music.mjs', PLAN_ARGS, dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.doesNotMatch(r.all, /sidechaincompress/, 'ducking is opt-in; the default graph must not change');
    assert.doesNotMatch(r.all, /apad/);
  });

  // The exit code is asserted, not assumed. Without it a plan that crashed AFTER building
  // the graph wrote nothing either, and passed.
  test('remuxMusic_duckingRequested_writesNothingWithoutApply', (t) => {
    const dir = remuxProject(t, { 'vo-envelope.json': boundEnvelope() });
    const r = runScript('remux-music.mjs', [...PLAN_ARGS, '--duck-db', '11', '--duck-envelope', 'vo-envelope.json'], dir);

    assertCleanExit(r, EXIT.OK, 'a ducking plan must succeed, not merely write nothing: ');
    assert.equal(fs.existsSync(path.join(dir, 'out.mp4')), false);
    assert.equal(fs.existsSync(path.join(dir, 'music-gain.lock.json')), false, 'and must not pin anything');
  });
});

// --------------------------------------------------------------------------------------
// B-6 — make-music checks the envelope against the narration in play, not its own source
// --------------------------------------------------------------------------------------

describe('make-music checks the envelope against the narration in play', () => {
  // Without --voice, make-music compared the envelope with THE FILE THE ENVELOPE NAMES —
  // so the check proved only that the envelope matched its own source. A project re-voiced
  // into voiceover.mp3, with the envelope still bound to a draft that is still on disk,
  // passed as current. remux-music defaults --voice to voiceover.mp3; so does this now.
  test('makeMusic_noVoiceFlag_checksTheEnvelopeAgainstVoiceoverMp3NotTheFileItNames', (t) => {
    const dir = makeProject(t, {
      'voiceover-draft.mp3': VOICE_BYTES,
      'voiceover.mp3': Buffer.from('the narration actually in play, re-voiced since the envelope'),
      'env.json': boundEnvelope({ file: 'voiceover-draft.mp3' }),
    });

    const r = runScript('make-music.mjs', ['--out', 'bed.wav', '--seconds', '2', '--envelope', 'env.json'], dir);

    assertCleanExit(r, EXIT.USAGE, 'an envelope that does not describe voiceover.mp3 must be refused: ');
    assert.match(r.all, /voiceover\.mp3/, 'the refusal must name the narration it checked against');
    assert.match(r.all, /"voiceover-draft\.mp3"/, 'and show the file the envelope names, as information only');
  });

  test('makeMusic_voiceFlagNamingTheEnvelopesSource_isCheckedAgainstThatFile', (t) => {
    const dir = makeProject(t, {
      'voiceover-draft.mp3': VOICE_BYTES,
      'voiceover.mp3': Buffer.from('some other narration'),
      'env.json': boundEnvelope({ file: 'voiceover-draft.mp3' }),
    });

    const r = runScript(
      'make-music.mjs',
      ['--out', 'bed.wav', '--seconds', '2', '--envelope', 'env.json', '--voice', 'voiceover-draft.mp3'],
      dir,
    );

    assertCleanExit(r, EXIT.OK, 'an explicit --voice is the narration the operator says is in play: ');
  });
});

// --------------------------------------------------------------------------------------
// B-1 — a bed make-music ducked stays bound to the narration it was ducked against
// --------------------------------------------------------------------------------------

describe('a ducked bed stays bound to the narration it was ducked against', () => {
  const RECORD = 'music.wav.duck.json';
  const MUSIC = pcmWav(10);
  const REVOICED = Buffer.from('the narration after a re-voice — different bytes, different length');

  /** The record make-music writes beside a bed. `sha256` is the narration it was ducked against. */
  const bedRecord = ({ ducked = true, sha256 = VOICE_SHA, bed = MUSIC } = {}) =>
    JSON.stringify({
      bed: { file: 'music.wav', bytes: bed.length, sha256: sha256Of(bed) },
      ducked,
      ...(ducked ? { duckedAgainst: { file: 'voiceover.mp3', bytes: VOICE_BYTES.length, sha256 } } : {}),
    });

  const bedProject = (t, extra = {}) => remuxProject(t, { 'music.wav': MUSIC, ...extra });

  const makeMusic = (dir, extra = [], seconds = 2) =>
    runScript('make-music.mjs', ['--out', 'music.wav', '--seconds', String(seconds), ...extra], dir);

  // ---- make-music writes the record ----

  test('makeMusic_duckedBed_writesARecordBindingTheBedToTheNarrationItWasDuckedAgainst', (t) => {
    const dir = makeProject(t, { 'voiceover.mp3': VOICE_BYTES, 'vo-envelope.json': boundEnvelope() });

    const r = makeMusic(dir, ['--envelope', 'vo-envelope.json', '--apply']);

    assertCleanExit(r, EXIT.OK);
    const bed = fs.readFileSync(path.join(dir, 'music.wav'));
    const record = JSON.parse(fs.readFileSync(path.join(dir, RECORD), 'utf8'));
    assert.deepEqual(record, {
      bed: { file: 'music.wav', bytes: bed.length, sha256: sha256Of(bed) },
      ducked: true,
      duckedAgainst: { file: 'voiceover.mp3', bytes: VOICE_BYTES.length, sha256: VOICE_SHA },
    });
  });

  // A FLAT BED GETS A RECORD TOO. Otherwise "no record" would mean both "not ducked" and
  // "written before records existed", and the second must not be read as the first.
  test('makeMusic_flatBed_writesARecordSayingTheBedIsNotDucked', (t) => {
    const dir = makeProject(t);

    const r = makeMusic(dir, ['--apply']);

    assertCleanExit(r, EXIT.OK);
    const bed = fs.readFileSync(path.join(dir, 'music.wav'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, RECORD), 'utf8')), {
      bed: { file: 'music.wav', bytes: bed.length, sha256: sha256Of(bed) },
      ducked: false,
    });
  });

  test('makeMusic_plan_namesTheDuckingRecordAndWritesNothing', (t) => {
    const dir = makeProject(t);

    const r = makeMusic(dir);

    assertCleanExit(r, EXIT.OK);
    assert.match(r.all, /music\.wav\.duck\.json/, 'the plan must name every file --apply would write');
    assert.equal(fs.existsSync(path.join(dir, RECORD)), false);
  });

  test('makeMusic_duckingRecordAlreadyPresentWithoutReplace_refusesBeforeSynthesising', (t) => {
    const dir = makeProject(t, { [RECORD]: 'EXISTING RECORD' });

    const r = makeMusic(dir, ['--apply']);

    assertCleanExit(r, EXIT.USAGE, 'an existing record is an existing output: ');
    assert.equal(fs.readFileSync(path.join(dir, RECORD), 'utf8'), 'EXISTING RECORD', 'and must be left alone');
    assert.equal(fs.existsSync(path.join(dir, 'music.wav')), false, 'and no bed may be written without its record');
    assert.doesNotMatch(r.all, /raw peak/, 'and the refusal must come before minutes of synthesis');
  });

  test('makeMusic_duckingRecordIsALinkToAnOutsideVictim_refusesWithoutWritingThroughIt', (t) => {
    const dir = makeProject(t);
    const outside = makeOutsideDir(t, { 'victim.json': 'ORIGINAL VICTIM' });
    if (!tryMakeFileLink(path.join(dir, RECORD), path.join(outside, 'victim.json'))) {
      return t.skip('platform refused to create a file link');
    }

    const r = makeMusic(dir, ['--apply', '--replace']);

    assertCleanExit(r, EXIT.USAGE, 'the record is engine-chosen, so a link at it is refused: ');
    assert.equal(fs.readFileSync(path.join(outside, 'victim.json'), 'utf8'), 'ORIGINAL VICTIM');
    assert.equal(fs.existsSync(path.join(dir, 'music.wav')), false);
  });

  // THE PUBLISH IS THE NO-CLOBBER GUARD, NOT THE UP-FRONT CHECK. Synthesis takes minutes, and
  // a record that appeared in that window was renamed over without --replace. The plant
  // lands inside make-music's own "raw peak" log call — after the check, before the publish
  // — so the collision is staged by the run itself, not raced against it.
  const makeMusicPlanting = (dir, extra) =>
    runScript('make-music.mjs', ['--out', 'music.wav', '--seconds', '2', '--apply', ...extra], dir, {
      nodeArgs: ['--import', plantOnMarker({ marker: 'raw peak', target: path.join(dir, RECORD), body: 'PLANTED MID-RUN' })],
    });

  test('makeMusic_duckingRecordAppearsAfterTheUpFrontCheck_refusesAndLeavesItAndWritesNoBed', (t) => {
    const dir = makeProject(t);

    const r = makeMusicPlanting(dir, []);

    assert.match(r.all, /plant-on-marker: planted/, 'the record must have appeared mid-run, or this tests nothing');
    assertCleanExit(r, EXIT.USAGE, 'a record that appeared after the check is still an existing output: ');
    assert.match(r.all, /appeared after/, 'and the refusal must say it was not there when the run was checked');
    assert.equal(fs.readFileSync(path.join(dir, RECORD), 'utf8'), 'PLANTED MID-RUN', 'it must be left exactly as it was');
    assert.deepEqual(fs.readdirSync(dir), [RECORD], 'and no bed, temp file or anything else may be left behind');
  });

  test('makeMusic_duckingRecordAppearsAfterTheUpFrontCheckWithReplace_isReplacedByTheBedsRecord', (t) => {
    const dir = makeProject(t);

    const r = makeMusicPlanting(dir, ['--replace']);

    assert.match(r.all, /plant-on-marker: planted/, 'the record must have appeared mid-run, or this tests nothing');
    assertCleanExit(r, EXIT.OK, '--replace covers the record: ');
    const bed = fs.readFileSync(path.join(dir, 'music.wav'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, RECORD), 'utf8')), {
      bed: { file: 'music.wav', bytes: bed.length, sha256: sha256Of(bed) },
      ducked: false,
    });
    assert.deepEqual(fs.readdirSync(dir).sort(), [RECORD, 'music.wav'].sort(), 'and no temp file may be left behind');
  });

  // A temp name that cannot be removed once the record is published is a leftover, not a
  // failed publish: the bed is still written, the run still succeeds, and it is named.
  test('makeMusic_tempNameCannotBeRemovedOnceTheRecordIsPublished_warnsNamingItAndWritesTheBed', (t) => {
    const dir = makeProject(t);

    const r = runScript('make-music.mjs', ['--out', 'music.wav', '--seconds', '2', '--apply'], dir, {
      nodeArgs: ['--import', refuseUnlink({ dir, fragment: `${RECORD}.part-` })],
    });

    assert.match(r.all, /refuse-unlink: refused/, 'the temp name must have failed to go away, or this tests nothing');
    assertCleanExit(r, EXIT.OK, 'a published record with a leftover temp name is not a failed publish: ');
    const leftover = fs.readdirSync(dir).filter((name) => name.startsWith(`${RECORD}.part-`));
    assert.equal(leftover.length, 1, fs.readdirSync(dir).join(', '));
    assert.match(r.stderr, new RegExp(`warning: .*${leftover[0].replaceAll('.', '\\.')}`), 'the warning must name it');
    const bed = fs.readFileSync(path.join(dir, 'music.wav'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, RECORD), 'utf8')), {
      bed: { file: 'music.wav', bytes: bed.length, sha256: sha256Of(bed) },
      ducked: false,
    });
  });

  // A descriptor that cannot be closed once the record is published is not a leftover: the
  // close can be what reports a failed write. The run fails, the record is left at its name,
  // and no bed is written against bytes that cannot be confirmed.
  test('makeMusic_recordCannotBeClosedOnceItIsPublished_exits1LeavingTheRecordAndWritingNoBed', (t) => {
    const dir = makeProject(t);

    const r = runScript('make-music.mjs', ['--out', 'music.wav', '--seconds', '2', '--apply'], dir, {
      nodeArgs: ['--import', failClose({ dir, fragment: `${RECORD}.part-` })],
    });

    assert.match(r.stderr, /fail-close: failed the close of /, 'the close must have failed, or this tests nothing');
    assertCleanExit(r, EXIT.FAILED, 'a record whose file could not be closed fails the run: ');
    assert.equal(fs.existsSync(path.join(dir, 'music.wav')), false, 'no bed may be written');
    assert.deepEqual(fs.readdirSync(dir), [RECORD], 'the record must be left at its name, and no temp file behind');
    const record = JSON.parse(fs.readFileSync(path.join(dir, RECORD), 'utf8'));
    assert.equal(record.bed.file, 'music.wav', 'and it is the record this run wrote');
    assert.equal(record.ducked, false);
    assert.match(r.stderr, /music\.wav has not been written/, 'stderr must say the bed was not written');
  });

  // ---- remux-music reads it ----

  // THE REQUIRED PROPERTY, END TO END: make-music ducks against the narration, the project
  // is re-voiced, make-music is not re-run. The bed's pin is still valid — it covers the
  // bed's bytes and the mix — so remux-music used to ship the ducks in the wrong places.
  test('remuxMusic_reVoicedAfterMakeMusicDucked_refusesTheBedWhetherOrNotDuckDbIsPassed', (t) => {
    const dir = remuxProject(t, { 'vo-envelope.json': boundEnvelope() });
    // 10 s so the bed outlasts the 5 s timeline without looping; --replace over the stub.
    assertCleanExit(makeMusic(dir, ['--envelope', 'vo-envelope.json', '--apply', '--replace'], 10), EXIT.OK, 'setup: ');

    const before = runScript('remux-music.mjs', PLAN_ARGS, dir);
    assertCleanExit(before, EXIT.OK, 'a bed ducked against the narration on disk plans: ');

    fs.writeFileSync(path.join(dir, 'voiceover.mp3'), REVOICED);
    fs.writeFileSync(
      path.join(dir, 'vo-envelope.json'),
      JSON.stringify({ ...JSON.parse(boundEnvelope()), measuredFrom: { file: 'voiceover.mp3', bytes: REVOICED.length, sha256: sha256Of(REVOICED) } }),
    );

    const flat = runScript('remux-music.mjs', PLAN_ARGS, dir);
    assertCleanExit(flat, EXIT.FAILED, 'without --duck-db the baked duck is still in the wrong places: ');
    assert.match(flat.all, /music\.wav\.duck\.json/, 'the refusal must name the record');
    assert.match(flat.all, /sha256/, 'and the field that differs');
    assert.match(flat.all, /make-music/, 'and the stage that re-ducks it');

    const ducked = runScript('remux-music.mjs', [...PLAN_ARGS, '--duck-db', '11', '--duck-envelope', 'vo-envelope.json'], dir);
    assertCleanExit(ducked, EXIT.FAILED, 'a current in-graph envelope does not make the baked duck current: ');
    assert.match(ducked.all, /music\.wav\.duck\.json/);
  });

  test('remuxMusic_bedDuckedAgainstTheNarrationOnDisk_plansAndSaysTheBakedDuckIsCurrent', (t) => {
    const dir = bedProject(t, { [RECORD]: bedRecord() });

    const r = runScript('remux-music.mjs', PLAN_ARGS, dir);

    assertCleanExit(r, EXIT.OK);
    assert.match(r.all, /carries make-music's duck/, 'the plan must not call a ducked bed flat');
    assert.match(r.all, /CURRENT/);
    assert.doesNotMatch(r.all, /plays flat/);
  });

  test('remuxMusic_bedDuckedAgainstDifferentNarration_refusesOnThePlanAndOnApply', (t) => {
    const dir = bedProject(t, { [RECORD]: bedRecord({ sha256: 'c'.repeat(64) }) });

    const plan = runScript('remux-music.mjs', PLAN_ARGS, dir);
    assertCleanExit(plan, EXIT.FAILED, 'a stale baked duck is refused like a stale envelope: ');
    assert.match(plan.all, /music\.wav\.duck\.json/);

    const apply = runScript('remux-music.mjs', [...PLAN_ARGS, '--apply', '--confirm-gain'], dir);
    assertCleanExit(apply, EXIT.FAILED);
    assert.match(apply.all, /music\.wav\.duck\.json/, '--confirm-gain covers the mix, not the narration the bed was ducked against');
    assert.doesNotMatch(apply.all, /· duck/, 'and the refusal must come before the mix starts');
  });

  test('remuxMusic_flatBedRecord_plansAndSaysTheBedPlaysFlat', (t) => {
    const dir = bedProject(t, { [RECORD]: bedRecord({ ducked: false }) });

    const r = runScript('remux-music.mjs', PLAN_ARGS, dir);

    assertCleanExit(r, EXIT.OK);
    assert.match(r.all, /plays flat: its ducking record says make-music did not duck it/);
  });

  // The apply line must not call a bed with make-music's duck in it "off".
  test('remuxMusic_applyLine_saysWhatTheBedsRecordSaysAboutItsDuck', (t) => {
    const baked = runScript('remux-music.mjs', [...PLAN_ARGS, '--apply', '--confirm-gain'], bedProject(t, { [RECORD]: bedRecord() }));
    assertCleanExit(baked, EXIT.FAILED, 'ffmpeg is missing, so the run fails after the apply line: ');
    assert.match(baked.all, /^voice 1\.14 · music 1\.5 · duck baked into the bed by make-music$/m);

    const flat = runScript(
      'remux-music.mjs',
      [...PLAN_ARGS, '--apply', '--confirm-gain'],
      bedProject(t, { [RECORD]: bedRecord({ ducked: false }) }),
    );
    assertCleanExit(flat, EXIT.FAILED, 'ffmpeg is missing, so the run fails after the apply line: ');
    assert.match(flat.all, /^voice 1\.14 · music 1\.5 · duck off$/m);
  });

  // ABSENCE IS NOT "NOT DUCKED". A licensed track has no record, and neither does a bed
  // make-music ducked before records existed; nothing in the audio tells the two apart.
  test('remuxMusic_noDuckingRecord_saysWhetherTheBedIsDuckedCannotBeTold', (t) => {
    const dir = bedProject(t);

    const r = runScript('remux-music.mjs', PLAN_ARGS, dir);

    assertCleanExit(r, EXIT.OK);
    assert.match(r.all, /cannot be told/, 'the plan must not claim a bed with no record plays flat');
    assert.doesNotMatch(r.all, /plays flat, as it always has/);
  });

  // ---- --duck-db over the bed's own duck (B-25) ----

  const DUCK_ARGS = ['--duck-db', '11', '--duck-envelope', 'vo-envelope.json'];
  const oneLine = (text) => text.replace(/\s+/g, ' ');

  // A SECOND DUCK IS REFUSED, NOT STACKED. The record says make-music baked a duck into the
  // bed against the narration in play, so an in-graph duck lands on top of it and the bed
  // drops by both under every phrase. That is a conflicting request, so exit 2, like a
  // --duck-* option without --duck-db. There is no stacking mode.
  test('remuxMusic_duckDbOnABedMakeMusicAlreadyDucked_refusesOnThePlanAndOnApplyWritingNothing', (t) => {
    const dir = bedProject(t, { [RECORD]: bedRecord(), 'vo-envelope.json': boundEnvelope() });
    const listing = fs.readdirSync(dir).sort();

    const plan = runScript('remux-music.mjs', [...PLAN_ARGS, ...DUCK_ARGS], dir);
    assertCleanExit(plan, EXIT.USAGE, 'a second duck is a conflicting request: ');
    assert.match(plan.all, /music\.wav\.duck\.json/, 'the refusal must name the record');
    assert.match(oneLine(plan.all), /already carries make-music's duck against voiceover\.mp3/);
    assert.match(oneLine(plan.all), /--duck-db would duck it a second time/);
    assert.match(oneLine(plan.all), /drop --duck-db .* the bed's own duck is used/i, 'one way out keeps the bed');
    assert.match(
      plan.all,
      /^\s+node src\/make-music\.mjs --out music\.wav --apply --replace$/m,
      'the other re-makes it flat — make-music without --envelope — to duck in the graph',
    );
    assert.doesNotMatch(plan.all, /sidechaincompress=/, 'and no graph may be planned');

    const apply = runScript('remux-music.mjs', [...PLAN_ARGS, ...DUCK_ARGS, '--apply', '--confirm-gain'], dir);
    assertCleanExit(apply, EXIT.USAGE, '--confirm-gain does not make a second duck acceptable: ');
    assert.match(oneLine(apply.all), /--duck-db would duck it a second time/);
    assert.doesNotMatch(apply.all, /· duck/, 'the refusal must come before the mix starts');
    assert.deepEqual(fs.readdirSync(dir).sort(), listing, 'and nothing may be written: no output and no pin');
  });

  // The refusal is for a bed its record says make-music ducked, and for nothing else.
  test('remuxMusic_duckDbOnAFlatBedOrABedWithNoRecord_isStillAcceptedOnThePlanAndOnApply', (t) => {
    for (const [label, extra] of [['flat record', { [RECORD]: bedRecord({ ducked: false }) }], ['no record', {}]]) {
      const plan = runScript('remux-music.mjs', [...PLAN_ARGS, ...DUCK_ARGS], bedProject(t, { 'vo-envelope.json': boundEnvelope(), ...extra }));
      assertCleanExit(plan, EXIT.OK, `${label}: `);
      assert.match(plan.all, /sidechaincompress=/, `${label}: the duck must be planned in the graph`);

      const apply = runScript(
        'remux-music.mjs',
        [...PLAN_ARGS, ...DUCK_ARGS, '--apply', '--confirm-gain'],
        bedProject(t, { 'vo-envelope.json': boundEnvelope(), ...extra }),
      );
      assertCleanExit(apply, EXIT.FAILED, `${label}: ffmpeg is missing, so the run fails after the apply line: `);
      assert.match(apply.all, /^voice 1\.14 · music 1\.5 · duck -11 dB$/m, `${label}: --apply must reach the mix`);
    }
  });

  // A STALE RECORD IS REFUSED AS STALE FIRST. The bed's duck is in the wrong places whatever
  // is asked of the graph, and that is the failure to report, with its own way out.
  test('remuxMusic_duckDbOnABedDuckedAgainstDifferentNarration_keepsTheStaleRefusalWhichFiresFirst', (t) => {
    const dir = bedProject(t, { [RECORD]: bedRecord({ sha256: 'c'.repeat(64) }), 'vo-envelope.json': boundEnvelope() });

    const r = runScript('remux-music.mjs', [...PLAN_ARGS, ...DUCK_ARGS], dir);

    assertCleanExit(r, EXIT.FAILED, 'stale is exit 1, whatever else is asked: ');
    assert.match(r.all, /against different narration/);
    assert.doesNotMatch(r.all, /second time/);
  });

  // THE UNKNOWN IS DISCLOSED WITH THE DUCK ON TOO. With no record, make-music may have baked
  // a duck into the bed, and the in-graph one would land on top of it — the plan said so
  // only when --duck-db was off.
  test('remuxMusic_duckDbOnABedWithNoRecord_saysABakedDuckCannotBeToldAndWouldBeDuckedAgain', (t) => {
    const dir = bedProject(t, { 'vo-envelope.json': boundEnvelope() });

    const r = runScript('remux-music.mjs', [...PLAN_ARGS, ...DUCK_ARGS], dir);

    assertCleanExit(r, EXIT.OK);
    assert.match(oneLine(r.all), /no ducking record beside the bed, so whether make-music ducked it cannot be told/);
    assert.match(oneLine(r.all), /if it did, this duck is applied on top of the one baked into it/);
  });

  test('remuxMusic_duckDbOnAFlatBed_saysTheInGraphDuckIsItsOnlyDuck', (t) => {
    const dir = bedProject(t, { [RECORD]: bedRecord({ ducked: false }), 'vo-envelope.json': boundEnvelope() });

    const r = runScript('remux-music.mjs', [...PLAN_ARGS, ...DUCK_ARGS], dir);

    assertCleanExit(r, EXIT.OK);
    assert.match(oneLine(r.all), /the bed's ducking record says make-music did not duck it, so this is its only duck/);
    assert.doesNotMatch(r.all, /cannot be told/);
  });

  test('remuxMusic_duckingRecordDescribesADifferentBed_refuses', (t) => {
    const dir = bedProject(t, { [RECORD]: bedRecord({ bed: Buffer.from('a bed that has since been replaced') }) });

    const r = runScript('remux-music.mjs', PLAN_ARGS, dir);

    assertCleanExit(r, EXIT.FAILED, 'a record that does not describe the bed beside it is malformed: ');
    assert.match(r.all, /different bed/);
    assert.match(r.all, /make-music/, 'and the refusal must say how to settle it');
  });

  test('remuxMusic_duckingRecordIsALinkToAnOutsideSecret_refusesWithoutDisclosingIt', (t) => {
    const dir = bedProject(t);
    const outside = makeOutsideDir(t, { 'secret.json': 'SQUIRRELTOKEN-do-not-disclose' });
    if (!tryMakeFileLink(path.join(dir, RECORD), path.join(outside, 'secret.json'))) {
      return t.skip('platform refused to create a file link');
    }

    const r = runScript('remux-music.mjs', PLAN_ARGS, dir);

    assertCleanExit(r, EXIT.USAGE, 'the record is engine-chosen, so a link at it is refused: ');
    assert.match(r.all, /link/i);
    assert.doesNotMatch(r.all, /SQUIRRELTOKEN/);
  });

  test('remuxMusic_duckingRecordIsNotJson_exitsFailedReportingItsLengthNotItsContents', (t) => {
    const body = '{ SQUIRRELTOKEN is not json';
    const dir = bedProject(t, { [RECORD]: body });

    const r = runScript('remux-music.mjs', PLAN_ARGS, dir);

    assertCleanExit(r, EXIT.FAILED, 'a malformed engine artifact exits 1: ');
    assert.ok(r.all.includes(`(${body.length} characters)`), `the refusal must report the length\n${r.all}`);
    assert.doesNotMatch(r.all, /SQUIRRELTOKEN/, 'and never the contents');
  });

  test('remuxMusic_duckingRecordOfTheWrongShape_exitsFailed', (t) => {
    const dir = bedProject(t, { [RECORD]: JSON.stringify({ bed: 'music.wav', ducked: 'yes' }) });

    const r = runScript('remux-music.mjs', PLAN_ARGS, dir);

    assertCleanExit(r, EXIT.FAILED);
    assert.match(r.all, /music\.wav\.duck\.json/);
  });

  test('remuxMusic_duckingRecordIsADirectory_refusesAsNotARegularFile', (t) => {
    const dir = bedProject(t);
    fs.mkdirSync(path.join(dir, RECORD));

    const r = runScript('remux-music.mjs', PLAN_ARGS, dir);

    assertCleanExit(r, EXIT.USAGE);
    assert.match(r.all, /not a regular file/);
  });
});

// --------------------------------------------------------------------------------------
// The ducking record is published without clobbering anything that appeared mid-run
// --------------------------------------------------------------------------------------

describe('the ducking record is created exclusively at its name without --replace', () => {
  const RECORD = 'music.wav.duck.json';
  const RECORD_BODY = { bed: { file: 'music.wav', bytes: 44, sha256: 'a'.repeat(64) }, ducked: false };
  // make-music's up-front check, exactly: it finds the name free, and then synthesis runs.
  const checkedFree = (dir, replace = false) =>
    resolveEngineOutput(dir, RECORD, { apply: true, replace, label: 'ducking record' });
  const refusedAsAppeared = (err) =>
    err instanceof CliError && err.exitCode === EXIT.USAGE && /appeared after the up-front check/.test(err.message);

  // The races below are staged INSIDE the publish, by replacing node:fs functions on the
  // shared default export that cli-support and envelope-ducking both call through. Every
  // test here is synchronous and restores the originals in `finally`, so nothing leaks.
  const real = {
    openSync: fs.openSync,
    writeFileSync: fs.writeFileSync,
    linkSync: fs.linkSync,
    unlinkSync: fs.unlinkSync,
    renameSync: fs.renameSync,
    symlinkSync: fs.symlinkSync,
    fstatSync: fs.fstatSync,
    lstatSync: fs.lstatSync,
    closeSync: fs.closeSync,
  };
  const withFs = (overrides, body) => {
    const saved = Object.fromEntries(Object.keys(overrides).map((name) => [name, fs[name]]));
    Object.assign(fs, overrides);
    try {
      return body();
    } finally {
      Object.assign(fs, saved);
    }
  };
  /** Publishes with `overrides` in place, returning what it threw rather than throwing it. */
  const publishing = (dir, recordPath, overrides, options) =>
    withFs(overrides, () => {
      try {
        return { result: publishBedDuckRecord(dir, recordPath, RECORD_BODY, options) };
      } catch (error) {
        return { error };
      }
    });
  /** A stat as a filesystem with no file identity reports it: inode 0 (and, by path, device 0). */
  const withoutIdentity = (stats, { dev = false } = {}) => {
    if (stats !== undefined) {
      stats.ino = typeof stats.ino === 'bigint' ? 0n : 0;
      if (dev) stats.dev = typeof stats.dev === 'bigint' ? 0n : 0;
    }
    return stats;
  };
  const NO_IDENTITY = {
    fstatSync: (...args) => withoutIdentity(real.fstatSync(...args)),
    lstatSync: (...args) => withoutIdentity(real.lstatSync(...args), { dev: true }),
  };
  const eio = () => Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' });
  const eperm = (syscall) => Object.assign(new Error(`EPERM: operation not permitted, ${syscall}`), { code: 'EPERM' });

  test('publishBedDuckRecord_fileAppearsAfterTheCheck_refusesUsageAndLeavesItByteIdentical', (t) => {
    const dir = makeProject(t);
    const recordPath = checkedFree(dir);
    fs.writeFileSync(recordPath, 'PLANTED AFTER THE CHECK');

    assert.throws(() => publishBedDuckRecord(dir, recordPath, RECORD_BODY), refusedAsAppeared);
    assert.equal(fs.readFileSync(recordPath, 'utf8'), 'PLANTED AFTER THE CHECK', 'it must be left exactly as it was');
    assert.deepEqual(fs.readdirSync(dir), [RECORD], 'and no temp file may be left behind');
  });

  test('publishBedDuckRecord_directoryAppearsAfterTheCheck_refusesUsageAndLeavesIt', (t) => {
    const dir = makeProject(t);
    const recordPath = checkedFree(dir);
    fs.mkdirSync(recordPath);
    fs.writeFileSync(path.join(recordPath, 'inside.txt'), 'KEEP');

    assert.throws(() => publishBedDuckRecord(dir, recordPath, RECORD_BODY), refusedAsAppeared);
    assert.equal(fs.readFileSync(path.join(recordPath, 'inside.txt'), 'utf8'), 'KEEP');
    assert.deepEqual(fs.readdirSync(dir), [RECORD]);
  });

  test('publishBedDuckRecord_linkAppearsAfterTheCheck_refusesWithoutWritingThroughOrReplacingIt', (t) => {
    const dir = makeProject(t);
    const outside = makeOutsideDir(t, { 'victim.json': 'ORIGINAL VICTIM' });
    const recordPath = checkedFree(dir);
    if (!tryMakeFileLink(recordPath, path.join(outside, 'victim.json'))) {
      return t.skip('platform refused to create a file link');
    }

    assert.throws(() => publishBedDuckRecord(dir, recordPath, RECORD_BODY), refusedAsAppeared);
    assert.equal(fs.readFileSync(path.join(outside, 'victim.json'), 'utf8'), 'ORIGINAL VICTIM');
    assert.equal(fs.lstatSync(recordPath).isSymbolicLink(), true, 'the link itself must be left in place');
  });

  // A link to nothing: an open that follows it creates its target, outside the project.
  test('publishBedDuckRecord_danglingLinkAppearsAfterTheCheck_refusesWithoutCreatingItsTarget', (t) => {
    const dir = makeProject(t);
    const target = path.join(makeOutsideDir(t), 'created-through-the-link.json');
    const recordPath = checkedFree(dir);
    if (!tryMakeFileLink(recordPath, target)) return t.skip('platform refused to create a file link');

    assert.throws(() => publishBedDuckRecord(dir, recordPath, RECORD_BODY), refusedAsAppeared);
    assert.equal(fs.existsSync(target), false, 'nothing may be created through the link');
  });

  test('publishBedDuckRecord_nameStillFree_createsTheRecordAndNothingElse', (t) => {
    const dir = makeProject(t);
    const recordPath = checkedFree(dir);

    publishBedDuckRecord(dir, recordPath, RECORD_BODY);

    assert.deepEqual(JSON.parse(fs.readFileSync(recordPath, 'utf8')), RECORD_BODY);
    assert.deepEqual(fs.readdirSync(dir), [RECORD]);
  });

  // --replace keeps the temp-and-rename publish: the record is replaced as a directory
  // entry, whatever appeared at the name.
  test('publishBedDuckRecord_withReplaceOverAFileThatAppeared_replacesItLeavingNoTempFile', (t) => {
    const dir = makeProject(t);
    const recordPath = checkedFree(dir, true);
    fs.writeFileSync(recordPath, 'PLANTED AFTER THE CHECK');

    publishBedDuckRecord(dir, recordPath, RECORD_BODY, { replace: true });

    assert.deepEqual(JSON.parse(fs.readFileSync(recordPath, 'utf8')), RECORD_BODY);
    assert.deepEqual(fs.readdirSync(dir), [RECORD]);
  });

  // An engine-chosen name: a link at it is refused even with --replace (T2's policy), and
  // the rename never runs, so the link and its target are both left as they were.
  test('publishBedDuckRecord_withReplaceOverALinkThatAppeared_refusesWithoutWritingThroughOrReplacingIt', (t) => {
    const dir = makeProject(t);
    const outside = makeOutsideDir(t, { 'victim.json': 'ORIGINAL VICTIM' });
    const recordPath = checkedFree(dir, true);
    if (!tryMakeFileLink(recordPath, path.join(outside, 'victim.json'))) {
      return t.skip('platform refused to create a file link');
    }

    assert.throws(
      () => publishBedDuckRecord(dir, recordPath, RECORD_BODY, { replace: true }),
      (err) => err instanceof CliError && err.exitCode === EXIT.USAGE && /is a link/.test(err.message),
    );
    assert.equal(fs.readFileSync(path.join(outside, 'victim.json'), 'utf8'), 'ORIGINAL VICTIM');
    assert.equal(fs.lstatSync(recordPath).isSymbolicLink(), true);
    assert.deepEqual(fs.readdirSync(dir), [RECORD], 'and no temp file may be left behind');
  });

  // The check that stands between every create and every later step: the temp file before
  // it is written to, the published name before it is trusted, and the temp name before it
  // is removed. It must fail closed.
  test('isOpenedAt_theFileThisDescriptorCreated_isTrue', (t) => {
    const name = path.join(makeProject(t), RECORD);
    const fd = fs.openSync(name, 'wx+');
    try {
      assert.equal(isOpenedAt(fd, name), true);
    } finally {
      fs.closeSync(fd);
    }
  });

  test('isOpenedAt_aLinkToTheOpenedFile_isFalse', (t) => {
    const name = path.join(makeProject(t), RECORD);
    const opened = path.join(makeOutsideDir(t), 'created-through-a-link.json');
    if (!tryMakeFileLink(name, opened)) return t.skip('platform refused to create a file link');
    const fd = fs.openSync(opened, 'wx+');
    try {
      assert.equal(isOpenedAt(fd, name), false, 'the name holds a link, not the file');
    } finally {
      fs.closeSync(fd);
    }
  });

  test('isOpenedAt_anotherFileAtTheName_isFalse', (t) => {
    const dir = makeProject(t, { [RECORD]: 'SOMEONE ELSE' });
    const fd = fs.openSync(path.join(dir, 'ours.json'), 'wx+');
    try {
      assert.equal(isOpenedAt(fd, path.join(dir, RECORD)), false);
      assert.equal(isOpenedAt(fd, path.join(dir, 'nothing-here.json')), false, 'and nothing at the name is no match');
    } finally {
      fs.closeSync(fd);
    }
  });

  // F7. A filesystem that reports inode 0 gives no identity to compare, and two different
  // files that both report none must not pass as one.
  test('isOpenedAt_filesystemReportsNoFileIdentity_isFalseForTwoDifferentFiles', (t) => {
    const dir = makeProject(t, { [RECORD]: 'SOMEONE ELSE' });
    const fd = fs.openSync(path.join(dir, 'ours.json'), 'wx+');
    try {
      const verdict = withFs(NO_IDENTITY, () => isOpenedAt(fd, path.join(dir, RECORD)));
      assert.equal(verdict, false, 'two different files that both report inode 0 are not one file');
    } finally {
      fs.closeSync(fd);
    }
  });

  test('publishBedDuckRecord_filesystemReportsNoFileIdentity_refusesSayingSoAndPublishesNothing', (t) => {
    const dir = makeProject(t);
    const recordPath = checkedFree(dir);

    const { error } = publishing(dir, recordPath, NO_IDENTITY);

    assert.ok(error instanceof CliError, `a file identity that cannot be checked must not be trusted: ${error?.message ?? 'it published'}`);
    assert.equal(error.exitCode, EXIT.FAILED, error.message);
    assert.match(error.message, /this filesystem gives no file identity to check/);
    assert.doesNotMatch(error.message.replaceAll(dir, '<project>'), /link/, 'and it must not say a link took its place');
    assert.equal(fs.existsSync(recordPath), false, 'nothing may be published at the name');
    assert.deepEqual(
      fs.readdirSync(dir).map((name) => name.replace(/\.part-\d+-[0-9a-f]{16}$/, '.part-<pid>-<random>')),
      [`${RECORD}.part-<pid>-<random>`],
      'the empty temp file cannot be shown to be this run\'s, so it is left as the message says',
    );
  });

  // F8. A write that fails must not remove anything by name: the entry at the record's
  // name may no longer be anything this run created. The replacement is staged inside the
  // failing write itself.
  test('publishBedDuckRecord_writeFailsAfterAnotherFileTakesTheName_exits1AndLeavesItByteIdentical', (t) => {
    const dir = makeProject(t);
    const recordPath = checkedFree(dir);
    let staged = false;

    const { error } = publishing(dir, recordPath, {
      writeFileSync: (file, ...rest) => {
        if (typeof file !== 'number' || staged) return real.writeFileSync(file, ...rest);
        staged = true;
        if (fs.lstatSync(recordPath, { throwIfNoEntry: false })) real.renameSync(recordPath, `${recordPath}.moved-aside`);
        real.writeFileSync(recordPath, 'A REPLACEMENT RECORD');
        throw eio();
      },
    });

    assert.equal(staged, true, 'the write must have been reached, or this tests nothing');
    assert.equal(
      fs.existsSync(recordPath) ? fs.readFileSync(recordPath, 'utf8') : '<nothing: it was removed>',
      'A REPLACEMENT RECORD',
      'the file that took the name must survive byte-identical',
    );
    assert.ok(error instanceof CliError && error.exitCode === EXIT.FAILED, `expected exit 1: ${error?.exitCode} ${error?.message}`);
    assert.match(error.message, /EIO/);
    assert.deepEqual(fs.readdirSync(dir), [RECORD], 'and the temp file, still this run\'s, is removed');
  });

  // F9. On Windows an open with wx FOLLOWS a dangling link and creates the file it points
  // at. The link is planted inside the publish's own first open — after every check that
  // could have seen it — so it tests the race, not the check.
  test('publishBedDuckRecord_danglingLinkPlantedAtTheNameDuringTheOpen_refusesWithoutCreatingItsTarget', (t) => {
    const dir = makeProject(t);
    const victim = path.join(makeOutsideDir(t), 'created-through-the-link.json');
    const recordPath = checkedFree(dir);
    const probe = path.join(dir, 'probe.link');
    if (!tryMakeFileLink(probe, victim)) return t.skip('platform refused to create a file link');
    fs.unlinkSync(probe);
    let planted = false;

    const { error } = publishing(dir, recordPath, {
      openSync: (...args) => {
        if (!planted) {
          planted = true;
          real.symlinkSync(victim, recordPath, 'file');
        }
        return real.openSync(...args);
      },
    });

    assert.equal(planted, true, 'the link must have been planted, or this tests nothing');
    assert.equal(fs.existsSync(victim), false, 'nothing may be created where the link points');
    assert.ok(refusedAsAppeared(error), `expected the exit-2 "appeared after" refusal: ${error?.exitCode} ${error?.message}`);
    assert.equal(fs.lstatSync(recordPath).isSymbolicLink(), true, 'the link must be left as it is');
    assert.equal(fs.readlinkSync(recordPath), victim);
    assert.deepEqual(fs.readdirSync(dir), [RECORD], 'and no temp file may be left behind');
  });

  // A hard link fails for reasons other than an entry at the name — FAT and exFAT volumes
  // cannot make one. Nothing is published, and the temp file goes.
  test('publishBedDuckRecord_linkFailsForAnotherReason_exits1RemovesTheTempAndWritesNothingAtTheName', (t) => {
    const dir = makeProject(t);
    const recordPath = checkedFree(dir);
    let linked = false;

    const { error } = publishing(dir, recordPath, {
      linkSync: () => {
        linked = true;
        throw eperm('link');
      },
    });

    assert.equal(linked, true, 'without --replace the record must be published as a hard link');
    assert.ok(error instanceof CliError && error.exitCode === EXIT.FAILED, `expected exit 1: ${error?.exitCode} ${error?.message}`);
    assert.match(error.message, /EPERM/);
    assert.match(error.message, /nothing was written at that name/);
    if (/--replace/.test(error.message)) assert.match(error.message, /overwrites/, '--replace is no workaround unless it says it overwrites');
    assert.deepEqual(fs.readdirSync(dir), [], 'neither a record nor a temp file may be left');
  });

  // The workaround says what --replace overwrites, and --replace never overwrites a link or a
  // directory at the record's name: the claim must be limited to a record that is a regular file.
  test('publishBedDuckRecord_linkFailsForAnotherReason_claimsReplaceOverwritesOnlyARecordThatIsARegularFile', (t) => {
    const dir = makeProject(t);
    const recordPath = checkedFree(dir);

    const { error } = publishing(dir, recordPath, {
      linkSync: () => {
        throw eperm('link');
      },
    });

    assert.ok(error instanceof CliError && error.exitCode === EXIT.FAILED, `expected exit 1: ${error?.exitCode} ${error?.message}`);
    assert.match(
      error.message,
      /--replace publishes it by rename instead, and overwrites an existing bed and a ducking record that is a regular file\./,
    );
  });

  // The name holds some other file by the time it is checked: it is reported, never removed.
  test('publishBedDuckRecord_nameHoldsAnotherFileOnceLinked_exits1AndLeavesThatFileInPlace', (t) => {
    const dir = makeProject(t);
    const recordPath = checkedFree(dir);
    let tempName;

    const { error } = publishing(dir, recordPath, {
      linkSync: (existing, name) => {
        tempName = existing;
        real.renameSync(existing, `${existing}.moved-aside`);
        real.writeFileSync(existing, 'A DIFFERENT FILE');
        return real.linkSync(existing, name);
      },
    });

    assert.ok(tempName, 'without --replace the record must be published as a hard link');
    assert.ok(error instanceof CliError && error.exitCode === EXIT.FAILED, `expected exit 1: ${error?.exitCode} ${error?.message}`);
    assert.equal(fs.readFileSync(recordPath, 'utf8'), 'A DIFFERENT FILE', 'the entry at the name must not be removed');
    assert.match(error.message, /is not the record this run wrote/);
    assert.match(error.message, /left as it is/);
    assert.equal(fs.readFileSync(tempName, 'utf8'), 'A DIFFERENT FILE', 'nor the temp name, which no longer holds this run\'s file');
  });

  test('publishBedDuckRecord_tempNameCannotBeRemovedOncePublished_publishesAndWarnsNamingIt', (t) => {
    const dir = makeProject(t);
    const recordPath = checkedFree(dir);
    let refused;

    const { result, error } = publishing(dir, recordPath, {
      unlinkSync: (name, ...rest) => {
        if (!String(name).includes(`${RECORD}.part-`)) return real.unlinkSync(name, ...rest);
        refused = String(name);
        throw eperm('unlink');
      },
    });

    assert.ok(refused, 'the temp name must have been removed, or this tests nothing');
    assert.equal(error, undefined, 'a leftover temp name is not a failed publish');
    assert.equal(result.path, recordPath);
    assert.deepEqual(JSON.parse(fs.readFileSync(recordPath, 'utf8')), RECORD_BODY);
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes(refused), `the warning must name ${refused}: ${result.warnings[0]}`);
    assert.match(result.warnings[0], /EPERM/);
  });

  // A close can be the step that reports a failed write: close(2) returns an error from an
  // earlier write, over NFS or against a disk quota. So once the record is published, a
  // descriptor that cannot be closed fails the publish, unlike a leftover temp name. The
  // record is left at its name, never removed by name, and the error says how to clear it.
  // The failure is staged as close(2) behaves: the descriptor is released, then EIO.
  const closeFailsOncePublished = ({ replace = false } = {}) => {
    const staged = { published: false, failed: false };
    const publish = replace ? 'renameSync' : 'linkSync';
    return {
      staged,
      overrides: {
        [publish]: (...args) => {
          const done = real[publish](...args);
          staged.published = true;
          return done;
        },
        closeSync: (fd, ...rest) => {
          if (!staged.published || staged.failed) return real.closeSync(fd, ...rest);
          real.closeSync(fd, ...rest);
          staged.failed = true;
          throw Object.assign(new Error('EIO: i/o error, close'), { code: 'EIO' });
        },
      },
    };
  };
  const failedPublish = ({ result, error }) =>
    `expected exit 1, got ${error ? `${error.exitCode} ${error.message}` : `success, warnings ${JSON.stringify(result.warnings)}`}`;

  test('publishBedDuckRecord_closeFailsOncePublished_exits1LeavingTheRecordAtItsName', (t) => {
    const dir = makeProject(t);
    const recordPath = checkedFree(dir);
    const { staged, overrides } = closeFailsOncePublished();

    const outcome = publishing(dir, recordPath, overrides);

    assert.equal(staged.failed, true, 'the close must have failed after the link, or this tests nothing');
    const { error } = outcome;
    assert.ok(error instanceof CliError && error.exitCode === EXIT.FAILED, failedPublish(outcome));
    assert.ok(
      error.message.includes(`the ducking record was published at ${recordPath} and has been left there`),
      `the error must say the record is at its name: ${error.message}`,
    );
    assert.match(error.message, /the file it was written through could not be closed \(EIO\), so what was written to it cannot be confirmed\./);
    assert.match(error.message, /Move it aside, or re-run with --replace to overwrite it\./);
    assert.deepEqual(JSON.parse(fs.readFileSync(recordPath, 'utf8')), RECORD_BODY, 'the record must be left at its name');
    assert.deepEqual(fs.readdirSync(dir), [RECORD], 'and no temp file may be left behind');
  });

  test('publishBedDuckRecord_withReplaceCloseFailsOncePublished_exits1LeavingTheRecordAtItsName', (t) => {
    const dir = makeProject(t, { [RECORD]: 'THE RECORD BEING REPLACED' });
    const recordPath = checkedFree(dir, true);
    const { staged, overrides } = closeFailsOncePublished({ replace: true });

    const outcome = publishing(dir, recordPath, overrides, { replace: true });

    assert.equal(staged.failed, true, 'the close must have failed after the rename, or this tests nothing');
    const { error } = outcome;
    assert.ok(error instanceof CliError && error.exitCode === EXIT.FAILED, failedPublish(outcome));
    assert.ok(
      error.message.includes(`the ducking record was published at ${recordPath} and has been left there`),
      `the error must say the record is at its name: ${error.message}`,
    );
    assert.match(error.message, /the file it was written through could not be closed \(EIO\), so what was written to it cannot be confirmed\./);
    assert.match(error.message, /Move it aside, or re-run with --replace to overwrite it\./);
    assert.deepEqual(JSON.parse(fs.readFileSync(recordPath, 'utf8')), RECORD_BODY, 'the record must be left at its name');
    assert.deepEqual(fs.readdirSync(dir), [RECORD], 'and no temp file may be left behind');
  });

  // What else the publish had to leave is still reported, beside the failure.
  test('publishBedDuckRecord_closeFailsOncePublishedAndTheTempNameStays_exits1NamingTheTempName', (t) => {
    const dir = makeProject(t);
    const recordPath = checkedFree(dir);
    const { staged, overrides } = closeFailsOncePublished();
    let refused;

    const outcome = publishing(dir, recordPath, {
      ...overrides,
      unlinkSync: (name, ...rest) => {
        if (!String(name).includes(`${RECORD}.part-`)) return real.unlinkSync(name, ...rest);
        refused = String(name);
        throw eperm('unlink');
      },
    });

    assert.equal(staged.failed, true, 'the close must have failed after the link, or this tests nothing');
    assert.ok(refused, 'the temp name must have been removed, or this tests nothing');
    const { error } = outcome;
    assert.ok(error instanceof CliError && error.exitCode === EXIT.FAILED, failedPublish(outcome));
    assert.match(error.message, /could not be closed \(EIO\)/);
    assert.ok(error.message.includes(`its temp name ${refused} could not be removed (EPERM)`), error.message);
    assert.deepEqual(JSON.parse(fs.readFileSync(recordPath, 'utf8')), RECORD_BODY, 'the record must be left at its name');
  });

  // --replace keeps the rename, now from an unguessable temp name that is never removed by
  // name unless it still holds this run's file.
  test('publishBedDuckRecord_withReplaceRenameFails_exits1AndRemovesOnlyItsOwnTemp', (t) => {
    const dir = makeProject(t, { [RECORD]: 'THE RECORD BEING REPLACED' });
    const recordPath = checkedFree(dir, true);
    let tempName;

    const { error } = publishing(
      dir,
      recordPath,
      {
        renameSync: (from) => {
          tempName = from;
          throw eperm('rename');
        },
      },
      { replace: true },
    );

    assert.match(path.basename(tempName ?? ''), /\.part-\d+-[0-9a-f]{16}$/, 'the temp name must not be guessable');
    assert.ok(error instanceof CliError && error.exitCode === EXIT.FAILED, `expected exit 1: ${error?.exitCode} ${error?.message}`);
    assert.equal(fs.readFileSync(recordPath, 'utf8'), 'THE RECORD BEING REPLACED');
    assert.deepEqual(fs.readdirSync(dir), [RECORD], 'the temp file, still this run\'s, is removed');
  });

  // The "appeared after" refusal advises --replace only where --replace can work: over a
  // regular file. It refuses a link, and cannot replace a directory, so for those the way
  // out is to move the entry aside. What is at the name is read by lstat, never through it.
  const ADVISES_REPLACE = /re-run with --replace/;

  test('publishBedDuckRecord_regularFileAtTheName_refusesAdvisingReplace', (t) => {
    const dir = makeProject(t);
    const recordPath = checkedFree(dir);
    fs.writeFileSync(recordPath, 'PLANTED AFTER THE CHECK');

    const { error } = publishing(dir, recordPath, {});

    assert.ok(refusedAsAppeared(error), `expected the exit-2 "appeared after" refusal: ${error?.exitCode} ${error?.message}`);
    assert.equal(fs.readFileSync(recordPath, 'utf8'), 'PLANTED AFTER THE CHECK');
    assert.match(error.message, /It has been left exactly as it is\. Move it aside, or re-run with --replace to overwrite it\./);
  });

  test('publishBedDuckRecord_directoryAtTheName_refusesWithoutAdvisingReplace', (t) => {
    const dir = makeProject(t);
    const recordPath = checkedFree(dir);
    fs.mkdirSync(recordPath);
    fs.writeFileSync(path.join(recordPath, 'inside.txt'), 'KEEP');

    const { error } = publishing(dir, recordPath, {});

    assert.ok(refusedAsAppeared(error), `expected the exit-2 "appeared after" refusal: ${error?.exitCode} ${error?.message}`);
    assert.deepEqual(fs.readdirSync(recordPath), ['inside.txt'], 'the directory must be left as it is');
    assert.equal(fs.readFileSync(path.join(recordPath, 'inside.txt'), 'utf8'), 'KEEP');
    assert.deepEqual(fs.readdirSync(dir), [RECORD], 'and no temp file may be left behind');
    assert.doesNotMatch(error.message, ADVISES_REPLACE, '--replace cannot replace a directory, so it must not be advised');
    assert.match(error.message, /It has been left exactly as it is\. Move it aside: it is a directory, and --replace does not overwrite a directory\./);
  });

  test('publishBedDuckRecord_danglingLinkAtTheName_refusesWithoutAdvisingReplace', (t) => {
    const dir = makeProject(t);
    const victim = path.join(makeOutsideDir(t), 'created-through-the-link.json');
    const recordPath = checkedFree(dir);
    if (!tryMakeFileLink(recordPath, victim)) return t.skip('platform refused to create a file link');

    const { error } = publishing(dir, recordPath, {});

    assert.ok(refusedAsAppeared(error), `expected the exit-2 "appeared after" refusal: ${error?.exitCode} ${error?.message}`);
    assert.equal(fs.lstatSync(recordPath).isSymbolicLink(), true, 'the link must be left as it is');
    assert.equal(fs.readlinkSync(recordPath), victim);
    assert.equal(fs.existsSync(victim), false, 'nothing may be created where it points');
    assert.doesNotMatch(error.message, ADVISES_REPLACE, '--replace refuses a link, so it must not be advised');
    assert.match(error.message, /Move it aside: it is a link, and --replace does not overwrite a link\./);
  });

  test('publishBedDuckRecord_junctionAtTheName_refusesWithoutAdvisingReplace', (t) => {
    const dir = makeProject(t);
    const outside = makeOutsideDir(t, { 'victim.json': 'ORIGINAL VICTIM' });
    const recordPath = checkedFree(dir);
    if (!tryMakeDirLink(recordPath, outside)) return t.skip('platform refused to create a directory link');

    const { error } = publishing(dir, recordPath, {});

    assert.ok(refusedAsAppeared(error), `expected the exit-2 "appeared after" refusal: ${error?.exitCode} ${error?.message}`);
    assert.equal(fs.lstatSync(recordPath).isSymbolicLink(), true, 'the junction must be left as it is');
    assert.deepEqual(fs.readdirSync(outside), ['victim.json'], 'and nothing written where it points');
    assert.equal(fs.readFileSync(path.join(outside, 'victim.json'), 'utf8'), 'ORIGINAL VICTIM');
    assert.doesNotMatch(error.message, ADVISES_REPLACE, '--replace refuses a link, so it must not be advised');
    assert.match(error.message, /it is a link, and --replace does not overwrite a link/, 'a junction is a link, read without following it');
  });

  // The same decision where the link itself is the guard: the directory appears inside the
  // publish's own first open, after every check that could have seen it.
  test('publishBedDuckRecord_directoryPlantedAtTheNameDuringTheOpen_refusesWithoutAdvisingReplace', (t) => {
    const dir = makeProject(t);
    const recordPath = checkedFree(dir);
    let planted = false;

    const { error } = publishing(dir, recordPath, {
      openSync: (...args) => {
        if (!planted) {
          planted = true;
          fs.mkdirSync(recordPath);
        }
        return real.openSync(...args);
      },
    });

    assert.equal(planted, true, 'the directory must have appeared inside the publish, or this tests nothing');
    assert.ok(refusedAsAppeared(error), `expected the exit-2 "appeared after" refusal: ${error?.exitCode} ${error?.message}`);
    assert.equal(fs.lstatSync(recordPath).isDirectory(), true, 'the directory must be left as it is');
    assert.deepEqual(fs.readdirSync(recordPath), []);
    assert.deepEqual(fs.readdirSync(dir), [RECORD], 'and no temp file may be left behind');
    assert.doesNotMatch(error.message, ADVISES_REPLACE, '--replace cannot replace a directory, so it must not be advised');
    assert.match(error.message, /Move it aside: it is a directory, and --replace does not overwrite a directory\./);
  });

  const NOT_ADVISED =
    /Move it aside: it could not be confirmed to be a regular file that --replace would overwrite, so --replace is not advised\./;

  // What is at the name is read when the refusal is written. The link can report EEXIST for
  // an entry that is gone by then, or that cannot be examined: neither is known to be a
  // regular file, so --replace is not advised, and the refusal is still the refusal. An
  // entry that is gone leaves nothing to move aside: the way out is to re-run.
  test('publishBedDuckRecord_entryGoneWhenTheRefusalIsWritten_refusesWithoutAdvisingReplace', (t) => {
    const dir = makeProject(t);
    const recordPath = checkedFree(dir);

    const { error } = publishing(dir, recordPath, {
      linkSync: (_existing, newPath) => {
        throw Object.assign(new Error(`EEXIST: file already exists, link -> '${newPath}'`), { code: 'EEXIST' });
      },
    });

    assert.ok(refusedAsAppeared(error), `expected the exit-2 "appeared after" refusal: ${error?.exitCode} ${error?.message}`);
    assert.deepEqual(fs.readdirSync(dir), [], 'nothing is at the name, and no temp file may be left behind');
    assert.doesNotMatch(error.message, ADVISES_REPLACE, 'an entry no longer there is not known to be a regular file');
    assert.match(error.message, /It has been left exactly as it is\. Nothing is at that name now, so re-run without --replace\./);
    assert.doesNotMatch(error.message, /Move it aside/, 'nothing is at the name, so there is nothing to move aside');
  });

  test('publishBedDuckRecord_entryAtTheNameCannotBeExamined_refusesWithoutAdvisingReplace', (t) => {
    const dir = makeProject(t);
    const recordPath = checkedFree(dir);
    let planted = false;
    let linking = false;

    const { error } = publishing(dir, recordPath, {
      openSync: (...args) => {
        if (!planted) {
          planted = true;
          real.writeFileSync(recordPath, 'PLANTED DURING THE OPEN');
        }
        return real.openSync(...args);
      },
      linkSync: (...args) => {
        linking = true;
        return real.linkSync(...args);
      },
      lstatSync: (candidate, ...rest) => {
        if (linking && String(candidate).endsWith(RECORD)) {
          throw Object.assign(new Error(`EACCES: permission denied, lstat '${candidate}'`), { code: 'EACCES' });
        }
        return real.lstatSync(candidate, ...rest);
      },
    });

    assert.equal(linking, true, 'the refusal must come from the link itself, or this tests nothing');
    assert.ok(refusedAsAppeared(error), `expected the exit-2 "appeared after" refusal: ${error?.exitCode} ${error?.message}`);
    assert.equal(fs.readFileSync(recordPath, 'utf8'), 'PLANTED DURING THE OPEN', 'it must be left exactly as it was');
    assert.deepEqual(fs.readdirSync(dir), [RECORD], 'and no temp file may be left behind');
    assert.doesNotMatch(error.message, ADVISES_REPLACE, 'an entry that cannot be examined is not known to be a regular file');
    assert.match(error.message, NOT_ADVISED);
  });

  // --replace is advised only at a name that passes the link check a --replace run meets.
  // Here a parent directory became a junction: the file at the name is regular, but the
  // path to it is refused whatever --replace says.
  test('publishBedDuckRecord_regularFileReachedThroughALinkedParent_refusesWithoutAdvisingReplace', (t) => {
    const dir = makeProject(t, { [path.join('elsewhere', RECORD)]: 'REACHED THROUGH THE LINK' });
    fs.mkdirSync(path.join(dir, 'sub'));
    const recordPath = resolveEngineOutput(dir, path.join('sub', RECORD), {
      apply: true, replace: false, label: 'ducking record',
    });
    fs.rmdirSync(path.join(dir, 'sub'));
    if (!tryMakeDirLink(path.join(dir, 'sub'), path.join(dir, 'elsewhere'))) {
      return t.skip('platform refused to create a directory link');
    }
    const reached = path.join(dir, 'elsewhere', RECORD);

    const { error } = publishing(dir, recordPath, {});

    assert.ok(refusedAsAppeared(error), `expected the exit-2 "appeared after" refusal: ${error?.exitCode} ${error?.message}`);
    assert.equal(fs.readFileSync(reached, 'utf8'), 'REACHED THROUGH THE LINK', 'the file must be left as it is');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'elsewhere')), [RECORD], 'and no temp file may be left behind');
    assert.doesNotMatch(error.message, ADVISES_REPLACE, 'the link check refused this path, and --replace meets it too');
    assert.match(error.message, NOT_ADVISED);

    // Which is so: with --replace the same path is refused, and the file is untouched.
    const { error: replacing } = publishing(dir, recordPath, {}, { replace: true });
    assert.ok(
      replacing instanceof CliError && replacing.exitCode === EXIT.USAGE && /through a link/.test(replacing.message),
      `expected the exit-2 link refusal: ${replacing?.exitCode} ${replacing?.message}`,
    );
    assert.equal(fs.readFileSync(reached, 'utf8'), 'REACHED THROUGH THE LINK');
  });
});

// --------------------------------------------------------------------------------------
// D-m1 — vo-envelope binds the bytes it measured
// --------------------------------------------------------------------------------------

describe('vo-envelope binds the bytes it measured', () => {
  // vo-envelope hashed the voice on one read and decoded it on a second, with a browser
  // launch in between — so the recorded fingerprint could name bytes that were never
  // measured. The fake page.goto() swaps the file inside that window, deterministically.
  test('voEnvelope_voiceReplacedWhileTheBrowserLoads_bindsTheBytesItActuallyMeasured', (t) => {
    const original = frames(50);
    const replacement = frames(50, 0x40);
    const outside = makeOutsideDir(t, { 'replacement.mp3': replacement });
    const dir = makeProject(t, { 'voiceover.mp3': original });

    const r = runScript('vo-envelope.mjs', ['--apply'], dir, {
      nodeArgs: ['--import', FAKE_AUDIO],
      env: {
        FAKE_PLAYWRIGHT_GOTO_SWAP: path.join(dir, 'voiceover.mp3'),
        FAKE_PLAYWRIGHT_GOTO_SWAP_WITH: path.join(outside, 'replacement.mp3'),
      },
    });

    assertCleanExit(r, EXIT.OK);
    assert.ok(
      fs.readFileSync(path.join(dir, 'voiceover.mp3')).equals(replacement),
      'the seam must actually have swapped the file, or this tests nothing',
    );
    const envelope = JSON.parse(fs.readFileSync(path.join(dir, 'vo-envelope.json'), 'utf8'));
    const measuredVoiced = envelope.rms.some((v) => Math.abs(v - VOICED_LEVEL) < 1e-6);
    const measured = measuredVoiced ? replacement : original;
    assert.equal(
      envelope.measuredFrom.sha256,
      sha256Of(measured),
      `the binding must name the bytes whose rms it records (the rms is ${measuredVoiced ? 'the replacement' : 'the original'})`,
    );
    assert.equal(envelope.measuredFrom.bytes, measured.length);
  });
});

// --------------------------------------------------------------------------------------
// The swap seam above acts only on files the suite made
// --------------------------------------------------------------------------------------

describe('the fake page.goto() swap is confined to suite-owned files', () => {
  // runScript hands the child the parent's whole environment, so two FAKE_PLAYWRIGHT_*
  // variables inherited from a shell would make every fake-audio run copy one arbitrary
  // file over another. The victims here live in a DIFFERENTLY prefixed temp directory, so a
  // regression can only ever damage a file this test made.
  const foreignDir = (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sizzlecraft-seam-'));
    t.after(() => removeFixture(dir));
    return dir;
  };
  const runSwapping = (dir, target, source) =>
    runScript('vo-envelope.mjs', ['--apply'], dir, {
      nodeArgs: ['--import', FAKE_AUDIO],
      env: { FAKE_PLAYWRIGHT_GOTO_SWAP: target, FAKE_PLAYWRIGHT_GOTO_SWAP_WITH: source },
    });
  // The fixture fails by throwing, which the stage reports as a stack at exit 1 — loud.
  const assertRefusedLoudly = (r, variable, dir) => {
    assert.equal(r.code, EXIT.FAILED, `the run must fail, not skip the swap\n${r.all}`);
    assert.match(r.all, new RegExp(`\\$${variable}\\b.*refusing to touch it`), `naming $${variable}`);
    assert.equal(fs.existsSync(path.join(dir, 'vo-envelope.json')), false, 'and nothing may be written');
  };

  test('fakePlaywrightGoto_swapTargetOutsideASuiteOwnedDir_failsTheRunAndCopiesNothing', (t) => {
    const victim = path.join(foreignDir(t), 'victim.bin');
    fs.writeFileSync(victim, 'ORIGINAL VICTIM');
    const outside = makeOutsideDir(t, { 'replacement.mp3': frames(50, 0x40) });
    const dir = makeProject(t, { 'voiceover.mp3': frames(50) });

    const r = runSwapping(dir, victim, path.join(outside, 'replacement.mp3'));

    assertRefusedLoudly(r, 'FAKE_PLAYWRIGHT_GOTO_SWAP', dir);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'ORIGINAL VICTIM', 'the file outside must be byte-identical');
  });

  test('fakePlaywrightGoto_swapSourceOutsideASuiteOwnedDir_failsTheRunAndCopiesNothing', (t) => {
    const source = path.join(foreignDir(t), 'replacement.mp3');
    fs.writeFileSync(source, frames(50, 0x40));
    const original = frames(50);
    const dir = makeProject(t, { 'voiceover.mp3': original });

    const r = runSwapping(dir, path.join(dir, 'voiceover.mp3'), source);

    assertRefusedLoudly(r, 'FAKE_PLAYWRIGHT_GOTO_SWAP_WITH', dir);
    assert.ok(fs.readFileSync(path.join(dir, 'voiceover.mp3')).equals(original), 'the target must be byte-identical');
  });

  // Inside a suite-owned directory by name, but a link out of it by content.
  test('fakePlaywrightGoto_swapTargetIsALinkToAForeignFile_failsTheRunAndWritesNothingThroughIt', (t) => {
    const victim = path.join(foreignDir(t), 'victim.bin');
    fs.writeFileSync(victim, 'ORIGINAL VICTIM');
    const outside = makeOutsideDir(t, { 'replacement.mp3': frames(50, 0x40) });
    const dir = makeProject(t, { 'voiceover.mp3': frames(50) });
    if (!tryMakeFileLink(path.join(dir, 'link.mp3'), victim)) return t.skip('platform refused to create a file link');

    const r = runSwapping(dir, path.join(dir, 'link.mp3'), path.join(outside, 'replacement.mp3'));

    assertRefusedLoudly(r, 'FAKE_PLAYWRIGHT_GOTO_SWAP', dir);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'ORIGINAL VICTIM', 'the link must not have been written through');
  });
});
// --------------------------------------------------------------------------------------
// D2-3/D2-2/D2-5 — the duck is IN THE SAMPLES, at the times the envelope describes
//
// Round 2 found that the whole suite passed with make-music's ducking loop removed: every
// test here read the record beside the bed, the exit code, or the log line, and none of
// them read the bed. The duck is the product; it is now decoded and measured.
//
// MEASURED AGAINST A FLAT CONTROL BED FROM THE SAME GENERATOR, not against an absolute
// level. The bed is peak-normalised and fades in and out, so an absolute RMS in a window
// says almost nothing; the ratio to the same window of an un-ducked bed of the same
// --seconds and preset cancels both and leaves exactly the duck.
// --------------------------------------------------------------------------------------

describe('the duck make-music bakes in is in the samples', () => {
  const SR = 48000;
  const HEADER = 44;
  /** The bed is 32-bit float stereo. RMS of the left channel over [startMs, endMs). */
  function rmsOver(bed, startMs, endMs) {
    const i0 = Math.round((startMs / 1000) * SR);
    const i1 = Math.round((endMs / 1000) * SR);
    let sum = 0;
    for (let i = i0; i < i1; i++) {
      const v = bed.readFloatLE(HEADER + i * 8);
      sum += v * v;
    }
    return Math.sqrt(sum / (i1 - i0));
  }
  const dbBelowFlat = (ducked, flat, startMs, endMs) =>
    20 * Math.log10(rmsOver(ducked, startMs, endMs) / rmsOver(flat, startMs, endMs));

  /** The reference depth make-music ducks to: REFERENCE_DUCK_GAIN as dB. */
  const REFERENCE_DUCK_DB = 20 * Math.log10(REFERENCE_DUCK_GAIN);

  /** speechGapSpeech, re-expressed at `hopMs` so the SAME audio is described at any hop. */
  function speechGapSpeechAt(hopMs) {
    const n = (ms) => Math.round(ms / hopMs);
    return [
      ...Array.from({ length: n(1000) }, () => 0.09),
      ...Array.from({ length: n(2000) }, () => 0.0001),
      ...Array.from({ length: n(1000) }, () => 0.09),
    ];
  }

  const envelopeAt = (hopMs, { durationMs, rms = speechGapSpeechAt(hopMs) } = {}) =>
    JSON.stringify({
      durationMs: durationMs ?? rms.length * hopMs,
      hopMs,
      rms,
      measuredFrom: { file: 'voiceover.mp3', bytes: VOICE_BYTES.length, sha256: VOICE_SHA },
    });

  /** Synthesises a 4 s bed, with `env.json` when one is given, and returns its bytes. */
  function bed(t, envelope) {
    const dir = makeProject(t, {
      'voiceover.mp3': VOICE_BYTES,
      ...(envelope === undefined ? {} : { 'env.json': envelope }),
    });
    const r = runScript(
      'make-music.mjs',
      ['--out', 'bed.wav', '--seconds', '4', '--apply', ...(envelope === undefined ? [] : ['--envelope', 'env.json'])],
      dir,
    );
    assertCleanExit(r, EXIT.OK, 'the bed under measurement must have been written: ');
    return fs.readFileSync(path.join(dir, 'bed.wav'));
  }

  // THE TEST MD3 SURVIVED. Deleting the per-sample `g *= duckGain[...]` multiply leaves
  // this at 0.00 dB in both windows and fails on the first assertion.
  //
  // The windows avoid the attack and release ramps: the first phrase runs 0..1000 ms and
  // is measured from 600 ms, the gap runs 1000..3000 ms and is measured from 2600 ms,
  // which is 1.6 s into an 800 ms release.
  test('makeMusic_envelopeWithAPhraseAGapAndAPhrase_attenuatesTheBedUnderSpeechAndLetsItBackUpInTheGap', (t) => {
    const flat = bed(t, undefined);
    const ducked = bed(t, envelopeAt(20));

    const underFirstPhrase = dbBelowFlat(ducked, flat, 600, 950);
    const inTheGap = dbBelowFlat(ducked, flat, 2600, 2950);
    const underSecondPhrase = dbBelowFlat(ducked, flat, 3600, 3950);

    assert.ok(
      Math.abs(underFirstPhrase - REFERENCE_DUCK_DB) <= 1,
      `the bed must sit at the reference depth under speech: ${underFirstPhrase.toFixed(2)} dB vs ${REFERENCE_DUCK_DB.toFixed(2)} dB`,
    );
    assert.ok(
      Math.abs(underSecondPhrase - REFERENCE_DUCK_DB) <= 1,
      `and under the second phrase too: ${underSecondPhrase.toFixed(2)} dB`,
    );
    assert.ok(
      inTheGap > -1.5,
      `and it must have come back up in the gap between them: ${inTheGap.toFixed(2)} dB below flat`,
    );
    assert.ok(
      inTheGap - underFirstPhrase > 5,
      `the gap must be audibly louder than the speech: ${(inTheGap - underFirstPhrase).toFixed(2)} dB apart`,
    );
  });

  // THE POSITIVE CONTROL FOR THE MEASUREMENT. An envelope with no speech in it must leave
  // the bed exactly where the flat control is, so a measurement that reports attenuation
  // for everything is caught here rather than mistaken for a passing duck above.
  test('makeMusic_envelopeWithNoSpeechInIt_leavesTheBedAtTheFlatLevel', (t) => {
    const flat = bed(t, undefined);
    const ducked = bed(t, envelopeAt(20, { rms: Array.from({ length: 200 }, () => 0.0001) }));

    for (const [from, to] of [[600, 950], [2600, 2950], [3600, 3950]]) {
      const delta = dbBelowFlat(ducked, flat, from, to);
      assert.ok(Math.abs(delta) < 0.01, `${from}-${to}ms must be untouched, measured ${delta.toFixed(3)} dB`);
    }
  });

  // D2-2 — THE ENVELOPE'S OWN HOP. make-music hard-coded 20 ms while the envelope carries
  // its own, so the SAME narration described at a coarser hop was read as a different
  // one: measured at hop 40 it ducked the gap by 7.23 dB and the first phrase by only
  // 4.17 dB — it ducked the silence and let the speech through, at exit 0.
  for (const hopMs of [10, 40]) {
    test(`makeMusic_envelopeMeasuredAtA${hopMs}MsHop_ducksTheSameAudioAtTheSameTimesAsAt20Ms`, (t) => {
      const flat = bed(t, undefined);
      const ducked = bed(t, envelopeAt(hopMs));

      const underFirstPhrase = dbBelowFlat(ducked, flat, 600, 950);
      const inTheGap = dbBelowFlat(ducked, flat, 2600, 2950);
      const underSecondPhrase = dbBelowFlat(ducked, flat, 3600, 3950);

      assert.ok(
        Math.abs(underFirstPhrase - REFERENCE_DUCK_DB) <= 1,
        `a ${hopMs} ms hop describes the same speech: ${underFirstPhrase.toFixed(2)} dB vs ${REFERENCE_DUCK_DB.toFixed(2)} dB`,
      );
      assert.ok(
        Math.abs(underSecondPhrase - REFERENCE_DUCK_DB) <= 1,
        `and the same second phrase: ${underSecondPhrase.toFixed(2)} dB`,
      );
      assert.ok(inTheGap > -1.5, `and the same gap: ${inTheGap.toFixed(2)} dB below flat`);
    });
  }

  // The hop is a number of milliseconds, in the range remux-music already enforces. An
  // envelope that does not carry one cannot be read at all: 20 is what vo-envelope writes,
  // not what an envelope means when it says nothing.
  for (const [label, hopMs] of [
    ['negative', -20],
    ['huge', 1e9],
    ['zero', 0],
    ['aString', '20'],
    ['absent', undefined],
  ]) {
    test(`makeMusic_envelopeHopMs_${label}_isRefusedWithoutWritingABed`, (t) => {
      const envelope = JSON.parse(envelopeAt(20));
      if (hopMs === undefined) delete envelope.hopMs;
      else envelope.hopMs = hopMs;
      const dir = makeProject(t, { 'voiceover.mp3': VOICE_BYTES, 'env.json': JSON.stringify(envelope) });

      const r = runScript(
        'make-music.mjs',
        ['--out', 'bed.wav', '--seconds', '4', '--envelope', 'env.json', '--apply'],
        dir,
      );

      assertCleanExit(r, EXIT.USAGE, 'an envelope with no usable hop must be refused: ');
      assert.match(r.all, /"hopMs"/, 'the refusal must name the field');
      assert.equal(fs.existsSync(path.join(dir, 'bed.wav')), false, 'and no bed may be written');
    });
  }

  // D2-5 — THE TWO HALVES MUST AGREE. durationMs and rms.length x hopMs describe the same
  // span, so when they disagree one of them is wrong and nothing here can tell which. A
  // truncated envelope ducks the start of the narration and leaves the rest flat; a padded
  // one holds the duck past the last word. Both used to run at exit 0.
  for (const [label, durationMs] of [
    ['truncated', 2000],
    ['padded', 8000],
  ]) {
    test(`makeMusic_envelope${label[0].toUpperCase()}${label.slice(1)}AgainstItsOwnFrameCount_isRefusedWithoutWritingABed`, (t) => {
      const dir = makeProject(t, {
        'voiceover.mp3': VOICE_BYTES,
        'env.json': envelopeAt(20, { durationMs }),
      });

      const r = runScript(
        'make-music.mjs',
        ['--out', 'bed.wav', '--seconds', '4', '--envelope', 'env.json', '--apply'],
        dir,
      );

      assertCleanExit(r, EXIT.USAGE, 'an envelope that contradicts itself must be refused: ');
      assert.match(r.all, /"durationMs"/, 'the refusal must name the field');
      assert.match(r.all, /4000/, 'and the span its own frames describe');
      assert.equal(fs.existsSync(path.join(dir, 'bed.wav')), false, 'and no bed may be written');
    });
  }

  // THE POSITIVE CONTROL FOR THAT CHECK. vo-envelope measures in whole hops and rounds the
  // duration, so the last hop is partial and the two halves differ by up to one hop. That
  // is what the writer produces and it must keep working.
  for (const [label, durationMs] of [
    ['oneHopShortOfItsFrames', 3980],
    ['aMillisecondOffFromRounding', 3999],
  ]) {
    test(`makeMusic_envelope${label[0].toUpperCase()}${label.slice(1)}_isAcceptedAsTheWriterProducesIt`, (t) => {
      const dir = makeProject(t, {
        'voiceover.mp3': VOICE_BYTES,
        'env.json': envelopeAt(20, { durationMs }),
      });

      const r = runScript(
        'make-music.mjs',
        ['--out', 'bed.wav', '--seconds', '4', '--envelope', 'env.json', '--apply'],
        dir,
      );

      assertCleanExit(r, EXIT.OK, 'a partial last hop is not a disagreement: ');
      assert.equal(fs.existsSync(path.join(dir, 'bed.wav')), true);
    });
  }
});

// --------------------------------------------------------------------------------------
// D2-1 — the bed's DEFAULT name is engine-chosen, so a link at it is refused
// --------------------------------------------------------------------------------------

describe('the bed make-music names for itself refuses a link', () => {
  // THE VICTIM IS INSIDE THE PROJECT. A link that leaves the root is already refused by
  // the boundary, so an outside victim proves nothing about link policy. This one stays
  // in-root, which the boundary deliberately permits for a path the CALLER named — and
  // nobody named `music.wav`, make-music picked it.
  //
  // Measured before the fix, exactly this shape: a 23-byte in-root file was replaced with
  // 384,044 bytes of PCM and the record landed beside the VICTIM, at `secret.txt.duck.json`.
  test('makeMusic_defaultOutputIsALinkToAnotherInRootFile_refusesWithoutWritingThroughIt', (t) => {
    const dir = makeProject(t, { 'notes.md': 'ORIGINAL VICTIM' });
    if (!tryMakeFileLink(path.join(dir, 'music.wav'), path.join(dir, 'notes.md'))) {
      return t.skip('platform refused to create a file link');
    }

    const r = runScript('make-music.mjs', ['--seconds', '2', '--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.USAGE, 'the default bed name is engine-chosen, so a link at it is refused: ');
    assert.match(r.all, /link/i, 'and the refusal must say why');
    assert.equal(fs.readFileSync(path.join(dir, 'notes.md'), 'utf8'), 'ORIGINAL VICTIM');
    assert.equal(
      fs.existsSync(path.join(dir, 'notes.md.duck.json')),
      false,
      'and no record may be written beside the victim either',
    );
    assert.doesNotMatch(r.all, /raw peak/, 'and the refusal must come before minutes of synthesis');
  });

  // THE POSITIVE CONTROL OF THE SAME SHAPE. A path the CALLER named is theirs to redirect:
  // an in-root link at it is followed, exactly as it is for every other user-named output.
  // Without this, refusing every link would pass the test above and break real projects.
  test('makeMusic_namedOutputIsAnInRootLink_followsItAsTheCallerAsked', (t) => {
    const dir = makeProject(t, { 'beds/real.wav': '' });
    if (!tryMakeFileLink(path.join(dir, 'bed.wav'), path.join(dir, 'beds', 'real.wav'))) {
      return t.skip('platform refused to create a file link');
    }

    const r = runScript('make-music.mjs', ['--out', 'bed.wav', '--seconds', '2', '--apply', '--replace'], dir);

    assertCleanExit(r, EXIT.OK, 'a link the caller named is theirs to follow: ');
    assert.ok(fs.statSync(path.join(dir, 'beds', 'real.wav')).size > 44, 'the bed must have landed at the link target');
  });
});

// --------------------------------------------------------------------------------------
// Round-2 review, finding 1: THE CHECK IS NOT THE WRITE
//
// The up-front resolve refuses a link at the engine-chosen bed name, and then synthesis
// runs for minutes before the bytes are written. A link planted in that window was
// followed by `writeFileSync`, which opens with 'w'. This is the same lesson the ducking
// record already learned — "the publish is the no-clobber guard, not the up-front check"
// — applied to the bed itself.
// --------------------------------------------------------------------------------------

describe('the bed make-music names for itself is published, not written through', () => {
  const VICTIM = 'notes.md';
  const PLANTED = 'ORIGINAL VICTIM';

  /** The --import URL that plants a link at `music.wav` inside make-music's own log call. */
  const plantingALinkAtTheBed = (dir) =>
    fixtureUrl('plant-link-on-marker.mjs', {
      marker: 'raw peak',
      target: path.join(dir, 'music.wav'),
      victim: path.join(dir, VICTIM),
    });

  const makeMusicPlantingALink = (dir, extra = []) =>
    runScript('make-music.mjs', ['--seconds', '2', '--apply', ...extra], dir, {
      nodeArgs: ['--import', plantingALinkAtTheBed(dir)],
    });

  // The plant lands after the up-front resolve found the name free and before the bytes
  // are written. Without --replace nothing may be created through it, and the entry that
  // took the name is left exactly as it is.
  test('makeMusic_aLinkAppearsAtTheDefaultBedNameAfterTheUpFrontCheck_refusesAndLeavesTheVictimIntact', (t) => {
    const dir = makeProject(t, { [VICTIM]: PLANTED });

    const r = makeMusicPlantingALink(dir);

    assert.match(r.all, /plant-link-on-marker: planted/, 'the link must have appeared mid-run, or this tests nothing');
    assertCleanExit(r, EXIT.USAGE, 'an entry that took the bed\'s name is not written through: ');
    assert.match(r.all, /appeared after/, 'and the refusal must say it was not there when the run was checked');
    assert.equal(fs.readFileSync(path.join(dir, VICTIM), 'utf8'), PLANTED, 'the victim must keep its bytes');
    assert.equal(fs.lstatSync(path.join(dir, 'music.wav')).isSymbolicLink(), true, 'and the link must be left as it is');
  });

  // --replace covers the bed's own name. It does NOT turn a link into permission to write
  // to whatever it points at: the name is replaced, the link's target is not touched.
  test('makeMusic_aLinkAppearsAtTheDefaultBedNameWithReplace_replacesTheNameNotTheLinksTarget', (t) => {
    const dir = makeProject(t, { [VICTIM]: PLANTED });

    const r = makeMusicPlantingALink(dir, ['--replace']);

    assert.match(r.all, /plant-link-on-marker: planted/, 'the link must have appeared mid-run, or this tests nothing');
    assertCleanExit(r, EXIT.OK, '--replace covers the bed\'s own name: ');
    assert.equal(fs.readFileSync(path.join(dir, VICTIM), 'utf8'), PLANTED, 'the victim must keep its bytes');
    const bed = path.join(dir, 'music.wav');
    assert.equal(
      fs.lstatSync(bed).isSymbolicLink(),
      false,
      'the bed must have replaced the link, not been written through it',
    );
    assert.ok(fs.statSync(bed).size > 44, 'and it must hold a bed');
    assert.deepEqual(
      fs.readdirSync(dir).sort(),
      [VICTIM, 'music.wav', 'music.wav.duck.json'].sort(),
      'and no temp file may be left behind',
    );
  });

  // THE POSITIVE CONTROL OF THE SAME SHAPE. With nothing planted, the ordinary run must
  // still write the bed and its record — so the guard above cannot pass by refusing
  // everything.
  test('makeMusic_nothingPlantedAtTheDefaultBedName_writesTheBedAndItsRecord', (t) => {
    const dir = makeProject(t);

    const r = runScript('make-music.mjs', ['--seconds', '2', '--apply'], dir);

    assertCleanExit(r, EXIT.OK, 'an unobstructed run must still write: ');
    assert.ok(fs.statSync(path.join(dir, 'music.wav')).size > 44);
    assert.deepEqual(
      fs.readdirSync(dir).sort(),
      ['music.wav', 'music.wav.duck.json'],
      'and no temp file may be left behind',
    );
  });
});

// --------------------------------------------------------------------------------------
// Round-2 review, finding 2: an ABSENT durationMs is not a licence to skip the span check
//
// vo-envelope always writes durationMs (vo-envelope.mjs, the only writer). An envelope
// without one did not come from it, and skipping the check for exactly those envelopes
// let a truncated rms array through — the case the check exists for.
// --------------------------------------------------------------------------------------

describe('an envelope must say what span it describes', () => {
  const DUCK_ARGS = ['--duck-db', '11', '--duck-envelope', 'vo-envelope.json'];
  const envelopeWithout = (field) => {
    const envelope = {
      durationMs: 4000,
      hopMs: 20,
      rms: Array.from({ length: 200 }, () => 0.0001),
      measuredFrom: { file: 'voiceover.mp3', bytes: VOICE_BYTES.length, sha256: VOICE_SHA },
    };
    delete envelope[field];
    return JSON.stringify(envelope);
  };

  test('makeMusic_envelopeWithNoDurationMs_isRefusedRatherThanSkippingTheSpanCheck', (t) => {
    const dir = makeProject(t, { 'voiceover.mp3': VOICE_BYTES, 'env.json': envelopeWithout('durationMs') });

    const r = runScript(
      'make-music.mjs',
      ['--out', 'bed.wav', '--seconds', '4', '--envelope', 'env.json', '--apply'],
      dir,
    );

    assertCleanExit(r, EXIT.USAGE, 'an envelope that says nothing about its span must be refused: ');
    assert.match(r.all, /"durationMs"/, 'the refusal must name the field');
    assert.equal(fs.existsSync(path.join(dir, 'bed.wav')), false, 'and no bed may be written');
  });

  test('remuxMusic_envelopeWithNoDurationMs_isRefusedAsAMalformedEnvelope', (t) => {
    const dir = remuxProject(t, { 'vo-envelope.json': envelopeWithout('durationMs') });

    const r = runScript('remux-music.mjs', [...PLAN_ARGS, ...DUCK_ARGS], dir);

    assertCleanExit(r, EXIT.FAILED, 'a malformed envelope is a failed input, not a usage error: ');
    assert.match(r.all, /"durationMs"/, 'the refusal must name the field');
  });

  // THE POSITIVE CONTROL. The envelope vo-envelope actually writes carries both halves and
  // must keep working, or this check has simply banned the format.
  test('makeMusic_envelopeCarryingBothHalves_isAccepted', (t) => {
    const dir = makeProject(t, { 'voiceover.mp3': VOICE_BYTES, 'env.json': envelopeWithout('nothing') });

    const r = runScript(
      'make-music.mjs',
      ['--out', 'bed.wav', '--seconds', '4', '--envelope', 'env.json', '--apply'],
      dir,
    );

    assertCleanExit(r, EXIT.OK, 'a complete envelope must still be accepted: ');
    assert.ok(fs.statSync(path.join(dir, 'bed.wav')).size > 44);
  });
});
// --------------------------------------------------------------------------------------
// Round-2 review (second pass): what a FAILED bed publish removes, and what it claims
//
// Cleanup that deletes by NAME deletes whatever is at the name. A temp name that no longer
// identifies this run's file belongs to someone else, and removing it would make the guard
// perform the destruction it exists to prevent. The ducking record's publish already works
// this way (retireTemp); the bed's now does too.
// --------------------------------------------------------------------------------------

describe('a failed bed publish removes only its own temp, and says what it left', () => {
  const RECORD = 'music.wav.duck.json';
  const BED_TEMP_FRAGMENT = 'music.wav.part-';

  test('makeMusic_bedTempNameNoLongerHoldsThisRunsFileWhenTheRenameFails_leavesItAndSaysSo', (t) => {
    const dir = makeProject(t);

    const r = runScript('make-music.mjs', ['--seconds', '2', '--apply', '--replace'], dir, {
      nodeArgs: ['--import', fixtureUrl('substitute-on-rename.mjs', { dir, fragment: BED_TEMP_FRAGMENT })],
    });

    assert.match(
      r.all,
      /substitute-on-rename: failed the rename/,
      'the rename must actually have failed and the name been substituted, or this tests nothing',
    );
    assertCleanExit(r, EXIT.FAILED, 'a bed that could not be published is a failed run: ');
    const leftover = fs.readdirSync(dir).filter((name) => name.startsWith(BED_TEMP_FRAGMENT));
    assert.equal(leftover.length, 1, `the temp must have been LEFT, not deleted: ${fs.readdirSync(dir).join(', ')}`);
    assert.match(r.all, /no longer holds the file this run wrote/, 'and the run must say why it left it');
    assert.ok(r.all.includes(leftover[0]), `and name it\n${r.all}`);
    assert.equal(fs.existsSync(path.join(dir, 'music.wav')), false, 'and no bed may be at the name');
  });

  // THE POSITIVE CONTROL OF THE SAME SHAPE. When the temp name DOES still hold this run's
  // file, a failed publish must clean up after itself — or "leave it" would just be a
  // licence to strand temp files on every failure.
  test('makeMusic_bedTempStillHoldsThisRunsFileWhenTheRenameFails_removesItLeavingNothingBehind', (t) => {
    const dir = makeProject(t);

    const r = runScript('make-music.mjs', ['--seconds', '2', '--apply', '--replace'], dir, {
      nodeArgs: ['--import', fixtureUrl('fail-rename.mjs', { dir, fragment: BED_TEMP_FRAGMENT })],
    });

    assert.match(r.all, /fail-rename: failed the rename/, 'the rename must actually have failed, or this tests nothing');
    assertCleanExit(r, EXIT.FAILED, 'a bed that could not be published is a failed run: ');
    assert.deepEqual(fs.readdirSync(dir), [RECORD], 'only the record may be left — no temp, no bed');
  });

  // A CLOSE THAT FAILS AFTER THE RENAME IS NOT A FAILED PUBLISH. The bed IS at its name;
  // what cannot be confirmed is what was written to it. Reporting that as "the bed was not
  // written" sends someone looking for a file that is sitting right there.
  test('makeMusic_bedPublishedButItsDescriptorCannotBeClosed_saysItIsAtItsNameRatherThanUnwritten', (t) => {
    const dir = makeProject(t);

    const r = runScript('make-music.mjs', ['--seconds', '2', '--apply', '--replace'], dir, {
      nodeArgs: ['--import', failClose({ dir, fragment: BED_TEMP_FRAGMENT })],
    });

    assert.match(r.all, /fail-close: failed/, 'the close must actually have failed, or this tests nothing');
    assertCleanExit(r, EXIT.FAILED, 'bytes that cannot be confirmed fail the run: ');
    assert.match(r.all, /cannot be confirmed/, 'and the run must say what it could not confirm');
    assert.doesNotMatch(
      r.all,
      /describes a bed that was not written/,
      'and it must not claim the bed is missing when it is at its name',
    );
    assert.ok(fs.statSync(path.join(dir, 'music.wav')).size > 44, 'the bed must be at its name');
  });
});
// --------------------------------------------------------------------------------------
// Round-2 review (third pass): the identity check's verdicts are DISTINCT
//
// `isOpenedAt` collapses four different findings into false, and a message that names one
// of them states a cause that was never established: "another entry took its place" and
// "this volume gives no file identity" are not the same fact. make-music's bed publish
// reports the verdict it got, so the states have to survive the call.
// --------------------------------------------------------------------------------------

describe('the identity check keeps its verdicts apart', () => {
  test('openedAtState_eachCondition_isReportedAsItsOwnVerdictRatherThanOneFalse', (t) => {
    const dir = makeProject(t, { 'someone-else.json': 'SOMEONE ELSE' });
    const fd = fs.openSync(path.join(dir, 'ours.json'), 'wx+');
    try {
      assert.equal(openedAtState(fd, path.join(dir, 'ours.json')), 'same');
      assert.equal(openedAtState(fd, path.join(dir, 'someone-else.json')), 'different');
      assert.equal(openedAtState(fd, path.join(dir, 'nothing-here.json')), 'absent');
      assert.equal(openedAtState(-1, path.join(dir, 'ours.json')), 'unchecked', 'a stat that throws is not a mismatch');
    } finally {
      fs.closeSync(fd);
    }
  });

  // The boolean must still agree with the verdict, or the two would be separate rules.
  // Every state it can return, including the two that are not about a different file.
  test('isOpenedAt_everyVerdict_isTrueOnlyForSame', (t) => {
    const dir = makeProject(t, { 'someone-else.json': 'SOMEONE ELSE' });
    const fd = fs.openSync(path.join(dir, 'ours.json'), 'wx+');
    const realLstat = fs.lstatSync;
    try {
      for (const name of ['ours.json', 'someone-else.json', 'nothing-here.json']) {
        const target = path.join(dir, name);
        assert.equal(isOpenedAt(fd, target), openedAtState(fd, target) === 'same', name);
      }
      // 'unchecked': the stat itself fails.
      const missingFd = -1;
      assert.equal(openedAtState(missingFd, path.join(dir, 'ours.json')), 'unchecked');
      assert.equal(isOpenedAt(missingFd, path.join(dir, 'ours.json')), false, 'unchecked is not a match');

      // 'unavailable': a volume that gives no file ID reports inode 0 on both sides, and
      // two files that both report none must not pass as one.
      fs.lstatSync = (candidate, ...rest) => {
        const st = realLstat(candidate, ...rest);
        if (st !== null && typeof st === 'object' && 'ino' in st) st.ino = typeof st.ino === 'bigint' ? 0n : 0;
        return st;
      };
      const ours = path.join(dir, 'ours.json');
      assert.equal(openedAtState(fd, ours), 'unavailable');
      assert.equal(isOpenedAt(fd, ours), false, 'an identity that cannot be asked is not a match');
    } finally {
      fs.lstatSync = realLstat;
      fs.closeSync(fd);
    }
  });
});
// --------------------------------------------------------------------------------------
// Round-2 review (fourth pass): the bed publish REPORTS the verdict it got
//
// The rename lands, and then the name cannot be shown to hold what was published there.
// Four different findings produce that, and naming one of them for all four states a cause
// that was never established. Each is driven through make-music here, not just through the
// identity check, because the message and the exit code are the contract a caller sees.
// --------------------------------------------------------------------------------------

describe('a bed whose name cannot be confirmed says which thing it found', () => {
  const confusingTheBed = (dir, verdict) =>
    fixtureUrl('confuse-after-rename.mjs', { dir, name: 'music.wav', verdict });

  for (const [verdict, why] of [
    ['different', /another entry took its place as it was renamed/],
    ['absent', /nothing is at that name any more/],
    ['unavailable', /this filesystem gives no file identity to check/],
    ['unchecked', /it could not be examined/],
  ]) {
    test(`makeMusic_bedNameReports${verdict[0].toUpperCase()}${verdict.slice(1)}AfterTheRename_refusesSayingThatAndNotSomethingElse`, (t) => {
      const dir = makeProject(t);

      const r = runScript('make-music.mjs', ['--seconds', '2', '--apply', '--replace'], dir, {
        nodeArgs: ['--import', confusingTheBed(dir, verdict)],
      });

      assert.match(
        r.all,
        /confuse-after-rename: renamed onto/,
        'the rename must have landed and the name been confused, or this tests nothing',
      );
      assertCleanExit(r, EXIT.FAILED, 'a bed that cannot be confirmed fails the run: ');
      assert.match(r.all, /cannot be confirmed as the bed this run just published there/);
      assert.match(r.all, why, `the refusal must report ${verdict}\n${r.all}`);
      for (const [other, otherWhy] of [
        ['different', /another entry took its place/],
        ['absent', /nothing is at that name any more/],
        ['unavailable', /gives no file identity/],
        ['unchecked', /it could not be examined/],
      ]) {
        if (other !== verdict) assert.doesNotMatch(r.all, otherWhy, `and must not also claim ${other}`);
      }
    });
  }
});