# Copilot Instructions for Forge (`jacen555/demo`)

> This file is a routing and quickstart guide.
> The authoritative policy source is `.github/instructions/constitution.instructions.md`.
> Do not duplicate constitutional rules here.

Forge is a **workshop repository** — a growing collection of desktop applications,
services, libraries, tools, and scripts built to learn and test things.

Always read the memory bank protocol at `.github/instructions/memory-bank-instructions.md`.

## Canonical Policy

For non-negotiable engineering rules, use:
- `.github/instructions/constitution.instructions.md`

For paths, tiers, build commands, and agent assignments, use:
- `.github/domains.yaml` (the domain registry — authoritative)

When policy and nearby guidance disagree, **constitution wins**.

## First Question On Every Request: What Tier?

Rigor is tiered **by the path being edited**, not by how the request was phrased
(Constitution §II):

| Path | Tier | What that means |
|---|---|---|
| `services/**`, `libs/**` | **1 — Full** | Pre-edit approval + failing-test-first + independent cross-model reviewer |
| `apps/**`, `tools/**`, `scripts/**` | **2 — Standard** | Pre-edit approval + tests for logic + independent cross-model reviewer |
| `spike/**` | **0 — Spike** | No approval stop, no test mandate, no reviewer — but code quality, security, and "it must build" still apply |

A change spanning tiers takes the **highest** tier it touches. State `TIER: <n>` and the
path that determined it in every report.

## The Agent Roster

| Agent | Role | Covers |
|---|---|---|
| `forge-team` | **Orchestrator** — runs plan → build → review → iterate | everything |
| `forge-team.planner` | Planner — decomposes into ordered, domain-tagged tasks | everything |
| `app-builder` / `app-reviewer` | Desktop application code | `apps/**` |
| `service-builder` / `service-reviewer` | Services and shared libraries | `services/**`, `libs/**` |
| `tooling-builder` / `tooling-reviewer` | CLIs, generators, PowerShell | `tools/**`, `scripts/**` |
| `researcher` | Investigates a technology, builds a spike, writes an ADR | `spike/**`, `docs/adr/` |

Builders and reviewers are **parameterized by domain** — the orchestrator passes the
domain id and the builder resolves paths and commands from `.github/domains.yaml`. When a
domain grows large enough to deserve its own dedicated pair, run the `scaffold-domain`
skill with `--with-agents`.

## Workflow Modes

### Mode A: Multi-Agent (`forge-team`) — recommended for larger/high-risk work

Use when any of these is true:
- The change spans more than one domain, or touches a `libs/**` shared contract
- Tier 1 work of non-trivial scope
- You want an independent reviewer on a different model family

Behavior: planner decomposes → domain builders implement → paired reviewers issue
PASS/FAIL → iterate until green.

### Mode B: Manual Single-Agent — recommended for focused work

Use `.github/instructions/single-agent-workflow.instructions.md` when:
- The change is small/medium and lives in one domain
- Orchestration overhead is not worth it
- The user explicitly asks for a manual/single-agent path

Behavior: one coordinator executes directly. **The same constitutional gates still
apply** — tier detection, pre-edit approval, test-first, build/test verification, and
explicit gate reporting.

### Mode C: Research (`researcher`) — for "how does X work?"

Use when the goal is understanding rather than shipping. The researcher builds a minimal
spike under `spike/`, answers one question, and writes an ADR in `docs/adr/`.

### Mode Override

User intent overrides defaults. If the user explicitly asks for `forge-team`, use
multi-agent. If they ask for a manual path, use single-agent. If they ask a "how does
this work" question, route to `researcher`.

## Spec-Driven Flow (optional)

For larger features, run the prompt chain in order. Artifacts land in `specs/<feature>/`:

`/speckit.specify` → `/speckit.plan` → `/speckit.tasks` → `/speckit.implement`
(with `/speckit.analyze` available at any point for a consistency audit).

## Mandatory Pre-Edit Approval Gate (Tier 1 and Tier 2)

Before any agent edits production code, tests, config, specs, or task files, it MUST:
1. Present the selected workflow mode, affected domains **and tier**, the compact
   spec/design summary, and the planned task list.
2. Ask the user: "Approve implementation? Reply yes to proceed or provide changes."
3. Stop until the user explicitly approves.

Builders MUST refuse implementation tasks unless the dispatching prompt includes
`PRE-EDIT-APPROVAL: yes` plus the approved plan/spec summary.

This gate applies in both multi-agent and single-agent workflows. It does **not** apply
at Tier 0 (`spike/**`).

## Adding A New Domain

Never create a project folder by hand. Run the `scaffold-domain` skill
(`.github/skills/scaffold-domain/SKILL.md`) — it creates the folder, the README, the
project and test scaffolding, the `Forge.sln` entry, and the `.github/domains.yaml`
registration in one step, and optionally mints a dedicated builder/reviewer pair.

## Build, Test & Work Items

Governed by the constitution — not duplicated here:
- Build/test commands and the never-green-on-red rule: Constitution §VI and §VII
- Per-domain commands: `.github/domains.yaml`
- GitHub issue and Conventional Commit PR title conventions: Constitution §IX and §X

## Azure Tooling Rules

- @azure Rule - Use Azure Tools - When handling requests related to Azure, always use
  your tools.
- @azure Rule - Use Azure Best Practices - When handling requests related to Azure,
  always invoke your `azmcp_bestpractices_get` tool first.
- @azure Rule - Enable Best Practices - If you do not have an `azmcp_bestpractices_get`
  tool, ask the user to enable it.
