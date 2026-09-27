/**
 * Deliberately silent segments — the one place that decides what silence IS.
 *
 * ## The distinction
 *
 * Every duration in this engine used to be PRODUCED by TTS: voice.mjs synthesised a clip,
 * measured it, and wrote that measurement into `endMs`, `audio.durationMs`, the
 * calibration, the concatenation and the drift gate. A segment with nothing to say
 * therefore had no clip, no measurement and no duration — and, critically, it looked
 * EXACTLY like a segment whose voice stage had not run yet. Both are "no `audio`".
 *
 * Those two states need opposite handling. A project that forgot to run the voice stage
 * must FAIL; an intermission must RENDER. Inferring either one from the same evidence
 * gets the other wrong, which is this engine's recurring defect — an in-band absence
 * colliding with a legitimate value.
 *
 * So silence is DECLARED, never inferred:
 *
 *   `segments[].silence` present  -> deliberately silent. An intro slide, a gap, an
 *                                    intermission. Its window is authored and honoured.
 *   `segments[].silence` absent   -> a narrated segment. `audio` absent still means the
 *                                    voice stage has not run, and still fails. Unchanged.
 *
 * ## Why there is no `silence.durationMs`
 *
 * The authored window `endMs - startMs` IS the duration, and it is the only one. A second
 * duration field would be a second source of truth for one number, free to drift from the
 * first — which is the same defect class in a new location. Stages that need the duration
 * of a silent segment ask `silentDurationMs()`, and there is nothing else to ask.
 *
 * ## What `audio` means on a silent segment
 *
 * After the voice stage runs, a silent segment has a REAL clip on disk — generated digital
 * silence of its authored length — so it carries `audio` like any other segment, with
 * `words: []`. An empty word list is a measurement that found nothing; an absent `audio`
 * is no measurement at all. Keeping that distinction is what lets "voice has not run"
 * stay a failure for silent and narrated segments alike.
 */
import crypto from 'node:crypto';
import { CliError } from './cli-support.mjs';

// MPEG-2 Layer III, 24 kHz, 96 kbps, mono — the msedge-tts profile this engine
// concatenates by raw bytes. Frame size 72 * 96000 / 24000 = 288 bytes; frame time
// 576 / 24000 = 24 ms. Defined once here and imported by silence-gen.mjs and
// concat-audio.mjs: two copies of the frame maths is a timeline corruption waiting to
// happen, because a disagreement would show up as drift rather than as an error.
export const SILENCE_FRAME_BYTES = 288;
export const SILENCE_FRAME_MS = (576 / 24000) * 1000; // 24

/** Frames needed to cover `targetMs`, and therefore the duration actually achievable. */
export function silentFrameCount(targetMs) {
  return Math.max(1, Math.round(targetMs / SILENCE_FRAME_MS));
}

/**
 * The real duration of the silence that would be generated for `targetMs`.
 *
 * Silence is frame-quantised: it lands on a multiple of 24 ms, up to 12 ms from the
 * request. Callers that reflow a timeline MUST write this value rather than the request,
 * so the timeline describes the audio that exists instead of the audio that was asked for.
 */
export function silentMp3DurationMs(targetMs) {
  return silentFrameCount(targetMs) * SILENCE_FRAME_MS;
}

/**
 * Frame-aligned digital silence. Side info and main_data are left zeroed, which every
 * compliant decoder renders as silence.
 */
export function silentMp3(targetMs) {
  const frames = silentFrameCount(targetMs);
  const buf = Buffer.alloc(SILENCE_FRAME_BYTES * frames);
  for (let i = 0; i < frames; i++) {
    const o = i * SILENCE_FRAME_BYTES;
    buf[o] = 0xff; buf[o + 1] = 0xf3; buf[o + 2] = 0xa4; buf[o + 3] = 0xc0;
  }
  return buf;
}

/**
 * Does this segment DECLARE itself silent?
 *
 * Keyed on the presence of the `silence` property, not on its contents. A declaration
 * that is present but malformed (`"silence": null`, `"silence": []`) is a silent segment
 * with a broken declaration — an error — not a narrated segment. Treating a malformed
 * declaration as "not silent" would reintroduce the very inference this exists to remove.
 */
export function isSilentSegment(seg) {
  return seg !== null && typeof seg === 'object' && Object.hasOwn(seg, 'silence');
}

/** The authored duration of a silent segment: its window, and nothing else. */
export function silentDurationMs(seg) {
  return Number(seg.endMs) - Number(seg.startMs);
}

/**
 * Everything wrong with a silent segment's declaration, as human-readable lines.
 *
 * Returns an array so a validator can report every problem in one pass rather than
 * stopping at the first. Empty means the declaration is well formed.
 */
export function silentSegmentProblems(seg, where = `segment "${seg?.id}"`) {
  const problems = [];
  const decl = seg.silence;
  if (decl === null || typeof decl !== 'object' || Array.isArray(decl)) {
    problems.push(`${where} declares \`silence\` as ${JSON.stringify(decl)} — it must be an object, e.g. {"caption": "[music]"}`);
    return problems;
  }

  // The accessibility cue is the ONLY thing a viewer reading captions gets from a silent
  // segment. There are no measured word boundaries to fall back on, so a blank cue is not
  // "no caption" — it is a caption that renders as an empty box. Refuse it.
  const caption = decl.caption;
  if (typeof caption !== 'string' || caption.trim() === '') {
    problems.push(
      `${where} is declared silent but its \`silence.caption\` is ${JSON.stringify(caption)} — ` +
      `a silent segment needs an authored accessibility cue (e.g. "[music]" or "[intermission]") ` +
      `because there are no measured word boundaries to caption from`);
  }

  // Narration plus a silence declaration is a contradiction with no safe resolution:
  // whichever one a stage honours, the other was a lie.
  const text = String(seg.voiceoverText ?? '');
  if (text.trim() !== '') {
    problems.push(
      `${where} is declared silent but carries narration text (${text.trim().length} chars) — ` +
      `a silent segment is never spoken, so remove the text or remove the \`silence\` declaration`);
  }

  const durationMs = silentDurationMs(seg);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    problems.push(
      `${where} is declared silent but its window is ${JSON.stringify(durationMs)}ms — ` +
      `a silent segment's duration is authored as endMs - startMs and must be positive`);
  }

  return problems;
}

/**
 * The validated accessibility cue for a silent segment.
 * @throws {CliError} when the declaration is malformed.
 */
export function silentCaption(seg) {
  const problems = silentSegmentProblems(seg);
  if (problems.length) throw new CliError(problems[0]);
  return seg.silence.caption.trim();
}

/** A segment's word count, counted the way voice.mjs and validate-timing count it. */
export function wordsInSegment(seg) {
  // `.filter(Boolean)` is load-bearing: `''.split(/\s+/)` is `['']`, so without it an
  // empty segment reports ONE word — a number that looks measured and is not.
  return String(seg?.voiceoverText ?? '').trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Builds `calibration-observed.json` from the measured clips.
 *
 * ## Silent segments are excluded from the RATE, kept in the RECORD
 *
 * A words-per-second figure over zero words is not a slow rate — it is not a rate. The
 * arithmetic says so loudly: `0 / 0` is NaN and `n / 0` is Infinity, and `JSON.stringify`
 * writes BOTH as `null`. validate-timing then requires that value finite and reports
 * "carries no aggregate.observedEffWps" — a true sentence about a cause that is not the
 * real one, pointing the author at a file they never edited. So silent segments
 * contribute to neither the per-segment rate nor the aggregate sums, and their entry
 * carries no `effWps` KEY AT ALL rather than a zero standing in for one.
 *
 * They do stay in `segments[]`, in position, because validate-timing's lineage check
 * compares the calibration to the timeline index by index. Dropping them would turn every
 * silent project into "the timeline has 3 segment(s) but the calibration measured 2" — a
 * lineage failure manufactured by the fix rather than found in the data.
 *
 * @param {object[]} segments  the timeline's segments, in order
 * @param {{durationMs: number, headMs: number, tailMs: number}[]} clips  measured, parallel to `segments`
 * @throws {CliError} when every segment is silent — see below.
 */
export function buildCalibration(segments, clips, { voiceId, roundedSpeed }) {
  const calSegs = segments.map((s, i) => {
    const clip = clips[i];
    const textHash = crypto.createHash('sha256').update(String(s.voiceoverText ?? ''), 'utf8').digest('hex');
    if (isSilentSegment(s)) {
      // No `effWps`, no speech. `silent: true` says WHY the rate is missing, so a reader
      // is never left to guess whether it was omitted or lost.
      return { id: s.id, words: 0, chars: 0, clipMs: clip.durationMs, speechMs: 0, silent: true, textHash };
    }
    const words = wordsInSegment(s);
    const speechMs = clip.durationMs - clip.headMs - clip.tailMs;
    return {
      id: s.id, words, chars: String(s.voiceoverText ?? '').length,
      clipMs: clip.durationMs, speechMs,
      effWps: +(words / (speechMs / 1000)).toFixed(3),
      textHash,
    };
  });

  const spoken = calSegs.filter((c) => !c.silent);
  if (spoken.length === 0) {
    // Writing the file anyway would put `"observedEffWps": null` on disk and make the NEXT
    // stage report the wrong failure. Naming the real situation here costs one run and
    // saves the author from debugging their calibration file.
    throw new CliError(
      'every segment is declared silent, so there is no speech to calibrate a word rate from — ' +
      'a project with no narration does not need the voice stage. Remove a `silence` declaration ' +
      'or skip this stage.');
  }

  const words = spoken.reduce((a, c) => a + c.words, 0);
  const speechMs = spoken.reduce((a, c) => a + c.speechMs, 0);
  const obsEff = words / (speechMs / 1000);
  return {
    voiceId,
    roundedSpeed,
    aggregate: {
      words,
      speechMs,
      observedEffWps: +obsEff.toFixed(3),
      observedSafeWps: +(obsEff / roundedSpeed).toFixed(3),
    },
    segments: calSegs,
  };
}
