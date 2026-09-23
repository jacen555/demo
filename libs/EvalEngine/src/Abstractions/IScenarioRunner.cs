using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Abstractions;

/// <summary>
/// What a participant offers when asked for the next stimulus.
/// </summary>
/// <remarks>
/// Either the participant has a stimulus, or it is complete — never both, and never neither.
/// The constructor is private and the two factory methods are the only way to build one, so that
/// state is unrepresentable rather than merely discouraged.
/// </remarks>
public sealed record ParticipantTurn
{
    private ParticipantTurn(string? stimulus, bool isComplete, TurnProvenance? provenance)
    {
        Stimulus = stimulus;
        IsComplete = isComplete;
        Provenance = provenance;
    }

    /// <summary>
    /// Gets the next stimulus, or <see langword="null"/> when <see cref="IsComplete"/> is
    /// <see langword="true"/>.
    /// </summary>
    public string? Stimulus { get; }

    /// <summary>Gets a value indicating whether the participant has nothing further to send.</summary>
    public bool IsComplete { get; }

    /// <summary>
    /// Gets where the stimulus came from, or <see langword="null"/> when
    /// <see cref="IsComplete"/> is <see langword="true"/>.
    /// </summary>
    public TurnProvenance? Provenance { get; }

    /// <summary>Gets the signal that the participant has nothing further to send.</summary>
    public static ParticipantTurn Complete { get; } = new(null, true, null);

    /// <summary>Creates the next stimulus.</summary>
    /// <param name="stimulus">The text to send to the system under test.</param>
    /// <param name="provenance">Where that text came from.</param>
    /// <returns>The participant's next turn.</returns>
    /// <exception cref="ArgumentException"><paramref name="stimulus"/> is empty or whitespace.</exception>
    /// <exception cref="ArgumentNullException"><paramref name="stimulus"/> is null.</exception>
    public static ParticipantTurn Next(string stimulus, TurnProvenance provenance)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(stimulus);

        return new ParticipantTurn(stimulus, isComplete: false, provenance);
    }
}

/// <summary>
/// Supplies the next stimulus, given everything that has happened so far.
/// </summary>
/// <remarks>
/// <para>
/// This is the seam that lets a one-shot REST call and a multi-turn conversation share one
/// pipeline. A REST participant emits the scenario's opening and then returns
/// <see cref="ParticipantTurn.Complete"/>; a conversational participant keeps going until its
/// script runs out or the terminal condition is met. The runner does not know which it has.
/// </para>
/// <para>
/// A conversation loop is therefore an emergent composition of a multi-turn participant and a
/// terminal condition — it is not a concept the engine knows about.
/// </para>
/// </remarks>
public interface IParticipant
{
    /// <summary>Asks for the next stimulus.</summary>
    /// <param name="transcriptSoFar">Everything that has happened in this run so far.</param>
    /// <param name="cancellationToken">Cancels the request.</param>
    /// <returns>The next stimulus, or <see cref="ParticipantTurn.Complete"/>.</returns>
    ValueTask<ParticipantTurn> NextAsync(Transcript transcriptSoFar, CancellationToken cancellationToken);
}

/// <summary>
/// What a runner needs beyond the scenario itself.
/// </summary>
public sealed record RunContext
{
    /// <summary>Gets the participant supplying stimuli for this run.</summary>
    public required IParticipant Participant { get; init; }

    /// <summary>
    /// Gets the seed for this run. Stamped into the resulting transcript so the run is
    /// reproducible.
    /// </summary>
    public required long Seed { get; init; }

    /// <summary>Gets the one-based repetition number within the scenario.</summary>
    public required int Repetition { get; init; }
}

/// <summary>
/// Runs one scenario of one kind and produces a kind-agnostic transcript.
/// </summary>
/// <remarks>
/// This interface is the entire extent of kind-specific behaviour in the engine. Everything
/// downstream of it — assertions, aggregation, comparison, reporting — sees only
/// <see cref="Transcript"/> and <see cref="Outcome"/>, and cannot tell which runner produced
/// them. Adding a fourth kind must not require a change anywhere else.
/// </remarks>
public interface IScenarioRunner
{
    /// <summary>Gets the kind of scenario this runner handles.</summary>
    ScenarioKind Kind { get; }

    /// <summary>Runs the scenario once.</summary>
    /// <param name="scenario">The scenario to run.</param>
    /// <param name="context">The participant and seed for this run.</param>
    /// <param name="cancellationToken">Cancels the run.</param>
    /// <returns>What happened, in the shared kind-agnostic form.</returns>
    Task<Transcript> RunAsync(Scenario scenario, RunContext context, CancellationToken cancellationToken);
}
