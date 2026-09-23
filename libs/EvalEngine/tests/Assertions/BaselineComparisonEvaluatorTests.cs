using FluentAssertions;

namespace Forge.EvalEngine.Tests.Assertions;

/// <summary>
/// <c>baseline</c> — judged against the recorded run rather than against an absolute expectation.
/// </summary>
/// <remarks>
/// The comparator proper is a later task. What is settled here is the thing that cannot be
/// deferred: a missing or mis-joined baseline must not evaluate to a pass, and must not evaluate
/// to a regression either — nothing was compared, so neither verdict would be true.
/// </remarks>
public class BaselineComparisonEvaluatorTests
{
    // -------------------------------------------------------------------------------------
    // Matching and diverging against the recorded run.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task EvaluateAsync_OutcomeMatchesTheBaseline_Passes()
    {
        var result = await Evidence.Evaluate(
            "baseline:outcome",
            Evidence.Context(
                Evidence.Transcript(Evidence.Outcome(observedOutcome: "resolved")),
                baseline: Evidence.Transcript(Evidence.Outcome(observedOutcome: "resolved"))
            )
        );

        result.Pass.Should().BeTrue();
    }

    [Fact]
    public async Task EvaluateAsync_OutcomeDivergedFromTheBaseline_FailsAndReportsBothValues()
    {
        var result = await Evidence.Evaluate(
            "baseline:outcome",
            Evidence.Context(
                Evidence.Transcript(Evidence.Outcome(observedOutcome: "escalated")),
                baseline: Evidence.Transcript(Evidence.Outcome(observedOutcome: "resolved"))
            )
        );

        result.Pass.Should().BeFalse();
        result.Detail.Should().Contain("resolved").And.Contain("escalated");
    }

    [Fact]
    public async Task EvaluateAsync_PathMatchesTheBaseline_Passes()
    {
        var result = await Evidence.Evaluate(
            "baseline:path",
            Evidence.Context(
                Evidence.Transcript(Evidence.Outcome(observedPath: "triage/resolve")),
                baseline: Evidence.Transcript(Evidence.Outcome(observedPath: "triage/resolve"))
            )
        );

        result.Pass.Should().BeTrue();
    }

    [Fact]
    public async Task EvaluateAsync_PathDivergedFromTheBaseline_Fails()
    {
        var result = await Evidence.Evaluate(
            "baseline:path",
            Evidence.Context(
                Evidence.Transcript(Evidence.Outcome(observedPath: "triage/escalate")),
                baseline: Evidence.Transcript(Evidence.Outcome(observedPath: "triage/resolve"))
            )
        );

        result.Pass.Should().BeFalse();
    }

    [Fact]
    public async Task EvaluateAsync_BothOutcomesAbsent_CountsAsUnchanged()
    {
        var result = await Evidence.Evaluate(
            "baseline:outcome",
            Evidence.Context(
                Evidence.Transcript(Evidence.Outcome(observedOutcome: null)),
                baseline: Evidence.Transcript(Evidence.Outcome(observedOutcome: null))
            )
        );

        result.Pass.Should().BeTrue("nothing changed, which is what this assertion is about");
    }

    [Fact]
    public async Task EvaluateAsync_FieldsMatchTheBaseline_Passes()
    {
        var fields = Evidence.Fields(("scope/confirm", "yes"), ("escalateReason", null));

        var result = await Evidence.Evaluate(
            "baseline:fields",
            Evidence.Context(
                Evidence.Transcript(Evidence.Outcome(fields: fields)),
                baseline: Evidence.Transcript(
                    Evidence.Outcome(fields: Evidence.Fields(("scope/confirm", "yes"), ("escalateReason", null)))
                )
            )
        );

        result.Pass.Should().BeTrue();
    }

    [Fact]
    public async Task EvaluateAsync_FieldsGainedAValueSinceTheBaseline_Fails()
    {
        var result = await Evidence.Evaluate(
            "baseline:fields",
            Evidence.Context(
                Evidence.Transcript(Evidence.Outcome(fields: Evidence.Fields(("scope/confirm", "no")))),
                baseline: Evidence.Transcript(Evidence.Outcome(fields: Evidence.Fields(("scope/confirm", "yes"))))
            )
        );

        result.Pass.Should().BeFalse();
    }

    [Fact]
    public async Task EvaluateAsync_FieldsGainedAKeySinceTheBaseline_Fails()
    {
        var result = await Evidence.Evaluate(
            "baseline:fields",
            Evidence.Context(
                Evidence.Transcript(Evidence.Outcome(fields: Evidence.Fields(("a", "1"), ("b", "2")))),
                baseline: Evidence.Transcript(Evidence.Outcome(fields: Evidence.Fields(("a", "1"))))
            )
        );

        result.Pass.Should().BeFalse();
    }

    [Fact]
    public async Task EvaluateAsync_NegatedAndTheOutcomeDiverged_Passes()
    {
        var result = await Evidence.Evaluate(
            "!baseline:outcome",
            Evidence.Context(
                Evidence.Transcript(Evidence.Outcome(observedOutcome: "escalated")),
                baseline: Evidence.Transcript(Evidence.Outcome(observedOutcome: "resolved"))
            )
        );

        result.Pass.Should().BeTrue("asserting a deliberate, expected change is a real need");
    }

    // -------------------------------------------------------------------------------------
    // No baseline is neither a pass nor a regression.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task EvaluateAsync_NoBaselineAvailable_IsRefusedRatherThanPassed()
    {
        var exception = await Evidence.Refuses("baseline:outcome", Evidence.Context(baseline: null));

        exception.Message.Should().Contain("baseline");
    }

    [Fact]
    public async Task EvaluateAsync_NoBaselineAvailableAndNegated_IsStillRefused()
    {
        await Evidence.Refuses("!baseline:outcome", Evidence.Context(baseline: null));
    }

    [Fact]
    public async Task EvaluateAsync_BaselineIsForADifferentScenario_IsRefusedRatherThanCompared()
    {
        var exception = await Evidence.Refuses(
            "baseline:outcome",
            Evidence.Context(
                Evidence.Transcript(scenarioId: "scenario-a"),
                baseline: Evidence.Transcript(scenarioId: "scenario-b")
            )
        );

        exception
            .Message.Should()
            .Contain("scenario-b", "the id is the join key, so a mis-joined baseline compares two different things");
    }

    [Fact]
    public async Task EvaluateAsync_CandidateIsForADifferentScenario_IsRefusedRatherThanReportedUnchanged()
    {
        var exception = await Evidence.Refuses(
            "baseline:outcome",
            Evidence.Context(
                Evidence.Transcript(Evidence.Outcome(observedOutcome: "resolved"), scenarioId: "scenario-b"),
                baseline: Evidence.Transcript(Evidence.Outcome(observedOutcome: "resolved"), scenarioId: "scenario-a"),
                scenarioId: "scenario-a"
            )
        );

        exception
            .Message.Should()
            .Contain(
                "scenario-b",
                "a candidate from another scenario matching by coincidence is a confident verdict about two "
                    + "unrelated runs, exactly as a mis-joined baseline is"
            );
    }

    [Fact]
    public async Task EvaluateAsync_CandidateIsForADifferentScenarioAndNegated_IsStillRefused()
    {
        await Evidence.Refuses(
            "!baseline:fields",
            Evidence.Context(
                Evidence.Transcript(scenarioId: "scenario-b"),
                baseline: Evidence.Transcript(scenarioId: "scenario-a"),
                scenarioId: "scenario-a"
            )
        );
    }

    [Fact]
    public async Task EvaluateAsync_BothTranscriptsAgreeWithEachOtherButNotWithTheContext_IsRefused()
    {
        var exception = await Evidence.Refuses(
            "baseline:outcome",
            Evidence.Context(
                Evidence.Transcript(scenarioId: "scenario-b"),
                baseline: Evidence.Transcript(scenarioId: "scenario-b"),
                scenarioId: "scenario-a"
            )
        );

        exception
            .Message.Should()
            .Contain("scenario-a", "the run being judged is the context's, so both artifacts are joined against it");
    }

    [Theory]
    [InlineData("baseline:outcome")]
    [InlineData("baseline:path")]
    [InlineData("baseline:fields")]
    public async Task EvaluateAsync_CandidateIsForADifferentScenario_IsRefusedForEverySelector(string expression)
    {
        await Evidence.Refuses(
            expression,
            Evidence.Context(
                Evidence.Transcript(scenarioId: "scenario-b"),
                baseline: Evidence.Transcript(scenarioId: "scenario-a"),
                scenarioId: "scenario-a"
            )
        );
    }

    // -------------------------------------------------------------------------------------
    // ExaminedTurns are indices into the run being judged, not into the baseline.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task EvaluateAsync_Always_ExaminesTheTurnTheJudgedRunEndedOn()
    {
        var result = await Evidence.Evaluate(
            "baseline:outcome",
            Evidence.Context(Evidence.EndingOnSynthesizedTurn(), baseline: Evidence.OneTurn())
        );

        // Indices belong to the candidate run, which has three turns; the baseline's count is not ours.
        result.ExaminedTurns.Should().Equal(3);
    }

    // -------------------------------------------------------------------------------------
    // Malformed parameters.
    // -------------------------------------------------------------------------------------

    [Theory]
    [InlineData("baseline")]
    [InlineData("baseline:nope")]
    [InlineData("baseline:Outcome")]
    [InlineData("baseline:outcome/extra")]
    public async Task EvaluateAsync_UnrecognisedSelector_IsRefused(string expression)
    {
        await Evidence.Refuses(expression, Evidence.Context(baseline: Evidence.Transcript()));
    }
}
