using FluentAssertions;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Coordination;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Serialization;
using Forge.EvalEngine.Tests.Runners;
using Forge.EvalEngine.Transcripts;
using Microsoft.Extensions.Logging;

namespace Forge.EvalEngine.Tests.Coordination;

/// <summary>
/// The guards that must <i>verify</i> independence rather than assert it.
/// </summary>
/// <remarks>
/// Every check in this file exists because a previous one looked right and was not uniformly
/// sensitive. Checking a transcript's scenario id and seed only attributes it correctly if those
/// two values are unique to the run; calling a factory once per run only yields a fresh
/// participant if the factory actually builds one. Both premises are supplied by injected
/// collaborators, so both are established here rather than trusted.
/// </remarks>
public sealed class RunCoordinatorAttributionTests
{
    private const string Secret = "AKIAIOSFODNN7EXAMPLE";

    // ---------------------------------------------------------------------------------------
    // Identity must be unique, or the attribution check passes on a replayed transcript.
    // ---------------------------------------------------------------------------------------

    /// <summary>
    /// The false green the attribution check cannot catch alone: with a colliding seed source,
    /// a runner that hands back repetition one's transcript for repetition two satisfies both
    /// halves of the check and is graded as an independent sample.
    /// </summary>
    [Fact]
    public async Task RunAsync_SeedSourceCollidesWithinAScenario_RefusesTheSuiteRatherThanGradingAReplay()
    {
        var first = (Transcript?)null;
        var runner = new StubRunner(
            ScenarioKind.Rest,
            (scenario, context, _) =>
            {
                // A runner that replays what it returned last time. Under a colliding seed this
                // is indistinguishable from a genuine second sample.
                first ??= CoordinatorFixtures.Transcript(scenario, context);

                return Task.FromResult(first);
            }
        );

        var act = () =>
            CoordinatorFixtures
                .Coordinator([runner], seeds: new CollidingSeedSource())
                .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario(repetitions: 2)), default);

        await act.Should().ThrowAsync<InvalidOperationException>();
    }

    [Fact]
    public async Task RunAsync_SeedSourceCollidesWithinAScenario_DispatchesNothingAtAll()
    {
        var runner = new StubRunner(ScenarioKind.Rest);

        var act = () =>
            CoordinatorFixtures
                .Coordinator([runner], seeds: new CollidingSeedSource())
                .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario(repetitions: 3)), default);

        await act.Should().ThrowAsync<InvalidOperationException>();
        runner.Seen.Should().BeEmpty("the plan is refused before anything is dispatched");
    }

    /// <summary>
    /// The precise boundary: a seed shared across <i>different</i> scenarios is not a false-green
    /// risk, because the scenario id already tells those runs apart. Refusing it would reject a
    /// legitimate paired-comparison setup for no gain.
    /// </summary>
    [Fact]
    public async Task RunAsync_SeedSourceRepeatsAcrossDifferentScenarios_StillRunsTheSuite()
    {
        var runner = new StubRunner(ScenarioKind.Rest);

        var result = await CoordinatorFixtures
            .Coordinator([runner], seeds: new CollidingSeedSource())
            .RunAsync(
                CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a"), CoordinatorFixtures.Scenario("b")),
                default
            );

        CoordinatorFixtures.Runs(result).Should().OnlyContain(run => run.Status == RunStatus.Pass);
    }

    [Fact]
    public async Task RunAsync_SuiteRepeatsAScenarioId_RefusesTheSuiteRatherThanFilingTwoRunsUnderOneKey()
    {
        var runner = new StubRunner(ScenarioKind.Rest);

        var act = () =>
            CoordinatorFixtures
                .Coordinator([runner])
                .RunAsync(
                    CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a"), CoordinatorFixtures.Scenario("a")),
                    default
                );

        await act.Should().ThrowAsync<ArgumentException>();
        runner.Seen.Should().BeEmpty();
    }

    // ---------------------------------------------------------------------------------------
    // "Called once per run" is not "returns a fresh instance".
    // ---------------------------------------------------------------------------------------

    /// <summary>
    /// A factory handing back one singleton defeats the anti-bleed design entirely while the
    /// results still grade as independent samples. Reuse is detected by reference, so the run
    /// that inherits another's caller is recorded ungradeable rather than graded.
    /// </summary>
    [Fact]
    public async Task RunAsync_FactoryReturnsOneInstanceForEveryRun_MarksTheReusedRunsUngradeable()
    {
        var shared = new CountingParticipant();
        var factory = new StubParticipantFactory((_, _, _) => shared);

        var result = await CoordinatorFixtures
            .Coordinator([CoordinatorFixtures.AskingRunner()], participants: factory)
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario(repetitions: 3)), default);

        var runs = CoordinatorFixtures.Runs(result).ToArray();

        runs[0].Status.Should().Be(RunStatus.Pass, "the first run genuinely had the instance to itself");
        runs.Skip(1).Should().OnlyContain(run => run.Status == RunStatus.Error);
    }

    /// <summary>
    /// Reuse is refused <b>before</b> the runner is invoked. Otherwise, under concurrency, two
    /// runs would drive one stateful participant simultaneously and the run that won the race
    /// would be graded on a transcript the loser had corrupted.
    /// </summary>
    [Fact]
    public async Task RunAsync_FactoryReturnsOneInstanceForEveryRun_NeverDrivesTheRunnerWithAReusedParticipant()
    {
        var shared = new CountingParticipant();
        var runner = CoordinatorFixtures.AskingRunner();

        await CoordinatorFixtures
            .Coordinator([runner], participants: new StubParticipantFactory((_, _, _) => shared))
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario(repetitions: 4)), default);

        runner.Seen.Should().ContainSingle("only the run that first claimed the instance may drive it");
    }

    [Fact]
    public async Task RunAsync_FactoryReturnsOneInstanceAcrossScenarios_MarksTheLaterScenariosUngradeable()
    {
        var shared = new CountingParticipant();

        var result = await CoordinatorFixtures
            .Coordinator(
                [CoordinatorFixtures.AskingRunner()],
                participants: new StubParticipantFactory((_, _, _) => shared)
            )
            .RunAsync(
                CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a"), CoordinatorFixtures.Scenario("b")),
                default
            );

        CoordinatorFixtures.Runs(result).Count(run => run.Status == RunStatus.Error).Should().Be(1);
    }

    [Fact]
    public async Task RunAsync_FactoryReturnsAFreshInstanceForEveryRun_GradesEveryRun()
    {
        var result = await CoordinatorFixtures
            .Coordinator([CoordinatorFixtures.AskingRunner()])
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario(repetitions: 4)), default);

        CoordinatorFixtures.Runs(result).Should().OnlyContain(run => run.Status == RunStatus.Pass);
    }

    // ---------------------------------------------------------------------------------------
    // A returned transcript's shape is checked before anything dereferences it.
    // ---------------------------------------------------------------------------------------

    public static TheoryData<string, Func<Transcript, Transcript>> MalformedTranscripts =>
        new()
        {
            { "no transport", transcript => transcript with { Transport = null! } },
            {
                "no attributes",
                transcript => transcript with { Transport = transcript.Transport with { Attributes = null! } }
            },
            { "no outcome", transcript => transcript with { Outcome = null! } },
            { "no fields", transcript => transcript with { Outcome = transcript.Outcome with { Fields = null! } } },
            { "no turns", transcript => transcript with { Turns = null! } },
            { "a null turn", transcript => transcript with { Turns = [null!] } },
        };

    [Theory]
    [MemberData(nameof(MalformedTranscripts))]
    public async Task RunAsync_RunnerReturnsAMalformedTranscript_RecordsAnUngradeableRunRatherThanThrowing(
        string description,
        Func<Transcript, Transcript> deform
    )
    {
        var runner = new StubRunner(
            ScenarioKind.Rest,
            (scenario, context, _) => Task.FromResult(deform(CoordinatorFixtures.Transcript(scenario, context)))
        );

        var result = await CoordinatorFixtures
            .Coordinator([runner])
            .RunAsync(
                CoordinatorFixtures.Suite(
                    CoordinatorFixtures.Scenario(assertions: ["expectedBehavior:outcome=resolved"])
                ),
                default
            );

        var run = CoordinatorFixtures.Runs(result).Single();

        run.Status.Should().Be(RunStatus.Error, description);
        run.AssertionResults.Should().BeEmpty();
        run.ErrorDetail.Should().NotBeNullOrWhiteSpace();
    }

    /// <summary>
    /// The property the finding turns on: grading a malformed transcript threw outside the
    /// runner catch, which aborted every other scenario in a mixed suite.
    /// </summary>
    [Fact]
    public async Task RunAsync_MalformedTranscriptInAMixedSuite_StillProducesEvidenceForTheOtherScenarios()
    {
        var broken = new StubRunner(
            ScenarioKind.Rest,
            (scenario, context, _) =>
                Task.FromResult(CoordinatorFixtures.Transcript(scenario, context) with { Transport = null! })
        );
        var healthy = new StubRunner(ScenarioKind.Mcp);

        var result = await CoordinatorFixtures
            .Coordinator([broken, healthy])
            .RunAsync(
                CoordinatorFixtures.Suite(
                    CoordinatorFixtures.Scenario("rest-a"),
                    CoordinatorFixtures.Scenario("mcp-a", ScenarioKind.Mcp)
                ),
                default
            );

        var runs = CoordinatorFixtures.Runs(result).ToArray();

        runs[0].Status.Should().Be(RunStatus.Error);
        runs[1].Status.Should().Be(RunStatus.Pass, "one broken runner must not take down a mixed suite");
    }

    // ---------------------------------------------------------------------------------------
    // Untrusted text never reaches the committed artifact. Error paths especially.
    // ---------------------------------------------------------------------------------------

    /// <summary>
    /// The identifier a rejected runner returned is text of its own authorship, and the artifact
    /// is committed and attached to pull requests.
    /// </summary>
    [Fact]
    public async Task RunAsync_RunnerReturnsATranscriptForAnotherScenario_DoesNotCommitTheReturnedIdentifier()
    {
        var runner = new StubRunner(
            ScenarioKind.Rest,
            (scenario, context, _) =>
                Task.FromResult(CoordinatorFixtures.Transcript(scenario, context, scenarioId: Secret))
        );

        var result = await CoordinatorFixtures
            .Coordinator([runner])
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("rest-a")), default);

        var run = CoordinatorFixtures.Runs(result).Single();

        run.Status.Should().Be(RunStatus.Error);
        run.ErrorDetail.Should().NotContain(Secret);
        CanonicalJson.Serialize(result).Should().NotContain(Secret);
    }

    /// <summary>
    /// The asymmetry the finding names: the happy path sanitizes the endpoint the coordinator
    /// resolved, and then commits a runner-supplied one verbatim.
    /// </summary>
    [Fact]
    public async Task RunAsync_GradedTranscriptCarriesACredentialBearingEndpoint_RecordsItSanitized()
    {
        var runner = new StubRunner(
            ScenarioKind.Rest,
            (scenario, context, _) =>
            {
                var transcript = CoordinatorFixtures.Transcript(scenario, context);

                return Task.FromResult(
                    transcript with
                    {
                        Transport = transcript.Transport with
                        {
                            Endpoint = $"https://svc:{Secret}@api.example.com/v1?api_key={Secret}",
                        },
                    }
                );
            }
        );

        var result = await CoordinatorFixtures
            .Coordinator([runner])
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("rest-a")), default);

        CanonicalJson.Serialize(result).Should().NotContain(Secret);
    }

    /// <summary>
    /// The registry is injected, so an <see cref="AssertionEvaluationException"/> message is not
    /// necessarily composed by this library and cannot be vouched for.
    /// </summary>
    [Fact]
    public async Task RunAsync_EvaluatorRefusesWithAMessageOfItsOwn_DoesNotCommitThatMessage()
    {
        var registry = new AssertionEvaluatorRegistry([
            new RefusingEvaluator("expectedBehavior", $"could not reach https://api.example.com?token={Secret}"),
        ]);

        var result = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)], assertions: registry)
            .RunAsync(
                CoordinatorFixtures.Suite(
                    CoordinatorFixtures.Scenario(assertions: ["expectedBehavior:outcome=resolved"])
                ),
                default
            );

        var run = CoordinatorFixtures.Runs(result).Single();

        run.Status.Should().Be(RunStatus.Error);
        run.ErrorDetail.Should().NotBeNullOrWhiteSpace("an errored run must never be silent");
        run.ErrorDetail.Should().NotContain(Secret);
    }

    // ---------------------------------------------------------------------------------------
    // A plan is budgeted before it is allocated.
    // ---------------------------------------------------------------------------------------

    /// <summary>
    /// A valid positive repetition count can be <see cref="int.MaxValue"/>. Allocating its
    /// results array exhausts memory before cancellation is ever consulted again.
    /// </summary>
    [Fact]
    public async Task RunAsync_RepetitionCountExceedsTheRunBudget_IsRefusedBeforeAnythingIsAllocated()
    {
        var act = () =>
            CoordinatorFixtures
                .Coordinator([new StubRunner(ScenarioKind.Rest)])
                .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario(repetitions: int.MaxValue)), default);

        await act.Should().ThrowAsync<ArgumentException>();
    }

    [Fact]
    public async Task RunAsync_TotalAcrossScenariosExceedsTheRunBudget_IsRefused()
    {
        var options = new RunCoordinatorOptions { MaxTotalRuns = 5 };

        var act = () =>
            CoordinatorFixtures
                .Coordinator([new StubRunner(ScenarioKind.Rest)], options: options)
                .RunAsync(
                    CoordinatorFixtures.Suite(
                        CoordinatorFixtures.Scenario("a", repetitions: 3),
                        CoordinatorFixtures.Scenario("b", repetitions: 3)
                    ),
                    default
                );

        await act.Should().ThrowAsync<ArgumentException>();
    }

    [Fact]
    public async Task RunAsync_TotalIsExactlyTheRunBudget_IsAllowed()
    {
        var result = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)], options: new RunCoordinatorOptions { MaxTotalRuns = 6 })
            .RunAsync(
                CoordinatorFixtures.Suite(
                    CoordinatorFixtures.Scenario("a", repetitions: 3),
                    CoordinatorFixtures.Scenario("b", repetitions: 3)
                ),
                default
            );

        CoordinatorFixtures.Runs(result).Should().HaveCount(6);
    }

    [Fact]
    public void Options_MaxTotalRunsBelowOne_IsRefused()
    {
        var act = () => new RunCoordinatorOptions { MaxTotalRuns = 0 };

        act.Should().Throw<ArgumentOutOfRangeException>();
    }

    /// <summary>
    /// Planning a large suite stays interruptible rather than running to completion first.
    /// </summary>
    /// <remarks>
    /// Asserting only that the call throws proves nothing here: a cancelled token makes
    /// <see cref="System.Threading.Tasks.Parallel.ForEachAsync{TSource}(IEnumerable{TSource}, System.Threading.Tasks.ParallelOptions, Func{TSource, CancellationToken, ValueTask})"/>
    /// throw whether or not planning ever looked at the token. The load-bearing assertion is that
    /// planning <i>stopped</i> — measured by how far the seed sequence got.
    /// </remarks>
    [Fact]
    public async Task RunAsync_CancelledWhilePlanning_StopsPlanningRatherThanCompletingThePlan()
    {
        using var cancellation = new CancellationTokenSource();
        var seeds = new CancellingSeedSource(cancellation, cancelAfter: 10);

        var act = () =>
            CoordinatorFixtures
                .Coordinator([new StubRunner(ScenarioKind.Rest)], seeds: seeds)
                .RunAsync(
                    CoordinatorFixtures.Suite([
                        .. Enumerable.Range(0, 400).Select(index => CoordinatorFixtures.Scenario($"s{index}")),
                    ]),
                    cancellation.Token
                );

        await act.Should().ThrowAsync<OperationCanceledException>();
        seeds.Issued.Should().BeLessThan(50, "planning must observe the token rather than run to the end");
    }

    /// <summary>
    /// The same property for the inner loop. A single scenario can declare tens of thousands of
    /// repetitions, so checking the token only once per <i>scenario</i> leaves the long plan
    /// uninterruptible.
    /// </summary>
    [Fact]
    public async Task RunAsync_CancelledWhilePlanningOneScenariosRepetitions_StopsPlanningThatScenario()
    {
        using var cancellation = new CancellationTokenSource();
        var seeds = new CancellingSeedSource(cancellation, cancelAfter: 10);

        var act = () =>
            CoordinatorFixtures
                .Coordinator([new StubRunner(ScenarioKind.Rest)], seeds: seeds)
                .RunAsync(
                    CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario(repetitions: 5_000)),
                    cancellation.Token
                );

        await act.Should().ThrowAsync<OperationCanceledException>();
        seeds.Issued.Should().BeLessThan(50, "one scenario's repetitions are planned interruptibly too");
    }

    // ---------------------------------------------------------------------------------------
    // The declared-gap stubs: what a suite actually gets back.
    // ---------------------------------------------------------------------------------------

    /// <summary>
    /// Pins the behaviour the stub runners' documentation now states. A suite cannot obtain a
    /// passing assertion for <c>exchange=unsupported</c> through the coordinator: the run
    /// gathered no evidence, so it is recorded as an error and its assertions are not evaluated.
    /// </summary>
    [Fact]
    public async Task RunAsync_UnsupportedScenarioAssertingOnTheGap_RecordsAnErrorRatherThanAnAssertionVerdict()
    {
        var result = await CoordinatorFixtures
            .Coordinator([
                new Forge.EvalEngine.Runners.NotImplementedUiRunner(new FrozenClock(CoordinatorFixtures.Instant)),
            ])
            .RunAsync(
                CoordinatorFixtures.Suite(
                    CoordinatorFixtures.Scenario(
                        "ui-a",
                        ScenarioKind.Ui,
                        assertions: ["expectedBehavior:transport/exchange=unsupported"]
                    )
                ),
                default
            );

        var run = CoordinatorFixtures.Runs(result).Single();

        run.Status.Should().Be(RunStatus.Error);
        run.AssertionResults.Should().BeEmpty("a run that gathered no evidence is not graded");
    }

    // ---------------------------------------------------------------------------------------
    // A terminal failure leaves an observable signal, once, carrying nothing untrusted.
    // ---------------------------------------------------------------------------------------

    /// <summary>
    /// <see cref="RunResult.ErrorDetail"/> already states the contract: "the harness logs the
    /// underlying failure once, at the point it decides the run is an error." A durable artifact
    /// is not a substitute for that log (§IV).
    /// </summary>
    [Fact]
    public async Task RunAsync_RunCouldNotBeConducted_LogsTheTerminalFailureOnce()
    {
        var logger = new RecordingLogger();
        var runner = new StubRunner(ScenarioKind.Rest, (_, _, _) => throw new InvalidOperationException("boom"));

        await CoordinatorFixtures
            .Coordinator([runner], logger: logger)
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("rest-a")), default);

        logger.Entries.Should().ContainSingle().Which.Level.Should().Be(LogLevel.Error);
    }

    [Fact]
    public async Task RunAsync_NoRunnerIsRegisteredForAKind_LogsTheTerminalFailureOnce()
    {
        var logger = new RecordingLogger();

        await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)], logger: logger)
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("mcp-a", ScenarioKind.Mcp)), default);

        logger.Entries.Should().ContainSingle();
    }

    /// <summary>
    /// A run the runner itself reported as ungradeable is a signal too, but a declared gap is not
    /// a fault — it is recorded at a lower severity so a suite that legitimately contains one
    /// does not read as broken.
    /// </summary>
    [Fact]
    public async Task RunAsync_RunnerReportsAnUngradeableExchange_LogsOnceBelowErrorSeverity()
    {
        var logger = new RecordingLogger();
        var runner = new StubRunner(
            ScenarioKind.Rest,
            (scenario, context, _) =>
                Task.FromResult(CoordinatorFixtures.Transcript(scenario, context, exchange: ExchangeState.Unsupported))
        );

        await CoordinatorFixtures
            .Coordinator([runner], logger: logger)
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("rest-a")), default);

        logger.Entries.Should().ContainSingle().Which.Level.Should().Be(LogLevel.Warning);
    }

    [Fact]
    public async Task RunAsync_EveryRunSucceeds_LogsNothing()
    {
        var logger = new RecordingLogger();

        await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)], logger: logger)
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario(repetitions: 3)), default);

        logger.Entries.Should().BeEmpty();
    }

    /// <summary>A log line is as committed as the artifact, so the same redaction applies (§V).</summary>
    [Fact]
    public async Task RunAsync_TerminalFailureCarriesUntrustedText_KeepsItOutOfTheLog()
    {
        var logger = new RecordingLogger();
        var runner = new StubRunner(
            ScenarioKind.Rest,
            (scenario, context, _) =>
                Task.FromResult(CoordinatorFixtures.Transcript(scenario, context, scenarioId: Secret))
        );

        await CoordinatorFixtures
            .Coordinator([runner], logger: logger)
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("rest-a")), default);

        logger.Entries.Should().NotBeEmpty();
        logger.Entries.Should().OnlyContain(entry => !entry.Message.Contains(Secret));
    }

    [Fact]
    public void Constructor_NullLogger_Throws()
    {
        var act = () =>
            new RunCoordinator(
                [new StubRunner(ScenarioKind.Rest)],
                AssertionEvaluatorRegistry.CreateDefault(),
                new StubParticipantFactory(),
                new FrozenClock(CoordinatorFixtures.Instant),
                new CountingSeedSource(),
                RunCoordinatorOptions.Default,
                null!
            );

        act.Should().Throw<ArgumentNullException>();
    }

    /// <summary>A consumer is not forced to supply a logger to use this library.</summary>
    [Fact]
    public async Task RunAsync_ConstructedWithoutALogger_StillConductsTheSuite()
    {
        var coordinator = new RunCoordinator(
            [new StubRunner(ScenarioKind.Rest)],
            AssertionEvaluatorRegistry.CreateDefault(),
            new StubParticipantFactory(),
            new FrozenClock(CoordinatorFixtures.Instant),
            new CountingSeedSource()
        );

        var result = await coordinator.RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario()), default);

        CoordinatorFixtures.Runs(result).Should().ContainSingle();
    }
}

/// <summary>
/// A seed source that cancels the run partway through the sequence, and counts how far it got.
/// </summary>
internal sealed class CancellingSeedSource(CancellationTokenSource cancellation, int cancelAfter) : ISeedSource
{
    private long _next;
    private int _issued;

    public long RootSeed => 0;

    /// <summary>Gets how many seeds were drawn before planning stopped.</summary>
    public int Issued => Volatile.Read(ref _issued);

    public long NextSeed()
    {
        if (Interlocked.Increment(ref _issued) >= cancelAfter)
        {
            cancellation.Cancel();
        }

        return Interlocked.Increment(ref _next);
    }
}
