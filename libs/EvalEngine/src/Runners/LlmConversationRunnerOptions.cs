namespace Forge.EvalEngine.Runners;

/// <summary>
/// What a <see cref="LlmConversationRunner"/> may write into a transcript, and the ceiling it
/// imposes on every conversation it drives.
/// </summary>
/// <remarks>
/// A transcript is a committed artifact — written to disk, diffed, attached to pull requests — so
/// the evidence default here is the conservative one, matching
/// <see cref="RestRunnerOptions.RetainUnredactedEvidence"/> (§V).
/// </remarks>
public sealed record LlmConversationRunnerOptions
{
    /// <summary>
    /// The ceiling applied when a caller states none. Twelve turns is long enough for a realistic
    /// multi-turn exchange and short enough that a runaway conversation against a metered provider
    /// is bounded by a number somebody chose.
    /// </summary>
    public const int DefaultMaxTurnCeiling = 12;

    private readonly int _maxTurnCeiling = DefaultMaxTurnCeiling;

    /// <summary>Gets the conservative defaults every constructor overload uses.</summary>
    public static LlmConversationRunnerOptions Default { get; } = new();

    /// <summary>
    /// Gets the hard ceiling on turns for every conversation this runner drives. Defaults to
    /// <see cref="DefaultMaxTurnCeiling"/>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>The cap belongs to the harness, not to the participant and not to the suite author.</b>
    /// The component best placed to judge when a conversation has finished is the simulated caller
    /// — and its faithfulness is the very thing under question, so handing it termination would
    /// let the least trustworthy component in the loop decide how much evidence gets gathered. It
    /// is not an adversarial concern: a persona simulator that politely wraps up at turn three,
    /// or that never stops at all, produces a run bounded by the model's mood.
    /// </para>
    /// <para>
    /// So this value wins. <see cref="Scenarios.TerminalCondition.MaxTurns"/> may only
    /// <i>narrow</i> it: the effective cap is the lower of the two, and a scenario declaring a
    /// ceiling above this one gets this one. A scenario declaring none gets this one too, which is
    /// what closes the gap behind the loader's <c>scenario.terminalCondition.unbounded</c> warning
    /// — a warning cannot stop a suite that ships with it unresolved from running indefinitely
    /// against a metered provider, and this can.
    /// </para>
    /// </remarks>
    /// <exception cref="ArgumentOutOfRangeException">The value is less than one.</exception>
    public int MaxTurnCeiling
    {
        get => _maxTurnCeiling;
        init
        {
            ArgumentOutOfRangeException.ThrowIfLessThan(value, 1);

            _maxTurnCeiling = value;
        }
    }

    /// <summary>
    /// Gets a value indicating whether raw, unredacted evidence is persisted. Off by default.
    /// </summary>
    /// <remarks>
    /// When off, the message of an exception the runner caught is not written into
    /// <see cref="Transcripts.TransportAttributes.Failure"/>. A message is authored by whatever
    /// threw it — an SDK, a driver, the framework — and routinely names the endpoint, the model
    /// deployment, or the connection string it failed on. A failing provider call is also the
    /// likeliest place for an API key to appear in a message, which is precisely why this is off
    /// by default for a conversational runner (§V).
    /// </remarks>
    public bool RetainUnredactedEvidence { get; init; }
}
