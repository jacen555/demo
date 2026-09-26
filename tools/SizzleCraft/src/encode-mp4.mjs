import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { EXIT, CliError, guard, resolveEngineOutput, resolveInternalArtifact, openExclusiveEngineFile, requireExistingFile, describeWrite, readLockOwner, requireFiniteNumber, requirePositiveNumber, pathExists, planFooter, resolveKnob } from './cli-support.mjs';

const ENCODE_USAGE = `
encode-mp4 — encode the captured frame sequence to MP4 (pipeline stage S7).

  node encode-mp4.mjs                      plan only (default)
  node encode-mp4.mjs --apply              encode and publish <project>.mp4
  node encode-mp4.mjs --apply --replace    overwrite an existing <project>.mp4

Options
  --project <dir>   project directory (default: current directory)
  --apply           actually encode. Without it nothing is written.
  --replace         permit publishing over an existing MP4
  --help            show this message

The final rename is the publish step: it replaces the deliverable. That is why it needs
--replace rather than happening on a bare run.

Exit codes: 0 success/plan · 1 encode failed · 2 bad usage · 3 skipped (another encode holds the lock)
`.trimStart();

let encodeArgs;
try {
  ({ values: encodeArgs } = parseArgs({
    options: {
      project: { type: 'string' },
      apply: { type: 'boolean', default: false },
      replace: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  }));
} catch (err) {
  console.error(`error: ${err.message}\n\n${ENCODE_USAGE}`);
  process.exit(EXIT.USAGE);
}
if (encodeArgs.help) {
  console.log(ENCODE_USAGE);
  process.exit(EXIT.OK);
}

const projectDir = path.resolve(encodeArgs.project ?? process.cwd());
if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
  console.error(`error: --project "${projectDir}" is not an existing directory`);
  process.exit(EXIT.USAGE);
}
// This script and its encoder-page.html ship together in the plugin. Resolve the shipped encoder page
// relative to this file (not the project) so the render is self-contained and never hand-transcribed.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
// timing.json is an ENGINE-chosen read: the caller named a project directory, not this file.
// Joining it raw followed a planted link and handed the target to JSON.parse, whose error
// message quotes the first bytes of what it parsed — disclosing a file outside the project
// on the default no-flag path. Every other stage already resolves it through
// requireExistingFile; this one was the outlier.
const timingPath = guard(() => requireExistingFile(projectDir, 'timing.json', 'timing file'));
const timing = JSON.parse(fs.readFileSync(timingPath, 'utf8'));
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
// Precedence is the shared rule — argv > env > config > default. See resolveKnob.
// This read used `||`, where frame-capture.mjs used `??`, so one configured `fps: 0` was a
// hard refusal in the capture stage and a silent 30 in the encode stage — the same knob,
// the same project, two answers. It was also unvalidated here: `Number('thirty')` is NaN,
// and a NaN fps reaches the muxer as a frame duration.
const fpsKnob = resolveKnob('FPS', { config: timing.project?.fps, fallback: 30 });
const fps = guard(() =>
  requirePositiveNumber(fpsKnob.value, { name: `fps (${fpsKnob.variable} / timing.project.fps)`, max: 240 }));
// Dimensions get the same treatment as fps, and for the same reason. These used `||`,
// so a configured `width: 0` became 3840 and a non-numeric `height` became NaN — and the
// default plan then REPORTED that value and exited 0 rather than refusing. A plan that
// prints `1280xNaN` and succeeds is a false success at the boundary, not a cosmetic
// inconsistency. frame-capture.mjs validates the identical three values; now so does this.
const width = guard(() =>
  requirePositiveNumber(timing.project?.width ?? 3840, { name: 'timing.project.width', max: 16384, integer: true }));
const height = guard(() =>
  requirePositiveNumber(timing.project?.height ?? 2160, { name: 'timing.project.height', max: 16384, integer: true }));
// #7 draft-only encode speedup: draft renders may use the fast WebCodecs `realtime` latency mode
// (higher throughput, ~20% larger file). live/publish stay on `quality` so the deliverable keeps
// best compression and byte-reproducibility. Default 'live' — never silently degrade a publish.
const mode = resolveKnob('MODE', { config: timing.project?.mode, fallback: 'live' }).value;
if (!['draft', 'live', 'publish'].includes(mode)) {
  console.error(`error: unknown mode "${mode}" — expected draft, live or publish. An unrecognised value silently selected the 'quality' encoder path.`);
  process.exit(EXIT.USAGE);
}
const latencyMode = mode === 'draft' ? 'realtime' : 'quality';

// The A/V drift budget, validated HERE rather than at the comparison. `Number('oops')`
// is NaN and `Math.abs(drift) > Math.max(NaN, 1500)` is false for every drift, so the
// sync gate at the end of the encode never fires — it publishes an out-of-sync MP4 and
// exits 0. Validating before any work also makes the guard provable without an encoder.
const wantAudio = timing.intake?.silent !== true;
const toleranceMs = guard(() =>
  requireFiniteNumber(timing.intake?.toleranceMs ?? 750, { name: 'timing.intake.toleranceMs', min: 0, max: 600_000 }));
const frameDir = path.join(projectDir, 'frames');
const audioPath = path.join(projectDir, 'voiceover.mp3');
const outPath = path.join(projectDir, `${projectName}.mp4`);

// --- The safe default. The final step of this script renames the encoded file over
// <project>.mp4 — that rename IS the publish, and on a bare run it replaced an approved
// deliverable with no way back. Nothing below this point has written anything yet.
if (!encodeArgs.apply) {
  let frameCount = 0;
  try {
    frameCount = fs.readdirSync(frameDir).filter((n) => /^frame_\d+\.(png|jpe?g|webp)$/i.test(n)).length;
  } catch {
    frameCount = 0;
  }
  console.log(`plan: encode ${frameCount} frame(s) at ${fps} fps, ${width}x${height} (${mode})`);
  console.log(`  frames  ${frameDir}`);
  // The apply path REFUSES a missing narration unless intake.silent is explicitly true,
  // so the plan must not describe a video-only render it would never produce.
  if (!wantAudio) {
    console.log(`  audio   none — intentional silent render (timing.intake.silent=true)`);
  } else if (pathExists(audioPath, 'voiceover.mp3')) {
    console.log(`  audio   ${audioPath}`);
  } else {
    console.log(`  audio   MISSING (${audioPath}) — --apply would refuse rather than publish a silent video`);
    console.log(`          set timing.intake.silent=true for an intentional silent render`);
  }
  console.log(`  A/V     drift budget ${Math.max(toleranceMs, 1500)}ms`);
  console.log(`  output  ${outPath} — ${describeWrite(outPath, encodeArgs.replace)}`);
  planFooter();
  process.exit(EXIT.OK);
}
// Guarded before the lock and before any work, so a refusal costs nothing.
//
// Every destination below is ENGINE-chosen: the caller named a project directory and
// nothing else. resolveOutput deliberately FOLLOWS an in-root link because the caller
// named that path; none of these were named, so following a link here writes to a file
// nobody asked for. resolveEngineOutput refuses links outright instead.
//
// Each guard also RETURNS the entry its action then operates on. The publish guard used
// to resolve the link's canonical TARGET while renameSync replaced the link ENTRY —
// guard and action describing different files, which is "correct for a reason nothing
// enforces". Refusing links makes the two the same path by construction.
//
// These run BEFORE the encoder-page prerequisite check below, so the confinement does
// not depend on the encoder page shipping — it was that file's absence, not a guard,
// that kept these writes from being reached.
const publishPath = guard(() =>
  resolveEngineOutput(projectDir, path.basename(outPath), { apply: true, replace: encodeArgs.replace, label: 'output MP4' }));
const encoderDirPath = guard(() => {
  const abs = resolveInternalArtifact(projectDir, 'encoder', 'encoder directory');
  // An ordinary file sitting at `encoder/` made mkdirSync throw a raw EEXIST stack and
  // exit 1. It is a refusable situation with an actionable message, not a crash.
  let st;
  try {
    st = fs.lstatSync(abs, { throwIfNoEntry: false });
  } catch (err) {
    throw new CliError(`encoder directory: could not inspect ${abs} (${err.code ?? err.message}) — refusing`);
  }
  if (st !== undefined && !st.isDirectory()) {
    throw new CliError(`encoder directory "encoder" exists and is not a directory (${abs}) — remove it and re-run`);
  }
  return abs;
});
// `replace: true` is correct for both: they are engine-owned scratch reinstalled on every
// run, not a deliverable. --replace guards the MP4 the caller would lose.
const encoderHtml = guard(() =>
  resolveEngineOutput(projectDir, path.join('encoder', 'encoder-page.html'), { apply: true, replace: true, label: 'encoder page' }));
const muxerDest = guard(() =>
  resolveEngineOutput(projectDir, path.join('encoder', 'mp4-muxer.js'), { apply: true, replace: true, label: 'encoder muxer' }));

// --- Single-writer lock (prevents concurrent encoders clobbering the output).
// A stale lock whose owner PID is dead is taken over; a live owner makes us exit
// cleanly so we never truncate a good file out from under another encoder.
const lockPath = `${publishPath}.lock`;
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function acquireLock() {
  while (true) {
    try { fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); return true; }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const owner = readLockOwner(lockPath);
      if (owner.state === 'vanished') continue; // released between our write and our read
      if (owner.state === 'unreadable') {
        console.error(`${path.basename(lockPath)} could not be read (${owner.detail}) — refusing to assume no encode is running`);
        return false;
      }
      if (!pidAlive(owner.pid)) { fs.rmSync(lockPath, { force: true }); continue; } // stale -> take over
      console.error(`encode already running (pid ${owner.pid}); skipped without touching ${path.basename(publishPath)}`);
      return false;
    }
  }
}
// A skipped encode produced no MP4. Exiting 0 here told the caller an encode had
// happened, so the next pipeline stage would publish whatever stale <project>.mp4
// was lying around. EXIT.SKIPPED is distinguishable from both success and failure.
if (!acquireLock()) process.exit(EXIT.SKIPPED);

// Guarantee the lock is released on ANY exit path — including a throw during the pre-`try` setup
// below (e.g. mp4-muxer not installed, permission error on the copies) or an uncaught exception —
// so a leaked lock can never make every subsequent encode wrongly report "already running".
// 'exit' handlers must be synchronous, so use fs.rmSync.
let lockOwned = true;
function releaseLock() { if (lockOwned) { lockOwned = false; try { fs.rmSync(lockPath, { force: true }); } catch {} } }
process.on('exit', releaseLock);

fs.mkdirSync(encoderDirPath, { recursive: true });
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
fs.copyFileSync(muxerSrc, muxerDest);

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
// Encode into a temp file, then atomically rename onto publishPath only on success.
// The real output is never truncated until a complete MP4 exists, so a failed or
// late-arriving encoder can never reduce a good <project>.mp4 to 0 bytes.
const partName = `${path.basename(publishPath)}.part-${process.pid}`;
let tempFile = null;
let fd = null;

// Loaded here rather than at module scope so the lock check and the prerequisite checks
// above can report their own outcomes before a missing browser dependency masks them.
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch (err) {
  console.error(`error: playwright is required for encoding but could not be loaded — run \`npm install\` in the engine directory.\n  ${err.message}`);
  process.exit(EXIT.USAGE);
}

const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--allow-file-access-from-files'],
});

let encodeFailure = null;
try {
  // Open the temp output only now, inside the try, after Chromium has launched. If any pre-encode
  // setup (chromium.launch, etc.) throws, no stray `.part-*` file (or open fd) is left behind — the
  // catch/finally below own cleanup of everything created inside this block.
  //
  // Created EXCLUSIVELY: `'w+'` follows a link, so an entry planted at this name was opened and
  // truncated, destroying whatever it pointed at. The PID in the name made that hard to aim, not
  // safe. `'wx+'` refuses any existing entry, with no window between deciding and acting.
  //
  // The handle owns removal. Cleaning up by path deleted whatever sat at that name — including a
  // pre-existing entry the open had just refused to touch — so the guard destroyed the thing it
  // exists to protect. A handle only exists when this run created the file.
  tempFile = openExclusiveEngineFile(projectDir, partName, 'encode temp file');
  fd = tempFile.fd;
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
  if (wantAudio && !mp4HasSoundTrack(tempFile.path)) {
    throw new Error('encoded MP4 has no audio (soun) track — refusing to publish a silent video');
  }
  // A/V sync assert: video frame-duration must match narration length within tolerance.
  // Aligned with sync-verify: intake.toleranceMs is the TOTAL A/V drift budget (default 750,
  // 1500ms floor) — NOT scaled per-segment, so a materially out-of-sync MP4 cannot slip past here
  // while sync-verify would fail it.
  const videoMs = Math.round((frameFiles.length / fps) * 1000);
  const audioMs = Number(timing.durationMs || 0);
  const tolMs = Math.max(toleranceMs, 1500);
  if (wantAudio && audioMs > 0 && Math.abs(videoMs - audioMs) > tolMs) {
    tempFile.cleanup();
    throw new Error(`A/V sync drift ${Math.abs(videoMs - audioMs)}ms (video ${videoMs}ms vs audio ${audioMs}ms) exceeds ${tolMs}ms`);
  }
  fs.renameSync(tempFile.path, publishPath); // atomic publish — the entry the guard resolved
  console.log(`wrote ${publishPath} (${maxEnd} bytes, ${frameFiles.length} frames, A/V drift ${Math.abs(videoMs - audioMs)}ms)`);
} catch (err) {
  // Removes ONLY a part file this run created. The previous version deleted whatever sat at
  // partPath, so a refused collision — the one case where the open deliberately touched
  // nothing — had its existing entry destroyed by the cleanup that followed the refusal.
  //
  // A removal that fails is reported rather than swallowed: the encode error below stays the
  // primary failure, but the stranded artifact gets named so it is not left silently behind.
  const leftover = tempFile?.cleanup();
  if (leftover) console.error(`warning: ${leftover.message}`);
  encodeFailure = err;
} finally {
  await browser.close();
  releaseLock();
}

if (encodeFailure) {
  // A CliError is a refusal this script decided on, so it is reported the way every other
  // refusal in this engine is reported — with the documented usage exit code, not as an
  // uncaught stack and exit 1. A genuine encode failure still surfaces with its stack.
  if (encodeFailure instanceof CliError) {
    console.error(`error: ${encodeFailure.message}`);
    process.exit(encodeFailure.exitCode);
  }
  throw encodeFailure;
}
