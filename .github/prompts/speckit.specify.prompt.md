---
mode: agent
description: 'Spec Kit — specify: turn a rough idea into a structured specification under specs/<feature>/spec.md. Self-contained; no .specify toolchain required.'
---

# Spec Kit — /speckit.specify

## User Input

```text
${input:feature:Describe the feature, app, service, tool, or experiment you want to specify}
```

You are creating a **feature specification** for the Forge workshop repo. Follow the
auto-loaded constitution (`.github/instructions/constitution.instructions.md`).

## Steps

1. **Pick a slug** — derive a short kebab-case `<feature>` slug from the request (e.g.
   `clipboard-history`). Confirm with the user only if ambiguous.

2. **Establish intent — this is the load-bearing question.** Ask yourself, and the user if
   unclear:

   > Is this being built to **keep**, or to **learn**?

   "Learn" means a spike under `spike/` at **Tier 0** — and honestly, a spike rarely needs a
   full spec. Say so and route to the `researcher` agent instead of grinding through this
   template. "Keep" means a real root with real gates; continue.

3. **Resolve the registry** — read `.github/domains.yaml`. For each domain the feature
   touches, record its `kind`, `tier`, and paths. **A domain that does not exist yet is a
   scaffolding task**, not an assumption — note it explicitly.

4. **Determine the tier** (Constitution §II). Tier follows the **paths that will be
   edited**, not how the request was phrased. A feature spanning tiers takes the highest.

5. **Explore** — use search/read to ground the spec in real current behavior. Do not
   specify against code you have not looked at.

6. **Write** `specs/<feature>/spec.md` using the template below. Mark unknowns explicitly
   with `[NEEDS CLARIFICATION: ...]` rather than guessing.

## spec.md Template

```markdown
# Spec: <Feature Title>

## Summary
<1–3 sentences: what and why>

## Intent
ship | learn
<If "learn", justify why this is not simply a spike.>

## Domains Affected
| Domain id | Kind | Tier | Registered? | Why it's involved |
|---|---|---|---|---|
| <id> | app/service/lib/tool/script | 0/1/2 | yes / **needs scaffold-domain** | <...> |

## Tier
**TIER: <highest>** (determined by `<path>`)

What that requires: <pre-edit approval? failing-test-first? independent reviewer?>

## User-Visible Behavior
- Happy path: <...>
- Error paths: <...>
- Edge cases: <...>

## Functional Requirements
- FR1: <testable requirement — if you cannot write a test name for it, it is not testable>
- FR2: ...

## Non-Functional / Constraints
- Security, input validation, performance, compatibility, platform constraints

## Out of Scope
- <explicitly excluded, so the builder does not drift into it>

## Prior Art In This Repo
- <existing domains, spikes with `status: answered`, or ADRs that already bear on this>
- <if a spike already answered part of this, say so — that is what it was for>

## Open Questions
- [NEEDS CLARIFICATION: ...]
```

## Rules

- **Do not design the solution here.** This is *what* and *why*. The *how* is
  `/speckit.plan`.
- **Every FR must be testable.** If you cannot name the test that would prove it, rewrite
  it.
- **Do not invent domains.** If it does not exist in `.github/domains.yaml`, the spec says
  it needs `scaffold-domain`.
- **Check `docs/adr/` and the spike ledger before writing.** This repo exists to learn
  things — do not re-specify a question already answered.

Next step: `/speckit.plan`.
