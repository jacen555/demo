using System.Text.Json;
using FluentAssertions;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Tests.Support;

namespace Forge.EvalCli.Tests.Cli;

public class RunCommandTests
{
    private static RunPlan Plan(TempWorkspace workspace, bool dryRun) =>
        RunPlan.Create(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = workspace.Root,
                DryRun = dryRun,
            }
        );

    [Fact]
    public async Task ExecuteAsync_ForADryRun_WritesThePlanToStandardOutAndSucceeds()
    {
        using var workspace = new TempWorkspace();
        using var console = new RecordingConsole();

        var code = await RunCommand.ExecuteAsync(Plan(workspace, dryRun: true), console, CancellationToken.None);

        code.Should().Be(ExitCode.Success);
        console.StandardOut.Should().Contain("Planned run");
        console.StandardError.Should().BeEmpty();
    }

    [Fact]
    public async Task ExecuteAsync_ForADryRun_ReadsNothingAndSoDoesNotRefuseAnInvalidSuite()
    {
        using var workspace = new TempWorkspace();
        using var console = new RecordingConsole();

        // The workspace's default suite declares no scenarios, which the loader refuses. A dry
        // run must still print a plan: it executes nothing, and it is the step a user is told to
        // start with.
        var code = await RunCommand.ExecuteAsync(Plan(workspace, dryRun: true), console, CancellationToken.None);

        code.Should().Be(ExitCode.Success);
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheSuiteDoesNotValidate_RefusesWithTheSuiteErrorCode()
    {
        using var workspace = new TempWorkspace();
        using var console = new RecordingConsole();

        var act = async () =>
            await RunCommand.ExecuteAsync(Plan(workspace, dryRun: false), console, CancellationToken.None);

        var refusal = await act.Should().ThrowAsync<EvalCliException>();

        // The loader refuses rather than guessing, and that refusal has to reach the caller as a
        // distinct, non-zero code. Nothing ran, so nothing may report that it passed.
        refusal.Which.ExitCode.Should().Be(ExitCode.SuiteError);
        refusal.Which.ExitCode.Should().NotBe(ExitCode.Success);
        console.StandardOut.Should().BeEmpty();
    }

    [Fact]
    public async Task ExecuteAsync_WhenNoRunnerIsWiredForAScenarioKind_ReportsAFailedRunRatherThanSuccess()
    {
        using var workspace = new TempWorkspace();
        using var console = new RecordingConsole();

        workspace.WriteFile(
            Path.Combine("eval-suites", "regression.json"),
            SuiteFixture.Suite("regression", SuiteFixture.Scenario("checkout"))
        );

        var code = await RunCommand.ExecuteAsync(Plan(workspace, dryRun: false), console, CancellationToken.None);

        // No --rest-exchange, so nothing conducts the scenario. The engine records the gap; the
        // exit code must not paper over it, because a green check over a suite that was never
        // conducted is worse than no check at all.
        code.Should().Be(ExitCode.RunFailed);
        console.StandardOut.Should().Contain("Run complete").And.Contain("error");
    }

    [Fact]
    public async Task ExecuteAsync_WhenNoChangedFileSetWasAskedFor_RunsEverythingAndSaysWhy()
    {
        using var workspace = new TempWorkspace();
        using var console = new RecordingConsole();

        workspace.WriteFile(
            Path.Combine("eval-suites", "regression.json"),
            SuiteFixture.Suite(
                "regression",
                SuiteFixture.Scenario("checkout", ["src/**"]),
                SuiteFixture.Scenario("billing", ["docs/**"])
            )
        );

        await RunCommand.ExecuteAsync(Plan(workspace, dryRun: false), console, CancellationToken.None);

        console.StandardOut.Should().Contain("2 of 2 scenarios ran");
        console.StandardOut.Should().Contain("no --changed-since revision was given");
        console.StandardOut.Should().Contain("fallback");
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheRunIsSelective_RunsOnlyTheImpactedScenariosAndReportsTheReason()
    {
        using var repository = new GitWorkspace();
        await using var endpoint = new StubEndpoint(_ => (200, "{ \"output\": \"ok\", \"outcome\": \"done\" }"));
        using var console = new RecordingConsole();

        repository.Write("src/Checkout.cs", "original");
        repository.Write("docs/billing.md", "original");
        repository.Write(
            "eval-suites/regression.json",
            SuiteFixture.Suite(
                "regression",
                SuiteFixture.Scenario("checkout", ["src/**"]),
                SuiteFixture.Scenario("billing", ["docs/**"])
            )
        );
        repository.Write(".gitignore", "artifacts/\n");
        repository.Commit("baseline");

        // A baseline recording a trustworthy pass for both scenarios, produced by a real run
        // rather than hand-written — a hand-written one would pin this test to a fingerprint
        // rather than to the behaviour.
        Directory.CreateDirectory(Path.Combine(repository.Root, "artifacts"));

        var first = await RunCommand.ExecuteAsync(
            Request(repository, endpoint, changedSince: null, output: "artifacts/baseline.json"),
            console,
            CancellationToken.None
        );

        first.Should().Be(ExitCode.Success, console.StandardError);
        endpoint.Requests.Should().Be(2);

        // Now change one file, and select against the baseline.
        repository.Write("src/Checkout.cs", "changed");

        using var selective = new RecordingConsole();

        var second = await RunCommand.ExecuteAsync(
            Request(repository, endpoint, changedSince: "HEAD", output: null, json: true),
            selective,
            CancellationToken.None
        );

        second.Should().Be(ExitCode.Success, selective.StandardError);

        using var report = JsonDocument.Parse(selective.StandardOut);
        var root = report.RootElement;

        root.GetProperty("scenariosInSuite").GetInt32().Should().Be(2);
        root.GetProperty("scenariosSelected").GetInt32().Should().Be(1);
        root.GetProperty("scenariosSkipped").EnumerateArray().Select(e => e.GetString()).Should().Equal("billing");
        root.GetProperty("fallbackReason").ValueKind.Should().Be(JsonValueKind.Null);
        root.GetProperty("changedFiles").GetProperty("established").GetBoolean().Should().BeTrue();
        root.GetProperty("changedFiles").GetProperty("count").GetInt32().Should().Be(1);

        var selected = root.GetProperty("selected").EnumerateArray().Single();

        // The count alone is not a claim anybody can check. The reason and its detail are.
        selected.GetProperty("scenarioId").GetString().Should().Be("checkout");
        selected.GetProperty("reason").GetString().Should().Be("glob-match");
        selected.GetProperty("detail").GetString().Should().Contain("src/Checkout.cs").And.Contain("src/**");

        // And only the impacted scenario was actually conducted.
        endpoint.Requests.Should().Be(3);
    }

    [Fact]
    public async Task ExecuteAsync_WhenAnArtifactDestinationWasGiven_WritesTheRunThere()
    {
        using var repository = new GitWorkspace();
        await using var endpoint = new StubEndpoint(_ => (200, "{ \"output\": \"ok\" }"));
        using var console = new RecordingConsole();

        repository.Write("src/Checkout.cs", "original");
        repository.Write(
            "eval-suites/regression.json",
            SuiteFixture.Suite("regression", SuiteFixture.Scenario("checkout", ["src/**"]))
        );
        repository.Commit("baseline");
        Directory.CreateDirectory(Path.Combine(repository.Root, "artifacts"));

        var code = await RunCommand.ExecuteAsync(
            Request(repository, endpoint, changedSince: null, output: "artifacts/eval.json"),
            console,
            CancellationToken.None
        );

        var artifact = Path.Combine(repository.Root, "artifacts", "eval.json");

        code.Should().Be(ExitCode.Success, console.StandardError);
        File.Exists(artifact).Should().BeTrue("a run that reports success must leave the evidence it claims");
        (await File.ReadAllTextAsync(artifact, CancellationToken.None)).Should().Contain("checkout");
        console.StandardOut.Should().Contain(artifact);
    }

    [Fact]
    public async Task ExecuteAsync_WhenAFileAppearsAtTheDestinationDuringTheRun_RefusesRatherThanReplacingIt()
    {
        using var repository = new GitWorkspace();
        using var console = new RecordingConsole();

        repository.Write("src/Checkout.cs", "original");
        repository.Write(
            "eval-suites/regression.json",
            SuiteFixture.Suite("regression", SuiteFixture.Scenario("checkout", ["src/**"]))
        );
        repository.Commit("baseline");
        Directory.CreateDirectory(Path.Combine(repository.Root, "artifacts"));

        var plan = RunPlan.Create(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = repository.Root,
                Out = "artifacts/eval.json",
            }
        );

        // The destination was clear when the arguments were validated. Something else got there
        // while the run was in flight — a race the validation cannot close on its own.
        var destination = Path.Combine(repository.Root, "artifacts", "eval.json");

        await File.WriteAllTextAsync(destination, "somebody else's artifact", CancellationToken.None);

        var act = async () => await RunCommand.ExecuteAsync(plan, console, CancellationToken.None);

        (await act.Should().ThrowAsync<EvalCliException>()).Which.ExitCode.Should().Be(ExitCode.RunFailed);

        // The safe default is not just a refusal: what was there is still there.
        (await File.ReadAllTextAsync(destination, CancellationToken.None))
            .Should()
            .Be("somebody else's artifact");
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheSuiteDeclaresNoScenarios_RefusesRatherThanReportingSuccess()
    {
        using var workspace = new TempWorkspace();
        using var console = new RecordingConsole();

        workspace.WriteFile(Path.Combine("eval-suites", "regression.json"), SuiteFixture.Suite("regression"));

        var act = async () =>
            await RunCommand.ExecuteAsync(Plan(workspace, dryRun: false), console, CancellationToken.None);

        var refusal = await act.Should().ThrowAsync<EvalCliException>();

        // `0 of 0` is a green check over an evaluation that never happened. It helps a human
        // reading stdout and tells an automated caller — which reads only the code — that the
        // suite passed. Refused before the run rather than reported after it.
        refusal.Which.ExitCode.Should().Be(ExitCode.SuiteError);
        refusal.Which.ExitCode.Should().NotBe(ExitCode.Success);
        console.StandardOut.Should().BeEmpty();
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheArtifactDirectoryBecomesALinkDuringTheRun_WritesNothingOutsideTheRoot()
    {
        using var workspace = new TempWorkspace();
        await using var endpoint = new StubEndpoint(_ => (200, "{ \"output\": \"ok\" }"));
        using var console = new RecordingConsole();

        workspace.WriteFile(
            Path.Combine("eval-suites", "regression.json"),
            SuiteFixture.Suite("regression", SuiteFixture.Scenario("checkout"))
        );

        var plan = RunPlan.Create(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = workspace.Root,
                Out = "artifacts/eval.json",
                Endpoint = endpoint.Address.ToString(),
                RestExchange = "json",
            }
        );

        // Validated against a real directory inside the root. Something swaps its *parent* for a
        // link out of the root while the run is in flight — the window a check before the run
        // cannot close, and one that CreateNew alone does not close either: the mode governs the
        // leaf, and it is the path to the leaf that moved.
        Directory.Delete(Path.Combine(workspace.Root, "artifacts"), recursive: true);
        workspace.CreateDirectoryLink("artifacts", workspace.Outside);

        var act = async () => await RunCommand.ExecuteAsync(plan, console, CancellationToken.None);

        (await act.Should().ThrowAsync<EvalCliException>()).Which.ExitCode.Should().Be(ExitCode.RunFailed);

        Directory
            .EnumerateFileSystemEntries(workspace.Outside)
            .Should()
            .BeEmpty("a redirected destination must be refused, not followed");
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheArtifactDirectoryBecomesALinkDuringTheRunWithOverwrite_TruncatesNothing()
    {
        using var workspace = new TempWorkspace();
        await using var endpoint = new StubEndpoint(_ => (200, "{ \"output\": \"ok\" }"));
        using var console = new RecordingConsole();

        workspace.WriteFile(
            Path.Combine("eval-suites", "regression.json"),
            SuiteFixture.Suite("regression", SuiteFixture.Scenario("checkout"))
        );

        var bystander = Path.Combine(workspace.Outside, "eval.json");

        await File.WriteAllTextAsync(bystander, "somebody else's file", CancellationToken.None);

        var plan = RunPlan.Create(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = workspace.Root,
                Out = "artifacts/eval.json",
                Overwrite = true,
                Endpoint = endpoint.Address.ToString(),
                RestExchange = "json",
            }
        );

        Directory.Delete(Path.Combine(workspace.Root, "artifacts"), recursive: true);
        workspace.CreateDirectoryLink("artifacts", workspace.Outside);

        var act = async () => await RunCommand.ExecuteAsync(plan, console, CancellationToken.None);

        (await act.Should().ThrowAsync<EvalCliException>()).Which.ExitCode.Should().Be(ExitCode.RunFailed);

        // --overwrite is an opt-in to replacing the file the caller named inside the root. It is
        // not an opt-in to truncating whatever a swapped link happens to lead to.
        (await File.ReadAllTextAsync(bystander, CancellationToken.None))
            .Should()
            .Be("somebody else's file");
    }

    [Fact]
    public async Task ExecuteAsync_WhenCancellationWasAlreadyRequested_ThrowsRatherThanReportingAPlan()
    {
        using var workspace = new TempWorkspace();
        using var console = new RecordingConsole();
        using var cancelled = new CancellationTokenSource();

        await cancelled.CancelAsync();

        var act = async () => await RunCommand.ExecuteAsync(Plan(workspace, dryRun: true), console, cancelled.Token);

        await act.Should().ThrowAsync<OperationCanceledException>();

        // And the reporter turns that into a non-zero exit, not a silent success.
        ExitCodeReporter.Classify(new OperationCanceledException()).Should().Be(ExitCode.Interrupted);
        console.StandardOut.Should().BeEmpty();
    }

    [Fact]
    public async Task ExecuteAsync_WhenThePlanIsNull_Throws()
    {
        using var console = new RecordingConsole();

        var act = async () => await RunCommand.ExecuteAsync(null!, console, CancellationToken.None);

        await act.Should().ThrowAsync<ArgumentNullException>();
    }

    private static RunPlan Request(
        GitWorkspace repository,
        StubEndpoint endpoint,
        string? changedSince,
        string? output,
        bool json = false
    ) =>
        RunPlan.Create(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = repository.Root,
                Baseline = changedSince is null ? null : "artifacts/baseline.json",
                Out = output,
                Endpoint = endpoint.Address.ToString(),
                RestExchange = "json",
                ChangedSince = changedSince,
                Json = json,
            }
        );
}
