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
/// Why a scenario that classified as newly covered had its coverage claim withheld.
/// </summary>
/// <remarks>
/// <para>
/// These are <b>different faults with different remedies</b>, which is why they are a declared
/// value rather than three sentences a consumer has to tell apart by substring. A repetition that
/// errored is a flake to re-run; a repetition that never happened is a harness that lost work; an
/// artifact recording more runs than it declared is neither, and a reader sent after a missing
/// run would be looking for something that was never absent.
/// </para>
/// <para>
/// <see cref="Incomplete"/> is first, and therefore the default, on the same reasoning as
/// <see cref="ScenarioOutcome.Absent"/> and <see cref="ScenarioClassification.NotComparable"/>: a
/// value nobody set must not read as the cause that licenses the cheapest response. A default of
/// <see cref="Errored"/> would tell a reader to re-run a flake on the strength of a value no
/// comparison produced, whereas this one sends them to look at the harness and find nothing
/// wrong — noisy in the safe direction rather than quiet in the unsafe one.
/// </para>
/// </remarks>
public enum CoverageWithholdingCause
{
    /// <summary>
    /// The scenario recorded fewer repetitions than its own policy declared, so at least one run
    /// the suite asked for never happened.
    /// </summary>
    Incomplete,

    /// <summary>
    /// The scenario recorded more repetitions than its own policy declared, so its runs include
    /// at least one the suite never asked for.
    /// </summary>
    OverRecorded,

    /// <summary>
    /// Every repetition the policy declared was recorded, and at least one of them produced no
    /// verdict.
    /// </summary>
    Errored,
}

/// <summary>
/// One scenario's withheld coverage claim, and the cause that withheld it.
/// </summary>
/// <remarks>
/// The cause is attributed to the scenario it belongs to. A suite-level reason cannot do that:
/// when two causes occur in one comparison it carries both, and a reader cannot tell which
/// scenario had which — an attribution the comparator computed, logged, and then discarded on the
/// way out.
/// </remarks>
public sealed record WithheldCoverage
{
    /// <summary>Gets the scenario whose coverage claim was withheld.</summary>
    public required string ScenarioId { get; init; }

    /// <summary>Gets the cause, as a value a consumer can branch on.</summary>
    public required CoverageWithholdingCause Cause { get; init; }

    /// <summary>Gets the caller-facing explanation of <see cref="Cause"/>.</summary>
    /// <remarks>
    /// Derived rather than settable, so the prose and the value cannot disagree about one fact.
    /// Two independently settable fields describing the same thing drift silently — a reader
    /// believes the sentence and a program believes the value. Always text this library composed;
    /// it names no scenario (§V).
    /// </remarks>
    public string Reason => Describe(Cause);

    /// <summary>States why a cause withholds a coverage claim.</summary>
    /// <param name="cause">The cause to describe.</param>
    /// <returns>The caller-facing explanation, composed by this library.</returns>
    /// <remarks>
    /// This wording is rendered verbatim downstream rather than re-derived, so it is part of the
    /// contract and not an implementation detail.
    /// </remarks>
    /// <exception cref="ArgumentOutOfRangeException">
    /// <paramref name="cause"/> is not a declared <see cref="CoverageWithholdingCause"/>. A value
    /// outside the enum is not a cause, and a fallback sentence would be prose manufactured from
    /// a value this domain never defined — indistinguishable, in a rendered report, from a real
    /// one.
    /// </exception>
    public static string Describe(CoverageWithholdingCause cause) =>
        cause switch
        {
            CoverageWithholdingCause.Incomplete =>
                "the scenario recorded fewer repetitions than the count its own policy declared, so at least one "
                    + "run the suite asked for never happened. A run that never happened is not a run that failed, "
                    + "and coverage cannot be claimed from evidence that was never gathered.",

            // Stated separately from Incomplete rather than folded into one mismatch sentence.
            // Nothing is missing here — there are runs the policy never asked for — and a reader
            // told to look for an absent repetition would be looking for something that was
            // never absent.
            CoverageWithholdingCause.OverRecorded =>
                "the scenario recorded more repetitions than the count its own policy declared, so its runs include "
                    + "at least one the suite never asked for. Nothing here is missing; what is unknown is which "
                    + "runs the claim rests on, and an artifact whose run set contradicts its own policy cannot "
                    + "settle that.",

            CoverageWithholdingCause.Errored =>
                "at least one repetition errored, so the scenario passed every run that produced a verdict rather "
                    + "than every run the suite asked for. An outcome conditional on the gradeable runs cannot "
                    + "establish coverage the change earned, because the evidence for the repetitions that errored "
                    + "was never gathered.",

            _ => throw new ArgumentOutOfRangeException(
                nameof(cause),
                cause,
                $"'{cause}' is not a declared {nameof(CoverageWithholdingCause)}, so there is no reason to state "
                    + "for it."
            ),
        };
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
    /// Gets the scenarios that classified as newly covered but whose coverage is not claimed,
    /// because the candidate did not conduct every repetition it asked for — each paired with the
    /// cause that withheld it.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Named rather than silently omitted: a shorter <see cref="NewlyCovered"/> and a withheld
    /// scenario read identically to a consumer, and a refusal that renders as an absence cannot
    /// be told apart from nothing having happened. The comparator logs each one at warning.
    /// </para>
    /// <para>
    /// <b>The cause is attributed per scenario</b>, in the order the comparisons were made. The
    /// causes lead to different actions, so a comparison in which two of them occurred has to say
    /// which scenario had which — a single suite-level reason carrying both sentences cannot, and
    /// leaves a consumer to guess an attribution the comparator already computed.
    /// </para>
    /// </remarks>
    public IReadOnlyList<WithheldCoverage> NewlyCoveredWithheld { get; init; } = [];

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
