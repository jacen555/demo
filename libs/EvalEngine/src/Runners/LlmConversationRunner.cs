using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Runners;

/// <summary>
/// Conducts exactly <b>one</b> execution of a multi-turn conversational scenario and returns what
/// happened.
/// </summary>
/// <remarks>
/// <para>
/// The same loop <see cref="RestRunner"/> drives, against a transport that is not HTTP's. It asks
/// the injected <see cref="IParticipant"/> for a stimulus, hands it to an
/// <see cref="IConversationExchange"/>, and repeats until the system reaches a terminal outcome,
/// the participant completes, the exchange fails, or the cap fires. The
/// <see cref="Transcript"/> it returns is the same kind-agnostic record every other runner
/// returns — <b>no downstream stage can tell which runner built it</b>.
/// </para>
/// <para>
/// <b>The cap is the one thing this runner has that the REST runner does not, and it is not
/// optional.</b> A REST scenario ends because its participant runs out of script; a conversation
/// driven by a model has no such floor, and the component best placed to judge when it has
/// finished is the simulated caller whose faithfulness is the open question. So termination is
/// taken away from the participant entirely: <see cref="LlmConversationRunnerOptions.MaxTurnCeiling"/>
/// bounds every run, <see cref="TerminalCondition.MaxTurns"/> may only narrow it, and neither the
/// participant nor the system under test can raise it.
/// </para>
/// <para>
/// <b>What the system under test did is outcome data; what the harness failed to do is not.</b> A
/// refusal, a reply the adapter reports it cannot interpret, a conversation that stalls — these
/// are recorded as structured <see cref="TransportMetadata.Attributes"/> that
/// <see cref="Assertions.AssertionCategory.ExpectedBehavior"/> can assert against. A simulated
/// caller that failed to produce a stimulus is on the other side of that line: it tested nothing,
/// so the run records <see cref="ExchangeState.ParticipantFailed"/> and
/// <see cref="ExchangeState.IsHarnessFailure(string?)"/> reports it as ungradeable. The one
/// failure that propagates is cancellation by the caller.
/// </para>
/// <para>
/// <b>The participant is checked against the scenario, not trusted to match it.</b> A participant
/// is constructed independently of the scenario it ends up driving, so a
/// <see cref="ExecutionMode.Deterministic"/> scenario — which the suite loader approves as bounded
/// by its script — could otherwise be driven by a caller that generates its turns, leaving every
/// unscoped assertion grading material the script never drove. A participant that declares its
/// mode through <see cref="IModeBoundParticipant"/> is refused up front when it does not match;
/// every participant, declared or not, has each turn it offers inside the scripted window checked
/// against the suite file before that turn reaches the system under test.
/// </para>
/// <para>
/// <b>A transcript describes the turn the run ended on.</b> Every turn starts from a clean record
/// rather than inheriting the previous one's, so an outcome, an adapter attribute, or a status
/// observed earlier cannot be attributed to a later turn that failed or simply did not report it.
/// A multi-turn runner is where that leak is likeliest, which is why it is built in rather than
/// found later.
/// </para>
/// <para>
/// This type holds no per-run state, so one instance may conduct several runs concurrently
/// provided the injected <see cref="IConversationExchange"/> and <see cref="IClock"/> are
/// themselves thread-safe. <see cref="IParticipant"/> is not shared between runs — it arrives on
/// <see cref="RunContext"/>, one per run.
/// </para>
/// </remarks>
public sealed class LlmConversationRunner : IScenarioRunner
{
    /// <summary>
    /// This runner does not own the transport, so it observes nothing of its own on the wire.
    /// Everything transport-specific arrives through the adapter's attributes, beneath the
    /// reserved keys that <see cref="RunnerSupport.Attributes"/> always writes last.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> NothingObserved = new Dictionary<string, string>(
        StringComparer.Ordinal
    );

    private readonly IConversationExchange _exchange;
    private readonly IClock _clock;
    private readonly LlmConversationRunnerOptions _options;

    /// <summary>Initializes a new instance of the <see cref="LlmConversationRunner"/> class.</summary>
    /// <param name="exchange">The adapter that knows how to reach the system under test.</param>
    /// <param name="clock">
    /// The clock every recorded time comes from. Injected so a run's timing is pinnable in a test
    /// and a transcript stays a function of its inputs.
    /// </param>
    /// <exception cref="ArgumentNullException">Any argument is null.</exception>
    public LlmConversationRunner(IConversationExchange exchange, IClock clock)
        : this(exchange, clock, LlmConversationRunnerOptions.Default) { }

    /// <summary>Initializes a new instance of the <see cref="LlmConversationRunner"/> class.</summary>
    /// <param name="exchange">The adapter that knows how to reach the system under test.</param>
    /// <param name="clock">
    /// The clock every recorded time comes from. Injected so a run's timing is pinnable in a test
    /// and a transcript stays a function of its inputs.
    /// </param>
    /// <param name="options">The turn ceiling, and what this runner may write into a transcript.</param>
    /// <exception cref="ArgumentNullException">Any argument is null.</exception>
    public LlmConversationRunner(IConversationExchange exchange, IClock clock, LlmConversationRunnerOptions options)
    {
        ArgumentNullException.ThrowIfNull(exchange);
        ArgumentNullException.ThrowIfNull(clock);
        ArgumentNullException.ThrowIfNull(options);

        _exchange = exchange;
        _clock = clock;
        _options = options;
    }

    /// <inheritdoc/>
    public ScenarioKind Kind => ScenarioKind.Llm;

    /// <summary>
    /// The turns this run may take: the runner's ceiling, narrowed by the scenario's if it
    /// declared a lower one.
    /// </summary>
    /// <remarks>
    /// Stated as a pure function and exposed so a suite author can see the number their scenario
    /// will actually be held to, rather than discovering it from a transcript. A scenario that
    /// declares nothing is capped; a scenario that declares more than the runner allows is capped
    /// at the runner's figure. <b>There is no argument that raises it.</b>
    /// </remarks>
    /// <param name="declared">
    /// <see cref="TerminalCondition.MaxTurns"/>, or <see langword="null"/> when the scenario
    /// declared no ceiling.
    /// </param>
    /// <returns>The number of turns the run will be allowed.</returns>
    public int EffectiveTurnCap(int? declared) =>
        declared is { } ceiling ? Math.Min(ceiling, _options.MaxTurnCeiling) : _options.MaxTurnCeiling;

    /// <summary>Runs the scenario once.</summary>
    /// <param name="scenario">The scenario to run. Must declare <see cref="ScenarioKind.Llm"/>.</param>
    /// <param name="context">The participant, seed, and repetition number for this run.</param>
    /// <param name="cancellationToken">Cancels the run.</param>
    /// <returns>What happened, in the shared kind-agnostic form.</returns>
    /// <exception cref="ArgumentNullException">
    /// <paramref name="scenario"/> or <paramref name="context"/> is null.
    /// </exception>
    /// <exception cref="ArgumentException">
    /// <paramref name="scenario"/> declares another kind, or <paramref name="context"/> supplies a
    /// participant built for another <see cref="ExecutionMode"/>. Both are harness faults that
    /// affect every run of the scenario rather than properties of one run.
    /// </exception>
    /// <exception cref="InvalidOperationException">
    /// The injected <see cref="IConversationExchange"/> reports a blank transport kind, or one
    /// that names a <see cref="ScenarioKind"/>. That is a constant defect in the adapter affecting
    /// every scenario it touches, rather than a property of one run, so it is surfaced rather than
    /// recorded as one scenario's outcome.
    /// </exception>
    /// <exception cref="OperationCanceledException"><paramref name="cancellationToken"/> was cancelled.</exception>
    public async Task<Transcript> RunAsync(Scenario scenario, RunContext context, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(scenario);
        ArgumentNullException.ThrowIfNull(context);
        cancellationToken.ThrowIfCancellationRequested();
        RunnerSupport.RequireKind(scenario, Kind, "llm");
        RunnerSupport.RequireParticipantMatchesMode(scenario, context.Participant);

        var transport = RequireTransportKind();
        var terminal = scenario.Execution.TerminalCondition;
        var cap = EffectiveTurnCap(terminal.MaxTurns);
        var startedAt = _clock.UtcNow;
        var turns = new List<Turn>();
        var fromAdapter = new Dictionary<string, string>(StringComparer.Ordinal);
        var outcome = new Outcome();

        // A run that never sends anything starts here, and only a run that does overwrites it —
        // so a scenario with nothing to send cannot quietly look like a clean empty run.
        var state = ExchangeState.NotAttempted;
        var stoppedBy = StopReason.ParticipantComplete;
        var failure =
            $"Scenario '{scenario.Identity.Id}' offered no stimulus: the participant completed before the "
            + "first turn, so nothing was sent and this run observed nothing about the system under test.";

        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();

            // The cap is checked before the participant is asked, so it bounds the conversation
            // whatever the participant would have said next. It is never null: EffectiveTurnCap
            // falls back to the runner's own ceiling, which is what stops a model-driven caller
            // that has no reason of its own to stop.
            if (turns.Count >= cap)
            {
                stoppedBy = StopReason.TurnCeiling;
                break;
            }

            ParticipantTurn offered;

            try
            {
                offered = await context.Participant.NextAsync(SnapshotSoFar(), cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                // The caller abandoned the run, rather than the participant failing.
                throw;
            }
            // The simulated caller could not say what comes next. It tested nothing, so this is a
            // harness failure — recorded rather than thrown, so that one run's caller failing
            // cannot take down a mixed suite. The filter is on the run's token rather than on the
            // exception type: a provider timeout surfaces as an OperationCanceledException with
            // this token untouched, and excluding that type would let one caller's timeout abort
            // the whole suite instead of recording one ungradeable run.
            catch (Exception exception) when (!cancellationToken.IsCancellationRequested)
            {
                state = ExchangeState.ParticipantFailed;
                failure = Explain(
                    "the simulated caller could not produce a stimulus",
                    exception.GetType().Name,
                    exception
                );
                stoppedBy = StopReason.ParticipantFailed;
                break;
            }

            if (offered.IsComplete)
            {
                // Completion ends the loop, whatever StopOnParticipantCompletion says: with no
                // stimulus there is nothing to send. Note that this is the only influence a
                // participant has over termination, and it is the one direction that is safe —
                // it can stop early, never continue past the cap.
                stoppedBy = StopReason.ParticipantComplete;
                break;
            }

            // ParticipantTurn makes the other state unrepresentable: a turn that is not complete
            // carries both a stimulus and its provenance. The provenance is recorded exactly as
            // declared and never re-derived here — a runner that decided provenance for itself
            // would be guessing at something only the participant knows.
            var stimulus = offered.Stimulus!;
            var provenance = offered.Provenance!.Value;
            var index = turns.Count + 1;

            // ...but "recorded as declared" is not "taken on trust". Under deterministic execution
            // the suite loader has already approved assertions on the premise that this turn was
            // replayed verbatim from the suite file, and this is the last point at which the two
            // can still be compared. Refused before the stimulus reaches the system under test:
            // a turn the script did not drive is evidence the guard never covered, so the run is
            // recorded as ungradeable rather than graded against a premise nothing established.
            if (RunnerSupport.DescribeScriptedPrefixMismatch(scenario, index, stimulus, provenance) is { } mismatch)
            {
                state = ExchangeState.ParticipantFailed;
                failure = Explain(
                    "the participant did not drive this scenario's script, so the suite loader's approval of "
                        + "otherwise-unscoped assertions rests on nothing and grading this run would measure the "
                        + "caller rather than the system under test",
                    mismatch.Classification,
                    mismatch.Detail
                );
                stoppedBy = StopReason.ParticipantFailed;
                break;
            }

            var turnStartedAt = _clock.UtcNow;

            // Run-level evidence describes the turn the run *ends* on, so each turn starts from
            // nothing rather than inheriting the last one's account of itself. Over many turns
            // this is where a stale outcome or a stale attribute would otherwise accumulate, and
            // an earlier success would get attributed to a later turn that failed.
            fromAdapter.Clear();
            outcome = new Outcome();

            ConversationResponse reply;

            try
            {
                reply =
                    await _exchange
                        .SendAsync(
                            new ConversationStimulus
                            {
                                Scenario = scenario,
                                Text = stimulus,
                                TurnIndex = index,
                                Seed = context.Seed,
                                Repetition = context.Repetition,
                            },
                            cancellationToken
                        )
                        .ConfigureAwait(false)
                    ?? throw new InvalidOperationException("the adapter returned nothing");
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (OperationCanceledException exception)
            {
                // Our token is not cancelled, so this is the transport's own timeout.
                state = ExchangeState.TimedOut;
                failure = Explain(
                    "the exchange did not complete within the transport's timeout",
                    exception.GetType().Name,
                    exception
                );
                stoppedBy = StopReason.ExchangeFailed;
                turns.Add(Record(index, stimulus, response: null, provenance, turnStartedAt));
                break;
            }
            catch (HttpRequestException exception)
            {
                // The adapter owns the transport here, so this is the one failure it can raise
                // that unambiguously means the request never completed.
                state = ExchangeState.RequestFailed;
                failure = Explain(
                    "the stimulus never reached the system under test",
                    exception.HttpRequestError.ToString(),
                    exception
                );
                stoppedBy = StopReason.ExchangeFailed;
                turns.Add(Record(index, stimulus, response: null, provenance, turnStartedAt));
                break;
            }
            // The adapter read the reply and rejected it. That is a verdict about the *system*, so
            // the run stays gradeable — a suite asserting on malformed output must still catch a
            // real regression.
            catch (MalformedResponseException exception)
            {
                state = ExchangeState.MalformedResponse;
                failure = Explain(
                    "the response could not be interpreted",
                    nameof(MalformedResponseException),
                    exception
                );
                stoppedBy = StopReason.ExchangeFailed;
                turns.Add(Record(index, stimulus, response: null, provenance, turnStartedAt));
                break;
            }
            // The adapter fell over, or returned nothing. It reached no verdict, so this run holds
            // no basis on which to grade the system under test.
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                state = ExchangeState.AdapterFailed;
                failure = Explain(
                    "the adapter failed while conducting the exchange",
                    exception.GetType().Name,
                    exception
                );
                stoppedBy = StopReason.ExchangeFailed;
                turns.Add(Record(index, stimulus, response: null, provenance, turnStartedAt));
                break;
            }

            state = ExchangeState.Responded;
            failure = null;

            foreach (var attribute in Copy(reply.Attributes))
            {
                fromAdapter[attribute.Key] = attribute.Value;
            }

            // The run's outcome is what the *system* ultimately did. It is read from the adapter's
            // reading of the system's reply and from nowhere else — in particular, nothing the
            // simulated caller said reaches it. A simulator able to declare itself successful
            // would be grading the harness.
            outcome = new Outcome
            {
                ObservedOutcome = reply.ObservedOutcome,
                ObservedPath = reply.ObservedPath,
                Fields = Copy(reply.Fields),
            };
            turns.Add(Record(index, stimulus, reply.Text, provenance, turnStartedAt));

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
                Kind = transport,
                Endpoint = RunnerSupport.SanitizeEndpoint(_exchange.Endpoint),
                Attributes = RunnerSupport.Attributes(fromAdapter, NothingObserved, state, stoppedBy, failure),
            },
        };

        // What the participant is allowed to see: the turns so far and the outcome they produced.
        // Deliberately the same snapshot the REST runner builds — a participant must not be able
        // to tell which runner is driving it, or it could behave differently under evaluation.
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

    /// <summary>
    /// The transport identifier, refused when it is blank or names a scenario kind.
    /// </summary>
    /// <remarks>
    /// <see cref="TransportMetadata.Kind"/> is adapter-supplied here, which is a route into the
    /// transcript that the REST runner does not have — it hard-codes <c>http</c>. An adapter that
    /// wrote <c>llm</c> would put a scenario kind into the one artifact every downstream stage is
    /// supposed to be blind to, and every stage could then branch on it. That is a constant defect
    /// in the adapter affecting every scenario it touches, so it is surfaced rather than recorded
    /// as one run's outcome.
    /// </remarks>
    private string RequireTransportKind()
    {
        var transport = _exchange.TransportKind;
        var adapter = _exchange.GetType().Name;

        if (string.IsNullOrWhiteSpace(transport))
        {
            throw new InvalidOperationException(
                $"{adapter}.TransportKind is blank. A transcript records how the run reached the system under "
                    + "test, and one that claimed no transport at all could not be told apart from one whose "
                    + "transport was never recorded. Name it — 'http', 'inproc', whatever it is."
            );
        }

        foreach (var kind in Enum.GetNames<ScenarioKind>())
        {
            if (!string.Equals(transport, kind, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            throw new InvalidOperationException(
                $"{adapter}.TransportKind is '{transport}', which names a scenario kind rather than a transport. "
                    + "Assertions, aggregation, comparison, and reporting see only the transcript, and are meant "
                    + "to be unable to tell which kind produced it; a transcript naming its kind hands every one "
                    + "of them something to branch on. Name the transport instead — an LLM-backed system reached "
                    + "over HTTP is 'http', exactly as the REST runner records it."
            );
        }

        return transport;
    }

    /// <summary>
    /// Describes a failure in terms the runner can vouch for.
    /// </summary>
    /// <remarks>
    /// An exception's message is authored by whatever threw it — an SDK, a driver, the framework —
    /// and a failing provider call routinely names the endpoint, the deployment, or the key it
    /// failed on. This value is written into a committed artifact, so by default it carries what
    /// failed and the type that reported it, and the message only when a caller has opted in (§V).
    /// </remarks>
    private string Explain(string summary, string classification, Exception exception) =>
        Explain(summary, classification, exception.Message);

    /// <summary>
    /// The same rule, for a detail this runner composed rather than caught.
    /// </summary>
    /// <remarks>
    /// A composed detail quotes material the runner cannot vouch for either — the stimulus a
    /// participant offered is text of unknown provenance, and a refused turn is never recorded as
    /// a <see cref="Turn"/>, so this message is the only thing that could carry it into a
    /// committed artifact. One gate, so the two cannot drift.
    /// </remarks>
    private string Explain(string summary, string classification, string detail) =>
        _options.RetainUnredactedEvidence ? $"{summary} ({classification}): {detail}" : $"{summary} ({classification})";

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
}
