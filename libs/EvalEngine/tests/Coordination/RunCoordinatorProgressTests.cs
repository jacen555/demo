using System.Collections.Concurrent;
using System.Runtime.ExceptionServices;
using FluentAssertions;
using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Coordination;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Tests.Runners;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Forge.EvalEngine.Tests.Coordination;

/// <summary>
/// Progress: one report for every run that completes, through an optional
/// <see cref="IProgress{T}"/>. A report cannot change the artifact, and an exception that
/// propagates out of the <see cref="IProgress{T}.Report(T)"/> call cannot fail the suite. One that
/// does not propagate out of the call is the sink's own, and that boundary is pinned near the end of
/// this class.
/// </summary>
/// <remarks>
/// <para>
/// Every consumer here but one does its work inside <see cref="IProgress{T}.Report(T)"/>,
/// synchronously, and records what it is handed in the order it was handed it — so what a test sees
/// depends on the coordinator rather than on scheduling, and the count is the coordinator's to get
/// right, not the marshalling's. The exception is the boundary test, which uses
/// <see cref="Progress{T}"/> under contexts that differ in where they run what is posted to them, and
/// in whether its faults come back out of <c>Post</c>.
/// </para>
/// <para>
/// <b>Every assertion of absence is paired with a control through the same harness.</b> A null
/// sink has nothing attached that could observe it, so "nothing happened" is only evidence when the
/// identical probe, in the same test, does observe something once a sink is supplied. Without the
/// control, a zero could equally mean the probe is deaf.
/// </para>
/// </remarks>
public sealed class RunCoordinatorProgressTests
{
    private const string Holds = "expectedBehavior:outcome/resolved";
    private const string DoesNotHold = "expectedBehavior:outcome/escalated";

    /// <summary>
    /// What a consumer's own exception says. It names a machine path, so it must not reach a log
    /// line: the consumer authored it, and a log is as committed as the artifact (§V).
    /// </summary>
    private const string ConsumerMessage = @"could not redraw the bar at C:\Users\ci-user\AppData\Local\Temp\eval.tty";

    private static readonly ExpectedFailure KnownGap = new()
    {
        Reason = "escalation is not built yet; tracked as FORGE-214",
    };

    // -----------------------------------------------------------------------------------------
    // What is reported.
    // -----------------------------------------------------------------------------------------

    [Fact]
    public async Task RunAsync_WithProgress_ReportsTheWholePlanAsTheTotalOnEveryReport()
    {
        var progress = new RecordingProgress();

        var result = await Coordinator().RunAsync(ThreeScenarios(), progress, default);

        CoordinatorFixtures.Runs(result).Should().HaveCount(8, "three, one, and four repetitions were planned");
        progress.Reports.Should().HaveCount(8);
        progress
            .Reports.Select(report => report.Total)
            .Should()
            .AllBeEquivalentTo(8, "the plan is settled before anything is dispatched, so the bar is determinate");
    }

    [Fact]
    public async Task RunAsync_WithProgress_ReportsEveryPlannedRunExactlyOnce()
    {
        var progress = new RecordingProgress();

        await Coordinator().RunAsync(ThreeScenarios(), progress, default);

        progress
            .Reports.Select(report => $"{report.ScenarioId}#{report.Repetition}")
            .Should()
            .OnlyHaveUniqueItems()
            .And.BeEquivalentTo("a#1", "a#2", "a#3", "b#1", "c#1", "c#2", "c#3", "c#4");
    }

    /// <summary>
    /// Every verdict a run can be recorded with is in this suite, so a report that ignored the
    /// outcome, or carried another run's, would not survive it.
    /// </summary>
    [Fact]
    public async Task RunAsync_WithProgress_ReportsEachRunWithTheVerdictTheArtifactRecordsForIt()
    {
        var progress = new RecordingProgress();

        var result = await Coordinator().RunAsync(EveryVerdict(), progress, default);

        CoordinatorFixtures
            .Runs(result)
            .Select(run => run.Status)
            .Distinct()
            .Should()
            .BeEquivalentTo(
                new[] { RunStatus.Pass, RunStatus.Fail, RunStatus.ExpectedFailure, RunStatus.Error },
                "a suite that produced one verdict could not tell a carried outcome from a constant"
            );

        var recorded = result.ScenarioResults.SelectMany(scenario =>
            scenario.Runs.Select((run, index) => $"{scenario.ScenarioId}#{index + 1}={run.Status}")
        );

        progress
            .Reports.Select(report => $"{report.ScenarioId}#{report.Repetition}={report.Status}")
            .Should()
            .BeEquivalentTo(recorded);
    }

    /// <summary>
    /// Runs finish on different workers at once, and the count has to survive that: a lost update
    /// repeats one value and skips another. The probe holds the first group of runs until it is
    /// complete, so the throttle is reached for certain rather than hoped for, and then releases the
    /// group together — which is exactly when completions contend for the count.
    /// </summary>
    /// <remarks>
    /// A torn increment is a race, and nothing outside the coordinator can force one; these sizes
    /// make one likely enough to see. What is deterministic is that the runs really were in flight
    /// together, which <see cref="ConcurrencyProbeRunner.Peak"/> establishes — and that is what makes
    /// a passing count mean anything.
    /// </remarks>
    [Theory]
    [InlineData(2, 50)]
    [InlineData(8, 400)]
    [InlineData(16, 1600)]
    public async Task RunAsync_ManyRunsInFlightAtOnce_CountsEveryCompletionExactlyOnce(int throttle, int runs)
    {
        var probe = new ConcurrencyProbeRunner(ScenarioKind.Rest, expectedPeak: throttle);
        var progress = new RecordingProgress();

        await CoordinatorFixtures
            .Coordinator(
                [probe],
                options: new RunCoordinatorOptions { MaxConcurrency = throttle },
                logger: new RecordingLogger()
            )
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario(repetitions: runs)), progress, default);

        probe.Peak.Should().Be(throttle, "the count is only tested under concurrency if runs were in flight together");
        progress.Reports.Should().HaveCount(runs);
        progress
            .Reports.Select(report => report.Completed)
            .Order()
            .Should()
            .Equal(Enumerable.Range(1, runs), "every count from one to the total is assigned to exactly one call");
        progress.Reports.Select(report => report.Repetition).Should().OnlyHaveUniqueItems();
        progress.Reports.Select(report => report.Total).Should().AllBeEquivalentTo(runs);
    }

    /// <summary>
    /// At a throttle of one there is one worker, so its calls are made one at a time and in the order
    /// it counted them. A sink that does its work in the call needs no ordering of its own at the
    /// default.
    /// </summary>
    [Fact]
    public async Task RunAsync_OneRunInFlight_ReportsTheCountsInAscendingOrder()
    {
        var progress = new RecordingProgress();

        await CoordinatorFixtures
            .Coordinator(
                [new StubRunner(ScenarioKind.Rest)],
                options: new RunCoordinatorOptions { MaxConcurrency = 1 },
                logger: new RecordingLogger()
            )
            .RunAsync(ThreeScenarios(), progress, default);

        progress.Reports.Select(report => report.Completed).Should().Equal(1, 2, 3, 4, 5, 6, 7, 8);
    }

    /// <summary>
    /// The coordinator conducts a scenario whose id is blank — only the loader refuses one — so the
    /// report must carry it rather than refuse it, or supplying a sink would fail a suite that runs
    /// without one.
    /// </summary>
    [Fact]
    public async Task RunAsync_ScenarioWithABlankId_IsReportedRatherThanFailingTheSuite()
    {
        var progress = new RecordingProgress();

        var result = await Coordinator()
            .RunAsync(
                CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario(string.Empty, repetitions: 2)),
                progress,
                default
            );

        CoordinatorFixtures.Runs(result).Should().HaveCount(2);
        progress.Reports.Select(report => report.ScenarioId).Should().Equal(string.Empty, string.Empty);
    }

    [Fact]
    public async Task RunAsync_WithProgressButNoSuite_IsRefused()
    {
        var act = () => Coordinator().RunAsync(null!, new RecordingProgress(), default);

        await act.Should().ThrowAsync<ArgumentNullException>();
    }

    // -----------------------------------------------------------------------------------------
    // Reporting cannot change what is recorded.
    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// The artifact is the same whether nobody is told, somebody is told, or the somebody throws.
    /// The two sinks that can be observed are checked to have been exercised: equal artifacts from
    /// runs nobody reported on would establish nothing.
    /// </summary>
    [Fact]
    public async Task RunAsync_WhateverTheProgressSink_ProducesTheArtifactTheOverloadWithoutOneDoes()
    {
        var reference = await Coordinator().RunAsync(EveryVerdict(), default);

        var unreported = await Coordinator().RunAsync(EveryVerdict(), progress: null, default);

        var recording = new RecordingProgress();
        var reported = await Coordinator().RunAsync(EveryVerdict(), recording, default);

        var throwing = new ThrowingProgress(() => new InvalidOperationException(ConsumerMessage));
        var reportedToAFaultyConsumer = await Coordinator().RunAsync(EveryVerdict(), throwing, default);

        recording.Reports.Should().HaveCount(8, "the recording sink was called for every run");
        throwing.Calls.Should().Be(8, "the throwing consumer was handed every report");

        unreported.Should().Be(reference);
        reported.Should().Be(reference);
        reportedToAFaultyConsumer.Should().Be(reference);
    }

    /// <summary>
    /// A null sink logs no failed report, and nothing the overload without one does not log. The
    /// probe for a failed report is <see cref="IsAFailedReport"/>, and the control — the same suite,
    /// the same harness, a sink that throws — is what shows the probe matches one: without it, a
    /// count of zero could equally be a predicate that matches nothing. This suite also logs
    /// something of its own (its unrouted runs cannot be conducted), so the logs compared are not
    /// two empty logs agreeing.
    /// </summary>
    [Fact]
    public async Task RunAsync_NullProgress_LogsNoFailedReportAndExactlyWhatTheOverloadWithoutOneLogs()
    {
        var reference = new RecordingLogger();
        await Coordinator(reference).RunAsync(EveryVerdict(), default);

        var unreported = new RecordingLogger();
        await Coordinator(unreported).RunAsync(EveryVerdict(), progress: null, default);

        var control = new RecordingLogger();
        await Coordinator(control)
            .RunAsync(
                EveryVerdict(),
                new ThrowingProgress(() => new InvalidOperationException(ConsumerMessage)),
                default
            );

        control
            .Entries.Count(IsAFailedReport)
            .Should()
            .Be(8, "the probe has to hear a failed report when there is one");
        unreported.Entries.Count(IsAFailedReport).Should().Be(0, "a null sink is never called, so it cannot fail");
        reference
            .Entries.Count(IsAFailedReport)
            .Should()
            .Be(0, "a caller that never asked for progress hears nothing of it");

        reference.Entries.Should().NotBeEmpty("the unrouted runs are logged, so this is not two empty logs agreeing");
        unreported.Entries.Should().Equal(reference.Entries);
    }

    // -----------------------------------------------------------------------------------------
    // A consumer that fails.
    // -----------------------------------------------------------------------------------------

    [Fact]
    public async Task RunAsync_ProgressConsumerThrows_CompletesTheSuiteAndLogsAWarningForEachFailedReport()
    {
        var logger = new RecordingLogger();
        var throwing = new ThrowingProgress(() => new InvalidOperationException(ConsumerMessage));

        var result = await Coordinator(logger).RunAsync(Passing(5), throwing, default);

        throwing.Calls.Should().Be(5, "every report was attempted, so every one of them threw");
        CoordinatorFixtures
            .Runs(result)
            .Select(run => run.Status)
            .Should()
            .Equal(
                Enumerable.Repeat(RunStatus.Pass, 5),
                "a renderer's fault is not a fact about the system under test"
            );

        // Every run passed, so nothing else in this suite logs: each entry is a failed report.
        logger
            .Entries.Should()
            .HaveCount(5)
            .And.AllSatisfy(entry =>
            {
                entry.Level.Should().Be(LogLevel.Warning);
                entry.Message.Should().Contain(nameof(InvalidOperationException)).And.Contain("scenario-a");
            });
        logger
            .Entries.Select(entry => entry.Message)
            .Should()
            .NotContain(
                message => message.Contains("ci-user"),
                "the consumer's message is its own text, and a log line is as committed as the artifact"
            );
    }

    /// <summary>
    /// One bad report is not a reason to stop reporting. A renderer that faulted on a single redraw
    /// would otherwise go dark for the rest of an hour-long suite.
    /// </summary>
    [Fact]
    public async Task RunAsync_ProgressConsumerThrowsOnce_KeepsReportingEveryLaterRun()
    {
        var logger = new RecordingLogger();
        var progress = new RecordingProgress(report =>
        {
            if (report.Completed == 2)
            {
                throw new InvalidOperationException(ConsumerMessage);
            }
        });

        await Coordinator(logger).RunAsync(Passing(5), progress, default);

        progress.Reports.Select(report => report.Completed).Should().Equal(1, 2, 3, 4, 5);
        logger.Entries.Should().ContainSingle().Which.Level.Should().Be(LogLevel.Warning);
    }

    /// <summary>
    /// A consumer can throw a cancellation, but it cannot decide one. Thrown while nobody has
    /// cancelled the suite, it is the consumer's fault like any other; thrown because the caller
    /// cancelled, it is that cancellation, and it propagates as one rather than being logged as a
    /// fault. Each arm is the other's control.
    /// </summary>
    [Fact]
    public async Task RunAsync_ProgressConsumerThrowsCancellation_IsAFaultUnlessTheSuiteWasCancelled()
    {
        // Nobody cancelled the suite.
        var faultLog = new RecordingLogger();
        var faulty = new ThrowingProgress(() => new OperationCanceledException());

        var result = await Coordinator(faultLog).RunAsync(Passing(3), faulty, default);

        CoordinatorFixtures.Runs(result).Should().HaveCount(3);
        faultLog
            .Entries.Should()
            .HaveCount(3)
            .And.AllSatisfy(entry => entry.Message.Should().Contain(nameof(OperationCanceledException)));

        // The caller cancelled, and the consumer is where it surfaced, as it would from a Ctrl+C
        // handler wired to the renderer.
        using var cancellation = new CancellationTokenSource();
        var cancelLog = new RecordingLogger();
        var cancelling = new ThrowingProgress(() =>
        {
            cancellation.Cancel();

            return new OperationCanceledException(cancellation.Token);
        });

        var act = () => Coordinator(cancelLog).RunAsync(Passing(3), cancelling, cancellation.Token);

        await act.Should().ThrowAsync<OperationCanceledException>();
        cancelling.Calls.Should().Be(1, "the first report cancelled the suite, so nothing further was dispatched");
        cancelLog.Entries.Should().BeEmpty("the caller's own cancellation is not a consumer fault");
    }

    // -----------------------------------------------------------------------------------------
    // Cancellation.
    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// Cancelling from inside a report stops the suite exactly as cancelling from anywhere else
    /// does: nothing further is dispatched, nothing is returned, and no run that did not happen is
    /// reported as completed.
    /// </summary>
    [Fact]
    public async Task RunAsync_CancelledWhileReporting_StopsDispatchingAndReturnsNoArtifact()
    {
        using var cancellation = new CancellationTokenSource();
        var runner = new StubRunner(ScenarioKind.Rest);
        var progress = new RecordingProgress(report =>
        {
            if (report.Completed == 3)
            {
                cancellation.Cancel();
            }
        });

        SuiteResult? artifact = null;
        var act = async () =>
            artifact = await CoordinatorFixtures
                .Coordinator([runner], logger: new RecordingLogger())
                .RunAsync(Passing(10), progress, cancellation.Token);

        await act.Should().ThrowAsync<OperationCanceledException>();
        artifact.Should().BeNull("a cancelled suite must not read as a completed one");
        runner.Seen.Should().HaveCount(3, "scheduling stops at the cancellation rather than draining the plan");
        progress.Reports.Select(report => report.Completed).Should().Equal(1, 2, 3);
    }

    // -----------------------------------------------------------------------------------------
    // A sink is refused if the logger does not admit warnings when the suite starts.
    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// The log is the only place a contained fault can appear, so a sink handed to a coordinator
    /// whose logger is not enabled for warnings is refused — before anything is dispatched, as every
    /// other condition that would make a run untrustworthy is. The rows are every way to arrive at
    /// such a coordinator: both constructors that take no logger, an explicit null logger, and a real
    /// logger configured above warning.
    /// </summary>
    [Theory]
    [InlineData(SuppliedLogger.NoneWithoutOptions)]
    [InlineData(SuppliedLogger.NoneWithOptions)]
    [InlineData(SuppliedLogger.ExplicitNullLogger)]
    [InlineData(SuppliedLogger.ErrorsOnly)]
    public async Task RunAsync_WithProgressButNoLoggerAdmittingWarnings_IsRefusedBeforeAnythingIsDispatched(
        SuppliedLogger logger
    )
    {
        var runner = new StubRunner(ScenarioKind.Rest);
        var participants = new StubParticipantFactory();
        var progress = new RecordingProgress();

        var act = () => Built(logger, runner, participants).RunAsync(Passing(3), progress, default);

        (await act.Should().ThrowAsync<InvalidOperationException>()).Which.Message.Should().Contain("logger");
        runner.Seen.Should().BeEmpty("nothing is dispatched before a refusal");
        participants.Created.Should().BeEmpty();
        progress.Reports.Should().BeEmpty();
    }

    /// <summary>
    /// The control for every refusal above: the same harness, with a logger that admits warnings,
    /// runs and reports — so a refusal is about the logger, not about supplying a sink, and its empty
    /// counts are a run that never started rather than a harness that cannot see one.
    /// </summary>
    [Theory]
    [InlineData(SuppliedLogger.WarningsAndAbove)]
    [InlineData(SuppliedLogger.Everything)]
    public async Task RunAsync_WithProgressAndALoggerAdmittingWarnings_RunsAndReports(SuppliedLogger logger)
    {
        var runner = new StubRunner(ScenarioKind.Rest);
        var participants = new StubParticipantFactory();
        var progress = new RecordingProgress();

        var result = await Built(logger, runner, participants).RunAsync(Passing(3), progress, default);

        CoordinatorFixtures.Runs(result).Should().HaveCount(3);
        runner.Seen.Should().HaveCount(3);
        participants.Created.Should().HaveCount(3);
        progress.Reports.Should().HaveCount(3);
    }

    /// <summary>
    /// No sink, nothing to refuse. A coordinator that logs nowhere runs a suite given a null sink
    /// exactly as the overload without one does, which is the null-sink promise kept under the
    /// refusal.
    /// </summary>
    [Fact]
    public async Task RunAsync_NullProgressToACoordinatorThatLogsNowhere_RunsExactlyAsTheOverloadWithoutOne()
    {
        var reference = await Built(
                SuppliedLogger.NoneWithoutOptions,
                new StubRunner(ScenarioKind.Rest),
                new StubParticipantFactory()
            )
            .RunAsync(EveryVerdict(), default);

        var unreported = await Built(
                SuppliedLogger.NoneWithoutOptions,
                new StubRunner(ScenarioKind.Rest),
                new StubParticipantFactory()
            )
            .RunAsync(EveryVerdict(), progress: null, default);

        CoordinatorFixtures.Runs(unreported).Should().HaveCount(8, "the suite was run rather than refused");
        unreported.Should().Be(reference);
    }

    /// <summary>
    /// The refusal reads the logger once, before dispatch, so a logger reconfigured while the suite
    /// runs, so that it stops admitting warnings, is beyond it. Later faults are still contained, and
    /// the coordinator still offers the logger a warning for each, but the logger, as now configured,
    /// declines them. Emitting the warning is the coordinator's part; keeping it is the logger's.
    /// </summary>
    /// <remarks>
    /// This pins a documented limitation, not a behaviour this change introduced: the refusal is a
    /// guard at the boundary, not a guarantee for the life of the suite. The first fault, raised while
    /// the logger still admitted warnings, is the control. It shows the probe recording a contained
    /// fault, so the later silence is the logger declining rather than a deaf probe or a coordinator
    /// that stopped trying.
    /// </remarks>
    [Fact]
    public async Task RunAsync_LoggerStopsAdmittingWarningsMidSuite_LaterFaultsAreStillContainedAndOfferedButDeclined()
    {
        var logger = new SwitchableLogger();
        var progress = new RecordingProgress(report =>
        {
            if (report.Completed == 2)
            {
                // A reload of logging configuration, landing between two calls.
                logger.Minimum = LogLevel.Error;
            }

            throw new InvalidOperationException(ConsumerMessage);
        });

        var result = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)], logger: logger)
            .RunAsync(Passing(4), progress, default);

        CoordinatorFixtures
            .Runs(result)
            .Should()
            .HaveCount(4, "every fault was contained, before the switch and after");
        progress.Reports.Should().HaveCount(4);
        logger.Entries.Count(IsAFailedReport).Should().Be(1, "the fault raised while warnings were admitted was kept");
        logger
            .DeclinedWarnings.Should()
            .Be(3, "a warning was offered for each later fault, and the logger declined it");
    }

    // -----------------------------------------------------------------------------------------
    // The boundary of containment.
    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// The rule: an exception is contained if and only if it propagates out of the
    /// <see cref="IProgress{T}.Report(T)"/> call, on the thread that made it, and is not the caller's
    /// own cancellation. One throwing handler, five ways. It propagates, and is contained and logged,
    /// when the sink runs it itself; when <see cref="Progress{T}"/> posts it to a context that runs it
    /// inline; and when it posts it to a context that runs it on another thread and rethrows its fault
    /// from <c>Post</c>. It does not propagate, and is neither caught nor logged, when that same kind of
    /// context keeps the fault instead, or when the context holds the work until after the suite has
    /// returned.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>The pair that decides the rule.</b> The forwarding and keeping contexts both run the handler
    /// on another thread and wait for it, so where it runs and when it throws are the same in both, and
    /// both are measured. They differ only in whether the fault comes back out of <c>Post</c>. One is
    /// contained and the other is not, so neither location nor timing is the rule; propagation is.
    /// Where a handler runs is the usual reason its fault does or does not propagate, and nothing more.
    /// </para>
    /// <para>
    /// <see cref="Progress{T}"/> posts to the context that was current when it was constructed, so
    /// each one here is constructed under a context the test chose. Constructed on the test thread, it
    /// would capture whatever context the test framework installed there, and the test would measure
    /// that framework's dispatcher rather than the coordinator.
    /// </para>
    /// <para>
    /// <b>What this does not show.</b> With no context — the console case — <see cref="Progress{T}"/>
    /// posts to the thread pool, which does not bring a fault back: it is unhandled on a pool thread,
    /// and the process terminates. The process would be this test host, so that is documented on
    /// <c>RunAsync</c> rather than demonstrated here. The keeping arm is the same case as far as
    /// containment goes, with the fault kept by the test's own context so that the host survives.
    /// </para>
    /// <para>
    /// The arms are one another's controls. The contained arms show the probe hearing a contained
    /// fault, and every arm counts the handler's throws, so an uncontained arm's silence is the
    /// coordinator seeing nothing rather than a handler that never threw.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task RunAsync_ProgressHandlerThrows_IsContainedIfAndOnlyIfItsExceptionPropagatesOutOfTheReportCall()
    {
        var inTheSink = await Observe(handler => new RecordingProgress(handler));
        var postedInline = await Observe(handler => Under(new InlineSynchronizationContext(), handler));

        var forwarding = new OtherThreadSynchronizationContext(forwardsFaults: true);
        var postedAndForwarded = await Observe(handler => Under(forwarding, handler));

        var keeping = new OtherThreadSynchronizationContext(forwardsFaults: false);
        var postedAndKept = await Observe(handler => Under(keeping, handler));

        var held = new HeldSynchronizationContext();
        var postedAndHeld = await Observe(handler => Under(held, handler));

        // The exception propagates out of the call: contained and logged.
        inTheSink.Logged.Should().Be(3, "the sink's own call threw");
        inTheSink.Thrown.Should().Be(3);
        postedInline.Logged.Should().Be(3, "the context ran the handler inside the call, so its fault came out of it");
        postedInline.Thrown.Should().Be(3);
        postedAndForwarded.Logged.Should().Be(3, "the context rethrew the fault from Post, so it came out of the call");
        postedAndForwarded.Thrown.Should().Be(3);

        // The pair: the same place and the same time, measured, and only propagation differs.
        forwarding.RanOnAnotherThread.Should().Be(3, "the forwarded handler ran elsewhere and was still contained");
        keeping.RanOnAnotherThread.Should().Be(3);
        forwarding.ThrewBeforePostFinished.Should().Be(3);
        keeping.ThrewBeforePostFinished.Should().Be(3);

        // The exception does not propagate out of the call: neither caught nor logged.
        postedAndKept.Logged.Should().Be(0, "the context kept the fault, so nothing came out of the call");
        postedAndKept.Thrown.Should().Be(3, "so the silence is not a handler that never threw");
        postedAndHeld.Logged.Should().Be(0);
        postedAndHeld.Thrown.Should().Be(0, "nothing posted had run when the suite returned");

        var pending = held.TakePending();
        pending.Should().HaveCount(3, "each call posted the handler to the held context");
        pending.Should().AllSatisfy(run => run.Should().Throw<InvalidOperationException>());
    }

    // -----------------------------------------------------------------------------------------
    // Fixtures.
    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// A coordinator whose logger admits warnings, as every coordinator given a sink must have,
    /// recording to <paramref name="logger"/> when a test wants to read the log.
    /// </summary>
    private static RunCoordinator Coordinator(RecordingLogger? logger = null) =>
        CoordinatorFixtures.Coordinator([new StubRunner(ScenarioKind.Rest)], logger: logger ?? new RecordingLogger());

    /// <summary>Three, one, and four repetitions: a total only a count of the whole plan arrives at.</summary>
    private static Suite ThreeScenarios() =>
        CoordinatorFixtures.Suite(
            CoordinatorFixtures.Scenario("a", repetitions: 3),
            CoordinatorFixtures.Scenario("b", repetitions: 1),
            CoordinatorFixtures.Scenario("c", repetitions: 4)
        );

    /// <summary>Two runs of each verdict a run can be recorded with.</summary>
    private static Suite EveryVerdict() =>
        CoordinatorFixtures.Suite(
            CoordinatorFixtures.Scenario("passes", repetitions: 2, assertions: [Holds]),
            CoordinatorFixtures.Scenario("fails", repetitions: 2, assertions: [DoesNotHold]),
            CoordinatorFixtures.Scenario(
                "known-gap",
                repetitions: 2,
                assertions: [DoesNotHold],
                expectedFailure: KnownGap
            ),
            // No runner is registered for this kind, so the harness cannot conduct it. Those runs
            // still complete, as errors, and the coordinator logs each one.
            CoordinatorFixtures.Scenario("unrouted", ScenarioKind.Mcp, repetitions: 2)
        );

    private static Suite Passing(int repetitions) =>
        CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario(repetitions: repetitions));

    /// <summary>Whether a log entry is the signal for a report the consumer failed to take.</summary>
    private static bool IsAFailedReport((LogLevel Level, string Message) entry) =>
        entry.Level == LogLevel.Warning && entry.Message.Contains("progress consumer", StringComparison.Ordinal);

    /// <summary>A coordinator given its logger the way <paramref name="logger"/> names.</summary>
    private static RunCoordinator Built(SuppliedLogger logger, StubRunner runner, StubParticipantFactory participants)
    {
        var assertions = AssertionEvaluatorRegistry.CreateDefault();
        var clock = new FrozenClock(CoordinatorFixtures.Instant);
        var seeds = new CountingSeedSource();
        var options = RunCoordinatorOptions.Default;

        return logger switch
        {
            SuppliedLogger.NoneWithoutOptions => new RunCoordinator([runner], assertions, participants, clock, seeds),
            SuppliedLogger.NoneWithOptions => new RunCoordinator(
                [runner],
                assertions,
                participants,
                clock,
                seeds,
                options
            ),
            SuppliedLogger.ExplicitNullLogger => new RunCoordinator(
                [runner],
                assertions,
                participants,
                clock,
                seeds,
                options,
                NullLogger<RunCoordinator>.Instance
            ),
            SuppliedLogger.ErrorsOnly => new RunCoordinator(
                [runner],
                assertions,
                participants,
                clock,
                seeds,
                options,
                new LevelGatedLogger(LogLevel.Error)
            ),
            SuppliedLogger.WarningsAndAbove => new RunCoordinator(
                [runner],
                assertions,
                participants,
                clock,
                seeds,
                options,
                new LevelGatedLogger(LogLevel.Warning)
            ),
            SuppliedLogger.Everything => new RunCoordinator(
                [runner],
                assertions,
                participants,
                clock,
                seeds,
                options,
                new LevelGatedLogger(LogLevel.Trace)
            ),
            _ => throw new ArgumentOutOfRangeException(nameof(logger), logger, "Not a way to supply a logger."),
        };
    }

    /// <summary>
    /// Runs three passing runs through a sink built around a handler that counts its throws, and
    /// returns how many failed reports the coordinator logged and how many throws the handler had
    /// made by the time the suite returned.
    /// </summary>
    private static async Task<(int Logged, int Thrown)> Observe(
        Func<Action<RunProgress>, IProgress<RunProgress>> sinkAround
    )
    {
        var thrown = 0;
        var log = new RecordingLogger();

        void Handler(RunProgress _)
        {
            Interlocked.Increment(ref thrown);

            throw new InvalidOperationException(ConsumerMessage);
        }

        var result = await Coordinator(log).RunAsync(Passing(3), sinkAround(Handler), default);

        CoordinatorFixtures.Runs(result).Should().HaveCount(3);

        return (log.Entries.Count(IsAFailedReport), Volatile.Read(ref thrown));
    }

    /// <summary>
    /// A <see cref="Progress{T}"/> constructed under <paramref name="context"/>, which is therefore
    /// where it posts its handler.
    /// </summary>
    private static Progress<RunProgress> Under(SynchronizationContext context, Action<RunProgress> handler)
    {
        var previous = SynchronizationContext.Current;
        SynchronizationContext.SetSynchronizationContext(context);

        try
        {
            return new Progress<RunProgress>(handler);
        }
        finally
        {
            SynchronizationContext.SetSynchronizationContext(previous);
        }
    }

    /// <summary>
    /// A consumer that records every report as it is handed it, and can be told to do something
    /// more with one.
    /// </summary>
    private sealed class RecordingProgress(Action<RunProgress>? then = null) : IProgress<RunProgress>
    {
        private readonly ConcurrentQueue<RunProgress> _reports = new();

        /// <summary>Gets every report this sink has been handed, in the order its Report was called.</summary>
        public IReadOnlyList<RunProgress> Reports => [.. _reports];

        public void Report(RunProgress value)
        {
            _reports.Enqueue(value);
            then?.Invoke(value);
        }
    }

    /// <summary>A consumer that throws on every report, counting how many it was handed.</summary>
    private sealed class ThrowingProgress(Func<Exception> fault) : IProgress<RunProgress>
    {
        private int _calls;

        public int Calls => Volatile.Read(ref _calls);

        public void Report(RunProgress value)
        {
            Interlocked.Increment(ref _calls);

            throw fault();
        }
    }

    /// <summary>
    /// A context that holds what is posted to it instead of running it, so a test decides when posted
    /// work runs — on the test's own thread, where what it throws can be seen — rather than a thread
    /// pool, where a throw would end the test host.
    /// </summary>
    private sealed class HeldSynchronizationContext : SynchronizationContext
    {
        private readonly ConcurrentQueue<(SendOrPostCallback Callback, object? State)> _held = new();

        public override void Post(SendOrPostCallback d, object? state) => _held.Enqueue((d, state));

        /// <summary>Takes everything held so far, each as an action that runs it.</summary>
        public List<Action> TakePending()
        {
            var pending = new List<Action>();

            while (_held.TryDequeue(out var posted))
            {
                var (callback, state) = posted;
                pending.Add(() => callback(state));
            }

            return pending;
        }
    }

    /// <summary>A context that runs posted work at once, on the stack that posted it.</summary>
    private sealed class InlineSynchronizationContext : SynchronizationContext
    {
        public override void Post(SendOrPostCallback d, object? state) => d(state);
    }

    /// <summary>
    /// A context that runs posted work on a thread of its own and waits for it, so the work has run,
    /// and thrown if it throws, before <c>Post</c> finishes. With <c>forwardsFaults</c> it then
    /// rethrows the work's exception from <c>Post</c>, which is how a dispatcher brings a fault back to
    /// the code that posted the work. Without it, it keeps the exception, as the thread pool does,
    /// except that keeping it here lets the test host survive.
    /// </summary>
    private sealed class OtherThreadSynchronizationContext(bool forwardsFaults) : SynchronizationContext
    {
        private int _ranOnAnotherThread;
        private int _threwBeforePostFinished;

        /// <summary>Gets how many posted callbacks ran on a thread other than the one that posted them.</summary>
        public int RanOnAnotherThread => Volatile.Read(ref _ranOnAnotherThread);

        /// <summary>Gets how many posted callbacks had thrown by the time the Post that ran them finished.</summary>
        public int ThrewBeforePostFinished => Volatile.Read(ref _threwBeforePostFinished);

        public override void Post(SendOrPostCallback d, object? state)
        {
            var poster = Environment.CurrentManagedThreadId;
            Exception? fault = null;
            var thread = new Thread(() =>
            {
                if (Environment.CurrentManagedThreadId != poster)
                {
                    Interlocked.Increment(ref _ranOnAnotherThread);
                }

                try
                {
                    d(state);
                }
                catch (InvalidOperationException exception)
                {
                    fault = exception;
                }
            });

            thread.Start();
            thread.Join();

            // Recorded here, once the work has finished and before Post returns or rethrows.
            if (fault is null)
            {
                return;
            }

            Interlocked.Increment(ref _threwBeforePostFinished);

            if (forwardsFaults)
            {
                ExceptionDispatchInfo.Capture(fault).Throw();
            }
        }
    }

    /// <summary>A logger that admits the levels from its minimum up, and keeps nothing.</summary>
    private sealed class LevelGatedLogger(LogLevel minimum) : ILogger<RunCoordinator>
    {
        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None && logLevel >= minimum;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter
        ) { }
    }

    /// <summary>
    /// A logger whose minimum level can be raised while a suite runs, as a reload of logging
    /// configuration would. It records what it admits, and counts the warnings it declines, whether it
    /// declines one when asked if it is enabled or when handed one.
    /// </summary>
    private sealed class SwitchableLogger : ILogger<RunCoordinator>
    {
        private readonly List<(LogLevel Level, string Message)> _entries = [];
        private int _minimum = (int)LogLevel.Trace;
        private int _declinedWarnings;

        public LogLevel Minimum
        {
            get => (LogLevel)Volatile.Read(ref _minimum);
            set => Volatile.Write(ref _minimum, (int)value);
        }

        public int DeclinedWarnings => Volatile.Read(ref _declinedWarnings);

        public IReadOnlyList<(LogLevel Level, string Message)> Entries
        {
            get
            {
                lock (_entries)
                {
                    return [.. _entries];
                }
            }
        }

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel)
        {
            var enabled = logLevel != LogLevel.None && logLevel >= Minimum;

            if (!enabled && logLevel == LogLevel.Warning)
            {
                Interlocked.Increment(ref _declinedWarnings);
            }

            return enabled;
        }

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter
        )
        {
            // A provider filters what it is handed as well as what it is asked about.
            if (!IsEnabled(logLevel))
            {
                return;
            }

            lock (_entries)
            {
                _entries.Add((logLevel, formatter(state, exception)));
            }
        }
    }
}

/// <summary>How a coordinator under test was given its logger.</summary>
public enum SuppliedLogger
{
    /// <summary>The constructor that takes neither options nor a logger.</summary>
    NoneWithoutOptions,

    /// <summary>The constructor that takes options but no logger.</summary>
    NoneWithOptions,

    /// <summary>The null logger, passed explicitly.</summary>
    ExplicitNullLogger,

    /// <summary>A real logger configured to admit errors and above only.</summary>
    ErrorsOnly,

    /// <summary>A real logger configured to admit warnings and above.</summary>
    WarningsAndAbove,

    /// <summary>A real logger that admits every level.</summary>
    Everything,
}
