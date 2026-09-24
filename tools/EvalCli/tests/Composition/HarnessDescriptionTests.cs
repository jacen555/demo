using FluentAssertions;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Composition;
using Forge.EvalCli.Tests.Support;
using Forge.EvalEngine.Scenarios;

namespace Forge.EvalCli.Tests.Composition;

public class HarnessDescriptionTests
{
    private static HarnessDescription Describe(TempWorkspace workspace)
    {
        var plan = RunPlan.Create(new RunRequest { Suite = "eval-suites/regression.json", Root = workspace.Root });

        using var diagnostics = new StringWriter();
        using var provider = EvalCliServices.Build(plan, diagnostics);

        return HarnessDescription.Describe(provider);
    }

    [Fact]
    public void Describe_ForEveryScenarioKind_ProducesAnEntry()
    {
        using var workspace = new TempWorkspace();

        var harness = Describe(workspace);

        harness.Runners.Select(runner => runner.Kind).Should().BeEquivalentTo(Enum.GetNames<ScenarioKind>());
    }

    [Theory]
    [InlineData(nameof(ScenarioKind.Rest))]
    [InlineData(nameof(ScenarioKind.Llm))]
    public void Describe_WhenAKindHasNoRunner_ReportsItAsUnwiredWithAReason(string kind)
    {
        using var workspace = new TempWorkspace();

        var entry = Describe(workspace).Runners.Single(runner => runner.Kind == kind);

        // Reported, never omitted: a missing entry would read as full coverage.
        entry.Wired.Should().BeFalse();
        entry.Runner.Should().BeNull();
        entry.Note.Should().Contain("no runner registered");
    }

    [Theory]
    [InlineData(nameof(ScenarioKind.Mcp), "NotImplementedMcpRunner")]
    [InlineData(nameof(ScenarioKind.Ui), "NotImplementedUiRunner")]
    public void Describe_WhenAKindHasTheEnginesStub_NamesItAndSaysWhatItDoes(string kind, string runner)
    {
        using var workspace = new TempWorkspace();

        var entry = Describe(workspace).Runners.Single(description => description.Kind == kind);

        entry.Wired.Should().BeTrue();
        entry.Runner.Should().Be(runner);
        entry.Note.Should().Contain("harness failure");
    }

    [Fact]
    public void Describe_NamesTheComponentsTheCompositionRootChose()
    {
        using var workspace = new TempWorkspace();

        var harness = Describe(workspace);

        harness.ParticipantFactory.Should().Be(nameof(DeterministicParticipantFactory));
        harness.Clock.Should().Be("SystemClock");
        harness.SignificanceTest.Should().Be("McNemar");
        harness.MultipleComparisonCorrection.Should().Be("benjamini-hochberg");
        harness.AssertionCategories.Should().NotBeEmpty();
    }

    [Fact]
    public void Describe_WhenTheProviderIsNull_Throws()
    {
        var act = () => HarnessDescription.Describe(null!);

        act.Should().Throw<ArgumentNullException>();
    }
}
