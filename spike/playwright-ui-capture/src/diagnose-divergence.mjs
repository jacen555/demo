/**
 * Diagnostic (not an experiment): find WHAT differs between two runs of the
 * fully-controlled arm, so a divergence can be attributed to a mechanism rather
 * than hand-waved.
 *
 * Writes the divergent frame pair and an amplified difference map to
 * results/diag/ so the cause is visible rather than inferred.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { openDrivenPage, captureTimeline } from './driver.mjs';
import { demoScript } from './timeline.mjs';
import { hashFrameDir } from './lib/frames.mjs';
import { comparePngs } from './lib/pixels.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const spikeRoot = path.resolve(here, '..');
const targetPath = path.join(spikeRoot, 'target', 'app.html');
const diagDir = path.join(spikeRoot, 'results', 'diag');
const FPS = 30;

/** Amplified difference map: any differing pixel is painted magenta. */
async function diffMap(page, aBuf, bBuf) {
  const b64 = await page.evaluate(
    async ([aB64, bB64]) => {
      const load = async (b64x) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + b64x;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        return { ctx, data: ctx.getImageData(0, 0, c.width, c.height), c };
      };
      const a = await load(aB64);
      const b = await load(bB64);
      const out = a.ctx.createImageData(a.data.width, a.data.height);
      for (let i = 0; i < a.data.width * a.data.height; i++) {
        const o = i * 4;
        const d =
          Math.abs(a.data.data[o] - b.data.data[o]) +
          Math.abs(a.data.data[o + 1] - b.data.data[o + 1]) +
          Math.abs(a.data.data[o + 2] - b.data.data[o + 2]);
        if (d > 0) {
          out.data[o] = 255; out.data[o + 1] = 0; out.data[o + 2] = 255; out.data[o + 3] = 255;
        } else {
          const g = Math.round(a.data.data[o] * 0.25);
          out.data[o] = g; out.data[o + 1] = g; out.data[o + 2] = g; out.data[o + 3] = 255;
        }
      }
      a.ctx.putImageData(out, 0, 0);
      return a.c.toDataURL('image/png').split(',')[1];
    },
    [aBuf.toString('base64'), bBuf.toString('base64')]
  );
  return Buffer.from(b64, 'base64');
}

async function captureRun(browser, i) {
  const outDir = path.join(os.tmpdir(), `spike-diag-run${i}`);
  const page = await openDrivenPage(browser, { targetPath, useClock: true, cursor: true });
  try {
    await captureTimeline(page, {
      steps: demoScript, fps: FPS, outDir,
      useClock: true, freezeAnimations: true, cursor: true,
    });
    const { hashes } = await hashFrameDir(outDir);
    return { outDir, hashes };
  } finally {
    await page.close();
  }
}

const browser = await chromium.launch({ headless: true });
try {
  const a = await captureRun(browser, 0);
  const b = await captureRun(browser, 1);

  const divergent = [];
  for (let i = 0; i < a.hashes.length; i++) if (a.hashes[i] !== b.hashes[i]) divergent.push(i);

  console.log(`frames: ${a.hashes.length}, divergent: ${divergent.length}`);
  console.log(`first 20 divergent frames: ${divergent.slice(0, 20).join(', ')}`);

  await fs.rm(diagDir, { recursive: true, force: true });
  await fs.mkdir(diagDir, { recursive: true });

  const probe = await browser.newPage();
  try {
    for (const f of divergent.slice(0, 4)) {
      const name = `frame_${String(f).padStart(5, '0')}.png`;
      const aBuf = await fs.readFile(path.join(a.outDir, name));
      const bBuf = await fs.readFile(path.join(b.outDir, name));
      const stats = await comparePngs(probe, aBuf, bBuf);
      console.log(`frame ${f}: ${JSON.stringify(stats)}`);
      await fs.writeFile(path.join(diagDir, `f${f}_runA.png`), aBuf);
      await fs.writeFile(path.join(diagDir, `f${f}_runB.png`), bBuf);
      await fs.writeFile(path.join(diagDir, `f${f}_diff.png`), await diffMap(probe, aBuf, bBuf));
    }
  } finally {
    await probe.close();
  }

  await fs.rm(a.outDir, { recursive: true, force: true });
  await fs.rm(b.outDir, { recursive: true, force: true });
} finally {
  await browser.close();
}
