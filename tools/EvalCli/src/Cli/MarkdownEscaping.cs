using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Forge.EvalCli.Cli;

internal static partial class MarkdownReport
{
    /// <summary>
    /// What prefixes a redacted machine path in author-supplied text.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A suite name and a scenario id are free text written by whoever wrote the suite, and this
    /// document is read by anyone who can read the repository. A path such as
    /// <c>/home/ci-runner/deploy</c> or <c>C:\Users\someone\work</c> names the account a job runs
    /// as and the layout of the machine it runs on, neither of which is evidence about the change
    /// under review (§V).
    /// </para>
    /// <para>
    /// <b>This is a safety net, not the control — and it is now written like one.</b> The control
    /// is <c>Forge.EvalEngine</c>'s refusal at suite load and at artifact read-back, which can
    /// tell the author to rename the value instead of mangling it on every push forever. This
    /// catches what gets past that: an artifact written by an older build, and any gap the
    /// engine's guard turns out to have. It does not try to be exhaustive, because trying is what
    /// produced the five rounds described on <see cref="MachinePath"/>.
    /// </para>
    /// <para>
    /// <b>The alias is a stand-in, not concealment.</b> It is an unkeyed digest of the matched
    /// text, so a guessable path — <c>/home/&lt;username&gt;/repo</c> over a known username list —
    /// is confirmable by anyone who cares to try. What it buys is that two different paths do not
    /// collapse into one indistinguishable string, which is the disappearance this document exists
    /// to prevent. Do not read it as a confidentiality boundary.
    /// </para>
    /// </remarks>
    private const string RedactedPathPrefix = "[path-redacted:";

    /// <summary>
    /// The rooted directories that name a machine rather than a resource.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Deliberately duplicated from the engine's list rather than shared. That one is internal to
    /// <c>Forge.EvalEngine</c>, and coupling a presentation control to a loader's internals to
    /// save eight strings would make a change to either a change to both. The two are allowed to
    /// diverge, and <see cref="MachinePath"/> records where they do.
    /// </para>
    /// <para>
    /// <b><c>media</c> and <c>workspace</c> are absent on purpose</b>, as they are in the engine:
    /// both are ordinary REST resource names — <c>/media/upload</c>, <c>/workspace/42</c> —
    /// before they are system directories.
    /// </para>
    /// </remarks>
    private const string SystemRoots = "home|Users|root|var|tmp|mnt|opt|srv";

    /// <summary>
    /// The address schemes whose authority may be spelled like a system root.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Matched <b>case-insensitively</b>, because RFC 3986 §3.1 defines a scheme as
    /// case-insensitive. That is a deliberate asymmetry with the engine's request-method
    /// exemption, which RFC 9110 §9.1 defines as case-sensitive — two specifications, not two
    /// conventions. Do not unify them.
    /// </para>
    /// <para>
    /// <b><c>file</c> is deliberately absent.</b> A <c>file://</c> URL <i>is</i> a machine path.
    /// It is the thing being refused, not admitted.
    /// </para>
    /// </remarks>
    private const string AddressSchemes = "https?|wss?";

    /// <summary>
    /// Matches an unmistakable machine path and everything after it in the same value.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>An allowlist of roots, not a shape.</b> This is the narrowing, and it is the point of
    /// the change. No shape rule can tell <c>/home/ci-user/repo</c> from <c>/orders/{id}/refund</c>
    /// — both are a rooted path of two or more segments — so the shape rule this replaces redacted
    /// <c>/api/v1/refund</c> to an alias on every push while still leaking
    /// <c>checkout path:/home/ci-user/repo</c>. A heuristic that mangles good data and misses bad
    /// data is worse than a narrow one that admits what it cannot see. <b>Route-shaped identifiers
    /// render verbatim.</b>
    /// </para>
    /// <para>
    /// <b>What it catches:</b> a path under one of <see cref="SystemRoots"/> with a segment
    /// beneath it; a drive letter followed by a separator (<c>C:\…</c>, <c>D:/…</c>); and a UNC
    /// host (<c>\\build-host\…</c>). Case-sensitive, so the macOS <c>/Users</c> is caught and the
    /// REST collection <c>/users</c> is not.
    /// </para>
    /// <para>
    /// <b>What it does not catch, and will not be extended to:</b> a machine path under any other
    /// root (<c>/workspace/ci-user/repo</c>, <c>/data/…</c>, <c>/scratch/…</c>); a relative or
    /// tilde path (<c>ci-user/repo</c>, <c>~/repo</c>); UNC spelled with forward slashes
    /// (<c>//host/share</c>, indistinguishable from a protocol-relative URL); a drive letter with
    /// no separator (<c>C:work</c>, indistinguishable from an identifier such as <c>X:12</c>);
    /// and a path in the <i>path</i> of a URL. Each of those is a guess, and every previous guess
    /// cost a legitimate identifier. They are the engine's job, at the layer that can refuse them.
    /// </para>
    /// <para>
    /// <b>It is also stricter than the engine in one place:</b> the engine exempts a leading
    /// request method, so <c>GET /home/dashboard</c> loads. This redacts it. The costs are not
    /// symmetric — a false positive here is one heading rendered as an alias, with the JSON
    /// artifact still carrying the value verbatim, while a false positive there stops the work —
    /// and a net that copies the control's exemptions inherits its blind spots, which leaves
    /// <c>GET /home/ci-user/repo</c> with nothing looking at it at all.
    /// </para>
    /// <para>
    /// <b>A colon is read as an address only when it opens an absolute URL — stated as what it
    /// admits, never as what it skips.</b> This mirrors <c>MachinePath.OpensAbsoluteUrl</c> in the
    /// engine, and mirrors the <i>rule</i> rather than its examples, because an earlier version of
    /// this pattern copied the cases and let the rule underneath them drift. Three positive
    /// requirements, all of them necessary:
    /// </para>
    /// <list type="number">
    /// <item><description>
    /// <b>A scheme from <see cref="AddressSchemes"/></b>, read as the whole run of RFC 3986 §3.1
    /// scheme characters before the colon — so <c>foo-https://home/ci-user/repo</c> has the scheme
    /// <c>foo-https</c>, which nothing recognises, and is a path.
    /// </description></item>
    /// <item><description>
    /// <b>Exactly the two slashes that introduce an authority.</b>
    /// </description></item>
    /// <item><description>
    /// <b>A non-empty authority</b> — which is what <c>https:///home/ci-user/repo</c> fails,
    /// having three slashes and no host at all. The requirement lives in the split below: the
    /// exemption is attached only to the alternative that matches exactly <c>//</c>, so a run of
    /// one or of three-or-more slashes never reaches it.
    /// </description></item>
    /// </list>
    /// <para>
    /// Five separate holes in this repository came from writing this as an exclusion — <c>//home</c>,
    /// <c>path:/</c>, <c>path:///</c>, quoted, spaced — each fix correct about the case in front of
    /// it and silent about the next variant. <b>If a new variant appears, restate what this admits;
    /// do not add another thing for it to skip.</b>
    /// </para>
    /// <para>
    /// <b>The match runs to the end of the value.</b> Stopping at the first space redacted
    /// <c>/home/john</c> and left <c> smith/repo</c> on the page, which is most of what this
    /// existed to prevent — and nothing in the text distinguishes a space inside a path from one
    /// after it. Losing a trailing word is the cheaper error.
    /// </para>
    /// </remarks>
    [GeneratedRegex(
        $@"(?<![A-Za-z0-9._~/\\-])(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]|(?<!(?:\A|[^A-Za-z0-9+.\-])(?i:{AddressSchemes}):)//(?:{SystemRoots})/[^\s]|(?:/{{3,}}|/)(?:{SystemRoots})/[^\s]).*",
        RegexOptions.CultureInvariant
    )]
    private static partial Regex MachinePath();

    /// <summary>
    /// Reduces a value supplied by somebody else to text that cannot forge this document.
    /// </summary>
    /// <param name="value">The scenario id, reason, path, or address.</param>
    /// <param name="maximum">The longest form of it this report will carry.</param>
    /// <returns>The safe form.</returns>
    /// <remarks>
    /// <para>
    /// Three rules, and all three are about a value being read as structure rather than as
    /// content:
    /// </para>
    /// <list type="bullet">
    /// <item><description>
    /// <b>Line breaks become spaces.</b> Every entry in this report is a line, so a value
    /// carrying a newline could open a heading, a list item, or a blockquote of its own.
    /// </description></item>
    /// <item><description>
    /// <b>HTML comment delimiters are replaced, visibly.</b> CI finds the comment it is replacing
    /// by searching the raw text for the marker, and a suite author names the scenarios — without
    /// this, an id could plant a second marker and send a find-and-replace at the wrong comment.
    /// The replacement is legible rather than silent, because an identifier quietly edited is its
    /// own small forgery.
    /// </description></item>
    /// <item><description>
    /// <b>An over-long value is clipped and marked.</b> Unbounded author text would put the
    /// document's own frame over the comment limit, at which point nothing could be rendered
    /// honestly at all. The clip carries <see cref="ClipMarker"/> so a shortened value is never
    /// mistaken for the whole one.
    /// </description></item>
    /// </list>
    /// <para>
    /// The durable record keeps every value as it was: this is the rendering, and the JSON
    /// artifact is the evidence.
    /// </para>
    /// <para>
    /// <b>Internal rather than private, because stderr is a published surface the net did not
    /// previously cover.</b> ADR 0005 puts the control at authoring time and keeps this as a
    /// narrow net at the rendering boundary — but the authoring-time control exempts a leading
    /// request method, so <c>GET /home/ci-user/repo</c> loads and survives artifact read-back.
    /// That concession was documented against one output channel. A refusal written to the build
    /// log is a second channel, and it must go through the same net rather than inherit the
    /// concession by omission. <see cref="Prose"/> and <see cref="Code"/> layer markup on top of
    /// this; a diagnostic wants the plain form.
    /// </para>
    /// </remarks>
    internal static string Sanitize(string? value, int maximum)
    {
        if (string.IsNullOrEmpty(value))
        {
            return string.Empty;
        }

        var text = MachinePath().Replace(Flatten(value), match => Alias(match, AliasHexLength));

        if (text.Length <= maximum)
        {
            return text;
        }

        var keep = maximum;

        if (char.IsHighSurrogate(text[keep - 1]))
        {
            keep--;
        }

        return string.Concat(text.AsSpan(0, keep), ClipMarker);
    }

    /// <summary>
    /// Applies the two structural rewrites that precede the net, so both callers see one
    /// implementation of them.
    /// </summary>
    /// <param name="value">The value.</param>
    /// <returns>The value with control characters and comment delimiters neutralised.</returns>
    /// <remarks>
    /// Extracted so <see cref="ContainsMachinePath"/> asks its question about exactly the text
    /// <see cref="Sanitize"/> would have run the net over. Asking it about the raw value instead
    /// would disagree wherever a control character sits inside a path — a rule implemented twice
    /// is one that eventually disagrees with itself (ADR 0005).
    /// </remarks>
    private static string Flatten(string value)
    {
        var flattened = new StringBuilder(value.Length);

        foreach (var character in value)
        {
            flattened.Append(char.IsControl(character) ? ' ' : character);
        }

        return flattened.Replace("<!--", CommentMarkerRemoved).Replace("-->", CommentMarkerRemoved).ToString();
    }

    /// <summary>
    /// Whether the net would alias something in this value.
    /// </summary>
    /// <param name="value">The value.</param>
    /// <returns><see langword="true"/> when it carries a machine path the net matches.</returns>
    /// <remarks>
    /// <para>
    /// <b><see cref="Sanitize"/> has four effects and only one of them is redaction.</b> It
    /// flattens control characters, replaces comment delimiters, aliases machine paths, and clips
    /// over-long text. A caller that infers "a path was found" from "the string changed" is
    /// therefore wrong three ways out of four — and a diagnostic that acts on that inference tells
    /// an author to rename a path that is not there, which sends them looking for nothing and
    /// teaches them the tool is unreliable.
    /// </para>
    /// <para>
    /// So the question is asked directly rather than inferred from the result. This is the only
    /// honest way to distinguish the redaction from the other three.
    /// </para>
    /// </remarks>
    internal static bool ContainsMachinePath(string? value) =>
        !string.IsNullOrEmpty(value) && MachinePath().IsMatch(Flatten(value));

    /// <summary>
    /// Renders a value supplied by somebody else as prose, with no structure of its own.
    /// </summary>
    /// <param name="value">The refusal reason, withholding reason, or other free text.</param>
    /// <param name="maximum">The longest form of it this report will carry.</param>
    /// <returns>The safe form.</returns>
    /// <remarks>
    /// <para>
    /// <see cref="Sanitize"/> handles what could forge the <i>document</i> — line breaks, comment
    /// delimiters, machine paths, unbounded length. This handles what could forge the
    /// <i>markup</i>: a value rendered outside a code span is otherwise interpreted, so HTML in a
    /// reason becomes an element and a bracket pair becomes a link.
    /// </para>
    /// <para>
    /// Block-level injection is already impossible because the line breaks are gone, so only the
    /// inline constructs need neutralising. HTML entities first, so the ampersand introduced by
    /// escaping is not escaped again.
    /// </para>
    /// <para>
    /// Applied only to values this tool did not write. Its own standing explanations are markup on
    /// purpose, and passing them through here would print their emphasis as literal asterisks.
    /// </para>
    /// <para>
    /// <b>Internal rather than private, so <see cref="TrendReport"/> escapes through this one
    /// implementation.</b> ADR 0005's finding applies exactly: a redaction net written twice is
    /// two nets that drift, and the one that drifts is the one that leaks.
    /// </para>
    /// </remarks>
    internal static string Prose(string? value, int maximum)
    {
        var text = Sanitize(value, maximum)
            .Replace("&", "&amp;", StringComparison.Ordinal)
            .Replace("<", "&lt;", StringComparison.Ordinal)
            .Replace(">", "&gt;", StringComparison.Ordinal);

        var escaped = new StringBuilder(text.Length);

        foreach (var character in text)
        {
            if (character is '`' or '*' or '_' or '[' or ']' or '|' or '\\')
            {
                escaped.Append('\\');
            }

            escaped.Append(character);
        }

        return escaped.ToString();
    }

    /// <summary>
    /// Wraps a value in a code span that survives whatever the value contains.
    /// </summary>
    /// <param name="value">The value.</param>
    /// <returns>The code span.</returns>
    /// <remarks>
    /// Backtick runs are fenced by a longer run, and a value that starts or ends with a backtick
    /// is padded, which is what CommonMark requires — so a scenario id containing one is rendered
    /// as itself rather than breaking the rest of the line into literal text. Displaying an
    /// identifier wrongly is a small thing; a broken span that swallows the sentence after it is
    /// not.
    /// </remarks>
    internal static string Code(string? value)
    {
        var text = Sanitize(value, MaxIdentifierCharacters);

        if (text.Length == 0)
        {
            return "`(empty)`";
        }

        var longest = 0;
        var run = 0;

        foreach (var character in text)
        {
            run = character == '`' ? run + 1 : 0;
            longest = Math.Max(longest, run);
        }

        var fence = new string('`', longest + 1);
        var pad = text[0] == '`' || text[^1] == '`' ? " " : string.Empty;

        return string.Concat(fence, pad, text, pad, fence);
    }

    /// <summary>How many hex digits of the digest an alias carries.</summary>
    /// <remarks>
    /// Sixty-four bits. Wide enough that two paths in one report colliding is not a practical
    /// concern, and <see cref="RequireDistinctAliases"/> checks rather than assumes it.
    /// </remarks>
    private const int AliasHexLength = 16;

    /// <summary>
    /// A stable, distinct stand-in for one redacted path.
    /// </summary>
    /// <param name="match">The matched path.</param>
    /// <param name="hexLength">How many digest digits to carry.</param>
    /// <returns>The alias.</returns>
    /// <remarks>
    /// Stable, so the same scenario reads the same way on every push, and distinct, so two
    /// scenarios do not collapse into one string. <b>It is not concealment</b>: the digest is
    /// unkeyed, so a guessable path is confirmable by anyone who cares to try. See
    /// <see cref="RedactedPathPrefix"/>.
    /// </remarks>
    private static string Alias(Match match, int hexLength)
    {
        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(match.Value));

        return string.Concat(RedactedPathPrefix, Convert.ToHexStringLower(digest)[..hexLength], "]");
    }

    /// <summary>
    /// Refuses a report in which two different redacted paths would render as one alias.
    /// </summary>
    /// <param name="values">Every author-supplied value the document will carry.</param>
    /// <param name="hexLength">
    /// How many digest digits an alias carries. A parameter so the collision branch is reachable:
    /// at the real width no test can construct one, and a guard nothing can exercise reads like
    /// protection that is not there.
    /// </param>
    /// <exception cref="InvalidOperationException">Two distinct paths share an alias.</exception>
    /// <remarks>
    /// <para>
    /// The alias is a truncated digest, so distinct inputs <i>can</i> collide. Two scenarios
    /// rendering as one string is exactly the indistinguishability the alias was introduced to
    /// remove, so it is checked rather than assumed.
    /// </para>
    /// <para>
    /// Checked over the inputs rather than by threading a ledger through every formatting helper:
    /// the values that can be redacted are the suite name, the scenario identifiers, and the
    /// reason strings, and this layer already holds all of them.
    /// </para>
    /// </remarks>
    internal static void RequireDistinctAliases(IEnumerable<string?> values, int hexLength = AliasHexLength)
    {
        var byAlias = new Dictionary<string, string>(StringComparer.Ordinal);
        var byRendering = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var value in values)
        {
            if (string.IsNullOrEmpty(value))
            {
                continue;
            }

            // The text the renderer nets, not the value as recorded. Sanitize flattens control
            // characters and replaces comment delimiters before the net ever runs, so a guard
            // asking about the raw value is asking about a different string from the one that
            // reaches the page — it invents aliases for shapes that flatten away, and misses
            // collisions between shapes that only appear once flattened.
            var flattened = Flatten(value);

            foreach (var match in MachinePath().Matches(flattened).Cast<Match>())
            {
                var alias = Alias(match, hexLength);

                if (
                    byAlias.TryGetValue(alias, out var first)
                    && !string.Equals(first, match.Value, StringComparison.Ordinal)
                )
                {
                    throw new InvalidOperationException(
                        $"Two different paths in this comparison redact to the same alias {alias}, so the report "
                            + "would render them as one string. Regenerate with the scenario renamed."
                    );
                }

                byAlias[alias] = match.Value;
            }

            // Sharing Flatten is necessary and not sufficient. Two distinct values can survive
            // the per-path check and still arrive at the page identical — because they flatten to
            // the same text, or because a comment delimiter was replaced in one of them. The only
            // claim worth making is about what is actually rendered, so it is made about that.
            var rendered = MachinePath().Replace(flattened, match => Alias(match, hexLength));

            if (
                byRendering.TryGetValue(rendered, out var earlier)
                && !string.Equals(earlier, value, StringComparison.Ordinal)
            )
            {
                throw new InvalidOperationException(
                    "Two different values in this comparison render identically, so the report would show them as "
                        + "one entry. Regenerate with the scenario renamed."
                );
            }

            byRendering[rendered] = value;
        }
    }

    /// <summary>
    /// Whether a relative path leaves the directory it was computed against.
    /// </summary>
    /// <remarks>
    /// <b>A prefix test on <c>".."</c> is wrong.</b> <c>..hidden/suite.json</c> is an ordinary
    /// directory inside the root, and treating it as an escape reduced it to its file name — which
    /// both mangled the displayed path and collided its marker with every other suite of the same
    /// file name. The segment has to be exactly <c>..</c>.
    /// </remarks>
    /// <param name="relative">The relative path.</param>
    /// <returns><see langword="true"/> when it escapes.</returns>
    internal static bool LeavesRoot(string relative) =>
        Path.IsPathRooted(relative)
        || string.Equals(relative, "..", StringComparison.Ordinal)
        || relative.StartsWith("../", StringComparison.Ordinal)
        || relative.StartsWith(@"..\", StringComparison.Ordinal);

    /// <summary>
    /// States a path the way a pull-request comment may carry it: relative to the root, separated
    /// with <c>/</c>, and bounded.
    /// </summary>
    /// <param name="root">The canonical containment root.</param>
    /// <param name="path">The path, absolute or already relative.</param>
    /// <returns>The path relative to the root.</returns>
    /// <remarks>
    /// <para>
    /// <b>No absolute path reaches this document.</b> A build agent's checkout directory names the
    /// account the job runs as and the layout of the machine it runs on, neither of which is
    /// evidence about the change under review, and a pull-request comment is read by anyone who
    /// can read the repository (§V).
    /// </para>
    /// <para>
    /// A path that will not relativise into the root falls back to its file name — unreachable
    /// through <see cref="PathGuard"/>, which contains every path this tool accepts, and the
    /// conservative direction regardless: a bare name is a loss of context, an absolute one is a
    /// disclosure. <see cref="ReportIdentity.ForPath(string, string)"/> deliberately does not do this: it is hashed, never shown.
    /// </para>
    /// </remarks>
    internal static string Display(string root, string path)
    {
        if (string.IsNullOrEmpty(path))
        {
            return string.Empty;
        }

        if (!Path.IsPathRooted(path))
        {
            return Sanitize(path.Replace('\\', '/'), MaxPathCharacters);
        }

        string relative;

        try
        {
            relative = Path.GetRelativePath(root, path);
        }
        catch (ArgumentException)
        {
            relative = Path.GetFileName(path);
        }

        if (LeavesRoot(relative))
        {
            relative = Path.GetFileName(path);
        }

        return Sanitize(relative.Replace('\\', '/'), MaxPathCharacters);
    }
}
