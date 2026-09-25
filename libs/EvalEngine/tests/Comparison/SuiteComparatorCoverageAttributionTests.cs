using FluentAssertions;
using Forge.EvalEngine.Comparison;
using Forge.EvalEngine.Results;
using Microsoft.Extensions.Logging;

namespace Forge.EvalEngine.Tests.Comparison;

/// <summary>
/// Per-scenario attribution of a withheld coverage claim.
/// </summary>
/// <remarks>
/// <para>
/// The comparator computes the cause <b>per scenario</b> and logs it per scenario, then — before
/// this — joined the distinct sentences into one suite-level string on the way out. The log
/// carried an attribution the report could not reach.
/// </para>
/// <para>
/// The causes lead to different actions, which is why collapsing them costs something real: a
/// repetition that errored is a flake to re-run, a repetition that never happened is a broken
/// harness, and an artifact recording more runs than it declared is neither. A consumer that has
/// to substring-match a joined sentence to tell those apart is re-deriving what the comparator
/// already knew.
/// </para>
/// </remarks>
public class SuiteComparatorCoverageAttributionTests
{
    private static WithheldCoverage Withheld(ComparisonResult result, string scenarioId) =>
        ComparisonFixtures.Withheld(result, scenarioId);

    /// <summary>
    /// The defect itself: two causes in one comparison, each belonging to a different scenario.
    /// </summary>
    /// <remarks>
    /// This is the case a single suite-level string cannot express. Both scenarios are withheld,
    /// for genuinely different reasons, and the pairing is the entire question a reader is
    /// asking.
    /// </remarks>
    [Fact]
    public void Compare_TwoScenariosWithheldForDifferentCauses_AttributesEachCauseToItsOwnScenario()
    {
        var result = new SuiteComparator().Compare(
            ComparisonFixtures.Artifact(),
            ComparisonFixtures.Artifact([
                ComparisonFixtures.Scenario("errored", [RunStatus.Pass, RunStatus.Error]),
                ComparisonFixtures.Scenario("incomplete", [RunStatus.Pass], declaredRepetitions: 2),
            ])
        );

        result.NewlyCovered.Should().BeEmpty();
        Withheld(result, "errored").Cause.Should().Be(CoverageWithholdingCause.Errored);
        Withheld(result, "incomplete").Cause.Should().Be(CoverageWithholdingCause.Incomplete);
    }

    /// <summary>
    /// The reason travels with the scenario it belongs to, not with the suite.
    /// </summary>
    [Fact]
    public void Compare_TwoScenariosWithheldForDifferentCauses_GivesEachScenarioOnlyItsOwnReason()
    {
        var result = new SuiteComparator().Compare(
            ComparisonFixtures.Artifact(),
            ComparisonFixtures.Artifact([
                ComparisonFixtures.Scenario("errored", [RunStatus.Pass, RunStatus.Error]),
                ComparisonFixtures.Scenario("incomplete", [RunStatus.Pass], declaredRepetitions: 2),
            ])
        );

        Withheld(result, "errored").Reason.Should().Contain("errored").And.NotContain("never happened");
        Withheld(result, "incomplete").Reason.Should().Contain("never happened").And.NotContain("passed every run");
    }

    /// <summary>
    /// A consumer branches on the cause without reading prose.
    /// </summary>
    /// <remarks>
    /// The report builder that found this needs to route a flake to a re-run and a short artifact
    /// to a harness investigation. Substring-matching an engine-composed sentence to decide that
    /// makes the wording a contract by accident; a declared value makes it one on purpose.
    /// </remarks>
    [Theory]
    [InlineData(CoverageWithholdingCause.Errored)]
    [InlineData(CoverageWithholdingCause.Incomplete)]
    [InlineData(CoverageWithholdingCause.OverRecorded)]
    public void Compare_WithheldScenario_CarriesACauseAConsumerCanBranchOnWithoutReadingProse(
        CoverageWithholdingCause cause
    )
    {
        var candidate = cause switch
        {
            CoverageWithholdingCause.Errored => ComparisonFixtures.Scenario("a", [RunStatus.Pass, RunStatus.Error]),
            CoverageWithholdingCause.Incomplete => ComparisonFixtures.Scenario(
                "a",
                [RunStatus.Pass],
                declaredRepetitions: 2
            ),
            _ => ComparisonFixtures.Scenario("a", [RunStatus.Pass, RunStatus.Pass], declaredRepetitions: 1),
        };

        var result = new SuiteComparator().Compare(
            ComparisonFixtures.Artifact(),
            ComparisonFixtures.Artifact([candidate])
        );

        Withheld(result, "a").Cause.Should().Be(cause);
    }

    /// <summary>
    /// The prose cannot disagree with the cause it sits beside.
    /// </summary>
    /// <remarks>
    /// Two independently settable fields describing one fact can drift, and the drift would be
    /// invisible — a reader believes the sentence and a program believes the value. The reason is
    /// derived from the cause, so there is one fact and one place it is stated.
    /// </remarks>
    [Fact]
    public void Compare_WithheldEntryReason_IsTheProseForItsOwnCauseRatherThanASeparatelySettableField()
    {
        var result = new SuiteComparator().Compare(
            ComparisonFixtures.Artifact(),
            ComparisonFixtures.Artifact([
                ComparisonFixtures.Scenario("errored", [RunStatus.Pass, RunStatus.Error]),
                ComparisonFixtures.Scenario("incomplete", [RunStatus.Pass], declaredRepetitions: 2),
            ])
        );

        foreach (var entry in result.NewlyCoveredWithheld)
        {
            entry.Reason.Should().Be(WithheldCoverage.Describe(entry.Cause));
        }

        typeof(WithheldCoverage)
            .GetProperty(nameof(WithheldCoverage.Reason))!
            .CanWrite.Should()
            .BeFalse("a reason that can be set apart from its cause can contradict it");
    }

    /// <summary>
    /// Precedence is preserved, and it is now preserved per scenario rather than per suite.
    /// </summary>
    /// <remarks>
    /// Two runs recorded against three declared, and one of the two errored — both causes hold.
    /// The structural one wins: an artifact that did not record what it declared is untrustworthy
    /// about the runs it did record.
    /// </remarks>
    [Fact]
    public void Compare_ScenarioBothIncompleteAndErrored_AttributesTheStructuralCauseToThatScenario()
    {
        var result = new SuiteComparator().Compare(
            ComparisonFixtures.Artifact(),
            ComparisonFixtures.Artifact([
                ComparisonFixtures.Scenario("a", [RunStatus.Pass, RunStatus.Error], declaredRepetitions: 3),
            ])
        );

        Withheld(result, "a").Cause.Should().Be(CoverageWithholdingCause.Incomplete);
    }

    /// <summary>
    /// Withheld entries keep the order of the comparisons that produced them.
    /// </summary>
    [Fact]
    public void Compare_SeveralWithheldScenarios_ListsThemInComparisonOrder()
    {
        var result = new SuiteComparator().Compare(
            ComparisonFixtures.Artifact(),
            ComparisonFixtures.Artifact([
                ComparisonFixtures.Scenario("zulu", [RunStatus.Pass, RunStatus.Error]),
                ComparisonFixtures.Scenario("alpha", [RunStatus.Pass], declaredRepetitions: 2),
            ])
        );

        result.NewlyCoveredWithheld.Select(entry => entry.ScenarioId).Should().Equal("zulu", "alpha");
    }

    /// <summary>
    /// Withholding must not swallow coverage that was genuinely earned.
    /// </summary>
    [Fact]
    public void Compare_FullyConductedScenarios_WithholdNothing()
    {
        var result = new SuiteComparator().Compare(
            ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("was-broken", [RunStatus.Fail, RunStatus.Fail])]),
            ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("was-broken", [RunStatus.Pass, RunStatus.Pass])])
        );

        result.NewlyCovered.Should().Equal("was-broken");
        result.NewlyCoveredWithheld.Should().BeEmpty();
    }

    /// <summary>
    /// The per-scenario signal and the per-scenario report agree, because they are one value.
    /// </summary>
    /// <remarks>
    /// The log already carried the attribution before this change. That is what made the gap a
    /// defect rather than a limitation — the information existed and was thrown away crossing the
    /// boundary.
    /// </remarks>
    [Fact]
    public void Compare_TwoScenariosWithheldForDifferentCauses_SignalsEachWithTheCauseItReports()
    {
        var logger = new RecordingComparatorLogger();

        var result = ComparisonFixtures
            .WithStatistics(logger: logger)
            .Compare(
                ComparisonFixtures.Artifact(),
                ComparisonFixtures.Artifact([
                    ComparisonFixtures.Scenario("errored", [RunStatus.Pass, RunStatus.Error]),
                    ComparisonFixtures.Scenario("incomplete", [RunStatus.Pass], declaredRepetitions: 2),
                ])
            );

        var entries = logger.Entries.Where(entry => entry.Message.Contains("not claimed as newly covered")).ToArray();

        entries.Should().HaveCount(2);
        entries.Should().AllSatisfy(entry => entry.Level.Should().Be(LogLevel.Warning));

        foreach (var withheld in result.NewlyCoveredWithheld)
        {
            entries
                .Should()
                .ContainSingle(entry => entry.Message.Contains(withheld.ScenarioId))
                .Which.Message.Should()
                .Contain(withheld.Reason);
        }
    }

    /// <summary>
    /// The wording consumers render verbatim is pinned to its cause.
    /// </summary>
    /// <remarks>
    /// These sentences are rendered downstream rather than re-derived, so rewording one is a
    /// deliberate cross-domain decision rather than something the engine suite waves through.
    /// </remarks>
    [Theory]
    [InlineData(
        CoverageWithholdingCause.Errored,
        "passed every run that produced a verdict rather than every run the suite asked for"
    )]
    [InlineData(CoverageWithholdingCause.Incomplete, "at least one run the suite asked for never happened")]
    [InlineData(CoverageWithholdingCause.OverRecorded, "its runs include at least one the suite never asked for")]
    public void Describe_EachCause_KeepsTheWordingConsumersRenderVerbatim(
        CoverageWithholdingCause cause,
        string expected
    ) => WithheldCoverage.Describe(cause).Should().Contain(expected);

    /// <summary>
    /// An undeclared cause is refused rather than described.
    /// </summary>
    /// <remarks>
    /// A value outside the enum is not a cause, and a fallback sentence would be prose
    /// manufactured from a value this domain never defined — indistinguishable, in a rendered
    /// report, from a real one.
    /// </remarks>
    [Fact]
    public void Describe_CauseOutsideTheDeclaredValues_IsRefusedRatherThanDescribed()
    {
        var describe = () => WithheldCoverage.Describe((CoverageWithholdingCause)99);

        describe.Should().Throw<ArgumentOutOfRangeException>();
    }

    /// <summary>
    /// The cause participates in canonical equality.
    /// </summary>
    /// <remarks>
    /// Only the cause varies, so only the cause can carry the inequality. Held against the same
    /// scenario id so a list-length difference cannot account for it.
    /// </remarks>
    [Fact]
    public void Equals_ResultsDifferingOnlyInAWithheldCause_AreNotEqual()
    {
        var one = new ComparisonResult
        {
            SuiteName = "s",
            NewlyCovered = ["a"],
            NewlyCoveredWithheld =
            [
                new WithheldCoverage { ScenarioId = "b", Cause = CoverageWithholdingCause.Errored },
            ],
        };
        var other = one with
        {
            NewlyCoveredWithheld =
            [
                new WithheldCoverage { ScenarioId = "b", Cause = CoverageWithholdingCause.Incomplete },
            ],
        };

        one.Equals(other).Should().BeFalse();
    }

    /// <summary>
    /// The scenario id participates too, so two entries differing only in attribution differ.
    /// </summary>
    [Fact]
    public void Equals_ResultsDifferingOnlyInAWithheldScenarioId_AreNotEqual()
    {
        var one = new ComparisonResult
        {
            SuiteName = "s",
            NewlyCoveredWithheld =
            [
                new WithheldCoverage { ScenarioId = "b", Cause = CoverageWithholdingCause.Errored },
            ],
        };
        var other = one with
        {
            NewlyCoveredWithheld =
            [
                new WithheldCoverage { ScenarioId = "c", Cause = CoverageWithholdingCause.Errored },
            ],
        };

        one.Equals(other).Should().BeFalse();
    }
}
