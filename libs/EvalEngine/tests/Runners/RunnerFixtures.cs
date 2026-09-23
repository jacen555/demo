using System.Net;
using System.Text;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Runners;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Tests.Runners;

/// <summary>A clock that returns the same instant however often it is read.</summary>
/// <remarks>
/// A frozen clock makes every recorded duration zero, which is what lets a structural comparison
/// of two transcripts differ only where the runs genuinely differed.
/// </remarks>
internal sealed class FrozenClock(DateTimeOffset instant) : IClock
{
    public DateTimeOffset UtcNow { get; } = instant;
}

/// <summary>A clock that advances by a fixed step on every read.</summary>
internal sealed class TickingClock(DateTimeOffset start, TimeSpan step) : IClock
{
    private int _reads;

    public DateTimeOffset UtcNow => start + (step * _reads++);
}

/// <summary>What the stub handler should do when a request arrives.</summary>
internal sealed record StubbedReply
{
    public HttpStatusCode Status { get; init; } = HttpStatusCode.OK;

    public string Body { get; init; } = "{}";

    /// <summary>An exception the transport raises instead of replying.</summary>
    public Exception? Throws { get; init; }

    /// <summary>Work the handler performs before replying — used to cancel mid-flight.</summary>
    public Action? BeforeReplying { get; init; }
}

/// <summary>
/// A handler that replies from a script, so a test exercises the whole
/// <see cref="HttpClient"/> pipeline rather than a mock of it.
/// </summary>
internal sealed class StubHandler(params StubbedReply[] replies) : HttpMessageHandler
{
    private readonly List<HttpRequestMessage> _requests = [];

    public IReadOnlyList<HttpRequestMessage> Requests => _requests;

    public List<string> Bodies { get; } = [];

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken
    )
    {
        _requests.Add(request);
        Bodies.Add(request.Content is null ? string.Empty : await request.Content.ReadAsStringAsync(cancellationToken));

        var reply = replies[Math.Min(_requests.Count - 1, replies.Length - 1)];
        reply.BeforeReplying?.Invoke();
        cancellationToken.ThrowIfCancellationRequested();

        if (reply.Throws is not null)
        {
            throw reply.Throws;
        }

        return new HttpResponseMessage(reply.Status)
        {
            Content = new StringContent(reply.Body, Encoding.UTF8, "application/json"),
            RequestMessage = request,
        };
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            foreach (var request in _requests)
            {
                request.Dispose();
            }
        }

        base.Dispose(disposing);
    }
}

/// <summary>
/// An adapter under the test's control. Nothing here is shipped: the library deliberately has no
/// default, because a request shape is a property of the system under test.
/// </summary>
internal sealed class StubExchange : IRestExchange
{
    private readonly Func<RestReply, RestResponse> _read;

    public StubExchange(Func<RestReply, RestResponse>? read = null) =>
        _read = read ?? (_ => new RestResponse { Text = "a response", ObservedOutcome = "resolved" });

    public List<RestStimulus> Seen { get; } = [];

    public HttpMethod Method { get; init; } = HttpMethod.Post;

    public string RequestUri { get; init; } = "eval";

    public HttpRequestMessage CreateRequest(RestStimulus stimulus)
    {
        Seen.Add(stimulus);

        return new HttpRequestMessage(Method, RequestUri)
        {
            Content = new StringContent(stimulus.Text, Encoding.UTF8, "text/plain"),
        };
    }

    public RestResponse Read(RestReply reply) => _read(reply);

    /// <summary>An adapter whose outcome is terminal only on the turn the run should end on.</summary>
    public static StubExchange EndingOnTurn(int finalTurn)
    {
        StubExchange? exchange = null;
        exchange = new StubExchange(_ => new RestResponse
        {
            Text = "a response",
            ObservedOutcome = exchange!.Seen.Count == finalTurn ? "resolved" : null,
            ObservedPath = "triage/resolve",
            Fields = new Dictionary<string, string?>(StringComparer.Ordinal) { ["scope/confirm"] = "yes" },
        });

        return exchange;
    }
}

/// <summary>A participant driven by a fixed script, independent of the deterministic caller.</summary>
internal sealed class ScriptedParticipant(params string[] script) : IParticipant
{
    public int Asks { get; private set; }

    public ValueTask<ParticipantTurn> NextAsync(Transcript transcriptSoFar, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(transcriptSoFar);
        Asks++;

        var position = transcriptSoFar.Turns.Count;

        return new ValueTask<ParticipantTurn>(
            position < script.Length
                ? ParticipantTurn.Next(script[position], TurnProvenance.Scripted)
                : ParticipantTurn.Complete
        );
    }
}

/// <summary>An adapter that cannot build a request — a defect, not a property of one run.</summary>
internal sealed class NullRequestExchange : IRestExchange
{
    public HttpRequestMessage CreateRequest(RestStimulus stimulus) => null!;

    public RestResponse Read(RestReply reply) => new();
}

internal static class RunnerFixtures
{
    public static readonly DateTimeOffset Instant = TestData.FixedInstant;

    public static readonly Uri BaseAddress = new("https://localhost:5001/");

    public static Scenario Scenario(
        ScenarioKind kind = ScenarioKind.Rest,
        string id = "scenario-a",
        int? maxTurns = null,
        bool stopOnTerminalOutcome = true,
        bool stopOnParticipantCompletion = true
    ) =>
        new()
        {
            Identity = new ScenarioIdentity { Id = id, Kind = kind },
            Execution = new Execution
            {
                Mode = ExecutionMode.Deterministic,
                TerminalCondition = new TerminalCondition
                {
                    MaxTurns = maxTurns,
                    StopOnTerminalOutcome = stopOnTerminalOutcome,
                    StopOnParticipantCompletion = stopOnParticipantCompletion,
                },
            },
        };

    public static RunContext Context(IParticipant participant, long seed = 4242, int repetition = 1) =>
        new()
        {
            Participant = participant,
            Seed = seed,
            Repetition = repetition,
        };

    public static HttpClient Client(HttpMessageHandler handler, Uri? baseAddress = null) =>
        new(handler, disposeHandler: false) { BaseAddress = baseAddress ?? BaseAddress };

    public static RestRunner Runner(HttpMessageHandler handler, IRestExchange exchange, IClock? clock = null) =>
        new(Client(handler), exchange, clock ?? new FrozenClock(Instant));

    public static string Attribute(Transcript transcript, string key) =>
        transcript.Transport.Attributes.TryGetValue(key, out var value)
            ? value
            : throw new Xunit.Sdk.XunitException(
                $"transport attribute '{key}' was not recorded. Recorded: "
                    + string.Join(", ", transcript.Transport.Attributes.Keys.Order(StringComparer.Ordinal))
            );
}
