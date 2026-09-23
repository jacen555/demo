using FluentAssertions;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Tests.Abstractions;

public class ParticipantTurnTests
{
    [Fact]
    public void Complete_Always_CarriesNoStimulusOrProvenance()
    {
        var turn = ParticipantTurn.Complete;

        turn.IsComplete.Should().BeTrue();
        turn.Stimulus.Should().BeNull();
        turn.Provenance.Should().BeNull();
    }

    [Fact]
    public void Next_ValidStimulus_IsNotComplete()
    {
        var turn = ParticipantTurn.Next("what is your order number?", TurnProvenance.Scripted);

        turn.IsComplete.Should().BeFalse();
        turn.Stimulus.Should().Be("what is your order number?");
        turn.Provenance.Should().Be(TurnProvenance.Scripted);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Next_EmptyStimulus_ThrowsArgumentException(string stimulus)
    {
        Action next = () => ParticipantTurn.Next(stimulus, TurnProvenance.Scripted);

        next.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void Next_NullStimulus_ThrowsArgumentNullException()
    {
        Action next = () => ParticipantTurn.Next(null!, TurnProvenance.Scripted);

        next.Should().Throw<ArgumentNullException>();
    }
}

public class DeterministicSeedSourceTests
{
    [Fact]
    public void Next_SameRootSeed_ProducesTheSameSequence()
    {
        var first = new DeterministicSeedSource(20260922);
        var second = new DeterministicSeedSource(20260922);

        var left = Enumerable.Range(0, 16).Select(_ => first.NextSeed()).ToArray();
        var right = Enumerable.Range(0, 16).Select(_ => second.NextSeed()).ToArray();

        left.Should().Equal(right);
    }

    [Fact]
    public void Next_DifferentRootSeed_ProducesADifferentSequence()
    {
        var first = new DeterministicSeedSource(1);
        var second = new DeterministicSeedSource(2);

        var left = Enumerable.Range(0, 16).Select(_ => first.NextSeed()).ToArray();
        var right = Enumerable.Range(0, 16).Select(_ => second.NextSeed()).ToArray();

        left.Should().NotEqual(right);
    }

    [Fact]
    public void Next_RepeatedCalls_DoNotRepeatTheSameValue()
    {
        var source = new DeterministicSeedSource(0);

        var seeds = Enumerable.Range(0, 64).Select(_ => source.NextSeed()).ToArray();

        seeds.Should().OnlyHaveUniqueItems();
    }

    [Fact]
    public void RootSeed_Always_IsTheValueTheSourceWasConstructedWith()
    {
        new DeterministicSeedSource(-77).RootSeed.Should().Be(-77);
    }
}

public class RepetitionPolicyTests
{
    [Fact]
    public void Once_Always_IsASingleRepetition()
    {
        RepetitionPolicy.Once.Repetitions.Should().Be(1);
        RepetitionPolicy.Once.IsOnce.Should().BeTrue();
    }

    [Fact]
    public void Repeat_CountAboveOne_IsNotOnce()
    {
        var policy = RepetitionPolicy.Repeat(20);

        policy.Repetitions.Should().Be(20);
        policy.IsOnce.Should().BeFalse();
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void Repeat_CountBelowOne_ThrowsArgumentOutOfRangeException(int repetitions)
    {
        Action repeat = () => RepetitionPolicy.Repeat(repetitions);

        repeat.Should().Throw<ArgumentOutOfRangeException>();
    }
}

public class TerminalConditionTests
{
    [Fact]
    public void MaxTurns_Unset_IsNullAndStopsOnParticipantCompletion()
    {
        var condition = new TerminalCondition();

        condition.MaxTurns.Should().BeNull();
        condition.StopOnParticipantCompletion.Should().BeTrue();
        condition.StopOnTerminalOutcome.Should().BeTrue();
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-3)]
    public void MaxTurns_NotPositive_ThrowsArgumentOutOfRangeException(int maxTurns)
    {
        Action build = () => _ = new TerminalCondition { MaxTurns = maxTurns };

        build.Should().Throw<ArgumentOutOfRangeException>();
    }
}
