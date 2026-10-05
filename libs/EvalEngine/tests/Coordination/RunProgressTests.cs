using FluentAssertions;
using Forge.EvalEngine.Coordination;
using Forge.EvalEngine.Results;

namespace Forge.EvalEngine.Tests.Coordination;

/// <summary>
/// The report itself. A consumer can construct one — a renderer's own tests will — so it refuses
/// the values the coordinator can never produce, and accepts every value it can.
/// </summary>
public sealed class RunProgressTests
{
    /// <summary>
    /// The control for every refusal below: a well-formed report is accepted, so a refusal is about
    /// the value refused rather than a constructor that refuses everything.
    /// </summary>
    [Fact]
    public void Constructor_WellFormedReport_CarriesWhatItWasGiven()
    {
        var report = new RunProgress(
            completed: 3,
            total: 8,
            scenarioId: "scenario-a",
            repetition: 2,
            status: RunStatus.ExpectedFailure
        );

        report.Completed.Should().Be(3);
        report.Total.Should().Be(8);
        report.ScenarioId.Should().Be("scenario-a");
        report.Repetition.Should().Be(2);
        report.Status.Should().Be(RunStatus.ExpectedFailure);
    }

    [Fact]
    public void Constructor_LastRunOfTheSuite_IsAccepted() =>
        new RunProgress(completed: 8, total: 8, scenarioId: "scenario-a", repetition: 1, status: RunStatus.Pass)
            .Completed.Should()
            .Be(8);

    [Theory]
    [InlineData(0, 8, 1, "completed")]
    [InlineData(-1, 8, 1, "completed")]
    [InlineData(9, 8, 1, "completed")]
    [InlineData(1, 0, 1, "total")]
    [InlineData(1, 8, 0, "repetition")]
    public void Constructor_CountOutOfRange_IsRefusedNamingTheArgument(
        int completed,
        int total,
        int repetition,
        string refused
    )
    {
        var act = () => new RunProgress(completed, total, "scenario-a", repetition, RunStatus.Pass);

        act.Should().Throw<ArgumentOutOfRangeException>().Which.ParamName.Should().Be(refused);
    }

    [Fact]
    public void Constructor_UndefinedStatus_IsRefused()
    {
        var act = () => new RunProgress(1, 1, "scenario-a", 1, (RunStatus)42);

        act.Should().Throw<ArgumentOutOfRangeException>().Which.ParamName.Should().Be("status");
    }

    [Fact]
    public void Constructor_NullScenarioId_IsRefused()
    {
        var act = () => new RunProgress(1, 1, null!, 1, RunStatus.Pass);

        act.Should().Throw<ArgumentNullException>().Which.ParamName.Should().Be("scenarioId");
    }

    /// <summary>
    /// The coordinator conducts a scenario whose id is blank — only the loader refuses one — so a
    /// report that refused it would make supplying a progress sink fail a suite that runs without
    /// one.
    /// </summary>
    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Constructor_BlankScenarioId_IsAcceptedBecauseTheCoordinatorAcceptsIt(string scenarioId) =>
        new RunProgress(1, 1, scenarioId, 1, RunStatus.Pass).ScenarioId.Should().Be(scenarioId);
}
