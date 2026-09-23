using FluentAssertions;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Runners;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Tests.Runners;

/// <summary>
/// The conversation runner.
/// </summary>
/// <remarks>
/// The property that separates this runner from <see cref="RestRunner"/> is that <b>it will not
/// let anything else decide when to stop</b>. A REST scenario ends because its participant runs
/// out of script; a model-driven conversation has no such floor, so the cap is the runner's and
/// nothing — not the scenario, not the participant, not the system under test — can raise it.
/// </remarks>
public sealed class LlmConversationRunnerTests
{
    private static Task<Transcript> Run(
        LlmConversationRunner runner,
        IParticipant participant,
        Scenario? scenario = null,
        CancellationToken cancellationToken = default
    ) =>
        runner.RunAsync(
            scenario ?? ConversationFixtures.Scenario(),
            RunnerFixtures.Context(participant),
            cancellationToken
        );

    // ---- The cap belongs to the harness -----------------------------------------------------

    /// <summary>
    /// The case the loader can only warn about: a simulated caller with no declared ceiling. A
    /// warning cannot stop a suite that ships with it unresolved; this can.
    /// </summary>
    [Fact]
    public async Task RunAsync_ParticipantNeverCompletesAndNoCeilingDeclared_StopsAtTheRunnersCeiling()
    {
        var exchange = new StubConversationExchange();
        var runner = ConversationFixtures.Runner(exchange, maxTurnCeiling: 5);

        var transcript = await Run(runner, new NeverCompletingParticipant());

        transcript.Turns.Should().HaveCount(5);
        RunnerFixtures.Attribute(transcript, TransportAttributes.StoppedBy).Should().Be(StopReason.TurnCeiling);
    }

    /// <summary>
    /// A scenario may narrow the cap. It may not widen it — the author is not the component that
    /// gets to decide how long a model-driven conversation runs against a metered provider.
    /// </summary>
    [Fact]
    public async Task RunAsync_ScenarioDeclaresACeilingAboveTheRunners_StopsAtTheRunners()
    {
        var exchange = new StubConversationExchange();
        var runner = ConversationFixtures.Runner(exchange, maxTurnCeiling: 3);

        var transcript = await Run(
            runner,
            new NeverCompletingParticipant(),
            ConversationFixtures.Scenario(maxTurns: 500)
        );

        transcript.Turns.Should().HaveCount(3);
        exchange.Seen.Should().HaveCount(3);
    }

    [Fact]
    public async Task RunAsync_ScenarioDeclaresACeilingBelowTheRunners_StopsAtTheScenarios()
    {
        var exchange = new StubConversationExchange();
        var runner = ConversationFixtures.Runner(exchange, maxTurnCeiling: 9);

        var transcript = await Run(
            runner,
            new NeverCompletingParticipant(),
            ConversationFixtures.Scenario(maxTurns: 2)
        );

        transcript.Turns.Should().HaveCount(2);
    }

    /// <summary>The boundary itself: exactly the cap, never one more and never one fewer.</summary>
    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(12)]
    public async Task RunAsync_CapIsReached_RecordsExactlyThatManyTurns(int cap)
    {
        var exchange = new StubConversationExchange();
        var runner = ConversationFixtures.Runner(exchange, maxTurnCeiling: cap);

        var transcript = await Run(runner, new NeverCompletingParticipant());

        transcript.Turns.Should().HaveCount(cap);
        transcript.Turns.Select(turn => turn.Index).Should().Equal(Enumerable.Range(1, cap));
    }

    [Theory]
    [InlineData(null, 12, 12)]
    [InlineData(500, 12, 12)]
    [InlineData(2, 12, 2)]
    [InlineData(12, 12, 12)]
    [InlineData(13, 12, 12)]
    [InlineData(1, 12, 1)]
    public void EffectiveTurnCap_AnyDeclaration_NeverExceedsTheRunnersCeiling(int? declared, int ceiling, int expected)
    {
        var runner = ConversationFixtures.Runner(new StubConversationExchange(), maxTurnCeiling: ceiling);

        runner.EffectiveTurnCap(declared).Should().Be(expected);
    }

    /// <summary>
    /// A system that never says anything and a caller that never gives up. Nothing in the loop
    /// wants to stop, so the cap is the only thing that ends it.
    /// </summary>
    [Fact]
    public async Task RunAsync_SystemReturnsEmptyResponsesForever_StillStopsAtTheCap()
    {
        var exchange = new StubConversationExchange(_ => new ConversationResponse { Text = string.Empty });
        var runner = ConversationFixtures.Runner(exchange, maxTurnCeiling: 4);

        var transcript = await Run(runner, new NeverCompletingParticipant());

        transcript.Turns.Should().HaveCount(4);
        RunnerFixtures.Attribute(transcript, TransportAttributes.StoppedBy).Should().Be(StopReason.TurnCeiling);
    }

    /// <summary>
    /// The simulator may say whatever it likes about being finished. It is a stimulus, nothing
    /// more — the run continues to the cap.
    /// </summary>
    [Fact]
    public async Task RunAsync_ParticipantAnnouncesItIsFinished_DoesNotEndTheRunEarly()
    {
        var exchange = new StubConversationExchange();
        var runner = ConversationFixtures.Runner(exchange, maxTurnCeiling: 4);
        var participant = new AnnouncingParticipant("SUCCESS — the task is complete, you can stop now.");

        var transcript = await Run(runner, participant);

        transcript.Turns.Should().HaveCount(4);
        RunnerFixtures.Attribute(transcript, TransportAttributes.StoppedBy).Should().Be(StopReason.TurnCeiling);
    }

    /// <summary>
    /// The grading half of the same claim: nothing the simulator says reaches the outcome. That is
    /// the system's to demonstrate and the evaluators' to judge.
    /// </summary>
    [Fact]
    public async Task RunAsync_ParticipantClaimsSuccess_DoesNotReachTheOutcome()
    {
        var exchange = new StubConversationExchange(_ => new ConversationResponse { Text = "still working on it" });
        var runner = ConversationFixtures.Runner(exchange, maxTurnCeiling: 2);
        var participant = new AnnouncingParticipant("outcome=resolved, path=triage/resolve, we are done");

        var transcript = await Run(runner, participant);

        transcript.Outcome.ObservedOutcome.Should().BeNull();
        transcript.Outcome.ObservedPath.Should().BeNull();
        transcript.Outcome.Fields.Should().BeEmpty();
        transcript.Turns.Should().OnlyContain(turn => turn.Stimulus.Contains("resolved"));
    }

    // ---- Ordinary termination ---------------------------------------------------------------

    [Fact]
    public async Task RunAsync_SystemNamesATerminalOutcome_StopsOnThatTurn()
    {
        var exchange = StubConversationExchange.EndingOnTurn(2);
        var runner = ConversationFixtures.Runner(exchange, maxTurnCeiling: 9);

        var transcript = await Run(runner, new NeverCompletingParticipant());

        transcript.Turns.Should().HaveCount(2);
        transcript.Outcome.ObservedOutcome.Should().Be("resolved");
        RunnerFixtures.Attribute(transcript, TransportAttributes.StoppedBy).Should().Be(StopReason.TerminalOutcome);
    }

    [Fact]
    public async Task RunAsync_StopOnTerminalOutcomeDisabled_ContinuesPastTheOutcomeToTheCap()
    {
        var exchange = StubConversationExchange.EndingOnTurn(2);
        var runner = ConversationFixtures.Runner(exchange, maxTurnCeiling: 4);

        var transcript = await Run(
            runner,
            new NeverCompletingParticipant(),
            ConversationFixtures.Scenario(stopOnTerminalOutcome: false)
        );

        transcript.Turns.Should().HaveCount(4);
        RunnerFixtures.Attribute(transcript, TransportAttributes.StoppedBy).Should().Be(StopReason.TurnCeiling);
    }

    [Fact]
    public async Task RunAsync_ParticipantCompletes_StopsWithParticipantComplete()
    {
        var exchange = new StubConversationExchange();
        var runner = ConversationFixtures.Runner(exchange, maxTurnCeiling: 9);

        var transcript = await Run(runner, new ScriptedParticipant("one", "two"));

        transcript.Turns.Should().HaveCount(2);
        RunnerFixtures.Attribute(transcript, TransportAttributes.StoppedBy).Should().Be(StopReason.ParticipantComplete);
        RunnerFixtures.Attribute(transcript, TransportAttributes.Exchange).Should().Be(ExchangeState.Responded);
    }

    [Fact]
    public async Task RunAsync_ParticipantCompletesBeforeTheFirstTurn_RecordsNotAttempted()
    {
        var exchange = new StubConversationExchange();
        var runner = ConversationFixtures.Runner(exchange);

        var transcript = await Run(runner, new ScriptedParticipant());

        transcript.Turns.Should().BeEmpty();
        exchange.Seen.Should().BeEmpty();
        RunnerFixtures.Attribute(transcript, TransportAttributes.Exchange).Should().Be(ExchangeState.NotAttempted);
        ExchangeState.IsHarnessFailure(ExchangeState.Of(transcript)).Should().BeTrue();
    }

    // ---- Failures -----------------------------------------------------------------------------

    /// <summary>
    /// The adapter read the reply and rejected it. That is a verdict about the <i>system</i>, so
    /// the run stays gradeable and a suite asserting on malformed output still catches it.
    /// </summary>
    [Fact]
    public async Task RunAsync_AdapterReportsAMalformedResponse_StaysGradeable()
    {
        var exchange = new StubConversationExchange
        {
            Throws = _ => new MalformedResponseException("not the agreed shape"),
        };
        var runner = ConversationFixtures.Runner(exchange);

        var transcript = await Run(runner, new NeverCompletingParticipant());

        RunnerFixtures.Attribute(transcript, TransportAttributes.Exchange).Should().Be(ExchangeState.MalformedResponse);
        RunnerFixtures.Attribute(transcript, TransportAttributes.StoppedBy).Should().Be(StopReason.ExchangeFailed);
        ExchangeState.IsHarnessFailure(ExchangeState.Of(transcript)).Should().BeFalse();
    }

    /// <summary>
    /// The adapter fell over. It reached no verdict, so grading the run would let a defective
    /// adapter manufacture a passing assertion about a system it never read.
    /// </summary>
    [Fact]
    public async Task RunAsync_AdapterThrowsSomethingElse_RecordsAdapterFailed()
    {
        var exchange = new StubConversationExchange { Throws = _ => new InvalidCastException("bad index") };
        var runner = ConversationFixtures.Runner(exchange);

        var transcript = await Run(runner, new NeverCompletingParticipant());

        RunnerFixtures.Attribute(transcript, TransportAttributes.Exchange).Should().Be(ExchangeState.AdapterFailed);
        ExchangeState.IsHarnessFailure(ExchangeState.Of(transcript)).Should().BeTrue();
    }

    [Fact]
    public async Task RunAsync_AdapterReturnsNull_RecordsAdapterFailed()
    {
        var exchange = new StubConversationExchange(_ => null);
        var runner = ConversationFixtures.Runner(exchange);

        var transcript = await Run(runner, new NeverCompletingParticipant());

        RunnerFixtures.Attribute(transcript, TransportAttributes.Exchange).Should().Be(ExchangeState.AdapterFailed);
    }

    [Fact]
    public async Task RunAsync_AdapterThrowsHttpRequestException_RecordsRequestFailed()
    {
        var exchange = new StubConversationExchange { Throws = _ => new HttpRequestException("no route") };
        var runner = ConversationFixtures.Runner(exchange);

        var transcript = await Run(runner, new NeverCompletingParticipant());

        RunnerFixtures.Attribute(transcript, TransportAttributes.Exchange).Should().Be(ExchangeState.RequestFailed);
    }

    [Fact]
    public async Task RunAsync_AdapterTimesOut_RecordsTimedOut()
    {
        var exchange = new StubConversationExchange
        {
            Throws = _ => new OperationCanceledException("the provider took too long"),
        };
        var runner = ConversationFixtures.Runner(exchange);

        var transcript = await Run(runner, new NeverCompletingParticipant());

        RunnerFixtures.Attribute(transcript, TransportAttributes.Exchange).Should().Be(ExchangeState.TimedOut);
    }

    /// <summary>
    /// The caller could not say what comes next — its model call failed, or the replaying client
    /// held no recording. Nothing was tested, so the run must not be gradeable.
    /// </summary>
    [Fact]
    public async Task RunAsync_ParticipantFails_RecordsParticipantFailedAsAHarnessFailure()
    {
        var exchange = new StubConversationExchange();
        var runner = ConversationFixtures.Runner(exchange);

        var transcript = await Run(runner, new FailingParticipant(new InvalidOperationException("no recording")));

        RunnerFixtures.Attribute(transcript, TransportAttributes.Exchange).Should().Be(ExchangeState.ParticipantFailed);
        RunnerFixtures.Attribute(transcript, TransportAttributes.StoppedBy).Should().Be(StopReason.ParticipantFailed);
        ExchangeState.IsHarnessFailure(ExchangeState.Of(transcript)).Should().BeTrue();
    }

    [Fact]
    public async Task RunAsync_ParticipantFailsAfterSomeTurns_KeepsTheTurnsThatHappened()
    {
        var exchange = new StubConversationExchange();
        var runner = ConversationFixtures.Runner(exchange, maxTurnCeiling: 9);

        var transcript = await Run(
            runner,
            new FailingParticipant(new InvalidOperationException("the model said nothing usable"), failOnAsk: 3)
        );

        transcript.Turns.Should().HaveCount(2);
        RunnerFixtures.Attribute(transcript, TransportAttributes.Exchange).Should().Be(ExchangeState.ParticipantFailed);
    }

    /// <summary>
    /// T7 finding 5. A provider timeout surfaces as an <see cref="OperationCanceledException"/>
    /// even though the run's own token is untouched, and it missed both participant clauses —
    /// so one caller's timeout propagated and took down the whole suite. A caller that could not
    /// say what comes next has tested nothing, whatever exception type it used to say so.
    /// </summary>
    [Fact]
    public async Task RunAsync_ParticipantCancelsWhileTheRunTokenIsUntouched_RecordsParticipantFailed()
    {
        var exchange = new StubConversationExchange();
        var runner = ConversationFixtures.Runner(exchange);

        var transcript = await Run(
            runner,
            new FailingParticipant(new OperationCanceledException("the provider took too long"))
        );

        transcript.Turns.Should().BeEmpty();
        RunnerFixtures.Attribute(transcript, TransportAttributes.Exchange).Should().Be(ExchangeState.ParticipantFailed);
        RunnerFixtures.Attribute(transcript, TransportAttributes.StoppedBy).Should().Be(StopReason.ParticipantFailed);
        ExchangeState.IsHarnessFailure(ExchangeState.Of(transcript)).Should().BeTrue();
    }

    /// <summary>
    /// A failure message is authored by whatever threw it and routinely names an endpoint, a model
    /// deployment, or a key. The transcript is committed, so it is withheld by default (§V).
    /// </summary>
    [Fact]
    public async Task RunAsync_EvidenceNotRetained_KeepsTheExceptionMessageOutOfTheTranscript()
    {
        const string Leak = "api-key=abcd1234 at https://provider.invalid/v1";
        var exchange = new StubConversationExchange { Throws = _ => new InvalidCastException(Leak) };
        var runner = ConversationFixtures.Runner(exchange);

        var transcript = await Run(runner, new NeverCompletingParticipant());

        RunnerFixtures.Attribute(transcript, TransportAttributes.Failure).Should().NotContain(Leak);
        EvalEngine.Serialization.CanonicalJson.Serialize(transcript).Should().NotContain("abcd1234");
    }

    [Fact]
    public async Task RunAsync_EvidenceRetained_RecordsTheExceptionMessage()
    {
        var exchange = new StubConversationExchange { Throws = _ => new InvalidCastException("bad index 7") };
        var runner = ConversationFixtures.Runner(exchange, retainUnredactedEvidence: true);

        var transcript = await Run(runner, new NeverCompletingParticipant());

        RunnerFixtures.Attribute(transcript, TransportAttributes.Failure).Should().Contain("bad index 7");
    }

    // ---- Adapter defects are surfaced, not recorded ------------------------------------------

    /// <summary>
    /// A transcript that named its scenario kind would let every downstream stage branch on it,
    /// undoing the one property the engine exists to hold. An adapter must not be able to stamp
    /// one in through the open transport vocabulary.
    /// </summary>
    [Theory]
    [InlineData("Llm")]
    [InlineData("llm")]
    [InlineData("Rest")]
    [InlineData("mcp")]
    public async Task RunAsync_AdapterNamesAScenarioKindAsItsTransport_ThrowsInvalidOperationException(string kind)
    {
        var runner = ConversationFixtures.Runner(new StubConversationExchange { TransportKind = kind });

        var run = async () => await Run(runner, new NeverCompletingParticipant());

        await run.Should().ThrowAsync<InvalidOperationException>();
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public async Task RunAsync_AdapterReportsABlankTransport_ThrowsInvalidOperationException(string kind)
    {
        var runner = ConversationFixtures.Runner(new StubConversationExchange { TransportKind = kind });

        var run = async () => await Run(runner, new NeverCompletingParticipant());

        await run.Should().ThrowAsync<InvalidOperationException>();
    }

    [Fact]
    public async Task RunAsync_ScenarioDeclaresAnotherKind_ThrowsArgumentException()
    {
        var runner = ConversationFixtures.Runner(new StubConversationExchange());

        var run = async () =>
            await runner.RunAsync(
                RunnerFixtures.Scenario(ScenarioKind.Rest),
                RunnerFixtures.Context(new NeverCompletingParticipant()),
                default
            );

        await run.Should().ThrowAsync<ArgumentException>();
    }

    [Fact]
    public async Task RunAsync_NullArgument_ThrowsArgumentNullException()
    {
        var runner = ConversationFixtures.Runner(new StubConversationExchange());

        var nullScenario = async () =>
            await runner.RunAsync(null!, RunnerFixtures.Context(new NeverCompletingParticipant()), default);
        var nullContext = async () => await runner.RunAsync(ConversationFixtures.Scenario(), null!, default);

        await nullScenario.Should().ThrowAsync<ArgumentNullException>();
        await nullContext.Should().ThrowAsync<ArgumentNullException>();
    }

    [Fact]
    public void Constructor_NullArgument_ThrowsArgumentNullException()
    {
        Action nullExchange = () => _ = new LlmConversationRunner(null!, new FrozenClock(RunnerFixtures.Instant));
        Action nullClock = () => _ = new LlmConversationRunner(new StubConversationExchange(), null!);
        Action nullOptions = () =>
            _ = new LlmConversationRunner(
                new StubConversationExchange(),
                new FrozenClock(RunnerFixtures.Instant),
                null!
            );

        nullExchange.Should().Throw<ArgumentNullException>();
        nullClock.Should().Throw<ArgumentNullException>();
        nullOptions.Should().Throw<ArgumentNullException>();
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-4)]
    public void MaxTurnCeiling_BelowOne_ThrowsArgumentOutOfRangeException(int ceiling)
    {
        Action build = () => _ = new LlmConversationRunnerOptions { MaxTurnCeiling = ceiling };

        build.Should().Throw<ArgumentOutOfRangeException>();
    }

    // ---- Cancellation -------------------------------------------------------------------------

    [Fact]
    public async Task RunAsync_CancelledBeforeStarting_NeverContactsTheSystem()
    {
        var exchange = new StubConversationExchange();
        var runner = ConversationFixtures.Runner(exchange);
        using var cancellation = new CancellationTokenSource();
        await cancellation.CancelAsync();

        var run = async () => await Run(runner, new NeverCompletingParticipant(), null, cancellation.Token);

        await run.Should().ThrowAsync<OperationCanceledException>();
        exchange.Seen.Should().BeEmpty();
    }

    /// <summary>
    /// Cancellation must halt the conversation <b>mid-flight</b>, not after it has run to the cap.
    /// A transcript for an abandoned run would hand the aggregator a result nobody waited for.
    /// </summary>
    [Fact]
    public async Task RunAsync_CancelledDuringATurn_HaltsMidConversationRatherThanRunningToTheCap()
    {
        using var cancellation = new CancellationTokenSource();
        var exchange = new StubConversationExchange
        {
            BeforeReplying = stimulus =>
            {
                if (stimulus.TurnIndex == 2)
                {
                    cancellation.Cancel();
                }
            },
        };
        var runner = ConversationFixtures.Runner(exchange, maxTurnCeiling: 20);

        var run = async () => await Run(runner, new NeverCompletingParticipant(), null, cancellation.Token);

        await run.Should().ThrowAsync<OperationCanceledException>();
        exchange.Seen.Should().HaveCount(2, because: "the loop must stop on the turn that was cancelled");
    }

    /// <summary>
    /// Cancellation raised inside the participant is the caller abandoning the run, not the
    /// participant failing. It must propagate rather than be recorded as a harness failure.
    /// </summary>
    [Fact]
    public async Task RunAsync_CancelledInsideTheParticipant_PropagatesRatherThanRecording()
    {
        using var cancellation = new CancellationTokenSource();
        var runner = ConversationFixtures.Runner(new StubConversationExchange(), maxTurnCeiling: 20);
        await cancellation.CancelAsync();

        var run = async () =>
            await Run(
                runner,
                new FailingParticipant(new OperationCanceledException(cancellation.Token)),
                null,
                cancellation.Token
            );

        await run.Should().ThrowAsync<OperationCanceledException>();
    }

    /// <summary>A participant whose every stimulus makes the same announcement.</summary>
    private sealed class AnnouncingParticipant(string announcement) : IParticipant
    {
        public ValueTask<ParticipantTurn> NextAsync(Transcript transcriptSoFar, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();

            return new ValueTask<ParticipantTurn>(ParticipantTurn.Next(announcement, TurnProvenance.Synthesized));
        }
    }
}
