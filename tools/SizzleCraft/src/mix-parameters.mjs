/*
 * The registration point for every value that reaches the delivered mix.
 *
 * ## Why this exists
 *
 * The music gain pin (gain-pin.mjs, bug-ledger 16) recorded a hand-written literal:
 * `{ source, sha256, musicGain }`. `--ceiling` was added later. It sets the limiter, so
 * it moves the delivered loudness of the shipped mix — and the pin had never heard of
 * it. A ceiling change therefore required no renewed confirmation: the pin reported
 * itself valid while the mix moved underneath it.
 *
 * Adding `ceiling` to that literal would have fixed the instance and left the class. The
 * enumeration was not the mistake. The mistake was that **the set was closed by
 * construction and nothing failed when it grew**. So this module makes the set open by
 * construction and makes growth fail loudly:
 *
 *   - MIX_PARAMETERS is the one place a knob is declared. The pin binds to the `pinned`
 *     subset of it, so a knob declared here is covered without anyone editing the pin.
 *   - `use()` refuses a name that is not declared.
 *   - `audit()` reads the finished filter graph and refuses any number in it that is not
 *     traceable to a declared parameter or to a declared structural literal.
 *
 * ## WHAT THIS MECHANISM ACTUALLY DETECTS — and what it does not
 *
 * This file's feature has been got wrong three times in the same shape: evidence weaker
 * than the claim it carries. So the claim here is deliberately narrow and exact.
 *
 * IT DETECTS:
 *   1. a name used through the registry that is not declared in MIX_PARAMETERS;
 *   2. a NUMBER present in the final `-filter_complex` string that no declared parameter
 *      use and no declared structural literal accounts for — including a number that
 *      duplicates a declared value, because accounting is by value AND use-count;
 *   3. ANY run of characters in that string carrying a digit which is neither a plain
 *      decimal nor a filter identifier. `.5`, `5.`, `+1.5`, `-1.5`, `1e3`, `1.5E-2`,
 *      `6dB`, `128k` and anything else it cannot confidently classify STOP THE RUN
 *      rather than being skipped. This is the one that was got wrong: the scan used to
 *      look for a single anticipated number shape, so `volume=.5` matched NOTHING and a
 *      graph carrying an undeclared bed multiplier read as fully accounted for;
 *   4. a `pinned` parameter that was never declared, so the pin cannot silently record a
 *      partial set;
 *   5. a `pinned` parameter that was declared but never reached the graph, so the pin
 *      cannot record a value that was not applied.
 *
 * IT DOES NOT DETECT:
 *   a. anything that reaches ffmpeg OUTSIDE the filter graph — `-b:a`, `-ar`, `-ac`, an
 *      added `-af`, a changed codec or `-map`. Those can move delivered loudness and
 *      this audit never sees them. It reads one string.
 *   b. a NON-NUMERIC change to the graph: swapping `alimiter` for `acompressor`, or
 *      `level=disabled` for `level=enabled`. No digit appears, so nothing fires. A
 *      future knob whose value is a word rather than a number is invisible here.
 *   c. a value hidden inside a `[link label]`, because labels are redacted wholesale
 *      before the scan runs. A label cannot set a level, but the audit's blind spot is
 *      real rather than argued away.
 *   d. a value shaped like a FILTER IDENTIFIER — `c0`, `ml1`. Digits inside a name are
 *      skipped, which is what lets `pan=stereo|c0=c0` pass on every correct run; it is
 *      also, unavoidably, a shape the scan does not inspect.
 *   e. **whether `pinned` is set correctly.** Nothing here can know that a knob moves the
 *      delivered level. Declaring `pinned: false` on something that does move it defeats
 *      the pin, and the tool will not notice. That is the sharpest limit of this design
 *      and it is a human judgement, not a mechanical guarantee. It has already been got
 *      wrong once — `voiceGain` was declared unpinned, and it feeds the limiter.
 *   f. deliberate circumvention — adding a new literal to STRUCTURAL_LITERALS, or calling
 *      `use('musicGain')` for a value that is not the music gain. This guard defends
 *      against FORGETTING, which is how --ceiling escaped. It does not defend against
 *      being wrong, and it does not defend against being talked around.
 *
 * The honest summary: a knob interpolated into the mix graph cannot reach ffmpeg AS A
 * NUMBER without either being declared or stopping the run — in any numeric form ffmpeg
 * accepts, not just the ones this file's author thought of. Values carrying no digit,
 * values shaped like identifiers, values inside labels, and everything outside the graph
 * are NOT covered, and are listed above rather than implied to be.
 */
import { CliError, EXIT } from './cli-support.mjs';

/**
 * THE REGISTRATION POINT. Adding a knob that reaches the mix graph means adding a row
 * here — the tool refuses to build a graph containing anything else.
 *
 * `pinned: true` means a change to this value demands a renewed operator confirmation,
 * because it moves the loudness actually delivered. `pinned: false` means the value
 * reaches the graph but is declared not to set the delivered level; see limit (d) above
 * — that classification is a judgement this module cannot check.
 *
 * Every field is read: `name` keys the lock record, `flag` and `summary` are what the
 * refusal text says to the operator, `pinned` selects what the pin covers. Nothing here
 * is decoration — a field that no predicate reads is how the last version of this
 * feature came to certify something nobody had checked.
 */
export const MIX_PARAMETERS = Object.freeze([
  Object.freeze({
    name: 'voiceGain',
    flag: '--voice-gain',
    summary: 'the narration multiplier',
    // PINNED, after being declared `pinned: false` and being wrong about it.
    //
    // The reasoning for leaving it out was that the pin's question is whether the BED
    // level was agreed to, so the narration bus is a separate matter. It is not. The
    // voice sets the other half of the balance the bed is judged against, and it is the
    // signal fed into the limiter whose ceiling is pinned right below — so moving it
    // alone moves the delivered mix while a settled pin goes on reporting valid. That is
    // the identical defect --ceiling had, reached by the identical reasoning.
    //
    // The incident this whole feature exists for was a voice 1.40 / music 0.85
    // rebalance that shipped a bed 24 dB above target: a voice-only change, against a
    // source that never moved. It is also a deliberate, rare change rather than the
    // frame-by-frame churn that makes a confirmation reflexive (see videoSeconds), so it
    // costs an operator one flag on the occasions it actually happens.
    pinned: true,
  }),
  Object.freeze({
    name: 'musicGain',
    flag: '--music-gain',
    summary: 'the music bed multiplier',
    pinned: true,
  }),
  Object.freeze({
    name: 'ceiling',
    flag: '--ceiling',
    summary: 'the limiter ceiling, in dB below full scale',
    // The knob that escaped. It clamps the finished mix, so it moves delivered loudness
    // directly — which is the whole question the pin asks.
    pinned: true,
  }),
  Object.freeze({
    name: 'crossfade',
    flag: '--crossfade',
    summary: 'the crossfade at each loop wrap',
    // Not pinned: it sets how a wrap is joined, not how loud the bed sits.
    pinned: false,
  }),
  Object.freeze({
    name: 'videoSeconds',
    flag: '--video-seconds',
    summary: 'the length the bed is trimmed to',
    // Not pinned: trimming changes how long the mix runs, not its level — and pinning it
    // would demand a fresh confirmation every time the video length moved by a frame,
    // which trains an operator to pass --confirm-gain reflexively. A confirmation that
    // fires constantly stops being a confirmation.
    pinned: false,
  }),
]);

const BY_NAME = new Map(MIX_PARAMETERS.map((parameter) => [parameter.name, parameter]));

/**
 * The fixed numbers of remux-music's filter graph, with the key they belong to.
 *
 * Matched WITH their key rather than as bare numbers on purpose: allowing a bare `2`
 * anywhere would let a future `volume=2` pass unnoticed. These are redacted before
 * numbers are extracted, so adding a constant to the graph without adding it here stops
 * the run rather than widening the hole.
 */
const STRUCTURAL_LITERALS = Object.freeze([
  'atrim=0:', // the trim always starts at the head of the bed
  'inputs=2', // amix takes exactly two buses: voice and music
  'normalize=0', // amix must not halve both buses
]);

/**
 * THE ONE NUMERIC GRAMMAR. `declare` may only render this, and `audit` may only read
 * this — deliberately the same constant, because two grammars is how a value becomes
 * legal to write and impossible to read.
 *
 * A leading digit is REQUIRED. `String(0.5)` is "0.5" and never ".5", so no value this
 * module can legitimately produce is excluded; requiring it means a leading-dot number
 * appearing in the graph is, without exception, something that did not come from here.
 */
const PLAIN_DECIMAL = /^(?:\d+|\d+\.\d+)$/;

/**
 * A maximal run of characters that could carry a value, split on everything a filter
 * graph uses as punctuation (`=`, `:`, `,`, `;`, `|`, `/`, and the redaction mark).
 *
 * Runs rather than a number pattern, because A NUMBER PATTERN CANNOT SEE THE SHAPES IT
 * WAS NOT WRITTEN FOR. The previous version of this scan matched `\d+(\.\d+)?` behind a
 * lookbehind that excluded `.`, so `volume=.5` matched NOTHING AT ALL: the graph read as
 * fully accounted for while carrying an undeclared bed multiplier. Every other form
 * ffmpeg accepts failed the same way — `5.`, `1e3`, `6dB`, `128k` produced no match, and
 * `+1.5`/`-1.5` silently dropped the sign that inverts the value.
 *
 * So the scan no longer looks for numbers. It takes every run, and classifies each one
 * into exactly one of three buckets (see `audit`): an identifier, a readable value, or
 * SOMETHING IT REFUSES TO GUESS AT. Widening this charset therefore tightens the guard —
 * a longer run is more likely to be unclassifiable, and unclassifiable stops the run.
 */
const GRAPH_TOKEN = /[0-9A-Za-z_.+-]+/g;

/** Any run carrying no digit at all — `volume`, `stereo`, `tri` — cannot be a value. */
const HAS_DIGIT = /\d/;

/**
 * A filter-graph name that happens to contain digits: `c0`, `c1`, `c2`, `ml1`, `SR`.
 *
 * Anchored and leading-letter, so it can never be satisfied by something that STARTS as
 * a number and trails into letters — `6dB` and `128k` are not identifiers here, and are
 * refused rather than quietly read as names.
 */
const IDENTIFIER = /^[A-Za-z_][0-9A-Za-z_]*$/;

/** Replaces redacted spans; matches no part of GRAPH_TOKEN's character class. */
const REDACTED = '\u0000';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Opens a declaration/use/audit cycle for one mix graph.
 *
 * Per-run rather than module state: two runs in one process must not see each other's
 * declarations, and a test that depends on import order is a test that will lie later.
 */
export function createMixAudit() {
  /** name -> { parameter, value, rendered, uses } */
  const declared = new Map();

  /**
   * Declares a value that is about to reach the mix graph.
   *
   * `value` is what the operator typed and what the pin records; `rendered` is what the
   * graph carries. They differ where a knob is expressed in one unit and applied in
   * another — `--ceiling 2` is pinned as 2 dB and rendered as the linear limit 0.794328.
   * Pinning the rendered form instead would make the refusal quote a number the operator
   * never typed.
   */
  function declare(name, { value, rendered = value }) {
    const parameter = BY_NAME.get(name);
    if (parameter === undefined) {
      throw new CliError(
        `"${name}" reaches the mix but is not declared in MIX_PARAMETERS (src/mix-parameters.mjs).\n` +
          'A value that moves the delivered mix without being declared is invisible to the gain pin,\n' +
          'which is how --ceiling came to change the shipped loudness with the pin reporting valid.\n' +
          'Declare it there — pinned: true if it moves the delivered level.',
        EXIT.FAILED,
      );
    }
    if (declared.has(name)) {
      throw new CliError(`${parameter.flag} was declared twice — only one value of it reaches the graph`, EXIT.FAILED);
    }
    if (!Number.isFinite(value)) {
      throw new CliError(`${parameter.flag} must be declared as a finite number — got ${JSON.stringify(value)}`, EXIT.FAILED);
    }
    const text = String(rendered);
    if (!PLAIN_DECIMAL.test(text)) {
      throw new CliError(
        `${parameter.flag} renders as "${text}", which is not a plain decimal with a leading digit. ` +
          'It would be interpolated into an ffmpeg filter graph and could not be audited there.',
        EXIT.FAILED,
      );
    }
    declared.set(name, { parameter, value, rendered: text, uses: 0 });
  }

  /**
   * Returns the literal to interpolate, and counts the use.
   *
   * The count is what lets `audit` tell a second legitimate occurrence from a smuggled
   * one, so it is derived from actual use rather than stated by the author.
   */
  function use(name) {
    const entry = declared.get(name);
    if (entry === undefined) {
      const known = BY_NAME.has(name) ? 'declared for this run' : 'declared in MIX_PARAMETERS';
      throw new CliError(`"${name}" reached the mix graph without being ${known}`, EXIT.FAILED);
    }
    entry.uses += 1;
    return entry.rendered;
  }

  /**
   * The values the pin covers, keyed by registry name.
   *
   * Refuses when a `pinned` parameter was never declared: a pin recording a subset of
   * the declared set is exactly the defect this module exists to stop, one level up.
   */
  function pinnedValues() {
    const values = {};
    for (const parameter of MIX_PARAMETERS) {
      if (!parameter.pinned) continue;
      const entry = declared.get(parameter.name);
      if (entry === undefined) {
        throw new CliError(
          `${parameter.flag} is a pinned mix parameter but was never declared for this run — ` +
            'the pin would record a set that does not cover what is about to be mixed',
          EXIT.FAILED,
        );
      }
      values[parameter.name] = entry.value;
    }
    return values;
  }

  /**
   * Refuses to proceed if the finished graph carries a number nothing accounts for.
   *
   * Runs on the plan path too: a plan that prints a graph it could not account for is a
   * plan that describes a mix the pin has not covered, and printing it at exit 0 is the
   * permissive default this engine refuses everywhere else.
   */
  function audit(graph) {
    for (const [, entry] of declared) {
      if (entry.parameter.pinned && entry.uses === 0) {
        throw new CliError(
          `${entry.parameter.flag} is pinned and was declared as ${entry.value}, but never reached the ` +
            'mix graph — the pin would record a value that was not applied',
          EXIT.FAILED,
        );
      }
    }

    // Link labels first: `[2:a]` and `[ml1]` are wiring, not filter arguments.
    let residue = String(graph).replace(/\[[^\]]*\]/g, REDACTED);
    for (const literal of STRUCTURAL_LITERALS) residue = residue.split(literal).join(REDACTED);

    const budget = new Map();
    const flagsFor = new Map();
    for (const [, entry] of declared) {
      budget.set(entry.rendered, (budget.get(entry.rendered) ?? 0) + entry.uses);
      flagsFor.set(entry.rendered, [...(flagsFor.get(entry.rendered) ?? []), entry.parameter.flag]);
    }

    const unaccounted = [];
    const unreadable = [];
    for (const token of residue.match(GRAPH_TOKEN) ?? []) {
      // THREE BUCKETS, AND THE THIRD IS A REFUSAL. A run with no digit cannot be a level;
      // a run shaped like a name is wiring; a run that is neither of those and is not the
      // one numeric grammar this module renders is something the audit CANNOT CLASSIFY,
      // and it stops the run rather than guessing. Guessing is what the old scan did when
      // it decided `.5` was not a number and therefore was not there.
      if (!HAS_DIGIT.test(token)) continue;
      if (IDENTIFIER.test(token)) continue;
      if (!PLAIN_DECIMAL.test(token)) {
        unreadable.push(token);
        continue;
      }
      const remaining = budget.get(token) ?? 0;
      if (remaining > 0) budget.set(token, remaining - 1);
      else unaccounted.push(token);
    }

    if (unaccounted.length > 0 || unreadable.length > 0) {
      const problems = [];
      if (unaccounted.length > 0) {
        problems.push(
          `  ${unaccounted.length} value(s) that no registered mix parameter explains: ${unaccounted.join(', ')}`,
        );
      }
      if (unreadable.length > 0) {
        problems.push(
          `  ${unreadable.length} run(s) it cannot read as either a plain decimal or a filter identifier: ` +
            `${unreadable.join(', ')}\n` +
            '    An unclassifiable run is REFUSED, not skipped. ffmpeg accepts .5, 5., +1.5, -1.5, 1e3,\n' +
            '    6dB and 128k as values, and a scan that recognises only the shapes its author\n' +
            '    anticipated reports a graph carrying one of them as fully accounted for.',
        );
      }
      throw new CliError(
        'the mix filter graph did not pass the registry audit:\n' +
          `${problems.join('\n')}\n` +
          'Every number in the graph must be traceable to a parameter declared in MIX_PARAMETERS\n' +
          '(src/mix-parameters.mjs) or to a declared structural literal of the graph. An untraceable\n' +
          'value is a knob that can move the delivered loudness while the gain pin reports valid —\n' +
          'which is bug-ledger 16, and is how --ceiling escaped the pin.\n' +
          'Declare it in MIX_PARAMETERS (pinned: true if it moves the delivered level) and interpolate\n' +
          'it with mix.use(<name>), so the pin covers it and this audit can account for it.',
        EXIT.FAILED,
      );
    }

    // THE BUDGET MUST BE EXACTLY SPENT. A `use()` whose string was built and then
    // discarded would otherwise leave slack that absorbs a smuggled literal of the same
    // value — an accounting hole that hands back the protection it just charged for.
    for (const [literal, remaining] of budget) {
      if (remaining > 0) {
        throw new CliError(
          `${flagsFor.get(literal).join('/')} was taken from the registry ${remaining} more time(s) than "${literal}" ` +
            'appears in the mix filter graph.\n' +
            'The audit accounts for values by use-count, so an unspent use would leave room for an\n' +
            'undeclared value of the same number to pass unnoticed. Interpolate every value taken\n' +
            'from mix.use(), or do not take it.',
          EXIT.FAILED,
        );
      }
    }
  }

  return { declare, use, pinnedValues, audit };
}

/** True for a value that can be read as a lock's recorded mix set. */
export function isMixRecord(value) {
  return isPlainObject(value);
}
