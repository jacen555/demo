using System.Globalization;
using Forge.EvalCli.Cli;
using Forge.EvalEngine.Comparison;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Statistics;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalCli.Tests.Support;

/// <summary>
/// Builds the two artifacts and the comparison between them that a rendering test needs.
/// </summary>
/// <remarks>
/// <para>
/// <b>Constructed, not conducted — and that is a deliberate limitation of these fixtures.</b>
/// A renderer is a pure function of a <see cref="ComparisonResult"/> and the two artifacts it was
/// made from, and pinning it against hand-built inputs is what lets a test reach shapes the
/// current comparator does not emit but the contract permits — a scenario with no summary, a
/// pair with no recorded reason, an artifact that never recorded its confidence level.
/// </para>
/// <para>
/// It is also how a fixture and the code under test can quietly agree about a shape the engine
/// never produces. That is why the end-to-end tests in
/// <c>MarkdownReportCommandTests</c> conduct a real suite against a real endpoint and assert on
/// the file that invocation wrote: those pin the rendering against what the engine actually
/// emits, and these pin it against what its contract allows.
/// </para>
/// </remarks>
internal static class ReportFixture
{
    /// <summary>The confidence level these artifacts record, matching the engine's default.</summary>
    public const double ConfidenceLevel = ProportionInterval.DefaultConfidenceLevel;

    /// <summary>Builds one scenario's record, with the runs and the aggregate a real run would have produced.</summary>
    /// <param name="id">The scenario id.</param>
    /// <param name="passed">How many repetitions passed.</param>
    /// <param name="graded">How many repetitions produced a verdict.</param>
    /// <param name="interval">Whether to carry the interval, so a test can reach an artifact without one.</param>
    /// <param name="errored">How many repetitions errored, on top of the graded ones.</param>
    /// <returns>The scenario result.</returns>
    /// <remarks>
    /// The runs are real because the renderer checks a summary against them: an artifact carrying
    /// figures its own runs do not support is exactly the tampering the report refuses, and a
    /// fixture that skipped the runs would have every test exercising that refusal instead of the
    /// rendering.
    /// </remarks>
    public static ScenarioResult Scenario(string id, int passed, int graded, bool interval = true, int errored = 0) =>
        new()
        {
            ScenarioId = id,
            Kind = ScenarioKind.Rest,
            RepetitionPolicyUsed = RepetitionPolicy.Repeat(graded + errored),
            Runs = Runs(id, passed, graded, errored),
            Summary = new StatisticalSummary
            {
                N = graded,
                PointEstimate = (double)passed / graded,
                Dispersion = 0,
                Interval = interval ? ProportionInterval.Wilson(passed, graded, ConfidenceLevel) : null,
            },
        };

    /// <summary>Builds one scenario's record with no aggregate — every repetition errored.</summary>
    /// <param name="id">The scenario id.</param>
    /// <returns>The scenario result.</returns>
    public static ScenarioResult Ungradeable(string id) =>
        new()
        {
            ScenarioId = id,
            Kind = ScenarioKind.Rest,
            RepetitionPolicyUsed = RepetitionPolicy.Once,
            Runs = Runs(id, passed: 0, graded: 0, errored: 1),
            Summary = null,
        };

    /// <summary>Builds a scenario whose recorded summary contradicts its own runs.</summary>
    /// <param name="id">The scenario id.</param>
    /// <param name="claimed">The repetition count the summary asserts.</param>
    /// <returns>The scenario result.</returns>
    /// <remarks>
    /// The shape a committed baseline takes after somebody edits it: a narrow interval over a
    /// large claimed <c>n</c>, with a handful of runs actually recorded.
    /// </remarks>
    public static ScenarioResult Tampered(string id, int claimed = 100) =>
        new()
        {
            ScenarioId = id,
            Kind = ScenarioKind.Rest,
            RepetitionPolicyUsed = RepetitionPolicy.Repeat(5),
            Runs = Runs(id, passed: 5, graded: 5, errored: 0),
            Summary = new StatisticalSummary
            {
                N = claimed,
                PointEstimate = 1.0,
                Dispersion = 0,
                Interval = ProportionInterval.Wilson(claimed, claimed, ConfidenceLevel),
            },
        };

    /// <summary>
    /// Builds a scenario whose <c>n</c> and estimate agree with its runs but whose interval does not.
    /// </summary>
    /// <param name="id">The scenario id.</param>
    /// <returns>The scenario result.</returns>
    /// <remarks>
    /// The narrower tampering: every figure a check on <c>n</c> and the point estimate looks at is
    /// correct, and only the bounds rendered beside them were edited. A forged narrow interval is
    /// the most persuasive thing on the page.
    /// </remarks>
    public static ScenarioResult ForgedInterval(string id) =>
        new()
        {
            ScenarioId = id,
            Kind = ScenarioKind.Rest,
            RepetitionPolicyUsed = RepetitionPolicy.Repeat(5),
            Runs = Runs(id, passed: 5, graded: 5, errored: 0),
            Summary = new StatisticalSummary
            {
                N = 5,
                PointEstimate = 1.0,
                Dispersion = 0,
                Interval = new ConfidenceInterval
                {
                    Lower = 0.99,
                    Upper = 1.0,
                    Method = IntervalMethod.Wilson,
                },
            },
        };

    /// <summary>Builds a scenario whose interval was computed by a method the run did not record.</summary>
    /// <param name="id">The scenario id.</param>
    /// <returns>The scenario result.</returns>
    public static ScenarioResult ForeignIntervalMethod(string id) =>
        new()
        {
            ScenarioId = id,
            Kind = ScenarioKind.Rest,
            RepetitionPolicyUsed = RepetitionPolicy.Repeat(5),
            Runs = Runs(id, passed: 5, graded: 5, errored: 0),
            Summary = new StatisticalSummary
            {
                N = 5,
                PointEstimate = 1.0,
                Dispersion = 0,
                Interval = ProportionInterval.AgrestiCoull(5, 5, ConfidenceLevel),
            },
        };

    /// <summary>
    /// Builds a scenario where nothing was graded and a summary was recorded anyway.
    /// </summary>
    /// <param name="id">The scenario id.</param>
    /// <param name="interval">Whether to carry bounds, which a zero-trial computation cannot produce.</param>
    /// <returns>The scenario result.</returns>
    /// <remarks>
    /// <b>The aggregator never produces this and a hand-edited artifact does.</b> Every repetition
    /// errored, so nothing was learned — and the file claims an aggregate over runs it does not
    /// have. A reader that trusts the summary before checking the runs beneath it reports a pass
    /// rate of zero from a scenario nobody graded, which is the distinction "no gradeable run is
    /// not a pass rate of zero" exists to keep.
    /// </remarks>
    public static ScenarioResult SummarisedWithoutVerdicts(string id, bool interval = false) =>
        new()
        {
            ScenarioId = id,
            Kind = ScenarioKind.Rest,
            RepetitionPolicyUsed = RepetitionPolicy.Repeat(3),
            Runs = Runs(id, passed: 0, graded: 0, errored: 3),
            Summary = new StatisticalSummary
            {
                N = 0,
                PointEstimate = 0,
                Dispersion = 0,
                Interval = interval
                    ? new ConfidenceInterval
                    {
                        Lower = 0,
                        Upper = 0,
                        Method = IntervalMethod.Wilson,
                    }
                    : null,
            },
        };

    /// <summary>Builds a scenario whose summary carries no interval at all.</summary>
    /// <param name="id">The scenario id.</param>
    /// <returns>The scenario result.</returns>
    public static ScenarioResult WithoutInterval(string id) => Scenario(id, passed: 5, graded: 5, interval: false);

    private static List<RunResult> Runs(string id, int passed, int graded, int errored)
    {
        var runs = new List<RunResult>(graded + errored);

        for (var index = 0; index < graded + errored; index++)
        {
            var status =
                index >= graded ? RunStatus.Error
                : index < passed ? RunStatus.Pass
                : RunStatus.Fail;

            runs.Add(
                new RunResult
                {
                    Status = status,
                    ErrorDetail = status == RunStatus.Error ? "the transport went away" : null,
                    Transcript = new Transcript
                    {
                        ScenarioId = id,
                        Seed = index,
                        StartedAt = new DateTimeOffset(2026, 9, 24, 12, 0, 0, TimeSpan.Zero),
                    },
                }
            );
        }

        return runs;
    }

    /// <summary>Builds an artifact carrying the given scenarios.</summary>
    /// <param name="scenarios">The scenario records.</param>
    /// <returns>The artifact.</returns>
    public static SuiteResult Artifact(params ScenarioResult[] scenarios) =>
        Artifact(recordsConfidence: true, scenarios);

    /// <summary>Builds an artifact, optionally one that never recorded its confidence level.</summary>
    /// <param name="recordsConfidence">Whether the harness settings carry the interval confidence.</param>
    /// <param name="scenarios">The scenario records.</param>
    /// <returns>The artifact.</returns>
    public static SuiteResult Artifact(bool recordsConfidence, params ScenarioResult[] scenarios)
    {
        var config = new Dictionary<string, string>(StringComparer.Ordinal) { ["maxConcurrency"] = "1" };

        if (recordsConfidence)
        {
            config["intervalMethod"] = "wilson";
            config["intervalConfidence"] = ConfidenceLevel.ToString(CultureInfo.InvariantCulture);
        }

        return new SuiteResult
        {
            SuiteName = "regression",
            ScenarioResults = scenarios,
            Environment = new EvaluationEnvironment
            {
                Seed = 0,
                Timestamp = new DateTimeOffset(2026, 9, 24, 12, 0, 0, TimeSpan.Zero),
                HarnessConfig = config,
            },
        };
    }

    /// <summary>Builds one scenario's comparison.</summary>
    /// <param name="id">The scenario id.</param>
    /// <param name="classification">How it changed.</param>
    /// <param name="baseline">What the baseline said.</param>
    /// <param name="candidate">What this run said.</param>
    /// <param name="gradedPairs">How many repetition pairs both sides graded.</param>
    /// <param name="effect">The raw difference in pass rate, or null for no comparison summary.</param>
    /// <param name="pValue">The unadjusted p-value, or null.</param>
    /// <param name="adjusted">The corrected p-value, or null.</param>
    /// <param name="reason">Why it could not be compared, or null.</param>
    /// <returns>The comparison.</returns>
    public static ScenarioComparison Compared(
        string id,
        ScenarioClassification classification,
        ScenarioOutcome baseline,
        ScenarioOutcome candidate,
        int gradedPairs = 0,
        double? effect = null,
        double? pValue = null,
        double? adjusted = null,
        string? reason = null
    ) =>
        new()
        {
            ScenarioId = id,
            Classification = classification,
            BaselineOutcome = baseline,
            CandidateOutcome = candidate,
            GradedPairs = gradedPairs,
            Comparison = effect is null
                ? null
                : new ComparisonSummary
                {
                    EffectSize = effect.Value,
                    PValue = pValue,
                    AdjustedPValue = adjusted,
                    Test = pValue is null ? null : SignificanceTestKind.McNemar,
                    Significant =
                        adjusted is null ? SignificanceVerdict.NotComputed
                        : adjusted <= 0.05 ? SignificanceVerdict.Significant
                        : SignificanceVerdict.NotSignificant,
                },
            NotComparableReason = reason,
        };

    /// <summary>Wraps a comparison and its two artifacts as the outcome a run would have produced.</summary>
    /// <param name="result">What the comparator found.</param>
    /// <param name="baseline">The baseline artifact it read.</param>
    /// <param name="candidate">The candidate artifact it read.</param>
    /// <param name="notRun">The scenarios this invocation did not conduct.</param>
    /// <param name="reference">The baseline reference, as displayed.</param>
    /// <param name="identity">What distinguishes this baseline, when it is not derived from the reference.</param>
    /// <returns>The outcome.</returns>
    public static ComparisonOutcome Outcome(
        ComparisonResult result,
        SuiteResult baseline,
        SuiteResult candidate,
        IReadOnlyList<string>? notRun = null,
        string reference = "artifacts/baseline.json",
        ReportIdentity? identity = null
    ) =>
        new()
        {
            Mechanism = BaselineMechanism.Artifact,
            Reference = reference,
            ReferenceIdentity = identity ?? ReportIdentity.ForSegments([reference]),
            Result = result,
            Baseline = baseline,
            Candidate = candidate,
            WithheldScenarios = notRun ?? [],
        };
}
