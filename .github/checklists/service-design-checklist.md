# Service & Library Design Checklist — `services/**`, `libs/**`

Applies to changes in any domain under `services/` or `libs/` (**Tier 1** — the highest
bar in the repo). Walk the items relevant to the change; answer each or mark N/A **with a
reason**.

`libs/**` has the largest blast radius: more than one domain depends on it. Treat every
public member as a contract.

## Scope & registry (§I, §IX)
- [ ] Change stays inside the one resolved domain's `source` + `tests` from `.github/domains.yaml`?
- [ ] Domain is registered in the registry with paths matching what you are editing?
- [ ] Domain root has a `README.md` stating what it is, what it's for, how to run it, and its state?
- [ ] No dependency on another domain's **internal** types — cross-domain contracts go through `libs/`?
- [ ] **No reference to anything under `spike/**`** (§XI)? A spike informs the design; it is never referenced.
- [ ] Smallest viable design — no unrelated renames, reformatting, or refactors?

## Public contract (§I, §IV) — critical for `libs/**`
- [ ] Is the change **additive**? If a public member was removed or re-signatured, is that honestly reported as `breaking`?
- [ ] Every dependent domain from the registry listed under `DOWNSTREAM-IMPACT`?
- [ ] XML doc comments on **all** new public types and members?
- [ ] Is the new surface the smallest one that satisfies the requirement — not a speculative framework?
- [ ] Does the type name and shape make the illegal state unrepresentable where practical?

## Endpoints & handlers (§IV, §V)
- [ ] Existing auth policies, required claims, headers, and query parameters preserved?
- [ ] **All** caller-supplied input validated before use — ids, paths, ranges, payload shapes?
- [ ] Consistent, documented error shape; no internal exception detail, stack traces, or connection info leaked to callers?
- [ ] RESTful design for HTTP surfaces; status codes correct and intentional?
- [ ] Idempotency considered for anything a caller may retry?

## Async & cancellation (§IV)
- [ ] `async`/`await` for all I/O?
- [ ] `CancellationToken` propagated through **every** async call chain, including data access and outbound HTTP?
- [ ] No `.Result` / `.Wait()` / `.GetAwaiter().GetResult()`?
- [ ] Hosted services and long-running handlers honour the stopping token?

## Data access (§IV, §V)
- [ ] **All** queries parameterized — no string-concatenated SQL anywhere?
- [ ] The domain's existing repository/persistence pattern respected — not a second pattern bolted alongside?
- [ ] Migration added only when the model genuinely changed; no hand-editing an applied migration?
- [ ] Connection strings and credentials read from configuration/secrets, never committed?

## Security (§V)
- [ ] No secrets, tokens, or connection strings in source or committed config?
- [ ] Input encoded/validated at every system boundary — HTTP, message consumers, file reads, IPC?
- [ ] Authorization boundary enforced — no path that resolves or returns data the caller shouldn't see?
- [ ] External content and tool output treated as untrusted (prompt-injection aware where LLM calls are involved)?

## Observability (§IV)
- [ ] Does any path terminally swallow an exception or abort/degrade an operation **without** a log at appropriate severity?
- [ ] In `services/**`, does that path also emit a **metric**?
- [ ] Is each error logged exactly once, at the layer that terminally handles it — no duplicate telemetry across frames?
- [ ] Are logs free of secrets and personal data?

## Determinism (§IV)
- [ ] No inline `DateTime.UtcNow`/`Now` or `Guid.NewGuid()` in production code — injected clock/id provider instead?
- [ ] Matches the determinism pattern already established in this domain?

## Testing (§VI — Tier 1: failing-test-first is MANDATORY)
- [ ] Contract pinned **before** writing code (FR, task, or checklist item named)?
- [ ] Tests written first and **actually run failing** against the un-fixed code? (`Pre-fix result: fail`)
- [ ] Could the tests have passed before the change? If yes, they prove nothing — rewrite them.
- [ ] Bug fix starts with a test that reproduces the bug?
- [ ] Happy, error, **edge**, **cancellation**, and **invalid-input** paths covered?
- [ ] Test names follow `<Method>_<Scenario>_<ExpectedOutcome>`?
- [ ] Existing framework/assertion/mocking libraries used (default for new domains: xUnit + FluentAssertions + NSubstitute)?
- [ ] Any `exempt` claim genuinely credible at Tier 1 — where exemption is rare?

## Verification (§VII)
- [ ] Domain `build` command from the registry run and green?
- [ ] Domain `test_cmd` run — targeted, then full project?
- [ ] If the `libs/**` public surface changed, was **every dependent domain** also built? A green library with red consumers is not done.
- [ ] New warnings you introduced fixed rather than deferred?
