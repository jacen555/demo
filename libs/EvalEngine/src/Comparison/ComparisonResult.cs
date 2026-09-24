using Forge.EvalEngine.Results;
using Forge.EvalEngine.Serialization;

namespace Forge.EvalEngine.Comparison;

/// <summary>
/// What one artifact says about one scenario.
/// </summary>
/// <remarks>
/// <see cref="Absent"/> is first, and therefore the default, for the same reason
/// <see cref="SignificanceVerdict.NotComputed"/> is: a default-constructed value must never read
/// as a pass.
/// </remarks>
public enum ScenarioOutcome
{
    /// <summary>The artifact does not carry this scenario at all.</summary>
    Absent,

    /// <summary>
    /// The scenario is present but no run produced a verdict, so the artifact says nothing about
    /// whether the system did the right thing.
    /// </summary>
    Ungradeable,

    /// <summary>At least one graded run did not pass.</summary>
    Failed,

    /// <summary>Every graded run passed.</summary>
    Passed,
}

/// <summary>
/// How a scenario changed between a baseline artifact and a candidate artifact.
/// </summary>
/// <remarks>
/// <see cref="NotComparable"/> is first, and therefore the default, so that a value nobody set
/// cannot be mistaken for a verdict — the same reasoning as
/// <see cref="SignificanceVerdict.NotComputed"/>.
/// </remarks>
public enum ScenarioClassification
{
    /// <summary>
    /// Both artifacts carry this scenario, but not in a form that can honestly be diffed.
    /// <see cref="ScenarioComparison.NotComparableReason"/> says why.
    /// </summary>
    NotComparable,

    /// <summary>Passed under both variants.</summary>
    StablePass,

    /// <summary>Did not pass under either variant.</summary>
    StableFail,

    /// <summary>Did not pass under the baseline and passes under the candidate.</summary>
    Fixed,

    /// <summary>Passed under the baseline and does not pass under the candidate.</summary>
    Regressed,

    /// <summary>Present only in the candidate.</summary>
    New,

    /// <summary>Present only in the baseline.</summary>
    Removed,
}

/// <summary>
/// How one scenario compares between two artifacts.
/// </summary>
public sealed record ScenarioComparison
{
    /// <summary>Gets the scenario's identifier — the join key the two artifacts were paired on.</summary>
    public required string ScenarioId { get; init; }

    /// <summary>Gets how the scenario changed.</summary>
    public required ScenarioClassification Classification { get; init; }

    /// <summary>Gets what the baseline artifact said about the scenario.</summary>
    public required ScenarioOutcome BaselineOutcome { get; init; }

    /// <summary>Gets what the candidate artifact said about the scenario.</summary>
    public required ScenarioOutcome CandidateOutcome { get; init; }

    /// <summary>
    /// Gets the number of repetition pairs in which <b>both</b> variants produced a verdict.
    /// </summary>
    /// <remarks>
    /// A repetition whose baseline run or candidate run errored produced no verdict about the
    /// change, so it is excluded from the evidence exactly as
    /// <see cref="Statistics.ScenarioAggregator"/> excludes an errored run from a pass rate. The
    /// consequence stays visible rather than hidden: this figure falls, and the p-value is drawn
    /// from fewer pairs.
    /// </remarks>
    public int GradedPairs { get; init; }

    /// <summary>
    /// Gets the per-scenario delta, or <see langword="null"/> when the scenario could not be
    /// compared.
    /// </summary>
    /// <remarks>
    /// <see cref="ComparisonSummary.EffectSize"/> is always the raw difference in pass rate.
    /// <see cref="ComparisonSummary.PValue"/> and <see cref="ComparisonSummary.AdjustedPValue"/>
    /// are populated only where a test was actually run — see <see cref="SuiteComparator"/> for
    /// when that is not possible.
    /// </remarks>
    public ComparisonSummary? Comparison { get; init; }

    /// <summary>
    /// Gets why the scenario could not be compared, or <see langword="null"/> when it could.
    /// </summary>
    /// <remarks>
    /// Always text this library composed, naming the scenario and the property that diverged.
    /// </remarks>
    public string? NotComparableReason { get; init; }
}

/// <summary>
/// The diff between a baseline artifact and a candidate artifact — the answer to "should this
/// merge?".
/// </summary>
/// <remarks>
/// <para>
/// <b><see cref="NewlyCovered"/> is the headline, not a byproduct.</b> A harness that reports only
/// what broke is a worse version of a test suite; the value of running a suite against two
/// variants is being able to show what a change <i>fixed</i>.
/// </para>
/// <para>
/// This is a computed view rather than a committed artifact, so it carries no schema version.
/// Equality is nonetheless by <b>canonical value</b>: this record holds collections, and the
/// compiler-generated equality a record would otherwise use compares those by reference, so two
/// comparisons built from identical data would compare unequal.
/// </para>
/// </remarks>
public sealed record ComparisonResult
{
    /// <summary>Gets the name both artifacts declared.</summary>
    public required string SuiteName { get; init; }

    /// <summary>
    /// Gets one entry per scenario: the candidate's scenarios in candidate order, then the
    /// scenarios present only in the baseline, in baseline order.
    /// </summary>
    public IReadOnlyList<ScenarioComparison> ScenarioComparisons { get; init; } = [];

    /// <summary>
    /// Gets the identifiers of the scenarios this change covered that the baseline did not:
    /// <see cref="ScenarioClassification.Fixed"/> plus
    /// <see cref="ScenarioClassification.New"/> scenarios that pass.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A new scenario that fails is excluded, as is one whose every repetition errored and which
    /// therefore produced no gradeable evidence at all. Neither is coverage the change gained.
    /// </para>
    /// <para>
    /// So is a scenario whose candidate errored on <i>some</i> of its repetitions, whether it
    /// arrived here as <see cref="ScenarioClassification.Fixed"/> or as
    /// <see cref="ScenarioClassification.New"/>. An outcome is conditional on the runs that
    /// produced a verdict, so <see cref="ScenarioOutcome.Passed"/> beside an errored repetition
    /// says the scenario passed everything gradeable rather than everything the suite asked for
    /// — and the difference between those two is exactly the evidence that was never gathered.
    /// Those scenarios are named in <see cref="NewlyCoveredWithheld"/> rather than dropped, and
    /// they keep the classification their runs earned.
    /// </para>
    /// </remarks>
    public IReadOnlyList<string> NewlyCovered { get; init; } = [];

    /// <summary>
    /// Gets the identifiers of the scenarios that classified as newly covered but whose coverage
    /// is not claimed, because the candidate did not conduct every repetition it asked for.
    /// </summary>
    /// <remarks>
    /// Named rather than silently omitted: a shorter <see cref="NewlyCovered"/> and a withheld
    /// scenario read identically to a consumer, and a refusal that renders as an absence cannot
    /// be told apart from nothing having happened. <see cref="NewlyCoveredWithheldReason"/> says
    /// why, and the comparator logs each one at warning.
    /// </remarks>
    public IReadOnlyList<string> NewlyCoveredWithheld { get; init; } = [];

    /// <summary>
    /// Gets why those scenarios were withheld from <see cref="NewlyCovered"/>, or
    /// <see langword="null"/> when none were.
    /// </summary>
    /// <remarks>Always text this library composed; it names no scenario (§V).</remarks>
    public string? NewlyCoveredWithheldReason { get; init; }

    /// <summary>
    /// Gets the suite-wide delta from the injected <see cref="Abstractions.ISignificanceTest"/>,
    /// or <see langword="null"/> when no test was supplied or no scenario was comparable.
    /// </summary>
    /// <remarks>
    /// This is one test over the whole suite, so it carries no
    /// <see cref="ComparisonSummary.AdjustedPValue"/>: there is no family to correct it against.
    /// The correction applies to the per-scenario p-values on
    /// <see cref="ScenarioComparisons"/>.
    /// </remarks>
    public ComparisonSummary? Suite { get; init; }

    /// <summary>
    /// Gets the name of the multiple-comparison correction applied to the per-scenario p-values,
    /// or <see langword="null"/> when none was.
    /// </summary>
    public string? Correction { get; init; }

    /// <summary>Determines whether another comparison has the same canonical value.</summary>
    /// <param name="other">The comparison to compare against, or null.</param>
    /// <returns><see langword="true"/> when both serialize to identical canonical JSON.</returns>
    public bool Equals(ComparisonResult? other) => CanonicalJson.AreEquivalent(this, other);

    /// <summary>Returns a hash consistent with canonical-value equality.</summary>
    /// <returns>The hash of this comparison's canonical JSON.</returns>
    public override int GetHashCode() => StringComparer.Ordinal.GetHashCode(CanonicalJson.Serialize(this));
}
