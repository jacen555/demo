namespace Forge.EvalEngine.Paths;

/// <summary>
/// A directory tree that untrusted paths are confined to, and the supported way to resolve a path
/// against it: resolve it to what the file system will actually read from, and refuse anything
/// that escapes.
/// </summary>
/// <remarks>
/// <para>
/// A path supplied by a suite author, a command line, or an artifact is untrusted input. Three
/// rules govern how one is turned into a path worth opening, and each of them is load-bearing on
/// its own. <b>None of them is redundant, and none of them may be reordered or removed.</b>
/// </para>
/// <para>
/// <b>1. Containment is checked twice, and the order matters.</b> The first check is on the text,
/// <i>before</i> the file system is touched at all: inspecting a path for links reads it, and
/// reading a path the caller chose is an action taken on their behalf — a UNC path makes it an
/// outbound request to a host they named. A path that is already outside the root as written is
/// never a reason to do that, so it is refused on the text alone. The second check is on the
/// <i>real</i> path, after resolution. A lexical check answers "does this string start with the
/// root", which a symbolic link or junction sitting inside the root satisfies while pointing
/// anywhere on the volume. Neither check catches the other's case: <c>../../secrets.json</c> is
/// caught only by the first, and an in-root junction pointing out is caught only by the second.
/// </para>
/// <para>
/// <b>2. The boundary is applied per segment, to a link target while it is still text.</b>
/// Following a link re-enters resolution with a path the link's author chose, so rule 1 has to
/// hold again at every link along the way. The target is measured against the root before anything
/// inspects it — not after. Deferring to the post-resolution check reaches the same verdict, but
/// only by first doing the thing the verdict exists to prevent: walking an in-root link that names
/// a UNC target was measured at 319 ms to 3.9 s and reaches DNS and SMB, where reading that link's
/// own metadata and stopping costs 13-14 ms and touches nothing. Write access to a suite root is
/// not authority to make this library issue that request.
/// </para>
/// <para>
/// <b>3. Inspection failure fails closed, and "unreadable" is not "absent".</b> A segment that is
/// confirmed absent cannot be a link, so it is kept as written and an ordinary not-found follows.
/// A segment that could not be inspected proves nothing, and treating it as the former is what
/// lets an unverified segment through. The two are distinguished through
/// <see cref="FileSystemInfo.ResolveLinkTarget(bool)"/> rather than
/// <see cref="FileSystemInfo.LinkTarget"/>, because on Windows the latter answers
/// <see langword="null"/> for an ACL-denied entry exactly as it does for a plain file.
/// </para>
/// <para>
/// This type exists so those rules have exactly one implementation. A consumer handed a lower
/// level primitive — a resolver taking a caller-supplied boundary predicate, say — has to restate
/// the ordering, the per-segment rule, and the containment comparison itself, and a containment
/// rule implemented twice is one that will eventually disagree with itself. Confinement is
/// therefore expressed as a boundary object that owns the root rather than as a helper that takes
/// one.
/// </para>
/// </remarks>
/// <example>
/// <code>
/// var boundary = new PathBoundary(@"C:\repo\eval-suites");
///
/// try
/// {
///     var real = boundary.Resolve(userSuppliedPath);
/// }
/// catch (PathEscapesBoundaryException)
/// {
///     // Refused: it leaves the root. Nothing was read on its behalf.
/// }
/// catch (IOException)
/// {
///     // Could not be established either way, so it was refused rather than assumed safe.
/// }
/// </code>
/// </example>
public sealed class PathBoundary
{
    private static readonly StringComparison PathComparison = OperatingSystem.IsWindows()
        ? StringComparison.OrdinalIgnoreCase
        : StringComparison.Ordinal;

    private readonly string _root;

    /// <summary>Initializes a new boundary confined to <paramref name="rootDirectory"/>.</summary>
    /// <param name="rootDirectory">
    /// The only directory tree paths may resolve into. It is canonicalized on construction —
    /// made absolute, and resolved through any links of its own — so that later comparisons are
    /// against the tree the file system reads from rather than the string the caller typed.
    /// </param>
    /// <remarks>
    /// The root is resolved <i>without</i> a boundary, unlike everything checked against it. That
    /// is deliberate: the root is the path the caller chose itself, not one it was handed, so
    /// there is no boundary it could meaningfully be confined to and no untrusted author whose
    /// link is being followed.
    /// </remarks>
    /// <exception cref="ArgumentException"><paramref name="rootDirectory"/> is empty or whitespace.</exception>
    /// <exception cref="ArgumentNullException"><paramref name="rootDirectory"/> is null.</exception>
    /// <exception cref="IOException">
    /// The root contains a cycle of links, or a segment of it could not be inspected, so it cannot
    /// be resolved to a real path.
    /// </exception>
    public PathBoundary(string rootDirectory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(rootDirectory);

        _root = RealPath.Resolve(Path.TrimEndingDirectorySeparator(Path.GetFullPath(rootDirectory)));
    }

    /// <summary>Gets the canonical root every resolved path is confined to.</summary>
    /// <remarks>
    /// This is the resolved form, which may differ from the string passed to the constructor. A
    /// caller reporting the boundary to a user should report this rather than what it supplied.
    /// </remarks>
    public string Root => _root;

    /// <summary>
    /// Resolves a path against the boundary and refuses it if it escapes.
    /// </summary>
    /// <param name="path">
    /// The path to resolve, relative to <see cref="Root"/> or absolute within it. Untrusted: this
    /// is the input the boundary exists to judge.
    /// </param>
    /// <returns>
    /// The real path the file system would read from, guaranteed to lie at or beneath
    /// <see cref="Root"/>. A segment that does not exist cannot be a link, so it is kept as
    /// written — the result is a path that is safe to open, not a promise that anything is there.
    /// </returns>
    /// <remarks>
    /// <para>
    /// Applies all three rules described on <see cref="PathBoundary"/>, in order: refuse on the
    /// text before any I/O, resolve every reparse point with the boundary applied to each link
    /// target while it is still text, then check containment again on the resolved path.
    /// </para>
    /// <para>
    /// A refusal is cheap and carries no inner exception, because nothing failed — the boundary
    /// declined to look. An <see cref="IOException"/> that is not a
    /// <see cref="PathEscapesBoundaryException"/> means the opposite: something could not be
    /// established, so the path was refused rather than assumed safe. Catch the refusal first;
    /// the compiler requires it, since the refusal type derives from <see cref="IOException"/> so
    /// that a caller handling only that still fails closed.
    /// </para>
    /// </remarks>
    /// <exception cref="ArgumentException"><paramref name="path"/> is empty or whitespace.</exception>
    /// <exception cref="ArgumentNullException"><paramref name="path"/> is null.</exception>
    /// <exception cref="PathEscapesBoundaryException">
    /// <paramref name="path"/> reads outside <see cref="Root"/>, passes through a link that points
    /// outside it, or resolves outside it.
    /// </exception>
    /// <exception cref="IOException">
    /// The path exceeds the maximum link depth, or a segment exists but could not be inspected —
    /// in which case whether it leaves the root is unknowable.
    /// </exception>
    public string Resolve(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);

        // Rule 1, first half. On the text, before the file system hears about this at all.
        var lexical = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.Combine(_root, path)));

        if (!Contains(lexical))
        {
            throw Escapes(path);
        }

        // Rules 2 and 3 live in RealPath, which is handed this boundary so that it can apply it to
        // each link target before inspecting it.
        var resolved = RealPath.Resolve(lexical, isTargetPermitted: Contains);

        // Rule 1, second half. The lexical check above cannot see a link that stayed inside the
        // root as text while pointing out of it.
        return Contains(resolved) ? resolved : throw Escapes(path);
    }

    private static PathEscapesBoundaryException Escapes(string path) =>
        new($"Path '{path}' resolves outside the boundary it was confined to and was refused.");

    /// <summary>Reports whether an already-canonical path lies at or beneath the root.</summary>
    /// <remarks>
    /// Compared with a trailing separator appended to the root, because a prefix test without one
    /// accepts a sibling whose name merely starts the same way — <c>C:\repo-elsewhere</c> is not
    /// inside <c>C:\repo</c>.
    /// </remarks>
    private bool Contains(string candidate) =>
        candidate.Equals(_root, PathComparison)
        || candidate.StartsWith(_root + Path.DirectorySeparatorChar, PathComparison);
}
