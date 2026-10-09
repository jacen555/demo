/*
 * The envelope: what binds it to the audio it describes, and what is computed from it.
 *
 * ## Why the binding exists
 *
 * `vo-envelope.json` is the narration amplitude envelope. Two stages consume it —
 * `make-music` bakes a duck into the synthesised bed from it, and `remux-music`
 * calibrates an in-graph sidechain duck from it — and NEITHER could tell whether the file
 * described the narration actually in play. A measured instance:
 *
 *     envelope durationMs : 291984      hops present  : 14600
 *     timeline durationMs : 276528      hops expected : 13826
 *     drift               :  15456 ms
 *
 * 15.5 seconds stale, from a cut two rounds old, and the file parsed perfectly. A duck
 * calibrated against it drifts further out of alignment the longer the video runs, and
 * nothing anywhere reports it. This is a defect class this engine has shipped more than
 * once: a generated artefact with no guard tying it to the thing it describes.
 *
 * ## THE FINGERPRINT IS OVER THE INPUT
 *
 * The envelope records a fingerprint of the VOICE AUDIO it measured, not of itself.
 *
 * A fingerprint over the artefact would prove only that nobody edited the artefact after
 * it was written — self-consistency, not lineage. `cli-support.timingSeal` says exactly
 * that about itself, and the README records what it cost to learn. A fingerprint over the
 * input is also SEPARABLE from the artefact it certifies: restore the audio that produced
 * a shipped render and the envelope is valid again, so lineage and a bit-reproducible
 * deliverable are not in competition. Had `textHash` hashed audio rather than text, that
 * recovery would not exist.
 *
 * ## THREE STATES, NOT TWO
 *
 * `current`, `stale`, `unbound` and `unreadable` are kept apart deliberately.
 * **Absence is not permission.** An envelope written before this guard existed carries no
 * binding, and "no binding" must not be answered with "then it is fine" — that collapse
 * is the same permissive default the guard exists to remove. A binding that is present
 * but malformed is a third thing again: somebody put something there.
 *
 * ## WHAT A REFUSAL MAY SAY
 *
 * It names the FIELDS THAT DIFFER and the command to run. It does NOT say who changed
 * the file, or when, or which stage wrote it. Nothing here can know that — mtimes are not
 * provenance — and naming an unprovable cause is an error this codebase has already made
 * and had to withdraw a tool over.
 *
 * ## WHAT THIS DETECTS, AND WHAT IT DOES NOT
 *
 * DETECTS: an envelope whose recorded input fingerprint does not match the voice file a
 * consumer is about to mix; an envelope carrying no binding; a binding that cannot be
 * read.
 *
 * DOES NOT DETECT:
 *   a. an envelope measured from the right audio but with the RMS values themselves
 *      edited — the binding covers the INPUT, and says nothing about whether the
 *      measurement was performed correctly.
 *   b. a timeline re-cut that leaves the voice audio untouched. That is deliberate: the
 *      envelope describes the AUDIO, so unchanged audio means an unchanged envelope.
 *   c. which stage produced either file. Provenance is not available here (see above).
 *   d. a voice file swapped BETWEEN a consumer's check and its read. The window is
 *      narrowed by checking at the point of use, not closed. (vo-envelope itself has no
 *      such window: it fingerprints the very buffer it decodes.)
 *
 * ## A BED MAKE-MUSIC DUCKED CARRIES THE SAME DEPENDENCY
 *
 * A duck baked into a bed's samples is timed against one narration, and outlives the
 * envelope that timed it. The bed's ducking record (see the end of this file) binds the
 * bed to that narration the same way, so remux-music can refuse the mismatch.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import {
  CliError,
  EXIT,
  openExclusiveEngineFile,
  resolveInternalArtifact,
} from "./cli-support.mjs";

/** The RMS above which a 20 ms hop counts as speech. Mirrors the synthesised-bed duck. */
export const SPEECH_RMS_THRESHOLD = 0.004;

/**
 * The reference duck, as shipped in the synthesised bed.
 *
 * `remux-music` asks ffmpeg to do the ducking in-graph while `make-music` bakes it into
 * the samples, so the two could easily become two different ducks. They are described by
 * ONE model here, at these constants, which is what keeps them one behaviour.
 */
export const REFERENCE_ATTACK_MS = 150;
export const REFERENCE_RELEASE_MS = 800;
export const REFERENCE_DUCK_GAIN = 0.42; // ~= -7.5 dB, the synthesised bed's depth

/** ffmpeg's `sidechaincompress` accepts a threshold in [0.000976563, 1]. */
export const SIDECHAIN_THRESHOLD_MIN = 0.000977;
export const SIDECHAIN_THRESHOLD_MAX = 1;

/** A run of silence shorter than this is a word gap, not somewhere the bed can recover. */
export const MIN_REPORTABLE_GAP_MS = 500;

/** How far a delivered duck may miss the requested depth before the request is refused. */
export const DUCK_DEPTH_TOLERANCE_DB = 0.1;

const BINDING_KEY = "measuredFrom";

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const dbOf = (linear) => 20 * Math.log10(linear);
const linearOf = (db) => 10 ** (db / 20);

// --------------------------------------------------------------------------------------
// The gain trajectory — one model, both ducking paths
// --------------------------------------------------------------------------------------

/**
 * The one-pole ducking envelope: duck fast, recover gently, so it never pumps.
 *
 * This IS the loop `make-music` shipped, moved here rather than reimplemented, so the
 * synthesised path and the in-graph path cannot drift into two different ducks.
 *
 * Note there is NO HOLD and no hysteresis. A hold long enough to stop word-gap pumping
 * and a cap on how long the bed may stay up are the same mechanism at two timescales, and
 * the second one breaks silent segments — an intro slide or an intermission is sustained
 * silence, and the bed must ride up to the gaps level and STAY there. A one-pole release
 * does that for free; anything bounding the excursion takes it away. It is also the only
 * shape `sidechaincompress` can express, so adding one here would put the model and the
 * filter graph out of agreement.
 *
 * @returns {Float64Array} the linear multiplier for each envelope hop
 */
export function duckGainTrajectory({
  rms,
  hopMs,
  duckGain,
  attackMs,
  releaseMs,
  threshold,
}) {
  const attackCoefficient = Math.exp(-hopMs / attackMs);
  const releaseCoefficient = Math.exp(-hopMs / releaseMs);
  const gains = new Float64Array(rms.length);
  let current = 1;
  for (let k = 0; k < rms.length; k++) {
    const target = rms[k] > threshold ? duckGain : 1.0;
    const coefficient =
      target < current ? attackCoefficient : releaseCoefficient;
    current = target + (current - target) * coefficient;
    gains[k] = current;
  }
  return gains;
}

/**
 * How far BELOW the gaps level the bed still is after `gapMs` of silence.
 *
 * A one-pole release APPROACHES its target asymptotically and never arrives, so this is
 * never zero. That is the whole point of exposing it: the gaps level is a target the bed
 * gets close to, not a level it lands on, and a feature that exists to make
 * `musicInGapsDb` mean something must not quietly honour it only approximately.
 *
 * @returns {number} decibels short of the gaps level, always > 0
 */
export function recoveryShortfallDb({ duckDb, releaseMs, gapMs }) {
  const duckGain = linearOf(-duckDb);
  const gain = 1 - (1 - duckGain) * Math.exp(-gapMs / releaseMs);
  return -dbOf(gain);
}

/**
 * How long a gap must last before the bed is within `withinDb` of the gaps level.
 *
 * Zero, never negative, for a duck no deeper than the tolerance: that bed is within it
 * before the gap begins. The bare formula returned a negative duration there.
 */
export function timeToWithinDb({ duckDb, releaseMs, withinDb }) {
  const duckGain = linearOf(-duckDb);
  const target = linearOf(-withinDb);
  return Math.max(0, -releaseMs * Math.log((1 - target) / (1 - duckGain)));
}

// --------------------------------------------------------------------------------------
// Calibration read off the envelope
// --------------------------------------------------------------------------------------

/**
 * The hop an envelope was measured at, refusing anything that is not one.
 *
 * ONE RULE, BOTH DUCKING PATHS, the same way the trajectory is one model. The hop decides
 * where every dip lands: make-music multiplies it into the samples and remux-music turns
 * frame counts into the gap lengths its plan reports, so two copies of "what is a valid
 * hop" is two behaviours waiting to drift apart.
 *
 * `Number(hopMs) || 20` let a hand-edited -20 report NO GAP, let 1e9 report gaps of
 * eleven days, and quietly read 0, "20" and an ABSENT field as 20. Absence is not 20:
 * 20 is what vo-envelope writes, not what an envelope means when it says nothing.
 *
 * @param {unknown} envelope the parsed envelope
 * @param {string} envelopePath named in the refusal
 * @param {number} exitCode the caller's contract — a bad envelope is a usage error to
 *   make-music, which was handed it as `--envelope`, and a failed input to remux-music.
 * @returns {number} the hop, in milliseconds
 */
export function requireEnvelopeHopMs(
  envelope,
  envelopePath,
  exitCode = EXIT.USAGE,
) {
  const hopMs = envelope?.hopMs;
  if (
    typeof hopMs !== "number" ||
    !Number.isFinite(hopMs) ||
    hopMs < 1 ||
    hopMs > 1000
  ) {
    throw new CliError(
      `${envelopePath} "hopMs" is ${hopMs === undefined ? "absent" : JSON.stringify(hopMs).slice(0, 32)} — it must be ` +
        "a number of milliseconds from 1 to 1000 (vo-envelope writes 20). It is what places every dip the duck makes.",
      exitCode,
    );
  }
  return hopMs;
}

/**
 * Refuses an envelope whose `durationMs` and whose own frames describe different spans,
 * and one that does not state a span at all.
 *
 * The two halves say the same thing twice, so a disagreement means one of them is wrong
 * and nothing here can tell which: an envelope truncated to half its frames ducks the
 * start of the narration and leaves the rest of the bed flat, and a padded one holds the
 * duck past the last word. Both parsed, both ducked, both exited 0.
 *
 * ONE HOP OF SLACK, PLUS A MILLISECOND. vo-envelope measures in whole hops and rounds the
 * duration, so its last hop is partial and the two halves legitimately differ by up to a
 * hop. Anything beyond that is not rounding.
 */
export function assertEnvelopeSpansAgree(
  envelope,
  envelopePath,
  exitCode = EXIT.USAGE,
) {
  const { durationMs } = envelope;
  const hopMs = requireEnvelopeHopMs(envelope, envelopePath, exitCode);
  const spanMs = envelope.rms.length * hopMs;
  // ABSENCE IS NOT AGREEMENT. vo-envelope is the only writer and it always records the
  // duration, so an envelope without one did not come from it — and skipping the check
  // for exactly those envelopes exempted the hand-edited ones it exists to catch.
  if (
    typeof durationMs !== "number" ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    throw new CliError(
      `${envelopePath} "durationMs" is ${durationMs === undefined ? "absent" : JSON.stringify(durationMs).slice(0, 32)} — ` +
        "it must be a non-negative number of milliseconds (vo-envelope writes one for every envelope it measures). " +
        `Its ${envelope.rms.length} frames at ${hopMs} ms describe ${spanMs} ms, and nothing can check that against ` +
        "a span the envelope does not state.",
      exitCode,
    );
  }
  if (Math.abs(spanMs - durationMs) > hopMs + 1) {
    throw new CliError(
      `${envelopePath} contradicts itself: "durationMs" says ${durationMs} ms, but its ${envelope.rms.length} ` +
        `frames at ${hopMs} ms describe ${spanMs} ms. One of them is wrong and which cannot be told from here — ` +
        "an envelope short of its narration ducks the start and leaves the rest flat, and a padded one holds the " +
        "duck past the last word.\nRe-measure it: node src/vo-envelope.mjs --apply --replace",
      exitCode,
    );
  }
}

/**
 * Separates speech from silence in an envelope and measures both.
 *
 * `speechRms` is the energy-average level of the frames above threshold — the level the
 * sidechain detector is presented with while narration is running. It is `null`, never 0,
 * when no frame clears the threshold: an absent measurement reported as a level of zero
 * is a calibration built on a number nobody measured.
 *
 * `gaps` counts only silence BETWEEN two runs of speech — somewhere the bed recovers and
 * must be back down when the next phrase starts. Silence before the first word has no
 * duck to recover from and silence after the last has no phrase to be ready for, so
 * neither is a gap: counting them hid a project with no gaps at all behind its lead-in.
 */
export function measureSpeech({
  rms,
  hopMs,
  threshold = SPEECH_RMS_THRESHOLD,
  minGapMs = MIN_REPORTABLE_GAP_MS,
}) {
  let sumOfSquares = 0;
  let speechFrames = 0;
  const gapLengths = [];
  let run = 0;

  for (let k = 0; k < rms.length; k++) {
    if (rms[k] > threshold) {
      if (speechFrames > 0 && run * hopMs >= minGapMs)
        gapLengths.push(run * hopMs);
      speechFrames += 1;
      sumOfSquares += rms[k] * rms[k];
      run = 0;
    } else {
      run += 1;
    }
  }

  gapLengths.sort((a, b) => a - b);
  return {
    frames: rms.length,
    speechFrames,
    speechRms:
      speechFrames === 0 ? null : Math.sqrt(sumOfSquares / speechFrames),
    gaps: {
      count: gapLengths.length,
      medianMs:
        gapLengths.length === 0
          ? null
          : gapLengths[Math.floor((gapLengths.length - 1) / 2)],
      longestMs:
        gapLengths.length === 0 ? null : gapLengths[gapLengths.length - 1],
    },
  };
}

/**
 * Solves the `sidechaincompress` threshold that produces `duckDb` of gain reduction at
 * the MEASURED narration level.
 *
 * A compressor's depth is `(level - threshold) * (1 - 1/ratio)`, so a fixed threshold
 * produces whatever depth the narration happens to land on. Solving it the other way
 * round is what makes the requested depth the thing that is delivered rather than the
 * thing that was hoped for — and it is why the envelope must be current, since the level
 * it is solved against comes from there.
 *
 * LIMIT, and it is a real one: the solve lands the depth on the AVERAGE speech level.
 * Speech is not constant-level, so a syllable `d` dB above that average ducks
 * `d * (1 - 1/ratio)` dB deeper. A lower ratio narrows that spread; it is not zero at any
 * ratio, and only a gate would make it zero.
 *
 * A DEPTH THE THRESHOLD RANGE CANNOT DELIVER IS REFUSED (exit 2). ffmpeg takes a threshold
 * only in [SIDECHAIN_THRESHOLD_MIN, SIDECHAIN_THRESHOLD_MAX]. The solve used to be clamped
 * into that range in silence, so the bed ducked by whatever the clamp allowed — shallower
 * at the floor, deeper at full scale — while the pin recorded the depth asked for. The
 * clamp still keeps the value legal; a delivered depth more than DUCK_DEPTH_TOLERANCE_DB
 * from the request now stops the run and names the depth that is reachable.
 */
export function calibrateDuckThreshold({
  speechRms,
  voiceGain,
  duckDb,
  ratio,
}) {
  const sidechainDb = dbOf(speechRms * voiceGain);
  const thresholdDb = sidechainDb - duckDb / (1 - 1 / ratio);
  const rounded = Number(linearOf(thresholdDb).toFixed(6));
  const threshold = Math.min(
    SIDECHAIN_THRESHOLD_MAX,
    Math.max(SIDECHAIN_THRESHOLD_MIN, rounded),
  );

  const delivered = achievedDuckDb({
    threshold,
    speechRms,
    voiceGain,
    ratio,
  });
  if (Math.abs(delivered - duckDb) <= DUCK_DEPTH_TOLERANCE_DB) return threshold;

  const narration = `the narration reaches the sidechain at ${sidechainDb.toFixed(2)} dBFS`;
  if (delivered < duckDb) {
    // (1 - 1/ratio) < 1 at every ratio, so the floor caps the depth below this whatever the ratio.
    const ceiling = Math.max(0, sidechainDb - dbOf(SIDECHAIN_THRESHOLD_MIN));
    throw new CliError(
      `--duck-db ${duckDb} is unreachable at ratio ${ratio} for this narration: max ${delivered.toFixed(2)} dB. ` +
        `ffmpeg takes no sidechaincompress threshold below ${SIDECHAIN_THRESHOLD_MIN} and ${narration}, ` +
        `so no ratio ducks it past ${ceiling.toFixed(2)} dB. Delivering less than was asked, under a pin ` +
        `recording what was asked, is the defect this refuses. Raise --duck-ratio or lower --duck-db.`,
      EXIT.USAGE,
    );
  }
  throw new CliError(
    `--duck-db ${duckDb} is unreachable at ratio ${ratio} for this narration: min ${delivered.toFixed(2)} dB. ` +
      `ffmpeg takes no sidechaincompress threshold above ${SIDECHAIN_THRESHOLD_MAX} (full scale) and ${narration}, ` +
      `so the bed would duck DEEPER than asked. Lower --duck-ratio or raise --duck-db.`,
    EXIT.USAGE,
  );
}

/** The depth a solved threshold actually delivers at a given level — the solve, inverted. */
export function achievedDuckDb({ threshold, speechRms, voiceGain, ratio }) {
  const over = dbOf(speechRms * voiceGain) - dbOf(threshold);
  return Math.max(0, over * (1 - 1 / ratio));
}

// --------------------------------------------------------------------------------------
// The binding
// --------------------------------------------------------------------------------------

/**
 * Fingerprints the voice audio an envelope is (or will be) measured from.
 *
 * Streamed rather than read whole: this runs on plan paths, and a synchronous whole-file
 * read of a narration track blocks the event loop for as long as the disk takes.
 */
export async function fingerprintVoice(voicePath, displayName) {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const source = fs.createReadStream(voicePath);
  source.on("data", (chunk) => {
    bytes += chunk.length;
  });
  await pipeline(source, hash);
  return { file: displayName, bytes, sha256: hash.digest("hex") };
}

/** Builds the record written into the envelope. Kept beside the reader that checks it. */
export function envelopeBindingRecord(fingerprint) {
  return {
    file: fingerprint.file,
    bytes: fingerprint.bytes,
    sha256: fingerprint.sha256,
  };
}

/**
 * Decides whether an envelope describes the voice audio now on disk.
 *
 * Returns one of four states, kept apart on purpose:
 *   `current`    — the recorded input fingerprint matches.
 *   `stale`      — it is present, readable, and does not match. `differences` names why.
 *   `unbound`    — the envelope carries no binding at all. NOT the same as matching.
 *   `unreadable` — a binding is present but is not a binding.
 */
export function classifyEnvelopeLineage(envelope, fingerprint) {
  if (!isPlainObject(envelope)) {
    return {
      state: "unreadable",
      recorded: null,
      actual: fingerprint,
      differences: [],
    };
  }

  const recorded = envelope[BINDING_KEY];
  if (recorded === undefined) {
    return {
      state: "unbound",
      recorded: null,
      actual: fingerprint,
      differences: [],
    };
  }
  if (
    !isPlainObject(recorded) ||
    typeof recorded.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(recorded.sha256) ||
    !Number.isInteger(recorded.bytes) ||
    recorded.bytes < 0
  ) {
    return {
      state: "unreadable",
      recorded,
      actual: fingerprint,
      differences: [],
    };
  }

  // `file` is RECORDED BUT NOT COMPARED. A caller may legitimately point a stage at the
  // same audio under another name, and refusing that would be a false stale. The content
  // is what the envelope was measured from, and the content is what is checked.
  const differences = [];
  if (recorded.bytes !== fingerprint.bytes) {
    differences.push({
      field: "bytes",
      recorded: recorded.bytes,
      actual: fingerprint.bytes,
    });
  }
  if (
    recorded.sha256.toLowerCase() !== String(fingerprint.sha256).toLowerCase()
  ) {
    differences.push({
      field: "sha256",
      recorded: recorded.sha256,
      actual: fingerprint.sha256,
    });
  }

  return {
    state: differences.length === 0 ? "current" : "stale",
    recorded,
    actual: fingerprint,
    differences,
  };
}

const REMEASURE = (voicePath) =>
  `Re-measure it:\n  node src/vo-envelope.mjs --voice ${voicePath} --apply --replace`;

/**
 * The refusal text for a non-current envelope.
 *
 * Each state gets its own wording because each is a different situation for the operator.
 * None of them names a cause: this code cannot know who changed either file or when, and
 * a guard that invents a cause is worse than one that reports a difference.
 */
export function describeEnvelopeRefusal(verdict, { envelopePath, voicePath }) {
  if (verdict.state === "unbound") {
    return (
      `${envelopePath} records no input fingerprint, so nothing can confirm it describes ${voicePath}.\n` +
      "An envelope with no binding is NOT an envelope that matches — it predates the check, and\n" +
      "treating absence as permission is the defect this guard exists to remove.\n" +
      REMEASURE(voicePath)
    );
  }

  if (verdict.state === "unreadable") {
    return (
      `${envelopePath} carries a "${BINDING_KEY}" that cannot be read as an input fingerprint.\n` +
      "A malformed binding is not an absent one and is not a matching one; it is refused on its own terms.\n" +
      REMEASURE(voicePath)
    );
  }

  const lines = verdict.differences.map(
    ({ field, recorded, actual }) =>
      `  ${field}\n    envelope records : ${String(recorded).slice(0, 64)}\n    ${voicePath} is  : ${String(actual).slice(0, 64)}`,
  );

  return (
    `${envelopePath} was measured from different audio than ${voicePath}:\n` +
    `${lines.join("\n")}\n` +
    "The envelope drives the duck, so calibrating against it would mis-place every gain change\n" +
    "by however far the two have diverged, and nothing downstream measures that.\n" +
    "This states only that the two differ — not what changed them, which is not knowable here.\n" +
    REMEASURE(voicePath)
  );
}

/** One-line status for a plan. */
export function describeEnvelopeState(verdict) {
  switch (verdict.state) {
    case "current":
      return "CURRENT — measured from the voice track on disk";
    case "stale":
      return `STALE — measured from different audio (${verdict.differences.map((d) => d.field).join(", ")} differ)`;
    case "unbound":
      return "UNBOUND — records no input fingerprint, so it cannot be confirmed";
    default:
      return "UNREADABLE — carries a binding that is not a binding";
  }
}

// ---------------------------------------------------------------------------------------------
// THE BED'S DUCKING RECORD — a duck make-music bakes in stays bound to its narration
// ---------------------------------------------------------------------------------------------

/**
 * The file make-music writes beside every bed it synthesises: `<bed>.duck.json`.
 *
 * A duck baked into a bed is timed against ONE narration, and it outlives the envelope
 * that timed it. Once make-music exits nothing in the samples says which narration that
 * was, so a project re-voiced or reflowed afterwards shipped every dip in the wrong place
 * — behind a gain pin that covers the bed's bytes and the mix, and so was still valid.
 *
 * A FLAT BED GETS A RECORD TOO. Otherwise "no record" would mean both "make-music did not
 * duck this" and "nothing ever recorded anything" — a licensed track, or a bed make-music
 * ducked before records existed. The audio cannot tell those apart, so absence is
 * reported as exactly what it is: unknown.
 */
export const BED_DUCK_RECORD_SUFFIX = ".duck.json";

/** The record make-music writes. `voiceFingerprint` is null for a bed it did not duck. */
export function bedDuckRecord(bedFingerprint, voiceFingerprint) {
  const bed = envelopeBindingRecord(bedFingerprint);
  return voiceFingerprint
    ? {
        bed,
        ducked: true,
        duckedAgainst: envelopeBindingRecord(voiceFingerprint),
      }
    : { bed, ducked: false };
}

/**
 * Publishes the ducking record at `recordPath`, the name make-music's up-front check
 * resolved minutes earlier, before synthesis.
 *
 * The body goes into a temp file beside it, under a name no one can guess in advance, and
 * the descriptor that created that file stays open to the end, so every later step can
 * check that a name still holds that very file (openedAtVerdict).
 *
 * WITHOUT --replace, THE PUBLISH IS THE NO-CLOBBER GUARD. The up-front check only makes a
 * refusal cheap. The record is published as a hard link to the temp file, and making a
 * link fails if anything at all is at the name — a file, a directory, a link, even one to
 * nothing — without following or changing it; that entry is refused and left exactly as
 * it is. The record's name is never opened, so an open that follows a dangling link can
 * never create a file where it points, and it is never removed by name: an entry that took
 * it after the link was made is reported and left as it is. A volume that cannot make a
 * hard link (FAT, exFAT) publishes nothing, and says so.
 *
 * WITH --replace it is renamed over the name, remux-music's gain-lock pattern. A link at
 * the name is still refused.
 *
 * The temp name is removed only while it still holds this run's file. One that cannot be
 * removed once the record is published does not fail the publish: it is returned as a
 * warning, for the caller to print. A descriptor that cannot be closed then does fail it
 * (exit 1): the close can be what reports a failed write, so the bytes cannot be confirmed.
 * The record is left at its name — once the descriptor is gone nothing can show the entry
 * is this run's file, so it is never removed by name — and the error says how to clear it.
 *
 * @returns {{path: string, warnings: string[]}} the path published, and what was left behind
 */
export function publishBedDuckRecord(
  root,
  recordPath,
  record,
  { replace = false } = {},
) {
  const body = `${JSON.stringify(record, null, 2)}\n`;

  let target;
  try {
    target = resolveInternalArtifact(
      root,
      recordPath,
      "ducking record",
      "write",
    );
  } catch (err) {
    // Without --replace, a link at the name is simply an entry that appeared.
    if (!replace && entryExists(recordPath))
      throw appearedAfterTheCheck(root, recordPath);
    throw err;
  }
  if (!replace && entryExists(target))
    throw appearedAfterTheCheck(root, target);

  let temp;
  try {
    temp = openExclusiveEngineFile(
      root,
      `${target}.part-${process.pid}-${crypto.randomBytes(8).toString("hex")}`,
      "ducking record temp file",
    );
  } catch (err) {
    throw new CliError(
      `could not publish the ducking record ${target}, and nothing was written at that name: ${err.message}`,
      EXIT.FAILED,
    );
  }
  requireOpenedAt(temp, "ducking record temp file");

  try {
    fs.writeFileSync(temp.fd, body);
  } catch (err) {
    throw notPublished(
      `could not write the ducking record ${target} (${err.code ?? err.message})`,
      withCloseNote(retireTemp(temp)),
    );
  }

  try {
    if (replace) fs.renameSync(temp.path, target);
    else fs.linkSync(temp.path, target);
  } catch (err) {
    const notes = withCloseNote(retireTemp(temp));
    // The authoritative no-clobber guard: the link cannot be made over any entry at all.
    if (!replace && err.code === "EEXIST")
      throw appearedAfterTheCheck(root, target, notes);
    throw notPublished(
      `could not publish the ducking record ${target} (${err.code ?? err.message})`,
      notes,
      {
        viaLink: !replace,
      },
    );
  }

  // Verify, then retire the temp name, then close: every check needs the descriptor open.
  const verdict = openedAtVerdict(temp.fd, target);
  const retired = retireTemp(temp, { published: verdict === "same" });
  if (verdict !== "same")
    throw notTheRecordThisRunWrote(target, verdict, withCloseNote(retired));
  if (retired.closeFailure) throw notClosed(root, target, retired);
  return { path: target, warnings: retired.notes };
}

function appearedAfterTheCheck(root, recordPath, notes = []) {
  return new CliError(
    `ducking record ${recordPath} appeared after the up-front check found the name free — refusing to ` +
      `replace it without --replace. It has been left exactly as it is. ${howToClear(root, recordPath)}` +
      asSentences(notes),
  );
}

/**
 * The way out of an "appeared after" refusal. --replace is advised only where it would
 * work: over a regular file, at a name that passes the link check a --replace run meets.
 * --replace refuses a link at the name, refuses a directory up front, and cannot rename
 * over one that appears mid-run, so for those the way out is to move the entry aside.
 * Nothing is claimed of anything else: a rename does replace, say, a FIFO. What is at the
 * name is read by lstat, never through a link. When lstat finds nothing at the name there
 * is nothing to move aside, and the way out is to re-run without --replace; when lstat
 * itself fails, the entry is not known to be anything, so it is to be moved aside. The
 * same way out is given for a record left at its name because its file could not be closed.
 */
function howToClear(root, recordPath) {
  let entry;
  try {
    entry = fs.lstatSync(recordPath, { throwIfNoEntry: false });
    if (entry === undefined)
      return "Nothing is at that name now, so re-run without --replace.";
  } catch {
    entry = undefined;
  }
  if (entry?.isSymbolicLink())
    return "Move it aside: it is a link, and --replace does not overwrite a link.";
  if (entry?.isDirectory())
    return "Move it aside: it is a directory, and --replace does not overwrite a directory.";
  if (entry?.isFile()) {
    try {
      resolveInternalArtifact(root, recordPath, "ducking record", "write");
      return "Move it aside, or re-run with --replace to overwrite it.";
    } catch {
      // The link check refused this path, and a --replace run meets the same check.
    }
  }
  return (
    "Move it aside: it could not be confirmed to be a regular file that --replace would overwrite, so " +
    "--replace is not advised."
  );
}

function notPublished(what, notes, { viaLink = false } = {}) {
  return new CliError(
    `${what} — nothing was written at that name.` +
      (viaLink
        ? " Without --replace the record is published as a hard link, which some volumes (FAT, exFAT) cannot " +
          "make; --replace publishes it by rename instead, and overwrites an existing bed and a ducking record " +
          "that is a regular file."
        : "") +
      asSentences(notes),
    EXIT.FAILED,
  );
}

function notTheRecordThisRunWrote(target, verdict, notes) {
  const state = {
    absent: "was removed as it was published: nothing is at that name now",
    different:
      "is not the record this run wrote: another entry took its place as it was published. That entry has " +
      "been left as it is",
    unavailable:
      "cannot be confirmed as the record this run wrote: this filesystem gives no file identity to check. " +
      "The entry at that name has been left as it is",
    unchecked:
      "cannot be confirmed as the record this run wrote: it could not be examined. The entry at that name " +
      "has been left as it is",
  }[verdict];
  return new CliError(
    `the ducking record ${target} ${state}.${asSentences(notes)}`,
    EXIT.FAILED,
  );
}

/**
 * The record IS published: its name held this run's file when it was checked, before the
 * close. But close(2) can report an error from an earlier write, so the bytes cannot be
 * confirmed. Once the descriptor is gone nothing can show the entry is this run's file, so
 * it is never removed by name: it is left there, with the way out for what is there now.
 */
function notClosed(root, target, { notes, closeFailure }) {
  return new CliError(
    `the ducking record was published at ${target} and has been left there, but the file it was written ` +
      `through could not be closed (${closeFailure.code ?? closeFailure.message}), so what was written to it ` +
      `cannot be confirmed. ${howToClear(root, target)}` +
      asSentences(notes),
    EXIT.FAILED,
  );
}

const asSentences = (notes) =>
  notes.map((note) => ` ${note[0].toUpperCase()}${note.slice(1)}.`).join("");

/**
 * Removes the temp file's name — only while it still holds the file open as `temp.fd` —
 * then closes the descriptor. Never throws, and never removes anything it cannot show is
 * this run's: what it had to leave comes back as notes. A failed close comes back apart,
 * as `closeFailure`, for the caller to weigh: beside an error already being raised it is
 * one more note (withCloseNote), but it fails a publish that otherwise succeeded.
 */
function retireTemp(temp, { published = false } = {}) {
  const notes = [];
  const verdict = openedAtVerdict(temp.fd, temp.path);
  if (verdict === "same") {
    try {
      fs.unlinkSync(temp.path);
    } catch (err) {
      notes.push(
        published
          ? `the ducking record is published, but its temp name ${temp.path} could not be removed ` +
              `(${err.code ?? err.message}): it is a second name for the same record, and can be deleted`
          : `the temp file ${temp.path} could not be removed (${err.code ?? err.message}) — delete it by hand`,
      );
    }
  } else if (verdict !== "absent") {
    notes.push(
      verdict === "different"
        ? `the temp name ${temp.path} no longer holds the file this run wrote, so it has been left as it is`
        : `the temp name ${temp.path} cannot be confirmed as this run's, so it has been left as it is`,
    );
  }
  let closeFailure;
  try {
    fs.closeSync(temp.fd);
  } catch (err) {
    closeFailure = err;
  }
  return { notes, closeFailure };
}

/** retireTemp's result as the notes for an error already being raised. */
function withCloseNote({ notes, closeFailure }) {
  return closeFailure
    ? [
        ...notes,
        `the temp file's descriptor could not be closed (${closeFailure.code ?? closeFailure.message})`,
      ]
    : notes;
}

/**
 * Whether the entry at `name` is provably the regular file open as `fd`: false for a
 * link — even one to that very file — for anything that took the file's place after it
 * was opened, and wherever the filesystem gives no file identity to compare. Two
 * different files that both report inode 0 must not pass as one.
 *
 * The publish asks it of the temp file before writing to it, of the record's name once it
 * is published, and of the temp name before removing it.
 */
/**
 * Whether the file open as `fd` is the one at `name`. See openedAtVerdict for the states
 * this collapses; a caller that must report WHY should ask for the verdict instead.
 */
export function isOpenedAt(fd, name) {
  return openedAtVerdict(fd, name) === "same";
}

/**
 * The verdict itself, for a caller that reports what it found rather than only whether it
 * matched. 'same' | 'absent' | 'different' | 'unavailable' | 'unchecked'.
 *
 * Collapsing these to a boolean and then naming one of them in the message states a cause
 * that was never established: "another entry took its place" and "this volume gives no
 * file identity" are different facts, and only one of them is about a substitution.
 */
export function openedAtState(fd, name) {
  return openedAtVerdict(fd, name);
}

/**
 * The entry at `name`, measured against the file open as `fd`: 'same', 'absent',
 * 'different' (a link, a directory, another file), 'unavailable' (either side reports
 * inode 0, so there is no identity to compare) or 'unchecked' (a stat failed). Never throws.
 */
function openedAtVerdict(fd, name) {
  let opened;
  let entry;
  try {
    opened = fs.fstatSync(fd, { bigint: true });
    entry = fs.lstatSync(name, { bigint: true, throwIfNoEntry: false });
  } catch {
    return "unchecked";
  }
  if (entry === undefined) return "absent";
  if (!entry.isFile() || !opened.isFile()) return "different";
  if (entry.ino === 0n || opened.ino === 0n) return "unavailable";
  if (entry.ino !== opened.ino) return "different";
  // Windows reports dev 0 for a stat by path and the volume serial for one by descriptor,
  // so the volume is compared only where both report one.
  return entry.dev === 0n || opened.dev === 0n || entry.dev === opened.dev
    ? "same"
    : "different";
}

/** Refuses a just-created handle whose name cannot be shown to hold its file. Never deletes by name. */
function requireOpenedAt(handle, label) {
  const verdict = openedAtVerdict(handle.fd, handle.path);
  if (verdict === "same") return;
  // Not handle.cleanup(): it removes by NAME, and the entry at the name is not provably this file.
  try {
    fs.closeSync(handle.fd);
  } catch {}
  if (verdict !== "different") {
    const why = {
      absent: "it was removed as it was created",
      unavailable: "this filesystem gives no file identity to check",
      unchecked: "it could not be examined",
    }[verdict];
    throw new CliError(
      `${label} ${handle.path} cannot be confirmed as the file this run just created: ${why}. Nothing was ` +
        "written to it, and whatever is at that name has been left as it is.",
      EXIT.FAILED,
    );
  }
  throw new CliError(
    `${label} ${handle.path} is not the file this run just created there — a link or another entry took its ` +
      "place as it was created. Nothing was written to it and it has been left as it is; if it is a link, an " +
      "empty file may now exist where it points.",
  );
}

function entryExists(candidate) {
  try {
    return fs.lstatSync(candidate, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return false;
  }
}

/** A fingerprint as the record writes one: a name, a byte count and a SHA-256. */
function isFingerprint(value) {
  return (
    isPlainObject(value) &&
    typeof value.file === "string" &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/i.test(value.sha256) &&
    Number.isInteger(value.bytes) &&
    value.bytes >= 0
  );
}

/**
 * Decides what a bed's ducking record says about the bed and the narration on disk.
 *
 *   `absent`    — no record. NOT "not ducked" (see BED_DUCK_RECORD_SUFFIX).
 *   `flat`      — make-music recorded that it did not duck this bed.
 *   `current`   — ducked against the narration on disk.
 *   `stale`     — ducked against different narration. `differences` names the fields.
 *   `other-bed` — the record fingerprints other bytes than the bed beside it.
 *   `malformed` — not a record make-music wrote. `reason` says what is wrong with it.
 *
 * `voiceFingerprint` is a function, called only for a ducked bed: fingerprinting the
 * narration reads every byte of it, and no other state needs one.
 */
export async function classifyBedDuckRecord(
  record,
  bedFingerprint,
  voiceFingerprint,
) {
  if (record === undefined) return { state: "absent" };
  if (!isPlainObject(record))
    return { state: "malformed", reason: "it is not a JSON object" };
  if (!isFingerprint(record.bed)) {
    return {
      state: "malformed",
      reason: '"bed" is not a fingerprint (file, bytes, sha256)',
    };
  }
  if (typeof record.ducked !== "boolean")
    return { state: "malformed", reason: '"ducked" is not true or false' };
  if (record.ducked && !isFingerprint(record.duckedAgainst)) {
    return {
      state: "malformed",
      reason: '"ducked" is true but "duckedAgainst" is not a fingerprint',
    };
  }
  if (!record.ducked && record.duckedAgainst !== undefined) {
    return {
      state: "malformed",
      reason: '"ducked" is false but it names narration it was ducked against',
    };
  }

  // The same comparison an envelope's binding gets: content, not name.
  const bed = classifyEnvelopeLineage(
    { [BINDING_KEY]: record.bed },
    bedFingerprint,
  );
  if (bed.state !== "current")
    return { state: "other-bed", differences: bed.differences };
  if (!record.ducked) return { state: "flat" };

  const voice = classifyEnvelopeLineage(
    { [BINDING_KEY]: record.duckedAgainst },
    await voiceFingerprint(),
  );
  return { state: voice.state, differences: voice.differences };
}

const fieldLines = (differences, recordedAs, actualAs) =>
  differences.map(
    ({ field, recorded, actual }) =>
      `  ${field}\n    ${recordedAs} : ${String(recorded).slice(0, 64)}\n    ${actualAs} : ${String(actual).slice(0, 64)}`,
  );

/**
 * The refusal text for a ducking record that does not clear the bed. Like the envelope's,
 * it reports what differs and never guesses at what changed it.
 */
export function describeBedDuckRefusal(
  verdict,
  { recordPath, bedName, voiceName },
) {
  const redo =
    "Re-duck the bed against the narration in play, with the --seconds and --preset it was made with:\n" +
    `  node src/vo-envelope.mjs --voice ${voiceName} --apply --replace\n` +
    `  node src/make-music.mjs --out ${bedName} --voice ${voiceName} --envelope vo-envelope.json --apply --replace`;

  if (verdict.state === "stale") {
    return (
      `${recordPath} says make-music ducked ${bedName} against different narration than ${voiceName}:\n` +
      `${fieldLines(verdict.differences, "ducked against", `${voiceName} is`).join("\n")}\n` +
      "That duck is baked into the bed's samples, timed to where the other narration spoke, so it\n" +
      "dips in the wrong places under this one. The gain pin cannot see it — it covers the bed and the\n" +
      "mix, not the narration — and --duck-db cannot fix it: an in-graph duck lands on top of the baked one.\n" +
      "This states only that the two differ, not what changed them, which is not knowable here.\n" +
      redo
    );
  }
  if (verdict.state === "other-bed") {
    return (
      `${recordPath} describes a different bed than ${bedName}:\n` +
      `${fieldLines(verdict.differences, "record describes", `${bedName} is`).join("\n")}\n` +
      "It was written for other bytes, so it says nothing about this bed — including whether it is ducked.\n" +
      "Re-run make-music to write the bed and its record together, or, if this bed did not come from\n" +
      "make-music, remove the leftover record."
    );
  }
  return (
    `${recordPath} is not a ducking record make-music wrote: ${verdict.reason}.\n` +
    "An unreadable record is not an absent one and not a flat one, and it is not guessed at.\n" +
    "Re-run make-music to write the bed and its record together, or remove the file if it does not\n" +
    "belong to this bed."
  );
}
