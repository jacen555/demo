/**
 * S11 — MP4 chapter metadata, one chapter per segment.
 *
 * Chapters come from the MEASURED timeline: each segment's `startMs` after the S4 reflow,
 * and its authored `visual.title` (falling back to `title`, then `id`). No estimates.
 *
 * ⚠️ SUPPORT IS UNEVEN AND THIS IS NOT A UNIVERSAL WIN — see the note printed at the end.
 * Chapter markers are honoured by VLC, QuickTime and several desktop players, and are
 * commonly IGNORED by HTML5 <video> and by corporate streaming portals. If the likely
 * destination ignores them, a visible chapter list in the video description is the only
 * thing that actually works. `--list` prints one ready to paste.
 *
 * Usage:
 *   node write-chapters.mjs            # write <project>-with-music-chaptered.mp4
 *   node write-chapters.mjs --list     # print a paste-able chapter list, write nothing
 *   node write-chapters.mjs --input x.mp4 --output y.mp4
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const projectDir = process.cwd();
const argv = process.argv.slice(2);
const flag = n => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };

const safeFileBase = (name, fallback) => {
  const base = path.basename(String(name ?? '')).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return base || fallback;
};
const timing = JSON.parse(fs.readFileSync(path.join(projectDir, 'timing.json'), 'utf8'));
const projectName = safeFileBase(timing.project?.name, safeFileBase(path.basename(projectDir), 'video'));

const segs = timing.segments ?? [];
if (!segs.length) throw new Error('timing.segments is empty');
if (!segs.every(s => Number.isFinite(s.startMs) && Number.isFinite(s.endMs))) {
  throw new Error('segments lack measured startMs/endMs — run voice.mjs (S3/S4) first');
}

const titleOf = s => (s.visual?.title || s.title || s.id).replace(/\s+/g, ' ').trim();
const clock = ms => {
  const h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000), sec = Math.floor(ms % 60000 / 1000);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
           : `${m}:${String(sec).padStart(2, '0')}`;
};

// A chapter runs from its segment's start to the NEXT segment's start, so the inter-segment
// gap belongs to the chapter it follows rather than falling into a hole. The first chapter
// starts at 0 so the lead-in is inside chapter 1, not before it.
const chapters = segs.map((s, i) => ({
  startMs: i === 0 ? 0 : s.startMs,
  endMs: i === segs.length - 1 ? timing.durationMs : segs[i + 1].startMs,
  title: titleOf(s),
}));

if (flag('list')) {
  console.log('Chapter list — paste into the video description where players ignore embedded markers:\n');
  for (const c of chapters) console.log(`${clock(c.startMs)}  ${c.title}`);
  process.exit(0);
}

const meta = ';FFMETADATA1\n' + chapters.map(c =>
  `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${c.startMs}\nEND=${c.endMs}\ntitle=${c.title.replace(/[=;#\\\n]/g, ' ')}\n`).join('');

const metaPath = path.join(projectDir, 'chapters.ffmeta');
fs.writeFileSync(metaPath, meta);

const input = opt('input', `${projectName}-with-music.mp4`);
const output = opt('output', `${projectName}-with-music-chaptered.mp4`);
if (!fs.existsSync(path.join(projectDir, input))) throw new Error(`not found: ${input} — run S9 first`);

const ff = fs.readFileSync(path.join(projectDir, 'ffmpeg-path.txt'), 'utf8').trim();
execFileSync(ff, ['-y', '-hide_banner', '-loglevel', 'error',
  '-i', input, '-i', 'chapters.ffmeta',
  '-map_metadata', '1', '-map_chapters', '1',
  '-c', 'copy', '-movflags', '+faststart', output], { stdio: 'inherit' });

console.log(`wrote ${output} — ${chapters.length} chapters, streams copied untouched`);
for (const c of chapters) console.log(`  ${clock(c.startMs)}  ${c.title}`);
console.log('');
console.log('  ⚠️  Chapter support is uneven. VLC, QuickTime and some desktop players honour');
console.log('      these markers; HTML5 <video> and many corporate streaming portals IGNORE');
console.log('      them entirely. If the destination is one of the latter, this file is');
console.log('      identical to the input in every way the viewer can see.');
console.log('      Run with --list for a chapter list to paste into the description, which');
console.log('      is the only form that works everywhere.');
