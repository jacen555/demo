# Forge Multi-Agent Engineering Team

This folder defines a **planner / builder / reviewer / researcher / orchestrator**
multi-agent setup for the Forge workshop repo. It is **tooling configuration** (Copilot
custom agents + prompts), not runtime application code.

## What's here

| File | Role |
|---|---|
| `../instructions/constitution.instructions.md` | The shared rulebook (`applyTo: '**'`, auto-loaded into every session). |
| `../domains.yaml` | **The domain registry** — authoritative paths, tiers, build/test commands, model pins. |
| `forge-team.agent.md` | **Orchestrator** — runs the plan → build → review → iterate loop. |
| `forge-team.planner.agent.md` | **Planner** — decomposes a request into ordered, domain-tagged, tier-labelled tasks. |
| `app-builder.agent.md` / `app-reviewer.agent.md` | Desktop applications (`apps/**`). |
| `service-builder.agent.md` / `service-reviewer.agent.md` | Services and shared libraries (`services/**`, `libs/**`). |
| `tooling-builder.agent.md` / `tooling-reviewer.agent.md` | CLIs and PowerShell (`tools/**`, `scripts/**`). |
| `researcher.agent.md` | **Researcher** — investigates a question, builds a spike, writes an ADR. |
| `../checklists/*-design-checklist.md` | Per-kind design checklists used at planning, build, and review. |
| `../prompts/speckit.*.prompt.md` | Self-contained spec → plan → tasks → implement workflow. |
| `../skills/scaffold-domain/SKILL.md` | Creates and registers a new domain (optionally with its own agent pair). |
| `../skills/demo-recording/SKILL.md` | Plans and renders narrated demo/educational videos, routing changes to the cheapest pipeline stage. |

## How this differs from a product repo

Forge is a **workshop**: the set of projects is open-ended and grows continuously. So
unlike a fixed product repo, agents here are **parameterized by domain** rather than
hard-wired to one project.

The orchestrator passes a **domain id**; the builder looks it up in `../domains.yaml` and
resolves its own paths, project files, and build/test commands. Adding a project therefore
needs **no new agent** — just a registry entry, created by the `scaffold-domain` skill.

When a project grows large enough to deserve bespoke rules, run `scaffold-domain` with
`--with-agents` to mint a dedicated builder/reviewer pair for it.

## Domain map

| Tag | Root | Kind | Tier | Builder / Reviewer |
|---|---|---|---|---|
| `[apps]` | `apps/` | app | 2 | `app-builder` / `app-reviewer` |
| `[services]` | `services/` | service | 1 | `service-builder` / `service-reviewer` |
| `[libs]` | `libs/` | lib | 1 | `service-builder` / `service-reviewer` |
| `[tools]` | `tools/` | tool | 2 | `tooling-builder` / `tooling-reviewer` |
| `[scripts]` | `scripts/` | script | 2 | `tooling-builder` / `tooling-reviewer` |
| `[spike]` | `spike/` | spike | 0 | `researcher` / none |

## Rigor tiers

Rigor follows the **path being edited**, not how the request was phrased
(Constitution §II):

| Tier | Paths | Pre-edit approval | Test-first | Independent reviewer |
|---|---|---|---|---|
| **1 — Full** | `services/**`, `libs/**` | Required | **Required** (failing test first) | Required |
| **2 — Standard** | `apps/**`, `tools/**`, `scripts/**` | Required | Required for logic | Required |
| **0 — Spike** | `spike/**` | No | No | No |

Code quality (§IV), security (§V), and "it must build" (§VII) apply at **every** tier,
including spikes.

## How to use it

In VS Code Copilot Chat, pick the agent from the agent/mode dropdown (or `@`-mention it):

- **End-to-end change:** select `forge-team` and describe the work. It detects the tier,
  plans, gets your approval, dispatches the right domain builder, then the paired reviewer,
  and iterates to a `PASS` verdict.
- **Just plan:** select `forge-team.planner` for a lightweight spec, a clarify pass, design
  validation, diagrams, and an ordered task list — without building.
- **One domain directly:** select e.g. `app-builder` for a small, single-domain change,
  then run `app-reviewer` on the result.
- **Learn something:** select `researcher` and ask "how does X work" or "is A faster than
  B". You get a spike under `spike/` and an ADR under `docs/adr/`.
- **Spec-driven flow:** run the prompts in order — `/speckit.specify` → `/speckit.plan`
  → `/speckit.tasks` → `/speckit.implement`. Artifacts land in `specs/<feature>/`.

## Design rules (from the constitution)

1. **Domain isolation** — each builder edits exactly one registered domain's source +
   tests. Cross-domain work is split into separate tasks; shared types go through `libs/`
   first.
2. **The registry is authoritative** — never guess a path or a build command. An
   unregistered domain is a blocking error, not an invitation to improvise.
3. **Separation of duties** — the reviewer is **read-only** (no edit/shell) and pairs with
   a builder it did not write. Run the reviewer on a **different model family** from the
   builder: builders `claude-opus-4.8`, reviewers `gpt-5.6-sol`.
4. **Tier follows the path** — you cannot downgrade rigor by calling Tier 1 work a
   "quick experiment". Reaching for `spike/` to dodge a gate is a review FAIL.
5. **Spikes graduate by rewrite, not by moving the folder** — the real implementation is
   built fresh under the gates the spike skipped (§XI).
6. **No green-light on red** — never accept a task on a failing build/test or a `FAIL`
   verdict; never push or open PRs without explicit user request.

## Extending

- **Add a domain:** run the `scaffold-domain` skill. It creates the folder, README, project
  and test scaffolding, the `Forge.sln` entry, and the registry row.
- **Give a domain its own agents:** run `scaffold-domain` with `--with-agents`, then set
  `builder`/`reviewer` on that domain's registry entry to the new pair.
- **Add a new kind** (e.g. `web/` for browser front-ends): add a `kinds:` block to
  `../domains.yaml`, a design checklist under `../checklists/`, a builder/reviewer pair
  here, and rows in the domain maps in the constitution §I/§II and the orchestrator.
- **Canonical Spec Kit** (optional): the prompts here are intentionally self-contained. To
  adopt the full GitHub Spec Kit toolchain, run `specify init` and migrate this
  constitution into `.specify/memory/constitution.md`.
