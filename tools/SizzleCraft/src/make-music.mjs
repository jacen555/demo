// Original ambient bed generator — no sampled or licensed material, everything is synthesised
// from first principles here.
//
// Composition: a slow four-chord loop voiced as five sine voices per chord with two soft
// harmonics each, crossfaded with a raised cosine. Each voice has its own slow tremolo and a
// slightly detuned right channel for width.
//
// Usage: node make-music.mjs <outWav> <durationSec> [envelopeJson] [preset]
//   envelopeJson (optional) = voiceover RMS envelope, used to sidechain-duck the bed under speech.
//   preset       (optional) = named bed, see BEDS below. Defaults to 'warm'.
import fs from 'node:fs';

const out = process.argv[2] || 'music.wav';
const DUR = Number(process.argv[3] || 251.2);
const envPath = process.argv[4] || null;
const presetName = process.argv[5] || process.env.SIZZLE_MUSIC_PRESET || 'warm';

const SR = 48000;
const N = Math.round(DUR * SR);

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
      { name: 'Fmaj9',  f: [ 87.31, 130.81, 220.00, 329.63, 392.00] },
      { name: 'Cmaj9',  f: [ 65.41,  98.00, 164.81, 246.94, 293.66] },
      { name: 'Dm9',    f: [ 73.42, 110.00, 174.61, 261.63, 329.63] },
      { name: 'Bbmaj9', f: [ 58.27,  87.31, 146.83, 220.00, 261.63] },
    ],
    chordSec: 15.7,
    xfadeSec: 5.2,
    voiceGain: [1.00, 0.72, 0.52, 0.34, 0.26],
    harm: [1.0, 0.18, 0.075],   // fundamental + 2nd + 3rd, organ-ish and soft
    detuneR: 1.0015,
  },
  // vi-IV-I-V in G. Brighter, shorter chords, a touch more movement.
  bright: {
    chords: [
      { name: 'Em9',    f: [ 82.41, 123.47, 196.00, 293.66, 369.99] },
      { name: 'Cmaj9',  f: [ 65.41,  98.00, 164.81, 246.94, 293.66] },
      { name: 'Gmaj9',  f: [ 98.00, 146.83, 246.94, 293.66, 392.00] },
      { name: 'Dsus2',  f: [ 73.42, 110.00, 164.81, 220.00, 329.63] },
    ],
    chordSec: 13.3,
    xfadeSec: 4.4,
    voiceGain: [1.00, 0.68, 0.55, 0.38, 0.22],
    harm: [1.0, 0.15, 0.09],
    detuneR: 1.0012,
  },
};

const bed = BEDS[presetName];
if (!bed) {
  console.error(`unknown music preset '${presetName}'. available: ${Object.keys(BEDS).join(', ')}`);
  process.exitCode = 1;
  process.exit();
}
console.log(`music preset: ${presetName} (${bed.chords.map(c => c.name).join(' - ')})`);

const CHORDS = bed.chords;
const CHORD_SEC = bed.chordSec;
const XFADE_SEC = bed.xfadeSec;
const VOICE_GAIN = bed.voiceGain;
const HARM = bed.harm;
const DETUNE_R = bed.detuneR;

// per-voice tremolo (slow, uncorrelated so the pad breathes rather than pulses)
const TREM_RATE = [0.037, 0.063, 0.052, 0.075, 0.045];
const TREM_DEPTH = 0.15;
const TREM_PHASE = [1.1, 4.2, 0.6, 2.8, 5.4];

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
    const m = 0.5 - 0.5 * Math.cos(Math.PI * (frac / xf));   // 0 -> 1
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
const phaseL = CHORDS.map(c => c.f.map(() => HARM.map(() => 0)));
const phaseR = CHORDS.map(c => c.f.map(() => HARM.map(() => 0)));

for (let i = 0; i < N; i++) {
  const t = i / SR;
  const ws = chordWeights(t);
  let l = 0, r = 0;
  for (const [ci, cw] of ws) {
    if (cw <= 0) continue;
    const chord = CHORDS[ci];
    for (let v = 0; v < chord.f.length; v++) {
      const trem = 1 + TREM_DEPTH * Math.sin(2 * Math.PI * TREM_RATE[v] * t + TREM_PHASE[v]);
      const g = cw * VOICE_GAIN[v] * trem;
      for (let h = 0; h < HARM.length; h++) {
        const base = chord.f[v] * (h + 1);
        phaseL[ci][v][h] += 2 * Math.PI * base / SR;
        phaseR[ci][v][h] += 2 * Math.PI * base * DETUNE_R / SR;
        l += Math.sin(phaseL[ci][v][h]) * HARM[h] * g;
        r += Math.sin(phaseR[ci][v][h]) * HARM[h] * g;
      }
    }
  }
  left[i] = l; right[i] = r;
  if ((i & 0x3fffff) === 0) process.stdout.write('.');
}
process.stdout.write('\n');

// ---- normalise the raw pad to a known peak ----------------------------------------------------
let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
const TARGET_PEAK = 0.125;                    // ≈ -18 dBFS before ducking
const norm = TARGET_PEAK / (peak || 1);
console.log(`raw peak ${peak.toFixed(3)} -> normalising x${norm.toFixed(4)} (target ${TARGET_PEAK})`);

// ---- sidechain ducking off the voiceover envelope ---------------------------------------------
// Music sits well under narration and lifts back up in the inter-segment gaps.
const DUCK = 0.42;          // ≈ -7.5 dB under speech
const HOP_MS = 20;
let duckGain = null;
if (envPath && fs.existsSync(envPath)) {
  const env = JSON.parse(fs.readFileSync(envPath, 'utf8'));
  const rms = env.rms, thresh = 0.004;
  // one-pole smoothing: duck fast, recover gently, so it never pumps
  const atk = Math.exp(-HOP_MS / 150), rel = Math.exp(-HOP_MS / 800);
  const g = new Float32Array(rms.length);
  let cur = 1;
  for (let k = 0; k < rms.length; k++) {
    const target = rms[k] > thresh ? DUCK : 1.0;
    const c = target < cur ? atk : rel;
    cur = target + (cur - target) * c;
    g[k] = cur;
  }
  duckGain = g;
  const ducked = g.reduce((a, b) => a + (b < 0.7 ? 1 : 0), 0);
  console.log(`ducking from ${rms.length} envelope frames — under speech for ${(ducked / g.length * 100).toFixed(0)}% of the run`);
} else {
  console.log('no envelope supplied — flat music level');
}

// ---- fades -----------------------------------------------------------------------------------
const FADE_IN = 1.4, FADE_OUT = 4.5;
function fade(t) {
  let f = 1;
  if (t < FADE_IN) f *= 0.5 - 0.5 * Math.cos(Math.PI * (t / FADE_IN));
  const tr = DUR - t;
  if (tr < FADE_OUT) f *= Math.max(0, 0.5 - 0.5 * Math.cos(Math.PI * (tr / FADE_OUT)));
  return f;
}

for (let i = 0; i < N; i++) {
  const t = i / SR;
  let g = norm * fade(t);
  if (duckGain) {
    const k = t * 1000 / HOP_MS;
    const k0 = Math.min(duckGain.length - 1, Math.floor(k));
    const k1 = Math.min(duckGain.length - 1, k0 + 1);
    const fr = k - k0;
    g *= duckGain[k0] * (1 - fr) + duckGain[k1] * fr;
  }
  left[i] *= g; right[i] *= g;
}

// ---- write 32-bit float WAV -------------------------------------------------------------------
const bytes = N * 2 * 4;
const buf = Buffer.alloc(44 + bytes);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + bytes, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(3, 20);   // 3 = IEEE float
buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 2 * 4, 28); buf.writeUInt16LE(8, 32); buf.writeUInt16LE(32, 34);
buf.write('data', 36); buf.writeUInt32LE(bytes, 40);
let o = 44;
let outPeak = 0;
for (let i = 0; i < N; i++) {
  buf.writeFloatLE(left[i], o); o += 4;
  buf.writeFloatLE(right[i], o); o += 4;
  outPeak = Math.max(outPeak, Math.abs(left[i]), Math.abs(right[i]));
}
fs.writeFileSync(out, buf);
const db = v => (20 * Math.log10(v || 1e-9)).toFixed(1);
console.log(`wrote ${out} — ${(bytes / 1e6).toFixed(1)} MB, peak ${db(outPeak)} dBFS`);
