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

**What "full render" costs.** It depends on the **frame format and the machine**
far more than on the video's length, and the numbers below were the first ones
actually measured end to end rather than scaled from a reference:

| Configuration | Cost |
|---|---|
| 1080p, PNG | **~35–42 min** for a ~4:10 video — capture ~84% of it |
| Half-scale draft (half scale, half fps) | **~5.5 min** — roughly **8× cheaper**, not 2× |
| 4K, JPEG q88 | **~9.6 min capture** — cheaper than the 1080p PNG render above |
| Audio-only swap (remux) | **~30 s**, regardless of length |

**Frame format is a bigger lever than resolution.** JPEG q88 against PNG measured
**13×** at 4K, which is why the 4K row beats the 1080p one. See
`references/cost-techniques.md` for the measurements and the caveats.

**These are one machine's numbers** — an Azure VM, Xeon Platinum 8370C, 16 logical
cores, 64 GB, **no GPU**. On a box with a real GPU the encode advice inverts. Run
`tools/SizzleCraft/src/probe-render-capability.mjs` against the machine in front of
you rather than quoting this table; it runtime-tests each encoder instead of
trusting `ffmpeg -encoders`, which advertises hardware that is not there.

Quote the estimate in minutes when you ask for approval, and record the real number
in `render-log.md` on first run so later sessions stop guessing.

**The draft gate is an easier sell than it used to look.** At ~8× cheaper rather
than ~2×, a half-scale draft costs minutes against tens of minutes — cheap enough
that skipping it to "save time" is usually the expensive choice.

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

1. **Run intake.** Work through `references/planning.md` §2. Answer what you can from
   context, then ask only what is genuinely unresolved — max three questions at a time,
   each with a recommended default. The one group you must never assume is **Evidence**:
   every figure needs a named source before it reaches a script.
2. **Write the narration script and the storyboard.** Text and visual plan only.
   Two constraints that are easy to miss and expensive to retrofit:
   - **Narration must convey everything visually essential** — it is this pipeline's only
     audio track, so it doubles as the audio description (WCAG G226). Name buttons and
     labels; never "this" or "here".
   - **Do not put the narration on screen as bullets.** Visuals complement; they don't
     duplicate.
3. **STOP. Present both for approval.** See the gate below.
4. Only then: synthesise → solve timing → build → capture → encode → mix.

### 4. The approval gate (required)

**Before any capture or encode run, present and stop:**

1. The full narration text, per segment
2. The storyboard — what is on screen for each segment
3. **Every figure with its source**, so a wrong number is caught while it is still text
4. Target vs estimated duration
5. The knob values that will be used
6. The estimated render cost in wall-clock minutes

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

**Measure cheaply.** A single-value `ffprobe` beats decoding; a null-muxer run beats
a trial encode; a per-segment `framemd5` answers "did the pixels change?" without
re-reading anything. Recipes in `references/cost-techniques.md` §1.

### 7. Show a draft before the real thing

When the change is visual or structural, render a **draft** first — reduced scale,
lower fps, `-preset ultrafast -crf 28`, or a single segment — and present that at
the approval gate. Resolution scale is the biggest single lever: halving it
roughly halves render time.

Keep draft settings in `knobs.json` under `render.preview` rather than inventing
them each session. See `references/cost-techniques.md` §3.

## Reference files

Load these **only when the task needs them**:

| File | Read it when |
|---|---|
| `references/planning.md` | **Authoring a new video, or when the subject changes.** Intake checklist, accessibility constraints, claims/provenance, narration craft, length evidence |
| `references/cost-techniques.md` | Making an expensive stage cheaper, or needing a cheap way to check "did anything change?" Covers `framemd5`, `ffprobe` probes, null-muxer gates, segment concat, draft settings, TTS metadata, deterministic capture |
| `references/pipeline-contract.md` | Setting up a new pipeline, or adapting a renderer that isn't the reference one |
| `references/bug-ledger.md` | **Before any audio mix, remux, or timing solve.** Cheap to read, expensive to rediscover |
| `templates/knobs.json` | Starting a new project |
| `templates/render-log.md` | Starting a new project |

## These rules have a shelf life

**The reference pipeline (SizzleCraft) is new and still moving.** A number of rules
here exist to work around gaps in its current implementation rather than anything
fundamental — notably the all-or-nothing capture, the absence of segment-level
re-rendering, and the per-project script duplication.

**Treat the cost table as a measurement, not a law.** If the tool gains incremental
capture, a content-hash cache, or a proxy-render mode, the routing in this file
needs revisiting and some of it becomes obsolete.

**Re-check periodically** — a sensible trigger is whenever you come back to make a
new video after a gap:

1. Has the pipeline gained partial/segment rendering or caching? (See
   `references/cost-techniques.md` §2 and §6 for the design to build toward.)
2. Are the measured stage costs in `render-log.md` still accurate?
3. Has anything in `cost-techniques.md` §7 (*Volatile*) changed — the TTS backend,
   Chrome headless flags, upstream library versions?

If any answer surprises you, fix this skill before running the next render.

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
- Using a technique from `references/cost-techniques.md` §8 (*Explicitly
  unverified*) — those are listed precisely because they could not be confirmed.
- Trying to replace the silence-gap solve with SSML `<break>` tags. It does not work
  on this TTS backend (bug ledger entry 10).
- Putting a figure in narration without a source (`references/planning.md` §4).
- Writing a storyboard whose meaning lives only in the visuals — narration is this
  pipeline's only audio track and must carry it (`references/planning.md` §3).
- Justifying a length target by citing the "six-minute rule" — it is a misquote with a
  published rebuttal (`references/planning.md` §6).
- Assuming target length, tone, or audience instead of asking.
