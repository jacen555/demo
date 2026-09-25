using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Serialization;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Results;

/// <summary>
/// The verdict for one run of one scenario.
/// </summary>
public enum RunStatus
{
    /// <summary>Every assertion held.</summary>
    Pass,

    /// <summary>The run completed and at least one assertion did not hold.</summary>
    Fail,

    /// <summary>The run did not complete — transport, configuration, or harness failure.</summary>
    Error,

    /// <summary>
    /// The run failed and was expected to. Distinguished from <see cref="Fail"/> so a known gap
    /// does not read as a regression, and so newly-covered scenarios are visible when it clears.
    /// </summary>
    ExpectedFailure,
}

/// <summary>
/// One run of one scenario: what happened, and how it was judged.
/// </summary>
public sealed record RunResult
{
    /// <summary>Gets what happened during the run.</summary>
    public required Transcript Transcript { get; init; }

    /// <summary>Gets the verdict of each assertion.</summary>
    public IReadOnlyList<AssertionResult> AssertionResults { get; init; } = [];

    /// <summary>Gets the overall verdict.</summary>
    public required RunStatus Status { get; init; }

    /// <summary>
    /// Gets why the run errored, when <see cref="Status"/> is <see cref="RunStatus.Error"/>.
    /// </summary>
    /// <remarks>
    /// An errored run must never be silent. This field carries the caller-facing reason; the
    /// harness logs the underlying failure once, at the point it decides the run is an error.
    /// </remarks>
    public string? ErrorDetail { get; init; }
}

/// <summary>
/// Every run of one scenario, plus the aggregate across them.
/// </summary>
public sealed record ScenarioResult
{
    /// <summary>Gets the scenario's identifier — the join key against a baseline artifact.</summary>
    public required string ScenarioId { get; init; }

    /// <summary>
    /// Gets the kind of scenario. Carried into the artifact so the reporter can roll results up
    /// by kind without needing the suite file that produced them.
    /// </summary>
    public required ScenarioKind Kind { get; init; }

    /// <summary>Gets the individual runs, in execution order.</summary>
    public IReadOnlyList<RunResult> Runs { get; init; } = [];

    /// <summary>Gets the aggregate across the runs, or null when none was computed.</summary>
    public StatisticalSummary? Summary { get; init; }

    /// <summary>
    /// Gets the repetition policy that was actually applied, which may differ from the scenario's
    /// declared policy when the harness was told to override it.
    /// </summary>
    public required RepetitionPolicy RepetitionPolicyUsed { get; init; }

    /// <summary>
    /// Gets the <see cref="Scenarios.ScenarioFingerprint"/> of the definition these runs were
    /// produced from, or <see langword="null"/> when the artifact's writer recorded none.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The id is a join key; this is the evidence that two artifacts mean the same thing by it.
    /// Without it, a suite author can edit <see cref="Scenarios.Grading.ExpectedOutcome"/>, leave
    /// the assertion spec untouched, and have an unchanged system response reported as a fix the
    /// change earned.
    /// </para>
    /// <para>
    /// Optional rather than required, because an artifact outlives the engine that wrote it and
    /// one written before this field existed is still readable — an additive field that
    /// serializes as absent does not bump
    /// <see cref="SchemaVersions.SuiteResult"/>. A missing fingerprint is not treated as a
    /// match: <see cref="Comparison.SuiteComparator"/> reports the scenario
    /// <see cref="Comparison.ScenarioClassification.NotComparable"/>, which is the safe
    /// direction.
    /// </para>
    /// </remarks>
    public string? DefinitionFingerprint { get; init; }

    /// <summary>
    /// Gets the scenario's slicing dimensions, copied in so the artifact can be sliced on its own.
    /// </summary>
    public IReadOnlyDictionary<string, string> Tags { get; init; } =
        new Dictionary<string, string>(StringComparer.Ordinal);
}

/// <summary>
/// What the selector decided about one scenario it was offered.
/// </summary>
/// <remarks>
/// <see cref="Selected"/> is first, and therefore the default, because of the asymmetry the
/// selector itself is built around: over-selecting costs time and under-selecting costs
/// correctness. A scenario that should have run and did not produces no output at all — there is
/// no wrong number in a report to catch it, just silence and a green result. A value nobody set
/// therefore reads as the claim that creates an obligation: the artifact is expected to carry
/// this scenario, and a reader who cannot find it is told so. The opposite default would excuse
/// the absence as deliberate and manufacture exactly the silence this type exists to prevent.
/// </remarks>
public enum SelectionDecision
{
    /// <summary>The selector chose to run the scenario.</summary>
    Selected,

    /// <summary>
    /// The selector chose not to run the scenario, so this run produced no evidence about it.
    /// </summary>
    /// <remarks>
    /// A scenario reaches this from one state only: its declared globs were all interpreted, none
    /// of them matched a changed file, and the baseline records a trustworthy pass for it. That
    /// is why no reason travels with the decision — unlike
    /// <see cref="Impact.SelectionReason"/>, which distinguishes five ways a scenario can earn a
    /// place in a run, there is exactly one way to lose one.
    /// </remarks>
    Skipped,
}

/// <summary>
/// The selector's decision about one scenario, as recorded in the artifact.
/// </summary>
/// <remarks>
/// Distinct from <see cref="Impact.ScenarioSelection"/>, which is the work list handed to a
/// coordinator. This is the durable record of the decision, and it deliberately carries less:
/// see <see cref="SuiteResult.SelectionDecisions"/> for what is left out and why.
/// </remarks>
public sealed record RecordedSelection
{
    /// <summary>Gets the scenario's identifier — the join key the artifact files everything under.</summary>
    public required string ScenarioId { get; init; }

    /// <summary>Gets what the selector decided.</summary>
    public required SelectionDecision Decision { get; init; }
}

/// <summary>
/// Everything needed to reproduce a suite run.
/// </summary>
public sealed record EvaluationEnvironment
{
    /// <summary>Gets the address the suite was run against.</summary>
    public string? Endpoint { get; init; }

    /// <summary>Gets the reference of the baseline artifact this run was compared against.</summary>
    public string? BaselineRef { get; init; }

    /// <summary>
    /// Gets the root seed the run was driven with. Stamped so the run can be reproduced exactly;
    /// it comes from an injected <see cref="Abstractions.ISeedSource"/>, never from ambient
    /// randomness.
    /// </summary>
    public required long Seed { get; init; }

    /// <summary>
    /// Gets when the run started, taken from an injected <see cref="Abstractions.IClock"/>.
    /// </summary>
    public required DateTimeOffset Timestamp { get; init; }

    /// <summary>Gets the harness settings in force, for a reader trying to reproduce the run.</summary>
    public IReadOnlyDictionary<string, string> HarnessConfig { get; init; } =
        new Dictionary<string, string>(StringComparer.Ordinal);
}

/// <summary>
/// The durable, canonical, versioned artifact for one suite run.
/// </summary>
/// <remarks>
/// <para>
/// This is the committable output of the harness and the thing a later run compares against. It
/// is written through <see cref="CanonicalJson"/>, which gives it a stable key order at every
/// level — without that, an unrelated change to a property's declaration order would produce a
/// diff across the whole file and drown the real signal.
/// </para>
/// <para>
/// <see cref="SchemaVersion"/> is <b>stamped, not supplied</b>: a writer cannot label an artifact
/// with a version it was not written to, and a reader checks it through
/// <see cref="CanonicalJson.DeserializeSuiteResult(string)"/> before trusting the shape.
/// </para>
/// <para>
/// Equality is by <b>canonical value</b>, not by collection reference. That costs a
/// serialization per comparison, which is the right trade for a type whose whole identity is its
/// committed text and whose consumer is a comparator.
/// </para>
/// </remarks>
public sealed record SuiteResult
{
    /// <summary>
    /// Gets the schema version this artifact was written with. Always the version this engine
    /// writes; it is not caller-settable.
    /// </summary>
    public string SchemaVersion { get; } = SchemaVersions.SuiteResult;

    /// <summary>Gets the name of the suite that was run.</summary>
    public required string SuiteName { get; init; }

    /// <summary>Gets the result for each scenario, in suite order.</summary>
    public IReadOnlyList<ScenarioResult> ScenarioResults { get; init; } = [];

    /// <summary>
    /// Gets what the selector decided for each scenario it was offered, ordered by identifier, or
    /// <see langword="null"/> when the writer recorded no selection.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Without this an absence has four possible meanings and the artifact can express one.</b>
    /// A scenario missing from <see cref="ScenarioResults"/> may have been skipped by the
    /// selector, may never have been in the suite, or may have been selected and lost by a run
    /// that failed before recording it. Those lead to different actions and the first two are not
    /// even the same kind of fact — one is an economy, the other is a suite change. With the
    /// decisions recorded, a reader separates them: skipped is stated, selected-and-absent is
    /// visible as a decision with no result beside it, and never-offered is absent from this list
    /// too.
    /// </para>
    /// <para>
    /// <b><see langword="null"/> is not an empty list.</b> Null says no selection was recorded —
    /// an artifact written before this field existed, or by a run that made no selection — and
    /// establishes nothing about any absence. An empty list says the selector ran and skipped
    /// nothing. Collapsing them would let a reader draw the second conclusion from the first
    /// artifact.
    /// </para>
    /// <para>
    /// <b>The decision is recorded; the reason for it is not.</b> The selector knows why it chose
    /// each scenario, and <see cref="Impact.ScenarioSelection.Detail"/> composes that from the
    /// glob and the <i>changed file</i> that matched. Changed files arrive from a caller's
    /// revision range, they are paths rather than authored identifiers, and this artifact is
    /// committed and published — so carrying the detail here would open a path-shaped disclosure
    /// on a surface that did not exist when the machine-path trade-offs were reasoned about
    /// (ADR 0005, which is explicit that a documented trade-off is scoped to the surfaces that
    /// existed when it was made). Nothing downstream of the artifact asks for the reason either:
    /// a run report renders it live from <see cref="Impact.SelectionResult"/>, where the values
    /// never reach a committed file.
    /// </para>
    /// <para>
    /// Ordered by identifier rather than by suite position, matching
    /// <see cref="SlicingDimensions"/>. The order carries no information, and one that tracked
    /// suite position would turn an unrelated reordering of the suite file into a diff across the
    /// whole list — the noise canonical serialization exists to stop.
    /// </para>
    /// <para>
    /// Optional, and absent from the JSON when unset, so an artifact written before this field
    /// existed still reads and <see cref="SchemaVersions.SuiteResult"/> does not move.
    /// </para>
    /// </remarks>
    public IReadOnlyList<RecordedSelection>? SelectionDecisions { get; init; }

    /// <summary>
    /// Gets the slicing dimension names present across the suite, so a reporter can offer them
    /// without scanning every scenario.
    /// </summary>
    public IReadOnlyList<string> SlicingDimensions { get; init; } = [];

    /// <summary>Gets what is needed to reproduce the run.</summary>
    public required EvaluationEnvironment Environment { get; init; }

    /// <summary>Determines whether another artifact has the same canonical value.</summary>
    /// <param name="other">The artifact to compare against, or null.</param>
    /// <returns><see langword="true"/> when both serialize to identical canonical JSON.</returns>
    public bool Equals(SuiteResult? other) => CanonicalJson.AreEquivalent(this, other);

    /// <summary>Returns a hash consistent with canonical-value equality.</summary>
    /// <returns>The hash of this artifact's canonical JSON.</returns>
    public override int GetHashCode() => StringComparer.Ordinal.GetHashCode(CanonicalJson.Serialize(this));
}
