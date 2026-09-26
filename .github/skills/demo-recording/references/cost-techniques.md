# Cost Techniques

Concrete techniques for cutting token and wall-clock cost, beyond the routing and
batching rules in `SKILL.md`. Read this when you want to make an expensive stage
cheaper, or need a cheap way to answer "did anything actually change?".

**Confidence markers** on every claim:
`[VERIFIED]` read from primary documentation · `[OBSERVED]` measured in this
project's own history · `[INFERRED]` reasoned, not cited · `[UNVERIFIED]` widely
repeated but not confirmed — **do not rely on these**.

## Contents

1. [Cheap verification — answer questions without decoding](#1-cheap-verification)
2. [Partial and segment-level rendering](#2-partial-and-segment-level-rendering)
3. [Draft vs production render settings](#3-draft-vs-production-render-settings)
4. [TTS — what works and what does not](#4-tts)
5. [Deterministic capture](#5-deterministic-capture)
6. [Caching discipline](#6-caching-discipline)
7. [Volatile — re-check these](#7-volatile--re-check-these)
8. [Explicitly unverified — do not use](#8-explicitly-unverified--do-not-use)

---

## 1. Cheap verification

Answer questions about an artifact without decoding it or reading it into context.

### `ffprobe` single-value probes `[VERIFIED]`

Return one number, not a JSON blob:

```bash
ffprobe -v error -show_entries format=duration -of csv=p=0 out.mp4
ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames -of csv=p=0 out.mp4
```

Useful flags: `-show_entries section=field` narrows output precisely, `-of json`
for structured output, `-select_streams v:0` for one stream, `-read_intervals` to
avoid a full-file scan, `-show_data_hash` for a payload hash.
<https://ffmpeg.org/ffprobe.html>

### Null muxer as a pre-encode gate `[VERIFIED]`

```powershell
ffmpeg -v error -i input -f null NUL     # Windows — POSIX uses -f null -
```

> *"The null muxer does not generate any output file… there is no muxing overhead."*
<https://trac.ffmpeg.org/wiki/Null>

With `-v error`, **a clean run emits nothing** — zero tokens. Use it to confirm a
file decodes before spending a full render, and with `-benchmark` to measure
encode speed without writing to disk.

### `framemd5` — the "did the pixels change?" oracle `[VERIFIED]`

The highest-value technique in this file.

```bash
ffmpeg -i segment.mp4 -f framemd5 segment.framemd5
```

Emits one checksum **per frame** with timestamps and sizes. Two modes matter:

- **default** — checksums *decoded* data. Detects real visual change.
- **with `-c copy`** — checksums *stored* data. Detects bitstream change.

Why it beats a whole-file hash, verbatim:

> *"It is still possible for a file to be changed in a way that would result in a
> mismatch for a future whole-file checksum analysis, but not create any difference
> between a stored framemd5 output… This could occur when embedded metadata is
> edited but the stored audiovisual data remains the same."*

<https://trac.ffmpeg.org/wiki/framemd5%20Intro%20and%20HowTo>

**Application `[INFERRED]`:** store a framemd5 per built segment. After a change,
rebuild and framemd5 only the plausibly-affected segments; where the hash matches,
**skip the encode and reuse the existing bytes**. It also lets you report
"segments 3 and 7 changed" in a handful of tokens instead of describing a diff.

---

## 2. Partial and segment-level rendering

This is how the expensive path stops being all-or-nothing. It is **not yet
implemented** in the reference pipeline — treat this section as the design to build
toward, and validate before relying on it.

### Concat demuxer `[VERIFIED]`

```bash
ffmpeg -f concat -safe 0 -i list.txt -c copy output.mp4
```

> *"All files must have the same streams (same codecs, same time base, etc.)"*
<https://trac.ffmpeg.org/wiki/Concatenate>

Two non-obvious requirements:

- **Normalise timestamps when cutting** `[VERIFIED]` — `-avoid_negative_ts 2`
  (`make_zero`) is documented as required when the output is intended for the
  concat demuxer. <https://trac.ffmpeg.org/wiki/Seeking>
- **Match encoder profiles** `[VERIFIED]` — a `-profile:v` mismatch breaks concat.
  <https://trac.ffmpeg.org/wiki/Encode/H.264>

### 🔴 Audio must not be concatenated per-segment `[VERIFIED]`

The constraint that makes naive segment-level rendering fail. From Revideo, which
hit it in production:

> *"Since **merging partial videos gives you audio issues (audio becomes laggy)**,
> this function returns the path to the audio file and mute video file… you should
> **first concatenate all of the partial audio files and then concatenate all of the
> partial mute video files, and then merge the full audio and video**."*

<https://github.com/midrender/revideo> — `renderPartialVideo.mdx`

**Why `[INFERRED]`:** AAC encoder delay/priming accumulates per segment, so audio
drifts progressively.

**This validates the existing architecture.** Keeping video muted and the narration
as one continuous track — which is what makes the ~4-minute audio-only remux safe —
is exactly the prescribed shape. Do not break it in pursuit of segment-level video
rendering.

### `-ss` placement `[VERIFIED]`

| Placement | Behaviour |
|---|---|
| **before** `-i` | Seeks by keyframe — **fast** |
| **after** `-i` | Decodes and discards to the position — **slow** |

> *"As of FFmpeg 2.1, when transcoding (i.e. not stream copying), `-ss` is also
> frame-accurate even as input option."*

So when re-encoding, put `-ss` before `-i` unconditionally — the old
fast-but-inaccurate tradeoff no longer applies.

**Caveat for stream copy `[VERIFIED]`:** with `-c copy`, ffmpeg can only split on
an I-frame, so the cut lands at the nearest keyframe and may carry audio without
video at the start. <https://trac.ffmpeg.org/wiki/Seeking>

---

## 3. Draft vs production render settings

### Split the config `[VERIFIED as a pattern]`

Motion Canvas makes this first-class:

> *"Both Scale and Frame rate can be configured **separately for the preview and
> the rendering**."*
<https://motioncanvas.io/docs/rendering/>

**Carry `preview.scale` / `preview.fps` alongside `render.*` in `knobs.json`**, so
draft settings are declared rather than invented per session.

### Frame format is the biggest lever at 4K — not resolution `[MEASURED]`

**Superseded 2026-09-25.** This section previously said *"resolution scale is the
biggest lever"*, citing Revideo's `slow-rendering.mdx`:

> *"setting the scale to 0.5 made our renders twice as fast as with the default of 1.0."*

That citation is real and the conclusion drawn from it was wrong twice over. The
first end-to-end run of this engine by a second project measured both claims:

| Previous claim | Measured |
|---|---|
| Halving resolution roughly halves render time | **~8×** — 5.5 min against 42.4 min, S5–S7 at half scale and half fps |
| Resolution scale is the biggest single lever | At 4K, **frame format is bigger** — JPEG q88 against PNG is **13×** (13.05 fps vs 1.00 fps; 2,183 → 170 KB/frame) |
| Capture is ~84% of a render | True at **1080p with PNG only.** With JPEG, 4K capture projects to ~9.6 min and **encode becomes the long pole** |

The practical consequence inverts the old advice: **4K JPEG capture (~9.6 min) is
cheaper than the 1080p PNG render this skill was written against (35.4 min).**
Reach for the frame format before reaching for resolution.

**These numbers are a machine profile, not a constant.** All of the above were
measured on an **Azure VM — Xeon Platinum 8370C, 8 physical / 16 logical cores,
64 GB RAM, no GPU passthrough.** On a workstation with a real GPU, `h264_nvenc`
would likely be the largest S7 win and the encode advice inverts again.

**So probe the machine rather than quoting this table.**
`tools/SizzleCraft/src/probe-render-capability.mjs` **runtime-tests each encoder**
rather than reading `ffmpeg -encoders` — that list advertises everything compiled
into the binary regardless of hardware, and the VM above cheerfully lists NVENC,
QSV *and* AMF while all three fail. Record the result in the project's
`render-log.md`, not here.

### Dedup measures holds, not byte-identity `[MEASURED]`

A first attempt to measure frame dedup compared consecutive frame **lengths** and
reported 74% deduped. That is wrong: a deterministic renderer produces
byte-identical output at full cost, so identical bytes prove nothing about whether
a frame was written once.

`fsutil hardlink list` is the real measurement — it showed one frame with **58
paths** beside byte-identical frames carrying **1 each**. True figures: lead-in
57% held, **body 0%**.

**Dedup cannot rescue an animated render.** It is also a useful canary in the
other direction: a suspiciously *high* ratio on content that should be moving
means nothing is animating.

### Bounded probes are representative, not just the opening `[MEASURED]`

`frame-capture.mjs` splits the timeline into **one contiguous slice per worker**,
run in parallel — so a timed bounded probe samples across the whole video rather
than only its first seconds. That promotes bounded probing from a guess to a
defensible technique, and is worth knowing before anyone discards a probe result
as unrepresentative.

### Raising the worker cap does not help `[MEASURED]`

`frame-capture.mjs` caps at **6 workers above 1080p** versus `cores - 1` below it,
and on a 16-core box with 64 GB that looks obviously over-conservative. It was
measured, and it is not:

| Workers | Rate |
|---|---|
| 6 | 9.77 fps |
| 10 | 9.87 fps |
| 14 | 9.53 fps |

**Flat.** Something saturates before the core count does — most likely SwiftShader,
the software rasteriser. Peak RAM was 2.2–2.3 GB against 64 GB, so memory was never
the constraint either.

Leave the cap alone. This is recorded because "16 cores, why only 6 workers" is an
obvious question that will be asked again, and the answer is that someone checked.

*(Process-count confirmation is inconclusive — Chromium shares renderer processes —
so the mechanism is inferred while the rate is measured.)*

### Proposed but unmeasured — do not quote alongside the above

- **A RAM disk for the frame store**, now viable *because* of the JPEG finding: PNG
  frames were 14.5 GB, JPEG at 4K is **~1.25 GB** for a whole video. Would take
  disk I/O out of capture and encode. Only helps with headroom; never a default.
- **x264 preset and thread count.** With no hardware encode available, S7 is
  CPU-bound and these are the only remaining encode levers. Untested on this
  pipeline.

### Encode settings `[VERIFIED]`

- CRF 0–51, default 23, sane range 17–28; 17–18 ≈ visually lossless.
- **"+6 CRF ≈ half the bitrate."**
- Presets fastest→slowest: `ultrafast … veryslow`. (`placebo` — *"ignore it as it
  is not useful."*)
- **Two-pass only when targeting a specific file size.** Otherwise CRF. Two-pass
  doubles encode time.
- `-tune stillimage` is documented as *"good for slideshow-like content"*
  `[VERIFIED]`; plausibly a win for mostly-static demo content, but **no benchmark
  found** `[INFERRED]`.

<https://trac.ffmpeg.org/wiki/Encode/H.264>

**Draft recipe `[INFERRED]`:** `-preset ultrafast -crf 28` at `preview.scale` for
anything shown at the approval gate. Production settings only after approval.

### Hardware encoding, with a trap `[VERIFIED]`

> *"The `crf` option is **not compatible** with hardware-accelerated encoders.
> Instead, use the `--video-bitrate` flag."* … *"the file size is significantly
> larger by default… `--video-bitrate=8M` achieves a similar file size than
> software encoding for H.264 Full HD."*

<https://www.remotion.dev/docs/hardware-acceleration>

---

## 4. TTS

### ❗ SSML break tags do NOT work on this stack `[VERIFIED]`

A tempting idea that will fail. `msedge-tts` supports **only** `speak`, `voice`,
and `prosody`:

> *"Only supports `speak`, `voice`, and `prosody` element types."*
<https://github.com/Migushthe2nd/MsEdgeTTS>

The Python client for the same backend explains why:

> *"Microsoft prevents the use of any SSML that could not be generated by Microsoft
> Edge itself… the service only permits a single `<voice>` tag with a single
> `<prosody>` tag inside it."*
<https://github.com/rany2/edge-tts>

**Consequence:** `<break time="500ms"/>` is unavailable. The available levers are
`rate`, `pitch`, `volume` — nothing else.

**This means the inserted-silence timing solve is the correct architecture, not a
workaround.** Do not try to replace it with SSML.

### ⭐ Boundary metadata gives structured timings for free `[VERIFIED]`

```js
await tts.setMetadata(voice, format, {
  wordBoundaryEnabled: true,
  sentenceBoundaryEnabled: true,
});
const { metadataStream } = await tts.toStream(text);
```

Returns `Offset` and `Duration` per word/sentence in **100-nanosecond ticks**
(`35875000` = 3.5875 s) `[INFERRED from the documented example — the unit is not
stated]`.

Use it for per-segment speech extent and for caption sync, without a decode pass.

> ⚠️ **It still does not give you tail silence.** Boundary metadata ends at the
> last word, so trailing silence remains invisible to it — see bug ledger entry 5,
> which cost a 0.32 s error on every gap. Use boundary metadata for *speech*
> timings; keep **decoding** for head/tail silence.

### Cache by content hash `[INFERRED — no citation found]`

Neither client caches; both are stateless. Hash
`(text, voice, rate, pitch, volume)` → filename and reuse on hit.

**The key must include the prosody knobs**, not just the text. See §6.

---

## 5. Deterministic capture

Determinism is what makes frame dedup and framemd5 comparison meaningful across
runs. Without it, every cached hash is invalid.

### Playwright `page.clock` `[VERIFIED]`

The reference pipeline already uses Playwright, so this is directly available. It
overrides `Date`, `setTimeout`, `setInterval`, **`requestAnimationFrame`**,
`requestIdleCallback`, **`performance`**, and `Event.timeStamp`.

```js
await page.clock.install();       // MUST come first — see below
await page.clock.pauseAt(start);
await page.clock.runFor(1000 / fps);   // advance exactly one frame
```

> ⚠️ **Ordering constraint, verbatim:** *"If you call `install` at any point in your
> test, the call MUST occur before any other clock related calls… Calling these
> methods out of order will result in undefined behavior."*

<https://playwright.dev/docs/clock>

`pauseAt` + `runFor(1000/fps)` per frame is a clean deterministic capture loop
`[INFERRED]`.

### Browser choice affects determinism `[VERIFIED]`

> *"When using a full Chrome binary through `browserExecutable`, rendering behavior
> may differ between Chrome versions and **may be less deterministic than Chrome
> Headless Shell**."*

Also: Chrome Headless Shell is *"faster for CPU-bound video rendering"*; Chrome for
Testing is *"faster for GPU-bound"*.
<https://www.remotion.dev/docs/miscellaneous/chrome-headless-shell>

**Pin the browser version.** An unpinned Chrome silently invalidates every cached
frame hash `[INFERRED]`.

### Image format `[VERIFIED]`

`jpeg` is the fastest and the default; `png` only when transparency is needed;
**`none` when rendering audio only** — the API-level equivalent of the cheap
audio-only path. <https://www.remotion.dev/docs/renderer/render-media>

---

## 6. Caching discipline

Manim is the only tool surveyed that solves "re-render only what changed"
automatically. Its design is worth copying `[VERIFIED from source —
`ManimCommunity/manim:manim/utils/caching.py`]`:

1. **Put the encoder in the cache key.** Manim passes
   `encoder_fingerprint=video_encoder_fingerprint(...)` into the hash, so changing
   ffmpeg settings invalidates cached segments. Omitting this is the classic
   hand-rolled-cache bug: stale segments encoded with old settings.
2. **Deterministic fallback names.** With caching disabled, segments are named
   `uncached_00001` — stable and inferable, so paths never need a directory listing.
3. **LRU eviction by *access* time** (`st_atime`, not `st_mtime`), with `-1` as an
   explicit unlimited sentinel — so reused segments survive pruning.
4. **A skipped segment gets a `None` hash** and is excluded from concatenation — a
   clean "contributes nothing" signal.

**Cache key should include, at minimum:** source text/scene, voice and prosody
knobs, timing values, encoder settings, and the browser version.

### Sentinel files beat re-inspection `[VERIFIED]`

> *"Remotion writes a `VERSION` file to the download folder… If the `VERSION` file
> is missing or does not match the expected version, Remotion will delete the
> existing browser and download the correct version."*
<https://www.remotion.dev/docs/miscellaneous/chrome-headless-shell>

A small file recording "what state this directory is in" is cheaper to read than
re-deriving that state — the same principle as `render-log.md`.

---

## 7. Volatile — re-check these

Everything in this section was accurate when written (2026-09-15) and sits on
fast-moving or unofficial surfaces. **Re-verify before relying on any of it.**

| Item | Why it may change |
|---|---|
| **`msedge-tts` Edge user-agent requirement** | Dec 2025 change: Read Aloud API now requires an Edge-matching UA. Server-side Node is unaffected **for now**, but this is an unofficial API that has already changed once. |
| **Chrome `--headless=old`** | Split from `--headless=new` in Chrome 123; `old` is *"ideal for screenshotting"* but **will stop working in a future Chrome version**. If the capture harness passes it, it is on a deprecation path. |
| **Revideo docs location** | Project moved: `docs.re.video` now redirects and returns empty; repo is `midrender/revideo` (was `redotvideo/revideo`). Cite the repo, not the docs site. |
| **Remotion `frameRange` multi-range** | Added in 4.0.502; `[number, null]` in 4.0.421; `gopSize` 4.0.466; NVENC 4.0.484. Version-gate any use. |
| **TTS determinism** | **Measured stable 2026-09-25** — three runs of the same script produced identical durations every time. Still undocumented by both client libraries, so this is observed behaviour on one engine version, not a guarantee. Keep the cache authoritative (bug ledger entry 7); treat this as "the cache is not papering over drift", not as licence to skip it. |

---

## 8. Explicitly unverified — do not use

Researched and **could not confirm from primary sources.** Listed so nobody spends
time rediscovering that they are unreliable.

| Claim | Status |
|---|---|
| CDP `Emulation.setVirtualTimePolicy` + `HeadlessExperimental.beginFrame` for virtual time | CDP reference returned a redirect stub. `HeadlessExperimental` is experimental and likely reduced in current Chrome. **Use Playwright `page.clock` (§5) instead.** |
| `-force_key_frames` exact syntax for segment-boundary alignment | Widely cited, not confirmed. `-x264-params keyint=N:min-keyint=N` **is** verified. |
| Variable frame rate as a capture optimisation | No supporting documentation, and it would likely break the concat demuxer's "same time base" requirement (§2). **Recommend against.** |
| Remotion webpack/bundle cache, `--bundle-cache` | Only seen in AI-summarised output. |
| Headless screenshot throughput figures | No authoritative benchmark found. |
| "Capture only changed regions" as a browser technique | No source. Frame dedup appears to be the practical equivalent. |
