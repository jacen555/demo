#!/usr/bin/env node
/**
 * probe-render-capability.mjs — what can THIS machine do, and which levers are worth pulling?
 *
 * Run before committing to a render target. Capability is measured or runtime-tested;
 * nothing is inferred from a capability list, because ffmpeg advertises encoders that were
 * compiled in regardless of whether the hardware exists.
 *
 * WHAT THIS IS NOT: a benchmark. It reports what the machine *is* and ranks the levers
 * worth pulling. The per-lever speedups quoted are REFERENCE measurements from another
 * machine and are labelled as such — they indicate which lever to reach for first, not
 * what it will be worth here. Measure the lever you pick.
 *
 * Usage:  node probe-render-capability.mjs [--ffmpeg <path>]
 */

import { execFileSync, execSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REFERENCE = 'Azure VM · Xeon Platinum 8370C · 8 physical / 16 logical · 64 GB · no GPU';

const argv = process.argv.slice(2);
const ffFlag = argv.indexOf('--ffmpeg');
let FFMPEG = ffFlag !== -1 ? argv[ffFlag + 1] : null;
if (!FFMPEG && fs.existsSync('ffmpeg-path.txt')) FFMPEG = fs.readFileSync('ffmpeg-path.txt', 'utf8').trim();
FFMPEG ||= 'ffmpeg';

const ok = s => `  \u2713 ${s}`;
const no = s => `  \u2717 ${s}`;
const bullet = s => `    ${s}`;
const heading = t => console.log(`\n${t}\n${'-'.repeat(t.length)}`);

// The heavy-frame worker cap is a constant in frame-capture.mjs. Read it rather than
// duplicating it — a second copy would silently lie the moment that file changed.
function readHeavyCap() {
  try {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'frame-capture.mjs'), 'utf8');
    const m = /heavyFrames\s*\?\s*(\d+)\s*:/.exec(src);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

// ---- CPU / memory -------------------------------------------------------------------
heading('CPU and memory');
const cpus = os.cpus();
const logical = os.availableParallelism?.() ?? cpus.length;
const totalGB = +(os.totalmem() / 1024 ** 3).toFixed(1);
let physical = null;
try {
  physical = Number(execSync(
    'powershell -NoProfile -Command "(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum"',
    { encoding: 'utf8' }).trim()) || null;
} catch { /* non-Windows or blocked — logical count still reported */ }

console.log(bullet(cpus[0]?.model?.trim() ?? 'unknown CPU'));
console.log(bullet(`${physical ?? '?'} physical / ${logical} logical cores · ${totalGB} GB RAM`));

// ---- GPU presence -------------------------------------------------------------------
heading('Display adapters');
let adapters = [];
try {
  adapters = execSync(
    'powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"',
    { encoding: 'utf8' }).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
} catch { /* ignore */ }

const virtualOnly = adapters.length > 0 &&
  adapters.every(a => /hyper-v|remote display|basic display|virtual|vmware|virtualbox/i.test(a));
adapters.forEach(a => console.log(bullet(a)));
if (virtualOnly) console.log(no('All adapters are virtual — no GPU passthrough.'));

// ---- Hardware encoders: TEST, do not trust the list ---------------------------------
heading('Hardware encoders (runtime-tested, not listed)');
const working = [];
for (const enc of ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_vaapi']) {
  try {
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=1',
      '-c:v', enc, '-f', 'null', '-'], { stdio: 'pipe' });
    working.push(enc);
    console.log(ok(`${enc} — WORKS`));
  } catch (e) {
    const msg = String(e.stderr ?? e.message).split(/\r?\n/).find(l => l.includes('[' + enc)) ?? '';
    console.log(no(`${enc} — unavailable${msg ? ': ' + msg.replace(/\[.*?\]\s*/, '').trim() : ''}`));
  }
}
console.log('');
if (!working.length) {
  console.log(bullet('No hardware encode. S7 is CPU-bound — x264 preset and thread count'));
  console.log(bullet('are the only encode levers on this machine.'));
} else {
  console.log(bullet(`Hardware encode available: ${working.join(', ')}`));
  console.log(bullet('Expect a large S7 win, but verify quality at 1:1 before adopting —'));
  console.log(bullet('hardware encoders trade quality for speed at a given bitrate.'));
}

// ---- Recommendations ----------------------------------------------------------------
heading('Recommended levers, highest value first');
console.log(bullet(`(speedups below are REFERENCE figures from: ${REFERENCE})`));

const heavyCap = readHeavyCap();
const recs = [
  ['frameFormat: jpeg (q88)',
   'Reference: 13x faster than PNG at 4K (13.05 vs 1.00 fps) and ~1/13th the disk, with no ' +
   'visible quality cost at 1:1. At high resolution this outranks resolution itself; below ' +
   '1080p resolution still dominates.'],
];

if (heavyCap && logical > heavyCap + 2) {
  recs.push([`the heavy-frame worker cap (frame-capture.mjs, currently ${heavyCap})`,
    `Workers are capped at ${heavyCap} above 1080p but use cores-1 below it; this machine has ` +
    `${logical} logical cores. On the reference machine 4K peaked at only 2.2-2.3 GB, far from OOM — ` +
    `BUT raising it there measured FLAT (9.77 / 9.87 / 9.53 fps at 6 / 10 / 14 workers), so something ` +
    `saturates before the core count does. Measure before changing it; do not assume headroom means speed.`]);
}

if (totalGB >= 32) {
  recs.push(['RAM disk for the frame store',
    `${totalGB} GB available. A 4K JPEG frame set ran ~1.25 GB for a 4-minute video on the reference ` +
    'machine, so it fits in memory with room to spare and removes disk I/O from capture and encode. ' +
    'UNMEASURED — proposed, not verified. Only worth it with real headroom.']);
}

if (!working.length) {
  recs.push(['x264 preset / thread count',
    'Encode is CPU-bound here. -preset faster/veryfast trades file size for wall-clock, and x264 ' +
    'threads scale well across cores. UNMEASURED on this pipeline.']);
}

recs.push(['draft renders at render.preview',
  'Reference: ~8x cheaper (5.5 min vs 42.4 min for S5-S7 at half scale / half fps) — NOT the 2x that ' +
  '"halving resolution halves render time" implies. On the reference project the draft caught three ' +
  'authoring defects that would each have cost a full cycle.']);

recs.forEach(([t, why], i) => {
  console.log(`\n  ${i + 1}. ${t}`);
  console.log(`     ${why}`);
});

// ---- Things that do NOT help --------------------------------------------------------
heading('Known non-levers');
console.log(bullet('Dedup, on animated content. ~0% hold in the body of an animated render — a live'));
console.log(bullet('CSS background animation trips the motion guard, so body frames never hold.'));
console.log(bullet(''));
console.log(bullet('Byte-identical frames are NOT deduped frames. A deterministic renderer produces'));
console.log(bullet('identical bytes at FULL cost. The only true measure is the NTFS hardlink count:'));
console.log(bullet('`fsutil hardlink list <frame>` — >1 path means genuinely held.'));
if (virtualOnly) {
  console.log(bullet(''));
  console.log(bullet('Headless-Chrome GPU flags. Without a GPU, Chrome is on SwiftShader —'));
  console.log(bullet('software rasterisation on the same CPU cores. The flags change nothing.'));
}
console.log('');
