# Product Context — Forge

## Who this serves

One developer (and their agents), working across a wide surface of technologies, who needs
somewhere to build things without either ceremony or rot.

There is no external customer. The "product" is the **workshop itself**: the speed at which
a question becomes a running experiment, and the confidence that the things worth keeping
stay trustworthy.

## The problems it solves

### 1. "Where do I put this?"

Every new idea used to need a decision about repo, structure, build setup, and conventions
before any code got written. Forge answers it structurally: pick a root, run
`scaffold-domain`, start writing. The root choice also settles the rigor question, so it
does not get relitigated per change.

### 2. "Did we already try this?"

The characteristic failure of a personal experiment repo is rediscovery — re-running an
experiment whose answer was already known, or rebuilding a tool that already exists three
folders over. Forge's defence is two-part:

- `docs/adr/` records **why** decisions were made, with the evidence.
- `memory-bank/progress.md` records **what exists and what state it is in**.

The `researcher` agent cannot finish an investigation without leaving one of these behind.

### 3. "This experiment became load-bearing and nobody noticed."

Experiments graduate into things you depend on, usually without ceremony, and then break at
the worst time. Forge makes graduation explicit: a spike that proves an approach is
**rewritten** into `libs/` or `services/` under Tier 1 gates. Moving the folder is
explicitly not graduation (Constitution §XI).

### 4. "The process is heavier than the work."

Tiering exists so that a throwaway benchmark does not need an approval gate and a failing
test, while a shared library does. The tier is decided by location, so it is not negotiated
per task.

## Domains

_No domains registered yet — the repo is freshly scaffolded._

As domains are added via `scaffold-domain`, record here **why each one exists** and who or
what it serves. The registry (`.github/domains.yaml`) says *where* it is; this file says
*why*.

| Domain | Kind | Exists to | Consumers |
|---|---|---|---|
| _(none yet)_ | | | |

## How work arrives

| Route | Use when | Lands in |
|---|---|---|
| `forge-team` orchestrator | Multi-domain or Tier 1 work of real scope | Plan → build → review loop |
| Single-agent workflow | Focused, single-domain change | Direct implementation, same gates |
| `researcher` | "How does X work?", "Is A faster than B?" | `spike/` + `docs/adr/` |
| Spec Kit prompts | Larger features wanting written artifacts | `specs/<feature>/` |

## Non-goals

- **Not a monorepo for a product.** Domains are deliberately independent; there is no
  shared release, no versioning scheme across domains, no unified deployment.
- **Not a portfolio.** Code here is honest about its state, including `broken` and
  `abandoned`. `progress.md` is not a highlight reel.
- **Not a dumping ground.** Everything is registered, every domain has a README that says
  what it is for, and answered spikes either graduate or get deleted.
