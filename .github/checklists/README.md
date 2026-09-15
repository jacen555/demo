# Design Checklists

Per-kind checklists used at three points in the workflow:

1. **Planning** — `forge-team.planner` walks the checklist during design validation and
   reports `DESIGN-CHECKLIST`.
2. **Build** — the builder does a pre-flight pass before writing code.
3. **Review** — the reviewer cross-checks the change and cites any missed applicable item,
   mapped to its constitution section.

| Checklist | Applies to | Kind | Tier |
|---|---|---|---|
| `app-design-checklist.md` | `apps/**` | `app` | 2 |
| `service-design-checklist.md` | `services/**`, `libs/**` | `service`, `lib` | 1 |
| `tooling-design-checklist.md` | `tools/**` | `tool` | 2 |
| `script-design-checklist.md` | `scripts/**` | `script` | 2 |

Spikes (`spike/**`, Tier 0) have no checklist — see Constitution §XI.

## How to use one

Walk the items relevant to your change. Answer each, or mark it **N/A with a reason**.
"I didn't consider it" is not N/A.

**A checklist informs; it does not replace the constitution.** If a checklist item and
`.github/instructions/constitution.instructions.md` conflict, the constitution wins — and
the checklist is wrong and should be fixed.

## Adding a checklist

When you add a new `kind` to `.github/domains.yaml`, add a matching checklist here and
point the kind's `checklist:` field at it. Keep the structure consistent: group items by
constitution section so reviewers can cite them directly.
