using System.CommandLine;
using System.CommandLine.IO;
using System.Diagnostics.CodeAnalysis;
using Forge.EvalCli.Cli;
using Forge.EvalEngine.Coordination;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;
using Microsoft.Extensions.Logging;
using Spectre.Console;

namespace Forge.EvalCli.Diagnostics;

/// <summary>
/// Shows a suite's progress while it is conducted: the one seam both render paths sit behind.
/// </summary>
/// <remarks>
/// <para>
/// <b>Two paths, chosen by Spectre.Console's own detection rather than ours.</b> A live, in-place
/// display when standard error is an interactive terminal that understands ANSI; plain lines, one
/// per completed run, when it is redirected or running in CI. The engine reports the same
/// structured <see cref="RunProgress"/> either way, so which one renders it is decided once, here.
/// </para>
/// <para>
/// <b>A display is never allowed to cost the user a run.</b> Each path renders work inside the
/// engine's <see cref="IProgress{T}.Report(T)"/> call, or on a loop it owns and awaits, never on a
/// thread nothing is watching: <see cref="Progress{T}"/> posts to the thread pool in a console,
/// where a throwing handler terminates the process — measured, before or after the suite returned
/// — and Spectre's own auto-refresh thread has no catch either. What is left is the display's start
/// and its teardown, which run on the suite's own path. <see cref="ShowAsync"/> contains both: a
/// display that fails before the suite starts is abandoned and the suite is conducted without it,
/// and one that fails afterwards is logged and the result returned. Either way the outcome is
/// exactly what the suite would have produced with no display at all.
/// </para>
/// </remarks>
internal abstract partial class RunProgressDisplay
{
    /// <summary>Chooses the display for the console this invocation was given.</summary>
    /// <param name="console">The invocation's console.</param>
    /// <param name="diagnostics">Where every other diagnostic line is being written.</param>
    /// <returns>The display.</returns>
    /// <remarks>
    /// <b>Only the process's own console can host a live display.</b> Spectre recognises a terminal
    /// by asking whether its writer <i>is</i> <see cref="System.Console.Error"/>, so any other
    /// console — a test's, or one an embedding host supplied — is somewhere Spectre cannot see, and
    /// gets lines.
    /// </remarks>
    /// <exception cref="ArgumentNullException">Any argument is null.</exception>
    public static RunProgressDisplay For(IConsole console, DiagnosticsWriter diagnostics)
    {
        ArgumentNullException.ThrowIfNull(console);
        ArgumentNullException.ThrowIfNull(diagnostics);

        if (console is not SystemConsole)
        {
            return new StreamedRunProgress(diagnostics);
        }

        var terminal = AnsiConsole.Create(
            new AnsiConsoleSettings { Out = new AnsiConsoleOutput(System.Console.Error) }
        );

        return Choose(terminal, diagnostics);
    }

    /// <summary>Chooses between the two paths for a terminal Spectre has already profiled.</summary>
    /// <param name="terminal">Standard error, as Spectre sees it.</param>
    /// <param name="diagnostics">Where every other diagnostic line is being written.</param>
    /// <returns>A live display, or a streamed one.</returns>
    /// <exception cref="ArgumentNullException">Any argument is null.</exception>
    internal static RunProgressDisplay Choose(IAnsiConsole terminal, DiagnosticsWriter diagnostics)
    {
        ArgumentNullException.ThrowIfNull(terminal);
        ArgumentNullException.ThrowIfNull(diagnostics);

        return CanDrawLive(terminal.Profile)
            ? new LiveRunProgress(terminal, diagnostics, LiveRunProgress.DefaultRefreshInterval)
            : new StreamedRunProgress(diagnostics);
    }

    /// <summary>Whether Spectre's profile of a stream says a live display can be drawn on it.</summary>
    /// <param name="profile">Spectre's profile of the stream.</param>
    /// <returns><see langword="true"/> for an interactive ANSI terminal.</returns>
    /// <remarks>
    /// <para>
    /// <b>All three are Spectre's own detection, and each one is needed.</b> Spectre's progress
    /// display asks only the last two, and in 0.49.1 neither describes the stream being drawn on:
    /// <c>Interactive</c> is whether <i>standard input</i> is redirected, and <c>Ansi</c> falls
    /// back to <c>TERM</c> when the stream is not a console — so under Git Bash with stderr sent to
    /// a file both are true, and escape codes would be written into the file.
    /// <c>Out.IsTerminal</c> is the one that asks about this stream.
    /// </para>
    /// <para>
    /// CI is covered twice over: its output is a pipe, and Spectre's CI enrichers clear
    /// <c>Interactive</c> wherever they recognise the build system.
    /// </para>
    /// </remarks>
    internal static bool CanDrawLive(Profile profile)
    {
        ArgumentNullException.ThrowIfNull(profile);

        return profile.Out.IsTerminal && profile.Capabilities.Interactive && profile.Capabilities.Ansi;
    }

    /// <summary>Conducts one suite while showing its progress.</summary>
    /// <param name="suite">The suite about to be conducted.</param>
    /// <param name="logger">Where a fault in the display itself is reported.</param>
    /// <param name="conduct">
    /// Conducts the suite, reporting to the sink it is given, or to nothing when it is given null.
    /// </param>
    /// <param name="cancellationToken">The invocation's token.</param>
    /// <returns>Exactly what <paramref name="conduct"/> returned.</returns>
    /// <exception cref="ArgumentNullException">Any argument is null.</exception>
    /// <exception cref="OperationCanceledException">
    /// <paramref name="cancellationToken"/> was cancelled before the suite started, in which case
    /// nothing was started; or the suite itself was cancelled.
    /// </exception>
    /// <remarks>
    /// <para>
    /// Whatever <paramref name="conduct"/> throws is rethrown unchanged — its refusals,
    /// cancellation, and failures are the suite's, and they mean the same here as without a display.
    /// </para>
    /// <para>
    /// <b>The caller's cancellation is not a fault in the display.</b> It ends the invocation
    /// rather than being logged and run past, and a suite the caller has cancelled is never started
    /// by a display: the token is asked at the moment the display asks for the suite. That is the
    /// check that matters, because a display's start can block — a start line written to a stalled
    /// pipe runs to completion, cancelled or not — and a user who pressed Ctrl+C while it was blocked
    /// has not asked for the suite to begin. Showing nothing for an invocation already cancelled is
    /// each display's part; see <see cref="RenderAsync"/>.
    /// </para>
    /// </remarks>
    [SuppressMessage(
        "Design",
        "CA1031:Do not catch general exception types",
        Justification = "Deliberately total, and not silent: any fault in a display is logged as a warning here, "
            + "and none may cost the suite. A narrower catch would let an unlisted fault discard a finished run."
    )]
    public async Task<SuiteResult> ShowAsync(
        Suite suite,
        ILogger logger,
        Func<IProgress<RunProgress>?, Task<SuiteResult>> conduct,
        CancellationToken cancellationToken
    )
    {
        ArgumentNullException.ThrowIfNull(suite);
        ArgumentNullException.ThrowIfNull(logger);
        ArgumentNullException.ThrowIfNull(conduct);

        var outline = SuiteOutline.Of(suite);

        // Selection can narrow a suite to nothing. No run will complete, so there is nothing to
        // show, and a bar drawn against a total of zero would have nothing honest to say.
        if (outline.PlannedRuns == 0)
        {
            return await conduct(null).ConfigureAwait(false);
        }

        Task<SuiteResult>? conducted = null;

        try
        {
            await RenderAsync(
                    outline,
                    sink =>
                    {
                        // A suite conducted twice is twice the load on somebody else's system.
                        if (conducted is not null)
                        {
                            throw new InvalidOperationException("A progress display asked for its suite twice.");
                        }

                        // The moment before the suite starts, and the check that matters: see the
                        // remarks. Thrown from here, it reaches the catch below as the caller's.
                        cancellationToken.ThrowIfCancellationRequested();

                        conducted = ConductAsync(conduct, sink);

                        return conducted;
                    },
                    cancellationToken
                )
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // The caller's own cancellation, not a fault in the display. Before the suite has
            // started it ends the invocation here; after, the suite's own outcome is awaited below.
            if (conducted is null)
            {
                throw;
            }
        }
        catch (Exception fault)
        {
            // A display settles the suite rather than rethrowing what it threw, so everything that
            // arrives here is the display's own. Its type and never its message, which may quote
            // whatever it was drawing (§V).
            LogDisplayFailed(logger, fault.GetType().Name);
        }

        return await (conducted ?? conduct(null)).ConfigureAwait(false);
    }

    /// <summary>Draws one suite's progress while <paramref name="conduct"/> runs.</summary>
    /// <param name="outline">What the suite is about to do.</param>
    /// <param name="conduct">
    /// Starts the suite with the given sink. Call it at most once, and await what it returns to
    /// completion before returning.
    /// </param>
    /// <param name="cancellationToken">
    /// The invocation's token. Pass it to anything asynchronous done before the suite starts, and
    /// draw nothing if it is already cancelled; the suite observes it from the moment it starts.
    /// </param>
    /// <returns>A task that completes when the display has finished.</returns>
    /// <remarks>
    /// <b>Settle the suite; do not rethrow it.</b> Its outcome is returned or thrown by
    /// <see cref="ShowAsync"/>, so anything thrown from here is treated as this display failing.
    /// </remarks>
    protected abstract Task RenderAsync(
        SuiteOutline outline,
        Func<IProgress<RunProgress>, Task<SuiteResult>> conduct,
        CancellationToken cancellationToken
    );

    /// <summary>Waits for a task to complete without throwing what it ended with.</summary>
    /// <param name="task">The task.</param>
    /// <returns>A task that completes when <paramref name="task"/> has, successfully.</returns>
    protected static async Task SettleAsync(Task task)
    {
        ArgumentNullException.ThrowIfNull(task);

        await task.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
    }

    // Async so that a conduct delegate that throws synchronously still yields a task carrying the
    // exception: the suite's outcome always arrives the one way ShowAsync rethrows it.
    private static async Task<SuiteResult> ConductAsync(
        Func<IProgress<RunProgress>?, Task<SuiteResult>> conduct,
        IProgress<RunProgress> sink
    ) => await conduct(sink).ConfigureAwait(false);

    // A source-generated delegate rather than a formatted call (CA1848). The argument is a type
    // name and nothing else.
    [LoggerMessage(
        EventId = 2100,
        Level = LogLevel.Warning,
        Message = "The progress display failed ({FaultType}) and was abandoned. The suite was conducted and its "
            + "result is unaffected; only the display was lost."
    )]
    private static partial void LogDisplayFailed(ILogger logger, string faultType);
}

/// <summary>What a display needs to know about a suite before its first run completes.</summary>
/// <param name="Name">The suite's name, put through the same net as every other value on stderr.</param>
/// <param name="Scenarios">How many scenarios it declares.</param>
/// <param name="PlannedRuns">How many runs it plans: every repetition of every scenario.</param>
/// <remarks>
/// <b>The total is known before anything runs</b>, which is what lets a display open with a start
/// line rather than with the silence it exists to remove. It is the same sum the engine plans and
/// reports as <see cref="RunProgress.Total"/>; once reports arrive, theirs is the one shown.
/// </remarks>
internal sealed record SuiteOutline(string Name, int Scenarios, long PlannedRuns)
{
    /// <summary>Outlines a suite.</summary>
    /// <param name="suite">The suite.</param>
    /// <returns>The outline.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="suite"/> is null.</exception>
    public static SuiteOutline Of(Suite suite)
    {
        ArgumentNullException.ThrowIfNull(suite);

        return new SuiteOutline(
            MarkdownReport.Sanitize(suite.Name, MarkdownReport.MaxIdentifierCharacters),
            suite.Scenarios.Count,
            suite.Scenarios.Sum(scenario => (long)scenario.Execution.RepetitionPolicy.Repetitions)
        );
    }
}
