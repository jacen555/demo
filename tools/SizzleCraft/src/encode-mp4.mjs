import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const projectDir = process.cwd();
// This script and its encoder-page.html ship together in the plugin. Resolve the shipped encoder page
// relative to this file (not the project) so the render is self-contained and never hand-transcribed.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const timing = JSON.parse(fs.readFileSync(path.join(projectDir, 'timing.json'), 'utf8'));
// `timing.project` permits additionalProperties, so `project.name` is untrusted input that gets
// interpolated into the output filename (outPath -> lockPath/partPath). Sanitize it to a
// filename-safe basename — strip any path separators (basename + regex) and characters that are
// illegal on Windows, and trim leading/trailing dots/spaces — so a crafted/accidental value like
// `../x` can never write outside ${project.dir} or fail on Windows. Fall back to the project dir's
// own basename (then a literal) when the sanitized result is empty.
function safeFileBase(name, fallback) {
  const base = path.basename(String(name ?? ''))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();
  return base || fallback;
}
const projectName = safeFileBase(timing.project?.name, safeFileBase(path.basename(projectDir), 'video'));

// Pure-JS MP4 probe (no ffmpeg): true iff the file contains a `soun` (audio) handler track.
// Used as the post-encode audio-presence gate so a video-only ("no volume") MP4 is never
// published on the default ffmpeg-free path (where ffprobe is unavailable).
// Memory-safe: scans only top-level box HEADERS via positioned reads (never loading the large
// `mdat` payload), and reads just the small `moov` box into memory to walk for a `soun` hdlr —
// so it cannot OOM on long/high-res renders. Works whether or not `moov` is fastStart-front.
function moovHasSoun(buf, start, end) {
  let i = start;
  while (i + 8 <= end) {
    let size = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    let hdr = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(i + 8)); hdr = 16; }
    else if (size === 0) size = end - i;
    if (size < 8) break;
    if (type === 'hdlr') {
      if (buf.toString('latin1', i + hdr + 8, i + hdr + 12) === 'soun') return true;
    } else if (type === 'trak' || type === 'mdia' || type === 'minf' || type === 'stbl') {
      if (moovHasSoun(buf, i + hdr, i + size)) return true;
    }
    i += size;
  }
  return false;
}
function mp4HasSoundTrack(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    const head = Buffer.alloc(16);
    let pos = 0;
    while (pos + 8 <= fileSize) {
      if (fs.readSync(fd, head, 0, 16, pos) < 8) break;
      let size = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      let hdr = 8;
      if (size === 1) { size = Number(head.readBigUInt64BE(8)); hdr = 16; }
      else if (size === 0) size = fileSize - pos;
      if (size < 8) break;
      if (type === 'moov') {
        const moov = Buffer.alloc(size);
        fs.readSync(fd, moov, 0, size, pos);
        return moovHasSoun(moov, hdr, size);
      }
      pos += size; // skip other top-level boxes (e.g. mdat) without reading their payload
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}
const fps = Number(timing.project?.fps || process.env.SIZZLECRAFT_FPS || 30);
const width = Number(timing.project?.width || 3840);
const height = Number(timing.project?.height || 2160);
// #7 draft-only encode speedup: draft renders may use the fast WebCodecs `realtime` latency mode
// (higher throughput, ~20% larger file). live/publish stay on `quality` so the deliverable keeps
// best compression and byte-reproducibility. Default 'live' — never silently degrade a publish.
const mode = timing.project?.mode || process.env.SIZZLECRAFT_MODE || 'live';
const latencyMode = mode === 'draft' ? 'realtime' : 'quality';
const frameDir = path.join(projectDir, 'frames');
const audioPath = path.join(projectDir, 'voiceover.mp3');
const outPath = path.join(projectDir, `${projectName}.mp4`);
const encoderDir = path.join(projectDir, 'encoder');
const encoderHtml = path.join(encoderDir, 'encoder-page.html');

// --- Single-writer lock (prevents concurrent encoders clobbering the output).
// A stale lock whose owner PID is dead is taken over; a live owner makes us exit
// cleanly so we never truncate a good file out from under another encoder.
const lockPath = `${outPath}.lock`;
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function acquireLock() {
  while (true) {
    try { fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); return true; }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const owner = Number(fs.readFileSync(lockPath, 'utf8').trim());
      if (!owner || !pidAlive(owner)) { fs.rmSync(lockPath, { force: true }); continue; } // stale -> take over
      console.log(`encode already running (pid ${owner}); exiting without touching ${path.basename(outPath)}`);
      return false;
    }
  }
}
if (!acquireLock()) process.exit(0);

// Guarantee the lock is released on ANY exit path — including a throw during the pre-`try` setup
// below (e.g. mp4-muxer not installed, permission error on the copies) or an uncaught exception —
// so a leaked lock can never make every subsequent encode wrongly report "already running".
// 'exit' handlers must be synchronous, so use fs.rmSync.
let lockOwned = true;
function releaseLock() { if (lockOwned) { lockOwned = false; try { fs.rmSync(lockPath, { force: true }); } catch {} } }
process.on('exit', releaseLock);

fs.mkdirSync(encoderDir, { recursive: true });
// Install the shipped encoder page into the project's encoder/ dir so the WebCodecs encode is fully
// self-contained (no per-project transcription of the encoder HTML). Check both prerequisites first
// so a missing file fails fast with an actionable message instead of an opaque ENOENT from copyFileSync.
const encoderPageSrc = path.join(scriptDir, 'encoder-page.html');
const muxerSrc = path.join(projectDir, 'node_modules', 'mp4-muxer', 'build', 'mp4-muxer.js');
if (!fs.existsSync(encoderPageSrc)) {
  throw new Error(`encoder-page.html not found next to this script (${encoderPageSrc}) — it ships alongside encode-mp4.mjs; copy it next to the script`);
}
if (!fs.existsSync(muxerSrc)) {
  throw new Error(`mp4-muxer not installed (${muxerSrc}) — run \`npm install mp4-muxer\` in ${projectDir}`);
}
fs.copyFileSync(encoderPageSrc, encoderHtml);
fs.copyFileSync(muxerSrc, path.join(encoderDir, 'mp4-muxer.js'));

const frameIndex = (name) => Number((name.match(/^frame_(\d+)\./) || [])[1]);
const frameFiles = fs.readdirSync(frameDir)
  .filter((name) => /^frame_\d+\.(png|jpe?g|webp)$/i.test(name))
  // Sort by the numeric frame index, NOT lexicographically: the 5-digit zero-pad breaks down past
  // 99,999 frames (~55 min @30fps), where `frame_100000.*` would string-sort before `frame_99999.*`
  // and shuffle frames out of order. Numeric sort stays correct for any frame count / pad width.
  .sort((a, b) => frameIndex(a) - frameIndex(b))
  .map((name) => path.join(frameDir, name));
if (!frameFiles.length) { fs.rmSync(lockPath, { force: true }); throw new Error(`no captured frames in ${frameDir}`); }

// Audio-presence gate (C-6): the default path muxes voiceover.mp3 into the MP4. A missing
// or near-empty file would silently ship a video-only ("no volume") deliverable, so refuse
// to encode unless the project explicitly opted into a silent render (timing.intake.silent).
const wantAudio = timing.intake?.silent !== true;
let audioBase64 = null;
if (wantAudio) {
  if (!fs.existsSync(audioPath)) {
    fs.rmSync(lockPath, { force: true });
    throw new Error(`voiceover.mp3 missing in ${projectDir} — refusing to encode a silent video (set timing.intake.silent=true for an intentional silent render)`);
  }
  const audioBytes = fs.readFileSync(audioPath);
  if (audioBytes.length < 2048) {
    fs.rmSync(lockPath, { force: true });
    throw new Error(`voiceover.mp3 is only ${audioBytes.length} bytes (empty/corrupt) — refusing to encode a silent video`);
  }
  audioBase64 = audioBytes.toString('base64');
} else {
  console.log('silent render requested (timing.intake.silent=true) — encoding without an audio track');
}
let maxEnd = 0;
// Encode into a temp file, then atomically rename onto outPath only on success.
// The real output is never truncated until a complete MP4 exists, so a failed or
// late-arriving encoder can never reduce a good <project>.mp4 to 0 bytes.
const partPath = `${outPath}.part-${process.pid}`;
let fd = null;

const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--allow-file-access-from-files'],
});

try {
  // Open the temp output only now, inside the try, after Chromium has launched. If any pre-encode
  // setup (chromium.launch, etc.) throws, no stray `.part-*` file (or open fd) is left behind — the
  // catch/finally below own cleanup of everything created inside this block.
  fd = fs.openSync(partPath, 'w+');
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('console', (msg) => console.log(`[encoder] ${msg.text()}`));

  // #1 encode speedup: frames are decoded by the browser directly from file:// URLs via
  // `new Image()` + `img.decode()` (see encoder-page.html), eliminating the per-frame readFileSync +
  // base64 + CDP IPC + atob + Uint8Array.from(charCodeAt) hot path. --allow-file-access-from-files is
  // set on the launch args above. Only the muxed-output write binding is exposed to the host now.
  await page.exposeBinding('writeMp4Chunk', async (_source, bytes, position) => {
    const buffer = Buffer.from(bytes);
    fs.writeSync(fd, buffer, 0, buffer.length, position);
    maxEnd = Math.max(maxEnd, position + buffer.length);
  });

  await page.goto(pathToFileURL(encoderHtml).toString(), { waitUntil: 'load' });
  const ready = await page.evaluate(() => window.__sizzleEncoderReady === true);
  if (!ready) throw new Error('Chromium does not expose WebCodecs plus the muxer');

  const encodeResult = await page.evaluate(async (opts) => window.encodeSizzleFrames(opts), {
    frameCount: frameFiles.length,
    frameFileUrls: frameFiles.map((f) => pathToFileURL(f).toString()), // #1: browser fetches these directly
    fps,
    width,
    height,
    latencyMode, // #7: 'realtime' for draft, 'quality' for live/publish
    audioMp3Base64: audioBase64,
    bitrateKbps: 6000,
    audioBitrateKbps: 192,
    normalizePeakDb: -1.0, // loudness-normalize the voiceover so volume is reliably audible + even
  });
  if (wantAudio && !(encodeResult && encodeResult.audioChunks > 0)) {
    throw new Error(`encoder muxed no audio (audioChunks=${encodeResult && encodeResult.audioChunks}) — aborting so a silent MP4 is never published`);
  }

  fs.ftruncateSync(fd, maxEnd);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  if (maxEnd <= 0) throw new Error('encoder produced 0 bytes');
  if (wantAudio && !mp4HasSoundTrack(partPath)) {
    throw new Error('encoded MP4 has no audio (soun) track — refusing to publish a silent video');
  }
  // A/V sync assert: video frame-duration must match narration length within tolerance.
  // Aligned with sync-verify: intake.toleranceMs is the TOTAL A/V drift budget (default 750,
  // 1500ms floor) — NOT scaled per-segment, so a materially out-of-sync MP4 cannot slip past here
  // while sync-verify would fail it.
  const videoMs = Math.round((frameFiles.length / fps) * 1000);
  const audioMs = Number(timing.durationMs || 0);
  const tolMs = Math.max(Number(timing.intake?.toleranceMs ?? 750), 1500);
  if (wantAudio && audioMs > 0 && Math.abs(videoMs - audioMs) > tolMs) {
    fs.rmSync(partPath, { force: true });
    throw new Error(`A/V sync drift ${Math.abs(videoMs - audioMs)}ms (video ${videoMs}ms vs audio ${audioMs}ms) exceeds ${tolMs}ms`);
  }
  fs.renameSync(partPath, outPath); // atomic publish
  console.log(`wrote ${outPath} (${maxEnd} bytes, ${frameFiles.length} frames, A/V drift ${Math.abs(videoMs - audioMs)}ms)`);
} catch (err) {
  if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  fs.rmSync(partPath, { force: true }); // never leave a partial as the deliverable
  throw err;
} finally {
  await browser.close();
  releaseLock();
}
