# Tech Context — Forge

> **Last verified:** 2026-09-15

## Platform

- **OS:** Windows
- **Shell:** PowerShell 7+ (all commands in this repo assume it; `scripts/**` declares
  `#Requires -Version 7.0`)
- **Repo:** `jacen555/demo`, default branch `main`, GitHub-hosted

## .NET

| Item | Value |
|---|---|
| SDK installed | 9.0.318 |
| `global.json` roll-forward | `latestFeature` on 9.0.100 |
| `TargetFramework` | `net9.0` (`net9.0-windows` for WPF/WinUI, set per project) |
| `LangVersion` | `latest` |
| `Nullable` | `enable` — repo-wide, non-negotiable (§IV) |
| `ImplicitUsings` | `enable` |
| `TreatWarningsAsErrors` | `true` |
| Central Package Management | **On** — `Directory.Packages.props`. Never pin a version in a `.csproj` (§VII). |

`Directory.Build.props` applies these to every project. A domain that needs to differ must
override deliberately and say why in its README.

## Formatting and analysis

| Tool | Role | Status |
|---|---|---|
| **CSharpier** | **Formatting authority** (§IV). `printWidth` 120, config in `.csharpierrc.json`. When an analyzer disagrees with CSharpier, CSharpier is correct. | ⚠️ Not yet installed as a local tool |
| **.NET analyzers** | `AnalysisLevel: latest`, `EnforceCodeStyleInBuild: true` | Active via `Directory.Build.props` |
| **PSScriptAnalyzer** | `scripts/**` must have **zero Error-severity findings** (§IV) | ⚠️ Not installed |
| **.editorconfig** | Editor/analyzer style; layout rules that conflict with CSharpier are disabled there | Present |

**Setup still required:**

```powershell
dotnet new tool-manifest            # if .config/dotnet-tools.json does not exist
dotnet tool install csharpier
Install-Module PSScriptAnalyzer -Scope CurrentUser
Install-Module Pester -MinimumVersion 5.0 -Scope CurrentUser
```

## Test stacks

| Kind | Framework | Assertions | Mocking |
|---|---|---|---|
| .NET (all kinds) | xUnit | FluentAssertions | NSubstitute |
| PowerShell | Pester v5 | Pester | Pester mocks |

Versions are centralised in `Directory.Packages.props`. Never introduce a second framework
into a domain that already has one (§VI).

## Repo-wide commands

```powershell
dotnet build Forge.sln
dotnet test Forge.sln
dotnet csharpier check .
dotnet csharpier format .
Invoke-ScriptAnalyzer -Path scripts -Recurse -Severity Error
```

Per-domain commands come from `.github/domains.yaml` — resolve them there, never from
memory.

**Spikes are excluded from `Forge.sln`** by design (§XI), so they never appear in a
solution-wide build or test run. That is intentional, not a gap.

## Solution layout

```
Forge.sln                  # apps, services, libs, tools + their test projects
apps/<Name>/src|tests
services/<Name>/src|tests
libs/<Name>/src|tests
tools/<Name>/src|tests
scripts/<Name>/src|tests   # PowerShell — not in the solution
spike/<name>/src           # excluded from the solution
```

Projects are added to the solution by the `scaffold-domain` skill, not by hand.

## Agent tooling

| Item | Value |
|---|---|
| Builder model (pinned, §VIII) | `claude-opus-4.8` |
| Reviewer model (pinned, §VIII) | `gpt-5.6-sol` |
| Planner / researcher model | `claude-opus-4.8` |
| Substitution rule | If a pinned model is unavailable, use the newest of the **same family** — never cross families, which would collapse review independence. |

## Environment gaps to close

- [ ] Install CSharpier as a local tool — it is the formatting authority and nothing
      enforces it yet.
- [ ] Install PSScriptAnalyzer — required before the first `scripts/**` domain.
- [ ] Install Pester v5 — required before the first PowerShell test.
- [ ] Decide WPF vs WinUI 3 for desktop work (worth a `researcher` spike + ADR) — the
      scaffold currently defaults to `wpf` because it ships in the base SDK.
- [ ] Consider a pre-commit hook running `dotnet csharpier format .`, mirroring the Husky
      setup used in other repos.
