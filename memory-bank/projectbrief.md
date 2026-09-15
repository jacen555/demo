# Project Brief — Forge

## What this is

**Forge** (`jacen555/demo`) is a **workshop repository**: a growing collection of desktop
applications, services, libraries, tools, and scripts built to learn and test things, and
to hold the useful automation that accumulates along the way.

It is deliberately **not** a product repo. There is no single shipping artifact and no
release train. What there is instead is a set of independent domains at different levels of
maturity, plus the machinery to keep the useful ones honest and the throwaway ones cheap.

## Why it is structured the way it is

A workshop repo has two failure modes, and they pull in opposite directions:

1. **Too much ceremony** — every experiment drowns in process, so nobody experiments.
2. **Too little rigor** — the things you actually depend on rot, and you rediscover the
   same lesson three times because nobody wrote it down.

Forge resolves that with **rigor tiers keyed to location** (Constitution §II). Where the
code lives decides how much process it gets:

| Tier | Paths | The deal |
|---|---|---|
| **1 — Full** | `services/**`, `libs/**` | Real production bar. Failing-test-first, pre-edit approval, independent cross-model review. |
| **2 — Standard** | `apps/**`, `tools/**`, `scripts/**` | Approval and review, tests for logic, pragmatic about UI and glue. |
| **0 — Spike** | `spike/**` | Move fast. No approval stop, no test mandate, no reviewer. Must still build and must not leak secrets. |

You cannot dodge a tier by how you phrase the request — tier follows the **path being
edited**.

## Rules of engagement

1. **The registry is authoritative.** `.github/domains.yaml` maps every domain to its
   paths, tier, and build/test commands. Agents resolve from it; they never guess. An
   unregistered domain is a blocking error.
2. **Agents are parameterized by domain, not hard-wired.** Adding a project needs a
   registry row, not a new agent. That is what makes an open-ended repo tractable.
3. **Spikes graduate by rewrite, not by moving the folder.** A spike proves an approach;
   the real thing is then built under the gates the spike skipped.
4. **Learning that is not written down did not happen.** Every investigation ends in an ADR
   under `docs/adr/`. Every domain has a README that says what it is *for*.
5. **Never green-light on red**, and never push or open a PR without being asked.

## Layout

| Root | Kind | Tier | Contains |
|---|---|---|---|
| `apps/` | app | 2 | Desktop applications (WinUI 3, WPF, console UX) |
| `services/` | service | 1 | Long-running services and APIs |
| `libs/` | lib | 1 | Shared libraries — highest blast radius |
| `tools/` | tool | 2 | Developer tooling — CLIs, generators, analyzers |
| `scripts/` | script | 2 | PowerShell automation |
| `spike/` | spike | 0 | Throwaway experiments, one question each |

## Authoritative documents

| Document | Role |
|---|---|
| `.github/instructions/constitution.instructions.md` | The rulebook. Wins every disagreement. |
| `.github/domains.yaml` | The registry. Paths, tiers, commands, model pins. |
| `.github/copilot-instructions.md` | Routing — which mode and which agent. |
| `.github/agents/README.md` | The agent roster and how to drive it. |
| `docs/adr/` | Why things are the way they are. |
| `memory-bank/progress.md` | What exists and what state it is actually in. |

## Success criteria

Forge is working if:
- Starting a new experiment takes minutes, not an afternoon of setup.
- The things you depend on (`libs/`, `services/`) stay trustworthy without being babysat.
- You can answer "did we already try this?" from `docs/adr/` and `progress.md` — without
  re-running the experiment.
