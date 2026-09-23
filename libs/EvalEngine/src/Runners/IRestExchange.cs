using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Runners;

/// <summary>
/// One stimulus, and everything an adapter needs to turn it into an HTTP request.
/// </summary>
public sealed record RestStimulus
{
    /// <summary>Gets the scenario being run.</summary>
    /// <remarks>
    /// Supplied whole because the address, method, and payload shape of a request are properties
    /// of the <i>system under test</i>, not of the engine. Putting them on
    /// <see cref="Scenarios.Execution"/> would put HTTP's vocabulary into a record that an MCP and
    /// an LLM scenario also travel through.
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
/// What came back off the wire, before anything interpreted it.
/// </summary>
/// <remarks>
/// The runner reads the body rather than handing over the <see cref="HttpResponseMessage"/>, for
/// two reasons: the raw text survives into the transcript even when the adapter cannot interpret
/// it, and an adapter given a live response could start doing I/O in a stage that must not have
/// any.
/// </remarks>
public sealed record RestReply
{
    /// <summary>Gets the HTTP status code.</summary>
    public required int StatusCode { get; init; }

    /// <summary>Gets the HTTP reason phrase, when the server supplied one.</summary>
    public string? ReasonPhrase { get; init; }

    /// <summary>Gets the response body. Empty rather than null when the body carried nothing.</summary>
    public required string Body { get; init; }
}

/// <summary>
/// What an adapter made of a reply, in the vocabulary the rest of the engine speaks.
/// </summary>
public sealed record RestResponse
{
    /// <summary>
    /// Gets the text recorded as <see cref="Turn.Response"/>, or <see langword="null"/> when the
    /// system returned nothing worth recording.
    /// </summary>
    /// <remarks>
    /// The adapter owns this rather than the runner copying the body, because this value is
    /// written into a committed artifact and an adapter may need to redact what its system echoes
    /// back (§V). A body the adapter never interpreted — an error page, or one it rejected — is
    /// withheld by default for exactly that reason, and stands in the transcript as
    /// <see cref="Transcripts.TransportAttributes.ResponseBodyLength"/> and
    /// <see cref="Transcripts.TransportAttributes.ResponseBodyHash"/> unless the caller opted in
    /// via <see cref="RestRunnerOptions.RetainUnredactedEvidence"/>.
    /// </remarks>
    public string? Text { get; init; }

    /// <summary>
    /// Gets the terminal outcome the system named, or <see langword="null"/> when it named none.
    /// </summary>
    /// <remarks>
    /// A non-blank value is what <see cref="Scenarios.TerminalCondition.StopOnTerminalOutcome"/>
    /// acts on. <see cref="Outcome.ObservedOutcome"/> is documented as the terminal outcome the
    /// system reached, so naming one <i>is</i> the terminal signal; there is no separate flag for
    /// an adapter to get out of step with.
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
/// Translates between one stimulus and the HTTP surface of the system under test.
/// </summary>
/// <remarks>
/// <para>
/// A <see cref="Scenario"/> carries no address, method, or payload shape, and deliberately so: it
/// is the one record a REST, an MCP, and an LLM scenario all travel through, and the moment HTTP's
/// vocabulary enters it the "generic" engine has encoded one transport's assumptions. This seam is
/// where that knowledge lives instead, and it is the only thing about a REST run that a system
/// under test gets to decide.
/// </para>
/// <para>
/// <b>This library ships no default implementation on purpose.</b> The request shape and the
/// extraction of an outcome, a route, and fields from a body are entirely properties of the system
/// being evaluated. Any "default" would be one system's JSON shape frozen into a generic library,
/// and every other system would then be a special case of a shape that was never general.
/// </para>
/// <para>
/// Both members are synchronous. Building a request and interpreting a body are pure functions of
/// their inputs; an await point here would be an invitation to do I/O in a stage whose
/// determinism the whole harness rests on.
/// </para>
/// </remarks>
public interface IRestExchange
{
    /// <summary>Builds the request that carries one stimulus.</summary>
    /// <param name="stimulus">The stimulus to send, and the run it belongs to.</param>
    /// <returns>
    /// The request. The runner disposes it, and resolves a relative
    /// <see cref="HttpRequestMessage.RequestUri"/> against the client's base address.
    /// </returns>
    HttpRequestMessage CreateRequest(RestStimulus stimulus);

    /// <summary>Interprets what the system under test returned.</summary>
    /// <param name="reply">The status and body that came back.</param>
    /// <returns>The reply in the engine's vocabulary. Never <see langword="null"/>.</returns>
    /// <remarks>
    /// <para>
    /// Throwing <see cref="MalformedResponseException"/> is how an adapter reports a body it
    /// cannot interpret. The runner records that as
    /// <see cref="Transcripts.ExchangeState.MalformedResponse"/> — it does not propagate, because
    /// a system returning nonsense is a finding about that system rather than a harness fault, and
    /// the run stays gradeable so a suite can assert on it.
    /// </para>
    /// <para>
    /// <b>Any other exception, and a <see langword="null"/> return, mean the adapter itself
    /// failed.</b> That is recorded as <see cref="Transcripts.ExchangeState.AdapterFailed"/>,
    /// which <see cref="Transcripts.ExchangeState.IsHarnessFailure(string?)"/> reports as a
    /// harness failure. The distinction is deliberate: an adapter that fell over reached no
    /// verdict about the system, so grading the run as though it had would let a defective adapter
    /// manufacture a passing assertion.
    /// </para>
    /// </remarks>
    RestResponse Read(RestReply reply);
}
