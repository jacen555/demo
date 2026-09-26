using System.Text.Json;

namespace Forge.EvalEngine.Serialization;

/// <summary>
/// Thrown when a durable artifact records a verdict its own evidence cannot support.
/// </summary>
/// <remarks>
/// <para>
/// <b>Distinct from <see cref="MalformedArtifactException"/>, because the remedy is different.</b>
/// A null where the shape forbids one is a file that cannot be read and is regenerated. This is a
/// file that reads perfectly and <i>claims something that did not happen</i>: a run stamped
/// <see cref="Results.RunStatus.Pass"/> beside a transcript recording that the system under test
/// was never successfully asked. Sending a reader to "regenerate it" would be the wrong
/// instruction — the run in it needs to happen.
/// </para>
/// <para>
/// <b>It derives from <see cref="JsonException"/> for the same reason its sibling does.</b>
/// Content this engine will not read is a category every existing reader already classifies as a
/// refusal with an exit code, so no consumer needs a change to keep classifying it correctly, and
/// one that wants the detail reads <see cref="Field"/> and <see cref="Position"/> rather than
/// parsing prose.
/// </para>
/// <para>
/// <b>The offending entry is described, never repeated.</b> This message reaches standard error
/// and from there CI logs (§V, ADR 0005).
/// </para>
/// </remarks>
public sealed class ContradictoryArtifactException : JsonException
{
    /// <summary>Initializes a new instance.</summary>
    public ContradictoryArtifactException() { }

    /// <summary>Initializes a new instance with a message.</summary>
    /// <param name="message">
    /// The caller-facing explanation. Must not repeat any value read out of the artifact.
    /// </param>
    public ContradictoryArtifactException(string message)
        : base(message) { }

    /// <summary>Initializes a new instance with a message and an inner exception.</summary>
    /// <param name="message">
    /// The caller-facing explanation. Must not repeat any value read out of the artifact.
    /// </param>
    /// <param name="innerException">The underlying failure.</param>
    public ContradictoryArtifactException(string message, Exception innerException)
        : base(message, innerException) { }

    /// <summary>Gets the artifact field that contradicts itself — for example <c>runs</c>.</summary>
    public string? Field { get; init; }

    /// <summary>
    /// Gets the position of the offending entry — for example <c>scenario #2, run #1</c>.
    /// </summary>
    public string? Position { get; init; }
}
