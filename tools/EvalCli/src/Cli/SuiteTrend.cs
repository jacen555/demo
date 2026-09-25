using System.Globalization;
using Forge.EvalEngine.Results;

namespace Forge.EvalCli.Cli;

/// <summary>What one artifact recorded about one scenario.</summary>
internal enum TrendPoint
{
    /// <summary>The artifact carries no entry for this scenario at all. It does not say why.</summary>
    NotRecorded,

    /// <summary>
    /// The scenario ran and nothing was learned: no repetition produced a verdict, or the runs
    /// carry no aggregate. Emphatically not a pass rate of zero.
    /// </summary>
    Ungradeable,

    /// <summary>
    /// The scenario ran and produced figures, and those figures do not describe its own runs, so
    /// they are not reported.
    /// </summary>
    Withheld,

    /// <summary>The scenario ran and its recorded figures describe the runs beside them.</summary>
    Graded,
}

/// <summary>
/// Where a position with no record sits relative to the records that do exist.
/// </summary>
/// <remarks>
/// <b>This is the shape of the hole, not its cause.</b> A <see cref="SuiteResult"/> records what
/// ran; it records neither the suite's membership nor the selector's decision, so nothing in a
/// series can tell "the scenario did not exist yet" from "it existed and was not selected". What
/// the series <i>can</i> establish is where the hole sits, and each shape narrows the causes it is
/// consistent with. <see cref="TrendReport"/> prints the narrowed set rather than choosing one of
/// them.
/// </remarks>
internal enum TrendGap
{
    /// <summary>The artifact recorded the scenario. There is no gap.</summary>
    None,

    /// <summary>No artifact at or before this position records the scenario.</summary>
    BeforeFirstRecord,

    /// <summary>An artifact before this one and an artifact after it record the scenario, and this one does not.</summary>
    Interior,

    /// <summary>No artifact at or after this position records the scenario.</summary>
    AfterLastRecord,
}

/// <summary>
/// One artifact in the series, with the label the report may print for it.
/// </summary>
/// <remarks>
/// <b>The label is netted in the constructor, so there is no way to hold an unsafe one.</b>
/// <c>TrendCommand</c> relativises it against the root before handing it over, which is the part
/// this type cannot do — but "the caller relativised it" is a convention, and ADR 0005's finding
/// is that a guard one call away from being bypassed is not a guard. Running the published net
/// over an already-safe label costs nothing and makes the invariant a property of the type rather
/// than of every call site that will ever construct one.
/// </remarks>
internal sealed record TrendArtifact
{
    /// <summary>Initializes a new instance of the <see cref="TrendArtifact"/> class.</summary>
    /// <param name="label">The path relative to the root.</param>
    /// <param name="result">What the run recorded.</param>
    /// <exception cref="ArgumentNullException"><paramref name="result"/> is null.</exception>
    public TrendArtifact(string label, SuiteResult result)
    {
        ArgumentNullException.ThrowIfNull(result);

        Label = MarkdownReport.Sanitize(label, MarkdownReport.MaxPathCharacters);
        Result = result;
    }

    /// <summary>Gets the label, safe to render into a document or a diagnostic.</summary>
    public string Label { get; }

    /// <summary>Gets what the run recorded.</summary>
    public SuiteResult Result { get; }
}

/// <summary>What one artifact said about one scenario, and where that sits in the series.</summary>
internal sealed record TrendObservation
{
    /// <summary>Gets the one-based position in the ordered series.</summary>
    public required int Position { get; init; }

    /// <summary>Gets what the artifact recorded.</summary>
    public required TrendPoint Point { get; init; }

    /// <summary>Gets the shape of the hole, when there is one.</summary>
    public required TrendGap Gap { get; init; }

    /// <summary>Gets the recorded scenario, or null when the artifact carried none.</summary>
    public ScenarioResult? Recorded { get; init; }
}

/// <summary>One scenario across the whole series.</summary>
internal sealed record TrendSeries
{
    /// <summary>Gets the scenario identifier.</summary>
    public required string ScenarioId { get; init; }

    /// <summary>Gets one observation per artifact, in series order.</summary>
    public required IReadOnlyList<TrendObservation> Observations { get; init; }

    /// <summary>Gets whether every artifact graded this scenario.</summary>
    public required bool InStableCore { get; init; }

    /// <summary>Gets how many artifacts recorded the scenario in any form.</summary>
    public int Recorded => Observations.Count(entry => entry.Point != TrendPoint.NotRecorded);

    /// <summary>Gets how many artifacts graded it.</summary>
    public int Graded => Observations.Count(entry => entry.Point == TrendPoint.Graded);

    /// <summary>Gets how many holes sit between two records.</summary>
    public int InteriorGaps => Observations.Count(entry => entry.Gap == TrendGap.Interior);

    /// <summary>Gets the graded observations, in series order.</summary>
    public IReadOnlyList<TrendObservation> GradedObservations =>
        [.. Observations.Where(entry => entry.Point == TrendPoint.Graded)];
}

/// <summary>The suite-level figures at one position, over the stable core only.</summary>
internal sealed record TrendPosition
{
    /// <summary>Gets the one-based position in the ordered series.</summary>
    public required int Position { get; init; }

    /// <summary>Gets the artifact at this position.</summary>
    public required TrendArtifact Artifact { get; init; }

    /// <summary>Gets how many scenarios this artifact recorded in any form.</summary>
    public required int ScenariosRecorded { get; init; }

    /// <summary>Gets how many repetitions of the stable core passed.</summary>
    public required int CorePassed { get; init; }

    /// <summary>Gets how many repetitions of the stable core produced a verdict.</summary>
    public required int CoreGraded { get; init; }
}

/// <summary>Something that moved between two artifacts and is not behaviour.</summary>
/// <param name="Setting">What changed.</param>
/// <param name="Position">The one-based position it first changed at.</param>
/// <param name="Before">What it was.</param>
/// <param name="After">What it became.</param>
internal sealed record TrendCaveat(string Setting, int Position, string Before, string After);

/// <summary>
/// A suite's movement across a series of artifacts.
/// </summary>
/// <remarks>
/// <para>
/// <b>The series is ordered by <see cref="EvaluationEnvironment.Timestamp"/> and by nothing
/// else.</b> That value is stamped from the injected clock at run start, which makes it the only
/// thing in the directory recording when the runs actually happened. A file name is chosen by
/// whoever wrote the artifact, and a modification time is rewritten by a copy, a checkout, or an
/// artifact-download step — so both survive being wrong, and a trend drawn in either order is a
/// claim about a sequence that never occurred.
/// </para>
/// <para>
/// <b>Two artifacts stamped with the same instant are refused.</b> A trend is a claim about order;
/// a tie makes that claim undecidable at one point, and every figure downstream of it — the
/// movement between two positions, which artifact first recorded a scenario, whether a hole is
/// interior or trailing — would then be computed against an order the data does not support. Every
/// tiebreak available here is a file name or a modification time, which is precisely what this
/// type refuses to order on.
/// </para>
/// <para>
/// <b>Membership moving is not a fingerprint disagreement.</b> A scenario appearing or
/// disappearing is the movement this analysis exists to report, so the fingerprint check is a
/// relation over the scenarios two artifacts <i>share</i> rather than a digest over the whole set.
/// Folding membership into it would refuse exactly the series worth trending. A shared id whose
/// definition fingerprint or kind disagrees is a redefinition, and that does refuse: a rate
/// recorded before an edit and a rate recorded after it answer different questions, and a line
/// drawn between them is arithmetic over unrelated work.
/// </para>
/// </remarks>
internal sealed record SuiteTrend
{
    /// <summary>The fewest artifacts a series can be drawn through.</summary>
    /// <remarks>
    /// Two, because a trend is movement and one point has none. A directory below this is a
    /// refusal rather than a chart with one column: "nothing to compare" and "nothing moved" must
    /// not render alike, and a single-artifact rendering reads as the second.
    /// </remarks>
    public const int MinimumArtifacts = 2;

    /// <summary>What to do about a directory that cannot be trended.</summary>
    public const string Remedy =
        "Point --artifacts at a directory of runs of one suite, conducted against one set of definitions. "
        + "Regenerate any artifact that predates a change to the suite rather than hand-editing it: an artifact is "
        + "evidence of the definitions it was run against, and an edited one is evidence of nothing.";

    /// <summary>Gets the suite every artifact in the series is a run of.</summary>
    public required string SuiteName { get; init; }

    /// <summary>Gets the artifacts, ordered by what each run recorded as its start time.</summary>
    public required IReadOnlyList<TrendArtifact> Artifacts { get; init; }

    /// <summary>Gets the suite-level figures, one per artifact, in series order.</summary>
    public required IReadOnlyList<TrendPosition> Positions { get; init; }

    /// <summary>Gets every scenario any artifact recorded, ordinal by identifier.</summary>
    public required IReadOnlyList<TrendSeries> Series { get; init; }

    /// <summary>Gets the scenarios every artifact graded — the population the suite figure moves over.</summary>
    public required IReadOnlyList<string> StableCore { get; init; }

    /// <summary>Gets the scenarios first recorded after the first artifact.</summary>
    public required IReadOnlyList<string> Appeared { get; init; }

    /// <summary>Gets the scenarios last recorded before the final artifact.</summary>
    public required IReadOnlyList<string> Disappeared { get; init; }

    /// <summary>Gets the settings that moved during the series without being behaviour.</summary>
    public required IReadOnlyList<TrendCaveat> Caveats { get; init; }

    /// <summary>
    /// Gets how many changed harness settings this build does not recognise, and so does not name.
    /// </summary>
    public required int UnnamedSettingChanges { get; init; }

    /// <summary>Gets the interval settings every artifact in the series agreed on.</summary>
    public required MarkdownReport.IntervalSettings Settings { get; init; }

    /// <summary>Orders a directory's artifacts into a series and classifies every hole in it.</summary>
    /// <param name="artifacts">The artifacts read from the directory, in any order.</param>
    /// <returns>The trend.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="artifacts"/> is null.</exception>
    /// <exception cref="EvalCliException">The artifacts cannot honestly be trended together.</exception>
    public static SuiteTrend Build(IReadOnlyList<TrendArtifact> artifacts)
    {
        ArgumentNullException.ThrowIfNull(artifacts);

        if (artifacts.Count < MinimumArtifacts)
        {
            throw Refuse(
                artifacts.Count == 0
                    ? "No artifact in that directory could be read as a run of a suite, so there is no series to "
                        + "trend. That is not a suite which has stopped moving; it is a directory this tool found "
                        + "nothing in."
                    : $"That directory yields {Number(artifacts.Count)} artifact, and a trend is movement between "
                        + "at least two. One run is a measurement, not a direction — reporting it as a flat series "
                        + "would state a stability the evidence cannot support.",
                // Not the standing remedy. Nothing here is malformed and nothing needs regenerating: the caller
                // either pointed at the wrong directory or has not run the suite enough times yet, and telling them
                // to regenerate an artifact would send them to fix a file that is fine.
                "Nothing was written. Point --artifacts at a directory holding at least two run artifacts of the "
                    + "same suite — each one written by `eval-cli run --out` — or conduct the suite again and trend "
                    + "the directory once it has a second run in it."
            );
        }

        var ordered = Order(artifacts);
        var index = Index(ordered);

        RequireOneSuite(ordered);
        RequireOneSetOfDefinitions(ordered, index);

        var settings = RequireOneIntervalSetting(ordered);
        var series = Classify(ordered, index, settings);
        var core = series.Where(entry => entry.InStableCore).Select(entry => entry.ScenarioId).ToArray();
        var (caveats, unnamed) = SettingsThatMoved(ordered);

        return new SuiteTrend
        {
            SuiteName = ordered[0].Result.SuiteName,
            Artifacts = ordered,
            Positions = [.. ordered.Select((artifact, slot) => Position(artifact, slot + 1, index[slot], core))],
            Series = series,
            StableCore = core,
            Appeared = [.. series.Where(entry => First(entry) > 1).Select(entry => entry.ScenarioId)],
            Disappeared = [.. series.Where(entry => Last(entry) < ordered.Length).Select(entry => entry.ScenarioId)],
            Caveats = caveats,
            UnnamedSettingChanges = unnamed,
            Settings = settings,
        };
    }

    /// <summary>
    /// Orders the series by what each run recorded, refusing a tie rather than breaking it.
    /// </summary>
    /// <remarks>
    /// Compared on <see cref="DateTimeOffset.UtcTicks"/>, so the same instant written in two
    /// offsets is one instant. Comparing the offset-bearing values would let a run stamped
    /// <c>10:00+01:00</c> and one stamped <c>09:00Z</c> sit in either order and call the result a
    /// sequence.
    /// </remarks>
    private static TrendArtifact[] Order(IReadOnlyList<TrendArtifact> artifacts)
    {
        var ordered = artifacts.OrderBy(artifact => artifact.Result.Environment.Timestamp.UtcTicks).ToArray();

        for (var slot = 1; slot < ordered.Length; slot++)
        {
            var previous = ordered[slot - 1];
            var current = ordered[slot];

            if (previous.Result.Environment.Timestamp.UtcTicks != current.Result.Environment.Timestamp.UtcTicks)
            {
                continue;
            }

            throw Refuse(
                "Two artifacts record the same instant as their start time, so which run came first cannot be "
                    + $"established from what the runs themselves recorded: {previous.Label} and {current.Label}, "
                    + $"both at {Instant(current.Result.Environment.Timestamp)}. Ordering them on a file name or a "
                    + "modification time would put a sequence on the page that nothing in the evidence supports, "
                    + "and every gap classification and every movement below it rests on that order.",
                "Re-run one of them so the clock separates them, or remove the copy. A duplicated timestamp is "
                    + "usually a copied artifact or a pinned clock, and both are conditions under which a trend "
                    + "would be describing one run twice."
            );
        }

        return ordered;
    }

    /// <summary>Indexes each artifact's scenarios by id, refusing an artifact that files one twice.</summary>
    private static List<Dictionary<string, ScenarioResult>> Index(TrendArtifact[] ordered)
    {
        var indexes = new List<Dictionary<string, ScenarioResult>>(ordered.Length);

        foreach (var artifact in ordered)
        {
            var index = new Dictionary<string, ScenarioResult>(StringComparer.Ordinal);

            foreach (var scenario in artifact.Result.ScenarioResults)
            {
                if (scenario is null)
                {
                    throw Refuse(
                        $"The artifact {artifact.Label} carries a scenario entry that is not there. An artifact "
                            + "whose own structure is malformed is not evidence of anything, and reading past it "
                            + "would put a hole in this series that nothing caused."
                    );
                }

                if (!index.TryAdd(scenario.ScenarioId, scenario))
                {
                    throw Refuse(
                        $"The artifact {artifact.Label} records the scenario '{Named(scenario.ScenarioId)}' twice. "
                            + "The id is the key this trend joins every artifact on, so two entries under one id "
                            + "mean the key does not identify a scenario — and picking a side would make every "
                            + "figure below it a silent choice between two runs."
                    );
                }
            }

            indexes.Add(index);
        }

        return indexes;
    }

    private static void RequireOneSuite(TrendArtifact[] ordered)
    {
        var first = ordered[0];

        foreach (var artifact in ordered.Skip(1))
        {
            if (string.Equals(first.Result.SuiteName, artifact.Result.SuiteName, StringComparison.Ordinal))
            {
                continue;
            }

            throw Refuse(
                $"The artifact {first.Label} is a run of suite '{Named(first.Result.SuiteName)}' and "
                    + $"{artifact.Label} is a run of suite '{Named(artifact.Result.SuiteName)}'. Two suites share "
                    + "no scenario definitions, so a series across them would be movement between unrelated work."
            );
        }
    }

    /// <summary>
    /// Refuses a series in which one id means two different things.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Each artifact's entry is checked against the <i>first</i> artifact that recorded that id,
    /// not against the one immediately before it, so a definition that changes and changes back is
    /// still caught. A trend across an edit and its revert is two populations wearing one name.
    /// </para>
    /// <para>
    /// <b>The kind is checked beside the fingerprint, not folded into it.</b>
    /// <see cref="Forge.EvalEngine.Scenarios.ScenarioFingerprint"/> deliberately excludes the
    /// kind and states that every consumer pairing two scenarios on a fingerprint owes it a second
    /// comparison. This is that comparison.
    /// </para>
    /// <para>
    /// <b>A missing fingerprint on a shared id refuses; on an id only one artifact carries, it
    /// does not.</b> The check establishes that two artifacts mean the same thing by one id, and
    /// where only one artifact carries it there is nothing to establish — the scenario is trended
    /// as the single point it is.
    /// </para>
    /// </remarks>
    private static void RequireOneSetOfDefinitions(
        TrendArtifact[] ordered,
        List<Dictionary<string, ScenarioResult>> index
    )
    {
        var first = new Dictionary<string, (TrendArtifact Artifact, ScenarioResult Scenario)>(StringComparer.Ordinal);

        for (var slot = 0; slot < ordered.Length; slot++)
        {
            foreach (var id in index[slot].Keys.Order(StringComparer.Ordinal))
            {
                var scenario = index[slot][id];

                if (!first.TryGetValue(id, out var earlier))
                {
                    first[id] = (ordered[slot], scenario);

                    continue;
                }

                RequireSameScenario(id, earlier.Artifact, earlier.Scenario, ordered[slot], scenario);
            }
        }
    }

    private static void RequireSameScenario(
        string id,
        TrendArtifact earlierArtifact,
        ScenarioResult earlier,
        TrendArtifact laterArtifact,
        ScenarioResult later
    )
    {
        var named = Named(id);

        if (earlier.Kind != later.Kind)
        {
            throw Refuse(
                $"The scenario '{named}' exercises a '{earlier.Kind}' kind of system in {earlierArtifact.Label} and "
                    + $"a '{later.Kind}' kind in {laterArtifact.Label}. One id naming two kinds is a redefinition "
                    + "rather than a change in behaviour, and a line drawn across it would report a change of "
                    + "system as something the suite did."
            );
        }

        if (string.IsNullOrEmpty(earlier.DefinitionFingerprint) || string.IsNullOrEmpty(later.DefinitionFingerprint))
        {
            var blank = string.IsNullOrEmpty(earlier.DefinitionFingerprint) ? earlierArtifact : laterArtifact;

            throw Refuse(
                $"The artifact {blank.Label} does not record the fingerprint of the definition scenario '{named}' "
                    + "was run from, and another artifact in this series records the same id. An artifact that "
                    + "never stated what it was run against cannot establish that both runs were run against the "
                    + "same thing, and absent is not the same as matching."
            );
        }

        if (string.Equals(earlier.DefinitionFingerprint, later.DefinitionFingerprint, StringComparison.Ordinal))
        {
            return;
        }

        throw Refuse(
            $"The scenario '{named}' was redefined between {earlierArtifact.Label} and {laterArtifact.Label}: its "
                + "execution inputs or its grading expectations differ. A rate recorded before that edit and a rate "
                + "recorded after it answer different questions, so a series through them would report the edit as "
                + "movement the suite made."
        );
    }

    /// <summary>
    /// Refuses a series whose artifacts do not agree on what their intervals mean.
    /// </summary>
    /// <remarks>
    /// <b>Narrower than the comparison's harness check, deliberately.</b>
    /// <c>SuiteComparator</c> refuses on any harness setting, because it compares exactly two runs
    /// and the delta between them is the whole claim. A series is longer, and a throttle
    /// legitimately changes across one; refusing a whole directory for that would destroy far more
    /// evidence than it protects, so a throttle or a seed that moved is reported as a caveat at
    /// the position it moved. The interval settings are different in kind — they decide what the
    /// <i>printed figures mean</i>, and a 95% Wilson bound rendered beside a 99% Agresti-Coull
    /// bound under one heading is evidence from one context presented as another.
    /// </remarks>
    private static MarkdownReport.IntervalSettings RequireOneIntervalSetting(TrendArtifact[] ordered)
    {
        var first = ordered[0];

        foreach (var key in (string[])[IntervalMethodKey, IntervalConfidenceKey])
        {
            var expected = Setting(first, key);

            foreach (var artifact in ordered.Skip(1))
            {
                var actual = Setting(artifact, key);

                if (string.Equals(expected, actual, StringComparison.Ordinal))
                {
                    continue;
                }

                throw Refuse(
                    $"The artifacts disagree on '{key}': {first.Label} records {Typed(key, expected)} and "
                        + $"{artifact.Label} records {Typed(key, actual)}. That setting decides what every interval "
                        + "in this report means, so rendering both under one heading would put two different "
                        + "measurements on one axis."
                );
            }
        }

        return MarkdownReport.Settings(first.Result);
    }

    /// <summary>The setting that decides which interval method a run's bounds were computed by.</summary>
    private const string IntervalMethodKey = "intervalMethod";

    /// <summary>The setting that decides what level a run's bounds were computed at.</summary>
    private const string IntervalConfidenceKey = "intervalConfidence";

    /// <summary>The throttle, which changes what a run observes without changing what a figure means.</summary>
    private const string ConcurrencyKey = "maxConcurrency";

    /// <summary>
    /// The harness settings this build understands well enough to print.
    /// </summary>
    /// <remarks>
    /// <b>An allowlist, because an artifact is a file anyone can write.</b>
    /// <see cref="EvaluationEnvironment.HarnessConfig"/> is an open map of strings; this build
    /// writes three keys into it and a hand-written or future artifact may carry anything,
    /// including a credential somebody parked in a setting. A caveat is rendered into a
    /// pull-request comment and into stderr, so a setting whose contents this build cannot vouch
    /// for is counted rather than named.
    /// </remarks>
    private static readonly string[] Printable = [ConcurrencyKey, IntervalMethodKey, IntervalConfidenceKey];

    /// <summary>
    /// A harness setting's value re-parsed into a typed form, or a statement that it would not
    /// parse.
    /// </summary>
    /// <param name="key">The setting, which is one of this type's own literals.</param>
    /// <param name="value">The recorded text.</param>
    /// <returns>Text composed here, never the artifact's own.</returns>
    /// <remarks>
    /// <b>The recorded text is never printed — only a value this build re-derived from it.</b> A
    /// method name is matched against a closed set and the <i>matched literal</i> is what reaches
    /// the page; a number is parsed and re-rendered. That makes the output a function of this
    /// build's own strings and an integer, so there is no path by which an artifact's bytes reach
    /// a reader, and no redaction net to get wrong.
    /// </remarks>
    private static string Typed(string key, string? value)
    {
        if (value is null)
        {
            return "none";
        }

        return key switch
        {
            IntervalMethodKey => value switch
            {
                "wilson" => "'wilson'",
                "agrestiCoull" => "'agrestiCoull'",
                _ => Unrecognised,
            },
            IntervalConfidenceKey => double.TryParse(
                value,
                NumberStyles.Float,
                CultureInfo.InvariantCulture,
                out var level
            ) && level is > 0 and < 1
                ? string.Create(CultureInfo.InvariantCulture, $"'{level}'")
                : Unrecognised,
            ConcurrencyKey => int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var throttle)
                ? Number(throttle)
                : Unrecognised,
            _ => Unrecognised,
        };
    }

    /// <summary>What a value this build could not re-derive is called.</summary>
    internal const string Unrecognised = "an unrecognised value";

    /// <summary>Builds one scenario's series, classifying every position that carries no record.</summary>
    private static List<TrendSeries> Classify(
        TrendArtifact[] ordered,
        List<Dictionary<string, ScenarioResult>> index,
        MarkdownReport.IntervalSettings settings
    )
    {
        var ids = index
            .SelectMany(entries => entries.Keys)
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal);

        var series = new List<TrendSeries>();

        foreach (var id in ids)
        {
            var recorded = Enumerable.Range(0, ordered.Length).Where(slot => index[slot].ContainsKey(id)).ToArray();
            var firstRecord = recorded[0];
            var lastRecord = recorded[^1];
            var observations = new List<TrendObservation>(ordered.Length);

            for (var slot = 0; slot < ordered.Length; slot++)
            {
                var present = index[slot].TryGetValue(id, out var scenario);

                // Two mutants survive here and are equivalent rather than untested: widening
                // `slot < firstRecord` to `<=`, and `slot > lastRecord` to `>=`. Both boundaries
                // are slots the scenario is present at, so the guard above has already taken the
                // `TrendGap.None` arm and the comparison is never evaluated there. Swapping the
                // two arms, collapsing the interior arm, and comparing against the wrong record
                // are all killed — see SuiteTrendTests.
                observations.Add(
                    new TrendObservation
                    {
                        Position = slot + 1,
                        Point = present ? Point(scenario!, settings) : TrendPoint.NotRecorded,
                        Gap =
                            present ? TrendGap.None
                            : slot < firstRecord ? TrendGap.BeforeFirstRecord
                            : slot > lastRecord ? TrendGap.AfterLastRecord
                            : TrendGap.Interior,
                        Recorded = scenario,
                    }
                );
            }

            series.Add(
                new TrendSeries
                {
                    ScenarioId = id,
                    Observations = observations,
                    InStableCore = observations.TrueForAll(entry => entry.Point == TrendPoint.Graded),
                }
            );
        }

        return series;
    }

    /// <summary>
    /// What one artifact's record of one scenario is worth.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Branches exactly as <see cref="MarkdownReport.Rate"/> does, because the cell and the
    /// classification must be two views of one judgement.</b> The consistency check is that same
    /// method's, so a cell the renderer withholds cannot be counted into the stable core — were
    /// the two to disagree, a scenario whose figures are not printable anywhere on the page would
    /// still be weighted into the suite-level rate, the most authoritative number in the document.
    /// </para>
    /// <para>
    /// <b>The two no-summary cases are kept apart</b>, as the renderer keeps them apart. No
    /// repetition producing a verdict means nothing was learned; repetitions producing verdicts
    /// with no aggregate over them means something was learned and the artifact's own figures
    /// cannot be shown to describe it. Collapsing those into one state would be this report's own
    /// defect turned inward.
    /// </para>
    /// </remarks>
    private static TrendPoint Point(ScenarioResult scenario, MarkdownReport.IntervalSettings settings)
    {
        var graded = scenario.Runs.Count(run => run.Status != RunStatus.Error);

        // Before the summary is looked at, exactly as MarkdownReport.Rate does it. An artifact
        // that aggregates runs it does not have would otherwise be classified Graded, enter the
        // stable core, and contribute a pass rate of zero to the most authoritative figure in the
        // document — from a scenario nobody graded.
        if (graded == 0)
        {
            return TrendPoint.Ungradeable;
        }

        if (scenario.Summary is not { } summary)
        {
            return TrendPoint.Withheld;
        }

        var passed = scenario.Runs.Count(run => run.Status == RunStatus.Pass);

        return MarkdownReport.Inconsistent(summary, graded, passed, settings) is null
            ? TrendPoint.Graded
            : TrendPoint.Withheld;
    }

    /// <summary>
    /// The suite-level figures at one position, pooled over the stable core and nothing else.
    /// </summary>
    /// <remarks>
    /// <b>The population is held fixed across the series on purpose.</b> Pooling whatever each
    /// artifact happened to carry produces a line that moves when the population moves rather than
    /// when behaviour does — a suite that dropped its three worst scenarios would read as a suite
    /// that improved. The core is every scenario graded at every position, and the scenarios
    /// outside it are named in the report rather than averaged into it.
    /// </remarks>
    private static TrendPosition Position(
        TrendArtifact artifact,
        int position,
        Dictionary<string, ScenarioResult> index,
        IReadOnlyList<string> core
    )
    {
        var passed = 0;
        var graded = 0;

        foreach (var id in core)
        {
            var scenario = index[id];

            passed += scenario.Runs.Count(run => run.Status == RunStatus.Pass);
            graded += scenario.Runs.Count(run => run.Status != RunStatus.Error);
        }

        return new TrendPosition
        {
            Position = position,
            Artifact = artifact,
            ScenariosRecorded = index.Count,
            CorePassed = passed,
            CoreGraded = graded,
        };
    }

    /// <summary>Records every setting that moved mid-series without being behaviour.</summary>
    /// <remarks>
    /// Reported rather than refused, and reported at the position it moved, so a reader who sees
    /// the line change at position four can see that the throttle changed there too. Each artifact
    /// is compared against its predecessor rather than against the first, which is what makes the
    /// position meaningful: a setting that moves twice is two caveats, not one.
    /// </remarks>
    private static (List<TrendCaveat> Caveats, int Unnamed) SettingsThatMoved(TrendArtifact[] ordered)
    {
        var caveats = new List<TrendCaveat>();
        var unnamed = 0;

        for (var slot = 1; slot < ordered.Length; slot++)
        {
            var before = ordered[slot - 1].Result.Environment;
            var after = ordered[slot].Result.Environment;

            if (before.Seed != after.Seed)
            {
                // A typed long on both sides. Nothing here came out of the artifact as text.
                caveats.Add(new TrendCaveat("seed", slot + 1, Number(before.Seed), Number(after.Seed)));
            }

            var keys = before
                .HarnessConfig.Keys.Concat(after.HarnessConfig.Keys)
                .Distinct(StringComparer.Ordinal)
                .Order(StringComparer.Ordinal);

            foreach (var key in keys)
            {
                if (key is IntervalMethodKey or IntervalConfidenceKey)
                {
                    // Already refused above. Stating a caveat here as well would describe a series
                    // that cannot exist.
                    continue;
                }

                var was = before.HarnessConfig.TryGetValue(key, out var left) ? left : null;
                var now = after.HarnessConfig.TryGetValue(key, out var right) ? right : null;

                if (string.Equals(was, now, StringComparison.Ordinal))
                {
                    continue;
                }

                if (!Printable.Contains(key, StringComparer.Ordinal))
                {
                    // Counted, not named. The key and the value are both artifact bytes, and this
                    // caveat is rendered into a pull-request comment and into stderr.
                    unnamed++;

                    continue;
                }

                caveats.Add(new TrendCaveat(key, slot + 1, Typed(key, was), Typed(key, now)));
            }
        }

        return (caveats, unnamed);
    }

    /// <summary>What a caveat says about a setting one of the two runs did not record at all.</summary>
    private const string NotRecorded = "not recorded";

    /// <summary>
    /// An identifier out of an artifact, reduced to something a build log may carry.
    /// </summary>
    /// <param name="value">The suite name or scenario id.</param>
    /// <returns>The safe form.</returns>
    /// <remarks>
    /// <b>Through the report's own net, because stderr is a published surface too.</b> The
    /// engine's authoring-time control exempts a leading request method — ADR 0005 records that
    /// <c>GET /home/dashboard</c> must load and that the exemption necessarily admits
    /// <c>GET /home/ci-user/repo</c> — so an identifier carrying a machine path behind a method
    /// token reaches artifact read-back intact. That concession was made against the Markdown
    /// document, where the report's stricter net catches it. A refusal printed to the build log is
    /// a second published surface, and it must not inherit the concession by omission.
    /// </remarks>
    private static string Named(string? value) =>
        MarkdownReport.Sanitize(value, MarkdownReport.MaxIdentifierCharacters);

    private static int First(TrendSeries series) =>
        series.Observations.First(entry => entry.Point != TrendPoint.NotRecorded).Position;

    private static int Last(TrendSeries series) =>
        series.Observations.Last(entry => entry.Point != TrendPoint.NotRecorded).Position;

    private static string? Setting(TrendArtifact artifact, string key) =>
        artifact.Result.Environment.HarnessConfig.TryGetValue(key, out var value) ? value : null;

    /// <summary>The one instant format this tool prints, at the precision it orders on.</summary>
    /// <param name="value">The instant.</param>
    /// <returns>The rendering.</returns>
    /// <remarks>
    /// <b>Full tick precision, because the order is decided on ticks.</b> Printing seconds renders
    /// two correctly ordered runs as one timestamp, and beside a refusal about runs stamped with
    /// the same instant that reads as a tool which failed to make its own check. Correct
    /// behaviour that looks wrong is its own defect. One formatter so the roster, the header, the
    /// footer and the tie refusal cannot disagree about what a timestamp is.
    /// </remarks>
    internal static string Instant(DateTimeOffset value) =>
        value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", CultureInfo.InvariantCulture);

    private static string Number(long value) => value.ToString(CultureInfo.InvariantCulture);

    private static EvalCliException Refuse(string message, string? remedy = null) =>
        new(ExitCode.ComparisonRefused, message, remedy ?? Remedy);
}
