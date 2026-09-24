using System.CommandLine;
using System.CommandLine.IO;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Forge.EvalCli.Composition;
using Forge.EvalEngine.Baselines;
using Forge.EvalEngine.Comparison;
using Forge.EvalEngine.Coordination;
using Forge.EvalEngine.Loading;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Serialization;
using Microsoft.Extensions.DependencyInjection;

namespace Forge.EvalCli.Cli;

/// <summary>The machine-readable form of a baseline update, applied or previewed.</summary>
internal sealed record BaselineUpdateDocument
{
    /// <summary>Gets the schema identifier, so a consumer can tell versions apart.</summary>
    [JsonPropertyName("schema")]
    public string Schema { get; init; } = "eval-cli/baseline-update/1";

    /// <summary>Gets whether the baseline was actually replaced.</summary>
    /// <remarks>
    /// The first field a consumer should read. False means this was a preview and the committed
    /// baseline is byte-for-byte what it was.
    /// </remarks>
    [JsonPropertyName("applied")]
    public required bool Applied { get; init; }

    /// <summary>Gets whether a diff between the two artifacts could be computed at all.</summary>
    /// <remarks>
    /// <b>Read this before any count below it.</b> When it is false the committed baseline and
    /// the replacement were not conducted alike, nothing compared them, and every figure that
    /// would describe the difference is <see langword="null"/> rather than zero. Zero is a claim
    /// — "this replacement changes nothing" — and it is the claim a reader would act on when
    /// deciding whether replacing a committed file is safe.
    /// </remarks>
    [JsonPropertyName("diffAvailable")]
    public required bool DiffAvailable { get; init; }

    /// <summary>Gets the suite name both artifacts are labelled with.</summary>
    [JsonPropertyName("suite")]
    public required string Suite { get; init; }

    /// <summary>Gets the canonical containment root.</summary>
    [JsonPropertyName("root")]
    public required string Root { get; init; }

    /// <summary>Gets the baseline that would be, or was, replaced.</summary>
    [JsonPropertyName("baseline")]
    public required string Baseline { get; init; }

    /// <summary>Gets the redacted endpoint the candidate was conducted against, or null.</summary>
    [JsonPropertyName("endpoint")]
    public string? Endpoint { get; init; }

    /// <summary>Gets how many scenarios the committed baseline records.</summary>
    [JsonPropertyName("scenariosInBaseline")]
    public required int ScenariosInBaseline { get; init; }

    /// <summary>Gets how many scenarios the replacement would record.</summary>
    [JsonPropertyName("scenariosInCandidate")]
    public required int ScenariosInCandidate { get; init; }

    /// <summary>Gets how many scenarios would change classification, or null when nothing compared them.</summary>
    /// <remarks>
    /// The diff shape, which is the thing worth previewing. Replacing a committed baseline is
    /// consequential in proportion to how much of it changes, and "will overwrite" tells a reader
    /// nothing about that. <see langword="null"/> rather than zero when
    /// <see cref="DiffAvailable"/> is false: an unavailable count and a count of none are
    /// opposite answers, and only one of them says the replacement is safe.
    /// </remarks>
    [JsonPropertyName("scenariosChanged")]
    public int? ScenariosChanged { get; init; }

    /// <summary>Gets the count per classification, or null when nothing compared the two.</summary>
    [JsonPropertyName("classificationCounts")]
    public IReadOnlyDictionary<string, int>? ClassificationCounts { get; init; }

    /// <summary>Gets the scenarios the replacement records as covered that the baseline does not.</summary>
    [JsonPropertyName("newlyCovered")]
    public IReadOnlyList<string>? NewlyCovered { get; init; }

    /// <summary>Gets the scenarios the comparator withheld from that claim, or null when nothing compared them.</summary>
    /// <remarks>
    /// Null and empty are different answers here, as everywhere else in this document: null is
    /// "nothing compared the two", empty is "the comparison withheld nothing". A field that
    /// appeared only when something was withheld would make a refusal indistinguishable from a
    /// preview that never looked.
    /// </remarks>
    [JsonPropertyName("newlyCoveredWithheld")]
    public IReadOnlyList<string>? NewlyCoveredWithheld { get; init; }

    /// <summary>Gets why the comparator withheld them, or null when it withheld nothing.</summary>
    [JsonPropertyName("newlyCoveredWithheldReason")]
    public string? NewlyCoveredWithheldReason { get; init; }

    /// <summary>Gets the scenarios the replacement records as no longer passing.</summary>
    [JsonPropertyName("regressed")]
    public IReadOnlyList<string>? Regressed { get; init; }

    /// <summary>Gets why no diff could be shown, or null when one was.</summary>
    /// <remarks>
    /// Populated when the committed baseline was not conducted alike — a different root seed or
    /// different harness settings. That is a legitimate reason to re-baseline, so it does not
    /// stop the command; what it does stop is any claim about what would change.
    /// </remarks>
    [JsonPropertyName("noDiffReason")]
    public string? NoDiffReason { get; init; }
}

/// <summary>
/// Carries out <c>baseline update</c> — the one genuinely destructive thing this tool does.
/// </summary>
/// <remarks>
/// <para>
/// <b>The default invocation writes nothing.</b> Without <c>--apply</c> this conducts the suite,
/// compares the result against the committed baseline, prints how many scenarios would change
/// classification and which ones, and stops. The committed file is not opened for writing, not
/// staged over, and not touched.
/// </para>
/// <para>
/// <b>A committed baseline is a tracked source file, so the guards are stricter than
/// <c>--out</c>'s.</b> Four of them, and each closes a way this command could destroy something
/// the caller did not mean to replace:
/// </para>
/// <list type="number">
/// <item><description>
/// <b>It never creates.</b> The baseline must already exist, checked while the arguments are
/// validated, and a path that is not there earns <see cref="ExitCode.BaselineMissing"/>. A
/// mistyped path is otherwise indistinguishable from a first run, and would leave a plausible
/// file somewhere nobody reads while the real baseline stayed stale.
/// </description></item>
/// <item><description>
/// <b>It refuses a baseline belonging to another suite.</b> That is not a regression, it is the
/// wrong file — and replacing it destroys an unrelated suite's evidence.
/// </description></item>
/// <item><description>
/// <b>It refuses to commit a baseline with errored runs.</b> A run the harness could not conduct
/// produced no verdict, and a baseline carrying one poisons every future comparison of that
/// scenario: the comparator will correctly report that no repetition has a verdict on both sides,
/// forever, and the report will read as a scenario nobody can say anything about.
/// </description></item>
/// <item><description>
/// <b>It writes through the same path <c>--out</c> does</b> — see <see cref="ArtifactWriter"/> —
/// so containment, the link refusal, staging, re-verification, and the atomic rename are the
/// same code rather than a second, weaker copy.
/// </description></item>
/// </list>
/// <para>
/// <b>A scenario that cannot be compared is not fatal here, unlike in a run.</b> A baseline that
/// predates the current definition fingerprint compares as
/// <see cref="ScenarioClassification.NotComparable"/> — which is exactly the state regenerating
/// it resolves. Refusing would leave a user unable to fix the thing the refusal complained about.
/// </para>
/// </remarks>
internal static class BaselineCommand
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    /// <summary>Executes one <c>baseline update</c> invocation.</summary>
    /// <param name="plan">The validated plan.</param>
    /// <param name="console">Where results (stdout) and diagnostics (stderr) go.</param>
    /// <param name="cancellationToken">Cancels the invocation.</param>
    /// <returns>The exit code.</returns>
    /// <exception cref="ArgumentNullException">Any argument is null.</exception>
    /// <exception cref="EvalCliException">The invocation was refused at one of its stages.</exception>
    /// <exception cref="OperationCanceledException"><paramref name="cancellationToken"/> was cancelled.</exception>
    public static async Task<ExitCode> ExecuteAsync(RunPlan plan, IConsole console, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(console);

        cancellationToken.ThrowIfCancellationRequested();

        using var provider = EvalCliServices.Build(plan, console.Error.CreateTextWriter());

        var suite = await SuiteDiscovery
            .LoadSuiteAsync(provider.GetRequiredService<SuiteLoader>(), plan, console, cancellationToken)
            .ConfigureAwait(false);

        // Fingerprinted before it is read as an artifact, deliberately. Every refusal below is
        // made about the bytes the loader parses; pinning them first means a file exchanged
        // between the two reads refuses the replacement rather than qualifying for it.
        var target = await VouchForAsync(plan, cancellationToken).ConfigureAwait(false);

        // The plan already required this file to exist, so a null here is the race and earns the
        // same BaselineMissing code from the loader. Read before the run, because a baseline that
        // cannot be read is a reason to stop rather than to spend a run finding out.
        var committed =
            await SuiteDiscovery
                .LoadBaselineAsync(provider.GetRequiredService<ArtifactBaseline>(), plan, cancellationToken)
                .ConfigureAwait(false)
            ?? throw new EvalCliException(
                ExitCode.BaselineMissing,
                $"--baseline names an artifact that is not there: {plan.BaselinePath}",
                "Nothing was written. This command replaces a baseline and never creates one."
            );

        // The whole suite, always. RunPlan refuses --changed-since here: a baseline assembled
        // from a narrowed run records only the scenarios that ran, and every later comparison
        // would read the missing ones as removed. Pinned anyway, so the seed schedule is settled
        // in one place for both commands rather than defaulted in one of them.
        provider.GetRequiredService<SeedSchedule>().PinTo(suite, [.. suite.Scenarios.Select(s => s.Identity.Id)]);

        var candidate = await provider
            .GetRequiredService<RunCoordinator>()
            .RunAsync(suite, cancellationToken)
            .ConfigureAwait(false);

        RequireEveryRunWasConducted(candidate, plan);

        var (comparison, noDiffReason) = Diff(provider, plan, committed, candidate);

        var applied = plan.ApplyBaselineUpdate;
        var replaced = false;

        if (applied)
        {
            await ApplyAsync(plan, candidate, target, cancellationToken).ConfigureAwait(false);

            replaced = true;
        }

        var document = Document(plan, committed, candidate, comparison, noDiffReason, applied);

        try
        {
            await WriteAsync(
                    console,
                    plan.Json ? JsonSerializer.Serialize(document, JsonOptions) : RenderText(document, comparison),
                    cancellationToken
                )
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException cancelled) when (replaced)
        {
            // The report never made it out, but the committed baseline is not what it was. The
            // interruption is still an interruption — same exit code — and the one sentence a
            // caller reads about it must not be the blanket "nothing was written".
            throw new InterruptedAfterWritingException(
                $"the baseline at {plan.BaselinePath} was replaced with this run before the report could be "
                    + "written, so the committed file has already changed.",
                cancelled
            );
        }

        return ExitCode.Success;
    }

    /// <summary>
    /// Pins the committed baseline's bytes, so the file replaced at the end is the file checked at
    /// the start.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Every guard this command has is a statement about contents, and it is enforced against a
    /// path.</b> The foreign-suite refusal, the errored-run refusal, and the diff are all made
    /// from the artifact read before the suite was conducted; the replacement happens however
    /// long the system under test takes afterwards. Without an identity to hold the two ends
    /// together, the file destroyed at the end is not necessarily the one any of them examined —
    /// which means another suite's evidence can be overwritten by a command whose whole second
    /// guard exists to stop exactly that.
    /// </para>
    /// <para>
    /// Read from the path the plan already resolved and contained, and streamed rather than held:
    /// nothing here has established how large that file is, and reading it whole to compare it
    /// would let a mistyped path exhaust the host on the way to a refusal. A second containment
    /// check here would be a second reading of a rule <see cref="PathGuard"/> owns; what the
    /// writer does at publication time — re-assert containment, then match this fingerprint — is
    /// the check that has to be late, and it is made there.
    /// </para>
    /// </remarks>
    private static async Task<ArtifactTarget> VouchForAsync(RunPlan plan, CancellationToken cancellationToken)
    {
        try
        {
            return new ArtifactTarget
            {
                ContentHash = await ArtifactTarget
                    .FingerprintAsync(plan.BaselinePath!, cancellationToken)
                    .ConfigureAwait(false),
                Vouched = "the artifact this command read, checked for a foreign suite, and diffed against",
                AbsentExitCode = ExitCode.BaselineMissing,
            };
        }
        catch (Exception exception) when (exception is FileNotFoundException or DirectoryNotFoundException)
        {
            throw new EvalCliException(
                ExitCode.BaselineMissing,
                $"--baseline names an artifact that is not there: {plan.BaselinePath}",
                "Nothing was written. This command replaces a baseline and never creates one."
            );
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                $"--baseline could not be read, so nothing was conducted: {exception.Message}",
                "Nothing was written. The baseline is read and fingerprinted before the suite runs precisely so "
                    + "this costs nothing. Check the permissions on that path and re-run."
            );
        }
    }

    /// <summary>
    /// Refuses to commit a baseline whose runs the harness could not conduct.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The same rule the run's exit code already applies, moved to the point where it becomes
    /// permanent. An errored run is not a verdict about the system under test — it means nothing
    /// asked the question — and freezing one into a committed baseline makes every later
    /// comparison of that scenario unanswerable rather than merely unknown for one run.
    /// </para>
    /// <para>
    /// Checked before the write and before <c>--apply</c> is honoured, so a preview reports it
    /// too rather than letting a user discover it only when they commit.
    /// </para>
    /// </remarks>
    private static void RequireEveryRunWasConducted(SuiteResult candidate, RunPlan plan)
    {
        if (!RunReport.HarnessFailed(candidate))
        {
            return;
        }

        throw new EvalCliException(
            ExitCode.RunFailed,
            "At least one run was recorded as an error, so this result is not a baseline: the harness could not "
                + "ask the question for those scenarios.",
            $"Nothing was written and {plan.BaselinePath} is unchanged. A committed baseline carrying an errored "
                + "run makes every later comparison of that scenario report that neither side has a verdict, which "
                + "reads as a scenario nobody can say anything about. Fix the transport or the wiring — check "
                + "--rest-exchange, --llm-exchange, and --endpoint — and re-run."
        );
    }

    /// <summary>
    /// Diffs the committed baseline against the replacement, or says why it could not.
    /// </summary>
    /// <remarks>
    /// <b>A foreign-suite baseline is fatal; every other divergence is not.</b> A different suite
    /// name means the wrong artifact was named, and overwriting it destroys another suite's
    /// evidence — the one outcome this command must never produce. A different seed or different
    /// harness settings means the committed baseline is stale in exactly the way re-baselining
    /// fixes, so it proceeds and reports honestly that it has no diff to show.
    /// </remarks>
    private static (ComparisonOutcome? Comparison, string? NoDiffReason) Diff(
        IServiceProvider provider,
        RunPlan plan,
        SuiteResult committed,
        SuiteResult candidate
    )
    {
        try
        {
            return (
                new ComparisonOutcome
                {
                    Mechanism = BaselineMechanism.Artifact,
                    Reference = plan.BaselinePath!,
                    Result = provider.GetRequiredService<SuiteComparator>().Compare(committed, candidate),
                },
                null
            );
        }
        catch (ComparisonRefusedException refusal) when (refusal.Property is "suiteName")
        {
            throw new EvalCliException(
                ExitCode.ComparisonRefused,
                $"The baseline at {plan.BaselinePath} is a run of a different suite: {refusal.Message}",
                "Nothing was written. That is what naming the wrong baseline looks like, and replacing it would "
                    + "destroy the evidence for a suite this run never evaluated. Check the path."
            );
        }
        catch (Exception refusal) when (refusal is ComparisonRefusedException or ArgumentException)
        {
            // Not fatal: the committed baseline records the same suite but was not conducted
            // alike, which is precisely the staleness re-baselining exists to clear. What is
            // refused is any claim about what would change.
            return (
                null,
                $"The committed baseline was not conducted alike, so there is no diff to show: {refusal.Message}"
            );
        }
    }

    /// <summary>Replaces the committed baseline. Reached only with <c>--apply</c>.</summary>
    /// <remarks>
    /// <para>
    /// Through <see cref="ArtifactWriter"/>, which is the same path <c>run --out</c> uses. The
    /// publication is <see cref="ArtifactPublication.ReplaceVerified"/>: it never creates, and it
    /// replaces only a destination that is still the artifact this command read and made its
    /// refusals against. "Never reach an unintended destination" is what the containment, link,
    /// and re-verification checks in the writer do; "never replace an unintended <i>file</i>" is
    /// what <paramref name="target"/> does, and the two are not the same guarantee.
    /// </para>
    /// <para>
    /// The bytes go through <see cref="ArtifactRedaction"/> first. A committed baseline is a
    /// tracked source file, and an address recorded in one is in the repository's history from
    /// that commit onwards (§V).
    /// </para>
    /// </remarks>
    private static async Task ApplyAsync(
        RunPlan plan,
        SuiteResult candidate,
        ArtifactTarget target,
        CancellationToken cancellationToken
    ) =>
        await ArtifactWriter
            .WriteAsync(
                new ArtifactWrite
                {
                    Destination = plan.BaselinePath!,
                    RootDirectory = plan.RootDirectory,
                    OptionName = "--baseline",
                    ReplaceOptionName = "--apply",
                    Publication = ArtifactPublication.ReplaceVerified,
                    RequiredTarget = target,
                    Contents = CanonicalJson.Serialize(ArtifactRedaction.Redact(candidate)),
                    FailureContext = "The suite was conducted but the baseline could not be replaced",
                    LossNote = "The baseline was not updated",
                },
                cancellationToken
            )
            .ConfigureAwait(false);

    private static BaselineUpdateDocument Document(
        RunPlan plan,
        SuiteResult committed,
        SuiteResult candidate,
        ComparisonOutcome? comparison,
        string? noDiffReason,
        bool applied
    )
    {
        // Every figure below describes a difference. With no comparison there is no difference to
        // describe, so they are withheld rather than defaulted — a default here is a zero, and a
        // zero is the answer that says replacing the file changes nothing.
        if (comparison is not { Result: { } result })
        {
            return new BaselineUpdateDocument
            {
                Applied = applied,
                DiffAvailable = false,
                Suite = candidate.SuiteName,
                Root = plan.RootDirectory,
                Baseline = plan.BaselinePath!,
                Endpoint = plan.EndpointDisplay,
                ScenariosInBaseline = committed.ScenarioResults.Count,
                ScenariosInCandidate = candidate.ScenarioResults.Count,
                NoDiffReason = noDiffReason ?? UnexplainedNoDiff,
            };
        }

        var comparisons = result.ScenarioComparisons;

        return new BaselineUpdateDocument
        {
            Applied = applied,
            DiffAvailable = true,
            Suite = candidate.SuiteName,
            Root = plan.RootDirectory,
            Baseline = plan.BaselinePath!,
            Endpoint = plan.EndpointDisplay,
            ScenariosInBaseline = committed.ScenarioResults.Count,
            ScenariosInCandidate = candidate.ScenarioResults.Count,
            ScenariosChanged = comparisons.Count(scenario => Changed(scenario.Classification)),
            ClassificationCounts = ComparisonReport.Counts(comparisons),
            NewlyCovered = result.NewlyCovered,
            NewlyCoveredWithheld = result.NewlyCoveredWithheld,
            NewlyCoveredWithheldReason = result.NewlyCoveredWithheldReason,
            Regressed =
            [
                .. comparisons
                    .Where(scenario => scenario.Classification == ScenarioClassification.Regressed)
                    .Select(scenario => scenario.ScenarioId),
            ],
            NoDiffReason = noDiffReason,
        };
    }

    /// <summary>
    /// What to say when there is no comparison and no stated reason for there not being one.
    /// </summary>
    /// <remarks>
    /// Unreachable through <see cref="Diff"/>, which always pairs a null comparison with a
    /// reason. Stated anyway, because the alternative is a report that says a diff is unavailable
    /// and then says nothing at all about why — which reads as an omission rather than as a
    /// refusal, and is the shape this whole finding is about.
    /// </remarks>
    private const string UnexplainedNoDiff =
        "No comparison was made between the committed baseline and this run, and no reason was recorded. Nothing "
        + "here is a claim about what replacing the baseline would change.";

    /// <summary>Whether a classification means the baseline's record of that scenario changes.</summary>
    /// <remarks>
    /// <see cref="ScenarioClassification.NotComparable"/> counts as a change: the committed entry
    /// and the replacement could not be shown to describe the same scenario, which is the
    /// strongest form of "this entry is not what it was".
    /// </remarks>
    private static bool Changed(ScenarioClassification classification) =>
        classification is not ScenarioClassification.StablePass and not ScenarioClassification.StableFail;

    private static string RenderText(BaselineUpdateDocument document, ComparisonOutcome? comparison)
    {
        var text = new StringBuilder();

        text.AppendLine(Headline(document));

        text.AppendLine();
        Row(text, "suite", document.Suite);
        Row(text, "root", document.Root);
        Row(text, "baseline", document.Baseline);
        Row(text, "endpoint", document.Endpoint ?? "(none)");
        Row(
            text,
            "opt-in",
            document.Applied
                ? "--apply was given - the baseline above was replaced"
                : "absent - nothing was written; pass --apply to replace the baseline"
        );
        Row(
            text,
            "scenarios",
            string.Create(
                CultureInfo.InvariantCulture,
                $"{document.ScenariosInBaseline} recorded -> {document.ScenariosInCandidate} recorded"
            )
        );

        if (!document.DiffAvailable)
        {
            text.AppendLine();
            text.AppendLine("  no diff to show");
            Row(text, "why", document.NoDiffReason ?? UnexplainedNoDiff, indent: 4);
            text.AppendLine();
            text.AppendLine("  The replacement would be written whole. Nothing above is a claim about what changes.");
        }
        else if (comparison is not null)
        {
            ComparisonReport.AppendTo(text, comparison, verbose: false);
        }

        text.AppendLine();
        text.AppendLine(
            document.Applied
                ? $"The baseline at {document.Baseline} now records this run."
                : $"Nothing was written. The baseline at {document.Baseline} is unchanged."
        );

        return text.ToString();
    }

    /// <summary>The first line, which is the one a reader acts on.</summary>
    /// <remarks>
    /// <b>The unknown leads, rather than appearing further down as a reason.</b> A headline of
    /// "0 of 2 scenarios would change classification" over a comparison that never happened is
    /// the whole of this command's risk in one sentence: it is the line that tells somebody
    /// replacing a committed file that doing so is free.
    /// </remarks>
    private static string Headline(BaselineUpdateDocument document) =>
        (document.DiffAvailable, document.ScenariosChanged) switch
        {
            (true, { } changed) when document.Applied => string.Create(
                CultureInfo.InvariantCulture,
                $"Baseline replaced - {changed} of {document.ScenariosInCandidate} scenarios changed classification."
            ),
            (true, { } changed) => string.Create(
                CultureInfo.InvariantCulture,
                $"Baseline update preview - {changed} of {document.ScenariosInCandidate} scenarios would change classification."
            ),
            _ when document.Applied =>
                "Baseline replaced - how many of its scenarios changed classification is unknown: nothing could "
                    + "compare the two.",
            _ => "Baseline update preview - how many scenarios would change classification is unknown: nothing "
                + "could compare the two.",
        };

    private static async Task WriteAsync(IConsole console, string rendered, CancellationToken cancellationToken)
    {
        var output = console.Out.CreateTextWriter();

        await output.WriteLineAsync(rendered.AsMemory(), cancellationToken).ConfigureAwait(false);
        await output.FlushAsync(cancellationToken).ConfigureAwait(false);
    }

    private static void Row(StringBuilder text, string label, string value, int indent = 2, int width = 18) =>
        text.AppendLine(
            string.Create(CultureInfo.InvariantCulture, $"{new string(' ', indent)}{label.PadRight(width)}{value}")
        );
}
