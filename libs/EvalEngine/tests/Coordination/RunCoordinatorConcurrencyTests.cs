using System.Collections.Concurrent;
using FluentAssertions;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Coordination;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Tests.Runners;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Tests.Coordination;

/// <summary>
/// The throttle, cancellation, and the independence of one run from another. Aggregation is where
/// results from different contexts first sit side by side, so this is where one run's evidence
/// could be attributed to another's scenario.
/// </summary>
public sealed class RunCoordinatorConcurrencyTests
{
    // ---------------------------------------------------------------------------------------
    // The throttle. Counted, never timed.
    // ---------------------------------------------------------------------------------------

    [Theory]
    [InlineData(1, 6)]
    [InlineData(2, 6)]
    [InlineData(3, 9)]
    [InlineData(4, 4)]
    [InlineData(5, 6)]
    public async Task RunAsync_Always_RunsExactlyUpToTheThrottleAndNeverPastIt(int throttle, int units)
    {
        var probe = new ConcurrencyProbeRunner(ScenarioKind.Rest, expectedPeak: throttle);

        await CoordinatorFixtures
            .Coordinator([probe], options: new RunCoordinatorOptions { MaxConcurrency = throttle })
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario(repetitions: units)), default);

        probe.Started.Should().Be(units);
        probe.Peak.Should().Be(throttle, "the throttle is the lever for testing a system's own throttling");
        probe
            .DispatchedWhileBlocked.Should()
            .Be(throttle, "with the whole first group held, an unbounded coordinator would have dispatched another");
    }

    /// <summary>
    /// The boundary the reviewer asks about: with exactly as many runs as the throttle allows,
    /// every one of them may be in flight together — and not one more.
    /// </summary>
    [Fact]
    public async Task RunAsync_AsManyRunsAsTheThrottleAllows_ReachesTheLimitExactly()
    {
        var probe = new ConcurrencyProbeRunner(ScenarioKind.Rest, expectedPeak: 4);

        await CoordinatorFixtures
            .Coordinator([probe], options: new RunCoordinatorOptions { MaxConcurrency = 4 })
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario(repetitions: 4)), default);

        probe.Peak.Should().Be(4);
    }

    /// <summary>The throttle spans the whole suite, not one scenario at a time.</summary>
    [Fact]
    public async Task RunAsync_RunsSpreadAcrossScenarios_AreThrottledTogetherRatherThanPerScenario()
    {
        var probe = new ConcurrencyProbeRunner(ScenarioKind.Rest, expectedPeak: 3);

        await CoordinatorFixtures
            .Coordinator([probe], options: new RunCoordinatorOptions { MaxConcurrency = 3 })
            .RunAsync(
                CoordinatorFixtures.Suite(
                    CoordinatorFixtures.Scenario("a", repetitions: 2),
                    CoordinatorFixtures.Scenario("b", repetitions: 2),
                    CoordinatorFixtures.Scenario("c", repetitions: 2)
                ),
                default
            );

        probe.Started.Should().Be(6);
        probe.Peak.Should().Be(3);
        probe.DispatchedWhileBlocked.Should().Be(3);
    }

    [Fact]
    public void Options_MaxConcurrencyBelowOne_IsRefused()
    {
        var act = () => new RunCoordinatorOptions { MaxConcurrency = 0 };

        act.Should().Throw<ArgumentOutOfRangeException>();
    }

    [Fact]
    public void Options_Default_RunsOneAtATime() =>
        RunCoordinatorOptions.Default.MaxConcurrency.Should().Be(1, "concurrency against a real system is a choice");

    // ---------------------------------------------------------------------------------------
    // Independence: one repetition must not influence another.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public async Task RunAsync_EveryRepetition_GetsItsOwnParticipant()
    {
        var participants = new StubParticipantFactory();
        var runner = new StubRunner(ScenarioKind.Rest);

        await CoordinatorFixtures
            .Coordinator([runner], participants)
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario(repetitions: 5)), default);

        participants.Created.Should().HaveCount(5);
        participants.Created.Distinct().Should().HaveCount(5, "a shared caller carries one run's state into the next");
        runner.Seen.Select(run => run.Participant).Distinct().Should().HaveCount(5);
    }

    [Fact]
    public async Task RunAsync_EveryScenario_GetsItsOwnParticipant()
    {
        var participants = new StubParticipantFactory();

        await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)], participants)
            .RunAsync(
                CoordinatorFixtures.Suite(
                    CoordinatorFixtures.Scenario("a"),
                    CoordinatorFixtures.Scenario("b"),
                    CoordinatorFixtures.Scenario("c")
                ),
                default
            );

        participants.Created.Distinct().Should().HaveCount(3);
    }

    [Fact]
    public async Task RunAsync_ParticipantFactory_IsToldWhichRunItIsBuildingFor()
    {
        var asked = new ConcurrentQueue<(string Id, long Seed, int Repetition)>();
        var participants = new StubParticipantFactory(
            (scenario, seed, repetition) =>
            {
                asked.Enqueue((scenario.Identity.Id, seed, repetition));

                return new CountingParticipant();
            }
        );
        var runner = new StubRunner(ScenarioKind.Rest);

        await CoordinatorFixtures
            .Coordinator([runner], participants)
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("rest-a", repetitions: 3)), default);

        asked.OrderBy(entry => entry.Repetition).Select(entry => entry.Id).Should().Equal("rest-a", "rest-a", "rest-a");
        asked
            .Select(entry => entry.Seed)
            .Distinct()
            .Should()
            .HaveCount(3, "a repetition is only reproducible with its own seed");
        asked
            .Select(entry => (entry.Seed, entry.Repetition))
            .Should()
            .BeEquivalentTo(
                runner.Seen.Select(run => (run.Seed, run.Repetition)),
                "the participant must be built for the run it is handed to"
            );
    }

    /// <summary>
    /// The end-to-end form of the same property, with a caller that is deliberately stateful. If
    /// one instance were shared, the second repetition would report itself as the second ask —
    /// and that bleed would reach the committed transcript.
    /// </summary>
    [Fact]
    public async Task RunAsync_StatefulParticipant_DoesNotCarryStateAcrossRepetitions()
    {
        var result = await CoordinatorFixtures
            .Coordinator(
                [CoordinatorFixtures.AskingRunner()],
                options: new RunCoordinatorOptions { MaxConcurrency = 4 }
            )
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario(repetitions: 5)), default);

        result
            .ScenarioResults.Single()
            .Runs.Select(run => run.Transcript.Turns.Single().Stimulus)
            .Should()
            .AllBe("ask 1", "every repetition starts from a caller that has been asked nothing");
    }

    // ---------------------------------------------------------------------------------------
    // Attribution: a result belongs to the run that produced it.
    // ---------------------------------------------------------------------------------------

    /// <summary>
    /// Under concurrency, every transcript has to land against the scenario it came from. A
    /// coordinator that collected results into a shared list would pass a single-scenario test and
    /// fail this one.
    /// </summary>
    [Fact]
    public async Task RunAsync_ManyScenariosAtOnce_AttributesEveryTranscriptToItsOwnScenario()
    {
        var scenarios = Enumerable
            .Range(0, 24)
            .Select(index => CoordinatorFixtures.Scenario($"scenario-{index}", repetitions: (index % 3) + 1))
            .ToArray();

        var result = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)], options: new RunCoordinatorOptions { MaxConcurrency = 8 })
            .RunAsync(CoordinatorFixtures.Suite(scenarios), default);

        result.ScenarioResults.Should().HaveCount(24);
        foreach (var scenario in result.ScenarioResults)
        {
            scenario
                .Runs.Should()
                .AllSatisfy(run =>
                    run.Transcript.ScenarioId.Should()
                        .Be(
                            scenario.ScenarioId,
                            "a transcript filed under the wrong scenario is graded by the wrong assertions"
                        )
                );
        }

        result
            .ScenarioResults.Select(scenario => scenario.Runs.Count)
            .Should()
            .Equal(Enumerable.Range(0, 24).Select(index => (index % 3) + 1));
    }

    /// <summary>
    /// Seeds are drawn in suite order before anything is dispatched, so a run's seed is a function
    /// of where it sits in the suite rather than of which worker reached it first. Without that,
    /// raising the throttle would silently change what a baseline is compared against.
    /// </summary>
    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(8)]
    public async Task RunAsync_WhateverTheThrottle_AssignsTheSameSeedsToTheSameRuns(int throttle)
    {
        var suite = CoordinatorFixtures.Suite(
            CoordinatorFixtures.Scenario("a", repetitions: 3),
            CoordinatorFixtures.Scenario("b", repetitions: 2),
            CoordinatorFixtures.Scenario("c", repetitions: 4)
        );

        var result = await CoordinatorFixtures
            .Coordinator(
                [new StubRunner(ScenarioKind.Rest)],
                options: new RunCoordinatorOptions { MaxConcurrency = throttle },
                seeds: new CountingSeedSource(rootSeed: 500)
            )
            .RunAsync(suite, default);

        result
            .ScenarioResults.Select(scenario => scenario.Runs.Select(run => run.Transcript.Seed).ToArray())
            .Should()
            .BeEquivalentTo(new[] { new long[] { 501, 502, 503 }, [504, 505], [506, 507, 508, 509] });
    }

    /// <summary>
    /// The structural half of the same property, checked deterministically rather than by hoping
    /// a race shows up: by the time any run starts, every seed in the plan has already been
    /// drawn. A seed drawn inside a worker would depend on scheduling, and a test that only
    /// compared the resulting seeds would catch that intermittently at best.
    /// </summary>
    [Fact]
    public async Task RunAsync_Always_DrawsEverySeedBeforeDispatchingAnyRun()
    {
        var seeds = new CountingSeedSource();
        var issuedWhenTheFirstRunStarted = -1;
        var runner = new StubRunner(
            ScenarioKind.Rest,
            (scenario, context, _) =>
            {
                Interlocked.CompareExchange(ref issuedWhenTheFirstRunStarted, seeds.Issued, -1);

                return Task.FromResult(CoordinatorFixtures.Transcript(scenario, context));
            }
        );

        await CoordinatorFixtures
            .Coordinator([runner], options: new RunCoordinatorOptions { MaxConcurrency = 1 }, seeds: seeds)
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario(repetitions: 12)), default);

        issuedWhenTheFirstRunStarted
            .Should()
            .Be(12, "the whole plan, seeds included, is settled on one thread before anything is dispatched");
    }

    [Fact]
    public async Task RunAsync_Always_DrivesEveryRunWithADistinctSeed()
    {
        var runner = new StubRunner(ScenarioKind.Rest);

        await CoordinatorFixtures
            .Coordinator([runner], options: new RunCoordinatorOptions { MaxConcurrency = 4 })
            .RunAsync(
                CoordinatorFixtures.Suite(
                    CoordinatorFixtures.Scenario("a", repetitions: 5),
                    CoordinatorFixtures.Scenario("b", repetitions: 5)
                ),
                default
            );

        runner.Seen.Select(run => run.Seed).Distinct().Should().HaveCount(10);
    }

    // ---------------------------------------------------------------------------------------
    // Cancellation.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public async Task RunAsync_TokenAlreadyCancelled_ThrowsAndDispatchesNothing()
    {
        using var cancellation = new CancellationTokenSource();
        await cancellation.CancelAsync();
        var runner = new StubRunner(ScenarioKind.Rest);

        var act = () =>
            CoordinatorFixtures
                .Coordinator([runner])
                .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario(repetitions: 3)), cancellation.Token);

        await act.Should().ThrowAsync<OperationCanceledException>();
        runner.Seen.Should().BeEmpty();
    }

    /// <summary>
    /// Cancellation between repetitions stops scheduling promptly. The runs that already happened
    /// are not returned as though the suite completed — the call throws instead.
    /// </summary>
    [Fact]
    public async Task RunAsync_CancelledBetweenRepetitions_HaltsSchedulingAndDoesNotReportPartialResults()
    {
        using var cancellation = new CancellationTokenSource();
        var runner = new StubRunner(
            ScenarioKind.Rest,
            async (scenario, context, _) =>
            {
                await cancellation.CancelAsync();

                return CoordinatorFixtures.Transcript(scenario, context);
            }
        );

        var act = () =>
            CoordinatorFixtures
                .Coordinator([runner])
                .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario(repetitions: 50)), cancellation.Token);

        await act.Should().ThrowAsync<OperationCanceledException>();
        runner.Seen.Count.Should().BeLessThan(50, "scheduling stops rather than draining the plan");
    }

    [Fact]
    public async Task RunAsync_CancelledBetweenScenarios_HaltsSchedulingAndDoesNotReportPartialResults()
    {
        using var cancellation = new CancellationTokenSource();
        var runner = new StubRunner(
            ScenarioKind.Rest,
            async (scenario, context, _) =>
            {
                await cancellation.CancelAsync();

                return CoordinatorFixtures.Transcript(scenario, context);
            }
        );
        var scenarios = Enumerable
            .Range(0, 40)
            .Select(index => CoordinatorFixtures.Scenario($"scenario-{index}"))
            .ToArray();

        var act = () =>
            CoordinatorFixtures
                .Coordinator([runner])
                .RunAsync(CoordinatorFixtures.Suite(scenarios), cancellation.Token);

        await act.Should().ThrowAsync<OperationCanceledException>();
        runner.Seen.Count.Should().BeLessThan(40);
    }

    /// <summary>A run already in flight has to see the token, not merely be abandoned.</summary>
    [Fact]
    public async Task RunAsync_CancelledMidRun_IsObservedByTheRunInFlight()
    {
        using var cancellation = new CancellationTokenSource();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var observed = false;
        var runner = new StubRunner(
            ScenarioKind.Rest,
            async (scenario, context, token) =>
            {
                started.TrySetResult();
                try
                {
                    await Task.Delay(Timeout.InfiniteTimeSpan, token);
                }
                catch (OperationCanceledException)
                {
                    observed = true;
                    throw;
                }

                return CoordinatorFixtures.Transcript(scenario, context);
            }
        );

        var running = CoordinatorFixtures
            .Coordinator([runner])
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario()), cancellation.Token);

        await started.Task;
        await cancellation.CancelAsync();

        await FluentActions.Awaiting(() => running).Should().ThrowAsync<OperationCanceledException>();
        observed.Should().BeTrue("the token must reach the run, not merely abandon it");
    }

    [Fact]
    public async Task RunAsync_CancelledMidRun_ReturnsNoArtifactAtAll()
    {
        using var cancellation = new CancellationTokenSource();
        var runner = new StubRunner(
            ScenarioKind.Rest,
            async (_, _, _) =>
            {
                await cancellation.CancelAsync();

                throw new OperationCanceledException(cancellation.Token);
            }
        );

        SuiteResult? artifact = null;
        var act = async () =>
            artifact = await CoordinatorFixtures
                .Coordinator([runner])
                .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario(repetitions: 4)), cancellation.Token);

        await act.Should().ThrowAsync<OperationCanceledException>();
        artifact.Should().BeNull("a cancelled suite must not read as a completed one");
    }

    /// <summary>
    /// The coordinator hands every run the caller's token, so a runner that ignores it is the only
    /// way a cancelled suite can keep working.
    /// </summary>
    [Fact]
    public async Task RunAsync_Always_HandsEachRunACancellableToken()
    {
        var tokens = new ConcurrentQueue<CancellationToken>();
        using var cancellation = new CancellationTokenSource();
        var runner = new StubRunner(
            ScenarioKind.Rest,
            (scenario, context, token) =>
            {
                tokens.Enqueue(token);

                return Task.FromResult(CoordinatorFixtures.Transcript(scenario, context));
            }
        );

        await CoordinatorFixtures
            .Coordinator([runner])
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario(repetitions: 3)), cancellation.Token);

        tokens.Should().HaveCount(3).And.AllSatisfy(token => token.CanBeCanceled.Should().BeTrue());
    }
}
