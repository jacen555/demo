# `apps/` — Desktop Applications

**Kind:** `app` · **Tier:** 2 · **Builder/Reviewer:** `app-builder` / `app-reviewer`
· **Checklist:** [`app-design-checklist.md`](../.github/checklists/app-design-checklist.md)

Desktop applications — WinUI 3, WPF, or a rich console UX. One immediate child folder per
domain, each registered in [`.github/domains.yaml`](../.github/domains.yaml).

## What Tier 2 requires

- **Pre-edit approval** before any edit
- **Tests for logic-bearing changes** — parsing, state machines, computation, data shaping,
  command enablement. Pure XAML layout and thin glue may be `exempt` with a justification
- **Independent reviewer** on a different model family (`gpt-5.6-sol` vs `claude-opus-4.8`)

## The rules that bite here

1. **Keep the UI thin.** If the logic can't be tested without opening a window, it's in the
   wrong layer. Move it to a view model or a service.
2. **Never block the UI thread.** No `.Result` / `.Wait()` / `.GetAwaiter().GetResult()`.
   Marshal back explicitly after an await.
3. **Dispose what you own.** Event handlers, timers, tray icons, file watchers, global
   hotkeys. A leaked handler in a long-running desktop app is a High finding.
4. **Credentials go through DPAPI or the Windows Credential Manager** — never plaintext
   files, never the registry.

## Add one

```powershell
.\.github\skills\scaffold-domain\scripts\New-ForgeDomain.ps1 `
    -Id clipboard-history -Kind app -Name ClipboardHistory -WhatIf
```

Defaults to the `wpf` template (it ships with the base SDK). Pass `-Template` for WinUI 3
or anything needing a template pack.

## Domains

_None yet._
