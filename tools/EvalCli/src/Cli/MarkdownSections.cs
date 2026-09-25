using Forge.EvalEngine.Comparison;
using Forge.EvalEngine.Results;

namespace Forge.EvalCli.Cli;

internal static partial class MarkdownReport
{
    /// <summary>
    /// Builds every section, in the order the report contracts to render them.
    /// </summary>
    /// <param name="outcome">The comparison that happened.</param>
    /// <param name="analysis">The single shared accounting of it.</param>
    /// <param name="artifact">The displayed path of the durable artifact, or null when there is none.</param>
    /// <returns>The sections, highest severity first.</returns>
    /// <remarks>
    /// <para>
    /// <b>This order is both the layout and the truncation priority.</b> Entries are allocated
    /// against the budget as a strict prefix of this sequence, so what survives a truncation is
    /// always the highest-severity content and the same input always produces the same output.
    /// </para>
    /// <para>
    /// <b>Every heading's figure comes from <paramref name="analysis"/>.</b> Nothing here counts
    /// anything itself: the summary, the headings, the bodies and the footer all read one
    /// accounting, so two of them cannot disagree about how many scenarios something happened to.
    /// </para>
    /// <para>
    /// The four sections a reader must be able to trust the silence of — regressions, newly
    /// covered, not comparable, withheld — are rendered <b>even when empty</b>, each with an empty
    /// form that says what the emptiness means. The rest appear only when they have something to
    /// report, and the footer's accounting names every category with its count regardless.
    /// </para>
    /// </remarks>
    private static IReadOnlyList<MarkdownSection> Sections(
        ComparisonOutcome outcome,
        ComparisonAnalysis analysis,
        string? artifact
    )
    {
        var baseline = Index(outcome.Baseline);
        var candidate = Index(outcome.Candidate);
        var settings = Settings(outcome.Candidate);
        var correction = outcome.Result.Correction;

        string Pair(ScenarioComparison entry) =>
            $"  - Pass rate: {Rate(Find(baseline, entry.ScenarioId), settings, "the baseline")} -> "
            + $"{Rate(Find(candidate, entry.ScenarioId), settings, "this run")}";

        string Delta(ScenarioComparison entry) => $"  - Change: {Change(entry, correction)}";

        return
        [
            MarkdownSection.List(
                "Regressions",
                "Passed under the baseline and does not pass under this change."
                    + Confidence(analysis.Regressed, analysis.RegressedSignificant, "regression"),
                analysis.ComparedPairs == 0
                    ? "**Nothing was compared.** No scenario appears in both the baseline and this run in a form "
                        + "that could be diffed, so this report says nothing about whether anything regressed. A "
                        + "count of zero here would mean zero scenarios examined, not zero problems."
                    : $"**No regressions** across {Count(analysis.ComparedPairs)} compared scenario(s). Every "
                        + "scenario present in both artifacts in a comparable form was diffed, and none went from "
                        + "passing to not passing.",
                [
                    .. analysis.Regressed.Select(entry =>
                        string.Join('\n', [Headline(entry, Regression), Pair(entry), Delta(entry)])
                    ),
                ],
                always: true
            ),
            MarkdownSection.List(
                "Not accounted for",
                "**These scenarios reached no classified section of this report, which is a defect in the report "
                    + "rather than a finding about the change.** They are named because a scenario that falls "
                    + "between two sections would otherwise be indistinguishable from one that was never there. "
                    + "Read them from the JSON artifact.",
                string.Empty,
                [.. analysis.Unaccounted.Select(entry => Headline(entry, _ => "reached no classified section."))],
                always: false
            ),
            MarkdownSection.List(
                "Newly covered",
                "What this change fixed, and what it covers newly. This is the reason to run a suite against two "
                    + "variants at all: a harness that reported only what broke would be a worse version of a test "
                    + "suite."
                    + Confidence(analysis.NewlyCovered, analysis.NewlyCoveredSignificant, "coverage claim"),
                "**No scenario is newly covered.** Nothing in this change moved a scenario from not passing to "
                    + "passing, and no new scenario passed.",
                [
                    .. analysis.NewlyCovered.Select(entry =>
                        string.Join('\n', [Headline(entry, Coverage), Pair(entry), Delta(entry)])
                    ),
                ],
                always: true
            ),
            MarkdownSection.List(
                "Coverage claims with no comparison",
                "**The comparison names these scenarios as covered but carries no per-scenario comparison for "
                    + "them.** A claim with no entry behind it is a gap in the record rather than the absence of "
                    + "one, so they are named here — and kept out of the newly-covered count, which reports only "
                    + "the claims an entry supports.",
                string.Empty,
                [.. analysis.Orphans.Select(Orphan)],
                always: false
            ),
            MarkdownSection.List(
                "Not comparable",
                "Both artifacts carry these scenarios, but not in a form that can honestly be diffed. **This run "
                    + "says nothing about whether the change helped or hurt them** — a count of zero beside them "
                    + "would read as agreement."
                    + (analysis.NotComparable.Count == 0 ? string.Empty : "\n\n" + BaselineComparison.RegenerateRemedy),
                "**No pair was refused.** Every scenario present in both artifacts was diffed.",
                [
                    .. analysis.NotComparable.Select(entry =>
                        string.Join(
                            '\n',
                            [
                                Headline(entry, Refusal),
                                Pair(entry),
                                $"  - Reason: {Prose(ComparisonReport.Refusal(entry), MaxReasonCharacters)}",
                            ]
                        )
                    ),
                ],
                always: true
            ),
            MarkdownSection.List(
                "Withheld from coverage",
                Withholding(outcome.Result.NewlyCoveredWithheldReason),
                "**No coverage claim was withheld.** Every newly covered scenario's own record supported the claim.",
                [
                    .. analysis.Withheld.Select(entry =>
                        string.Join('\n', [Headline(entry, Held), Pair(entry), Delta(entry)])
                    ),
                ],
                always: true
            ),
            MarkdownSection.List(
                "New scenarios that did not pass",
                "Added by this change, and not passing. Not a regression — there is no baseline to have regressed "
                    + "from — and not coverage the change gained either.",
                string.Empty,
                [
                    .. analysis.NewNotPassing.Select(entry =>
                        string.Join('\n', [Headline(entry, NewFailing), Pair(entry)])
                    ),
                ],
                always: false
            ),
            MarkdownSection.List(
                "Removed from the suite",
                "Present in the baseline and not in this run's suite. Reported so a scenario that stopped existing "
                    + "is not read as one that stopped failing.",
                string.Empty,
                [.. analysis.Removed.Select(entry => Headline(entry, Retired))],
                always: false
            ),
            MarkdownSection.Aggregate(
                "Unchanged",
                analysis.Unchanged,
                total =>
                    $"{Count(total)} scenario(s) compared the same under both variants: "
                    + $"{Count(analysis.StablePass)} passed under both, {Count(analysis.StableFail)} passed under "
                    + "neither. Collapsed to a count.\n\nScenarios this invocation did not run are never counted "
                    + "here: no candidate evidence about them exists, so they are neither unchanged nor removed."
            ),
            MarkdownSection.List(
                "Not run by this invocation",
                $"These were {ComparisonReport.WithheldReason}."
                    + (
                        artifact is null
                            ? string.Empty
                            : " The whole record of what did run is in the JSON artifact named below."
                    ),
                string.Empty,
                [.. outcome.WithheldScenarios.Select(id => $"- {Code(id)}")],
                always: false
            ),
        ];
    }

    /// <summary>
    /// How much of a section's count the run actually judged real.
    /// </summary>
    /// <remarks>
    /// <b>In the lead, not only in the per-entry detail.</b> A reviewer who reads "Regressions
    /// (1)" under a lead saying it must be acted on has been told a regression was confirmed, and
    /// at the repetition counts an evaluation suite runs at that is frequently not what the
    /// evidence supports. The interval and the adjusted p-value exist so a reader is not misled by
    /// a headline; putting the qualification below the headline reinstates the problem it was
    /// meant to solve.
    /// </remarks>
    private static string Confidence(IReadOnlyList<ScenarioComparison> entries, int significant, string noun)
    {
        if (entries.Count == 0)
        {
            return string.Empty;
        }

        // An explicit verdict, never "not equal to the sentinel". A New scenario has no
        // counterpart to pair against, so its Comparison is null — and reading that through a
        // nullable `!= NotComputed` lifts the null to true and counts a test that never happened.
        // That is the defect class inside the fix for the defect class.
        var tested = entries.Count(entry =>
            entry.Comparison is { Significant: SignificanceVerdict.Significant or SignificanceVerdict.NotSignificant }
        );

        return $" **An observed transition is not by itself a confirmed {noun}.** Of {Count(entries.Count)} here, "
            + $"{Count(significant)} were judged significant against the run's significance level, "
            + $"{Count(tested - significant)} were tested and not judged significant, and "
            + $"{Count(entries.Count - tested)} carried no test at all. Read the `n` and the adjusted p-value on "
            + "each entry before acting.";
    }

    private static string Regression(ScenarioComparison entry) =>
        $"passed under the baseline and now records {ComparisonReport.Name(entry.CandidateOutcome)}.";

    private static string Coverage(ScenarioComparison entry) =>
        entry.Classification == ScenarioClassification.Fixed
            ? "did not pass under the baseline and passes under this change."
            : "new in this change, and it passes.";

    private static string Held(ScenarioComparison entry) =>
        Coverage(entry) + " **The coverage claim is withheld** — see the reason above.";

    private static string NewFailing(ScenarioComparison entry) =>
        $"new in this change, and it recorded {ComparisonReport.Name(entry.CandidateOutcome)}.";

    private static string Retired(ScenarioComparison entry) =>
        $"present in the baseline ({ComparisonReport.Name(entry.BaselineOutcome)}) and absent from this run's suite.";

    private static string Refusal(ScenarioComparison entry) =>
        $"the baseline recorded {ComparisonReport.Name(entry.BaselineOutcome)} and this run recorded "
        + $"{ComparisonReport.Name(entry.CandidateOutcome)}, and the two could not be paired.";

    private static string Headline(ScenarioComparison entry, Func<ScenarioComparison, string> describe) =>
        $"- {Code(entry.ScenarioId)} — {describe(entry)}";

    /// <summary>A coverage claim naming a scenario the comparison carries no entry for.</summary>
    private static string Orphan(string id) => $"- {Code(id)} — no per-scenario comparison accompanies this claim.";

    /// <summary>
    /// The standing explanation of the withheld section, including the comparator's own reason.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>It does not say what went wrong, because the field it has cannot support that.</b> The
    /// comparator withholds a claim for three different reasons — fewer repetitions recorded than
    /// declared, <i>more</i> recorded than declared, or a repetition that produced no verdict —
    /// and an earlier wording here asserted the first of them for every withheld scenario. Nothing
    /// is missing in the over-recorded case, so a reader sent looking for an absent repetition was
    /// looking for something that was never absent.
    /// </para>
    /// <para>
    /// <b>Stated as a claim about the withheld set, not about any one scenario in it.</b>
    /// <see cref="ComparisonResult.NewlyCoveredWithheldReason"/> is a single suite-level string:
    /// where more than one cause occurred it carries every one of their sentences, and nothing in
    /// it says which scenario had which. Splitting it here to guess an attribution would be
    /// exactly the cross-context inference this report exists to refuse.
    /// </para>
    /// </remarks>
    private static string Withholding(string? reason) =>
        "These scenarios classified as newly covered and **the claim is not made**, because the candidate's own "
        + "record of them does not support it: the repetitions it recorded and the repetitions its policy declared "
        + "do not agree, or not every repetition produced a verdict. They are named here rather than dropped — a "
        + "shorter coverage list and a withheld scenario read identically, and a refusal that renders as an absence "
        + "cannot be told from nothing having happened.\n\n"
        + (
            reason is null
                ? "The comparator recorded no reason for this run."
                : "Reason recorded for the withheld set as a whole — the comparator records one reason per run "
                    + "rather than one per scenario, so where more than one cause occurred this carries all of "
                    + $"them and does not say which scenario had which: {Prose(reason, MaxReasonCharacters)}"
        );

    private static Dictionary<string, ScenarioResult> Index(SuiteResult artifact)
    {
        var index = new Dictionary<string, ScenarioResult>(StringComparer.Ordinal);

        foreach (var scenario in artifact.ScenarioResults)
        {
            // First wins. A duplicated id is already refused by the comparator, and picking a
            // side here would be this report inventing a rule the comparison did not apply.
            _ = index.TryAdd(scenario.ScenarioId, scenario);
        }

        return index;
    }

    private static ScenarioResult? Find(Dictionary<string, ScenarioResult> index, string id) =>
        index.TryGetValue(id, out var scenario) ? scenario : null;
}
