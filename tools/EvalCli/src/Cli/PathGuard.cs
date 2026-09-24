using System.Globalization;

namespace Forge.EvalCli.Cli;

/// <summary>
/// Canonicalizes a path taken from an argument and refuses one that resolves outside the expected
/// root.
/// </summary>
/// <remarks>
/// <para>
/// A path from the command line is untrusted input. It is canonicalized before it is acted on,
/// and containment is checked against the canonical form, so <c>..</c> traversal cannot walk out
/// of the root and a relative path cannot mean something different depending on where the process
/// happened to start.
/// </para>
/// <para>
/// <b>Read paths and the write path are guarded differently, on purpose.</b> For <c>--suite</c>
/// and <c>--baseline</c> this is a textual check: it does not follow symlinks or junctions,
/// because the engine's <c>SuiteLoader</c> performs the stronger link-aware check against the path
/// the file system will actually read from, at the point the file is opened. Duplicating that here
/// would be a second, weaker implementation of a rule that already has an authoritative one.
/// </para>
/// <para>
/// Nothing downstream re-checks a <i>destination</i>, so <see cref="ResolveOutputFile"/> cannot
/// defer in the same way and refuses a path reached through a link itself. See
/// <c>EnsureNoLinkOnWritePath</c> for why that guard detects links rather than resolving them.
/// </para>
/// </remarks>
internal static class PathGuard
{
    private static readonly StringComparison PathComparison = OperatingSystem.IsWindows()
        ? StringComparison.OrdinalIgnoreCase
        : StringComparison.Ordinal;

    /// <summary>Canonicalizes the containment root itself and confirms it exists.</summary>
    /// <param name="value">The root as supplied, absolute or relative to the working directory.</param>
    /// <param name="optionName">The option this value came from, for the error message.</param>
    /// <returns>The canonical, absolute root directory.</returns>
    /// <exception cref="EvalCliException">The value is blank, malformed, or not an existing directory.</exception>
    public static string ResolveRoot(string value, string optionName)
    {
        var canonical = Canonicalize(value, optionName);

        if (!Directory.Exists(canonical))
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                $"{optionName} is not an existing directory: {canonical}",
                $"Point {optionName} at a directory that exists. It is the boundary every other path must stay inside."
            );
        }

        return TrimTrailingSeparator(canonical);
    }

    /// <summary>Resolves an input file that must already exist inside the root.</summary>
    /// <param name="value">The path as supplied, absolute or relative to <paramref name="root"/>.</param>
    /// <param name="root">The canonical containment root.</param>
    /// <param name="optionName">The option this value came from, for the error message.</param>
    /// <returns>The canonical, absolute path to the file.</returns>
    /// <exception cref="EvalCliException">
    /// The value is blank or malformed, resolves outside <paramref name="root"/>, or does not name
    /// an existing file.
    /// </exception>
    public static string ResolveExistingFile(string value, string root, string optionName)
    {
        var canonical = ResolveInsideRoot(value, root, optionName);

        if (Directory.Exists(canonical))
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                $"{optionName} names a directory, not a file: {canonical}",
                $"Point {optionName} at the file itself."
            );
        }

        if (!File.Exists(canonical))
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                $"{optionName} does not name an existing file: {canonical}",
                $"Check the path. {optionName} is resolved relative to the root, not to the working directory."
            );
        }

        return canonical;
    }

    /// <summary>
    /// Resolves a destination file, refusing to clobber an existing one unless overwriting was
    /// asked for explicitly.
    /// </summary>
    /// <param name="value">The path as supplied, absolute or relative to <paramref name="root"/>.</param>
    /// <param name="root">The canonical containment root.</param>
    /// <param name="overwriteAllowed">Whether the caller opted in to replacing an existing file.</param>
    /// <param name="optionName">The option this value came from, for the error message.</param>
    /// <param name="overwriteOptionName">The opt-in flag to name in the refusal message.</param>
    /// <returns>The canonical, absolute path the artifact would be written to.</returns>
    /// <remarks>
    /// <b>This is the safe default.</b> Replacing a file a developer already has is the one
    /// irreversible thing this argument can cause, so it is refused unless
    /// <paramref name="overwriteAllowed"/> says otherwise — checked before anything is opened, so
    /// a refusal costs the caller nothing and leaves the existing file exactly as it was.
    /// </remarks>
    /// <exception cref="EvalCliException">
    /// The value is blank or malformed, resolves outside <paramref name="root"/>, names a
    /// directory, has no existing parent directory, or already exists without
    /// <paramref name="overwriteAllowed"/>.
    /// </exception>
    public static string ResolveOutputFile(
        string value,
        string root,
        bool overwriteAllowed,
        string optionName,
        string overwriteOptionName
    )
    {
        var canonical = ResolveInsideRoot(value, root, optionName);

        EnsureNoLinkOnWritePath(canonical, root, optionName);

        if (Directory.Exists(canonical))
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                $"{optionName} names an existing directory, not a file: {canonical}",
                $"Give {optionName} a file name inside that directory."
            );
        }

        var parent = Path.GetDirectoryName(canonical);

        if (string.IsNullOrEmpty(parent) || !Directory.Exists(parent))
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                $"{optionName} points into a directory that does not exist: {parent}",
                "Create the directory first, or choose a path inside one that already exists."
            );
        }

        if (File.Exists(canonical) && !overwriteAllowed)
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                $"{optionName} already exists and would be replaced: {canonical}",
                $"Nothing was written. Choose another path, or pass {overwriteOptionName} to replace it deliberately."
            );
        }

        return canonical;
    }

    /// <summary>Canonicalizes a path and confirms it resolves inside the root.</summary>
    /// <param name="value">The path as supplied, absolute or relative to <paramref name="root"/>.</param>
    /// <param name="root">The canonical containment root.</param>
    /// <param name="optionName">The option this value came from, for the error message.</param>
    /// <returns>The canonical, absolute path.</returns>
    /// <exception cref="EvalCliException">The value is blank or malformed, or resolves outside the root.</exception>
    internal static string ResolveInsideRoot(string value, string root, string optionName)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(root);

        var canonical = Canonicalize(value, optionName, root);

        if (!IsInside(canonical, root))
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                $"{optionName} resolves outside the root: {canonical}",
                $"Every path must stay inside {root}. Move the file inside it, or widen the root with --root."
            );
        }

        return canonical;
    }

    /// <summary>Reports whether a canonical path lies at or beneath a canonical root.</summary>
    /// <param name="canonicalPath">An already-canonicalized absolute path.</param>
    /// <param name="root">An already-canonicalized absolute root.</param>
    /// <returns><see langword="true"/> when the path is the root or sits beneath it.</returns>
    /// <remarks>
    /// Compared with a trailing separator appended to the root, because a prefix test without one
    /// accepts a sibling directory whose name merely starts the same way — <c>C:\repo-elsewhere</c>
    /// is not inside <c>C:\repo</c>.
    /// </remarks>
    internal static bool IsInside(string canonicalPath, string root)
    {
        var trimmedRoot = TrimTrailingSeparator(root);

        if (string.Equals(canonicalPath, trimmedRoot, PathComparison))
        {
            return true;
        }

        var prefix = trimmedRoot + Path.DirectorySeparatorChar;

        return canonicalPath.StartsWith(prefix, PathComparison);
    }

    /// <summary>Turns a supplied path into an absolute, normalized one.</summary>
    /// <param name="value">The path as supplied.</param>
    /// <param name="optionName">The option this value came from, for the error message.</param>
    /// <param name="basePath">What a relative path is resolved against, or <see langword="null"/> for the working directory.</param>
    /// <returns>The canonical, absolute path.</returns>
    /// <exception cref="EvalCliException">The value is blank or the platform refuses to normalize it.</exception>
    internal static string Canonicalize(string value, string optionName, string? basePath = null)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                $"{optionName} was given a blank path.",
                $"Supply a path, or omit {optionName} entirely."
            );
        }

        try
        {
            return basePath is null ? Path.GetFullPath(value.Trim()) : Path.GetFullPath(value.Trim(), basePath);
        }
        catch (Exception exception)
            when (exception is ArgumentException or NotSupportedException or PathTooLongException or IOException)
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                string.Create(CultureInfo.InvariantCulture, $"{optionName} is not a usable path: {exception.Message}"),
                "Check for invalid characters, a reserved device name, or a path that is too long."
            );
        }
    }

    /// <summary>Refuses a destination that is reached through a reparse point.</summary>
    /// <param name="canonicalPath">The already-contained canonical destination.</param>
    /// <param name="root">The canonical containment root.</param>
    /// <param name="optionName">The option this value came from, for the error message.</param>
    /// <remarks>
    /// <para>
    /// Lexical containment answers "does this string begin with the root", which a directory link
    /// sitting inside the root satisfies while pointing anywhere on the machine. For a path the
    /// tool <i>reads</i>, the engine settles that at the moment the file is opened. Nothing
    /// downstream re-checks a destination, so for a path the tool would <i>write</i> this argument
    /// is the only place the question is ever asked — and it is asked now, while the answer still
    /// costs nothing, rather than when there is a stream open on the wrong file.
    /// </para>
    /// <para>
    /// <b>This detects rather than resolves.</b> Resolution — following a target, restarting from
    /// it, bounding the hops, refusing to read a target on another host — is genuinely hard and
    /// already has one correct implementation, in the engine, where it is internal. A second copy
    /// here would be weaker by construction, so this asks the smaller question instead: is any
    /// segment a link at all? That needs none of the machinery, cannot disagree with the engine
    /// about where a link leads because it never asks, and is strictly the more conservative rule
    /// — it refuses a link that leaves the root <i>and</i> one that stays inside it, on the
    /// grounds that an artifact destination has no reason to be reached through either.
    /// </para>
    /// </remarks>
    /// <exception cref="EvalCliException">
    /// A segment is a link, or exists but could not be inspected.
    /// </exception>
    private static void EnsureNoLinkOnWritePath(string canonicalPath, string root, string optionName)
    {
        var trimmedRoot = TrimTrailingSeparator(root);

        foreach (var segment in SegmentsBelow(canonicalPath, trimmedRoot))
        {
            if (LinkTargetOf(segment, optionName) is null)
            {
                continue;
            }

            throw new EvalCliException(
                ExitCode.UsageError,
                $"{optionName} is reached through a link, so where it would be written cannot be established from "
                    + $"the path: {segment}",
                $"Nothing was written. A link inside {trimmedRoot} can point anywhere on the machine, so staying "
                    + $"inside the root as text is not the same as staying inside it on disk. Give {optionName} a "
                    + "path with no link along it, or point --root at the directory the link leads to."
            );
        }
    }

    /// <summary>Lists each path from just below the root down to the destination, outermost first.</summary>
    /// <param name="canonicalPath">The already-contained canonical destination.</param>
    /// <param name="trimmedRoot">The canonical root, without a trailing separator.</param>
    /// <returns>The segments to inspect, in the order the file system would traverse them.</returns>
    /// <remarks>
    /// The root itself is excluded. It is the boundary the caller declared, so whether it is
    /// reached through a link is their decision to have made, not this guard's to overturn.
    /// </remarks>
    private static List<string> SegmentsBelow(string canonicalPath, string trimmedRoot)
    {
        var segments = new List<string>();
        var current = canonicalPath;

        while (!string.Equals(current, trimmedRoot, PathComparison))
        {
            segments.Add(current);

            var parent = Path.GetDirectoryName(current);

            if (string.IsNullOrEmpty(parent))
            {
                break;
            }

            current = parent;
        }

        segments.Reverse();

        return segments;
    }

    /// <summary>The link target of one segment, or <see langword="null"/> when it is confirmed not to be a link.</summary>
    /// <param name="segment">The path to inspect.</param>
    /// <param name="optionName">The option this value came from, for the error message.</param>
    /// <returns>The target, or <see langword="null"/> for a segment that is absent or is a plain entry.</returns>
    /// <remarks>
    /// The two negative answers here are not the same answer. "This segment does not exist" proves
    /// it is not a link — and a destination that does not exist yet is the ordinary case, not a
    /// fault. "This segment could not be inspected" proves nothing, and treating it as the former
    /// is exactly what lets an unverified segment through.
    /// <see cref="FileSystemInfo.LinkTarget"/> cannot express the difference; on Windows it answers
    /// null for an unreadable entry just as it does for a plain file.
    /// <see cref="FileSystemInfo.ResolveLinkTarget(bool)"/> throws instead, which is the
    /// distinction this is built on.
    /// </remarks>
    /// <exception cref="EvalCliException">The segment exists but could not be inspected.</exception>
    private static string? LinkTargetOf(string segment, string optionName)
    {
        try
        {
            FileSystemInfo entry = Directory.Exists(segment) ? new DirectoryInfo(segment) : new FileInfo(segment);

            return entry.ResolveLinkTarget(returnFinalTarget: false)?.FullName;
        }
        catch (Exception exception) when (exception is FileNotFoundException or DirectoryNotFoundException)
        {
            // Confirmed absent, so confirmed not a link.
            return null;
        }
        catch (Exception exception)
            when (exception is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                string.Create(
                    CultureInfo.InvariantCulture,
                    $"{optionName} passes through '{segment}', which exists but could not be inspected, so whether "
                        + $"it is a link out of the root could not be established: {exception.Message}"
                ),
                "Nothing was written. It was refused rather than assumed safe. Check the permissions on that "
                    + $"directory, or give {optionName} a destination elsewhere."
            );
        }
    }

    private static string TrimTrailingSeparator(string path) => Path.TrimEndingDirectorySeparator(path);
}
