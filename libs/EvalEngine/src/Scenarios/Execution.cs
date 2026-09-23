using System.Text.Json.Serialization;
using Forge.EvalEngine.Serialization;

namespace Forge.EvalEngine.Scenarios;

/// <summary>
/// How stimuli are produced for a scenario. Maps one-to-one onto
/// <see cref="Transcripts.TurnProvenance"/>, which records what actually happened.
/// </summary>
public enum ExecutionMode
{
    /// <summary>
    /// Stimuli are replayed verbatim from <see cref="Simulation.ScriptedStimuli"/>, after the
    /// <see cref="Simulation.Opening"/>. Fully reproducible, and the only mode in which the
    /// script-overrun guard applies.
    /// </summary>
    /// <remarks>
    /// A deterministic participant signals completion once its script is exhausted. That is what
    /// lets <see cref="TerminalCondition.StopOnParticipantCompletion"/> bound a run to
    /// <see cref="Simulation.ScriptedTurnBudget"/>, and the guard relies on it.
    /// </remarks>
    Deterministic,

    /// <summary>Stimuli are synthesized by a model from <see cref="Simulation"/> material.</summary>
    Simulated,

    /// <summary>Stimuli come from a real external caller, or a recording of one.</summary>
    Live,
}

/// <summary>
/// How many times a scenario runs before its results are aggregated.
/// </summary>
/// <remarks>
/// Running once is modelled as the degenerate case of repeating — a single repetition — so that a
/// REST scenario and a repeated LLM scenario travel the same aggregation path. There is no
/// separate "run once" concept for downstream stages to special-case.
/// </remarks>
[JsonConverter(typeof(RepetitionPolicyJsonConverter))]
public sealed record RepetitionPolicy
{
    private RepetitionPolicy(int repetitions) => Repetitions = repetitions;

    /// <summary>Gets the number of times the scenario runs. Always one or greater.</summary>
    public int Repetitions { get; }

    /// <summary>Gets a value indicating whether this policy runs the scenario exactly once.</summary>
    public bool IsOnce => Repetitions == 1;

    /// <summary>Gets the policy that runs a scenario exactly once.</summary>
    public static RepetitionPolicy Once { get; } = new(1);

    /// <summary>Creates a policy that runs a scenario the given number of times.</summary>
    /// <param name="repetitions">The repetition count. Must be one or greater.</param>
    /// <returns>The repetition policy.</returns>
    /// <exception cref="ArgumentOutOfRangeException">
    /// <paramref name="repetitions"/> is less than one.
    /// </exception>
    public static RepetitionPolicy Repeat(int repetitions)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(repetitions, 1);

        return repetitions == 1 ? Once : new RepetitionPolicy(repetitions);
    }
}

/// <summary>
/// What ends a scenario's turn loop.
/// </summary>
/// <remarks>
/// A conversation loop is an <i>emergent composition</i> of a multi-turn participant and a
/// terminal condition — never a core concept. A REST scenario needs no special handling here: its
/// participant signals completion after emitting the opening, so the loop ends after one turn
/// under the default condition.
/// </remarks>
public sealed record TerminalCondition
{
    private readonly int? _maxTurns;

    /// <summary>
    /// Gets the hard ceiling on turns, or <see langword="null"/> for no ceiling.
    /// </summary>
    /// <exception cref="ArgumentOutOfRangeException">The value is zero or negative.</exception>
    public int? MaxTurns
    {
        get => _maxTurns;
        init
        {
            if (value is <= 0)
            {
                throw new ArgumentOutOfRangeException(
                    nameof(value),
                    value,
                    "maxTurns must be one or greater when specified."
                );
            }

            _maxTurns = value;
        }
    }

    /// <summary>
    /// Gets a value indicating whether the loop ends when the participant signals completion.
    /// This is what lets a one-turn REST scenario and an N-turn exchange share one pipeline.
    /// </summary>
    public bool StopOnParticipantCompletion { get; init; } = true;

    /// <summary>
    /// Gets a value indicating whether the loop ends as soon as the system under test returns a
    /// terminal <see cref="Transcripts.Outcome"/>.
    /// </summary>
    public bool StopOnTerminalOutcome { get; init; } = true;
}

/// <summary>
/// How the runner drives a scenario. Owned by the runner; no other stage reads it.
/// </summary>
public sealed record Execution
{
    /// <summary>Gets how stimuli are produced.</summary>
    public required ExecutionMode Mode { get; init; }

    /// <summary>Gets how many times the scenario runs before aggregation.</summary>
    public RepetitionPolicy RepetitionPolicy { get; init; } = RepetitionPolicy.Once;

    /// <summary>Gets what ends the turn loop.</summary>
    public TerminalCondition TerminalCondition { get; init; } = new();
}
