# CLI & Tooling Design Checklist — `tools/**`

Applies to changes in any domain under `tools/` (Tier 2) — .NET CLIs, generators,
analyzers. Walk the items relevant to the change; answer each or mark N/A **with a
reason**.

Tooling runs on developer machines, often elevated, often against real repositories and
real infrastructure — and **nobody code-reviews the invocation**. Safety of defaults is the
first question, not the last.

## Destructive operations — answer these first (§IV, §V)
- [ ] Does this delete, overwrite, force-push, reset, or mutate remote/shared state?
- [ ] **Is the default invocation safe?** Running with no flags must not destroy anything.
- [ ] Is there a working `--dry-run` (or equivalent) that prints exactly what *would* happen?
- [ ] Is the destructive path behind an explicit opt-in flag (e.g. `--force`, `--apply`)?
- [ ] Are paths from input validated and canonicalized before being acted on, and refused if outside an expected root?
- [ ] Is the **safe default covered by a test** that asserts the destructive path does not execute without the opt-in?
- [ ] Is the dry-run documented as the first step in the domain README?

## Scope & registry (§I, §IX)
- [ ] Change stays inside the one resolved domain's `source` + `tests` from `.github/domains.yaml`?
- [ ] Domain is registered in the registry with matching paths?
- [ ] Domain root `README.md` has a **copy-pasteable usage example** and documents the **exit codes**?
- [ ] Shared types surfaced as a `SHARED-TYPE-REQUEST` for a `libs/` task rather than edited directly?
- [ ] Smallest viable design — no unrelated renames, reformatting, or refactors?

## Command-line interface (§IV)
- [ ] Arguments parsed with an established parser — not hand-rolled string slicing?
- [ ] Every argument value validated (existence, range, format, allowed set)?
- [ ] Are flag names conventional and unambiguous, with short forms only where they're obvious?
- [ ] Is `--help` genuinely useful — does it explain the safe path first?
- [ ] Does the tool fail fast with a clear message on bad input, rather than half-completing?

## Exit codes & output contract (§IV)
- [ ] `0` **only** on success; non-zero on every failure path?
- [ ] Exit codes documented in the README — they are an API for every caller that checks?
- [ ] Diagnostics written to **stderr**, machine-readable results to **stdout**, so the tool composes?
- [ ] Is there a structured output mode (e.g. `--json`) where the tool is likely to be scripted?
- [ ] Does output stay quiet by default and get verbose on request, rather than the reverse?

## Async & interruption (§IV)
- [ ] `async`/`await` for I/O; no `.Result` / `.Wait()` / `.GetAwaiter().GetResult()`?
- [ ] `CancellationToken` propagated, and **Ctrl+C honoured** with a clean partial-state exit?
- [ ] If interrupted mid-operation, does it leave the target in a recoverable state?

## Composition & configuration (§IV, §V)
- [ ] Services registered via DI from `Program.cs`?
- [ ] Configuration read from arguments, environment, or a git-ignored local file — never committed?
- [ ] No secrets, tokens, or connection strings in source or committed config?
- [ ] **No secret echoed** to the console or into a log, including in verbose/debug output?
- [ ] TLS certificate validation left enabled everywhere?

## Idempotency & repeatability (§IV)
- [ ] Is running the tool twice safe, or is re-running explicitly guarded?
- [ ] Are partial failures resumable, or at least clearly reported as partial?
- [ ] Is external state detected rather than assumed (check-then-act, not act-and-hope)?

## Determinism (§IV)
- [ ] No inline `DateTime.UtcNow`/`Now` or `Guid.NewGuid()` where it blocks testing — injected provider instead?

## Error handling & observability (§IV)
- [ ] No silently swallowed exception that terminally aborts or degrades the run without a message?
- [ ] Each error reported once, at the layer that terminally handles it?
- [ ] Do error messages tell the user what to **do**, not just what failed?

## Testing (§VI — Tier 2)
- [ ] Logic-bearing paths tested: argument parsing, path resolution, data transformation, filtering, exit-code selection, idempotency?
- [ ] The safe-default guard tested (the single most valuable test in this kind)?
- [ ] Any `exempt` claim genuinely limited to thin glue or a pure passthrough?
- [ ] Test names follow `<Method>_<Scenario>_<ExpectedOutcome>`?
- [ ] Default stack used for new domains: xUnit + FluentAssertions + NSubstitute?

## Verification (§VII)
- [ ] Domain `build` command from the registry run and green?
- [ ] Domain `test_cmd` run — targeted, then full?
- [ ] **`SMOKE-RUN`: the tool actually executed once in safe/dry-run mode** and observed? A tool that compiles but has never run has not been verified.
- [ ] New warnings you introduced fixed rather than deferred?
