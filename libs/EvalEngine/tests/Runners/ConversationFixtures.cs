using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Runners;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Tests.Runners;

/// <summary>
/// A conversational adapter under the test's control. Nothing here is shipped: the library
/// deliberately has no default, because a payload shape is a property of the system under test.
/// </summary>
internal sealed class StubConversationExchange : IConversationExchange
{
    private readonly Func<ConversationStimulus, ConversationResponse?> _reply;

    public StubConversationExchange(Func<ConversationStimulus, ConversationResponse?>? reply = null) =>
        _reply = reply ?? (_ => new ConversationResponse { Text = "a response" });

    public List<ConversationStimulus> Seen { get; } = [];

    public string TransportKind { get; init; } = "http";

    public string? Endpoint { get; init; } = "https://localhost:5001/converse";

    /// <summary>Work performed before replying — used to cancel mid-turn.</summary>
    public Action<ConversationStimulus>? BeforeReplying { get; init; }

    /// <summary>An exception raised instead of replying.</summary>
    public Func<ConversationStimulus, Exception?>? Throws { get; init; }

    public Task<ConversationResponse> SendAsync(ConversationStimulus stimulus, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Seen.Add(stimulus);
        BeforeReplying?.Invoke(stimulus);
        cancellationToken.ThrowIfCancellationRequested();

        if (Throws?.Invoke(stimulus) is { } failure)
        {
            return Task.FromException<ConversationResponse>(failure);
        }

        return Task.FromResult(_reply(stimulus)!);
    }

    /// <summary>An adapter whose outcome is terminal only on the turn the run should end on.</summary>
    public static StubConversationExchange EndingOnTurn(int finalTurn) =>
        new(stimulus => new ConversationResponse
        {
            Text = $"response {stimulus.TurnIndex}",
            ObservedOutcome = stimulus.TurnIndex == finalTurn ? "resolved" : null,
            ObservedPath = "triage/resolve",
            Fields = new Dictionary<string, string?>(StringComparer.Ordinal) { ["scope/confirm"] = "yes" },
        });
}

/// <summary>A participant that always has something more to say. The cap is what stops it.</summary>
internal sealed class NeverCompletingParticipant(TurnProvenance provenance = TurnProvenance.Synthesized) : IParticipant
{
    public int Asks { get; private set; }

    public ValueTask<ParticipantTurn> NextAsync(Transcript transcriptSoFar, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(transcriptSoFar);
        Asks++;

        return new ValueTask<ParticipantTurn>(
            ParticipantTurn.Next($"stimulus {transcriptSoFar.Turns.Count + 1}", provenance)
        );
    }
}

/// <summary>A participant that fails rather than producing a stimulus.</summary>
internal sealed class FailingParticipant(Exception failure, int failOnAsk = 1) : IParticipant
{
    public int Asks { get; private set; }

    public ValueTask<ParticipantTurn> NextAsync(Transcript transcriptSoFar, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(transcriptSoFar);
        Asks++;

        return Asks >= failOnAsk
            ? throw failure
            : new ValueTask<ParticipantTurn>(
                ParticipantTurn.Next($"stimulus {transcriptSoFar.Turns.Count + 1}", TurnProvenance.Synthesized)
            );
    }
}

internal static class ConversationFixtures
{
    public static Scenario Scenario(
        string id = "scenario-a",
        int? maxTurns = null,
        bool stopOnTerminalOutcome = true,
        bool stopOnParticipantCompletion = true,
        ExecutionMode mode = ExecutionMode.Simulated,
        Simulation? simulation = null
    ) =>
        new()
        {
            Identity = new ScenarioIdentity { Id = id, Kind = ScenarioKind.Llm },
            Execution = new Execution
            {
                Mode = mode,
                TerminalCondition = new TerminalCondition
                {
                    MaxTurns = maxTurns,
                    StopOnTerminalOutcome = stopOnTerminalOutcome,
                    StopOnParticipantCompletion = stopOnParticipantCompletion,
                },
            },
            Simulation = simulation ?? new Simulation(),
        };

    public static LlmConversationRunner Runner(
        IConversationExchange exchange,
        IClock? clock = null,
        int maxTurnCeiling = LlmConversationRunnerOptions.DefaultMaxTurnCeiling,
        bool retainUnredactedEvidence = false
    ) =>
        new(
            exchange,
            clock ?? new FrozenClock(RunnerFixtures.Instant),
            new LlmConversationRunnerOptions
            {
                MaxTurnCeiling = maxTurnCeiling,
                RetainUnredactedEvidence = retainUnredactedEvidence,
            }
        );
}
