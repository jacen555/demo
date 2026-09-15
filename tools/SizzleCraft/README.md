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
| `canonical-json.mjs` | — | Deterministic JSON serialiser. **The hashing backbone** — `remix` and `voice` use it for cache keys, so changing its output silently invalidates every stored timing hash. The only module here with a real exported API, and the only one under test. |
| `voice.mjs` | S3 | TTS synthesis via `msedge-tts` → per-segment MP3. Deterministic: identical text/voice/speed returns identical durations. |
| `silence-gen.mjs` | S4 | Generates gap audio assets. |
| `silence-scan.mjs` | S4 | Measures head/tail silence by **decoding**, not from synthesis metadata (see bug ledger entry 5). |
| `remix.mjs` | S4 | Solves perceived gaps and concatenates without re-synthesising. |
| `vo-envelope.mjs` | S4/S8 | Narration amplitude envelope, used to drive sidechain ducking. |
| `write-build-html.mjs` | S5 | Builds the renderable scene. The big one — 65 KB. |
| `frame-capture.mjs` | S6 | Headless-browser frame capture with dedup. **The long pole.** |
| `encode-mp4.mjs` | S7 | Frames → MP4. |

Stage numbers refer to the pipeline contract in
[`references/pipeline-contract.md`](../../.github/skills/demo-recording/references/pipeline-contract.md).

## How to run

```powershell
npm install                 # first time — pulls playwright, msedge-tts, music-metadata
node --test                 # run the tests
node src/canonical-json.mjs fixed-key-order-json-utf8-v1 < input.json
```

Every other script is a CLI entry point invoked by a project's build sequence, not
directly by hand. See the skill for the stage ordering.

## Current state

**`partial` — an extracted set of scripts, not yet a library.**

Honest assessment of what this extraction did and did not achieve:

**Done**
- 124 KB of byte-identical duplication collapsed to one copy.
- All 9 scripts verified to parse as ESM, with no hardcoded project paths.
- `canonical-json.mjs` now has a real test suite (12 tests) — it had none, despite
  being the integrity backbone.
- Internal coupling preserved: `remix` and `voice` both import `canonical-json`.

**Not done**
- **8 of 9 scripts export nothing.** They execute on import, so they cannot be
  imported as modules or unit-tested directly — the test suite parses them instead.
  Turning them into a library with a real API is a separate, larger refactor.
- **The 5 diverged scripts were deliberately left out**: `write-script.mjs`,
  `write-storyboard.mjs`, `make-music.mjs`, `preview.mjs`, `validate-timing.mjs`.
  Some diverged legitimately (each video wants different music and different
  narration), some are probably drift. Separating those two cases needs a diff
  review that has not happened yet.
- **The original projects still hold their own copies.** Nothing points at this
  domain yet. Pointing them here is the next step, and is what actually banks the
  benefit.
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
