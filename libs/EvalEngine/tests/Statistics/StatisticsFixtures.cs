using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Results;

namespace Forge.EvalEngine.Tests.Statistics;

/// <summary>
/// Material for the statistics tests.
/// </summary>
/// <remarks>
/// Nothing here computes a statistic. Every expected value in these tests is either published,
/// produced by an independent reference implementation, or exact arithmetic a reader can redo by
/// hand — a fixture that calculated the answer would be asserting that the code agrees with
/// itself.
/// </remarks>
internal static class StatisticsFixtures
{
    public static RunResult Run(RunStatus status) => new() { Transcript = TestData.Transcript(), Status = status };

    public static IReadOnlyList<RunResult> Runs(params RunStatus[] statuses) => [.. statuses.Select(Run)];

    /// <summary>Repeats one verdict, the shape a scenario with a repetition policy produces.</summary>
    public static IReadOnlyList<RunResult> Repeated(RunStatus status, int count) =>
        [.. Enumerable.Repeat(status, count).Select(Run)];

    /// <summary>
    /// Builds a paired set from a 2x2 table of matched outcomes.
    /// </summary>
    /// <param name="baselineOnly">
    /// Pairs the baseline passed and the candidate failed — McNemar's <c>b</c>.
    /// </param>
    /// <param name="candidateOnly">
    /// Pairs the baseline failed and the candidate passed — McNemar's <c>c</c>.
    /// </param>
    /// <param name="bothPass">Concordant passes, which McNemar conditions away.</param>
    /// <param name="bothFail">Concordant failures, which McNemar conditions away.</param>
    public static PairedObservations Table(int baselineOnly, int candidateOnly, int bothPass = 0, int bothFail = 0)
    {
        var pairs = new List<PairedObservation>();
        var index = 0;

        void Add(int count, bool baseline, bool candidate)
        {
            for (var i = 0; i < count; i++)
            {
                pairs.Add(PairedObservation.FromOutcomes($"scenario-{index}", 1000 + index, baseline, candidate));
                index++;
            }
        }

        Add(baselineOnly, baseline: true, candidate: false);
        Add(candidateOnly, baseline: false, candidate: true);
        Add(bothPass, baseline: true, candidate: true);
        Add(bothFail, baseline: false, candidate: false);

        return PairedObservations.Create(pairs);
    }

    /// <summary>Builds a paired set from per-scenario continuous statistics.</summary>
    public static PairedObservations Continuous(params double[] differences) =>
        Continuous((IEnumerable<double>)differences);

    /// <summary>Builds a paired set from per-scenario continuous statistics.</summary>
    public static PairedObservations Continuous(IEnumerable<double> differences) =>
        PairedObservations.Create(
            differences.Select(
                (difference, index) =>
                    new PairedObservation
                    {
                        ScenarioId = $"scenario-{index}",
                        Seed = 1000 + index,
                        BaselineValue = 0,
                        CandidateValue = difference,
                    }
            )
        );

    /// <summary>
    /// The 100-scenario reference set the bootstrap is checked against.
    /// </summary>
    /// <remarks>
    /// Its mean difference is exactly 0.03 and its population standard deviation is
    /// 0.29597297173897485, so the paired mean has a normal-approximation two-sided p-value of
    /// 0.3107707612635575. That reference was computed with Python 3.14's
    /// <c>statistics.NormalDist</c> — an implementation independent of anything in this library.
    /// </remarks>
    public static IReadOnlyList<double> ConvergenceDifferences { get; } =
    [.. Enumerable.Range(0, 100).Select(i => ((i % 21) - 9) / 20.0)];
}
