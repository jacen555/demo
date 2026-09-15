# Pipeline Contract

A generic stage model for narrated demo video pipelines, plus how the reference
implementation (SizzleCraft) maps onto it.

Read this when setting up a new pipeline or adapting a renderer that isn't the
reference one. For routine tweaks you only need the cost table in `SKILL.md`.

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

Bespoke Node/ffmpeg tooling under `~/SizzleCraft/<project>/`. Not an installed
package — it is rebuilt or copied per project, which is exactly the duplication
this skill's "never spawn a one-off script" rule targets.

| Stage | Script | Notes |
|---|---|---|
| S0 | `timing.json` → `intake` block | The knobs live here today; project `knobs.json` should be the edit surface |
| S1 | `write-script.mjs` | Emits `script.md` |
| S2 | `write-storyboard.mjs` | Emits `storyboard.html` |
| S3 | `voice.mjs` | msedge-tts → `segment_NN.mp3`. **Deterministic** — re-synthesis reproduces byte-identical lengths |
| S4 | `remix.mjs`, `silence-gen.mjs` | Solves perceived gaps, emits `gap_NN.mp3` |
| S5 | `write-build-html.mjs` | Emits `video-auto.html` |
| S6 | `frame-capture.mjs` | Frame capture with dedup. The long pole |
| S7 | `encode-mp4.mjs` | |
| S8 | `make-music.mjs`, `remux-music.mjs` | Generated music bed, sidechain ducking |
| S9 | `remux-music.mjs` | Swaps audio, preserves video stream |
| — | `preview.mjs`, `preview-seg.mjs` | **Single-segment preview — use before committing to a full render** |
| — | `check-levels.mjs`, `audio-probe.mjs`, `validate-timing.mjs` | Verification |

### Known SizzleCraft characteristics

- **Measured render cost:** ~40 minutes for a ~4:20 video — roughly **9–10× the
  finished runtime**. Capture alone was 22 minutes for a 3:07 cut at 25% dedup.
  An audio-only remux was ~4 minutes and near-independent of length. These are one
  machine's numbers; re-measure and record in `render-log.md`.
- **TTS is deterministic.** Re-synthesising unchanged text returns identical
  durations. Safe to regenerate cleaned-up clips without re-solving timing.
- **Perceived gap ≠ inserted silence.** Real gap is
  `tail(clip N) + inserted silence + head(clip N+1)`. Measured tails run
  ~276–312 ms, heads ~130 ms. Solve against perceived gap.
- **Music is generated, not sampled** (`make-music.mjs`) — no licensing to clear.
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
