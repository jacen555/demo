# EvalEngine

> **Kind:** `lib` · **Tier:** 1 · **Registry id:** `eval-engine`

## What this is

A generic evaluation harness for running a suite of scenarios against a system under test and
producing a durable, diff-able artifact of what happened. It handles three kinds of scenario in
one suite — REST calls, MCP tool invocations, and multi-turn LLM conversations — and its purpose
is **before/after comparison for pull requests**: attaching evidence that shows regressions *and*
newly-covered scenarios.

The central design idea, which everything else follows from:

> **Every runner produces the same kind-agnostic `Transcript` + `Outcome`.** Assertions,
> aggregation, comparison, and reporting operate only on those two types and cannot tell which
> kind of scenario produced them.

A REST call is the **degenerate one-turn case of the same pipeline**, not a separate code path.
A conversation loop is an *emergent composition* of a multi-turn `IParticipant` and a
`TerminalCondition` — never a core concept.

The core vocabulary is `stimulus` / `response` / `turn` / `terminalCondition`. It is deliberately
**not** `question` / `answer`: the moment one domain's words enter the core types, the "generic"
engine has quietly encoded that domain's assumptions. That applies to `Simulation` too — a REST
scenario flows through it, and an HTTP request is not an answer to anything — so the simulated
caller's material is `scriptedStimuli` / `stimulusPool`, not `scriptedAnswers` / `answerPool`.
The legacy `answer` / `slot` / `scriptedAnswers` / `answerPool` input names are still accepted
**at the loading boundary only**, mapped there and never written back. Declaring a canonical name
*and* its legacy alias on the same object is refused rather than resolved last-one-wins, because
silently discarding authored script material surfaces later as a baffling eval result rather than
as an error.

## What it was built to learn or do

To find out whether a single harness can serve one-shot API checks and stochastic multi-turn
conversations without either one distorting the model — and whether the statistics needed to say
"this got worse" honestly can be designed in from the start rather than bolted on.

## What is here today (T3 — contracts, seams and serialization)

| Area | Types |
|---|---|
| Scenario model | `Scenario` composed of `ScenarioIdentity`, `Execution`, `Simulation`, `Grading`, `Selection`, `Slicing` |
| Transcript model | `Transcript`, `Turn`, `TurnProvenance`, `Outcome`, `TransportMetadata` |
| Assertions | `AssertionSpec` (parsed from `category:parameter`), `AssertionResult`, `AssertionCategory` |
| Results | `RunResult`, `ScenarioResult`, `SuiteResult`, `StatisticalSummary` |
| Seams | `IScenarioRunner`, `IParticipant`, `IAssertionEvaluator`, `ISignificanceTest`, `IMultipleComparisonCorrection`, `IBaselineProvider`, `ILlmClient` |
| Statistics inputs | `PairedObservation`, `PairedObservations` |
| Determinism | `IClock` / `SystemClock`, `ISeedSource` / `DeterministicSeedSource` |
| Loading | `SuiteLoader`, `SuiteLoadResult`, `ValidationMessage` |
| Serialization | `CanonicalJson`, `SchemaVersions`, `SchemaVersionException` |

### Scenario composition

`Scenario` is a composition of sub-records, each owned by exactly one pipeline stage. No stage
reaches across into another stage's fields:

| Sub-record | Owning stage |
|---|---|
| `Identity` | the suite author and the reporter |
| `Execution` | the runner |
| `Simulation` | the participant (the simulated caller) |
| `Grading` | the assertion evaluators |
| `Selection` | the scenario selector |
| `Slicing` | results slicing only — never execution |

**Adding a top-level field requires naming its consuming component.** A field with no named
consumer belongs inside an existing sub-record, or nowhere.

### Assertions are data, not classes

Assertions are expressions of the form `category:parameter`, split on the **first** colon only —
a parameter may itself contain `:` or `/`:

```
slotAbsent:scope/confirm
reachedDepth:4
escalateReasonIs:out_of_scope
!slotAbsent:scope/confirm      # '!' negates, '+' affirms; both are optional
```

An entry in a suite file may be a bare expression, or an object that also declares the turn it
depends on:

```json
{ "expression": "reachedDepth:4", "turn": 4 }
```

### The script-overrun guard

Under a deterministic caller, only turns `1..scriptedTurnBudget` are driven by the script — and
**the opening is turn 1**, so a one-turn REST scenario has a budget of 1, not 0. An assertion
judged against a later turn is judging a stimulus the *simulated caller* invented, so it measures
the caller rather than the system under test. This caused a genuine misdiagnosis in the harness
this design came from, so `SuiteLoader` rejects it at load time:

```
Error: [scenario.assertion.scriptOverrun] scenario 'overrun-probe': assertion 'reachedDepth:5'
depends on turn 5, but the script drives only 3 turn(s). Turns past the script are driven by the
simulated caller, so this assertion would measure the caller rather than the system under test.
```

**The guard is on by default, not opt-in.** The failure mode it defends against is an author not
thinking about which turn an assertion lands on — so a guard that engaged only once they declared
`"turn"` would engage only for the authors who did not need it. An assertion with **no** declared
turn is therefore read conservatively, as depending on the last turn the run could possibly
reach, and is refused unless the scenario is structurally incapable of reaching past its script:

```
Error: [scenario.assertion.turnScopeRequired] scenario 'overrun-probe': assertion
'reachedDepth:5' does not declare which turn it depends on, and this scenario can reach an
unbounded number of turns while the script drives only 2 turn(s). ...
```

A scenario is bounded to its script when `terminalCondition.stopOnParticipantCompletion` is left
enabled (the default — a deterministic participant signals completion once its script runs out),
or when `terminalCondition.maxTurns` is at or below the scripted budget. In those cases an
undeclared turn is safe and nothing is reported, so the common one-turn REST case stays free of
ceremony. Declaring `"turn"` is how an author narrows the claim in the cases that are not.

A turn *ceiling* past the scripted budget is a warning rather than an error — it is legitimate,
but you should not assert on those turns.

`grading.expectedOutcome` and `grading.expectedPath` are read the same conservative way. They
judge the outcome the run *ended on*, so if the run can outlast the script that outcome may have
been produced by turns the script never drove. Unlike an assertion they carry no turn of their
own, so there is no narrower claim to declare and the only remedy is to bound the run:

```
Error: [scenario.grading.expectationScopeRequired] scenario 'overrun-probe':
grading.expectedOutcome judges the outcome the run ended on, and this scenario can reach an
unbounded number of turns while the script drives only 2 turn(s). ...
```

The scripted turn budget counts only material that can actually drive a turn, so a blank or
missing entry cannot widen it — and such an entry is refused at the loading boundary anyway,
rather than being carried as a stimulus the participant could never send.

### Canonical artifacts

`SuiteResult` is the durable, committable output. `CanonicalJson` writes it with **object keys
ordered ordinally at every level**, unset optional values **absent rather than null**, enums as
camel-case strings, and `\n` line endings — so a diff shows real change and not key-order churn.

`schemaVersion` is **stamped, not supplied**: `SuiteResult.SchemaVersion` has no setter, so a
writer cannot label an artifact with a version it was not written to. Because it is stamped
rather than bound, reading a future artifact without checking would return one labelled with
*today's* version and lose the evidence that its shape was unsupported — so **every** public way
of reading a `SuiteResult` carries the version guard, `CanonicalJson.Deserialize<SuiteResult>`
included, not just `CanonicalJson.DeserializeSuiteResult`. `SuiteLoader` reports an unsupported
suite `schemaVersion` as an error (and a missing one as a warning). Support is *same major, minor
at or below* — which follows from the bump policy that an additive change does not bump.

Integer enum input is refused, so an ordinal in a suite file is not a back door into a closed set,
and a null assigned to a non-nullable member is refused rather than bound, so a required
sub-record cannot arrive null.

### Comparing artifacts

`SuiteResult` and `Transcript` compare by **canonical value**, not by collection reference —
`==`, `Equals` and `GetHashCode` all go through canonical JSON, so two artifacts built from
identical data are equal. `CanonicalJson.AreEquivalent(left, right)` is the same comparison for
any other type. It costs a serialization per comparison, which is the right trade for types whose
whole identity is their committed text.

### Statistics: decided, not yet computed

`StatisticalSummary` carries its full shape now so the artifact schema does not change when the
statistics land. The methods are already settled and recorded in the XML docs so they are not
relitigated:

- **Wilson or Agresti-Coull** intervals. Never normal/Wald — it misbehaves at small n and at
  extreme proportions, which is exactly where an eval suite lives.
- **McNemar's test or a paired bootstrap.** The comparison is *paired by construction* (same
  scenarios, same seeds, two variants); an unpaired two-proportion z-test is a documented footgun.
  `PairedObservation` carries one scenario's identity, the seed both variants ran with, and a
  **non-binary** per-scenario statistic for both variants on a single record — so an unpaired or
  mismatched comparison is not expressible rather than merely discouraged. `PairedObservations`
  is only constructible through `Create`, which rejects duplicates, blank identifiers and
  non-finite values, and exposes the validated set as a read-only view so it cannot be cast back
  to an array and edited afterwards.
- **Benjamini-Hochberg FDR**, not Bonferroni — but this one is a *deliberate design choice*, not
  settled convention, and is flagged as such in the doc comment.

Today the library reports raw deltas with `significant = notComputed` and no interval. That is
honest rather than pretending.

## Current state

**`partial` — contracts only.** Types, seams, the suite loader with validation, and canonical
serialization are complete and tested. Deliberately **not** here yet:

- No `IScenarioRunner` implementations (REST, MCP, LLM) — T4 and later.
- No `IAssertionEvaluator` implementations — T4.
- No statistics implementations — `ISignificanceTest` and `IMultipleComparisonCorrection` have no
  implementations, and `StatisticalSummary.Interval` / `.Comparison` are never populated — T9.
- No baseline provider, no reporter, no CLI wiring.

### Known sharp edge

`SuiteResult` and `Transcript` compare by canonical value, but the sub-records reached through
them (`ScenarioResult`, `RunResult`, `Outcome`, `Simulation`, …) still hold collections and still
use the compiler-generated member-wise equality, which compares those by **reference**. Compare
those with `CanonicalJson.AreEquivalent`, not with `==`.

## How to use

```csharp
var result = SuiteLoader.LoadFromJson(json, "regression.json");
if (!result.Succeeded)
{
    foreach (var message in result.Messages)
    {
        Console.Error.WriteLine(message);
    }
}

// Or from disk, confined to a root directory. Containment is checked against the path the file
// system will actually read from, so a traversal *and* a symlink or junction inside the root
// that points out of it are both refused. A segment whose link status cannot be established at
// all is also refused — "I could not inspect it" is not evidence that it is not a link, whereas
// a segment that is confirmed absent stays an ordinary not-found:
var loader = new SuiteLoader(@"C:\repo\eval-suites");
var loaded = await loader.LoadAsync("regression.json", cancellationToken);
```

This is a library; there is nothing to run directly. Its consumer is `tools/EvalCli`
(`eval-cli` in the registry), which does not yet reference it.

## Build and test

```powershell
dotnet build libs/EvalEngine/src/Forge.EvalEngine.csproj
dotnet test libs/EvalEngine/tests/Forge.EvalEngine.Tests.csproj
```
