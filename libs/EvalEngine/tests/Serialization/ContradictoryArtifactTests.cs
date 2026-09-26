using FluentAssertions;
using Forge.EvalEngine.Baselines;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Serialization;
using Forge.EvalEngine.Statistics;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Tests.Serialization;

/// <summary>
/// The read door, and the public surfaces a decision-point check cannot stand in front of.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="Comparison.SuiteComparator"/> and <see cref="Impact.ImpactSelector"/> establish that
/// a recorded verdict is backed by evidence before they act on one. That protects the verdict
/// path and nothing else. A <see cref="SuiteResult"/> is also built in process and never
/// serialized, which is a reason to keep those checks — not a reason to leave file input
/// unvalidated. Every consumer that reads an artifact and counts its runs without going through
/// the comparator reads the contradiction as a pass.
/// </para>
/// <para>
/// Same argument for <see cref="ScenarioAggregator.Summarize(IReadOnlyList{RunResult})"/>: it is
/// a public method on a library, so its caller set is whatever the signature admits rather than
/// whatever calls it today.
/// </para>
/// </remarks>
public sealed class ContradictoryArtifactTests
{
    private static string Artifact(RunStatus status, string? exchange) =>
        CanonicalJson.Serialize(
            new SuiteResult
            {
                SuiteName = "regression",
                Environment = new EvaluationEnvironment { Seed = 1, Timestamp = DateTimeOffset.UnixEpoch },
                ScenarioResults =
                [
                    new ScenarioResult
                    {
                        ScenarioId = "refund-flow",
                        Kind = ScenarioKind.Rest,
                        RepetitionPolicyUsed = RepetitionPolicy.Once,
                        Runs = [Run(status, exchange)],
                    },
                ],
            }
        );

    private static RunResult Run(RunStatus status, string? exchange) =>
        new()
        {
            Status = status,
            Transcript = new Transcript
            {
                ScenarioId = "refund-flow",
                Seed = 7,
                StartedAt = DateTimeOffset.UnixEpoch,
                Outcome = new Outcome { ObservedOutcome = "resolved" },
                Transport = new TransportMetadata
                {
                    Attributes = exchange is null
                        ? new Dictionary<string, string>(StringComparer.Ordinal)
                        : new Dictionary<string, string>(StringComparer.Ordinal)
                        {
                            [TransportAttributes.Exchange] = exchange,
                        },
                },
            },
        };

    // -----------------------------------------------------------------------------------------
    // The read door.
    // -----------------------------------------------------------------------------------------

    [Theory]
    [InlineData(ExchangeState.RunnerFailed)]
    [InlineData(ExchangeState.Unsupported)]
    [InlineData(ExchangeState.TimedOut)]
    [InlineData(ExchangeState.RequestFailed)]
    [InlineData(ExchangeState.NotAttempted)]
    [InlineData(ExchangeState.ParticipantFailed)]
    [InlineData(ExchangeState.AdapterFailed)]
    public void DeserializeSuiteResult_PassBesideAnExchangeThatGatheredNothing_IsRefused(string exchange)
    {
        var read = () => CanonicalJson.DeserializeSuiteResult(Artifact(RunStatus.Pass, exchange));

        var thrown = read.Should().Throw<ContradictoryArtifactException>().Which;
        thrown.Field.Should().Be("runs");
        thrown.Position.Should().Contain("#1");
    }

    [Fact]
    public void DeserializeSuiteResult_PassWithNoExchangeStateRecorded_IsRefused()
    {
        var read = () => CanonicalJson.DeserializeSuiteResult(Artifact(RunStatus.Pass, exchange: null));

        read.Should().Throw<ContradictoryArtifactException>();
    }

    [Theory]
    [InlineData(RunStatus.Fail)]
    [InlineData(RunStatus.ExpectedFailure)]
    public void DeserializeSuiteResult_GradedNonPassBesideAnExchangeThatGatheredNothing_IsRefused(RunStatus status)
    {
        var read = () => CanonicalJson.DeserializeSuiteResult(Artifact(status, ExchangeState.RequestFailed));

        read.Should().Throw<ContradictoryArtifactException>();
    }

    [Fact]
    public void DeserializeSuiteResult_ErroredRunBesideAHarnessFailure_ReadsBecauseThatIsWhatAnErrorIs()
    {
        var artifact = CanonicalJson.DeserializeSuiteResult(Artifact(RunStatus.Error, ExchangeState.RunnerFailed));

        artifact.ScenarioResults.Single().Runs.Single().Status.Should().Be(RunStatus.Error);
    }

    [Theory]
    [InlineData(ExchangeState.Responded)]
    [InlineData(ExchangeState.MalformedResponse)]
    public void DeserializeSuiteResult_VerdictBesideAnExchangeThatGatheredEvidence_Reads(string exchange)
    {
        var artifact = CanonicalJson.DeserializeSuiteResult(Artifact(RunStatus.Pass, exchange));

        artifact.ScenarioResults.Single().Runs.Single().Status.Should().Be(RunStatus.Pass);
    }

    [Fact]
    public void DeserializeSuiteResult_RefusingAContradiction_RepeatsNoValueFromTheArtifact()
    {
        var read = () => CanonicalJson.DeserializeSuiteResult(Artifact(RunStatus.Pass, ExchangeState.RunnerFailed));

        read.Should().Throw<ContradictoryArtifactException>().Which.Message.Should().NotContain("refund-flow");
    }

    /// <summary>The baseline provider inherits the guard rather than restating it.</summary>
    [Fact]
    public async Task TryGetBaselineAsync_ContradictoryArtifact_ThrowsRatherThanYieldingABaseline()
    {
        var root = System.IO.Path.Combine(System.IO.Path.GetTempPath(), System.IO.Path.GetRandomFileName());
        System.IO.Directory.CreateDirectory(root);

        try
        {
            await System.IO.File.WriteAllTextAsync(
                System.IO.Path.Combine(root, "baseline.json"),
                Artifact(RunStatus.Pass, ExchangeState.RunnerFailed),
                CancellationToken.None
            );

            var load = () => new ArtifactBaseline(root).TryGetBaselineAsync("baseline.json", CancellationToken.None);

            await load.Should().ThrowAsync<ContradictoryArtifactException>();
        }
        finally
        {
            System.IO.Directory.Delete(root, recursive: true);
        }
    }

    // -----------------------------------------------------------------------------------------
    // The aggregator is a public method; its callers are whatever its signature admits.
    // -----------------------------------------------------------------------------------------

    [Fact]
    public void Summarize_PassBesideAnExchangeThatGatheredNothing_RefusesRatherThanReportingAPerfectRate()
    {
        var act = () => ScenarioAggregator.Default.Summarize([Run(RunStatus.Pass, ExchangeState.RunnerFailed)]);

        act.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void Summarize_PassWithNoExchangeStateRecorded_Refuses()
    {
        var act = () => ScenarioAggregator.Default.Summarize([Run(RunStatus.Pass, exchange: null)]);

        act.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void Summarize_ErroredRunBesideAHarnessFailure_IsStillConditionedOutRatherThanRefused()
    {
        ScenarioAggregator
            .Default.Summarize([
                Run(RunStatus.Error, ExchangeState.RunnerFailed),
                Run(RunStatus.Pass, ExchangeState.Responded),
            ])
            .Should()
            .NotBeNull()
            .And.Match<StatisticalSummary>(summary => summary.N == 1);
    }
}
