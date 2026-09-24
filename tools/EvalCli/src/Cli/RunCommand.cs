using System.CommandLine;
using System.CommandLine.IO;
using Forge.EvalCli.Changes;
using Forge.EvalCli.Composition;
using Forge.EvalEngine.Baselines;
using Forge.EvalEngine.Coordination;
using Forge.EvalEngine.Impact;
using Forge.EvalEngine.Loading;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Serialization;
using Microsoft.Extensions.DependencyInjection;

namespace Forge.EvalCli.Cli;

/// <summary>
/// Carries out one <c>run</c> invocation and decides the exit code it reports.
/// </summary>
/// <remarks>
/// <para>
/// <b>Every path out of here either returns <see cref="ExitCode.Success"/> because the work
/// completed, or throws.</b> There is deliberately no branch that prints a failure and falls
/// through to a zero exit: that combination turns a red result into a green check, and it is the
/// one defect a caller has no way to detect.
/// </para>
/// <para>
/// The stages run in the order their evidence becomes available: load the suite, read the
/// baseline it might be skipped against, acquire the changed-file set, select, run, write,
/// compare, report. Nothing is caught and continued. The engine refuses rather than guessing at
/// every one of those stages, and a refusal here becomes a message and a non-zero code.
/// </para>
/// <para>
/// <b>The comparison is report-only.</b> It changes what is printed and, when it is refused, the
/// exit code — but a regression it found does not, because the gate is reserved
/// (<see cref="ExitCode.RegressionsFound"/>) and <c>--fail-on-regression</c> is parsed and
/// deliberately inert. A refused comparison is a different thing from a comparison that found
/// nothing, and only the first of those is non-zero.
/// </para>
/// </remarks>
internal static class RunCommand
{
    /// <summary>Executes one invocation.</summary>
    /// <param name="plan">The validated plan.</param>
    /// <param name="console">Where results (stdout) and diagnostics (stderr) go.</param>
    /// <param name="cancellationToken">Cancels the invocation.</param>
    /// <returns>The exit code, which is <see cref="ExitCode.Success"/> only when the work completed.</returns>
    /// <exception cref="ArgumentNullException">Any argument is null.</exception>
    /// <exception cref="EvalCliException">The invocation was refused at one of its stages.</exception>
    /// <exception cref="OperationCanceledException"><paramref name="cancellationToken"/> was cancelled.</exception>
    public static async Task<ExitCode> ExecuteAsync(RunPlan plan, IConsole console, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(console);

        cancellationToken.ThrowIfCancellationRequested();

        // Built before the dry-run branch so that a composition root which cannot be satisfied is
        // a failure of the preview too. A dry run that skipped this would report a plan the real
        // run could not carry out.
        using var provider = EvalCliServices.Build(plan, console.Error.CreateTextWriter());

        var harness = HarnessDescription.Describe(provider);

        if (plan.DryRun)
        {
            var preview = plan.Json ? PlanRenderer.RenderJson(plan, harness) : PlanRenderer.RenderText(plan, harness);

            await WriteAsync(console, preview, cancellationToken).ConfigureAwait(false);

            return ExitCode.Success;
        }

        var suite = await SuiteDiscovery
            .LoadSuiteAsync(provider.GetRequiredService<SuiteLoader>(), plan, console, cancellationToken)
            .ConfigureAwait(false);

        var baseline = await SuiteDiscovery
            .LoadBaselineAsync(provider.GetRequiredService<ArtifactBaseline>(), plan, cancellationToken)
            .ConfigureAwait(false);

        var changes = await provider
            .GetRequiredService<IChangedFileSource>()
            .GetChangedFilesAsync(cancellationToken)
            .ConfigureAwait(false);

        var summary = Select(suite, changes, baseline);
        var conducted = Narrow(suite, summary);

        // Pinned before anything is conducted. The coordinator draws its seeds sequentially over
        // the suite it is handed, so narrowing the suite shifts the draw of every scenario after
        // a skipped one — and the comparison is paired by seed. See SeedSchedule.
        provider
            .GetRequiredService<SeedSchedule>()
            .PinTo(suite, [.. conducted.Scenarios.Select(scenario => scenario.Identity.Id)]);

        var result = await provider
            .GetRequiredService<RunCoordinator>()
            .RunAsync(conducted, cancellationToken)
            .ConfigureAwait(false);

        var artifactPath = await WriteArtifactAsync(plan, result, cancellationToken).ConfigureAwait(false);

        try
        {
            // After the artifact is on disk, deliberately. A refused comparison still leaves the
            // evidence the run produced, which is what a user needs in order to act on the
            // refusal — and the artifact is a statement about this run, which is true whether or
            // not anything could be compared against it.
            var comparison = await BaselineComparison
                .CompareAsync(provider, plan, conducted, summary.Selection.Skipped, result, baseline, cancellationToken)
                .ConfigureAwait(false);

            var rendered = plan.Json
                ? RunReport.RenderJson(plan, summary, result, artifactPath, comparison)
                : RunReport.RenderText(plan, summary, result, artifactPath, comparison);

            await WriteAsync(console, rendered, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException cancelled) when (artifactPath is not null)
        {
            // Everything from the publication onwards, not only the write of the report. The
            // comparison between them conducts a whole second suite against the baseline address
            // when one was named, which is the longest cancellable stretch this command has and
            // therefore the likeliest place for an interruption to land. The artifact is already
            // on disk throughout all of it. The interruption is still an interruption — same exit
            // code — but the one sentence a caller reads about it must not be the blanket
            // "nothing was written", which would send them looking past the file they now have.
            throw new InterruptedAfterWritingException(
                $"the artifact at {artifactPath} was written before the report could be, so the evidence this run "
                    + "produced is on disk.",
                cancelled
            );
        }

        return Outcome(result);
    }

    /// <summary>Chooses which scenarios to run, and records what the choice was made of.</summary>
    /// <remarks>
    /// <para>
    /// A changed-file set that could not be established is handed over as the empty sequence, and
    /// the selector answers that with a full-suite run in its own words. <b>The reason it was
    /// empty stays with it</b>: the selector knows only that nothing was supplied, while this
    /// layer knows whether that was because git is absent, because the revision was unknown, or
    /// because no revision was asked for at all. Those select the same scenarios and mean
    /// entirely different things, and only the report can tell them apart.
    /// </para>
    /// <para>
    /// Nothing partial is ever handed in. <see cref="ChangedFileSet"/> carries no paths when it
    /// carries a reason, because a set missing a file nobody can account for would select a
    /// subset that looks exactly like a correct one.
    /// </para>
    /// </remarks>
    private static SelectionSummary Select(Suite suite, ChangedFileSet changes, SuiteResult? baseline) =>
        new()
        {
            Changes = changes,
            Selection = ImpactSelector.Select(suite, changes.Paths, baseline),
            TotalScenarios = suite.Scenarios.Count,
        };

    /// <summary>Reduces the suite to the scenarios the selector chose, in suite order.</summary>
    /// <remarks>
    /// Indexed by identifier rather than filtered by position, because the selector's output is
    /// keyed by id and a positional assumption is the sort that holds until the day a suite is
    /// reordered. Suite order is preserved so the artifact reads the way the suite does.
    /// </remarks>
    private static Suite Narrow(Suite suite, SelectionSummary summary)
    {
        var selected = summary.Selection.Selected.Select(entry => entry.ScenarioId).ToHashSet(StringComparer.Ordinal);

        return suite with
        {
            Scenarios = [.. suite.Scenarios.Where(scenario => selected.Contains(scenario.Identity.Id))],
        };
    }

    /// <summary>Writes the artifact, when a destination was asked for.</summary>
    /// <param name="plan">The validated plan.</param>
    /// <param name="result">The artifact the run produced.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>Where it was written, or null when no destination was named.</returns>
    /// <remarks>
    /// <para>
    /// The write discipline itself — containment re-asserted at the moment of the write, staging
    /// under a name <see cref="FileMode.CreateNew"/> creates or refuses, re-verification with the
    /// file in hand, and an atomic rename — belongs to <see cref="ArtifactWriter"/> and is
    /// documented there. This supplies only the vocabulary: which option named the destination,
    /// what was lost if it could not be written, and whether replacing an existing file was opted
    /// into.
    /// </para>
    /// <para>
    /// <b>The bytes are redacted first.</b> A transcript records the address a run was actually
    /// directed at, path included, and this artifact is committed and read by people — see
    /// <see cref="ArtifactRedaction"/> for why that rule belongs at the write rather than at the
    /// run.
    /// </para>
    /// </remarks>
    private static async Task<string?> WriteArtifactAsync(
        RunPlan plan,
        SuiteResult result,
        CancellationToken cancellationToken
    )
    {
        if (plan.ArtifactPath is not { } destination)
        {
            return null;
        }

        return await ArtifactWriter
            .WriteAsync(
                new ArtifactWrite
                {
                    Destination = destination,
                    RootDirectory = plan.RootDirectory,
                    OptionName = "--out",
                    ReplaceOptionName = "--overwrite",
                    Publication = plan.OverwriteArtifact
                        ? ArtifactPublication.CreateOrReplace
                        : ArtifactPublication.CreateOnly,
                    Contents = CanonicalJson.Serialize(ArtifactRedaction.Redact(result)),
                    FailureContext = "The run completed but its artifact could not be written",
                    LossNote = "The evidence the run produced was not recorded",
                },
                cancellationToken
            )
            .ConfigureAwait(false);
    }

    /// <summary>Decides what the completed run means for the exit code.</summary>
    /// <remarks>
    /// <para>
    /// A scenario that ran and failed is report-only in this build: the system under test
    /// behaving badly is what the suite exists to observe, and the gate that turns it into a
    /// non-zero exit is reserved.
    /// </para>
    /// <para>
    /// <b>A run recorded as an error is different, and is not report-only.</b> It means the
    /// harness could not ask the question — no transport, no runner registered for the kind, an
    /// adapter that fell over — so that scenario produced no evidence at all. Exiting zero there
    /// would put a green check over a suite that was never conducted, which is the failure this
    /// whole tool is built to make unreachable.
    /// </para>
    /// </remarks>
    private static ExitCode Outcome(SuiteResult result) =>
        RunReport.HarnessFailed(result) ? ExitCode.RunFailed : ExitCode.Success;

    private static async Task WriteAsync(IConsole console, string rendered, CancellationToken cancellationToken)
    {
        var output = console.Out.CreateTextWriter();

        await output.WriteLineAsync(rendered.AsMemory(), cancellationToken).ConfigureAwait(false);
        await output.FlushAsync(cancellationToken).ConfigureAwait(false);
    }
}
