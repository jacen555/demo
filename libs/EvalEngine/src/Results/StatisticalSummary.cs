namespace Forge.EvalEngine.Results;

/// <summary>
/// The method used to compute a confidence interval for a proportion.
/// </summary>
/// <remarks>
/// <para>
/// Both options here are deliberate, and the option that is <b>absent</b> is the point: the
/// normal-approximation (Wald) interval is not offered. Wald misbehaves badly at the small
/// repetition counts this harness runs at and at proportions near zero or one — exactly the
/// region an evaluation suite lives in — producing intervals that fall outside <c>[0, 1]</c> and
/// that have far less than their nominal coverage.
/// </para>
/// <para>This is settled. Do not reopen it by adding Wald.</para>
/// </remarks>
public enum IntervalMethod
{
    /// <summary>
    /// The Wilson score interval. The default choice: well-behaved at small n and at extreme
    /// proportions.
    /// </summary>
    Wilson,

    /// <summary>
    /// The Agresti-Coull interval. Slightly more conservative than Wilson and simpler to explain;
    /// acceptable where a reader finds it easier to follow.
    /// </summary>
    AgrestiCoull,
}

/// <summary>
/// The test used to judge whether a difference between a baseline and a candidate is real.
/// </summary>
/// <remarks>
/// <para>
/// <b>The comparison is paired by construction.</b> The same scenarios are run against both
/// variants with the same seeds, so each scenario contributes a matched pair of observations. An
/// unpaired two-proportion z-test discards that pairing and is a documented footgun here: it
/// systematically understates the evidence and will miss real regressions.
/// </para>
/// <para>This is settled. The only admissible tests are the paired ones below.</para>
/// </remarks>
public enum SignificanceTestKind
{
    /// <summary>
    /// McNemar's test on the discordant pairs. The default for binary pass/fail outcomes.
    /// </summary>
    McNemar,

    /// <summary>
    /// A paired bootstrap over scenarios. Use when the per-scenario statistic is not binary — for
    /// example a mean over repetitions.
    /// </summary>
    PairedBootstrap,
}

/// <summary>
/// Whether a comparison was judged significant.
/// </summary>
/// <remarks>
/// <see cref="NotComputed"/> is the honest default and the only value this library produces until
/// the statistics stage is implemented. Reporting a raw delta and saying the significance is not
/// computed is better than reporting a number the harness did not actually calculate.
/// </remarks>
public enum SignificanceVerdict
{
    /// <summary>No test was run. The delta is reported raw.</summary>
    NotComputed,

    /// <summary>A test was run and the difference was not significant.</summary>
    NotSignificant,

    /// <summary>A test was run and the difference was significant.</summary>
    Significant,
}

/// <summary>
/// A confidence interval for a proportion.
/// </summary>
public sealed record ConfidenceInterval
{
    /// <summary>Gets the lower bound.</summary>
    public required double Lower { get; init; }

    /// <summary>Gets the upper bound.</summary>
    public required double Upper { get; init; }

    /// <summary>Gets the method used. See <see cref="IntervalMethod"/> for why Wald is not here.</summary>
    public required IntervalMethod Method { get; init; }
}

/// <summary>
/// How a scenario's result compares against the same scenario in a baseline artifact.
/// </summary>
public sealed record ComparisonSummary
{
    /// <summary>
    /// Gets the raw difference between the candidate and the baseline point estimates. Always
    /// populated: this is the number the harness can always state honestly.
    /// </summary>
    public required double EffectSize { get; init; }

    /// <summary>Gets the unadjusted p-value, or null when no test was run.</summary>
    public double? PValue { get; init; }

    /// <summary>
    /// Gets the p-value after correcting for multiple comparisons across the suite, or null when
    /// no correction was applied.
    /// </summary>
    /// <remarks>
    /// The correction is <b>Benjamini-Hochberg FDR</b>, not Bonferroni. Unlike the pairing and
    /// interval choices above, this one is a <i>deliberate design choice rather than settled
    /// convention</i>: a suite runs many scenarios at once, and Bonferroni's family-wise error
    /// control is so conservative at that width that genuine regressions are suppressed. Trading
    /// a controlled false-discovery rate for that sensitivity is the right trade for a
    /// pull-request signal, but it is a trade, and a future reader is entitled to disagree with
    /// it knowingly rather than assume it was inherited.
    /// </remarks>
    public double? AdjustedPValue { get; init; }

    /// <summary>Gets the test used, or null when no test was run.</summary>
    public SignificanceTestKind? Test { get; init; }

    /// <summary>Gets whether the difference was judged significant.</summary>
    public SignificanceVerdict Significant { get; init; } = SignificanceVerdict.NotComputed;
}

/// <summary>
/// The aggregate across a scenario's repetitions.
/// </summary>
/// <remarks>
/// <para>
/// The full shape is carried from the outset so that the artifact schema does not change when the
/// statistics stage lands. <see cref="Interval"/> and <see cref="Comparison"/> are optional and
/// serialize as <b>absent</b> when unset — never as nulls — so a committed baseline does not
/// churn when they begin to be populated.
/// </para>
/// <para>
/// Until that stage exists, this library reports <see cref="N"/>,
/// <see cref="PointEstimate"/>, and <see cref="Dispersion"/> only.
/// </para>
/// </remarks>
public sealed record StatisticalSummary
{
    /// <summary>Gets the number of repetitions the estimate is drawn from.</summary>
    public required int N { get; init; }

    /// <summary>
    /// Gets the central estimate over the repetitions — for a binary pass/fail scenario, the pass
    /// rate.
    /// </summary>
    public required double PointEstimate { get; init; }

    /// <summary>Gets the spread of the repetitions around <see cref="PointEstimate"/>.</summary>
    public required double Dispersion { get; init; }

    /// <summary>Gets the confidence interval, or null when none was computed.</summary>
    public ConfidenceInterval? Interval { get; init; }

    /// <summary>Gets the comparison against a baseline, or null when there was no baseline.</summary>
    public ComparisonSummary? Comparison { get; init; }
}
