using FluentAssertions;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Tests.Assertions;

/// <summary>
/// <c>exactMatch</c> — the observed outcome or path equals the expectation the suite declared.
/// Absorbs the origin harness's per-field exact checks as a parameter rather than a class each.
/// </summary>
public class ExactMatchEvaluatorTests
{
    private static Grading Expecting(string? outcome = null, string? path = null) =>
        new() { ExpectedOutcome = outcome, ExpectedPath = path };

    // -------------------------------------------------------------------------------------
    // Happy paths.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task EvaluateAsync_OutcomeMatchesTheDeclaredExpectation_Passes()
    {
        var result = await Evidence.Evaluate(
            "exactMatch:outcome",
            Evidence.Context(Evidence.Transcript(Evidence.Outcome(observedOutcome: "resolved")), Expecting("resolved"))
        );

        result.Pass.Should().BeTrue();
        result.Detail.Should().NotBeNullOrWhiteSpace();
    }

    [Fact]
    public async Task EvaluateAsync_PathMatchesTheDeclaredExpectation_Passes()
    {
        var result = await Evidence.Evaluate(
            "exactMatch:path",
            Evidence.Context(
                Evidence.Transcript(Evidence.Outcome(observedPath: "triage/resolve")),
                Expecting(path: "triage/resolve")
            )
        );

        result.Pass.Should().BeTrue();
    }

    [Fact]
    public async Task EvaluateAsync_OutcomeDiffersFromTheExpectation_FailsAndReportsBothValues()
    {
        var result = await Evidence.Evaluate(
            "exactMatch:outcome",
            Evidence.Context(Evidence.Transcript(Evidence.Outcome(observedOutcome: "escalated")), Expecting("resolved"))
        );

        result.Pass.Should().BeFalse();
        result.Detail.Should().Contain("resolved").And.Contain("escalated");
    }

    [Fact]
    public async Task EvaluateAsync_ComparisonIsOrdinal_DiffersOnlyInCaseStillFails()
    {
        var result = await Evidence.Evaluate(
            "exactMatch:outcome",
            Evidence.Context(Evidence.Transcript(Evidence.Outcome(observedOutcome: "Resolved")), Expecting("resolved"))
        );

        result.Pass.Should().BeFalse();
    }

    // -------------------------------------------------------------------------------------
    // Null observed values are a system behaviour, not an authoring error.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task EvaluateAsync_ObservedOutcomeIsNull_FailsRatherThanThrowing()
    {
        var result = await Evidence.Evaluate(
            "exactMatch:outcome",
            Evidence.Context(Evidence.Transcript(Evidence.Outcome(observedOutcome: null)), Expecting("resolved"))
        );

        result.Pass.Should().BeFalse();
        result.Detail.Should().Contain("resolved");
    }

    [Fact]
    public async Task EvaluateAsync_ObservedPathIsNull_FailsRatherThanThrowing()
    {
        var result = await Evidence.Evaluate(
            "exactMatch:path",
            Evidence.Context(
                Evidence.Transcript(Evidence.Outcome(observedPath: null)),
                Expecting(path: "triage/resolve")
            )
        );

        result.Pass.Should().BeFalse();
    }

    // -------------------------------------------------------------------------------------
    // Polarity.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task EvaluateAsync_NegatedAndTheOutcomeDiffers_Passes()
    {
        var result = await Evidence.Evaluate(
            "!exactMatch:outcome",
            Evidence.Context(Evidence.Transcript(Evidence.Outcome(observedOutcome: "escalated")), Expecting("resolved"))
        );

        result.Pass.Should().BeTrue();
    }

    [Fact]
    public async Task EvaluateAsync_NegatedAndTheOutcomeMatches_Fails()
    {
        var result = await Evidence.Evaluate(
            "!exactMatch:outcome",
            Evidence.Context(Evidence.Transcript(Evidence.Outcome(observedOutcome: "resolved")), Expecting("resolved"))
        );

        result.Pass.Should().BeFalse();
    }

    [Fact]
    public async Task EvaluateAsync_AffirmedPrefix_BehavesAsTheDefaultPolarity()
    {
        var result = await Evidence.Evaluate(
            "+exactMatch:outcome",
            Evidence.Context(Evidence.Transcript(Evidence.Outcome(observedOutcome: "resolved")), Expecting("resolved"))
        );

        result.Pass.Should().BeTrue();
    }

    // -------------------------------------------------------------------------------------
    // Un-evaluable: refused, never graded.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task EvaluateAsync_ExpectationWasNeverDeclared_IsRefusedRatherThanPassed()
    {
        var exception = await Evidence.Refuses(
            "exactMatch:outcome",
            Evidence.Context(Evidence.Transcript(), new Grading())
        );

        exception.Message.Should().Contain("expectedOutcome");
    }

    [Fact]
    public async Task EvaluateAsync_NegatedAndTheExpectationWasNeverDeclared_IsStillRefused()
    {
        await Evidence.Refuses("!exactMatch:outcome", Evidence.Context(Evidence.Transcript(), new Grading()));
    }

    [Fact]
    public async Task EvaluateAsync_ExpectedPathWasNeverDeclared_IsRefused()
    {
        var exception = await Evidence.Refuses("exactMatch:path", Evidence.Context(Evidence.Transcript()));

        exception.Message.Should().Contain("expectedPath");
    }

    [Fact]
    public async Task EvaluateAsync_NoParameter_IsRefused()
    {
        await Evidence.Refuses("exactMatch", Evidence.Context(grading: Expecting("resolved")));
    }

    [Theory]
    [InlineData("exactMatch:nope")]
    [InlineData("exactMatch:OUTCOME")]
    [InlineData("exactMatch:field/scope/confirm")]
    public async Task EvaluateAsync_UnrecognisedSelector_IsRefused(string expression)
    {
        var exception = await Evidence.Refuses(expression, Evidence.Context(grading: Expecting("resolved", "a/b")));

        exception.Message.Should().Contain("outcome", "the refusal should name the selectors that do exist");
    }

    // -------------------------------------------------------------------------------------
    // ExaminedTurns — the outcome is attributed to the turn the run ended on.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task EvaluateAsync_OutcomeAssertion_ExaminesTheTurnTheRunEndedOn()
    {
        var result = await Evidence.Evaluate(
            "exactMatch:outcome",
            Evidence.Context(Evidence.EndingOnSynthesizedTurn(), Expecting("resolved"))
        );

        // The outcome the run ended on was produced by its final turn — here, a synthesized one.
        result.ExaminedTurns.Should().Equal(3);
    }

    [Fact]
    public async Task EvaluateAsync_OutcomeAssertionOnAOneTurnRun_ExaminesThatTurn()
    {
        var result = await Evidence.Evaluate(
            "exactMatch:outcome",
            Evidence.Context(Evidence.OneTurn(), Expecting("resolved"))
        );

        result.ExaminedTurns.Should().Equal(1);
    }

    [Fact]
    public async Task EvaluateAsync_TranscriptWithNoTurns_ReportsNoExaminedTurnsAndStillGrades()
    {
        var result = await Evidence.Evaluate(
            "exactMatch:outcome",
            Evidence.Context(Evidence.Transcript(turns: []), Expecting("resolved"))
        );

        result.Pass.Should().BeTrue();
        result.ExaminedTurns.Should().BeEmpty("there were no turns to examine, and claiming otherwise would be a lie");
    }

    [Fact]
    public async Task EvaluateAsync_Always_EchoesTheSpecItJudged()
    {
        var result = await Evidence.Evaluate("exactMatch:outcome", Evidence.Context(grading: Expecting("resolved")));

        result.Spec.Category.Should().Be("exactMatch");
        result.Spec.Parameter.Should().Be("outcome");
    }

    // -------------------------------------------------------------------------------------
    // Kind-agnosticism: one code path for a REST call and a conversation.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task EvaluateAsync_RestOneTurnAndConversationManyTurn_ReachTheSameVerdict()
    {
        var outcome = Evidence.Outcome(observedOutcome: "resolved");

        var rest = await Evidence.Evaluate(
            "exactMatch:outcome",
            Evidence.Context(Evidence.OneTurn(outcome), Expecting("resolved"))
        );
        var conversation = await Evidence.Evaluate(
            "exactMatch:outcome",
            Evidence.Context(
                Evidence.Transcript(outcome, [Evidence.Turn(1), Evidence.Turn(2, provenance: TurnProvenance.Live)]),
                Expecting("resolved")
            )
        );

        rest.Pass.Should().Be(conversation.Pass);
    }
}
