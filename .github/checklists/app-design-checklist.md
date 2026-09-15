# Desktop App Design Checklist — `apps/**`

Applies to changes in any domain under `apps/` (Tier 2).
Walk the items relevant to the change; answer each or mark N/A **with a reason**.

## Scope & registry (§I, §IX)
- [ ] Change stays inside the one resolved domain's `source` + `tests` from `.github/domains.yaml`?
- [ ] Domain is registered in the registry with paths matching what you are editing?
- [ ] Domain root has a `README.md` stating what it is, what it's for, how to run it, and its state?
- [ ] No edits to `services/`, `libs/`, `tools/`, `scripts/`, `spike/`, `.github/`, `memory-bank/`, `docs/`, or root build files?
- [ ] Shared types surfaced as a `SHARED-TYPE-REQUEST` for a `libs/` task rather than edited directly?
- [ ] Smallest viable design — no unrelated renames, reformatting, or refactors?

## UI layer discipline (§IV)
- [ ] Is the logic testable **without** instantiating a window? If not, move it to a view model or service.
- [ ] No I/O, business logic, or blocking work in code-behind or view-model constructors?
- [ ] No `.Result` / `.Wait()` / `.GetAwaiter().GetResult()` anywhere on the UI path?
- [ ] Post-await UI access explicitly marshalled (`DispatcherQueue` / `Dispatcher`)?
- [ ] Long-running work moved off the UI thread, with a visible busy/progress state?
- [ ] `CancellationToken` propagated through async chains, and cancelled when the view closes?

## Lifetime & disposal (§IV)
- [ ] Every event handler subscription has a matching unsubscription?
- [ ] Timers, file watchers, tray icons, global hotkeys, and native handles disposed?
- [ ] Anything registered with a longer-lived object (messenger, event aggregator, static event) released on teardown?
- [ ] Window/view state persisted and restored deliberately, not incidentally?

## Composition & configuration (§IV, §V)
- [ ] Services registered in the composition root (`App.xaml.cs` / `Program.cs`) via DI?
- [ ] No `new` of a service that has a registered abstraction?
- [ ] No secrets, tokens, or connection strings in `appsettings.json` or any committed config?
- [ ] Credentials stored via DPAPI or Windows Credential Manager — never plaintext files or the registry?

## Input & trust boundaries (§V)
- [ ] Data read from disk, clipboard, registry, IPC, or another process validated before use?
- [ ] File paths from user input validated and canonicalized before being acted on?
- [ ] Content rendered from an external source treated as untrusted (no injection into markup/script surfaces)?
- [ ] Destructive user actions confirmed, and reversible where practical?

## Determinism (§IV)
- [ ] No inline `DateTime.UtcNow`/`Now` or `Guid.NewGuid()` where it blocks testing — injected clock/id provider instead?
- [ ] Matches the determinism pattern already established in this domain?

## Error handling & observability (§IV)
- [ ] No silently swallowed exception that terminally aborts or degrades an operation without a log?
- [ ] Each error logged once, at the layer that terminally handles it — no duplicate telemetry across frames?
- [ ] User-facing failures produce a comprehensible message, not a raw exception string?

## Testing (§VI — Tier 2)
- [ ] Logic-bearing paths (parsing, state machines, computation, data shaping, command enablement) have tests?
- [ ] Any `exempt` claim genuinely limited to XAML layout, styling, or thin glue — with a one-line justification?
- [ ] Test names follow `<Method>_<Scenario>_<ExpectedOutcome>`?
- [ ] Existing framework/assertion/mocking libraries used (default for new domains: xUnit + FluentAssertions + NSubstitute)?
- [ ] `TEST-FIRST-EVIDENCE` names tests that actually cover the changed contract?

## Verification (§VII)
- [ ] Domain `build` command from the registry run and green?
- [ ] Domain `test_cmd` run — targeted, then full project?
- [ ] New warnings you introduced fixed rather than deferred?
- [ ] App actually launched once and the changed path exercised by hand?
