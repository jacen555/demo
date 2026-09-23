using FluentAssertions;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Coordination;
using Forge.EvalEngine.Participants;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Runners;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Serialization;
using Forge.EvalEngine.Tests.Runners;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Tests.Coordination;

/// <summary>
/// The coordinator routes each scenario to its runner, applies the repetition policy, and grades
/// through the ordinary evaluators. This is the first place the whole pipeline runs end to end,
/// so it is also the first place a result from one run could be attributed to another.
/// </summary>
public sealed class RunCoordinatorTests
{
    // ---------------------------------------------------------------------------------------
    // Construction.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public void Constructor_NullRunners_Throws()
    {
        var act = () => CoordinatorFixtures.Coordinator(null!);

        act.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Constructor_NullRunnerInTheCollection_IsRefused()
    {
        var act = () => CoordinatorFixtures.Coordinator([new StubRunner(ScenarioKind.Rest), null!]);

        act.Should().Throw<ArgumentException>();
    }

    /// <summary>
    /// Which runner conducted a scenario would otherwise depend on registration order, exactly as
    /// it would for two evaluators claiming one category.
    /// </summary>
    [Fact]
    public void Constructor_TwoRunnersForOneKind_IsRefused()
    {
        var act = () =>
            CoordinatorFixtures.Coordinator([new StubRunner(ScenarioKind.Rest), new StubRunner(ScenarioKind.Rest)]);

        act.Should().Throw<ArgumentException>().WithMessage("*Rest*");
    }

    [Fact]
    public void Constructor_NullAssertionRegistry_Throws()
    {
        var act = () =>
            new RunCoordinator(
                [new StubRunner(ScenarioKind.Rest)],
                null!,
                new StubParticipantFactory(),
                new FrozenClock(CoordinatorFixtures.Instant),
                new CountingSeedSource()
            );

        act.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Constructor_NullParticipantFactory_Throws()
    {
        var act = () =>
            new RunCoordinator(
                [new StubRunner(ScenarioKind.Rest)],
                AssertionEvaluatorRegistry.CreateDefault(),
                null!,
                new FrozenClock(CoordinatorFixtures.Instant),
                new CountingSeedSource()
            );

        act.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Constructor_NullClock_Throws()
    {
        var act = () =>
            new RunCoordinator(
                [new StubRunner(ScenarioKind.Rest)],
                AssertionEvaluatorRegistry.CreateDefault(),
                new StubParticipantFactory(),
                null!,
                new CountingSeedSource()
            );

        act.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Constructor_NullSeedSource_Throws()
    {
        var act = () =>
            new RunCoordinator(
                [new StubRunner(ScenarioKind.Rest)],
                AssertionEvaluatorRegistry.CreateDefault(),
                new StubParticipantFactory(),
                new FrozenClock(CoordinatorFixtures.Instant),
                null!
            );

        act.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public async Task RunAsync_NullSuite_Throws()
    {
        var act = () => CoordinatorFixtures.Coordinator([new StubRunner(ScenarioKind.Rest)]).RunAsync(null!, default);

        await act.Should().ThrowAsync<ArgumentNullException>();
    }

    // ---------------------------------------------------------------------------------------
    // Routing.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public async Task RunAsync_Scenario_DispatchesToTheRunnerRegisteredForItsKind()
    {
        var rest = new StubRunner(ScenarioKind.Rest);
        var llm = new StubRunner(ScenarioKind.Llm);

        await CoordinatorFixtures
            .Coordinator([rest, llm])
            .RunAsync(
                CoordinatorFixtures.Suite(
                    CoordinatorFixtures.Scenario("rest-a"),
                    CoordinatorFixtures.Scenario("llm-a", ScenarioKind.Llm)
                ),
                default
            );

        rest.Seen.Select(run => run.ScenarioId).Should().Equal("rest-a");
        llm.Seen.Select(run => run.ScenarioId).Should().Equal("llm-a");
    }

    [Fact]
    public async Task RunAsync_Always_ReportsResultsInSuiteOrder()
    {
        var result = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)], options: new RunCoordinatorOptions { MaxConcurrency = 4 })
            .RunAsync(
                CoordinatorFixtures.Suite(
                    CoordinatorFixtures.Scenario("c"),
                    CoordinatorFixtures.Scenario("a"),
                    CoordinatorFixtures.Scenario("b")
                ),
                default
            );

        result.ScenarioResults.Select(scenario => scenario.ScenarioId).Should().Equal("c", "a", "b");
    }

    [Fact]
    public async Task RunAsync_Always_CarriesEachScenarioKindIntoTheArtifact()
    {
        var result = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest), new StubRunner(ScenarioKind.Llm)])
            .RunAsync(
                CoordinatorFixtures.Suite(
                    CoordinatorFixtures.Scenario("rest-a"),
                    CoordinatorFixtures.Scenario("llm-a", ScenarioKind.Llm)
                ),
                default
            );

        result.ScenarioResults.Select(scenario => scenario.Kind).Should().Equal(ScenarioKind.Rest, ScenarioKind.Llm);
    }

    /// <summary>
    /// The headline claim for this layer: a suite containing all four kinds — two conducted for
    /// real, two reporting a declared gap — runs to completion through the real runners and the
    /// real evaluators, and the unsupported ones do not take the run down.
    /// </summary>
    [Fact]
    public async Task RunAsync_MixedSuiteOfAllFourKinds_RunsEndToEndWithoutTheUnsupportedOnesTakingItDown()
    {
        using var handler = new StubHandler(new StubbedReply());
        var runners = new IScenarioRunner[]
        {
            RunnerFixtures.Runner(handler, new StubExchange()),
            ConversationFixtures.Runner(new StubConversationExchange()),
            new NotImplementedMcpRunner(new FrozenClock(CoordinatorFixtures.Instant)),
            new NotImplementedUiRunner(new FrozenClock(CoordinatorFixtures.Instant)),
        };
        var suite = CoordinatorFixtures.Suite(
            Conducted("rest-a", ScenarioKind.Rest, ExecutionMode.Deterministic, "responded"),
            Conducted("llm-a", ScenarioKind.Llm, ExecutionMode.Simulated, "responded"),
            Conducted("mcp-a", ScenarioKind.Mcp, ExecutionMode.Deterministic, "unsupported"),
            Conducted("ui-a", ScenarioKind.Ui, ExecutionMode.Deterministic, "unsupported")
        );

        var result = await CoordinatorFixtures
            .Coordinator(
                runners,
                participants: CallerFactory(),
                options: new RunCoordinatorOptions { MaxConcurrency = 4 }
            )
            .RunAsync(suite, default);

        result
            .ScenarioResults.Select(scenario => scenario.ScenarioId)
            .Should()
            .Equal("rest-a", "llm-a", "mcp-a", "ui-a");
        result
            .ScenarioResults.Select(scenario => scenario.Runs.Single().Status)
            .Should()
            .Equal(RunStatus.Pass, RunStatus.Pass, RunStatus.Error, RunStatus.Error);
        result
            .ScenarioResults.SelectMany(scenario => scenario.Runs)
            .Should()
            .AllSatisfy(run => run.Transcript.Should().NotBeNull());

        static Scenario Conducted(string id, ScenarioKind kind, ExecutionMode mode, string exchange) =>
            CoordinatorFixtures.Scenario(
                id,
                kind,
                assertions: [$"expectedBehavior:transport/exchange={exchange}"],
                mode: mode,
                simulation: new Simulation { Opening = "the opening stimulus" }
            );

        static StubParticipantFactory CallerFactory() =>
            new((scenario, _, _) => new DeterministicCaller(scenario.Simulation, scenario.Execution.Mode));
    }

    /// <summary>
    /// A kind nobody registered a runner for is a harness fault, so the run is an error rather
    /// than a verdict — but it is recorded, not thrown, for exactly the reason the unsupported
    /// stub is recorded: one gap must not decide whether the other two hundred scenarios produce
    /// evidence at all.
    /// </summary>
    [Fact]
    public async Task RunAsync_KindWithNoRegisteredRunner_IsAnErrorAndTheRestOfTheSuiteStillRuns()
    {
        var result = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)])
            .RunAsync(
                CoordinatorFixtures.Suite(
                    CoordinatorFixtures.Scenario("rest-a"),
                    CoordinatorFixtures.Scenario("mcp-a", ScenarioKind.Mcp),
                    CoordinatorFixtures.Scenario("rest-b")
                ),
                default
            );

        result
            .ScenarioResults.Select(scenario => scenario.Runs.Single().Status)
            .Should()
            .Equal(RunStatus.Pass, RunStatus.Error, RunStatus.Pass);
        result.ScenarioResults[1].Runs.Single().ErrorDetail.Should().NotBeNullOrWhiteSpace().And.Contain("Mcp");
    }

    /// <summary>
    /// A run with no runner gathered nothing, so it must not look like a run that gathered
    /// something. Fails closed through the shared classification rather than a private one.
    /// </summary>
    [Fact]
    public async Task RunAsync_KindWithNoRegisteredRunner_ProducesATranscriptThatIsNotGradeable()
    {
        var result = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)])
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("mcp-a", ScenarioKind.Mcp)), default);

        var transcript = result.ScenarioResults.Single().Runs.Single().Transcript;
        transcript.ScenarioId.Should().Be("mcp-a");
        transcript.Turns.Should().BeEmpty();
        transcript.Outcome.ObservedOutcome.Should().BeNull();
        ExchangeState.IsHarnessFailure(ExchangeState.Of(transcript)).Should().BeTrue();
    }

    // ---------------------------------------------------------------------------------------
    // Repetition. One code path: Once is Repeat(1).
    // ---------------------------------------------------------------------------------------

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(7)]
    public async Task RunAsync_RepetitionPolicy_ConductsThatManyRuns(int repetitions)
    {
        var runner = new StubRunner(ScenarioKind.Rest);

        var result = await CoordinatorFixtures
            .Coordinator([runner])
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario(repetitions: repetitions)), default);

        runner.Seen.Should().HaveCount(repetitions);
        result.ScenarioResults.Single().Runs.Should().HaveCount(repetitions);
    }

    [Fact]
    public async Task RunAsync_RepetitionPolicyOnce_TravelsTheSamePathAsRepeatOfOne()
    {
        var runner = new StubRunner(ScenarioKind.Rest);
        var once = CoordinatorFixtures.Scenario("a") with
        {
            Execution = new Execution { Mode = ExecutionMode.Deterministic, RepetitionPolicy = RepetitionPolicy.Once },
        };

        await CoordinatorFixtures.Coordinator([runner]).RunAsync(CoordinatorFixtures.Suite(once), default);

        runner.Seen.Should().ContainSingle();
        runner.Seen.Single().Repetition.Should().Be(1);
    }

    [Fact]
    public async Task RunAsync_Repetitions_AreNumberedOneThroughN()
    {
        var runner = new StubRunner(ScenarioKind.Rest);

        await CoordinatorFixtures
            .Coordinator([runner])
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario(repetitions: 4)), default);

        runner.Seen.Select(run => run.Repetition).Order().Should().Equal(1, 2, 3, 4);
    }

    [Fact]
    public async Task RunAsync_Always_RecordsThePolicyItApplied()
    {
        var result = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest), new StubRunner(ScenarioKind.Llm)])
            .RunAsync(
                CoordinatorFixtures.Suite(
                    CoordinatorFixtures.Scenario("rest-a"),
                    CoordinatorFixtures.Scenario("llm-a", ScenarioKind.Llm, repetitions: 5)
                ),
                default
            );

        result.ScenarioResults[0].RepetitionPolicyUsed.Repetitions.Should().Be(1);
        result.ScenarioResults[0].RepetitionPolicyUsed.IsOnce.Should().BeTrue();
        result.ScenarioResults[1].RepetitionPolicyUsed.Repetitions.Should().Be(5);
    }

    [Fact]
    public async Task RunAsync_Repetitions_AreOrderedByRepetitionNumberInTheArtifact()
    {
        var result = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)], options: new RunCoordinatorOptions { MaxConcurrency = 4 })
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario(repetitions: 6)), default);

        var seeds = result.ScenarioResults.Single().Runs.Select(run => run.Transcript.Seed).ToArray();
        seeds.Should().BeInAscendingOrder("the counting seed source hands seeds out in repetition order");
    }

    /// <summary>
    /// Zero and negative repetitions are unrepresentable rather than merely rejected, which is why
    /// the coordinator has no branch for them.
    /// </summary>
    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(int.MinValue)]
    public void RepetitionPolicy_ZeroOrNegative_IsUnrepresentable(int repetitions)
    {
        var act = () => RepetitionPolicy.Repeat(repetitions);

        act.Should().Throw<ArgumentOutOfRangeException>();
    }

    // ---------------------------------------------------------------------------------------
    // Grading.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public async Task RunAsync_EveryAssertionHeld_IsPass()
    {
        var result = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)])
            .RunAsync(
                CoordinatorFixtures.Suite(
                    CoordinatorFixtures.Scenario(
                        assertions:
                        [
                            "expectedBehavior:outcome/resolved",
                            "expectedBehavior:transport/exchange=responded",
                        ]
                    )
                ),
                default
            );

        var run = result.ScenarioResults.Single().Runs.Single();
        run.Status.Should().Be(RunStatus.Pass);
        run.AssertionResults.Should().HaveCount(2).And.AllSatisfy(assertion => assertion.Pass.Should().BeTrue());
    }

    [Fact]
    public async Task RunAsync_AnAssertionDidNotHold_IsFail()
    {
        var result = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)])
            .RunAsync(
                CoordinatorFixtures.Suite(
                    CoordinatorFixtures.Scenario(
                        assertions: ["expectedBehavior:outcome/resolved", "expectedBehavior:outcome/escalated"]
                    )
                ),
                default
            );

        var run = result.ScenarioResults.Single().Runs.Single();
        run.Status.Should().Be(RunStatus.Fail);
        run.ErrorDetail.Should().BeNull("a graded failure is not an error");
        run.AssertionResults.Select(assertion => assertion.Pass).Should().Equal(true, false);
    }

    [Fact]
    public async Task RunAsync_ScenarioWithNoAssertions_IsPass()
    {
        var result = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)])
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario()), default);

        result.ScenarioResults.Single().Runs.Single().Status.Should().Be(RunStatus.Pass);
    }

    /// <summary>
    /// The refusal line T4 drew, kept: an assertion nobody can evaluate is an error, never a
    /// graded fail. A typo that reads as a regression is nearly as bad as one that reads as a pass.
    /// </summary>
    [Fact]
    public async Task RunAsync_UnEvaluableAssertion_IsErrorRatherThanAGradedFail()
    {
        var result = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)])
            .RunAsync(
                CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario(assertions: ["ExactMatch:outcome"])),
                default
            );

        var run = result.ScenarioResults.Single().Runs.Single();
        run.Status.Should().Be(RunStatus.Error);
        run.ErrorDetail.Should().NotBeNullOrWhiteSpace().And.Contain("ExactMatch");
    }

    [Fact]
    public async Task RunAsync_UnEvaluableAssertionAfterAnEvaluableOne_IsStillError()
    {
        var result = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)])
            .RunAsync(
                CoordinatorFixtures.Suite(
                    CoordinatorFixtures.Scenario(
                        assertions: ["expectedBehavior:outcome/resolved", "nothingImplementsThis:outcome"]
                    )
                ),
                default
            );

        result.ScenarioResults.Single().Runs.Single().Status.Should().Be(RunStatus.Error);
    }

    /// <summary>
    /// The decisive false-green guard at this layer. A run the harness could not gather evidence
    /// from is an error whatever its assertions would have said, and its assertions are not run —
    /// a verdict about a system that was never successfully asked is not a verdict.
    /// </summary>
    [Theory]
    [InlineData(ExchangeState.Unsupported)]
    [InlineData(ExchangeState.TimedOut)]
    [InlineData(ExchangeState.RequestFailed)]
    [InlineData(ExchangeState.NotAttempted)]
    [InlineData(ExchangeState.AdapterFailed)]
    [InlineData(ExchangeState.ParticipantFailed)]
    [InlineData("somethingNobodyHasWrittenYet")]
    public async Task RunAsync_RunThatGatheredNoEvidence_IsErrorAndIsNotGraded(string exchange)
    {
        var runner = new StubRunner(
            ScenarioKind.Rest,
            (scenario, context, _) =>
                Task.FromResult(
                    CoordinatorFixtures.Transcript(scenario, context, exchange, failure: "the stated reason")
                )
        );

        var result = await CoordinatorFixtures
            .Coordinator([runner])
            .RunAsync(
                CoordinatorFixtures.Suite(
                    CoordinatorFixtures.Scenario(assertions: ["expectedBehavior:outcome/resolved"])
                ),
                default
            );

        var run = result.ScenarioResults.Single().Runs.Single();
        run.Status.Should().Be(RunStatus.Error);
        run.AssertionResults.Should().BeEmpty("there was no evidence to grade");
        run.ErrorDetail.Should().NotBeNullOrWhiteSpace().And.Contain("the stated reason");
    }

    /// <summary>
    /// The states that produced something to grade stay gradeable — including a body the adapter
    /// reported it could not read, which is a verdict about the <i>system</i>.
    /// </summary>
    [Theory]
    [InlineData(ExchangeState.Responded)]
    [InlineData(ExchangeState.MalformedResponse)]
    public async Task RunAsync_RunThatProducedEvidence_IsGraded(string exchange)
    {
        var runner = new StubRunner(
            ScenarioKind.Rest,
            (scenario, context, _) => Task.FromResult(CoordinatorFixtures.Transcript(scenario, context, exchange))
        );

        var result = await CoordinatorFixtures
            .Coordinator([runner])
            .RunAsync(
                CoordinatorFixtures.Suite(
                    CoordinatorFixtures.Scenario(assertions: ["expectedBehavior:outcome/resolved"])
                ),
                default
            );

        var run = result.ScenarioResults.Single().Runs.Single();
        run.Status.Should().Be(RunStatus.Pass);
        run.AssertionResults.Should().ContainSingle();
    }

    /// <summary>An errored run must never be silent, even when the runner stated no reason.</summary>
    [Fact]
    public async Task RunAsync_HarnessFailureWithNoStatedReason_StillRecordsWhyItCouldNotBeGraded()
    {
        var runner = new StubRunner(
            ScenarioKind.Rest,
            (scenario, context, _) =>
                Task.FromResult(CoordinatorFixtures.Transcript(scenario, context, ExchangeState.TimedOut))
        );

        var result = await CoordinatorFixtures
            .Coordinator([runner])
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario()), default);

        result
            .ScenarioResults.Single()
            .Runs.Single()
            .ErrorDetail.Should()
            .NotBeNullOrWhiteSpace()
            .And.Contain(ExchangeState.TimedOut);
    }

    // ---------------------------------------------------------------------------------------
    // A runner that misbehaves.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public async Task RunAsync_RunnerThrows_IsRecordedAsAnErrorWithoutTakingDownTheSuite()
    {
        var result = await CoordinatorFixtures
            .Coordinator([
                Throwing(new InvalidOperationException("the adapter exploded")),
                new StubRunner(ScenarioKind.Llm),
            ])
            .RunAsync(
                CoordinatorFixtures.Suite(
                    CoordinatorFixtures.Scenario("rest-a"),
                    CoordinatorFixtures.Scenario("llm-a", ScenarioKind.Llm)
                ),
                default
            );

        result
            .ScenarioResults.Select(scenario => scenario.Runs.Single().Status)
            .Should()
            .Equal(RunStatus.Error, RunStatus.Pass);
    }

    /// <summary>
    /// An exception message is authored by whatever threw it and routinely names an endpoint or a
    /// connection string. The artifact is committed, so the failure is named by its type (§V).
    /// </summary>
    [Fact]
    public async Task RunAsync_RunnerThrows_DoesNotCommitTheExceptionMessage()
    {
        var result = await CoordinatorFixtures
            .Coordinator([
                Throwing(new InvalidOperationException("Login failed for user 'sa' with password 'hunter2'")),
            ])
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("rest-a")), default);

        var artifact = CanonicalJson.Serialize(result);
        artifact.Should().NotContain("hunter2").And.NotContain("Login failed");
        artifact.Should().Contain(nameof(InvalidOperationException), "the failure is still named");
    }

    [Fact]
    public async Task RunAsync_RunnerReturnsNothing_IsRecordedAsAnError()
    {
        var runner = new StubRunner(ScenarioKind.Rest, (_, _, _) => Task.FromResult<Transcript>(null!));

        var result = await CoordinatorFixtures
            .Coordinator([runner])
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("rest-a")), default);

        var run = result.ScenarioResults.Single().Runs.Single();
        run.Status.Should().Be(RunStatus.Error);
        run.Transcript.ScenarioId.Should().Be("rest-a");
        ExchangeState.IsHarnessFailure(ExchangeState.Of(run.Transcript)).Should().BeTrue();
    }

    /// <summary>
    /// The recurrence this layer is built against: evidence from one run graded as though it came
    /// from another. A transcript that names a different scenario is refused rather than graded,
    /// because grading it would attribute one scenario's behaviour to another's assertions.
    /// </summary>
    [Fact]
    public async Task RunAsync_RunnerReturnsATranscriptForAnotherScenario_IsRefusedRatherThanGraded()
    {
        var runner = new StubRunner(
            ScenarioKind.Rest,
            (scenario, context, _) =>
                Task.FromResult(CoordinatorFixtures.Transcript(scenario, context, scenarioId: "somebody-else"))
        );

        var result = await CoordinatorFixtures
            .Coordinator([runner])
            .RunAsync(
                CoordinatorFixtures.Suite(
                    CoordinatorFixtures.Scenario("rest-a", assertions: ["expectedBehavior:outcome/resolved"])
                ),
                default
            );

        var run = result.ScenarioResults.Single().Runs.Single();
        run.Status.Should().Be(RunStatus.Error);
        run.AssertionResults.Should().BeEmpty();
        run.ErrorDetail.Should()
            .Contain("rest-a")
            .And.NotContain("somebody-else", "an identifier the runner authored is not committed verbatim (§V)");
        run.Transcript.ScenarioId.Should().Be("rest-a", "the artifact is joined on this key");
    }

    /// <summary>
    /// The same misattribution one level finer: a transcript stamped with a seed this run was
    /// never driven with cannot be reproduced, and cannot be paired against a baseline.
    /// </summary>
    [Fact]
    public async Task RunAsync_RunnerReturnsATranscriptWithAnotherSeed_IsRefusedRatherThanGraded()
    {
        var runner = new StubRunner(
            ScenarioKind.Rest,
            (scenario, context, _) => Task.FromResult(CoordinatorFixtures.Transcript(scenario, context, seed: 999999))
        );

        var result = await CoordinatorFixtures
            .Coordinator([runner])
            .RunAsync(
                CoordinatorFixtures.Suite(
                    CoordinatorFixtures.Scenario("rest-a", assertions: ["expectedBehavior:outcome/resolved"])
                ),
                default
            );

        var run = result.ScenarioResults.Single().Runs.Single();
        run.Status.Should().Be(RunStatus.Error);
        run.AssertionResults.Should().BeEmpty();
        run.ErrorDetail.Should().NotBeNullOrWhiteSpace();
    }

    [Fact]
    public async Task RunAsync_ParticipantFactoryThrows_IsRecordedAsAnErrorWithoutTakingDownTheSuite()
    {
        var participants = new StubParticipantFactory(
            (scenario, _, _) =>
                scenario.Identity.Id == "rest-a"
                    ? throw new InvalidOperationException("no caller for this scenario")
                    : new CountingParticipant()
        );

        var result = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)], participants)
            .RunAsync(
                CoordinatorFixtures.Suite(
                    CoordinatorFixtures.Scenario("rest-a"),
                    CoordinatorFixtures.Scenario("rest-b")
                ),
                default
            );

        result
            .ScenarioResults.Select(scenario => scenario.Runs.Single().Status)
            .Should()
            .Equal(RunStatus.Error, RunStatus.Pass);
    }

    [Fact]
    public async Task RunAsync_ParticipantFactoryReturnsNothing_IsRecordedAsAnError()
    {
        var participants = new StubParticipantFactory((_, _, _) => null!);

        var result = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)], participants)
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("rest-a")), default);

        result.ScenarioResults.Single().Runs.Single().Status.Should().Be(RunStatus.Error);
    }

    /// <summary>
    /// A transport timeout surfaces as <see cref="OperationCanceledException"/> without the
    /// caller's token being cancelled. That is the system under test being slow, not the caller
    /// abandoning the run, so it is recorded rather than propagated.
    /// </summary>
    [Fact]
    public async Task RunAsync_RunnerReportsACancellationTheCallerDidNotRequest_IsRecordedRatherThanPropagated()
    {
        var result = await CoordinatorFixtures
            .Coordinator([Throwing(new OperationCanceledException("the transport timed out"))])
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("rest-a")), default);

        result.ScenarioResults.Single().Runs.Single().Status.Should().Be(RunStatus.Error);
    }

    // ---------------------------------------------------------------------------------------
    // The artifact.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public async Task RunAsync_Always_StampsTheInjectedClockAndTheRootSeed()
    {
        var result = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)], seeds: new CountingSeedSource(rootSeed: 20260923))
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario()), default);

        result.Environment.Timestamp.Should().Be(CoordinatorFixtures.Instant);
        result.Environment.Seed.Should().Be(20260923);
        result.SuiteName.Should().Be("regression-suite");
    }

    /// <summary>
    /// The endpoint travels into a committed artifact, so it is stripped by the one implementation
    /// every runner already uses rather than by a third copy of the rule (§V).
    /// </summary>
    [Theory]
    [InlineData("https://user:hunter2@localhost:5001/eval", "hunter2")]
    [InlineData("https://localhost:5001/eval?sig=abcdef", "abcdef")]
    [InlineData("https://localhost:5001/eval#access_token=abcdef", "abcdef")]
    public async Task RunAsync_EndpointCarryingACredential_IsStrippedInTheArtifact(string endpoint, string secret)
    {
        var result = await CoordinatorFixtures
            .Coordinator(
                [new StubRunner(ScenarioKind.Rest)],
                options: new RunCoordinatorOptions { Endpoint = endpoint }
            )
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario()), default);

        result.Environment.Endpoint.Should().NotBeNull().And.NotContain(secret);
        CanonicalJson.Serialize(result).Should().NotContain(secret);
    }

    [Fact]
    public async Task RunAsync_Always_RecordsTheThrottleItRanUnder()
    {
        var result = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)], options: new RunCoordinatorOptions { MaxConcurrency = 3 })
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario()), default);

        result
            .Environment.HarnessConfig.Should()
            .ContainKey("maxConcurrency")
            .WhoseValue.Should()
            .Be("3", "the throttle changes what a run against a rate-limited system observes");
    }

    [Fact]
    public async Task RunAsync_Always_CopiesSlicingTagsAndNamesTheDimensions()
    {
        var suite = CoordinatorFixtures.Suite(
            CoordinatorFixtures.Scenario(
                "a",
                tags: new Dictionary<string, string>(StringComparer.Ordinal) { ["risk"] = "high", ["area"] = "scope" }
            ),
            CoordinatorFixtures.Scenario(
                "b",
                tags: new Dictionary<string, string>(StringComparer.Ordinal) { ["area"] = "triage" }
            )
        );

        var result = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)])
            .RunAsync(suite, default);

        result.SlicingDimensions.Should().Equal("area", "risk");
        result.ScenarioResults[0].Tags.Should().Contain(new KeyValuePair<string, string>("risk", "high"));
        result.ScenarioResults[1].Tags.Should().ContainKey("area").WhoseValue.Should().Be("triage");
    }

    /// <summary>
    /// The artifact is the committable output, so it has to survive the round trip the comparator
    /// will put it through.
    /// </summary>
    [Fact]
    public async Task RunAsync_Always_ProducesAnArtifactThatRoundTripsThroughCanonicalJson()
    {
        var result = await CoordinatorFixtures
            .Coordinator([
                new StubRunner(ScenarioKind.Rest),
                new NotImplementedUiRunner(new FrozenClock(CoordinatorFixtures.Instant)),
            ])
            .RunAsync(
                CoordinatorFixtures.Suite(
                    CoordinatorFixtures.Scenario("rest-a", assertions: ["expectedBehavior:outcome/resolved"]),
                    CoordinatorFixtures.Scenario("ui-a", ScenarioKind.Ui)
                ),
                default
            );

        var json = CanonicalJson.Serialize(result);

        CanonicalJson.DeserializeSuiteResult(json).Should().Be(result);
    }

    /// <summary>
    /// Statistics are a later stage. Reporting an aggregate this library did not compute would be
    /// the same dishonesty <see cref="SignificanceVerdict.NotComputed"/> exists to avoid.
    /// </summary>
    [Fact]
    public async Task RunAsync_Always_LeavesTheStatisticalSummaryUnset()
    {
        var result = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)])
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario(repetitions: 3)), default);

        result.ScenarioResults.Single().Summary.Should().BeNull();
    }

    [Fact]
    public async Task RunAsync_SuiteWithNoScenarios_ProducesAnEmptyButWellFormedArtifact()
    {
        var result = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)])
            .RunAsync(CoordinatorFixtures.Suite(), default);

        result.ScenarioResults.Should().BeEmpty();
        result.SlicingDimensions.Should().BeEmpty();
        result.Environment.Timestamp.Should().Be(CoordinatorFixtures.Instant);
        CanonicalJson.DeserializeSuiteResult(CanonicalJson.Serialize(result)).Should().Be(result);
    }

    /// <summary>
    /// A coordinator with nothing registered still accounts for every planned run. A missing
    /// result would leave a consumer to decide what silence meant.
    /// </summary>
    [Fact]
    public async Task RunAsync_NoRunnersRegisteredAtAll_StillAccountsForEveryPlannedRun()
    {
        var result = await CoordinatorFixtures
            .Coordinator([])
            .RunAsync(
                CoordinatorFixtures.Suite(
                    CoordinatorFixtures.Scenario("a", repetitions: 2),
                    CoordinatorFixtures.Scenario("b", ScenarioKind.Llm)
                ),
                default
            );

        CoordinatorFixtures
            .Runs(result)
            .Should()
            .HaveCount(3)
            .And.AllSatisfy(run => run.Status.Should().Be(RunStatus.Error));
        CoordinatorFixtures.Runs(result).Should().AllSatisfy(run => run.ErrorDetail.Should().NotBeNullOrWhiteSpace());
    }

    private static StubRunner Throwing(Exception failure) =>
        new(ScenarioKind.Rest, (_, _, _) => Task.FromException<Transcript>(failure));
}
