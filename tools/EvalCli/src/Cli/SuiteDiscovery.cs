using System.CommandLine;
using System.CommandLine.IO;
using System.Globalization;
using System.Text;
using System.Text.Json;
using Forge.EvalEngine.Baselines;
using Forge.EvalEngine.Loading;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Serialization;

namespace Forge.EvalCli.Cli;

/// <summary>
/// Turns the two file inputs a run needs — the suite and, when one was named, the baseline — into
/// engine types, and turns the engine's refusals into an exit code and a message.
/// </summary>
/// <remarks>
/// <para>
/// <b>Nothing here catches and continues.</b> The engine refuses malformed or untrustworthy input
/// rather than guessing, and every one of those refusals ends this invocation with a non-zero
/// code. A loader finding that was reported and then run past would produce a result computed
/// from input nobody could vouch for, which is the one failure an exit code cannot warn a caller
/// about afterwards.
/// </para>
/// </remarks>
internal static class SuiteDiscovery
{
    /// <summary>Loads and validates the suite.</summary>
    /// <param name="loader">The loader, confined to the same root the arguments were checked against.</param>
    /// <param name="plan">The validated plan.</param>
    /// <param name="console">Where warnings go. Standard error, so stdout stays composable.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The validated suite.</returns>
    /// <exception cref="ArgumentNullException">Any argument is null.</exception>
    /// <exception cref="EvalCliException">
    /// The suite could not be loaded, did not validate, or declares no scenarios.
    /// </exception>
    /// <exception cref="OperationCanceledException">The token was cancelled.</exception>
    public static async Task<Suite> LoadSuiteAsync(
        SuiteLoader loader,
        RunPlan plan,
        IConsole console,
        CancellationToken cancellationToken
    )
    {
        ArgumentNullException.ThrowIfNull(loader);
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(console);

        SuiteLoadResult result;

        try
        {
            result = await loader.LoadAsync(plan.SuitePath, cancellationToken).ConfigureAwait(false);
        }
        catch (ArgumentException exception)
        {
            // The path was already contained against this same root by the same boundary, so
            // reaching here means the file system changed underneath the invocation. Refused
            // rather than retried: whatever is there now is not what was checked.
            throw new EvalCliException(
                ExitCode.SuiteError,
                $"--suite could not be read from the suite root: {exception.Message}",
                "Nothing was executed. Re-run once the path is stable."
            );
        }

        foreach (var warning in result.Messages.Where(message => message.Severity is ValidationSeverity.Warning))
        {
            console.Error.WriteLine($"eval-cli: {warning}");
        }

        if (result.Succeeded)
        {
            return Declared(result.Suite!, plan);
        }

        var errors = result.Messages.Where(message => message.Severity is ValidationSeverity.Error).ToArray();
        var detail = new StringBuilder("The suite did not validate, so nothing was run.");

        foreach (var error in errors)
        {
            detail.AppendLine().Append("          ").Append(error.ToString());
        }

        throw new EvalCliException(
            ExitCode.SuiteError,
            detail.ToString(),
            "Fix the "
                + errors.Length.ToString(CultureInfo.InvariantCulture)
                + $" finding(s) above in {plan.SuitePath}. A suite that does not validate cannot produce "
                + "evidence, so it is refused rather than partly run."
        );
    }

    /// <summary>Refuses a suite that declares nothing to conduct.</summary>
    /// <param name="suite">The suite, already validated by the loader.</param>
    /// <param name="plan">The validated plan, for the path to name.</param>
    /// <returns>The suite, when it declares at least one scenario.</returns>
    /// <remarks>
    /// <para>
    /// The engine warns about this and does not error, which is its judgement to make: a library
    /// cannot know whether an empty suite is a mistake or a placeholder. A command-line tool can,
    /// because it owns something the library does not — the exit code. An automated caller reads
    /// only that code, and <c>0</c> tells it the evaluation passed. Nothing was evaluated, so
    /// there is no such thing to tell it. Printing <c>0 of 0</c> answers a human reading stdout
    /// and answers CI not at all.
    /// </para>
    /// <para>
    /// This is the same rule the exit code already applies to a run recorded as an error — a
    /// harness that could not ask the question must not report that the answer was good — moved
    /// one stage earlier, to the suite that never asked one.
    /// </para>
    /// <para>
    /// <b>A suite that declares scenarios and selects none of them is a different thing</b> and
    /// is not refused. There, the scenarios exist, the selector chose to skip them, and the
    /// report names the rule it chose by. The refusal here is for a suite with nothing to skip.
    /// </para>
    /// </remarks>
    /// <exception cref="EvalCliException">The suite declares no scenarios.</exception>
    private static Suite Declared(Suite suite, RunPlan plan)
    {
        if (suite.Scenarios.Count > 0)
        {
            return suite;
        }

        throw new EvalCliException(
            ExitCode.SuiteError,
            $"The suite declares no scenarios, so there is nothing to conduct: {plan.SuitePath}",
            "Nothing was executed. A run against an empty suite produces no evidence, and reporting it as a "
                + "success would tell every caller that checks the exit code that the evaluation passed. Declare "
                + "at least one scenario, or point --suite at the suite you meant."
        );
    }

    /// <summary>Loads the baseline artifact, when one was named, for the selector to skip on.</summary>
    /// <param name="baselines">The provider, confined to the containment root.</param>
    /// <param name="plan">The validated plan.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The baseline, or null when none was named.</returns>
    /// <remarks>
    /// <para>
    /// <b>An unreadable baseline is never treated as an absent one.</b> Absent means "nothing
    /// records how this scenario last behaved", which makes every scenario run; unreadable means
    /// the evidence exists and could not be read, and collapsing the two would report the first
    /// while the second happened. The engine's provider already draws that line — only a
    /// genuinely absent artifact yields null — so this preserves it rather than flattening it
    /// into one catch.
    /// </para>
    /// <para>
    /// In this build the baseline is an input to <i>selection</i> only. Comparing a candidate
    /// against it is a later stage; what it decides here is which scenarios there is evidence to
    /// skip.
    /// </para>
    /// </remarks>
    /// <exception cref="ArgumentNullException">Any argument is null.</exception>
    /// <exception cref="EvalCliException">A baseline was named and could not be read.</exception>
    /// <exception cref="OperationCanceledException">The token was cancelled.</exception>
    public static async Task<SuiteResult?> LoadBaselineAsync(
        ArtifactBaseline baselines,
        RunPlan plan,
        CancellationToken cancellationToken
    )
    {
        ArgumentNullException.ThrowIfNull(baselines);
        ArgumentNullException.ThrowIfNull(plan);

        if (plan.BaselinePath is not { } reference)
        {
            return null;
        }

        SuiteResult? baseline;

        try
        {
            baseline = await baselines.TryGetBaselineAsync(reference, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception)
            when (exception
                    is ArgumentException
                        or IOException
                        or InvalidOperationException
                        or JsonException
                        or SchemaVersionException
            )
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                $"--baseline names a file that is not a readable run artifact: {reference}",
                "Nothing was executed. Regenerate the baseline from a run rather than editing it by hand; a "
                    + "baseline that cannot be read is not the same as no baseline, and must not be treated as one."
            );
        }

        if (baseline is null)
        {
            throw new EvalCliException(
                ExitCode.BaselineMissing,
                $"--baseline named an artifact that is not there: {reference}",
                "Nothing was executed. No baseline is not the same as no regression, so a baseline that was asked "
                    + "for and not found stops the run rather than silently widening it."
            );
        }

        return baseline;
    }
}
