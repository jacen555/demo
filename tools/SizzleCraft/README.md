# SizzleCraft

> **Kind:** `tool` · **Tier:** 2 · **Registry id:** `sizzlecraft` · **Language:** `node` (ESM, no bundler — [ADR 0002](../../docs/adr/0002-admit-nodejs-for-ecosystem-bound-tooling.md))

Shared engine for generating narrated demo and educational videos: TTS synthesis,
timing solve, scene build, frame capture, and encode.

Paired with the [`demo-recording` skill](../../.github/skills/demo-recording/SKILL.md),
which holds the workflow discipline — cost routing, the approval gate, and the bug
ledger. **Read that skill before driving this engine.**

## What it was built to do

Two narrated demos were produced with bespoke tooling kept under
`~/SizzleCraft/<project>/`. The pipeline worked well; the *packaging* did not. Each
project got its own copy of the engine, and they drifted:

| | |
|---|---|
| Scripts in project A | 40 |
| Scripts in project B | 15 |
| Shared names | 14 |
| **Byte-identical copies** | **9 (~124 KB)** |
| Diverged | 5 |

This domain is those 9 identical scripts, extracted once so there is a single
place to fix a bug.

## What's here

| Script | Stage | Role |
|---|---|---|
| `canonical-json.mjs` | — | Deterministic JSON serialiser. **The hashing backbone** — `remix` and `voice` use it for cache keys, so changing its output silently invalidates every stored timing hash. The only module here with a real exported API, and the only one under direct test. |
| `write-storyboard.mjs` | S2 | Emits `storyboard.html`. Lede text comes from `project.lede`. |
| `voice.mjs` | S3 | TTS synthesis via `msedge-tts` → per-segment MP3. |
| `silence-gen.mjs`, `silence-asset.mjs` | S4 | Generate gap audio assets. |
| `silence-scan.mjs` | S4 | Measures head/tail silence by **decoding**, not from synthesis metadata (see bug ledger entry 5). |
| `remix.mjs`, `concat-audio.mjs` | S4 | Solves perceived gaps and concatenates without re-synthesising. |
| `vo-envelope.mjs` | S4/S8 | Narration amplitude envelope, used to drive sidechain ducking. |
| `write-build-html.mjs` | S5 | Builds the renderable scene. The big one — 65 KB. |
| `frame-capture.mjs` | S6 | Headless-browser frame capture with dedup. **The long pole.** |
| `encode-mp4.mjs`, `append-outro.mjs` | S7 | Frames → MP4, plus end-card append. |
| `make-music.mjs` | S8 | Generated ambient bed, nothing sampled. Named presets — `warm` (I-V-ii-IV in F) and `bright` (vi-IV-I-V in G). |
| `remux-music.mjs` | S8/S9 | **The cheap path.** Swaps the audio track and preserves the video stream byte-for-byte. |
| `preview.mjs`, `preview-seg.mjs` | — | Segment previews before committing to a full render. |
| `check-levels.mjs`, `audio-probe.mjs`, `validate-timing.mjs` | — | Verification. |

Stage numbers refer to the pipeline contract in
[`references/pipeline-contract.md`](../../.github/skills/demo-recording/references/pipeline-contract.md).

**`write-script.mjs` (S1) is deliberately not here** — see below.

## How to run

```powershell
npm install                 # first time — pulls playwright, msedge-tts, music-metadata
node --test                 # run the tests
node src/canonical-json.mjs fixed-key-order-json-utf8-v1 < input.json
node src/make-music.mjs bed.wav 240 vo-envelope.json bright
node src/preview.mjs                    # preview every segment
node src/preview.mjs flywheel explorer  # preview just these
```

Most scripts are CLI entry points invoked by a project's build sequence rather than
directly by hand. See the skill for the stage ordering.

## Current state

**`partial` — the full pipeline except S1, but still scripts rather than a library.**

**Done**
- **Every pipeline stage except S1 is present**, including the S8/S9 music and remux
  path that implements the cheap audio-only route the skill is built around. A test
  (`engineScripts_coverEveryPipelineStage`) pins this so a partial extraction fails
  loudly instead of silently.
- ~124 KB of byte-identical duplication collapsed to one copy, plus 11 further scripts
  brought over.
- **Four scripts that "diverged" turned out to be the same script with project data
  hardcoded.** Each difference was a value, not logic, and is now a parameter:

  | Script | Was | Now |
  |---|---|---|
  | `validate-timing.mjs` | `WPS=3.43*0.97` vs `3.00*0.95` — one line | Reads `calibration-observed.json`, then `intake.wordsPerSecond`, then a default |
  | `write-storyboard.mjs` | Hardcoded per-video lede string | `project.lede` |
  | `preview.mjs` | Hardcoded list of segment ids | Defaults to all segments; pass ids to narrow |
  | `make-music.mjs` | Forked chord progression | Named presets (`warm`, `bright`), selectable by argv |

- `canonical-json.mjs` has a real test suite — it had none, despite being the integrity
  backbone.

**Not done**
- **`write-script.mjs` (S1) is not extracted.** It diverged ~120% between projects —
  genuinely rewritten, not drifted — and needs a real review to decide what is shared
  versus per-video. This is the one honest exclusion.
- **8 of the scripts export nothing.** They execute on import, so they cannot be
  imported as modules or unit-tested directly — the test suite parses them instead.
  Turning them into a library with a real API is a separate, larger refactor.
- **The original projects still hold their own copies.** Nothing points at this domain
  yet. Pointing them here is what actually banks the benefit.
- No lockfile committed yet — run `npm install` and commit `package-lock.json`.

## Dependencies

| Package | Why |
|---|---|
| `playwright` | Headless browser for frame capture. No practical .NET equivalent for this workload — the reason this domain is Node (ADR 0002). |
| `msedge-tts` | Narration synthesis. Deterministic, which the timing solve depends on. |
| `music-metadata` | Cheap audio probing without a full decode. |

`gsap` and `mp4-muxer` are used by the *generated* scene HTML, not by these scripts,
so they belong to the consuming project rather than here.

## Gotchas

- **`node --test <dir>` does not work** on Node 22 — it resolves the path as a
  module. Use bare `node --test` from this folder, or a glob from the repo root:
  `node --test "tools/SizzleCraft/tests/**/*.test.mjs"`.
- **Import style is inconsistent** across the extracted scripts — some use `node:`
  prefixes, some bare (`fs`, `path`, `crypto`). Harmless, worth normalising.
- **Do not change `canonical-json.mjs` output** without understanding that it
  invalidates every cached timing hash downstream.
- General pipeline bugs (ffmpeg `alimiter`, `-shortest`, mono→stereo loss) live in
  the skill's
  [bug ledger](../../.github/skills/demo-recording/references/bug-ledger.md),
  not here.
