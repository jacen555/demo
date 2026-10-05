// The registration point for values that reach the delivered mix — and the guard that
// fails closed when one arrives undeclared.
//
// The gain pin was defeated by a knob it had never heard of. `--ceiling` sets the
// limiter, so it moves the delivered loudness, and the pin compared a hand-written
// literal that predated it. Adding `ceiling` to that literal would fix the instance and
// leave the class: the next knob would escape the same way.
//
// So the property under test here is not "ceiling is covered" — it is:
//
//   a value cannot reach the mix filter graph without being DECLARED, and if one does,
//   the tool REFUSES rather than proceeding.
//
// Two routes into the graph exist and both are covered: through the registry (`use`,
// which refuses an undeclared name) and around it (raw interpolation, which `audit`
// catches because the literal it leaves behind is traceable to nothing). What neither
// can see is stated in mix-parameters.mjs and asserted at the bottom of this file, so
// the limit is a tested claim rather than a comforting comment.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { CliError, EXIT } from '../src/cli-support.mjs';
import { MIX_PARAMETERS, createMixAudit } from '../src/mix-parameters.mjs';
import { classifyGainPin, confirmedLockRecord } from '../src/gain-pin.mjs';
import { makeProject, runScript, assertCleanExit, pcmWav } from './_helpers.mjs';

/** Declares the set remux-music declares, at the shipped defaults, with ducking OFF. */
function declaredMix() {
  const mix = createMixAudit();
  mix.declare('voiceGain', { value: 1.14 });
  mix.declare('musicGain', { value: 1.5 });
  mix.declare('ceiling', { value: 1, rendered: 0.891251 });
  mix.declare('crossfade', { value: 3 });
  mix.declare('videoSeconds', { value: 38.5 });
  // Ducking is opt-in, and a pinned knob must be accounted for on every run either way.
  for (const name of ['duckDb', 'duckRatio', 'duckAttack', 'duckRelease']) mix.declareAbsent(name);
  return mix;
}

/** The shape remux-music actually builds, looping, with every value taken from the registry. */
function loopingGraph(mix, tail = '') {
  return (
    `[1:a]volume=${mix.use('voiceGain', 'vo')},pan=stereo|c0=c0|c1=c0[vo];` +
    `[2:a][3:a]acrossfade=d=${mix.use('crossfade', 'ml1')}:c1=tri:c2=tri[ml1];` +
    `[ml1][4:a]acrossfade=d=${mix.use('crossfade', 'ml2')}:c1=tri:c2=tri[ml2];` +
    `[ml2]${mix.structural('atrim=0:')}${mix.use('videoSeconds', 'mu')},asetpts=N/SR/TB,volume=${mix.use('musicGain', 'mu')}[mu];` +
    `[vo][mu]${mix.structural('amix=inputs=2:duration=longest:normalize=0')}[mx];` +
    `[mx]alimiter=limit=${mix.use('ceiling', 'out')}:level=disabled${tail}[out]`
  );
}

/** Declares the set remux-music declares with the sidechain duck IN FORCE and no loop. */
function declaredDuckingMix() {
  const mix = createMixAudit();
  mix.declare('voiceGain', { value: 1.4 });
  mix.declare('musicGain', { value: 0.031 });
  mix.declare('ceiling', { value: 2, rendered: 0.794328 });
  mix.declareAbsent('crossfade');
  mix.declare('videoSeconds', { value: 38.5 });
  mix.declare('duckDb', { value: 11, rendered: 0.023 });
  mix.declare('duckRatio', { value: 4 });
  mix.declare('duckAttack', { value: 150 });
  mix.declare('duckRelease', { value: 800 });
  return mix;
}

/** The ducking shape remux-music builds, with every value taken from the registry. */
function duckingGraph(mix) {
  return (
    `[1:a]volume=${mix.use('voiceGain', 'vo')},pan=stereo|c0=c0|c1=c0,${mix.structural('asplit=2')}[vo][vosc];` +
    `[2:a]${mix.structural('atrim=0:')}${mix.use('videoSeconds', 'mu')},asetpts=N/SR/TB,volume=${mix.use('musicGain', 'mu')}[mu];` +
    `[vosc]apad[vop];` +
    `[mu][vop]sidechaincompress=threshold=${mix.use('duckDb', 'mud')}:ratio=${mix.use('duckRatio', 'mud')}` +
    `:attack=${mix.use('duckAttack', 'mud')}:release=${mix.use('duckRelease', 'mud')}[mud];` +
    `[vo][mud]${mix.structural('amix=inputs=2:duration=longest:normalize=0')}[mx];` +
    `[mx]alimiter=limit=${mix.use('ceiling', 'out')}:level=disabled[out]`
  );
}

describe('mix parameter registry', () => {
  test('MIX_PARAMETERS_theKnobsThatSetDeliveredLoudness_areRegisteredAsPinned', () => {
    const pinned = MIX_PARAMETERS.filter((p) => p.pinned).map((p) => p.name);

    // voiceGain WAS DECLARED `pinned: false` AND THAT WAS WRONG. The reasoning was that
    // the pin's question is whether the BED level was agreed to, so the narration bus is
    // none of its business. But the narration is the other half of the balance the bed is
    // set against, and it is the signal fed into the limiter this same change made
    // pinnable — so moving it alone moves the delivered mix while leaving a settled pin
    // reporting valid. The incident behind this whole feature was exactly that: a voice
    // 1.40 / music 0.85 rebalance that shipped a bed 24 dB above target.
    //
    // A voice rebalance is also not the frame-by-frame churn that would train an operator
    // to pass --confirm-gain reflexively (the reason videoSeconds stays unpinned). It is
    // deliberate, rare, and worth a confirmation.
    // The duck knobs joined this set when file-sourced ducking arrived. Each one moves
    // the delivered bed level at the ends of its range — --duck-release at 9000 ms never
    // returns the bed to the gaps level at all.
    //
    // --crossfade joined it for the same reason, having been called a "transition shape"
    // knob. On a looping bed the tri curves on uncorrelated material dip up to -3.01 dB at
    // each overlap's midpoint, about -1.76 dB averaged over the overlap — so at 30 s it
    // sets the bed level for a large share of the running time. It is the voiceGain
    // mistake a second time.
    assert.deepEqual(
      pinned.slice().sort(),
      ['ceiling', 'crossfade', 'duckAttack', 'duckDb', 'duckRatio', 'duckRelease', 'musicGain', 'voiceGain'],
      'every knob that moves the delivered level — both bus gains, the limiter, the loop crossfade and the duck — must be pinned',
    );
  });

  test('declare_nameNotInTheRegistry_refusesRatherThanAcceptingIt', () => {
    const mix = createMixAudit();

    assert.throws(
      () => mix.declare('duckDepth', { value: 0.4 }),
      (err) => err instanceof CliError && /duckDepth/.test(err.message) && /MIX_PARAMETERS/.test(err.message),
      'an undeclared knob must be refused at the point it tries to join the mix',
    );
  });

  test('declare_sameParameterTwice_refusesBecauseOneValueReachesTheGraph', () => {
    const mix = createMixAudit();
    mix.declare('musicGain', { value: 1.5 });

    assert.throws(() => mix.declare('musicGain', { value: 3 }), CliError);
  });

  test('declare_renderedValueThatIsNotAPlainDecimal_refuses', () => {
    const mix = createMixAudit();

    // 1e-7 renders as "1e-7", which is neither a level anyone means nor a literal this
    // audit can account for. Refusing beats auditing a string it cannot read.
    assert.throws(() => mix.declare('musicGain', { value: 0.0000001 }), CliError);
  });

  test('use_parameterThatWasNeverDeclared_refuses', () => {
    const mix = createMixAudit();

    assert.throws(() => mix.use('ceiling', 'out'), CliError, 'a value cannot be used before it is declared');
  });

  test('use_declaredParameter_returnsTheRenderedLiteralNotTheOperatorFacingValue', () => {
    const mix = createMixAudit();
    mix.declare('voiceGain', { value: 1.14 });
    mix.declare('musicGain', { value: 1.5 });
    mix.declare('ceiling', { value: 2, rendered: 0.794328 });
    // pinnedValues refuses a partial set, so the conditional knobs are accounted for too.
    mix.declareAbsent('crossfade');
    for (const name of ['duckDb', 'duckRatio', 'duckAttack', 'duckRelease']) mix.declareAbsent(name);

    assert.equal(mix.use('ceiling', 'out'), '0.794328', 'the graph carries the linear limit');
    assert.equal(mix.pinnedValues().ceiling, 2, 'the pin records the dB the operator actually typed');
  });

  test('pinnedValues_registeredPinnedParameterNeverDeclared_refusesRatherThanPinningAPartialSet', () => {
    const mix = createMixAudit();
    mix.declare('voiceGain', { value: 1.14 });
    mix.declare('musicGain', { value: 1.5 });

    assert.throws(
      () => mix.pinnedValues(),
      (err) => err instanceof CliError && /ceiling/.test(err.message),
      'a pin that silently omits a registered parameter is the defect this exists to stop',
    );
  });

  test('pinnedValues_everyPinnedParameterDeclared_returnsExactlyThatSet', () => {
    assert.deepEqual(declaredMix().pinnedValues(), {
      voiceGain: 1.14,
      musicGain: 1.5,
      ceiling: 1,
      crossfade: 3,
      // NOT_IN_FORCE. Recorded rather than omitted, so turning ducking on is a changed
      // pinned parameter and demands a fresh confirmation.
      duckDb: 0,
      duckRatio: 0,
      duckAttack: 0,
      duckRelease: 0,
    });
  });

  // THE WRITE SHAPE AND THE READ SHAPE MUST BE THE SAME SHAPE. `pinnedValues()` produces
  // what the lock records; `classifyGainPin` consumes it. Nothing else connects them, and
  // a divergence would make every pin unreadable — or worse, readable as a match on a set
  // that is not the set being applied. Neither side names its members, so this is the
  // test that keeps them honest.
  test('pinnedValues_roundTrippedThroughTheLockRecord_isAcceptedByTheClassifier', () => {
    const recorded = declaredMix().pinnedValues();
    const sha256 = 'b'.repeat(64);

    const v = classifyGainPin(
      { source: 'music.wav', sha256, mix: recorded, evidence: 'operator-confirmed' },
      { source: 'music.wav', sha256, mix: declaredMix().pinnedValues() },
    );

    assert.equal(v.requiresConfirmation, false, 'a pin written from the registry must read back as settled');
    assert.deepEqual(v.unrecordedParameters, [], 'and must cover every registered member');
    assert.deepEqual(v.changedParameters, []);
  });

  // THE RECORD AS WRITTEN, NOT AS A TEST SPELLS IT. The test above builds its own lock, so
  // a writer that recorded any other `evidence` would pass it while every pin it wrote read
  // back as unconfirmed. remux-music writes through confirmedLockRecord; this reads that
  // back, through the same JSON round trip the lock file takes.
  test('pinnedValues_roundTrippedThroughTheLockRecordRemuxWrites_isAcceptedByTheClassifier', () => {
    const current = { source: 'music.wav', sha256: 'b'.repeat(64), mix: declaredMix().pinnedValues() };
    const written = JSON.parse(JSON.stringify(confirmedLockRecord(current, '2025-01-01T00:00:00.000Z')));

    const v = classifyGainPin(written, { ...current, mix: declaredMix().pinnedValues() });

    assert.equal(v.requiresConfirmation, false, 'the lock remux-music writes must read back as settled');
    assert.deepEqual(v.unrecordedParameters, []);
    assert.deepEqual(v.changedParameters, []);
  });
});

describe('mix graph audit', () => {
  test('audit_graphBuiltEntirelyFromDeclaredParameters_passes', () => {
    const mix = declaredMix();

    assert.doesNotThrow(() => mix.audit(loopingGraph(mix)));
  });

  test('audit_graphWithNoLoopAndNoTrim_passesWithoutTheOptionalParameters', () => {
    const mix = createMixAudit();
    mix.declare('voiceGain', { value: 1.14 });
    mix.declare('musicGain', { value: 1.5 });
    mix.declare('ceiling', { value: 1, rendered: 0.891251 });

    const graph =
      `[1:a]volume=${mix.use('voiceGain', 'vo')},pan=stereo|c0=c0|c1=c0[vo];` +
      `[2:a]asetpts=N/SR/TB,volume=${mix.use('musicGain', 'mu')}[mu];` +
      `[vo][mu]${mix.structural('amix=inputs=2:duration=longest:normalize=0')}[mx];` +
      `[mx]alimiter=limit=${mix.use('ceiling', 'out')}:level=disabled[out]`;

    assert.doesNotThrow(() => mix.audit(graph));
  });

  // THE CASE THIS WHOLE MECHANISM EXISTS FOR. Envelope ducking adds parameters that move
  // the delivered bed level. Interpolated straight into the graph they leave literals
  // that trace to nothing, and the run must stop there rather than deliver a mix the pin
  // has never heard of.
  test('audit_valueInterpolatedWithoutBeingDeclared_refusesAndNamesTheValue', () => {
    const mix = declaredMix();
    const graph = loopingGraph(mix, ',sidechaincompress=threshold=0.05:ratio=8:attack=20:release=800');

    assert.throws(
      () => mix.audit(graph),
      (err) => {
        assert.ok(err instanceof CliError, 'an unregistered value is a refusal');
        assert.equal(err.exitCode, EXIT.FAILED, 'and not a caller mistake — the registry is incomplete');
        for (const literal of ['0.05', '8', '20', '800']) {
          assert.match(err.message, new RegExp(literal.replace('.', '\\.')), `must name ${literal}`);
        }
        assert.match(err.message, /MIX_PARAMETERS/, 'and must say where to declare it');
        return true;
      },
    );
  });

  test('audit_unregisteredValueThatDuplicatesARegisteredOne_isStillRefused', () => {
    const mix = declaredMix();

    // 1.5 is already musicGain. Accounting by VALUE alone would wave this through;
    // accounting by value AND use-count does not.
    assert.throws(() => mix.audit(loopingGraph(mix, ',volume=1.5')), CliError);
  });

  test('audit_valueUsedThroughTheRegistryButDroppedFromTheGraph_refusesRatherThanPassing', () => {
    const mix = declaredMix();
    const graph = loopingGraph(mix).replace(':level=disabled', ':level=disabled,volume=0.25');

    assert.throws(() => mix.audit(graph), CliError, 'a late edit to the graph must not escape the audit');
  });

  test('audit_structuralLiteralsOfTheGraph_areAccountedForWithoutBeingPinned', () => {
    // atrim's 0 start, amix's inputs=2 and normalize=0 are fixed parts of the graph, not
    // knobs. They are declared as structural so the audit has no reason to be loosened —
    // and a constant that is NOT declared stops the run rather than widening the rule.
    const clean = declaredMix();
    assert.doesNotThrow(() => clean.audit(loopingGraph(clean)));

    const tampered = declaredMix();
    const graph = loopingGraph(tampered).replace('inputs=2', 'inputs=3');
    assert.throws(() => tampered.audit(graph), CliError);
  });

  // A STRUCTURAL LITERAL WAS STRIPPED WHEREVER IT APPEARED, AS OFTEN AS IT APPEARED. So a
  // second split feeding a second mix — which sums two copies of the finished mix, about
  // +6 dB on everything — left no number the scan could see, and the graph read as fully
  // accounted for. The literals are now matched whole, at a filter boundary, exactly as
  // many times as the graph builder emitted them.
  test('audit_duplicatedSplitAndMixPair_isRefusedRatherThanReadAsStructure', () => {
    const mix = declaredDuckingMix();
    const graph = duckingGraph(mix).replace(
      '[mx];[mx]alimiter',
      '[mx0];[mx0]asplit=2[d1][d2];[d1][d2]amix=inputs=2:normalize=0[mx];[mx]alimiter',
    );

    assert.throws(
      () => mix.audit(graph),
      (err) => {
        assert.ok(err instanceof CliError, 'a doubled bus is a refusal');
        assert.equal(err.exitCode, EXIT.FAILED);
        assert.match(err.message, /asplit=2/, 'and the refusal must name the literal that appears too often');
        return true;
      },
      'a second split/mix pair doubles a bus without adding a number, and must not pass as structure',
    );
  });

  test('audit_duckingGraphExactlyAsBuilt_passes', () => {
    const mix = declaredDuckingMix();

    assert.doesNotThrow(() => mix.audit(duckingGraph(mix)));
  });

  // MATCHED WHOLE OR NOT AT ALL. `normalize=0x1` used to lose its `normalize=0` to the
  // strip and leave `x1`, which reads as an identifier — so the run passed. Whether ffmpeg
  // itself would reject 0x1 as a boolean is UNVERIFIED here (no ffmpeg on the machine that
  // wrote this); the audit must not depend on it either way.
  test('audit_structuralLiteralRunIntoFurtherCharacters_isNotStripped', () => {
    const mix = declaredDuckingMix();
    const graph = duckingGraph(mix).replace('normalize=0[mx]', 'normalize=0x1[mx]');

    assert.throws(() => mix.audit(graph), CliError, 'a literal with more attached is not that literal');
  });

  // The same property from the other side: the amix literal is the WHOLE filter, so a
  // change inside it is not the declared structure, even where no new number appears.
  test('audit_amixWithItsOptionsChanged_isNotReadAsTheDeclaredFilter', () => {
    for (const changed of ['amix=inputs=2:normalize=0', 'amix=inputs=2:duration=shortest:normalize=0']) {
      const mix = declaredDuckingMix();
      const graph = duckingGraph(mix).replace('amix=inputs=2:duration=longest:normalize=0', changed);

      assert.throws(() => mix.audit(graph), CliError, `${changed} is not the amix the builder emits`);
    }
  });

  test('audit_structuralLiteralTheGraphBuilderNeverEmitted_isRefused', () => {
    const mix = declaredMix();
    // No duck, so the builder emits no split — one appearing is not structure.
    const graph = loopingGraph(mix).replace('c1=c0[vo]', 'c1=c0,asplit=2[vo][spare]');

    assert.throws(
      () => mix.audit(graph),
      (err) => err instanceof CliError && /asplit=2/.test(err.message),
      'a literal the builder did not emit must be refused, not stripped',
    );
  });

  // An unspent use would leave slack in the accounting, and slack of exactly the right
  // value is indistinguishable from a smuggled literal. The budget must balance both ways.
  test('audit_valueTakenFromTheRegistryButNeverInterpolated_refusesRatherThanLeavingSlack', () => {
    const mix = declaredMix();
    const graph = loopingGraph(mix);

    mix.use('musicGain', 'mu'); // taken, and the string thrown away

    assert.throws(
      () => mix.audit(graph),
      (err) => err instanceof CliError && /--music-gain/.test(err.message),
      'an unspent use must be reported, not absorbed',
    );
  });

  // THE AUDIT MUST NOT HAVE A SHAPE IT CANNOT SEE.
  //
  // The first version of this scan looked for one shape of number — `\d+(\.\d+)?` with a
  // lookbehind that also excluded `.`. So `volume=.5` matched NOTHING: the `5` was
  // preceded by a dot, the lookbehind failed, and a graph carrying an undeclared bed
  // multiplier had, as far as the audit could tell, nothing unaccounted in it. The guard
  // built to stop a knob reaching ffmpeg undeclared waved one through, and the README
  // claimed the opposite.
  //
  // Enumerating more known-good shapes would repeat the mistake one shape later. The
  // property under test is therefore the stronger one: ANY run of characters carrying a
  // digit is either a plain decimal the audit can account for, or an identifier, or it
  // STOPS THE RUN. A form the audit cannot confidently classify is refused, not ignored.
  //
  // Every form below is a real ffmpeg value form that the previous scan read as absent
  // or misread, and each would have reached the mix unaccounted for.
  const SMUGGLED_FORMS = [
    ['leadingDot', '.5', 'ffmpeg reads volume=.5 as 0.5 — the exact case the old lookbehind dropped'],
    ['trailingDot', '5.', 'a trailing-dot decimal is valid and matched nothing'],
    ['signedPositive', '+1.5', 'an explicit + was stripped, leaving a value that looked declared'],
    ['signedNegative', '-1.5', 'a leading - inverts polarity as well as level, and was stripped'],
    ['exponent', '1e3', 'an exponent read as no number at all'],
    ['upperCaseExponent', '1.5E-2', 'and this one read as the bare 2, a cause that did not occur'],
    ['decibelSuffix', '6dB', 'volume=6dB is +6 dB, not a 6x multiplier — and matched nothing'],
    ['kiloSuffix', '128k', "ffmpeg's k magnitude suffix"],
    ['megaSuffix', '2M', "ffmpeg's M magnitude suffix"],
  ];

  for (const [label, literal, why] of SMUGGLED_FORMS) {
    test(`audit_undeclaredValueWrittenAsA_${label}_refusesRatherThanReadingNothingThere`, () => {
      const mix = declaredMix();
      const graph = loopingGraph(mix, `,volume=${literal}`);

      assert.throws(
        () => mix.audit(graph),
        (err) => {
          assert.ok(err instanceof CliError, `${literal} must stop the run — ${why}`);
          assert.equal(err.exitCode, EXIT.FAILED);
          assert.ok(
            err.message.includes(literal),
            `the refusal must quote ${literal} back, so the reader knows what stopped it; got:\n${err.message}`,
          );
          return true;
        },
        `volume=${literal} reached the graph undeclared and the audit must not read past it — ${why}`,
      );
    });
  }

  // THE OTHER HALF OF THE SAME PROPERTY. Refusing everything it cannot classify is only
  // safe if it classifies what the real graph actually contains. `pan=stereo|c0=c0|c1=c0`
  // and the `ml1` loop labels carry digits inside IDENTIFIERS, and reading those as
  // smuggled values would make the guard fire on every correct run — a guard that cries
  // wolf is turned off, which is how it stops protecting anything.
  test('audit_identifiersThatContainDigits_areNotMistakenForValues', () => {
    const mix = declaredMix();

    assert.doesNotThrow(
      () => mix.audit(loopingGraph(mix)),
      'c0/c1/c2 and the ml1 loop labels are wiring, not levels',
    );
  });

  // THE PRICE OF THE LINE ABOVE, ASSERTED SO IT IS NOT FORGOTTEN. Skipping
  // identifier-shaped runs is what lets every correct graph pass, and it is therefore
  // also a shape the scan does not inspect. Documented as a limit in mix-parameters.mjs
  // and in the README, and pinned here so the claim is tested rather than asserted.
  test('audit_undeclaredRunShapedLikeAFilterIdentifier_isNotDetected', () => {
    const mix = declaredMix();

    assert.doesNotThrow(
      () => mix.audit(loopingGraph(mix).replace(':level=disabled', ':level=disabled2')),
      'a digit inside a name is skipped — the guard reads numbers, not identifiers',
    );
  });

  // THE LIMIT, ASSERTED RATHER THAN ASSUMED. The audit reads the filter graph and
  // nothing else. A level-moving argument passed to ffmpeg OUTSIDE -filter_complex is
  // invisible to it, and saying so is the point — the history of this file is claims
  // stronger than their evidence.
  //
  // It used to audit a clean graph and call that the limit, which proved nothing: no
  // `-af` existed anywhere, and a broken audit that accepted everything passed it too. So
  // the argument is really built, beside the graph remux-music hands the audit, and the
  // same value is shown to be refused INSIDE the graph.
  test('audit_levelMovingArgumentOutsideTheFilterGraph_isNotDetected', () => {
    const mix = declaredMix();
    const graph = loopingGraph(mix);
    const ffArgs = [
      '-i', 'render.mp4', '-i', 'voiceover.mp3', '-i', 'music.wav',
      '-filter_complex', graph,
      '-af', 'volume=4',
      '-map', '0:v', '-c:v', 'copy', '-map', '[out]', '-c:a', 'aac', 'out.mp4',
    ];

    assert.doesNotThrow(
      () => mix.audit(ffArgs[ffArgs.indexOf('-filter_complex') + 1]),
      'the audit sees the graph only; the `-af volume=4` beside it passes unseen',
    );

    const inside = declaredMix();
    assert.throws(
      () => inside.audit(loopingGraph(inside, ',volume=4')),
      CliError,
      'the same value inside the graph is refused — so the pass above is the limit, not a broken audit',
    );
  });
});

// --------------------------------------------------------------------------------------
// P2-1 — A VALUE MUST BE WHERE IT WAS TAKEN, NOT MERELY PRESENT
//
// The audit accounted for values as a multiset over the whole graph string: value and
// use-count, never position. So a gain MOVED onto another chain was accepted — the same
// two literals, the same two counts, a completely different mix. Measured against the
// ducking graph at voiceGain 1.4 / musicGain 0.031 / ceiling 0.794328, all three of the
// substitutions below PASSED, while a smuggled 0.9 was correctly refused: the audit was
// not vacuous, it simply had no notion of where a value landed.
//
// `use()` now names the chain the value is being interpolated into, and the audit checks
// the chain, so a value that moved is a value that is missing from where it belongs.
// --------------------------------------------------------------------------------------

describe('a mix value must appear in the chain it was taken for', () => {
  /** The ducking graph, built with `pick` choosing which parameter goes on which chain. */
  const duckingGraphWith = (mix, pick) =>
    `[1:a]volume=${pick.voice}` + `,pan=stereo|c0=c0|c1=c0,${mix.structural('asplit=2')}[vo][vosc];` +
    `[2:a]${mix.structural('atrim=0:')}${mix.use('videoSeconds', 'mu')},asetpts=N/SR/TB,volume=${pick.music}[mu];` +
    `[vosc]apad[vop];` +
    `[mu][vop]sidechaincompress=threshold=${mix.use('duckDb', 'mud')}:ratio=${mix.use('duckRatio', 'mud')}` +
    `:attack=${mix.use('duckAttack', 'mud')}:release=${mix.use('duckRelease', 'mud')}[mud];` +
    `[vo][mud]${mix.structural('amix=inputs=2:duration=longest:normalize=0')}[mx];` +
    `[mx]alimiter=limit=${pick.ceiling}:level=disabled[out]`;

  // THE POSITIVE CONTROL. The graph remux-music actually builds must still pass, or the
  // refusals below would just be an audit that refuses everything.
  test('audit_duckingGraphWithEveryValueOnTheChainItWasTakenFor_passes', () => {
    const mix = declaredDuckingMix();
    const graph = duckingGraphWith(mix, {
      voice: mix.use('voiceGain', 'vo'),
      music: mix.use('musicGain', 'mu'),
      ceiling: mix.use('ceiling', 'out'),
    });

    assert.doesNotThrow(() => mix.audit(graph));
  });

  test('audit_loopingGraphWithEveryValueOnTheChainItWasTakenFor_passes', () => {
    const mix = declaredMix();

    assert.doesNotThrow(() => mix.audit(loopingGraph(mix)));
  });

  // THE SUBSTITUTION. The bed's gain lands on the narration and the narration's on the
  // bed: at 1.4 and 0.031 that is a mix with the music 33 dB over the voice, and the pin
  // records the declared values and reports valid.
  test('audit_voiceAndMusicGainsSwappedOntoEachOthersChains_isRefusedNamingThem', () => {
    const mix = declaredDuckingMix();
    const graph = duckingGraphWith(mix, {
      voice: mix.use('musicGain', 'mu'),
      music: mix.use('voiceGain', 'vo'),
      ceiling: mix.use('ceiling', 'out'),
    });

    assert.throws(
      () => mix.audit(graph),
      (err) => {
        assert.ok(err instanceof CliError, 'a value that is not where it was taken is a refusal');
        assert.equal(err.exitCode, EXIT.FAILED);
        assert.match(err.message, /--voice-gain/, 'the refusal must name the parameter');
        return true;
      },
    );
  });

  // The same hole with only ONE value moved, so it cannot be passed by a check that merely
  // notices two parameters have exchanged places.
  test('audit_ceilingMovedOntoTheVoiceChain_isRefusedNamingIt', () => {
    const mix = declaredDuckingMix();
    const graph = duckingGraphWith(mix, {
      voice: mix.use('ceiling', 'out'),
      music: mix.use('musicGain', 'mu'),
      ceiling: mix.use('voiceGain', 'vo'),
    });

    assert.throws(
      () => mix.audit(graph),
      (err) => err instanceof CliError && /--ceiling|--voice-gain/.test(err.message),
      'a limiter ceiling applied as a voice gain must stop the run',
    );
  });

  // A duck parameter moved WITHIN the one chain it belongs to is NOT caught, and must not
  // be claimed to be: threshold and ratio are both taken for `mud`, so swapping them is
  // invisible here. Stating the limit as a test keeps it honest rather than argued away.
  test('audit_twoValuesSwappedWithinTheSameChain_isNotDetected', () => {
    const mix = declaredDuckingMix();
    const graph =
      `[1:a]volume=${mix.use('voiceGain', 'vo')},pan=stereo|c0=c0|c1=c0,${mix.structural('asplit=2')}[vo][vosc];` +
      `[2:a]${mix.structural('atrim=0:')}${mix.use('videoSeconds', 'mu')},asetpts=N/SR/TB,volume=${mix.use('musicGain', 'mu')}[mu];` +
      `[vosc]apad[vop];` +
      `[mu][vop]sidechaincompress=threshold=${mix.use('duckRatio', 'mud')}:ratio=${mix.use('duckDb', 'mud')}` +
      `:attack=${mix.use('duckAttack', 'mud')}:release=${mix.use('duckRelease', 'mud')}[mud];` +
      `[vo][mud]${mix.structural('amix=inputs=2:duration=longest:normalize=0')}[mx];` +
      `[mx]alimiter=limit=${mix.use('ceiling', 'out')}:level=disabled[out]`;

    assert.doesNotThrow(
      () => mix.audit(graph),
      'the chain is the unit of accounting — a value moved within one chain is a stated blind spot',
    );
  });

  // THE SITE IS NOT OPTIONAL. A `use()` with no site would silently opt that value out of
  // the check, which is exactly the "closed by construction, nothing fails when it grows"
  // shape this module exists to stop.
  test('use_withoutASite_refusesRatherThanSkippingTheCheckForThatValue', () => {
    const mix = declaredDuckingMix();

    assert.throws(
      () => mix.use('musicGain'),
      (err) => err instanceof CliError && err.exitCode === EXIT.FAILED,
      'a value with no site cannot be checked, so it cannot be taken',
    );
  });

  test('use_siteThatIsNotAnOutputLabelOfTheGraph_isRefusedByTheAudit', () => {
    const mix = declaredDuckingMix();
    const graph = duckingGraphWith(mix, {
      voice: mix.use('voiceGain', 'vo'),
      music: mix.use('musicGain', 'nosuchchain'),
      ceiling: mix.use('ceiling', 'out'),
    });

    assert.throws(
      () => mix.audit(graph),
      (err) => err instanceof CliError && /nosuchchain/.test(err.message),
      'a site no chain produces cannot be checked, so it must stop the run',
    );
  });
});
// --------------------------------------------------------------------------------------
// P2-3 — THE PIN IS ACTUALLY PUBLISHED
//
// Everything above tests the registry as a function. Nothing tested that remux-music ever
// WRITES the lock: --apply dies at the missing ffmpeg three checks before the publish, so
// a mutant deleting the `writeGainLock(...)` call entirely left the whole suite green —
// 1107 tests, 0 failures, the same as the unmutated run.
//
// These drive the real CLI to completion behind a controlled ffmpeg (see
// tests/fixtures/fake-ffmpeg.mjs) and read the file back.
// --------------------------------------------------------------------------------------

describe('remux-music publishes the gain pin', () => {
  const LOCK = 'music-gain.lock.json';
  /** A path that is not an executable: the fake intercepts it by name, nothing runs it. */
  const FAKE_FFMPEG = path.join(os.tmpdir(), 'sizzlecraft-fake-ffmpeg', 'ffmpeg.exe');

  const project = (t, extra = {}) =>
    makeProject(t, {
      'render.mp4': 'a stub video stream',
      'voiceover.mp3': 'a stub narration',
      'music.wav': pcmWav(10),
      'timing.json': JSON.stringify({ project: { fps: 30 }, durationMs: 4000 }),
      ...extra,
    });

  const fakeFfmpeg = (dir, extra = {}) => {
    const url = pathToFileURL(path.join(import.meta.dirname, 'fixtures', 'fake-ffmpeg.mjs'));
    url.search = new URLSearchParams({ dir, ffmpeg: FAKE_FFMPEG, ...extra }).toString();
    return url.href;
  };

  const remux = (dir, extra = []) =>
    runScript(
      'remux-music.mjs',
      ['--video', 'render.mp4', '--out', 'out.mp4', '--ffmpeg', FAKE_FFMPEG, '--apply', ...extra],
      dir,
      { nodeArgs: ['--import', fakeFfmpeg(dir)] },
    );

  // MUTANT MP3: deleting the writeGainLock call leaves this at "no lock on disk" and fails
  // on the first assertion. Nothing else in the suite moves.
  test('remuxMusic_applyWithConfirmGain_publishesTheLockRecordingTheMixThatWasBuilt', (t) => {
    const dir = project(t);

    const r = remux(dir, ['--confirm-gain']);

    assertCleanExit(r, EXIT.OK, `the remux must complete for the pin to be reachable: ${r.all}`);
    assert.equal(fs.existsSync(path.join(dir, LOCK)), true, 'the pin must be on disk');
    const lock = JSON.parse(fs.readFileSync(path.join(dir, LOCK), 'utf8'));
    assert.equal(lock.evidence, 'operator-confirmed', 'and it must record how it was earned');
    assert.equal(typeof lock.confirmedAt, 'string', 'and when');
    assert.equal(
      lock.sha256,
      crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'music.wav'))).digest('hex'),
      'and the bed it covers',
    );
    // Every PINNED parameter, at the value the run actually built with.
    for (const parameter of MIX_PARAMETERS.filter((p) => p.pinned)) {
      assert.ok(
        Object.hasOwn(lock.mix, parameter.name),
        `the pin must cover ${parameter.name}: ${JSON.stringify(lock.mix)}`,
      );
      assert.equal(typeof lock.mix[parameter.name], 'number', `${parameter.name} must be a comparable number`);
    }
    assert.equal(lock.mix.voiceGain, 1.14, 'at the shipped default');
    assert.equal(lock.mix.musicGain, 1.5, 'at the shipped default');
    assert.match(r.all, new RegExp(LOCK.replace(/\./g, '\\.')), 'and the run must say it wrote it');
  });

  // THE PIN IS A CONFIRMATION, NOT A SIDE EFFECT OF RUNNING. A second --apply over a
  // settled pin must not refresh `confirmedAt`: that would stamp an acceptance nobody
  // gave on this run, which is a false record on its own terms.
  test('remuxMusic_applyOverASettledPinWithoutConfirmGain_leavesThePinExactlyAsItWas', (t) => {
    const dir = project(t);

    const first = remux(dir, ['--confirm-gain']);
    assertCleanExit(first, EXIT.OK, `the pin must be settled before this tests anything: ${first.all}`);
    const settled = fs.readFileSync(path.join(dir, LOCK), 'utf8');

    const again = remux(dir, ['--replace']);

    assertCleanExit(again, EXIT.OK, `a settled pin needs no fresh confirmation: ${again.all}`);
    assert.doesNotMatch(again.all, /--confirm-gain/, 'and must not nag for one it already has');
    assert.equal(
      fs.readFileSync(path.join(dir, LOCK), 'utf8'),
      settled,
      'the pin must be byte-identical — a refreshed confirmedAt records a confirmation nobody gave',
    );
  });

  // The gains the pin records are the gains the run was given, not the defaults it would
  // have used — a pin that always records 1.14/1.5 would pass the test above and certify
  // nothing.
  test('remuxMusic_applyWithConfirmGainAtNonDefaultGains_recordsThoseGainsNotTheDefaults', (t) => {
    const dir = project(t);

    const r = remux(dir, ['--confirm-gain', '--voice-gain', '1.4', '--music-gain', '0.8']);

    assertCleanExit(r, EXIT.OK, r.all);
    const lock = JSON.parse(fs.readFileSync(path.join(dir, LOCK), 'utf8'));
    assert.equal(lock.mix.voiceGain, 1.4);
    assert.equal(lock.mix.musicGain, 0.8);
  });

  // THE VERDICT IS LIVE, AND THE PIN IS BEHIND IT. remux-music publishes only after
  // proving the video stream came through untouched. Without this control, a fake whose
  // digests always matched would make that proof — and every pin assertion above —
  // vacuous. `corruptVideo` makes the copy not a copy.
  test('remuxMusic_remuxedVideoStreamDiffersFromTheSource_failsAndPublishesNoPin', (t) => {
    const dir = project(t);

    const r = runScript(
      'remux-music.mjs',
      ['--video', 'render.mp4', '--out', 'out.mp4', '--ffmpeg', FAKE_FFMPEG, '--apply', '--confirm-gain'],
      dir,
      { nodeArgs: ['--import', fakeFfmpeg(dir, { corruptVideo: 'true' })] },
    );

    assert.notEqual(r.code, EXIT.OK, `a changed video stream must not be published\n${r.all}`);
    assert.match(r.all, /FAILED/, 'and the run must say so');
    assert.equal(fs.existsSync(path.join(dir, LOCK)), false, 'and a failed verdict must publish no pin');
  });
});