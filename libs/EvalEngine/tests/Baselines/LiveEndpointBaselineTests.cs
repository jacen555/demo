using System.Collections.Concurrent;
using FluentAssertions;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Baselines;
using Forge.EvalEngine.Coordination;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Tests.Coordination;
using Forge.EvalEngine.Transcripts;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Forge.EvalEngine.Tests.Baselines;

/// <summary>
/// The deployed-service baseline: run the suite against the version already running.
/// </summary>
/// <remarks>
/// The reference is untrusted, and the two ways it goes wrong are dialling something that is not
/// an evaluation endpoint, and evaluating something other than what was asked for.
/// </remarks>
public sealed class LiveEndpointBaselineTests
{
    private const string BaselineEndpoint = "https://baseline.example/eval";

    private static Suite Suite() => CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a"));

    private static RunCoordinator Coordinator(string? endpoint) =>
        CoordinatorFixtures.Coordinator(
            [new StubRunner(ScenarioKind.Rest)],
            options: new RunCoordinatorOptions { Endpoint = endpoint }
        );

    [Fact]
    public async Task TryGetBaselineAsync_HttpsReference_RunsTheSuiteAgainstIt()
    {
        Uri? asked = null;
        var provider = new LiveEndpointBaseline(
            Suite(),
            endpoint =>
            {
                asked = endpoint;

                return Coordinator(endpoint.ToString());
            }
        );

        var baseline = await provider.TryGetBaselineAsync(BaselineEndpoint, CancellationToken.None);

        asked.Should().Be(new Uri(BaselineEndpoint));
        baseline.Should().NotBeNull();
        baseline!.SuiteName.Should().Be("regression-suite");
        baseline.ScenarioResults.Should().ContainSingle().Which.ScenarioId.Should().Be("a");
    }

    [Fact]
    public async Task TryGetBaselineAsync_PlainHttpReference_IsAccepted()
    {
        const string Endpoint = "http://localhost:5001/eval";
        var provider = new LiveEndpointBaseline(Suite(), _ => Coordinator(Endpoint));

        (await provider.TryGetBaselineAsync(Endpoint, CancellationToken.None)).Should().NotBeNull();
    }

    [Fact]
    public async Task TryGetBaselineAsync_ProducedArtifact_RecordsTheEndpointItRanAgainst()
    {
        var provider = new LiveEndpointBaseline(Suite(), endpoint => Coordinator(endpoint.ToString()));

        var baseline = await provider.TryGetBaselineAsync(BaselineEndpoint, CancellationToken.None);

        baseline!.Environment.Endpoint.Should().Be(BaselineEndpoint);
    }

    [Theory]
    [InlineData("file:///C:/secrets/baseline.json")]
    [InlineData("ftp://baseline.example/eval")]
    [InlineData("data:text/plain,nothing")]
    public async Task TryGetBaselineAsync_ReferenceNamingAnotherScheme_Refuses(string reference)
    {
        var provider = new LiveEndpointBaseline(Suite(), _ => Coordinator(reference));
        var act = async () => await provider.TryGetBaselineAsync(reference, CancellationToken.None);

        await act.Should().ThrowAsync<ArgumentException>();
    }

    [Fact]
    public async Task TryGetBaselineAsync_ReferenceCarryingACredential_RefusesRatherThanStrippingIt()
    {
        const string Reference = "https://user:secret@baseline.example/eval";
        var invoked = false;

        var provider = new LiveEndpointBaseline(
            Suite(),
            _ =>
            {
                invoked = true;

                return Coordinator(BaselineEndpoint);
            }
        );

        var act = async () => await provider.TryGetBaselineAsync(Reference, CancellationToken.None);

        // Refused before the factory is called, so the credential never reaches anything that
        // could record or dial it. The message must not echo it back either.
        var thrown = await act.Should().ThrowAsync<ArgumentException>();
        thrown.Which.Message.Should().NotContain("secret");
        invoked.Should().BeFalse();
    }

    [Theory]
    [InlineData("baseline.example/eval")]
    [InlineData("/eval")]
    [InlineData("not a uri at all")]
    public async Task TryGetBaselineAsync_ReferenceThatIsNotAnAbsoluteUri_Refuses(string reference)
    {
        var provider = new LiveEndpointBaseline(Suite(), _ => Coordinator(BaselineEndpoint));
        var act = async () => await provider.TryGetBaselineAsync(reference, CancellationToken.None);

        await act.Should().ThrowAsync<ArgumentException>();
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public async Task TryGetBaselineAsync_BlankReference_Refuses(string reference)
    {
        var provider = new LiveEndpointBaseline(Suite(), _ => Coordinator(BaselineEndpoint));
        var act = async () => await provider.TryGetBaselineAsync(reference, CancellationToken.None);

        await act.Should().ThrowAsync<ArgumentException>();
    }

    [Fact]
    public async Task TryGetBaselineAsync_NullReference_Refuses()
    {
        var provider = new LiveEndpointBaseline(Suite(), _ => Coordinator(BaselineEndpoint));
        var act = async () => await provider.TryGetBaselineAsync(null!, CancellationToken.None);

        await act.Should().ThrowAsync<ArgumentNullException>();
    }

    [Fact]
    public async Task TryGetBaselineAsync_FactoryReturnedNull_RefusesRatherThanReportingNoBaseline()
    {
        var provider = new LiveEndpointBaseline(Suite(), _ => null!);
        var act = async () => await provider.TryGetBaselineAsync(BaselineEndpoint, CancellationToken.None);

        await act.Should().ThrowAsync<InvalidOperationException>();
    }

    [Fact]
    public async Task TryGetBaselineAsync_CoordinatorRecordedAnotherEndpoint_RefusesTheArtifact()
    {
        // The artifact is the only record of what was evaluated. A coordinator wired to a
        // different address produces a perfectly well-formed baseline for the wrong system, and
        // comparing against it attributes that system's behaviour to this one.
        var provider = new LiveEndpointBaseline(Suite(), _ => Coordinator("https://elsewhere.example/eval"));

        var act = async () => await provider.TryGetBaselineAsync(BaselineEndpoint, CancellationToken.None);

        (await act.Should().ThrowAsync<InvalidOperationException>()).WithMessage("*elsewhere.example*");
    }

    [Fact]
    public async Task TryGetBaselineAsync_CoordinatorRecordedNoEndpoint_RefusesTheArtifact()
    {
        var provider = new LiveEndpointBaseline(Suite(), _ => Coordinator(null));

        var act = async () => await provider.TryGetBaselineAsync(BaselineEndpoint, CancellationToken.None);

        await act.Should().ThrowAsync<InvalidOperationException>();
    }

    // -------------------------------------------------------------------------------------------
    // Redaction and verification pull against each other. Only what survives redaction can be
    // verified, so only that may be referenced — and the runner's own destination is checked
    // against the evidence rather than against the label the coordinator was configured with.
    // -------------------------------------------------------------------------------------------

    [Theory]
    [InlineData("https://baseline.example/eval?deployment=old")]
    [InlineData("https://baseline.example/eval?deployment=new")]
    [InlineData("https://baseline.example/eval#slot-two")]
    public async Task TryGetBaselineAsync_ReferenceWhoseIdentityCannotSurviveRedaction_Refuses(string reference)
    {
        // A query is where a bearer token lives, so it never reaches a committed artifact — it
        // is recorded as "?[redacted]". Two different deployments therefore record the same
        // text, and a check over that text cannot tell them apart.
        var invoked = false;
        var provider = new LiveEndpointBaseline(
            Suite(),
            _ =>
            {
                invoked = true;

                return Coordinator(reference);
            }
        );

        var act = async () => await provider.TryGetBaselineAsync(reference, CancellationToken.None);

        await act.Should().ThrowAsync<ArgumentException>();
        invoked.Should().BeFalse();
    }

    [Fact]
    public async Task TryGetBaselineAsync_ReferenceDifferingFromTheCoordinatorOnlyInItsQuery_IsNotAccepted()
    {
        // The fabrication this refusal prevents: a coordinator wired for ?deployment=new
        // satisfying a request for ?deployment=old, because both record as "?[redacted]".
        var provider = new LiveEndpointBaseline(
            Suite(),
            _ => Coordinator("https://baseline.example/eval?deployment=new")
        );

        var act = async () =>
            await provider.TryGetBaselineAsync("https://baseline.example/eval?deployment=old", CancellationToken.None);

        await act.Should().ThrowAsync<ArgumentException>();
    }

    [Fact]
    public async Task TryGetBaselineAsync_RunnerDialledAnotherDestination_RefusesTheArtifact()
    {
        // The miswired runner: the coordinator's options name the endpoint that was asked for,
        // and the runs went somewhere else. The options are a label; the transcripts are the
        // evidence.
        var provider = new LiveEndpointBaseline(
            Suite(),
            _ =>
                CoordinatorFixtures.Coordinator(
                    [DialsRunner("https://elsewhere.example/eval")],
                    options: new RunCoordinatorOptions { Endpoint = BaselineEndpoint }
                )
        );

        var act = async () => await provider.TryGetBaselineAsync(BaselineEndpoint, CancellationToken.None);

        (await act.Should().ThrowAsync<InvalidOperationException>()).WithMessage("*elsewhere.example*");
    }

    [Fact]
    public async Task TryGetBaselineAsync_RunnerDialledTheRequestedDestination_IsAccepted()
    {
        // The guard must pass the honest case, including a runner that appended its own query:
        // that is redacted on the way into the artifact and the address underneath still matches.
        var provider = new LiveEndpointBaseline(
            Suite(),
            _ =>
                CoordinatorFixtures.Coordinator(
                    [DialsRunner(BaselineEndpoint + "?api-version=2024-10-01")],
                    options: new RunCoordinatorOptions { Endpoint = BaselineEndpoint }
                )
        );

        var baseline = await provider.TryGetBaselineAsync(BaselineEndpoint, CancellationToken.None);

        baseline!.Environment.Endpoint.Should().Be(BaselineEndpoint);
    }

    [Fact]
    public async Task TryGetBaselineAsync_RunnerRecordedADestinationThatIsNotAnAddress_RefusesTheArtifact()
    {
        var provider = new LiveEndpointBaseline(
            Suite(),
            _ =>
                CoordinatorFixtures.Coordinator(
                    [DialsRunner("the baseline deployment")],
                    options: new RunCoordinatorOptions { Endpoint = BaselineEndpoint }
                )
        );

        var act = async () => await provider.TryGetBaselineAsync(BaselineEndpoint, CancellationToken.None);

        await act.Should().ThrowAsync<InvalidOperationException>();
    }

    /// <summary>A runner whose transcripts record the address it actually dialled.</summary>
    private static StubRunner DialsRunner(string dialled) =>
        new(
            ScenarioKind.Rest,
            (scenario, context, _) =>
            {
                var transcript = CoordinatorFixtures.Transcript(scenario, context);

                return Task.FromResult(
                    transcript with
                    {
                        Transport = transcript.Transport with { Endpoint = dialled },
                    }
                );
            }
        );

    [Fact]
    public async Task TryGetBaselineAsync_Cancelled_PropagatesThroughTheWholeSuiteRun()
    {
        using var cts = new CancellationTokenSource();
        var observed = CancellationToken.None;

        var runner = new StubRunner(
            ScenarioKind.Rest,
            async (scenario, context, token) =>
            {
                observed = token;
                await cts.CancelAsync();
                token.ThrowIfCancellationRequested();

                return CoordinatorFixtures.Transcript(scenario, context);
            }
        );

        var provider = new LiveEndpointBaseline(
            Suite(),
            _ =>
                CoordinatorFixtures.Coordinator(
                    [runner],
                    options: new RunCoordinatorOptions { Endpoint = BaselineEndpoint }
                )
        );

        var act = async () => await provider.TryGetBaselineAsync(BaselineEndpoint, cts.Token);

        await act.Should().ThrowAsync<OperationCanceledException>();

        // The coordinator may hand its workers a linked token rather than the caller's own, so
        // the claim is that cancelling the caller's token reached the innermost runner — not
        // that the same instance arrived there.
        observed.CanBeCanceled.Should().BeTrue();
        observed.IsCancellationRequested.Should().BeTrue();
    }

    [Fact]
    public async Task TryGetBaselineAsync_AlreadyCancelled_ThrowsWithoutRunningTheSuite()
    {
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        var invoked = false;
        var provider = new LiveEndpointBaseline(
            Suite(),
            _ =>
            {
                invoked = true;

                return Coordinator(BaselineEndpoint);
            }
        );

        var act = async () => await provider.TryGetBaselineAsync(BaselineEndpoint, cts.Token);

        await act.Should().ThrowAsync<OperationCanceledException>();
        invoked.Should().BeFalse();
    }

    [Fact]
    public void Constructor_NullSuite_Refuses()
    {
        var act = () => new LiveEndpointBaseline(null!, _ => Coordinator(BaselineEndpoint));

        act.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Constructor_NullFactory_Refuses()
    {
        var act = () => new LiveEndpointBaseline(Suite(), null!);

        act.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public async Task TryGetBaselineAsync_ResultFeedsTheComparatorDirectly()
    {
        // Both providers yield a SuiteResult, which is the whole reason one comparator serves
        // both: the live baseline is diffed against a candidate with no conversion step.
        var provider = new LiveEndpointBaseline(Suite(), endpoint => Coordinator(endpoint.ToString()));
        var baseline = await provider.TryGetBaselineAsync(BaselineEndpoint, CancellationToken.None);

        baseline.Should().BeAssignableTo<SuiteResult>();
        baseline!.ScenarioResults.Should().ContainSingle();
    }

    [Fact]
    public void LiveEndpointBaseline_IsABaselineProvider() =>
        new LiveEndpointBaseline(Suite(), _ => Coordinator(BaselineEndpoint))
            .Should()
            .BeAssignableTo<IBaselineProvider>();

    // -------------------------------------------------------------------------------------------
    // Progress. A baseline is a suite run like any other, and one nobody can watch is the silence
    // progress exists to remove. A missing sink produces silence, not an error: the run succeeds and
    // the artifact is right either way. So these tests assert that reports ARRIVE, and every
    // assertion of absence is paired with a control, through the same probe, that hears them.
    // -------------------------------------------------------------------------------------------

    /// <summary>
    /// The baseline suite reports each of its runs, while it runs, against its own plan.
    /// </summary>
    /// <remarks>
    /// Count, total, and correspondence to the artifact are all satisfied by a sink handed every
    /// report once the suite has finished — which leaves the baseline exactly as silent as before.
    /// So the probe also records how many runs had been dispatched when each report arrived.
    /// </remarks>
    [Fact]
    public async Task TryGetBaselineAsync_WithProgress_ReportsEachBaselineRunAsItCompletesAgainstTheBaselinesOwnPlan()
    {
        var suite = EightRuns();

        // The control: the same probe, handed straight to a coordinator built as the factory below
        // builds one, hears every run. Without it a zero further down could be a deaf probe rather
        // than a silent baseline.
        var control = new RecordingProgress();
        await Reporting(new Uri(BaselineEndpoint), new StubRunner(ScenarioKind.Rest)).RunAsync(suite, control, default);
        control.Reports.Should().HaveCount(8, "the probe hears a coordinator that is handed it");

        var runner = new StubRunner(ScenarioKind.Rest);
        var dispatchedAtEachReport = new ConcurrentQueue<int>();
        var progress = new RecordingProgress(_ => dispatchedAtEachReport.Enqueue(runner.Seen.Count));
        var provider = new LiveEndpointBaseline(suite, endpoint => Reporting(endpoint, runner));

        var baseline = await provider.TryGetBaselineAsync(BaselineEndpoint, progress, default);

        progress.Reports.Should().HaveCount(8, "every run of the baseline suite is reported");
        progress
            .Reports.Select(report => report.Total)
            .Should()
            .AllBeEquivalentTo(8, "the total is the baseline suite's own plan: three, one, and four repetitions");
        progress.Reports.Select(report => report.Completed).Should().BeEquivalentTo(Enumerable.Range(1, 8));
        progress
            .Reports.Select(report => $"{report.ScenarioId}#{report.Repetition}={report.Status}")
            .Should()
            .BeEquivalentTo(
                baseline!.ScenarioResults.SelectMany(scenario =>
                    scenario.Runs.Select((run, index) => $"{scenario.ScenarioId}#{index + 1}={run.Status}")
                ),
                "each report describes a run the returned artifact records"
            );

        // One run in flight at a time, so the report for run k is made before run k + 1 is dispatched.
        dispatchedAtEachReport
            .Should()
            .Equal([1, 2, 3, 4, 5, 6, 7, 8], "each report arrives while the baseline is still running");
    }

    /// <summary>
    /// A candidate reported to its own sink, then a baseline reported to its own: neither sink hears
    /// the other suite. The plans differ, so a report that reached the wrong sink would say so by its
    /// total as well as by the count.
    /// </summary>
    [Fact]
    public async Task TryGetBaselineAsync_AfterACandidateRunWithItsOwnSink_ReportsTheBaselineToItsOwnSinkAlone()
    {
        var candidate = new RecordingProgress();
        await Reporting(new Uri("https://candidate.example/eval"), new StubRunner(ScenarioKind.Rest))
            .RunAsync(
                CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("candidate-only", repetitions: 2)),
                candidate,
                default
            );

        // The control: the probe hears the candidate, through the same sink type the baseline's is.
        candidate.Reports.Should().HaveCount(2);

        var baseline = new RecordingProgress();
        var provider = new LiveEndpointBaseline(
            EightRuns(),
            endpoint => Reporting(endpoint, new StubRunner(ScenarioKind.Rest))
        );

        await provider.TryGetBaselineAsync(BaselineEndpoint, baseline, default);

        candidate
            .Reports.Should()
            .HaveCount(2, "nothing from the baseline run reaches the candidate's sink")
            .And.OnlyContain(report => report.Total == 2 && report.ScenarioId == "candidate-only");
        baseline
            .Reports.Should()
            .HaveCount(8, "the baseline's runs reach the sink handed to the baseline")
            .And.OnlyContain(report => report.Total == 8 && report.ScenarioId != "candidate-only");
    }

    /// <summary>
    /// A sink the coordinator would refuse is refused before anything is dispatched — and as
    /// <see cref="NotSupportedException"/>, not as the coordinator's
    /// <see cref="InvalidOperationException"/>. From this method that type means the artifact
    /// describes a different system, and a caller that reports it so turns a progress
    /// misconfiguration into a claim about the system under test. The rows are the two ways a logger
    /// declines a warning: it logs nowhere, or it is configured above warning.
    /// </summary>
    [Theory]
    [InlineData(null)]
    [InlineData(LogLevel.Error)]
    public async Task TryGetBaselineAsync_WithProgressAndALoggerNotAdmittingWarnings_RefusesAsUnsupportedNotAsAWrongEndpoint(
        LogLevel? lowestAdmitted
    )
    {
        var runner = new StubRunner(ScenarioKind.Rest);
        var progress = new RecordingProgress();
        var provider = new LiveEndpointBaseline(
            EightRuns(),
            endpoint => Reporting(endpoint, runner, Admitting(lowestAdmitted))
        );

        var act = () => provider.TryGetBaselineAsync(BaselineEndpoint, progress, default);

        // Exactly this type: not InvalidOperationException, which from this method means a wrong
        // endpoint, and not ArgumentException, which means the reference itself was refused.
        (await act.Should().ThrowExactlyAsync<NotSupportedException>())
            .Which.Message.Should()
            .Contain("logger");
        runner.Seen.Should().BeEmpty("nothing is dispatched before a refusal");
        progress.Reports.Should().BeEmpty();

        // The control: the same harness with a logger that admits warnings dispatches and reports, so
        // the refusal is about the logger, and the empty counts above are a suite that never started
        // rather than a probe that cannot see one.
        var admitted = new StubRunner(ScenarioKind.Rest);
        var heard = new RecordingProgress();

        await new LiveEndpointBaseline(EightRuns(), endpoint => Reporting(endpoint, admitted)).TryGetBaselineAsync(
            BaselineEndpoint,
            heard,
            default
        );

        admitted.Seen.Should().HaveCount(8);
        heard.Reports.Should().HaveCount(8);
    }

    /// <summary>
    /// No sink, nothing to refuse: a coordinator that logs nowhere runs the baseline through either
    /// overload exactly as it did before progress could be threaded through. This pins preserved
    /// behaviour, so it passes before and after the change by design; the refusal above, through the
    /// same harness, is what shows it could see a refusal if there were one.
    /// </summary>
    [Fact]
    public async Task TryGetBaselineAsync_WithoutASinkAndACoordinatorThatLogsNowhere_RunsRatherThanBeingRefused()
    {
        var unreported = new StubRunner(ScenarioKind.Rest);
        var withoutOne = await new LiveEndpointBaseline(
            EightRuns(),
            endpoint => Reporting(endpoint, unreported, NullLogger<RunCoordinator>.Instance)
        ).TryGetBaselineAsync(BaselineEndpoint, default);

        var nulled = new StubRunner(ScenarioKind.Rest);
        var withNull = await new LiveEndpointBaseline(
            EightRuns(),
            endpoint => Reporting(endpoint, nulled, NullLogger<RunCoordinator>.Instance)
        ).TryGetBaselineAsync(BaselineEndpoint, progress: null, default);

        unreported.Seen.Should().HaveCount(8, "the suite was run rather than refused");
        nulled.Seen.Should().HaveCount(8, "the suite was run rather than refused");
        withNull.Should().Be(withoutOne, "a null sink is exactly the overload without one");
    }

    /// <summary>
    /// A report is not a verdict on the baseline: the runs are reported as they complete, and the
    /// artifact is checked against the endpoint only once the suite has finished.
    /// </summary>
    [Fact]
    public async Task TryGetBaselineAsync_WithProgressAndARunnerThatDialledElsewhere_ReportsEveryRunAndStillRefusesTheArtifact()
    {
        var progress = new RecordingProgress();
        var provider = new LiveEndpointBaseline(
            EightRuns(),
            _ =>
                CoordinatorFixtures.Coordinator(
                    [DialsRunner("https://elsewhere.example/eval")],
                    options: new RunCoordinatorOptions { Endpoint = BaselineEndpoint },
                    logger: new RecordingLogger()
                )
        );

        var act = () => provider.TryGetBaselineAsync(BaselineEndpoint, progress, default);

        (await act.Should().ThrowAsync<InvalidOperationException>()).WithMessage("*elsewhere.example*");
        progress.Reports.Should().HaveCount(8, "the runs were reported as they completed, before the check");
    }

    /// <summary>
    /// The token and the sink reach the same suite run: cancelling from inside a report stops the
    /// baseline where it stood, and no run that did not happen is reported.
    /// </summary>
    [Fact]
    public async Task TryGetBaselineAsync_CancelledFromTheSinkMidSuite_StopsReportingAndReturnsNoArtifact()
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

        var provider = new LiveEndpointBaseline(EightRuns(), endpoint => Reporting(endpoint, runner));
        SuiteResult? artifact = null;

        var act = async () =>
            artifact = await provider.TryGetBaselineAsync(BaselineEndpoint, progress, cancellation.Token);

        await act.Should().ThrowAsync<OperationCanceledException>();
        artifact.Should().BeNull("a cancelled baseline must not read as a completed one");
        runner.Seen.Should().HaveCount(3, "scheduling stops at the cancellation rather than draining the plan");
        progress.Reports.Select(report => report.Completed).Should().Equal(1, 2, 3);
    }

    /// <summary>
    /// A reference that is refused never reaches anything that could dial it, so a sink handed with
    /// it hears nothing — and the same provider and probe, given an address it may dial, hear every run.
    /// </summary>
    [Fact]
    public async Task TryGetBaselineAsync_WithProgressAndAReferenceCarryingAQuery_RefusesWithoutDiallingOrReporting()
    {
        var invoked = 0;
        var provider = new LiveEndpointBaseline(
            EightRuns(),
            endpoint =>
            {
                invoked++;

                return Reporting(endpoint, new StubRunner(ScenarioKind.Rest));
            }
        );
        var refused = new RecordingProgress();

        var act = () => provider.TryGetBaselineAsync(BaselineEndpoint + "?deployment=old", refused, default);

        await act.Should().ThrowAsync<ArgumentException>();
        invoked.Should().Be(0, "a refused reference is never handed to the factory");
        refused.Reports.Should().BeEmpty();

        // The control: the same provider and the same kind of probe, given an address it may dial.
        var heard = new RecordingProgress();
        await provider.TryGetBaselineAsync(BaselineEndpoint, heard, default);

        invoked.Should().Be(1);
        heard.Reports.Should().HaveCount(8);
    }

    /// <summary>
    /// The coordinator's own guard stays the authority. The check made here and the coordinator's
    /// read the logger one after the other, so a logger that stops admitting warnings between the two
    /// passes the first and is refused by the second — still before anything is dispatched, and as the
    /// coordinator's <see cref="InvalidOperationException"/>. That is the documented residual: only a
    /// logger reconfigured between two adjacent reads reaches it.
    /// </summary>
    [Fact]
    public async Task TryGetBaselineAsync_WithALoggerThatStopsAdmittingWarningsAfterTheFirstCheck_IsStillRefusedBeforeDispatch()
    {
        var runner = new StubRunner(ScenarioKind.Rest);
        var progress = new RecordingProgress();
        var provider = new LiveEndpointBaseline(
            EightRuns(),
            endpoint => Reporting(endpoint, runner, new AdmitsOnceLogger())
        );

        var act = () => provider.TryGetBaselineAsync(BaselineEndpoint, progress, default);

        (await act.Should().ThrowExactlyAsync<InvalidOperationException>()).Which.Message.Should().Contain("logger");
        runner.Seen.Should().BeEmpty("the coordinator refuses before anything is dispatched");
        progress.Reports.Should().BeEmpty();
    }

    /// <summary>Three, one, and four repetitions: a total only a count of the whole plan arrives at.</summary>
    private static Suite EightRuns() =>
        CoordinatorFixtures.Suite(
            CoordinatorFixtures.Scenario("a", repetitions: 3),
            CoordinatorFixtures.Scenario("b", repetitions: 1),
            CoordinatorFixtures.Scenario("c", repetitions: 4)
        );

    /// <summary>
    /// A coordinator wired for <paramref name="endpoint"/> around <paramref name="runner"/>, with a
    /// logger that admits warnings unless the test supplies one.
    /// </summary>
    private static RunCoordinator Reporting(Uri endpoint, StubRunner runner, ILogger<RunCoordinator>? logger = null) =>
        CoordinatorFixtures.Coordinator(
            [runner],
            options: new RunCoordinatorOptions { Endpoint = endpoint.ToString() },
            logger: logger ?? new RecordingLogger()
        );

    /// <summary>A logger admitting <paramref name="lowest"/> and above, or one that logs nowhere.</summary>
    private static ILogger<RunCoordinator> Admitting(LogLevel? lowest) =>
        lowest is { } level ? new LevelGatedLogger(level) : NullLogger<RunCoordinator>.Instance;

    /// <summary>
    /// A sink that does its work inside <see cref="IProgress{T}.Report(T)"/>, recording each report in
    /// the order it was handed, and can be told to do something more with one. Never
    /// <see cref="Progress{T}"/>, which posts the work elsewhere: what a test saw would then depend on
    /// scheduling rather than on the provider.
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
    /// A logger that admits everything the first time it is asked and nothing afterwards: logging
    /// configuration reloaded between one read and the next.
    /// </summary>
    private sealed class AdmitsOnceLogger : ILogger<RunCoordinator>
    {
        private int _asked;

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => Interlocked.Increment(ref _asked) == 1;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter
        ) { }
    }
}
