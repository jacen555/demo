# EvalEngine

> **Kind:** `lib` · **Tier:** 1 · **Registry id:** `eval-engine`

## What this is

A generic evaluation harness for running a suite of scenarios against a system under test and
producing a durable, diff-able artifact of what happened. It handles four kinds of scenario in
one suite — REST calls, MCP tool invocations, multi-turn LLM conversations, and scripted UI
interaction — and its purpose is **before/after comparison for pull requests**: attaching
evidence that shows regressions *and* newly-covered scenarios.

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

## What is here today (T3 contracts + T4 assertion evaluators + T5 deterministic caller + T6 runners + T7 conversation runner + T8 run coordinator + T9 statistics + T10 comparator + T11 impacted selection)

| Area | Types |
|---|---|
| Scenario model | `Scenario` composed of `ScenarioIdentity`, `Execution`, `Simulation`, `Grading`, `Selection`, `Slicing` |
| Transcript model | `Transcript`, `Turn`, `TurnProvenance`, `Outcome`, `TransportMetadata` |
| Transport vocabulary | `TransportAttributes`, `ExchangeState`, `StopReason` |
| Assertions | `AssertionSpec` (parsed from `category:parameter`), `AssertionResult`, `AssertionCategory` |
| Assertion evaluation | `AssertionEvaluatorRegistry`, `AssertionEvaluationException`, and one internal evaluator per category |
| Participants | `DeterministicCaller` — the simulated caller that adds no variance of its own; `LlmCaller` — the model-driven one, for realism testing |
| Runners | `RestRunner`, `LlmConversationRunner`, `NotImplementedMcpRunner`, `NotImplementedUiRunner`, and the `IRestExchange` / `IConversationExchange` adapter seams |
| Coordination | `RunCoordinator`, `RunCoordinatorOptions` — routing, repetition, throttling, grading, and the artifact |
| LLM access | `ILlmClient` / `LlmRequest`, and `RecordedLlmClient` — replay by request content, so a model-driven run is reproducible |
| Results | `RunResult`, `ScenarioResult`, `SuiteResult`, `StatisticalSummary` |
| Seams | `IScenarioRunner`, `IParticipant` / `IModeBoundParticipant`, `IParticipantFactory`, `IAssertionEvaluator`, `ISignificanceTest`, `IMultipleComparisonCorrection`, `IBaselineProvider`, `ILlmClient` |
| Statistics inputs | `PairedObservation`, `PairedObservations` |
| Statistics | `ScenarioAggregator`, `ProportionInterval` (Wilson, Agresti-Coull), `McNemarTest`, `PairedBootstrapTest`, `BenjaminiHochbergCorrection` |
| Comparison | `SuiteComparator`, `ComparisonResult`, `ScenarioComparison`, `ScenarioClassification`, `ScenarioOutcome`, `ComparisonRefusedException` |
| Selection | `ImpactSelector`, `SelectionResult`, `ScenarioSelection`, `SelectionReason` — which scenarios a change needs to run, and why |
| Baselines | `ArtifactBaseline` (committed file), `LiveEndpointBaseline` (deployed system) |
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
  One implementation does this for every runner, including the one whose address is stated by an
  adapter rather than resolved from a request.
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

#### The not-implemented stubs, and why "unsupported" is not a new `RunStatus`

Real MCP transport and real UI driving are both out of scope. A stub is still registered for each
— `NotImplementedMcpRunner` and `NotImplementedUiRunner` — so that routing stays uniform: every
kind has a runner, every runner returns a transcript, and one unsupported scenario cannot take
down a mixed suite. Each reports `exchange=unsupported` with a reason, observes nothing, never
consults the participant, and does not throw. They are classified through the same
`ExchangeState.IsHarnessFailure` path, so the two are indistinguishable downstream apart from the
transport they name.

`ScenarioKind.Ui` exists now rather than alongside its runner because it needs **no new transcript
shape**: a UI turn's stimulus is an *action* — click this, fill that — and its response is the
page state the action produced, which is structurally the same `Turn` a request and a reply are.
Admitting the kind early is what lets a mixed suite route today and lets a real runner be
registered later without reshaping anything. Driving a real UI deterministically is achievable and
needs three determinism controls applied together; none of that is built here, because a seam
built ahead of its implementation is speculation.

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

### The conversation runner, and who owns termination

`LlmConversationRunner` drives the same loop `RestRunner` drives, over a transport that is not
HTTP's: `IConversationExchange`, a single async call the composition root implements. It is a
separate seam from `IRestExchange` because a conversational system is not necessarily an HTTP one
— reaching for `HttpClient` there would bake HTTP into the `llm` kind, which is the same mistake
as putting a URL on `Scenario`.

**The one thing this runner has that the REST runner does not is a cap, and it is not optional.**

> The turn cap belongs to the harness, never to the participant.

A REST scenario ends because its participant runs out of script. A model-driven conversation has
no such floor, and the component best placed to judge when it has finished is the simulated caller
— whose faithfulness is the very thing under question. Handing it termination would let the least
trustworthy component in the loop decide how much evidence gets gathered. So:

- `LlmConversationRunnerOptions.MaxTurnCeiling` (default 12) bounds **every** run.
- `terminalCondition.maxTurns` may only **narrow** it. The effective cap is the lower of the two,
  and a scenario declaring more gets the runner's figure. `EffectiveTurnCap` states the rule as a
  pure function so an author can see the number their scenario will actually be held to.
- This closes the gap behind the loader's `scenario.terminalCondition.unbounded` warning. A
  warning cannot stop a suite that ships with it unresolved from running indefinitely against a
  metered provider; a cap can.

A participant may still stop *early* by completing — that direction is safe, since with no
stimulus there is nothing to send.

One new failure state joins the transport vocabulary. `participantFailed` means the simulated
caller could not say what comes next: its model call failed, the replaying client held no
recording, the model returned nothing usable, or a provider call timed out while the run's own
token was untouched. That is a statement about the **harness**, so
`ExchangeState.IsHarnessFailure` reports it as ungradeable — a conversation cut short by the
*caller* must never read as the system declining to continue. The turns already recorded stand,
because they happened. Only cancellation by the *caller of the run* propagates; one participant's
timeout records one ungradeable run rather than taking down the suite.

The adapter supplies `transport.kind` here, which the REST runner hard-codes. That is a new route
into the transcript, so the runner refuses a value that is blank or that names a `ScenarioKind`:
an adapter writing `llm` would put a scenario kind into the one artifact every downstream stage is
supposed to be blind to. An LLM-backed system reached over HTTP is `http`, exactly as `RestRunner`
records it.

The adapter also supplies `transport.endpoint`, and that value is **sanitized rather than trusted**
— the same rule `RestRunner` applies to the address it resolves itself, from the same
implementation, because a redaction that is right in one runner and forgotten in another is how a
credential reaches a committed artifact. An address that does not parse into components cannot be
taken apart that way, so it is redacted whole when it carries `@`, `?`, or `#`.

#### The participant must match the scenario

> A guard that rests on a premise nothing establishes is not a guard.

A participant is constructed independently of the scenario it ends up driving, so until the runner
compares them, nothing does. That gap is the script-overrun guard's premise, unverified: a
`deterministic` scenario is approved at load time as *bounded by its script*, and driving it with a
model-backed caller leaves every otherwise-unscoped assertion grading turns the script never drove.
Two checks close it:

- **Up front**, a participant that declares its mode through `IModeBoundParticipant` — both callers
  in this library do — is refused when that mode is not the scenario's. Mis-wiring affects every
  run of the scenario rather than one run, so it is thrown, exactly as a mis-routed `kind` is.
- **Per turn**, under `deterministic` execution only, the stimulus a participant offers inside the
  scripted window is compared against the suite file before it reaches the system under test —
  ordinally, with its one-based index and `Scripted` provenance. Past the budget there is no
  scripted material left to have been replayed, so a turn still claiming `Scripted` is refused too.
  A divergence records `participantFailed`: the run is ungradeable rather than graded against a
  premise nothing established.

### The model-driven caller

`LlmCaller` is the counterpart to `DeterministicCaller`, and the opposite trade: realistic
unscripted turns, at the cost of **being itself a source of error**. A suite driven by it measures
the harness and the system together, so it belongs in realism testing — the deterministic caller
stays the default for regression suites. Between them the two callers cover all three execution
modes and neither can produce a provenance it would be lying about:

| Caller | Modes it serves | Refuses |
|---|---|---|
| `DeterministicCaller` | `deterministic` → `Scripted`, `simulated` → `Synthesized` | `live` |
| `LlmCaller` | `simulated` — the opening → `Scripted`, everything it generates → `Synthesized` | `deterministic`, `live` |

**`LlmCaller` can never tag a turn it generated `Scripted`**, and that is the point rather than an
implementation detail: the script-overrun guard approves otherwise-unscoped assertions on the
premise that a `Scripted` turn was replayed verbatim from the suite file. A model-generated turn
wearing that tag would make the approval a fiction and let an assertion measure the caller while
its author believed it measured the system.

**It can never emit `Live` either, and so it refuses `live` execution outright.** Both that mode
and that provenance mean *a real external caller, or a recording of one*. A model asked what to
say next is neither, whatever mode the runner was handed, so there is no symmetry with
`DeterministicCaller` to preserve here: that caller refuses one mode because it cannot replay live
material, and this one refuses two because it can neither replay a script nor be a real caller.
`LlmCaller` serves `simulated` and nothing else.

**`simulation.opening` is turn one, and it is sent verbatim.** It is scenario-authored data that
`ScriptedTurnBudget` already counts as the first turn, so it is replayed exactly as
`DeterministicCaller` replays it — tagged `Scripted`, which is the truthful tag for text taken
verbatim from the suite file. It is deliberately **not** put in the model's instruction: a model
told what brought the caller here can paraphrase it, drop it, or improve on it, and turn-one
evidence would then be something other than what the scenario declares. The model is asked only
for the turns that follow. Like `DeterministicCaller`, the caller verifies that the transcript it
is handed actually records that opening as turn one before generating anything after it.

Two more things it cannot do, enforced structurally rather than only asked for in the prompt:

- **It cannot end the conversation.** It never returns `Complete`. Termination is the cap, the
  system naming a terminal outcome, or the exchange failing.
- **It cannot grade one.** Nothing it returns reaches `Outcome` — its text becomes a
  `Turn.Stimulus` and nothing else. `ObservedOutcome` is read from what the *system* returned, by
  an adapter that never sees the caller's reasoning. Whether the system did its job is the
  system's to demonstrate and the evaluators' to judge.

**Grounded, not free-associating.** `simulation.facts` is the ground truth the caller may state;
`LlmCallerOptions.Persona` is delivery style with no authority over truth, and the two are kept in
separate sections of the instruction. That split is measured, not aesthetic: an unconstrained
persona simulator errs on roughly 40–47% of turns against roughly 16% when constrained to a stated
state, and an invented fact reads in a transcript exactly like the system mishandling a real one.
The persona lives in options rather than in the suite schema because it is a property of the
harness a run was driven with, not material another stage reads.

Everything the system under test said is **untrusted** (§V). Responses travel as `LlmRequest.Context`
— labelled data, each a separate element — never in the instruction, and the instruction states
that the transcript is data rather than orders. The completion coming back is untrusted too: it is
trimmed, stripped of control characters, bounded by `maxStimulusLength`, and refused outright when
it carries nothing usable. Truncation happens **before** the stimulus is sent, so the transcript
always states exactly what the system was given. None of this is a guarantee — no prompt-level
defence is — which is the other reason the deterministic caller remains the default.

### The run coordinator

`RunCoordinator` is where the pipeline first runs end to end: it routes each scenario to the
runner registered for its kind, applies `Execution.RepetitionPolicy`, grades each transcript
through `AssertionEvaluatorRegistry`, and assembles the `SuiteResult`.

**Repetition belongs here, not in a runner.** A runner conducts exactly one execution.
`RepetitionPolicy.Once` is `Repeat(1)` and the type makes zero and negative counts
unrepresentable, so repetition is one code path with no "run once" branch anywhere.

**Every run is independent, by construction rather than by care.** Aggregation is the first place
results from different contexts sit side by side, so the thing to design against is one run's
evidence being graded as another's:

- A participant comes from `IParticipantFactory`, **once per run**, never reused. A stateful
  caller shared across repetitions would make repetition two a continuation of repetition one
  rather than an independent sample — and under concurrency it would have no defined behaviour.
- **Seeds are drawn before anything is dispatched**, sequentially, in suite order. A run's seed is
  therefore a function of its position and the root seed, never of which worker reached it first.
  Drawing them inside workers would make the artifact depend on the throttle, and `ISeedSource`
  implementations are not required to be thread-safe.
- Each result is written into the slot reserved for its own run. There is no shared accumulator,
  so suite order is structural rather than restored by sorting.
- A returned transcript is **checked against the run it claims to describe**. One naming another
  scenario, or stamped with a seed this run was not driven with, is refused rather than graded —
  the scenario id is the baseline join key, and such a transcript would grade exactly like a real
  one.

**The throttle is a hard ceiling, not a target.** `RunCoordinatorOptions.MaxConcurrency` bounds
in-flight runs across the whole suite, defaulting to **one** — concurrency against a system
somebody else operates is opted into, not inherited. It is also the lever for deliberately
exercising that system's own throttling, so it has to be honest; the count is recorded in
`EvaluationEnvironment.HarnessConfig`.

**What the harness failed to do is never graded.** A run whose exchange
`ExchangeState.IsHarnessFailure` classifies as a harness failure becomes `RunStatus.Error` and its
assertions are **not evaluated at all** — recording green verdicts beside a run that asked nothing
is how a suite of unsupported scenarios comes to read as clean. An `AssertionEvaluationException`
is `Error` too, keeping T4's refusal-versus-failure line.

**One broken runner does not take down a mixed suite.** A runner that throws, returns nothing, or
was never registered for a kind yields a recorded error carrying an ungradeable transcript
(`exchange=runnerFailed`) for the runs it affected. The blast radius of a misconfiguration must
not depend on where in the suite it sat. The one failure that propagates is **cancellation**:
scheduling stops promptly, in-flight runs see the token, and `RunAsync` throws rather than
returning a partial artifact that would read as a complete one.

Exception **messages** never reach the artifact — they are authored elsewhere and routinely name
an endpoint or a connection string — so a failure is recorded by what failed and the type that
reported it. `RunCoordinatorOptions.Endpoint` is stripped by the same single implementation every
runner uses.

### Reproducibility without a provider

`RecordedLlmClient` replays recorded completions **keyed by request content**, and that mechanism
is the delivery. Real provider wiring is deliberately out of scope: no keys, no HTTP to a
provider.

> Determinism here comes from content addressing, not from sampling parameters.

`LlmRequest.Seed` and `LlmRequest.Temperature` are excluded from a request's identity on purpose.
A seed is a best-effort provider hint rather than a reproducibility guarantee — bitwise
determinism is unattainable on GPU inference even at temperature zero — and providers are actively
withdrawing the sampling parameters from newer models. A fake keyed on them would be reproducible
only while the provider co-operated, and would start missing recordings the day a caller varied a
seed for reasons unrelated to what it was asking. Both parameters stay on the seam as **optional
capability**, so a caller with a provider that honours them can pass them through; nothing in the
library treats either as a correctness precondition.

The key length-prefixes every part, so there is no separator to inject and no prompt can be
written to collide with a different prompt-plus-context.

An unmatched request throws `MissingRecordingException` rather than returning a fallback. A
replaying client that guessed would let a test keep passing while exercising nothing, and the
transcript would look exactly like a real run — so it fails loud, the runner records
`participantFailed`, and the run is not gradeable.

### Canonical artifacts`SuiteResult` is the durable, committable output. `CanonicalJson` writes it with **object keys
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

### Statistics: decided, and now computed

`StatisticalSummary` carried its full shape from T3 so the artifact schema would not change when
the statistics landed. It has not. The methods were settled in advance and are recorded in the
XML docs so they are not relitigated:

- **Wilson or Agresti-Coull** intervals. Never normal/Wald — it misbehaves at small n and at
  extreme proportions, which is exactly where an eval suite lives. `ProportionInterval` implements
  both; `ScenarioAggregator` defaults to Wilson at 95%.
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

**Every expected value in the statistics tests comes from outside this library** — Newcombe's
1998 comparison table for the Wilson intervals, the published chi-squared critical points, the
worked McNemar tables, the Benjamini-Hochberg 1995 example and its stated four discoveries, and
exact binomial fractions a reader can redo by hand. A test asserting that a Wilson interval
matches what the Wilson code computes would prove nothing; a wrong interval does not crash, it
produces a confident wrong verdict, which is why the boundaries (n = 1, p = 0, p = 1, zero
discordant pairs, a single scenario) are each pinned explicitly.

#### The aggregator, and what an error does to the estimate

`ScenarioAggregator` collapses a scenario's repetitions into `n`, a pass-rate `pointEstimate`,
a `dispersion` (the population standard deviation `sqrt(p(1-p))`, which is the figure T3 already
committed to the artifact and which stays defined at a single repetition), and an `interval`.
Repetition is one code path: `RepetitionPolicy.Once` is `Repeat(1)`, so a one-run REST scenario
and a twenty-run model scenario travel the same route.

**An ungradeable run is not evidence the system failed.** A `RunStatus.Error` run never produced
a verdict — the transport fell over, the participant could not be built, an assertion could not
be evaluated — so counting it as a failure would manufacture a regression out of a harness fault
and counting it as a pass would manufacture a green. It is excluded from both the denominator and
the estimate. The consequence is visible rather than hidden: `n` falls, the interval widens to
match the thinner evidence, and the errored runs stay in `ScenarioResult.Runs` with their
`errorDetail`, already logged once by the coordinator. A scenario whose runs *all* errored has no
pass rate at all, so `Summary` is left unset rather than filled with a zero nobody measured.
`ExpectedFailure` is different: it ran and it did not pass, so it counts as a graded non-pass.

An interval means nothing without the confidence level it was computed at, and
`ConfidenceInterval` has nowhere to carry one. The coordinator records `intervalMethod` and
`intervalConfidence` in `EvaluationEnvironment.HarnessConfig` beside `maxConcurrency` instead —
the artifact schema did not have to change for it.

#### Edge cases that would otherwise be silent

- **No discordant pairs.** McNemar's statistic is `0 / 0`. `McNemarTest` reports
  `notComputed` with no p-value rather than letting a NaN reach a merge decision.
- **Few discordant pairs.** Below 25 the chi-squared approximation is untrustworthy, so the
  exact conditional binomial test is used.
- **A perfectly balanced table.** Edwards' continuity correction subtracts one before squaring,
  so an uncorrected implementation reports a *positive* statistic when the null holds exactly.
  The corrected difference is floored at zero.
- **A single scenario in a bootstrap.** Every resample is that same scenario, so the naive
  formula reports `1 / (B + 1)` — an overwhelming result manufactured from one observation.
  `PairedBootstrapTest` refuses below two scenarios. Its p-value is also floored at `1 / (B + 1)`
  by construction, and it says so rather than claiming a precision it never computed.
- **Bootstrap determinism.** The seed is injected and stamped on `PairedBootstrapTest.Seed`;
  the generator is the same SplitMix64 as `DeterministicSeedSource`. There is no ambient
  randomness anywhere in this library.

What is still not computed: `ComparisonSummary` is only produced by the significance tests when a
caller supplies paired observations. `RunCoordinator` has no baseline to build them from, so
`ScenarioResult.Summary.Comparison` stays unset — the comparison is produced by
`SuiteComparator` from two artifacts rather than stamped into one of them.

## Comparison (T10)

`SuiteComparator` diffs two `SuiteResult`s into a `ComparisonResult`. It is **source-agnostic**:
it neither knows nor cares whether an artifact came from a committed file or from a run against a
deployed baseline, which is what lets `ArtifactBaseline` and `LiveEndpointBaseline` share it.

### `newlyCovered` is the headline

Each scenario is classified `fixed` · `regressed` · `stablePass` · `stableFail` · `new` ·
`removed` · `notComparable`, and `ComparisonResult.NewlyCovered` is `fixed` plus `new`-and-passing.
A harness that only reports what broke is a worse version of a test suite; the reason to run a
suite against two variants is to show what a change **fixed**. A new scenario that fails, and a
new scenario that produced no gradeable evidence, are both excluded — neither is coverage gained.

Classification never depends on the statistics. It is a factual statement about what the two
artifacts recorded, and it is produced whether or not a significance test was supplied.

### The pairing is verified, not assumed

A scenario id is a join key, and a join key is only worth what the claim that both sides mean the
same thing by it is worth. Two artifacts can agree on every id and still describe different work.
**Two artifacts are comparable when they agree on** the suite name, the root seed, and every entry
of `EvaluationEnvironment.HarnessConfig`; anything else throws `ComparisonRefusedException`, which
names the property that diverged. `Endpoint`, `BaselineRef`, and `Timestamp` are deliberately not
compared — two variants at two addresses at two times is the case this stage exists for.

**Two scenarios are comparable when they agree on** the kind, the **definition fingerprint** of
what each was run from, the repetition policy used, the runs actually recorded under it, the set
of assertions they were graded against, the seed of every repetition pairwise and in order, and
both having produced at least one gradeable paired run. A scenario failing any of those is
reported as `notComparable` with a stated reason, logged once, and excluded from `newlyCovered`
and from the observations handed to the significance test — but it does not veto the rest of the
suite.

The seed check is the load-bearing one. `PairedObservation.Seed` exists precisely so a reader can
confirm two runs were driven identically; comparing repetitions driven from different seeds
attributes seed variation to the change under review.

#### The definition fingerprint, and why the assertion specs are not enough

`ScenarioFingerprint.Of` hashes a scenario's **execution inputs** (`Execution`, `Simulation`) and
its **grading expectations** (`Grading`) into a `sha256:…` value that `RunCoordinator` stamps onto
`ScenarioResult.DefinitionFingerprint`.

This exists because an assertion spec names *what* is checked, never the value it is checked
**against**. Keep `exactMatch:outcome`, edit `grading.expectedOutcome`, and an unchanged system
response turns from a failure into a pass — the emitted specs are byte-identical on both sides, so
a comparator that pairs on them alone reports `fixed` and puts the scenario in `newlyCovered`.
That is the headline output of the harness fabricated by editing the expectation rather than
changing the system. A differing fingerprint is `notComparable`, and so is a **missing** one:
absent is not the same as matching, and an artifact that never said what it was run against cannot
establish that both sides were run against the same thing.

The field is optional and does not bump `SchemaVersions.SuiteResult` — an additive field that
serializes as absent does not, per the version policy — because an artifact written before it
existed is still readable and is refused for comparison rather than mis-compared.

**`Identity.Kind` is deliberately *not* in the fingerprint, and every consumer owes it a second
comparison.** The kind selects the runner, so a scenario switched from `rest` to `llm` is driven
against a different system by different code — while carrying a byte-identical fingerprint, since
the digest covers `Execution`, `Simulation`, and `Grading` and the kind lives in `Identity`. It is
checked directly instead, because `ScenarioResult.Kind` is a **required** field on every artifact
where `DefinitionFingerprint` is optional: comparing it is both stronger than a digest and
readable on artifacts written before fingerprinting existed, and folding it in would sever every
comparison against every artifact already written for a check those artifacts can already answer.
`SuiteComparator` and `ImpactSelector` both make that comparison beside the fingerprint; anything
else that pairs two scenarios on one must do the same.

#### Outcomes come from every graded run, and a transition has to be paired

What an artifact says about a scenario is a statement about **that artifact's own runs**, so it
counts all of them. Deriving it from only the mutually gradeable repetitions discards graded
evidence that contradicts the verdict: baseline `[Fail, Error]` against candidate `[Pass, Fail]`
would report `fixed` with `candidateOutcome: passed` while the candidate's graded failure sat in
plain sight. It is `stableFail`.

Symmetrically, a `fixed` or `regressed` that **no repetition pair demonstrates** is
`notComparable`. Baseline `[Fail, Pass]` against candidate `[Error, Pass]` has every graded
candidate run passing and a graded baseline run failing, but the only evidence for the transition
would be one variant's repetition read against the other's — which is not a matched pair. The
stable classifications need no pair: they assert that nothing changed.

`SuiteResult.SchemaVersion` is deliberately **not** among these checks. It is stamped rather than
settable, so two instances cannot disagree on it — the guard that matters lives where an artifact
is *read*, in `CanonicalJson.DeserializeSuiteResult`, which `ArtifactBaseline` goes through. A
check here could never fail, and a check that cannot fail reads like protection that is not there.

### The evidence is the runs, not the reported summary

Classification and effect size are derived from `ScenarioResult.Runs`, not from
`ScenarioResult.Summary`. A committed baseline is untrusted input (§V) and a summary is a derived
claim about the runs, so a hand-edited point estimate cannot manufacture a fix or hide a
regression. An undeclared `RunStatus` is refused rather than graded, exactly as
`ScenarioAggregator` refuses one.

Reading the runs only helps if the runs themselves are coherent, so each artifact is checked
before either is indexed:

- **A run's transcript must name its enclosing scenario.** Otherwise one scenario's evidence is
  filed, and graded, under another's id — the same misattribution `RunCoordinator` refuses at
  dispatch, reaching the comparator through a file instead of a runner.
- **A `pass` must not sit beside a failed assertion verdict.** The verdicts are the evidence and
  the status is a claim about them, so a run that contradicts itself cannot establish coverage.
- **Repetition seeds must be distinct within a scenario.** A run is identified by its scenario and
  its seed. Six repetitions from one seed are one observation recorded six times; paired against
  six of the other verdict they read as six discordant pairs and return an exact p-value of
  0.03125 — a significant finding manufactured from a single run. `RunCoordinator` establishes
  this at plan time for artifacts it produces; the comparator establishes it for artifacts it did
  not.

### Two statistical levels, and why only one goes through the seam

- **Suite-wide**, through the injected `ISignificanceTest`: one `PairedObservation` per comparable
  scenario, which is exactly the cross-scenario shape `PairedObservations` was built for. It
  carries no adjusted p-value, because one test is not a family.
- **Per scenario**, from the exact conditional test on that scenario's discordant repetitions.
  This does **not** go through `ISignificanceTest`: `PairedObservations` admits exactly one pair
  per scenario, deliberately, so a family drawn from one scenario's repetitions is not expressible
  through it — and synthesizing a composite identifier to get around that would be the precise
  cross-context misattribution this stage exists to prevent. The arithmetic is `McNemarTest`'s own
  exact branch (`SignTest`), not a second implementation. The exact test is used at every count
  rather than only below `McNemarTest.ExactThreshold`, because a repetition count is small by
  nature and the exact conditional test is valid at every size.

`BenjaminiHochbergCorrection` is then applied across that per-scenario family, and each verdict is
judged on the **adjusted** value — judging the raw one would make the correction decorative. Only
scenarios that actually produced a p-value form the family: counting the ones that reported
`notComputed` would inflate its size and weaken every real finding in it.

#### Edge cases that would otherwise be silent

- **No discordant repetitions.** The statistic is `0 / 0`, so the p-value is withheld and the
  verdict is `notComputed`. The effect size, which really is zero, is still stated.
- **A single discordant repetition.** The exact test reports `p = 1.0`: one flip is no evidence at
  all. The classification still says `fixed` or `regressed`, because that is what happened — the
  two answer different questions.
- **A repetition that errored under either variant.** It produced no verdict about the change, so
  it is conditioned out of the pair count rather than counted as a failure. `GradedPairs` reports
  what survived, and both pass rates are drawn from the same repetitions so the delta stays a
  paired quantity.
- **Non-binary pass rates with McNemar.** A scenario passing three of four repetitions has a
  statistic of 0.75, and `McNemarTest` refuses it rather than returning a number that does not
  mean what it says. The comparator propagates that refusal instead of binarising. Use
  `PairedBootstrapTest`, which is why `PairedObservation` carries a `double`.
- **Nothing comparable at all.** The suite delta is `null` and the fact is logged, rather than a
  zero standing in for a figure nobody computed.

### Baseline providers

Both implement `IBaselineProvider` and both yield a `SuiteResult`, so one comparator serves both.

- **`ArtifactBaseline`** reads a committed artifact from a confined root, for evaluations with
  nothing to deploy. The reference is untrusted: it is refused on the text alone if it reads
  outside the root, then resolved through `RealPath` — following links at every segment, with the
  boundary handed in — and checked again. That is the same pair of checks, through the same
  implementation, that `SuiteLoader` applies, because a containment rule implemented twice is a
  containment rule that will eventually disagree with itself. Oversized artifacts are refused
  against the file length **before** anything is allocated. Existence is asked through
  `File.GetAttributes` rather than `FileInfo.Exists`, which answers "is there a readable file
  here" and returns `false` for three different reasons — absent, a directory, or metadata that
  could not be inspected. Only the first is "no baseline".
- **`LiveEndpointBaseline`** runs the suite against a baseline endpoint, for a deployed system. It
  takes a `Func<Uri, RunCoordinator>`, because a coordinator is built around runners already bound
  to a transport and re-pointing one is not possible — which is correct, since that is a
  composition-root decision. Only absolute `http`/`https` references are dialled, and a reference
  carrying userinfo is refused outright rather than stripped: a credential in a reference ends up
  wherever the reference is recorded.

#### Redaction and verification pull against each other

`LiveEndpointBaseline` has to prove the artifact it got back describes the system that was asked
for, and everything it could prove that from is redacted on the way into the artifact. The query
and fragment of every recorded address are replaced by a fixed marker, because that is where a
bearer token, a SAS signature, or an OAuth access token lives — so `?deployment=old` and
`?deployment=new` are the *same recorded text*, and a check over that text would pair two
different deployments with confidence.

Resolved deliberately, in the direction that keeps the credential out:

- **A reference carrying a query or a fragment is refused.** The part of an address that cannot
  survive redaction is not admitted at all; select the deployment by path, or from the composition
  root. Nothing is persisted to make it verifiable.
- **The runs are checked, not just the label.** `EvaluationEnvironment.Endpoint` is copied from
  `RunCoordinatorOptions.Endpoint` — a label the composition root supplied, not evidence of where
  a request went. Each run's recorded transport address is compared on scheme, host, port, and
  path: everything that survives redaction. A run that recorded `null` is skipped, because
  `IConversationExchange.Endpoint` documents that as "no address to report" and refusing those
  would refuse honest runners rather than miswired ones. A run that recorded something which is
  **not** an address is refused — that is a positive claim about a destination which cannot be
  reconciled with the one asked for, and admitting an unverifiable claim is the false green this
  check exists to prevent. The deliberate consequence: an adapter that names a model deployment
  rather than an address cannot sit behind a baseline requested by URL. So this catches a runner
  that says where it went and went elsewhere; it cannot catch one that says nothing, which is why
  the endpoint label check is kept alongside it rather than replaced by it.

**Only a genuinely absent artifact yields `null`.** A reference naming a directory, one whose
metadata cannot be inspected, and a file that exists but cannot be read, is too large, is
malformed, or declares an unreadable schema version all throw — and `LiveEndpointBaseline` never
returns `null` at all. Returning `null` for any of those would tell the caller there is no
baseline, the caller would report "no regression", and the reason would be that nothing was ever
compared.

## Impacted selection (T11)

`ImpactSelector.Select(suite, changedFiles, baseline)` answers one question: **which scenarios
does this change actually need to run?** It is a **pure function** — no git, no file system, no
clock. The CLI acquires the changed-file set and hands it in, which keeps diff parsing out of a
Tier 1 library and makes every rule below testable against a literal list of strings.

### The asymmetry that drives every judgement here

**Over-selecting costs time. Under-selecting costs correctness — invisibly.** A scenario that
should have run and did not produces no output at all: no wrong number in the report, no missing
assertion, just a smaller run and a green result. Research found that classical test-impact
analysis does not transfer cleanly to multi-service eval topologies, so this falls back to the
whole suite far more readily than such tooling normally does. **Selection must never be the
reason a regression goes unobserved.**

### Glob syntax — and what is deliberately refused

| Supported | Meaning |
|---|---|
| `*` | zero or more characters **within one segment** — never across `/` |
| `?` | exactly one character within one segment (not the DOS "zero or one") |
| `**` | zero or more whole segments; must stand alone as a complete segment |
| `/` or `\` | separator; a leading `./` and interior `.` segments are dropped |

Everything else is **refused rather than reinterpreted**: character classes (`[a-z]`), brace
alternation (`{a,b}`), gitignore negation (a leading `!`), `..` segments, absolute or
drive-qualified patterns, and `**` embedded in a larger segment (`**.cs`, `a**b`). Every one of
those is a construct a suite author might reasonably expect to work, and every matcher in the BCL
would treat them as *literal text* — matching nothing, selecting nothing, saying nothing. A
refused pattern selects its scenario under `noGlobsDeclared` and names itself in the report, which
turns a silent mismatch into a loud over-selection. A lone `]` or `}` is an ordinary filename
character; only the openers introduce an unsupported construct.

**A pattern naming a directory covers what is under it.** `libs/EvalEngine` matches
`libs/EvalEngine/src/Foo.cs`, as though it ended in `/**` — matching it literally would silently
drop every file in the tree the author named. The prefix is a **segment** prefix, never a string
prefix: `libs/EvalEngine` does not match `libs/EvalEngineOther/src/Foo.cs`.

### Normalization and case

Changed-file sets arrive however their producer emits them, so both sides are reduced to one
canonical form first: **repo-relative, `/`-separated, no empty segment, no `.` segment, every
`..` resolved lexically**. `src\deep\..\a.cs`, `./src/a.cs`, and `src//a.cs` all become
`src/a.cs`.

**Matching is case-insensitive on every platform, deliberately.** Following the host file system
instead would make one suite and one changed-file set select *different scenarios* depending on
where the run happened — and the case-sensitive platform is the one that silently drops them. The
cost is that two files differing only in case are treated as one on Linux, which over-selects.
That is the cheap direction.

A path that cannot be made repo-relative — blank, absolute, drive-qualified, or traversing above
the root (§V: this is untrusted input) — is **refused**, and the refusal selects the whole suite.
Dropping it quietly would be cheaper and is exactly the bug this layer exists to prevent: whatever
that path mapped to would simply not run. Interior traversal that stays inside the repo is
*resolved* rather than refused, because it names a real file and falling back on every run some
tool produced would train a reader to ignore the fallback.

**A path still carrying its producer's quoting is refused too.** `git diff --name-only` — the
command this README hands you below — C-quotes any path containing a non-ASCII byte, a quote, or
a control character, so `src/café.cs` arrives as `"src/caf\303\251.cs"`. Matched as written, the
wrapping quotes and the octal escapes put it in a directory that does not exist: `src/**` misses
the file that actually changed and the scenario mapped to it retires on a prior pass. Any entry
containing a `"` is therefore refused into the full-suite fallback — decoding it here was
declined for the reason unsupported glob constructs are refused rather than approximated, since a
decoder's own failure modes (a truncated escape, an octal run that is not valid UTF-8) would each
have to end in this same refusal anyway. Decode before handing the set in, or read the diff with
`git diff -z --name-only`.

### Why a scenario ran — an output, not a detail

"47 of 150 scenarios" is untrustworthy on its own. Each selected scenario carries the **first
rule that selected it**, plus a `Detail` naming the glob and file that matched, the pattern that
was rejected, or what the baseline failed to establish:

| Reason | Meaning |
|---|---|
| `fallback` | selection could not be trusted at all; `SelectionResult.FallbackReason` says why |
| `globMatch` | a changed file matched a declared glob |
| `noGlobsDeclared` | no glob declared, or none that could be interpreted — an unknown mapping runs |
| `previouslyFailing` | the baseline records it as not passing; a fix that is never re-run is never observed |
| `new` | the baseline carries no trustworthy verdict for it |

The rules are applied in that order, and that ordering is what makes the counts mean something: a
scenario reported `previouslyFailing` is one the safety net **rescued**, not one the mapping would
have selected anyway. `fallback` is the default enum value, for the same reason `ScenarioOutcome`
defaults to `Absent` — a value nobody set must never read as "it matched".

### What "the baseline says it passed" has to survive

A scenario is skipped from **one** state only: every declared glob interpreted, none matched, and
a baseline recording a trustworthy pass. A scenario id is a join key, not evidence that two runs
meant the same thing by it — nor that the verdict filed under it was ever completely gathered. So
a recorded pass is believed only when:

- the baseline ran the scenario against the **same kind** the suite now declares. The kind selects
  the runner and is not covered by the fingerprint, so a `rest`-to-`llm` change is the one
  redefinition the fingerprint cannot see — and the pass being skipped on came from another runner
  against another system entirely;
- the baseline's `ScenarioFingerprint` is the fingerprint of the definition the suite **now**
  declares — a scenario redefined since the baseline is `new`, not `passed`;
- it recorded **as many runs as the repetition policy it applied**. Two repetitions applied and one
  run written down reads, to anything counting runs alone, as "one graded, one passed" — and the
  missing repetition is precisely the one whose verdict is unknown;
- its runs are filed under the scenario they claim;
- no run is recorded as a pass beside an assertion verdict that did not hold, **or without a
  verdict for an assertion the suite declares**. "Nothing failed" is satisfied vacuously by a run
  that checked nothing, so a `pass` carrying no verdict for a declared assertion is a claim with no
  evidence under it. Coverage is checked per declared spec rather than by counting: a run carrying
  exactly as many passing verdicts as the suite declares assertions, for a *different* assertion,
  is no more evidence than a run carrying none;
- at least one run produced a verdict at all. An all-errored scenario is `new`: **an absence of
  recorded failure is not a record of passing.**

Every one of those is an **under-selection** guard, which is the class that matters here: each
describes a way a baseline can look like a pass without being one, and being wrong about any of
them retires a scenario in silence.

`RunStatus.ExpectedFailure` counts as not-passing, so a known gap clearing is re-run and shows up
in `newlyCovered` — the headline the harness exists to produce.

The seed-reuse check `SuiteComparator` also makes is deliberately **not** repeated here.
Repetitions sharing a seed corrupt a paired significance test, but they do not change whether a
scenario passed, and over-selecting on a harmless condition spends the fallback's credibility for
nothing.

> The namespace is `Forge.EvalEngine.Impact` rather than `…Selection`, because a `Selection`
> namespace would shadow the `Scenarios.Selection` record and break every `typeof(Selection)` in
> the suite.

## Current state

**`partial` — contracts, assertion evaluation, both simulated callers, the REST and conversation
runners, the run coordinator, the statistics, the comparator, and impacted selection.** Types,
seams, the suite loader with validation, canonical serialization, the five assertion evaluators
behind
`AssertionEvaluatorRegistry`, `DeterministicCaller`, `LlmCaller`, `RecordedLlmClient`,
`RestRunner`, `LlmConversationRunner`, `RunCoordinator`, `ScenarioAggregator`,
`ProportionInterval`, `McNemarTest`, `PairedBootstrapTest`, `BenjaminiHochbergCorrection`,
`SuiteComparator`, `ImpactSelector`, `ArtifactBaseline` and `LiveEndpointBaseline` are complete
and tested. A mixed
suite of all four kinds runs end to end and produces a `SuiteResult` carrying a populated
`StatisticalSummary`, and two artifacts diff into a `ComparisonResult` carrying classifications,
`newlyCovered`, per-scenario corrected p-values, and a suite-wide delta. Deliberately **not** here
yet:

- No real MCP runner and no real UI runner. `NotImplementedMcpRunner` and `NotImplementedUiRunner`
  report those gaps cleanly so a mixed suite still routes.
- **No real LLM provider wiring** — by design, not by omission. `ILlmClient` is the seam and
  `RecordedLlmClient` is the deterministic implementation; a provider client belongs in the
  composition root, where its keys and its HTTP handler can be owned properly.
- No `IRestExchange` or `IConversationExchange` implementation — also by design. A request shape is
  a property of the system under test, so the composition root supplies one.
- No `IParticipantFactory` implementation. Which caller a scenario deserves is a composition-root
  decision; `DeterministicCaller` and `LlmCaller` are what one would return.
- No comparison stamped **into** the artifact. `SuiteComparator` produces a `ComparisonResult`
  from two `SuiteResult`s; `RunCoordinator` still has no baseline of its own, so
  `StatisticalSummary.Comparison` inside a `SuiteResult` remains unset. Which of the two is the
  right home for it is a reporting decision that has not been made.
- `baseline:*` **assertions still refuse themselves.** `RunCoordinator` passes
  `EvaluationContext.Baseline = null`, so an assertion graded against a recorded baseline
  *transcript* has nothing to compare against. That is a different seam from `IBaselineProvider`,
  which resolves a whole baseline *artifact* and now has two implementations.
- No repetition **override**. `ScenarioResult.RepetitionPolicyUsed` always reports the scenario's
  declared policy, because nothing can yet tell the harness to run a different count.
- `RunStatus.ExpectedFailure` is never produced. Nothing in `Scenario` declares that a scenario is
  expected to fail — `expectedBehavior` asserts the named behaviour and **passes** when the system
  does it — so the member stays unused rather than being inferred from a guess. The aggregator and
  the comparator nonetheless have stated rules for it, so the meaning is fixed before anything
  emits one.
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

Narrow the suite to what a change actually needs to run. Pure — the caller supplies the
changed-file set, and an empty or untrustworthy one selects everything rather than nothing:

```csharp
// Paths as your tooling emits them: `git diff --name-only`, mixed separators, leading `./`.
var selection = ImpactSelector.Select(suite, changedFiles, baselineArtifact);

if (selection.FellBackToFullSuite)
{
    // Not a failure — the answer. Print it, because a selective run nobody can explain is
    // indistinguishable from a broken one.
    Console.WriteLine($"Running the full suite: {selection.FallbackReason}");
}

foreach (var scenario in selection.Selected)
{
    Console.WriteLine($"{scenario.ScenarioId}: {scenario.Reason} — {scenario.Detail}");
}

var toRun = suite with
{
    Scenarios =
    [
        .. suite.Scenarios.Where(s =>
            selection.Selected.Any(x => x.ScenarioId == s.Identity.Id)
        ),
    ],
};
```

Or hand the whole suite to the coordinator, which routes, repeats, throttles, and grades:

```csharp
var coordinator = new RunCoordinator(
    runners:
    [
        new RestRunner(httpClient, restExchange, SystemClock.Instance),
        new LlmConversationRunner(conversationExchange, SystemClock.Instance),
        new NotImplementedMcpRunner(SystemClock.Instance),
        new NotImplementedUiRunner(SystemClock.Instance),
    ],
    assertions: AssertionEvaluatorRegistry.CreateDefault(),

    // A fresh caller per run — never one instance shared across repetitions.
    participants: participantFactory,
    clock: SystemClock.Instance,
    seeds: new DeterministicSeedSource(rootSeed),
    options: new RunCoordinatorOptions { MaxConcurrency = 4, Endpoint = "https://localhost:5001" }
);

// Throws on cancellation rather than returning a partial artifact.
SuiteResult artifact = await coordinator.RunAsync(suite, cancellationToken);
File.WriteAllText("eval.json", CanonicalJson.Serialize(artifact));
```

Then diff it against a baseline. The provider decides where the baseline comes from; the
comparator does not care:

```csharp
// A committed artifact, confined to a root. Null means there genuinely is no baseline at that
// reference — everything else throws rather than reporting "no baseline" for a file it refused.
IBaselineProvider provider = new ArtifactBaseline(@"C:\repo\eval-baselines");

// ...or the deployed version, evaluated now. The factory supplies a coordinator wired for the
// endpoint it is handed, and the artifact that comes back is checked against it.
IBaselineProvider live = new LiveEndpointBaseline(suite, endpoint => BuildCoordinator(endpoint));

var baseline = await provider.TryGetBaselineAsync("main.json", cancellationToken);

if (baseline is null)
{
    // No baseline is not "no regression". Say so rather than reporting a green.
    return;
}

var comparator = new SuiteComparator(new McNemarTest(), BenjaminiHochbergCorrection.Instance);

// Throws ComparisonRefusedException when the two runs were not conducted alike — a different
// suite, a different root seed, or different harness settings.
ComparisonResult comparison = comparator.Compare(baseline, artifact, cancellationToken);

// The headline: what this change covered that the baseline did not.
foreach (var scenarioId in comparison.NewlyCovered)
{
    Console.WriteLine($"newly covered: {scenarioId}");
}

foreach (var scenario in comparison.ScenarioComparisons)
{
    // Significant is judged on the *adjusted* p-value, and is NotComputed wherever no test
    // could honestly be run — never a figure that was not calculated.
    Console.WriteLine(
        $"{scenario.ScenarioId}: {scenario.Classification} "
            + $"(delta {scenario.Comparison?.EffectSize}, {scenario.Comparison?.Significant})"
    );

    // A scenario that could not be diffed says why, rather than being dropped or guessed at.
    if (scenario.NotComparableReason is { } reason)
    {
        Console.Error.WriteLine(reason);
    }
}
```

## Build and test

```powershell
dotnet build libs/EvalEngine/src/Forge.EvalEngine.csproj
dotnet test libs/EvalEngine/tests/Forge.EvalEngine.Tests.csproj
```
