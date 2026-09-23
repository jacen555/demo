/**
 * The timeline model (question 3: speed control).
 *
 * DESIGN CHOICE UNDER TEST — three candidate models were considered:
 *
 *   (a) frames-per-action    — authoring in frames couples the script to fps;
 *                              changing 30->60fps rewrites every number.
 *   (b) duration-per-step    — authoring in ms, frames derived. Same unit as the
 *                              audio timing solve (S4), which is entirely in ms.
 *   (c) a timeline the loop walks — the capture loop asks "what should be true at
 *                              frame N", which is what the generated-scene path
 *                              already does via masterTimeline.seek().
 *
 * This implements (b) as the AUTHORING surface and (c) as the EXECUTION surface:
 * steps are authored in milliseconds, then compiled once into an explicit,
 * frame-indexed plan. That keeps the script fps-independent and readable, while
 * giving the capture loop the "what is true at frame N" shape it needs.
 *
 * Speed control then falls out for free: `durationMs` per step IS the speed knob.
 * A 200 ms click "holds" for 6 frames at 30fps; a 600 ms form fill skims 18.
 */

/** Frame duration in ms for a given fps. */
export const frameMs = (fps) => 1000 / fps;

/**
 * Compile authored steps into a frame-indexed plan.
 *
 * Each compiled frame carries:
 *   - `stepIndex` / `step` — the authored step it belongs to
 *   - `localFrame` / `stepFrames` — position within the step
 *   - `progress` — 0..1 eased position within the step, for interpolated visuals
 *                  (cursor travel, zoom ramps, click affordances)
 *   - `virtualMs` — exact virtual-clock timestamp, computed from the frame index
 *                   rather than accumulated, so it cannot drift at 30fps (33.33ms)
 */
export function compileTimeline(steps, fps) {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('timeline: steps must be a non-empty array');
  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`timeline: invalid fps ${fps}`);

  // Frame budgets are derived from CUMULATIVE boundaries, not by rounding each
  // step's duration independently.
  //
  // Rounding per step accumulates: measured on this spike's 15-step, 7500 ms
  // script, independent rounding drifted +140 ms at 25 fps (3.5 frames) and
  // +42 ms at 24 fps. A narrated demo is cut against audio, so that drift
  // desynchronises the voiceover. Rounding boundaries instead bounds total error
  // to under one frame at any fps, and the error never compounds.
  const boundaries = [0];
  let cumulativeMs = 0;
  for (const [stepIndex, step] of steps.entries()) {
    const durationMs = Number(step.durationMs);
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new Error(`timeline: step ${stepIndex} (${step.kind}) has invalid durationMs ${step.durationMs}`);
    }
    cumulativeMs += durationMs;
    // Every step gets at least one frame, even if its duration rounds to zero.
    const boundary = Math.max(boundaries[boundaries.length - 1] + 1, Math.round((cumulativeMs / 1000) * fps));
    boundaries.push(boundary);
  }

  const frames = [];
  for (const [stepIndex, step] of steps.entries()) {
    const stepFrames = boundaries[stepIndex + 1] - boundaries[stepIndex];
    for (let localFrame = 0; localFrame < stepFrames; localFrame++) {
      const raw = stepFrames === 1 ? 1 : localFrame / (stepFrames - 1);
      frames.push({
        stepIndex,
        step,
        localFrame,
        stepFrames,
        progress: raw,
        eased: easeInOutCubic(raw),
        isFirstOfStep: localFrame === 0,
        isLastOfStep: localFrame === stepFrames - 1,
      });
    }
  }

  // Exact virtual timestamps derived from the absolute frame index. Deriving
  // (rather than accumulating a rounded per-frame delta) is what keeps a 30fps
  // run from drifting ~0.33 ms/frame — 1 full frame every 100 frames.
  return frames.map((f, i) => ({
    ...f,
    frame: i,
    virtualMs: Math.round(((i + 1) * 1000) / fps),
  }));
}

/** Total frames a timeline will emit at a given fps. */
export function totalFrames(steps, fps) {
  return compileTimeline(steps, fps).length;
}

export function easeInOutCubic(t) {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/**
 * The demo script used by every experiment. One shared script means E2's
 * determinism claim and E4's speed claim are measured on the same workload.
 *
 * Note the deliberate speed variation: a slow deliberate move to the first
 * field, a fast skim while typing, a long hold on the click so the viewer can
 * see what was pressed, then a long settle to watch the async result land.
 */
export const demoScript = [
  { kind: 'settle',   durationMs: 400,  label: 'establish the UI' },
  { kind: 'move',     durationMs: 500,  target: '#service', label: 'travel to Service' },
  { kind: 'click',    durationMs: 200,  target: '#service', label: 'focus Service' },
  { kind: 'type',     durationMs: 600,  target: '#service', text: 'ledger', label: 'skim-type service' },
  { kind: 'move',     durationMs: 300,  target: '#tag',     label: 'travel to Tag' },
  { kind: 'click',    durationMs: 200,  target: '#tag',     label: 'focus Tag' },
  { kind: 'type',     durationMs: 500,  target: '#tag',     text: 'v1.5.0', label: 'skim-type tag' },
  { kind: 'move',     durationMs: 300,  target: '#env',     label: 'travel to Environment' },
  { kind: 'select',   durationMs: 300,  target: '#env', value: 'staging', label: 'choose staging' },
  { kind: 'move',     durationMs: 300,  target: '#hint',    label: 'travel to the hint' },
  { kind: 'hover',    durationMs: 500,  target: '#hint',    label: 'reveal the tooltip' },
  { kind: 'move',     durationMs: 400,  target: '#deploy',  label: 'travel to Deploy' },
  { kind: 'click',    durationMs: 400,  target: '#deploy',  label: 'press Deploy (long hold)' },
  { kind: 'settle',   durationMs: 1200, label: 'watch the rollout animate' },
  { kind: 'settle',   durationMs: 1400, label: 'watch it land' },
];
