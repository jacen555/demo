---
name: demo-recording
description: >
  Plan, render, and iterate on narrated demo and educational video recordings
  token-efficiently. Use when the user says "create a demo", "make a demo video",
  "record a walkthrough", "generate a demo recording", "make an educational video",
  "narrate this", "add background music to the demo", "tweak the demo timing",
  "re-render the demo", or asks to change narration, pacing, voice, gaps, music,
  or visuals on an existing demo video. Routes every change to the cheapest
  pipeline stage that can satisfy it, gates expensive renders behind approval,
  and keeps hard-won fixes out of the rediscovery loop.
---

# Demo Recording

> Narrated demo videos are **cheap to plan and expensive to render**. Almost all
> waste — tokens, wall-clock, and patience — comes from rendering before the plan
> is settled, or from re-rendering when a 4-minute audio swap would have done.
>
> This skill exists to make the cheap path the default one.

## The one rule that matters

**Only the audio track is cheap to change. Everything else costs a full render.**

| Change | Path | Cost |
|---|---|---|
| Music, volume, ducking, fades | Swap audio track, keep video stream | **~minutes** |
| Narration text, voice, speed | Re-synthesise → rebuild → capture → encode | **full render** |
| Gaps, silence, lead-in | Re-solve timing → rebuild → capture → encode | **full render** |
| Visuals, scenes, on-screen text | Rebuild → capture → encode | **full render** |

**What "full render" costs.** In the reference implementation, roughly **9–10×
the runtime of the finished video** — measured at ~40 minutes for a ~4:20 video
(capture alone was 22 minutes for a 3:07 cut at 25% dedup). An audio-only swap was
~4 minutes regardless of length.

Scale that to the video in front of you, and quote the estimate in minutes when you
ask for approval. Record the real number in `render-log.md` on first run so later
sessions stop guessing.

Everything except the first row changes the **video timeline**, which forces a
re-capture. So:

> ### Batch every timeline-affecting change into one render.
>
> If the user gives you one timing tweak and more feedback is plausible, **ask
> whether they have other changes before you render**. Two sequential renders for
> two small tweaks is the single most expensive mistake in this workflow.

## Protocol

### 1. Read the project state, not the artifacts

Every project keeps two small files (see `templates/`):

- **`knobs.json`** — every tunable value. Small, stable, the *only* thing you edit
  for a parameter change.
- **`render-log.md`** — what has been rendered, current values, what is approved,
  known issues.

**Read these. Do not read the full timing/storyboard artifact to change a knob.**
Those artifacts are routinely 50–100 KB of generated data; reading one to change
`speed: 1.1 → 1.2` burns thousands of tokens for a one-line edit. The build step
projects `knobs.json` into the large artifact — that is the build step's job, not
yours.

Read the large artifact only when you must reason about its *structure* (adding or
reordering segments), never to read or set a value.

### 2. Classify the request before acting

| Request is… | Do this |
|---|---|
| A new demo | Go to **Authoring** below |
| A parameter tweak (gap, speed, volume, music) | Edit `knobs.json`, route via the cost table, batch if timeline-affecting |
| A narration or visual change | Treat as timeline-affecting. Re-approve the script, then batch |
| "Just update the storyboard" | Do exactly that. **Do not render.** |
| Ambiguous | Ask. A wrong guess here costs ~40 minutes |

### 3. Authoring — plan fully before rendering anything

1. **Gather intent.** Target length, audience, what to emphasise (decisions vs.
   mechanics), tone, and whether it is part of a series. Ask rather than assume —
   these change the whole script.
2. **Write the narration script and the storyboard.** Text and visual plan only.
3. **STOP. Present both for approval.** See the gate below.
4. Only then: synthesise → solve timing → build → capture → encode → mix.

### 4. The approval gate (required)

**Before any capture or encode run, present and stop:**

1. The full narration text, per segment
2. The storyboard — what is on screen for each segment
3. Target vs. estimated duration
4. The knob values that will be used
5. The estimated render cost in wall-clock minutes

Ask: **"Approve for render? This takes ~N minutes. Reply yes, or give changes."**

**Wait for explicit approval.** A restatement or a question is not approval.

This gate applies to capture/encode only. Audio-only remuxes and storyboard/script
regeneration are cheap — run those freely.

### 5. Never spawn a one-off script

The failure mode this skill was written against: a pipeline accumulating
`voice.mjs` → `voice2.mjs`, `grab-crops.mjs` → `grab-crops2.mjs` →
`grab-crops3.mjs`, `rebalance.mjs` → `rebalance2.mjs`. Forty scripts in one
project, nine of them byte-identical copies of another project's.

**Rules:**
- A variation goes in as a **parameter on the existing script**, never a new file
  with a digit appended.
- Logic shared by two projects belongs in a shared location, referenced by both.
- Before writing any new script, check whether an existing one does 90% of it.

### 6. Measure, don't assume

Verify the output by decoding it, not by trusting the inputs. The reference
implementation's costliest bugs were all cases where the intended value and the
actual value diverged silently — see `references/bug-ledger.md`.

Report measured values (actual gap lengths, actual loudness, actual duration), not
targets.

## Reference files

Load these **only when the task needs them**:

| File | Read it when |
|---|---|
| `references/pipeline-contract.md` | Setting up a new pipeline, or adapting a renderer that isn't the reference one |
| `references/bug-ledger.md` | **Before any audio mix, remux, or timing solve.** Cheap to read, expensive to rediscover |
| `templates/knobs.json` | Starting a new project |
| `templates/render-log.md` | Starting a new project |

## Series continuity

For multi-part series:
- Keep one `knobs.json` per part, but **keep voice, speed, gap, and loudness
  values identical** across parts unless deliberately varied. Mismatched loudness
  between parts is very noticeable on back-to-back playback.
- Record the shared values in each part's `render-log.md` so a later session does
  not drift.
- Ask whether parts will be played back-to-back or standalone — it changes how
  much the opening must re-establish context.

## Anti-patterns

- Rendering before the script and storyboard are approved.
- Rendering twice for two tweaks that could have been batched.
- Re-rendering video for a music or volume change.
- Reading a 90 KB timing artifact to change one number.
- Creating `<script>2.mjs` instead of adding a parameter.
- Reporting target values as if they were measured.
- Rediscovering a bug that is already in `references/bug-ledger.md`.
- Assuming target length, tone, or audience instead of asking.
