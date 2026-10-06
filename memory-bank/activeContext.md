# Active Context — Forge

> **Last updated:** 2026-10-05

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
| `0a5b7f4` | Q14 — remix refuses a shapeless timeline instead of crashing; the shape check gains the schema's segment `id` rule; silent windows are bounded (nonnegative start, finite end, one-hour cap); frame-capture checks every silence declaration before it plans; the caption gate refuses all seven Unicode mandatory line breaks, naming each by code point | **PASS** at round 2. Round 1 **FAIL** (B1: an index printed as an id; B2: U+2028/U+2029 accepted into the sidecars at exit 0). Absorbed S2-1..S2-4 and K4 |
| `af5aeef` | R5 — narrated text containing `-->` is refused instead of written into both sidecars, where Chromium parses the cue with EMPTY text so the caption silently disappears. The narrated half of Q14's silent-caption rule, checking both sources of cue text | **PASS**. Four findings across three review rounds, all accuracy rather than behaviour: a comment and a diagnostic asserting an outcome alignment can prevent; an output invariant testing a line's SHAPE not its position, which would have passed the exact forged cue it existed to refuse; and two claims left stale after the first correction |
| `127f2a8` | F7 — voice checks an enabled end card (`builderVersion`, outro length) before it writes anything; gap 27's other case. The gate calls the pause GENERATOR's own predicate (`isGenerablePause`) rather than restating it, so the two cannot disagree | **PASS** at round 3. Round 1 **FAIL** (High): the gate mirrored `outroMs > SILENCE_MAX_MS`, but `String(1e-7)` is `"1e-7"` and the plain-decimal rule rejects it, so `outroMs: 0.0000001` passed the gate and died after 2 TTS calls. Round 2 (Medium): the remedy advised "write it as a plain decimal" for a value that already was one — `0.000001` is the floor, verified exact over 600,015 samples both directions |
| `7a6dd98` | F7 docs — the README gate enumeration at `:156-161` now names the end card | wording supplied verbatim by the builder |
| `e0fe668` → `d17c9be` | validate-scene — new pre-capture stage, 88 tests. The README commit found a real bug by FOLLOWING ITS OWN EXAMPLE: a missing `--knobs manifest.json` reported `knobs.json` as absent, sending the author to a file they never named | **PASS** at round 6, then **PASS**. On branch `validate-scene` |
| `995c917` | Duck (round 2) — make-music: pre-synthesis and mid-run link policy, the envelope's own hop, span agreement, publish/retire of the bed temp | **PASS** at round 6. Four High findings across four FAILs, every one real and reproduced as a failing test before being fixed. On branch `duck-and-pin-round-2` |
| `e85e355` | Pin (round 2) — `audit` budgets gains by position: `use(name, site)` is now a required two-argument call, plus `auditSites`. Pre-fix, a voice/music gain swap and a ceiling moved onto the voice chain both AUDIT PASSED | **PASS** at round 1 — the full evidence block was supplied up front rather than on request |
| `b375d95` | Duck/pin follow-up | **PASS** |
| `assertCleanExit` | The test helper sees a crash from module-scope code | not started — spec, then approval |
| T5 | Documentation debt; gain-pin's self-contradicting guidance proposed for it | not started |
| `c620c88` | Gain pin fails closed — `mix-parameters.mjs` registry, 7 pinned knobs | 2026-09-28 **FAIL** (pin reviewer; it also confirmed the commit's two round-1 fixes). Findings placed in T3. Round 2, 2026-10-02: **FAIL** — placed findings fixed, except that no test publishes a lock (PARTIAL); new: `audit` accepts a gain moved onto the voice chain (High, latent), and gain-pin's guidance contradicts itself (Medium). Placement pending (gap 22) |
| `331ddac` | Deliberately silent segments — declared and captioned, never inferred | 2026-09-28 **FAIL** (silence reviewer, with `2e5a62e`). Findings placed in T1, T2 and T4. Round 2: **FAIL** — placed findings fixed; new: a non-number silent `startMs` becomes a window and a silent window has no upper bound (High), two Medium. Proposed for Q14 (gap 22) |
| `c3f1e56` | In-graph ducking of a licensed bed; envelope bound to its voiceover | 2026-09-28 **FAIL** (duck reviewer, with `34fa0e7`). Findings placed in T3, one in T5. Round 2: **FAIL** — two placed findings PARTIAL; new: make-music writes the bed after publishing its record, and ignores the envelope's hop (High); no test checks the PCM is ducked (Medium). Placement pending (gap 22) |
| `34fa0e7` | Modelled gaps shortfall labelled MODELLED; measured values in help | Reviewed with `c3f1e56` |
| `2e5a62e` (consumer) | Subtitle options bounded; the stage plans by default | Reviewed with `331ddac` |
| `d71c605` | The consumer's code-block wrap (`ffe3f82`), byte for byte; T1 `a0add0b` corrected its CSS | Round 2: **FAIL on process only** — no BUILDER-MODEL recorded, no CSS defect left. Since measured: written on `claude-opus-5`, committed on `claude-opus-5.5` (gap 22) |

**The third-pass commits had their cross-family review on 2026-09-28: three `gpt-6-sol`
reviewers, FAIL on all three.** Their findings, with the audit's, became T1–T5. The T1–T4
and F6 reviews cover their own diffs only, so **round 2** (2026-10-02) checked that every
2026-09-28 finding was carried into the union, placed and closed. **It failed all three
again**: nine new findings and three PARTIALs, each confirmed by the orchestrator, and five
findings the union had downgraded or narrowed without grounds (progress, gap 22). Until
2026-10-02 this file said those commits had no review at all. That was
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

## The second recurring defect: the engine already had the answer

Distinct from the false-green class above, and newer. **Five times in one session a fix was
written for a rule the engine already contained, exported, and documented — and simply did
not call from the stage that needed it.**

1. **F7** restated a plain-decimal rule that `PLAIN_DECIMAL` (`mix-parameters.mjs:269`,
   read at `:318`, `:476`, `:659`) had already solved, with the same value, by
   construction. The fix was to call the pause generator's own predicate instead.
2. **R4** — a null `timing.segments` entry crashing four stages — is already refused,
   verbatim and with the chosen index-naming, by `shapeBlocker`
   (`silent-segment.mjs:868`): `timing.segments[${i}] is not a segment object`. It is
   exported and consumed by `remix.mjs:96`. All four crashing stages already import that
   module. Nobody called it.

3. **voice.mjs's late crashes** were already diagnosed and fixed for *remix* —
   `voice-remix-apply.test.mjs:1086` describes the defect in words that fit voice exactly:
   "a C-6 failure used to exit with a stack trace after the silent clips, the pauses and the
   voice track had already been overwritten, leaving new audio beside a timeline that
   described the old." Same bug, same words, one stage over.
4. **Five stages stage-then-publish** over the shared primitive at `cli-support.mjs:737`.
   `voice.mjs` staged nothing — the most expensive stage in the engine to fail late was the
   only one without the protection (fixed, `94648af`).
5. **`silent-segment.mjs:588`** is the counter-example that proves the convention works: it
   states that the blockers deliberately do NOT model the intake, the brand tokens, the TTS
   service or the replace guard, "which each stage reports for itself". Here the engine does
   not hold the answer **and says so** — which is why that refusal correctly belongs in the
   stage.

**The missing artefact is not a rule, it is an index of who reads a rule.** Note what
made `PLAIN_DECIMAL` findable at all: not the constant, but the sentence above it naming
the failure mode — *"two grammars is how a value becomes legal to write and impossible to
read."* A convention recorded as "use one grammar constant" would not have been found.

`shapeBlocker` goes one better and enumerates its consumers: *"voice.mjs and remix.mjs
each refuse what this refuses before any other check of their segments."* **That sentence
is simultaneously the index and the audit** — the four stages missing from it are exactly
the four that crash. Had it been kept honest, the gap would have been readable without
measurement.

**Convention, earned five times:** a shared rule's doc comment must name the failure mode
it prevents *and* enumerate every consumer. A stage absent from that list is either
deliberately exempt — say why, as `:588` does — or a defect waiting to be found.

**Now mechanised (`7ae62bb`).** `segmentEntryFact` and `segmentEntryBlocker` each carry a
`CONSUMERS(<symbol>):` line, and a test compares it against the modules that actually
import the symbol. Verified to discriminate in BOTH directions by mutation: naming a
non-importer fails, and adding a real importer while leaving the line stale fails with
"drifted apart". **It caught its first real case within the hour** — the R4 stream's three
new importers — naming the symbol and printing the drift on the first run.

**And it exposed a flaw in the process rule wrapped around it.** The CONSUMERS line is a
**per-tree invariant, not a per-owner one**: it is only true relative to the importers in
one working tree, so it must change in the SAME COMMIT as the importer that makes it true.
I had told the consuming stream to send me the line so I could edit my own file — which
would have named three non-importers in my tree, the exact mutant I had killed to prove the
audit works. My branch would have gone red and theirs green on the same line of text. A
self-auditing comment deliberately couples the declaration to the importing commit, so
strict file ownership cannot be enforced on that one line. Grant a narrow exception.

### Caution: a shared rule is usually a bundle

`shapeBlocker` refuses three things, not one: an absent/empty segment list, a non-object
entry, and a missing/non-string `id`. Adopting it wholesale imports all three, and the
third **contradicts a deliberate, documented decision** in `frame-capture.mjs:104-109`,
which tolerates an id-less segment and labels it by index on the stated grounds that
`segment "1"` would send an author to the wrong line. So "just call the existing rule" is
a measurement, not a reflex: count the currently-passing tests that change verdict first.

## How a green suite lies — the 2026-10-05 measurement rules

Eight rules, each earned by a defect that survived a green test. They belong together
because they are all the same failure: **evidence graded in a context it did not come from.**

1. **A zero from ABSENT COVERAGE is not a zero from PRESERVED BEHAVIOUR.** Two streams hit
   this independently within an hour, both measuring "0 tests change verdict" and both
   discovering the zero meant *nothing exercised the changed path*. One found 6 behaviour
   changes across 3 stages with 0 tests; the other found 4 reclassified shapes in 88 tests.
   Had either reported "0, no impact" — true — a silent change would have shipped. **I then
   made the same error on my own work**: a widened regex passed all 1130 tests and was still
   wrong, because nothing in the suite happens to print a bare clock.
2. **Measuring something is not defending it.** A matrix is evidence for a decision; only a
   test keeps the decision true after you leave. A reviewer FAILed a stream for exactly this
   — a precedence change it had deliberately chosen, written a source comment about, and
   never tested; and absent/non-array cells present in its own matrix and absent from its
   tests.
3. **When the defect is "wrote, then failed", measure STATE, not the exit code.** An exit
   code is structurally blind to it. Content digests before and after a triggered failure
   are the only instrument that sees it (`94648af`).
4. **A check that looks right and discriminates nothing.** A symlink test with an
   outside-root victim passes against unfixed code, because the project boundary already
   refuses an escaping link — it proves nothing about link policy. `at 10:30:00` matching a
   "stack frame" regex is the same shape. Both look like coverage.
5. **An untested cleanup path is not covered just because a test passes near it.** Proven,
   not asserted: a stream removed its own `discardFrom(mark)` to check its new test
   discriminated, and the test **still passed** because an outer handler masks it. It
   documented the necessity as unobservable rather than implying coverage.

6. **A surviving mutant means the test is weak OR THE CODE IS DEAD**, and those demand
   opposite responses. I spent two days reading every survivor as a coverage gap. One was
   not: `defaultLabel`'s index branch is unreachable because all three gates call
   `shapeBlocker` first, which refuses an id-less segment outright. Writing a test to kill
   that mutant would have produced a test for a path that cannot execute — green forever,
   proving nothing, which is the artefact this whole list exists to prevent. **Check
   reachability before treating a survivor as a gap** — and note that writing the test
   first is how you end up with a green assertion over an unreachable branch, which is
   *worse* than the mutant, because the gap is now documented as covered.

   **The portable habit, in the finder's own correction:** it did not set out to disprove
   the brief. It went looking for the reachable path in order to fix it, and found there
   wasn't one. The transferable rule is **reproduce the symptom before changing anything** —
   a knack for disproving briefs is not a method, and recording it as one would teach the
   wrong thing. The same lesson points inward: a control is only worth having if a
   surprising failure can change your mind about the *setup* rather than about the code.
7. **A check that matches nothing looks exactly like a check that changes nothing.** Both
   are green. Four sightings in two days, across three toolchains:
   - a file collapsed to one line by `Set-Content -NoNewline`, where `node --check` returned
     **0** because a single line of `//` comments is valid JavaScript;
   - a widened regex that passed all 1130 tests and was still wrong, because nothing in the
     suite happens to print a bare clock;
   - a .NET run reporting a clean **825/825 against stale binaries**, twice — once after a
     mutation failed to compile, once after `Copy-Item` preserved a timestamp so MSBuild
     skipped the rebuild (confirmed by finding the mutant's member still in the DLL);
   - a PowerShell patch that silently matched **0 sites** through backtick escaping.
   **The defence is cheap: print the applied-site count, assert the row count, compare a
   hash, or count the lines.** A tool reporting success tells you it ran, not that it did
   what you meant.

   **The sharper framing, from the stream that hit the fourth one:** every instance is *a
   true answer to the wrong question*. `node --check` answers "is this parseable", not "is
   this the file I wrote". A test run answers "did these binaries pass", not "were these
   binaries built from this source". A `-replace` answers "here is a string", not "here is
   a *changed* string". Because each answer is true, none of them fails loudly — so **the
   defence must be a second measurement of the thing you actually care about, never a more
   careful reading of the first.**
8. **A remedy is a claim about what happens next, and the only way to know is to do it.**
   The all-silent refusal took three rounds, each plausible and each wrong in a way no
   reading would catch: the first was a **referral loop** — voice told the author to run
   remix, and remix refuses that very timeline; the second rested on `hasAudioFile`, which
   tests a *record* rather than a file; the third said "write narration", which does not
   clear a refusal keyed on *has a `silence` key*. The final wording was verified by
   following it and watching the run be accepted. `README.md:156`'s invariant — "a remedy
   names a stage only where that stage would run" — is the written form of this, and this
   repo ships a remedy in nearly every refusal, so the surface is large.

### The instrument that proved the instrument was broken — 2026-10-06

The sharpest instance of rule 7, because it happened **inside the experiment built to test
rule 7**, and it corrected two people in sequence.

A stream's exit-code probe piped a live child through `Select-Object -First 1` and read
`$LASTEXITCODE`. All cases reported the harness's value rather than the tool's. It caught
that only because a refusal it had *already measured at 2* came back as 1.

It then built a control — and **the control said the hazard did not exist**. Its child
emitted 5000 lines synchronously and exited before the consumer stopped reading, so there
was nothing left to kill. Its diagnosis of its own control is the transferable part:

> **A control that cannot fail proves nothing, and a FAST control for a RACE is a control
> that cannot fail. The shape of the control has to match the shape of the hazard.**

With a slow producer the hazard appeared, and worse than stated: a child that exits **3**
was reported as **0** — a failing tool reported as passing, the single most dangerous
direction for a measurement error.

**Then the corrected experiment was itself wrong**, and only a sentinel exposed it. Setting
`$LASTEXITCODE` to `99` before each case:

    | Select-Object -First 1                    exit=99   137ms   <- sentinel SURVIVED
    | Select-Object -Last 1                     exit=3   1366ms
    | Select-String | Select-Object -First 1    exit=99   123ms   <- sentinel SURVIVED
    | Where-Object { $_ }                       exit=3   1344ms
    captured, then filtered                     exit=3   1353ms

**`$LASTEXITCODE` is not set to 0 on early termination — it is not set at all**, and keeps
whatever it held before. So the "0" was a stale 0, and the combination classified as *safe
because it returned 3* was a stale 3. The child dies with `EPIPE` in both unsafe cases.

**THE RULE — and note it is not a list of safe filters, because the safe-looking one was
the trap:**

> **Never read `$LASTEXITCODE` after a pipeline whose final element can stop early.
> Capture the child's output to a variable first, then filter the variable. When measuring
> an exit code at all, set a sentinel first so "unset" is visible rather than silently
> inherited.**

`spawnSync` is immune by construction. And the orchestrator was not clean either: a
`git merge-tree` conflict preflight used `Select-Object -First 15` directly, which did not
corrupt an exit code but **capped the conflict output at 15 lines** — it reported "clean"
from a truncated instrument, and was right only because the answer happened to be short.

### `assertCleanExit` was blind, and that is the cautionary one

The helper exists to catch "exited plausibly AND printed a stack" — its own comment says
*"that is how one of these defects survived a round."* Its regex required parentheses, so it
could not see a top-level ESM frame (`at file:///x.mjs:239:28`), which is the shape a throw
takes in a CLI's argument handling and first file reads. It guarded ~356 call sites across
ten test files while blind to the most common modern shape. Found by a stream that noticed
its own test passing against a source printing a full crash dump. Fixed in `faeb8ed`; the
widening deliberately requires a path separator or a `node:` scheme, because the obvious
version reads a printed clock as a frame.

### Stating a contract: mechanism versus observable

The eval progress contract took four review rounds, and the first three were wrong in
instructive ways — universal, then **temporal** ("throws after this method has moved on"),
then **locational** ("decided by where work runs", my formulation). Each was closer and each
still described the MECHANISM rather than the OBSERVABLE CONTRACT. The rule that survives:

> An exception is contained if and only if it **propagates out of the `Report` call** on the
> thread that made it.

Where the handler runs is the usual *reason*, never the definition — a context may run work
on another thread, catch it there, and rethrow from `Post`, and that fault IS contained.
Pinned by a forwarding/keeping pair identical in location and timing and differing only in
propagation, and the superseded rule was **refuted by measurement, not argument**: the
builder set an arm to the old rule's prediction and recorded the failure.

**The transferable lesson: when a claim keeps needing narrowing, stop patching sentences and
ask what the OBSERVABLE is.** Three rounds went to time and place; the answer was neither.

## Parallel streams — topology, 2026-10-05

Three worktrees on disjoint file sets, after measuring that the candidate tasks had **zero
overlapping files**. Nothing is pushed; five commits sit across three local branches.

| Branch | Commits | Holds |
|---|---|---|
| `multi-agent-orchestration` (mine) | `127f2a8`, `7a6dd98`, `694c9e9`, `7ae62bb`, `faeb8ed`, `56fc0c7`, `cbce984` | `silent-segment.mjs`, `tests/_helpers.mjs`, `README.md`, `memory-bank/**`, and the eval domains |
| `validate-scene` | `e0fe668`, `d17c9be`, `49cef8f`, `4713ffd`, `94648af` | `validate-scene.mjs`, `voice.mjs` + their tests |
| `duck-and-pin-round-2` | `995c917`, `e85e355`, `b375d95`, `cf266f2`, `a71678d` | `make-music.mjs`, `envelope-ducking.mjs`, `remux-music.mjs`, `mix-parameters.mjs`, `frame-capture.mjs`, `write-storyboard.mjs`, `concat-audio.mjs` + tests |

**The rule that makes this work: one file has exactly one owner.** `silent-segment.mjs` is
the contended one — it holds `shapeBlocker`, `isSilentSegment`, `isGenerablePause` and now
`segmentEntryFact`, so every stream eventually wants it. It stays mine; a stream that needs
a change there reports it and I make it. The sole exception is a `CONSUMERS:` line, which by
construction must move with its importer (above).

**This worked.** Three streams, zero collisions, five tasks closed on one branch and four on
another, every one independently reviewed to PASS. The merge was `cf266f2` — a stream merged
my branch FIRST and proved the combined suite green BEFORE editing, so any later red could
only be its own. Adopt that ordering every time.

## The eval harness is no longer silent (2026-10-05)

The user asked to see a suite run in progress. Measured first: `libs/EvalEngine` had **no
progress channel at all** — no `IProgress`, no events, no observer — and `tools/EvalCli`
printed nothing but help and errors. Built as two ordered tasks across a tier boundary.

| | Task 1 `56fc0c7` — `libs/EvalEngine`, Tier 1 | Task 2 `cbce984` — `tools/EvalCli`, Tier 2 |
|---|---|---|
| What | `RunAsync` overload taking `IProgress<RunProgress>?` | auto-detecting renderer, Spectre live bar or streamed lines |
| Tests | 2066 → 2101 | 758 → 811 |
| Review | PASS after 3 FAILs | PASS, then re-reviewed after a cancellation fix |

**Measured outcome:** redirected, 6.647 s of zero bytes → a start line at 0.272 s; in a real
terminal, first text at 9.819 s → a bar at 3.655 s.

**Decisions worth keeping:**
- An **overload, not a defaulted parameter**: a default deletes the two-argument signature,
  breaking the XML cref at `RunCoordinator.cs:107` under `TreatWarningsAsErrors`, and is
  binary-breaking for compiled callers.
- The sink is **refused before dispatch** unless the logger admits the fault level — the
  engine's own signature move, used four times in the same method ("nothing has been
  dispatched, so the suite is refused rather than run"). `IsEnabled`, **not** a `NullLogger`
  type check, because a logger configured above Warning is equally silent.
- `InvalidOperationException`, **not** `ArgumentException`, because `SuiteDiscovery.cs:362`
  wraps `RunAsync` in `catch (ArgumentException)` and would misreport the refusal.
- The renderer implements `IProgress<T>` **directly and never uses `System.Progress<T>`**:
  that posts to the thread pool in a console, where a throwing handler is unhandled and
  terminates the CLI — measured at exit `0xE0434352`, landing both before and after
  `RunAsync` returned.
- Threading a token to the start-line write required **overriding
  `DiagnosticsWriter.WriteLineAsync`**: `TextWriter`'s own implementation writes one
  character at a time — measured at 1,857 whole lines out of 2,000 across 8 concurrent
  writers. Closing a cancellation gap would otherwise have opened an interleaving one.

**Open:** `LiveEndpointBaseline.cs:102` calls the two-argument overload with no sink, so a
`--baseline-endpoint` run shows progress for one suite and 4.3 s of silence for the other.
Reported by the CLI builder rather than fixed across the boundary; queued as a Tier 1 task.

**A line citation without a commit is not a fact, it is a timestamp.** Proven here:
`writeGainLock` sat at 769 → 771 → 774 → 774 across four commits. Two sessions "disagreed"
about its line; both were right, at different commits, and one of them had moved it itself
within the same task. Pin citations to a commit-ish or to a symbol.

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

- **Q14 and R5's follow-up queue, in the user's order.** Q14 closed at `0a5b7f4`, R5 at
  `af5aeef`; these came out of their review rounds and are not yet scheduled:
  - **Narrated line breaks** — the piece R5 deliberately did not take. Measured: six of the
    seven Unicode mandatory line breaks are split away by `/\s+/` before reaching a cue, but
    **`U+0085` is not matched by JS `\s` at all** and does reach cue text, arriving by the
    ordinary `restorePunctuation` path because `bare()` strips it. Measured as
    **non-destructive** in Chromium — the cue is intact and the NEL survives as an invisible
    character — which is why it was left. Whether such a cue can exceed `MAX_LINES = 2` is
    **unmeasured**; measure before speccing.
  - **`voice.mjs` is still ungated** for `-->`, so an author pays for TTS before learning the
    narration is unusable. R5 gates only the sidecar stage.
  - **SRT parser behaviour is unmeasured** — ffmpeg is not installed here. The README claims
    nothing about it, only that the gate lands before either file is written. Measure with a
    real SRT parser before any claim is made.
  - **"Shape-first everywhere" — R1 plus the surviving `?? i` sites.** The deferred record is
    incomplete, and a spec written from the round-1 verdict's citations would fix one site of
    four. **Measured complete list** of the quoted-index pattern, all pre-existing at HEAD and
    untouched by Q14: `concat-audio.mjs:117`, `concat-audio.mjs:207`, `remix.mjs:86`
    (`labelOf`), `silent-segment.mjs:599` (`defaultLabel`). Separately, the `segment
    "undefined"` default is `silent-segment.mjs:366`, reachable from `validate-timing.mjs:356`,
    `write-storyboard.mjs:29` and `concat-audio.mjs:119`. Also here: `segmentLabel` in
    `write-chapters.mjs:292-295` and `write-subtitles.mjs:632-635` tests only
    `typeof id === 'string'`, so an empty id still prints `("")` — laxer than the rule Q14
    enforced. frame-capture is clean: it had zero `?? i` sites at HEAD, round 1 added one,
    round 2 removed it.
  - **R4 — a null segment entry is a TypeError, not a refusal.** Sites: `frame-capture.mjs:119`
    (**re-measured after Q14 shifted it from :112**), `write-storyboard.mjs:37`,
    `concat-audio.mjs:108`.
  - **R2/R3 wording**, nested **K4** (`silent-segment.mjs:366-370`), and **`declareSilentRemedy`**
    (`silent-segment.mjs:985`, was :971) which omits the nonnegative start, the one-hour cap
    **and now the caption rule**.
  - **Citations in all of the above are tree-relative.** Q14 shifted `silent-segment.mjs` by
    **+14** below its hunk and `frame-capture.mjs` by **+7**; anything above a hunk is
    unchanged. Both the builder and the reviewer cited stale numbers this round. **Re-measure
    every deferred citation against the tree it will be implemented in.**
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

- **A false claim in a brief propagates into the product, and the first correction is
  usually too narrow.** In R5 I wrote "JS `\s` covers every Unicode mandatory line break"
  into the builder's FACTS section after measuring only LF and U+2028. `U+0085` is the
  exception. The builder restated it as fact in a source comment *and* the README; the
  correction fixed the source but left the same sentence in the test file; and the widened
  wording still missed blank narration, whose token also bares to the empty key. **Three
  passes to land one accurate sentence, each needing a different agent.** Mutation cannot
  catch this class — nothing executes a comment — so only a reader finds it. Write FACTS
  sections as measurements with their scope attached, never as generalisations.
- **A mutant that does not change behaviour proves nothing, and a mutant that breaks the
  parse proves less than nothing.** Both happened in one session. One inserted an unused
  `const` and left the message intact — "SURVIVED" meant only that it was equivalent code.
  The other replaced a string literal's contents without its surrounding quotes, producing
  `''GUTTED ''`; the module stopped parsing, 103 tests "failed", and it scored as the most
  decisive kill in the run. The tell was unrelated names like `writeSubtitles_help_...` in
  the failure list. **The harness now `node --check`s each mutant and asserts the row count
  against baseline before counting a kill**, and the guard is validated by deliberately
  reintroducing the defect.
- **A reviewer can return a verdict without doing the review.** Q14 round 2's first
  submission was a PASS in 185 seconds: no citations, and four of the six required sections
  missing. Nothing in it could be distinguished from a reading of the builder's report — and
  the report is the thing the reviewer exists to check. I sent it back naming the missing
  sections and restating the questions, saying plainly that either conclusion was acceptable
  but an unsupported verdict was not. The resubmission quoted the loop, worked all four
  branches of the message logic, and answered the deferred-defect question; the conclusion
  did not change, but the evidence appeared. **Read the verdict for evidence, not for its
  verdict.** A PASS is a claim like any other.
- **Re-confirm after a fix, even on a PASS.** R5's reviewer passed, then found two more real
  defects when shown the fix — including the first correction's own sentence left stale in a
  second file. The confirmation round has now earned its keep twice.
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
