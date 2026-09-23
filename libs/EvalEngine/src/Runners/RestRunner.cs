using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Runners;

/// <summary>
/// Conducts exactly <b>one</b> execution of a REST scenario and returns what happened.
/// </summary>
/// <remarks>
/// <para>
/// This runner knows the transport and the turn-taking, and deliberately nothing else. It does not
/// decide how many repetitions to run — that is the aggregator's job — and it does not grade,
/// which is the assertion evaluators'. What it returns is the same kind-agnostic
/// <see cref="Transcript"/> every other runner returns.
/// </para>
/// <para>
/// <b>There is no one-turn special case.</b> A REST participant emits the scenario's opening and
/// signals completion, so the loop below runs once and stops — by the same rule that stops a
/// twenty-turn conversation. Branching on scenario kind here is what the whole design exists to
/// avoid: the moment this method can tell, so can everything downstream.
/// </para>
/// <para>
/// <b>What the system under test did is outcome data; what the harness failed to do is not.</b> A
/// 429, a 4xx, a refusal, a body the adapter reports it cannot parse — these are frequently the
/// <i>point</i> of a scenario, so they are recorded as structured
/// <see cref="TransportMetadata.Attributes"/> that
/// <see cref="Assertions.AssertionCategory.ExpectedBehavior"/> can assert against, and never
/// thrown. An adapter that merely <i>fell over</i> is on the other side of that line: it reached
/// no verdict, so the run records <see cref="ExchangeState.AdapterFailed"/> and is not gradeable
/// as evidence about the system. The one failure that <i>is</i> propagated is cancellation by the
/// caller: returning a transcript for an abandoned run would hand the aggregator a result nobody
/// waited for.
/// </para>
/// <para>
/// <b>A transcript describes the turn the run ended on.</b> Every turn starts from a clean record
/// rather than inheriting the previous one's, so an outcome, an adapter attribute, or a status
/// code observed earlier cannot be attributed to a later turn that failed or simply did not report
/// it. Merging instead is how a success two turns back gets graded as though it were the final
/// answer.
/// </para>
/// <para>
/// The <see cref="HttpClient"/> is injected and <b>not owned</b>: register this as a typed client
/// so the composition root keeps control of handler lifetime and connection reuse. This type is
/// therefore deliberately not <see cref="IDisposable"/>.
/// </para>
/// <para>
/// This type holds no per-run state, so one instance may conduct several runs concurrently
/// provided the injected <see cref="IRestExchange"/> and <see cref="IClock"/> are themselves
/// thread-safe. <see cref="IParticipant"/> is not shared between runs — it arrives on
/// <see cref="RunContext"/>, one per run.
/// </para>
/// </remarks>
public sealed class RestRunner : IScenarioRunner
{
    private readonly HttpClient _client;
    private readonly IRestExchange _exchange;
    private readonly IClock _clock;
    private readonly RestRunnerOptions _options;

    /// <summary>Initializes a new instance of the <see cref="RestRunner"/> class.</summary>
    /// <param name="client">
    /// The client to issue requests with. Injected rather than constructed, so the composition
    /// root owns its lifetime; its base address is what a relative request URI resolves against.
    /// </param>
    /// <param name="exchange">The adapter that knows the HTTP surface of the system under test.</param>
    /// <param name="clock">
    /// The clock every recorded time comes from. Injected so a run's timing is pinnable in a test
    /// and a transcript stays a function of its inputs.
    /// </param>
    /// <exception cref="ArgumentNullException">Any argument is null.</exception>
    public RestRunner(HttpClient client, IRestExchange exchange, IClock clock)
        : this(client, exchange, clock, RestRunnerOptions.Default) { }

    /// <summary>Initializes a new instance of the <see cref="RestRunner"/> class.</summary>
    /// <param name="client">
    /// The client to issue requests with. Injected rather than constructed, so the composition
    /// root owns its lifetime; its base address is what a relative request URI resolves against.
    /// </param>
    /// <param name="exchange">The adapter that knows the HTTP surface of the system under test.</param>
    /// <param name="clock">
    /// The clock every recorded time comes from. Injected so a run's timing is pinnable in a test
    /// and a transcript stays a function of its inputs.
    /// </param>
    /// <param name="options">What this runner may write into a transcript.</param>
    /// <exception cref="ArgumentNullException">Any argument is null.</exception>
    public RestRunner(HttpClient client, IRestExchange exchange, IClock clock, RestRunnerOptions options)
    {
        ArgumentNullException.ThrowIfNull(client);
        ArgumentNullException.ThrowIfNull(exchange);
        ArgumentNullException.ThrowIfNull(clock);
        ArgumentNullException.ThrowIfNull(options);

        _client = client;
        _exchange = exchange;
        _clock = clock;
        _options = options;
    }

    /// <inheritdoc/>
    public ScenarioKind Kind => ScenarioKind.Rest;

    /// <summary>Runs the scenario once.</summary>
    /// <param name="scenario">The scenario to run. Must declare <see cref="ScenarioKind.Rest"/>.</param>
    /// <param name="context">The participant, seed, and repetition number for this run.</param>
    /// <param name="cancellationToken">Cancels the run.</param>
    /// <returns>What happened, in the shared kind-agnostic form.</returns>
    /// <exception cref="ArgumentNullException">
    /// <paramref name="scenario"/> or <paramref name="context"/> is null.
    /// </exception>
    /// <exception cref="ArgumentException"><paramref name="scenario"/> declares another kind.</exception>
    /// <exception cref="InvalidOperationException">
    /// The injected <see cref="IRestExchange"/> returned no request. That is a defect in the
    /// adapter rather than a property of one run, so it is surfaced rather than recorded as one
    /// scenario's outcome.
    /// </exception>
    /// <exception cref="OperationCanceledException"><paramref name="cancellationToken"/> was cancelled.</exception>
    public async Task<Transcript> RunAsync(Scenario scenario, RunContext context, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(scenario);
        ArgumentNullException.ThrowIfNull(context);
        cancellationToken.ThrowIfCancellationRequested();
        RunnerSupport.RequireKind(scenario, Kind, "rest");

        var terminal = scenario.Execution.TerminalCondition;
        var startedAt = _clock.UtcNow;
        var turns = new List<Turn>();
        var fromAdapter = new Dictionary<string, string>(StringComparer.Ordinal);
        var observed = new Dictionary<string, string>(StringComparer.Ordinal);
        var outcome = new Outcome();
        Uri? endpoint = null;

        // A run that never sends anything starts here, and only a run that does overwrites it —
        // so a scenario with nothing to send cannot quietly look like a clean empty run.
        var state = ExchangeState.NotAttempted;
        var stoppedBy = StopReason.ParticipantComplete;
        var failure =
            $"Scenario '{scenario.Identity.Id}' offered no stimulus: the participant completed before the "
            + "first turn, so no request was sent and this run observed nothing about the system under test. "
            + "A REST scenario needs 'simulation.opening'.";

        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();

            // TerminalCondition.MaxTurns refuses a value below one, so this cannot stop a run
            // before its first turn. A null ceiling compares false and never stops it at all.
            if (turns.Count >= terminal.MaxTurns)
            {
                stoppedBy = StopReason.TurnCeiling;
                break;
            }

            var offered = await context.Participant.NextAsync(SnapshotSoFar(), cancellationToken).ConfigureAwait(false);

            if (offered.IsComplete)
            {
                // Completion always ends the loop, whatever StopOnParticipantCompletion says: with
                // no stimulus there is nothing to send, and a runner that invented one would be
                // measuring itself. That flag governs whether completion is a *declared* terminal
                // condition — which is what the suite loader reads when it scopes an assertion —
                // not whether this loop can continue without a caller.
                stoppedBy = StopReason.ParticipantComplete;
                break;
            }

            // ParticipantTurn makes the other state unrepresentable: a turn that is not complete
            // carries both a stimulus and its provenance.
            var stimulus = offered.Stimulus!;
            var provenance = offered.Provenance!.Value;
            var index = turns.Count + 1;
            var turnStartedAt = _clock.UtcNow;

            // Run-level evidence describes the turn the run *ends* on, so each turn starts from
            // nothing rather than inheriting the last one's account of itself. Merging instead is
            // how an earlier turn's outcome gets attributed to a later one that failed, and how a
            // key the final response omitted stays assertable from a response two turns back —
            // the same false green, one layer down.
            observed.Clear();
            fromAdapter.Clear();
            outcome = new Outcome();

            using var request =
                _exchange.CreateRequest(
                    new RestStimulus
                    {
                        Scenario = scenario,
                        Text = stimulus,
                        TurnIndex = index,
                        Seed = context.Seed,
                        Repetition = context.Repetition,
                    }
                )
                ?? throw new InvalidOperationException(
                    $"{_exchange.GetType().Name}.CreateRequest returned no request for turn {Render(index)} of "
                        + $"scenario '{scenario.Identity.Id}'. An adapter that cannot build a request is a defect "
                        + "in the adapter rather than a property of this run — every scenario it touches is "
                        + "affected — so it is surfaced rather than recorded as one run's outcome."
                );

            endpoint ??= Resolve(request);

            int statusCode;
            string? reasonPhrase;
            string body;

            try
            {
                using var response = await _client.SendAsync(request, cancellationToken).ConfigureAwait(false);
                statusCode = (int)response.StatusCode;
                reasonPhrase = response.ReasonPhrase;
                body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                // The caller abandoned the run. Recording a transcript for it would report a
                // result nobody waited for, so this is the one failure that propagates.
                throw;
            }
            catch (OperationCanceledException exception)
            {
                // Our token is not cancelled, so this is the transport's own timeout — HttpClient
                // reports one as a cancellation carrying a TimeoutException.
                state = ExchangeState.TimedOut;
                failure = Explain(
                    "the request did not complete within the transport's timeout",
                    exception.GetType().Name,
                    exception
                );
                stoppedBy = StopReason.ExchangeFailed;
                turns.Add(Record(index, stimulus, response: null, provenance, turnStartedAt));
                break;
            }
            catch (HttpRequestException exception)
            {
                state = ExchangeState.RequestFailed;
                failure = Explain(
                    "the request never reached the system under test",
                    exception.HttpRequestError.ToString(),
                    exception
                );
                stoppedBy = StopReason.ExchangeFailed;
                turns.Add(Record(index, stimulus, response: null, provenance, turnStartedAt));
                break;
            }

            state = ExchangeState.Responded;
            failure = null;
            observed[TransportAttributes.StatusCode] = Render(statusCode);
            observed[TransportAttributes.Method] = request.Method.Method;

            if (!string.IsNullOrWhiteSpace(reasonPhrase))
            {
                observed[TransportAttributes.ReasonPhrase] = reasonPhrase;
            }

            if (statusCode is < 200 or > 299)
            {
                // Not interpreted: an error page is not the shape the adapter agreed to parse, and
                // `expectedBehavior:transport/statusCode` is how a scenario asserts the refusal it
                // was written to provoke. The body itself is withheld by default — it never passed
                // through the adapter's redaction, and an error page is where a token surfaces.
                stoppedBy = StopReason.ExchangeFailed;
                turns.Add(Record(index, stimulus, Capture(body, observed), provenance, turnStartedAt));
                break;
            }

            RestResponse read;

            try
            {
                read =
                    _exchange.Read(
                        new RestReply
                        {
                            StatusCode = statusCode,
                            ReasonPhrase = reasonPhrase,
                            Body = body,
                        }
                    ) ?? throw new InvalidOperationException("the adapter returned nothing");
            }
            // The adapter read the body and rejected it. That is a verdict about the *system*, so
            // the run stays gradeable — a suite asserting on malformed output must still catch a
            // real regression.
            catch (MalformedResponseException exception)
            {
                state = ExchangeState.MalformedResponse;
                failure = Explain(
                    "the response body could not be interpreted",
                    nameof(MalformedResponseException),
                    exception
                );
                stoppedBy = StopReason.ExchangeFailed;
                turns.Add(Record(index, stimulus, Capture(body, observed), provenance, turnStartedAt));
                break;
            }
            // The adapter fell over, or returned nothing. It reached no verdict, so this run holds
            // no basis on which to grade the system under test. Recording it as malformed would
            // let a broken adapter manufacture a passing assertion about a system it never read;
            // IRestExchange is a public extension point, so this is recorded rather than thrown
            // to keep one adapter's defect from taking down a mixed suite.
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                state = ExchangeState.AdapterFailed;
                failure = Explain(
                    "the adapter failed while interpreting the response",
                    exception.GetType().Name,
                    exception
                );
                stoppedBy = StopReason.ExchangeFailed;
                turns.Add(Record(index, stimulus, Capture(body, observed), provenance, turnStartedAt));
                break;
            }

            foreach (var attribute in Copy(read.Attributes))
            {
                fromAdapter[attribute.Key] = attribute.Value;
            }

            // The run's outcome is what the system *ultimately* did, so the turn it ends on
            // replaces what earlier turns reported rather than merging with it.
            outcome = new Outcome
            {
                ObservedOutcome = read.ObservedOutcome,
                ObservedPath = read.ObservedPath,
                Fields = Copy(read.Fields),
            };
            turns.Add(Record(index, stimulus, read.Text, provenance, turnStartedAt));

            if (terminal.StopOnTerminalOutcome && !string.IsNullOrWhiteSpace(outcome.ObservedOutcome))
            {
                stoppedBy = StopReason.TerminalOutcome;
                break;
            }
        }

        return new Transcript
        {
            ScenarioId = scenario.Identity.Id,
            Seed = context.Seed,
            StartedAt = startedAt,
            Duration = _clock.UtcNow - startedAt,
            Turns = turns,
            Outcome = outcome,
            Transport = new TransportMetadata
            {
                // 'http', never 'rest': this names a transport, not a scenario kind. A future
                // HTTP-backed runner for another kind must be indistinguishable here.
                Kind = "http",
                Endpoint = Sanitize(endpoint),
                Attributes = RunnerSupport.Attributes(fromAdapter, observed, state, stoppedBy, failure),
            },
        };

        // What the participant is allowed to see: the turns so far and the outcome they produced.
        // The deterministic caller derives its position from exactly this and verifies the prefix
        // it is handed, so the indices and provenance recorded above are load-bearing input.
        Transcript SnapshotSoFar() =>
            new()
            {
                ScenarioId = scenario.Identity.Id,
                Seed = context.Seed,
                StartedAt = startedAt,
                Turns = turns.ToArray(),
                Outcome = outcome,
            };
    }

    private static string Render(int value) => value.ToString(CultureInfo.InvariantCulture);

    /// <summary>The body as evidence, or null when the system returned nothing at all.</summary>
    private static string? Evidence(string body) => string.IsNullOrEmpty(body) ? null : body;

    /// <summary>
    /// Decides what of an <i>uninterpreted</i> body reaches the transcript, and records safe
    /// structured evidence for it either way.
    /// </summary>
    /// <remarks>
    /// The bodies that arrive here — an error page, a body the adapter rejected — are the ones
    /// that never passed through the adapter's redaction, which makes them the likeliest place for
    /// a credential to enter a committed artifact. A length and a fingerprint carry the
    /// debuggability that matters (did the body change? is this the same failure as the last
    /// forty?) without carrying the text (§V).
    /// </remarks>
    private string? Capture(string body, Dictionary<string, string> observed)
    {
        observed[TransportAttributes.ResponseBodyLength] = Render(body.Length);

        if (body.Length > 0)
        {
            observed[TransportAttributes.ResponseBodyHash] = Fingerprint(body);
        }

        return _options.RetainUnredactedEvidence ? Evidence(body) : null;
    }

    private static string Fingerprint(string body) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(body)))[..16];

    /// <summary>
    /// Describes a failure in terms the runner can vouch for.
    /// </summary>
    /// <remarks>
    /// An exception's message is authored by whatever threw it — a handler, a driver, the
    /// framework — and routinely names the endpoint or connection string it failed on. This value
    /// is written into a committed artifact, so by default it carries what failed and the type
    /// that reported it, and the message only when a caller has opted in (§V).
    /// </remarks>
    private string Explain(string summary, string classification, Exception exception) =>
        _options.RetainUnredactedEvidence
            ? $"{summary} ({classification}): {exception.Message}"
            : $"{summary} ({classification})";

    private static Dictionary<string, TValue> Copy<TValue>(IReadOnlyDictionary<string, TValue>? source) =>
        source is null
            ? new Dictionary<string, TValue>(StringComparer.Ordinal)
            : new Dictionary<string, TValue>(source, StringComparer.Ordinal);

    private Turn Record(
        int index,
        string stimulus,
        string? response,
        TurnProvenance provenance,
        DateTimeOffset turnStartedAt
    ) =>
        new()
        {
            Index = index,
            Stimulus = stimulus,
            Response = response,
            Provenance = provenance,
            Elapsed = _clock.UtcNow - turnStartedAt,
        };

    private Uri? Resolve(HttpRequestMessage request) =>
        request.RequestUri switch
        {
            null => _client.BaseAddress,
            { IsAbsoluteUri: true } absolute => absolute,
            var relative => _client.BaseAddress is null ? null : new Uri(_client.BaseAddress, relative),
        };

    /// <summary>
    /// Strips credentials from the recorded address.
    /// </summary>
    /// <remarks>
    /// Delegated to <see cref="RunnerSupport.SanitizeEndpoint(Uri?)"/> rather than implemented
    /// here, so that this runner and <see cref="LlmConversationRunner"/> cannot disagree about
    /// what a committed transcript may carry. Getting a redaction right in one runner and wrong
    /// in another is how a library like this rots.
    /// </remarks>
    private static string? Sanitize(Uri? uri) => RunnerSupport.SanitizeEndpoint(uri);
}
