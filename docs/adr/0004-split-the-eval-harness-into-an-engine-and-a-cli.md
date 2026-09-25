# 0004. Split the eval harness into an engine and a CLI

- **Status:** Accepted
- **Date:** 2026-09-24
- **Supersedes:** nothing.

## Question

Forge needed a general evaluation harness: one that can exercise a REST endpoint,
an MCP server, or a multi-turn LLM conversation, compare a change against a
baseline, and produce evidence a reviewer can read on a pull request. What shape
should it take, and what language should it be written in?

## Context

The work that prompted this was a domain-specific interview evaluator in another
repository: a 91 KB PowerShell runner, five Python report builders, 162 scenarios
and 32 assertion types, all welded to one product's vocabulary. The pipeline was
genuinely good and none of it was reusable.

Three requirements shaped the answer. **Non-LLM scenarios run once**; LLM
scenarios run many times and are averaged, because a single sample of a
stochastic system is not evidence. **A suite mixes both**, so one runner cannot
assume either. And the output is **comparative** — the question is never "does
this pass" but "is this better or worse than before", which means baselines,
pairing, and a statistical treatment that does not manufacture confidence.

A fourth requirement emerged during the build rather than before it: the harness
must be able to **refuse**. A comparison that could not be made must not render
as a comparison that found nothing.

## Options considered

1. **One CLI, no library.** Everything in `tools/EvalCli`.
   · Pros: simplest; no public surface to design; one domain, one tier.
   · Cons: `tools/**` is Tier 2, and the parts that most need failing-test-first
   rigour are the comparator and the statistics — where a wrong answer is
   *confident and wrong* rather than obviously broken. It also forecloses any
   other consumer: a test harness, a service, a scheduled job.

2. **One library, no CLI.** Consumers write their own entry points.
   · Pros: maximum reuse; all Tier 1.
   · Cons: nothing to run. The thing a reviewer actually wants is a command
   they can put in CI, and designing that as an afterthought is how you get a
   library whose ergonomics nobody tested.

3. **Engine in `libs/`, CLI in `tools/`.** The evaluation, comparison and
   statistics live in a Tier 1 library; argument parsing, path confinement,
   artifact writing and report rendering live in a Tier 2 tool.

## Evidence

The split earned itself repeatedly during the build, in ways that were not
predicted:

- **The tier boundary did real work.** `SuiteComparator`'s paired bootstrap
  returned `p=0.0001` for two same-direction differences where the true rejection
  rate is 50%. That was caught by simulating type-I error rather than by reading
  the derivation — a Tier 1 discipline. The first remedy fixed `n=2` and still
  failed at `n=6` (16.8% against a nominal 5%). The final answer is an exact
  sign-flip test for `n ≤ 20`. None of that rigour would have been mandatory at
  Tier 2.

- **The CLI found defects the engine's own tests could not.** `ComparisonResult`
  passed eleven review rounds as a contract. Building a report that actually
  renders it surfaced that `NewlyCovered` claimed coverage for scenarios that
  were never fully conducted, that `Slicing.Tags` reached a committed artifact
  unredacted, and that baseline read-back bypassed validation entirely. A
  consumer exercising a contract finds what the contract's own tests cannot.

- **The seam let the statistics be replaced without touching the runners.**
  `ISignificanceTest` is injected; three implementations were tried and the
  callers never changed.

On language: .NET, consistent with the constitution's default, and the choice was
never close. The alternative worth considering was single-file C# (`dotnet run
app.cs`), which requires .NET 10; only 8.0 and 9.0 are installed here, so it was
not available regardless.

## Decision

**`libs/EvalEngine` (Tier 1)** owns scenario contracts, assertion evaluation,
participants, runners, the coordinator, statistics, comparison, baselines and
impacted-scenario selection. It has no console, no argument parsing, and no
knowledge of where artifacts live.

**`tools/EvalCli` (Tier 2)** owns the command line, path confinement, artifact
writing, baseline resolution, and report rendering. It emits report files; CI
posts them. The tool holds no GitHub token and makes no network call to GitHub,
which keeps §V simple and lets the harness work outside GitHub entirely.

Every runner produces the same kind-agnostic `Transcript` and `Outcome`, so
REST-once is the degenerate one-turn case of the same pipeline rather than a
separate code path. `KindAgnosticismGuardTests` enforces that.

The harness is **report-only**. `--fail-on-regression` is deliberately inert and
exit codes `10`–`19` are unallocated, reserved for gating once the reports have
been trusted in practice. A harness that blocks merges before anyone believes its
output teaches people to bypass it.

## Consequences

- Cross-domain changes cost two tasks and two reviews. The coverage-overclaim fix
  took an engine task and a CLI task landing together, because §VII has no
  by-design exemption for a dependent domain left red.
- The engine's public surface is a real contract with real cost. Promoting
  `RealPath` to `PathBoundary` for the CLI's use was a deliberate, reviewed
  decision rather than an internal refactor.
- Statistics are replaceable but not free: any new test must be calibrated by
  simulation, not derivation, because the failure mode is a confident wrong
  verdict rather than a crash.
- Gating is a future decision with a reserved exit-code range, not a rewrite.
- `Mcp` and `Ui` scenario kinds are declared stubs. The `Ui` kind exists because
  an API-level evaluation is structurally blind to post-classification failure
  (ADR 0003); it is not yet implemented, and a `Ui` scenario may prove
  structurally uncomparable where the system under test has no per-change slot.
