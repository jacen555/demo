# Bug Ledger

Failures that were expensive to find and are cheap to avoid. **Read this before any
audio mix, remux, or timing solve.**

Every entry here was recorded because it was expensive to find. Most were discovered by
measuring a finished artifact and finding it disagreed with the intent; a few — entry 12 is
the clearest — were written **pre-emptively**, from a failure mode reasoned about before it
could cost anything. Where an entry labels its evidence, `[OBSERVED]` means measured rather
than guaranteed; **labelling is not yet consistent across entries**, so read the body rather
than assuming an unlabelled claim was measured. None of them announce themselves — that is
what makes them worth recording.

Format: **Symptom → Cause → Fix**, with the measurement that exposes it.

**Numbers are stable identifiers, not an ordering** — other files cite them
(`knobs.json`, `cost-techniques.md`). Never renumber an existing entry; append.

## Contents

**Audio mixing**
1. [`alimiter` silently gain-rides the whole mix](#1-alimiter-silently-gain-rides-the-whole-mix)
2. [`-shortest` truncates the end card](#2--shortest-truncates-the-end-card)
3. [Mono→stereo upmix costs 3 dB](#3-monostereo-upmix-costs-3-db)
4. [Fade-in longer than the lead-in](#4-fade-in-longer-than-the-lead-in)
15. [`amix duration=longest` does not extend a short music track](#15-amix-durationlongest-does-not-extend-a-short-music-track)
16. [Changing the music source invalidates the mix gain](#16-changing-the-music-source-invalidates-the-mix-gain)

**Timing**
5. [TTS tail silence cannot be derived from word-boundary metadata](#5-tts-tail-silence-cannot-be-derived-from-word-boundary-metadata)
6. [Perceived gap ≠ inserted silence](#6-perceived-gap--inserted-silence)
13. [The reference `voice.mjs` still derives tails from metadata — and three videos shipped with it](#13-the-reference-voicemjs-still-derives-tails-from-metadata--and-three-videos-shipped-with-it)

**TTS**
7. [Re-synthesis appears safe — but is not guaranteed](#7-re-synthesis-appears-safe--but-do-not-depend-on-it-being-guaranteed)
10. [SSML break tags are not available](#10-ssml-break-tags-are-not-available--the-silence-solve-is-not-a-workaround)
11. [The TTS backend is an unofficial, moving surface](#11-the-tts-backend-is-an-unofficial-moving-surface)

**Assembly**
12. [Do not concatenate audio per-segment](#12-do-not-concatenate-audio-per-segment-pre-emptive)

**Tooling hygiene**
8. [Hard-referenced optional config keys](#8-hard-referenced-optional-config-keys)
9. [Measure the output, not the input](#9-measure-the-output-not-the-input)

**Scene authoring**
14. [A trigger that resolves to nothing renders a blank segment, silently](#14-a-trigger-that-resolves-to-nothing-renders-a-blank-segment-silently)

---

## Audio mixing

### 1. `alimiter` silently gain-rides the whole mix

**Symptom.** Changing the music level barely moves the output. In the reference
case, cutting music by 6.9 dB moved integrated loudness by **0.3 dB**. Output
peaked at −0.0 dBFS instead of the intended −1.0.

**Cause.** ffmpeg's `alimiter` defaults to `level=true`, which auto-levels output
up to the ceiling. It was undoing every adjustment as it was made.

**Fix.** Set `level=disabled`:

```
alimiter=limit=0.891:level=disabled
```

**Detect.** Make a deliberate large change to one stem and re-measure integrated
loudness. If the total barely moves, something is auto-levelling.

---

### 2. `-shortest` truncates the end card

**Symptom.** The final frame is missing. Frame count is one short of the dry
encode. Only appears *after* an unrelated change.

**Cause.** `-shortest` ends output at the shortest input. While the music bed was
longer than the video this was harmless. Once the bed got shorter, it started
clipping the video's last frame.

**Fix.** Drop `-shortest`. Set durations explicitly instead.

**Detect.** Compare frame count against the dry encode. They must match exactly.

---

### 3. Mono→stereo upmix costs 3 dB

**Symptom.** Narration is quieter after a remux that should not have touched it.

**Cause.** Converting mono narration to stereo via `aformat` splits energy across
channels, costing ~3 dB.

**Fix.** Use an explicit `pan` that duplicates rather than distributes:

```
pan=stereo|c0=c0|c1=c0
```

**Detect.** Measure narration-only loudness before and after. It must be unchanged.

---

### 4. Fade-in longer than the lead-in

**Symptom.** The music bed is inaudible at the start; it arrives under the
narration instead of before it.

**Cause.** A 3 s fade-in against a 2 s lead-in means the bed is still ramping when
speech begins.

**Fix.** Keep fade-in **shorter** than `leadInMs`. Roughly 0.5–0.7× is comfortable.

**Detect.** Measure loudness of the lead-in region alone. It should be within a few
dB of the intended bed level by the time speech starts.

---

### 15. `amix duration=longest` does not extend a short music track

**Symptom.** The music bed simply stops partway through the video and the rest
plays with narration only. No error, no warning, and the mix command looks
correct. In the case that exposed it, a 2:38 track under a 4:10 video left
**the final 92 seconds with no bed at all**.

**Cause.** `duration=longest` describes how long the *output* runs — it takes the
longest input. It does **not** loop, pad, or stretch a shorter input. A music
input that ends early just stops contributing, and `amix` is perfectly happy:

```
[vo][mu]amix=inputs=2:duration=longest:normalize=0[mx]
```

This is easy to miss because it only bites when the bed is *generated* to length
for every earlier video — `make-music.mjs` takes a duration argument, so every
project that used a generated bed was immune. The first file-sourced track hit it
immediately.

**Fix — NOW IMPLEMENTED; this is a solved defect, kept for the arithmetic and the reason.**
`remux-music.mjs` loops the bed with a crossfade at each wrap (`--crossfade`, default 3s),
sizes the loop from the video (`--video-seconds` overrides it), and `--no-loop` refuses
rather than looping. `validate-scene` E3 can catch it one stage earlier, with two bounds
worth knowing: it reads `knobs.json`, so it is NOT evaluated when a project keeps none (the
run says so rather than passing silently), and it accepts a short bed whose knobs declare
`audio.music.loop.required: true`, because looping is the sanctioned remedy. So E3 flags a
**declared, file-sourced bed shorter than the video that has not been marked for looping**.
The arithmetic below is why the loop works.

Loop the music to cover the video, with a **crossfade at each wrap**, and
trim to the exact video length. A hard loop point in an ambient bed is audible.
`n` copies crossfaded end-to-end yield `n*D - (n-1)*X` seconds, so the smallest
covering `n` is `ceil((video - X) / (D - X))`:

```
[2:a][3:a]acrossfade=d=3:c1=tri:c2=tri[ml1];
[ml1]atrim=0:<videoSeconds>,asetpts=N/SR/TB,volume=<gain>[mu]
```

Pass the music file once per copy (`-i track.mp3 -i track.mp3`). Derive
`videoSeconds` from the capture stage's own frame formula
(`ceil(((durationMs + 1000)/1000) * fps) / fps`) rather than probing the
container, so it agrees with the encoded stream exactly.

**And refuse to do nothing silently.** If the track is shorter than the video and
looping is disabled, that must be a loud error naming the shortfall — never a
quiet stretch of missing bed:

```
music is 158.46s but the video is 250.63s — the last 92.17s would have NO bed at all.
```

**Detect.** Measure RMS in a **narration-silent gap past the music's end** and
compare it with a gap before the end. They should match within a dB or so. On the
verified fix: −9.8 / −9.3 / −8.8 dB at 184 s, 207 s and 250 s against −9.2 dB at
49 s. Measuring the whole file will *not* reveal this — narration dominates the
average and hides a missing bed entirely.

---

### 16. Changing the music source invalidates the mix gain

**Symptom.** A music-bed swap that should be a cheap audio-only remux ships a mix
**~10 dB too loud**. Whole-file RMS measured **−9.8 dB** against a sibling video's
−19.1 dB, with true peak at −0.2 dBFS instead of −1.0. Nothing in the remux
reports a problem, the loop and crossfade are correct, and the bed is audibly
present throughout.

**Cause.** The music gain is tuned against whatever the bed *was*. Measured RMS of
the two sources in one project:

| Source | RMS | Peak |
|---|---|---|
| Generated bed (`make-music.mjs`) | **−43.1 dB** | −25.2 dBFS |
| Licensed track (commercial master) | **−11.4 dB** | **+0.6 dBFS** |

**31.7 dB apart.** A commercial master is loudness-normalised and peak-limited —
often clipping slightly — while a generated ambient bed is quiet by construction.
A gain of `1.50` that was correct for the **generated bed** is catastrophic for the
**licensed track**: the same multiplier applied to a source 31.7 dB louder is what puts the
mix ~10 dB over, which is the symptom at the top of this entry.

**Fix.** Recompute the gain whenever the source changes — and target the right level for
the mode you are in, because three modes differ:

- **Flat bed, no ducking anywhere.** One gain serves both targets, so target the
  under-speech level: `gain_dB = musicUnderSpeechDb − measured_RMS_of_the_new_track`.
- **Pre-ducked generated bed** (`make-music.mjs` bakes the duck into the samples, and
  `remux-music.mjs` accepts it without `--duck-db`). The duck is already in the audio, so
  the gain positions a bed that already moves: target the **gaps** level, or the gaps sit a
  duck-depth too quiet. The record beside the bed (`<bed>.duck.json`) says whether this
  applies.
- **Sidechain-ducked file bed** (`--duck-db` with `--duck-envelope`). The unducked gain is
  what plays in the gaps and `--duck-db` supplies the reduction under speech, so target the
  gaps level here too: `gain_dB = musicInGapsDb − measured_RMS_of_the_new_track`.

The question is not "is `--duck-db` set" but **"does this bed already duck"** — in the
samples or in the graph. Either way, target a level, never the previous gain number:

```
gain_dB = <target level for your mode> − <measured RMS of the new track>
```

**Which RMS, for a pre-ducked bed, is NOT settled here.** Whole-track RMS includes the
attenuated speech-time passages, so it under-states the unducked level the gaps target
assumes, and a gain computed from it lands high. Measure a narration-silent window of the
bed instead — or compute from the unducked source if you still have it — and then **verify
the delivered mix** with `check-levels.mjs` rather than trusting the arithmetic. For a flat
bed the distinction does not arise and whole-track RMS is the right input.

In the reference case, a flat bed with no ducking, that gave `0.055` (≈ −25 dB) against the
previous `1.50`.

**Detect — and this is the part that bites.** The loop fix in entry 15 had already
been verified by measuring RMS in narration-silent windows, and those measurements
were *correct*: the bed was present, at consistent level, across the whole video.
**Window measurements show presence, not absolute correctness.** They cannot
reveal that the level is uniformly wrong.

> **The rule: a source change invalidates the gain, and only an ABSOLUTE LEVEL
> comparison catches it.** A window measurement can do that — the lead-in, where the
> bed plays alone, is the cheapest one, and `check-levels.mjs` reports it. What cannot
> catch it is a PRESENCE check: "the bed is there, at consistent level, throughout" was
> true and told you nothing. Re-run `check-levels.mjs` after ANY change to the bed — new
> track, different preset, regenerated bed — and compare the number against a reference
> video rather than against itself. Presence checks and level checks answer different
> questions, and this project ran the first while skipping the second.

**Now enforced, and the placement is the point.** `remux-music.mjs` pins the gain
to a SHA-256 of the music source in `music-gain.lock.json`, and refuses when the
source changes while the gain does not:

```
error: the music source CHANGED but --music-gain did not.
  calibrated against  music.wav (1b37457d10c6) at gain 1.5
  now supplied        licensed-master.mp3 (52188cb00ad4) at gain 0.48
```

`--confirm-gain` re-pins. It records the caller's **acceptance** of the new values — the
tool cannot verify that anyone measured anything, and records `operator-confirmed` either
way — so measure the mix it produces before you deliver it:
`node src/check-levels.mjs --file <out>`, reading the lead-in window where the bed plays
alone. The pin is committed with the project, so it travels rather than living in one
machine's head.

> **Why the check lives where the SOURCE changes, not where the gain is parsed.**
> Validating the gain *value* bounds it to a sane range — and 1.50 is in range for
> both a generated bed at −43.1 dB RMS and a licensed master at −11.4 dB. The two
> are 31.7 dB apart and the same in-range number is right for one and 10 dB hot for
> the other. **Range validation and calibration validation are different checks**,
> and only the second one could ever have caught this. Bounding an argument protects
> against a bad value; pinning it to its input protects against a stale one.

### ✅ Related: a file bed could not duck — it can now

**This entry described a limitation that no longer exists.** It is kept rather than deleted
because the compromise it prescribes — pick the under-speech target and accept a quiet
lead-in — is still the right advice when you choose not to duck, and because the next
person to read `knobs.audio.levels` will reach for it.

`knobs.audio.levels` asks for two different bed levels — typically −36 dB under
speech and −30 dB in gaps — and the 6 dB lift is what makes tuned silence feel
deliberate rather than empty.

A **generated** bed achieves that because `make-music.mjs` consumes
`vo-envelope.json` and bakes sidechain ducking in. A file bed played through
`remux-music.mjs` used to have no sidechain path, so it played flat and one gain had to
serve both targets.

**`remux-music.mjs` now builds that sidechain** — the thing the last paragraph of this entry
asked for. `--duck-db <dB>` sets how far the bed drops under narration and
`--duck-envelope <file>` supplies the `vo-envelope.json` it is solved against; it is
REQUIRED with `--duck-db`, because the threshold comes from the measured narration rather
than a guess. `--duck-ratio` tunes the knee. Without `--duck-db` the graph is byte-for-byte
what it always was, and the other ducking options are refused without it — so the old
behaviour is still the default and nothing moves under a project that does not ask.

A bed `make-music` already ducked carries that duck in its samples and is checked against
the narration in play through the record written beside it (`<bed>.duck.json`); passing
`--duck-db` at a bed that record says is already ducked is refused rather than ducked twice.

If you do NOT duck, the original compromise stands: pick the under-speech target — an
intrusive bed is worse than a quiet gap — and expect the lead-in to read quiet, because the
same flat gain applies there and most tracks open softly.

---

## Timing

### 5. TTS tail silence cannot be derived from word-boundary metadata

**Symptom.** Every gap lands short by a consistent amount — ~0.32 s in the
reference case — despite the solver reporting correct values.

**Cause.** Scaling word-boundary timings by `duration / lastWordEnd` pins the final
word to the end of the clip **by construction**, so computed tail is always zero.
The method structurally cannot see trailing silence. Real measured tails were
**276–312 ms**; heads ~130 ms.

**Fix.** Decode the rendered audio and measure head/tail directly. Never derive
them from synthesis metadata.

**Detect.** Decode the concatenated output and measure silence between speech
runs. Compare against target.

---

### 6. Perceived gap ≠ inserted silence

**Symptom.** "Two second gaps" sound like three.

**Cause.** What a viewer hears is:

```
perceived gap = tail(clip N) + inserted silence + head(clip N+1)
```

Inserting a 2 s file between two clips that each carry ~300 ms of their own
silence yields a ~2.6 s perceived gap.

**Fix.** Solve for **perceived** gap. Insert
`target − tail(N) − head(N+1)`. In the reference implementation a 1.5 s perceived
gap corresponds to a ~1.08 s inserted file.

**Detect.** Measure gaps on the finished mix, not on the inserted assets.

---

### 13. The reference `voice.mjs` still derives tails from metadata — and three videos shipped with it

**Symptom.** Every perceived gap lands **~340 ms long**. The solve reports
`perceived ~1500ms` for each gap and the arithmetic in the log is internally
consistent, so nothing looks wrong at any point in the run.

**Cause.** Entry 5 says never derive head/tail from synthesis metadata. The
reference implementation (`tools/SizzleCraft/src/voice.mjs`) **still does**:

```js
const tailMs = Math.max(0, durationMs - Math.round(words.at(-1).localEndMs * scale));
```

Because `scale = durationMs / lastWordEnd` pins the last word to the end of the
clip by construction, `tailMs` is **structurally always 0**. Measured on 8 clips
of `en-US-AndrewNeural` at `rate=+20%`: tail reported `0 ms` every time. The
solver therefore under-subtracts and **over-inserts** by the size of the real
tail.

Decoding with `silence-scan.mjs` puts the real tail at **~335 ms**, consistent
with the 276–312 ms entry 5 already recorded.

> **Direction note.** Entry 5 describes the symptom as gaps landing *short*. The
> mechanism as implemented here makes them land *long* — a zero tail means the
> solver inserts `target − head` instead of `target − tail − head`, so the
> surplus is the tail. Expect **long** when auditing a gap solve built this way.

**Fix.** Not applied, deliberately — see below. The code fix is to decode each
clip and measure the tail, rather than computing it from word boundaries.

**Detect.** Only by decoding. `silence-scan.mjs voiceover.mp3` and compare the
runs between speech against `intake.perceivedGapMs`. No amount of reading the
solver's own log will reveal it; the log is self-consistent and wrong.

**The consequence that makes this more than a bug.** Three videos now exist, all
`en-US-AndrewNeural` at `+20%`, all solving for a 1,500 ms perceived gap, and all
inserting **1,416 ms**:

| Project | Inserted gaps | Decoded? |
|---|---|---|
| `interviewer-qna-dataprep` | `1416` × 11 | **never** |
| `interviewer-qna-delta` | `1416` × 8 | **never** |
| `eval-loop-demo` | `1416` × 7 | yes — 1.83 s measured |

All three therefore play at **~1.83 s perceived gaps**, and are **internally
consistent with each other**. The defect is uniform, not erratic.

So fixing `voice.mjs` is **a series-wide pacing decision, not a silent
correctness fix**: the first video rendered after the fix will pace differently
from every video before it, which is exactly the back-to-back mismatch
`SKILL.md` § *Series continuity* warns about. Make it deliberately, and re-render
the siblings if the series must stay consistent.

**Equally: do not "correct" a single project by lowering `perceivedGapMs` to
compensate.** That lands one video at a true 1.5 s while its siblings sit at
1.83 s, which is the same continuity break with none of the benefit.

---

## TTS

### 7. Re-synthesis appears safe — but do not depend on it being guaranteed

**Symptom.** Worry that regenerating cleaned-up TTS clips will shift the timeline.

**What was observed `[OBSERVED]`.** A full regeneration of unchanged text returned
**byte-identical durations to the millisecond** (`what` 19,944 ms, `pipeline`
27,864 ms, …). Empirically, the reference TTS is deterministic.

**What is NOT true.** Determinism is **not documented** by `msedge-tts` or by the
Edge Read Aloud backend — neither client library addresses it. It is an
unofficial API that has already changed once (see entry 11). An observed property
of one run is not a contract.

**Fix.** **Make the cache authoritative rather than asserting determinism.** Key
cached clips by a hash of `(text, voice, rate, pitch, volume)`; on a hit, reuse the
existing file and never re-synthesise. That is correct whether or not the service
is deterministic, and it survives the service changing.

**Still true regardless:** a change to text, voice, **or speed** invalidates every
downstream duration.

---

### 10. SSML break tags are not available — the silence solve is not a workaround

**Symptom.** A reasonable-looking idea: replace inserted silence assets with
`<break time="1500ms"/>` in SSML and skip the timing solve entirely.

**Cause.** `msedge-tts` supports **only** `speak`, `voice`, and `prosody`. The
backend rejects anything Edge itself would not emit — a single `<voice>` with a
single `<prosody>` inside. `<break>` is not available at any level.

**Fix.** Don't try. The available levers are `rate`, `pitch`, and `volume`.
**Inserted-silence gap solving is the correct architecture for this stack**, not a
crutch to be engineered away.

**Detect.** Not applicable — this is a "do not attempt" entry. Cited sources are in
`cost-techniques.md` §4.

---

### 11. The TTS backend is an unofficial, moving surface

**Symptom.** Synthesis that worked yesterday starts failing, or returns different
output.

**Cause.** Edge Read Aloud is not a supported public API. A December 2025 change
began requiring a user agent matching Microsoft Edge. Server-side Node is
unaffected *for now*.

**Fix.** Treat synthesis as a stage that can break independently of your code.
Cache by content hash (entry 7) so a backend change does not invalidate finished
work, and pin the client library version.

**Detect.** If durations shift on unchanged text, suspect the backend before
suspecting the solve.

---

## Assembly

### 12. Do not concatenate audio per-segment (pre-emptive)

**Symptom.** Audio drifts progressively out of sync across a video assembled from
separately-rendered segments. Worse the further in you go.

**Cause.** AAC encoder delay/priming accumulates per segment. Concatenating
per-segment audio stacks that padding.

This has **not** been hit in this project — because the current pipeline keeps
narration as one continuous track. It is recorded pre-emptively because it is the
first thing that would break any attempt at segment-level video rendering. Revideo
documents hitting it in production (`cost-techniques.md` §2).

**Fix.** Keep video **muted** through segment assembly, concatenate the **full
audio** as one continuous stream, and mux audio to video **last**.

**Detect.** Check A/V sync at the *end* of a concatenated output, not the start —
drift accumulates.

---

## Tooling hygiene

### 8. Hard-referenced optional config keys

**Symptom.** Removing an override crashes the build script.

**Cause.** The script referenced `perceivedGapOverrides.<key>` directly. Deleting
the override left the reference dangling.

**Fix.** Treat every override map as optional. Fall back to the uniform value and
say which path was taken in the log output.

**Detect.** Exercise the empty-override case whenever an override is introduced.

---

### 9. Measure the output, not the input

The meta-lesson behind entries 1–6: in every case the *intent* was correct and the
*artifact* was wrong, and nothing surfaced the difference until it was decoded and
measured.

**Rule.** Before reporting a result, decode the finished artifact and measure the
property you claimed to change. Report the measured number.

Cheap checks worth running every time:

| Property | Check |
|---|---|
| Duration | Total, and per-segment |
| Frame count | Against the dry encode |
| Integrated loudness / true peak | Whole file, and narration alone |
| Gaps | Measured on the final mix |
| Video stream hash | Unchanged after an audio-only remux |

---

## Scene authoring

### 14. A trigger that resolves to nothing renders a blank segment, silently

**Symptom.** A segment renders as its title and subtitle over an empty stage.
Every card, node and edge is missing. Nothing errors, the capture succeeds, the
encode succeeds, and the storyboard preview looks perfect — because the
storyboard draws from the same data without going through the trigger layer.

**Cause.** Three independent versions of the same mistake, all in the scene data
rather than the engine:

1. **Unqualified trigger targets.** The builder emits **segment-qualified** DOM
   ids — `scenario-item-0`, `twotier-node-lane_ui`, `loop-edge-3`. A trigger
   targeting a bare `item-0` or `lane_ui` calls `getElementById` on an id that
   does not exist, gets `null`, and returns without revealing anything. Elements
   start hidden, so the segment stays empty.
2. **Edges with no draw trigger.** `revealNode` does not draw edges. An edge needs
   its own `drawEdge` — or a `flowEdge`, which draws it as a side effect. A
   diagram of disconnected boxes is easy to miss in review.
3. **Triggers scheduled past the segment's end.** Segment-relative `atMs` is
   compared against the *measured* window. The reference `voice.mjs` reflows
   segment windows onto real audio but **leaves trigger times untouched**, so
   anything authored against a pre-synthesis estimate drifts — and a segment that
   came in shorter than estimated silently drops its last reveals.

**Fix — NOW IMPLEMENTED as `validate-scene.mjs`.** This paragraph asked for a check; the
check exists, and it runs before capture for milliseconds against a stage that costs tens of
minutes. Run it:

```
node tools/SizzleCraft/src/validate-scene.mjs --project <dir>
```

It refuses the three failures above, with the coverage stated rather than implied: every
authored trigger target must be an id the builder emits (A1); every node and edge a diagram
segment declares, and the first six items a narrative one declares, must be revealed by
something (A3); an edge must be drawn only after both its endpoints exist (A4); and no
`atMs` may fall at or past its segment's measured end (A5). Plus diagram geometry and a
no-go content scan. Exit 2 is a timeline it will not read; exit 1 is a scene that failed a
check.

**A1 is weaker on footage segments, and says so.** Whether the builder emits the footage ids
or falls back to synthetic content depends on clip approval this stage does not read, so A1
checks the **union** of both id sets. A target in neither is wrong under every outcome and is
refused; a target in one establishes only that it *could* resolve, not that it resolves in
the branch actually rendered. A3 and A4 skip those segments entirely for the same reason, and
the run reports them as NOT evaluated rather than passing them.

**Read A3's bounds before relying on it.** It skips a segment whose reveals the builder
derives — one with no authored trigger carrying a target — because `write-build-html`
generates a complete sequence for those, and flagging them would fail every correct
auto-driven project. It skips footage segments, whose emitted ids depend on clip approval
this stage cannot read. It checks only the **first six** narrative items, because that is
all `write-build-html` emits — a seventh is never rendered, so it is never checked. And it
requires an edge to be targeted by `drawEdge` specifically: `flowEdge` does reveal an edge
in the runtime, but an edge that only ever flows was never drawn, which is the defect this
entry is about. So A3 covers diagram nodes and edges, and
narrative items, on author-driven non-footage segments.

Two things it deliberately does NOT do, so this entry is not read as covering them.
`validate-scene` compares no frames, so "no two segments render identically" is a post-S6
check and lives in `qc/`. And it does not reflow: **reflowing trigger times alongside segment
windows still belongs in the synthesis stage**, and `voice.mjs` still does not do it — see
entry 13. The check catches the class; reflow would remove one of its causes.

**Detect — the capture dedup ratio is the cheap canary.** Frame capture reports
how many frames it deduplicated. Measured on one 4-minute project:

| State | Unique frames | Dedup |
|---|---|---|
| Every trigger broken — nothing animates | 159 / 3,760 | **96%** |
| Triggers fixed — content animates | 3,685 / 3,760 | **2%** |

A dedup ratio far higher than the scene's static-ness would suggest means nothing
is moving. **Check it before spending an encode**, and before believing a fast
capture was good luck.

---

## Adding to this ledger
When a bug costs more than one render cycle to find, add it. Keep the
**Symptom → Cause → Fix → Detect** shape — the symptom is what a future session
will recognise, and the detection method is what makes it cheap next time.
