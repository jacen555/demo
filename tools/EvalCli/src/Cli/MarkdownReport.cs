namespace Forge.EvalCli.Cli;

/// <summary>What to render, and how much room there is to render it in.</summary>
internal sealed record MarkdownReportRequest
{
    /// <summary>Gets the comparison that happened.</summary>
    public required ComparisonOutcome Comparison { get; init; }

    /// <summary>Gets the canonical containment root every path is stated relative to.</summary>
    public required string RootDirectory { get; init; }

    /// <summary>Gets the canonical suite path.</summary>
    public required string SuitePath { get; init; }

    /// <summary>Gets where the durable JSON artifact was written, or null when none was.</summary>
    public string? ArtifactPath { get; init; }

    /// <summary>Gets the gate mode in force.</summary>
    public required string GateMode { get; init; }

    /// <summary>Gets the character budget the rendering must fit inside.</summary>
    public int CharacterBudget { get; init; } = MarkdownReport.CommentCharacterLimit;
}

/// <summary>How much of one section reached the rendering.</summary>
/// <param name="Section">The section's heading text.</param>
/// <param name="Total">How many entries it has.</param>
/// <param name="Shown">How many of them were rendered.</param>
internal sealed record MarkdownSectionOmission(string Section, int Total, int Shown);

/// <summary>A rendered report, and what it could not fit.</summary>
internal sealed record MarkdownRendering
{
    /// <summary>Gets the Markdown.</summary>
    public required string Text { get; init; }

    /// <summary>Gets the marker identity CI finds this report's comment by.</summary>
    public required string Marker { get; init; }

    /// <summary>Gets whether anything was omitted to fit the budget.</summary>
    public required bool Truncated { get; init; }

    /// <summary>Gets the per-section accounting.</summary>
    public required IReadOnlyList<MarkdownSectionOmission> Sections { get; init; }
}

/// <summary>
/// One section of the report: a heading, a standing explanation, and either entries or a count.
/// </summary>
/// <remarks>
/// <para>
/// <b>Two shapes, because a required number is not a bound one.</b> Making the heading figure a
/// required <see cref="int"/> only obliged a caller to supply <i>some</i> number — a section with
/// one entry and a headline of zero still compiled, so the heading could still contradict the
/// body beneath it. Here a <see cref="List"/> section derives its count from its own entries and
/// offers no way to say otherwise, and the one section whose count is deliberately not an entry
/// count is a different construction that says so.
/// </para>
/// <para>
/// The private constructor is what closes it: there is no third way to build one.
/// </para>
/// </remarks>
internal sealed record MarkdownSection
{
    private MarkdownSection(
        string title,
        string lead,
        string empty,
        IReadOnlyList<string> entries,
        bool always,
        int count
    )
    {
        Title = title;
        Lead = lead;
        Empty = empty;
        Entries = entries;
        Always = always;
        Count = count;
    }

    /// <summary>Gets the heading text, which is also the key in <see cref="MarkdownRendering.Sections"/>.</summary>
    public string Title { get; }

    /// <summary>Gets the standing explanation, always rendered.</summary>
    public string Lead { get; }

    /// <summary>Gets what to print when the section has no entries at all.</summary>
    public string Empty { get; }

    /// <summary>Gets the entries, in the order the comparator produced them.</summary>
    public IReadOnlyList<string> Entries { get; }

    /// <summary>Gets whether to render the section even when it has no entries.</summary>
    public bool Always { get; }

    /// <summary>Gets the figure the heading carries.</summary>
    public int Count { get; }

    /// <summary>A section that lists scenarios. Its heading counts them; nothing else can.</summary>
    /// <param name="title">The heading text.</param>
    /// <param name="lead">The standing explanation.</param>
    /// <param name="empty">What to print when there are no entries.</param>
    /// <param name="entries">The entries.</param>
    /// <param name="always">Whether to render the section when it is empty.</param>
    /// <returns>The section.</returns>
    /// <remarks>
    /// <b>The entries are snapshotted.</b> Holding the caller's <see cref="IReadOnlyList{T}"/>
    /// while taking the count from it once is not a binding: the caller can hand over an empty
    /// <see cref="List{T}"/>, add to it afterwards, and produce a heading of zero above one entry
    /// without the analysis being involved at all. A count taken from a copy nobody else holds
    /// cannot drift from the thing it counts.
    /// </remarks>
    public static MarkdownSection List(
        string title,
        string lead,
        string empty,
        IReadOnlyList<string> entries,
        bool always
    )
    {
        ArgumentNullException.ThrowIfNull(entries);

        string[] snapshot = [.. entries];

        return new MarkdownSection(title, lead, empty, snapshot, always, snapshot.Length);
    }

    /// <summary>
    /// A section that reports a count rather than a list.
    /// </summary>
    /// <param name="title">The heading text.</param>
    /// <param name="total">The figure, from the one shared accounting.</param>
    /// <param name="lead">Builds the standing explanation from that same figure.</param>
    /// <returns>The section.</returns>
    /// <remarks>
    /// Separate from <see cref="List"/> precisely so the divergence between the heading figure and
    /// the number of rendered entries is deliberate and visible at the call site. The prose is
    /// <i>derived</i> from the total rather than supplied beside it, so the sentence cannot state
    /// one number while the heading states another.
    /// </remarks>
    public static MarkdownSection Aggregate(string title, int total, Func<int, string> lead)
    {
        ArgumentNullException.ThrowIfNull(lead);

        return new MarkdownSection(title, lead(total), string.Empty, [], always: true, total);
    }
}

/// <summary>
/// Renders a comparison as the Markdown a pull-request reviewer reads.
/// </summary>
/// <remarks>
/// <para>
/// <b>What a change fixed is the headline.</b> It leads the summary line, because a harness that
/// reports only what broke is a worse version of a test suite and the reason to run a suite
/// against two variants is to be able to show what a change <i>fixed</i>. The detailed sections
/// then run in severity order, regressions first, because that is the order a reviewer needs to
/// act in.
/// </para>
/// <para>
/// <b>Everything here is designed against one failure: a refusal rendering as an absence.</b> That
/// is the defect this repository keeps producing, and a report is where it does the most damage,
/// because a human reads it and stops looking. Four rules follow from it and each is pinned by a
/// test:
/// </para>
/// <list type="number">
/// <item><description>
/// <b>"No regressions" is not printable when nothing was compared.</b> The empty form of the
/// regressions section is chosen on the number of pairs that were actually diffed, not on the
/// number that regressed — a zero drawn from nothing examined is not a finding.
/// </description></item>
/// <item><description>
/// <b>A truncated section does not read as an empty one.</b> Every heading carries the section's
/// true total, and a section that could not show everything says how many it dropped and where
/// the whole record is. A silently shortened list is the same defect wearing a different hat.
/// </description></item>
/// <item><description>
/// <b>A scenario withheld from coverage does not vanish.</b> It keeps its own section, and the
/// section is keyed on the comparator's list rather than on the nullable reason beside it.
/// </description></item>
/// <item><description>
/// <b>The unchanged count contains only scenarios that ran.</b> Scenarios this invocation skipped
/// are reported separately with the reason, because no candidate evidence about them exists at
/// all — they are neither unchanged nor removed.
/// </description></item>
/// </list>
/// <para>
/// <b>The arithmetic is printed so a reader can check it.</b> Every scenario in the comparison
/// lands in exactly one section, and the footer adds the sections up against the number of
/// entries the comparator produced. A scenario that fell between two sections shows up as a
/// mismatch in that line rather than as a silence.
/// </para>
/// <para>
/// <b>This rendering is never read back.</b> The JSON artifact is the durable evidence and the
/// only thing a later comparison is made against; this is a view of it, produced for a human, and
/// nothing in this tool parses it.
/// </para>
/// </remarks>
internal static partial class MarkdownReport
{
    /// <summary>GitHub's hard limit on the length of one issue or pull-request comment.</summary>
    /// <remarks>
    /// The originals this report is generalised from reached 19 MB, which no comment API will
    /// take. Fitting the limit is therefore a requirement rather than a courtesy — and fitting it
    /// by quietly dropping the tail would be a refusal rendering as an absence, so the truncation
    /// is deterministic, severity-ordered, and stated in the document.
    /// </remarks>
    public const int CommentCharacterLimit = 65_536;

    /// <summary>The smallest budget this renderer will accept.</summary>
    /// <remarks>
    /// Below this there is not enough room for the frame and the section headings, so what came
    /// back would be a fragment presented as a report. Refused instead.
    /// </remarks>
    public const int MinimumCharacterBudget = 2_048;

    /// <summary>Renders the report.</summary>
    /// <param name="request">What to render.</param>
    /// <returns>The rendering, and the accounting of anything it could not fit.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="request"/> is null.</exception>
    /// <exception cref="ArgumentOutOfRangeException">The budget is below <see cref="MinimumCharacterBudget"/>.</exception>
    public static MarkdownRendering Render(MarkdownReportRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentOutOfRangeException.ThrowIfLessThan(request.CharacterBudget, MinimumCharacterBudget);

        var root = request.RootDirectory;
        var suite = Display(root, request.SuitePath);
        var artifact = request.ArtifactPath is null ? null : Display(root, request.ArtifactPath);
        var baseline =
            request.Comparison.Mechanism is BaselineMechanism.Artifact
                ? Display(root, request.Comparison.Reference)
                : Sanitize(request.Comparison.Reference, MaxPathCharacters);

        // Hashed from the typed identities, never from the display strings above. Clipping and
        // redaction are presentation controls; a marker fed by either collides two distinct
        // reports, and one then silently replaces the other on the pull request. The identity is
        // a type rather than a convention so the wrong value cannot be assigned in the first
        // place, and its encoding is injective so no transformation inside the hash path can
        // collide two inputs either.
        var marker = MarkerFor(ReportIdentity.ForPath(root, request.SuitePath), request.Comparison.ReferenceIdentity);

        var analysis = Analyse(request.Comparison);

        RequireDistinctAliases(AliasedValues(request.Comparison));

        var sections = Sections(request.Comparison, analysis, artifact);
        var header = Header(marker, request.Comparison.Result.SuiteName, analysis);
        var footer = Footer(request, analysis, suite, baseline, artifact);
        var recovery = Recovery(artifact);
        var total = sections.Sum(section => section.Entries.Count);
        var skeleton = Skeleton(header, sections, footer, total, request.CharacterBudget, recovery);

        // Refused rather than fitted. Below this the headings, the standing explanations and the
        // footer do not themselves fit, so what came back would be a fragment presented as a
        // report — and "no section can be truncated out of existence" would hold only for inputs
        // that happened to be small enough.
        if (skeleton > request.CharacterBudget)
        {
            throw new ArgumentOutOfRangeException(
                nameof(request),
                request.CharacterBudget,
                $"This comparison needs at least {Count(skeleton)} characters for its headings, its standing "
                    + "explanations and its footer, before a single entry is rendered. A smaller budget cannot "
                    + "carry a report whose sections are all present."
            );
        }

        var everything = (int[])[.. sections.Select(section => section.Entries.Count)];
        var untruncated = Assemble(header, banner: null, sections, everything, footer, recovery);

        if (untruncated.Length <= request.CharacterBudget)
        {
            return Complete(untruncated, marker, sections, truncated: false, everything, request.CharacterBudget);
        }

        var shown = Allocate(request.CharacterBudget - skeleton, sections);
        var omitted = total - shown.Sum();
        var banner = Banner(omitted, total, request.CharacterBudget, recovery);

        return Complete(
            Assemble(header, banner, sections, shown, footer, recovery),
            marker,
            sections,
            truncated: true,
            shown,
            request.CharacterBudget
        );
    }

    /// <summary>
    /// Every author-supplied value this document can carry, as the alias check must see them.
    /// </summary>
    /// <param name="comparison">The comparison that happened.</param>
    /// <returns>The values, including nulls and duplicates, which the check ignores.</returns>
    /// <remarks>
    /// A method rather than a list built at the call site, so a test can assert on the same set
    /// the renderer checks. The set drifting from what the document actually prints is the whole
    /// failure mode here: a value that reaches the page and not this list is a value whose alias
    /// nothing checked.
    /// <para>
    /// <b>The two coverage-claim lists are here because an orphan claim reaches the page through
    /// neither of the others.</b> A claim naming a scenario the comparison carries no entry for is
    /// rendered in its own section — see <see cref="ComparisonAnalysis.Orphans"/> — so taking the
    /// ids only from the per-scenario comparisons left exactly those unchecked. An orphan is
    /// already the entry a reader has least ability to cross-check, and two of them colliding
    /// onto one alias would make them one scenario.
    /// </para>
    /// <para>
    /// Duplicates are expected — a covered id is normally also a comparison id — and are harmless:
    /// the check refuses an alias shared by two <i>different</i> values, not one named twice.
    /// </para>
    /// <para>
    /// <b>The withheld reasons are here as whole sentences, one per withheld scenario.</b> They
    /// are composed by the engine from a closed set of causes and carry no author-supplied text,
    /// so today none of them can produce an alias at all. They are listed anyway because the rule
    /// this set answers to is "everything the document prints", not "everything the document
    /// prints that looks risky today" — the previous single suite-level reason was listed on the
    /// same basis, and a set curated by what currently seems safe is a set that stops matching
    /// the page without anyone noticing.
    /// </para>
    /// </remarks>
    internal static IReadOnlyList<string?> AliasedValues(ComparisonOutcome comparison)
    {
        ArgumentNullException.ThrowIfNull(comparison);

        return
        [
            comparison.Result.SuiteName,
            .. comparison.Result.ScenarioComparisons.Select(entry => entry.ScenarioId),
            .. comparison.Result.ScenarioComparisons.Select(entry => entry.NotComparableReason),
            .. comparison.Result.NewlyCovered,
            .. comparison.Result.NewlyCoveredWithheld.Select(entry => entry.ScenarioId),
            .. comparison.Result.NewlyCoveredWithheld.Select(entry => ComparisonReport.Withholding(entry.Cause)),
            .. comparison.WithheldScenarios,
        ];
    }

    /// <summary>
    /// Packages a rendering, refusing one that overran the budget it was built against.
    /// </summary>
    /// <remarks>
    /// A postcondition, not a guard. The skeleton is reserved before any entry competes and every
    /// notice is measured at its widest, so this cannot fire — and were it ever to, the
    /// alternatives are emitting a document the comment API rejects, or cutting away the headings
    /// and the footer this report promises are always present. Both are worse than stopping.
    /// <para>
    /// Internal rather than private so <see cref="TrendReport"/> is held to the same
    /// postcondition. A second report allowed to overrun its own budget is a second report whose
    /// tail disappears without saying so.
    /// </para>
    /// </remarks>
    internal static MarkdownRendering Complete(
        string text,
        string marker,
        IReadOnlyList<MarkdownSection> sections,
        bool truncated,
        int[] shown,
        int budget
    )
    {
        if (text.Length > budget)
        {
            throw new InvalidOperationException(
                $"The report renderer produced {Count(text.Length)} characters against a budget of "
                    + $"{Count(budget)}. This is a defect in the renderer's own allocation, not a property of the "
                    + "comparison."
            );
        }

        return new MarkdownRendering
        {
            Text = text,
            Marker = marker,
            Truncated = truncated,
            Sections =
            [
                .. sections.Select(
                    (section, index) => new MarkdownSectionOmission(section.Title, section.Entries.Count, shown[index])
                ),
            ],
        };
    }
}
