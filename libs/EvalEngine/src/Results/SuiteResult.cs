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
    /// Gets the scenario's slicing dimensions, copied in so the artifact can be sliced on its own.
    /// </summary>
    public IReadOnlyDictionary<string, string> Tags { get; init; } =
        new Dictionary<string, string>(StringComparer.Ordinal);
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
