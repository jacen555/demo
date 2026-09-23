/**
 * E5 — Zoom: CSS transform vs crop-and-scale.
 *
 * Both mechanisms magnify the same source region to the same output resolution,
 * so the comparison is about how much DETAIL survives.
 *
 *   Method 1 — CSS transform: scale the document about a focal point. The page
 *     re-rasterises at the zoomed scale, so text is re-shaped at the larger size.
 *   Method 2 — crop-and-scale: screenshot at 1x, crop the region, resample up.
 *     Only (W/Z x H/Z) source pixels exist, so detail is interpolated.
 *
 * Measured against a GROUND TRUTH rather than against each other: the same
 * region captured at deviceScaleFactor = Z, which is a genuine supersampled
 * render of that region. This avoids the trap of declaring one method the
 * reference and is independent of which resampling filter method 2 uses —
 * no filter can invent detail that was never sampled.
 *
 * Metrics:
 *   - RMSE vs ground truth (lower is closer to a true zoomed render)
 *   - mean gradient magnitude, i.e. acutance (upscaling smears edges and
 *     measurably lowers it)
 *
 * Also checks the two practical questions: does a CSS transform break the
 * coordinates Playwright clicks, and can the zoom be ramped smoothly?
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { openDrivenPage, applyZoom, clearZoom, DETERMINISTIC_RASTER_ARGS } from './driver.mjs';
import { comparePngs, gradientEnergy, cropAndScale } from './lib/pixels.mjs';
import { easeInOutCubic } from './timeline.mjs';
import { hashBuffer } from './lib/frames.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const spikeRoot = path.resolve(here, '..');
const targetPath = path.join(spikeRoot, 'target', 'app.html');
const resultsDir = path.join(spikeRoot, 'results');

const VIEWPORT = { width: 1280, height: 720 };
const ZOOM = 2.5;
// Focal point: the dense monospace "Recent activity" table — the legibility
// case that actually matters in a product demo.
const FOCUS = { x: 660, y: 165 };

/**
 * Source region that a CSS `scale(Z)` about FOCUS makes visible.
 * A point p maps to focus + (p - focus) * Z, so the visible source span is
 * [focus * (1 - 1/Z), focus * (1 - 1/Z) + size/Z].
 */
function visibleSourceRegion(focus, zoom, viewport) {
  return {
    x: focus.x * (1 - 1 / zoom),
    y: focus.y * (1 - 1 / zoom),
    width: viewport.width / zoom,
    height: viewport.height / zoom,
  };
}

export async function run() {
  const browser = await chromium.launch({ headless: true, args: DETERMINISTIC_RASTER_ARGS });
  const outDir = path.join(resultsDir, 'zoom');
  await fs.mkdir(outDir, { recursive: true });
  const region = visibleSourceRegion(FOCUS, ZOOM, VIEWPORT);

  const result = { experiment: 'e5-zoom', zoom: ZOOM, focus: FOCUS, viewport: VIEWPORT, region };

  try {
    // --- Method 1: CSS transform ------------------------------------------
    const page = await openDrivenPage(browser, { targetPath, useClock: true, cursor: false });
    await applyZoom(page, { from: ZOOM, to: ZOOM, focus: FOCUS }, { eased: 1 });
    const cssShot = await page.screenshot({ type: 'png', caret: 'hide' });
    await fs.writeFile(path.join(outDir, 'method1-css-transform.png'), cssShot);

    // Does a transformed page still resolve click coordinates correctly?
    // Tested at a focal point that KEEPS the target on screen. Zooming into the
    // table and then clicking a button the zoom pushed out of the viewport would
    // fail for the correct reason (not visible), and would say nothing about
    // whether transforms break coordinate resolution.
    await clearZoom(page);
    const deployBox = await page.locator('#deploy').boundingBox();
    const deployFocus = { x: deployBox.x + deployBox.width / 2, y: deployBox.y + deployBox.height / 2 };
    await applyZoom(page, { from: ZOOM, to: ZOOM, focus: deployFocus }, { eased: 1 });

    let clickWorksUnderZoom = false;
    let clickError = null;
    let clickedPointUnderZoom = null;
    try {
      await page.click('#deploy', { timeout: 3000 });
      clickWorksUnderZoom = (await page.evaluate(() => window.__clicks || 0)) === 1;
      // The transformed bounding box is what Playwright targets, so the overlay
      // can still be placed correctly while zoomed.
      const zoomedBox = await page.locator('#deploy').boundingBox();
      clickedPointUnderZoom = {
        zoomedBoxWidth: +zoomedBox.width.toFixed(1),
        unzoomedBoxWidth: +deployBox.width.toFixed(1),
        scaleObserved: +(zoomedBox.width / deployBox.width).toFixed(3),
      };
    } catch (e) {
      clickError = e.message.split('\n')[0];
    }

    // The companion negative case, recorded because it is a real authoring
    // constraint: a target the zoom moves off-screen is genuinely unclickable.
    await clearZoom(page);
    await applyZoom(page, { from: ZOOM, to: ZOOM, focus: FOCUS }, { eased: 1 });
    let offscreenTargetClickable = true;
    try {
      await page.click('#deploy', { timeout: 1500 });
    } catch {
      offscreenTargetClickable = false;
    }
    await clearZoom(page);

    // --- Method 2: crop-and-scale from a 1x capture -----------------------
    const flatShot = await page.screenshot({ type: 'png', caret: 'hide' });
    await fs.writeFile(path.join(outDir, 'source-1x.png'), flatShot);
    await page.close();

    const probe = await browser.newPage();
    const croppedShot = await cropAndScale(probe, flatShot, region, VIEWPORT.width, VIEWPORT.height);
    await fs.writeFile(path.join(outDir, 'method2-crop-and-scale.png'), croppedShot);

    // --- Ground truth: supersampled render of the same region -------------
    const truthPage = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: ZOOM });
    await truthPage.goto(pathToFileURL(targetPath).toString(), { waitUntil: 'load' });
    await truthPage.evaluate(() => document.fonts?.ready);
    const truthShot = await truthPage.screenshot({ type: 'png', caret: 'hide', clip: region });
    await fs.writeFile(path.join(outDir, 'ground-truth-supersampled.png'), truthShot);
    await truthPage.close();

    // --- Measure ----------------------------------------------------------
    const [cssVsTruth, cropVsTruth] = [
      await comparePngs(probe, cssShot, truthShot),
      await comparePngs(probe, croppedShot, truthShot),
    ];
    const [cssGrad, cropGrad, truthGrad] = [
      await gradientEnergy(probe, cssShot),
      await gradientEnergy(probe, croppedShot),
      await gradientEnergy(probe, truthShot),
    ];

    result.groundTruth = { source: `deviceScaleFactor=${ZOOM} clipped render`, ...truthGrad };
    result.method1CssTransform = {
      vsGroundTruth: cssVsTruth,
      acutance: cssGrad.meanGradient,
      clickWorksUnderZoom,
      clickError,
      clickedPointUnderZoom,
      offscreenTargetClickable,
      file: 'results/zoom/method1-css-transform.png',
    };
    result.method2CropAndScale = {
      vsGroundTruth: cropVsTruth,
      acutance: cropGrad.meanGradient,
      sourcePixelsAvailable: Math.round(region.width) * Math.round(region.height),
      outputPixels: VIEWPORT.width * VIEWPORT.height,
      // The information-theoretic core: at zoom Z there are Z^2 fewer source
      // pixels than output pixels. No resampling filter recovers that.
      pixelDeficitFactor: +(
        (VIEWPORT.width * VIEWPORT.height) /
        (Math.round(region.width) * Math.round(region.height))
      ).toFixed(2),
      file: 'results/zoom/method2-crop-and-scale.png',
    };

    // --- Smooth ramp: can zoom be animated, and is it deterministic? -------
    const rampPage = await openDrivenPage(browser, { targetPath, useClock: true, cursor: false });
    const scales = [];
    const rampHashes = [];
    const STEPS = 12;
    for (let i = 0; i < STEPS; i++) {
      const eased = easeInOutCubic(i / (STEPS - 1));
      const scale = await applyZoom(rampPage, { from: 1, to: ZOOM, focus: FOCUS }, { eased });
      scales.push(+scale.toFixed(4));
      rampHashes.push(hashBuffer(await rampPage.screenshot({ type: 'png', caret: 'hide' })));
    }
    await rampPage.close();

    // Re-run the ramp to confirm the zoom path is reproducible frame for frame.
    const rampPage2 = await openDrivenPage(browser, { targetPath, useClock: true, cursor: false });
    const rampHashes2 = [];
    for (let i = 0; i < STEPS; i++) {
      await applyZoom(rampPage2, { from: 1, to: ZOOM, focus: FOCUS }, { eased: easeInOutCubic(i / (STEPS - 1)) });
      rampHashes2.push(hashBuffer(await rampPage2.screenshot({ type: 'png', caret: 'hide' })));
    }
    await rampPage2.close();

    result.ramp = {
      steps: STEPS,
      scales,
      distinctFrames: new Set(rampHashes).size,
      deterministic: rampHashes.every((h, i) => h === rampHashes2[i]),
      easing: 'easeInOutCubic applied to the scale factor',
    };

    await probe.close();
  } finally {
    await browser.close();
  }

  const m1 = result.method1CssTransform;
  const m2 = result.method2CropAndScale;
  result.verdict = {
    winner: m1.vsGroundTruth.rmse < m2.vsGroundTruth.rmse ? 'css-transform' : 'crop-and-scale',
    rmseCss: m1.vsGroundTruth.rmse,
    rmseCrop: m2.vsGroundTruth.rmse,
    acutanceGroundTruth: result.groundTruth.meanGradient,
    acutanceCss: m1.acutance,
    acutanceCrop: m2.acutance,
    cssPreservesHitTesting: m1.clickWorksUnderZoom,
    zoomCanHideTargets: m1.offscreenTargetClickable === false,
    acutanceLossCropPercent: +(
      ((result.groundTruth.meanGradient - m2.acutance) / result.groundTruth.meanGradient) * 100
    ).toFixed(1),
    rampSmoothAndDeterministic: result.ramp.deterministic && result.ramp.distinctFrames === result.ramp.steps,
  };

  await fs.writeFile(path.join(resultsDir, 'e5-zoom.json'), JSON.stringify(result, null, 2));
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
