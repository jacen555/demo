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
| `canonical-json.mjs` | — | Deterministic JSON serialiser. **The hashing backbone** — `remix` and `voice` use it for cache keys, so changing its output silently invalidates every stored timing hash. |
| `cli-support.mjs` | — | Shared exit-code contract, **link-following path confinement** (ported from `libs/EvalEngine`'s `PathBoundary`), a separate wipe-target rule for the one directory that gets recursively deleted, `--help`-before-I/O argument parsing, and the input validators every guard depends on. Side-effect free, so it is unit-tested directly. |
| `remux-verify.mjs` | S8/S9 | The video-stream verdict for the cheap remux path. Parses ffmpeg's `MD5=` line rather than comparing raw strings — equal-but-unparsed output is not evidence either digest was computed. |
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

## Safe defaults and exit codes

**Every script in this engine that writes, deletes or appends plans by default.** A bare
invocation tells you exactly what it would do and changes nothing. That is the whole
contract, and it is covered by a test per script in `tests/destructive-defaults.test.mjs`.

```powershell
node src/frame-capture.mjs                     # plan: what would be captured and deleted
node src/frame-capture.mjs --apply             # actually capture, REPLACING frames/
```

- `--apply` performs the work. Without it nothing is written, deleted or appended.
- `--replace` is additionally required to overwrite something that already exists.
- `--help` is handled before any file is touched, on every script.
- Output paths are confined to the project root, and the confinement **follows links** —
  a junction inside the project pointing outside it is refused, not followed. The
  confinement is applied to the path actually **written**, not just to its directory.
- **Being inside the project root is not the same as being safe to delete.** The one
  directory that gets recursively wiped (`frames/`) must be the real directory at that
  name; a link there is refused even when its target is also inside the project.
- Two inputs that resolve to one output file are refused rather than silently
  overwriting each other.
- A parent stage never hands a child the flags that make it write. `remix` and `voice`
  forward `--apply`/`--replace` to `silence-gen` only when they were given them.
- **Every value a guard depends on is validated before the guard reads it** — calibration
  rates, drift tolerances, frame rates, envelope samples, lock owner PIDs and ffmpeg's
  MD5 output. A threshold that arrives as `NaN` does not relax a check, it removes it,
  and an unreadable file is never treated as an absent one.

**Exit codes are an API.** Every script uses the same four, and a pipeline driver
should check them — stage N+1 consuming stage N's output depends on it.

| Code | Meaning |
|---|---|
| `0` | Success, or a plan produced successfully. The work was done. |
| `1` | The work ran and the result is bad — a check failed, a hash mismatched, ffmpeg failed. |
| `2` | Bad usage — invalid arguments, a path outside the project root, a missing prerequisite. |
| `3` | **Skipped.** Another process holds the lock, so nothing was done. Not a success. |

`3` matters most. `frame-capture` and `encode-mp4` take a single-writer lock; when
another run holds it they exit `3` rather than `0`, so a driver cannot mistake "someone
else is encoding" for "the encode is finished". A plan never takes the lock.

Verification scripts (`validate-timing`, `check-levels`, `preview`) exit non-zero when
they find a problem. `validate-timing` needs `ajv` for schema validation and **fails
rather than silently skipping** if it is missing; pass `--no-schema` to skip that check
deliberately. `preview` treats a non-empty layout audit as a failure, matching
`frame-capture` — the two stages must agree about whether the same condition is fatal.

## How to run

```powershell
npm install                 # first time — pulls playwright, msedge-tts, music-metadata, ajv
node --test                 # run the tests

# verification
node src/validate-timing.mjs                      # schema + contiguity + word budget
node src/validate-timing.mjs --strict             # also fail on over-budget segments
node src/check-levels.mjs --file "Part 1=a.mp4" --file "Part 2=b.mp4"
node src/preview.mjs --apply                      # screenshot every segment + audit layout

# every writing stage: plan first, then apply
node src/write-storyboard.mjs                  # then: --apply [--replace]
node src/voice.mjs                             # then: --apply --replace
node src/remix.mjs                             # then: --apply --replace
node src/concat-audio.mjs                      # then: --apply --replace
node src/silence-gen.mjs --out gap.mp3 --ms 3500   # then: --apply [--replace]
node src/append-outro.mjs --ms 2500            # then: --apply
node src/write-build-html.mjs                  # then: --apply --replace
node src/frame-capture.mjs                     # then: --apply
node src/encode-mp4.mjs                        # then: --apply --replace
node src/vo-envelope.mjs                       # then: --apply --replace
node src/make-music.mjs --out bed.wav --seconds 240 --preset bright   # then: --apply
node src/remux-music.mjs --video render.mp4 --out render-with-music.mp4   # then: --apply

# pure helpers
node src/canonical-json.mjs fixed-key-order-json-utf8-v1 < input.json
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
- **The destructive and verification paths are now honest.** Two rules hold across the
  engine: *nothing irreversible happens without being asked*, and *no script claims to
  have done work it did not*. Every writing stage plans by default; every verifier can
  fail; path confinement follows links; `--help` touches nothing. Covered by
  `tests/destructive-defaults.test.mjs`, `tests/path-boundary.test.mjs` and
  `tests/safe-defaults.test.mjs`.

**Breaking change for existing build sequences**

**Every stage that writes now requires `--apply`**, and `--replace` as well where it
would overwrite an existing artifact. `remux-music.mjs` no longer has hardcoded
input/output filenames — it requires `--video` and `--out`. `make-music.mjs`,
`preview.mjs`, `preview-seg.mjs` and `append-outro.mjs` take named options instead of
positional arguments. A driver that invoked these bare will now produce a plan and exit
`0` without doing the work — a loud no-op rather than a silent one, but still a change.
The in-repo callers (`remix.mjs`, `voice.mjs`) are updated; **external project build
sequences must add the flags.**

**Not done**
- **`write-script.mjs` (S1) is not extracted.** It diverged ~120% between projects —
  genuinely rewritten, not drifted — and needs a real review to decide what is shared
  versus per-video. This is the one honest exclusion.
- **Most scripts export nothing.** They execute on import, so they cannot be imported as
  modules. The behavioural suite runs them as subprocesses and asserts on exit codes and
  the filesystem instead, which covers the contract callers actually depend on; turning
  them into a library with a real API is still a separate, larger refactor.
- **The original projects still hold their own copies.** Nothing points at this domain
  yet. Pointing them here is what actually banks the benefit.
- **`silence-scan.mjs` has no failure criterion.** It measures head/tail silence and
  reports it, but cannot fail on any finding — structurally the same defect
  `validate-timing` had. Fixing it needs a decision about what silence is out of
  tolerance, which is calibration, not code. Read-only, so it destroys nothing.

## Dependencies

| Package | Why |
|---|---|
| `playwright` | Headless browser for frame capture. No practical .NET equivalent for this workload — the reason this domain is Node (ADR 0002). |
| `msedge-tts` | Narration synthesis. Deterministic, which the timing solve depends on. |
| `music-metadata` | Cheap audio probing without a full decode. |
| `ajv` | JSON Schema validation for `validate-timing.mjs`, against `src/timing-schema.json`. The script already imported it but never declared it, so schema validation failed at runtime; declaring it is what makes that stage real. Draft 2020-12 support is the reason for `ajv` specifically, and it brings 4 small transitive packages. |

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
