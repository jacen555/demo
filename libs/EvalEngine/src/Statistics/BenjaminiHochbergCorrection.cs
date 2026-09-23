using Forge.EvalEngine.Abstractions;

namespace Forge.EvalEngine.Statistics;

/// <summary>
/// Benjamini-Hochberg false-discovery-rate correction for a suite's family of p-values.
/// </summary>
/// <remarks>
/// <para>
/// <b>This choice is a deliberate design decision, not settled convention, and should be read as
/// one.</b> The pairing and the interval method elsewhere in this library are settled: the
/// literature is unambiguous that an unpaired test and a Wald interval are wrong here. This is
/// different. There is no established practice for multiple-comparison correction in language
/// model evaluation — the honest finding is that the field mostly does not address the problem
/// at all — so what follows is this harness's reasoning rather than an inherited norm, and a
/// future reader is entitled to disagree with it knowingly.
/// </para>
/// <para>
/// <b>The reasoning.</b> A regression suite of a hundred and fifty scenarios tested at the 5%
/// level will, with no real regression anywhere, flag around seven of them by chance. A signal
/// that cries wolf seven times per run is one people learn to ignore, so some correction is
/// needed. Bonferroni controls the family-wise error rate, which at that width means testing
/// each scenario at 0.00033 — so conservative that a genuine regression in one scenario is
/// suppressed, and the suite becomes unable to fail. Benjamini-Hochberg controls the expected
/// <i>proportion</i> of false discoveries among the flagged scenarios instead, which keeps the
/// power to see a single real regression while still bounding the noise. For a pull-request
/// signal, where the cost of a missed regression is higher than the cost of one spurious flag
/// among several real ones, that is the better trade — but it is a trade.
/// </para>
/// <para>
/// Benjamini, Y. &amp; Hochberg, Y. (1995), "Controlling the False Discovery Rate: A Practical
/// and Powerful Approach to Multiple Testing", Journal of the Royal Statistical Society Series B
/// 57(1):289-300. The procedure assumes the tests are independent or positively dependent; if
/// scenarios in a suite were strongly negatively correlated the guarantee would need the
/// Benjamini-Yekutieli variant, which is not implemented here.
/// </para>
/// <para>
/// <b>What is returned are adjusted p-values, not a reject/accept decision.</b> Each is the
/// smallest false-discovery rate at which its hypothesis would be rejected, computed by the
/// step-up procedure with a running minimum from the largest p-value downwards. That running
/// minimum is load-bearing: without it the raw scaling <c>p * m / i</c> can hand a smaller
/// p-value a larger adjusted value, so a scenario with stronger evidence would be reported as
/// weaker than one with less.
/// </para>
/// </remarks>
public sealed class BenjaminiHochbergCorrection : IMultipleComparisonCorrection
{
    /// <summary>Gets a shared instance. The correction holds no state.</summary>
    public static BenjaminiHochbergCorrection Instance { get; } = new();

    /// <inheritdoc/>
    public string Name => "benjamini-hochberg";

    /// <inheritdoc/>
    /// <exception cref="ArgumentNullException"><paramref name="pValues"/> is null.</exception>
    /// <exception cref="ArgumentException">
    /// A value is not a probability — negative, above one, or not a number. An "adjusted p-value"
    /// computed from one of those would be meaningless rather than merely imprecise.
    /// </exception>
    public IReadOnlyList<double> Adjust(IReadOnlyList<double> pValues)
    {
        ArgumentNullException.ThrowIfNull(pValues);

        var count = pValues.Count;

        if (count == 0)
        {
            return [];
        }

        var order = new int[count];

        for (var i = 0; i < count; i++)
        {
            var pValue = pValues[i];

            if (!double.IsFinite(pValue) || pValue < 0 || pValue > 1)
            {
                throw new ArgumentException(
                    $"The value at index {i} is not a probability. A family of p-values cannot be adjusted when one "
                        + "of them is negative, above one, or not a number.",
                    nameof(pValues)
                );
            }

            order[i] = i;
        }

        Array.Sort(order, (left, right) => pValues[left].CompareTo(pValues[right]));

        var adjusted = new double[count];
        var running = 1.0;

        // The step-up sweep runs from the largest p-value down. The running minimum is what
        // makes the result monotone: the raw scaling p * m / i is not, so without it a scenario
        // with stronger evidence could be handed a larger adjusted value than one with weaker
        // evidence. Ties fall out of this correctly — two equal p-values at adjacent ranks
        // always receive the same adjusted value — so the sort does not need to be stable.
        for (var rank = count; rank >= 1; rank--)
        {
            var index = order[rank - 1];

            running = Math.Min(running, pValues[index] * count / rank);
            adjusted[index] = Math.Min(1.0, running);
        }

        return adjusted;
    }
}
