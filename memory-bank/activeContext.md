# Active Context — Forge

> **Last updated:** 2026-09-28

## Current focus

**SizzleCraft's third pass, driven by its first consumer** (`tools/EvalLoopDemo`) — and an
honest ledger of what has been independently reviewed, because most of it has not.
Alongside it, **a pre-render video coach is being backtested** before it may block a
render (below).

| Commit | What | Independent review |
|---|---|---|
| `c620c88` | Gain pin fails closed — `mix-parameters.mjs` registry, 7 pinned knobs | Round 1 **FAIL**; round-2 fixes **never re-reviewed** |
| `331ddac` | Deliberately silent segments — declared and captioned, never inferred | **None** |
| `c3f1e56` | In-graph ducking of a licensed bed; envelope bound to its voiceover | **None** |
| `34fa0e7` | Modelled gaps shortfall labelled MODELLED; measured values in help | **None** |
| `2e5a62e` (consumer) | Subtitle options bounded; the stage plans by default | **None** |

`c620c88` reached `main` in PR #14; the rest are local. SizzleCraft: 434 tests (433 pass,
1 skip). A **same-family** audit (4 × `claude-opus-5.5`, one slice each) was run on
2026-09-28 at the user's request — it finds defects, but **it does not satisfy §VIII**. A
cross-family gate review is still owed on every row above. Its headline, verified by
execution: **the WCAG contrast audit has never fired** (C-14 — a template-literal escape
mangles the colour regex, so every red channel parses as `NaN`). It raised 13 Highs; no
fix has been approved yet (progress, gap 25).

### Ducking — measured by the consumer on the real project

- **Depth ~10.4 dB delivered against an 11 dB solved target**, measured on the *isolated*
  bed. Speech masks the bed in the mix, so the mixed file cannot answer this question.
- **Gaps recover to within 0.05–0.11 dB.** The one-pole model predicted 0.67 dB — ffmpeg's
  release is faster than the model. The plan prints the model's figure, labelled MODELLED.
- **Release 800 ms is right.** 1500 ms leaves gaps 2.0–3.5 dB short; 2500 ms, 6.1–8.7 dB.
  Slowing release to reduce pumping looked like free headroom and was not — measured.
- **`--ceiling 2.0` delivers −1.1 dBTP** post-AAC; 1.0 delivers −0.3.
- Measure gap levels **inside true gaps**, not near segment boundaries.

### Video coach — it must pass a backtest before it may block

The user proposed a second reviewer for **content**: a coach that reads a video's script,
storyboard and stills before anything expensive is rendered. Decided with the user on
2026-09-28:

- **Authority.** It blocks on objective defects and advises on craft. It never approves or
  waives; the user is the final gate.
- **Independence.** `.github/agents/video-coach.agent.md` is generic and read-only, and
  its knowledge comes only from the rubric named at dispatch. It runs on the GPT family,
  because Claude wrote the storyboards.
- **It earns the right to block.** It stays advisory until a backtest against the
  EvalLoopDemo review rounds (`spike/video-coach-backtest`) reaches recall ≥ 50 % and
  precision ≥ 80 % on BLOCKING findings, pooled. Both bars were fixed before any coach
  output existed.
- **Only learnings go in git.** The rubric, its brief and provenance, the protocol, the
  answer key and the hash ledgers are committed. Extracted inputs, stills and coach
  reports are output, and stay out.

| Step | State |
|---|---|
| Freeze: rubric, coach, protocol | `ee835ad` |
| r4–r7 inputs pinned in `inputs.md` | `91bb307` |
| r6c, r2 and r3 extraction | **next** — must happen before the demo session's log is read |
| Answer key, drafted from the user's own review messages | after the log is read; the user confirms it |
| Runs on `gpt-6-sol`, `runs.md`, scoring, ADR 0006 | pending |

The rubric has 27 rules, 10 of them block-eligible. It was written blind by `research` on
`claude-sonnet-5`. Its tool log confirms the blindness, and also shows its regenerated
source lists misstating which pages were read. The README discloses both; `rubric.md` is
not edited.

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
  (`ffe3f82`..`d47cf86`), which neither session can push. The first delivery was
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
- **Still open on the engine**: `render.preview` is declared in the template but no script
  implements it, `evidence-pack/` is resolved unconditionally at module load, and
  `voice.mjs` reflows segment windows but not segment-relative trigger times.

## Watch out for

- **Green is not reviewed.** I committed `c620c88` after a FAIL verdict without re-review,
  and three feature commits with no review at all, because the suites were green. The
  consumer had done the same three times, and their unreviewed engine changes produced 16
  findings — so the base rate was known before I repeated it. Tests check what the author
  thought of; review exists for what they did not. **The orchestrator is not exempt from
  the gate it enforces.**
- **A same-family review is not the gate.** Opus reviewing Opus finds real defects and
  still cannot satisfy §VIII; report it as an audit, never as a verdict.
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
