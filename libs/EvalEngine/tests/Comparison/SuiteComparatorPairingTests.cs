using FluentAssertions;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Comparison;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;
using Microsoft.Extensions.Logging;
using NSubstitute;

namespace Forge.EvalEngine.Tests.Comparison;

/// <summary>
/// The pairing is what the comparator is trusted for.
/// </summary>
/// <remarks>
/// Every test here describes a way two artifacts can agree on a scenario id while describing
/// different work. Each one, left unchecked, produces a confident delta that measures the harness
/// rather than the change — the same false-green shape as attributing a transcript to the wrong
/// run, moved up a level to attributing a whole scenario to the wrong baseline.
/// </remarks>
public sealed class SuiteComparatorPairingTests
{
    [Fact]
    public void Compare_SuiteNamesDiffer_RefusesRatherThanDiffing()
    {
        var baseline = ComparisonFixtures.Artifact(
            [ComparisonFixtures.Scenario("a", RunStatus.Pass)],
            suiteName: "nightly"
        );
        var candidate = ComparisonFixtures.Artifact(
            [ComparisonFixtures.Scenario("a", RunStatus.Fail)],
            suiteName: "regression-suite"
        );

        var act = () => new SuiteComparator().Compare(baseline, candidate);

        act.Should().Throw<ComparisonRefusedException>().Which.Property.Should().Be("suiteName");
    }

    [Fact]
    public void Compare_RootSeedsDiffer_RefusesBecauseThePairingWouldBeFabricated()
    {
        var baseline = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)], seed: 1);
        var candidate = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Fail)], seed: 2);

        var act = () => new SuiteComparator().Compare(baseline, candidate);

        act.Should().Throw<ComparisonRefusedException>().Which.Property.Should().Be("seed");
    }

    [Fact]
    public void Compare_HarnessConfigValueDiffers_RefusesRatherThanComparingUnlikeRuns()
    {
        var baseline = ComparisonFixtures.Artifact(
            [ComparisonFixtures.Scenario("a", RunStatus.Pass)],
            harnessConfig: ComparisonFixtures.Config(maxConcurrency: 1)
        );
        var candidate = ComparisonFixtures.Artifact(
            [ComparisonFixtures.Scenario("a", RunStatus.Fail)],
            harnessConfig: ComparisonFixtures.Config(maxConcurrency: 8)
        );

        var act = () => new SuiteComparator().Compare(baseline, candidate);

        act.Should().Throw<ComparisonRefusedException>().Which.Property.Should().Be("maxConcurrency");
    }

    [Fact]
    public void Compare_HarnessConfigIntervalMethodDiffers_RefusesRatherThanComparingUnlikeRuns()
    {
        var baseline = ComparisonFixtures.Artifact(
            [ComparisonFixtures.Scenario("a", RunStatus.Pass)],
            harnessConfig: ComparisonFixtures.Config(intervalMethod: "wilson")
        );
        var candidate = ComparisonFixtures.Artifact(
            [ComparisonFixtures.Scenario("a", RunStatus.Fail)],
            harnessConfig: ComparisonFixtures.Config(intervalMethod: "agrestiCoull")
        );

        var act = () => new SuiteComparator().Compare(baseline, candidate);

        act.Should().Throw<ComparisonRefusedException>().Which.Property.Should().Be("intervalMethod");
    }

    [Fact]
    public void Compare_HarnessConfigKeyPresentOnOneSideOnly_Refuses()
    {
        var candidateConfig = new Dictionary<string, string>(ComparisonFixtures.Config(), StringComparer.Ordinal)
        {
            ["throttleMilliseconds"] = "250",
        };

        var baseline = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)]);
        var candidate = ComparisonFixtures.Artifact(
            [ComparisonFixtures.Scenario("a", RunStatus.Pass)],
            harnessConfig: candidateConfig
        );

        var act = () => new SuiteComparator().Compare(baseline, candidate);

        act.Should().Throw<ComparisonRefusedException>().Which.Property.Should().Be("throttleMilliseconds");
    }

    [Fact]
    public void Compare_EndpointsDiffer_ComparesBecauseTwoAddressesIsThePoint()
    {
        var baseline = ComparisonFixtures.Artifact(
            [ComparisonFixtures.Scenario("a", RunStatus.Fail)],
            endpoint: "https://baseline.example/eval"
        );
        var candidate = ComparisonFixtures.Artifact(
            [ComparisonFixtures.Scenario("a", RunStatus.Pass)],
            endpoint: "https://candidate.example/eval"
        );

        var result = new SuiteComparator().Compare(baseline, candidate);

        ComparisonFixtures.For(result, "a").Classification.Should().Be(ScenarioClassification.Fixed);
    }

    [Fact]
    public void Compare_TimestampsAndBaselineRefsDiffer_ComparesBecauseNeitherIsAConfound()
    {
        var baseline = ComparisonFixtures.Artifact(
            [ComparisonFixtures.Scenario("a", RunStatus.Fail)],
            baselineRef: "main@abc1234",
            timestamp: TestData.FixedInstant
        );
        var candidate = ComparisonFixtures.Artifact(
            [ComparisonFixtures.Scenario("a", RunStatus.Pass)],
            baselineRef: "pr-42@def5678",
            timestamp: TestData.FixedInstant.AddHours(9)
        );

        var result = new SuiteComparator().Compare(baseline, candidate);

        ComparisonFixtures.For(result, "a").Classification.Should().Be(ScenarioClassification.Fixed);
    }

    [Fact]
    public void Compare_SameIdDifferentKind_MarksNotComparable()
    {
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Fail], kind: ScenarioKind.Rest),
        ]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Pass], kind: ScenarioKind.Llm),
        ]);

        var comparison = ComparisonFixtures.For(new SuiteComparator().Compare(baseline, candidate), "a");

        comparison.Classification.Should().Be(ScenarioClassification.NotComparable);
        comparison.NotComparableReason.Should().Contain("kind");
        comparison.Comparison.Should().BeNull();
    }

    [Fact]
    public void Compare_SameIdDifferentAssertions_MarksNotComparable()
    {
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Fail], assertions: ["slotAbsent:scope/confirm"]),
        ]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Pass], assertions: ["slotAbsent:scope/escalate"]),
        ]);

        var comparison = ComparisonFixtures.For(new SuiteComparator().Compare(baseline, candidate), "a");

        comparison.Classification.Should().Be(ScenarioClassification.NotComparable);
        comparison.NotComparableReason.Should().Contain("assertion");
    }

    [Fact]
    public void Compare_SameIdCandidateGradedAgainstAnExtraAssertion_MarksNotComparable()
    {
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Pass], assertions: ["slotAbsent:scope/confirm"]),
        ]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario(
                "a",
                [RunStatus.Pass],
                assertions: ["slotAbsent:scope/confirm", "slotAbsent:scope/escalate"]
            ),
        ]);

        ComparisonFixtures
            .For(new SuiteComparator().Compare(baseline, candidate), "a")
            .Classification.Should()
            .Be(ScenarioClassification.NotComparable);
    }

    [Fact]
    public void Compare_SameAssertionsInADifferentOrder_StillCompares()
    {
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario(
                "a",
                [RunStatus.Fail],
                assertions: ["slotAbsent:scope/confirm", "slotAbsent:scope/escalate"]
            ),
        ]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario(
                "a",
                [RunStatus.Pass],
                assertions: ["slotAbsent:scope/escalate", "slotAbsent:scope/confirm"]
            ),
        ]);

        ComparisonFixtures
            .For(new SuiteComparator().Compare(baseline, candidate), "a")
            .Classification.Should()
            .Be(ScenarioClassification.Fixed);
    }

    [Fact]
    public void Compare_SameIdDifferentRepetitionCount_MarksNotComparable()
    {
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", ComparisonFixtures.Repeated(RunStatus.Fail, 3)),
        ]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", ComparisonFixtures.Repeated(RunStatus.Pass, 5)),
        ]);

        var comparison = ComparisonFixtures.For(new SuiteComparator().Compare(baseline, candidate), "a");

        comparison.Classification.Should().Be(ScenarioClassification.NotComparable);
        comparison.NotComparableReason.Should().Contain("repetition");
    }

    [Fact]
    public void Compare_SameIdDifferentRunSeeds_MarksNotComparable()
    {
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Fail, RunStatus.Fail], seeds: [1000, 1001]),
        ]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Pass, RunStatus.Pass], seeds: [1000, 9999]),
        ]);

        var comparison = ComparisonFixtures.For(new SuiteComparator().Compare(baseline, candidate), "a");

        comparison.Classification.Should().Be(ScenarioClassification.NotComparable);
        comparison.NotComparableReason.Should().Contain("seed");
    }

    [Fact]
    public void Compare_SameSeedsInADifferentOrder_MarksNotComparableBecausePairingIsPositional()
    {
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Pass, RunStatus.Fail], seeds: [1000, 1001]),
        ]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Pass, RunStatus.Fail], seeds: [1001, 1000]),
        ]);

        ComparisonFixtures
            .For(new SuiteComparator().Compare(baseline, candidate), "a")
            .Classification.Should()
            .Be(ScenarioClassification.NotComparable);
    }

    [Fact]
    public void Compare_RepetitionPolicyDisagreesWithTheRunsRecorded_MarksNotComparable()
    {
        var baseline = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Pass], declaredRepetitions: 4),
        ]);

        var comparison = ComparisonFixtures.For(new SuiteComparator().Compare(baseline, candidate), "a");

        comparison.Classification.Should().Be(ScenarioClassification.NotComparable);
        comparison.NotComparableReason.Should().Contain("repetition");
    }

    [Fact]
    public void Compare_CandidateCarryingFewerRunsThanItDeclares_MarksNotComparableRatherThanReadingPastTheEnd()
    {
        // Both artifacts declare three repetitions, but the candidate recorded two. The seeds are
        // paired positionally against the baseline's run count, so without this check the walk
        // reads past the end of the candidate's runs.
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", ComparisonFixtures.Repeated(RunStatus.Pass, 3)),
        ]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", ComparisonFixtures.Repeated(RunStatus.Fail, 2), declaredRepetitions: 3),
        ]);

        var comparison = ComparisonFixtures.For(new SuiteComparator().Compare(baseline, candidate), "a");

        comparison.Classification.Should().Be(ScenarioClassification.NotComparable);
        comparison.NotComparableReason.Should().Contain("repetition");
    }

    [Fact]
    public void Compare_BaselineProducedNoGradeableRun_MarksNotComparableRatherThanFixed()
    {
        var baseline = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Error)]);
        var candidate = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)]);

        var comparison = ComparisonFixtures.For(new SuiteComparator().Compare(baseline, candidate), "a");

        comparison.Classification.Should().Be(ScenarioClassification.NotComparable);
        comparison.BaselineOutcome.Should().Be(ScenarioOutcome.Ungradeable);
        comparison.CandidateOutcome.Should().Be(ScenarioOutcome.Passed);
        comparison.Comparison.Should().BeNull();
    }

    [Fact]
    public void Compare_CandidateProducedNoGradeableRun_MarksNotComparableRatherThanRegressed()
    {
        var baseline = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)]);
        var candidate = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Error)]);

        var comparison = ComparisonFixtures.For(new SuiteComparator().Compare(baseline, candidate), "a");

        comparison.Classification.Should().Be(ScenarioClassification.NotComparable);
        comparison.CandidateOutcome.Should().Be(ScenarioOutcome.Ungradeable);
    }

    [Fact]
    public void Compare_ErroredRepetitionsThatNeverLineUp_MarksNotComparableRatherThanReportingNoChange()
    {
        // Each side graded one repetition, so each has evidence and both were graded against the
        // same assertion — but never in the *same* repetition, so there is no matched pair. With
        // nothing paired, both pass rates are drawn from an empty set and the delta between them
        // is a confident zero computed from nothing at all.
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Pass, RunStatus.Error]),
        ]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Error, RunStatus.Pass]),
        ]);

        var comparison = ComparisonFixtures.For(new SuiteComparator().Compare(baseline, candidate), "a");

        comparison.Classification.Should().Be(ScenarioClassification.NotComparable);
        comparison.NotComparableReason.Should().Contain("both variants produced a verdict");
        comparison.Comparison.Should().BeNull();
    }

    [Fact]
    public void Compare_BaselineWithNoGradeableRun_IsNotReportedAsNewlyCovered()
    {
        var baseline = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Error)]);
        var candidate = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)]);

        new SuiteComparator().Compare(baseline, candidate).NewlyCovered.Should().BeEmpty();
    }

    [Fact]
    public void Compare_NotComparableScenario_DoesNotVetoTheRestOfTheSuite()
    {
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("drifted", [RunStatus.Fail], kind: ScenarioKind.Rest),
            ComparisonFixtures.Scenario("sound", RunStatus.Fail),
        ]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("drifted", [RunStatus.Pass], kind: ScenarioKind.Llm),
            ComparisonFixtures.Scenario("sound", RunStatus.Pass),
        ]);

        var result = new SuiteComparator().Compare(baseline, candidate);

        ComparisonFixtures.For(result, "drifted").Classification.Should().Be(ScenarioClassification.NotComparable);
        ComparisonFixtures.For(result, "sound").Classification.Should().Be(ScenarioClassification.Fixed);
        result.NewlyCovered.Should().BeEquivalentTo(["sound"]);
    }

    [Fact]
    public void Compare_NotComparableScenario_IsSignalledOnceAtWarning()
    {
        var logger = new RecordingComparatorLogger();
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Fail], kind: ScenarioKind.Rest),
        ]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Pass], kind: ScenarioKind.Llm),
        ]);

        new SuiteComparator(null, null, 0.05, logger).Compare(baseline, candidate);

        logger.Entries.Should().ContainSingle().Which.Level.Should().Be(LogLevel.Warning);
        logger.Entries[0].Message.Should().Contain("a");
    }

    [Fact]
    public void Compare_NotComparableScenario_NeverReachesTheSignificanceTest()
    {
        var test = Substitute.For<ISignificanceTest>();
        test.Kind.Returns(Forge.EvalEngine.Results.SignificanceTestKind.McNemar);
        test.Compare(Arg.Any<PairedObservations>(), Arg.Any<CancellationToken>())
            .Returns(new ComparisonSummary { EffectSize = 0 });

        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("drifted", [RunStatus.Fail], kind: ScenarioKind.Rest),
            ComparisonFixtures.Scenario("sound", RunStatus.Fail),
        ]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("drifted", [RunStatus.Pass], kind: ScenarioKind.Llm),
            ComparisonFixtures.Scenario("sound", RunStatus.Pass),
        ]);

        new SuiteComparator(test, Forge.EvalEngine.Statistics.BenjaminiHochbergCorrection.Instance).Compare(
            baseline,
            candidate
        );

        var observations = (PairedObservations)test.ReceivedCalls().Single().GetArguments()[0]!;
        observations.Pairs.Select(pair => pair.ScenarioId).Should().BeEquivalentTo(["sound"]);
    }

    [Fact]
    public void Compare_DuplicateScenarioIdInCandidate_RefusesRatherThanPickingOne()
    {
        var baseline = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", RunStatus.Pass),
            ComparisonFixtures.Scenario("a", RunStatus.Fail),
        ]);

        var act = () => new SuiteComparator().Compare(baseline, candidate);

        act.Should().Throw<ArgumentException>().WithMessage("*more than once*");
    }

    [Fact]
    public void Compare_DuplicateScenarioIdInBaseline_RefusesRatherThanPickingOne()
    {
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", RunStatus.Pass),
            ComparisonFixtures.Scenario("a", RunStatus.Fail),
        ]);
        var candidate = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)]);

        var act = () => new SuiteComparator().Compare(baseline, candidate);

        act.Should().Throw<ArgumentException>().WithMessage("*more than once*");
    }

    [Fact]
    public void Compare_UndeclaredRunStatus_RefusesRatherThanGradingIt()
    {
        var baseline = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [(RunStatus)99], summarize: false),
        ]);

        var act = () => new SuiteComparator().Compare(baseline, candidate);

        act.Should().Throw<ArgumentException>().WithMessage("*not a declared*");
    }

    [Fact]
    public void Compare_ArtifactSummaryDisagreesWithItsRuns_TrustsTheRuns()
    {
        // A committed baseline is untrusted input. A hand-edited point estimate claiming a pass
        // must not be able to manufacture a regression against a candidate that really passed.
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario(
                "a",
                [RunStatus.Fail],
                summary: new StatisticalSummary
                {
                    N = 1,
                    PointEstimate = 1.0,
                    Dispersion = 0,
                }
            ),
        ]);
        var candidate = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)]);

        var comparison = ComparisonFixtures.For(new SuiteComparator().Compare(baseline, candidate), "a");

        comparison.Classification.Should().Be(ScenarioClassification.Fixed);
        comparison.BaselineOutcome.Should().Be(ScenarioOutcome.Failed);
    }

    [Fact]
    public void Compare_ScenarioWithNoRunsAtAll_MarksNotComparable()
    {
        var baseline = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", [], summarize: false)]);
        var candidate = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)]);

        ComparisonFixtures
            .For(new SuiteComparator().Compare(baseline, candidate), "a")
            .Classification.Should()
            .Be(ScenarioClassification.NotComparable);
    }
}
