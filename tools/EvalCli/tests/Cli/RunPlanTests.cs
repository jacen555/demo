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
    public void Create_ForEveryPlan_ReportsOnlyRatherThanGating()
    {
        using var workspace = new TempWorkspace();

        var gated = RunPlan.Create(Minimal(workspace) with { FailOnRegression = true });
        var ungated = RunPlan.Create(Minimal(workspace));

        gated.GateMode.Should().Be(RunPlan.ReportOnlyGate);
        ungated.GateMode.Should().Be(RunPlan.ReportOnlyGate);
        gated.GateMode.Should().Be(ungated.GateMode, "the reserved flag must not change behaviour yet");
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
}
