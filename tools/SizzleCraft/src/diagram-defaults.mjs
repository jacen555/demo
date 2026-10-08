/*
 * The diagram defaults, stated once.
 *
 * A node with no geometry falls back to the same box and a diagram with no viewBox to the
 * same canvas in every stage that draws one. Those numbers were written out separately in
 * `write-build-html.mjs` (S5), `write-storyboard.mjs` (S2) and `validate-scene.mjs` — so a
 * change to the default node size would have moved the render without moving the preview
 * an author approves it against, or without moving the check that refuses an overlapping
 * layout.
 *
 * THE LITERALS ARE SHARED; THE COORDINATE EXPRESSIONS AROUND THEM ARE NOT, and that
 * distinction is the whole reason this file holds values rather than helpers. The stages
 * coerce differently and are NOT interchangeable:
 *
 *     builder      Number(n.x || 0)     a node x of "abc" -> NaN
 *     storyboard   +n.x || 0            a node x of "abc" -> 0
 *     validator    Number(n.x ?? 0) || 0
 *
 * Two independent reviews of this code disagreed about whether these were duplicates: one
 * reported the literals, the other refused on the expressions. Both were right. They
 * diverge on one input in twelve — the kind that passes a green suite and surfaces later —
 * so only the numbers move here, and each stage keeps its own coercion.
 *
 * `validate-scene.mjs` is not yet a consumer: it is being worked on elsewhere and is left
 * alone rather than edited concurrently.
 *
 * Side-effect free: it declares and exports, and is listed as such in
 * `tests/cli-help-contract.test.mjs`.
 */

/**
 * The canvas a diagram is drawn on when `visual.viewBox` is absent.
 *
 * CONSUMERS(DIAGRAM_VIEWBOX): write-build-html.mjs, write-storyboard.mjs
 */
export const DIAGRAM_VIEWBOX = '0 0 1600 900';

/**
 * The box a node occupies when it declares no geometry of its own.
 *
 * CONSUMERS(NODE_DEFAULTS): write-build-html.mjs, write-storyboard.mjs
 */
export const NODE_DEFAULTS = Object.freeze({ x: 0, y: 0, w: 240, h: 96 });
