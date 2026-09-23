using System.Net;
using FluentAssertions;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Participants;
using Forge.EvalEngine.Runners;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Tests.Runners;

/// <summary>
/// The REST runner conducts one execution and returns a transcript. It knows the transport and the
/// turn-taking, and nothing else: it does not repeat, and it does not grade.
/// </summary>
public sealed class RestRunnerTests
{
    [Fact]
    public void Constructor_NullClient_Throws()
    {
        var act = () => new RestRunner(null!, new StubExchange(), new FrozenClock(RunnerFixtures.Instant));

        act.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Constructor_NullExchange_Throws()
    {
        using var handler = new StubHandler(new StubbedReply());
        var act = () => new RestRunner(RunnerFixtures.Client(handler), null!, new FrozenClock(RunnerFixtures.Instant));

        act.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Constructor_NullClock_Throws()
    {
        using var handler = new StubHandler(new StubbedReply());
        var act = () => new RestRunner(RunnerFixtures.Client(handler), new StubExchange(), null!);

        act.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Kind_Always_IsRest()
    {
        using var handler = new StubHandler(new StubbedReply());

        RunnerFixtures.Runner(handler, new StubExchange()).Kind.Should().Be(ScenarioKind.Rest);
    }

    [Fact]
    public async Task RunAsync_NullScenario_Throws()
    {
        using var handler = new StubHandler(new StubbedReply());
        var runner = RunnerFixtures.Runner(handler, new StubExchange());

        var act = () => runner.RunAsync(null!, RunnerFixtures.Context(new ScriptedParticipant("hi")), default);

        await act.Should().ThrowAsync<ArgumentNullException>();
    }

    [Fact]
    public async Task RunAsync_NullContext_Throws()
    {
        using var handler = new StubHandler(new StubbedReply());
        var runner = RunnerFixtures.Runner(handler, new StubExchange());

        var act = () => runner.RunAsync(RunnerFixtures.Scenario(), null!, default);

        await act.Should().ThrowAsync<ArgumentNullException>();
    }

    /// <summary>
    /// Mis-routing a scenario to the wrong runner is a harness fault, not a finding about the
    /// system under test, and a transcript produced from it would be graded as though it were one.
    /// </summary>
    [Theory]
    [InlineData(ScenarioKind.Mcp)]
    [InlineData(ScenarioKind.Llm)]
    public async Task RunAsync_ScenarioOfAnotherKind_IsRefused(ScenarioKind kind)
    {
        using var handler = new StubHandler(new StubbedReply());
        var runner = RunnerFixtures.Runner(handler, new StubExchange());

        var act = () =>
            runner.RunAsync(
                RunnerFixtures.Scenario(kind),
                RunnerFixtures.Context(new ScriptedParticipant("hi")),
                default
            );

        (await act.Should().ThrowAsync<ArgumentException>()).WithMessage("*rest*");
    }

    [Fact]
    public async Task RunAsync_OneTurnScenario_RecordsOneTurnWithItsStimulusResponseAndProvenance()
    {
        using var handler = new StubHandler(new StubbedReply { Body = "{\"outcome\":\"resolved\"}" });
        var runner = RunnerFixtures.Runner(handler, new StubExchange());

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("the opening")),
            default
        );

        transcript.Turns.Should().HaveCount(1);
        transcript.Turns[0].Index.Should().Be(1);
        transcript.Turns[0].Stimulus.Should().Be("the opening");
        transcript.Turns[0].Response.Should().Be("a response");
        transcript.Turns[0].Provenance.Should().Be(TurnProvenance.Scripted);
    }

    [Fact]
    public async Task RunAsync_OneTurnScenario_SendsTheStimulusThroughTheInjectedClient()
    {
        using var handler = new StubHandler(new StubbedReply());
        var runner = RunnerFixtures.Runner(handler, new StubExchange());

        await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("the opening")),
            default
        );

        handler.Requests.Should().HaveCount(1);
        handler.Bodies.Should().ContainSingle().Which.Should().Be("the opening");
    }

    [Fact]
    public async Task RunAsync_MultiTurnScenario_DrivesEveryStimulusTheParticipantOffers()
    {
        using var handler = new StubHandler(new StubbedReply());
        var runner = RunnerFixtures.Runner(handler, StubExchange.EndingOnTurn(3));

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("one", "two", "three")),
            default
        );

        transcript.Turns.Select(turn => turn.Stimulus).Should().Equal("one", "two", "three");
        transcript.Turns.Select(turn => turn.Index).Should().Equal(1, 2, 3);
        handler.Bodies.Should().Equal("one", "two", "three");
    }

    [Fact]
    public async Task RunAsync_MultiTurnScenario_TakesItsOutcomeFromTheTurnTheRunEndedOn()
    {
        using var handler = new StubHandler(new StubbedReply());
        var runner = RunnerFixtures.Runner(handler, StubExchange.EndingOnTurn(3));

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("one", "two", "three")),
            default
        );

        transcript.Outcome.ObservedOutcome.Should().Be("resolved");
        transcript.Outcome.ObservedPath.Should().Be("triage/resolve");
        transcript.Outcome.Fields.Should().ContainKey("scope/confirm");
    }

    [Fact]
    public async Task RunAsync_AnyRun_StampsTheScenarioIdAndSeedFromTheContext()
    {
        using var handler = new StubHandler(new StubbedReply());
        var runner = RunnerFixtures.Runner(handler, new StubExchange());

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(id: "throttle-probe"),
            RunnerFixtures.Context(new ScriptedParticipant("hi"), seed: 987654321),
            default
        );

        transcript.ScenarioId.Should().Be("throttle-probe");
        transcript.Seed.Should().Be(987654321);
    }

    [Fact]
    public async Task RunAsync_AnyRun_PassesTheRunsSeedAndRepetitionToTheAdapter()
    {
        using var handler = new StubHandler(new StubbedReply());
        var exchange = new StubExchange();
        var runner = RunnerFixtures.Runner(handler, exchange);

        await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("hi"), seed: 77, repetition: 4),
            default
        );

        exchange.Seen.Should().ContainSingle();
        exchange.Seen[0].Seed.Should().Be(77);
        exchange.Seen[0].Repetition.Should().Be(4);
        exchange.Seen[0].TurnIndex.Should().Be(1);
        exchange.Seen[0].Scenario.Identity.Id.Should().Be("scenario-a");
    }

    /// <summary>
    /// A frozen clock produces a zero duration. Any use of <c>DateTimeOffset.UtcNow</c> would
    /// produce a non-zero one, so this is the determinism guard rather than a timing assertion.
    /// </summary>
    [Fact]
    public async Task RunAsync_WithAFrozenClock_TimesTheRunEntirelyFromTheInjectedClock()
    {
        using var handler = new StubHandler(new StubbedReply());
        var runner = RunnerFixtures.Runner(handler, new StubExchange());

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("hi")),
            default
        );

        transcript.StartedAt.Should().Be(RunnerFixtures.Instant);
        transcript.Duration.Should().Be(TimeSpan.Zero);
        transcript.Turns[0].Elapsed.Should().Be(TimeSpan.Zero);
    }

    [Fact]
    public async Task RunAsync_WithATickingClock_RecordsPerTurnAndWholeRunTiming()
    {
        using var handler = new StubHandler(new StubbedReply());
        var clock = new TickingClock(RunnerFixtures.Instant, TimeSpan.FromMilliseconds(10));
        var runner = RunnerFixtures.Runner(handler, StubExchange.EndingOnTurn(2), clock);

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("one", "two")),
            default
        );

        transcript.StartedAt.Should().Be(RunnerFixtures.Instant);
        transcript.Turns.Should().OnlyContain(turn => turn.Elapsed > TimeSpan.Zero);
        transcript.Duration.Should().BeGreaterThan(transcript.Turns[0].Elapsed);
    }

    [Fact]
    public async Task RunAsync_AnyRun_RecordsTheTransportKindAndTheResolvedEndpoint()
    {
        using var handler = new StubHandler(new StubbedReply());
        var runner = RunnerFixtures.Runner(handler, new StubExchange { RequestUri = "eval/run" });

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("hi")),
            default
        );

        transcript.Transport.Kind.Should().Be("http");
        transcript.Transport.Endpoint.Should().Be("https://localhost:5001/eval/run");
        RunnerFixtures.Attribute(transcript, TransportAttributes.Method).Should().Be("POST");
    }

    /// <summary>
    /// The endpoint is written into a committed artifact, so credentials carried in the base
    /// address must not travel with it (§V).
    /// </summary>
    [Fact]
    public async Task RunAsync_BaseAddressCarryingCredentials_RecordsTheEndpointWithoutThem()
    {
        using var handler = new StubHandler(new StubbedReply());
        var client = RunnerFixtures.Client(handler, new Uri("https://evaluser:s3cr3t@localhost:5001/"));
        var runner = new RestRunner(client, new StubExchange(), new FrozenClock(RunnerFixtures.Instant));

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("hi")),
            default
        );

        transcript.Transport.Endpoint.Should().NotContain("s3cr3t").And.NotContain("evaluser");
        transcript.Transport.Endpoint.Should().Be("https://localhost:5001/eval");
    }

    [Fact]
    public async Task RunAsync_AnyRun_AlwaysRecordsAnExchangeStateAndAStopReason()
    {
        using var handler = new StubHandler(new StubbedReply());
        var runner = RunnerFixtures.Runner(handler, new StubExchange());

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("hi")),
            default
        );

        RunnerFixtures.Attribute(transcript, TransportAttributes.Exchange).Should().Be(ExchangeState.Responded);
        RunnerFixtures.Attribute(transcript, TransportAttributes.StoppedBy).Should().NotBeEmpty();
        transcript.Transport.Attributes.Should().NotContainKey(TransportAttributes.Failure);
    }

    /// <summary>
    /// The headline requirement: a scenario whose point is "this should throttle" passes when the
    /// system throttles. The status is outcome data, reached through the same evaluator any other
    /// assertion uses.
    /// </summary>
    [Fact]
    public async Task RunAsync_ThrottledResponse_IsOutcomeDataAScenarioCanAssertOnAndPass()
    {
        using var handler = new StubHandler(
            new StubbedReply { Status = HttpStatusCode.TooManyRequests, Body = "slow down" }
        );
        var runner = RunnerFixtures.Runner(handler, new StubExchange());

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(id: "throttle-probe"),
            RunnerFixtures.Context(new ScriptedParticipant("hi")),
            default
        );

        RunnerFixtures.Attribute(transcript, TransportAttributes.StatusCode).Should().Be("429");
        RunnerFixtures.Attribute(transcript, TransportAttributes.Exchange).Should().Be(ExchangeState.Responded);
        transcript
            .Turns.Should()
            .ContainSingle()
            .Which.Response.Should()
            .BeNull(because: "an error page never passed through the adapter's redaction");
        RunnerFixtures.Attribute(transcript, TransportAttributes.ResponseBodyLength).Should().Be("9");

        var verdict = await AssertionEvaluatorRegistry
            .CreateDefault()
            .EvaluateAsync(
                AssertionSpec.Parse("expectedBehavior:transport/statusCode=429"),
                new EvaluationContext
                {
                    ScenarioId = "throttle-probe",
                    Grading = new Grading(),
                    Transcript = transcript,
                },
                default
            );

        verdict.Pass.Should().BeTrue(because: "an expected refusal is a pass, not an error");
    }

    [Fact]
    public async Task RunAsync_UnexpectedServerError_IsRecordedRatherThanThrownAndEndsTheRun()
    {
        using var handler = new StubHandler(
            new StubbedReply { Status = HttpStatusCode.InternalServerError, Body = "boom" },
            new StubbedReply()
        );
        var runner = RunnerFixtures.Runner(handler, new StubExchange());

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("one", "two", "three")),
            default
        );

        RunnerFixtures.Attribute(transcript, TransportAttributes.StatusCode).Should().Be("500");
        RunnerFixtures.Attribute(transcript, TransportAttributes.StoppedBy).Should().Be(StopReason.ExchangeFailed);
        transcript.Turns.Should().ContainSingle(because: "a system that has already failed is not asked again");
        handler.Requests.Should().HaveCount(1);
    }

    /// <summary>
    /// A scenario that did <i>not</i> expect the failure is graded on the evidence and fails —
    /// rather than the runner throwing and the whole scenario never being graded at all.
    /// </summary>
    [Fact]
    public async Task RunAsync_UnexpectedServerError_LeavesTheOutcomeUnsetSoGradingFails()
    {
        using var handler = new StubHandler(new StubbedReply { Status = HttpStatusCode.InternalServerError });
        var runner = RunnerFixtures.Runner(handler, new StubExchange());

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("hi")),
            default
        );

        transcript.Outcome.ObservedOutcome.Should().BeNull();

        var verdict = await AssertionEvaluatorRegistry
            .CreateDefault()
            .EvaluateAsync(
                AssertionSpec.Parse("exactMatch:outcome"),
                new EvaluationContext
                {
                    ScenarioId = "scenario-a",
                    Grading = new Grading { ExpectedOutcome = "resolved" },
                    Transcript = transcript,
                },
                default
            );

        verdict.Pass.Should().BeFalse();
    }

    [Fact]
    public async Task RunAsync_NonSuccessStatus_DoesNotAskTheAdapterToInterpretTheBody()
    {
        using var handler = new StubHandler(new StubbedReply { Status = HttpStatusCode.BadGateway, Body = "<html/>" });
        var interpreted = false;
        var exchange = new StubExchange(_ =>
        {
            interpreted = true;

            return new RestResponse();
        });
        var runner = RunnerFixtures.Runner(handler, exchange);

        await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("hi")),
            default
        );

        interpreted.Should().BeFalse(because: "an error page is not the shape the adapter parses");
    }

    [Fact]
    public async Task RunAsync_EmptyResponseBody_IsInterpretedRatherThanTreatedAsMalformed()
    {
        using var handler = new StubHandler(
            new StubbedReply { Status = HttpStatusCode.NoContent, Body = string.Empty }
        );
        RestReply? seen = null;
        var exchange = new StubExchange(reply =>
        {
            seen = reply;

            return new RestResponse();
        });
        var runner = RunnerFixtures.Runner(handler, exchange);

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("hi")),
            default
        );

        seen.Should().NotBeNull();
        seen!.Body.Should().BeEmpty(because: "an empty body is empty text, never null");
        seen.StatusCode.Should().Be(204);
        RunnerFixtures.Attribute(transcript, TransportAttributes.Exchange).Should().Be(ExchangeState.Responded);
        transcript.Turns.Should().ContainSingle().Which.Response.Should().BeNull();
    }

    [Fact]
    public async Task RunAsync_AdapterReportsAMalformedBody_RecordsMalformedResponseWithStructuredEvidence()
    {
        using var handler = new StubHandler(new StubbedReply { Body = "not json at all" });
        var exchange = new StubExchange(_ => throw new MalformedResponseException("the body is not the agreed shape"));
        var runner = RunnerFixtures.Runner(handler, exchange);

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("hi")),
            default
        );

        RunnerFixtures.Attribute(transcript, TransportAttributes.Exchange).Should().Be(ExchangeState.MalformedResponse);
        RunnerFixtures
            .Attribute(transcript, TransportAttributes.Failure)
            .Should()
            .Contain(nameof(MalformedResponseException));
        transcript
            .Turns.Should()
            .ContainSingle()
            .Which.Response.Should()
            .BeNull(because: "a body nothing could interpret is not safe to commit by default");
        RunnerFixtures.Attribute(transcript, TransportAttributes.ResponseBodyLength).Should().Be("15");
        RunnerFixtures.Attribute(transcript, TransportAttributes.ResponseBodyHash).Should().NotBeEmpty();
        RunnerFixtures.Attribute(transcript, TransportAttributes.StoppedBy).Should().Be(StopReason.ExchangeFailed);
    }

    /// <summary>
    /// A body the adapter <i>reported</i> it could not read is the <i>system</i> misbehaving.
    /// Classifying it as a harness failure would excuse a real regression.
    /// </summary>
    [Fact]
    public async Task RunAsync_AdapterReportsAMalformedBody_IsNotClassifiedAsAHarnessFailure()
    {
        using var handler = new StubHandler(new StubbedReply { Body = "not json" });
        var exchange = new StubExchange(_ => throw new MalformedResponseException("nope"));
        var runner = RunnerFixtures.Runner(handler, exchange);

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("hi")),
            default
        );

        ExchangeState.IsHarnessFailure(ExchangeState.Of(transcript)).Should().BeFalse();
    }

    [Fact]
    public async Task RunAsync_TransportTimeout_IsRecordedAsTimedOutRatherThanThrown()
    {
        using var handler = new StubHandler(
            new StubbedReply { Throws = new TaskCanceledException("timed out", new TimeoutException()) }
        );
        var runner = RunnerFixtures.Runner(handler, new StubExchange());

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("hi")),
            default
        );

        RunnerFixtures.Attribute(transcript, TransportAttributes.Exchange).Should().Be(ExchangeState.TimedOut);
        RunnerFixtures.Attribute(transcript, TransportAttributes.Failure).Should().NotBeEmpty();
        RunnerFixtures.Attribute(transcript, TransportAttributes.StoppedBy).Should().Be(StopReason.ExchangeFailed);
        transcript.Turns.Should().ContainSingle().Which.Response.Should().BeNull();
        ExchangeState.IsHarnessFailure(ExchangeState.Of(transcript)).Should().BeTrue();
    }

    [Fact]
    public async Task RunAsync_RequestNeverReachesTheSystem_IsRecordedAsRequestFailedRatherThanThrown()
    {
        using var handler = new StubHandler(
            new StubbedReply { Throws = new HttpRequestException("connection refused") }
        );
        var runner = RunnerFixtures.Runner(handler, new StubExchange());

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("hi")),
            default
        );

        RunnerFixtures.Attribute(transcript, TransportAttributes.Exchange).Should().Be(ExchangeState.RequestFailed);
        RunnerFixtures
            .Attribute(transcript, TransportAttributes.Failure)
            .Should()
            .NotContain("connection refused", because: "a message authored elsewhere may name a credential");
        RunnerFixtures
            .Attribute(transcript, TransportAttributes.Failure)
            .Should()
            .Contain("never reached the system under test");
        transcript.Transport.Attributes.Should().NotContainKey(TransportAttributes.StatusCode);
        ExchangeState.IsHarnessFailure(ExchangeState.Of(transcript)).Should().BeTrue();
    }

    /// <summary>
    /// Caller cancellation is the one thing that is <b>not</b> outcome data. Swallowing it would
    /// hand the aggregator a result for a run the caller abandoned.
    /// </summary>
    [Fact]
    public async Task RunAsync_TokenCancelledMidFlight_PropagatesTheCancellation()
    {
        using var cancellation = new CancellationTokenSource();
        using var handler = new StubHandler(new StubbedReply { BeforeReplying = cancellation.Cancel });
        var runner = RunnerFixtures.Runner(handler, new StubExchange());

        var act = () =>
            runner.RunAsync(
                RunnerFixtures.Scenario(),
                RunnerFixtures.Context(new ScriptedParticipant("hi")),
                cancellation.Token
            );

        await act.Should().ThrowAsync<OperationCanceledException>();
    }

    [Fact]
    public async Task RunAsync_TokenAlreadyCancelled_PropagatesBeforeSendingAnything()
    {
        using var cancellation = new CancellationTokenSource();
        await cancellation.CancelAsync();
        using var handler = new StubHandler(new StubbedReply());
        var runner = RunnerFixtures.Runner(handler, new StubExchange());

        var act = () =>
            runner.RunAsync(
                RunnerFixtures.Scenario(),
                RunnerFixtures.Context(new ScriptedParticipant("hi")),
                cancellation.Token
            );

        await act.Should().ThrowAsync<OperationCanceledException>();
        handler.Requests.Should().BeEmpty();
    }

    [Fact]
    public async Task RunAsync_TokenCancelledOnALaterTurn_PropagatesTheCancellation()
    {
        using var cancellation = new CancellationTokenSource();
        using var handler = new StubHandler(
            new StubbedReply { BeforeReplying = () => { } },
            new StubbedReply { BeforeReplying = cancellation.Cancel }
        );
        var runner = RunnerFixtures.Runner(handler, StubExchange.EndingOnTurn(3));

        var act = () =>
            runner.RunAsync(
                RunnerFixtures.Scenario(),
                RunnerFixtures.Context(new ScriptedParticipant("one", "two", "three")),
                cancellation.Token
            );

        await act.Should().ThrowAsync<OperationCanceledException>();
    }

    /// <summary>
    /// A scenario with nothing to send is mis-authored. It is recorded rather than thrown so that
    /// one bad row cannot take down a suite, and it is recorded <i>loudly</i> so it cannot pass.
    /// </summary>
    [Fact]
    public async Task RunAsync_ParticipantCompletesImmediately_RecordsNotAttemptedWithNoTurns()
    {
        using var handler = new StubHandler(new StubbedReply());
        var runner = RunnerFixtures.Runner(handler, new StubExchange());

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant()),
            default
        );

        transcript.Turns.Should().BeEmpty();
        handler.Requests.Should().BeEmpty();
        RunnerFixtures.Attribute(transcript, TransportAttributes.Exchange).Should().Be(ExchangeState.NotAttempted);
        RunnerFixtures.Attribute(transcript, TransportAttributes.Failure).Should().NotBeEmpty();
        ExchangeState.IsHarnessFailure(ExchangeState.Of(transcript)).Should().BeTrue();
    }

    [Fact]
    public async Task RunAsync_MaxTurnsReached_StopsAtTheCeiling()
    {
        using var handler = new StubHandler(new StubbedReply());
        var runner = RunnerFixtures.Runner(handler, new StubExchange(_ => new RestResponse { Text = "a response" }));

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(maxTurns: 2),
            RunnerFixtures.Context(new ScriptedParticipant("one", "two", "three", "four")),
            default
        );

        transcript.Turns.Should().HaveCount(2);
        RunnerFixtures.Attribute(transcript, TransportAttributes.StoppedBy).Should().Be(StopReason.TurnCeiling);
    }

    [Fact]
    public async Task RunAsync_TerminalOutcomeReached_StopsTheLoopBeforeTheScriptRunsOut()
    {
        using var handler = new StubHandler(new StubbedReply());
        var runner = RunnerFixtures.Runner(handler, StubExchange.EndingOnTurn(2));

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("one", "two", "three", "four")),
            default
        );

        transcript.Turns.Should().HaveCount(2);
        RunnerFixtures.Attribute(transcript, TransportAttributes.StoppedBy).Should().Be(StopReason.TerminalOutcome);
    }

    [Fact]
    public async Task RunAsync_TerminalOutcomeDisabled_KeepsGoingUntilTheParticipantCompletes()
    {
        using var handler = new StubHandler(new StubbedReply());
        var runner = RunnerFixtures.Runner(handler, StubExchange.EndingOnTurn(1));

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(stopOnTerminalOutcome: false),
            RunnerFixtures.Context(new ScriptedParticipant("one", "two", "three")),
            default
        );

        transcript.Turns.Should().HaveCount(3);
        RunnerFixtures.Attribute(transcript, TransportAttributes.StoppedBy).Should().Be(StopReason.ParticipantComplete);
    }

    /// <summary>
    /// A completed participant always ends the loop: with no stimulus there is nothing to send,
    /// and a runner that invented one would measure itself.
    /// </summary>
    [Fact]
    public async Task RunAsync_ParticipantCompletionNotDeclaredTerminal_StillEndsTheLoop()
    {
        using var handler = new StubHandler(new StubbedReply());
        var runner = RunnerFixtures.Runner(handler, StubExchange.EndingOnTurn(9));

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(stopOnParticipantCompletion: false, maxTurns: 9),
            RunnerFixtures.Context(new ScriptedParticipant("one", "two")),
            default
        );

        transcript.Turns.Should().HaveCount(2);
        RunnerFixtures.Attribute(transcript, TransportAttributes.StoppedBy).Should().Be(StopReason.ParticipantComplete);
    }

    [Fact]
    public async Task RunAsync_AdapterSuppliesAttributes_MergesThemBeneathTheReservedKeys()
    {
        using var handler = new StubHandler(new StubbedReply());
        var exchange = new StubExchange(_ => new RestResponse
        {
            Text = "a response",
            ObservedOutcome = "resolved",
            Attributes = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["retryAfter"] = "30",
                [TransportAttributes.Exchange] = "fabricated",
                [TransportAttributes.StatusCode] = "200 but actually not",
            },
        });
        var runner = RunnerFixtures.Runner(handler, exchange);

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("hi")),
            default
        );

        RunnerFixtures.Attribute(transcript, "retryAfter").Should().Be("30");
        RunnerFixtures.Attribute(transcript, TransportAttributes.Exchange).Should().Be(ExchangeState.Responded);
        RunnerFixtures.Attribute(transcript, TransportAttributes.StatusCode).Should().Be("200");
    }

    /// <summary>
    /// An adapter that cannot build a request is broken for <i>every</i> scenario, so it is
    /// surfaced rather than recorded as one run's outcome — a per-run record would hide a
    /// systemic defect behind a suite of individually plausible failures.
    /// </summary>
    [Fact]
    public async Task RunAsync_AdapterReturnsNoRequest_IsSurfacedRatherThanRecorded()
    {
        using var handler = new StubHandler(new StubbedReply());
        var runner = RunnerFixtures.Runner(handler, new NullRequestExchange());

        var act = () =>
            runner.RunAsync(RunnerFixtures.Scenario(), RunnerFixtures.Context(new ScriptedParticipant("hi")), default);

        (await act.Should().ThrowAsync<InvalidOperationException>()).WithMessage("*CreateRequest returned no request*");
        handler.Requests.Should().BeEmpty();
    }

    [Fact]
    public async Task RunAsync_DeterministicCallerDrivingTheRun_ProducesAScriptedOneTurnTranscript()
    {
        using var handler = new StubHandler(new StubbedReply());
        var runner = RunnerFixtures.Runner(handler, new StubExchange());
        var caller = new DeterministicCaller(new Simulation { Opening = "the opening" }, ExecutionMode.Deterministic);

        var transcript = await runner.RunAsync(RunnerFixtures.Scenario(), RunnerFixtures.Context(caller), default);

        transcript.Turns.Should().ContainSingle();
        transcript.Turns[0].Stimulus.Should().Be("the opening");
        transcript.Turns[0].Provenance.Should().Be(TurnProvenance.Scripted);
    }

    /// <summary>
    /// The deterministic caller verifies the prefix it is handed rather than trusting it, so this
    /// also proves the runner feeds it a transcript whose turns carry the shape it expects.
    /// </summary>
    [Fact]
    public async Task RunAsync_DeterministicCallerDrivingSeveralTurns_IsFedATranscriptItAccepts()
    {
        using var handler = new StubHandler(new StubbedReply());
        var runner = RunnerFixtures.Runner(handler, StubExchange.EndingOnTurn(3));
        var caller = new DeterministicCaller(
            new Simulation
            {
                Opening = "the opening",
                ScriptedStimuli = [new ScriptedStimulus { Text = "second" }, new ScriptedStimulus { Text = "third" }],
            },
            ExecutionMode.Deterministic
        );

        var transcript = await runner.RunAsync(RunnerFixtures.Scenario(), RunnerFixtures.Context(caller), default);

        transcript.Turns.Select(turn => turn.Stimulus).Should().Equal("the opening", "second", "third");
        transcript.Turns.Should().OnlyContain(turn => turn.Provenance == TurnProvenance.Scripted);
    }
}
