# EvalLoopDemo

> **Kind:** `tool` · **Tier:** 2 · **Registry id:** `eval-loop-demo` · **Language:** `node` (ESM, no bundler — [ADR 0002](../../docs/adr/0002-admit-nodejs-for-ecosystem-bound-tooling.md))

## What this is

One narrated demo video project: **"How do you test a conversation?"** — a standalone
~4-minute video about the evaluation harnesses built for an LLM-driven multi-turn support
interview, and how a change to that interview is measured against a pull-request branch
*before* the pull request is opened.

It is a **consuming project**, not an engine. The engine is
[`tools/SizzleCraft`](../SizzleCraft/); this domain holds the per-video inputs
(`knobs.json`, `timing.json`), the one pipeline stage the engine deliberately does not
ship (`src/write-script.mjs`, S1), and the generated `script.md` / `storyboard.html`.

The workflow discipline — cost routing, the approval gate, the bug ledger — lives in the
[`demo-recording` skill](../../.github/skills/demo-recording/SKILL.md).
**Read that skill before driving this project.**

## What it was built to learn or do

Two reasons, and the second is the one that matters to this repo.

1. **To make the video.** Its subject is an evaluation method that is genuinely unusual:
   162 scripted customer scenarios, each carrying its own knowledge bank, replicated three
   times to separate a real change from model noise, run against a deployed branch.

2. **To be the first real consumer of the extracted SizzleCraft engine.**
   `memory-bank/progress.md` listed *"the originals do not point here yet"* as outstanding
   work. Extracting nine byte-identical scripts only banks a benefit once something
   actually depends on them. This project does.

   **Result: `write-storyboard.mjs` (S2) ran unmodified against a video it was never
   written for.** The `project.lede` parameterisation — one of the four "diverged" scripts
   that turned out to be the same script with data hardcoded — held. See
   [`render-log.md`](render-log.md) § *Engine friction* for the full first-consumer report,
   including what should feed back into the engine before S1 is extracted.

## How to run

Every stage below is **free** — seconds, no external process. Regenerate freely.

```powershell
cd tools\EvalLoopDemo

node src\write-script.mjs                     # S1 · timing.json -> script.md
node src\write-script.mjs --check             # S1 · render to stdout, write nothing
node ..\SizzleCraft\src\write-storyboard.mjs  # S2 · timing.json -> storyboard.html
```

S3 and S4 have run, and are cheap to repeat (~46 s) because TTS is deterministic. They
need `npm install` in `tools/SizzleCraft` first, plus `brand/tokens.json` here (the C-11
voice allow-list `voice.mjs` refuses to start without):

```powershell
node ..\SizzleCraft\src\voice.mjs                      # S3 synthesis + S4 gap solve
node ..\SizzleCraft\src\validate-timing.mjs            # schema + invariants
node ..\SizzleCraft\src\silence-scan.mjs voiceover.mp3 # decoded pacing — needs chromium
```

**S5 onward is expensive and is not authorised.** Scene build, capture and encode are
estimated at ~38 minutes and the
[skill's approval gate](../../.github/skills/demo-recording/SKILL.md) must be cleared
first. `silence-scan.mjs` and S6 both need `npx playwright install chromium`.

**To change a value, edit [`knobs.json`](knobs.json).** Do not open `timing.json` to read
or set one — it is 31 KB of projected data and costs thousands of tokens to read for a
one-line edit.

## Current state

**`working` — rendered, music-mixed, and verified by decoding.**

**Deliverable: `EvalLoopDemo-with-music.mp4`** — 4:10.63, 1920×1080 @ 30fps, 23.22 MB.

**Done**
- Full narration for all eight segments, every figure carrying a named source and a
  `direct`/`derived` type.
- **Full render S5–S9 in ~42.4 min**, verified by decoding: narration loudness within
  **0.27 dB** of the sibling video, video stream MD5-identical across the remux, no end
  card in the canonical absent form.
- Head/tail silence measured by decoding, which caught a real gap-solve defect now recorded
  as [bug-ledger entry 13](../../.github/skills/demo-recording/references/bug-ledger.md).
- A draft pass at half scale caught three authoring defects that would each have cost a
  full 42-minute cycle.
- **27 tests**, including guards that fail the build if a trigger targets an element the
  builder never emits, if any element is never revealed, if a trigger fires past its
  segment's end, or if a deployment endpoint or pull-request id reaches a frame.

**Not done**
- **The approved Playground clip has not been captured.** `blindspot` shipped with its
  stage-trace diagram — the designed degradation, and it reads well.
- **Perceived gaps run ~335 ms long** and were **accepted deliberately**: both sibling
  videos carry the same defect, so 1.83 s is the continuity-correct value.
- Shipped at 4:10.63 against a "~4:00" target; the plan's trim order is exhausted.

## Build and test

```powershell
node --test "tools/EvalLoopDemo/tests/**/*.test.mjs"
```

There is no build step — ESM run directly, per ADR 0002.

The tests are not decorative. Besides covering the S1 projection, they pin:

- the **canonical disabled end card** (`outroMs` 0 **and** `durationMs == last endMs`);
- segment ordering and the uniform gap;
- that every segment carries an on-screen description and at least one sourced claim;
- that **no deployment endpoint, environment name or pull-request id** reaches narration,
  a node label, a card, a title or a subtitle;
- that retired jargon (`SAP path`, `L1`–`L5`, `NO_PATH`, `SSE`) never reaches a frame;
- that `knobs.json` and `timing.json` agree on every value they both carry.
