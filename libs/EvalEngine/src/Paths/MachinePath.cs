namespace Forge.EvalEngine.Paths;

/// <summary>
/// Whether an author-supplied identifier carries a path on somebody's machine.
/// </summary>
/// <remarks>
/// <para>
/// A suite name, a scenario id, and a slicing tag are free text. All three are copied into the
/// committed JSON artifact, and the first two are rendered into a published pull-request comment.
/// A checkout directory among them names the account a job runs as and the layout of the machine
/// it runs on (§V).
/// </para>
/// <para>
/// <b>Why the control is here rather than at the report.</b> Deciding whether a machine path is
/// present inside arbitrary free text is under-constrained: the same characters are an account
/// path in one value and a legitimate route in the next. The consuming report spent five rounds
/// proving that, and today both destroys <c>/api/v1/refund</c> and leaks
/// <c>checkout path:/home/ci-user/repo</c>. An identifier is a different problem, because the
/// constraint is real: it is authored once, in a committed file, by somebody who can be told to
/// change it. So this refuses the value rather than mangling it forever afterwards.
/// </para>
/// <para>
/// <b>The boundary is a token, not "anywhere" and not "the very start".</b> Whitespace begins a
/// new token, and so does a <c>label:</c> separator — but <c>/</c> does not. That is the whole
/// distinction: <c>checkout /home/ci-user/repo</c> and <c>checkout path:/home/ci-user/repo</c>
/// carry a path, while <c>/api/v1/media/upload</c> carries a system root as an <i>interior
/// segment</i> of a route and is left alone. Matching anywhere would refuse the second; anchoring
/// only at the start of the value would admit the first two.
/// </para>
/// <para>
/// <b>Case-sensitive, deliberately.</b> The macOS home root is <c>/Users</c> and the canonical
/// REST collection route is <c>/users</c>. No case-insensitive rule keeps both, and the route is
/// overwhelmingly the more likely thing for an author to have written.
/// </para>
/// <para>
/// <b>What it deliberately does not cover</b>, because each would be a guess rather than a rule:
/// a machine path behind a leading quote (<c>'/home/ci-user/repo'</c>); UNC spelled with forward
/// slashes (<c>//host/share</c>, indistinguishable from a protocol-relative URL); and a drive
/// letter with no separator (<c>C:work</c>, indistinguishable from an identifier such as
/// <c>X:12</c>).
/// </para>
/// <para>
/// <b>Labels are guarded; evidence is not.</b> This is applied to the suite name, scenario ids,
/// and slicing tags — names somebody chose, where a machine path is always an authoring error. It
/// is deliberately <i>not</i> applied to stimuli, transcripts, or assertion expressions. Those are
/// the record of what was actually sent and observed, and a path in one may be exactly what the
/// system under test requires; refusing or scrubbing them would destroy the artifact's reason to
/// exist. Do not "tighten" this by extending it to them.
/// </para>
/// </remarks>
internal static class MachinePath
{
    /// <summary>
    /// The rooted directories that name a machine rather than a route.
    /// </summary>
    /// <remarks>
    /// <para>
    /// An allowlist rather than a shape, because shape alone cannot tell <c>/home/ci-user/repo</c>
    /// from <c>/orders/{id}/refund</c> — both are a rooted path of two or more segments.
    /// </para>
    /// <para>
    /// <b><c>media</c> and <c>workspace</c> are deliberately absent.</b> Both are ordinary REST
    /// resource names — <c>/media/upload</c>, <c>/workspace/42</c> — before they are system
    /// directories, and refusing an identifier an author had every reason to write is a worse
    /// failure than the disclosure it would prevent. <c>opt</c> and <c>srv</c> are kept because
    /// neither is idiomatic as a resource collection: an API exposes <c>/preferences</c> and
    /// <c>/services</c>, not <c>/opt</c> and <c>/srv</c>.
    /// </para>
    /// </remarks>
    private static readonly string[] SystemRoots = ["home", "Users", "root", "var", "tmp", "mnt", "opt", "srv"];

    /// <summary>
    /// The request methods whose route token is exempt.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>METHOD /route</c> is idiomatic in this domain, and without this the token rule refuses
    /// <c>GET /home/dashboard</c>. The exemption is the narrower concession than dropping
    /// <c>home</c> from <see cref="SystemRoots"/>, because <c>/home/&lt;account&gt;</c> is the
    /// classic disclosure this guard exists for.
    /// </para>
    /// <para>
    /// <b>A closed set, matched exactly, in the leading position only.</b> "Any leading word"
    /// would be the label hole reopened under another name — <c>checkout /home/ci-user/repo</c>
    /// would sail through.
    /// </para>
    /// <para>
    /// <b>Case-sensitive.</b> RFC 9110 §9.1 defines the method token as case-sensitive and
    /// uppercase, so <c>get</c> is not <c>GET</c>; this repository's fixtures are uppercase; and
    /// every exemption is a hole, so it takes the narrowest spelling that satisfies the
    /// requirement. Widening later on evidence costs one line and a test. It is also what
    /// <see cref="SystemRoots"/> already does with <c>/Users</c> against <c>/users</c> — one
    /// convention, not two.
    /// </para>
    /// </remarks>
    private static readonly string[] ExemptMethods =
    [
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "HEAD",
        "OPTIONS",
        "TRACE",
        "CONNECT",
    ];

    /// <summary>Whether <paramref name="value"/> carries an unmistakable machine path.</summary>
    /// <param name="value">The suite name, scenario id, or slicing tag, as the author wrote it.</param>
    /// <returns><see langword="true"/> when the value must be refused.</returns>
    public static bool IsPresentIn(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return false;
        }

        var text = value.AsSpan();
        var cursor = 0;
        var ordinal = 0;
        var addressed = false;

        while (cursor < text.Length)
        {
            while (cursor < text.Length && char.IsWhiteSpace(text[cursor]))
            {
                cursor++;
            }

            if (cursor >= text.Length)
            {
                break;
            }

            var start = cursor;

            while (cursor < text.Length && !char.IsWhiteSpace(text[cursor]))
            {
                cursor++;
            }

            var token = text[start..cursor];

            if (ordinal == 0 && IsExemptMethod(token))
            {
                addressed = true;
            }
            else if (ordinal == 1 && addressed)
            {
                // The route the method addresses. Only the Unix-root *route shape* is waived —
                // that is the one ambiguity the exemption was granted for, because
                // `/home/dashboard` is a plausible route and is not distinguishable in text from
                // `/home/<account>`. A drive prefix and a UNC path carry no such ambiguity:
                // neither is ever a route, so there is nothing to concede and they stay refused.
                if (IsDriveRooted(token) || IsUncRooted(token) || CarriesLabelledPath(token))
                {
                    return true;
                }
            }
            else if (StartsPath(token) || CarriesLabelledPath(token))
            {
                return true;
            }

            ordinal++;
        }

        return false;
    }

    /// <summary>Whether any of the values carries an unmistakable machine path.</summary>
    /// <param name="values">The values to inspect. Nulls are ignored.</param>
    /// <returns><see langword="true"/> when at least one must be refused.</returns>
    public static bool IsPresentInAny(IEnumerable<string?> values)
    {
        ArgumentNullException.ThrowIfNull(values);

        foreach (var value in values)
        {
            if (IsPresentIn(value))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Whether one token is exactly one of <see cref="ExemptMethods"/>.
    /// </summary>
    /// <remarks>
    /// An exact ordinal match, not a prefix one: <c>GETX /home/ci-user/repo</c> is not a request
    /// line, and admitting it would turn a closed set back into a shape.
    /// </remarks>
    private static bool IsExemptMethod(ReadOnlySpan<char> token)
    {
        foreach (var method in ExemptMethods)
        {
            if (token.Equals(method.AsSpan(), StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// The address schemes whose authority may look like a system root.
    /// </summary>
    /// <remarks>
    /// Matched <b>case-insensitively</b>, because RFC 3986 §3.1 defines a scheme as
    /// case-insensitive. That is a deliberate asymmetry with <see cref="ExemptMethods"/>, which
    /// RFC 9110 §9.1 defines as case-sensitive — two specifications, not two conventions.
    /// </remarks>
    private static readonly string[] AddressSchemes = ["http", "https", "ws", "wss"];

    /// <summary>
    /// Whether a token carries a path behind a <c>label:</c> separator.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This is what closes <c>checkout path:/home/ci-user/repo</c>, which the report-side pattern
    /// cannot see because it excludes <c>:</c> wholesale to protect <c>https://</c>.
    /// </para>
    /// <para>
    /// <b>Stated as what it admits, not what it skips.</b> Five separate holes in this repository
    /// came from writing a colon rule as an exclusion — each fix correct about the case in front
    /// of it and silent about the next variant. So: a colon is treated as an address, and the
    /// path check waived, <b>only</b> when what surrounds it is an absolute URL — a scheme from
    /// <see cref="AddressSchemes"/>, then <c>//</c>, then a non-empty authority. Everything else
    /// that a colon can be is a label, and the path after it is checked. If you need to widen
    /// this, widen <see cref="AddressSchemes"/> or <see cref="OpensAbsoluteUrl"/>; do not add
    /// another thing to skip.
    /// </para>
    /// </remarks>
    private static bool CarriesLabelledPath(ReadOnlySpan<char> token)
    {
        for (var index = 0; index < token.Length - 1; index++)
        {
            if (token[index] != ':' || OpensAbsoluteUrl(token, index))
            {
                continue;
            }

            if (StartsPath(token[(index + 1)..]))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Whether the colon at <paramref name="colon"/> is the scheme separator of an absolute URL.
    /// </summary>
    /// <param name="token">The whole token.</param>
    /// <param name="colon">The index of the colon being considered.</param>
    /// <returns><see langword="true"/> when this is an address rather than a label.</returns>
    /// <remarks>
    /// <para>
    /// Three requirements, all of them positive. The colon must be preceded by a scheme this
    /// engine recognises as addressing a network host; it must be followed by exactly the two
    /// slashes that introduce an authority; and the authority must be <b>non-empty</b> — which is
    /// what <c>path:///home/ci-user/repo</c> fails, having three slashes and no host at all.
    /// </para>
    /// <para>
    /// <c>file:</c> is deliberately absent from <see cref="AddressSchemes"/>: a <c>file://</c> URL
    /// <i>is</i> a machine path, which is the thing being refused rather than admitted.
    /// </para>
    /// <para>
    /// The scheme is read as the run of scheme characters immediately before the colon rather
    /// than from the start of the token, so a URL sitting at the tail of a longer token is still
    /// recognised.
    /// </para>
    /// </remarks>
    private static bool OpensAbsoluteUrl(ReadOnlySpan<char> token, int colon)
    {
        var after = token[(colon + 1)..];

        // "//" then at least one character of authority that is not itself a separator.
        if (after.Length < 3 || after[0] != '/' || after[1] != '/' || after[2] == '/')
        {
            return false;
        }

        var start = colon;

        while (start > 0 && IsSchemeCharacter(token[start - 1]))
        {
            start--;
        }

        var scheme = token[start..colon];

        if (scheme.Length == 0 || !char.IsAsciiLetter(scheme[0]))
        {
            return false;
        }

        foreach (var known in AddressSchemes)
        {
            if (scheme.Equals(known.AsSpan(), StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>A character permitted in a URI scheme by RFC 3986 §3.1.</summary>
    private static bool IsSchemeCharacter(char character) =>
        char.IsAsciiLetterOrDigit(character) || character is '+' or '-' or '.';

    private static bool StartsPath(ReadOnlySpan<char> text) =>
        IsDriveRooted(text) || IsUncRooted(text) || IsSystemRooted(text);

    /// <summary><c>C:\Users\…</c> or <c>D:/build/…</c>.</summary>
    /// <remarks>
    /// The separator is required. <c>C:</c> followed by anything else is a drive-relative path in
    /// theory and an ordinary identifier such as <c>X:12</c> in practice, and this cannot tell
    /// them apart.
    /// </remarks>
    private static bool IsDriveRooted(ReadOnlySpan<char> text) =>
        text.Length >= 3 && char.IsAsciiLetter(text[0]) && text[1] == ':' && text[2] is '\\' or '/';

    /// <summary><c>\\host\share\…</c>.</summary>
    /// <remarks>
    /// A host character is required so a bare <c>\\</c> is not read as a path. A share is not:
    /// <c>\\build-host</c> already names somebody's machine, and no identifier anybody writes on
    /// purpose opens with two backslashes.
    /// </remarks>
    private static bool IsUncRooted(ReadOnlySpan<char> text) =>
        text.Length >= 3 && text[0] == '\\' && text[1] == '\\' && text[2] is not ('\\' or '/');

    /// <summary><c>/home/…</c>, <c>/Users/…</c>, and the rest of <see cref="SystemRoots"/>.</summary>
    /// <remarks>
    /// <para>
    /// A leading run of separators is collapsed before the root is read. <c>//home/ci-user/repo</c>
    /// evaded the report-side pattern outright and is a real leak in this repository's history,
    /// and collapsing costs nothing: a route spelled with a redundant leading slash still does not
    /// begin with a system root.
    /// </para>
    /// <para>
    /// A segment after the root is required, so <c>/home</c> and <c>/var</c> — shapes a route
    /// takes, and paths that lead nowhere — keep loading.
    /// </para>
    /// </remarks>
    private static bool IsSystemRooted(ReadOnlySpan<char> text)
    {
        var separators = 0;

        while (separators < text.Length && text[separators] == '/')
        {
            separators++;
        }

        if (separators == 0)
        {
            return false;
        }

        var rooted = text[separators..];

        foreach (var root in SystemRoots)
        {
            if (
                rooted.Length > root.Length + 1
                && rooted[root.Length] == '/'
                && rooted.StartsWith(root.AsSpan(), StringComparison.Ordinal)
            )
            {
                return true;
            }
        }

        return false;
    }
}
