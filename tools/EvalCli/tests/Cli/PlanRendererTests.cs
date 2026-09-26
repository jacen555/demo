using System.Text.Json;
using FluentAssertions;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Composition;
using Forge.EvalCli.Tests.Support;

namespace Forge.EvalCli.Tests.Cli;

public class PlanRendererTests
{
    private static RunPlan Plan(TempWorkspace workspace, Action<RunRequest>? _ = null) =>
        RunPlan.Create(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = workspace.Root,
                DryRun = true,
            }
        );

    private static HarnessDescription Harness(RunPlan plan)
    {
        using var writer = new StringWriter();
        using var provider = EvalCliServices.Build(plan, writer);

        return HarnessDescription.Describe(provider);
    }

    [Fact]
    public void RenderText_ForADryRun_SaysNothingWasExecuted()
    {
        using var workspace = new TempWorkspace();

        var plan = Plan(workspace);

        PlanRenderer.RenderText(plan, Harness(plan)).Should().Contain("Nothing was executed");
    }

    [Fact]
    public void RenderText_WhenNoDestinationWasNamed_SaysNothingWouldBeWritten()
    {
        using var workspace = new TempWorkspace();

        var plan = Plan(workspace);

        PlanRenderer.RenderText(plan, Harness(plan)).Should().Contain("nothing would be written");
    }

    [Fact]
    public void RenderText_WhenARunnerKindIsUnwired_SaysSoRatherThanOmittingIt()
    {
        using var workspace = new TempWorkspace();

        var plan = Plan(workspace);

        var rendered = PlanRenderer.RenderText(plan, Harness(plan));

        // Every kind is named, so a reader cannot conclude the suite is fully covered.
        rendered.Should().Contain("rest").And.Contain("mcp").And.Contain("llm").And.Contain("ui");
        rendered.Should().Contain("no runner registered");
    }

    [Fact]
    public void RenderText_WhenTheEndpointCarriesAQueryString_DoesNotPrintIt()
    {
        using var workspace = new TempWorkspace();

        var plan = RunPlan.Create(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = workspace.Root,
                DryRun = true,
                Endpoint = "https://example.com/api?token=abcdef",
            }
        );

        PlanRenderer.RenderText(plan, Harness(plan)).Should().NotContain("abcdef");
    }

    [Fact]
    public void RenderText_ForEveryPlan_SaysRegressionsAreReportedRatherThanEnforced()
    {
        // The plan can no longer be built with the gate flag — it is refused — so the one
        // remaining honest gate line is the one every plan carries.
        using var workspace = new TempWorkspace();

        var plan = RunPlan.Create(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = workspace.Root,
                DryRun = true,
            }
        );

        var rendered = PlanRenderer.RenderText(plan, Harness(plan));

        rendered.Should().Contain("report-only");
        rendered.Should().Contain("reported, not enforced");
    }

    [Fact]
    public void RenderJson_ForADryRun_ReportsThatNothingWasExecuted()
    {
        using var workspace = new TempWorkspace();

        var plan = Plan(workspace);

        using var document = JsonDocument.Parse(PlanRenderer.RenderJson(plan, Harness(plan)));

        document.RootElement.GetProperty("dryRun").GetBoolean().Should().BeTrue();
        document.RootElement.GetProperty("executed").GetBoolean().Should().BeFalse();
        document.RootElement.GetProperty("failOnRegressionImplemented").GetBoolean().Should().BeFalse();
    }

    [Fact]
    public void RenderJson_UsesCamelCaseThroughoutSoAConsumerSeesOneConvention()
    {
        using var workspace = new TempWorkspace();

        var plan = Plan(workspace);

        using var document = JsonDocument.Parse(PlanRenderer.RenderJson(plan, Harness(plan)));

        var harness = document.RootElement.GetProperty("harness");

        harness.TryGetProperty("participantFactory", out _).Should().BeTrue();
        harness.GetProperty("runners")[0].TryGetProperty("kind", out _).Should().BeTrue();
    }

    [Fact]
    public void RenderJson_WhenTheEndpointCarriesAQueryString_DoesNotSerializeIt()
    {
        using var workspace = new TempWorkspace();

        var plan = RunPlan.Create(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = workspace.Root,
                DryRun = true,
                Endpoint = "https://example.com/api?token=abcdef",
            }
        );

        PlanRenderer.RenderJson(plan, Harness(plan)).Should().NotContain("abcdef");
    }

    [Fact]
    public void RenderText_WhenARevisionWasNamed_DoesNotClaimTheChangedFileSetWasAlreadyRead()
    {
        using var workspace = new TempWorkspace();

        var plan = RunPlan.Create(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = workspace.Root,
                DryRun = true,
                ChangedSince = "origin/main",
            }
        );

        var rendered = PlanRenderer.RenderText(plan, Harness(plan));

        // A dry run reads nothing — not the suite, not the diff. Saying the run will be
        // "impacted only" states an outcome the preview has no evidence for: git may be absent,
        // the revision unknown, or a path outside the root, and every one of those runs the whole
        // suite instead. The revision is still named, because that is the value worth checking
        // before anything is executed.
        rendered.Should().Contain("origin/main");
        rendered.Should().Contain("not resolved yet");
        rendered.Should().Contain("whole suite");
    }

    [Fact]
    public void Report_ForEveryPlan_SaysNothingWasExecuted()
    {
        using var workspace = new TempWorkspace();

        var plan = Plan(workspace);

        PlanRenderer.Report(plan, Harness(plan)).Executed.Should().BeFalse();
    }
}
