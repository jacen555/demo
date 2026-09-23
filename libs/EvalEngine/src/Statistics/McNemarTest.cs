using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Results;

namespace Forge.EvalEngine.Statistics;

/// <summary>
/// McNemar's test for a paired binary comparison.
/// </summary>
/// <remarks>
/// <para>
/// <b>The comparison is paired by construction</b> — the same scenarios, driven with the same
/// seeds, under two variants — and this test uses that. Only the <i>discordant</i> pairs carry
/// information about a change: a scenario that passed under both variants, or failed under both,
/// says nothing about which variant is better. Conditioning on the discordant pairs removes the
/// between-scenario variance that an unpaired two-proportion z-test would have to absorb, which
/// is why the unpaired test misses real regressions here.
/// </para>
/// <para>
/// McNemar, Q. (1947), "Note on the sampling error of the difference between correlated
/// proportions or percentages", Psychometrika 12(2):153-157. The continuity correction is
/// Edwards, A.L. (1948), "Note on the 'correction for continuity' in testing the significance of
/// the difference between correlated proportions", Psychometrika 13(3):185-187.
/// </para>
/// <para>
/// <b>Three cases are handled explicitly, because each is a way to emit a number that is not a
/// number:</b>
/// </para>
/// <list type="bullet">
/// <item><description>
/// <b>No discordant pairs at all.</b> The statistic is <c>0 / 0</c>. Every scenario agreed under
/// both variants, so there is no evidence about the direction of a change — and the honest
/// report is <see cref="SignificanceVerdict.NotComputed"/> with no p-value, not a NaN flowing
/// downstream into a merge decision. The raw effect size, which really is zero, is still stated.
/// </description></item>
/// <item><description>
/// <b>Few discordant pairs.</b> Below <see cref="ExactThreshold"/> the chi-squared approximation
/// is not trustworthy, so the exact conditional binomial test is used instead. This is the
/// conventional threshold for the switch, and an evaluation suite comparing two nearby variants
/// sits below it far more often than above.
/// </description></item>
/// <item><description>
/// <b>Equal counts in both directions.</b> Edwards' correction subtracts one from the absolute
/// difference, so a perfectly balanced table would yield a <i>positive</i> statistic of
/// <c>1 / n</c> and a p-value below one — the correction making the result look more significant
/// than no difference at all, which is the opposite of what a conservative correction is for.
/// The corrected difference is floored at zero.
/// </description></item>
/// </list>
/// </remarks>
public sealed class McNemarTest : ISignificanceTest
{
    /// <summary>
    /// The discordant-pair count below which the exact conditional test is used instead of the
    /// chi-squared approximation.
    /// </summary>
    public const int ExactThreshold = 25;

    /// <summary>Initializes a new instance judging at the conventional 5% level.</summary>
    public McNemarTest()
        : this(0.05) { }

    /// <summary>Initializes a new instance of the <see cref="McNemarTest"/> class.</summary>
    /// <param name="significanceLevel">
    /// The level below which a p-value is called significant. Strictly between zero and one.
    /// </param>
    /// <exception cref="ArgumentOutOfRangeException">
    /// <paramref name="significanceLevel"/> is not strictly between zero and one.
    /// </exception>
    public McNemarTest(double significanceLevel)
    {
        if (!(significanceLevel > 0 && significanceLevel < 1))
        {
            throw new ArgumentOutOfRangeException(
                nameof(significanceLevel),
                significanceLevel,
                "A significance level must be strictly between zero and one."
            );
        }

        SignificanceLevel = significanceLevel;
    }

    /// <inheritdoc/>
    public SignificanceTestKind Kind => SignificanceTestKind.McNemar;

    /// <summary>Gets the level below which a p-value is reported as significant.</summary>
    public double SignificanceLevel { get; }

    /// <inheritdoc/>
    /// <exception cref="ArgumentNullException"><paramref name="observations"/> is null.</exception>
    /// <exception cref="ArgumentException">
    /// The observations are not binary. McNemar is defined on pass/fail outcomes; a mean over
    /// repetitions needs <see cref="SignificanceTestKind.PairedBootstrap"/>. Choosing the wrong
    /// test is a defect in the caller rather than a property of the data, so it fails loudly
    /// instead of returning a number that does not mean what it says.
    /// </exception>
    /// <exception cref="OperationCanceledException">
    /// <paramref name="cancellationToken"/> was cancelled.
    /// </exception>
    public ComparisonSummary Compare(PairedObservations observations, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(observations);
        cancellationToken.ThrowIfCancellationRequested();

        if (!observations.IsBinary)
        {
            throw new ArgumentException(
                "McNemar's test is defined on paired binary outcomes. A per-scenario statistic that is not zero or "
                    + "one needs a paired bootstrap; running it through here would produce a number that does not "
                    + "mean what it says.",
                nameof(observations)
            );
        }

        var regressed = 0;
        var fixedUp = 0;
        var total = 0.0;

        foreach (var pair in observations.Pairs)
        {
            total += pair.Difference;

            if (pair.BaselineValue > pair.CandidateValue)
            {
                regressed++;
            }
            else if (pair.CandidateValue > pair.BaselineValue)
            {
                fixedUp++;
            }
        }

        // The raw difference in pass rate across every scenario, concordant pairs included.
        // This is the one figure that is always honest, so it is always reported — even when no
        // test could be run.
        var effectSize = total / observations.Count;
        var discordant = regressed + fixedUp;

        if (discordant == 0)
        {
            return new ComparisonSummary { EffectSize = effectSize };
        }

        var pValue =
            discordant < ExactThreshold
                ? SignTest.TwoSidedExactPValue(regressed, fixedUp)
                : ChiSquared.UpperTailOneDegreeOfFreedom(CorrectedStatistic(regressed, fixedUp, discordant));

        return new ComparisonSummary
        {
            EffectSize = effectSize,
            PValue = pValue,
            Test = SignificanceTestKind.McNemar,
            Significant =
                pValue <= SignificanceLevel ? SignificanceVerdict.Significant : SignificanceVerdict.NotSignificant,
        };
    }

    /// <summary>Computes the continuity-corrected chi-squared statistic.</summary>
    /// <remarks>
    /// The correction is floored at zero. Edwards' form subtracts one from the absolute
    /// difference before squaring, so a table with equal counts in both directions — the null
    /// hypothesis holding exactly — would otherwise yield a positive statistic of
    /// <c>1 / discordant</c> and a p-value below one. A correction that makes a perfectly
    /// balanced result look significant is doing the opposite of its job.
    /// </remarks>
    private static double CorrectedStatistic(int regressed, int fixedUp, int discordant)
    {
        var difference = Math.Max(0.0, Math.Abs(regressed - fixedUp) - 1.0);

        return difference * difference / discordant;
    }
}
