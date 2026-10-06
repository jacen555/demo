using System.Collections.Concurrent;
using System.Text.Json;
using FluentAssertions;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Composition;
using Forge.EvalCli.Diagnostics;
using Forge.EvalCli.Tests.Support;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Coordination;
using Forge.EvalEngine.Results;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Forge.EvalCli.Tests.Cli;

/// <summary>
/// Progress, end to end: what a suite run writes while it runs, through the real command.
/// </summary>
/// <remarks>
/// <para>
/// <b>The defect these pin was silence.</b> A run printed nothing between being started and its
/// final report, however long the suite took. A test console is not a terminal, so every run here
/// takes the streamed path: a start line, then one line per completed run, on stderr.
/// </para>
/// <para>
/// <b>Stdout is asserted as well as stderr</b>, because the easiest way to add progress is to add
/// it to the stream a caller parses as the result.
/// </para>
/// </remarks>
public class RunProgressReportingTests
{
    private const string StartLine = "eval-cli: starting suite 'regression' - 2 run(s) planned across 2 scenario(s).";

    private static RunPlan Plan(TempWorkspace workspace, StubEndpoint endpoint, bool json = false) =>
        RunPlan.Create(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = workspace.Root,
                Endpoint = endpoint.Address.ToString(),
                RestExchange = "json",
                Json = json,
            }
        );

    private static string[] ProgressLines(string standardError) =>
        standardError
            .Split(Environment.NewLine)
            .Where(line => line.StartsWith("eval-cli: [", StringComparison.Ordinal))
            .ToArray();

    [Fact]
    public async Task ExecuteAsync_WhenASuiteRuns_StreamsAStartLineAndOneLinePerCompletedRunToStandardError()
    {
        using var workspace = new TempWorkspace();
        ComparisonWorkspace.WriteSuite(workspace);
        await using var endpoint = ComparisonWorkspace.Endpoint(ComparisonWorkspace.Billing);
        using var console = new RecordingConsole();

        var code = await RunCommand.ExecuteAsync(Plan(workspace, endpoint), console, CancellationToken.None);

        code.Should().Be(ExitCode.Success, console.StandardError);
        console.StandardError.Should().Contain(StartLine);

        var lines = ProgressLines(console.StandardError);

        lines
            .Should()
            .BeEquivalentTo(
                [
                    "eval-cli: [1/2] scenario 'checkout' repetition 1: pass",
                    "eval-cli: [2/2] scenario 'billing' repetition 1: fail",
                ],
                options => options.WithStrictOrdering(),
                "the default throttle is one run in flight, so the runs complete in suite order"
            );

        console
            .StandardError.IndexOf(StartLine, StringComparison.Ordinal)
            .Should()
            .BeLessThan(console.StandardError.IndexOf(lines[0], StringComparison.Ordinal));
    }

    [Fact]
    public async Task ExecuteAsync_WhenASuiteRuns_KeepsProgressOffStandardOut()
    {
        using var workspace = new TempWorkspace();
        ComparisonWorkspace.WriteSuite(workspace);
        await using var endpoint = ComparisonWorkspace.Endpoint();
        using var console = new RecordingConsole();

        await RunCommand.ExecuteAsync(Plan(workspace, endpoint), console, CancellationToken.None);

        // The positive control for the absence below: progress was written, just not here.
        ProgressLines(console.StandardError).Should().HaveCount(2);
        console.StandardOut.Should().Contain("Run complete").And.NotContain("eval-cli:");
    }

    [Fact]
    public async Task ExecuteAsync_WithJson_LeavesStandardOutParseableWhileProgressGoesToStandardError()
    {
        using var workspace = new TempWorkspace();
        ComparisonWorkspace.WriteSuite(workspace);
        await using var endpoint = ComparisonWorkspace.Endpoint();
        using var console = new RecordingConsole();

        await RunCommand.ExecuteAsync(Plan(workspace, endpoint, json: true), console, CancellationToken.None);

        ProgressLines(console.StandardError).Should().HaveCount(2);

        using var document = JsonDocument.Parse(console.StandardOut);

        document.RootElement.ValueKind.Should().Be(JsonValueKind.Object);
    }

    [Fact]
    public async Task ExecuteAsync_ForADryRun_ReportsNoProgressBecauseNothingRuns()
    {
        using var workspace = new TempWorkspace();
        ComparisonWorkspace.WriteSuite(workspace);
        await using var endpoint = ComparisonWorkspace.Endpoint();
        using var console = new RecordingConsole();

        var plan = RunPlan.Create(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = workspace.Root,
                Endpoint = endpoint.Address.ToString(),
                RestExchange = "json",
                DryRun = true,
            }
        );

        await RunCommand.ExecuteAsync(plan, console, CancellationToken.None);

        console.StandardError.Should().BeEmpty();
        endpoint.Requests.Should().Be(0);
    }

    [Fact]
    public async Task ExecuteAsync_ForABaselineUpdatePreview_StreamsProgressForTheSuiteItConducts()
    {
        using var workspace = new TempWorkspace();
        ComparisonWorkspace.WriteSuite(workspace);
        Directory.CreateDirectory(Path.Combine(workspace.Root, "artifacts"));
        await using var endpoint = ComparisonWorkspace.Endpoint();

        using (var seeding = new RecordingConsole())
        {
            var seeded = await RunCommand.ExecuteAsync(
                RunPlan.Create(
                    new RunRequest
                    {
                        Suite = "eval-suites/regression.json",
                        Root = workspace.Root,
                        Out = "artifacts/baseline.json",
                        Endpoint = endpoint.Address.ToString(),
                        RestExchange = "json",
                    }
                ),
                seeding,
                CancellationToken.None
            );

            seeded.Should().Be(ExitCode.Success, seeding.StandardError);
        }

        using var console = new RecordingConsole();

        // The second place a suite is conducted. Without --apply this writes nothing.
        var code = await BaselineCommand.ExecuteAsync(
            RunPlan.CreateForBaselineUpdate(
                new RunRequest
                {
                    Suite = "eval-suites/regression.json",
                    Root = workspace.Root,
                    Baseline = "artifacts/baseline.json",
                    Endpoint = endpoint.Address.ToString(),
                    RestExchange = "json",
                }
            ),
            console,
            CancellationToken.None
        );

        code.Should().Be(ExitCode.Success, console.StandardError);
        console.StandardError.Should().Contain(StartLine);
        ProgressLines(console.StandardError).Should().HaveCount(2);
    }

    // -------------------------------------------------------------------------------------
    // The engine refuses a sink unless the coordinator's logger admits warnings, and refuses it
    // with an exception nothing here translates. The pair below is one harness with one fact
    // changed: whether that logger would admit a warning.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task ConductAsync_WhenTheCoordinatorsLoggerAdmitsWarnings_ShowsProgress()
    {
        using var workspace = new TempWorkspace();
        using var provider = EvalCliServices.Build(
            RunPlan.Create(new RunRequest { Suite = "eval-suites/regression.json", Root = workspace.Root }),
            TextWriter.Null
        );
        var display = new RecordingDisplay();

        var result = await SuiteDiscovery.ConductAsync(
            provider,
            ProgressFixture.Suite("regression", ("checkout", 2)),
            display,
            CancellationToken.None
        );

        // No exchange is wired, so both runs are recorded as errors — and each is still reported.
        result.ScenarioResults.Single().Runs.Should().HaveCount(2);
        display.Renders.Should().Be(1);
        display.Reports.Select(report => report.Completed).Should().BeEquivalentTo([1, 2]);
    }

    [Fact]
    public async Task ConductAsync_WhenTheCoordinatorsLoggerWouldNotAdmitAWarning_ConductsWithoutADisplayRatherThanBeingRefused()
    {
        using var workspace = new TempWorkspace();
        using var real = EvalCliServices.Build(
            RunPlan.Create(new RunRequest { Suite = "eval-suites/regression.json", Root = workspace.Root }),
            TextWriter.Null
        );
        using var quiet = new QuietCoordinator(real);
        var display = new RecordingDisplay();

        quiet.GetRequiredService<ILogger<RunCoordinator>>().IsEnabled(LogLevel.Warning).Should().BeFalse();

        // Handed a sink, the engine would throw InvalidOperationException here, which reaches the
        // defect handler and prints a stack trace for a run that was only asked to be quiet.
        var result = await SuiteDiscovery.ConductAsync(
            quiet,
            ProgressFixture.Suite("regression", ("checkout", 2)),
            display,
            CancellationToken.None
        );

        result.ScenarioResults.Single().Runs.Should().HaveCount(2);
        display.Renders.Should().Be(0);
        display.Reports.Should().BeEmpty();
    }

    /// <summary>Records whether it was asked to render, and what it was told.</summary>
    private sealed class RecordingDisplay : RunProgressDisplay
    {
        public int Renders { get; private set; }

        public ConcurrentQueue<RunProgress> Reports { get; } = new();

        protected override async Task RenderAsync(
            SuiteOutline outline,
            Func<IProgress<RunProgress>, Task<SuiteResult>> conduct,
            CancellationToken cancellationToken
        )
        {
            Renders++;

            await SettleAsync(conduct(new Sink(Reports)));
        }

        private sealed class Sink(ConcurrentQueue<RunProgress> reports) : IProgress<RunProgress>
        {
            public void Report(RunProgress value) => reports.Enqueue(value);
        }
    }

    /// <summary>
    /// The real composition root, except that the coordinator's logger is set above warning — the
    /// configuration no flag in this build produces, and the one the engine refuses a sink for.
    /// </summary>
    private sealed class QuietCoordinator(ServiceProvider inner) : IServiceProvider, IDisposable
    {
        private readonly ILoggerFactory _quiet = LoggerFactory.Create(builder =>
            builder.SetMinimumLevel(LogLevel.Error).AddProvider(new StandardErrorLoggerProvider(TextWriter.Null))
        );

        public object? GetService(Type serviceType)
        {
            if (serviceType == typeof(ILogger<RunCoordinator>))
            {
                return _quiet.CreateLogger<RunCoordinator>();
            }

            if (serviceType == typeof(RunCoordinator))
            {
                return new RunCoordinator(
                    inner.GetServices<IScenarioRunner>(),
                    inner.GetRequiredService<AssertionEvaluatorRegistry>(),
                    inner.GetRequiredService<IParticipantFactory>(),
                    inner.GetRequiredService<IClock>(),
                    inner.GetRequiredService<ISeedSource>(),
                    inner.GetRequiredService<RunCoordinatorOptions>(),
                    _quiet.CreateLogger<RunCoordinator>()
                );
            }

            return inner.GetService(serviceType);
        }

        public void Dispose() => _quiet.Dispose();
    }
}
