# Pipeline Contract

A generic stage model for narrated demo video pipelines, plus how the reference
implementation (SizzleCraft) maps onto it.

Read this when setting up a new pipeline or adapting a renderer that isn't the
reference one. For routine tweaks you only need the cost table in `SKILL.md`.

## Contents

1. [Stages](#stages)
2. [The dependency rule](#the-dependency-rule)
3. [Change routing](#change-routing)
4. [Verification points](#verification-points)
5. [Reference implementation: SizzleCraft](#reference-implementation-sizzlecraft)
6. [Adapting a different renderer](#adapting-a-different-renderer)

## Stages

Any narrated-demo pipeline decomposes into these stages. Names differ; the
boundaries and costs do not.

| # | Stage | Produces | Cost tier |
|---|---|---|---|
| S0 | **Intake** | `knobs.json` — every tunable value | Free |
| S1 | **Script** | Narration text per segment | Free |
| S2 | **Storyboard** | Visual plan per segment | Free |
| S3 | **Synthesis** | One audio clip per segment (TTS) | Cheap |
| S4 | **Timing solve** | Gap/lead-in durations, segment start/end | Free |
| S5 | **Scene build** | Renderable scene (HTML, timeline, project file) | Cheap |
| S6 | **Capture** | Frame sequence | **Expensive** |
| S7 | **Encode** | Video stream | **Expensive** |
| S8 | **Audio mix** | Narration + music + ducking → single track | Cheap |
| S9 | **Mux** | Final container | Cheap |

**Cost tiers:** *Free* = seconds, no external process. *Cheap* = seconds to a few
minutes. *Expensive* = tens of minutes.

## The dependency rule

A change invalidates its own stage and **every stage after it**.

```
S0 ─┬─> S1 ─> S2 ─┐
    └─> S3 ────────┼─> S4 ─> S5 ─> S6 ─> S7 ─┐
                   │         (expensive)     ├─> S9
                   └─> S8 ────────────────────┘
```

The one useful asymmetry: **S8 (audio mix) does not feed S5–S7.** The video stream
does not depend on the audio track. So any change confined to S8 — music, volume,
ducking, fades, loudness normalisation — can be delivered by re-running S8 and S9
alone, reusing the existing video stream byte-for-byte.

**That is the only cheap path.** Everything else lands at or above S4 and drags
S6/S7 along with it.

## Change routing

| User asks for | Lowest invalidated stage | Must re-run | Cost |
|---|---|---|---|
| Background music, its level, ducking, fades | S8 | S8, S9 | Minutes |
| Overall loudness / normalisation | S8 | S8, S9 | Minutes |
| Gap, silence, lead-in duration | S4 | S4–S7, S9 | **Expensive** |
| Speech speed or voice | S3 | S3–S7, S9 | **Expensive** |
| Narration wording | S1 | S1, S3–S7, S9 | **Expensive** |
| On-screen visuals, scenes, text | S2 | S2, S5–S7, S9 | **Expensive** |
| Segment order, add/remove segment | S1 | S1–S7, S9 | **Expensive** |
| Storyboard only ("don't render yet") | S2 | S2 | Free |

**Before running anything expensive, check whether other pending changes can ride
along in the same render.**

## Verification points

Verify by **decoding the artifact**, not by trusting the input. Report measured
values.

| After stage | Verify |
|---|---|
| S3 | Clip durations; head and tail silence (measured, not from metadata — see bug ledger) |
| S4 | Perceived gaps in the concatenated audio |
| S7 | Frame count, duration |
| S8 | Integrated loudness and true peak, narration level unchanged vs. approved |
| S9 | Video stream hash unchanged when it should be; total duration; no truncated tail |

## Reference implementation: SizzleCraft

Reference implementation: bespoke Node/ffmpeg tooling, now consolidated as the
`sizzlecraft` domain at **`tools/SizzleCraft/`** (ADR 0002). It was previously copied
per project under `~/SizzleCraft/<project>/`, which is the duplication this skill's
"never spawn a one-off script" rule targets.

| Stage | Script | Notes |
|---|---|---|
| S0 | `timing.json` → `intake` block | The knobs live here today; project `knobs.json` should be the edit surface |
| S1 | `write-script.mjs` | Emits `script.md`. **Not yet extracted** — diverged heavily between projects, pending review |
| S2 | `write-storyboard.mjs` | Emits `storyboard.html`. Lede text comes from `project.lede` |
| S3 | `voice.mjs` | msedge-tts → `segment_NN.mp3`. Observed deterministic — but see bug ledger entry 7 |
| S4 | `remix.mjs`, `silence-gen.mjs`, `silence-asset.mjs`, `concat-audio.mjs` | Solves perceived gaps, emits `gap_NN.mp3` |
| S4 | `silence-scan.mjs`, `vo-envelope.mjs` | Measures head/tail by decoding; builds the ducking envelope |
| S5 | `write-build-html.mjs` | Emits `video-auto.html` |
| S5/S6 | `validate-scene.mjs` | **Refuses an unrenderable scene BEFORE capture.** Pure data over `timing.json` — no browser, no ffmpeg, no frames — so it costs milliseconds against a stage that costs tens of minutes. Catches trigger targets that resolve to nothing, diagram nodes and edges (and the first six narrative items) that nothing reveals, edges drawn before their endpoints, diagram geometry that letterboxes or overlaps, and content a project declared it will not ship. It does **not** check narrative shots, or live-mode fields and hotspots. See bug ledger entry 14 for its bounds — it asked for exactly this check |
| S6 | `frame-capture.mjs` | Frame capture with dedup. The long pole |
| S7 | `encode-mp4.mjs`, `append-outro.mjs` | |
| S8 | `make-music.mjs` | Generated bed. Named presets (`warm`, `bright`) — pass as argv or set `audio.music.preset` |
| S9 | `remux-music.mjs` | **The cheap path** — swaps audio, preserves the video stream byte-for-byte. Also builds the file-bed sidechain (`--duck-db`, `--duck-envelope`), and loops a short bed with a crossfade rather than letting it stop partway |
| — | `write-subtitles.mjs` | WebVTT and SRT caption sidecars, cut from the word timings the TTS service reports, scaled to each clip's probed duration — not from the script, and not decoded from the audio |
| — | `write-chapters.mjs` | MP4 chapter markers, one per segment |
| — | `preview.mjs`, `preview-seg.mjs` | **Segment preview — use before committing to a full render.** `preview.mjs` defaults to all segments; pass ids to narrow. Publishes a binding record last, tying each still and its audit transcript to the `timing.json` and scene it shows by sha256 |
| — | `coach-pack.mjs` | Collects the coach's input set and writes its hash manifest. Pass 1: script only. Pass 2: script, timing, storyboard, stills, audit. **Refuses a still whose binding record does not match, and refuses absence of a record** — "no record" must never read as "nothing wrong" |
| — | `coach-rulings.mjs` | Matches a coach report against the project's committed `coach-rulings.json`. A finding ruled **valid stays open** as "ruled valid, still unfixed"; only waived, false alarm and taste collapse. The key includes a hash of the sentence containing the quote, so **rewording the cited sentence re-opens the finding** rather than silencing it |
| — | `check-levels.mjs`, `audio-probe.mjs`, `validate-timing.mjs` | Verification |

All of the above are checked in at `tools/SizzleCraft/src/` **except `write-script.mjs`**.
A test (`engineScripts_coverEveryPipelineStage`, `tests/SizzleCraft.test.mjs:89`) checks that
**ten specific files** are present — one named per stage, S2 through S8/S9 — so deleting any
of those ten fails loudly. It pins those ten files and nothing else: a stage with several
scripts is only partly covered (S4 pins `remix.mjs`, `silence-gen.mjs` and `silence-scan.mjs`
but not `silence-asset.mjs` or `concat-audio.mjs`), and the verification helpers, the caption
and chapter writers and the coach stages are not in its list at all. Deleting one of those
would not fail this test.

### Known SizzleCraft characteristics

- **Measured render cost:** ~40 minutes for a ~4:20 video — roughly **9–10× the
  finished runtime**. Capture alone was 22 minutes for a 3:07 cut at 25% dedup.
  An audio-only remux was ~4 minutes and near-independent of length. These are one
  machine's numbers; re-measure and record in `render-log.md`.
- **TTS is deterministic `[OBSERVED]`.** Re-synthesising unchanged text returned
  identical durations to the millisecond on every run measured — but determinism is
  **not documented** by `msedge-tts` or the Edge backend, so it is an observation and
  not a guarantee. Regenerating cleaned-up clips without re-solving timing has always
  worked and is not promised to: re-measure rather than assume. See bug ledger entry 7,
  which this line used to contradict by stating the observation as a property.
- **Perceived gap ≠ inserted silence.** Real gap is
  `tail(clip N) + inserted silence + head(clip N+1)`. Measured tails run
  ~276–312 ms, heads ~130 ms. Solve against perceived gap.
- **A generated bed has no licensing to clear** (`make-music.mjs` synthesises it; nothing
  is sampled). A **file-sourced** bed is a different matter: `remux-music.mjs` accepts one,
  and it carries whatever licence its source does — ledger entry 16 is about a commercial
  master. Clear it yourself, and if its licence requires attribution the end card is the
  only surface that can carry it.
- **Capture dedup** materially reduces frame count on largely static scenes.

> **SizzleCraft is new and moving.** Several rules here exist to work around gaps
> in the current implementation rather than anything fundamental — notably the
> all-or-nothing capture, the absence of segment-level re-rendering, and the
> per-project script duplication. **Re-check these periodically**; if the tool gains
> incremental capture or a proper caching layer, the routing table in `SKILL.md`
> needs revisiting and some of this becomes obsolete. Treat the cost table as a
> measurement, not a law.

## Adapting a different renderer

The skill is renderer-agnostic. To adapt one:

1. Map its steps onto S0–S9. Most tools collapse several stages into one command.
2. Identify **whether the audio track can be swapped without re-rendering video**.
   If yes, you have the cheap path; wire it up and use it. If no, every change is
   expensive — say so explicitly, and batch aggressively.
3. Identify the cheapest **preview** (single segment, low resolution, proxy
   render). Use it before any full render.
4. Record per-stage wall-clock timings in `render-log.md` on first run so later
   sessions can quote real costs instead of guessing.
5. Put every tunable in `knobs.json`. If the tool has no projection step, write one
   — it pays for itself the first time you avoid reading the full artifact.
