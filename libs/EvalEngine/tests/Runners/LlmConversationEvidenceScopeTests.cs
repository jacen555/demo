using FluentAssertions;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Llm;
using Forge.EvalEngine.Participants;
using Forge.EvalEngine.Runners;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Tests.Llm;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Tests.Runners;

/// <summary>
/// Evidence gathered on one turn must not survive into the record of another.
/// </summary>
/// <remarks>
/// This is the same defect class review has caught at four successive layers — T3's guard, T4's
/// evaluator scoping, T5's transcript derivation, T6's runner evidence. Every instance was
/// evidence from one context graded as though it came from another. A multi-turn runner is where
/// it is likeliest to recur, so the boundary is pinned here from the start rather than found in
/// review.
/// </remarks>
public sealed class LlmConversationEvidenceScopeTests
{
    private static Task<Transcript> Run(
        IConversationExchange exchange,
        IParticipant participant,
        int cap = 9,
        Scenario? scenario = null
    ) =>
        ConversationFixtures
            .Runner(exchange, maxTurnCeiling: cap)
            .RunAsync(scenario ?? ConversationFixtures.Scenario(), RunnerFixtures.Context(participant), default);

    /// <summary>
    /// The run ended on a turn that failed, so an earlier turn's outcome is not what the system
    /// ultimately did. Carrying it forward attributes a success to a failed turn.
    /// </summary>
    [Fact]
    public async Task RunAsync_FinalTurnFailsAfterASuccessfulOne_DoesNotCarryTheEarlierTurnsOutcome()
    {
        var exchange = new StubConversationExchange(stimulus =>
            stimulus.TurnIndex == 1
                ? new ConversationResponse
                {
                    Text = "a response",
                    ObservedOutcome = "resolved",
                    ObservedPath = "triage/resolve",
                    Fields = new Dictionary<string, string?>(StringComparer.Ordinal) { ["scope/confirm"] = "yes" },
                }
                : throw new MalformedResponseException("not the agreed shape")
        )
        {
            // The scenario must not stop on turn one's outcome, or turn two never happens.
        };

        var transcript = await Run(
            exchange,
            new ScriptedParticipant("one", "two"),
            scenario: ConversationFixtures.Scenario(stopOnTerminalOutcome: false)
        );

        transcript.Outcome.ObservedOutcome.Should().BeNull();
        transcript.Outcome.ObservedPath.Should().BeNull();
        transcript.Outcome.Fields.Should().BeEmpty();
    }

    /// <summary>
    /// The grading consequence, stated as a suite author would meet it: a scenario expecting
    /// <c>triage/resolve</c> must not pass on a run whose final turn the adapter rejected.
    /// </summary>
    [Fact]
    public async Task RunAsync_FinalTurnFailsAfterASuccessfulOne_DoesNotLetTheEarlierPathPassGrading()
    {
        var exchange = new StubConversationExchange(stimulus =>
            stimulus.TurnIndex == 1
                ? new ConversationResponse { Text = "a response", ObservedPath = "triage/resolve" }
                : throw new MalformedResponseException("not the agreed shape")
        );

        var transcript = await Run(
            exchange,
            new ScriptedParticipant("one", "two"),
            scenario: ConversationFixtures.Scenario(stopOnTerminalOutcome: false)
        );

        var verdict = await AssertionEvaluatorRegistry
            .CreateDefault()
            .EvaluateAsync(
                AssertionSpec.Parse("exactMatch:path"),
                new EvaluationContext
                {
                    ScenarioId = "scenario-a",
                    Grading = new Grading { ExpectedPath = "triage/resolve" },
                    Transcript = transcript,
                },
                default
            );

        verdict.Pass.Should().BeFalse(because: "the path was observed on a turn the run did not end on");
    }

    /// <summary>
    /// Run-level transport attributes describe the final turn. A key the final turn did not supply
    /// must not still be assertable from an earlier one.
    /// </summary>
    [Fact]
    public async Task RunAsync_FinalTurnOmitsAnAttributeAnEarlierTurnSupplied_DoesNotRetainTheStaleValue()
    {
        var exchange = new StubConversationExchange(stimulus => new ConversationResponse
        {
            Text = "a response",
            Attributes =
                stimulus.TurnIndex == 1
                    ? new Dictionary<string, string>(StringComparer.Ordinal) { ["retryAfter"] = "30" }
                    : new Dictionary<string, string>(StringComparer.Ordinal),
        });

        var transcript = await Run(exchange, new ScriptedParticipant("one", "two"));

        transcript.Transport.Attributes.Should().NotContainKey("retryAfter");
    }

    /// <summary>
    /// The same rule for structured fields: a field the final response omitted must not stay
    /// assertable from a response two turns back.
    /// </summary>
    [Fact]
    public async Task RunAsync_FinalTurnOmitsAFieldAnEarlierTurnSupplied_DoesNotRetainTheStaleField()
    {
        var exchange = new StubConversationExchange(stimulus => new ConversationResponse
        {
            Text = "a response",
            Fields =
                stimulus.TurnIndex == 1
                    ? new Dictionary<string, string?>(StringComparer.Ordinal) { ["scope/confirm"] = "yes" }
                    : new Dictionary<string, string?>(StringComparer.Ordinal),
        });

        var transcript = await Run(exchange, new ScriptedParticipant("one", "two"));

        transcript.Outcome.Fields.Should().NotContainKey("scope/confirm");
    }

    /// <summary>
    /// An earlier turn's outcome survives a participant failure, because the run genuinely ended
    /// on that turn — but the run is recorded as a harness failure, so nothing downstream may
    /// grade it. Both halves matter: the evidence is honest and it is not gradeable.
    /// </summary>
    [Fact]
    public async Task RunAsync_ParticipantFailsAfterASuccessfulTurn_RecordsAHarnessFailureSoTheOutcomeIsNotGradeable()
    {
        var exchange = new StubConversationExchange(_ => new ConversationResponse
        {
            Text = "a response",
            ObservedOutcome = "resolved",
        });

        var transcript = await Run(
            exchange,
            new FailingParticipant(new InvalidOperationException("the model said nothing usable"), failOnAsk: 2),
            scenario: ConversationFixtures.Scenario(stopOnTerminalOutcome: false)
        );

        transcript.Turns.Should().ContainSingle();
        ExchangeState.IsHarnessFailure(ExchangeState.Of(transcript)).Should().BeTrue();
    }

    [Fact]
    public async Task RunAsync_SeveralTurns_NumbersThemFromOneInOrder()
    {
        var exchange = new StubConversationExchange();

        var transcript = await Run(exchange, new ScriptedParticipant("one", "two", "three"));

        transcript.Turns.Select(turn => turn.Index).Should().Equal(1, 2, 3);
        transcript.Turns.Select(turn => turn.Stimulus).Should().Equal("one", "two", "three");
        exchange.Seen.Select(seen => seen.TurnIndex).Should().Equal(1, 2, 3);
    }

    /// <summary>The runner records the provenance the participant declared, and never rewrites it.</summary>
    [Theory]
    [InlineData(TurnProvenance.Synthesized)]
    [InlineData(TurnProvenance.Live)]
    [InlineData(TurnProvenance.Scripted)]
    public async Task RunAsync_ParticipantDeclaresAProvenance_RecordsExactlyThat(TurnProvenance provenance)
    {
        var transcript = await Run(new StubConversationExchange(), new NeverCompletingParticipant(provenance), cap: 3);

        transcript.Turns.Should().OnlyContain(turn => turn.Provenance == provenance);
    }

    // ---- The participant must match the scenario it is driving -------------------------------

    /// <summary>
    /// T7 finding 1, and the same false-green class one seam further out. The runner checked the
    /// scenario's <i>kind</i> but never that the participant it was handed matched the scenario's
    /// <see cref="ExecutionMode"/>. A <see cref="ExecutionMode.Deterministic"/> scenario is
    /// approved by the suite loader as bounded by its script; running it with a model-backed
    /// caller leaves that approval resting on a fiction, and every unscoped assertion then grades
    /// model-generated turns.
    /// </summary>
    [Fact]
    public async Task RunAsync_DeterministicScenarioDrivenByTheModelBackedCaller_ThrowsArgumentException()
    {
        var simulation = new Simulation { Opening = "my order has not arrived", Facts = ["order A-4471"] };
        var caller = new LlmCaller(new StubLlmClient("where is my order?"), simulation, ExecutionMode.Simulated);

        var run = async () =>
            await Run(
                new StubConversationExchange(),
                caller,
                scenario: ConversationFixtures.Scenario(mode: ExecutionMode.Deterministic, simulation: simulation)
            );

        await run.Should().ThrowAsync<ArgumentException>();
    }

    /// <summary>
    /// The same check, for the caller that <i>can</i> serve a deterministic scenario but was not
    /// built to. Mis-wiring is a harness fault affecting every run of the scenario, so it is
    /// surfaced rather than recorded as one run's outcome — exactly as a mis-routed kind is.
    /// </summary>
    [Fact]
    public async Task RunAsync_DeterministicScenarioDrivenByACallerBuiltForAnotherMode_ThrowsArgumentException()
    {
        var simulation = new Simulation { Opening = "the opening" };

        var run = async () =>
            await Run(
                new StubConversationExchange(),
                new DeterministicCaller(simulation, ExecutionMode.Simulated),
                scenario: ConversationFixtures.Scenario(mode: ExecutionMode.Deterministic, simulation: simulation)
            );

        await run.Should().ThrowAsync<ArgumentException>();
    }

    /// <summary>
    /// The legitimate path, pinned so the guards above cannot be satisfied by refusing everything.
    /// </summary>
    [Fact]
    public async Task RunAsync_DeterministicScenarioDrivenByItsOwnScript_RecordsEveryTurnAsScripted()
    {
        var simulation = new Simulation
        {
            Opening = "the opening",
            ScriptedStimuli = [new ScriptedStimulus { Text = "the second line" }],
        };

        var transcript = await Run(
            new StubConversationExchange(),
            new DeterministicCaller(simulation, ExecutionMode.Deterministic),
            scenario: ConversationFixtures.Scenario(
                mode: ExecutionMode.Deterministic,
                simulation: simulation,
                stopOnTerminalOutcome: false
            )
        );

        transcript.Turns.Select(turn => turn.Stimulus).Should().Equal("the opening", "the second line");
        transcript.Turns.Should().OnlyContain(turn => turn.Provenance == TurnProvenance.Scripted);
        ExchangeState.Of(transcript).Should().Be(ExchangeState.Responded);
    }

    /// <summary>
    /// A participant that declares no mode escapes the binding check above, so the turns
    /// themselves are checked against the script inside the window the loader approved. A
    /// synthesized turn there is evidence the guard never covered.
    /// </summary>
    [Fact]
    public async Task RunAsync_DeterministicScenarioWhoseParticipantSynthesizesInsideTheScript_RecordsParticipantFailed()
    {
        var transcript = await Run(
            new StubConversationExchange(),
            new NeverCompletingParticipant(TurnProvenance.Synthesized),
            scenario: ConversationFixtures.Scenario(
                mode: ExecutionMode.Deterministic,
                simulation: new Simulation { Opening = "the opening" }
            )
        );

        transcript.Turns.Should().BeEmpty(because: "nothing was sent — the stimulus was refused before the wire");
        ExchangeState.Of(transcript).Should().Be(ExchangeState.ParticipantFailed);
        ExchangeState.IsHarnessFailure(ExchangeState.Of(transcript)).Should().BeTrue();
        RunnerFixtures.Attribute(transcript, TransportAttributes.StoppedBy).Should().Be(StopReason.ParticipantFailed);
    }

    /// <summary>
    /// <see cref="TurnProvenance.Scripted"/> means <i>replayed verbatim from the suite file</i>.
    /// A participant replaying something else while wearing that tag is the same fiction, stated
    /// in the one place the tag can still be checked against the file.
    /// </summary>
    [Fact]
    public async Task RunAsync_DeterministicScenarioWhoseParticipantReplaysAnotherLine_RecordsParticipantFailed()
    {
        var transcript = await Run(
            new StubConversationExchange(),
            new ScriptedParticipant("a line the suite file never declared"),
            scenario: ConversationFixtures.Scenario(
                mode: ExecutionMode.Deterministic,
                simulation: new Simulation { Opening = "the opening" }
            )
        );

        transcript.Turns.Should().BeEmpty();
        ExchangeState.Of(transcript).Should().Be(ExchangeState.ParticipantFailed);
    }

    /// <summary>
    /// Past the scripted budget there is no suite-file material left to have been replayed, so a
    /// turn still claiming to be scripted widens the very window the guard defends.
    /// </summary>
    [Fact]
    public async Task RunAsync_DeterministicScenarioWhoseParticipantScriptsPastTheBudget_RecordsParticipantFailed()
    {
        var transcript = await Run(
            new StubConversationExchange(),
            new ScriptedParticipant("the opening", "a line past the script"),
            cap: 4,
            scenario: ConversationFixtures.Scenario(
                mode: ExecutionMode.Deterministic,
                simulation: new Simulation { Opening = "the opening" },
                stopOnTerminalOutcome: false
            )
        );

        transcript.Turns.Should().ContainSingle(because: "turn one was scripted; turn two was refused");
        ExchangeState.Of(transcript).Should().Be(ExchangeState.ParticipantFailed);
        RunnerFixtures.Attribute(transcript, TransportAttributes.StoppedBy).Should().Be(StopReason.ParticipantFailed);
    }

    /// <summary>
    /// The refused stimulus is never recorded as a <see cref="Turn"/>, so the failure message is
    /// the only thing that could carry it — and a transcript is committed. Text of unknown
    /// provenance is therefore withheld by default, exactly as an exception message is (§V); what
    /// is always recorded is which of the script's three claims the turn broke.
    /// </summary>
    [Fact]
    public async Task RunAsync_ScriptMismatchWithRetentionOff_WithholdsTheOfferedStimulus()
    {
        var transcript = await Run(
            new StubConversationExchange(),
            new ScriptedParticipant("a line the suite file never declared"),
            scenario: ConversationFixtures.Scenario(
                mode: ExecutionMode.Deterministic,
                simulation: new Simulation { Opening = "the opening" }
            )
        );

        var failure = RunnerFixtures.Attribute(transcript, TransportAttributes.Failure);

        failure.Should().NotContain("a line the suite file never declared");
        failure.Should().Contain("stimulusNotTheScriptedLine", because: "the classification is always recordable");
    }

    [Fact]
    public async Task RunAsync_ScriptMismatchWithRetentionOn_RecordsTheOfferedStimulus()
    {
        var transcript = await ConversationFixtures
            .Runner(new StubConversationExchange(), retainUnredactedEvidence: true)
            .RunAsync(
                ConversationFixtures.Scenario(
                    mode: ExecutionMode.Deterministic,
                    simulation: new Simulation { Opening = "the opening" }
                ),
                RunnerFixtures.Context(new ScriptedParticipant("a line the suite file never declared")),
                default
            );

        RunnerFixtures
            .Attribute(transcript, TransportAttributes.Failure)
            .Should()
            .Contain("a line the suite file never declared");
    }

    // ---- What reaches a committed artifact: the endpoint (§V) --------------------------------

    /// <summary>
    /// T7 finding 4, which is T6's finding 4 left unapplied here: the adapter's address was copied
    /// verbatim into a committed transcript. <see cref="RestRunner"/> strips the components of a
    /// URI that carry credentials; this runner now uses the same implementation rather than a
    /// second opinion.
    /// </summary>
    [Fact]
    public async Task RunAsync_AdapterEndpointCarryingCredentials_RecordsItWithoutThem()
    {
        var transcript = await Run(
            new StubConversationExchange
            {
                Endpoint = "https://evaluser:s3cr3t@localhost:5001/converse?api_key=s3cr3t#access_token=s3cr3t",
            },
            new ScriptedParticipant("one")
        );

        transcript.Transport.Endpoint.Should().Be("https://localhost:5001/converse?[redacted]#[redacted]");
    }

    /// <summary>
    /// An adapter need not report an address that parses into components at all. One that does not
    /// cannot be stripped component-wise, so it is recorded only when it carries none of the
    /// characters that delimit a credential-bearing part.
    /// </summary>
    [Fact]
    public async Task RunAsync_AdapterEndpointWithNoAddressableComponents_RedactsItWhenItCouldCarryACredential()
    {
        var transcript = await Run(
            new StubConversationExchange { Endpoint = "agent:s3cr3t@in-process-agent" },
            new ScriptedParticipant("one")
        );

        transcript.Transport.Endpoint.Should().NotContain("s3cr3t");
    }

    [Fact]
    public async Task RunAsync_PlainAdapterEndpoint_IsRecordedUnchanged()
    {
        var transcript = await Run(
            new StubConversationExchange { Endpoint = "inproc:agent-under-test" },
            new ScriptedParticipant("one")
        );

        transcript.Transport.Endpoint.Should().Be("inproc:agent-under-test");
    }

    /// <summary>
    /// Retention governs bodies and messages, never the endpoint. A credential in an address is a
    /// credential whatever a caller has opted into.
    /// </summary>
    [Fact]
    public async Task RunAsync_AdapterEndpointWithRetentionOn_IsStillRedacted()
    {
        var transcript = await ConversationFixtures
            .Runner(
                new StubConversationExchange { Endpoint = "https://evaluser:s3cr3t@localhost:5001/converse" },
                retainUnredactedEvidence: true
            )
            .RunAsync(ConversationFixtures.Scenario(), RunnerFixtures.Context(new ScriptedParticipant("one")), default);

        transcript.Transport.Endpoint.Should().Be("https://localhost:5001/converse");
    }

    // ---- End-to-end provenance, with the real caller ------------------------------------------

    /// <summary>
    /// The T5 defect, one layer up and end to end: a run driven by the real model-backed caller
    /// must never tag a <i>model-generated</i> turn <see cref="TurnProvenance.Scripted"/>. T3's
    /// load-time approval of unscoped assertions rests on that tag meaning "replayed verbatim from
    /// the suite file", and a model-generated turn wearing it would make the approval a fiction.
    /// The scenario's authored opening is the one turn that genuinely was replayed verbatim, and
    /// it is the only one tagged that way.
    /// </summary>
    [Fact]
    public async Task RunAsync_DrivenByTheModelBackedCaller_ReplaysTheOpeningThenTagsEveryTurnSynthesized()
    {
        var caller = new LlmCaller(
            new StubLlmClient("where is my order?"),
            new Simulation { Opening = "my order has not arrived", Facts = ["order A-4471"] },
            ExecutionMode.Simulated
        );

        var transcript = await Run(new StubConversationExchange(), caller, cap: 4);

        transcript.Turns.Should().HaveCount(4);
        transcript.Turns[0].Stimulus.Should().Be("my order has not arrived");
        transcript.Turns[0].Provenance.Should().Be(TurnProvenance.Scripted);
        transcript
            .Turns.Skip(1)
            .Should()
            .OnlyContain(turn => turn.Provenance == TurnProvenance.Synthesized)
            .And.OnlyContain(turn => turn.Stimulus == "where is my order?");
    }

    /// <summary>
    /// A model-backed caller cannot be tagged <see cref="TurnProvenance.Live"/> by being handed
    /// <see cref="ExecutionMode.Live"/>, because it cannot be built for that mode at all. Both
    /// that mode and that provenance mean a real external caller.
    /// </summary>
    [Fact]
    public void Constructing_TheModelBackedCallerForLiveExecution_IsRefused()
    {
        Action build = () =>
            _ = new LlmCaller(new StubLlmClient("x"), new Simulation { Facts = ["order A-4471"] }, ExecutionMode.Live);

        build.Should().Throw<ArgumentOutOfRangeException>();
    }

    /// <summary>
    /// The whole delivery, driven end to end by the replaying client: the same recordings produce
    /// the same transcript, byte for byte, across independent runs. That is what makes a
    /// model-driven scenario usable in a regression suite at all. Turn one is the authored
    /// opening, so the model is asked only for what follows it.
    /// </summary>
    [Fact]
    public async Task RunAsync_DrivenByRecordedCompletions_ProducesTheSameTranscriptEveryRun()
    {
        var simulation = new Simulation { Opening = "my order has not arrived", Facts = ["order A-4471"] };

        async Task<Transcript> Once()
        {
            var probe = new LlmCaller(new StubLlmClient("probe"), simulation, ExecutionMode.Simulated);
            var client = new RecordedLlmClient([
                new LlmRecording
                {
                    Prompt = probe.Instruction,
                    Context = ["caller: my order has not arrived", "system: response 1"],
                    Completion = "it is A-4471",
                },
            ]);

            return await Run(
                new StubConversationExchange(stimulus => new ConversationResponse
                {
                    Text = $"response {stimulus.TurnIndex}",
                }),
                new LlmCaller(client, simulation, ExecutionMode.Simulated),
                cap: 2
            );
        }

        var first = await Once();
        var second = await Once();

        first.Should().Be(second);
        first.Turns.Select(turn => turn.Stimulus).Should().Equal("my order has not arrived", "it is A-4471");
    }

    /// <summary>
    /// The reviewer's probe, end to end: the replaying client has nothing for the request the
    /// caller builds, so the caller fails and the run is recorded as ungradeable rather than
    /// quietly ending as though the conversation had finished.
    /// </summary>
    [Fact]
    public async Task RunAsync_ReplayingClientRunsOutOfRecordings_RecordsParticipantFailedRatherThanACleanEnd()
    {
        var simulation = new Simulation { Opening = "my order has not arrived", Facts = ["order A-4471"] };
        var probe = new LlmCaller(new StubLlmClient("probe"), simulation, ExecutionMode.Simulated);
        var client = new RecordedLlmClient([
            new LlmRecording { Prompt = probe.Instruction, Completion = "where is my order?" },
        ]);

        var transcript = await Run(
            new StubConversationExchange(),
            new LlmCaller(client, simulation, ExecutionMode.Simulated),
            cap: 4
        );

        transcript.Turns.Should().ContainSingle();
        RunnerFixtures
            .Attribute(transcript, TransportAttributes.StoppedBy)
            .Should()
            .Be(
                StopReason.ParticipantFailed,
                because: "a caller that ran out of recordings has not finished the conversation"
            );
        ExchangeState.IsHarnessFailure(ExchangeState.Of(transcript)).Should().BeTrue();
    }
}
