using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Paths;

namespace Forge.EvalEngine.Scenarios;

/// <summary>
/// What a correct result looks like. Owned by the assertion evaluators; no other stage reads it.
/// </summary>
public sealed record Grading
{
    private readonly string? _expectedOutcome;
    private readonly string? _expectedPath;

    /// <summary>
    /// Gets the outcome the system under test is expected to reach. Compared against
    /// <see cref="Transcripts.Outcome.ObservedOutcome"/>.
    /// </summary>
    /// <remarks>
    /// A blank value is refused rather than stored, so that "declared" and "absent" are the only
    /// two states anything downstream has to reason about. The script-overrun guard reads a blank
    /// expectation as absent and passes over it, which would leave the scenario carrying an
    /// expectation nothing had scoped.
    /// </remarks>
    /// <exception cref="ArgumentException">The value is empty or whitespace.</exception>
    public string? ExpectedOutcome
    {
        get => _expectedOutcome;
        init => _expectedOutcome = Declared(value, "expectedOutcome");
    }

    /// <summary>
    /// Gets the route the system under test is expected to take to that outcome. Compared against
    /// <see cref="Transcripts.Outcome.ObservedPath"/>.
    /// </summary>
    /// <remarks>Blank is refused for the same reason as <see cref="ExpectedOutcome"/>.</remarks>
    /// <exception cref="ArgumentException">The value is empty or whitespace.</exception>
    public string? ExpectedPath
    {
        get => _expectedPath;
        init => _expectedPath = Declared(value, "expectedPath");
    }

    /// <summary>Gets the assertions evaluated against the transcript.</summary>
    public IReadOnlyList<AssertionSpec> Assertions { get; init; } = [];

    /// <summary>
    /// Gets the declared carve-out for a known failure, or <see langword="null"/> when there is
    /// none.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A carve-out says "this scenario is known not to work, and that is not news". The
    /// coordinator stamps <see cref="Results.RunStatus.ExpectedFailure"/> instead of
    /// <see cref="Results.RunStatus.Fail"/> when a carved-out scenario's assertions do not hold,
    /// so a reader can tell a known gap from a failure the change just caused.
    /// </para>
    /// <para>
    /// <b>It lives inside <see cref="Grading"/> deliberately, so it is fingerprinted.</b>
    /// <see cref="ScenarioFingerprint"/> covers grading, so adding or removing a carve-out moves
    /// the fingerprint and <see cref="Comparison.SuiteComparator"/> reports the scenario
    /// not-comparable. Outside grading it would be invisible to the digest, and a carve-out added
    /// between two runs would silently turn a regression into a stable failure — the same
    /// fabrication as editing <see cref="ExpectedOutcome"/> while leaving the assertion spec
    /// alone.
    /// </para>
    /// <para>
    /// <b>It excuses a verdict, never the absence of one.</b> A run that gathered no evidence
    /// stays <see cref="Results.RunStatus.Error"/>, and a carved-out scenario that passes is
    /// recorded as a pass — a gap clearing is the headline the harness exists to produce.
    /// </para>
    /// </remarks>
    public ExpectedFailure? ExpectedFailure { get; init; }

    private static string? Declared(string? value, string field) =>
        value is null || !string.IsNullOrWhiteSpace(value)
            ? value
            : throw new ArgumentException(
                $"grading.{field} must not be blank when it is declared; omit it instead of blanking it.",
                nameof(value)
            );
}

/// <summary>
/// A declared carve-out: this scenario is known to fail, and that is not a regression.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="Results.RunStatus.ExpectedFailure"/> is read by the aggregator, the comparator, and
/// the selector, and this is what produces one. Without it every known gap arrives as an ordinary
/// <see cref="Results.RunStatus.Fail"/> and is indistinguishable in a committed artifact from a
/// failure the change under review just caused.
/// </para>
/// <para>
/// <b>A carve-out does not inflate anything.</b> An expected failure still counts as a graded
/// non-pass everywhere a rate is computed, so the pass rate, the interval, and the paired
/// statistics are exactly what they would have been. What it changes is what a <i>reader</i> —
/// and a gate that treats the two differently — can tell apart.
/// </para>
/// </remarks>
public sealed record ExpectedFailure
{
    private readonly string _reason = string.Empty;

    /// <summary>Gets why the failure is known and accepted.</summary>
    /// <remarks>
    /// Required and non-blank. A carve-out with no stated reason is an exclusion nobody can
    /// review, and this value is written verbatim into a committed, published artifact so that a
    /// reader can see what was excluded and why. Blank is refused rather than stored, exactly as
    /// <see cref="Grading.ExpectedOutcome"/> refuses one — "declared" and "absent" are the only
    /// two states anything downstream has to reason about.
    /// </remarks>
    /// <exception cref="ArgumentException">The value is null, empty, or whitespace.</exception>
    public required string Reason
    {
        get => _reason;
        init =>
            _reason = string.IsNullOrWhiteSpace(value)
                ? throw new ArgumentException(
                    "An expected-failure carve-out must state why the failure is known and accepted. A carve-out "
                        + "excludes a scenario from reading as a regression, and one with no stated reason is an "
                        + "exclusion nobody can review. Omit the carve-out instead of blanking its reason.",
                    nameof(value)
                )
                : value;
    }
}

/// <summary>
/// The inputs to scenario selection. Owned by the selector; no other stage reads it.
/// </summary>
public sealed record Selection
{
    /// <summary>
    /// Gets the glob patterns whose matching source changes should cause this scenario to be
    /// selected for a run.
    /// </summary>
    public IReadOnlyList<string> ImpactGlobs { get; init; } = [];
}

/// <summary>
/// The dimensions used to slice results. Read only when reporting — never during execution.
/// </summary>
public sealed record Slicing
{
    /// <summary>
    /// Gets the free-form slicing dimensions for this scenario.
    /// </summary>
    /// <remarks>
    /// This is deliberately an open dictionary and <b>not</b> a fixed enum. A closed set would
    /// force every new way of grouping results to become a change to this library; an open one
    /// keeps slicing a property of the suite. Nothing in the execution path may read it.
    /// </remarks>
    public IReadOnlyDictionary<string, string> Tags { get; init; } =
        new Dictionary<string, string>(StringComparer.Ordinal);
}
