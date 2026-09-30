# 0006. Keep the video coach advisory-only, and graduate it into the demo pipeline

- **Status:** Accepted
- **Date:** 2026-09-30
- **Spike:** `spike/video-coach-backtest/`. The evidence below is in its `scoring.md` and
  `answer-key.md` at `b3cffb0`.

## Question

> Would a pre-render content coach, given only a round's pre-render artifacts (script,
> timing, storyboard, stills), have caught at least half of the objective defects the user
> reported across the EvalLoopDemo review rounds, with the user agreeing with at least 4 in
> 5 of its blocking findings?

## Context

Code has reviewers and the demo engine has audits, but nothing reviewed a video's
*content* until the user watched a draft. A full EvalLoopDemo render measured 42.4 minutes,
so a content defect found at the draft costs a round trip. The user proposed a coach that
reads the script and storyboard before anything expensive is rendered.

Whether that coach may **block** a render was the consequential question. A coach that
blocks wrongly stops the work and spends the user's trust; an advisory one costs reading
time. So blocking was something the coach had to earn, against a bar fixed with the user
before any coach output existed: recall ≥ 50 % **and** precision ≥ 80 % on BLOCKING
findings. If either was missed, the coach would stay advisory-only.

The test was a backtest. The EvalLoopDemo review rounds are an answer key nobody wrote for
this purpose: in each round the user watched a draft and said what was wrong, and the fixes
were committed. The coach (`.github/agents/video-coach.agent.md`, on `gpt-6-sol` because
Claude wrote the storyboards) was replayed on each round's pre-fix inputs at two moments:

- **pass 1**, the script, before TTS;
- **pass 2**, the script, timing, storyboard, stills and engine audit output, before frame
  capture.

Its rubric was written by the `research` agent, blind to the project. The commit order is
the proof: the rubric, the coach and the protocol (`ee835ad`) before the answer key, and the
answer key before any run.

## Options considered

1. **Let the coach block a render.** · Pros: an objective defect stops before the most
   expensive stage. · Cons: defensible only if the bar is met; a false block costs a round
   trip.
2. **Advisory-only, as a step in the demo pipeline.** The coach runs at both passes, and the
   user decides on each finding. · Pros: defects surface while a fix is cheap, and the user
   stays the only gate. · Cons: advice competes for attention, and every video pays for two
   coach runs.
3. **Park the spike** until more review rounds exist to test a revised rubric. · Pros: no
   new surface. · Cons: new rounds come only from making videos, and the coach would sit
   unused while they are made.
4. **Retire it.** · Pros: the least surface. · Cons: discards a coach whose blocking
   findings the user agreed with every time.

## Evidence

From `scoring.md`, which the spike's scorer computes from the committed records and the
user's 25 scoring answers:

| Set | Rounds | Recall (BLOCKING) | Precision | Bar |
|---|---|---|---|---|
| Commit-backed (governs) | r6, r7 | 1/3 (33.3 %) | 4/4 | not met |
| Reconstructed | r2 | 1/2 (50 %) | 2/2 | met |
| Pooled | r2, r6, r7 | 2/5 (40 %) | 6/6 | not met |

- **The answer is No.** The protocol says the commit-backed result governs when the sets
  disagree, and also that the bar is pooled over all scored rounds. The bar is missed under
  either reading. Recall at any severity is the same in every set, so ADVISORY findings
  caught nothing that BLOCKING missed.
- **The misses are structural, and the key predicted them.** Before any run, its "Counts"
  section named the objective items the rubric could not block:
  - **R6-13**, an edge drawn through a box in the `loop` diagram, has no BLOCKING route. No
    rule covers one diagram element drawn over another. The engine's layout audit checks
    overflow and clipping, not crossings, and it reported "layout issues: none".
  - **R2-06 and R6-10** are narration that calls a visual "on screen" 4.45 s and 11.38 s
    before it appears. They are reachable only through OBJ-07's check procedure, which
    looks "at that timestamp". OBJ-07's rule text asks whether the visual appears
    "anywhere in that segment", and both do.

  The coach caught both items that had a direct route (R2-11 and R7-01), and none of those
  three. The failure is in the rubric's rules, not in the coach's reading of them.
- **When it blocked, the user agreed, but on few distinct observations.** 3 of the 4
  commit-backed BLOCKING findings, and 4 of the 6 pooled, are one observation: in segment
  `many` the narration says three result strips land on "three different grades" (later
  "outputs"), and the strips show two. The user never reported it. The coach raised it in
  every round, and the user judged it a valid defect every time. So precision rests on two
  distinct observations in the governing set and three pooled, and the most repeated is a
  real defect that four review rounds missed, which recall does not count.
- **The same observation is graded differently from round to round.** The coach rated its
  "Watch it drive the real U I" finding BLOCKING in r2 and r1, and ADVISORY in r6 and r7.
  The user judged the CRAFT-02 finding a false alarm, taste and valid in three rounds, and
  the `ids` finding two different ways. No single report shows this.
- **The evidence is thin.** The governing set has three objective items, and one more catch
  would have met the bar. Only 5 of the 30 scored review items were objective; 19 were
  craft, which the coach may not block on at all.
- **Contamination is disclosed, not eliminated.** The orchestrator (Claude) knew the answers
  when it wrote the coach's instructions and the rubric brief, and it asked every scoring
  question with the key open. The brief is committed verbatim and contains no example from
  any round. Every judgment is one user's, given once. Run 4 stands under Amendment 9, and
  the answer does not change without it.

## Decision

**The coach does not gate a render.** A BLOCKING finding is its strongest advice, and the
user decides on every one. The render approval gate stays the user's alone.

**The coach graduates into the demo pipeline as an advisory step**, by the user's decision
on 2026-09-30: pass 1 before TTS, and pass 2 before frame capture. It is rebuilt under
Tier 2 gates, not moved (constitution §XI).

The evidence supports keeping it. It caught both objective items it had a rule for, it found
a valid defect that four review rounds missed, and the user agreed with every BLOCKING
finding they judged. The evidence does not support letting it block. It missed the bar, and
the misses show holes in the rubric that no coach can see past.

## Consequences

- **The rubric's known holes travel with it** unless the graduation fixes them: OBJ-07's
  check procedure and rule text disagree, and no rule covers one diagram element crossing
  another. A fix is legitimate for an advisory coach. It is fitted to the misses that
  exposed it, though, so these rounds cannot test it.
- **Blocking authority can be reconsidered only on new rounds.** A revised rubric would need
  review rounds it was not revised from, a bar fixed before its runs, and the same
  commit-order proof.
- **"BLOCKING" no longer means blocks.** From this ADR on, the agent file and both agent
  rosters say the coach is advisory. The word still over-promises, and the graduation
  decides whether to keep it.
- **The rubric lives in the spike,** and nothing outside `spike/` may depend on it (§XI).
  The graduated step needs its own rubric, reviewed under the gates, not a path into the
  spike.
- **Repetition is a cost the graduation has to answer.** The coach raised the same finding
  in every round, and graded one observation two ways. A step that shows each report fresh
  will re-ask settled questions. A step that remembers rulings must not let an old ruling
  excuse a new defect.
- **Neither lane catches one element drawn over another.** R6-13 passed both the coach and
  the engine's layout audit. That is an engine gap as well as a rubric gap.
- **The spike stays** as the reference for the rubric and the protocol until the graduated
  step lands, as `playwright-ui-capture` does for ADR 0003.
