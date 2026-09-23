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
    /// Gets a value indicating whether a suite was produced with no errors. Warnings do not
    /// prevent success, but they are still worth surfacing.
    /// </summary>
    public bool Succeeded => Suite is not null && !Messages.Any(m => m.Severity == ValidationSeverity.Error);
}
