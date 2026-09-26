# Progress — Forge

> **The domain ledger.** `.github/domains.yaml` says a domain *exists*; this file says what
> state it is actually **in**. Keep it honest — `broken` and `abandoned` are valid, useful
> statuses. A ledger that overstates is worse than none.
>
> **Last updated:** 2026-09-15

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
| `sizzlecraft` | tool (`node`) | 2 | `partial` | 152 (151 pass, 1 skip) | Shared demo-video engine. 20 scripts covering every pipeline stage except S1 (`write-script.mjs`). CLI scripts, not yet a library — most export nothing. Originals do not point here yet. **Group 1 of the audit closed** — safe defaults, exit contract, path confinement, engine-vs-user-named write classification across 49 sinks. **Group 3 (operability) not started; see the blocking preconditions below.** |
| `eval-engine` | lib | 1 | `working` | 1779 passing | Generic eval harness: contracts, assertions, participants, REST/LLM runners, coordinator, statistics (Wilson, McNemar, BH), comparator, baseline providers, impacted selection, machine-path refusal at load and artifact read-back. **Group 2 of the audit (comparison correctness) is not started — 4 open findings.** `Mcp` and `Ui` scenario kinds are declared stubs. |
| `eval-cli` | tool | 2 | `working` | 760 passing | `run`, `baseline update` and `trend`. Suite discovery, impacted selection, artifact writing, committed-artifact and live-endpoint baselines, JSON + text + Markdown reports, PR comparison and trend reports. **Group 1 of the audit closed** — input/output collision matrix, `ArtifactBudget`, `--fail-on-regression` refused rather than ignored, artifact shape checked before publication. |

Add a row whenever `scaffold-domain` creates a domain. Cross-check this table against
`.github/domains.yaml` — if they disagree, one of them is wrong; fix it.

## Spike ledger

| Spike | Question | Status | Disposition | ADR |
|---|---|---|---|---|
| `playwright-ui-capture` | Can Playwright drive a real web UI while capturing deterministic, frame-accurate output suitable for the SizzleCraft pipeline — with a synthetic cursor, speed control, and zoom? | `answered` | **graduate** → `tools/SizzleCraft` (Tier 2), rewritten under the gates the spike skipped | [0003](../docs/adr/0003-drive-real-uis-with-scripted-playwright-frame-capture.md) |

**A spike with `status: answered` that has neither graduated nor retired is debt**
(Constitution §XI). Surface it here and in planning, don't let it accumulate quietly.

## Infrastructure

| Item | State |
|---|---|
| Constitution (`.github/instructions/constitution.instructions.md`) | ✅ §I–§XI |
| Domain registry (`.github/domains.yaml`) | ✅ Schema in place, **0 domains** |
| Orchestrator + planner | ✅ `forge-team`, `forge-team.planner` |
| Builder/reviewer pairs | ✅ `app`, `service`, `tooling` — parameterized by domain |
| Researcher agent | ✅ `researcher` |
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
7. **Repo-wide verification is no longer one command.** `dotnet build Forge.sln` does not
   cover Node domains (ADR 0002) — the registry's per-domain `test_cmd` is the only
   complete story.
8. **Desktop framework undecided.** The scaffold defaults to WPF because it ships with the
   base SDK. Worth a spike and an ADR before the first real desktop app.
9. ~~**`ComparisonResult.NewlyCovered` overclaims, in the engine.**~~ **Closed** by T14a
   (`8f52efa`). The engine now withholds any scenario that was not fully conducted, in three
   named causes — incomplete, over-recorded, errored — and reports them on
   `NewlyCoveredWithheld` / `…Reason` rather than dropping them. `eval-cli`'s workaround was
   deleted in T14b and replaced by a pass-through. One residual, deferred to T15a: the reason
   is a single suite-level string, so a reader cannot attribute a cause to a specific scenario
   from that field alone. Per-scenario attribution is a Tier 1 change and will be sequenced
   only if the report genuinely needs it.
10. **Four tracked follow-ups from the T15 work**, none blocking:
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

## Next

1. Close the environment gaps in `memory-bank/techContext.md` (CSharpier, PSScriptAnalyzer,
   Pester).
2. **Prove the agent loop.** Pick a first real domain and take it through `forge-team`
   end to end — planner, pre-edit approval, builder, reviewer, PASS. Record what broke.
3. Record the outcome here — including what broke.
