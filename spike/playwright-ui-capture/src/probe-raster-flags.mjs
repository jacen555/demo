/**
 * Probe: with the CSS-animation freeze working, are the extra Chromium raster
 * flags still needed for bit-exact output?
 *
 * History worth keeping: this probe originally reported that no flag set could
 * eliminate +/-1 rasterisation noise. That conclusion was WRONG — it was measured
 * while the animation freeze was silently a no-op (a function-shaped string
 * passed to page.evaluate is never called). The unfrozen spinner was re-rastering
 * and dragging neighbouring antialiased pixels with it. With the freeze actually
 * applied, this re-measures the question honestly.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { openDrivenPage, captureTimeline, DETERMINISTIC_RASTER_ARGS } from './driver.mjs';
import { demoScript } from './timeline.mjs';
import { hashFrameDir } from './lib/frames.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const spikeRoot = path.resolve(here, '..');
const targetPath = path.join(spikeRoot, 'target', 'app.html');
const FPS = 30;
const RUNS = 3;

const FLAG_SETS = [
  { id: 'no-extra-flags', args: [] },
  { id: 'deterministic-raster', args: DETERMINISTIC_RASTER_ARGS },
];

async function runOnce(browser, tag) {
  const outDir = path.join(os.tmpdir(), `spike-raster-${tag}`);
  const page = await openDrivenPage(browser, { targetPath, useClock: true, cursor: true });
  try {
    await captureTimeline(page, {
      steps: demoScript, fps: FPS, outDir,
      useClock: true, freezeAnimations: true, cursor: true,
    });
    const { hashes } = await hashFrameDir(outDir);
    await fs.rm(outDir, { recursive: true, force: true });
    return hashes;
  } finally {
    await page.close();
  }
}

for (const set of FLAG_SETS) {
  const browser = await chromium.launch({ headless: true, args: set.args });
  try {
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(await runOnce(browser, `${set.id}-${i}`));

    let divergent = 0;
    let first = -1;
    for (let i = 0; i < runs[0].length; i++) {
      if (!runs.every((r) => r[i] === runs[0][i])) {
        divergent++;
        if (first === -1) first = i;
      }
    }
    console.log(
      `${set.id.padEnd(22)} runs=${RUNS} frames=${runs[0].length} divergent=${String(divergent).padStart(3)} first=${first}`
    );
  } finally {
    await browser.close();
  }
}
