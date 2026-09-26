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
/// <b>The verified replacement route is a separate command, and stays one.</b> Nothing a
/// <see cref="Run"/> invocation can be given makes it reach the code that checks a baseline's
/// suite, its errored runs, and its byte identity before replacing it. What <see cref="Run"/>
/// <i>can</i> do with <c>--overwrite</c> is replace an existing file at a destination it was
/// given; what it can never do is replace a file the same invocation reads.
/// </para>
/// </remarks>
internal enum CliOperation
{
    /// <summary>
    /// Evaluate a suite. Writes where <c>--out</c> and <c>--report-markdown</c> name destinations,
    /// and nowhere else.
    /// </summary>
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

    /// <summary>
    /// Gets the containment root as supplied, or null when <c>--root</c> was omitted.
    /// </summary>
    /// <remarks>
    /// <b>Null rather than a pre-filled working directory.</b> The option carries no default
    /// factory, so an absent <c>--root</c> stays absent all the way to
    /// <see cref="PathValue.RootFrom"/> — the one place that turns it into a path, and therefore
    /// the only place that can honestly mark that path as this process's rather than the
    /// caller's. A default materialised at binding reaches every later call site looking exactly
    /// like something a caller typed.
    /// </remarks>
    public required string? Root { get; init; }

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
    /// <remarks>
    /// Kept on the request, not carried into the plan: the only thing this value can produce is a
    /// refusal, so a validated plan that could report it would be reporting a state it cannot be
    /// in.
    /// </remarks>
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

        var guard = PathGuard.ForRoot(PathValue.RootFrom(request.Root), "--root");
        var suite = guard.ResolveExistingFile(request.Suite, "--suite");
        var updating = operation is CliOperation.BaselineUpdate;

        RefuseTheUnimplementedGate(request);

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

        RefuseWritingOverAnInput(
            guard.Root,
            Inputs(suite, updating ? null : baseline),
            Destinations(operation, baseline, artifact, markdown)
        );
        RefuseUnpairableBaselines(baseline, endpoint, baselineEndpoint, requiresEndpoint);
        RefuseUnreportableComparisons(guard.Root, markdown, baseline, baselineEndpoint, artifact);
        RefuseAnOptInThatCannotAct(request, artifact, markdown);

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
            Verbose = request.Verbose,
            Operation = operation,
            ApplyBaselineUpdate = updating && request.Apply,
        };
    }

    /// <summary>
    /// Re-establishes, at the moment of the write, that a destination is still not one of this
    /// invocation's own inputs.
    /// </summary>
    /// <param name="destination">The canonical destination about to be written.</param>
    /// <param name="optionName">The option that named it, for the refusal message.</param>
    /// <remarks>
    /// <para>
    /// <b>The argument-time answer has expired by the time it matters.</b> A run takes as long as
    /// the system under test does, and whether two paths are the same file is a property of the
    /// file system rather than of the arguments — a directory swapped for a link in between
    /// redirects a destination onto the suite this run was conducted from. No file mode defends
    /// against that: the mode governs the leaf while what moved was the path to it. Asking again
    /// narrows the window; what closes what is left of it is that
    /// <see cref="ArtifactWriter"/> never truncates.
    /// </para>
    /// <para>
    /// <b>On the plan rather than on a command, because two commands share it.</b> <c>run</c> and
    /// <c>baseline update</c> validate through this one type precisely so that "resolve the root,
    /// then contain every path against it" exists once; a re-check written twice would be the
    /// same pair of readings that eventually disagree, and the direction they would disagree in
    /// is writing over something.
    /// </para>
    /// <para>
    /// <b>A named step rather than four lines inline</b>, for the reason
    /// <c>TrendCommand.RecheckDestination</c> is one: both paths here were produced by this tool
    /// rather than typed by the caller, so a refusal out of them must not echo its subject, and
    /// "which <see cref="PathValue"/> factory did this call site use" is a question a test should
    /// be able to ask without the root having to vanish between conducting a suite and writing
    /// beside it, which neither command exposes a seam for.
    /// </para>
    /// </remarks>
    /// <exception cref="ArgumentNullException">Any argument is null.</exception>
    /// <exception cref="EvalCliException">
    /// The root, an input, or the destination stopped being what this plan recorded.
    /// </exception>
    internal void RecheckDestination(string destination, string optionName)
    {
        ArgumentNullException.ThrowIfNull(destination);
        ArgumentNullException.ThrowIfNull(optionName);

        var guard = PathGuard.ForRoot(PathValue.Derived(RootDirectory), "--root");

        // Under `baseline update` the baseline is the destination rather than an input, so it is
        // excluded here for the same reason Destinations excludes it from the other command: the
        // matrix is asymmetric and the asymmetry is stated, not inferred from which fields are set.
        var baseline = Operation is CliOperation.BaselineUpdate ? null : BaselinePath;

        RefuseWritingOverAnInput(
            guard.Root,
            Inputs(
                guard.ResolveExistingFile(SuitePath, "--suite"),
                baseline is null ? null : guard.ResolveExistingFile(baseline, "--baseline")
            ),
            [(optionName, guard.VerifyWritePath(destination, optionName))]
        );
    }

    /// <summary>Refuses an opt-in that has nothing it could act on.</summary>
    /// <remarks>
    /// <b><c>trend</c> already refuses exactly this, and <c>run</c> did not.</b> The flag names
    /// the only irreversible thing this command can do, so accepted with no destination to govern
    /// it reads as one that might act — the same shape as a gate flag that parses and never gates,
    /// at a smaller scale. Refused after the collision checks, so an invocation that is wrong in
    /// both ways is told about the destructive mistake first.
    /// </remarks>
    private static void RefuseAnOptInThatCannotAct(RunRequest request, string? artifact, string? markdown)
    {
        if (!request.Overwrite || artifact is not null || markdown is not null)
        {
            return;
        }

        throw new EvalCliException(
            ExitCode.UsageError,
            "--overwrite was given but neither --out nor --report-markdown was, so there is nothing it could "
                + "replace.",
            "Nothing was executed. The opt-in governs replacing an existing file at a destination you named; with "
                + "no destination it governs nothing, and a flag that is accepted and does nothing reads as one "
                + "that might act. Drop it, or name the destination you meant."
        );
    }

    /// <summary>Refuses the gate flag, because this build has no gate to put behind it.</summary>
    /// <remarks>
    /// <para>
    /// <b>Leaving the gate unimplemented is a decision and it stands (ADR 0004): gating before
    /// the reports are trusted teaches people to bypass the harness.</b> What does not stand is
    /// <i>accepting the flag</i>. Somebody wires <c>--fail-on-regression</c> into CI, watches the
    /// step go green, and concludes that a regression would have stopped them. A documented
    /// reservation never reaches that person — they read the flag name, not the README — so the
    /// only statement that does reach them is the invocation refusing to run.
    /// </para>
    /// <para>
    /// <b>The tool already knew this rule and applied it one command over.</b> <c>trend</c>
    /// declines <c>--verbose</c> on the grounds that "a flag that is accepted and does nothing is
    /// a smaller version of the same lie", and declines <c>--fail-on-regression</c> outright. The
    /// command that most needed the rule was the one that did not get it.
    /// </para>
    /// <para>
    /// <b><see cref="ExitCode.NotImplemented"/> rather than <see cref="ExitCode.UsageError"/>.</b>
    /// Nothing typed here is malformed — the invocation is well formed and asks for an operation
    /// this build does not have, which is that code's documented meaning and, until now, nothing
    /// produced it. It also stays distinguishable from a typo, which matters most to exactly the
    /// caller this refusal is for: a CI author reading an exit code, who needs "this gate does not
    /// exist yet" to look different from "you misspelled an argument".
    /// </para>
    /// <para>
    /// <b>The reserved block is not released.</b> 10-19 still belongs to the gate, and the remedy
    /// says so, because the next person to reach for it needs to know the range is spoken for
    /// rather than free.
    /// </para>
    /// </remarks>
    private static void RefuseTheUnimplementedGate(RunRequest request)
    {
        if (!request.FailOnRegression)
        {
            return;
        }

        throw new EvalCliException(
            ExitCode.NotImplemented,
            "--fail-on-regression is not available in this build, so it is refused rather than accepted and "
                + "ignored.",
            "Nothing was executed. Implemented, it will exit in the reserved "
                + $"{ExitCodes.GateRangeStart}-{ExitCodes.GateRangeEnd} range when the comparison finds a "
                + "regression; that range stays held for it. Until then this build is report-only: drop the flag "
                + "and read the comparison on stdout, in the artifact at --out, or in the report at "
                + "--report-markdown. A gate that was accepted and did nothing would have told a CI step it was "
                + "guarded when nothing was guarding it."
        );
    }

    /// <summary>
    /// Refuses any destination this invocation would write that is also a file it reads.
    /// </summary>
    /// <param name="root">The canonical root, so a refusal can state a path the way it may be carried.</param>
    /// <param name="inputs">Every file this invocation reads, with the option that named it.</param>
    /// <param name="destinations">Every file it would write, with the option that named it.</param>
    /// <remarks>
    /// <para>
    /// <b>One rule over the whole matrix, because the per-pair form grew a hole every time a path
    /// was added.</b> <c>--out</c> was held against <c>--baseline</c> and <c>--report-markdown</c>
    /// was held against <c>--baseline</c>; neither was ever held against <c>--suite</c>. So
    /// <c>run --out &lt;suite&gt; --overwrite</c> replaced the suite with an artifact and reported
    /// success, and the suite it was conducted from could not be re-read to find out what it had
    /// said. Enumerating inputs against destinations has no cell to forget.
    /// </para>
    /// <para>
    /// <b>Refused regardless of <c>--overwrite</c>.</b> That opt-in says "replace the file I
    /// named"; every cell here is a file the same invocation <i>also</i> named as something to
    /// read, which is the one thing the caller cannot have meant. It is the rule
    /// <see cref="TrendPlan.RequireDestinationOutsideInput"/> applies to a directory input,
    /// applied to the command people invoke constantly.
    /// </para>
    /// <para>
    /// <b>Which option is an input is a property of the command, not of the path.</b> Under
    /// <c>run</c> the baseline is read and <c>--out</c> is written; under <c>baseline update</c>
    /// the baseline is the destination and the suite is the only input. Both are passed in rather
    /// than inferred here, so the asymmetry is visible at the call site.
    /// </para>
    /// <para>
    /// <b>No sentence here claims anything about process state.</b> These refusals are raised
    /// while the arguments are validated <i>and</i> again at the moment of the write, where
    /// "nothing was executed" would be false — and a remedy that is wrong about what already
    /// happened is this whole finding in miniature.
    /// </para>
    /// </remarks>
    /// <exception cref="EvalCliException">A destination names one of the inputs.</exception>
    internal static void RefuseWritingOverAnInput(
        string root,
        IReadOnlyList<(string Option, string Path)> inputs,
        IReadOnlyList<(string Option, string? Path)> destinations
    )
    {
        ArgumentNullException.ThrowIfNull(inputs);
        ArgumentNullException.ThrowIfNull(destinations);

        // A guard whose strictness is a parameter the caller supplies is only as strong as the
        // weakest call site, and an empty input set disables the whole matrix silently. No
        // invocation of this tool reads nothing — there is always a suite — so an empty set is a
        // caller defect rather than a legitimate "check nothing".
        if (inputs.Count == 0)
        {
            throw new ArgumentException(
                "No inputs were supplied, so this would check every destination against nothing and refuse none of "
                    + "them. Every invocation reads at least a suite.",
                nameof(inputs)
            );
        }

        foreach (var destination in destinations)
        {
            if (destination.Path is not { } written)
            {
                continue;
            }

            foreach (var input in inputs)
            {
                if (string.Equals(written, input.Path, PathComparison))
                {
                    throw Collision(root, destination.Option, written, input.Option);
                }
            }
        }
    }

    /// <summary>The files a validated invocation reads, in the order a refusal should mention them.</summary>
    private static IReadOnlyList<(string Option, string Path)> Inputs(string suite, string? baseline) =>
        baseline is null ? [("--suite", suite)] : [("--suite", suite), ("--baseline", baseline)];

    /// <summary>
    /// The files a validated invocation would write.
    /// </summary>
    /// <remarks>
    /// <c>baseline update</c> writes exactly one file and it is <c>--baseline</c>;
    /// <see cref="RefuseRunOnlyOptions"/> has already refused the other two by the time this is
    /// asked, so they are stated as absent rather than filtered.
    /// </remarks>
    private static IReadOnlyList<(string Option, string? Path)> Destinations(
        CliOperation operation,
        string? baseline,
        string? artifact,
        string? markdown
    ) =>
        operation is CliOperation.BaselineUpdate
            ? [("--baseline", baseline)]
            : [("--out", artifact), ("--report-markdown", markdown)];

    /// <summary>Composes the refusal for one collision, in the vocabulary of the input that was hit.</summary>
    /// <remarks>
    /// The opt-in named is the one the <i>destination</i> has, not a fixed string: under
    /// <c>baseline update</c> the destination is <c>--baseline</c> and its opt-in is
    /// <c>--apply</c>. Naming <c>--overwrite</c> there would send a reader looking for a flag that
    /// command does not have, which is its own smaller version of a message that is not true.
    /// </remarks>
    private static EvalCliException Collision(
        string root,
        string destinationOption,
        string destination,
        string inputOption
    ) =>
        new(
            ExitCode.UsageError,
            $"{destinationOption} and {inputOption} name the same file: {MarkdownReport.Display(root, destination)}",
            $"{WhyItIsRefused(destinationOption, inputOption)} {OptInFor(destinationOption)} does not lift this: "
                + "that opt-in is about replacing a file you chose, not about destroying one this invocation "
                + $"reads. Give {destinationOption} a different destination."
        );

    /// <summary>The opt-in that governs replacing a file at each destination.</summary>
    private static string OptInFor(string destinationOption) =>
        destinationOption == "--baseline" ? "--apply" : "--overwrite";

    /// <summary>What is actually lost in each cell of the matrix.</summary>
    /// <remarks>
    /// Stated per cell rather than generically, because the remedy differs: a suite collision is a
    /// mistyped path, while a baseline collision under <c>--out</c> is somebody reaching for the
    /// destructive command without knowing it exists.
    /// </remarks>
    private static string WhyItIsRefused(string destinationOption, string inputOption) =>
        (destinationOption, inputOption) switch
        {
            (_, "--suite") =>
                "The suite is what this invocation is conducted from, and one destroyed by its own run cannot be "
                    + "re-read to find out what it asked.",
            ("--out", _) =>
                "Writing this run over the baseline it was compared against is a baseline update, and that has its "
                    + "own command and its own opt-in: `eval-cli baseline update --apply`.",
            _ => "Writing the report over the baseline would destroy the artifact this run was compared against, and "
                + "the next run would have nothing to compare to.",
        };

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
    /// <b>The report may never be the artifact.</b> The JSON is the durable evidence and the only
    /// thing a later comparison is made against; the Markdown is a rendering of it that nothing
    /// reads back. Writing one over the other would replace evidence with a view of it. Refused
    /// even under <c>--overwrite</c>, because that opt-in is about replacing a stale report, not
    /// about destroying the record. The report landing on an <i>input</i> — the suite or the
    /// baseline — is the same property one level up, and belongs to
    /// <see cref="RefuseWritingOverAnInput"/>.
    /// </para>
    /// </remarks>
    private static void RefuseUnreportableComparisons(
        string root,
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
                $"--report-markdown and --out name the same file: {MarkdownReport.Display(root, artifact)}",
                "Nothing was executed. The JSON artifact is the durable evidence a later comparison is made "
                    + "against; the Markdown is a rendering of it that nothing reads back. Give --report-markdown a "
                    + "different destination."
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
                $"--baseline names a directory, not a file: {MarkdownReport.Display(guard.Root, resolved)}",
                "Point --baseline at the baseline artifact itself."
            );
        }

        if (!File.Exists(resolved))
        {
            throw new EvalCliException(
                ExitCode.BaselineMissing,
                $"--baseline names an artifact that is not there: {MarkdownReport.Display(guard.Root, resolved)}",
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
    /// <para>
    /// Validated here rather than by an option validator, so that the rules a test pins are the
    /// same rules the tool applies — the same reason every other value is checked in this method.
    /// </para>
    /// <para>
    /// <b>The rejected value is omitted rather than netted.</b> It is caller text, not authored
    /// text, and the two need different treatment: the report's net catches machine paths, and a
    /// credential is not path-shaped — <c>ghp_…</c> passes through it untouched. Judging whether
    /// <i>this particular</i> value looks dangerous is the reasoning ADR 0005 records five failed
    /// rounds of, so it is not attempted. The option name and the closed set of valid values are
    /// what a caller acts on, and the caller already has what they typed.
    /// </para>
    /// <para>
    /// The same choice <see cref="PathGuard"/> makes for a value that will not parse as a path at
    /// all. <see cref="ArgumentRedactor"/> covers the parser's own diagnostics, which are produced
    /// before this runs and therefore cannot reach it.
    /// </para>
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
                $"{optionName} does not name an adapter this build has. The value is not repeated here, because "
                    + "this message is written to the build log.",
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
