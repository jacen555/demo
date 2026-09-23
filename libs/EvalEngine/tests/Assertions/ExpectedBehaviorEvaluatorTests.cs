using FluentAssertions;

namespace Forge.EvalEngine.Tests.Assertions;

/// <summary>
/// <c>expectedBehavior</c> — the expected-failure category.
/// </summary>
/// <remarks>
/// Asserting that a system <i>correctly fails</i> is a first-class requirement here, not an
/// afterthought: a scenario whose whole point is "this should be refused with 429" must be
/// expressible as data, and must <b>pass</b> when the system does exactly that.
/// </remarks>
public class ExpectedBehaviorEvaluatorTests
{
    // -------------------------------------------------------------------------------------
    // The headline case: a correct failure is a pass.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task EvaluateAsync_SystemReturnedTheStatusTheScenarioExpectedToProvoke_Passes()
    {
        var context = Evidence.Context(Evidence.Transcript(transport: Evidence.Transport(("statusCode", "429"))));

        var result = await Evidence.Evaluate("expectedBehavior:transport/statusCode=429", context);

        result.Pass.Should().BeTrue("a scenario whose whole point is 'this should 429' must pass when it does");
    }

    [Fact]
    public async Task EvaluateAsync_SystemSucceededWhereTheScenarioExpectedItToBeRefused_Fails()
    {
        var context = Evidence.Context(Evidence.Transcript(transport: Evidence.Transport(("statusCode", "200"))));

        var result = await Evidence.Evaluate("expectedBehavior:transport/statusCode=429", context);

        result.Pass.Should().BeFalse();
        result.Detail.Should().Contain("429").And.Contain("200");
    }

    [Fact]
    public async Task EvaluateAsync_ExpectedTransportAttributeWasNeverReported_Fails()
    {
        var context = Evidence.Context(Evidence.Transcript(transport: Evidence.Transport()));

        var result = await Evidence.Evaluate("expectedBehavior:transport/statusCode=429", context);

        result.Pass.Should().BeFalse();
    }

    [Fact]
    public async Task EvaluateAsync_RefusalOutcomeNamedInline_Passes()
    {
        var context = Evidence.Context(Evidence.Transcript(Evidence.Outcome(observedOutcome: "out_of_scope")));

        var result = await Evidence.Evaluate("expectedBehavior:outcome/out_of_scope", context);

        result.Pass.Should().BeTrue();
    }

    [Fact]
    public async Task EvaluateAsync_OutcomeTokenIsIndependentOfGrading_NeedsNoDeclaredExpectation()
    {
        var context = Evidence.Context(
            Evidence.Transcript(Evidence.Outcome(observedOutcome: "invalid_input")),
            grading: new Scenarios.Grading()
        );

        var result = await Evidence.Evaluate("expectedBehavior:outcome/invalid_input", context);

        result.Pass.Should().BeTrue("the expected behaviour is named in the assertion, not in grading");
    }

    [Fact]
    public async Task EvaluateAsync_PathTokenNamedInline_Passes()
    {
        var context = Evidence.Context(Evidence.Transcript(Evidence.Outcome(observedPath: "triage/refuse")));

        var result = await Evidence.Evaluate("expectedBehavior:path/triage/refuse", context);

        result.Pass.Should().BeTrue("the token after the selector is taken verbatim, slashes included");
    }

    // -------------------------------------------------------------------------------------
    // field — a named reason token, and its negation.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task EvaluateAsync_ReasonFieldCarriesTheExpectedToken_Passes()
    {
        var context = Evidence.Context(
            Evidence.Transcript(Evidence.Outcome(fields: Evidence.Fields(("escalateReason", "out_of_scope"))))
        );

        var result = await Evidence.Evaluate("expectedBehavior:field/escalateReason=out_of_scope", context);

        result.Pass.Should().BeTrue();
    }

    [Fact]
    public async Task EvaluateAsync_ReasonFieldCarriesADifferentToken_Fails()
    {
        var context = Evidence.Context(
            Evidence.Transcript(Evidence.Outcome(fields: Evidence.Fields(("escalateReason", "timeout"))))
        );

        var result = await Evidence.Evaluate("expectedBehavior:field/escalateReason=out_of_scope", context);

        result.Pass.Should().BeFalse();
    }

    [Fact]
    public async Task EvaluateAsync_NegatedReasonField_PassesWhenTheSystemDidNotDoThat()
    {
        var context = Evidence.Context(
            Evidence.Transcript(Evidence.Outcome(fields: Evidence.Fields(("escalateReason", "timeout"))))
        );

        var result = await Evidence.Evaluate("!expectedBehavior:field/escalateReason=out_of_scope", context);

        result.Pass.Should().BeTrue();
    }

    [Fact]
    public async Task EvaluateAsync_FieldKeyContainingASlash_IsSplitOnTheFirstEqualsOnly()
    {
        var context = Evidence.Context(
            Evidence.Transcript(Evidence.Outcome(fields: Evidence.Fields(("scope/confirm", "a=b"))))
        );

        var result = await Evidence.Evaluate("expectedBehavior:field/scope/confirm=a=b", context);

        result.Pass.Should().BeTrue();
    }

    [Fact]
    public async Task EvaluateAsync_FieldNotReturnedAtAll_Fails()
    {
        var context = Evidence.Context(Evidence.Transcript(Evidence.Outcome(fields: Evidence.Fields())));

        var result = await Evidence.Evaluate("expectedBehavior:field/escalateReason=out_of_scope", context);

        result.Pass.Should().BeFalse();
    }

    [Fact]
    public async Task EvaluateAsync_FieldPresentWithANullValue_Fails()
    {
        var context = Evidence.Context(
            Evidence.Transcript(Evidence.Outcome(fields: Evidence.Fields(("escalateReason", null))))
        );

        var result = await Evidence.Evaluate("expectedBehavior:field/escalateReason=out_of_scope", context);

        result.Pass.Should().BeFalse();
    }

    // -------------------------------------------------------------------------------------
    // fieldAtLeast — a numeric threshold.
    // -------------------------------------------------------------------------------------

    [Theory]
    [InlineData("0.75", "0.4", true)]
    [InlineData("0.4", "0.4", true)]
    [InlineData("0.2", "0.4", false)]
    [InlineData("-1", "0", false)]
    public async Task EvaluateAsync_NumericFieldAgainstAThreshold_PassesWhenAtOrAboveIt(
        string observed,
        string threshold,
        bool expected
    )
    {
        var context = Evidence.Context(
            Evidence.Transcript(Evidence.Outcome(fields: Evidence.Fields(("routeConfidence", observed))))
        );

        var result = await Evidence.Evaluate($"expectedBehavior:fieldAtLeast/routeConfidence={threshold}", context);

        result.Pass.Should().Be(expected);
    }

    [Theory]
    [InlineData("not-a-number")]
    [InlineData("")]
    [InlineData(null)]
    [InlineData("NaN")]
    public async Task EvaluateAsync_FieldIsNotANumberTheSystemCouldHaveMeant_FailsRatherThanThrowing(string? observed)
    {
        var context = Evidence.Context(
            Evidence.Transcript(Evidence.Outcome(fields: Evidence.Fields(("routeConfidence", observed))))
        );

        var result = await Evidence.Evaluate("expectedBehavior:fieldAtLeast/routeConfidence=0.4", context);

        result.Pass.Should().BeFalse("a non-numeric reading is the system's behaviour, not the author's mistake");
        result.Detail.Should().NotBeNullOrWhiteSpace();
    }

    [Fact]
    public async Task EvaluateAsync_ThresholdIsParsedInvariantly_IgnoresTheAmbientCulture()
    {
        var context = Evidence.Context(
            Evidence.Transcript(Evidence.Outcome(fields: Evidence.Fields(("routeConfidence", "0.5"))))
        );

        var result = await Evidence.Evaluate("expectedBehavior:fieldAtLeast/routeConfidence=0.5", context);

        result.Pass.Should().BeTrue();
    }

    [Theory]
    [InlineData("expectedBehavior:fieldAtLeast/routeConfidence=abc")]
    [InlineData("expectedBehavior:fieldAtLeast/routeConfidence=")]
    [InlineData("expectedBehavior:fieldAtLeast/routeConfidence=NaN")]
    [InlineData("expectedBehavior:fieldAtLeast/routeConfidence=Infinity")]
    [InlineData("expectedBehavior:fieldAtLeast/routeConfidence=-Infinity")]
    [InlineData("expectedBehavior:fieldAtLeast/routeConfidence")]
    [InlineData("expectedBehavior:fieldAtLeast/=0.4")]
    public async Task EvaluateAsync_MalformedThreshold_IsRefusedRatherThanGraded(string expression)
    {
        await Evidence.Refuses(expression, Evidence.Context());
    }

    // -------------------------------------------------------------------------------------
    // Malformed parameters generally.
    // -------------------------------------------------------------------------------------

    [Theory]
    [InlineData("expectedBehavior")]
    [InlineData("expectedBehavior:nope/x")]
    [InlineData("expectedBehavior:Outcome/x")]
    [InlineData("expectedBehavior:outcome")]
    [InlineData("expectedBehavior:outcome/")]
    [InlineData("expectedBehavior:field/escalateReason")]
    [InlineData("expectedBehavior:field/=value")]
    [InlineData("expectedBehavior:transport/statusCode")]
    [InlineData("expectedBehavior:transport/=429")]
    public async Task EvaluateAsync_MalformedParameter_IsRefused(string expression)
    {
        await Evidence.Refuses(expression, Evidence.Context());
    }

    [Fact]
    public async Task EvaluateAsync_FieldExpectingAnEmptyValue_IsRefusedRatherThanMatchingNothing()
    {
        await Evidence.Refuses("expectedBehavior:field/escalateReason=", Evidence.Context());
    }

    // -------------------------------------------------------------------------------------
    // ExaminedTurns.
    // -------------------------------------------------------------------------------------

    [Theory]
    [InlineData("expectedBehavior:outcome/resolved")]
    [InlineData("expectedBehavior:transport/statusCode=200")]
    public async Task EvaluateAsync_OutcomeOrTransportSelector_ExaminesTheTurnTheRunEndedOn(string expression)
    {
        var context = Evidence.Context(
            Evidence.Transcript(
                Evidence.Outcome(observedOutcome: "resolved"),
                [Evidence.Turn(1), Evidence.Turn(2), Evidence.Turn(3)],
                Evidence.Transport(("statusCode", "200"))
            )
        );

        var result = await Evidence.Evaluate(expression, context);

        result.Pass.Should().BeTrue();
        result.ExaminedTurns.Should().Equal(3);
    }

    [Fact]
    public async Task EvaluateAsync_TranscriptWithNoTurns_StillGradesTheOutcome()
    {
        var context = Evidence.Context(
            Evidence.Transcript(Evidence.Outcome(observedOutcome: "rate_limited"), turns: [])
        );

        var result = await Evidence.Evaluate("expectedBehavior:outcome/rate_limited", context);

        result.Pass.Should().BeTrue();
        result.ExaminedTurns.Should().BeEmpty();
    }

    // -------------------------------------------------------------------------------------
    // A conditional expectation is two data rows, not a conditional evaluator.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task EvaluateAsync_PathPreservedAlongsideARefusal_IsExpressibleAsTwoAssertions()
    {
        var context = Evidence.Context(
            Evidence.Transcript(Evidence.Outcome(observedOutcome: "escalated", observedPath: "triage/escalate"))
        );

        var refused = await Evidence.Evaluate("expectedBehavior:outcome/escalated", context);
        var preserved = await Evidence.Evaluate("structural:pathPresent", context);

        refused.Pass.Should().BeTrue();
        preserved.Pass.Should().BeTrue();
    }
}
