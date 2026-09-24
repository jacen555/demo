using System.Text;

namespace Forge.EvalCli.Changes;

/// <summary>
/// Reads the two shapes a <c>git diff</c> answer arrives in: the NUL framing its bytes carry, and
/// the repository-relative paths inside them.
/// </summary>
/// <remarks>
/// <para>
/// Pure, and separated from the process invocation on purpose. <b>This is where the changed-file
/// set is decided</b>, and the changed-file set decides whether a scenario runs at all. A path
/// that arrives mis-framed, mis-decoded, or relative to the wrong directory does not fail — it
/// silently fails to match its glob, the scenario it mapped to is skipped on a prior pass, and
/// the report is green. There is no wrong number to catch, so the rules below are pinned by tests
/// against literal bytes rather than observed through a subprocess.
/// </para>
/// </remarks>
internal static class GitDiffReading
{
    /// <summary>The path separator git emits, on every platform.</summary>
    private const char GitSeparator = '/';

    /// <summary>The most of a git-produced path that is ever quoted back in a message.</summary>
    private const int MaxQuotedPathLength = 200;

    /// <summary>
    /// Quotes a path git produced, safely, for a message a person will read.
    /// </summary>
    /// <param name="path">The path as git reported it.</param>
    /// <returns>The path in quotes, stripped of control characters and capped in length.</returns>
    /// <remarks>
    /// A path is subprocess output and therefore untrusted (§V). A file may legitimately be named
    /// with an escape sequence in it, and one reproduced verbatim rewrites the terminal of
    /// whoever reads the refusal — so the same treatment git's own stderr gets is applied here.
    /// </remarks>
    public static string Quote(string path)
    {
        ArgumentNullException.ThrowIfNull(path);

        return "'"
            + new string([.. path.Where(character => !char.IsControl(character)).Take(MaxQuotedPathLength)])
            + "'";
    }

    /// <summary>
    /// Decodes the NUL-separated output of <c>git diff -z --name-only</c>.
    /// </summary>
    /// <param name="stdout">The raw bytes git wrote. Not text: it has not been decoded yet.</param>
    /// <param name="paths">The decoded paths, or empty when the output was refused.</param>
    /// <param name="rejection">Why it was refused, or null.</param>
    /// <returns><see langword="true"/> when every entry decoded.</returns>
    /// <remarks>
    /// <para>
    /// <b>Why <c>-z</c> and not plain <c>--name-only</c>.</b> Without it git <i>C-quotes</i> any
    /// path containing a non-ASCII byte, a quote, or a control character: <c>src/café.cs</c>
    /// arrives as the literal text <c>"src/caf\303\251.cs"</c>. That still looks like a path, it
    /// still matches nothing, and the scenario mapped to the file that really changed retires on
    /// a stale pass. <c>-z</c> turns quoting off entirely and separates entries with a NUL, which
    /// no path may contain — so the framing is unambiguous and nothing needs unescaping.
    /// </para>
    /// <para>
    /// <b>Decoding fails closed.</b> The bytes are decoded as strict UTF-8; a path git stored in
    /// some other encoding cannot be turned into the text on disk, and substituting replacement
    /// characters would produce a plausible-looking path that matches the wrong glob. That is the
    /// failure this whole layer exists to prevent, so it is refused instead — and the caller turns
    /// a refusal into a full-suite run.
    /// </para>
    /// <para>
    /// <b>A path carrying a literal backslash is refused too, and for a subtler reason.</b> It
    /// decodes perfectly — on Linux and macOS a backslash is an ordinary character in a file
    /// name, so <c>src/a\b.cs</c> is one file inside <c>src</c>. But the matcher these paths are
    /// handed to reads a backslash as a directory separator, which is right on Windows (where no
    /// file name may contain one) and wrong here: the path would be matched as <c>src/a/b.cs</c>,
    /// miss <c>src/*.cs</c>, and retire the scenario mapped to the file that actually changed.
    /// There is no lossless way to hand it over, so the whole set is refused and the caller runs
    /// everything. Refusing the set rather than dropping the entry is the point: a set with one
    /// entry quietly removed is still non-empty, and nothing falls back from a non-empty set.
    /// </para>
    /// <para>
    /// A trailing NUL terminates the last entry rather than introducing an empty one, so exactly
    /// one trailing empty segment is expected and dropped. An empty entry anywhere else is a path
    /// of no length, which git cannot have meant, and is refused rather than skipped.
    /// </para>
    /// </remarks>
    public static bool TryDecodeNulSeparated(ReadOnlySpan<byte> stdout, out List<string> paths, out string? rejection)
    {
        // Throwing rather than replacing. The whole point is that an undecodable path must not
        // become a plausible one.
        var utf8 = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

        paths = [];
        rejection = null;

        if (stdout.Length == 0)
        {
            return true;
        }

        if (stdout[^1] != 0)
        {
            // Every entry is NUL-terminated, so the last byte is a NUL. Anything else means the
            // output was cut short, and a truncated set is a set that is missing files.
            rejection =
                "git's diff output did not end with a NUL terminator, so it was truncated and the changed-file "
                + "set it describes is incomplete";
            return false;
        }

        var remaining = stdout;

        while (!remaining.IsEmpty)
        {
            var terminator = remaining.IndexOf((byte)0);
            var entry = remaining[..terminator];

            remaining = remaining[(terminator + 1)..];

            if (entry.IsEmpty)
            {
                rejection = "git's diff output carried an empty entry between NUL terminators, which names no file";
                paths = [];
                return false;
            }

            try
            {
                var decoded = utf8.GetString(entry);

                if (decoded.Contains('\\', StringComparison.Ordinal))
                {
                    // Decoded perfectly, and still unusable — which is why this is a separate
                    // refusal rather than a case of the one above. On Unix a backslash is an
                    // ordinary character in a file name, so `src/a\b.cs` is one file in `src`.
                    // ImpactGlob normalizes a backslash to a separator, which is correct on
                    // Windows (where no file name may contain one) and wrong for this path: it
                    // would be matched as `src/a/b.cs`, miss `src/*.cs`, and retire the scenario
                    // mapped to the file that actually changed. There is no lossless way to hand
                    // it over, so the set is refused and the caller runs everything.
                    rejection =
                        $"git reported a changed path carrying a literal backslash, {Quote(decoded)}. A backslash is "
                        + "an ordinary character in a file name on Linux and macOS, but impact globs are matched "
                        + "with it read as a directory separator, so this path cannot be handed over without being "
                        + "read as a file in a directory that does not exist — which would match no glob and skip "
                        + "the scenarios mapped to it";
                    paths = [];
                    return false;
                }

                paths.Add(decoded);
            }
            catch (DecoderFallbackException)
            {
                rejection =
                    "git reported a changed path whose bytes are not valid UTF-8, so it cannot be decoded to the "
                    + "path as it exists on disk. Decoding it approximately would produce a path that matches the "
                    + "wrong impact glob, or none";
                paths = [];
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Works out how much of a repository-relative path is above the containment root.
    /// </summary>
    /// <param name="repositoryRoot">The canonical absolute path of the repository's top level.</param>
    /// <param name="containmentRoot">The canonical absolute path that <c>--root</c> resolved to.</param>
    /// <param name="prefix">
    /// The segments of <paramref name="containmentRoot"/> below
    /// <paramref name="repositoryRoot"/>, or empty when they are the same directory.
    /// </param>
    /// <param name="rejection">Why the two could not be related, or null.</param>
    /// <returns><see langword="true"/> when the root sits at or inside the repository.</returns>
    /// <remarks>
    /// <b>git diff paths are relative to the repository root, never to the working directory or
    /// to <c>-C</c>.</b> Impact globs are relative to <c>--root</c>. When those two directories
    /// differ, every path has to be rebased before it is matched, or <c>src/**</c> is compared
    /// against <c>tools/EvalCli/src/Foo.cs</c> and quietly matches nothing.
    /// </remarks>
    public static bool TryComputePrefix(
        string repositoryRoot,
        string containmentRoot,
        out string[] prefix,
        out string? rejection
    )
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(repositoryRoot);
        ArgumentException.ThrowIfNullOrWhiteSpace(containmentRoot);

        prefix = [];
        rejection = null;

        var relative = Path.GetRelativePath(repositoryRoot, containmentRoot);

        if (relative is ".")
        {
            return true;
        }

        var segments = relative.Split(
            [Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar],
            StringSplitOptions.RemoveEmptyEntries
        );

        if (segments.Length == 0 || segments.Any(segment => segment is "..") || Path.IsPathRooted(relative))
        {
            // GetRelativePath falls back to the absolute path when the two share no root, and
            // emits '..' when the root is above the repository. Either way --root is not inside
            // the repository, so a repo-relative path cannot be rebased onto it at all.
            rejection =
                $"the --root directory '{containmentRoot}' is not inside the git repository at "
                + $"'{repositoryRoot}', so paths from its diff cannot be made relative to the root that impact "
                + "globs are anchored at";
            return false;
        }

        prefix = segments;
        return true;
    }

    /// <summary>
    /// Rebases one repository-relative path onto the containment root.
    /// </summary>
    /// <param name="repositoryRelativePath">The path exactly as git emitted it.</param>
    /// <param name="prefix">The segments of the containment root below the repository root.</param>
    /// <returns>
    /// The path relative to the containment root, or <see langword="null"/> when it names a file
    /// outside that root.
    /// </returns>
    /// <remarks>
    /// <para>
    /// A file inside the repository but outside <c>--root</c> is answered with
    /// <see langword="null"/> rather than dropped. Dropping it is the quieter answer and the
    /// dangerous one: whatever it mapped to would then be skipped, and the report would look
    /// identical to a run in which it had genuinely matched nothing. The caller turns
    /// <see langword="null"/> into a full-suite run with that file named.
    /// </para>
    /// <para>
    /// Segments are compared the way the host file system compares them, because both sides are
    /// real paths from the same machine. That is a different question from glob matching, which
    /// <c>ImpactGlob</c> deliberately answers case-insensitively everywhere so that one suite and
    /// one changed-file set select the same scenarios on every platform.
    /// </para>
    /// </remarks>
    public static string? Rebase(string repositoryRelativePath, string[] prefix)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(repositoryRelativePath);
        ArgumentNullException.ThrowIfNull(prefix);

        if (prefix.Length == 0)
        {
            return repositoryRelativePath;
        }

        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        var segments = repositoryRelativePath.Split(GitSeparator, StringSplitOptions.RemoveEmptyEntries);

        if (segments.Length <= prefix.Length)
        {
            return null;
        }

        for (var index = 0; index < prefix.Length; index++)
        {
            if (!string.Equals(segments[index], prefix[index], comparison))
            {
                return null;
            }
        }

        return string.Join(GitSeparator, segments[prefix.Length..]);
    }
}
