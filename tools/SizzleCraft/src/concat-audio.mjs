import fs from 'node:fs';
import { EXIT, CliError, runCli, parseCli, requireExistingFile, resolveOutput, describeWrite, planFooter } from './cli-support.mjs';

function audioStart(buffer) {
  let offset = 0;
  if (buffer.length >= 10 && buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
    const size = ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);
    offset = 10 + size + ((buffer[5] & 0x10) ? 10 : 0);
  }
  while (offset < buffer.length - 1) {
    if (buffer[offset] === 0xff && (buffer[offset + 1] & 0xe0) === 0xe0) break;
    offset++;
  }
  return offset;
}

function stripId3v1(buffer) {
  return buffer.length >= 128 && buffer[buffer.length - 128] === 0x54 && buffer[buffer.length - 127] === 0x41 && buffer[buffer.length - 126] === 0x47
    ? buffer.subarray(0, buffer.length - 128)
    : buffer;
}

function clean(buffer, keepLeadingTag) {
  return stripId3v1(keepLeadingTag ? buffer : buffer.subarray(audioStart(buffer)));
}

const USAGE = `
concat-audio — concatenate segment_*.mp3 into voiceover.mp3, inserting silence between
segments (pipeline stage S4).

  node concat-audio.mjs                  plan only (default)
  node concat-audio.mjs --apply          write voiceover.mp3
  node concat-audio.mjs --apply --replace  overwrite an existing voiceover.mp3

Options
  --out <file>      output path (default: voiceover.mp3)
  --project <dir>   project root; no path may escape it (default: current directory)
  --apply           actually write. Without it nothing is written.
  --replace         permit overwriting an existing --out
  --help            show this message

Exit codes: 0 success/plan · 1 write failed · 2 bad usage or refused overwrite
`.trimStart();

await runCli(() => {
  const { values, projectDir, apply, replace } = parseCli({
    usage: USAGE,
    options: { out: { type: 'string' } },
  });

  const silencePath = requireExistingFile(projectDir, 'silence.mp3', 'silence asset');
  const segmentNames = fs
    .readdirSync(projectDir)
    .filter((name) => /^segment_\d+\.mp3$/i.test(name))
    .sort();
  if (!segmentNames.length) {
    throw new CliError('no segment_000.mp3 files found', EXIT.FAILED);
  }
  const segmentPaths = segmentNames.map((name) => requireExistingFile(projectDir, name, `segment ${name}`));
  const outPath = resolveOutput(projectDir, values.out ?? 'voiceover.mp3', { apply, replace, label: 'output' });

  if (!apply) {
    console.log(`plan: concatenate ${segmentPaths.length} segment(s) with silence between them`);
    for (const name of segmentNames) console.log(`  + ${name}`);
    console.log(`  output ${outPath} — ${describeWrite(outPath, replace)}`);
    planFooter();
    return EXIT.OK;
  }

  const silence = clean(fs.readFileSync(silencePath), false);
  const buffers = [];
  for (let i = 0; i < segmentPaths.length; i++) {
    buffers.push(clean(fs.readFileSync(segmentPaths[i]), i === 0));
    if (i < segmentPaths.length - 1) buffers.push(silence);
  }
  fs.writeFileSync(outPath, Buffer.concat(buffers));
  console.log(`wrote ${outPath}`);
  return EXIT.OK;
});
