# Bug Ledger

Failures that were expensive to find and are cheap to avoid. **Read this before any
audio mix, remux, or timing solve.**

Every entry here was discovered by measuring a finished artifact and finding it
disagreed with the intent. None of them announce themselves — that is what makes
them worth recording.

Format: **Symptom → Cause → Fix**, with the measurement that exposes it.

**Numbers are stable identifiers, not an ordering** — other files cite them
(`knobs.json`, `cost-techniques.md`). Never renumber an existing entry; append.

## Contents

**Audio mixing**
1. [`alimiter` silently gain-rides the whole mix](#1-alimiter-silently-gain-rides-the-whole-mix)
2. [`-shortest` truncates the end card](#2--shortest-truncates-the-end-card)
3. [Mono→stereo upmix costs 3 dB](#3-monostereo-upmix-costs-3-db)
4. [Fade-in longer than the lead-in](#4-fade-in-longer-than-the-lead-in)

**Timing**
5. [TTS tail silence cannot be derived from word-boundary metadata](#5-tts-tail-silence-cannot-be-derived-from-word-boundary-metadata)
6. [Perceived gap ≠ inserted silence](#6-perceived-gap--inserted-silence)

**TTS**
7. [Re-synthesis appears safe — but is not guaranteed](#7-re-synthesis-appears-safe--but-do-not-depend-on-it-being-guaranteed)
10. [SSML break tags are not available](#10-ssml-break-tags-are-not-available--the-silence-solve-is-not-a-workaround)
11. [The TTS backend is an unofficial, moving surface](#11-the-tts-backend-is-an-unofficial-moving-surface)

**Assembly**
12. [Do not concatenate audio per-segment](#12-do-not-concatenate-audio-per-segment-pre-emptive)

**Tooling hygiene**
8. [Hard-referenced optional config keys](#8-hard-referenced-optional-config-keys)
9. [Measure the output, not the input](#9-measure-the-output-not-the-input)

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

## Adding to this ledger

When a bug costs more than one render cycle to find, add it. Keep the
**Symptom → Cause → Fix → Detect** shape — the symptom is what a future session
will recognise, and the detection method is what makes it cheap next time.
