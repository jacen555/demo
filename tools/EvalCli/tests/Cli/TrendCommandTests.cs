using FluentAssertions;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Tests.Support;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Serialization;

namespace Forge.EvalCli.Tests.Cli;

/// <summary>
/// <c>trend</c> wired end to end: what it reads, what it writes, and what it refuses.
/// </summary>
/// <remarks>
/// <b>The artifacts in the passing cases are written by real runs.</b> A trend read from
/// hand-built JSON would agree with the analysis about a shape the engine never emits — and the
/// definition fingerprint, which is what the refusal rests on, is exactly the field a fixture
/// would get wrong.
/// </remarks>
public class TrendCommandTests
{
    private const string ArtifactsDirectory = "trend";

    private static TrendRequest Request(
        TempWorkspace workspace,
        string? report = null,
        bool overwrite = false,
        string artifacts = ArtifactsDirectory
    ) =>
        new()
        {
            Artifacts = artifacts,
            Root = workspace.Root,
            ReportMarkdown = report,
            Overwrite = overwrite,
        };

    private static async Task<(ExitCode Code, string Out, string Error)> RunAsync(TrendRequest request)
    {
        using var console = new RecordingConsole();

        try
        {
            var code = await TrendCommand.ExecuteAsync(TrendPlan.Create(request), console, CancellationToken.None);

            return (code, console.StandardOut, console.StandardError);
        }
        catch (EvalCliException refusal)
        {
            return (refusal.ExitCode, console.StandardOut, refusal.Message + " " + refusal.Remedy);
        }
    }

    /// <summary>Conducts the suite once and writes the artifact into the trend directory.</summary>
    private static async Task ConductAsync(TempWorkspace workspace, string name, params string[] failing)
    {
        await using var endpoint = ComparisonWorkspace.Endpoint(failing);

        using var console = new RecordingConsole();

        var code = await RunCommand.ExecuteAsync(
            RunPlan.Create(
                new RunRequest
                {
                    Suite = "eval-suites/regression.json",
                    Root = workspace.Root,
                    Out = $"{ArtifactsDirectory}/{name}.json",
                    Endpoint = endpoint.Address.ToString(),
                    RestExchange = "json",
                }
            ),
            console,
            CancellationToken.None
        );

        code.Should().Be(ExitCode.Success, console.StandardError);
    }

    /// <summary>Re-stamps an artifact on disk with an explicit instant, so a test can order a series.</summary>
    /// <remarks>
    /// The runs really happened; only the clock is moved, because two invocations inside one test
    /// land microseconds apart and a trend of two adjacent instants reads as one point.
    /// </remarks>
    private static async Task StampAsync(TempWorkspace workspace, string name, int day)
    {
        var path = Path.Combine(workspace.Root, ArtifactsDirectory, name + ".json");
        var artifact = CanonicalJson.DeserializeSuiteResult(await File.ReadAllTextAsync(path));

        var stamped = artifact with
        {
            Environment = artifact.Environment with { Timestamp = TrendFixture.Start.AddDays(day - 1) },
        };

        await File.WriteAllTextAsync(path, CanonicalJson.Serialize(stamped));
    }

    private static async Task SeedSeriesAsync(TempWorkspace workspace)
    {
        ComparisonWorkspace.WriteSuite(workspace);
        Directory.CreateDirectory(Path.Combine(workspace.Root, ArtifactsDirectory));

        await ConductAsync(workspace, "first", ComparisonWorkspace.Checkout);
        await StampAsync(workspace, "first", 1);

        await ConductAsync(workspace, "second");
        await StampAsync(workspace, "second", 2);
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheSeriesIsClean_PrintsTheTrendAndWritesNothing()
    {
        using var workspace = new TempWorkspace();

        await SeedSeriesAsync(workspace);

        var (code, output, _) = await RunAsync(Request(workspace));

        code.Should().Be(ExitCode.Success);
        output.Should().Contain("<!-- eval-cli:trend:").And.Contain(ComparisonWorkspace.Checkout);
        Directory.GetFiles(workspace.Root, "*.md", SearchOption.AllDirectories).Should().BeEmpty();
    }

    [Fact]
    public async Task ExecuteAsync_WhenAReportPathIsGiven_WritesTheMarkdownThere()
    {
        using var workspace = new TempWorkspace();

        await SeedSeriesAsync(workspace);

        var (code, _, error) = await RunAsync(Request(workspace, report: "artifacts/trend.md"));

        code.Should().Be(ExitCode.Success, error);

        var written = await File.ReadAllTextAsync(Path.Combine(workspace.Root, "artifacts", "trend.md"));

        written.Should().StartWith("<!-- eval-cli:trend:").And.Contain("## Evaluation trend");
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheReportAlreadyExists_RefusesWithoutTheOptIn()
    {
        using var workspace = new TempWorkspace();

        await SeedSeriesAsync(workspace);

        workspace.WriteFile(Path.Combine("artifacts", "trend.md"), "mine");

        var (code, _, error) = await RunAsync(Request(workspace, report: "artifacts/trend.md"));

        code.Should().Be(ExitCode.UsageError);
        error.Should().Contain("--overwrite");

        var kept = await File.ReadAllTextAsync(Path.Combine(workspace.Root, "artifacts", "trend.md"));

        kept.Should().Be("mine");
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheOptInIsGiven_ReplacesTheReport()
    {
        using var workspace = new TempWorkspace();

        await SeedSeriesAsync(workspace);

        workspace.WriteFile(Path.Combine("artifacts", "trend.md"), "mine");

        var (code, _, error) = await RunAsync(Request(workspace, report: "artifacts/trend.md", overwrite: true));

        code.Should().Be(ExitCode.Success, error);

        var written = await File.ReadAllTextAsync(Path.Combine(workspace.Root, "artifacts", "trend.md"));

        written.Should().NotBe("mine");
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheDirectoryHoldsOneArtifact_RefusesRatherThanReportingNoMovement()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);
        Directory.CreateDirectory(Path.Combine(workspace.Root, ArtifactsDirectory));

        await ConductAsync(workspace, "only");

        var (code, output, error) = await RunAsync(Request(workspace));

        code.Should().Be(ExitCode.ComparisonRefused);
        output.Should().BeEmpty();
        error.Should().Contain("1 artifact");
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheDirectoryIsEmpty_Refuses()
    {
        using var workspace = new TempWorkspace();

        Directory.CreateDirectory(Path.Combine(workspace.Root, ArtifactsDirectory));

        var (code, _, error) = await RunAsync(Request(workspace));

        code.Should().Be(ExitCode.ComparisonRefused);
        error.Should().Contain("No artifact in that directory");
    }

    [Fact]
    public async Task ExecuteAsync_WhenAnArtifactOnDiskCarriesANullScenario_RefusesThroughTheReadPath()
    {
        // **The path production takes, not the one the unit test constructs.** SuiteTrend's own
        // null refusal is pinned against an object built in memory; an artifact read from disk
        // goes through the engine's deserializer first, which is a different door at a domain
        // boundary. Before the engine refused it, that door raised a NullReferenceException —
        // not classified as unreadable, so it reached the defect handler, the one branch that
        // prints a stack trace and with it the machine's layout.
        using var workspace = new TempWorkspace();

        await SeedSeriesAsync(workspace);

        var source = Path.Combine(workspace.Root, ArtifactsDirectory, "first.json");
        var document = System.Text.Json.Nodes.JsonNode.Parse(await File.ReadAllTextAsync(source))!;

        document["scenarioResults"]!.AsArray().Add(null);

        workspace.WriteFile(Path.Combine(ArtifactsDirectory, "zz-nulled.json"), document.ToJsonString());

        var (code, output, error) = await RunAsync(Request(workspace));

        code.Should().Be(ExitCode.ComparisonRefused);
        error.Should().Contain("trend/zz-nulled.json").And.NotContain(workspace.Root);
        output.Should().BeEmpty();
    }

    [Fact]
    public async Task ExecuteAsync_WhenAnArtifactIsMalformed_RefusesNamingItByARelativePath()
    {
        using var workspace = new TempWorkspace();

        await SeedSeriesAsync(workspace);

        workspace.WriteFile(Path.Combine(ArtifactsDirectory, "broken.json"), "{ not json");

        var (code, _, error) = await RunAsync(Request(workspace));

        code.Should().Be(ExitCode.ComparisonRefused);
        error.Should().Contain("trend/broken.json");
        error.Should().NotContain(workspace.Root);
    }

    [Fact]
    public async Task ExecuteAsync_WhenAnArtifactDeclaresAnUnreadableSchema_Refuses()
    {
        using var workspace = new TempWorkspace();

        await SeedSeriesAsync(workspace);

        workspace.WriteFile(
            Path.Combine(ArtifactsDirectory, "future.json"),
            "{ \"schemaVersion\": \"99.0\", \"suiteName\": \"regression\" }"
        );

        var (code, _, error) = await RunAsync(Request(workspace));

        code.Should().Be(ExitCode.ComparisonRefused);
        error.Should().Contain("trend/future.json");
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheSuiteWasRedefinedMidSeries_Refuses()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);
        Directory.CreateDirectory(Path.Combine(workspace.Root, ArtifactsDirectory));

        await ConductAsync(workspace, "before");
        await StampAsync(workspace, "before", 1);

        // A real redefinition: the opening stimulus feeds the definition fingerprint.
        ComparisonWorkspace.WriteSuite(workspace, checkoutOpening: "goodbye");

        await ConductAsync(workspace, "after");
        await StampAsync(workspace, "after", 2);

        var (code, _, error) = await RunAsync(Request(workspace));

        code.Should().Be(ExitCode.ComparisonRefused);
        error.Should().Contain("redefined").And.Contain(ComparisonWorkspace.Checkout);
    }

    [Fact]
    public void Create_WhenTheArtifactsPathIsNotADirectory_IsARefusedInvocation()
    {
        using var workspace = new TempWorkspace();

        var refusal = Assert.Throws<EvalCliException>(() =>
            TrendPlan.Create(Request(workspace, artifacts: "eval-suites/regression.json"))
        );

        refusal.ExitCode.Should().Be(ExitCode.UsageError);
        refusal.Message.Should().Contain("--artifacts");
    }

    [Fact]
    public void Create_WhenTheArtifactsPathIsOutsideTheRoot_IsARefusedInvocation()
    {
        using var workspace = new TempWorkspace();

        var refusal = Assert.Throws<EvalCliException>(() =>
            TrendPlan.Create(Request(workspace, artifacts: workspace.Outside))
        );

        refusal.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Fact]
    public void Create_WhenTheArtifactsDirectoryDoesNotExist_IsARefusedInvocation()
    {
        using var workspace = new TempWorkspace();

        var refusal = Assert.Throws<EvalCliException>(() => TrendPlan.Create(Request(workspace, artifacts: "nowhere")));

        refusal.ExitCode.Should().Be(ExitCode.UsageError);
        refusal.Message.Should().Contain("--artifacts");
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheDirectoryHoldsNonArtifactFiles_IgnoresThemRatherThanRefusing()
    {
        using var workspace = new TempWorkspace();

        await SeedSeriesAsync(workspace);

        workspace.WriteFile(Path.Combine(ArtifactsDirectory, "notes.md"), "# not an artifact");

        var (code, _, error) = await RunAsync(Request(workspace));

        code.Should().Be(ExitCode.Success, error);
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheSeriesHasAGap_PutsTheGapOnThePage()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);
        Directory.CreateDirectory(Path.Combine(workspace.Root, ArtifactsDirectory));

        await ConductAsync(workspace, "first");
        await StampAsync(workspace, "first", 1);

        await ConductAsync(workspace, "second");
        await StampAsync(workspace, "second", 2);

        // Remove one scenario's record from the middle artifact, which is the shape selection
        // produces: the run happened and that scenario is simply not in it.
        var path = Path.Combine(workspace.Root, ArtifactsDirectory, "second.json");
        var artifact = CanonicalJson.DeserializeSuiteResult(await File.ReadAllTextAsync(path));

        await File.WriteAllTextAsync(
            path,
            CanonicalJson.Serialize(
                artifact with
                {
                    ScenarioResults =
                    [
                        .. artifact.ScenarioResults.Where(scenario =>
                            scenario.ScenarioId != ComparisonWorkspace.Billing
                        ),
                    ],
                }
            )
        );

        await ConductAsync(workspace, "third");
        await StampAsync(workspace, "third", 3);

        var (code, output, error) = await RunAsync(Request(workspace));

        code.Should().Be(ExitCode.Success, error);
        output.Should().Contain("no record");
        output.Should().Contain(ComparisonWorkspace.Billing);
    }

    [Fact]
    public async Task ExecuteAsync_WhenCancelledBeforeItStarts_Throws()
    {
        using var workspace = new TempWorkspace();

        await SeedSeriesAsync(workspace);

        using var console = new RecordingConsole();
        using var source = new CancellationTokenSource();

        await source.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            TrendCommand.ExecuteAsync(TrendPlan.Create(Request(workspace)), console, source.Token)
        );
    }

    [Fact]
    public void Create_WhenGivenNull_Throws() => Assert.Throws<ArgumentNullException>(() => TrendPlan.Create(null!));

    [Fact]
    public async Task ExecuteAsync_WhenGivenNull_Throws()
    {
        using var console = new RecordingConsole();

        await Assert.ThrowsAsync<ArgumentNullException>(() =>
            TrendCommand.ExecuteAsync(null!, console, CancellationToken.None)
        );
    }

    [Fact]
    public async Task ExecuteAsync_WhenAnArtifactIsADirectory_IsIgnoredRatherThanRefused()
    {
        using var workspace = new TempWorkspace();

        await SeedSeriesAsync(workspace);

        Directory.CreateDirectory(Path.Combine(workspace.Root, ArtifactsDirectory, "nested.json"));

        var (code, _, error) = await RunAsync(Request(workspace));

        code.Should().Be(ExitCode.Success, error);
    }

    [Fact]
    public async Task ExecuteAsync_WhenAnArtifactSitsInASubdirectory_IsNotRead()
    {
        // The directory is the series. Recursing would sweep a nested baseline or an unrelated
        // run into a trend nobody asked for.
        using var workspace = new TempWorkspace();

        await SeedSeriesAsync(workspace);

        var nested = Path.Combine(workspace.Root, ArtifactsDirectory, "old");

        Directory.CreateDirectory(nested);
        File.Copy(Path.Combine(workspace.Root, ArtifactsDirectory, "first.json"), Path.Combine(nested, "first.json"));

        var (code, output, error) = await RunAsync(Request(workspace));

        code.Should().Be(ExitCode.Success, error);
        output.Should().Contain("2 run(s)");
    }
}
