using System.Globalization;
using System.Text.RegularExpressions;
using FluentAssertions;
using Forge.EvalCli.Diagnostics;
using Forge.EvalCli.Tests.Support;
using Forge.EvalEngine.Coordination;
using Forge.EvalEngine.Results;

namespace Forge.EvalCli.Tests.Diagnostics;

public partial class StreamedRunProgressTests
{
    private const string Start = "eval-cli: starting suite 'regression' - 3 run(s) planned across 2 scenario(s).";

    private static readonly Forge.EvalEngine.Scenarios.Suite Suite = ProgressFixture.Suite(
        "regression",
        ("checkout", 2),
        ("billing", 1)
    );

    private static string[] Lines(StringWriter stderr) =>
        stderr.ToString().Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries);

    [Fact]
    public async Task ShowAsync_BeforeTheFirstRunCompletes_HasAlreadyWrittenTheStartLine()
    {
        using var stderr = new StringWriter();
        using var diagnostics = new DiagnosticsWriter(stderr);
        using var log = new StringWriter();
        string? beforeAnyReport = null;

        await new StreamedRunProgress(diagnostics).ShowAsync(
            Suite,
            ProgressFixture.Logger(log),
            ProgressFixture.Reporting("regression", _ => beforeAnyReport = stderr.ToString()),
            CancellationToken.None
        );

        // Read from inside the suite, before it reported anything: the window this line exists for.
        beforeAnyReport.Should().Be(Start + Environment.NewLine);
    }

    [Fact]
    public async Task Report_ForEachCompletedRun_WritesOneLineNamingTheRunAndItsVerdict()
    {
        using var stderr = new StringWriter();
        using var diagnostics = new DiagnosticsWriter(stderr);
        using var log = new StringWriter();

        await new StreamedRunProgress(diagnostics).ShowAsync(
            Suite,
            ProgressFixture.Logger(log),
            ProgressFixture.Reporting(
                "regression",
                null,
                ProgressFixture.Report(1, 3, "checkout", 1, RunStatus.Pass),
                ProgressFixture.Report(2, 3, "checkout", 2, RunStatus.Fail),
                ProgressFixture.Report(3, 3, "billing", 1, RunStatus.Error)
            ),
            CancellationToken.None
        );

        Lines(stderr)
            .Should()
            .Equal(
                Start,
                "eval-cli: [1/3] scenario 'checkout' repetition 1: pass",
                "eval-cli: [2/3] scenario 'checkout' repetition 2: fail",
                "eval-cli: [3/3] scenario 'billing' repetition 1: error"
            );
        log.ToString().Should().BeEmpty();
    }

    [Fact]
    public async Task Report_WhenCountsArriveOutOfOrder_ShowsTheGreatestCountSeenRatherThanTheLatest()
    {
        using var stderr = new StringWriter();
        using var diagnostics = new DiagnosticsWriter(stderr);
        using var log = new StringWriter();

        // Above one run in flight, the worker that counted one can call after the one that counted two.
        await new StreamedRunProgress(diagnostics).ShowAsync(
            Suite,
            ProgressFixture.Logger(log),
            ProgressFixture.Reporting(
                "regression",
                null,
                ProgressFixture.Report(2, 3, "checkout", 2),
                ProgressFixture.Report(1, 3, "checkout", 1),
                ProgressFixture.Report(3, 3, "billing", 1)
            ),
            CancellationToken.None
        );

        Lines(stderr)
            .Skip(1)
            .Should()
            .Equal(
                "eval-cli: [2/3] scenario 'checkout' repetition 2: pass",
                "eval-cli: [2/3] scenario 'checkout' repetition 1: pass",
                "eval-cli: [3/3] scenario 'billing' repetition 1: pass"
            );
    }

    [Fact]
    public async Task Report_FromConcurrentWorkers_WritesOneWholeLinePerRunAndNeverCountsBackwards()
    {
        const int Total = 400;
        using var stderr = new StringWriter();
        using var diagnostics = new DiagnosticsWriter(stderr);
        using var log = new StringWriter();

        var reports = Enumerable
            .Range(1, Total)
            .Select(completed => ProgressFixture.Report(completed, Total, "checkout", completed))
            .OrderBy(_ => Random.Shared.Next())
            .ToArray();

        await new StreamedRunProgress(diagnostics).ShowAsync(
            ProgressFixture.Suite("regression", ("checkout", Total)),
            ProgressFixture.Logger(log),
            sink =>
            {
                Parallel.ForEach(reports, new ParallelOptions { MaxDegreeOfParallelism = 8 }, sink!.Report);

                return Task.FromResult(ProgressFixture.Result("regression"));
            },
            CancellationToken.None
        );

        var counts = Lines(stderr)
            .Skip(1)
            .Select(line => Count().Match(line))
            .Select(match => match.Success ? int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture) : -1)
            .ToArray();

        counts.Should().HaveCount(Total).And.NotContain(-1, "every line is whole and well formed");
        counts.Should().BeInAscendingOrder("the greatest count seen never decreases");
        counts[^1].Should().Be(Total);
    }

    [Fact]
    public async Task ShowAsync_ForASecondSuite_CountsFromItsOwnStartRatherThanTheFirstSuitesEnd()
    {
        using var stderr = new StringWriter();
        using var diagnostics = new DiagnosticsWriter(stderr);
        using var log = new StringWriter();
        var display = new StreamedRunProgress(diagnostics);

        await display.ShowAsync(
            Suite,
            ProgressFixture.Logger(log),
            ProgressFixture.Reporting("regression", null, ProgressFixture.Report(3, 3)),
            CancellationToken.None
        );
        await display.ShowAsync(
            ProgressFixture.Suite("second", ("checkout", 1)),
            ProgressFixture.Logger(log),
            ProgressFixture.Reporting("second", null, ProgressFixture.Report(1, 1)),
            CancellationToken.None
        );

        Lines(stderr)[^1].Should().Be("eval-cli: [1/1] scenario 'checkout' repetition 1: pass");
    }

    [Fact]
    public async Task Report_ForAScenarioNamedForAMachine_NetsThePathOutOfTheLine()
    {
        using var stderr = new StringWriter();
        using var diagnostics = new DiagnosticsWriter(stderr);
        using var log = new StringWriter();

        // ADR 0005 admits a leading request method, so this id loads — and this line reaches the build log.
        await new StreamedRunProgress(diagnostics).ShowAsync(
            ProgressFixture.Suite("regression", ("GET /home/ci-runner/work", 1)),
            ProgressFixture.Logger(log),
            ProgressFixture.Reporting("regression", null, ProgressFixture.Report(1, 1, "GET /home/ci-runner/work")),
            CancellationToken.None
        );

        var line = Lines(stderr)[^1];

        line.Should().StartWith("eval-cli: [1/1] scenario 'GET [path-redacted:");
        line.Should().NotContain("/home/ci-runner/work");
    }

    [Fact]
    public async Task ShowAsync_ForASuiteWithNothingPlanned_WritesNothingAndConductsWithoutASink()
    {
        using var stderr = new StringWriter();
        using var diagnostics = new DiagnosticsWriter(stderr);
        using var log = new StringWriter();
        var sinks = new List<IProgress<RunProgress>?>();

        await new StreamedRunProgress(diagnostics).ShowAsync(
            ProgressFixture.Suite("regression"),
            ProgressFixture.Logger(log),
            ProgressFixture.Reporting("regression", sinks.Add),
            CancellationToken.None
        );

        sinks.Should().ContainSingle().Which.Should().BeNull();
        stderr.ToString().Should().BeEmpty();
    }

    [Fact]
    public async Task ShowAsync_WhenCancelledWhileTheStartLineIsStalled_FinishesThatLineThenStartsNoSuite()
    {
        using var destination = new StallingWriter();
        using var diagnostics = new DiagnosticsWriter(destination);
        using var log = new StringWriter();
        using var cancellation = new CancellationTokenSource();
        var started = 0;

        var showing = new StreamedRunProgress(diagnostics).ShowAsync(
            Suite,
            ProgressFixture.Logger(log),
            _ =>
            {
                started++;

                return Task.FromResult(ProgressFixture.Result("regression"));
            },
            cancellation.Token
        );

        destination.Entered.Wait(TimeSpan.FromSeconds(10)).Should().BeTrue("the start line is being written");

        await cancellation.CancelAsync();

        // The limitation, pinned rather than hidden: a write already under way is not interrupted.
        // A console stream is written synchronously, and nothing a token does reaches into that.
        var first = await Task.WhenAny(showing, Task.Delay(TimeSpan.FromMilliseconds(300)));

        first.Should().NotBeSameAs(showing, "the stalled write is still in progress");

        destination.Release.Set();

        var act = () => showing;

        await act.Should().ThrowAsync<OperationCanceledException>();
        started.Should().Be(0, "a Ctrl+C while the start line was stalled is not a request to begin the suite");
        destination.Text.Should().Be(Start + Environment.NewLine, "the line in progress was finished, whole");
        log.ToString().Should().BeEmpty("cancellation is not a fault in the display");
    }

    [GeneratedRegex(@"^eval-cli: \[(\d+)/400\] scenario 'checkout' repetition \d+: pass$")]
    private static partial Regex Count();

    /// <summary>A destination whose writes block until released, the way a write to a full pipe blocks.</summary>
    private sealed class StallingWriter : TextWriter
    {
        private readonly System.Text.StringBuilder _text = new();

        /// <summary>Gets the signal that a write has started and is now blocked.</summary>
        public ManualResetEventSlim Entered { get; } = new(false);

        /// <summary>Gets the signal that lets blocked writes finish.</summary>
        public ManualResetEventSlim Release { get; } = new(false);

        public override System.Text.Encoding Encoding => System.Text.Encoding.UTF8;

        public string Text
        {
            get
            {
                lock (_text)
                {
                    return _text.ToString();
                }
            }
        }

        public override void Write(char value) => Write(value.ToString());

        public override void Write(string? value)
        {
            Entered.Set();

            // Bounded, so a test that never releases fails instead of hanging the run.
            Release.Wait(TimeSpan.FromSeconds(30));

            lock (_text)
            {
                _text.Append(value);
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                Entered.Dispose();
                Release.Dispose();
            }

            base.Dispose(disposing);
        }
    }
}
