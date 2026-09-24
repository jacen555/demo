using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Impact;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Tests.Impact;

/// <summary>
/// Material for the impact-selection tests.
/// </summary>
/// <remarks>
/// A baseline entry built here carries the <b>real</b>
/// <see cref="ScenarioFingerprint.Of(Scenario)"/> of the scenario it records, so a test that
/// wants the baseline and the suite to disagree about what a scenario asks has to say so
/// explicitly. A fixture that stamped a constant would let the fingerprint guard pass for the
/// wrong reason — it would never be exercised at all.
/// </remarks>
internal static class ImpactFixtures
{
    public const string SuiteName = "regression-suite";

    /// <summary>The one assertion <see cref="Declaring"/> grades on.</summary>
    /// <remarks>
    /// Declared rather than left empty so that the happy path exercises the coverage guard: a
    /// fixture whose scenarios assert nothing would satisfy "every declared assertion has a
    /// verdict" vacuously, and the guard would never be reached by the test that proves a
    /// scenario can still be skipped.
    /// </remarks>
    public const string DeclaredAssertion = "slotAbsent:scope/confirm";

    /// <summary>A scenario declaring the given impact globs and nothing else of interest.</summary>
    public static Scenario Declaring(string id, params string[] globs) =>
        new()
        {
            Identity = new ScenarioIdentity { Id = id, Kind = ScenarioKind.Rest },
            Execution = new Execution { Mode = ExecutionMode.Deterministic },
            Grading = new Grading { Assertions = [AssertionSpec.Parse(DeclaredAssertion)] },
            Selection = new Selection { ImpactGlobs = globs },
        };

    /// <summary>The same scenario, exercising a different kind of system under test.</summary>
    /// <remarks>
    /// <see cref="ScenarioFingerprint"/> covers execution, simulation, and grading — never
    /// <see cref="ScenarioIdentity"/>, where the kind lives — so two scenarios that differ only
    /// here carry the <b>same</b> fingerprint. That is what makes a kind change the one
    /// redefinition the fingerprint guard cannot see.
    /// </remarks>
    public static Scenario Conducting(Scenario scenario, ScenarioKind kind) =>
        scenario with
        {
            Identity = scenario.Identity with { Kind = kind },
        };

    /// <summary>The same scenario, grading on nothing at all.</summary>
    public static Scenario Ungraded(Scenario scenario) =>
        scenario with
        {
            Grading = scenario.Grading with { Assertions = [] },
        };

    /// <summary>The same scenario, but asking a different question of the system under test.</summary>
    /// <remarks>
    /// <see cref="ScenarioFingerprint"/> covers execution, simulation, and grading — never
    /// <see cref="Selection"/> — so this is how a test makes two definitions of one id diverge
    /// without touching the globs the selection is being made on.
    /// </remarks>
    public static Scenario Expecting(Scenario scenario, string expectedOutcome) =>
        scenario with
        {
            Grading = scenario.Grading with { ExpectedOutcome = expectedOutcome },
        };

    public static Suite SuiteOf(params Scenario[] scenarios) => new() { Name = SuiteName, Scenarios = scenarios };

    /// <summary>What a previous run recorded about one scenario.</summary>
    /// <param name="scenario">The scenario the entry is about; supplies the real fingerprint.</param>
    /// <param name="statuses">One verdict per repetition.</param>
    /// <param name="fingerprint">Overrides the real fingerprint. Pass null to record none.</param>
    /// <param name="recordFingerprint">False records no fingerprint at all.</param>
    /// <param name="transcriptScenarioId">Files the runs' transcripts under another scenario.</param>
    /// <param name="contradictAssertions">Records a pass beside an assertion verdict that failed.</param>
    /// <param name="declaredRepetitions">
    /// Overrides the repetition count the entry claims was applied, so it can disagree with the
    /// number of runs actually written under it.
    /// </param>
    /// <param name="recordVerdicts">False records the runs with no assertion verdicts at all.</param>
    /// <param name="verdictSpec">
    /// Records the verdicts against another assertion than the one the scenario declares.
    /// </param>
    public static ScenarioResult Recorded(
        Scenario scenario,
        RunStatus[]? statuses = null,
        string? fingerprint = null,
        bool recordFingerprint = true,
        string? transcriptScenarioId = null,
        bool contradictAssertions = false,
        int? declaredRepetitions = null,
        bool recordVerdicts = true,
        string? verdictSpec = null
    )
    {
        var verdicts = statuses ?? [RunStatus.Pass];
        var id = scenario.Identity.Id;

        return new ScenarioResult
        {
            ScenarioId = id,
            Kind = scenario.Identity.Kind,
            RepetitionPolicyUsed = RepetitionPolicy.Repeat(declaredRepetitions ?? Math.Max(1, verdicts.Length)),
            DefinitionFingerprint = recordFingerprint ? fingerprint ?? ScenarioFingerprint.Of(scenario) : null,
            Runs =
            [
                .. verdicts.Select(
                    (status, index) =>
                        new RunResult
                        {
                            Transcript = Transcript(transcriptScenarioId ?? id, 1000 + index),
                            Status = status,
                            ErrorDetail = status == RunStatus.Error ? "transport refused the connection" : null,
                            AssertionResults =
                                status == RunStatus.Error || !recordVerdicts
                                    ? []
                                    :
                                    [
                                        new AssertionResult
                                        {
                                            Spec = AssertionSpec.Parse(verdictSpec ?? DeclaredAssertion),
                                            Pass = !contradictAssertions && status == RunStatus.Pass,
                                        },
                                    ],
                        }
                ),
            ],
        };
    }

    public static SuiteResult Artifact(params ScenarioResult[] results) => Artifact(SuiteName, results);

    public static SuiteResult Artifact(string suiteName, params ScenarioResult[] results) =>
        new()
        {
            SuiteName = suiteName,
            ScenarioResults = results,
            SlicingDimensions = [],
            Environment = new EvaluationEnvironment { Seed = 20260922, Timestamp = TestData.FixedInstant },
        };

    public static Transcript Transcript(string scenarioId, long seed) =>
        new()
        {
            ScenarioId = scenarioId,
            Seed = seed,
            StartedAt = TestData.FixedInstant,
            Duration = TimeSpan.FromMilliseconds(1500),
            Turns =
            [
                new Turn
                {
                    Index = 1,
                    Stimulus = "opening stimulus",
                    Response = "a response",
                    Provenance = TurnProvenance.Scripted,
                },
            ],
            Outcome = new Outcome { ObservedOutcome = "resolved", ObservedPath = "triage/resolve" },
        };

    /// <summary>The entry for one scenario, or a failure naming what was selected instead.</summary>
    public static ScenarioSelection For(SelectionResult result, string scenarioId) =>
        result.Selected.SingleOrDefault(selection => selection.ScenarioId == scenarioId)
        ?? throw new InvalidOperationException(
            $"Scenario '{scenarioId}' was not selected. Selected: "
                + $"[{string.Join(", ", result.Selected.Select(s => $"{s.ScenarioId}={s.Reason}"))}]; "
                + $"skipped: [{string.Join(", ", result.Skipped)}]."
        );

    public static IEnumerable<SelectionReason> Reasons(SelectionResult result) =>
        result.Selected.Select(selection => selection.Reason);
}
