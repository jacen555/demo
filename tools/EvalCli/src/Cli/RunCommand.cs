using System.CommandLine;
using System.CommandLine.IO;
using Forge.EvalCli.Composition;

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
/// Executing a suite is not wired up in this build. That is reported as
/// <see cref="ExitCode.NotImplemented"/> rather than as success, because nothing ran and nothing
/// that did not run may report that it passed.
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
    /// <exception cref="EvalCliException">The requested operation is not wired up in this build.</exception>
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

        if (!plan.DryRun)
        {
            throw new EvalCliException(
                ExitCode.NotImplemented,
                "Running a suite is not wired up in this build; only --dry-run is.",
                "Re-run with --dry-run to see exactly what would happen. Nothing was executed and "
                    + "nothing was written."
            );
        }

        var rendered = plan.Json ? PlanRenderer.RenderJson(plan, harness) : PlanRenderer.RenderText(plan, harness);

        var output = console.Out.CreateTextWriter();

        await output.WriteLineAsync(rendered.AsMemory(), cancellationToken).ConfigureAwait(false);
        await output.FlushAsync(cancellationToken).ConfigureAwait(false);

        return ExitCode.Success;
    }
}
