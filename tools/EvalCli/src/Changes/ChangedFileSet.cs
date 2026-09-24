namespace Forge.EvalCli.Changes;

/// <summary>
/// The set of files a change touched, expressed the way <c>ImpactSelector</c> needs them — or the
/// reason no set could be established.
/// </summary>
/// <remarks>
/// <para>
/// <b>"Not established" is a first-class answer, not an empty list.</b> The selector already
/// treats an empty changed-file set as grounds to run the whole suite, and it says so in its own
/// words — but it cannot know <i>why</i> the set was empty. Git missing, a directory that is not
/// a repository, and a working tree with genuinely nothing changed all reach the selector as the
/// same empty sequence, and only the caller can tell them apart. Carrying the reason here is what
/// lets the report say which one happened.
/// </para>
/// <para>
/// <see cref="Paths"/> is empty whenever <see cref="UnavailableReason"/> is set. That is
/// deliberate rather than incidental: handing the selector a partial set it will treat as
/// complete is how a scenario is retired on a stale pass, so a set that could not be completed is
/// not offered at all.
/// </para>
/// </remarks>
internal sealed record ChangedFileSet
{
    private ChangedFileSet() { }

    /// <summary>
    /// Gets the changed paths, relative to the containment root and in the order the producer
    /// emitted them.
    /// </summary>
    public IReadOnlyList<string> Paths { get; private init; } = [];

    /// <summary>
    /// Gets why no set could be established, or <see langword="null"/> when one was.
    /// </summary>
    /// <remarks>
    /// Phrased for a person reading a run report, and composed only from text this tool wrote or
    /// from a value the caller supplied — never from an arbitrary subprocess message (§V).
    /// </remarks>
    public string? UnavailableReason { get; private init; }

    /// <summary>Gets the command the set was acquired from, for the report, or null.</summary>
    /// <remarks>
    /// A selective run is only checkable if the reader can see what the selection was made of,
    /// and the diff command is half of that. It is assembled from this tool's own argument list,
    /// so it is safe to print.
    /// </remarks>
    public string? Source { get; private init; }

    /// <summary>Gets a value indicating whether a trustworthy set was established.</summary>
    public bool Established => UnavailableReason is null;

    /// <summary>Records a set that was established.</summary>
    /// <param name="paths">The changed paths, relative to the containment root.</param>
    /// <param name="source">The command they were read from.</param>
    /// <returns>The set.</returns>
    /// <exception cref="ArgumentNullException">Any argument is null.</exception>
    public static ChangedFileSet Acquired(IReadOnlyList<string> paths, string source)
    {
        ArgumentNullException.ThrowIfNull(paths);
        ArgumentNullException.ThrowIfNull(source);

        return new ChangedFileSet { Paths = paths, Source = source };
    }

    /// <summary>Records that no set could be established, and why.</summary>
    /// <param name="reason">Why, phrased for a person reading a run report.</param>
    /// <param name="source">The command that was attempted, or null when none was.</param>
    /// <returns>The set.</returns>
    /// <exception cref="ArgumentException"><paramref name="reason"/> is blank.</exception>
    public static ChangedFileSet Unavailable(string reason, string? source = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(reason);

        return new ChangedFileSet { UnavailableReason = reason, Source = source };
    }
}

/// <summary>
/// Where the changed-file set comes from.
/// </summary>
/// <remarks>
/// A seam rather than a direct call to git, so the stage that consumes the set can be tested
/// against a set the test chose — including the sets that must produce a full-suite fallback.
/// </remarks>
internal interface IChangedFileSource
{
    /// <summary>Acquires the changed-file set.</summary>
    /// <param name="cancellationToken">Cancels the acquisition.</param>
    /// <returns>The set, or the reason none could be established.</returns>
    /// <exception cref="OperationCanceledException">The token was cancelled.</exception>
    Task<ChangedFileSet> GetChangedFilesAsync(CancellationToken cancellationToken);
}

/// <summary>
/// The source used when the caller did not ask for impact selection.
/// </summary>
/// <remarks>
/// <b>Impact selection is opt-in, and that is the safety property.</b> Choosing a revision to
/// diff against is a judgement this tool cannot make on a caller's behalf: <c>HEAD</c> misses
/// everything already committed on a branch, a merge base needs to know which branch is the
/// trunk, and picking wrong <i>shrinks</i> the run. A scenario that should have run and did not
/// produces no output at all — no wrong number to catch, just silence and a green report — so
/// the default is to run everything and say so, and a narrower run is something a caller asks for
/// by naming the revision themselves.
/// </remarks>
internal sealed class FullSuiteChangedFileSource : IChangedFileSource
{
    /// <inheritdoc/>
    public Task<ChangedFileSet> GetChangedFilesAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        return Task.FromResult(
            ChangedFileSet.Unavailable(
                "no --changed-since revision was given, so no changed-file set was acquired and the whole suite "
                    + "was selected. Pass --changed-since <rev> to narrow the run to what a change actually touched."
            )
        );
    }
}
