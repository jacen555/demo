/*
 * Verifies a project's timing.json: schema shape, segment contiguity, and the
 * narration word budget.
 *
 * This script's entire job is to say no. It previously printed schema errors and
 * contiguity breaks and then exited 0, which is worse than not running it — a green
 * light nobody earned, in a nine-stage pipeline where every later stage trusts this
 * file. Schema and contiguity failures now exit 1.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { EXIT, CliError, runCli, requireExistingFile, requireFiniteNumber, narrationFingerprint } from './cli-support.mjs';

const SHIPPED_SCHEMA = fileURLToPath(new URL('./timing-schema.json', import.meta.url));

/** Words in a segment's narration, counted the same way voice.mjs counts them. */
const wordsIn = (s) => String(s?.voiceoverText ?? '').trim().split(/\s+/).filter(Boolean).length;

/**
 * Does this calibration measure THIS script?
 *
 * `endMs - startMs === audio.durationMs` proves only that the windows came from SOME
 * audio. It says nothing about whether the calibration corresponds to the text now in
 * timing.json. Edit a segment's narration without re-running the voice stage and the
 * stored durations are unchanged, the measured rate is unchanged, and that predicate
 * still holds — so suppressing the word budget on it silently waves through the exact
 * case the budget exists to catch: new text against stale audio.
 *
 * The authority is `textHash`, a fingerprint of the exact narration bytes.
 * `{ words, chars, clipMs }` are kept as cheap pre-checks because they produce far better
 * messages when they differ — but they must NOT be the gate. Every summary collides:
 * "word0 word1 word2 word3" and "other word1 word2 word3" agree on all three while being
 * different scripts. A gate built on the summary passes the rewrite it exists to catch.
 *
 * A calibration written before fingerprinting existed carries no `textHash`. That is
 * treated as lineage UNPROVEN, not lineage intact — the suppression requires positive
 * proof, and the safe direction is to evaluate the budget.
 *
 * A mismatch is NOT an error — editing the script and re-validating before re-synthesising
 * is the normal authoring loop, and it is precisely when the budget is wanted. The
 * measured rate stays the best available predictor (same voice, same speed), so it is used
 * as a PREDICTION against the now-stale windows, with the safety margin restored.
 *
 * @returns {{covers: boolean, reason?: string}}
 */
function calibrationLineage(segs, calibrationSegments) {
  if (!Array.isArray(calibrationSegments) || calibrationSegments.length === 0) {
    return {
      covers: false,
      reason: 'the calibration file carries no per-segment evidence (`segments` absent or empty), '
        + 'so it cannot be shown to measure this text',
    };
  }
  if (calibrationSegments.length !== segs.length) {
    return {
      covers: false,
      reason: `the timeline has ${segs.length} segment(s) but the calibration measured ${calibrationSegments.length}`,
    };
  }
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const c = calibrationSegments[i];
    // Order and naming are part of the narration's identity: the same segments read in a
    // different order is a different video. Compared POSITIONALLY, one id at a time.
    //
    // A delimiter-joined comparison was tried here first and is NOT injective:
    // ["a\u0000b", "c"] and ["a", "b\u0000c"] produce the identical joined string, and
    // timing-schema.json permits either id (`type: string, minLength: 1`). A joined string
    // is a summary too — it just looks like a serialisation — so it reintroduced exactly
    // the collision the fingerprint was added to remove, one field over.
    if (String(c?.id) !== String(s.id)) {
      return {
        covers: false,
        reason: `segment ${i + 1} is "${s.id}" but the calibration measured "${c?.id}" at that position `
          + `— segments were renamed or reordered since the voice stage ran`,
      };
    }
    const words = wordsIn(s);
    const chars = String(s.voiceoverText ?? '').length;
    if (Number(c.words) !== words) {
      return { covers: false, reason: `segment "${s.id}" now has ${words} word(s); the calibration measured ${c.words}` };
    }
    if (Number(c.chars) !== chars) {
      return { covers: false, reason: `segment "${s.id}" text changed since it was measured (${chars} chars now, ${c.chars} then)` };
    }
    if (Number(c.clipMs) !== s.endMs - s.startMs) {
      return { covers: false, reason: `segment "${s.id}" window is ${s.endMs - s.startMs}ms but the measured clip was ${c.clipMs}ms` };
    }
    if (c.textHash === undefined || c.textHash === null) {
      return {
        covers: false,
        reason: `segment "${s.id}" carries no narration fingerprint — this calibration predates `
          + `fingerprinting, so lineage is UNPROVEN rather than intact (re-run the voice stage to record one)`,
      };
    }
    if (String(c.textHash) !== narrationFingerprint(s.voiceoverText)) {
      return {
        covers: false,
        reason: `segment "${s.id}" narration does not match the fingerprint taken when it was measured `
          + `— an equal-length rewrite still needs new audio`,
      };
    }
  }
  return { covers: true };
}

const USAGE = `
validate-timing — verify a project's timing.json before the render stages trust it.

  node validate-timing.mjs                     validate timing.json in the current project
  node validate-timing.mjs --no-schema         skip JSON-Schema validation (no ajv installed)
  node validate-timing.mjs --strict            also fail when a segment is over its word budget

Options
  --project <dir>   project root (default: current directory)
  --timing <file>   timing file to validate (default: timing.json)
  --schema <file>   JSON Schema to validate against (default: the schema shipped with this engine)
  --no-schema       skip schema validation entirely, and say so
  --strict          treat an over-budget segment as a failure, not a warning
  --help            show this message

Schema validation needs \`ajv\`. If it is not installed this script FAILS rather than
quietly skipping — pass --no-schema to run the remaining checks deliberately.

Exit codes: 0 all checks passed · 1 a check failed · 2 bad usage or ajv unavailable
`.trimStart();

await runCli(async () => {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        project: { type: 'string' },
        timing: { type: 'string' },
        schema: { type: 'string' },
        'no-schema': { type: 'boolean', default: false },
        strict: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    }));
  } catch (err) {
    throw new CliError(`${err.message}\n\n${USAGE}`);
  }

  if (values.help) {
    console.log(USAGE);
    return EXIT.OK;
  }

  const projectDir = path.resolve(values.project ?? process.cwd());
  const timingPath = requireExistingFile(projectDir, values.timing ?? 'timing.json', 'timing file');

  let timing;
  try {
    timing = JSON.parse(fs.readFileSync(timingPath, 'utf8'));
  } catch (err) {
    throw new CliError(`${timingPath} is not valid JSON — ${err.message}`, EXIT.FAILED);
  }

  // Every check appends here; the exit code is decided once, at the end, from its contents.
  const failures = [];

  // --- Schema -------------------------------------------------------------
  if (values['no-schema']) {
    console.log('SCHEMA: skipped (--no-schema) — shape was NOT verified');
  } else {
    const schemaPath = values.schema
      ? requireExistingFile(projectDir, values.schema, 'schema file')
      : SHIPPED_SCHEMA;
    const errors = await validateAgainstSchema(timing, schemaPath);
    if (errors === null) {
      console.log(`SCHEMA: valid (${path.basename(schemaPath)})`);
    } else {
      console.log(`SCHEMA: INVALID (${path.basename(schemaPath)})`);
      console.log(JSON.stringify(errors, null, 2).slice(0, 3000));
      failures.push(`schema validation failed with ${errors.length} error(s)`);
    }
  }

  const segs = Array.isArray(timing.segments) ? timing.segments : [];
  if (segs.length === 0) {
    throw new CliError(`${timingPath} has no segments to validate`, EXIT.FAILED);
  }

  // --- Segment timing shape -----------------------------------------------
  // Both checks below are arithmetic on startMs/endMs, and arithmetic on a non-number
  // produces NaN, which makes every comparison false. A FINAL segment with a bad endMs
  // was the sharpest case: nothing follows it, so contiguity had nothing to compare and
  // the word budget went NaN — neither check fired and the verifier exited 0 on
  // malformed timing. A check that cannot fire is not a check that passed.
  const shapeProblems = [];
  segs.forEach((s, i) => {
    const where = `segments[${i}]${s?.id ? ` ("${s.id}")` : ''}`;
    for (const field of ['startMs', 'endMs']) {
      const value = s?.[field];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        shapeProblems.push(`${where}.${field} is ${JSON.stringify(value)} — must be a finite number >= 0`);
      }
    }
    if (typeof s?.startMs === 'number' && typeof s?.endMs === 'number' && Number.isFinite(s.startMs) && Number.isFinite(s.endMs) && s.endMs <= s.startMs) {
      shapeProblems.push(`${where} window is ${s.endMs - s.startMs}ms (${s.startMs} -> ${s.endMs}) — must be positive`);
    }
  });

  if (shapeProblems.length > 0) {
    console.log('segment timings: INVALID');
    for (const p of shapeProblems) console.log(`  ${p}`);
    failures.push(`${shapeProblems.length} malformed segment timing value(s)`);
    console.log('\ncontiguity: NOT evaluated — segment timings are malformed');
    console.log('word budget: NOT evaluated — segment timings are malformed');
    console.error(`\nFAILED: ${failures.join('; ')}`);
    return EXIT.FAILED;
  }

  // --- Contiguity ---------------------------------------------------------
  console.log(`lastSeg.endMs ${segs.at(-1).endMs} contentMs ${timing.contentMs} durationMs ${timing.durationMs}`);
  let prev = 0;
  const breaks = [];
  const gaps = [];
  for (const s of segs) {
    if (s.startMs < prev) {
      breaks.push(`${s.id} OVERLAPS the previous segment — starts at ${s.startMs}, previous ended at ${prev}`);
    } else if (s.startMs > prev) {
      gaps.push({ id: s.id, ms: s.startMs - prev });
    }
    prev = s.endMs;
  }
  if (breaks.length === 0) {
    // A GAP IS NOT A BREAK. voice.mjs deliberately inserts inter-segment silence — the
    // "perceived gap" that stops one segment running into the next — plus a lead-in, so a
    // timeline produced by the real pipeline is monotonic but NOT adjacent. Asserting
    // adjacency made this check fail on every genuine run, which is the mirror of the
    // ajv.errors defect above: a check that can never pass is as useless as one that can
    // never fail, and worse in daily use, because a line that is always red trains the
    // reader to stop reading — and it sits directly above the word-rate output that
    // matters. Overlaps are still errors; gaps are reported so an UNEVEN one stays visible.
    const uniq = [...new Set(gaps.map(g => g.ms))];
    if (gaps.length === 0) console.log('contiguity: OK (adjacent)');
    else if (uniq.length === 1) console.log(`contiguity: OK (${gaps.length} inter-segment gap(s), uniform ${uniq[0]} ms)`);
    else {
      console.log(`contiguity: OK (${gaps.length} inter-segment gap(s), UNEVEN: ${uniq.sort((a, b) => a - b).join(', ')} ms)`);
      for (const g of gaps) console.log(`  ${g.id} +${g.ms} ms`);
    }
  } else {
    console.log('contiguity: BROKEN');
    for (const b of breaks) console.log(`  ${b}`);
    failures.push(`${breaks.length} segment overlap(s)`);
  }

  // --- Word rate ----------------------------------------------------------
  const { rate, margin, marginConfigured, source, measuredRate, calibrationSegments } = resolveWordRate(timing, projectDir);

  // Windows measured, or authored estimates? voice.mjs sets
  // `seg.endMs = seg.startMs + <measured clip duration>` and records that same duration at
  // `seg.audio.durationMs`, so the two agreeing means this timeline has been reflowed onto
  // real audio. This is necessary for the suppression below but NOT sufficient — see
  // calibrationLineage: it proves the windows came from some audio, not that the
  // calibration measures the text that is in the file now.
  const measuredWindows = segs.every((s) => {
    const clipMs = Number(s.audio?.durationMs);
    return Number.isFinite(clipMs) && s.endMs - s.startMs === clipMs;
  });

  const lineage = measuredRate
    ? calibrationLineage(segs, calibrationSegments)
    : { covers: false, reason: 'the rate is not a measurement' };

  // Speech-only, excluding the clip's own leading/trailing silence — the same basis
  // voice.mjs uses for `aggregate.observedEffWps`, so the two are directly comparable.
  const speechMsOf = (s) =>
    Number(s.audio?.durationMs) - (Number(s.audio?.headMs) || 0) - (Number(s.audio?.tailMs) || 0);

  // contentMs drives the summary line below; a non-numeric value would print NaN as
  // though it were a measurement.
  const contentMs = requireFiniteNumber(timing.contentMs ?? segs.at(-1).endMs, {
    name: 'timing.contentMs',
    min: 1,
  });
  const totalWords = segs.reduce((a, s) => a + wordsIn(s), 0);

  // The budget is void in exactly ONE case: when the reference rate is a measurement OF
  // THE SAME AUDIO that defines the windows, AND that measurement covers the text that is
  // in the file right now. Then `words / window` IS that rate by construction, and
  // comparing it to that rate minus a safety margin sets a threshold below the mean of the
  // thing being measured — which half the population must exceed by definition. A safety
  // margin hedges a GUESS; it cannot hedge a measurement of itself.
  //
  // Every other combination is a real comparison and keeps the budget:
  //   measured rate + AUTHORED windows  -> a genuine prediction ("will this script fit?")
  //   measured rate + EDITED text       -> also a prediction, against stale audio
  //   estimate/default rate             -> "did the audio come out as planned?"
  let over = 0;
  if (measuredRate && measuredWindows && lineage.covers) {
    console.log(`\nword rate: ${rate} wps — MEASURED (source: ${source})`);
    console.log('segment windows: MEASURED from synthesised audio');
    console.log(
      '\nword budget: NOT EVALUATED — these windows were measured FROM this audio, so\n' +
        '  words/window is that same measured rate by construction. Rate variance against the\n' +
        '  measured mean is reported instead: it is true and actionable, where a budget verdict\n' +
        '  here would be false whenever the audio exists and fits.',
    );
    console.log('\nsegment            window(s)  words     wps   vs mean');
    for (const s of segs) {
      const win = (s.endMs - s.startMs) / 1000;
      const w = wordsIn(s);
      const speechMs = speechMsOf(s);
      const segRate = speechMs > 0 ? w / (speechMs / 1000) : NaN;
      const delta = Number.isFinite(segRate) ? ((segRate - rate) / rate) * 100 : NaN;
      const shown = Number.isFinite(segRate) ? segRate.toFixed(3) : 'n/a';
      const variance = Number.isFinite(delta) ? `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%` : 'n/a';
      console.log(
        `${String(s.id).padEnd(18)} ${String(win).padStart(7)}  ${String(w).padStart(5)}  ${shown.padStart(6)}  ${variance.padStart(8)}`,
      );
    }
    console.log(`\ntotal words ${totalWords}, total window ${contentMs / 1000}s, measured mean ${rate} wps`);
    if (marginConfigured) {
      // A configured value that is silently ignored is the same class of defect as a
      // calibration file that is silently discarded: the author believes it is in force.
      console.log(
        `\nnote: intake.wpsSafetyMargin (${margin}) is NOT applied here — a margin hedges a guess,` +
          ` and this rate is a measurement of this audio. It applies when the windows are authored.`,
      );
    }
    if (values.strict) {
      console.log('\nnote: --strict has no word budget to enforce here (see above) — rate variance is advisory.');
    }
  } else {
    const WPS = rate * margin;
    const rateKind = measuredRate ? 'MEASURED rate' : 'ESTIMATE';
    console.log(`\nword rate: ${rate} wps x ${margin} margin = ${WPS.toFixed(2)} effective — ${rateKind} (source: ${source})`);
    console.log(`segment windows: ${measuredWindows ? 'MEASURED from synthesised audio' : 'AUTHORED estimates'}`);
    if (measuredRate && !lineage.covers) {
      // The audio no longer matches the script. Loud, because every later stage renders
      // the stale clips, and because this is the case the budget exists to catch.
      console.log(`\ncalibration lineage: STALE — ${lineage.reason}.`);
      console.log('  The measured rate is still the best predictor available, so it is applied as a');
      console.log('  PREDICTION against these windows, with the safety margin restored. Re-run the');
      console.log('  voice stage to re-measure before rendering.');
    }
    console.log('\nsegment            window(s)  words  budget  headroom');
    for (const s of segs) {
      const win = (s.endMs - s.startMs) / 1000;
      const w = wordsIn(s);
      const budget = Math.floor(win * WPS);
      if (w > budget) over++;
      const flag = w > budget ? '  <-- OVER' : '';
      console.log(`${String(s.id).padEnd(18)} ${String(win).padStart(7)}  ${String(w).padStart(5)}  ${String(budget).padStart(6)}  ${String(budget - w).padStart(8)}${flag}`);
    }
    console.log(`\ntotal words ${totalWords}, total window ${contentMs / 1000}s, implied wps ${(totalWords / (contentMs / 1000)).toFixed(2)} (ceiling ${WPS.toFixed(2)})`);
  }

  // The word budget is a calibration heuristic, not a hard contract — an over-budget
  // segment renders, it just reads fast. It is advisory by default and a failure under
  // --strict, so the distinction is explicit rather than assumed.
  if (over > 0) {
    if (values.strict) {
      failures.push(`${over} segment(s) over the word budget (--strict)`);
    } else {
      console.log(`\nwarning: ${over} segment(s) over the word budget — advisory; re-run with --strict to fail on this`);
    }
  }

  // --- Verdict ------------------------------------------------------------
  if (failures.length > 0) {
    console.error(`\nFAILED: ${failures.join('; ')}`);
    return EXIT.FAILED;
  }
  console.log('\nOK: all checks passed');
  return EXIT.OK;
});

/**
 * Validates `timing` against the JSON Schema at `schemaPath`.
 * @returns {Promise<null | object[]>} null when valid, otherwise the ajv error list.
 * @throws {CliError} EXIT.USAGE when ajv cannot be loaded — a schema check that did not
 *   happen must never be reported as a pass.
 */
async function validateAgainstSchema(timing, schemaPath) {
  let Ajv;
  try {
    ({ default: Ajv } = await import('ajv/dist/2020.js'));
  } catch (err) {
    throw new CliError(
      `schema validation requires \`ajv\`, which could not be loaded (${err.code ?? err.message}). ` +
        `Run \`npm install\` in the engine directory, or pass --no-schema to skip this check deliberately.`,
    );
  }

  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  } catch (err) {
    throw new CliError(`could not read schema ${schemaPath} — ${err.message}`);
  }

  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  return validate(timing) ? null : validate.errors;
}

/**
 * Resolves the reference speech rate used to reason about the narration, and says where
 * it came from.
 *
 * Calibration data, not logic, is what diverged between projects, so it is read from the
 * project rather than hardcoded. In precedence order:
 *
 *   1. `calibration-observed.json` -> `aggregate.observedEffWps`   (a MEASUREMENT)
 *   2. `timing.json` -> `intake.wordsPerSecond`                    (an ESTIMATE)
 *   3. 3.0                                                          (a DEFAULT)
 *
 * ## The key
 *
 * This used to look for a TOP-LEVEL `wordsPerSecond` in the calibration file. `voice.mjs`
 * has never written that: it writes the rate NESTED, at `aggregate.observedEffWps`. So the
 * lookup missed on every real project — the file was read, parsed, validated, and then
 * silently discarded, and every project was checked against its planning estimate while
 * appearing to use its measured rate. The tests that "covered" this hand-wrote a top-level
 * key, so the reader was proven correct against a shape the writer never produced.
 *
 * ## The margin
 *
 * `wpsSafetyMargin` is read from `intake` ONLY, never from the calibration file. It is an
 * authoring hedge, not an observable: timing-schema.json declares it under `intake` alone,
 * and voice.mjs writes no margin-like key at any depth. (`observedSafeWps` is not one — it
 * is the rate normalised to 1.0x speed, `effWps / roundedSpeed`.) Looking for a margin in
 * a file of measurements is the same mistake as the key above, in a second location.
 * It is validated whenever PRESENT, even where the caller will not apply it: an author who
 * set the value believes it matters, and silently ignoring an invalid one is how a value
 * comes to mean nothing.
 *
 * ## Absent, unreadable, and the third state
 *
 * Only an ABSENT calibration file is ignored; an unreadable or malformed one is an error,
 * because "I could not read your calibration" and "you have no calibration" are different
 * facts and only one is safe to assume. A THIRD state hid between them: read fine, key
 * never written — which rendered identically to absent, and is exactly how the defect
 * above stayed invisible for as long as it did. A calibration file that yields no rate is
 * now its own error, naming the key it expected, so a future rename in voice.mjs surfaces
 * here instead of silently reverting to the estimate.
 *
 * @returns {{rate: number, margin: number, source: string, measuredRate: boolean}}
 */
function resolveWordRate(timing, projectDir) {
  const calibrationPath = path.join(projectDir, 'calibration-observed.json');
  let observed = null;
  let raw = null;
  try {
    raw = fs.readFileSync(calibrationPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new CliError(`could not read ${calibrationPath} (${err.code}) — refusing to fall back to a default calibration`);
    }
    // No calibration file — expected for a new project, not an error.
  }
  if (raw !== null) {
    try {
      observed = JSON.parse(raw);
    } catch (err) {
      throw new CliError(`${calibrationPath} is not valid JSON — ${err.message}`);
    }
    if (observed === null || typeof observed !== 'object') {
      throw new CliError(`${calibrationPath} must contain a JSON object`);
    }
  }

  const intake = timing.intake || {};
  // `??` treats a PRESENT null as missing, so `{"wpsSafetyMargin": null}` silently took
  // the default and the run could still pass. An absent property and a present invalid
  // one are different facts; only the first is safe to substitute a default for.
  const margin = Object.hasOwn(intake, 'wpsSafetyMargin')
    ? requireFiniteNumber(intake.wpsSafetyMargin, { name: 'intake.wpsSafetyMargin', min: 0.01, max: 1 })
    : 0.95;
  const marginConfigured = Object.hasOwn(intake, 'wpsSafetyMargin');

  if (observed !== null) {
    const aggregate = observed.aggregate;
    if (aggregate === null || typeof aggregate !== 'object' || !Object.hasOwn(aggregate, 'observedEffWps')) {
      throw new CliError(
        `${calibrationPath} was read and parsed but carries no \`aggregate.observedEffWps\` — ` +
          `that is the key voice.mjs writes the measured rate to, and it is the only rate this file supplies. ` +
          `Present-but-empty is reported rather than treated as absent, because a calibration that silently ` +
          `degrades to the planning estimate is indistinguishable from one that was used. ` +
          `Re-run the voice stage to regenerate it, or delete it to fall back to intake.wordsPerSecond deliberately.`,
      );
    }
    const rate = requireFiniteNumber(aggregate.observedEffWps, {
      name: 'calibration-observed.json aggregate.observedEffWps',
      min: 0.1,
      max: 30,
    });
    return { rate, margin, marginConfigured, source: 'calibration-observed.json aggregate.observedEffWps', measuredRate: true, calibrationSegments: observed.segments };
  }

  if (Object.hasOwn(intake, 'wordsPerSecond')) {
    const rate = requireFiniteNumber(intake.wordsPerSecond, { name: 'intake.wordsPerSecond', min: 0.1, max: 30 });
    return { rate, margin, marginConfigured, source: 'timing.json intake.wordsPerSecond', measuredRate: false, calibrationSegments: null };
  }

  return { rate: 3.0, margin, marginConfigured, source: 'default', measuredRate: false, calibrationSegments: null };
}


