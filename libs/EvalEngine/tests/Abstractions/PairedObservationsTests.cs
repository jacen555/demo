using FluentAssertions;
using Forge.EvalEngine.Abstractions;

namespace Forge.EvalEngine.Tests.Abstractions;

/// <summary>
/// The significance seam.
/// </summary>
/// <remarks>
/// The comparison is paired by construction — the same scenarios run against both variants with
/// the same seeds. An unpaired test discards that pairing and systematically understates the
/// evidence, so the seam is shaped to make an unpaired comparison inexpressible rather than
/// merely discouraged.
/// </remarks>
public class PairedObservationsTests
{
    private static PairedObservation Pair(string id, double baseline, double candidate, long seed = 42) =>
        new()
        {
            ScenarioId = id,
            Seed = seed,
            BaselineValue = baseline,
            CandidateValue = candidate,
        };

    [Fact]
    public void Create_MatchedObservations_KeepsThemInOrder()
    {
        var observations = PairedObservations.Create([Pair("a", 1, 0), Pair("b", 0, 1)]);

        observations.Count.Should().Be(2);
        observations.Pairs.Select(p => p.ScenarioId).Should().Equal("a", "b");
    }

    [Fact]
    public void Create_NullObservations_ThrowsArgumentNullException()
    {
        Action create = () => PairedObservations.Create(null!);

        create.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Create_NoObservations_ThrowsArgumentException()
    {
        Action create = () => PairedObservations.Create([]);

        create.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void Create_DuplicateScenarioId_ThrowsArgumentException()
    {
        Action create = () => PairedObservations.Create([Pair("a", 1, 0), Pair("a", 0, 1)]);

        create.Should().Throw<ArgumentException>().WithMessage("*a*");
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Create_BlankScenarioId_ThrowsArgumentException(string id)
    {
        Action create = () => PairedObservations.Create([Pair(id, 1, 0)]);

        create.Should().Throw<ArgumentException>();
    }

    [Theory]
    [InlineData(double.NaN, 0d)]
    [InlineData(0d, double.NaN)]
    [InlineData(double.PositiveInfinity, 0d)]
    [InlineData(0d, double.NegativeInfinity)]
    public void Create_NonFiniteValue_ThrowsArgumentException(double baseline, double candidate)
    {
        Action create = () => PairedObservations.Create([Pair("a", baseline, candidate)]);

        create.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void Create_NullObservation_ThrowsArgumentException()
    {
        Action create = () => PairedObservations.Create([Pair("a", 1, 0), null!]);

        create.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void FromOutcomes_BinaryOutcomes_ProducesZeroAndOne()
    {
        var pair = PairedObservation.FromOutcomes("a", seed: 7, baseline: false, candidate: true);

        pair.ScenarioId.Should().Be("a");
        pair.Seed.Should().Be(7);
        pair.BaselineValue.Should().Be(0);
        pair.CandidateValue.Should().Be(1);
    }

    [Fact]
    public void IsBinary_OnlyZeroesAndOnes_IsTrue()
    {
        PairedObservations.Create([Pair("a", 0, 1), Pair("b", 1, 1)]).IsBinary.Should().BeTrue();
    }

    [Fact]
    public void IsBinary_AMeanOverRepetitions_IsFalse()
    {
        PairedObservations.Create([Pair("a", 0.6, 0.8)]).IsBinary.Should().BeFalse();
    }

    [Fact]
    public void Difference_Always_IsTheCandidateMinusTheBaseline()
    {
        Pair("a", 0.25, 0.75).Difference.Should().BeApproximately(0.5, 1e-12);
    }

    [Fact]
    public void Pair_Always_CarriesTheSeedBothVariantsWereRunWith()
    {
        Pair("a", 1, 0, seed: 20260922).Seed.Should().Be(20260922);
    }

    [Fact]
    public void Pairs_CastBackToTheUnderlyingArray_CannotBeMutated()
    {
        // The validation this type performs is only worth something if the validated set cannot
        // be edited afterwards. An IReadOnlyList that is really an array is a cast away from
        // being writable again.
        var observations = PairedObservations.Create([Pair("a", 1, 0), Pair("b", 0, 1)]);

        (observations.Pairs is PairedObservation[]).Should().BeFalse();

        Action mutate = () => ((IList<PairedObservation>)observations.Pairs)[0] = Pair("c", 1, 1);

        mutate.Should().Throw<NotSupportedException>();
        observations.Pairs.Select(p => p.ScenarioId).Should().Equal("a", "b");
    }
}
