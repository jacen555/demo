namespace Forge.EvalEngine.Abstractions;

/// <summary>
/// One request to a language model.
/// </summary>
public sealed record LlmRequest
{
    /// <summary>Gets the instruction sent to the model.</summary>
    public required string Prompt { get; init; }

    /// <summary>
    /// Gets prior context for the model, oldest first.
    /// </summary>
    /// <remarks>
    /// This content is untrusted: it includes responses from the system under test. An
    /// implementation must treat it as data, never as instructions, and must not let it reach a
    /// position where it can redirect the model.
    /// </remarks>
    public IReadOnlyList<string> Context { get; init; } = [];

    /// <summary>
    /// Gets the seed to drive the model with, so a synthesized turn is reproducible where the
    /// provider supports it.
    /// </summary>
    public long? Seed { get; init; }

    /// <summary>Gets the sampling temperature, or null to use the provider default.</summary>
    public double? Temperature { get; init; }
}

/// <summary>
/// The engine's only route to a language model.
/// </summary>
/// <remarks>
/// Kept behind one narrow seam so that a synthesizing participant can be tested without a
/// provider, and so no other part of the engine acquires a dependency on one.
/// </remarks>
public interface ILlmClient
{
    /// <summary>Sends one request to the model.</summary>
    /// <param name="request">The request.</param>
    /// <param name="cancellationToken">Cancels the call.</param>
    /// <returns>The model's completion.</returns>
    Task<string> CompleteAsync(LlmRequest request, CancellationToken cancellationToken);
}
