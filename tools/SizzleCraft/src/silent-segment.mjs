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
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CliError, EXIT, assertDistinctDestinations, createBoundary, pathExists, resolveEngineOutput, resolveWithinRoot,
} from './cli-support.mjs';

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

// The range silence-gen.mjs accepts for --ms: a plain positive decimal, at most an hour.
const PAUSE_TEXT = /^(?:\d+|\d*\.\d+)$/;
const PAUSE_MAX_MS = 3_600_000;

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
  if (!PAUSE_TEXT.test(text) || !(value > 0) || value > PAUSE_MAX_MS) {
    throw new CliError(
      `${name}: the solved pause is ${text}ms — a pause asset must be a plain number of milliseconds ` +
      `above 0 and at most ${PAUSE_MAX_MS}. Check the timeline's lead-in, gap and outro values.`,
      EXIT.FAILED);
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
  return seg !== null && typeof seg === 'object' && Object.hasOwn(seg, 'silence');
}

/** The authored duration of a silent segment: its window, and nothing else. */
export function silentDurationMs(seg) {
  return Number(seg.endMs) - Number(seg.startMs);
}

/**
 * Does this segment's audio record name a clip?
 *
 * voice.mjs names one for every segment it runs for, silent ones included. remix.mjs
 * re-measures only clips that exist, so it refuses a segment whose record names none,
 * and a remedy that sends someone to remix has to ask this first.
 */
export function hasAudioFile(seg) {
  return typeof seg?.audio?.file === 'string' && seg.audio.file.trim() !== '';
}

// What a record value is, for a diagnostic that describes a file's shape and never quotes
// its content: a number is shown, anything else is named by its type.
const kindOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'number' ? String(v)
  : typeof v === 'object' ? 'an object' : `a ${typeof v}`);

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
  if (audio === undefined) return { state: 'absent' };
  if (audio === null || typeof audio !== 'object' || Array.isArray(audio)) {
    return { state: 'unusable', why: `its audio record is ${kindOf(audio)}, not an object` };
  }
  const recordedMs = audio.durationMs;
  if (recordedMs === undefined) return { state: 'unusable', why: 'its audio record has no durationMs' };
  if (typeof recordedMs !== 'number' || !Number.isFinite(recordedMs) || recordedMs < 0) {
    return {
      state: 'unusable',
      why: `its audio record's durationMs is ${kindOf(recordedMs)}, not a finite number of milliseconds >= 0`,
    };
  }
  return { state: silentDurationMs(seg) === recordedMs ? 'matches' : 'differs', recordedMs };
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
  if (declaration) return `${lead}, but ${malformedDeclaration(declaration.fact)}`;
  const last = segs[lastIndex];
  if (isSilentSegment(last)) {
    const where = labelOf(last, lastIndex);
    if (!hasAudioFile(last)) {
      if (segs.every(isSilentSegment)) {
        // voice.mjs has no narration to synthesise, and remix refuses this record.
        return `${lead}, and ${where} is declared silent but no audio.file names its clip, and every segment is ` +
          "declared silent, so no stage measures the timeline: set timing.durationMs by hand, no shorter than the last " +
          "segment's end";
      }
      return `${lead}, and ${where} is declared silent but no audio.file names its clip, so the voice stage has not run ` +
        `for it: ${gatedRemedy(voiceBlocker(dir, timing, labelOf), {
          open: 'run voice.mjs (S3), which generates its clip and re-measures the timeline',
          stem: 'voice.mjs (S3) generates its clip and re-measures the timeline',
        })}`;
    }
    return `${lead}, and ${where} is declared silent, so its window is a silence edit: ${remixReflowRemedy(dir, timing, labelOf)}`;
  }
  const edited = segs.findIndex((s) => isSilentSegment(s) && hasAudioFile(s) &&
    ['differs', 'unusable'].includes(silentRecordState(s).state));
  if (edited !== -1) {
    const record = silentRecordState(segs[edited]);
    const found = record.state === 'differs'
      ? ' and its window no longer holds the silence its record describes, so the change is a silence edit'
      : `, but ${record.why}, so nothing shows its window still holds the silence generated for it`;
    return `${lead}, and ${labelOf(segs[edited], edited)} is declared silent${found}: ` +
      remixReflowRemedy(dir, timing, labelOf);
  }
  return `${lead}; ${gatedRemedy(voiceBlocker(dir, timing, labelOf), {
    open: 'run voice.mjs (S3) to measure it',
    stem: 'voice.mjs (S3) measures it',
  })}`;
}

const remixReflowRemedy = (dir, timing, labelOf) => gatedRemedy(remixBlocker(dir, timing, labelOf), {
  open: 'run remix.mjs (S4), which regenerates that silence and reflows the timeline onto it, with no re-voice',
  stem: 'remix.mjs (S4) regenerates that silence and reflows the timeline onto it, with no re-voice',
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
  if (voice.declaration) return `${lead}, but ${malformedDeclaration(voice.fact)}`;
  if (Array.isArray(timing.segments) && timing.segments.every(isSilentSegment)) {
    const remix = remixBlocker(dir, timing, labelOf);
    if (remix === null) {
      return `${lead}; every segment is declared silent, so there is no narration to measure: run remix.mjs (S4), ` +
        'which generates the silence and measures the timeline, with no re-voice';
    }
    return `${lead}; every segment is declared silent, so there is no narration to measure, and remix.mjs (S4) ` +
      `refuses this timeline as it stands: ${renderBlocker(remix, { factOnly: true })}; set timing.durationMs by hand, ` +
      "no shorter than the last segment's end";
  }
  return `${lead}; ${gatedRemedy(voice, { stem: 'voice.mjs (S3/S4) measures it' })}`;
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
export function silentWindowFieldProblem({ dir, timing, index, field, fields, shown, labelOf }) {
  const seg = timing.segments[index];
  const both = fields.includes('startMs') && fields.includes('endMs');
  let bound;
  let corrected;
  if (both) {
    bound = field === 'startMs' ? ' and less than endMs' : ' and greater than startMs';
    corrected = { startMs: 0, endMs: 1 };
  } else if (field === 'startMs' && seg.endMs > 0) {
    bound = ` and less than endMs (${seg.endMs})`;
    corrected = { startMs: 0 };
  } else if (field === 'startMs') {
    bound = `. endMs (${seg.endMs}) must change too: no startMs >= 0 gives a window that ends at ${seg.endMs} a positive ` +
      'length, so write endMs as a number of milliseconds greater than startMs';
    corrected = { startMs: 0, endMs: 1 };
  } else {
    bound = ` and greater than startMs (${seg.startMs})`;
    corrected = { endMs: seg.startMs + 1 };
  }
  const text = `${labelOf(seg, index)} is declared silent, so its window is authored, not measured: ${field} is ${shown} ` +
    `— write it as a number of milliseconds, >= 0${bound}`;
  const after = Object.keys(corrected).length > 1 ? 'Once both are corrected, if' : 'If';
  const hypothetical = structuredClone(timing);
  Object.assign(hypothetical.segments[index], corrected);
  const b = remixBlocker(dir, hypothetical, labelOf);
  if (b === null) return `${text}. ${after} that changes the window's length, remix.mjs (S4) reflows the timeline onto it, with no re-voice`;
  if (b.declaration) return `${text}. ${startSentence(malformedDeclaration(b.fact))}`;
  return `${text}. ${after} that changes the window's length, remix.mjs (S4) is the stage that reflows the timeline onto it, ` +
    `with no re-voice, but it would refuse this timeline even then: ${renderBlocker(b, { factOnly: true })}`;
}

/**
 * The remedy for a NARRATED segment's startMs or endMs that is not a number: voice.mjs
 * measures narrated windows. Named as a step only where it would run.
 */
export function narratedWindowFieldRemedy(dir, timing, labelOf) {
  const b = voiceBlocker(dir, timing, labelOf);
  return b === null ? 'Run voice.mjs (S3/S4) first' : startSentence(gatedRemedy(b, { stem: 'voice.mjs (S3/S4) measures it' }));
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
export function unvoicedNarrationProblem(seg, where = `segment "${seg?.id}"`, dir, timing, labelOf = defaultLabel) {
  const words = seg?.audio?.words;
  if (Array.isArray(words) && words.length > 0) return null;
  return `${renderBlocker({ fact: unvoicedNarrationFact(seg, where), then: unvoicedNarrationRemedy(dir, timing, seg, labelOf) })}.`;
}

function unvoicedNarrationFact(seg, where) {
  const words = seg?.audio?.words;
  const held = Array.isArray(words) ? 'an empty word list' : words === undefined ? 'no word list' : 'a word list that is not a list';
  return `${where} is narrated, but its audio record holds ${held} — so its clip is not narration voice.mjs produced ` +
    'for it (a segment declared silent when voice ran gets generated silence)';
}

function unvoicedNarrationRemedy(dir, timing, seg, labelOf) {
  return 'arranging existing audio cannot create speech: ' + gatedRemedy(voiceBlocker(dir, timing, labelOf), {
    open: `run voice.mjs (S3) to synthesise it, or, if it is meant to be silent, ${declareSilentRemedy(seg)}`,
    stem: 'voice.mjs (S3) synthesises it',
  });
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
    // saves the author from debugging their calibration file. Removing a declaration alone
    // would leave a narrated segment with no text, which the TTS service cannot synthesise,
    // so the edit offered gives that segment its narration too.
    throw new CliError(
      'every segment is declared silent, so there is no speech to calibrate a word rate from — ' +
      'a project with no narration does not need the voice stage. Give a segment its narration text and remove ' +
      'its `silence` declaration, or skip this stage.');
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

const pad2 = (n) => String(n).padStart(2, '0');

/** The name voice.mjs gives segment i's clip, and remix.mjs a declared silent one's. */
export const segmentClipName = (i) => `segment_${pad2(i + 1)}.mp3`;

/** The pause asset inserted AFTER segment i. */
export const gapAssetName = (i) => `gap_${pad2(i + 1)}.mp3`;

const defaultLabel = (s, i) => `segment "${s?.id ?? i}"`;

// The pause assets a stage can write: a seam touching a declared silent segment never gets
// a pause, and a silent first segment never gets a lead-in, whatever the solve.
function pauseSet(segs, withOutro) {
  return [
    ...(isSilentSegment(segs[0]) ? [] : [{ key: 'lead.mp3', solved: 'a lead-in' }]),
    ...segs.slice(0, -1).flatMap((s, i) => (isSilentSegment(s) || isSilentSegment(segs[i + 1]) ? []
      : [{ key: gapAssetName(i), solved: `a pause after segment "${s.id}"` }])),
    ...(withOutro ? [{ key: 'outro.mp3', solved: null }] : []),
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
    ...segs.map((seg, i) => ({ key: segmentClipName(i), label: `segment ${seg.id} output`, append: false })),
    ...pauseSet(segs, timing.endCard?.enabled && Number(timing.outroMs) > 0)
      .map((o) => ({ ...o, label: o.key, append: false })),
    { key: 'voiceover.mp3', label: 'voiceover.mp3', append: false },
    { key: 'timing.json', label: 'timing.json', append: false },
    { key: 'calibration-observed.json', label: 'calibration-observed.json', append: false },
    { key: 'sync-mapping.md', label: 'sync-mapping.md', append: false },
    // Appended to on a synthesis retry, so it carries no --replace requirement — but it is
    // still a write, and still an engine-chosen name.
    { key: 'heal-log.txt', label: 'heal-log.txt', append: true },
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
    { key: 'voiceover.mp3', label: 'voiceover.mp3' },
    { key: 'timing.json', label: 'timing.json' },
    ...segs.flatMap((s, i) => (isSilentSegment(s) ? [{ key: segmentClipName(i), label: `segment ${s.id} output`, silent: s }] : [])),
    // Listed unless the duration is known to write nothing, so a malformed outroMs is
    // refused by the generator rather than skipped, as it always has been in remix. The
    // end-card test is the one its write applies, so the two cannot disagree about the file.
    ...pauseSet(segs, timing.endCard?.enabled && !(Number(timing.outroMs) <= 0)).map((o) => ({ ...o, label: o.key })),
  ];
}

// A stage's write set resolved the way the stage resolves it before its plan — a link
// refused, a directory refused, every destination distinct — or the stage's refusal. The
// replace guard is the stage's own opt-in, so it is not a refusal here.
function writeSetBlocker(dir, set) {
  try {
    const resolved = set.map((o) => ({
      ...o,
      path: resolveEngineOutput(dir, o.key, { apply: false, replace: true, label: o.label }),
    }));
    assertDistinctDestinations(resolved.map(({ key, path }) => ({ key, path })), 'output');
    return { resolved };
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    return { blocker: { fact: trimFact(err.message) } };
  }
}

// ---- what remix must not write over --------------------------------------------------------

// A record's clip, resolved the way remix resolves it; null where that refuses.
function recordedClipPath(dir, seg) {
  try { return resolveWithinRoot(dir, seg.audio.file, `segment ${seg.id} audio`); } catch { return null; }
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
      `${label}: could not inspect ${p} (${err.code ?? err.message}) — refusing rather than assuming it is not a narrated clip`);
  }
  return { exists: st !== undefined, id: st === undefined || st.ino === 0n ? null : st, name };
}
/** Whether two bigint stats are one file: the same inode, on the same volume where both report one. */
export const sameIdentity = (a, b) => a !== null && b !== null && a.ino === b.ino && (a.dev === 0n || b.dev === 0n || a.dev === b.dev);
/** Whether two paths are spelled as one name, as the platform compares names. */
export const sameName = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
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
    if (err?.code === 'ENOENT') return p;
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
    .filter(({ s }) => !isSilentSegment(s) && hasAudioFile(s) && !cleared.includes(s))
    .map((n) => ({ ...n, path: recordedClipPath(dir, n.s) }))
    .filter((n) => n.path !== null)
    .map((n) => ({ ...n, ...identityOf(n.path, `segment ${n.s.id} audio`) }));
  for (const o of resolved) {
    const { id, name } = identityOf(o.path, o.label);
    const owner = owners.find((n) => sameName(n.path, o.path) || sameName(n.name, name) || sameIdentity(n.id, id));
    if (owner) {
      const kind = sameName(owner.path, o.path) ? 'name' : sameName(owner.name, name) ? 'canonical' : 'identity';
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
export function remixCollisionBlocker(dir, timing, labelOf, resolved, { cleared = [], nested = false } = {}) {
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
  let via = '';
  if (!sameName(spelled(file), owner.path)) {
    let link = false;
    try {
      link = fs.lstatSync(spelled(file), { throwIfNoEntry: false })?.isSymbolicLink() === true;
    } catch {
      // Not inspected, so not shown to be the link itself; a link on the way was followed.
    }
    via = link ? `, a link to ${read}` : `, which leads through a link to ${read}`;
  }
  const silent = o.silent ? labelOf(o.silent, segs.indexOf(o.silent)) : null;
  let fact;
  if (o.silent && kind === 'name') {
    // A silent segment's clip name is positional, and a narrated record names that file:
    // the timeline was reordered after voice ran, or two records named one clip.
    fact = `${silent} is declared silent, so remix regenerates its clip as ${o.key}, the name that belongs to its ` +
      `position in the timeline, and narrated ${narrated}'s record names ${via ? `${file}${via}` : 'that file'}` +
      (owner.exists ? '. Writing the silence would destroy that narration'
        : ', which is not in the project: the silence would be written where its record expects its narration');
  } else if (kind === 'identity') {
    // Another entry for the narration's file. Publishing by rename replaces the entry remix
    // writes and leaves this one holding the narration; remix refuses it all the same.
    const holder = via ? read : file;
    fact = `remix writes ${o.key}, and ${o.key} is a hard link of ${holder}, which narrated ${narrated} is read from` +
      (via ? `: its record names ${file}${via}` : '') +
      `. Publishing ${o.key} by rename would leave ${holder} holding that narration, but remix never writes a ` +
      'narrated clip it reads, under any name';
  } else {
    fact = `remix writes ${o.key}, and ${narrated} is narrated and its record names ` +
      (kind === 'canonical' ? `${file}${via}, another name for ${o.key}` : via ? `${file}${via}` : 'that file') +
      (owner.exists ? '. Writing it would destroy that narration'
        : `, which is not in the project: ${o.key} would be written where its record expects its narration`);
  }
  let next = null;
  if (!nested) {
    try {
      next = remixBlocker(dir, timing, labelOf, { cleared: [...cleared, owner.s], nested: true });
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      next = { fact: trimFact(err.message) };
    }
  }
  if (!owner.exists) {
    let then = `restore ${narrated}'s narration under a name remix does not write and point its audio.file there, or ` +
      gatedRemedy(voiceBlocker(dir, timing, labelOf), {
        open: 'run voice.mjs (S3), which synthesises it and names every clip by its position',
        stem: 'voice.mjs (S3) synthesises it',
      }, { factOnly: true });
    if (next !== null) then += `. After restoring it, remix would still refuse this timeline: ${renderBlocker(next, { factOnly: true })}`;
    return { fact, then };
  }
  const keeper = segs.findIndex((s) => isSilentSegment(s) && hasAudioFile(s) && recordedClipPath(dir, s) !== null &&
    sameName(spelled(s.audio.file), spelled(file)));
  let then = `give the narration a file of its own: copy ${file} under a name remix does not write and point ` +
    `${narrated}'s audio.file at the copy` +
    (keeper === -1 ? '' : `, and leave ${file} where it is — ${labelOf(segs[keeper], keeper)}'s record names it, and ` +
      'remix requires the file a record names to exist');
  if (!nested) {
    then += next === null
      ? `. Then run remix.mjs --apply --replace: --replace because ${o.key} is still there, and this run overwrites it` +
        (silent ? ` with ${silent}'s silence` : o.solved ? ` if the solve inserts ${o.solved}` : '')
      : `. Even then, remix would refuse this timeline: ${renderBlocker(next, { factOnly: true })}`;
  }
  return { fact, then };
}

// ---- the gates ------------------------------------------------------------------------------

function shapeBlocker(timing) {
  const segs = timing?.segments;
  if (!Array.isArray(segs) || segs.length === 0) return { fact: 'timing.json declares no segments' };
  const bad = segs.findIndex((s) => s === null || typeof s !== 'object' || Array.isArray(s));
  return bad === -1 ? null : { fact: `timing.segments[${bad}] is not a segment object` };
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
 * Would voice.mjs (S3) accept this timeline's segments? null when it would; otherwise the
 * first refusal, as `{fact, then?, declaration?}`, from these checks in this order: the
 * segments' shape, every silence declaration, the narration text, and whether any segment is
 * narrated. voice.mjs makes exactly these checks, by calling this, before it builds its write
 * set, in its plan and under --apply; voiceBlocker makes them before it asks about that write
 * set. So the stage and its gate cannot disagree about any of them. It judges a timing object
 * already parsed: voice.mjs calls it after parsing its arguments, reading timing.json, and
 * checking its intake, its end-card decision and its brand voice allow-list.
 */
export function voiceTimelineBlocker(timing, labelOf = defaultLabel) {
  const shape = shapeBlocker(timing);
  if (shape) return shape;
  const segs = timing.segments;
  const declaration = declarationBlocker(segs, labelOf);
  if (declaration) return declaration;
  const mute = segs.findIndex((s) => !isSilentSegment(s) && String(s.voiceoverText ?? '').trim() === '');
  if (mute !== -1) {
    return {
      fact: `${labelOf(segs[mute], mute)} is narrated but has no narration text, which the TTS service cannot synthesise`,
      then: `write its narration, or, if it is meant to be silent, ${declareSilentRemedy(segs[mute])}`,
    };
  }
  if (segs.every(isSilentSegment)) {
    return { fact: 'every segment is declared silent, so voice.mjs has no narration to synthesise or calibrate from' };
  }
  return null;
}

/**
 * Would voice.mjs (S3) run on this timeline? null when this model finds nothing to stop it;
 * otherwise the first refusal this model finds, as `{fact, then?, declaration?}`: first
 * voiceTimelineBlocker's, then the files voice writes, resolved as voice resolves them before
 * its plan. voice.mjs makes the same two checks, in the same order, before it writes anything.
 * The rest it checks itself, and this model does not: before them, its intake, its end-card
 * decision and the brand voice allow-list; after them, under --apply, the replace guard, so
 * this model answers for a run given --replace; and from synthesis on, the TTS service, the
 * per-segment fit (C-10), the pause assets' lengths, an enabled end card's builderVersion and
 * the drift check (C-6).
 */
export function voiceBlocker(dir, timing, labelOf = defaultLabel) {
  return voiceTimelineBlocker(timing, labelOf) ?? writeSetBlocker(dir, voiceWriteSet(timing)).blocker ?? null;
}

/**
 * Would remix.mjs (S4) run on this timeline? null when this model finds nothing to stop it;
 * otherwise the first refusal this model finds, as `{fact, then?, declaration?}`, in remix's
 * own order after the timeline's shape, which remix does not check. `cleared` and `nested`
 * are for a remedy asking what remix would do once a narration has a file of its own.
 */
export function remixBlocker(dir, timing, labelOf = defaultLabel, { cleared = [], nested = false } = {}) {
  const shape = shapeBlocker(timing);
  if (shape) return shape;
  const segs = timing.segments;
  const declaration = declarationBlocker(segs, labelOf);
  if (declaration) return declaration;
  const unvoiced = segs.findIndex((s) => !isSilentSegment(s) && hasAudioFile(s) && !cleared.includes(s) &&
    !(Array.isArray(s.audio.words) && s.audio.words.length > 0));
  if (unvoiced !== -1) {
    const s = segs[unvoiced];
    return { fact: unvoicedNarrationFact(s, labelOf(s, unvoiced)), then: unvoicedNarrationRemedy(dir, timing, s, labelOf) };
  }
  const set = writeSetBlocker(dir, remixWriteSet(timing));
  if (set.blocker) return set.blocker;
  try {
    const collision = remixCollisionBlocker(dir, timing, labelOf, set.resolved, { cleared, nested });
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
        then: gatedRemedy(voiceBlocker(dir, timing, labelOf), {
          open: 'run voice.mjs (S3), which generates its clip and writes its record',
          stem: 'voice.mjs (S3) generates its clip and writes its record',
        }, { factOnly: true }),
      };
    }
    let clip;
    try {
      clip = resolveWithinRoot(dir, s.audio.file, `segment ${s.id} audio`);
      if (pathExists(clip, `segment ${s.id} audio`)) continue;
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      return clip === undefined
        ? { fact: trimFact(err.message), then: `point ${where}'s audio.file at a file inside the project` }
        : { fact: trimFact(err.message) };
    }
    const file = s.audio.file;
    const voice = gatedRemedy(voiceBlocker(dir, timing, labelOf), {
      open: 'run voice.mjs (S3), which generates every clip and writes every record',
      stem: 'voice.mjs (S3) generates every clip and writes every record',
    }, { factOnly: true });
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

const trimFact = (s) => String(s).replace(/\.\s*$/, '');

/** Capitalises a clause that starts a sentence, unless it starts with a file name. */
export const startSentence = (s) => (/^[a-z]+\b(?!\.)/.test(s) ? s[0].toUpperCase() + s.slice(1) : s);

const malformedDeclaration = (fact) =>
  `a malformed silence declaration is reported here instead: ${trimFact(fact)}`;

/** The edit that declares a segment silent in a form every stage accepts. */
export function declareSilentRemedy(seg) {
  const windowMs = silentDurationMs(seg);
  return 'declare it silent (a `silence` block with a caption, and no narration text)' +
    (Number.isFinite(windowMs) && windowMs > 0 ? '' : '; its window, endMs - startMs, must also be a positive number of milliseconds');
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
