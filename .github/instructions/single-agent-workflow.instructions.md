---
applyTo: '**'
---

# Forge — Single-Agent Manual Workflow

Use this workflow when the developer wants a focused, manual path instead of multi-agent
orchestration.

## When To Use

Prefer this mode when:
- The change is scoped and lives primarily within one domain
- The user asks for a direct/manual/single-agent approach
- Orchestration overhead is unnecessary for the task size

Use `.github/agents/forge-team.agent.md` instead when work spans domains, touches a
`libs/**` shared contract, is Tier 1 with non-trivial scope, or is explicitly requested as
multi-agent.

Use `.github/agents/researcher.agent.md` instead when the goal is understanding rather
than shipping.

## Non-Negotiable Policy Source

All policy requirements come from:
- `.github/instructions/constitution.instructions.md`
- `.github/domains.yaml` (paths, tiers, build/test commands)

This file defines **execution style only**. It does not relax constitution policy. A
single-agent path is not a lower-rigor path — it is the same bar with fewer hand-offs.

## Execution Protocol

### Step 0 — Resolve the domain and the tier

- Restate the request and identify the affected domain(s).
- **Read `.github/domains.yaml`.** Pull each affected domain's `kind`, `tier`, `source`,
  `tests`, `project`, `build`, and `test_cmd`. Never guess a path or a command.
  - **Unregistered domain?** Blocking error. Run the `scaffold-domain` skill to create and
    register it before writing any code.
- **Determine the tier** (Constitution §II). Tier follows the **path being edited**, not
  the phrasing of the request. A change spanning tiers takes the **highest** tier it
  touches. State it explicitly: `TIER: <0|1|2> (determined by <path>)`.
- **Tier 0 fast path:** if every path is under `spike/**`, skip Step 0.75 and the
  test-first requirement. §IV (code quality), §V (security), and §VII (it must build) still
  apply. Make sure the spike `README.md` states its question.

### Step 0.5 — Lightweight spec, clarify & design validation

- For anything beyond a one-file/trivial change, write a **compact spec** in your working
  notes: summary, domains affected, tier, user-visible behavior (happy/error/edge),
  testable requirements, and out-of-scope. Mark unknowns as `[NEEDS CLARIFICATION]`.
- **Clarify:** if a high-impact ambiguity would change the design, tasks, or tests, ask the
  user up to 3 targeted questions before implementing. Skip if nothing material is
  unresolved.
- **Design validation:** confirm the intended design satisfies the constitution
  (§IV/§V/§VI) and walk the relevant
  `.github/checklists/<kind>-design-checklist.md`. Resolve design risks before coding.

### Step 0.75 — Pre-Edit Approval Gate (Tier 1 and Tier 2)

Before editing any production code, tests, config, specs, or task files, present:
1. Selected workflow mode (single-agent)
2. Affected domains **and the tier, with the path that determined it**
3. Compact spec/design summary
4. Planned task list

Ask: **"Approve implementation? Reply yes to proceed or provide changes."**

**Stop until the user explicitly approves.** A restatement or a question is not approval.

### Step 1 — Implement

- Make the smallest correct change.
- Stay within the resolved domain's `source` + `tests`. Do not edit another domain — if the
  change needs a shared type, that is a separate `libs/` task; surface it.
- Never reference anything under `spike/**` from real code (§XI).
- Preserve security boundaries, auth policies, and existing contracts.
- §IV (code quality), §V (security), and §VI (testing at the task's tier) apply to **every**
  change.

**Test-first, where the tier requires it (§VI):**
- **Tier 1 (`services/**`, `libs/**`):** mandatory. Pin the contract, write the tests, **run
  them and see them fail**, then implement to green. A test that passed before your change
  proves nothing.
- **Tier 2 (`apps/**`, `tools/**`, `scripts/**`):** required for logic-bearing changes. Thin
  UI/glue may be `exempt` with a one-line justification.
- **Tier 0 (`spike/**`):** no mandate.

### Step 2 — Verify

- Run the domain's `build` command from the registry.
- Run the domain's `test_cmd` — targeted first, then the full project.
- For `scripts/**`, also run
  `Invoke-ScriptAnalyzer -Path <domain path> -Recurse -Severity Error` and confirm zero
  Error-severity findings.
- For `tools/**` and `scripts/**`, **actually run it once** in safe/dry-run mode.
- If the `libs/**` public surface changed, build every dependent domain listed in the
  registry.
- Fix failures, or escalate with clear blocker details. **Never mark complete on red.**

### Step 3 — Review mindset

You have no independent reviewer in this mode, so you must supply the scrutiny yourself.
Re-read your own diff against the relevant reviewer agent's checklist
(`.github/agents/<kind>-reviewer.agent.md`) as if you had not written it. Call out risks,
assumptions, and residual gaps honestly — do not grade your own work generously.

If the user wants a genuine independent verdict, route to multi-agent mode: only there does
a different model family judge the change (Constitution §VIII).

### Step 4 — Handoff

Provide a concise summary:

```
DOMAIN: <id> (<path>) — resolved from .github/domains.yaml
TIER: <0|1|2> (determined by <path>)

CHANGED FILES:
  - <path> — <one-line summary>

BUILD:  pass | fail | n/a (<key result line>)
TESTS:  pass | fail | n/a (<result line>)
SCRIPT-ANALYZER: pass | fail | n/a   (scripts/** only)
SMOKE-RUN: <command> → <result>      (tools/** and scripts/** only)
TEST-DECISION: tests-added | exempt (<justification if exempt>)
TEST-FIRST-EVIDENCE:
  - Requirement/contract pinned: <FR / task / checklist item>
  - Test name(s): <names>
  - Pre-fix result: fail | not-run-with-justification
  - Post-fix result: pass
  - Command: <exact command run>
CONSTITUTION-CHECK: pass | findings (§IV code quality, §V security, §VI testing)
DESIGN-CHECKLIST: clean | <items needing attention> (<checklist path>)
SELF-REVIEW: <the findings you would have raised against this diff, honestly>
DOWNSTREAM-IMPACT: none | <dependent domain ids>   (libs/** only)

RISKS / FOLLOW-UPS:
  - <...>
```

- Update `memory-bank/activeContext.md` and `memory-bank/progress.md` — in this mode **you**
  own the memory bank (Constitution §IX).
- Do NOT push, open PRs, or create GitHub issues unless explicitly requested. If asked, use
  the conventions in Constitution §IX and §X.

## Required Verification Commands

Per-domain commands come from `.github/domains.yaml`. Repo-wide:

```powershell
dotnet build Forge.sln
dotnet test Forge.sln
dotnet csharpier check .
Invoke-ScriptAnalyzer -Path scripts -Recurse -Severity Error
```

Notes:
- Spikes are excluded from `Forge.sln` by design (Constitution §XI) — their absence from a
  solution build is not a gap.
- Never mark complete on a failing required build or test unless the user explicitly
  accepts the risk.
