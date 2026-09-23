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

## What is here today (T3 contracts + T4 assertion evaluators + T5 deterministic caller + T6 runners)

| Area | Types |
|---|---|
| Scenario model | `Scenario` composed of `ScenarioIdentity`, `Execution`, `Simulation`, `Grading`, `Selection`, `Slicing` |
| Transcript model | `Transcript`, `Turn`, `TurnProvenance`, `Outcome`, `TransportMetadata` |
| Transport vocabulary | `TransportAttributes`, `ExchangeState`, `StopReason` |
| Assertions | `AssertionSpec` (parsed from `category:parameter`), `AssertionResult`, `AssertionCategory` |
| Assertion evaluation | `AssertionEvaluatorRegistry`, `AssertionEvaluationException`, and one internal evaluator per category |
| Participants | `DeterministicCaller` — the simulated caller that adds no variance of its own |
| Runners | `RestRunner`, `NotImplementedMcpRunner`, and the `IRestExchange` adapter seam |
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

### The five evaluator categories

Every assertion is served by one of five evaluators, selected by its category token through
`AssertionEvaluatorRegistry`. A new behaviour is a **new row in a suite file**, not a new class —
and at worst one new evaluator, never a fork of an existing one.

| Category | Selectors | Judges |
|---|---|---|
| `exactMatch` | `outcome`, `path` | The observed value equals the expectation `grading` declared. |
| `structural` | `pathPresent`, `pathDepth/<n>`, `levelsPopulated`, `turnDepth/<n>` | The shape of what came back, independent of its values. |
| `presence` | `field/<key>`, `response/<token>`, `stimulus/<token>`, `anyResponse`, `repeatedResponse` | Something is in the evidence, or is not. |
| `baseline` | `outcome`, `path`, `fields` | The run against the recorded baseline transcript. |
| `expectedBehavior` | `outcome/<token>`, `path/<route>`, `field/<key>=<value>`, `fieldAtLeast/<key>=<n>`, `transport/<key>=<value>` | The system behaved a named way — including failing correctly. |

A parameter is `selector/operand`, split on the **first** `/` for the same reason an expression
splits on its first `:` — an operand may carry further slashes, such as the flattened field key
`scope/confirm` or the route `triage/resolve`.

**Polarity supplies the other half of each claim**, which is what collapses matched pairs of
origin checks into one evaluator: `presence:field/x` is "observed", `!presence:field/x` is
"absent", and `!structural:pathDepth/5` is "did not run deeper than four levels".

```
exactMatch:outcome                            # ended on the outcome the scenario declared
!structural:pathPresent                       # no route came back
presence:response/please confirm              # the system asked for confirmation
!presence:repeatedResponse                    # the system never repeated itself
baseline:fields                               # every returned field is unchanged
expectedBehavior:transport/statusCode=429     # this request was supposed to be refused
```

#### Expected failure is a first-class case

`expectedBehavior` exists because asserting that a system *correctly fails* — an expected error
code, a refusal, out-of-scope handling, graceful degradation — is a real requirement rather than
an afterthought. A scenario whose whole point is "this should 429" is one data row, and it
**passes** when the system does exactly that.

It names its expected value *in the assertion*, where `exactMatch` reads one from `grading`. That
is the distinction: `exactMatch` asks "did it do what this scenario declared it should",
`expectedBehavior` asks "did it do this specific named thing" — which is what a suite needs when
the interesting behaviour is a refusal no `expectedOutcome` would sensibly describe.

A *conditional* expectation — "the route survives when it escalates" — is two rows in the same
scenario, not a conditional evaluator. Two assertions are already a conjunction, and a branch
operator in the expression grammar would start the slide back towards code.

#### Refused, not graded

An assertion that cannot be evaluated throws `AssertionEvaluationException` rather than returning
a verdict, and a caller records the run as `RunStatus.Error` with `ErrorDetail` set. This is the
line `RunStatus` already draws: `Fail` is "the run completed and an assertion did not hold",
`Error` is "configuration or harness failure". Refused cases:

- An **unknown category** — a typo'd assertion that always passes is far worse than one that
  always fails, so it is never skipped.
- A **malformed or missing parameter** — a blank token would match everything, and an assertion
  that can never fail is not an assertion.
- An **expectation that was never declared**, for `exactMatch`.
- A **missing or mis-joined baseline**. Passing would report "no regression" on the strength of no
  evidence; failing would report a regression against a baseline that does not exist. Neither is
  true. The scenario id is the join key, so a baseline carrying a different one is refused too.

Negation does not rescue an un-evaluable assertion: `!baseline:outcome` with no baseline is still
refused, because there is still nothing to compare.

#### `ExaminedTurns` is load-bearing

Every evaluator records the turns that actually determined its verdict, using each turn's recorded
`Turn.Index`. This is what lets a report cross-reference `Turn.Provenance` and surface an
assertion that rested on a `Synthesized` turn — the same misdiagnosis the script-overrun guard
defends against at load time, caught at grading time for the runs the guard could not bound in
advance. An evaluator that examines turns and reports none defeats that silently.

- An **outcome-derived** assertion examines the turn the run *ended on*, because that is the turn
  that produced the outcome.
- A **scan** examines the matching turns, or — when nothing matched — every turn, because
  establishing absence required reading all of them.

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

### The deterministic caller

`DeterministicCaller` is the harness's **primary variance-reduction mechanism**. It replays
`scriptedStimuli` and — in `simulated` mode only — picks from `stimulusPool` by token overlap with
the system's last response. It never asks a model what to say next, so:

> **The only stochastic element in a run is the system under test.**

A persona-driven model standing in for the caller is itself a source of error, so a suite driven
by one measures the harness and the system together. This caller contributes none: re-running a
scenario changes the result only if the system changed. That makes it the right default for a
regression suite, and confines a model-driven caller to scenarios whose purpose is realism
testing.

**Two trade-offs worth knowing before you write a scenario:**

1. **A synthesized caller can only ever stay ON topic.** It answers out of the scenario's own
   material, so a whole class of bug — how the system copes with an irrelevant, adversarial, or
   abruptly changed subject — is not merely untested but *inexpressible* by pool selection.
   `scriptedStimuli` is the escape hatch: a line written there is replayed verbatim, however
   off-topic, and is tagged `Scripted`.
2. **Asserting on a turn after the script runs out measures the caller, not the system.** That is
   what the script-overrun guard defends at load time and what assertion turn-scoping defends at
   grading time. Both rely on this caller tagging provenance exactly, so turns
   `1..scriptedTurnBudget` are `Scripted` and anything past them is `Synthesized`.

What happens when the script runs out depends on the mode, and the difference is deliberate:

| Mode | Past the script | Why |
|---|---|---|
| `deterministic` | Signals completion | `stopOnParticipantCompletion` bounds the run to `scriptedTurnBudget`, and the loader approves otherwise-unscoped assertions on the strength of it. A caller that kept talking would make that approval false. |
| `simulated` | Falls through to `stimulusPool` | This is the mode the overrun guard deliberately does not police. |

Because position is derived from the transcript rather than from mutable internal state, **the
transcript is verified, not trusted**. Before selecting a turn the caller checks that the prefix
it claims authorship of is the prefix it would have produced — the script's text compared
ordinally, one-based turn indices, and `Scripted` provenance — and throws `ArgumentException` if
it is not. Without that check, a two-turn script handed a transcript whose opening came from
somewhere else would emit the *second* line, tag it `Scripted`, and complete, leaving the loader's
approval of unscoped assertions resting on a premise nothing established. It refuses rather than
completing because a corrupt transcript is a *harness* fault (`RunStatus.Error`), and completing
would be indistinguishable from a clean end-of-script — a graded verdict about the system drawn
from evidence its caller never produced. Turns past the scripted budget are deliberately not
checked: nothing derives scope from them.

Selection is stated rather than incidental, because a rule left implicit is a rule that drifts:
entries already sent are excluded so the caller cannot loop, **ties are resolved by pool order**,
a blank or absent response scores everything zero so the first unused entry is taken, and folding
is invariant so a run cannot grade differently on a build agent than on a developer's box. When
nothing is left the caller completes, and a REST scenario — an opening and nothing else — is the
degenerate one-turn case of exactly this path.

### The runners

`IScenarioRunner` is **the entire extent of kind-specific behaviour in the engine**. A runner
conducts exactly one execution and returns a `Transcript`; it does not decide how many repetitions
to run (the aggregator's job) and it does not grade (the evaluators').

`RestRunner` drives the same turn loop every runner drives. It asks the injected `IParticipant`
for a stimulus, sends it over an **injected typed `HttpClient`** — it constructs nothing, so the
composition root keeps control of handler lifetime — and repeats until the participant completes,
the system reaches a terminal outcome, `maxTurns` is hit, or the exchange fails. A REST scenario
takes one lap of that loop because its participant completes after the opening. **There is no
one-turn branch**: the moment the runner can tell, so can everything downstream.

A `Scenario` carries no URL, method, or payload shape, deliberately — it is the one record every
kind travels through, and HTTP's vocabulary entering it is how a "generic" engine quietly encodes
one transport's assumptions. That knowledge lives in `IRestExchange` instead, a two-method adapter
that builds a request from a stimulus and interprets a reply. **The library ships no default
implementation**, because a request shape and the extraction of an outcome, a route, and fields
from a body are entirely properties of the system being evaluated; a "default" would be one
system's JSON shape frozen into a generic library.

A completed participant always ends the loop, whatever `terminalCondition.stopOnParticipantCompletion`
says — with no stimulus there is nothing to send, and a runner that invented one would be measuring
itself. That flag governs whether completion is a *declared* terminal condition, which is what the
suite loader reads when it scopes an assertion.

#### Expected failure is outcome data, never an exception

A 429, a 4xx, a refusal, a body that will not parse — these are frequently the *point* of a
scenario, so they are recorded as structured transport attributes an `expectedBehavior` assertion
can pass on, rather than thrown. `TransportAttributes` names the keys once, so a suite file and a
later stage cannot drift apart on a magic string:

| `exchange` | Meaning | Harness failure? |
|---|---|---|
| `responded` | The system answered — 2xx, 4xx, and 5xx alike | no |
| `malformedResponse` | It answered and the adapter **reported** it could not read the body, by throwing `MalformedResponseException` | no — the *system* misbehaved |
| `adapterFailed` | The adapter threw something else, or returned nothing — it reached no verdict at all | yes — the *adapter* misbehaved |
| `timedOut` | The request did not complete in time | yes |
| `requestFailed` | The request never arrived | yes |
| `notAttempted` | The participant completed before offering a stimulus | yes |
| `unsupported` | This build cannot speak the declared transport | yes |

`ExchangeState.IsHarnessFailure` answers the only question a later stage needs — "is a verdict from
this run trustworthy?" — and **fails closed**: an absent or unrecognised state reports as a harness
failure, because reading "I do not know what happened" as "nothing went wrong" is the shape of
every false green this library guards against. `stoppedBy` answers the separate question of *why
the loop ended*, which on a healthy run is not derivable from `exchange`.

The `malformedResponse` / `adapterFailed` split is the same principle one layer down. An adapter
that rejects a body has judged the *system* and the run stays gradeable. An adapter that fell over
has judged nothing, so grading the run would let **a defective adapter manufacture a passing
assertion about a system it never successfully read**.

**The one failure that propagates is cancellation by the caller.** Returning a transcript for a run
the caller abandoned would hand the aggregator a result nobody waited for. A non-success status
ends the run instead of being interpreted — an error page is not the shape the adapter agreed to
parse, and driving a further turn against a system that has already refused would produce stimuli
that answer an error body, which measures the simulated caller rather than the system.

Reserved keys are written **last**, so an adapter may add to the record of what happened on the
wire but may not rewrite it.

#### A transcript describes the turn the run ended on

Run-level evidence — the outcome, the adapter's attributes, the observed status code — is reset at
the start of every turn rather than merged across them. Without that, a run whose first turn
succeeded and whose second returned a 500 would still carry the first turn's outcome, and
`exactMatch:path` would pass while attributing a success to the failed final turn. The same applies
to a key the final response omitted: it must not stay assertable from a response two turns back.

#### What reaches a committed artifact

A transcript is written to disk, diffed, and attached to pull requests, so the default is the
conservative one (§V):

- **The endpoint** has its userinfo, query, *and* fragment removed — a query string is where a
  bearer token or SAS signature usually lives, and an OAuth fragment carries an access token by
  design. A marker (`?[redacted]`) is left so a bare path is not mistaken for the real address.
- **Bodies nothing interpreted** — an error page, or one the adapter rejected — are *not* persisted.
  These never passed through the redaction an adapter applies to `RestResponse.Text`, which is
  exactly what made them the leak. `responseBodyLength` and `responseBodyHash` stand in: enough to
  tell two error bodies apart and to see one change, without committing the text.
- **Exception messages** are not persisted either. A message is authored by whatever threw it and
  routinely names the endpoint or connection string it failed on, so `failure` records what failed
  and the type that reported it.

`RestRunnerOptions { RetainUnredactedEvidence = true }` turns the first two back into verbatim
capture for a system with no real credentials — a local fake, a throwaway environment. The endpoint
stays redacted regardless.

#### `NotImplementedMcpRunner`, and why "unsupported" is not a new `RunStatus`

Real MCP transport is out of scope. A stub is still registered so that routing stays uniform —
every kind has a runner, every runner returns a transcript, and one unsupported scenario cannot
take down a mixed suite. It reports `exchange=unsupported` with a reason, observes nothing, never
consults the participant, and does not throw.

That signal is deliberately **not** a new `RunStatus` member:

- `RunStatus` is a *grading verdict*; "this build cannot speak MCP" is a *capability* fact. A new
  member would oblige aggregation, comparison, reporting, and the statistics each to grow a
  branch — the `IScenarioRunner` rule that adding a kind must not require a change anywhere else,
  violated for a gap instead of for a kind.
- It is an enum serialized into the committed artifact, so every existing reader would meet a
  member it does not know. That is a schema decision, not a runner's.
- `RunStatus.Error` already fits. A transport the harness cannot speak *is* a harness failure;
  what makes it feel different is that it is known rather than surprising, and "known" is what
  `RunResult.ErrorDetail` is for. The status answers "can a verdict from this run be trusted?" —
  no, either way — and the detail answers "why not".
- A distinct status would be a false-green vector: any consumer treating "not `Fail`" as "no
  regression" would report a suite of entirely unsupported scenarios as clean.

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

**`partial` — contracts, assertion evaluation, the deterministic caller, and the REST runner.**
Types, seams, the suite loader with validation, canonical serialization, the five assertion
evaluators behind `AssertionEvaluatorRegistry`, `DeterministicCaller`, and `RestRunner` are
complete and tested. Deliberately **not** here yet:

- No real MCP or LLM runner. `NotImplementedMcpRunner` reports the MCP gap cleanly so a mixed
  suite still routes; the LLM runner is T7.
- No `IRestExchange` implementation — by design, not by omission. A request shape is a property of
  the system under test, so the composition root supplies one.
- No LLM-driven participant — T7. That one exists for realism testing; the deterministic caller
  stays the default for regression suites.
- No repetition/aggregation loop — T9. `RestRunner` conducts a single execution;
  `Execution.RepetitionPolicy` is read by the aggregator, not by the runner.
- No mapping from a transcript to `RunStatus`. `ExchangeState.IsHarnessFailure` is the input that
  mapping will use; the mapping itself lands with the aggregator.
- No statistics implementations — `ISignificanceTest` and `IMultipleComparisonCorrection` have no
  implementations, and `StatisticalSummary.Interval` / `.Comparison` are never populated — T9.
- No baseline **comparator** — T10. `baseline:*` assertions grade against the transcript handed to
  them through `EvaluationContext.Baseline`; resolving a baseline reference remains
  `IBaselineProvider`'s job and has no implementation.
- No reporter, no CLI wiring.

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

Grading a transcript goes through the registry, which dispatches by category:

```csharp
var registry = AssertionEvaluatorRegistry.CreateDefault();
var context = new EvaluationContext
{
    ScenarioId = scenario.Identity.Id,
    Grading = scenario.Grading,
    Transcript = transcript,
    Baseline = baselineTranscript, // null when there is none
};

foreach (var assertion in scenario.Grading.Assertions)
{
    // Throws AssertionEvaluationException when the assertion cannot be evaluated at all —
    // record the run as RunStatus.Error rather than letting it read as a pass or a regression.
    var result = await registry.EvaluateAsync(assertion, context, cancellationToken);
}
```

## Build and test

```powershell
dotnet build libs/EvalEngine/src/Forge.EvalEngine.csproj
dotnet test libs/EvalEngine/tests/Forge.EvalEngine.Tests.csproj
```
