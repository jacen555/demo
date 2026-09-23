using System.Net;
using FluentAssertions;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Runners;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Serialization;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Tests.Runners;

/// <summary>
/// A run's transcript is a statement about <b>the turn the run ended on</b>. These tests pin the
/// boundary that makes that true: evidence gathered on one turn must not survive into the record
/// of another, and evidence about the <i>harness</i> must never be gradeable as evidence about the
/// system under test.
/// </summary>
/// <remarks>
/// Every case here is the same defect class — one context's evidence being graded as though it
/// came from another — which is the shape of a false green rather than of a failure someone
/// notices.
/// </remarks>
public sealed class RestRunnerEvidenceScopeTests
{
    /// <summary>
    /// A distinctive stand-in for a credential. Assembled into a message at runtime rather than
    /// written as a credential-shaped URI literal, so no tool in the chain can helpfully redact it
    /// and leave the test asserting against a secret that was never there.
    /// </summary>
    private const string Credential = "s3cr3t";

    /// <summary>
    /// The run ended on a turn that failed, so the earlier turn's outcome is not what the system
    /// ultimately did. Carrying it forward attributes a success to a failed turn.
    /// </summary>
    [Fact]
    public async Task RunAsync_FinalTurnFailsAfterASuccessfulOne_DoesNotCarryTheEarlierTurnsOutcome()
    {
        using var handler = new StubHandler(
            new StubbedReply(),
            new StubbedReply { Status = HttpStatusCode.InternalServerError, Body = "boom" }
        );
        var runner = RunnerFixtures.Runner(handler, SucceedsWithAPath());

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("one", "two")),
            default
        );

        RunnerFixtures.Attribute(transcript, TransportAttributes.StatusCode).Should().Be("500");
        transcript.Outcome.ObservedPath.Should().BeNull();
        transcript.Outcome.ObservedOutcome.Should().BeNull();
        transcript.Outcome.Fields.Should().BeEmpty();
    }

    /// <summary>
    /// The grading consequence of the above, stated as a suite author would hit it: a scenario
    /// expecting <c>triage/resolve</c> must not pass on a run whose final turn returned a 500.
    /// </summary>
    [Fact]
    public async Task RunAsync_FinalTurnFailsAfterASuccessfulOne_DoesNotLetTheEarlierPathPassGrading()
    {
        using var handler = new StubHandler(
            new StubbedReply(),
            new StubbedReply { Status = HttpStatusCode.InternalServerError, Body = "boom" }
        );
        var runner = RunnerFixtures.Runner(handler, SucceedsWithAPath());

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("one", "two")),
            default
        );

        var verdict = await AssertionEvaluatorRegistry
            .CreateDefault()
            .EvaluateAsync(
                AssertionSpec.Parse("exactMatch:path"),
                new EvaluationContext
                {
                    ScenarioId = "scenario-a",
                    Grading = new Grading { ExpectedPath = "triage/resolve" },
                    Transcript = transcript,
                },
                default
            );

        verdict.Pass.Should().BeFalse(because: "the path was observed on a turn the run did not end on");
    }

    /// <summary>
    /// Run-level transport attributes describe the final turn. A key the final turn did not supply
    /// must not still be assertable from an earlier one.
    /// </summary>
    [Fact]
    public async Task RunAsync_FinalTurnOmitsAnAttributeAnEarlierTurnSupplied_DoesNotRetainTheStaleValue()
    {
        using var handler = new StubHandler(new StubbedReply());
        var reads = 0;
        var exchange = new StubExchange(_ =>
        {
            reads++;

            return new RestResponse
            {
                Text = "a response",
                Attributes =
                    reads == 1
                        ? new Dictionary<string, string>(StringComparer.Ordinal) { ["retryAfter"] = "30" }
                        : new Dictionary<string, string>(StringComparer.Ordinal),
            };
        });
        var runner = RunnerFixtures.Runner(handler, exchange);

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("one", "two")),
            default
        );

        transcript.Turns.Should().HaveCount(2);
        transcript.Transport.Attributes.Should().NotContainKey("retryAfter");
    }

    [Fact]
    public async Task RunAsync_FinalTurnOmitsAnAttributeAnEarlierTurnSupplied_DoesNotLetTheStaleValuePassGrading()
    {
        using var handler = new StubHandler(new StubbedReply());
        var reads = 0;
        var exchange = new StubExchange(_ =>
        {
            reads++;

            return new RestResponse
            {
                Text = "a response",
                Attributes =
                    reads == 1
                        ? new Dictionary<string, string>(StringComparer.Ordinal) { ["retryAfter"] = "30" }
                        : new Dictionary<string, string>(StringComparer.Ordinal),
            };
        });
        var runner = RunnerFixtures.Runner(handler, exchange);

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("one", "two")),
            default
        );

        var verdict = await AssertionEvaluatorRegistry
            .CreateDefault()
            .EvaluateAsync(
                AssertionSpec.Parse("expectedBehavior:transport/retryAfter=30"),
                new EvaluationContext
                {
                    ScenarioId = "scenario-a",
                    Grading = new Grading(),
                    Transcript = transcript,
                },
                default
            );

        verdict.Pass.Should().BeFalse(because: "the final turn supplied no retryAfter");
    }

    /// <summary>
    /// The same staleness in the runner's own observations: a final turn that never reached the
    /// system has no status code, and the previous turn's must not stand in for one.
    /// </summary>
    [Fact]
    public async Task RunAsync_FinalTurnNeverReachesTheSystem_DoesNotRetainTheEarlierTurnsStatusCode()
    {
        using var handler = new StubHandler(
            new StubbedReply(),
            new StubbedReply { Throws = new HttpRequestException("connection refused") }
        );
        var runner = RunnerFixtures.Runner(handler, new StubExchange(_ => new RestResponse { Text = "a response" }));

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("one", "two")),
            default
        );

        RunnerFixtures.Attribute(transcript, TransportAttributes.Exchange).Should().Be(ExchangeState.RequestFailed);
        transcript.Transport.Attributes.Should().NotContainKey(TransportAttributes.StatusCode);
    }

    /// <summary>
    /// A defective adapter is a statement about the <i>harness</i>. Grading it as
    /// <see cref="ExchangeState.MalformedResponse"/> — which reads as system evidence — lets a
    /// broken adapter produce a passing assertion about a system it never successfully read.
    /// </summary>
    [Fact]
    public async Task RunAsync_AdapterThrowsAnUnexpectedException_IsClassifiedAsAHarnessFailure()
    {
        using var handler = new StubHandler(new StubbedReply());
        var exchange = new StubExchange(_ => throw new KeyNotFoundException("adapter bug"));
        var runner = RunnerFixtures.Runner(handler, exchange);

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("hi")),
            default
        );

        ExchangeState
            .IsHarnessFailure(ExchangeState.Of(transcript))
            .Should()
            .BeTrue(because: "an adapter defect is not evidence about the system under test");
    }

    [Fact]
    public async Task RunAsync_AdapterReturnsNothing_IsClassifiedAsAHarnessFailure()
    {
        using var handler = new StubHandler(new StubbedReply());
        var runner = RunnerFixtures.Runner(handler, new StubExchange(_ => null!));

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("hi")),
            default
        );

        ExchangeState
            .IsHarnessFailure(ExchangeState.Of(transcript))
            .Should()
            .BeTrue(because: "an adapter that returns nothing read nothing");
    }

    /// <summary>
    /// The endpoint travels into a committed artifact. A bearer token in a query string is a
    /// credential exactly as much as one in the userinfo segment (§V).
    /// </summary>
    [Fact]
    public async Task RunAsync_RequestUriCarryingACredentialInItsQuery_RecordsTheEndpointWithoutIt()
    {
        using var handler = new StubHandler(new StubbedReply());
        var runner = RunnerFixtures.Runner(handler, new StubExchange { RequestUri = "eval?api_key=s3cr3t" });

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("hi")),
            default
        );

        transcript.Transport.Endpoint.Should().NotContain("s3cr3t");
        transcript.Transport.Endpoint.Should().StartWith("https://localhost:5001/eval");
    }

    [Fact]
    public async Task RunAsync_RequestUriCarryingACredentialInItsFragment_RecordsTheEndpointWithoutIt()
    {
        using var handler = new StubHandler(new StubbedReply());
        var runner = RunnerFixtures.Runner(handler, new StubExchange { RequestUri = "eval#access_token=s3cr3t" });

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("hi")),
            default
        );

        transcript.Transport.Endpoint.Should().NotContain("s3cr3t");
    }

    /// <summary>
    /// The error paths are where credentials surface, and they are exactly the paths that bypassed
    /// the adapter's redaction. An unparsed body is not safe to commit just because nothing could
    /// read it (§V).
    /// </summary>
    [Fact]
    public async Task RunAsync_NonSuccessBodyCarryingACredential_DoesNotPersistItByDefault()
    {
        using var handler = new StubHandler(
            new StubbedReply { Status = HttpStatusCode.Unauthorized, Body = "{\"token\":\"ghp_s3cr3t\"}" }
        );
        var runner = RunnerFixtures.Runner(handler, new StubExchange());

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("hi")),
            default
        );

        transcript.Turns.Should().ContainSingle().Which.Response.Should().BeNull();
        CanonicalJson.Serialize(transcript).Should().NotContain("ghp_s3cr3t");
    }

    [Fact]
    public async Task RunAsync_UninterpretableBodyCarryingACredential_DoesNotPersistItByDefault()
    {
        using var handler = new StubHandler(new StubbedReply { Body = "{\"token\":\"ghp_s3cr3t\"}" });
        var exchange = new StubExchange(_ => throw new InvalidOperationException("not the agreed shape"));
        var runner = RunnerFixtures.Runner(handler, exchange);

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("hi")),
            default
        );

        CanonicalJson.Serialize(transcript).Should().NotContain("ghp_s3cr3t");
    }

    /// <summary>
    /// An exception message is authored by whatever threw it — a handler, a driver, the framework
    /// — and routinely carries the connection string or URI it failed on.
    /// </summary>
    [Fact]
    public async Task RunAsync_TransportFailureWhoseMessageCarriesACredential_KeepsItOutOfTheTranscript()
    {
        using var handler = new StubHandler(
            new StubbedReply { Throws = new HttpRequestException($"no route to host, password={Credential}") }
        );
        var runner = RunnerFixtures.Runner(handler, new StubExchange());

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("hi")),
            default
        );

        RunnerFixtures.Attribute(transcript, TransportAttributes.Failure).Should().NotBeEmpty();
        RunnerFixtures.Attribute(transcript, TransportAttributes.Failure).Should().NotContain(Credential);
        CanonicalJson.Serialize(transcript).Should().NotContain(Credential);
    }

    [Fact]
    public async Task RunAsync_TimeoutWhoseMessageCarriesACredential_KeepsItOutOfTheTranscript()
    {
        using var handler = new StubHandler(
            new StubbedReply
            {
                Throws = new TaskCanceledException($"timed out, bearer {Credential}", new TimeoutException()),
            }
        );
        var runner = RunnerFixtures.Runner(handler, new StubExchange());

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("hi")),
            default
        );

        RunnerFixtures.Attribute(transcript, TransportAttributes.Exchange).Should().Be(ExchangeState.TimedOut);
        CanonicalJson.Serialize(transcript).Should().NotContain(Credential);
    }

    /// <summary>An adapter that succeeds and reports a route, but never a terminal outcome.</summary>
    private static StubExchange SucceedsWithAPath() =>
        new(_ => new RestResponse
        {
            Text = "a response",
            ObservedPath = "triage/resolve",
            Fields = new Dictionary<string, string?>(StringComparer.Ordinal) { ["scope/confirm"] = "yes" },
        });
}

/// <summary>
/// The escape hatch for the redaction above. Withholding raw evidence costs debuggability, so a
/// caller running against a system with no real credentials can ask for it back — explicitly,
/// which is the point.
/// </summary>
public sealed class RestRunnerUnredactedEvidenceTests
{
    private static readonly RestRunnerOptions Unredacted = new() { RetainUnredactedEvidence = true };

    [Fact]
    public void Constructor_NullOptions_Throws()
    {
        using var handler = new StubHandler(new StubbedReply());
        var act = () =>
            new RestRunner(
                RunnerFixtures.Client(handler),
                new StubExchange(),
                new FrozenClock(RunnerFixtures.Instant),
                null!
            );

        act.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Default_Always_WithholdsRawEvidence() =>
        RestRunnerOptions.Default.RetainUnredactedEvidence.Should().BeFalse();

    [Fact]
    public async Task RunAsync_NonSuccessStatusWithRetentionOn_KeepsTheBody()
    {
        using var handler = new StubHandler(
            new StubbedReply { Status = HttpStatusCode.BadGateway, Body = "the gateway is unhappy" }
        );
        var runner = Runner(handler, new StubExchange());

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("hi")),
            default
        );

        transcript.Turns.Should().ContainSingle().Which.Response.Should().Be("the gateway is unhappy");
        RunnerFixtures.Attribute(transcript, TransportAttributes.ResponseBodyLength).Should().Be("22");
    }

    [Fact]
    public async Task RunAsync_MalformedBodyWithRetentionOn_KeepsTheBodyAndTheAdaptersMessage()
    {
        using var handler = new StubHandler(new StubbedReply { Body = "not json at all" });
        var exchange = new StubExchange(_ => throw new MalformedResponseException("expected an object"));
        var runner = Runner(handler, exchange);

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("hi")),
            default
        );

        transcript.Turns.Should().ContainSingle().Which.Response.Should().Be("not json at all");
        RunnerFixtures.Attribute(transcript, TransportAttributes.Failure).Should().Contain("expected an object");
    }

    [Fact]
    public async Task RunAsync_TransportFailureWithRetentionOn_KeepsTheExceptionMessage()
    {
        using var handler = new StubHandler(
            new StubbedReply { Throws = new HttpRequestException("connection refused") }
        );
        var runner = Runner(handler, new StubExchange());

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("hi")),
            default
        );

        RunnerFixtures.Attribute(transcript, TransportAttributes.Failure).Should().Contain("connection refused");
    }

    /// <summary>
    /// Retention is about <i>bodies and messages</i>, never about the endpoint. A credential in an
    /// address is a credential whatever the caller opted into, so this stays redacted (§V).
    /// </summary>
    [Fact]
    public async Task RunAsync_EndpointWithRetentionOn_IsStillRedacted()
    {
        using var handler = new StubHandler(new StubbedReply());
        var runner = Runner(handler, new StubExchange { RequestUri = "eval?api_key=s3cr3t" });

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("hi")),
            default
        );

        transcript.Transport.Endpoint.Should().NotContain("s3cr3t");
    }

    private static RestRunner Runner(HttpMessageHandler handler, IRestExchange exchange) =>
        new(RunnerFixtures.Client(handler), exchange, new FrozenClock(RunnerFixtures.Instant), Unredacted);
}

/// <summary>
/// The endpoint recorded for a run, which travels verbatim into a committed artifact.
/// </summary>
public sealed class RestRunnerEndpointTests
{
    [Fact]
    public async Task RunAsync_PlainEndpoint_IsRecordedUnchanged() =>
        (await EndpointFor("eval/run")).Should().Be("https://localhost:5001/eval/run");

    [Fact]
    public async Task RunAsync_EndpointWithAQuery_ReplacesItWithAMarker() =>
        (await EndpointFor("eval?api_key=s3cr3t&user=evaluser")).Should().Be("https://localhost:5001/eval?[redacted]");

    [Fact]
    public async Task RunAsync_EndpointWithAFragment_ReplacesItWithAMarker() =>
        (await EndpointFor("eval#access_token=s3cr3t")).Should().Be("https://localhost:5001/eval#[redacted]");

    [Fact]
    public async Task RunAsync_EndpointWithBothAQueryAndAFragment_ReplacesEach() =>
        (await EndpointFor("eval?api_key=s3cr3t#access_token=s3cr3t"))
            .Should()
            .Be("https://localhost:5001/eval?[redacted]#[redacted]");

    private static async Task<string?> EndpointFor(string requestUri)
    {
        using var handler = new StubHandler(new StubbedReply());
        var runner = RunnerFixtures.Runner(handler, new StubExchange { RequestUri = requestUri });

        var transcript = await runner.RunAsync(
            RunnerFixtures.Scenario(),
            RunnerFixtures.Context(new ScriptedParticipant("hi")),
            default
        );

        return transcript.Transport.Endpoint;
    }
}
