# Specs

Spec-driven artifacts produced by the Spec Kit prompt chain. One folder per feature.

## Flow

```
/speckit.specify  →  specs/<feature>/spec.md    what and why
/speckit.plan     →  specs/<feature>/plan.md    how, validated against the constitution
/speckit.tasks    →  specs/<feature>/tasks.md   ordered, single-domain, tier-labelled tasks
/speckit.implement →  executes the tasks through the build/review loop
/speckit.analyze  →  audits spec/plan/tasks/code for drift (read-only)
```

## When to use it

Use the chain for **larger features** where the written artifacts earn their keep —
multi-domain work, anything touching a `libs/**` contract, or work you will pick up again
after a gap.

For a focused single-domain change, skip it. `forge-team` or the
[single-agent workflow](../.github/instructions/single-agent-workflow.instructions.md)
carry the same gates with far less paperwork.

For a spike, skip it entirely — route to the `researcher` agent. A Tier 0 experiment does
not need a spec; it needs one falsifiable question and a README.

## Rules

- **Keep `tasks.md` current as work proceeds.** A task list that does not reflect reality is
  worse than none.
- **Do not build around an unresolved `[NEEDS CLARIFICATION]`.** Resolve it or stop.
- **If execution reveals the plan was wrong, go back to `/speckit.plan`** — do not improvise
  new scope inside the build loop.
- Run `/speckit.analyze` before considering a feature finished; it catches drift between
  what was specified, what was planned, and what actually got built.

## Layout

```
specs/
  <feature-slug>/
    spec.md
    plan.md
    tasks.md
```

_No specs yet._
