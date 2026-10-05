using Forge.EvalEngine.Results;

namespace Forge.EvalEngine.Coordination;

/// <summary>
/// One run of a suite has completed: which run it was, the verdict it was recorded with, and how
/// much of the suite's plan has now completed.
/// </summary>
/// <remarks>
/// <para>
/// The coordinator passes one to <see cref="IProgress{T}.Report(T)"/> on the sink handed to
/// <see cref="RunCoordinator.RunAsync(Scenarios.Suite, IProgress{RunProgress}, CancellationToken)"/>: one
/// call for every run that completes, whatever its verdict. A run the harness could not conduct still
/// completes, as <see cref="RunStatus.Error"/>, because the artifact records it like any other. The
/// call is what the coordinator controls. Whether a value then reaches a renderer is up to the sink,
/// which can throw, drop it, or hand it to another thread.
/// </para>
/// <para>
/// <b>The total is fixed before the first call.</b> The coordinator settles the whole plan before it
/// dispatches anything, so <see cref="Total"/> is the same on every report from one suite and a
/// renderer can draw a determinate bar rather than a spinner.
/// </para>
/// <para>
/// <b>Each count is assigned once; none is promised to arrive, or to arrive in order.</b>
/// <see cref="Completed"/> is counted atomically as each run finishes, so each count is assigned to
/// exactly one call, and a suite that runs to the end assigns every count from one to
/// <see cref="Total"/>. With <see cref="RunCoordinatorOptions.MaxConcurrency"/> above one, runs finish
/// on different workers, and a worker that counted seven can make its call after the one that counted
/// eight. Show the greatest <see cref="Completed"/> received, not the latest.
/// </para>
/// <para>
/// <b>A report is a notification, not evidence.</b> It carries the run's verdict rather than its
/// <see cref="RunResult"/>, because the call is made while the artifact is still being assembled and
/// a result is part of it: a consumer holding one would hold evidence that has not finished being
/// written. The <see cref="SuiteResult"/> that <c>RunAsync</c> returns is the record, and nothing
/// handed to a sink can change it.
/// </para>
/// <para>
/// <b>The last report is not the end of the suite.</b> A cancelled suite stops making calls where it
/// stopped running, so <see cref="Completed"/> can end short of <see cref="Total"/>. Whether the
/// suite finished is what <c>RunAsync</c> returning says.
/// </para>
/// </remarks>
public sealed record RunProgress
{
    /// <summary>Initializes a new instance of the <see cref="RunProgress"/> class.</summary>
    /// <param name="completed">How many of the suite's runs have completed, this one included.</param>
    /// <param name="total">How many runs the suite planned.</param>
    /// <param name="scenarioId">The id of the scenario the run belongs to.</param>
    /// <param name="repetition">Which repetition of the scenario the run was, counting from one.</param>
    /// <param name="status">The verdict the run was recorded with.</param>
    /// <exception cref="ArgumentOutOfRangeException">
    /// <paramref name="total"/> is below one; <paramref name="completed"/> is below one or above
    /// <paramref name="total"/>; <paramref name="repetition"/> is below one; or
    /// <paramref name="status"/> is not a defined <see cref="RunStatus"/>.
    /// </exception>
    /// <exception cref="ArgumentNullException"><paramref name="scenarioId"/> is null.</exception>
    public RunProgress(int completed, int total, string scenarioId, int repetition, RunStatus status)
    {
        // Only what the coordinator guarantees by construction is checked, so no value it produces
        // can be refused: a report is not allowed to fail the run it reports on.
        ArgumentOutOfRangeException.ThrowIfLessThan(total, 1);
        ArgumentOutOfRangeException.ThrowIfLessThan(completed, 1);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(completed, total);
        ArgumentNullException.ThrowIfNull(scenarioId);
        ArgumentOutOfRangeException.ThrowIfLessThan(repetition, 1);

        if (!Enum.IsDefined(status))
        {
            throw new ArgumentOutOfRangeException(nameof(status), status, "The status is not a defined RunStatus.");
        }

        Completed = completed;
        Total = total;
        ScenarioId = scenarioId;
        Repetition = repetition;
        Status = status;
    }

    /// <summary>Gets how many of the suite's runs have completed, this one included.</summary>
    /// <remarks>
    /// Between one and <see cref="Total"/>, and different on every report from one suite. The count
    /// equal to <see cref="Total"/> is assigned to the last run counted, but the call carrying it need
    /// not be the last call made.
    /// </remarks>
    public int Completed { get; }

    /// <summary>Gets how many runs the suite planned: every repetition of every scenario.</summary>
    public int Total { get; }

    /// <summary>Gets the id of the scenario the run belongs to.</summary>
    /// <remarks>
    /// Exactly as the suite declares it. A blank id is not refused here, because the coordinator
    /// does not refuse one either — <see cref="Loading.SuiteLoader"/> does — and a report must not be
    /// stricter than the run it reports on, or supplying a progress sink would fail a suite that
    /// runs without one.
    /// </remarks>
    public string ScenarioId { get; }

    /// <summary>Gets which repetition of the scenario the run was, counting from one.</summary>
    public int Repetition { get; }

    /// <summary>
    /// Gets the verdict the run was recorded with: the <see cref="RunResult.Status"/> the artifact
    /// carries for it.
    /// </summary>
    public RunStatus Status { get; }
}
