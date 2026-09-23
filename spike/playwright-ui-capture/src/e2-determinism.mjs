/**
 * E2 — Option B: is a scripted, per-frame-captured UI deterministic?
 *
 * The crux question: does `page.clock` stay pinned while Playwright ACTIONS run,
 * or do actions internally wait on real time and let wall-clock into the pixels?
 *
 * TWO determinism claims are measured separately, because they have different
 * causes and different consequences:
 *
 *   LOGICAL determinism — does the page reach the same STATE at the same frame
 *     every run? Measured by a per-frame signature (virtual Date/performance
 *     readings, input values, focus, status text, progress width, row count,
 *     tooltip visibility, cursor position). This is what the timing solve, the
 *     dedup keying and any re-render actually depend on.
 *
 *   RASTER determinism — are the encoded PNG bytes identical? Strictly stronger
 *     and, as it turns out, not achievable: Chromium's rasteriser is not
 *     bit-exact across processes. So raster divergence is QUANTIFIED (how many
 *     pixels, how far off) rather than merely flagged.
 *
 * Arms isolate each control so determinism is ATTRIBUTED, not just asserted:
 *   naive      — no virtual clock, no CSS-animation freeze
 *   clockOnly  — virtual clock, no CSS-animation freeze
 *   full       — virtual clock + CSS-animation freeze
 *
 * Falsification: if `full` diverges LOGICALLY across runs, Option B is dead.
 * If `naive` is logically identical, the controls do nothing and the claim is
 * unsupported.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { openDrivenPage, captureTimeline, DETERMINISTIC_RASTER_ARGS } from './driver.mjs';
import { demoScript } from './timeline.mjs';
import { hashFrameDir, compareRuns, dedupStats } from './lib/frames.mjs';
import { comparePngs } from './lib/pixels.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const spikeRoot = path.resolve(here, '..');
const targetPath = path.join(spikeRoot, 'target', 'app.html');
const resultsDir = path.join(spikeRoot, 'results');

const FPS = 30;

const ARMS = [
  { id: 'naive',     useClock: false, freezeAnimations: false, runs: 2 },
  { id: 'clockOnly', useClock: true,  freezeAnimations: false, runs: 2 },
  { id: 'full',      useClock: true,  freezeAnimations: true,  runs: 3 },
];

async function captureArm(browser, arm, runIndex) {
  const outDir = path.join(os.tmpdir(), `spike-e2-${arm.id}-run${runIndex}`);
  const page = await openDrivenPage(browser, {
    targetPath,
    useClock: arm.useClock,
    cursor: true,
  });
  try {
    const summary = await captureTimeline(page, {
      steps: demoScript,
      fps: FPS,
      outDir,
      useClock: arm.useClock,
      freezeAnimations: arm.freezeAnimations,
      cursor: true,
    });
    const { hashes } = await hashFrameDir(outDir);
    return { summary, hashes, outDir };
  } finally {
    await page.close();
  }
}

/**
 * Quantify raster-only divergence: for every frame whose bytes differ, measure
 * how far apart the pixels actually are. A worst-case channel delta of 1 means
 * the difference is a single LSB of antialiasing, not a state difference.
 */
async function quantifyRasterNoise(browser, runs, hashesPerRun, limit = 40) {
  const divergent = [];
  for (let i = 0; i < hashesPerRun[0].length; i++) {
    if (!hashesPerRun.every((h) => h[i] === hashesPerRun[0][i])) divergent.push(i);
  }
  if (divergent.length === 0) {
    return {
      divergentFrames: 0, sampled: 0, worstChannelDelta: 0,
      worstDifferingPercent: 0, meanRmse: 0, withinOneLsb: true,
    };
  }

  const step = Math.max(1, Math.floor(divergent.length / limit));
  const sample = divergent.filter((_, i) => i % step === 0).slice(0, limit);

  const probe = await browser.newPage();
  let worstChannelDelta = 0;
  let worstDifferingPercent = 0;
  let rmseSum = 0;
  try {
    for (const f of sample) {
      const name = `frame_${String(f).padStart(5, '0')}.png`;
      const a = await fs.readFile(path.join(runs[0].outDir, name));
      const b = await fs.readFile(path.join(runs[1].outDir, name));
      const s = await comparePngs(probe, a, b);
      worstChannelDelta = Math.max(worstChannelDelta, s.maxChannelDelta);
      worstDifferingPercent = Math.max(worstDifferingPercent, s.differingPercent);
      rmseSum += s.rmse;
    }
  } finally {
    await probe.close();
  }

  return {
    divergentFrames: divergent.length,
    sampled: sample.length,
    worstChannelDelta,
    worstDifferingPercent: +worstDifferingPercent.toFixed(4),
    meanRmse: +(rmseSum / sample.length).toFixed(4),
    // The headline: a worst-case delta of 1/255 is sub-perceptual antialiasing
    // noise on element edges, not a behavioural difference.
    withinOneLsb: worstChannelDelta <= 1,
  };
}

export async function run() {
  // Raster flags applied to every arm so all arms are measured on equal terms.
  const browser = await chromium.launch({ headless: true, args: DETERMINISTIC_RASTER_ARGS });
  const armResults = [];

  try {
    for (const arm of ARMS) {
      const runs = [];
      for (let i = 0; i < arm.runs; i++) runs.push(await captureArm(browser, arm, i));

      const hashesPerRun = runs.map((r) => r.hashes);
      const sigsPerRun = runs.map((r) => r.summary.signatures);
      const rasterCmp = compareRuns(hashesPerRun);
      const logicalCmp = compareRuns(sigsPerRun);
      const wall = runs.map((r) => r.summary.wallClockMs);
      const rasterNoise = await quantifyRasterNoise(browser, runs, hashesPerRun);

      // Where the logic diverges, keep the first differing signature pair — it
      // names the exact mechanism that leaked (e.g. a real wall-clock read).
      let logicalExample = null;
      if (logicalCmp.firstDivergentFrame >= 0) {
        const f = logicalCmp.firstDivergentFrame;
        logicalExample = { frame: f, runA: sigsPerRun[0][f], runB: sigsPerRun[1][f] };
      }

      armResults.push({
        arm: arm.id,
        useClock: arm.useClock,
        freezeAnimations: arm.freezeAnimations,
        runs: arm.runs,
        frames: runs[0].summary.frames,
        logical: {
          allIdentical: logicalCmp.allIdentical,
          identicalFrames: logicalCmp.identicalFrames,
          divergentFrames: logicalCmp.divergentFrames,
          firstDivergentFrame: logicalCmp.firstDivergentFrame,
          example: logicalExample,
        },
        raster: {
          allIdentical: rasterCmp.allIdentical,
          identicalFrames: rasterCmp.identicalFrames,
          firstDivergentFrame: rasterCmp.firstDivergentFrame,
          noise: rasterNoise,
        },
        frameCountStable: rasterCmp.frameCountStable,
        frameCounts: rasterCmp.frameCounts,
        dedup: dedupStats(runs[0].hashes),
        wallClockMs: {
          runs: wall,
          min: Math.min(...wall),
          max: Math.max(...wall),
          mean: Math.round(wall.reduce((s, v) => s + v, 0) / wall.length),
          spreadMs: Math.max(...wall) - Math.min(...wall),
        },
        actionsDispatched: runs[0].summary.actionLog.length,
      });

      for (const r of runs) await fs.rm(r.outDir, { recursive: true, force: true });
    }
  } finally {
    await browser.close();
  }

  const full = armResults.find((a) => a.arm === 'full');
  const naive = armResults.find((a) => a.arm === 'naive');
  const clockOnly = armResults.find((a) => a.arm === 'clockOnly');

  const result = {
    experiment: 'e2-determinism',
    question: 'Does page.clock stay pinned while Playwright actions run, giving reproducible frame-accurate output?',
    fps: FPS,
    scriptSteps: demoScript.length,
    rasterArgs: DETERMINISTIC_RASTER_ARGS,
    arms: armResults,
    verdict: {
      logicallyDeterministic: full.logical.allIdentical,
      clockSurvivesActions: full.logical.allIdentical,
      frameCountStable: full.frameCountStable,
      controlsAreLoadBearing: !naive.logical.allIdentical,
      cssAnimationNeedsSeparateFreeze: !clockOnly.raster.allIdentical || !clockOnly.logical.allIdentical,
      rasterBitExact: full.raster.allIdentical,
      rasterNoiseWithinOneLsb: full.raster.noise.withinOneLsb,
      summary: full.logical.allIdentical
        ? `${full.frames}/${full.frames} frames logically identical across ${full.runs} runs. ` +
          `Raster bytes differ on ${full.raster.noise.divergentFrames} frames, worst case ` +
          `${full.raster.noise.worstChannelDelta}/255 on ${full.raster.noise.worstDifferingPercent}% of pixels.`
        : `FALSIFIED: logical state diverged at frame ${full.logical.firstDivergentFrame}.`,
    },
  };

  await fs.mkdir(resultsDir, { recursive: true });
  await fs.writeFile(path.join(resultsDir, 'e2-determinism.json'), JSON.stringify(result, null, 2));
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
    .then((r) => console.log(JSON.stringify(r.verdict, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    });
}
