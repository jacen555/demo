---
mode: agent
description: 'Spec Kit — implement: execute specs/<feature>/tasks.md through the Forge multi-agent build/review loop, honouring the pre-edit approval gate and tier requirements.'
---

# Spec Kit — /speckit.implement

## User Input

```text
${input:feature:The feature slug to implement (must already have specs/<feature>/tasks.md)}
```

You are executing an approved task list in the Forge workshop repo. Follow the auto-loaded
constitution (`.github/instructions/constitution.instructions.md`).

## Steps

### 0 — Load and verify

1. Read `specs/<feature>/spec.md`, `plan.md`, and `tasks.md` in full. If `tasks.md` is
   missing, stop and tell the user to run `/speckit.tasks` first.
2. Read `.github/domains.yaml` and resolve every task's paths and commands.
3. Re-check the tier of each task against the **paths it will actually edit** (§II). If the
   task list understates a tier, the registry wins — correct it and say so.
4. Confirm no `[NEEDS CLARIFICATION]` remains open in the spec. If one does and it blocks
   the design, stop and ask.

### 1 — Pre-Edit Approval Gate (Tier 1 and Tier 2 — §III)

Before dispatching any builder, present to the user:
1. Workflow mode (multi-agent, spec-driven)
2. Affected domains **and the tier, with the path that determined it**
3. Compact spec/design summary
4. The task list with its gate summary
5. Which builder/reviewer pairs and models will run

Ask: **"Approve implementation? Reply yes to proceed or provide changes."**

**Stop until the user explicitly approves.**

### 2 — Execute (per task, in dependency order)

Parallelize independent tasks across different domains. For each task:

1. **Scaffold first if needed.** Run `scaffold-domain` for any unregistered domain before
   any build task targeting it.

2. **Build** — dispatch the task's `*-builder` with `model: "claude-opus-4.8"`, and include:
   - the **domain id** (the builder resolves paths from the registry itself)
   - `TIER: <n>` and what it requires
   - the design checklist path
   - `PRE-EDIT-APPROVAL: yes` plus the approved plan summary
   - the task's "Done when" condition
   - on re-runs, the reviewer's prior FINDINGS

   Wait for the full structured report.

3. **Gate on red.** If `BUILD: fail` or `TESTS: fail`, send it straight back to the builder.
   Never invoke the reviewer on a red build.

4. **Review** (Tier 1 and 2) — dispatch the paired `*-reviewer` with
   `model: "gpt-5.6-sol"` — a different family from the builder (§VIII) — passing the
   changed files/diff plus the builder's report. Wait for `VERDICT` + `FINDINGS`.

5. **Iterate** — on `FAIL`, hand the FINDINGS back to the builder and repeat. Cap at ~3
   cycles, then stop and escalate with the open findings.

6. **Accept** — on `PASS`, mark the task done **in `tasks.md`** and move on. A `libs/**`
   task reporting `DOWNSTREAM-IMPACT` may require re-verifying dependent domains — schedule
   those.

### 3 — Integrate & verify

```powershell
dotnet build Forge.sln
dotnet test Forge.sln
dotnet csharpier check .
Invoke-ScriptAnalyzer -Path scripts -Recurse -Severity Error   # if scripts/** changed
```

Spikes are excluded from the solution by design (§XI) — their absence is not a gap.

Update `memory-bank/activeContext.md` and `memory-bank/progress.md`. You own the memory
bank; builders do not (§IX).

### 4 — Handoff

Summarize: what changed per domain, every verdict, and residual Low/Medium findings.
Relay builder reports and reviewer FINDINGS **in full — never truncate them**.

Do NOT push, open PRs, or create GitHub issues unless explicitly asked. If asked, use the
conventions in §IX and §X (Conventional Commit title for PRs into `main`, scoped to the
domain id).

## Rules

- **Never green-light on red.** No task is done on a failing build, failing required tests,
  or a `FAIL` verdict.
- **Never skip the reviewer at Tier 1 or 2** because a change "looks small."
- **Never dispatch without an explicit `model`.** Defaults may collapse builder/reviewer
  independence (§VIII).
- **Never let a builder edit outside its one resolved domain**, or touch `.github/`,
  `memory-bank/`, `docs/`, or root build files.
- **Keep `tasks.md` current** as you go. A task list that does not reflect reality is worse
  than none.
- If execution reveals the plan was wrong, **stop and go back to `/speckit.plan`** rather
  than improvising new scope inside the build loop.
