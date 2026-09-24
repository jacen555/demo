using System.IO.Enumeration;

namespace Forge.EvalEngine.Impact;

/// <summary>
/// A changed-file path reduced to the one canonical form matching is performed against.
/// </summary>
/// <remarks>
/// <para>
/// A changed-file set is <b>untrusted input</b> (§V). It arrives from whatever produced it —
/// <c>git diff</c> emits <c>/</c>, Windows tooling emits <c>\</c>, either may prefix <c>./</c>,
/// and either may contain a <c>..</c>. Matching two spellings of one path against one glob and
/// getting two different answers is a selection bug that shows up as a missing scenario and
/// nothing else, so both sides are reduced here before anything is compared.
/// </para>
/// <para>
/// The canonical form is <b>repo-relative, <c>/</c>-separated, with no empty segment, no
/// <c>.</c> segment, and every <c>..</c> resolved lexically</b>. A path that cannot be expressed
/// that way — blank, absolute, drive-qualified, traversing above the root, or still carrying its
/// producer's quoting — is <b>refused</b> rather than matched approximately, and
/// <see cref="ImpactSelector"/> turns that refusal into a full-suite run. Quietly dropping it
/// would be the cheaper answer and the dangerous one: the scenarios that path mapped to would
/// simply not run.
/// </para>
/// </remarks>
internal sealed class ChangedPath
{
    private ChangedPath(string asWritten, string[] segments)
    {
        AsWritten = asWritten;
        Segments = segments;
    }

    /// <summary>Gets the path exactly as the caller supplied it, for quoting back in a report.</summary>
    public string AsWritten { get; }

    /// <summary>Gets the canonical segments, in order.</summary>
    public string[] Segments { get; }

    /// <summary>Gets the canonical path.</summary>
    public string Normalized => string.Join('/', Segments);

    /// <summary>Reduces a supplied path to canonical form.</summary>
    /// <param name="value">The path as supplied.</param>
    /// <param name="path">The canonical path, or null when it was refused.</param>
    /// <param name="rejection">Why it was refused, phrased to follow the quoted path.</param>
    /// <returns><see langword="true"/> when the path is repo-relative and names a file.</returns>
    public static bool TryNormalize(string? value, out ChangedPath? path, out string? rejection)
    {
        path = null;

        if (string.IsNullOrWhiteSpace(value))
        {
            rejection = "is blank, so it names no file";
            return false;
        }

        // Before separators are normalized, because that is the step which destroys the evidence:
        // the escapes in `"src/caf\303\251.cs"` become separators and the entry reads as an
        // ordinary six-segment path. `git diff --name-only`, the command this library's README
        // hands callers, C-quotes any path containing a non-ASCII byte, a quote, or a control
        // character, and every such path is wrapped in quotes and escaped.
        //
        // Refused rather than decoded, for the reason ImpactGlob refuses a construct it does not
        // implement: a decoder has its own silent failure modes — a truncated escape, an octal
        // run that is not valid UTF-8 — and each of them would have to end in this same refusal
        // anyway. Matching it as written is the one option that is never safe, because a quoted
        // path sits in no directory any glob names: `src/**` misses the file that changed, and
        // the scenario it maps to retires on a prior pass.
        if (value.Contains('"', StringComparison.Ordinal))
        {
            rejection =
                "carries a double quote, so it is still quoted rather than being the path as it exists on disk — "
                + "`git diff --name-only` C-quotes any path containing a non-ASCII byte, a quote, or a control "
                + "character. Matched as written it would name a directory this repository does not have, and the "
                + "scenarios mapped to the file that actually changed would not run. Hand in the decoded path, or "
                + "read the diff with `-z`";
            return false;
        }

        var slashed = value.Replace('\\', '/');

        if (PathSyntax.IsRooted(slashed))
        {
            rejection =
                "is absolute or drive-qualified, and impact globs are repo-relative — there is no "
                + "repository root here to make the two comparable, because this matcher performs no I/O";
            return false;
        }

        if (!PathSyntax.TryResolve(slashed, out var segments))
        {
            rejection = "traverses above the repository root, so it cannot be expressed as a repo-relative path";
            return false;
        }

        if (segments.Length == 0)
        {
            rejection = "resolves to the repository root rather than to a file";
            return false;
        }

        path = new ChangedPath(value, segments);
        rejection = null;
        return true;
    }
}

/// <summary>
/// One impact glob, parsed into segments and matched against a <see cref="ChangedPath"/>.
/// </summary>
/// <remarks>
/// <para>
/// <b>Supported syntax.</b> <c>*</c> matches zero or more characters <i>within one segment</i>.
/// <c>?</c> matches exactly one character within one segment. <c>**</c> matches zero or more
/// whole segments and must stand alone as a complete segment. Separators are <c>/</c> or
/// <c>\</c>; a leading <c>./</c> and interior <c>.</c> segments are dropped. Matching is
/// <b>case-insensitive on every platform</b> — see below.
/// </para>
/// <para>
/// <b>Not supported, and refused rather than reinterpreted.</b> Character classes
/// (<c>[a-z]</c>), brace alternation (<c>{a,b}</c>), gitignore negation (a leading <c>!</c>),
/// <c>..</c> segments, absolute or drive-qualified patterns, and <c>**</c> embedded in a larger
/// segment (<c>**.cs</c>, <c>a**b</c>). Every one of these is a construct a suite author might
/// reasonably expect to work, and every BCL matcher would treat them as <i>literal text</i> —
/// which matches nothing, selects nothing, and reports nothing. Refusing them turns a silent
/// mismatch into an over-selection with a named cause, which is the direction this whole layer
/// leans. A lone <c>]</c> or <c>}</c> is an ordinary character and is matched as one; only the
/// openers introduce an unsupported construct.
/// </para>
/// <para>
/// <b>Case.</b> Insensitive, ordinal, on every platform. The alternative — following the host
/// file system — makes the same suite and the same changed-file set select different scenarios
/// on Windows and on Linux, and the Linux difference is the one that <i>drops</i> scenarios. The
/// cost of this choice is that two files differing only in case are treated as one on a
/// case-sensitive file system, which over-selects. That is the cheap direction.
/// </para>
/// <para>
/// <b>A pattern naming a directory covers what is under it.</b> <c>libs/EvalEngine</c> matches
/// <c>libs/EvalEngine/src/Foo.cs</c>, as though it ended in <c>/**</c>. Matching it literally
/// would silently drop every file in the tree the author named, which is the single most likely
/// authoring mistake and the most expensive one. The prefix is a <b>segment</b> prefix, never a
/// string prefix: <c>libs/EvalEngine</c> does not match <c>libs/EvalEngineOther/src/Foo.cs</c>.
/// </para>
/// </remarks>
internal sealed class ImpactGlob
{
    private const string Globstar = "**";

    /// <summary>The openers of the two expansion constructs this matcher does not implement.</summary>
    private static readonly char[] UnsupportedOpeners = ['[', '{'];

    private ImpactGlob(string pattern, string[] segments)
    {
        Pattern = pattern;
        Segments = segments;
    }

    /// <summary>Gets the pattern exactly as the suite declared it, for quoting back in a report.</summary>
    public string Pattern { get; }

    /// <summary>Gets the canonical pattern segments, in order.</summary>
    public string[] Segments { get; }

    /// <summary>Parses a declared glob, refusing anything that could silently mismatch.</summary>
    /// <param name="pattern">The pattern as declared.</param>
    /// <param name="glob">The parsed glob, or null when it was refused.</param>
    /// <param name="rejection">Why it was refused, phrased to follow the quoted pattern.</param>
    /// <returns><see langword="true"/> when the pattern is one this matcher implements.</returns>
    public static bool TryParse(string? pattern, out ImpactGlob? glob, out string? rejection)
    {
        glob = null;

        if (string.IsNullOrWhiteSpace(pattern))
        {
            rejection = "is blank, so it declares no mapping";
            return false;
        }

        if (pattern.StartsWith('!'))
        {
            rejection =
                "begins with '!', which this matcher does not read as a gitignore-style negation. "
                + "Matching it literally would invert exactly the intent that wrote it";
            return false;
        }

        var unsupported = pattern.IndexOfAny(UnsupportedOpeners);
        if (unsupported >= 0)
        {
            rejection =
                $"contains '{pattern[unsupported]}', which introduces a character class or brace alternation. "
                + "Neither is supported, and every matcher in the BCL treats them as literal text — so accepting "
                + "this pattern would match nothing and quietly shrink the run";
            return false;
        }

        var slashed = pattern.Replace('\\', '/');

        if (PathSyntax.IsRooted(slashed))
        {
            rejection = "is absolute or drive-qualified, and the paths it would be matched against are repo-relative";
            return false;
        }

        var segments = new List<string>();
        foreach (var segment in slashed.Split('/'))
        {
            if (segment.Length == 0 || string.Equals(segment, ".", StringComparison.Ordinal))
            {
                continue;
            }

            if (string.Equals(segment, "..", StringComparison.Ordinal))
            {
                rejection =
                    "contains a '..' segment, which has no unambiguous meaning beside '**' — there is no single "
                    + "path for it to walk back up";
                return false;
            }

            if (
                !string.Equals(segment, Globstar, StringComparison.Ordinal)
                && segment.Contains(Globstar, StringComparison.Ordinal)
            )
            {
                rejection =
                    $"contains the segment '{segment}', in which '**' is neither a whole segment nor a plain "
                    + "single-segment wildcard. '**' must stand alone, because reading it as '*' here would match "
                    + "one segment where the author meant any number";
                return false;
            }

            segments.Add(segment);
        }

        if (segments.Count == 0)
        {
            rejection = "names no path";
            return false;
        }

        glob = new ImpactGlob(pattern, [.. segments]);
        rejection = null;
        return true;
    }

    /// <summary>Determines whether a changed path is covered by this glob.</summary>
    /// <param name="path">The canonical changed path.</param>
    /// <returns>
    /// <see langword="true"/> when the pattern consumes the whole path, or consumes a leading
    /// run of whole segments of it — the case where the pattern names a directory the file lives
    /// under.
    /// </returns>
    /// <remarks>
    /// Matching is a reachability walk rather than a greedy scan with one backtrack point:
    /// <c>reachable[g]</c> records that the first <c>g</c> pattern segments can consume the path
    /// segments seen so far. A pattern with two globstars (<c>a/**/b/**/c</c>) needs more than
    /// one point to retreat to, and the greedy form of this algorithm is where hand-rolled
    /// matchers quietly get that wrong.
    /// </remarks>
    public bool Matches(ChangedPath path)
    {
        ArgumentNullException.ThrowIfNull(path);

        var pattern = Segments;
        var reachable = new bool[pattern.Length + 1];
        var next = new bool[pattern.Length + 1];

        reachable[0] = true;
        CloseGlobstars(pattern, reachable);

        // The pattern is already satisfied before any segment is consumed — `**` alone, matching
        // zero segments. Checked here as well as in the loop so a path of any length answers the
        // same way.
        if (reachable[pattern.Length])
        {
            return true;
        }

        foreach (var segment in path.Segments)
        {
            Array.Clear(next);

            for (var g = 0; g < pattern.Length; g++)
            {
                if (!reachable[g])
                {
                    continue;
                }

                if (string.Equals(pattern[g], Globstar, StringComparison.Ordinal))
                {
                    // The globstar absorbs this segment and stays where it is.
                    next[g] = true;
                }
                else if (SegmentMatches(pattern[g], segment))
                {
                    next[g + 1] = true;
                }
            }

            CloseGlobstars(pattern, next);
            (reachable, next) = (next, reachable);

            // Every pattern segment is spent. Any path segments still to come are below the
            // directory the pattern named, which it covers.
            if (reachable[pattern.Length])
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>Lets every reachable globstar also match zero segments.</summary>
    private static void CloseGlobstars(string[] pattern, bool[] reachable)
    {
        // Ascending, so a run of adjacent globstars collapses in one pass.
        for (var g = 0; g < pattern.Length; g++)
        {
            if (reachable[g] && string.Equals(pattern[g], Globstar, StringComparison.Ordinal))
            {
                reachable[g + 1] = true;
            }
        }
    }

    /// <summary>Matches one pattern segment against one path segment.</summary>
    /// <remarks>
    /// <para>
    /// <see cref="FileSystemName.MatchesSimpleExpression(ReadOnlySpan{char}, ReadOnlySpan{char}, bool)"/>
    /// supplies <c>*</c> and <c>?</c> — with <c>?</c> meaning exactly one character rather than
    /// the DOS "zero or one" — so that part of the matching is the BCL's rather than this
    /// library's.
    /// </para>
    /// <para>
    /// It is fed <b>one segment at a time</b> for two reasons, and both of them are silent bugs
    /// if ignored. Its <c>*</c> crosses <c>/</c> freely, so a whole path handed to it would make
    /// <c>src/*.cs</c> match <c>src/deep/a.cs</c>. And it treats <c>\</c> as an <b>escape
    /// character</b> — <c>a\b</c> matches the name <c>ab</c> — so a pattern still carrying a
    /// Windows separator would match a file that does not exist and miss the one that does. The
    /// separator is normalized and split away long before a segment reaches here, and a segment
    /// with no wildcard in it is compared directly instead.
    /// </para>
    /// </remarks>
    private static bool SegmentMatches(string pattern, string segment) =>
        pattern.AsSpan().ContainsAny('*', '?')
            ? FileSystemName.MatchesSimpleExpression(pattern, segment, ignoreCase: true)
            : string.Equals(pattern, segment, StringComparison.OrdinalIgnoreCase);
}

/// <summary>
/// The lexical path rules both a changed path and a glob are held to.
/// </summary>
/// <remarks>
/// Deliberately independent of the host platform. <see cref="Path.IsPathRooted(string)"/> answers
/// differently on Windows and on Linux, which would make one changed-file set select different
/// scenarios depending on where the run happened — and the platform that says "relative" is the
/// one that then matches it against the wrong thing.
/// </remarks>
internal static class PathSyntax
{
    /// <summary>Determines whether a <c>/</c>-separated path is absolute or drive-qualified.</summary>
    /// <param name="slashed">The path, with separators already normalized to <c>/</c>.</param>
    /// <returns><see langword="true"/> when the path is not repo-relative.</returns>
    /// <remarks>
    /// A UNC path (<c>\\server\share</c>) normalizes to a leading <c>//</c> and is caught by the
    /// first test. <c>C:relative</c> is caught by the second: it is drive-qualified without being
    /// rooted, and is no more comparable to a repo-relative glob than <c>C:\absolute</c> is.
    /// </remarks>
    public static bool IsRooted(string slashed) =>
        slashed.StartsWith('/') || (slashed.Length >= 2 && char.IsAsciiLetter(slashed[0]) && slashed[1] == ':');

    /// <summary>Reduces a <c>/</c>-separated path to canonical segments.</summary>
    /// <param name="slashed">The path, with separators already normalized to <c>/</c>.</param>
    /// <param name="segments">The canonical segments, or empty when the path escapes the root.</param>
    /// <returns><see langword="false"/> when a <c>..</c> walks above the root.</returns>
    /// <remarks>
    /// Interior traversal is <b>resolved</b>, not refused: <c>src/deep/../a.cs</c> names a real
    /// repo-relative file, and refusing it would fall back on every run some tool that emits it
    /// produced — which trains a reader to ignore the fallback, and a fallback nobody reads is
    /// the same as no safety net at all. Traversal that leaves the root is a different thing: it
    /// names a file this repository does not contain, and no glob here could honestly match it.
    /// </remarks>
    public static bool TryResolve(string slashed, out string[] segments)
    {
        var resolved = new List<string>();

        foreach (var segment in slashed.Split('/'))
        {
            if (segment.Length == 0 || string.Equals(segment, ".", StringComparison.Ordinal))
            {
                continue;
            }

            if (string.Equals(segment, "..", StringComparison.Ordinal))
            {
                if (resolved.Count == 0)
                {
                    segments = [];
                    return false;
                }

                resolved.RemoveAt(resolved.Count - 1);
                continue;
            }

            resolved.Add(segment);
        }

        segments = [.. resolved];
        return true;
    }
}
