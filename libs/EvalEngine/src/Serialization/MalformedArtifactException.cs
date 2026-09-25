using System.Text.Json;

namespace Forge.EvalEngine.Serialization;

/// <summary>
/// Thrown when a durable artifact carries a null in a position its own shape declares as never
/// holding one — a null element in a list, or a null value in a dictionary.
/// </summary>
/// <remarks>
/// <para>
/// <b>This is a malformed artifact, not a defect in the reader.</b> The serializer's
/// <c>RespectNullableAnnotations</c> setting is enforced for properties and constructor
/// parameters only; it says nothing about the element type of a collection or the value type of a
/// dictionary. So <c>"scenarioResults": [null]</c> binds a null into a list whose element type
/// says it cannot hold one, and without this the failure surfaces much later as a dereference —
/// a <see cref="NullReferenceException"/> that a consumer classifies as a crash rather than as an
/// unreadable file, and reports with a stack trace naming the machine it ran on.
/// </para>
/// <para>
/// <b>It derives from <see cref="JsonException"/> deliberately.</b> An artifact carrying a null
/// where its shape forbids one is content this engine cannot read, which is a category every
/// existing reader already handles and classifies as a refusal with an exit code. A consumer
/// needs no change to keep classifying it correctly, and one that wants the detail can read
/// <see cref="Field"/> and <see cref="Position"/> rather than parse prose.
/// </para>
/// <para>
/// <b>The offending entry is described, never repeated.</b> This message reaches standard error
/// and from there CI logs, which on many setups are readable by anyone who can read the
/// repository. A dictionary key is author-supplied and may itself be the machine path that
/// <see cref="UnsafeIdentifierException"/> exists to refuse, so it is named by its
/// <see cref="Field"/> and the <see cref="Position"/> of the entry that owns it — never quoted
/// back (§V, ADR 0005).
/// </para>
/// </remarks>
public sealed class MalformedArtifactException : JsonException
{
    /// <summary>Initializes a new instance.</summary>
    public MalformedArtifactException() { }

    /// <summary>Initializes a new instance with a message.</summary>
    /// <param name="message">
    /// The caller-facing explanation. Must not repeat any value read out of the artifact.
    /// </param>
    public MalformedArtifactException(string message)
        : base(message) { }

    /// <summary>Initializes a new instance with a message and an inner exception.</summary>
    /// <param name="message">
    /// The caller-facing explanation. Must not repeat any value read out of the artifact.
    /// </param>
    /// <param name="innerException">The underlying failure.</param>
    public MalformedArtifactException(string message, Exception innerException)
        : base(message, innerException) { }

    /// <summary>
    /// Gets the artifact field the null was found in — for example <c>scenarioResults</c>, or
    /// <c>transcript.transport.attributes</c> for one nested inside a scenario's runs.
    /// </summary>
    public string? Field { get; init; }

    /// <summary>
    /// Gets the position of the offending entry within the artifact — for example
    /// <c>scenario #2, run #1</c> — or null for an artifact-level field.
    /// </summary>
    /// <remarks>
    /// A position rather than the entry or its key, because those are the things that may not be
    /// repeated. For a dictionary this names the scenario and run that own it rather than an
    /// ordinal within it: a dictionary has no stable order, so an ordinal would send a reader to
    /// the wrong entry.
    /// </remarks>
    public string? Position { get; init; }
}
