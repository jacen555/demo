using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Runners;

/// <summary>
/// One stimulus, and everything an adapter needs to deliver it to a conversational system.
/// </summary>
/// <remarks>
/// The same shape as <see cref="RestStimulus"/> and deliberately so: the two adapters differ in
/// the transport they speak, never in what the engine tells them about a turn.
/// </remarks>
public sealed record ConversationStimulus
{
    /// <summary>Gets the scenario being run.</summary>
    /// <remarks>
    /// Supplied whole because the address, protocol, and payload shape of a conversational system
    /// are properties of <i>that system</i>, not of the engine. Putting them on
    /// <see cref="Scenarios.Execution"/> would put one transport's vocabulary into a record a
    /// REST and an MCP scenario also travel through.
    /// </remarks>
    public required Scenario Scenario { get; init; }

    /// <summary>Gets the text to send. Never blank.</summary>
    public required string Text { get; init; }

    /// <summary>Gets the one-based index of the turn this stimulus drives.</summary>
    public required int TurnIndex { get; init; }

    /// <summary>Gets the seed this run was driven with.</summary>
    public required long Seed { get; init; }

    /// <summary>Gets the one-based repetition number within the scenario.</summary>
    public required int Repetition { get; init; }
}

/// <summary>
/// What an adapter made of one exchange with a conversational system, in the vocabulary the rest
/// of the engine speaks.
/// </summary>
/// <remarks>
/// Structurally identical to <see cref="RestResponse"/>. That is what lets
/// <see cref="LlmConversationRunner"/> and <see cref="RestRunner"/> build transcripts of the same
/// shape without either one knowing the other exists.
/// </remarks>
public sealed record ConversationResponse
{
    /// <summary>
    /// Gets the text recorded as <see cref="Turn.Response"/>, or <see langword="null"/> when the
    /// system returned nothing worth recording.
    /// </summary>
    /// <remarks>
    /// The adapter owns this rather than the runner capturing a raw payload, because this value is
    /// written into a committed artifact and a conversational system echoes back whatever it was
    /// given — including, in a prompt-injection scenario, whatever an attacker put there (§V).
    /// Redaction is the adapter's job because only the adapter knows its system's shape.
    /// </remarks>
    public string? Text { get; init; }

    /// <summary>
    /// Gets the terminal outcome the system named, or <see langword="null"/> when it named none.
    /// </summary>
    /// <remarks>
    /// <b>This is the system's claim, never the simulated caller's.</b> A model standing in for
    /// the caller has no route to this property — it is read from what the system under test
    /// returned, by an adapter that never sees the caller's reasoning. A harness that let the
    /// simulator declare the conversation resolved would be grading the simulator.
    /// <para>
    /// A non-blank value is what <see cref="TerminalCondition.StopOnTerminalOutcome"/> acts on, so
    /// naming an outcome <i>is</i> the terminal signal; there is no separate flag to get out of
    /// step with.
    /// </para>
    /// </remarks>
    public string? ObservedOutcome { get; init; }

    /// <summary>Gets the route the system took, or <see langword="null"/> when it reported none.</summary>
    public string? ObservedPath { get; init; }

    /// <summary>Gets the structured fields the system returned, flattened and keyed by path.</summary>
    public IReadOnlyDictionary<string, string?> Fields { get; init; } =
        new Dictionary<string, string?>(StringComparer.Ordinal);

    /// <summary>Gets transport detail the adapter learned that the runner could not know.</summary>
    /// <remarks>
    /// Merged into <see cref="TransportMetadata.Attributes"/> beneath the reserved keys in
    /// <see cref="TransportAttributes"/>, which always win — an adapter may add to the record of
    /// what happened on the wire but may not rewrite it.
    /// </remarks>
    public IReadOnlyDictionary<string, string> Attributes { get; init; } =
        new Dictionary<string, string>(StringComparer.Ordinal);
}

/// <summary>
/// Carries one stimulus to a conversational system under test and interprets what came back.
/// </summary>
/// <remarks>
/// <para>
/// The counterpart to <see cref="IRestExchange"/>, and separate from it for one reason: a
/// conversational system is not necessarily an HTTP one. It may be an in-process agent, an SDK
/// client, or a socket. Reaching for <see cref="HttpClient"/> here would bake HTTP into the
/// <see cref="ScenarioKind.Llm"/> path, which is the same mistake as putting a URL on
/// <see cref="Scenario"/> — one transport's assumptions frozen into a generic engine.
/// </para>
/// <para>
/// <b>This library ships no default implementation on purpose</b>, for the reason
/// <see cref="IRestExchange"/> ships none: the payload shape and the extraction of an outcome, a
/// route, and fields are entirely properties of the system being evaluated.
/// </para>
/// <para>
/// Unlike <see cref="IRestExchange"/>, which splits building a request from reading a reply, this
/// seam is a single asynchronous call. The runner cannot own the transport here, so it cannot
/// sit between the two halves — and a seam that pretended otherwise would force every adapter to
/// invent a wire format for the runner to carry.
/// </para>
/// </remarks>
public interface IConversationExchange
{
    /// <summary>
    /// Gets the transport identifier recorded as <see cref="TransportMetadata.Kind"/> — for
    /// example <c>http</c> or <c>inproc</c>.
    /// </summary>
    /// <remarks>
    /// <b>It names a transport, never a scenario kind.</b> The runner refuses a value that matches
    /// a <see cref="ScenarioKind"/> member, because a transcript that named its kind would let
    /// every downstream stage branch on it — undoing the one property the engine is built to
    /// hold. Blank is refused for the same class of reason: a transcript must not claim a
    /// transport it cannot name.
    /// </remarks>
    string TransportKind { get; }

    /// <summary>
    /// Gets the address the run is directed at, or <see langword="null"/> when the system under
    /// test has no address to report.
    /// </summary>
    /// <remarks>
    /// Recorded as <see cref="TransportMetadata.Endpoint"/> into a committed artifact, so an
    /// adapter must not put a credential in it (§V). The runner does not rely on that: what an
    /// adapter states here is stripped by the same rule <see cref="RestRunner"/> applies to the
    /// address it resolves itself — userinfo, query, and fragment removed, with a marker left in
    /// place of each. An address that does not parse into components cannot be taken apart that
    /// way and is redacted whole rather than recorded on trust.
    /// </remarks>
    string? Endpoint { get; }

    /// <summary>Sends one stimulus to the system under test and interprets its reply.</summary>
    /// <param name="stimulus">The stimulus to send, and the run it belongs to.</param>
    /// <param name="cancellationToken">Cancels the exchange.</param>
    /// <returns>The reply in the engine's vocabulary. Never <see langword="null"/>.</returns>
    /// <remarks>
    /// <para>
    /// Throwing <see cref="MalformedResponseException"/> is how an adapter reports a reply it
    /// cannot interpret. The runner records that as
    /// <see cref="ExchangeState.MalformedResponse"/> — it does not propagate, because a system
    /// returning nonsense is a finding about that system rather than a harness fault, and the run
    /// stays gradeable so a suite can assert on it.
    /// </para>
    /// <para>
    /// <b>Any other exception, and a <see langword="null"/> return, mean the adapter itself
    /// failed</b> and are recorded as <see cref="ExchangeState.AdapterFailed"/>, which
    /// <see cref="ExchangeState.IsHarnessFailure(string?)"/> reports as a harness failure. An
    /// adapter that fell over reached no verdict about the system, so grading the run as though it
    /// had would let a defective adapter manufacture a passing assertion.
    /// </para>
    /// <para>
    /// The adapter owns the transport here, so the runner cannot tell a connection that was never
    /// made from an adapter defect the way <see cref="RestRunner"/> can. A
    /// <see cref="HttpRequestException"/> is recorded as
    /// <see cref="ExchangeState.RequestFailed"/> because it unambiguously means the request did
    /// not complete; everything else lands on <see cref="ExchangeState.AdapterFailed"/>. Both are
    /// harness failures, so the distinction is diagnostic rather than load-bearing.
    /// </para>
    /// </remarks>
    Task<ConversationResponse> SendAsync(ConversationStimulus stimulus, CancellationToken cancellationToken);
}
