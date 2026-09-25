using FluentAssertions;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Tests.Support;
using Forge.EvalEngine.Serialization;

namespace Forge.EvalCli.Tests.Cli;

/// <summary>
/// The guards on what <c>trend</c> may write and where, and on what it may conclude.
/// </summary>
/// <remarks>
/// <b>The directory input is a write-collision surface the comparison report never had.</b>
/// <c>run</c> refuses <c>--out</c> equal to <c>--baseline</c> even with <c>--overwrite</c>, because
/// a tool that destroys the evidence it was asked to read leaves nothing to re-run from. A
/// destination inside <c>--artifacts</c> is the same failure with a directory in the middle of it.
/// </remarks>
public class TrendDestinationTests
{
    private const string ArtifactsDirectory = "trend";

    private static TrendRequest Request(
        TempWorkspace workspace,
        string? report,
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

    private static async Task SeedAsync(TempWorkspace workspace)
    {
        ComparisonWorkspace.WriteSuite(workspace);
        Directory.CreateDirectory(Path.Combine(workspace.Root, ArtifactsDirectory));

        for (var day = 1; day <= 2; day++)
        {
            await using var endpoint = ComparisonWorkspace.Endpoint();

            using var console = new RecordingConsole();

            var code = await RunCommand.ExecuteAsync(
                RunPlan.Create(
                    new RunRequest
                    {
                        Suite = "eval-suites/regression.json",
                        Root = workspace.Root,
                        Out = $"{ArtifactsDirectory}/run-{day}.json",
                        Endpoint = endpoint.Address.ToString(),
                        RestExchange = "json",
                    }
                ),
                console,
                CancellationToken.None
            );

            code.Should().Be(ExitCode.Success, console.StandardError);

            var path = Path.Combine(workspace.Root, ArtifactsDirectory, $"run-{day}.json");
            var artifact = CanonicalJson.DeserializeSuiteResult(await File.ReadAllTextAsync(path));

            await File.WriteAllTextAsync(
                path,
                CanonicalJson.Serialize(
                    artifact with
                    {
                        Environment = artifact.Environment with { Timestamp = TrendFixture.Start.AddDays(day - 1) },
                    }
                )
            );
        }
    }

    // -------------------------------------------------------------------------------------
    // The destination may not land inside the input.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task Create_WhenTheReportWouldBeWrittenInsideTheArtifactsDirectory_RefusesEvenWithTheOptIn()
    {
        using var workspace = new TempWorkspace();

        await SeedAsync(workspace);

        var refusal = Assert.Throws<EvalCliException>(() =>
            TrendPlan.Create(Request(workspace, report: $"{ArtifactsDirectory}/trend.md", overwrite: true))
        );

        refusal.ExitCode.Should().Be(ExitCode.UsageError);
        refusal.Message.Should().Contain("--report-markdown").And.Contain("--artifacts");
    }

    [Fact]
    public async Task Create_WhenTheReportWouldReplaceASourceArtifact_RefusesAndLeavesItUntouched()
    {
        using var workspace = new TempWorkspace();

        await SeedAsync(workspace);

        var artifact = Path.Combine(workspace.Root, ArtifactsDirectory, "run-1.json");
        var before = await File.ReadAllTextAsync(artifact);

        var refusal = Assert.Throws<EvalCliException>(() =>
            TrendPlan.Create(Request(workspace, report: $"{ArtifactsDirectory}/run-1.json", overwrite: true))
        );

        refusal.ExitCode.Should().Be(ExitCode.UsageError);
        (await File.ReadAllTextAsync(artifact)).Should().Be(before);
    }

    [Fact]
    public async Task Create_WhenTheReportIsInASubdirectoryOfTheArtifactsDirectory_IsStillRefused()
    {
        using var workspace = new TempWorkspace();

        await SeedAsync(workspace);

        Directory.CreateDirectory(Path.Combine(workspace.Root, ArtifactsDirectory, "reports"));

        Assert.Throws<EvalCliException>(() =>
            TrendPlan.Create(Request(workspace, report: $"{ArtifactsDirectory}/reports/trend.md", overwrite: true))
        );
    }

    [Fact]
    public async Task Create_WhenTheReportIsInASiblingDirectoryWithASharedPrefix_IsAllowed()
    {
        // `trendy` is not inside `trend`. A prefix test on the string would refuse it, and the
        // refusal would be indistinguishable from the real one to whoever hit it.
        using var workspace = new TempWorkspace();

        await SeedAsync(workspace);

        Directory.CreateDirectory(Path.Combine(workspace.Root, "trendy"));

        var plan = TrendPlan.Create(Request(workspace, report: "trendy/trend.md"));

        plan.MarkdownReportPath.Should().NotBeNull();
    }

    [Fact]
    public async Task RecheckDestination_WhenTheRootHasGoneAwayByTheTimeOfTheWrite_DoesNotRepeatIt()
    {
        // Both paths this step re-resolves were produced by this tool, so its refusal must not
        // echo them. Asserted at the call site rather than only on `ForRoot`, because which
        // `PathValue` factory a call site reaches for is the thing that has been wrong three
        // times — and the end-to-end route cannot be provoked: the root has to survive the
        // directory read and vanish before the write, with no seam in between.
        using var workspace = new TempWorkspace();

        await SeedAsync(workspace);

        Directory.CreateDirectory(Path.Combine(workspace.Root, "out"));

        var plan = TrendPlan.Create(Request(workspace, report: "out/trend.md"));
        var gone = plan with { RootDirectory = Path.Combine(workspace.Root, "vanished") };

        var refusal = Assert.Throws<EvalCliException>(() =>
            TrendCommand.RecheckDestination(gone, gone.MarkdownReportPath!)
        );

        refusal.Message.Should().Contain("--root").And.Contain("not repeated");
        (refusal.Message + refusal.Remedy).Should().NotContain(workspace.Root);
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheArtifactsDirectoryGrowsToContainTheDestination_RefusesBeforeWriting()
    {
        // The T14 shape: the answer was true when the arguments were checked and is false by the
        // time of the write. Here the input directory is swapped for a link to the destination's
        // own parent, so the report would land inside the series it was read from.
        using var workspace = new TempWorkspace();

        await SeedAsync(workspace);

        Directory.CreateDirectory(Path.Combine(workspace.Root, "out"));

        var plan = TrendPlan.Create(Request(workspace, report: "out/trend.md"));

        foreach (var file in Directory.GetFiles(Path.Combine(workspace.Root, ArtifactsDirectory)))
        {
            File.Copy(file, Path.Combine(workspace.Root, "out", Path.GetFileName(file)));
        }

        Directory.Delete(Path.Combine(workspace.Root, ArtifactsDirectory), recursive: true);
        workspace.CreateDirectoryLink(ArtifactsDirectory, Path.Combine(workspace.Root, "out"));

        using var console = new RecordingConsole();

        var refusal = await Assert.ThrowsAsync<EvalCliException>(() =>
            TrendCommand.ExecuteAsync(plan, console, CancellationToken.None)
        );

        refusal.Message.Should().Contain("--artifacts");
        File.Exists(Path.Combine(workspace.Root, "out", "trend.md")).Should().BeFalse();
    }

    // -------------------------------------------------------------------------------------
    // An option that cannot act is not accepted.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task Create_WhenTheOptInIsGivenWithNoDestinationToOptInTo_Refuses()
    {
        using var workspace = new TempWorkspace();

        await SeedAsync(workspace);

        var refusal = Assert.Throws<EvalCliException>(() =>
            TrendPlan.Create(Request(workspace, report: null, overwrite: true))
        );

        refusal.ExitCode.Should().Be(ExitCode.UsageError);
        refusal.Message.Should().Contain("--overwrite").And.Contain("--report-markdown");
    }

    // -------------------------------------------------------------------------------------
    // Reading the directory.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task ExecuteAsync_WhenCancelledAfterTheReportWasPublished_TellsTheCallerItWasWritten()
    {
        // **The sixth instance of one property**: any cancellable step occurring after a durable
        // write must report that write. Here the report has already replaced a file the caller
        // had, and the only sentence they read would otherwise be "nothing was written" — which
        // sends them past the file they no longer have.
        using var workspace = new TempWorkspace();

        await SeedAsync(workspace);

        Directory.CreateDirectory(Path.Combine(workspace.Root, "out"));

        var report = Path.Combine(workspace.Root, "out", "trend.md");

        await File.WriteAllTextAsync(report, "the file the caller already had");

        var plan = TrendPlan.Create(Request(workspace, report: "out/trend.md", overwrite: true));

        using var source = new CancellationTokenSource();

        // The first reach for stdout is the instant after every side effect and before any of it
        // is reported — the only place a test can interrupt a command between the two.
        using var console = new RecordingConsole(() => source.Cancel());

        var interrupted = await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            TrendCommand.ExecuteAsync(plan, console, source.Token)
        );

        // The file state and the caller-visible message, both.
        (await File.ReadAllTextAsync(report))
            .Should()
            .StartWith("<!-- eval-cli:trend:");

        using var reported = new RecordingConsole();

        ExitCodeReporter.Report(interrupted, reported).Should().Be(ExitCode.Interrupted);

        reported.StandardError.Should().NotContain("nothing was written");
        reported.StandardError.Should().Contain("out/trend.md").And.NotContain(workspace.Root);
    }

    [Fact]
    public async Task ExecuteAsync_WhenCancelledWithNothingWritten_StillSaysNothingWasWritten()
    {
        // The other half: the blanket sentence is correct when it is correct, and a report that
        // cried leftover on every interruption would be its own false alarm.
        using var workspace = new TempWorkspace();

        await SeedAsync(workspace);

        using var source = new CancellationTokenSource();
        using var console = new RecordingConsole(() => source.Cancel());

        var interrupted = await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            TrendCommand.ExecuteAsync(TrendPlan.Create(Request(workspace, report: null)), console, source.Token)
        );

        using var reported = new RecordingConsole();

        ExitCodeReporter.Report(interrupted, reported);

        reported.StandardError.Should().Contain("nothing was written");
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheArtifactsDirectoryGoesAwayBeforeItIsRead_RefusesRatherThanFaulting()
    {
        using var workspace = new TempWorkspace();

        await SeedAsync(workspace);

        var plan = TrendPlan.Create(Request(workspace, report: null));

        Directory.Delete(Path.Combine(workspace.Root, ArtifactsDirectory), recursive: true);

        using var console = new RecordingConsole();

        var refusal = await Assert.ThrowsAsync<EvalCliException>(() =>
            TrendCommand.ExecuteAsync(plan, console, CancellationToken.None)
        );

        refusal.ExitCode.Should().Be(ExitCode.ComparisonRefused);
        refusal.Message.Should().NotContain(workspace.Root);
    }

    [Fact]
    public async Task ExecuteAsync_WhenAListedArtifactCannotBeFoundWhenItIsRead_RefusesRatherThanTrendingShort()
    {
        using var workspace = new TempWorkspace();

        await SeedAsync(workspace);

        // A dangling link: enumerated as a file, absent when opened. That is the shape of the
        // race between listing a directory and reading it, made deterministic — and the series
        // must not quietly become the two artifacts that survived, because the hole it left
        // would be classified as though something had caused it.
        workspace.CreateFileLink(
            Path.Combine(ArtifactsDirectory, "zz-dangling.json"),
            Path.Combine(workspace.Root, ArtifactsDirectory, "never-written.json")
        );

        var plan = TrendPlan.Create(Request(workspace, report: null));

        using var console = new RecordingConsole();

        var refusal = await Assert.ThrowsAsync<EvalCliException>(() =>
            TrendCommand.ExecuteAsync(plan, console, CancellationToken.None)
        );

        refusal.ExitCode.Should().Be(ExitCode.ComparisonRefused);
        refusal.Message.Should().Contain("zz-dangling.json").And.NotContain(workspace.Root);
        console.StandardOut.Should().BeEmpty();
    }

    [Theory]
    [InlineData(typeof(UnauthorizedAccessException))]
    [InlineData(typeof(IOException))]
    [InlineData(typeof(InvalidOperationException))]
    [InlineData(typeof(ArgumentException))]
    [InlineData(typeof(NotSupportedException))]
    [InlineData(typeof(System.Text.Json.JsonException))]
    public void Unreadable_ForAFailureThatMeansTheFileWillNotRead_IsTreatedAsARefusal(Type failure)
    {
        // UnauthorizedAccessException cannot be provoked portably from a test — it needs an ACL
        // this process can set and not read through — so the classification is pinned directly.
        // It is the one that matters most: uncaught, it reaches the defect handler, which is the
        // only branch that prints a stack trace and with it the machine's layout.
        TrendCommand.Unreadable((Exception)Activator.CreateInstance(failure)!).Should().BeTrue();
    }

    [Fact]
    public void Unreadable_ForACancellation_IsNotTreatedAsARefusal() =>
        TrendCommand.Unreadable(new OperationCanceledException()).Should().BeFalse();
}
