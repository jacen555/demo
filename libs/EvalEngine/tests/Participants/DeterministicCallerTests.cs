using FluentAssertions;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Participants;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Tests.Participants;

/// <summary>
/// The deterministic caller is the harness's primary variance-reduction mechanism: it selects
/// stimuli from the scenario's own material rather than asking a model, so the only stochastic
/// element in a run is the system under test.
/// </summary>
public class DeterministicCallerTests
{
    // ---------------------------------------------------------------------
    // Script replay and turn indexing.
    //
    // The opening is turn 1 (Simulation.ScriptedTurnBudget counts it), so
    // ScriptedStimuli[0] drives turn 2 whenever an opening is present.
    // ---------------------------------------------------------------------

    [Fact]
    public async Task NextAsync_FirstTurn_ReplaysTheOpeningAsScripted()
    {
        var caller = Deterministic(new Simulation { Opening = "I need to change my order" });

        var turn = await caller.NextAsync(Transcript(), CancellationToken.None);

        turn.IsComplete.Should().BeFalse();
        turn.Stimulus.Should().Be("I need to change my order");
        turn.Provenance.Should().Be(TurnProvenance.Scripted);
    }

    [Fact]
    public async Task NextAsync_AfterTheOpening_ReplaysScriptedStimuliInOrder()
    {
        var caller = Deterministic(
            new Simulation { Opening = "opening", ScriptedStimuli = [Scripted("first"), Scripted("second")] }
        );

        var stimuli = await DriveAsync(caller, _ => "ok");

        stimuli.Should().Equal("opening", "first", "second");
    }

    [Fact]
    public async Task NextAsync_NoOpening_ReplaysScriptedStimuliFromTurnOne()
    {
        var caller = Deterministic(new Simulation { ScriptedStimuli = [Scripted("first"), Scripted("second")] });

        var stimuli = await DriveAsync(caller, _ => "ok");

        stimuli.Should().Equal("first", "second");
    }

    [Fact]
    public async Task NextAsync_TurnAtExactlyTheScriptedBudget_IsStillScripted()
    {
        var simulation = new Simulation { Opening = "opening", ScriptedStimuli = [Scripted("last scripted")] };
        var caller = Deterministic(simulation);

        // Budget is 2: the opening plus one scripted entry. Turn 2 is the final scripted turn.
        simulation.ScriptedTurnBudget.Should().Be(2);
        var turn = await caller.NextAsync(TranscriptOf(("opening", "ok")), CancellationToken.None);

        turn.Stimulus.Should().Be("last scripted");
        turn.Provenance.Should().Be(TurnProvenance.Scripted);
    }

    [Fact]
    public async Task NextAsync_TurnImmediatelyPastTheScriptedBudget_IsNotScripted()
    {
        var caller = Simulated(
            new Simulation
            {
                Opening = "opening",
                ScriptedStimuli = [Scripted("last scripted")],
                StimulusPool = ["a pool entry"],
            }
        );

        var turn = await caller.NextAsync(
            TranscriptOf(("opening", "ok"), ("last scripted", "ok")),
            CancellationToken.None
        );

        turn.Stimulus.Should().Be("a pool entry");
        turn.Provenance.Should().Be(TurnProvenance.Synthesized);
    }

    [Fact]
    public async Task NextAsync_UnusableScriptEntries_DoNotConsumeATurnIndex()
    {
        // ScriptedTurnBudget counts only material that can actually drive a turn. A null entry
        // that silently consumed turn 3 would push "second" to turn 4 and break the guard's
        // "scripted turns are exactly 1..budget" invariant.
        var simulation = new Simulation
        {
            Opening = "opening",
            ScriptedStimuli = [Scripted("first"), null!, Scripted("second")],
        };
        var caller = Deterministic(simulation);

        var stimuli = await DriveAsync(caller, _ => "ok");

        simulation.ScriptedTurnBudget.Should().Be(3);
        stimuli.Should().Equal("opening", "first", "second");
    }

    [Fact]
    public async Task NextAsync_BlankOpening_DoesNotConsumeTurnOne()
    {
        var simulation = new Simulation { Opening = "   ", ScriptedStimuli = [Scripted("first")] };
        var caller = Deterministic(simulation);

        var stimuli = await DriveAsync(caller, _ => "ok");

        simulation.ScriptedTurnBudget.Should().Be(1);
        stimuli.Should().Equal("first");
    }

    // ---------------------------------------------------------------------
    // Provenance. Load-bearing: T3's load-time guard and T4's evaluation-time
    // scoping both depend on the set of Scripted turns being exactly 1..budget.
    // ---------------------------------------------------------------------

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(4)]
    public async Task NextAsync_AnyScript_EmitsExactlyScriptedTurnBudgetScriptedTurns(int scriptedCount)
    {
        var simulation = new Simulation
        {
            Opening = "opening",
            ScriptedStimuli = Enumerable.Range(1, scriptedCount).Select(i => Scripted($"line {i}")).ToArray(),
            StimulusPool = ["pool one", "pool two"],
        };
        var caller = Simulated(simulation);

        var turns = await DriveTurnsAsync(caller, _ => "ok");

        turns.Count(turn => turn.Provenance == TurnProvenance.Scripted).Should().Be(simulation.ScriptedTurnBudget);
        turns
            .Take(simulation.ScriptedTurnBudget)
            .Should()
            .OnlyContain(turn => turn.Provenance == TurnProvenance.Scripted);
        turns
            .Skip(simulation.ScriptedTurnBudget)
            .Should()
            .OnlyContain(turn => turn.Provenance == TurnProvenance.Synthesized);
    }

    // ---------------------------------------------------------------------
    // Completion signalling.
    // ---------------------------------------------------------------------

    [Fact]
    public async Task NextAsync_DeterministicModeWithScriptExhausted_SignalsCompletion()
    {
        // SuiteValidator.FurthestReachableTurn bounds a run to ScriptedTurnBudget whenever
        // stopOnParticipantCompletion is enabled. If this participant kept going, that
        // load-time approval would be false and un-scoped assertions would silently grade
        // against synthesized turns.
        var caller = Deterministic(
            new Simulation
            {
                Opening = "opening",
                ScriptedStimuli = [Scripted("first")],
                StimulusPool = ["a pool entry", "another pool entry"],
            }
        );

        var turns = await DriveTurnsAsync(caller, _ => "ok");

        turns.Should().HaveCount(2);
        var past = await caller.NextAsync(TranscriptOf(("opening", "ok"), ("first", "ok")), CancellationToken.None);
        past.IsComplete.Should().BeTrue();
        past.Stimulus.Should().BeNull();
        past.Provenance.Should().BeNull();
    }

    [Fact]
    public async Task NextAsync_RestStyleOpeningOnly_EmitsOneTurnThenCompletes()
    {
        var caller = Deterministic(new Simulation { Opening = "GET /orders/42" });

        var turns = await DriveTurnsAsync(caller, _ => "200 OK");

        turns.Should().HaveCount(1);
        turns[0].Stimulus.Should().Be("GET /orders/42");
        turns[0].Provenance.Should().Be(TurnProvenance.Scripted);
    }

    [Fact]
    public async Task NextAsync_SimulatedModeWithEmptyPool_SignalsCompletion()
    {
        var caller = Simulated(new Simulation { Opening = "opening" });

        var turn = await caller.NextAsync(TranscriptOf(("opening", "ok")), CancellationToken.None);

        turn.IsComplete.Should().BeTrue();
    }

    [Fact]
    public async Task NextAsync_SimulatedModeWithPoolExhausted_SignalsCompletion()
    {
        var caller = Simulated(new Simulation { Opening = "opening", StimulusPool = ["only entry"] });

        var turns = await DriveTurnsAsync(caller, _ => "ok");

        turns.Should().HaveCount(2);
        turns[1].Stimulus.Should().Be("only entry");
        var past = await caller.NextAsync(
            TranscriptOf(("opening", "ok"), ("only entry", "ok")),
            CancellationToken.None
        );
        past.IsComplete.Should().BeTrue();
    }

    [Fact]
    public async Task NextAsync_NothingToContribute_SignalsCompletionOnTheFirstTurn()
    {
        var caller = Simulated(new Simulation());

        var turn = await caller.NextAsync(Transcript(), CancellationToken.None);

        turn.IsComplete.Should().BeTrue();
    }

    // ---------------------------------------------------------------------
    // Token-overlap selection from the stimulus pool.
    // ---------------------------------------------------------------------

    [Fact]
    public async Task NextAsync_UnscriptedTurn_SelectsThePoolEntryWithTheHighestTokenOverlap()
    {
        var caller = Simulated(
            new Simulation
            {
                Opening = "opening",
                StimulusPool = ["the weather is fine", "my order number is 4471", "unrelated filler text"],
            }
        );

        var turn = await caller.NextAsync(
            TranscriptOf(("opening", "what is your order number?")),
            CancellationToken.None
        );

        turn.Stimulus.Should().Be("my order number is 4471");
        turn.Provenance.Should().Be(TurnProvenance.Synthesized);
    }

    [Fact]
    public async Task NextAsync_TieInOverlapScoring_SelectsTheEarliestPoolEntry()
    {
        // Both entries overlap on exactly one token. The winner must be decided by pool order,
        // not by hash order, alphabetical order, or whichever the runtime happened to enumerate.
        var caller = Simulated(
            new Simulation { Opening = "opening", StimulusPool = ["zulu confirm", "alpha confirm"] }
        );

        var turn = await caller.NextAsync(TranscriptOf(("opening", "please confirm")), CancellationToken.None);

        turn.Stimulus.Should().Be("zulu confirm");
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    public async Task NextAsync_BlankSystemResponse_SelectsTheFirstUnusedPoolEntry(string? response)
    {
        var caller = Simulated(new Simulation { Opening = "opening", StimulusPool = ["first entry", "second entry"] });

        var turn = await caller.NextAsync(TranscriptOf(("opening", response)), CancellationToken.None);

        turn.Stimulus.Should().Be("first entry");
        turn.Provenance.Should().Be(TurnProvenance.Synthesized);
    }

    [Fact]
    public async Task NextAsync_PoolEntryAlreadySent_IsNotSelectedAgain()
    {
        var caller = Simulated(
            new Simulation { Opening = "opening", StimulusPool = ["my order number is 4471", "please escalate"] }
        );

        var turns = await DriveTurnsAsync(caller, _ => "what is your order number?");

        turns.Select(turn => turn.Stimulus).Should().Equal("opening", "my order number is 4471", "please escalate");
    }

    [Fact]
    public async Task NextAsync_PoolEntryMatchingAScriptedStimulus_IsNotRepeated()
    {
        var caller = Simulated(
            new Simulation
            {
                Opening = "opening",
                ScriptedStimuli = [Scripted("please escalate")],
                StimulusPool = ["please escalate", "something else"],
            }
        );

        var turns = await DriveTurnsAsync(caller, _ => "ok");

        turns.Select(turn => turn.Stimulus).Should().Equal("opening", "please escalate", "something else");
    }

    [Fact]
    public async Task NextAsync_OverlapScoring_MatchesTokensRegardlessOfCase()
    {
        var caller = Simulated(
            new Simulation { Opening = "opening", StimulusPool = ["filler", "ORDER NUMBER four four seven one"] }
        );

        var turn = await caller.NextAsync(
            TranscriptOf(("opening", "what is your order number?")),
            CancellationToken.None
        );

        turn.Stimulus.Should().Be("ORDER NUMBER four four seven one");
    }

    [Fact]
    public async Task NextAsync_BlankPoolEntries_AreNeverSelected()
    {
        var caller = Simulated(new Simulation { Opening = "opening", StimulusPool = ["   ", null!, "real entry"] });

        var turns = await DriveTurnsAsync(caller, _ => string.Empty);

        turns.Select(turn => turn.Stimulus).Should().Equal("opening", "real entry");
    }

    // ---------------------------------------------------------------------
    // Determinism.
    // ---------------------------------------------------------------------

    [Fact]
    public async Task NextAsync_SameScenarioAndSameResponses_ProducesTheIdenticalTurnSequence()
    {
        static Simulation Build() =>
            new()
            {
                Opening = "opening",
                ScriptedStimuli = [Scripted("scripted line")],
                StimulusPool = ["confirm the change", "cancel the order", "confirm and cancel", "escalate please"],
            };

        var first = await DriveTurnsAsync(Simulated(Build()), turn => $"confirm or cancel, step {turn}");
        var second = await DriveTurnsAsync(Simulated(Build()), turn => $"confirm or cancel, step {turn}");

        second.Should().Equal(first);
    }

    [Fact]
    public async Task NextAsync_CalledTwiceWithTheSameTranscript_ReturnsTheSameStimulus()
    {
        var caller = Simulated(
            new Simulation { Opening = "opening", StimulusPool = ["confirm the change", "cancel the order"] }
        );
        var transcript = TranscriptOf(("opening", "confirm or cancel?"));

        var first = await caller.NextAsync(transcript, CancellationToken.None);
        var second = await caller.NextAsync(transcript, CancellationToken.None);

        second.Should().Be(first);
    }

    // ---------------------------------------------------------------------
    // Guards.
    // ---------------------------------------------------------------------

    [Fact]
    public async Task NextAsync_NullTranscript_ThrowsArgumentNullException()
    {
        var caller = Deterministic(new Simulation { Opening = "opening" });

        var next = async () => await caller.NextAsync(null!, CancellationToken.None);

        await next.Should().ThrowAsync<ArgumentNullException>();
    }

    [Fact]
    public async Task NextAsync_CancelledToken_ThrowsOperationCanceledException()
    {
        var caller = Deterministic(new Simulation { Opening = "opening" });
        using var cancellation = new CancellationTokenSource();
        await cancellation.CancelAsync();

        var next = async () => await caller.NextAsync(Transcript(), cancellation.Token);

        await next.Should().ThrowAsync<OperationCanceledException>();
    }

    [Fact]
    public void Constructor_NullSimulation_ThrowsArgumentNullException()
    {
        Action build = () => _ = new DeterministicCaller(null!, ExecutionMode.Deterministic);

        build.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Constructor_LiveMode_ThrowsArgumentOutOfRangeException()
    {
        // Live provenance means a real external caller. This type cannot produce one, and
        // silently tagging its own output as Live would defeat the provenance contract.
        Action build = () => _ = new DeterministicCaller(new Simulation(), ExecutionMode.Live);

        build.Should().Throw<ArgumentOutOfRangeException>();
    }

    [Fact]
    public void Constructor_ModeOutsideTheEnum_ThrowsArgumentOutOfRangeException()
    {
        Action build = () => _ = new DeterministicCaller(new Simulation(), (ExecutionMode)99);

        build.Should().Throw<ArgumentOutOfRangeException>();
    }

    [Fact]
    public async Task NextAsync_DeterministicMode_NeverDrawsFromTheStimulusPool()
    {
        var caller = Deterministic(new Simulation { Opening = "opening", StimulusPool = ["pool one", "pool two"] });

        var turns = await DriveTurnsAsync(caller, _ => "please continue");

        turns.Should().ContainSingle();
        turns[0].Stimulus.Should().Be("opening");
    }

    // ---------------------------------------------------------------------
    // Transcript trust.
    //
    // This caller derives how far the script has run from the transcript it is
    // handed, which is a better design than a mutable used-set — but it means
    // the transcript is load-bearing input, and input is not trusted. The suite
    // loader approves otherwise-unscoped assertions on the premise that turns
    // 1..ScriptedTurnBudget are script-driven, and the evaluators scope to that
    // same premise. This is the layer that has to make it true at run time, so
    // the prefix it claims authorship of must be the prefix it would have
    // produced: the script's text, one-based indices, and Scripted provenance.
    // ---------------------------------------------------------------------

    [Fact]
    public async Task NextAsync_ForeignTurnInTheScriptedPrefix_RefusesInsteadOfEmittingTheNextScriptedLine()
    {
        // A two-turn script and a transcript whose turn 1 came from somewhere else. Deriving
        // position from Turns.Count alone skips the opening, emits "second" tagged Scripted onto
        // a transcript no part of which this caller drove, and completes — leaving the loader's
        // approval resting on a fiction.
        var caller = Deterministic(new Simulation { Opening = "opening", ScriptedStimuli = [Scripted("second")] });
        var foreign = Transcript([TurnAt(1, "a line this caller never wrote", TurnProvenance.Live)]);

        var next = async () => await caller.NextAsync(foreign, CancellationToken.None);

        var thrown = await next.Should().ThrowExactlyAsync<ArgumentException>();
        thrown.Which.ParamName.Should().Be("transcriptSoFar");
        thrown.Which.Message.Should().Contain("Turn 1");
    }

    [Theory]
    [InlineData(TurnProvenance.Live)]
    [InlineData(TurnProvenance.Synthesized)]
    public async Task NextAsync_ScriptedPrefixTurnCarryingOtherProvenance_Refuses(TurnProvenance provenance)
    {
        // Text and index both line up; only the provenance says the script did not drive it.
        // Accepting it would let a turn the caller never produced count towards the budget.
        var caller = Simulated(
            new Simulation
            {
                Opening = "opening",
                ScriptedStimuli = [Scripted("second")],
                StimulusPool = ["a pool entry"],
            }
        );
        var foreign = Transcript([TurnAt(1, "opening", provenance)]);

        var next = async () => await caller.NextAsync(foreign, CancellationToken.None);

        var thrown = await next.Should().ThrowExactlyAsync<ArgumentException>();
        thrown.Which.Message.Should().Contain(provenance.ToString());
    }

    [Fact]
    public async Task NextAsync_ScriptedPrefixTurnHoldingTextTheScriptNeverWrote_Refuses()
    {
        // Correctly numbered and honestly tagged Scripted — but by a different script. The tag
        // alone is not evidence; the text has to be the line this caller would have sent.
        var caller = Deterministic(
            new Simulation { Opening = "opening", ScriptedStimuli = [Scripted("second"), Scripted("third")] }
        );
        var foreign = Transcript([
            TurnAt(1, "opening", TurnProvenance.Scripted),
            TurnAt(2, "another suite's line", TurnProvenance.Scripted),
        ]);

        var next = async () => await caller.NextAsync(foreign, CancellationToken.None);

        var thrown = await next.Should().ThrowExactlyAsync<ArgumentException>();
        thrown.Which.Message.Should().Contain("Turn 2").And.Contain("another suite's line");
    }

    [Fact]
    public async Task NextAsync_ScriptedPrefixTurnDifferingFromTheScriptOnlyInCase_Refuses()
    {
        // Pool selection case-folds because a loose match is a feature when picking what to say
        // next. Deciding whether the script drove a turn is not that: it is ordinal, like every
        // other verdict-bearing comparison in this library.
        var caller = Deterministic(new Simulation { Opening = "opening", ScriptedStimuli = [Scripted("second")] });
        var foreign = Transcript([TurnAt(1, "OPENING", TurnProvenance.Scripted)]);

        var next = async () => await caller.NextAsync(foreign, CancellationToken.None);

        await next.Should().ThrowExactlyAsync<ArgumentException>();
    }

    [Theory]
    [InlineData(0)]
    [InlineData(2)]
    [InlineData(7)]
    public async Task NextAsync_ScriptedPrefixTurnCarryingTheWrongOneBasedIndex_Refuses(int index)
    {
        // Turn.Index is one-based and the loader reasons in those numbers — "turns 1..budget are
        // scripted". A prefix numbered differently cannot be the prefix that claim describes.
        var caller = Deterministic(new Simulation { Opening = "opening", ScriptedStimuli = [Scripted("second")] });
        var foreign = Transcript([TurnAt(index, "opening", TurnProvenance.Scripted)]);

        var next = async () => await caller.NextAsync(foreign, CancellationToken.None);

        var thrown = await next.Should().ThrowExactlyAsync<ArgumentException>();
        thrown.Which.Message.Should().Contain("Turn 1");
    }

    [Fact]
    public async Task NextAsync_ForeignPrefixWithTheScriptExhausted_RefusesRatherThanSignallingCompletion()
    {
        // The completion path is the dangerous one: a run that ends here is graded. Completing on
        // a transcript the script did not drive would report a confident verdict about the system
        // from evidence the system's caller never produced, and look exactly like a clean
        // end-of-script. The check therefore runs before the mode decides anything.
        var caller = Deterministic(new Simulation { Opening = "opening", ScriptedStimuli = [Scripted("second")] });
        var foreign = Transcript([
            TurnAt(1, "someone else's opening", TurnProvenance.Live),
            TurnAt(2, "second", TurnProvenance.Scripted),
        ]);

        var next = async () => await caller.NextAsync(foreign, CancellationToken.None);

        await next.Should().ThrowExactlyAsync<ArgumentException>();
    }

    [Fact]
    public async Task NextAsync_TranscriptThisCallerDrove_IsAccepted()
    {
        var caller = Deterministic(
            new Simulation { Opening = "opening", ScriptedStimuli = [Scripted("second"), Scripted("third")] }
        );
        var honest = Transcript([
            TurnAt(1, "opening", TurnProvenance.Scripted),
            TurnAt(2, "second", TurnProvenance.Scripted),
        ]);

        var turn = await caller.NextAsync(honest, CancellationToken.None);

        turn.Stimulus.Should().Be("third");
        turn.Provenance.Should().Be(TurnProvenance.Scripted);
    }

    [Fact]
    public async Task NextAsync_TurnsPastTheScript_AreNotCheckedAgainstTheScript()
    {
        // The check defends exactly the claim the loader and the evaluators rest on — that turns
        // 1..budget are script-driven. It deliberately says nothing about turns past the budget:
        // no stage derives scope from their provenance, the overrun guard does not police
        // Simulated mode at all, and policing them here would be a claim this caller never made.
        var caller = Simulated(new Simulation { Opening = "opening", StimulusPool = ["a pool entry"] });
        var transcript = Transcript([
            TurnAt(1, "opening", TurnProvenance.Scripted),
            TurnAt(2, "somebody else's line", TurnProvenance.Live),
        ]);

        var turn = await caller.NextAsync(transcript, CancellationToken.None);

        turn.Stimulus.Should().Be("a pool entry");
        turn.Provenance.Should().Be(TurnProvenance.Synthesized);
    }

    [Fact]
    public async Task NextAsync_NoScriptToCompareAgainst_AcceptsTheTranscript()
    {
        // A pool-only simulation has no scripted prefix, so there is nothing to verify and
        // nothing this caller has claimed. Refusing here would break pool-only scenarios for a
        // premise they never made.
        var caller = Simulated(new Simulation { StimulusPool = ["a pool entry"] });
        var transcript = Transcript([TurnAt(1, "somebody else's line", TurnProvenance.Live)]);

        var turn = await caller.NextAsync(transcript, CancellationToken.None);

        turn.Stimulus.Should().Be("a pool entry");
    }

    // ---------------------------------------------------------------------
    // Helpers.
    // ---------------------------------------------------------------------

    private static DeterministicCaller Deterministic(Simulation simulation) =>
        new(simulation, ExecutionMode.Deterministic);

    private static DeterministicCaller Simulated(Simulation simulation) => new(simulation, ExecutionMode.Simulated);

    private static ScriptedStimulus Scripted(string text) => new() { Text = text };

    private static Turn TurnAt(int index, string stimulus, TurnProvenance provenance, string? response = "ok") =>
        new()
        {
            Index = index,
            Stimulus = stimulus,
            Response = response,
            Provenance = provenance,
        };

    private static Transcript Transcript(IReadOnlyList<Turn>? turns = null) =>
        new()
        {
            ScenarioId = "scenario-a",
            Seed = 4242,
            StartedAt = TestData.FixedInstant,
            Turns = turns ?? [],
        };

    private static Transcript TranscriptOf(params (string Stimulus, string? Response)[] turns) =>
        Transcript(
            turns
                .Select(
                    (turn, index) =>
                        new Turn
                        {
                            Index = index + 1,
                            Stimulus = turn.Stimulus,
                            Response = turn.Response,
                            Provenance = TurnProvenance.Scripted,
                        }
                )
                .ToArray()
        );

    /// <summary>
    /// Drives the caller to completion, feeding each stimulus back as a turn carrying the
    /// response the supplied function produces for that turn index — the loop a runner runs.
    /// </summary>
    private static async Task<IReadOnlyList<ParticipantTurn>> DriveTurnsAsync(
        DeterministicCaller caller,
        Func<int, string?> respond,
        int ceiling = 12
    )
    {
        var emitted = new List<ParticipantTurn>();
        var turns = new List<Turn>();

        while (emitted.Count < ceiling)
        {
            var next = await caller.NextAsync(Transcript(turns.ToArray()), CancellationToken.None);

            if (next.IsComplete)
            {
                break;
            }

            emitted.Add(next);
            turns.Add(
                new Turn
                {
                    Index = turns.Count + 1,
                    Stimulus = next.Stimulus!,
                    Response = respond(turns.Count + 1),
                    Provenance = next.Provenance!.Value,
                }
            );
        }

        return emitted;
    }

    private static async Task<IReadOnlyList<string>> DriveAsync(DeterministicCaller caller, Func<int, string?> respond)
    {
        var turns = await DriveTurnsAsync(caller, respond);

        return turns.Select(turn => turn.Stimulus!).ToArray();
    }
}
