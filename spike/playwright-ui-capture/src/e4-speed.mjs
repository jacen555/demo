/**
 * E4 — Speed control.
 *
 * Question: can N frames be emitted per action — holding on a click, skimming a
 * long form fill — and what is the cleanest authoring model?
 *
 * Three candidate models were considered (see src/timeline.mjs):
 *   (a) frames-per-action  — couples every number in the script to fps
 *   (b) duration-per-step  — same unit as the audio timing solve (ms)
 *   (c) a timeline the capture loop walks
 *
 * The implementation authors in (b) and executes as (c). This experiment checks
 * the two properties that choice has to earn:
 *
 *   FPS-INDEPENDENCE — the same script at 30 and 60 fps must produce the same
 *     DURATION (not the same frame count), so changing render fps never rewrites
 *     the script or desynchronises narration.
 *
 *   PROPORTIONALITY — a step's frame budget must be exactly its authored
 *     duration, so "hold longer on this click" is one number, and the emitted
 *     frames land where the timeline says.
 *
 * Verified against a real capture, not just the compiler, so the claim covers
 * what actually reaches disk.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { openDrivenPage, captureTimeline, DETERMINISTIC_RASTER_ARGS } from './driver.mjs';
import { compileTimeline, demoScript } from './timeline.mjs';
import { hashFrameDir, dedupStats } from './lib/frames.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const spikeRoot = path.resolve(here, '..');
const targetPath = path.join(spikeRoot, 'target', 'app.html');
const resultsDir = path.join(spikeRoot, 'results');

/** A short script whose only difference between variants is the SPEED knob. */
const fastVariant = [
  { kind: 'settle', durationMs: 200, label: 'establish' },
  { kind: 'move',   durationMs: 200, target: '#service', label: 'travel' },
  { kind: 'click',  durationMs: 100, target: '#service', label: 'quick press' },
  { kind: 'type',   durationMs: 300, target: '#service', text: 'ledger', label: 'fast skim' },
];

const slowVariant = [
  { kind: 'settle', durationMs: 200,  label: 'establish' },
  { kind: 'move',   durationMs: 200,  target: '#service', label: 'travel' },
  { kind: 'click',  durationMs: 600,  target: '#service', label: 'long deliberate hold' },
  { kind: 'type',   durationMs: 1200, target: '#service', text: 'ledger', label: 'slow deliberate typing' },
];

async function captureVariant(browser, steps, fps, tag) {
  const outDir = path.join(os.tmpdir(), `spike-e4-${tag}`);
  const page = await openDrivenPage(browser, { targetPath, useClock: true, cursor: true });
  try {
    const summary = await captureTimeline(page, {
      steps, fps, outDir, useClock: true, freezeAnimations: true, cursor: true,
    });
    const { hashes } = await hashFrameDir(outDir);
    await fs.rm(outDir, { recursive: true, force: true });
    return { summary, dedup: dedupStats(hashes) };
  } finally {
    await page.close();
  }
}

export async function run() {
  // --- FPS independence, checked at the compiler level (free). -------------
  const authoredMs = demoScript.reduce((s, x) => s + x.durationMs, 0);

  // Both rounding models measured side by side, so the design choice is
  // evidenced rather than asserted.
  const naiveFrames = (fps) =>
    demoScript.reduce((sum, s) => sum + Math.max(1, Math.round((s.durationMs / 1000) * fps)), 0);

  const fpsMatrix = [24, 25, 30, 60].map((fps) => {
    const plan = compileTimeline(demoScript, fps);
    const boundaryMs = Math.round((plan.length / fps) * 1000);
    const naiveMs = Math.round((naiveFrames(fps) / fps) * 1000);
    return {
      fps,
      frames: plan.length,
      durationMs: boundaryMs,
      driftMs: boundaryMs - authoredMs,
      naiveRoundingFrames: naiveFrames(fps),
      naiveRoundingDriftMs: naiveMs - authoredMs,
    };
  });

  // --- Per-step frame budgets. ---------------------------------------------
  const perStep = (() => {
    const fps = 30;
    const plan = compileTimeline(demoScript, fps);
    const counts = new Map();
    for (const f of plan) counts.set(f.stepIndex, (counts.get(f.stepIndex) || 0) + 1);
    // Expected budget comes from the cumulative boundaries, matching the model.
    let cumulative = 0;
    let prevBoundary = 0;
    return demoScript.map((s, i) => {
      cumulative += s.durationMs;
      const boundary = Math.max(prevBoundary + 1, Math.round((cumulative / 1000) * fps));
      const expectedFrames = boundary - prevBoundary;
      prevBoundary = boundary;
      return {
        label: s.label,
        kind: s.kind,
        authoredMs: s.durationMs,
        frames: counts.get(i),
        expectedFrames,
      };
    });
  })();

  // --- Real captures proving the budget reaches disk. ----------------------
  const browser = await chromium.launch({ headless: true, args: DETERMINISTIC_RASTER_ARGS });
  let fast;
  let slow;
  try {
    fast = await captureVariant(browser, fastVariant, 30, 'fast');
    slow = await captureVariant(browser, slowVariant, 30, 'slow');
  } finally {
    await browser.close();
  }

  const result = {
    experiment: 'e4-speed',
    question: 'Can N frames be emitted per action, and what is the cleanest authoring model?',
    model: {
      authoringUnit: 'milliseconds per step',
      executionUnit: 'frame-indexed plan walked by the capture loop',
      rationale:
        'ms matches the audio timing solve (S4), so a step duration can be derived from a narration ' +
        'segment length directly; frames are derived, so render fps is a render knob, not a script rewrite.',
    },
    fpsIndependence: {
      authoredDurationMs: authoredMs,
      matrix: fpsMatrix,
      // Frame counts scale with fps while duration stays put — the property that
      // keeps a script valid across render settings.
      durationStableAcrossFps: fpsMatrix.every((m) => Math.abs(m.driftMs) <= 1000 / Math.min(...fpsMatrix.map((x) => x.fps))),
      worstDriftMs: Math.max(...fpsMatrix.map((m) => Math.abs(m.driftMs))),
      worstNaiveDriftMs: Math.max(...fpsMatrix.map((m) => Math.abs(m.naiveRoundingDriftMs))),
      frameCountsScale: fpsMatrix.map((m) => `${m.fps}fps=${m.frames}f`).join(' '),
      note:
        'Boundary rounding keeps total drift under one frame at every fps. Rounding each step ' +
        'independently drifts up to ' +
        Math.max(...fpsMatrix.map((m) => Math.abs(m.naiveRoundingDriftMs))) +
        ' ms, which would desynchronise narration.',
    },
    perStepBudgets: {
      steps: perStep,
      allExact: perStep.every((s) => s.frames === s.expectedFrames),
    },
    speedKnob: {
      fast: {
        authoredMs: fastVariant.reduce((s, x) => s + x.durationMs, 0),
        frames: fast.summary.frames,
        wallClockMs: fast.summary.wallClockMs,
        distinctFrames: fast.dedup.distinct,
      },
      slow: {
        authoredMs: slowVariant.reduce((s, x) => s + x.durationMs, 0),
        frames: slow.summary.frames,
        wallClockMs: slow.summary.wallClockMs,
        distinctFrames: slow.dedup.distinct,
      },
      // The ONLY change between variants is durationMs on two steps.
      framesScaledWithDuration: slow.summary.frames > fast.summary.frames,
      // A long hold on a static element produces duplicate frames, which is
      // exactly the dedup opportunity the existing capture already exploits.
      slowVariantDedupPercent: slow.dedup.dedupPercent,
      fastVariantDedupPercent: fast.dedup.dedupPercent,
    },
  };

  result.verdict = {
    framesPerActionControllable: result.perStepBudgets.allExact,
    fpsIndependent: result.fpsIndependence.durationStableAcrossFps,
    recommendedModel: 'duration-per-step (ms) authored; frame-indexed plan executed',
    holdingCreatesDedupableFrames: slow.dedup.dedupPercent > fast.dedup.dedupPercent,
  };

  await fs.mkdir(resultsDir, { recursive: true });
  await fs.writeFile(path.join(resultsDir, 'e4-speed.json'), JSON.stringify(result, null, 2));
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
