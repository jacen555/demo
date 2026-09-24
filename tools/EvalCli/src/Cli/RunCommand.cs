using System.CommandLine;
using System.CommandLine.IO;
using System.Text;
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
/// baseline it might be skipped against, acquire the changed-file set, select, run, write, report.
/// Nothing is caught and continued. The engine refuses rather than guessing at every one of those
/// stages, and a refusal here becomes a message and a non-zero code.
/// </para>
/// </remarks>
internal static class RunCommand
{
    /// <summary>What a not-yet-published artifact is called while it is being written.</summary>
    /// <remarks>
    /// Derived from the destination rather than randomized, so it is deterministic, it lands in
    /// the directory that was just verified, and two runs racing for one <c>--out</c> collide on
    /// it and are refused instead of interleaving. A file left under this name is a run that was
    /// killed mid-write: the destination was never touched, and the next run says so rather than
    /// staging over it.
    /// </remarks>
    private const string StagedSuffix = ".partial";

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

        var result = await provider
            .GetRequiredService<RunCoordinator>()
            .RunAsync(Narrow(suite, summary), cancellationToken)
            .ConfigureAwait(false);

        var artifactPath = await WriteArtifactAsync(plan, result, cancellationToken).ConfigureAwait(false);

        var rendered = plan.Json
            ? RunReport.RenderJson(plan, summary, result, artifactPath)
            : RunReport.RenderText(plan, summary, result, artifactPath);

        await WriteAsync(console, rendered, cancellationToken).ConfigureAwait(false);

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
    /// <b>The destination was validated before the run, and that evidence has expired.</b> A run
    /// takes as long as the system under test does, and containment is a property of the file
    /// system rather than of the argument — so a directory along the way that has since been
    /// swapped for a link would redirect this write to somewhere the caller never authorized. The
    /// path is therefore re-asserted here, immediately before anything is opened, rather than
    /// trusted from minutes ago.
    /// </para>
    /// <para>
    /// <b>Re-checking narrows that window; staging closes what is left of it.</b> The artifact is
    /// written to a fresh name that <see cref="FileMode.CreateNew"/> creates or refuses — never a
    /// mode that truncates, so no file that already exists anywhere can lose its contents to this
    /// — and the path it actually landed on is verified again, with the file in hand, before a
    /// byte is written. Then it is renamed into place. A rename replaces the destination entry
    /// itself rather than following a link through it, and without <c>--overwrite</c> it refuses
    /// an occupied destination atomically, which is the same no-clobber guarantee
    /// <see cref="FileMode.CreateNew"/> gave before and for the same reason: a second
    /// <c>File.Exists</c> would have the same race, just a narrower one.
    /// </para>
    /// <para>
    /// What remains is the interval between the last verification and the rename, which cannot be
    /// closed without a handle the platform will not open through a link — .NET exposes no
    /// portable equivalent. It is microseconds rather than the length of a run, and the worst it
    /// can now do is put a new file somewhere unintended, never destroy one that was there.
    /// </para>
    /// <para>
    /// Serialized through the engine's canonical writer, so a committed artifact diffs cleanly
    /// against the next one rather than differing by property order.
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

        var staged = destination + StagedSuffix;
        var stagedIsOurs = false;

        try
        {
            var guard = PathGuard.ForRoot(plan.RootDirectory, "--root");

            guard.VerifyWritePath(destination, "--out");

            var file = new FileStream(staged, FileMode.CreateNew, FileAccess.Write, FileShare.None);

            stagedIsOurs = true;

            await using (file.ConfigureAwait(false))
            await using (var writer = new StreamWriter(file, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false)))
            {
                // Asked of the staged file now that it exists: this is what proves the directory
                // the bytes are going into is the verified one, rather than one the path merely
                // pointed at a moment ago.
                guard.VerifyWritePath(staged, "--out");

                await writer
                    .WriteAsync(CanonicalJson.Serialize(result).AsMemory(), cancellationToken)
                    .ConfigureAwait(false);
            }

            File.Move(staged, destination, plan.OverwriteArtifact);

            stagedIsOurs = false;
        }
        catch (EvalCliException refusal)
        {
            // The destination stopped being one this tool can vouch for while the run was in
            // flight. Reported at the write stage rather than as a usage error, because the
            // invocation was well formed: what changed was the file system underneath it.
            throw new EvalCliException(
                ExitCode.RunFailed,
                $"The run completed but its artifact could not be written to {destination}: {refusal.Message}",
                "The evidence the run produced was not recorded, and nothing outside the root was written or "
                    + "replaced. The destination was checked again at the moment of the write and no longer "
                    + "passed, so it was refused rather than followed. Re-run once that path is stable."
            );
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // The run happened; only the record of it did not. Reported as a failed run rather
            // than swallowed, because a caller who asked for an artifact and got a zero exit
            // would reasonably believe one is there.
            throw new EvalCliException(
                ExitCode.RunFailed,
                $"The run completed but its artifact could not be written to {destination}: {exception.Message}",
                plan.OverwriteArtifact
                    ? "The evidence the run produced was not recorded, so this is reported as a failed run rather "
                        + "than as a success with nothing to show for it. Check the permissions on that path and "
                        + "re-run."
                    : "The evidence the run produced was not recorded, and nothing that was already there was "
                        + "replaced. If a file appeared at that path while the run was in flight, pass --overwrite "
                        + "to replace it deliberately, or choose another destination."
            );
        }
        finally
        {
            if (stagedIsOurs)
            {
                Discard(staged);
            }
        }

        return destination;
    }

    /// <summary>Removes a staged artifact that never made it into place.</summary>
    /// <remarks>
    /// Only ever called for a file this invocation created with <see cref="FileMode.CreateNew"/>,
    /// which is what makes deleting it safe to do without asking: if anything had been there,
    /// that mode would have refused and there would be nothing here to remove. A failure to
    /// remove it is not worth failing a run over — the write it belonged to has already reported
    /// its own outcome, and this would be a second signal for one cause (§IV).
    /// </remarks>
    private static void Discard(string staged)
    {
        try
        {
            File.Delete(staged);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // Left behind rather than retried. The name is derived from the destination, so the
            // next run refuses to stage over it and says so.
        }
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
