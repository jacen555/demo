using FluentAssertions;
using Forge.EvalCli.Diagnostics;
using Forge.EvalCli.Tests.Support;
using Forge.EvalEngine.Coordination;
using Forge.EvalEngine.Results;
using Spectre.Console;

namespace Forge.EvalCli.Tests.Diagnostics;

public class RunProgressDisplayTests
{
    private static readonly Forge.EvalEngine.Scenarios.Suite Suite = ProgressFixture.Suite(
        "regression",
        ("checkout", 1)
    );

    /// <summary>Conducts a one-run suite through whatever was chosen, and returns both streams.</summary>
    private static async Task<(RunProgressDisplay Chosen, string Terminal, string StandardError)> RenderOneRunAsync(
        FakeTerminal terminal,
        IAnsiConsole console
    )
    {
        using var stderr = new StringWriter();
        using var diagnostics = new DiagnosticsWriter(stderr);
        using var log = new StringWriter();

        var chosen = RunProgressDisplay.Choose(console, diagnostics);

        await chosen.ShowAsync(
            Suite,
            ProgressFixture.Logger(log),
            ProgressFixture.Reporting("regression", null, ProgressFixture.Report(1, 1)),
            CancellationToken.None
        );

        return (chosen, terminal.Output, stderr.ToString());
    }

    // -------------------------------------------------------------------------------------
    // Selection. Each arm is the same harness with one fact changed, so a display that is
    // absent in one is shown to be observable in the other.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task Choose_ForAnInteractiveAnsiTerminal_DrawsInPlaceAndStreamsNoLines()
    {
        using var terminal = new FakeTerminal(isTerminal: true);

        var (chosen, drawn, stderr) = await RenderOneRunAsync(terminal, terminal.Console());

        chosen.Should().BeOfType<LiveRunProgress>();
        drawn.Should().Contain("1/1 runs").And.Contain("\u001b[");
        stderr.Should().BeEmpty();
    }

    [Fact]
    public async Task Choose_WhenStandardErrorIsRedirected_StreamsLinesAndDrawsNothing()
    {
        // Identical to the test above but for the one fact Spectre is asked about the stream.
        using var terminal = new FakeTerminal(isTerminal: false);

        var (chosen, drawn, stderr) = await RenderOneRunAsync(terminal, terminal.Console());

        chosen.Should().BeOfType<StreamedRunProgress>();
        drawn.Should().BeEmpty("no escape code may reach a file or a pipe");
        stderr.Should().Contain("eval-cli: [1/1] scenario 'checkout' repetition 1: pass");
    }

    [Fact]
    public async Task Choose_InCi_StreamsLinesEvenWhereTheStreamLooksLikeATerminal()
    {
        using var terminal = new FakeTerminal(isTerminal: true);
        var ci = terminal.Console(environment: new Dictionary<string, string> { ["GITHUB_ACTIONS"] = "true" });

        var (chosen, drawn, stderr) = await RenderOneRunAsync(terminal, ci);

        // Spectre's own CI enricher, not a list of ours: it clears Interactive for the build system.
        ci.Profile.Capabilities.Interactive.Should().BeFalse();
        chosen.Should().BeOfType<StreamedRunProgress>();
        drawn.Should().BeEmpty();
        stderr.Should().Contain("eval-cli: [1/1]");
    }

    [Theory]
    [InlineData(true, true, true, true)]
    [InlineData(false, true, true, false)]
    [InlineData(true, false, true, false)]
    [InlineData(true, true, false, false)]
    public void CanDrawLive_RequiresATerminalAnInteractiveSessionAndAnsi(
        bool isTerminal,
        bool interactive,
        bool ansi,
        bool expected
    )
    {
        // Spectre's own progress display asks only the last two. Under Git Bash with stderr sent to a
        // file both are true — measured — so the first is what keeps escape codes out of the file.
        var console = new FakeTerminal(isTerminal).Console(interactive, ansi);

        RunProgressDisplay.CanDrawLive(console.Profile).Should().Be(expected);
    }

    [Fact]
    public void For_AnyConsoleButTheProcessOwn_StreamsLines()
    {
        using var console = new RecordingConsole();
        using var diagnostics = new DiagnosticsWriter(new StringWriter());

        RunProgressDisplay.For(console, diagnostics).Should().BeOfType<StreamedRunProgress>();
    }

    // -------------------------------------------------------------------------------------
    // Cancellation. The caller's Ctrl+C is not a fault in the display, and a suite the caller
    // has cancelled is never started by one.
    // -------------------------------------------------------------------------------------

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ShowAsync_WhenAlreadyCancelled_ShowsNothingAndStartsNoSuite(bool isTerminal)
    {
        // Both paths, through the same choice the tool makes. Every other test in this class shows
        // this harness does observe a start line on one and a bar on the other.
        using var terminal = new FakeTerminal(isTerminal);
        using var stderr = new StringWriter();
        using var diagnostics = new DiagnosticsWriter(stderr);
        using var log = new StringWriter();
        var started = 0;

        var act = () =>
            RunProgressDisplay
                .Choose(terminal.Console(), diagnostics)
                .ShowAsync(
                    Suite,
                    ProgressFixture.Logger(log),
                    _ =>
                    {
                        started++;

                        return Task.FromResult(ProgressFixture.Result("regression"));
                    },
                    new CancellationToken(canceled: true)
                );

        await act.Should().ThrowAsync<OperationCanceledException>();
        started.Should().Be(0);
        terminal.Output.Should().BeEmpty();
        stderr.ToString().Should().BeEmpty();
        log.ToString().Should().BeEmpty("cancellation is not a fault in the display");
    }

    [Fact]
    public async Task ShowAsync_WhenCancelledBeforeTheDisplayAsksForTheSuite_StartsNoSuiteAndLogsNoFault()
    {
        using var log = new StringWriter();
        using var cancellation = new CancellationTokenSource();
        var started = 0;

        // Whatever a display does before it asks for the suite — draw, write, block on a stalled
        // stream — a Ctrl+C that arrived meanwhile is honoured at the moment it asks.
        var display = new ScriptedDisplay(async conduct =>
        {
            await cancellation.CancelAsync();
            await conduct(NoSink.Instance);
        });

        var act = () =>
            display.ShowAsync(
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
    }

    // -------------------------------------------------------------------------------------
    // Containment. A display is never allowed to cost the user a run.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task ShowAsync_WhenTheDisplayFailsBeforeStartingTheSuite_ConductsItOnceWithoutTheDisplay()
    {
        using var log = new StringWriter();
        var sinks = new List<IProgress<RunProgress>?>();
        var result = ProgressFixture.Result("regression");
        var display = new ScriptedDisplay(async _ =>
        {
            await Task.Yield();

            throw new InvalidOperationException("the display broke");
        });

        var returned = await display.ShowAsync(
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
        sinks.Should().ContainSingle().Which.Should().BeNull();
        log.ToString().Should().Contain("warn: ").And.Contain("(InvalidOperationException)");
        log.ToString().Should().NotContain("the display broke", "a fault's message is never quoted");
    }

    [Fact]
    public async Task ShowAsync_WhenTheDisplayFailsAfterTheSuiteFinished_ReturnsTheSuitesResult()
    {
        using var log = new StringWriter();
        var calls = 0;
        var result = ProgressFixture.Result("regression");
        var display = new ScriptedDisplay(async conduct =>
        {
            await conduct(NoSink.Instance);

            throw new IOException("the console went away at teardown");
        });

        var returned = await display.ShowAsync(
            Suite,
            ProgressFixture.Logger(log),
            _ =>
            {
                calls++;

                return Task.FromResult(result);
            },
            CancellationToken.None
        );

        // The finished suite is the user's evidence; a display failing after it must not discard it.
        returned.Should().BeSameAs(result);
        calls.Should().Be(1);
        log.ToString().Should().Contain("(IOException)");
    }

    [Fact]
    public async Task ShowAsync_WhenTheSuiteFails_RethrowsTheSuitesOwnExceptionAndLogsNothing()
    {
        using var stderr = new StringWriter();
        using var diagnostics = new DiagnosticsWriter(stderr);
        using var log = new StringWriter();
        var refusal = new ArgumentException("the suite plans more runs than the budget allows");

        var act = () =>
            new StreamedRunProgress(diagnostics).ShowAsync(
                Suite,
                ProgressFixture.Logger(log),
                _ => Task.FromException<SuiteResult>(refusal),
                CancellationToken.None
            );

        // The same instance: SuiteDiscovery.ConductAsync translates exactly this into a usage error.
        (await act.Should().ThrowAsync<ArgumentException>())
            .Which.Should()
            .BeSameAs(refusal);
        log.ToString().Should().BeEmpty();
    }

    [Fact]
    public async Task ShowAsync_WhenTheSuiteFailsAndTheDisplayFailsUnwinding_RethrowsTheSuitesExceptionAndLogsTheDisplays()
    {
        using var log = new StringWriter();
        var cancelled = new OperationCanceledException();
        var display = new ScriptedDisplay(async conduct =>
        {
            await ScriptedDisplay.Settle(conduct(NoSink.Instance));

            throw new InvalidOperationException("the display broke while the suite was failing");
        });

        var act = () =>
            display.ShowAsync(
                Suite,
                ProgressFixture.Logger(log),
                _ => Task.FromException<SuiteResult>(cancelled),
                CancellationToken.None
            );

        (await act.Should().ThrowAsync<OperationCanceledException>()).Which.Should().BeSameAs(cancelled);
        log.ToString().Should().Contain("(InvalidOperationException)");
    }

    [Fact]
    public async Task ShowAsync_WhenADisplayAsksForTheSuiteTwice_ConductsItOnce()
    {
        using var log = new StringWriter();
        var calls = 0;
        var display = new ScriptedDisplay(async conduct =>
        {
            await conduct(NoSink.Instance);
            await conduct(NoSink.Instance);
        });

        await display.ShowAsync(
            Suite,
            ProgressFixture.Logger(log),
            _ =>
            {
                calls++;

                return Task.FromResult(ProgressFixture.Result("regression"));
            },
            CancellationToken.None
        );

        calls.Should().Be(1, "a second conduct would be a second load on somebody else's system");
        log.ToString().Should().Contain("(InvalidOperationException)");
    }

    [Fact]
    public async Task ShowAsync_WhenADisplayNeverStartsTheSuite_StillConductsIt()
    {
        using var log = new StringWriter();
        var sinks = new List<IProgress<RunProgress>?>();
        var display = new ScriptedDisplay(_ => Task.CompletedTask);

        await display.ShowAsync(
            Suite,
            ProgressFixture.Logger(log),
            ProgressFixture.Reporting("regression", sinks.Add),
            CancellationToken.None
        );

        sinks.Should().ContainSingle().Which.Should().BeNull();
    }

    [Fact]
    public async Task ShowAsync_WhenNothingIsPlanned_ConductsWithoutRendering()
    {
        using var log = new StringWriter();
        var sinks = new List<IProgress<RunProgress>?>();
        var display = new ScriptedDisplay(_ => throw new InvalidOperationException("must not be reached"));

        await display.ShowAsync(
            ProgressFixture.Suite("regression"),
            ProgressFixture.Logger(log),
            ProgressFixture.Reporting("regression", sinks.Add),
            CancellationToken.None
        );

        display.Renders.Should().Be(0);
        sinks.Should().ContainSingle().Which.Should().BeNull();
    }

    // -------------------------------------------------------------------------------------
    // The result is the caller's. A display hands back what the suite returned, untouched.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task ShowAsync_WhenTheSuiteReturnsNull_HandsTheNullBackForTheCallerToJudge()
    {
        // A live baseline's provider is typed to return null. What that would mean — a missing
        // baseline, not a clean comparison — is decided by the one caller that asked for it, so the
        // display neither replaces it nor takes it for a fault of its own.
        using var stderr = new StringWriter();
        using var diagnostics = new DiagnosticsWriter(stderr);
        using var log = new StringWriter();

        var returned = await new StreamedRunProgress(diagnostics).ShowAsync<SuiteResult?>(
            SuiteOutline.OfBaseline(Suite, "http://localhost:1/<redacted>"),
            ProgressFixture.Logger(log),
            sink =>
            {
                sink?.Report(ProgressFixture.Report(1, 1));

                return Task.FromResult<SuiteResult?>(null);
            },
            CancellationToken.None
        );

        returned.Should().BeNull();
        log.ToString().Should().BeEmpty("a null result is not a fault in the display");

        // The positive control: the display was up, and drew its start line and the run.
        stderr.ToString().Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries).Should().HaveCount(2);
    }

    [Fact]
    public async Task ShowAsync_GivenASuite_DrawsExactlyWhatItsOutlineDraws()
    {
        // The overload the candidate has always been shown through is the outline overload given
        // SuiteOutline.Of, and nothing more.
        using var log = new StringWriter();
        var suite = ProgressFixture.Suite("regression", ("checkout", 2), ("billing", 1));
        var reports = new[]
        {
            ProgressFixture.Report(2, 3, "checkout", 2, RunStatus.Fail),
            ProgressFixture.Report(1, 3, "checkout", 1),
            ProgressFixture.Report(3, 3, "billing", 1, RunStatus.Error),
        };

        static async Task<string> DrawnAsync(Func<RunProgressDisplay, Task> show)
        {
            using var stderr = new StringWriter();
            using var diagnostics = new DiagnosticsWriter(stderr);

            await show(new StreamedRunProgress(diagnostics));

            return stderr.ToString();
        }

        var viaSuite = await DrawnAsync(display =>
            display.ShowAsync(
                suite,
                ProgressFixture.Logger(log),
                ProgressFixture.Reporting("regression", null, reports),
                CancellationToken.None
            )
        );
        var viaOutline = await DrawnAsync(display =>
            display.ShowAsync(
                SuiteOutline.Of(suite),
                ProgressFixture.Logger(log),
                ProgressFixture.Reporting("regression", null, reports),
                CancellationToken.None
            )
        );

        viaSuite.Should().NotBeEmpty().And.Be(viaOutline);
        log.ToString().Should().BeEmpty();
    }

    /// <summary>A sink that ignores every report, for displays whose drawing is not under test.</summary>
    private sealed class NoSink : IProgress<RunProgress>
    {
        public static readonly NoSink Instance = new();

        public void Report(RunProgress value) { }
    }

    /// <summary>A display whose rendering a test scripts, including how it fails.</summary>
    private sealed class ScriptedDisplay(Func<Func<IProgress<RunProgress>, Task>, Task> render) : RunProgressDisplay
    {
        public int Renders { get; private set; }

        public static Task Settle(Task task) => SettleAsync(task);

        protected override Task RenderAsync(
            SuiteOutline outline,
            Func<IProgress<RunProgress>, Task> conduct,
            CancellationToken cancellationToken
        )
        {
            Renders++;

            return render(conduct);
        }
    }
}
