# Answer key

> **Status: confirmed by the user on 2026-09-28**, before any coach run (README,
> "Protocol", step 3). The user kept rule T as written, *objective* as R2-11's class, and
> the full quotes.

This key records what the user reported about each render they watched, and classifies
each report before any coach has run. The coach's findings are scored against it (README,
"Scoring"): recall on the *objective* items, and precision on the user's agreement with
every BLOCKING finding.

## How to read it

### Sources

- **Primary: the user's own words.**
  - The messages the user typed in the plan session (`04ef1c2e`). They are cited P1–P26,
    by their order among that log's user messages, with their line (Amendment 7, item 1).
  - The user's answers to `ask_user`, cited `A@plan L…` or `A@build L…` by the line of the
    question. Each is quoted after the question it answers, with the tool's own prefix:
    "User selected:" for an offered choice, "User responded:" for typed text.
- **Cross-check only:** the author's review scripts (`tools/EvalLoopDemo/qc/apply-review-*.mjs`),
  the commit messages, and the build session's relays. The *Fixed by* column comes from
  these. It records what the author changed, not what the defect was.
- **Quoted in full.** Each message is quoted verbatim, typos included, with line-end
  whitespace trimmed. The quotes are generated from the session logs by script, not typed.
  A `\` at the end of a quoted line is not part of the message: it keeps the message's line
  break when the file is rendered.
- **Redacted, and nothing else changed** (constitution §V):
  - every URL becomes `[link omitted]`. Where the user wrote a markdown link, its text stays
    if it names something public (P9's music track), and goes with the URL if not (P16's
    internal page);
  - the user's name becomes `[name omitted]`;
  - one internal hostname, in the question at plan L1226, becomes `[host omitted]`.

### Classes

| Class | Meaning | In recall's denominator |
|---|---|---|
| *objective* | A careful viewer would call it wrong, not merely prefer it otherwise. This is the coach's own test (`video-coach.agent.md`, "Authority"). The round's inputs must show it | yes |
| *craft* | A judgement: the user preferred something else | no |
| *not catchable before render* | It needed listening, or a full render | no |
| *not in these inputs* | The defect did not exist yet in the round's pre-fix state | no |
| *not about this video* | A request for something the render never attempted, or feedback on the tooling or the process (Amendment 7, item 10) | no |

- **The defect is classified, not the fix.** "Space them out" is a fix. The class depends
  on what it answers: a crossing that the still shows is objective, and spacing the user
  would like looser is craft.
- **Only what the user reported is keyed.** A defect the author found with no user report
  is not keyed (Amendment 7, item 5), and neither is one noticed while drafting this key.
  Those are listed in the appendix, which changes no score.
- A coach finding that the user matches to an item of any class counts as agreed.

### Rule T: "show it earlier"

Three items ask for a visual to appear sooner: R2-06, R6-06 and R6-10. When a diagram
should lead the sentence about it is a judgement, and the user said so in P21: *"I'm not
sure if there's a "best practice" for this."* So such a request is **craft**, with one
exception.

- If the narration speaks of the visual as already present ("on screen", "shown here",
  "labelled …") **at least 1.0 s before the visual is revealed**, the video says something
  untrue for that long. The item is then **objective**.
- Both times come from pass 2's `timing.json`, counted from the segment's start: the
  deictic word's `audio.words[].startMs` less the segment's `startMs`, and the visual's
  reveal trigger `atMs`, which the engine already counts from the segment's start.
- The 1.0 s tolerance is a choice, not a sourced figure. It is fixed here, before any run.

### Fields

- **Seg**: the segment's position in the render. From r2 on, the order is the same in
  every round: 1 `hard`, 2 `scenario`, 3 `freeform`, 4 `many`, 5 `dimensions`,
  6 `twotier`, 7 `blindspot`, 8 `loop`. A dash means the item is not about one segment.
- **Passes**: the passes whose inputs show the defect. Pass 1 has `script.md` only. Pass 2
  adds `timing.json`, `storyboard.html`, one still per segment and `audit.txt`. Recall
  counts a BLOCKING finding in any of these passes (README, "Scoring").
- **Route**: the block-eligible rubric rules that reach the defect, and the pass each runs
  in. *None* means only `UNLISTED` can reach it, which is advisory, so at BLOCKING it is an
  expected miss. It still counts in the denominator: the key records what a careful
  viewer would call wrong, not what the rubric can reach.
- **Lane**: the row of the lane table (README, "Contamination") that the defect falls in,
  if any. A defect in rows 1–5 that the coach leaves to the engine is a miss, and is also
  counted separately.
- **Fixed by**: cross-check only. A quoted name such as "2 · many" is a section heading in
  the author's review script, which numbers the segments its own way.
- **Times** are seconds from the segment's start, counted as in rule T, and rounded to the
  nearest 10 ms, halves up. A difference is taken before rounding.

## Counts

| Round | Set | Items | Objective | Craft | Not catchable | Not in these inputs | Not about this video |
|---|---|---|---|---|---|---|---|
| r2 | reconstructed | 13 | 2 | 10 | 0 | 0 | 1 |
| r6 | commit-backed | 15 | 2 | 9 | 1 | 0 | 3 |
| r7 | commit-backed | 2 | 1 | 0 | 1 | 0 | 0 |
| **Scored** | | **30** | **5** | **19** | **2** | **0** | **4** |
| r1 | descriptive only | 15 | 0–2 | 7–8 | 1–2 | 0–1 | 5 |
| Outside any round | — | 4 | 0 | 0 | 0 | 0 | 4 |

The last row is four messages of feedback on the tooling or the process, which Amendment 7,
item 10 keys but no round's review contains (see "Keyed outside any round").

Recall's denominator is 3 on the commit-backed set (R6-10, R6-13, R7-01), and 2 on the
reconstructed set (R2-06, R2-11). The bar, recall of at least 50 %, needs 2 of 3 and 1 of
2. Two consequences, stated before any run:

- **R6-13 has no BLOCKING route.** So the commit-backed bar needs both R6-10 and R7-01
  raised as BLOCKING.
- **R6-10 and R2-06 are reached only through OBJ-07's check procedure,** which looks at the
  storyboard "at that timestamp". OBJ-07's rule text asks only whether the visual appears
  "anywhere in that segment", and both visuals do. A coach that applies the rule text
  alone will block neither. OBJ-06 cannot reach them either: the triggers in `timing.json`
  carry times, not words.

## r2: P20 (reconstructed)

- **Render:** 09-25 23:04:52 UTC (build L3227), 3840×2160, from checkpoint #16.
- **Review:** P20 (plan L1375, 09-26 00:06 UTC), and the answer at plan L1411.
- **Input set:** checkpoint #17. Its engine differs from #16's only by the inert
  `arrowSize` option, and both build a scene byte-identical to r2's (Amendment 7, item 6).

**P20** (plan L1375):

> I have the updated video recording now.
>
> -Segment 1: the unit test bubbles are still too close together. Space them apart futher and make the arrows smaller
>
> -For segment 2, can we actually show the JSON object instead of these and then highlight the portion that we're looking at? It'll be more impressive showing all the things we have that are configurable (and I understand it'll be noisier). We can highlight/circle the fields as we talk about them
>
> -Segment 3: there's a goofy spot where it darkens the screen when discussing r4. We don't need to do that. Update the "Phrasings come from real support data" and remove the rest of the sentence
>
> -Segment 4: remove the progress bar. Show the diagrams for the 3 runs earlier (along with the second sentence calling out the three scenarios?). Change "grade A"/"grade B" to "output A"/"output B". Move the "run" bubbles higher to give move space for the arrows
>
> -Segment 5: round the counts to the nearest 5. We don't need to be so specific. Change "interview stops and asks" to "interview clarifies scope"
>
> -Segment 7: can we add the webpage screenshots here?
>
> -Segment 8-this seems like a soft ending. We should punch it up and not call out any failures
>
> -can we add chapters or something to the video for marking the segments easily or for skipping forward? Can we add subtitles as well?

**Answer at plan L1411:**

> *Asked:* For segment 8's ending: keep the prompt-injection catch but reframe it as the harness succeeding, or cut it entirely and end on the metrics?
>
> User selected: Reframe it as a win — the eval caught a safety regression before the PR (Recommended)

| ID | Seg | The user's words (excerpt) | Class | Fixed by |
|---|---|---|---|---|
| R2-01 | 1 | the unit test bubbles are still too close together. Space them apart futher and make the arrows smaller | craft | `apply-review-2.mjs`, "1 · hard" |
| R2-02 | 2 | can we actually show the JSON object instead of these and then highlight the portion that we're looking at? | craft | `apply-review-4.mjs` |
| R2-03 | 3 | there's a goofy spot where it darkens the screen when discussing r4. We don't need to do that. | craft | `apply-review-2.mjs`, "3 · freeform" |
| R2-04 | 3 | Update the "Phrasings come from real support data" and remove the rest of the sentence | craft | `apply-review-2.mjs`, "3 · freeform" |
| R2-05 | 4 | remove the progress bar. | craft | `apply-review-2.mjs`, "2 · many" |
| **R2-06** | 4 | Show the diagrams for the 3 runs earlier (along with the second sentence calling out the three scenarios?) | **objective** (rule T) | `apply-review-2.mjs`, "2 · many"; re-timed by `apply-review-5.mjs` |
| R2-07 | 4 | Change "grade A"/"grade B" to "output A"/"output B". | craft | `apply-review-2.mjs`, "2 · many" |
| R2-08 | 4 | Move the "run" bubbles higher to give move space for the arrows | craft | `apply-review-2.mjs`, "2 · many" |
| R2-09 | 5 | round the counts to the nearest 5. We don't need to be so specific. | craft | `apply-review-3.mjs`, "5 · dimensions" |
| R2-10 | 5 | Change "interview stops and asks" to "interview clarifies scope" | craft | `apply-review-2.mjs`, "4 · dimensions" |
| **R2-11** | 7 | can we add the webpage screenshots here? | **objective** | Never: the capture was blocked at sign-in (build L3788) |
| R2-12 | 8 | this seems like a soft ending. We should punch it up and not call out any failures | craft | `apply-review-3.mjs`, "8 · loop" |
| R2-13 | — | can we add chapters or something to the video for marking the segments easily or for skipping forward? Can we add subtitles as well? | not about this video | The chapter and subtitle stages (build L3598) |

**R2-06** (segment 4, `many`)

- *Evidence:* the narration (`script.md` L53) says "On screen, three result strips for one
  scenario land on three different grades". "screen" is spoken at 12.00 s. The three
  strips are revealed at 16.44, 17.42 and 18.40 s, so the narration calls them on screen
  4.45 s before the first one appears.
- *Passes:* 2. Pass 1's On-screen line (L55) says the strips reveal after the bar fills,
  but it gives no times.
- *Route:* OBJ-07, through its check procedure (see "Counts").
- *Lane:* none. Row 5 is visual events overlapping each other in time, not a visual that
  lags its narration.
- *Fixed:* `apply-review-2.mjs` moved the strips earlier. It overshot: at r5 they ran about
  5.5 s ahead of the narration, and `apply-review-5.mjs` re-timed them (Amendment 7,
  item 5).

**R2-11** (segment 7, `blindspot`)

- *Evidence:* the narration (`script.md` L83) says "Watch it drive the real U I, and a
  stage trace surfaces". "Watch" is spoken at 3.48 s. The segment is in `footage` mode
  with no clip, so it renders the fallback four-node stage-trace diagram, and no interface
  appears anywhere in it (still `blindspot.png`). The script's own On-screen line (L85)
  says so: "The clip has NOT been captured."
- *Passes:* 1 and 2. Pass 1 has the narration and the On-screen line. Pass 2 adds the
  storyboard and the still.
- *Route:* OBJ-07 (pass 2). Its rule text and its check procedure agree here. There is no
  pass-1 route: OBJ-07 runs in pass 2 only, and OBJ-08 needs an on-screen claim that
  contradicts the narration, which the diagram does not make.
- *Lane:* none.
- *Why objective:* the user asked for screenshots, which reads like a request for more.
  But the narration already tells the viewer to watch an interface that never appears,
  and that is not a preference.
- *Fixed:* never. r6 and r7 still say "Watch it drive the real U I" over the same diagram,
  and it was not reported again (see the appendix).

**Other classifications**

- R2-01: the `hard` still shows no overlap and no clipped arrowhead, so the spacing is a
  preference. The clipped arrowheads were r1's report (R1-04).
- R2-05: the bar is labelled "162 scenarios · running in parallel", so it explains itself
  on screen, and OBJ-11 does not apply. Removing it is a preference.
- R2-07: the strips are labelled "grade", and the narration says "grades". Renaming them
  is a preference. That "three different grades" is spoken over grades A, A and B is a
  separate matter, in the appendix.
- R2-10: the label reads "interview: stops, and asks", and the narration says the
  interview "must notice and stop". They agree, so the change is one of wording.
- R2-12: the answer at plan L1411 chose how: "Reframe it as a win".

## r6: P21 (commit-backed)

- **Render:** 09-26 17:20:38 UTC (build L6035), 3840×2160, from checkpoint #27.
- **Review:** P21 (plan L1441, 09-26 21:55 UTC).
- **Input set:** `9e20f3c`. It adds two timeline fields to the render's state, and both
  build a byte-identical scene (Amendment 7, item 7).

**P21** (plan L1441):

> a few more feedback items:\
> -can we easily add subtitles?\
> -the background music is a little loud, we can quiet that and raise the voice a little bit too.\
> -Segment 1: after mentioning postman, the background darkens and it highlights the "one case at a time." We don't need to do that.\
> -Segment 2 is good! Much preferred to show the structure. Add one more row to the "facts" list that says "I still have space left in my inbox." Can we keep the description field as well? Put it at the bottom of the json object, If it's too long, we can just keep the first sentence\
> -Segment 5: show the diagrams a little earlier. Space them out a little bit more\
> -Feedback for the demo generation scripts: we should ask more questions ahead of time. We should see how much of a point of view and what audience. How technical we should get VS educational VS entertainment\
> -Feedback for the demo generation scripts: I believe we should generally show the diagrams before we talk about them. I'm not sure if there's a "best practice" for this.\
> -Segment 6:Show the diagrams here a little sooner too.\
> -Segment 7: Space out the diagrams a little bit more. Make the arrows smaller. Another page where we're darkening the background and highlighting "workflow failed." Don't do that here either\
> -Segment 8: the diagrams are overlapping and hard to read. Space them out and make the arrows smaller. I think putting the "open the pull request" box further to the right of the loop and drawing the arrow pointing to that one from the "fix" box makes the most sense. Show it's the output after fixing. Remove the specific callout about the prompt injection, but change it to call out that we immediately see and fix any regressions as they happen in the code

| ID | Seg | The user's words (excerpt) | Class | Fixed by |
|---|---|---|---|---|
| R6-01 | — | can we easily add subtitles? | not about this video | — |
| R6-02 | — | the background music is a little loud, we can quiet that and raise the voice a little bit too. | not catchable before render | The audio mix, not the scene |
| R6-03 | 1 | after mentioning postman, the background darkens and it highlights the "one case at a time." We don't need to do that. | craft | `fc8dece`: the spotlight becomes an emphasis, in every segment |
| R6-04 | 2 | Add one more row to the "facts" list that says "I still have space left in my inbox." | craft | `fc8dece` |
| R6-05 | 2 | Can we keep the description field as well? Put it at the bottom of the json object, If it's too long, we can just keep the first sentence | craft | `fc8dece`: kept to its first sentence, but above `assertions`, not at the bottom |
| R6-06 | 5 | show the diagrams a little earlier. | craft (rule T) | `fc8dece`, re-timed |
| R6-07 | 5 | Space them out a little bit more | craft | Not re-laid out; arrowhead size 10 → 6 |
| R6-08 | — | Feedback for the demo generation scripts: we should ask more questions ahead of time. | not about this video | — |
| R6-09 | — | Feedback for the demo generation scripts: I believe we should generally show the diagrams before we talk about them. | not about this video | — |
| **R6-10** | 6 | Show the diagrams here a little sooner too. | **objective** (rule T) | `fc8dece` |
| R6-11 | 7 | Space out the diagrams a little bit more. Make the arrows smaller. | craft | Not re-laid out; arrowhead size 10 → 6 |
| R6-12 | 7 | Another page where we're darkening the background and highlighting "workflow failed." Don't do that here either | craft | `fc8dece` |
| **R6-13** | 8 | the diagrams are overlapping and hard to read. Space them out and make the arrows smaller. | **objective** | `fc8dece`: the loop is rebuilt (14 nodes) |
| R6-14 | 8 | I think putting the "open the pull request" box further to the right of the loop and drawing the arrow pointing to that one from the "fix" box makes the most sense. Show it's the output after fixing. | craft | `fc8dece` |
| R6-15 | 8 | Remove the specific callout about the prompt injection, but change it to call out that we immediately see and fix any regressions as they happen in the code | craft | `fc8dece` |

**R6-10** (segment 6, `twotier`)

- *Evidence:* the narration (`script.md` L73) opens "Two harnesses, and the lanes on screen
  fill against the same clock", and later says "The lower lane, labelled A P I, clears all
  hundred and sixty-two". "screen" is spoken at 1.55 s, and "labelled" (A P I) at 10.83 s.
  The interface lane is revealed at 1.78 s, but the API lane only at 12.93 s. That is
  11.38 s after the narration says the lanes are on screen, and 2.10 s after it calls the
  lane "labelled A P I".
- *Passes:* 2.
- *Route:* OBJ-07, through its check procedure (see "Counts").
- *Lane:* none.
- *Fixed:* `fc8dece` reveals both lanes at 0.24 s and 0.48 s (r7's `timing.json`).

**R6-13** (segment 8, `loop`)

- *Evidence:* in the still `loop.png`, the edge from "re-run" back to "run the suite × 3"
  is drawn straight through the "→ open the pull request" box, and two arrowheads collide
  in the gap in front of "read the delta". The node geometry in `timing.json` agrees. The
  box spans x 700–990 and y 112–186. A straight line between the centres of "re-run"
  (x 1050, y 112, 200 × 74) and "run the suite × 3" (x 390, y 20, 270 × 74) passes through
  the box from x ≈ 899 to x = 990. `audit.txt` reports "layout issues: none", because the
  audit checks overflow and clipping, not one element crossing another.
- *Passes:* 2.
- *Route:* none. No rubric rule covers one diagram element drawn over another. OBJ-14
  covers subtitles over content, and "Covered by the pipeline" gives the engine only
  elements overflowing or clipped by their container or the frame. Only `UNLISTED` can
  raise it, and `UNLISTED` is never BLOCKING.
- *Lane:* none. Row 4 is overflow and clipping, so a coach that leaves this to the engine
  scores an ordinary miss, not a lane miss.
- *Fixed:* `fc8dece` rebuilt the loop (14 nodes).

**Other classifications**

- R6-06: the narration of `dimensions` never speaks of the rows as present. Each row is
  revealed between 1.24 and 1.62 s after its sentence starts (d1 at 2.89 s, d2 at 6.75 s,
  d3 at 11.56 s). Under rule T that is craft.
- R6-07 and R6-11: the `dimensions` and `blindspot` stills show no overlap and no
  clipping, so the spacing is a preference.
- Not a finding: "Segment 2 is good! Much preferred to show the structure."

## r7: P26, with P24 (commit-backed)

- **Render:** 09-26 22:56:00 UTC (build L7859), 3840×2160, from checkpoint #36, which is
  `fc8dece`.
- **Review:** P26 (plan L1654, 09-27 17:53 UTC), and P24 (plan L1596, 09-27 02:52 UTC) on
  the audio. The answer at plan L1675 says nothing else was outstanding.
- **Input set:** `fc8dece`, with its committed engine (Amendment 7, item 8). Its
  `script.md` and `storyboard.html` are partly stale (Amendment 6, item 2).

**P26** (plan L1654):

> feedback:
>
> -segment 2: we're still saying "3 authored facts" when it's 4. We should update that part

**P24** (plan L1596):

> the background music needs to be a bit quieter

**Answer at plan L1675:**

> *Asked:* Do you have other changes to batch with this, or should I spend the render on the facts fix alone?
>
> User selected: Render now — this is the only outstanding change

| ID | Seg | The user's words (excerpt) | Class | Fixed by |
|---|---|---|---|---|
| **R7-01** | 2 | we're still saying "3 authored facts" when it's 4. We should update that part | **objective** | `ffe3f82`, which is not on this branch |
| R7-02 | — | the background music needs to be a bit quieter | not catchable before render | The audio mix, not the scene |

**R7-01** (segment 2, `scenario`)

- *Evidence:* the narration (`script.md` L33) says "Three authored facts this customer
  knows and will say if asked", with "Three" spoken at 19.28 s, and lists three. The
  segment shows four: the still `scenario.png` has four rows in `facts`, and no numeral.
  The script's own On-screen line (L35) says "Four authored facts are shown."
- *Passes:* 1 and 2. Pass 1 has the narration and the On-screen line. Pass 2 adds the
  still.
- *Route:* OBJ-08 (both passes): the on-screen content, as the On-screen line and the
  still give it, contradicts the narration. OBJ-04 (pass 2) as well, if a count of
  rendered rows is read as an on-screen number, because the still shows four rows but no
  numeral.
- *Lane:* none.
- *Fixed:* `ffe3f82`.

## r1: P8, with P9, P13, P15 and P16 (descriptive only)

- **Render:** 09-25 02:55:05 UTC (build L1860), 1920×1080, from checkpoints #5–#7.
- **Review:** P8 (plan L768, 09-25 21:35 UTC), with P9 (L858), P13 (L1107), P15 (L1151)
  and P16 (L1196), and the answers at plan L803, L919 and L1226 (Amendment 7, item 9).
- **Input set:** checkpoint #7, extracted after this key (Amendment 7, item 9).
- r1 is reported on its own and counts toward neither bar (README, "Why r1 is descriptive
  only").
- **r1's segment numbers are the user's.** r1's render had its own segment order, so the
  extraction maps each number to a segment id. An item whose segment is not in r1's inputs
  is *not in these inputs*.

**P8** (plan L768):

> A few points of feedback on the video:
>
> -I've tweaked a few things in the storyboard-edit file, but I haven't gotten through everything yet. I'll tweak a few more things after we finish with the feedback here, but it'll likely be updated pretty heavily\
> -what other options do we have for background music? I'm still not a fan of the organ-like synth waves. This website has royalty free background music: [link omitted]\
> -the target resolution should be 1920x1200\
> -Segment 1: we can space things out a little better. It looks like the arrows are getting cut off and the animation is a bit compressed\
> -how do I edit the storyboard? Can I edit the html for you to read back?\
> -Idea: Add a title/intro page with my name (no narration, just a starting page)\
> -let's avoid the "behavior suite" I think it complicates things.\
> -Segment 3: we should show the scenario object too. Highlight the bits we're talking about as we talk about them. We can likely spend more time here explaining how this works. Maybe we can choose a more interesting scenario as well\
> -We should also spend time on explaining how we respond to free-form/ LLM generated questions. Using the knowledge bank, etc
>
> -some good stuff in this demo: [link omitted]\
> -and this demo: [link omitted]

**Answer at plan L803:**

> *Asked:* I can't open either reference demo — both are auth-gated SharePoint Stream links, and I can't watch video regardless. What specifically did you like about them? (e.g. pacing, real screen recordings vs motion graphics, on-screen text style, how they introduce concepts, colour/visual polish)
>
> User responded: -nevermind, I'll give detailed feedback instead\
> -For the audio choice, we should collect a few website options for copyright free music, then have me (or the person using this) select one from the website or generate the synth music. It can be one of the choices and we should be able to swap them around easily.\
> -for the resolution, keep the 16:9, but change to 4k instead of 1080\
> -for the titlecard, we should add it as a fix to the engine, but leave it out for now. We can add it as a point of feedback for the repo edit session.\
> -feel free to ask any more clarifying questions

**P9** (plan L858):

> -the youtube audio library is fine. We checked and it is allowed
>
> -fading and trimming is not legally considered modifications; it's more-so splicing it and remixing
>
> -if the music track requires attribution, then make a note of us not being able to disable the end credit card (be sure to add the human making the video at the top. For this scenario it's me - [name omitted])
>
> -is the storyboard-edit.md file regenerated already?
>
> -for the music, let's use this track: [Corporate Ambient by Kulakovka | Royalty-free Music - Pixabay]([link omitted]) let me know if you need me to download it for you

**Answer at plan L919:**

> *Asked:* Since the Pixabay track needs no attribution, the end card is optional. Do you want it enabled anyway to credit you as the creator?
>
> User selected: No — keep the end card off, no credits

**P13** (plan L1107):

> -that hero scenario sounds good
>
> -let's keep it at 5:07 for now. We can tweak some things and see how to get it closer to 4
>
> -let me go through the storyboard and review now

**P15** (plan L1151):

> -For the video generation, is there any way to leverage the graphics card on this machine to speed up rendering? Or any other levers to pull to unlock resources?
>
> -For the Segment 1, "PPE" is a stage and not an endpoint. Saying it here is fine

**P16** (plan L1196):

> -I've updated the storyboard file
>
> -for segment 7, can we show the UI? the webpage is [link omitted] and we can simulate the same messages from the eval
>
> -let's re-calculate the length. If we're under 5 minutes, we can start the next steps (including the render)

**Answer at plan L1226:**

> *Asked:* The Playground URL contains the hostname `[host omitted]`, which would be visible in the browser address bar. You cleared the word "PPE" as a stage name, but a full hostname is the thing the no-go guard was actually built to block. How do you want to handle it on screen?
>
> User selected: Crop the address bar out — capture the page content only (Recommended)

| ID | Seg | The user's words (excerpt) | Class |
|---|---|---|---|
| R1-01 | — | P8: what other options do we have for background music? I'm still not a fan of the organ-like synth waves.<br>P9: for the music, let's use this track | not catchable before render |
| R1-02 | — | P8: the target resolution should be 1920x1200<br>A@plan L803: for the resolution, keep the 16:9, but change to 4k instead of 1080 | not about this video |
| R1-03 | 1 | P8: Segment 1: we can space things out a little better. | craft |
| **R1-04** | 1 | P8: It looks like the arrows are getting cut off | **objective** if the inputs show it, otherwise not catchable before render |
| R1-05 | 1 | P8: and the animation is a bit compressed | craft |
| R1-06 | — | P8: let's avoid the "behavior suite" I think it complicates things. | craft |
| R1-07 | 3 | P8: Segment 3: we should show the scenario object too. Highlight the bits we're talking about as we talk about them. | craft |
| R1-08 | 3 | P8: We can likely spend more time here explaining how this works. | craft |
| R1-09 | 3 | P8: Maybe we can choose a more interesting scenario as well | craft |
| R1-10 | — | P8: We should also spend time on explaining how we respond to free-form/ LLM generated questions. Using the knowledge bank, etc | craft |
| **R1-11** | 7 | P16: for segment 7, can we show the UI? | **objective**, craft or not in these inputs, as below |
| R1-12 | — | P8: Idea: Add a title/intro page with my name (no narration, just a starting page)<br>A@plan L803: for the titlecard, we should add it as a fix to the engine, but leave it out for now. | not about this video |
| R1-13 | — | P8: how do I edit the storyboard? Can I edit the html for you to read back?<br>P9: is the storyboard-edit.md file regenerated already?<br>P15: For the video generation, is there any way to leverage the graphics card on this machine to speed up rendering?<br>A@plan L803: For the audio choice, we should collect a few website options for copyright free music | not about this video |
| R1-14 | — | P8: some good stuff in this demo: [link omitted]<br>P9: the youtube audio library is fine. We checked and it is allowed … fading and trimming is not legally considered modifications … if the music track requires attribution, then make a note of us not being able to disable the end credit card | not about this video |
| R1-15 | — | A@plan L1226: Crop the address bar out — capture the page content only (Recommended) | not about this video |

**Resolved at extraction, by rules fixed here**

- **R1-04** is *objective* if r1's pass-2 inputs show an arrowhead cut off. Its lane is
  then row 4, overflow and clipping. If they do not show it, it is *not catchable before
  render*, because the stills are one frame per segment.
- **R1-11.** P16 came after the user had edited the storyboard, so "segment 7" may be the
  edited storyboard's numbering, not the render's. The extraction finds r1's segment about
  the interface harness.
  - If its narration speaks of an interface that no visual in the segment shows, the item
    is *objective*, as R2-11 is.
  - If it does not, the item is *craft*: a request for more visuals.
  - If r1 has no such segment, the item is *not in these inputs*.
- The result is recorded in `inputs.md`, with r1's extraction, before any coach run on r1.

**Other classifications**

- R1-05: "compressed" can mean cramped or rushed. Either way it is a judgement, and the
  reveal times are in the inputs.
- R1-14: P8's links point to reference demos, and P9's lines settle which music may be used
  and how it may be credited. None of them reports a defect in the render.
- Not findings:
  - P8's first line, about the user's edits to `storyboard-edit.md`. Those edits are not
    used (Amendment 7, item 9).
  - All three lines of P13: an approval of the hero scenario, a decision on the length, and
    "let me go through the storyboard".
  - P15's second line, which is the standing waiver (below).
  - P16's first and third lines: the storyboard was updated, and the length is to be
    re-calculated.
  - The first and last lines of the answer at plan L803, and the answer at plan L919,
    which is a choice, not a defect.

## Every message, accounted for

**The 26 plan-session messages**

| Where | Messages |
|---|---|
| In a round's review | P8, P9, P13, P15, P16 (r1); P20 (r2); P21 (r6); P24, P26 (r7) |
| Keyed outside any round | P17, P18, P22, P25 (below) |
| Feedback in no key | P4 (below) |
| No feedback | P1 (the request that started the project), P3 ("run it"), P5 ("check"), P7 (a question that P8 repeats), P10 and P11 (notes: where the music file was put, and to hold the render), P12 (the storyboard-edit file was closed) |
| Not typed by the user | P2, P6, P14, P19, P23: relays and notifications from other sessions |

**The 13 `ask_user` answers**

| Where | Answers |
|---|---|
| In a round's key | plan L803, L919, L1226 (r1); plan L1411 (r2); plan L1675 (r7) |
| Before the first render | build L526, L535; plan L274 (the brief), L336, L380, L603 |
| Neither | build L5926 (whether to watch r5's draft) and build L8548 (the ducking approach) |

**Keyed outside any round**

Amendment 7, item 10 keys these four with the class *not about this video*. None of them
answers a render, and item 3 places none of them in a review, so no round's table holds
them. A coach finding in any round may still be matched to one, and it then counts as
agreed, as any match does.

**P17** (plan L1256):

> Add a point of feedback for the repo for the levers to pull to speed up video rendering/encoding. Checking the different hardware and software options on the machine

**P18** (plan L1307):

> One other point of feedback that could be useful for these demo recordings in the future is intersplicing some stock videos. That can help make things look professional. I understand ClipChamp has some stock video/audio capabilities

**P22** (plan L1500):

> Feedback for demo generation: it might be good to generate the segments separately if we need to make tweaks after the fact. Often we don't have to tweak everything once we get that far, so we can re-use the existing video segments and just regenerate the bits that need to get fixed. Then overlay the video after which is cheap

**P25** (plan L1629):

> are you saying that in order to make the music quiet, but get louder in the gaps, we have to edit the music file? We can add tooling for that

| ID | The user's words (excerpt) | Class |
|---|---|---|
| P17 | Add a point of feedback for the repo for the levers to pull to speed up video rendering/encoding. | not about this video |
| P18 | One other point of feedback that could be useful for these demo recordings in the future is intersplicing some stock videos. | not about this video |
| P22 | Feedback for demo generation: it might be good to generate the segments separately if we need to make tweaks after the fact. | not about this video |
| P25 | we have to edit the music file? We can add tooling for that | not about this video |

**Feedback in no key**

P4 (plan L530): *"segment 4: we don't need to call out the fact it was sequential before. We
don't gain anything from it"*. It is feedback on the script before the first render, so it
falls in no round (Amendment 7, item 3). It is the one time the user acted as the kind of
pre-render reviewer this spike tests.

## Standing waiver

P15 (plan L1151): *"For the Segment 1, "PPE" is a stage and not an endpoint. Saying it here
is fine"*.

- Segment 1's narration in r2, r6 and r7 (`script.md` L23) says "Or deploy it all the way
  to PPE and test the larger interface by hand."
- The user has cleared the term's use there. The waiver does not say whether a viewer needs
  "PPE" explained, so a coach finding about that is judged like any unmatched finding.

## Appendix: seen while drafting, not keyed

These were noticed while checking the items above. Nobody searched for them, so the list is
not exhaustive. None is keyed, because the user did not report it. If the coach raises one,
the user judges it like any other unmatched finding.

- **r2 `many` (4):** "land on three different grades" (14.40 s) is spoken over strips graded
  A, A and B, which are two grades.
- **r2 `many` (4):** the slide's subtitle is an authoring note: "A filling bar, not a
  strobing grid." (`timing.json`, `visual.subtitle`; shown under the title in the
  storyboard and the scene).
- **r2 `twotier` (6):** the same lag as R6-10. "screen" is spoken at 1.55 s, and the API lane
  is revealed at 11.49 s. P20 did not mention segment 6.
- **r2 `loop` (8):** "Then the panel below the totals slides in" (24.95 s), but the panel
  sits to the right of the totals, as the script's own On-screen line (L95) says: "slides in
  on the right".
- **r2 `loop` (8):** the same edge crossing as R6-13. P20's segment-8 item is about the
  ending's tone.
- **r6 and r7 `blindspot` (7):** "Watch it drive the real U I" (3.48 s) still plays over the
  stage-trace diagram, with no interface. It was not reported again after P20.
- **r2, r6 and r7 `scenario` (2):** the Claims line (`script.md` L37) cites
  `scenarios.json:onedrive-data-loss`. The narration describes a scenario whose target is
  "Outlook, on iOS, not receiving email", and in r6 and r7 the slide's subtitle names the
  object shown: "id: outlook-ios-not-receiving".
- **r7 `scenario` (2):** the On-screen line (L35) says the description is "placed last", but
  `assertions` follows it.
- Defects that the README already discloses are not repeated: engine finding C-12's
  `NaN:NaN` badge and `t=NaNs` line, and r7's stale pacing line, `loop` subtitle and
  `c-caveat` claim.
