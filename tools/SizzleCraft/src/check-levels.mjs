/*
 * Reports RMS and peak levels for one or more rendered files, whole-file and at the
 * lead-in / end-card windows where the music bed plays alone.
 *
 * Two things were wrong here. ffmpeg's exit status was never checked, so a failed
 * probe produced NaN and printed "RMS NaN dB" as though it were a measurement, at
 * exit 0. And the files were a hardcoded pair including an absolute machine path
 * (C:\dev\temp\...) from one old video, so the script could not run anywhere else
 * — see ADR 0005 on refusing machine paths at author time.
 *
 * A third: the fix for the first one classified DIGITAL SILENCE as a failed measurement,
 * so this gate exited 1 on every correct narration-only render — the lead-in window is
 * deliberately silent, and astats reports that correctly as `-inf`. Silence is now its
 * own state. See astats-levels.mjs for why that distinction is the whole check.
 *
 * A fourth, and it is a CHANGE OF CONTRACT rather than a bug fix: this script only ever
 * REPORTED. Every refusal in it concerned unmeasurability — bad usage, a missing file,
 * ffmpeg failing, levels it could not read — and none compared a measured level against
 * anything, which its own usage said plainly ("0 every file measured"). So a mix defect
 * that slipped past the graph audit in mix-parameters.mjs reached a human unchallenged,
 * and that audit's header lists seven classes it cannot see, including everything outside
 * the filter graph. The windows are now JUDGED as well as printed, and a render that
 * delivered NO AUDIO exits 1. Runs that exited 0 before can exit 1 now; that is the point.
 *
 * What that gate is NOT is the broad level check it was first built as. A peak-above-full-
 * scale bound was implemented here and then WITHDRAWN after measurement: a correctly
 * limited render at the DEFAULT --ceiling measured +3.30 dBFS post-AAC, because the encode
 * overshoots the clamped sample peaks by an amount the material sets and the ceiling does
 * not bound. It would have refused good work. judgeDeliveredLevels carries the sweep and
 * the reasoning; what survives is one categorical refusal with no number in it, and the
 * honest reading is that this closes a narrow hole rather than the whole one.
 *
 * The gate is DEFAULT-ON, and its one escape is narrow on purpose. `--allow-silent` is not
 * a switch that turns the gate off: it declares the one thing that makes a silent render
 * correct — a timeline that is silent in EVERY segment, which concat-audio supports and
 * generates (README). Defaulting the other way would make the gate opt-in, and a delivery
 * check nobody remembers to pass a flag to is a check that does not run. The full report
 * still prints before the refusal.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { EXIT, CliError, runCli, requireExistingFile } from './cli-support.mjs';
import { readAstatsLevels, formatLevels, describeUnusableLevels, judgeDeliveredLevels } from './astats-levels.mjs';

const USAGE = `
check-levels — report RMS/peak audio levels for rendered video files.

  node check-levels.mjs --file part1.mp4 --file part2.mp4
  node check-levels.mjs --file "Part 1=part1.mp4" --file "Part 2=part2-with-music.mp4"
  node check-levels.mjs part1.mp4 part2.mp4

Options
  --file <[label=]path>  a file to measure; repeatable. Label defaults to the filename.
  --project <dir>        project root; files may not escape it (default: current directory)
  --ffmpeg <path>        ffmpeg binary (default: read from ffmpeg-path.txt in the project)
  --allow-silent         this project's timeline is silent in EVERY segment, so a render
                         with no audio in it is correct (see concat-audio in the README)
  --help                 show this message

A window reported as "digital silence" (-inf) is a MEASUREMENT, not a failure — the
lead-in of a narration-only render is silent by design.

THE REPORT IS ALSO A GATE. Every window is judged after it is printed, and one condition
fails the run:
  * a WHOLE FILE that is digital silence, unless --allow-silent says the timeline is
    deliberately silent in every segment — the render carries no audio at all.
A silent WINDOW is still correct and still passes. There is no peak bound (a correct
render's encode can overshoot full scale), no RMS band, and no general opt-out. See
judgeDeliveredLevels in astats-levels.mjs for the measurements behind both omissions and
for the much larger list of defects this does NOT catch.

Exit codes: 0 every window measured, audio delivered (silence in a window included) · 1
ffmpeg failed, a window was unmeasurable, or the render carries no audio · 2 bad usage
`.trimStart();

await runCli(() => {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      options: {
        file: { type: 'string', multiple: true, default: [] },
        project: { type: 'string' },
        ffmpeg: { type: 'string' },
        'allow-silent': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
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
  const specs = [...values.file, ...positionals];
  if (specs.length === 0) {
    throw new CliError(`no files to measure — pass --file <path> at least once\n\n${USAGE}`);
  }

  const files = specs.map((spec) => {
    // "label=path", but only split on the first '=' so a path containing '=' survives.
    const eq = spec.indexOf('=');
    const hasLabel = eq > 0;
    const rawPath = hasLabel ? spec.slice(eq + 1) : spec;
    const abs = requireExistingFile(projectDir, rawPath, `input file "${rawPath}"`);
    return { label: hasLabel ? spec.slice(0, eq) : path.basename(rawPath), file: abs };
  });

  const FF = resolveFfmpeg(projectDir, values.ffmpeg);

  // The third window is the TAIL, not necessarily an end card. It was labelled
  // "end card — music only", which is true only for a project that has one: with
  // endCard.enabled false there is no end card, and the last 2s may still carry
  // narration. The measurement is useful either way; the label just has to stop
  // asserting a configuration it cannot see from here.
  const sections = [
    ['whole file', [], { wholeFile: true, audioExpected: !values['allow-silent'] }],
    ['lead-in (first 1.5s — music only, no speech yet)', ['-t', '1.5'], {}],
    ['last 2s (tail — music only when the project ends on an end card)', ['-sseof', '-2'], {}],
  ];

  const labelWidth = Math.max(...files.map((f) => f.label.length), 20);
  const refusals = [];
  let first = true;
  for (const [heading, args, gate] of sections) {
    console.log(first ? heading : `\n${heading}`);
    first = false;
    for (const { label, file } of files) {
      const s = stats(FF, file, args);
      console.log(`  ${label.padEnd(labelWidth)} ${formatLevels(s)}`);
      // Judged AFTER the line is printed, and collected rather than thrown, so the whole
      // report reaches the reader. A gate that stops at the first bad window hides the
      // other measurements, which are the context for deciding what went wrong.
      const refusal = judgeDeliveredLevels(s, { label: `${label} — ${heading}`, ...gate });
      if (refusal) refusals.push(refusal);
    }
  }

  if (refusals.length > 0) {
    throw new CliError(
      `${refusals.length} delivered file(s) carry no audio — this render must not be delivered:\n` +
        refusals.map((r) => `  ${r}`).join('\n'),
      EXIT.FAILED,
    );
  }
  return EXIT.OK;
});

/** Resolves the ffmpeg binary, preferring --ffmpeg over the project's ffmpeg-path.txt. */
function resolveFfmpeg(projectDir, override) {
  if (override) return override;
  const pointer = path.join(projectDir, 'ffmpeg-path.txt');
  if (!fs.existsSync(pointer)) {
    throw new CliError(
      `ffmpeg-path.txt not found in ${projectDir} — create it containing the path to ffmpeg, or pass --ffmpeg <path>`,
    );
  }
  const ff = fs.readFileSync(pointer, 'utf8').trim();
  if (!ff) throw new CliError(`ffmpeg-path.txt in ${projectDir} is empty`);
  return ff;
}

/**
 * Measures RMS and peak for `file`. Throws rather than returning NaN: a level this
 * script could not measure must not be printed as though it had been.
 *
 * A SILENT window is not such a case. See astats-levels.mjs — `-inf` is what a correct
 * measurement of this pipeline's deliberate lead-in looks like.
 */
function stats(FF, file, args = []) {
  const r = spawnSync(FF, ['-hide_banner', ...args, '-i', file,
    '-af', 'astats=metadata=1:reset=0', '-f', 'null', '-'], { encoding: 'utf8' });

  if (r.error) {
    throw new CliError(`could not run ffmpeg at "${FF}" — ${r.error.message}`, EXIT.FAILED);
  }
  if (r.status !== 0) {
    const tail = ((r.stderr || '').trim().split('\n').slice(-5).join('\n')) || '(no stderr)';
    throw new CliError(`ffmpeg exited ${r.status} while measuring ${file}:\n${tail}`, EXIT.FAILED);
  }

  const out = (r.stdout || '') + (r.stderr || ''); // astats reports on stderr
  const levels = readAstatsLevels(out);
  if (levels.state === 'unmeasurable') {
    throw new CliError(describeUnusableLevels(file, out, levels), EXIT.FAILED);
  }
  return levels;
}
