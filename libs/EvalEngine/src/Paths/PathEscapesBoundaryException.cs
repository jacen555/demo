namespace Forge.EvalEngine.Paths;

/// <summary>
/// Signals that a path was refused because it leaves the boundary it was confined to.
/// </summary>
/// <remarks>
/// <para>
/// This is <see cref="PathBoundary.Resolve(string)"/>'s primary answer, so a consumer that calls
/// it has to be able to catch this. It covers every way out of a boundary, and they are not the
/// same way: a path that reads outside the root as written, a link met part-way along that points
/// outside it, and a path whose fully resolved form lands outside it. All three are the same
/// verdict to a caller, which is why they share one type.
/// </para>
/// <para>
/// <b>A refusal carries no inner exception.</b> There is nothing to report as a cause because
/// nothing failed — the boundary declined to look. An instance of this type arriving with a cause
/// attached would mean the I/O it exists to prevent had already happened, so the absence is part
/// of what the type asserts rather than an omission.
/// </para>
/// <para>
/// It derives from <see cref="IOException"/> so that a caller which handles only that still fails
/// closed, and so that the compiler forces a caller which wants to tell a refusal apart from an
/// inspection failure to catch this one first.
/// </para>
/// </remarks>
public class PathEscapesBoundaryException : IOException
{
    /// <summary>Initializes a new instance of the <see cref="PathEscapesBoundaryException"/> class.</summary>
    public PathEscapesBoundaryException()
        : base("A path was refused because it resolves outside the boundary it was confined to.") { }

    /// <summary>Initializes a new instance with a message.</summary>
    /// <param name="message">The caller-facing explanation of the refusal.</param>
    public PathEscapesBoundaryException(string message)
        : base(message) { }

    /// <summary>Initializes a new instance with a message and an inner exception.</summary>
    /// <param name="message">The caller-facing explanation of the refusal.</param>
    /// <param name="innerException">The underlying failure.</param>
    /// <remarks>
    /// Present because a public exception type is expected to offer it. A refusal raised by
    /// <see cref="PathBoundary"/> never uses it: see the type-level remarks on why a cause would
    /// contradict the refusal.
    /// </remarks>
    public PathEscapesBoundaryException(string message, Exception innerException)
        : base(message, innerException) { }
}
