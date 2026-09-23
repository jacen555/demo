# Architecture Decision Records

**Why** things are the way they are. `memory-bank/progress.md` records *what* exists; this
folder records the reasoning and the evidence behind it.

## When to write one

Write an ADR when you choose between **real alternatives with lasting consequence** — a
framework, a protocol, a persistence model, a repo-wide convention.

The `researcher` agent writes one at the end of every investigation whose finding would
change how a real domain gets built (Constitution §XI).

**The distinction that matters:**

> "I learned how the API is shaped" → that's a **README**.
> "We will use X over Y because Z" → that's an **ADR**.

An ADR with no evidence section is a preference, not a decision record. Don't write those.

## Conventions

- Filename: `NNNN-kebab-title.md`, numbered sequentially from `0001`.
- Title is a **decision in imperative form** — "Use X for Y", not "Thoughts on X".
- Status is one of `Proposed`, `Accepted`, `Superseded by NNNN`.
- **Never edit an accepted ADR to change its decision.** Write a new one and mark the old
  one superseded. The record of what you used to think is the point.

## Template

```markdown
# NNNN. <Decision title in imperative form>

- **Status:** Accepted | Superseded by NNNN | Proposed
- **Date:** YYYY-MM-DD
- **Spike:** `spike/<kebab-name>/` (if one informed this)

## Question

<the one falsifiable question this answers>

## Context

<what prompted this, what constraints are real>

## Options considered

1. **<Option A>** — <how it works> · Pros: <...> · Cons: <...>
2. **<Option B>** — ...

## Evidence

<what was actually observed. Numbers with units and spread, or concrete behavioral
observations. No hand-waving.>

## Decision

<what we will do, and why the evidence supports it>

## Consequences

- <what this makes easy>
- <what this makes hard>
- <what we will have to revisit, and when>
```

## Index

| # | Title | Status | Date |
|---|---|---|---|
| [0001](0001-multi-agent-orchestration-for-a-workshop-repo.md) | Tier multi-agent rigor by repository location | Accepted | 2026-09-15 |
| [0002](0002-admit-nodejs-for-ecosystem-bound-tooling.md) | Admit Node.js for ecosystem-bound tooling | Accepted | 2026-09-15 |
| [0003](0003-drive-real-uis-with-scripted-playwright-frame-capture.md) | Drive real UIs with scripted Playwright frame capture | Accepted | 2026-09-23 |
