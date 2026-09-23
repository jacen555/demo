namespace Forge.EvalEngine.Statistics;

/// <summary>
/// The standard normal distribution.
/// </summary>
/// <remarks>
/// <para>
/// Implemented from the definition rather than from a recalled table of rational-approximation
/// coefficients. The error function is evaluated by an all-positive power series near the origin
/// and by its continued fraction in the tail, so there is no constant here that could be silently
/// wrong in its eighth digit — a failure mode that would not crash anything and would produce
/// confident, wrong intervals instead.
/// </para>
/// <para>
/// The series is the confluent form
/// <c>erf(x) = (2x/sqrt(pi)) * exp(-x^2) * sum_{k&gt;=0} (2x^2)^k / (2k+1)!!</c>, whose terms are
/// all positive and therefore free of the cancellation that spoils the alternating form. The
/// tail uses the standard continued fraction
/// <c>erfc(x) = exp(-x^2)/sqrt(pi) * 1/(x + (1/2)/(x + 1/(x + (3/2)/(x + ...))))</c>, evaluated
/// by the modified Lentz algorithm.
/// </para>
/// </remarks>
internal static class StandardNormal
{
    /// <summary>The point beyond which the continued fraction converges faster than the series.</summary>
    private const double TailThreshold = 2.0;

    private const int MaximumIterations = 300;
    private const double RelativeTolerance = 1e-17;
    private const double Tiny = 1e-300;

    private static readonly double TwoOverSqrtPi = 2.0 / Math.Sqrt(Math.PI);
    private static readonly double OneOverSqrtPi = 1.0 / Math.Sqrt(Math.PI);

    /// <summary>Evaluates the cumulative distribution function.</summary>
    /// <param name="x">The point to evaluate at. Infinities saturate; NaN is refused.</param>
    /// <returns>The probability that a standard normal variate is at most <paramref name="x"/>.</returns>
    /// <remarks>
    /// Computed as <c>erfc(-x / sqrt(2)) / 2</c>, which keeps its relative accuracy in the lower
    /// tail. The textbook <c>1 - Phi(-x)</c> loses every significant digit there.
    /// </remarks>
    /// <exception cref="ArgumentOutOfRangeException"><paramref name="x"/> is NaN.</exception>
    public static double Cdf(double x)
    {
        if (double.IsNaN(x))
        {
            throw new ArgumentOutOfRangeException(nameof(x), x, "The point to evaluate at must be a number.");
        }

        return Erfc(-x / Math.Sqrt(2.0)) / 2.0;
    }

    /// <summary>Evaluates the quantile function — the inverse of <see cref="Cdf(double)"/>.</summary>
    /// <param name="probability">The probability, strictly between zero and one.</param>
    /// <returns>The point at which the cumulative distribution reaches <paramref name="probability"/>.</returns>
    /// <remarks>
    /// Inverted numerically against <see cref="Cdf(double)"/> by bisection, rather than through a
    /// published rational approximation. Both are accurate; only one of them can be silently
    /// wrong because a coefficient was mistyped. Bisection on a monotone function is also
    /// self-evidently convergent, and its accuracy is limited only by that of the CDF it
    /// brackets against — around one part in 10^15 for the quantiles this library asks for. It
    /// costs a few hundred CDF evaluations, which is nothing beside the run whose results it is
    /// summarizing.
    /// </remarks>
    /// <exception cref="ArgumentOutOfRangeException">
    /// <paramref name="probability"/> is not strictly between zero and one, or is NaN.
    /// </exception>
    public static double InverseCdf(double probability)
    {
        if (!(probability > 0 && probability < 1))
        {
            throw new ArgumentOutOfRangeException(
                nameof(probability),
                probability,
                "A quantile is defined only strictly between zero and one."
            );
        }

        // The median is exact, and bisection would only ever approach it. Returning the
        // algebraic value keeps the function odd about the point a reader will check first.
        if (probability == 0.5)
        {
            return 0.0;
        }

        // Every probability a double can hold lies inside this bracket: Phi(-38.5) is already
        // below the smallest subnormal, and Phi(8.3) has rounded to one.
        var lower = -40.0;
        var upper = 40.0;

        for (var iteration = 0; iteration < 200 && upper - lower > 1e-16 * Math.Max(1.0, Math.Abs(lower)); iteration++)
        {
            var middle = (lower + upper) / 2.0;

            if (Cdf(middle) < probability)
            {
                lower = middle;
            }
            else
            {
                upper = middle;
            }
        }

        return (lower + upper) / 2.0;
    }

    /// <summary>Evaluates the complementary error function.</summary>
    /// <param name="x">The point to evaluate at. Infinities saturate.</param>
    /// <returns>The value of <c>erfc(x)</c>.</returns>
    public static double Erfc(double x)
    {
        if (double.IsNaN(x))
        {
            return double.NaN;
        }

        if (double.IsNegativeInfinity(x))
        {
            return 2.0;
        }

        if (double.IsPositiveInfinity(x))
        {
            return 0.0;
        }

        var magnitude = Math.Abs(x);
        var upperTail = magnitude < TailThreshold ? 1.0 - Erf(magnitude) : TailByContinuedFraction(magnitude);

        // erfc is symmetric about one: erfc(-x) = 2 - erfc(x). Evaluating the non-negative half
        // and reflecting keeps the tail computed where it has full relative accuracy.
        return x < 0 ? 2.0 - upperTail : upperTail;
    }

    /// <summary>
    /// Evaluates <c>erf</c> near the origin by its all-positive confluent series.
    /// </summary>
    /// <remarks>
    /// The familiar alternating Maclaurin series is mathematically identical and numerically
    /// worse: its terms grow to roughly <c>e^(x^2)</c> before cancelling, so it loses accuracy
    /// exactly where it is being used. This form has no subtraction in it at all.
    /// </remarks>
    private static double Erf(double x)
    {
        var squared = x * x;
        var term = 1.0;
        var sum = 1.0;

        for (var k = 1; k < MaximumIterations; k++)
        {
            term *= 2.0 * squared / ((2.0 * k) + 1.0);
            sum += term;

            if (term <= Math.Abs(sum) * RelativeTolerance)
            {
                break;
            }
        }

        return TwoOverSqrtPi * x * Math.Exp(-squared) * sum;
    }

    /// <summary>
    /// Evaluates <c>erfc</c> in the tail by its continued fraction, using the modified Lentz
    /// algorithm.
    /// </summary>
    /// <remarks>
    /// The fraction is <c>erfc(x) = exp(-x^2)/sqrt(pi) * 1/(x + (1/2)/(x + 1/(x + (3/2)/(x +
    /// ...))))</c>, whose partial numerators are <c>(n - 1) / 2</c> from the second term onwards.
    /// It computes the small tail value directly rather than as <c>1 - erf(x)</c>, which would
    /// have no significant digits left by the time <c>erf</c> reached 0.9999.
    /// </remarks>
    private static double TailByContinuedFraction(double x)
    {
        var f = Tiny;
        var c = f;
        var d = 0.0;

        for (var n = 1; n < MaximumIterations; n++)
        {
            var a = n == 1 ? 1.0 : (n - 1) / 2.0;

            d = x + (a * d);
            if (d == 0)
            {
                d = Tiny;
            }

            c = x + (a / c);
            if (c == 0)
            {
                c = Tiny;
            }

            d = 1.0 / d;

            var delta = c * d;
            f *= delta;

            if (Math.Abs(delta - 1.0) < RelativeTolerance)
            {
                break;
            }
        }

        return Math.Exp(-x * x) * OneOverSqrtPi * f;
    }
}

/// <summary>
/// The chi-squared distribution with one degree of freedom.
/// </summary>
/// <remarks>
/// Only the upper tail is needed, and with one degree of freedom it has a closed form in the
/// complementary error function: <c>P(X &gt; x) = erfc(sqrt(x / 2))</c>. Feeding the published
/// critical points back through it returns the levels they are tabulated at, which is how the
/// tests pin it.
/// </remarks>
internal static class ChiSquared
{
    /// <summary>Evaluates the upper-tail probability at one degree of freedom.</summary>
    /// <param name="statistic">The test statistic. Must be finite and not negative.</param>
    /// <returns>The probability of a statistic at least this large under the null hypothesis.</returns>
    /// <exception cref="ArgumentOutOfRangeException">
    /// <paramref name="statistic"/> is negative, infinite, or NaN.
    /// </exception>
    public static double UpperTailOneDegreeOfFreedom(double statistic)
    {
        if (!double.IsFinite(statistic) || statistic < 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(statistic),
                statistic,
                "A chi-squared statistic must be a finite, non-negative number."
            );
        }

        return StandardNormal.Erfc(Math.Sqrt(statistic / 2.0));
    }
}

/// <summary>
/// The exact conditional test on a set of discordant pairs.
/// </summary>
/// <remarks>
/// <para>
/// Conditional on the number of discordant pairs, the count favouring one direction is binomial
/// with probability one half under the null hypothesis. This is the exact form of McNemar's
/// test, and it is the form to use when the discordant count is small — which, for an evaluation
/// suite comparing two variants, it usually is.
/// </para>
/// <para>
/// The terms are accumulated relative to the mode of the distribution rather than absolutely.
/// Computing <c>C(n, k) / 2^n</c> directly overflows above n = 1029 and underflows below
/// 2^-1074; taking every term as a ratio to the central one keeps the whole calculation inside a
/// narrow range whatever n is, and terms far enough out to underflow contribute nothing anyway.
/// </para>
/// </remarks>
internal static class SignTest
{
    /// <summary>Evaluates the exact two-sided probability for a pair of discordant counts.</summary>
    /// <param name="b">Pairs favouring one direction.</param>
    /// <param name="c">Pairs favouring the other.</param>
    /// <returns>
    /// Twice the probability of an outcome at least as lopsided as the smaller count, capped at
    /// one.
    /// </returns>
    /// <exception cref="ArgumentOutOfRangeException">
    /// Either count is negative, or both are zero — with no discordant pairs there is no
    /// conditional distribution to evaluate.
    /// </exception>
    public static double TwoSidedExactPValue(int b, int c)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(b);
        ArgumentOutOfRangeException.ThrowIfNegative(c);

        var trials = (long)b + c;

        if (trials == 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(b),
                "With no discordant pairs there is no conditional distribution to evaluate."
            );
        }

        var smaller = Math.Min(b, c);
        var mode = trials / 2;

        // Every term is carried as a ratio to the central one, which is therefore exactly 1.
        // The smaller count never exceeds the mode, so only the terms at or below the mode can
        // fall inside the lower tail.
        var total = 1.0;
        var lowerTail = mode <= smaller ? 1.0 : 0.0;

        var ratio = 1.0;
        for (var i = mode; i > 0; i--)
        {
            ratio *= (double)i / (trials - i + 1);

            if (ratio == 0)
            {
                break;
            }

            total += ratio;

            if (i - 1 <= smaller)
            {
                lowerTail += ratio;
            }
        }

        ratio = 1.0;
        for (var i = mode; i < trials; i++)
        {
            ratio *= (double)(trials - i) / (i + 1);

            if (ratio == 0)
            {
                break;
            }

            total += ratio;
        }

        // Doubling the one-sided tail is the conventional two-sided rule for a symmetric
        // distribution, and it can exceed one for a nearly balanced table — 1 is the cap, not a
        // number the computation produced.
        return Math.Min(1.0, 2.0 * (lowerTail / total));
    }
}
