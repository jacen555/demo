using FluentAssertions;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Statistics;

namespace Forge.EvalEngine.Tests.Statistics;

/// <summary>
/// Collapsing a scenario's repetitions into one honest number.
/// </summary>
/// <remarks>
/// The load-bearing decision here is what an <see cref="RunStatus.Error"/> run does to the
/// estimate. A run that never reached the system under test is not evidence the system failed,
/// so counting it as a failure manufactures a regression out of a transport fault; counting it as
/// a pass manufactures a green. It is excluded from the denominator instead, and when that leaves
/// nothing the summary is withheld rather than invented.
/// </remarks>
public class ScenarioAggregatorTests
{
    /// <summary>
    /// Pinned against the shape T3 committed to the artifact: <c>TestData.SuiteResult()</c> and
    /// the canonical-JSON tests both carry <c>n = 5, pointEstimate = 0.8, dispersion = 0.4</c>,
    /// and sqrt(0.8 * 0.2) is exactly 0.4. Dispersion is therefore the population standard
    /// deviation of the Bernoulli sample, not the Bessel-corrected one, which would be 0.4472.
    /// </summary>
    [Fact]
    public void Summarize_FourPassesAndOneFailure_ReportsTheShapeTheArtifactAlreadyDeclares()
    {
        var summary = ScenarioAggregator.Default.Summarize(
            StatisticsFixtures.Runs(RunStatus.Pass, RunStatus.Pass, RunStatus.Pass, RunStatus.Pass, RunStatus.Fail)
        );

        summary.Should().NotBeNull();
        summary!.N.Should().Be(5);
        summary.PointEstimate.Should().Be(0.8);
        summary.Dispersion.Should().BeApproximately(0.4, 1e-15);
    }

    /// <summary>
    /// The second figure the artifact already declares: n = 40 at a pass rate of 0.75 has
    /// dispersion sqrt(0.1875) = 0.4330..., which the canonical-JSON test rounds to 0.43.
    /// </summary>
    [Fact]
    public void Summarize_ThreeQuartersPassing_ReportsThePopulationStandardDeviation()
    {
        var runs = StatisticsFixtures
            .Repeated(RunStatus.Pass, 30)
            .Concat(StatisticsFixtures.Repeated(RunStatus.Fail, 10))
            .ToArray();

        var summary = ScenarioAggregator.Default.Summarize(runs);

        summary!.N.Should().Be(40);
        summary.PointEstimate.Should().Be(0.75);
        summary.Dispersion.Should().BeApproximately(0.4330127018922193, 1e-15);
    }

    /// <summary>
    /// The decision this whole type turns on. Two passes, one failure and one ungradeable run is
    /// a pass rate of 2/3 over the three runs that produced evidence — not 2/4, which would read
    /// as a regression caused by a transport fault.
    /// </summary>
    [Fact]
    public void Summarize_OneRunErrored_ExcludesItFromBothTheCountAndTheEstimate()
    {
        var summary = ScenarioAggregator.Default.Summarize(
            StatisticsFixtures.Runs(RunStatus.Pass, RunStatus.Pass, RunStatus.Fail, RunStatus.Error)
        );

        summary!.N.Should().Be(3, "an ungradeable run produced no verdict to count");
        summary.PointEstimate.Should().BeApproximately(2.0 / 3.0, 1e-15);
    }

    /// <summary>
    /// Excluding errors narrows the evidence, and the interval has to widen to say so. If it did
    /// not, an errored suite would report the same confidence as a clean one.
    /// </summary>
    [Fact]
    public void Summarize_ErroredRuns_ProduceAWiderIntervalThanTheSameRateWithoutThem()
    {
        var clean = ScenarioAggregator.Default.Summarize(
            StatisticsFixtures
                .Repeated(RunStatus.Pass, 8)
                .Concat(StatisticsFixtures.Repeated(RunStatus.Fail, 2))
                .ToArray()
        );
        var degraded = ScenarioAggregator.Default.Summarize(
            StatisticsFixtures
                .Repeated(RunStatus.Pass, 4)
                .Concat(StatisticsFixtures.Repeated(RunStatus.Fail, 1))
                .Concat(StatisticsFixtures.Repeated(RunStatus.Error, 5))
                .ToArray()
        );

        clean!.PointEstimate.Should().Be(degraded!.PointEstimate);
        (degraded.Interval!.Upper - degraded.Interval.Lower)
            .Should()
            .BeGreaterThan(clean.Interval!.Upper - clean.Interval.Lower);
    }

    /// <summary>
    /// With nothing gradeable there is no point estimate to report, so none is reported. T3 made
    /// <see cref="ScenarioResult.Summary"/> nullable for exactly this, and a zero or a NaN here
    /// would both be figures the library did not compute.
    /// </summary>
    [Fact]
    public void Summarize_EveryRunErrored_ReturnsNoSummaryAtAll()
    {
        ScenarioAggregator.Default.Summarize(StatisticsFixtures.Repeated(RunStatus.Error, 4)).Should().BeNull();
    }

    [Fact]
    public void Summarize_NoRuns_ReturnsNoSummaryAtAll()
    {
        ScenarioAggregator.Default.Summarize([]).Should().BeNull();
    }

    /// <summary>
    /// An expected failure is still a graded verdict about the system: it ran, and it did not do
    /// the right thing. It counts as a non-pass. That a reporter should not flag it as a
    /// regression is a reporting concern, not an estimation one.
    /// </summary>
    [Fact]
    public void Summarize_ExpectedFailure_CountsAsAGradedNonPass()
    {
        var summary = ScenarioAggregator.Default.Summarize(
            StatisticsFixtures.Runs(RunStatus.Pass, RunStatus.ExpectedFailure)
        );

        summary!.N.Should().Be(2);
        summary.PointEstimate.Should().Be(0.5);
    }

    /// <summary>
    /// The two boundaries a naive estimator gets away with and a naive interval does not.
    /// Reference bounds from an independent implementation of the Wilson formula.
    /// </summary>
    [Fact]
    public void Summarize_EveryRunPassed_ReportsAnEstimateOfOneWithAnIntervalThatIsNotDegenerate()
    {
        var summary = ScenarioAggregator.Default.Summarize(StatisticsFixtures.Repeated(RunStatus.Pass, 3));

        summary!.PointEstimate.Should().Be(1);
        summary.Dispersion.Should().Be(0);
        summary.Interval!.Lower.Should().BeApproximately(0.438502968245, 1e-11);
        summary.Interval.Upper.Should().Be(1);
    }

    [Fact]
    public void Summarize_EveryRunFailed_ReportsAnEstimateOfZeroWithAnIntervalThatIsNotDegenerate()
    {
        var summary = ScenarioAggregator.Default.Summarize(StatisticsFixtures.Repeated(RunStatus.Fail, 3));

        summary!.PointEstimate.Should().Be(0);
        summary.Dispersion.Should().Be(0);
        summary.Interval!.Lower.Should().Be(0);
        summary.Interval.Upper.Should().BeApproximately(0.561497031755, 1e-11);
    }

    /// <summary>
    /// A single repetition is the common case — <see cref="RepetitionPolicy.Once"/> is
    /// <c>Repeat(1)</c> — and it is where a Bessel-corrected dispersion would divide by zero.
    /// </summary>
    [Fact]
    public void Summarize_ASingleRun_ReportsZeroDispersionRatherThanNotANumber()
    {
        var summary = ScenarioAggregator.Default.Summarize(StatisticsFixtures.Runs(RunStatus.Pass));

        summary!.N.Should().Be(1);
        summary.PointEstimate.Should().Be(1);
        double.IsNaN(summary.Dispersion).Should().BeFalse();
        summary.Dispersion.Should().Be(0);
        summary.Interval!.Lower.Should().BeApproximately(0.206549314377, 1e-11);
        summary.Interval.Upper.Should().Be(1);
    }

    /// <summary>
    /// Every figure written into a committed artifact has to be a real number. A NaN or an
    /// infinity does not even serialize as valid JSON, so the whole small-n grid is swept.
    /// </summary>
    [Fact]
    public void Summarize_EveryMixOfUpToEightRuns_ProducesOnlyFiniteFigures()
    {
        for (var total = 1; total <= 8; total++)
        {
            for (var passes = 0; passes <= total; passes++)
            {
                var summary = ScenarioAggregator.Default.Summarize(
                    StatisticsFixtures
                        .Repeated(RunStatus.Pass, passes)
                        .Concat(StatisticsFixtures.Repeated(RunStatus.Fail, total - passes))
                        .ToArray()
                );

                var because = $"{passes}/{total}";
                double.IsFinite(summary!.PointEstimate).Should().BeTrue(because);
                double.IsFinite(summary.Dispersion).Should().BeTrue(because);
                double.IsFinite(summary.Interval!.Lower).Should().BeTrue(because);
                double.IsFinite(summary.Interval.Upper).Should().BeTrue(because);
                summary.Interval.Lower.Should().BeLessThanOrEqualTo(summary.Interval.Upper, because);
            }
        }
    }

    [Fact]
    public void Summarize_Always_ReportsTheIntervalMethodItActuallyUsed()
    {
        ScenarioAggregator
            .Default.Summarize(StatisticsFixtures.Repeated(RunStatus.Pass, 4))!
            .Interval!.Method.Should()
            .Be(IntervalMethod.Wilson);

        new ScenarioAggregator(IntervalMethod.AgrestiCoull, 0.95)
            .Summarize(StatisticsFixtures.Repeated(RunStatus.Pass, 4))!
            .Interval!.Method.Should()
            .Be(IntervalMethod.AgrestiCoull);
    }

    [Fact]
    public void Summarize_Always_LeavesTheBaselineComparisonUnset()
    {
        ScenarioAggregator
            .Default.Summarize(StatisticsFixtures.Repeated(RunStatus.Pass, 4))!
            .Comparison.Should()
            .BeNull("comparing against a baseline needs a baseline, which this stage has no access to");
    }

    [Fact]
    public void Summarize_NullRuns_ThrowsArgumentNullException()
    {
        Action summarize = () => ScenarioAggregator.Default.Summarize(null!);

        summarize.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Summarize_ARunThatIsNull_ThrowsArgumentException()
    {
        Action summarize = () => ScenarioAggregator.Default.Summarize([StatisticsFixtures.Run(RunStatus.Pass), null!]);

        summarize.Should().Throw<ArgumentException>();
    }

    /// <summary>
    /// A value outside the declared enum is not a verdict about anything. Reached through an
    /// "everything that is not an error is graded" branch it silently becomes a graded failure,
    /// and an undefined status acquires a point estimate, a dispersion and a confidence interval
    /// — an estimate manufactured from a value this domain never defined. The four declared
    /// statuses are handled exhaustively and anything else is refused.
    /// </summary>
    [Fact]
    public void Summarize_AnUndeclaredRunStatus_ThrowsArgumentException()
    {
        Action summarize = () => ScenarioAggregator.Default.Summarize(StatisticsFixtures.Runs((RunStatus)99));

        summarize.Should().Throw<ArgumentException>().WithMessage("*99*");
    }

    /// <summary>
    /// The same refusal when the undefined value is hidden among runs that <i>are</i> gradeable,
    /// which is the shape that would otherwise pass review: a plausible summary over a
    /// denominator containing one value nobody defined.
    /// </summary>
    [Fact]
    public void Summarize_AnUndeclaredRunStatusAmongGradedRuns_ThrowsRatherThanQuietlyGradingIt()
    {
        Action summarize = () =>
            ScenarioAggregator.Default.Summarize(
                StatisticsFixtures.Runs(RunStatus.Pass, RunStatus.Pass, RunStatus.Fail, (RunStatus)(-1))
            );

        summarize.Should().Throw<ArgumentException>();
    }

    /// <summary>
    /// The four declared statuses must all stay reachable — a guard that refuses unknown values
    /// is worthless if it also refuses a status the domain does define.
    /// </summary>
    [Theory]
    [InlineData(RunStatus.Pass)]
    [InlineData(RunStatus.Fail)]
    [InlineData(RunStatus.Error)]
    [InlineData(RunStatus.ExpectedFailure)]
    public void Summarize_EveryDeclaredRunStatus_IsAccepted(RunStatus status)
    {
        Action summarize = () => ScenarioAggregator.Default.Summarize(StatisticsFixtures.Runs(status));

        summarize.Should().NotThrow();
    }

    [Fact]
    public void Default_Always_IsWilsonAtNinetyFivePercent()
    {
        ScenarioAggregator.Default.IntervalMethod.Should().Be(IntervalMethod.Wilson);
        ScenarioAggregator.Default.ConfidenceLevel.Should().Be(0.95);
    }

    [Theory]
    [InlineData(0.0)]
    [InlineData(1.0)]
    [InlineData(double.NaN)]
    public void Constructor_ConfidenceLevelOutsideTheOpenUnitInterval_ThrowsArgumentOutOfRangeException(double level)
    {
        Action construct = () => _ = new ScenarioAggregator(IntervalMethod.Wilson, level);

        construct.Should().Throw<ArgumentOutOfRangeException>();
    }

    [Fact]
    public void Constructor_UnknownIntervalMethod_ThrowsArgumentOutOfRangeException()
    {
        Action construct = () => _ = new ScenarioAggregator((IntervalMethod)99, 0.95);

        construct.Should().Throw<ArgumentOutOfRangeException>();
    }
}
