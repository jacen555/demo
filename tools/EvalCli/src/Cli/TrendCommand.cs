using System.CommandLine;
using System.CommandLine.IO;
using System.Text.Json;
using Forge.EvalEngine.Baselines;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Serialization;

namespace Forge.EvalCli.Cli;

/// <summary>The raw option values of one <c>trend</c> invocation, before validation.</summary>
internal sealed record TrendRequest
{
    /// <summary>Gets the directory of artifacts to trend, relative to <see cref="Root"/>.</summary>
    public required string Artifacts { get; init; }

    /// <summary>
    /// Gets the directory every path must resolve inside, or null when <c>--root</c> was omitted.
    /// </summary>
    /// <remarks>
    /// Null rather than a pre-filled working directory — see <see cref="PathValue.RootFrom"/>.
    /// </remarks>
    public required string? Root { get; init; }

    /// <summary>Gets where to write the Markdown report, or null to print it and write nothing.</summary>
    public string? ReportMarkdown { get; init; }

    /// <summary>Gets whether an existing report file may be replaced.</summary>
    public bool Overwrite { get; init; }
}

/// <summary>
/// A validated <c>trend</c> invocation.
/// </summary>
/// <remarks>
/// <b>This command reads and, at most, writes one file it was explicitly pointed at.</b> Nothing
/// it can be given deletes, replaces or mutates an artifact: <c>--artifacts</c> is only ever
/// enumerated and read, and the one write is <c>--report-markdown</c>, which refuses an existing
/// file unless <c>--overwrite</c> is passed as well. The safe default — print, write nothing — is
/// what happens when the option is omitted, so forgetting a flag can only make this command do
/// less.
/// </remarks>
internal sealed record TrendPlan
{
    /// <summary>Gets the canonical directory the artifacts are read from.</summary>
    public required string ArtifactsDirectory { get; init; }

    /// <summary>Gets the canonical containment root.</summary>
    public required string RootDirectory { get; init; }

    /// <summary>Gets where the report is written, or null when it is printed instead.</summary>
    public string? MarkdownReportPath { get; init; }

    /// <summary>Gets whether an existing report file may be replaced.</summary>
    public bool OverwriteReport { get; init; }

    /// <summary>Validates one invocation.</summary>
    /// <param name="request">The raw option values.</param>
    /// <returns>The plan.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="request"/> is null.</exception>
    /// <exception cref="EvalCliException">A path is blank, malformed, outside the root, or not what it must be.</exception>
    public static TrendPlan Create(TrendRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);

        var guard = PathGuard.ForRoot(PathValue.RootFrom(request.Root), "--root");

        if (request.ReportMarkdown is null)
        {
            if (request.Overwrite)
            {
                // An opt-in with nothing to opt in to. `--verbose` was dropped from this command
                // for the same reason: a flag that is accepted and cannot act reads as one that
                // might, and the one it names here is the only irreversible thing this command
                // can do.
                throw new EvalCliException(
                    ExitCode.UsageError,
                    "--overwrite was given without --report-markdown, so there is no destination for it to allow "
                        + "replacing.",
                    "Nothing was read and nothing was written. Pass --report-markdown <path> as well, or drop "
                        + "--overwrite: without a destination this command prints the report and writes nothing."
                );
            }

            return new TrendPlan
            {
                ArtifactsDirectory = guard.ResolveExistingDirectory(request.Artifacts, "--artifacts"),
                RootDirectory = guard.Root,
            };
        }

        var artifacts = guard.ResolveExistingDirectory(request.Artifacts, "--artifacts");
        var destination = guard.ResolveOutputFile(
            request.ReportMarkdown,
            request.Overwrite,
            "--report-markdown",
            "--overwrite"
        );

        RequireDestinationOutsideInput(artifacts, destination);

        return new TrendPlan
        {
            ArtifactsDirectory = artifacts,
            RootDirectory = guard.Root,
            MarkdownReportPath = destination,
            OverwriteReport = request.Overwrite,
        };
    }

    /// <summary>
    /// Refuses a report destination that lands inside the directory the series is read from.
    /// </summary>
    /// <param name="artifacts">The canonical input directory.</param>
    /// <param name="destination">The canonical report destination.</param>
    /// <remarks>
    /// <para>
    /// <b>Refused regardless of <c>--overwrite</c>, because the opt-in is about replacing a file
    /// the caller chose, not about destroying the evidence they asked to be read.</b> A Markdown
    /// report written over <c>run-3.json</c> takes a run out of the series permanently, and the
    /// next invocation of this command would then classify the resulting hole in every scenario
    /// as though something had caused it. <c>run</c> already refuses <c>--out</c> equal to
    /// <c>--baseline</c> even with the opt-in; a directory input is the same failure with a
    /// directory in the middle of it, and the trend inherited none of that guard.
    /// </para>
    /// <para>
    /// <b>Containment, not a prefix test.</b> <c>trendy/report.md</c> is not inside <c>trend</c>,
    /// and a string comparison that refused it would be indistinguishable to whoever hit it from
    /// the refusal that matters.
    /// </para>
    /// </remarks>
    /// <exception cref="EvalCliException">The destination is inside the input directory.</exception>
    internal static void RequireDestinationOutsideInput(string artifacts, string destination)
    {
        if (!Inside(artifacts, destination))
        {
            return;
        }

        throw new EvalCliException(
            ExitCode.UsageError,
            "--report-markdown would write inside the directory --artifacts names, so this command could replace "
                + "one of the run artifacts it was asked to read.",
            "Nothing was read and nothing was written, and --overwrite does not lift this: the opt-in is about "
                + "replacing a file you chose, not about destroying the evidence the report is made of. Write the "
                + "report outside the artifacts directory."
        );
    }

    /// <summary>Whether a path resolves inside a directory.</summary>
    /// <param name="directory">The canonical directory.</param>
    /// <param name="path">The canonical path.</param>
    /// <returns><see langword="true"/> when the path is the directory or sits beneath it.</returns>
    private static bool Inside(string directory, string path)
    {
        try
        {
            return !MarkdownReport.LeavesRoot(Path.GetRelativePath(directory, path));
        }
        catch (ArgumentException)
        {
            // Neither path can be related to the other, so it is not inside. Both have already
            // been contained against one root, so this is unreachable through the guard.
            return false;
        }
    }
}

/// <summary>
/// Carries out one <c>trend</c> invocation and decides the exit code it reports.
/// </summary>
/// <remarks>
/// <para>
/// <b>Every path out of here either returns <see cref="ExitCode.Success"/> because the report was
/// produced, or throws.</b> There is deliberately no branch that prints a refusal and falls
/// through to a zero exit, and no branch that renders a trend over a series it could not fully
/// read.
/// </para>
/// <para>
/// <b>One unreadable artifact refuses the whole directory.</b> Skipping it would silently remove a
/// run from the series — and the report would then classify the resulting hole in every other
/// scenario as though it were real, which is precisely the gap-as-flat-line failure the report is
/// built to prevent, arriving through the reader rather than the renderer.
/// </para>
/// <para>
/// <b>No artifact is written, replaced, or touched.</b> The directory is enumerated and read.
/// </para>
/// </remarks>
internal static class TrendCommand
{
    /// <summary>
    /// Re-asserts, at the moment of the write, that the report still lands outside the series.
    /// </summary>
    /// <param name="plan">The validated plan, whose paths this tool derived.</param>
    /// <param name="destination">The canonical report destination.</param>
    /// <remarks>
    /// <b>A named step rather than four lines inline, so the provenance of what it re-resolves can
    /// be tested directly.</b> Both paths here were produced by this tool, not typed by the
    /// caller, so a refusal out of them must not echo its subject — and "which
    /// <see cref="PathValue"/> factory did this call site use" is a question a test should be able
    /// to ask without needing the root to vanish between reading a directory and writing beside
    /// it, which the command exposes no seam for.
    /// </remarks>
    /// <exception cref="EvalCliException">
    /// The root, the input directory or the destination stopped being what the plan recorded.
    /// </exception>
    internal static void RecheckDestination(TrendPlan plan, string destination)
    {
        ArgumentNullException.ThrowIfNull(plan);

        var guard = PathGuard.ForRoot(PathValue.Derived(plan.RootDirectory), "--root");

        TrendPlan.RequireDestinationOutsideInput(
            guard.ResolveExistingDirectory(plan.ArtifactsDirectory, "--artifacts"),
            guard.VerifyWritePath(destination, "--report-markdown")
        );
    }

    /// <summary>The extension a run artifact is written with, and the only files read from the directory.</summary>
    private const string ArtifactPattern = "*.json";

    /// <summary>Executes one invocation.</summary>
    /// <param name="plan">The validated plan.</param>
    /// <param name="console">Where the report (stdout) and diagnostics (stderr) go.</param>
    /// <param name="cancellationToken">Cancels the invocation.</param>
    /// <returns><see cref="ExitCode.Success"/> when a trend was produced.</returns>
    /// <exception cref="ArgumentNullException">Any argument is null.</exception>
    /// <exception cref="EvalCliException">The directory could not be read, or cannot be trended.</exception>
    /// <exception cref="OperationCanceledException"><paramref name="cancellationToken"/> was cancelled.</exception>
    public static Task<ExitCode> ExecuteAsync(TrendPlan plan, IConsole console, CancellationToken cancellationToken) =>
        // An expression body on purpose: there is no statement position after the guard for a
        // later step to be added in. See DurableWrites for the property and its residual hole.
        DurableWrites.GuardAsync(written => RunAsync(plan, console, written, cancellationToken));

    private static async Task<ExitCode> RunAsync(
        TrendPlan plan,
        IConsole console,
        DurableWrites written,
        CancellationToken cancellationToken
    )
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(console);

        cancellationToken.ThrowIfCancellationRequested();

        var artifacts = await ReadAsync(plan, cancellationToken).ConfigureAwait(false);

        var rendering = TrendReport.Render(
            new TrendReportRequest
            {
                Trend = SuiteTrend.Build(artifacts),
                RootDirectory = plan.RootDirectory,
                ArtifactsDirectory = plan.ArtifactsDirectory,
            }
        );

        if (plan.MarkdownReportPath is not { } destination)
        {
            await WriteAsync(console, rendering.Text, cancellationToken).ConfigureAwait(false);

            return ExitCode.Success;
        }

        // Asked again, with the file system in the state it is in now. The first answer was given
        // while the arguments were validated and a whole directory has been read since; a
        // directory swapped for a link in between would redirect the write into the series it was
        // read from, and no file mode defends against that because the mode governs the leaf while
        // what moved was the path to it. This narrows the window rather than closing it — what
        // closes it is that ArtifactWriter never truncates, staging under a fresh name and
        // renaming into place.
        RecheckDestination(plan, destination);

        // Through the same writer the run artifact goes through: containment re-asserted at the
        // moment of the write, staged under a name FileMode.CreateNew creates or refuses,
        // re-verified with the file in hand, and renamed into place. A second, weaker write path
        // for a second report is how the two drift.
        var reportPath = await ArtifactWriter
            .WriteAsync(
                new ArtifactWrite
                {
                    Destination = destination,
                    RootDirectory = plan.RootDirectory,
                    OptionName = "--report-markdown",
                    ReplaceOptionName = "--overwrite",
                    Publication = plan.OverwriteReport
                        ? ArtifactPublication.CreateOrReplace
                        : ArtifactPublication.CreateOnly,
                    Contents = rendering.Text,
                    FailureContext = "The trend was produced but its report could not be written",
                    LossNote =
                        "The artifacts it was read from are untouched; only the rendering for a pull request was "
                        + "lost",
                    DurableNote = "the trend report",
                },
                written,
                cancellationToken
            )
            .ConfigureAwait(false);

        // The result on stdout is where the report went, so a shell can pass it straight to
        // whatever posts it. The report itself is in the file rather than on both channels.
        await WriteAsync(console, MarkdownReport.Display(plan.RootDirectory, reportPath), cancellationToken)
            .ConfigureAwait(false);

        return ExitCode.Success;
    }

    /// <summary>
    /// Reads every artifact in the directory, refusing the series if any one of them will not read.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>The directory itself, not the tree under it.</b> Recursing would sweep a nested baseline
    /// or an unrelated suite's runs into a series nobody asked for, and the resulting trend would
    /// be over a population the caller never named.
    /// </para>
    /// <para>
    /// <b>Read through <see cref="ArtifactBaseline"/>, which is the one artifact reader in this
    /// repository.</b> That gives this command the size budget checked before a byte is
    /// allocated, the containment re-asserted through every link, and the schema check inside
    /// <see cref="CanonicalJson.DeserializeSuiteResult(string)"/> — including the machine-path
    /// refusal ADR 0005 put there rather than in a renderer.
    /// </para>
    /// <para>
    /// <b>The refusal names the file by its path relative to the root, through the report's own
    /// display rule.</b> The engine's own message carries the reference it was given, so it is
    /// deliberately not forwarded: this message reaches standard error and from there the build
    /// log, and an absolute path there names the account the job runs as (§V).
    /// </para>
    /// </remarks>
    private static async Task<IReadOnlyList<TrendArtifact>> ReadAsync(
        TrendPlan plan,
        CancellationToken cancellationToken
    )
    {
        string[] paths;

        try
        {
            // Ordinal rather than the file system's order, so which two files a refusal names is a
            // function of the directory's contents and not of how it happens to be enumerated.
            // Forced inside the guard on purpose: enumeration is lazy, so a directory that has
            // gone away, or that this process may not read, faults where the sequence is drained
            // rather than where it is built.
            paths =
            [
                .. Directory
                    .EnumerateFiles(plan.ArtifactsDirectory, ArtifactPattern, SearchOption.TopDirectoryOnly)
                    .Order(StringComparer.Ordinal),
            ];
        }
        catch (Exception exception) when (Unreadable(exception))
        {
            throw new EvalCliException(
                ExitCode.ComparisonRefused,
                $"The directory {MarkdownReport.Display(plan.RootDirectory, plan.ArtifactsDirectory)} could not be "
                    + "listed, so this series cannot be read at all.",
                "Nothing was written. It was there when the arguments were validated, so it has gone away or "
                    + "become unreadable since. Re-run once the directory is stable."
            );
        }

        var reader = new ArtifactBaseline(plan.RootDirectory);
        var artifacts = new List<TrendArtifact>(paths.Length);

        foreach (var path in paths)
        {
            var label = MarkdownReport.Display(plan.RootDirectory, path);

            SuiteResult? artifact;

            try
            {
                artifact = await reader.TryGetBaselineAsync(path, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception exception) when (Unreadable(exception))
            {
                throw new EvalCliException(
                    ExitCode.ComparisonRefused,
                    $"The file {label} is in --artifacts and is not a readable run artifact, so this series cannot "
                        + "be read whole.",
                    "Nothing was written. It is refused rather than skipped: dropping it would take a run out of "
                        + "the series silently, and every scenario would then carry a hole at that position that "
                        + "nothing caused. Move the file out of the directory, or regenerate it from a run."
                );
            }

            if (artifact is null)
            {
                // Enumerated a moment ago and gone now. Refused rather than skipped, for the
                // reason above: a series short one run is not a series with one fewer run in it.
                throw new EvalCliException(
                    ExitCode.ComparisonRefused,
                    $"The file {label} was in --artifacts when the directory was listed and is not there now, so "
                        + "this series cannot be read whole.",
                    "Nothing was written. Re-run once the directory is stable."
                );
            }

            artifacts.Add(new TrendArtifact(label, artifact));
        }

        return artifacts;
    }

    /// <summary>
    /// Reports whether a failure means an input would not read, rather than a defect in this tool.
    /// </summary>
    /// <param name="exception">The failure.</param>
    /// <returns><see langword="true"/> when it is a refusal this command should report.</returns>
    /// <remarks>
    /// <para>
    /// <b><see cref="UnauthorizedAccessException"/> is on this list and is the reason the list
    /// exists.</b> <c>File.ReadAllTextAsync</c> and <c>Directory.EnumerateFiles</c> both raise it
    /// and the engine's reader does not convert it, so uncaught it reaches the exception-handler
    /// middleware as an unrecognised failure — <see cref="ExitCode.UnexpectedError"/>, the one
    /// branch that prints a stack trace, and with it the checkout directory and the source layout
    /// of the machine that built the tool (§V). A permission problem on somebody's artifacts
    /// directory is not a defect in this tool and must not be reported as one.
    /// </para>
    /// <para>
    /// <b><see cref="OperationCanceledException"/> is deliberately absent.</b> An interruption is
    /// not a file that would not read, and folding it in here would turn Ctrl+C into a refusal
    /// about the input.
    /// </para>
    /// <para>
    /// A named predicate rather than an inline <c>when</c> clause so it can be exercised directly.
    /// The one entry that matters most cannot be provoked portably from a test — it needs an ACL
    /// this process can set and then not read through — and a filter nothing can demonstrate reads
    /// like protection that is not there.
    /// </para>
    /// </remarks>
    internal static bool Unreadable(Exception exception) =>
        exception
            is ArgumentException
                or IOException
                or InvalidOperationException
                or JsonException
                or NotSupportedException
                or SchemaVersionException
                or UnauthorizedAccessException
                or UnsafeIdentifierException;

    private static async Task WriteAsync(IConsole console, string rendered, CancellationToken cancellationToken)
    {
        var output = console.Out.CreateTextWriter();

        await output.WriteLineAsync(rendered.AsMemory(), cancellationToken).ConfigureAwait(false);
        await output.FlushAsync(cancellationToken).ConfigureAwait(false);
    }
}
