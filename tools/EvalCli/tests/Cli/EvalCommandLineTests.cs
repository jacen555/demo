using System.CommandLine.Parsing;
using System.Text.Json;
using FluentAssertions;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Tests.Support;

namespace Forge.EvalCli.Tests.Cli;

/// <summary>
/// End-to-end through the real parser pipeline. These are the tests that pin the contract a CI
/// step actually depends on: what lands on stdout, what lands on stderr, and what the process
/// exits with.
/// </summary>
public class EvalCommandLineTests
{
    private static async Task<(int ExitCode, string StandardOut, string StandardError)> InvokeAsync(
        params string[] args
    )
    {
        using var console = new RecordingConsole();

        var exitCode = await EvalCommandLine.Build().InvokeAsync(args, console);

        return (exitCode, console.StandardOut, console.StandardError);
    }

    private static string[] DryRunArgs(TempWorkspace workspace, params string[] extra) =>
        ["run", "--suite", "eval-suites/regression.json", "--root", workspace.Root, "--dry-run", .. extra];

    [Fact]
    public async Task Invoke_WithDryRun_WritesThePlanToStandardOutAndExitsSuccess()
    {
        using var workspace = new TempWorkspace();

        var (exitCode, standardOut, standardError) = await InvokeAsync(DryRunArgs(workspace));

        exitCode.Should().Be((int)ExitCode.Success);
        standardOut.Should().Contain("Planned run");
        standardOut.Should().Contain("nothing was executed");
        standardError.Should().BeEmpty();
    }

    [Fact]
    public async Task Invoke_WithoutDryRun_ExitsNonZeroBecauseNothingRan()
    {
        using var workspace = new TempWorkspace();

        var (exitCode, standardOut, standardError) = await InvokeAsync(
            "run",
            "--suite",
            "eval-suites/regression.json",
            "--root",
            workspace.Root
        );

        // The defect this guards against: reporting a failure and exiting zero anyway, which
        // turns a red result into a green CI check.
        exitCode.Should().Be((int)ExitCode.NotImplemented);
        exitCode.Should().NotBe((int)ExitCode.Success);
        standardOut.Should().BeEmpty();
        standardError.Should().Contain("not wired up");
    }

    [Fact]
    public async Task Invoke_WithDryRunAndTheReservedGateFlag_StillExitsSuccess()
    {
        using var workspace = new TempWorkspace();

        var (exitCode, standardOut, _) = await InvokeAsync(DryRunArgs(workspace, "--fail-on-regression"));

        // Reserved means parsed and reported, not acted on.
        exitCode.Should().Be((int)ExitCode.Success);
        standardOut.Should().Contain("report-only");
    }

    [Fact]
    public async Task Invoke_WithDryRunAndJson_WritesOnlyMachineReadableOutputToStandardOut()
    {
        using var workspace = new TempWorkspace();

        var (exitCode, standardOut, standardError) = await InvokeAsync(DryRunArgs(workspace, "--json"));

        exitCode.Should().Be((int)ExitCode.Success);
        standardError.Should().BeEmpty();

        using var document = JsonDocument.Parse(standardOut);

        document.RootElement.GetProperty("executed").GetBoolean().Should().BeFalse();
    }

    [Fact]
    public async Task Invoke_WithNoArgumentsAtAll_ShowsHelpOnStandardErrorAndExitsUsageError()
    {
        var (exitCode, standardOut, standardError) = await InvokeAsync();

        exitCode.Should().Be((int)ExitCode.UsageError);
        standardOut.Should().BeEmpty("a caller piping stdout must not receive help text as a result");
        standardError.Should().Contain("Start here");
    }

    [Fact]
    public async Task Invoke_WithAnUnknownFlag_ExitsUsageErrorAndKeepsStandardOutClean()
    {
        using var workspace = new TempWorkspace();

        var (exitCode, standardOut, standardError) = await InvokeAsync([.. DryRunArgs(workspace), "--not-a-real-flag"]);

        exitCode.Should().Be((int)ExitCode.UsageError);
        standardOut.Should().BeEmpty();
        standardError.Should().Contain("--not-a-real-flag");
    }

    [Fact]
    public async Task Invoke_WithoutTheRequiredSuiteOption_ExitsUsageError()
    {
        using var workspace = new TempWorkspace();

        var (exitCode, standardOut, _) = await InvokeAsync("run", "--root", workspace.Root, "--dry-run");

        exitCode.Should().Be((int)ExitCode.UsageError);
        standardOut.Should().BeEmpty();
    }

    [Fact]
    public async Task Invoke_WhenTheSuitePathEscapesTheRoot_ExitsUsageErrorAndWritesNothingToStandardOut()
    {
        using var workspace = new TempWorkspace();

        var (exitCode, standardOut, standardError) = await InvokeAsync(
            "run",
            "--suite",
            "../../elsewhere.json",
            "--root",
            workspace.Root,
            "--dry-run"
        );

        exitCode.Should().Be((int)ExitCode.UsageError);
        standardOut.Should().BeEmpty();
        standardError.Should().Contain("outside the root");
    }

    [Fact]
    public async Task Invoke_WhenTheDestinationWouldClobberAnExistingFile_RefusesAndLeavesItUntouched()
    {
        using var workspace = new TempWorkspace();

        var existing = workspace.WriteFile(Path.Combine("artifacts", "eval.json"), "the developer's own artifact");

        var (exitCode, standardOut, standardError) = await InvokeAsync([
            .. DryRunArgs(workspace),
            "--out",
            "artifacts/eval.json",
        ]);

        exitCode.Should().Be((int)ExitCode.UsageError);
        standardOut.Should().BeEmpty();
        standardError.Should().Contain("--overwrite");
        (await File.ReadAllTextAsync(existing)).Should().Be("the developer's own artifact");
    }

    [Fact]
    public async Task Invoke_WhenTheDestinationWouldClobberAndOverwriteWasPassed_Proceeds()
    {
        using var workspace = new TempWorkspace();

        var existing = workspace.WriteFile(Path.Combine("artifacts", "eval.json"), "the developer's own artifact");

        var (exitCode, standardOut, _) = await InvokeAsync([
            .. DryRunArgs(workspace),
            "--out",
            "artifacts/eval.json",
            "--overwrite",
        ]);

        exitCode.Should().Be((int)ExitCode.Success);
        standardOut.Should().Contain("allowed");

        // A dry run still writes nothing, even with the opt-in.
        (await File.ReadAllTextAsync(existing))
            .Should()
            .Be("the developer's own artifact");
    }

    [Fact]
    public async Task Invoke_WithNoDestination_WritesNothingToDisk()
    {
        using var workspace = new TempWorkspace();

        var before = Directory.GetFiles(workspace.Root, "*", SearchOption.AllDirectories);

        var (exitCode, _, _) = await InvokeAsync(DryRunArgs(workspace));

        exitCode.Should().Be((int)ExitCode.Success);
        Directory.GetFiles(workspace.Root, "*", SearchOption.AllDirectories).Should().BeEquivalentTo(before);
    }

    [Fact]
    public async Task Invoke_WhenTheEndpointCarriesCredentials_RefusesWithoutEchoingTheSecret()
    {
        using var workspace = new TempWorkspace();

        var (exitCode, standardOut, standardError) = await InvokeAsync([
            .. DryRunArgs(workspace),
            "--endpoint",
            "https://someone:hunter2@example.com/api",
        ]);

        exitCode.Should().Be((int)ExitCode.UsageError);
        standardOut.Should().NotContain("hunter2");
        standardError.Should().NotContain("hunter2");
        standardError.Should().Contain("credentials in the URL");
    }

    [Fact]
    public async Task Invoke_WhenTheEndpointCarriesAQueryString_NeverPrintsIt()
    {
        using var workspace = new TempWorkspace();

        var (exitCode, standardOut, standardError) = await InvokeAsync([
            .. DryRunArgs(workspace),
            "--endpoint",
            "https://example.com/api?token=abcdef",
        ]);

        exitCode.Should().Be((int)ExitCode.Success);
        standardOut.Should().NotContain("abcdef");
        standardError.Should().NotContain("abcdef");
    }

    [Fact]
    public async Task Invoke_WhenTheEndpointHidesACredentialInThePath_NeverPrintsIt()
    {
        using var workspace = new TempWorkspace();

        var (exitCode, standardOut, standardError) = await InvokeAsync([
            .. DryRunArgs(workspace),
            "--endpoint",
            "https://evals.example.com/api/sk-live-abc123/run",
        ]);

        exitCode.Should().Be((int)ExitCode.Success);
        standardOut.Should().NotContain("sk-live-abc123");
        standardError.Should().NotContain("sk-live-abc123");

        // Still enough to confirm which environment was addressed.
        standardOut.Should().Contain("https://evals.example.com");
    }

    [Fact]
    public async Task Invoke_WhenTheEndpointHidesACredentialInThePathAndJsonWasAsked_NeverSerializesIt()
    {
        using var workspace = new TempWorkspace();

        var (exitCode, standardOut, standardError) = await InvokeAsync([
            .. DryRunArgs(workspace),
            "--json",
            "--endpoint",
            "https://evals.example.com/api/sk-live-abc123/run",
        ]);

        exitCode.Should().Be((int)ExitCode.Success);
        standardOut.Should().NotContain("sk-live-abc123");
        standardError.Should().NotContain("sk-live-abc123");

        using var document = JsonDocument.Parse(standardOut);

        document.RootElement.GetProperty("endpoint").GetString().Should().NotContain("sk-live-abc123");
    }

    [Fact]
    public async Task Invoke_WithAnUnrecognizedArgumentCarryingAQueryToken_DoesNotEchoTheTokenInTheParseError()
    {
        // No `run`, so the parse fails before any handler is reached and before anything has
        // interpreted this value as an endpoint. The redaction has to live at the output boundary
        // to catch it at all.
        var (exitCode, standardOut, standardError) = await InvokeAsync(
            "https://evals.example.com/api?token=sk-live-abc123"
        );

        exitCode.Should().Be((int)ExitCode.UsageError);
        standardOut.Should().BeEmpty();
        standardError.Should().NotContain("sk-live-abc123");
        standardError.Should().NotContain("token=");
        standardError.Should().Contain("Unrecognized command or argument");
    }

    [Fact]
    public async Task Invoke_WhenAnOptionValueCarryingAQueryTokenFailsToParse_DoesNotEchoTheToken()
    {
        using var workspace = new TempWorkspace();

        var (exitCode, standardOut, standardError) = await InvokeAsync([
            .. DryRunArgs(workspace),
            "--seed",
            "https://evals.example.com/api?token=sk-live-abc123",
        ]);

        exitCode.Should().Be((int)ExitCode.UsageError);
        standardOut.Should().BeEmpty();
        standardError.Should().NotContain("sk-live-abc123");

        // The message must still say which option was wrong; that part is the parser's, not the
        // caller's, and it is the whole reason the message exists.
        standardError.Should().Contain("--seed");
    }

    [Fact]
    public async Task Invoke_WhenTheDestinationIsReachedThroughADirectoryLinkOutOfTheRoot_Refuses()
    {
        using var workspace = new TempWorkspace();

        var bystander = Path.Combine(workspace.Outside, "someone-elses.json");

        await File.WriteAllTextAsync(bystander, "not this tool's to touch");
        workspace.CreateDirectoryLink("linked", workspace.Outside);

        var (exitCode, standardOut, standardError) = await InvokeAsync([
            .. DryRunArgs(workspace),
            "--out",
            "linked/someone-elses.json",
            "--overwrite",
        ]);

        exitCode.Should().Be((int)ExitCode.UsageError);
        standardOut.Should().BeEmpty();
        standardError.Should().Contain("link");
        (await File.ReadAllTextAsync(bystander)).Should().Be("not this tool's to touch");
    }

    [Fact]
    public async Task Invoke_WhenMaxConcurrencyIsBelowOne_ExitsUsageError()
    {
        using var workspace = new TempWorkspace();

        var (exitCode, _, standardError) = await InvokeAsync([.. DryRunArgs(workspace), "--max-concurrency", "0"]);

        exitCode.Should().Be((int)ExitCode.UsageError);
        standardError.Should().Contain("--max-concurrency");
    }

    [Fact]
    public async Task Invoke_WhenAnIntegerOptionIsNotANumber_ExitsUsageError()
    {
        using var workspace = new TempWorkspace();

        var (exitCode, standardOut, _) = await InvokeAsync([.. DryRunArgs(workspace), "--seed", "not-a-number"]);

        exitCode.Should().Be((int)ExitCode.UsageError);
        standardOut.Should().BeEmpty();
    }

    [Fact]
    public async Task Invoke_WithHelp_ShowsTheSafePathBeforeTheOptions()
    {
        var (exitCode, standardOut, _) = await InvokeAsync("--help");

        exitCode.Should().Be((int)ExitCode.Success);
        standardOut.Should().Contain("--dry-run");
        standardOut
            .IndexOf("Start here", StringComparison.Ordinal)
            .Should()
            .BeLessThan(standardOut.IndexOf("Options:", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Invoke_WithHelp_DocumentsEveryExitCode()
    {
        var (_, standardOut, _) = await InvokeAsync("--help");

        foreach (var entry in ExitCodes.Documented)
        {
            standardOut.Should().Contain(entry.Meaning);
        }
    }

    [Fact]
    public async Task Invoke_WithHelp_SaysTheGateRangeIsReserved()
    {
        var (_, standardOut, _) = await InvokeAsync("--help");

        standardOut.Should().Contain($"{ExitCodes.GateRangeStart}-{ExitCodes.GateRangeEnd}");
        standardOut.Should().Contain("reserved");
    }

    [Fact]
    public async Task Invoke_WithHelpForTheRunCommand_DocumentsTheReservedGateFlagAsNotImplemented()
    {
        var (exitCode, standardOut, _) = await InvokeAsync("run", "--help");

        exitCode.Should().Be((int)ExitCode.Success);
        standardOut.Should().Contain("--fail-on-regression");
        standardOut.Should().Contain("RESERVED");
    }

    [Fact]
    public async Task Invoke_WithDryRun_NamesEveryUnwiredRunnerKind()
    {
        using var workspace = new TempWorkspace();

        var (_, standardOut, _) = await InvokeAsync(DryRunArgs(workspace));

        standardOut.Should().Contain("IRestExchange");
        standardOut.Should().Contain("IConversationExchange");
    }
}
