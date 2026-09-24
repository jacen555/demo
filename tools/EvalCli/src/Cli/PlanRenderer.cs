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

    /// <summary>Gets the gate mode in force.</summary>
    [JsonPropertyName("gateMode")]
    public required string GateMode { get; init; }

    /// <summary>Gets whether the reserved gate flag was passed.</summary>
    [JsonPropertyName("failOnRegressionRequested")]
    public required bool FailOnRegressionRequested { get; init; }

    /// <summary>Gets whether the gate is implemented. False in this build.</summary>
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
            OverwriteArtifact = plan.OverwriteArtifact,
            RootSeed = plan.RootSeed,
            MaxConcurrency = plan.MaxConcurrency,
            MaxTotalRuns = plan.MaxTotalRuns,
            Endpoint = plan.EndpointDisplay,
            GateMode = plan.GateMode,
            FailOnRegressionRequested = plan.FailOnRegression,
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
            "overwrite",
            plan.OverwriteArtifact
                ? "allowed - an existing artifact at --out would be replaced"
                : "refused - an existing artifact at --out would stop the run"
        );
        Row(text, "root seed", plan.RootSeed.ToString(CultureInfo.InvariantCulture));
        Row(text, "max concurrency", plan.MaxConcurrency.ToString(CultureInfo.InvariantCulture));
        Row(text, "max total runs", plan.MaxTotalRuns.ToString(CultureInfo.InvariantCulture));

        // Only ever the redacted form. The plan's Uri keeps the query string for a dialling stage
        // and must not reach any output.
        Row(text, "endpoint", plan.EndpointDisplay ?? NoneMarker);
        Row(text, "gate", GateLine(plan));

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

    private static string GateLine(RunPlan plan) =>
        plan.FailOnRegression
            ? $"{plan.GateMode} - --fail-on-regression is reserved and does not change this build's behaviour"
            : $"{plan.GateMode} - regressions are reported, not enforced";

    private static void Row(StringBuilder text, string label, string value, int indent = 2) =>
        text.AppendLine(string.Create(CultureInfo.InvariantCulture, $"{new string(' ', indent)}{label, -18}{value}"));
}
