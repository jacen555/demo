/*
 * The end-card field contract.
 *
 * `builderVersion`, `contentMs` and `outroMs` exist to describe an end card. When there
 * is no end card they are not zero — they are ABSENT, because zero reads as "measured
 * it, got nothing", which is a different claim from "there is nothing to measure".
 *
 * This lived inline in voice.mjs, which stripped contentMs and outroMs and left
 * builderVersion behind. That was invisible while the schema did not enforce the rule;
 * the moment it did, no run could produce a schema-valid disabled-end-card timeline. It
 * lives here so the rule is stated once and can be tested without synthesising speech —
 * voice.mjs is a CLI entry point that does network TTS on import, so the logic inside it
 * is unreachable from a test.
 */

/** Every field that exists only to describe an end card. */
export const END_CARD_ONLY_FIELDS = Object.freeze([
  "builderVersion",
  "contentMs",
  "outroMs",
]);

/**
 * Applies the end-card contract to a timing object, in place.
 *
 * Enabled: the three fields are populated and the timeline runs to content + outro.
 * Disabled: all three are removed and the timeline ends at the content.
 *
 * @param {object} timing a timing object with an `endCard.enabled` boolean
 * @param {{contentMs: number, outroMs: number}} measured the solved content and outro lengths
 * @returns {object} the same object, mutated
 */
export function normalizeEndCardFields(timing, { contentMs, outroMs }) {
  if (timing?.endCard?.enabled) {
    timing.contentMs = contentMs;
    timing.outroMs = outroMs;
    timing.durationMs = contentMs + outroMs;
    return timing;
  }

  for (const field of END_CARD_ONLY_FIELDS) delete timing[field];
  timing.durationMs = contentMs;
  return timing;
}
