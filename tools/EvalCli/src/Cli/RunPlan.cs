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
/// Which command this plan was built for.
/// </summary>
/// <remarks>
/// <para>
/// One validated plan serves both commands because they validate almost everything identically,
/// and two copies of "resolve the root, then contain every path against it" is the shape that
/// eventually disagrees with itself. What differs is carried here explicitly rather than inferred
/// from which fields happen to be set.
/// </para>
/// <para>
/// <b>The destructive command is a separate command, and stays one.</b> Nothing a
/// <see cref="Run"/> invocation can be given makes it replace a committed baseline, so no
/// invocation that is safe today becomes destructive by a later option being added here.
/// </para>
/// </remarks>
internal enum CliOperation
{
    /// <summary>Evaluate a suite. Writes only where <c>--out</c> names a destination.</summary>
    Run,

    /// <summary>Replace a committed baseline. Previews by default; writes only with <c>--apply</c>.</summary>
    BaselineUpdate,
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

    /// <summary>Gets the Markdown comparison report destination as supplied, or <see langword="null"/>.</summary>
    public string? ReportMarkdown { get; init; }

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

    /// <summary>Gets the baseline address as supplied, or <see langword="null"/>.</summary>
    public string? BaselineEndpoint { get; init; }

    /// <summary>Gets whether replacing the committed baseline was opted into.</summary>
    public bool Apply { get; init; }

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

    /// <summary>
    /// Gets the canonical path the Markdown comparison report would be written to, or
    /// <see langword="null"/> when none was asked for.
    /// </summary>
    /// <remarks>
    /// Never set without a baseline. A comparison report with nothing to compare against would
    /// print a heading and a count of zero beside it, and a reader takes a zero under
    /// "Regressions" for a finding rather than for an absence of evidence — so the invocation is
    /// refused at argument time instead.
    /// </remarks>
    public string? MarkdownReportPath { get; init; }

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
    /// Gets the validated address a baseline run would be conducted against, or
    /// <see langword="null"/>.
    /// </summary>
    /// <remarks>
    /// <b>Never print this.</b> <see cref="BaselineEndpointDisplay"/> is the printable form. This
    /// one is handed to the engine's live provider, which verifies the artifact it gets back
    /// against exactly this address — a redacted label handed over instead would defeat the check
    /// that catches a baseline run against the wrong system.
    /// </remarks>
    public Uri? BaselineEndpoint { get; init; }

    /// <summary>Gets the redacted baseline address, or <see langword="null"/>. The only printable form.</summary>
    public string? BaselineEndpointDisplay { get; init; }

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

    /// <summary>Gets which command this plan was built for.</summary>
    public CliOperation Operation { get; init; }

    /// <summary>
    /// Gets whether replacing the committed baseline was opted into.
    /// </summary>
    /// <remarks>
    /// <b>False is the safe default and it is the whole guard.</b> Without it,
    /// <c>baseline update</c> conducts the run, compares, prints what would change, and writes
    /// nothing at all.
    /// </remarks>
    public bool ApplyBaselineUpdate { get; init; }

    /// <summary>Gets a value indicating whether this invocation would compare against a baseline.</summary>
    public bool Compares => BaselinePath is not null || BaselineEndpoint is not null;

    /// <summary>Gets the gate mode in force. Always report-only in this build.</summary>
    /// <remarks>
    /// Get-only rather than settable: report-only is not a configuration choice in this build, and
    /// a plan must not be able to claim a gate that nothing enforces.
    /// </remarks>
    public string GateMode { get; } = ReportOnlyGate;

    /// <summary>Validates and resolves a parsed request into a plan for the <c>run</c> command.</summary>
    /// <param name="request">The raw option values.</param>
    /// <returns>The validated plan.</returns>
    /// <remarks>
    /// The root is resolved first, because every other path is checked against it. Validation is
    /// ordered so that the first thing a user is told about is the thing that invalidates the most
    /// of what follows.
    /// </remarks>
    /// <exception cref="ArgumentNullException"><paramref name="request"/> is null.</exception>
    /// <exception cref="EvalCliException">Any value is missing, malformed, or out of range.</exception>
    public static RunPlan Create(RunRequest request) => Create(request, CliOperation.Run);

    /// <summary>
    /// Validates and resolves a parsed request into a plan for the <c>baseline update</c> command.
    /// </summary>
    /// <param name="request">The raw option values.</param>
    /// <returns>The validated plan.</returns>
    /// <remarks>
    /// <para>
    /// Three rules apply here and nowhere else, and all three exist because the destination is a
    /// <i>tracked source file</i> rather than a fresh artifact:
    /// </para>
    /// <list type="bullet">
    /// <item><description>
    /// <b>The baseline must already exist.</b> This command replaces a baseline; it never creates
    /// one. A mistyped path would otherwise write a plausible-looking baseline somewhere nobody
    /// reads while the real one stayed stale forever, and the next comparison would be made
    /// against the stale file with nothing to indicate it. Creating the first baseline is what
    /// <c>run --out</c> is for.
    /// </description></item>
    /// <item><description>
    /// <b>The destination is put through the write discipline now</b>, before the suite is
    /// conducted — containment against the root and the refusal of any link below it — so an
    /// invocation that could never have been allowed to write does not first spend a run
    /// discovering that.
    /// </description></item>
    /// <item><description>
    /// <b>Selection is refused.</b> A baseline built from a narrowed run records only the
    /// scenarios that ran, and every later comparison would read the missing ones as removed.
    /// A baseline is a statement about a whole suite.
    /// </description></item>
    /// </list>
    /// </remarks>
    /// <exception cref="ArgumentNullException"><paramref name="request"/> is null.</exception>
    /// <exception cref="EvalCliException">Any value is missing, malformed, or out of range.</exception>
    public static RunPlan CreateForBaselineUpdate(RunRequest request) => Create(request, CliOperation.BaselineUpdate);

    private static RunPlan Create(RunRequest request, CliOperation operation)
    {
        ArgumentNullException.ThrowIfNull(request);

        var guard = PathGuard.ForRoot(request.Root, "--root");
        var suite = guard.ResolveExistingFile(request.Suite, "--suite");
        var updating = operation is CliOperation.BaselineUpdate;

        var baseline =
            request.Baseline is null ? RequireBaselineFor(operation)
            : updating ? ResolveBaselineDestination(guard, request.Baseline)
            : guard.ResolveExistingFile(request.Baseline, "--baseline");

        var artifact = request.Out is null
            ? null
            : guard.ResolveOutputFile(request.Out, request.Overwrite, "--out", "--overwrite");

        var markdown = request.ReportMarkdown is null
            ? null
            : guard.ResolveOutputFile(request.ReportMarkdown, request.Overwrite, "--report-markdown", "--overwrite");

        if (updating)
        {
            RefuseRunOnlyOptions(request);
        }

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

        Uri? baselineEndpoint = null;
        string? baselineEndpointDisplay = null;

        if (request.BaselineEndpoint is not null)
        {
            (baselineEndpoint, baselineEndpointDisplay) = EndpointGuard.ValidateBaselineReference(
                request.BaselineEndpoint,
                "--baseline-endpoint"
            );
        }

        var changedSince = ValidateRevision(request.ChangedSince);
        var restExchange = ParseExchange(request.RestExchange, "--rest-exchange");
        var llmExchange = ParseExchange(request.LlmExchange, "--llm-exchange");
        var requiresEndpoint = restExchange is not ExchangeAdapter.None || llmExchange is not ExchangeAdapter.None;

        if (requiresEndpoint && endpoint is null)
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                "An exchange was selected but --endpoint was not given, so there is nowhere to send a stimulus.",
                "Pass --endpoint <url> as well, or drop the exchange and let the run record the missing runner as "
                    + "a harness failure rather than dialling somewhere nobody named."
            );
        }

        RefuseUnpairableBaselines(baseline, artifact, endpoint, baselineEndpoint, requiresEndpoint);
        RefuseUnreportableComparisons(markdown, baseline, baselineEndpoint, artifact);

        return new RunPlan
        {
            SuitePath = suite,
            RootDirectory = guard.Root,
            BaselinePath = baseline,
            ArtifactPath = artifact,
            MarkdownReportPath = markdown,
            OverwriteArtifact = request.Overwrite,
            RootSeed = request.Seed,
            MaxConcurrency = request.MaxConcurrency,
            MaxTotalRuns = request.MaxTotalRuns,
            Endpoint = endpoint,
            EndpointDisplay = endpointDisplay,
            BaselineEndpoint = baselineEndpoint,
            BaselineEndpointDisplay = baselineEndpointDisplay,
            ChangedSince = changedSince,
            RestExchange = restExchange,
            LlmExchange = llmExchange,
            DryRun = request.DryRun,
            Json = request.Json,
            FailOnRegression = request.FailOnRegression,
            Verbose = request.Verbose,
            Operation = operation,
            ApplyBaselineUpdate = updating && request.Apply,
        };
    }

    /// <summary>
    /// Refuses two references that would not be a baseline and a candidate.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>The defect these guard against is a comparison that reports "nothing changed" because
    /// it never compared two different things.</b> The engine refuses a mismatched fingerprint, a
    /// different suite, a different seed, and different harness settings — every one of which is
    /// useless if the two references named the same artifact or the same deployment, because then
    /// nothing it checks disagrees.
    /// </para>
    /// <para>
    /// The address rule compares everything that identifies a system and survives redaction:
    /// scheme, host, port, and path. Two addresses differing only in a query string are
    /// <i>not</i> treated as distinct, for the reason a baseline may not carry one at all — the
    /// harness cannot verify which deployment a query selected, so it must not be the only thing
    /// telling a baseline from a candidate.
    /// </para>
    /// </remarks>
    private static void RefuseUnpairableBaselines(
        string? baseline,
        string? artifact,
        Uri? endpoint,
        Uri? baselineEndpoint,
        bool requiresEndpoint
    )
    {
        if (baseline is not null && baselineEndpoint is not null)
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                "--baseline and --baseline-endpoint were both given, so there are two baselines and no way to "
                    + "choose between them.",
                "Pass one. --baseline compares against a committed artifact; --baseline-endpoint conducts the "
                    + "suite against a running system and compares against that."
            );
        }

        if (baseline is not null && artifact is not null && string.Equals(baseline, artifact, PathComparison))
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                $"--baseline and --out name the same file: {artifact}",
                "Nothing was executed. Writing this run over the baseline it was compared against is a baseline "
                    + "update, and that has its own command and its own opt-in: `eval-cli baseline update "
                    + "--apply`. Give --out a different destination."
            );
        }

        if (baselineEndpoint is null)
        {
            return;
        }

        if (!requiresEndpoint)
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                "--baseline-endpoint was given but no exchange was selected, so nothing would conduct the baseline "
                    + "run.",
                "Pass --rest-exchange json or --llm-exchange json as well. Without one, every scenario on both "
                    + "sides would be recorded as a harness failure and the comparison would have no evidence to "
                    + "work from."
            );
        }

        if (
            endpoint is not null
            && string.Equals(
                endpoint.GetLeftPart(UriPartial.Path),
                baselineEndpoint.GetLeftPart(UriPartial.Path),
                StringComparison.Ordinal
            )
        )
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                "--endpoint and --baseline-endpoint name the same address, so the suite would be compared against "
                    + "itself.",
                "Nothing was executed. A comparison against the same deployment reports that nothing changed "
                    + "whatever the change did, which is a green check over an unexamined change. "
                    + EndpointGuard.DeploymentSelectorRemedy
            );
        }
    }

    /// <summary>
    /// Refuses a comparison report that would have nothing to report, or somewhere unsafe to go.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>A report with no baseline is refused rather than written empty.</b> The document is a
    /// comparison: its headings are "Regressions", "Newly covered", "Not comparable". Rendered
    /// with nothing to compare against, every one of them carries a zero — and a reader who sees
    /// zero under "Regressions" reads it as a finding, not as the absence of an examination.
    /// That is a green check over an unexamined change, posted where the most people will see it,
    /// so the invocation stops here instead.
    /// </para>
    /// <para>
    /// <b>The report may never be the artifact, and may never be the baseline.</b> The JSON is the
    /// durable evidence and the only thing a later comparison is made against; the Markdown is a
    /// rendering of it that nothing reads back. Writing one over the other would replace evidence
    /// with a view of it, and in the baseline's case the next run would refuse to compare at all
    /// — with the original gone. Refused even under <c>--overwrite</c>, because that opt-in is
    /// about replacing a stale report, not about destroying the record.
    /// </para>
    /// </remarks>
    private static void RefuseUnreportableComparisons(
        string? markdown,
        string? baseline,
        Uri? baselineEndpoint,
        string? artifact
    )
    {
        if (markdown is null)
        {
            return;
        }

        if (baseline is null && baselineEndpoint is null)
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                "--report-markdown was given but no baseline was, so there would be nothing to compare and nothing "
                    + "to report.",
                "Nothing was executed. The report is a comparison: written with no baseline it would print a zero "
                    + "under every heading, and a zero under \"Regressions\" reads as a finding rather than as an "
                    + "unexamined change. Pass --baseline <path> or --baseline-endpoint <url> as well."
            );
        }

        if (artifact is not null && string.Equals(markdown, artifact, PathComparison))
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                $"--report-markdown and --out name the same file: {artifact}",
                "Nothing was executed. The JSON artifact is the durable evidence a later comparison is made "
                    + "against; the Markdown is a rendering of it that nothing reads back. Give --report-markdown a "
                    + "different destination."
            );
        }

        if (baseline is not null && string.Equals(markdown, baseline, PathComparison))
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                $"--report-markdown and --baseline name the same file: {baseline}",
                "Nothing was executed. Writing the report over the baseline would destroy the artifact this run was "
                    + "compared against, and the next run would have nothing to compare to. Give --report-markdown "
                    + "a different destination."
            );
        }
    }

    /// <summary>Refuses the options that belong to <c>run</c> and must not reach a baseline update.</summary>
    private static void RefuseRunOnlyOptions(RunRequest request)
    {
        if (request.ReportMarkdown is not null)
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                "--report-markdown is not an option of `baseline update`: that command replaces a baseline rather "
                    + "than reporting a change for review.",
                "The report describes what a change did to a suite against the baseline it is being judged "
                    + "against. A baseline update has no such reading — its comparison exists to preview what the "
                    + "replacement would move. Use `eval-cli run --baseline ... --report-markdown` instead."
            );
        }

        if (request.Out is not null)
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                "--out is not an option of `baseline update`: the destination is --baseline.",
                "This command writes exactly one file, the baseline it was pointed at, and only with --apply. "
                    + "Use `eval-cli run --out` to write a run artifact somewhere else."
            );
        }

        if (request.ChangedSince is not null)
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                "--changed-since is not an option of `baseline update`: a baseline is always a run of the whole "
                    + "suite.",
                "A baseline built from a narrowed run records only the scenarios that ran, and every later "
                    + "comparison would read the rest as removed. Drop --changed-since; it belongs on `run`, where "
                    + "narrowing costs only time."
            );
        }

        if (request.BaselineEndpoint is not null)
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                "--baseline-endpoint is not an option of `baseline update`: the baseline being replaced is the "
                    + "committed artifact at --baseline.",
                "A live system is not something this command can write over. Use `eval-cli run "
                    + "--baseline-endpoint` to compare against one."
            );
        }
    }

    /// <summary>Refuses a baseline update with no baseline named.</summary>
    private static string? RequireBaselineFor(CliOperation operation) =>
        operation is CliOperation.BaselineUpdate
            ? throw new EvalCliException(
                ExitCode.UsageError,
                "--baseline was not given, so there is no baseline to update.",
                "Point --baseline at the committed artifact you want replaced. This command never creates one: "
                    + "write the first baseline with `eval-cli run --out`."
            )
            : null;

    /// <summary>
    /// Resolves the baseline this command would replace, refusing one that is not there.
    /// </summary>
    /// <remarks>
    /// <see cref="PathGuard.VerifyWritePath"/> rather than
    /// <see cref="PathGuard.ResolveExistingFile"/>: the destination is about to be written, so it
    /// is held to the write rule — contained against the root, and reached through no link below
    /// it — at argument time, which is the same check the writer makes again at the moment of the
    /// write. Existence is then required separately so it earns
    /// <see cref="ExitCode.BaselineMissing"/> rather than a generic usage error: a baseline that
    /// was asked for and is not there is exactly what that code means.
    /// </remarks>
    private static string ResolveBaselineDestination(PathGuard guard, string value)
    {
        var resolved = guard.VerifyWritePath(value, "--baseline");

        if (Directory.Exists(resolved))
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                $"--baseline names a directory, not a file: {resolved}",
                "Point --baseline at the baseline artifact itself."
            );
        }

        if (!File.Exists(resolved))
        {
            throw new EvalCliException(
                ExitCode.BaselineMissing,
                $"--baseline names an artifact that is not there: {resolved}",
                "Nothing was written. This command replaces a baseline and never creates one, so a path that is "
                    + "not there is a mistyped path rather than a first run — writing one anyway would leave the "
                    + "real baseline stale with nothing to show for it. Create the first baseline with `eval-cli "
                    + "run --out`."
            );
        }

        return resolved;
    }

    /// <summary>How two resolved paths are compared for being the same file.</summary>
    /// <remarks>
    /// Both sides have been through the same boundary and are canonical, so this is a comparison
    /// of two canonical forms rather than an attempt to decide path equality in general — which
    /// is the engine's <c>PathBoundary</c>'s business and is not restated here. Case-insensitive
    /// on Windows and macOS, where the file system is.
    /// </remarks>
    private static StringComparison PathComparison =>
        OperatingSystem.IsLinux() ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase;

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
