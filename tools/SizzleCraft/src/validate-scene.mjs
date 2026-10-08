/*
 * S5-pre: refuses an unrenderable scene BEFORE capture.
 *
 * This stage reads `timing.json` (and `knobs.json` when a project keeps one) and says no.
 * It is pure data validation — no browser, no ffmpeg, no frames — so it costs
 * milliseconds against a capture that costs around 11 minutes at 4K. That economics is
 * the entire justification: every defect below is currently found by rendering.
 *
 * Every check exists because a real render produced a wrong frame AND REPORTED SUCCESS.
 * That is the failure mode this file is built around — not a crash, which announces
 * itself, but a trigger that resolves to null, animates nothing, and exits 0.
 *
 * WHAT THIS STAGE DELIBERATELY DOES NOT DO
 *
 *   - Highlight-path resolution. Already a build-time refusal in write-build-html.mjs,
 *     which has the parsed object in hand and can offer a suggestion list. A data-only
 *     re-derivation here would be a second, weaker copy of an enforced rule.
 *   - The endCard canonical form. `end-card.mjs` PRODUCES that invariant and
 *     `timing-schema.json` CHECKS it via validate-timing. Re-stating it here would make a
 *     third site for one rule, which is how two of them drift. See the report footer.
 *   - Anything needing captured frames: identical-segment detection and dead-air spans
 *     are post-S6 and belong to qc/.
 *
 * EXIT CODES (the engine-wide contract in cli-support.mjs)
 *   0  every evaluated check passed
 *   1  at least one check failed — the scene is not fit to capture
 *   2  the caller's fault: no timing.json, unparseable JSON, an invalid no-go pattern, an
 *      unusable SIZZLECRAFT_SCAN_TIMEOUT_MS, or a no-go scan that could not be completed
 *      within its budget (unmeasurable, which is not the same as failed)
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  EXIT,
  CliError,
  runCli,
  requireExistingFile,
  resolveWithinRoot,
  noGoPatternsProblem,
  resolveKnob,
} from './cli-support.mjs';
import { classifyScanOutcome } from './scan-outcome.mjs';
import { isSilentSegment, shapeBlocker } from './silent-segment.mjs';

const USAGE = `usage: node src/validate-scene.mjs [--project DIR] [--timing FILE] [--knobs FILE]

Refuses an unrenderable scene before capture. Reads timing.json, and knobs.json when the
project keeps one. Reads nothing else and writes nothing.

  --project DIR   project root (default: cwd)
  --timing FILE   timing file, relative to the project root (default: timing.json)
  --knobs FILE    knobs file, relative to the project root (default: knobs.json)
  -h, --help      show this message

exit: 0 clean · 1 a check failed · 2 caller error`;

/**
 * The viewBox aspect below which `.diagram-svg` letterboxes to height.
 *
 * DERIVED, not chosen: `.diagram-svg` is `width:100%` inside a `--fit`-scaled safe area
 * with `max-height:58vh` and `preserveAspectRatio="xMidYMid meet"`, so the box binds on
 * height once `0.88*W / (fit * 0.58 * H)` exceeds the aspect — 2.70 at 16:9 and fit 1.
 *
 * ONLY VALID AT FIT 1, and that limitation is real rather than pedantic. On a slide that
 * settles at fit *f* the true threshold is 2.70/f, and `--fit` is decided by the in-browser
 * layout pass, which no pre-capture check can know. So B1 honestly tests the fit-1 case;
 * the general case belongs to the layout audit, which can measure drawn width directly
 * instead of deriving it.
 */
const MIN_VIEWBOX_ASPECT = 2.7;

/** The engine's own default (write-build-html.mjs), applied when a visual declares none. */
const DEFAULT_VIEWBOX = '0 0 1600 900';

/** Node box defaults, mirroring `Number(n.x || 0)` etc. in write-build-html's diagram(). */
const NODE_DEFAULTS = { x: 0, y: 0, w: 240, h: 96 };

/**
 * Does this trigger make its target appear?
 *
 * REVELATION IS A PROPERTY OF THE TRIGGER AND ITS PAYLOAD, NOT OF THE ACTION NAME. Four
 * versions of this rule were written from what the names suggest, and each was wrong in a
 * different direction. This one is built by walking each handler in write-build-html.mjs
 * and asking one question on every branch: does `show()` reach the ADDRESSED element?
 *
 * Does NOT reveal:
 *   - `progress`:934 — resolves its host with `fxHost(tr, null)` and never looks the
 *     target up at all; it draws a slide-level bar.
 *   - `zoomFocus`:928 — scales the SURFACE. It calls `fxRect(id)` only to compute an
 *     offset, which is exactly what makes it read like a reveal on a skim.
 *   - `spotlight`:903 and `codeFocus`:904 with `payload.release` — both return at the top
 *     of the release branch, before their `show()`. A teardown cannot be the thing that
 *     first shows an element.
 *   - `codeFocus`:904 without `release`, aimed anywhere but a field inside a code block —
 *     it does `const blk=el.closest('.codeblock'); if(!blk)return;` BEFORE showing
 *     anything. Only `<seg>-path-*` ids live inside the `<pre class="codeblock">`;
 *     `<seg>-code` is the enclosing `<figure class="codewrap el">`, whose own `closest`
 *     finds no code block either.
 *   - `hover`/`rollover`:930 whose `payload.toId` is absent or does not RESOLVE, and
 *     `moveCursor`:899 whose DESTINATION does not resolve. The two differ, and the
 *     difference lives in the dispatcher rather than the handler: `apply()`:935 calls
 *     `moveCursor(tr.a, (tr.payload&&tr.payload.toId)||tr.a)`, so a `moveCursor` with no
 *     `toId` aims at its own target and reveals it, whereas `hover` has no such fallback
 *     (`const toId=...; if(toId)moveCursor(...)`) and reveals nothing. Reading the
 *     handlers alone was not enough to see this; treating the two alike refused a
 *     legitimate authored scene.
 *     Either way the destination must RESOLVE — `moveCursor` is
 *     `const c=byId(cursorId),t=byId(toId); if(!c||!t)return; show(c);`, so a dangling
 *     destination means even the cursor stays hidden. A present-but-dangling `toId` is the
 *     same silent-null failure A1 exists to catch, one level down in the payload where A1
 *     does not look.
 *   - `pulsePath`:932 with a `payload.chain` that omits the target — it shows the ids in
 *     the chain, falling back to `[tr.a]` only when no chain is supplied.
 *
 * Everything else reveals, verified handler by handler: `clickAt`:897, `typeInto`:898,
 * `spotlight`:903, `emphasize`:920, `callout`:929, `flowEdge`:931 and `stepBadge`:933 all
 * call `show()` on their target; `drawEdge`:895 calls `show(el)` before the path work,
 * with `getTotalLength()` inside a try/catch; and `apply()`:935 routes every unrecognised
 * action to `reveal()`:894, which is target-agnostic.
 *
 * @param {object} trigger the authored trigger
 * @param {object} seg     its segment, for the code-block test
 * @param {Set<string>} ids the ids this segment can emit, for resolving payload destinations
 */
function revealsTarget(trigger, seg, ids) {
  const action = trigger.action;
  const payload = trigger.payload || {};
  if (action === 'progress' || action === 'zoomFocus') return false;
  if ((action === 'spotlight' || action === 'codeFocus') && payload.release) return false;
  if (action === 'codeFocus') return String(trigger.target).startsWith(`${seg.id}-path-`);
  if (action === 'moveCursor') {
    const destination = payload.toId ?? trigger.target; // apply():935 supplies this fallback
    return ids.has(destination);
  }
  if (action === 'hover' || action === 'rollover') {
    return typeof payload.toId === 'string' && ids.has(payload.toId);
  }
  if (action === 'pulsePath') {
    const chain = Array.isArray(payload.chain) && payload.chain.length ? payload.chain : [trigger.target];
    return chain.includes(trigger.target);
  }
  return true;
}

/**
 * Bounds on the no-go patterns.
 *
 * These are compiled from a file on disk with `new RegExp` and run against every string
 * that reaches a frame. Length and count are cheap bounds; neither is the real control,
 * because `(a|aa){30}$` is twelve characters and backtracks exponentially.
 *
 * The real control is the scan budget: the scan runs in a child process under a hard
 * timeout. A heuristic that tried to RECOGNISE dangerous patterns was written and
 * withdrawn — it missed bounded forms like `(a|aa){30}` while refusing ordinary ones like
 * `(foo|bar)+`, and a guard that rejects everyday patterns gets switched off, which costs
 * the whole check. Node cannot interrupt a regex in-process and worker termination is not
 * reliable mid-match, so a separate process killed by the OS is the only bound that
 * actually holds.
 *
 * The scanned INPUT is deliberately NOT truncated. Capping it would convert a hypothetical
 * hang into a guaranteed blind spot at the end of every long value.
 *
 * The length and count bounds themselves MOVED to cli-support's `noGoPatternsProblem`, so
 * write-build-html — which read the same field with no bounds at all — is held to them too.
 *
 * THE BUDGET IS OPERATOR-SETTABLE, and that is part of the remedy rather than a
 * convenience. 5000 ms is a judgement about a machine, not about a pattern: the same
 * innocent scan that finishes in 40 ms on an idle laptop was measured crossing 5000 ms
 * on this repo's own suite under a 12-worker load. When the bound is the thing that is
 * wrong, the operator must be able to say so without editing the engine — otherwise the
 * only available response to a false refusal is to delete the check.
 *
 * WHAT THIS BOUND DOES NOT DO — stated here because the code below spent a release
 * claiming otherwise:
 *   a. It does not identify a slow pattern. A child killed at the budget proves only
 *      that the scan did not finish; catastrophic backtracking and a loaded machine are
 *      indistinguishable from outside, and this code measures neither.
 *   b. It does not detect a pathological pattern that finishes INSIDE the budget. A
 *      `(a+)+$` that happens to be given short bait is quadratic-but-quick here and
 *      passes, and will not be quick on a longer string later.
 *   c. The index it reports is WHERE THE SCAN WAS when the OS stopped it. On a loaded
 *      machine that is whichever pattern held the CPU at the deadline, which need not be
 *      the most expensive one.
 *   d. It does not account for a child stopped by something OTHER than this budget. An
 *      external signal — an out-of-memory killer, a CI step reaping the process tree — is
 *      reported as the signal it was, with no claim about cost, about elapsed time, or
 *      about a pattern. This stage cannot measure a scan it did not stop, and that cuts
 *      both ways: it can no more say the budget was NOT reached than that it was.
 */
const SCAN_TIMEOUT_FALLBACK_MS = 5000;

/**
 * Resolves the scan budget through the shared knob resolver (argv > env > config >
 * default, stated once in cli-support.mjs and enforced by env-precedence.test.mjs).
 *
 * An unusable value is REFUSED, never quietly replaced by the default: a budget read as
 * "use 5000" is how a typo silently disables the thing the operator was trying to set.
 */
function resolveScanTimeoutMs() {
  const { value, source, variable } = resolveKnob('SCAN_TIMEOUT_MS', { fallback: SCAN_TIMEOUT_FALLBACK_MS });
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms <= 0) {
    throw new CliError(
      `${variable} must be a positive whole number of milliseconds — got ${JSON.stringify(String(value))} ` +
        `(from ${source}). It is refused rather than read as ${SCAN_TIMEOUT_FALLBACK_MS}, because a budget ` +
        `that silently reverts to the default cannot be raised by the operator who needed it raised.`,
    );
  }
  return { ms, variable };
}

/**
 * The slide mode, mirroring write-build-html.mjs:168.
 *
 * `footage` here means "this segment ASKS for footage", which is NOT the same as what the
 * builder renders: the real `mode()` also consults `footageUsable(seg)`, which reads
 * clips.json and an approval manifest. When the clip is unapproved or missing, the builder
 * falls back to synthetic content with an entirely different id set.
 *
 * A data-only stage cannot resolve that, so it must not pretend to. `footageSegments()`
 * below pulls those segments OUT of A1/A3/A4 and the report names them as NOT evaluated.
 * The first version instead assumed footage and certified `-footage` targets that the
 * builder may never emit — a pre-capture guard returning a false clean, which is the one
 * outcome this stage exists to prevent.
 */
function slideMode(seg) {
  const v = seg.visual || {};
  if (v.mode === 'footage' || (!v.mode && v.footage)) return 'footage';
  if (v.mode && v.mode !== 'footage') return v.mode;
  return v.nodes ? 'diagram' : v.shot || v.fields || v.hotspots ? 'live' : 'narrative';
}

/** Segments whose rendered id set depends on inputs this stage cannot read. */
const requestsFootage = (seg) => slideMode(seg) === 'footage';

/**
 * The ids a segment could emit under ANY outcome this stage cannot resolve.
 *
 * For an ordinary segment that is exactly `emittedIds`. For a footage segment it is the
 * UNION of the footage ids and the synthetic-fallback ids, because `footageUsable()`
 * decides between them from clips.json and an approval manifest.
 *
 * The union is what makes A1 sound here rather than merely absent. Pulling footage
 * segments out of A1 entirely — the previous behaviour — threw away a real guarantee: a
 * target in NEITHER branch is wrong under every possible outcome, so it can be refused
 * with certainty. A3 and A4 still cannot run, because COVERAGE depends on which branch
 * wins, and they are reported as not evaluated instead.
 */
function possibleIds(seg) {
  const ids = emittedIds(seg);
  if (!requestsFootage(seg)) return ids;
  const v = seg.visual || {};
  const fallback = v.nodes ? 'diagram' : v.shot || v.fields || v.hotspots ? 'live' : 'narrative';
  for (const id of emittedIds(seg, fallback)) ids.add(id);
  return ids;
}

/** The edge id write-build-html emits: authored `id` when present, else the array index. */
const edgeId = (seg, e, j) => `${seg.id}-edge-${e.id ?? j}`;
const nodeId = (seg, n) => `${seg.id}-node-${n.id}`;

/**
 * Every element id `write-build-html` emits for this segment.
 *
 * Transcribed from the emitting template literals rather than guessed — the ids are
 * SEGMENT-QUALIFIED (`flow-node-gw`, never `node-gw`), and a bare id is the single most
 * common authoring error precisely because it looks right.
 *
 * `forceMode` lets a footage segment be evaluated under its synthetic FALLBACK too: the
 * builder renders footage only if the clip is approved and present, and this stage cannot
 * read those inputs. See `possibleIds()`.
 */
function emittedIds(seg, forceMode = null) {
  const v = seg.visual || {};
  const m = forceMode ?? slideMode(seg);
  const ids = new Set([`${seg.id}-label`, `${seg.id}-title`]);
  if (v.subtitle) ids.add(`${seg.id}-subtitle`);

  if (m === 'footage') {
    ids.add(`${seg.id}-footage`);
    if ((v.footage?.overlays || ['lowerThird', 'brandBug']).includes('lowerThird')) ids.add(`${seg.id}-lt`);
    return ids;
  }
  if (m === 'diagram') {
    for (const n of v.nodes || []) ids.add(nodeId(seg, n));
    (v.edges || []).forEach((e, j) => {
      ids.add(edgeId(seg, e, j));
      if (e.label) ids.add(`${seg.id}-edgelabel-${e.id ?? j}`);
    });
    return ids;
  }
  if (m === 'code') {
    ids.add(`${seg.id}-code`);
    return ids; // `-path-*` ids are dynamic and owned by write-build-html's own refusal
  }
  if (m === 'live') {
    ids.add(`${seg.id}-cursor`);
    (v.fields || []).forEach((f, j) => ids.add(`${seg.id}-field-${f.id ?? j}`));
    (v.hotspots || []).forEach((hp, j) => ids.add(`${seg.id}-hotspot-${hp.id ?? j}`));
    return ids;
  }
  // narrative: the builder slices items to 6 and shots to 4, so ids past those bounds are
  // never emitted even though the data declares them.
  (v.items || []).slice(0, 6).forEach((_, j) => ids.add(`${seg.id}-item-${j}`));
  (v.shots || (v.image ? [1] : [])).slice(0, 4).forEach((_, j) => ids.add(`${seg.id}-shot-${j}`));
  return ids;
}

/** Author-supplied triggers that actually address something. */
const authoredTriggers = (seg) => (seg.triggers || []).filter((t) => t && t.target);

/**
 * Does the BUILDER derive this segment's reveal sequence?
 *
 * write-build-html.mjs:577 returns early from autoTriggers the moment any authored trigger
 * carries a target. So a segment with no authored targets gets a complete, correct reveal
 * sequence for free, and A3 must stay silent on it. Flagging those would fail every
 * correct auto-driven project — the same shape as the contiguity check that once asserted
 * segment ADJACENCY and failed all 8 segments of a working timeline.
 */
const isAutoDriven = (seg) => authoredTriggers(seg).length === 0;

// ---------------------------------------------------------------------------
// A · Trigger and element integrity
// ---------------------------------------------------------------------------

/** A1 · every trigger target resolves to an element the builder emits. */
function checkA1(timing, report) {
  for (const seg of timing.segments) {
    const ids = possibleIds(seg); // for footage, the union of both possible outcomes
    const pathPrefix = `${seg.id}-path-`;
    authoredTriggers(seg).forEach((t, i) => {
      // code-mode `-path-*` targets are resolved against the parsed JSON at build time.
      if (slideMode(seg) === 'code' && String(t.target).startsWith(pathPrefix)) return;
      if (ids.has(t.target)) return;
      const sample = [...ids].slice(0, 6).join(', ');
      report.fail(
        'A1',
        `segment "${seg.id}" trigger[${i}] targets "${t.target}", which no element in this ` +
          `${slideMode(seg)}-mode segment emits. Target ids are segment-qualified. ` +
          `Emitted here: ${sample}${ids.size > 6 ? `, +${ids.size - 6} more` : ''}`,
      );
    });
  }
}

/** A2 · `flowEdge` animates particles along a path; pointed at a node it does nothing. */
function checkA2(timing, report) {
  for (const seg of timing.segments) {
    authoredTriggers(seg).forEach((t, i) => {
      if (t.action !== 'flowEdge') return;
      if (String(t.target).startsWith(`${seg.id}-edge-`)) return;
      report.fail(
        'A2',
        `segment "${seg.id}" trigger[${i}] is flowEdge on "${t.target}", which is not an edge. ` +
          `flowEdge animates particles along a path — on anything else it silently does nothing, ` +
          `which looks exactly like a correctly-wired segment with no motion.`,
      );
    });
  }
}

/** A3 · every declared node, edge and item is revealed by something. */
function checkA3(timing, report) {
  for (const seg of timing.segments) {
    if (requestsFootage(seg)) continue;
    if (isAutoDriven(seg)) continue; // the builder derives a complete reveal sequence
    const v = seg.visual || {};
    const triggers = authoredTriggers(seg);
    const ids = possibleIds(seg);
    const declared = [];
    if (slideMode(seg) === 'diagram') {
      const revealed = new Set(triggers.filter((t) => revealsTarget(t, seg, ids)).map((t) => t.target));
      // An edge must be DRAWN, not merely shown. This is deliberately stricter than the
      // renderer, which would make a `rise`-targeted edge visible-but-undrawn — and the
      // divergence is the point: A3's minimal failing input is an edge declared with no
      // drawEdge trigger, which is how `dimensions` shipped two edges that never appeared
      // to connect anything.
      const drawn = new Set(triggers.filter((t) => t.action === 'drawEdge').map((t) => t.target));
      for (const n of v.nodes || []) declared.push([revealed, nodeId(seg, n), `node "${n.id}"`, 'a revealing']);
      (v.edges || []).forEach((e, j) =>
        declared.push([drawn, edgeId(seg, e, j), `edge ${e.id ?? j} (${e.from} -> ${e.to})`, 'a drawEdge']),
      );
    } else {
      const revealed = new Set(triggers.filter((t) => revealsTarget(t, seg, ids)).map((t) => t.target));
      (v.items || []).slice(0, 6).forEach((_, j) => declared.push([revealed, `${seg.id}-item-${j}`, `item ${j}`, 'a revealing']));
    }
    for (const [revealed, id, label, wanted] of declared) {
      if (revealed.has(id)) continue;
      report.fail(
        'A3',
        `segment "${seg.id}" declares ${label} (${id}) but no ${wanted} trigger ever shows it. ` +
          `revealNode does NOT draw an edge — a draw has to be asked for explicitly, and a diagram ` +
          `of disconnected boxes still looks plausible in a storyboard.`,
      );
    }
  }
}

/** A4 · an edge is drawn only after both its endpoints exist. */
function checkA4(timing, report) {
  for (const seg of timing.segments) {
    if (requestsFootage(seg)) continue;
    if (isAutoDriven(seg)) continue;
    const v = seg.visual || {};
    if (slideMode(seg) !== 'diagram') continue;
    const triggers = authoredTriggers(seg);
    const ids = possibleIds(seg);
    // Earliest reveal per target. A later duplicate cannot rescue an edge drawn before it.
    const revealedAt = new Map();
    for (const t of triggers) {
      if (!revealsTarget(t, seg, ids)) continue;
      const at = Number(t.atMs || 0);
      if (!revealedAt.has(t.target) || at < revealedAt.get(t.target)) revealedAt.set(t.target, at);
    }
    const byId = new Map((v.edges || []).map((e, j) => [edgeId(seg, e, j), e]));
    for (const t of triggers) {
      if (t.action !== 'drawEdge') continue;
      const edge = byId.get(t.target);
      if (!edge) continue; // an unresolvable target is A1's finding, not a second report here
      const at = Number(t.atMs || 0);
      for (const end of [edge.from, edge.to]) {
        const id = `${seg.id}-node-${end}`;
        const when = revealedAt.get(id);
        // A missing reveal entirely is A3's finding. A4 owns the ORDERING.
        if (when === undefined || when <= at) continue;
        report.fail(
          'A4',
          `segment "${seg.id}" draws ${t.target} at ${at} ms, but its endpoint "${end}" is not ` +
            `revealed until ${when} ms. The edge animates to a point nothing occupies.`,
        );
      }
    }
  }
}

/** A5 · no trigger fires past its segment end. */
function checkA5(timing, report) {
  for (const seg of timing.segments) {
    const window = Number(seg.endMs) - Number(seg.startMs);
    authoredTriggers(seg).forEach((t, i) => {
      const at = Number(t.atMs || 0);
      // Strictly less than. A beat ON the boundary fires as the NEXT slide takes over.
      if (at < window) return;
      report.fail(
        'A5',
        `segment "${seg.id}" trigger[${i}] fires at ${at} ms but the segment window is only ` +
          `${window} ms (${seg.startMs}..${seg.endMs}). It will never fire and will never error. ` +
          `voice.mjs reflows segment windows onto measured audio, so a narration edit can push ` +
          `authored beats past the new end.`,
      );
    });
  }
}

// ---------------------------------------------------------------------------
// B · Diagram geometry
// ---------------------------------------------------------------------------

/**
 * Parses `"minX minY width height"`, returning null when it is not four numbers.
 *
 * The ORIGIN is kept. Discarding it and then comparing node coordinates against
 * `0..width` made every node in a valid negative-origin viewBox a B2 failure — a false
 * positive that makes the check unusable for anyone who offsets their origin, and which
 * simultaneously accepted a node sitting outside the right edge of such a box.
 */
function parseViewBox(raw) {
  const parts = String(raw).trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [minX, minY, w, h] = parts;
  if (!(w > 0) || !(h > 0)) return null;
  return { minX, minY, w, h };
}

/** Segments that draw a diagram, i.e. the ones B1-B3 are about. */
const diagramSegments = (timing) => timing.segments.filter((s) => (s.visual?.nodes || []).length > 0);

/** B1 · viewBox aspect is wide enough not to letterbox (fit 1 only — see MIN_VIEWBOX_ASPECT). */
function checkB1(timing, report) {
  for (const seg of diagramSegments(timing)) {
    const raw = seg.visual.viewBox ?? DEFAULT_VIEWBOX;
    const box = parseViewBox(raw);
    if (!box) {
      report.fail('B1', `segment "${seg.id}" has an unparseable viewBox: ${JSON.stringify(raw)}`);
      continue;
    }
    const aspect = box.w / box.h;
    if (aspect >= MIN_VIEWBOX_ASPECT) continue;
    const defaulted = seg.visual.viewBox === undefined ? ' (the engine default — none declared)' : '';
    report.fail(
      'B1',
      `segment "${seg.id}" viewBox "${raw}"${defaulted} has aspect ${aspect.toFixed(2)}, below ${MIN_VIEWBOX_ASPECT}. ` +
        `It letterboxes to height: measured, a 16:9 viewBox draws at ~58% of the width a wide one gets ` +
        `(1952 px vs 3379 px at 4K), which is the difference between legible and unreadable labels. ` +
        `Threshold is derived from the CSS at fit 1.`,
    );
  }
}

/** B2 · nodes stay inside their viewBox. */
function checkB2(timing, report) {
  for (const seg of diagramSegments(timing)) {
    const box = parseViewBox(seg.visual.viewBox ?? DEFAULT_VIEWBOX);
    if (!box) continue; // already reported by B1
    for (const n of seg.visual.nodes) {
      const r = nodeRect(n);
      if (r.x >= box.minX && r.y >= box.minY && r.x + r.w <= box.minX + box.w && r.y + r.h <= box.minY + box.h) continue;
      report.fail(
        'B2',
        `segment "${seg.id}" node "${n.id}" occupies ${r.x},${r.y} ${r.w}x${r.h}, outside its viewBox ` +
          `(${box.minX}..${box.minX + box.w} x ${box.minY}..${box.minY + box.h}). It renders clipped.`,
      );
    }
  }
}

const nodeRect = (n) => ({
  x: Number(n.x ?? NODE_DEFAULTS.x) || 0,
  y: Number(n.y ?? NODE_DEFAULTS.y) || 0,
  w: Number(n.w || NODE_DEFAULTS.w),
  h: Number(n.h || NODE_DEFAULTS.h),
});

/**
 * B3 · no two nodes overlap.
 *
 * B2 catches overflow of the box and never overlap WITHIN it, which is why `loop` could be
 * fully inside its viewBox and still unreadable — a defect reported twice before it was
 * recognised as a separate class.
 *
 * Strict inequality on purpose: nodes that merely SHARE A BORDER are a legitimate flush
 * layout. Only a positive-area intersection is a defect.
 */
function checkB3(timing, report) {
  for (const seg of diagramSegments(timing)) {
    const nodes = seg.visual.nodes;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodeRect(nodes[i]);
        const b = nodeRect(nodes[j]);
        const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (overlapX <= 0 || overlapY <= 0) continue;
        report.fail(
          'B3',
          `segment "${seg.id}" nodes "${nodes[i].id}" and "${nodes[j].id}" overlap by ` +
            `${overlapX}x${overlapY}. Both are inside the viewBox and both render unreadable.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// C · Timeline shape
// ---------------------------------------------------------------------------

/**
 * C1 · segments are ordered and monotonic.
 *
 * An OVERLAP is an error; a GAP IS NOT. voice.mjs deliberately inserts inter-segment
 * silence, so a real timeline is monotonic but not adjacent. An earlier version of this
 * rule asserted adjacency and failed all 8 segments of a correct project — a check that
 * could never pass.
 */
function checkC1(timing, report) {
  let prev = null;
  for (const seg of timing.segments) {
    const start = Number(seg.startMs);
    const end = Number(seg.endMs);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      report.fail('C1', `segment "${seg.id}" has a non-numeric window (${seg.startMs}..${seg.endMs})`);
      continue;
    }
    if (end <= start) {
      report.fail('C1', `segment "${seg.id}" ends at ${end} ms, at or before its start of ${start} ms`);
    }
    if (prev) {
      if (start < prev.start) {
        report.fail('C1', `segment "${seg.id}" starts at ${start} ms, before "${prev.id}" at ${prev.start} ms`);
      } else if (start < prev.end) {
        report.fail(
          'C1',
          `segment "${seg.id}" starts at ${start} ms, inside "${prev.id}" which runs to ${prev.end} ms. ` +
            `Overlaps are an error; gaps are not — voice.mjs inserts inter-segment silence by design.`,
        );
      }
    }
    prev = { id: seg.id, start, end };
  }
}

/**
 * C2 · after synthesis, every segment carries measured audio.
 *
 * SILENT SEGMENTS ARE EXEMPT. A silent segment is declared, never inferred — it carries
 * `silence` — and it has no narration, so it has no measured words by construction.
 * Demanding them flagged every correct project that uses a deliberate pause: the same
 * family as the contiguity rule that once demanded adjacency, a check that cannot pass on
 * a valid input. `isSilentSegment` is imported rather than re-stated so the two
 * definitions cannot drift.
 */
function checkC2(timing, report) {
  for (const seg of timing.segments) {
    const audio = seg.audio || {};
    const window = Number(seg.endMs) - Number(seg.startMs);
    const silent = isSilentSegment(seg);

    if (!silent) {
      if (!Number.isFinite(Number(audio.durationMs))) {
        report.fail('C2', `segment "${seg.id}" has no audio.durationMs, but this project has been synthesised`);
        continue;
      }
      if (!Array.isArray(audio.words) || audio.words.length === 0) {
        report.fail(
          'C2',
          `segment "${seg.id}" has no measured audio.words[], but this project has been synthesised. ` +
            `This is the shape a partial re-synthesis leaves behind.`,
        );
      }
    } else if (!Number.isFinite(Number(audio.durationMs))) {
      // A silent segment legitimately carries no clip at all. Nothing further to compare.
      continue;
    }

    // The window-versus-clip comparison applies to BOTH kinds. Exempting silent segments
    // from the words requirement is correct — they have no narration, so they have no
    // measured words — but exempting them from this was not: a silent segment that does
    // carry a measured clip must still describe the audio its window was solved from.
    if (Number.isFinite(window) && Math.round(window) !== Math.round(Number(audio.durationMs))) {
      report.fail(
        'C2',
        `segment "${seg.id}"${silent ? ' (silent)' : ''} window is ${window} ms but its clip measures ` +
          `${audio.durationMs} ms. The window no longer describes the audio it was solved from.`,
      );
    }
  }
}

/** C5 · the render target keeps the aspect every viewBox threshold assumes. */
function checkC5(timing, report) {
  const { width, height } = timing.project || {};
  if (!Number.isFinite(Number(width)) || !Number.isFinite(Number(height)) || !(Number(height) > 0)) {
    report.fail('C5', `project.width/height are not both positive numbers (${width}x${height})`);
    return;
  }
  const aspect = Number(width) / Number(height);
  if (Math.abs(aspect - 16 / 9) <= 0.01) return;
  report.fail(
    'C5',
    `render target is ${width}x${height} (aspect ${aspect.toFixed(3)}), not 16:9. ` +
      `Every diagram viewBox threshold in this project is derived from a 16:9 stage, so a different ` +
      `target silently invalidates all of them.`,
  );
}

// ---------------------------------------------------------------------------
// D · Content safety
// ---------------------------------------------------------------------------

/**
 * Every string that reaches a frame.
 *
 * EXCLUDED, deliberately: `visual.note` and `claims`. Those are authoring prose and
 * provenance — they are never rendered and they are ALLOWED to name sources, so scanning
 * them would make the check unusable in exactly the projects that need it.
 */
function renderedStrings(timing) {
  const out = [];
  const add = (where, value) => {
    if (typeof value === 'string' && value.length) out.push({ where, value });
  };
  const p = timing.project || {};
  add('project.name', p.name);
  add('project.title', p.title);
  add('project.lede', p.lede);

  for (const seg of timing.segments) {
    const at = (f) => `segment "${seg.id}" ${f}`;
    add(at('voiceoverText'), seg.voiceoverText);
    add(at('title'), seg.title);
    const v = seg.visual || {};
    for (const key of ['title', 'subtitle', 'kicker', 'caption', 'label', 'imageLabel', 'url']) {
      add(at(`visual.${key}`), v[key]);
    }
    (v.items || []).forEach((it, j) => {
      for (const key of ['label', 'title', 'text', 'value']) add(at(`visual.items[${j}].${key}`), it?.[key]);
    });
    (v.shots || []).forEach((s, j) => add(at(`visual.shots[${j}].label`), s?.label));
    (v.nodes || []).forEach((n, j) => add(at(`visual.nodes[${j}].label`), n?.label));
    (v.edges || []).forEach((e, j) => add(at(`visual.edges[${j}].label`), e?.label));
    (v.fields || []).forEach((f, j) => {
      add(at(`visual.fields[${j}].label`), f?.label);
      add(at(`visual.fields[${j}].text`), f?.text);
    });
    (v.hotspots || []).forEach((h, j) => add(at(`visual.hotspots[${j}].label`), h?.label));
    (v.highlights || []).forEach((h, j) => add(at(`visual.highlights[${j}].label`), h?.label));

    // code mode is the only mode that puts SOURCE DATA on screen instead of authored copy,
    // so it is the likeliest route for a hostname or an internal id to reach a frame.
    for (const key of ['json', 'code', 'payload']) {
      if (v[key] === undefined) continue;
      add(at(`visual.${key}`), typeof v[key] === 'string' ? v[key] : JSON.stringify(v[key]));
    }
  }
  return out;
}

/**
 * D1/D2 · nothing reaching a frame matches a no-go pattern.
 *
 * ABSENCE MUST NOT BE PERMISSION. A missing `noGoPatterns` key previously defaulted to
 * allow-all, so the guarantee was inert in the only project that used it — and the tests
 * passed, because they supplied their own patterns, which proves the mechanism works and
 * never that it is switched on. `[]` is the explicit opt-out.
 */
function checkD1(timing, report) {
  const raw = timing.project?.noGoPatterns;
  if (raw === undefined || raw === null) {
    report.fail(
      'D1',
      `project.noGoPatterns is absent. This is the guard that keeps deployment hostnames and ` +
        `internal pull-request ids out of a shipped video, and a missing key must not read as ` +
        `permission. Declare the patterns, or set it to [] to opt out explicitly.`,
    );
    return;
  }
  // The shape is cli-support's `noGoPatternsProblem`, not restated here: write-build-html
  // reads the same field and had no bounds at all, so a number silently became a pattern
  // there while this stage refused it. One statement, imported by both.
  const problem = noGoPatternsProblem(raw, 'project.noGoPatterns');
  if (problem) throw new CliError(problem);
  if (!raw.length) return; // the explicit opt-out

  for (const finding of scanInChildProcess(renderedStrings(timing), raw)) {
    report.fail('D1', finding);
  }
}

/**
 * Runs the no-go scan in a child process under a hard timeout.
 *
 * The patterns are untrusted input compiled with `new RegExp` and run against every string
 * that reaches a frame, and Node cannot interrupt a regex in-process. A worker thread is
 * not enough either — termination is not reliable while V8 is inside a match. A separate
 * process killed by the OS is the only bound that actually holds.
 *
 * The child writes the index it is about to test to stderr before testing it, so when the
 * OS kills it the parent can still name the pattern that stalled. Without that, the
 * refusal would be "one of your 40 patterns", which is a bound without a remedy.
 */
function scanInChildProcess(strings, patterns) {
  const self = fileURLToPath(import.meta.url);
  const budget = resolveScanTimeoutMs();
  const result = spawnSync(process.execPath, [self, '--scan-stdin'], {
    input: JSON.stringify({ strings, patterns }),
    encoding: 'utf8',
    timeout: budget.ms,
    maxBuffer: 64 * 1024 * 1024,
  });

  classifyScanOutcome(result, budget);

  if (result.status !== 0) {
    // The child reports an invalid pattern by INDEX, never by source — see scanMain().
    throw new CliError((result.stdout || result.stderr || 'the no-go scan failed').trim());
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new CliError('the no-go scan returned unreadable output');
  }
}


/**
 * The child half of the scan. Reads `{strings, patterns}` on stdin, prints findings as
 * JSON on stdout, and exits non-zero with a message for a pattern that will not compile.
 *
 * NEITHER THE MATCH NOR THE PATTERN IS EVER PRINTED. This guard exists to stop a
 * deployment hostname or an internal id reaching a frame; echoing the thing it caught
 * would copy that value into stdout and from there into CI logs, defeating the check at
 * the moment it succeeds. The pattern is no safer than the match — an author who writes
 * `internal\.example\.com` to keep that host off the screen would have the report print
 * the host right back. That includes `err.message` from `new RegExp`, which embeds the
 * source: forwarding it reintroduced the leak through the error path.
 */
function scanMain() {
  const { strings, patterns } = JSON.parse(fs.readFileSync(0, 'utf8'));
  const compiled = [];
  for (const [index, source] of patterns.entries()) {
    try {
      compiled.push({ index, re: new RegExp(source, 'i') });
    } catch {
      console.log(`project.noGoPatterns[${index}] is not a valid regular expression`);
      return EXIT.USAGE;
    }
  }
  const findings = [];
  for (const { index, re } of compiled) {
    // Synchronous and unbuffered, so the marker survives an OS kill mid-match.
    fs.writeSync(2, `scanning ${index}\n`);
    for (const { where, value } of strings) {
      const hit = re.exec(value);
      if (!hit) continue;
      findings.push(
        `${where} matches project.noGoPatterns[${index}] (${hit[0].length} characters at offset ` +
          `${hit.index}) and reaches a frame. The matched text and the pattern are both withheld ` +
          `deliberately — read them in the source file.`,
      );
    }
  }
  console.log(JSON.stringify(findings));
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// knobs.json · C4 and E1-E3
//
// knobs.json IS NOT AN ENGINE CONCEPT — verified at source: no script in
// tools/SizzleCraft/src reads it. It is a convention of the demo projects, carried in the
// skill's templates. These four checks are therefore OPTIONAL, and when the file is absent
// their absence is REPORTED rather than silently skipped: this engine distinguishes
// `passed` from `could not run`, and a missing file must not read as a clean bill of health.
// ---------------------------------------------------------------------------

/** Where the two files say the same thing. Compared only where BOTH carry a value. */
const OVERLAP = [
  ['render.fps', 'project.fps'],
  ['render.width', 'project.width'],
  ['render.height', 'project.height'],
  ['voice.voice', 'intake.voice'],
  ['voice.speed', 'intake.speed'],
  ['timing.leadInMs', 'intake.leadInMs'],
  ['timing.perceivedGapMs', 'intake.perceivedGapMs'],
];

const dig = (obj, dotted) => dotted.split('.').reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj);

/** C4 · knobs.json and timing.json agree where they overlap. */
function checkC4(timing, knobs, report) {
  for (const [kPath, tPath] of OVERLAP) {
    const kv = dig(knobs, kPath);
    const tv = dig(timing, tPath);
    if (kv === undefined || tv === undefined) continue; // present in only one file is not drift
    if (kv === tv) continue;
    report.fail(
      'C4',
      `knobs.${kPath} is ${JSON.stringify(kv)} but timing.${tPath} is ${JSON.stringify(tv)}. ` +
        `One file was edited and the other was not.`,
    );
  }
}

/** E1 · non-null music attribution requires an end card to carry it. */
function checkE1(timing, knobs, report) {
  const attribution = dig(knobs, 'audio.music.attribution');
  if (attribution === undefined || attribution === null) return;
  if (timing.endCard?.enabled === true) return;
  report.fail(
    'E1',
    `knobs.audio.music.attribution is ${JSON.stringify(attribution)} but endCard.enabled is ` +
      `${JSON.stringify(timing.endCard?.enabled)}. The end card is the only credit surface, so this ` +
      `ships an uncredited work.`,
  );
}

/**
 * E2 · the music source is internally consistent.
 *
 * `durationSeconds` is validated as a finite positive NUMBER, not merely as present. The
 * first version checked presence only and E3 then returned early on a non-finite value
 * "because E2 already reported it" — so `"durationSeconds": "unknown"` passed both and
 * exited 0. Two guards, one hole, each deferring to the other.
 */
function checkE2(knobs, report) {
  const music = dig(knobs, 'audio.music');
  if (!music || typeof music !== 'object') return;
  if (music.generated === false) {
    for (const key of ['file', 'licence']) {
      if (music[key] !== undefined && music[key] !== null) continue;
      report.fail('E2', `knobs.audio.music.generated is false, so "${key}" is required and is missing`);
    }
    const seconds = music.durationSeconds;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
      report.fail(
        'E2',
        `knobs.audio.music.generated is false, so "durationSeconds" must be a finite positive number; ` +
          `it is ${JSON.stringify(seconds)}. E3 cannot compare a value it cannot read.`,
      );
    }
    return;
  }
  if (music.generated === true && (music.preset === undefined || music.preset === null)) {
    report.fail('E2', 'knobs.audio.music.generated is true, so "preset" is required and is missing');
  }
}

/** E3 · a track shorter than the video is flagged for looping. */
function checkE3(timing, knobs, report) {
  const music = dig(knobs, 'audio.music');
  if (!music || music.generated !== false) return;
  const seconds = music.durationSeconds;
  // A malformed duration is E2's finding AND is reported there — this is a genuine
  // hand-off, not the silent return that let "unknown" through.
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return;
  const videoSeconds = Number(timing.durationMs ?? timing.segments.at(-1)?.endMs ?? 0) / 1000;
  if (seconds >= videoSeconds || music.loop?.required === true) return;
  report.fail(
    'E3',
    `the music bed is ${seconds}s against a ${videoSeconds}s video and loop.required is not true. ` +
      `ffmpeg's "amix duration=longest" does NOT extend a short input — the remainder plays with no ` +
      `bed at all and nothing reports it.`,
  );
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const CHECK_TITLES = {
  A1: 'trigger targets resolve to emitted elements',
  A2: 'flowEdge targets an edge',
  A3: 'every declared element is revealed',
  A4: 'edges are drawn after their endpoints',
  A5: 'no trigger fires past its segment end',
  B1: 'viewBox is wide enough not to letterbox',
  B2: 'nodes stay inside their viewBox',
  B3: 'nodes do not overlap each other',
  C1: 'segments are ordered and non-overlapping',
  C2: 'every segment carries measured audio',
  C4: 'knobs.json and timing.json agree',
  C5: 'render target is 16:9',
  D1: 'nothing reaching a frame is a no-go',
  E1: 'music attribution has a credit surface',
  E2: 'music source is internally consistent',
  E3: 'a short bed is flagged for looping',
};

function createReport() {
  const problems = [];
  const evaluated = [];
  const notEvaluated = [];
  return {
    problems,
    evaluated,
    notEvaluated,
    fail: (id, message) => problems.push({ id, message }),
    ran: (id) => evaluated.push(id),
    skipped: (id, why) => notEvaluated.push({ id, why }),
  };
}

function printReport(report, timingPath) {
  console.log(`validate-scene: ${timingPath}\n`);
  for (const id of report.evaluated) {
    const failures = report.problems.filter((p) => p.id === id);
    const status = failures.length ? `FAIL (${failures.length})` : 'ok';
    console.log(`  ${id}  ${CHECK_TITLES[id].padEnd(46)} ${status}`);
    for (const f of failures) console.log(`        ${f.message}`);
  }
  for (const { id, why } of report.notEvaluated) {
    console.log(`  ${id}  ${CHECK_TITLES[id].padEnd(46)} NOT evaluated — ${why}`);
  }
  console.log('');
  // `passed` and `could not run` are different states, and this engine reports them so.
  for (const line of report.absences) console.log(line);
  console.log(
    `\n${report.evaluated.length} checks evaluated, ${report.notEvaluated.length} NOT evaluated`,
  );
  console.log(`${report.problems.length} problems`);
  console.log(
    '\nendCard canonical form is not re-stated here: end-card.mjs produces that invariant and ' +
      'timing-schema.json checks it. Run validate-timing for it, and for schema shape generally.',
  );
}

/** Reads a JSON file, turning a parse failure into a caller error rather than a crash. */
function readJson(abs, label) {
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    throw new CliError(`${label}: could not read ${abs} (${err.code ?? err.message})`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new CliError(`${label}: ${abs} is not valid JSON — ${err.message}`);
  }
}

// The CLI runs unconditionally: there is no "am I the entry point?" guard here, because a
// guard that compares path strings can be defeated by a junction or symlink and would then
// make this validator exit 0 having checked nothing. classifyScanOutcome lives in
// scan-outcome.mjs so it can be imported by its tests without needing one.
await runCli(async () => {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        project: { type: 'string' },
        timing: { type: 'string' },
        knobs: { type: 'string' },
        'scan-stdin': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    }));
  } catch (err) {
    throw new CliError(`${err.message}\n\n${USAGE}`);
  }
  if (values.help) {
    console.log(USAGE);
    return EXIT.OK;
  }
  // The child half of the bounded no-go scan. Internal: not in USAGE, and it reads only
  // stdin, so it touches no path and needs no project root.
  if (values['scan-stdin']) return scanMain();

  const projectDir = path.resolve(values.project ?? process.cwd());
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    throw new CliError(`--project "${projectDir}" is not an existing directory`);
  }

  const timingPath = requireExistingFile(projectDir, values.timing ?? 'timing.json', 'timing file');
  const timing = readJson(timingPath, 'timing file');

  // Can every check below read this segment list at all? Asked FIRST, because a malformed
  // entry is not one failed check — it makes the segment unreadable, so every check would
  // report nonsense about it. A null entry used to reach A1 and die on `seg.visual` with a
  // TypeError and a stack trace: no index, no remedy, and a failure that reads as a bug in
  // the tool rather than a refusal of the input.
  //
  // The rule is NOT restated here. `shapeBlocker` owns it, and `voice` and `remix` already
  // refuse exactly what it refuses before any other check of their segments — so this
  // stage cannot disagree with its siblings about what a segment is. This call replaced a
  // hand-rolled "declares no segments" check that was a second statement of one clause of
  // it. Exit 2 matches those stages: a timing.json shaped wrongly is bad input, like the
  // unparseable JSON refused above, not a scene that failed a check.
  const shape = shapeBlocker(timing);
  if (shape) {
    // The fact is passed through verbatim. It is already a complete sentence, and the
    // trailer this once appended ("— there is no scene to validate") read as a non-sequitur
    // on the id case. Wrapping a message the engine owns in prose of my own is the same
    // mistake as restating the rule, one layer out.
    throw new CliError(`timing file: ${shape.fact}`);
  }

  const report = createReport();
  report.absences = [];

  const always = [
    ['A1', () => checkA1(timing, report)],
    ['A2', () => checkA2(timing, report)],
    ['A3', () => checkA3(timing, report)],
    ['A4', () => checkA4(timing, report)],
    ['A5', () => checkA5(timing, report)],
    ['B1', () => checkB1(timing, report)],
    ['B2', () => checkB2(timing, report)],
    ['B3', () => checkB3(timing, report)],
    ['C1', () => checkC1(timing, report)],
    ['C5', () => checkC5(timing, report)],
    ['D1', () => checkD1(timing, report)],
  ];
  for (const [id, run] of always) {
    report.ran(id);
    run();
  }

  // A segment that asks for footage still has its TARGETS checked by A1, against the union
  // of both possible outcomes (see possibleIds). Only A3 and A4 are withheld, because
  // COVERAGE depends on which branch the builder takes, and that is decided by clips.json
  // and an approval manifest this stage does not read.
  for (const seg of timing.segments.filter(requestsFootage)) {
    report.absences.push(
      `segment "${seg.id}": footage mode — A3/A4 NOT evaluated (clip usability is decided by ` +
        `write-build-html from clips.json and the approval manifest, which this stage does not read; ` +
        `A1 still ran, against the union of the footage and fallback id sets)`,
    );
  }

  // C2 only means anything after synthesis. Before it, a timeline legitimately carries no
  // audio — so the check is reported as NOT evaluated rather than quietly passing.
  //
  // Both optional files go through the project boundary, exactly as --timing does. The
  // first version used a bare path.join for these two, so `--knobs ../elsewhere.json` was
  // read and parsed from outside the project root — and when the escaped path did not
  // exist it was reported as "knobs.json: ABSENT", a boundary breach degrading into a
  // clean bill of health.
  const calibrationPath = resolveWithinRoot(projectDir, 'calibration-observed.json', 'calibration file');
  if (fs.existsSync(calibrationPath)) {
    report.ran('C2');
    checkC2(timing, report);
  } else {
    report.skipped('C2', 'calibration-observed.json is absent — this project has not been synthesised');
    report.absences.push('calibration-observed.json: ABSENT — 1 check NOT evaluated');
  }

  const knobsName = values.knobs ?? 'knobs.json';
  const knobsPath = resolveWithinRoot(projectDir, knobsName, 'knobs file');
  const knobsIds = ['C4', 'E1', 'E2', 'E3'];
  if (fs.existsSync(knobsPath)) {
    const knobs = readJson(knobsPath, 'knobs file');
    for (const id of knobsIds) report.ran(id);
    checkC4(timing, knobs, report);
    checkE1(timing, knobs, report);
    checkE2(knobs, report);
    checkE3(timing, knobs, report);
  } else {
    // Name the file the CALLER asked for. Hardcoding "knobs.json" sent an author who
    // passed `--knobs manifest.json` to look for a file they never mentioned, found
    // legitimately absent, while the path that actually failed to resolve went unreported.
    for (const id of knobsIds) {
      report.skipped(id, `${knobsName} is absent`);
    }
    report.absences.push(`${knobsName}: ABSENT — ${knobsIds.length} checks NOT evaluated`);
  }

  printReport(report, timingPath);
  return report.problems.length ? EXIT.FAILED : EXIT.OK;
});
