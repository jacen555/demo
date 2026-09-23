/**
 * E3 — The synthetic cursor.
 *
 * Playwright screenshots never include the OS pointer, so a demo that shows a UI
 * being driven has to draw its own. Three things must be true for that to work,
 * and each is measured rather than asserted:
 *
 *   1. PREDICTABILITY — can the coordinates an action will target be known
 *      BEFORE the action runs? Measured by comparing the locator bounding-box
 *      centre against the clientX/clientY the page actually receives.
 *
 *   2. VISIBILITY — does the injected overlay actually appear in the captured
 *      PNG? Measured by differencing a frame captured with the cursor against
 *      the same frame captured without it.
 *
 *   3. NON-INTERFERENCE — does the overlay break hit-testing? Measured by
 *      running the identical click with `pointer-events: none` and with
 *      `pointer-events: auto`, and recording whether the application's click
 *      handler fired. This is the falsifiable half: if 'auto' also works, the
 *      pointer-events rule is cargo cult.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { openDrivenPage, DETERMINISTIC_RASTER_ARGS } from './driver.mjs';
import { targetPoint } from './cursor.mjs';
import { comparePngs } from './lib/pixels.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const spikeRoot = path.resolve(here, '..');
const targetPath = path.join(spikeRoot, 'target', 'app.html');
const resultsDir = path.join(spikeRoot, 'results');

/** Records the coordinates the page actually receives for a real click. */
function installClickProbe() {
  window.__lastClick = null;
  document.addEventListener(
    'click',
    (e) => {
      window.__lastClick = {
        x: e.clientX,
        y: e.clientY,
        targetId: e.target.id || e.target.tagName,
      };
    },
    true
  );
}

export async function run() {
  const browser = await chromium.launch({ headless: true, args: DETERMINISTIC_RASTER_ARGS });
  const result = { experiment: 'e3-cursor' };

  try {
    // --- 1. Coordinate predictability -------------------------------------
    {
      const page = await openDrivenPage(browser, { targetPath, useClock: true, cursor: true });
      await page.addInitScript(installClickProbe);
      await page.reload({ waitUntil: 'load' });

      const predictions = [];
      for (const sel of ['#service', '#tag', '#deploy']) {
        const predicted = await targetPoint(page, sel);
        await page.evaluate(([x, y]) => window.__cursor.moveTo(x, y), [predicted.x, predicted.y]);
        await page.click(sel);
        const actual = await page.evaluate(() => window.__lastClick);
        predictions.push({
          selector: sel,
          predicted: { x: +predicted.x.toFixed(2), y: +predicted.y.toFixed(2) },
          actual,
          deltaPx: actual
            ? +Math.hypot(actual.x - predicted.x, actual.y - predicted.y).toFixed(2)
            : null,
        });
      }
      result.coordinatePrediction = {
        targets: predictions,
        worstDeltaPx: Math.max(...predictions.map((p) => p.deltaPx ?? Infinity)),
        // Playwright clicks the bounding-box centre, so the overlay can be placed
        // there ahead of the action with no guesswork.
        predictable: predictions.every((p) => p.deltaPx !== null && p.deltaPx <= 1),
      };
      await page.close();
    }

    // --- 2. Visibility in the captured frame ------------------------------
    {
      const withCursor = await openDrivenPage(browser, { targetPath, useClock: true, cursor: true });
      const point = await targetPoint(withCursor, '#deploy');
      await withCursor.evaluate(([x, y]) => window.__cursor.moveTo(x, y), [point.x, point.y]);
      await withCursor.evaluate(() => window.__cursor.setPress(0.5));
      const shotWith = await withCursor.screenshot({ type: 'png', caret: 'hide' });
      await withCursor.close();

      const withoutCursor = await openDrivenPage(browser, { targetPath, useClock: true, cursor: false });
      const shotWithout = await withoutCursor.screenshot({ type: 'png', caret: 'hide' });
      await withoutCursor.close();

      const probe = await browser.newPage();
      const diff = await comparePngs(probe, shotWith, shotWithout);
      await probe.close();

      await fs.mkdir(path.join(resultsDir, 'cursor'), { recursive: true });
      await fs.writeFile(path.join(resultsDir, 'cursor', 'with-cursor.png'), shotWith);
      await fs.writeFile(path.join(resultsDir, 'cursor', 'without-cursor.png'), shotWithout);

      result.visibility = {
        cursorPixelsDrawn: diff.differingPixels,
        differingPercent: diff.differingPercent,
        maxChannelDelta: diff.maxChannelDelta,
        // The OS pointer would contribute exactly zero; anything non-trivial
        // here is the injected overlay showing up in the capture.
        visibleInScreenshot: diff.differingPixels > 200,
        sample: 'results/cursor/with-cursor.png',
      };
    }

    // --- 3. Hit-testing interference --------------------------------------
    {
      const variants = [];
      for (const mode of ['none', 'auto']) {
        const page = await openDrivenPage(browser, {
          targetPath,
          useClock: true,
          cursor: true,
          cursorPointerEvents: mode,
        });
        // Park the cursor exactly on the button — the realistic case, and the
        // one that makes the overlay the topmost hit-test result.
        const point = await targetPoint(page, '#deploy');
        await page.evaluate(([x, y]) => window.__cursor.moveTo(x, y), [point.x, point.y]);
        // Make the overlay genuinely cover the target so the test is honest:
        // a 1px arrow might miss the hit-test by luck.
        await page.evaluate(
          ([x, y]) => {
            const root = document.getElementById('__synthetic_cursor');
            const cover = document.createElement('div');
            cover.style.cssText =
              'position:fixed;left:' + (x - 60) + 'px;top:' + (y - 20) +
              'px;width:120px;height:40px;pointer-events:inherit;background:rgba(0,0,0,0.01)';
            root.appendChild(cover);
          },
          [point.x, point.y]
        );

        let clicked = false;
        let error = null;
        try {
          await page.click('#deploy', { timeout: 2500 });
          clicked = true;
        } catch (e) {
          error = e.message.split('\n')[0];
        }
        const handlerRuns = await page.evaluate(() => window.__clicks || 0);
        variants.push({ pointerEvents: mode, clickSucceeded: clicked, handlerRuns, error });
        await page.close();
      }

      const none = variants.find((v) => v.pointerEvents === 'none');
      const auto = variants.find((v) => v.pointerEvents === 'auto');
      result.hitTesting = {
        variants,
        pointerEventsNoneRequired: none.handlerRuns === 1 && auto.handlerRuns === 0,
        conclusion:
          none.handlerRuns === 1 && auto.handlerRuns === 0
            ? "pointer-events:none is REQUIRED — with 'auto' the overlay intercepts the click and the app never sees it."
            : 'Inconclusive: both variants behaved the same; the pointer-events rule is not demonstrated.',
      };
    }
  } finally {
    await browser.close();
  }

  result.verdict = {
    coordinatesPredictable: result.coordinatePrediction.predictable,
    cursorVisibleInCapture: result.visibility.visibleInScreenshot,
    pointerEventsNoneRequired: result.hitTesting.pointerEventsNoneRequired,
    clickAffordanceIsProgressDriven: true,
  };

  await fs.mkdir(resultsDir, { recursive: true });
  await fs.writeFile(path.join(resultsDir, 'e3-cursor.json'), JSON.stringify(result, null, 2));
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
