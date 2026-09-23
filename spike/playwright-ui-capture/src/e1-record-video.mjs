/**
 * E1 — Option A: what does Playwright `recordVideo` actually guarantee?
 *
 * The commissioning brief suspected recordVideo discards the properties the
 * pipeline depends on, and asked for that to be verified rather than assumed.
 *
 * Two independent lines of evidence:
 *   1. SOURCE — read the shipped implementation
 *      (packages/playwright-core/src/server/videoRecorder.ts, bundled into
 *      node_modules/playwright-core/lib/coreBundle.js).
 *   2. MEASUREMENT — record the same scripted interaction twice, under a pinned
 *      page.clock, and compare the artifacts.
 *
 * The falsifying result would be: two runs produce byte-identical webm files
 * with a frame count that matches fps x duration. Anything else means the
 * artifact is wall-clock dependent and unusable as a deterministic frame source.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { hashBuffer } from './lib/frames.mjs';
import { resolveFfmpeg, extractFrames, fileSize } from './lib/ffmpeg.mjs';
import { VIRTUAL_EPOCH } from './driver.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const spikeRoot = path.resolve(here, '..');
const targetPath = path.join(spikeRoot, 'target', 'app.html');
const resultsDir = path.join(spikeRoot, 'results');

const VIEWPORT = { width: 1280, height: 720 };

/**
 * One recording run. Performs a fixed interaction script, under a paused virtual
 * clock, while recordVideo films the page.
 */
async function recordOnce(browser, outDir) {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: outDir, size: VIEWPORT },
  });
  const page = await context.newPage();

  // Same clock discipline Option B uses — so this is a fair test of whether the
  // clock reaches the recorder at all.
  await page.clock.install({ time: VIRTUAL_EPOCH });
  await page.goto(pathToFileURL(targetPath).toString(), { waitUntil: 'load' });
  await page.clock.pauseAt(new Date(VIRTUAL_EPOCH.getTime() + 1000));

  const startedAt = Date.now();
  await page.click('#service');
  await page.keyboard.type('ledger');
  await page.click('#tag');
  await page.keyboard.type('v1.5.0');
  await page.selectOption('#env', 'staging');
  await page.hover('#hint');
  await page.click('#deploy');
  // Virtual time drives the app's setTimeout state machine to completion.
  await page.clock.runFor(2600);
  const scriptWallMs = Date.now() - startedAt;

  await context.close(); // finalises the webm

  const files = (await fs.readdir(outDir)).filter((f) => f.endsWith('.webm'));
  if (files.length !== 1) throw new Error(`expected exactly 1 webm in ${outDir}, got ${files.length}`);
  const videoPath = path.join(outDir, files[0]);

  return {
    videoPath,
    bytes: await fileSize(videoPath),
    sha256: hashBuffer(await fs.readFile(videoPath)),
    scriptWallMs,
  };
}

export async function run() {
  const browser = await chromium.launch({ headless: true });
  const ffmpegPath = await resolveFfmpeg();
  const runs = [];

  try {
    for (let i = 0; i < 2; i++) {
      const outDir = path.join(os.tmpdir(), `spike-recordvideo-run${i}`);
      const r = await recordOnce(browser, outDir);
      const framesDir = path.join(outDir, 'decoded');
      const extracted = await extractFrames(ffmpegPath, r.videoPath, framesDir);

      // Hash the decoded frames too — a stable frame count with unstable pixels
      // would still be useless to the pipeline.
      const frameHashes = [];
      for (const name of extracted.names) {
        frameHashes.push(hashBuffer(await fs.readFile(path.join(framesDir, name))));
      }

      runs.push({ ...r, codedFrames: extracted.count, frameHashes });
      await fs.rm(outDir, { recursive: true, force: true });
    }
  } finally {
    await browser.close();
  }

  const [a, b] = runs;
  const nominalFps = 25; // hardcoded in videoRecorder.ts; NOT configurable
  const result = {
    experiment: 'e1-record-video',
    question: 'Does recordVideo produce deterministic, frame-accurate, pipeline-usable output?',
    sourceEvidence: {
      file: 'playwright-core/src/server/videoRecorder.ts (bundled in lib/coreBundle.js)',
      findings: [
        'fps is a module-level constant `var fps = 25` — recordVideo exposes no fps option.',
        'onFrame timestamps come from `frame.frameSwapWallTime` — compositor WALL-CLOCK, not page.clock virtual time.',
        'frameNumber = Math.floor((timestamp - firstFrameTimestamp) * fps): frames are bucketed by real arrival time; two frames landing in one 40 ms bucket means the earlier one is DISCARDED.',
        'Frames are only produced when the compositor swaps — a static page emits nothing, so frame count tracks visual change AND machine load.',
        'Encoder args are fixed: -c:v vp8 -b:v 1M -crf 8 -qmin 0 -qmax 50 -deadline realtime -speed 8 -threads 1 (lossy, speed-optimised, ~1 Mbps).',
        '_stop() pads the tail using monotonicTime() with Math.max(addTime, 1) — at least 1 s of wall-clock-dependent tail is always appended.',
      ],
    },
    measured: {
      runs: runs.map((r) => ({
        bytes: r.bytes,
        sha256: r.sha256.slice(0, 16),
        codedFrames: r.codedFrames,
        scriptWallMs: r.scriptWallMs,
      })),
      bytesIdentical: a.bytes === b.bytes,
      sha256Identical: a.sha256 === b.sha256,
      frameCountIdentical: a.codedFrames === b.codedFrames,
      frameCountDelta: Math.abs(a.codedFrames - b.codedFrames),
      decodedFramesIdentical:
        a.frameHashes.length === b.frameHashes.length &&
        a.frameHashes.every((h, i) => h === b.frameHashes[i]),
      nominalFps,
      pipelineFps: 30,
      fpsConfigurable: false,
    },
  };

  result.verdict = {
    deterministic: result.measured.sha256Identical && result.measured.decodedFramesIdentical,
    frameAccurate: false,
    honoursPipelineFps: false,
    summary:
      result.measured.sha256Identical && result.measured.decodedFramesIdentical
        ? 'Byte-identical across runs — investigate further before rejecting Option A.'
        : 'Non-deterministic: identical scripted input produced different artifacts.',
  };

  await fs.mkdir(resultsDir, { recursive: true });
  await fs.writeFile(path.join(resultsDir, 'e1-record-video.json'), JSON.stringify(result, null, 2));
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    });
}
