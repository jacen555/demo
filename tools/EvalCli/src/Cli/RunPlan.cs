using Forge.EvalCli.Changes;
using Forge.EvalCli.Exchanges;
using Forge.EvalEngine.Coordination;

namespace Forge.EvalCli.Cli;

/// <summary>
/// Which adapter, if any, describes the system under test to a runner that needs one.
/// </summary>
/// <remarks>
/// <see cref="None"/> is first, and therefore the default, deliberately. An exchange encodes an
/// assumption about the shape of somebody else's system; a wrong one turns every reply into a
/// malformed-response finding that reads as a finding <i>about that system</i>. So no exchange is
/// wired unless one is named, and a suite whose kind has no runner records the gap as a harness
/// failure rather than as a pass.
/// </remarks>
internal enum ExchangeAdapter
{
    /// <summary>No adapter. The kind's runner is not registered, and the engine records the gap.</summary>
    None,

    /// <summary>The built-in JSON contract described on <see cref="JsonExchangeContract"/>.</summary>
    Json,
}

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

    /// <summary>Gets the revision to diff against as supplied, or <see langword="null"/>.</summary>
    public string? ChangedSince { get; init; }

    /// <summary>Gets the REST adapter name as supplied.</summary>
    public string? RestExchange { get; init; }

    /// <summary>Gets the conversational adapter name as supplied.</summary>
    public string? LlmExchange { get; init; }

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

    /// <summary>
    /// Gets the revision the changed-file set is read against, or <see langword="null"/> when no
    /// selection was asked for.
    /// </summary>
    /// <remarks>
    /// Null is not "select nothing" — it is "select everything, and say that is why". Impact
    /// selection is opt-in because choosing the wrong revision <i>shrinks</i> a run, and a
    /// scenario that should have run and did not leaves no trace in the report.
    /// </remarks>
    public string? ChangedSince { get; init; }

    /// <summary>Gets the adapter wired for REST scenarios.</summary>
    public ExchangeAdapter RestExchange { get; init; }

    /// <summary>Gets the adapter wired for conversational scenarios.</summary>
    public ExchangeAdapter LlmExchange { get; init; }

    /// <summary>Gets a value indicating whether any runner needing an address is wired.</summary>
    public bool RequiresEndpoint => RestExchange is not ExchangeAdapter.None || LlmExchange is not ExchangeAdapter.None;

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

        var guard = PathGuard.ForRoot(request.Root, "--root");
        var suite = guard.ResolveExistingFile(request.Suite, "--suite");

        var baseline = request.Baseline is null ? null : guard.ResolveExistingFile(request.Baseline, "--baseline");

        var artifact = request.Out is null
            ? null
            : guard.ResolveOutputFile(request.Out, request.Overwrite, "--out", "--overwrite");

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

        var changedSince = ValidateRevision(request.ChangedSince);
        var restExchange = ParseExchange(request.RestExchange, "--rest-exchange");
        var llmExchange = ParseExchange(request.LlmExchange, "--llm-exchange");

        if ((restExchange is not ExchangeAdapter.None || llmExchange is not ExchangeAdapter.None) && endpoint is null)
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                "An exchange was selected but --endpoint was not given, so there is nowhere to send a stimulus.",
                "Pass --endpoint <url> as well, or drop the exchange and let the run record the missing runner as "
                    + "a harness failure rather than dialling somewhere nobody named."
            );
        }

        return new RunPlan
        {
            SuitePath = suite,
            RootDirectory = guard.Root,
            BaselinePath = baseline,
            ArtifactPath = artifact,
            OverwriteArtifact = request.Overwrite,
            RootSeed = request.Seed,
            MaxConcurrency = request.MaxConcurrency,
            MaxTotalRuns = request.MaxTotalRuns,
            Endpoint = endpoint,
            EndpointDisplay = endpointDisplay,
            ChangedSince = changedSince,
            RestExchange = restExchange,
            LlmExchange = llmExchange,
            DryRun = request.DryRun,
            Json = request.Json,
            FailOnRegression = request.FailOnRegression,
            Verbose = request.Verbose,
        };
    }

    /// <summary>Validates the revision a changed-file set would be read against.</summary>
    /// <remarks>
    /// Whether the revision <i>exists</i> is git's question and git answers it. This refuses only
    /// the shapes that would stop it being read as a revision at all — chiefly a leading
    /// <c>-</c>, which git's own parser would take for an option.
    /// </remarks>
    private static string? ValidateRevision(string? changedSince)
    {
        if (changedSince is null)
        {
            return null;
        }

        if (!GitChangedFileSource.TryValidateRevision(changedSince, out var rejection))
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                $"--changed-since {rejection}.",
                "Give it a revision, a branch, or a commit id — for example --changed-since origin/main. Omit it "
                    + "and the whole suite runs, which is the safe default."
            );
        }

        return changedSince.Trim();
    }

    /// <summary>Reads an adapter name, refusing one this build does not have.</summary>
    /// <remarks>
    /// Validated here rather than by an option validator, so that the rules a test pins are the
    /// same rules the tool applies — the same reason every other value is checked in this method.
    /// </remarks>
    private static ExchangeAdapter ParseExchange(string? value, string optionName)
    {
        if (value is null || value.Trim().Length == 0)
        {
            return ExchangeAdapter.None;
        }

        return value.Trim() switch
        {
            var name when string.Equals(name, "none", StringComparison.OrdinalIgnoreCase) => ExchangeAdapter.None,
            var name when string.Equals(name, JsonExchangeContract.Name, StringComparison.OrdinalIgnoreCase) =>
                ExchangeAdapter.Json,
            _ => throw new EvalCliException(
                ExitCode.UsageError,
                $"{optionName} does not name an adapter this build has: {value}",
                $"This build knows 'none' and '{JsonExchangeContract.Name}'. A system with another shape needs its "
                    + "own adapter; until there is one, leave the option off and the missing runner is recorded as "
                    + "a harness failure rather than guessed at."
            ),
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
