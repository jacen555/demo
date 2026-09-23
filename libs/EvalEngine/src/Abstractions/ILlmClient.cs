namespace Forge.EvalEngine.Abstractions;

/// <summary>
/// One request to a language model.
/// </summary>
public sealed record LlmRequest
{
    private readonly string _prompt = string.Empty;

    /// <summary>Gets the instruction sent to the model.</summary>
    /// <remarks>
    /// Blank is refused rather than stored. An implementation that replays by request content
    /// keys on this value, so a blank prompt would collapse every unprompted request onto one
    /// key — and a request carrying no instruction cannot produce a stimulus worth recording.
    /// </remarks>
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
    /// Gets the seed to drive the model with, or <see langword="null"/> to send none.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>A seed is a best-effort hint, never a reproducibility guarantee, and nothing in this
    /// library may treat it as one.</b> Bitwise determinism is unattainable on GPU inference even
    /// at temperature zero — batching, kernel selection, and floating-point reassociation all move
    /// under the provider's feet — and providers document their own seed support as best effort.
    /// A harness that made a seed a correctness precondition would therefore be asserting a
    /// property no provider offers, and would report the provider's ordinary drift as a regression
    /// in the system under test.
    /// </para>
    /// <para>
    /// Reproducibility in this library comes from somewhere else entirely: an
    /// <see cref="ILlmClient"/> that replays recorded completions by request content. That is a
    /// property of the <i>seam</i>, not of the provider, which is why it survives a provider
    /// dropping the parameter.
    /// </para>
    /// </remarks>
    public long? Seed { get; init; }

    /// <summary>
    /// Gets the sampling temperature, or <see langword="null"/> to send none.
    /// </summary>
    /// <remarks>
    /// <b>Optional capability, not configuration.</b> Providers are actively withdrawing
    /// <c>temperature</c> and <c>top_p</c> on their newer models, so an implementation must work
    /// when it is absent and must not fail a request that omits it. It is exposed so a caller who
    /// has a provider that honours it can pass it through — not so anything here can depend on it.
    /// No sibling sampling parameter is exposed: adding one would grow a surface in the direction
    /// the providers are retreating from.
    /// </remarks>
    public double? Temperature { get; init; }
}

/// <summary>
/// The engine's only route to a language model.
/// </summary>
/// <remarks>
/// <para>
/// Kept behind one narrow seam so that a synthesizing participant can be tested without a
/// provider, and so no other part of the engine acquires a dependency on one.
/// </para>
/// <para>
/// <b>The narrowness is a security control, not only a design preference (§V).</b> The contract
/// returns the completion text and nothing else, so a provider's response envelope — request and
/// organisation identifiers, token accounting, log probabilities, echoed request headers — has no
/// route into a <see cref="Transcripts.Transcript"/>, which is a committed artifact. An
/// implementation must not smuggle one through by packing it into the returned string.
/// </para>
/// <para>
/// What comes back is <b>untrusted</b>, exactly like <see cref="LlmRequest.Context"/>: it is model
/// output shaped by content the system under test authored. A caller must treat it as data to be
/// validated and bounded before it is sent anywhere or written to disk.
/// </para>
/// </remarks>
public interface ILlmClient
{
    /// <summary>Sends one request to the model.</summary>
    /// <param name="request">The request.</param>
    /// <param name="cancellationToken">Cancels the call.</param>
    /// <returns>The model's completion, carrying no provider envelope.</returns>
    Task<string> CompleteAsync(LlmRequest request, CancellationToken cancellationToken);
}
