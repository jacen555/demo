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
 * `words: []`. remix.mjs regenerates that clip from the CURRENT window, so a silence edit
 * never needs the voice stage again. An empty word list is a measurement that found
 * nothing; an absent `audio` is no measurement at all. Keeping that distinction is what
 * lets "voice has not run" stay a failure for silent and narrated segments alike.
 */

import fs from "node:fs";
import path from "node:path";
import {
  CliError,
  EXIT,
  assertDistinctDestinations,
  createBoundary,
  narrationFingerprint,
  pathExists,
  resolveEngineOutput,
  resolveWithinRoot,
} from "./cli-support.mjs";

// MPEG-2 Layer III, 24 kHz, 96 kbps, mono — the msedge-tts profile this engine
// concatenates by raw bytes. Frame size 72 * 96000 / 24000 = 288 bytes; frame time
// 576 / 24000 = 24 ms. Defined once here and imported by silence-gen.mjs, voice.mjs,
// remix.mjs and concat-audio.mjs: two copies of the frame maths is a timeline corruption
// waiting to happen, because a disagreement would show up as drift rather than as an error.
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
 *
 * @throws {RangeError} before allocating anything, for a target that is not a number above 0
 *   and at most SILENCE_MAX_MS. Each caller checks its target first, so this is the backstop
 *   for one that does not: the allocation is as large as the target asks.
 */
export function silentMp3(targetMs) {
  if (
    typeof targetMs !== "number" ||
    !(targetMs > 0) ||
    targetMs > SILENCE_MAX_MS
  ) {
    throw new RangeError(
      `silentMp3: the target is ${shownKind(targetMs)} — generated silence must be a number of ` +
        `milliseconds above 0 and at most ${SILENCE_MAX_MS}`,
    );
  }
  const frames = silentFrameCount(targetMs);
  const buf = Buffer.alloc(SILENCE_FRAME_BYTES * frames);
  for (let i = 0; i < frames; i++) {
    const o = i * SILENCE_FRAME_BYTES;
    buf[o] = 0xff;
    buf[o + 1] = 0xf3;
    buf[o + 2] = 0xa4;
    buf[o + 3] = 0xc0;
  }
  return buf;
}

// The longest silence the engine generates, one hour: the most silence-gen.mjs accepts for
// --ms, and the most a pause asset or a declared silent segment's window may ask for.
const SILENCE_MAX_MS = 3_600_000;
// The form silence-gen.mjs accepts for --ms: a plain positive decimal.
const PAUSE_TEXT = /^(?:\d+|\d*\.\d+)$/;
// The shortest pause the engine can generate — NOT a separate rule, but where PAUSE_TEXT stops
// matching, named so a refusal can give the author a number they can actually write.
//
// String() switches to exponential notation below 1e-6 ("9.99999e-7"), and the generator takes
// only plain decimal text. Notation is not a lever the author has: JSON.parse normalises
// "0.0000001" in timing.json to the Number 1e-7 either way, so NO positive value under this
// floor has a form the generator accepts, however it is written. A remedy that asked for "a
// plain decimal" therefore sent the author in a circle; one that names this floor does not.
//
// For ADVICE only. The refusal itself stays isGenerablePause's, so the gate and the generator
// go on agreeing by construction — do not restate this as the check.
const PAUSE_MIN_MS = 0.000001;

/**
 * Can the engine generate a pause of `ms`? THE ONE RULE — the gate that refuses an ungenerable
 * pause before anything is written and the generator that refuses it at the point of writing
 * both call this, so they cannot disagree. Neither restates it.
 *
 * Three parts, and the TEXT form is the one that is easy to miss: silence-gen accepts a plain
 * decimal, and that is tested against String(ms), which switches to exponential notation below
 * 1e-6 ("1e-7") and at or above 1e21 ("1e+21"). So a pause can be above 0 AND far under the
 * ceiling and still be ungenerable. A gate that mirrored only the ceiling let exactly that
 * through, to fail inside the generator after the clips were written and the TTS calls spent.
 */
function isGenerablePause(ms) {
  const text = String(ms).trim();
  const value = Number(text);
  return PAUSE_TEXT.test(text) && value > 0 && value <= SILENCE_MAX_MS;
}

/**
 * The bytes of a pause asset the engine names itself — lead.mp3, gap_NN.mp3, outro.mp3 —
 * for a solved pause of `ms`.
 *
 * These were written by a silence-gen.mjs child process, which resolves its --out through
 * the resolver that FOLLOWS an in-root link: a gap_01.mp3 planted as a link to music.wav
 * had MPEG silence written into music.wav. voice.mjs and remix.mjs now write them
 * in-process, through the resolver that refuses a link. This keeps what the child did:
 * the same duration check, then the same silentMp3() call, so the bytes do not change.
 *
 * @throws {CliError} EXIT.FAILED, naming the asset, for a duration silence-gen would have
 *   refused. A pause is solved by the stage, not typed by the caller, so a bad one is a
 *   failure of the run rather than bad usage.
 */
export function silenceAssetBytes(ms, name) {
  const text = String(ms).trim();
  const value = Number(text);
  if (!isGenerablePause(ms)) {
    throw new CliError(
      `${name}: the solved pause is ${text}ms — a pause asset must be a plain number of milliseconds ` +
        `above 0 and at most ${SILENCE_MAX_MS}. Check the timeline's lead-in, gap and outro values.`,
      EXIT.FAILED,
    );
  }
  return silentMp3(value);
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
  return (
    seg !== null && typeof seg === "object" && Object.hasOwn(seg, "silence")
  );
}

/**
 * The authored duration of a silent segment: its window, and nothing else. NaN unless both
 * bounds are numbers: a null, a string or an array is no window, and is not coerced into one.
 */
export function silentDurationMs(seg) {
  return typeof seg.startMs === "number" && typeof seg.endMs === "number"
    ? seg.endMs - seg.startMs
    : NaN;
}

/**
 * Does this segment's audio record name a clip?
 *
 * voice.mjs names one for every segment it runs for, silent ones included. remix.mjs
 * re-measures only clips that exist, so it refuses a segment whose record names none,
 * and a remedy that sends someone to remix has to ask this first.
 */
export function hasAudioFile(seg) {
  return typeof seg?.audio?.file === "string" && seg.audio.file.trim() !== "";
}

// What a record value is, for a diagnostic that describes a file's shape and never quotes
// its content: a number is shown, anything else is named by its type.
const kindOf = (v) =>
  v === null
    ? "null"
    : Array.isArray(v)
      ? "an array"
      : typeof v === "number"
        ? String(v)
        : typeof v === "object"
          ? "an object"
          : `a ${typeof v}`;
// The same, for a value that may be absent.
const shownKind = (v) => (v === undefined ? "missing" : kindOf(v));
// A value a diagnostic quotes, as JSON, except a number JSON cannot write: JSON.stringify
// writes NaN and Infinity, which JSON.parse reads from 1e999, as null.
const shownValue = (v) =>
  typeof v === "number" ? String(v) : JSON.stringify(v);

/**
 * What a silent segment's audio record says about its window, as one of:
 *
 *   {state: 'absent'}                  no record: `audio` is not there. Declared before
 *                                      the voice stage ran, or after it and filled only by
 *                                      concat — there is no generated length to compare.
 *   {state: 'unusable', why}           a record that gives no generated length: `audio` is
 *                                      not an object, or its durationMs is not a finite
 *                                      number >= 0. `why` says which, by shape.
 *   {state: 'matches' | 'differs', recordedMs}
 *                                      the window does, or does not, still hold the silence
 *                                      the record describes.
 *
 * The window is authored and the silence in its clip is generated from it, so the two
 * agree after every stage that generates it (voice.mjs, remix.mjs, both of which record
 * its length) and disagree only when the window was edited after that silence was made: a
 * timeline not yet reflowed onto it. Only an ABSENT record is unknown. One that is there
 * but gives no length is not "no record": it vouches for nothing, and a window it cannot
 * vouch for may be stale.
 *
 * One definition for every stage that asks, so remix.mjs (which keeps plannedDurationMs
 * only on 'matches' and rewrites the record whatever else it finds) and validate-timing.mjs
 * (which fails the timeline on 'differs' and 'unusable') cannot disagree about what "edited
 * since its silence was generated" means.
 */
export function silentRecordState(seg) {
  const audio = seg?.audio;
  if (audio === undefined) return { state: "absent" };
  if (audio === null || typeof audio !== "object" || Array.isArray(audio)) {
    return {
      state: "unusable",
      why: `its audio record is ${kindOf(audio)}, not an object`,
    };
  }
  const recordedMs = audio.durationMs;
  if (recordedMs === undefined)
    return { state: "unusable", why: "its audio record has no durationMs" };
  if (
    typeof recordedMs !== "number" ||
    !Number.isFinite(recordedMs) ||
    recordedMs < 0
  ) {
    return {
      state: "unusable",
      why: `its audio record's durationMs is ${kindOf(recordedMs)}, not a finite number of milliseconds >= 0`,
    };
  }
  return {
    state: silentDurationMs(seg) === recordedMs ? "matches" : "differs",
    recordedMs,
  };
}

/**
 * The remedy for a timeline whose `durationMs` is shorter than its last window, for the
 * stages it bounds: some window changed after the duration was measured.
 *
 * Which stage re-measures it depends on what changed. A declared silent window is
 * authored, and remix.mjs (S4) regenerates its silence and reflows the timeline onto it
 * with no re-voice. So when the last window is a silent one, or an earlier silent window no
 * longer holds the silence its record describes, the change is a silence edit and remix is
 * the remedy — provided that segment's record names its clip, since remix refuses one that
 * names none. An earlier silent record that names its clip but gives no usable length cannot
 * show whether its window was edited, so it is not called a silence edit; remix is its
 * repair all the same, and the stage validate-timing.mjs names for it, so it is sent there
 * too. Anything else needs the voice stage (S3).
 *
 * The stage is named as a step only where it would run (see the stage gates below). While
 * any silence declaration is malformed, no stage is named: that declaration is reported in
 * place of every remedy below, the edit by hand included. Where the stage would refuse for
 * another reason, it is named with that reason rather than as a step to take.
 *
 * Shared by write-subtitles.mjs and write-chapters.mjs, so the same edit is never sent to
 * two different stages.
 *
 * @param {string} lead  what durationMs bounds, e.g. 'It bounds the last cue'
 * @param {string} dir  the project root, where the stage named would run
 * @param {object} timing  the timeline, whose segments are objects with measured windows
 * @param {number} lastIndex  the index of the segment that ends last
 * @param {(seg: object, i: number) => string} labelOf  how the caller names a segment
 */
export function durationShortfallRemedy(lead, dir, timing, lastIndex, labelOf) {
  const segs = timing.segments;
  const declaration = declarationBlocker(segs, labelOf);
  if (declaration)
    return `${lead}, but ${malformedDeclaration(declaration.fact)}`;
  const last = segs[lastIndex];
  if (isSilentSegment(last)) {
    const where = labelOf(last, lastIndex);
    if (!hasAudioFile(last)) {
      if (segs.every(isSilentSegment)) {
        // voice.mjs has no narration to synthesise, and remix refuses this record.
        return (
          `${lead}, and ${where} is declared silent but no audio.file names its clip, and every segment is ` +
          "declared silent, so no stage measures the timeline: set timing.durationMs by hand, no shorter than the last " +
          "segment's end"
        );
      }
      return (
        `${lead}, and ${where} is declared silent but no audio.file names its clip, so the voice stage has not run ` +
        `for it: ${gatedRemedy(voiceBlocker(dir, timing, labelOf), {
          open: "run voice.mjs (S3), which generates its clip and re-measures the timeline",
          stem: "voice.mjs (S3) generates its clip and re-measures the timeline",
        })}`
      );
    }
    return `${lead}, and ${where} is declared silent, so its window is a silence edit: ${remixReflowRemedy(dir, timing, labelOf)}`;
  }
  const edited = segs.findIndex(
    (s) =>
      isSilentSegment(s) &&
      hasAudioFile(s) &&
      ["differs", "unusable"].includes(silentRecordState(s).state),
  );
  if (edited !== -1) {
    const record = silentRecordState(segs[edited]);
    const found =
      record.state === "differs"
        ? " and its window no longer holds the silence its record describes, so the change is a silence edit"
        : `, but ${record.why}, so nothing shows its window still holds the silence generated for it`;
    return (
      `${lead}, and ${labelOf(segs[edited], edited)} is declared silent${found}: ` +
      remixReflowRemedy(dir, timing, labelOf)
    );
  }
  return `${lead}; ${gatedRemedy(voiceBlocker(dir, timing, labelOf), {
    open: "run voice.mjs (S3) to measure it",
    stem: "voice.mjs (S3) measures it",
  })}`;
}

const remixReflowRemedy = (dir, timing, labelOf) =>
  gatedRemedy(remixBlocker(dir, timing, labelOf), {
    open: "run remix.mjs (S4), which regenerates that silence and reflows the timeline onto it, with no re-voice",
    stem: "remix.mjs (S4) regenerates that silence and reflows the timeline onto it, with no re-voice",
  });

/**
 * The remedy for a timeline whose `durationMs` is not a number at all, for the stages it
 * bounds. voice.mjs measures it; on a timeline with no narration, which voice refuses,
 * remix.mjs does, and where neither would run it is set by hand.
 *
 * @param {string} lead  what durationMs bounds, e.g. 'It bounds the last cue'
 */
export function durationMeasureRemedy(lead, dir, timing, labelOf) {
  const voice = voiceBlocker(dir, timing, labelOf);
  if (voice === null) return `${lead}; run voice.mjs (S3/S4) to measure it`;
  if (voice.declaration)
    return `${lead}, but ${malformedDeclaration(voice.fact)}`;
  if (
    Array.isArray(timing.segments) &&
    timing.segments.every(isSilentSegment)
  ) {
    const remix = remixBlocker(dir, timing, labelOf);
    if (remix === null) {
      return (
        `${lead}; every segment is declared silent, so there is no narration to measure: run remix.mjs (S4), ` +
        "which generates the silence and measures the timeline, with no re-voice"
      );
    }
    return (
      `${lead}; every segment is declared silent, so there is no narration to measure, and remix.mjs (S4) ` +
      `refuses this timeline as it stands: ${renderBlocker(remix, { factOnly: true })}; set timing.durationMs by hand, ` +
      "no shorter than the last segment's end"
    );
  }
  return `${lead}; ${gatedRemedy(voice, { stem: "voice.mjs (S3/S4) measures it" })}`;
}

/**
 * What is wrong with a DECLARED SILENT segment's startMs or endMs that is not a number of
 * milliseconds, for the stages that read windows (write-chapters.mjs, write-subtitles.mjs).
 *
 * A silent window is authored, not measured, so re-voicing is never its repair: the field is
 * corrected by hand, and if that changes the window's length, remix.mjs (S4) reflows the
 * timeline onto it. The message states the bound that makes the window positive, since
 * remix refuses a window that is not, and whether remix would then run is asked of the
 * timeline exactly as the edits the message names leave it: the fields the writer reports
 * (`fields`) take the most favourable value that bound permits, and a field it accepts keeps
 * its value — unless no value of the reported field gives a positive window against it, in
 * which case the message names that field's edit too, and so does the timeline asked.
 *
 * @param {{dir: string, timing: object, index: number, field: string, fields: string[],
 *   shown: string, labelOf: (seg: object, i: number) => string}} what  `shown` describes the
 *   bad value; `fields` lists every field of this segment the writer reports, `field` among them
 */
export function silentWindowFieldProblem({
  dir,
  timing,
  index,
  field,
  fields,
  shown,
  labelOf,
}) {
  const seg = timing.segments[index];
  const both = fields.includes("startMs") && fields.includes("endMs");
  let bound;
  let corrected;
  if (both) {
    bound =
      field === "startMs"
        ? " and less than endMs"
        : " and greater than startMs";
    corrected = { startMs: 0, endMs: 1 };
  } else if (field === "startMs" && seg.endMs > 0) {
    bound = ` and less than endMs (${seg.endMs})`;
    corrected = { startMs: 0 };
  } else if (field === "startMs") {
    bound =
      `. endMs (${seg.endMs}) must change too: no startMs >= 0 gives a window that ends at ${seg.endMs} a positive ` +
      "length, so write endMs as a number of milliseconds greater than startMs";
    corrected = { startMs: 0, endMs: 1 };
  } else {
    bound = ` and greater than startMs (${seg.startMs})`;
    corrected = { endMs: seg.startMs + 1 };
  }
  const text =
    `${labelOf(seg, index)} is declared silent, so its window is authored, not measured: ${field} is ${shown} ` +
    `— write it as a number of milliseconds, >= 0${bound}`;
  const after =
    Object.keys(corrected).length > 1 ? "Once both are corrected, if" : "If";
  const hypothetical = structuredClone(timing);
  Object.assign(hypothetical.segments[index], corrected);
  const b = remixBlocker(dir, hypothetical, labelOf);
  if (b === null)
    return `${text}. ${after} that changes the window's length, remix.mjs (S4) reflows the timeline onto it, with no re-voice`;
  if (b.declaration)
    return `${text}. ${startSentence(malformedDeclaration(b.fact))}`;
  return (
    `${text}. ${after} that changes the window's length, remix.mjs (S4) is the stage that reflows the timeline onto it, ` +
    `with no re-voice, but it would refuse this timeline even then: ${renderBlocker(b, { factOnly: true })}`
  );
}

/**
 * The remedy for a NARRATED segment's startMs or endMs that is not a number: voice.mjs
 * measures narrated windows. Named as a step only where it would run.
 */
export function narratedWindowFieldRemedy(dir, timing, labelOf) {
  const b = voiceBlocker(dir, timing, labelOf);
  return b === null
    ? "Run voice.mjs (S3/S4) first"
    : startSentence(gatedRemedy(b, { stem: "voice.mjs (S3/S4) measures it" }));
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
  if (decl === null || typeof decl !== "object" || Array.isArray(decl)) {
    problems.push(
      `${where} declares \`silence\` as ${shownValue(decl)} — it must be an object, e.g. {"caption": "[music]"}`,
    );
    return problems;
  }

  // The accessibility cue is the ONLY thing a viewer reading captions gets from a silent
  // segment. There are no measured word boundaries to fall back on, so a blank cue is not
  // "no caption" — it is a caption that renders as an empty box. Refuse it.
  const caption = decl.caption;
  if (typeof caption !== "string" || caption.trim() === "") {
    problems.push(
      `${where} is declared silent but its \`silence.caption\` is ${shownValue(caption)} — ` +
        `a silent segment needs an authored accessibility cue (e.g. "[music]" or "[intermission]") ` +
        `because there are no measured word boundaries to caption from`,
    );
  } else {
    // The cue is written into the subtitle sidecars as it stands, so a line break can end it
    // and a "-->" start another, with timing of its own: "[music]\n\n00:00.000 --> 00:05.000\nX"
    // wrote a second cue into both sidecars.
    //
    // Every Unicode mandatory line break is refused, not only the CR and LF a WebVTT file
    // uses as its own line terminators: UAX #14 classes BK, CR, LF and NL, which is LF, VT,
    // FF, CR, NEL, U+2028 and U+2029. A cue is one line by construction, and those are the
    // characters that end a line by definition rather than by one reader's convention, so
    // none of them is written into a sidecar unexamined. Nothing else is refused — TAB,
    // U+001C-U+001E and NBSP are accepted.
    //
    // Each one found is named by its code point: none of the seven has a glyph, and NEL,
    // U+2028 and U+2029 can sit unescaped in timing.json, so "a line break" on its own
    // leaves the author hunting a character they cannot see. Distinct ones only, in order
    // of first appearance, so the list is a map of the string rather than a tally.
    const breaks = caption.match(/[\n\v\f\r\u0085\u2028\u2029]/g) ?? [];
    const arrow = caption.includes("-->");
    if (breaks.length || arrow) {
      const points = [...new Set(breaks)].map(
        (c) =>
          `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`,
      );
      const named = `a line break (${points.join(", ")})`;
      const found =
        points.length && arrow
          ? `${named} and "-->"`
          : points.length
            ? named
            : '"-->"';
      problems.push(
        `${where} is declared silent but its \`silence.caption\` contains ${found} — the caption is written into the ` +
          'subtitle sidecars as one cue, where a line break can end the cue and "-->" can start another, so write it on ' +
          'one line, without "-->"',
      );
    }
  }

  // Narration plus a silence declaration is a contradiction with no safe resolution:
  // whichever one a stage honours, the other was a lie.
  const text = String(seg.voiceoverText ?? "");
  if (text.trim() !== "") {
    problems.push(
      `${where} is declared silent but carries narration text (${text.trim().length} chars) — ` +
        `a silent segment is never spoken, so remove the text or remove the \`silence\` declaration`,
    );
  }

  // The window is all of a silent segment's duration, so each bound must be a number as
  // written: coerced, a null start was 0 and a string end its digits. The start is at least
  // 0, as the schema says, and the window at most the longest silence the engine generates.
  const startOk = Number.isFinite(seg.startMs) && seg.startMs >= 0;
  const endOk = Number.isFinite(seg.endMs);
  if (!startOk) {
    problems.push(
      `${where} is declared silent but its startMs is ${shownKind(seg.startMs)} — ` +
        `a silent segment's window is authored, so its startMs must be a finite number of milliseconds, at least 0`,
    );
  }
  if (!endOk) {
    problems.push(
      `${where} is declared silent but its endMs is ${shownKind(seg.endMs)} — ` +
        `a silent segment's window is authored, so its endMs must be a finite number of milliseconds`,
    );
  }
  if (startOk && endOk) {
    const durationMs = silentDurationMs(seg);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      problems.push(
        `${where} is declared silent but its window is ${durationMs}ms — ` +
          `a silent segment's duration is authored as endMs - startMs and must be positive`,
      );
    } else if (durationMs > SILENCE_MAX_MS) {
      problems.push(
        `${where} is declared silent but its window is ${durationMs}ms — a silent segment's window, endMs - startMs, ` +
          `must be at most ${SILENCE_MAX_MS}ms (one hour), the longest silence the engine generates`,
      );
    }
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

/**
 * Why a NARRATED segment's audio record cannot be narration, or null when it can be.
 *
 * voice.mjs records the word boundaries of every narrated clip it synthesises, and a clip
 * of speech always has at least one. A narrated segment whose record holds none is
 * therefore carrying a clip that is not its narration — typically the generated silence
 * voice made while the segment was still declared silent, with the declaration since
 * removed. Stages that only arrange existing audio (remix, concat) cannot make narration;
 * only the voice stage can, so that is the stage this names — as a step only where it would
 * run, which is why it is given the project and the timeline.
 *
 * Never quotes the narration: a diagnostic describes the file's shape, not its content.
 */
export function unvoicedNarrationProblem(
  seg,
  where = `segment "${seg?.id}"`,
  dir,
  timing,
  labelOf = defaultLabel,
) {
  const words = seg?.audio?.words;
  if (Array.isArray(words) && words.length > 0) return null;
  return `${renderBlocker({ fact: unvoicedNarrationFact(seg, where), then: unvoicedNarrationRemedy(dir, timing, seg, labelOf) })}.`;
}

function unvoicedNarrationFact(seg, where) {
  const words = seg?.audio?.words;
  const held = Array.isArray(words)
    ? "an empty word list"
    : words === undefined
      ? "no word list"
      : "a word list that is not a list";
  return (
    `${where} is narrated, but its audio record holds ${held} — so its clip is not narration voice.mjs produced ` +
    "for it (a segment declared silent when voice ran gets generated silence)"
  );
}

function unvoicedNarrationRemedy(dir, timing, seg, labelOf) {
  return (
    "arranging existing audio cannot create speech: " +
    gatedRemedy(voiceBlocker(dir, timing, labelOf), {
      open: `run voice.mjs (S3) to synthesise it, or, if it is meant to be silent, ${declareSilentRemedy(seg)}`,
      stem: "voice.mjs (S3) synthesises it",
    })
  );
}

/** A segment's word count, counted the way voice.mjs and validate-timing count it. */
export function wordsInSegment(seg) {
  // `.filter(Boolean)` is load-bearing: `''.split(/\s+/)` is `['']`, so without it an
  // empty segment reports ONE word — a number that looks measured and is not.
  return String(seg?.voiceoverText ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
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
    const textHash = narrationFingerprint(s.voiceoverText);
    if (isSilentSegment(s)) {
      // No `effWps`, no speech. `silent: true` says WHY the rate is missing, so a reader
      // is never left to guess whether it was omitted or lost.
      return {
        id: s.id,
        words: 0,
        chars: 0,
        clipMs: clip.durationMs,
        speechMs: 0,
        silent: true,
        textHash,
      };
    }
    const words = wordsInSegment(s);
    const speechMs = clip.durationMs - clip.headMs - clip.tailMs;
    return {
      id: s.id,
      words,
      chars: String(s.voiceoverText ?? "").length,
      clipMs: clip.durationMs,
      speechMs,
      effWps: +(words / (speechMs / 1000)).toFixed(3),
      textHash,
    };
  });

  const spoken = calSegs.filter((c) => !c.silent);
  if (spoken.length === 0) {
    // Writing the file anyway would put `"observedEffWps": null` on disk and make the NEXT
    // stage report the wrong failure. Naming the real situation here costs one run and
    // saves the author from debugging their calibration file. Removing a declaration alone
    // would leave a narrated segment with no text, which the TTS service cannot synthesise,
    // so the edit offered gives that segment its narration too.
    throw new CliError(
      "every segment is declared silent, so there is no speech to calibrate a word rate from — " +
        "a project with no narration does not need the voice stage. Give a segment its narration text and remove " +
        "its `silence` declaration, or skip this stage.",
    );
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

// ===========================================================================
// Which stage a remedy may name
// ===========================================================================
//
// A diagnostic that names a stage as its remedy has to name one that would run. These gates
// answer that for voice.mjs (S3) and remix.mjs (S4): null when the stage would accept the
// timeline as it stands, otherwise the first reason they find for it to refuse — a `fact`
// and, where one exists, the edit that clears it (`then`). A remedy names a stage as a step
// only while its gate is open; otherwise it names the stage together with why it would
// refuse — or, where that reason is a malformed silence declaration, reports the declaration
// instead of naming the stage — so following a diagnostic never leads to a stage that
// refuses the same timeline.
//
// They model the refusals the timeline and the files it names decide: the shape of its
// segments, the silence declarations, the narration text, the clips the records name, and the
// files each stage writes. They report the first they find, in their own order, as
// voiceBlocker and remixBlocker describe. They do not model the intake, the brand tokens,
// the TTS service or the replace guard, which each stage reports for itself when it runs.

const pad2 = (n) => String(n).padStart(2, "0");

/** The name voice.mjs gives segment i's clip, and remix.mjs a declared silent one's. */
export const segmentClipName = (i) => `segment_${pad2(i + 1)}.mp3`;

/** The pause asset inserted AFTER segment i. */
export const gapAssetName = (i) => `gap_${pad2(i + 1)}.mp3`;

/**
 * How a refusal names one segment: by its id when it has a usable one, otherwise by its index.
 *
 * ONE STATEMENT OF A RULE THE ENGINE ALREADY MAKES TWICE. `frame-capture.mjs` picks
 * `timing.segments[i]` for an id-less segment and says why; `segmentEntryFact` does the same and
 * explains that `segment "1"` would send an author to the wrong line when another segment really
 * carries the id "1". `segment "${s?.id ?? i}"` quietly disagrees with both: it formats a 0-based
 * INDEX as a quoted id, so an author goes looking for a segment genuinely called "2" — and the
 * fixture in this module's own tests has a segment whose id IS "2", which is why the collision is
 * not hypothetical.
 *
 * An id that merely looks like an index is still an id, so `{ id: '2' }` is `segment "2"`. The
 * distinction this draws is between HAVING an id and not having one — never between how an id
 * happens to be spelled.
 *
 * CONSUMERS(segmentLabel): concat-audio.mjs, remix.mjs, write-storyboard.mjs
 * Used inside this module by defaultLabel. THAT USE IS CURRENTLY UNOBSERVABLE: all three gates
 * ask shapeBlocker first, and it refuses any segment without a usable id, so defaultLabel never
 * meets one. The symbol therefore fixes the STATEMENT, not a live symptom, and is pinned by
 * direct unit tests rather than through a gate.
 *
 * Of the three callers that restated the old form, TWO ARE LIVE and one is not — measured, not
 * assumed. `concat-audio.mjs` reaches both of its labels, because it gates with
 * segmentEntryBlocker, which refuses non-objects but has no opinion about ids; an id-less
 * segment therefore arrives at its silent-declaration label and at its clip-matching label
 * intact, and both are covered by integration tests. `remix.mjs` is NOT reachable with an
 * id-less segment: its gate asks shapeBlocker first. It reads this symbol for the statement's
 * sake and is pinned here, because a green assertion over an unreachable branch would document
 * a gap as covered. A test asserts the list above matches the modules that actually import this
 * symbol, in both directions.
 */
export function segmentLabel(s, i) {
  return typeof s?.id === "string" && s.id !== ""
    ? `segment "${s.id}"`
    : `timing.segments[${i}]`;
}

const defaultLabel = segmentLabel;

// The pause assets a stage can write: a seam touching a declared silent segment never gets
// a pause, and a silent first segment never gets a lead-in, whatever the solve.
function pauseSet(segs, withOutro) {
  return [
    ...(isSilentSegment(segs[0])
      ? []
      : [{ key: "lead.mp3", solved: "a lead-in" }]),
    ...segs.slice(0, -1).flatMap((s, i) =>
      isSilentSegment(s) || isSilentSegment(segs[i + 1])
        ? []
        : [
            {
              key: gapAssetName(i),
              solved: `a pause after segment "${s.id}"`,
            },
          ],
    ),
    ...(withOutro ? [{ key: "outro.mp3", solved: null }] : []),
  ];
}

/**
 * Every file voice.mjs writes, in the order its plan lists them. Its plan, its distinctness
 * check and its writes use this list, and so does the voice gate, so the gate cannot pass a
 * write set voice refuses. Only the pause assets this run CAN write are listed.
 */
export function voiceWriteSet(timing) {
  const segs = timing.segments;
  return [
    ...segs.map((seg, i) => ({
      key: segmentClipName(i),
      label: `segment ${seg.id} output`,
      append: false,
    })),
    ...pauseSet(
      segs,
      timing.endCard?.enabled && Number(timing.outroMs) > 0,
    ).map((o) => ({ ...o, label: o.key, append: false })),
    { key: "voiceover.mp3", label: "voiceover.mp3", append: false },
    { key: "timing.json", label: "timing.json", append: false },
    {
      key: "calibration-observed.json",
      label: "calibration-observed.json",
      append: false,
    },
    { key: "sync-mapping.md", label: "sync-mapping.md", append: false },
    // Appended to on a synthesis retry, so it carries no --replace requirement — but it is
    // still a write, and still an engine-chosen name.
    { key: "heal-log.txt", label: "heal-log.txt", append: true },
  ];
}

/**
 * Every file remix.mjs writes: the voice track, the timeline, each declared silent
 * segment's clip — under the name its position gives it, so its record always names a clip
 * holding exactly the silence the record describes — and the pause assets. A narrated
 * segment's clip is read, and never written.
 */
export function remixWriteSet(timing) {
  const segs = Array.isArray(timing.segments) ? timing.segments : [];
  return [
    { key: "voiceover.mp3", label: "voiceover.mp3" },
    { key: "timing.json", label: "timing.json" },
    ...segs.flatMap((s, i) =>
      isSilentSegment(s)
        ? [
            {
              key: segmentClipName(i),
              label: `segment ${s.id} output`,
              silent: s,
            },
          ]
        : [],
    ),
    // Listed unless the duration is known to write nothing, so a malformed outroMs is
    // refused by the generator rather than skipped, as it always has been in remix. The
    // end-card test is the one its write applies, so the two cannot disagree about the file.
    ...pauseSet(
      segs,
      timing.endCard?.enabled && !(Number(timing.outroMs) <= 0),
    ).map((o) => ({ ...o, label: o.key })),
  ];
}

// A stage's write set resolved the way the stage resolves it before its plan — a link
// refused, a directory refused, every destination distinct — or the stage's refusal. The
// replace guard is the stage's own opt-in, so it is not a refusal here.
function writeSetBlocker(dir, set) {
  try {
    const resolved = set.map((o) => ({
      ...o,
      path: resolveEngineOutput(dir, o.key, {
        apply: false,
        replace: true,
        label: o.label,
      }),
    }));
    assertDistinctDestinations(
      resolved.map(({ key, path }) => ({ key, path })),
      "output",
    );
    return { resolved };
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    return { blocker: { fact: trimFact(err.message) } };
  }
}

// ---- what remix must not write over --------------------------------------------------------

// A record's clip, resolved the way remix resolves it; null where that refuses.
function recordedClipPath(dir, seg) {
  try {
    return resolveWithinRoot(dir, seg.audio.file, `segment ${seg.id} audio`);
  } catch {
    return null;
  }
}

// Names are not enough to tell two files apart, so a destination is matched three ways.
// By canonical name: on Windows a case variant and an 8.3 short name share it, and it needs
// no file IDs. Publishing by rename replaces the directory entry, so such a name is replaced
// with it, or left naming nothing. And by identity, where the volume reports file IDs: a
// hard link shares the inode but is another entry, which a rename leaves holding what it
// held — remix refuses it anyway. Inode 0 is no identity: it is what Node reports on a
// volume that gives no file IDs. The volume is compared only where both sides report one:
// Node's by-name stat can report 0 for it on Windows, and 0 is not a different volume.
function identityOf(p, label) {
  let st;
  let name;
  try {
    st = fs.statSync(p, { bigint: true, throwIfNoEntry: false });
    name = canonicalName(p);
  } catch (err) {
    throw new CliError(
      `${label}: could not inspect ${p} (${err.code ?? err.message}) — refusing rather than assuming it is not a narrated clip`,
    );
  }
  return {
    exists: st !== undefined,
    id: st === undefined || st.ino === 0n ? null : st,
    name,
  };
}
/** Whether two bigint stats are one file: the same inode, on the same volume where both report one. */
export const sameIdentity = (a, b) =>
  a !== null &&
  b !== null &&
  a.ino === b.ino &&
  (a.dev === 0n || b.dev === 0n || a.dev === b.dev);
/** Whether two paths are spelled as one name, as the platform compares names. */
export const sameName = (a, b) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
/**
 * The one name the platform gives the file at `p`: its long name, with every link followed.
 * A path naming nothing is returned as typed, so the caller compares the text it has. Any
 * other failure is thrown: whether "not shown to be the same" may be read as "different"
 * is the caller's policy, and each caller states it.
 */
export function canonicalName(p) {
  try {
    return fs.realpathSync.native(p);
  } catch (err) {
    if (err?.code === "ENOENT") return p;
    throw err;
  }
}

// The first destination in a resolved write set that is a narrated segment's clip — by name,
// by canonical name, or, where both exist on a volume with file IDs, by identity — with that
// segment and which of those matched. Segments in `cleared` are left out: a remedy asks what
// remix would do once their narration has a file of its own.
function firstNarratedClipCollision(dir, segs, resolved, cleared) {
  const owners = segs
    .map((s, i) => ({ s, i }))
    .filter(
      ({ s }) => !isSilentSegment(s) && hasAudioFile(s) && !cleared.includes(s),
    )
    .map((n) => ({ ...n, path: recordedClipPath(dir, n.s) }))
    .filter((n) => n.path !== null)
    .map((n) => ({
      ...n,
      ...identityOf(n.path, `segment ${n.s.id} audio`),
    }));
  for (const o of resolved) {
    const { id, name } = identityOf(o.path, o.label);
    const owner = owners.find(
      (n) =>
        sameName(n.path, o.path) ||
        sameName(n.name, name) ||
        sameIdentity(n.id, id),
    );
    if (owner) {
      const kind = sameName(owner.path, o.path)
        ? "name"
        : sameName(owner.name, name)
          ? "canonical"
          : "identity";
      return { o, owner, kind };
    }
  }
  return null;
}

/**
 * Why remix refuses a destination in its write set that is a narrated segment's clip, with
 * the edit that clears it, or null when no destination is one.
 *
 * The edit is a COPY: the narration gets a file of its own, under a name remix does not
 * write, and its record is pointed there. Not a rename, which removes the file any other
 * record naming it still needs (remix refuses a record whose clip is missing), and not
 * "delete it", which by another name for the same file can delete the only copy of the
 * narration. What remix would do once that is done is asked too, so the next step it names
 * is one remix would take.
 *
 * @param {object[]} resolved  remix's write set, each entry with the path it resolves to
 * @throws {CliError} when a file cannot be inspected
 */
export function remixCollisionBlocker(
  dir,
  timing,
  labelOf,
  resolved,
  { cleared = [], nested = false } = {},
) {
  const segs = timing.segments;
  const hit = firstNarratedClipCollision(dir, segs, resolved, cleared);
  if (hit === null) return null;
  const { o, owner, kind } = hit;
  const narrated = labelOf(owner.s, owner.i);
  const file = owner.s.audio.file;
  const { root } = createBoundary(dir);
  const spelled = (f) => path.resolve(root, f);
  // The record's own spelling, and how it reaches the file the narration is read from: the
  // resolver follows an in-root link, so that file can have another name than the record's.
  const read = path.relative(root, owner.path);
  let via = "";
  if (!sameName(spelled(file), owner.path)) {
    let link = false;
    try {
      link =
        fs
          .lstatSync(spelled(file), { throwIfNoEntry: false })
          ?.isSymbolicLink() === true;
    } catch {
      // Not inspected, so not shown to be the link itself; a link on the way was followed.
    }
    via = link
      ? `, a link to ${read}`
      : `, which leads through a link to ${read}`;
  }
  const silent = o.silent ? labelOf(o.silent, segs.indexOf(o.silent)) : null;
  let fact;
  if (o.silent && kind === "name") {
    // A silent segment's clip name is positional, and a narrated record names that file:
    // the timeline was reordered after voice ran, or two records named one clip.
    fact =
      `${silent} is declared silent, so remix regenerates its clip as ${o.key}, the name that belongs to its ` +
      `position in the timeline, and narrated ${narrated}'s record names ${via ? `${file}${via}` : "that file"}` +
      (owner.exists
        ? ". Writing the silence would destroy that narration"
        : ", which is not in the project: the silence would be written where its record expects its narration");
  } else if (kind === "identity") {
    // Another entry for the narration's file. Publishing by rename replaces the entry remix
    // writes and leaves this one holding the narration; remix refuses it all the same.
    const holder = via ? read : file;
    fact =
      `remix writes ${o.key}, and ${o.key} is a hard link of ${holder}, which narrated ${narrated} is read from` +
      (via ? `: its record names ${file}${via}` : "") +
      `. Publishing ${o.key} by rename would leave ${holder} holding that narration, but remix never writes a ` +
      "narrated clip it reads, under any name";
  } else {
    fact =
      `remix writes ${o.key}, and ${narrated} is narrated and its record names ` +
      (kind === "canonical"
        ? `${file}${via}, another name for ${o.key}`
        : via
          ? `${file}${via}`
          : "that file") +
      (owner.exists
        ? ". Writing it would destroy that narration"
        : `, which is not in the project: ${o.key} would be written where its record expects its narration`);
  }
  let next = null;
  if (!nested) {
    try {
      next = remixBlocker(dir, timing, labelOf, {
        cleared: [...cleared, owner.s],
        nested: true,
      });
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      next = { fact: trimFact(err.message) };
    }
  }
  if (!owner.exists) {
    let then =
      `restore ${narrated}'s narration under a name remix does not write and point its audio.file there, or ` +
      gatedRemedy(
        voiceBlocker(dir, timing, labelOf),
        {
          open: "run voice.mjs (S3), which synthesises it and names every clip by its position",
          stem: "voice.mjs (S3) synthesises it",
        },
        { factOnly: true },
      );
    if (next !== null)
      then += `. After restoring it, remix would still refuse this timeline: ${renderBlocker(next, { factOnly: true })}`;
    return { fact, then };
  }
  const keeper = segs.findIndex(
    (s) =>
      isSilentSegment(s) &&
      hasAudioFile(s) &&
      recordedClipPath(dir, s) !== null &&
      sameName(spelled(s.audio.file), spelled(file)),
  );
  let then =
    `give the narration a file of its own: copy ${file} under a name remix does not write and point ` +
    `${narrated}'s audio.file at the copy` +
    (keeper === -1
      ? ""
      : `, and leave ${file} where it is — ${labelOf(segs[keeper], keeper)}'s record names it, and ` +
        "remix requires the file a record names to exist");
  if (!nested) {
    then +=
      next === null
        ? `. Then run remix.mjs --apply --replace: --replace because ${o.key} is still there, and this run overwrites it` +
          (silent
            ? ` with ${silent}'s silence`
            : o.solved
              ? ` if the solve inserts ${o.solved}`
              : "")
        : `. Even then, remix would refuse this timeline: ${renderBlocker(next, { factOnly: true })}`;
  }
  return { fact, then };
}

// ---- the gates ------------------------------------------------------------------------------

/**
 * Is this entry a segment object at all? The refusal as a string, naming the index, or null.
 *
 * THE INDEX, NOT THE ID: an entry that is not an object has no id to be named by, so its
 * position is the only handle an author has on it. `timing.segments[1]` is the form every
 * stage's label already uses for a segment that cannot name itself.
 *
 * THIS RULE IS THE ENTRY'S SHAPE AND NOTHING ELSE. It is deliberately NOT the schema's id rule
 * and NOT the "declares no segments" list rule, both of which shapeBlocker also enforces. Those
 * three travelled together until a null entry was found to crash four stages that each wanted
 * only this one: frame-capture.mjs:104-109 tolerates an id-less segment ON PURPOSE and labels it
 * by index, because `segment "1"` would send an author to the wrong line when another segment
 * really carries the id "1". A stage adopting shapeBlocker wholesale to fix the crash would have
 * silently reversed that decision. Extracted so the rule has ONE statement that every caller
 * reads, rather than one statement per caller that drift apart — which is how the end-card gate
 * and PLAIN_DECIMAL came to disagree before F7.
 *
 * CONSUMERS(segmentEntryFact): none
 * Called inside this module by shapeBlocker, so the two agree by construction rather than by
 * restatement. A test asserts that the list above matches the modules that actually import this
 * symbol, so adding a caller without updating the line fails the suite — the enumeration is an
 * audit, not a courtesy.
 */
export function segmentEntryFact(s, i) {
  if (s === null || typeof s !== "object" || Array.isArray(s))
    return `timing.segments[${i}] is not a segment object`;
  return null;
}

/**
 * The first entry in this list that is not a segment object, as `{fact}`, or null when every one
 * of them is. The whole-list form of segmentEntryFact, for the stages that want the entry rule
 * without the other two.
 *
 * A NON-ARRAY RETURNS NULL, DELIBERATELY. Whether an absent, empty or non-array segment list is
 * an error is each stage's own question and they answer it differently today — concat-audio
 * refuses it with its own wording, frame-capture tolerates it, write-storyboard crashes on it
 * (recorded as open work, not fixed here). Answering it here would change three shipped
 * behaviours under the cover of a crash fix. This function refuses entries; it does not have an
 * opinion about lists.
 *
 * CONSUMERS(segmentEntryBlocker): concat-audio.mjs, frame-capture.mjs, write-storyboard.mjs
 * Each of them threw an uncaught TypeError on a null entry before they called this. The line
 * above is compared against the real importers by a test, and must change in the SAME COMMIT as
 * an importer: it is only true relative to the modules in one working tree.
 */
export function segmentEntryBlocker(segs) {
  if (!Array.isArray(segs)) return null;
  for (const [i, s] of segs.entries()) {
    const fact = segmentEntryFact(s, i);
    if (fact) return { fact };
  }
  return null;
}

/**
 * Can every stage read this timeline's segment list? null when it can; otherwise the first
 * problem, as `{fact}`, with no remedy: no list, or an empty one, which the schema's minItems
 * forbids; else, in index order, the first entry that is not a segment object or has no
 * non-empty string id, which the schema requires. An entry is named by its index, since it
 * may have no id to be named by.
 *
 * THIS IS A BUNDLE OF THREE RULES, and callers rarely want all three. The entry-shape rule is
 * segmentEntryFact, called below rather than restated. remix.mjs imports this whole gate;
 * voice.mjs does not import it but refuses exactly what it refuses, because voiceTimelineBlocker
 * asks it first; validate-scene.mjs calls it directly before any of its own checks. Any stage
 * that wants only the entry rule should call segmentEntryBlocker and keep its own handling of an
 * absent or empty list.
 *
 * The input's NAME is a parameter, defaulting to the only thing two shipped stages can mean by
 * it. `voice.mjs` and `remix.mjs` each hardcode `timing.json` as their input and call this with
 * one argument, so their wording is unchanged to the byte.
 *
 * NO CALLER PASSES A DIFFERENT NAME YET. `validate-scene.mjs` reads `--timing`, so it is the one
 * that should, and until it does its diagnostic still names `timing.json` for a file it did not
 * open. That is a one-line change in a file this task did not own, reported rather than made —
 * so this parameter is a capability, not a fix, and the contract is pinned by direct unit tests
 * rather than by an integration path that does not exist.
 *
 * Only the no-segments fact takes it. `timing.segments[1]` is a JSON PATH into the parsed
 * object, not a filename, and does not move with the input's name.
 */
export function shapeBlocker(timing, inputName = "timing.json") {
  const segs = timing?.segments;
  if (!Array.isArray(segs) || segs.length === 0) {
    return {
      fact: `${inputName} declares no segments`,
      // THE ONE FACT HERE THAT DOES NOT STATE ITS OWN FIX. The other two name the field and
      // the rule it breaks in the same sentence; this one names an absence and stops. The
      // remedy is an AUTHORING step, never a referral to another stage — a remedy that
      // sends an author to a stage which refuses the same timeline is a loop, and reading
      // one cannot tell you it is a loop. Following this clears this refusal outright.
      then: `write the timeline's segments into ${inputName} — each needs a non-empty string id`,
    };
  }
  for (const [i, s] of segs.entries()) {
    const entry = segmentEntryFact(s, i);
    if (entry) return { fact: entry };
    if (typeof s.id !== "string" || s.id === "") {
      const id =
        s.id === undefined ? "missing" : s.id === "" ? "empty" : kindOf(s.id);
      return {
        fact: `timing.segments[${i}]'s id is ${id} — every segment needs a non-empty string id`,
      };
    }
  }
  return null;
}

// remix and voice each refuse a timeline with a malformed silence declaration before writing
// anything, in their plan and under --apply. Both gates ask this straight after the timeline's
// shape, so unless the shape is refused first, a remedy that asks either reports the
// declaration rather than naming a stage.
function declarationBlocker(segs, labelOf) {
  for (const [i, s] of segs.entries()) {
    if (!isSilentSegment(s)) continue;
    const [problem] = silentSegmentProblems(s, labelOf(s, i));
    if (problem) return { fact: problem, declaration: true };
  }
  return null;
}

/**
 * What an ENABLED end card's stamp or outro is wrong about, as `{fact, then}`, or null. A
 * DISABLED end card is unaffected: the schema forbids these fields when there is no end card,
 * and a timeline that does not declare one is not judged here at all, so the gate other stages
 * ask does not start refusing timelines that never had an end card.
 *
 * The builderVersion rule MUST AGREE WITH voice.mjs's own check on the stamped timeline — a
 * string, non-empty after trimming, and not the text "undefined" or "null", case-insensitively.
 * voice.mjs makes that check again after it writes; if the two ever disagree, the later one
 * fires after every clip and voiceover.mp3 are on disk, which is the defect this check removes.
 * Change them together.
 *
 * The outro rule is the pause GENERATOR's own, called rather than restated: isGenerablePause,
 * which silenceAssetBytes also calls, so the gate and the generator cannot disagree about any
 * value. It refuses exactly what that generator refuses and no more: voice turns the outro into
 * a pause asset only when it solves ABOVE 0, so 0 — and any value that does not solve above 0 —
 * is not an outro the engine cannot make, it is no outro at all, which voice accepts and writes
 * nothing for. Refusing those here would refuse timelines the stage runs happily today.
 */
function endCardBlocker(timing) {
  if (timing?.endCard?.enabled !== true) return null;
  const bv = timing.builderVersion;
  const trimmed = typeof bv === "string" ? bv.trim() : null;
  const wrong =
    trimmed === null
      ? shownKind(bv)
      : trimmed === ""
        ? bv === ""
          ? "empty"
          : "blank"
        : ["undefined", "null"].includes(trimmed.toLowerCase())
          ? `the text ${JSON.stringify(bv)}`
          : null;
  if (wrong !== null) {
    return {
      fact:
        `the end card is enabled, but the timeline's builderVersion is ${wrong} — an enabled end card is ` +
        'stamped with the builder version, so it must be a non-empty string, and not the text "undefined" or "null"',
      then: "set builderVersion to the version this build was made with, or set endCard.enabled to false",
    };
  }
  const outroMs = Number(timing.outroMs);
  // Judged only where voice would actually generate it — above 0 (voice.mjs:278-279).
  if (outroMs > 0 && !isGenerablePause(outroMs)) {
    return {
      fact:
        `the end card is enabled, but the timeline's outroMs is ${shownValue(outroMs)}ms — the outro is a ` +
        `generated pause, so it must be from ${PAUSE_MIN_MS} to ${SILENCE_MAX_MS}ms (one hour), the longest ` +
        "silence the engine generates",
      then:
        `set outroMs to at least ${PAUSE_MIN_MS} and at most ${SILENCE_MAX_MS}, or 0 for an end card with ` +
        "no outro, or set endCard.enabled to false",
    };
  }
  return null;
}

/**
 * What NARRATED text may not carry, stated once for the two gates that refuse it.
 *
 * THE SAME RULE REACHES AN AUTHOR TWICE, AND THE TWO REACH DIFFERENT DISTANCES. voice.mjs
 * (S3) asks this through voiceTimelineBlocker, before it synthesises anything, so an author
 * stops paying for TTS on narration that could never caption. write-subtitles.mjs (S10)
 * asks it again, because narration can be edited AFTER voice has run and S10 does not
 * re-run this gate — MEASURED, not assumed.
 *
 * The LATE gate reaches further: it also refuses all seven mandatory line breaks in a
 * MEASURED WORD, which the early gate cannot see because measured words do not exist before
 * TTS. That asymmetry is deliberate and is stated at both sites, so neither reads as an
 * oversight to be tidied into the other.
 *
 * Only the two characters narration can actually deliver to a cue are here. MEASURED: of
 * Unicode's seven mandatory line breaks, /\s+/ splits six out of narration before they
 * reach a cue; U+0085 alone survives, because JS \s does not match it. Adding the six would
 * be a rule that could never fire.
 *
 * CONSUMERS(narrationCueProblems): write-subtitles.mjs
 * Used inside this module by voiceTimelineBlocker. A test asserts the list above matches the
 * modules that actually import this symbol, in both directions, so a second private copy of
 * this rule has to be a deliberate act rather than an accident of not knowing.
 */
export const CUE_ARROW = "-->";
export const CUE_NEL = "\u0085";

/**
 * The consequence of each, shared so the early and late refusals cannot describe it
 * differently.
 *
 * A HARM STRING STATES WHAT WAS MEASURED, FOR EVERY FORMAT THIS ENGINE WRITES. The arrow's
 * first version described Chromium's WebVTT behaviour only, inside a sentence that says the
 * text goes into BOTH sidecars. Measured against `.srt` afterwards, both of its clauses were
 * false there — prose holding "-->" is harmless in both SRT parsers, and the timing-line
 * shape deletes a cue or steals its timing rather than forging a second one.
 *
 * AND THE TWO SRT PARSERS DISAGREE WITH EACH OTHER, so neither reading may be promoted to a
 * property of the format. Saying "in .srt, X happens" would be the same over-claim pointing
 * the other way. What is named is what was observed, and in what.
 */
export const CUE_HARM = {
  arrow:
    "the damage differs by file and by shape, all MEASURED: in .vtt, Chromium parses any cue text line holding " +
    '"-->" as EMPTY, so the caption silently disappears whatever else is on that line, and cue text that is ' +
    "itself a whole timing line forges a second cue; in .srt, prose holding it was harmless in both parsers " +
    "tried, but cue text shaped as a whole timing line made ffmpeg either delete the cue or adopt the injected " +
    "timing and lose the real text, both at exit 0 with no diagnostic, while srt-parser-2 left it intact — two " +
    "SRT parsers disagreeing, so this is what was observed and not a property of the format",
  // U+0085's own reason. It adds no line in Chromium, in ffmpeg or in srt-parser-2 — three
  // implementations — so citing the extra-line harm for it would explain this rule with a
  // consequence the engine has measured it does not have. The cue-grouping split is this
  // engine's OWN grouping, so unlike a parser behaviour it applies to both sidecars alike.
  nel:
    "it has no glyph, so neither it nor its effect can be seen in the text it came from, and at the " +
    "cue-grouping ceiling its one extra character splits a caption into two cues (MEASURED: one cue became two, " +
    "the second holding a single word). It adds no line — MEASURED in Chromium, in ffmpeg and in srt-parser-2 " +
    "alike",
};

/** Every reason this narration cannot become a cue, in reporting order. Empty when it can. */
export function narrationCueProblems(text) {
  if (typeof text !== "string") return [];
  const out = [];
  if (text.includes(CUE_ARROW)) out.push("arrow");
  if (text.includes(CUE_NEL)) out.push("nel");
  return out;
}

/**
 * Would voice.mjs (S3) accept this timeline's segments? null when it would; otherwise the
 * first refusal, as `{fact, then?, declaration?}`, from these checks in this order: the
 * segments' shape, every silence declaration, the narration text, whether any segment is
 * narrated, and an enabled end card's builderVersion and outro length. voice.mjs makes exactly
 * these checks, by calling this, before it builds its write set, in its plan and under --apply;
 * voiceBlocker makes them before it asks about that write set. So the stage and its gate cannot
 * disagree about any of them. It judges a timing object already parsed: voice.mjs calls it
 * after parsing its arguments, reading timing.json, and checking its intake, its end-card
 * decision and its brand voice allow-list.
 */
export function voiceTimelineBlocker(timing, labelOf = defaultLabel) {
  const shape = shapeBlocker(timing);
  if (shape) return shape;
  const segs = timing.segments;
  const declaration = declarationBlocker(segs, labelOf);
  if (declaration) return declaration;
  const mute = segs.findIndex(
    (s) => !isSilentSegment(s) && String(s.voiceoverText ?? "").trim() === "",
  );
  if (mute !== -1) {
    return {
      fact: `${labelOf(segs[mute], mute)} is narrated but has no narration text, which the TTS service cannot synthesise`,
      then: `write its narration, or, if it is meant to be silent, ${declareSilentRemedy(segs[mute])}`,
    };
  }
  // BEFORE A SINGLE TTS CALL. Narration that cannot become a cue is refused by
  // write-subtitles (S10) at the end of the pipeline, which meant an author paid to
  // synthesise every segment first — MEASURED at 3 of 3 segments synthesised, exit 0, for
  // narration S10 would later refuse. The rule itself is narrationCueProblems', called
  // rather than restated, so this gate and S10 cannot drift about what is refused.
  //
  // NARRATION ONLY. S10 additionally refuses all seven mandatory line breaks in a MEASURED
  // WORD; that half cannot move here, because measured words do not exist until voice.mjs
  // has run. The two reaches are different on purpose.
  for (const [i, s] of segs.entries()) {
    if (isSilentSegment(s)) continue;
    const [kind] = narrationCueProblems(s.voiceoverText);
    if (!kind) continue;
    const named = kind === "arrow" ? `"${CUE_ARROW}"` : `a line break (U+0085)`;
    return {
      fact:
        `${labelOf(s, i)} is narrated but its narration contains ${named}, which is written into both subtitle ` +
        `sidecars as cue text, where ${CUE_HARM[kind]}`,
      then: `write the narration without it`,
    };
  }
  if (segs.every(isSilentSegment)) {
    // Carries a remedy, like every other refusal in this gate — renderBlocker prints the fact
    // ALONE when `then` is absent, so this reached the author as a problem with no way out.
    //
    // CONDITIONAL, because the obvious remedy is a LOOP, and NEITHER half of it was true as
    // first written. Three things were measured by running the suggested edit back through
    // the gate rather than reasoning about it:
    //
    //   - "write narration for at least one segment" does NOT clear this refusal.
    //     isSilentSegment is "has a `silence` key", so narration alone lands on the next gate:
    //     `segment "one" is declared silent but carries narration text`. The declaration has
    //     to go too. A remedy that produces a different refusal is not a remedy.
    //   - remix.mjs arranges a wholly silent timeline from its authored windows without
    //     synthesising — but only for clips that EXIST. `hasAudioFile` tests the string in the
    //     timeline, not the file on disk, and remix refuses `segment_01.mp3 is not in the
    //     project` for a record naming an absent clip. So the offer carries its precondition
    //     instead of promising a run that can bounce.
    //   - with records on SOME segments, "no segment has one" is false, and a false reason
    //     invites the reader to disbelieve the true part of the message.
    //
    // `hasAudioFile` reads the timing object, so the branches are told apart from data already
    // in hand, with no filesystem access from a gate that must not have one.
    const everyClipRecorded = segs.every(hasAudioFile);
    return {
      fact: "every segment is declared silent, so voice.mjs has no narration to synthesise or calibrate from",
      then: everyClipRecorded
        ? "add narration to at least one segment and remove its silence declaration, or, if every clip the timeline names is still in the project, run remix.mjs (S4), which arranges a wholly silent timeline from its authored windows without synthesising anything"
        : "add narration to at least one segment and remove its silence declaration — remix.mjs (S4) cannot stand in here, because it re-measures only clips that already exist and not every segment has one",
    };
  }
  // Last, so a timeline already refused for its segments keeps reporting that reason.
  return endCardBlocker(timing);
}

/**
 * Would voice.mjs (S3) run on this timeline? null when this model finds nothing to stop it;
 * otherwise the first refusal this model finds, as `{fact, then?, declaration?}`: first
 * voiceTimelineBlocker's, then the files voice writes, resolved as voice resolves them before
 * its plan. voice.mjs makes the same two checks, in the same order, before it writes anything.
 * The rest it checks itself, and this model does not: before them, its intake, its end-card
 * decision and the brand voice allow-list; after them, under --apply, the replace guard, so
 * this model answers for a run given --replace; and from synthesis on, the TTS service, the
 * per-segment fit (C-10), the lead-in and gap pauses' solved lengths and the drift check (C-6).
 * An enabled end card's builderVersion and outro length are NOT in that list: they are the
 * timeline's own, knowable before anything is written, so voiceTimelineBlocker judges them and
 * this model answers for them too.
 */
export function voiceBlocker(dir, timing, labelOf = defaultLabel) {
  return (
    voiceTimelineBlocker(timing, labelOf) ??
    writeSetBlocker(dir, voiceWriteSet(timing)).blocker ??
    null
  );
}

/**
 * Would remix.mjs (S4) run on this timeline? null when this model finds nothing to stop it;
 * otherwise the first refusal this model finds, as `{fact, then?, declaration?}`, in remix's
 * own order: the timeline's shape, then every silence declaration, both of which remix.mjs
 * checks before anything else it asks of its segments, then the rest. `cleared` and `nested`
 * are for a remedy asking what remix would do once a narration has a file of its own.
 */
export function remixBlocker(
  dir,
  timing,
  labelOf = defaultLabel,
  { cleared = [], nested = false } = {},
) {
  const shape = shapeBlocker(timing);
  if (shape) return shape;
  const segs = timing.segments;
  const declaration = declarationBlocker(segs, labelOf);
  if (declaration) return declaration;
  const unvoiced = segs.findIndex(
    (s) =>
      !isSilentSegment(s) &&
      hasAudioFile(s) &&
      !cleared.includes(s) &&
      !(Array.isArray(s.audio.words) && s.audio.words.length > 0),
  );
  if (unvoiced !== -1) {
    const s = segs[unvoiced];
    return {
      fact: unvoicedNarrationFact(s, labelOf(s, unvoiced)),
      then: unvoicedNarrationRemedy(dir, timing, s, labelOf),
    };
  }
  const set = writeSetBlocker(dir, remixWriteSet(timing));
  if (set.blocker) return set.blocker;
  try {
    const collision = remixCollisionBlocker(
      dir,
      timing,
      labelOf,
      set.resolved,
      { cleared, nested },
    );
    if (collision) return collision;
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    return { fact: trimFact(err.message) };
  }
  for (const [i, s] of segs.entries()) {
    if (cleared.includes(s)) continue;
    const where = labelOf(s, i);
    if (!hasAudioFile(s)) {
      return {
        fact: `${where} has no audio.file, and remix re-measures only clips that exist`,
        then: gatedRemedy(
          voiceBlocker(dir, timing, labelOf),
          {
            open: "run voice.mjs (S3), which generates its clip and writes its record",
            stem: "voice.mjs (S3) generates its clip and writes its record",
          },
          { factOnly: true },
        ),
      };
    }
    let clip;
    try {
      clip = resolveWithinRoot(dir, s.audio.file, `segment ${s.id} audio`);
      if (pathExists(clip, `segment ${s.id} audio`)) continue;
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      return clip === undefined
        ? {
            fact: trimFact(err.message),
            then: `point ${where}'s audio.file at a file inside the project`,
          }
        : { fact: trimFact(err.message) };
    }
    const file = s.audio.file;
    const voice = gatedRemedy(
      voiceBlocker(dir, timing, labelOf),
      {
        open: "run voice.mjs (S3), which generates every clip and writes every record",
        stem: "voice.mjs (S3) generates every clip and writes every record",
      },
      { factOnly: true },
    );
    return {
      fact: `${file} is not in the project, and ${where} names it as its clip`,
      then: isSilentSegment(s)
        ? `restore ${file} (remix does not read it, but requires the file a record names to exist), or ${voice}`
        : `restore ${file}, or ${voice}`,
    };
  }
  return null;
}

// ---- how a remedy names a stage ---------------------------------------------------------------

const trimFact = (s) => String(s).replace(/\.\s*$/, "");

/** Capitalises a clause that starts a sentence, unless it starts with a file name. */
export const startSentence = (s) =>
  /^[a-z]+\b(?!\.)/.test(s) ? s[0].toUpperCase() + s.slice(1) : s;

const malformedDeclaration = (fact) =>
  `a malformed silence declaration is reported here instead: ${trimFact(fact)}`;

/** The edit that declares a segment silent in a form every stage accepts. */
export function declareSilentRemedy(seg) {
  const windowMs = silentDurationMs(seg);
  return (
    "declare it silent (a `silence` block with a caption, and no narration text)" +
    (Number.isFinite(windowMs) && windowMs > 0
      ? ""
      : "; its window, endMs - startMs, must also be a positive number of milliseconds")
  );
}

/**
 * A gate's refusal as text: the fact, then the edit that clears it — or the fact alone,
 * where the caller only says why a stage would refuse.
 */
export function renderBlocker(b, { factOnly = false } = {}) {
  if (b.declaration) return malformedDeclaration(b.fact);
  const fact = trimFact(b.fact);
  return factOnly || !b.then ? fact : `${fact}. ${startSentence(b.then)}`;
}

/**
 * A remedy that names a stage: `open`, the step, while the stage would run; where the gate
 * found a malformed silence declaration, that declaration, reported instead of naming the
 * stage; otherwise `stem` — what the stage would do — with why it refuses this timeline as
 * it stands.
 */
export function gatedRemedy(b, { open, stem }, opts) {
  if (b === null) return open;
  if (b.declaration) return malformedDeclaration(b.fact);
  return `${stem}, but it refuses this timeline as it stands: ${renderBlocker(b, opts)}`;
}

/** A sentence saying `stage` refuses this timeline as it stands, and why. */
export function stageRefusal(stage, b) {
  if (b.declaration) return startSentence(malformedDeclaration(b.fact));
  return `${stage} refuses this timeline as it stands: ${renderBlocker(b)}`;
}
