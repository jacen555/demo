using Forge.EvalEngine.Coordination;

namespace Forge.EvalCli.Cli;

/// <summary>
/// The raw option values as parsed, before any of them have been validated.
/// </summary>
/// <remarks>
/// Separated from <see cref="RunPlan"/> so that "parsed" and "validated" are different types.
/// Nothing downstream can accidentally consume an unchecked path or an unchecked endpoint, because
/// the only way to get a <see cref="RunPlan"/> is through
/// <see cref="RunPlan.Create(RunRequest)"/>.
/// </remarks>
internal sealed record RunRequest
{
    /// <summary>Gets the suite path as supplied.</summary>
    public required string Suite { get; init; }

    /// <summary>Gets the containment root as supplied.</summary>
    public required string Root { get; init; }

    /// <summary>Gets the baseline artifact path as supplied, or <see langword="null"/>.</summary>
    public string? Baseline { get; init; }

    /// <summary>Gets the artifact destination as supplied, or <see langword="null"/>.</summary>
    public string? Out { get; init; }

    /// <summary>Gets whether replacing an existing artifact was opted into.</summary>
    public bool Overwrite { get; init; }

    /// <summary>Gets the root seed as supplied.</summary>
    public long Seed { get; init; }

    /// <summary>Gets the concurrency ceiling as supplied.</summary>
    public int MaxConcurrency { get; init; } = 1;

    /// <summary>Gets the whole-suite run budget as supplied.</summary>
    public int MaxTotalRuns { get; init; } = RunPlan.DefaultMaxTotalRuns;

    /// <summary>Gets the endpoint as supplied, or <see langword="null"/>.</summary>
    public string? Endpoint { get; init; }

    /// <summary>Gets whether the caller asked for a preview instead of a run.</summary>
    public bool DryRun { get; init; }

    /// <summary>Gets whether the caller asked for machine-readable output.</summary>
    public bool Json { get; init; }

    /// <summary>Gets whether the caller asked for the not-yet-implemented gate.</summary>
    public bool FailOnRegression { get; init; }

    /// <summary>Gets whether the caller asked for verbose diagnostics.</summary>
    public bool Verbose { get; init; }
}

/// <summary>
/// A validated, fully resolved description of the run that was asked for.
/// </summary>
/// <remarks>
/// Every path here is canonical and confirmed to sit inside <see cref="RootDirectory"/>, and
/// <see cref="EndpointDisplay"/> is the only address-shaped value anything is permitted to print.
/// </remarks>
internal sealed record RunPlan
{
    /// <summary>The whole-suite run budget the engine applies when a caller does not raise it.</summary>
    internal const int DefaultMaxTotalRuns = 100_000;

    /// <summary>The only gate mode this build supports.</summary>
    /// <remarks>
    /// Report-only is the default and, for now, the only behaviour: the gate that turns a
    /// regression into a non-zero exit is reserved, not implemented. The mode is stated in the
    /// plan rather than implied so that a reader of a dry run can see which one is in force.
    /// </remarks>
    internal const string ReportOnlyGate = "report-only";

    /// <summary>Gets the canonical path to the suite definition.</summary>
    public required string SuitePath { get; init; }

    /// <summary>Gets the canonical root every other path is confined to.</summary>
    public required string RootDirectory { get; init; }

    /// <summary>Gets the canonical path to the baseline artifact, or <see langword="null"/>.</summary>
    public string? BaselinePath { get; init; }

    /// <summary>Gets the canonical path the artifact would be written to, or <see langword="null"/>.</summary>
    public string? ArtifactPath { get; init; }

    /// <summary>Gets whether replacing an existing artifact was opted into.</summary>
    public bool OverwriteArtifact { get; init; }

    /// <summary>Gets the root seed every run is derived from.</summary>
    public required long RootSeed { get; init; }

    /// <summary>Gets the ceiling on runs in flight at once.</summary>
    public required int MaxConcurrency { get; init; }

    /// <summary>Gets the ceiling on runs the whole suite may plan.</summary>
    public required int MaxTotalRuns { get; init; }

    /// <summary>
    /// Gets the validated address a later stage would dial, or <see langword="null"/>.
    /// </summary>
    /// <remarks>
    /// <b>Never print this.</b> It retains the query string, which a dialling stage needs and
    /// which is exactly where a token hides. <see cref="EndpointDisplay"/> is the printable form.
    /// </remarks>
    public Uri? Endpoint { get; init; }

    /// <summary>Gets the redacted address, or <see langword="null"/>. The only printable form.</summary>
    public string? EndpointDisplay { get; init; }

    /// <summary>Gets whether this invocation is a preview that executes nothing.</summary>
    public bool DryRun { get; init; }

    /// <summary>Gets whether output should be machine-readable.</summary>
    public bool Json { get; init; }

    /// <summary>
    /// Gets whether the caller asked for the gate. Parsed and reported; it changes nothing yet.
    /// </summary>
    public bool FailOnRegression { get; init; }

    /// <summary>Gets whether diagnostics should be verbose.</summary>
    public bool Verbose { get; init; }

    /// <summary>Gets the gate mode in force. Always report-only in this build.</summary>
    /// <remarks>
    /// Get-only rather than settable: report-only is not a configuration choice in this build, and
    /// a plan must not be able to claim a gate that nothing enforces.
    /// </remarks>
    public string GateMode { get; } = ReportOnlyGate;

    /// <summary>Validates and resolves a parsed request into a plan.</summary>
    /// <param name="request">The raw option values.</param>
    /// <returns>The validated plan.</returns>
    /// <remarks>
    /// The root is resolved first, because every other path is checked against it. Validation is
    /// ordered so that the first thing a user is told about is the thing that invalidates the most
    /// of what follows.
    /// </remarks>
    /// <exception cref="ArgumentNullException"><paramref name="request"/> is null.</exception>
    /// <exception cref="EvalCliException">Any value is missing, malformed, or out of range.</exception>
    public static RunPlan Create(RunRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);

        var root = PathGuard.ResolveRoot(request.Root, "--root");
        var suite = PathGuard.ResolveExistingFile(request.Suite, root, "--suite");

        var baseline = request.Baseline is null
            ? null
            : PathGuard.ResolveExistingFile(request.Baseline, root, "--baseline");

        var artifact = request.Out is null
            ? null
            : PathGuard.ResolveOutputFile(request.Out, root, request.Overwrite, "--out", "--overwrite");

        if (request.MaxConcurrency < 1)
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                "--max-concurrency must be at least 1.",
                "Concurrency against a real system is a decision with consequences; 1 is the default for that reason."
            );
        }

        if (request.MaxTotalRuns < 1)
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                "--max-total-runs must be at least 1.",
                "This is the budget that turns a mistyped repetition count into a refusal instead of an exhausted host."
            );
        }

        Uri? endpoint = null;
        string? endpointDisplay = null;

        if (request.Endpoint is not null)
        {
            (endpoint, endpointDisplay) = EndpointGuard.Validate(request.Endpoint, "--endpoint");
        }

        return new RunPlan
        {
            SuitePath = suite,
            RootDirectory = root,
            BaselinePath = baseline,
            ArtifactPath = artifact,
            OverwriteArtifact = request.Overwrite,
            RootSeed = request.Seed,
            MaxConcurrency = request.MaxConcurrency,
            MaxTotalRuns = request.MaxTotalRuns,
            Endpoint = endpoint,
            EndpointDisplay = endpointDisplay,
            DryRun = request.DryRun,
            Json = request.Json,
            FailOnRegression = request.FailOnRegression,
            Verbose = request.Verbose,
        };
    }

    /// <summary>Builds the coordinator options this plan implies.</summary>
    /// <returns>The options, carrying only the redacted endpoint.</returns>
    /// <remarks>
    /// <see cref="RunCoordinatorOptions.Endpoint"/> is recorded into a committed artifact rather
    /// than dialled, so the redacted form is the correct one to hand it. The engine strips the
    /// same components again; passing the redacted form means there is no window in which an
    /// unredacted address is held by something whose job is to serialize itself.
    /// </remarks>
    public RunCoordinatorOptions ToCoordinatorOptions() =>
        new()
        {
            MaxConcurrency = MaxConcurrency,
            MaxTotalRuns = MaxTotalRuns,
            Endpoint = EndpointDisplay,
        };
}
