using System.Collections.Concurrent;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Coordination;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Tests.Runners;
using Forge.EvalEngine.Transcripts;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Forge.EvalEngine.Tests.Coordination;

/// <summary>What one run of a stub runner was asked to conduct.</summary>
internal sealed record RunRecord(string ScenarioId, long Seed, int Repetition, IParticipant Participant);

/// <summary>
/// A runner under the test's control. It records what it was handed, so a test can check that the
/// coordinator dispatched the run it claims to have dispatched.
/// </summary>
internal sealed class StubRunner : IScenarioRunner
{
    private readonly Func<Scenario, RunContext, CancellationToken, Task<Transcript>> _conduct;

    public StubRunner(
        ScenarioKind kind,
        Func<Scenario, RunContext, CancellationToken, Task<Transcript>>? conduct = null
    )
    {
        Kind = kind;
        _conduct =
            conduct ?? ((scenario, context, _) => Task.FromResult(CoordinatorFixtures.Transcript(scenario, context)));
    }

    public ScenarioKind Kind { get; }

    public ConcurrentQueue<RunRecord> Seen { get; } = new();

    public Task<Transcript> RunAsync(Scenario scenario, RunContext context, CancellationToken cancellationToken)
    {
        Seen.Enqueue(new RunRecord(scenario.Identity.Id, context.Seed, context.Repetition, context.Participant));

        return _conduct(scenario, context, cancellationToken);
    }
}

/// <summary>
/// A probe that counts how many runs are in flight at once, so the throttle is checked by
/// bookkeeping rather than by timing.
/// </summary>
/// <remarks>
/// <para>
/// Each run announces its arrival and then blocks. The first group is held <b>through</b> the
/// check for an extra dispatch rather than released the moment it forms: releasing at
/// <c>expectedPeak</c> would let an unbounded coordinator pass, because a run could leave before
/// the next one entered and the two would never be counted together.
/// </para>
/// <para>
/// With the whole group held, an unbounded coordinator has nothing to wait for and dispatches
/// <c>expectedPeak + 1</c>. <see cref="DispatchedWhileBlocked"/> records what it actually did.
/// That check needs a settle window, which is the one timed thing here — and it is timed in the
/// safe direction: a window that is too short can only let a breach go unnoticed, never invent
/// one. <see cref="Peak"/> remains the positive counter and never under-reports.
/// </para>
/// <para>
/// The in-flight count spans the whole runner body, including building the transcript, so a
/// brief overlap at the end of a run is still counted.
/// </para>
/// </remarks>
internal sealed class ConcurrencyProbeRunner(ScenarioKind kind, int expectedPeak) : IScenarioRunner
{
    private readonly TaskCompletionSource _released = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource _grouped = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int _inFlight;
    private int _peak;
    private int _started;
    private int _dispatchedWhileBlocked;
    private int _settled;

    public ScenarioKind Kind => kind;

    /// <summary>Gets the most runs this probe ever saw in flight at one time.</summary>
    public int Peak => Volatile.Read(ref _peak);

    /// <summary>Gets how many runs were dispatched to this probe.</summary>
    public int Started => Volatile.Read(ref _started);

    /// <summary>
    /// Gets how many runs had been dispatched at the moment the first full group was still
    /// blocked — the count an unbounded coordinator inflates.
    /// </summary>
    public int DispatchedWhileBlocked => Volatile.Read(ref _dispatchedWhileBlocked);

    public Task<Transcript> RunAsync(Scenario scenario, RunContext context, CancellationToken cancellationToken) =>
        ConductAsync(scenario, context, cancellationToken);

    private async Task<Transcript> ConductAsync(
        Scenario scenario,
        RunContext context,
        CancellationToken cancellationToken
    )
    {
        Interlocked.Increment(ref _started);
        var current = Interlocked.Increment(ref _inFlight);

        for (var observed = Volatile.Read(ref _peak); current > observed; observed = Volatile.Read(ref _peak))
        {
            if (Interlocked.CompareExchange(ref _peak, current, observed) == observed)
            {
                break;
            }
        }

        try
        {
            if (current >= expectedPeak)
            {
                _grouped.TrySetResult();
            }

            // Every run waits for the group to form. If the coordinator ran fewer than
            // expectedPeak concurrently nothing would ever form, so the wait is bounded and the
            // test fails rather than hangs.
            await _grouped.Task.WaitAsync(TimeSpan.FromSeconds(30), cancellationToken).ConfigureAwait(false);

            if (current >= expectedPeak && Interlocked.CompareExchange(ref _settled, 1, 0) == 0)
            {
                // The group is complete and still entirely blocked. Give an over-eager
                // coordinator room to dispatch the extra run it would, then record what it did
                // and only then release. One-shot: without the guard, a throttle of one would see
                // every subsequent run re-enter this branch and overwrite the measurement with a
                // count taken after the group had already been released.
                await Task.Delay(TimeSpan.FromMilliseconds(50), cancellationToken).ConfigureAwait(false);

                Volatile.Write(ref _dispatchedWhileBlocked, Volatile.Read(ref _started));
                _released.TrySetResult();
            }

            await _released.Task.WaitAsync(TimeSpan.FromSeconds(30), cancellationToken).ConfigureAwait(false);

            // A window in which an over-eager coordinator would start an extra run while this one
            // is still counted as in flight.
            await Task.Yield();

            return CoordinatorFixtures.Transcript(scenario, context);
        }
        finally
        {
            // Decremented only once the run's whole body is done, so the count covers the full
            // lifetime rather than ending early and missing a brief overlap.
            Interlocked.Decrement(ref _inFlight);
        }
    }
}

/// <summary>A participant factory under the test's control, recording every instance it minted.</summary>
internal sealed class StubParticipantFactory(Func<Scenario, long, int, IParticipant>? create = null)
    : IParticipantFactory
{
    public ConcurrentQueue<IParticipant> Created { get; } = new();

    public IParticipant Create(Scenario scenario, long seed, int repetition)
    {
        var participant = create is null ? new CountingParticipant() : create(scenario, seed, repetition);
        Created.Enqueue(participant);

        return participant;
    }
}

/// <summary>
/// A deliberately stateful participant: it says how many times it has been asked. Sharing one
/// across repetitions is therefore visible in the transcript rather than invisible.
/// </summary>
internal sealed class CountingParticipant : IParticipant
{
    private int _asks;

    public ValueTask<ParticipantTurn> NextAsync(Transcript transcriptSoFar, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        return new ValueTask<ParticipantTurn>(
            ParticipantTurn.Next($"ask {Interlocked.Increment(ref _asks)}", TurnProvenance.Scripted)
        );
    }
}

/// <summary>
/// A seed source that hands out the same seed every time — the collision the attribution check
/// cannot see through on its own.
/// </summary>
/// <remarks>
/// An <see cref="ISeedSource"/> is injected, so nothing in the coordinator's own code guarantees
/// the sequence is distinct. A source that repeats makes two runs of one scenario carry identical
/// identity, and a transcript replayed from the first then satisfies every check the second one
/// applies.
/// </remarks>
internal sealed class CollidingSeedSource(long seed = 4242) : ISeedSource
{
    private readonly long _seed = seed;

    public long RootSeed => _seed;

    public long NextSeed() => _seed;
}

/// <summary>
/// An evaluator that refuses every assertion with a message of its own authorship.
/// </summary>
/// <remarks>
/// The registry is injected, so the text of an <see cref="AssertionEvaluationException"/> is not
/// necessarily composed by this library. This stands in for a caller-supplied evaluator whose
/// message quotes material that must not reach a committed artifact.
/// </remarks>
internal sealed class RefusingEvaluator(string category, string message) : IAssertionEvaluator
{
    public string Category => category;

    public AssertionCategory Family => AssertionCategory.ExpectedBehavior;

    public ValueTask<AssertionResult> EvaluateAsync(
        AssertionSpec spec,
        EvaluationContext context,
        CancellationToken cancellationToken
    ) => throw new AssertionEvaluationException(message);
}

/// <summary>
/// An <see cref="ILogger{TCategoryName}"/> that keeps what it was told, so a test can check that
/// a terminal failure was signalled exactly once and carried nothing sensitive.
/// </summary>
internal sealed class RecordingLogger : ILogger<RunCoordinator>
{
    private readonly List<(LogLevel Level, string Message)> _entries = [];

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

    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(
        LogLevel logLevel,
        EventId eventId,
        TState state,
        Exception? exception,
        Func<TState, Exception?, string> formatter
    )
    {
        lock (_entries)
        {
            _entries.Add((logLevel, formatter(state, exception)));
        }
    }
}

/// <summary>A seed source whose sequence is a plain counter, so a test can predict it exactly.</summary>
internal sealed class CountingSeedSource(long rootSeed = 1000) : ISeedSource
{
    private long _next = rootSeed;
    private int _issued;

    public long RootSeed { get; } = rootSeed;

    /// <summary>Gets how many seeds have been handed out so far.</summary>
    public int Issued => Volatile.Read(ref _issued);

    public long NextSeed()
    {
        Interlocked.Increment(ref _issued);

        return Interlocked.Increment(ref _next);
    }
}

internal static class CoordinatorFixtures
{
    public static readonly DateTimeOffset Instant = TestData.FixedInstant;

    public static Scenario Scenario(
        string id = "scenario-a",
        ScenarioKind kind = ScenarioKind.Rest,
        int repetitions = 1,
        IEnumerable<string>? assertions = null,
        IReadOnlyDictionary<string, string>? tags = null,
        ExecutionMode mode = ExecutionMode.Deterministic,
        Simulation? simulation = null
    ) =>
        new()
        {
            Identity = new ScenarioIdentity { Id = id, Kind = kind },
            Execution = new Execution { Mode = mode, RepetitionPolicy = RepetitionPolicy.Repeat(repetitions) },
            Simulation = simulation ?? new Simulation(),
            Grading = new Grading { Assertions = [.. (assertions ?? []).Select(AssertionSpec.Parse)] },
            Slicing = new Slicing { Tags = tags ?? new Dictionary<string, string>(StringComparer.Ordinal) },
        };

    public static Suite Suite(params Scenario[] scenarios) =>
        new() { Name = "regression-suite", Scenarios = scenarios };

    public static Transcript Transcript(
        Scenario scenario,
        RunContext context,
        string exchange = ExchangeState.Responded,
        string stimulus = "opening stimulus",
        string? observedOutcome = "resolved",
        string? failure = null,
        string? scenarioId = null,
        long? seed = null
    )
    {
        var attributes = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [TransportAttributes.Exchange] = exchange,
            [TransportAttributes.StoppedBy] = StopReason.ParticipantComplete,
        };

        if (failure is not null)
        {
            attributes[TransportAttributes.Failure] = failure;
        }

        return new Transcript
        {
            ScenarioId = scenarioId ?? scenario.Identity.Id,
            Seed = seed ?? context.Seed,
            StartedAt = Instant,
            Turns =
            [
                new Turn
                {
                    Index = 1,
                    Stimulus = stimulus,
                    Response = "a response",
                    Provenance = TurnProvenance.Scripted,
                },
            ],
            Outcome = new Outcome
            {
                ObservedOutcome = observedOutcome,
                ObservedPath = "triage/resolve",
                Fields = new Dictionary<string, string?>(StringComparer.Ordinal) { ["scope/confirm"] = "yes" },
            },
            Transport = new TransportMetadata { Kind = "http", Attributes = attributes },
        };
    }

    /// <summary>A runner that asks its participant once and records what it offered.</summary>
    /// <remarks>
    /// This is how a shared participant becomes visible: a stateful caller asked twice says so,
    /// and the stimulus it offered travels into the transcript the coordinator attributes.
    /// </remarks>
    public static StubRunner AskingRunner(ScenarioKind kind = ScenarioKind.Rest) =>
        new(
            kind,
            async (scenario, context, token) =>
            {
                var offered = await context
                    .Participant.NextAsync(
                        new Transcript
                        {
                            ScenarioId = scenario.Identity.Id,
                            Seed = context.Seed,
                            StartedAt = Instant,
                        },
                        token
                    )
                    .ConfigureAwait(false);

                return Transcript(scenario, context, stimulus: offered.Stimulus ?? "(complete)");
            }
        );

    public static RunCoordinator Coordinator(
        IEnumerable<IScenarioRunner> runners,
        IParticipantFactory? participants = null,
        RunCoordinatorOptions? options = null,
        IClock? clock = null,
        ISeedSource? seeds = null,
        AssertionEvaluatorRegistry? assertions = null,
        ILogger<RunCoordinator>? logger = null
    ) =>
        new(
            runners,
            assertions ?? AssertionEvaluatorRegistry.CreateDefault(),
            participants ?? new StubParticipantFactory(),
            clock ?? new FrozenClock(Instant),
            seeds ?? new CountingSeedSource(),
            options ?? RunCoordinatorOptions.Default,
            logger ?? NullLogger<RunCoordinator>.Instance
        );

    /// <summary>Every run in the artifact, flattened in suite order.</summary>
    public static IEnumerable<Results.RunResult> Runs(Results.SuiteResult result) =>
        result.ScenarioResults.SelectMany(scenario => scenario.Runs);
}
