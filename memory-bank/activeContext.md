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

## The video coach graduated, advisory-only — 2026-10-06

Seven steps, G5 → G1 → G2+G3 → G4 → G6 → G7, all reviewed cross-family. The spike is
`status: graduated` and **retained**, because it is the provenance for every rubric rule and
for the backtest figures the OBJ-07 tolerance rests on.

| Step | What |
|---|---|
| G5 `0606751`, `f8c912d` | Agent contract: `BLOCKING` → `DEFECTS`, a required verbatim `QUOTE`, a `MANIFEST` line |
| G1 `ae42467` | `coach/rubric.md` + a parse contract that enforces the rubric's own `:8` criterion |
| G2+G3 `7295c1e`, `dc423fe` | preview binding record; `coach-pack.mjs` and its hash manifest |
| G4 `a22ad52` | `coach-rulings.mjs` — the anti-suppression matcher |
| G6 `1dd2606` | Wired into the demo-recording skill at two passes, neither gating |

**The design property worth remembering:** a ruling that *agrees the defect is real* does not
suppress it. `valid` keeps a finding open as "ruled valid, still unfixed"; only waived,
false-alarm and taste collapse. And because the key hashes the sentence a finding quotes,
**rewording that sentence re-opens the finding** — you cannot silence a review by editing the
text it cites.

### G7's end-to-end run found a defect nobody knew about

Run against a temp copy of EvalLoopDemo, pass 1, coach on GPT against a Claude author:

- The **known** `script.md` defect surfaced as a DEFECT, as the plan required — narration says
  *"three result strips … land on three different outputs"* while the on-screen note reads
  *"output A / output A / output B"*. Two distinct outputs, not three.
- **A second, previously unrecorded OBJ-08 defect**: narration says *"Three authored facts"*,
  the screen note says *"Four authored facts are shown."* Same rule, different segment.
- All quotes verified **verbatim** in the source, so both findings were keyable.

Then the full matcher chain, measured rather than asserted: no rulings → all NEW · `valid` →
stays OPEN · `waived` → COLLAPSED · **cited sentence reworded → UNKEYABLE, shown NEW and
flagged, with the prior ruling ORPHANED** ("either it was fixed, or the text it cited
changed"). The rules the rubric marks unable to fire appeared in NOT EVALUATED as
"covered by: nobody" — the honest marking from G1 doing its job in a live report.

### A test that could never have passed on a fresh clone — 2026-10-06

I observed one test failure after deleting a gitignored folder, could not reproduce it in
three further runs, and **logged it rather than closing it on repetition.** That instinct was
right, and the reason is sharper than the instinct: **the three green runs were green because
the first failing run had created the directory.** Repetition could only ever confirm the
bug's own side effect.

The cause was not a race and not intermittent. `coach-rulings.test.mjs` called `mkdtempSync`
*inside* the real `coach/pack`, and `mkdtemp` requires its parent to exist. Nothing in that
file created it — the directory existed **only as a side effect of `coach-pack.test.mjs`
running `--apply`**. From cold, the file failed every time with `ENOENT`.

**And `coach/pack` is gitignored, so a fresh clone is exactly that cold state.** This test
could never have passed on a clean checkout. It passed on our machines solely because a
previous run had left the directory behind.

**The verification that distinguishes a fix from a disguise:** from cold the file is 49/49
**and the folder is still absent afterwards.** A fix that merely `mkdirSync`'d first would
have satisfied "it passes from cold" while leaving the shared tree — independent, versus
merely self-creating.

**Rules earned:**
- **Green runs after an observed failure are evidence of nothing if the failure could have
  repaired the state it depended on.** Ask what the first run changed.
- **A gitignored directory is not a precondition.** Any test that needs one must create it in
  isolation, because CI and a fresh clone both start without it.

### An audit that was an explicit list, not a discovery — the same week

I briefed that adding a `CONSUMERS(fingerprintBuffer):` line would be enforced automatically,
because the audit "now covers `cli-support.mjs`". **It does not discover anything** — it is an
explicit list of `[owner, symbol]` pairs. The line alone would have been **decorative: a
comment claiming to be audited by a test that never reads it**, which is the exact artefact
the convention exists to prevent, reproduced inside the convention.

The builder also caught itself **listing a module as a consumer before checking whether it
imports the symbol** — it does not. Worth recording, because a `CONSUMERS` line is precisely
the artefact that rots when someone writes down what they assume rather than what they
measured.

### A correct rule with an explanation nobody re-measured — 2026-10-06

In the U+0085 gate, **three of four review findings were wrong EXPLANATIONS, not wrong code.**
The sharpest: the refusal cited a three-line harm **for a character the builder had personally
measured as not adding a line**, in the same task. A refusal explaining itself with a
consequence the engine has measured it does not have.

Its own diagnosis is the transferable part:

> **I write a correct general rule, then attach a specific explanation to it without
> re-checking the explanation against the measurement that produced it.**

This matters more here than in most codebases, because this engine's refusals are *meant* to
be actionable — an author acts on the explanation, not on the rule. A true rule with a false
reason sends them to the wrong place, which is the same family as `knobs.json` named for
`manifest.json` and a remedy pointing at a stage that refuses the very timeline.

**The fix that holds by construction:** the harm text is now selected **by character**, and
the test table selects its expected string the same way, so the two cannot diverge by someone
remembering wrongly.

### A boundary row has to sit on the same path as the rule it bounds

A mutant widening the refused set to all whitespace **survived**. The TAB and NBSP boundary
rows sat on the **narration** path, which is checked against one character and never against
the set — so they bounded a rule they did not name. Obvious written down; invisible until a
mutant walked through it.

### And the measurement that reversed its own premise

The task was dispatched with: *do not gate the other six breaks on the grounds they cannot
occur — a gate for a case that cannot happen is a rule that can never fire — but if you
believe one can arrive by another path, measure it.*

It measured. `restorePunctuation` emits the **raw measured word** when alignment fails, and
down that path **all seven** breaks reach cue text at exit 0 with both sidecars written. A raw
`U+000A` produced a genuine **three-line cue** while the run printed `0 cue(s) over` — the
`MAX_LINES` violation that had just been proven *impossible* for U+0085, arriving as a
different character down a different path.

**"It cannot happen" is a claim about the paths you enumerated.** The gate is asymmetric
because the measurements are, and that asymmetry is now documented at the gate rather than
tidied away.

## Mutate the inputs, not just the implementation — 2026-10-06

The strongest methodological finding of the graduation, and it is about the technique this
repo has leaned on hardest.

`coach-rulings` exists so that **nothing disappears silently**. Five of its fourteen review
findings were one family — a finding vanishing, or collapsing under a ruling that was not
about it — and **every one was reached by varying the DATA or the FORMAT. Not one by
mutating code.** Thirteen code mutants were killed, and the suite could still be walked past
by a stored ruling whose status read `pending`:

> key matched, so not NEW · not `valid`, so not OPEN · not a collapsing verdict, so not
> COLLAPSED · keyed, so not ORPHANED. **The finding fell out of every section at exit 0.**

That is the exact suppression the stage was built to prevent, reproduced *inside* the
stage — and code mutation was **structurally blind** to it, because the defect lived in the
rulings file rather than in any line of the program.

**The rule: for any stage that reads a file somebody else writes, the file is the attack
surface.** Mutate the inputs — a malformed entry after a good one, a status nobody
enumerated, two records that collide on a key, a field present but empty.

### Two more of the same week's shape, from the same task

- **A test named for the stage's most important property passed against an empty section.**
  It asserted a match on `/ruled valid, still unfixed/` — which is the **section heading**,
  printed unconditionally. The single property the stage exists to guarantee was untested by
  the test named after it. Assert on section *contents* and *counts*, never on a label the
  renderer always prints.
- **A fixture hid an integration defect for the second time in two tasks.** The manifest was
  written where the test found it convenient, not where `coach-pack` actually writes it —
  `tools/SizzleCraft/coach/pack/<id>/`. The stage could not read the manifest from the only
  stage that produces one, and 32 passing tests said otherwise.

### The pair defect, and why pairing the reviews found it

`.github/agents/video-coach.agent.md` said a still-only finding keys on the still's hash,
while its REQUIRED template showed `QUOTE:` unconditionally and said *"emit exactly this"*.
A conforming agent had to either break the template or **invent a quote for an image** —
and an invented quote fails the matcher's verbatim check, flagging a finding unkeyable that
would otherwise have keyed cleanly.

**The defect lived between two files and was invisible to a review of either one.** It was
found only because the plan deliberately paired G5's review with G4's, on the grounds that
an output contract and its parser are two halves of one interface. Worth repeating whenever
a producer and a consumer are written separately.

## My briefs keep being narrower than the rule — 2026-10-06

Three times in one day a stream found more than I asked for, because my instruction named
**examples** where it should have named the **rule**. This is an orchestrator defect, not a
builder virtue, and it is worth recording as mine.

| I wrote | The rule was | What the narrow form would have missed |
|---|---|---|
| "sweep for `Inputs used` naming **storyboard or stills** at pass 1" | *any* input unavailable at that pass | `CRAFT-09` and `OBJ-17`, which name **timing** |
| "apply `:8` to these **six** rules" | apply `:8` to **every** rule | `OBJ-14` and `OBJ-15` |
| "move the duplicated `describeShape` into `silent-segment.mjs`" | *one statement per rule, wherever it already lives* | `cli-support.mjs` already had `describeJsonValue`, identical body — following my brief would have created a **third** statement while nominally removing a duplicate |

The third is the worst: my instruction would have **made the defect worse** while appearing
to fix it. The stream caught it only because it checked whether the engine already held the
answer — a habit it had from the previous task, not from my brief.

**The same failure appears inside a stream's own work**, which is why it is a general rule
rather than a complaint about me: a stream searching for `?? i` found the three sites my
brief listed and none of the four live ones the reviewer later found, because two of those
were in **ordinary success output at exit 0** rather than in a refusal. Its own diagnosis:

> **My search was shaped by the brief's example instead of by the rule.**

**What to do instead:** when dispatching, state the rule and give the examples as
*illustrations*, explicitly labelled as non-exhaustive — and ask for the general form back.
The strongest result of the day came from exactly that: a stream told to find one
rule-vs-procedure mismatch was asked to walk the whole rubric, and returned nine.

**And the cheapest correction: a mechanical query beats an enumeration.** `Pass` versus
`Inputs used` is answerable for every rule at once; an audit list is answerable only for
the rules someone remembered. The first prevents the tenth instance, the second documents
the nine.

**A fourth variant, sharper than the three above: I cited a precedent without checking
which way it points.** Briefing G2, I wrote "you have been here before with make-music's
bed — the answer there was deliberate and documented. Read it before choosing", in support
of publishing a record LAST. `make-music.mjs` carries the comment **"THE RECORD FIRST, THEN
THE BED"**. It argues the opposite.

The stream read the precedent instead of my gloss on it, and derived the rule neither file
states: **make-music fingerprints an in-memory buffer, so its record can precede the write;
preview's stills are PNG bytes the browser writes to disk and cannot be hashed until they
exist, so its record cannot.** Both orderings are right, for opposite reasons.

**A precedent cited without its distinguishing condition is worse than no precedent**, because
it transfers a conclusion without the reason that bounds it — and a reader following the
pointer finds the engine apparently contradicting itself.

### A fifth variant, and the worst: my brief contained the answer — 2026-10-06

My merge-before-edit instruction read **"ff-only to `X`, confirm `N` as predicted."** It
hands the stream the expected number before it measures. That is not a verification step.
It is an **anchor**, and it returns itself.

A stream reported `1555 / 1554`, having "confirmed 1544 / 1543 as predicted". Measured,
twice each, cold and warm:

| tree | `# tests` | `# pass` |
|---|---|---|
| `abaf4f9` — the baseline everyone "confirmed" at 1544 | **1545** | **1544** |
| `4a47413` — the commit reported as 1555 | **1556** | **1555** |

The stream's **delta of +11 was exactly right** — isolated it: `voice-remix-apply` 158→164,
`silent-segments` 351→356. The work was real. I concluded the totals had been **derived** —
my predicted baseline plus its own delta, presented as a reading — and that the baseline had
been one low for several commits, re-confirmed by every stream that passed through it.

**That conclusion was wrong. See the correction immediately below.** The totals were read off
real output; the streams and I were running *different commands*. I am leaving the wrong
reasoning in place rather than quietly rewriting it, because the way it was wrong is worth
more than the finding it replaced.

**I did not conclude "mis-transcribed", because both of its numbers were internally
consistent — which is the signature of a genuine environment difference, not a slip.** So I
tested that explanation instead of preferring the convenient one: I ran the suite in *that
stream's own worktree, at its own commit*. 1556 / 1555. I concluded nothing environmental
differed, and that the totals had been derived rather than read.

### That conclusion was WRONG, and how it was wrong is the real lesson — 2026-10-06

**Both streams, independently, found the actual cause. The repo prescribes two test commands
that disagree by one test:**

```
node --test "tools/SizzleCraft/tests/**/*.test.mjs"   ← .github/domains.yaml test_cmd
# tests 1555 · # pass 1554

node --test                                            ← package.json "test", bare discovery
# tests 1556 · # pass 1555
```

The extra one is `tests/fixtures/test-owned-path.mjs` — **a fixture that registers no tests
at all.** Node's default discovery matches `test-*.mjs`, so bare `node --test` runs it and
reports `ok 8 - tests\fixtures\test-owned-path.mjs`: **a passing test that cannot fail,
living inside the instrument we measure the repo with.** The registry glob requires
`*.test.mjs` and never matches it.

So the streams read real output. They ran the registry command; I ran `npm test`.

**MY EXPERIMENT CONTROLLED THE TREE AND NOT THE COMMAND.** I ran *my* command in *their*
tree, got my own number back, and declared the environment identical. It answered **"does
their tree give 1556 under my command"** when the question was **"does their command give
1555."** A true answer to the wrong question — rule 7 — committed by me, in the investigation
whose entire subject was instruments that return the expected answer. I had even written the
positive-control rule into the brief that same hour.

**The giveaway I walked past: both of their numbers were internally consistent.** I correctly
identified that as the signature of a real difference rather than a slip — and then tested
only the one explanation I had thought of. Ruling out *an* alternative is not ruling out
*the* alternative. When the evidence says "something real differs," the honest next step is
to vary **every** axis of the measurement, starting with the one you did not choose
deliberately.

**What survives, and it survives strengthened:** the anchoring rule is still right, and the
stream confirmed it against itself without being asked —

> I *did* read my numbers off real output, yet I wrote "confirmed as predicted". Had the tool
> printed something else I might still have typed "confirmed", because **the word was in the
> brief before the number was on screen.**

So the brief was a real defect and the process change stands. It just was not the cause of
*this* discrepancy. **Two true findings, and I welded them into one wrong story** because the
first one explained the second well enough to stop looking.

Two of my own instruments failed inside this same investigation, and both failed silently:

- A summary regex `^# (tests|pass|fail)` matched **nothing**. The test-name check beside it
  printed `FOUND` eleven times, so the run *looked* successful — a zero from a regex that
  never matched, sitting next to a genuine positive result.
- A `Get-Content | Select-Object -Last 3` issued in the same batch as the `git merge` read
  the **pre-merge** file. I raced my own measurement against my own mutation.
- A brace-depth counter I wrote to check scope counted braces inside strings and comments,
  and returned `-1`. It discriminated nothing.

I discarded all three and measured the thing I actually cared about: whether the new tests
**execute by name**. They do, all eleven.

**The rule: a verification step that states its expected result in advance has stopped being
a verification step.** State the expectation *after* the reading, or not at all. Ask for the
**verbatim** instrument output **and the exact command that produced it** — the command was
the variable I never asked for, and it was the answer. Treat the **delta** as the trustworthy
quantity: it is computed from two readings the stream actually took, while a total can be
inherited from whoever spoke first.

This is the same family as the mp3-count-versus-request-log control, and as the phrase-grep
that answered *"does this phrase appear"* when the question was *"is the false claim still
asserted."* **An instrument pointed at the expected answer returns the expected answer.**

### A fixture that reproduces the symptom is not a fixture that represents the system

The same stream's first scene for the layout-misattribution fix used slide ids equal to
segment ids. It reproduced the symptom **perfectly**, and would have made `issue.id ===
segmentId` look like the fix. Against a real `write-build-html` run, slides are `seg-0`,
`seg-1` while segments are `ok`, `big` — so that filter matches **nothing** and ships as a
silent no-op that empties the failure line.

**A fix that makes a failure line empty looks exactly like a fix that makes failures stop.**
It was caught only because the fixture "felt too convenient", which is not a method. The
method: **a fixture whose identifiers you chose yourself must be checked against a real run
before trusting any filter built on it.**

**A fifth variant, and the costliest: I pointed at a model that had a defect.** Briefing the
exit-code work I wrote *"`concat-audio` and `frame-capture` already supply the wording for a
clean refusal; copy the one that reads better."* `frame-capture.mjs:63` forwards
`err.message`, and V8 quotes **~17 bytes of the file** back into a JSON parse error:

    Unexpected token 'S', "{ "k": SENTINEL-L"... is not valid JSON

**So the instruction propagated a disclosure leak into three stages**, and only the
reviewer caught it. The engine already held the correct form — `write-chapters.mjs:197`
reports the file **by size**, settled after a link at `timing.json` made a parse error quote
the bytes it led to, and pinned by `path-boundary.test.mjs:676`. I named the wrong two of
three siblings.

**The rule, from both instances together: check the model, not the model's reputation.** A
precedent is a claim about code, and like any other claim it is worth exactly what its last
measurement was worth. Citing one without reading it transfers its defects along with its
authority — and the authority makes the defect harder to question, because the receiving
stream now has two reasons to believe it.

## A derivation with two agreeing measurements, both of one benign signal — 2026-10-07

A stream was sent to add a threshold gate to `check-levels.mjs`, which until now only
**reported**: every `CliError` in it concerned unmeasurability, and none compared a measured
level to a threshold, so a mix defect reached a human unchallenged.

It built the obvious bound — refuse a peak above full scale — and the derivation looked
solid from three directions: `remux-music.mjs:685` emits `alimiter=limit=<ceiling>`, the
README records −0.3 dBTP at the default, and its own render measured **−0.227 dBFS** against
**+2.012** unlimited. Two agreeing measurements and a documented figure.

**All of it was one benign signal.** With the limiter correctly in force, ffmpeg 9.0.2, AAC
192k:

| material | `--ceiling 0.1` | `--ceiling 1.0` | `--ceiling 2.0` |
|---|---|---|---|
| sine + pink noise | −0.26 | −0.68 | −1.91 |
| white noise | **+2.85** | **+3.30** | +1.23 |
| square wave | **+4.49** | | |

**A correct render at the default ceiling measures +3.30 dBFS.** AAC overshoots the clamped
peaks by an amount the *material* sets and the ceiling does not bound. The gate would have
refused good work — and would have been defended by a README figure, a source line, and a
real render.

Two things make this transferable:

1. **Agreement between measurements is not independence.** Two readings of the same benign
   signal agree with each other and with the documentation, and are jointly wrong about the
   population. The question is never "do my measurements agree" but **"what do they vary?"**
   Here nothing varied the one input that mattered: the material.
2. **It was withdrawn rather than tuned,** and the `+3.295152` reading is now pinned in a
   test as ACCEPTED, so the bound cannot return on the same plausible reasoning. The next
   person meets the measurement instead of an empty space that invites the same derivation.

What shipped is narrower and true: one categorical condition with no number in it — **a
whole file that is digital silence where audio was expected** — behind `--allow-silent`,
because the README documents a *supported* all-silent S4 timeline that an unqualified rule
would have refused. A partial result, reported as partial in the headline.

**Shipping less than asked, and saying so first, was the correct outcome.** A threshold
nobody can justify gets tuned until it stops complaining.

### Two orchestration errors of mine, same day

**I spawned a session without pinning its base branch**, so it branched off the project
default (`main`) rather than the working trunk, and did its whole task **10 commits behind**.
Its baselines looked wrong against every other stream's numbers, and it had correctly
reported a fixture problem as "pre-existing, not mine" that another stream had fixed an hour
earlier. It measured its tree correctly; I handed it the wrong tree. **A number that
disagrees with every other stream's is a question about the tree, not about the stream.**

**And an unexplained red I could not reproduce.** The first full-suite run after merging two
independently-green test changes reported `# pass 1571 / # fail 1`, exit 1. Four subsequent
runs at the same commit were clean at `1572 / 0`. **I did not capture the failing output**,
which is the actual defect here — a one-off red with no artefact is nearly worthless, and I
had the run in hand. The plausible cause is resource contention: another session was driving
real ffmpeg renders concurrently. **That is a hypothesis, not a finding, and it is recorded
as unresolved rather than closed on four greens** — the coach/pack cold-clone case is exactly
why repetition is not proof. Future suite runs capture their output on a non-zero exit.

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
