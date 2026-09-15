# `scripts/` — PowerShell Automation

**Kind:** `script` · **Tier:** 2 · **Builder/Reviewer:** `tooling-builder` / `tooling-reviewer`
· **Checklist:** [`script-design-checklist.md`](../.github/checklists/script-design-checklist.md)

PowerShell automation and the useful one-liners that accumulate. One immediate child folder
per domain, each registered in [`.github/domains.yaml`](../.github/domains.yaml).

Not part of `Forge.sln` — there is nothing to compile. Verified by PSScriptAnalyzer and
Pester instead.

> **Scripts are the easiest thing here to run carelessly and the hardest to undo.**

## The rules that bite here

1. **The default invocation must be safe.** No parameters must not mean "destroy things".
2. **`SupportsShouldProcess` — and actually use it.** Declare
   `[CmdletBinding(SupportsShouldProcess = $true)]` *and* wrap every destructive action in
   `if ($PSCmdlet.ShouldProcess(...))`. Declaring it without wrapping is worse than not
   offering `-WhatIf` at all, because it silently lies.
3. **`Set-StrictMode -Version Latest`** and an explicit `$ErrorActionPreference` at every
   entry point.
4. **Comment-based help with at least one `.EXAMPLE`** — and make the first example the
   *safe* invocation. This is how the next person runs it without breaking something.
5. **Approved verbs** (`Get-Verb`), `Verb-PascalNoun` naming, typed parameters with
   validation attributes.
6. **Emit objects, not formatted strings**, so output composes in a pipeline. Diagnostics go
   through `Write-Verbose`/`Write-Warning`/`Write-Error` — not `Write-Host`.
7. **Credentials as `[PSCredential]` or `[SecureString]`**, never plain `[string]`. Never
   disable TLS validation. Never `Invoke-Expression` on outside data.

## Verification

```powershell
Invoke-ScriptAnalyzer -Path scripts -Recurse -Severity Error   # must be zero
Invoke-Pester -Path scripts/<Name>/tests
```

Builders must also report a `SMOKE-RUN` — the script actually executed once with `-WhatIf`.

## Add one

```powershell
.\.github\skills\scaffold-domain\scripts\New-ForgeDomain.ps1 `
    -Id env-setup -Kind script -Name EnvSetup -WhatIf
```

## Domains

_None yet._

## A worked example

[`../.github/skills/scaffold-domain/scripts/New-ForgeDomain.ps1`](../.github/skills/scaffold-domain/scripts/New-ForgeDomain.ps1)
follows all of the above — `ShouldProcess`, strict mode, comment-based help with examples,
typed and validated parameters, object output. Use it as the reference shape.
