namespace Forge.EvalEngine.Comparison;

/// <summary>
/// Thrown when two artifacts cannot be compared at all.
/// </summary>
/// <remarks>
/// <para>
/// A scenario that diverged is reported as
/// <see cref="ScenarioClassification.NotComparable"/>, because the rest of the suite is still
/// comparable. This exception is for the divergences that make the whole comparison meaningless —
/// a different schema version, a different suite, a different root seed, or different harness
/// settings. There is no partial answer to give, and a confident delta computed across two runs
/// that were not conducted alike is worse than a refusal.
/// </para>
/// </remarks>
public sealed class ComparisonRefusedException : Exception
{
    /// <summary>Initializes a new instance of the <see cref="ComparisonRefusedException"/> class.</summary>
    public ComparisonRefusedException() { }

    /// <summary>Initializes a new instance with a message.</summary>
    /// <param name="message">The caller-facing explanation.</param>
    public ComparisonRefusedException(string message)
        : base(message) { }

    /// <summary>Initializes a new instance with a message and an inner exception.</summary>
    /// <param name="message">The caller-facing explanation.</param>
    /// <param name="innerException">The underlying failure.</param>
    public ComparisonRefusedException(string message, Exception innerException)
        : base(message, innerException) { }

    /// <summary>
    /// Gets the artifact property that diverged — <c>schemaVersion</c>, <c>suiteName</c>,
    /// <c>seed</c>, or the harness setting's key.
    /// </summary>
    public string? Property { get; init; }
}
