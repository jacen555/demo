/**
 * The driven-capture loop — Option B.
 *
 * Walks a compiled timeline, dispatching Playwright actions at exact frame
 * indices and emitting one screenshot per frame, with virtual time advanced by
 * exactly one frame between shots.
 *
 * THREE independent sources of time have to be pinned; missing any one of them
 * leaks wall-clock into the pixels:
 *
 *   1. JS-visible time  — Date, setTimeout, setInterval, requestAnimationFrame,
 *                         performance.now(). Handled by `page.clock`.
 *   2. CSS animations   — driven by the compositor's document timeline, which
 *                         `page.clock` does NOT control. Handled by the same
 *                         pause + negative-animation-delay technique that
 *                         tools/SizzleCraft/src/frame-capture.mjs already uses.
 *   3. The text caret   — blinks on a compositor timer. Handled by Playwright's
 *                         screenshot `caret: 'hide'` default.
 *
 * E2 measures each of these by turning them off one at a time.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileTimeline, frameMs } from './timeline.mjs';
import { cursorInitScript, targetPoint, lerpPoint } from './cursor.mjs';

/** Virtual epoch. Fixed so every run starts from the same wall-clock reading. */
export const VIRTUAL_EPOCH = new Date('2025-01-01T08:15:00.000Z');

/**
 * Freeze every CSS animation at a given document time.
 *
 * Re-scans the DOM each call rather than caching the element set once, because a
 * driven UI mutates: the spinner in target/app.html does not exist until Deploy
 * is pressed. frame-capture.mjs can afford a sparse re-scan (its scene is
 * generated and its trigger points are known); a driven scene cannot.
 *
 * NOTE: passed to page.evaluate as a REAL FUNCTION, never as a function-shaped
 * string. Playwright evaluates a string as an expression, so `page.evaluate('(s) => {...}', x)`
 * merely constructs a function and discards it — it silently does nothing and
 * returns undefined. That failure mode is invisible and fakes a passing result.
 */
function freezeAnimationsAt(seconds) {
  for (const el of document.querySelectorAll('*')) {
    const st = getComputedStyle(el);
    if (!st.animationName || st.animationName === 'none') continue;
    if (el.__baseDelay === undefined) el.__baseDelay = parseFloat(st.animationDelay) || 0;
    el.style.animationPlayState = 'paused';
    el.style.animationDelay = el.__baseDelay - seconds + 's';
  }
}

/**
 * Logical frame signature — the deterministic state of the page, independent of
 * rasterisation.
 *
 * This is the load-bearing determinism measurement. Chromium's rasteriser is not
 * bit-exact across processes (antialiased edges can differ by one channel LSB),
 * so a pixel hash conflates "the UI did something different" with "Skia blended
 * a corner pixel differently". This signature captures only the former, and is
 * the same shape as the `window.__frameSig` hook that
 * tools/SizzleCraft/src/frame-capture.mjs already uses for dedup.
 *
 * Also a real function, for the reason above.
 */
function frameSignature() {
  const parts = [];
  parts.push('t=' + Date.now());
  parts.push('perf=' + Math.round(performance.now()));
  const status = document.getElementById('status');
  parts.push('status=' + status.className + '|' + status.textContent.trim());
  parts.push('clock=' + document.getElementById('clock').textContent);
  parts.push('bar=' + (document.getElementById('bar').style.width || '0%'));
  for (const id of ['service', 'tag', 'env']) {
    const el = document.getElementById(id);
    parts.push(id + '=' + el.value + '|focus=' + (document.activeElement === el));
  }
  parts.push('rows=' + document.getElementById('log').children.length);
  parts.push('tipVisible=' + getComputedStyle(document.querySelector('#hint .tip')).visibility);
  const c = window.__cursor ? window.__cursor.position() : null;
  parts.push('cursor=' + (c ? c.x.toFixed(2) + ',' + c.y.toFixed(2) + ',' + c.press.toFixed(3) : 'none'));
  return parts.join(';');
}

/**
 * Chromium launch flags that measurably reduce rasterisation noise.
 *
 * Measured on this spike's script (225 frames, 2 runs): baseline diverged on
 * ~98 frames starting at frame 30; with these flags ~57 frames starting at 154.
 * They do NOT eliminate it — see results/e2-determinism.json — but partial
 * raster is the single largest contributor, because Chromium reuses previously
 * rasterised tile content and re-rasters only the invalidated region, making a
 * pixel's value depend on what was drawn there before.
 */
export const DETERMINISTIC_RASTER_ARGS = [
  '--disable-partial-raster',
  '--disable-checker-imaging',
  '--disable-image-animation-resync',
  '--force-color-profile=srgb',
  '--hide-scrollbars',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
];

/**
 * Open a page against the local target, with the requested determinism controls.
 *
 * @param {import('playwright').Browser} browser
 * @param {object} options
 * @param {string} options.targetPath   absolute path to the local HTML target
 * @param {boolean} options.useClock    install + pause page.clock
 * @param {boolean} options.cursor      inject the synthetic cursor
 * @param {'none'|'auto'} options.cursorPointerEvents  E3 only; always 'none' otherwise
 */
export async function openDrivenPage(browser, options) {
  const {
    targetPath,
    useClock = true,
    cursor = true,
    cursorPointerEvents = 'none',
    viewport = { width: 1280, height: 720 },
  } = options;

  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });

  // Ordering is load-bearing: clock.install() must precede every other clock
  // call AND the navigation, so the document sees virtual time from its first
  // line of script. Installing after goto leaves the page's startup reads on
  // real time.
  if (useClock) await page.clock.install({ time: VIRTUAL_EPOCH });
  if (cursor) await page.addInitScript(cursorInitScript({ pointerEvents: cursorPointerEvents }));

  await page.goto(pathToFileURL(targetPath).toString(), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts?.ready);

  // Pause after load so the page's own startup timers have settled into a known
  // state, then hold time still for the whole capture.
  if (useClock) await page.clock.pauseAt(new Date(VIRTUAL_EPOCH.getTime() + 1000));

  return page;
}

/**
 * Capture a timeline to `outDir` as frame_NNNNN.png.
 *
 * The output layout deliberately matches what tools/SizzleCraft/src/encode-mp4.mjs
 * already consumes (`frame_\d+\.png`, numerically ordered, constant fps), so a
 * driven capture can feed the existing S7 encode stage unchanged.
 */
export async function captureTimeline(page, options) {
  const {
    steps,
    fps = 30,
    outDir,
    useClock = true,
    freezeAnimations = true,
    cursor = true,
    zoom = null,
    collectSignatures = true,
  } = options;

  const plan = compileTimeline(steps, fps);
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const signatures = [];

  // Resolve every target's coordinates up front. Boxes are read from the live
  // layout, so this answers "can we know where an action will land" directly.
  const points = new Map();
  for (const step of steps) {
    if (step.target && !points.has(step.target)) {
      points.set(step.target, await targetPoint(page, step.target));
    }
  }

  let cursorPos = { x: 40, y: 40 };
  if (cursor) await page.evaluate(([x, y]) => window.__cursor.moveTo(x, y), [cursorPos.x, cursorPos.y]);

  // Per-run state for interpolated moves. Deliberately NOT stored on the step
  // objects: `demoScript` is a shared module-level constant, so writing to it
  // would leak the first run's start points into every later run in the same
  // process and silently fake a determinism failure.
  const moveOrigins = new Map();

  const startedAt = Date.now();
  let prevVirtualMs = 0;
  const actionLog = [];

  for (const f of plan) {
    const { step } = f;

    // --- 1. Advance virtual time by exactly one frame. --------------------
    // The delta is derived from absolute frame indices, never accumulated, so a
    // non-integer frame duration (33.33ms at 30fps) cannot drift.
    if (useClock) {
      const delta = f.virtualMs - prevVirtualMs;
      if (delta > 0) await page.clock.runFor(delta);
      prevVirtualMs = f.virtualMs;
    } else {
      // Control arm: real time, advanced by sleeping a real frame duration.
      await page.waitForTimeout(frameMs(fps));
    }

    // --- 2. Position the cursor and dispatch the step's action. -----------
    const target = step.target ? points.get(step.target) : null;

    if (cursor) {
      if (step.kind === 'move' && target) {
        if (f.isFirstOfStep) moveOrigins.set(f.stepIndex, { ...cursorPos });
        const from = moveOrigins.get(f.stepIndex) ?? cursorPos;
        const p = lerpPoint(from, target, f.eased);
        await page.evaluate(([x, y]) => window.__cursor.moveTo(x, y), [p.x, p.y]);
        if (f.isLastOfStep) cursorPos = { x: target.x, y: target.y };
      } else if (target) {
        await page.evaluate(([x, y]) => window.__cursor.moveTo(x, y), [target.x, target.y]);
        cursorPos = { x: target.x, y: target.y };
      }

      // Click affordance, driven by step progress rather than a CSS animation.
      if (step.kind === 'click') {
        await page.evaluate((p) => window.__cursor.setPress(p), f.progress);
      } else if (f.isFirstOfStep) {
        await page.evaluate(() => window.__cursor.setPress(0));
      }
    }

    // Actions fire on a chosen frame within the step so the surrounding frames
    // read as anticipation and reaction. A click at 35% through its hold leaves
    // the affordance visible before and after the state change.
    const actionFrame = Math.floor(f.stepFrames * 0.35);
    if (f.localFrame === actionFrame) {
      const dispatched = await dispatchAction(page, step, target);
      if (dispatched) actionLog.push({ frame: f.frame, kind: step.kind, target: step.target ?? null });
    }

    // Distribute typing across the step's frames — this is what makes "skim a
    // long form fill" a duration knob rather than a fixed per-character delay.
    if (step.kind === 'type' && step.text) {
      const chars = [...step.text];
      const per = Math.max(1, Math.floor(f.stepFrames / (chars.length + 1)));
      const idx = Math.floor(f.localFrame / per) - 1;
      if (idx >= 0 && idx < chars.length && f.localFrame % per === 0) {
        await page.keyboard.type(chars[idx]);
      }
    }

    // --- 3. Neutralise compositor-driven CSS animation time. --------------
    if (freezeAnimations) {
      await page.evaluate(freezeAnimationsAt, f.virtualMs / 1000);
    }

    // --- 4. Optional zoom ramp (E5 uses this directly). -------------------
    if (zoom) await applyZoom(page, zoom, f);

    // --- 5. Emit the frame. -----------------------------------------------
    // The logical signature is read on its own round-trip AFTER every state
    // change for this frame and immediately before the screenshot, so it
    // describes exactly the pixels about to be captured.
    if (collectSignatures) {
      const sig = await page.evaluate(frameSignature);
      // Fail loud rather than silently collecting `undefined`: an empty
      // signature makes every run trivially "identical" and fakes a pass.
      if (typeof sig !== 'string' || sig.length === 0) {
        throw new Error(`frame ${f.frame}: frame signature was ${JSON.stringify(sig)} — expected a non-empty string`);
      }
      signatures.push(sig);
    }

    const buf = await page.screenshot({ type: 'png', caret: 'hide' });
    await fs.writeFile(path.join(outDir, `frame_${String(f.frame).padStart(5, '0')}.png`), buf);
  }

  return {
    frames: plan.length,
    fps,
    durationMs: plan.length * frameMs(fps),
    wallClockMs: Date.now() - startedAt,
    actionLog,
    signatures,
    outDir,
  };
}

/** Dispatch one step's Playwright action. Returns true when something fired. */
async function dispatchAction(page, step, target) {
  switch (step.kind) {
    case 'click':
      await page.click(step.target);
      return true;
    case 'hover':
      await page.hover(step.target);
      return true;
    case 'select':
      await page.selectOption(step.target, step.value);
      return true;
    case 'type':
      await page.click(step.target);
      return true;
    case 'move':
    case 'settle':
      return false;
    default:
      throw new Error(`unknown step kind: ${step.kind}`);
  }
}

/**
 * CSS-transform zoom. Scales the document root about a focal point, so the page
 * re-rasterises at the zoomed scale instead of magnifying captured pixels.
 */
export async function applyZoom(page, zoom, frame) {
  const scale = zoom.from + (zoom.to - zoom.from) * frame.eased;
  await page.evaluate(
    ([s, fx, fy]) => {
      const el = document.getElementById('app') || document.body;
      el.style.transformOrigin = `${fx}px ${fy}px`;
      el.style.transform = `scale(${s})`;
    },
    [scale, zoom.focus.x, zoom.focus.y]
  );
  return scale;
}

/** Remove any applied CSS zoom. */
export async function clearZoom(page) {
  await page.evaluate(() => {
    const el = document.getElementById('app') || document.body;
    el.style.transform = '';
    el.style.transformOrigin = '';
  });
}
