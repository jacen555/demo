# `services/` — Services & APIs

**Kind:** `service` · **Tier:** 1 · **Builder/Reviewer:** `service-builder` / `service-reviewer`
· **Checklist:** [`service-design-checklist.md`](../.github/checklists/service-design-checklist.md)

Long-running services and HTTP APIs — ASP.NET Core, workers, daemons. Anything that runs
unattended. One immediate child folder per domain, each registered in
[`.github/domains.yaml`](../.github/domains.yaml).

## What Tier 1 requires

This is the highest bar in the repo.

- **Pre-edit approval** before any edit
- **Failing-test-first is mandatory.** Pin the contract, write the test, **run it and see it
  fail**, then implement to green. A test that passed before your change proves nothing.
  Bug fixes start with a test that reproduces the bug
- **Independent read-only reviewer** on a different model family, which scrutinises the
  test-first evidence rather than taking it on trust

## The rules that bite here

1. **Validate every caller-supplied input** — ids, paths, ranges, payload shapes. Never
   trust a caller.
2. **Parameterize all data access.** No string-concatenated SQL, ever.
3. **Propagate `CancellationToken`** through every async chain, including data access and
   outbound HTTP. A hosted service that ignores cancellation is a finding.
4. **No silent hard failures.** A path that terminally swallows an exception or aborts an
   operation must log *and* emit a metric.
5. **Log each error once**, at the layer that terminally handles it.
6. **Never reference `spike/**`.** A spike proves the approach; the real thing is written
   here from scratch.

## Add one

```powershell
.\.github\skills\scaffold-domain\scripts\New-ForgeDomain.ps1 `
    -Id ledger -Kind service -Name Ledger -WhatIf
```

`-NoTests` is rejected here — failing-test-first is not optional at Tier 1.

## Domains

_None yet._
