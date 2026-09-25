namespace Forge.EvalCli.Cli;

/// <summary>
/// What this invocation has already made durable, and the one sentence to say about it if the
/// invocation is then interrupted.
/// </summary>
/// <remarks>
/// <para>
/// <b>This exists because the same defect arrived six times.</b> "Interrupted, and nothing was
/// written" is two claims, and only the first is always true. Each instance was found, understood
/// and fixed correctly — <c>baseline update --apply</c>, <c>run --out</c>, the live-baseline
/// comparison, the staged-file cleanup, the report write — and each fix was written as <i>this
/// operation, after this write</i>: a local flag set at the call site and a
/// <c>catch</c> filtered on it. A sweep after the third found no fourth, and it was right; the
/// fifth and sixth did not exist yet. Every new write path since has arrived carrying a fresh
/// instance, because the property was never anywhere that a new write path would have to pass
/// through.
/// </para>
/// <para>
/// <b>The property is: any cancellable step occurring after a durable write must report that
/// write.</b> Two things make it hold here rather than being remembered:
/// </para>
/// <list type="number">
/// <item><description>
/// <b>The ledger is appended by the writer, not by the caller.</b> <c>ArtifactWriter</c> takes one
/// and records on publication, so a command cannot make a durable write without the fact being
/// recorded — there is exactly one writer, which is a property this tool already holds.
/// </description></item>
/// <item><description>
/// <b>The catch wraps the whole command body, not the step after the write.</b>
/// <see cref="GuardAsync"/> owns both the ledger and the catch, so a command cannot take one
/// without the other, and <i>every</i> later step is inside it — including steps that do not
/// exist yet. That is the part a per-site fix cannot give: the seventh instance is covered before
/// it is written.
/// </description></item>
/// </list>
/// <para>
/// It is not enforced by the compiler. A durable write made outside <c>ArtifactWriter</c>, or a
/// command that never calls <see cref="GuardAsync"/>, would still escape — and both are pinned by
/// test rather than by type, because the alternative shapes cost more than they buy. See the
/// mutants named in the task report.
/// </para>
/// </remarks>
internal sealed class DurableWrites
{
    private readonly List<string> _clauses = [];

    /// <summary>
    /// Private so <see cref="GuardAsync"/> is the only source of one.
    /// </summary>
    /// <remarks>
    /// A command that wants somewhere to record a write cannot obtain it without also obtaining
    /// the catch, because there is no other way to make one. That turns "skip the guard and pass
    /// a fresh ledger" from something a test has to catch into something that does not compile.
    /// </remarks>
    private DurableWrites() { }

    /// <summary>Records something that has landed on disk and will outlive this invocation.</summary>
    /// <param name="clause">
    /// What happened, as a lower-case clause with no trailing stop — it is read after
    /// "Nothing further was run, but ".
    /// </param>
    /// <exception cref="ArgumentException"><paramref name="clause"/> is blank.</exception>
    public void Record(string clause)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(clause);

        _clauses.Add(clause);
    }

    /// <summary>Gets whether anything durable has happened yet.</summary>
    public bool Any => _clauses.Count > 0;

    /// <summary>Everything that has, as one sentence.</summary>
    /// <returns>The sentence.</returns>
    /// <exception cref="InvalidOperationException">Nothing has been recorded.</exception>
    public string Describe() =>
        _clauses.Count switch
        {
            0 => throw new InvalidOperationException(
                "Nothing durable was recorded, so there is no interruption to qualify. Ask "
                    + $"{nameof(Any)} before asking this."
            ),
            1 => $"{_clauses[0]}.",
            _ => $"{string.Join("; ", _clauses[..^1])}; and {_clauses[^1]}.",
        };

    /// <summary>
    /// Runs a command body, reporting any durable effect if the invocation is interrupted.
    /// </summary>
    /// <typeparam name="T">What the body returns.</typeparam>
    /// <param name="body">The whole command, given the ledger to hand to the writer.</param>
    /// <returns>Whatever the body returned.</returns>
    /// <remarks>
    /// <para>
    /// <b>The ledger and the catch are issued together and cannot be separated.</b> A command that
    /// wants somewhere to record a write has to take this, and taking it puts every subsequent
    /// step inside the catch.
    /// </para>
    /// <para>
    /// <b>An interruption that already carries its own account passes through untouched.</b> The
    /// writer reports a staged file it declined to remove, and that sentence is more specific than
    /// anything this could compose; re-wrapping it would replace a precise statement with a
    /// general one.
    /// </para>
    /// </remarks>
    /// <exception cref="ArgumentNullException"><paramref name="body"/> is null.</exception>
    public static async Task<T> GuardAsync<T>(Func<DurableWrites, Task<T>> body)
    {
        ArgumentNullException.ThrowIfNull(body);

        var written = new DurableWrites();

        try
        {
            return await body(written).ConfigureAwait(false);
        }
        catch (InterruptedAfterWritingException)
        {
            throw;
        }
        catch (OperationCanceledException cancelled) when (written.Any)
        {
            throw new InterruptedAfterWritingException(written.Describe(), cancelled);
        }
    }
}
