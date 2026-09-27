import fs from 'node:fs';
import path from 'node:path';
import { EXIT, CliError, runCli, parseCli, requireExistingFile, resolveOutput, describeWrite, planFooter } from './cli-support.mjs';
import { isSilentSegment, silentSegmentProblems, silentDurationMs, silentMp3, silentMp3DurationMs, SILENCE_FRAME_MS } from './silent-segment.mjs';

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
concat-audio — concatenate the per-segment clips into voiceover.mp3, inserting silence
between segments (pipeline stage S4).

  node concat-audio.mjs                    plan only (default)
  node concat-audio.mjs --apply            write voiceover.mp3
  node concat-audio.mjs --apply --replace  overwrite an existing voiceover.mp3

Segments declared silent in timing.json (\`segments[].silence\`) have no clip to
concatenate, so their authored window is filled with generated digital silence. They keep
their place and their length in the voice track, which is what stops every later segment
drifting earlier.

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

  // THE TIMELINE IS THE AUTHORITY, NOT THE DIRECTORY LISTING.
  //
  // This stage used to glob `segment_*.mp3` and concatenate whatever it found. A glob
  // cannot tell "three segments, the middle one deliberately silent" apart from "three
  // segments, the middle clip missing" — or from "two segments". So a segment with no
  // clip was simply omitted, and EVERY LATER SEGMENT MOVED EARLIER by its whole duration:
  // a corrupted timeline, no error, exit 0. Measured on the fixture in
  // tests/silent-segments.test.mjs, a 2160ms track came out 1440ms, putting the back half
  // a full 720ms early against the picture.
  //
  // Reading timing.json makes the hole DETECTABLE, and the `silence` declaration makes it
  // ATTRIBUTABLE: a hole that was declared is filled, and one that was not is refused.
  const timingPath = requireExistingFile(projectDir, 'timing.json', 'timing file');
  let timing;
  try {
    timing = JSON.parse(fs.readFileSync(timingPath, 'utf8'));
  } catch (err) {
    throw new CliError(`${timingPath} is not valid JSON — ${err.message}`, EXIT.FAILED);
  }
  const segments = Array.isArray(timing.segments) ? timing.segments : [];
  if (!segments.length) {
    throw new CliError('timing.json declares no segments — there is nothing to concatenate', EXIT.FAILED);
  }

  const discovered = fs
    .readdirSync(projectDir)
    .filter((name) => /^segment_\d+\.mp3$/i.test(name))
    .sort();

  // Two ways a project names its clips, and they must not be mixed.
  //
  // After the voice stage runs, every segment carries `audio.file`, and that name is
  // authoritative. A project that predates it has clips on disk and no names in the
  // timeline, which can only be mapped positionally. A PARTIALLY named project is
  // ambiguous — positional mapping would hand one segment's clip to another, quietly — so
  // it is refused below rather than guessed at.
  const declaredName = segments.map((s) =>
    typeof s.audio?.file === 'string' && s.audio.file.trim() !== '' ? s.audio.file : null);
  const anyNamed = declaredName.some((n) => n !== null);

  const used = new Set();
  let nextPositional = 0;
  const parts = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const label = `segment "${seg?.id ?? i}"`;
    const silent = isSilentSegment(seg);

    if (silent) {
      const problems = silentSegmentProblems(seg, label);
      if (problems.length) throw new CliError(problems[0], EXIT.FAILED);
    }

    let name = declaredName[i];
    if (name === null && !anyNamed && !silent) {
      // Positional mode: a silent segment consumes no clip, so the pointer only advances
      // for segments that actually need one.
      name = discovered[nextPositional++] ?? null;
    }

    const onDisk = name !== null && fs.existsSync(path.join(projectDir, name));

    if (onDisk) {
      // Confine the name before reading it: `audio.file` is authored input, and authored
      // input is not trusted input.
      const resolved = requireExistingFile(projectDir, name, `${label} audio`);
      used.add(path.basename(resolved));
      parts.push({
        kind: 'clip',
        id: seg.id,
        name: path.basename(resolved),
        bytes: clean(fs.readFileSync(resolved), parts.length === 0),
        silent,
      });
      continue;
    }

    if (silent) {
      // The authored window IS the duration — there is no second field to disagree with
      // it. Generated at the shared frame size so the concatenation stays frame-aligned,
      // exactly as an inserted gap does.
      const requestedMs = silentDurationMs(seg);
      parts.push({
        kind: 'generated',
        id: seg.id,
        requestedMs,
        realMs: silentMp3DurationMs(requestedMs),
        bytes: silentMp3(requestedMs),
        silent: true,
      });
      continue;
    }

    // A hole nobody declared. Nothing on disk says how long it should be, so there is no
    // safe fill — and dropping it is the corruption described above.
    throw new CliError(
      `${label} has no clip to concatenate` +
      (name === null ? ' and no `audio.file` naming one' : ` (${name} is missing)`) +
      (anyNamed && declaredName[i] === null ? ', while other segments do name theirs' : '') +
      '. The voice stage has not produced it and it is not declared silent — run voice.mjs (S3), ' +
      'or add a `silence` declaration if this segment is meant to be a gap.',
      EXIT.FAILED);
  }

  const orphans = discovered.filter((name) => !used.has(name));

  // Inter-segment silence is NOT inserted beside a declared silent segment: the authored
  // silence already IS the pause, and padding it would make the audio longer than the
  // timeline that describes it.
  const seam = (i) => i + 1 < parts.length && !parts[i].silent && !parts[i + 1].silent;
  const seamCount = parts.reduce((n, _, i) => n + (seam(i) ? 1 : 0), 0);

  // Required only where a seam will actually use it, so an entirely silent project is not
  // asked for an asset it has no use for.
  const silencePath = seamCount > 0 ? requireExistingFile(projectDir, 'silence.mp3', 'silence asset') : null;

  const outPath = resolveOutput(projectDir, values.out ?? 'voiceover.mp3', { apply, replace, label: 'output' });

  // Generated silence lands on a whole number of 24ms frames, so a filled window can miss
  // its authored length by up to 12ms — and across several silent segments that
  // accumulates. Disclosed rather than absorbed: a track that is quietly 120ms short of
  // the timeline describing it is drift, and drift that nothing prints is drift nobody
  // finds. (The voice stage reflows the timeline onto the probed durations, so a full
  // pipeline run ends up consistent; a standalone S4 does not.)
  const generated = parts.filter((p) => p.kind === 'generated');
  const quantDeltaMs = generated.reduce((a, p) => a + (p.realMs - p.requestedMs), 0);
  const quantNote = quantDeltaMs === 0 ? null
    : `note: generated silence is quantised to ${SILENCE_FRAME_MS}ms frames, so the filled window(s) come to `
    + `${quantDeltaMs > 0 ? '+' : ''}${quantDeltaMs}ms against their authored length. Re-run voice.mjs (S3) to `
    + 'reflow the timeline onto the audio that exists.';

  if (!apply) {
    console.log(`plan: concatenate ${parts.length} segment(s), inserting silence at ${seamCount} seam(s)`);
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.kind === 'clip') console.log(`  + ${p.name}${p.silent ? `  (segment "${p.id}" — declared silent)` : ''}`);
      else console.log(`  + segment "${p.id}" — GENERATE ${p.realMs}ms of digital silence (declared silent, no clip on disk)`);
      if (seam(i)) console.log('  + silence.mp3');
    }
    for (const name of orphans) console.log(`  ! ${name} is on disk but no segment claims it — it will NOT be included`);
    console.log(`  output ${outPath} — ${describeWrite(outPath, replace)}`);
    if (quantNote) console.log(`  ${quantNote}`);
    planFooter();
    return EXIT.OK;
  }

  const silence = silencePath === null ? null : clean(fs.readFileSync(silencePath), false);
  const buffers = [];
  for (let i = 0; i < parts.length; i++) {
    buffers.push(parts[i].bytes);
    if (seam(i)) buffers.push(silence);
  }
  fs.writeFileSync(outPath, Buffer.concat(buffers));
  for (const p of parts) {
    if (p.kind === 'generated') {
      console.log(`generated ${p.realMs}ms of silence for segment "${p.id}" (authored window ${p.requestedMs}ms)`);
    }
  }
  for (const name of orphans) console.log(`warning: ${name} is on disk but no segment claims it — it was NOT included`);
  if (quantNote) console.log(quantNote);
  console.log(`wrote ${outPath}`);
  return EXIT.OK;
});
