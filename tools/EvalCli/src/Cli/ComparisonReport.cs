using System.Globalization;
using System.Text;
using System.Text.Json.Serialization;
using Forge.EvalEngine.Comparison;

namespace Forge.EvalCli.Cli;

/// <summary>One scenario's diff, in the machine-readable report.</summary>
/// <param name="ScenarioId">The scenario — the join key the two artifacts were paired on.</param>
/// <param name="Classification">How it changed.</param>
/// <param name="BaselineOutcome">What the baseline said about it.</param>
/// <param name="CandidateOutcome">What this run said about it.</param>
/// <param name="NotComparableReason">Why it could not be diffed, or null when it could.</param>
internal sealed record ComparisonScenarioReport(
    string ScenarioId,
    string Classification,
    string BaselineOutcome,
    string CandidateOutcome,
    string? NotComparableReason
);

/// <summary>The machine-readable form of a comparison.</summary>
internal sealed record ComparisonReportDocument
{
    /// <summary>Gets which mechanism supplied the baseline: <c>artifact</c> or <c>live-endpoint</c>.</summary>
    [JsonPropertyName("mechanism")]
    public required string Mechanism { get; init; }

    /// <summary>Gets the reference the baseline came from — a path, or a redacted address.</summary>
    [JsonPropertyName("baseline")]
    public required string Baseline { get; init; }

    /// <summary>
    /// Gets the scenarios this change covered that the baseline did not.
    /// </summary>
    /// <remarks>
    /// <b>The headline, not a byproduct.</b> A harness that reports only what broke is a worse
    /// version of a test suite; the reason to run a suite against two variants is to be able to
    /// show what a change <i>fixed</i>. First in this record for the same reason it is first in
    /// the rendered text.
    /// </remarks>
    [JsonPropertyName("newlyCovered")]
    public required IReadOnlyList<string> NewlyCovered { get; init; }

    /// <summary>Gets the scenarios that passed but were not fully conducted, so are not claimed.</summary>
    /// <remarks>
    /// Named rather than dropped, for the same reason a withheld scenario is: silence in a
    /// coverage report reads as a scenario that was examined and offered nothing. The comparator
    /// decides membership; this report states it.
    /// </remarks>
    [JsonPropertyName("newlyCoveredWithheld")]
    public IReadOnlyList<string> NewlyCoveredWithheld { get; init; } = [];

    /// <summary>Gets why those scenarios were withheld from the headline, or null when none were.</summary>
    [JsonPropertyName("newlyCoveredWithheldReason")]
    public string? NewlyCoveredWithheldReason { get; init; }

    /// <summary>Gets the scenarios that passed under the baseline and do not under this run.</summary>
    [JsonPropertyName("regressed")]
    public required IReadOnlyList<string> Regressed { get; init; }

    /// <summary>Gets the scenarios present in both artifacts that could not honestly be diffed.</summary>
    [JsonPropertyName("notComparable")]
    public required IReadOnlyList<string> NotComparable { get; init; }

    /// <summary>Gets the count per classification, including the classifications that matched nothing.</summary>
    /// <remarks>
    /// Every classification is listed even at zero, for the reason every selection reason is: one
    /// omitted because its count was zero reads as a classification that does not exist, and a
    /// reader cannot then tell "nothing regressed" from "regressions are not reported".
    /// </remarks>
    [JsonPropertyName("classificationCounts")]
    public required IReadOnlyDictionary<string, int> ClassificationCounts { get; init; }

    /// <summary>Gets every compared scenario with its classification.</summary>
    [JsonPropertyName("scenarios")]
    public required IReadOnlyList<ComparisonScenarioReport> Scenarios { get; init; }

    /// <summary>Gets the scenarios withheld from the comparison because this run did not conduct them.</summary>
    [JsonPropertyName("notCompared")]
    public required IReadOnlyList<string> NotCompared { get; init; }

    /// <summary>Gets why those scenarios were withheld, or null when none were.</summary>
    [JsonPropertyName("notComparedReason")]
    public string? NotComparedReason { get; init; }

    /// <summary>Gets the multiple-comparison correction applied to the per-scenario p-values, or null.</summary>
    [JsonPropertyName("correction")]
    public string? Correction { get; init; }

    /// <summary>Gets whether the comparison changed the exit code. False in this build.</summary>
    /// <remarks>
    /// Stated rather than implied. A consumer reading a regression count needs to know whether
    /// anything acted on it, and a field that appears only once the gate exists would read as a
    /// gate that was always there.
    /// </remarks>
    [JsonPropertyName("enforced")]
    public required bool Enforced { get; init; }
}

/// <summary>
/// Renders a comparison for a human and for a machine.
/// </summary>
/// <remarks>
/// <para>
/// <b><see cref="ComparisonReportDocument.NewlyCovered"/> leads.</b> What a change fixed is the
/// reason this harness exists, and a report that opened with regressions would train a reader to
/// stop at the first line.
/// </para>
/// <para>
/// <b>A scenario that could not be compared is rendered as a refusal, not as an absence.</b> Its
/// reason is printed in full and the instruction to regenerate rather than hand-edit the baseline
/// is printed beside it, because the difference between "this did not change" and "nothing
/// examined this" is the whole value of the report.
/// </para>
/// </remarks>
internal static class ComparisonReport
{
    private const int Width = 20;

    /// <summary>Builds the machine-readable comparison.</summary>
    /// <param name="outcome">The comparison that happened.</param>
    /// <returns>The report.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="outcome"/> is null.</exception>
    public static ComparisonReportDocument Document(ComparisonOutcome outcome)
    {
        ArgumentNullException.ThrowIfNull(outcome);

        var comparisons = outcome.Result.ScenarioComparisons;

        return new ComparisonReportDocument
        {
            Mechanism = Name(outcome.Mechanism),
            Baseline = outcome.Reference,
            NewlyCovered = outcome.Result.NewlyCovered,
            NewlyCoveredWithheld = outcome.Result.NewlyCoveredWithheld,
            NewlyCoveredWithheldReason = outcome.Result.NewlyCoveredWithheldReason,
            Regressed = [.. Ids(comparisons, ScenarioClassification.Regressed)],
            NotComparable = [.. Ids(comparisons, ScenarioClassification.NotComparable)],
            ClassificationCounts = Counts(comparisons),
            Scenarios =
            [
                .. comparisons.Select(scenario => new ComparisonScenarioReport(
                    scenario.ScenarioId,
                    Name(scenario.Classification),
                    Name(scenario.BaselineOutcome),
                    Name(scenario.CandidateOutcome),
                    scenario.NotComparableReason
                )),
            ],
            NotCompared = outcome.WithheldScenarios,
            NotComparedReason = outcome.WithheldScenarios.Count == 0 ? null : WithheldReason,
            Correction = outcome.Result.Correction,
            Enforced = false,
        };
    }

    /// <summary>Appends the comparison section to a run's rendered text.</summary>
    /// <param name="text">The report being built.</param>
    /// <param name="outcome">The comparison that happened.</param>
    /// <param name="verbose">Whether to print the per-scenario lines for scenarios that did compare.</param>
    /// <exception cref="ArgumentNullException">Any argument is null.</exception>
    public static void AppendTo(StringBuilder text, ComparisonOutcome outcome, bool verbose)
    {
        ArgumentNullException.ThrowIfNull(text);
        ArgumentNullException.ThrowIfNull(outcome);

        var comparisons = outcome.Result.ScenarioComparisons;
        var withheld = outcome.Result.NewlyCoveredWithheld;

        text.AppendLine();
        text.AppendLine("  comparison");
        Row(text, "baseline", $"{Name(outcome.Mechanism)} {outcome.Reference}");

        // First, and named even at zero. This is what the harness is for.
        Row(text, "newly covered", Listed(outcome.Result.NewlyCovered));
        Row(text, "regressed", Listed([.. Ids(comparisons, ScenarioClassification.Regressed)]));

        if (withheld.Count > 0)
        {
            // Beside the headline rather than below the fold: a scenario the harness could not
            // fully conduct is the one whose absence from a coverage list reads as a scenario
            // nobody gained.
            //
            // Selected on the list, not on the reason. ComparisonResult documents the reason as
            // non-null whenever it withheld something, but it is a nullable member of a record
            // this tool does not own — and a row keyed on the annotation would drop the names if
            // that ever stopped holding, which is this section's own defect turned inward.
            var reason = outcome.Result.NewlyCoveredWithheldReason;

            Row(text, "not fully conducted", reason is null ? Listed(withheld) : $"{Listed(withheld)} - {reason}");
        }

        text.AppendLine();

        foreach (var (classification, count) in Counts(comparisons))
        {
            Row(text, classification, count.ToString(CultureInfo.InvariantCulture));
        }

        if (outcome.WithheldScenarios.Count > 0)
        {
            Row(text, "not compared", $"{Listed(outcome.WithheldScenarios)} - {WithheldReason}");
        }

        Row(text, "gate", $"{RunPlan.ReportOnlyGate} - the comparison is reported, not enforced");

        AppendRefusals(text, comparisons);

        if (!verbose)
        {
            return;
        }

        text.AppendLine();
        text.AppendLine("  scenarios compared");

        foreach (
            var scenario in comparisons.Where(entry => entry.Classification != ScenarioClassification.NotComparable)
        )
        {
            Row(
                text,
                scenario.ScenarioId,
                $"{Name(scenario.Classification)} - {Name(scenario.BaselineOutcome)} -> "
                    + Name(scenario.CandidateOutcome),
                width: 28
            );
        }
    }

    /// <summary>Renders the per-scenario refusals, with what to do about them.</summary>
    /// <remarks>
    /// <para>
    /// Never abbreviated and never conditional on <c>--verbose</c>. A scenario nobody could
    /// compare is precisely the scenario whose silence in a count would be misread as agreement.
    /// </para>
    /// <para>
    /// <b>Selected by classification, not by whether a reason was recorded.</b>
    /// <see cref="ScenarioComparison.Classification"/> is what defines this section, and it is a
    /// required member. <see cref="ScenarioComparison.NotComparableReason"/> is an optional
    /// annotation on a record owned by the engine, documented as null when a scenario could be
    /// compared. Keying the section on the annotation makes this rendering depend on an
    /// invariant that type does not state and this tool does not own.
    /// </para>
    /// <para>
    /// <b>What that costs is a scenario that disappears.</b> The verbose
    /// <c>scenarios compared</c> list excludes <see cref="ScenarioClassification.NotComparable"/>
    /// by classification, so a refused pair carrying no reason would be filtered out of this
    /// section and was never eligible for that one — absent from the report altogether, which is
    /// exactly the silence this section exists to break. It would also put the text at odds with
    /// <see cref="Document"/> and with the refusal in
    /// <c>BaselineComparison.RequireEveryPairWasCompared</c>, both of which select on the
    /// classification: one run, three accounts of what went unexamined.
    /// <see cref="Refusal"/> already states the outcomes that could not be paired when no reason
    /// was recorded, and that fallback is what makes selecting on the classification total.
    /// </para>
    /// <para>
    /// <b>No path in the current comparator produces one.</b> Every
    /// <see cref="ScenarioClassification.NotComparable"/> it emits today carries a reason — the
    /// wholly ungradeable baseline included, which its no-graded-pair guard names explicitly
    /// rather than leaving blank. This is totality over a contract that permits null, not a
    /// defect reproduced.
    /// </para>
    /// </remarks>
    private static void AppendRefusals(StringBuilder text, IReadOnlyList<ScenarioComparison> comparisons)
    {
        var refused = comparisons
            .Where(scenario => scenario.Classification == ScenarioClassification.NotComparable)
            .ToArray();

        if (refused.Length == 0)
        {
            return;
        }

        text.AppendLine();
        text.AppendLine("  not comparable - these scenarios were not examined by this comparison");

        foreach (var scenario in refused)
        {
            Row(text, scenario.ScenarioId, Refusal(scenario), width: 28);
        }

        text.AppendLine();
        text.AppendLine($"    {BaselineComparison.RegenerateRemedy}");
    }

    /// <summary>Why one scenario could not be compared, stated even when the comparator did not.</summary>
    /// <param name="scenario">The refused comparison.</param>
    /// <returns>The recorded reason, or the outcomes that could not be paired.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="scenario"/> is null.</exception>
    public static string Refusal(ScenarioComparison scenario)
    {
        ArgumentNullException.ThrowIfNull(scenario);

        return scenario.NotComparableReason
            ?? $"the baseline recorded {Name(scenario.BaselineOutcome)} and this run recorded "
                + $"{Name(scenario.CandidateOutcome)}, which are not a pair anything can be concluded from";
    }

    /// <summary>The wire name for a classification, stable across the text and JSON renderings.</summary>
    /// <param name="classification">The classification.</param>
    /// <returns>The name.</returns>
    public static string Name(ScenarioClassification classification) =>
        classification switch
        {
            ScenarioClassification.NotComparable => "not-comparable",
            ScenarioClassification.StablePass => "stable-pass",
            ScenarioClassification.StableFail => "stable-fail",
            ScenarioClassification.Fixed => "fixed",
            ScenarioClassification.Regressed => "regressed",
            ScenarioClassification.New => "new",
            ScenarioClassification.Removed => "removed",
            _ => classification.ToString(),
        };

    /// <summary>The wire name for a mechanism.</summary>
    /// <param name="mechanism">The mechanism.</param>
    /// <returns>The name.</returns>
    public static string Name(BaselineMechanism mechanism) =>
        mechanism switch
        {
            BaselineMechanism.Artifact => "artifact",
            BaselineMechanism.LiveEndpoint => "live-endpoint",
            _ => "none",
        };

    /// <summary>The count per classification, in declaration order, including the empty ones.</summary>
    /// <param name="comparisons">The scenario comparisons.</param>
    /// <returns>The counts.</returns>
    public static IReadOnlyDictionary<string, int> Counts(IReadOnlyList<ScenarioComparison> comparisons)
    {
        ArgumentNullException.ThrowIfNull(comparisons);

        var counts = new Dictionary<string, int>(StringComparer.Ordinal);

        foreach (var classification in Enum.GetValues<ScenarioClassification>())
        {
            counts[Name(classification)] = comparisons.Count(scenario => scenario.Classification == classification);
        }

        return counts;
    }

    /// <summary>Why a scenario this run did not conduct is reported apart from the comparison.</summary>
    /// <remarks>
    /// Stated in one place so the text rendering, the JSON document, and the Markdown report
    /// cannot drift into three accounts of the same withholding.
    /// </remarks>
    internal const string WithheldReason =
        "skipped by selection, so this run produced no candidate evidence about them. They are not unchanged and "
        + "they were not removed";

    /// <summary>The wire name for an outcome, stable across the text and JSON renderings.</summary>
    /// <param name="outcome">The outcome.</param>
    /// <returns>The name.</returns>
    public static string Name(ScenarioOutcome outcome) =>
        outcome switch
        {
            ScenarioOutcome.Absent => "absent",
            ScenarioOutcome.Ungradeable => "ungradeable",
            ScenarioOutcome.Failed => "failed",
            ScenarioOutcome.Passed => "passed",
            _ => outcome.ToString(),
        };

    private static IEnumerable<string> Ids(
        IReadOnlyList<ScenarioComparison> comparisons,
        ScenarioClassification classification
    ) =>
        comparisons
            .Where(scenario => scenario.Classification == classification)
            .Select(scenario => scenario.ScenarioId);

    /// <summary>A count and the identifiers behind it, because a count alone is not checkable.</summary>
    internal static string Listed(IReadOnlyList<string> identifiers) =>
        identifiers.Count == 0
            ? "0"
            : string.Create(CultureInfo.InvariantCulture, $"{identifiers.Count} - {string.Join(", ", identifiers)}");

    private static void Row(StringBuilder text, string label, string value, int width = Width) =>
        text.AppendLine(string.Create(CultureInfo.InvariantCulture, $"    {label.PadRight(width)}{value}"));
}
