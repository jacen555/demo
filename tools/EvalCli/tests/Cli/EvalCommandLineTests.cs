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
    public async Task Invoke_WithoutDryRunAgainstASuiteThatDoesNotValidate_ExitsWithTheSuiteErrorCode()
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
        // turns a red result into a green CI check. The loader refuses this suite — it declares
        // no scenarios — and the refusal has to reach the caller as a distinct non-zero code.
        exitCode.Should().Be((int)ExitCode.SuiteError);
        exitCode.Should().NotBe((int)ExitCode.Success);
        standardOut.Should().BeEmpty();
        standardError.Should().Contain("did not validate");
    }

    [Fact]
    public async Task Invoke_WithTheGateFlag_RefusesRatherThanPassingAGateThatNeverRan()
    {
        using var workspace = new TempWorkspace();

        var (exitCode, standardOut, standardError) = await InvokeAsync(DryRunArgs(workspace, "--fail-on-regression"));

        // The defect: someone wires --fail-on-regression into CI, watches it go green, and
        // believes a regression would have stopped them. A documented reservation does not reach
        // that person; a non-zero exit on the invocation that asked for it does.
        exitCode.Should().NotBe((int)ExitCode.Success);
        exitCode.Should().Be((int)ExitCode.NotImplemented);
        standardOut.Should().BeEmpty();
        standardError.Should().Contain("--fail-on-regression");
    }

    [Fact]
    public async Task Invoke_WithTheGateFlag_NamesWhatTheGateWillDoAndThatItIsNotHereYet()
    {
        using var workspace = new TempWorkspace();

        var (_, _, standardError) = await InvokeAsync(DryRunArgs(workspace, "--fail-on-regression"));

        // A refusal that only says "no" sends the reader looking for a typo. This one has to say
        // what the flag will do, and that the exits it will use are held for it.
        standardError.Should().Contain("regression");
        standardError.Should().Contain($"{ExitCodes.GateRangeStart}-{ExitCodes.GateRangeEnd}");
    }

    [Fact]
    public async Task Invoke_WithTheGateFlagAndNoDryRun_RefusesBeforeConductingAnything()
    {
        using var workspace = new TempWorkspace();

        var before = Directory.GetFiles(workspace.Root, "*", SearchOption.AllDirectories);

        var (exitCode, _, _) = await InvokeAsync(
            "run",
            "--suite",
            "eval-suites/regression.json",
            "--root",
            workspace.Root,
            "--fail-on-regression"
        );

        // Refused while the arguments are validated, so the cost of asking for a gate that is not
        // here is nothing at all.
        exitCode.Should().Be((int)ExitCode.NotImplemented);
        Directory.GetFiles(workspace.Root, "*", SearchOption.AllDirectories).Should().BeEquivalentTo(before);
    }

    [Fact]
    public async Task Invoke_WithoutTheGateFlag_StillReportsTheReportOnlyMode()
    {
        using var workspace = new TempWorkspace();

        var (exitCode, standardOut, _) = await InvokeAsync(DryRunArgs(workspace));

        // Refusing the flag must not remove the statement that this build does not gate. The
        // mode is what a reader of a plan needs; the flag is what a CI author wires.
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
    public async Task Invoke_WithHelp_DoesNotCallBaselineUpdateTheOnlyDestructiveRoute()
    {
        // `run --out <path> --overwrite` replaces an existing file, and that file may be a
        // baseline the invocation did not name. Calling `baseline update` the only destructive
        // thing the tool does is the documentation not having caught up with that.
        var (_, standardOut, _) = await InvokeAsync("--help");

        standardOut.Should().NotContain("the one destructive thing this tool does");
    }

    [Fact]
    public async Task Invoke_WithHelp_SaysWhatBaselineUpdateAddsOverAPlainOverwrite()
    {
        var (_, standardOut, _) = await InvokeAsync("--help");

        // What the command actually is: the previewed, verified route, not the only one.
        standardOut.Should().Contain("previews");
        standardOut.Should().Contain("verifies");
    }

    [Fact]
    public async Task Invoke_WithHelp_StatesTheNarrowerGuaranteeRunActuallyHolds()
    {
        var (_, standardOut, _) = await InvokeAsync("--help");

        // The guarantee `run` can hold is about its own inputs, not about baselines in general.
        standardOut.Should().Contain("--suite");
        standardOut.Should().Contain("never replaces");
    }

    [Fact]
    public async Task Invoke_WithHelp_DocumentsThreeAsARunOrPublicationFailure()
    {
        var (_, standardOut, _) = await InvokeAsync("--help");

        // A completed run can earn 3 when publication fails, so the description may not say only
        // that the run could not complete.
        standardOut.Should().Contain("could not be published");
    }

    [Fact]
    public async Task Invoke_WithHelpForBaselineUpdate_DoesNotClaimTheBaselineIsNeverModified()
    {
        // The description is shared with `run`, where it is true. Rendered here it sits beside
        // --apply, which replaces exactly that file.
        var (exitCode, standardOut, _) = await InvokeAsync("baseline", "update", "--help");

        exitCode.Should().Be((int)ExitCode.Success);
        standardOut.Should().Contain("--baseline");
        standardOut.Should().NotContain("never modified");
    }

    [Fact]
    public async Task Invoke_WithHelpForBaselineUpdate_SaysWhichCommandReplacesTheBaselineAndWhichDoesNot()
    {
        var (_, standardOut, _) = await InvokeAsync("baseline", "update", "--help");

        // One sentence that is true in both renderings: it has to name the asymmetry rather than
        // pick whichever command it was written against.
        standardOut.Should().Contain("replaces it");
    }

    [Fact]
    public async Task Invoke_WithHelpForTheRunCommand_StillSaysRunDoesNotModifyTheBaseline()
    {
        // The correction must not cost `run` the guarantee it genuinely holds.
        var (_, standardOut, _) = await InvokeAsync("run", "--help");

        standardOut.Should().Contain("never modifies it");
    }

    [Fact]
    public async Task Invoke_WithHelpForTheRunCommand_DoesNotClaimOmittingOutWritesNothingAtAll()
    {
        // `run --baseline ... --report-markdown <path>` writes a file with no --out at all.
        var (_, standardOut, _) = await InvokeAsync("run", "--help");

        standardOut.Should().Contain("--out");
        standardOut.Should().NotContain("nothing is written at all");
    }

    [Fact]
    public async Task Invoke_WithHelpForTheRunCommand_SaysOutDoesNotGovernTheReport()
    {
        var (_, standardOut, _) = await InvokeAsync("run", "--help");

        standardOut.Should().Contain("no artifact is written");
    }

    [Fact]
    public async Task Invoke_WithHelpForTrend_DoesNotDescribeTheOptInWithAnOptionTrendDoesNotHave()
    {
        // The whole point of splitting the instance: `trend` declares no --out, so its help must
        // not name one. Asserted on the phrase from `run`'s description rather than on "--out"
        // alone, because the safe-path preamble legitimately mentions --out while describing
        // `run` — a bare NotContain would pass or fail for the wrong reason.
        var (exitCode, standardOut, _) = await InvokeAsync("trend", "--help");

        exitCode.Should().Be((int)ExitCode.Success);
        standardOut.Should().Contain("--overwrite");
        standardOut.Should().NotContain("Allow --out and --report-markdown");
    }

    [Fact]
    public async Task Invoke_WithHelpForTrend_DescribesTheOptInAgainstTheOneDestinationTrendHas()
    {
        var (_, standardOut, _) = await InvokeAsync("trend", "--help");

        // A phrase that can only come from the opt-in's own description. Asserting "trend report"
        // alone would pass on --report-markdown's text and prove nothing about --overwrite.
        standardOut.Should().Contain("replace an existing trend report");
    }

    [Fact]
    public async Task Invoke_WithHelpForTheRunCommand_SaysTheOptInIsRefusedWithNoDestination()
    {
        // This group made --overwrite refuse an invocation that names neither destination. The
        // help did not say so.
        var (_, standardOut, _) = await InvokeAsync("run", "--help");

        standardOut.Should().Contain("refused if neither is named");
    }

    [Fact]
    public async Task Invoke_WithHelpForTheRunCommand_SaysTheOptInNeverLiftsAnInputCollision()
    {
        var (_, standardOut, _) = await InvokeAsync("run", "--help");

        standardOut.Should().Contain("never a file this invocation reads");
    }

    [Fact]
    public void BindTrendRequest_WhenTheOptInIsGiven_ReadsTheInstanceTrendActuallyDeclares()
    {
        // **The hazard the split creates, pinned.** Options are instance fields: if `trend` is
        // built with one instance and bound from another, every value comes back as its default
        // — false here — which is indistinguishable from the caller not passing the flag. The
        // failure mode is a report that silently refuses to replace, or worse, one that does.
        var cli = new EvalCommandLine();

        cli.BindTrendRequest(Parse(cli, "trend", "--artifacts", "trend", "--overwrite")).Overwrite.Should().BeTrue();
    }

    [Fact]
    public void BindTrendRequest_WhenTheOptInIsOmitted_StillReadsFalseRatherThanNothing()
    {
        var cli = new EvalCommandLine();

        cli.BindTrendRequest(Parse(cli, "trend", "--artifacts", "trend")).Overwrite.Should().BeFalse();
    }

    [Fact]
    public void BindRequest_WhenTheOptInIsGiven_ReadsTheInstanceRunActuallyDeclares()
    {
        var cli = new EvalCommandLine();

        cli.BindRequest(Parse(cli, "run", "--suite", "s.json", "--overwrite")).Overwrite.Should().BeTrue();
    }

    private static ParseResult Parse(EvalCommandLine cli, params string[] args) => cli.BuildParser().Parse(args);

    [Fact]
    public async Task Invoke_WithHelp_SaysTheGateRangeIsReserved()
    {
        var (_, standardOut, _) = await InvokeAsync("--help");

        standardOut.Should().Contain($"{ExitCodes.GateRangeStart}-{ExitCodes.GateRangeEnd}");
        standardOut.Should().Contain("reserved");
    }

    [Fact]
    public async Task Invoke_WithHelpForTheRunCommand_SaysTheGateFlagIsNotAvailableYet()
    {
        var (exitCode, standardOut, _) = await InvokeAsync("run", "--help");

        exitCode.Should().Be((int)ExitCode.Success);
        standardOut.Should().Contain("--fail-on-regression");

        // "RESERVED" read as "accepted, does nothing yet". The help has to say the invocation is
        // refused, because that is what the caller will actually meet.
        standardOut.Should().Contain("Not yet available");
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
