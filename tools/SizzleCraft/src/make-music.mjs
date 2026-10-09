// Original ambient bed generator — no sampled or licensed material, everything is synthesised
// from first principles here.
//
// Composition: a slow four-chord loop voiced as five detuned-unison voices per chord, run
// through an LFO-swept low-pass filter and a small stereo reverb. Each voice has its own slow
// tremolo so the pad breathes rather than pulses.
//
// Usage: node make-music.mjs <outWav> <durationSec> [envelopeJson] [preset]
//   envelopeJson (optional) = voiceover RMS envelope, used to sidechain-duck the bed under speech.
//   preset       (optional) = named bed, see BEDS below. Defaults to 'warm'.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
    EXIT,
    CliError,
    guard,
    runCli,
    parseCli,
    requireExistingFile,
    resolveOutput,
    resolveEngineOutput,
    openExclusiveEngineFile,
    describeWrite,
    planFooter,
    requirePositiveNumber,
    resolveKnob,
    fingerprintBuffer,
} from "./cli-support.mjs";
import {
    SPEECH_RMS_THRESHOLD,
    REFERENCE_ATTACK_MS,
    REFERENCE_RELEASE_MS,
    REFERENCE_DUCK_GAIN,
    BED_DUCK_RECORD_SUFFIX,
    duckGainTrajectory,
    fingerprintVoice,
    bedDuckRecord,
    publishBedDuckRecord,
    classifyEnvelopeLineage,
    describeEnvelopeRefusal,
    requireEnvelopeHopMs,
    assertEnvelopeSpansAgree,
    openedAtState,
} from "./envelope-ducking.mjs";

const USAGE = `
make-music — synthesise the ambient bed (pipeline stage S8). Nothing sampled or licensed.

  node make-music.mjs --out music.wav --seconds 240                    plan only (default)
  node make-music.mjs --out music.wav --seconds 240 --apply            write the bed
  node make-music.mjs --out music.wav --seconds 240 --apply --replace  overwrite it

Options
  --out <file>        output WAV (default: music.wav)
  --seconds <number>  duration in seconds, 0..7200 (default: 251.2)
  --envelope <file>   voiceover RMS envelope, used to sidechain-duck the bed under speech
  --voice <file>      the narration in play, which the envelope must have been measured
                      from (default: voiceover.mp3 — what remux-music mixes by default)
  --preset <name>     named bed: warm (I-V-ii-IV in F) or bright (vi-IV-I-V in G)
  --project <dir>     project root; no path may escape it (default: current directory)
  --apply             actually write. Without it nothing is written.
  --replace           permit overwriting an existing --out and its ducking record
  --help              show this message

Beside the bed, --apply writes <out>.duck.json: the narration the bed was ducked against,
or that it was not ducked. The duck is baked into the samples, so remux-music checks this
record and refuses a bed ducked against narration that is no longer the one in play.
Without --replace the record is created only if its name is still free when it is
published: one that appeared while the bed was synthesised is refused and left as it is,
and the bed is not written.

Exit codes: 0 success/plan · 1 synthesis failed, or the ducking record could not be
written · 2 bad usage or refused overwrite, including a ducking record that appeared
during the run
`.trimStart();

const cli = (() => {
    try {
        return parseCli({
            usage: USAGE,
            options: {
                out: { type: "string" },
                seconds: { type: "string" },
                envelope: { type: "string" },
                voice: { type: "string" },
                preset: { type: "string" },
            },
        });
    } catch (err) {
        if (err.name === "HelpRequested") {
            console.log(err.usage);
            process.exit(EXIT.OK);
        }
        console.error(`error: ${err.message}`);
        process.exit(err.exitCode ?? EXIT.FAILED);
    }
})();

let out, recordPath, DUR, envPath, presetName;
const bedNameIsEngineChosen = cli.values.out === undefined;
try {
    // `music.wav` IS ENGINE-CHOSEN: nobody named it, make-music picked it, so a link at it
    // is refused rather than followed. A path the caller passed is theirs to redirect, and
    // an in-root link at it is honoured as it is for every other user-named output. Writing
    // through a link nobody named replaces a file nobody asked about — measured at exactly
    // that: a planted link put 384 kB of PCM over an unrelated in-root file.
    out = bedNameIsEngineChosen
        ? resolveEngineOutput(cli.projectDir, "music.wav", {
              apply: cli.apply,
              replace: cli.replace,
              label: "output",
          })
        : resolveOutput(cli.projectDir, cli.values.out, {
              apply: cli.apply,
              replace: cli.replace,
              label: "output",
          });
    // ENGINE-CHOSEN: nobody named it, so a link at it is refused, and an existing one needs
    // --replace as the bed does. Resolved here, so a refusal costs nothing — not after
    // minutes of synthesis, and never with a bed written and its record not. This is the
    // cheap refusal; the guard is the publish, which creates the record exclusively.
    recordPath = resolveEngineOutput(
        cli.projectDir,
        `${out}${BED_DUCK_RECORD_SUFFIX}`,
        {
            apply: cli.apply,
            replace: cli.replace,
            label: "ducking record",
        },
    );
    DUR = requirePositiveNumber(cli.values.seconds ?? 251.2, {
        name: "--seconds",
        max: 7200,
    });
    envPath = cli.values.envelope
        ? requireExistingFile(
              cli.projectDir,
              cli.values.envelope,
              "envelope file",
          )
        : null;
    presetName = resolveKnob("MUSIC_PRESET", {
        argv: cli.values.preset,
        fallback: "warm",
        legacy: ["SIZZLE_MUSIC_PRESET"],
    }).value;
} catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(err.exitCode ?? EXIT.FAILED);
}

// ---- envelope lineage ------------------------------------------------------------------------
// THE ENVELOPE MUST DESCRIBE THE NARRATION ACTUALLY IN PLAY. A stale one parses perfectly
// and ducks against a cut that no longer exists, drifting further out of alignment the
// longer the bed runs, with nothing reporting it (see envelope-ducking.mjs).
//
// Checked HERE, before the preset line and before synthesis, so a stale envelope costs
// seconds rather than minutes of pad generation. It is checked AGAIN at the read below,
// which is the authoritative one: this is a pre-flight, not a substitute.
let voiceFingerprint = null;
if (envPath) {
    try {
        voiceFingerprint = await resolveVoiceFingerprint();
        assertEnvelopeCurrent(JSON.parse(fs.readFileSync(envPath, "utf8")));
    } catch (err) {
        if (err instanceof SyntaxError) {
            console.error(
                `error: ${envPath} is not valid JSON — ${err.message}`,
            );
            process.exit(EXIT.USAGE);
        }
        console.error(`error: ${err.message}`);
        process.exit(err.exitCode ?? EXIT.USAGE);
    }
}

/**
 * Fingerprints the narration the envelope has to match: `--voice`, else voiceover.mp3 —
 * the narration remux-music mixes by default.
 *
 * NOT the file the envelope names. Checking an envelope against its own `measuredFrom`
 * proved only that it matched its own source, so a project re-voiced into voiceover.mp3
 * with the envelope still bound to a draft that was still on disk passed as current. The
 * name the envelope records appears in a refusal, as information, and nowhere else.
 */
async function resolveVoiceFingerprint() {
    const named = cli.values.voice;
    const voiceName =
        typeof named === "string" && named !== "" ? named : "voiceover.mp3";
    const voicePath = requireExistingFile(
        cli.projectDir,
        voiceName,
        "voice track the envelope must describe",
    );
    return fingerprintVoice(voicePath, voiceName);
}

/** Refuses anything but a current envelope, keeping stale/unbound/unreadable distinct. */
function assertEnvelopeCurrent(parsed) {
    const verdict = classifyEnvelopeLineage(parsed, voiceFingerprint);
    if (verdict.state === "current") return;
    const named = parsed?.measuredFrom?.file;
    const namedNote =
        typeof named === "string" && named !== voiceFingerprint.file
            ? `\nThe envelope names ${JSON.stringify(named.slice(0, 64))} as its source. That is information only: the\n` +
              `narration in play is ${voiceFingerprint.file} (--voice, default voiceover.mp3), and it is what the envelope must describe.`
            : "";
    throw new CliError(
        describeEnvelopeRefusal(verdict, {
            envelopePath: envPath,
            voicePath: voiceFingerprint.file,
        }) + namedNote,
    );
}

const SR = 48000;
const N = Math.round(DUR * SR);
// A positive duration shorter than half a sample rounds to zero, which produced a
// header-only WAV and reported a completed bed.
if (!Number.isSafeInteger(N) || N < 1) {
    console.error(
        `error: --seconds ${DUR} yields ${N} samples at ${SR} Hz — refusing to write an empty bed`,
    );
    process.exit(EXIT.USAGE);
}

// ---- composition -----------------------------------------------------------------------------
// Named beds. Each is a complete voicing; add a new entry rather than editing one in place, so
// previously-rendered videos keep their bed. Sibling videos in a series should use DIFFERENT
// presets — deliberately related, not a repeat.
//
// This was the only real divergence between project copies of this script, so it is a parameter
// rather than a fork.
const BEDS = {
    // I-V-ii-IV in F. Warmer, slower, more settled.
    warm: {
        chords: [
            { name: "Fmaj9", f: [87.31, 130.81, 220.0, 329.63, 392.0] },
            { name: "Cmaj9", f: [65.41, 98.0, 164.81, 246.94, 293.66] },
            { name: "Dm9", f: [73.42, 110.0, 174.61, 261.63, 329.63] },
            { name: "Bbmaj9", f: [58.27, 87.31, 146.83, 220.0, 261.63] },
        ],
        chordSec: 15.7,
        xfadeSec: 5.2,
        voiceGain: [1.0, 0.72, 0.52, 0.34, 0.26],
        filterBaseHz: 560, // warmer — filter sits lower, fewer upper partials survive
        filterSweepHz: 300,
        detuneR: 1.0015,
    },
    // vi-IV-I-V in G. Brighter, shorter chords, a touch more movement.
    bright: {
        chords: [
            { name: "Em9", f: [82.41, 123.47, 196.0, 293.66, 369.99] },
            { name: "Cmaj9", f: [65.41, 98.0, 164.81, 246.94, 293.66] },
            { name: "Gmaj9", f: [98.0, 146.83, 246.94, 293.66, 392.0] },
            { name: "Dsus2", f: [73.42, 110.0, 164.81, 220.0, 329.63] },
        ],
        chordSec: 13.3,
        xfadeSec: 4.4,
        voiceGain: [1.0, 0.68, 0.55, 0.38, 0.22],
        filterBaseHz: 700, // brighter — more of the wavetable's upper partials pass
        filterSweepHz: 380,
        detuneR: 1.0012,
    },
};

const bed = BEDS[presetName];
if (!bed) {
    console.error(
        `error: unknown music preset '${presetName}'. available: ${Object.keys(BEDS).join(", ")}`,
    );
    process.exit(EXIT.USAGE);
}
console.log(
    `music preset: ${presetName} (${bed.chords.map((c) => c.name).join(" - ")})`,
);

// Synthesis of a multi-minute bed is not free, so the plan stops here rather than
// generating a buffer it would then discard.
if (!cli.apply) {
    console.log(`plan: synthesise ${DUR}s of the '${presetName}' bed`);
    console.log(
        `  ducking ${envPath ? `sidechained to ${envPath}` : "none (no --envelope given)"}`,
    );
    console.log(`  output  ${out} — ${describeWrite(out, cli.replace)}`);
    console.log(
        `  record  ${recordPath} — ${describeWrite(recordPath, cli.replace)} ` +
            `(${voiceFingerprint ? `ducked against ${voiceFingerprint.file}` : "not ducked"})`,
    );
    planFooter();
    process.exit(EXIT.OK);
}

const CHORDS = bed.chords;
const CHORD_SEC = bed.chordSec;
const XFADE_SEC = bed.xfadeSec;
const VOICE_GAIN = bed.voiceGain;
const DETUNE_R = bed.detuneR;

// per-voice tremolo (slow, uncorrelated so the pad breathes rather than pulses)
const TREM_RATE = [0.037, 0.063, 0.052, 0.075, 0.045];
const TREM_DEPTH = 0.15;
const TREM_PHASE = [1.1, 4.2, 0.6, 2.8, 5.4];

// ---- oscillator ------------------------------------------------------------------------------
// A wavetable replaces the previous per-harmonic Math.sin stack. Two reasons: it gives a much
// richer starting spectrum for the filter to shape (a bare sine has nothing to take away), and
// a table lookup is cheaper than N sine calls per sample, so the detuned voices below cost less
// than the additive stack they replace.
const TABLE_BITS = 12;
const TABLE_SIZE = 1 << TABLE_BITS;
const TABLE_MASK = TABLE_SIZE - 1;
const WAVE = new Float32Array(TABLE_SIZE);
{
    // Soft sawtooth: 1/n rolloff, extra-damped above the 6th so it stays warm rather than buzzy.
    const PARTIALS = 14;
    let max = 0;
    for (let i = 0; i < TABLE_SIZE; i++) {
        const ph = (2 * Math.PI * i) / TABLE_SIZE;
        let s = 0;
        for (let n = 1; n <= PARTIALS; n++) {
            const damp = n <= 6 ? 1 : 1 / (1 + 0.55 * (n - 6));
            s += (Math.sin(n * ph) / n) * damp;
        }
        WAVE[i] = s;
        if (Math.abs(s) > max) max = Math.abs(s);
    }
    for (let i = 0; i < TABLE_SIZE; i++) WAVE[i] /= max;
}

function wave(phase) {
    // phase in [0,1)
    const x = phase * TABLE_SIZE;
    const i0 = x | 0;
    const frac = x - i0;
    const a = WAVE[i0 & TABLE_MASK];
    const b = WAVE[(i0 + 1) & TABLE_MASK];
    return a + (b - a) * frac;
}

// Three oscillators per voice, detuned in cents. This is what stops it reading as a test tone:
// the slow beating between near-unison partials is most of what "an instrument" sounds like.
const DETUNE_CENTS = [-6.5, 0, 6.5];
const DETUNE = DETUNE_CENTS.map((c) => Math.pow(2, c / 1200));
const UNISON_GAIN = 1 / DETUNE.length;

// ---- filter ----------------------------------------------------------------------------------
// Chamberlin state-variable low-pass, cutoff swept by a slow LFO. Replaces the previous static
// harmonic weights: the spectrum now moves, which is the difference between a pad that breathes
// and one that sits still.
const FILT_BASE_HZ = bed.filterBaseHz;
const FILT_SWEEP_HZ = bed.filterSweepHz;
const FILT_LFO_RATE = 0.021;
const FILT_Q = 0.62;

// ---- reverb ----------------------------------------------------------------------------------
// Small Schroeder network: four parallel combs into two series allpasses, per channel, with
// different delay lengths L/R for real stereo space rather than only a detuned right channel.
const COMB_L = [1687, 1759, 1621, 1543];
const COMB_R = [1733, 1801, 1667, 1597];
const COMB_FB = 0.79;
const ALLPASS_L = [241, 607];
const ALLPASS_R = [263, 641];
const ALLPASS_FB = 0.62;
const REVERB_WET = 0.28;

function makeDelays(lengths) {
    return lengths.map((n) => ({ buf: new Float32Array(n), idx: 0, n }));
}

const left = new Float32Array(N);
const right = new Float32Array(N);

// chord weight at time t — raised-cosine crossfade so two chords overlap rather than cut
function chordWeights(t) {
    const pos = t / CHORD_SEC;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const w = [];
    const xf = XFADE_SEC / CHORD_SEC;
    const a = idx % CHORDS.length;
    const b = (idx + 1) % CHORDS.length;
    if (frac < xf) {
        const m = 0.5 - 0.5 * Math.cos(Math.PI * (frac / xf)); // 0 -> 1
        w.push([(idx - 1 + CHORDS.length * 2) % CHORDS.length, 1 - m]);
        w.push([a, m]);
    } else {
        w.push([a, 1]);
    }
    if (frac > 1 - xf) {
        const m = 0.5 - 0.5 * Math.cos(Math.PI * ((frac - (1 - xf)) / xf));
        w[w.length - 1] = [a, 1 - m];
        w.push([b, m]);
    }
    return w;
}

console.log(`synthesising ${DUR.toFixed(1)}s of pad at ${SR} Hz…`);

// phase accumulators, normalised to [0,1) — one per chord/voice/unison-oscillator, per channel
const phaseL = CHORDS.map((c) => c.f.map(() => DETUNE.map(() => 0)));
const phaseR = CHORDS.map((c) => c.f.map(() => DETUNE.map(() => 0)));

// filter state
let lowL = 0,
    bandL = 0,
    lowR = 0,
    bandR = 0;

// reverb state
const combL = makeDelays(COMB_L),
    combR = makeDelays(COMB_R);
const apL = makeDelays(ALLPASS_L),
    apR = makeDelays(ALLPASS_R);

function reverb(x, combs, allpasses) {
    let acc = 0;
    for (const d of combs) {
        const y = d.buf[d.idx];
        d.buf[d.idx] = x + y * COMB_FB;
        d.idx = (d.idx + 1) % d.n;
        acc += y;
    }
    acc /= combs.length;
    for (const d of allpasses) {
        const y = d.buf[d.idx];
        const out = -acc + y;
        d.buf[d.idx] = acc + y * ALLPASS_FB;
        d.idx = (d.idx + 1) % d.n;
        acc = out;
    }
    return acc;
}

for (let i = 0; i < N; i++) {
    const t = i / SR;
    const ws = chordWeights(t);
    let l = 0,
        r = 0;
    for (const [ci, cw] of ws) {
        if (cw <= 0) continue;
        const chord = CHORDS[ci];
        for (let v = 0; v < chord.f.length; v++) {
            const trem =
                1 +
                TREM_DEPTH *
                    Math.sin(2 * Math.PI * TREM_RATE[v] * t + TREM_PHASE[v]);
            const g = cw * VOICE_GAIN[v] * trem * UNISON_GAIN;
            const base = chord.f[v];
            for (let d = 0; d < DETUNE.length; d++) {
                const fL = (base * DETUNE[d]) / SR;
                const fR = (base * DETUNE[d] * DETUNE_R) / SR;
                phaseL[ci][v][d] = (phaseL[ci][v][d] + fL) % 1;
                phaseR[ci][v][d] = (phaseR[ci][v][d] + fR) % 1;
                l += wave(phaseL[ci][v][d]) * g;
                r += wave(phaseR[ci][v][d]) * g;
            }
        }
    }

    // moving low-pass — the LFO is 90 degrees apart per channel so the sweep widens the image
    const lfo = Math.sin(2 * Math.PI * FILT_LFO_RATE * t);
    const fcL = FILT_BASE_HZ + FILT_SWEEP_HZ * lfo;
    const fcR =
        FILT_BASE_HZ +
        FILT_SWEEP_HZ * Math.sin(2 * Math.PI * FILT_LFO_RATE * t + Math.PI / 2);
    const fL = 2 * Math.sin((Math.PI * fcL) / SR);
    const fR = 2 * Math.sin((Math.PI * fcR) / SR);

    lowL += fL * bandL;
    bandL += fL * (l - lowL - FILT_Q * bandL);
    lowR += fR * bandR;
    bandR += fR * (r - lowR - FILT_Q * bandR);

    const dryL = lowL,
        dryR = lowR;
    left[i] = dryL * (1 - REVERB_WET) + reverb(dryL, combL, apL) * REVERB_WET;
    right[i] = dryR * (1 - REVERB_WET) + reverb(dryR, combR, apR) * REVERB_WET;

    if ((i & 0x3fffff) === 0) process.stdout.write(".");
}
process.stdout.write("\n");

// ---- normalise the raw pad to a known peak ----------------------------------------------------
let peak = 0;
for (let i = 0; i < N; i++)
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
const TARGET_PEAK = 0.125; // ≈ -18 dBFS before ducking
const norm = TARGET_PEAK / (peak || 1);
console.log(
    `raw peak ${peak.toFixed(3)} -> normalising x${norm.toFixed(4)} (target ${TARGET_PEAK})`,
);

// ---- sidechain ducking off the voiceover envelope ---------------------------------------------
// Music sits well under narration and lifts back up in the inter-segment gaps.
const DUCK = REFERENCE_DUCK_GAIN; // ≈ -7.5 dB under speech
// THE ENVELOPE'S OWN HOP, NOT A CONSTANT. This was hard-coded at 20 ms while the envelope
// carries the hop it was measured at, so the same narration described at a coarser hop
// was read as a different one: measured at 40 ms, the duck landed 7.2 dB on the GAP and
// only 4.2 dB on the first phrase — it ducked the silence and let the speech through, at
// exit 0. Null until an envelope supplies it; there is no duck without one.
let hopMs = null;
let duckGain = null;
if (envPath) {
    // No existsSync pre-check: an envelope that was ASKED for and cannot be read must fail,
    // not silently select flat music and report success. Reading once and handling the
    // failure also closes the window between the check and the read.
    const env = guard(() => {
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(envPath, "utf8"));
        } catch (err) {
            throw new CliError(`${envPath} is not valid JSON — ${err.message}`);
        }
        // THE AUTHORITATIVE LINEAGE CHECK. The pre-flight above fails fast; this one is over
        // the bytes actually about to be ducked against, so an envelope swapped between the
        // two is caught rather than trusted.
        assertEnvelopeCurrent(parsed);
        // An empty or non-numeric envelope produced an empty gain array, which indexed to
        // `undefined`, multiplied every sample to NaN, and wrote a WAV of NaN floats while
        // reporting success — replacing a good bed with garbage. The ducking curve is the
        // value the whole gain path depends on, so it is validated before synthesis.
        if (!Array.isArray(parsed?.rms)) {
            throw new CliError(
                `${envPath} must contain an "rms" array of envelope samples`,
            );
        }
        if (parsed.rms.length === 0) {
            throw new CliError(
                `${envPath} has an empty "rms" array — there is no envelope to duck against`,
            );
        }
        const bad = parsed.rms.findIndex(
            (v) => typeof v !== "number" || !Number.isFinite(v) || v < 0,
        );
        if (bad !== -1) {
            throw new CliError(
                `${envPath} "rms"[${bad}] is ${JSON.stringify(parsed.rms[bad])} — every envelope sample must be a finite non-negative number`,
            );
        }
        // The hop places every dip, and the two halves of the envelope's own span must agree
        // before any of it is ducked against. Both are checked AFTER the rms array, which is
        // the field they are expressed in terms of.
        requireEnvelopeHopMs(parsed, envPath);
        assertEnvelopeSpansAgree(parsed, envPath);
        return parsed;
    });
    hopMs = env.hopMs;
    // ONE MODEL, BOTH DUCKING PATHS. This loop used to live here and remux-music now ducks
    // in the ffmpeg graph from the same envelope; two copies of "duck fast, recover gently"
    // is two behaviours waiting to drift apart, so both read the same function.
    const g = duckGainTrajectory({
        rms: env.rms,
        hopMs,
        duckGain: DUCK,
        attackMs: REFERENCE_ATTACK_MS,
        releaseMs: REFERENCE_RELEASE_MS,
        threshold: SPEECH_RMS_THRESHOLD,
    });
    duckGain = g;
    const ducked = g.reduce((a, b) => a + (b < 0.7 ? 1 : 0), 0);
    console.log(
        `ducking from ${env.rms.length} envelope frames at ${hopMs} ms — under speech for ${((ducked / g.length) * 100).toFixed(0)}% of the run`,
    );
} else {
    console.log("no envelope supplied — flat music level");
}

// ---- fades -----------------------------------------------------------------------------------
const FADE_IN = 1.4,
    FADE_OUT = 4.5;
function fade(t) {
    let f = 1;
    if (t < FADE_IN) f *= 0.5 - 0.5 * Math.cos(Math.PI * (t / FADE_IN));
    const tr = DUR - t;
    if (tr < FADE_OUT)
        f *= Math.max(0, 0.5 - 0.5 * Math.cos(Math.PI * (tr / FADE_OUT)));
    return f;
}

for (let i = 0; i < N; i++) {
    const t = i / SR;
    let g = norm * fade(t);
    if (duckGain) {
        const k = (t * 1000) / hopMs;
        const k0 = Math.min(duckGain.length - 1, Math.floor(k));
        const k1 = Math.min(duckGain.length - 1, k0 + 1);
        const fr = k - k0;
        g *= duckGain[k0] * (1 - fr) + duckGain[k1] * fr;
    }
    left[i] *= g;
    right[i] *= g;
}

// ---- write 32-bit float WAV -------------------------------------------------------------------
const bytes = N * 2 * 4;
const buf = Buffer.alloc(44 + bytes);
buf.write("RIFF", 0);
buf.writeUInt32LE(36 + bytes, 4);
buf.write("WAVE", 8);
buf.write("fmt ", 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(3, 20); // 3 = IEEE float
buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 2 * 4, 28);
buf.writeUInt16LE(8, 32);
buf.writeUInt16LE(32, 34);
buf.write("data", 36);
buf.writeUInt32LE(bytes, 40);
let o = 44;
let outPeak = 0;
let nonFinite = -1;
for (let i = 0; i < N; i++) {
    if (
        nonFinite === -1 &&
        (!Number.isFinite(left[i]) || !Number.isFinite(right[i]))
    )
        nonFinite = i;
    buf.writeFloatLE(left[i], o);
    o += 4;
    buf.writeFloatLE(right[i], o);
    o += 4;
    outPeak = Math.max(outPeak, Math.abs(left[i]), Math.abs(right[i]));
}
// Belt and braces on the "claims to have done the job" half: whatever produced them, a
// buffer of NaN samples is not a music bed, and writing one over a good file while
// printing "wrote ..." is the failure mode this engine exists to stop.
if (nonFinite !== -1) {
    console.error(
        `error: synthesis produced a non-finite sample at index ${nonFinite} — refusing to write ${out}. ` +
            `This is a bug in the generator or its inputs; the existing file has not been touched.`,
    );
    process.exit(EXIT.FAILED);
}
// THE RECORD FIRST, THEN THE BED. A new bed never lands without its record: if the bed
// write fails after the record is published, the record fingerprints bytes that are not
// on disk, and remux-music refuses it as describing a different bed.
const record = bedDuckRecord(
    fingerprintBuffer(buf, path.basename(out)),
    voiceFingerprint,
);
let published;
try {
    published = publishBedDuckRecord(cli.projectDir, recordPath, record, {
        replace: cli.replace,
    });
} catch (err) {
    console.error(
        `error: ${err.message}\n${out} has not been written: a bed never lands without its record.`,
    );
    process.exit(err.exitCode ?? EXIT.FAILED);
}
for (const warning of published.warnings) console.error(`warning: ${warning}`);
try {
    publishBed(buf);
} catch (err) {
    // A bed that IS at its name, with bytes that could not be confirmed, is not a missing
    // bed — and the record fingerprints what was meant to be there, so remux-music refuses
    // it if they are not.
    console.error(
        err.bedPublished
            ? `error: ${err.message}\nThe bed is at ${out} and the ducking record at ${recordPath} fingerprints the ` +
                  `bytes it should hold, so remux-music will refuse it if they are not those bytes.`
            : `error: ${err.message}\nThe ducking record at ${recordPath} describes a bed that was not written, so ` +
                  `remux-music will refuse it as describing a different bed. Clear it and re-run.`,
    );
    process.exit(err.exitCode ?? EXIT.FAILED);
}
const db = (v) => (20 * Math.log10(v || 1e-9)).toFixed(1);
console.log(
    `wrote ${out} — ${(bytes / 1e6).toFixed(1)} MB, peak ${db(outPeak)} dBFS`,
);
console.log(
    `wrote ${recordPath} — ${record.ducked ? `ducked against ${voiceFingerprint.file}` : "not ducked"}`,
);

/**
 * Writes the bed, with the link policy its name earned.
 *
 * THE UP-FRONT RESOLVE IS NOT THE WRITE. It refuses a link at the engine-chosen name, and
 * then synthesis runs for minutes before the bytes exist — and `writeFileSync` opens with
 * `'w'`, which FOLLOWS a link that took the name in that window and writes to a file
 * nobody named. The ducking record learned this first (see publishBedDuckRecord); the bed
 * is the larger write and had the same window.
 *
 * So for the name make-music chose, the write itself is the guard. Without --replace the
 * create is exclusive, so any entry at all — file, directory, link, even one to nothing —
 * refuses it and is left as it is. With --replace the bytes go to a temp file under an
 * unguessable name and are RENAMED over it, which replaces a link rather than following
 * it: --replace covers the bed's own name, never whatever something else pointed it at.
 *
 * A path the CALLER named is theirs to redirect, and an in-root link at it is followed, as
 * it is for every other user-named output in this engine.
 */
function publishBed(bedBytes) {
    if (!bedNameIsEngineChosen) {
        fs.writeFileSync(out, bedBytes);
        return;
    }
    if (!cli.replace) {
        try {
            fs.writeFileSync(out, bedBytes, { flag: "wx" });
        } catch (err) {
            if (err.code === "EEXIST") {
                throw new CliError(
                    `${out} appeared after the up-front check found the name free — refusing to write through an entry ` +
                        `this run did not create. It has been left exactly as it is; if it is a link, nothing was written ` +
                        `to what it points at. Move it aside, or re-run with --replace.`,
                );
            }
            throw new CliError(
                `could not write the bed ${out} (${err.code ?? err.message})`,
                EXIT.FAILED,
            );
        }
        return;
    }

    const temp = openExclusiveEngineFile(
        cli.projectDir,
        `${out}.part-${process.pid}-${crypto.randomBytes(8).toString("hex")}`,
        "bed temp file",
    );
    try {
        fs.writeFileSync(temp.fd, bedBytes);
        fs.renameSync(temp.path, out);
    } catch (err) {
        const left = retireBedTemp(temp);
        throw new CliError(
            `could not write the bed ${out} (${err.code ?? err.message})${left.map((note) => `\n${note}`).join("")}`,
            EXIT.FAILED,
        );
    }
    // The rename moved this run's file onto the name, so the name is checked against the
    // descriptor that still holds it — and the temp name is never removed, because the
    // rename already consumed it and anything there now belongs to someone else.
    const verdict = openedAtState(temp.fd, out);
    let closeFailure = null;
    try {
        fs.closeSync(temp.fd);
    } catch (err) {
        closeFailure = err;
    }
    if (verdict !== "same") {
        // WHAT WAS FOUND, NOT WHAT IT MIGHT MEAN. A substitution and a volume that gives no
        // file identity both fail this check, and only one of them is a substitution.
        const why = {
            different: "another entry took its place as it was renamed",
            absent: "nothing is at that name any more",
            unavailable: "this filesystem gives no file identity to check",
            unchecked: "it could not be examined",
        }[verdict];
        throw new CliError(
            `${out} cannot be confirmed as the bed this run just published there: ${why}. It has been left as it is.`,
            EXIT.FAILED,
        );
    }
    if (closeFailure) {
        // NOT A FAILED PUBLISH. The bed is at its name; what cannot be confirmed is what was
        // written to it. Reporting it as unwritten sends someone looking for a file that is
        // sitting right there.
        const err = new CliError(
            `the bed was published at ${out}, but the file it was written through could not be closed ` +
                `(${closeFailure.code ?? closeFailure.message}), so what was written to it cannot be confirmed.`,
            EXIT.FAILED,
        );
        err.bedPublished = true;
        throw err;
    }
}

/**
 * Closes the bed's temp file and removes it — but ONLY while the name still holds the file
 * this run created there.
 *
 * Removing by name removes whatever is at the name. An entry substituted in the window
 * between the open and the cleanup was never this run's to delete, and deleting it would
 * make the guard perform exactly the destruction it exists to prevent. What has to be left
 * behind comes back as a note, so a stranded temp is reported rather than silently kept.
 *
 * @returns {string[]} what it had to leave, for the caller to print
 */
function retireBedTemp(temp) {
    const notes = [];
    const verdict = openedAtState(temp.fd, temp.path);
    if (verdict === "same") {
        try {
            fs.unlinkSync(temp.path);
        } catch (err) {
            notes.push(
                `the temp file ${temp.path} could not be removed (${err.code ?? err.message}) — delete it by hand`,
            );
        }
    } else if (verdict !== "absent") {
        notes.push(
            verdict === "different"
                ? `the temp name ${temp.path} no longer holds the file this run wrote, so it has been left as it is`
                : `the temp name ${temp.path} cannot be confirmed as this run's, so it has been left as it is`,
        );
    }
    try {
        fs.closeSync(temp.fd);
    } catch (err) {
        notes.push(
            `the temp file's descriptor could not be closed (${err.code ?? err.message})`,
        );
    }
    return notes;
}
