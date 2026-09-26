using FluentAssertions;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Tests.Support;

namespace Forge.EvalCli.Tests.Cli;

public class RunPlanTests
{
    private static RunRequest Minimal(TempWorkspace workspace) =>
        new() { Suite = "eval-suites/regression.json", Root = workspace.Root };

    [Fact]
    public void Create_WithTheMinimumArguments_PlansToWriteNothing()
    {
        using var workspace = new TempWorkspace();

        var plan = RunPlan.Create(Minimal(workspace));

        plan.ArtifactPath.Should().BeNull("the default invocation must not write anything");
        plan.OverwriteArtifact.Should().BeFalse();
        plan.BaselinePath.Should().BeNull();
        plan.Endpoint.Should().BeNull();
        plan.DryRun.Should().BeFalse();
    }

    [Fact]
    public void Create_WithTheMinimumArguments_UsesTheConservativeDefaults()
    {
        using var workspace = new TempWorkspace();

        var plan = RunPlan.Create(Minimal(workspace));

        plan.MaxConcurrency.Should().Be(1, "load on somebody else's system is opted into, never inherited");
        plan.MaxTotalRuns.Should().Be(RunPlan.DefaultMaxTotalRuns);
        plan.RootSeed.Should().Be(0);
    }

    [Fact]
    public void Create_WhenTheGateFlagIsPassed_RefusesRatherThanAcceptingAGateNothingEnforces()
    {
        using var workspace = new TempWorkspace();

        var refusal = Assert.Throws<EvalCliException>(() =>
            RunPlan.Create(Minimal(workspace) with { FailOnRegression = true })
        );

        // Accepting the flag is the defect, not failing to implement it. A CI step that passes it
        // and goes green teaches its author that a regression would have stopped the build.
        refusal.ExitCode.Should().Be(ExitCode.NotImplemented);
        refusal.ExitCode.Should().NotBe(ExitCode.Success);
        refusal.Message.Should().Contain("--fail-on-regression");
    }

    [Fact]
    public void Create_WhenTheGateFlagIsPassed_KeepsTheReservedExitsHeldForIt()
    {
        using var workspace = new TempWorkspace();

        var refusal = Assert.Throws<EvalCliException>(() =>
            RunPlan.Create(Minimal(workspace) with { FailOnRegression = true })
        );

        // The refusal is not a retraction of the reservation: the block still belongs to the gate,
        // and the message is where a caller learns that rather than from an ADR they will not read.
        ExitCodes.IsGateCode(refusal.ExitCode).Should().BeFalse();
        refusal.Remedy.Should().Contain($"{ExitCodes.GateRangeStart}-{ExitCodes.GateRangeEnd}");
    }

    [Fact]
    public void Create_WithoutTheGateFlag_StillReportsOnlyRatherThanGating()
    {
        using var workspace = new TempWorkspace();

        RunPlan.Create(Minimal(workspace)).GateMode.Should().Be(RunPlan.ReportOnlyGate);
    }

    [Fact]
    public void Create_WhenTheOptInIsGivenWithNoDestinationToOptInTo_Refuses()
    {
        // `trend` already refuses exactly this. An opt-in with nothing to opt in to names the only
        // irreversible thing the command can do and then does not govern anything, which reads as
        // one that might act.
        using var workspace = new TempWorkspace();

        var refusal = Assert.Throws<EvalCliException>(() =>
            RunPlan.Create(Minimal(workspace) with { Overwrite = true })
        );

        refusal.ExitCode.Should().Be(ExitCode.UsageError);
        refusal.Message.Should().Contain("--overwrite");
    }

    [Fact]
    public void Create_WhenTheOptInAccompaniesADestination_IsAccepted()
    {
        using var workspace = new TempWorkspace();

        var plan = RunPlan.Create(Minimal(workspace) with { Out = "artifacts/eval.json", Overwrite = true });

        plan.OverwriteArtifact.Should().BeTrue();
    }

    [Fact]
    public void Create_WhenMaxConcurrencyIsBelowOne_Refuses()
    {
        using var workspace = new TempWorkspace();

        var act = () => RunPlan.Create(Minimal(workspace) with { MaxConcurrency = 0 });

        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Fact]
    public void Create_WhenMaxTotalRunsIsBelowOne_Refuses()
    {
        using var workspace = new TempWorkspace();

        var act = () => RunPlan.Create(Minimal(workspace) with { MaxTotalRuns = -1 });

        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Fact]
    public void Create_WhenTheArtifactDestinationAlreadyExistsWithoutTheOptIn_Refuses()
    {
        using var workspace = new TempWorkspace();

        workspace.WriteFile(Path.Combine("artifacts", "eval.json"), "{}");

        var act = () => RunPlan.Create(Minimal(workspace) with { Out = "artifacts/eval.json" });

        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Fact]
    public void Create_WhenTheArtifactDestinationAlreadyExistsWithTheOptIn_Resolves()
    {
        using var workspace = new TempWorkspace();

        var existing = workspace.WriteFile(Path.Combine("artifacts", "eval.json"), "{}");

        var plan = RunPlan.Create(Minimal(workspace) with { Out = "artifacts/eval.json", Overwrite = true });

        plan.ArtifactPath.Should().Be(existing);
        plan.OverwriteArtifact.Should().BeTrue();
    }

    [Fact]
    public void Create_WhenTheSuitePathEscapesTheRoot_Refuses()
    {
        using var workspace = new TempWorkspace();

        var act = () => RunPlan.Create(Minimal(workspace) with { Suite = "../../elsewhere.json" });

        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Fact]
    public void Create_WhenABaselineIsNamed_ResolvesItAsAnExistingFile()
    {
        using var workspace = new TempWorkspace();

        var baseline = workspace.WriteFile(Path.Combine("artifacts", "main.json"), "{}");

        var plan = RunPlan.Create(Minimal(workspace) with { Baseline = "artifacts/main.json" });

        plan.BaselinePath.Should().Be(baseline);
    }

    [Fact]
    public void Create_WhenTheEndpointCarriesCredentials_Refuses()
    {
        using var workspace = new TempWorkspace();

        var act = () => RunPlan.Create(Minimal(workspace) with { Endpoint = "https://u:p@example.com" });

        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Fact]
    public void Create_WhenTheEndpointCarriesAQueryString_KeepsThePrintableFormRedacted()
    {
        using var workspace = new TempWorkspace();

        var plan = RunPlan.Create(Minimal(workspace) with { Endpoint = "https://example.com/api?token=abcdef" });

        plan.EndpointDisplay.Should().NotContain("abcdef");
        plan.Endpoint!.Query.Should().Contain("abcdef");
    }

    [Fact]
    public void ToCoordinatorOptions_WhenAnEndpointWasGiven_CarriesOnlyTheRedactedForm()
    {
        using var workspace = new TempWorkspace();

        var plan = RunPlan.Create(Minimal(workspace) with { Endpoint = "https://example.com/api?token=abcdef" });

        var options = plan.ToCoordinatorOptions();

        // RunCoordinatorOptions.Endpoint is written into a committed artifact, never dialled.
        options.Endpoint.Should().NotContain("abcdef");
        options.Endpoint.Should().Be(plan.EndpointDisplay);
    }

    [Fact]
    public void ToCoordinatorOptions_CarriesTheCeilingsFromThePlan()
    {
        using var workspace = new TempWorkspace();

        var plan = RunPlan.Create(Minimal(workspace) with { MaxConcurrency = 4, MaxTotalRuns = 99 });

        var options = plan.ToCoordinatorOptions();

        options.MaxConcurrency.Should().Be(4);
        options.MaxTotalRuns.Should().Be(99);
    }

    [Fact]
    public void Create_WhenTheRequestIsNull_Throws()
    {
        var act = () => RunPlan.Create(null!);

        act.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Create_WithTheMinimumArguments_SelectsNothingOutOfTheSuite()
    {
        using var workspace = new TempWorkspace();

        var plan = RunPlan.Create(Minimal(workspace));

        // Impact selection is opted into. Guessing a revision to diff against is what shrinks a
        // run invisibly, so the default is to run everything.
        plan.ChangedSince.Should().BeNull();
        plan.RestExchange.Should().Be(ExchangeAdapter.None);
        plan.LlmExchange.Should().Be(ExchangeAdapter.None);
        plan.RequiresEndpoint.Should().BeFalse();
    }

    [Theory]
    [InlineData("HEAD")]
    [InlineData("origin/main")]
    public void Create_WhenARevisionIsNamed_CarriesItIntoThePlan(string revision)
    {
        using var workspace = new TempWorkspace();

        RunPlan.Create(Minimal(workspace) with { ChangedSince = revision }).ChangedSince.Should().Be(revision);
    }

    [Theory]
    [InlineData("--upload-pack=whatever")]
    [InlineData("   ")]
    [InlineData("main\nsomething")]
    public void Create_WhenTheRevisionIsNotOne_Refuses(string revision)
    {
        using var workspace = new TempWorkspace();

        var act = () => RunPlan.Create(Minimal(workspace) with { ChangedSince = revision });

        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Theory]
    [InlineData("json")]
    [InlineData("JSON")]
    public void Create_WhenAnExchangeIsNamed_ReadsItCaseInsensitively(string value)
    {
        using var workspace = new TempWorkspace();

        var plan = RunPlan.Create(
            Minimal(workspace) with
            {
                RestExchange = value,
                Endpoint = "https://example.com/api",
            }
        );

        plan.RestExchange.Should().Be(ExchangeAdapter.Json);
    }

    [Fact]
    public void Create_WhenTheExchangeIsNamedNone_WiresNothing()
    {
        using var workspace = new TempWorkspace();

        var plan = RunPlan.Create(Minimal(workspace) with { RestExchange = "none" });

        plan.RestExchange.Should().Be(ExchangeAdapter.None);
        plan.RequiresEndpoint.Should().BeFalse("'none' is the absence of an adapter, so it needs no address");
    }

    [Fact]
    public void Create_WhenTheExchangeIsNotOneThisBuildHas_RefusesRatherThanFallingBack()
    {
        using var workspace = new TempWorkspace();

        var act = () =>
            RunPlan.Create(Minimal(workspace) with { RestExchange = "openapi", Endpoint = "https://example.com/api" });

        // Falling back to 'none' would leave the caller believing a transport was wired.
        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Theory]
    [InlineData("json", null)]
    [InlineData(null, "json")]
    public void Create_WhenAnExchangeIsNamedWithoutAnEndpoint_Refuses(string? rest, string? llm)
    {
        using var workspace = new TempWorkspace();

        var act = () => RunPlan.Create(Minimal(workspace) with { RestExchange = rest, LlmExchange = llm });

        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }
}
