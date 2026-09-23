namespace Forge.EvalEngine.Scenarios;

/// <summary>
/// A named, validated collection of scenarios loaded from a suite file.
/// </summary>
/// <remarks>
/// A <see cref="Suite"/> is only produced by
/// <see cref="Loading.SuiteLoader"/>, which validates it first. Holding an instance therefore
/// means validation passed — including the script-overrun guard.
/// </remarks>
public sealed record Suite
{
    /// <summary>Gets the schema version the suite file declared.</summary>
    public string SchemaVersion { get; init; } = Serialization.SchemaVersions.Suite;

    /// <summary>Gets the suite name, used to label the resulting artifact.</summary>
    public required string Name { get; init; }

    /// <summary>Gets the scenarios in the suite, in file order.</summary>
    public IReadOnlyList<Scenario> Scenarios { get; init; } = [];
}
