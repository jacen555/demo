# `tools/` — Developer Tooling

**Kind:** `tool` · **Tier:** 2 · **Builder/Reviewer:** `tooling-builder` / `tooling-reviewer`
· **Checklist:** [`tooling-design-checklist.md`](../.github/checklists/tooling-design-checklist.md)

CLIs, generators, and analyzers a developer runs from a terminal. One immediate child folder
per domain, each registered in [`.github/domains.yaml`](../.github/domains.yaml).

> **Tooling has a specific hazard profile.** It runs on developer machines, often elevated,
> often against real repositories and real infrastructure — and **nobody code-reviews the
> invocation**. A tool with a destructive default does more damage than a service that
> crashes.

## The rules that bite here

1. **The default invocation must be safe.** Running with no flags must not destroy
   anything. Put the destructive path behind an explicit opt-in (`--force`, `--apply`).
2. **Ship a working `--dry-run`** that prints exactly what *would* happen, and document it
   as the first step in the README.
3. **Validate and canonicalize paths** taken from input. Refuse anything outside the
   expected root.
4. **Exit codes are an API.** `0` only on success, non-zero on every failure path,
   documented in the README. Exiting `0` on failure breaks every caller that checks.
5. **Diagnostics to stderr, results to stdout**, so the tool composes.
6. **Honour Ctrl+C** and leave the target recoverable if interrupted.
7. **Never echo a secret** — including in verbose or debug output.

## What Tier 2 requires

Pre-edit approval, tests for logic-bearing changes (argument parsing, path resolution, data
transformation, exit-code selection, idempotency), and an independent reviewer on a
different model family.

**Test the safe default.** Assert that the destructive path does not run without the opt-in
flag — the single most valuable test in this kind.

Builders must also report a `SMOKE-RUN`: the tool actually executed once in dry-run mode. A
tool that compiles but has never been run has not been verified.

## Add one

```powershell
.\.github\skills\scaffold-domain\scripts\New-ForgeDomain.ps1 `
    -Id repo-stats -Kind tool -Name RepoStats -WhatIf
```

## Domains

_None yet._
