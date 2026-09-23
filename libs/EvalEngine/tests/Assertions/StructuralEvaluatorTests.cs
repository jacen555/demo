using FluentAssertions;

namespace Forge.EvalEngine.Tests.Assertions;

/// <summary>
/// <c>structural</c> — how deep the result went and whether its levels were filled. Absorbs the
/// origin harness's depth, levels-populated, fabricated-depth and no-path checks as selectors
/// plus polarity.
/// </summary>
public class StructuralEvaluatorTests
{
    // -------------------------------------------------------------------------------------
    // pathDepth — "reached depth N", and its negation, "did not fabricate depth N".
    // -------------------------------------------------------------------------------------

    [Theory]
    [InlineData("a/b/c", 1, true)]
    [InlineData("a/b/c", 3, true)]
    [InlineData("a/b/c", 4, false)]
    [InlineData("a", 1, true)]
    [InlineData("a", 2, false)]
    public async Task EvaluateAsync_PathDepth_PassesWhenThePathReachesAtLeastThatDepth(
        string path,
        int depth,
        bool expected
    )
    {
        var result = await Evidence.Evaluate(
            $"structural:pathDepth/{depth}",
            Evidence.Context(Evidence.Transcript(Evidence.Outcome(observedPath: path)))
        );

        result.Pass.Should().Be(expected);
    }

    [Fact]
    public async Task EvaluateAsync_NegatedPathDepth_PassesWhenTheStructureDidNotReachThatDepth()
    {
        var result = await Evidence.Evaluate(
            "!structural:pathDepth/4",
            Evidence.Context(Evidence.Transcript(Evidence.Outcome(observedPath: "a/b/c")))
        );

        result.Pass.Should().BeTrue("depth beyond what was reached would be fabricated");
    }

    [Fact]
    public async Task EvaluateAsync_PathDepthWhenNoPathWasReturned_FailsRatherThanThrowing()
    {
        var result = await Evidence.Evaluate(
            "structural:pathDepth/1",
            Evidence.Context(Evidence.Transcript(Evidence.Outcome(observedPath: null)))
        );

        result.Pass.Should().BeFalse();
    }

    [Fact]
    public async Task EvaluateAsync_PathDepthCountsDeclaredSegmentsIncludingBlankOnes()
    {
        var result = await Evidence.Evaluate(
            "structural:pathDepth/3",
            Evidence.Context(Evidence.Transcript(Evidence.Outcome(observedPath: "a//b")))
        );

        result
            .Pass.Should()
            .BeTrue("depth counts the levels the system declared; levelsPopulated judges their content");
    }

    // -------------------------------------------------------------------------------------
    // pathPresent — "a path was returned at all", negated for "no path returned".
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task EvaluateAsync_PathPresentWhenAPathWasReturned_Passes()
    {
        var result = await Evidence.Evaluate("structural:pathPresent", Evidence.Context(Evidence.Transcript()));

        result.Pass.Should().BeTrue();
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public async Task EvaluateAsync_NegatedPathPresentWhenNoPathWasReturned_Passes(string? path)
    {
        var result = await Evidence.Evaluate(
            "!structural:pathPresent",
            Evidence.Context(Evidence.Transcript(Evidence.Outcome(observedPath: path)))
        );

        result.Pass.Should().BeTrue();
    }

    // -------------------------------------------------------------------------------------
    // levelsPopulated — every declared level actually carries something.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task EvaluateAsync_LevelsPopulatedWhenEverySegmentIsFilled_Passes()
    {
        var result = await Evidence.Evaluate(
            "structural:levelsPopulated",
            Evidence.Context(Evidence.Transcript(Evidence.Outcome(observedPath: "triage/scope/resolve")))
        );

        result.Pass.Should().BeTrue();
    }

    [Theory]
    [InlineData("a//b")]
    [InlineData("a/ /b")]
    [InlineData("a/b/")]
    [InlineData("/a/b")]
    public async Task EvaluateAsync_LevelsPopulatedWithABlankSegment_Fails(string path)
    {
        var result = await Evidence.Evaluate(
            "structural:levelsPopulated",
            Evidence.Context(Evidence.Transcript(Evidence.Outcome(observedPath: path)))
        );

        result.Pass.Should().BeFalse();
    }

    [Fact]
    public async Task EvaluateAsync_LevelsPopulatedWhenNoPathWasReturned_FailsRatherThanPassingVacuously()
    {
        var result = await Evidence.Evaluate(
            "structural:levelsPopulated",
            Evidence.Context(Evidence.Transcript(Evidence.Outcome(observedPath: null)))
        );

        result.Pass.Should().BeFalse("an absent structure has no populated levels; passing would be a silent pass");
    }

    // -------------------------------------------------------------------------------------
    // turnDepth — the conversational reading of depth, and the one a REST run degenerates to.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task EvaluateAsync_TurnDepthReachedByTheTranscript_Passes()
    {
        var result = await Evidence.Evaluate(
            "structural:turnDepth/3",
            Evidence.Context(Evidence.EndingOnSynthesizedTurn())
        );

        result.Pass.Should().BeTrue();
    }

    [Fact]
    public async Task EvaluateAsync_TurnDepthBeyondTheTranscript_Fails()
    {
        var result = await Evidence.Evaluate("structural:turnDepth/2", Evidence.Context(Evidence.OneTurn()));

        result.Pass.Should().BeFalse();
    }

    [Fact]
    public async Task EvaluateAsync_TurnDepth_ExaminesEveryTurnItHadToCount()
    {
        var result = await Evidence.Evaluate(
            "structural:turnDepth/2",
            Evidence.Context(Evidence.EndingOnSynthesizedTurn())
        );

        result.ExaminedTurns.Should().Equal(1, 2, 3);
    }

    // -------------------------------------------------------------------------------------
    // ExaminedTurns for the outcome-derived selectors.
    // -------------------------------------------------------------------------------------

    [Theory]
    [InlineData("structural:pathPresent")]
    [InlineData("structural:levelsPopulated")]
    [InlineData("structural:pathDepth/2")]
    public async Task EvaluateAsync_OutcomeDerivedSelector_ExaminesTheTurnTheRunEndedOn(string expression)
    {
        var result = await Evidence.Evaluate(expression, Evidence.Context(Evidence.EndingOnSynthesizedTurn()));

        result.ExaminedTurns.Should().Equal(3);
    }

    // -------------------------------------------------------------------------------------
    // Malformed parameters are refused, never graded.
    // -------------------------------------------------------------------------------------

    [Theory]
    [InlineData("structural:pathDepth/0")]
    [InlineData("structural:pathDepth/-1")]
    [InlineData("structural:pathDepth/abc")]
    [InlineData("structural:pathDepth/4.0")]
    [InlineData("structural:pathDepth/+4")]
    [InlineData("structural:pathDepth/ 4")]
    [InlineData("structural:pathDepth/1e3")]
    [InlineData("structural:pathDepth/99999999999999999999")]
    [InlineData("structural:pathDepth/")]
    [InlineData("structural:pathDepth")]
    [InlineData("structural:turnDepth/0")]
    [InlineData("structural:turnDepth")]
    public async Task EvaluateAsync_MalformedDepth_IsRefusedRatherThanGraded(string expression)
    {
        await Evidence.Refuses(expression, Evidence.Context());
    }

    [Theory]
    [InlineData("structural")]
    [InlineData("structural:nope")]
    [InlineData("structural:PathPresent")]
    [InlineData("structural:pathPresent/extra")]
    public async Task EvaluateAsync_UnrecognisedSelector_IsRefused(string expression)
    {
        await Evidence.Refuses(expression, Evidence.Context());
    }

    [Fact]
    public async Task EvaluateAsync_TurnDepthOnATranscriptWithNoTurns_FailsAndExaminesNothing()
    {
        var result = await Evidence.Evaluate(
            "structural:turnDepth/1",
            Evidence.Context(Evidence.Transcript(turns: []))
        );

        result.Pass.Should().BeFalse();
        result.ExaminedTurns.Should().BeEmpty();
    }
}
