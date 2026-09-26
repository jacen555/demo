/*
 * Audio-only remux: mixes the ambient bed under the narration and muxes it
 * back onto the ALREADY-ENCODED video stream with -c:v copy, so the video is
 * bit-identical and no re-render is needed (~1 min instead of ~27).
 *
 * Default levels are the ones approved on Part 1:
 *   voice  volume=1.14    (the encoder normalisation gain; encode-mp4 logs it)
 *   music  volume=1.50    (+3.5 dB, the "slightly louder" pass)
 *   amix   normalize=0    (do NOT let amix halve both buses)
 *   alimiter limit=0.891  (-1.0 dBFS ceiling)
 *
 * Mono -> stereo uses pan, NOT aformat: aformat applies -3 dB power
 * compensation and quietly drops the narration level.
 *
 * Output is 24 kHz stereo to match the delivered Part 1 exactly.
 *
 * Three things were wrong here and all three are load-bearing:
 *   - the input and output filenames were hardcoded to one old video;
 *   - the gains came straight off argv into an ffmpeg filter graph with no
 *     validation, where a comma does not error, it appends another filter;
 *   - ffmpeg was given -y unconditionally, and the md5 check that exists purely
 *     to prove the video stream survived printed "!! VIDEO STREAM CHANGED !!"
 *     and still exited 0 — waving through the exact case it was written to catch.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { EXIT, CliError, runCli, requireExistingFile, resolveOutput, parseBoundedNumber } from './cli-support.mjs';
import { videoStreamVerdict } from './remux-verify.mjs';

// Linear volume multipliers. 8.0 is about +18 dB — far past anything useful here, and
// well short of a value that would produce a nonsense filter graph.
const GAIN_MIN = 0;
const GAIN_MAX = 8;

const USAGE = `
remux-music — mix the music bed under the narration and mux it onto an existing
video stream without re-encoding the video (pipeline stage S8/S9, "the cheap path").

  node remux-music.mjs --video render.mp4 --out render-with-music.mp4
                                                       plan only (default)
  node remux-music.mjs --video render.mp4 --out render-with-music.mp4 --apply
  node remux-music.mjs --video render.mp4 --out render-with-music.mp4 --apply --replace

Options
  --video <file>        the already-encoded video (required)
  --out <file>          output file (required)
  --voice <file>        narration track (default: voiceover.mp3)
  --music <file>        music bed (default: music.wav)
  --voice-gain <n>      linear voice gain, ${GAIN_MIN}..${GAIN_MAX} (default: 1.14)
  --music-gain <n>      linear music gain, ${GAIN_MIN}..${GAIN_MAX} (default: 1.50)
  --project <dir>       project root; no path may escape it (default: current directory)
  --ffmpeg <path>       ffmpeg binary (default: read from ffmpeg-path.txt in the project)
  --apply               actually remux. Without it nothing is written.
  --replace             permit overwriting an existing --out
  --help                show this message

Exit codes: 0 success/plan · 1 ffmpeg failed or the video stream was NOT preserved · 2 bad usage
`.trimStart();

await runCli(() => {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        video: { type: 'string' },
        out: { type: 'string' },
        voice: { type: 'string' },
        music: { type: 'string' },
        'voice-gain': { type: 'string' },
        'music-gain': { type: 'string' },
        project: { type: 'string' },
        ffmpeg: { type: 'string' },
        apply: { type: 'boolean', default: false },
        replace: { type: 'boolean', default: false },
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
  if (!values.video || !values.out) {
    throw new CliError(`--video and --out are both required\n\n${USAGE}`);
  }

  const projectDir = path.resolve(values.project ?? process.cwd());
  const video = requireExistingFile(projectDir, values.video, 'video');
  const voice = requireExistingFile(projectDir, values.voice ?? 'voiceover.mp3', 'voice track');
  const music = requireExistingFile(projectDir, values.music ?? 'music.wav', 'music bed');
  const outPath = resolveOutput(projectDir, values.out, {
    apply: values.apply === true,
    replace: values.replace === true,
    label: 'output',
  });
  if (outPath === video) {
    throw new CliError('--out must differ from --video; remuxing onto the source in place would destroy it');
  }

  // Validated before they are ever interpolated. `volume=${gain}` sits inside a filter
  // graph, so an unchecked value is a filter-injection primitive, not just a bad number.
  const voiceGain = parseBoundedNumber(values['voice-gain'] ?? '1.14', {
    name: '--voice-gain', min: GAIN_MIN, max: GAIN_MAX,
  });
  const musicGain = parseBoundedNumber(values['music-gain'] ?? '1.50', {
    name: '--music-gain', min: GAIN_MIN, max: GAIN_MAX,
  });

  const filter =
    `[1:a]volume=${voiceGain},pan=stereo|c0=c0|c1=c0[vo];` +
    `[2:a]volume=${musicGain}[mu];` +
    `[vo][mu]amix=inputs=2:duration=longest:normalize=0[mx];` +
    `[mx]alimiter=limit=0.891:level=disabled[out]`;

  const FF = resolveFfmpeg(projectDir, values.ffmpeg);
  const ffArgs = [
    values.replace ? '-y' : '-n', '-hide_banner', '-loglevel', 'error',
    '-i', video, '-i', voice, '-i', music,
    '-filter_complex', filter,
    '-map', '0:v', '-c:v', 'copy',
    '-map', '[out]', '-c:a', 'aac', '-b:a', '160k', '-ar', '24000', '-ac', '2',
    '-movflags', '+faststart',
    outPath,
  ];

  if (!values.apply) {
    console.log('plan: audio-only remux (video stream copied, not re-encoded)');
    console.log(`  video   ${video}`);
    console.log(`  voice   ${voice}  (gain ${voiceGain})`);
    console.log(`  music   ${music}  (gain ${musicGain})`);
    console.log(`  output  ${outPath}`);
    console.log(`  filter  ${filter}`);
    console.log(`\nwould run:\n  ${FF} ${ffArgs.join(' ')}`);
    console.log('\nnothing was written. Re-run with --apply to remux.');
    return EXIT.OK;
  }

  console.log(`voice ${voiceGain} · music ${musicGain}`);
  try {
    execFileSync(FF, ffArgs, { stdio: 'inherit' });
  } catch (err) {
    throw new CliError(`ffmpeg failed while remuxing (${err.message}) — ${outPath} was not produced`, EXIT.FAILED);
  }

  // Prove the video stream survived untouched. This check is the entire justification
  // for the cheap path: if the stream changed, the output is a re-encode wearing the
  // cheap path's name, and it must not be published as an approved deliverable.
  const md5 = (f) => execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', f,
    '-map', '0:v', '-c', 'copy', '-f', 'md5', '-'], { encoding: 'utf8' }).trim();

  const before = md5(video);
  const after = md5(outPath);
  console.log(`video ${before}`);
  console.log(`remux ${after}`);
  console.log(`${outPath} ${(fs.statSync(outPath).size / 1048576).toFixed(2)} MB`);

  const verdict = videoStreamVerdict(before, after, path.basename(outPath));
  if (!verdict.identical) {
    console.error(`\nFAILED: ${verdict.message}`);
    return verdict.exitCode;
  }
  console.log(verdict.message);
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
