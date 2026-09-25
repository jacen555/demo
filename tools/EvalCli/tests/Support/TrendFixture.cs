using System.Globalization;
using Forge.EvalCli.Cli;
using Forge.EvalEngine.Results;

namespace Forge.EvalCli.Tests.Support;

/// <summary>
/// Builds the series of artifacts a trend is read from.
/// </summary>
/// <remarks>
/// <para>
/// <b>Constructed, not conducted</b>, for the same reason <see cref="ReportFixture"/> is: a trend
/// is a pure function of a list of artifacts, and hand-building them is what lets a test reach
/// shapes a single invocation cannot produce — a scenario absent from the middle of a series, two
/// runs stamped with the same instant, an artifact written before fingerprinting existed.
/// </para>
/// <para>
/// The end-to-end coverage in <c>TrendCommandTests</c> conducts real suites and trends the
/// artifacts those runs wrote, which is what pins this against what the engine really emits.
/// </para>
/// </remarks>
internal static class TrendFixture
{
    /// <summary>The fingerprint a scenario carries unless a test changes it.</summary>
    public const string Fingerprint = "sha256:aaaa";

    /// <summary>The instant the first artifact in a series is stamped with.</summary>
    public static readonly DateTimeOffset Start = new(2026, 1, 5, 9, 0, 0, TimeSpan.Zero);

    /// <summary>Stamps a scenario record with a definition fingerprint.</summary>
    /// <param name="scenario">The record.</param>
    /// <param name="fingerprint">The fingerprint, or null for an artifact that recorded none.</param>
    /// <returns>The stamped record.</returns>
    public static ScenarioResult Fingerprinted(ScenarioResult scenario, string? fingerprint = Fingerprint) =>
        scenario with
        {
            DefinitionFingerprint = fingerprint,
        };

    /// <summary>A graded scenario carrying the default fingerprint.</summary>
    /// <param name="id">The scenario id.</param>
    /// <param name="passed">How many repetitions passed.</param>
    /// <param name="graded">How many repetitions produced a verdict.</param>
    /// <returns>The record.</returns>
    public static ScenarioResult Scenario(string id, int passed, int graded) =>
        Fingerprinted(ReportFixture.Scenario(id, passed, graded));

    /// <summary>A scenario every repetition of which errored, so nothing was learned about it.</summary>
    /// <param name="id">The scenario id.</param>
    /// <returns>The record.</returns>
    public static ScenarioResult Ungradeable(string id) => Fingerprinted(ReportFixture.Ungradeable(id));

    /// <summary>Builds one artifact in a series.</summary>
    /// <param name="day">Which day of the series it was run on, from one.</param>
    /// <param name="scenarios">What it recorded.</param>
    /// <returns>The artifact, labelled the way the report would print it.</returns>
    public static TrendArtifact Artifact(int day, params ScenarioResult[] scenarios) =>
        Artifact(Start.AddDays(day - 1), $"artifacts/run-{day.ToString(CultureInfo.InvariantCulture)}.json", scenarios);

    /// <summary>Builds one artifact stamped with an explicit instant.</summary>
    /// <param name="timestamp">What the run recorded as its start.</param>
    /// <param name="label">The label the report would print.</param>
    /// <param name="scenarios">What it recorded.</param>
    /// <param name="suiteName">The suite the run was of.</param>
    /// <param name="seed">The root seed it was driven from.</param>
    /// <param name="confidence">The interval confidence it recorded, or null for none.</param>
    /// <param name="concurrency">The throttle it ran under.</param>
    /// <param name="intervalMethod">The interval method it recorded, or null for none.</param>
    /// <param name="extraConfig">Harness settings beyond the ones this build writes.</param>
    /// <returns>The artifact.</returns>
    public static TrendArtifact Artifact(
        DateTimeOffset timestamp,
        string label,
        ScenarioResult[] scenarios,
        string suiteName = "regression",
        long seed = 0,
        double? confidence = ReportFixture.ConfidenceLevel,
        int concurrency = 1,
        string? intervalMethod = "wilson",
        IReadOnlyDictionary<string, string>? extraConfig = null
    )
    {
        var config = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["maxConcurrency"] = concurrency.ToString(CultureInfo.InvariantCulture),
        };

        if (confidence is { } level)
        {
            config["intervalConfidence"] = level.ToString(CultureInfo.InvariantCulture);
        }

        // Independent of the level on purpose. A run that records a method and no level — or a
        // level and a method this build does not recognise — has settings present enough to pass
        // a null check and not enough to check a bound against, and that half-configured shape is
        // one a test has to be able to construct.
        if (intervalMethod is not null)
        {
            config["intervalMethod"] = intervalMethod;
        }

        foreach (var (key, value) in extraConfig ?? new Dictionary<string, string>(StringComparer.Ordinal))
        {
            config[key] = value;
        }

        return new TrendArtifact(
            label,
            new SuiteResult
            {
                SuiteName = suiteName,
                ScenarioResults = scenarios,
                Environment = new EvaluationEnvironment
                {
                    Seed = seed,
                    Timestamp = timestamp,
                    HarnessConfig = config,
                },
            }
        );
    }

    /// <summary>Renders a trend as the Markdown a reviewer reads, at the full comment budget.</summary>
    /// <param name="trend">The trend.</param>
    /// <param name="budget">The character budget.</param>
    /// <returns>The Markdown.</returns>
    public static string Render(SuiteTrend trend, int budget = MarkdownReport.CommentCharacterLimit) =>
        TrendReport
            .Render(
                new TrendReportRequest
                {
                    Trend = trend,
                    RootDirectory = OperatingSystem.IsWindows() ? @"C:\repo" : "/repo",
                    ArtifactsDirectory = OperatingSystem.IsWindows() ? @"C:\repo\artifacts" : "/repo/artifacts",
                    CharacterBudget = budget,
                }
            )
            .Text;
}
