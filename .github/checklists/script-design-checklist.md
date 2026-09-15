# PowerShell Script Design Checklist — `scripts/**`

Applies to changes in any domain under `scripts/` (Tier 2). Walk the items relevant to the
change; answer each or mark N/A **with a reason**.

Scripts are the easiest thing in this repo to run carelessly and the hardest to undo.
Safety of defaults comes first.

## Destructive operations — answer these first (§IV, §V)
- [ ] Does this delete, overwrite, force-push, reset, or mutate remote/shared state?
- [ ] **Is the default invocation safe?** Running with no parameters must not destroy anything.
- [ ] Is `[CmdletBinding(SupportsShouldProcess = $true)]` declared?
- [ ] Is **every** destructive action wrapped in `if ($PSCmdlet.ShouldProcess($target, $action))`?
      Declaring `SupportsShouldProcess` without wrapping is worse than not offering `-WhatIf` at all — it silently lies.
- [ ] Is `ConfirmImpact` set appropriately (`High` for genuinely destructive scripts)?
- [ ] Are paths from input validated and canonicalized before being acted on, and refused if outside an expected root?
- [ ] Is the safe default **covered by a Pester test** asserting the destructive path does not run without the opt-in?

## Scope & registry (§I, §IX)
- [ ] Change stays inside the one resolved domain's `source` + `tests` from `.github/domains.yaml`?
- [ ] Domain is registered in the registry with matching paths?
- [ ] Domain root `README.md` has a copy-pasteable usage example?
- [ ] Smallest viable change — no unrelated reformatting or drive-by rewrites?

## Script structure & conventions (§IV)
- [ ] **Approved verb** (`Get-Verb`) and `Verb-PascalNoun` naming?
- [ ] `[CmdletBinding()]` present on every function and script?
- [ ] Parameters **typed**, with validation attributes (`[ValidateNotNullOrEmpty()]`, `[ValidateSet()]`, `[ValidateRange()]`, `[ValidateScript()]`)?
- [ ] Mandatory parameters marked `Mandatory` rather than defaulted to something surprising?
- [ ] `Set-StrictMode -Version Latest` at the entry point?
- [ ] Explicit `$ErrorActionPreference` set at the entry point (usually `'Stop'`)?
- [ ] `param()` block before any executable statement?

## Help & discoverability (§IV, §IX)
- [ ] Comment-based help present with `.SYNOPSIS`, `.DESCRIPTION`, `.PARAMETER` for each parameter?
- [ ] **At least one `.EXAMPLE`** — this is how the next person runs it safely, and it is not optional?
- [ ] Does the first `.EXAMPLE` show the **safe** invocation (e.g. with `-WhatIf`)?
- [ ] `.OUTPUTS` documented where the script emits objects a caller will consume?

## Output & pipeline behaviour (§IV)
- [ ] Emits **objects**, not pre-formatted strings, so output composes in a pipeline?
- [ ] Diagnostics via `Write-Verbose` / `Write-Warning` / `Write-Error` — **not** `Write-Host`?
- [ ] Quiet by default, informative under `-Verbose`?
- [ ] Does it avoid `Write-Output` for status chatter that would pollute the return value?
- [ ] Are failures surfaced as terminating errors (`throw` / `-ErrorAction Stop`) where the caller must not continue?

## Security (§V)
- [ ] No secrets, tokens, passwords, or connection strings in source?
- [ ] Secrets read from environment variables, `SecretManagement`, or a git-ignored local file?
- [ ] **No secret echoed** into output, transcript, or verbose logging?
- [ ] Credentials taken as `[PSCredential]` or `[SecureString]` rather than plain `[string]`?
- [ ] TLS certificate validation **never** disabled (no `ServerCertificateValidationCallback = { $true }`, no `-SkipCertificateCheck` without explicit justification)?
- [ ] No `Invoke-Expression` on data that came from outside the script?
- [ ] External input (file contents, API responses, environment) validated before use?

## Idempotency & recovery (§IV)
- [ ] Is running the script twice safe, or is re-running explicitly guarded?
- [ ] Does it check current state before acting (check-then-act, not act-and-hope)?
- [ ] If interrupted, does it leave the target recoverable — and is that documented?

## Error handling (§IV)
- [ ] No `try { } catch { }` that swallows an error and continues as if nothing happened?
- [ ] Where a fallback is taken, is it logged at appropriate severity?
- [ ] Each error surfaced once, at the point that terminally handles it?
- [ ] Do error messages tell the user what to **do** next?

## Testing (§VI — Tier 2)
- [ ] **Pester v5** tests for logic-bearing paths: parameter validation, path resolution, filtering, transformation, idempotency guards?
- [ ] The safe-default / `ShouldProcess` guard tested?
- [ ] External commands and cmdlets mocked rather than actually invoked?
- [ ] Any `exempt` claim genuinely limited to a thin passthrough?

## Verification (§VII)
- [ ] `Invoke-ScriptAnalyzer -Path <domain path> -Recurse -Severity Error` run with **zero Error-severity findings**?
- [ ] Domain `test_cmd` (Pester) run and green?
- [ ] **`SMOKE-RUN`: the script actually executed once with `-WhatIf`** and the output observed?
- [ ] Any suppressed analyzer rule justified inline with a comment?
