// Generates silence.mp3 matching the msedge-tts profile exactly
// (audio-24khz-96kbitrate-mono-mp3), so byte concatenation stays frame-aligned.
//
// MPEG-2 Layer III, 24 kHz, 96 kbps, mono:
//   frame header  FF F3 A4 C0
//   frame size    72 * 96000 / 24000 = 288 bytes
//   frame time    576 samples / 24000 Hz = 24 ms
// Side info + main_data are left zeroed, which every compliant decoder renders as silence.
//
// Writing is an explicit opt-in: this script is invoked with a caller-supplied output path,
// so an unguarded run could overwrite an arbitrary file. The default plans and writes nothing.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { EXIT, CliError, runCli, resolveOutput } from './cli-support.mjs';

const FRAME_BYTES = 288;
const FRAME_MS = (576 / 24000) * 1000; // 24

const USAGE = `
silence-gen — generate a frame-aligned silent MP3 matching the msedge-tts profile.

  node silence-gen.mjs --out gap.mp3 --ms 3500                    plan only (default)
  node silence-gen.mjs --out gap.mp3 --ms 3500 --apply            write a new file
  node silence-gen.mjs --out gap.mp3 --ms 3500 --apply --replace  overwrite an existing file

Options
  --out <file>      output path, relative to the project root (default: silence.mp3)
  --ms <number>     target duration in milliseconds, 1..3600000 (default: 3500)
  --project <dir>   project root; --out may not escape it (default: current directory)
  --apply           actually write. Without it nothing is written.
  --replace         permit overwriting an existing --out
  --help            show this message

Positional form \`silence-gen.mjs <outFile> <targetMs>\` is still accepted for
compatibility with existing build sequences, but --apply is required to write.

Exit codes: 0 success/plan · 1 write failed · 2 bad usage or refused overwrite
`.trimStart();

/**
 * Strict duration parse. Accepts a plain positive decimal only — the previous
 * `Number(argv[3])` accepted values like "1e9", which is a 288 GB allocation.
 */
function parseDurationMs(raw) {
  const text = String(raw ?? '').trim();
  if (!/^(?:\d+|\d*\.\d+)$/.test(text)) {
    throw new CliError(`--ms must be a plain number of milliseconds — got "${raw}"`);
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0 || value > 3_600_000) {
    throw new CliError(`--ms must be between 1 and 3600000 — got ${text}`);
  }
  return value;
}

await runCli(() => {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      options: {
        out: { type: 'string' },
        ms: { type: 'string' },
        project: { type: 'string' },
        apply: { type: 'boolean', default: false },
        replace: { type: 'boolean', default: false },
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
  const outArg = values.out ?? positionals[0] ?? 'silence.mp3';
  const msArg = values.ms ?? positionals[1] ?? '3500';

  // Validated before anything touches the filesystem: `ms` drives an allocation size
  // and `out` is a caller-supplied write target.
  const targetMs = parseDurationMs(msArg);
  const frames = Math.max(1, Math.round(targetMs / FRAME_MS));
  const bytes = FRAME_BYTES * frames;
  const outPath = resolveOutput(projectDir, outArg, {
    apply: values.apply === true,
    replace: values.replace === true,
    label: 'output',
  });

  if (!values.apply) {
    console.log(`plan: ${frames} frames, ${(frames * FRAME_MS).toFixed(0)}ms, ${bytes} bytes`);
    console.log(`  output ${outPath}`);
    console.log('');
    console.log('nothing was written. Re-run with --apply to write.');
    return EXIT.OK;
  }

  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < frames; i++) {
    const o = i * FRAME_BYTES;
    buf[o] = 0xff; buf[o + 1] = 0xf3; buf[o + 2] = 0xa4; buf[o + 3] = 0xc0;
  }
  fs.writeFileSync(outPath, buf);
  console.log(`${outPath}: ${frames} frames, ${(frames * FRAME_MS).toFixed(0)}ms, ${buf.length} bytes`);
  return EXIT.OK;
});
