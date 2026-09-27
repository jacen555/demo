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

import { CliError, EXIT } from '../src/cli-support.mjs';
import { MIX_PARAMETERS, createMixAudit } from '../src/mix-parameters.mjs';
import { classifyGainPin } from '../src/gain-pin.mjs';

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
    `[1:a]volume=${mix.use('voiceGain')},pan=stereo|c0=c0|c1=c0[vo];` +
    `[2:a][3:a]acrossfade=d=${mix.use('crossfade')}:c1=tri:c2=tri[ml1];` +
    `[ml1][4:a]acrossfade=d=${mix.use('crossfade')}:c1=tri:c2=tri[ml2];` +
    `[ml2]atrim=0:${mix.use('videoSeconds')},asetpts=N/SR/TB,volume=${mix.use('musicGain')}[mu];` +
    `[vo][mu]amix=inputs=2:duration=longest:normalize=0[mx];` +
    `[mx]alimiter=limit=${mix.use('ceiling')}:level=disabled${tail}[out]`
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
    // returns the bed to the gaps level at all — so calling any of them a "transition
    // shape" knob of the kind --crossfade is would be the voiceGain mistake repeated.
    assert.deepEqual(
      pinned.slice().sort(),
      ['ceiling', 'duckAttack', 'duckDb', 'duckRatio', 'duckRelease', 'musicGain', 'voiceGain'],
      'every knob that moves the delivered level — both bus gains, the limiter and the duck — must be pinned',
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

    assert.throws(() => mix.use('ceiling'), CliError, 'a value cannot be used before it is declared');
  });

  test('use_declaredParameter_returnsTheRenderedLiteralNotTheOperatorFacingValue', () => {
    const mix = createMixAudit();
    mix.declare('voiceGain', { value: 1.14 });
    mix.declare('musicGain', { value: 1.5 });
    mix.declare('ceiling', { value: 2, rendered: 0.794328 });
    // pinnedValues refuses a partial set, so the conditional knobs are accounted for too.
    for (const name of ['duckDb', 'duckRatio', 'duckAttack', 'duckRelease']) mix.declareAbsent(name);

    assert.equal(mix.use('ceiling'), '0.794328', 'the graph carries the linear limit');
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
      `[1:a]volume=${mix.use('voiceGain')},pan=stereo|c0=c0|c1=c0[vo];` +
      `[2:a]asetpts=N/SR/TB,volume=${mix.use('musicGain')}[mu];` +
      `[vo][mu]amix=inputs=2:duration=longest:normalize=0[mx];` +
      `[mx]alimiter=limit=${mix.use('ceiling')}:level=disabled[out]`;

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

  // An unspent use would leave slack in the accounting, and slack of exactly the right
  // value is indistinguishable from a smuggled literal. The budget must balance both ways.
  test('audit_valueTakenFromTheRegistryButNeverInterpolated_refusesRatherThanLeavingSlack', () => {
    const mix = declaredMix();
    const graph = loopingGraph(mix);

    mix.use('musicGain'); // taken, and the string thrown away

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
  test('audit_levelMovingArgumentOutsideTheFilterGraph_isNotDetected', () => {
    const mix = declaredMix();
    const graph = loopingGraph(mix);

    assert.doesNotThrow(
      () => mix.audit(graph),
      'the audit sees the graph only; `-af volume=4` or a changed -b:a would pass it unseen',
    );
  });
});
