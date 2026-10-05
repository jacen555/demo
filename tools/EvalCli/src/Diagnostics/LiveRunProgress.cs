using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Runtime.ExceptionServices;
using Forge.EvalEngine.Coordination;
using Forge.EvalEngine.Results;
using Spectre.Console;

namespace Forge.EvalCli.Diagnostics;

/// <summary>
/// Progress drawn in place on an interactive terminal, with Spectre.Console's progress display.
/// </summary>
/// <remarks>
/// <para>
/// <b>Nothing is drawn inside the engine's <see cref="IProgress{T}.Report(T)"/> call.</b> A redraw
/// on a real console was measured at about 0.64 ms, and a call is made on the worker that
/// conducted the run, which starts nothing else until it returns — so drawing there would slow a
/// fast suite by its own display. A call only records the counts, under a lock held for a few
/// assignments, and marks the frame stale.
/// </para>
/// <para>
/// <b>The frame is redrawn by a loop this display owns and awaits.</b> Spectre's own auto-refresh
/// does the same job on a dedicated thread with no catch, so anything thrown while drawing there
/// would terminate the process, before the artifact is written if the timing is unlucky. This loop
/// is a task awaited when the suite has finished, so a fault in it is observed on the suite's own
/// path and contained there; a draw that fails also stops further drawing, rather than failing on
/// every tick. A stale frame is redrawn within one <see cref="DefaultRefreshInterval"/>, so a burst
/// of completions followed by a long run never leaves the count behind for the length of that run.
/// </para>
/// <para>
/// <b>Diagnostics are drawn above the display, not beneath it.</b> Spectre redraws its region by
/// moving the cursor back up over it, so a log record written straight to stderr in between is
/// spliced into the region — measured in a real pseudo-console, shifted to the region's right edge
/// or glued onto the bar, never on a line of its own. While the display is up, the
/// <see cref="DiagnosticsWriter"/> hands each line to Spectre, which writes it above the region and
/// redraws the region below it.
/// </para>
/// </remarks>
internal sealed class LiveRunProgress : RunProgressDisplay
{
    /// <summary>How often a stale frame is redrawn. Spectre's own default refresh rate.</summary>
    internal static readonly TimeSpan DefaultRefreshInterval = TimeSpan.FromMilliseconds(100);

    private readonly IAnsiConsole _terminal;
    private readonly DiagnosticsWriter _diagnostics;
    private readonly TimeSpan _refreshInterval;

    /// <summary>Initializes a new instance of the <see cref="LiveRunProgress"/> class.</summary>
    /// <param name="terminal">The terminal to draw on.</param>
    /// <param name="diagnostics">Where every other diagnostic line is being written.</param>
    /// <param name="refreshInterval">How often a stale frame is redrawn.</param>
    /// <exception cref="ArgumentNullException">Any reference argument is null.</exception>
    /// <exception cref="ArgumentOutOfRangeException"><paramref name="refreshInterval"/> is not positive.</exception>
    public LiveRunProgress(IAnsiConsole terminal, DiagnosticsWriter diagnostics, TimeSpan refreshInterval)
    {
        ArgumentNullException.ThrowIfNull(terminal);
        ArgumentNullException.ThrowIfNull(diagnostics);
        ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(refreshInterval, TimeSpan.Zero);

        _terminal = terminal;
        _diagnostics = diagnostics;
        _refreshInterval = refreshInterval;
    }

    /// <inheritdoc/>
    /// <remarks>
    /// The token is asked once, before Spectre puts anything on screen, so an invocation already
    /// cancelled draws no bar. Nothing else this display does before the suite starts is
    /// asynchronous; the base class asks the token again as the suite is started, and the suite
    /// observes it from there.
    /// </remarks>
    protected override async Task RenderAsync(
        SuiteOutline outline,
        Func<IProgress<RunProgress>, Task<SuiteResult>> conduct,
        CancellationToken cancellationToken
    )
    {
        ArgumentNullException.ThrowIfNull(outline);
        ArgumentNullException.ThrowIfNull(conduct);

        cancellationToken.ThrowIfCancellationRequested();

        // Refreshed only by the loop below, never by Spectre's own thread. The final frame is left
        // on screen, so the count the suite ended on is still there above the report.
        var progress = new Progress(_terminal) { AutoRefresh = false, AutoClear = false };

        progress.Columns(
            new TaskDescriptionColumn { Alignment = Justify.Left },
            new ProgressBarColumn { Width = 30 },
            new PercentageColumn()
        );

        var fault = await progress
            .StartAsync(async context =>
            {
                var frame = new Frame(_terminal, context, outline);

                // The start line: the bar at zero, drawn before anything is dispatched.
                frame.Draw();

                using (_diagnostics.Divert(frame.TryWriteAbove))
                {
                    using var stop = new CancellationTokenSource();
                    var refreshing = RefreshAsync(frame, _refreshInterval, stop.Token);

                    // Stopped in a finally: disposing a token source does not cancel it, so a loop
                    // left running here would go on drawing over a terminal the display had left.
                    // And conduct can throw before it returns a task — a Ctrl+C caught at the last
                    // moment before the suite starts — so the finally is the only place it stops.
                    try
                    {
                        await SettleAsync(conduct(frame)).ConfigureAwait(false);
                    }
                    finally
                    {
                        await stop.CancelAsync().ConfigureAwait(false);
                        await refreshing.ConfigureAwait(false);
                    }
                }

                // Where the suite ended, including where a cancelled one stopped.
                frame.Draw();

                return frame.Fault;
            })
            .ConfigureAwait(false);

        if (fault is not null)
        {
            ExceptionDispatchInfo.Throw(fault);
        }
    }

    private static async Task RefreshAsync(Frame frame, TimeSpan interval, CancellationToken stop)
    {
        using var timer = new PeriodicTimer(interval);

        try
        {
            while (await timer.WaitForNextTickAsync(stop).ConfigureAwait(false))
            {
                if (frame.IsStale)
                {
                    frame.Draw();
                }
            }
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested)
        {
            // Stopped, which is how this loop ends.
        }
    }

    /// <summary>One suite's counts, and the Spectre task they are drawn with.</summary>
    private sealed class Frame : IProgress<RunProgress>
    {
        private readonly IAnsiConsole _terminal;
        private readonly ProgressContext _context;
        private readonly ProgressTask _task;
        private readonly string _suite;
        private readonly object _gate = new();
        private int _greatest;
        private long _total;
        private int _failed;
        private int _errored;
        private bool _stale;
        private Exception? _fault;

        public Frame(IAnsiConsole terminal, ProgressContext context, SuiteOutline outline)
        {
            _terminal = terminal;
            _context = context;
            _total = outline.PlannedRuns;

            // A task description is parsed as markup. The name has been through the net, and the
            // net's own alias — [path-redacted:…] — is exactly the shape markup reads as a style.
            _suite = Markup.Escape(outline.Name);
            _task = context.AddTask(Describe(0, _total, 0, 0), maxValue: _total);
        }

        /// <summary>Gets the first fault this frame hit drawing, after which it draws nothing.</summary>
        public Exception? Fault
        {
            get
            {
                lock (_gate)
                {
                    return _fault;
                }
            }
        }

        /// <summary>Gets whether a run has completed since the frame was last drawn.</summary>
        public bool IsStale
        {
            get
            {
                lock (_gate)
                {
                    return _stale && _fault is null;
                }
            }
        }

        /// <summary>Records one completed run. Draws nothing.</summary>
        /// <remarks>
        /// <b>The greatest count seen, never the latest</b>: above one run in flight a worker that
        /// counted seven can call after the one that counted eight. Failures and errors are tallied
        /// per call, and each call is one run, so they are exact whatever the order.
        /// </remarks>
        public void Report(RunProgress value)
        {
            ArgumentNullException.ThrowIfNull(value);

            lock (_gate)
            {
                _greatest = Math.Max(_greatest, value.Completed);
                _total = value.Total;

                if (value.Status is RunStatus.Fail)
                {
                    _failed++;
                }
                else if (value.Status is RunStatus.Error)
                {
                    _errored++;
                }

                _stale = true;
            }
        }

        /// <summary>Draws the current counts. Never throws: a fault is recorded and drawing stops.</summary>
        [SuppressMessage(
            "Design",
            "CA1031:Do not catch general exception types",
            Justification = "Not silent: the fault is recorded and RunProgressDisplay.ShowAsync logs it as a warning. "
                + "This runs on the refresh loop, where anything that escaped would end the loop and the display."
        )]
        public void Draw()
        {
            int greatest;
            long total;
            int failed;
            int errored;

            lock (_gate)
            {
                if (_fault is not null)
                {
                    return;
                }

                (greatest, total, failed, errored) = (_greatest, _total, _failed, _errored);
                _stale = false;
            }

            try
            {
                _task.MaxValue = total;
                _task.Value = greatest;
                _task.Description = Describe(greatest, total, failed, errored);
                _context.Refresh();
            }
            catch (Exception exception)
            {
                Record(exception);
            }
        }

        /// <summary>Draws a diagnostic line above the display.</summary>
        /// <param name="line">The line, already netted by whoever wrote it.</param>
        /// <returns>Whether it was drawn. A line that was not is written to stderr as usual.</returns>
        [SuppressMessage(
            "Design",
            "CA1031:Do not catch general exception types",
            Justification = "Not silent: the fault is recorded and logged by RunProgressDisplay.ShowAsync, and the "
                + "line itself is still written, to stderr. This runs inside a log call, which must never fail."
        )]
        public bool TryWriteAbove(string line)
        {
            lock (_gate)
            {
                if (_fault is not null)
                {
                    return false;
                }
            }

            try
            {
                // Text, not markup: a log record is never interpreted. Written through the same
                // console as the display, so Spectre places it above the region and redraws the
                // region beneath it.
                _terminal.Write(new Text(line + "\n"));

                return true;
            }
            catch (Exception exception)
            {
                Record(exception);

                return false;
            }
        }

        private void Record(Exception exception)
        {
            lock (_gate)
            {
                _fault ??= exception;
            }
        }

        private string Describe(int completed, long total, int failed, int errored) =>
            string.Create(
                CultureInfo.InvariantCulture,
                $"{completed}/{total} runs, {failed} fail, {errored} error - suite '{_suite}'"
            );
    }
}
