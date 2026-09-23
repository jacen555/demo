# Active Context — Forge

> **Last updated:** 2026-09-23

## Current focus

**Building the generic evaluation harness** (`libs/EvalEngine` + `tools/EvalCli`), generalized
from a domain-specific harness in another repo. Running through the multi-agent loop:
planner → builder → cross-family reviewer → iterate.

## Where the harness stands

| Task | State | Tests |
|---|---|---|
| T0–T2 scaffold, model pins, CSharpier | done | — |
| T3 contracts, seams, canonical serialization | done | 309 |
| T4 assertion evaluators | done | 553 |
| T5 deterministic caller | done | 597 |
| T6 REST runner + MCP stub | done | 694 |
| T7 LLM runner, caller, `ILlmClient` seam | done | 824 |
| **T8 coordinator + `Ui` kind stub** | **in flight** | — |
| T9–T15 | not started | — |

Remaining: aggregator + statistics seam (T9), comparator + baseline providers (T10),
impacted-selection matcher (T11), CLI skeleton/wiring/artifacts (T12–T14), the two reports
(T15), ADR (T16), memory-bank update (T17).

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
- **`Ui` as a fourth scenario kind.** Being added as a not-implemented stub in T8, mirroring
  the MCP stub. Driven by Cortex adding UI interaction to its own eval loop. ADR 0003 proved
  deterministic scripted capture is achievable; the real runner is a later task.

## Known open work

- **`SuiteLoader` path confinement** — accepted as a separate task, not fixed. Unix symlink
  following, a validate-then-open race, a volume-root separator bug. Fix before the harness
  loads a suite file an untrusted party can write.
- **`RestRunner` has no `try`/`catch` around `Participant.NextAsync`**, so a participant
  failure there takes down the suite — the asymmetry T7 fixed on the LLM side.
- **The scripted-prefix check is wired into the conversation runner only.**
- **`playwright-ui-capture` spike is `answered` but not graduated** — debt under §XI until
  the sibling capture script is built in `tools/SizzleCraft` under Tier 2 gates.

## Watch out for

- **Builders misreport their own model.** Several reported `claude-opus-4.5`, which is not an
  available model here. The dispatch is correct (`read_agent` confirms `model: claude-opus-5`);
  models are simply unreliable at self-identification. Independence has held throughout —
  Anthropic builder, OpenAI reviewer.
- **Push is blocked from this environment.** The linked account is an Enterprise Managed User
  with read-only access to `jacen555/demo`; forking is blocked by enterprise policy. The user
  pushes manually.
- **`Directory.Packages.props` is orchestrator-owned** — builders must stop and report rather
  than adding a package.
