using System.Globalization;
using System.Text;
using Forge.EvalEngine.Abstractions;

namespace Forge.EvalEngine.Llm;

/// <summary>
/// One recorded exchange: the request content that was sent, and the completion that came back.
/// </summary>
/// <remarks>
/// A recording is keyed by <see cref="Prompt"/> and <see cref="Context"/> only. Sampling
/// parameters are deliberately <b>not</b> part of its identity — see
/// <see cref="RecordedLlmClient"/> for why.
/// </remarks>
public sealed record LlmRecording
{
    private readonly string _prompt = string.Empty;

    /// <summary>Gets the instruction this recording answers.</summary>
    /// <exception cref="ArgumentException">The value is null, empty, or whitespace.</exception>
    public required string Prompt
    {
        get => _prompt;
        init
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(value, nameof(value));

            _prompt = value;
        }
    }

    /// <summary>Gets the prior context this recording answers, oldest first.</summary>
    public IReadOnlyList<string> Context { get; init; } = [];

    /// <summary>Gets the completion replayed for a request that matches.</summary>
    /// <remarks>
    /// May be blank. A model that returns nothing is a real case a suite should be able to
    /// reproduce, and refusing to record it would make the one failure mode worth testing the one
    /// the fake cannot express.
    /// </remarks>
    public required string Completion { get; init; }
}

/// <summary>
/// Thrown when a <see cref="RecordedLlmClient"/> holds no recording for a request.
/// </summary>
/// <remarks>
/// <b>Loud, because the alternative manufactures a false green.</b> A replaying client that
/// returned an empty string, a canned apology, or the nearest recording for an unmatched request
/// would let a test that no longer exercises what it was written to exercise keep passing — and
/// the transcript would look exactly like a real run. So it throws, the runner records
/// <see cref="Transcripts.ExchangeState.ParticipantFailed"/>, and the run is not gradeable.
/// </remarks>
public sealed class MissingRecordingException : Exception
{
    /// <summary>Initializes a new instance of the <see cref="MissingRecordingException"/> class.</summary>
    public MissingRecordingException()
        : base("No recorded completion matches this request.") { }

    /// <summary>Initializes a new instance of the <see cref="MissingRecordingException"/> class.</summary>
    /// <param name="message">Which request had no recording.</param>
    public MissingRecordingException(string message)
        : base(message) { }

    /// <summary>Initializes a new instance of the <see cref="MissingRecordingException"/> class.</summary>
    /// <param name="message">Which request had no recording.</param>
    /// <param name="innerException">The failure underneath.</param>
    public MissingRecordingException(string message, Exception innerException)
        : base(message, innerException) { }
}

/// <summary>
/// An <see cref="ILlmClient"/> that replays recorded completions, keyed by request content.
/// </summary>
/// <remarks>
/// <para>
/// This is how a suite driven by <see cref="Participants.LlmCaller"/> becomes reproducible, and
/// the mechanism matters. <b>Determinism here comes from content addressing, not from sampling
/// parameters.</b> A request's identity is its prompt and its context and nothing else:
/// <see cref="LlmRequest.Seed"/> and <see cref="LlmRequest.Temperature"/> are excluded from the
/// key on purpose.
/// </para>
/// <para>
/// That exclusion is the design, not an oversight. A seed is a best-effort hint no provider
/// guarantees — bitwise determinism is unattainable on GPU inference even at temperature zero —
/// and providers are actively withdrawing the sampling parameters from newer models. A fake keyed
/// on them would be reproducible only for as long as the provider kept honouring them, and would
/// start missing recordings the day a caller passed a different seed for reasons that had nothing
/// to do with what it was asking. Keyed on content, the same conversation replays identically
/// whatever the sampling parameters say, or whether they are present at all.
/// </para>
/// <para>
/// The key is built by length-prefixing every part, so no arrangement of separators in a prompt
/// can be made to collide with a different context — there is no delimiter to inject.
/// </para>
/// <para>
/// <b>An unmatched request throws</b> <see cref="MissingRecordingException"/> rather than
/// returning a fallback. See that type for why.
/// </para>
/// <para>This type is thread-safe. Its recordings are immutable and its call log is guarded.</para>
/// </remarks>
public sealed class RecordedLlmClient : ILlmClient
{
    private readonly Dictionary<string, string> _completions;
    private readonly List<LlmRequest> _requests = [];
    private readonly Lock _gate = new();

    /// <summary>Creates a client over a fixed set of recordings.</summary>
    /// <param name="recordings">The recordings to replay.</param>
    /// <exception cref="ArgumentNullException"><paramref name="recordings"/> is null, or contains a null.</exception>
    /// <exception cref="ArgumentException">
    /// Two recordings share the same prompt and context. Which completion applies would then
    /// depend on enumeration order, so the set is refused rather than resolved arbitrarily — a
    /// fake whose replay depended on ordering would defeat the only reason it exists.
    /// </exception>
    public RecordedLlmClient(IEnumerable<LlmRecording> recordings)
    {
        ArgumentNullException.ThrowIfNull(recordings);

        _completions = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var recording in recordings)
        {
            ArgumentNullException.ThrowIfNull(recording, nameof(recordings));

            if (!_completions.TryAdd(Key(recording.Prompt, recording.Context), recording.Completion))
            {
                throw new ArgumentException(
                    "Two recordings share the same prompt and context, so which completion applies would depend "
                        + "on the order they happened to be enumerated in. A fake whose replay depends on ordering "
                        + "is not reproducible, which is the only reason this type exists — so the set is refused "
                        + "rather than resolved arbitrarily. Give the two recordings different context.",
                    nameof(recordings)
                );
            }
        }
    }

    /// <summary>Gets the requests this client has been asked to complete, in order.</summary>
    /// <remarks>
    /// A snapshot, so enumerating it while a run is in flight is safe. Exposed so a test can
    /// assert on what the simulated caller was actually told — the prompt is where grounding
    /// either happened or did not.
    /// </remarks>
    public IReadOnlyList<LlmRequest> Requests
    {
        get
        {
            lock (_gate)
            {
                return [.. _requests];
            }
        }
    }

    /// <summary>Replays the completion recorded for this request's content.</summary>
    /// <param name="request">The request.</param>
    /// <param name="cancellationToken">Cancels the call.</param>
    /// <returns>The recorded completion.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="request"/> is null.</exception>
    /// <exception cref="MissingRecordingException">No recording matches the request's content.</exception>
    /// <exception cref="OperationCanceledException"><paramref name="cancellationToken"/> was cancelled.</exception>
    public Task<string> CompleteAsync(LlmRequest request, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(request);

        lock (_gate)
        {
            _requests.Add(request);
        }

        if (_completions.TryGetValue(Key(request.Prompt, request.Context), out var completion))
        {
            return Task.FromResult(completion);
        }

        // The request is described rather than quoted. A prompt carries a scenario's facts, which
        // are a suite author's material and may be anything; this message can reach a transcript
        // when a caller has opted into unredacted evidence, so it stays a description (§V). The
        // request itself is on Requests for a test that needs it.
        return Task.FromException<string>(
            new MissingRecordingException(
                $"No recorded completion matches this request: a prompt of {Render(request.Prompt.Length)} "
                    + $"character(s) with {Render(request.Context.Count)} context entry(ies), against "
                    + $"{Render(_completions.Count)} recording(s). Sampling parameters are deliberately not part "
                    + "of a request's identity, so a differing seed or temperature is not the cause — the prompt "
                    + "or the conversation so far is not the one that was recorded. Inspect Requests for the "
                    + "request that missed, and record it rather than relaxing the match: a replaying client that "
                    + "guessed would let a test keep passing while exercising nothing."
            )
        );
    }

    private static string Render(int value) => value.ToString(CultureInfo.InvariantCulture);

    /// <summary>
    /// The content key for a prompt and its context: every part length-prefixed, so no prompt can
    /// be written to collide with a different context.
    /// </summary>
    private static string Key(string prompt, IReadOnlyList<string>? context)
    {
        var builder = new StringBuilder();
        Append(builder, prompt);

        var count = context?.Count ?? 0;
        builder.Append(Render(count)).Append('|');

        for (var index = 0; index < count; index++)
        {
            Append(builder, context![index] ?? string.Empty);
        }

        return builder.ToString();

        // '<length>:<text>|'. A reader takes the digits, then exactly that many characters, so the
        // encoding is injective: no separator appears in a position a caller could exploit, and a
        // prompt cannot be written to look like a prompt plus a context entry.
        static void Append(StringBuilder builder, string part) =>
            builder.Append(Render(part.Length)).Append(':').Append(part).Append('|');
    }
}
