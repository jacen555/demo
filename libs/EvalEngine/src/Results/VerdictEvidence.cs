using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Results;

/// <summary>
/// The one rule deciding whether a recorded verdict is backed by the evidence beside it.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="Coordination.RunCoordinator"/> never writes a graded verdict beside a transcript
/// whose exchange gathered nothing — such a run is recorded <see cref="RunStatus.Error"/> and its
/// assertions are never evaluated. Every other reader of a <see cref="SuiteResult"/> has to
/// establish that property rather than assume it, because an artifact read from a file was
/// written by something else (§V).
/// </para>
/// <para>
/// <b>One predicate, four callers.</b> The read door
/// (<see cref="Serialization.CanonicalJson.DeserializeSuiteResult(string)"/>),
/// <see cref="Comparison.SuiteComparator"/>, <see cref="Impact.ImpactSelector"/>, and
/// <see cref="Statistics.ScenarioAggregator"/> all ask this type rather than each re-deriving the
/// rule. Four copies of a rule that must agree and are never checked against each other is how
/// one of them quietly stops agreeing — the same reasoning that put the reserved transport keys
/// in one place.
/// </para>
/// </remarks>
internal static class VerdictEvidence
{
    /// <summary>
    /// The clause every refusal shares, so four messages cannot drift into four rules.
    /// </summary>
    public const string Why =
        "a verdict about a system that was never successfully asked is not a verdict, and a pass recorded that "
        + "way is indistinguishable from a run that never happened";

    /// <summary>
    /// Determines whether a run claims a verdict its own transcript cannot support.
    /// </summary>
    /// <param name="run">The run as the artifact records it.</param>
    /// <returns>
    /// <see langword="true"/> when the run carries a graded verdict beside an exchange that
    /// gathered no evidence about the system under test.
    /// </returns>
    /// <remarks>
    /// <b>Fails closed.</b> A run with no transcript at all, and a transcript recording no
    /// exchange state, both report as unbacked — reading "I do not know what happened" as
    /// "nothing went wrong" is the shape of every false green this library guards against, and
    /// <see cref="ExchangeState.IsHarnessFailure(string?)"/> already draws that line the same way.
    /// An errored run is exempt because a harness-failure exchange is precisely what it records.
    /// </remarks>
    public static bool IsUnbacked(RunResult run)
    {
        if (run is null || run.Status == RunStatus.Error)
        {
            return false;
        }

        return run.Transcript is null || ExchangeState.IsHarnessFailure(ExchangeState.Of(run.Transcript));
    }
}
