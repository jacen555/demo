# 0003. Drive real UIs with scripted Playwright frame capture, not `recordVideo`

- **Status:** Accepted
- **Date:** 2026-09-23
- **Spike:** `spike/playwright-ui-capture/`

## Question

Can Playwright drive a real web UI while capturing deterministic, frame-accurate output
suitable for the existing SizzleCraft video pipeline — including a visible synthetic
cursor, per-segment speed control, and zoom?

## Context

`tools/SizzleCraft` only ever captures a **generated** scene: `frame-capture.mjs`
navigates to a locally built `video-auto.html` and screenshots it once per frame, seeking
`masterTimeline` to `frameNo / fps`. There is no `click`, `fill`, `hover`, `type` or
`press` anywhere in the engine, and `recordVideo` is unused. Showing a real product being
operated is therefore not currently possible.

Playwright is already a dependency (`playwright` in `tools/SizzleCraft/package.json`), so
this is an extension of the existing stack rather than a new one — ADR 0002 already admits
Node for exactly this kind of ecosystem-bound tooling.

The pipeline's hard constraints (`.github/skills/demo-recording/references/pipeline-contract.md`):

- **S6 → S7 contract:** `frames/frame_NNNNN.png`, numerically ordered, constant fps.
- **The cheap path (S9 remux) depends on the video stream being reusable byte-for-byte.**
  That requires capture to be reproducible; a wall-clock-paced artifact destroys it.
- Capture is the long pole (~22 min for a 3:07 cut). Dedup materially reduces it.
- Timing is solved in **milliseconds** against measured narration audio.

## Options considered

1. **Playwright `recordVideo`** — film the page while driving it. The browser writes a
   webm; the pipeline consumes it as a segment. Pros: trivially small change; no
   per-frame loop. Cons: hypothesised to discard frame-level control, dedup, and the
   timing solve.

2. **Scripted interaction + per-frame screenshot capture**, with `page.clock` pinning
   virtual time — the existing capture model, with actions dispatched at known frame
   indices. Pros: preserves determinism, frame hashing, the timing solve and the cheap
   remux path. Cons: a new capture loop; loses worker parallelism.

## Evidence

Measured on one machine (16 cores, Windows, Playwright 1.62.1, Chromium 151.0.7922.34),
1280×720 @ 30fps unless stated. Raw output in `spike/playwright-ui-capture/results/`;
reproduce with `npm run experiments`.

### Option 1 is structurally disqualified

Two runs of an **identical** scripted interaction produced different artifacts: **149,565
vs 78,164 bytes** (1.9×), **58 vs 57** coded frames, decoded frames not identical.

Reading the shipped implementation (`playwright-core/src/server/videoRecorder.ts`,
bundled in `lib/coreBundle.js`) explains why it cannot be tuned into compliance:

- `var fps = 25` is a **module-level constant**; `recordVideo` exposes no fps option. The
  pipeline's 30fps cannot be honoured.
- Frame timestamps come from `frame.frameSwapWallTime` — **compositor wall-clock**.
  `page.clock` virtualises time inside the page and never reaches the recorder.
- `frameNumber = Math.floor((timestamp - firstFrameTimestamp) * fps)` buckets frames by
  real arrival time; a second frame in the same 40 ms bucket **overwrites** the first.
  Frame count therefore tracks machine load.
- `_stop()` pads the tail from `monotonicTime()` with `Math.max(addTime, 1)` — **≥1 s of
  wall-clock-dependent tail, always**.
- Encoder args are fixed: `-c:v vp8 -b:v 1M -crf 8 -deadline realtime -speed 8`. Lossy,
  ~1 Mbps, speed-optimised — not a 4K master.

### Option 2 works, and needs exactly three controls

Same script, 225 frames, arms differing only in which control is active. **Logical**
determinism (page state signature) and **raster** determinism (PNG bytes) measured
separately, because they have different causes:

| arm | `page.clock` | anim freeze | logical identical | raster identical | ms/frame |
|---|---|---|---|---|---|
| naive | ✗ | ✗ | 0 / 225 | 0 / 225 | 79.3 |
| clockOnly | ✓ | ✗ | **225 / 225** | 161 / 225 | 35.1 |
| full | ✓ | ✓ | **225 / 225** | **225 / 225** (3 runs) | 35.1 |

1. **`page.clock` survives Playwright actions** — the crux risk, and it holds by design.
   Playwright's actionability polling uses `injected.utils.builtins.requestAnimationFrame`
   and `builtins.setTimeout`: references snapshotted at injection time, deliberately
   immune to page-level overrides. The driver waits on real time; the page sees only
   virtual time.
2. **CSS animations need a separate freeze.** `page.clock` does not control the
   compositor's document timeline. One unfrozen spinner broke 64 / 225 frames (worst
   pixel delta 186/255). The fix is the pause + negative-`animation-delay` technique
   `frame-capture.mjs` already uses — but re-scanned **every** frame, because a driven DOM
   grows animated elements mid-script.
3. **Chromium raster flags are required for bit-exactness.** Without
   `--disable-partial-raster` (+ `--disable-checker-imaging`, `--force-color-profile=srgb`),
   73 / 225 frames diverged across 3 runs; with them, 0. Chromium re-rasterises only the
   invalidated region of a tile, so a pixel can depend on what was drawn there before.

Run-to-run wall-clock spread: **69 ms on 7.9 s (0.9%)**. Dedup opportunity: **29 / 225
consecutive duplicate frames (13%)**.

### Cursor, speed, zoom

- **Cursor coordinates are predictable to 0.14 px** — `locator.boundingBox()` centre vs
  the `clientX/clientY` the page received. The overlay renders in the capture (882 px
  drawn). **`pointer-events: none` is required and proven:** with `auto`, `page.click`
  times out and the app handler runs **0** times; with `none`, **1**. The click affordance
  must be progress-driven, not CSS-animated, or it freezes under the paused clock.
- **Speed: author in milliseconds, derive frames.** Rounding each step independently
  accumulates **+140 ms (3.5 frames) of drift at 25fps** on a 15-step, 7500 ms script —
  enough to desync narration. Rounding **cumulative boundaries** bounds total error to
  under one frame at every fps tested (24/25/30/60).
- **Zoom: CSS transform beats crop-and-scale**, measured against a ground truth rendered
  at `deviceScaleFactor = 2.5`:

  | | RMSE vs ground truth | acutance |
  |---|---|---|
  | ground truth | — | 2.661 |
  | CSS transform | **5.89** | **2.661** (exact match) |
  | crop-and-scale | 7.81 | 2.059 (−22.6%) |

  Crop-and-scale has a **6.25× pixel deficit** (= Z²); no filter recovers unsampled
  detail. CSS zoom also **preserves hit-testing** (observed box scale exactly 2.500), so
  the UI can still be driven while zoomed — but a target the zoom pushes off-viewport
  becomes genuinely unclickable.

### Cost

Per-frame driven capture, 3 repeats each:

| resolution | ms/frame | spread |
|---|---|---|
| 1280×720 | 35.8 | 3.4 |
| 1920×1080 | 54.7 | 1.6 |
| 3840×2160 | **158** | 1.6 |

At 4K that is **4.7 s of capture per second of video, single-threaded**.

## Decision

**Add driven UI capture to the pipeline as a sibling capture path using scripted
Playwright interaction with per-frame screenshot capture (Option 2). Do not use
`recordVideo` for any pipeline output.**

Specifically:

- **Three determinism controls are mandatory and non-negotiable together:**
  `page.clock` install-before-navigate then `pauseAt`; a per-frame CSS-animation freeze;
  and the Chromium raster flags. Dropping any one silently degrades output — the failure
  is invisible frame-to-frame and only shows as a re-render that will not remux.
- **Author interaction scripts in milliseconds per step**, compiled to a frame-indexed
  plan by **cumulative-boundary rounding**. Never round step durations independently.
- **Zoom is a CSS transform**, never a capture-time crop-and-scale.
- **The synthetic cursor is an injected overlay with `pointer-events: none`**, with a
  progress-driven press affordance.
- **Implement as a sibling script, not a new mode inside `frame-capture.mjs`.** Its
  worker slicing depends on every frame being a pure function of frame number
  (`masterTimeline.seek(t)`); a driven UI is a stateful sequence where frame N depends on
  frames 0..N-1. Extract the shared primitives — capture lock, resume fingerprint, atomic
  frame write, `linkOrCopy` dedup, progress/ETA, frame naming, animation freeze — into a
  module both consume.

## Consequences

**What this makes easy**

- Demos can show the real product being operated, not a reconstruction of it.
- Driven output lands in the existing `frames/frame_NNNNN.png` contract, so **S7 encode,
  S8 audio mix and S9 remux are unchanged** — including the cheap audio-only remux path.
- Because step durations are milliseconds, a driven segment can be timed directly against
  its measured narration clip, reusing the S4 solve as-is.
- Reproducible capture means a re-render can be compared frame-for-frame against the
  approved one, which the generated path already relies on.

**What this makes hard**

- **Driven segments lose worker parallelism** — 1 worker vs the 6 used for generated 4K
  content. Budget them as a minority of runtime, or capture at lower resolution and
  upscale at encode. This is the main cost of the decision.
- **Mid-segment resume is gone** for driven segments; recovery replays from the segment
  start.
- **Zoom and interaction targets must be planned together**, since zoom can move a target
  off-viewport and make it unclickable.
- Any real app with network I/O must have responses stubbed (`page.route`) to stay
  deterministic — the spike only covered a self-contained local page.

**What we will have to revisit, and when**

- **Bit-exactness is established on one machine, one OS, one Chromium build.** Do not
  assume cross-machine reproducibility. Re-measure before relying on it in CI, and before
  any Playwright or Chromium upgrade — `fps = 25`, the `builtins` snapshot, and the
  partial-raster behaviour are all internal details that can change without notice.
- If `frame-capture.mjs` gains incremental or segment-level capture, revisit whether the
  driven path should merge back into it rather than remain a sibling.
- The 4K single-threaded cost (158 ms/frame) is the number to re-measure first if driven
  segments start dominating render time.
