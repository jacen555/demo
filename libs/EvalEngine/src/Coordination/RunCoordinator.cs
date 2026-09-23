using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Runners;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Transcripts;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Forge.EvalEngine.Coordination;

/// <summary>
/// Conducts a whole suite: routes each scenario to its runner, applies the repetition policy,
/// grades the transcripts, and assembles the durable artifact.
/// </summary>
/// <remarks>
/// <para>
/// This is the first stage that holds results from more than one run at a time, which makes it
/// the first stage where one run's evidence could be graded as though it came from another. The
/// design is built against that rather than patched for it:
/// </para>
/// <list type="bullet">
/// <item><description>
/// <b>Nothing is shared between runs.</b> A participant arrives from
/// <see cref="IParticipantFactory"/> once per run and is never reused — a stateful caller shared
/// across repetitions would make repetition two a continuation of repetition one rather than an
/// independent sample, and under concurrency it would have no defined behaviour at all. That the
/// factory <i>returned</i> a fresh instance is verified by reference rather than assumed: calling
/// it once per run establishes nothing about what it handed back.
/// </description></item>
/// <item><description>
/// <b>Seeds are drawn before anything is dispatched</b>, sequentially, in suite order. A run's
/// seed is therefore a function of where it sits in the suite and of the root seed, never of
/// which worker reached it first. Drawing them inside the workers would make the artifact depend
/// on the throttle, silently changing what a baseline is compared against — and
/// <see cref="ISeedSource"/> implementations are not required to be thread-safe.
/// </description></item>
/// <item><description>
/// <b>Every result is written into the slot reserved for its own run.</b> There is no shared
/// accumulator whose ordering could attribute a transcript to the wrong scenario, and suite order
/// is preserved structurally rather than by sorting afterwards.
/// </description></item>
/// <item><description>
/// <b>A transcript is checked against the run it is supposed to describe.</b> A runner that
/// returns one naming another scenario, or stamped with a seed this run was not driven with, is
/// refused rather than graded. That transcript would grade exactly like a real one, which is the
/// shape of a false green rather than of a failure someone notices. That check only tells runs
/// apart if the pair it compares is unique to the run, so the plan also refuses a suite with a
/// duplicate scenario id and a seed source that repeats a seed within a scenario — before
/// anything is dispatched.
/// </description></item>
/// </list>
/// <para>
/// <b>Repetition is one code path, not a branch.</b>
/// <see cref="RepetitionPolicy.Once"/> is <see cref="RepetitionPolicy.Repeat(int)"/> of one, and
/// the policy makes zero and negative counts unrepresentable, so there is nothing here that reads
/// "if this runs more than once". Runners know nothing about repetition; they conduct exactly one
/// execution each.
/// </para>
/// <para>
/// <b>What the harness failed to do is never graded.</b> A run whose exchange
/// <see cref="ExchangeState.IsHarnessFailure(string?)"/> classifies as a harness failure — an
/// unsupported transport, a request that never arrived, an adapter that fell over — becomes
/// <see cref="RunStatus.Error"/> and its assertions are not evaluated at all. A verdict about a
/// system that was never successfully asked is not a verdict, and recording green assertions
/// beside it is how a suite of entirely unsupported scenarios comes to read as clean. An
/// assertion that cannot be evaluated is <see cref="RunStatus.Error"/> for the same reason, which
/// is the refusal-versus-failure line the evaluators already draw.
/// </para>
/// <para>
/// <b>One broken runner does not take down a mixed suite.</b> A runner that throws, returns
/// nothing, or was never registered for a kind produces a recorded error for the runs it
/// affected, exactly as a declared gap does. The alternative — propagating — makes the blast
/// radius of one misconfiguration depend on where in the suite it happened to sit, and destroys
/// the evidence every other scenario did produce. The only failure that propagates is
/// cancellation by the caller: returning an artifact for a suite nobody waited for would report a
/// partial run as a complete one.
/// </para>
/// <para>
/// <b>Errors are signalled in the artifact <i>and</i> logged.</b> Every terminal failure here
/// becomes a <see cref="RunStatus.Error"/> carrying a stated
/// <see cref="RunResult.ErrorDetail"/> and an ungradeable transcript — a durable, structured,
/// committed signal rather than a line in a console nobody kept. A durable artifact is not a
/// substitute for a log, though: nobody reads it until the suite finishes, and §IV requires an
/// observable signal at the point an operation terminally fails. So each terminal failure is also
/// logged exactly once, at the layer that decides it, through an injected
/// <see cref="ILogger{TCategoryName}"/> that defaults to
/// <see cref="NullLogger{T}.Instance"/> — abstractions only, so a consumer is neither forced to
/// supply a logger nor saddled with a logging implementation this library chose. Only text this
/// library composed is logged; anything authored by a runner, a factory, or an evaluator is
/// redacted first, because a log line is as committed as the artifact (§V).
/// </para>
/// <para>
/// One instance conducts <b>one suite at a time</b>. Concurrency within a run is bounded by
/// <see cref="RunCoordinatorOptions.MaxConcurrency"/>; calling
/// <see cref="RunAsync(Suite, CancellationToken)"/> concurrently on the same instance is not
/// supported, because the injected <see cref="ISeedSource"/> need not be thread-safe. Give each
/// concurrent suite run its own coordinator and its own seed source.
/// </para>
/// </remarks>
public sealed partial class RunCoordinator
{
    private static readonly IReadOnlyDictionary<string, string> NothingObserved = new Dictionary<string, string>(
        StringComparer.Ordinal
    );

    private readonly Dictionary<ScenarioKind, IScenarioRunner> _runners = new();
    private readonly AssertionEvaluatorRegistry _assertions;
    private readonly IParticipantFactory _participants;
    private readonly IClock _clock;
    private readonly ISeedSource _seeds;
    private readonly RunCoordinatorOptions _options;
    private readonly ILogger<RunCoordinator> _logger;

    /// <summary>Initializes a new instance of the <see cref="RunCoordinator"/> class.</summary>
    /// <param name="runners">The runners to route by <see cref="IScenarioRunner.Kind"/>.</param>
    /// <param name="assertions">The registry every transcript is graded through.</param>
    /// <param name="participants">The source of a fresh participant for each run.</param>
    /// <param name="clock">The clock the artifact's timestamp comes from.</param>
    /// <param name="seeds">The source of the seed each run is driven with.</param>
    /// <exception cref="ArgumentNullException">Any argument is null.</exception>
    /// <exception cref="ArgumentException">
    /// A runner is null, or two runners conduct the same <see cref="ScenarioKind"/>.
    /// </exception>
    public RunCoordinator(
        IEnumerable<IScenarioRunner> runners,
        AssertionEvaluatorRegistry assertions,
        IParticipantFactory participants,
        IClock clock,
        ISeedSource seeds
    )
        : this(runners, assertions, participants, clock, seeds, RunCoordinatorOptions.Default) { }

    /// <summary>Initializes a new instance of the <see cref="RunCoordinator"/> class.</summary>
    /// <param name="runners">The runners to route by <see cref="IScenarioRunner.Kind"/>.</param>
    /// <param name="assertions">The registry every transcript is graded through.</param>
    /// <param name="participants">The source of a fresh participant for each run.</param>
    /// <param name="clock">The clock the artifact's timestamp comes from.</param>
    /// <param name="seeds">The source of the seed each run is driven with.</param>
    /// <param name="options">The throttle, and what may be written into the artifact.</param>
    /// <exception cref="ArgumentNullException">Any argument is null.</exception>
    /// <exception cref="ArgumentException">
    /// A runner is null, or two runners conduct the same <see cref="ScenarioKind"/>.
    /// </exception>
    public RunCoordinator(
        IEnumerable<IScenarioRunner> runners,
        AssertionEvaluatorRegistry assertions,
        IParticipantFactory participants,
        IClock clock,
        ISeedSource seeds,
        RunCoordinatorOptions options
    )
        : this(runners, assertions, participants, clock, seeds, options, NullLogger<RunCoordinator>.Instance) { }

    /// <summary>Initializes a new instance of the <see cref="RunCoordinator"/> class.</summary>
    /// <param name="runners">The runners to route by <see cref="IScenarioRunner.Kind"/>.</param>
    /// <param name="assertions">The registry every transcript is graded through.</param>
    /// <param name="participants">The source of a fresh participant for each run.</param>
    /// <param name="clock">The clock the artifact's timestamp comes from.</param>
    /// <param name="seeds">The source of the seed each run is driven with.</param>
    /// <param name="options">The throttle, and what may be written into the artifact.</param>
    /// <param name="logger">
    /// Where terminal failures are signalled, in addition to the artifact. Only ever handed text
    /// this library composed — never a message, endpoint, or identifier authored elsewhere (§V).
    /// </param>
    /// <exception cref="ArgumentNullException">Any argument is null.</exception>
    /// <exception cref="ArgumentException">
    /// A runner is null, or two runners conduct the same <see cref="ScenarioKind"/>.
    /// </exception>
    public RunCoordinator(
        IEnumerable<IScenarioRunner> runners,
        AssertionEvaluatorRegistry assertions,
        IParticipantFactory participants,
        IClock clock,
        ISeedSource seeds,
        RunCoordinatorOptions options,
        ILogger<RunCoordinator> logger
    )
    {
        ArgumentNullException.ThrowIfNull(runners);
        ArgumentNullException.ThrowIfNull(assertions);
        ArgumentNullException.ThrowIfNull(participants);
        ArgumentNullException.ThrowIfNull(clock);
        ArgumentNullException.ThrowIfNull(seeds);
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(logger);

        foreach (var runner in runners)
        {
            if (runner is null)
            {
                throw new ArgumentException("A scenario runner must not be null.", nameof(runners));
            }

            if (!_runners.TryAdd(runner.Kind, runner))
            {
                throw new ArgumentException(
                    $"More than one runner conducts '{runner.Kind}' scenarios. Which one ran would depend on "
                        + "registration order, so the ambiguity is refused rather than resolved.",
                    nameof(runners)
                );
            }
        }

        _assertions = assertions;
        _participants = participants;
        _clock = clock;
        _seeds = seeds;
        _options = options;
        _logger = logger;
    }

    /// <summary>Conducts every scenario in the suite and returns the durable artifact.</summary>
    /// <param name="suite">The validated suite to run.</param>
    /// <param name="cancellationToken">Cancels the suite.</param>
    /// <returns>
    /// The artifact: one <see cref="ScenarioResult"/> per scenario in suite order, each carrying
    /// one <see cref="RunResult"/> per repetition in repetition order.
    /// </returns>
    /// <remarks>
    /// <para>
    /// Never returns partially. A cancelled suite throws rather than handing back the runs that
    /// happened to finish first, because an artifact is read as a complete account of a run and
    /// there is nothing in its shape that could say otherwise.
    /// </para>
    /// <para>
    /// The whole plan is settled before anything is dispatched, and the conditions that would
    /// make the artifact untrustworthy are refused there rather than recorded: a duplicate
    /// scenario id, a seed source that repeats a seed within a scenario, and a plan larger than
    /// <see cref="RunCoordinatorOptions.MaxTotalRuns"/>. Refusing costs nothing at that point —
    /// no run has happened, so no evidence is destroyed — which is why these throw while a
    /// failure during a run is recorded.
    /// </para>
    /// </remarks>
    /// <exception cref="ArgumentNullException"><paramref name="suite"/> is null.</exception>
    /// <exception cref="ArgumentException">
    /// Two scenarios declare the same id, or the suite plans more runs than
    /// <see cref="RunCoordinatorOptions.MaxTotalRuns"/> allows.
    /// </exception>
    /// <exception cref="InvalidOperationException">
    /// The <see cref="ISeedSource"/> issued the same seed more than once within one scenario, so
    /// its repetitions could not be told apart.
    /// </exception>
    /// <exception cref="OperationCanceledException"><paramref name="cancellationToken"/> was cancelled.</exception>
    public async Task<SuiteResult> RunAsync(Suite suite, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(suite);
        cancellationToken.ThrowIfCancellationRequested();

        var startedAt = _clock.UtcNow;
        var results = new RunResult[suite.Scenarios.Count][];
        var plan = new List<PlannedRun>();
        var identifiers = new HashSet<string>(StringComparer.Ordinal);
        var totalRuns = 0L;

        // The plan — including every seed — is settled here, on one thread, in suite order.
        // Drawing a seed inside a worker would make it depend on scheduling, and ISeedSource is
        // not required to be thread-safe.
        for (var index = 0; index < suite.Scenarios.Count; index++)
        {
            // Planning is O(total runs) and allocates as it goes, so it observes the token too.
            // A caller who cancelled must not wait for a large plan to finish being built.
            cancellationToken.ThrowIfCancellationRequested();

            var scenario = suite.Scenarios[index];

            // Attribution rests on the scenario id being unique: a transcript is matched to its
            // run by that id, so two scenarios sharing one make a transcript from either satisfy
            // the check for both. SuiteLoader already refuses this ('scenario.id.duplicate'), but
            // a Suite can be constructed directly, and the artifact would file two scenarios
            // under one join key regardless. Refused here rather than trusted upstream.
            if (!identifiers.Add(scenario.Identity.Id))
            {
                throw new ArgumentException(
                    $"More than one scenario in the suite declares id '{scenario.Identity.Id}'. That id is the key "
                        + "each run is filed and compared under, so a transcript returned for either scenario would "
                        + "be attributed to both. Nothing has been dispatched, so the suite is refused rather than "
                        + "run.",
                    nameof(suite)
                );
            }

            // RepetitionPolicy refuses anything below one, so this always plans at least one run
            // and 'run once' needs no branch of its own. It does not cap the count, though: a
            // policy of int.MaxValue is valid and would exhaust memory in the allocation below
            // before the token was ever consulted again. Budgeted *before* allocating, so the
            // refusal costs nothing (§IV).
            var repetitions = scenario.Execution.RepetitionPolicy.Repetitions;

            totalRuns += repetitions;

            if (totalRuns > _options.MaxTotalRuns)
            {
                throw new ArgumentException(
                    $"The suite plans more than {Render(_options.MaxTotalRuns)} runs, which is the budget this "
                        + $"coordinator was configured with. Scenario '{scenario.Identity.Id}' declares "
                        + $"{Render(repetitions)} repetition(s). A plan is allocated in full before anything is "
                        + "dispatched, so it is refused here rather than allowed to exhaust memory. Raise "
                        + $"{nameof(RunCoordinatorOptions)}.{nameof(RunCoordinatorOptions.MaxTotalRuns)} if the "
                        + "suite is genuinely this large.",
                    nameof(suite)
                );
            }

            results[index] = new RunResult[repetitions];

            // A seed is the other half of a run's identity. ISeedSource is injected, so nothing
            // here guarantees the sequence is distinct — and a source that repeats one within a
            // scenario makes two repetitions carry identical identity, at which point a replayed
            // transcript satisfies every check the second run applies and is graded as an
            // independent sample. Verified rather than assumed (§V).
            var drawn = new HashSet<long>();

            for (var repetition = 0; repetition < repetitions; repetition++)
            {
                cancellationToken.ThrowIfCancellationRequested();

                var seed = _seeds.NextSeed();

                if (!drawn.Add(seed))
                {
                    throw new InvalidOperationException(
                        $"{_seeds.GetType().Name} issued seed {Render(seed)} more than once for scenario "
                            + $"'{scenario.Identity.Id}'. A run is attributed by its scenario id and its seed, so "
                            + "two repetitions sharing both are indistinguishable: a transcript from the first "
                            + "would be graded as the second without anything noticing. The repetitions would also "
                            + "not be independent samples. Nothing has been dispatched, so the suite is refused."
                    );
                }

                plan.Add(new PlannedRun(index, repetition, scenario, seed));
            }
        }

        // Which participant instances this suite has already handed to a run. The factory
        // contract says "a participant for this run alone", but calling it once per run does not
        // establish that it returned a fresh one — a factory handing back a singleton defeats the
        // whole defence while the results still grade as independent samples. Tracked by
        // reference, because a stateful participant is exactly the case that matters and value
        // equality would not see it (§V).
        var claimed = new ConcurrentDictionary<object, byte>(ReferenceEqualityComparer.Instance);

        await Parallel
            .ForEachAsync(
                plan,
                new ParallelOptions
                {
                    // A hard ceiling on runs in flight, enforced by the scheduler rather than by
                    // bookkeeping of our own. The suite is the unit it applies to, not one
                    // scenario — the system under test sees the total.
                    MaxDegreeOfParallelism = _options.MaxConcurrency,
                    CancellationToken = cancellationToken,
                },
                async (planned, token) =>
                {
                    // Each run owns one slot, written exactly once and read only after every
                    // worker has finished. No shared accumulator, so nothing can land against
                    // another run's scenario however the workers interleave.
                    results[planned.ScenarioIndex][planned.RepetitionIndex] = await ConductAsync(
                            planned,
                            claimed,
                            token
                        )
                        .ConfigureAwait(false);
                }
            )
            .ConfigureAwait(false);

        return Assemble(suite, results, startedAt);
    }

    /// <summary>One planned run: which scenario, which repetition, and the seed for it.</summary>
    private sealed record PlannedRun(int ScenarioIndex, int RepetitionIndex, Scenario Scenario, long Seed)
    {
        /// <summary>Gets the one-based repetition number within the scenario.</summary>
        public int Repetition => RepetitionIndex + 1;
    }

    private async Task<RunResult> ConductAsync(
        PlannedRun planned,
        ConcurrentDictionary<object, byte> claimed,
        CancellationToken cancellationToken
    )
    {
        var scenario = planned.Scenario;

        if (!_runners.TryGetValue(scenario.Identity.Kind, out var runner))
        {
            // Recorded rather than thrown, by the same reasoning as an unsupported transport: an
            // undeclared gap is the same fact as a declared one, less honestly stated, and
            // refusing the suite would destroy the evidence every other scenario produced. There
            // is no false-green risk in recording it — no transcript exists to be mis-graded.
            return Unconducted(
                planned,
                $"No runner is registered for scenario kind '{scenario.Identity.Kind}', so scenario "
                    + $"'{scenario.Identity.Id}' was never conducted and this run carries no evidence about the "
                    + "system under test. Register a runner for that kind, or remove the scenario from the suite."
            );
        }

        IParticipant participant;

        try
        {
            participant = _participants.Create(scenario, planned.Seed, planned.Repetition);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (OperationCanceledException exception)
        {
            // Our token is not cancelled, so nobody abandoned this run: something inside the
            // factory cancelled work of its own. That is a statement about the harness, not about
            // the caller, so it is recorded like any other failure to build a caller.
            return Unconducted(planned, Blame(CouldNotBuildCaller(), exception));
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            return Unconducted(planned, Blame(CouldNotBuildCaller(), exception));
        }

        if (participant is null)
        {
            return Unconducted(
                planned,
                $"{_participants.GetType().Name}.Create returned no participant for scenario "
                    + $"'{scenario.Identity.Id}', so there was nothing to drive the run with. A factory that "
                    + "cannot build a caller is a defect in the factory rather than a property of this run."
            );
        }

        // Claimed before the runner is invoked, never after. A run that inherited another's
        // participant must not drive it: under concurrency both would be driving one stateful
        // caller at once, and the run that won the race would then be graded on a transcript the
        // loser had corrupted. Refusing first leaves the instance to exactly one run.
        if (!claimed.TryAdd(participant, 0))
        {
            return Unconducted(
                planned,
                $"{_participants.GetType().Name}.Create returned a participant this suite had already handed to "
                    + $"another run ({participant.GetType().Name}). A participant is built per run so that one run "
                    + "cannot inherit another's state: sharing one makes a repetition a continuation of the "
                    + "previous one rather than an independent sample, and under concurrency it has no defined "
                    + "behaviour at all. The run is recorded as ungradeable rather than graded as independent."
            );
        }

        Transcript? transcript;

        try
        {
            transcript = await runner
                .RunAsync(
                    scenario,
                    new RunContext
                    {
                        Participant = participant,
                        Seed = planned.Seed,
                        Repetition = planned.Repetition,
                    },
                    cancellationToken
                )
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // The caller abandoned the suite. Recording a result for a run nobody waited for
            // would put it in an artifact that reads as a complete account, so this is the one
            // failure that propagates.
            throw;
        }
        catch (OperationCanceledException exception)
        {
            // Our token is not cancelled, so this is not the caller abandoning the run — it is
            // the transport reporting its own timeout, which arrives in exactly this shape.
            return Unconducted(
                planned,
                Blame($"{runner.GetType().Name} reported a cancellation this suite did not request", exception)
            );
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            return Unconducted(planned, Blame($"{runner.GetType().Name} failed while conducting the run", exception));
        }

        if (transcript is null)
        {
            return Unconducted(
                planned,
                $"{runner.GetType().Name}.RunAsync returned no transcript for scenario '{scenario.Identity.Id}'. "
                    + "A runner that conducts a run must say what happened, even when what happened was nothing."
            );
        }

        if (DescribeMalformedShape(transcript) is { } malformed)
        {
            // Checked before anything dereferences it. Grading reads the transport attributes,
            // the outcome, and the turns, so a transcript missing any of them threw from inside
            // GradeAsync — outside the catch above, which aborted every other scenario in a mixed
            // suite. A runner that returns a shape nothing can grade is a harness fault like any
            // other, and is recorded as one.
            return Unconducted(planned, malformed);
        }

        if (DescribeMisattribution(planned, transcript) is { } misattribution)
        {
            return Unconducted(planned, misattribution);
        }

        return await GradeAsync(planned, Sanitized(transcript), cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// How a returned transcript is shaped such that grading it would throw, or
    /// <see langword="null"/> when it can be graded.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <see cref="Transcript"/> defaults every one of these members, so a well-behaved runner
    /// never trips this. A runner is an injected collaborator, though, and an <c>init</c> default
    /// is not a guarantee: any of them can be set back to null. The members named here are
    /// precisely the ones the grading path dereferences.
    /// </para>
    /// <para>
    /// Recorded rather than thrown, by the same reasoning as every other runner fault: one
    /// runner returning an ungradeable shape must not decide whether the rest of the suite
    /// produces evidence at all.
    /// </para>
    /// </remarks>
    private static string? DescribeMalformedShape(Transcript transcript)
    {
        var missing = transcript switch
        {
            { Transport: null } => $"no {nameof(Transcript.Transport)}",
            { Transport.Attributes: null } => $"no {nameof(TransportMetadata.Attributes)}",
            { Outcome: null } => $"no {nameof(Transcript.Outcome)}",
            { Outcome.Fields: null } => $"no {nameof(Outcome.Fields)}",
            { Turns: null } => $"no {nameof(Transcript.Turns)}",
            _ when transcript.Turns.Any(turn => turn is null) => "a null turn",
            _ => null,
        };

        return missing is null
            ? null
            : $"The runner returned a transcript with {missing}. Grading reads the transport attributes, the "
                + "outcome, and the turns to decide whether the run gathered evidence at all, so a transcript "
                + "missing any of them cannot be graded — and grading it anyway would fail in a way that took "
                + "down every other scenario in the suite. It is refused rather than graded.";
    }

    /// <summary>
    /// The transcript as it may be committed: the same one, with any address it names stripped of
    /// the parts that carry credentials.
    /// </summary>
    /// <remarks>
    /// A runner in this library already sanitizes the endpoints it resolves itself, but
    /// <see cref="IScenarioRunner"/> is an injected seam and a transcript arriving through it has
    /// only been vouched for by whoever wrote that runner. The artifact is committed and attached
    /// to pull requests, so the rule is applied once more here, by the same single implementation
    /// rather than a second reading of it (§V). The transcript is rewritten only when the address
    /// actually changes, so a well-behaved runner's transcript travels through untouched.
    /// </remarks>
    private static Transcript Sanitized(Transcript transcript)
    {
        var endpoint = RunnerSupport.SanitizeEndpoint(transcript.Transport.Endpoint);

        return string.Equals(endpoint, transcript.Transport.Endpoint, StringComparison.Ordinal)
            ? transcript
            : transcript with
            {
                Transport = transcript.Transport with { Endpoint = endpoint },
            };
    }

    /// <summary>
    /// How a returned transcript fails to describe the run it was returned for, or
    /// <see langword="null"/> when it describes it correctly.
    /// </summary>
    /// <remarks>
    /// This is the guard against the one failure mode aggregation uniquely introduces: evidence
    /// from one context graded as though it came from another. The scenario identifier is the
    /// join key a baseline artifact is matched on, and the seed is what makes a run reproducible
    /// and a comparison genuinely paired — a transcript carrying either from somewhere else would
    /// grade exactly like a real one, so it is refused rather than run through the evaluators.
    /// </remarks>
    private static string? DescribeMisattribution(PlannedRun planned, Transcript transcript)
    {
        var expected = planned.Scenario.Identity.Id;

        if (!string.Equals(transcript.ScenarioId, expected, StringComparison.Ordinal))
        {
            return $"The runner returned a transcript for a different scenario than '{expected}' "
                + $"({RunnerSupport.Redact(transcript.ScenarioId)}). The identifier is the key this run is filed "
                + "and compared under, so grading that transcript would judge one scenario's behaviour against "
                + "another scenario's assertions. It is refused rather than graded.";
        }

        if (transcript.Seed != planned.Seed)
        {
            return $"The runner returned a transcript stamped with seed {Render(transcript.Seed)} for run "
                + $"{Render(planned.Repetition)} of '{expected}', which was driven with seed "
                + $"{Render(planned.Seed)}. A run that cannot be reproduced from the seed recorded beside it "
                + "cannot be paired against a baseline either, so it is refused rather than graded.";
        }

        return null;
    }

    private async Task<RunResult> GradeAsync(
        PlannedRun planned,
        Transcript transcript,
        CancellationToken cancellationToken
    )
    {
        var state = ExchangeState.Of(transcript);

        if (ExchangeState.IsHarnessFailure(state))
        {
            // Not graded at all. Evaluating assertions against a run that gathered nothing would
            // record verdicts about a system that was never successfully asked, and any consumer
            // reading 'not Fail' as 'no regression' would then report the suite as clean.
            var ungradeable = Ungradeable(planned, transcript, state);

            // Logged once, here, where the run is terminally decided ungradeable — the artifact
            // is durable but a caller watching a suite run sees nothing in it until the end
            // (§IV). Warning rather than Error: the commonest cause is a *declared* gap such as
            // an unsupported transport, and a suite that legitimately contains one must not read
            // as broken. A failure the coordinator itself reaches is logged at Error below.
            LogRunNotGraded(planned.Repetition, planned.Scenario.Identity.Id, ungradeable);

            return new RunResult
            {
                Transcript = transcript,
                Status = RunStatus.Error,
                ErrorDetail = ungradeable,
            };
        }

        var context = new EvaluationContext
        {
            ScenarioId = planned.Scenario.Identity.Id,
            Grading = planned.Scenario.Grading,
            Transcript = transcript,

            // Resolving a baseline is IBaselineProvider's job and has no implementation yet, so
            // baseline:* assertions refuse themselves rather than comparing against nothing.
            Baseline = null,
        };
        var verdicts = new List<AssertionResult>(planned.Scenario.Grading.Assertions.Count);
        var evaluating = (AssertionSpec?)null;

        try
        {
            foreach (var assertion in planned.Scenario.Grading.Assertions)
            {
                evaluating = assertion;

                verdicts.Add(
                    await _assertions.EvaluateAsync(assertion, context, cancellationToken).ConfigureAwait(false)
                );
            }
        }
        catch (AssertionEvaluationException exception)
        {
            // An un-evaluable assertion is a refusal, not a verdict — the line the evaluators
            // already draw. The verdicts reached before it are dropped rather than reported,
            // because a partial set read as a complete one is the same false green in miniature.
            //
            // The message is NOT recorded. AssertionEvaluatorRegistry is injected, so this text
            // is composed by whichever evaluator threw — not necessarily one of this library's —
            // and it is written into a committed artifact. What a reader actually needs is which
            // assertion was refused, and that comes from the suite file rather than from the
            // evaluator: it is the caller's own text, already committed beside the scenario. The
            // evaluator's message is reduced to a fingerprint, which still tells two refusals
            // apart and recognises the same one recurring (§V).
            var refusal =
                $"Run {Render(planned.Repetition)} of scenario '{planned.Scenario.Identity.Id}' could not be "
                + $"graded: assertion '{evaluating?.ToExpression() ?? "(none)"}' was refused by "
                + $"{exception.GetType().Name} {RunnerSupport.Redact(exception.Message)}. The message is not "
                + "recorded, because it is authored by the evaluator rather than by this library and this "
                + "artifact is committed.";

            LogRunRefusedByEvaluator(planned.Repetition, planned.Scenario.Identity.Id, refusal);

            return new RunResult
            {
                Transcript = transcript,
                Status = RunStatus.Error,
                ErrorDetail = refusal,
            };
        }

        return new RunResult
        {
            Transcript = transcript,
            AssertionResults = verdicts,

            // Vacuously true for a scenario that declares no assertions: it asserted nothing, and
            // nothing it asserted failed.
            Status = verdicts.TrueForAll(verdict => verdict.Pass) ? RunStatus.Pass : RunStatus.Fail,
        };
    }

    /// <summary>
    /// The result for a run the harness could not conduct: an ungradeable transcript and a stated
    /// reason.
    /// </summary>
    /// <remarks>
    /// A transcript is produced even though nothing ran, so that the artifact carries one run per
    /// planned run and no consumer has to reason about a missing one. It observes nothing, claims
    /// no transport, and records <see cref="ExchangeState.RunnerFailed"/>, which
    /// <see cref="ExchangeState.IsHarnessFailure(string?)"/> classifies with the other states
    /// that gathered no evidence.
    /// </remarks>
    private RunResult Unconducted(PlannedRun planned, string failure)
    {
        // The one terminal point for every failure the coordinator itself reaches, so logging
        // here is exactly one signal per root cause (§IV). `failure` is composed by this library
        // and carries no text of unknown provenance — the callers that handle untrusted material
        // redact it before it ever gets here — so it is as safe in a log as it is in the
        // artifact.
        LogRunNotConducted(planned.Repetition, planned.Scenario.Identity.Id, failure);

        return new()
        {
            Transcript = new Transcript
            {
                ScenarioId = planned.Scenario.Identity.Id,
                Seed = planned.Seed,
                StartedAt = _clock.UtcNow,
                Duration = TimeSpan.Zero,
                Turns = [],
                Outcome = new Outcome(),
                Transport = new TransportMetadata
                {
                    // No transport was reached, so none is named and no address is claimed.
                    Kind = null,
                    Endpoint = null,
                    Attributes = RunnerSupport.Attributes(
                        fromAdapter: NothingObserved,
                        observed: NothingObserved,
                        exchange: ExchangeState.RunnerFailed,
                        stoppedBy: StopReason.RunnerFailed,
                        failure: failure
                    ),
                },
            },
            Status = RunStatus.Error,
            ErrorDetail = failure,
        };
    }

    /// <summary>Why a run that did reach the system under test still cannot be graded.</summary>
    /// <remarks>
    /// The runner's stated reason is quoted. That text is written by a runner rather than by this
    /// layer, but it already travels into the artifact inside the transcript's
    /// <see cref="TransportAttributes.Failure"/> attribute, so repeating it here exposes nothing
    /// new — the runners in this library compose it under the same rule (§V).
    /// </remarks>
    private static string Ungradeable(PlannedRun planned, Transcript transcript, string? state) =>
        $"Run {Render(planned.Repetition)} of scenario '{planned.Scenario.Identity.Id}' recorded exchange "
        + $"'{state ?? "(none recorded)"}', so the harness gathered no evidence about the system under test and "
        + "this run's assertions were not evaluated: a verdict about a system that was never successfully asked "
        + "is not a verdict. "
        + (
            transcript.Transport.Attributes.TryGetValue(TransportAttributes.Failure, out var stated)
            && !string.IsNullOrWhiteSpace(stated)
                ? stated
                : "The runner stated no reason."
        );

    /// <summary>
    /// Describes a failure in terms the coordinator can vouch for.
    /// </summary>
    /// <remarks>
    /// An exception's message is authored by whatever threw it — a runner, an adapter, an SDK,
    /// the framework — and routinely names the endpoint, deployment, or connection string it
    /// failed on. This value is written into a committed artifact, so it carries what failed and
    /// the type that reported it, never the message (§V). The runners make the same choice, and
    /// the opt-in they offer has no analogue here: this layer never sees a response body, so
    /// there is nothing a caller could usefully turn back on.
    /// </remarks>
    private static string Blame(string summary, Exception exception) =>
        $"Scenario could not be conducted: {summary} ({exception.GetType().Name}). The exception's message is "
        + "not recorded, because it is authored elsewhere and this artifact is committed.";

    private string CouldNotBuildCaller() =>
        $"the participant for this run could not be built by {_participants.GetType().Name}";

    private SuiteResult Assemble(Suite suite, RunResult[][] results, DateTimeOffset startedAt)
    {
        var scenarios = new List<ScenarioResult>(suite.Scenarios.Count);
        var dimensions = new SortedSet<string>(StringComparer.Ordinal);

        for (var index = 0; index < suite.Scenarios.Count; index++)
        {
            var scenario = suite.Scenarios[index];
            dimensions.UnionWith(scenario.Slicing.Tags.Keys);

            scenarios.Add(
                new ScenarioResult
                {
                    ScenarioId = scenario.Identity.Id,
                    Kind = scenario.Identity.Kind,
                    Runs = results[index],
                    RepetitionPolicyUsed = scenario.Execution.RepetitionPolicy,
                    Tags = new Dictionary<string, string>(scenario.Slicing.Tags, StringComparer.Ordinal),

                    // Repetition is collapsed here, which is the first point results from more
                    // than one run of one scenario sit together. The aggregator withholds the
                    // summary entirely when no run produced a gradeable verdict, so a scenario
                    // that only ever errored still reports no pass rate rather than a zero it
                    // did not measure.
                    Summary = _options.Aggregator.Summarize(results[index]),
                }
            );
        }

        return new SuiteResult
        {
            SuiteName = suite.Name,
            ScenarioResults = scenarios,
            SlicingDimensions = [.. dimensions],
            Environment = new EvaluationEnvironment
            {
                // Stripped by the one implementation every runner already uses, rather than by a
                // second reading of the same rule (§V).
                Endpoint = RunnerSupport.SanitizeEndpoint(_options.Endpoint),

                // Resolving a baseline reference is IBaselineProvider's job and has no
                // implementation yet, so nothing is claimed here.
                BaselineRef = null,
                Seed = _seeds.RootSeed,
                Timestamp = startedAt,
                HarnessConfig = new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    // The throttle changes what a run against a rate-limited system observes, so
                    // a reader trying to reproduce the run needs the figure it ran under.
                    ["maxConcurrency"] = Render(_options.MaxConcurrency),

                    // An interval is uninterpretable without the confidence level it was
                    // computed at, and ConfidenceInterval has nowhere to carry one — adding a
                    // member would churn a schema T3 deliberately fixed in advance. It goes here
                    // instead, named the same way the artifact names the method itself so the
                    // two read as one setting.
                    ["intervalMethod"] = JsonNamingPolicy.CamelCase.ConvertName(
                        _options.Aggregator.IntervalMethod.ToString()
                    ),
                    ["intervalConfidence"] = _options.Aggregator.ConfidenceLevel.ToString(CultureInfo.InvariantCulture),
                },
            },
        };
    }

    private static string Render(long value) => value.ToString(CultureInfo.InvariantCulture);

    // The three terminal signals, as source-generated delegates rather than formatted calls
    // (CA1848). Every argument is composed by this library: callers redact anything of unknown
    // provenance before it reaches these, because a log line is as committed as the artifact
    // (§V).

    [LoggerMessage(
        EventId = 1000,
        Level = LogLevel.Error,
        Message = "Run {Repetition} of scenario {ScenarioId} could not be conducted: {Detail}"
    )]
    private partial void LogRunNotConducted(int repetition, string scenarioId, string detail);

    [LoggerMessage(
        EventId = 1001,
        Level = LogLevel.Warning,
        Message = "Run {Repetition} of scenario {ScenarioId} gathered no evidence and was not graded: {Detail}"
    )]
    private partial void LogRunNotGraded(int repetition, string scenarioId, string detail);

    [LoggerMessage(
        EventId = 1002,
        Level = LogLevel.Error,
        Message = "Run {Repetition} of scenario {ScenarioId} could not be graded: {Detail}"
    )]
    private partial void LogRunRefusedByEvaluator(int repetition, string scenarioId, string detail);
}
