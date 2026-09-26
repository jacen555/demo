/*
 * Reports RMS and peak levels for one or more rendered files, whole-file and at the
 * lead-in / end-card windows where the music bed plays alone.
 *
 * Two things were wrong here. ffmpeg's exit status was never checked, so a failed
 * probe produced NaN and printed "RMS NaN dB" as though it were a measurement, at
 * exit 0. And the files were a hardcoded pair including an absolute machine path
 * (C:\dev\temp\...) from one old video, so the script could not run anywhere else
 * — see ADR 0005 on refusing machine paths at author time.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { EXIT, CliError, runCli, requireExistingFile } from './cli-support.mjs';

const USAGE = `
check-levels — report RMS/peak audio levels for rendered video files.

  node check-levels.mjs --file part1.mp4 --file part2.mp4
  node check-levels.mjs --file "Part 1=part1.mp4" --file "Part 2=part2-with-music.mp4"
  node check-levels.mjs part1.mp4 part2.mp4

Options
  --file <[label=]path>  a file to measure; repeatable. Label defaults to the filename.
  --project <dir>        project root; files may not escape it (default: current directory)
  --ffmpeg <path>        ffmpeg binary (default: read from ffmpeg-path.txt in the project)
  --help                 show this message

Exit codes: 0 every file measured · 1 ffmpeg failed or a measurement was unusable · 2 bad usage
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

  const sections = [
    ['whole file', []],
    ['lead-in (first 1.5s — music only, no speech yet)', ['-t', '1.5']],
    ['last 2s (end card — music only)', ['-sseof', '-2']],
  ];

  const labelWidth = Math.max(...files.map((f) => f.label.length), 20);
  let first = true;
  for (const [heading, args] of sections) {
    console.log(first ? heading : `\n${heading}`);
    first = false;
    for (const { label, file } of files) {
      const s = stats(FF, file, args);
      console.log(`  ${label.padEnd(labelWidth)} RMS ${s.rms.toFixed(1)} dB   peak ${s.peak.toFixed(1)} dBFS`);
    }
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
  const grab = (k) => {
    const m = [...out.matchAll(new RegExp(k + ':\\s*(-?[\\d.]+)', 'g'))].map((x) => parseFloat(x[1]));
    return m.length ? m[m.length - 1] : NaN;
  };
  const rms = grab('RMS level dB');
  const peak = grab('Peak level dB');
  if (!Number.isFinite(rms) || !Number.isFinite(peak)) {
    throw new CliError(
      `ffmpeg produced no usable astats levels for ${file} — the file may have no audio track`,
      EXIT.FAILED,
    );
  }
  return { rms, peak };
}
