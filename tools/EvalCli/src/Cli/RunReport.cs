using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Forge.EvalCli.Changes;
using Forge.EvalEngine.Impact;
using Forge.EvalEngine.Results;

namespace Forge.EvalCli.Cli;

/// <summary>
/// Everything a reader needs to judge whether a selective run was trustworthy.
/// </summary>
/// <remarks>
/// The changed-file set and the selection travel together because neither is interpretable alone.
/// "31 matched a changed file" says nothing useful if the changed-file set was read from the
/// wrong revision, and "the whole suite ran" says nothing useful without the reason. Both halves
/// of the provenance are carried here so both halves reach the report.
/// </remarks>
internal sealed record SelectionSummary
{
    /// <summary>Gets how the changed-file set was acquired, or why it was not.</summary>
    public required ChangedFileSet Changes { get; init; }

    /// <summary>Gets what the selector decided.</summary>
    public required SelectionResult Selection { get; init; }

    /// <summary>Gets how many scenarios the suite declares in total.</summary>
    public required int TotalScenarios { get; init; }

    /// <summary>Gets the count of selected scenarios per reason, in the selector's rule order.</summary>
    /// <remarks>
    /// Every reason is listed, including the ones that selected nothing. A reason omitted because
    /// its count was zero reads as a reason that does not exist, and the reader cannot then tell
    /// "the safety net rescued nothing" from "there is no safety net".
    /// </remarks>
    public IReadOnlyList<KeyValuePair<string, int>> CountsByReason =>
        Enum.GetValues<SelectionReason>()
            .Select(reason => new KeyValuePair<string, int>(
                Name(reason),
                Selection.Selected.Count(entry => entry.Reason == reason)
            ))
            .ToArray();

    /// <summary>The wire name for a reason, stable across the text and JSON renderings.</summary>
    /// <param name="reason">The reason.</param>
    /// <returns>The name.</returns>
    public static string Name(SelectionReason reason) =>
        reason switch
        {
            SelectionReason.Fallback => "fallback",
            SelectionReason.GlobMatch => "glob-match",
            SelectionReason.NoGlobsDeclared => "no-globs-declared",
            SelectionReason.PreviouslyFailing => "previously-failing",
            SelectionReason.New => "new",
            _ => reason.ToString(),
        };
}

/// <summary>One scenario's selection, in the machine-readable report.</summary>
/// <param name="ScenarioId">The scenario.</param>
/// <param name="Reason">The first rule that selected it.</param>
/// <param name="Detail">The caller-facing explanation of that reason, or null.</param>
internal sealed record SelectedScenarioReport(string ScenarioId, string Reason, string? Detail);

/// <summary>How the changed-file set was acquired, in the machine-readable report.</summary>
/// <param name="Established">Whether a trustworthy set was read.</param>
/// <param name="Count">How many paths it carried.</param>
/// <param name="Source">The command it was read from, or null.</param>
/// <param name="UnavailableReason">Why no set could be established, or null.</param>
internal sealed record ChangedFilesReport(bool Established, int Count, string? Source, string? UnavailableReason);

/// <summary>The machine-readable form of a completed run.</summary>
internal sealed record RunReportDocument
{
    /// <summary>Gets the schema identifier, so a consumer can tell versions apart.</summary>
    [JsonPropertyName("schema")]
    public string Schema { get; init; } = "eval-cli/run/1";

    /// <summary>Gets a value indicating whether anything was executed. Always true here.</summary>
    [JsonPropertyName("executed")]
    public required bool Executed { get; init; }

    /// <summary>Gets the suite name the artifact is labelled with.</summary>
    [JsonPropertyName("suite")]
    public required string Suite { get; init; }

    /// <summary>Gets the canonical containment root.</summary>
    [JsonPropertyName("root")]
    public required string Root { get; init; }

    /// <summary>Gets the redacted endpoint, or null.</summary>
    [JsonPropertyName("endpoint")]
    public string? Endpoint { get; init; }

    /// <summary>Gets where the artifact was written, or null when none was asked for.</summary>
    [JsonPropertyName("artifact")]
    public string? Artifact { get; init; }

    /// <summary>Gets the gate mode in force.</summary>
    [JsonPropertyName("gateMode")]
    public required string GateMode { get; init; }

    /// <summary>Gets how the changed-file set was acquired.</summary>
    [JsonPropertyName("changedFiles")]
    public required ChangedFilesReport ChangedFiles { get; init; }

    /// <summary>Gets how many scenarios the suite declares.</summary>
    [JsonPropertyName("scenariosInSuite")]
    public required int ScenariosInSuite { get; init; }

    /// <summary>Gets how many scenarios ran.</summary>
    [JsonPropertyName("scenariosSelected")]
    public required int ScenariosSelected { get; init; }

    /// <summary>Gets the identifiers of the scenarios that did not run.</summary>
    [JsonPropertyName("scenariosSkipped")]
    public required IReadOnlyList<string> ScenariosSkipped { get; init; }

    /// <summary>Gets why the whole suite was selected regardless of its mapping, or null.</summary>
    [JsonPropertyName("fallbackReason")]
    public string? FallbackReason { get; init; }

    /// <summary>Gets the count of selected scenarios per reason.</summary>
    [JsonPropertyName("selectionCounts")]
    public required IReadOnlyDictionary<string, int> SelectionCounts { get; init; }

    /// <summary>Gets every selected scenario with the rule that selected it.</summary>
    /// <remarks>
    /// Always complete here, unlike the text rendering, which shows the per-scenario lines only
    /// under <c>--verbose</c>. A machine-readable report costs nothing to read in full, and the
    /// reason a scenario ran is the thing a reviewer needs to check the selection against.
    /// </remarks>
    [JsonPropertyName("selected")]
    public required IReadOnlyList<SelectedScenarioReport> Selected { get; init; }

    /// <summary>Gets the count of runs per status.</summary>
    [JsonPropertyName("runCounts")]
    public required IReadOnlyDictionary<string, int> RunCounts { get; init; }

    /// <summary>Gets a value indicating whether any run failed as a harness failure.</summary>
    [JsonPropertyName("harnessFailed")]
    public required bool HarnessFailed { get; init; }

    /// <summary>Gets the comparison against a baseline, or null when no baseline was named.</summary>
    /// <remarks>
    /// Null is "no comparison was asked for". It is never "the comparison found nothing" and
    /// never "the comparison was refused" — a refusal ends the invocation with a non-zero code
    /// and no report at all, precisely so a consumer cannot read one as the other.
    /// </remarks>
    [JsonPropertyName("comparison")]
    public ComparisonReportDocument? Comparison { get; init; }
}

/// <summary>
/// Renders a completed run to standard output.
/// </summary>
/// <remarks>
/// <para>
/// This is the <i>result</i>, so it goes to stdout; diagnostics go to stderr. A caller can pipe
/// the JSON form into another process without log lines in the stream.
/// </para>
/// <para>
/// <b>Counts are never reported without their reasons.</b> "3 of 5 scenarios" is not a claim a
/// reviewer can check — it is indistinguishable from a broken selection that happened to produce
/// a plausible number. What makes it checkable is the rule that selected each scenario, the
/// command the changed-file set was read from, and, when the suite ran whole, the reason it did.
/// </para>
/// </remarks>
internal static class RunReport
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    private const string NoneMarker = "(none)";

    /// <summary>Builds the machine-readable report.</summary>
    /// <param name="plan">The validated plan.</param>
    /// <param name="summary">What was selected and why.</param>
    /// <param name="result">The artifact the run produced.</param>
    /// <param name="artifactPath">Where the artifact was written, or null.</param>
    /// <param name="comparison">The comparison against a baseline, or null when none was named.</param>
    /// <returns>The report.</returns>
    /// <exception cref="ArgumentNullException">Any required argument is null.</exception>
    public static RunReportDocument Document(
        RunPlan plan,
        SelectionSummary summary,
        SuiteResult result,
        string? artifactPath,
        ComparisonOutcome? comparison = null
    )
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(summary);
        ArgumentNullException.ThrowIfNull(result);

        return new RunReportDocument
        {
            Executed = true,
            Suite = result.SuiteName,
            Root = plan.RootDirectory,
            Endpoint = plan.EndpointDisplay,
            Artifact = artifactPath,
            GateMode = plan.GateMode,
            ChangedFiles = new ChangedFilesReport(
                summary.Changes.Established,
                summary.Changes.Paths.Count,
                summary.Changes.Source,
                summary.Changes.UnavailableReason
            ),
            ScenariosInSuite = summary.TotalScenarios,
            ScenariosSelected = summary.Selection.Selected.Count,
            ScenariosSkipped = summary.Selection.Skipped,
            FallbackReason = summary.Selection.FallbackReason,
            SelectionCounts = summary.CountsByReason.ToDictionary(
                entry => entry.Key,
                entry => entry.Value,
                StringComparer.Ordinal
            ),
            Selected =
            [
                .. summary.Selection.Selected.Select(entry => new SelectedScenarioReport(
                    entry.ScenarioId,
                    SelectionSummary.Name(entry.Reason),
                    entry.Detail
                )),
            ],
            RunCounts = CountByStatus(result),
            HarnessFailed = HarnessFailed(result),
            Comparison = comparison is null ? null : ComparisonReport.Document(comparison),
        };
    }

    /// <summary>Renders the run as JSON.</summary>
    /// <param name="plan">The validated plan.</param>
    /// <param name="summary">What was selected and why.</param>
    /// <param name="result">The artifact the run produced.</param>
    /// <param name="artifactPath">Where the artifact was written, or null.</param>
    /// <param name="comparison">The comparison against a baseline, or null when none was named.</param>
    /// <returns>The JSON document.</returns>
    public static string RenderJson(
        RunPlan plan,
        SelectionSummary summary,
        SuiteResult result,
        string? artifactPath,
        ComparisonOutcome? comparison = null
    ) => JsonSerializer.Serialize(Document(plan, summary, result, artifactPath, comparison), JsonOptions);

    /// <summary>Renders the run for a human reader.</summary>
    /// <param name="plan">The validated plan.</param>
    /// <param name="summary">What was selected and why.</param>
    /// <param name="result">The artifact the run produced.</param>
    /// <param name="artifactPath">Where the artifact was written, or null.</param>
    /// <param name="comparison">The comparison against a baseline, or null when none was named.</param>
    /// <returns>The rendered run.</returns>
    /// <exception cref="ArgumentNullException">Any required argument is null.</exception>
    public static string RenderText(
        RunPlan plan,
        SelectionSummary summary,
        SuiteResult result,
        string? artifactPath,
        ComparisonOutcome? comparison = null
    )
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(summary);
        ArgumentNullException.ThrowIfNull(result);

        var text = new StringBuilder();
        var selected = summary.Selection.Selected.Count;

        text.AppendLine(
            string.Create(
                CultureInfo.InvariantCulture,
                $"Run complete - {selected} of {summary.TotalScenarios} scenarios ran."
            )
        );
        text.AppendLine();
        Row(text, "suite", result.SuiteName);
        Row(text, "root", plan.RootDirectory);
        Row(text, "endpoint", plan.EndpointDisplay ?? NoneMarker);
        Row(text, "artifact", artifactPath ?? $"{NoneMarker} - no --out, so nothing was written");
        Row(text, "gate", $"{plan.GateMode} - regressions are reported, not enforced");

        text.AppendLine();
        text.AppendLine("  selection");
        Row(text, "changed files", ChangedFilesLine(summary.Changes), indent: 4, width: 20);

        if (summary.Selection.FallbackReason is { } fallback)
        {
            // Never abbreviated and never conditional on --verbose. A run that widened itself is
            // exactly the run whose number nobody should trust without the reason beside it.
            Row(text, "why the full suite", fallback, indent: 4, width: 20);
        }

        text.AppendLine();

        foreach (var (reason, count) in summary.CountsByReason)
        {
            Row(text, reason, count.ToString(CultureInfo.InvariantCulture), indent: 4, width: 20);
        }

        Row(
            text,
            "skipped",
            summary.Selection.Skipped.Count.ToString(CultureInfo.InvariantCulture),
            indent: 4,
            width: 20
        );

        if (plan.Verbose)
        {
            text.AppendLine();
            text.AppendLine("  scenarios");

            foreach (var entry in summary.Selection.Selected)
            {
                Row(
                    text,
                    entry.ScenarioId,
                    $"{SelectionSummary.Name(entry.Reason)} - {entry.Detail ?? summary.Selection.FallbackReason}",
                    indent: 4,
                    width: 28
                );
            }
        }

        text.AppendLine();
        text.AppendLine("  runs");

        foreach (var (status, count) in CountByStatus(result))
        {
            Row(text, status, count.ToString(CultureInfo.InvariantCulture), indent: 4, width: 20);
        }

        if (comparison is not null)
        {
            ComparisonReport.AppendTo(text, comparison, plan.Verbose);
        }

        text.AppendLine();
        text.AppendLine(
            HarnessFailed(result)
                ? "At least one run did not complete, so this run carries no verdict about those scenarios."
                : "Every selected scenario was conducted."
        );

        return text.ToString();
    }

    /// <summary>Reports whether any run failed as a harness failure rather than as a verdict.</summary>
    /// <remarks>
    /// <see cref="RunStatus.Error"/> means the run did not complete — a transport, configuration,
    /// or harness fault. It is emphatically not the same as a scenario that ran and failed, and
    /// the exit code separates the two: a system under test behaving badly is what the suite is
    /// for, while a harness that could not ask the question has produced no evidence at all.
    /// </remarks>
    public static bool HarnessFailed(SuiteResult result)
    {
        ArgumentNullException.ThrowIfNull(result);

        return result.ScenarioResults.Any(scenario => scenario.Runs.Any(run => run.Status is RunStatus.Error));
    }

    private static Dictionary<string, int> CountByStatus(SuiteResult result)
    {
        var counts = new Dictionary<string, int>(StringComparer.Ordinal);

        foreach (var status in Enum.GetValues<RunStatus>())
        {
            counts[Name(status)] = result.ScenarioResults.Sum(scenario =>
                scenario.Runs.Count(run => run.Status == status)
            );
        }

        return counts;
    }

    private static string Name(RunStatus status) =>
        status switch
        {
            RunStatus.Pass => "pass",
            RunStatus.Fail => "fail",
            RunStatus.Error => "error",
            RunStatus.ExpectedFailure => "expected-failure",
            _ => status.ToString(),
        };

    private static string ChangedFilesLine(ChangedFileSet changes) =>
        changes.Established
            ? string.Create(CultureInfo.InvariantCulture, $"{changes.Paths.Count} from `{changes.Source}`")
            : changes.UnavailableReason ?? NoneMarker;

    private static void Row(StringBuilder text, string label, string value, int indent = 2, int width = 18) =>
        text.AppendLine(
            string.Create(CultureInfo.InvariantCulture, $"{new string(' ', indent)}{label.PadRight(width)}{value}")
        );
}
