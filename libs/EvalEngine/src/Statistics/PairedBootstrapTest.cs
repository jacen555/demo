using System.Numerics;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Results;

namespace Forge.EvalEngine.Statistics;

/// <summary>
/// A paired bootstrap over scenarios, for a per-scenario statistic that is not binary.
/// </summary>
/// <remarks>
/// <para>
/// <b>The resampling unit is the scenario, not the repetition.</b> That is what keeps the
/// comparison paired: each draw takes a scenario's baseline and candidate values together, so
/// the between-scenario variation that dominates an evaluation suite cancels rather than being
/// mistaken for a difference between the variants.
/// </para>
/// <para>
/// The p-value is the standard bootstrap hypothesis test: the resampled statistic is recentred
/// on the null, and the proportion of resamples at least as extreme as the observed statistic is
/// reported as <c>(1 + count) / (B + 1)</c>. See Davison, A.C. &amp; Hinkley, D.V. (1997),
/// <i>Bootstrap Methods and Their Application</i>, Cambridge University Press, section 4.4, and
/// Efron, B. &amp; Tibshirani, R.J. (1993), <i>An Introduction to the Bootstrap</i>, chapter 16.
/// The <c>1 +</c> in both places is deliberate: without it a p-value of exactly zero is
/// reportable, which claims a precision no finite number of resamples can supply.
/// </para>
/// <para>
/// <b>Its resolution is bounded below by <c>1 / (B + 1)</c>.</b> At the default resample count
/// that is 0.0001. A smaller figure is not available from this procedure and is never reported.
/// </para>
/// <para>
/// <b>Determinism.</b> Resampling needs randomness, so the seed is injected and stamped on
/// <see cref="Seed"/> rather than drawn from an ambient source; two instances built with the
/// same seed produce the same p-value, and an instance may be reused without carrying state
/// between calls. The generator is SplitMix64, matching
/// <see cref="DeterministicSeedSource"/> — the determinism pattern this domain already uses.
/// There is no room in the committed artifact's shape for the seed, so a composition root that
/// wants it reproducible records <see cref="Seed"/> and <see cref="Resamples"/> in
/// <see cref="EvaluationEnvironment.HarnessConfig"/>.
/// </para>
/// <para>
/// <b>Fewer than two scenarios is refused.</b> With a single scenario every resample is that
/// same scenario, so the resampled statistic never moves off the observed one, and the formula
/// above returns <c>1 / (B + 1)</c> — an apparently overwhelming result manufactured from one
/// observation. Nothing is reported instead.
/// </para>
/// <para>
/// <b>The p-value is bounded below by what the scenario count can support.</b> Every reported
/// p-value is at least <c>2^(1-n)</c>, the smallest value an exact two-sided sign-flip test on
/// <c>n</c> paired differences can return: the observed sign assignment and its complete
/// negation are always at least as extreme as the observed effect, so <c>2 / 2^n</c> is the
/// floor. At or below <see cref="ExactScenarios"/> that bound is reached by computing the exact
/// test itself; above it the bound guards the bootstrap.
/// </para>
/// <para>
/// <b>Known limitation.</b> Between <see cref="ExactScenarios"/> and roughly thirty scenarios
/// the percentile bootstrap remains somewhat liberal — measured at about 8% against a nominal 5%
/// under a true null, settling to nominal by thirty. That is the documented finite-sample
/// behaviour of the percentile method rather than the collapse this class guards against, and it
/// is stated so a reader can judge a borderline p-value in that range for themselves.
/// </para>
/// </remarks>
public sealed class PairedBootstrapTest : ISignificanceTest
{
    /// <summary>The resample count used when a caller does not state one.</summary>
    /// <remarks>
    /// Nine thousand nine hundred and ninety-nine, so that <c>B + 1</c> is a round ten thousand
    /// and the smallest reportable p-value is exactly 0.0001.
    /// </remarks>
    public const int DefaultResamples = 9999;

    /// <summary>The smallest number of scenarios a bootstrap can resample from.</summary>
    public const int MinimumScenarios = 2;

    /// <summary>
    /// The scenario count at or below which the exact sign-flip test replaces the bootstrap.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>The percentile bootstrap is not calibrated at small n, and no correction to it is.</b>
    /// Its null is recentred on the observed differences, so a set whose differences all share a
    /// sign produces resamples that all share it too: the null never reaches the observed effect
    /// and the procedure returns <c>1 / (B + 1)</c> <i>deterministically</i>, whatever the
    /// evidence. Measured against a true symmetric null at a nominal 5%, the uncorrected
    /// procedure rejects about 50% of the time at two scenarios, 30% at three, and 12-17% from
    /// four to eight. The exact test rejects at or below the nominal rate at every one of them,
    /// because it is exact.
    /// </para>
    /// <para>
    /// <b>Twenty, because that is what can be enumerated.</b> The exact test evaluates all
    /// <c>2^n</c> sign assignments, so its cost doubles per scenario; at twenty that is about a
    /// million constant-time steps, a few milliseconds, and bounded. Above it the enumeration
    /// stops being affordable while the bootstrap's asymptotics start to hold.
    /// </para>
    /// <para>
    /// <b>The threshold depends only on the scenario count, never on the values.</b> Choosing a
    /// test after looking at the data would inflate the error rate this constant exists to
    /// control.
    /// </para>
    /// </remarks>
    public const int ExactScenarios = 20;

    /// <summary>Initializes a new instance with the default resample count and 5% level.</summary>
    /// <param name="seed">The seed the resampling is driven with.</param>
    public PairedBootstrapTest(long seed)
        : this(seed, DefaultResamples, 0.05) { }

    /// <summary>Initializes a new instance of the <see cref="PairedBootstrapTest"/> class.</summary>
    /// <param name="seed">The seed the resampling is driven with.</param>
    /// <param name="resamples">The number of bootstrap resamples. One or greater.</param>
    /// <param name="significanceLevel">
    /// The level below which a p-value is called significant. Strictly between zero and one.
    /// </param>
    /// <exception cref="ArgumentOutOfRangeException">
    /// <paramref name="resamples"/> is below one, or <paramref name="significanceLevel"/> is not
    /// strictly between zero and one.
    /// </exception>
    public PairedBootstrapTest(long seed, int resamples, double significanceLevel)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(resamples, 1);

        if (!(significanceLevel > 0 && significanceLevel < 1))
        {
            throw new ArgumentOutOfRangeException(
                nameof(significanceLevel),
                significanceLevel,
                "A significance level must be strictly between zero and one."
            );
        }

        Seed = seed;
        Resamples = resamples;
        SignificanceLevel = significanceLevel;
    }

    /// <inheritdoc/>
    public SignificanceTestKind Kind => SignificanceTestKind.PairedBootstrap;

    /// <summary>Gets the seed the resampling is driven with, so a run can be reproduced.</summary>
    public long Seed { get; }

    /// <summary>Gets the number of resamples drawn.</summary>
    public int Resamples { get; }

    /// <summary>Gets the level below which a p-value is reported as significant.</summary>
    public double SignificanceLevel { get; }

    /// <inheritdoc/>
    /// <exception cref="ArgumentNullException"><paramref name="observations"/> is null.</exception>
    /// <exception cref="ArgumentException">
    /// A scenario's baseline and candidate values are each finite but their difference is not.
    /// An infinite effect size admits no p-value, and left unchecked it produces a falsely
    /// significant one rather than failing.
    /// </exception>
    /// <exception cref="OperationCanceledException">
    /// <paramref name="cancellationToken"/> was cancelled. A large bootstrap is the one
    /// computation in this library long enough to be worth abandoning.
    /// </exception>
    public ComparisonSummary Compare(PairedObservations observations, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(observations);
        cancellationToken.ThrowIfCancellationRequested();

        var pairs = observations.Pairs;
        var count = pairs.Count;
        var differences = new double[count];
        var observed = 0.0;

        for (var i = 0; i < count; i++)
        {
            var difference = pairs[i].Difference;

            // Both values are validated finite, but their difference need not be: -MaxValue
            // against +MaxValue overflows. An infinite effect would make every |t* - t|
            // comparison below NaN, NaN is not greater than or equal to anything, so no resample
            // would count as extreme and the floor would be reported as a significant result —
            // a verdict manufactured out of an arithmetic overflow.
            if (!double.IsFinite(difference))
            {
                throw new ArgumentException(
                    $"Scenario '{pairs[i].ScenarioId}' has a difference that is not finite. Its baseline and "
                        + "candidate values are each finite but their difference overflows, so there is no effect "
                        + "size or p-value to report for it.",
                    nameof(observations)
                );
            }

            differences[i] = difference;

            // Accumulated incrementally rather than summed and then divided. A total of finite
            // values can overflow even when every value is finite, and an infinite total becomes
            // an infinite effect size without anything objecting. A running mean never leaves the
            // range of the values it is drawn from, so it cannot overflow when they do not.
            observed += (difference - observed) / (i + 1);
        }

        if (count < MinimumScenarios)
        {
            // One scenario resamples to itself every time, so the recentred statistic never
            // moves and the formula below would report 1 / (B + 1) — an apparently overwhelming
            // result drawn from a single observation. The raw difference is still real and is
            // still stated; the p-value is not.
            return new ComparisonSummary { EffectSize = observed };
        }

        // Below the threshold the bootstrap is not merely imprecise, it is invalid — see
        // ExactScenarios — so the exact sign-flip test is computed instead of it, not as a
        // correction to it.
        var pValue =
            count <= ExactScenarios
                ? ExactSignFlipPValue(differences, cancellationToken)
                : BootstrapPValue(differences, observed, cancellationToken);

        return new ComparisonSummary
        {
            EffectSize = observed,
            PValue = pValue,
            Test = SignificanceTestKind.PairedBootstrap,
            Significant =
                pValue <= SignificanceLevel ? SignificanceVerdict.Significant : SignificanceVerdict.NotSignificant,
        };
    }

    /// <summary>Draws the recentred bootstrap p-value.</summary>
    private double BootstrapPValue(double[] differences, double observed, CancellationToken cancellationToken)
    {
        var count = differences.Length;
        var random = new SplitMix64(Seed);
        var magnitude = Math.Abs(observed);
        var extreme = 0;

        for (var resample = 0; resample < Resamples; resample++)
        {
            // Checked every 256 draws rather than every one: a token read per resample would
            // cost more than the resample, and a bootstrap abandoned 255 draws late is still
            // abandoned promptly.
            if ((resample & 0xFF) == 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
            }

            var resampled = 0.0;

            for (var draw = 0; draw < count; draw++)
            {
                // Accumulated as a running mean for the same reason the observed statistic is:
                // a total of finite values can overflow where their mean cannot.
                resampled += (differences[random.NextIndex(count)] - resampled) / (draw + 1);
            }

            // Recentred on the null: how often does a resample move as far from the observed
            // statistic as the observed statistic sits from zero?
            if (Math.Abs(resampled - observed) >= magnitude)
            {
                extreme++;
            }
        }

        // Bounded below by what this many paired observations can support at all. Above
        // ExactScenarios the bound is slack at the default resample count, but it stays correct
        // for a caller who raises B far enough for the Monte Carlo floor to drop beneath it.
        return Math.Max((1.0 + extreme) / (Resamples + 1.0), RandomizationFloor(count));
    }

    /// <summary>
    /// Evaluates the exact two-sided sign-flip probability by enumerating every assignment.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Under the symmetric no-effect null each paired difference is as likely to fall negative as
    /// positive, so the <c>2^n</c> sign assignments of the observed magnitudes are equally likely
    /// and the exact two-sided p-value is the proportion of them whose mean is at least as far
    /// from zero as the observed mean. This is Fisher's randomization test — Fisher, R.A. (1935),
    /// <i>The Design of Experiments</i>, chapter III — and it is exact rather than asymptotic, so
    /// its size never exceeds the nominal level however few scenarios there are.
    /// </para>
    /// <para>
    /// <b>Scaled before summing.</b> Every difference is divided by the largest magnitude among
    /// them, so each lies in <c>[-1, 1]</c> and no partial sum can exceed <c>n</c>. The
    /// comparison is between two sums on the same scale, so dividing through by a positive
    /// constant leaves it unchanged — and it removes the overflow that summing finite but
    /// enormous differences would otherwise cause.
    /// </para>
    /// <para>
    /// <b>Enumerated in Gray-code order.</b> Consecutive assignments differ in exactly one sign,
    /// so the running sum updates in constant time and the sweep costs <c>2^n</c> additions
    /// rather than <c>n * 2^n</c>. At the threshold that is about a million additions, a few
    /// milliseconds, and it is bounded — it cannot grow with the suite.
    /// </para>
    /// </remarks>
    private static double ExactSignFlipPValue(double[] differences, CancellationToken cancellationToken)
    {
        var count = differences.Length;
        var largest = 0.0;

        foreach (var difference in differences)
        {
            largest = Math.Max(largest, Math.Abs(difference));
        }

        if (largest == 0)
        {
            // Every difference is exactly zero, which is the null holding exactly. Every sign
            // assignment ties with the observed one, so all of them are at least as extreme and
            // the p-value is one — the largest the procedure can report, which is the right
            // answer for no evidence of a difference at all.
            return 1.0;
        }

        var scaled = new double[count];
        var signs = new double[count];
        var running = 0.0;

        for (var i = 0; i < count; i++)
        {
            scaled[i] = differences[i] / largest;
            signs[i] = 1.0;
            running += scaled[i];
        }

        // The enumeration starts at the observed assignment, so the first sum is the observed
        // one, computed in the same order and therefore bit-for-bit identical to it.
        var target = Math.Abs(running);

        // The tolerance absorbs the drift of a sum updated 2^n times in place. Scaled values lie
        // in [-1, 1] and the sum in [-n, n], so after a million updates the accumulated error is
        // of order sqrt(2^20) * n * 2^-53 — about 5e-12, some two hundred times smaller than
        // this. Counting a near-tie as "at least as extreme" can only raise the p-value, which
        // is the conservative direction.
        var threshold = target - 1e-9;
        var total = 1L << count;
        var atLeastAsExtreme = Math.Abs(running) >= threshold ? 1L : 0L;

        for (var step = 1L; step < total; step++)
        {
            if ((step & 0xFFFF) == 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
            }

            // The bit that changes between consecutive Gray codes is the lowest set bit of the
            // step index. Flipping one sign moves the sum by twice that term.
            var bit = BitOperations.TrailingZeroCount(step);

            running -= 2.0 * signs[bit] * scaled[bit];
            signs[bit] = -signs[bit];

            if (Math.Abs(running) >= threshold)
            {
                atLeastAsExtreme++;
            }
        }

        return (double)atLeastAsExtreme / total;
    }

    /// <summary>
    /// The smallest two-sided p-value that <paramref name="count"/> paired differences can
    /// support, whatever those differences are.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Derivation.</b> Under the symmetric no-effect null a paired difference is as likely to
    /// fall negative as positive, so the <c>2^n</c> sign assignments of the observed magnitudes
    /// are equally likely. The observed assignment and its complete negation both produce a mean
    /// at least as extreme as the observed one, so an exact two-sided sign-flip test can never
    /// return less than <c>2 / 2^n = 2^(1-n)</c>. The bootstrap is an approximation to that
    /// randomization test — Efron, B. &amp; Tibshirani, R.J. (1993), <i>An Introduction to the
    /// Bootstrap</i>, chapter 15 — so a bootstrap p-value below the bound would be claiming more
    /// evidence than <c>n</c> observations can carry.
    /// </para>
    /// <para>
    /// This guards the bootstrap path only: at or below <see cref="ExactScenarios"/> the exact
    /// test is computed instead and attains the bound directly. At the default resample count
    /// the bound is slack above that threshold, but it stays correct for a caller who raises
    /// <see cref="Resamples"/> far enough for the Monte Carlo floor to drop beneath it. It can
    /// only raise a p-value, never lower one.
    /// </para>
    /// </remarks>
    private static double RandomizationFloor(int count) => Math.Pow(2.0, 1 - count);

    /// <summary>
    /// SplitMix64 — the same mixer <see cref="DeterministicSeedSource"/> uses, so this library
    /// has one notion of "deterministic pseudo-randomness" rather than two.
    /// </summary>
    /// <remarks>
    /// Its whole state is a counter, so the sequence is a pure function of the seed and the call
    /// index. It is not cryptographic and is not used as though it were; it is used because a
    /// resampling draw has to be reproducible from a number recorded in an artifact, which is
    /// the opposite of what a cryptographic generator offers.
    /// </remarks>
    private sealed class SplitMix64(long seed)
    {
        private ulong _state = unchecked((ulong)seed);

        /// <summary>Draws an index uniformly from a range.</summary>
        /// <remarks>
        /// The modulo introduces a bias of order <c>bound / 2^64</c>. For a suite of scenarios
        /// that is below one part in 10^15 — far smaller than the Monte Carlo error of the
        /// bootstrap it feeds — so it is stated rather than corrected.
        /// </remarks>
        public int NextIndex(int exclusiveBound) => (int)(Next() % (ulong)exclusiveBound);

        private ulong Next()
        {
            unchecked
            {
                _state += 0x9E3779B97F4A7C15UL;
                var mixed = _state;
                mixed = (mixed ^ (mixed >> 30)) * 0xBF58476D1CE4E5B9UL;
                mixed = (mixed ^ (mixed >> 27)) * 0x94D049BB133111EBUL;

                return mixed ^ (mixed >> 31);
            }
        }
    }
}
