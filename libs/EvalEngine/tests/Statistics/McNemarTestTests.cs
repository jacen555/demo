using FluentAssertions;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Statistics;

namespace Forge.EvalEngine.Tests.Statistics;

/// <summary>
/// McNemar's test on the discordant pairs.
/// </summary>
/// <remarks>
/// <para>
/// Sources for the expectations below. <b>Published</b>: the test itself is McNemar, Q. (1947),
/// "Note on the sampling error of the difference between correlated proportions or percentages",
/// Psychometrika 12(2):153-157, with the continuity correction from Edwards, A.L. (1948), "Note
/// on the 'correction for continuity' in testing the significance of the difference between
/// correlated proportions", Psychometrika 13(3):185-187. The worked table b = 121, c = 59 is the
/// example carried in the standard references for the test, whose uncorrected statistic is the
/// widely printed 21.3556 = 62^2 / 180 — arithmetic a reader can redo from the cell counts. The
/// 150/86 table is Agresti's Prime-Minister-approval example, whose published statistic is
/// 17.36 (z = 4.17).
/// </para>
/// <para>
/// <b>Derived</b>: the p-values themselves were computed from those published statistics by an
/// independent implementation (Python 3.14 <c>math.erfc</c> for the chi-squared tail, exact
/// rational arithmetic for the binomial tail), not lifted from a table. The exact small-sample
/// values are plain fractions and are checkable by hand.
/// </para>
/// </remarks>
public class McNemarTestTests
{
    private static readonly McNemarTest Test = new();

    /// <summary>
    /// The classic worked table. Its published uncorrected statistic is 62^2 / 180 = 21.3556;
    /// this implementation applies Edwards' continuity correction, giving 61^2 / 180 = 20.6722
    /// and a two-sided tail of 5.4501e-06.
    /// </summary>
    [Fact]
    public void Compare_ClassicWorkedTable_ReportsTheContinuityCorrectedTail()
    {
        var comparison = Test.Compare(
            StatisticsFixtures.Table(baselineOnly: 121, candidateOnly: 59, bothPass: 101, bothFail: 33)
        );

        comparison.PValue.Should().BeApproximately(5.450094825427123e-06, 5.450094825427123e-06 * 1e-10);
        comparison.Test.Should().Be(SignificanceTestKind.McNemar);
        comparison.Significant.Should().Be(SignificanceVerdict.Significant);
    }

    /// <summary>Agresti's approval-rating table: b = 150, c = 86, published statistic 17.36.</summary>
    [Fact]
    public void Compare_ApprovalRatingTable_ReportsTheContinuityCorrectedTail()
    {
        var comparison = Test.Compare(
            StatisticsFixtures.Table(baselineOnly: 150, candidateOnly: 86, bothPass: 794, bothFail: 570)
        );

        comparison.PValue.Should().BeApproximately(4.114562281345942e-05, 4.114562281345942e-05 * 1e-10);
    }

    /// <summary>
    /// The effect size is the raw difference in pass rate across <b>all</b> scenarios, not just
    /// the discordant ones: 121 regressions and 59 fixes over 314 scenarios is -0.19745.
    /// </summary>
    [Fact]
    public void Compare_Always_ReportsTheRawDifferenceInPassRateOverEveryScenario()
    {
        var comparison = Test.Compare(
            StatisticsFixtures.Table(baselineOnly: 121, candidateOnly: 59, bothPass: 101, bothFail: 33)
        );

        comparison.EffectSize.Should().BeApproximately(-0.19745222929936307, 1e-15);
    }

    /// <summary>
    /// The edge case that makes a naive implementation emit NaN: with no discordant pairs the
    /// statistic is 0/0. There is no evidence about the direction of change, so nothing is
    /// claimed — and the raw effect size, which is genuinely zero, is still reported.
    /// </summary>
    [Fact]
    public void Compare_NoDiscordantPairs_ReportsNotComputedRatherThanNotANumber()
    {
        var comparison = Test.Compare(
            StatisticsFixtures.Table(baselineOnly: 0, candidateOnly: 0, bothPass: 5, bothFail: 3)
        );

        comparison.PValue.Should().BeNull();
        comparison.Significant.Should().Be(SignificanceVerdict.NotComputed);
        comparison.Test.Should().BeNull("no test was run");
        comparison.EffectSize.Should().Be(0);
    }

    /// <summary>
    /// Below the conventional threshold the chi-squared approximation is not trustworthy, so the
    /// exact conditional binomial test is used instead. Six discordant pairs all in one
    /// direction is 2 * (1/2)^6 = 1/32 — hand-checkable, and nothing like the 0.0143 the
    /// corrected chi-squared approximation would claim.
    /// </summary>
    [Theory]
    [InlineData(6, 0, 0.03125)]
    [InlineData(0, 6, 0.03125)]
    [InlineData(5, 0, 0.0625)]
    [InlineData(8, 2, 0.109375)]
    [InlineData(1, 0, 1.0)]
    [InlineData(1, 1, 1.0)]
    [InlineData(20, 4, 0.001543879508972168)]
    public void Compare_FewerThanTwentyFiveDiscordantPairs_UsesTheExactConditionalTest(
        int baselineOnly,
        int candidateOnly,
        double expected
    )
    {
        var comparison = Test.Compare(
            StatisticsFixtures.Table(baselineOnly, candidateOnly, bothPass: 10, bothFail: 10)
        );

        comparison.PValue.Should().BeApproximately(expected, expected * 1e-12);
    }

    /// <summary>
    /// The threshold is a real switch, not decoration: 24 discordant pairs all one way gives the
    /// exact 2^-23 = 1.1921e-07, and 25 gives the corrected chi-squared tail 1.5867e-06 — an
    /// order of magnitude apart, so a test that straddles it cannot pass by accident.
    /// </summary>
    [Fact]
    public void Compare_AtTheExactThreshold_SwitchesFromTheExactTestToTheChiSquaredApproximation()
    {
        var justBelow = Test.Compare(StatisticsFixtures.Table(baselineOnly: 24, candidateOnly: 0, bothPass: 40));
        var atThreshold = Test.Compare(StatisticsFixtures.Table(baselineOnly: 25, candidateOnly: 0, bothPass: 40));

        justBelow.PValue.Should().BeApproximately(1.1920928955078125e-07, 1.1920928955078125e-07 * 1e-12);
        atThreshold.PValue.Should().BeApproximately(1.5866563039511898e-06, 1.5866563039511898e-06 * 1e-10);
    }

    /// <summary>
    /// A single discordant pair is the smallest non-degenerate input, and one observation can
    /// never be evidence of anything: the exact test returns 1 rather than a small number.
    /// </summary>
    [Fact]
    public void Compare_ASingleDiscordantPair_ReportsAPValueOfOne()
    {
        var comparison = Test.Compare(StatisticsFixtures.Table(baselineOnly: 1, candidateOnly: 0, bothPass: 40));

        comparison.PValue.Should().Be(1);
        comparison.Significant.Should().Be(SignificanceVerdict.NotSignificant);
    }

    /// <summary>
    /// Equal numbers of regressions and fixes is the null hypothesis exactly. A corrected
    /// statistic of (|0| - 1)^2 / n is <i>positive</i>, so an implementation that forgot to floor
    /// the correction would report a tail below one for a perfectly balanced table.
    /// </summary>
    [Fact]
    public void Compare_EquallyManyRegressionsAndFixes_ReportsNoEvidenceOfADifference()
    {
        var comparison = Test.Compare(StatisticsFixtures.Table(baselineOnly: 13, candidateOnly: 13, bothPass: 40));

        comparison.EffectSize.Should().Be(0);
        comparison.PValue.Should().Be(1);
        comparison.Significant.Should().Be(SignificanceVerdict.NotSignificant);
    }

    /// <summary>
    /// A wrong p-value here is silent, so the whole small grid is swept for figures that would
    /// not even serialize as JSON.
    /// </summary>
    [Fact]
    public void Compare_EveryDiscordantTableUpToThirty_ProducesOnlyFiniteProbabilities()
    {
        for (var baselineOnly = 0; baselineOnly <= 30; baselineOnly++)
        {
            for (var candidateOnly = 0; candidateOnly <= 30; candidateOnly++)
            {
                var comparison = Test.Compare(StatisticsFixtures.Table(baselineOnly, candidateOnly, bothPass: 1));
                var because = $"b={baselineOnly}, c={candidateOnly}";

                double.IsFinite(comparison.EffectSize).Should().BeTrue(because);

                if (comparison.PValue is { } p)
                {
                    double.IsFinite(p).Should().BeTrue(because);
                    p.Should().BeInRange(0, 1, because);
                }
                else
                {
                    comparison.Significant.Should().Be(SignificanceVerdict.NotComputed, because);
                }
            }
        }
    }

    [Fact]
    public void Compare_PValueAboveTheSignificanceLevel_IsReportedAsNotSignificant()
    {
        var comparison = Test.Compare(StatisticsFixtures.Table(baselineOnly: 8, candidateOnly: 2, bothPass: 10));

        comparison.PValue.Should().BeApproximately(0.109375, 1e-12);
        comparison.Significant.Should().Be(SignificanceVerdict.NotSignificant);
    }

    [Fact]
    public void Compare_CustomSignificanceLevel_MovesTheVerdictBoundary()
    {
        var observations = StatisticsFixtures.Table(baselineOnly: 6, candidateOnly: 0, bothPass: 10);

        new McNemarTest(0.05).Compare(observations).Significant.Should().Be(SignificanceVerdict.Significant);
        new McNemarTest(0.01).Compare(observations).Significant.Should().Be(SignificanceVerdict.NotSignificant);
    }

    /// <summary>
    /// McNemar is defined on binary outcomes. Handing it a mean over repetitions is the caller
    /// choosing the wrong test, which is a defect rather than a data condition, so it fails loud
    /// instead of returning a number that does not mean what it says.
    /// </summary>
    [Fact]
    public void Compare_NonBinaryObservations_ThrowsArgumentException()
    {
        Action compare = () => Test.Compare(StatisticsFixtures.Continuous(0.5, 0.25, 1.0));

        compare.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void Compare_NullObservations_ThrowsArgumentNullException()
    {
        Action compare = () => Test.Compare(null!);

        compare.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Compare_CancelledToken_ThrowsOperationCanceledException()
    {
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();

        Action compare = () => Test.Compare(StatisticsFixtures.Table(4, 4, bothPass: 4), cancelled.Token);

        compare.Should().Throw<OperationCanceledException>();
    }

    [Fact]
    public void Kind_Always_IsMcNemar()
    {
        Test.Kind.Should().Be(SignificanceTestKind.McNemar);
    }

    [Theory]
    [InlineData(0.0)]
    [InlineData(1.0)]
    [InlineData(double.NaN)]
    public void Constructor_SignificanceLevelOutsideTheOpenUnitInterval_ThrowsArgumentOutOfRangeException(double level)
    {
        Action construct = () => _ = new McNemarTest(level);

        construct.Should().Throw<ArgumentOutOfRangeException>();
    }
}
