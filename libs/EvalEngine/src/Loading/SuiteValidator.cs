using System.Globalization;
using Forge.EvalEngine.Scenarios;

namespace Forge.EvalEngine.Loading;

/// <summary>
/// The suite-level rules that cannot be expressed as a type invariant.
/// </summary>
/// <remarks>
/// Single-value ranges are enforced by the types themselves — a
/// <see cref="RepetitionPolicy"/> cannot hold zero, a <see cref="TerminalCondition.MaxTurns"/>
/// cannot be negative. What is left here is everything that depends on more than one field, or on
/// more than one scenario.
/// </remarks>
internal static class SuiteValidator
{
    public static IReadOnlyList<ValidationMessage> Validate(IReadOnlyList<Scenario> scenarios)
    {
        var messages = new List<ValidationMessage>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var scenario in scenarios)
        {
            var id = scenario.Identity.Id;

            if (string.IsNullOrWhiteSpace(id))
            {
                messages.Add(
                    Error(
                        "scenario.id.missing",
                        id,
                        "A scenario must declare a non-empty id. The id is the join key against a "
                            + "baseline artifact, so a blank one makes the scenario impossible to compare."
                    )
                );
            }
            else if (!seen.Add(id))
            {
                messages.Add(
                    Error(
                        "scenario.id.duplicate",
                        id,
                        "more than one scenario declares this id, so results cannot be matched to a baseline unambiguously."
                    )
                );
            }

            ValidateStimulus(scenario, messages);
            ValidateScriptedBudget(scenario, messages);
        }

        return messages;
    }

    public static ValidationMessage Error(string code, string? scenarioId, string message) =>
        Create(ValidationSeverity.Error, code, scenarioId, message);

    public static ValidationMessage Warning(string code, string? scenarioId, string message) =>
        Create(ValidationSeverity.Warning, code, scenarioId, message);

    private static ValidationMessage Create(
        ValidationSeverity severity,
        string code,
        string? scenarioId,
        string message
    ) =>
        new()
        {
            Severity = severity,
            Code = code,
            ScenarioId = string.IsNullOrWhiteSpace(scenarioId) ? null : scenarioId,
            Message = message,
        };

    private static void ValidateStimulus(Scenario scenario, List<ValidationMessage> messages)
    {
        var id = scenario.Identity.Id;

        if (
            scenario.Execution.Mode == ExecutionMode.Deterministic
            && string.IsNullOrWhiteSpace(scenario.Simulation.Opening)
            && scenario.Simulation.ScriptedStimuli.Count == 0
        )
        {
            messages.Add(
                Error(
                    "scenario.deterministic.noStimulus",
                    id,
                    "deterministic execution replays scripted material, but this scenario declares "
                        + "neither an opening nor any scripted stimuli, so the participant has nothing to send."
                )
            );
        }

        if (scenario.Execution.Mode == ExecutionMode.Simulated && scenario.Execution.TerminalCondition.MaxTurns is null)
        {
            messages.Add(
                Warning(
                    "scenario.terminalCondition.unbounded",
                    id,
                    "a simulated caller with no turn ceiling can run indefinitely against a paid "
                        + "model. Set terminalCondition.maxTurns unless that is genuinely intended."
                )
            );
        }
    }

    /// <summary>
    /// The script-overrun guard.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Under a deterministic caller, only turns one through
    /// <see cref="Simulation.ScriptedTurnBudget"/> are driven by the script. An assertion judged
    /// against a later turn is judging a stimulus the simulated caller invented, so it measures
    /// the caller rather than the system under test. That is not a hypothetical: it caused a real
    /// misdiagnosis in the harness this design came from, which is why it is an error at load
    /// time rather than a comment in a README.
    /// </para>
    /// <para>
    /// <b>The guard is on by default.</b> The failure mode it defends against is a suite author
    /// not thinking about which turn an assertion lands on, so a guard that engaged only once
    /// they declared a turn would engage only for the authors who did not need it. An assertion
    /// that declares no turn is therefore read conservatively — as depending on the last turn the
    /// run could possibly reach — and refused unless the scenario is structurally incapable of
    /// reaching past its script. Declaring a turn is how an author narrows that claim.
    /// </para>
    /// <para>
    /// <see cref="Grading.ExpectedOutcome"/> and <see cref="Grading.ExpectedPath"/> are grading
    /// dependencies too, and they are read the same way. They judge the outcome the run ended on,
    /// so if the run can outlast the script that outcome may have been produced by turns the
    /// script never drove. Unlike an assertion they carry no turn of their own, so there is no
    /// narrower claim to declare — the only remedy is to bound the run.
    /// </para>
    /// </remarks>
    private static void ValidateScriptedBudget(Scenario scenario, List<ValidationMessage> messages)
    {
        if (scenario.Execution.Mode != ExecutionMode.Deterministic)
        {
            return;
        }

        var id = scenario.Identity.Id;
        var budget = scenario.Simulation.ScriptedTurnBudget;
        var budgetText = budget.ToString(CultureInfo.InvariantCulture);
        var reach = FurthestReachableTurn(scenario.Execution.TerminalCondition, budget);
        var scriptBoundsTheRun = reach is int bounded && bounded <= budget;

        if (!scriptBoundsTheRun)
        {
            ValidateExpectation(id, "expectedOutcome", scenario.Grading.ExpectedOutcome, reach, budgetText, messages);
            ValidateExpectation(id, "expectedPath", scenario.Grading.ExpectedPath, reach, budgetText, messages);
        }

        foreach (var assertion in scenario.Grading.Assertions)
        {
            if (assertion.TurnDependency is int turn)
            {
                if (turn > budget)
                {
                    messages.Add(
                        Error(
                            "scenario.assertion.scriptOverrun",
                            id,
                            $"assertion '{assertion.ToExpression()}' depends on turn "
                                + $"{turn.ToString(CultureInfo.InvariantCulture)}, but the script drives only "
                                + $"{budgetText} turn(s). Turns past the script are driven by the simulated caller, "
                                + "so this assertion would measure the caller rather than the system under test."
                        )
                    );
                }

                continue;
            }

            if (scriptBoundsTheRun)
            {
                continue;
            }

            messages.Add(
                Error(
                    "scenario.assertion.turnScopeRequired",
                    id,
                    $"assertion '{assertion.ToExpression()}' does not declare which turn it depends on, and this "
                        + $"scenario can reach {DescribeReach(reach)} while the script drives only {budgetText} "
                        + "turn(s). An assertion that lands past the script measures the simulated caller rather "
                        + "than the system under test, so declare the turn it depends on "
                        + "(\"turn\": <n>), lower terminalCondition.maxTurns to the scripted budget, or leave "
                        + "terminalCondition.stopOnParticipantCompletion enabled."
                )
            );
        }

        if (scenario.Execution.TerminalCondition.MaxTurns is int ceiling && ceiling > budget)
        {
            messages.Add(
                Warning(
                    "scenario.terminalCondition.scriptOverrun",
                    id,
                    $"the turn ceiling is {ceiling.ToString(CultureInfo.InvariantCulture)}, but the script drives "
                        + $"only {budgetText} turn(s). Either the ceiling is higher than this scenario needs, or "
                        + "turns past the script are expected — and those are not script-driven, so do not assert "
                        + "on them."
                )
            );
        }
    }

    /// <summary>
    /// Reports an expectation that judges an outcome the script may not have produced.
    /// </summary>
    private static void ValidateExpectation(
        string id,
        string field,
        string? expectation,
        int? reach,
        string budgetText,
        List<ValidationMessage> messages
    )
    {
        if (string.IsNullOrWhiteSpace(expectation))
        {
            return;
        }

        messages.Add(
            Error(
                "scenario.grading.expectationScopeRequired",
                id,
                $"grading.{field} judges the outcome the run ended on, and this scenario can reach "
                    + $"{DescribeReach(reach)} while the script drives only {budgetText} turn(s). An outcome "
                    + "reached past the script was produced by the simulated caller rather than by scripted "
                    + "material, and an expectation carries no turn of its own to narrow that claim. Bound the run "
                    + "instead: lower terminalCondition.maxTurns to the scripted budget, or leave "
                    + "terminalCondition.stopOnParticipantCompletion enabled."
            )
        );
    }

    /// <summary>
    /// The highest turn index the run could reach, or <see langword="null"/> when it is unbounded.
    /// </summary>
    /// <remarks>
    /// A deterministic participant signals completion once its script is exhausted, so
    /// <see cref="TerminalCondition.StopOnParticipantCompletion"/> genuinely bounds the run to the
    /// scripted budget. With that disabled, only an explicit ceiling bounds it — and if there is
    /// no ceiling either, nothing does.
    /// </remarks>
    private static int? FurthestReachableTurn(TerminalCondition condition, int budget)
    {
        if (!condition.StopOnParticipantCompletion)
        {
            return condition.MaxTurns;
        }

        return condition.MaxTurns is int ceiling ? Math.Min(budget, ceiling) : budget;
    }

    private static string DescribeReach(int? reach) =>
        reach is int bounded
            ? $"turn {bounded.ToString(CultureInfo.InvariantCulture)}"
            : "an unbounded number of turns";
}
