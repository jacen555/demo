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
import { MIX_PARAMETERS, createMixAudit } from './mix-parameters.mjs';
import { probeDurationSeconds } from './audio-probe.mjs';
import {
  SPEECH_RMS_THRESHOLD,
  REFERENCE_ATTACK_MS,
  REFERENCE_RELEASE_MS,
  fingerprintVoice,
  classifyEnvelopeLineage,
  describeEnvelopeRefusal,
  measureSpeech,
  calibrateDuckThreshold,
  achievedDuckDb,
  recoveryShortfallDb,
  timeToWithinDb,
} from './envelope-ducking.mjs';

/** The duck knobs, in the order they are declared. Absent together, present together. */
const DUCK_PARAMETERS = Object.freeze(['duckDb', 'duckRatio', 'duckAttack', 'duckRelease']);

/** How close to the gaps level the plan reports the bed getting, in dB. */
const GAPS_TOLERANCE_DB = 0.1;

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

/** The flags a confirmation covers — read off the registry, so a new pinned knob documents itself. */
const PINNED_FLAGS = MIX_PARAMETERS.filter((p) => p.pinned).map((p) => p.flag).join(', ');

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

  Sidechain ducking (file-sourced music). Without --duck-db the bed plays flat and the
  graph is byte-for-byte what it always was.
  --duck-db <dB>        how far the bed drops under narration, 0..40 (default: 0 = off).
                        Set --music-gain so the bed sits at your gaps level; --duck-db is
                        the DIFFERENCE down to your under-speech level. For
                        musicInGapsDb -30 and musicUnderSpeechDb -41 that is 11.
  --duck-envelope <f>   vo-envelope.json, REQUIRED with --duck-db. The sidechain threshold
                        is solved against the narration level measured in it, so it must
                        describe the narration actually in play — a stale envelope is
                        refused, not worked around.
  --duck-ratio <n>      sidechain compression ratio, 1.5..20 (default: 4). Lower narrows
                        how far the delivered depth strays from --duck-db on a syllable
                        louder or quieter than average.
  --duck-attack <ms>    1..2000 (default: ${REFERENCE_ATTACK_MS})
  --duck-release <ms>   1..9000 (default: ${REFERENCE_RELEASE_MS})

                        THE GAPS LEVEL IS APPROACHED, NOT REACHED — AND THE FIGURE IS
                        MODELLED, NOT MEASURED. A one-pole release closes on its target
                        asymptotically, so the model always puts the bed some distance
                        short when narration resumes: 0.66 dB at the defaults and a
                        1.83 s gap, under 0.10 dB after 3.3 s. Treat that as a
                        PESSIMISTIC UPPER BOUND. Measured on a real render,
                        sidechaincompress recovers FASTER than the one-pole model — a
                        predicted 0.66 dB shortfall delivered 0.05-0.11 dB at a 1.82 s
                        gap — so release is NOT the coefficient to tune by this number.
                        Lengthening it costs the knob its meaning fast: measured 2.0-3.5
                        dB short at 1500 ms and 6.1-8.7 dB at 2500 ms. The plan prints
                        the modelled figure for the release in force, against the gaps
                        measured in YOUR envelope. Only a decode of the ISOLATED bed
                        settles the real depth; the mixed file cannot, because speech
                        masks the bed it is ducking.
  --confirm-gain        confirm the pinned mix parameters (${PINNED_FLAGS}) for the current
                        music source (bug-ledger 16). Required on first use, whenever the
                        source or any pinned parameter changes, and once for every pin
                        written before those parameters were registered.
  --video-seconds <n>   override the video length used to size the loop
  --ceiling <dB>        limiter headroom in dB BELOW full scale, 0.1..12 (default: 1.0).
                        This is dBFS. A delivery target is usually dBTP, and true peak
                        sits ABOVE the sample peaks a limiter clamps. Measured on real
                        encoded output, post-AAC:
                            --ceiling 1.0  ->  -9.7 LUFS, -0.3 dBTP
                            --ceiling 2.0  -> -10.0 LUFS, -1.1 dBTP
                            --ceiling 3.0  -> -10.5 LUFS, -2.1 dBTP
                        So --ceiling 2.0 is a measured starting point for a -1.0 dBTP
                        target. It is NOT a guarantee: this tool clamps sample peaks
                        before the AAC encode and measures nothing after it, so verifying
                        a dBTP target means decoding the output and measuring it yourself.
  --project <dir>       project root; no path may escape it (default: current directory)
  --ffmpeg <path>       ffmpeg binary (default: read from ffmpeg-path.txt in the project)
  --apply               actually remux. Without it nothing is written.
  --replace             permit overwriting an existing --out
  --help                show this message

Exit codes: 0 success/plan · 1 ffmpeg failed, the video stream was NOT preserved, or a
value reached the mix graph without being registered · 2 bad usage
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
        'duck-db': { type: 'string' },
        'duck-envelope': { type: 'string' },
        'duck-ratio': { type: 'string' },
        'duck-attack': { type: 'string' },
        'duck-release': { type: 'string' },
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
  //
  // EVERY VALUE THAT REACHES THE MIX IS DECLARED, next to the parse that produces it.
  // The pin binds to the `pinned` subset of that declaration rather than to a literal
  // written here, and `mix.audit` refuses a graph carrying anything undeclared — so a
  // knob added later cannot move the delivered loudness behind a pin reporting valid,
  // which is exactly how --ceiling escaped. See mix-parameters.mjs, including its limits.
  const mix = createMixAudit();

  const voiceGain = parseBoundedNumber(values['voice-gain'] ?? '1.14', {
    name: '--voice-gain', min: GAIN_MIN, max: GAIN_MAX,
  });
  mix.declare('voiceGain', { value: voiceGain });

  const musicGain = parseBoundedNumber(values['music-gain'] ?? '1.50', {
    name: '--music-gain', min: GAIN_MIN, max: GAIN_MAX,
  });
  mix.declare('musicGain', { value: musicGain });

  // A LIMITER CEILING IS dBFS; A DELIVERY TARGET IS USUALLY dBTP. The two are not the
  // same number: inter-sample peaks reconstructed on playback run above the sample peaks
  // the limiter clamps. Measured on real encoded output, post-AAC, --ceiling 1.0 delivered
  // -0.3 dBTP and --ceiling 2.0 delivered -1.1 dBTP. Nothing in this pipeline measures
  // encoded true peak, so the help states 2.0 as a measured starting point and says
  // plainly that confirming a dBTP target requires decoding the output.
  //
  // Expressed as dB BELOW full scale (a positive number) rather than as a negative dBFS
  // value: gains reach an ffmpeg filter graph, so the shared parser refuses anything that
  // is not a plain decimal, and a leading dash is also ambiguous to parseArgs. "How much
  // headroom" is the more natural question anyway.
  //
  // PARSED HERE, BEFORE THE PIN, because the pin now covers it. Parsing it after the pin
  // check is what let a ceiling change reach the mix without a renewed confirmation.
  const ceilingBelowFs = parseBoundedNumber(values.ceiling ?? '1.0', {
    name: '--ceiling', min: 0.1, max: 12,
  });
  const ceilingLinear = Number(Math.pow(10, -ceilingBelowFs / 20).toFixed(6));
  // Pinned as the dB the operator typed, rendered as the linear limit the graph carries —
  // a refusal that quoted 0.794328 back at someone who typed 2.0 would be no use.
  mix.declare('ceiling', { value: ceilingBelowFs, rendered: ceilingLinear });

  // ---- THE SIDECHAIN DUCK ------------------------------------------------------------
  //
  // Before this, a file-sourced bed played FLAT: one gain served two knobs 11 dB apart,
  // so `musicInGapsDb` had no effect at all for any project using a licensed track.
  //
  // WHY IN-GRAPH, AND WHY NOT THE ALTERNATIVES.
  //  - A piecewise `volume` expression driven by the envelope measures out at ~3,042
  //    numeric literals in -filter_complex for a real envelope. The registry audit refuses
  //    undeclared numbers by design, so that shape and this guard cannot both exist.
  //  - Ducking the bed in PCM before the graph would mirror make-music exactly, and would
  //    put the duck parameters nowhere in -filter_complex — so audit rule 5 (a pinned
  //    value declared but never reaching the graph) would stop a CORRECT run. The fix for
  //    that would be an exemption in a guard one day old. Refused.
  // `sidechaincompress` keeps the graph footprint constant whatever the envelope says.
  //
  // DECLARED BEFORE THE PIN, because the pin covers all four. Parsing a pinned knob after
  // the pin check is exactly how --ceiling once reached the mix unconfirmed.
  const duckDb = parseBoundedNumber(values['duck-db'] ?? '0', { name: '--duck-db', min: 0, max: 40 });
  const ducking = duckDb > 0;

  let duck = null;
  if (!ducking) {
    // Recorded as NOT IN FORCE rather than omitted, so "ducking was off" is a fact the
    // pin carries and switching it on later reads as a changed pinned parameter.
    for (const name of DUCK_PARAMETERS) mix.declareAbsent(name);
  } else {
    if (values['duck-envelope'] === undefined) {
      throw new CliError(
        '--duck-db needs --duck-envelope <vo-envelope.json>.\n' +
        'The sidechain threshold is SOLVED against the narration level measured in the envelope, so\n' +
        'without one the depth would be whatever a guessed threshold happened to produce — which is\n' +
        'the behaviour this flag exists to replace. Produce one with:\n' +
        '  node src/vo-envelope.mjs --apply',
      );
    }

    const duckRatio = parseBoundedNumber(values['duck-ratio'] ?? '4', { name: '--duck-ratio', min: 1.5, max: 20 });
    const duckAttack = parseBoundedNumber(values['duck-attack'] ?? String(REFERENCE_ATTACK_MS), {
      name: '--duck-attack', min: 1, max: 2000,
    });
    const duckRelease = parseBoundedNumber(values['duck-release'] ?? String(REFERENCE_RELEASE_MS), {
      name: '--duck-release', min: 1, max: 9000,
    });

    const envelopePath = requireExistingFile(projectDir, values['duck-envelope'], 'duck envelope');
    const envelope = readDuckEnvelope(envelopePath);

    // THE ENVELOPE MUST DESCRIBE THE NARRATION BEING MIXED. It sets the level the
    // threshold is solved against, so a stale one mis-places every gain change by however
    // far the two have diverged and nothing downstream measures that.
    const voiceFingerprint = await fingerprintVoice(voice, path.basename(voice));
    const lineage = classifyEnvelopeLineage(envelope, voiceFingerprint);
    if (lineage.state !== 'current') {
      throw new CliError(
        describeEnvelopeRefusal(lineage, { envelopePath, voicePath: path.basename(voice) }),
        EXIT.FAILED,
      );
    }

    const speech = measureSpeech({ rms: envelope.rms, hopMs: Number(envelope.hopMs) || 20 });
    if (speech.speechRms === null) {
      throw new CliError(
        `${envelopePath} has no frame above the speech threshold (${SPEECH_RMS_THRESHOLD}), so there is no\n` +
        'narration level to solve the duck against. Ducking silence would reduce to a constant gain,\n' +
        'which --music-gain already is.',
        EXIT.FAILED,
      );
    }

    const threshold = calibrateDuckThreshold({
      speechRms: speech.speechRms, voiceGain, duckDb, ratio: duckRatio,
    });

    // Pinned as the dB the operator asked for, rendered as the threshold that delivers it
    // — the --ceiling shape. Pinning the solved threshold instead would demand a fresh
    // confirmation every time the narration was re-synthesised, and a confirmation that
    // fires constantly stops being one.
    mix.declare('duckDb', { value: duckDb, rendered: threshold });
    mix.declare('duckRatio', { value: duckRatio });
    mix.declare('duckAttack', { value: duckAttack });
    mix.declare('duckRelease', { value: duckRelease });

    duck = {
      db: duckDb, ratio: duckRatio, attack: duckAttack, release: duckRelease,
      threshold, speech,
      achievedDb: achievedDuckDb({ threshold, speechRms: speech.speechRms, voiceGain, ratio: duckRatio }),
      envelopePath,
    };
  }

  // THE GAIN PIN (bug-ledger entry 16).
  //
  // A gain is only meaningful for the track it was confirmed against: a generated bed at
  // -43.1 dB RMS and a licensed master at -11.4 dB are 31.7 dB apart and both accept the
  // same in-range gain, so bounding the VALUE cannot catch this. Nothing downstream can
  // either — the narration-gap checks measure whether a bed is PRESENT, not whether it is
  // at the right LEVEL.
  //
  // `mix.pinnedValues()` rather than a hand-written object: the set the pin records is
  // the set the registry declares, and it refuses to hand back a partial one.
  //
  // The gate is on WRITING, not on planning: the plan produces no artefact, so it reports
  // the pin status instead of refusing, and --apply is where an unconfirmed mix is
  // stopped. See gain-pin.mjs for what this pin does and does not certify.
  const lock = readGainLock(projectDir);
  const current = { source: path.basename(music), sha256: await sha256File(music), mix: mix.pinnedValues() };
  const pin = classifyGainPin(lock, current);
  const confirmed = values['confirm-gain'] === true;

  if (values.apply && pin.requiresConfirmation && !confirmed) {
    throw new CliError(describeGainPinRefusal(pin, current));
  }

  const xfade = parseBoundedNumber(values.crossfade ?? '3', {
    name: '--crossfade', min: 0.1, max: 30,
  });
  mix.declare('crossfade', { value: xfade });

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
  if (undecidable === null) mix.declare('videoSeconds', { value: videoSeconds });
  const trim = undecidable === null ? `atrim=0:${mix.use('videoSeconds')},` : '';

  let musicFilter;
  if (copies === 1) {
    musicFilter = `[2:a]${trim}asetpts=N/SR/TB,volume=${mix.use('musicGain')}[mu];`;
  } else {
    let prev = '2:a';
    musicFilter = '';
    for (let i = 1; i < copies; i += 1) {
      const label = `ml${i}`;
      musicFilter += `[${prev}][${i + 2}:a]acrossfade=d=${mix.use('crossfade')}:c1=tri:c2=tri[${label}];`;
      prev = label;
    }
    musicFilter += `[${prev}]${trim}asetpts=N/SR/TB,volume=${mix.use('musicGain')}[mu];`;
  }

  // The voice bus forks only when the duck needs a sidechain tap, so a run without
  // --duck-db produces the graph this stage has always produced, character for character.
  const voiceFilter = ducking
    ? `[1:a]volume=${mix.use('voiceGain')},pan=stereo|c0=c0|c1=c0,asplit=2[vo][vosc];`
    : `[1:a]volume=${mix.use('voiceGain')},pan=stereo|c0=c0|c1=c0[vo];`;

  // `apad` ON THE SIDECHAIN, and it is load-bearing. sidechaincompress ends its output
  // when EITHER input ends, so a narration track shorter than the trimmed bed would cut
  // the bed off at the last word — silently, for the whole tail. That is bug-ledger 15's
  // shape exactly. Padding the detector leg with silence makes the music the input that
  // decides the length, which is what the trim already sets. The mix leg is NOT padded,
  // so amix duration=longest is unaffected.
  const duckFilter = ducking
    ? `[vosc]apad[vop];` +
      `[mu][vop]sidechaincompress=threshold=${mix.use('duckDb')}:ratio=${mix.use('duckRatio')}` +
      `:attack=${mix.use('duckAttack')}:release=${mix.use('duckRelease')}[mud];`
    : '';

  const filter =
    voiceFilter +
    musicFilter +
    duckFilter +
    `[vo][${ducking ? 'mud' : 'mu'}]amix=inputs=2:duration=longest:normalize=0[mx];` +
    `[mx]alimiter=limit=${mix.use('ceiling')}:level=disabled[out]`;

  // FAIL CLOSED ON AN UNREGISTERED VALUE. Anything interpolated into the graph without
  // going through the registry leaves a number here that traces to nothing, and the run
  // stops rather than delivering a mix the pin has never covered. Audited on the plan
  // path too: a plan that prints a graph it cannot account for describes a mix nobody
  // confirmed, and printing that at exit 0 is the permissive default refused everywhere
  // else in this engine.
  mix.audit(filter);

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
    for (const line of describeDuckPlan(duck)) console.log(line);
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
    const recorded = Object.entries(current.mix)
      .map(([name, value]) => `${MIX_PARAMETERS.find((p) => p.name === name).flag} ${value}`)
      .join(', ');
    console.log(`${LOCK_NAME}: ${recorded} confirmed for ${current.source} ` +
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

/**
 * Reads the envelope the duck is calibrated from, validating the one field it depends on.
 *
 * An envelope whose `rms` is absent, empty or non-numeric produced NaN gains in the
 * synthesised path; here it would produce a NaN threshold interpolated into a filter
 * graph. Both are refused rather than rendered.
 */
function readDuckEnvelope(envelopePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(envelopePath, 'utf8'));
  } catch (err) {
    throw new CliError(`${envelopePath} could not be read as an envelope — ${err.message}`, EXIT.FAILED);
  }
  if (!Array.isArray(parsed?.rms) || parsed.rms.length === 0) {
    throw new CliError(
      `${envelopePath} must contain a non-empty "rms" array of envelope samples`, EXIT.FAILED,
    );
  }
  const bad = parsed.rms.findIndex((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0);
  if (bad !== -1) {
    throw new CliError(
      `${envelopePath} "rms"[${bad}] is ${JSON.stringify(parsed.rms[bad])} — every envelope sample must be a ` +
      'finite non-negative number', EXIT.FAILED,
    );
  }
  return parsed;
}

/**
 * The duck's plan lines.
 *
 * THE TOLERANCE IS PRINTED WHERE THE DECISION IS MADE. A one-pole release approaches the
 * gaps level and never arrives, so the honest figure is how far short the bed still is
 * when narration resumes — computed for the release ACTUALLY IN FORCE, against the gaps
 * measured in THIS project's envelope, not a constant from someone else's render.
 */
function describeDuckPlan(duck) {
  if (duck === null) return ['  duck    none (no --duck-db) — the bed plays flat, as it always has'];

  const { db, ratio, attack, release, threshold, speech, achievedDb, envelopePath } = duck;
  const speechDb = (20 * Math.log10(speech.speechRms)).toFixed(1);
  const lines = [
    `  duck    -${db} dB under narration, in-graph sidechaincompress`,
    `          envelope ${envelopePath} — CURRENT (${speech.speechFrames} speech frames, level ${speechDb} dBFS)`,
    `          threshold ${threshold} solved for that level; ratio ${ratio}, attack ${attack} ms, release ${release} ms`,
    `          solved depth ${achievedDb.toFixed(2)} dB at the AVERAGE speech level; a syllable N dB louder`,
    `          ducks N x ${(1 - 1 / ratio).toFixed(2)} dB deeper, so the depth is a centre, not a clamp`,
  ];

  if (speech.gaps.count === 0) {
    lines.push(
      '          NO GAP of 500 ms or more in this envelope — the bed never returns to the gaps',
      '          level anywhere in this video, so --music-gain alone does not describe it',
    );
    return lines;
  }

  const atMedian = recoveryShortfallDb({ duckDb: db, releaseMs: release, gapMs: speech.gaps.medianMs });
  const settle = timeToWithinDb({ duckDb: db, releaseMs: release, withinDb: GAPS_TOLERANCE_DB });
  lines.push(
    `          gaps level is APPROACHED, NOT REACHED — MODELLED, NOT MEASURED: across this`,
    `          envelope's median gap of ${(speech.gaps.medianMs / 1000).toFixed(2)}s (${speech.gaps.count} gaps >= 0.5s) the one-pole model puts the`,
    `          bed ${atMedian.toFixed(2)} dB under it when narration resumes, and within ${GAPS_TOLERANCE_DB} dB after ${(settle / 1000).toFixed(2)}s.`,
    '          Treat this as a PESSIMISTIC UPPER BOUND. Measured on a real render,',
    "          sidechaincompress recovers FASTER than the model: a predicted 0.67 dB",
    '          shortfall at a 1.82s gap delivered 0.05-0.11 dB. Only a decode of the',
    '          isolated bed settles it — the mixed file cannot, because speech masks',
    '          the bed it is ducking.',
  );
  return lines;
}
