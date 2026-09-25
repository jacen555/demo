namespace Forge.EvalEngine.Serialization;

/// <summary>
/// Thrown when a durable artifact carries an identifier that is a path on somebody's machine.
/// </summary>
/// <remarks>
/// <para>
/// A suite name, a scenario id, and a slicing tag are author-supplied labels that this engine
/// copies into the committed artifact and that a reporter renders into published output. A
/// checkout directory among them names the account a job runs as and the layout of the machine it
/// runs on (§V).
/// </para>
/// <para>
/// <b>Refused rather than treated as absent.</b> Yielding "no baseline" would have the caller
/// report "no regression" on the strength of never having compared anything — a false green
/// produced by a refusal rather than by working software. That is the same reason a malformed or
/// unsupported artifact throws.
/// </para>
/// <para>
/// <b>The offending value is never repeated.</b> This message reaches standard error and from
/// there CI logs, which on many setups are readable by anyone who can read the repository. An
/// exception that prints the path it refused has moved the disclosure rather than removed it, so
/// it names the <see cref="Field"/> and the <see cref="Position"/> instead.
/// </para>
/// </remarks>
public sealed class UnsafeIdentifierException : Exception
{
    /// <summary>Initializes a new instance.</summary>
    public UnsafeIdentifierException() { }

    /// <summary>Initializes a new instance with a message.</summary>
    /// <param name="message">The caller-facing explanation. Must not repeat the offending value.</param>
    public UnsafeIdentifierException(string message)
        : base(message) { }

    /// <summary>Initializes a new instance with a message and an inner exception.</summary>
    /// <param name="message">The caller-facing explanation. Must not repeat the offending value.</param>
    /// <param name="innerException">The underlying failure.</param>
    public UnsafeIdentifierException(string message, Exception innerException)
        : base(message, innerException) { }

    /// <summary>
    /// Gets the artifact field the refused identifier came from — for example <c>scenarioId</c>.
    /// </summary>
    public string? Field { get; init; }

    /// <summary>
    /// Gets the position of the offending scenario within the artifact — for example <c>#3</c> —
    /// or null for an artifact-level field.
    /// </summary>
    /// <remarks>
    /// A position rather than the identifier, because the identifier is the thing that may not be
    /// repeated. It is still enough for a reader to find the entry.
    /// </remarks>
    public string? Position { get; init; }
}
