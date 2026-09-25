using Forge.EvalEngine.Scenarios;

namespace Forge.EvalEngine.Loading;

/// <summary>
/// How seriously to take a validation finding.
/// </summary>
public enum ValidationSeverity
{
    /// <summary>The suite is usable, but something about it is likely to mislead.</summary>
    Warning,

    /// <summary>The suite is not usable. Loading fails.</summary>
    Error,
}

/// <summary>
/// One finding from validating a suite.
/// </summary>
public sealed record ValidationMessage
{
    /// <summary>Gets how seriously to take the finding.</summary>
    public required ValidationSeverity Severity { get; init; }

    /// <summary>Gets a stable machine-readable code, for example <c>scenario.assertion.scriptOverrun</c>.</summary>
    public required string Code { get; init; }

    /// <summary>
    /// Gets the identifier of the offending scenario, or null for a suite-level finding.
    /// </summary>
    public string? ScenarioId { get; init; }

    /// <summary>Gets the caller-facing explanation, naming what is wrong and why it matters.</summary>
    public required string Message { get; init; }

    /// <summary>Returns a one-line rendering suitable for a console or a log.</summary>
    /// <returns>The rendered finding.</returns>
    public override string ToString() =>
        ScenarioId is null
            ? $"{Severity}: [{Code}] {Message}"
            : $"{Severity}: [{Code}] scenario '{ScenarioId}': {Message}";
}

/// <summary>
/// The outcome of attempting to load a suite.
/// </summary>
/// <remarks>
/// Content problems are returned rather than thrown, so a caller can report every finding at once
/// instead of discovering them one exception at a time.
/// </remarks>
public sealed record SuiteLoadResult
{
    /// <summary>Gets the loaded suite, or null when loading failed.</summary>
    public Suite? Suite { get; init; }

    /// <summary>Gets every finding, in the order they were produced.</summary>
    public IReadOnlyList<ValidationMessage> Messages { get; init; } = [];

    /// <summary>
    /// Gets the source this result was produced from, exactly as it was named — the resolved
    /// suite path for a file load, or the caller's own label for a document load.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>This is the only place the real path survives, and that is deliberate.</b> A finding
    /// names the suite in a form carrying no machine path, because the command-line tool writes
    /// findings to standard error and from there into CI logs, which on many setups are readable
    /// by anyone who can read the repository (§V). Removing the path from the message and from
    /// the result alike would trade that disclosure for a usability defect, so it is kept here
    /// for programmatic use and for a caller that decides to print it under its own policy.
    /// </para>
    /// <para>
    /// <b>A caller that renders this is choosing to.</b> That includes rendering this record
    /// itself: the compiler-generated <c>ToString()</c> of a record prints every property.
    /// Nothing in this library writes it anywhere.
    /// </para>
    /// </remarks>
    public string? SourcePath { get; init; }

    /// <summary>
    /// Gets a value indicating whether a suite was produced with no errors. Warnings do not
    /// prevent success, but they are still worth surfacing.
    /// </summary>
    public bool Succeeded => Suite is not null && !Messages.Any(m => m.Severity == ValidationSeverity.Error);
}
