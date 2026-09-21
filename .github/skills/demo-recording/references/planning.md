# Planning

What to establish **before** writing a script or rendering anything. Read this when
authoring a new video, or when a request changes what the video is about.

Sources are marked `[VERIFIED]` (read from a primary source), `[OBSERVED]` (measured in
this project's history), `[INFERRED]`, or `[UNVERIFIED]`. Where established practice is
thin or absent, this file says so rather than implying a standard exists.

## Contents

1. [How to run intake](#1-how-to-run-intake)
2. [The checklist](#2-the-checklist)
3. [Accessibility is a planning constraint, not a post step](#3-accessibility-is-a-planning-constraint-not-a-post-step)
4. [Evidence and claims](#4-evidence-and-claims)
5. [Writing narration for the ear](#5-writing-narration-for-the-ear)
6. [Choosing a target length](#6-choosing-a-target-length)
7. [Principles worth knowing](#7-principles-worth-knowing)

---

## 1. How to run intake

**Do not interrogate the user with thirty questions.** Most of the checklist is
answerable from the request, the repo, or an earlier part in the series.

The discipline:

1. **Answer what you can yourself** from context. Say what you assumed.
2. **Ask only what is genuinely unresolved and would change the script, the storyboard,
   or the tests.** Maximum three at a time, each with a recommended default.
3. **Group C (Evidence) is the exception — never assume it.** A wrong number that reaches
   a render is the most expensive kind of mistake, because it is invisible until someone
   who knows the domain watches the finished video.
4. Record the answers in `knobs.json` so a later session does not re-ask.

---

## 2. The checklist

### A. Purpose and audience

- **What will the viewer be able to do afterwards?** State it with an action verb —
  *configure*, *explain*, *compare*, *decide*. Defining a learning objective before
  scripting is established instructional-design sequencing (ADDIE), not a nicety
  `[VERIFIED]`. It is also what disciplines the framing question in §B: "celebratory" is
  a tone, "the viewer will be able to explain why we chose X" is a target.
- **Who is watching, and what do they already know?** Determines how much the opening
  must establish.
- **Pre-training check** — does this video need to introduce key terms, names, or
  components *before* the walkthrough, or can it assume them? If an earlier part in the
  series already did that, this video can lean on it (Mayer's pre-training principle).
- **What should the viewer do next?** A call to action is near-universal in professional
  pre-production checklists `[VERIFIED]` and is easy to forget in an internal demo.

### B. Shape and framing

- **Target length.** See §6 — justify it by content complexity and genre, and do **not**
  cite the "six-minute rule."
- **Segment/chapter points** — where are the natural boundaries? Decide at planning time.
  Segmenting is one of Mayer's principles and it also determines where gaps and visual
  transitions land, which the timing solve depends on.
- **Emphasis** — decisions, mechanics, or impact? These produce very different scripts.
- **Framing** — celebratory or balanced? *"Celebrate the wins, don't dwell on gaps"*
  versus *"name the limitations too."* This changes wording throughout, not just tone.
- **Anything that must NOT be said** — unreleased names, internal-only figures,
  comparisons that would land badly.
- **Where will it be watched?** Platform, aspect ratio, embedded or standalone.

### C. Evidence — the mandatory group

See §4. Every figure needs a source before it reaches a script.

### D. Series and continuity

- **Standalone, or part of a set?** If a set: which part, and is it authored before or
  after its siblings?
- **Played back-to-back or independently?** *Back-to-back* means do not retread.
  *Standalone* means re-establish context. *Both* means soften the opening.
- **Does an earlier part function as this one's pre-training?** This is a content
  sequencing question, not just scheduling — it decides what this script may assume.
- **Continuity values that must match:** voice, speed, perceived gap, narration loudness.
  Mismatched loudness between parts is very obvious on back-to-back playback.

### E. Accessibility

See §3 — these are planning-time constraints, not post-production additions.

- **Narration-covers-visuals audit** (the load-bearing one)
- **Use-of-colour audit**
- **Contrast** for overlays, diagram labels, and any code theme on screen
- **Flashing / rapid-cut** check on animated transitions
- **Caption and transcript plan**

### F. Assets

- **What visuals already exist?** Screenshots, HTML, CSVs, diagrams, dashboards,
  recordings. Ask before designing a storyboard around something that would have to be
  built.
- **Anything that must appear?**

### G. Narration craft

- **Pronunciation glossary** — list acronyms, jargon, product names, and how each should
  be read (spelled out, as a word, or phonetically respelled). Building this as a planning
  artifact is verified professional practice `[VERIFIED]`, and it matters more here than
  for a human voice actor, who would improvise correctly.
- **Numbers convention** — how versions, dates, percentages, and currency will be written
  so that both a human reviewer and the TTS engine read them correctly. `v1.2` and
  `2026-09-21` are read very differently depending on how they are written.
- **Voice, and voice quality tier.** Two separate questions. Identity matching across a
  series matters, but engine tier matters more: a modern neural voice is materially
  better than a legacy one, and that gap is larger than the cost of an inconsistent —
  but good — voice between parts.

### H. Downstream reuse

- **Will this material also become slides, a doc, or a reference page?**
- **If so — as what mode?** Per Diátaxis, a tutorial-style walkthrough and a reference doc
  serve different user needs by design `[VERIFIED]`. Video is not a lossless source for
  documentation. Plan for reuse, but do not assume a downstream format is a trivial
  derivative of the script.

### I. Sign-off

- **Who must approve the script and the final cut?** Distinct from the render approval
  gate in `SKILL.md`, which is about spending render time; this is about who owns the
  content being correct.

---

## 3. Accessibility is a planning constraint, not a post step

### The load-bearing finding: narration IS the audio description

This pipeline produces **one audio track** and has no separate audio-description channel.
Under WCAG that makes *integrated description* the only conformant path — and there is a
named sufficient technique for exactly this production model, **G226: "Providing audio
descriptions by incorporating narration in the soundtrack."** `[VERIFIED — W3C]`

> *"Where all of the video information is already provided in existing audio, no
> additional audio description is necessary."* — WCAG 1.2.3 (Level A) and 1.2.5 (AA)

G226's own script rules, which are directly usable as a writing checklist `[VERIFIED]`:

- **Never say only "this" or "here"** — name the actual button, field, or label
- Describe elements by **both label and position**
- **Fully narrate sequences of action**, including anything that appears or disappears
- **Announce dialog and page titles**
- **Narrate mouse actions explicitly** — hover, select, scroll, open

**What this means at planning time:** for every diagram, UI state change, or piece of
on-screen text that carries meaning, confirm the *narration* will convey it. Not the
visual — the narration. Do this at storyboard time; it cannot be bolted on later without
a re-render.

### Use of colour

> *"Color is not used as the only visual means of conveying information, indicating an
> action, prompting a response, or distinguishing a visual element."* — WCAG 1.4.1
> `[VERIFIED]`

No W3C source specifically addresses code diffs or syntax highlighting `[VERIFIED — the
gap is real]`, so this application is `[INFERRED]` from the general rule: a red/green diff,
a colour-only "failed" state indicator, or a colour-only highlight needs a **second
channel** — glyph, shape, label, or narration. Standard diff renderers using `+`/`−`
already satisfy this; a custom animated diff built for a video must preserve it
deliberately.

### Contrast

**4.5:1** normal text, **3:1** large text (1.4.3), **3:1** for UI components and graphical
objects needed to understand content, including diagrams (1.4.11) `[VERIFIED]`. No
rounding — *"a computed 4.499:1 would not meet the 4.5:1 threshold."*

Applies to overlay text, diagram labels and arrows, and — worth calling out — **the code
theme in any screen recording**. Muted comment-grey on a dark background often measures
worse once recorded and compressed than its nominal hex value suggests `[INFERRED]`.

### Flashing

No more than **3 flashes in any one-second period** `[VERIFIED — WCAG 2.3.1]`. Covers
*all* content including purely decorative transitions, so it applies to rapid
diagram-state cuts, pulsing highlights, and fast-cut intro montages.

### Planning-time vs post-production

| Requirement | When | Why |
|---|---|---|
| Narration covers all visually-essential info (G226) | **Planning — hard constraint** | No separate AD channel exists to add later |
| No meaning by colour alone (1.4.1) | **Planning** | Redundant cues must be designed into the assets |
| Flash / rapid-cut threshold (2.3.1) | **Planning**, verifiable in post | Best avoided by design |
| Contrast (1.4.3 / 1.4.11) | **Planning** (theme/asset choice), measured in post | Theme selection happens at design time |
| Captions (1.2.2) | **Post-addable** — cheaply *only* if a clean locked script exists | Auto-captions over unplanned audio need heavy correction |

### Narration pacing ≠ caption reading speed

Two different numbers measuring different things:

- **Narration pacing** ~120–150 wpm — how fast the TTS speaks. Planning-time; determines
  how much script fits the runtime.
- **Caption reading speed** ~15–20 characters/second `[PARTIAL — professional captioning
  sources, not a W3C number]` — how fast viewers can read cue text. A post-production
  segmentation concern.

Well-paced narration sits comfortably below the caption ceiling, so verbatim captions
generally will not breach it `[INFERRED]`. What still needs post attention is line
breaking and cue timing — a formatting task, not a "speak slower" task.

---

## 4. Evidence and claims

**There is essentially no established standard for sourcing claims in technical video**
`[VERIFIED — the gap is real]`. This section is this document's own contribution. Do not
weaken it to match a convention that does not exist.

Every figure that appears in narration or on screen needs:

- **A source** — a file, a query, a PR, a run output. Be able to name it.
- **A currency check** — is this number still true? Numbers taken from an earlier run go
  stale silently.
- **A type**, using the schema the pipeline already provides:

```
claims: [{ claimId, type, provenanceIds }]      // provenanceIds: minItems 1
```

| Type | Means |
|---|---|
| `direct` | Read straight from a source — a row count, a banner figure |
| `derived` | Computed from sources — a percentage, a delta, a ratio |
| `hypothesis` | Believed but not demonstrated here |
| `aspirational` | A goal or target, **not** a current fact |

The `direct`/`derived` split matters most: a derived figure can be wrong even when every
input is right, and it is the kind that survives review because each source checks out
individually.

**At the approval gate, present figures with their sources**, not bare. A wrong percentage
is cheap to fix while it is still text and expensive once it is in a rendered video.

---

## 5. Writing narration for the ear

- **Write to be spoken, not read.** Shorter sentences than you would write for a page; one
  idea per sentence; front-load the subject.
- **Pacing: ~120–150 wpm for technical narration** `[PARTIAL — consistent across
  professional sources, no single standard]`. Denser material wants the lower end. Note
  Guo et al. found *faster, more enthusiastic* delivery correlated with higher engagement,
  which the authors attribute to enthusiasm rather than speed `[VERIFIED]` — relevant for
  a human read, less controllable with TTS.
- **Acronyms and jargon are genuinely ambiguous to a TTS engine.** Decide per term whether
  it is spoken as a word or spelled out, and record it in the glossary (§2.G).
- **Write numbers the way they should be read.** This is the most common source of an
  otherwise-perfect render needing a redo.
- **This is not a stack where SSML `<break>` can fix pacing** — see bug ledger entry 10.
  Pacing comes from the sentence and from the gap solve.

---

## 6. Choosing a target length

**3–6 minutes is a defensible default for a scoped technical demo.** Justify it by content
complexity and genre-matched data — not by the "six-minute rule."

### ⚠️ Do not cite the six-minute rule

Guo, Kim & Rubin (2014) is the source usually invoked, and it is widely misquoted
`[VERIFIED — full paper read]`:

- The finding was *"median engagement time is at most 6 minutes, regardless of total video
  length."* The **shortest** videos (0–3 min) had the **highest** engagement — there was
  no peak *at* six minutes. The common phrasing inverts this.
- The recommendation was to **chunk long lecture content**, not a ceiling on video length.
- The authors explicitly warn: *"it is important not to draw any conclusions about student
  learning solely from our findings about video engagement."*
- It measured a **graded MOOC with embedded quizzes and anonymous auditors** — not
  standalone technical demos.
- A direct rebuttal exists: **Lagerstrom, Johanes & Ponsukcharoen (2015), "The Myth of the
  Six-Minute Rule"** found 90%+ completion on 50–75 minute videos in for-credit courses and
  suggests 12–20 minutes as a rule of thumb, attributing the original effect to **audience
  motivation**, not an attention ceiling `[VERIFIED]`.

### Better evidence to reason from

- **Wistia** (13M+ hosted videos): *"Educate or explain: 1–5 mins — how-tos, product
  demos… Viewers typically watch over 50% of an educational video."* A gradual 11% drop
  appears past 30 minutes, not a cliff at 6 `[VERIFIED]`.
- **TechSmith 2024** (n=1,000, **stated preference**, not measured behaviour) disagrees
  with "shorter is always better": most-desired length for instructional video was
  10–19 minutes `[VERIFIED]`. Treat with care — stated preference and revealed behaviour
  diverge, and this tension is unresolved.
- **No source found** gives data specifically for standalone technical/developer demo
  video. The closest genre match is Wistia's educate/explain bucket.

---

## 7. Principles worth knowing

Mayer's cognitive theory of multimedia learning `[VERIFIED]`. The ones that are
**planning-time decisions** rather than editing fixes:

| Principle | Planning implication |
|---|---|
| **Coherence** | Cut anything not serving the objective — decorative visuals, tangents, music that competes |
| **Signaling** | Plan how attention is directed — highlights, callouts, narration cues |
| **Redundancy** | **Do not put narration text on screen as bullets while narrating it.** Visuals should complement, not duplicate. This constrains storyboarding directly |
| **Segmenting** | Decide chapter boundaries at planning time (§2.B) |
| **Pre-training** | Decide what must be introduced before the walkthrough (§2.A, §2.D) |
| **Modality** | Prefer narration + graphic over on-screen text + graphic |
| **Personalization** | Conversational register beats formal |
| **Voice** | Quality of the speaking voice matters — see the tier question in §2.G |

Note the tension between **redundancy** (don't duplicate narration on screen) and the
**G226 accessibility requirement** (narration must cover everything visually essential).
They resolve in the same direction: *narration carries the meaning, visuals illustrate it*
— rather than visuals carrying meaning that narration merely echoes.
