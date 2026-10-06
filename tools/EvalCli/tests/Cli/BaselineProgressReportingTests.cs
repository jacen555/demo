using System.Collections.Concurrent;
using System.CommandLine;
using System.CommandLine.IO;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using FluentAssertions;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Composition;
using Forge.EvalCli.Diagnostics;
using Forge.EvalCli.Tests.Support;
using Forge.EvalEngine.Coordination;
using Forge.EvalEngine.Loading;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Runners;
using Forge.EvalEngine.Scenarios;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Forge.EvalCli.Tests.Cli;

/// <summary>
/// Progress for the second suite a live-baseline comparison conducts: the baseline's own runs, on
/// stderr, while they happen.
/// </summary>
/// <remarks>
/// <para>
/// <b>The defect these pin was silence that every other test passed through.</b> With
/// <c>--baseline-endpoint</c> the candidate suite showed its progress and the baseline suite — as
/// long again — showed nothing. Nothing failed and nothing was logged; the comparison completed and
/// exited zero, so a test asserting the run succeeds measured nothing.
/// </para>
/// <para>
/// <b>Counting lines is not enough either.</b> A display that held every line until its suite had
/// finished would print exactly the right lines, in the right order, after the last request — silence
/// wearing a progress bar. What tells the two apart is <i>when</i> each line was written, so each
/// endpoint here reads stderr at the moment a request reaches it.
/// </para>
/// <para>
/// <b>The candidate's lines are the control throughout.</b> The same probe, read the same way, sees
/// them on the path that already worked. If a baseline assertion ever passes while the candidate's
/// vanish, the harness is being measured rather than the feature.
/// </para>
/// </remarks>
public partial class BaselineProgressReportingTests
{
    /// <summary>Three repetitions of each of two scenarios: six runs on each side.</summary>
    private const int Repetitions = 3;

    private const int Runs = 2 * Repetitions;

    /// <summary>A credential in the path, which is where one sits as readily as in a query string.</summary>
    private const string PathToken = "sk-live-abc123";

    private const string CandidateStart =
        "eval-cli: starting suite 'regression' - 6 run(s) planned across 2 scenario(s).";

    // -------------------------------------------------------------------------------------
    // When the lines are written.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task ExecuteAsync_AgainstALiveBaseline_WritesEachBaselineLineBeforeTheNextBaselineRequest()
    {
        using var workspace = new TempWorkspace();
        WriteSuite(workspace);
        using var console = new WatchedConsole();
        var atCandidateRequest = new ConcurrentQueue<string>();
        var atBaselineRequest = new ConcurrentQueue<string>();

        await using var candidate = Watching(console, atCandidateRequest);
        await using var baseline = Watching(console, atBaselineRequest);

        var plan = Plan(workspace, candidate, baseline);

        var code = await RunCommand.ExecuteAsync(plan, console, CancellationToken.None);

        code.Should().Be(ExitCode.Success, console.StandardError);

        // The control. The same probe on the suite that already showed its progress: if this fails,
        // the probe cannot see a timely line, and nothing asserted below would mean anything.
        var candidateSeen = atCandidateRequest.ToArray();

        candidateSeen.Should().HaveCount(Runs);
        candidateSeen[0].Should().Contain(CandidateStart);
        RequireALinePerEarlierRequest(
            candidateSeen.Select(seen => CandidateCounts(seen).Length).ToArray(),
            "candidate"
        );

        var baselineSeen = atBaselineRequest.ToArray();

        baselineSeen.Should().HaveCount(Runs);
        baselineSeen[0]
            .Should()
            .Contain(
                BaselineStart(plan),
                "nothing is reported until the first run completes, so until then the start line is all there is"
            );
        RequireALinePerEarlierRequest(baselineSeen.Select(seen => BaselineCounts(seen).Length).ToArray(), "baseline");

        // The candidate's lines stay where they were for the whole baseline run: added to, not replaced.
        baselineSeen.Should().OnlyContain(seen => CandidateCounts(seen).Length == Runs);
    }

    // -------------------------------------------------------------------------------------
    // What the lines say.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task ExecuteAsync_AgainstALiveBaseline_ShowsTwoSuitesThatCanBeToldApart()
    {
        using var workspace = new TempWorkspace();
        WriteSuite(workspace);
        using var console = new WatchedConsole();

        await using var candidate = Answering();
        await using var baseline = Answering();

        var plan = Plan(workspace, candidate, baseline);

        var code = await RunCommand.ExecuteAsync(plan, console, CancellationToken.None);

        code.Should().Be(ExitCode.Success, console.StandardError);

        var lines = Lines(console.StandardError);

        lines.Should().ContainSingle(line => line == CandidateStart);
        lines.Should().ContainSingle(line => line == BaselineStart(plan));

        // Each suite counts from its own first run. A sink shared with the candidate would hold the
        // candidate's final count, and every baseline line would read [6/6].
        CandidateCounts(console.StandardError)
            .Should()
            .Equal([1, 2, 3, 4, 5, 6], "the default throttle is one run in flight, so runs complete in order");
        BaselineCounts(console.StandardError).Should().Equal([1, 2, 3, 4, 5, 6]);

        // In the order they happened: the whole candidate, then the whole baseline.
        var lastCandidate = Array.FindLastIndex(lines, line => CandidateRun().IsMatch(line));
        var baselineStart = Array.IndexOf(lines, BaselineStart(plan));
        var firstBaseline = Array.FindIndex(lines, line => BaselineRun().IsMatch(line));

        Array.IndexOf(lines, CandidateStart).Should().BeLessThan(lastCandidate);
        lastCandidate.Should().BeLessThan(baselineStart);
        baselineStart.Should().BeLessThan(firstBaseline);
    }

    [Fact]
    public async Task ExecuteAsync_AgainstALiveBaselineWithJson_LeavesStandardOutParseable()
    {
        using var workspace = new TempWorkspace();
        WriteSuite(workspace);
        using var console = new WatchedConsole();

        await using var candidate = Answering();
        await using var baseline = Answering();

        var code = await RunCommand.ExecuteAsync(
            Plan(workspace, candidate, baseline) with
            {
                Json = true,
            },
            console,
            CancellationToken.None
        );

        code.Should().Be(ExitCode.Success, console.StandardError);

        // The positive control for the stdout assertions below: both suites' progress was written.
        CandidateCounts(console.StandardError).Should().HaveCount(Runs);
        BaselineCounts(console.StandardError).Should().HaveCount(Runs);

        console.StandardOut.Should().NotContain("eval-cli:");

        using var document = JsonDocument.Parse(console.StandardOut);

        document
            .RootElement.GetProperty("comparison")
            .GetProperty("mechanism")
            .GetString()
            .Should()
            .Be("live-endpoint");
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheBaselinePathCarriesACredential_NamesTheBaselineWithoutIt()
    {
        using var workspace = new TempWorkspace();
        WriteSuite(workspace);
        using var console = new WatchedConsole();

        await using var candidate = Answering();
        await using var baseline = Answering($"{PathToken}/evaluate");

        var code = await RunCommand.ExecuteAsync(Plan(workspace, candidate, baseline), console, CancellationToken.None);

        code.Should().Be(ExitCode.Success, console.StandardError);

        // The positive control: the baseline suite was shown, and it was named — by the only form of
        // its address anything may print. Without this, an empty stderr would pass the line below.
        var port = baseline.Address.Port.ToString(CultureInfo.InvariantCulture);

        console
            .StandardError.Should()
            .Contain($"eval-cli: starting baseline suite 'regression' against http://localhost:{port}/<redacted> - ");
        BaselineCounts(console.StandardError).Should().HaveCount(Runs);

        console.StandardError.Should().NotContain(PathToken);
        console.StandardOut.Should().NotContain(PathToken);
    }

    // -------------------------------------------------------------------------------------
    // Refusals and interruptions mean what they meant before the display was there.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task ExecuteAsync_WhenTheBaselineAddressRedirectsToTheCandidate_IsStillRefusedWithTheBaselineShown()
    {
        using var workspace = new TempWorkspace();
        WriteSuite(workspace);
        using var console = new WatchedConsole();

        await using var candidate = Answering();

        // A client that followed this would produce a baseline describing the candidate, stamped
        // with the baseline's address: the candidate compared against itself, and green.
        await using var baseline = new StubEndpoint(_ => new StubReply
        {
            Status = 307,
            Location = candidate.Address.ToString(),
        });

        var plan = Plan(workspace, candidate, baseline);

        var act = async () => await RunCommand.ExecuteAsync(plan, console, CancellationToken.None);
        var refusal = await act.Should().ThrowAsync<EvalCliException>();

        refusal.Which.ExitCode.Should().Be(ExitCode.ComparisonRefused);
        candidate
            .Requests.Should()
            .Be(Runs, "a redirect must not deliver the baseline's runs to the system under review");
        console.StandardOut.Should().BeEmpty();

        // The display was up for all of it, and showed each baseline run as what it was: a run the
        // harness could not conduct. The refusal came after, from the comparison.
        console.StandardError.Should().Contain(BaselineStart(plan));
        Lines(console.StandardError)
            .Where(line => BaselineRun().IsMatch(line))
            .Should()
            .HaveCount(Runs)
            .And.OnlyContain(line => line.EndsWith(": error", StringComparison.Ordinal));
        CandidateCounts(console.StandardError).Should().HaveCount(Runs);
    }

    [Fact]
    public async Task ExecuteAsync_WhenInterruptedDuringTheBaselineSuite_EndsAsAnInterruptionRatherThanAFaultInTheDisplay()
    {
        using var workspace = new TempWorkspace();
        WriteSuite(workspace);
        using var console = new WatchedConsole();
        using var cancellation = new CancellationTokenSource();

        await using var candidate = Answering();

        // Ctrl+C as the first baseline request arrives. The connection is dropped rather than
        // answered, so nothing is written to a client that has already given up on it.
        await using var baseline = new StubEndpoint(_ =>
        {
            cancellation.Cancel();

            return new StubReply { Status = 200, Abort = true };
        });

        var plan = Plan(workspace, candidate, baseline);

        var act = async () => await RunCommand.ExecuteAsync(plan, console, cancellation.Token);
        var interrupted = (await act.Should().ThrowAsync<OperationCanceledException>()).Which;

        ExitCodeReporter.Classify(interrupted).Should().Be(ExitCode.Interrupted);

        // The baseline's display was up when the interruption arrived, and its ending was not taken
        // for a fault in it.
        console.StandardError.Should().Contain(BaselineStart(plan));
        console.StandardError.Should().NotContain("progress display failed");
        CandidateCounts(console.StandardError).Should().HaveCount(Runs);
        console.StandardOut.Should().BeEmpty();
    }

    // -------------------------------------------------------------------------------------
    // Whether the baseline is shown at all is the coordinator's logger's to decide, and it is
    // asked once. These go beneath the command because no flag in this build makes that logger
    // quieter: the harness is the real composition root with that one logger chosen.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task CompareAsync_WhenTheCoordinatorsLoggerAdmitsWarnings_ShowsTheBaselineSuite()
    {
        using var workspace = new TempWorkspace();
        WriteSuite(workspace);
        await using var candidate = Answering();
        await using var baseline = Answering();
        var plan = Plan(workspace, candidate, baseline);
        using var provider = EvalCliServices.Build(plan, TextWriter.Null);
        var (suite, conducted) = await CandidateAsync(provider, plan);
        using var stderr = new StringWriter();
        using var diagnostics = new DiagnosticsWriter(stderr);
        var admitting = provider.GetRequiredService<ILogger<RunCoordinator>>();

        admitting.IsEnabled(LogLevel.Warning).Should().BeTrue();

        using var coordinators = new BaselineEndpointCoordinators(Answered(provider, admitting), plan);

        var outcome = await BaselineComparison.CompareAsync(
            Answered(provider, admitting, coordinators),
            plan,
            suite,
            [],
            conducted,
            null,
            new StreamedRunProgress(diagnostics),
            CancellationToken.None
        );

        outcome.Should().BeOfType<ComparisonOutcome>().Which.Mechanism.Should().Be(BaselineMechanism.LiveEndpoint);
        Lines(stderr.ToString()).Should().StartWith(BaselineStart(plan));
        BaselineCounts(stderr.ToString()).Should().Equal([1, 2, 3, 4, 5, 6]);
    }

    [Fact]
    public async Task CompareAsync_WhenTheCoordinatorsLoggerWouldNotAdmitAWarning_ComparesWithoutShowingTheBaseline()
    {
        // The test above with one fact changed: the logger both halves are handed.
        using var workspace = new TempWorkspace();
        WriteSuite(workspace);
        await using var candidate = Answering();
        await using var baseline = Answering();
        var plan = Plan(workspace, candidate, baseline);
        using var provider = EvalCliServices.Build(plan, TextWriter.Null);
        var (suite, conducted) = await CandidateAsync(provider, plan);
        using var stderr = new StringWriter();
        using var diagnostics = new DiagnosticsWriter(stderr);
        using var loggers = QuietLoggers();
        var quiet = loggers.CreateLogger<RunCoordinator>();

        quiet.IsEnabled(LogLevel.Warning).Should().BeFalse();

        using var coordinators = new BaselineEndpointCoordinators(Answered(provider, quiet), plan);

        var act = () =>
            BaselineComparison.CompareAsync(
                Answered(provider, quiet, coordinators),
                plan,
                suite,
                [],
                conducted,
                null,
                new StreamedRunProgress(diagnostics),
                CancellationToken.None
            );

        // Completed: neither refused as a comparison nor reported as a defect — both of which throw.
        var outcome = (await act.Should().NotThrowAsync()).Which;

        outcome.Should().BeOfType<ComparisonOutcome>().Which.Mechanism.Should().Be(BaselineMechanism.LiveEndpoint);
        baseline.Requests.Should().Be(Runs, "the baseline was conducted in full, without a sink");
        stderr.ToString().Should().BeEmpty("no sink was supplied, so there was nothing to draw");
    }

    [Fact]
    public async Task CompareAsync_WhenTheBaselineCoordinatorWouldRefuseItsSink_ReportsADefectRatherThanConductingWithoutOne()
    {
        // The question this tool asks is answered yes and the coordinator it is about would say no:
        // the check gone wrong, on purpose. It cannot happen while both are handed the same logger.
        using var workspace = new TempWorkspace();
        WriteSuite(workspace);
        await using var candidate = Answering();
        await using var baseline = Answering();
        var plan = Plan(workspace, candidate, baseline);
        using var provider = EvalCliServices.Build(plan, TextWriter.Null);
        var (suite, conducted) = await CandidateAsync(provider, plan);
        using var stderr = new StringWriter();
        using var diagnostics = new DiagnosticsWriter(stderr);
        using var loggers = QuietLoggers();
        var admitting = provider.GetRequiredService<ILogger<RunCoordinator>>();

        admitting.IsEnabled(LogLevel.Warning).Should().BeTrue();

        using var coordinators = new BaselineEndpointCoordinators(
            Answered(provider, loggers.CreateLogger<RunCoordinator>()),
            plan
        );

        var act = () =>
            BaselineComparison.CompareAsync(
                Answered(provider, admitting, coordinators),
                plan,
                suite,
                [],
                conducted,
                null,
                new StreamedRunProgress(diagnostics),
                CancellationToken.None
            );

        var defect = (await act.Should().ThrowExactlyAsync<NotSupportedException>()).Which;

        // Not translated into anything that reads as a fact about either system.
        ExitCodeReporter.Classify(defect).Should().Be(ExitCode.UnexpectedError);

        // And not quietly retried without the sink, which would be the silence this display removes.
        baseline
            .Requests.Should()
            .Be(0, "the sink is refused before anything is dispatched, and nothing is run after");
    }

    [Fact]
    public async Task CompareAsync_WhenTheBaselineRunsWentElsewhere_IsStillRefusedAfterTheirProgressWasShown()
    {
        using var workspace = new TempWorkspace();
        WriteSuite(workspace);
        await using var candidate = Answering();
        await using var baseline = Answering();
        await using var elsewhere = Answering();
        var plan = Plan(workspace, candidate, baseline);
        using var provider = EvalCliServices.Build(plan, TextWriter.Null);
        var (suite, conducted) = await CandidateAsync(provider, plan);
        using var stderr = new StringWriter();
        using var diagnostics = new DiagnosticsWriter(stderr);

        // The baseline harness's adapter dials an address of its own, so the artifact that comes back
        // describes a system the engine can prove is not the one it was asked about.
        var misdirected = new Elsewhere(provider.GetRequiredService<IRestExchange>(), elsewhere.Address);

        using var coordinators = new BaselineEndpointCoordinators(
            new AnsweringProvider(provider, (typeof(IRestExchange), misdirected)),
            plan
        );

        var act = () =>
            BaselineComparison.CompareAsync(
                new AnsweringProvider(provider, (typeof(BaselineEndpointCoordinators), coordinators)),
                plan,
                suite,
                [],
                conducted,
                null,
                new StreamedRunProgress(diagnostics),
                CancellationToken.None
            );

        var refusal = (await act.Should().ThrowAsync<EvalCliException>()).Which;

        refusal.ExitCode.Should().Be(ExitCode.ComparisonRefused);
        elsewhere.Requests.Should().Be(Runs, "the refusal is only the real one if the runs actually went there");

        // A report is not a verdict. Every run was shown as it completed; the artifact was refused once
        // the suite had finished, through the display, and mapped exactly as it was without one.
        Lines(stderr.ToString()).Should().StartWith(BaselineStart(plan));
        BaselineCounts(stderr.ToString()).Should().Equal([1, 2, 3, 4, 5, 6]);
    }

    // -------------------------------------------------------------------------------------
    // Harness.
    // -------------------------------------------------------------------------------------

    private static void WriteSuite(TempWorkspace workspace) =>
        workspace.WriteFile(
            Path.Combine("eval-suites", "regression.json"),
            SuiteFixture.Suite(
                "regression",
                SuiteFixture.Scenario(
                    ComparisonWorkspace.Checkout,
                    ["src/**"],
                    expectedOutcome: ComparisonWorkspace.ExpectedOutcome,
                    repetitions: Repetitions
                ),
                SuiteFixture.Scenario(
                    ComparisonWorkspace.Billing,
                    ["docs/**"],
                    expectedOutcome: ComparisonWorkspace.ExpectedOutcome,
                    repetitions: Repetitions
                )
            )
        );

    private static RunPlan Plan(TempWorkspace workspace, StubEndpoint candidate, StubEndpoint baseline) =>
        RunPlan.Create(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = workspace.Root,
                Endpoint = candidate.Address.ToString(),
                BaselineEndpoint = baseline.Address.ToString(),
                RestExchange = "json",
            }
        );

    /// <summary>The baseline's start line, naming the only printable form of its address.</summary>
    private static string BaselineStart(RunPlan plan) =>
        $"eval-cli: starting baseline suite 'regression' against {plan.BaselineEndpointDisplay} - 6 run(s) planned "
        + "across 2 scenario(s).";

    /// <summary>Answers every request as a pass.</summary>
    private static StubReply Answer() =>
        new()
        {
            Status = 200,
            Body = $"{{ \"output\": \"ok\", \"outcome\": \"{ComparisonWorkspace.ExpectedOutcome}\" }}",
        };

    private static StubEndpoint Answering(string path = "evaluate") => new(_ => Answer(), path);

    /// <summary>
    /// An endpoint that, as each request reaches it, records what stderr already says.
    /// </summary>
    /// <remarks>
    /// A request is sent only once the run before it has been reported — one run in flight, and the
    /// worker reporting a run starts nothing else until the report returns — so whatever a display
    /// writes as runs complete is on stderr by the time the next request arrives here.
    /// </remarks>
    private static StubEndpoint Watching(WatchedConsole console, ConcurrentQueue<string> seen) =>
        new(_ =>
        {
            seen.Enqueue(console.StandardError);

            return Answer();
        });

    /// <summary>Requires that, by request k+1, the lines for the k runs before it had been written.</summary>
    /// <param name="linesAtRequest">How many of the suite's run lines stderr held as each request arrived.</param>
    /// <param name="suite">Which suite, for the message.</param>
    /// <remarks>
    /// A display that held its lines until the suite had finished writes as many lines, all after the
    /// last request — which every request sees as none at all.
    /// </remarks>
    private static void RequireALinePerEarlierRequest(int[] linesAtRequest, string suite) =>
        linesAtRequest
            .Select((lines, request) => lines >= request)
            .Should()
            .AllBeEquivalentTo(
                true,
                "each {0} run's line must be on stderr before the next {0} request is sent; lines seen at each "
                    + "request: [{1}]",
                suite,
                string.Join(", ", linesAtRequest)
            );

    private static string[] Lines(string standardError) =>
        standardError.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries);

    private static int[] CandidateCounts(string standardError) => Counts(CandidateRun(), standardError);

    private static int[] BaselineCounts(string standardError) => Counts(BaselineRun(), standardError);

    private static int[] Counts(Regex run, string standardError) =>
        Lines(standardError)
            .Select(line => run.Match(line))
            .Where(match => match.Success)
            .Select(match => int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture))
            .ToArray();

    [GeneratedRegex(@"^eval-cli: \[(\d+)/\d+\] scenario '")]
    private static partial Regex CandidateRun();

    [GeneratedRegex(@"^eval-cli: \[(\d+)/\d+\] baseline scenario '")]
    private static partial Regex BaselineRun();

    /// <summary>Loads the suite and conducts the candidate, as the command does before it compares.</summary>
    private static async Task<(Suite Suite, SuiteResult Candidate)> CandidateAsync(
        IServiceProvider provider,
        RunPlan plan
    )
    {
        using var console = new RecordingConsole();

        var suite = await SuiteDiscovery.LoadSuiteAsync(
            provider.GetRequiredService<SuiteLoader>(),
            plan,
            console,
            CancellationToken.None
        );

        return (suite, await provider.GetRequiredService<RunCoordinator>().RunAsync(suite, CancellationToken.None));
    }

    /// <summary>
    /// Loggers set above warning: the configuration no flag in this build produces, and the one the
    /// engine refuses a progress sink for.
    /// </summary>
    private static ILoggerFactory QuietLoggers() =>
        LoggerFactory.Create(builder =>
            builder.SetMinimumLevel(LogLevel.Error).AddProvider(new StandardErrorLoggerProvider(TextWriter.Null))
        );

    /// <summary>The composition root, with the coordinator's logger chosen.</summary>
    private static AnsweringProvider Answered(IServiceProvider provider, ILogger<RunCoordinator> logger) =>
        new(provider, (typeof(ILogger<RunCoordinator>), logger));

    /// <summary>The composition root, with the coordinator's logger and the baseline harness chosen.</summary>
    private static AnsweringProvider Answered(
        IServiceProvider provider,
        ILogger<RunCoordinator> logger,
        BaselineEndpointCoordinators coordinators
    ) => new(provider, (typeof(ILogger<RunCoordinator>), logger), (typeof(BaselineEndpointCoordinators), coordinators));

    /// <summary>The real composition root, answering some services with instances a test chose.</summary>
    /// <remarks>
    /// A <see cref="BaselineEndpointCoordinators"/> resolves what it builds from the provider it was
    /// constructed over, so a test that changes what the baseline coordinator is given builds one over
    /// this rather than taking the container's, which would answer from the container regardless.
    /// </remarks>
    private sealed class AnsweringProvider(IServiceProvider inner, params (Type Service, object Instance)[] answers)
        : IServiceProvider
    {
        public object? GetService(Type serviceType)
        {
            ArgumentNullException.ThrowIfNull(serviceType);

            foreach (var (service, instance) in answers)
            {
                if (service == serviceType)
                {
                    return instance;
                }
            }

            return inner.GetService(serviceType);
        }
    }

    /// <summary>An adapter that dials an absolute address of its own rather than the client's.</summary>
    /// <remarks>
    /// Only the destination changes: the body and the reading of the reply are the real adapter's, so
    /// the artifact that comes back differs from an honest one only in where its runs went.
    /// </remarks>
    private sealed class Elsewhere(IRestExchange inner, Uri destination) : IRestExchange
    {
        public HttpRequestMessage CreateRequest(RestStimulus stimulus)
        {
            var request = inner.CreateRequest(stimulus);

            request.RequestUri = destination;

            return request;
        }

        public RestResponse Read(RestReply reply) => inner.Read(reply);
    }

    /// <summary>A console whose streams can be read while the command is still writing to them.</summary>
    /// <remarks>
    /// The endpoints above read stderr from the thread that serves their requests while the command
    /// writes it from its own. <see cref="RecordingConsole"/> keeps a plain <see cref="StringWriter"/>,
    /// which is safe to read only once the command has returned.
    /// </remarks>
    private sealed class WatchedConsole : IConsole, IDisposable
    {
        private readonly LockedWriter _out = new();
        private readonly LockedWriter _error = new();

        public WatchedConsole()
        {
            Out = StandardStreamWriter.Create(_out);
            Error = StandardStreamWriter.Create(_error);
        }

        public IStandardStreamWriter Out { get; }

        public IStandardStreamWriter Error { get; }

        public bool IsOutputRedirected => true;

        public bool IsErrorRedirected => true;

        public bool IsInputRedirected => false;

        /// <summary>Gets everything written to standard output so far.</summary>
        public string StandardOut => _out.Text;

        /// <summary>Gets everything written to standard error so far.</summary>
        public string StandardError => _error.Text;

        public void Dispose()
        {
            _out.Dispose();
            _error.Dispose();
        }

        private sealed class LockedWriter : TextWriter
        {
            private readonly StringBuilder _text = new();

            public override Encoding Encoding => Encoding.UTF8;

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

            public override void Write(char value)
            {
                lock (_text)
                {
                    _text.Append(value);
                }
            }

            public override void Write(string? value)
            {
                lock (_text)
                {
                    _text.Append(value);
                }
            }
        }
    }
}
