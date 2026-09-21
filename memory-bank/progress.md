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
| `sizzlecraft` | tool (`node`) | 2 | `partial` | 13 passing | Shared demo-video engine. 20 scripts covering every pipeline stage except S1 (`write-script.mjs`). CLI scripts, not yet a library — most export nothing. Originals do not point here yet. |

Add a row whenever `scaffold-domain` creates a domain. Cross-check this table against
`.github/domains.yaml` — if they disagree, one of them is wrong; fix it.

## Spike ledger

_No spikes yet._

| Spike | Question | Status | Disposition | ADR |
|---|---|---|---|---|
| _(none)_ | | | | |

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

1. **The agent loop itself is unproven.** `scaffold-domain` is verified, but no domain has
   been taken through `forge-team` → planner → builder → reviewer → PASS. Until that runs,
   the orchestration is configuration, not a demonstrated workflow.
2. **The SizzleCraft extraction is not yet banked.** The two original projects under
   `~/SizzleCraft/` still hold their own copies of the scripts. Until they point at
   `tools/SizzleCraft`, the duplication is *recorded*, not *removed*.
3. **`write-script.mjs` (S1) is still unextracted.** It diverged ~120% between projects —
   genuinely rewritten rather than drifted — and needs a review to separate shared logic
   from per-video content. The other four "diverged" scripts turned out to be hardcoded
   config and are now parameterized.
4. **No formatting enforcement.** CSharpier is the declared authority (§IV) but is not
   installed and no hook runs it. Prettier likewise for Node domains.
5. **PSScriptAnalyzer and Pester are not installed**, so the `scripts/**` verification path
   has never actually been executed.
6. **Repo-wide verification is no longer one command.** `dotnet build Forge.sln` does not
   cover Node domains (ADR 0002) — the registry's per-domain `test_cmd` is the only
   complete story.
7. **Desktop framework undecided.** The scaffold defaults to WPF because it ships with the
   base SDK. Worth a spike and an ADR before the first real desktop app.
8. **`Directory.Packages.props` versions were not verified against the feed.** The lib
   smoke test restored successfully, so the test stack is good; the hosting and CLI entries
   are unproven until something references them.

## Next

1. Close the environment gaps in `memory-bank/techContext.md` (CSharpier, PSScriptAnalyzer,
   Pester).
2. **Prove the agent loop.** Pick a first real domain and take it through `forge-team`
   end to end — planner, pre-edit approval, builder, reviewer, PASS. Record what broke.
3. Record the outcome here — including what broke.
