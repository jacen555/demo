using System.Text.Json;
using System.Text.Json.Nodes;
using FluentAssertions;
using Forge.EvalEngine.Comparison;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Serialization;
using Microsoft.Extensions.Logging;

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
    public void Compare_FixedScenarioWithAnErroredRepetition_IsNotNewlyCovered()
    {
        // [Pass, Pass, Error] measures as Passed, because an errored repetition is conditioned
        // out of the denominator rather than counted. The scenario passed every run that
        // produced a verdict, which is not the same as passing every run the suite asked for.
        var result = new SuiteComparator().Compare(
            ComparisonFixtures.Artifact([
                ComparisonFixtures.Scenario("a", [RunStatus.Fail, RunStatus.Fail, RunStatus.Fail]),
            ]),
            ComparisonFixtures.Artifact([
                ComparisonFixtures.Scenario("a", [RunStatus.Pass, RunStatus.Pass, RunStatus.Error]),
            ])
        );

        ComparisonFixtures.For(result, "a").Classification.Should().Be(ScenarioClassification.Fixed);
        result.NewlyCovered.Should().BeEmpty();
        ComparisonFixtures.Withheld(result, "a").Cause.Should().Be(CoverageWithholdingCause.Errored);
    }

    [Fact]
    public void Compare_NewScenarioWithAnErroredRepetition_IsNotNewlyCovered()
    {
        // The New branch guards on CandidateOutcome == Passed, which has the identical hole:
        // Graded=2, Passed=2 reads as Passed while a third repetition never ran.
        var result = new SuiteComparator().Compare(
            ComparisonFixtures.Artifact(),
            ComparisonFixtures.Artifact([
                ComparisonFixtures.Scenario("a", [RunStatus.Pass, RunStatus.Pass, RunStatus.Error]),
            ])
        );

        ComparisonFixtures.For(result, "a").Classification.Should().Be(ScenarioClassification.New);
        result.NewlyCovered.Should().BeEmpty();
        ComparisonFixtures.Withheld(result, "a").Cause.Should().Be(CoverageWithholdingCause.Errored);
    }

    [Fact]
    public void Compare_WithheldScenario_KeepsTheOutcomeAndClassificationItsRunsEarned()
    {
        // Requirement: this is about what gets claimed, not how a scenario is classified. The
        // comparison still reports Fixed, and the candidate still measures Passed over its
        // gradeable runs — only the coverage claim is withheld.
        var result = new SuiteComparator().Compare(
            ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", [RunStatus.Fail, RunStatus.Fail])]),
            ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", [RunStatus.Pass, RunStatus.Error])])
        );

        var comparison = ComparisonFixtures.For(result, "a");

        comparison.Classification.Should().Be(ScenarioClassification.Fixed);
        comparison.CandidateOutcome.Should().Be(ScenarioOutcome.Passed);
        comparison.BaselineOutcome.Should().Be(ScenarioOutcome.Failed);
        comparison.GradedPairs.Should().Be(1);
        ComparisonFixtures.WithheldIds(result).Should().Equal("a");
    }

    [Fact]
    public void Compare_FullyConductedScenarios_AreStillNewlyCoveredAndNothingIsWithheld()
    {
        // The other half of the contract: withholding must not swallow coverage that was
        // genuinely earned. Both variants conduct every repetition they declare.
        var result = new SuiteComparator().Compare(
            ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("was-broken", [RunStatus.Fail, RunStatus.Fail])]),
            ComparisonFixtures.Artifact([
                ComparisonFixtures.Scenario("was-broken", [RunStatus.Pass, RunStatus.Pass]),
                ComparisonFixtures.Scenario("brand-new", [RunStatus.Pass, RunStatus.Pass]),
            ])
        );

        result.NewlyCovered.Should().Equal("was-broken", "brand-new");
        result.NewlyCoveredWithheld.Should().BeEmpty();
    }

    [Fact]
    public void Compare_BaselineErroredButCandidateFullyConducted_IsStillNewlyCovered()
    {
        // The claim is about what the candidate now covers. The candidate answered every
        // repetition it was asked, so the coverage is real; the baseline's missing repetition
        // is already visible as a fall in GradedPairs.
        var result = new SuiteComparator().Compare(
            ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", [RunStatus.Fail, RunStatus.Error])]),
            ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", [RunStatus.Pass, RunStatus.Pass])])
        );

        ComparisonFixtures.For(result, "a").GradedPairs.Should().Be(1);
        result.NewlyCovered.Should().Equal("a");
        result.NewlyCoveredWithheld.Should().BeEmpty();
    }

    [Fact]
    public void Compare_ScenarioThatNeverClaimedCoverage_IsNotListedAsWithheld()
    {
        // A regressed scenario and a wholly ungradeable new one were never going to be claimed,
        // so naming them as withheld would overstate what the fix is refusing.
        var result = new SuiteComparator().Compare(
            ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("broke", [RunStatus.Pass, RunStatus.Pass])]),
            ComparisonFixtures.Artifact([
                ComparisonFixtures.Scenario("broke", [RunStatus.Fail, RunStatus.Error]),
                ComparisonFixtures.Scenario("never-ran", [RunStatus.Error, RunStatus.Error]),
            ])
        );

        ComparisonFixtures.For(result, "broke").Classification.Should().Be(ScenarioClassification.Regressed);
        ComparisonFixtures.For(result, "never-ran").CandidateOutcome.Should().Be(ScenarioOutcome.Ungradeable);
        result.NewlyCovered.Should().BeEmpty();
        result.NewlyCoveredWithheld.Should().BeEmpty();
    }

    [Fact]
    public void Compare_WithheldScenario_IsSignalledOnceAtWarning()
    {
        var logger = new RecordingComparatorLogger();

        ComparisonFixtures
            .WithStatistics(logger: logger)
            .Compare(
                ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", [RunStatus.Fail, RunStatus.Fail])]),
                ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", [RunStatus.Pass, RunStatus.Error])])
            );

        var entries = logger.Entries.Where(entry => entry.Message.Contains("not claimed as newly covered")).ToArray();

        entries.Should().ContainSingle();
        entries[0].Level.Should().Be(LogLevel.Warning);
        entries[0].Message.Should().Contain("a").And.Contain("at least one repetition errored");
    }

    [Fact]
    public void Equals_ResultsDifferingOnlyInTheWithheldList_AreNotEqual()
    {
        // Every other property is held identical, so this can only pass if NewlyCoveredWithheld
        // itself participates in canonical equality. The earlier version of this test also
        // varied NewlyCovered, so it passed whether or not the withheld fields counted.
        var without = new ComparisonResult { SuiteName = "s", NewlyCovered = ["a"] };
        var with = without with
        {
            NewlyCoveredWithheld = [ComparisonFixtures.Withholding("b", CoverageWithholdingCause.Errored)],
        };

        without.Equals(with).Should().BeFalse();
    }

    // -----------------------------------------------------------------------------------------
    // Conducted in full, not merely free of errors.
    // -----------------------------------------------------------------------------------------

    [Fact]
    public void Compare_NewScenarioRecordingFewerRepetitionsThanDeclared_IsNotNewlyCovered()
    {
        // One Pass recorded against two declared repetitions. Nothing errored, so a check that
        // asks "did a repetition error?" sees nothing wrong — but the suite asked twice and got
        // one answer. A candidate-only scenario has no counterpart, so the pairing checks that
        // catch a short artifact on the Fixed path never run here.
        var result = new SuiteComparator().Compare(
            ComparisonFixtures.Artifact(),
            ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", [RunStatus.Pass], declaredRepetitions: 2)])
        );

        ComparisonFixtures.For(result, "a").Classification.Should().Be(ScenarioClassification.New);
        ComparisonFixtures.For(result, "a").CandidateOutcome.Should().Be(ScenarioOutcome.Passed);
        result.NewlyCovered.Should().BeEmpty();
        ComparisonFixtures.Withheld(result, "a").Cause.Should().Be(CoverageWithholdingCause.Incomplete);
    }

    [Fact]
    public void Compare_NewScenarioRecordingMoreRepetitionsThanDeclared_IsNotNewlyCovered()
    {
        // The mirror: an artifact recording more than it declared disagrees with itself just as
        // badly, and is no more trustworthy a basis for a coverage claim.
        var result = new SuiteComparator().Compare(
            ComparisonFixtures.Artifact(),
            ComparisonFixtures.Artifact([
                ComparisonFixtures.Scenario("a", [RunStatus.Pass, RunStatus.Pass], declaredRepetitions: 1),
            ])
        );

        result.NewlyCovered.Should().BeEmpty();
        ComparisonFixtures.Withheld(result, "a").Cause.Should().Be(CoverageWithholdingCause.OverRecorded);
    }

    [Fact]
    public void Compare_NewScenarioRecordingMoreRepetitionsThanDeclared_IsSignalledWithThatCause()
    {
        // The log carries the per-scenario cause, so it has to be wrong in the same place or
        // right in the same place as the reported reason. They are now one value rather than
        // two that happen to agree.
        var logger = new RecordingComparatorLogger();

        ComparisonFixtures
            .WithStatistics(logger: logger)
            .Compare(
                ComparisonFixtures.Artifact(),
                ComparisonFixtures.Artifact([
                    ComparisonFixtures.Scenario("a", [RunStatus.Pass, RunStatus.Pass], declaredRepetitions: 1),
                ])
            );

        var entries = logger.Entries.Where(entry => entry.Message.Contains("not claimed as newly covered")).ToArray();

        entries.Should().ContainSingle();
        entries[0].Message.Should().Contain("more repetitions").And.NotContain("never happened");
    }

    [Fact]
    public void Compare_PairedScenariosBothRecordingFewerRepetitionsThanDeclared_AreNotComparable()
    {
        // Refutes the paired variant of the same hole. The structural check compares each side's
        // run count against its OWN declared policy rather than against the other side, so two
        // equally short artifacts do not agree their way past it.
        var result = new SuiteComparator().Compare(
            ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", [RunStatus.Fail], declaredRepetitions: 2)]),
            ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", [RunStatus.Pass], declaredRepetitions: 2)])
        );

        var comparison = ComparisonFixtures.For(result, "a");

        comparison.Classification.Should().Be(ScenarioClassification.NotComparable);
        comparison.NotComparableReason.Should().Contain("does not match the runs recorded under it");
        result.NewlyCovered.Should().BeEmpty();
    }

    [Fact]
    public void RepetitionPolicy_Always_CarriesACountOfOneOrMoreThatCannotBeAbsent()
    {
        // The guard above counts recorded runs against this declared figure, so a policy that
        // could be zero or missing would make that guard a false one. Probed rather than assumed.
        var belowOne = () => RepetitionPolicy.Repeat(0);
        belowOne.Should().Throw<ArgumentOutOfRangeException>();

        RepetitionPolicy.Once.Repetitions.Should().Be(1);

        var zeroFromJson = () => CanonicalJson.Deserialize<RepetitionPolicy>("0");
        zeroFromJson.Should().Throw<JsonException>();

        var node = JsonNode
            .Parse(CanonicalJson.Serialize(ComparisonFixtures.Scenario("a", RunStatus.Pass)))!
            .AsObject();
        node.Remove("repetitionPolicyUsed");
        var absent = () => CanonicalJson.Deserialize<ScenarioResult>(node.ToJsonString());

        absent.Should().Throw<JsonException>();
    }

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
