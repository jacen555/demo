using Forge.EvalEngine.Statistics;

namespace Forge.EvalEngine.Coordination;

/// <summary>
/// How a <see cref="RunCoordinator"/> conducts a suite, and what it may write into the artifact.
/// </summary>
/// <remarks>
/// A suite result is committed, diffed, and attached to pull requests, so the defaults here are
/// the conservative ones and a caller asks for more explicitly (§V).
/// </remarks>
public sealed record RunCoordinatorOptions
{
    private readonly int _maxConcurrency = 1;
    private readonly int _maxTotalRuns = DefaultMaxTotalRuns;
    private readonly ScenarioAggregator _aggregator = ScenarioAggregator.Default;

    /// <summary>The run budget a caller gets without asking for one.</summary>
    private const int DefaultMaxTotalRuns = 100_000;

    /// <summary>Gets the conservative defaults every constructor overload uses.</summary>
    public static RunCoordinatorOptions Default { get; } = new();

    /// <summary>
    /// Gets the greatest number of runs that may be in flight at once. One by default.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>This is a hard ceiling, not a target.</b> The coordinator is frequently pointed at a
    /// system somebody else operates, and it is also the lever for deliberately exercising that
    /// system's own throttling — a suite that asserts on a 429 is asserting about the load this
    /// number produced. A ceiling that was approximate would make both of those dishonest, so the
    /// count of in-flight runs never exceeds it.
    /// </para>
    /// <para>
    /// The default of one is deliberate. Concurrency against a real system is a decision with
    /// consequences for whoever runs it, so it is opted into rather than inherited.
    /// </para>
    /// </remarks>
    /// <exception cref="ArgumentOutOfRangeException">The value is less than one.</exception>
    public int MaxConcurrency
    {
        get => _maxConcurrency;
        init
        {
            ArgumentOutOfRangeException.ThrowIfLessThan(value, 1);

            _maxConcurrency = value;
        }
    }

    /// <summary>
    /// Gets the greatest number of runs a whole suite may plan. One hundred thousand by default.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A repetition count only has to be positive to be valid, so a suite may legitimately
    /// declare <see cref="int.MaxValue"/> of them. The plan — a results array per scenario and
    /// one entry per run — is built before anything is dispatched, so a count that large
    /// exhausts memory during planning rather than failing as a run that did not happen. A
    /// budget checked <b>before</b> each allocation turns that into a stated refusal (§IV, §V).
    /// </para>
    /// <para>
    /// The default is high enough that no honest suite meets it and low enough that a typo in a
    /// repetition count is refused in constant time rather than taking the host down with it. A
    /// caller with a genuinely larger suite raises it deliberately, which is the same shape as
    /// <see cref="MaxConcurrency"/>: the consequential number is opted into.
    /// </para>
    /// </remarks>
    /// <exception cref="ArgumentOutOfRangeException">The value is less than one.</exception>
    public int MaxTotalRuns
    {
        get => _maxTotalRuns;
        init
        {
            ArgumentOutOfRangeException.ThrowIfLessThan(value, 1);

            _maxTotalRuns = value;
        }
    }

    /// <summary>
    /// Gets the address the suite was run against, recorded in the artifact so a reader can tell
    /// what was evaluated. Optional.
    /// </summary>
    /// <remarks>
    /// Stripped of its userinfo, query, and fragment before it is recorded, by the same single
    /// implementation every runner uses for the endpoints it resolves itself. A query string is
    /// where a bearer token or a SAS signature usually lives and an OAuth fragment carries an
    /// access token by design, so neither survives into a committed artifact (§V).
    /// </remarks>
    public string? Endpoint { get; init; }

    /// <summary>
    /// Gets how a scenario's repetitions are collapsed into a
    /// <see cref="Results.StatisticalSummary"/>. A Wilson interval at 95% confidence by default.
    /// </summary>
    /// <remarks>
    /// The confidence level and the interval method are reporting choices rather than execution
    /// ones, so they live here instead of growing the coordinator a set of statistics knobs.
    /// Whatever is configured is recorded in
    /// <see cref="Results.EvaluationEnvironment.HarnessConfig"/>: an interval without the level
    /// it was computed at is not interpretable, and <see cref="Results.ConfidenceInterval"/> has
    /// no room to carry one.
    /// </remarks>
    /// <exception cref="ArgumentNullException">The value is null.</exception>
    public ScenarioAggregator Aggregator
    {
        get => _aggregator;
        init
        {
            ArgumentNullException.ThrowIfNull(value);

            _aggregator = value;
        }
    }
}
