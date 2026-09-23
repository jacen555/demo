using FluentAssertions;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Tests.Assertions;

/// <summary>
/// <c>presence</c> — something is in the evidence, or is not. Absorbs the origin harness's
/// observed/absent pairs into one evaluator where <b>polarity carries the observed-vs-absent
/// half</b> and the parameter carries the token being looked for.
/// </summary>
public class PresenceAbsenceEvaluatorTests
{
    private static Transcript WithFields(params (string Key, string? Value)[] fields) =>
        Evidence.Transcript(Evidence.Outcome(fields: Evidence.Fields(fields)));

    private static Transcript WithTurns(params Turn[] turns) => Evidence.Transcript(turns: turns);

    // -------------------------------------------------------------------------------------
    // field — a flattened outcome field was returned, or was not.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task EvaluateAsync_FieldReturnedWithAValue_Passes()
    {
        var result = await Evidence.Evaluate(
            "presence:field/scope/confirm",
            Evidence.Context(WithFields(("scope/confirm", "yes")))
        );

        result.Pass.Should().BeTrue();
    }

    [Fact]
    public async Task EvaluateAsync_FieldNotReturnedAtAll_Fails()
    {
        var result = await Evidence.Evaluate(
            "presence:field/scope/confirm",
            Evidence.Context(WithFields(("something/else", "yes")))
        );

        result.Pass.Should().BeFalse();
    }

    [Fact]
    public async Task EvaluateAsync_FieldKeyPresentButValueIsNull_CountsAsAbsent()
    {
        var result = await Evidence.Evaluate(
            "presence:field/escalateReason",
            Evidence.Context(WithFields(("escalateReason", null)))
        );

        result.Pass.Should().BeFalse("a key carrying no value was not observed, it was merely enumerated");
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public async Task EvaluateAsync_FieldValueIsBlank_CountsAsAbsent(string value)
    {
        var result = await Evidence.Evaluate(
            "presence:field/escalateReason",
            Evidence.Context(WithFields(("escalateReason", value)))
        );

        result.Pass.Should().BeFalse();
    }

    [Fact]
    public async Task EvaluateAsync_NegatedFieldThatCarriesNoValue_Passes()
    {
        var result = await Evidence.Evaluate(
            "!presence:field/escalateReason",
            Evidence.Context(WithFields(("escalateReason", null)))
        );

        result.Pass.Should().BeTrue();
    }

    [Fact]
    public async Task EvaluateAsync_NegatedFieldThatWasReturned_Fails()
    {
        var result = await Evidence.Evaluate(
            "!presence:field/scope/confirm",
            Evidence.Context(WithFields(("scope/confirm", "yes")))
        );

        result.Pass.Should().BeFalse();
    }

    [Fact]
    public async Task EvaluateAsync_FieldKeyIsMatchedOrdinally_DiffersOnlyInCaseIsAbsent()
    {
        var result = await Evidence.Evaluate(
            "presence:field/ScopeConfirm",
            Evidence.Context(WithFields(("scopeconfirm", "yes")))
        );

        result.Pass.Should().BeFalse();
    }

    [Fact]
    public async Task EvaluateAsync_FieldAssertion_ExaminesTheTurnTheRunEndedOn()
    {
        var context = Evidence.Context(
            Evidence.Transcript(
                Evidence.Outcome(fields: Evidence.Fields(("scope/confirm", "yes"))),
                [Evidence.Turn(1), Evidence.Turn(2, provenance: TurnProvenance.Synthesized)]
            )
        );

        var result = await Evidence.Evaluate("presence:field/scope/confirm", context);

        result.ExaminedTurns.Should().Equal(2);
    }

    // -------------------------------------------------------------------------------------
    // response / stimulus — a token appears somewhere in the exchange.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task EvaluateAsync_TokenAppearsInAResponse_PassesAndExaminesTheMatchingTurn()
    {
        var context = Evidence.Context(
            WithTurns(
                Evidence.Turn(1, response: "nothing here"),
                Evidence.Turn(2, response: "please confirm the scope"),
                Evidence.Turn(3, response: "done")
            )
        );

        var result = await Evidence.Evaluate("presence:response/confirm the scope", context);

        result.Pass.Should().BeTrue();
        result.ExaminedTurns.Should().Equal(2);
    }

    [Fact]
    public async Task EvaluateAsync_TokenAppearsInSeveralResponses_ExaminesEveryMatchingTurn()
    {
        var context = Evidence.Context(
            WithTurns(
                Evidence.Turn(1, response: "confirm"),
                Evidence.Turn(2, response: "no"),
                Evidence.Turn(3, response: "confirm")
            )
        );

        var result = await Evidence.Evaluate("presence:response/confirm", context);

        result.ExaminedTurns.Should().Equal(1, 3);
    }

    [Fact]
    public async Task EvaluateAsync_TokenAbsentFromEveryResponse_FailsAndExaminesEveryTurnItHadToCheck()
    {
        var context = Evidence.Context(
            WithTurns(Evidence.Turn(1, response: "a"), Evidence.Turn(2, response: "b"), Evidence.Turn(3, response: "c"))
        );

        var result = await Evidence.Evaluate("presence:response/confirm", context);

        result.Pass.Should().BeFalse();

        // Establishing absence required reading every turn, and the report must say so.
        result.ExaminedTurns.Should().Equal(1, 2, 3);
    }

    [Fact]
    public async Task EvaluateAsync_NegatedTokenAbsentFromEveryResponse_PassesAndExaminesEveryTurn()
    {
        var context = Evidence.Context(WithTurns(Evidence.Turn(1, response: "a"), Evidence.Turn(2, response: "b")));

        var result = await Evidence.Evaluate("!presence:response/confirm", context);

        result.Pass.Should().BeTrue();
        result.ExaminedTurns.Should().Equal(1, 2);
    }

    [Fact]
    public async Task EvaluateAsync_NegatedTokenPresent_FailsAndExaminesTheViolatingTurn()
    {
        var context = Evidence.Context(
            WithTurns(Evidence.Turn(1, response: "a"), Evidence.Turn(2, response: "confirm"))
        );

        var result = await Evidence.Evaluate("!presence:response/confirm", context);

        result.Pass.Should().BeFalse();
        result.ExaminedTurns.Should().Equal(2);
    }

    [Fact]
    public async Task EvaluateAsync_TurnWithNoResponseAtAll_IsSkippedRatherThanThrowing()
    {
        var context = Evidence.Context(
            WithTurns(Evidence.Turn(1, response: null), Evidence.Turn(2, response: "confirm"))
        );

        var result = await Evidence.Evaluate("presence:response/confirm", context);

        result.Pass.Should().BeTrue();
        result.ExaminedTurns.Should().Equal(2);
    }

    [Fact]
    public async Task EvaluateAsync_TokenAppearsInAStimulus_Passes()
    {
        var context = Evidence.Context(
            WithTurns(Evidence.Turn(1, stimulus: "the scope is billing"), Evidence.Turn(2, stimulus: "unrelated"))
        );

        var result = await Evidence.Evaluate("presence:stimulus/scope is billing", context);

        result.Pass.Should().BeTrue();
        result.ExaminedTurns.Should().Equal(1);
    }

    [Fact]
    public async Task EvaluateAsync_TokenIsMatchedOrdinally_DiffersOnlyInCaseIsAbsent()
    {
        var context = Evidence.Context(WithTurns(Evidence.Turn(1, response: "Confirm")));

        var result = await Evidence.Evaluate("presence:response/confirm", context);

        result.Pass.Should().BeFalse();
    }

    [Fact]
    public async Task EvaluateAsync_TokenContainingASlash_IsTakenVerbatimAfterTheSelector()
    {
        var context = Evidence.Context(WithTurns(Evidence.Turn(1, response: "see triage/resolve for detail")));

        var result = await Evidence.Evaluate("presence:response/triage/resolve", context);

        result.Pass.Should().BeTrue();
    }

    // -------------------------------------------------------------------------------------
    // anyResponse / repeatedResponse — aggregate claims over the exchange.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task EvaluateAsync_AnyResponseWhenTheSystemRespondedAtLeastOnce_Passes()
    {
        var context = Evidence.Context(WithTurns(Evidence.Turn(1, response: null), Evidence.Turn(2, response: "here")));

        var result = await Evidence.Evaluate("presence:anyResponse", context);

        result.Pass.Should().BeTrue();
        result.ExaminedTurns.Should().Equal(2);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public async Task EvaluateAsync_AnyResponseWhenTheSystemNeverRespondedMeaningfully_Fails(string? response)
    {
        var context = Evidence.Context(WithTurns(Evidence.Turn(1, response: response)));

        var result = await Evidence.Evaluate("presence:anyResponse", context);

        result.Pass.Should().BeFalse();
    }

    [Fact]
    public async Task EvaluateAsync_RepeatedResponseWhenTheSystemSaidTheSameThingTwice_Passes()
    {
        var context = Evidence.Context(
            WithTurns(
                Evidence.Turn(1, response: "which scope?"),
                Evidence.Turn(2, response: "elsewhere"),
                Evidence.Turn(3, response: "which scope?")
            )
        );

        var result = await Evidence.Evaluate("presence:repeatedResponse", context);

        result.Pass.Should().BeTrue();

        // The repetition itself is the evidence, so those are the turns to surface.
        result.ExaminedTurns.Should().Equal(1, 3);
    }

    [Fact]
    public async Task EvaluateAsync_NegatedRepeatedResponseWhenNothingRepeated_Passes()
    {
        var context = Evidence.Context(
            WithTurns(Evidence.Turn(1, response: "a"), Evidence.Turn(2, response: "b"), Evidence.Turn(3, response: "c"))
        );

        var result = await Evidence.Evaluate("!presence:repeatedResponse", context);

        result.Pass.Should().BeTrue();
        result.ExaminedTurns.Should().Equal(1, 2, 3);
    }

    [Fact]
    public async Task EvaluateAsync_RepeatedResponseIgnoresTurnsThatCarryNoResponse()
    {
        var context = Evidence.Context(
            WithTurns(
                Evidence.Turn(1, response: null),
                Evidence.Turn(2, response: null),
                Evidence.Turn(3, response: "a")
            )
        );

        var result = await Evidence.Evaluate("presence:repeatedResponse", context);

        result.Pass.Should().BeFalse("two absent responses are not the system repeating itself");
    }

    // -------------------------------------------------------------------------------------
    // Empty transcripts and malformed parameters.
    // -------------------------------------------------------------------------------------

    [Theory]
    [InlineData("presence:response/confirm")]
    [InlineData("presence:stimulus/confirm")]
    [InlineData("presence:anyResponse")]
    [InlineData("presence:repeatedResponse")]
    public async Task EvaluateAsync_TranscriptWithNoTurns_FailsAndExaminesNothing(string expression)
    {
        var result = await Evidence.Evaluate(expression, Evidence.Context(Evidence.Transcript(turns: [])));

        result.Pass.Should().BeFalse();
        result.ExaminedTurns.Should().BeEmpty();
    }

    [Theory]
    [InlineData("presence:response/")]
    [InlineData("presence:stimulus/")]
    [InlineData("presence:field/")]
    public async Task EvaluateAsync_BlankToken_IsRefusedBecauseItWouldMatchEverything(string expression)
    {
        await Evidence.Refuses(expression, Evidence.Context());
    }

    [Theory]
    [InlineData("presence")]
    [InlineData("presence:nope")]
    [InlineData("presence:field")]
    [InlineData("presence:response")]
    [InlineData("presence:Field/x")]
    [InlineData("presence:anyResponse/extra")]
    [InlineData("presence:repeatedResponse/extra")]
    public async Task EvaluateAsync_UnrecognisedOrIncompleteSelector_IsRefused(string expression)
    {
        await Evidence.Refuses(expression, Evidence.Context());
    }

    // -------------------------------------------------------------------------------------
    // Kind-agnosticism.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task EvaluateAsync_OneTurnAndManyTurnEvidence_UseTheSameEvaluator()
    {
        var registry = Forge.EvalEngine.Assertions.AssertionEvaluatorRegistry.CreateDefault();
        registry.TryGetEvaluator("presence", out var evaluator).Should().BeTrue();

        var rest = await Evidence.Evaluate(
            "presence:response/confirm",
            Evidence.Context(WithTurns(Evidence.Turn(1, response: "please confirm")))
        );
        var conversation = await Evidence.Evaluate(
            "presence:response/confirm",
            Evidence.Context(
                WithTurns(
                    Evidence.Turn(1, response: "hello"),
                    Evidence.Turn(2, response: "please confirm", provenance: TurnProvenance.Synthesized)
                )
            )
        );

        evaluator.Should().NotBeNull();
        rest.Pass.Should().BeTrue();
        conversation.Pass.Should().BeTrue();
        // The report must be able to see the match landed on a synthesized turn.
        conversation.ExaminedTurns.Should().Equal(2);
    }
}
