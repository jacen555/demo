using FluentAssertions;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Tests.Support;
using Forge.EvalEngine.Results;

namespace Forge.EvalCli.Tests.Cli;

/// <summary>
/// The trend's analysis: what order the series is in, what a hole in it means, and what it
/// refuses to trend at all.
/// </summary>
/// <remarks>
/// <b>These are the tests the report's honesty rests on.</b> A series ordered by anything other
/// than what the runs recorded, a hole classified as continuity, or a refusal that returns an
/// empty trend instead of throwing are all the same defect — evidence from one context presented
/// as though it came from another — and all three are cheapest to pin here, before any of it
/// reaches a renderer.
/// </remarks>
public class SuiteTrendTests
{
    // ---------------------------------------------------------------------------------------
    // Ordering.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public void Build_WhenArtifactsArriveOutOfOrder_OrdersThemByTheTimestampTheRunsRecorded()
    {
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(3, TrendFixture.Scenario("checkout", 5, 5)),
            TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 1, 5)),
            TrendFixture.Artifact(2, TrendFixture.Scenario("checkout", 3, 5)),
        ]);

        trend
            .Artifacts.Select(artifact => artifact.Result.Environment.Timestamp)
            .Should()
            .BeInAscendingOrder()
            .And.HaveCount(3);
    }

    [Fact]
    public void Build_WhenFileNameOrderContradictsTheRecordedTimestamps_FollowsTheTimestamps()
    {
        // The shape an artifact-download step produces: names that sort one way, runs that
        // happened the other. Ordering on the name would draw the trend backwards.
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(
                TrendFixture.Start.AddDays(2),
                "artifacts/a-first.json",
                [TrendFixture.Scenario("checkout", 5, 5)]
            ),
            TrendFixture.Artifact(
                TrendFixture.Start,
                "artifacts/z-last.json",
                [TrendFixture.Scenario("checkout", 1, 5)]
            ),
        ]);

        trend
            .Artifacts.Select(artifact => artifact.Label)
            .Should()
            .Equal("artifacts/z-last.json", "artifacts/a-first.json");
    }

    [Fact]
    public void Build_WhenTwoArtifactsCarryTheSameInstant_RefusesRatherThanBreakingTheTieArbitrarily()
    {
        var refusal = Assert.Throws<EvalCliException>(() =>
            SuiteTrend.Build([
                TrendFixture.Artifact(
                    TrendFixture.Start,
                    "artifacts/one.json",
                    [TrendFixture.Scenario("checkout", 5, 5)]
                ),
                TrendFixture.Artifact(
                    TrendFixture.Start,
                    "artifacts/two.json",
                    [TrendFixture.Scenario("checkout", 1, 5)]
                ),
            ])
        );

        refusal.ExitCode.Should().Be(ExitCode.ComparisonRefused);
        refusal.Message.Should().Contain("artifacts/one.json").And.Contain("artifacts/two.json");
        refusal.Message.Should().Contain("same instant");
    }

    [Fact]
    public void Build_WhenTwoArtifactsCarryOneInstantInDifferentOffsets_StillRefuses()
    {
        // The same moment written two ways. Comparing the offset-bearing text rather than the
        // instant would order them arbitrarily and call it a trend.
        var refusal = Assert.Throws<EvalCliException>(() =>
            SuiteTrend.Build([
                TrendFixture.Artifact(
                    new DateTimeOffset(2026, 1, 5, 9, 0, 0, TimeSpan.Zero),
                    "artifacts/utc.json",
                    [TrendFixture.Scenario("checkout", 5, 5)]
                ),
                TrendFixture.Artifact(
                    new DateTimeOffset(2026, 1, 5, 10, 0, 0, TimeSpan.FromHours(1)),
                    "artifacts/local.json",
                    [TrendFixture.Scenario("checkout", 1, 5)]
                ),
            ])
        );

        refusal.Message.Should().Contain("same instant");
    }

    [Fact]
    public void Build_WhenAnArtifactsOffsetDisagreesWithItsWallClock_OrdersOnTheInstantAndNotTheWallClock()
    {
        // 08:30-02:00 is 10:30Z — later than 09:00Z by instant and earlier by wall-clock reading.
        // A run conducted in a non-UTC zone produces exactly this, and sorting on the local
        // reading draws the series backwards while every timestamp on the page still looks
        // plausible.
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(
                new DateTimeOffset(2026, 1, 5, 8, 30, 0, TimeSpan.FromHours(-2)),
                "artifacts/later.json",
                [TrendFixture.Scenario("checkout", 5, 5)]
            ),
            TrendFixture.Artifact(
                new DateTimeOffset(2026, 1, 5, 9, 0, 0, TimeSpan.Zero),
                "artifacts/earlier.json",
                [TrendFixture.Scenario("checkout", 1, 5)]
            ),
        ]);

        trend
            .Artifacts.Select(artifact => artifact.Label)
            .Should()
            .Equal("artifacts/earlier.json", "artifacts/later.json");
    }

    // ---------------------------------------------------------------------------------------
    // Refusals.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public void Build_WhenTheDirectoryYieldsOneArtifact_RefusesRatherThanRenderingNoMovement()
    {
        var refusal = Assert.Throws<EvalCliException>(() =>
            SuiteTrend.Build([TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 5, 5))])
        );

        refusal.ExitCode.Should().Be(ExitCode.ComparisonRefused);
        refusal.Message.Should().Contain("1 artifact");

        // Nothing is malformed here, so the remedy must not send the caller off to regenerate a
        // file that is fine. Pinned because the generic one read plausibly and was wrong.
        refusal.Remedy.Should().Contain("at least two run artifacts").And.NotContain("Regenerate");
    }

    [Fact]
    public void Build_WhenTheDirectoryYieldsNothing_RefusesRatherThanRenderingAnEmptyChart()
    {
        var refusal = Assert.Throws<EvalCliException>(() => SuiteTrend.Build([]));

        refusal.ExitCode.Should().Be(ExitCode.ComparisonRefused);
    }

    [Fact]
    public void Build_WhenTwoArtifactsAreRunsOfDifferentSuites_Refuses()
    {
        var refusal = Assert.Throws<EvalCliException>(() =>
            SuiteTrend.Build([
                TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 5, 5)),
                TrendFixture.Artifact(
                    TrendFixture.Start.AddDays(1),
                    "artifacts/other.json",
                    [TrendFixture.Scenario("checkout", 5, 5)],
                    suiteName: "smoke"
                ),
            ])
        );

        refusal.Message.Should().Contain("regression").And.Contain("smoke");
    }

    [Fact]
    public void Build_WhenAScenarioWasRedefinedMidSeries_RefusesTheWholeSeries()
    {
        var refusal = Assert.Throws<EvalCliException>(() =>
            SuiteTrend.Build([
                TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 5, 5)),
                TrendFixture.Artifact(
                    TrendFixture.Start.AddDays(1),
                    "artifacts/two.json",
                    [TrendFixture.Fingerprinted(ReportFixture.Scenario("checkout", 5, 5), "sha256:bbbb")]
                ),
            ])
        );

        refusal.ExitCode.Should().Be(ExitCode.ComparisonRefused);
        refusal.Message.Should().Contain("checkout").And.Contain("redefined");
    }

    [Fact]
    public void Build_WhenAnArtifactRecordsNoFingerprintForASharedScenario_Refuses()
    {
        var refusal = Assert.Throws<EvalCliException>(() =>
            SuiteTrend.Build([
                TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 5, 5)),
                TrendFixture.Artifact(
                    TrendFixture.Start.AddDays(1),
                    "artifacts/two.json",
                    [TrendFixture.Fingerprinted(ReportFixture.Scenario("checkout", 5, 5), fingerprint: null)]
                ),
            ])
        );

        refusal.Message.Should().Contain("checkout").And.Contain("does not record");
    }

    [Fact]
    public void Build_WhenOneScenarioAppearsAndAnotherDisappears_DoesNotTreatThatAsAFingerprintDisagreement()
    {
        // Membership moving is the movement this report exists to show. Folding it into the
        // fingerprint would refuse exactly the series worth trending.
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 5, 5), TrendFixture.Scenario("legacy", 5, 5)),
            TrendFixture.Artifact(2, TrendFixture.Scenario("checkout", 5, 5), TrendFixture.Scenario("refunds", 4, 5)),
        ]);

        trend.Appeared.Should().Equal("refunds");
        trend.Disappeared.Should().Equal("legacy");
    }

    [Fact]
    public void Build_WhenTwoArtifactsRecordDifferentIntervalConfidence_Refuses()
    {
        var refusal = Assert.Throws<EvalCliException>(() =>
            SuiteTrend.Build([
                TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 5, 5)),
                TrendFixture.Artifact(
                    TrendFixture.Start.AddDays(1),
                    "artifacts/two.json",
                    [TrendFixture.Scenario("checkout", 5, 5)],
                    confidence: 0.99
                ),
            ])
        );

        refusal.Message.Should().Contain("intervalConfidence");
    }

    [Fact]
    public void Build_WhenTheThrottleChangedMidSeries_ReportsItAsACaveatRatherThanRefusing()
    {
        // Unlike the interval settings, a throttle does not change what a printed figure means.
        // It changes what the run observed, which is a reason the line moved that is not
        // behaviour — named at the position it moved, not used to destroy the whole series.
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 5, 5)),
            TrendFixture.Artifact(
                TrendFixture.Start.AddDays(1),
                "artifacts/two.json",
                [TrendFixture.Scenario("checkout", 5, 5)],
                concurrency: 8
            ),
        ]);

        trend.Caveats.Should().ContainSingle();
        trend.Caveats[0].Setting.Should().Be("maxConcurrency");
        trend.Caveats[0].Position.Should().Be(2);
        trend.Caveats[0].Before.Should().Be("1");
        trend.Caveats[0].After.Should().Be("8");
    }

    [Fact]
    public void Build_WhenTheSeedChangedMidSeries_ReportsItAsACaveatRatherThanRefusing()
    {
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 5, 5)),
            TrendFixture.Artifact(
                TrendFixture.Start.AddDays(1),
                "artifacts/two.json",
                [TrendFixture.Scenario("checkout", 5, 5)],
                seed: 42
            ),
        ]);

        trend.Caveats.Should().ContainSingle(caveat => caveat.Setting == "seed");
    }

    // ---------------------------------------------------------------------------------------
    // Gap classification.
    // ---------------------------------------------------------------------------------------

    private static SuiteTrend WithHole() =>
        SuiteTrend.Build([
            TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 5, 5)),
            TrendFixture.Artifact(2, TrendFixture.Scenario("other", 5, 5)),
            TrendFixture.Artifact(3, TrendFixture.Scenario("checkout", 4, 5)),
        ]);

    private static TrendSeries SeriesFor(SuiteTrend trend, string id) =>
        trend.Series.Single(series => series.ScenarioId == id);

    [Fact]
    public void Build_WhenAScenarioIsMissingFromTheMiddleOfASeries_ClassifiesTheHoleAsInterior()
    {
        var series = SeriesFor(WithHole(), "checkout");

        series.Observations[1].Point.Should().Be(TrendPoint.NotRecorded);
        series.Observations[1].Gap.Should().Be(TrendGap.Interior);
        series.InteriorGaps.Should().Be(1);
    }

    [Fact]
    public void Build_WhenAScenarioIsRecorded_LeavesNoGapBesideIt()
    {
        var series = SeriesFor(WithHole(), "checkout");

        series.Observations[0].Gap.Should().Be(TrendGap.None);
        series.Observations[2].Gap.Should().Be(TrendGap.None);
    }

    [Fact]
    public void Build_WhenNoArtifactUpToAPositionRecordsAScenario_ClassifiesItAsBeforeTheFirstRecord()
    {
        var series = SeriesFor(WithHole(), "other");

        series.Observations[0].Gap.Should().Be(TrendGap.BeforeFirstRecord);
    }

    [Fact]
    public void Build_WhenNoArtifactFromAPositionOnRecordsAScenario_ClassifiesItAsAfterTheLastRecord()
    {
        var series = SeriesFor(WithHole(), "other");

        series.Observations[2].Gap.Should().Be(TrendGap.AfterLastRecord);
    }

    [Fact]
    public void Build_WhenAScenarioRanAndNothingWasLearned_ClassifiesItUngradeableRatherThanAbsent()
    {
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 5, 5)),
            TrendFixture.Artifact(
                TrendFixture.Start.AddDays(1),
                "artifacts/two.json",
                [TrendFixture.Ungradeable("checkout")]
            ),
        ]);

        var series = SeriesFor(trend, "checkout");

        series.Observations[1].Point.Should().Be(TrendPoint.Ungradeable);
        series.Observations[1].Gap.Should().Be(TrendGap.None);
        series.Observations[1].Recorded.Should().NotBeNull();
    }

    [Fact]
    public void Build_WhenAnArtifactsFiguresDoNotDescribeItsOwnRuns_ClassifiesThePointWithheld()
    {
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 5, 5)),
            TrendFixture.Artifact(
                TrendFixture.Start.AddDays(1),
                "artifacts/two.json",
                [TrendFixture.Fingerprinted(ReportFixture.Tampered("checkout"))]
            ),
        ]);

        SeriesFor(trend, "checkout").Observations[1].Point.Should().Be(TrendPoint.Withheld);
    }

    [Fact]
    public void Build_WhenARunGradedRepetitionsButRecordedNoSummary_WithholdsRatherThanCallingItUngradeable()
    {
        // Two different no-summary cases, and this is the one where something *was* learned: the
        // repetitions produced verdicts and the artifact carries no aggregate over them. Reading
        // that as "nothing was learned" would be this report's own defect turned inward — and the
        // renderer already contradicts it, because Rate says "withheld" for exactly this shape.
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 5, 5)),
            TrendFixture.Artifact(
                TrendFixture.Start.AddDays(1),
                "artifacts/two.json",
                [TrendFixture.Fingerprinted(ReportFixture.Scenario("checkout", 5, 5) with { Summary = null })]
            ),
        ]);

        SeriesFor(trend, "checkout").Observations[1].Point.Should().Be(TrendPoint.Withheld);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Build_WhenNoRepetitionProducedAVerdictButASummaryWasRecorded_IsUngradeableAndOutOfTheCore(
        bool carriesBounds
    )
    {
        // The summary claims an aggregate over runs it does not have. Believing it before
        // checking the runs beneath it puts a scenario nobody graded into the stable core, where
        // it contributes a pass rate of zero to the most authoritative figure in the document.
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 5, 5)),
            TrendFixture.Artifact(
                TrendFixture.Start.AddDays(1),
                "artifacts/two.json",
                [TrendFixture.Fingerprinted(ReportFixture.SummarisedWithoutVerdicts("checkout", carriesBounds))]
            ),
        ]);

        SeriesFor(trend, "checkout").Observations[1].Point.Should().Be(TrendPoint.Ungradeable);
        trend.StableCore.Should().BeEmpty();
    }

    [Fact]
    public void Build_WhenAnIntervalMethodIsRecordedThatThisBuildDoesNotKnow_StillTrendsTheSeries()
    {
        // Both artifacts agree on the recorded text, so there is nothing to refuse — the series
        // is trendable and its bounds simply cannot be checked. What must not happen is the
        // bounds being shown or compared anyway; TrendReportTests pins that half.
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(
                TrendFixture.Start,
                "artifacts/one.json",
                [TrendFixture.Scenario("checkout", 4, 5)],
                intervalMethod: "bootstrap"
            ),
            TrendFixture.Artifact(
                TrendFixture.Start.AddDays(1),
                "artifacts/two.json",
                [TrendFixture.Scenario("checkout", 5, 5)],
                intervalMethod: "bootstrap"
            ),
        ]);

        trend.Settings.Confidence.Should().NotBeNull();
        trend.Settings.Method.Should().BeNull();
    }

    // ---------------------------------------------------------------------------------------
    // The stable core, and the suite-level population.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public void Build_WhenAScenarioIsMissingFromOneArtifact_KeepsItOutOfTheStableCore()
    {
        var trend = WithHole();

        trend.StableCore.Should().BeEmpty();
        SeriesFor(trend, "checkout").InStableCore.Should().BeFalse();
    }

    [Fact]
    public void Build_WhenAScenarioIsGradedEverywhere_PutsItInTheStableCore()
    {
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 5, 5), TrendFixture.Scenario("late", 1, 5)),
            TrendFixture.Artifact(2, TrendFixture.Scenario("checkout", 4, 5)),
        ]);

        trend.StableCore.Should().Equal("checkout");
    }

    [Fact]
    public void Build_WhenAScenarioIsUngradeableInOneArtifact_KeepsItOutOfTheStableCore()
    {
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 5, 5)),
            TrendFixture.Artifact(
                TrendFixture.Start.AddDays(1),
                "artifacts/two.json",
                [TrendFixture.Ungradeable("checkout")]
            ),
        ]);

        trend.StableCore.Should().BeEmpty();
    }

    [Fact]
    public void Build_WhenScenariosOutsideTheCoreMove_LeavesTheSuiteLevelFiguresUntouched()
    {
        // The finding this is designed against: a suite figure that averages over whatever was
        // present moves when the population changes rather than when behaviour does. `noisy`
        // swings from nothing to everything between the two artifacts and must not appear in
        // either position's figures.
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 4, 5)),
            TrendFixture.Artifact(2, TrendFixture.Scenario("checkout", 4, 5), TrendFixture.Scenario("noisy", 0, 5)),
        ]);

        trend.Positions.Select(position => position.CorePassed).Should().Equal(4, 4);
        trend.Positions.Select(position => position.CoreGraded).Should().Equal(5, 5);
        trend.Positions.Select(position => position.ScenariosRecorded).Should().Equal(1, 2);
    }

    [Fact]
    public void Build_WhenNoScenarioIsGradedEverywhere_LeavesTheCoreEmptyRatherThanPoolingWhatItHas()
    {
        var trend = WithHole();

        trend.Positions.Select(position => position.CoreGraded).Should().AllSatisfy(graded => graded.Should().Be(0));
    }

    [Fact]
    public void Build_WhenAScenarioAppearsLate_NamesItAsAppearedAndNotAsDisappeared()
    {
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 5, 5)),
            TrendFixture.Artifact(2, TrendFixture.Scenario("checkout", 5, 5), TrendFixture.Scenario("refunds", 5, 5)),
        ]);

        trend.Appeared.Should().Equal("refunds");
        trend.Disappeared.Should().BeEmpty();
    }

    [Fact]
    public void Build_WhenAScenarioIsMissingOnlyFromTheMiddle_IsNeitherAppearedNorDisappeared()
    {
        var trend = WithHole();

        trend.Appeared.Should().NotContain("checkout");
        trend.Disappeared.Should().NotContain("checkout");
    }

    [Fact]
    public void Build_WhenTheSeriesRuns_GivesEveryScenarioOneObservationPerArtifact()
    {
        var trend = WithHole();

        trend
            .Series.Should()
            .AllSatisfy(series => series.Observations.Select(entry => entry.Position).Should().Equal(1, 2, 3));
    }

    [Fact]
    public void Build_WhenArtifactsCarryScenariosInAnyOrder_OrdersTheSeriesByIdentifier()
    {
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(1, TrendFixture.Scenario("zulu", 5, 5), TrendFixture.Scenario("alpha", 5, 5)),
            TrendFixture.Artifact(2, TrendFixture.Scenario("alpha", 5, 5), TrendFixture.Scenario("mike", 5, 5)),
        ]);

        trend.Series.Select(series => series.ScenarioId).Should().Equal("alpha", "mike", "zulu");
    }

    [Fact]
    public void Build_WhenAnArtifactRecordsTheSameScenarioTwice_Refuses()
    {
        // One id filed twice in one artifact means the join key does not identify a scenario,
        // and every figure downstream of it would silently pick a side.
        var refusal = Assert.Throws<EvalCliException>(() =>
            SuiteTrend.Build([
                TrendFixture.Artifact(
                    1,
                    TrendFixture.Scenario("checkout", 5, 5),
                    TrendFixture.Scenario("checkout", 1, 5)
                ),
                TrendFixture.Artifact(2, TrendFixture.Scenario("checkout", 5, 5)),
            ])
        );

        refusal.Message.Should().Contain("checkout").And.Contain("twice");
    }

    [Fact]
    public void Build_WhenTheSeriesIsClean_NamesTheSuiteOnce()
    {
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 5, 5)),
            TrendFixture.Artifact(2, TrendFixture.Scenario("checkout", 5, 5)),
        ]);

        trend.SuiteName.Should().Be("regression");
        trend.Caveats.Should().BeEmpty();
    }

    [Fact]
    public void Build_WhenGivenNull_Throws() => Assert.Throws<ArgumentNullException>(() => SuiteTrend.Build(null!));

    [Fact]
    public void Build_WhenAnArtifactCarriesANullScenario_Refuses()
    {
        var refusal = Assert.Throws<EvalCliException>(() =>
            SuiteTrend.Build([
                TrendFixture.Artifact(
                    TrendFixture.Start,
                    "artifacts/one.json",
                    [null!, TrendFixture.Scenario("checkout", 5, 5)]
                ),
                TrendFixture.Artifact(2, TrendFixture.Scenario("checkout", 5, 5)),
            ])
        );

        refusal.Message.Should().Contain("artifacts/one.json");
    }

    [Fact]
    public void Build_WhenAScenarioIsRecordedOnlyInOneArtifactOfThree_StillCarriesEveryPosition()
    {
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 5, 5)),
            TrendFixture.Artifact(2, TrendFixture.Scenario("checkout", 5, 5), TrendFixture.Scenario("once", 5, 5)),
            TrendFixture.Artifact(3, TrendFixture.Scenario("checkout", 5, 5)),
        ]);

        var series = SeriesFor(trend, "once");

        series
            .Observations.Select(entry => entry.Gap)
            .Should()
            .Equal(TrendGap.BeforeFirstRecord, TrendGap.None, TrendGap.AfterLastRecord);
    }

    [Fact]
    public void Build_WhenAScenarioRecordsNoFingerprintAndAppearsOnlyOnce_IsStillTrended()
    {
        // Nothing to disagree with: the fingerprint check establishes that two artifacts mean the
        // same thing by one id, and there is only one artifact carrying this one.
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 5, 5)),
            TrendFixture.Artifact(
                TrendFixture.Start.AddDays(1),
                "artifacts/two.json",
                [
                    TrendFixture.Scenario("checkout", 5, 5),
                    TrendFixture.Fingerprinted(ReportFixture.Scenario("legacy", 5, 5), fingerprint: null),
                ]
            ),
        ]);

        SeriesFor(trend, "legacy").Recorded.Should().Be(1);
    }

    [Fact]
    public void Build_WhenAnArtifactRecordsNoIntervalSettings_IsNotTreatedAsADisagreementWithAnotherThatDoesNot()
    {
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(
                TrendFixture.Start,
                "artifacts/one.json",
                [TrendFixture.Scenario("checkout", 5, 5)],
                confidence: null,
                intervalMethod: null
            ),
            TrendFixture.Artifact(
                TrendFixture.Start.AddDays(1),
                "artifacts/two.json",
                [TrendFixture.Scenario("checkout", 5, 5)],
                confidence: null,
                intervalMethod: null
            ),
        ]);

        trend.Artifacts.Should().HaveCount(2);
    }

    [Fact]
    public void Build_WhenOnlyOneArtifactRecordsIntervalSettings_Refuses()
    {
        var refusal = Assert.Throws<EvalCliException>(() =>
            SuiteTrend.Build([
                TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 5, 5)),
                TrendFixture.Artifact(
                    TrendFixture.Start.AddDays(1),
                    "artifacts/two.json",
                    [TrendFixture.Scenario("checkout", 5, 5)],
                    confidence: null,
                    intervalMethod: null
                ),
            ])
        );

        // Both keys disagree; the refusal names the first it reaches, which is enough to send a
        // reader at the artifact that recorded nothing.
        refusal.Message.Should().Contain("intervalMethod").And.Contain("records none");
    }

    [Fact]
    public void Build_WhenAScenarioChangedKindBetweenArtifacts_Refuses()
    {
        var refusal = Assert.Throws<EvalCliException>(() =>
            SuiteTrend.Build([
                TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 5, 5)),
                TrendFixture.Artifact(
                    TrendFixture.Start.AddDays(1),
                    "artifacts/two.json",
                    [TrendFixture.Scenario("checkout", 5, 5) with { Kind = Forge.EvalEngine.Scenarios.ScenarioKind.Ui }]
                ),
            ])
        );

        refusal.Message.Should().Contain("checkout").And.Contain("kind");
    }
}
