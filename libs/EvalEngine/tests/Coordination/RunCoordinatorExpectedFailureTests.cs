using FluentAssertions;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Serialization;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Tests.Coordination;

/// <summary>
/// The failure carve-out: a known gap stated up front, so it does not read as a regression.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="RunStatus.ExpectedFailure"/> is read by the aggregator, the comparator, and the
/// selector, and until this it was written by nothing. A declared value with no producer is a
/// promise the library does not keep: a suite author has no way to say "this one is known to
/// fail", so every known gap arrives as an ordinary <see cref="RunStatus.Fail"/> and is
/// indistinguishable in the artifact from one the change just caused.
/// </para>
/// <para>
/// <b>The carve-out excuses a verdict, never the absence of one.</b> A run that gathered no
/// evidence stays <see cref="RunStatus.Error"/> — excusing it would be the exact shape this
/// library guards against everywhere else, an absence rendering as an accepted result. And a
/// carved-out scenario that <i>passes</i> is recorded as a pass, because a gap clearing is the
/// headline the harness exists to produce.
/// </para>
/// </remarks>
public sealed class RunCoordinatorExpectedFailureTests
{
    private const string Failing = "expectedBehavior:outcome/escalated";
    private const string Passing = "expectedBehavior:outcome/resolved";

    private static readonly ExpectedFailure KnownGap = new()
    {
        Reason = "the triage service does not escalate refunds yet; tracked as FORGE-214",
    };

    private static Task<SuiteResult> RunAsync(Scenario scenario) =>
        CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)])
            .RunAsync(CoordinatorFixtures.Suite(scenario), default);

    // -----------------------------------------------------------------------------------------
    // The producer.
    // -----------------------------------------------------------------------------------------

    [Fact]
    public async Task RunAsync_CarvedOutScenarioWhoseAssertionsDoNotHold_RecordsExpectedFailureRatherThanFail()
    {
        var result = await RunAsync(CoordinatorFixtures.Scenario(assertions: [Failing], expectedFailure: KnownGap));

        result.ScenarioResults.Single().Runs.Single().Status.Should().Be(RunStatus.ExpectedFailure);
    }

    [Fact]
    public async Task RunAsync_ScenarioWithNoCarveOutWhoseAssertionsDoNotHold_StillRecordsFail()
    {
        var result = await RunAsync(CoordinatorFixtures.Scenario(assertions: [Failing]));

        result.ScenarioResults.Single().Runs.Single().Status.Should().Be(RunStatus.Fail);
    }

    /// <summary>
    /// A gap that has cleared must be visible as a pass, not buried under its own carve-out.
    /// </summary>
    [Fact]
    public async Task RunAsync_CarvedOutScenarioThatNowPasses_RecordsPassSoTheClearedGapIsVisible()
    {
        var result = await RunAsync(CoordinatorFixtures.Scenario(assertions: [Passing], expectedFailure: KnownGap));

        result.ScenarioResults.Single().Runs.Single().Status.Should().Be(RunStatus.Pass);
    }

    /// <summary>
    /// A carve-out excuses a failure. It does not excuse a run that never happened.
    /// </summary>
    [Fact]
    public async Task RunAsync_CarvedOutScenarioThatCouldNotBeConducted_StaysErrorRatherThanBeingExcused()
    {
        var runner = new StubRunner(
            ScenarioKind.Rest,
            (scenario, context, _) =>
                Task.FromResult(
                    CoordinatorFixtures.Transcript(
                        scenario,
                        context,
                        exchange: ExchangeState.RequestFailed,
                        failure: "the transport refused the connection"
                    )
                )
        );

        var result = await CoordinatorFixtures
            .Coordinator([runner])
            .RunAsync(
                CoordinatorFixtures.Suite(
                    CoordinatorFixtures.Scenario(assertions: [Failing], expectedFailure: KnownGap)
                ),
                default
            );

        result.ScenarioResults.Single().Runs.Single().Status.Should().Be(RunStatus.Error);
    }

    /// <summary>
    /// An unregistered runner is not a known failure either.
    /// </summary>
    [Fact]
    public async Task RunAsync_CarvedOutScenarioWithNoRunnerRegistered_StaysErrorRatherThanBeingExcused()
    {
        var result = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Llm)])
            .RunAsync(
                CoordinatorFixtures.Suite(
                    CoordinatorFixtures.Scenario(assertions: [Failing], expectedFailure: KnownGap)
                ),
                default
            );

        result.ScenarioResults.Single().Runs.Single().Status.Should().Be(RunStatus.Error);
    }

    // -----------------------------------------------------------------------------------------
    // What the reader can see.
    // -----------------------------------------------------------------------------------------

    [Fact]
    public async Task RunAsync_CarvedOutScenario_RecordsTheCarveOutAndItsReasonInTheArtifact()
    {
        var result = await RunAsync(CoordinatorFixtures.Scenario(assertions: [Failing], expectedFailure: KnownGap));

        result.ScenarioResults.Single().ExpectedFailure.Should().NotBeNull().And.Be(KnownGap);
    }

    [Fact]
    public async Task RunAsync_ScenarioWithNoCarveOut_RecordsNoneInTheArtifact()
    {
        var result = await RunAsync(CoordinatorFixtures.Scenario(assertions: [Failing]));

        result.ScenarioResults.Single().ExpectedFailure.Should().BeNull();
    }

    [Fact]
    public async Task RunAsync_CarvedOutScenario_SurvivesCanonicalSerialization()
    {
        var result = await RunAsync(CoordinatorFixtures.Scenario(assertions: [Failing], expectedFailure: KnownGap));

        var read = CanonicalJson.DeserializeSuiteResult(CanonicalJson.Serialize(result));

        read.ScenarioResults.Single().ExpectedFailure!.Reason.Should().Be(KnownGap.Reason);
        read.ScenarioResults.Single().Runs.Single().Status.Should().Be(RunStatus.ExpectedFailure);
    }

    /// <summary>
    /// An artifact written before carve-outs existed still reads, and claims none.
    /// </summary>
    [Fact]
    public void DeserializeSuiteResult_ArtifactWithNoCarveOutField_ReadsWithNoneRatherThanFailing()
    {
        var json = """
            {
              "schemaVersion": "1.0",
              "suiteName": "regression-suite",
              "scenarioResults": [
                {
                  "scenarioId": "a",
                  "kind": "rest",
                  "repetitionPolicyUsed": { "repetitions": 1 },
                  "runs": []
                }
              ],
              "environment": { "seed": 1, "timestamp": "1970-01-01T00:00:00+00:00" }
            }
            """;

        CanonicalJson.DeserializeSuiteResult(json).ScenarioResults.Single().ExpectedFailure.Should().BeNull();
    }

    // -----------------------------------------------------------------------------------------
    // The boundary: this is suite-author text bound for a committed artifact (§V).
    // -----------------------------------------------------------------------------------------

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void ExpectedFailure_WithABlankReason_IsRefusedRatherThanStored(string reason)
    {
        var act = () => new ExpectedFailure { Reason = reason };

        act.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void ExpectedFailure_WithANullReason_IsRefused()
    {
        var act = () => new ExpectedFailure { Reason = null! };

        act.Should().Throw<ArgumentException>();
    }
}
