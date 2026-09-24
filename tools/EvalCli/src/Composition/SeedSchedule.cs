using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Scenarios;

namespace Forge.EvalCli.Composition;

/// <summary>
/// The seed sequence one invocation draws from, pinned to the suite <b>as declared</b> rather
/// than to the scenarios that happen to run.
/// </summary>
/// <remarks>
/// <para>
/// <b>A narrowed run is not a full run with gaps; it is a shorter run.</b> The coordinator draws
/// one seed per planned repetition, sequentially, in suite order — so removing a scenario from
/// the suite before handing it over does not leave a hole, it shifts every draw after it. A
/// scenario that follows a skipped one is then driven with a seed the baseline recorded against a
/// different scenario entirely.
/// </para>
/// <para>
/// <b>That shift lands on the one guard that cannot absorb it.</b> The comparison is paired by
/// seed, deliberately, because two runs driven differently are not matched observations. So a
/// selected scenario whose seed moved compares as not-comparable against its own baseline — the
/// narrowing silently un-examines exactly the scenarios the narrowing was for. Once a refused
/// pair is fatal to a run, that is no longer a quiet degradation either.
/// </para>
/// <para>
/// <b>The fix is to keep the schedule, not to widen the run.</b> The full suite's draws are
/// computed here, in declared order, and only the ones belonging to the conducted scenarios are
/// handed out. A run that conducts everything gets exactly the sequence it always did; a narrowed
/// run gets the subsequence the same root seed would have produced for those scenarios in a full
/// run. Falling back to a full run would work too, and would spend the selection's entire value
/// to do it.
/// </para>
/// <para>
/// <b>Pinned once per invocation, and read by both harnesses.</b> A live baseline conducts the
/// same narrowed suite through a second coordinator, and both resolve <see cref="ISeedSource"/>
/// from here — so the two sides of a paired comparison cannot end up on different schedules.
/// </para>
/// </remarks>
internal sealed class SeedSchedule
{
    private readonly long _rootSeed;
    private long[]? _pinned;

    /// <summary>Initializes a new instance of the <see cref="SeedSchedule"/> class.</summary>
    /// <param name="rootSeed">The root seed every sequence is derived from.</param>
    public SeedSchedule(long rootSeed) => _rootSeed = rootSeed;

    /// <summary>
    /// Pins the schedule to the suite as declared and the scenarios that will actually run.
    /// </summary>
    /// <param name="declared">The suite as loaded, before any narrowing.</param>
    /// <param name="conducted">The identifiers of the scenarios that will be conducted.</param>
    /// <remarks>
    /// The repetition count comes from each scenario's declared policy, which is what the
    /// coordinator plans from — reading anything else here would produce a schedule that is a
    /// plausible length and wrong from the first skipped scenario onwards.
    /// </remarks>
    /// <exception cref="ArgumentNullException">Any argument is null.</exception>
    public void PinTo(Suite declared, IReadOnlyCollection<string> conducted)
    {
        ArgumentNullException.ThrowIfNull(declared);
        ArgumentNullException.ThrowIfNull(conducted);

        var selected = conducted.ToHashSet(StringComparer.Ordinal);
        var full = new DeterministicSeedSource(_rootSeed);
        var schedule = new List<long>();

        foreach (var scenario in declared.Scenarios)
        {
            var runs = scenario.Execution.RepetitionPolicy.Repetitions;
            var keep = selected.Contains(scenario.Identity.Id);

            for (var repetition = 0; repetition < runs; repetition++)
            {
                var seed = full.NextSeed();

                if (keep)
                {
                    schedule.Add(seed);
                }
            }
        }

        _pinned = [.. schedule];
    }

    /// <summary>Produces a source for one suite run.</summary>
    /// <returns>A fresh source replaying the pinned schedule.</returns>
    /// <remarks>
    /// One per suite run, never shared: <see cref="ISeedSource"/> is not thread-safe by contract,
    /// and a shared one would make the seed a scenario was driven with depend on scheduling.
    /// </remarks>
    public ISeedSource Create() =>
        _pinned is { } schedule ? new PinnedSeedSource(_rootSeed, schedule) : new DeterministicSeedSource(_rootSeed);

    /// <summary>Replays a settled schedule, and refuses to invent one past its end.</summary>
    /// <remarks>
    /// Running out means the coordinator planned more runs than the schedule was pinned for,
    /// which means the two disagree about what is being conducted. Falling back to a fresh draw
    /// there would produce a run that looks ordinary and pairs against nothing, so it throws
    /// instead (§IV).
    /// </remarks>
    private sealed class PinnedSeedSource(long rootSeed, IReadOnlyList<long> schedule) : ISeedSource
    {
        private int _drawn;

        public long RootSeed { get; } = rootSeed;

        public long NextSeed() =>
            _drawn < schedule.Count
                ? schedule[_drawn++]
                : throw new InvalidOperationException(
                    "The run asked for more seeds than the schedule this invocation pinned. The schedule is built "
                        + "from the suite as declared and the scenarios selected from it, so exhausting it means "
                        + "the coordinator is conducting something the selection did not describe. A fresh draw "
                        + "here would produce a run that pairs against nothing in any baseline."
                );
    }
}
