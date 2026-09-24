namespace Forge.EvalCli.Cli;

/// <summary>
/// The process exit codes this tool contracts to return.
/// </summary>
/// <remarks>
/// <para>
/// <b>Exit codes are an API.</b> Every caller that checks one — a CI step, a git hook, a shell
/// pipeline — depends on these values, so they are additive only: a code is never renumbered and
/// never repurposed.
/// </para>
/// <para>
/// <see cref="Success"/> means <i>the run completed and nothing asked for a non-zero exit</i>. It
/// never means "the tool finished writing output." A tool that reports a failure on stdout and
/// exits zero produces a green check over a red result, which is worse than no check at all.
/// </para>
/// <para>
/// <b>10-19 is reserved for the gate.</b> The report-only default becomes an opt-in gate later,
/// and that gate needs room for more than one kind of "the change made things worse" without
/// renumbering anything above it. <see cref="RegressionsFound"/> is the first of that block; the
/// rest of the range stays unallocated until a gate outcome earns one.
/// </para>
/// </remarks>
internal enum ExitCode
{
    /// <summary>The run completed and nothing asked for a non-zero exit.</summary>
    Success = 0,

    /// <summary>
    /// The invocation was refused before anything ran: a missing or malformed argument, a value
    /// outside its allowed range, or a path that does not resolve inside the expected root.
    /// </summary>
    UsageError = 1,

    /// <summary>
    /// The suite could not be loaded or did not validate. The loader refuses rather than guessing,
    /// and this is that refusal reaching the caller.
    /// </summary>
    SuiteError = 2,

    /// <summary>
    /// The run itself could not complete. The artifact, if any, does not describe a whole run.
    /// </summary>
    RunFailed = 3,

    /// <summary>
    /// A baseline and a candidate could not be compared, because they were not conducted alike.
    /// This is a refusal, not a regression — the comparison did not happen.
    /// </summary>
    ComparisonRefused = 4,

    /// <summary>
    /// A baseline was required and none was found. Distinct from <see cref="ComparisonRefused"/>,
    /// and emphatically distinct from <see cref="Success"/>: no baseline is not the same as no
    /// regression.
    /// </summary>
    BaselineMissing = 5,

    /// <summary>
    /// The gate was asked for and the comparison found regressions. Reserved: nothing produces
    /// this yet, and the reserved block runs to <see cref="ExitCodes.GateRangeEnd"/>.
    /// </summary>
    RegressionsFound = 10,

    /// <summary>
    /// The invocation was well-formed but the operation it asked for is not wired up in this
    /// build. Non-zero on purpose: nothing ran, so nothing may report success.
    /// </summary>
    NotImplemented = 70,

    /// <summary>An unhandled internal failure. This is a defect in the tool.</summary>
    UnexpectedError = 71,

    /// <summary>
    /// The run was interrupted — Ctrl+C, or cancellation from elsewhere. Follows the 128 + SIGINT
    /// convention so a shell reports it the same way it reports every other interrupted process.
    /// </summary>
    Interrupted = 130,
}

/// <summary>One documented exit code and what a caller should read into it.</summary>
/// <param name="Code">The code.</param>
/// <param name="Meaning">What the code means, in one line, for <c>--help</c> and the README.</param>
internal sealed record ExitCodeDescription(ExitCode Code, string Meaning);

/// <summary>
/// The exit-code table, in one place, so <c>--help</c>, the README, and the tests cannot drift
/// apart from each other.
/// </summary>
internal static class ExitCodes
{
    /// <summary>The first code in the block reserved for gate outcomes.</summary>
    public const int GateRangeStart = 10;

    /// <summary>The last code in the block reserved for gate outcomes.</summary>
    public const int GateRangeEnd = 19;

    /// <summary>Gets every documented exit code, in ascending order.</summary>
    public static IReadOnlyList<ExitCodeDescription> Documented { get; } =
    [
        new(ExitCode.Success, "the run completed and nothing asked for a non-zero exit"),
        new(ExitCode.UsageError, "the invocation was refused - bad argument, value, or path"),
        new(ExitCode.SuiteError, "the suite could not be loaded or did not validate"),
        new(ExitCode.RunFailed, "the run could not complete"),
        new(ExitCode.ComparisonRefused, "baseline and candidate were not conducted alike"),
        new(ExitCode.BaselineMissing, "a baseline was required and none was found"),
        new(ExitCode.RegressionsFound, "reserved for the gate (10-19); nothing produces it yet"),
        new(ExitCode.NotImplemented, "the requested operation is not wired up in this build"),
        new(ExitCode.UnexpectedError, "an unhandled internal failure - a defect in this tool"),
        new(ExitCode.Interrupted, "interrupted (Ctrl+C); partial state, nothing was written"),
    ];

    /// <summary>Reports whether a code falls in the block reserved for gate outcomes.</summary>
    /// <param name="code">The code to test.</param>
    /// <returns><see langword="true"/> when the code is in the reserved gate block.</returns>
    public static bool IsGateCode(ExitCode code) => (int)code is >= GateRangeStart and <= GateRangeEnd;

    /// <summary>Reports whether a code means the caller should treat the invocation as failed.</summary>
    /// <param name="code">The code to test.</param>
    /// <returns><see langword="true"/> for every code other than <see cref="ExitCode.Success"/>.</returns>
    public static bool IsFailure(ExitCode code) => code != ExitCode.Success;
}
