import fs from 'node:fs';
import { EXIT, CliError, runCli, parseCli, requireExistingFile, planFooter } from './cli-support.mjs';

// MPEG Layer III frame tables (kbps). MPEG-1 vs MPEG-2/2.5 differ in bitrate table + samples/frame.
const BR_V1_L3 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
const BR_V2_L3 = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0];
const SR = { 3:[44100,48000,32000,0], 2:[22050,24000,16000,0], 0:[11025,12000,8000,0] }; // by version bits

function id3Len(b){ if(b.length>=10 && b[0]===0x49&&b[1]===0x44&&b[2]===0x33){const s=((b[6]&0x7f)<<21)|((b[7]&0x7f)<<14)|((b[8]&0x7f)<<7)|(b[9]&0x7f);return 10+s+((b[5]&0x10)?10:0);} return 0; }

function frameInfo(b,off){
  if(!(b[off]===0xff && (b[off+1]&0xe0)===0xe0)) return null;
  const verBits=(b[off+1]>>3)&0x03, layer=(b[off+1]>>1)&0x03;
  if(layer!==0x01) return null; // Layer III only
  const isV1=verBits===0x03, brIdx=(b[off+2]>>4)&0x0f, srIdx=(b[off+2]>>2)&0x03, pad=(b[off+2]>>1)&0x01;
  const bitrate=(isV1?BR_V1_L3:BR_V2_L3)[brIdx]*1000, sr=(SR[verBits]||SR[2])[srIdx];
  if(!bitrate||!sr) return null;
  const samples=isV1?1152:576;
  const size=Math.floor((isV1?144:72)*bitrate/sr)+pad;
  if(size<=0) return null;
  return { size, durMs: samples/sr*1000 };
}

const USAGE = `
append-outro — append frame-aligned silence to voiceover.mp3 for the end card (stage S7).

  node append-outro.mjs --ms 2500                 plan only (default)
  node append-outro.mjs --ms 2500 --apply         actually append

Options
  --ms <number>     outro duration in milliseconds, 0..600000. 0 is a legitimate no-op.
  --voice <file>    file to append to (default: voiceover.mp3)
  --silence <file>  silence asset to take frames from (default: silence.mp3)
  --project <dir>   project root; no path may escape it (default: current directory)
  --apply           actually append. Without it nothing is written.
  --help            show this message

Appending is not reversible, so it is opt-in. SIZZLECRAFT_OUTRO_MS still supplies the
default duration, but an unparseable value is now an error rather than a silent 2500.

Exit codes: 0 success/plan/no-op · 1 append failed · 2 bad usage
`.trimStart();

// parseCli throws HelpRequested before returning, so --help cannot reach the reads below.
// It previously could: `Number('--help')` is NaN, which fell back to 2500 ms and appended
// to the user's voiceover.
await runCli(() => {
  const { values, projectDir, apply } = parseCli({
    usage: USAGE,
    options: { ms: { type: 'string' }, voice: { type: 'string' }, silence: { type: 'string' } },
  });

  const rawTarget = values.ms ?? process.env.SIZZLECRAFT_OUTRO_MS;
  const targetMs = parseOutroMs(rawTarget);

  // 0 is a legitimate no-op (the schema allows outroMs: 0) and doing nothing IS the job.
  if (targetMs === 0) {
    console.log('append-outro: outroMs=0 -> no-op (no outro appended)');
    return EXIT.OK;
  }

  const silencePath = requireExistingFile(projectDir, values.silence ?? 'silence.mp3', 'silence asset');
  const voPath = requireExistingFile(projectDir, values.voice ?? 'voiceover.mp3', 'voice track');

  const silence = fs.readFileSync(silencePath);
  let off = id3Len(silence);
  const frames = [];
  let acc = 0;
  while (off < silence.length - 4 && acc < targetMs) {
    const fi = frameInfo(silence, off);
    if (!fi) { off++; continue; }
    frames.push(silence.subarray(off, off + fi.size));
    acc += fi.durMs;
    off += fi.size;
  }
  if (!frames.length) {
    throw new CliError(`no silence frames parsed from ${silencePath}`, EXIT.FAILED);
  }

  if (!apply) {
    console.log(`plan: append ~${Math.round(acc)}ms (${frames.length} frames) of silence`);
    console.log(`  from   ${silencePath}`);
    console.log(`  onto   ${voPath} (${fs.statSync(voPath).size} bytes, APPEND — not reversible)`);
    planFooter();
    return EXIT.OK;
  }

  fs.appendFileSync(voPath, Buffer.concat(frames));
  console.log(`appended outro ~${Math.round(acc)}ms (${frames.length} frames) onto ${voPath}`);
  return EXIT.OK;
});

/**
 * Strict outro duration. The previous `Number(raw)` with a 2500 ms fallback turned every
 * typo — and every flag, including --help — into a 2.5 second append.
 */
function parseOutroMs(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return 2500;
  const text = String(raw).trim();
  if (!/^(?:\d+|\d*\.\d+)$/.test(text)) {
    throw new CliError(`--ms must be a plain number of milliseconds — got "${raw}"`);
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > 600_000) {
    throw new CliError(`--ms must be between 0 and 600000 — got ${text}`);
  }
  return value;
}
