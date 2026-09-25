using System.Globalization;
using System.Text;
using Forge.EvalEngine.Comparison;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Statistics;

namespace Forge.EvalCli.Cli;

internal static partial class MarkdownReport
{
    /// <summary>The marker, the title, and the one line a reviewer reads before anything else.</summary>
    private static string Header(string marker, string suiteName, ComparisonAnalysis analysis)
    {
        var text = new StringBuilder();

        // First, and on its own line. CI finds the comment it is replacing by searching the raw
        // text for this; anything before it is one more thing that could move.
        text.Append("<!-- eval-cli:report:").Append(marker).Append(" -->\n");
        text.Append("## Evaluation report — ").Append(Code(suiteName)).Append("\n\n");

        // The headline leads. What a change fixed is the reason this harness exists, and a
        // summary that opened with the regression count would teach a reader that coverage is a
        // footnote. The sections below then run regressions-first, which is the order to act in.
        text.Append(
            analysis.ComparedPairs == 0
                ? "> **Nothing was compared.** No scenario appears in both the baseline and this run in a form "
                    + "that could be diffed, so no count in this report is evidence that nothing regressed. "
                    + $"Newly covered: {Claim(analysis.NewlyCovered.Count, analysis.NewlyCoveredSignificant)}. "
                    + $"Not comparable: {Count(analysis.NotComparable.Count)}. "
                    + $"Coverage claims withheld: {Count(analysis.Withheld.Count)}."
                : $"> **Newly covered: {Claim(analysis.NewlyCovered.Count, analysis.NewlyCoveredSignificant)}.** "
                    + $"Regressions: {Claim(analysis.Regressed.Count, analysis.RegressedSignificant)}. "
                    + $"Compared: {Count(analysis.ComparedPairs)} scenario(s). "
                    + $"Not comparable: {Count(analysis.NotComparable.Count)}. "
                    + $"Coverage claims withheld: {Count(analysis.Withheld.Count)}. "
                    + $"Unchanged: {Count(analysis.Unchanged)}."
        );

        return text.Append('\n').ToString();
    }

    /// <summary>
    /// A count of observed transitions, qualified by how many the run judged real.
    /// </summary>
    /// <remarks>
    /// <b>In the summary, not only in the detail.</b> A reviewer who reads the first line and
    /// stops must not come away believing a regression was confirmed when the adjusted p-value
    /// did not support it. Carrying `n` and an interval beside every rate exists precisely so a
    /// headline cannot mislead; a headline that omitted the qualification would put the problem
    /// straight back.
    /// </remarks>
    private static string Claim(int observed, int significant) =>
        observed == 0 ? "0" : $"{Count(observed)} observed, {Count(significant)} judged significant";

    /// <summary>The provenance, the pointer to the durable record, and the checkable arithmetic.</summary>
    private static string Footer(
        MarkdownReportRequest request,
        ComparisonAnalysis analysis,
        string suite,
        string baseline,
        string? artifact
    )
    {
        var text = new StringBuilder("\n---\n\n");

        text.Append("**Suite** ")
            .Append(Code(suite))
            .Append(" · **baseline** ")
            .Append(Code(baseline))
            .Append(" (")
            .Append(ComparisonReport.Name(request.Comparison.Mechanism))
            .Append(") · **gate** ")
            .Append(Code(request.GateMode))
            .Append(", so nothing in this report changed the exit code.\n\n");

        text.Append("**Full record** — ")
            .Append(
                artifact is null
                    ? "none: no `--out` was given, so this run wrote no JSON artifact and this Markdown is the only "
                        + "account of it — a rendering rather than the evidence, and never read back by anything."
                    : Code(artifact)
                        + ". The JSON artifact is the durable evidence; this Markdown is a rendering of it and is "
                        + "never read back — never a baseline, never an input, never compared against."
            )
            .Append("\n\n");

        text.Append(
            "**Statistics** — a pass rate is conditional on the repetitions that produced a verdict, so an "
                + "errored repetition lowers `n` rather than counting as a failure. Every interval and p-value "
                + "here is the figure the run recorded; this report surfaces them and computes none of its own.\n\n"
        );

        // The arithmetic, printed so a reader can check it. The catch-all is deliberately not a
        // term on the left: with it there the equation balances however the partition behaves,
        // and a check that cannot fail is not protection against a scenario falling between two
        // sections. Excluded, the difference is exactly what no classified section claimed.
        text.Append("**Accounting** — ")
            .Append(Count(analysis.Regressed.Count))
            .Append(" regressed + ")
            .Append(Count(analysis.NewlyCovered.Count))
            .Append(" newly covered + ")
            .Append(Count(analysis.NotComparable.Count))
            .Append(" not comparable + ")
            .Append(Count(analysis.Withheld.Count))
            .Append(" withheld + ")
            .Append(Count(analysis.NewNotPassing.Count))
            .Append(" new and not passing + ")
            .Append(Count(analysis.Removed.Count))
            .Append(" removed + ")
            .Append(Count(analysis.Unchanged))
            .Append(" unchanged = ")
            .Append(Count(analysis.Classified))
            .Append(" of ")
            .Append(Count(analysis.Entries))
            .Append(" scenario entries in the comparison.");

        if (analysis.Classified != analysis.Entries)
        {
            text.Append(" **")
                .Append(Count(analysis.Entries - analysis.Classified))
                .Append(" entry/entries reached no classified section of this report**, of which ")
                .Append(Count(analysis.Unaccounted.Count))
                .Append(" are named under \"Not accounted for\" above.");
        }

        text.Append(' ')
            .Append(Count(request.Comparison.WithheldScenarios.Count))
            .Append(
                " further scenario(s) were not run by this invocation and are outside that total — they are not "
                    + "unchanged and they were not removed."
            );

        if (analysis.Orphans.Count > 0)
        {
            text.Append(' ')
                .Append(Count(analysis.Orphans.Count))
                .Append(
                    " coverage claim(s) name a scenario the comparison carries no entry for; they are listed under "
                        + "\"Coverage claims with no comparison\" and are outside that total too."
                );
        }

        return text.Append('\n').ToString();
    }

    /// <summary>The document-level truncation banner, stated before anything a reader might trust.</summary>
    private static string Banner(int omitted, int total, int budget, string? artifact) =>
        $"> **This report was truncated.** {Count(omitted)} of {Count(total)} entries were omitted to fit the "
        + $"{Count(budget)}-character comment limit; every section below states how many it could not show. Nothing "
        + "was dropped silently. "
        + Recovery(artifact);

    /// <summary>What one section says when it could not show everything it has.</summary>
    /// <remarks>
    /// The heading always carries the section's <i>true</i> total, and this says what reached the
    /// page. Without both figures a shortened list is indistinguishable from a complete one, which
    /// is a refusal rendering as an absence in the place it does the most harm.
    /// </remarks>
    private static string Notice(int shown, int total, string? artifact) =>
        $"> **{Count(shown)} of {Count(total)} shown — {Count(total - shown)} omitted to fit the comment limit.** "
        + Recovery(artifact);

    /// <summary>
    /// Where the omitted entries can be read, or the statement that they cannot.
    /// </summary>
    /// <remarks>
    /// <b><c>--report-markdown</c> does not require <c>--out</c>.</b> Pointing at a JSON artifact
    /// that was never written would make the recovery instruction a lie in exactly the
    /// configuration where the reader most needs it — and a pointer to nothing is the same
    /// disappearance as a silent truncation, only with a sentence over the top of it.
    /// </remarks>
    private static string Recovery(string? artifact) =>
        artifact is null
            ? "**There is no fuller record: no `--out` was given, so the omitted entries were not written "
                + "anywhere.** Re-run with `--out` to keep them."
            : "The whole record is in the JSON artifact named at the end of this report.";

    /// <summary>Lays the document out, showing the first <paramref name="shown"/> entries of each section.</summary>
    /// <param name="header">The marker, title, and summary.</param>
    /// <param name="banner">The truncation banner, or null when nothing was omitted.</param>
    /// <param name="sections">The sections, in severity order.</param>
    /// <param name="shown">How many entries of each to render.</param>
    /// <param name="footer">The provenance and the accounting.</param>
    /// <param name="artifact">The displayed artifact path, so a recovery pointer names something real.</param>
    private static string Assemble(
        string header,
        string? banner,
        IReadOnlyList<MarkdownSection> sections,
        int[] shown,
        string footer,
        string? artifact
    )
    {
        var text = new StringBuilder(header);

        if (banner is not null)
        {
            text.Append('\n').Append(banner).Append('\n');
        }

        for (var index = 0; index < sections.Count; index++)
        {
            var section = sections[index];
            var total = section.Entries.Count;

            if (total == 0 && !section.Always)
            {
                continue;
            }

            text.Append("\n### ").Append(section.Title).Append(" (").Append(Count(section.Count)).Append(")\n\n");
            text.Append(section.Lead).Append('\n');

            if (total == 0)
            {
                if (section.Empty.Length > 0)
                {
                    text.Append('\n').Append(section.Empty).Append('\n');
                }

                continue;
            }

            text.Append('\n');

            for (var entry = 0; entry < shown[index]; entry++)
            {
                text.Append(section.Entries[entry]).Append('\n');
            }

            if (shown[index] < total)
            {
                text.Append('\n').Append(Notice(shown[index], total, artifact)).Append('\n');
            }
        }

        return text.Append(footer).ToString();
    }

    /// <summary>
    /// What the document costs before a single entry competes for the budget.
    /// </summary>
    /// <remarks>
    /// Every heading, every standing explanation, the banner, the footer, and a worst-case
    /// omission notice per section. The notices are measured with the widest numbers they could
    /// ever carry, so the reservation is an upper bound rather than a guess a longer count could
    /// overrun — which is what lets <see cref="Render"/> refuse a budget that cannot hold the
    /// skeleton instead of discovering the shortfall by cutting the footer off the end.
    /// </remarks>
    private static int Skeleton(
        string header,
        IReadOnlyList<MarkdownSection> sections,
        string footer,
        int total,
        int budget,
        string? artifact
    ) =>
        Assemble(
            header,
            Banner(total, total, budget, artifact),
            sections,
            new int[sections.Count],
            footer,
            artifact
        ).Length + sections.Where(section => section.Entries.Count > 0).Sum(section => NoticeSlack(section));

    /// <summary>
    /// How much wider a section's omission notice can grow than the one already reserved.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The skeleton is assembled with nothing shown, so it already carries
    /// <c>Notice(0, total)</c> — one digit in the shown slot and the full width in the omitted
    /// slot. This is the remaining headroom.
    /// </para>
    /// <para>
    /// <b><c>Notice(total, total)</c> is not the widest notice</b>, which is what the earlier
    /// reservation assumed: that form renders the omitted count as zero, while the widest real
    /// notice carries the full digit count in <i>both</i> slots. At 300 entries
    /// <c>145 of 300 shown — 155 omitted</c> is two characters longer than
    /// <c>300 of 300 shown — 0 omitted</c>. A reservation taken from the wrong end under-reserves,
    /// and a budget the renderer accepted then overruns and trips its own postcondition. Both
    /// counts are bounded by the total, so the headroom is the digits the shown slot can still
    /// grow by.
    /// </para>
    /// </remarks>
    private static int NoticeSlack(MarkdownSection section) => Count(section.Entries.Count).Length - 1;

    /// <summary>
    /// Decides how many entries of each section fit, deterministically.
    /// </summary>
    /// <param name="remaining">What the budget has left once the skeleton is paid for.</param>
    /// <param name="sections">The sections, in severity order.</param>
    /// <returns>How many entries of each section to render.</returns>
    /// <remarks>
    /// <para>
    /// <b>The skeleton is paid for before this is reached</b>, and a budget that could not hold it
    /// has already been refused — so no section can be truncated out of existence, and a reader
    /// always sees that a section exists and what it could not show.
    /// </para>
    /// <para>
    /// <b>What remains is allocated as a strict prefix, in severity order.</b> The first entry
    /// that does not fit ends the allocation for the whole document rather than skipping ahead to
    /// a shorter one further down. That keeps the highest-severity content, and it makes the
    /// output a function of the input alone: the same comparison and the same budget always
    /// produce the same bytes.
    /// </para>
    /// </remarks>
    private static int[] Allocate(int remaining, IReadOnlyList<MarkdownSection> sections)
    {
        var shown = new int[sections.Count];

        for (var index = 0; index < sections.Count && remaining > 0; index++)
        {
            foreach (var entry in sections[index].Entries)
            {
                var cost = entry.Length + 1;

                if (cost > remaining)
                {
                    return shown;
                }

                remaining -= cost;
                shown[index]++;
            }
        }

        return shown;
    }

    /// <summary>One artifact's pass rate for one scenario, with the denominator it rests on.</summary>
    /// <remarks>
    /// <para>
    /// <b>A rate is never printed without its <c>n</c>.</b> 80% against 90% on ten repetitions is
    /// noise presented as a result, and a percentage with no denominator beside it cannot be told
    /// apart from a real finding.
    /// </para>
    /// <para>
    /// <b>A single observation gets a sentence rather than an interval.</b> A deterministic REST
    /// scenario runs once; the Wilson interval at <c>n = 1</c> spans most of the unit interval and
    /// reads as a measurement when it is only an artefact of having measured once.
    /// </para>
    /// <para>
    /// <b>No gradeable run is not a pass rate of zero.</b> One says the system failed; the other
    /// says nothing was ever learned about it.
    /// </para>
    /// </remarks>
    /// <summary>One artifact's pass rate for one scenario, with the denominator it rests on.</summary>
    /// <remarks>
    /// <para>
    /// <b>A rate is never printed without its <c>n</c>.</b> 80% against 90% on ten repetitions is
    /// noise presented as a result, and a percentage with no denominator beside it cannot be told
    /// apart from a real finding.
    /// </para>
    /// <para>
    /// <b>Nor is it printed without being checked against the runs it claims to summarise.</b> A
    /// committed baseline is a file in the repository: anyone can edit it, and a summary claiming
    /// <c>n=100</c> with a correspondingly narrow interval renders as the most authoritative thing
    /// on the page while the comparator classifies the scenario from the five runs actually
    /// recorded. The figures and the evidence would then be two accounts of the same run, with the
    /// reader shown only the one nobody verified.
    /// </para>
    /// <para>
    /// <b>Refused, not recomputed.</b> Recomputing would hand a reader a number the run never
    /// produced and hide the tampering that motivated it; the honest response to a summary that
    /// disagrees with its own runs is to decline to report its figures and say why.
    /// </para>
    /// <para>
    /// <b>A single observation gets a sentence rather than an interval.</b> A deterministic REST
    /// scenario runs once; the Wilson interval at <c>n = 1</c> spans most of the unit interval and
    /// reads as a measurement when it is only an artefact of having measured once.
    /// </para>
    /// <para>
    /// <b>No gradeable run is not a pass rate of zero.</b> One says the system failed; the other
    /// says nothing was ever learned about it.
    /// </para>
    /// </remarks>
    private static string Rate(ScenarioResult? scenario, IntervalSettings settings, string side)
    {
        if (scenario is null)
        {
            return $"not present in {side}";
        }

        var graded = scenario.Runs.Count(run => run.Status != RunStatus.Error);
        var passed = scenario.Runs.Count(run => run.Status == RunStatus.Pass);

        if (scenario.Summary is not { } summary)
        {
            return graded == 0
                ? $"no pass rate — no repetition produced a verdict, so {side} says nothing about the system"
                : $"withheld — {side} records {Count(graded)} graded run(s) and no summary of them, so its figures "
                    + "cannot be shown to describe its own runs";
        }

        if (Inconsistent(summary, graded, passed, settings) is { } discrepancy)
        {
            // Named rather than silently corrected. A reader who is shown nothing here goes
            // looking; a reader shown a recomputed figure never learns the artifact disagreed
            // with itself.
            return $"withheld — the summary recorded in {side} does not match the runs beside it ({discrepancy}), "
                + "so its figures are not reported. Regenerate the artifact rather than editing it.";
        }

        var estimate = Percent(summary.PointEstimate);

        if (summary.N == 1)
        {
            return $"{estimate} (n=1 — a single observation, so no interval is reported: one run cannot bound a rate)";
        }

        if (settings.Confidence is null)
        {
            // The bounds cannot be checked against anything, so they are not presented as though
            // they had been. The rate and its denominator were checked, so those still stand.
            return $"{estimate} (n={Count(summary.N)} — the run recorded no interval settings, so any interval it "
                + "carries could not be verified and is not shown)";
        }

        var interval = summary.Interval!;

        return $"{estimate} (n={Count(summary.N)}, {Percent(settings.Confidence.Value)} {Method(interval.Method)} "
            + $"CI {Percent(interval.Lower)}-{Percent(interval.Upper)})";
    }

    /// <summary>
    /// States how a recorded summary disagrees with the runs it claims to summarise, or null.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Every figure this report renders as evidence is checked — not only the ones an earlier
    /// version of this check happened to be aimed at.</b> A reader weighs an interval at least as
    /// heavily as the rate it brackets, so an artifact whose <c>n</c> and point estimate agree
    /// with its runs while its bounds were edited would present the most persuasive number on the
    /// page unverified. So would one whose interval was simply deleted from a run that recorded
    /// having computed them.
    /// </para>
    /// <para>
    /// <b>Recomputed to verify, never to display.</b> Substituting a recomputed interval would
    /// hand a reader a figure the run never produced and hide the edit that motivated it. The
    /// bounds shown are always the artifact's own; this only decides whether they may be shown.
    /// </para>
    /// </remarks>
    private static string? Inconsistent(StatisticalSummary summary, int graded, int passed, IntervalSettings settings)
    {
        if (summary.N != graded)
        {
            return $"n={Count(summary.N)} against {Count(graded)} graded run(s)";
        }

        if (Math.Abs(summary.PointEstimate * graded - passed) > Tolerance)
        {
            return $"a pass rate of {Percent(summary.PointEstimate)} against {Count(passed)} of {Count(graded)} "
                + "run(s) that passed";
        }

        if (settings.Confidence is not { } confidence || settings.Method is not { } method)
        {
            // Nothing to check the bounds against. Rate and denominator stand; the bounds are
            // withheld by the caller rather than dressed up as verified.
            return null;
        }

        if (summary.Interval is not { } interval)
        {
            return "no confidence interval, from a run whose settings record that it computed them";
        }

        if (interval.Method != method)
        {
            return $"a {Method(interval.Method)} interval, from a run whose settings record {Method(method)}";
        }

        var expected = ProportionInterval.Compute(passed, graded, method, confidence);

        // Named, not printed. The footer states that every interval in this document is the
        // figure the run recorded and that none was computed here, so putting a recomputed bound
        // on the page would contradict it in the one place the data is known to be untrustworthy.

        return
            Math.Abs(expected.Lower - interval.Lower) > Tolerance
            || Math.Abs(expected.Upper - interval.Upper) > Tolerance
            ? $"an interval of {Percent(interval.Lower)}-{Percent(interval.Upper)} that its own runs and settings "
                + "do not produce"
            : null;
    }

    private const double Tolerance = 1e-9;

    /// <summary>The interval settings a run recorded, or the absence of them.</summary>
    /// <param name="Method">The method the run stamped, or null when it recorded none.</param>
    /// <param name="Confidence">The level the run stamped, or null when it recorded none.</param>
    private readonly record struct IntervalSettings(IntervalMethod? Method, double? Confidence);

    /// <summary>
    /// The interval settings the candidate recorded.
    /// </summary>
    /// <remarks>
    /// Read from the artifact rather than assumed. <see cref="ConfidenceInterval"/> carries no
    /// level, the coordinator records both figures in
    /// <see cref="EvaluationEnvironment.HarnessConfig"/>, and a report that assumed 95% would
    /// state a level the run may not have used. The candidate is read because the comparator has
    /// already refused any pair whose harness settings disagree.
    /// </remarks>
    private static IntervalSettings Settings(SuiteResult artifact)
    {
        var config = artifact.Environment.HarnessConfig;

        double? confidence =
            config.TryGetValue("intervalConfidence", out var recorded)
            && double.TryParse(recorded, NumberStyles.Float, CultureInfo.InvariantCulture, out var level)
            && level is > 0 and < 1
                ? level
                : null;

        IntervalMethod? method = config.TryGetValue("intervalMethod", out var name)
            ? name switch
            {
                "wilson" => IntervalMethod.Wilson,
                "agrestiCoull" => IntervalMethod.AgrestiCoull,
                _ => null,
            }
            : null;

        return new IntervalSettings(method, confidence);
    }

    /// <summary>The per-scenario delta, and what was or was not tested.</summary>
    private static string Change(ScenarioComparison entry, string? correction)
    {
        if (entry.Comparison is not { } summary)
        {
            return entry.Classification switch
            {
                ScenarioClassification.New => "there is no baseline record of this scenario, so there is no matched "
                    + "pair to test and no delta to state.",
                ScenarioClassification.Removed => "there is no candidate record of this scenario, so there is no "
                    + "matched pair to test and no delta to state.",
                _ => "no paired comparison was recorded for this scenario, so no delta can be stated.",
            };
        }

        var points = (summary.EffectSize * 100).ToString("+0.#;-0.#;0", CultureInfo.InvariantCulture);
        var effect = $"{points} points over {Count(entry.GradedPairs)} graded repetition pair(s).";

        if (summary.PValue is not { } raw)
        {
            return effect
                + " No significance test was run: every repetition agreed under both variants, so there is no "
                + "discordant pair the statistic is defined on.";
        }

        var adjusted = summary.AdjustedPValue is { } value
            ? $", {correction ?? "corrected"} adjusted p={PValue(value)}"
            : ", with no multiple-comparison correction applied";

        return $"{effect} p={PValue(raw)}{adjusted} — {Verdict(summary.Significant)}.";
    }

    private static string Verdict(SignificanceVerdict verdict) =>
        verdict switch
        {
            SignificanceVerdict.Significant => "judged significant against the run's significance level",
            SignificanceVerdict.NotSignificant => "judged not significant against the run's significance level",
            _ => "no significance verdict was recorded",
        };

    private static string Method(IntervalMethod method) =>
        method switch
        {
            IntervalMethod.Wilson => "Wilson",
            IntervalMethod.AgrestiCoull => "Agresti-Coull",
            _ => method.ToString(),
        };

    /// <summary>
    /// The confidence level the run's intervals were computed at, or null when it did not record one.
    /// </summary>
    /// <remarks>
    /// Read from the artifact rather than assumed. <see cref="ConfidenceInterval"/> carries no
    /// level, the coordinator records it in <see cref="EvaluationEnvironment.HarnessConfig"/>, and
    /// a report that printed "95%" over an interval computed at 99% would be stating a figure the
    /// run never produced. The candidate is read because the comparator has already refused any
    /// pair whose harness settings disagree.
    /// </remarks>
    private static string? ConfidenceLevel(SuiteResult artifact) =>
        artifact.Environment.HarnessConfig.TryGetValue("intervalConfidence", out var recorded)
        && double.TryParse(recorded, NumberStyles.Float, CultureInfo.InvariantCulture, out var level)
        && level is > 0 and < 1
            ? Percent(level)
            : null;

    private static string Percent(double value) => (value * 100).ToString("0.#", CultureInfo.InvariantCulture) + "%";

    private static string PValue(double value) =>
        value < 0.001 ? "<0.001" : value.ToString("0.###", CultureInfo.InvariantCulture);
}
