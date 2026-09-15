---
name: scaffold-domain
description: >
  Create and register a new Forge domain — a desktop app, service, library, tool,
  script, or spike. Use when the user says "add a new app", "create a service",
  "start a new project", "scaffold a library", "make a new tool", "set up a spike",
  "I want to try X in a new project", or when a builder/orchestrator hits a domain
  that is missing from .github/domains.yaml. Creates the folder, README, project and
  test scaffolding, the Forge.sln entry, and the domain registry row in one step —
  and can optionally mint a dedicated builder/reviewer agent pair.
---

# Scaffold Domain

> Adds a new domain to the Forge workshop repo **and registers it**, so the
> multi-agent system can resolve it. Never create a project folder by hand — an
> unregistered domain is a blocking error for every builder (Constitution §I).

## Why this exists

Forge's agents are **parameterized by domain**: the orchestrator passes a domain id, and
the builder resolves paths, project files, and build/test commands from
`.github/domains.yaml`. That only works if the registry is complete and accurate. This
skill is the single supported way to add a row to it.

## When to use it

- The user asks to start a new app, service, library, tool, script, or spike.
- The planner emits a `T0 [repo] scaffold domain <id>` task.
- A builder returns an error report saying its domain is not registered.

## Before you scaffold: pick the right root

The root determines the **rigor tier**, and the tier is not negotiable afterwards
(Constitution §II). Choose deliberately:

| Root | Kind | Tier | Choose when |
|---|---|---|---|
| `apps/` | `app` | 2 | It has a window. WinUI 3, WPF, or a rich console UX. |
| `services/` | `service` | 1 | It runs unattended — an HTTP API, a worker, a daemon. |
| `libs/` | `lib` | 1 | **More than one** domain will consume it. Highest blast radius. |
| `tools/` | `tool` | 2 | A developer runs it from a terminal to get something done. |
| `scripts/` | `script` | 2 | PowerShell automation. No compilation step. |
| `spike/` | `spike` | 0 | You are answering **one question** and expect to throw it away. |

**Ask the user if the intent is ambiguous.** The most consequential question is:

> Are you building this to **keep**, or to **learn**?

"Learn" means `spike/` at Tier 0 — fast, no approval stop, no test mandate. "Keep" means a
real root with real gates. Getting this wrong in either direction is expensive: a spike in
`services/` drowns in ceremony, and production code in `spike/` skips every gate that
matters.

**Do not use `spike/` to dodge a gate.** If the code is going to be depended on, it belongs
in a real root. That is a review FAIL (Constitution §II).

A spike also needs its **question** stated up front — one falsifiable question. If the user
cannot state it, they want a `tool/` or an `app/`, not a spike.

## Usage

```powershell
# A desktop app (Tier 2, WPF by default)
.\.github\skills\scaffold-domain\scripts\New-ForgeDomain.ps1 `
    -Id clipboard-history -Kind app -Name ClipboardHistory -WhatIf

# A service (Tier 1, ASP.NET Core Web API, with tests)
.\.github\skills\scaffold-domain\scripts\New-ForgeDomain.ps1 `
    -Id ledger -Kind service -Name Ledger

# A shared library, with its own dedicated builder/reviewer agent pair
.\.github\skills\scaffold-domain\scripts\New-ForgeDomain.ps1 `
    -Id forge-core -Kind lib -Name Core -WithAgents

# A PowerShell script domain
.\.github\skills\scaffold-domain\scripts\New-ForgeDomain.ps1 `
    -Id env-setup -Kind script -Name EnvSetup

# A spike — the question is mandatory
.\.github\skills\scaffold-domain\scripts\New-ForgeDomain.ps1 `
    -Id channel-vs-blockingcollection -Kind spike -Name ChannelVsBlockingCollection `
    -Question 'Is Channel<T> measurably faster than BlockingCollection<T> at our expected throughput?'
```

**Always run with `-WhatIf` first** and show the user the plan before applying it.

## Parameters

| Parameter | Required | Notes |
|---|---|---|
| `-Id` | yes | kebab-case, unique. Becomes the Conventional Commit scope (§X). |
| `-Kind` | yes | `app` \| `service` \| `lib` \| `tool` \| `script` \| `spike` |
| `-Name` | yes | PascalCase folder/project name. |
| `-Question` | for spikes | The one falsifiable question the spike answers. |
| `-Template` | no | Override the `dotnet new` template (default per kind). |
| `-NoTests` | no | Skip the test project. Rejected for Tier 1 kinds. |
| `-WithAgents` | no | Also mint a dedicated builder/reviewer pair for this domain. |

## What it does

1. Validates the id is kebab-case and not already in `.github/domains.yaml`.
2. Creates `<root>/<Name>/` with `src/` and (unless `-NoTests`) `tests/`.
3. Runs `dotnet new` for the kind's template, plus an `xunit` test project referencing it.
   For `kind: script`, writes a constitution-conformant `.ps1` starter and a Pester test
   instead.
4. Writes the domain `README.md` — required by Constitution §IX.
5. Adds the projects to `Forge.sln` (**except spikes**, which are excluded by §XI).
6. Appends the registry row to `.github/domains.yaml` with resolved paths and commands.
7. With `-WithAgents`, generates `<id>-builder.agent.md` and `<id>-reviewer.agent.md` from
   the generic pair and points the registry row at them.

## After scaffolding — do these, they are not optional

1. **Verify the build:** `dotnet build Forge.sln` (or the domain's `build` command).
2. **Fill in the README.** The generated one is a skeleton. State what this is, what it was
   built to learn or do, how to run it, and its current state. A domain with a skeleton
   README is a review FAIL (§IX).
3. **Update `memory-bank/progress.md`** with the new domain and its state. The registry
   says it exists; `progress.md` says whether it works.
4. **For a spike:** confirm the question is at the top of its README and the answer section
   is present as `_(pending)_`.
5. **For `-WithAgents`:** review the generated pair. They start as copies of the generic
   agents — edit in the domain-specific rules that justified minting them, and keep the
   model pins from Constitution §VIII (builder `claude-opus-4.8`, reviewer `gpt-5.6-sol`).

## Registry row shape

```yaml
  - id: ledger
    kind: service
    path: services/Ledger
    source: services/Ledger/src
    tests: services/Ledger/tests
    project: services/Ledger/src/Forge.Ledger.csproj
    build: dotnet build services/Ledger/src/Forge.Ledger.csproj
    test_cmd: dotnet test services/Ledger/tests/Forge.Ledger.Tests.csproj
    tier: 1
    status: active
    notes: ''
```

## Do not

- Create a domain folder without registering it. That is the failure this skill prevents.
- Scaffold Tier 1 work into `spike/` to skip the gates (§II).
- Use `-NoTests` for a `service` or `lib` — Tier 1 requires failing-test-first (§VI).
- Move a spike folder into `services/` to "graduate" it. Graduation is a **rewrite** under
  the gates the spike skipped (§XI).
- Hand-edit `.github/domains.yaml` into an invalid shape. If the append needs to be
  different, fix the script rather than working around it.
