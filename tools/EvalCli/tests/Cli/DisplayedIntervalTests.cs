using FluentAssertions;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Tests.Support;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Statistics;

namespace Forge.EvalCli.Tests.Cli;

/// <summary>
/// The binding between what a rate renders and what anything else is allowed to reason from.
/// </summary>
/// <remarks>
/// <b>One judgement, asked in two places, must answer the same way.</b> <c>MarkdownReport.Rate</c>
/// decides whether an artifact's recorded bounds may be shown; <c>DisplayedInterval</c> answers
/// the same question for a caller that wants to compare them. If the two drifted, a bound the page
/// refuses to print would still reach a conclusion printed beside it — the shape of every finding
/// this repository keeps producing, with the two contexts one method apart instead of one file
/// apart.
/// </remarks>
public class DisplayedIntervalTests
{
    /// <summary>
    /// The shapes, keyed by name so the theory's signature can stay public.
    /// </summary>
    /// <remarks>
    /// <c>IntervalSettings</c> is internal, so a <c>[Theory]</c> parameter cannot carry one. The
    /// name is the parameter and the case is looked up here.
    /// </remarks>
    private static (ScenarioResult Scenario, bool RecordsSettings) Case(string shape) =>
        shape switch
        {
            "a rate with its interval" => (ReportFixture.Scenario("a", 4, 5), true),
            "a single observation" => (ReportFixture.Scenario("a", 1, 1), true),
            "no interval settings recorded" => (ReportFixture.Scenario("a", 4, 5), false),
            "a summary carrying no interval" => (ReportFixture.WithoutInterval("a"), true),
            "a summary that disagrees with its runs" => (ReportFixture.Tampered("a"), true),
            "a forged interval" => (ReportFixture.ForgedInterval("a"), true),
            "a method the run did not record" => (ReportFixture.ForeignIntervalMethod("a"), true),
            "no repetition produced a verdict" => (ReportFixture.Ungradeable("a"), true),
            "a single observation and no settings" => (ReportFixture.Scenario("a", 1, 1), false),
            "a summary over runs that produced no verdict" => (ReportFixture.SummarisedWithoutVerdicts("a"), true),
            "forged bounds and a level but no method" => (ReportFixture.ForgedInterval("a"), true),
            "forged bounds and a method but no level" => (ReportFixture.ForgedInterval("a"), true),
            _ => throw new ArgumentOutOfRangeException(nameof(shape), shape, "unknown shape"),
        };

    /// <summary>
    /// The settings each shape is judged against.
    /// </summary>
    /// <remarks>
    /// <b>"Half configured" is two cases, not one, and both were missing.</b> A bound is checked
    /// by recomputing it from the method and the level together, so either one missing skips the
    /// check entirely — while the bounds still look recorded. The level-only case let unverified
    /// bounds be displayed and compared; the method-only case additionally reaches a
    /// <c>Confidence!</c> dereference on the way to printing them.
    /// </remarks>
    private static MarkdownReport.IntervalSettings Settings(string shape) =>
        shape switch
        {
            "no interval settings recorded" or "a single observation and no settings" => new(null, null),
            "forged bounds and a level but no method" => new(null, ReportFixture.ConfidenceLevel),
            "forged bounds and a method but no level" => new(IntervalMethod.Wilson, null),
            _ => new(IntervalMethod.Wilson, ReportFixture.ConfidenceLevel),
        };

    public static TheoryData<string> Shapes() =>
        [
            "a rate with its interval",
            "a single observation",
            "no interval settings recorded",
            "a summary carrying no interval",
            "a summary that disagrees with its runs",
            "a forged interval",
            "a method the run did not record",
            "no repetition produced a verdict",
            "a single observation and no settings",
            "a summary over runs that produced no verdict",
            "forged bounds and a level but no method",
            "forged bounds and a method but no level",
        ];

    [Theory]
    [MemberData(nameof(Shapes))]
    public void DisplayedInterval_AgreesWithWhetherTheRateActuallyPrintedAnInterval(string shape)
    {
        var (scenario, _) = Case(shape);
        var settings = Settings(shape);

        var rendered = MarkdownReport.Rate(scenario, settings, "this run");
        var displayed = MarkdownReport.DisplayedInterval(scenario, settings);

        (displayed is not null)
            .Should()
            .Be(
                rendered.Contains(" CI ", StringComparison.Ordinal),
                "the rate for {0} rendered as \"{1}\"",
                shape,
                rendered
            );
    }

    [Theory]
    [MemberData(nameof(Shapes))]
    public void DisplayedInterval_WhenItAnswersAnInterval_IsTheOneTheRateActuallyPrinted(string shape)
    {
        var (scenario, _) = Case(shape);
        var settings = Settings(shape);

        if (MarkdownReport.DisplayedInterval(scenario, settings) is not { } interval)
        {
            return;
        }

        MarkdownReport
            .Rate(scenario, settings, "this run")
            .Should()
            .Contain(MarkdownReport.Percent(interval.Lower), "the bounds shown for {0} must be the ones", shape)
            .And.Contain(MarkdownReport.Percent(interval.Upper));
    }

    [Theory]
    [MemberData(nameof(Shapes))]
    public void DisplayedInterval_WhenItAnswersAnInterval_TheSettingsItWasCheckedAgainstAreComplete(string shape)
    {
        // **Consistency is not correctness.** One shared decision that is wrong produces two wrong
        // outputs rather than one, and this is the case it was wrong for: with a level recorded
        // and no recognised method, `Inconsistent` skips bound verification entirely and the
        // bounds were still being displayed and compared. A bound can only be checked against
        // both settings, so both are required before it may be shown.
        var (scenario, _) = Case(shape);
        var settings = Settings(shape);

        if (MarkdownReport.DisplayedInterval(scenario, settings) is null)
        {
            return;
        }

        settings.Method.Should().NotBeNull("a bound cannot be recomputed without the method that produced it");
        settings.Confidence.Should().NotBeNull("a bound cannot be recomputed without the level it was computed at");
    }

    [Fact]
    public void Rate_WhenALevelIsRecordedAndTheMethodIsNot_WithholdsForgedBoundsRatherThanPrintingThem()
    {
        var settings = new MarkdownReport.IntervalSettings(null, ReportFixture.ConfidenceLevel);

        var rendered = MarkdownReport.Rate(ReportFixture.ForgedInterval("a"), settings, "this run");

        rendered.Should().NotContain(" CI ").And.NotContain("99%");
        rendered.Should().Contain("could not be verified and is not shown");
    }

    [Fact]
    public void Rate_WhenAMethodIsRecordedAndTheLevelIsNot_WithholdsTheBoundsWithoutDereferencingTheLevel()
    {
        // The mirror of the case above, and the one that does not merely misreport: printing a
        // bound needs the level to label it with, so a method-only run reaches `Confidence!` on
        // the way there and faults out of the renderer.
        var settings = new MarkdownReport.IntervalSettings(IntervalMethod.Wilson, null);

        var act = () => MarkdownReport.Rate(ReportFixture.ForgedInterval("a"), settings, "this run");

        act.Should().NotThrow();
        act().Should().NotContain(" CI ").And.Contain("could not be verified and is not shown");
    }

    [Fact]
    public void DisplayedInterval_WhenNoRepetitionProducedAVerdictAndBoundsWereRecorded_AnswersNothingRatherThanFaulting()
    {
        // Asked directly, not through `Rate`. `Rate` returns before it reaches here for this
        // shape, so a guard removed from this method would be invisible through that door — and
        // the guard is real: verification recomputes through ProportionInterval, which refuses
        // fewer than one trial, so without it this faults for any caller that is not `Rate`.
        var settings = new MarkdownReport.IntervalSettings(IntervalMethod.Wilson, ReportFixture.ConfidenceLevel);
        var scenario = ReportFixture.SummarisedWithoutVerdicts("a", interval: true);

        var act = () => MarkdownReport.DisplayedInterval(scenario, settings);

        act.Should().NotThrow();
        act().Should().BeNull();
    }

    [Fact]
    public void Rate_WhenNoRepetitionProducedAVerdictButASummaryWasRecorded_IsNotAPassRateOfZero()
    {
        var settings = new MarkdownReport.IntervalSettings(IntervalMethod.Wilson, ReportFixture.ConfidenceLevel);

        var rendered = MarkdownReport.Rate(ReportFixture.SummarisedWithoutVerdicts("a"), settings, "this run");

        rendered.Should().Contain("no repetition produced a verdict");
        rendered.Should().NotContain("0% (n=0").And.NotContain(" CI ");
    }

    [Fact]
    public void Rate_WhenNoRepetitionProducedAVerdictAndBoundsWereRecorded_DoesNotTryToRecomputeThem()
    {
        // ProportionInterval refuses fewer than one trial, so verifying a zero-trial summary
        // throws out of the renderer and reaches the defect handler — the one branch that prints
        // a stack trace. The runs must be checked before the summary is trusted at all.
        var settings = new MarkdownReport.IntervalSettings(IntervalMethod.Wilson, ReportFixture.ConfidenceLevel);

        var act = () =>
            MarkdownReport.Rate(ReportFixture.SummarisedWithoutVerdicts("a", interval: true), settings, "x");

        act.Should().NotThrow();
        act().Should().Contain("no repetition produced a verdict");
    }

    [Fact]
    public void DisplayedInterval_WhenThereIsNoScenario_AnswersNothing() =>
        MarkdownReport
            .DisplayedInterval(null, new MarkdownReport.IntervalSettings(IntervalMethod.Wilson, 0.95))
            .Should()
            .BeNull();
}
