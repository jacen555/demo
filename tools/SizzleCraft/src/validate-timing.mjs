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
import { EXIT, CliError, runCli, requireExistingFile, requireFiniteNumber } from './cli-support.mjs';

const SHIPPED_SCHEMA = fileURLToPath(new URL('./timing-schema.json', import.meta.url));

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
  for (const s of segs) {
    if (s.startMs !== prev) breaks.push(`${s.id} gap/overlap at ${s.startMs} (expected ${prev})`);
    prev = s.endMs;
  }
  if (breaks.length === 0) {
    console.log('contiguity: OK');
  } else {
    console.log('contiguity: BROKEN');
    for (const b of breaks) console.log(`  ${b}`);
    failures.push(`${breaks.length} contiguity break(s)`);
  }

  // --- Word budget --------------------------------------------------------
  const { wps: WPS, rate, margin, source } = resolveWps(timing, projectDir);
  console.log(`\nword rate: ${rate} wps x ${margin} margin = ${WPS.toFixed(2)} effective (source: ${source})`);
  console.log('\nsegment            window(s)  words  budget  headroom');
  let tw = 0;
  let over = 0;
  for (const s of segs) {
    const win = (s.endMs - s.startMs) / 1000;
    const w = String(s.voiceoverText ?? '').trim().split(/\s+/).filter(Boolean).length;
    tw += w;
    const budget = Math.floor(win * WPS);
    if (w > budget) over++;
    const flag = w > budget ? '  <-- OVER' : '';
    console.log(`${String(s.id).padEnd(18)} ${String(win).padStart(7)}  ${String(w).padStart(5)}  ${String(budget).padStart(6)}  ${String(budget - w).padStart(8)}${flag}`);
  }
  // contentMs drives the implied-wps summary below; a non-numeric value would print NaN
  // as though it were a measurement.
  const contentMs = requireFiniteNumber(timing.contentMs ?? segs.at(-1).endMs, {
    name: 'timing.contentMs',
    min: 1,
  });
  console.log(`\ntotal words ${tw}, total window ${contentMs / 1000}s, implied wps ${(tw / (contentMs / 1000)).toFixed(2)} (ceiling ${WPS.toFixed(2)})`);

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
 * Effective speech rate used for the word-budget check.
 *
 * This is the ONLY thing that diverged between projects (3.43*0.97 vs 3.00*0.95), which
 * is calibration data, not logic — so it is read from the project rather than hardcoded.
 * Set `intake.wordsPerSecond` / `intake.wpsSafetyMargin` in timing.json, or drop a
 * calibration-observed.json next to it. Falls back to a conservative default.
 *
 * Every value is validated before it is used. `"wordsPerSecond": "oops"` made the budget
 * NaN, and `words > NaN` is always false — so no segment was ever over budget and even
 * --strict exited 0. A threshold that cannot be compared does not relax the check, it
 * removes it. Only an ABSENT calibration file is ignored; a malformed one is an error,
 * because "I could not read your calibration" and "you have no calibration" are
 * different facts and only one of them is safe to assume.
 */
function resolveWps(timing, projectDir) {
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
  const pick = (key) => {
    if (observed !== null && Object.hasOwn(observed, key)) {
      return { present: true, value: observed[key], from: 'calibration-observed.json' };
    }
    if (Object.hasOwn(intake, key)) {
      return { present: true, value: intake[key], from: 'timing.json intake' };
    }
    return { present: false };
  };

  const ratePick = pick('wordsPerSecond');
  const marginPick = pick('wpsSafetyMargin');

  const rate = ratePick.present
    ? requireFiniteNumber(ratePick.value, { name: 'wordsPerSecond', min: 0.1, max: 30 })
    : 3.0;
  const margin = marginPick.present
    ? requireFiniteNumber(marginPick.value, { name: 'wpsSafetyMargin', min: 0.01, max: 1 })
    : 0.95;

  const source = ratePick.present ? ratePick.from : 'default';

  return { wps: rate * margin, rate, margin, source };
}


