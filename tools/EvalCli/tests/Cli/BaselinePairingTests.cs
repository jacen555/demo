using FluentAssertions;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Tests.Support;

namespace Forge.EvalCli.Tests.Cli;

/// <summary>
/// The refusals that stop two references being compared when they are not a baseline and a
/// candidate.
/// </summary>
/// <remarks>
/// Every guard the engine applies — the definition fingerprint, the harness config, the root
/// seed, the suite name — is checking that two <i>different</i> artifacts were produced alike.
/// None of them fires when the two references name the same artifact or the same deployment,
/// because then nothing disagrees. That case reports "nothing changed" whatever the change did,
/// so it is refused here, before anything runs.
/// </remarks>
public class BaselinePairingTests
{
    private static RunRequest Comparing(TempWorkspace workspace) =>
        new()
        {
            Suite = "eval-suites/regression.json",
            Root = workspace.Root,
            Endpoint = "http://localhost:8787/evaluate",
            RestExchange = "json",
        };

    [Fact]
    public void Create_WhenTheBaselineAndTheArtifactDestinationAreTheSameFile_Refuses()
    {
        using var workspace = new TempWorkspace();

        workspace.WriteFile(Path.Combine("artifacts", "baseline.json"), "{}");

        var act = () =>
            RunPlan.Create(
                Comparing(workspace) with
                {
                    Baseline = "artifacts/baseline.json",
                    Out = "artifacts/baseline.json",
                    Overwrite = true,
                }
            );

        // Writing a run over the baseline it was compared against is a baseline update, and that
        // has its own command and its own opt-in. Allowing it here would make a `run` invocation
        // destructive.
        var refusal = act.Should().Throw<EvalCliException>().Which;

        refusal.ExitCode.Should().Be(ExitCode.UsageError);
        refusal.Remedy.Should().Contain("baseline update");
    }

    [Fact]
    public void Create_WhenTheBaselineAndTheArtifactDestinationDiffer_IsAllowed()
    {
        using var workspace = new TempWorkspace();

        workspace.WriteFile(Path.Combine("artifacts", "baseline.json"), "{}");

        var plan = RunPlan.Create(
            Comparing(workspace) with
            {
                Baseline = "artifacts/baseline.json",
                Out = "artifacts/candidate.json",
            }
        );

        // The guard above must refuse the same file, not the ordinary case of comparing against
        // one artifact while writing another.
        plan.BaselinePath.Should().NotBe(plan.ArtifactPath);
        plan.Compares.Should().BeTrue();
    }

    [Fact]
    public void Create_WhenTheBaselineEndpointIsTheEndpoint_RefusesRatherThanComparingASuiteAgainstItself()
    {
        using var workspace = new TempWorkspace();

        var act = () =>
            RunPlan.Create(Comparing(workspace) with { BaselineEndpoint = "http://localhost:8787/evaluate" });

        var refusal = act.Should().Throw<EvalCliException>().Which;

        refusal.ExitCode.Should().Be(ExitCode.UsageError);
        refusal.Message.Should().Contain("compared against itself");
    }

    [Fact]
    public void Create_WhenTheTwoAddressesDifferOnlyByQueryString_RefusesBecauseThatCannotBeVerified()
    {
        using var workspace = new TempWorkspace();

        var act = () =>
            RunPlan.Create(
                Comparing(workspace) with
                {
                    Endpoint = "http://localhost:8787/evaluate?deployment=new",
                    BaselineEndpoint = "http://localhost:8787/evaluate",
                }
            );

        // A query is stripped before an address is recorded, so two deployments selected that way
        // are the same text in the artifact. Treating them as distinct is exactly the confident
        // pairing of two unverifiable things this refuses.
        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Fact]
    public void Create_WhenTheBaselineEndpointNamesADifferentAddress_IsAllowed()
    {
        using var workspace = new TempWorkspace();

        var plan = RunPlan.Create(Comparing(workspace) with { BaselineEndpoint = "http://localhost:8788/evaluate" });

        plan.BaselineEndpoint.Should().NotBeNull();
        plan.BaselineEndpointDisplay.Should().Be("http://localhost:8788/<redacted>");
        plan.Compares.Should().BeTrue();
    }

    [Theory]
    [InlineData("http://localhost:8788/evaluate?deployment=old")]
    [InlineData("http://localhost:8788/evaluate#old")]
    public void Create_WhenTheBaselineAddressSelectsADeploymentItCannotVerify_RefusesAndSaysHowToSelectOne(
        string address
    )
    {
        using var workspace = new TempWorkspace();

        var act = () => RunPlan.Create(Comparing(workspace) with { BaselineEndpoint = address });

        var refusal = act.Should().Throw<EvalCliException>().Which;

        refusal.ExitCode.Should().Be(ExitCode.UsageError);

        // The engine refuses the same shape; refusing at argument time is what makes it a usage
        // error carrying the remedy rather than an unhandled engine failure mid-run.
        refusal.Remedy.Should().Contain("by path").And.Contain("header");
    }

    [Fact]
    public void Create_WhenBothBaselineMechanismsAreNamed_Refuses()
    {
        using var workspace = new TempWorkspace();

        workspace.WriteFile(Path.Combine("artifacts", "baseline.json"), "{}");

        var act = () =>
            RunPlan.Create(
                Comparing(workspace) with
                {
                    Baseline = "artifacts/baseline.json",
                    BaselineEndpoint = "http://localhost:8788/evaluate",
                }
            );

        // Two baselines and no rule for choosing between them is the shape that eventually
        // compares against whichever one the code happened to reach first.
        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Fact]
    public void Create_WhenABaselineEndpointIsNamedWithNoExchange_Refuses()
    {
        using var workspace = new TempWorkspace();

        var act = () =>
            RunPlan.Create(
                new RunRequest
                {
                    Suite = "eval-suites/regression.json",
                    Root = workspace.Root,
                    Endpoint = "http://localhost:8787/evaluate",
                    BaselineEndpoint = "http://localhost:8788/evaluate",
                }
            );

        // Nothing would conduct either run, so both sides would be harness failures and the
        // comparison would have no evidence at all to work from.
        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Fact]
    public void Create_WithNoBaselineAtAll_PlansToCompareNothing()
    {
        using var workspace = new TempWorkspace();

        var plan = RunPlan.Create(Comparing(workspace));

        plan.Compares.Should().BeFalse();
        plan.Operation.Should().Be(CliOperation.Run);
    }
}
