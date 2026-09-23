/**
 * Probe: per-frame capture cost at the pipeline's real resolution.
 *
 * E2 measured throughput at 1280x720. tools/SizzleCraft/src/frame-capture.mjs
 * defaults to 3840x2160, and screenshot cost is strongly resolution-dependent,
 * so the 720p figure must not be extrapolated into an integration estimate.
 *
 * This measures a short driven capture at both resolutions and reports ms/frame
 * with spread, so the cost of losing worker parallelism on driven segments can
 * be stated in real numbers.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { openDrivenPage, captureTimeline, DETERMINISTIC_RASTER_ARGS } from './driver.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const spikeRoot = path.resolve(here, '..');
const targetPath = path.join(spikeRoot, 'target', 'app.html');
const resultsDir = path.join(spikeRoot, 'results');

const FPS = 30;
const REPEATS = 3;

// A short script — cost per frame is what matters, not total length.
const costScript = [
  { kind: 'settle', durationMs: 300, label: 'establish' },
  { kind: 'move',   durationMs: 400, target: '#deploy', label: 'travel' },
  { kind: 'click',  durationMs: 300, target: '#deploy', label: 'press' },
];

const RESOLUTIONS = [
  { id: '1280x720', viewport: { width: 1280, height: 720 } },
  { id: '1920x1080', viewport: { width: 1920, height: 1080 } },
  { id: '3840x2160', viewport: { width: 3840, height: 2160 } },
];

const browser = await chromium.launch({ headless: true, args: DETERMINISTIC_RASTER_ARGS });
const rows = [];

try {
  for (const res of RESOLUTIONS) {
    const perFrame = [];
    let frames = 0;
    for (let i = 0; i < REPEATS; i++) {
      const outDir = path.join(os.tmpdir(), `spike-cost-${res.id}-${i}`);
      const page = await openDrivenPage(browser, {
        targetPath, useClock: true, cursor: true, viewport: res.viewport,
      });
      try {
        const summary = await captureTimeline(page, {
          steps: costScript, fps: FPS, outDir,
          useClock: true, freezeAnimations: true, cursor: true,
        });
        frames = summary.frames;
        perFrame.push(summary.wallClockMs / summary.frames);
      } finally {
        await page.close();
        await fs.rm(outDir, { recursive: true, force: true });
      }
    }
    const mean = perFrame.reduce((s, v) => s + v, 0) / perFrame.length;
    rows.push({
      resolution: res.id,
      frames,
      repeats: REPEATS,
      msPerFrame: perFrame.map((v) => +v.toFixed(1)),
      meanMsPerFrame: +mean.toFixed(1),
      minMsPerFrame: +Math.min(...perFrame).toFixed(1),
      maxMsPerFrame: +Math.max(...perFrame).toFixed(1),
      spreadMsPerFrame: +(Math.max(...perFrame) - Math.min(...perFrame)).toFixed(1),
    });
    console.log(
      `${res.id.padEnd(11)} ${rows[rows.length - 1].meanMsPerFrame} ms/frame ` +
      `(min ${rows[rows.length - 1].minMsPerFrame}, max ${rows[rows.length - 1].maxMsPerFrame}, ` +
      `spread ${rows[rows.length - 1].spreadMsPerFrame})`
    );
  }
} finally {
  await browser.close();
}

const cores = os.availableParallelism?.() ?? os.cpus().length;
// frame-capture.mjs caps workers at 6 above 1080p, else cores-1.
const generatedWorkers4k = Math.max(1, Math.min(cores - 1, 6));
const uhd = rows.find((r) => r.resolution === '3840x2160');

const out = {
  probe: 'capture-cost',
  cores,
  fps: FPS,
  rows,
  interpretation: {
    drivenCaptureIsSequential:
      'A driven UI is a stateful sequence — frame N depends on frames 0..N-1 — so the worker ' +
      'slicing in frame-capture.mjs (which relies on every frame being a pure function of ' +
      'masterTimeline.seek(t)) cannot be applied to a driven segment.',
    generatedWorkersAt4k: generatedWorkers4k,
    drivenWorkers: 1,
    drivenSecondsPerSecondOfVideo4k: +((uhd.meanMsPerFrame * FPS) / 1000).toFixed(1),
    note:
      'Driven segments cost roughly ' + generatedWorkers4k + 'x more wall-clock per frame than ' +
      'generated ones at 4K, purely from lost parallelism. Budget driven segments as a minority ' +
      'of total runtime, or capture them at a lower resolution and upscale at encode.',
  },
};

await fs.mkdir(resultsDir, { recursive: true });
await fs.writeFile(path.join(resultsDir, 'capture-cost.json'), JSON.stringify(out, null, 2));
console.log(`\ndriven 4K: ${out.interpretation.drivenSecondsPerSecondOfVideo4k}s of capture per second of video (1 worker)`);
console.log(`generated 4K would use ${generatedWorkers4k} workers for the same frames`);
