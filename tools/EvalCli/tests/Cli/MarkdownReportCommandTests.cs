using System.Text.Json;
using FluentAssertions;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Tests.Support;

namespace Forge.EvalCli.Tests.Cli;

/// <summary>
/// <c>--report-markdown</c> wired into a run: what it writes, and what it refuses to write.
/// </summary>
/// <remarks>
/// <b>Every report here was produced by conducting the suite.</b> The regressions and the
/// newly-covered scenarios these tests read out of the Markdown were earned by a system under test
/// answering differently between two runs — which is what pins the rendering against the shapes
/// the engine really emits, rather than against a fixture that could agree with the renderer while
/// the comparator disagreed with both.
/// </remarks>
public class MarkdownReportCommandTests
{
    private const string ReportPath = "artifacts/report.md";

    private static RunRequest Request(
        TempWorkspace workspace,
        StubEndpoint endpoint,
        string? baseline = "artifacts/baseline.json",
        string? output = null,
        string? report = ReportPath,
        bool overwrite = false,
        bool dryRun = false,
        bool json = false
    ) =>
        new()
        {
            Suite = "eval-suites/regression.json",
            Root = workspace.Root,
            Baseline = baseline,
            Out = output,
            ReportMarkdown = report,
            Overwrite = overwrite,
            Endpoint = endpoint.Address.ToString(),
            RestExchange = "json",
            DryRun = dryRun,
            Json = json,
        };

    private static async Task SeedBaselineAsync(TempWorkspace workspace, StubEndpoint endpoint)
    {
        using var console = new RecordingConsole();

        var code = await RunCommand.ExecuteAsync(
            RunPlan.Create(
                Request(workspace, endpoint, baseline: null, output: "artifacts/baseline.json", report: null)
            ),
            console,
            CancellationToken.None
        );

        code.Should().Be(ExitCode.Success, console.StandardError);
    }

    /// <summary>Conducts a real comparison and returns the Markdown the invocation wrote.</summary>
    private static async Task<(ExitCode Code, string Markdown)> ReportAsync(
        TempWorkspace workspace,
        params string[] failing
    )
    {
        ComparisonWorkspace.WriteSuite(workspace);

        await using var before = ComparisonWorkspace.Endpoint();

        await SeedBaselineAsync(workspace, before);

        await using var after = ComparisonWorkspace.Endpoint(failing);

        using var console = new RecordingConsole();

        var code = await RunCommand.ExecuteAsync(
            RunPlan.Create(Request(workspace, after)),
            console,
            CancellationToken.None
        );

        var path = Path.Combine(workspace.Root, "artifacts", "report.md");

        return (code, File.Exists(path) ? await File.ReadAllTextAsync(path) : string.Empty);
    }

    [Fact]
    public async Task ExecuteAsync_WhenAScenarioRegressed_WritesAReportNamingItWithItsRates()
    {
        using var workspace = new TempWorkspace();

        var (code, markdown) = await ReportAsync(workspace, ComparisonWorkspace.Checkout);

        code.Should().Be(ExitCode.Success);
        markdown.Should().StartWith("<!-- eval-cli:report:");
        markdown.Should().Contain("### Regressions (1)").And.Contain("`checkout`");
        markdown.Should().Contain("### Unchanged");
    }

    [Fact]
    public async Task ExecuteAsync_WhenAScenarioWasFixed_LeadsTheReportWithWhatTheChangeCovered()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var before = ComparisonWorkspace.Endpoint(ComparisonWorkspace.Checkout);

        await SeedBaselineAsync(workspace, before);

        await using var after = ComparisonWorkspace.Endpoint();

        using var console = new RecordingConsole();

        var code = await RunCommand.ExecuteAsync(
            RunPlan.Create(Request(workspace, after)),
            console,
            CancellationToken.None
        );

        code.Should().Be(ExitCode.Success, console.StandardError);

        var markdown = await File.ReadAllTextAsync(Path.Combine(workspace.Root, "artifacts", "report.md"));

        markdown.Should().Contain("### Newly covered (1)").And.Contain("`checkout`");

        // Never a baseline, never an input. The Markdown is a rendering of the JSON artifact.
        markdown.Should().Contain("never read back");
    }

    [Fact]
    public async Task ExecuteAsync_WhenAReportIsWritten_NamesNoPathOutsideTheRoot()
    {
        using var workspace = new TempWorkspace();

        var (_, markdown) = await ReportAsync(workspace, ComparisonWorkspace.Checkout);

        markdown.Should().NotContain(workspace.Root, "a build agent's directory layout is not evidence");
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheReportDestinationExists_RefusesWithoutOverwrite()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);
        workspace.WriteFile(Path.Combine("artifacts", "report.md"), "an earlier report");

        await using var endpoint = ComparisonWorkspace.Endpoint();

        await SeedBaselineAsync(workspace, endpoint);

        var act = () => RunPlan.Create(Request(workspace, endpoint));

        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);

        // Refused at argument time, so the existing file is untouched and no run was spent
        // discovering it.
        (await File.ReadAllTextAsync(Path.Combine(workspace.Root, "artifacts", "report.md")))
            .Should()
            .Be("an earlier report");
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheReportDestinationExistsAndOverwriteWasGiven_ReplacesIt()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var before = ComparisonWorkspace.Endpoint();

        await SeedBaselineAsync(workspace, before);

        workspace.WriteFile(Path.Combine("artifacts", "report.md"), "an earlier report");

        await using var after = ComparisonWorkspace.Endpoint(ComparisonWorkspace.Checkout);

        using var console = new RecordingConsole();

        var code = await RunCommand.ExecuteAsync(
            RunPlan.Create(Request(workspace, after, overwrite: true)),
            console,
            CancellationToken.None
        );

        code.Should().Be(ExitCode.Success, console.StandardError);

        var markdown = await File.ReadAllTextAsync(Path.Combine(workspace.Root, "artifacts", "report.md"));

        markdown.Should().StartWith("<!-- eval-cli:report:").And.NotContain("an earlier report");
    }

    [Fact]
    public void Create_WhenAReportIsAskedForWithNoBaseline_Refuses()
    {
        using var workspace = new TempWorkspace();

        var act = () =>
            RunPlan.Create(
                new RunRequest
                {
                    Suite = "eval-suites/regression.json",
                    Root = workspace.Root,
                    ReportMarkdown = ReportPath,
                }
            );

        // A comparison report with nothing to compare against would print counts of zero beside
        // headings a reader takes for findings. Refused rather than written empty.
        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Fact]
    public void Create_WhenTheReportWouldOverwriteTheArtifact_Refuses()
    {
        using var workspace = new TempWorkspace();

        workspace.WriteFile(Path.Combine("artifacts", "baseline.json"), "{}");

        var act = () =>
            RunPlan.Create(
                new RunRequest
                {
                    Suite = "eval-suites/regression.json",
                    Root = workspace.Root,
                    Baseline = "artifacts/baseline.json",
                    Out = "artifacts/candidate.json",
                    ReportMarkdown = "artifacts/candidate.json",
                }
            );

        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Fact]
    public void Create_WhenTheReportWouldOverwriteTheBaseline_Refuses()
    {
        using var workspace = new TempWorkspace();

        workspace.WriteFile(Path.Combine("artifacts", "baseline.json"), "{}");

        var act = () =>
            RunPlan.Create(
                new RunRequest
                {
                    Suite = "eval-suites/regression.json",
                    Root = workspace.Root,
                    Baseline = "artifacts/baseline.json",
                    ReportMarkdown = "artifacts/baseline.json",
                    Overwrite = true,
                }
            );

        // The durable artifact is the one thing this report may never become. Refused even with
        // --overwrite, because the opt-in is about replacing a stale report, not about destroying
        // the evidence the next comparison is made against.
        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Fact]
    public void CreateForBaselineUpdate_WhenAReportIsAskedFor_Refuses()
    {
        using var workspace = new TempWorkspace();

        workspace.WriteFile(Path.Combine("artifacts", "baseline.json"), "{}");

        var act = () =>
            RunPlan.CreateForBaselineUpdate(
                new RunRequest
                {
                    Suite = "eval-suites/regression.json",
                    Root = workspace.Root,
                    Baseline = "artifacts/baseline.json",
                    ReportMarkdown = ReportPath,
                }
            );

        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Fact]
    public async Task ExecuteAsync_WhenPreviewing_NamesTheReportDestinationAndWritesNothing()
    {
        using var workspace = new TempWorkspace();

        workspace.WriteFile(Path.Combine("artifacts", "baseline.json"), "{}");

        await using var endpoint = ComparisonWorkspace.Endpoint();

        using var console = new RecordingConsole();

        var code = await RunCommand.ExecuteAsync(
            RunPlan.Create(Request(workspace, endpoint, dryRun: true)),
            console,
            CancellationToken.None
        );

        code.Should().Be(ExitCode.Success, console.StandardError);
        console.StandardOut.Should().Contain("report markdown").And.Contain("report.md");
        File.Exists(Path.Combine(workspace.Root, "artifacts", "report.md")).Should().BeFalse();
    }

    [Fact]
    public async Task ExecuteAsync_WhenPreviewingAsJson_CarriesTheReportDestination()
    {
        using var workspace = new TempWorkspace();

        workspace.WriteFile(Path.Combine("artifacts", "baseline.json"), "{}");

        await using var endpoint = ComparisonWorkspace.Endpoint();

        using var console = new RecordingConsole();

        await RunCommand.ExecuteAsync(
            RunPlan.Create(Request(workspace, endpoint, dryRun: true, json: true)),
            console,
            CancellationToken.None
        );

        JsonDocument
            .Parse(console.StandardOut)
            .RootElement.GetProperty("reportMarkdown")
            .GetString()
            .Should()
            .EndWith("report.md");
    }

    [Fact]
    public async Task ExecuteAsync_WhenNoReportWasAskedFor_WritesNone()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var before = ComparisonWorkspace.Endpoint();

        await SeedBaselineAsync(workspace, before);

        await using var after = ComparisonWorkspace.Endpoint(ComparisonWorkspace.Checkout);

        using var console = new RecordingConsole();

        var code = await RunCommand.ExecuteAsync(
            RunPlan.Create(Request(workspace, after, report: null)),
            console,
            CancellationToken.None
        );

        code.Should().Be(ExitCode.Success, console.StandardError);
        Directory
            .GetFiles(Path.Combine(workspace.Root, "artifacts"), "*.md")
            .Should()
            .BeEmpty("the default invocation writes no report");
    }

    [Fact]
    public async Task ExecuteAsync_WhenTwoLiveBaselinesDifferOnlyByPath_WritesReportsWithDistinctMarkers()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var endpoint = new StubEndpoint(
            body =>
            {
                using var request = JsonDocument.Parse(body);

                _ = request.RootElement.GetProperty("scenarioId").GetString();

                return new StubReply
                {
                    Status = 200,
                    Body = $"{{ \"output\": \"ok\", \"outcome\": \"{ComparisonWorkspace.ExpectedOutcome}\" }}",
                };
            },
            "candidate",
            ["main", "release"]
        );

        var trunk = await LiveReportAsync(workspace, endpoint, "main", "trunk.md");
        var release = await LiveReportAsync(workspace, endpoint, "release", "release.md");

        // Both baselines redact to the same displayed address, so a marker taken from what is
        // printed cannot tell them apart and the second report replaces the first. This is the
        // production wiring — the renderer tests construct the identity themselves and never
        // exercise the assignment in BaselineComparison.
        Marker(trunk).Should().NotBe(Marker(release));

        foreach (var report in (string[])[trunk, release])
        {
            report.Should().Contain("<redacted>").And.NotContain("/main").And.NotContain("/release");
        }
    }

    /// <summary>Conducts a live-baseline comparison against one path and returns the Markdown.</summary>
    private static async Task<string> LiveReportAsync(
        TempWorkspace workspace,
        StubEndpoint endpoint,
        string baselinePath,
        string reportName
    )
    {
        using var console = new RecordingConsole();

        var code = await RunCommand.ExecuteAsync(
            RunPlan.Create(
                new RunRequest
                {
                    Suite = "eval-suites/regression.json",
                    Root = workspace.Root,
                    Endpoint = endpoint.Address.ToString(),
                    BaselineEndpoint = endpoint.At(baselinePath).ToString(),
                    RestExchange = "json",
                    ReportMarkdown = $"artifacts/{reportName}",
                }
            ),
            console,
            CancellationToken.None
        );

        code.Should().Be(ExitCode.Success, console.StandardError);

        return await File.ReadAllTextAsync(Path.Combine(workspace.Root, "artifacts", reportName));
    }

    private static string Marker(string report) => report[..report.IndexOf('\n')];

    [Fact]
    public async Task ExecuteAsync_WhenTheSuiteNameCarriesAMachinePath_RefusesTheRunAndWritesNoReport()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var before = ComparisonWorkspace.Endpoint();

        await SeedBaselineAsync(workspace, before);

        // The same scenario this test has always exercised — a suite name carrying a checkout
        // directory, travelling from the file through the loader — but the contract it meets
        // changed. "Redact it and carry on" put the author's mistake on the page under an alias
        // and left the suite naming a machine forever; the engine now refuses the value at load
        // and tells the author to rename it. Rewritten rather than deleted: the input is still
        // the right one, only the expectation moved.
        workspace.WriteFile(
            Path.Combine("eval-suites", "regression.json"),
            SuiteFixture.Suite(
                "checkout /home/ci-user/build regression",
                SuiteFixture.Scenario(
                    ComparisonWorkspace.Checkout,
                    expectedOutcome: ComparisonWorkspace.ExpectedOutcome
                )
            )
        );

        await using var after = ComparisonWorkspace.Endpoint(ComparisonWorkspace.Checkout);

        using var console = new RecordingConsole();

        var act = async () =>
            await RunCommand.ExecuteAsync(RunPlan.Create(Request(workspace, after)), console, CancellationToken.None);

        var refusal = await act.Should().ThrowAsync<EvalCliException>();

        refusal.Which.ExitCode.Should().Be(ExitCode.SuiteError);
        refusal.Which.ExitCode.Should().NotBe(ExitCode.Success);
        refusal.Which.Message.Should().Contain("suite.name.machinePath");

        // No file at all, rather than a report carrying an alias where the suite name goes. The
        // refusal is the exit code and the message; nothing was run, so there is nothing to
        // render.
        File.Exists(Path.Combine(workspace.Root, "artifacts", "report.md")).Should().BeFalse();
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheComparisonWasRefused_WritesNoReportAndExitsNonZero()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var before = ComparisonWorkspace.Endpoint();

        await SeedBaselineAsync(workspace, before);

        // A genuine redefinition: the scenario now asks something else, so the two artifacts
        // cannot be shown to have been conducted against the same definition.
        ComparisonWorkspace.WriteSuite(workspace, checkoutOpening: "a different question");

        await using var after = ComparisonWorkspace.Endpoint();

        using var console = new RecordingConsole();

        var act = async () =>
            await RunCommand.ExecuteAsync(RunPlan.Create(Request(workspace, after)), console, CancellationToken.None);

        (await act.Should().ThrowAsync<EvalCliException>()).Which.ExitCode.Should().Be(ExitCode.ComparisonRefused);

        // No file at all rather than a report saying nothing regressed. The refusal is the exit
        // code and the message; a Markdown file whose absence means "refused" is still safer than
        // one whose content reads as a clean comparison.
        File.Exists(Path.Combine(workspace.Root, "artifacts", "report.md")).Should().BeFalse();
    }
}
