# Content Coach Rubric — Pre-Render Review of Narrated Technical Explainer Videos

## About this rubric

- **What it is.** The rubric the `video-coach` agent applies (`.github/agents/video-coach.agent.md`): pass 1 before TTS, pass 2 before frame capture. The coach is advisory only and never gates a render ([ADR 0006](../../../docs/adr/0006-keep-the-video-coach-advisory-only.md)).
- **Where it came from.** It graduated from the video-coach backtest. Its body is the backtest's rubric as committed at `b3cffb0` (unchanged since `ee835ad`), written blind by a research agent that read no file in this repository. Every change made at graduation is listed under "Changes at graduation", at the end. Those changes were not written blind: their author had read the repository, the backtest's answer key and its scoring.
- **Sections of a report.** A finding under a rule marked defect-eligible goes in the coach's **DEFECTS** section, and every other finding in **ADVISORY**. Every rule the coach does not evaluate, every lane under "Covered by the pipeline" and every item under "Not evaluatable from these inputs" goes in **NOT EVALUATED**, citing its ID. The backtest's own records keep the names in force when they were written.
- **Defect-eligible.** A rule is defect-eligible only if it is objective, meaning two careful reviewers who follow its check procedure on the same inputs reach the same answer, and either (a) it rests on a [VERIFIED] source, or (b) it tests the video against itself: narration against on-screen text, numbers, labels, timing, the storyboard's declared structure or the brief, where a contradiction is wrong under any taste. No threshold without a source: a rule whose procedure needs a judgement is not defect-eligible. What that rules out is a threshold no source gives, or one the reviewer must choose while checking. A figure selected once, inside bounds measured on the user's own reviews, and fixed before any check, is sourced; OBJ-07's 1.5 s is that case (see "Fitted, not yet tested"). A rule that cannot run on the inputs this pipeline produces is not objective, because nobody can follow its procedure, so it is not defect-eligible either (see "Carried by no input"). Each rule's Defect-eligible field gives its reason in one line.
- **IDs.** `OBJ-nn` are objective rules and `CRAFT-nn` craft rules. `ENG-nn` are the lanes the engine's audits do or do not own ("Covered by the pipeline"). `NE-nn` are what no input here can show ("Not evaluatable from these inputs").
- **Format.** `tools/SizzleCraft/tests/coach-rubric.test.mjs` reads this file and fails on anything it cannot read. A rule is a heading `### <ID> — <name>` followed by exactly ten one-line bullets, in this order: Rule, Class, Defect-eligible, Pass, Tag & source, Inputs used, Check procedure, Evidence to cite, Not a defect, Blind spot. Class opens with `objective` or `craft`, matching the ID. Defect-eligible is `yes` or `no`; an objective rule gives its reason after ` — `, and a craft rule is never `yes`. Pass is `1`, `2` or `both`, the values the coach acts on, or `none` for a rule no input lets run, which the coach reports under NOT EVALUATED at both passes; any of them may be followed by ` — ` and a note. Tag & source opens with exactly one of [VERIFIED], [PRACTICE] and [HOUSE]. A figure is a number with its unit: "1.5 s" and "1.5 ms" are different figures, and a criterion's number such as 1.4.1 is one figure, not three. Every figure a rule's Rule field states must appear, in the same unit, in its Check procedure. Pass 1 has only the script and the brief, so a rule marked `1` or `both` names the script or the brief for pass 1, and names a pass-2 input (timing, storyboard, stills, audit output) only after "at pass 2", for what it reads then. The test also applies the defect-eligible criterion above as far as it can be read mechanically. A rule evaluated at any pass may not ask, in its Rule, Inputs used, Check procedure or Evidence to cite, for anything listed under "Carried by no input"; a `none` rule names what it lacks in its Pass note, and is never defect-eligible. A defect-eligible rule's Rule, Check procedure and Blind spot carry none of the marks of a threshold no source gives ("judgement", a figure written "~5", "typically", "conventional", "roughly", "approximately"). Every figure in its Check procedure has a unit, and its Tag & source states that figure in that unit, so a criterion's number cannot pass for a threshold. A threshold written in plain words, with none of those marks and no figure, gets past the test, so the reviewer still reads for one. A lane is a heading `### ENG-nn — <name>` with five bullets: Status, Audit, On failure, Seen to fail, Owner. Each not-evaluatable item opens with its bold `NE-nn`. IDs are unique, and every ID the text mentions is defined.

## Fitted, not yet tested

The backtest found two holes in this rubric (ADR 0006), and graduation closed both: OBJ-07 now times the claim it checks against a tolerance, and OBJ-19 is new. **Both were fitted to the very misses they were written to catch, and have not been tested on a fresh review round.** The rounds that exposed them cannot test them. Until a round they were not fitted to has done so, their findings are no better evidenced than the rest of this rubric's.

**OBJ-07's tolerance: the bounds were measured, and 1.5 s was selected inside them.** The figures come from the EvalLoopDemo timing files: each named element's reveal `atMs`, less the claim word's time from the segment's start.

- *Must pass.* The shipped cut (`3bd77a2`, on branch `eval-loop-demo-build`). Every presence claim in it lags its visual by exactly what it did in r7 (`fc8dece`), which the user reviewed and sent to render with a single fix, to a fact count. Its worst lag is 0.63 s: in `hard`, "On the right of the screen, the interview branches", "screen" is spoken at 6.672 s and the last branch edge is drawn at 7.302 s. Timed from "On" (6.229 s) instead, it is 1.07 s. Every other claim's visual is on screen before its word, or within 0.08 s of it.
- *Must fail.* R2-06, in r2's `many`: "screen" at 11.996 s, and the three strips at 16.442, 17.421 and 18.400 s, which is 4.45 s to the first and 6.40 s to the last. R6-10, in r6's `twotier`: "screen" at 1.545 s and the API lane at 12.928 s, 11.38 s later; and "labelled" (A P I) at 10.827 s, 2.10 s before the same lane appears. The user reported both items.
- *So* the tolerance must sit above 1.07 s and, to catch every claim in the items the user reported, below 2.10 s. 1.5 s was selected inside those bounds, leaving at least 0.4 s on either side whichever word a claim is timed from. The selection is a judgement, made once, here, and disclosed; the coach applies the fixed figure. That keeps OBJ-07 defect-eligible. The rule against a threshold without a source is aimed at a threshold no source gives, or one a reviewer must choose while checking, and this one is neither: measurements bound it, and it is fixed before any check.
- The backtest's answer key used 1.0 s, chosen before any run and never measured. Timed from its first word, the shipped cut's `hard` claim would fail it.
- The shipped cut still trips OBJ-07 once, whatever the tolerance. In `blindspot`, "Watch it drive the real U I" plays over the stage-trace diagram because the interface was never captured, and the shipped cut records that as an accepted gap. "The shipped cut passes" therefore bounds the tolerance, not the rule.

**OBJ-19 generalizes a single report.** In R6-13, r6's `loop` drew the edge from "re-run" back to "run the suite × 3" straight through the "open the pull request" box. The layout audit reported "layout issues: none", and the user wrote that "the diagrams are overlapping and hard to read" (ADR 0006). r1 showed the same class, arrowheads hidden under neighbouring boxes, and the audit passed that too. The diagram coordinates in r6's inputs reproduce R6-13, and r2's reproduce the identical crossing. No passing case bounds OBJ-19. On the shipped cut it should raise one finding: in `loop`, the same edge now passes under the corner of "read the delta", by about 23 × 5 diagram units. It is visible in a still rendered from the shipped cut at graduation, and the user did not report it. A ruling on that finding should settle it, not a narrower rule.

## What the inputs carry

The coach reads this rubric and its input set and nothing else, so a rule can use only what these carry. Pass 1 has the script and, sometimes, a brief; pass 2 adds the rest.

- **script** — `script.md`: each segment's id and heading, its narration, and the author's On-screen and Claims notes.
- **brief** — what the video is for and who watches it, when the dispatcher supplies one.
- **timing** — `timing.json`: each segment's `startMs` and `endMs`; its narration words with their times (`audio.words[]`); its visual, including a diagram's nodes with their coordinates, its edges, and a code block's highlight times; and its authored triggers (`triggers[]`), each with the time it fires (`atMs`), its target and its action.
- **storyboard** — `storyboard.html`: each segment's narration, claims and a preview of its visual, a diagram drawn from the timing file's coordinates with its steps numbered in reveal order.
- **stills** — one PNG per segment, taken by `preview` at 86 % of the segment's window.
- **audit output** — the transcript of `preview`, the stage that takes the stills: its layout audit's findings (ENG-01, ENG-02).

## Carried by no input

A rule that needs one of these cannot run. It is marked `Pass: none`, meaning NOT EVALUATED at either pass, and its Pass note names what is missing; such a rule is never defect-eligible. A rule evaluated at any pass may not ask for one of these in its Rule, Inputs used, Check procedure or Evidence to cite. The test enforces both.

- **trigger words** — a trigger records when it fires (`atMs`), its target and its action, never a word it is keyed to. None of the 109 triggers in the backtest's r2 timing, or of the 106 in the shipped cut's, has one.
- **chapter marks** — the timing file has none. Chapters are written after the coach runs, one per segment start, by `write-chapters`.
- **animation timing** — the storyboard shows reveal order only; its own footer says "motion (edge draw, flowing particles, active-path pulse) is applied at render". Flash rates, easings and durations are in no input.

## Scope and boundary conditions (apply to every rule below)

This rubric equips a read-only coach that reviews short (roughly 3–6 minute) narrated technical explainers for software engineers, before the expensive TTS/timing/frame-capture stages. Pass 1 sees the script (segmented, with ids/headings) and sometimes a brief (purpose, audience). Pass 2 additionally sees a timing file (segment start/end, word-level narration timestamps, and the trigger time of each named visual step), the storyboard (per-segment HTML/CSS/SVG), a handful of rendered stills, and the pipeline's automated-audit output. The coach cannot hear audio, watch motion, or see unrendered frames.

Three boundary conditions recur across the rules and are stated once here rather than in each entry:

1. **Expertise reversal.** Kalyuga, Ayres, Chandler & Sweller (2003) report that instructional supports which help novices (extra elaboration, redundant restatement, heavier signaling) can fail to help, or actively slow down, learners who already hold a schema for the material — the "expertise reversal effect." This pipeline's audience is domain-experienced engineers. Rules touching redundancy, pacing, or explanatory depth are calibrated to an expert audience: the coach must not flag the *absence* of novice-oriented scaffolding (defining basic terms, restating a diagram in words) as a defect.
2. **System-paced delivery.** The video plays at a fixed pace with no viewer-side pause/replay built into the format itself. Cognitive-load-relevant rules (e.g., simultaneous novelty, missing signaling) are held to a stricter standard than they would be for self-paced material, because the viewer cannot slow down a confusing moment.
3. **Synthetic narration.** Historic "voice principle" findings that a human-recorded voice outperforms a machine voice were established using early, robotic-sounding TTS. Craig & Schroeder (2017) revisited the comparison with a more conversational synthetic voice and found the human-voice advantage shrank and was not consistent across their experiments. This rubric does not treat synthetic narration itself as a defect, and no rule below penalizes "sounding like TTS"; only script- and delivery-level properties that narration can actually control are in scope.

Rules are grouped: Message and structure; Narration (script); Narration and visuals together; Visual design and density; Accessibility; Pacing. IDs: `OBJ-nn` objective, `CRAFT-nn` craft.

---

## Message and structure

### OBJ-01 — Script scope contradicts the brief
- Rule: It is a defect when the script's actual subject matter, scope, or assumed audience knowledge contradicts what the brief states.
- Class: objective
- Defect-eligible: yes — tests the video against itself (brief vs. script); a contradiction is wrong under any taste.
- Pass: 1
- Tag & source: [PRACTICE] user-supplied checklist (unsourced) — the checklist's "pick a focused topic" bullet could not be traced to any fetched practitioner source (see Sources); kept as an unsourced practice point per the task's fallback instruction, re-expressed as a checkable brief/script consistency test.
- Inputs used: brief, script.
- Check procedure: 1) Extract the brief's stated purpose and audience/knowledge-level line. 2) Read the full script and note the system/concept actually covered and the knowledge level assumed. 3) Flag a defect if the script covers a different system than the brief names, or assumes a different knowledge level than the brief states (e.g., brief says "audience already knows X," script re-derives X from scratch, or the reverse).
- Evidence to cite: the brief's exact purpose/audience sentence; the contradicting segment id and quoted script line.
- Not a defect: the script covering the brief's topic with different emphasis, ordering, or examples than a reviewer might personally prefer.
- Blind spot: cannot judge whether the brief itself was well-scoped, only whether the script matches it; not applicable when Pass 1 has no brief supplied.

### CRAFT-01 — Missing or weak opening hook
- Rule: It is a defect-candidate (craft) when the opening segment gives the viewer no concrete question, stake, or surprising fact before it starts explaining mechanism.
- Class: craft
- Defect-eligible: no — craft rules are judgement calls, never defect-eligible by definition.
- Pass: 1
- Tag & source: [PRACTICE] user-supplied checklist (unsourced) — "write a strong hook" bullet; none of the four fetched non-video checklist sources (Crash Course Creator Lab, esteem.nd.edu, academyforvirtualteaching.com, indie-film-making.com) state this specific claim, and the four YouTube sources could not be fetched (see Sources), so this is credited only to the checklist itself, per the task's explicit fallback.
- Inputs used: script, brief.
- Check procedure: 1) Read the first segment's narration. 2) Judge whether it opens with a concrete question, consequence, or surprising fact rather than starting directly with background/definitions. 3) Record as a craft note, not a pass/fail gate.
- Evidence to cite: segment id of the opening segment; its first 1–2 narration sentences, quoted.
- Not a defect: an opening that states the topic plainly and moves straight to mechanism — for an expert audience this may be a deliberate efficiency choice rather than a flaw (expertise reversal, see Scope).
- Blind spot: cannot tell whether a hook lands emotionally — only whether one is structurally present.

### OBJ-02 — Chapter markers don't align to segment/topic boundaries
- Rule: It is a defect when a marked chapter starts or ends in the middle of a script segment/sub-topic rather than at a segment boundary.
- Class: objective
- Defect-eligible: no — its own procedure leaves marginal placements to reviewer judgement because no source gives a tolerance, and a rule whose procedure needs a judgement is not defect-eligible.
- Pass: none — NOT EVALUATED at either pass: no input carries chapter marks; chapters are written after the coach runs, one per segment start.
- Tag & source: [PRACTICE] user-supplied checklist (unsourced) — "organize into modular sections" bullet, re-expressed as a checkable structural test; not substantiated by any fetched source (see Sources).
- Inputs used: timing file (segment start/end, chapter marks), script (segment ids/headings).
- Check procedure: 1) List chapter-mark timestamps from the timing file. 2) List segment start/end timestamps. 3) Flag a defect if any chapter mark falls strictly inside a segment's [start, end) range rather than at or very near a segment boundary (no source gives a tolerance number; treat any clear mid-segment placement as the defect and leave marginal cases to reviewer judgement — this keeps the rule objective for clear cases while not inventing a numeric tolerance threshold no source provides.
- Evidence to cite: the chapter-mark timestamp; the segment id and its start/end it falls inside.
- Not a defect: a chapter boundary that coincides with a segment boundary, even when it groups multiple short segments under one chapter heading.
- Blind spot: cannot judge whether chapter titles are well-worded, only their placement.

### CRAFT-02 — Section count mismatched to runtime and audience
- Rule: It is a defect-candidate (craft) when the number of top-level sections is so high, for a 3–6 minute video, that a viewer must track more top-level chunks than short-term memory comfortably holds at once.
- Class: craft
- Defect-eligible: no.
- Pass: both
- Tag & source: [VERIFIED] Cowan, N. (2001). The magical number 4 in short-term memory: A reconsideration of mental storage capacity. *Behavioral and Brain Sciences, 24*(1), 87–114. https://www.cambridge.org/core/journals/behavioral-and-brain-sciences/article/magical-number-4-in-shortterm-memory-a-reconsideration-of-mental-storage-capacity/44023F1147D4A1D44BDC0AD226838496 — finding: capacity-limited storage in short-term/working memory holds roughly 3–5 meaningful chunks once rehearsal and long-term-memory strategies are controlled for, revising the older "7±2" estimate downward. Boundary: this is a simultaneous-holding capacity finding, not a validated rule for video section counts — used only as a soft order-of-magnitude anchor, which is why this stays craft rather than objective.
- Inputs used: script (segment headings), brief.
- Check procedure: 1) Count top-level sections/headings. 2) Judge whether, for a 3–6 minute runtime, the count sits near Cowan's small-chunk range or clearly exceeds it with no grouping/recap device. No numeric pass/fail threshold is asserted.
- Evidence to cite: the list of section headings and their count.
- Not a defect: a higher count when sections are explicitly grouped under fewer named chapters, effectively re-chunking them.
- Blind spot: cannot measure actual viewer recall; this is an analogy to a memory-capacity finding, not a direct test of it.

### CRAFT-03 — Register inconsistent with a technical-peer tone
- Rule: It is a defect-candidate (craft) when the narration's register shifts inconsistently between casual/conversational phrasing and stiff, formal technical prose across segments, with no apparent reason.
- Class: craft
- Defect-eligible: no.
- Pass: 1
- Tag & source: [PRACTICE] user-supplied checklist (unsourced) — "keep the tone conversational" bullet; not substantiated by any fetched source (see Sources).
- Inputs used: script.
- Check procedure: 1) Read the script end-to-end. 2) Note segments that read as addressed to "a smart friend" (conversational) versus segments that read like formal documentation (passive voice, no second person, no contractions). 3) Flag as a craft note if the shift seems arbitrary rather than deliberate (e.g., a serious/cautionary aside).
- Evidence to cite: the two (or more) segment ids being compared and a representative quoted sentence from each.
- Not a defect: a deliberate, brief shift to a more formal register for a warning, caveat, or precise technical definition.
- Blind spot: "conversational" is itself a judgement call; the check cannot hear delivery, only read word choice.

### OBJ-03 — Same concept given inconsistent names with no on-screen mapping
- Rule: It is a defect when the narration refers to the same system/concept by two or more different names across segments and the storyboard never visually maps the names to each other.
- Class: objective
- Defect-eligible: yes — objective count/match check, and a self-test (script vs. script, cross-checked against storyboard) that a VERIFIED source also motivates.
- Pass: 2 — not pass 1: whether the storyboard maps the two names cannot be checked before there is a storyboard.
- Tag & source: [VERIFIED] Richter, T., Scheiter, K., & Eitel, A. (2016) — signaling/cueing research in multimedia learning — PsychArchives. https://psycharchives.org/en/item/7bf33e3f-9355-4fc8-90cd-6618021338ac — finding: verbal/visual signals that consistently mark what matters help learners build correct connections; inconsistent labeling undermines the very signal a cue is meant to send. Boundary: for expert viewers the risk is not comprehension failure but wasted attention re-resolving which name maps to which entity — still a real cost under system pacing (see Scope).
- Inputs used: script, storyboard.
- Check procedure: 1) Extract every named entity/system component mentioned two or more times in the script. 2) Group mentions referring to the same referent. 3) Flag a defect if a referent has two or more distinct names and the storyboard contains no explicit visual pairing (e.g., a label showing "X (also called Y)" or an on-screen renaming callout).
- Evidence to cite: the two conflicting terms, their segment ids and timestamps, and confirmation the storyboard has no mapping element.
- Not a defect: a deliberate one-time aside that explicitly introduces an alternate name ("some call this a buffer") and then uses one name consistently afterward.
- Blind spot: cannot judge whether the audience would find the terms obviously synonymous; relies on the reviewer's domain knowledge.

### CRAFT-04 — Dense technical concept has no analogy or concrete example
- Rule: It is a defect-candidate (craft) when a segment introduces an abstract mechanism with no analogy, concrete example, or worked instance to anchor it.
- Class: craft
- Defect-eligible: no.
- Pass: 1
- Tag & source: [PRACTICE] user-supplied checklist (unsourced) — "using humor and analogies" bullet; not substantiated by any fetched source (see Sources).
- Inputs used: script, brief.
- Check procedure: 1) Identify segments introducing a new mechanism or abstraction. 2) Judge whether the narration gives at least one concrete example, analogy, or instance, or whether it stays entirely abstract. 3) Record as a craft note.
- Evidence to cite: segment id and the abstract passage in question.
- Not a defect: a segment that is itself a worked example (no separate analogy needed), or a case where the expert audience needs no analogy for a familiar abstraction (expertise reversal, see Scope).
- Blind spot: cannot judge whether an analogy present is actually a good or accurate one, only whether one exists.

### CRAFT-05 — Flat delivery pacing with no emphasis variation
- Rule: It is a defect-candidate (craft) when the script gives the narration no cues (punctuation, phrasing, short emphatic sentences) to vary pace or stress key terms anywhere in the video.
- Class: craft
- Defect-eligible: no.
- Pass: 1
- Tag & source: [PRACTICE] user-supplied checklist (unsourced) — "pace your delivery ... leave room for emphasis on key terms" bullet; not substantiated by any fetched source (see Sources).
- Inputs used: script.
- Check procedure: 1) Read the full script for sentence-length variation and any explicit emphasis markers (short punchy sentences, set-off key terms). 2) Judge whether the whole script reads as uniformly paced with no variation anywhere. 3) Record as a craft note.
- Evidence to cite: representative segment ids showing uniform sentence rhythm.
- Not a defect: consistently measured, evenly paced delivery that is a deliberate stylistic choice for dense technical content — the synthetic-narration boundary condition (see Scope) means we do not require "energetic" delivery cues as a fix.
- Blind spot: this reads only the script text; actual TTS delivery variation (prosody) cannot be assessed from these inputs (see Not evaluatable).

### OBJ-04 — Narrated number contradicts the on-screen number
- Rule: It is a defect when the narration states a numeric value (count, percentage, size, duration, version) that differs from the corresponding number rendered on screen in the same segment.
- Class: objective
- Defect-eligible: yes — tests the video against itself; a numeric contradiction is wrong under any taste.
- Pass: 2
- Tag & source: [PRACTICE] user-supplied checklist (unsourced) — generalizes the "plan your visuals" bullet (visuals and narration must be planned together) into a checkable numeric-consistency test; not substantiated by any fetched source (see Sources).
- Inputs used: script, storyboard, stills.
- Check procedure: 1) Extract every number spoken in the narration, with its segment id and word timestamp. 2) Extract every number rendered in the storyboard/stills for the same segment. 3) Flag a defect where a spoken number and an on-screen number describing the same quantity disagree.
- Evidence to cite: the spoken number with word and timestamp; the on-screen text and still filename (or storyboard element id) showing the conflicting number.
- Not a defect: two numbers that are simply different quantities (e.g., narration gives a duration, slide gives a count) rather than the same quantity stated twice.
- Blind spot: cannot verify which number is factually correct, only that they disagree.

### OBJ-05 — Narrated label contradicts the on-screen label
- Rule: It is a defect when the narration names a component or step using a term that does not match the label rendered for that same component or step on screen.
- Class: objective
- Defect-eligible: no — its procedure starts from the trigger words in the timing file, and no input carries trigger words, so it cannot run as written.
- Pass: none — NOT EVALUATED at either pass: its procedure needs trigger words, which no input carries.
- Tag & source: [PRACTICE] user-supplied checklist (unsourced) — "plan your visuals" bullet, generalized into a checkable label-consistency test; not substantiated by any fetched source (see Sources).
- Inputs used: script, timing (trigger words), storyboard, stills.
- Check procedure: 1) For each visual element with an on-screen text label, find the trigger word/phrase in the timing file that introduces it. 2) Compare the label text to the narration word(s) around that trigger. 3) Flag a defect if they name the same thing differently with no on-screen reconciliation.
- Evidence to cite: the trigger word and timestamp; the on-screen label text and still filename/storyboard element id.
- Not a defect: narration using a shorter/informal reference to a fully labeled element once the pairing has already been established earlier in the same segment.
- Blind spot: cannot judge which label is more correct, only that they disagree.

### OBJ-06 — Visual trigger keyed to a word absent from the narration
- Rule: It is a defect when a visual step's trigger word (from the timing file) does not actually occur in the narration text at or near that timestamp.
- Class: objective
- Defect-eligible: no — it compares trigger words with the narration, and no input carries trigger words, so it cannot run as written.
- Pass: none — NOT EVALUATED at either pass: it needs trigger words, which no input carries.
- Tag & source: [PRACTICE] user-supplied checklist (unsourced) — "plan your visuals" bullet, generalized into a checkable trigger-integrity test; not substantiated by any fetched source (see Sources).
- Inputs used: timing (trigger words/timestamps), script.
- Check procedure: 1) For each visual step, read its designated trigger word from the timing file. 2) Locate that word in the script at the matching timestamp/word-level alignment. 3) Flag a defect if the trigger word cannot be found in the narration at that point (e.g., renamed in a later script edit, or a stale trigger left over from an earlier draft).
- Evidence to cite: the visual step id, its declared trigger word and timestamp, and the actual narration word(s) present at that timestamp.
- Not a defect: a trigger word that appears in a slightly different inflected form (plural, verb tense) of the same word.
- Blind spot: cannot judge whether the chosen trigger word is a good choice, only whether it exists in the narration at all.

### OBJ-07 — Narration points at a visual that is not on screen
- Rule: It is a defect when the narration speaks of a visual as already on screen ("on screen", "shown here", "as you can see", "labelled …", "watch", "notice", "this diagram") and an element it names is still not on screen 1.5 s after the word that makes the claim, including an element that never appears in that segment at all.
- Class: objective
- Defect-eligible: yes — tests the video against itself (the narration's claim against the timing file's reveal times, the storyboard and the still), with a tolerance selected inside measured bounds; narration that points at something that is not there is wrong under any taste.
- Pass: 2
- Tag & source: [HOUSE] the user's own reviews of the EvalLoopDemo renders. The spoken-moment test and its 1.5 s tolerance are fitted to them (R2-06 and R6-10 reported, the shipped cut accepted) and have not been tested on a fresh round; see "Fitted, not yet tested" for the observations that bound the tolerance. The rule itself generalizes the user-supplied checklist's "plan your visuals" bullet, which no fetched source substantiates. Boundary: a visual that leads its narration is never a defect here, whatever the lead; the user's stated preference is to show a diagram before talking about it.
- Inputs used: script, timing, storyboard, stills.
- Check procedure: 1) Scan the narration for presence claims: words that speak of a visual as already on screen, such as "on screen", "shown"/"showing", "here" pointing at the screen, "see"/"watch"/"look"/"notice" directed at it, "labelled …", or "this"/"these" with a visual noun. 2) Time each claim from the word that makes it ("screen" in "on screen", "labelled", "Watch", "Notice"), not from the first word of its phrase: that word's `audio.words[].startMs` in the timing file, less the segment's `startMs`. 3) List every element the claim names: "three result strips" is three elements, and "the lanes" is every lane. An element's reveal time is the `atMs` of the trigger in the segment's `triggers` that reveals it (`revealNode`, `drawEdge`, `rise`, `pop` and the like), which is already counted from the segment's start. A part of the slide itself, such as its title, is on screen from the start. In a segment with no authored trigger target, the builder sets the reveal times and no input carries them; see Blind spot. 4) The lag is the latest reveal time among the named elements, less the claim's time. Flag a defect if the lag exceeds 1.5 s, or if a named element never appears in the segment: the storyboard and the still do not show it, or, in a segment whose triggers are authored, no trigger reveals it. 5) The 1.5 s threshold was selected inside bounds measured on this pipeline's own review rounds; see "Fitted, not yet tested".
- Evidence to cite: as QUOTE, the claim verbatim from the script, with its segment id, the claim word and its time from the segment's start; each named element's id with its reveal time, or "never shown"; and the lag.
- Not a defect: a visual already on screen when it is spoken of, however early it arrived; narrative deixis that does not point at the screen ("here is the hard part", "as we'll see"); a verb for what an element on screen does or will do ("the lanes fill", "the panel slides in"), because only the elements the claim names must be on screen, not the action; an element the claim does not name.
- Blind spot: the timing file carries only authored triggers. A segment with no authored trigger target gets its reveal times from the builder, and those are in no input, so the lag cannot be measured there: report that under NOT EVALUATED, while the never-shown clause still applies. The timing file records reveals, not removals, so an element hidden again before it is spoken of reads as present. Which elements a claim names is a reading of the script, not a measurement. The rule cannot judge whether a visual that is present matches what the narration meant.

### OBJ-08 — On-screen claim contradicts narration or brief elsewhere
- Rule: It is a defect when text rendered on screen asserts something that contradicts a statement made in the narration (in the same or a different segment) or in the brief.
- Class: objective
- Defect-eligible: yes — self-test; a direct contradiction is wrong under any taste.
- Pass: both — at pass 1 it reads the on-screen text from the script's On-screen notes
- Tag & source: [PRACTICE] user-supplied checklist (unsourced) — generalizes the checklist's overall coherence expectations (plan script and visuals together) into a checkable claim-consistency test; not substantiated by any fetched source (see Sources).
- Inputs used: script and brief, where at pass 1 the script's On-screen notes give the on-screen text; at pass 2 also storyboard, stills.
- Check procedure: 1) Extract every on-screen text claim (a sentence or phrase asserting a fact, not just a label). 2) Compare each to the narration and to the brief. 3) Flag a defect on any direct factual contradiction (e.g., a slide says "always X" while narration says "usually X, except when Y").
- Evidence to cite: the on-screen text (still filename/storyboard element id) and the contradicting narration or brief line, each quoted.
- Not a defect: an on-screen claim that is a simplification or a subset of a more nuanced narration statement, without contradicting it.
- Blind spot: cannot verify which claim is factually correct, only that they disagree. At pass 1 the script's On-screen notes stand in for the screen, so a note the storyboard later departs from can raise a finding the render would not; pass 2 checks the storyboard and the stills themselves.

### OBJ-09 — Cumulative new on-screen elements exceed a working-memory-motivated ceiling
- Rule: It is a defect when more than a small number of new distinct visual elements accumulate on screen within a short time window without any being removed, grouped, or visually consolidated.
- Class: objective
- Defect-eligible: no — its count is sourced but its rolling 5-second window is not: Cowan (2001) bounds how many chunks are held at once, not over what span of time, and no threshold may stand without a source.
- Pass: 2
- Tag & source: [VERIFIED] Cowan, N. (2001). The magical number 4 in short-term memory: A reconsideration of mental storage capacity. *Behavioral and Brain Sciences, 24*(1), 87–114. https://www.cambridge.org/core/journals/behavioral-and-brain-sciences/article/magical-number-4-in-shortterm-memory-a-reconsideration-of-mental-storage-capacity/44023F1147D4A1D44BDC0AD226838496 — finding: capacity-limited storage in short-term/working memory holds roughly 3–5 meaningful chunks. Boundary: this concerns simultaneously-held items, distinct from visual events overlapping in time, the literal timing collisions that no engine audit checks (ENG-12); this rule instead flags cumulative, non-overlapping new elements that still pile up faster than they can be chunked. For expert viewers, chunking may occur at a higher level (a whole diagram read as one chunk) — the check counts newly-introduced distinct visual elements, not raw shapes, so a single diagram revealed at once (one new chunk) does not itself trigger this rule.
- Inputs used: timing (visual step trigger times), storyboard, stills.
- Check procedure: 1) List each segment's visual steps in trigger-time order. 2) In any rolling ~5-second window, count new distinct elements introduced (not yet removed/merged). 3) Flag a defect where the count exceeds 5 (the top of Cowan's range) with no consolidation (e.g., grouping several under one labeled container) before the next new element appears.
- Evidence to cite: the visual step ids and trigger timestamps of the elements counted; the still filename showing the pileup.
- Not a defect: many elements that are visually grouped under a single container/label the moment they appear (one chunk, not many).
- Blind spot: cannot judge whether an expert viewer would perceive several elements as obviously one thing faster than a novice would; this is a mechanical count, not a perception test.

### OBJ-10 — Emphasized content has no visual cue distinguishing it
- Rule: It is a defect when the visual element the narration is currently emphasizing (via a trigger word/phrase that names or foregrounds it) has no distinguishing visual treatment (color, outline, arrow, motion, size) setting it apart from co-present elements at that moment.
- Class: objective
- Defect-eligible: no — its procedure finds the emphasized moment through trigger words, which no input carries, and inspects a still at that moment, when there is one still per segment; it cannot run as written.
- Pass: none — NOT EVALUATED at either pass: its procedure needs trigger words, which no input carries, and a still at the emphasized moment.
- Tag & source: [VERIFIED] Richter, T., Scheiter, K., & Eitel, A. (2016) — signaling/cueing research in multimedia learning — PsychArchives. https://psycharchives.org/en/item/7bf33e3f-9355-4fc8-90cd-6618021338ac — finding: signals that visually mark task-relevant information help learners direct attention to what matters and build correct links between narration and visuals. Boundary: expert viewers may need less exhaustive cueing than novices (expertise reversal); this rule is satisfied by any distinguishing treatment at all, not a specific style, and does not require cueing every element — only the one element the narration is actively pointing to at that instant.
- Inputs used: timing (trigger words/timestamps), storyboard, stills.
- Check procedure: 1) Identify moments where the narration names or foregrounds a specific visual element (per the trigger-word mapping). 2) Inspect the storyboard/still at that timestamp for any visual distinction applied to that element versus its co-present neighbors. 3) Flag a defect if no distinguishing treatment exists at all.
- Evidence to cite: the trigger word/timestamp; the still filename and a description of the co-present elements with no distinguishing treatment.
- Not a defect: a segment with only one visual element on screen (nothing to distinguish it from).
- Blind spot: cannot judge whether the cue chosen is a good one (e.g., color alone may fail SC 1.4.1, covered separately under Accessibility) — only whether some cue exists.

### OBJ-11 — Visual element never referenced by the narration (possible seductive detail)
- Rule: It is a defect when a visual element present on a still/storyboard is never mentioned, implied, or referenced anywhere in that segment's narration, and carries no on-screen explanatory label of its own.
- Class: objective
- Defect-eligible: yes — objective presence/absence check against a VERIFIED source, and also a self-test (element vs. narration text).
- Pass: 2
- Tag & source: [VERIFIED] Rey, G. D. (2012). A review of research and a meta-analysis of the seductive detail effect. *Educational Research Review, 7*(3), 216–237 (accessed via ERIC EJ986386). https://eric.ed.gov/?id=EJ986386 — finding: the meta-analysis found interesting-but-irrelevant "seductive details" reliably reduce learning outcomes across the reviewed studies. Boundary: the effect concerns irrelevant added material competing for attention/processing, not visual complexity per se; a relevant element unmentioned by narration but explained by its own on-screen label is not automatically seductive — the check specifically flags elements with neither a narration reference nor on-screen explanatory text.
- Inputs used: script, storyboard, stills.
- Check procedure: 1) List every distinct visual element present in a segment's storyboard. 2) For each, check whether it is referenced by the narration OR carries its own on-screen explanatory label/caption. 3) Flag a defect for any element with neither.
- Evidence to cite: the storyboard element id or still filename showing the element; confirmation that the segment's full narration text contains no reference to it.
- Not a defect: purely decorative background/branding elements consistent across the whole video (e.g., a persistent logo or a background grid), which are not content elements.
- Blind spot: cannot judge whether an unreferenced element still helps orientation (e.g., a recurring map/legend); flags presence, not necessarily true irrelevance.

### CRAFT-06 — Visual style inconsistent across segments covering similar content
- Rule: It is a defect-candidate (craft) when the palette, typography, or iconography used for the same kind of content (e.g., all "warning" callouts, all data labels) changes without an apparent reason across segments.
- Class: craft
- Defect-eligible: no.
- Pass: 2
- Tag & source: [PRACTICE] user-supplied checklist (unsourced) — a general style-consistency concern loosely related to the checklist's "layer in multimedia ... maintain high visual engagement" bullet; not substantiated by any fetched source (see Sources).
- Inputs used: storyboard, stills.
- Check procedure: 1) Sample stills/storyboard across segments. 2) Group visual elements by role (e.g., "callout," "metric," "step label"). 3) Judge whether elements of the same role are styled consistently; record inconsistencies as a craft note.
- Evidence to cite: two or more still filenames/storyboard element ids showing the same role styled differently.
- Not a defect: a deliberate style change marking a distinct chapter or mode shift (e.g., a "before/after" contrast).
- Blind spot: cannot judge whether a style choice is aesthetically good, only whether it is applied consistently.

### CRAFT-07 — No clear focal point in a still
- Rule: It is a defect-candidate (craft) when a rendered still has no single element that reads as the primary focus, leaving the eye with no place to land first.
- Class: craft
- Defect-eligible: no.
- Pass: 2
- Tag & source: [PRACTICE] user-supplied checklist (unsourced) — general layout/composition concern; not substantiated by any fetched source (see Sources).
- Inputs used: stills, storyboard.
- Check procedure: 1) Look at each sampled still as a whole composition. 2) Judge whether one element (size, position, contrast, or motion state) reads as dominant. 3) Record as a craft note if the composition appears flat/uniform with no evident focal hierarchy.
- Evidence to cite: the still filename in question.
- Not a defect: a deliberately symmetrical/comparison layout (e.g., two equally weighted panels being compared) where "no single focal point" is the intended reading.
- Blind spot: this is a purely compositional judgement from a static image; cannot account for the still's context in motion (what came immediately before/after).

### OBJ-19 — One element drawn across another
- Rule: It is a defect when one element is drawn across another that it does not join or belong to (an edge passing under or over a box that is not one of its two ends, an arrowhead or a label hidden by another element, or one box overlapping another), as a still shows it or, where the still cannot settle it, as the storyboard's coordinates place it.
- Class: objective
- Defect-eligible: yes — tests the video against itself: the storyboard declares which elements connect and which stand apart, so a still that draws one across another shows a connection, or hides content, that the video's own structure does not have.
- Pass: 2
- Tag & source: [HOUSE] the user's own review of the EvalLoopDemo renders: R6-13, an edge drawn straight through a box in the `loop` diagram, reported as "the diagrams are overlapping and hard to read" (ADR 0006). No fetched source states this rule. It is fitted to that report and has not been tested on a fresh round; see "Fitted, not yet tested". Boundary: it judges whether elements are drawn across each other, not whether the spacing is generous; spacing the user would like looser is craft.
- Inputs used: stills, storyboard.
- Check procedure: 1) In each still, look for an element drawn across another: a line that runs under or across a box it neither starts nor ends at, an arrowhead or a label partly covered by another element, or two boxes overlapping. 2) For a diagram, check the storyboard too: its `line` and `rect` coordinates show whether an edge's straight path enters a box other than its two ends, and whether two boxes' rectangles intersect; its edges say which boxes each edge joins. 3) Flag a defect when the still shows a crossing. When the still cannot settle it, because it is unclear or an element involved is not on screen at the still's moment, flag a defect when the storyboard's coordinates place one. When the still clearly shows the elements apart, the still decides.
- Evidence to cite: the still's filename; as QUOTE, the on-screen label of an element involved, verbatim from the storyboard; and, for a diagram, the storyboard coordinates of the crossing.
- Not a defect: an element designed to sit over another, such as a callout, a highlight or emphasis ring, a step badge on its box, an edge label on its own edge, a container and what it holds, or a lower third over footage; an edge meeting the boxes at its own two ends; two edges crossing each other where both stay traceable and nothing is hidden.
- Blind spot: there is one still per segment, taken late in its window (at 86 % of it, as `preview` takes it), so a crossing that resolves before that moment is invisible, and an element revealed after it is not in the still at all. For a diagram, the storyboard's coordinates give the final layout whatever the timing, but not motion, such as an element crossing another as it slides in; a slide that is not a diagram has no coordinates, so only its still can show a crossing. The coordinates describe square boxes, while the boxes are drawn with rounded corners, so a line that clips only a rounded-off corner shows in the coordinates and not in the still.

### OBJ-12 — Meaning conveyed by color alone
- Rule: It is a defect when color is the only visual means of distinguishing or conveying information (e.g., "the red path is the failure case") with no redundant non-color cue (label, icon, pattern, position).
- Class: objective
- Defect-eligible: yes — objective presence/absence check against a VERIFIED W3C standard.
- Pass: 2
- Tag & source: [VERIFIED] W3C WAI, WCAG 2.2, Success Criterion 1.4.1 Use of Color (Level A). https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html — requirement: color must not be the only visual means of conveying information, indicating an action, prompting a response, or distinguishing a visual element. Boundary: distinct from contrast, whether colors are perceptible enough against their background, which the engine measures for text (ENG-03) and not for graphics (ENG-11); this rule instead checks for a redundant non-color encoding of meaning, an orthogonal requirement.
- Inputs used: storyboard, stills.
- Check procedure: 1) Identify any place where color distinguishes categories/states (e.g., red vs. green paths, colored status dots). 2) Check whether a non-color cue (text label, icon, line pattern, shape, position) also conveys the same distinction. 3) Flag a defect if color is the sole differentiator.
- Evidence to cite: the still filename/storyboard element id and a description of the color-only distinction.
- Not a defect: color used purely decoratively/for brand consistency, where no information is being conveyed by the color choice itself.
- Blind spot: cannot assess whether a colorblind viewer would actually be confused in practice, only whether a redundant cue exists on paper.

### OBJ-13 — Essential meaning conveyed by shape, position, or sound alone
- Rule: It is a defect when instructions or meaning depend solely on a visual element's shape, size, visual location, or on a sound cue, with no text alternative (e.g., "the item on the right" with no other identifying label).
- Class: objective
- Defect-eligible: yes — objective presence/absence check against a VERIFIED W3C standard.
- Pass: 2 — not pass 1: whether the element carries a text label cannot be checked before there is a storyboard.
- Tag & source: [VERIFIED] W3C WAI, WCAG 2.2, Success Criterion 1.3.3 Sensory Characteristics (Level A). https://www.w3.org/WAI/WCAG22/Understanding/sensory-characteristics.html — requirement: instructions for understanding/operating content must not rely solely on sensory characteristics such as shape, visual location, orientation, or sound. Boundary: for a narrated, non-interactive video, this most often shows up as narration that identifies an element only by position ("the box on the left") or shape ("the round icon") with no name/label given anywhere.
- Inputs used: script, storyboard, stills.
- Check procedure: 1) Scan the narration for identifying phrases based only on position, shape, size, or sound. 2) Check whether the referenced element also carries a text label or is named in the narration itself. 3) Flag a defect if position/shape/sound is the only identifier given anywhere.
- Evidence to cite: the quoted narration phrase, segment id/timestamp, and confirmation no text label/name exists for that element.
- Not a defect: positional language used in addition to a name or label ("the round icon, labeled retry, on the left").
- Blind spot: cannot verify whether a screen-reader user would actually be able to follow along; checks presence of a text identifier, not full assistive-technology usability.

### OBJ-14 — Subtitle/caption placement obscures essential on-screen content
- Rule: It is a defect when the region where subtitles/captions render overlaps a visual element carrying information the narration does not otherwise state (e.g., a label, number, or diagram detail).
- Class: objective
- Defect-eligible: no — its caption band is a convention no source gives: the WCAG 2.2 text it cites says only that captions "should not obscure or obstruct relevant information in the video", and no input says where the player will place subtitles.
- Pass: 2
- Tag & source: [VERIFIED] W3C WAI, WCAG 2.2, Success Criterion 1.2.2 Captions (Prerecorded) (Level A), Understanding page note on caption placement. https://www.w3.org/WAI/WCAG22/Understanding/captions-prerecorded.html — guidance: captions should not obscure important information in the video, distinct from the caption text's own line width and reading speed (ENG-13: measured by the engine, never enforced), which govern the caption text itself, not what it covers on screen. Boundary: this check is about the caption-safe area colliding with content, not about caption wording or timing.
- Inputs used: storyboard, stills, timing (subtitle region if specified).
- Check procedure: 1) Identify the screen region reserved for subtitles/captions (typically a lower-third band). 2) For each still, check whether any essential visual element (a label, number, or diagram detail not otherwise stated in narration) falls within that band. 3) Flag a defect on any such overlap.
- Evidence to cite: the still filename; the overlapping element's description and position.
- Not a defect: decorative background elements in the caption-safe area, or essential elements also fully restated in the narration (so losing sight of them briefly costs nothing).
- Blind spot: cannot see the actual rendered caption box at that instant if caption position is computed later in the pipeline; flags only elements placed in the conventional caption-safe band.

### OBJ-15 — Visual-only information has no spoken equivalent
- Rule: It is a gap to report as advice, not a defect, when a visual conveys information essential to understanding the segment (a value, a relationship, a state change) that is not spoken in the narration, and no separate text alternative to the video is supplied; on-screen text is part of the visual.
- Class: objective
- Defect-eligible: no — by the user's ruling of 2026-10-06, it detects the gap WCAG describes and reports it as advice, in ADVISORY, rather than as a defect; its procedure also needs a judgement of which facts are essential.
- Pass: 2
- Tag & source: [VERIFIED] W3C WAI, WCAG 2.2, Success Criterion 1.2.3 Audio Description or Media Alternative (Prerecorded) (Level A). https://www.w3.org/WAI/WCAG22/Understanding/audio-description-or-media-alternative-prerecorded.html — requirement: an alternative must give equivalent information to what sighted, hearing viewers get, for any essential visual information not already carried by the audio track. Boundary: the standard's usual remedy (a separate audio-description track) is a later production stage; this rubric checks the cheaper, earlier fix available at storyboard time — whether the script already states the essential visual information in words, sufficient to satisfy the intent without a separate track.
- Inputs used: script, brief, storyboard, stills.
- Check procedure: 1) For each segment, list the essential facts a visual conveys (a comparison, a resulting value, a state change). 2) For each, check whether the narration states it in words. 3) Check whether a separate text alternative to the video is supplied: only the brief can say so, and on-screen text, being part of the visual, never is one. 4) Report the gap, as advice, where the visual is the sole carrier of an essential fact.
- Evidence to cite: the still's filename or the storyboard element's id, and the essential fact it alone conveys; as QUOTE, that element's label or on-screen text, verbatim from the storyboard; and confirmation that the segment's narration omits the fact.
- Not a defect: purely illustrative/decorative motion that does not carry a distinct fact beyond what narration already states.
- Blind spot: cannot judge how much visual nuance is "essential" versus merely illustrative; relies on reviewer judgement of what counts as essential information. It treats on-screen text as WCAG does, as visual content: WCAG 2.2's definition of audio description lists "on-screen text" among the visual content to be described (Note 1), and needs no description only "where all of the video information is already provided in existing audio" (Note 3). So an essential fact shown only as on-screen text is reported, as advice. It cannot see a separate text alternative unless the brief names one.

### OBJ-16 — Flashing content risk
- Rule: It is a defect when any visual element flashes (rapid alternation between light and dark, or rapid color change) more than three times in any one-second period.
- Class: objective
- Defect-eligible: no — it counts flashes from the storyboard's animation timing, which the storyboard does not carry, and its area condition cannot be checked, as its blind spot says; it cannot run as written.
- Pass: none — NOT EVALUATED at either pass: it needs animation timing, which no input carries.
- Tag & source: [VERIFIED] W3C WAI, WCAG 2.2, Success Criterion 2.3.1 Three Flashes or Below Threshold (Level A). https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html — requirement: content does not contain anything that flashes more than three times in any one-second period, or the flash is below the general/red flash thresholds. Boundary: this is a hard safety threshold (photosensitive seizure risk), not a taste judgement — applies regardless of audience expertise or pacing.
- Inputs used: storyboard (animation timing), stills, timing.
- Check procedure: 1) Identify any animated element with rapid, repeated, high-contrast state changes (blinking alerts, strobing highlights). 2) Count transitions within any rolling one-second window from the storyboard's declared animation timing. 3) Flag a defect if the count exceeds three flashes per second and the element is large enough to matter (per the SC's area threshold), or the flash content type cannot be ruled safe.
- Evidence to cite: the storyboard element id, its animation timing definition, and the computed flash count in the relevant one-second window.
- Not a defect: a single state change (e.g., one color change on trigger) or slow pulsing well under three cycles per second.
- Blind spot: cannot verify actual rendered luminance/contrast of a flash (only declared animation timing), and cannot check the SC's precise area-of-screen threshold without knowing final render dimensions.

### CRAFT-08 — No variation in segment rhythm across the runtime
- Rule: It is a defect-candidate (craft) when every segment runs roughly the same duration with no faster or slower stretches, producing a metronomic rhythm across the whole video.
- Class: craft
- Defect-eligible: no.
- Pass: 2
- Tag & source: [PRACTICE] user-supplied checklist (unsourced) — "pace your delivery" bullet, applied here to segment-level rhythm rather than sentence-level wording (see CRAFT-05); not substantiated by any fetched source (see Sources).
- Inputs used: timing (segment start/end durations).
- Check procedure: 1) List every segment's duration from the timing file. 2) Judge whether durations are suspiciously uniform (little variation) across the whole runtime, versus varying with content density/importance. 3) Record as a craft note.
- Evidence to cite: the list of segment ids and durations.
- Not a defect: intentionally even pacing for a series of parallel, equally-weighted examples.
- Blind spot: duration alone does not capture perceived pace (motion speed, word density); this is a coarse proxy only.

### CRAFT-09 — Runtime devoted to a point disproportionate to its importance
- Rule: It is a defect-candidate (craft) when a segment's duration is clearly out of proportion to the importance the brief assigns to that point (a minor caveat gets as much time as the core mechanism).
- Class: craft
- Defect-eligible: no.
- Pass: both — pass 1 compares script length; pass 2 adds the timing file's durations
- Tag & source: [PRACTICE] user-supplied checklist (unsourced) — general editorial-proportion concern; not substantiated by any fetched source (see Sources).
- Inputs used: brief, script; at pass 2 also timing (segment durations).
- Check procedure: 1) Rank segments/points by the importance the brief assigns them. 2) Compare relative script length (Pass 1) or duration (Pass 2). 3) Record as a craft note wherever a minor point clearly outweighs a major one in time given.
- Evidence to cite: the two segment ids being compared, their durations/lengths, and the brief's stated relative importance.
- Not a defect: a short but critical point that is short precisely because it needs no elaboration (a one-line key takeaway).
- Blind spot: "importance" is itself the brief author's judgement, which this check cannot independently verify.

### OBJ-17 — New named concepts introduced faster than a comfortable rate
- Rule: It is a defect when a burst of new named technical terms/concepts appears within a short span of narration with no definition, example, or restatement attached to any of them.
- Class: objective (a countable pattern: number of undefined new terms in a window) though the "how many is too many" threshold is unsourced.
- Defect-eligible: no — the counting procedure is objective, but no fetched source gives a specific rate/count threshold for this exact pattern, so per "no threshold without a source" this stays advisory (judgement).
- Pass: both
- Tag & source: [PRACTICE] user-supplied checklist (unsourced) — reflects the checklist's "pick a focused topic" / "modular sections" concern about not overloading a single stretch with too much new material; conceptually adjacent to working-memory capacity limits (cf. Cowan, 2001, cited under OBJ-11) but that source bounds simultaneous holding capacity, not the rate of introducing new terms over time, so its number is not reused here.
- Inputs used: script; at pass 2 also timing, to bound the "short span" in seconds.
- Check procedure: 1) List every new named technical term/concept as it first appears in the script, in order. 2) Identify any run where several such terms appear close together (same sentence or adjacent sentences/segment) with none of them given a definition, example, or restatement nearby. 3) Record as a craft-adjacent objective note — flag the run, but do not assign a hard pass/fail count since no source specifies one.
- Evidence to cite: the segment id, the list of new terms in the flagged run, and their position (sentence order or timestamp).
- Not a defect: a deliberate list/enumeration where the point is exactly to name several related things together (e.g., "the four steps are X, Y, Z, W" followed by explaining each in turn).
- Blind spot: cannot measure the viewer's actual cognitive load; "no definition nearby" is judged from the same script window only, so a definition given much later in the video is not credited.

### OBJ-18 — Redundant re-explanation of material already established for this audience
- Rule: It is a defect when the script re-explains, in full, a concept the brief already identifies as known to the target audience, or that the script itself already explained earlier without new information being added.
- Class: objective — self-test (script vs brief; script vs itself).
- Defect-eligible: yes — self-test under clause (b); a stated-audience contradiction or a verbatim/near-verbatim repeat is wrong under any taste.
- Pass: both — primarily pass 1; pass 2 checks the script again as it then stands
- Tag & source: [VERIFIED] Kalyuga, S., Ayres, P., Chandler, P., & Sweller, J. (2003). The expertise reversal effect. Educational Psychologist, 38(1), 23-31. https://doi.org/10.1207/S15326985EP3801_4 (fetched abstract) — finding: instructional support (elaboration, redundant explanation) that helps novices can measurably hurt higher-knowledge learners' performance, because processing already-redundant material consumes working-memory capacity without adding information. Boundary: this rubric's audience is "experienced engineers" per the brief, and the video is system-paced (viewer cannot skip a redundant passage the way a reader skims a paragraph), which makes an unnecessary re-explanation costlier here than in learner-paced self-study text — reinforcing rather than weakening the case for flagging it.
- Inputs used: brief, script.
- Check procedure: 1) From the brief, list what the target audience is already assumed to know. 2) Scan the script for a full re-explanation of any such item, or for near-identical explanatory text repeated for the same concept later in the script without new information. 3) Flag both as defects.
- Evidence to cite: the brief's stated audience assumption or the earlier segment id/quote, plus the segment id/quote of the redundant re-explanation.
- Not a defect: a brief recap line that explicitly ties a prior concept to a new one ("as we saw with X, the same limit applies to Y") — this adds a new connection, not a redundant repeat.
- Blind spot: cannot judge whether a repeated explanation is pedagogically deliberate (spaced repetition for retention) versus wasteful; treats any full duplicate as a defect regardless of intent.

## Practitioner checklist disposition

The user-supplied checklist was checked bullet-by-bullet against its own cited sources. Result: none of the four fetched non-video sources (esteem.nd.edu; thecrashcourse.com/creator-lab; academyforvirtualteaching.com; indie-film-making.com) state the specific claim attributed to them in the checklist — Crash Course's own page describes a four-unit creator course (research, script, revise, produce), not these bullet-level rules. The eight YouTube links could not be fetched as readable text and so are not verified sources. Every bullet below is tagged [PRACTICE] "user-supplied checklist (unsourced)" unless marked otherwise.

**1. Research and Outline**
- Pick a focused topic — [PRACTICE] unsourced (cited esteem.nd.edu and Crash Course Creator Lab do not state this). — OBJ-01 (topic-scope self-test).
- Write a strong hook — [PRACTICE] unsourced (same two sources checked; neither specifies hook technique). — CRAFT-01 (craft judgement, not defect-eligible).
- Organize into modular sections (three to four sub-topics) — [PRACTICE] unsourced; the specific "three to four" count appears in neither fetched source. — OBJ-02 (structure self-test; the numeric "three to four" is not adopted as a threshold since unsourced). OBJ-02 cannot run on these inputs (see "Carried by no input"), so no rule here carries this bullet.

**2. Write the Script**
- Keep the tone conversational (humor, analogies) — [PRACTICE] unsourced (YouTube sources unfetchable). — CRAFT-03/CRAFT-04. See Conflicts: analogies/humor aimed at a general audience can add extraneous load for expert viewers (Kalyuga et al., 2003).
- Pace your delivery (energetic, fast, with emphasis) — [PRACTICE] unsourced (YouTube sources unfetchable). — CRAFT-05, CRAFT-08. See Conflicts: "fast cadence" in a system-paced video removes the viewer's ability to self-pace, which cognitive-load research treats as a risk factor, not a virtue, for complex material.
- Plan your visuals alongside talking-head footage — [PRACTICE] unsourced (YouTube sources unfetchable); "talking-head footage" itself is Not applicable (no camera, no on-screen presenter in this format). The surviving principle — deliberately plan what visual supports each script beat — is carried by OBJ-04, OBJ-07 and OBJ-08 (Narration and visuals together). OBJ-05 and OBJ-06 belong to the same group but cannot run on these inputs (see "Carried by no input").

**3. Film Your Footage** — the entire section is Not applicable: this format has no camera, no on-location recording, and no presenter to light, frame, or mic.
- Set up clean lighting — Not applicable: no camera or physical set exists.
- Prioritize good audio (quiet room, external mic) — Not applicable as stated (no live recording). The underlying goal (clean, intelligible narration audio) is not a coach rule, and no engine audit measures it either (ENG-14); it is heard at the draft review (NE-08).
- Frame your shots (medium shots, close-ups) — Not applicable: there is no face or body on screen to frame.

**4. Edit and Polish**
- Do a rough cut (import clips, remove pauses/breaths/dead air) — Not applicable as stated: there are no camera clips to import, and synthetic TTS has no breaths. The surviving "avoid dead air" concern is carried by CRAFT-08 (segment rhythm).
- Layer in multimedia for "high visual engagement" — [PRACTICE] unsourced (YouTube sources unfetchable). Direct Conflict with [VERIFIED] research: see Conflicts section and OBJ-11 (seductive-detail defect) — decorative additions purely for engagement are exactly the pattern the cited meta-analysis found to hurt retention.
- Mix your audio (voice above music) — not a coach rule. The engine sets the music's level under speech by its gain and duck, and refuses a duck it cannot deliver (ENG-06), but nothing measures the delivered mix (ENG-14); see the open question on WCAG SC 1.4.7 under Covered by the pipeline.

## Not evaluatable from these inputs

These matter but require listening to real audio, watching real motion, or a full render. The coach must not attempt them and must report each as NOT EVALUATED under its NE ID, naming who checks it.

- **NE-01** Pronunciation of technical terms, acronyms, and proper nouns — the coach can see that a term appears in the script, but cannot hear how the TTS voice actually renders it. Checked by: the user at the draft review.
- **NE-02** Prosody and emphasis — whether the synthetic reading naturally stresses the intended word or phrase, or sounds flat or misplaced. Checked by: the user at the draft review.
- **NE-03** Music bed character and mood fit — genre, tempo, and emotional tone appropriate to the topic; the coach has no audio input at all. Checked by: the user at the draft review.
- **NE-04** Motion smoothness and animation easing — whether a transition feels abrupt, janky, or too fast to track; only a handful of static stills are available, not continuous motion. Checked by: the user at the draft review.
- **NE-05** Perceived pace of the finished piece — how fast the video "feels" when watched straight through, as distinct from the segment-duration proxy a coach can compute from the timing file (CRAFT-08). Checked by: the user at the draft review.
- **NE-06** Voice and persona fit for the material and audience — whether the single synthetic voice's tone suits a technical explainer for experienced engineers. Checked by: the user at the draft review.
- **NE-07** Whether a hook, joke, or analogy actually lands with a real audience — text can be checked for the presence of a hook or analogy (CRAFT-01, CRAFT-03), but whether it is genuinely engaging or funny is a felt response the coach cannot simulate. Checked by: the user at the draft review.
- **NE-08** The audio mix as heard — e.g., a sound effect or music swell that is subjectively distracting, or narration that the music crowds. No engine audit measures the delivered mix's loudness, true peak or music level (ENG-14), so listening is the only check there is. Checked by: the user at the draft review.
- **NE-09** Compression, encoding, and rendering artifacts (banding, aliasing, dropped frames) in the final video file — invisible in pre-render HTML/CSS/SVG storyboards and PNG stills. Checked by: the user at the draft review.
- **NE-10** Whole-video cohesion and rewatchability as a felt, holistic experience — the coach evaluates segments and pairwise consistency, not the gestalt experience of watching start to finish. Checked by: the user at the draft review.

## Conflicts

Two checklist recommendations conflict with a [VERIFIED] source. In both cases, research wins, per the task's authority model.

**1. Conversational tone / fast energetic pacing vs. the expertise-reversal effect**
- Checklist: "Keep the tone conversational... using humor and analogies" and "Pace your delivery: Aim for an energetic, fast cadence" (Write the Script section).
- [VERIFIED]: Kalyuga, S., Ayres, P., Chandler, P., & Sweller, J. (2003). The expertise reversal effect. Educational Psychologist, 38(1), 23-31. https://doi.org/10.1207/S15326985EP3801_4 — finding: instructional elaboration (extra explanation, analogy, redundant framing) that helps novices can measurably hurt higher-knowledge learners, because processing already-known or loosely-mapped material consumes working-memory capacity without adding information.
- Resolution: for this audience (experienced engineers, per the brief) and this format (system-paced: the viewer cannot slow the video down the way a reader can re-read a sentence), a fast, joke- and analogy-dense conversational style is not adopted as a goal. The rubric keeps a narrower, sourced version of "conversational" (plain, direct sentences; see CRAFT-03/CRAFT-04) but treats "fast energetic cadence" and "humor/analogy for its own sake" as a craft option the author may choose, never a defect the coach checks for, and explicitly not a virtue to reward. Where an analogy or aside is not tied to a needed distinction and adds length without new information, it falls under OBJ-18 (redundant re-explanation) instead.

**2. "High visual engagement" via B-roll/stock footage/pop-up graphics vs. the seductive-detail effect**
- Checklist: "Layer in multimedia: Add relevant B-roll, stock footage, pop-up text graphics, and background music to maintain high visual engagement" (Edit and Polish section).
- [VERIFIED]: Rey, G. D. (2012). A review of research and a meta-analysis of the seductive detail effect. Educational Research Review, 7(3), 216-237. https://doi.org/10.1016/j.edurev.2012.05.003 — finding: across the reviewed studies, interesting-but-irrelevant additions (decorative graphics, tangential anecdotes) reliably reduced retention/transfer test performance versus a version without them, even though they may raise subjective interest; the effect held across delivery formats.
- Resolution: "maintain high visual engagement" is not adopted as a rubric goal. Decorative elements that do not carry information relevant to the segment's point are treated as a defect risk (OBJ-11), not a quality signal. This does not ban all illustrative motion; it bans engagement-only additions that compete with the segment's actual point for attention.

## Covered by the pipeline

Rebuilt at graduation against the engine as it stands at `fe03a88`, under one rule: **a lane counts as covered only if its audit has been seen to fail on known-bad input.** An audit that has never failed is an untested claim of coverage, and worse than none, because listing it tells the coach not to look where nobody is looking. The engine's WCAG contrast audit had never fired until someone checked (finding C-14, fixed in `a0add0b`). The brief this rubric was written from called five lanes covered, and said the pipeline fails builds on all of them. Checked, most were not. The backtest's coach, told they were covered, reported overlapping visual events as owned by an audit that does not exist.

Every lane goes in NOT EVALUATED on every pass, citing its ID, with `covered by:` its Owner.

- **covered**: the engine owns it, so the coach does not re-check it. The Owner says when the audit only logs what it finds and the render continues.
- **not run**: the audit exists and has been seen to fail, but no stage of the demo pipeline runs it, so it covers nothing yet.
- **not covered**: no audit, or one that has never been seen to fail.

For a lane that is not covered, or not run, the Owner names any rule that reaches it. The coach evaluates that rule as usual.

**Open question for the pipeline (not a coach rule):** [VERIFIED] W3C WAI, WCAG 2.2, Success Criterion 1.4.7 Low or No Background Audio (Level AAA). https://www.w3.org/WAI/WCAG22/Understanding/low-or-no-background-audio.html — quantified threshold: background sound should be at least 20 dB lower than foreground speech (roughly four times quieter), with brief exceptions of a second or two. This SC is written for audio-only content and is Level AAA, so it does not directly bind this video format, but it is the only sourced numeric bound this research pass found for "how much quieter must music be than speech." The engine has no check of the music's level under speech to compare it with: that level is set by the music's gain and duck (ENG-06) and is not measured in the mix (ENG-14). Whether those settings put a project's music 20 dB under its narration is not verified here — an open question for whoever owns the mix targets, not adopted as a rubric rule.

### ENG-01 — A code block clipping its own content
- Status: covered
- Audit: the scene's `auditLayout`, reason `codeblock-clipped`, run by `preview` on each segment's still (its transcript is pass 2's audit input) and by `frame-capture` at each segment's start.
- On failure: `preview` exits 1; `frame-capture` stops the render (read in its source, not seen). `preview` prints the whole scene's issues under every segment it previews, so the slide at fault is the one in the issue's own `id`, not the segment it is printed under.
- Seen to fail: test `auditLayout_codeblockTallerThanItsPanel_reportsTheClippedBlock` builds a real scene whose code block hides over 100 px and asserts the audit reports that block and only it; test `preview_layoutIssuesFound_exitsNonZeroLikeCaptureDoes` shows `preview` exits 1 on a non-empty audit, with a stand-in audit.
- Owner: engine: `auditLayout`, in `preview` and `frame-capture`

### ENG-02 — A slide whose safe area still overflows after fitting
- Status: covered
- Audit: `auditLayout`, reason `overflow-after-fit`, once the layout has shrunk the slide's content to its floor (fit 0.6); the same stages as ENG-01.
- On failure: as ENG-01.
- Seen to fail: once, by hand, at `fe03a88`, not by a test: a real scene whose title and subtitle overflow at that floor made `preview --apply` exit 1, reporting `overflow-after-fit` for that slide. No committed test pins it, so it could stop firing unnoticed, as C-14's contrast audit once did.
- Owner: engine: `auditLayout`, in `preview` and `frame-capture`

### ENG-03 — Text contrast below WCAG AA (4.5:1, or 3:1 for large text)
- Status: covered
- Audit: the scene's `auditLegibility`, reasons `low-contrast` and `contrast-unverified`, run by `frame-capture` at each segment's start. `preview` does not run it, so its findings are not in pass 2's audit input.
- On failure: logged as an advisory, and the render continues (read in `frame-capture`'s source). Nothing stops.
- Seen to fail: tests `auditLegibility_nearBlackTitleOnBlackStage_flagsLowContrast`, `auditLegibility_pairBetween3And4point5To1_flagsBodyTextButNotALargeTitle` and `auditLegibility_ratioJustUnderTheThreshold_reportsARatioBelowTheNeed` build real scenes and assert the audit flags them, since C-14 was fixed.
- Owner: engine: `auditLegibility` in `frame-capture`, an advisory log that stops nothing

### ENG-04 — Rendered text below the minimum size
- Status: covered
- Audit: `auditLegibility`, reason `text-too-small`: text smaller than 1.4 % of the stage's height, or than 14 px where that is larger; `frame-capture` only.
- On failure: logged as an advisory; nothing stops.
- Seen to fail: once, by hand, at `fe03a88`, not by a test: 6 px body text on a 720 px stage was reported as `text-too-small` against a 14 px minimum. No committed test pins it.
- Owner: engine: `auditLegibility` in `frame-capture`, an advisory log that stops nothing

### ENG-05 — A narration track that drifts from the timeline
- Status: covered
- Audit: `remix`'s voice-drift check (C-6), which compares the rebuilt voice track with the reflowed timeline's duration before anything is published.
- On failure: `remix --apply` exits 1 and publishes nothing.
- Seen to fail: tests `remix_applyWhoseVoiceTrackDriftsFromTheTimeline_publishesNothing` and `remix_applyWhoseVoiceTrackDriftsWhereTheVoiceStageWouldRefuse_saysWhyRatherThanSendingThere`.
- Owner: engine: `remix`'s voice-drift check

### ENG-06 — A music duck the bed cannot deliver
- Status: covered
- Audit: the duck's threshold solve, which turns the depth a project asks for under speech into a threshold for the measured narration.
- On failure: refused, naming the depth that can be reached.
- Seen to fail: tests `calibrateDuckThreshold_depthDeeperThanTheThresholdFloorAllows_refusesNamingTheReachableMaximum`, `calibrateDuckThreshold_narrationBelowTheThresholdFloor_refusesRatherThanClamping` and `calibrateDuckThreshold_depthShallowerThanTheThresholdCeilingAllows_refusesNamingTheMinimum`. This covers the duck that was asked for, not the music's level in the delivered mix (ENG-14).
- Owner: engine: the duck's threshold solve

### ENG-07 — A diagram node outside its viewBox, which renders clipped
- Status: not run
- Audit: `validate-scene` check B2.
- On failure: `validate-scene` would exit 1, but the demo-recording skill does not run it; neither its SKILL.md nor its pipeline contract names `validate-scene`.
- Seen to fail: tests `B2_nodeOverflowingItsViewBox_isRefused` and `B2_nodeOutsideANonZeroOriginViewBox_isRefused`.
- Owner: nobody, until the skill runs `validate-scene` before capture; a clipped node may still show in a still

### ENG-08 — Two diagram nodes overlapping
- Status: not run
- Audit: `validate-scene` check B3. Boxes that only touch are not overlap.
- On failure: as ENG-07: it would exit 1, but nothing runs it.
- Seen to fail: test `B3_overlappingNodes_isRefused`, with `B3_nodesTouchingAtTheEdge_isNotRefused` as its negative control.
- Owner: pass 2, where OBJ-19 reaches it

### ENG-09 — An element clipped by its container, or hidden under another
- Status: not covered
- Audit: none. `auditLayout` checks only a slide's safe area (ENG-02) and its code blocks (ENG-01), not an arrowhead under a box, a node's label cut off by its box, or one card over another.
- On failure: nothing runs.
- Seen to fail: never. In the backtest's r1, the arrowheads in `hard` were hidden under neighbouring boxes and the layout audit reported no issue.
- Owner: pass 2, where OBJ-19 reaches an element hidden under another; clipping by a container is caught only when a still happens to show it

### ENG-10 — Content outside the video frame
- Status: not covered
- Audit: `frame-capture` refuses a scene built for a different frame size from the one it captures.
- On failure: `frame-capture` would stop the render.
- Seen to fail: never; no test or recorded run has seen that check fail.
- Owner: nobody

### ENG-11 — Contrast of graphics against their background (3:1)
- Status: not covered
- Audit: none. `auditLegibility` reads text only.
- On failure: nothing runs.
- Seen to fail: never; it is not measured.
- Owner: nobody

### ENG-12 — Visual events overlapping in time within a segment
- Status: not covered
- Audit: none. `validate-timing` and `validate-scene` (C1) compare segments with each other, not the events within one.
- On failure: nothing runs.
- Seen to fail: never; no audit exists.
- Owner: nobody

### ENG-13 — Subtitle line width and reading speed (by default 42 characters a line, 20 characters a second)
- Status: not covered
- Audit: `write-subtitles` measures both and prints them in its summary.
- On failure: nothing; it exits 0 whatever they are.
- Seen to fail: never; it does not fail on either, and no test has seen it report either limit exceeded.
- Owner: nobody

### ENG-14 — Loudness, true peak and the music's level in the delivered mix
- Status: not covered
- Audit: none that fails. No stage measures integrated loudness or true peak; `check-levels` reports RMS and peak levels and fails only when it cannot measure. The music's level under speech is set by its gain and duck (ENG-06), not measured in the mix.
- On failure: nothing runs.
- Seen to fail: never.
- Owner: nobody; the user hears the mix at the draft review (NE-08), which measures nothing

### ENG-15 — Audio and video drift in the encoded file
- Status: not covered
- Audit: `encode-mp4` refuses a drift beyond its budget.
- On failure: `encode-mp4` would stop.
- Seen to fail: never. EvalLoopDemo's render log records it passing, at 1,009 and 1,016 ms against a 1,500 ms gate, and no test feeds it a drift.
- Owner: nobody

## [HOUSE]

The user's own judgements, from their reviews of their own videos. This section was empty until the backtest completed. It now holds two rules, both fitted to the reports they come from and not yet tested on a fresh round (see "Fitted, not yet tested"):

- OBJ-07's spoken-moment test and its 1.5 s tolerance, from R2-06 and R6-10, which the user reported, and the shipped cut, which the user accepted.
- OBJ-19, from R6-13.

No preference has been added. Both came in on the user's word, in the coach-graduation plan approved on 2026-09-30.

It also records one ruling. OBJ-15's findings are advice, not defects, by the user's word on 2026-10-06. What OBJ-15 detects follows WCAG, its [VERIFIED] source; only how its findings are reported is the user's.

## Sources

**W3C standards and WAI guidance (fetched):**
1. WCAG 2.2 SC 1.2.2 Captions (Prerecorded) — https://www.w3.org/WAI/WCAG22/Understanding/captions-prerecorded.html — fetched.
2. WCAG 2.2 SC 1.2.3 Audio Description or Media Alternative (Prerecorded) — https://www.w3.org/WAI/WCAG22/Understanding/audio-description-or-media-alternative-prerecorded.html — fetched.
3. WCAG 2.2 SC 1.3.3 Sensory Characteristics — https://www.w3.org/WAI/WCAG22/Understanding/sensory-characteristics.html — fetched.
4. WCAG 2.2 SC 1.4.1 Use of Color — https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html — fetched.
5. WCAG 2.2 SC 1.4.7 Low or No Background Audio — https://www.w3.org/WAI/WCAG22/Understanding/low-or-no-background-audio.html — fetched.
6. WCAG 2.2 SC 2.3.1 Three Flashes or Below Threshold — https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html — fetched.
7. W3C WAI, Media Accessibility overview — https://www.w3.org/WAI/media/av/ — fetched.
8. W3C WAI, Media Accessibility: content types — https://www.w3.org/WAI/media/av/av-content/ — fetched.
9. W3C WAI, Audio Description — https://www.w3.org/WAI/media/av/description/ — fetched.
10. W3C WAI, Captions/Subtitles — https://www.w3.org/WAI/media/av/captions/ — fetched.

**Peer-reviewed research (fetched):**
11. Cowan, N. (2001). The magical number 4 in short-term memory. Behavioral and Brain Sciences, 24(1), 87-114. https://doi.org/10.1017/S0140525X01003922 — fetched (abstract).
12. Richter, J., Scheiter, K., & Eitel, A. (2016). Signaling text-picture relations in multimedia learning: A comprehensive meta-analysis. Educational Research Review, 17, 19-36. https://doi.org/10.1016/j.edurev.2015.12.003 — fetched (abstract).
13. Rey, G. D. (2012). A review of research and a meta-analysis of the seductive detail effect. Educational Research Review, 7(3), 216-237. https://doi.org/10.1016/j.edurev.2012.05.003 — fetched (abstract).
14. Craig, S. D., & Schroeder, N. L. (2017). Reconsidering the voice effect when learning from a virtual human. Computers & Education, 114, 193-205. https://doi.org/10.1016/j.compedu.2017.07.003 — fetched (abstract).
15. Kalyuga, S., Ayres, P., Chandler, P., & Sweller, J. (2003). The expertise reversal effect. Educational Psychologist, 38(1), 23-31. https://doi.org/10.1207/S15326985EP3801_4 — fetched (abstract).

**Peer-reviewed research identified but NOT fetched (excluded from all rule citations):**
16. Mayer, R. E., & Moreno, R. (2003). Nine ways to reduce cognitive load in multimedia learning. Educational Psychologist, 38(1), 43-52. — not fetched.
17. Ginns, P. (2006). Integrating information: A meta-analysis of the spatial contiguity and temporal contiguity effects. Learning and Instruction, 16(6), 511-525. — not fetched.
18. Mayer, R. E., & Johnson, C. I. (2008). Revising the redundancy principle in multimedia learning. Journal of Educational Psychology, 100(2), 380-386. — not fetched.
19. Mayer, R. E., Sobko, K., & Mautone, P. D. (2003). Social cues in multimedia learning: Role of speaker's voice. Journal of Educational Psychology, 95(2), 419-425. — not fetched.
20. Schroeder, N. L., & Cenkci, A. T. (2018). Spatial contiguity and spatial split-attention effects in multimedia learning environments: A meta-analysis. Educational Psychology Review, 30(3), 679-701. — not fetched.
21. Sweller, J., van Merriënboer, J. J. G., & Paas, F. (2019). Cognitive architecture and instructional design: 20 years later. Educational Psychology Review, 31(2), 261-292. — not fetched.

**User-supplied checklist links:**
22. https://esteem.nd.edu/news/7-step-guide-to-creating-online-video-courses/ — fetched; does not state the attributed claims.
23. https://thecrashcourse.com/creator-lab/ — fetched; describes a four-unit creator course, not these bullets.
24. https://www.academyforvirtualteaching.com/courses/video-making-crash-course — fetched; does not state the attributed claims.
25. https://www.indie-film-making.com/how-to-make-a-video/ — fetched; does not state the attributed claims.
26. https://www.youtube.com/watch?v=6xk4iUuL4IY&t=200 — not fetched (video content unfetchable).
27. https://www.youtube.com/watch?v=ArBS88h1r2Q — not fetched.
28. https://www.youtube.com/watch?v=8QCK_qEp_PI&t=18 — not fetched.
29. https://www.youtube.com/watch?v=K-FJIc93RqE — not fetched.
30. https://www.youtube.com/watch?v=fDe7G8Tz6cA&t=7 — not fetched.

## SOURCES CONSULTED

The original author's record, unchanged. The changes made at graduation cite no new outside source.

- https://www.w3.org/WAI/WCAG22/Understanding/captions-prerecorded.html
- https://www.w3.org/WAI/WCAG22/Understanding/audio-description-or-media-alternative-prerecorded.html
- https://www.w3.org/WAI/WCAG22/Understanding/sensory-characteristics.html
- https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html
- https://www.w3.org/WAI/WCAG22/Understanding/low-or-no-background-audio.html
- https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html
- https://www.w3.org/WAI/media/av/
- https://www.w3.org/WAI/media/av/av-content/
- https://www.w3.org/WAI/media/av/description/
- https://www.w3.org/WAI/media/av/captions/
- https://doi.org/10.1017/S0140525X01003922
- https://doi.org/10.1016/j.edurev.2015.12.003
- https://doi.org/10.1016/j.edurev.2012.05.003
- https://doi.org/10.1016/j.compedu.2017.07.003
- https://doi.org/10.1207/S15326985EP3801_4
- https://esteem.nd.edu/news/7-step-guide-to-creating-online-video-courses/
- https://thecrashcourse.com/creator-lab/
- https://www.academyforvirtualteaching.com/courses/video-making-crash-course
- https://www.indie-film-making.com/how-to-make-a-video/

## REPO FILES READ

none

That is the original author's record, and it is true of the body that author wrote. The changes made at graduation were written with the repository open; see below.

## Changes at graduation

The body above is the backtest's rubric at `b3cffb0`, with these changes and no others. They were made in step G1 of the coach-graduation plan that the user approved on 2026-09-30, by a builder who had read the repository, the backtest's answer key and its scoring.

1. **OBJ-07 rewritten.** Its rule text and its check procedure now both test the moment the claim is spoken, against a 1.5 s tolerance selected inside measured bounds. Before, the rule asked whether the visual appeared "anywhere in that segment" while the procedure looked "at that timestamp", and the two disagreed on exactly the defects the backtest missed (ADR 0006).
2. **OBJ-19 added:** one element drawn across another (R6-13, ADR 0006).
3. **The eligibility mark renamed** to defect-eligible, to match the coach's DEFECTS section, in all 27 rules that carried it and in two other places. The backtest's records keep the old name.
4. **"Covered by the pipeline" rebuilt** against the engine at `fe03a88`, with an ID for each lane. Every other place that called a lane covered was corrected to match: the boundaries of OBJ-09, OBJ-12 and OBJ-14, two items of the practitioner checklist disposition, NE-08, and the WCAG SC 1.4.7 open question.
5. **Pass values reduced to `1`, `2` or `both`,** the only values the coach acts on. CRAFT-02, CRAFT-09 and OBJ-17 said "1 or 2", and OBJ-18 said "1 (primary), re-checkable in 2 if wording changed". Read literally against the coach's pass scope, "1 or 2" matches no pass; the backtest's coach read the four generously and ran them, which a rubric should not depend on. All four are now `both`, with a note where one said something more.
6. **IDs for not-evaluatable items** (NE-01 to NE-10) and for lanes (ENG-01 to ENG-15), so that a NOT EVALUATED line cites the same ID on every run. Without them, the backtest's coach gave the same three lanes a different label in nearly every report.
7. **The meaning of defect-eligible stated here**, under "About this rubric", from the brief this rubric was written to. Its self-test clause now names the timing and the storyboard's declared structure among the things the video is tested against itself on, which is what makes OBJ-19 defect-eligible.
8. **[HOUSE] filled** with OBJ-07's tolerance and OBJ-19.
9. **"About this rubric", "Fitted, not yet tested"** and this section added, with the notes under SOURCES CONSULTED and REPO FILES READ.
10. **Every rule held to the defect-eligible criterion its own text fails.** Each change is to a rule's status, not to what it detects, and each rule's Defect-eligible field says why in one line.
    - OBJ-02, OBJ-05, OBJ-06, OBJ-10 and OBJ-16 need inputs no stage produces (chapter marks, trigger words, animation timing). They are `Pass: none`, NOT EVALUATED at either pass, and not defect-eligible.
    - OBJ-09 (a "~5-second" window), OBJ-14 (a band "typically" in the lower third) and OBJ-15 ("reviewer judgement" of what is essential) rest on thresholds no source gives. They are no longer defect-eligible, and they still run, as advice.
    - OBJ-03 and OBJ-13 run at pass 2 only, where they had said `both`: their defect turns on the storyboard, which pass 1 lacks.
    - Two items of the practitioner checklist disposition no longer credit rules that cannot run.
11. **"What the inputs carry" and "Carried by no input" added**, and the test now applies the defect-eligible criterion to every rule as far as it can be read mechanically.
12. **OBJ-07's tolerance described as it was set.** Its bounds were measured and its figure selected inside them; it had been called measured outright.
13. **OBJ-15 detects what WCAG describes, and reports it as advice, by the user's ruling of 2026-10-06.** This is the one change at graduation, besides OBJ-07 and OBJ-19, to what a rule detects. It had accepted on-screen text in place of narration, which WCAG treats as visual content to be described, so an essential fact shown only as on-screen text passed it. Now that fact is reported, in ADVISORY: the rule requires the narration to state it, unless the brief names a separate text alternative to the video. Its name no longer says "or on-screen text equivalent".
14. **Inputs split by pass for every rule evaluated at pass 1 that reads more at pass 2.** OBJ-08, CRAFT-09 and OBJ-17 had named pass-2 inputs (storyboard, stills, timing) for pass 1, which has only the script and the brief. They now name those inputs after "at pass 2". OBJ-08 keeps `both`: its defect, the narration contradicting the on-screen text, shows in the script by itself, through its On-screen notes. The backtest's pass-1 run raised one such finding, and the user judged it valid. The test now holds every rule to this pass scope.
15. **Figures checked with their units.** The test had matched a threshold's digits anywhere in its citation, so the last 1 of a criterion such as 1.4.1 could stand in for a "1 s" threshold. A figure is now its number and its unit, and only a figure its source states in that unit counts as sourced.

The body's known slips are left as written. The backtest found them by auditing the rubric against its author's tool log. OBJ-03 and OBJ-10 give the first author of Richter et al. as "T.", where the record says "J.". OBJ-17 says Cowan is cited under OBJ-11, but it is cited under CRAFT-02 and OBJ-09. The source lists mark four papers' DOI pages as fetched, when their abstracts were read from repository records (psycharchives.org, eric.ed.gov, asu.elsevierpure.com and ro.uow.edu.au). The record of Rey (2012) that was fetched gives neither its author nor its journal. Only the first of the six group headings the brief asked for is present.
