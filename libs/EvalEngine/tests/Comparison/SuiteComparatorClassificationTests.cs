using FluentAssertions;
using Forge.EvalEngine.Comparison;
using Forge.EvalEngine.Results;

namespace Forge.EvalEngine.Tests.Comparison;

/// <summary>
/// Classification, and the newly-covered headline it feeds.
/// </summary>
/// <remarks>
/// Classification is a factual statement about what the two artifacts recorded, so none of it
/// depends on a significance test having been supplied. Every test here uses the comparator
/// without statistics to make that explicit.
/// </remarks>
public sealed class SuiteComparatorClassificationTests
{
    private static ScenarioComparison Classify(RunStatus[] baseline, RunStatus[] candidate) =>
        ComparisonFixtures.For(
            new SuiteComparator().Compare(
                ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", baseline)]),
                ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", candidate)])
            ),
            "a"
        );

    [Fact]
    public void Compare_PassedUnderBothVariants_ClassifiesStablePass()
    {
        var comparison = Classify([RunStatus.Pass], [RunStatus.Pass]);

        comparison.Classification.Should().Be(ScenarioClassification.StablePass);
        comparison.BaselineOutcome.Should().Be(ScenarioOutcome.Passed);
        comparison.CandidateOutcome.Should().Be(ScenarioOutcome.Passed);
    }

    [Fact]
    public void Compare_FailedUnderBothVariants_ClassifiesStableFail() =>
        Classify([RunStatus.Fail], [RunStatus.Fail]).Classification.Should().Be(ScenarioClassification.StableFail);

    [Fact]
    public void Compare_FailedThenPassed_ClassifiesFixed() =>
        Classify([RunStatus.Fail], [RunStatus.Pass]).Classification.Should().Be(ScenarioClassification.Fixed);

    [Fact]
    public void Compare_PassedThenFailed_ClassifiesRegressed() =>
        Classify([RunStatus.Pass], [RunStatus.Fail]).Classification.Should().Be(ScenarioClassification.Regressed);

    [Fact]
    public void Compare_ExpectedFailureThatNowPasses_ClassifiesFixed()
    {
        // A known gap is a graded non-pass, exactly as the aggregator treats it. When it clears,
        // that is newly-covered ground and the whole reason the status exists.
        var comparison = Classify([RunStatus.ExpectedFailure], [RunStatus.Pass]);

        comparison.Classification.Should().Be(ScenarioClassification.Fixed);
        comparison.BaselineOutcome.Should().Be(ScenarioOutcome.Failed);
    }

    [Fact]
    public void Compare_ExpectedFailureUnderBothVariants_ClassifiesStableFail() =>
        Classify([RunStatus.ExpectedFailure], [RunStatus.ExpectedFailure])
            .Classification.Should()
            .Be(ScenarioClassification.StableFail);

    [Fact]
    public void Compare_PartiallyPassingCandidate_ClassifiesFailedBecauseNotEveryRunPassed()
    {
        var comparison = Classify(
            [RunStatus.Fail, RunStatus.Fail, RunStatus.Fail, RunStatus.Fail],
            [RunStatus.Pass, RunStatus.Pass, RunStatus.Pass, RunStatus.Fail]
        );

        comparison.Classification.Should().Be(ScenarioClassification.StableFail);
        comparison.CandidateOutcome.Should().Be(ScenarioOutcome.Failed);
    }

    [Fact]
    public void Compare_ErroredRepetitionOnOneSide_IsExcludedFromTheGradedPairs()
    {
        var comparison = Classify(
            [RunStatus.Fail, RunStatus.Fail, RunStatus.Fail],
            [RunStatus.Pass, RunStatus.Error, RunStatus.Pass]
        );

        // Two repetitions produced a verdict under both variants; the third produced none under
        // the candidate and is conditioned away rather than counted as a failure.
        comparison.GradedPairs.Should().Be(2);
        comparison.Classification.Should().Be(ScenarioClassification.Fixed);
    }

    [Fact]
    public void Compare_EveryRepetitionErroredOnOneSideOnly_MarksNotComparable()
    {
        Classify([RunStatus.Error, RunStatus.Error], [RunStatus.Pass, RunStatus.Pass])
            .Classification.Should()
            .Be(ScenarioClassification.NotComparable);
    }

    [Fact]
    public void Compare_ScenarioOnlyInCandidate_ClassifiesNew()
    {
        var result = new SuiteComparator().Compare(
            ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)]),
            ComparisonFixtures.Artifact([
                ComparisonFixtures.Scenario("a", RunStatus.Pass),
                ComparisonFixtures.Scenario("b", RunStatus.Pass),
            ])
        );

        var comparison = ComparisonFixtures.For(result, "b");

        comparison.Classification.Should().Be(ScenarioClassification.New);
        comparison.BaselineOutcome.Should().Be(ScenarioOutcome.Absent);
        comparison.CandidateOutcome.Should().Be(ScenarioOutcome.Passed);
        comparison.Comparison.Should().BeNull();
    }

    [Fact]
    public void Compare_ScenarioOnlyInBaseline_ClassifiesRemoved()
    {
        var result = new SuiteComparator().Compare(
            ComparisonFixtures.Artifact([
                ComparisonFixtures.Scenario("a", RunStatus.Pass),
                ComparisonFixtures.Scenario("gone", RunStatus.Pass),
            ]),
            ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)])
        );

        var comparison = ComparisonFixtures.For(result, "gone");

        comparison.Classification.Should().Be(ScenarioClassification.Removed);
        comparison.BaselineOutcome.Should().Be(ScenarioOutcome.Passed);
        comparison.CandidateOutcome.Should().Be(ScenarioOutcome.Absent);
    }

    [Fact]
    public void Compare_MixedSuite_OrdersCandidateScenariosFirstThenBaselineOnlyOnes()
    {
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("kept", RunStatus.Pass),
            ComparisonFixtures.Scenario("gone-1", RunStatus.Pass),
            ComparisonFixtures.Scenario("gone-2", RunStatus.Fail),
        ]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("added", RunStatus.Pass),
            ComparisonFixtures.Scenario("kept", RunStatus.Pass),
        ]);

        var result = new SuiteComparator().Compare(baseline, candidate);

        result
            .ScenarioComparisons.Select(comparison => comparison.ScenarioId)
            .Should()
            .Equal("added", "kept", "gone-1", "gone-2");
    }

    [Fact]
    public void Compare_SuiteName_IsCarriedOntoTheResult() =>
        new SuiteComparator()
            .Compare(
                ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)]),
                ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)])
            )
            .SuiteName.Should()
            .Be(ComparisonFixtures.SuiteName);

    [Fact]
    public void Compare_TwoEmptySuites_ComparesToAnEmptyResult()
    {
        var result = new SuiteComparator().Compare(ComparisonFixtures.Artifact(), ComparisonFixtures.Artifact());

        result.ScenarioComparisons.Should().BeEmpty();
        result.NewlyCovered.Should().BeEmpty();
        result.Suite.Should().BeNull();
    }
}

/// <summary>
/// <see cref="ComparisonResult.NewlyCovered"/> is the headline of the report, so it gets its own
/// suite rather than being checked incidentally.
/// </summary>
public sealed class SuiteComparatorNewlyCoveredTests
{
    [Fact]
    public void Compare_FixedScenario_IsNewlyCovered()
    {
        var result = new SuiteComparator().Compare(
            ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Fail)]),
            ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)])
        );

        result.NewlyCovered.Should().Equal("a");
    }

    [Fact]
    public void Compare_NewAndPassingScenario_IsNewlyCovered()
    {
        var result = new SuiteComparator().Compare(
            ComparisonFixtures.Artifact(),
            ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)])
        );

        result.NewlyCovered.Should().Equal("a");
    }

    [Fact]
    public void Compare_NewAndFailingScenario_IsNotNewlyCovered()
    {
        var result = new SuiteComparator().Compare(
            ComparisonFixtures.Artifact(),
            ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Fail)])
        );

        ComparisonFixtures.For(result, "a").Classification.Should().Be(ScenarioClassification.New);
        result.NewlyCovered.Should().BeEmpty();
    }

    [Fact]
    public void Compare_NewButUngradeableScenario_IsNotNewlyCovered()
    {
        var result = new SuiteComparator().Compare(
            ComparisonFixtures.Artifact(),
            ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Error)])
        );

        ComparisonFixtures.For(result, "a").CandidateOutcome.Should().Be(ScenarioOutcome.Ungradeable);
        result.NewlyCovered.Should().BeEmpty();
    }

    [Fact]
    public void Compare_RegressedScenario_IsNotNewlyCovered() =>
        new SuiteComparator()
            .Compare(
                ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)]),
                ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Fail)])
            )
            .NewlyCovered.Should()
            .BeEmpty();

    [Fact]
    public void Compare_StablePassScenario_IsNotNewlyCoveredBecauseTheBaselineAlreadyCoveredIt() =>
        new SuiteComparator()
            .Compare(
                ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)]),
                ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)])
            )
            .NewlyCovered.Should()
            .BeEmpty();

    [Fact]
    public void Compare_RemovedScenario_IsNotNewlyCovered() =>
        new SuiteComparator()
            .Compare(
                ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)]),
                ComparisonFixtures.Artifact()
            )
            .NewlyCovered.Should()
            .BeEmpty();

    [Fact]
    public void Compare_MixedSuite_ReportsEveryNewlyCoveredScenarioInResultOrder()
    {
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("was-broken", RunStatus.Fail),
            ComparisonFixtures.Scenario("was-fine", RunStatus.Pass),
            ComparisonFixtures.Scenario("broke", RunStatus.Pass),
            ComparisonFixtures.Scenario("still-broken", RunStatus.Fail),
        ]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("brand-new-passing", RunStatus.Pass),
            ComparisonFixtures.Scenario("was-broken", RunStatus.Pass),
            ComparisonFixtures.Scenario("was-fine", RunStatus.Pass),
            ComparisonFixtures.Scenario("broke", RunStatus.Fail),
            ComparisonFixtures.Scenario("still-broken", RunStatus.Fail),
            ComparisonFixtures.Scenario("brand-new-failing", RunStatus.Fail),
        ]);

        var result = new SuiteComparator().Compare(baseline, candidate);

        result.NewlyCovered.Should().Equal("brand-new-passing", "was-broken");
        ComparisonFixtures.For(result, "broke").Classification.Should().Be(ScenarioClassification.Regressed);
        ComparisonFixtures.For(result, "still-broken").Classification.Should().Be(ScenarioClassification.StableFail);
    }
}
