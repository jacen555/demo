/*
 * Reads RMS/peak levels out of one ffmpeg `astats` run, and says which of THREE things
 * happened: the window was MEASURED, the window was SILENT, or it could not be measured.
 * It also owns the ONE condition those levels are JUDGED against — see
 * judgeDeliveredLevels, which records the bound that was withdrawn after measuring it.
 *
 * The rule lives here rather than inside check-levels.mjs so it can be tested without an
 * ffmpeg binary — the same reason end-card.mjs lives apart from voice.mjs. The gate was
 * put here for that same reason and for one more: its correctness IS the silence
 * distinction below, so the two belong where they can be read against each other.
 *
 * ## Why silence is a state and not a failure
 *
 * astats reports digital silence as `-inf`:
 *
 *     Peak level dB: -inf
 *     RMS level dB: -inf
 *
 * The first version guarded with `Number.isFinite` and reported anything else as "the
 * file may have no audio track". This pipeline INSERTS ~2s of deliberate lead-in silence
 * before speech, so the lead-in window of every correct narration-only render measured
 * `-inf`, failed the guard, and exited 1 naming a cause that was false — the file had a
 * perfectly good AAC track. `-inf` is an in-band sentinel colliding with real data: the
 * same shape as the `null`/`ENOENT` collapse one layer down, where the domain's
 * legitimate extreme gets read as an error value. Digital silence IS `-inf`.
 *
 * That is worse than a wrong message. This is the last gate before delivery — the check
 * that exists to catch a music bed shipped ~10 dB hot when every narration-silent-window
 * check was green — so it exited 1 on good artefacts, any pipeline gating on it failed,
 * and its reader learned to read past the red line. A gate that cries wolf is the habit
 * that lets a real alarm through.
 *
 * ## Why "no audio track" has to be checked
 *
 * A missing number never implied a missing track; it was inferred from one. The stream
 * declaration is already in the same ffmpeg output, so the claim costs nothing to CHECK
 * and is never made without checking.
 */

/**
 * `RMS level dB: -21.06` -> `"-21.06"`. The LAST match wins: astats prints a block per
 * channel and then an `Overall` block, and Overall is the one being reported.
 *
 * The token is captured as `\S+` rather than as a number on purpose. Capturing digits
 * only meant `-inf` did not match AT ALL, so a silent Overall block fell through to
 * whatever earlier numeric line happened to be last — reporting a measurement of a
 * different window than the one asked for.
 */
function lastToken(output, key) {
  const matches = [...String(output ?? '').matchAll(new RegExp(`${key}:\\s*(\\S+)`, 'g'))];
  return matches.length ? matches[matches.length - 1][1] : null;
}

/** A level token is a number, digital silence, or unreadable. Nothing else. */
function readLevel(token) {
  if (token === null) return { kind: 'absent' };
  if (/^-(?:inf|infinity)$/i.test(token)) return { kind: 'silent', db: -Infinity };
  const db = Number(token);
  return Number.isFinite(db) ? { kind: 'level', db } : { kind: 'unreadable', token };
}

/**
 * Classifies one ffmpeg run's astats output.
 *
 * `RMS trough dB` and `Noise floor dB` are `-inf` in almost every real astats block, loud
 * audio included — so "is `-inf` present in the output" is NOT a test for silence. Only
 * the two Overall rails below are consulted.
 *
 * @returns {{state: 'measured'|'silent', rms: number, peak: number}
 *          | {state: 'unmeasurable', detail: string}}
 */
export function readAstatsLevels(output) {
  const fields = [
    ['RMS level dB', readLevel(lastToken(output, 'RMS level dB'))],
    ['Peak level dB', readLevel(lastToken(output, 'Peak level dB'))],
  ];

  const absent = fields.filter(([, v]) => v.kind === 'absent').map(([k]) => k);
  if (absent.length > 0) {
    return { state: 'unmeasurable', detail: `astats printed no "${absent.join('" line and no "')}" line` };
  }
  const unreadable = fields.find(([, v]) => v.kind === 'unreadable');
  if (unreadable) {
    return {
      state: 'unmeasurable',
      detail: `astats reported "${unreadable[0]}" as ${JSON.stringify(unreadable[1].token)}, which is not a level`,
    };
  }

  const [[, rms], [, peak]] = fields;
  // Both rails at -inf is digital silence. A mixed reading is still a reading — `-inf` is
  // a real level — so it is reported as measured rather than promoted to a failure.
  const state = rms.kind === 'silent' && peak.kind === 'silent' ? 'silent' : 'measured';
  return { state, rms: rms.db, peak: peak.db };
}

/**
 * Judges ONE measured window of a delivered render, and returns a refusal naming what it
 * measured — or `null` when the window is acceptable.
 *
 * ## Why a gate on the OUTPUT exists at all
 *
 * mix-parameters.mjs audits every number in the final `-filter_complex` string, and its
 * header lists seven things that audit cannot see: anything reaching ffmpeg OUTSIDE the
 * graph (`-b:a`, `-ar`, a changed codec or `-map`), any non-numeric change, a value inside
 * a link label, a value shaped like a filter identifier, a mis-set `pinned` flag,
 * deliberate circumvention, and two values moved within one chain. A reading of the
 * delivered file is taken DOWNSTREAM of all seven — it never looks at the graph — so it is
 * not blinded by any of them. That is a statement about where the reading is taken, NOT a
 * claim that it detects those defects: it detects the two outcomes below and nothing else,
 * and most of those seven can move a mix without producing either.
 *
 * ## THE ONE BOUND, AND THE ONE THAT WAS WITHDRAWN AFTER MEASURING IT
 *
 * **Refused: a WHOLE FILE that is digital silence, where audio was expected.** Not a
 * threshold — there is no number in it. A delivered render that measures `-inf` across its
 * whole length carries no audio at all, which is the wrong-`-map` / wrong-stream /
 * dropped-audio class.
 *
 * The qualifier is load-bearing, and it is there because a reviewer caught its absence.
 * README "concat-audio (S4)" documents a supported timeline in which EVERY segment is
 * deliberately silent — "no clip is matched to anything and each window is generated" — and
 * a render of that project is correctly silent from end to end. An unqualified rule would
 * refuse it, which is the lead-in regression repeated one level up. Whether audio was
 * expected cannot be read off the audio, so the CALLER declares it (`--allow-silent`); it
 * defaults to expected, because that is what every narrated project is.
 *
 * **Withdrawn: a peak above full scale.** This was built, and the reasoning for it looked
 * sound: remux-music.mjs:685 emits `alimiter=limit=<ceiling>:level=disabled` and
 * `--ceiling` is bounded 0.1..12 dB BELOW full scale, so every mix is clamped under the
 * rail before the encode; the README's own `--ceiling` table measured -0.3 dBTP at the
 * default; and an independent render of that graph shape measured -0.227 dBFS post-AAC
 * against +2.012 dBFS for the same material unlimited. Two measurements, both agreeing.
 *
 * Both were of the same benign signal. Sweeping the material instead, with the limiter
 * CORRECTLY IN FORCE (ffmpeg 9.0.2, `alimiter=limit=<ceiling>:level=disabled`, AAC 192k
 * 44.1 kHz, astats on the decoded result):
 *
 *   | material, limiter in force      | --ceiling 0.1 | --ceiling 1.0 | --ceiling 2.0 |
 *   |---------------------------------|---------------|---------------|---------------|
 *   | sine + pink noise               |  -0.26 dBFS   |  -0.68 dBFS   |  -1.91 dBFS   |
 *   | white noise                     |  +2.85 dBFS   |  +3.30 dBFS   |  +1.23 dBFS   |
 *   | square wave                     |  +4.49 dBFS   |               |               |
 *   | dense square + HF tone          |  +1.44 dBFS   |               |               |
 *
 * A CORRECT render at the DEFAULT ceiling measured +3.30 dBFS. AAC reconstruction
 * overshoots the sample peaks the limiter clamped, by an amount set by the material rather
 * than by the ceiling, and the overshoot is far larger than the headroom any supported
 * ceiling leaves. So "peak above full scale" is not a property of a BAD render; it is a
 * property of dense material through a lossy encoder, and gating on it would have refused
 * good work. The bound was removed rather than tuned: a threshold picked to sit above the
 * largest overshoot anyone happened to measure is exactly the number that gets loosened
 * until it stops complaining.
 *
 * Detecting clipping honestly needs a measurement this stage does not take — true peak on
 * the decoded output, or a comparison against the pre-encode bus — and that is named here
 * rather than approximated.
 *
 * ## There is deliberately NO RMS BAND either
 *
 * bug-ledger 16 is both the case for one and the argument against it: a gain of 1.50 is in
 * range for a generated bed at -43.1 dB RMS and for a licensed master at -11.4 dB, 31.7 dB
 * apart, and is right for one and 10 dB hot for the other. "Range validation and
 * calibration validation are different checks", and the ledger's own prescribed detection
 * is COMPARISON against a reference render, not a band. No defensible absolute band was
 * derivable, so none was invented.
 *
 * ## WHAT THIS DOES NOT DETECT
 *
 *   a. ANY defect that leaves some audio in the file. That is nearly all of them. A bed
 *      10 dB hot, a duck on the wrong words, a swapped track at the same loudness, a
 *      crossfade at the wrong wrap, a wrong sample rate or bitrate: every one of those
 *      delivers a file that is not silent, and every one passes here.
 *   b. the bug-ledger 16 incident itself — whole-file RMS -9.8 dB, a bed ~10 dB hot. It is
 *      not silent, so it passes. The ledger prescribes comparison against a reference
 *      render for exactly that reason, and that comparison does not exist yet.
 *   c. CLIPPING, for the measured reason above.
 *   d. silence confined to a window it was not asked to measure, or to part of one. The
 *      whole-file window is an average over the whole file: a render whose audio drops out
 *      for thirty seconds is not `-inf` over its length, so it is not refused.
 *   e. whether the levels it accepts are the RIGHT levels. Nothing here reads knobs.json.
 *      Acceptance means "there is sound in it", never "calibrated".
 *   f. a render that SHOULD have been silent and is not, and a `--allow-silent` passed
 *      where it was not true. The flag is a declaration by the caller and is trusted as
 *      one; nothing here can check it against the timeline.
 *
 * An UNMEASURABLE window is not judged here at all. That is already a refusal one layer
 * up, with a message that names the cause; re-deciding it from levels that were never read
 * is how "the file may have no audio track" came to be asserted about files that had one.
 *
 * @param {{state: string, rms?: number, peak?: number}} levels a readAstatsLevels result
 * @param {{label: string, wholeFile?: boolean}} window the window that was measured
 * @returns {string|null} the refusal detail, or null when the window is acceptable
 */
export function judgeDeliveredLevels(levels, { label, wholeFile = false, audioExpected = true } = {}) {
  // Silence is the measurement this whole module exists to keep as a measurement. A window
  // of it is CORRECT — the lead-in is silent by design — so only the whole file is judged,
  // and only for being silent all the way through.
  if (levels?.state !== 'silent' || !wholeFile) return null;
  // ...and only when audio was expected at all. README "concat-audio (S4)" documents a
  // timeline where EVERY segment is deliberately silent: no clip is matched to anything
  // and each window is generated. A render of that project is correctly silent end to end,
  // and refusing it would be this gate making the same mistake the lead-in fix made, one
  // level up. The caller declares that case; it is not guessed from the audio.
  if (!audioExpected) return null;

  return (
    `${label}: digital silence — the whole file measures -inf, so it carries NO AUDIO at ` +
    `all. A silent lead-in is correct; a silent render is not. Check that the mix reached ` +
    `the output stream (-map, the codec, the filter graph's final link) before delivering. ` +
    `If this project's timeline really is silent in every segment, say so with --allow-silent.`
  );
}

/**
 * Every `Stream #N:M ...` declaration in ffmpeg's input dump, in order.
 *
 * Anchored to the start of a line because the dump prints the FILE PATH mid-line
 * (`from 'C:\...':`), and the path is caller-controlled. An unanchored search would let a
 * filename assert the existence of a track that is not there — the same mistake as
 * inferring the track from a missing number, with a different input.
 */
export function findStreamDeclarations(output) {
  return [...String(output ?? '').matchAll(/^[ \t]*(Stream #\d+:\d+[^\n]*)$/gm)].map((m) => m[1].trim());
}

/** The audio stream ffmpeg declared for this input, or null when it declared none. */
export function findAudioStream(output) {
  const audio = findStreamDeclarations(output).find((s) => /:\s*Audio:\s/.test(s));
  return audio ? audio.slice(0, 160) : null;
}

/**
 * One report line's levels. `-inf` prints as `-inf`.
 *
 * `-Infinity` is matched EXACTLY rather than via `!Number.isFinite`, so that a `NaN`
 * arriving from a future caller cannot be rendered as digital silence. Printing an
 * unknown value as a specific claim is the defect this whole module exists to undo; it
 * would be a poor result to reintroduce it in the formatter.
 */
export function formatLevels(levels) {
  const db = (v) => (v === -Infinity ? '-inf' : Number.isFinite(v) ? v.toFixed(1) : `unreadable(${v})`);
  const line = `RMS ${db(levels.rms)} dB   peak ${db(levels.peak)} dBFS`;
  return levels.state === 'silent' ? `${line}   — digital silence (expected in the lead-in)` : line;
}

/**
 * Explains an unmeasurable window, naming a cause only where it has been established.
 *
 * Three outcomes, because "no audio stream matched" has two causes and only one of them
 * justifies the diagnosis. The stream regex tracks ffmpeg's output FORMAT, and a guard
 * keyed on a symptom expires when the symptom does — if a future ffmpeg reworded its
 * dump, a naive version of this would go straight back to announcing "no audio track"
 * about files that have one. So the claim is only made when the dump was demonstrably
 * readable: at least one stream was parsed, and none of them was audio.
 *
 * @param {string} file the file being measured
 * @param {string} output the combined ffmpeg output for that run
 * @param {{detail?: string}} levels the unmeasurable result from readAstatsLevels
 */
export function describeUnusableLevels(file, output, levels) {
  const streams = findStreamDeclarations(output);
  const audio = streams.find((s) => /:\s*Audio:\s/.test(s));
  const why = levels?.detail ?? 'astats produced no levels';
  const head = `ffmpeg produced no usable astats levels for ${file}`;

  if (audio) {
    return (
      `${head}, but the file DOES have an audio track (${audio.slice(0, 160)}) — so this is a ` +
      `probe failure, not a missing track. ${why}. ` +
      `Re-run that ffmpeg command by hand to see what the filter reported.`
    );
  }
  if (streams.length === 0) {
    return (
      `${head}, and no stream declarations could be read from its input dump — so whether this file ` +
      `has an audio track has NOT been established. ${why}. ` +
      `Re-run that ffmpeg command by hand and check the Input #0 block.`
    );
  }
  return (
    `${head}, and its input dump declares ${streams.length} stream(s), none of them audio — ` +
    `the file has no audio track. ${why}. ` +
    `Check the input, or remux an audio track in before measuring.`
  );
}
