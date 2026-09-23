using FluentAssertions;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Runners;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Tests.Runners;

/// <summary>
/// The MCP stub reports an unsupported transport cleanly. A mixed suite containing MCP scenarios
/// must still load and route; the MCP scenario yields an observable unsupported signal rather than
/// taking down the run.
/// </summary>
public sealed class NotImplementedMcpRunnerTests
{
    private static NotImplementedMcpRunner Runner() => new(new FrozenClock(RunnerFixtures.Instant));

    [Fact]
    public void Constructor_NullClock_Throws()
    {
        var act = () => new NotImplementedMcpRunner(null!);

        act.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Kind_Always_IsMcp() => Runner().Kind.Should().Be(ScenarioKind.Mcp);

    [Fact]
    public async Task RunAsync_McpScenario_ReturnsATranscriptRatherThanThrowing()
    {
        var transcript = await Runner()
            .RunAsync(
                RunnerFixtures.Scenario(ScenarioKind.Mcp, id: "tool-probe"),
                RunnerFixtures.Context(new ScriptedParticipant("hi"), seed: 1234),
                default
            );

        transcript.ScenarioId.Should().Be("tool-probe");
        transcript.Seed.Should().Be(1234);
        transcript.StartedAt.Should().Be(RunnerFixtures.Instant);
    }

    [Fact]
    public async Task RunAsync_McpScenario_RecordsTheUnsupportedSignalObservably()
    {
        var transcript = await Runner()
            .RunAsync(
                RunnerFixtures.Scenario(ScenarioKind.Mcp),
                RunnerFixtures.Context(new ScriptedParticipant("hi")),
                default
            );

        transcript.Transport.Kind.Should().Be("mcp");
        RunnerFixtures.Attribute(transcript, TransportAttributes.Exchange).Should().Be(ExchangeState.Unsupported);
        RunnerFixtures.Attribute(transcript, TransportAttributes.StoppedBy).Should().Be(StopReason.Unsupported);
        RunnerFixtures
            .Attribute(transcript, TransportAttributes.Failure)
            .Should()
            .NotBeNullOrWhiteSpace()
            .And.Contain("mcp");
    }

    /// <summary>
    /// The decisive property: unsupported is a harness failure, so a suite of entirely unsupported
    /// scenarios cannot report as clean.
    /// </summary>
    [Fact]
    public async Task RunAsync_McpScenario_ClassifiesAsAHarnessFailure()
    {
        var transcript = await Runner()
            .RunAsync(
                RunnerFixtures.Scenario(ScenarioKind.Mcp),
                RunnerFixtures.Context(new ScriptedParticipant("hi")),
                default
            );

        ExchangeState.IsHarnessFailure(ExchangeState.Of(transcript)).Should().BeTrue();
    }

    /// <summary>
    /// No turn ran and nothing was observed, so nothing may look like evidence about the system.
    /// An empty outcome beside a green assertion is exactly the false green this round is guarding.
    /// </summary>
    [Fact]
    public async Task RunAsync_McpScenario_ObservesNothingAboutTheSystemUnderTest()
    {
        var transcript = await Runner()
            .RunAsync(
                RunnerFixtures.Scenario(ScenarioKind.Mcp),
                RunnerFixtures.Context(new ScriptedParticipant("hi")),
                default
            );

        transcript.Turns.Should().BeEmpty();
        transcript.Outcome.ObservedOutcome.Should().BeNull();
        transcript.Outcome.ObservedPath.Should().BeNull();
        transcript.Outcome.Fields.Should().BeEmpty();
        transcript.Transport.Endpoint.Should().BeNull();
    }

    /// <summary>
    /// The unsupported signal is readable by the same evaluator a suite author already has, so it
    /// is genuinely observable rather than merely recorded somewhere.
    /// </summary>
    [Fact]
    public async Task RunAsync_McpScenario_IsAssertableThroughTheOrdinaryEvaluators()
    {
        var transcript = await Runner()
            .RunAsync(
                RunnerFixtures.Scenario(ScenarioKind.Mcp, id: "tool-probe"),
                RunnerFixtures.Context(new ScriptedParticipant("hi")),
                default
            );

        var verdict = await AssertionEvaluatorRegistry
            .CreateDefault()
            .EvaluateAsync(
                AssertionSpec.Parse("expectedBehavior:transport/exchange=unsupported"),
                new EvaluationContext
                {
                    ScenarioId = "tool-probe",
                    Grading = new Grading(),
                    Transcript = transcript,
                },
                default
            );

        verdict.Pass.Should().BeTrue();
    }

    [Fact]
    public async Task RunAsync_ScenarioOfAnotherKind_IsRefused()
    {
        var act = () =>
            Runner()
                .RunAsync(
                    RunnerFixtures.Scenario(ScenarioKind.Rest),
                    RunnerFixtures.Context(new ScriptedParticipant("hi")),
                    default
                );

        (await act.Should().ThrowAsync<ArgumentException>()).WithMessage("*mcp*");
    }

    [Fact]
    public async Task RunAsync_NullScenario_Throws()
    {
        var act = () => Runner().RunAsync(null!, RunnerFixtures.Context(new ScriptedParticipant("hi")), default);

        await act.Should().ThrowAsync<ArgumentNullException>();
    }

    [Fact]
    public async Task RunAsync_NullContext_Throws()
    {
        var act = () => Runner().RunAsync(RunnerFixtures.Scenario(ScenarioKind.Mcp), null!, default);

        await act.Should().ThrowAsync<ArgumentNullException>();
    }

    [Fact]
    public async Task RunAsync_CancelledToken_PropagatesTheCancellation()
    {
        using var cancellation = new CancellationTokenSource();
        await cancellation.CancelAsync();

        var act = () =>
            Runner()
                .RunAsync(
                    RunnerFixtures.Scenario(ScenarioKind.Mcp),
                    RunnerFixtures.Context(new ScriptedParticipant("hi")),
                    cancellation.Token
                );

        await act.Should().ThrowAsync<OperationCanceledException>();
    }

    /// <summary>The participant is never consulted: there is no transport to drive it over.</summary>
    [Fact]
    public async Task RunAsync_McpScenario_NeverAsksTheParticipantForAStimulus()
    {
        var participant = new ScriptedParticipant("hi");

        await Runner()
            .RunAsync(RunnerFixtures.Scenario(ScenarioKind.Mcp), RunnerFixtures.Context(participant), default);

        participant.Asks.Should().Be(0);
    }

    /// <summary>
    /// A mixed suite routes by kind and every runner returns a transcript. Nothing in this loop
    /// knows that one of them is a stub.
    /// </summary>
    [Fact]
    public async Task RunAsync_MixedSuite_RoutesEveryScenarioWithoutTakingDownTheRun()
    {
        using var handler = new StubHandler(new StubbedReply());
        IReadOnlyList<IScenarioRunner> runners = [RunnerFixtures.Runner(handler, new StubExchange()), Runner()];
        var scenarios = new[]
        {
            RunnerFixtures.Scenario(ScenarioKind.Rest, id: "rest-a"),
            RunnerFixtures.Scenario(ScenarioKind.Mcp, id: "mcp-a"),
            RunnerFixtures.Scenario(ScenarioKind.Rest, id: "rest-b"),
        };

        var transcripts = new List<Transcript>();
        foreach (var scenario in scenarios)
        {
            var runner = runners.Single(candidate => candidate.Kind == scenario.Identity.Kind);
            transcripts.Add(
                await runner.RunAsync(scenario, RunnerFixtures.Context(new ScriptedParticipant("hi")), default)
            );
        }

        transcripts.Select(transcript => transcript.ScenarioId).Should().Equal("rest-a", "mcp-a", "rest-b");
        transcripts
            .Select(transcript => ExchangeState.IsHarnessFailure(ExchangeState.Of(transcript)))
            .Should()
            .Equal(false, true, false);
    }
}

/// <summary>
/// The exchange vocabulary is read across stages, so its classification is pinned here rather than
/// left to whichever stage happens to read it.
/// </summary>
public sealed class ExchangeStateTests
{
    [Theory]
    [InlineData(ExchangeState.Responded)]
    [InlineData(ExchangeState.MalformedResponse)]
    public void IsHarnessFailure_StateThatProducedEvidence_IsFalse(string state) =>
        ExchangeState.IsHarnessFailure(state).Should().BeFalse();

    [Theory]
    [InlineData(ExchangeState.TimedOut)]
    [InlineData(ExchangeState.RequestFailed)]
    [InlineData(ExchangeState.NotAttempted)]
    [InlineData(ExchangeState.Unsupported)]
    public void IsHarnessFailure_StateThatGatheredNothing_IsTrue(string state) =>
        ExchangeState.IsHarnessFailure(state).Should().BeTrue();

    /// <summary>
    /// Fails closed. Reading "I do not know what happened" as "nothing went wrong" is the shape of
    /// every false green this library guards against.
    /// </summary>
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("Responded")]
    [InlineData("somethingNobodyHasWrittenYet")]
    public void IsHarnessFailure_AbsentOrUnrecognisedState_IsTrue(string? state) =>
        ExchangeState.IsHarnessFailure(state).Should().BeTrue();

    [Fact]
    public void Of_TranscriptWithoutTheAttribute_IsNull() => ExchangeState.Of(TestData.Transcript()).Should().BeNull();

    [Fact]
    public void Of_NullTranscript_Throws()
    {
        var act = () => ExchangeState.Of(null!);

        act.Should().Throw<ArgumentNullException>();
    }
}
