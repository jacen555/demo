using FluentAssertions;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Tests.Support;

namespace Forge.EvalCli.Tests.Cli;

/// <summary>
/// What the trend report puts on the page.
/// </summary>
/// <remarks>
/// <b>One failure mode governs every test here: a gap rendering as a flat line.</b> A reader
/// looking at a trend is looking for movement, so a line that appears steady is a positive claim
/// of stability. Every hole in the record must therefore reach the page as a hole, and every rate
/// must carry the <c>n</c> that produced it.
/// </remarks>
public class TrendReportTests
{
    private static SuiteTrend Clean() =>
        SuiteTrend.Build([
            TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 4, 5)),
            TrendFixture.Artifact(2, TrendFixture.Scenario("checkout", 5, 5)),
        ]);

    private static SuiteTrend Holed() =>
        SuiteTrend.Build([
            TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 4, 5)),
            TrendFixture.Artifact(2, TrendFixture.Scenario("other", 5, 5)),
            TrendFixture.Artifact(3, TrendFixture.Scenario("checkout", 5, 5)),
        ]);

    // ---------------------------------------------------------------------------------------
    // A gap never renders as continuity.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public void Render_WhenAScenarioIsMissingFromTheMiddle_SaysSoAtThatPosition()
    {
        var markdown = TrendFixture.Render(Holed());

        markdown.Should().Contain("no record").And.Contain("2.");
        markdown.Should().Contain("Gaps in the record");
    }

    [Fact]
    public void Render_WhenAScenarioIsMissingFromTheMiddle_NeverDrawsARateAcrossTheHole()
    {
        var markdown = TrendFixture.Render(Holed());

        // The hole must not be filled by repeating either neighbour's figure.
        markdown.Should().NotContain("80% (n=5, 95% Wilson CI 37.6%-96.4%) → 80%");
    }

    [Fact]
    public void Render_WhenASeriesHasAGap_NamesWhatTheGapCouldAndCouldNotMean()
    {
        var markdown = TrendFixture.Render(Holed());

        markdown.Should().Contain("not selected");
        markdown.Should().Contain("the artifact does not say");
    }

    [Fact]
    public void Render_WhenAScenarioHasNotBeenRecordedYet_DoesNotCallThatAGapInTheMiddle()
    {
        var markdown = TrendFixture.Render(Holed());

        markdown.Should().Contain("no artifact up to this point records it");
    }

    [Fact]
    public void Render_WhenAScenarioStoppedBeingRecorded_SaysTheRecordStoppedRatherThanThatItPassed()
    {
        var markdown = TrendFixture.Render(Holed());

        markdown.Should().Contain("no artifact from this point on records it");
    }

    [Fact]
    public void Render_WhenTheOnlyHoleIsInTheMiddle_UsesTheInteriorWordingAndNoOther()
    {
        // The three hole wordings must be told apart, not merely all be present somewhere. In a
        // series whose only hole is interior, the leading and trailing wordings are claims about
        // this record that are false — and one wording reused for all three would read as a
        // scenario that had not started yet where in fact it stopped being measured.
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 4, 5)),
            TrendFixture.Artifact(
                TrendFixture.Start.AddDays(1),
                "artifacts/two.json",
                [TrendFixture.Scenario("filler", 5, 5)]
            ),
            TrendFixture.Artifact(3, TrendFixture.Scenario("checkout", 5, 5)),
        ]);

        var body = TrendFixture.Render(trend).Split("### Per-scenario series")[1];
        var checkout = body.Split("- `checkout`")[1].Split("- `filler`")[0];

        checkout.Should().Contain("a gap: artifacts on both sides of this one record it");
        checkout.Should().NotContain("no artifact up to this point records it");
        checkout.Should().NotContain("no artifact from this point on records it");
    }

    [Fact]
    public void Render_WhenTheGapsSectionNamesAScenario_UsesTheWordingOfItsOwnShapeAndNoOther()
    {
        // The summary section carries its own three wordings, and each is a claim about what the
        // hole is consistent with. One reused across shapes would tell a reader that a scenario
        // which stopped being measured had not started yet — a refusal rendering as a different
        // refusal, which is no better than rendering as an absence.
        var section = TrendFixture.Render(Holed()).Split("### Gaps in the record")[1].Split("### Per-scenario")[0];

        var checkout = section.Split("- `checkout`")[1].Split("- `other`")[0];
        var other = section.Split("- `other`")[1];

        checkout.Should().Contain("a gap inside the record");
        checkout.Should().NotContain("no record yet").And.NotContain("no record since");

        other.Should().Contain("no record yet").And.Contain("no record since");
        other.Should().NotContain("a gap inside the record");
    }

    [Fact]
    public void Render_WhenAScenarioRanAndNothingWasLearned_DoesNotRenderThatAsAPassRateOfZero()
    {
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 5, 5)),
            TrendFixture.Artifact(
                TrendFixture.Start.AddDays(1),
                "artifacts/two.json",
                [TrendFixture.Ungradeable("checkout")]
            ),
        ]);

        var markdown = TrendFixture.Render(trend);

        markdown.Should().Contain("no repetition produced a verdict");
        markdown.Should().NotContain("| 0% |");
    }

    // ---------------------------------------------------------------------------------------
    // Every rate carries its denominator.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public void Render_WhenAPerScenarioRateIsShown_CarriesTheNAndTheIntervalBesideIt()
    {
        var markdown = TrendFixture.Render(Clean());

        markdown.Should().Contain("n=5").And.Contain("Wilson CI");
    }

    [Fact]
    public void Render_WhenASuiteLevelRateIsShown_CarriesTheDenominatorItRestsOn()
    {
        var markdown = TrendFixture.Render(Clean());

        markdown.Should().Contain("n=5 graded repetition(s)");
    }

    [Fact]
    public void Render_WhenASuiteLevelRateIsShown_SaysWhyItCarriesNoInterval()
    {
        var markdown = TrendFixture.Render(Clean());

        markdown.Should().Contain("not a single binomial experiment");
    }

    [Fact]
    public void Render_WhenAnArtifactsFiguresDoNotDescribeItsRuns_WithholdsThemRatherThanPrintingThem()
    {
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 5, 5)),
            TrendFixture.Artifact(
                TrendFixture.Start.AddDays(1),
                "artifacts/two.json",
                [TrendFixture.Fingerprinted(ReportFixture.Tampered("checkout"))]
            ),
        ]);

        var markdown = TrendFixture.Render(trend);

        markdown.Should().Contain("withheld").And.Contain("does not match the runs beside it");
        markdown.Should().NotContain("100% (n=100");
    }

    // ---------------------------------------------------------------------------------------
    // The suite-level population.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public void Render_WhenTheSuiteFigureIsShown_StatesThePopulationItWasComputedOver()
    {
        var markdown = TrendFixture.Render(Clean());

        markdown.Should().Contain("stable core");
        markdown.Should().Contain("graded in every artifact");
    }

    [Fact]
    public void Render_WhenSomeScenariosAreOutsideTheCore_SaysHowManyAndWhy()
    {
        var markdown = TrendFixture.Render(Holed());

        markdown.Should().Contain("no scenario was graded in every artifact");
    }

    [Fact]
    public void Render_WhenNoScenarioIsGradedEverywhere_RefusesTheSuiteFigureRatherThanShowingZero()
    {
        var markdown = TrendFixture.Render(Holed());

        markdown.Should().NotContain("**Suite pass rate** 0%");
        markdown.Should().Contain("No suite-level rate is reported");
    }

    [Fact]
    public void Render_WhenScenariosAppearedOrDisappeared_NamesThemInTheirOwnSections()
    {
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 5, 5), TrendFixture.Scenario("legacy", 5, 5)),
            TrendFixture.Artifact(2, TrendFixture.Scenario("checkout", 5, 5), TrendFixture.Scenario("refunds", 5, 5)),
        ]);

        var markdown = TrendFixture.Render(trend);

        markdown.Should().Contain("### Newly appeared (1)").And.Contain("`refunds`");
        markdown.Should().Contain("### No longer recorded (1)").And.Contain("`legacy`");
    }

    [Fact]
    public void Render_WhenNothingAppearedOrDisappeared_StillRendersThoseSectionsSoTheSilenceIsReadable()
    {
        var markdown = TrendFixture.Render(Clean());

        markdown.Should().Contain("### Newly appeared (0)").And.Contain("### No longer recorded (0)");
    }

    // ---------------------------------------------------------------------------------------
    // Movement.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public void Render_WhenAScenarioMoved_StatesTheDeltaWithBothDenominators()
    {
        var markdown = TrendFixture.Render(Clean());

        markdown.Should().Contain("+20").And.Contain("no significance test");
    }

    [Fact]
    public void Render_WhenTheTwoEndpointIntervalsOverlap_SaysTheMovementIsNotEstablished()
    {
        var markdown = TrendFixture.Render(Clean());

        markdown.Should().Contain("overlap");
    }

    [Fact]
    public void Render_WhenTheRunRecordedNoIntervalSettings_MakesNoOverlapClaimAtAll()
    {
        // `Rate` refuses to show these bounds — they could not be checked against anything — so
        // nothing may reason from them either. A value untrustworthy enough to withhold from
        // display and trustworthy enough to draw a conclusion from is one judgement made twice
        // and answered differently, and the overlap sentence is the honest-making part of the
        // movement line: a fabricated one buys false confidence exactly where warranted
        // confidence was being offered.
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(
                TrendFixture.Start,
                "artifacts/one.json",
                [TrendFixture.Scenario("checkout", 4, 5)],
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

        var markdown = TrendFixture.Render(trend);

        markdown.Should().NotContain("overlap");
        markdown.Should().Contain("no interval this report is willing to show");
    }

    [Fact]
    public void Render_WhenAnEndpointRestsOnASingleObservation_MakesNoOverlapClaim()
    {
        // At n=1 the Wilson interval spans most of the unit interval and `Rate` prints no
        // interval for exactly that reason. Comparing the bounds it declined to print would
        // reinstate the reading it declined to offer.
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 0, 1)),
            TrendFixture.Artifact(2, TrendFixture.Scenario("checkout", 1, 1)),
        ]);

        var markdown = TrendFixture.Render(trend);

        markdown.Should().NotContain("overlap");
        markdown.Should().Contain("+100 points").And.Contain("no interval this report is willing to show");
    }

    [Fact]
    public void Render_WhenTwoRunsAreLessThanASecondApart_RendersTheirTimestampsDistinctly()
    {
        // The order is decided on ticks and the page must show enough to agree with it. Two
        // correctly ordered runs printed as one timestamp, beside a refusal about runs stamped
        // with the same instant, reads as a tool that failed to make its own check.
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(
                TrendFixture.Start.AddTicks(20),
                "artifacts/second.json",
                [TrendFixture.Scenario("checkout", 5, 5)]
            ),
            TrendFixture.Artifact(
                TrendFixture.Start,
                "artifacts/first.json",
                [TrendFixture.Scenario("checkout", 4, 5)]
            ),
        ]);

        var roster = TrendFixture.Render(trend).Split("### The series")[1].Split("### Suite-level")[0];

        // The position prefix is stripped: `- **1.** <stamp> — …` and `- **2.** <stamp> — …`
        // differ on the position alone, so comparing whole lines would pass however coarse the
        // timestamp format is.
        var stamps = roster
            .Split('\n')
            .Where(line => line.Contains("artifacts/", StringComparison.Ordinal))
            .Select(line => line.Split("** ")[1].Split('—')[0].Trim())
            .ToArray();

        stamps.Should().HaveCount(2);
        stamps[0].Should().NotBe(stamps[1]);
    }

    [Fact]
    public void Render_WhenALevelIsRecordedButTheMethodIsNot_ShowsNoBoundsAndClaimsNoOverlap()
    {
        // Half-configured settings: present enough to pass a null check, not enough to check a
        // bound against. `Inconsistent` skips verification entirely here, so anything that
        // displayed or compared these bounds would be presenting an unverified figure as a
        // verified one — in the two places a reader weighs most heavily.
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

        var markdown = TrendFixture.Render(trend);

        markdown.Should().NotContain(" CI ").And.NotContain("overlap");
        markdown.Should().Contain("could not be verified and is not shown");
        markdown.Should().Contain("no interval this report is willing to show");
    }

    [Fact]
    public void Render_WhenAMethodIsRecordedButTheLevelIsNot_ShowsNoBoundsAndDoesNotFault()
    {
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(
                TrendFixture.Start,
                "artifacts/one.json",
                [TrendFixture.Scenario("checkout", 4, 5)],
                confidence: null,
                intervalMethod: "wilson"
            ),
            TrendFixture.Artifact(
                TrendFixture.Start.AddDays(1),
                "artifacts/two.json",
                [TrendFixture.Scenario("checkout", 5, 5)],
                confidence: null,
                intervalMethod: "wilson"
            ),
        ]);

        var markdown = TrendFixture.Render(trend);

        markdown.Should().NotContain(" CI ").And.NotContain("overlap");
        markdown.Should().Contain("could not be verified and is not shown");
    }

    [Fact]
    public void Render_WhenNoRepetitionProducedAVerdictButASummaryWasRecorded_ShowsNoRateForThatPosition()
    {
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 5, 5)),
            TrendFixture.Artifact(
                TrendFixture.Start.AddDays(1),
                "artifacts/two.json",
                [TrendFixture.Fingerprinted(ReportFixture.SummarisedWithoutVerdicts("checkout", interval: true))]
            ),
        ]);

        var markdown = TrendFixture.Render(trend);

        markdown.Should().Contain("no repetition produced a verdict");
        markdown.Should().NotContain("0% (n=0");
        markdown.Should().Contain("No suite-level rate is reported");
    }

    [Fact]
    public void Render_WhenAScenarioWasGradedOnlyOnce_StatesThatRatherThanAMovementOfZero()
    {
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 5, 5)),
            TrendFixture.Artifact(2, TrendFixture.Scenario("checkout", 5, 5), TrendFixture.Scenario("once", 5, 5)),
        ]);

        var markdown = TrendFixture.Render(trend);

        markdown.Should().Contain("graded once in this series, so it has no movement to state");
    }

    // ---------------------------------------------------------------------------------------
    // Provenance, identity, and size.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public void Render_WhenTheReportIsBuilt_OpensWithAMarkerDistinctFromTheComparisonReports()
    {
        var markdown = TrendFixture.Render(Clean());

        markdown.Should().StartWith("<!-- eval-cli:trend:");
        markdown.Should().NotContain("<!-- eval-cli:report:");
    }

    [Fact]
    public void Render_WhenTheReportIsBuilt_SaysTheMarkdownIsNeverReadBack()
    {
        var markdown = TrendFixture.Render(Clean());

        markdown.Should().Contain("never read back");
    }

    [Fact]
    public void Render_WhenTheSeriesIsOrdered_SaysWhatItWasOrderedBy()
    {
        var markdown = TrendFixture.Render(Clean());

        markdown.Should().Contain("ordered by the start time each run recorded");
        markdown.Should().Contain("never by file name");
    }

    [Fact]
    public void Render_WhenASettingMovedMidSeries_NamesItAndThePositionItMovedAt()
    {
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 5, 5)),
            TrendFixture.Artifact(
                TrendFixture.Start.AddDays(1),
                "artifacts/two.json",
                [TrendFixture.Scenario("checkout", 5, 5)],
                concurrency: 8
            ),
        ]);

        var markdown = TrendFixture.Render(trend);

        markdown.Should().Contain("maxConcurrency").And.Contain("`1` to `8`");
    }

    [Fact]
    public void Render_WhenAnArtifactLabelCarriesAMachinePath_RedactsItRatherThanPrintingIt()
    {
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(
                TrendFixture.Start,
                "/home/ci-runner/work/one.json",
                [TrendFixture.Scenario("checkout", 5, 5)]
            ),
            TrendFixture.Artifact(2, TrendFixture.Scenario("checkout", 5, 5)),
        ]);

        var markdown = TrendFixture.Render(trend);

        markdown.Should().NotContain("ci-runner");
        markdown.Should().Contain("[path-redacted:");
    }

    [Fact]
    public void Render_WhenTheSeriesIsLargerThanTheBudget_TruncatesLoudlyRatherThanSilently()
    {
        var trend = SuiteTrend.Build([
            TrendFixture.Artifact(1, [.. Enumerable.Range(0, 400).Select(Wide)]),
            TrendFixture.Artifact(2, [.. Enumerable.Range(0, 400).Select(Wide)]),
        ]);

        var rendering = TrendReport.Render(
            new TrendReportRequest
            {
                Trend = trend,
                RootDirectory = OperatingSystem.IsWindows() ? @"C:\repo" : "/repo",
                ArtifactsDirectory = OperatingSystem.IsWindows() ? @"C:\repo\artifacts" : "/repo/artifacts",
            }
        );

        rendering.Truncated.Should().BeTrue();
        rendering.Text.Length.Should().BeLessThanOrEqualTo(MarkdownReport.CommentCharacterLimit);
        rendering.Text.Should().Contain("This report was truncated.");
    }

    [Fact]
    public void Render_WhenTheSeriesFitsTheBudget_ReportsNothingTruncated()
    {
        var rendering = TrendReport.Render(
            new TrendReportRequest
            {
                Trend = Clean(),
                RootDirectory = OperatingSystem.IsWindows() ? @"C:\repo" : "/repo",
                ArtifactsDirectory = OperatingSystem.IsWindows() ? @"C:\repo\artifacts" : "/repo/artifacts",
            }
        );

        rendering.Truncated.Should().BeFalse();
        rendering.Marker.Should().HaveLength(16);
    }

    [Fact]
    public void Render_WhenTheBudgetCannotHoldTheFrame_RefusesRatherThanReturningAFragment() =>
        Assert.Throws<ArgumentOutOfRangeException>(() => TrendFixture.Render(Clean(), budget: 512));

    [Fact]
    public void Render_WhenGivenNull_Throws() => Assert.Throws<ArgumentNullException>(() => TrendReport.Render(null!));

    private static Forge.EvalEngine.Results.ScenarioResult Wide(int index) =>
        TrendFixture.Scenario($"scenario-with-a-deliberately-long-identifier-{index:000}", 4, 5);
}
