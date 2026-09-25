using System.Globalization;
using System.Text;
using Forge.EvalEngine.Results;

namespace Forge.EvalCli.Cli;

/// <summary>What to render, and how much room there is to render it in.</summary>
internal sealed record TrendReportRequest
{
    /// <summary>Gets the trend to render.</summary>
    public required SuiteTrend Trend { get; init; }

    /// <summary>Gets the canonical containment root the marker identity is computed against.</summary>
    public required string RootDirectory { get; init; }

    /// <summary>Gets the directory the artifacts were read from.</summary>
    public required string ArtifactsDirectory { get; init; }

    /// <summary>Gets the character budget the rendering must fit inside.</summary>
    public int CharacterBudget { get; init; } = MarkdownReport.CommentCharacterLimit;
}

/// <summary>
/// Renders a suite's movement across a series of runs, for a human.
/// </summary>
/// <remarks>
/// <para>
/// <b>A different artifact from the comparison report, deliberately.</b> The comparison answers
/// "is this change better or worse than the baseline". This answers "where has this suite been
/// going". Merging them produces a document that answers neither well, and the two carry different
/// markers so CI keeps them in two comments rather than having each push replace the other.
/// </para>
/// <para>
/// <b>Everything here is designed against one failure: a gap rendering as a flat line.</b> That is
/// this report's version of a refusal rendering as an absence, and it is worse here than in the
/// comparison — a reader looking at a trend is specifically looking for movement, so a line that
/// appears steady is a positive claim of stability. Four rules follow, each pinned by a test:
/// </para>
/// <list type="number">
/// <item><description>
/// <b>A position with no record renders as a hole, never as its neighbour's figure.</b> Nothing is
/// interpolated, carried forward, or carried back.
/// </description></item>
/// <item><description>
/// <b>The hole states its shape, and the standing explanation states what that shape can and
/// cannot mean.</b> An artifact records what ran; it records neither suite membership nor the
/// selector's decision, so "not yet present" and "present but not selected" are genuinely not
/// separable from it. That is said rather than collapsed.
/// </description></item>
/// <item><description>
/// <b>Every rate carries the <c>n</c> that produced it and the interval the run recorded.</b> A
/// trend of stochastic rates is <i>more</i> prone to reading noise as signal than a single
/// comparison: a scenario oscillating between 80% and 90% at <c>n=5</c> is one sample drawn
/// repeatedly.
/// </description></item>
/// <item><description>
/// <b>The suite-level figure moves over a population that does not.</b> See
/// <see cref="Population"/>.
/// </description></item>
/// </list>
/// <para>
/// <b>This rendering is never read back.</b> The JSON artifacts are the durable evidence; this is
/// a view of them, and nothing in this tool parses it.
/// </para>
/// </remarks>
internal static class TrendReport
{
    /// <summary>The schema the trend's marker identity is computed under.</summary>
    /// <remarks>
    /// Distinct from the comparison's, which is what keeps the two reports in two comments. Were
    /// they to share a marker over one repository, each push would replace the other's document
    /// and a reader would see a single comment silently alternating between two reports.
    /// </remarks>
    private const string MarkerSchema = "eval-cli/trend/1";

    /// <summary>Renders the trend.</summary>
    /// <param name="request">What to render.</param>
    /// <returns>The rendering, and the accounting of anything it could not fit.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="request"/> is null.</exception>
    /// <exception cref="ArgumentOutOfRangeException">
    /// The budget is below <see cref="MarkdownReport.MinimumCharacterBudget"/>, or below what this
    /// trend's headings and standing explanations cost before a single entry is rendered.
    /// </exception>
    /// <exception cref="InvalidOperationException">Two distinct paths in the series share one alias.</exception>
    public static MarkdownRendering Render(TrendReportRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentOutOfRangeException.ThrowIfLessThan(request.CharacterBudget, MarkdownReport.MinimumCharacterBudget);

        var trend = request.Trend;

        // Hashed from the typed identity of the directory the series was read from, never from a
        // displayed label. A marker fed by a clipped or redacted string collides two distinct
        // trends, and one then silently replaces the other on the pull request.
        var marker = MarkdownReport.MarkerFor(
            MarkerSchema,
            [ReportIdentity.ForPath(request.RootDirectory, request.ArtifactsDirectory)]
        );

        MarkdownReport.RequireDistinctAliases(AliasedValues(trend));

        var sections = Sections(trend);
        var header = Header(marker, trend);
        var footer = Footer(trend);
        var total = sections.Sum(section => section.Entries.Count);
        var skeleton = MarkdownReport.Skeleton(header, sections, footer, total, request.CharacterBudget, Recovery);

        // Refused rather than fitted, for the reason the comparison refuses it: below this the
        // headings, the standing explanations and the footer do not themselves fit, so what came
        // back would be a fragment presented as a report — and in this report the standing
        // explanations are what stop a hole being read as a flat line.
        if (skeleton > request.CharacterBudget)
        {
            throw new ArgumentOutOfRangeException(
                nameof(request),
                request.CharacterBudget,
                $"This trend needs at least {Count(skeleton)} characters for its headings, its standing "
                    + "explanations and its footer, before a single scenario is rendered. A smaller budget cannot "
                    + "carry a report whose sections are all present."
            );
        }

        var everything = (int[])[.. sections.Select(section => section.Entries.Count)];
        var untruncated = MarkdownReport.Assemble(header, banner: null, sections, everything, footer, Recovery);

        if (untruncated.Length <= request.CharacterBudget)
        {
            return MarkdownReport.Complete(
                untruncated,
                marker,
                sections,
                truncated: false,
                everything,
                request.CharacterBudget
            );
        }

        var shown = MarkdownReport.Allocate(request.CharacterBudget - skeleton, sections);
        var banner = MarkdownReport.Banner(total - shown.Sum(), total, request.CharacterBudget, Recovery);

        return MarkdownReport.Complete(
            MarkdownReport.Assemble(header, banner, sections, shown, footer, Recovery),
            marker,
            sections,
            truncated: true,
            shown,
            request.CharacterBudget
        );
    }

    /// <summary>
    /// Every value in this document that came from somebody else, as the alias check must see it.
    /// </summary>
    /// <param name="trend">The trend being rendered.</param>
    /// <returns>The values, including duplicates, which the check ignores.</returns>
    /// <remarks>
    /// The artifact labels are here as well as the identifiers, because a label is a path and a
    /// path is what the redaction net aliases. Two different checkout directories aliasing to one
    /// string would make two positions in the series indistinguishable — the disappearance the
    /// alias exists to prevent, landing on the axis rather than on a row.
    /// </remarks>
    /// <exception cref="ArgumentNullException"><paramref name="trend"/> is null.</exception>
    internal static IReadOnlyList<string?> AliasedValues(SuiteTrend trend)
    {
        ArgumentNullException.ThrowIfNull(trend);

        return
        [
            trend.SuiteName,
            .. trend.Artifacts.Select(artifact => artifact.Label),
            .. trend.Series.Select(series => series.ScenarioId),
        ];
    }

    /// <summary>The marker, the title, and the one line a reviewer reads before anything else.</summary>
    private static string Header(string marker, SuiteTrend trend)
    {
        var text = new StringBuilder();

        // First, and on its own line. CI finds the comment it is replacing by searching the raw
        // text for this; anything before it is one more thing that could move.
        text.Append("<!-- eval-cli:trend:").Append(marker).Append(" -->\n");
        text.Append("## Evaluation trend — ").Append(Code(trend.SuiteName)).Append("\n\n");

        var gaps = trend.Series.Sum(series => series.InteriorGaps);

        text.Append("> **")
            .Append(Count(trend.Artifacts.Count))
            .Append(" run(s), ")
            .Append(Instant(trend.Artifacts[0]))
            .Append(" to ")
            .Append(Instant(trend.Artifacts[^1]))
            .Append(".** ")
            .Append(Headline(trend))
            .Append(' ')
            .Append(Count(trend.Appeared.Count))
            .Append(" newly appeared, ")
            .Append(Count(trend.Disappeared.Count))
            .Append(" no longer recorded, ")
            .Append(Count(gaps))
            .Append(
                gaps == 0
                    ? " gap(s) inside the record."
                    : " gap(s) inside the record — **a gap is not a flat line**, see below."
            );

        return text.Append('\n').ToString();
    }

    /// <summary>
    /// The one figure a reader who stops at the first line takes away.
    /// </summary>
    /// <remarks>
    /// The empty-core case leads with the refusal rather than with a number, because a headline is
    /// where a missing population does the most damage: a reader who takes one figure away from
    /// this document must not take away one that was never computable.
    /// </remarks>
    private static string Headline(SuiteTrend trend) =>
        trend.StableCore.Count == 0
            ? "**No suite-level rate is reported**: no scenario was graded in every artifact, so there is no "
                + "population a suite figure could move over."
            : $"Stable-core pass rate {Rate(trend.Positions[0], trend)} → {Rate(trend.Positions[^1], trend)}.";

    /// <summary>
    /// Builds every section, in the order the report contracts to render them.
    /// </summary>
    /// <remarks>
    /// <b>This order is both the layout and the truncation priority.</b> The roster comes first
    /// because every position number below it is unreadable without it, and the gaps come next
    /// because they are what this report exists to make visible. Entries are allocated as a strict
    /// prefix of this sequence, so the same series and the same budget always produce the same
    /// bytes.
    /// </remarks>
    private static IReadOnlyList<MarkdownSection> Sections(SuiteTrend trend)
    {
        var holed = trend.Series.Where(series => series.Recorded < trend.Artifacts.Count).ToArray();

        return
        [
            MarkdownSection.List(
                "The series",
                "**Ordered by the start time each run recorded in its own artifact, and by nothing else.** Never by "
                    + "file name, which whoever wrote the artifact chose, and never by modification time, which a "
                    + "copy, a checkout or an artifact-download step rewrites. Two runs stamped with the same "
                    + "instant are refused rather than ordered on either of those.",
                string.Empty,
                [.. trend.Positions.Select(position => Roster(position, trend))],
                always: true
            ),
            MarkdownSection.Aggregate("Suite-level movement", trend.StableCore.Count, core => Population(trend, core)),
            MarkdownSection.List(
                "Gaps in the record",
                GapExplanation,
                "**No scenario is missing from any artifact in this series.** Every scenario any run recorded was "
                    + "recorded by all of them, so no line below crosses a hole.",
                [.. holed.Select(series => Gaps(series, trend))],
                always: true
            ),
            MarkdownSection.List(
                "Per-scenario series",
                "One line per run, in series order. **A position with no record is printed as a hole and nothing is "
                    + "drawn across it** — no figure is carried forward, carried back, or interpolated. Every rate "
                    + "is the figure that run recorded, with the `n` it rests on and the interval it was recorded "
                    + "with; nothing here is recomputed, and no significance test is run anywhere in this report.",
                string.Empty,
                [.. trend.Series.Select(series => Scenario(series, trend))],
                always: true
            ),
            MarkdownSection.List(
                "Newly appeared",
                "Scenarios first recorded after the first artifact in this series. **That is a statement about the "
                    + "record, not about the suite**: an artifact does not say what the suite contained, so a "
                    + "scenario that existed all along and was selected for the first time appears here too.",
                "**No scenario is newly recorded.** Every scenario in this series was recorded by the first "
                    + "artifact in it.",
                [.. trend.Appeared.Select(Entry)],
                always: true
            ),
            MarkdownSection.List(
                "No longer recorded",
                "Scenarios last recorded before the final artifact. **Also a statement about the record**: this is "
                    + "consistent with removal from the suite and with a scenario that has simply not been selected "
                    + "since, and nothing in the artifacts distinguishes the two. Named so a scenario that stopped "
                    + "being measured is not read as one that stopped failing.",
                "**No scenario stopped being recorded.** Every scenario in this series was recorded by the final "
                    + "artifact in it.",
                [.. trend.Disappeared.Select(Entry)],
                always: true
            ),
            MarkdownSection.List(
                "Settings that moved",
                "**These are reasons the series could move that are not behaviour.** They do not decide what a "
                    + "printed figure means — the interval settings do, and a series disagreeing on those was "
                    + "refused before this report was built — but they do change what a run observes, so they are "
                    + "named at the position they changed rather than used to destroy the series."
                    + Withheld(trend.UnnamedSettingChanges),
                trend.UnnamedSettingChanges == 0
                    ? string.Empty
                    : "**No setting this build recognises moved.**" + Withheld(trend.UnnamedSettingChanges),
                [.. trend.Caveats.Select(Caveat)],
                always: trend.UnnamedSettingChanges > 0
            ),
        ];
    }

    /// <summary>
    /// What a hole in the record can and cannot be read as.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>The centrepiece of this report.</b> A <c>SuiteResult</c> carries the scenarios that ran.
    /// It carries no statement of the suite's membership and no record of the selector's decision,
    /// so three of the four causes a reader cares about are not separable from it. Naming the
    /// three rather than picking one is the whole point: a report that guessed "not yet present"
    /// for a scenario that was present and skipped would be exactly the cross-context inference
    /// this repository keeps producing.
    /// </para>
    /// <para>
    /// What <i>is</i> separable is marked as such: a scenario that ran and produced no verdict is
    /// recorded, and reads differently from one that is absent.
    /// </para>
    /// </remarks>
    private const string GapExplanation =
        "**A gap is not a flat line, and nothing in this report is drawn across one.**\n\n"
        + "An artifact records the scenarios that ran. It records neither the suite's membership nor the selector's "
        + "decision, so of the four things a missing scenario could mean, only one is decidable from the "
        + "artifacts:\n\n"
        + "- **Selected but ungradeable** — *decidable.* The scenario is in the artifact, it ran, and no repetition "
        + "produced a verdict. It is printed as its own state and is never a pass rate of zero.\n"
        + "- **Not yet present** — *not separable.* No artifact records it at or before that position.\n"
        + "- **Present but not selected** — *not separable.* Nothing in an artifact distinguishes a scenario the "
        + "selector skipped from one that was not in the suite at all.\n"
        + "- **Absent for an unknown reason** — *not separable.* A run that errored before it could record the "
        + "scenario leaves the same hole as the two above.\n\n"
        + "What the series does establish is **where the hole sits**, and each position narrows the causes it is "
        + "consistent with. Each line below says which — and for the ones that remain, **the artifact does not say "
        + "which applies**. Closing that would take a field in the artifact recording what the selector decided; "
        + "there is none, and inferring one from the shape of the record would be the same defect wearing a "
        + "different hat.";

    /// <summary>
    /// The population the suite-level figure moves over, and why it is held still.
    /// </summary>
    /// <param name="trend">The trend being rendered.</param>
    /// <param name="core">How many scenarios are in the stable core.</param>
    /// <returns>The standing explanation, and the movement when there is a population to state one over.</returns>
    /// <remarks>
    /// <b>The subtle one.</b> A suite figure averaged over whatever each artifact happened to
    /// carry moves when the <i>population</i> changes rather than when <i>behaviour</i> does — a
    /// suite that dropped its three worst scenarios would read as a suite that improved, and one
    /// that added three failing scenarios would read as a regression nobody caused. So the figure
    /// is pooled over the scenarios graded at <i>every</i> position and the rest are named rather
    /// than averaged in. It is stated in the report and not only here, because a reader cannot
    /// check a population they were never told about.
    /// </remarks>
    private static string Population(SuiteTrend trend, int core)
    {
        var preamble =
            "**Computed over the stable core: the scenarios graded in every artifact in this series.** A suite "
            + "figure pooled over whatever each run happened to carry moves when the population changes rather than "
            + "when behaviour does — dropping three failing scenarios would read as an improvement nobody earned. "
            + $"{Count(core)} scenario(s) are in the core and {Count(trend.Series.Count - core)} are outside it; "
            + "those outside appear in the per-scenario series below with their own figures, and in no line here."
            + "\n\n";

        if (core == 0)
        {
            return preamble
                + "**No suite-level rate is reported for this series, because no scenario was graded in every "
                + "artifact.** A rate pooled over whatever was present at each position would be a different "
                + "measurement at every position, and a zero here would read as a suite that failed everything "
                + "rather than as a population that never held still. The per-scenario series below is what this "
                + "directory supports.";
        }

        var first = trend.Positions[0];
        var last = trend.Positions[^1];
        var movement = ((double)last.CorePassed / last.CoreGraded) - ((double)first.CorePassed / first.CoreGraded);

        return preamble
            + $"**{Rate(first, trend)} → {Rate(last, trend)}**, a movement of {Points(movement)} points across "
            + $"{Count(trend.Artifacts.Count)} run(s).\n\n"
            + "**No interval is reported beside a suite figure, and that is not an omission.** Pooling repetitions "
            + "of different scenarios is not a single binomial experiment — the repetitions are not draws from one "
            + "process — so an interval computed over them would have the shape of evidence and none of its "
            + "meaning. The per-scenario intervals below are the ones the runs actually recorded. No significance "
            + "test backs the movement above; none was run.";
    }

    /// <summary>One artifact's row in the roster: when, where from, and what it covered.</summary>
    private static string Roster(TrendPosition position, SuiteTrend trend)
    {
        var text =
            $"- **{Count(position.Position)}.** {Instant(position.Artifact)} — {Code(position.Artifact.Label)} — "
            + $"{Count(position.ScenariosRecorded)} scenario(s) recorded";

        return trend.StableCore.Count == 0
            ? text + "; no stable core, so no suite figure."
            : $"{text}; core {Rate(position, trend)}.";
    }

    /// <summary>The suite-level rate at one position, never without the denominator it rests on.</summary>
    private static string Rate(TrendPosition position, SuiteTrend trend) =>
        position.CoreGraded == 0
            ? "no rate — the stable core is empty"
            : $"{Percent((double)position.CorePassed / position.CoreGraded)} (n={Count(position.CoreGraded)} graded "
                + $"repetition(s) across {Count(trend.StableCore.Count)} core scenario(s))";

    /// <summary>One scenario's whole series, one line per run.</summary>
    private static string Scenario(TrendSeries series, SuiteTrend trend)
    {
        var lines = new List<string>
        {
            $"- {Code(series.ScenarioId)} — graded at {Count(series.Graded)} of "
                + $"{Count(trend.Artifacts.Count)} position(s)"
                + (series.InStableCore ? ", in the stable core." : ", outside the stable core."),
        };

        foreach (var observation in series.Observations)
        {
            lines.Add($"  - **{Count(observation.Position)}.** {Cell(observation, trend)}");
        }

        lines.Add($"  - Movement: {Movement(series, trend)}");

        return string.Join('\n', lines);
    }

    /// <summary>
    /// What one artifact said about one scenario, at one position.
    /// </summary>
    /// <remarks>
    /// A recorded figure goes through <see cref="MarkdownReport.Rate"/> — the renderer the
    /// comparison report uses — so a summary that disagrees with its own runs is withheld here for
    /// the same reason and in the same words. A position with no record gets a hole naming its
    /// shape; <see cref="GapExplanation"/> says what each shape narrows the causes to.
    /// </remarks>
    private static string Cell(TrendObservation observation, SuiteTrend trend) =>
        observation.Gap switch
        {
            TrendGap.BeforeFirstRecord => "**no record** — no artifact up to this point records it",
            TrendGap.Interior =>
                "**no record** — a gap: artifacts on both sides of this one record it and this one does not",
            TrendGap.AfterLastRecord => "**no record** — no artifact from this point on records it",
            _ => MarkdownReport.Rate(observation.Recorded, trend.Settings, $"run {Count(observation.Position)}"),
        };

    /// <summary>
    /// Where a scenario moved between its first and last graded position, with both denominators.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Between graded positions only, and never across a hole.</b> The endpoints are the first
    /// and last positions that produced a figure; whatever happened between them is printed
    /// individually above and is not smoothed into this line.
    /// </para>
    /// <para>
    /// <b>A difference of two recorded rates, not a statistic.</b> No test is run here and none is
    /// available: the artifacts in a series are independent runs rather than a matched pair, so
    /// there is nothing for a paired test to pair. Whether the two recorded intervals overlap is
    /// stated because it is checkable from the figures on the page — and stated carefully, because
    /// overlap does not establish that two rates are equal.
    /// </para>
    /// </remarks>
    private static string Movement(TrendSeries series, SuiteTrend trend)
    {
        var graded = series.GradedObservations;

        if (graded.Count == 0)
        {
            return "never graded in this series, so no rate of its own was ever recorded. It has no movement, which "
                + "is not the same as not having moved.";
        }

        if (graded.Count == 1)
        {
            return "graded once in this series, so it has no movement to state. One observation is a measurement, "
                + "not a direction.";
        }

        var first = graded[0];
        var last = graded[^1];
        var from = first.Recorded!.Summary!;
        var to = last.Recorded!.Summary!;

        return $"{Points(to.PointEstimate - from.PointEstimate)} points, {Percent(from.PointEstimate)} "
            + $"(n={Count(from.N)}) at position {Count(first.Position)} → {Percent(to.PointEstimate)} "
            + $"(n={Count(to.N)}) at position {Count(last.Position)}. {Overlap(first, last, trend)} "
            + "**No significance test backs this**: the runs in a series are independent rather than a matched "
            + "pair, so there is nothing for a paired test to pair, and none was run.";
    }

    /// <summary>
    /// Whether the two endpoint intervals overlap, said only where both may be shown at all.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Conditional on the same judgement that decides whether the bounds are printed.</b>
    /// <see cref="MarkdownReport.DisplayedInterval"/> is asked, not
    /// <c>Summary.Interval</c> — because a value untrustworthy enough to withhold from display is
    /// not trustworthy enough to reason from, and the two judgements are one judgement. An
    /// artifact recording no interval settings carries bounds nothing could check; a single
    /// observation carries bounds that span most of the unit interval and are suppressed for
    /// exactly that reason. Comparing either would reinstate the reading the page declined to
    /// offer.
    /// </para>
    /// <para>
    /// <b>This sentence is the honest-making part of the movement line, which is what makes
    /// getting it wrong expensive.</b> A reader who sees "the intervals overlap, so these figures
    /// alone do not establish movement" trusts the report <i>more</i>, so a fabricated version of
    /// it buys false confidence at precisely the point warranted confidence was being offered.
    /// </para>
    /// <para>
    /// Where it can be said: non-overlap is suggestive of a real difference and overlap
    /// establishes nothing either way. The implication runs one way only, and the common reading
    /// — "they overlap, therefore the rate did not move" — is a fallacy. Both branches say what
    /// the observation does <i>not</i> license, and neither uses the word "significant", which no
    /// figure on this page is entitled to.
    /// </para>
    /// </remarks>
    private static string Overlap(TrendObservation first, TrendObservation last, SuiteTrend trend)
    {
        if (
            MarkdownReport.DisplayedInterval(first.Recorded, trend.Settings) is not { } left
            || MarkdownReport.DisplayedInterval(last.Recorded, trend.Settings) is not { } right
        )
        {
            return "At least one end carries **no interval this report is willing to show** — see its line above — "
                + "so the two cannot be set against each other even informally.";
        }

        return left.Lower <= right.Upper && right.Lower <= left.Upper
            ? "The intervals recorded at the two ends **overlap**, so these two figures alone do not establish that "
                + "the rate moved at all."
            : "The intervals recorded at the two ends do **not** overlap. That is suggestive and it is not a test — "
                + "it says nothing about how likely this difference was to have arisen by chance.";
    }

    /// <summary>One scenario's holes, named by shape and position.</summary>
    private static string Gaps(TrendSeries series, SuiteTrend trend)
    {
        var parts = series
            .Observations.Where(entry => entry.Gap != TrendGap.None)
            .GroupBy(entry => entry.Gap)
            .OrderBy(group => (int)group.Key)
            .Select(group =>
                $"{Shape(group.Key)} at position(s) {string.Join(", ", group.Select(entry => Count(entry.Position)))}"
            );

        return $"- {Code(series.ScenarioId)} — recorded in {Count(series.Recorded)} of "
            + $"{Count(trend.Artifacts.Count)} artifact(s): {string.Join("; ", parts)}.";
    }

    /// <summary>What one shape of hole narrows the causes to.</summary>
    private static string Shape(TrendGap gap) =>
        gap switch
        {
            TrendGap.BeforeFirstRecord => "**no record yet** — not yet present, or present and not selected",
            TrendGap.Interior =>
                "**a gap inside the record** — not selected, errored before it could be recorded, or removed and "
                    + "restored",
            TrendGap.AfterLastRecord => "**no record since** — removed from the suite, or not selected since",
            _ => "recorded",
        };

    /// <summary>The provenance, the pointer to the durable record, and the checkable arithmetic.</summary>
    private static string Footer(SuiteTrend trend)
    {
        var text = new StringBuilder("\n---\n\n");
        var gaps = trend.Series.Sum(series => series.InteriorGaps);

        text.Append("**Suite** ")
            .Append(Code(trend.SuiteName))
            .Append(" · **runs** ")
            .Append(Count(trend.Artifacts.Count))
            .Append(", from ")
            .Append(Instant(trend.Artifacts[0]))
            .Append(" to ")
            .Append(Instant(trend.Artifacts[^1]))
            .Append(", ordered by the start time each run recorded and never by file name or modification time.\n\n");

        text.Append("**Full record** — ")
            .Append(Recovery)
            .Append(
                " The JSON artifacts are the durable evidence; this Markdown is a rendering of them, is **never "
                    + "read back**, and is never itself trended against.\n\n"
            );

        text.Append(
            "**Statistics** — a pass rate is conditional on the repetitions that produced a verdict, so an errored "
                + "repetition lowers `n` rather than counting as a failure. Every interval here is the figure the "
                + "run recorded; this report surfaces them and computes none of its own, and runs no significance "
                + "test anywhere.\n\n"
        );

        // The arithmetic, printed so a reader can check it. A scenario that fell between the core
        // and the named lists shows up as a mismatch in this line rather than as a silence.
        text.Append("**Accounting** — ")
            .Append(Count(trend.StableCore.Count))
            .Append(" in the stable core + ")
            .Append(Count(trend.Series.Count - trend.StableCore.Count))
            .Append(" outside it = ")
            .Append(Count(trend.Series.Count))
            .Append(" scenario(s) recorded by at least one artifact in this series. ")
            .Append(Count(trend.Appeared.Count))
            .Append(" first recorded after the first run, ")
            .Append(Count(trend.Disappeared.Count))
            .Append(" last recorded before the final run, ")
            .Append(Count(gaps))
            .Append(" gap(s) inside the record. ")
            .Append(
                trend.Caveats.Count == 0 && trend.UnnamedSettingChanges == 0
                    ? "No harness setting moved during the series."
                    : $"{Count(trend.Caveats.Count)} harness setting change(s) are named above and "
                        + $"{Count(trend.UnnamedSettingChanges)} are counted there without being named."
            );

        return text.Append('\n').ToString();
    }

    /// <summary>
    /// Where the omitted entries can be read.
    /// </summary>
    /// <remarks>
    /// Unconditional, unlike the comparison's: this command's input <i>is</i> a directory of
    /// artifacts, so there is always a fuller record and it is always the thing the caller already
    /// pointed at.
    /// </remarks>
    private const string Recovery =
        "The whole record is the JSON artifacts in the directory this trend was read from — the same directory "
        + "`--artifacts` named.";

    /// <summary>
    /// What is said about a setting that changed and whose contents this build cannot vouch for.
    /// </summary>
    /// <remarks>
    /// <b>Counted rather than named, and counted rather than dropped.</b>
    /// <c>HarnessConfig</c> is an open map of strings in a file anyone can write, so a key this
    /// build does not recognise could carry anything — a token parked in a setting reaches a
    /// pull-request comment and the build log through a caveat. Naming neither the key nor the
    /// value is the only form that leaks nothing; saying nothing at all would make a setting that
    /// moved indistinguishable from one that did not, which is this report's own failure mode
    /// applied to its own caveats.
    /// </remarks>
    private static string Withheld(int unnamed) =>
        unnamed == 0
            ? string.Empty
            : $"\n\n**{Count(unnamed)} harness setting(s) this build does not recognise also changed, and neither "
                + "their names nor their values are printed.** An artifact is a file anyone can write and this "
                + "report is published; a setting this build cannot re-derive a typed value from could carry "
                + "anything. Read them from the JSON artifacts, which you already have.";

    private static string Caveat(TrendCaveat caveat) =>
        $"- {Code(caveat.Setting)} changed at position {Count(caveat.Position)}, from {Code(caveat.Before)} to "
        + $"{Code(caveat.After)}.";

    private static string Entry(string id) => $"- {Code(id)}";

    /// <summary>
    /// One artifact's start time, at the precision the series is ordered on.
    /// </summary>
    /// <remarks>
    /// Through <see cref="SuiteTrend.Instant"/> so the roster, the header, the footer and the
    /// tie refusal cannot disagree about what a timestamp is. Seconds rendered two correctly
    /// ordered runs identically, which — printed beside a refusal about runs stamped with the
    /// same instant — reads as a tool that failed to make its own check. Correct behaviour that
    /// looks wrong is its own defect.
    /// </remarks>
    private static string Instant(TrendArtifact artifact) => SuiteTrend.Instant(artifact.Result.Environment.Timestamp);

    private static string Points(double value) => (value * 100).ToString("+0.#;-0.#;0", CultureInfo.InvariantCulture);

    private static string Code(string? value) => MarkdownReport.Code(value);

    private static string Percent(double value) => MarkdownReport.Percent(value);

    private static string Count(int value) => MarkdownReport.Count(value);
}
