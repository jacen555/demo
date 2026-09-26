using FluentAssertions;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Coordination;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;

namespace Forge.EvalEngine.Tests.Coordination;

/// <summary>
/// What a run's seed is a function of.
/// </summary>
/// <remarks>
/// <para>
/// A comparison is paired by seed — deliberately, because two runs driven differently are not
/// matched observations. So whatever the seed depends on becomes, silently, a precondition of
/// every comparison against every baseline. A seed drawn by position makes <i>the order of the
/// suite file</i> and <i>which scenarios happened to be selected</i> into that precondition:
/// reorder the suite or narrow it, and every scenario after the first change is driven with a
/// seed its own baseline recorded against a different scenario.
/// </para>
/// <para>
/// The failure is quiet in the worst direction. The pairing guard does its job and reports those
/// scenarios not-comparable, so a narrowed run silently un-examines exactly the scenarios the
/// narrowing was for, and the report shows no regression because nothing was compared.
/// </para>
/// <para>
/// These tests pin the seed to what it must be a function of: the root seed, the scenario's own
/// id, and the repetition number. Nothing else.
/// </para>
/// </remarks>
public sealed class RunCoordinatorSeedTests
{
    private const long Root = 20260922;

    /// <summary>The seeds each scenario's repetitions were driven with, in repetition order.</summary>
    private static async Task<IReadOnlyDictionary<string, long[]>> SeedsFor(Suite suite, long rootSeed = Root)
    {
        var runner = new StubRunner(ScenarioKind.Rest);

        await CoordinatorFixtures
            .Coordinator([runner], seeds: new DeterministicSeedSource(rootSeed))
            .RunAsync(suite, default);

        return runner
            .Seen.GroupBy(record => record.ScenarioId, StringComparer.Ordinal)
            .ToDictionary(
                group => group.Key,
                group => group.OrderBy(record => record.Repetition).Select(record => record.Seed).ToArray(),
                StringComparer.Ordinal
            );
    }

    // -----------------------------------------------------------------------------------------
    // Position must not be an input.
    // -----------------------------------------------------------------------------------------

    [Fact]
    public async Task RunAsync_SuiteReorderedBetweenRuns_DrivesEachScenarioWithTheSameSeedsAsBefore()
    {
        var a = CoordinatorFixtures.Scenario("a");
        var b = CoordinatorFixtures.Scenario("b");
        var c = CoordinatorFixtures.Scenario("c");

        var declared = await SeedsFor(CoordinatorFixtures.Suite(a, b, c));
        var reordered = await SeedsFor(CoordinatorFixtures.Suite(c, a, b));

        reordered.Should().BeEquivalentTo(declared);
    }

    [Fact]
    public async Task RunAsync_SuiteNarrowedToASubset_DrivesEachRemainingScenarioWithTheSeedTheFullSuiteGaveIt()
    {
        var a = CoordinatorFixtures.Scenario("a");
        var b = CoordinatorFixtures.Scenario("b");
        var c = CoordinatorFixtures.Scenario("c");

        var full = await SeedsFor(CoordinatorFixtures.Suite(a, b, c));
        var narrowed = await SeedsFor(CoordinatorFixtures.Suite(c));

        narrowed["c"].Should().Equal(full["c"]);
    }

    /// <summary>
    /// Editing one scenario's repetition count must not move another scenario's seeds.
    /// </summary>
    /// <remarks>
    /// A positional draw shifts by the difference, so every scenario declared after the edited
    /// one silently stops pairing against its own baseline.
    /// </remarks>
    [Fact]
    public async Task RunAsync_AnEarlierScenariosRepetitionCountChanged_DoesNotMoveALaterScenariosSeeds()
    {
        var b = CoordinatorFixtures.Scenario("b");

        var before = await SeedsFor(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a", repetitions: 2), b));
        var after = await SeedsFor(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a", repetitions: 5), b));

        after["b"].Should().Equal(before["b"]);
    }

    // -----------------------------------------------------------------------------------------
    // What the seed IS a function of.
    // -----------------------------------------------------------------------------------------

    [Fact]
    public async Task RunAsync_SameSuiteAndRootSeed_DrivesEveryRunWithTheSameSeedAsBefore()
    {
        var suite = CoordinatorFixtures.Suite(
            CoordinatorFixtures.Scenario("a", repetitions: 3),
            CoordinatorFixtures.Scenario("b")
        );

        (await SeedsFor(suite)).Should().BeEquivalentTo(await SeedsFor(suite));
    }

    [Fact]
    public async Task RunAsync_DifferentRootSeed_DrivesTheSameScenarioWithADifferentSeed()
    {
        var suite = CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a"));

        var first = await SeedsFor(suite, rootSeed: 1);
        var second = await SeedsFor(suite, rootSeed: 2);

        second["a"].Should().NotEqual(first["a"]);
    }

    [Fact]
    public async Task RunAsync_ScenarioWithSeveralRepetitions_DrivesEachWithADistinctSeed()
    {
        var seeds = await SeedsFor(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a", repetitions: 8)));

        seeds["a"].Should().OnlyHaveUniqueItems().And.HaveCount(8);
    }

    [Fact]
    public async Task RunAsync_TwoScenariosInOneSuite_AreDrivenWithDifferentSeeds()
    {
        var seeds = await SeedsFor(
            CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a"), CoordinatorFixtures.Scenario("b"))
        );

        seeds["a"].Should().NotEqual(seeds["b"]);
    }

    /// <summary>
    /// The seed recorded beside a run is the seed it was driven with.
    /// </summary>
    /// <remarks>
    /// The artifact's whole claim to reproducibility rests on this, and the comparator pairs on
    /// the recorded value rather than on the dispatched one.
    /// </remarks>
    [Fact]
    public async Task RunAsync_Always_StampsEachRunWithTheSeedItWasDrivenWith()
    {
        var runner = new StubRunner(ScenarioKind.Rest);
        var result = await CoordinatorFixtures
            .Coordinator([runner], seeds: new DeterministicSeedSource(Root))
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a", repetitions: 3)), default);

        result
            .ScenarioResults.Single()
            .Runs.Select(run => run.Transcript.Seed)
            .Should()
            .Equal(runner.Seen.OrderBy(record => record.Repetition).Select(record => record.Seed));
    }

    // -----------------------------------------------------------------------------------------
    // The injected seam, and the guard that survives it.
    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// An injected source that hands one seed to every repetition is still refused.
    /// </summary>
    /// <remarks>
    /// Deriving the seed from the scenario id makes a collision impossible for the source this
    /// library ships, but <see cref="ISeedSource"/> is injected and an implementation is free to
    /// return whatever it likes. Two repetitions sharing an identity are indistinguishable, so
    /// the plan is refused before anything is dispatched.
    /// </remarks>
    [Fact]
    public async Task RunAsync_SeedSourceIssuingOneSeedForEveryRepetition_IsRefusedBeforeAnythingIsDispatched()
    {
        var runner = new StubRunner(ScenarioKind.Rest);
        var coordinator = CoordinatorFixtures.Coordinator([runner], seeds: new CollidingSeedSource());

        var act = () =>
            coordinator.RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a", repetitions: 2)), default);

        await act.Should().ThrowAsync<InvalidOperationException>();
        runner.Seen.Should().BeEmpty();
    }

    /// <summary>
    /// A source that derives its own seeds from the scenario is consulted rather than bypassed.
    /// </summary>
    [Fact]
    public async Task RunAsync_SeedSourceDerivingItsOwnSeeds_IsTheSourceOfEverySeedDispatched()
    {
        var runner = new StubRunner(ScenarioKind.Rest);

        await CoordinatorFixtures
            .Coordinator([runner], seeds: new ScenarioNamingSeedSource())
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a", repetitions: 2)), default);

        runner
            .Seen.OrderBy(record => record.Repetition)
            .Select(record => record.Seed)
            .Should()
            .Equal(ScenarioNamingSeedSource.Of("a", 1), ScenarioNamingSeedSource.Of("a", 2));
    }

    /// <summary>A source whose seeds are a transparent function of the run they are for.</summary>
    private sealed class ScenarioNamingSeedSource : ISeedSource
    {
        public static long Of(string scenarioId, int repetition) => (scenarioId.Length * 1_000_000L) + repetition;

        public long RootSeed => 7;

        public long NextSeed() => throw new InvalidOperationException("The coordinator must ask for a run's seed.");

        public long SeedFor(string scenarioId, int repetition) => Of(scenarioId, repetition);
    }
}
