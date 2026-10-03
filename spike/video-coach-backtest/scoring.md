# Video-coach backtest: scoring

Written by `src/write-scoring.mjs`. Do not edit it by hand; re-run the script.

It scores the eight coach reports against the committed answer key, using the user's answers to the scoring questions, under the README's "Scoring (defined before results)". Every number here is computed. Every declaration the script relies on is checked, and the checks it passed are listed at the end.

## Result

**The answer is No.** The commit-backed set governs, and it misses the bar: recall 1/3 (33.3 %) is under 50 %.

| Set | Rounds | Recall (BLOCKING) | Recall (any severity) | Precision | Bar |
|---|---|---|---|---|---|
| Commit-backed (governs) | r6, r7 | 1/3 (33.3 %) | 1/3 (33.3 %) | 4/4 (100 %) | not met |
| Reconstructed | r2 | 1/2 (50 %) | 1/2 (50 %) | 2/2 (100 %) | met |
| Pooled | r2, r6, r7 | 2/5 (40 %) | 2/5 (40 %) | 6/6 (100 %) | not met |
| Commit-backed without run 4 | r6, r7 | 1/3 (33.3 %) | 1/3 (33.3 %) | 3/3 (100 %) | not met |

The bar, from the README: recall ≥ 50 % **and** precision ≥ 80 %. The README also says: "If they disagree, the commit-backed result governs."

As this script computes them: an objective item is caught when a BLOCKING finding from its round, in a pass that could see it, was judged to be that item. The user agrees with a BLOCKING finding when they judged it valid or matched it to an item; a false alarm or taste is disagreement. Recall at any severity lets ADVISORY findings catch too.

The sets disagree: the reconstructed set meets the bar, and the commit-backed set misses it. The commit-backed result governs.

The README also says the bar is "pooled over all scored rounds and both passes". Pooled over r2, r6 and r7, the bar is not met, so the answer is the same under either reading.

Run 4 (r6 pass 2) stands under Amendment 9. Without it, the commit-backed set scores recall 1/3 (33.3 %) and precision 3/3 (100 %), keeping every objective item in the denominator. The bar is not met, so the answer does not depend on that run.

| Round | Set | Recall (BLOCKING) | Precision |
|---|---|---|---|
| r2 | reconstructed | 1/2 (50 %) | 2/2 (100 %) |
| r6 | commit-backed | 0/2 (0 %) | 1/1 (100 %) |
| r7 | commit-backed | 1/1 (100 %) | 3/3 (100 %) |

## Objective items

Recall's denominator. r1's two come from `r1-resolution.json` and count toward neither bar.

| Round | Item | Seg | Passes | Route | Lane | Offered in | Caught |
|---|---|---|---|---|---|---|---|
| r2 | R2-06 | 4 `many` | 2 | OBJ-07, through its check procedure (see "Counts") | none | Q1 | no |
| r2 | R2-11 | 7 `blindspot` | 1 and 2 | OBJ-07 (pass 2) | none | Q2 | yes: r2p2B2 (Q2) |
| r6 | R6-10 | 6 `twotier` | 2 | OBJ-07, through its check procedure (see "Counts") | none | never | no |
| r6 | R6-13 | 8 `loop` | 2 | none | none | never | no |
| r7 | R7-01 | 2 `scenario` | 1 and 2 | OBJ-08 (both passes) | none | Q5, Q15, Q18 | yes: r7p2B1 (Q5) |
| r1 | R1-04 | 1 `hard` | 2 | — | row 4 (overflowing or clipped) | Q20 | no |
| r1 | R1-11 | 7 `blindspot` | 1 and 2 | — | none | Q22 | possibly: r1p2B3 (Q22, not judged) |

- R6-10 was never offered as a choice. BLOCKING findings from its passes: r6p2B1 (Q3, unmatched, valid; the question invited typing an item ID).
- R6-13 was never offered as a choice. BLOCKING findings from its passes: r6p2B1 (Q3, unmatched, valid; the question invited typing an item ID).

ID judgments outside the item's round or passes: none.

## BLOCKING findings

Precision counts these. r1's count toward neither bar.

| Run | Finding | Rule | Segments | Judgment | Agreed |
|---|---|---|---|---|---|
| 2 | r2p2B1 | OBJ-08 | `many` | Q1, unmatched, valid | yes |
| 2 | r2p2B2 | OBJ-07 | `blindspot` | Q2, matched R2-11 | yes |
| 4 | r6p2B1 | OBJ-08 | `many` | Q3, unmatched, valid | yes |
| 5 | r7p1B1 | OBJ-08 | `many` | Q4, unmatched, valid | yes |
| 6 | r7p2B1 | OBJ-04 | `scenario` | Q5, matched R7-01 | yes |
| 6 | r7p2B2 | OBJ-04 | `many` | Q4, unmatched, valid | yes |
| 8 | r1p2B1 | OBJ-07 | `hard` | Q20, unmatched, valid | yes |
| 8 | r1p2B2 | OBJ-08 | `many` | Q21, unmatched, valid (asked in error) | yes |
| 8 | r1p2B3 | OBJ-07 | `blindspot` | Q22, a typed answer | not judged |

## Every finding, by run

The coach's words, with its staging directory removed. Not-evaluated lines are shown only where they leave one of the README's engine lanes to the engine.

### Run 1: r2 pass 1

`COUNTS: blocking 0 · advisory 3 · not evaluated 34` · files read: 2

**r2p1A1** · ADVISORY · UNLISTED · `scenario` · family claims · Q6, a typed answer

> [UNLISTED] script.md @ scenario, 0:29–1:20 — The narration calls the showcased scenario “Outlook, on iOS, not receiving email,” but its claim citation names `onedrive-data-loss`. The example's provenance is ambiguous; a viewer may be shown the wrong object. Fix: align the cited scenario id and field references with the actual example before capture.

**r2p1A2** · ADVISORY · UNLISTED · `twotier` · family less-time · Q7, a typed answer

> [UNLISTED] script.md @ twotier, 3:25–3:45 — “the API lane, clears all hundred and sixty-two in less time than that” is presented as a timed comparison against “three runs each — about three and a half minutes,” but the cited API datum is 74 seconds for 75 scenarios, scaled to 162 without a stated three-run measurement. If 74 seconds is one run, linear scaling to three runs is about eight minutes, not less than 3.5. Fix: measure the API's 162-scenario, three-replicate runtime or qualify/remove the faster-than comparison.

**r2p1A3** · ADVISORY · CRAFT-02 · whole video · family craft-02 · Q8, unmatched, false alarm

> [CRAFT-02] script.md @ headings hard, scenario, freeform, many, dimensions, twotier, blindspot, loop (0:01–4:51) — Eight top-level sections in 4:51 have no named chapter grouping; the viewer must hold more transitions than the core argument requires. Fix: group the eight beats under a few named phases without dropping the distinct examples.

Not evaluated, left to the engine:

> [Covered by pipeline 1] Rendered text size and contrast are automated — covered by: engine: text-size/contrast audit.

> [Covered by pipeline 2] Overflow and clipping are automated — covered by: engine: overflow/clipping audit.

> [Covered by pipeline 3] Overlapping visual events are automated — covered by: engine: visual-event-overlap audit.

### Run 2: r2 pass 2

`COUNTS: blocking 2 · advisory 2 · not evaluated 24` · files read: 13

**r2p2B1** · BLOCKING · OBJ-08 · `many` · family count · Q1, unmatched, valid

> [OBJ-08] script.md @ many / stills\many.png — Narration says "three different grades," but the three strips read "grade A," "grade A," "grade B": only two grades differ. Fix: say "different grades across three runs" or show three distinct grades.

**r2p2B2** · BLOCKING · OBJ-07 · `blindspot` · family interface · Q2, matched R2-11

> [OBJ-07] script.md @ blindspot / "Watch" 230734 ms / stills\blindspot.png — "Watch it drive the real U I" promises live interface footage; the storyboard says the clip "has NOT been captured" and substitutes a stage-trace diagram. Fix: capture and approve the UI clip before rendering, or rewrite the line to introduce the diagram rather than footage.

**r2p2A1** · ADVISORY · UNLISTED · `scenario` · family claims · Q6, a typed answer

> [UNLISTED] storyboard.html @ scenario / stills\scenario.png — The displayed "id: outlook-ios-not-receiving" is attributed in its claims to "interview-eval/scenarios.json:onedrive-data-loss"; this mismatched provenance makes the example hard to verify. Fix: cite the Outlook scenario's actual record or correct the displayed example.

**r2p2A2** · ADVISORY · UNLISTED · `loop` · Q9, a typed answer

> [UNLISTED] storyboard.html @ loop / stills\loop.png — Narration says "Then the same suite against main, and we diff the two," but the loop only labels "deploy the branch → run the suite × 3 → read the delta"; the baseline run is invisible at the video's central comparison. Fix: show a second, labelled main run feeding the delta.

Not evaluated, left to the engine:

> [PIPELINE: text size and contrast] covered by the pipeline — covered by: engine: rendered-text audit

> [PIPELINE: overflow and clipping] covered by the pipeline — covered by: engine: layout audit

> [PIPELINE: overlapping visual events] covered by the pipeline — covered by: engine: visual-event audit

### Run 3: r6 pass 1

`COUNTS: blocking 0 · advisory 2 · not evaluated 33` · files read: 2

**r6p1A1** · ADVISORY · UNLISTED · `many`, `dimensions` · Q10, a typed answer

> [UNLISTED] script.md @ `many` (2:10–2:38), “hundreds of scenarios”; `dimensions` (2:40–3:15), “all hundred and sixty-two scenarios” — the script calls a 162-scenario suite “hundreds,” implying at least 200. This matters because the suite size is a central credibility claim; no pass-1 rubric rule covers a narration-to-narration count mismatch. Fix: say “more than 160 scenarios” in `many` and use the same count in the opening blurb.

**r6p1A2** · ADVISORY · CRAFT-02 · whole video · family craft-02 · Q11, unmatched, taste

> [CRAFT-02] script.md @ `hard` (0:01–0:27) through `loop` (4:01–4:41) — eight top-level headings (“One assert,” “One scenario,” “The interview invents the questions,” “Independent scenarios,” “Several different questions,” “The fast tier,” “Correct category,” “The comparison”) appear in 4:41 without named grouping. Fix: group the existing segments under a few named chapters, without adding exposition.

Not evaluated, left to the engine:

> [PIPELINE: text size and contrast] automated rendered-text audit — covered by: engine: text-size/contrast audit

> [PIPELINE: clipping and overflow] automated layout audit — covered by: engine: overflow/clipping audit

> [PIPELINE: overlapping visual events] automated timing audit — covered by: engine: visual-event overlap audit

### Run 4: r6 pass 2

`COUNTS: blocking 1 · advisory 3 · not evaluated 24` · files read: 13

**r6p2B1** · BLOCKING · OBJ-08 · `many` · family count · Q3, unmatched, valid

> [OBJ-08] script.md @ `many`, “different” 2:25.353 — narration says “three different outputs,” but `many.png` labels the runs “output A,” “output A,” and “output B.” Fix: say “two different outputs across three runs,” or show three distinct outputs.

**r6p2A1** · ADVISORY · UNLISTED · `blindspot` · family interface · Q12, unmatched, valid

> [UNLISTED] timing.json @ `blindspot`, “Watch” 3:42.238; `blindspot.png` — “Watch it drive the real U I” promises footage, but the storyboard says the clip “has NOT been captured” and the available still shows only a stage-trace diagram. This matters if the diagram fallback is used. Fix: capture and clear the clip before using that line, or narrate the trace without asking viewers to watch the UI.

**r6p2A2** · ADVISORY · UNLISTED · `scenario` · family claims · Q13, unmatched, valid

> [UNLISTED] script.md @ `scenario`, “scenario” 0:30.282; `scenario.png` — the claim provenance names `onedrive-data-loss` and `answerPool[11]`, while the displayed example is `outlook-ios-not-receiving` with “13 alternative phrasings.” This leaves the example’s sourcing ambiguous. Fix: align the provenance with the depicted scenario and count, or depict the cited scenario.

**r6p2A3** · ADVISORY · UNLISTED · `scenario` · family ids · Q14, a typed answer

> [UNLISTED] timing.json @ `scenario`; `scenario.png` — the on-screen caption says “internal ids removed,” but the JSON visibly includes `"id": "outlook-ios-not-receiving"`. Fix: remove the id from the display or correct the caption.

Not evaluated, left to the engine:

> [PIPELINE: text size and contrast] covered by the pipeline — covered by: engine: rendered-text audit.

> [PIPELINE: overflow and clipping] covered by the pipeline — covered by: engine: layout audit.

> [PIPELINE: overlapping visual events] covered by the pipeline — covered by: engine: visual-event audit.

### Run 5: r7 pass 1

`COUNTS: blocking 1 · advisory 3 · not evaluated 19` · files read: 2

**r7p1B1** · BLOCKING · OBJ-08 · `many` · family count · Q4, unmatched, valid

> [OBJ-08] script.md @ `many` (2:10–2:38) — Narration says “three different outputs,” but the specified on-screen labels are “output A / output A / output B”: only two distinct outputs. Fix: say “two different outputs across three runs,” or show three genuinely distinct outputs.

**r7p1A1** · ADVISORY · UNLISTED · `scenario` · family claims · Q15, unmatched, valid

> [UNLISTED] script.md @ `scenario` (0:29–1:20) — Narration describes “Outlook, on iOS, not receiving email,” while the specified real scenario object is `onedrive-data-loss`; the source identifier suggests the demonstrated case may not be the narrated one. Fix: use an Outlook/iOS scenario and verify its fields match the spoken facts, or rewrite the narration to match the selected object.

**r7p1A2** · ADVISORY · UNLISTED · `scenario` · Q5, matched R7-01

> [UNLISTED] script.md @ `scenario` (0:29–1:20) — Narration says “Three authored facts this customer knows,” while the visual instruction says “Four authored facts are shown.” Fix: reconcile the spoken fact count and displayed facts.

**r7p1A3** · ADVISORY · CRAFT-02 · whole video · family craft-02 · Q16, unmatched, valid

> [CRAFT-02] script.md @ headings `hard`, `scenario`, `freeform`, `many`, `dimensions`, `twotier`, `blindspot`, `loop` — Eight top-level sections in 4:36 have no named higher-level grouping. Fix: group adjacent segments under a few named chapters without changing their examples.

### Run 6: r7 pass 2

`COUNTS: blocking 2 · advisory 3 · not evaluated 25` · files read: 13

**r7p2B1** · BLOCKING · OBJ-04 · `scenario` · Q5, matched R7-01

> [OBJ-04] stills\scenario.png @ scenario, “Three” 0:48.442 — narration says “Three authored facts” but the displayed `facts` array has four, including “I still have space left in my inbox.” Fix: narrate four facts and account for the fourth, or show only three.

**r7p2B2** · BLOCKING · OBJ-04 · `many` · family count · Q4, unmatched, valid

> [OBJ-04] stills\many.png @ many, “three different outputs” 2:25.068 — the narration claims three *different* outputs, while the three strips read “output A”, “output A”, “output B”: only two distinct outputs. Fix: say “three runs, with two different outputs,” or depict A/B/C.

**r7p2A1** · ADVISORY · UNLISTED · `blindspot` · family interface · Q17, unmatched, valid

> [UNLISTED] script.md @ blindspot, still `blindspot.png` — narration promises “Watch it drive the real U I,” but the segment notes say “The clip has NOT been captured” and currently fall back to a stage-trace diagram. Fix: secure and approve the clip before using that line, or narrate the trace instead when footage is absent.

**r7p2A2** · ADVISORY · UNLISTED · `loop` · Q19, unmatched, valid

> [UNLISTED] storyboard.html @ loop, still `loop.png` — storyboard says “One line said less safe” and cites “Out-of-scope probes stopped being refused,” but neither the narration nor the visible diagram identifies this regression; the comparison looks uniformly positive. Fix: show and narrate the out-of-scope regression alongside the gains.

**r7p2A3** · ADVISORY · UNLISTED · `scenario` · family ids · Q18, unmatched, false alarm

> [UNLISTED] stills\scenario.png @ scenario.png — the caption says “internal ids removed” although the JSON visibly includes `"id": "outlook-ios-not-receiving"`. Fix: omit that field or clarify which IDs were removed.

Not evaluated, left to the engine:

> [Pipeline 1] rendered text size and contrast — covered by: engine: text-size and contrast audit.

> [Pipeline 2] overflow and clipping — covered by: engine: layout audit.

> [Pipeline 3] overlapping visual events — covered by: engine: event-overlap audit.

### Run 7: r1 pass 1

`COUNTS: blocking 0 · advisory 2 · not evaluated 34` · files read: 2

**r1p1A1** · ADVISORY · UNLISTED · `many` · Q23, a typed answer

> [UNLISTED] script.md @ many, 1:30–2:03 — “All hundred and sixty-two run at once” suggests 162 simultaneous conversations, while the same segment's throughput example says “at ten workers.” This obscures the concurrency limit for a technical audience. Fix: say the scenarios are queued as independent parallel jobs, with bounded worker concurrency; keep the ten-worker figure tied to the recorded 75-scenario run.

**r1p1A2** · ADVISORY · UNLISTED · `twotier` · family less-time · not asked (it would have been Q24)

> [UNLISTED] script.md @ twotier, 2:42–3:03 — “the A P I [lane] clears all hundred and sixty-two in less time than that” reads as a measured comparison, but the script cites a 75-scenario measurement scaled to 162. An extrapolation is not a recorded 162-scenario result. Fix: call it a projection, or use a measured 162-scenario run before stating the comparison as fact.

Not evaluated, left to the engine:

> [Rendered text size and contrast] Covered by the pipeline, not this coach — covered by: engine: text-size and contrast audit.

> [Overflow and clipping] Covered by the pipeline, not this coach — covered by: engine: overflow and clipping audit.

> [Visual-event overlap] Covered by the pipeline, not this coach — covered by: engine: visual-event overlap audit.

### Run 8: r1 pass 2

`COUNTS: blocking 3 · advisory 2 · not evaluated 14` · files read: 13

**r1p2B1** · BLOCKING · OBJ-07 · `hard` · Q20, unmatched, valid

> [OBJ-07] script.md @ hard, “ten turns” (timing.json 11.121s); hard.png — narration says the interview “branches for ten turns,” but the storyboard/still ends at “turn 3.” Fix: show the later turns or describe the diagram as the first three turns of a longer interview.

**r1p2B2** · BLOCKING · OBJ-08 · `many` · family count · Q21, unmatched, valid (asked in error)

> [OBJ-08] script.md @ many, “three different grades” (timing.json 110.194–111.213s); many.png — the three strips read “grade A,” “grade A,” “grade B”: two grades, not three different grades. Fix: say “two different grades across three runs,” or show three distinct grades.

**r1p2B3** · BLOCKING · OBJ-07 · `blindspot` · family interface · Q22, a typed answer

> [OBJ-07] script.md @ blindspot, “Watch it drive the real interface” (timing.json 188.253–189.669s); blindspot.png — the input states the footage has not been captured and the available visual is a stage-trace diagram, not the interface being driven. Fix: capture and approve the interface clip before using this narration, or narrate the stage-trace diagram instead.

**r1p2A1** · ADVISORY · CRAFT-02 · whole video · family craft-02 · not asked (it would have been Q25)

> [CRAFT-02] script.md @ hard.png through loop.png — eight top-level beats in 4:09 (“One assert,” “A behaviour suite,” “One scenario,” “Independent scenarios,” “Several different questions,” “The fast tier,” “Correct category,” “The comparison”) have no named chapter grouping. Fix: group them visually into a few named chapters without adding explanatory narration.

**r1p2A2** · ADVISORY · UNLISTED · `loop` · Q26, unmatched, valid

> [UNLISTED] script.md @ loop, “the panel below the totals slides in”; loop.png — the flagged panel is to the right of the totals, not below them; the spatial direction sends the viewer to the wrong place. Fix: say “the panel beside the totals,” or place it below.

Not evaluated, left to the engine:

> [ENGINE-TEXT] minimum rendered text size and contrast are pipeline checks — covered by: engine: rendered text size/contrast audit

> [ENGINE-OVERFLOW] element clipping and frame overflow are pipeline checks — covered by: engine: layout audit

> [ENGINE-OVERLAP] simultaneous visual events are pipeline checks — covered by: engine: visual-event overlap audit

## The answers

The 25 scoring exchanges, in order: each question's first line and the answer, verbatim. The rest of each question (its quoted findings, rubric lines and context) is not reproduced; the window hash under "Sources" fixes it.

### Q1

2026-09-29T01:08:45.865Z · asks about r2p2B1 · offers R2-05, R2-06, R2-07 and R2-08

> 1 of 19 · r2 (reconstructed) · pass 2 (script, timing, storyboard, stills, audit) · BLOCKING · segment 4, `many`
>
> User selected: Unmatched — valid (the review missed it)

### Q2

2026-09-29T03:47:03.951Z · asks about r2p2B2 · offers R2-11

> 2 of 19 · r2 (reconstructed) · pass 2 (script, timing, storyboard, stills, audit) · BLOCKING · segment 7, `blindspot`
>
> User selected: R2-11 — can we add the webpage screenshots here?

### Q3

2026-09-29T16:03:38.110Z · asks about r6p2B1 · offers no item, only the unmatched choices

> 3 of 19 · r6 (commit-backed) · pass 2 (script, timing, storyboard, stills, audit) · BLOCKING · segment 4, `many`
>
> User selected: Unmatched — valid (the review missed it)

### Q4

2026-09-29T16:38:35.574Z · asks about r7p1B1 and r7p2B2 · offers no item, only the unmatched choices

> 4 of 19 · r7 (commit-backed) · pass 1 (script) and pass 2 (script, timing, storyboard, stills, audit) · BLOCKING, both · segment 4, `many`
>
> User selected: Unmatched — valid (the review missed it)

### Q5

2026-09-29T18:12:58.944Z · asks about r7p2B1 and r7p1A2 · offers R7-01

> 5 of 19 · r7 (commit-backed) · pass 2 (script, timing, storyboard, stills, audit) BLOCKING, and pass 1 (script) ADVISORY · segment 2, `scenario`
>
> User selected: R7-01 — we're still saying "3 authored facts" when it's 4. We should update that part

### Q6

2026-09-29T19:51:29.630Z · asks about r2p1A1 and r2p2A1 · offers R2-02

> 6 of 19 · r2 (reconstructed) · pass 1 (script) and pass 2 (script, timing, storyboard, stills, audit) · ADVISORY · segment 2, scenario
>
> User responded: Unmatched and likely valid. Something to fix in the citation since the scenario was updated to outlook instead of the OneDrive scenario

### Q7

2026-09-29T20:31:46.734Z · asks about r2p1A2 · offers no item, only the unmatched choices

> 7 of 19 · r2 (reconstructed) · pass 1 (script) · ADVISORY · segment 6, twotier
>
> User responded: Unmatched. It's something that is good to call out, but ultimately something we would keep in. This callout is fine for this case, but it's a good callout to make overall

### Q8

2026-09-29T20:48:30.643Z · asks about r2p1A3 · offers R2-13

> 8 of 19 · r2 (reconstructed) · pass 1 (script) · ADVISORY · whole video, all eight segments
>
> User selected: Unmatched — false alarm

### Q9

2026-09-29T20:58:59.101Z · asks about r2p2A2 · offers R2-12

> 9 of 19 · r2 (reconstructed) · pass 2 (script, timing, storyboard, stills, audit) · ADVISORY · segment 8, loop
>
> User responded: Unmatched. Good feedback, but I would probably reject this one too. We don't want it to be super busy

### Q10

2026-09-29T21:04:53.790Z · asks about r6p1A1 · offers R6-06 and R6-07

> 10 of 19 · r6 (commit-backed) · pass 1 (script) · ADVISORY · segments 4 (many) and 5 (dimensions)
>
> User responded: This was something I changed that an earlier LLM pushed back on. We run the 162 scenarios 3 times, so it's essentially >400, but we're also exagerrating slightly

### Q11

2026-09-29T21:09:56.190Z · asks about r6p1A2 · offers R6-01, R6-02, R6-08 and R6-09

> 11 of 19 · r6 (commit-backed) · pass 1 (script) · ADVISORY · whole video, all eight segments
>
> User selected: Unmatched — taste

### Q12

2026-09-29T21:17:59.352Z · asks about r6p2A1 · offers R6-11 and R6-12

> 12 of 19 · r6 (commit-backed) · pass 2 (script, timing, storyboard, stills, audit) · ADVISORY · segment 7, blindspot
>
> User selected: Unmatched — valid (the review missed it)

### Q13

2026-09-29T23:06:53.646Z · asks about r6p2A2 · offers R6-04 and R6-05

> 13 of 19 · r6 (commit-backed set) · pass 2 (all inputs) · ADVISORY · segment 2 (scenario)
>
> User selected: Unmatched — valid (the review missed it)

### Q14

2026-09-29T23:09:06.016Z · asks about r6p2A3 · offers R6-04 and R6-05

> 14 of 19 · r6 (commit-backed set) · pass 2 (all inputs) · ADVISORY · segment 2 (scenario)
>
> User responded: Unmatched: valid feedback, but another thing I would likely ignore/allow since we mostly care about userIds or things that don't make sense to the user. This ID is fine

### Q15

2026-09-29T23:21:34.914Z · asks about r7p1A1 · offers R7-01

> 15 of 19 · r7 (commit-backed set) · pass 1 (script and rubric only) · ADVISORY · segment 2 (scenario)
>
> User selected: Unmatched — valid (the review missed it)

### Q16

2026-09-29T23:33:09.472Z · asks about r7p1A3 · offers R7-02

> 16 of 19 · r7 (commit-backed set) · pass 1 (script and rubric only) · ADVISORY · whole video
>
> User selected: Unmatched — valid (the review missed it)

### Q17

2026-09-29T23:36:24.069Z · asks about r7p2A1 · offers no item, only the unmatched choices

> 17 of 19 · r7 (commit-backed set) · pass 2 (all inputs) · ADVISORY · segment 7 (blindspot)
>
> User selected: Unmatched — valid (the review missed it)

### Q18

2026-09-29T23:44:54.479Z · asks about r7p2A3 · offers R7-01

> 18 of 19 · r7 (commit-backed set) · pass 2 (all inputs) · ADVISORY · segment 2 (scenario)
>
> User selected: Unmatched — false alarm

### Q19

2026-09-29T23:45:51.068Z · asks about r7p2A2 · offers no item, only the unmatched choices

> 19 of 19 · r7 (commit-backed set) · pass 2 (all inputs) · ADVISORY · segment 8 (loop)
>
> User selected: Unmatched — valid (the review missed it)

### The r1 decision

2026-09-29T23:47:45.439Z

> Scoring for the three scored rounds (r2, r6, r7) is complete.
>
> User selected: Yes — judge r1's findings too

### Q20

2026-09-29T23:54:48.557Z · asks about r1p2B1 · offers R1-03, R1-04 and R1-05

> r1 · 1 of 7 · descriptive only (counts toward neither bar) · pass 2 (all inputs) · BLOCKING · segment 1 (hard)
>
> User selected: Unmatched — valid (the review missed it)

### Q21

2026-09-30T00:04:22.258Z · asks about r1p2B2 · offers no item, only the unmatched choices

> r1 · 2 of 7 · descriptive only (counts toward neither bar) · pass 2 (all inputs) · BLOCKING · segment 4 (many)
>
> User selected: Unmatched — valid (the review missed it)

### Q22

2026-09-30T00:10:29.648Z · asks about r1p2B3 · offers R1-11

> r1 · 3 of 7 · descriptive only (counts toward neither bar) · pass 2 (all inputs) · BLOCKING · segment 7 (blindspot)
>
> User responded: I've already reviewed this one. Please double-check the remaining items and ensure I haven't already provided feedback

### Q23

2026-09-30T00:13:22.750Z · asks about r1p1A1 · offers no item, only the unmatched choices

> r1 · Q23 · descriptive only (counts toward neither bar) · pass 1 (script and rubric only, no stills) · ADVISORY · segment 4 (many)
>
> User responded: unmatched. Good callout, but too much detail for this one

### Q26

2026-09-30T00:17:49.316Z · asks about r1p2A2 · offers no item, only the unmatched choices

> r1 · Q26, the last one · descriptive only (counts toward neither bar) · pass 2 (all inputs) · ADVISORY · segment 8 (loop)
>
> User selected: Unmatched — valid (the review missed it)

## r1 (descriptive only)

r1 counts toward neither bar. Its two objective items were resolved from its inputs in `r1-resolution.json`, against state `b9a3c09239b75aca2c95e4c07e5434f79541011d`. The user chose to judge its findings anyway.

- Precision: 2/2 (100 %) of the BLOCKING findings that were judged. Over all 3, between 2/3 and 3/3, because r1p2B3 was not judged.
- Recall: 0/2 (0 %) certain, at most 1/2 (50 %). R1-11 could have been caught by r1p2B3 (Q22, not judged), which names its segment.

R1-04 falls in row 4 of the README's lane table (overflowing or clipped). No finding caught it, and pass 2 left that lane to the engine:

> [ENGINE-OVERFLOW] element clipping and frame overflow are pipeline checks — covered by: engine: layout audit

- Q21 was asked in error: r1p2B2 is in family count, which Q1 had already judged. It was answered unmatched, valid.
- Q22 was not judged. r1p2B3 is in family interface, asked before as Q2, Q12 and Q17, and the answer was typed: "I've already reviewed this one. Please double-check the remaining items and ensure I haven't already provided feedback".
- r1p1A2 (ADVISORY) was not asked. It would have been Q24, and its family, less-time, had been asked as Q7.
- r1p2A1 (ADVISORY) was not asked. It would have been Q25, and its family, craft-02, had been asked as Q8, Q11 and Q16.

## Families

Findings from different runs that make the same observation, grouped by a declared pattern. The script checks that each pattern matches exactly its declared findings, and that no finding is in two families. A family is judged differently when one of its members was judged a false alarm or taste and its asked members drew at least two different answers.

### count

Matches "three different grades" or "three different outputs".

| Finding | Round | Severity | Question | Judgment |
|---|---|---|---|---|
| r2p2B1 | r2 | BLOCKING | Q1 | unmatched, valid |
| r6p2B1 | r6 | BLOCKING | Q3 | unmatched, valid |
| r7p1B1 | r7 | BLOCKING | Q4 | unmatched, valid |
| r7p2B2 | r7 | BLOCKING | Q4 | unmatched, valid |
| r1p2B2 | r1 | BLOCKING | Q21 | unmatched, valid |

### interface

Matches "Watch it drive the real U I" or "… interface".

| Finding | Round | Severity | Question | Judgment |
|---|---|---|---|---|
| r2p2B2 | r2 | BLOCKING | Q2 | matched R2-11 |
| r6p2A1 | r6 | ADVISORY | Q12 | unmatched, valid |
| r7p2A1 | r7 | ADVISORY | Q17 | unmatched, valid |
| r1p2B3 | r1 | BLOCKING | Q22 | a typed answer |

### claims

Names `onedrive-data-loss`.

| Finding | Round | Severity | Question | Judgment |
|---|---|---|---|---|
| r2p1A1 | r2 | ADVISORY | Q6 | a typed answer |
| r2p2A1 | r2 | ADVISORY | Q6 | a typed answer |
| r6p2A2 | r6 | ADVISORY | Q13 | unmatched, valid |
| r7p1A1 | r7 | ADVISORY | Q15 | unmatched, valid |

### craft-02

Rule CRAFT-02. **Judged differently.**

| Finding | Round | Severity | Question | Judgment |
|---|---|---|---|---|
| r2p1A3 | r2 | ADVISORY | Q8 | unmatched, false alarm |
| r6p1A2 | r6 | ADVISORY | Q11 | unmatched, taste |
| r7p1A3 | r7 | ADVISORY | Q16 | unmatched, valid |
| r1p2A1 | r1 | ADVISORY | not asked | — |

### ids

Matches "internal ids removed". **Judged differently.**

| Finding | Round | Severity | Question | Judgment |
|---|---|---|---|---|
| r6p2A3 | r6 | ADVISORY | Q14 | a typed answer |
| r7p2A3 | r7 | ADVISORY | Q18 | unmatched, false alarm |

### less-time

Matches "less time than that".

| Finding | Round | Severity | Question | Judgment |
|---|---|---|---|---|
| r2p1A2 | r2 | ADVISORY | Q7 | a typed answer |
| r1p1A2 | r1 | ADVISORY | not asked | — |

Judged differently: craft-02 and ids.

The coach's severity differs within interface: BLOCKING in r2 and r1, ADVISORY in r6 and r7.

## The key's appendix

The answer key's appendix lists 9 things seen while drafting it and not keyed. Each probe names one bullet by a string it contains, then says which findings touch it: a family, or a pattern searched in every finding. The probes were written after the findings had been read.

| # | Bullet containing | Probe | Findings |
|---|---|---|---|
| 1 | "land on three different grades" | family count | r2p2B1, r6p2B1, r7p1B1, r7p2B2 and r1p2B2 |
| 2 | "A filling bar, not a strobing grid." | `/strobing\|filling bar\|authoring note/i` | none |
| 3 | "the same lag as R6-10" | `/\b(lags?\|reveal\w*\|sooner\|earlier)\b/i` | none |
| 4 | "Then the panel below the totals slides in" | `/panel below the totals/i` | r1p2A2 |
| 5 | "the same edge crossing as R6-13" | `/\b(cross\w*\|collid\w*\|overlap\w*\|arrowheads?)\b/i` | none |
| 6 | "Watch it drive the real U I" | family interface | r2p2B2, r6p2A1, r7p2A1 and r1p2B3 |
| 7 | "onedrive-data-loss" | family claims | r2p1A1, r2p2A1, r6p2A2 and r7p1A1 |
| 8 | "placed last" | `/placed last\|\blast\b/i` | none |
| 9 | "Defects that the README already discloses" | `/One line said less safe\|c-caveat\|\bNaN\b/i` | r7p2A2 |

## Disclosures

1. **The questioner knew the key.** The orchestrator wrote every question with the answer key open, and chose the context each one showed. It did not choose the options: each question offered the items of its findings' segments, in table order, then the three unmatched choices, and the script checks that for every question.
2. **Only a finding's own segments were offered.** An item was offered only when a question's findings named its segment. Items offered: r2 8/13, r6 10/15, r7 2/2, r1 4/15, outside any round 0/4. Objective items never offered: R6-10 and R6-13. Only Q3 and Q4 invited typing an item ID that was not offered. The 4 items outside any round are in no round's denominator, so offering them could not have changed a score.
3. **How each quote was matched.** Each quoted finding matched its report at the strictest level that matched any: 11 exact, 0 excerpt, 16 folded, 0 folded excerpt and 0 tag and location. The question bodies around the quotes are fixed only by the window hash.
4. **Grouped questions were never split.** Q4, Q5 and Q6 each asked about two findings and took one answer for both. Q5 paired a BLOCKING finding with an ADVISORY one, so its one answer counts at both severities.
5. **Typed answers.** 7 answers were typed: Q6, Q7, Q9, Q10, Q14, Q22 and Q23. The script checks that no typed answer names an item, so none can catch one. None was on a scored BLOCKING finding, so none changes precision.
6. **Q21 was asked in error, and that was not reported when it happened.** Its finding is in family count, which Q1 had already judged. A phrase test run by this script (the first quoted phrase of each r1 BLOCKING finding, searched in the findings of Q1–19) gives: Q20 hits nothing; Q21 hits Q1; Q22 hits nothing. So it finds Q21's repeat but not Q22's, whose family had been asked as Q2, Q12 and Q17.
7. **Not judged, and not asked.** Q22 was not judged. Q24 (r1p1A2) and Q25 (r1p2A1) were not asked, because each repeats a family already asked. All of them are r1's, which counts toward neither bar.
8. **Words that could lead the judge.** "type its ID" appears in Q3 and Q4; "objective" appears in Q22; "(craft)" appears in Q8, Q11 and Q16. The question with "objective" is the one question not judged. The ones with "(craft)" are the CRAFT-02 questions, quoting the rubric's own rule. Lower-case "craft" appears nowhere else. That last check was first written to excuse any line starting "• rubric.md". Q8 and Q11 quote the rule on a line of their own, so it failed on its first run. It now excuses only the rule's quoted words, wherever they appear. It is the only declaration changed after a check failed.
9. **The same observation drew different answers.** craft-02 and ids were judged differently from round to round, and the coach's own severity varies within interface. One round's score cannot show either.
10. **Amendment 9.** Run 4 (r6 pass 2) stands under Amendment 9. Without it, the governing set scores recall 1/3 (33.3 %) and precision 3/3 (100 %), and the answer is the same.
11. **The appendix probes came after the findings.** 5 of the key's 9 appendix bullets are touched by at least one finding. The probes that show it were written after the findings had been read, so they describe the overlap; they do not measure it.
12. **No "(Recommended)".** No question or choice said "(Recommended)"; the script checks every one.
13. **What is left out.** The coach's staging directory is removed from every quoted finding. The reports' RUBRIC field, their FILES READ lists and the question bodies are not reproduced. The script refuses to write this file if it would contain a profile path, a URL or the user's name.
14. **Engine lanes.** No scored objective item falls in an engine lane, so the lane rule cannot move the result. In r1, R1-04 does, and a pass that could see it left the lane to the engine (see "r1").
15. **One judge.** Every judgment is the user's, given once. Nothing here measures how a second judge would have answered.
16. **The script came after the answers.** The README's Scoring rules were fixed before any coach run. This script was written after the answers were collected. Its declarations (the questions, families, typed answers and probes) record what the session shows, and each one is checked against its source.

## Sources

Protocol files, read from HEAD:

| File | Blob |
|---|---|
| answer-key.md | `1cf941b1c8b81c23372f13d0173bc80d1bdd70aa` |
| inputs.md | `9cd325b6e262c53505ff35bd0de68ef002c30a99` |
| runs.md | `67ee5c9968c7c86f0664529a270bfd2eabb01b82` |
| r1-resolution.json | `6ee06726d1254354c24125587184f3e92c9e2027` |
| rubric.md | `106d2d666826ec4c48b48aed5a75ebec31c2adc8` |

README.md is not pinned by blob, because its Answer section is written after this file. Its Scoring part (14 lines) has sha256 `88b8b98ed6aee47aa95ad2f9a75e75df75865951c70ddc6ead58febe48167377`, and its lane table has sha256 `7cf8fe35ba4a334130d8491b8abf729262c00afd3411977f1a1c430c4d42ac7d`.

Coach reports, each matched byte for byte:

| Run | Round | Pass | Bytes | SHA-256 | Status |
|---|---|---|---|---|---|
| 1 | r2 | 1 | 5361 | `be1673ee48a3eec5997bb1255b849a4ae438315cf7b79812f83b8ca3e947ca09` | valid |
| 2 | r2 | 2 | 5019 | `b804ce9ce7c8c113fb707e5ff4fa02ae3c7a79a90de7416ca8f510354686cd47` | valid |
| 3 | r6 | 1 | 4208 | `1e84f655b1f50182a9cfc6991b65e94e421b55fc42f108a49d370f0e95754d64` | valid |
| 4 | r6 | 2 | 5017 | `da1eb3419e520fb3c41d4485cfcfc9224e9377e5d7242f09739ac0b8a0bfc639` | valid (Amendment 9) |
| 5 | r7 | 1 | 3569 | `4560fd16601b387e449cd5ab6f32564d6a440bee9549c5307654e2b5f2f7bd30` | valid |
| 6 | r7 | 2 | 5234 | `b03cb9c3be39c68bdc9abfce0a5f91d80f0f7355bdabcd8605e557834d4b960c` | valid |
| 7 | r1 | 1 | 4757 | `2304de740e76b026688f7e876bf3bddc940583f2a95c071cd1b880c51f442cc9` | valid |
| 8 | r1 | 2 | 4397 | `97f9abdf2e81444c395cc33445a521bc7260e04770415e072a0d36687bbddd45` | valid |

Scoring exchanges: 25 ask_user calls, from 2026-09-29T01:08:45.865Z to 2026-09-30T00:17:49.316Z. The sha256 of their canonical questions, choices and answers is `2b252b1ebc47fd740dbcb255c4da5e42cf8cf031e19b6f4d03df57b69fea8907`.

## Declared, and checked

Every check below passed on this run. A failed check stops the script, and it writes nothing.

- sources: each protocol file is one blob at HEAD
- README: the Scoring heading appears once
- README: the Contamination heading appears once
- README: Scoring ends where Contamination begins
- README: Scoring states the bar
- README: the bar is recall ≥ 50 % and precision ≥ 80 %
- README: Scoring says the commit-backed result governs a disagreement
- README: the lane table appears once
- README: the lane table lies outside Scoring
- README: the lane table is 8 lines
- README: the lane table has a separator row
- README: a blank line follows the lane table
- README: lane row 1 is text size
- README: lane row 2 is contrast of text
- README: lane row 3 is contrast of graphics
- README: lane row 4 is overflowing or clipped
- README: lane row 5 is overlapping in time
- README: lane row 6 is subtitles and loudness
- key: states the segment order from r2 on
- key: the segment order is numbered 1, 2, 3, …
- key: the order names eight segments, each once
- key: the round sections are r2, r6, r7 and r1, in that order
- key: r2 has one item table
- key: item tables are ID, Seg, words, Class and, in scored rounds, Fixed by
- key: item tables have a separator row
- key: item rows have one cell per column
- key: item IDs are R<round>-NN, bold or plain
- key: item IDs are numbered in order within their round
- key: Seg is a digit from 1 to 8, or a dash
- key: every item has at least one class
- key: an ID is bold exactly when objective is among its classes
- key: every scored item has exactly one class
- key: every round has items
- key: r6 has one item table
- key: r7 has one item table
- key: r1 has one item table
- key: the outside-any-round table appears once
- key: the outside-any-round table is ID, words and Class
- key: outside-any-round IDs are P-numbers
- key: every outside-any-round item has exactly one class
- key: every item outside any round is "not about this video"
- key: the counts table appears once
- key: the counts table has a separator row
- key: the counts table is what the item tables add up to
- key: states the recall denominators its own tables produce
- key: says "R6-13 has no BLOCKING route"
- key: says "R6-10 and R2-06 are reached only through OBJ-07's check procedure"
- key: a blank line follows each detail header
- key: detail lines are bullets or 2-space continuations
- key: a detail block is Evidence, Passes, Route, Lane, an optional Why objective, then Fixed
- key: Passes reads "N." or "N and M."
- key: Route ends its first clause with "." or ":"
- key: Lane is "none" or names a row
- key: each item has at most one detail block
- key: the detail blocks are exactly the scored objective items
- key: the declared objective items are the key’s
- key: a detail header names its table row’s segment
- key: R2-06's passes, route and lane
- key: R2-11's passes, route and lane
- key: R6-10's passes, route and lane
- key: R6-13's passes, route and lane
- key: R7-01's passes, route and lane
- key: the appendix heading appears once
- key: the appendix runs to the end of the file
- key: after its first bullet the appendix is bullets only
- key: a reconstructed round is one lib.mjs rebuilds from recorded inputs
- key: a commit-backed round is one lib.mjs pins to a commit
- key: a descriptive-only round is one lib.mjs rebuilds only from a checkpoint
- inputs: the segment-number table appears once
- inputs: a blank line, then a Number | Segment table, follows
- inputs: segment rows are numbered 1, 2, 3, … and name one segment
- inputs: r1 has eight segments, each named once
- r1-resolution: resolves round r1
- key: no r1 item is objective by its table alone
- r1-resolution: resolves exactly the r1 items the key left with several candidate classes
- r1-resolution: each item resolves to one of its candidate classes
- r1-resolution: each item names the segment of its table row
- r1-resolution: each item cites evidence
- r1-resolution: R1-04 and R1-11 resolve with the declared passes and lanes
- r1-resolution: both resolve to objective
- runs: the Runs table appears once
- runs: the Runs table has a status column
- runs: the Runs table has a separator row
- runs: each row has one cell per column
- runs: each row is a numbered run of one round and pass
- runs: the log records the coach model for every run
- runs: each row records the report size and its full SHA-256
- runs: every run is valid
- runs: the eight runs are r2, r6, r7 and r1, pass 1 then pass 2
- runs: exactly one run, r6 pass 2, stands under Amendment 9
- reports: each report matches runs.md byte for byte
- reports: use LF line endings only
- reports: line 1 is "COACH REPORT — pass N" for the run’s pass
- reports: a blank line follows line 1
- reports: outside a section, every line is a header field
- reports: header fields come before any section, once each
- reports: a section header follows a blank line
- reports: each section appears once, in order
- reports: inside a section, every line is a "  - " item
- reports: every report has each header field
- reports: every report has every section
- reports: the coach and author models are the recorded ones, and independent
- reports: "none" appears only as the whole of an empty section
- reports: COUNTS reads "blocking B · advisory A · not evaluated N"
- reports: COUNTS match the sections
- reports: every finding opens with a [RULE] tag
- reports: every finding separates its location from its text with " — "
- reports: every finding names a segment, or is CRAFT-02
- reports: 29 findings, 9 BLOCKING and 20 ADVISORY
- reports: every BLOCKING finding cites an objective rule
- families: each family is exactly its declared findings
- families: no finding belongs to two families
- events: exactly one ask_user call opens the scoring ("1 of 19 · ")
- events: exactly one closes it ("r1 · Q26, the last one · ")
- events: the window opens before it closes
- events: the window holds 25 ask_user calls
- events: every call in the window completed successfully, with text
- events: every question is text, and every choice list is text
- events: the window’s timestamps never decrease
- exchanges: the window is questions 1–19, the r1 decision, then 20–23 and 26
- rubric: the CRAFT-02 rule line appears once
- rubric: the quoted CRAFT-02 words are the rule’s
- exchanges: no question or choice says "(Recommended)"
- exchanges: every declared finding exists
- exchanges: a question asks about one round
- exchanges: each header names its findings’ round, and that round’s set
- exchanges: each header names its findings’ passes
- exchanges: each header names its findings’ severities
- exchanges: each question’s segments are its findings’
- exchanges: each header numbers its segments as its round does
- exchanges: each question quotes as many findings as it asks about
- exchanges: a quote matches one finding, at the strictest level that matches any
- exchanges: quotes and findings pair off one to one
- exchanges: each question offers its segments’ items in table order, then the three unmatched choices
- exchanges: every answer is a selection or a typed response
- exchanges: every selection is one of the choices offered
- exchanges: each judgment is the declared one
- exchanges: no finding is asked about twice
- exchanges: each item selected is the declared one
- exchanges: each typed answer opens with its declared words
- exchanges: no typed answer names an item
- exchanges: a whole-video header says "whole video" and names no segment
- exchanges: each CRAFT-02 question quotes the rubric’s rule
- exchanges: the r1 decision states r1’s finding counts
- exchanges: the r1 decision offers judging r1, or reporting it unjudged
- exchanges: the user chose to judge r1
- exchanges: the asked and the not-asked findings are all 29, each once
- exchanges: Q26 says which question each skipped finding would have been
- exchanges: each skipped question repeats the declared ones
- exchanges: each skipped finding shares a family with every question it repeats
- exchanges: the question asked in error repeats a family already judged
- exchanges: the unjudged question’s family had been asked as the declared questions
- exchanges: the unjudged question was answered by typing
- exchanges: each r1 BLOCKING finding quotes a phrase
- exchanges: the phrase test finds what it was declared to find
- exchanges: "type its ID" appears only where declared
- exchanges: "objective" appears only where declared
- exchanges: "(craft)" appears only where declared
- exchanges: lower-case "craft" appears only inside the quoted rubric rule
- scoring: every scored BLOCKING finding was judged
- scoring: every lane an item names is one of the five engine lanes
- scoring: the families judged differently are the declared ones
- appendix: each probe names exactly one bullet
- appendix: each probe hits the declared findings
- appendix: the probes and the bullets pair off one to one
