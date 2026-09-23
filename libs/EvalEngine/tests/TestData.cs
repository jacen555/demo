using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Tests;

internal static class TestData
{
    public static readonly DateTimeOffset FixedInstant = new(2026, 9, 22, 16, 43, 22, TimeSpan.Zero);

    public static Transcript Transcript(string scenarioId = "scenario-a") =>
        new()
        {
            ScenarioId = scenarioId,
            Seed = 4242,
            StartedAt = FixedInstant,
            Duration = TimeSpan.FromMilliseconds(1500),
            Turns =
            [
                new Turn
                {
                    Index = 1,
                    Stimulus = "opening stimulus",
                    Response = "a response",
                    Provenance = TurnProvenance.Scripted,
                    Elapsed = TimeSpan.FromMilliseconds(900),
                },
            ],
            Outcome = new Outcome
            {
                ObservedOutcome = "resolved",
                ObservedPath = "triage/resolve",
                Fields = new Dictionary<string, string?>(StringComparer.Ordinal)
                {
                    ["scope/confirm"] = "yes",
                    ["escalateReason"] = null,
                },
            },
            Transport = new TransportMetadata
            {
                Kind = "http",
                Endpoint = "https://localhost:5001/eval",
                Attributes = new Dictionary<string, string>(StringComparer.Ordinal) { ["statusCode"] = "200" },
            },
        };

    public static SuiteResult SuiteResult() =>
        new()
        {
            SuiteName = "regression-suite",
            SlicingDimensions = ["area", "risk"],
            Environment = new EvaluationEnvironment
            {
                Endpoint = "https://localhost:5001/eval",
                BaselineRef = "main@abc1234",
                Seed = 20260922,
                Timestamp = FixedInstant,
                HarnessConfig = new Dictionary<string, string>(StringComparer.Ordinal) { ["repetitions"] = "5" },
            },
            ScenarioResults =
            [
                new ScenarioResult
                {
                    ScenarioId = "scenario-a",
                    Kind = ScenarioKind.Llm,
                    RepetitionPolicyUsed = RepetitionPolicy.Repeat(5),
                    Tags = new Dictionary<string, string>(StringComparer.Ordinal)
                    {
                        ["area"] = "scope",
                        ["risk"] = "high",
                    },
                    Summary = new StatisticalSummary
                    {
                        N = 5,
                        PointEstimate = 0.8,
                        Dispersion = 0.4,
                    },
                    Runs =
                    [
                        new RunResult
                        {
                            Transcript = Transcript(),
                            Status = RunStatus.Pass,
                            AssertionResults =
                            [
                                new AssertionResult
                                {
                                    Spec = AssertionSpec.Parse("slotAbsent:scope/confirm"),
                                    Pass = true,
                                    Detail = "slot was absent as expected",
                                    ExaminedTurns = [1],
                                },
                            ],
                        },
                    ],
                },
            ],
        };
}
