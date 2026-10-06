using System.Diagnostics;
using System.Text.RegularExpressions;
using FluentAssertions;
using Forge.EvalCli.Diagnostics;
using Forge.EvalCli.Tests.Support;
using Forge.EvalEngine.Coordination;
using Forge.EvalEngine.Results;

namespace Forge.EvalCli.Tests.Diagnostics;

public partial class LiveRunProgressTests
{
    /// <summary>Long enough that the loop never ticks inside a test, so every frame is one the test caused.</summary>
    private static readonly TimeSpan Never = TimeSpan.FromHours(1);

    private static readonly Forge.EvalEngine.Scenarios.Suite Suite = ProgressFixture.Suite(
        "regression",
        ("checkout", 2),
        ("billing", 1)
    );

    private static string LastFrame(string output) => Frame().Matches(output).Last().Value;

    [Fact]
    public async Task ShowAsync_BeforeTheFirstRunCompletes_HasAlreadyDrawnTheBarAtZero()
    {
        using var terminal = new FakeTerminal(isTerminal: true);
        using var stderr = new StringWriter();
        using var diagnostics = new DiagnosticsWriter(stderr);
        using var log = new StringWriter();
        string? beforeAnyReport = null;

        await new LiveRunProgress(terminal.Console(), diagnostics, Never).ShowAsync(
            Suite,
            ProgressFixture.Logger(log),
            ProgressFixture.Reporting("regression", _ => beforeAnyReport = terminal.Output),
            CancellationToken.None
        );

        beforeAnyReport.Should().Contain("0/3 runs, 0 fail, 0 error - suite 'regression'");
    }

    [Fact]
    public async Task Report_DrawsNothingOnTheWorkerThatMadeTheCall()
    {
        using var terminal = new FakeTerminal(isTerminal: true);
        using var stderr = new StringWriter();
        using var diagnostics = new DiagnosticsWriter(stderr);
        using var log = new StringWriter();
        string? rightAfterTheCall = null;

        await new LiveRunProgress(terminal.Console(), diagnostics, Never).ShowAsync(
            Suite,
            ProgressFixture.Logger(log),
            sink =>
            {
                sink!.Report(ProgressFixture.Report(1, 3));
                rightAfterTheCall = terminal.Output;

                return Task.FromResult(ProgressFixture.Result("regression"));
            },
            CancellationToken.None
        );

        // A redraw costs a real console about 0.64 ms, and the worker starts nothing until the call returns.
        rightAfterTheCall.Should().NotContain("1/3 runs");

        // The positive control: the same harness sees the count once something has drawn it.
        terminal.Output.Should().Contain("1/3 runs");
    }

    [Fact]
    public async Task ShowAsync_WhileTheSuiteRuns_RedrawsAStaleFrameWithinTheRefreshInterval()
    {
        using var terminal = new FakeTerminal(isTerminal: true);
        using var stderr = new StringWriter();
        using var diagnostics = new DiagnosticsWriter(stderr);
        using var log = new StringWriter();
        var drawnWhileRunning = false;

        await new LiveRunProgress(terminal.Console(), diagnostics, TimeSpan.FromMilliseconds(10)).ShowAsync(
            Suite,
            ProgressFixture.Logger(log),
            async sink =>
            {
                sink!.Report(ProgressFixture.Report(1, 3));

                var waited = Stopwatch.StartNew();

                while (!terminal.Output.Contains("1/3 runs") && waited.Elapsed < TimeSpan.FromSeconds(10))
                {
                    await Task.Delay(10);
                }

                drawnWhileRunning = terminal.Output.Contains("1/3 runs");

                return ProgressFixture.Result("regression");
            },
            CancellationToken.None
        );

        // Drawn by the loop, not at teardown: the suite had not returned when this was seen.
        drawnWhileRunning.Should().BeTrue();
    }

    [Fact]
    public async Task ShowAsync_WhileItsOwnLoopIsIdle_IsRedrawnByNothingElse()
    {
        using var terminal = new FakeTerminal(isTerminal: true);
        using var stderr = new StringWriter();
        using var diagnostics = new DiagnosticsWriter(stderr);
        using var log = new StringWriter();
        string? atStart = null;
        string? later = null;

        // Spectre's own auto-refresh draws on a thread with no catch, where a fault terminates the
        // process. The positive control is the test above: this harness does see a loop's redraws.
        await new LiveRunProgress(terminal.Console(), diagnostics, Never).ShowAsync(
            Suite,
            ProgressFixture.Logger(log),
            async _ =>
            {
                atStart = terminal.Output;
                await Task.Delay(TimeSpan.FromMilliseconds(400));
                later = terminal.Output;

                return ProgressFixture.Result("regression");
            },
            CancellationToken.None
        );

        later.Should().Be(atStart, "four of Spectre's default refresh intervals passed and nothing may have drawn");
    }

    [Fact]
    public async Task ShowAsync_WhenCountsArriveOutOfOrder_EndsOnTheGreatestCountSeen()
    {
        using var terminal = new FakeTerminal(isTerminal: true);
        using var stderr = new StringWriter();
        using var diagnostics = new DiagnosticsWriter(stderr);
        using var log = new StringWriter();

        await new LiveRunProgress(terminal.Console(), diagnostics, Never).ShowAsync(
            Suite,
            ProgressFixture.Logger(log),
            ProgressFixture.Reporting(
                "regression",
                null,
                ProgressFixture.Report(2, 3, "checkout", 2, RunStatus.Fail),
                ProgressFixture.Report(1, 3, "checkout", 1, RunStatus.Error)
            ),
            CancellationToken.None
        );

        LastFrame(terminal.Output).Should().Be("2/3 runs, 1 fail, 1 error");
    }

    [Fact]
    public async Task ShowAsync_ForASuiteNameThatReadsAsMarkup_DrawsItLiterallyAndNetted()
    {
        using var terminal = new FakeTerminal(isTerminal: true);
        using var stderr = new StringWriter();
        using var diagnostics = new DiagnosticsWriter(stderr);
        using var log = new StringWriter();

        // Both shapes are markup to Spectre: an author's brackets, and the net's own alias.
        await new LiveRunProgress(terminal.Console(), diagnostics, Never).ShowAsync(
            ProgressFixture.Suite("[red]x[/] GET /home/ci-runner/work", ("checkout", 1)),
            ProgressFixture.Logger(log),
            ProgressFixture.Reporting("regression", null, ProgressFixture.Report(1, 1)),
            CancellationToken.None
        );

        terminal.Output.Should().Contain("suite '[red]x[/] GET [path-redacted:");
        terminal.Output.Should().NotContain("/home/ci-runner/work");
        log.ToString().Should().BeEmpty("drawing the name was not a fault");
    }

    [Fact]
    public async Task ShowAsync_WhileTheDisplayIsUp_DrawsDiagnosticsAboveItInsteadOfBeneathIt()
    {
        using var terminal = new FakeTerminal(isTerminal: true);
        using var stderr = new StringWriter();
        using var diagnostics = new DiagnosticsWriter(stderr);
        using var log = new StringWriter();

        await new LiveRunProgress(terminal.Console(), diagnostics, Never).ShowAsync(
            Suite,
            ProgressFixture.Logger(log),
            ProgressFixture.Reporting(
                "regression",
                _ => diagnostics.WriteLine("fail: a record written while the display is up"),
                ProgressFixture.Report(1, 3)
            ),
            CancellationToken.None
        );

        await diagnostics.WriteLineAsync("fail: a record written after it is down");

        var output = terminal.Output;
        var record = output.IndexOf("fail: a record written while the display is up", StringComparison.Ordinal);

        // Through Spectre, which writes the record and then redraws the region beneath it.
        record.Should().BeGreaterThan(-1);
        output.IndexOf(" runs, ", record, StringComparison.Ordinal).Should().BeGreaterThan(record);
        stderr.ToString().Should().NotContain("while the display is up");

        // The positive control: once the display is down, the same writer reaches stderr again.
        stderr.ToString().Should().Be("fail: a record written after it is down" + Environment.NewLine);
        output.Should().NotContain("after it is down");
    }

    [Fact]
    public async Task ShowAsync_WhenTheTerminalFailsMidRun_ReturnsTheSuitesResultLosesNoRecordAndWarnsOnce()
    {
        using var terminal = new FakeTerminal(isTerminal: true);
        using var stderr = new StringWriter();
        using var diagnostics = new DiagnosticsWriter(stderr);
        using var log = new StringWriter();
        var result = ProgressFixture.Result("regression");

        var returned = await new LiveRunProgress(terminal.Console(), diagnostics, Never).ShowAsync(
            Suite,
            ProgressFixture.Logger(log),
            async sink =>
            {
                terminal.Fail();
                sink!.Report(ProgressFixture.Report(1, 3));
                await diagnostics.WriteLineAsync("fail: a record the display can no longer draw");

                return result;
            },
            CancellationToken.None
        );

        returned.Should().BeSameAs(result);
        stderr.ToString().Should().Contain("fail: a record the display can no longer draw");

        var warnings = log.ToString().Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries);

        warnings.Should().ContainSingle().Which.Should().StartWith("warn: ").And.Contain("(IOException)");
    }

    [Fact]
    public async Task ShowAsync_WhenTheTerminalFailsBeforeTheSuiteStarts_ConductsTheSuiteOnceWithoutIt()
    {
        using var terminal = new FakeTerminal(isTerminal: true);
        using var stderr = new StringWriter();
        using var diagnostics = new DiagnosticsWriter(stderr);
        using var log = new StringWriter();
        var sinks = new List<IProgress<RunProgress>?>();
        var result = ProgressFixture.Result("regression");

        terminal.Fail();

        var returned = await new LiveRunProgress(terminal.Console(), diagnostics, Never).ShowAsync(
            Suite,
            ProgressFixture.Logger(log),
            sink =>
            {
                sinks.Add(sink);

                return Task.FromResult(result);
            },
            CancellationToken.None
        );

        returned.Should().BeSameAs(result);
        sinks.Should().ContainSingle().Which.Should().BeNull("the display never started, so nothing was attached");
        log.ToString().Should().Contain("warn: ").And.Contain("(IOException)");
    }

    [Fact]
    public async Task ShowAsync_WhenTheSuiteIsCancelled_RethrowsTheCancellationAndGivesTheCursorBack()
    {
        using var terminal = new FakeTerminal(isTerminal: true);
        using var stderr = new StringWriter();
        using var diagnostics = new DiagnosticsWriter(stderr);
        using var log = new StringWriter();

        var act = () =>
            new LiveRunProgress(terminal.Console(), diagnostics, Never).ShowAsync(
                Suite,
                ProgressFixture.Logger(log),
                sink =>
                {
                    sink!.Report(ProgressFixture.Report(1, 3));

                    return Task.FromCanceled<SuiteResult>(new CancellationToken(canceled: true));
                },
                CancellationToken.None
            );

        await act.Should().ThrowAsync<OperationCanceledException>();

        // Where it stopped is left on screen, and Spectre's hidden cursor is shown again.
        LastFrame(terminal.Output).Should().Be("1/3 runs, 0 fail, 0 error");
        terminal.Output.Should().EndWith("\u001b[?25h");
        log.ToString().Should().BeEmpty();
    }

    [Fact]
    public async Task ShowAsync_WhenCancelledWhileTheDisplayIsStarting_StartsNoSuiteAndGivesTheCursorBack()
    {
        using var cancellation = new CancellationTokenSource();

        // Cancelled inside Spectre's first write — hiding the cursor as the display starts — so the
        // test lands in that window exactly rather than racing it.
        using var terminal = new FakeTerminal(isTerminal: true, onFirstWrite: cancellation.Cancel);
        using var stderr = new StringWriter();
        using var diagnostics = new DiagnosticsWriter(stderr);
        using var log = new StringWriter();
        var started = 0;

        var act = () =>
            new LiveRunProgress(terminal.Console(), diagnostics, TimeSpan.FromMilliseconds(10)).ShowAsync(
                Suite,
                ProgressFixture.Logger(log),
                _ =>
                {
                    started++;

                    return Task.FromResult(ProgressFixture.Result("regression"));
                },
                cancellation.Token
            );

        await act.Should().ThrowAsync<OperationCanceledException>();
        started.Should().Be(0);
        log.ToString().Should().BeEmpty("cancellation is not a fault in the display");
        terminal.Output.Should().EndWith("\u001b[?25h", "a display that was cancelled starting still shows the cursor");
    }

    [GeneratedRegex(@"\d+/\d+ runs, \d+ fail, \d+ error")]
    private static partial Regex Frame();
}
