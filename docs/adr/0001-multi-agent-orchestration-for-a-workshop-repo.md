# 0001. Tier multi-agent rigor by repository location

- **Status:** Accepted
- **Date:** 2026-09-15
- **Spike:** none — this is a process decision, validated against an existing production
  setup rather than a code experiment.

## Question

How should a multi-agent engineering workflow apply rigor in a repository whose purpose is
**both** fast experimentation and building things worth depending on?

## Context

Forge (`jacen555/demo`) is a workshop repo: an open-ended, growing collection of desktop
apps, services, libraries, tools, and scripts used to learn and test things.

The reference implementation for the agent setup is `CRM.Services.KnowMe`, a production
service repo with a mature planner/builder/reviewer/orchestrator arrangement. Two of its
assumptions do not transfer:

1. **Fixed domains.** KnowMe has four projects, each with a hard-wired builder/reviewer
   pair and a hard-coded path. Forge's project set is open-ended and grows continuously —
   a new agent pair per project means file sprawl and constant drift between near-identical
   agents.
2. **Uniform rigor.** KnowMe applies one bar to everything: mandatory pre-edit approval,
   failing-test-first, independent cross-model review. That is correct for a service on a
   critical path. Applied to a throwaway benchmark, it costs more than the experiment is
   worth — and the predictable outcome is that people stop using the workflow, or stop
   experimenting.

Meanwhile the opposite failure is just as real: experiments quietly become load-bearing,
and code that skipped every gate ends up in a position of dependency.

## Options considered

1. **Uniform full rigor (copy KnowMe as-is).** Every change gets approval, test-first, and
   independent review.
   · Pros: simple to state; nothing rots; no arguments about which bar applies.
   · Cons: kills experimentation, which is the repo's stated purpose. A five-minute
   benchmark needs a planner, an approval gate, and a reviewer. Predictable outcome: the
   workflow gets bypassed, which is worse than a lower bar honestly applied.

2. **Uniform light rigor.** Planner/builder/reviewer available, no hard gates anywhere.
   · Pros: zero friction.
   · Cons: `libs/` and `services/` are exactly where silent rot is expensive — one bad
   shared contract breaks every consumer. No mechanism distinguishes them.

3. **Rigor declared per task.** The requester or planner picks the bar for each change.
   · Pros: flexible.
   · Cons: the decision gets relitigated every time, and it is always won by whoever is in
   a hurry. "This is just a quick fix" is precisely how a Tier 1 change escapes review.
   Requires trusting intent, which is the thing under pressure.

4. **Rigor tiered by repository location.** Top-level root determines the tier;
   `services/**` and `libs/**` are Tier 1, `apps/**`/`tools/**`/`scripts/**` are Tier 2,
   `spike/**` is Tier 0.
   · Pros: the tier is a *fact about the file*, not a claim about the task. Decided once,
   at scaffold time, when the stakes are visible. Mechanically checkable.
   · Cons: needs an enforced escape hatch (`spike/`) or people route around it; needs a
   graduation path or spikes silently become production.

## Evidence

- The KnowMe constitution's strongest property is that **every gate maps to a mechanically
  checkable report field** (`TIER`, `BUILD`, `TESTS`, `TEST-FIRST-EVIDENCE`,
  `BUILDER-MODEL`, `VERDICT`). The orchestrator refuses to advance on a red field without
  interpreting prose. Location-derived tiers preserve that property — the tier is derived
  from the path, so a builder cannot misreport it without the reviewer catching a mismatch
  against the registry.
- KnowMe's reviewer independence rule (read-only tools, different model family, explicit
  model pinning) is orthogonal to tiering and transfers unchanged. Its stated rationale —
  a reviewer on the same model family rubber-stamps its own reasoning — does not depend on
  domain count.
- KnowMe's fixed domain map is the **only** part of its design that assumes a closed
  project set. Replacing it with a registry (`.github/domains.yaml`) that agents resolve at
  dispatch time removes that assumption without touching the loop, the reports, or the
  gates.
- Option 3 was rejected on a specific observed failure mode rather than principle: KnowMe's
  own constitution had to add an explicit anti-pattern — *"Skipping the reviewer because the
  change looks small"* — which is direct evidence that per-task rigor decisions erode under
  time pressure even in a repo with a strict written bar.

## Decision

Adopt **location-based rigor tiers** (option 4), with the agent roster **parameterized by a
domain registry** rather than hard-wired per project.

- **Tier 1** (`services/**`, `libs/**`): pre-edit approval, failing-test-first, read-only
  independent reviewer on a different model family.
- **Tier 2** (`apps/**`, `tools/**`, `scripts/**`): pre-edit approval, tests for
  logic-bearing changes, independent reviewer.
- **Tier 0** (`spike/**`): no approval stop, no test mandate, no reviewer.

Three invariants make this hold:

1. **Tier follows the path, not the request.** A change spanning tiers takes the highest.
2. **Code quality (§IV), security (§V), and "it must build" (§VII) apply at every tier**,
   including spikes. Tier 0 relaxes process, never correctness.
3. **Spikes graduate by rewrite, not by moving the folder.** Nothing outside `spike/` may
   reference it, and spikes are excluded from `Forge.sln`.

Builders resolve their paths and commands from `.github/domains.yaml` via a domain id, so
adding a project requires a registry row — not a new agent.

## Consequences

**Makes easy**
- Starting an experiment: `scaffold-domain -Kind spike`, then write code. No gate, no
  ceremony.
- Adding a project: one registry row, no new agent files, no drift between near-identical
  agents.
- Mechanical enforcement: the reviewer cross-checks the declared `TIER` against the registry,
  so a misdeclared tier is caught the same way a red build is.

**Makes hard**
- **`spike/` is now the pressure point.** The temptation to scaffold real work there to skip
  gates is the single most likely failure of this design. Mitigated by making it an explicit
  review FAIL (§II) and by the no-reference rule, but it depends on the planner asking the
  "keep or learn?" question honestly at scaffold time.
- **The registry becomes a single point of failure.** A stale or wrong row silently
  misdirects every builder targeting that domain. Mitigated by `scaffold-domain` being the
  only supported write path and by `/speckit.analyze` auditing registry-vs-disk drift.
- **Spike debt accrues quietly.** A spike whose question is answered but which never
  graduated or retired is debt with no natural forcing function. Mitigated by tracking
  disposition in the registry and surfacing stale spikes in `memory-bank/progress.md` — but
  this is a discipline, not a mechanism, and is the most likely thing to slip.

**Revisit when**
- More than a handful of domains need dedicated agent pairs (`-WithAgents`) — that would
  suggest the generic pairs are too generic and the `kind` taxonomy needs splitting.
- A `kind` appears that does not fit the tier mapping (e.g. a browser front-end, or an
  infrastructure/IaC root), requiring a new root and tier assignment.
- The spike ledger shows a persistent pattern of `answered` spikes never graduating, which
  would mean the graduation path is too expensive and needs a cheaper intermediate.
