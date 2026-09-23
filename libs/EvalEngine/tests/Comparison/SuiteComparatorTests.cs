using FluentAssertions;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Comparison;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Statistics;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;

namespace Forge.EvalEngine.Tests.Comparison;

public sealed class SuiteComparatorTests
{
    [Fact]
    public void Constructor_SignificanceTestWithoutACorrection_Refuses()
    {
        var act = () => new SuiteComparator(new McNemarTest(), null, 0.05, NullLogger<SuiteComparator>.Instance);

        act.Should().Throw<ArgumentException>().WithMessage("*together or not at all*");
    }

    [Fact]
    public void Constructor_CorrectionWithoutASignificanceTest_Refuses()
    {
        var act = () =>
            new SuiteComparator(null, BenjaminiHochbergCorrection.Instance, 0.05, NullLogger<SuiteComparator>.Instance);

        act.Should().Throw<ArgumentException>().WithMessage("*together or not at all*");
    }

    [Theory]
    [InlineData(0.0)]
    [InlineData(1.0)]
    [InlineData(-0.1)]
    [InlineData(1.5)]
    [InlineData(double.NaN)]
    public void Constructor_SignificanceLevelOutsideTheOpenUnitInterval_Refuses(double level)
    {
        var act = () => new SuiteComparator(null, null, level, NullLogger<SuiteComparator>.Instance);

        act.Should().Throw<ArgumentOutOfRangeException>();
    }

    [Fact]
    public void Constructor_NullLogger_Refuses()
    {
        var act = () => new SuiteComparator(null, null, 0.05, null!);

        act.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Constructor_NullSignificanceTestOnTheTwoArgumentOverload_Refuses()
    {
        var act = () => new SuiteComparator(null!, BenjaminiHochbergCorrection.Instance);

        act.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Constructor_NullCorrectionOnTheTwoArgumentOverload_Refuses()
    {
        var act = () => new SuiteComparator(new McNemarTest(), null!);

        act.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Constructor_WithoutStatistics_DefaultsToTheConventionalLevel() =>
        new SuiteComparator().SignificanceLevel.Should().Be(0.05);

    [Fact]
    public void Constructor_LevelSupplied_IsCarried() =>
        new SuiteComparator(null, null, 0.01, NullLogger<SuiteComparator>.Instance).SignificanceLevel.Should().Be(0.01);

    [Fact]
    public void Compare_NullBaseline_Refuses()
    {
        var act = () => new SuiteComparator().Compare(null!, ComparisonFixtures.Artifact());

        act.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Compare_NullCandidate_Refuses()
    {
        var act = () => new SuiteComparator().Compare(ComparisonFixtures.Artifact(), null!);

        act.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Compare_AtATighterLevel_JudgesTheAdjustedValueAgainstIt()
    {
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("regressed", ComparisonFixtures.Repeated(RunStatus.Pass, 10)),
            ComparisonFixtures.Scenario("fixed", ComparisonFixtures.Repeated(RunStatus.Fail, 4)),
        ]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("regressed", ComparisonFixtures.Repeated(RunStatus.Fail, 10)),
            ComparisonFixtures.Scenario("fixed", ComparisonFixtures.Repeated(RunStatus.Pass, 4)),
        ]);

        // The adjusted value is 0.00390625: significant at 1%, not at 0.1%.
        ComparisonFixtures
            .For(ComparisonFixtures.WithStatistics(0.01).Compare(baseline, candidate), "regressed")
            .Comparison!.Significant.Should()
            .Be(SignificanceVerdict.Significant);

        ComparisonFixtures
            .For(ComparisonFixtures.WithStatistics(0.001).Compare(baseline, candidate), "regressed")
            .Comparison!.Significant.Should()
            .Be(SignificanceVerdict.NotSignificant);
    }

    [Fact]
    public void Compare_TwoComparisonsBuiltFromIdenticalData_AreEqualByCanonicalValue()
    {
        var baseline = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Fail)]);
        var candidate = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)]);

        var first = new SuiteComparator().Compare(baseline, candidate);
        var second = new SuiteComparator().Compare(baseline, candidate);

        // The record holds collections, so the compiler-generated equality would compare them by
        // reference and report two identical comparisons as different.
        first.Should().Be(second);
        first.GetHashCode().Should().Be(second.GetHashCode());
    }

    [Fact]
    public void Compare_ComparisonsThatDiffer_AreNotEqual()
    {
        var baseline = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Fail)]);

        var fixedUp = new SuiteComparator().Compare(
            baseline,
            ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)])
        );
        var stillBroken = new SuiteComparator().Compare(
            baseline,
            ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Fail)])
        );

        fixedUp.Should().NotBe(stillBroken);
    }

    [Fact]
    public void Compare_WithoutStatistics_NeverCallsASignificanceTest()
    {
        var test = Substitute.For<ISignificanceTest>();

        new SuiteComparator().Compare(
            ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Fail)]),
            ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)])
        );

        test.ReceivedCalls().Should().BeEmpty();
    }
}
