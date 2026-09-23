using System.Globalization;
using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Comparison;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Statistics;
using Forge.EvalEngine.Transcripts;
using Microsoft.Extensions.Logging;

namespace Forge.EvalEngine.Tests.Comparison;

/// <summary>
/// Material for the comparator tests.
/// </summary>
/// <remarks>
/// Nothing here computes an expected statistic. Every p-value asserted in these tests is an exact
/// binary fraction a reader can redo by hand from the binomial coefficients — a fixture that
/// derived the answer would only be asserting that the code agrees with itself.
/// </remarks>
internal static class ComparisonFixtures
{
    public const string SuiteName = "regression-suite";
    public const long RootSeed = 20260922;

    /// <summary>The assertion both variants are graded against unless a test says otherwise.</summary>
    public static IReadOnlyList<string> DefaultAssertions { get; } = ["slotAbsent:scope/confirm"];

    /// <summary>The harness settings a run stamps, shaped exactly as the coordinator writes them.</summary>
    public static IReadOnlyDictionary<string, string> Config(
        int maxConcurrency = 1,
        string intervalMethod = "wilson",
        string intervalConfidence = "0.95"
    ) =>
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["maxConcurrency"] = maxConcurrency.ToString(CultureInfo.InvariantCulture),
            ["intervalMethod"] = intervalMethod,
            ["intervalConfidence"] = intervalConfidence,
        };

    public static SuiteResult Artifact(
        IEnumerable<ScenarioResult> scenarios,
        string suiteName = SuiteName,
        long seed = RootSeed,
        string? endpoint = "https://baseline.example/eval",
        string? baselineRef = null,
        DateTimeOffset? timestamp = null,
        IReadOnlyDictionary<string, string>? harnessConfig = null
    ) =>
        new()
        {
            SuiteName = suiteName,
            ScenarioResults = [.. scenarios],
            SlicingDimensions = [],
            Environment = new EvaluationEnvironment
            {
                Endpoint = endpoint,
                BaselineRef = baselineRef,
                Seed = seed,
                Timestamp = timestamp ?? TestData.FixedInstant,
                HarnessConfig = harnessConfig ?? Config(),
            },
        };

    public static SuiteResult Artifact(params ScenarioResult[] scenarios) =>
        Artifact((IEnumerable<ScenarioResult>)scenarios);

    /// <summary>The seed a repetition is driven with when a test does not pin one.</summary>
    /// <remarks>
    /// A function of the repetition index alone, so a baseline fixture and a candidate fixture
    /// are paired by construction and a test that wants them unpaired has to say so.
    /// </remarks>
    public static long SeedFor(int repetition) => 1000 + repetition;

    /// <summary>
    /// The definition fingerprint both variants carry unless a test says otherwise.
    /// </summary>
    /// <remarks>
    /// A constant rather than a value derived from the other knobs on purpose. Each guard in the
    /// comparator is checked on its own, so a test that varies the assertions must not also
    /// silently vary the fingerprint and end up proving a different guard from the one it names.
    /// The coordinator's own stamping is pinned separately, against the real
    /// <see cref="ScenarioFingerprint"/>.
    /// </remarks>
    public const string DefaultFingerprint = "sha256:fixture-definition";

    public static ScenarioResult Scenario(string id, params RunStatus[] statuses) => Scenario(id, statuses, null);

    public static ScenarioResult Scenario(
        string id,
        IReadOnlyList<RunStatus> statuses,
        IReadOnlyList<long>? seeds = null,
        ScenarioKind kind = ScenarioKind.Rest,
        IEnumerable<string>? assertions = null,
        int? declaredRepetitions = null,
        StatisticalSummary? summary = null,
        bool summarize = true,
        string? definitionFingerprint = DefaultFingerprint
    )
    {
        var specs = (assertions ?? DefaultAssertions).Select(AssertionSpec.Parse).ToArray();

        var runs = statuses
            .Select(
                (status, index) =>
                    new RunResult
                    {
                        Transcript = Transcript(id, seeds is null ? SeedFor(index) : seeds[index]),
                        Status = status,
                        ErrorDetail = status == RunStatus.Error ? "transport refused the connection" : null,

                        // An errored run never reached grading, so it carries no assertion
                        // results — the shape the coordinator actually produces.
                        AssertionResults =
                            status == RunStatus.Error
                                ? []
                                :
                                [
                                    .. specs.Select(spec => new AssertionResult
                                    {
                                        Spec = spec,
                                        Pass = status == RunStatus.Pass,
                                    }),
                                ],
                    }
            )
            .ToArray();

        return new ScenarioResult
        {
            ScenarioId = id,
            Kind = kind,
            Runs = runs,
            RepetitionPolicyUsed = RepetitionPolicy.Repeat(declaredRepetitions ?? Math.Max(1, statuses.Count)),
            Summary = summary ?? (summarize ? ScenarioAggregator.Default.Summarize(runs) : null),
            DefinitionFingerprint = definitionFingerprint,
        };
    }

    /// <summary>Repeats one verdict, the shape a scenario with a repetition policy produces.</summary>
    public static RunStatus[] Repeated(RunStatus status, int count) => [.. Enumerable.Repeat(status, count)];

    public static Transcript Transcript(string scenarioId, long seed) =>
        new()
        {
            ScenarioId = scenarioId,
            Seed = seed,
            StartedAt = TestData.FixedInstant,
            Duration = TimeSpan.FromMilliseconds(1500),
            Turns =
            [
                new Turn
                {
                    Index = 1,
                    Stimulus = "opening stimulus",
                    Response = "a response",
                    Provenance = TurnProvenance.Scripted,
                },
            ],
            Outcome = new Outcome { ObservedOutcome = "resolved", ObservedPath = "triage/resolve" },
        };

    public static ScenarioComparison For(ComparisonResult result, string scenarioId) =>
        result.ScenarioComparisons.Single(comparison => comparison.ScenarioId == scenarioId);

    /// <summary>A comparator with the statistics wired exactly as a caller would wire them.</summary>
    public static SuiteComparator WithStatistics(
        double significanceLevel = SuiteComparator.DefaultSignificanceLevel,
        ILogger<SuiteComparator>? logger = null
    ) =>
        new(
            new McNemarTest(significanceLevel),
            BenjaminiHochbergCorrection.Instance,
            significanceLevel,
            logger ?? Microsoft.Extensions.Logging.Abstractions.NullLogger<SuiteComparator>.Instance
        );
}

/// <summary>
/// An <see cref="ILogger{TCategoryName}"/> that keeps what it was told, so a test can check that a
/// refusal to compare was signalled rather than swallowed.
/// </summary>
internal sealed class RecordingComparatorLogger : ILogger<SuiteComparator>
{
    private readonly List<(LogLevel Level, string Message)> _entries = [];

    public IReadOnlyList<(LogLevel Level, string Message)> Entries
    {
        get
        {
            lock (_entries)
            {
                return [.. _entries];
            }
        }
    }

    public IDisposable? BeginScope<TState>(TState state)
        where TState : notnull => null;

    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(
        LogLevel logLevel,
        EventId eventId,
        TState state,
        Exception? exception,
        Func<TState, Exception?, string> formatter
    )
    {
        lock (_entries)
        {
            _entries.Add((logLevel, formatter(state, exception)));
        }
    }
}
