# Active Context — Forge

> **Last updated:** 2026-09-15

## Current focus

**Bootstrapping the repository.** The multi-agent orchestration, constitution, domain
registry, checklists, prompts, and .NET baseline have just been established. No application
code exists yet.

## What just happened

The repo was empty. It now has:

- **Constitution** (`.github/instructions/constitution.instructions.md`) — §I–§XI, with
  rigor tiers keyed to location as the central idea.
- **Domain registry** (`.github/domains.yaml`) — authoritative paths, tiers, build/test
  commands, and model pins. Currently holds **zero domains**.
- **Agent roster** (`.github/agents/`) — orchestrator (`forge-team`), planner, three
  parameterized builder/reviewer pairs (`app`, `service`, `tooling`), and a `researcher`.
- **Design checklists** (`.github/checklists/`) — one per kind.
- **Spec Kit prompt chain** (`.github/prompts/`) — specify → plan → tasks → implement, plus
  analyze.
- **`scaffold-domain` skill** (`.github/skills/scaffold-domain/`) — the only supported way
  to add and register a domain. **Verified end to end** across lib, spike, script, and tool
  kinds, including `-WithAgents`; three real bugs were found and fixed in the process (see
  `progress.md`).
- **Two workflow modes** — multi-agent (`forge-team`) and single-agent
  (`.github/instructions/single-agent-workflow.instructions.md`).
- **.NET baseline** — `Directory.Build.props`, `Directory.Packages.props`, `.editorconfig`,
  `.csharpierrc.json`, `global.json`, `.gitignore`, `Forge.sln`.

Key decisions are recorded in `docs/adr/0001-multi-agent-orchestration-for-a-workshop-repo.md`.

## Immediate next step

**Add the first domain**, then take it through the full agent loop. `scaffold-domain` is
proven; the plan → build → review loop is not — no domain has yet been built by
`forge-team` with a real builder and an independent reviewer.

```powershell
.\.github\skills\scaffold-domain\scripts\New-ForgeDomain.ps1 -Id <id> -Kind <kind> -Name <Name> -WhatIf
```

Then drop `-WhatIf`, fill in the domain README, and update `progress.md`.

## Open questions

- **First domain?** Unchosen. A `libs/` domain would exercise the Tier 1 path (mandatory
  failing-test-first, downstream-impact reporting); an `apps/` domain would exercise Tier 2
  and the desktop checklist.
- **WinUI 3 vs WPF for desktop work?** The scaffold defaults to `wpf` because it ships with
  the base SDK. WinUI 3 needs a template pack and can be passed via `-Template`. Worth a
  `researcher` spike + ADR before the first real desktop app, rather than defaulting by
  accident.
- **PSScriptAnalyzer is not installed** on this machine. The constitution requires zero
  Error-severity findings for `scripts/**` (§IV), so install it before the first script
  domain: `Install-Module PSScriptAnalyzer -Scope CurrentUser`.
- **CSharpier is not yet installed** as a local tool. `dotnet csharpier` is the formatting
  authority (§IV) — wire it up (and optionally a pre-commit hook) before the first C#
  domain lands.

## Watch out for

- **The registry is the single point of truth.** If a domain folder ever exists without a
  registry row, every builder targeting it will correctly refuse to work. Always scaffold
  through the skill.
- **Tier is not negotiable after the fact.** Choosing `spike/` for something that will be
  depended on skips every gate that matters (§II). Choose the root deliberately.
- **Builders must not touch `memory-bank/`.** This file and `progress.md` are owned by the
  orchestrator or the single-agent coordinator (§IX).
