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
import path from 'node:path';
import crypto from 'node:crypto';

import { EXIT, CliError } from '../src/cli-support.mjs';
import { createMixAudit, MIX_PARAMETERS } from '../src/mix-parameters.mjs';
import {
  SPEECH_RMS_THRESHOLD,
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
} from '../src/envelope-ducking.mjs';
import { makeProject, runScript, assertCleanExit, MISSING_FFMPEG } from './_helpers.mjs';

// --------------------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------------------

const VOICE_BYTES = Buffer.from('a fake narration track — only its bytes matter here');
const VOICE_SHA = crypto.createHash('sha256').update(VOICE_BYTES).digest('hex');

/** An envelope bound to VOICE_BYTES: speech, then a gap, in 20 ms hops. */
function boundEnvelope({ rms = speechThenGap(), file = 'voiceover.mp3', sha256 = VOICE_SHA } = {}) {
  return JSON.stringify({
    durationMs: rms.length * 20,
    hopMs: 20,
    rms,
    measuredFrom: { file, bytes: VOICE_BYTES.length, sha256 },
  });
}

/** 2 s of speech at a realistic level, then a 2 s gap at digital-silence level. */
function speechThenGap(speechMs = 2000, gapMs = 2000, level = 0.09) {
  return [
    ...Array.from({ length: speechMs / 20 }, () => level),
    ...Array.from({ length: gapMs / 20 }, () => 0.0001),
  ];
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
    const m = measureSpeech({ rms: speechThenGap(), hopMs: 20, threshold: SPEECH_RMS_THRESHOLD });

    assert.equal(m.speechFrames, 100, '2 s of speech at 20 ms hops');
    assert.ok(Math.abs(m.speechRms - 0.09) < 1e-9);
    assert.equal(m.gaps.count, 1);
    assert.equal(m.gaps.longestMs, 2000);
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

  test('calibrateDuckThreshold_depthDeeperThanFfmpegsThresholdRange_clampsRatherThanEmittingAnIllegalValue', () => {
    const threshold = calibrateDuckThreshold({ speechRms: 0.0005, voiceGain: 1, duckDb: 40, ratio: 2 });

    assert.ok(threshold >= 0.000976563, 'ffmpeg refuses a sidechaincompress threshold below its minimum');
    assert.ok(threshold <= 1);
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

    assert.equal(mix.use('duckDb'), '0.023286', 'the graph carries the solved threshold');
  });

  // A pinned knob has to be accounted for on EVERY run, including the runs where it is
  // switched off — otherwise "ducking was off" is a fact the pin cannot record, and
  // turning ducking on later moves the delivered mix behind a pin still reporting valid.
  test('declareAbsent_pinnedParameterNotInForce_isRecordedByThePinRatherThanOmitted', () => {
    const mix = createMixAudit();
    mix.declare('voiceGain', { value: 1.4 });
    mix.declare('musicGain', { value: 0.117 });
    mix.declare('ceiling', { value: 2, rendered: 0.794328 });
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
      `[1:a]volume=${mix.use('voiceGain')},pan=stereo|c0=c0|c1=c0,asplit=2[vo][vosc];` +
      `[vosc]apad[vop];` +
      `[2:a]asetpts=N/SR/TB,volume=${mix.use('musicGain')}[mu];` +
      `[mu][vop]sidechaincompress=threshold=${mix.use('duckDb')}:ratio=${mix.use('duckRatio')}` +
      `:attack=${mix.use('duckAttack')}:release=${mix.use('duckRelease')}:knee=2.5[mud];` +
      `[vo][mud]amix=inputs=2:duration=longest:normalize=0[mx];` +
      `[mx]alimiter=limit=${mix.use('ceiling')}:level=disabled[out]`;

    assert.throws(
      () => mix.audit(graph),
      (err) => err instanceof CliError && /2\.5/.test(err.message),
      'an undeclared sidechaincompress option must stop the run',
    );
  });
});

describe('remux-music ducking plan', () => {
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

  test('remuxMusic_noDuckDb_leavesTheGraphExactlyAsItWas', (t) => {
    const dir = remuxProject(t);
    const r = runScript('remux-music.mjs', PLAN_ARGS, dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.doesNotMatch(r.all, /sidechaincompress/, 'ducking is opt-in; the default graph must not change');
    assert.doesNotMatch(r.all, /apad/);
  });

  test('remuxMusic_duckingRequested_writesNothingWithoutApply', (t) => {
    const dir = remuxProject(t, { 'vo-envelope.json': boundEnvelope() });
    runScript('remux-music.mjs', [...PLAN_ARGS, '--duck-db', '11', '--duck-envelope', 'vo-envelope.json'], dir);

    assert.equal(fs.existsSync(path.join(dir, 'out.mp4')), false);
    assert.equal(fs.existsSync(path.join(dir, 'music-gain.lock.json')), false, 'and must not pin anything');
  });
});
