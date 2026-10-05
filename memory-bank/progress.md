# Progress — Forge

> **The domain ledger.** `.github/domains.yaml` says a domain *exists*; this file says what
> state it is actually **in**. Keep it honest — `broken` and `abandoned` are valid, useful
> statuses. A ledger that overstates is worse than none.
>
> **Last updated:** 2026-10-02

## Status vocabulary

| Status | Meaning |
|---|---|
| `working` | Builds, tests pass, does what its README says |
| `partial` | Builds, but incomplete — the README says what is missing |
| `broken` | Does not build or does not work; needs attention or retirement |
| `abandoned` | Not maintained. Kept only for reference, or awaiting deletion |
| `answered` | Spike only — question answered, awaiting graduate/retire |
| `graduated` | Spike only — rebuilt for real in a proper root |
| `retired` | Deleted; the finding lives in an ADR |

## Domains

| Domain | Kind | Tier | Status | Tests | Notes |
|---|---|---|---|---|---|
| `sizzlecraft` | tool (`node`) | 2 | `partial` | 1077 (1076 pass, 1 skip) at `af5aeef` | Shared demo-video engine. 20 scripts covering every pipeline stage except S1 (`write-script.mjs`). CLI scripts, not yet a library — most export nothing. Originals do not point here yet. **Group 3 of the audit closed** — engine-chosen writes confined, schema enforcing what it claimed, optional reads keeping absent/unreadable/malformed apart, contiguity and word-budget checks answerable, one enforceable precedence rule for every `SIZZLECRAFT_*` knob. **Then a second pass driven by its own consumer**: level checks treat digital silence as a third state rather than a failed measurement, the `code`-mode guard no longer prints what it refuses, and the music gain pin requires confirmation on first use as well as on change — recording `operator-confirmed`, because a measured bed level is not reachable at pin time. `stamp-lineage` was built and **withdrawn**: no artefact bound to synthesis retains the exact narration, so it could only mint false proof. **Third pass, for the same consumer:** the gain pin became a registry that fails closed on a knob nobody declared (seven pinned); silent segments must be declared and captioned, never inferred from absence; a licensed bed is ducked in-graph by a solved `sidechaincompress` threshold, verified by decoding at ~10.4 dB of an 11 dB target; and `vo-envelope.json` is bound to the voiceover it measured. **The third pass landed unreviewed. The 2026-09-28 cross-family review failed it, its findings became T1–T5, and round 2 failed it again on 2026-10-02 — gap 22.** **Then the fixes from the 2026-09-28 audit and §VIII reviews (T1–T5), each gated by a cross-family review:** T1 `a0add0b` makes the scene audits fire (C-14 contrast, C-5 clipped code block) and keeps slides on their seams; T2 `cbac96b` makes write-chapters and write-subtitles plan by default and confines their writes; T3 `b671a2e` binds a baked bed to its narration, pins the crossfade and refuses a duck that cannot be delivered. All three passed review. T4 `53424c2` regenerates declared silence in S4 (remix, concat-audio) from the authored window, without a re-voice, and passed at round 8. F6 `d1d8d47` makes voice check its timeline before it writes anything, in its plan and under `--apply`, and passed at round 2. Two High voice defects its review raised are placed in Q14 and F7 (gap 27). **Q14 `0a5b7f4` closed on 2026-10-02 at review round 2:** remix refuses a shapeless timeline instead of crashing, the shape check gained the schema's segment `id` rule, silent windows are bounded (nonnegative start, finite end, one-hour cap), frame-capture checks every silence declaration before it plans, and the caption gate refuses all seven Unicode mandatory line breaks — UAX #14 classes BK, CR, LF and NL — naming each distinct one by code point. Round 1 failed on two: an array index printed inside id quotes as `segment "1"`, and U+2028/U+2029 written unexamined into both subtitle sidecars at exit 0. Q14 absorbed the silence findings S2-1..S2-4 and K4, which are now closed. **R5 `af5aeef` closed on 2026-10-03:** narrated text containing `-->` is refused rather than written into both subtitle sidecars, where Chromium parses the cue with EMPTY text so the caption silently disappears — the narrated half of Q14's silent-caption rule, checking both `voiceoverText` and the raw measured word a cue falls back to. T5 (documentation) has not started. |
| `eval-engine` | lib | 1 | `working` | 2066 passing | Generic eval harness: contracts, assertions, participants, REST/LLM runners, coordinator, statistics (Wilson, McNemar, BH), comparator, baseline providers, impacted selection, machine-path refusal at load, write and read. **Group 2 of the audit closed** — identity-derived seeds, runner and participant attestation frozen pre-dispatch, verdicts refused without their evidence, identifiers guarded at every stage entry, fixtures driven by real runners. `Mcp` and `Ui` scenario kinds are declared stubs. |
| `eval-loop-demo` | tool (`node`) | 2 | `working` | 32 passing | Demo-video project *"How do you test a conversation?"* — **SizzleCraft's first end-to-end consumer**, and the reason 10 engine defects are known. 8 segments, 4:42 at 4K/JPEG on this branch; a 4:37 four-facts cut with the ducked mix is verified on the consumer's branch and **not merged** (gap 23). Supplies its own S1 (`write-script.mjs`), the one stage the engine deliberately excludes. Tests pin the traps that cost a render: segment-qualified trigger targets, edges needing explicit `drawEdge`, no trigger past a reflowed segment end, diagram viewBox aspect, no-go strings, and the music-attribution ⇒ end-card invariant. |
| `eval-cli` | tool | 2 | `working` | 758 passing | `run`, `baseline update` and `trend`. Suite discovery, impacted selection, artifact writing, committed-artifact and live-endpoint baselines, JSON + text + Markdown reports, PR comparison and trend reports. **Groups 1 and 2 closed** — input/output collision matrix, `ArtifactBudget`, `--fail-on-regression` refused rather than ignored, and the positional `SeedSchedule` workaround deleted now the engine derives seeds from identity. |

Add a row whenever `scaffold-domain` creates a domain. Cross-check this table against
`.github/domains.yaml` — if they disagree, one of them is wrong; fix it.

## Spike ledger

| Spike | Question | Status | Disposition | ADR |
|---|---|---|---|---|
| `playwright-ui-capture` | Can Playwright drive a real web UI while capturing deterministic, frame-accurate output suitable for the SizzleCraft pipeline — with a synthetic cursor, speed control, and zoom? | `answered` | **graduate** → `tools/SizzleCraft` (Tier 2), rewritten under the gates the spike skipped | [0003](../docs/adr/0003-drive-real-uis-with-scripted-playwright-frame-capture.md) |
| `video-coach-backtest` | Would a pre-render content coach, given only a round's pre-render artifacts (script, timing, storyboard, stills), have caught at least half of the objective defects the user reported across the EvalLoopDemo review rounds, with the user agreeing with at least 4 in 5 of its blocking findings? | `answered` — **No**: recall 1/3 against a 50 % bar, precision 4/4 (`b3cffb0`) | **graduate**, as an advisory-only step in the demo pipeline, rebuilt under Tier 2 gates with its own reviewed rubric. Not started | [0006](../docs/adr/0006-keep-the-video-coach-advisory-only.md) |

**A spike with `status: answered` that has neither graduated nor retired is debt**
(Constitution §XI). Surface it here and in planning, don't let it accumulate quietly.

## Infrastructure

| Item | State |
|---|---|
| Constitution (`.github/instructions/constitution.instructions.md`) | ✅ §I–§XI |
| Domain registry (`.github/domains.yaml`) | ✅ Schema in place; its domains are the rows above |
| Orchestrator + planner | ✅ `forge-team`, `forge-team.planner` |
| Builder/reviewer pairs | ✅ `app`, `service`, `tooling` — parameterized by domain |
| Researcher agent | ✅ `researcher` |
| Video coach | ⚠️ `video-coach` — pre-render content review. **Advisory only** (ADR 0006): its backtest answered No, so it never gates a render. Graduating into the demo pipeline; not started |
| Design checklists | ✅ app, service, tooling, script |
| Spec Kit prompts | ✅ specify, plan, tasks, implement, analyze |
| `scaffold-domain` skill | ✅ SKILL.md + `New-ForgeDomain.ps1` — **verified end to end** for lib, spike, script, tool, `-WithAgents`, and `-Language node` |
| `demo-recording` skill | ✅ SKILL.md + pipeline contract + bug ledger + knobs/render-log templates |
| Node.js support | ✅ Constitution §IV subsection, registry `languages` block, `-Language node` scaffolding, ADR 0002 |
| Single-agent workflow | ✅ `.github/instructions/single-agent-workflow.instructions.md` |
| Memory bank | ✅ 6 core files seeded |
| .NET baseline | ✅ `Directory.Build.props`, `Directory.Packages.props`, `.editorconfig`, `.csharpierrc.json`, `global.json`, `.gitignore`, `Forge.sln` |
| CSharpier local tool | ⚠️ Not installed — it is the formatting authority (§IV) |
| PSScriptAnalyzer | ⚠️ Not installed — required before the first `scripts/**` domain |
| Pester v5 | ⚠️ Not installed — required before the first PowerShell test |

## What works end to end

**Verified by smoke test on 2026-09-15** (artifacts created, checked, then removed):

- `scaffold-domain` for **lib** (Tier 1), **spike** (Tier 0), **script** (Tier 2), and
  **tool** with `-WithAgents` — all four create the folder, README, projects, solution
  entry where applicable, and a valid registry row.
- `dotnet build Forge.sln` → **0 warnings, 0 errors** with `TreatWarningsAsErrors`,
  Central Package Management, and the analyzer set active.
- `dotnet test Forge.sln` → **passing**.
- **Solution exclusions hold:** spike and script domains are correctly absent from
  `Forge.sln` (§XI).
- **Guard rails fire:** spike without `-Question`, `-NoTests` on a Tier 1 kind, and a
  duplicate domain id are all rejected with actionable messages.
- **`-WhatIf` is honest** — reports the plan and makes no changes.
- **Generated agent pairs** get the correct `name:` frontmatter, keep the reviewer
  read-only (`tools: ['read','search']`), and carry an edit-me domain-lock note.
- **Registry stays valid YAML** across the `domains: []` → `domains:` conversion and
  subsequent appends.

Three real bugs were found and fixed by this testing:

1. **NU1008** — `dotnet new` templates pin package versions in the `.csproj`, which fails
   restore under Central Package Management. Fixed by `ConvertTo-CentralPackageManagement`,
   which strips the `Version` attributes and warns on any package missing a
   `PackageVersion` entry.
2. **Scaffolded libs did not build** — the template's undocumented `Class1` tripped the
   `libs/**` XML-doc requirement (§IV). Fixed by emitting documented starter code instead.
3. **`script` kind crashed** — its empty template value failed the `-Template` parameter's
   own `[ValidateNotNullOrEmpty()]` on reassignment. Fixed with a local variable.

A fourth was found when Node support was added:

4. **`node --test <dir>` does not work** on Node 22 — it resolves the directory path as a
   module and fails with `MODULE_NOT_FOUND`. Registry `test_cmd` for Node domains must use
   a glob (`node --test "path/tests/**/*.test.mjs"`) so it works from the repo root; bare
   `node --test` works from the domain folder. `npm --prefix <path> test` does **not** work
   — it does not change the working directory.

**Not yet exercised:** the plan → build → review agent loop itself. No domain has been
built through `forge-team` with a real builder and reviewer. That is the next real test.

## Known gaps

1. **`SuiteLoader` path confinement — open task, accepted deliberately.** The independent
   reviewer's three remaining findings are all in this one file:
   - `Directory.Exists` follows symbolic links on Unix, so an out-of-root or network-mounted
     target can be inspected before the boundary predicate runs.
   - The validate-then-open sequence is racy: a writer can swap an in-root entry for an
     escaping link between the two operations.
   - A volume root already ends in a separator, so appending another makes valid child paths
     fail containment.

   These were accepted rather than fixed because TOCTOU-safe, cross-platform, confined file
   access is a deep problem and not what a contracts task is for. **Nothing T4–T15 builds on
   is affected** — review findings converged onto this file alone from round 3 onward, and the
   contracts, seams, serialization, assertions, results and transcripts are clean. Fix before
   the harness loads any suite file an untrusted party can write.
2. **The agent loop is now proven** — T3 ran plan → build → review → iterate five times with a
   cross-family reviewer and materially improved the code each round. See "What works end to
   end". This closes the previous gap #1.
3. **The SizzleCraft extraction is not yet banked.** The two original projects under
   `~/SizzleCraft/` still hold their own copies of the scripts. Until they point at
   `tools/SizzleCraft`, the duplication is *recorded*, not *removed*. **This turned out to
   be load-bearing**: the first project to consume the extracted engine end to end
   (`tools/EvalLoopDemo`) hit 10 defects, 6 of them fatal to any second consumer — scripts
   spawned by bare filename, files that ship nowhere, sibling names hardcoded. None of it
   is visible from reading; all of it is unavoidable from running.
4. **`encode-mp4` link guards are a blocking precondition for group 3, not a follow-up.**
   Four engine-chosen paths are unconfined: `copyFileSync` into `encoder/` (`:223`),
   `openSync(partPath, 'w+')` (`:280`), `mkdirSync(encoderDir)` (`:211`), and a guard at
   `:173` that resolves the canonical target while `renameSync` at `:333` replaces the
   lexical entry. All four are unreachable **only** because `encoder-page.html` was never
   extracted — and extracting it is the first thing group 3 does. The guards and the
   exclusive part-file creation must land in the *same* change that makes encode operable,
   with the outside-link victim tests written first. Making it work before confining its
   writes would ship a reachable path.
5. **`write-script.mjs` (S1) is still unextracted.** It diverged ~120% between projects —
   genuinely rewritten rather than drifted — and needs a review to separate shared logic
   from per-video content. The other four "diverged" scripts turned out to be hardcoded
   config and are now parameterized. `materialize-footage.mjs`, `clip-video.mjs` and
   `grab-crops.mjs` are also unextracted, which makes `footage` mode unusable by any
   project.
6. **Prettier not enforced** for Node domains (CSharpier is now installed and enforced for C#).
7. **PSScriptAnalyzer and Pester are not installed**, so the `scripts/**` verification path
   has never actually been executed.
8. ~~**`SIZZLECRAFT_*` override precedence is inconsistent within one file.**~~ **Closed** by
   `5979e4d`. One `resolveKnob`, one stated rule — environment overrides config overrides
   default — and a scanner test that fails when a new knob bypasses it. That scanner
   immediately found a **sixth** knob (`SIZZLE_MUSIC_PRESET`, a different prefix, invisible
   to every earlier count), now carried as a legacy alias. **One stated limit:** an author
   who aliases the global first (`const p = process; p.env.X`) defeats any purely textual
   rule. Recorded in the scanner's doc comment and in the README. Ruled a recordable Tier 2
   limit for a drift guard — the guard exists to stop a knob arriving by copying a
   neighbour, which is how all six arrived, not to sandbox a determined author. Closing it
   needs a real parser and would be its own task.
9. ~~**The word budget is a planning check run after synthesis.**~~ **Closed** by `5979e4d`.
   Suppression now requires **proof of lineage** — a sha256 of the exact narration, written
   by `voice.mjs` and checked by `validate-timing`. A summary of `{words, chars, clipMs}`
   collides: `"word0 word1 word2 word3"` and `"other word1 word2 word3"` are identical under
   all three. An absent fingerprint is **UNPROVEN, not intact**, so old calibrations evaluate
   the budget until a voice re-run records one. Worth keeping: removing the safety margin
   still left half the segments warning, because half a population must exceed its own mean —
   the margin was never the defect.
10. ~~**The calibration lookup reads a key nothing writes.**~~ **Closed** by `5979e4d`. Reads
    `aggregate.observedEffWps`; a calibration that parses but yields no rate is its own error
    rather than rendering as absent. `wpsSafetyMargin` got its own verdict with evidence —
    legitimately absent, declared under `intake` only, and `observedSafeWps` is
    `effWps / roundedSpeed`, not a margin. Same error in form, no data to miss.
11. ~~**The contiguity check can never pass.**~~ **Closed** by `5979e4d`. An overlap fails; a
    gap passes and is reported; an uneven gap is called out. `safe-defaults.test.mjs:182`,
    which pinned the defect as a requirement, was replaced. **One recorded limit:** the
    lead-in counts as an "inter-segment gap", so otherwise-uniform gaps can print `UNEVEN`.
    Advisory, and the detail lines name each affected segment. Kept deliberately to match the
    consuming project's accepted wording rather than diverging unilaterally; correct on both
    branches together.
12. **Four unguarded reads in `write-build-html.mjs`** — **closed** by `1aa6924`; retained here
    hands it to `JSON.parse`, whose error quotes the first bytes parsed — the same
    disclosure just closed at `encode-mp4.mjs:54`, and **High**. `:124`, `:126` and `:131`
    read `clips.json` / `manifest.json` / `evidence-pack.json` through the same unguarded
    join but are `catch {}`-swallowed, so they disclose nothing via a message while still
    reading through a link into the rendered page — **Medium**, each needing its own
    verdict. Severity rises with the new `code` mode, which renders **source data** into the
    frame rather than authored copy: an unguarded `jsonFile` does not leak into a log, it is
    composited into the video and encoded.
13. **Repo-wide verification is no longer one command.** `dotnet build Forge.sln` does not
    cover Node domains (ADR 0002) — the registry's per-domain `test_cmd` is the only
    complete story.
14. **The fixture-shape inventory is guarded by a count, not by evidence.**
    `FixtureFidelityTests` drives real runners into every modelled `(exchange, stoppedBy)`
    pair and compares full values, and the factory inventory is closed by reflection. But a
    **matched deletion** of a pair whose two constants both appear in other pairs still
    satisfies every check except a count tripwire. Closing it properly needs a disposition
    for all 63 cells of the constant cross-product, judged disproportionate. Accepted by the
    reviewer as "an honest, recordable tripwire" — it is not proof, and should not be
    described as one.
15. **Assertion operands live in evidence surfaces and are deliberately not guarded there.**
    ADR 0005's accepted under-guarding, with the boundary now explicit: an operand is
    accepted **in** the suite and the transcript, because the consumer nets those at
    publication — and refused **into** anything the consumer publishes without netting: the
    artifact diagnostic, the log, and `ScenarioSelection.Detail`. The general form is *output
    the consumer does not net*, not *logs*; an earlier framing as "not a build log" was a
    special case. An operand naming a machine path therefore reaches the suite file and the
    transcript, by design.
16. **The method exemption requires a leading bare method.** `presence:response/GET /home/dashboard`
    is refused **as a scenario id**, because ordinal 0 is `presence:response/GET` rather than a
    bare method, so the ordinal-1 exemption misses. Pre-existing and **not** the round-5
    regression: a 26-site sink sweep confirms no assertion expression reaches this predicate,
    so an assertion spelled that way still loads. Left unfixed deliberately — changing an
    exemption's shape in `MachinePath` is what produced this audit's only false refusal, and
    doing it safely needs the route-shaped positives pinned first.
17. **Desktop framework undecided.** The scaffold defaults to WPF because it ships with the
    base SDK. Worth a spike and an ADR before the first real desktop app.
18. ~~**`ComparisonResult.NewlyCovered` overclaims, in the engine.**~~ **Closed** by T14a
   (`8f52efa`). The engine now withholds any scenario that was not fully conducted, in three
   named causes — incomplete, over-recorded, errored — and reports them on
   `NewlyCoveredWithheld` / `…Reason` rather than dropping them. `eval-cli`'s workaround was
   deleted in T14b and replaced by a pass-through. One residual, deferred to T15a: the reason
   is a single suite-level string, so a reader cannot attribute a cause to a specific scenario
   from that field alone. Per-scenario attribution is a Tier 1 change and will be sequenced
   only if the report genuinely needs it.
19. **Four tracked follow-ups from the T15 work**, none blocking:
    - **T15b** — the trend report. The comparison report exists; a separate
      dashboard showing movement across runs does not.
    - **T15c** — `NewlyCoveredWithheldReason` is a single suite-level string, so
      with mixed causes a reader cannot attribute a cause to a scenario. The
      comparator already computes the per-scenario reason and discards it at the
      boundary. Tier 1; the report evidenced the need (ADR 0004's consumer
      argument).
    - **T15g** — `simulation.scriptedStimuli[].field` is label-like but sits under
      `simulation`, which the T15d enumeration classified as evidence. Where the
      label/evidence line falls deserves its own decision, not a fix round.
    - **T15h** — three CLI-owned messages still print an absolute path to stderr
      deliberately. That may be correct — the tool printing it once under its own
      policy — but it should be a decision rather than a leftover.

20. **`resolveFfmpeg` builds its pointer-file path with a raw `path.join`**, in
    `remux-music.mjs` and `check-levels.mjs` both. Graded narrow and left open
    deliberately: the path is `--apply`-only, and an attacker who can write
    `ffmpeg-path.txt` in the project root can set the binary directly, so
    confining it buys only the link-without-write case. **Fix both files in one
    task**, and settle whether the pointer file is engine-chosen or author-chosen
    first — that answer decides which resolver it wants.

21. **12 raw `path.join(projectDir, …)` sinks across 9 files — swept, not traced.**
    **Severity unknown, and that is the point.** A builder declined three rounds
    running to grade them without tracing each to its resolver, which was correct:
    **a sweep produces candidates, not conclusions.** Publishing 12
    unsecured-sounding items would have overstated the evidence in exactly the way
    this audit spent forty rounds learning not to. Schedule the traced sweep as its
    own task; grade each sink only once its resolver is known.

22. **SizzleCraft's third pass landed unreviewed, failed its retrospective review, and
    failed round 2.**
    - Landing `c620c88`, `331ddac`, `c3f1e56` and `34fa0e7` without a cross-family review
      was a §VIII breach on the orchestrator's side. The 2026-09-28 audit ran on
      `claude-opus-5.5`, the builders' own family, so **it found defects without
      satisfying the gate**.
    - **The cross-family review ran on 2026-09-28**, against `c526a79`. Three `gpt-6-sol`
      `tooling-reviewer`s split the commits:
      - pin: `c620c88`; it also confirmed that commit's two round-1 fixes;
      - silence: `331ddac`, with the consumer's `2e5a62e`;
      - duck: `c3f1e56`, with `34fa0e7`.
    - **All three returned FAIL.** On process, because no commit recorded
      TEST-FIRST-EVIDENCE, which cannot be supplied after the fact. And on substance.
      Their findings, unioned with the audit's, became T1–T5.
    - T1–T4 and F6 each passed a cross-family review of **their own diff only**. That does
      not show every 2026-09-28 finding was carried into the union, placed and closed.
      **Round 2 checked exactly that**, on 2026-10-02: the same three reviewers, a frozen
      export at `1a9cfa2` (67 of 67 blobs re-verified after the reviews), with T5's queued
      findings excluded.
    - `d71c605` brought the consumer's code-block wrap (gap 23) into this branch byte for
      byte (9 lines, 0 differing), and was committed as unreviewed. T1 `a0add0b` corrected
      its CSS. Until 2026-10-02 this file credited that correction to `d71c605`.
    - **Round 2 failed all three.** The orchestrator confirmed every finding by a probe, a
      mutation or a read; none was refuted:
      - pin: the union's findings are fixed, except that no test publishes a lock —
        deleting remux's lock-writer call leaves all 883 tests passing (PARTIAL). New:
        `audit` budgets gains by literal and count, not position, so a `volume=1.5` moved
        onto the voice chain is accepted (High, latent); gain-pin's guidance says there is
        nothing to measure, then that `--confirm-gain` asserts a person measured (Medium).
      - duck: D-h2 (an older ducked bed with no record is accepted as absent) and D-m2
        (`durationMs` against the frame count) are PARTIAL. New: make-music publishes its
        record, then writes `music.wav` unconditionally and through links (High); it
        indexes the envelope at 20 ms whatever its `hopMs` (High); and no test checks the
        PCM is ducked — deleting the multiplier leaves all 883 passing (Medium).
      - silence: the union's findings are fixed. New: a silent `startMs` of `null`,
        `"1000"` or `[]` becomes a window (High); a silent window has no upper bound, so
        `endMs` 1e10 asks `silentMp3` for 120 GB (High); frame-capture derives a
        declared-silent `endMs` from stale audio (Medium); a caption carrying a cue
        separator reaches the VTT raw (Medium). The orchestrator added K4 (Low): a `NaN`
        window prints as `nullms`.
      - `d71c605`: FAIL on process only, for want of a BUILDER-MODEL. Measured since from
        local usage telemetry: the consumer session's main agent, which wrote `ffe3f82`,
        ran only `claude-opus-5`; `d71c605` was committed on `claude-opus-5.5`. Both are
        cross-family to the `gpt-6-sol` reviewer. The cloud session store returned no rows,
        even for this session, so its zero was not evidence.
    - **Process stays FAIL, permanently.** T1–T3's builder reports were never archived, and
      their commit messages name no pre-fix failure and no exact command. T4's and F6's
      evidence exists in session files, but the brief gave the reviewers only commit
      messages, so **the orchestrator's brief made a process PASS unreachable by
      construction**. From Q14 on, each commit message carries its TEST-FIRST-EVIDENCE and
      BUILDER-MODEL.
    - **The union was not faithful.** It downgraded P-h2 (High→Medium), S-h6 (High→Low,
      having considered only narrated→silent) and S-t1 (High→Medium), narrowed D-h2 to
      "the filename must change" and D-m2 to remux's default, and its D-m1 row omitted a
      gap. The reviewers' severities stand.
    - Placement, proposed and pending the user: the silence findings fold into Q14; a duck
      task and then a pin task follow F7; gain-pin's wording goes into T5. D-h2's residue
      needs a design call, since a licensed bed has no record by design.
    - **From 2026-09-28 to 2026-10-02 this entry said "no independent review".** It was
      written in `c526a79`, the commit the reviewers were dispatched against, and not
      updated when the FAILs arrived that afternoon. The orchestrator repeated the claim in
      `1a9cfa2` and in a question to the user.
23. **Neither this branch nor the consumer's can be pushed.**
    - The consumer rebased `eval-loop-demo-build` onto `013cdc8`. Measured on 2026-10-02:
      0 behind, 13 local commits at `6ef6ca9`, none touching `tools/SizzleCraft`. Its old
      `ffe3f82`, `4134283` and `d47cf86` are ancestors of neither branch.
    - `ffe3f82`'s unreviewed 9-line code-block wrap reached this branch as `d71c605`
      (gap 22).
    - Both linked accounts get 403 on push (EMU read-only), so delivery waits on someone
      with write access.
24. **Two silent-segment paths have been read, never run.**
    - `voice.mjs` generates a clip for a declared-silent segment and reflows the timeline
      (needs live TTS).
    - `remix.mjs` applies its gap rule (needs Playwright).

    The consumer's project has no silent segment, so no real render has exercised
    either path. The first project with an intro slide or an intermission is the test.

    Since `cbac96b` (T2), a fake-audio harness runs the `--apply` paths of `voice.mjs`
    and `remix.mjs` under test, and T4 (`53424c2`) uses it for the silent paths. Fakes
    stand in for TTS and the decoder, so the gap stays open until a real render runs.
25. ~~**The engine's WCAG contrast audit has never fired (C-14).**~~ **Closed** by
    `a0add0b` (T1). The colour regex was mangled by template-literal escaping, so every
    red channel parsed as `NaN` and no ratio could fall below a threshold. It now parses,
    and text that no sample point reaches is reported as unverified, never passed.
    Checking the engines that drew the backtest rounds found other lanes thinner than the
    docs say. **These stay open:**
    - rendered text size is logged as advisory and never fails;
    - graphics contrast is never measured;
    - overflow is checked for the `.safe` box and, since `a0add0b`, for a `.codeblock`
      that clips its content (C-5) — not for any other element clipped by its container;
    - nothing checks visual events overlapping within a segment;
    - nothing checks one diagram element drawn across another (R6-13). The backtest
      showed the coach misses it too, because no rubric rule covers it;
    - encoded true peak is never measured, as the engine's own comment says.

    The same-family audit that found C-14 raised 13 Highs. The user approved a fix plan
    (T1–T5) on 2026-09-28. Nine are fixed in committed code: C-1 to C-5 by T1 and T2, B-1
    by T3, and A-1 to A-3 by T4 (`53424c2`). D-1 to D-4 are T5's documentation.
26. **Is the bed 20 dB under the speech?** WCAG 2.2 SC 1.4.7 (Level AAA, written for
    audio-only content) asks for background sound at least 20 dB below foreground
    speech. The mix is set by its own targets: −41 dB for the bed under speech and
    −30 dB in gaps. Whether those put the EvalLoopDemo bed 20 dB under its narration has
    not been measured. The rubric author raised it; it is a question for the consumer,
    not a finding.
27. **voice still writes before two failures.** Both are pre-existing, rated High by F6's
    round-1 review, and outside F6. Both plan as runnable (exit 0). Under `--apply`, with
    the fake audio backends:
    - an enabled end card fails only after voice has overwritten every clip: an outro over
      3,600,000 ms exits 1; a missing `builderVersion` exits 1 with a stack, after
      `voiceover.mp3` is overwritten too;
    - a segment with no string `id`, narrated or silent, passes the gate, and voice
      crashes at `seg.id.padEnd` after writing the clips up to and including that
      segment's.

    **The user placed both on 2026-10-02.** The id case folds into Q14, whose shape check
    gains the schema's `id` rule. The end-card case is F7, straight after Q14.

    **Both are now closed.** The id case by Q14 (`0a5b7f4`) — verified by measurement, not
    by assumption: exit 2, zero TTS calls, nothing written. The end-card case by F7
    (`127f2a8`) — `endCardBlocker`, reached from `voiceTimelineBlocker`, so the gate other
    stages ask and the pre-write gate are the same check.

    **What F7 cost, and why it is worth recording:** the defect was in
    `tests/_helpers.mjs`'s own `timingFixture`, which declared an enabled end card with no
    `builderVersion` and was inherited by 105 test references. So `README.md:156`'s stated
    invariant — "a remedy names a stage only where that stage would run" — was already
    violated at HEAD for every fixture-derived timeline. Fixture isolation was proven
    rather than asserted: HEAD-plus-fixture-only produces a pass/fail set identical to HEAD
    across all 1189 entries (0 only-in-A, 0 only-in-B, 0 verdict changes), with a control
    that detects an injected flip.

28. **R4 — a null `timing.segments` entry crashes four stages**, each with a stack:
    `frame-capture.mjs:119` (`msOf(s.endMs)`), `write-storyboard.mjs:37` (`s.visual || {}`),
    `concat-audio.mjs:108` (`s.audio?.file` — the optional chain guards `audio`, not `s`),
    and `validate-scene.mjs` before `checkC1`. A number or an array entry is handled
    correctly at all four (exit 1, no stack), which is what makes the null a defect rather
    than a missing feature.

    **The refusal already exists** — `shapeBlocker` (`silent-segment.mjs:868`) returns
    ``timing.segments[${i}] is not a segment object``, which is exactly the behaviour the
    user chose. All four stages already import that module. See activeContext, "the engine
    already had the answer". In flight across two streams, split pre-capture/downstream.

    `frame-capture.mjs:122` already writes ``segments[${i}]${s?.id ? …}`` — defensive
    against a null that `:119` prevents from ever arriving. R4 is finishing a half-written
    guard, not adding one.

## Next

**SizzleCraft queue, in the user's order (2026-10-01, extended 2026-10-02):** F6 (done,
`d1d8d47`) → Q14 (done, `0a5b7f4`) → R5 (done, `af5aeef`) → F7 (done, `127f2a8` + docs
`7a6dd98`) → the `assertCleanExit` fix → validate-scene (done, `e0fe668` + `d17c9be`) →
T5, with the T4 follow-ups batched in → Prettier adoption (**must be last** — it reformats
everything) → coach graduation G5, G1, G2+G3, G4, G6, G7. "Shape-first everywhere" (R1 plus
the three uncited `?? i` sites), R4 (in flight, gap 28), narrated line breaks, and gating
`voice.mjs` are unplaced; the measured site lists are in `activeContext.md`. Each is Tier 2:
a plan, pre-edit approval, a failing test first, then a cross-family review. Round 2 of the
2026-09-28 reviews failed on 2026-10-02 (gap 22). Its silence findings (S2-1..S2-4, K4) were
absorbed into Q14 and are closed; the duck and pin findings were approved by the user and are
now done (`995c917`, `e85e355`, `b375d95`), each reviewed to PASS.

**2026-10-05 — three parallel streams, nothing pushed.** Five commits across three local
branches: `multi-agent-orchestration` (2), `validate-scene` (2), `duck-and-pin-round-2` (3).
Chosen after measuring that the candidate tasks had **zero overlapping files**. Suite stands
at 1165/1164 pass/0 fail/1 skip on the validate-scene branch, 1122/1121/0/1 on duck-and-pin.
Topology and the one-owner-per-file rule are in `activeContext.md`.

**Residual risk carried deliberately:** a bed with no `.duck.json` is accepted and disclosed
as `absent` (`remux-music.mjs:513`) — licensed beds legitimately have none, the user's call.
And `auditSites` accounts by chain, so two values swapped WITHIN one chain are undetectable;
that is pinned as a passing test (`audit_twoValuesSwappedWithinTheSameChain_isNotDetected`)
rather than left as a comment, which is the convention `mix-parameters.mjs` already uses.

1. Close the environment gaps in `memory-bank/techContext.md` (CSharpier, PSScriptAnalyzer,
   Pester).
2. **Prove the agent loop.** Pick a first real domain and take it through `forge-team`
   end to end — planner, pre-edit approval, builder, reviewer, PASS. Record what broke.
3. Record the outcome here — including what broke.
