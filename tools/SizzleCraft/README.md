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
| `astats-levels.mjs` | — | Reads ffmpeg `astats` levels and classifies a window as **measured, silent, or unmeasurable**. Side-effect free, so it is unit-tested directly. |
| `check-levels.mjs`, `audio-probe.mjs`, `validate-timing.mjs` | — | Verification. |

Stage numbers refer to the pipeline contract in
[`references/pipeline-contract.md`](../../.github/skills/demo-recording/references/pipeline-contract.md).

**`write-script.mjs` (S1) is deliberately not here** — see below.

## Configuration precedence

Every `SIZZLECRAFT_*` environment knob resolves through one helper (`resolveKnob` /
`resolveBooleanKnob` in `src/cli-support.mjs`) under one rule, with no exceptions:

```
argv  overrides  env  overrides  config  overrides  default
```

Most specific wins: a flag typed on this invocation beats a variable exported for this
shell, which beats a value committed to `timing.json`, which beats what the engine assumes
when nobody said. A configured `0` is a **value**, not an absence — it survives to be
validated and refused rather than being silently replaced by the default.

| Knob | Config counterpart |
|---|---|
| `SIZZLECRAFT_FPS` | `timing.project.fps` |
| `SIZZLECRAFT_MODE` | `timing.project.mode` (`draft` \| `live` \| `publish`) |
| `SIZZLECRAFT_FRAME_FORMAT` | `timing.project.frameFormat` (`png` \| `jpeg`) |
| `SIZZLECRAFT_JPEG_QUALITY` | `timing.project.jpegQuality` |
| `SIZZLECRAFT_WORKERS` | — (auto-sized from core count) |
| `SIZZLECRAFT_RESUME` | `--resume` |
| `SIZZLECRAFT_NO_DEDUP` / `SIZZLECRAFT_DEDUP_HOLDS` | — |
| `SIZZLECRAFT_OUTRO_MS` | `--ms` |
| `SIZZLECRAFT_MUSIC_PRESET` | `--preset` (legacy `SIZZLE_MUSIC_PRESET` still read, canonical name wins) |

This is enforced, not merely documented:
`envKnobs_everyDirectEnvironmentRead_goesThroughTheSharedResolver` in
`tests/env-precedence.test.mjs` fails if any file under `src/` reads the environment
directly, **anywhere in the tree**, including inside `cli-support.mjs` outside the
resolver's own two accesses — which are exempted by character offset, not by line or by
file. It catches every **textual** form of the read: dotted (`process.env.X`), bracketed
(`process.env['X']`), computed access to the environment object itself
(`process['env']['X']`), destructuring, aliasing that object (`const e = process.env`),
an access split across lines, and any variable prefix — not just `SIZZLECRAFT_`.

**What it does not catch, and why that is the right boundary.** Aliasing the *global*
first — `const p = process; p.env.X` — defeats any purely textual rule, and closing that
would need a real parser. This guard exists to stop a knob arriving by **copying a
neighbour**, which is how all six of the current ones arrived; it is not a sandbox against
a determined author. The limit is stated in the scanner's own doc comment so the code and
this page agree.

Before that rule existed, `FPS` and `MODE` read config first while three neighbours read
env first, so a half-fps draft silently rendered at 30 — and `SIZZLE_MUSIC_PRESET` kept a
non-conforming prefix unnoticed, because the first scanner only looked for `SIZZLECRAFT_`.

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

**A silent window is a measurement, not a failure.** `check-levels` reports three states,
not two: *measured*, *silent* (`-inf`, which is what astats correctly reports for this
pipeline's deliberate ~2s lead-in), and *unmeasurable*. Only the third exits `1`. Treating
`-inf` as a failed probe made the last gate before delivery exit `1` on every correct
narration-only render, and it named a cause — "the file may have no audio track" — that
was false. That diagnosis is now only made after the input dump has actually been checked
for an audio stream.

**Proving lineage after the fact is not possible, and the report says so.** `validate-timing`
treats a calibration with no `textHash` as lineage UNPROVEN. Only `voice` writes one — and
**`voice --apply` is not a verification step, it is a regeneration**: it re-synthesises
every clip and overwrites `voiceover.mp3` and `timing.json`. So the documented route to
the proof read like a check and was a rewrite.

A `stamp-lineage` tool was built here to close that, and **withdrawn**. It is worth
recording why, because the next person to want it will reach the same design:

`textHash` is a fingerprint over the **exact narration bytes**. No *voice-stage-bound*
record of them survives. `voice` writes six things — the segment clips, `voiceover.mp3`,
`timing.json`, `calibration-observed.json`, `sync-mapping.md` and `heal-log.txt` — and the
only record of what was *spoken* is `segments[].audio.words`, the TTS service's
tokenisation, which does not voice punctuation. Everything else is a summary: `chars` is a
count. So an edit from `"… ready?"` to `"… ready!"` preserves word count, character count,
clip duration **and** the word record, while changing the hash. `remix` then re-seals the
edited timeline without re-synthesising, so `timingHash` verifies too — it proves
self-consistency, never provenance.

**`storyboard.html` is the near-miss, and it is worth knowing why it does not count.**
S2 embeds `voiceoverText` verbatim (`write-storyboard.mjs:83`), so the exact narration
*does* exist on disk. But S2 renders it from whatever `timing.json` holds **at the time it
runs**, before and independently of synthesis, and re-running it after an edit silently
updates it. It follows the script rather than recording what was spoken — a copy, not a
receipt. Nothing binds a given `storyboard.html` to a given voice run, so it cannot
witness one.

Each candidate gate was real and one inferential step short of the claim:

| Gate | Actually proves | Claim needed |
|---|---|---|
| `endMs - startMs === audio.durationMs` | the windows came from *some* audio | *this* audio |
| `{words, chars, clipMs}` | a summary matches | the text is identical |
| `timingHash` verifies | nobody edited the file after sealing | the voice stage produced it |
| normalised word record matches | the service spoke *roughly* this | it spoke *exactly* this |
| `sha256(--music)` unchanged | the track is the same file | the gain was ever calibrated for it |
| the mix pin's values match | the knobs it *records* did not move | no knob that moves the mix moved |

**Evidence weaker than the claim cannot establish the claim.** The correct response to
insufficient evidence is to not certify, so there is no tool — and leaving a calibration
UNPROVEN is a correct outcome. It costs only the word budget, which is evaluated rather
than suppressed.

### The music gain pin — a confirmation, not a measurement

`remux-music.mjs` pins the **delivered-mix parameters** to the music source (bug-ledger
16: a generated bed at −43.1 dB RMS and a licensed master at −11.4 dB are 31.7 dB apart,
both accept the same in-range gain, and the narration-gap checks measure *presence*, not
*level*).

The pin requires `--confirm-gain` on **first use**, whenever the source or **any pinned
mix parameter** changes, whenever the existing pin **records no confirmation**, and once
for any pin written before those parameters were registered. The earlier version asked
only whether the source had *changed*, which is the last-but-one row of the table above: a
changed input shows a calibration is stale, not that one ever happened. That left a first
run pinning its own unconfirmed default, and left a lock carrying no confirmation being
read as agreement when it only ever recorded the tool agreeing with itself.

Older self-pinning versions of this tool did write such locks. The refusal does **not**
say so about any particular file, because a lock's contents cannot establish what wrote
it — it names the missing `evidence` marker and stops there.

`--confirm-gain` records a **provisional acceptance**, and the order it implies is the
only one that can actually be carried out — `check-levels.mjs` measures a *rendered file*,
so there is nothing to measure until the remux has run:

1. `--confirm-gain` to accept the mix parameters and produce the mix;
2. `node src/check-levels.mjs --file <out>` to measure it;
3. read the lead-in window, where the bed plays alone, **before delivering**.

`confirmedAt` and `evidence` are written only on a run where someone actually passed
`--confirm-gain`; a settled pin is left untouched rather than restamped.

#### The registered set — why the pin no longer names its own members

`--ceiling` was added after the pin was written. It sets the limiter, so it moves the
delivered loudness — and the pin recorded `{source, sha256, musicGain}`, a literal typed
before that knob existed. A ceiling change therefore needed no renewed confirmation while
the mix moved underneath a pin reporting itself valid.

The enumeration was not the mistake. **The set was closed by construction and nothing
failed when it grew.** So `src/mix-parameters.mjs` is now the one place a mix knob is
declared, the pin binds to the `pinned` subset of it, and the filter graph is audited
against it before ffmpeg is invoked. A value interpolated into the graph without being
declared leaves a number that traces to nothing, and the run stops with exit `1` (a check
failed) having written nothing — on the plan path too, because a plan that prints a graph
it cannot account for describes a mix nobody confirmed.

**Existing locks are refused, not upgraded.** A pin written before the registry cannot say
which ceiling it covered, and back-filling today's default would record an agreement
nobody was asked for. Every project therefore needs **one** fresh `--confirm-gain`. That
cost was accepted deliberately.

**A refusal names what is missing, not who wrote the file.** Five refusal states are kept
apart: unreadable, *pre-registry* (no `mix` record **and** the complete old
`{source, sha256, musicGain}` shape around it — the only evidence on disk that supports
dating a lock), *no mix record* (no `mix` and not that shape either — refused, and
described by what is absent, because nothing in it establishes when it was written), a
`mix` record missing a registered member, and a member that moved. A pin that also turns
out to be pinned to a **different digest** has that named as a second, independent
difference rather than being described by its first problem alone.

**What the fail-closed guard actually detects** — stated narrowly on purpose, because this
mechanism's previous versions each claimed more than they proved, most recently by
claiming the row below that reads "any run carrying a digit" while the scan matched a
single anticipated shape and read `volume=.5` as nothing at all:

| Detected | Not detected |
|---|---|
| a name used through the registry that is not declared | anything reaching ffmpeg **outside** `-filter_complex` — `-b:a`, `-ar`, an added `-af`, a changed codec |
| a number in the finished graph that no declared use or structural literal accounts for | a change carrying **no digit at all** — swapping `alimiter` for `acompressor`, `level=disabled` → `enabled` |
| a number duplicating a declared value (accounting is by value **and** use-count) | a value inside a `[link label]` (redacted before the scan) or shaped like a **filter identifier** (`c0`, `ml1` — digits in a name are skipped) |
| **any run of characters carrying a digit** that is neither a plain decimal nor a filter identifier — `.5`, `5.`, `+1.5`, `-1.5`, `1e3`, `1.5E-2`, `6dB`, `128k` all stop the run rather than being skipped | **whether `pinned` is set correctly** — nothing mechanical can know a knob moves the level, and this has already been got wrong once (see below) |
| a `pinned` parameter never declared, or declared and never applied | |

The honest summary: a knob interpolated into the mix graph cannot reach ffmpeg **as a
number** — in any numeric form ffmpeg accepts, not just the ones anticipated when the scan
was written — without either being declared or stopping the run. Four things are still
**not** covered, and are named rather than implied away: a value carrying no digit at all,
a value shaped like a filter identifier (`c0`, `ml1` — digits in a name are skipped, which
is what lets the real graph pass), a value inside a `[link label]`, and anything outside
the graph. This guard defends against *forgetting*, which is how `--ceiling` escaped. It
does not defend against being wrong.

**`pinned` is a human judgement, and it was wrong about `--voice-gain`.** The voice gain
was registered `pinned: false` on the reasoning that the pin asks whether the *bed* level
was agreed to. But the narration sets the other half of the balance the bed is judged
against, and it is the signal fed into the limiter whose ceiling *is* pinned — so a
voice-only change moved the delivered mix while a settled pin went on reporting valid,
which is exactly the defect `--ceiling` had. The incident behind this whole feature was a
voice `1.40` / music `0.85` rebalance that shipped a bed 24 dB above target. It is now
pinned; `--voice-gain`, `--music-gain` and `--ceiling` are the confirmed set. Nothing
mechanical caught that error, and nothing mechanical would catch the next one.

#### `--ceiling`, dBFS and dBTP

A limiter ceiling is **dBFS**; a delivery target is usually **dBTP**, and true peak sits
above the sample peaks a limiter clamps. Measured on real encoded output, post-AAC:

| `--ceiling` | integrated | true peak |
|---|---|---|
| 1.0 (default) | −9.7 LUFS | −0.3 dBTP |
| **2.0** | −10.0 LUFS | **−1.1 dBTP** |
| 3.0 | −10.5 LUFS | −2.1 dBTP |

So `--ceiling 2.0` is a **measured starting point** for a −1.0 dBTP target, not a
guarantee. This tool clamps sample peaks before the AAC encode and measures nothing after
it — **verifying a dBTP target means decoding the output and measuring it yourself.** The
earlier guidance of "about 2.5" was a guess and has been removed.

**Known gap — what this pin does not do.** It records that an operator confirmed a set of
mix parameters, not that anyone measured the result. `music-gain.lock.json` carries
`evidence: "operator-confirmed"` so the file cannot be misread as a calibration record. A
measured pin is not buildable from what exists today: `check-levels.mjs` writes no
artifact, measures a *rendered video* rather than the music source, has no way to bind a
reading to the source hash, and the render it would measure does not exist until after
the remux the pin guards. Closing it properly means `remux-music` taking its own astats
reading of the source and recording `sourceRms + 20·log10(gain)` as the predicted bed
level — a real measurement, and a change that trades directly against keeping the plan
path cheap. It is named here rather than approximated in code.

### Re-running the voice stage — what it actually costs, and the recovery

**TTS here is length-deterministic, not byte-deterministic.** Measured on a real
8-segment project, re-running `voice` on *unchanged* narration produced:

| | |
|---|---|
| `durationMs`, every segment `endMs` | identical to the millisecond |
| every clip's byte **length** | identical to the byte |
| every clip's duration | identical |
| **content hash — 5 of 8 segments + `voiceover.mp3`** | **different** |

Neural synthesis varies sub-perceptually between runs while landing on the same frame
count. This is the hardest shape of divergence to catch: every cheap check agrees and only
a content hash disagrees. Do not write a check that compares TTS audio across runs by
anything but content — and do not assume a re-run reproduces a shipped deliverable.

**The recovery, if you have already re-run.** Nothing is lost. `textHash` hashes the
narration **text**, not the audio, which makes the two separable: keep the re-run's
`calibration-observed.json` and `timing.json`, restore the audio files that produced the
shipped render, and you end with lineage proven *and* a bit-reproducible artefact. The
general property, which is the reason to fingerprint inputs rather than outputs:

> **A fingerprint over the input is separable from the output it certifies; a fingerprint
> over the output is not.**

Had `textHash` hashed the audio, that recovery would not exist — the choice would have
been between proven lineage and a reproducible deliverable.

Two notes on the recovery. `remix` is the reflow path that does *not* re-synthesise —
it reuses the `segment_*.mp3` clips on disk byte-for-byte and only changes pacing. And
`vo-envelope.json` is the one artefact derived from audio *content*; it is recomputed on
every run and never compared against a stored value, so nothing breaks, but it describes
whichever audio was on disk when it last ran — regenerate it if you restore clips and
intend to re-render.

## How to run

```powershell
npm install                 # first time — pulls playwright, msedge-tts, music-metadata, ajv
node --test                 # run the tests

# verification
node src/validate-timing.mjs                      # schema + contiguity + word rate
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
node src/remux-music.mjs --video render.mp4 --out render-with-music.mp4   # then: --apply --confirm-gain

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
  | `validate-timing.mjs` | `WPS=3.43*0.97` vs `3.00*0.95` — one line | Reads `calibration-observed.json` → `aggregate.observedEffWps` (measured), then `intake.wordsPerSecond` (estimate), then a default. The margin comes from `intake.wpsSafetyMargin` only — it hedges a guess and is not applied to a measurement |
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
- **A verifier must also be able to *pass*.** `validate-timing`'s contiguity check
  asserted strict adjacency, but `voice.mjs` deliberately inserts a lead-in and
  inter-segment silence — so every timeline the real pipeline produces failed on every
  segment. That is the mirror of a check that can never fail, and worse in daily use: a
  line that is always red trains the reader to stop reading. Overlaps now fail; gaps pass
  and are reported, with uneven ones called out.
- **The word budget knows the difference between a guess and a measurement.** Once the
  windows come from synthesised audio *and* the rate is a measurement of that same audio,
  `words / window` **is** that rate by construction — so a budget built from it, minus a
  safety margin, flags every segment above the mean by definition. In that one case the
  budget is skipped and **rate variance against the measured mean** is reported instead
  (`hard +4.1%`), which is true and actionable. The budget and its margin still apply
  wherever the comparison is real: a measured rate against authored windows is a genuine
  prediction, and an estimate against measured windows says whether the audio came out as
  planned. Every run states which rate it used and where it came from, so a silent
  fallback can never again look like a measurement. See `tests/word-rate.test.mjs`.
- **The suppression requires lineage, not just measured windows.** `endMs - startMs ===
  audio.durationMs` proves the windows came from *some* audio — not that the calibration
  measures the text in the file now. Edit a segment's narration without re-running the
  voice stage and that predicate still holds, which would wave through exactly the case
  the budget exists to catch. So `voice.mjs` records a **`textHash`** — a sha256 of each
  segment's exact narration — and `validate-timing` checks it, along with segment order
  and naming. `{words, chars, clipMs}` are kept only as cheap pre-checks that give better
  messages: they are a *summary*, and every summary collides — `"word0 word1 word2 word3"`
  and `"other word1 word2 word3"` agree on all three while being different scripts. A
  calibration with no fingerprint is **unproven**, not intact, so the budget is evaluated.
  A mismatch is **not** an error — editing and re-validating before re-synthesising is the
  normal loop — it reports `calibration lineage: STALE`, names both sides of the
  divergence, and applies the measured rate as a *prediction* with the margin restored.

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
| `msedge-tts` | Narration synthesis. **Length-deterministic, not byte-deterministic** — see "Re-running the voice stage" below. The timing solve depends on the length determinism, and nothing depends on the bytes. |
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
