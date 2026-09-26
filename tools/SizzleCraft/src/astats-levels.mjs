/*
 * Reads RMS/peak levels out of one ffmpeg `astats` run, and says which of THREE things
 * happened: the window was MEASURED, the window was SILENT, or it could not be measured.
 *
 * The rule lives here rather than inside check-levels.mjs so it can be tested without an
 * ffmpeg binary — the same reason end-card.mjs lives apart from voice.mjs.
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
