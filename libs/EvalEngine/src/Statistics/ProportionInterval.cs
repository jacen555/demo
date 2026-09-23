using Forge.EvalEngine.Results;

namespace Forge.EvalEngine.Statistics;

/// <summary>
/// Confidence intervals for a proportion.
/// </summary>
/// <remarks>
/// <para>
/// <b>The normal-approximation (Wald) interval is not offered, and that absence is the point.</b>
/// An evaluation suite runs three to ten repetitions at a pass rate that is usually near zero or
/// near one, which is precisely the regime in which Wald's coverage collapses: it produces bounds
/// outside <c>[0, 1]</c>, and at zero or complete success it degenerates to a zero-width
/// interval that claims certainty from a handful of runs. See Brown, L.D., Cai, T.T. &amp;
/// DasGupta, A. (2001), "Interval Estimation for a Binomial Proportion", Statistical Science
/// 16(2):101-133.
/// </para>
/// <para>
/// Both methods here are recommended in that literature for small samples. Neither is exact —
/// they are approximations with good average coverage, not guarantees — and both are reported
/// with the method stamped on them so a reader knows which one produced the number.
/// </para>
/// </remarks>
public static class ProportionInterval
{
    /// <summary>The confidence level used when a caller does not state one.</summary>
    public const double DefaultConfidenceLevel = 0.95;

    /// <summary>Computes an interval by the named method.</summary>
    /// <param name="successes">The number of successes. Between zero and <paramref name="trials"/>.</param>
    /// <param name="trials">The number of trials. One or greater.</param>
    /// <param name="method">The method to use.</param>
    /// <param name="confidenceLevel">The two-sided confidence level, strictly between zero and one.</param>
    /// <returns>The interval, stamped with the method that produced it.</returns>
    /// <exception cref="ArgumentOutOfRangeException">
    /// The counts are impossible, the confidence level is not strictly between zero and one, or
    /// the method is not a declared <see cref="IntervalMethod"/>.
    /// </exception>
    public static ConfidenceInterval Compute(
        int successes,
        int trials,
        IntervalMethod method = IntervalMethod.Wilson,
        double confidenceLevel = DefaultConfidenceLevel
    ) =>
        method switch
        {
            IntervalMethod.Wilson => Wilson(successes, trials, confidenceLevel),
            IntervalMethod.AgrestiCoull => AgrestiCoull(successes, trials, confidenceLevel),
            _ => throw new ArgumentOutOfRangeException(nameof(method), method, "Unknown interval method."),
        };

    /// <summary>Computes a Wilson score interval.</summary>
    /// <param name="successes">The number of successes. Between zero and <paramref name="trials"/>.</param>
    /// <param name="trials">The number of trials. One or greater.</param>
    /// <param name="confidenceLevel">The two-sided confidence level, strictly between zero and one.</param>
    /// <returns>The interval.</returns>
    /// <remarks>
    /// <para>
    /// Wilson, E.B. (1927), "Probable Inference, the Law of Succession, and Statistical
    /// Inference", Journal of the American Statistical Association 22(158):209-212. The interval
    /// inverts the score test rather than the Wald test, which is why it stays inside
    /// <c>[0, 1]</c> and retains width at the boundary: at zero successes its lower bound is
    /// exactly zero and its upper bound is not.
    /// </para>
    /// <para>The default choice. Recommended over Wald at every sample size in Brown, Cai &amp;
    /// DasGupta (2001).</para>
    /// </remarks>
    /// <exception cref="ArgumentOutOfRangeException">
    /// The counts are impossible, or the confidence level is not strictly between zero and one.
    /// </exception>
    public static ConfidenceInterval Wilson(int successes, int trials, double confidenceLevel = DefaultConfidenceLevel)
    {
        var z = Validate(successes, trials, confidenceLevel);
        var n = (double)trials;
        var estimate = successes / n;
        var zSquared = z * z;
        var denominator = 1.0 + (zSquared / n);
        var centre = (estimate + (zSquared / (2.0 * n))) / denominator;
        var halfWidth = z / denominator * Math.Sqrt((estimate * (1.0 - estimate) / n) + (zSquared / (4.0 * n * n)));

        // At zero successes the lower bound is algebraically exactly zero, and at complete
        // success the upper bound is exactly one — the two terms cancel. Stating those instead of
        // hoping the subtraction cancels to the last bit makes the boundary a guarantee rather
        // than an accident of rounding, which matters because the boundary is where an eval
        // suite spends most of its time.
        return new ConfidenceInterval
        {
            Lower = successes == 0 ? 0.0 : Clamp(centre - halfWidth),
            Upper = successes == trials ? 1.0 : Clamp(centre + halfWidth),
            Method = IntervalMethod.Wilson,
        };
    }

    /// <summary>Computes an Agresti-Coull interval.</summary>
    /// <param name="successes">The number of successes. Between zero and <paramref name="trials"/>.</param>
    /// <param name="trials">The number of trials. One or greater.</param>
    /// <param name="confidenceLevel">The two-sided confidence level, strictly between zero and one.</param>
    /// <returns>The interval, clamped to <c>[0, 1]</c>.</returns>
    /// <remarks>
    /// Agresti, A. &amp; Coull, B.A. (1998), "Approximate Is Better than 'Exact' for Interval
    /// Estimation of Binomial Proportions", The American Statistician 52(2):119-126. It adds
    /// <c>z^2 / 2</c> notional successes and the same number of failures, then applies the normal
    /// approximation to the adjusted counts — at 95% confidence the familiar "add two successes
    /// and two failures" rule. Simpler to explain than Wilson and slightly more conservative;
    /// unlike Wilson its raw bounds can fall outside <c>[0, 1]</c> at extreme proportions, so
    /// they are clamped.
    /// </remarks>
    /// <exception cref="ArgumentOutOfRangeException">
    /// The counts are impossible, or the confidence level is not strictly between zero and one.
    /// </exception>
    public static ConfidenceInterval AgrestiCoull(
        int successes,
        int trials,
        double confidenceLevel = DefaultConfidenceLevel
    )
    {
        var z = Validate(successes, trials, confidenceLevel);
        var zSquared = z * z;
        var adjustedTrials = trials + zSquared;
        var adjustedEstimate = (successes + (zSquared / 2.0)) / adjustedTrials;
        var halfWidth = z * Math.Sqrt(adjustedEstimate * (1.0 - adjustedEstimate) / adjustedTrials);

        // Unlike Wilson, this method's raw bounds genuinely leave [0, 1] at extreme proportions,
        // so the clamp here is substantive rather than cosmetic.
        return new ConfidenceInterval
        {
            Lower = Clamp(adjustedEstimate - halfWidth),
            Upper = Clamp(adjustedEstimate + halfWidth),
            Method = IntervalMethod.AgrestiCoull,
        };
    }

    /// <summary>Confines a bound to the range a proportion can occupy.</summary>
    private static double Clamp(double bound) => Math.Clamp(bound, 0.0, 1.0);

    /// <summary>Checks the counts and the level, and returns the critical value they imply.</summary>
    /// <remarks>
    /// The quantile is taken from the <i>lower</i> tail and negated rather than read off the
    /// upper tail, because the upper-tail form cannot express a level close to one. At a
    /// confidence level one ulp below one, <c>(1 - level) / 2</c> is 5.55e-17 and
    /// <c>1 - 5.55e-17</c> rounds to exactly one — outside the open interval a quantile is
    /// defined on, so both interval methods threw on a level they are documented to accept. The
    /// standard normal is symmetric, so the two forms agree wherever both are representable and
    /// only this one survives the corner.
    /// </remarks>
    private static double Validate(int successes, int trials, double confidenceLevel)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(trials, 1);
        ArgumentOutOfRangeException.ThrowIfNegative(successes);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(successes, trials);

        if (!(confidenceLevel > 0 && confidenceLevel < 1))
        {
            throw new ArgumentOutOfRangeException(
                nameof(confidenceLevel),
                confidenceLevel,
                "A confidence level must be strictly between zero and one."
            );
        }

        return -StandardNormal.InverseCdf((1 - confidenceLevel) / 2);
    }
}
