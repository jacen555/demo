/**
 * Decoding helper for Option A (`recordVideo`) output.
 *
 * Playwright ships its own ffmpeg build in the browser cache; we reuse it rather
 * than adding a dependency or requiring ffmpeg on PATH. That build is heavily
 * stripped (`--disable-everything`) but happens to enable exactly what is needed
 * here: matroska demuxer, libvpx_vp8 decoder, png encoder, image2 muxer.
 *
 * Note it CANNOT decode png — so this is only useful for reading webm, never for
 * re-processing the spike's own frames.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

/** Locate Playwright's bundled ffmpeg. Throws with an actionable message if absent. */
export async function resolveFfmpeg() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  let entries;
  try {
    entries = await fs.readdir(root);
  } catch {
    throw new Error(`Playwright browser cache not found at ${root} — run \`npx playwright install\``);
  }
  const dir = entries.filter((e) => e.startsWith('ffmpeg-')).sort().pop();
  if (!dir) throw new Error(`no bundled ffmpeg under ${root} — run \`npx playwright install\``);

  for (const exe of ['ffmpeg-win64.exe', 'ffmpeg-linux', 'ffmpeg-mac-x64', 'ffmpeg-mac-arm64']) {
    const candidate = path.join(root, dir, exe);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* try the next platform name */
    }
  }
  throw new Error(`bundled ffmpeg directory ${dir} contains no known executable`);
}

/**
 * Extract every CODED frame from a webm, without resampling.
 * `-fps_mode passthrough` keeps the stream's own frame cadence, so the returned
 * count is the true number of encoded frames rather than an ffmpeg-invented one.
 */
export async function extractFrames(ffmpegPath, videoPath, outDir) {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  // Argument array — never a concatenated shell string (constitution SS V).
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', videoPath,
    '-fps_mode', 'passthrough',
    path.join(outDir, 'f_%05d.png'),
  ];
  await execFileAsync(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 64 });

  const names = (await fs.readdir(outDir)).filter((n) => n.endsWith('.png')).sort();
  return { count: names.length, names, dir: outDir };
}

/** Byte size of a file. */
export async function fileSize(p) {
  return (await fs.stat(p)).size;
}
