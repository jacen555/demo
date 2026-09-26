# Footage and B-roll

Stock video and other interspliced footage: what the pipeline already supports, what it
does not, what it costs, and when it helps rather than hurts.

Licensing machinery is shared with music — see the music notes in
[`bug-ledger.md` entry 15](bug-ledger.md) and the `audio.music` block in
`templates/knobs.json`. **Treat a clip exactly like a track.**

## Contents

1. [It is already half-built](#1-it-is-already-half-built)
2. [Gap: footage is per-segment, B-roll wants cutaways](#2-gap-footage-is-per-segment-b-roll-wants-cutaways)
3. [Gap: footage pays full capture cost for pixels you already have](#3-gap-footage-pays-full-capture-cost-for-pixels-you-already-have)
4. [Licensing — reuse the music pattern exactly](#4-licensing--reuse-the-music-pattern-exactly)
5. [When B-roll helps, and when it hurts](#5-when-b-roll-helps-and-when-it-hurts)

---

## 1. It is already half-built

**Stock video is not a new capability — it is the existing `footage` mode with a
different source.** Most of the work is sourcing and licensing, not rendering.

What `write-build-html.mjs` already does:

- A clip is pre-extracted to JPEG frames under `evidence-pack/footage/<clipId>/`.
- It plays full-bleed, with the frame index chosen per capture frame by
  `window.__setFootageFrame`, so playback stays deterministic under frame-accurate capture.
- It is **gated**: `footageApproved` requires `approvedForUse === true` **and**
  `redaction === 'clear'` **and** `evidenceApprovedClip(id)`.
- Clip ids are path-escape protected, and every frame path is re-checked against the
  evidence root on the realpath — symlinks and junctions that escape are rejected.
- **It degrades to the authored diagram** when a clip is not approved.

That degradation is not theoretical: one project shipped a segment authored as `footage`
with no clip at all, and the stage-trace diagram underneath carried it. **Always author
the fallback**, then the clip is an upgrade rather than a dependency.

### ⚠️ Two producer stages are missing from the engine

`write-build-html.mjs` requires `manifest.json` to carry a
`stages['materialize-footage'].derivedFootage` record of kind `footage-frame-set-v1`,
with per-clip `frameSetSha` / `frameCount` / `fps` that must match a SHA-verified
projection of the actual frame files — or it throws
`footage lineage mismatch: approved clips require materialize-footage lineage`.

**Neither `materialize-footage.mjs` nor `clip-video.mjs` is in `tools/SizzleCraft/src/`.**
Until they are extracted, `footage` mode cannot be used by any project: registering a clip
by hand would mean forging the lineage hash, which is the exact thing that check exists to
prevent. This is the same class of gap as the unextracted `write-script.mjs` (S1) and
`grab-crops.mjs`.

---

## 2. Gap: footage is per-segment, B-roll wants cutaways

`mode(seg)` swaps the **whole segment's** visual. That is right for a segment that *is*
the footage. It is wrong for B-roll, which is typically a 2–4 second cutaway inside a
segment that then returns to the diagram.

This already had a structural cost: an approved screen capture could not live inside an
existing segment, forcing a **7 → 8 segment split** purely to carry it, which added a gap
and lengthened the video.

Proposed shape — same approval gate, same degradation:

```jsonc
"visual": {
  "mode": "diagram",
  "cutaways": [
    { "clipId": "…", "atMs": 4200, "durationMs": 2500 }
  ]
}
```

An unapproved cutaway is simply skipped and the diagram plays through, exactly as an
unapproved `footage` segment falls back today.

---

## 3. Gap: footage pays full capture cost for pixels you already have

Footage frames are **re-screenshotted through the browser** like any generated scene. So
content that is *already pixels* costs the same per frame as an animated diagram —
measured at 4K: **1.00 fps on PNG, 13.05 fps on JPEG q88**.

A footage span does not need S6 at all. Its frames could be scaled and concatenated at S7
directly from source. On a video with meaningful B-roll that is a large saving, and it
grows with resolution.

**Know this before planning a lot of B-roll on the assumption it is cheap. Today it is
not — it is the most expensive kind of frame you can add**, because:

- it cannot be skipped by capture, and
- **stock footage dedups at 0%.** It is full-motion by definition, so no frame ever
  matches its predecessor's signature. See the dedup findings in
  [`cost-techniques.md`](cost-techniques.md) §5 — animated content holds ~0% of frames,
  and footage is the purest case of that.

---

## 4. Licensing — reuse the music pattern exactly

`clips.json` is already an approval checkpoint. Extend each entry with the same fields a
music track carries:

```jsonc
{
  "id": "city-timelapse",
  "approvedForUse": true,
  "redaction": "clear",
  "licence": "Pexels License",
  "sourceUrl": "https://www.pexels.com/video/…",
  "attribution": null,
  "croppedWhatAndWhy": "address bar and account chrome removed — hostname is a no-go"
}
```

**Apply the invariant already established for music:**

> `attribution` non-null ⇒ `endCard.enabled` **must** be true.

The end card is usually the only credit surface a video has. A video with three attributed
clips and no end card is unshippable, and that must surface **at selection time, not at
publish**. Enforce it in the project's test suite, as the music invariant already is.

### ⚠️ Platform-bundled stock libraries — verify scope before relying on one

**ClipChamp's stock library is a must-verify, not an assumption.** Platform-bundled
libraries commonly licence assets for use *within that product*, which would not cover
exporting them into a different pipeline. That is the identical shape to the YouTube Audio
Library trap: a convenient library that turns out to be platform-scoped.

Check the actual terms before anyone builds a plan around it.

Pipeline-agnostic alternatives worth checking first, since they do not carry that
question at all:

| Source | Note |
|---|---|
| **Pexels** | Pexels License, no attribution required |
| **Pixabay** | Pixabay Content License — already used for this pipeline's music |
| **Mixkit** | Mixkit License, no attribution for most assets |
| **Coverr** | Coverr License, no attribution required |

Record the licence and URL at selection time. Reconstructing provenance for a clip already
cut into a render is painful and sometimes impossible.

---

## 5. When B-roll helps, and when it hurts

There is a real tension here and it should be written down rather than discovered.

`planning.md` §7 carries Mayer's **Coherence** principle — *cut anything not serving the
objective, including decorative visuals*. **Stock B-roll is the textbook decorative
visual**, and the evidence is that it can actively *hurt* comprehension when it competes
with dense explanation.

That does not make it a bad idea. It scopes it:

**Good — nothing technical is being explained:**
- Openings and closings
- Transitions between acts
- Emotional or contextual beats — "this is what a customer's Monday looks like"

**Bad — the viewer is decoding something:**
- Over a diagram build
- Over a field-by-field reveal
- Over any passage carrying figures

**Two hard constraints regardless:**

- **Never load-bearing.** Narration is this pipeline's only audio track (WCAG G226), so a
  cutaway may not be the sole carrier of any meaning. If the video still works with the
  clip replaced by its fallback diagram, the clip is safe to use.
- **Watch WCAG 2.3.1.** Rapid-cut stock montages are a common offender — no more than 3
  flashes or hard cuts in any one-second period.
