# Active Context — Forge

> **Last updated:** 2026-10-02

## Current focus

**SizzleCraft fixes T1–T5**, from the 2026-09-28 audit and §VIII reviews, approved by the user. Each is
built test-first on `claude-opus-5.5` and gated by a `gpt-6-sol` review. Alongside them,
**the video coach graduates as an advisory-only step**: its backtest answered No, and
ADR 0006 records why (below).

| Commit | What | Independent review |
|---|---|---|
| `a0add0b` | T1 — the scene audits fire (C-14 contrast, C-5 clipped code block); slides stay on their seams | **PASS** at round 3 |
| `cbac96b` | T2 — write-chapters and write-subtitles plan by default and confine their writes | **PASS** at round 2 |
| `b671a2e` | T3 — a baked bed is bound to its narration, crossfade is pinned, an undeliverable duck is refused | **PASS** at round 4 |
| `53424c2` | T4 — silence edits run in S4 without a re-voice: remix and concat-audio generate declared silence from the authored window; validate and the writers follow | **PASS** at round 8 |
| `d1d8d47` | F6 — voice checks its timeline before it writes anything, in plan and `--apply`: the segments' shape, every silence declaration, the narration text, and that some segment is narrated | **PASS** at round 2 |
| Q14 | remix's plan crashes on a timeline with no segment list, and remix never checks the segments' shape, which its gate checks first. The shape check also gains the schema's segment `id` rule, which closes gap 27's id-less crash | not started — spec, then approval |
| F7 | voice checks an enabled end card (`builderVersion`, outro length) before it writes anything — gap 27's other case | not started — spec, then approval |
| `assertCleanExit` | The test helper sees a crash from module-scope code | not started — spec, then approval |
| validate-scene | New pre-capture scene checks, from the consumer's 32 project tests | not started — spec, then approval |
| T5 | Documentation debt | not started |
| `c620c88` | Gain pin fails closed — `mix-parameters.mjs` registry, 7 pinned knobs | 2026-09-28 **FAIL** (pin reviewer; it also confirmed the commit's two round-1 fixes). Findings placed in T3 — round 2 **running** |
| `331ddac` | Deliberately silent segments — declared and captioned, never inferred | 2026-09-28 **FAIL** (silence reviewer, with `2e5a62e`). Findings placed in T1, T2 and T4 — round 2 **running** |
| `c3f1e56` | In-graph ducking of a licensed bed; envelope bound to its voiceover | 2026-09-28 **FAIL** (duck reviewer, with `34fa0e7`). Findings placed in T3, one in T5 — round 2 **running** |
| `34fa0e7` | Modelled gaps shortfall labelled MODELLED; measured values in help | Reviewed with `c3f1e56` |
| `2e5a62e` (consumer) | Subtitle options bounded; the stage plans by default | Reviewed with `331ddac` |
| `d71c605` | The consumer's code-block wrap (`ffe3f82`), with its CSS corrected | **None** until round 2, where the silence reviewer covers it |

**The third-pass commits had their cross-family review on 2026-09-28: three `gpt-6-sol`
reviewers, FAIL on all three.** Their findings, with the audit's, became T1–T5. The T1–T4
and F6 reviews cover their own diffs only, so **round 2** runs now, alongside Q14. It checks
that every 2026-09-28 finding was carried into the union, placed and closed (progress,
gap 22). Until 2026-10-02 this file said those commits had no review at all. That was
written before the verdicts arrived and never corrected. SizzleCraft: 883 tests (882 pass,
1 skip) at `d1d8d47`. `c620c88` reached `main` in PR #14 (`39b8312`). The user pushed the branch
through `013cdc8`, which is 27 commits past `main` with no PR yet. Everything after it, T4 and
F6 included, is local, and pushes from here return 403.

The 2026-09-28 audit ran on `claude-opus-5.5` (4 slices) at the user's request. It finds
defects, but **it does not satisfy §VIII**, so T1–T5 each carry their own cross-family
gate. Its headline — **the WCAG contrast audit had never fired** (C-14) — is fixed by
`a0add0b`. The thinner lanes it exposed are still open (progress, gap 25).

### Ducking — measured by the consumer on the real project

- **Depth ~10.4 dB delivered against an 11 dB solved target**, measured on the *isolated*
  bed. Speech masks the bed in the mix, so the mixed file cannot answer this question.
- **Gaps recover to within 0.05–0.11 dB.** The one-pole model predicted 0.67 dB — ffmpeg's
  release is faster than the model. The plan prints the model's figure, labelled MODELLED.
- **Release 800 ms is right.** 1500 ms leaves gaps 2.0–3.5 dB short; 2500 ms, 6.1–8.7 dB.
  Slowing release to reduce pumping looked like free headroom and was not — measured.
- **`--ceiling 2.0` delivers −1.1 dBTP** post-AAC; 1.0 delivers −0.3.
- Measure gap levels **inside true gaps**, not near segment boundaries.

### Video coach — the backtest answered No; it graduates as advisory-only

The user proposed a second reviewer for **content**: a coach that reads a video's script,
storyboard and stills before anything expensive is rendered. Before it could block a
render, it had to pass a backtest against the EvalLoopDemo review rounds
(`spike/video-coach-backtest`): recall ≥ 50 % and precision ≥ 80 % on BLOCKING findings,
a bar fixed before any coach output existed.

**The answer is No** (`b3cffb0`; [ADR 0006](../docs/adr/0006-keep-the-video-coach-advisory-only.md)).

| Set | Rounds | Recall (BLOCKING) | Precision |
|---|---|---|---|
| Commit-backed (governs) | r6, r7 | 1/3 | 4/4 |
| Pooled | r2, r6, r7 | 2/5 | 6/6 |

- **The misses are the ones the answer key predicted.**
  - No rubric rule covers one diagram element drawn over another (R6-13). The engine's
    layout audit misses it too.
  - OBJ-07's check procedure and its rule text disagree (R2-06, R6-10).
  - The coach caught both objective items it had a direct rule for.
- **Precision rests on few distinct observations.** 3 of the 4 commit-backed BLOCKING
  findings are one count defect in segment `many`. The user never reported it, and judged
  it valid every time the coach raised it.
- **That defect may still be live.** `tools/EvalLoopDemo/script.md:53` still says the
  three strips "land on three different outputs", while the storyboard emphasises "the one
  that differs". It is the consumer's to judge, and it has not been reported to them yet.
- **Disposition: graduate**, the user's decision on 2026-09-30. It becomes an advisory step
  in the demo pipeline, pass 1 before TTS and pass 2 before frame capture. It is rebuilt
  under Tier 2 gates with its own reviewed rubric, and it never gates a render.
- **Plan approved 2026-09-30, on the user's five design answers. Not started**; queued as
  G1–G7 after T5 and Prettier. The rubric carries over with both holes fixed: OBJ-07 checks
  the spoken moment against a measured tolerance, and a new rule, OBJ-19, covers one
  element drawn across another. A new SizzleCraft stage collects the inputs, refuses
  stills older than what they show, and writes a hash manifest the report cites. The
  rubric lives beside that stage. BLOCKING becomes DEFECTS. Repeated findings match a
  committed per-project rulings file by rule, segment and exact quoted text, and the
  coach never sees that file.
- **Only learnings went in git.** The rubric, the protocol, the answer key, the hash
  ledgers, the scorer and `scoring.md` are committed. Extracted inputs, stills and coach
  reports are output, and stay out.

## Where the harness stands (paused since 2026-09-24)

| Task | State | Tests |
|---|---|---|
| T0–T2 scaffold, model pins, CSharpier | done | — |
| T3 contracts, seams, canonical serialization | done | 309 |
| T4 assertion evaluators | done | 553 |
| T5 deterministic caller | done | 597 |
| T6 REST runner + MCP stub | done | 694 |
| T7 LLM runner, caller, `ILlmClient` seam | done | 824 |
| T8 coordinator + `Ui` kind stub | done | 1049 |
| T9 aggregator + statistics seam | done | 1263 |
| T10 comparator + baseline providers | done | 1421 |
| T11 impacted-selection matcher | done | 1527 |
| T12 CLI skeleton | done | 244 (cli) |
| T13 discovery + selection wiring | done | 282 (cli) |
| T14 artifacts + baseline comparison | done | 308 (cli) |
| T14a coverage withholding (engine) | done | 1545 |
| T14b CLI pass-through | done | 313 (cli) |
| T15a PR comparison report | done | 442 (cli) |
| T15d machine-path refusal at load | done | 1657 |
| T15f CLI consequences of T15d | done | 442 (cli) |
| T15e stop printing the caller's suite path | done | 1724 |
| T16 ADR 0004 + 0005 | done | — |
| T17 memory bank | done (`f388b4c`) | — |
| T15b trend report | not started | — |
| T15c per-scenario withholding attribution | not started | — |
| T15g `scriptedStimuli[].field` classification | not started | — |
| T15h three CLI-owned absolute paths | not started | — |

**Repo-wide green: 1724 engine + 442 CLI = 2166.** Commits `ac6ff11`, `8f52efa`,
`fe65696`, `708cd0b`, `c2d980e`, `c8e1f7a`.

Remaining: the trend report (T15b) and four tracked follow-ups, none blocking.

## Decisions taken during the build

- **`eval-cli` emits report files; CI posts them.** No GitHub API, no token, no network in
  the tool — §V stays simple and the harness works outside GitHub.
- **A suite cannot assert on a `3xx`.** Redirects are raised as failed requests, because a
  3xx left standing grades as an answer — and against a redirecting *baseline* address that
  marks every scenario `Fixed` and prints "newly covered: everything". See
  `RedirectRefusingHandler`. Revisit as a new scenario kind if redirect assertions are ever
  needed; do not loosen the transport.
- **Machine paths are refused at authoring time, not filtered in the report** — ADR 0005.
  The report-side pattern was written five times and ended up failing in both directions at
  once. The report keeps a narrow net whose holes are published in its README.
- **The harness is report-only.** `--fail-on-regression` is inert and exit codes `10`–`19`
  are reserved. Gating is a later decision once the reports have been trusted in practice.
- **§I was amended** so a domain's `README.md` belongs to its domain (`fe65696`).

## The design idea everything rests on

**Every runner produces the same kind-agnostic `Transcript` + `Outcome`.** Everything
downstream — assertions, aggregation, comparison, reporting — operates only on those two
types. REST-once is the degenerate one-turn case of the same pipeline, not a separate code
path; a conversation loop is an emergent composition of a multi-turn participant and a
terminal condition. `KindAgnosticismGuardTests` enforces it.

Core vocabulary is `stimulus` / `response` / `turn` / `terminalCondition` — never
`question` / `answer`. If interview-loop vocabulary reaches the core types, the "generic"
engine has quietly encoded one domain's assumptions.

## The recurring defect this project keeps producing

The cross-family reviewer has caught **the same false-green class at seven successive
layers**. Every instance is *evidence from one context graded as though it came from
another*:

1. T3 — the overrun guard fired only when an author *declared* a turn dependency
2. T4 — the evaluator then ignored that declared scope
3. T5 — the caller derived its position from an unverified transcript
4. T6 — a stale outcome survived into a failed final turn
5. T6 — stale transport attributes survived an omitted key
6. T6 — a broken *adapter* was graded as a broken *system*
7. T7 — the participant was never checked against the scenario's execution mode
8. T7 — the model could rewrite the scenario's authored opening

The UI spike hit the same class independently: its determinism control passed when it
should have failed, because a silently-discarded `page.evaluate` string made every check
vacuous — and a wrong conclusion had already been written before the tell was noticed.

**This is structural, not incidental.** Keep the cross-family reviewer on every remaining
task, and design each new layer against cross-context bleed rather than waiting for review
to find it.

## Open decisions

- **`TurnDependency` is a ceiling, not an exact turn** (turns with index ≤ T). Reasoning is
  sound — `SuiteValidator` documents an undeclared turn as "the last turn the run could
  reach", which only coheres under a ceiling reading — but T8+ build on it. Worth
  confirming.
- **`Ui` as a fourth scenario kind.** Stubbed in T8 (`NotImplementedUiRunner`), mirroring the MCP
  stub. Driven by Cortex adding UI interaction to its own eval loop. ADR 0003 proved deterministic
  scripted capture is achievable; the real runner is a later task.

  **Two findings from the parallel SupportSphere UI harness (`contextlayer-eval`), worth carrying
  into that task:**
  1. **The value proposition is post-classification failure.** That harness exists because the API
     eval is "structurally blind to a failure that happens *after* classification succeeds" — the
     interview lands a correct path, an agent is selected, and resolution then fails, so the
     customer sees a canned refusal. A UI kind earns its place by covering what a REST kind
     structurally cannot, not by re-testing the same surface through a browser.
  2. **A UI scenario may be structurally uncomparable for PR purposes.** That harness documents
     "what this harness cannot do: evaluate a pull request" — the Playground has no per-PR slot, PR
     builds deploy elsewhere, and nothing in the UI targets them. Our T10 comparator would refuse
     such a pairing as `NotComparable`, which is correct, but the *reason* should be documented on
     the UI runner rather than surfacing as a confusing refusal. A UI suite may be a
     point-in-time environment check rather than a before/after gate.

## Known open work

- **`SuiteLoader` path confinement** — accepted as a separate task, not fixed. Unix symlink
  following, a validate-then-open race, a volume-root separator bug. Fix before the harness
  loads a suite file an untrusted party can write.
- **`RestRunner` has no `try`/`catch` around `Participant.NextAsync`**, so a participant
  failure there takes down the suite — the asymmetry T7 fixed on the LLM side.
- **The scripted-prefix check is wired into the conversation runner only.**
- **`playwright-ui-capture` spike is `answered` but not graduated** — debt under §XI until
  the sibling capture script is built in `tools/SizzleCraft` under Tier 2 gates.
- **`eval-loop-demo` is rendered and verified — not merged in its latest form.** This branch
  holds the 4:42 cut. The consumer's branch holds a 4:37 four-facts cut with the ducked mix
  (rebased onto `013cdc8`; 13 local commits at `6ef6ca9`), which neither session can push. The first delivery was
  `EvalLoopDemo-with-music.mp4`, 4:10.63, narration within **0.27 dB** of the sibling video. Full render measured at
  **42.4 min** (S6 capture is 84% of it, at 2% dedup); an audio-only change is ~30 s.
  **Perceived gaps run ~335 ms long and were accepted deliberately** — both sibling videos
  carry the identical defect, so 1.83 s is continuity-correct. Fixing `voice.mjs` to decode
  tails would re-pace every future video against the three that exist; that is a series-wide
  decision, recorded as bug-ledger entry 13, not a silent correctness fix.
- **Driving the engine to the last stage found 10 defects, 6 of them fatal to any second
  consumer.** Worst: `validate-timing.mjs` read `ajv.errors` after `ajv.compile(schema)(t)`
  — always null — so schema validation was silently disabled for every project that ever
  ran it. Also `remux-music.mjs` and `check-levels.mjs` still had the sibling project's
  filenames hardcoded, which is exactly the disease the extraction claimed to have cured;
  they survived because **no second project had reached S8/S9**. Full ledger in
  `tools/EvalLoopDemo/render-log.md`.
- **T4's accepted follow-ups, not yet scheduled** (the T4 commit message lists them):
  remix's plan throws a TypeError for a timing.json with no `segments` list — T4 introduced
  that, where the plan used to exit 0; remix's plan still prints the shared "Re-run with
  --apply to proceed" after saying `--apply` would refuse; write-subtitles can repeat a word
  or a fact for a malformed declaration; validate-timing:607 calls re-running voice "the only
  route" even where voice would refuse; the four round-6 wording and bound items; the
  zero-file-ids preload's documented limits. **The user placed them on 2026-10-01:** the
  TypeError is Q14, next in the queue; the round-6 items and the three wording fixes go into
  T5. The preloads' limits were not placed.
- **F6's follow-ups, not yet scheduled** (the F6 commit message lists them):
  - **Two High defects, pre-existing, raised by F6's round-1 review.** Both plan as runnable
    (exit 0) and fail only after voice has written. Measured with the fake audio backends:
    - an enabled end card with an outro over 3,600,000 ms exits 1 after overwriting every
      clip; one with no `builderVersion` exits 1, with a stack, after overwriting every clip
      and `voiceover.mp3`;
    - a segment with no string `id`, narrated or silent, passes the gate; under `--apply`
      voice writes the clips up to and including that segment's, then crashes at
      `seg.id.padEnd` (exit 1).
  - The label for a segment with no id: voice and both gates print its 0-based index,
    quoted like an id (`segment "2"`); remix prints `segment "undefined"`.
  - The all-silent and shape refusals carry no remedy, so voice prints the fact alone.
  - voice's C-11 and brand allow-list failures are uncaught throws: exit 1 with a stack.
  - The README's exit-code table row for 2 does not mention a refused timeline.

  The user decides where the two Highs go.
- **Still open on the engine**: `render.preview` is declared in the template but no script
  implements it, `evidence-pack/` is resolved unconditionally at module load, and
  `voice.mjs` reflows segment windows but not segment-relative trigger times.
- **`assertCleanExit` cannot see a module-scope crash.** Its stack check matches only a
  frame with parentheses. A throw from module-scope code, which is where `voice.mjs` and
  `remix.mjs` do their work, prints `at file:///…:232:35`, with none, so the helper calls
  it clean. Measured 2026-10-01: widening the check changes none of the 867 tests. A
  control confirmed that the wider pattern does catch the module-scope frame. It also
  matches a line like `at 0:01:23`, so the fix should require a path-shaped token. Queued
  after Q14, in the user's order of 2026-10-01.

## Watch out for

- **Green is not reviewed.** I committed `c620c88` after a FAIL verdict without re-review,
  and three feature commits with no review at all, because the suites were green. The
  consumer had done the same three times, and their unreviewed engine changes produced 16
  findings — so the base rate was known before I repeated it. Tests check what the author
  thought of; review exists for what they did not. **The orchestrator is not exempt from
  the gate it enforces.**
- **A same-family review is not the gate.** Opus reviewing Opus finds real defects and
  still cannot satisfy §VIII; report it as an audit, never as a verdict.
- **A surviving mutant of changed behaviour is a missing test, not a question.** F6 round 1
  changed voice's label for a segment with no id, and my own mutation run showed no test
  would notice (M8). I put it to the reviewer as a question; the reviewer ruled it blocking,
  and round 2 added the test. Write that test before the review.
- **The two branches diverge silently.** Each holds commits the other lacks, including a
  consumer-side engine edit to `write-build-html.mjs`. Check `git log A..B` both ways
  before calling either one current.

- **Builders misreport their own model.** Several reported `claude-opus-4.5`, which is not an
  available model here. The dispatch is correct (`read_agent` confirms `model: claude-opus-5`);
  models are simply unreliable at self-identification. Independence has held throughout —
  Anthropic builder, OpenAI reviewer.
- **Push is blocked from this environment.** The linked account is an Enterprise Managed User
  with read-only access to `jacen555/demo`; forking is blocked by enterprise policy. The user
  pushes manually.
- **`Directory.Packages.props` is orchestrator-owned** — builders must stop and report rather
  than adding a package.
