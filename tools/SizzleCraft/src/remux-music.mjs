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
 *
 * ## What planning costs
 *
 * Planning does NOT run ffmpeg and writes nothing. It is not, however, free, and an
 * earlier version of this comment claimed it was while the code below read the entire
 * music file synchronously to hash it. A plan reads every byte of --music (streamed, to
 * hash it for the gain pin) and decodes enough of it to read its duration. Both are
 * unavoidable here: the pin status and the loop decision are the two things a plan
 * exists to report, and neither can be answered without its input. What a plan will
 * never do is run the encode or touch the output.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import {
  EXIT, CliError, runCli, requireExistingFile, resolveOutput, parseBoundedNumber,
  resolveInternalArtifact, readOptionalEngineJson, openExclusiveEngineFile,
} from './cli-support.mjs';
import { videoStreamVerdict } from './remux-verify.mjs';
import { classifyGainPin, describeGainPinRefusal, describeGainPinPlan } from './gain-pin.mjs';
import { probeDurationSeconds } from './audio-probe.mjs';

const TIMING_NAME = 'timing.json';

const LOCK_NAME = 'music-gain.lock.json';

/**
 * SHA-256 of a file, streamed.
 *
 * Streamed rather than `readFileSync` because this runs on the PLAN path, and a
 * synchronous whole-file read of a licensed master blocks the event loop for as long as
 * the disk takes. Streaming does not make the read free — the plan still reads every
 * byte, and the header comment says so — it stops it from being a blocking call.
 */
async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

/**
 * Reads the gain lock, if there is one.
 *
 * `resolveInternalArtifact` rather than a raw join: this path is ENGINE-CHOSEN. The
 * caller named --music and --out; it never named `music-gain.lock.json`. Containment
 * alone deliberately permits an in-root link because a user-named output may legitimately
 * be one — but nobody asked for this file, so a link at it redirects a read, and later a
 * write, that the caller never requested. `'read'` is not cosmetic: telling someone a
 * read was "refused to write through" sends them looking for the wrong thing.
 */
function readGainLock(projectDir) {
  const lockPath = resolveInternalArtifact(projectDir, LOCK_NAME, 'music gain pin', 'read');
  if (!fs.existsSync(lockPath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    // Deliberately not surfacing the parse error: an unreadable pin is classified as
    // "not a confirmation" by classifyGainPin, which is the answer that matters, and the
    // refusal text explains it without quoting the file back.
    return {};
  }
  // A present-but-unusable pin is NOT an absent one. Returning null here would report it
  // as "never confirmed", which is the wrong diagnosis for a file that is sitting right
  // there — the same absent/malformed collapse readOptionalEngineJson exists to prevent.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed;
}

/**
 * Publishes the gain lock through an exclusively-created temp file and a rename.
 *
 * Re-resolving before an `fs.writeFileSync` NARROWS the window between the check and the
 * write; it does not close it. `writeFileSync` opens with `'w'`, which FOLLOWS a symlink
 * at the destination, so a link planted after the guard ran still gets written through
 * and its outside target truncated. `renameSync` replaces the directory ENTRY instead, so
 * a link appearing at the destination is overwritten rather than followed, and the guard
 * and the action describe the same path by construction — the property encode-mp4.mjs
 * documents at its own publish step.
 *
 * `evidence` and `confirmedAt` are written ONLY here, and this is called only when an
 * operator actually passed --confirm-gain. A timestamp that refreshes on a run where
 * nobody confirmed anything is a false record on its own, independent of what else the
 * file says.
 */
function writeGainLock(projectDir, current) {
  const lockPath = resolveInternalArtifact(projectDir, LOCK_NAME, 'music gain pin', 'write');
  const record = { ...current, evidence: 'operator-confirmed', confirmedAt: new Date().toISOString() };

  const temp = openExclusiveEngineFile(projectDir, `${LOCK_NAME}.part-${process.pid}`, 'music gain pin temp file');
  try {
    fs.writeFileSync(temp.fd, `${JSON.stringify(record, null, 2)}\n`);
    fs.closeSync(temp.fd);
    fs.renameSync(temp.path, lockPath); // atomic publish — replaces the entry, never follows it
  } catch (err) {
    // cleanup() removes ONLY the part file this run created, and reports it if removal
    // fails rather than claiming a clean abort it did not achieve.
    const leftover = temp.cleanup();
    throw new CliError(
      `could not publish the music gain pin (${err.code ?? err.message})` +
      `${leftover ? ` — ${leftover.message}` : ''}`,
      EXIT.FAILED,
    );
  }
  return lockPath;
}

// Video length from frame-capture's own frame formula, so this agrees with the encoded
// stream exactly rather than depending on a container probe.
//
// Pure: it is handed the already-read timing document rather than reading one, so the
// confinement decision happens once, at a boundary, and this stays directly testable.
// `timing === null` means the file is genuinely absent, which is an undecidable input
// rather than a refusal — a stub project is allowed to plan.
function resolveVideoSeconds(override, timing) {
  if (override !== null) return override;
  if (timing === null) {
    throw new Error(`no ${TIMING_NAME} in the project — pass --video-seconds to state the video length`);
  }
  const fps = Number(timing.project?.fps || 30);
  const durationMs = Number(timing.durationMs);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error(`invalid timing.durationMs (${durationMs}) in ${TIMING_NAME}`);
  }
  return Math.ceil(((durationMs + 1000) / 1000) * fps) / fps;
}

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
  --crossfade <sec>     crossfade at each loop wrap, 0.1..30 (default: 3)
  --no-loop             refuse rather than loop a music bed shorter than the video
  --confirm-gain        confirm --music-gain for the current music source (bug-ledger 16).
                        Required on first use and whenever the source or the gain changes.
  --video-seconds <n>   override the video length used to size the loop
  --ceiling <dB>        limiter headroom in dB BELOW full scale, 0.1..12 (default: 1.0).
                        NOTE this is dBFS and TRUE PEAK sits above it, because
                        inter-sample peaks exceed sample peaks. Use about 2.5 to deliver
                        -1.0 dBTP.
  --project <dir>       project root; no path may escape it (default: current directory)
  --ffmpeg <path>       ffmpeg binary (default: read from ffmpeg-path.txt in the project)
  --apply               actually remux. Without it nothing is written.
  --replace             permit overwriting an existing --out
  --help                show this message

Exit codes: 0 success/plan · 1 ffmpeg failed or the video stream was NOT preserved · 2 bad usage
`.trimStart();
await runCli(async () => {
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
        crossfade: { type: 'string' },
        'no-loop': { type: 'boolean' },
        'confirm-gain': { type: 'boolean' },
        ceiling: { type: 'string' },
        'video-seconds': { type: 'string' },
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

  // THE GAIN PIN (bug-ledger entry 16).
  //
  // A gain is only meaningful for the track it was confirmed against: a generated bed at
  // -43.1 dB RMS and a licensed master at -11.4 dB are 31.7 dB apart and both accept the
  // same in-range gain, so bounding the VALUE cannot catch this. Nothing downstream can
  // either — the narration-gap checks measure whether a bed is PRESENT, not whether it is
  // at the right LEVEL.
  //
  // The gate is on WRITING, not on planning: the plan produces no artefact, so it reports
  // the pin status instead of refusing, and --apply is where an unconfirmed gain is
  // stopped. See gain-pin.mjs for what this pin does and does not certify.
  const lock = readGainLock(projectDir);
  const current = { source: path.basename(music), sha256: await sha256File(music), musicGain };
  const pin = classifyGainPin(lock, current);
  const confirmed = values['confirm-gain'] === true;

  if (values.apply && pin.requiresConfirmation && !confirmed) {
    throw new CliError(describeGainPinRefusal(pin, current));
  }

  const xfade = parseBoundedNumber(values.crossfade ?? '3', {
    name: '--crossfade', min: 0.1, max: 30,
  });

  // A LIMITER CEILING IS dBFS; A DELIVERY TARGET IS USUALLY dBTP. The two are not the
  // same number: inter-sample peaks reconstructed on playback run above the sample peaks
  // the limiter clamps, so a -1.0 dBFS ceiling measured -0.3 to -0.7 dBTP on real mixes
  // here. A project asked to deliver <= -1.0 dBTP could not reach it at any input gain,
  // because the ceiling was fixed.
  //
  // Expressed as dB BELOW full scale (a positive number) rather than as a negative dBFS
  // value: gains reach an ffmpeg filter graph, so the shared parser refuses anything that
  // is not a plain decimal, and a leading dash is also ambiguous to parseArgs. "How much
  // headroom" is the more natural question anyway.
  const ceilingBelowFs = parseBoundedNumber(values.ceiling ?? '1.0', {
    name: '--ceiling', min: 0.1, max: 12,
  });
  const ceilingLinear = Number(Math.pow(10, -ceilingBelowFs / 20).toFixed(6));

  // A BAD ARGUMENT IS A USAGE ERROR, NOT AN UNDECIDABLE INPUT. Parsed here, outside the
  // try below, because that try turns anything it catches into "could not decide" on the
  // plan path — which would let `--video-seconds 0` be planned around at exit 0 instead
  // of refused. The operator being wrong and the input being unknowable are different
  // states and only one of them is recoverable.
  const videoSecondsOverride = values['video-seconds'] !== undefined
    ? parseBoundedNumber(values['video-seconds'], { name: '--video-seconds', min: 0.1, max: 36000 })
    : null;

  // Read up front, and OUTSIDE the try below, because the states are not the same kind of
  // thing. A link, a malformed file or an unreadable one is a REFUSAL — it means someone
  // put something there that must not be read through, and folding that into "could not
  // decide" would let a planted file be planned around at exit 0. An ABSENT timing.json
  // is a legitimately undecidable input, and readOptionalEngineJson reserves null for it.
  const timing = videoSecondsOverride !== null
    ? null
    : readOptionalEngineJson(projectDir, TIMING_NAME, 'timing');

  // Probing decodes media, so it is strict under --apply but must NOT be a precondition
  // of planning: a plan is supposed to be answerable about inputs that are absent,
  // stubbed or not yet rendered. Probing unconditionally made `remux-music` with no
  // flags exit non-zero on an undecodable stub, which breaks the plan-by-default
  // contract every other stage now honours.
  let musicSeconds = null;
  let videoSeconds = null;
  let undecidable = null;
  try {
    musicSeconds = await probeDurationSeconds(music);
    videoSeconds = resolveVideoSeconds(videoSecondsOverride, timing);
  } catch (err) {
    if (values.apply) throw err;
    undecidable = err.message;
  }

  // SHORT MUSIC IS LOOPED, NOT TRUNCATED (bug-ledger entry 15).
  // `amix duration=longest` describes how long the OUTPUT runs — it takes the longest
  // input. It does not loop or pad a short one, so a bed that ends early simply stops
  // contributing and the rest of the video plays with no bed at all. Nothing reports it.
  // Every earlier video was immune only because make-music.mjs generates the bed TO
  // LENGTH; the first file-sourced track hit this immediately, leaving 92 s bedless.
  const short = undecidable === null && musicSeconds < videoSeconds;

  if (short && values['no-loop'] === true) {
    throw new CliError(
      `music is ${musicSeconds.toFixed(2)}s but the video is ${videoSeconds.toFixed(2)}s — ` +
      `the last ${(videoSeconds - musicSeconds).toFixed(2)}s would have NO bed at all. ` +
      `Drop --no-loop to loop it with a crossfade, or supply a longer track.`);
  }
  if (short && musicSeconds <= xfade) {
    throw new CliError(
      `music (${musicSeconds.toFixed(2)}s) must be longer than the ${xfade}s crossfade to loop`);
  }

  // n copies crossfaded end-to-end yield n*D - (n-1)*X seconds. Smallest covering n.
  const copies = short ? Math.max(2, Math.ceil((videoSeconds - xfade) / (musicSeconds - xfade))) : 1;
  const trim = undecidable === null ? `atrim=0:${videoSeconds},` : '';

  let musicFilter;
  if (copies === 1) {
    musicFilter = `[2:a]${trim}asetpts=N/SR/TB,volume=${musicGain}[mu];`;
  } else {
    let prev = '2:a';
    musicFilter = '';
    for (let i = 1; i < copies; i += 1) {
      const label = `ml${i}`;
      musicFilter += `[${prev}][${i + 2}:a]acrossfade=d=${xfade}:c1=tri:c2=tri[${label}];`;
      prev = label;
    }
    musicFilter += `[${prev}]${trim}asetpts=N/SR/TB,volume=${musicGain}[mu];`;
  }

  const filter =
    `[1:a]volume=${voiceGain},pan=stereo|c0=c0|c1=c0[vo];` +
    musicFilter +
    `[vo][mu]amix=inputs=2:duration=longest:normalize=0[mx];` +
    `[mx]alimiter=limit=${ceilingLinear}:level=disabled[out]`;

  const musicInputs = Array.from({ length: copies }, () => ['-i', music]).flat();

  const FF = resolveFfmpeg(projectDir, values.ffmpeg);
  const ffArgs = [
    values.replace ? '-y' : '-n', '-hide_banner', '-loglevel', 'error',
    '-i', video, '-i', voice, ...musicInputs,
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
    console.log(`  gain    ${describeGainPinPlan(pin, current, confirmed)}`);
    if (undecidable !== null) {
      console.log(`  loop    UNDECIDED — could not read durations (${undecidable}).`);
      console.log('          Planned WITHOUT looping. If the track is shorter than the');
      console.log('          video, --apply will loop it and this plan understates the graph.');
    } else if (copies > 1) {
      console.log(`  loop    music ${musicSeconds.toFixed(2)}s < video ${videoSeconds.toFixed(2)}s ` +
        `— ${copies} copies, ${xfade}s crossfade at each wrap`);
    } else {
      console.log(`  loop    not needed — music ${musicSeconds.toFixed(2)}s covers video ${videoSeconds.toFixed(2)}s`);
    }
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

  // Pin only after the remux is proven good — pinning earlier would record a gain that
  // was never actually used — and only when an operator actually confirmed on this run.
  // Rewriting a settled pin would refresh `confirmedAt` for a confirmation that did not
  // happen, and would stamp `evidence: "operator-confirmed"` onto a legacy record that
  // never earned it.
  if (confirmed) {
    writeGainLock(projectDir, current);
    console.log(`${LOCK_NAME}: gain ${musicGain} confirmed for ${current.source} ` +
      `(${current.sha256.slice(0, 12)})`);
    console.log('   this records your acceptance, NOT a measurement — check the mix with:');
    console.log(`   node src/check-levels.mjs --file ${path.basename(outPath)}`);
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
