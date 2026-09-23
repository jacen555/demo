namespace Forge.EvalEngine.Transcripts;

/// <summary>
/// The attribute keys every runner in this library writes into
/// <see cref="TransportMetadata.Attributes"/>.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="TransportMetadata.Attributes"/> is deliberately an open dictionary — a field there
/// would force every downstream stage to know which transports exist. Open does not mean
/// arbitrary, though: a suite author writes <c>expectedBehavior:transport/statusCode=429</c> and a
/// later stage reads the same key to decide whether a run is gradeable at all. Two magic strings
/// that must agree and are never checked against each other is how a false green is manufactured,
/// so the keys that carry meaning across stages are named here once.
/// </para>
/// <para>
/// Everything a runner learns that is not in this list is still written — adapters add their own
/// keys freely. These are only the ones with a defined meaning. <b>Reserved keys always win:</b> a
/// runner writes them last, so an adapter cannot overwrite the record of what happened on the wire
/// with its own interpretation of it.
/// </para>
/// </remarks>
public static class TransportAttributes
{
    /// <summary>
    /// What happened on the wire. Always present; one of the <see cref="ExchangeState"/> values.
    /// </summary>
    public const string Exchange = "exchange";

    /// <summary>
    /// Why the turn loop ended. Always present; one of the <see cref="StopReason"/> values.
    /// </summary>
    public const string StoppedBy = "stoppedBy";

    /// <summary>
    /// Why the exchange did not complete normally. Present only when
    /// <see cref="Exchange"/> is not <see cref="ExchangeState.Responded"/>.
    /// </summary>
    /// <remarks>
    /// Carries a message, never a stack trace or connection detail — this value is written into a
    /// committed artifact.
    /// </remarks>
    public const string Failure = "failure";

    /// <summary>
    /// The HTTP status code of the last response, as its integer rendered invariantly. Present
    /// only when a response was actually received.
    /// </summary>
    public const string StatusCode = "statusCode";

    /// <summary>The HTTP reason phrase of the last response, when the server supplied one.</summary>
    public const string ReasonPhrase = "reasonPhrase";

    /// <summary>The HTTP method of the last request sent.</summary>
    public const string Method = "method";

    /// <summary>
    /// The character length of a response body the runner did not persist. Present only when a
    /// response could not be interpreted and its body was therefore withheld.
    /// </summary>
    /// <remarks>
    /// Structured evidence stands in for the body by default. An uninterpreted body is raw output
    /// from the system under test, it bypasses whatever redaction the adapter would have applied,
    /// and it is written into a committed artifact — so a length and a fingerprint are recorded
    /// instead of the text (§V).
    /// </remarks>
    public const string ResponseBodyLength = "responseBodyLength";

    /// <summary>
    /// A truncated SHA-256 of a response body the runner did not persist, as lower-case hex.
    /// Present only when that body was non-empty.
    /// </summary>
    /// <remarks>
    /// Enough to tell two error bodies apart, to recognise the same one recurring across a suite,
    /// and to confirm a fix changed what came back — without committing the text itself.
    /// </remarks>
    public const string ResponseBodyHash = "responseBodyHash";
}

/// <summary>
/// The values of <see cref="TransportAttributes.Exchange"/> — what happened on the wire.
/// </summary>
/// <remarks>
/// This is the distinction between <i>evidence about the system under test</i> and <i>the harness
/// failing to gather any</i>. A refusal is evidence: a scenario whose whole point is "this should
/// 429" passes when the system does exactly that. A connection that was never made is not: there
/// is nothing to grade, and grading it anyway would report a verdict about a system that was never
/// asked.
/// </remarks>
public static class ExchangeState
{
    /// <summary>
    /// The system under test returned a response. Includes a 4xx and a 5xx — a refusal is an
    /// answer, and <see cref="Assertions.AssertionCategory.ExpectedBehavior"/> exists to assert
    /// on one.
    /// </summary>
    public const string Responded = "responded";

    /// <summary>
    /// The system under test answered, and the adapter reported that it could not interpret what
    /// it said.
    /// </summary>
    /// <remarks>
    /// Classified as evidence rather than harness failure: the request was delivered and the
    /// adapter reached a considered verdict on the body, so what is wrong is the <i>system's</i>
    /// output. Reporting it as a harness error would excuse a real regression.
    /// <para>
    /// This means the adapter <b>explicitly</b> reported it, by throwing
    /// <see cref="Runners.MalformedResponseException"/>. An adapter that merely fell over is
    /// <see cref="AdapterFailed"/> — see that member for why the distinction matters.
    /// </para>
    /// </remarks>
    public const string MalformedResponse = "malformedResponse";

    /// <summary>
    /// The adapter failed while interpreting a response, in a way it did not report as a verdict
    /// about the body.
    /// </summary>
    /// <remarks>
    /// <b>This is a statement about the harness, not about the system under test</b>, and it is
    /// the distinction that keeps a defective adapter from manufacturing a passing assertion. An
    /// adapter that throws <see cref="ArgumentException"/> from a bad index, or returns
    /// <see langword="null"/>, has not judged the response at all — so the run has no basis on
    /// which to grade the system, and <see cref="IsHarnessFailure(string?)"/> reports it as the
    /// harness failure it is.
    /// <para>
    /// Recorded rather than thrown so that one adapter's defect cannot take down a mixed suite,
    /// by the same reasoning as <see cref="Unsupported"/>.
    /// </para>
    /// </remarks>
    public const string AdapterFailed = "adapterFailed";

    /// <summary>The request did not complete within the transport's timeout.</summary>
    public const string TimedOut = "timedOut";

    /// <summary>The request never reached the system under test.</summary>
    public const string RequestFailed = "requestFailed";

    /// <summary>
    /// No request was sent, because the participant completed before offering a single stimulus.
    /// </summary>
    public const string NotAttempted = "notAttempted";

    /// <summary>
    /// The participant failed while producing a stimulus, so the run could not continue.
    /// </summary>
    /// <remarks>
    /// <b>A statement about the harness, not about the system under test.</b> A simulated caller
    /// that cannot say what comes next — its model call failed, a replaying client held no
    /// recording for the request, the model returned nothing usable — has not tested anything. The
    /// turns already recorded stand, because they happened, but
    /// <see cref="IsHarnessFailure(string?)"/> reports the run as ungradeable so a conversation cut
    /// short by the <i>caller</i> cannot be read as the system declining to continue.
    /// <para>
    /// Recorded rather than thrown, by the same reasoning as <see cref="AdapterFailed"/>: a
    /// participant is supplied per run and one run's caller failing must not take down a mixed
    /// suite.
    /// </para>
    /// </remarks>
    public const string ParticipantFailed = "participantFailed";

    /// <summary>
    /// This build cannot speak the transport the scenario declared, so no exchange was attempted.
    /// </summary>
    /// <remarks>
    /// A declared gap rather than a surprise, and recorded rather than thrown so that one
    /// unsupported scenario cannot take down a mixed suite. It is still a harness failure by
    /// <see cref="IsHarnessFailure(string?)"/>: the run produced no evidence about the system
    /// under test, and a status that read as anything else would let a suite of entirely
    /// unsupported scenarios report as clean.
    /// </remarks>
    public const string Unsupported = "unsupported";

    /// <summary>Reads the exchange state a transcript recorded.</summary>
    /// <param name="transcript">The transcript to read.</param>
    /// <returns>The recorded state, or <see langword="null"/> when none was recorded.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="transcript"/> is null.</exception>
    public static string? Of(Transcript transcript)
    {
        ArgumentNullException.ThrowIfNull(transcript);

        return transcript.Transport.Attributes.TryGetValue(TransportAttributes.Exchange, out var state) ? state : null;
    }

    /// <summary>
    /// Determines whether a state means the harness failed to gather evidence, rather than the
    /// system under test behaving badly.
    /// </summary>
    /// <param name="state">The recorded state, which may be absent or unrecognised.</param>
    /// <returns>
    /// <see langword="false"/> only for the states that produced something to grade.
    /// </returns>
    /// <remarks>
    /// <b>This fails closed.</b> An absent or unrecognised state reports as a harness failure,
    /// because the alternative — reading "I do not know what happened" as "nothing went wrong" —
    /// is the shape of every false green this library guards against. That is also why
    /// <see cref="AdapterFailed"/> needs no clause here: only the two states that produced
    /// something to grade are named, and everything else is a harness failure by default.
    /// </remarks>
    public static bool IsHarnessFailure(string? state) =>
        !(
            string.Equals(state, Responded, StringComparison.Ordinal)
            || string.Equals(state, MalformedResponse, StringComparison.Ordinal)
        );
}

/// <summary>
/// The values of <see cref="TransportAttributes.StoppedBy"/> — why the turn loop ended.
/// </summary>
/// <remarks>
/// Distinct from <see cref="ExchangeState"/>, which says what happened on the wire. On a healthy
/// run the wire says <see cref="ExchangeState.Responded"/> either way, and only this says whether
/// the run ended because the caller had nothing more to say, because the system reached a terminal
/// outcome, or because it hit a declared ceiling.
/// </remarks>
public static class StopReason
{
    /// <summary>The participant had no further stimulus to send.</summary>
    /// <remarks>
    /// This ends the loop whatever
    /// <see cref="Scenarios.TerminalCondition.StopOnParticipantCompletion"/> says: with no
    /// stimulus there is nothing to send, and a runner that invented one would be measuring
    /// itself. That flag governs whether completion is a <i>declared</i> terminal condition — which
    /// is what the suite loader reads when it decides an unscoped assertion is safe — not whether
    /// the runner can continue without a caller.
    /// </remarks>
    public const string ParticipantComplete = "participantComplete";

    /// <summary>The system under test reached a terminal outcome.</summary>
    public const string TerminalOutcome = "terminalOutcome";

    /// <summary>The run reached <see cref="Scenarios.TerminalCondition.MaxTurns"/>.</summary>
    /// <remarks>
    /// Or the runner's own ceiling, where it has one. A
    /// <see cref="Runners.LlmConversationRunner"/> caps every conversation whether the scenario
    /// declared a ceiling or not, so this value also means "the harness stopped it" — which is
    /// the point: termination must never belong to the participant.
    /// </remarks>
    public const string TurnCeiling = "turnCeiling";

    /// <summary>The participant failed while producing a stimulus.</summary>
    /// <remarks>
    /// Paired with <see cref="ExchangeState.ParticipantFailed"/>, which is what makes the run
    /// ungradeable. This says only that the loop ended for that reason; the detail is in
    /// <see cref="TransportAttributes.Failure"/>.
    /// </remarks>
    public const string ParticipantFailed = "participantFailed";

    /// <summary>
    /// The exchange did not complete successfully, so there was no sound basis for another turn.
    /// </summary>
    /// <remarks>
    /// The detail is in <see cref="TransportAttributes.Exchange"/> and
    /// <see cref="TransportAttributes.Failure"/>. Driving a further turn against a system that has
    /// already refused would produce turns whose stimuli answer an error body, which measures the
    /// simulated caller rather than the system.
    /// </remarks>
    public const string ExchangeFailed = "exchangeFailed";

    /// <summary>No loop ran: this build cannot speak the transport the scenario declared.</summary>
    public const string Unsupported = "unsupported";
}
