using FluentAssertions;
using Forge.EvalEngine.Statistics;

namespace Forge.EvalEngine.Tests.Statistics;

/// <summary>
/// The numerics everything else stands on.
/// </summary>
/// <remarks>
/// <para>
/// <b>Every expected value here comes from outside this library.</b> The critical points are the
/// ones printed in standard statistical tables; the CDF and quantile values were produced by
/// Python 3.14's standard library (<c>math.erfc</c> and <c>statistics.NormalDist</c>, the latter
/// implementing Wichura's AS241), which shares no code with anything under test. Asserting that
/// this code reproduces its own arithmetic would prove nothing at all.
/// </para>
/// <para>
/// These types are internal, and are reached through <c>InternalsVisibleTo</c> rather than being
/// made public. A wrong tail probability here is silent — it produces a confident, wrong verdict
/// rather than a crash — so it is pinned directly instead of only through its callers.
/// </para>
/// </remarks>
public class StandardNormalTests
{
    /// <summary>
    /// Reference values from Python 3.14 <c>statistics.NormalDist().cdf(x)</c>. Phi(1) and Phi(2)
    /// are also the values printed in any standard normal table to the digits shown.
    /// </summary>
    [Theory]
    [InlineData(0.0, 0.5)]
    [InlineData(1.0, 0.8413447460685428)]
    [InlineData(-1.0, 0.15865525393145707)]
    [InlineData(0.5, 0.691462461274013)]
    [InlineData(1.96, 0.9750021048517796)]
    [InlineData(2.0, 0.9772498680518209)]
    [InlineData(3.0, 0.9986501019683699)]
    [InlineData(4.0, 0.9999683287581669)]
    public void Cdf_PublishedPoint_MatchesToFourteenSignificantFigures(double x, double expected)
    {
        StandardNormal.Cdf(x).Should().BeApproximately(expected, Math.Abs(expected) * 1e-13);
    }

    /// <summary>
    /// The far lower tail is where an implementation built on <c>1 - Phi(-x)</c> loses every
    /// significant digit it had. Reference: Python <c>statistics.NormalDist().cdf(-6.0)</c>.
    /// </summary>
    [Fact]
    public void Cdf_FarLowerTail_KeepsItsRelativeAccuracy()
    {
        StandardNormal.Cdf(-6.0).Should().BeApproximately(9.865876450377016e-10, 9.865876450377016e-10 * 1e-11);
    }

    [Fact]
    public void Cdf_ExtremeArguments_SaturateWithoutOverflow()
    {
        StandardNormal.Cdf(double.NegativeInfinity).Should().Be(0);
        StandardNormal.Cdf(double.PositiveInfinity).Should().Be(1);
        StandardNormal.Cdf(-40).Should().BeGreaterThanOrEqualTo(0).And.BeLessThan(1e-300);
        StandardNormal.Cdf(40).Should().Be(1);
    }

    [Fact]
    public void Cdf_NotANumber_ThrowsArgumentOutOfRangeException()
    {
        Action cdf = () => StandardNormal.Cdf(double.NaN);

        cdf.Should().Throw<ArgumentOutOfRangeException>();
    }

    /// <summary>
    /// The two-sided critical values every confidence interval in this library is built from.
    /// These are the numbers printed in standard normal tables (1.95996, 1.64485, 2.57583) and
    /// reproduce Python 3.14 <c>statistics.NormalDist().inv_cdf(p)</c> exactly.
    /// </summary>
    [Theory]
    [InlineData(0.975, 1.9599639845400536)]
    [InlineData(0.95, 1.6448536269514715)]
    [InlineData(0.995, 2.5758293035489)]
    [InlineData(0.9, 1.2815515655446008)]
    [InlineData(0.75, 0.6744897501960817)]
    [InlineData(0.999, 3.090232306167813)]
    public void InverseCdf_PublishedCriticalValue_MatchesToTenSignificantFigures(double probability, double expected)
    {
        StandardNormal.InverseCdf(probability).Should().BeApproximately(expected, Math.Abs(expected) * 1e-10);
    }

    [Fact]
    public void InverseCdf_Median_IsZero()
    {
        StandardNormal.InverseCdf(0.5).Should().Be(0);
    }

    [Fact]
    public void InverseCdf_Always_IsTheInverseOfTheCdf()
    {
        foreach (var probability in new[] { 0.001, 0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999 })
        {
            StandardNormal.Cdf(StandardNormal.InverseCdf(probability)).Should().BeApproximately(probability, 1e-12);
        }
    }

    [Theory]
    [InlineData(0.0)]
    [InlineData(1.0)]
    [InlineData(-0.1)]
    [InlineData(1.1)]
    [InlineData(double.NaN)]
    public void InverseCdf_OutsideTheOpenUnitInterval_ThrowsArgumentOutOfRangeException(double probability)
    {
        Action inverse = () => StandardNormal.InverseCdf(probability);

        inverse.Should().Throw<ArgumentOutOfRangeException>();
    }
}

public class ChiSquaredTests
{
    /// <summary>
    /// The one-degree-of-freedom critical points <b>as they are actually printed</b> in a
    /// chi-squared table: 3.841 at 0.05, 6.635 at 0.01, 10.828 at 0.001, 2.706 at 0.10. These
    /// four values, and only these, are the published ones.
    /// </summary>
    /// <remarks>
    /// The tolerance follows from the rounding rather than being picked. A statistic printed to
    /// three decimals carries +/-0.0005, and the chi-squared density at one degree of freedom,
    /// <c>f(x) = exp(-x/2) / sqrt(2*pi*x)</c>, is about 0.0298 at 3.841 — so the level moves by
    /// roughly 1.5e-5, or 3e-4 relative. A relative tolerance of 1e-3 covers all four points with
    /// margin while staying orders of magnitude tighter than any genuine implementation error.
    /// </remarks>
    [Theory]
    [InlineData(3.841, 0.05)]
    [InlineData(6.635, 0.01)]
    [InlineData(10.828, 0.001)]
    [InlineData(2.706, 0.10)]
    public void UpperTail_PublishedTableCriticalPoint_ReturnsItsTabulatedLevelToThePrecisionItIsPrintedAt(
        double statistic,
        double level
    )
    {
        ChiSquared.UpperTailOneDegreeOfFreedom(statistic).Should().BeApproximately(level, level * 1e-3);
    }

    /// <summary>
    /// The same four points to full precision. <b>These sixteen-digit statistics are derived, not
    /// published</b> — no table prints them — and the derivation is that a chi-squared critical
    /// point at one degree of freedom is the square of the two-sided standard normal critical
    /// value: 1.9599639845400536^2 = 3.8414588206941254 at the 5% level, and likewise for the
    /// others. They were produced from Python 3.14's <c>statistics.NormalDist().inv_cdf</c>,
    /// which shares no code with anything under test, and are asserted here at full precision
    /// because four decimals would hide an error in the tenth.
    /// </summary>
    [Theory]
    [InlineData(3.8414588206941254, 0.05)]
    [InlineData(6.634896601021216, 0.01)]
    [InlineData(10.827566170662735, 0.001)]
    [InlineData(2.705543454095414, 0.10)]
    public void UpperTail_DerivedCriticalPoint_ReturnsItsLevelToTwelveSignificantFigures(double statistic, double level)
    {
        ChiSquared.UpperTailOneDegreeOfFreedom(statistic).Should().BeApproximately(level, level * 1e-12);
    }

    /// <summary>Reference: Python <c>math.erfc(math.sqrt(x / 2))</c>.</summary>
    [Theory]
    [InlineData(0.0, 1.0)]
    [InlineData(1.0, 0.31731050786291404)]
    [InlineData(21.355555555555554, 3.815135865112595e-06)]
    [InlineData(20.67222222222222, 5.450094825427123e-06)]
    public void UpperTail_KnownStatistic_MatchesTheReferenceImplementation(double statistic, double expected)
    {
        ChiSquared.UpperTailOneDegreeOfFreedom(statistic).Should().BeApproximately(expected, expected * 1e-11);
    }

    [Fact]
    public void UpperTail_Always_StaysAProbability()
    {
        for (var statistic = 0.0; statistic < 60; statistic += 0.25)
        {
            var tail = ChiSquared.UpperTailOneDegreeOfFreedom(statistic);

            tail.Should().BeInRange(0, 1);
            double.IsFinite(tail).Should().BeTrue();
        }
    }

    [Fact]
    public void UpperTail_NegativeOrNotANumber_ThrowsArgumentOutOfRangeException()
    {
        Action negative = () => ChiSquared.UpperTailOneDegreeOfFreedom(-1);
        Action notANumber = () => ChiSquared.UpperTailOneDegreeOfFreedom(double.NaN);

        negative.Should().Throw<ArgumentOutOfRangeException>();
        notANumber.Should().Throw<ArgumentOutOfRangeException>();
    }
}

public class SignTestTests
{
    /// <summary>
    /// The exact two-sided binomial probability on the discordant pairs, which is exact
    /// arithmetic a reader can redo by hand: with b + c = 6 and c = 0 the p-value is
    /// 2 * (1/64) = 1/32, and with b + c = 10 and c = 2 it is 2 * (1 + 10 + 45)/1024 = 7/64.
    /// The fractions were confirmed independently in exact rational arithmetic.
    /// </summary>
    [Theory]
    [InlineData(1, 0, 1.0)]
    [InlineData(1, 1, 1.0)]
    [InlineData(2, 1, 1.0)]
    [InlineData(2, 0, 0.5)]
    [InlineData(3, 0, 0.25)]
    [InlineData(4, 0, 0.125)]
    [InlineData(5, 0, 0.0625)]
    [InlineData(6, 0, 0.03125)]
    [InlineData(0, 6, 0.03125)]
    [InlineData(10, 0, 0.001953125)]
    [InlineData(8, 2, 0.109375)]
    [InlineData(12, 12, 1.0)]
    [InlineData(20, 4, 0.001543879508972168)]
    [InlineData(13, 11, 0.8388197422027588)]
    [InlineData(15, 9, 0.30745625495910645)]
    [InlineData(24, 0, 1.1920928955078125e-07)]
    public void TwoSidedExactPValue_KnownTable_IsTheExactRational(int b, int c, double expected)
    {
        SignTest.TwoSidedExactPValue(b, c).Should().BeApproximately(expected, expected * 1e-12);
    }

    [Fact]
    public void TwoSidedExactPValue_Always_IsSymmetricInItsArguments()
    {
        for (var b = 0; b <= 12; b++)
        {
            for (var c = 0; c <= 12; c++)
            {
                if (b + c == 0)
                {
                    continue;
                }

                SignTest.TwoSidedExactPValue(b, c).Should().Be(SignTest.TwoSidedExactPValue(c, b));
            }
        }
    }

    [Fact]
    public void TwoSidedExactPValue_Always_StaysAProbability()
    {
        for (var b = 0; b <= 24; b++)
        {
            for (var c = 0; c <= 24; c++)
            {
                if (b + c == 0)
                {
                    continue;
                }

                var p = SignTest.TwoSidedExactPValue(b, c);

                double.IsFinite(p).Should().BeTrue($"b={b}, c={c} must not produce NaN or infinity");
                p.Should().BeInRange(0, 1);
            }
        }
    }

    [Fact]
    public void TwoSidedExactPValue_NoDiscordantPairs_ThrowsArgumentOutOfRangeException()
    {
        Action exact = () => SignTest.TwoSidedExactPValue(0, 0);

        exact.Should().Throw<ArgumentOutOfRangeException>("there is no conditional distribution to evaluate");
    }
}
