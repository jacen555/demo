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
 *   d. a voice file swapped BETWEEN the check and the read. The window is narrowed by
 *      checking at the point of use, not closed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';

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

const BINDING_KEY = 'measuredFrom';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
export function duckGainTrajectory({ rms, hopMs, duckGain, attackMs, releaseMs, threshold }) {
  const attackCoefficient = Math.exp(-hopMs / attackMs);
  const releaseCoefficient = Math.exp(-hopMs / releaseMs);
  const gains = new Float64Array(rms.length);
  let current = 1;
  for (let k = 0; k < rms.length; k++) {
    const target = rms[k] > threshold ? duckGain : 1.0;
    const coefficient = target < current ? attackCoefficient : releaseCoefficient;
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

/** How long a gap must last before the bed is within `withinDb` of the gaps level. */
export function timeToWithinDb({ duckDb, releaseMs, withinDb }) {
  const duckGain = linearOf(-duckDb);
  const target = linearOf(-withinDb);
  return -releaseMs * Math.log((1 - target) / (1 - duckGain));
}

// --------------------------------------------------------------------------------------
// Calibration read off the envelope
// --------------------------------------------------------------------------------------

/**
 * Separates speech from silence in an envelope and measures both.
 *
 * `speechRms` is the energy-average level of the frames above threshold — the level the
 * sidechain detector is presented with while narration is running. It is `null`, never 0,
 * when no frame clears the threshold: an absent measurement reported as a level of zero
 * is a calibration built on a number nobody measured.
 */
export function measureSpeech({ rms, hopMs, threshold = SPEECH_RMS_THRESHOLD, minGapMs = MIN_REPORTABLE_GAP_MS }) {
  let sumOfSquares = 0;
  let speechFrames = 0;
  const gapLengths = [];
  let run = 0;

  for (let k = 0; k < rms.length; k++) {
    if (rms[k] > threshold) {
      speechFrames += 1;
      sumOfSquares += rms[k] * rms[k];
      if (run * hopMs >= minGapMs) gapLengths.push(run * hopMs);
      run = 0;
    } else {
      run += 1;
    }
  }
  if (run * hopMs >= minGapMs) gapLengths.push(run * hopMs);

  gapLengths.sort((a, b) => a - b);
  return {
    frames: rms.length,
    speechFrames,
    speechRms: speechFrames === 0 ? null : Math.sqrt(sumOfSquares / speechFrames),
    gaps: {
      count: gapLengths.length,
      medianMs: gapLengths.length === 0 ? null : gapLengths[Math.floor((gapLengths.length - 1) / 2)],
      longestMs: gapLengths.length === 0 ? null : gapLengths[gapLengths.length - 1],
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
 */
export function calibrateDuckThreshold({ speechRms, voiceGain, duckDb, ratio }) {
  const sidechainDb = dbOf(speechRms * voiceGain);
  const thresholdDb = sidechainDb - duckDb / (1 - 1 / ratio);
  const rounded = Number(linearOf(thresholdDb).toFixed(6));
  return Math.min(SIDECHAIN_THRESHOLD_MAX, Math.max(SIDECHAIN_THRESHOLD_MIN, rounded));
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
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const source = fs.createReadStream(voicePath);
  source.on('data', (chunk) => {
    bytes += chunk.length;
  });
  await pipeline(source, hash);
  return { file: displayName, bytes, sha256: hash.digest('hex') };
}

/** Builds the record written into the envelope. Kept beside the reader that checks it. */
export function envelopeBindingRecord(fingerprint) {
  return { file: fingerprint.file, bytes: fingerprint.bytes, sha256: fingerprint.sha256 };
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
    return { state: 'unreadable', recorded: null, actual: fingerprint, differences: [] };
  }

  const recorded = envelope[BINDING_KEY];
  if (recorded === undefined) {
    return { state: 'unbound', recorded: null, actual: fingerprint, differences: [] };
  }
  if (
    !isPlainObject(recorded) ||
    typeof recorded.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(recorded.sha256) ||
    !Number.isInteger(recorded.bytes) ||
    recorded.bytes < 0
  ) {
    return { state: 'unreadable', recorded, actual: fingerprint, differences: [] };
  }

  // `file` is RECORDED BUT NOT COMPARED. A caller may legitimately point a stage at the
  // same audio under another name, and refusing that would be a false stale. The content
  // is what the envelope was measured from, and the content is what is checked.
  const differences = [];
  if (recorded.bytes !== fingerprint.bytes) {
    differences.push({ field: 'bytes', recorded: recorded.bytes, actual: fingerprint.bytes });
  }
  if (recorded.sha256.toLowerCase() !== String(fingerprint.sha256).toLowerCase()) {
    differences.push({ field: 'sha256', recorded: recorded.sha256, actual: fingerprint.sha256 });
  }

  return { state: differences.length === 0 ? 'current' : 'stale', recorded, actual: fingerprint, differences };
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
  if (verdict.state === 'unbound') {
    return (
      `${envelopePath} records no input fingerprint, so nothing can confirm it describes ${voicePath}.\n` +
      'An envelope with no binding is NOT an envelope that matches — it predates the check, and\n' +
      'treating absence as permission is the defect this guard exists to remove.\n' +
      REMEASURE(voicePath)
    );
  }

  if (verdict.state === 'unreadable') {
    return (
      `${envelopePath} carries a "${BINDING_KEY}" that cannot be read as an input fingerprint.\n` +
      'A malformed binding is not an absent one and is not a matching one; it is refused on its own terms.\n' +
      REMEASURE(voicePath)
    );
  }

  const lines = verdict.differences.map(
    ({ field, recorded, actual }) =>
      `  ${field}\n    envelope records : ${String(recorded).slice(0, 64)}\n    ${voicePath} is  : ${String(actual).slice(0, 64)}`,
  );

  return (
    `${envelopePath} was measured from different audio than ${voicePath}:\n` +
    `${lines.join('\n')}\n` +
    'The envelope drives the duck, so calibrating against it would mis-place every gain change\n' +
    'by however far the two have diverged, and nothing downstream measures that.\n' +
    'This states only that the two differ — not what changed them, which is not knowable here.\n' +
    REMEASURE(voicePath)
  );
}

/** One-line status for a plan. */
export function describeEnvelopeState(verdict) {
  switch (verdict.state) {
    case 'current':
      return 'CURRENT — measured from the voice track on disk';
    case 'stale':
      return `STALE — measured from different audio (${verdict.differences.map((d) => d.field).join(', ')} differ)`;
    case 'unbound':
      return 'UNBOUND — records no input fingerprint, so it cannot be confirmed';
    default:
      return 'UNREADABLE — carries a binding that is not a binding';
  }
}
