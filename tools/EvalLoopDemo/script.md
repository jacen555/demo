# How do you test a conversation?

**Audience:** engineering leadership / partner-level
**Final length:** 4:36 · no end card · 16:9 · 3840×2160 @ 30fps (live)
**Voice:** en-US-AndrewNeural @ 1.2× · **Engagement:** rich · **Background:** white
**Approval owner:** jonosace · **Words:** 929 · **Measured rate:** 3.519 words/sec

> Hundreds of simulated customers, each with their own knowledge of their own problem, run against a pull-request branch before anyone opens the review.
>
> **End card is OFF** — the canonical disabled form, in which `builderVersion`, `contentMs` and
> `outroMs` are all **absent** and `durationMs` (276528 ms) is the last segment's `endMs`.
> Nothing is padded or appended.
>
> **Measured pacing** (decoded, not metadata): lead-in 2.04s against a 2.0s target; perceived inter-segment gaps 1.80–1.90s (mean 1.84s) against a 1.5s target — see render-log.md.
> **Timings below are measured** — each segment was synthesised, the real audio measured, and the timeline reflowed onto it.

Claim types: `direct` = read straight from a source · `derived` = computed from sources.

---

### 1 · `hard` — One assert, or ten branching turns · 0:01–0:27 · 25.8s · 98 words

> A unit test is easy. One input, one answer; and the same answer every time. Now try testing a conversation. On the right of the screen, the interview branches for each turn. When you run it again, a different branch occurs. There is no single assert to check. So how did we check it? One case at a time. Type an opening into Postman, read the reply, type the next. Or deploy it all the way to PPE and test the larger interface by hand. It was so slow that customers were finding the regressions before we did.

**On screen:** **Animated split diagram.** Left column, a three-node unit test revealed and settled instantly. Right, the interview tree branches from the opening turn; the active path pulses once, then pulses again down a DIFFERENT branch to show the same input taking a different route. Below, a two-node loop cycles slowly with low-density particles. No numbers on screen. RE-LAID OUT TWICE: the unit-test column now sits at ~96px vertical gaps (was ~50, originally ~20) and arrowSize drops to 6, because the heads were visually dominating the short edges between tightly-stacked boxes. Verify against a rendered frame at 1:1 — the storyboard letterboxes differently.

**Claims:** `c-before` direct (content-owner:stated (jonosace))<br>`c-flip` direct (interview-eval/README.md:One run is not a measurement · contextlayer-eval/README.md:Replication)

---

### 2 · `scenario` — One scenario, field by field · 0:29–1:20 · 51.8s · 184 words

> Let's look at one specific scenario definition. The opening is what the conversation starts with: my email has just stopped working. That is deliberately vague, because that is how people actually write. Underneath it sits the target: Outlook, on iOS, not receiving email. The interview never sees that, we are using it to grade once the conversation ends. Then we have the knowledge bank. Three authored facts this customer knows and will say if asked: that they are using the mail app on an iPhone; that they can still send messages, but nothing new ever arrives; and that they have checked junk, and the mailbox is not full. Notice the second one. Can send, cannot receive — that is the detail separating this from a dozen neighbouring categories, and the interview only learns it if it thinks to ask. Then a pool of alternative phrasings, so the customer can choose different phrasings to not repeat every time. And last, the assertions this scenario has to satisfy. That is what makes it a conversation and not a prompt. We have defined nearly two-hundred of them.

**On screen:** The real scenario object from scenarios.json, rendered as syntax-highlighted JSON. Six fields are outlined and the rest dimmed, one at a time, each landing on the word that names it: opening, targetPath, the facts array, the second fact, answerPool, assertions. Four authored facts are shown. Internal ids are removed and the 13 alternative phrasings are elided to a count, since they derive from real support data; the taxonomy description is kept to its first sentence and placed last.

**Claims:** `c-scenario` direct (interview-eval/scenarios.json:onedrive-data-loss (opening, targetPath, facts[3], answerPool[11], assertions[3]))<br>`c-suite` direct (interview-eval/scenarios.json:162 objects, counted by kind)

---

### 3 · `freeform` — The interview invents the questions. The customer still has to answer. · 1:22–2:08 · 46.5s · 170 words

> But here is the hard part: the thing being tested is a language model. It writes its own questions, and it will ask things nobody anticipated. A script of canned answers can fall apart on the first unexpected turn. So the simulated customer answers by rule, in priority order. If the question offers choices, and those choices carry routing data, it picks the one whose route runs closest to its own target. If the choices are platforms, it answers with the platform it is actually on. If it is any other multiple choice, it scores each option against its own vocabulary. And if the question has no choices at all — free text, invented on the spot — it draws the next unused line from its knowledge bank. One guard matters more than the rest. The customer will never name a platform it is not on. Those phrasings come from real support data. Matching is on word boundaries — which is why Xbox Game Studios is not an iOS case.

**On screen:** **A priority ladder builds top to bottom**, one rung per rule as the narration names it. The free-text rung is the one the segment is really about. The screen-dimming spotlight was removed at review. Rungs carry numbered step badges rather than connecting arrows — the gaps are too tight for arrowheads to draw cleanly. Then the guard lands underneath as three stacked panels, with the Xbox Game Studios example legible as text — the joke only works if it can be read.

**Claims:** `c-strategies` direct (interview-eval/README.md:What it does — strategy table (route, family, platform, leafRoute, overlap, freeText))<br>`c-platformguard` direct (interview-eval/README.md:If you regenerate the suite — match on word boundaries, Xbox Game Studios is not an iOS case · contextlayer-eval/README.md:The scripted customer — one guard carries over verbatim)

---

### 4 · `many` — Independent scenarios run in parallel — three times each · 2:10–2:38 · 28.7s · 99 words

> Each of the hundreds of scenarios opens its own conversation and shares no state with any other, so they can go out in parallel. And we run every scenario three times, because the same input doesn't give the same answer twice. On screen, three result strips for one scenario land on three different outputs, and an average line resolves between them. Replication across this suite showed the same scenario changing grade from one run to the next, for no reason at all. So we average across three runs, and a real change is separated from the model's own noise.

**On screen:** **Three run strips for ONE scenario reveal early**, landing with the narration's second sentence, labelled output A / output A / output B so the divergence is carried by a letter rather than a colour. An average node resolves beneath them. The progress bar was removed at review — it was not earning its place. Run bubbles sit high to give the edges room.

**Claims:** `c-parallel` direct (interview-eval/README.md:Parallelism — full 75-scenario suite at ~74 s with 10 workers)<br>`c-suite` direct (interview-eval/scenarios.json:162 objects, counted)<br>`c-flip` direct (interview-eval/README.md:~20% per-scenario grade-flip rate · contextlayer-eval/README.md:Replication)

---

### 5 · `dimensions` — Several different questions, graded separately · 2:40–3:15 · 35.2s · 118 words

> And it is not grading one thing. Did the interview reach the right category — sixty-seven scenarios on that. Did it ask for the context it needed — fifty more, drawn from real customer queries. Does it repeat itself or leak across products — forty-five. And the sharpest one: does it refuse what it should, without refusing what it shouldn't? A customer opens about Outlook, then asks how to order a pizza. The interview must notice and clarify scope. But it must not refuse ordinary requests that merely sound odd — someone overriding an inbox rule. Across all hundred and sixty-two scenarios: around a hundred and thirty-five must not refuse, a handful must, and zero counted in both.

**On screen:** **Three dimension rows build down the left**, each with its scenario count, as the narration names them. Then the two-turn exchange builds on the right — the customer's opening, the off-topic follow-up, and the interview stopping to ask. Then the false-positive guard line appears beneath it. Finally four counters land across the bottom. The counters are labelled in words, never by colour. The guard example is authored BDD test data, not real customer text.

**Claims:** `c-suite` direct (interview-eval/scenarios.json:67 l5-descent + 50 golden-disambiguation + 45 review-repro, counted)<br>`c-pizza` direct (out_of_scope_interview.feature:An off-topic follow-up is questioned, not routed · out_of_scope_interview.feature:Ordinary support text is never refused)<br>`c-polarity` **derived** (contextlayer-eval/README.md:Validated across all 162 scenarios — 0 conflicts, 7 / 134 / 21. SPOKEN ROUNDED at user request: 134 as "around a hundred and thirty-five", 21 as "~20" on screen, 7 as "a handful" (rounding 7 to 5 would assert a 29% error). 0 conflicts is exact and unrounded.)

---

### 6 · `twotier` — The fast tier gates the branch · 3:16–3:37 · 20.4s · 67 words

> Two harnesses, and the lanes on screen fill against the same clock. The upper lane, labelled U I, clears thirteen scenarios in three runs each — about three and a half minutes. The lower lane, labelled A P I, clears all hundred and sixty-two in less time than that. So the fast tier is the pull-request gate; the interface harness cannot target a pull-request build at all.

**On screen:** **Two labelled lanes fill against a shared clock** — the interface lane slowly, the API lane densely. Each lane carries its own text label, so the comparison never depends on colour, and both labels are spoken. No numeric clock appears on screen: the only time figure shown is the interface lane's '~3.5 min', which the narration states.

**Claims:** `c-tiers` **derived** (contextlayer-eval/README.md:Usage — 13-scenario subset, 3 replicates, 4 workers (~3.5 min) · interview-eval/README.md:Parallelism — 74 s at 10 workers for 75 scenarios, scaled to 162)<br>`c-nopr` direct (contextlayer-eval/README.md:What this harness cannot do — evaluate a pull request)

---

### 7 · `blindspot` — Correct category, right agent — and resolution failed anyway · 3:38–4:00 · 21.5s · 75 words

> But the slow tier sees something the fast one is structurally blind to. Watch it drive the real U I, and a stage trace surfaces: running Outlook Q and A agent, agent completed, workflow failed. The interview got the category right, the right agent was picked, and resolution failed anyway. The customer got a canned refusal. The fast tier stops at the category and cannot say any of that. Different data, not just slower data.

**On screen:** **APPROVED AT THE GATE (Q2): a 5-8s screen capture of the interface harness driving the real Playground**, then the stage trace. Split out of `twotier` because write-build-html resolves `footage` per SEGMENT, not as a mid-segment overlay — a 7-segment cut could not carry it. The clip has NOT been captured. Until one is registered `approvedForUse: true` + `redaction: "clear"` in `evidence-pack/footage/clips.json`, this segment degrades safely to the four-node stage-trace diagram below, which is why the nodes are authored. Redaction is a light pass — the scenarios are authored test data with no personal information — but account chrome and any hostname must still be off-screen.

**Claims:** `c-uiblind` direct (contextlayer-eval/README.md:Why a second harness — Running: Outlook QnA Agent -> completed -> Workflow failed, reproducing 3/3)

---

### 8 · `loop` — The comparison exists before the pull request does · 4:01–4:36 · 34.9s · 118 words

> We deploy the pull-request branch, point the harness at it, and run it three times. Then the same suite against main, and we diff the two. The comparison exists before the review does. On one real change, routing got clearly better. Cases reaching the right support area went from twenty-seven to thirty-five out of sixty-seven. Cases where the interview came back with nothing were almost halved. Twenty-six fewer failed assertions. And when something regresses, we see it immediately — in the same report, on the same run, while the change is still a branch. Not in production. Not in review. Before the pull request was ever opened. That is what this buys. Run it against your branch first.

**On screen:** The loop builds as it is narrated — deploy, run x3, read the delta, fix, re-run — and closes back on the suite. "Open the pull request" sits outside the cycle to the right, drawn from "fix", so it reads as the output of fixing rather than a step inside the loop. The three measured deltas land one per sentence on the left. The claim panel "REGRESSIONS SURFACE ON THE SAME RUN" is marked with a sustained outline as the narration reaches it, then the closing triad lands as three separate beats.

**Claims:** `c-win` direct (report-1602086-vs-1601897.html:L3 or better 27.0->35.0/67 (ranges 24-29 vs 34-37) · report-1602086-vs-1601897.html:Returned NO path 21.3->11.7/67 — spoken as "almost halved" · report-1602086-vs-1601897.html:Assertions failed delta -26.0 · report-1602086-vs-1601897.html:3 runs per arm)

---
