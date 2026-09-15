---
mode: agent
description: 'Spec Kit — analyze: audit a feature spec, plan, tasks, and implementation for internal consistency, constitution compliance, and drift. Read-only; produces a findings report.'
---

# Spec Kit — /speckit.analyze

## User Input

```text
${input:feature:The feature slug to audit (needs at least specs/<feature>/spec.md)}
```

You are auditing a feature's artifacts for **consistency and drift** in the Forge workshop
repo. Follow the auto-loaded constitution
(`.github/instructions/constitution.instructions.md`).

This prompt is **read-only**. Report problems; do not fix them.

## Steps

1. Read whichever of these exist: `specs/<feature>/spec.md`, `plan.md`, `tasks.md`.
2. Read `.github/domains.yaml`.
3. Read the actual code in the affected domains. **The codebase is the baseline** — where
   documents and code disagree, the code is what is true and the document is what is wrong.

## What To Check

### Traceability
- Does every **FR** in the spec map to at least one task?
- Does every **task** trace back to an FR or an explicit plan decision? A task with no
  source is scope creep.
- Does every FR that is implemented have a **test** that pins it? Name the test, or report
  it as unpinned.

### Registry accuracy
- Does every domain named in the plan/tasks exist in `.github/domains.yaml`?
- Do the registry's `source`, `tests`, `project`, `build`, and `test_cmd` match what is
  actually on disk? A stale registry silently breaks every builder.
- Is any domain present on disk but **missing from the registry**? That is a blocking
  defect (§I).

### Tier correctness
- Is each task's declared tier consistent with the **paths it actually edits** (§II)?
- Is anything real living in `spike/**` to avoid a gate? That is a §II violation, not a
  shortcut.
- Does any code in `apps/`, `services/`, `libs/`, `tools/`, or `scripts/` reference
  `spike/**`? Automatic High (§XI).

### Constitution compliance in the delivered code
- **§IV:** blocking on async; dropped `CancellationToken`; inline `DateTime.UtcNow` /
  `Guid.NewGuid()` in production paths; unrelated churn.
- **§V:** secrets or connection strings in source or committed config; unvalidated
  caller input; concatenated SQL; disabled TLS validation.
- **§VI:** behavior changes with no test; Tier 1 changes with no credible failing-test-first
  evidence; `exempt` claims that do not hold up.
- **§IX:** domains missing a `README.md`, or one still holding the scaffold skeleton.

### Document drift
- Does `plan.md` still describe what was actually built?
- Does `tasks.md` reflect real completion state?
- Are there `[NEEDS CLARIFICATION]` markers that were silently built around instead of
  resolved?

### Repo hygiene
- Spikes in the registry with `status: answered` that never graduated or retired — that is
  debt (§XI). Name them.
- Domains in `memory-bank/progress.md` that are absent from the registry, or vice versa.
- Decisions with lasting consequence that have **no ADR** in `docs/adr/`.

## Output Format (REQUIRED — emit exactly this, nothing after it)

```
ANALYSIS: <feature slug>

ARTIFACTS: spec=<present|missing> plan=<present|missing> tasks=<present|missing>

TRACEABILITY:
  - FRs: <n total> | mapped to tasks: <n> | pinned by tests: <n>
  - Unmapped FRs: <list or none>
  - Untraceable tasks (no FR/plan source): <list or none>
  - Unpinned FRs (implemented, no test): <list or none>

REGISTRY: accurate | drifted
  - <each discrepancy between .github/domains.yaml and disk, or "none">

TIER-CHECK: pass | violations
  - <each tier misdeclaration or spike-as-loophole, or "none">

FINDINGS:
  - [High|Medium|Low] <file:line or doc:section> — <problem> (§<section>). Fix: <concrete change>.
  - ...
  (write "  - none" if there are no findings)

DRIFT:
  - <where a document no longer matches the code, or "none">

DEBT:
  - <stale spikes, missing ADRs, missing/skeleton READMEs, memory-bank mismatches, or "none">

VERDICT: consistent | drifted | non-compliant
```

Verdict rules:
- `non-compliant` if there is **any High** finding or any tier violation.
- `drifted` if documents and code disagree, or the registry does not match disk.
- `consistent` otherwise (Low/Medium nits may still be listed).
- No preamble, no closing remarks — the structured block is the entire response.
