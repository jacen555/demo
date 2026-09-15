# `spike/` — Experiments

**Kind:** `spike` · **Tier:** 0 · **Agent:** `researcher` · **No reviewer**

Throwaway experiments. This is where you go fast. One immediate child folder per spike,
each registered in [`.github/domains.yaml`](../.github/domains.yaml).

## The deal

**You get:** no pre-edit approval stop, no test mandate, no reviewer, no ceremony.

**You still owe:**
- **One falsifiable question**, stated at the top of the spike's `README.md`. If you can't
  state one, you want a `tool/` or an `app/`, not a spike.
- **It must build** (§VII). A spike that doesn't compile isn't a learning, it's a mess.
- **No secrets** (§V). Tier 0 relaxes process, never correctness.
- **The answer written down** once you have it.

## Hard boundaries

- **Nothing outside `spike/` may reference anything inside it** (§XI).
- **Spikes are excluded from `Forge.sln`**, so they can never break the repo build.
- **Don't use `spike/` to dodge a gate.** If the code will be depended on, it belongs in a
  real root. Scaffolding Tier 1 work here is a review FAIL (§II) — not a clever shortcut.

## Graduation

A spike is **done** when its question is answered. Then it must go one of three ways:

| Disposition | What happens |
|---|---|
| **Graduate** | The real implementation is **rewritten** in `apps/`, `services/`, `libs/`, or `tools/` at its proper tier. **Moving the folder is not graduation** — the point is to get the gates the spike skipped. |
| **Retire** | Delete the folder. The finding survives in an ADR under [`../docs/adr/`](../docs/adr/). |
| **Park** | Still a useful reference. Note what would unblock it. |

**A spike whose question is answered but which neither graduated nor retired is debt.**
Track it in [`../memory-bank/progress.md`](../memory-bank/progress.md) and let the planner
surface it.

## Add one

The question is mandatory:

```powershell
.\.github\skills\scaffold-domain\scripts\New-ForgeDomain.ps1 `
    -Id channel-vs-blockingcollection -Kind spike -Name ChannelVsBlockingCollection `
    -Question 'Is Channel<T> measurably faster than BlockingCollection<T> at our throughput?' `
    -WhatIf
```

Or just ask the `researcher` agent — it sharpens the question, picks the cheapest
experiment, runs it, and writes the ADR.

## Spikes

_None yet._
