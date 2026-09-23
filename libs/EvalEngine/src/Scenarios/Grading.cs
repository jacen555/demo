using Forge.EvalEngine.Assertions;

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

    private static string? Declared(string? value, string field) =>
        value is null || !string.IsNullOrWhiteSpace(value)
            ? value
            : throw new ArgumentException(
                $"grading.{field} must not be blank when it is declared; omit it instead of blanking it.",
                nameof(value)
            );
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
