using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Runners;

/// <summary>
/// The parts of conducting a run that every runner does the same way.
/// </summary>
/// <remarks>
/// Internal, and kept small on purpose. Anything that grows here is a candidate for being a
/// difference between transports, which is the one thing a runner must not introduce.
/// </remarks>
internal static class RunnerSupport
{
    /// <summary>
    /// Refuses a scenario routed to the wrong runner.
    /// </summary>
    /// <remarks>
    /// Mis-routing is a harness fault, not a finding about the system under test. Running the
    /// scenario anyway would produce a transcript that grades exactly like a real one, which is
    /// the shape of a false green rather than of a failure someone notices.
    /// </remarks>
    /// <param name="scenario">The scenario handed to the runner.</param>
    /// <param name="expected">The kind the runner conducts.</param>
    /// <param name="token">How that kind is written in a suite file.</param>
    /// <exception cref="ArgumentException">The scenario declares another kind.</exception>
    public static void RequireKind(Scenario scenario, ScenarioKind expected, string token)
    {
        if (scenario.Identity.Kind == expected)
        {
            return;
        }

        throw new ArgumentException(
            $"Scenario '{scenario.Identity.Id}' declares kind '{scenario.Identity.Kind}', and this runner "
                + $"conducts '{token}' runs. A scenario routed to the wrong runner is a harness fault rather "
                + "than a finding about the system under test, and the transcript it produced would be graded "
                + "as though the right transport had been used — so it is refused rather than run.",
            nameof(scenario)
        );
    }

    /// <summary>
    /// Merges what an adapter reported <b>beneath</b> the runner's own record of what happened.
    /// </summary>
    /// <remarks>
    /// An adapter may add to the record of what happened on the wire; it may not rewrite it. The
    /// reserved keys in <see cref="TransportAttributes"/> are written last for that reason — a
    /// downstream stage deciding whether a run is gradeable must be reading the runner's account,
    /// not an adapter's account of itself.
    /// </remarks>
    /// <param name="fromAdapter">Attributes the adapter supplied.</param>
    /// <param name="observed">Attributes the runner observed on the wire.</param>
    /// <param name="exchange">The <see cref="ExchangeState"/> the run reached.</param>
    /// <param name="stoppedBy">The <see cref="StopReason"/> that ended the turn loop.</param>
    /// <param name="failure">Why the exchange did not complete normally, or null when it did.</param>
    /// <returns>The transport attributes for the transcript.</returns>
    public static IReadOnlyDictionary<string, string> Attributes(
        IReadOnlyDictionary<string, string> fromAdapter,
        IReadOnlyDictionary<string, string> observed,
        string exchange,
        string stoppedBy,
        string? failure
    )
    {
        var merged = new Dictionary<string, string>(fromAdapter, StringComparer.Ordinal);

        foreach (var attribute in observed)
        {
            merged[attribute.Key] = attribute.Value;
        }

        merged[TransportAttributes.Exchange] = exchange;
        merged[TransportAttributes.StoppedBy] = stoppedBy;

        if (string.IsNullOrWhiteSpace(failure))
        {
            merged.Remove(TransportAttributes.Failure);
        }
        else
        {
            merged[TransportAttributes.Failure] = failure;
        }

        return merged;
    }
}
