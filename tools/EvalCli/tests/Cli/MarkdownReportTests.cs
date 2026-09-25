using FluentAssertions;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Tests.Support;
using Forge.EvalEngine.Comparison;
using Forge.EvalEngine.Results;

namespace Forge.EvalCli.Tests.Cli;

/// <summary>
/// The Markdown a pull-request reviewer reads: what it leads with, what it refuses to imply, and
/// what it says when it could not fit everything in.
/// </summary>
/// <remarks>
/// <para>
/// Every test here is aimed at one failure mode: <b>a refusal rendering as an absence</b>. A
/// section that was truncated must not read as an empty one, a scenario whose coverage claim was
/// withheld must not read as a scenario nobody gained, an unchanged count must not absorb a
/// scenario that was never run, and "no regressions" must not be printable when nothing was
/// compared. A reader who stops at a clean-looking line is exactly the reader this report is for.
/// </para>
/// <para>
/// These pin the renderer against the contract <see cref="ComparisonResult"/> states.
/// <see cref="MarkdownReportCommandTests"/> pins it against what the engine actually emits, from a
/// real run.
/// </para>
/// </remarks>
public class MarkdownReportTests
{
    private const string Root = "/repo";
    private const string Suite = "/repo/eval-suites/regression.json";

    private static MarkdownReportRequest Request(
        ComparisonOutcome comparison,
        int budget = MarkdownReport.CommentCharacterLimit,
        string? artifact = "/repo/artifacts/candidate.json"
    ) =>
        new()
        {
            Comparison = comparison,
            RootDirectory = Root,
            SuitePath = Suite,
            ArtifactPath = artifact,
            GateMode = RunPlan.ReportOnlyGate,
            CharacterBudget = budget,
        };

    /// <summary>A comparison carrying one scenario of every kind the report has a section for.</summary>
    private static ComparisonOutcome Everything()
    {
        var baseline = ReportFixture.Artifact(
            ReportFixture.Scenario("checkout", passed: 5, graded: 5),
            ReportFixture.Scenario("refunds", passed: 0, graded: 5),
            ReportFixture.Scenario("billing", passed: 3, graded: 5),
            ReportFixture.Scenario("stable", passed: 5, graded: 5),
            ReportFixture.Scenario("retired", passed: 5, graded: 5)
        );

        var candidate = ReportFixture.Artifact(
            ReportFixture.Scenario("checkout", passed: 1, graded: 5),
            ReportFixture.Scenario("refunds", passed: 5, graded: 5),
            ReportFixture.Scenario("billing", passed: 4, graded: 5),
            ReportFixture.Scenario("stable", passed: 5, graded: 5),
            ReportFixture.Scenario("flaky", passed: 4, graded: 4),
            ReportFixture.Scenario("brandnew", passed: 0, graded: 3)
        );

        var result = new ComparisonResult
        {
            SuiteName = "regression",
            ScenarioComparisons =
            [
                ReportFixture.Compared(
                    "checkout",
                    ScenarioClassification.Regressed,
                    ScenarioOutcome.Passed,
                    ScenarioOutcome.Failed,
                    gradedPairs: 5,
                    effect: -0.8,
                    pValue: 0.0625,
                    adjusted: 0.125
                ),
                ReportFixture.Compared(
                    "refunds",
                    ScenarioClassification.Fixed,
                    ScenarioOutcome.Failed,
                    ScenarioOutcome.Passed,
                    gradedPairs: 5,
                    effect: 1.0,
                    pValue: 0.0312,
                    adjusted: 0.0312
                ),
                ReportFixture.Compared(
                    "billing",
                    ScenarioClassification.NotComparable,
                    ScenarioOutcome.Failed,
                    ScenarioOutcome.Failed,
                    reason: "Scenario 'billing' was run against a different definition on each side."
                ),
                ReportFixture.Compared(
                    "stable",
                    ScenarioClassification.StablePass,
                    ScenarioOutcome.Passed,
                    ScenarioOutcome.Passed,
                    gradedPairs: 5,
                    effect: 0.0
                ),
                ReportFixture.Compared(
                    "flaky",
                    ScenarioClassification.New,
                    ScenarioOutcome.Absent,
                    ScenarioOutcome.Passed
                ),
                ReportFixture.Compared(
                    "brandnew",
                    ScenarioClassification.New,
                    ScenarioOutcome.Absent,
                    ScenarioOutcome.Failed
                ),
                ReportFixture.Compared(
                    "retired",
                    ScenarioClassification.Removed,
                    ScenarioOutcome.Passed,
                    ScenarioOutcome.Absent
                ),
            ],
            NewlyCovered = ["refunds"],
            NewlyCoveredWithheld = ["flaky"],
            NewlyCoveredWithheldReason =
                "at least one repetition errored, so the scenario passed every run that "
                + "produced a verdict rather than every run the suite asked for.",
            Correction = "benjamini-hochberg",
        };

        return ReportFixture.Outcome(result, baseline, candidate, notRun: ["shipping", "tax"]);
    }

    /// <summary>A comparison in which no pair could be diffed, because every scenario is new.</summary>
    private static ComparisonOutcome NothingCompared()
    {
        var baseline = ReportFixture.Artifact();
        var candidate = ReportFixture.Artifact(ReportFixture.Scenario("brandnew", passed: 1, graded: 1));

        return ReportFixture.Outcome(
            new ComparisonResult
            {
                SuiteName = "regression",
                ScenarioComparisons =
                [
                    ReportFixture.Compared(
                        "brandnew",
                        ScenarioClassification.New,
                        ScenarioOutcome.Absent,
                        ScenarioOutcome.Passed
                    ),
                ],
                NewlyCovered = ["brandnew"],
            },
            baseline,
            candidate
        );
    }

    private static int IndexOfSection(string text, string heading)
    {
        var index = text.IndexOf(heading, StringComparison.Ordinal);

        index.Should().BeGreaterThanOrEqualTo(0, "the report must carry a '{0}' section", heading);

        return index;
    }

    [Fact]
    public void Render_WhenEverySectionHasContent_OrdersThemBySeverity()
    {
        var text = MarkdownReport.Render(Request(Everything())).Text;

        var order = new[]
        {
            IndexOfSection(text, "### Regressions"),
            IndexOfSection(text, "### Newly covered"),
            IndexOfSection(text, "### Not comparable"),
            IndexOfSection(text, "### Withheld from coverage"),
            IndexOfSection(text, "### New scenarios that did not pass"),
            IndexOfSection(text, "### Removed from the suite"),
            IndexOfSection(text, "### Unchanged"),
            IndexOfSection(text, "### Not run by this invocation"),
        };

        order.Should().BeInAscendingOrder("the sections run in the severity order the report contracts to");
    }

    [Fact]
    public void Render_WhenAScenarioRegressed_NamesItWithBothRatesAndTheirIntervals()
    {
        var text = MarkdownReport.Render(Request(Everything())).Text;

        text.Should().Contain("`checkout`").And.Contain("passed").And.Contain("failed");

        // N and an interval beside every stochastic rate: 80% -> 90% on n=10 is noise presented
        // as a result, and a rate with no denominator cannot be told apart from one.
        text.Should().Contain("n=5").And.Contain("95% Wilson");
    }

    [Fact]
    public void Render_WhenAScenarioIsNewlyCovered_LeadsWithItRatherThanBuryingIt()
    {
        var rendering = MarkdownReport.Render(Request(Everything()));

        // The headline is what the change fixed. It is named in the summary line, not only in a
        // section a reader reaches after the regressions.
        var summary = rendering.Text[..IndexOfSection(rendering.Text, "### Regressions")];

        summary.Should().Contain("Newly covered");
        rendering.Text.Should().Contain("`refunds`");
    }

    [Fact]
    public void Render_WhenAScenarioRanOnce_SaysSoRatherThanPrintingAnInterval()
    {
        var baseline = ReportFixture.Artifact(ReportFixture.Scenario("rest-once", passed: 0, graded: 1));
        var candidate = ReportFixture.Artifact(ReportFixture.Scenario("rest-once", passed: 1, graded: 1));

        var outcome = ReportFixture.Outcome(
            new ComparisonResult
            {
                SuiteName = "regression",
                ScenarioComparisons =
                [
                    ReportFixture.Compared(
                        "rest-once",
                        ScenarioClassification.Fixed,
                        ScenarioOutcome.Failed,
                        ScenarioOutcome.Passed,
                        gradedPairs: 1,
                        effect: 1.0
                    ),
                ],
                NewlyCovered = ["rest-once"],
            },
            baseline,
            candidate
        );

        var text = MarkdownReport.Render(Request(outcome)).Text;

        text.Should().Contain("single observation").And.NotContain("95% Wilson");
    }

    [Fact]
    public void Render_WhenAScenarioProducedNoGradeableRun_SaysThatRatherThanShowingZeroPercent()
    {
        var baseline = ReportFixture.Artifact(ReportFixture.Scenario("checkout", passed: 1, graded: 1));
        var candidate = ReportFixture.Artifact(ReportFixture.Ungradeable("checkout"));

        var outcome = ReportFixture.Outcome(
            new ComparisonResult
            {
                SuiteName = "regression",
                ScenarioComparisons =
                [
                    ReportFixture.Compared(
                        "checkout",
                        ScenarioClassification.NotComparable,
                        ScenarioOutcome.Passed,
                        ScenarioOutcome.Ungradeable,
                        reason: "no repetition produced a verdict"
                    ),
                ],
            },
            baseline,
            candidate
        );

        var text = MarkdownReport.Render(Request(outcome)).Text;

        // A pass rate of zero and no pass rate at all are different claims, and only one of them
        // is about the system under test.
        text.Should().Contain("no pass rate");
    }

    [Fact]
    public void Render_WhenNoPairCouldBeDiffed_RefusesToPrintNoRegressions()
    {
        var text = MarkdownReport.Render(Request(NothingCompared())).Text;

        text.Should().Contain("Nothing was compared");
        text.Should().NotContain("No regressions", "a zero drawn from nothing examined is not a finding");
    }

    [Fact]
    public void Render_WhenPairsWereComparedAndNoneRegressed_SaysHowManyWereCompared()
    {
        var baseline = ReportFixture.Artifact(ReportFixture.Scenario("stable", passed: 5, graded: 5));
        var candidate = ReportFixture.Artifact(ReportFixture.Scenario("stable", passed: 5, graded: 5));

        var outcome = ReportFixture.Outcome(
            new ComparisonResult
            {
                SuiteName = "regression",
                ScenarioComparisons =
                [
                    ReportFixture.Compared(
                        "stable",
                        ScenarioClassification.StablePass,
                        ScenarioOutcome.Passed,
                        ScenarioOutcome.Passed,
                        gradedPairs: 5,
                        effect: 0
                    ),
                ],
            },
            baseline,
            candidate
        );

        var text = MarkdownReport.Render(Request(outcome)).Text;

        text.Should().Contain("No regressions").And.Contain("1 compared");
    }

    [Fact]
    public void Render_WhenCoverageWasWithheld_NamesTheScenarioAndTheComparatorsReason()
    {
        var text = MarkdownReport.Render(Request(Everything())).Text;
        var section = text[IndexOfSection(text, "### Withheld from coverage")..];

        section.Should().Contain("`flaky`");

        // The comparator's own words, passed through rather than re-derived at this boundary.
        section.Should().Contain("passed every run that produced a verdict");
    }

    [Fact]
    public void Render_WhenCoverageWasWithheldWithNoReason_StillNamesTheScenario()
    {
        var baseline = ReportFixture.Artifact();
        var candidate = ReportFixture.Artifact(ReportFixture.Scenario("flaky", passed: 2, graded: 2));

        var outcome = ReportFixture.Outcome(
            new ComparisonResult
            {
                SuiteName = "regression",
                ScenarioComparisons =
                [
                    ReportFixture.Compared(
                        "flaky",
                        ScenarioClassification.New,
                        ScenarioOutcome.Absent,
                        ScenarioOutcome.Passed
                    ),
                ],
                NewlyCoveredWithheld = ["flaky"],
                NewlyCoveredWithheldReason = null,
            },
            baseline,
            candidate
        );

        var text = MarkdownReport.Render(Request(outcome)).Text;

        // Keyed on the list, never on the nullable annotation beside it: a row that disappeared
        // when the reason was absent is this report's own defect turned inward.
        text.Should().Contain("### Withheld from coverage").And.Contain("`flaky`");
    }

    [Fact]
    public void Render_WhenAPairCouldNotBeCompared_NamesItWithItsReasonAndTheRemedy()
    {
        var text = MarkdownReport.Render(Request(Everything())).Text;
        var section = text[IndexOfSection(text, "### Not comparable")..];

        section.Should().Contain("`billing`").And.Contain("different definition on each side");
        text.Should().Contain("Regenerate the baseline");
    }

    [Fact]
    public void Render_WhenANewScenarioDidNotPass_NamesItRatherThanDroppingIt()
    {
        var text = MarkdownReport.Render(Request(Everything())).Text;
        var section = text[IndexOfSection(text, "### New scenarios that did not pass")..];

        section.Should().Contain("`brandnew`");
    }

    [Fact]
    public void Render_WhenAScenarioWasRemoved_NamesItRatherThanDroppingIt()
    {
        var text = MarkdownReport.Render(Request(Everything())).Text;
        var section = text[IndexOfSection(text, "### Removed from the suite")..];

        section.Should().Contain("`retired`");
    }

    [Fact]
    public void Render_WhenASuitePathContainsADotDotPrefixedDirectory_DoesNotCollideWithAnotherSuite()
    {
        var outcome = Everything();

        // `..hidden` is an ordinary directory inside the root. A prefix test on ".." reduced both
        // of these to their file name, so two distinct suites hashed to one marker and one PR
        // report silently replaced the other.
        var first = MarkdownReport.Render(Request(outcome) with { SuitePath = "/repo/..hidden/regression.json" });
        var second = MarkdownReport.Render(Request(outcome) with { SuitePath = "/repo/visible/regression.json" });

        first.Marker.Should().NotBe(second.Marker);
        first.Text.Should().Contain("..hidden/regression.json", "the directory is real and inside the root");
    }

    [Fact]
    public void Render_WhenTwoSuitePathsDifferBeyondTheDisplayClip_DoesNotCollideTheirMarkers()
    {
        var outcome = Everything();
        var stem = "/repo/" + new string('a', 400);

        // Clipping exists so a comment stays readable. Feeding it into the marker makes every
        // suite under a long enough path share one identity.
        var first = MarkdownReport.Render(Request(outcome) with { SuitePath = $"{stem}/one.json" });
        var second = MarkdownReport.Render(Request(outcome) with { SuitePath = $"{stem}/two.json" });

        first.Marker.Should().NotBe(second.Marker);
    }

    [Fact]
    public void Render_WhenTwoLiveBaselinesRedactToTheSameAddress_DoesNotCollideTheirMarkers()
    {
        var outcome = Everything();

        // Redaction is a §V control on what may be printed. Both of these display as
        // `https://host/<redacted>`, so a marker keyed on the display string cannot tell a
        // comparison against trunk from one against a release branch.
        var trunk = Live(outcome, "https://host/main");
        var release = Live(outcome, "https://host/release");

        var first = MarkdownReport.Render(Request(trunk));
        var second = MarkdownReport.Render(Request(release));

        first.Text.Should().Contain("host/<redacted>").And.NotContain("host/main");
        first.Marker.Should().NotBe(second.Marker);
    }

    private static ComparisonOutcome Live(ComparisonOutcome outcome, string address) =>
        outcome with
        {
            Mechanism = BaselineMechanism.LiveEndpoint,
            Reference = "https://host/<redacted>",
            ReferenceIdentity = ReportIdentity.ForAddress(new Uri(address)),
        };

    [Fact]
    public void Render_WhenAnAddressContainsASchemeSeparator_DoesNotMistakeItForADriveLetter()
    {
        var outcome = Live(Everything(), "https://host/main");

        // `https:/` ends in the same two characters a Windows drive prefix does. An unanchored
        // rule redacted every address in the document, which is the §V control corrupting values
        // that disclose nothing.
        MarkdownReport.Render(Request(outcome)).Text.Should().Contain("https://host/<redacted>");
    }

    [Fact]
    public void Render_WhenAnEntryReachesNoClassifiedSection_LeavesTheAccountingUnbalanced()
    {
        var baseline = ReportFixture.Artifact();
        var candidate = ReportFixture.Artifact(ReportFixture.Scenario("odd", passed: 1, graded: 1));

        var outcome = ReportFixture.Outcome(
            new ComparisonResult
            {
                SuiteName = "regression",
                ScenarioComparisons =
                [
                    ReportFixture.Compared(
                        "odd",
                        (ScenarioClassification)99,
                        ScenarioOutcome.Passed,
                        ScenarioOutcome.Passed
                    ),
                ],
            },
            baseline,
            candidate
        );

        var text = MarkdownReport.Render(Request(outcome)).Text;

        // The catch-all is not a term on the left of the equation. With it there the sum balanced
        // however the partition behaved, and the unbalanced warning offered as the protection
        // against a scenario falling between two sections could never fire.
        text.Should().Contain("= 0 of 1 scenario entries");
        text.Should().Contain("reached no classified section of this report");
        text.Should().Contain("### Not accounted for (1)").And.Contain("`odd`");
    }

    [Fact]
    public void Render_WhenACoverageClaimHasNoComparison_KeepsItOutOfTheNewlyCoveredCount()
    {
        var outcome = ReportFixture.Outcome(
            new ComparisonResult
            {
                SuiteName = "regression",
                ScenarioComparisons = [],
                NewlyCovered = ["orphan"],
            },
            ReportFixture.Artifact(),
            ReportFixture.Artifact()
        );

        var text = MarkdownReport.Render(Request(outcome)).Text;

        // The heading, the summary and the footer draw the same figure from one accounting. An
        // orphan appended to "Newly covered" made the heading read (1) over a summary saying 0.
        text.Should().Contain("### Newly covered (0)");
        text.Should().Contain("### Coverage claims with no comparison (1)").And.Contain("`orphan`");
        text.Should().Contain("no per-scenario comparison");
    }

    [Fact]
    public void Render_WhenAnArtifactSummaryContradictsItsRuns_WithholdsItsFiguresRatherThanTrustingThem()
    {
        var baseline = ReportFixture.Artifact(ReportFixture.Tampered("checkout"));
        var candidate = ReportFixture.Artifact(ReportFixture.Scenario("checkout", passed: 0, graded: 5));

        var outcome = ReportFixture.Outcome(
            new ComparisonResult
            {
                SuiteName = "regression",
                ScenarioComparisons =
                [
                    ReportFixture.Compared(
                        "checkout",
                        ScenarioClassification.Regressed,
                        ScenarioOutcome.Passed,
                        ScenarioOutcome.Failed,
                        gradedPairs: 5,
                        effect: -1.0
                    ),
                ],
            },
            baseline,
            candidate
        );

        var text = MarkdownReport.Render(Request(outcome)).Text;

        // A committed baseline is a file anyone can edit. A summary claiming n=100 renders as the
        // most authoritative thing on the page while the comparator classifies from five runs.
        text.Should().Contain("does not match the runs beside it").And.Contain("n=100 against 5 graded run(s)");
        text.Should().NotContain("(n=100,", "a figure the runs do not support is not reported");
    }

    [Fact]
    public void Render_WhenTheBudgetCannotHoldTheFrame_RefusesRatherThanCuttingTheHeadings()
    {
        var render = () => MarkdownReport.Render(Request(Crowded(40), budget: MarkdownReport.MinimumCharacterBudget));

        // "No section can be truncated out of existence" held only while the budget could hold
        // the skeleton. Below that the cut removed later headings, totals, notices and the footer.
        render.Should().Throw<ArgumentOutOfRangeException>().WithMessage("*headings*");
    }

    [Fact]
    public void Render_WhenTruncated_StillCarriesEveryRequiredHeadingAndTheFooter()
    {
        var rendering = MarkdownReport.Render(Request(Crowded(40), budget: CrowdedBudget));

        foreach (
            var heading in new[]
            {
                "### Regressions",
                "### Newly covered",
                "### Not comparable",
                "### Withheld from coverage",
                "### Unchanged",
            }
        )
        {
            rendering.Text.Should().Contain(heading);
        }

        rendering.Text.Should().Contain("**Accounting** —").And.Contain("**Full record** —");
    }

    [Fact]
    public void Render_WhenTruncatedWithNoArtifact_DoesNotPromiseARecordThatWasNeverWritten()
    {
        var rendering = MarkdownReport.Render(Request(Crowded(40), budget: CrowdedBudget, artifact: null));

        // The recovery pointer is the one sentence a reader acts on once something was omitted.
        // Naming a JSON artifact that --out never wrote makes it a lie exactly when it matters.
        rendering.Text.Should().Contain("no fuller record");
        rendering.Text.Should().NotContain("whole record is in the JSON artifact");
    }

    [Fact]
    public void Render_WhenASuiteNameCarriesAMachinePath_KeepsItOutOfThePullRequestComment()
    {
        var outcome = Everything() with
        {
            Result = Everything().Result with { SuiteName = "regression /home/ci-runner/work C:\\Users\\someone" },
        };

        var text = MarkdownReport.Render(Request(outcome)).Text;

        text.Should().NotContain("/home/ci-runner").And.NotContain("C:\\Users\\someone");
        text.Should().Contain("[path-redacted:");
    }

    [Fact]
    public void Render_WhenAScenarioIdCarriesAMachinePath_KeepsItOutOfThePullRequestComment()
    {
        var id = "checkout /home/ci-runner/secrets";
        var outcome = ReportFixture.Outcome(
            new ComparisonResult
            {
                SuiteName = "regression",
                ScenarioComparisons =
                [
                    ReportFixture.Compared(
                        id,
                        ScenarioClassification.New,
                        ScenarioOutcome.Absent,
                        ScenarioOutcome.Failed
                    ),
                ],
            },
            ReportFixture.Artifact(),
            ReportFixture.Artifact(ReportFixture.Scenario(id, passed: 0, graded: 1))
        );

        var text = MarkdownReport.Render(Request(outcome)).Text;

        text.Should().NotContain("/home/ci-runner").And.Contain("[path-redacted:");
    }

    [Fact]
    public void Render_WhenAnIdIsASingleSlashSegment_LeavesItAlone()
    {
        var id = "/refund";
        var outcome = ReportFixture.Outcome(
            new ComparisonResult
            {
                SuiteName = "regression",
                ScenarioComparisons =
                [
                    ReportFixture.Compared(
                        id,
                        ScenarioClassification.New,
                        ScenarioOutcome.Absent,
                        ScenarioOutcome.Failed
                    ),
                ],
            },
            ReportFixture.Artifact(),
            ReportFixture.Artifact(ReportFixture.Scenario(id, passed: 0, graded: 1))
        );

        // Redacting this would delete the scenario's name from the report, which is the
        // disappearance the whole document is built to prevent. One segment is not a path shape;
        // a multi-segment identifier is aliased instead, distinctly per value, so nothing
        // collapses — see MarkdownReportPropertyTests.
        MarkdownReport.Render(Request(outcome)).Text.Should().Contain("/refund");
    }

    [Fact]
    public void Render_WhenARefusalReasonCarriesMarkup_RendersItAsTextRatherThanAsStructure()
    {
        var reason = "<img src=x onerror=alert(1)> and a [link](http://example.invalid) and **bold**";
        var outcome = ReportFixture.Outcome(
            new ComparisonResult
            {
                SuiteName = "regression",
                ScenarioComparisons =
                [
                    ReportFixture.Compared(
                        "billing",
                        ScenarioClassification.NotComparable,
                        ScenarioOutcome.Failed,
                        ScenarioOutcome.Failed,
                        reason: reason
                    ),
                ],
            },
            ReportFixture.Artifact(ReportFixture.Scenario("billing", passed: 1, graded: 1)),
            ReportFixture.Artifact(ReportFixture.Scenario("billing", passed: 0, graded: 1))
        );

        var text = MarkdownReport.Render(Request(outcome)).Text;

        text.Should().NotContain("<img").And.Contain("&lt;img");
        text.Should().Contain(@"\[link\]").And.Contain(@"\*\*bold\*\*");
    }

    [Fact]
    public void Render_WhenAWithholdingReasonCarriesMarkup_RendersItAsTextRatherThanAsStructure()
    {
        var outcome = ReportFixture.Outcome(
            new ComparisonResult
            {
                SuiteName = "regression",
                ScenarioComparisons =
                [
                    ReportFixture.Compared(
                        "flaky",
                        ScenarioClassification.New,
                        ScenarioOutcome.Absent,
                        ScenarioOutcome.Passed
                    ),
                ],
                NewlyCoveredWithheld = ["flaky"],
                NewlyCoveredWithheldReason = "<script>alert(1)</script>",
            },
            ReportFixture.Artifact(),
            ReportFixture.Artifact(ReportFixture.Scenario("flaky", passed: 1, graded: 1))
        );

        MarkdownReport.Render(Request(outcome)).Text.Should().NotContain("<script").And.Contain("&lt;script");
    }

    [Fact]
    public void Render_WhenTheWithheldLeadExplainsItself_DoesNotAssignOneCauseToEveryScenario()
    {
        var text = MarkdownReport.Render(Request(Everything())).Text;
        var section = text[IndexOfSection(text, "### Withheld from coverage")..];

        // The comparator also withholds a candidate that recorded MORE repetitions than declared.
        // Nothing is missing there, so a lead asserting an unconducted repetition sends a reader
        // looking for something that was never absent.
        section.Should().NotContain("did not conduct every repetition it asked for");
        section.Should().Contain("do not agree, or not every repetition produced a verdict");
    }

    [Fact]
    public void Render_WhenARegressionWasNotJudgedSignificant_SaysSoInTheSummaryAndTheLead()
    {
        var rendering = MarkdownReport.Render(Request(Everything()));
        var summary = rendering.Text[..IndexOfSection(rendering.Text, "### Regressions")];

        // A reviewer who reads the first line and stops must not come away believing a regression
        // was confirmed. Carrying n and an interval beside every rate exists so a headline cannot
        // mislead; leaving the caveat below the headline puts the problem straight back.
        summary.Should().Contain("Regressions: 1 observed, 0 judged significant");

        var lead = rendering.Text[
            IndexOfSection(rendering.Text, "### Regressions")..IndexOfSection(rendering.Text, "### Newly covered")
        ];

        lead.Should().Contain("An observed transition is not by itself a confirmed regression");
        lead.Should().Contain("0 were judged significant against the run's significance level");
    }

    [Fact]
    public void Render_WhenACoverageClaimWasNotJudgedSignificant_SaysSoInTheSummary()
    {
        var rendering = MarkdownReport.Render(Request(Everything()));
        var summary = rendering.Text[..IndexOfSection(rendering.Text, "### Regressions")];

        summary.Should().Contain("Newly covered: 1 observed, 1 judged significant");
    }

    [Fact]
    public void Render_WhenScenariosWereUnchanged_PutsThatCountInTheHeadingRatherThanZero()
    {
        var text = MarkdownReport.Render(Request(Everything())).Text;

        // The unchanged section reports a count rather than a list, so its heading has to carry
        // the count. A heading reading (0) over a body saying one scenario was unchanged is a
        // number contradicting the sentence beneath it, and a skimming reader resolves that in
        // whichever direction is more comfortable.
        text.Should().Contain("### Unchanged (1)").And.NotContain("### Unchanged (0)");
    }

    [Fact]
    public void Render_WhenScenariosWereNotRun_KeepsThemOutOfTheUnchangedCount()
    {
        var text = MarkdownReport.Render(Request(Everything())).Text;
        var unchanged = text[
            IndexOfSection(text, "### Unchanged")..IndexOfSection(text, "### Not run by this invocation")
        ];

        // One StablePass and nothing else. The two scenarios this invocation never conducted are
        // not unchanged: no candidate evidence about them exists at all.
        unchanged.Should().Contain("1").And.NotContain("shipping").And.NotContain("tax");

        var notRun = text[IndexOfSection(text, "### Not run by this invocation")..];

        notRun.Should().Contain("`shipping`").And.Contain("`tax`").And.Contain("skipped by selection");
    }

    [Fact]
    public void Render_WhenEveryClassificationIsPresent_AccountsForEveryScenarioInTheComparison()
    {
        var outcome = Everything();
        var text = MarkdownReport.Render(Request(outcome)).Text;

        // The checkable arithmetic. A reader can add the sections up and see that nothing fell
        // between them, which is the only defence against a scenario silently vanishing.
        text.Should()
            .Contain("Accounting")
            .And.Contain(
                $"= {outcome.Result.ScenarioComparisons.Count} of {outcome.Result.ScenarioComparisons.Count} scenario entries"
            );
    }

    [Fact]
    public void Render_WhenCalledTwiceOnTheSameComparison_ProducesIdenticalText()
    {
        var outcome = Everything();

        MarkdownReport.Render(Request(outcome)).Text.Should().Be(MarkdownReport.Render(Request(outcome)).Text);
    }

    [Fact]
    public void Render_WhenTheSuiteAndBaselineAreUnchanged_KeepsTheMarkerStableAcrossResults()
    {
        var clean = ReportFixture.Outcome(
            new ComparisonResult { SuiteName = "regression" },
            ReportFixture.Artifact(),
            ReportFixture.Artifact()
        );

        // Same invocation, different findings. A marker that moved when a result changed would
        // post a new comment on every push instead of replacing one.
        MarkdownReport.Render(Request(clean)).Marker.Should().Be(MarkdownReport.Render(Request(Everything())).Marker);
    }

    [Fact]
    public void Render_WhenTwoSuitesAreReportedOnTheSamePullRequest_GivesThemDifferentMarkers()
    {
        var outcome = Everything();

        var first = MarkdownReport.Render(Request(outcome));
        var second = MarkdownReport.Render(Request(outcome) with { SuitePath = "/repo/eval-suites/smoke.json" });

        first.Marker.Should().NotBe(second.Marker);
    }

    [Fact]
    public void Render_WhenTheBaselineDiffers_GivesTheReportsDifferentMarkers()
    {
        var outcome = Everything();

        var first = MarkdownReport.Render(Request(outcome));
        var second = MarkdownReport.Render(
            Request(
                outcome with
                {
                    Reference = "artifacts/release-baseline.json",
                    ReferenceIdentity = ReportIdentity.ForSegments(["artifacts", "release-baseline.json"]),
                }
            )
        );

        first.Marker.Should().NotBe(second.Marker);
    }

    [Fact]
    public void Render_WhenOnlyTheDisplayedReferenceChanges_KeepsTheMarker()
    {
        var outcome = Everything();

        var first = MarkdownReport.Render(Request(outcome));
        var second = MarkdownReport.Render(Request(outcome with { Reference = "a prettier label" }));

        // The marker keys on the identity, never on what is printed. This is the half of the
        // split that stops a change of display wording from orphaning an existing comment.
        first.Marker.Should().Be(second.Marker);
    }

    [Fact]
    public void Render_WhenTheRootDiffers_KeepsTheMarkerStableSoAnotherCheckoutReplacesTheSameComment()
    {
        var outcome = Everything();

        var here = MarkdownReport.Render(Request(outcome));
        var elsewhere = MarkdownReport.Render(
            Request(outcome) with
            {
                RootDirectory = "/build/agent/_work/12/s",
                SuitePath = "/build/agent/_work/12/s/eval-suites/regression.json",
                ArtifactPath = "/build/agent/_work/12/s/artifacts/candidate.json",
            }
        );

        here.Marker.Should().Be(elsewhere.Marker);
    }

    [Fact]
    public void Render_WhenTheMarkerIsEmitted_PutsItFirstSoCiCanFindAndReplaceOneComment()
    {
        var rendering = MarkdownReport.Render(Request(Everything()));

        rendering.Text.Should().StartWith($"<!-- eval-cli:report:{rendering.Marker} -->");
    }

    [Fact]
    public void Render_WhenPathsAreAbsolute_RendersThemRelativeToTheRoot()
    {
        var text = MarkdownReport.Render(Request(Everything())).Text;

        // A pull-request comment is public and a build agent's directory layout is not evidence
        // about the change. Every path in the document is stated relative to --root.
        text.Should().NotContain(Root).And.Contain("eval-suites/regression.json");
    }

    [Fact]
    public void Render_WhenNoArtifactWasWritten_SaysSoRatherThanNamingNone()
    {
        var text = MarkdownReport.Render(Request(Everything(), artifact: null)).Text;

        text.Should().Contain("no `--out`");
    }

    /// <summary>
    /// A budget that fits the frame and every section's heading, but not all of the entries.
    /// </summary>
    /// <remarks>
    /// Chosen above the skeleton deliberately. Below it the hard cut fires instead, which is a
    /// different behaviour with its own test — mixing the two would let a passing assertion about
    /// truncation actually be exercising the fallback.
    /// </remarks>
    private const int CrowdedBudget = 8_000;

    [Fact]
    public void Render_WhenTheReportDoesNotFit_SaysItWasTruncatedAndWhereTheFullRecordIs()
    {
        var rendering = MarkdownReport.Render(Request(Crowded(40), budget: CrowdedBudget));

        rendering.Truncated.Should().BeTrue();
        rendering.Text.Length.Should().BeLessThanOrEqualTo(CrowdedBudget);
        rendering.Text.Should().Contain("truncated").And.Contain("artifacts/candidate.json");
    }

    [Fact]
    public void Render_WhenASectionWasTruncated_StatesHowManyItDroppedRatherThanReadingAsEmpty()
    {
        var rendering = MarkdownReport.Render(Request(Crowded(40), budget: CrowdedBudget));

        rendering.Sections.Should().Contain(section => section.Shown < section.Total);

        // Every section states its true total in the heading and says what it could not show.
        // A section rendered with no entries and no notice is indistinguishable from a section
        // that found nothing, which is the defect this whole report is designed against.
        foreach (var section in rendering.Sections.Where(entry => entry.Shown < entry.Total))
        {
            rendering.Text.Should().Contain($"### {section.Section} ({section.Total})");

            // Both figures, and both true. A notice stating an omission while overstating how
            // much reached the page is the same defect as one that stated no omission at all:
            // the reader is told a number that contradicts what is in front of them.
            rendering.Text.Should().Contain($"{section.Shown} of {section.Total} shown");
            rendering.Text.Should().Contain($"{section.Total - section.Shown} omitted");
        }
    }

    [Fact]
    public void Render_WhenTruncating_KeepsTheHighestSeverityContent()
    {
        var rendering = MarkdownReport.Render(Request(Crowded(40), budget: CrowdedBudget));

        var regressions = rendering.Sections.Single(section => section.Section == "Regressions");
        var lower = rendering.Sections.Single(section => section.Section == "Removed from the suite");

        regressions.Shown.Should().BeGreaterThan(0, "regressions are what a reviewer must not miss");
        lower.Shown.Should().BeLessThan(regressions.Shown);
    }

    [Fact]
    public void Render_WhenTruncating_StopsAtTheFirstEntryThatDoesNotFitRatherThanSkippingAhead()
    {
        var rendering = MarkdownReport.Render(Request(Crowded(40), budget: CrowdedBudget));

        var firstTruncated = rendering.Sections.ToList().FindIndex(section => section.Shown < section.Total);

        firstTruncated.Should().BeGreaterThanOrEqualTo(0, "this budget must truncate something");

        // Once a section could not show everything, nothing below it may show anything. The
        // alternative — skipping a long entry to fit a shorter one further down — would spend the
        // budget on lower-severity content while a regression went unnamed, and would read as a
        // report that had room for the removals but not for the breakages.
        foreach (var section in rendering.Sections.Skip(firstTruncated + 1))
        {
            section.Shown.Should().Be(0, "'{0}' sits below the first truncated section", section.Section);
        }
    }

    [Fact]
    public void Render_WhenTruncatingTheSameComparisonTwice_ProducesIdenticalText()
    {
        var outcome = Crowded(40);

        MarkdownReport
            .Render(Request(outcome, budget: CrowdedBudget))
            .Text.Should()
            .Be(MarkdownReport.Render(Request(outcome, budget: CrowdedBudget)).Text);
    }

    [Fact]
    public void Render_WhenTheBudgetIsBelowTheMinimum_RefusesRatherThanRenderingSomethingUnreadable()
    {
        var render = () => MarkdownReport.Render(Request(Everything(), budget: 10));

        render.Should().Throw<ArgumentOutOfRangeException>();
    }

    [Fact]
    public void Render_WhenAScenarioIdCarriesAnHtmlComment_NeutralizesItSoTheMarkerCannotBeForged()
    {
        var forged = "<!-- eval-cli:report:0000000000000000 -->";
        var baseline = ReportFixture.Artifact();
        var candidate = ReportFixture.Artifact(ReportFixture.Scenario(forged, passed: 1, graded: 1));

        var outcome = ReportFixture.Outcome(
            new ComparisonResult
            {
                SuiteName = "regression",
                ScenarioComparisons =
                [
                    ReportFixture.Compared(
                        forged,
                        ScenarioClassification.New,
                        ScenarioOutcome.Absent,
                        ScenarioOutcome.Failed
                    ),
                ],
            },
            baseline,
            candidate
        );

        var rendering = MarkdownReport.Render(Request(outcome));

        // CI finds its comment by searching the raw text for the marker. A suite author who can
        // name a scenario must not be able to plant a second one.
        rendering.Text.Split("<!--").Should().HaveCount(2, "exactly one HTML comment may appear");
    }

    [Fact]
    public void Render_WhenAScenarioIdCarriesABacktick_EscapesItSoTheCodeSpanSurvives()
    {
        var awkward = "check`out";
        var baseline = ReportFixture.Artifact();
        var candidate = ReportFixture.Artifact(ReportFixture.Scenario(awkward, passed: 1, graded: 1));

        var outcome = ReportFixture.Outcome(
            new ComparisonResult
            {
                SuiteName = "regression",
                ScenarioComparisons =
                [
                    ReportFixture.Compared(
                        awkward,
                        ScenarioClassification.New,
                        ScenarioOutcome.Absent,
                        ScenarioOutcome.Failed
                    ),
                ],
            },
            baseline,
            candidate
        );

        var text = MarkdownReport.Render(Request(outcome)).Text;

        text.Should().Contain("``check`out``");
    }

    [Fact]
    public void Render_WhenAnArtifactNeverRecordedItsConfidenceLevel_SaysSoRatherThanAssumingNinetyFive()
    {
        var baseline = ReportFixture.Artifact(
            recordsConfidence: false,
            ReportFixture.Scenario("checkout", passed: 0, graded: 5)
        );

        var candidate = ReportFixture.Artifact(
            recordsConfidence: false,
            ReportFixture.Scenario("checkout", passed: 5, graded: 5)
        );

        var outcome = ReportFixture.Outcome(
            new ComparisonResult
            {
                SuiteName = "regression",
                ScenarioComparisons =
                [
                    ReportFixture.Compared(
                        "checkout",
                        ScenarioClassification.Fixed,
                        ScenarioOutcome.Failed,
                        ScenarioOutcome.Passed,
                        gradedPairs: 5,
                        effect: 1.0
                    ),
                ],
                NewlyCovered = ["checkout"],
            },
            baseline,
            candidate
        );

        var text = MarkdownReport.Render(Request(outcome)).Text;

        text.Should().Contain("could not be verified").And.NotContain("95% Wilson");
    }

    [Fact]
    public void Render_WhenNoTestWasRunForAScenario_SaysSoRatherThanLeavingTheFieldBlank()
    {
        var text = MarkdownReport.Render(Request(Everything())).Text;
        var section = text[IndexOfSection(text, "### Newly covered")..IndexOfSection(text, "### Not comparable")];

        // `refunds` carries a p-value; `flaky` is new and has no baseline rate to test against.
        section.Should().Contain("benjamini-hochberg");

        var withheld = text[IndexOfSection(text, "### Withheld from coverage")..];

        withheld.Should().Contain("no baseline");
    }

    [Fact]
    public void Render_WhenACoverageClaimNamesAScenarioWithNoComparison_StillNamesItRatherThanDroppingIt()
    {
        var outcome = ReportFixture.Outcome(
            new ComparisonResult
            {
                SuiteName = "regression",
                ScenarioComparisons = [],
                NewlyCovered = ["orphan"],
            },
            ReportFixture.Artifact(),
            ReportFixture.Artifact()
        );

        var text = MarkdownReport.Render(Request(outcome)).Text;

        text.Should().Contain("`orphan`").And.Contain("no per-scenario comparison");
    }

    /// <summary>A comparison wide enough that it cannot fit a small budget.</summary>
    /// <param name="perSection">How many scenarios to put in each entry-bearing section.</param>
    /// <returns>The outcome.</returns>
    private static ComparisonOutcome Crowded(int perSection)
    {
        var comparisons = new List<ScenarioComparison>();
        var baseline = new List<ScenarioResult>();
        var candidate = new List<ScenarioResult>();

        for (var index = 0; index < perSection; index++)
        {
            var regressed = $"regressed-{index:D3}";
            var removed = $"removed-{index:D3}";

            comparisons.Add(
                ReportFixture.Compared(
                    regressed,
                    ScenarioClassification.Regressed,
                    ScenarioOutcome.Passed,
                    ScenarioOutcome.Failed,
                    gradedPairs: 5,
                    effect: -1.0,
                    pValue: 0.0312,
                    adjusted: 0.0625
                )
            );

            comparisons.Add(
                ReportFixture.Compared(
                    removed,
                    ScenarioClassification.Removed,
                    ScenarioOutcome.Passed,
                    ScenarioOutcome.Absent
                )
            );

            baseline.Add(ReportFixture.Scenario(regressed, passed: 5, graded: 5));
            baseline.Add(ReportFixture.Scenario(removed, passed: 5, graded: 5));
            candidate.Add(ReportFixture.Scenario(regressed, passed: 0, graded: 5));
        }

        return ReportFixture.Outcome(
            new ComparisonResult
            {
                SuiteName = "regression",
                ScenarioComparisons = comparisons,
                Correction = "benjamini-hochberg",
            },
            ReportFixture.Artifact([.. baseline]),
            ReportFixture.Artifact([.. candidate])
        );
    }
}
