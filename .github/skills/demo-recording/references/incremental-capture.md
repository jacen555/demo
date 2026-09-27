# Segment-level incremental capture — design note

**Status: proposed, not built.** No measurement here is from a working implementation;
the cost figures are from full renders and are used to bound the *available* saving, not
to claim a realised one.

This is the change `SKILL.md` already points at when it says several of its rules exist to
work around *"the all-or-nothing capture, the absence of segment-level re-rendering"*, and
it is what the skill's re-check trigger means by *"has the pipeline gained partial/segment
rendering or caching?"*

---

## 1. Why it is closer than it looks

Three of the four pieces already exist and are verified:

| Piece | State |
|---|---|
| Concat demuxer | documented `[VERIFIED]` in `cost-techniques.md` §2 |
| Capturing a contiguous **sub-range** of frames | already what `frame-capture.mjs` does — it splits the timeline into one contiguous slice per worker and runs them in parallel |
| Reusing frames across runs | `--resume` already does this |

**The blocker is one line's granularity**, in `frame-capture.mjs:175`:

```js
const htmlHash = crypto.createHash('sha256').update(fs.readFileSync(htmlPath)).digest('hex');
```

A SHA-256 of the **whole** `video-auto.html`. A one-word edit in segment 8 therefore
invalidates segment 1's frames, and `--resume` correctly refuses to reuse anything.

**The determinism guarantee is right and must not be weakened.** Resume already closes the
"reuse a frame produced by a different input" hole, and that is worth more than the saving.
What is wrong is only the *resolution* at which the question is asked.

---

## 2. Design

### Hash per segment, plus a shared-globals hash

Store in `frames/.capture-meta.json` alongside the existing frame parameters:

```jsonc
{
  "fps": 30, "width": 3840, "height": 2160,
  "frameFormat": "jpeg", "jpegQuality": 88,
  "globalsHash": "…",
  "segments": {
    "hard":     { "hash": "…", "startFrame": 0,    "frameCount": 775 },
    "scenario": { "hash": "…", "startFrame": 775,  "frameCount": 1553 }
  },
  "v": 2
}
```

- A **segment hash** covers that segment's own scene data: `visual`, `triggers`, window
  timings, audio duration, narration text.
- A **globals hash** covers everything that can change a pixel *outside* one segment:
  theme, brand tokens, fonts, the generated CSS, stage dimensions, fps, frame format,
  engagement level, end-card state.

> **If the globals hash changes, everything is dirty. Do not optimise this away.** It is
> the rule that keeps the cache honest, and the temptation to special-case it is exactly
> how a stale frame ships.

### What gets re-captured

A segment is dirty when **its hash changed**, or when **its frame range moved** (see §4).
Everything else is reused.

### Report the reuse

```
reusing 5 of 8 segments (4,112 frames) · capturing 3 (2,214 frames)
  dirty: scenario (content), loop (content), twotier (range moved)
```

A cache that is silent about what it skipped is indistinguishable from one that is wrong.
**Naming the reason per segment** is what makes a mis-reuse findable — "range moved" and
"content changed" are different bugs when one turns out to be spurious.

### Escape hatches

`--force-segment <id>` and `--force-all`, so defeating the cache never requires
hand-deleting frames. A cache people work around by `rm -rf` is a cache whose behaviour
nobody can reason about.

---

## 3. What it does NOT do

**Do not render per-segment MP4s and concatenate them.** See `cost-techniques.md` §2 —
audio must not be concatenated per-segment, and the correct architecture is *cache frames,
encode whole*. S7, S8 and S9 are unchanged by this design.

---

## 4. ⚠️ The subtle failure: a narration edit moves every later segment

This is the part to design carefully, because getting it wrong produces a **silently
misaligned video** rather than an obviously broken one.

Changing narration in segment 2 reflows the timeline, so segments 3–8 keep identical
*content* but occupy different *absolute frame numbers*. A cache keyed on content alone
would happily reuse segment 8's frames at the wrong timestamps.

Two ways to handle it, and the second is better:

1. **Include `startFrame` in the cache key.** Correct, but a pure timeline shift then
   invalidates every later segment — which is precisely the common case this feature
   exists to make cheap.
2. **Store frames keyed by segment-relative index** (`frames/<segid>/0001.jpg`) and
   renumber into a flat sequence at assembly. A pure shift becomes **free**: the frames
   are still valid, only their position changed.

Option 2 also makes the reuse report truthful — "reused, renumbered" is a different and
more reassuring statement than "re-captured because it moved".

Whichever is chosen, **assembly must verify the final sequence is complete and contiguous
before encoding**: every index present, no gaps, count equal to the expected total. That
check is cheap and it is the one that catches a renumbering bug before it becomes a shipped
video with a two-second jump in it.

---

## 5. Honest scoping — when it does not help

- **Global visual changes defeat it entirely, by design.** Review round 6 changed the
  arrowhead default, node spacing and the emphasis treatment — all shared styling, so every
  segment was legitimately dirty. **Per-segment caching would have saved nothing that
  round**, and a design note that implied otherwise would be overselling it.
- **It pays on content edits**, which is the more common late-stage shape. That same round
  changed narration in only 2 of 8 segments; under a working cache with option 2 above,
  that is ~2/8 of a capture instead of 8/8.
- Ceiling on the saving: capture was **84%** of a 1080p/PNG render and **47%** of a
  4K/JPEG one. Encode is untouched, so the realistic best case on a content-only edit at
  4K is roughly a third off the wall clock, not an order of magnitude.
