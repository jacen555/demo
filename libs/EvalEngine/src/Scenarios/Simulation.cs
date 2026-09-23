using System.Text.Json.Serialization;
using Forge.EvalEngine.Serialization;

namespace Forge.EvalEngine.Scenarios;

/// <summary>
/// One stimulus the deterministic participant replays, optionally tagged with the field it was
/// written to exercise.
/// </summary>
/// <remarks>
/// <para>
/// In a suite file an entry may be a bare string or an object. Both forms round-trip:
/// <c>"yes, please"</c> and <c>{ "text": "yes, please", "field": "scope/confirm" }</c>.
/// </para>
/// <para>
/// The legacy names <c>answer</c> and <c>slot</c> are still accepted <i>on input</i>, because the
/// harness this design generalizes wrote them. They are mapped at the loading boundary and never
/// written back.
/// </para>
/// </remarks>
[JsonConverter(typeof(ScriptedStimulusJsonConverter))]
public sealed record ScriptedStimulus
{
    private readonly string _text = string.Empty;

    /// <summary>Gets the literal text replayed as the stimulus for one turn.</summary>
    /// <remarks>
    /// Blank text is refused rather than stored. A stimulus that carries nothing cannot drive a
    /// turn — <see cref="Abstractions.ParticipantTurn.Next"/> would refuse to send it — yet it
    /// would still be counted into <see cref="Simulation.ScriptedTurnBudget"/>, which is the
    /// number the script-overrun guard trusts when it decides an assertion is in scope.
    /// </remarks>
    /// <exception cref="ArgumentException">The value is null, empty, or whitespace.</exception>
    public required string Text
    {
        get => _text;
        init
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(value, nameof(value));

            _text = value;
        }
    }

    /// <summary>
    /// Gets the field this stimulus was written to exercise, or <see langword="null"/> when it was
    /// written positionally. Recorded so a reviewer can tell whether a line still targets what it
    /// was authored against; the vocabulary matches the keys of
    /// <see cref="Transcripts.Outcome.Fields"/>.
    /// </summary>
    public string? Field { get; init; }
}

/// <summary>
/// The material the simulated caller draws on. Owned by the participant; no other stage reads it.
/// </summary>
/// <remarks>
/// A REST scenario flows through this record too — it is simply one with an <see cref="Opening"/>
/// and nothing else. That is why the vocabulary here is <c>stimulus</c> rather than <c>answer</c>:
/// an HTTP request is not an answer to anything, and the moment one domain's words enter a type
/// that every kind travels through, the "generic" engine has quietly encoded that domain's
/// assumptions.
/// </remarks>
[JsonConverter(typeof(SimulationJsonConverter))]
public sealed record Simulation
{
    /// <summary>Gets the first stimulus sent to the system under test. This is turn one.</summary>
    public string? Opening { get; init; }

    /// <summary>Gets background facts a synthesizing participant may draw on.</summary>
    public IReadOnlyList<string> Facts { get; init; } = [];

    /// <summary>Gets candidate stimuli a synthesizing participant may choose between.</summary>
    public IReadOnlyList<string> StimulusPool { get; init; } = [];

    /// <summary>
    /// Gets the exact stimuli the deterministic participant replays after the opening, in order.
    /// </summary>
    public IReadOnlyList<ScriptedStimulus> ScriptedStimuli { get; init; } = [];

    /// <summary>
    /// Gets the number of turns the script drives, which is the set of scripted turn indices
    /// <c>1..ScriptedTurnBudget</c> in the resulting <see cref="Transcripts.Transcript"/>.
    /// </summary>
    /// <remarks>
    /// <b>The opening is turn one.</b> It is the first stimulus sent, so it occupies the first
    /// index of the transcript exactly as a scripted line does, and the budget counts it. A
    /// one-turn REST scenario therefore has a budget of one rather than zero. Under
    /// <see cref="ExecutionMode.Deterministic"/>, turns past this budget are not script-driven,
    /// which is what the script-overrun guard in the suite loader exists to catch.
    /// <para>
    /// Only material that can actually drive a turn is counted. The guard reads this number to
    /// decide whether an assertion lands on scripted material, so counting an entry the
    /// participant could never send would widen the budget and approve an assertion the script
    /// cannot reach.
    /// </para>
    /// </remarks>
    [JsonIgnore]
    public int ScriptedTurnBudget =>
        (string.IsNullOrWhiteSpace(Opening) ? 0 : 1)
        + ScriptedStimuli.Count(stimulus => !string.IsNullOrWhiteSpace(stimulus?.Text));
}
