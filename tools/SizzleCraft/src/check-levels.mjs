import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';

const FF = fs.readFileSync('ffmpeg-path.txt', 'utf8').trim();

function stats(file, args = []) {
  const r = spawnSync(FF, ['-hide_banner', ...args, '-i', file,
    '-af', 'astats=metadata=1:reset=0', '-f', 'null', '-'], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');   // astats reports on stderr
  const grab = k => {
    const m = [...out.matchAll(new RegExp(k + ':\\s*(-?[\\d.]+)', 'g'))].map(x => parseFloat(x[1]));
    return m.length ? m[m.length - 1] : NaN;
  };
  return { rms: grab('RMS level dB'), peak: grab('Peak level dB') };
}

const files = [
  ['Part 1 (approved)', 'C:\\dev\\temp\\Cortex-QnA-Part1-question-bank-generation-with-music.mp4'],
  ['Part 2 (new)', 'interviewer-qna-delta-with-music.mp4'],
];

console.log('whole file');
for (const [n, f] of files) {
  const s = stats(f);
  console.log(`  ${n.padEnd(20)} RMS ${s.rms.toFixed(1)} dB   peak ${s.peak.toFixed(1)} dBFS`);
}

console.log('\nlead-in (first 1.5s — music only, no speech yet)');
for (const [n, f] of files) {
  const s = stats(f, ['-t', '1.5']);
  console.log(`  ${n.padEnd(20)} RMS ${s.rms.toFixed(1)} dB   peak ${s.peak.toFixed(1)} dBFS`);
}

console.log('\nlast 2s (end card — music only)');
for (const [n, f] of files) {
  const s = stats(f, ['-sseof', '-2']);
  console.log(`  ${n.padEnd(20)} RMS ${s.rms.toFixed(1)} dB   peak ${s.peak.toFixed(1)} dBFS`);
}
