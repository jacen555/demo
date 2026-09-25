# System Patterns — Forge

Conventions that have earned their place. When a pattern here conflicts with
`.github/instructions/constitution.instructions.md`, **the constitution wins** and this file
is wrong — fix it.

## Pattern: rigor keyed to location, not to intent

**Problem.** A workshop repo needs both fast experimentation and a real bar on code that is
depended upon. Deciding rigor per-request means relitigating it every time, and the
argument is always won by whoever is in a hurry.

**Pattern.** Bind rigor to the **path**. `services/**` and `libs/**` are Tier 1;
`apps/**`, `tools/**`, `scripts/**` are Tier 2; `spike/**` is Tier 0. A change spanning
tiers takes the highest. The tier is a fact about the file, not a claim about the task.

**Consequence.** The only decision left is *where does this live*, which gets made once, at
`scaffold-domain` time, with the stakes visible.

## Pattern: agents parameterized by domain

**Problem.** A fixed builder/reviewer pair per project works when the project set is fixed.
Forge's is open-ended — a new pair per domain means an agent-file explosion and constant
drift between them.

**Pattern.** Three generic pairs (`app`, `service`, `tooling`) resolve their target from a
**domain id** passed by the orchestrator, looked up in `.github/domains.yaml`. Each pair is
still hard-scoped to exactly **one** domain per task.

**Escape hatch.** When a domain grows rules the generic agent cannot express, mint a
dedicated pair with `scaffold-domain -WithAgents` and repoint the registry row.

## Pattern: the registry as single source of truth

Every path, project file, build command, test command, tier, and agent assignment lives in
`.github/domains.yaml`. Agents **resolve** from it and never guess.

An unregistered domain is a **blocking error**, not an invitation to improvise. This is what
makes the parameterized-agent pattern safe: a builder that cannot resolve its domain stops
rather than inventing a folder layout that nobody else will expect.

## Pattern: spikes graduate by rewrite

**Problem.** The natural lifecycle of a successful experiment is "it works, ship it" —
which silently promotes code that skipped every gate into a position of dependency.

**Pattern.** A spike answers **one falsifiable question** and is registered at Tier 0.
When the question is answered, it either **graduates** — the real implementation is written
fresh in a real root under its proper tier — or **retires**, with the finding preserved in
an ADR. Moving the folder is explicitly *not* graduation.

**Enforcement.** Nothing outside `spike/` may reference anything inside it (§XI), and spikes
are excluded from `Forge.sln` so they cannot silently break the repo build.

## Pattern: reviewer independence by model family

Reviewers are strictly read-only (no `edit`, no `shell`) and run on a **different model
family** from the builder — builders `claude-opus-5`, reviewers `gpt-6-sol`. The
orchestrator pins both explicitly; relying on a default risks collapsing them into the same
family, at which point the review is just the builder agreeing with itself.

Both roles report their model, and the reviewer fails the verdict if independence cannot be
demonstrated.

## Pattern: structured reports as the interface

Builders and reviewers communicate through **fixed-shape reports**, not prose. A builder
emits `CHANGED FILES` / `TIER` / `BUILD` / `TESTS` / `TEST-FIRST-EVIDENCE` /
`BUILDER-MODEL` / `CONSTITUTION-CHECK`; a reviewer emits `VERDICT` / `FINDINGS` with
`file:line` plus a constitution citation.

This makes the loop **gateable**: the orchestrator can mechanically refuse to advance on
`BUILD: fail` or a missing `TEST-FIRST-EVIDENCE`, without interpreting narrative.

## Pattern: no finding without a citation

Every review finding cites a `file:line` **and** a constitution section. A finding that
cannot be located is not raised. This kills the two failure modes of AI review — vague
stylistic grumbling, and confident hallucinated problems.

## Pattern: settle disagreements with a measurement, not an argument

**Problem.** A builder and a reviewer can both produce a plausible argument about whether
a guard fires, a test covers something, or a statistic is calibrated. Plausible arguments
are frequently wrong, and two of them cost a round each.

**Practice.** When a claim is contested, produce a number:

- **Run the mutant**, don't reason about the branch. A guard reported unreachable was
  reachable twice before a third measurement settled it. A "redundant" backstop turned out
  to be the only thing covering a duplicate-key path nobody had identified.
- **Simulate the statistic**, don't trust the derivation. A paired bootstrap returned
  `p=0.0001` where the true rejection rate was 50%; the first remedy fixed `n=2` and still
  failed at `n=6`. Only a type-I error simulation caught either.
- **Read the real output**, don't inspect the code. Three disclosure leaks were found that
  way and none by reading — including one where a finding withheld the value it was warned
  about and printed an unsanitised one in the same sentence.
- **Probe the primitive.** `Path.GetFileName` ignores backslashes on Unix.
  `FileSystemName.MatchesSimpleExpression` treats `\` as an escape. `FileSystemInfo.LinkTarget`
  never throws on Windows. All three were found by constructing the case.

## Pattern: the defect that keeps coming back

Roughly twenty review findings across the eval harness were one shape: **evidence from one
context treated as though it came from another.** Its commonest form is **a refusal
rendering as an absence** — a guard that fires only in the total case, a count that reads
zero when nothing was comparable, a truncated section that looks empty.

Three things reliably surface it:

1. **Enumerate, don't sample.** Fixing where a finding points leaves the next instance. The
   T15d surface was five sites by inspection and twelve by enumeration.
2. **Verify the property, not the reported case.** A builder reports the case it tested; the
   predicate usually covers less.
3. **Distrust green.** A passing test is not evidence until you know why it passes. Repeated
   causes here: testing the helper rather than the path production takes, a lock that did not
   take, a relative path that echoed relative, a conditional skip keyed on the assertion's
   own subject.

And a caution on fixes: `required`, a name, and a convention all look structural in a diff
and are not. Four "structural" guarantees in this work still compiled with a wrong value.
The ones that held were enforced by the compiler — a count derived from an immutable
snapshot, a type with no display-string constructor, a method with no string overload.


Agent memory resets. The repo's memory does not. So:

- Every investigation ends in an **ADR** (`docs/adr/`) — the decision *and* the evidence.
- Every domain has a **README** saying what it is for and its honest current state.
- `memory-bank/progress.md` is the domain ledger; `docs/adr/` is the rationale.

"I learned how the API is shaped" is a README. "We will use X over Y because Z" is an ADR.

## Naming conventions

| Thing | Convention | Example |
|---|---|---|
| Domain id (registry, commit scope) | kebab-case | `clipboard-history` |
| Domain folder | PascalCase | `apps/ClipboardHistory` |
| .NET project | `Forge.<Name>` | `Forge.ClipboardHistory` |
| Test project | `Forge.<Name>.Tests` | `Forge.ClipboardHistory.Tests` |
| Test method | `<Method>_<Scenario>_<ExpectedOutcome>` | `GetById_UnknownId_ReturnsNotFound` |
| PowerShell script | `Verb-PascalNoun.ps1`, approved verb | `New-ForgeDomain.ps1` |
| ADR | `NNNN-kebab-title.md`, sequential | `0001-multi-agent-orchestration-...md` |
| Spike folder | kebab-case, names the question | `spike/channel-vs-blockingcollection` |
| PR title into `main` | `<type>(<domain-id>): <imperative subject>` | `feat(ledger): add idempotent posting` |

## Default stacks for a new domain

| Kind | Project | Tests |
|---|---|---|
| app | WPF (`-Template winui` or similar to override) | xUnit + FluentAssertions + NSubstitute |
| service | ASP.NET Core Web API | xUnit + FluentAssertions + NSubstitute |
| lib | classlib | xUnit + FluentAssertions + NSubstitute |
| tool | console | xUnit + FluentAssertions + NSubstitute |
| script | PowerShell 7 | Pester v5 |

Never introduce a second framework into a domain that already has one.
