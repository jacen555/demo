using Forge.EvalEngine.Results;

namespace Forge.EvalEngine.Abstractions;

/// <summary>
/// One scenario's matched pair of observations: the same scenario, the same seed, two variants.
/// </summary>
/// <remarks>
/// Both values live on <b>one</b> record on purpose. Two parallel lists can drift in length, be
/// reordered independently, or be filled from different scenarios entirely, and nothing about
/// their shape would object. Here the pairing is the record, so an unpaired comparison is not
/// expressible rather than merely discouraged.
/// </remarks>
public sealed record PairedObservation
{
    /// <summary>Gets the scenario both observations came from — the join key against a baseline.</summary>
    public required string ScenarioId { get; init; }

    /// <summary>
    /// Gets the seed both variants were run with. Carrying it here is what makes the pairing
    /// auditable: a reader can confirm the two runs really were driven identically.
    /// </summary>
    public required long Seed { get; init; }

    /// <summary>
    /// Gets the scenario's statistic under the baseline variant. Deliberately a
    /// <see cref="double"/> and not a <see cref="bool"/>: a paired bootstrap needs a per-scenario
    /// value that may be a mean over repetitions, not just a pass/fail.
    /// </summary>
    public required double BaselineValue { get; init; }

    /// <summary>Gets the same statistic under the candidate variant.</summary>
    public required double CandidateValue { get; init; }

    /// <summary>Gets the per-scenario difference the test is drawing its evidence from.</summary>
    public double Difference => CandidateValue - BaselineValue;

    /// <summary>Creates an observation from a binary pass/fail outcome under each variant.</summary>
    /// <param name="scenarioId">The scenario both outcomes came from.</param>
    /// <param name="seed">The seed both variants were run with.</param>
    /// <param name="baseline">Whether the scenario passed under the baseline.</param>
    /// <param name="candidate">Whether it passed under the candidate.</param>
    /// <returns>The matched observation, with outcomes encoded as zero and one.</returns>
    public static PairedObservation FromOutcomes(string scenarioId, long seed, bool baseline, bool candidate) =>
        new()
        {
            ScenarioId = scenarioId,
            Seed = seed,
            BaselineValue = baseline ? 1 : 0,
            CandidateValue = candidate ? 1 : 0,
        };
}

/// <summary>
/// A validated set of matched observations for the same scenarios under two variants.
/// </summary>
/// <remarks>
/// Only constructible through <see cref="Create(IEnumerable{PairedObservation})"/>, so a test that
/// accepts this type is given observations that have already been checked: every scenario appears
/// exactly once, every identifier is real, and every value is finite. A significance test can
/// therefore do statistics instead of input validation.
/// </remarks>
public sealed class PairedObservations
{
    private PairedObservations(PairedObservation[] pairs) => Pairs = Array.AsReadOnly(pairs);

    /// <summary>Gets the matched observations, in the order they were supplied.</summary>
    /// <remarks>
    /// A read-only view over the validated copy, not the copy itself. An
    /// <see cref="IReadOnlyList{T}"/> that is really an array is one cast away from being writable
    /// again, and a set that can be edited after validation carries no guarantee at all.
    /// </remarks>
    public IReadOnlyList<PairedObservation> Pairs { get; }

    /// <summary>Gets the number of matched scenarios.</summary>
    public int Count => Pairs.Count;

    /// <summary>
    /// Gets a value indicating whether every value is zero or one.
    /// </summary>
    /// <remarks>
    /// <see cref="SignificanceTestKind.McNemar"/> is defined on binary outcomes; a mean over
    /// repetitions needs <see cref="SignificanceTestKind.PairedBootstrap"/>. An implementation can
    /// check this rather than silently producing a number that does not mean what it says.
    /// </remarks>
    public bool IsBinary => Pairs.All(pair => IsZeroOrOne(pair.BaselineValue) && IsZeroOrOne(pair.CandidateValue));

    /// <summary>Creates a validated set of matched observations.</summary>
    /// <param name="observations">One observation per scenario.</param>
    /// <returns>The validated set.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="observations"/> is null.</exception>
    /// <exception cref="ArgumentException">
    /// The sequence is empty, contains a null, declares a blank scenario identifier, names the
    /// same scenario more than once, or carries a value that is not finite.
    /// </exception>
    public static PairedObservations Create(IEnumerable<PairedObservation> observations)
    {
        ArgumentNullException.ThrowIfNull(observations);

        var pairs = observations.ToArray();

        if (pairs.Length == 0)
        {
            throw new ArgumentException("A paired comparison needs at least one observation.", nameof(observations));
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var pair in pairs)
        {
            if (pair is null)
            {
                throw new ArgumentException("An observation must not be null.", nameof(observations));
            }

            if (string.IsNullOrWhiteSpace(pair.ScenarioId))
            {
                throw new ArgumentException(
                    "An observation must name the scenario it came from; without it the pairing cannot be audited.",
                    nameof(observations)
                );
            }

            if (!seen.Add(pair.ScenarioId))
            {
                throw new ArgumentException(
                    $"Scenario '{pair.ScenarioId}' appears more than once. Each scenario contributes exactly one pair.",
                    nameof(observations)
                );
            }

            if (!double.IsFinite(pair.BaselineValue) || !double.IsFinite(pair.CandidateValue))
            {
                throw new ArgumentException(
                    $"Scenario '{pair.ScenarioId}' carries a value that is not finite.",
                    nameof(observations)
                );
            }
        }

        return new PairedObservations(pairs);
    }

    private static bool IsZeroOrOne(double value) => value is 0 or 1;
}

/// <summary>
/// Judges whether a paired difference between a baseline and a candidate is real.
/// </summary>
/// <remarks>
/// Implementations must be paired tests. See <see cref="SignificanceTestKind"/> for why an
/// unpaired two-proportion z-test is not admissible here.
/// </remarks>
public interface ISignificanceTest
{
    /// <summary>Gets the test this implementation performs.</summary>
    SignificanceTestKind Kind { get; }

    /// <summary>Compares a baseline against a candidate.</summary>
    /// <param name="observations">The matched per-scenario observations.</param>
    /// <param name="cancellationToken">
    /// Cancels the computation. A paired bootstrap runs many resamples and is expected to honour
    /// it.
    /// </param>
    /// <returns>The effect size and, where computed, the p-value and verdict.</returns>
    ComparisonSummary Compare(PairedObservations observations, CancellationToken cancellationToken = default);
}

/// <summary>
/// Adjusts a family of p-values for the fact that a suite tests many scenarios at once.
/// </summary>
/// <remarks>
/// The intended implementation is Benjamini-Hochberg FDR rather than Bonferroni. See
/// <see cref="ComparisonSummary.AdjustedPValue"/> for why that is a deliberate trade and not an
/// inherited convention.
/// </remarks>
public interface IMultipleComparisonCorrection
{
    /// <summary>Gets the name of the correction, for stamping into the artifact.</summary>
    string Name { get; }

    /// <summary>Adjusts a family of p-values.</summary>
    /// <param name="pValues">The unadjusted p-values.</param>
    /// <returns>The adjusted p-values, in the same order as the input.</returns>
    IReadOnlyList<double> Adjust(IReadOnlyList<double> pValues);
}
