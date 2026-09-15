# `libs/` — Shared Libraries

**Kind:** `lib` · **Tier:** 1 · **Builder/Reviewer:** `service-builder` / `service-reviewer`
· **Checklist:** [`service-design-checklist.md`](../.github/checklists/service-design-checklist.md)

Libraries consumed by **more than one** domain. One immediate child folder per domain, each
registered in [`.github/domains.yaml`](../.github/domains.yaml).

> **This is the highest blast radius in the repo.** Everything else can break in isolation;
> a bad change here breaks every consumer at once. Treat every public member as a contract.

## Put something here when

Two or more domains need it. That is the whole test.

A type used by exactly one domain belongs **in** that domain. Speculative "we might share
this later" libraries are how a workshop repo accumulates abstraction nobody wanted.

## What Tier 1 requires

- **Pre-edit approval**, **failing-test-first**, **independent read-only reviewer** on a
  different model family — see [`../services/README.md`](../services/README.md) for the full
  shape.

## The rules that bite here

1. **Prefer additive changes.** Adding to a public surface is cheap; changing or removing
   from it breaks every consumer.
2. **Report `PUBLIC-SURFACE` honestly.** A removed or re-signatured member reported as
   `additive` is an automatic review FAIL.
3. **Name every consumer in `DOWNSTREAM-IMPACT`**, taken from the registry — and build them.
   A green library with red consumers is not done.
4. **XML doc comments are required** on all public types and members. Not optional here.
5. **Make illegal states unrepresentable** where practical. Consumers will do whatever the
   type system permits.

## Add one

```powershell
.\.github\skills\scaffold-domain\scripts\New-ForgeDomain.ps1 `
    -Id forge-core -Kind lib -Name Core -WhatIf
```

## Domains

_None yet._
