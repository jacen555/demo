/**
 * Synthetic cursor overlay (question 2).
 *
 * Playwright screenshots never contain the OS pointer, so the cursor has to be
 * drawn into the page. Two properties matter:
 *
 *  1. `pointer-events: none` is MANDATORY. The overlay sits at exactly the
 *     coordinates the next action will target, so without it the overlay is the
 *     topmost hit-test result and Playwright's actionability check refuses to
 *     click ("intercepts pointer events"). E3 proves this both ways.
 *
 *  2. The press affordance is PROGRESS-DRIVEN, not CSS-animated. Under a paused
 *     virtual clock a CSS animation does not advance, so an animated ripple
 *     would freeze. Driving radius/opacity from an explicit 0..1 progress value
 *     supplied by the capture loop keeps the affordance frame-exact and makes it
 *     deterministic by construction.
 */

/** z-index chosen to sit above any application content. */
const CURSOR_Z = 2147483647;

/**
 * Init script installing `window.__cursor`. Injected with `addInitScript` so it
 * survives navigation and exists before the app's own scripts run.
 *
 * @param {{ pointerEvents?: 'none'|'auto' }} options
 *   `pointerEvents` is parameterised ONLY so E3 can demonstrate the failure mode.
 *   Production use is always 'none'.
 */
export function cursorInitScript({ pointerEvents = 'none' } = {}) {
  const pe = pointerEvents === 'auto' ? 'auto' : 'none';
  return `(() => {
  const PE = ${JSON.stringify(pe)};
  const Z = ${CURSOR_Z};
  let root = null, ring = null, dot = null;
  let state = { x: -100, y: -100, press: 0, visible: false };

  function build() {
    if (root) return;
    root = document.createElement('div');
    root.id = '__synthetic_cursor';
    root.style.cssText = [
      'position:fixed', 'left:0', 'top:0', 'width:0', 'height:0',
      'pointer-events:' + PE, 'z-index:' + Z, 'contain:layout style size'
    ].join(';');

    ring = document.createElement('div');
    ring.style.cssText = [
      'position:absolute', 'border-radius:50%', 'border:2px solid #4f8cff',
      'background:rgba(79,140,255,0.18)', 'pointer-events:' + PE,
      'transform:translate(-50%,-50%)', 'opacity:0', 'left:0', 'top:0'
    ].join(';');

    dot = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    dot.setAttribute('viewBox', '0 0 24 24');
    dot.setAttribute('width', '24');
    dot.setAttribute('height', '24');
    dot.style.cssText = [
      'position:absolute', 'pointer-events:' + PE, 'left:0', 'top:0',
      'filter:drop-shadow(0 1px 2px rgba(0,0,0,0.55))'
    ].join(';');
    dot.innerHTML =
      '<path d="M5 2 L5 19 L9.2 15.2 L11.8 21.4 L14.8 20.1 L12.2 14.1 L18 14 Z" ' +
      'fill="#ffffff" stroke="#10182a" stroke-width="1.3" stroke-linejoin="round"/>';

    root.appendChild(ring);
    root.appendChild(dot);
    (document.body || document.documentElement).appendChild(root);
  }

  function paint() {
    if (!root) return;
    root.style.visibility = state.visible ? 'visible' : 'hidden';
    dot.style.transform = 'translate(' + state.x + 'px,' + state.y + 'px)';
    // Press affordance: ring grows 0 -> 46px and fades out across the press
    // progress the capture loop supplies. No CSS animation, no clock dependency.
    const p = Math.max(0, Math.min(1, state.press));
    const size = 46 * p;
    ring.style.width = size + 'px';
    ring.style.height = size + 'px';
    ring.style.transform = 'translate(-50%,-50%) translate(' + state.x + 'px,' + state.y + 'px)';
    ring.style.opacity = p > 0 ? String(0.85 * (1 - p)) : '0';
  }

  window.__cursor = {
    ensure() { build(); paint(); },
    moveTo(x, y) { build(); state.x = x; state.y = y; state.visible = true; paint(); },
    setPress(p) { build(); state.press = p; paint(); },
    hide() { build(); state.visible = false; paint(); },
    position() { return { x: state.x, y: state.y, press: state.press, visible: state.visible }; },
    pointerEventsMode: PE,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { build(); paint(); });
  } else {
    build(); paint();
  }
})();`;
}

/**
 * Centre point of a locator's bounding box — the coordinate Playwright itself
 * will target for a click. E3 verifies this prediction against the click event
 * the page actually receives.
 */
export async function targetPoint(page, selector) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`target ${selector} has no bounding box (not visible?)`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

/** Linear interpolation between two points. */
export function lerpPoint(from, to, t) {
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}
