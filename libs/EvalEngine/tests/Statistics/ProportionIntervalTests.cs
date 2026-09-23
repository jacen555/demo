using FluentAssertions;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Statistics;

namespace Forge.EvalEngine.Tests.Statistics;

/// <summary>
/// Interval estimation for a pass rate.
/// </summary>
/// <remarks>
/// <para>
/// The Wilson expectations below are the published worked examples from <b>Newcombe, R.G.
/// (1998), "Two-sided confidence intervals for the single proportion: comparison of seven
/// methods", Statistics in Medicine 17:857-872, Table I</b>, whose four illustrative
/// proportions are 81/263, 15/148, 0/20 and 1/29. Those four were independently reproduced from
/// the Wilson formula in Python 3.14 (using <c>statistics.NormalDist().inv_cdf</c> for z) before
/// being written down here, so a slip of memory in the citation would have shown up as a
/// mismatch.
/// </para>
/// <para>
/// The Agresti-Coull expectations are <b>not</b> from a published table. They were computed in
/// Python from the formula in Agresti, A. &amp; Coull, B.A. (1998), "Approximate Is Better than
/// 'Exact' for Interval Estimation of Binomial Proportions", The American Statistician
/// 52(2):119-126 — an independent implementation, but not an authoritative worked example, and
/// stated as such.
/// </para>
/// </remarks>
public class ProportionIntervalTests
{
    [Theory]
    [InlineData(81, 263, 0.2553, 0.3662)]
    [InlineData(15, 148, 0.0624, 0.1605)]
    [InlineData(0, 20, 0.0000, 0.1611)]
    [InlineData(1, 29, 0.0061, 0.1718)]
    public void Wilson_NewcombeTableOne_MatchesThePublishedIntervalToFourDecimals(
        int successes,
        int trials,
        double lower,
        double upper
    )
    {
        var interval = ProportionInterval.Wilson(successes, trials);

        interval.Lower.Should().BeApproximately(lower, 0.00005);
        interval.Upper.Should().BeApproximately(upper, 0.00005);
        interval.Method.Should().Be(IntervalMethod.Wilson);
    }

    /// <summary>
    /// The same four cases to full precision, from an independent implementation of the Wilson
    /// formula. Four decimals would hide an error in the tenth.
    /// </summary>
    [Theory]
    [InlineData(81, 263, 0.2552885199, 0.3662095770)]
    [InlineData(15, 148, 0.0623863995, 0.1604872417)]
    [InlineData(1, 29, 0.0061132143, 0.1717552188)]
    public void Wilson_NewcombeTableOne_MatchesToTenDecimals(int successes, int trials, double lower, double upper)
    {
        var interval = ProportionInterval.Wilson(successes, trials);

        interval.Lower.Should().BeApproximately(lower, 1e-10);
        interval.Upper.Should().BeApproximately(upper, 1e-10);
    }

    /// <summary>
    /// The regime this harness actually lives in: three to ten repetitions, pass rate at or near
    /// the boundary. Reference values from an independent implementation of the Wilson formula.
    /// </summary>
    [Theory]
    [InlineData(3, 3, 0.438502968245, 1.0)]
    [InlineData(0, 3, 0.0, 0.561497031755)]
    [InlineData(5, 10, 0.236593090513, 0.763406909487)]
    [InlineData(9, 10, 0.595849973205, 0.982123786905)]
    [InlineData(1, 1, 0.206549314377, 1.0)]
    [InlineData(0, 1, 0.0, 0.793450685623)]
    [InlineData(4, 5, 0.375534629763, 0.963775891368)]
    public void Wilson_SmallNumberOfRepetitions_MatchesTheReferenceImplementation(
        int successes,
        int trials,
        double lower,
        double upper
    )
    {
        var interval = ProportionInterval.Wilson(successes, trials);

        interval.Lower.Should().BeApproximately(lower, 1e-11);
        interval.Upper.Should().BeApproximately(upper, 1e-11);
    }

    /// <summary>
    /// The boundary the Wald interval gets catastrophically wrong: at zero successes it reports
    /// the degenerate interval [0, 0], and at every success [1, 1]. Wilson does not — and its
    /// lower bound at zero successes is exactly zero algebraically, not merely close to it.
    /// </summary>
    [Fact]
    public void Wilson_NoSuccesses_PinsTheLowerBoundAtZeroAndStillReportsWidth()
    {
        var interval = ProportionInterval.Wilson(0, 10);

        interval.Lower.Should().Be(0);
        interval.Upper.Should().BeGreaterThan(0.2, "a Wald interval would collapse to [0, 0] here");
    }

    [Fact]
    public void Wilson_EverySuccess_PinsTheUpperBoundAtOneAndStillReportsWidth()
    {
        var interval = ProportionInterval.Wilson(10, 10);

        interval.Upper.Should().Be(1);
        interval.Lower.Should().BeLessThan(0.8, "a Wald interval would collapse to [1, 1] here");
    }

    /// <summary>
    /// A Wilson interval always contains the observed proportion and never leaves [0, 1]. The
    /// second half is the property the normal approximation violates at small n, and it is
    /// checked across the whole small-sample grid rather than at a convenient point.
    /// </summary>
    [Fact]
    public void Wilson_EveryProportionUpToTwentyTrials_ContainsTheEstimateAndStaysInTheUnitInterval()
    {
        for (var trials = 1; trials <= 20; trials++)
        {
            for (var successes = 0; successes <= trials; successes++)
            {
                var interval = ProportionInterval.Wilson(successes, trials);
                var estimate = (double)successes / trials;

                interval.Lower.Should().BeInRange(0, 1, $"{successes}/{trials} lower bound");
                interval.Upper.Should().BeInRange(0, 1, $"{successes}/{trials} upper bound");
                interval.Lower.Should().BeLessThanOrEqualTo(estimate + 1e-12, $"{successes}/{trials}");
                interval.Upper.Should().BeGreaterThanOrEqualTo(estimate - 1e-12, $"{successes}/{trials}");
            }
        }
    }

    [Fact]
    public void AgrestiCoull_EveryProportionUpToTwentyTrials_StaysInTheUnitInterval()
    {
        for (var trials = 1; trials <= 20; trials++)
        {
            for (var successes = 0; successes <= trials; successes++)
            {
                var interval = ProportionInterval.AgrestiCoull(successes, trials);

                interval.Lower.Should().BeInRange(0, 1, $"{successes}/{trials} lower bound");
                interval.Upper.Should().BeInRange(0, 1, $"{successes}/{trials} upper bound");
                interval.Lower.Should().BeLessThanOrEqualTo(interval.Upper);
            }
        }
    }

    /// <summary>Reference values from an independent implementation of the Agresti-Coull formula.</summary>
    [Theory]
    [InlineData(81, 263, 0.2552206652, 0.3662774317)]
    [InlineData(15, 148, 0.0613859749, 0.1614876663)]
    [InlineData(0, 20, 0.0, 0.1898095605)]
    [InlineData(1, 29, 0.0, 0.1862865086)]
    public void AgrestiCoull_KnownProportion_MatchesTheReferenceImplementation(
        int successes,
        int trials,
        double lower,
        double upper
    )
    {
        var interval = ProportionInterval.AgrestiCoull(successes, trials);

        interval.Lower.Should().BeApproximately(lower, 1e-10);
        interval.Upper.Should().BeApproximately(upper, 1e-10);
        interval.Method.Should().Be(IntervalMethod.AgrestiCoull);
    }

    /// <summary>
    /// Agresti-Coull's raw bounds run outside [0, 1] at extreme proportions — 1/29 has a raw
    /// lower bound below zero — so the clamp is load-bearing rather than decorative.
    /// </summary>
    [Fact]
    public void AgrestiCoull_ExtremeProportion_ClampsRatherThanReportingAnImpossibleBound()
    {
        ProportionInterval.AgrestiCoull(1, 29).Lower.Should().Be(0);
        ProportionInterval.AgrestiCoull(28, 29).Upper.Should().Be(1);
    }

    /// <summary>
    /// A confidence level one ulp below one is a legal level, and the upper-tail form
    /// <c>InverseCdf(1 - (1 - level) / 2)</c> cannot express it. <c>(1 - level) / 2</c> is
    /// 5.551115123125783e-17, and <c>1 - 5.551115123125783e-17</c> rounds to <i>exactly</i> one,
    /// which is outside the open interval a quantile is defined on — so both interval methods
    /// threw on a level they are documented to accept. Working from the lower tail keeps the
    /// probability representable, and by the symmetry of the standard normal it is the same
    /// critical value.
    /// </summary>
    /// <remarks>
    /// The critical value at that level is 8.292361075813595, computed two independent ways in
    /// Python 3.14 — <c>statistics.NormalDist().inv_cdf</c> (Wichura's AS241) and a bisection
    /// against <c>math.erfc</c> — which agreed to every bit. The bounds below follow from it
    /// through the Wilson formula, so they are reference values, not published ones.
    /// </remarks>
    [Fact]
    public void Wilson_AConfidenceLevelJustBelowOne_ReturnsAnIntervalRatherThanThrowing()
    {
        var interval = ProportionInterval.Wilson(4, 10, Math.BitDecrement(1.0));

        interval.Lower.Should().BeApproximately(0.021309220181150446, 1e-11);
        interval.Upper.Should().BeApproximately(0.953298227532852, 1e-11);
    }

    [Fact]
    public void AgrestiCoull_AConfidenceLevelJustBelowOne_ReturnsAnIntervalRatherThanThrowing()
    {
        var interval = ProportionInterval.AgrestiCoull(4, 10, Math.BitDecrement(1.0));

        interval.Lower.Should().BeInRange(0, 1);
        interval.Upper.Should().BeInRange(0, 1);
        interval.Lower.Should().BeLessThanOrEqualTo(interval.Upper);
    }

    /// <summary>
    /// Raising the confidence level must widen the interval at every step, including into the
    /// near-one corner the subtraction used to lose. A level that threw, or that silently
    /// saturated, would break this monotonicity.
    /// </summary>
    [Fact]
    public void Wilson_RisingConfidenceLevels_WidenTheIntervalMonotonically()
    {
        var levels = new[] { 0.5, 0.8, 0.95, 0.99, 0.999, 1 - 1e-12, Math.BitDecrement(1.0) };
        var widths = levels.Select(level => ProportionInterval.Wilson(4, 10, level)).ToArray();

        for (var i = 1; i < widths.Length; i++)
        {
            (widths[i].Upper - widths[i].Lower)
                .Should()
                .BeGreaterThan(widths[i - 1].Upper - widths[i - 1].Lower, $"level {levels[i]} exceeds {levels[i - 1]}");
        }
    }

    /// <summary>
    /// At an observed proportion of exactly one half the two methods are algebraically identical:
    /// both reduce to 0.5 +/- z / (2 * sqrt(n + z^2)). A test that agrees only approximately
    /// would be hiding an error in one of them.
    /// </summary>
    [Fact]
    public void Wilson_ProportionOfAHalf_AgreesWithAgrestiCoullToWithinRounding()
    {
        foreach (var trials in new[] { 2, 4, 10, 50, 264 })
        {
            var wilson = ProportionInterval.Wilson(trials / 2, trials);
            var agrestiCoull = ProportionInterval.AgrestiCoull(trials / 2, trials);

            wilson.Lower.Should().BeApproximately(agrestiCoull.Lower, 1e-14);
            wilson.Upper.Should().BeApproximately(agrestiCoull.Upper, 1e-14);
        }
    }

    [Fact]
    public void Wilson_HigherConfidence_ProducesAWiderInterval()
    {
        var ninetyFive = ProportionInterval.Wilson(8, 10);
        var ninetyNine = ProportionInterval.Wilson(8, 10, 0.99);

        (ninetyNine.Upper - ninetyNine.Lower).Should().BeGreaterThan(ninetyFive.Upper - ninetyFive.Lower);
    }

    [Fact]
    public void Compute_EachMethod_DelegatesToItAndStampsIt()
    {
        ProportionInterval.Compute(8, 10, IntervalMethod.Wilson).Should().Be(ProportionInterval.Wilson(8, 10));
        ProportionInterval
            .Compute(8, 10, IntervalMethod.AgrestiCoull)
            .Should()
            .Be(ProportionInterval.AgrestiCoull(8, 10));
    }

    [Fact]
    public void Compute_UnknownMethod_ThrowsArgumentOutOfRangeException()
    {
        Action compute = () => ProportionInterval.Compute(8, 10, (IntervalMethod)99);

        compute.Should().Throw<ArgumentOutOfRangeException>();
    }

    [Theory]
    [InlineData(0, 0)]
    [InlineData(-1, 10)]
    [InlineData(11, 10)]
    [InlineData(1, -1)]
    public void Wilson_ImpossibleCounts_ThrowsArgumentOutOfRangeException(int successes, int trials)
    {
        Action wilson = () => ProportionInterval.Wilson(successes, trials);
        Action agrestiCoull = () => ProportionInterval.AgrestiCoull(successes, trials);

        wilson.Should().Throw<ArgumentOutOfRangeException>();
        agrestiCoull.Should().Throw<ArgumentOutOfRangeException>();
    }

    [Theory]
    [InlineData(0.0)]
    [InlineData(1.0)]
    [InlineData(-0.5)]
    [InlineData(1.5)]
    [InlineData(double.NaN)]
    public void Wilson_ConfidenceLevelOutsideTheOpenUnitInterval_ThrowsArgumentOutOfRangeException(double level)
    {
        Action wilson = () => ProportionInterval.Wilson(5, 10, level);

        wilson.Should().Throw<ArgumentOutOfRangeException>();
    }
}
