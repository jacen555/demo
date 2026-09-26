using Forge.EvalEngine.Scenarios;

namespace Forge.EvalEngine.Abstractions;

/// <summary>
/// Builds the participant for <b>one</b> run of one scenario.
/// </summary>
/// <remarks>
/// <para>
/// <b>This is a factory rather than an instance because a run must not inherit another run's
/// state.</b> A participant may legitimately be stateful — a replaying client holding a cursor
/// into a recording, a caller that remembers what it has already said — and the repetition loop
/// exists precisely to observe the variance between otherwise identical runs. Sharing one
/// instance across repetitions would make repetition two a continuation of repetition one rather
/// than an independent sample of the same scenario, and the aggregate computed over them would
/// describe neither.
/// </para>
/// <para>
/// The same argument applies across scenarios and, more sharply, under concurrency: a single
/// participant driven by several runs at once has no defined behaviour at all. So the
/// <see cref="Coordination.RunCoordinator"/> calls this once per run and never caches the result.
/// </para>
/// <para>
/// The run's identity is passed in so an implementation can be deterministic: the same scenario,
/// seed, and repetition must be able to produce the same caller. An implementation that ignores
/// the seed is free to — a fully scripted caller has nothing to vary — but one that draws on
/// randomness must take it from there rather than from ambient state, or the run stops being
/// reproducible.
/// </para>
/// </remarks>
public interface IParticipantFactory
{
    /// <summary>
    /// Gets the settings in force on this factory, and on the callers it builds, that change what
    /// a run sends to the system under test.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Required rather than defaulted, for the reason
    /// <see cref="IScenarioRunner.VerdictBearingSettings"/> is.</b> A stimulus ceiling truncates
    /// before the text is sent, and a persona changes what the text says — two runs differing only
    /// in either ask the system a different question, and a comparison that did not know would
    /// report the difference as a system change. The coordinator holds this seam only as an
    /// interface, so a setting a factory does not declare is one two runs can silently disagree
    /// about. A default returning nothing would make that silence the behaviour every existing
    /// factory inherited without anyone choosing it.
    /// </para>
    /// <para>
    /// A factory with genuinely nothing that can vary — a fully scripted replayer — returns an
    /// empty map, explicitly. <see cref="Participants.LlmCallerOptions.VerdictBearingSettings"/>
    /// supplies the map for this library's own caller so a composition root does not re-derive the
    /// key names.
    /// </para>
    /// <para>
    /// The coordinator records these under <c>participants.&lt;key&gt;</c>. Values must be
    /// invariantly rendered and free of credentials and free text — they are written verbatim into
    /// a committed, published artifact (§V).
    /// </para>
    /// </remarks>
    IReadOnlyDictionary<string, string> VerdictBearingSettings { get; }

    /// <summary>Creates the participant for one run.</summary>
    /// <param name="scenario">The scenario about to be run.</param>
    /// <param name="seed">The seed this run is driven with, stamped into its transcript.</param>
    /// <param name="repetition">The one-based repetition number within the scenario.</param>
    /// <returns>
    /// A participant for this run alone. Returning a shared instance defeats the purpose of this
    /// seam; returning <see langword="null"/> is refused by the caller.
    /// </returns>
    IParticipant Create(Scenario scenario, long seed, int repetition);
}
