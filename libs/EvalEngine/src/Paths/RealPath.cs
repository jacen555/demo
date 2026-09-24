using System.Globalization;

namespace Forge.EvalEngine.Paths;

/// <summary>
/// Resolves a path to the location the file system will actually read from, following symbolic
/// links and junctions at every level of the path rather than only at its last segment.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="Path.GetFullPath(string)"/> is purely lexical: it normalizes <c>..</c> and casing
/// and stops there. Containment built on it alone is a text comparison, and a reparse point is
/// exactly the case where the text and the bytes disagree.
/// </para>
/// <para>
/// This type knows nothing about suites or roots. The boundary it must not resolve past is handed
/// to it, because following a link is an action taken on a path the link chose and only the caller
/// can say which paths it is willing to have read on its behalf.
/// </para>
/// <para>
/// It stays internal. The shape a consumer outside this assembly needs is
/// <see cref="PathBoundary"/>, which owns the boundary rather than taking one as a delegate — a
/// caller that supplies its own predicate is a caller that has reimplemented containment, which is
/// the failure this primitive exists to prevent rather than a use of it.
/// </para>
/// </remarks>
internal static class RealPath
{
    private const int MaxLinkHops = 40;

    /// <summary>Resolves every reparse point along a path.</summary>
    /// <param name="path">The path to resolve. It need not exist.</param>
    /// <param name="isTargetPermitted">
    /// The boundary resolution is confined to, asked about each link target <i>before</i> that
    /// target is inspected. A rejected target stops resolution rather than being walked. Omitting
    /// it resolves without a boundary, which is only appropriate for a path the caller chose
    /// itself rather than one it was handed.
    /// </param>
    /// <returns>
    /// The real path. A segment that does not exist cannot be a link, so it is kept as written.
    /// </returns>
    /// <exception cref="LinkLeavesBoundaryException">
    /// A link points outside <paramref name="isTargetPermitted"/>. Raised before its target is
    /// touched.
    /// </exception>
    /// <exception cref="IOException">
    /// The path exceeds the maximum link depth, or a segment could not be inspected — in which
    /// case whether it leaves the root is unknowable and it is refused rather than assumed safe.
    /// </exception>
    public static string Resolve(string path, Func<string, bool>? isTargetPermitted = null)
    {
        var pending = Split(Path.GetFullPath(path), out var resolved);
        var hops = 0;

        while (pending.Count > 0)
        {
            var candidate = Path.Combine(resolved, pending.Dequeue());

            if (LinkTarget(candidate) is not string target)
            {
                resolved = candidate;
                continue;
            }

            if (++hops > MaxLinkHops)
            {
                throw new IOException(
                    $"Resolving '{path}' exceeded {MaxLinkHops.ToString(CultureInfo.InvariantCulture)} links, "
                        + "which means the path contains a cycle."
                );
            }

            // Reading the link said nothing about where it points; every step after this one is
            // taken on a path the link chose. Inspecting the target's segments reads them, and a
            // target on another host makes the first of those reads an outbound request. So the
            // boundary is applied to the target here, while it is still only text — checking it
            // afterwards reaches the same verdict, but only by first making the request that the
            // verdict exists to prevent.
            var followed = Path.TrimEndingDirectorySeparator(Path.GetFullPath(target, resolved));

            if (isTargetPermitted is not null && !isTargetPermitted(followed))
            {
                throw new LinkLeavesBoundaryException(candidate, followed);
            }

            // The target's own ancestors may themselves be links, so resolution restarts from the
            // target with whatever segments were still outstanding appended to it.
            var outstanding = pending;
            pending = Split(followed, out resolved);

            while (outstanding.Count > 0)
            {
                pending.Enqueue(outstanding.Dequeue());
            }
        }

        return resolved;
    }

    private static Queue<string> Split(string fullPath, out string root)
    {
        var path = Path.TrimEndingDirectorySeparator(fullPath);
        var segments = new Stack<string>();

        while (true)
        {
            var parent = Path.GetDirectoryName(path);

            if (string.IsNullOrEmpty(parent))
            {
                root = path;
                return new Queue<string>(segments);
            }

            segments.Push(Path.GetFileName(path));
            path = parent;
        }
    }

    /// <summary>
    /// The target of a segment's link, or <see langword="null"/> when it is confirmed not to be
    /// one.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The two negative answers here are not the same answer. "This segment does not exist" is
    /// proof that it is not a link. "I could not inspect this segment" is proof of nothing — and
    /// treating it as the former is what lets an unverified segment through, after which a read
    /// can follow it out of the root.
    /// </para>
    /// <para>
    /// <see cref="FileSystemInfo.LinkTarget"/> cannot express that difference: on Windows it
    /// answers <see langword="null"/> for an entry whose attributes could not be read just as it
    /// does for a plain file. <see cref="FileSystemInfo.ResolveLinkTarget(bool)"/> throws instead,
    /// which is the distinction this method is built on.
    /// </para>
    /// </remarks>
    /// <exception cref="IOException">The segment exists but could not be inspected.</exception>
    private static string? LinkTarget(string path)
    {
        try
        {
            FileSystemInfo entry = Directory.Exists(path) ? new DirectoryInfo(path) : new FileInfo(path);

            return entry.ResolveLinkTarget(returnFinalTarget: false)?.FullName;
        }
        catch (Exception exception) when (exception is FileNotFoundException or DirectoryNotFoundException)
        {
            // Confirmed absent. A segment that is not there cannot be a link, and a suite path
            // that does not exist is an ordinary not-found rather than a refusal.
            return null;
        }
        catch (Exception exception)
            when (exception is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            throw new IOException(
                $"Path segment '{path}' exists but could not be inspected, so whether it is a link that leaves the "
                    + "suite root could not be established. It was refused rather than assumed safe.",
                exception
            );
        }
    }
}
