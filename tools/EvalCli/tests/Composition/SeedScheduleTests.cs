using FluentAssertions;
using Forge.EvalCli.Composition;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Scenarios;

namespace Forge.EvalCli.Tests.Composition;

/// <summary>
/// The seed schedule: what a narrowed run must draw so that it still pairs with a full-suite
/// baseline.
/// </summary>
/// <remarks>
/// Asserted against the sequence a full run would produce, computed here from the engine's own
/// <see cref="DeterministicSeedSource"/> rather than from hard-coded figures. Pinning literals
/// would make this a test of the mixer, which is the engine's to own, and it would pass against a
/// schedule that was internally consistent and wrong.
/// </remarks>
public class SeedScheduleTests
{
    private const long Root = 4242;

    private static Suite TwoScenarios(int first = 1, int second = 1) =>
        new() { Name = "regression", Scenarios = [Scenario("checkout", first), Scenario("billing", second)] };

    private static Scenario Scenario(string id, int repetitions) =>
        new()
        {
            Identity = new ScenarioIdentity { Id = id, Kind = ScenarioKind.Rest },
            Execution = new Execution
            {
                Mode = ExecutionMode.Deterministic,
                RepetitionPolicy = RepetitionPolicy.Repeat(repetitions),
            },
            Simulation = new Simulation { Opening = "hello" },
        };

    private static IReadOnlyList<long> FullSuiteDraws(int count)
    {
        var source = new DeterministicSeedSource(Root);

        return [.. Enumerable.Range(0, count).Select(_ => source.NextSeed())];
    }

    private static IReadOnlyList<long> Draw(ISeedSource source, int count) =>
        [.. Enumerable.Range(0, count).Select(_ => source.NextSeed())];

    [Fact]
    public void Create_WhenEveryScenarioIsConducted_DrawsTheSequenceTheRootSeedAlwaysProduced()
    {
        var schedule = new SeedSchedule(Root);

        schedule.PinTo(TwoScenarios(), ["checkout", "billing"]);

        Draw(schedule.Create(), 2).Should().Equal(FullSuiteDraws(2));
    }

    [Fact]
    public void Create_WhenAnEarlierScenarioIsSkipped_StillDrawsTheSeedTheFullSuiteWouldHaveGivenIt()
    {
        var schedule = new SeedSchedule(Root);

        schedule.PinTo(TwoScenarios(), ["billing"]);

        // The second scenario's draw, not the first's. Closing the gap is what makes a narrowed
        // candidate un-pairable against its own full-suite baseline — and the comparison is
        // paired by seed, so that lands as "not comparable" on precisely the scenario the
        // narrowing was for.
        Draw(schedule.Create(), 1).Should().Equal(FullSuiteDraws(2)[1]);
    }

    [Fact]
    public void Create_WhenASkippedScenarioRepeats_SkipsEveryOneOfItsDraws()
    {
        var schedule = new SeedSchedule(Root);

        schedule.PinTo(TwoScenarios(first: 3), ["billing"]);

        // Three draws belong to the skipped scenario, so the selected one takes the fourth. A
        // schedule that counted scenarios rather than repetitions would be off by two here and
        // look entirely plausible.
        Draw(schedule.Create(), 1).Should().Equal(FullSuiteDraws(4)[3]);
    }

    [Fact]
    public void Create_ForEachSuiteRun_ReplaysTheSameScheduleFromTheStart()
    {
        var schedule = new SeedSchedule(Root);

        schedule.PinTo(TwoScenarios(), ["checkout", "billing"]);

        // A live baseline conducts the same scenarios through a second coordinator. Two sides of
        // one paired comparison that drew from a shared cursor would be driven differently, which
        // is the thing the pairing exists to rule out.
        Draw(schedule.Create(), 2).Should().Equal(Draw(schedule.Create(), 2));
    }

    [Fact]
    public void NextSeed_PastTheEndOfThePinnedSchedule_ThrowsRatherThanInventingOne()
    {
        var schedule = new SeedSchedule(Root);

        schedule.PinTo(TwoScenarios(), ["billing"]);

        var source = schedule.Create();

        _ = source.NextSeed();

        // Running out means the coordinator is conducting something the selection did not
        // describe. A fresh draw would produce a run that looks ordinary and pairs against
        // nothing in any baseline.
        var act = () => source.NextSeed();

        act.Should().Throw<InvalidOperationException>().WithMessage("*more seeds than the schedule*");
    }

    [Fact]
    public void Create_BeforeAnythingIsPinned_FallsBackToTheFullSequence()
    {
        var schedule = new SeedSchedule(Root);

        // The unnarrowed sequence, which is correct for any run that conducts the suite whole and
        // is what every caller got before the schedule existed.
        Draw(schedule.Create(), 3).Should().Equal(FullSuiteDraws(3));
        schedule.Create().RootSeed.Should().Be(Root);
    }
}
