# 0002. Admit Node.js for ecosystem-bound tooling

- **Status:** Accepted
- **Date:** 2026-09-15
- **Supersedes:** nothing. Amends the stack declared in ADR 0001's context.

## Question

Forge's constitution declares ".NET primary, PowerShell for scripts." A shared
demo-video engine (`tools/SizzleCraft`) needs headless browser automation and
ffmpeg orchestration, and its existing implementation is Node.js. Do we port it,
exclude it, or admit a third language?

## Context

The work that prompted this: two narrated demo videos were produced with bespoke
tooling kept outside the repo, under `~/SizzleCraft/<project>/`. The pipeline was
sound; the packaging was not. Each project carried its own copy of the engine —
**9 byte-identical scripts, ~124 KB** — and five more had already drifted apart.
Consolidating them into a single domain is the obvious fix, and doing so requires
deciding what language that domain is written in.

The engine's load-bearing dependencies are `playwright` (headless browser frame
capture), `msedge-tts` (narration synthesis), and ffmpeg driven over a child
process. Frame capture is the pipeline's long pole and the part most sensitive to
the browser automation library's behaviour.

## Options considered

1. **Port to .NET.** Keep the declared stack intact.
   · Pros: one language; existing constitution, scaffolding, and test conventions
   apply unchanged.
   · Cons: the port buys nothing. Playwright's .NET binding wraps the same Node
   driver process, so the dependency does not actually go away — it gains a layer.
   `msedge-tts` has no .NET equivalent. ffmpeg is a subprocess either way, so the
   host language is irrelevant there. This is days of work to produce a *worse*
   artifact, and it throws away code that is already proven against two shipped
   videos.

2. **Leave it outside the repo.** Consolidate in place at `~/SizzleCraft/_core/`.
   · Pros: no constitution change.
   · Cons: the thing we most want — that it stops being invisible, untested, and
   duplicated — is exactly what living outside the repo prevents. It stays
   unversioned, unreviewed, and undiscoverable, which is how it got into this state.

3. **Admit it as an unblessed exception.** Put it in `tools/` and note in the
   README that Node is a one-off here.
   · Pros: fastest.
   · Cons: an "exception" with no rules is just an undocumented second stack. The
   next Node domain copies this one and inherits nothing — no conventions, no test
   runner, no scaffolding. Precedent without policy is the worst of both.

4. **Admit Node.js properly**, with a constitution section, registry support,
   scaffolding, and this ADR.
   · Pros: the cost is bounded and one-time; every later Node domain inherits real
   conventions.
   · Cons: a genuinely larger repo surface — a second test runner, a second
   formatter, a second dependency ecosystem to keep current.

## Evidence

- **The .NET port does not remove the Node dependency.** Playwright's .NET binding
  drives a bundled Node process; the runtime is still there, with an extra
  interop boundary. The port would add a layer, not remove one.
- **The engine is already generic.** Inspection of the 9 extracted scripts found
  **no hardcoded project paths** and only one internal coupling
  (`remix.mjs` and `voice.mjs` both import `canonical-json.mjs`). Nothing about
  them is project-specific — they were duplicated by convenience, not necessity.
- **The code is proven.** These scripts produced two finished videos. A port would
  discard that and reintroduce the class of bugs already recorded in the
  `demo-recording` bug ledger.
- **Language is orthogonal to kind.** This was the deciding design point. A Node
  tool is still a `tool` — same root, same tier 2, same builder/reviewer pair, same
  design checklist. Modelling this as a `language` field rather than a `node` kind
  keeps the kind taxonomy from multiplying (`node-tool`, `node-service`, …) and
  leaves the tier mapping in §II untouched.

## Decision

Admit Node.js as a **second-class but fully specified** language, permitted where
the ecosystem is the reason for the work.

- A domain declares `language: node` in `.github/domains.yaml`. Its `kind`, and
  therefore its **tier, is unchanged**.
- Constitution §IV gains a JavaScript/Node.js subsection: ESM only, no bundler,
  pinned `engines`, committed lockfile, dependencies justified in the README, fail
  loud with non-zero exit, `node:test` as the test runner, Prettier for formatting.
- `scaffold-domain` gains `-Language node`, emitting `package.json`, an ESM entry
  point, and a `node:test` test. Node domains are excluded from `Forge.sln` —
  there is nothing to compile.
- `-Language node` is **rejected for `-Kind script`**: the `scripts/` root is
  PowerShell automation by definition (§I). Node tooling goes in `tools/`.
- **.NET remains the default.** Node is for cases where the library that makes the
  work possible is JavaScript. "I prefer it" is not a reason.
- **No further language is admitted by precedent.** Adding one requires this same
  treatment: constitution section, registry support, scaffolding, and an ADR.

## Consequences

**Makes easy**
- Consolidating the demo engine at all — the entire point.
- Future ecosystem-bound tooling (browser automation, npm-only libraries) has a
  defined home and defined conventions instead of landing outside the repo.
- Tier and review machinery applies unchanged: `tools/SizzleCraft` is tier 2, gated
  by `tooling-builder` / `tooling-reviewer` like any other tool.

**Makes hard**
- **Two test runners and two formatters.** `dotnet test`/xUnit alongside
  `node --test`; CSharpier alongside Prettier. Contributors and agents must check
  `language` before assuming a command.
- **A second dependency ecosystem to keep current.** npm advisories, lockfile
  maintenance, and `playwright`'s browser binaries, which are large and version-
  coupled.
- **The "ecosystem is the reason" test is a judgement call.** It will be argued
  over. That is deliberate — a bright line would either exclude legitimate cases or
  admit everything — but expect to have to hold it.
- **Repo-wide verification is no longer one command.** `dotnet build Forge.sln`
  does not cover Node domains; the registry's per-domain `test_cmd` is now the only
  complete story.

**Revisit when**
- A second Node domain appears — check whether the conventions actually transferred
  or whether the first one just got copied again.
- Playwright ships a .NET binding that does not shell out to Node, which would
  weaken the central argument for the capture stage specifically.
- A third language is proposed. If the answer is yes twice, the constitution's
  ".NET primary" framing is no longer describing reality and should be rewritten
  rather than exempted again.
