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
| `silence-gen.mjs`, `silence-asset.mjs` | S4 | Generate silence assets. `silence-gen` is the standalone generator for a file the caller names; `voice` and `remix` no longer spawn it — they write their lead-in, gap and outro silence in-process. All three take their bytes from `silent-segment.mjs`, so none can drift from the silence `concat-audio` generates. |
| `silent-segment.mjs` | — | **What a deliberately silent segment is**, in one place: the `segments[].silence` declaration, its validation, its authored duration, the frame-aligned silence generator (and the pause-asset rules `voice` and `remix` share with `silence-gen`), the check that a narrated record holds measured words, and the calibration builder that keeps zero-word segments out of the word-rate maths. Side-effect free, so it is unit-tested directly. |
| `silence-scan.mjs` | S4 | Measures head/tail silence by **decoding**, not from synthesis metadata (see bug ledger entry 5). |
| `remix.mjs`, `concat-audio.mjs` | S4 | Solves perceived gaps and concatenates without re-synthesising. Narrated clips are reused as they are; a declared silent segment's audio is generated from its **current** authored window and never taken from a clip, so a silence edit needs no re-voice. Both refuse a narrated segment whose record names its clip but holds no measured words — arranging audio cannot create speech. `concat-audio` reads `timing.json` as the authority — a directory glob cannot tell a deliberately silent segment from a missing clip, which is also why a project that names no clips in `audio.file` is refused once a segment is silent while another is narrated; where every segment is silent, each window is generated. |
| `vo-envelope.mjs` | S4/S8 | Narration amplitude envelope, used to drive sidechain ducking. Bound to the audio it measured; consumers refuse a stale one. |
| `envelope-ducking.mjs` | — | **What an envelope is bound to, and what is ducked from it**, in one place: the input fingerprint and its four lineage states, the one-pole gain trajectory both ducking paths share, the threshold solve, and the bed's ducking record (`<bed>.duck.json`). Side-effect free apart from `publishBedDuckRecord`, which writes that record; unit-tested directly. |
| `write-build-html.mjs` | S5 | Builds the renderable scene. The big one — 65 KB. |
| `frame-capture.mjs` | S6 | Headless-browser frame capture with dedup. **The long pole.** |
| `encode-mp4.mjs`, `append-outro.mjs` | S7 | Frames → MP4, plus end-card append. |
| `make-music.mjs` | S8 | Generated ambient bed, nothing sampled. Named presets — `warm` (I-V-ii-IV in F) and `bright` (vi-IV-I-V in G). Ducks from the shared model in `envelope-ducking.mjs`, so the synthesised and in-graph ducks cannot drift apart. |
| `remux-music.mjs` | S8/S9 | **The cheap path.** Swaps the audio track and preserves the video stream byte-for-byte. Optional in-graph sidechain duck for a licensed bed (`--duck-db`). |
| `preview.mjs`, `preview-seg.mjs` | — | Segment previews before committing to a full render. |
| `astats-levels.mjs` | — | Reads ffmpeg `astats` levels and classifies a window as **measured, silent, or unmeasurable**. Side-effect free, so it is unit-tested directly. |
| `check-levels.mjs`, `audio-probe.mjs`, `validate-timing.mjs` | — | Verification. |

Stage numbers refer to the pipeline contract in
[`references/pipeline-contract.md`](../../.github/skills/demo-recording/references/pipeline-contract.md).

**`write-script.mjs` (S1) is deliberately not here** — see below.

## Deliberately silent segments

A segment can carry no narration at all — an intro slide, a gap between beats, an
intermission where the music bed continues and the voice stops. It is **declared**, never
inferred:

```json
{
  "id": "intermission",
  "startMs": 4000,
  "endMs": 6000,
  "voiceoverText": "",
  "silence": { "caption": "[music]" }
}
```

**Why a declaration and not just empty text.** Before this existed, every duration in the
engine was *produced by TTS*, so a segment with nothing to say had no clip and no
duration — and looked exactly like a segment whose voice stage had not run yet. Both are
"no `audio`". Those two states need opposite handling: a project that forgot to run the
voice stage must fail, an intermission must render. The declaration separates them, and
the old rule is untouched:

| `silence` | `audio` | Meaning |
|---|---|---|
| present | present | A silent segment the voice stage has seen. Its clip is generated digital silence. `remix` (S4) regenerates its clip from the current window, and `concat-audio` (S4) generates the silence into the track from that window without using the clip, so a silence edit since then needs no re-voice. |
| present | absent | A silent segment; the voice stage has not run. |
| absent | absent | **The voice stage has not run. Still fails, exactly as before.** |

**The duration is the window.** `endMs - startMs` is the authored duration and there is
deliberately no `silence.durationMs` — two sources of truth for one number are free to
drift apart, which is the defect class this engine keeps re-shipping. So the window is
taken as written: `startMs` and `endMs` must each be a finite number of milliseconds,
`startMs` at least `0`, and the window must be positive and at most one hour (3600000 ms),
the longest silence the engine generates. A bound that is missing, `null`, a numeric
string or `1e999` (which JSON reads as `Infinity`) is refused, never coerced into a window.
These checks are the declaration's, in `silent-segment.mjs`, and `voice`, `remix`,
`concat-audio`, `frame-capture`, `validate-timing`, `write-storyboard` and
`write-subtitles` each make them; a stage that checks bounds of its own may report a bad
one in its own words first.

**What each stage does with one:**

- **voice (S3)** never sends it to TTS (synthesising `""` returns no word boundaries and
  fails four times with backoff). It generates the clip at the authored length, probes it,
  and reflows the timeline onto the probed value. No inter-segment gap is inserted at a
  seam touching a silent segment, and no lead-in before a leading one — the authored
  silence *is* the pause.
- **concat-audio (S4)** fills the window with generated digital silence so the segment
  occupies its time in the voice track. This is the load-bearing one: omitting it moved
  every later segment earlier with no error. The silence is generated from the **current**
  authored window and never taken from a clip, so a window widened — or a segment
  silenced — since voice ran plays at its authored length, and the old clip (speech, or
  silence of the old length) is left unused on disk. It never writes `timing.json`. A
  project whose timeline names no clip in any `audio.file` has its clips matched to
  segments by their order on disk; once any segment is declared silent while another is
  narrated, a directory listing cannot say which clip is whose, so that is refused (exit
  `2`) — name each narrated segment's clip in `audio.file`. `voice` names every clip it
  writes, on a timeline it accepts; the refusal says whether it would accept this one.
  Where every segment is silent, no clip is matched to anything and each window is
  generated. That refusal comes before any clip is read, after every declaration has been
  checked, so a missing clip earlier in the timeline cannot pre-empt it. A clip a record
  names is claimed under the name the directory lists, however the record cases it, and
  where that name is a link, so is the file the link resolves to. It is claimed under its
  canonical name too, where the platform reports one, so a record naming a regular file
  by its Windows 8.3 short name claims its long name. A short name of a link claims the
  link's own entry, found by the link's identity; where hard links of one link share that
  identity, which of them the short name belongs to cannot be told, so neither is claimed
  and each is reported as one the record may name. Where there is no identity to find it
  by — the volume reports no file IDs, or an entry cannot be inspected — nothing more is
  claimed, and each unclaimed entry that is a link, or cannot be inspected, is reported as
  one the record may name rather than as unclaimed. A regular file left unclaimed is
  reported without that qualifying: a record that names its entry — by its own name, a
  case variant or a short name — claims it, wherever the platform reports the file's
  canonical name. A short name that cannot itself be inspected, or a file whose canonical
  name the platform does not report, claims nothing beyond the names above, and the entry
  it reaches may then be reported as unclaimed. That is accounting only: what is read is
  still the path the record names.
- **remix (S4)** generates the same silence, writes it as the segment's clip under the
  name voice gives it (`segment_NN.mp3`), reflows the timeline onto its length, and
  rewrites the record to describe it: that length, no words, no head or tail. A second
  remix changes nothing. This is the route for a silence edit — an intermission's length,
  silencing a narrated segment — because `voice --apply` re-synthesises every clip. It
  checks the timeline's shape before anything else it asks of its segments: a missing or
  empty segment list is refused, and so is an entry that is not a segment object or has no
  non-empty string `id`, named by its index — exit `2`, in its plan as well as under
  `--apply`, before anything is written; `voice` refuses the same shapes. It does
  not fill a segment the voice stage never saw: while any segment has no audio record it
  refuses (exit `2`) before writing anything, and its plan names those segments. Every
  output is staged beside its destination and checked before any is published — the voice
  track is probed from the staged bytes and held to the reflowed timeline (C-6) — then
  each is renamed into place, `timing.json` last. A failed check publishes nothing (exit
  `1`); a rename that fails partway names what was and was not published, and leaves
  `timing.json` as it was.
- **Both S4 stages refuse** a malformed declaration (`"silence": false` included) and a
  narrated segment whose record names its clip but holds no measured words: that clip is
  not narration voice produced for it, and arranging audio cannot create speech. So, with
  such a record, removing a declaration needs the voice stage, and they say so.
- **A remedy names a stage only where that stage would run.** Every diagnostic here that
  names `voice` or `remix` as the next step first asks `silent-segment.mjs` whether that
  stage would accept the project as it stands: whether it has a list of segment objects,
  each with a non-empty string `id`, its silence declarations, its narration text, the
  clips its records name, and the files the stage writes. Where it would refuse, the
  message names it as refusing and says why.
  While any silence declaration is malformed, the part of a remedy that would name `voice`
  or `remix` — as the step, or as refusing — reports that declaration in the stage's
  place, since neither stage would run on that timeline: `remix` and `voice` each refuse
  it before writing anything, in their plan as well as under `--apply`. Each reports that
  declaration (exit `2`) once its own earlier checks have passed. A failure in one of
  those is reported first, in its own words, instead of the declaration; for `voice`, a
  failure of its brand voice allow-list (`brand/tokens.json`) exits `1`. When asked
  whether a stage would accept the project, `silent-segment.mjs` asks whether every
  segment is an object with a non-empty string `id` before it asks about declarations, so
  a segment that is not one, or has none, can be reported instead, as the stage's refusal.
  The declaration replaces only part of the
  message: the explanation around it can still name a stage. The intake, brand tokens, the
  TTS service and the `--replace` guard are not modelled; each stage reports those itself.
  Three limits: `validate-timing --timing <file>` checking a file other than the project's
  `timing.json` names no stage as the step, because every stage reads `timing.json` — it
  says instead to install the file as `timing.json` (and that this replaces the one there,
  where there is one) and run `validate-timing` again without `--timing`, which decides
  the stage. A case variant, an 8.3 short name or an in-root link of `timing.json` is that
  file; once a stage replaces it, a case variant or a link names the new one, and a short
  name names it or nothing. A hard link of it is not: it is another entry for the file,
  which a stage publishing `timing.json` by rename leaves holding the old timeline. Where
  the volume reports file IDs a hard link is told just that, with no install step —
  installing it would copy the file onto itself — and where it reports none, it is treated
  as another file. `concat-audio`'s refusal of a missing clip, in a timeline that names no
  clip in any `audio.file` and declares no silence, keeps the wording it always had, which
  names `voice` without asking; so does `frame-capture`'s refusal of a narrated segment
  with neither a finite `endMs` nor a `startMs` and `audio.durationMs` to derive one from.
  And a `remix` run whose publishing fails partway names a re-run of `remix` without
  asking: that run has just passed every check `remix` makes of this timeline, which it
  leaves as it was.
- **frame-capture (S6)** checks the declaration as the stages above do, refusing a
  malformed one (exit `2`) before it plans, launches a browser or writes anything, and
  takes a silent segment's end from its authored `endMs` — never from `startMs` plus
  `audio.durationMs`, which it derives only for a narrated segment with no finite `endMs`.
- **write-subtitles (S10)** emits the authored `caption` as one cue spanning the window.
  There are no measured word boundaries to caption from, so the cue text must be authored;
  a blank one is refused rather than rendered as an empty caption box, and so is one
  holding `-->` or any of Unicode's seven mandatory line breaks — U+000A, U+000B, U+000C,
  U+000D, U+0085, U+2028 and U+2029 (UAX #14 classes BK, CR, LF and NL). CR and LF are a
  WebVTT file's own line terminators, with CRLF, so either can end the cue there; a
  cue-text line holding `-->` ends the cue in Chromium's parser (measured). The other five
  are refused without a per-player measurement: a cue is one line by construction, and
  those are the characters that end a line by definition rather than by one reader's
  convention. None of the seven has a glyph, and U+0085, U+2028 and U+2029 can sit
  unescaped in `timing.json`, so the refusal names each distinct one it found by code
  point, in order of first appearance — `a line break (U+2028)`. NARRATED cue text is
  refused for `-->` on the same grounds, so the two halves read as one rule: a cue-text
  line holding `-->` is parsed with EMPTY text by Chromium's WebVTT parser (measured, via
  a `<track>` element read back against a well-formed control), so the caption silently
  disappears rather than rendering wrongly, and cue text that is itself a whole timing
  line forges a second cue spanning those times. Nothing is claimed here about any other
  player. Both sources of cue text are checked — `voiceoverText`, and the raw measured
  `audio.words[].word` a cue falls back to where alignment fails — and the refusal names
  whichever carries it, the narration alone where both do. It lands before either file is
  written, so `.srt` is covered by the same gate. A line break in `voiceoverText` is not
  refused, but for a narrower reason than "it cannot get there": six of the seven —
  U+000A, U+000B, U+000C, U+000D, U+2028 and U+2029 — are split away as whitespace before
  they reach a cue, while `U+0085` is not matched by JS `\s` at all and does reach cue
  text. It is left unrefused because it is not destructive there: measured in Chromium,
  the cue is intact and the NEL survives as an invisible character. The spoken cue just
  before it keeps its last word on screen until that word ends rather than stopping 40 ms
  short, and never overlaps it; a measured word that runs into a silent window is refused,
  naming `remix` (the window moved) or `voice` (the narration did). A `durationMs` shorter
  than the last window names `remix` when the change is a silence edit — the last window is
  a silent one, or an earlier silent window no longer holds the silence its record
  describes — and when an earlier silent record names its clip but gives no usable length,
  which `remix` rewrites. It names `voice` otherwise, including for a silent segment whose
  record names no clip, which `remix` refuses — unless every segment is silent, when no
  stage measures the timeline and it says to set `durationMs` by hand. A silent segment
  whose `startMs` or `endMs` is not a number of milliseconds is an authored field to
  correct by hand — never a re-voice. The message gives the bound that keeps the window
  positive (`startMs` below `endMs`, `endMs` above `startMs`), names the other field as
  well where no value of the bad one alone would do, and only after those edits, if they
  change the window's length, names `remix` to reflow the timeline onto it.
- **write-chapters (S11)** gives it a chapter like any other segment, and routes a
  `durationMs` short of the last window, and a silent window field that is not a number,
  by the same rules, from `silent-segment.mjs`.
- **calibration** excludes it from the per-segment and aggregate word rate. A rate over
  zero words is not a slow rate — it is `NaN`, which `JSON.stringify` writes as `null`.
- **validate-timing** reports it as `silent` rather than `n/a`, and checks the declaration
  and the record: a silent segment whose record still carries measured words — silenced,
  then concatenated without `remix` — fails, naming `remix`. Calibration lineage ignores a
  silent window, which is authored, but not the declaration: a segment silenced or
  un-silenced since the voice stage ran makes lineage stale, with advice that follows the
  direction (a silence edit needs no re-voice; un-silencing needs `voice`). A silent window
  that is not the length its record gives — edited since its silence was generated —
  fails as `declared silence: NOT REFLOWED` (exit `1`), naming `remix`, by the same test
  `remix` applies, from `silent-segment.mjs`. A record that is there but gives no usable
  length — not an object, or a `durationMs` that is not a number ≥ 0 — fails as
  `declared silence: INCOMPLETE RECORD` (exit `1`). Each of these record failures names
  `remix` when the record names its clip, and `voice` when it names none, because `remix`
  refuses a segment without one. A silent segment with no audio record at all is reported
  as `declared silence: UNCHECKED` — not failed, and not counted in the `OK` line, which
  lists only the segments it checked. Beside silent segments, the `MEASURED` windows label
  claims only the narrated windows. Checking a file other than the project's `timing.json`
  with `--timing`, none of these messages names a stage as the step (see the limits above).

**One rounding caveat, disclosed at the point of use.** Generated silence is frame-aligned
to 24 ms, so a filled window lands within 12 ms of its authored length (a 2000 ms window
becomes 1992 ms). `voice` and `remix` reflow the timeline onto the real value, so a full
pipeline run stays consistent; a standalone `concat-audio` prints the accumulated delta and
names `remix` as the step that reflows it, where `remix` would run — no re-voice needed.

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
- **A file name the engine chose is never written through a link**, even one that stays
  inside the project. `voice` and `remix` write their lead-in, gap and outro silence
  in-process through the same link-refusing resolver as every other output, and list them
  in the plan under the same `--replace` guard; they used to hand them to a `silence-gen`
  child, which follows an in-root link. `concat-audio` refuses a link at its default
  `voiceover.mp3`, while a path you name with `--out` may still resolve through one.
- **`remix` never writes a narrated clip it reads, under any name.** Before the plan it
  refuses (exit `2`) a destination that is that clip: by name — the path the record
  resolves to, links followed, which catches an in-root link and, on Windows, a case
  variant — by canonical name, which needs no file IDs and catches a Windows 8.3 short
  name, and by file identity where the volume reports file IDs, which catches a hard link.
  A hard link is refused even though publishing by rename would leave it holding its
  narration; where the volume reports no file IDs a hard link is not detected, and its
  narration survives at its own name. The refusal names the record's own spelling and how
  it reaches the destination, and advises a copy: the narration gets a file of its own and
  its record points there, while a file another record names stays where it is; it says
  when the next run needs `--replace`. Each output is then published by rename, which
  replaces the entry rather than writing through it.
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
record of them survives. `voice` writes six things besides the silence it inserts — the
segment clips, `voiceover.mp3`, `timing.json`, `calibration-observed.json`,
`sync-mapping.md` and `heal-log.txt` — and the
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

1. `--confirm-gain`, on a person's answer, to accept the mix parameters and produce the mix;
2. `node src/check-levels.mjs --file <out>` to measure it;
3. read the lead-in window, where the bed plays alone, **before delivering**.

**`--confirm-gain` is the caller's assertion** that a person measured or listened to the mix
and accepts these values for this source. The tool cannot tell who passed it, and records
`evidence: "operator-confirmed"` either way — so an agent must not pass it on its own
authority: ask the person, and pass it only on their answer.

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
it cannot account for describes a mix nobody confirmed. A gain too small to render as a
plain decimal — nonzero and below `0.000001` — is refused as usage (exit `2`) before it
reaches the graph.

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
| a number in the finished graph that no declared use or structural literal accounts for | a change carrying **no digit at all** outside the `asplit`/`amix` literals — swapping `alimiter` for `acompressor`, `level=disabled` → `enabled` |
| a number duplicating a declared value (accounting is by value **and** use-count) | a value inside a `[link label]` (redacted before the scan) or shaped like a **filter identifier** (`c0`, `ml1` — digits in a name are skipped) |
| **any run of characters carrying a digit** that is neither a plain decimal nor a filter identifier — `.5`, `5.`, `+1.5`, `-1.5`, `1e3`, `1.5E-2`, `6dB`, `128k` all stop the run rather than being skipped | **whether `pinned` is set correctly** — nothing mechanical can know a knob moves the level, and this has already been got wrong once (see below) |
| a `pinned` parameter never declared, or declared and never applied | |
| a **structural literal** — `atrim=0:`, `asplit=2`, the whole `amix` — appearing more or fewer times than the graph builder took it through `mix.structural()`, or anywhere but at a filter boundary. A second `asplit`/`amix` pair doubles a bus without adding a number; literals were once stripped wherever they appeared, so it passed as structure | |

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
pinned. So is `--crossfade`, once left unpinned as a knob that only joins a loop wrap: on a
looping bed its tri curves dip up to 3.01 dB at each overlap's midpoint, so it sets the bed
level for a large share of the running time. The confirmed set is `--voice-gain`,
`--music-gain`, `--ceiling`, `--crossfade` and the four duck knobs `--duck-db`,
`--duck-ratio`, `--duck-attack`, `--duck-release`. Nothing mechanical caught either error,
and nothing mechanical would catch the next one.

**A conditional pinned knob is recorded as absent, not omitted.** The duck is opt-in, so
on a run without `--duck-db` its knobs have no value — but a pinned parameter must still
be accounted for or the pin records a partial set. `mix.declareAbsent()` writes
`NOT_IN_FORCE` (`0`) for them, and `mix.use()` refuses a knob declared that way, so "not in
force" cannot be claimed for a value that is in force. **Turning ducking on is therefore a
changed pinned parameter** and demands a fresh confirmation — which is correct, because
switching the duck on moves the delivered mix. `--crossfade` is conditional the same way:
it reaches the mix only when the bed loops, so on a bed that covers the video it is
recorded `NOT_IN_FORCE` whatever the flag says and a change to it asks for no confirmation,
while a bed that starts looping — a longer video, a shorter track — is a changed pinned
parameter. So the loop is decided before the pin is checked, and on `--apply` durations
that cannot be read stop the run (exit `1`) rather than being guessed.

> **Adding the duck knobs invalidated every existing pin**, exactly as `--ceiling` did, and
> pinning `--crossfade` did it again. Each time, each project needs **one** more
> `--confirm-gain`. That is the mechanism working rather than an obstacle: the set grew, and
> the pin failed loudly instead of quietly certifying a set it no longer covers.

### Sidechain ducking for a file-sourced bed

`make-music` bakes a duck into the bed it synthesises. A **licensed track has no such
step**, so before this a file-sourced bed played flat: one gain served two knobs 11 dB
apart, and `musicInGapsDb` had **no effect at all** for any project using one. Since the
music-sources work, a licensed track is the expected path.

`remux-music --duck-db <dB>` ducks it **in the filter graph**, with `sidechaincompress`:

```powershell
# 1. measure the narration (bind the envelope to the audio it describes)
node src/vo-envelope.mjs --apply --replace

# 2. plan the duck — prints the solved threshold and the tolerance, writes nothing
node src/remux-music.mjs --video render.mp4 --out render-with-music.mp4 `
  --music-gain 0.117 --voice-gain 1.40 --ceiling 2.0 `
  --duck-db 11 --duck-envelope vo-envelope.json

# 3. apply, confirming the pinned set (the duck knobs are all pinned)
node src/remux-music.mjs --video render.mp4 --out render-with-music.mp4 `
  --music-gain 0.117 --voice-gain 1.40 --ceiling 2.0 `
  --duck-db 11 --duck-envelope vo-envelope.json --apply --confirm-gain
```

Without `--duck-db` the `--duck-*` options are refused (exit `2`), not ignored: ducking is
off, so nothing would read them.

**Set the levels with two knobs, not one.** `--music-gain` puts the bed at your
`musicInGapsDb`; `--duck-db` is the **difference** down to `musicUnderSpeechDb`. For
−30 and −41 that is `--duck-db 11`.

> **`musicGain` must be RE-DERIVED once ducking works.** A value tuned while the bed
> played flat is compensating for the duck's absence — it is low so that narration stays
> intelligible. With a duck in the graph that same value puts the bed far below the gaps
> level. Re-derive it from the track's measured RMS and your gaps target.

**A bed `make-music` ducked is checked against the narration, and never ducked twice — if it
has a ducking record.**
`make-music --envelope` bakes its duck into the samples, timed to the narration it was made
with, and nothing in the audio says so. So `make-music --apply` writes `<out>.duck.json`
beside every bed: the narration it ducked against, or that it did not duck. `--replace`
overwrites a record that is a regular file, never a link or a directory: one already at the
record's name is refused before the bed is synthesised (exit `2`) and left as it is, and the
bed is not written. Without `--replace` the record is created only if its
name is still free when it is published: one that appeared while the bed was synthesised is
refused (exit `2`) and left as it is, and the bed is not written. That publish makes a hard
link, which a FAT or exFAT volume cannot: there it fails (exit `1`) and writes neither file;
`--replace` publishes by rename instead, and overwrites an existing bed and a record that is
a regular file.
If the record's file cannot be closed once the record is published, what was written to it
cannot be confirmed: the run fails (exit `1`), the record is left at its name, and the bed is
not written. Move the record aside, or re-run with `--replace` to overwrite it.
`remux-music` reads the record on the plan and on `--apply`, with or without `--duck-db`:

| The record says | `remux-music` |
|---|---|
| ducked, against the narration in play | uses the bed's own duck. **`--duck-db` is refused (exit `2`)**: it would duck the bed a second time. Drop it, or write a flat bed with `make-music` (no `--envelope`) and duck that in the graph |
| ducked against other narration, fingerprints other bytes than the bed, or is malformed | refused (exit `1`), naming what differs or what is wrong with it |
| not ducked | the bed plays flat, or `--duck-db` is its only duck |
| *nothing — no record* (a licensed track, or a bed from before records existed) | **not read as flat**: the plan says whether `make-music` ducked it cannot be told, and with `--duck-db` that the in-graph duck lands on top of any duck baked into it |

A bed with no record gets no such check: `--duck-db` is not refused on a `make-music` bed from
before records existed, and ducks it a second time if it was ducked. The plan warns; it does
not prevent it.

`remux-music` refuses a link, or anything but a regular file, at the record's name (exit
`2`), and reports a record that does not parse by its length, never its contents.

**Why `sidechaincompress`, and what was rejected.**

| Approach | Verdict |
|---|---|
| Piecewise `volume` expression driven by the envelope | **Rejected.** ~3,042 numeric literals in `-filter_complex` for a real envelope. The registry audit refuses undeclared numbers by design; the two cannot coexist. |
| Pre-graph PCM ducking (decode, curve in JS, mix the ducked WAV) | **Rejected.** The duck parameters would never appear in `-filter_complex`, so audit rule 5 would stop a *correct* run. The remedy would be an exemption in a guard one day old. |
| In-graph `sidechaincompress`, threshold solved from the envelope | **Shipped.** Constant graph footprint whatever the envelope says. |

**The threshold is solved, not guessed.** A compressor's depth is
`(level − threshold) × (1 − 1/ratio)`, so a fixed threshold delivers whatever depth the
narration happens to land on. `remux-music` measures the speech level in the envelope and
solves the threshold backwards from `--duck-db`. That is why the envelope must describe
the narration in play, and why a stale one stops the run. A depth the narration cannot
deliver — the solved threshold would fall outside the range ffmpeg's `sidechaincompress`
accepts — is refused (exit `2`), naming the depth it can reach, rather than clamped while
the pin records the depth that was asked for.

#### The gaps level is APPROACHED, not reached — and by how much

A one-pole release closes on its target asymptotically and never arrives. At the defaults
(`--duck-db 11`, `--duck-release 800`):

| Gap | Bed is still short of the gaps level by |
|---|---|
| 0.50 s | 4.21 dB |
| 1.00 s | 2.00 dB |
| 1.51 s | 1.00 dB |
| **1.83 s** (a measured inter-segment gap) | **0.66 dB** |
| 3.31 s | 0.10 dB |
| 4.00 s | 0.04 dB |

So in the model a real inter-segment gap comes within about **0.7 dB** of `musicInGapsDb`
(a modelled figure, not a bound: see the one measured render below), and a **silent
segment** — an intro slide, an intermission — sits on it properly, because the release
keeps riding up and **nothing caps how long the excursion may last**. There is
deliberately no hold and no hysteresis: a hold long enough to stop word-gap pumping and a
cap on excursion length are the same mechanism at two timescales, and the second one
breaks the intermission case. `sidechaincompress` cannot express a hold either, so adding
one would put the model and the graph out of agreement.

The plan prints this figure **for the release actually in force, against the gaps measured
in your envelope** — not the table above — and refuses an envelope whose `hopMs` is not a
number of milliseconds from 1 to 1000 (exit `1`), because it sets every gap length. A
shorter `--duck-release` closes the modelled figure further, at the cost of more audible
movement across word gaps. But the one measured render did not track the model, and nothing
was measured below 800 ms, so release is **not** the coefficient to tune by this number.

**Two further limits, stated rather than implied.**

- The solve lands the depth on the **average** speech level. Speech is not constant-level,
  so a syllable *N* dB louder ducks `N × (1 − 1/ratio)` dB deeper — 0.75·*N* at the default
  ratio 4. The depth is a **centre, not a clamp**; lower `--duck-ratio` narrows the spread.
- **One render has been measured, and it did not track the model.** The figures above are
  computed from the one-pole model the tests pin. With an 11 dB duck across a 1.82 s median
  gap, the bed measured 0.05–0.12 dB short at an 800 ms release (model 0.67 dB), 2.0–3.5 dB
  at 1500 ms (model 2.09) and 6.1–8.7 dB at 2500 ms (model 3.70). So the model is **not a
  bound in either direction**, ffmpeg's `attack`/`release` coefficients do not map onto it
  exactly, and nothing was measured below 800 ms. Verify by decoding the
  output and measuring — and **measure inside true gaps, not near their boundaries**. A
  first attempt at this sampled 0.1 s from a boundary, measured narration, and read the
  result as "ducking barely worked".

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

**Known gap — what this pin does not do.** It records that the caller passed
`--confirm-gain` — an assertion that a person accepted a set of mix parameters, which the
tool cannot check — not that anyone measured the result. `music-gain.lock.json` carries
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
it reuses the narrated `segment_*.mp3` clips on disk byte-for-byte and only changes
pacing. (A declared silent segment's clip it regenerates from the authored window; that
is digital silence, the same bytes every time.) And
`vo-envelope.json` is the one artefact derived from audio *content*, so it is **bound to
the audio it measured**: it records a `measuredFrom` fingerprint of the voice track, and
every consumer refuses an envelope that describes different audio. Restore the clips that
produced a shipped render and the envelope is valid again — the same separability
`textHash` has. Re-measure it with `node src/vo-envelope.mjs --apply --replace` if you
restore audio it was not measured from.

### The envelope is bound to the audio it describes

`vo-envelope.json` had no binding to the narration it measured. A measured instance:

| | |
|---|---|
| envelope `durationMs` | 291,984 (14,600 hops present) |
| timeline `durationMs` | 276,528 (13,826 hops expected) |
| drift | **15,456 ms** |

15.5 seconds stale, from a cut two rounds old — and the file parsed perfectly. A duck
calibrated against it drifts further out of alignment the longer the video runs, with
nothing reporting it. This is a defect class this engine has shipped more than once: a
generated artefact with no guard tying it to the thing it describes.

`vo-envelope --apply` now writes `measuredFrom: { file, bytes, sha256 }` — **a fingerprint
of the INPUT**, for the reason stated above: a fingerprint over the input is separable from
the artefact it certifies, and one over the artefact would prove only that nobody edited
it. `make-music` and `remux-music` both check it and **refuse** rather than calibrate
against it.

Four states are kept apart, because they are different situations for the operator:

| State | Meaning |
|---|---|
| `current` | The recorded fingerprint matches the voice track on disk. |
| `stale` | Present, readable, does not match. The refusal **names the fields that differ**. |
| `unbound` | No binding at all — an envelope predating this check. **Absence is not permission.** |
| `unreadable` | A binding is present but is not a binding. |

A refusal states **only that the two differ**. It does not say who changed either file or
when: mtimes are not provenance, and naming an unprovable cause is the mistake that got a
`stamp-lineage` tool withdrawn (above). Nothing is silently re-measured — the refusal
prints the command to run.

**What it does not detect** is in `src/envelope-ducking.mjs`, in full: an envelope measured
from the right audio whose RMS values were then edited; a timeline re-cut that leaves the
voice audio untouched (deliberate — the envelope describes the *audio*); which stage wrote
either file; and a swap between the check and the read, which is narrowed by checking at
the point of use, not closed.

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
node src/make-music.mjs --out bed.wav --seconds 240 --preset bright   # then: --apply (writes bed.wav and bed.wav.duck.json)
node src/remux-music.mjs --video render.mp4 --out render-with-music.mp4   # then: --apply --confirm-gain

# a licensed bed, ducked under narration (see "Sidechain ducking" above)
node src/remux-music.mjs --video render.mp4 --out render-with-music.mp4 `
  --duck-db 11 --duck-envelope vo-envelope.json      # then: --apply --confirm-gain

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
  segment's exact narration — and `validate-timing` checks it, along with segment order,
  naming and each segment's `silence` declaration. `{words, chars, clipMs}` are kept only
  as cheap pre-checks that give better messages (`clipMs` is not compared for a declared
  silent segment, whose window is authored rather than narrated, so a silence edit does
  not make lineage stale; a silent window its record does not describe fails the
  declared-silence check instead, naming `remix`, or `voice` where its record names no
  clip): they are a *summary*, and every summary collides — `"word0 word1 word2 word3"`
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
The in-repo callers (`remix.mjs`, `voice.mjs`) were updated, and have since stopped
spawning `silence-gen` at all; **external project build sequences must add the flags.**

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
