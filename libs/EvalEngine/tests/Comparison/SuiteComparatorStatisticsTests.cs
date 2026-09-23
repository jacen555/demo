using FluentAssertions;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Comparison;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Statistics;
using Microsoft.Extensions.Logging;
using NSubstitute;

namespace Forge.EvalEngine.Tests.Comparison;

/// <summary>
/// The statistics the comparator overlays on its classification.
/// </summary>
/// <remarks>
/// Every p-value asserted here is exact. The per-scenario test is the exact conditional test on
/// the discordant repetitions, so a scenario with <c>b</c> discordant pairs all in one direction
/// has a two-sided p-value of <c>2 / 2^b</c> — arithmetic a reader can redo without running the
/// code. Asserting merely that "a p-value came back" is how a wrong one survives.
/// </remarks>
public sealed class SuiteComparatorStatisticsTests
{
    private static ComparisonResult CompareWithStatistics(
        IReadOnlyList<ScenarioResult> baseline,
        IReadOnlyList<ScenarioResult> candidate,
        double significanceLevel = SuiteComparator.DefaultSignificanceLevel
    ) =>
        ComparisonFixtures
            .WithStatistics(significanceLevel)
            .Compare(ComparisonFixtures.Artifact(baseline), ComparisonFixtures.Artifact(candidate));

    [Fact]
    public void Compare_WithoutStatistics_ReportsTheRawDeltaAndClaimsNothingElse()
    {
        var result = new SuiteComparator().Compare(
            ComparisonFixtures.Artifact([
                ComparisonFixtures.Scenario("a", ComparisonFixtures.Repeated(RunStatus.Pass, 4)),
            ]),
            ComparisonFixtures.Artifact([
                ComparisonFixtures.Scenario("a", ComparisonFixtures.Repeated(RunStatus.Fail, 4)),
            ])
        );

        var comparison = ComparisonFixtures.For(result, "a").Comparison;

        comparison.Should().NotBeNull();
        comparison!.EffectSize.Should().Be(-1.0);
        comparison.PValue.Should().BeNull();
        comparison.AdjustedPValue.Should().BeNull();
        comparison.Test.Should().BeNull();
        comparison.Significant.Should().Be(SignificanceVerdict.NotComputed);
        result.Suite.Should().BeNull();
        result.Correction.Should().BeNull();
    }

    [Fact]
    public void Compare_EffectSize_IsTheRawDifferenceInPassRate()
    {
        // Baseline passes three of four; the candidate passes one of four. The effect size is
        // the figure that is always honest, so it is reported with no test configured at all.
        var result = new SuiteComparator().Compare(
            ComparisonFixtures.Artifact([
                ComparisonFixtures.Scenario("a", [RunStatus.Pass, RunStatus.Pass, RunStatus.Pass, RunStatus.Fail]),
            ]),
            ComparisonFixtures.Artifact([
                ComparisonFixtures.Scenario("a", [RunStatus.Pass, RunStatus.Fail, RunStatus.Fail, RunStatus.Fail]),
            ])
        );

        ComparisonFixtures.For(result, "a").Comparison!.EffectSize.Should().Be(-0.5);
    }

    [Fact]
    public void Compare_ScenarioWithNoDiscordantRepetitions_ReportsNotComputedRatherThanANumber()
    {
        var result = CompareWithStatistics(
            [ComparisonFixtures.Scenario("a", ComparisonFixtures.Repeated(RunStatus.Pass, 4))],
            [ComparisonFixtures.Scenario("a", ComparisonFixtures.Repeated(RunStatus.Pass, 4))]
        );

        var comparison = ComparisonFixtures.For(result, "a").Comparison!;

        comparison.EffectSize.Should().Be(0.0);
        comparison.PValue.Should().BeNull();
        comparison.AdjustedPValue.Should().BeNull();
        comparison.Significant.Should().Be(SignificanceVerdict.NotComputed);
    }

    [Fact]
    public void Compare_ScenarioWithSixDiscordantRepetitions_ReportsTheExactConditionalPValue()
    {
        var result = CompareWithStatistics(
            [ComparisonFixtures.Scenario("a", ComparisonFixtures.Repeated(RunStatus.Pass, 6))],
            [ComparisonFixtures.Scenario("a", ComparisonFixtures.Repeated(RunStatus.Fail, 6))]
        );

        var comparison = ComparisonFixtures.For(result, "a").Comparison!;

        // Six discordant pairs, all in one direction: 2 * (1/2)^6 = 0.03125.
        comparison.PValue.Should().BeApproximately(0.03125, 0.03125 * 1e-12);
        comparison.Test.Should().Be(SignificanceTestKind.McNemar);
        comparison.EffectSize.Should().Be(-1.0);
    }

    [Fact]
    public void Compare_ScenarioWithFourDiscordantRepetitionsTheOtherWay_ReportsTheSamePValue()
    {
        var result = CompareWithStatistics(
            [ComparisonFixtures.Scenario("a", ComparisonFixtures.Repeated(RunStatus.Fail, 4))],
            [ComparisonFixtures.Scenario("a", ComparisonFixtures.Repeated(RunStatus.Pass, 4))]
        );

        // The test is two-sided: 2 * (1/2)^4 = 0.125, whichever direction the pairs favour.
        ComparisonFixtures.For(result, "a").Comparison!.PValue.Should().BeApproximately(0.125, 0.125 * 1e-12);
    }

    [Fact]
    public void Compare_SingleDiscordantRepetition_ReportsAPValueOfOne()
    {
        var result = CompareWithStatistics(
            [ComparisonFixtures.Scenario("a", RunStatus.Pass)],
            [ComparisonFixtures.Scenario("a", RunStatus.Fail)]
        );

        var comparison = ComparisonFixtures.For(result, "a");

        // One flip is no evidence at all. The classification still says what happened.
        comparison.Classification.Should().Be(ScenarioClassification.Regressed);
        comparison.Comparison!.PValue.Should().Be(1.0);
        comparison.Comparison.Significant.Should().Be(SignificanceVerdict.NotSignificant);
    }

    [Fact]
    public void Compare_ErroredRepetitions_AreConditionedAwayBeforeTheExactTest()
    {
        // Four repetitions, but the fourth errored under the candidate: three discordant pairs
        // reach the test, not four. 2 * (1/2)^3 = 0.25, where four would have given 0.125.
        var result = CompareWithStatistics(
            [ComparisonFixtures.Scenario("a", ComparisonFixtures.Repeated(RunStatus.Pass, 4))],
            [ComparisonFixtures.Scenario("a", [RunStatus.Fail, RunStatus.Fail, RunStatus.Fail, RunStatus.Error])]
        );

        var comparison = ComparisonFixtures.For(result, "a");

        comparison.GradedPairs.Should().Be(3);
        comparison.Comparison!.PValue.Should().BeApproximately(0.25, 0.25 * 1e-12);
    }

    [Fact]
    public void Compare_FamilyOfPerScenarioPValues_IsAdjustedAcrossTheSuite()
    {
        var result = CompareWithStatistics(
            [
                ComparisonFixtures.Scenario("regressed", ComparisonFixtures.Repeated(RunStatus.Pass, 6)),
                ComparisonFixtures.Scenario("fixed", ComparisonFixtures.Repeated(RunStatus.Fail, 4)),
                ComparisonFixtures.Scenario("stable", ComparisonFixtures.Repeated(RunStatus.Pass, 2)),
            ],
            [
                ComparisonFixtures.Scenario("regressed", ComparisonFixtures.Repeated(RunStatus.Fail, 6)),
                ComparisonFixtures.Scenario("fixed", ComparisonFixtures.Repeated(RunStatus.Pass, 4)),
                ComparisonFixtures.Scenario("stable", ComparisonFixtures.Repeated(RunStatus.Pass, 2)),
            ]
        );

        // Family of two: 0.03125 and 0.125. Benjamini-Hochberg steps up from the largest —
        // 0.125 * 2 / 2 = 0.125, then min(0.125, 0.03125 * 2 / 1) = 0.0625.
        ComparisonFixtures
            .For(result, "regressed")
            .Comparison!.AdjustedPValue.Should()
            .BeApproximately(0.0625, 0.0625 * 1e-12);
        ComparisonFixtures
            .For(result, "fixed")
            .Comparison!.AdjustedPValue.Should()
            .BeApproximately(0.125, 0.125 * 1e-12);
        result.Correction.Should().Be("benjamini-hochberg");
    }

    [Fact]
    public void Compare_ScenarioSignificantOnItsOwn_IsNotSignificantOnceTheFamilyIsCorrected()
    {
        var result = CompareWithStatistics(
            [
                ComparisonFixtures.Scenario("regressed", ComparisonFixtures.Repeated(RunStatus.Pass, 6)),
                ComparisonFixtures.Scenario("fixed", ComparisonFixtures.Repeated(RunStatus.Fail, 4)),
            ],
            [
                ComparisonFixtures.Scenario("regressed", ComparisonFixtures.Repeated(RunStatus.Fail, 6)),
                ComparisonFixtures.Scenario("fixed", ComparisonFixtures.Repeated(RunStatus.Pass, 4)),
            ]
        );

        var comparison = ComparisonFixtures.For(result, "regressed").Comparison!;

        // Uncorrected this would clear the 5% bar; corrected across the family it does not, and
        // the verdict follows the adjusted value rather than the raw one.
        comparison.PValue.Should().BeApproximately(0.03125, 0.03125 * 1e-12);
        comparison.PValue.Should().BeApproximately(0.03125, 0.03125 * 1e-12);
        comparison.AdjustedPValue.Should().BeApproximately(0.0625, 0.0625 * 1e-12);
        comparison.Significant.Should().Be(SignificanceVerdict.NotSignificant);
    }

    [Fact]
    public void Compare_ScenarioStillSignificantAfterCorrection_ReportsSignificant()
    {
        var result = CompareWithStatistics(
            [
                ComparisonFixtures.Scenario("regressed", ComparisonFixtures.Repeated(RunStatus.Pass, 10)),
                ComparisonFixtures.Scenario("fixed", ComparisonFixtures.Repeated(RunStatus.Fail, 4)),
            ],
            [
                ComparisonFixtures.Scenario("regressed", ComparisonFixtures.Repeated(RunStatus.Fail, 10)),
                ComparisonFixtures.Scenario("fixed", ComparisonFixtures.Repeated(RunStatus.Pass, 4)),
            ]
        );

        var comparison = ComparisonFixtures.For(result, "regressed").Comparison!;

        // 2 / 2^10 = 0.001953125, adjusted to min(0.125, 0.001953125 * 2) = 0.00390625.
        comparison.PValue.Should().BeApproximately(0.001953125, 0.001953125 * 1e-12);
        comparison.AdjustedPValue.Should().BeApproximately(0.00390625, 0.00390625 * 1e-12);
        comparison.Significant.Should().Be(SignificanceVerdict.Significant);
    }

    [Fact]
    public void Compare_ScenariosWithNoComputablePValue_AreExcludedFromTheCorrectedFamily()
    {
        // Three scenarios agree under both variants and so contribute no test. Counting them in
        // the family would inflate m from 2 to 5 and weaken every real finding: the regressed
        // scenario would be adjusted to 0.078125 instead of 0.0625.
        var stableBaseline = Enumerable
            .Range(0, 3)
            .Select(index =>
                ComparisonFixtures.Scenario($"stable-{index}", ComparisonFixtures.Repeated(RunStatus.Pass, 2))
            )
            .ToArray();

        var result = CompareWithStatistics(
            [
                ComparisonFixtures.Scenario("regressed", ComparisonFixtures.Repeated(RunStatus.Pass, 6)),
                ComparisonFixtures.Scenario("fixed", ComparisonFixtures.Repeated(RunStatus.Fail, 4)),
                .. stableBaseline,
            ],
            [
                ComparisonFixtures.Scenario("regressed", ComparisonFixtures.Repeated(RunStatus.Fail, 6)),
                ComparisonFixtures.Scenario("fixed", ComparisonFixtures.Repeated(RunStatus.Pass, 4)),
                .. stableBaseline,
            ]
        );

        ComparisonFixtures
            .For(result, "regressed")
            .Comparison!.AdjustedPValue.Should()
            .BeApproximately(0.0625, 0.0625 * 1e-12);
        ComparisonFixtures.For(result, "stable-0").Comparison!.AdjustedPValue.Should().BeNull();
    }

    [Fact]
    public void Compare_SuiteDelta_ComesFromTheInjectedSignificanceTest()
    {
        var result = CompareWithStatistics(
            [
                ComparisonFixtures.Scenario("regressed", RunStatus.Pass),
                ComparisonFixtures.Scenario("fixed", RunStatus.Fail),
                ComparisonFixtures.Scenario("stable", RunStatus.Pass),
            ],
            [
                ComparisonFixtures.Scenario("regressed", RunStatus.Fail),
                ComparisonFixtures.Scenario("fixed", RunStatus.Pass),
                ComparisonFixtures.Scenario("stable", RunStatus.Pass),
            ]
        );

        // One scenario each way plus one concordant: McNemar conditions on the two discordant
        // pairs, whose exact two-sided probability saturates at one, and the raw pass-rate
        // difference across the suite is zero.
        result.Suite.Should().NotBeNull();
        result.Suite!.EffectSize.Should().Be(0.0);
        result.Suite.PValue.Should().Be(1.0);
        result.Suite.Test.Should().Be(SignificanceTestKind.McNemar);
        result.Suite.Significant.Should().Be(SignificanceVerdict.NotSignificant);
    }

    [Fact]
    public void Compare_SuiteDeltaWithEveryScenarioRegressing_IsSignificant()
    {
        var baseline = Enumerable
            .Range(0, 6)
            .Select(index => ComparisonFixtures.Scenario($"scenario-{index}", RunStatus.Pass))
            .ToArray();
        var candidate = Enumerable
            .Range(0, 6)
            .Select(index => ComparisonFixtures.Scenario($"scenario-{index}", RunStatus.Fail))
            .ToArray();

        var result = CompareWithStatistics(baseline, candidate);

        result.Suite!.EffectSize.Should().Be(-1.0);
        result.Suite.PValue.Should().BeApproximately(0.03125, 0.03125 * 1e-12);
        result.Suite.Significant.Should().Be(SignificanceVerdict.Significant);
    }

    [Fact]
    public void Compare_SuiteDelta_CarriesNoAdjustedPValueBecauseItIsNotAFamily()
    {
        var result = CompareWithStatistics(
            [ComparisonFixtures.Scenario("a", RunStatus.Pass), ComparisonFixtures.Scenario("b", RunStatus.Fail)],
            [ComparisonFixtures.Scenario("a", RunStatus.Fail), ComparisonFixtures.Scenario("b", RunStatus.Pass)]
        );

        result.Suite!.AdjustedPValue.Should().BeNull();
    }

    [Fact]
    public void Compare_SuiteObservations_CarryTheSeedBothVariantsWereDrivenWith()
    {
        var test = Substitute.For<ISignificanceTest>();
        test.Kind.Returns(SignificanceTestKind.McNemar);
        test.Compare(Arg.Any<PairedObservations>(), Arg.Any<CancellationToken>())
            .Returns(new ComparisonSummary { EffectSize = 0 });

        new SuiteComparator(test, BenjaminiHochbergCorrection.Instance).Compare(
            ComparisonFixtures.Artifact([
                ComparisonFixtures.Scenario("a", ComparisonFixtures.Repeated(RunStatus.Fail, 2)),
            ]),
            ComparisonFixtures.Artifact([
                ComparisonFixtures.Scenario("a", ComparisonFixtures.Repeated(RunStatus.Pass, 2)),
            ])
        );

        var observations = (PairedObservations)test.ReceivedCalls().Single().GetArguments()[0]!;
        var pair = observations.Pairs.Should().ContainSingle().Subject;

        pair.ScenarioId.Should().Be("a");
        pair.Seed.Should().Be(ComparisonFixtures.SeedFor(0));
        pair.BaselineValue.Should().Be(0.0);
        pair.CandidateValue.Should().Be(1.0);
    }

    [Fact]
    public void Compare_NoComparableScenario_ReportsNoSuiteDeltaAndSignalsIt()
    {
        var logger = new RecordingComparatorLogger();
        var comparator = new SuiteComparator(new McNemarTest(), BenjaminiHochbergCorrection.Instance, 0.05, logger);

        var result = comparator.Compare(
            ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("only-in-baseline", RunStatus.Pass)]),
            ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("only-in-candidate", RunStatus.Pass)])
        );

        result.Suite.Should().BeNull();
        logger.Entries.Should().Contain(entry => entry.Level == LogLevel.Warning);
    }

    [Fact]
    public void Compare_NonBinaryPassRatesWithMcNemar_PropagatesTheRefusalRatherThanBinarising()
    {
        // The candidate passes three of four repetitions, so its per-scenario statistic is 0.75.
        // McNemar is defined on binary outcomes and says so; swallowing that and reporting a
        // number would mean reporting one that does not mean what it says.
        var act = () =>
            CompareWithStatistics(
                [ComparisonFixtures.Scenario("a", ComparisonFixtures.Repeated(RunStatus.Pass, 4))],
                [ComparisonFixtures.Scenario("a", [RunStatus.Pass, RunStatus.Pass, RunStatus.Pass, RunStatus.Fail])]
            );

        act.Should().Throw<ArgumentException>().WithMessage("*paired binary outcomes*");
    }

    [Fact]
    public void Compare_PairedBootstrapOverContinuousRates_IsAdmissible()
    {
        // The same suite the McNemar overload refuses is fine for a bootstrap, which is exactly
        // why PairedObservation carries a double rather than a bool.
        var comparator = new SuiteComparator(
            new PairedBootstrapTest(seed: 20260922),
            BenjaminiHochbergCorrection.Instance
        );

        var result = comparator.Compare(
            ComparisonFixtures.Artifact([
                ComparisonFixtures.Scenario("a", ComparisonFixtures.Repeated(RunStatus.Pass, 4)),
                ComparisonFixtures.Scenario("b", ComparisonFixtures.Repeated(RunStatus.Pass, 4)),
            ]),
            ComparisonFixtures.Artifact([
                ComparisonFixtures.Scenario("a", [RunStatus.Pass, RunStatus.Pass, RunStatus.Pass, RunStatus.Fail]),
                ComparisonFixtures.Scenario("b", [RunStatus.Pass, RunStatus.Pass, RunStatus.Fail, RunStatus.Fail]),
            ])
        );

        result.Suite.Should().NotBeNull();
        result.Suite!.Test.Should().Be(SignificanceTestKind.PairedBootstrap);
        result.Suite.EffectSize.Should().Be(-0.375);
    }

    [Fact]
    public void Compare_Cancelled_ThrowsRatherThanReturningAPartialComparison()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        var act = () =>
            ComparisonFixtures
                .WithStatistics()
                .Compare(
                    ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)]),
                    ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Fail)]),
                    cts.Token
                );

        act.Should().Throw<OperationCanceledException>();
    }

    [Fact]
    public void Compare_CancellationToken_ReachesTheSignificanceTest()
    {
        var test = Substitute.For<ISignificanceTest>();
        test.Kind.Returns(SignificanceTestKind.McNemar);
        test.Compare(Arg.Any<PairedObservations>(), Arg.Any<CancellationToken>())
            .Returns(new ComparisonSummary { EffectSize = 0 });

        using var cts = new CancellationTokenSource();

        new SuiteComparator(test, BenjaminiHochbergCorrection.Instance).Compare(
            ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)]),
            ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Fail)]),
            cts.Token
        );

        test.ReceivedCalls().Single().GetArguments()[1].Should().Be(cts.Token);
    }
}
