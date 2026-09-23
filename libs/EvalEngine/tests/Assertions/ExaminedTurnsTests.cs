using FluentAssertions;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Tests.Assertions;

/// <summary>
/// <see cref="Forge.EvalEngine.Assertions.AssertionResult.ExaminedTurns"/> is load-bearing rather
/// than bookkeeping.
/// </summary>
/// <remarks>
/// It is what lets a report surface an assertion that rested on a turn the simulated caller
/// invented — the misdiagnosis the script-overrun guard defends against at load time, caught here
/// at grading time for the runs the guard could not bound in advance. An evaluator that examines
/// turns and reports none defeats that silently, so every evaluator is checked.
/// </remarks>
public class ExaminedTurnsTests
{
    private static Transcript IndexedFromFive(string? lastResponse = "confirm") =>
        Evidence.Transcript(
            Evidence.Outcome(fields: Evidence.Fields(("scope/confirm", "yes"))),
            [
                Evidence.Turn(5, response: "opening"),
                Evidence.Turn(6, response: lastResponse, provenance: TurnProvenance.Synthesized),
            ]
        );

    // -------------------------------------------------------------------------------------
    // The recorded Turn.Index is reported, not the position in the list.
    // -------------------------------------------------------------------------------------

    [Theory]
    [InlineData("structural:pathPresent")]
    [InlineData("structural:levelsPopulated")]
    [InlineData("structural:pathDepth/2")]
    [InlineData("presence:field/scope/confirm")]
    [InlineData("expectedBehavior:outcome/resolved")]
    public async Task EvaluateAsync_TurnsNotIndexedFromOne_ReportsTheRecordedIndexOfTheFinalTurn(string expression)
    {
        var result = await Evidence.Evaluate(expression, Evidence.Context(IndexedFromFive()));

        result.ExaminedTurns.Should().Equal(6);
    }

    [Fact]
    public async Task EvaluateAsync_ScanningTurnsNotIndexedFromOne_ReportsTheirRecordedIndices()
    {
        var result = await Evidence.Evaluate("presence:response/nowhere", Evidence.Context(IndexedFromFive()));

        result.Pass.Should().BeFalse();
        result.ExaminedTurns.Should().Equal(5, 6);
    }

    [Fact]
    public async Task EvaluateAsync_TurnDepthOnTurnsNotIndexedFromOne_ReportsTheirRecordedIndices()
    {
        var result = await Evidence.Evaluate("structural:turnDepth/2", Evidence.Context(IndexedFromFive()));

        result.ExaminedTurns.Should().Equal(5, 6);
    }

    [Fact]
    public async Task EvaluateAsync_BaselineComparison_ReportsTheRecordedIndexOfTheFinalTurn()
    {
        var result = await Evidence.Evaluate(
            "baseline:outcome",
            Evidence.Context(IndexedFromFive(), baseline: Evidence.OneTurn())
        );

        result.ExaminedTurns.Should().Equal(6);
    }

    // -------------------------------------------------------------------------------------
    // The point of recording them: a reader can cross-reference provenance.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task EvaluateAsync_AssertionRestingOnASynthesizedTurn_IsVisibleByCrossReferencingProvenance()
    {
        var transcript = IndexedFromFive();

        var result = await Evidence.Evaluate("presence:response/confirm", Evidence.Context(transcript));

        result.Pass.Should().BeTrue();

        var provenance = result
            .ExaminedTurns.Select(index => transcript.Turns.Single(turn => turn.Index == index).Provenance)
            .ToArray();

        provenance
            .Should()
            .Contain(
                TurnProvenance.Synthesized,
                "the report must be able to tell a reader this verdict rested on a stimulus the caller invented"
            );
    }

    [Fact]
    public async Task EvaluateAsync_AssertionRestingOnlyOnScriptedTurns_ShowsNoSynthesizedDependency()
    {
        var transcript = Evidence.Transcript(
            turns: [Evidence.Turn(1, response: "confirm"), Evidence.Turn(2, provenance: TurnProvenance.Synthesized)]
        );

        var result = await Evidence.Evaluate("presence:response/confirm", Evidence.Context(transcript));

        var provenance = result
            .ExaminedTurns.Select(index => transcript.Turns.Single(turn => turn.Index == index).Provenance)
            .ToArray();

        provenance.Should().AllBeEquivalentTo(TurnProvenance.Scripted);
    }

    // -------------------------------------------------------------------------------------
    // Every evaluator reports something when there was something to examine.
    // -------------------------------------------------------------------------------------

    [Theory]
    [InlineData("exactMatch:outcome")]
    [InlineData("structural:pathPresent")]
    [InlineData("structural:turnDepth/1")]
    [InlineData("presence:field/scope/confirm")]
    [InlineData("presence:anyResponse")]
    [InlineData("presence:repeatedResponse")]
    [InlineData("baseline:outcome")]
    [InlineData("expectedBehavior:outcome/resolved")]
    public async Task EvaluateAsync_AnyCategoryAgainstANonEmptyTranscript_ReportsAtLeastOneExaminedTurn(
        string expression
    )
    {
        var context = Evidence.Context(
            Evidence.Transcript(
                Evidence.Outcome(fields: Evidence.Fields(("scope/confirm", "yes"))),
                [Evidence.Turn(1), Evidence.Turn(2)]
            ),
            grading: new Scenarios.Grading { ExpectedOutcome = "resolved" },
            baseline: Evidence.Transcript(Evidence.Outcome(fields: Evidence.Fields(("scope/confirm", "yes"))))
        );

        var result = await Evidence.Evaluate(expression, context);

        result.ExaminedTurns.Should().NotBeEmpty("an evaluator that examines turns but reports none defeats the guard");
    }
}
