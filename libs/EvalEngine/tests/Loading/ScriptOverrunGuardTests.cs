using System.Text.Json;
using FluentAssertions;
using Forge.EvalEngine.Loading;
using Forge.EvalEngine.Scenarios;

namespace Forge.EvalEngine.Tests.Loading;

/// <summary>
/// The script-overrun guard.
/// </summary>
/// <remarks>
/// Judging a turn the script does not drive measures the simulated caller rather than the system
/// under test. That produced a real misdiagnosis in the harness this design came from, so the
/// guard is enforced at load time — and, critically, it is enforced <b>by default</b>. The
/// failure mode being defended against is a suite author forgetting to say which turn an
/// assertion depends on, so protection that only engages once they remember would defend against
/// nothing.
/// </remarks>
public class ScriptOverrunGuardTests
{
    private const string OverrunCode = "scenario.assertion.scriptOverrun";
    private const string ScopeCode = "scenario.assertion.turnScopeRequired";
    private const string ExpectationCode = "scenario.grading.expectationScopeRequired";
    private const string CeilingCode = "scenario.terminalCondition.scriptOverrun";

    private static string Suite(
        string mode = "deterministic",
        string? opening = "opening stimulus",
        int scriptedTurns = 0,
        int? assertionTurn = null,
        string expression = "reachedDepth:5",
        int? maxTurns = null,
        bool? stopOnParticipantCompletion = null,
        string? expectedOutcome = null,
        string? expectedPath = null,
        bool includeAssertion = true
    )
    {
        var script = string.Join(", ", Enumerable.Range(1, scriptedTurns).Select(i => $"\"scripted line {i}\""));

        var terminalParts = new List<string>();
        if (maxTurns is int ceiling)
        {
            terminalParts.Add($"\"maxTurns\": {ceiling}");
        }

        if (stopOnParticipantCompletion is bool stop)
        {
            terminalParts.Add($"\"stopOnParticipantCompletion\": {(stop ? "true" : "false")}");
        }

        var terminal =
            terminalParts.Count == 0
                ? string.Empty
                : $", \"terminalCondition\": {{ {string.Join(", ", terminalParts)} }}";

        var openingJson = opening is null ? string.Empty : $"\"opening\": {JsonSerializer.Serialize(opening)}, ";
        var assertion = assertionTurn is int turn
            ? $$"""{ "expression": "{{expression}}", "turn": {{turn}} }"""
            : $"\"{expression}\"";

        var gradingParts = new List<string>();
        if (expectedOutcome is not null)
        {
            gradingParts.Add($"\"expectedOutcome\": {JsonSerializer.Serialize(expectedOutcome)}");
        }

        if (expectedPath is not null)
        {
            gradingParts.Add($"\"expectedPath\": {JsonSerializer.Serialize(expectedPath)}");
        }

        gradingParts.Add($"\"assertions\": [{(includeAssertion ? assertion : string.Empty)}]");
        var grading = string.Join(", ", gradingParts);

        return $$"""
            {
              "name": "guard",
              "schemaVersion": "1.0",
              "scenarios": [
                {
                  "identity": { "id": "overrun-probe", "kind": "llm" },
                  "execution": { "mode": "{{mode}}"{{terminal}} },
                  "simulation": { {{openingJson}}"scriptedAnswers": [{{script}}] },
                  "grading": { {{grading}} }
                }
              ]
            }
            """;
    }

    private static SuiteLoadResult Load(string json) => SuiteLoader.LoadFromJson(json, "guard.json");

    private static string Why(SuiteLoadResult result) => string.Join("; ", result.Messages);

    // ---------------------------------------------------------------------------------------
    // The budget is the number of script-driven turns, and the opening is the first of them.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public void LoadFromJson_OneTurnScenarioAssertingTurnOne_IsAcceptedBecauseTheOpeningIsTurnOne()
    {
        var result = Load(Suite(scriptedTurns: 0, assertionTurn: 1, expression: "statusIs:200"));

        result.Succeeded.Should().BeTrue(because: Why(result));
        result.Messages.Should().NotContain(m => m.Code == OverrunCode);
    }

    [Fact]
    public void LoadFromJson_AssertionOnTheLastScriptedTurn_IsAccepted()
    {
        var result = Load(Suite(scriptedTurns: 2, assertionTurn: 3));

        result.Succeeded.Should().BeTrue(because: Why(result));
    }

    [Fact]
    public void LoadFromJson_AssertionOneTurnPastTheBudget_ReportsAnError()
    {
        var result = Load(Suite(scriptedTurns: 2, assertionTurn: 4));

        result.Succeeded.Should().BeFalse();
        result
            .Messages.Should()
            .Contain(m =>
                m.Code == OverrunCode && m.Severity == ValidationSeverity.Error && m.ScenarioId == "overrun-probe"
            );
    }

    [Fact]
    public void LoadFromJson_NoOpening_CountsOnlyTheScriptedTurns()
    {
        Load(Suite(opening: null, scriptedTurns: 2, assertionTurn: 2)).Succeeded.Should().BeTrue();
        Load(Suite(opening: null, scriptedTurns: 2, assertionTurn: 3)).Succeeded.Should().BeFalse();
    }

    [Fact]
    public void LoadFromJson_AssertionPastTheBudget_ExplainsWhyItMatters()
    {
        var result = Load(Suite(scriptedTurns: 2, assertionTurn: 5));

        var message = result.Messages.Single(m => m.Code == OverrunCode);
        message.Message.Should().Contain("5").And.Contain("3").And.Contain("reachedDepth:5");
        message.ToString().Should().Contain("overrun-probe");
    }

    // ---------------------------------------------------------------------------------------
    // Protection is on by default: an assertion that does not say which turn it depends on is
    // refused whenever the run could reach a turn the script does not drive.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public void LoadFromJson_UnscopedAssertionWhereTheRunCanOutlastTheScript_ReportsAnError()
    {
        var result = Load(
            Suite(scriptedTurns: 1, assertionTurn: null, maxTurns: 8, stopOnParticipantCompletion: false)
        );

        result.Succeeded.Should().BeFalse();
        result
            .Messages.Should()
            .Contain(m =>
                m.Code == ScopeCode && m.Severity == ValidationSeverity.Error && m.ScenarioId == "overrun-probe"
            );
    }

    [Fact]
    public void LoadFromJson_UnscopedAssertionWithNoTurnCeiling_ReportsAnError()
    {
        var result = Load(Suite(scriptedTurns: 1, assertionTurn: null, stopOnParticipantCompletion: false));

        result.Succeeded.Should().BeFalse();
        result.Messages.Should().Contain(m => m.Code == ScopeCode);
    }

    [Fact]
    public void LoadFromJson_UnscopedAssertionWhereTheScriptBoundsTheRun_IsAccepted()
    {
        var result = Load(Suite(scriptedTurns: 1, assertionTurn: null));

        result.Succeeded.Should().BeTrue(because: Why(result));
        result.Messages.Should().NotContain(m => m.Code == ScopeCode);
    }

    [Fact]
    public void LoadFromJson_UnscopedAssertionWhereTheCeilingBoundsTheRunToTheScript_IsAccepted()
    {
        var result = Load(
            Suite(scriptedTurns: 1, assertionTurn: null, maxTurns: 2, stopOnParticipantCompletion: false)
        );

        result.Succeeded.Should().BeTrue(because: Why(result));
    }

    [Fact]
    public void LoadFromJson_UnscopedAssertionPastTheScript_NamesTheAssertionAndHowToFixIt()
    {
        var result = Load(Suite(scriptedTurns: 1, assertionTurn: null, stopOnParticipantCompletion: false));

        var message = result.Messages.Single(m => m.Code == ScopeCode);
        message.Message.Should().Contain("reachedDepth:5").And.Contain("turn");
    }

    // ---------------------------------------------------------------------------------------
    // expectedOutcome and expectedPath are grading dependencies too, and they carry no turn
    // scope at all. They judge the outcome the run ended on, so if the run can outlast the
    // script that outcome may have been produced by turns the script never drove — the same
    // misdiagnosis the assertion guard exists to prevent, with no way for the author to narrow
    // the claim. The only remedy is to bound the run, so the message says so.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public void LoadFromJson_ExpectedOutcomeWhereTheRunCanOutlastTheScript_ReportsAnError()
    {
        var result = Load(
            Suite(
                scriptedTurns: 1,
                includeAssertion: false,
                expectedOutcome: "resolved",
                maxTurns: 8,
                stopOnParticipantCompletion: false
            )
        );

        result.Succeeded.Should().BeFalse();
        result
            .Messages.Should()
            .Contain(m =>
                m.Code == ExpectationCode && m.Severity == ValidationSeverity.Error && m.ScenarioId == "overrun-probe"
            );
    }

    [Fact]
    public void LoadFromJson_ExpectedPathWhereTheRunCanOutlastTheScript_ReportsAnError()
    {
        var result = Load(
            Suite(
                scriptedTurns: 1,
                includeAssertion: false,
                expectedPath: "triage/resolve",
                stopOnParticipantCompletion: false
            )
        );

        result.Succeeded.Should().BeFalse();
        result.Messages.Should().Contain(m => m.Code == ExpectationCode);
    }

    [Fact]
    public void LoadFromJson_UnboundedRunWithBothExpectations_ReportsOneErrorPerField()
    {
        var result = Load(
            Suite(
                scriptedTurns: 1,
                includeAssertion: false,
                expectedOutcome: "resolved",
                expectedPath: "triage/resolve",
                stopOnParticipantCompletion: false
            )
        );

        var messages = result.Messages.Where(m => m.Code == ExpectationCode).ToList();
        messages.Should().HaveCount(2);
        messages.Should().Contain(m => m.Message.Contains("expectedOutcome", StringComparison.Ordinal));
        messages.Should().Contain(m => m.Message.Contains("expectedPath", StringComparison.Ordinal));
    }

    [Fact]
    public void LoadFromJson_ExpectationWhereTheScriptBoundsTheRun_IsAccepted()
    {
        var result = Load(Suite(scriptedTurns: 1, includeAssertion: false, expectedOutcome: "resolved"));

        result.Succeeded.Should().BeTrue(because: Why(result));
        result.Messages.Should().NotContain(m => m.Code == ExpectationCode);
    }

    [Fact]
    public void LoadFromJson_ExpectationWhereTheCeilingBoundsTheRunToTheScript_IsAccepted()
    {
        var result = Load(
            Suite(
                scriptedTurns: 1,
                includeAssertion: false,
                expectedOutcome: "resolved",
                maxTurns: 2,
                stopOnParticipantCompletion: false
            )
        );

        result.Succeeded.Should().BeTrue(because: Why(result));
    }

    [Theory]
    [InlineData("simulated")]
    [InlineData("live")]
    public void LoadFromJson_ExpectationUnderANonDeterministicCaller_IsNotFlagged(string mode)
    {
        var result = Load(
            Suite(mode: mode, scriptedTurns: 1, includeAssertion: false, expectedOutcome: "resolved", maxTurns: 8)
        );

        result.Messages.Should().NotContain(m => m.Code == ExpectationCode);
    }

    [Fact]
    public void LoadFromJson_UnscopedExpectationPastTheScript_NamesTheFieldAndHowToFixIt()
    {
        var result = Load(
            Suite(
                scriptedTurns: 1,
                includeAssertion: false,
                expectedOutcome: "resolved",
                stopOnParticipantCompletion: false
            )
        );

        var message = result.Messages.Single(m => m.Code == ExpectationCode);
        message.Message.Should().Contain("expectedOutcome").And.Contain("stopOnParticipantCompletion");
        message.ToString().Should().Contain("overrun-probe");
    }

    // ---------------------------------------------------------------------------------------
    // A blank expectation is not an absent one. Read as absent there is nothing to scope, so
    // the guard passes over it — while the loaded scenario goes on carrying it, and grading
    // then judges the run against an expectation nothing vetted. Blank is refused where it
    // arrives, the same rule a scripted stimulus already holds to, so that "declared" and
    // "absent" are the only two states anything downstream has to reason about.
    // ---------------------------------------------------------------------------------------

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("\t")]
    public void LoadFromJson_BlankExpectedOutcome_ReportsAnErrorRatherThanLoadingItUnscoped(string expectation)
    {
        var result = Load(
            Suite(
                scriptedTurns: 1,
                includeAssertion: false,
                expectedOutcome: expectation,
                stopOnParticipantCompletion: false
            )
        );

        result.Succeeded.Should().BeFalse();
        result.Messages.Should().Contain(m => m.Code == "scenario.malformed" && m.ScenarioId == "overrun-probe");
        result.Suite!.Scenarios.Should().BeEmpty();
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("\t")]
    public void LoadFromJson_BlankExpectedPath_ReportsAnErrorRatherThanLoadingItUnscoped(string expectation)
    {
        var result = Load(
            Suite(
                scriptedTurns: 1,
                includeAssertion: false,
                expectedPath: expectation,
                stopOnParticipantCompletion: false
            )
        );

        result.Succeeded.Should().BeFalse();
        result.Messages.Should().Contain(m => m.Code == "scenario.malformed" && m.ScenarioId == "overrun-probe");
        result.Suite!.Scenarios.Should().BeEmpty();
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Construct_BlankExpectedOutcome_ThrowsArgumentException(string expectation)
    {
        Action construct = () => _ = new Grading { ExpectedOutcome = expectation };

        construct.Should().Throw<ArgumentException>();
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Construct_BlankExpectedPath_ThrowsArgumentException(string expectation)
    {
        Action construct = () => _ = new Grading { ExpectedPath = expectation };

        construct.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void Construct_OmittedExpectations_AreStillAllowedToBeAbsent()
    {
        var grading = new Grading { ExpectedOutcome = null, ExpectedPath = null };

        grading.ExpectedOutcome.Should().BeNull();
        grading.ExpectedPath.Should().BeNull();
    }

    // ---------------------------------------------------------------------------------------
    // The guard is about the deterministic caller only.
    // ---------------------------------------------------------------------------------------

    [Theory]
    [InlineData("simulated")]
    [InlineData("live")]
    public void LoadFromJson_OverrunUnderANonDeterministicCaller_IsNotFlagged(string mode)
    {
        var result = Load(Suite(mode: mode, scriptedTurns: 2, assertionTurn: 5, maxTurns: 8));

        result.Messages.Should().NotContain(m => m.Code == OverrunCode || m.Code == ScopeCode);
        result.Succeeded.Should().BeTrue(because: Why(result));
    }

    [Theory]
    [InlineData("simulated")]
    [InlineData("live")]
    public void LoadFromJson_UnscopedAssertionUnderANonDeterministicCaller_IsNotFlagged(string mode)
    {
        var result = Load(Suite(mode: mode, scriptedTurns: 0, assertionTurn: null, maxTurns: 8));

        result.Messages.Should().NotContain(m => m.Code == ScopeCode);
    }

    // ---------------------------------------------------------------------------------------
    // A ceiling past the script is an authoring smell, not a provable hazard.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public void LoadFromJson_TurnCeilingBeyondTheScriptedBudget_ReportsAWarningNotAnError()
    {
        var result = Load(Suite(scriptedTurns: 2, assertionTurn: 2, maxTurns: 9));

        result.Succeeded.Should().BeTrue(because: Why(result));
        result
            .Messages.Should()
            .Contain(m =>
                m.Code == CeilingCode && m.Severity == ValidationSeverity.Warning && m.ScenarioId == "overrun-probe"
            );
    }

    [Fact]
    public void LoadFromJson_TurnCeilingWithinTheScriptedBudget_IsNotFlagged()
    {
        var result = Load(Suite(scriptedTurns: 2, assertionTurn: 2, maxTurns: 3));

        result.Messages.Should().NotContain(m => m.Code == CeilingCode);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void LoadFromJson_AssertionTurnNotPositive_ReportsAnError(int turn)
    {
        var result = Load(Suite(scriptedTurns: 1, assertionTurn: turn));

        result.Succeeded.Should().BeFalse();
        result.Messages.Should().Contain(m => m.ScenarioId == "overrun-probe");
    }
}
