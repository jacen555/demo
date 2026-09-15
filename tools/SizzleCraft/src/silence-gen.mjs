// Generates silence.mp3 matching the msedge-tts profile exactly
// (audio-24khz-96kbitrate-mono-mp3), so byte concatenation stays frame-aligned.
//
// MPEG-2 Layer III, 24 kHz, 96 kbps, mono:
//   frame header  FF F3 A4 C0
//   frame size    72 * 96000 / 24000 = 288 bytes
//   frame time    576 samples / 24000 Hz = 24 ms
// Side info + main_data are left zeroed, which every compliant decoder renders as silence.
//
// Usage: node silence-gen.mjs <outFile> <targetMs>
import fs from 'node:fs';

const FRAME_BYTES = 288;
const FRAME_MS = 576 / 24000 * 1000; // 24

const out = process.argv[2] || 'silence.mp3';
const targetMs = Number(process.argv[3] || 3500);
if (!Number.isFinite(targetMs) || targetMs <= 0) throw new Error(`bad targetMs ${process.argv[3]}`);

const frames = Math.max(1, Math.round(targetMs / FRAME_MS));
const buf = Buffer.alloc(FRAME_BYTES * frames);
for (let i = 0; i < frames; i++) {
  const o = i * FRAME_BYTES;
  buf[o] = 0xFF; buf[o + 1] = 0xF3; buf[o + 2] = 0xA4; buf[o + 3] = 0xC0;
}
fs.writeFileSync(out, buf);
console.log(`${out}: ${frames} frames, ${(frames * FRAME_MS).toFixed(0)}ms, ${buf.length} bytes`);
