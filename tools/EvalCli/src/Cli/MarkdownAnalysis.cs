using System.Globalization;
using Forge.EvalEngine.Comparison;
using Forge.EvalEngine.Results;

namespace Forge.EvalCli.Cli;

/// <summary>One withheld coverage claim, paired with the comparison entry that names it.</summary>
/// <param name="Comparison">The scenario's comparison, which carries its rates and its change.</param>
/// <param name="Cause">What the comparator attributed the withholding to.</param>
/// <remarks>
/// Paired here rather than looked up again at render time. The section renders both, and a
/// renderer that re-resolved the cause from the scenario id would be a second lookup that can
/// disagree with the one the partition was built from — the row saying one cause and the
/// accounting having used another.
/// </remarks>
internal sealed record WithheldComparison(ScenarioComparison Comparison, CoverageWithholdingCause Cause);

/// <summary>
/// The partition of a comparison into the sections the report renders.
/// </summary>
/// <remarks>
/// <b>Total and disjoint, by construction.</b> Every <see cref="ScenarioComparison"/> the
/// comparator produced lands in exactly one list here, and <see cref="Unaccounted"/> exists so
/// that a shape this partition did not anticipate is <i>visible</i> rather than quietly folded
/// into the unchanged count. It should always be empty; if it is not, the report says so and the
/// footer's arithmetic stops balancing, which is the point.
/// </remarks>
internal sealed record ComparisonAnalysis
{
    /// <summary>Gets the scenarios that passed under the baseline and do not now.</summary>
    public required IReadOnlyList<ScenarioComparison> Regressed { get; init; }

    /// <summary>Gets the scenarios whose coverage this change is claiming.</summary>
    public required IReadOnlyList<ScenarioComparison> NewlyCovered { get; init; }

    /// <summary>Gets the scenarios whose coverage claim the comparator withheld, with each one's cause.</summary>
    public required IReadOnlyList<WithheldComparison> Withheld { get; init; }

    /// <summary>Gets the pairs that could not honestly be diffed.</summary>
    public required IReadOnlyList<ScenarioComparison> NotComparable { get; init; }

    /// <summary>Gets the scenarios new in this change that did not pass.</summary>
    public required IReadOnlyList<ScenarioComparison> NewNotPassing { get; init; }

    /// <summary>Gets the scenarios the baseline carries and this run does not.</summary>
    public required IReadOnlyList<ScenarioComparison> Removed { get; init; }

    /// <summary>Gets the scenarios no branch of the partition claimed. Always empty in a sound build.</summary>
    public required IReadOnlyList<ScenarioComparison> Unaccounted { get; init; }

    /// <summary>
    /// Gets the coverage claims naming a scenario the comparison carries no entry for.
    /// </summary>
    /// <remarks>
    /// Defensive, and rendered rather than dropped. The comparator builds both lists from the
    /// comparisons, so this cannot happen today — but it is a nullable-free list on a record this
    /// tool does not own, and the failure mode of getting it wrong is a scenario that disappears.
    /// </remarks>
    public required IReadOnlyList<string> Orphans { get; init; }

    /// <summary>Gets how many scenarios passed under both variants.</summary>
    public required int StablePass { get; init; }

    /// <summary>Gets how many scenarios passed under neither.</summary>
    public required int StableFail { get; init; }

    /// <summary>Gets how many scenarios were genuinely diffed as a pair.</summary>
    /// <remarks>
    /// The denominator behind "no regressions". A zero here means nothing was examined, which is
    /// not the same claim and must never be rendered as the same claim.
    /// </remarks>
    public required int ComparedPairs { get; init; }

    /// <summary>Gets how many of the regressions the run judged significant.</summary>
    /// <remarks>
    /// <b>An observed transition is not a confirmed regression.</b> A scenario that passed five
    /// times and now fails five times is one observation of a change, and at the repetition counts
    /// this harness runs at the adjusted p-value frequently does not support calling it real. The
    /// count is carried here so the summary and the section lead can say so, rather than leaving
    /// the caveat in the per-entry detail under a heading a reader may not read past.
    /// </remarks>
    public required int RegressedSignificant { get; init; }

    /// <summary>Gets how many of the coverage claims the run judged significant.</summary>
    public required int NewlyCoveredSignificant { get; init; }

    /// <summary>Gets how many scenarios the comparison carries entries for.</summary>
    public required int Entries { get; init; }

    /// <summary>Gets how many scenarios were unchanged.</summary>
    public int Unchanged => StablePass + StableFail;

    /// <summary>
    /// Gets how many entries reached one of the report's classified sections.
    /// </summary>
    /// <remarks>
    /// <b><see cref="Unaccounted"/> is deliberately not a term here.</b> This subtotal is what the
    /// footer checks against <see cref="Entries"/>, and putting the catch-all on the same side of
    /// that equation makes it balance however the partition behaves — a check that cannot fail,
    /// offered as the protection against a scenario falling between two sections. Excluded, the
    /// difference is exactly the number of entries no classified section claimed, and the footer
    /// states it.
    /// </remarks>
    public int Classified =>
        Regressed.Count
        + NewlyCovered.Count
        + NotComparable.Count
        + Withheld.Count
        + NewNotPassing.Count
        + Removed.Count
        + Unchanged;
}

internal static partial class MarkdownReport
{
    /// <summary>The schema the marker identity is computed under, so a later change is legible.</summary>
    private const string MarkerSchema = "eval-cli/report/1";

    /// <summary>The longest scenario identifier that reaches the document.</summary>
    internal const int MaxIdentifierCharacters = 160;

    /// <summary>The longest explanatory text — a refusal reason, a withholding reason — that reaches it.</summary>
    internal const int MaxReasonCharacters = 1_200;

    /// <summary>The longest path or address that reaches it.</summary>
    internal const int MaxPathCharacters = 400;

    /// <summary>What marks a value this renderer shortened, so a clip is never silent.</summary>
    private const string ClipMarker = " [clipped]";

    /// <summary>
    /// What replaces an HTML comment delimiter found in author-supplied text.
    /// </summary>
    /// <remarks>
    /// CI finds this report's comment by searching the raw text for the marker. A suite author
    /// names the scenarios, so without this a scenario id could plant a second marker and send a
    /// find-and-replace at the wrong comment — evidence from one context presented as another, in
    /// the one field a reader never inspects. Replaced visibly rather than stripped, because a
    /// silent edit to an identifier is its own small forgery.
    /// </remarks>
    private const string CommentMarkerRemoved = "[html-comment-delimiter-removed]";

    /// <summary>Partitions the comparison into the sections the report renders.</summary>
    /// <param name="outcome">The comparison that happened.</param>
    /// <returns>The partition.</returns>
    private static ComparisonAnalysis Analyse(ComparisonOutcome outcome)
    {
        var result = outcome.Result;
        var covered = result.NewlyCovered.ToHashSet(StringComparer.Ordinal);

        // Keyed on the identifier, which is what every branch below asks about. The list is a
        // list of records now, and a set of records would answer "is this scenario withheld?"
        // with "no" for every scenario — silently moving each one into the newly-covered
        // section, which is the coverage claim the comparator explicitly refused to make.
        var withheld = new Dictionary<string, CoverageWithholdingCause>(StringComparer.Ordinal);

        foreach (var entry in result.NewlyCoveredWithheld)
        {
            // First wins, matching Index below: a duplicated id is the comparator's to refuse,
            // and picking a side here would be this report inventing a rule the comparison did
            // not apply.
            _ = withheld.TryAdd(entry.ScenarioId, entry.Cause);
        }

        List<ScenarioComparison> regressed = [];
        List<ScenarioComparison> newlyCovered = [];
        List<WithheldComparison> withheldEntries = [];
        List<ScenarioComparison> notComparable = [];
        List<ScenarioComparison> newNotPassing = [];
        List<ScenarioComparison> removed = [];
        List<ScenarioComparison> unaccounted = [];

        var stablePass = 0;
        var stableFail = 0;
        var pairs = 0;

        foreach (var comparison in result.ScenarioComparisons)
        {
            if (
                comparison.Classification
                is ScenarioClassification.StablePass
                    or ScenarioClassification.StableFail
                    or ScenarioClassification.Fixed
                    or ScenarioClassification.Regressed
            )
            {
                pairs++;
            }

            // Ordered by what a reviewer must not miss, and total: the last branch is a named
            // list rather than a fall-through into "unchanged", because a Fixed scenario silently
            // counted as unchanged is exactly the class of defect this report is designed against.
            switch (comparison)
            {
                case { Classification: ScenarioClassification.Regressed }:
                    regressed.Add(comparison);
                    break;

                case { Classification: ScenarioClassification.NotComparable }:
                    notComparable.Add(comparison);
                    break;

                case var entry when withheld.TryGetValue(entry.ScenarioId, out var cause):
                    withheldEntries.Add(new WithheldComparison(comparison, cause));
                    break;

                case var entry when covered.Contains(entry.ScenarioId):
                    newlyCovered.Add(comparison);
                    break;

                case { Classification: ScenarioClassification.New }:
                    newNotPassing.Add(comparison);
                    break;

                case { Classification: ScenarioClassification.Removed }:
                    removed.Add(comparison);
                    break;

                case { Classification: ScenarioClassification.StablePass }:
                    stablePass++;
                    break;

                case { Classification: ScenarioClassification.StableFail }:
                    stableFail++;
                    break;

                default:
                    unaccounted.Add(comparison);
                    break;
            }
        }

        var named = result.ScenarioComparisons.Select(entry => entry.ScenarioId).ToHashSet(StringComparer.Ordinal);

        return new ComparisonAnalysis
        {
            Regressed = regressed,
            NewlyCovered = newlyCovered,
            Withheld = withheldEntries,
            NotComparable = notComparable,
            NewNotPassing = newNotPassing,
            Removed = removed,
            Unaccounted = unaccounted,
            Orphans =
            [
                .. covered
                    .Concat(withheld.Keys)
                    .Where(id => !named.Contains(id))
                    .Distinct(StringComparer.Ordinal)
                    .Order(StringComparer.Ordinal),
            ],
            StablePass = stablePass,
            StableFail = stableFail,
            ComparedPairs = pairs,
            RegressedSignificant = regressed.Count(Significant),
            NewlyCoveredSignificant = newlyCovered.Count(Significant),
            Entries = result.ScenarioComparisons.Count,
        };
    }

    /// <summary>Whether the run judged this scenario's change significant.</summary>
    private static bool Significant(ScenarioComparison comparison) =>
        comparison.Comparison?.Significant == SignificanceVerdict.Significant;

    internal static string Count(int value) => value.ToString(CultureInfo.InvariantCulture);
}
