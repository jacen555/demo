using FluentAssertions;
using Forge.EvalCli.Composition;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Participants;
using Forge.EvalEngine.Scenarios;

namespace Forge.EvalCli.Tests.Composition;

public class DeterministicParticipantFactoryTests
{
    private static Scenario Scenario(ExecutionMode mode = ExecutionMode.Deterministic) =>
        new()
        {
            Identity = new ScenarioIdentity { Id = "checkout-happy-path", Kind = ScenarioKind.Rest },
            Execution = new Execution { Mode = mode },
            Simulation = new Simulation { Opening = "hello" },
        };

    [Fact]
    public void Create_CalledTwiceForTheSameScenario_ReturnsDistinctInstances()
    {
        var factory = new DeterministicParticipantFactory();
        var scenario = Scenario();

        var first = factory.Create(scenario, seed: 1, repetition: 1);
        var second = factory.Create(scenario, seed: 1, repetition: 2);

        // The coordinator tracks handed-out participants by reference and refuses a repeat, so a
        // factory that cached would fail the second repetition of every scenario.
        first.Should().NotBeSameAs(second);
    }

    [Fact]
    public void Create_AcrossManyRuns_NeverReturnsAnInstanceItHasAlreadyReturned()
    {
        var factory = new DeterministicParticipantFactory();
        var scenario = Scenario();

        var participants = Enumerable
            .Range(1, 25)
            .Select(repetition => factory.Create(scenario, seed: repetition, repetition: repetition))
            .ToArray();

        participants.Distinct(ReferenceEqualityComparer.Instance).Should().HaveCount(25);
    }

    [Fact]
    public void Create_ForADeterministicScenario_ReturnsACallerBoundToThatMode()
    {
        var participant = new DeterministicParticipantFactory().Create(Scenario(), seed: 1, repetition: 1);

        participant.Should().BeOfType<DeterministicCaller>();
        participant.Should().BeAssignableTo<IModeBoundParticipant>();
        ((IModeBoundParticipant)participant).Mode.Should().Be(ExecutionMode.Deterministic);
    }

    [Fact]
    public void Create_ForASimulatedScenario_ReturnsACallerBoundToThatMode()
    {
        var participant = new DeterministicParticipantFactory().Create(
            Scenario(ExecutionMode.Simulated),
            seed: 1,
            repetition: 1
        );

        ((IModeBoundParticipant)participant).Mode.Should().Be(ExecutionMode.Simulated);
    }

    [Fact]
    public void Create_WhenTheScenarioIsNull_Throws()
    {
        var act = () => new DeterministicParticipantFactory().Create(null!, seed: 1, repetition: 1);

        act.Should().Throw<ArgumentNullException>();
    }
}
