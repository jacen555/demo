namespace Forge.EvalEngine.Runners;

/// <summary>
/// Thrown by an <see cref="IRestExchange"/> to report a response body it cannot interpret.
/// </summary>
/// <remarks>
/// <para>
/// This type exists to separate two failures that look identical from the runner's side and mean
/// opposite things. An adapter that throws <i>this</i> has read the body and reached a verdict:
/// the system under test returned something outside the shape it agreed to. That is evidence
/// about the system, so the run records
/// <see cref="Transcripts.ExchangeState.MalformedResponse"/> and stays gradeable — a suite that
/// asserts on malformed output should be able to catch a real regression.
/// </para>
/// <para>
/// An adapter that throws <b>anything else</b>, or returns <see langword="null"/>, has not reached
/// a verdict — it fell over. The run records
/// <see cref="Transcripts.ExchangeState.AdapterFailed"/> instead, which
/// <see cref="Transcripts.ExchangeState.IsHarnessFailure(string?)"/> reports as a harness failure.
/// <b>A defective adapter must never be able to produce a passing assertion about the system it
/// failed to read.</b>
/// </para>
/// <para>
/// The message travels into a committed artifact only when a caller has opted in via
/// <see cref="RestRunnerOptions.RetainUnredactedEvidence"/>, so an adapter may put the offending
/// fragment in it without that fragment being committed by default (§V).
/// </para>
/// </remarks>
public sealed class MalformedResponseException : Exception
{
    /// <summary>Initializes a new instance of the <see cref="MalformedResponseException"/> class.</summary>
    public MalformedResponseException()
        : base("The response body could not be interpreted.") { }

    /// <summary>Initializes a new instance of the <see cref="MalformedResponseException"/> class.</summary>
    /// <param name="message">What about the body could not be interpreted.</param>
    public MalformedResponseException(string message)
        : base(message) { }

    /// <summary>Initializes a new instance of the <see cref="MalformedResponseException"/> class.</summary>
    /// <param name="message">What about the body could not be interpreted.</param>
    /// <param name="innerException">The parse failure underneath.</param>
    public MalformedResponseException(string message, Exception innerException)
        : base(message, innerException) { }
}

/// <summary>
/// What a <see cref="RestRunner"/> is allowed to write into a transcript.
/// </summary>
/// <remarks>
/// A transcript is a committed artifact: it is written to disk, diffed, and attached to pull
/// requests. The default here is therefore the conservative one, and a caller who needs more for
/// debugging asks for it explicitly rather than discovering afterwards that a token reached git
/// history (§V).
/// </remarks>
public sealed record RestRunnerOptions
{
    /// <summary>Gets the conservative defaults every constructor overload uses.</summary>
    public static RestRunnerOptions Default { get; } = new();

    /// <summary>
    /// Gets a value indicating whether raw, unredacted evidence is persisted. Off by default.
    /// </summary>
    /// <remarks>
    /// <para>
    /// When off, the runner records safe structured evidence in place of two things that
    /// routinely carry credentials:
    /// </para>
    /// <list type="bullet">
    /// <item>
    /// <description>
    /// The body of a response nothing could interpret — a non-2xx page or a body the adapter
    /// rejected. These bypass the redaction an adapter applies to
    /// <see cref="RestResponse.Text"/>, which is exactly why they are the leak. The runner writes
    /// <see cref="Transcripts.TransportAttributes.ResponseBodyLength"/> and
    /// <see cref="Transcripts.TransportAttributes.ResponseBodyHash"/> instead.
    /// </description>
    /// </item>
    /// <item>
    /// <description>
    /// The message of an exception, which is authored by whatever threw it — a handler, a driver,
    /// the framework — and commonly names the endpoint or connection string it failed on.
    /// <see cref="Transcripts.TransportAttributes.Failure"/> names the failure and its type
    /// instead.
    /// </description>
    /// </item>
    /// </list>
    /// <para>
    /// Turning this on is appropriate against a system under test with no real credentials — a
    /// local fake, a throwaway environment — and inappropriate anywhere the transcript is
    /// committed.
    /// </para>
    /// </remarks>
    public bool RetainUnredactedEvidence { get; init; }
}
