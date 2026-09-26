using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Forge.EvalCli.Composition;

namespace Forge.EvalCli.Cli;

/// <summary>The machine-readable form of a dry run.</summary>
/// <remarks>
/// A separate shape from <see cref="RunPlan"/> on purpose. The plan holds the unredacted address a
/// later dialling stage needs; this holds only what may be printed, so no serializer can reach the
/// field that must not leave the process.
/// </remarks>
internal sealed record DryRunReport
{
    /// <summary>Gets the schema identifier, so a consumer can tell versions apart.</summary>
    [JsonPropertyName("schema")]
    public string Schema { get; init; } = "eval-cli/dry-run/1";

    /// <summary>Gets a value indicating whether this was a preview.</summary>
    [JsonPropertyName("dryRun")]
    public required bool DryRun { get; init; }

    /// <summary>Gets a value indicating whether anything was executed. Always false for a dry run.</summary>
    [JsonPropertyName("executed")]
    public required bool Executed { get; init; }

    /// <summary>Gets the canonical suite path.</summary>
    [JsonPropertyName("suite")]
    public required string Suite { get; init; }

    /// <summary>Gets the canonical containment root.</summary>
    [JsonPropertyName("root")]
    public required string Root { get; init; }

    /// <summary>Gets the canonical baseline path, or null.</summary>
    [JsonPropertyName("baseline")]
    public string? Baseline { get; init; }

    /// <summary>Gets the canonical artifact destination, or null when nothing would be written.</summary>
    [JsonPropertyName("artifact")]
    public string? Artifact { get; init; }

    /// <summary>Gets the canonical Markdown report destination, or null when none would be written.</summary>
    [JsonPropertyName("reportMarkdown")]
    public string? ReportMarkdown { get; init; }

    /// <summary>Gets whether replacing an existing artifact was opted into.</summary>
    [JsonPropertyName("overwriteArtifact")]
    public required bool OverwriteArtifact { get; init; }

    /// <summary>Gets the root seed.</summary>
    [JsonPropertyName("rootSeed")]
    public required long RootSeed { get; init; }

    /// <summary>Gets the ceiling on runs in flight at once.</summary>
    [JsonPropertyName("maxConcurrency")]
    public required int MaxConcurrency { get; init; }

    /// <summary>Gets the ceiling on runs the whole suite may plan.</summary>
    [JsonPropertyName("maxTotalRuns")]
    public required int MaxTotalRuns { get; init; }

    /// <summary>Gets the redacted endpoint, or null.</summary>
    [JsonPropertyName("endpoint")]
    public string? Endpoint { get; init; }

    /// <summary>Gets the redacted baseline address a baseline run would be conducted against, or null.</summary>
    [JsonPropertyName("baselineEndpoint")]
    public string? BaselineEndpoint { get; init; }

    /// <summary>Gets which mechanism would supply the baseline: <c>none</c>, <c>artifact</c>, or <c>live-endpoint</c>.</summary>
    [JsonPropertyName("baselineMechanism")]
    public required string BaselineMechanism { get; init; }

    /// <summary>Gets the revision the changed-file set would be read against, or null.</summary>
    [JsonPropertyName("changedSince")]
    public string? ChangedSince { get; init; }

    /// <summary>Gets the adapter that would describe the REST system under test.</summary>
    [JsonPropertyName("restExchange")]
    public required string RestExchange { get; init; }

    /// <summary>Gets the adapter that would describe the conversational system under test.</summary>
    [JsonPropertyName("llmExchange")]
    public required string LlmExchange { get; init; }

    /// <summary>Gets the gate mode in force.</summary>
    [JsonPropertyName("gateMode")]
    public required string GateMode { get; init; }

    /// <summary>Gets whether the gate is implemented. False in this build.</summary>
    /// <remarks>
    /// <c>failOnRegressionRequested</c> used to sit beside this and is gone: the flag is now
    /// refused, so the only value that field could carry is <see langword="false"/>, and a
    /// document field whose one possible answer is the answer to a question nobody can ask is
    /// noise a consumer has to interpret.
    /// </remarks>
    [JsonPropertyName("failOnRegressionImplemented")]
    public required bool FailOnRegressionImplemented { get; init; }

    /// <summary>Gets what the composition root wired.</summary>
    [JsonPropertyName("harness")]
    public required HarnessDescription Harness { get; init; }
}

/// <summary>
/// Renders the planned run to standard output.
/// </summary>
/// <remarks>
/// This is the <i>result</i> of a dry run, so it goes to stdout. Diagnostics go to stderr, which
/// is what lets a caller pipe the plan into another process without log lines in the stream.
/// </remarks>
internal static class PlanRenderer
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    private const string NoneMarker = "(none)";

    /// <summary>Builds the machine-readable report for a plan.</summary>
    /// <param name="plan">The validated plan.</param>
    /// <param name="harness">What the composition root wired.</param>
    /// <returns>The report.</returns>
    /// <exception cref="ArgumentNullException">Any argument is null.</exception>
    public static DryRunReport Report(RunPlan plan, HarnessDescription harness)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(harness);

        return new DryRunReport
        {
            DryRun = plan.DryRun,
            Executed = false,
            Suite = plan.SuitePath,
            Root = plan.RootDirectory,
            Baseline = plan.BaselinePath,
            Artifact = plan.ArtifactPath,
            ReportMarkdown = plan.MarkdownReportPath,
            OverwriteArtifact = plan.OverwriteArtifact,
            RootSeed = plan.RootSeed,
            MaxConcurrency = plan.MaxConcurrency,
            MaxTotalRuns = plan.MaxTotalRuns,
            Endpoint = plan.EndpointDisplay,
            BaselineEndpoint = plan.BaselineEndpointDisplay,
            BaselineMechanism = ComparisonReport.Name(Mechanism(plan)),
            ChangedSince = plan.ChangedSince,
            RestExchange = plan.RestExchange.ToString().ToLowerInvariant(),
            LlmExchange = plan.LlmExchange.ToString().ToLowerInvariant(),
            GateMode = plan.GateMode,
            FailOnRegressionImplemented = false,
            Harness = harness,
        };
    }

    /// <summary>Renders the plan as JSON.</summary>
    /// <param name="plan">The validated plan.</param>
    /// <param name="harness">What the composition root wired.</param>
    /// <returns>The JSON document.</returns>
    /// <exception cref="ArgumentNullException">Any argument is null.</exception>
    public static string RenderJson(RunPlan plan, HarnessDescription harness) =>
        JsonSerializer.Serialize(Report(plan, harness), JsonOptions);

    /// <summary>Renders the plan for a human reader.</summary>
    /// <param name="plan">The validated plan.</param>
    /// <param name="harness">What the composition root wired.</param>
    /// <returns>The rendered plan.</returns>
    /// <exception cref="ArgumentNullException">Any argument is null.</exception>
    public static string RenderText(RunPlan plan, HarnessDescription harness)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(harness);

        var text = new StringBuilder();

        text.AppendLine("Planned run - dry run, nothing was executed.");
        text.AppendLine();
        Row(text, "suite", plan.SuitePath);
        Row(text, "root", plan.RootDirectory);
        Row(text, "baseline", plan.BaselinePath ?? NoneMarker);
        Row(text, "artifact", plan.ArtifactPath ?? $"{NoneMarker} - no --out, so nothing would be written");
        Row(
            text,
            "report markdown",
            plan.MarkdownReportPath
                ?? $"{NoneMarker} - no --report-markdown, so no pull-request report would be written"
        );
        Row(
            text,
            "overwrite",
            plan.OverwriteArtifact
                ? "allowed - an existing file at --out or --report-markdown would be replaced"
                : "refused - an existing file at --out or --report-markdown would stop the run"
        );
        Row(text, "root seed", plan.RootSeed.ToString(CultureInfo.InvariantCulture));
        Row(text, "max concurrency", plan.MaxConcurrency.ToString(CultureInfo.InvariantCulture));
        Row(text, "max total runs", plan.MaxTotalRuns.ToString(CultureInfo.InvariantCulture));

        // Only ever the redacted form. The plan's Uri keeps the query string for a dialling stage
        // and must not reach any output.
        Row(text, "endpoint", plan.EndpointDisplay ?? NoneMarker);
        Row(text, "comparison", ComparisonLine(plan));
        Row(text, "selection", SelectionLine(plan));
        Row(text, "gate", $"{plan.GateMode} - regressions are reported, not enforced");

        text.AppendLine();
        text.AppendLine("  runners");

        foreach (var runner in harness.Runners)
        {
            Row(text, runner.Kind.ToLowerInvariant(), $"{runner.Runner ?? "-"}  {runner.Note}", indent: 4);
        }

        text.AppendLine();
        Row(text, "clock", harness.Clock);
        Row(text, "participants", $"{harness.ParticipantFactory} - a fresh participant per run");
        Row(text, "assertions", string.Join(", ", harness.AssertionCategories));
        Row(text, "significance", $"{harness.SignificanceTest}, corrected with {harness.MultipleComparisonCorrection}");
        Row(text, "diagnostics", "stderr; results on stdout");

        text.AppendLine();
        text.AppendLine("Nothing was executed and nothing was written.");

        return text.ToString();
    }

    /// <summary>Which mechanism would supply the baseline this run compares against.</summary>
    private static BaselineMechanism Mechanism(RunPlan plan) =>
        plan switch
        {
            { BaselineEndpoint: not null } => Cli.BaselineMechanism.LiveEndpoint,
            { BaselinePath: not null } => Cli.BaselineMechanism.Artifact,
            _ => Cli.BaselineMechanism.None,
        };

    /// <summary>States what the run would be compared against, and what it would cost.</summary>
    /// <remarks>
    /// <b>The live mechanism conducts the suite twice</b>, once against each address, and that is
    /// said here rather than discovered from the request count on somebody else's system. A
    /// preview whose only surprise arrives at runtime is not a preview.
    /// </remarks>
    private static string ComparisonLine(RunPlan plan) =>
        Mechanism(plan) switch
        {
            Cli.BaselineMechanism.LiveEndpoint =>
                $"against a baseline run at {plan.BaselineEndpointDisplay} - the suite would be conducted twice, "
                    + "once against each address",
            Cli.BaselineMechanism.Artifact => $"against the committed artifact at {plan.BaselinePath}",
            _ => "none - no --baseline and no --baseline-endpoint, so nothing would be compared. That is not the "
                + "same as nothing having regressed",
        };

    /// <summary>States which scenarios would run, and on what evidence.</summary>
    /// <remarks>
    /// <para>
    /// Named in the preview because it is the decision with the quietest failure mode. A run
    /// narrowed against the wrong revision reports a plausible number and omits the scenario that
    /// would have caught the regression, so a reader has to be able to see the revision before
    /// anything is executed.
    /// </para>
    /// <para>
    /// <b>What it does not say is that the run will be narrowed.</b> A dry run reads nothing —
    /// not the suite, not the diff — so it has no evidence for that, and the real run may widen
    /// instead: git may be absent, the revision unknown, the output undecodable, or a changed
    /// file outside the root. Stating an outcome the preview cannot know is the same error in
    /// miniature as a selective run that quietly selected too little.
    /// </para>
    /// </remarks>
    private static string SelectionLine(RunPlan plan) =>
        plan.ChangedSince is { } revision
            ? $"not resolved yet - a run would read the changed-file set from `git diff {revision}` plus the "
                + "untracked files, and fall back to the whole suite if it cannot be established"
            : "full suite - no --changed-since, so nothing is skipped";

    private static void Row(StringBuilder text, string label, string value, int indent = 2) =>
        text.AppendLine(string.Create(CultureInfo.InvariantCulture, $"{new string(' ', indent)}{label, -18}{value}"));
}
