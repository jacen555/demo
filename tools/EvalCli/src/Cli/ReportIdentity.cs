using System.Security.Cryptography;
using System.Text;

namespace Forge.EvalCli.Cli;

/// <summary>
/// A value that distinguishes one report from another, in a form safe to hash and unsafe to print.
/// </summary>
/// <remarks>
/// <para>
/// <b>A distinct type, because a correctly wired call site is not a structure.</b> Identity and
/// display were previously two <see cref="string"/> members, so assigning the redacted display
/// address to the identity compiled and restored the collision the split was made to prevent.
/// Nothing here can be built from a display string: the factories take a root and a path, or a
/// <see cref="Uri"/>, and <see cref="MarkdownReport.MarkerFor(ReportIdentity, ReportIdentity)"/> accepts nothing else.
/// </para>
/// <para>
/// <b>The encoding is injective, which is the property the marker actually needs.</b> "Not
/// clipped and not redacted" was the instance, not the rule: a lossy normalisation <i>inside</i>
/// the hash input collides two distinct inputs just as surely as one outside it. Each path
/// segment is percent-encoded, so a segment containing a separator cannot be mistaken for two
/// segments — on Linux <c>a\b.json</c> is one file and <c>a/b.json</c> is two, and both are
/// reachable.
/// </para>
/// <para>
/// <b>Splitting happens before encoding, using the platform's own separators.</b> That is what
/// makes a Windows checkout and a Linux checkout of the same repository agree, without reading a
/// backslash as a separator on a platform where it is an ordinary character.
/// </para>
/// <para>
/// <b>This is never printed.</b> It exists to be hashed. Rendering it would reintroduce exactly
/// the disclosure redaction exists to prevent (§V).
/// </para>
/// </remarks>
internal readonly record struct ReportIdentity
{
    private ReportIdentity(string value) => Value = value;

    /// <summary>Gets the canonical, losslessly encoded value. Hashed, never rendered.</summary>
    internal string Value { get; }

    /// <summary>The identity of a path, relative to the root it is contained by.</summary>
    /// <param name="root">The canonical containment root.</param>
    /// <param name="path">The path, absolute or already relative.</param>
    /// <returns>The identity.</returns>
    /// <remarks>
    /// The containment root is excluded, which is what makes the marker stable across machines: a
    /// build agent's checkout lives somewhere else than a developer's, and a marker carrying the
    /// absolute path would post a second comment rather than updating the one already there. A
    /// path that will not relativise into the root keeps every segment it has — completeness
    /// costs nothing in a value that is only ever hashed.
    /// </remarks>
    public static ReportIdentity ForPath(string root, string path) =>
        ForPath(root, path, [Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar]);

    /// <summary>The identity of a path, split on an explicit set of separators.</summary>
    /// <param name="root">The canonical containment root.</param>
    /// <param name="path">The path, absolute or already relative.</param>
    /// <param name="separators">The characters that separate segments on the platform.</param>
    /// <returns>The identity.</returns>
    /// <remarks>
    /// The separators are a parameter so the platform-dependent half of this can be tested
    /// without the platform. On Linux <c>\</c> is an ordinary character in a file name and only
    /// <c>/</c> separates; a Windows test run cannot reach that case any other way, and it is
    /// exactly the case a normalisation inside the hash path would collide.
    /// </remarks>
    internal static ReportIdentity ForPath(string root, string path, char[] separators)
    {
        if (string.IsNullOrEmpty(path))
        {
            return ForSegments([]);
        }

        var relative = path;

        if (Path.IsPathRooted(path))
        {
            try
            {
                var candidate = Path.GetRelativePath(root, path);

                relative = MarkdownReport.LeavesRoot(candidate) ? path : candidate;
            }
            catch (ArgumentException)
            {
                relative = path;
            }
        }

        // Split, and nothing else. Any normalisation applied here — a backslash mapped to a
        // slash, say — would merge two distinct paths before they were ever encoded, which is the
        // same collision the encoding below exists to prevent, moved one step earlier.
        //
        // The discriminator is what keeps an out-of-root path apart from the same segments inside
        // the root: splitting drops the leading separator, so without it `/elsewhere/a` under
        // root `/repo` and `/repo/elsewhere/a` reduce to one value.
        var segments = relative.Split(separators, StringSplitOptions.RemoveEmptyEntries);

        return ForSegments(Path.IsPathRooted(relative) ? ["absolute", .. segments] : segments);
    }

    /// <summary>The identity of an address.</summary>
    /// <param name="endpoint">The unredacted address the baseline was conducted against.</param>
    /// <returns>The identity.</returns>
    /// <remarks>
    /// Scheme, host, port, and path — the same notion of "a different deployment" that
    /// <see cref="RunPlan"/> already refuses a self-comparison on, so the two rules cannot
    /// disagree about what counts as one system. The query string and the fragment are absent
    /// because <see cref="EndpointGuard.ValidateBaselineReference"/> refuses an address carrying
    /// either. The leading discriminator keeps an address from colliding with a path that happens
    /// to encode to the same text.
    /// </remarks>
    public static ReportIdentity ForAddress(Uri endpoint)
    {
        ArgumentNullException.ThrowIfNull(endpoint);

        return ForSegments(["address", endpoint.GetLeftPart(UriPartial.Path)]);
    }

    /// <summary>The identity of an already-split sequence of path segments.</summary>
    /// <param name="segments">The segments, in order.</param>
    /// <returns>The identity.</returns>
    /// <remarks>
    /// Each segment is percent-encoded before the segments are joined, so the joining character
    /// cannot occur inside one. Without that, a single segment containing a separator and two
    /// segments without one produce the same string. The count is prefixed for the same reason at
    /// the other end: no segments and one empty segment both encode to nothing.
    /// </remarks>
    public static ReportIdentity ForSegments(IEnumerable<string> segments)
    {
        ArgumentNullException.ThrowIfNull(segments);

        var encoded = segments.Select(Uri.EscapeDataString).ToArray();

        return new ReportIdentity(
            string.Concat(
                encoded.Length.ToString(System.Globalization.CultureInfo.InvariantCulture),
                ":",
                string.Join('/', encoded)
            )
        );
    }
}

internal static partial class MarkdownReport
{
    /// <summary>
    /// The identity CI finds this report's comment by.
    /// </summary>
    /// <param name="suite">The suite's identity.</param>
    /// <param name="baseline">The baseline's identity.</param>
    /// <returns>Sixteen hex characters.</returns>
    /// <remarks>
    /// <para>
    /// <b>Derived from what the invocation named, never from what the run found.</b> A marker that
    /// moved when a result changed would post a new comment on every push instead of replacing
    /// one, which is the thread-spamming this exists to prevent. So the suite <i>name</i>, the
    /// scenario fingerprints, and every count are deliberately excluded: all of them are content a
    /// pull request is entitled to change while still being the same report.
    /// </para>
    /// <para>
    /// <b>The two inputs are length-prefixed rather than delimited.</b> A newline is a legal
    /// character in a Unix file name, so joining on one makes <c>("a\nb", "c")</c> and
    /// <c>("a", "b\nc")</c> the same byte sequence — two distinct reports sharing a comment slot.
    /// No separator is safe against an input that may contain it; a length prefix needs no
    /// separator to be safe against.
    /// </para>
    /// <para>
    /// Sixteen hex characters is 64 bits. This is an identity, not a security boundary — a
    /// collision means two reports share a comment slot, which is a nuisance, and there is nothing
    /// here for an adversary to gain by forcing one.
    /// </para>
    /// </remarks>
    public static string MarkerFor(ReportIdentity suite, ReportIdentity baseline) =>
        MarkerFor(MarkerSchema, [suite, baseline]);

    /// <summary>
    /// The identity a report of <paramref name="schema"/> finds its own comment by.
    /// </summary>
    /// <param name="schema">The schema the identity is computed under.</param>
    /// <param name="parts">What distinguishes this report from another of the same schema.</param>
    /// <returns>Sixteen hex characters.</returns>
    /// <remarks>
    /// <b>The schema is an input, which is what keeps two <i>kinds</i> of report apart.</b> The
    /// trend and the comparison are deliberately different artifacts answering different
    /// questions; were they to hash to one value over the same suite, CI would find one comment
    /// for both and each push would replace the other's report with its own. A reader would then
    /// see a single comment that silently alternated between two documents.
    /// </remarks>
    internal static string MarkerFor(string schema, IReadOnlyList<ReportIdentity> parts)
    {
        var canonical = new StringBuilder(schema);

        foreach (var part in parts)
        {
            canonical.Append('\u0000').Append(part.Value.Length).Append('\u0000').Append(part.Value);
        }

        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(canonical.ToString()));

        return Convert.ToHexStringLower(digest)[..16];
    }
}
