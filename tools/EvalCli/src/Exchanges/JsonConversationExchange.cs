using Forge.EvalEngine.Runners;

namespace Forge.EvalCli.Exchanges;

/// <summary>
/// The built-in <see cref="IConversationExchange"/> for a conversational system that speaks the
/// JSON contract described on <see cref="JsonExchangeContract"/> over HTTP.
/// </summary>
/// <remarks>
/// <para>
/// Selected with <c>--llm-exchange json</c>, and never registered without it.
/// </para>
/// <para>
/// <b>Each turn is sent on its own, and no conversation history is carried.</b> That is a real
/// limitation and it is stated rather than worked around: the seam hands an adapter one stimulus,
/// and accumulating prior turns would mean holding per-run state on an object the engine shares
/// across concurrent runs. Keyed wrongly — by scenario rather than by scenario <i>and</i>
/// repetition, say — that state would leak one run's conversation into another's, which is a far
/// worse failure than the one it would fix, and an invisible one. A system that genuinely needs
/// history needs an adapter that owns a session, not a shared dictionary; until then the turn
/// index travels in the body so the system under test can correlate if it keeps its own.
/// </para>
/// <para>
/// The <see cref="HttpClient"/> is injected and not owned, so the composition root keeps control
/// of handler lifetime.
/// </para>
/// </remarks>
internal sealed class JsonConversationExchange : IConversationExchange
{
    private readonly HttpClient _client;

    /// <summary>Initializes a new instance of the <see cref="JsonConversationExchange"/> class.</summary>
    /// <param name="client">The client to send with. Its base address is the endpoint.</param>
    /// <param name="endpointDisplay">
    /// The redacted address to record in the artifact. The redacted form is handed over rather
    /// than the dialling one, so there is no window in which a value carrying a query string is
    /// held by something whose job is to be serialized (§V).
    /// </param>
    /// <exception cref="ArgumentNullException"><paramref name="client"/> is null.</exception>
    public JsonConversationExchange(HttpClient client, string? endpointDisplay)
    {
        ArgumentNullException.ThrowIfNull(client);

        _client = client;
        Endpoint = endpointDisplay;
    }

    /// <inheritdoc/>
    /// <remarks>
    /// Names the transport, never the scenario kind. The runner refuses a value that matches a
    /// <c>ScenarioKind</c> member, because a transcript that named its kind would let every
    /// downstream stage branch on it.
    /// </remarks>
    public string TransportKind => "http";

    /// <inheritdoc/>
    public string? Endpoint { get; }

    /// <inheritdoc/>
    /// <remarks>
    /// Only <see cref="MalformedResponseException"/> is raised deliberately, and only for a body
    /// this contract cannot read. Everything else is allowed to propagate: the runner records a
    /// failed request as a request failure and anything else as an adapter failure, and both are
    /// harness failures rather than verdicts about the system. An adapter that swallowed its own
    /// fault and returned an empty reply would let a broken harness manufacture a passing
    /// assertion.
    /// </remarks>
    public async Task<ConversationResponse> SendAsync(
        ConversationStimulus stimulus,
        CancellationToken cancellationToken
    )
    {
        ArgumentNullException.ThrowIfNull(stimulus);
        cancellationToken.ThrowIfCancellationRequested();

        using var request = new HttpRequestMessage
        {
            Method = HttpMethod.Post,
            RequestUri = null,
            Content = JsonExchangeContract.CreateBody(
                stimulus.Scenario.Identity.Id,
                stimulus.Text,
                stimulus.TurnIndex,
                stimulus.Repetition,
                stimulus.Seed
            ),
        };

        using var response = await _client.SendAsync(request, cancellationToken).ConfigureAwait(false);

        var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        var reading = JsonExchangeContract.Read(body);

        return new ConversationResponse
        {
            Text = reading.Text,
            ObservedOutcome = reading.ObservedOutcome,
            ObservedPath = reading.ObservedPath,
            Fields = reading.Fields,
        };
    }
}
