using FluentAssertions;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Runners;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Serialization;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Tests.Runners;

/// <summary>
/// The UI stub reports an unsupported transport cleanly, by exactly the path the MCP stub already
/// reports one. A mixed suite containing UI scenarios must still load and route; the UI scenario
/// yields an observable unsupported signal rather than taking down the run.
/// </summary>
public sealed class NotImplementedUiRunnerTests
{
    private static NotImplementedUiRunner Runner() => new(new FrozenClock(RunnerFixtures.Instant));

    [Fact]
    public void Constructor_NullClock_Throws()
    {
        var act = () => new NotImplementedUiRunner(null!);

        act.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Kind_Always_IsUi() => Runner().Kind.Should().Be(ScenarioKind.Ui);

    [Fact]
    public async Task RunAsync_UiScenario_ReturnsATranscriptRatherThanThrowing()
    {
        var transcript = await Runner()
            .RunAsync(
                RunnerFixtures.Scenario(ScenarioKind.Ui, id: "checkout-probe"),
                RunnerFixtures.Context(new ScriptedParticipant("click #buy"), seed: 1234),
                default
            );

        transcript.ScenarioId.Should().Be("checkout-probe");
        transcript.Seed.Should().Be(1234);
        transcript.StartedAt.Should().Be(RunnerFixtures.Instant);
    }

    [Fact]
    public async Task RunAsync_UiScenario_RecordsTheUnsupportedSignalObservably()
    {
        var transcript = await Runner()
            .RunAsync(
                RunnerFixtures.Scenario(ScenarioKind.Ui),
                RunnerFixtures.Context(new ScriptedParticipant("click #buy")),
                default
            );

        transcript.Transport.Kind.Should().Be("ui");
        RunnerFixtures.Attribute(transcript, TransportAttributes.Exchange).Should().Be(ExchangeState.Unsupported);
        RunnerFixtures.Attribute(transcript, TransportAttributes.StoppedBy).Should().Be(StopReason.Unsupported);
        RunnerFixtures
            .Attribute(transcript, TransportAttributes.Failure)
            .Should()
            .NotBeNullOrWhiteSpace()
            .And.Contain("ui");
    }

    /// <summary>
    /// The decisive property: unsupported is a harness failure, so a suite of entirely unsupported
    /// scenarios cannot report as clean.
    /// </summary>
    [Fact]
    public async Task RunAsync_UiScenario_ClassifiesAsAHarnessFailure()
    {
        var transcript = await Runner()
            .RunAsync(
                RunnerFixtures.Scenario(ScenarioKind.Ui),
                RunnerFixtures.Context(new ScriptedParticipant("click #buy")),
                default
            );

        ExchangeState.IsHarnessFailure(ExchangeState.Of(transcript)).Should().BeTrue();
    }

    /// <summary>
    /// No turn ran and nothing was observed, so nothing may look like evidence about the system.
    /// </summary>
    [Fact]
    public async Task RunAsync_UiScenario_ObservesNothingAboutTheSystemUnderTest()
    {
        var transcript = await Runner()
            .RunAsync(
                RunnerFixtures.Scenario(ScenarioKind.Ui),
                RunnerFixtures.Context(new ScriptedParticipant("click #buy")),
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
    public async Task RunAsync_UiScenario_IsAssertableThroughTheOrdinaryEvaluators()
    {
        var transcript = await Runner()
            .RunAsync(
                RunnerFixtures.Scenario(ScenarioKind.Ui, id: "checkout-probe"),
                RunnerFixtures.Context(new ScriptedParticipant("click #buy")),
                default
            );

        var verdict = await AssertionEvaluatorRegistry
            .CreateDefault()
            .EvaluateAsync(
                AssertionSpec.Parse("expectedBehavior:transport/exchange=unsupported"),
                new EvaluationContext
                {
                    ScenarioId = "checkout-probe",
                    Grading = new Grading(),
                    Transcript = transcript,
                },
                default
            );

        verdict.Pass.Should().BeTrue();
    }

    /// <summary>
    /// The claim this stub has to earn: it is classified through the <i>same</i>
    /// <see cref="ExchangeState"/> path the MCP stub is, not a parallel one that happens to look
    /// similar. Everything outside the transport block is byte-identical for the same run, and the
    /// transport block differs only in the transport it names and the reason it gives.
    /// </summary>
    [Fact]
    public async Task RunAsync_UiScenario_IsClassifiedExactlyAsTheMcpStubIs()
    {
        var context = RunnerFixtures.Context(new ScriptedParticipant("click #buy"), seed: 99);
        var clock = new FrozenClock(RunnerFixtures.Instant);
        var ui = await new NotImplementedUiRunner(clock).RunAsync(
            RunnerFixtures.Scenario(ScenarioKind.Ui, id: "shared"),
            context,
            default
        );
        var mcp = await new NotImplementedMcpRunner(clock).RunAsync(
            RunnerFixtures.Scenario(ScenarioKind.Mcp, id: "shared"),
            context,
            default
        );

        WithoutTransport(ui).Should().Be(WithoutTransport(mcp));
        TransportKeys(ui).Should().Equal(TransportKeys(mcp));
        RunnerFixtures
            .Attribute(ui, TransportAttributes.Exchange)
            .Should()
            .Be(RunnerFixtures.Attribute(mcp, TransportAttributes.Exchange));
        RunnerFixtures
            .Attribute(ui, TransportAttributes.StoppedBy)
            .Should()
            .Be(RunnerFixtures.Attribute(mcp, TransportAttributes.StoppedBy));
    }

    [Fact]
    public async Task RunAsync_ScenarioOfAnotherKind_IsRefused()
    {
        var act = () =>
            Runner()
                .RunAsync(
                    RunnerFixtures.Scenario(ScenarioKind.Rest),
                    RunnerFixtures.Context(new ScriptedParticipant("click #buy")),
                    default
                );

        (await act.Should().ThrowAsync<ArgumentException>()).WithMessage("*ui*");
    }

    [Fact]
    public async Task RunAsync_NullScenario_Throws()
    {
        var act = () =>
            Runner().RunAsync(null!, RunnerFixtures.Context(new ScriptedParticipant("click #buy")), default);

        await act.Should().ThrowAsync<ArgumentNullException>();
    }

    [Fact]
    public async Task RunAsync_NullContext_Throws()
    {
        var act = () => Runner().RunAsync(RunnerFixtures.Scenario(ScenarioKind.Ui), null!, default);

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
                    RunnerFixtures.Scenario(ScenarioKind.Ui),
                    RunnerFixtures.Context(new ScriptedParticipant("click #buy")),
                    cancellation.Token
                );

        await act.Should().ThrowAsync<OperationCanceledException>();
    }

    /// <summary>The participant is never consulted: there is no transport to drive it over.</summary>
    [Fact]
    public async Task RunAsync_UiScenario_NeverAsksTheParticipantForAStimulus()
    {
        var participant = new ScriptedParticipant("click #buy");

        await Runner().RunAsync(RunnerFixtures.Scenario(ScenarioKind.Ui), RunnerFixtures.Context(participant), default);

        participant.Asks.Should().Be(0);
    }

    private static string WithoutTransport(Transcript transcript) =>
        CanonicalJson.Serialize(transcript with { Transport = new TransportMetadata() });

    private static IEnumerable<string> TransportKeys(Transcript transcript) =>
        transcript.Transport.Attributes.Keys.Order(StringComparer.Ordinal);
}
