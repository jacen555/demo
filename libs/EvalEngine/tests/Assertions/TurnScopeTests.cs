using FluentAssertions;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Tests.Assertions;

/// <summary>
/// <see cref="Forge.EvalEngine.Assertions.AssertionSpec.TurnDependency"/> is a <b>scope</b>, and
/// an evaluator has to honour it.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="Forge.EvalEngine.Loading.SuiteLoader"/> refuses, at load time, an assertion whose
/// declared turn lands past the scripted budget — because a turn the script did not drive was
/// driven by the simulated caller, and an assertion resting on it measures the caller rather than
/// the system under test. That guard is worth nothing if the evaluator then reads every turn
/// anyway: an assertion declared for scripted turn 2 would still be able to pass on evidence from
/// synthesized turn 3, which is the exact false green the guard exists to prevent. Reporting that
/// turn in <see cref="Forge.EvalEngine.Assertions.AssertionResult.ExaminedTurns"/> documents the
/// problem; it does not fix it.
/// </para>
/// <para>
/// The declared turn is a <b>ceiling</b>, not a single turn — it is read the same way the loader
/// reads it, as the furthest turn the assertion depends on. An assertion that declares none
/// depends on every turn the run reached, which is why leaving it unset changes nothing here and
/// is not a way around the guard.
/// </para>
/// <para>
/// Two shapes of claim, two different treatments. A claim that <i>scans turns</i> is narrowed to
/// the turns in scope and then graded — absence of evidence within the scope is the system's
/// behaviour. A claim derived from the <i>run-level outcome</i> cannot be narrowed at all: a
/// transcript carries one outcome, attributed to the turn the run ended on, and it holds no
/// record of what it looked like earlier. Asking for the outcome as of turn 2 of a 3-turn run is
/// un-evaluable, so it is refused rather than silently widened to the final turn.
/// </para>
/// </remarks>
public class TurnScopeTests
{
    /// <summary>
    /// A run that continued past its script: turns 1 and 2 were scripted, turn 3 was invented by
    /// the simulated caller, and everything interesting happened on turn 3.
    /// </summary>
    private static Transcript RanPastItsScript() =>
        Evidence.Transcript(
            Evidence.Outcome(
                observedOutcome: "escalated",
                observedPath: "triage/handoff/escalate",
                fields: Evidence.Fields(("escalateReason", "out_of_scope"))
            ),
            [
                Evidence.Turn(1, stimulus: "scripted opening", response: "which scope?"),
                Evidence.Turn(2, stimulus: "scripted follow-up", response: "still unclear"),
                Evidence.Turn(
                    3,
                    stimulus: "invented follow-up",
                    response: "escalating to a human",
                    provenance: TurnProvenance.Synthesized
                ),
            ]
        );

    private const int LastScriptedTurn = 2;

    // -------------------------------------------------------------------------------------
    // Scans are restricted to the declared scope.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task EvaluateAsync_TokenAppearsOnlyPastTheDeclaredTurn_FailsRatherThanPassingOnCallerEvidence()
    {
        var result = await Evidence.Evaluate(
            "presence:response/escalating",
            Evidence.Context(RanPastItsScript()),
            turn: LastScriptedTurn
        );

        result
            .Pass.Should()
            .BeFalse("the token appears only on turn 3, which the simulated caller invented rather than the script");
        result.ExaminedTurns.Should().Equal([1, 2], "the scan must not reach past the declared turn");
    }

    [Fact]
    public async Task EvaluateAsync_StimulusAppearsOnlyPastTheDeclaredTurn_Fails()
    {
        var result = await Evidence.Evaluate(
            "presence:stimulus/invented",
            Evidence.Context(RanPastItsScript()),
            turn: LastScriptedTurn
        );

        result.Pass.Should().BeFalse();
        result.ExaminedTurns.Should().Equal(1, 2);
    }

    [Fact]
    public async Task EvaluateAsync_NegatedScanAndTheTokenAppearsOnlyPastTheDeclaredTurn_Passes()
    {
        var result = await Evidence.Evaluate(
            "!presence:response/escalating",
            Evidence.Context(RanPastItsScript()),
            turn: LastScriptedTurn
        );

        result.Pass.Should().BeTrue("through turn 2 the system genuinely never said it, which is the claim made");
    }

    [Fact]
    public async Task EvaluateAsync_TokenAppearsWithinTheDeclaredScope_StillPasses()
    {
        var result = await Evidence.Evaluate(
            "presence:response/still unclear",
            Evidence.Context(RanPastItsScript()),
            turn: LastScriptedTurn
        );

        result.Pass.Should().BeTrue();
        result.ExaminedTurns.Should().Equal(2);
    }

    [Fact]
    public async Task EvaluateAsync_AnyResponseWhenOnlyTheSynthesizedTurnResponded_Fails()
    {
        var transcript = Evidence.Transcript(
            turns:
            [
                Evidence.Turn(1, response: null),
                Evidence.Turn(2, response: "   "),
                Evidence.Turn(3, response: "at last", provenance: TurnProvenance.Synthesized),
            ]
        );

        var result = await Evidence.Evaluate("presence:anyResponse", Evidence.Context(transcript), turn: 2);

        result.Pass.Should().BeFalse("the system said nothing across the turns the script drove");
    }

    [Fact]
    public async Task EvaluateAsync_RepetitionOnlyCompletedPastTheDeclaredTurn_Fails()
    {
        var transcript = Evidence.Transcript(
            turns:
            [
                Evidence.Turn(1, response: "which scope?"),
                Evidence.Turn(2, response: "elsewhere"),
                Evidence.Turn(3, response: "which scope?", provenance: TurnProvenance.Synthesized),
            ]
        );

        var result = await Evidence.Evaluate("presence:repeatedResponse", Evidence.Context(transcript), turn: 2);

        result
            .Pass.Should()
            .BeFalse("the system only looked repetitive once the caller drove it there, which is not the claim");
    }

    [Fact]
    public async Task EvaluateAsync_TurnDepthCountingTurnsPastTheDeclaredTurn_CountsOnlyThoseInScope()
    {
        var result = await Evidence.Evaluate(
            "structural:turnDepth/3",
            Evidence.Context(RanPastItsScript()),
            turn: LastScriptedTurn
        );

        result.Pass.Should().BeFalse("only two turns are in scope, and depth reached past the script is the caller's");
        result.ExaminedTurns.Should().Equal(1, 2);
    }

    // -------------------------------------------------------------------------------------
    // An outcome-derived claim that cannot be judged from the declared scope is refused.
    // -------------------------------------------------------------------------------------

    [Theory]
    [InlineData("presence:field/escalateReason")]
    [InlineData("exactMatch:outcome")]
    [InlineData("exactMatch:path")]
    [InlineData("expectedBehavior:outcome/escalated")]
    [InlineData("expectedBehavior:field/escalateReason=out_of_scope")]
    [InlineData("expectedBehavior:transport/statusCode=200")]
    [InlineData("structural:pathPresent")]
    [InlineData("structural:pathDepth/3")]
    [InlineData("structural:levelsPopulated")]
    [InlineData("baseline:outcome")]
    [InlineData("baseline:fields")]
    public async Task EvaluateAsync_OutcomeDerivedClaimScopedBeforeTheRunEnded_IsRefusedRatherThanWidened(
        string expression
    )
    {
        var exception = await Evidence.Refuses(
            expression,
            Evidence.Context(
                RanPastItsScript(),
                grading: new Grading { ExpectedOutcome = "escalated", ExpectedPath = "triage/handoff/escalate" },
                baseline: RanPastItsScript()
            ),
            turn: LastScriptedTurn
        );

        exception.Message.Should().Contain("turn 3", "the reason is that the run outlasted the declared scope");
    }

    [Fact]
    public async Task EvaluateAsync_NegatedOutcomeDerivedClaimScopedBeforeTheRunEnded_IsStillRefused()
    {
        await Evidence.Refuses(
            "!presence:field/escalateReason",
            Evidence.Context(RanPastItsScript()),
            turn: LastScriptedTurn
        );
    }

    [Fact]
    public async Task EvaluateAsync_OutcomeDerivedClaimScopedToTheTurnTheRunEndedOn_IsGraded()
    {
        var result = await Evidence.Evaluate(
            "presence:field/escalateReason",
            Evidence.Context(RanPastItsScript()),
            turn: 3
        );

        result.Pass.Should().BeTrue("the whole run is within scope, so the outcome is the declared turn's outcome");
        result.ExaminedTurns.Should().Equal(3);
    }

    [Fact]
    public async Task EvaluateAsync_OutcomeDerivedClaimScopedPastTheEndOfTheRun_IsGraded()
    {
        var result = await Evidence.Evaluate(
            "presence:field/escalateReason",
            Evidence.Context(RanPastItsScript()),
            turn: 9
        );

        result.Pass.Should().BeTrue("no turn fell outside the declared scope, so nothing was widened");
    }

    [Fact]
    public async Task EvaluateAsync_OutcomeDerivedClaimOnATranscriptWithNoTurns_IsGraded()
    {
        var result = await Evidence.Evaluate(
            "presence:field/escalateReason",
            Evidence.Context(
                Evidence.Transcript(
                    Evidence.Outcome(fields: Evidence.Fields(("escalateReason", "out_of_scope"))),
                    turns: []
                )
            ),
            turn: 1
        );

        result.Pass.Should().BeTrue("there is no turn past the scope, so there is nothing the scope excludes");
        result.ExaminedTurns.Should().BeEmpty();
    }

    // -------------------------------------------------------------------------------------
    // A declared turn the run never reached is the system's behaviour, not the author's mistake.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task EvaluateAsync_ScanScopedToATurnTheRunNeverReached_IsGradedAgainstEveryTurnItDidReach()
    {
        var result = await Evidence.Evaluate(
            "presence:response/escalating",
            Evidence.Context(RanPastItsScript()),
            turn: 9
        );

        result.Pass.Should().BeTrue("the run ended early, which bounds the scan without invalidating it");
        result.ExaminedTurns.Should().Equal(3);
    }

    [Fact]
    public async Task EvaluateAsync_ScanScopedBeforeTheFirstRecordedTurn_FailsAndExaminesNothing()
    {
        var transcript = Evidence.Transcript(
            turns: [Evidence.Turn(5, response: "opening"), Evidence.Turn(6, response: "confirm")]
        );

        var result = await Evidence.Evaluate("presence:response/confirm", Evidence.Context(transcript), turn: 4);

        result.Pass.Should().BeFalse();
        result.ExaminedTurns.Should().BeEmpty();
    }

    // -------------------------------------------------------------------------------------
    // Declaring no turn is unchanged — the assertion depends on every turn the run reached.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task EvaluateAsync_ScanWithNoDeclaredTurn_StillReadsEveryTurn()
    {
        var result = await Evidence.Evaluate("presence:response/escalating", Evidence.Context(RanPastItsScript()));

        result.Pass.Should().BeTrue("an assertion that declares no turn depends on every turn the run reached");
        result.ExaminedTurns.Should().Equal(3);
    }

    [Fact]
    public async Task EvaluateAsync_OutcomeDerivedClaimWithNoDeclaredTurn_IsGraded()
    {
        var result = await Evidence.Evaluate("presence:field/escalateReason", Evidence.Context(RanPastItsScript()));

        result.Pass.Should().BeTrue();
    }
}
