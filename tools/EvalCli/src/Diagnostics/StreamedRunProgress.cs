using System.Globalization;
using Forge.EvalCli.Cli;
using Forge.EvalEngine.Coordination;

namespace Forge.EvalCli.Diagnostics;

/// <summary>
/// Progress as plain lines on standard error: a start line, then one line per completed run.
/// </summary>
/// <remarks>
/// <para>
/// For a stream that is not a terminal — a file, a pipe, a CI log. Nothing is drawn over anything
/// and no escape code is written, so every line reads the same in a log viewer as it did when it
/// was written.
/// </para>
/// <para>
/// <b>Each line is written inside the engine's <see cref="IProgress{T}.Report(T)"/> call.</b>
/// That is the one place a fault is contained: an exception from the write propagates out of the
/// call, the engine logs it as a warning, and the suite goes on. A line is one short write, so the
/// worker making the call is held for no longer than the log record it would have written anyway.
/// </para>
/// </remarks>
internal sealed class StreamedRunProgress : RunProgressDisplay
{
    private readonly DiagnosticsWriter _lines;

    /// <summary>Initializes a new instance of the <see cref="StreamedRunProgress"/> class.</summary>
    /// <param name="lines">Where the lines are written, alongside every other diagnostic.</param>
    /// <exception cref="ArgumentNullException"><paramref name="lines"/> is null.</exception>
    public StreamedRunProgress(DiagnosticsWriter lines)
    {
        ArgumentNullException.ThrowIfNull(lines);

        _lines = lines;
    }

    /// <summary>The line written before anything is dispatched.</summary>
    /// <param name="outline">The suite.</param>
    /// <returns>The line.</returns>
    /// <remarks>
    /// <para>
    /// Nothing is reported until the first run completes, which for a slow system under test is
    /// the whole of the first run. Without this, that is exactly the silence the display exists to
    /// remove.
    /// </para>
    /// <para>
    /// It states the plan rather than claiming the suite is running, because it is written before
    /// the engine settles that plan and the engine may still refuse it — a suite over its run
    /// budget is refused before anything is dispatched, and its refusal follows this line.
    /// </para>
    /// <para>
    /// <b>A live baseline's suite says so, and says where.</b> It is the same suite with the same
    /// plan, so unlabelled its start line would read exactly like the candidate's. The address is
    /// <see cref="SuiteOutline.Baseline"/>, the printable form, and it is named here rather than on
    /// every line: this one is written once.
    /// </para>
    /// </remarks>
    internal static string StartLine(SuiteOutline outline) =>
        string.Create(
            CultureInfo.InvariantCulture,
            $"eval-cli: starting {Role(outline)}suite '{outline.Name}'{Against(outline)} - {outline.PlannedRuns} run(s) planned across {outline.Scenarios} scenario(s)."
        );

    /// <summary>The line for one completed run.</summary>
    /// <param name="outline">The suite the run belongs to.</param>
    /// <param name="greatest">The greatest completed count reported so far, this run's included.</param>
    /// <param name="report">The run.</param>
    /// <returns>The line.</returns>
    /// <remarks>
    /// The scenario id is author text, so it goes through the same net as every other value on
    /// stderr: a scenario named <c>GET /home/ci-runner/work</c> loads by design (ADR 0005), and this
    /// line reaches the build log.
    /// </remarks>
    internal static string Line(SuiteOutline outline, int greatest, RunProgress report) =>
        string.Create(
            CultureInfo.InvariantCulture,
            $"eval-cli: [{greatest}/{report.Total}] {Role(outline)}scenario '{MarkdownReport.Sanitize(report.ScenarioId, MarkdownReport.MaxIdentifierCharacters)}' repetition {report.Repetition}: {RunReport.Name(report.Status)}"
        );

    /// <inheritdoc/>
    protected override async Task RenderAsync(
        SuiteOutline outline,
        Func<IProgress<RunProgress>, Task> conduct,
        CancellationToken cancellationToken
    )
    {
        ArgumentNullException.ThrowIfNull(outline);
        ArgumentNullException.ThrowIfNull(conduct);

        // The token reaches the write and stops it if it has not started. It cannot stop one that
        // has — see DiagnosticsWriter.WriteLineAsync — which is why the base class asks it again
        // before the suite is started.
        await _lines.WriteLineAsync(StartLine(outline).AsMemory(), cancellationToken).ConfigureAwait(false);

        await SettleAsync(conduct(new Sink(_lines, outline))).ConfigureAwait(false);
    }

    /// <summary>
    /// <c>baseline </c> for a live baseline's suite. Nothing for the candidate, whose lines read as
    /// they did before a second suite could be shown.
    /// </summary>
    private static string Role(SuiteOutline outline) => outline.Baseline is null ? string.Empty : "baseline ";

    /// <summary>Where a live baseline's suite is conducted. Nothing for the candidate.</summary>
    private static string Against(SuiteOutline outline) =>
        outline.Baseline is { } address ? " against " + address : string.Empty;

    /// <summary>The sink for one suite: its own greatest count, so suites cannot share one.</summary>
    private sealed class Sink(DiagnosticsWriter lines, SuiteOutline outline) : IProgress<RunProgress>
    {
        private readonly object _gate = new();
        private int _greatest;

        /// <summary>Writes the line for one completed run.</summary>
        /// <remarks>
        /// <b>The greatest count seen, never the latest.</b> Above one run in flight, a worker that
        /// counted seven can make its call after the one that counted eight; printing the latest
        /// would make the count go backwards. Taken and written under one lock, so the counts on
        /// successive lines never decrease.
        /// </remarks>
        public void Report(RunProgress value)
        {
            ArgumentNullException.ThrowIfNull(value);

            lock (_gate)
            {
                _greatest = Math.Max(_greatest, value.Completed);
                lines.WriteLine(Line(outline, _greatest, value));
            }
        }
    }
}
