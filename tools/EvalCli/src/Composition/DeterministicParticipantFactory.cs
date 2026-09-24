using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Participants;
using Forge.EvalEngine.Scenarios;

namespace Forge.EvalCli.Composition;

/// <summary>
/// Builds a fresh scripted participant for every single run.
/// </summary>
/// <remarks>
/// <para>
/// <b>A new instance per call is the contract, not an optimization to avoid.</b> A participant is
/// stateful — it holds a cursor into the scenario's script — and the repetition loop exists to
/// observe variance between otherwise identical runs. The coordinator tracks which instances it
/// has already handed out by reference and refuses one it has seen before, so registering a single
/// shared participant would fail at runtime on the second repetition rather than quietly producing
/// an aggregate that described nothing. The factory itself is stateless and safe to share.
/// </para>
/// <para>
/// Which caller a scenario deserves is a composition-root decision the engine deliberately does
/// not make. This build always returns the deterministic one: it needs no provider, no key, and
/// no network, so a suite is reproducible from its definition alone. A model-driven caller would
/// be selected here too, once something owns its credentials properly.
/// </para>
/// </remarks>
internal sealed class DeterministicParticipantFactory : IParticipantFactory
{
    /// <summary>Gets the name shown in a dry run, so a reader can see which factory is wired.</summary>
    public static string DisplayName => nameof(DeterministicParticipantFactory);

    /// <inheritdoc/>
    /// <exception cref="ArgumentNullException"><paramref name="scenario"/> is null.</exception>
    public IParticipant Create(Scenario scenario, long seed, int repetition)
    {
        ArgumentNullException.ThrowIfNull(scenario);

        // The mode comes from the scenario rather than from configuration: a deterministic
        // scenario is approved by the suite loader as bounded by its script, and a caller built
        // for another mode would make that approval false.
        return new DeterministicCaller(scenario.Simulation, scenario.Execution.Mode);
    }
}
