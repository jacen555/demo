/*
 * The brand palette, stated once.
 *
 * THE STORYBOARD IS A PREVIEW OF THE SCENE. `write-storyboard.mjs` (S2) and
 * `write-build-html.mjs` (S5) each held their own copy of these six values — as `PAL` and
 * as `PALETTE` — and assigned them per component by the same index arithmetic. Two copies
 * of one brand is the defect this engine keeps re-shipping, and here it has a sharper
 * edge than usual: if they drift, the storyboard an author reviews the pacing and the
 * colour against stops describing the video that will be rendered. A preview that lies is
 * worse than no preview.
 *
 * Azure/Fluent, assigned per component by index rather than chosen per segment, so the
 * same component reads the same way across a deck.
 *
 * Side-effect free: it declares and exports, and is listed as such in
 * `tests/cli-help-contract.test.mjs`.
 */

/**
 * CONSUMERS(BRAND_PALETTE): write-build-html.mjs, write-storyboard.mjs
 */
export const BRAND_PALETTE = Object.freeze([
    "#0078D4",
    "#00B7C3",
    "#8661C5",
    "#E3008C",
    "#107C10",
    "#F7630C",
]);
