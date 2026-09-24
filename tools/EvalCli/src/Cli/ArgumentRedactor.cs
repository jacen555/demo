using System.CommandLine.Parsing;
using System.Text;

namespace Forge.EvalCli.Cli;

/// <summary>
/// Removes caller-supplied values from parser-generated text on its way to standard error.
/// </summary>
/// <remarks>
/// <para>
/// <b>This sits at the output boundary, not at the point of interpretation.</b> A parse error is
/// produced before any handler runs, by machinery that has never heard of
/// <see cref="EndpointGuard"/> and cannot know that <c>--endpoint</c> is the option whose value
/// hides a token. Redacting where a value is understood therefore protects nothing that fails to
/// parse — and an unrecognized argument is precisely the case where the value was never
/// understood. Every value on a command line is untrusted from the moment it arrives, so the rule
/// belongs where text leaves the process: applied there it covers every option this tool has and
/// every option it grows, with nobody having to remember.
/// </para>
/// <para>
/// <c>System.CommandLine</c> quotes the values it names. Rewriting those quoted spans keeps the
/// half of the message that says <i>what</i> was wrong — which option, which expected type — and
/// drops the half the caller supplied. A span is echoed only when it cannot be a supplied value,
/// or when its shape makes it an option name rather than a secret.
/// </para>
/// </remarks>
internal static class ArgumentRedactor
{
    /// <summary>
    /// The length at or above which a supplied value is also matched inside a larger quoted span.
    /// </summary>
    /// <remarks>
    /// Exact matches are always redacted. Substring matching exists for a message shape that
    /// quotes a value together with something else, but applied to very short values it would
    /// redact the parser's own words — a caller who passed <c>--root .</c> would turn
    /// <c>'System.Int64'</c> into a marker. Below this length a value cannot meaningfully be a
    /// credential, so the cost of matching it outweighs the protection.
    /// </remarks>
    private const int MinimumEmbeddedValueLength = 4;

    /// <summary>Rewrites one line of parser diagnostics so no supplied value survives in it.</summary>
    /// <param name="message">The message as the parser produced it.</param>
    /// <param name="suppliedValues">The values this invocation supplied, from <see cref="SuppliedValues"/>.</param>
    /// <returns>The message with every quoted caller value replaced.</returns>
    /// <exception cref="ArgumentNullException">Any argument is null.</exception>
    public static string Redact(string message, IReadOnlyCollection<string> suppliedValues)
    {
        ArgumentNullException.ThrowIfNull(message);
        ArgumentNullException.ThrowIfNull(suppliedValues);

        if (suppliedValues.Count == 0)
        {
            return message;
        }

        var rewritten = new StringBuilder(message.Length);
        var index = 0;

        while (index < message.Length)
        {
            var open = message.IndexOf('\'', index);
            var close = open < 0 ? -1 : message.IndexOf('\'', open + 1);

            if (close < 0)
            {
                rewritten.Append(message, index, message.Length - index);

                break;
            }

            var span = message[(open + 1)..close];

            rewritten.Append(message, index, open + 1 - index);
            rewritten.Append(CarriesASuppliedValue(span, suppliedValues) ? RedactValue(span) : span);
            rewritten.Append('\'');

            index = close + 1;
        }

        return rewritten.ToString();
    }

    /// <summary>Collects the values this invocation supplied, excluding option and command names.</summary>
    /// <param name="parseResult">The parse result, successful or not.</param>
    /// <returns>Every token that could be a value rather than a name.</returns>
    /// <remarks>
    /// The unmatched tokens are gathered separately even though this parser version already
    /// reports them among <see cref="ParseResult.Tokens"/> — removing that second loop changes no
    /// observable behaviour today, and it is kept anyway. An unclaimed token is the one the parser
    /// echoes back verbatim and the one nothing else has had a chance to redact, so the cost of it
    /// being missing from this set is a leak, while the cost of gathering it twice is nothing. The
    /// set is a redaction allow-list, and a redaction allow-list is the wrong place to depend on
    /// one collection being a superset of another.
    /// </remarks>
    /// <exception cref="ArgumentNullException"><paramref name="parseResult"/> is null.</exception>
    internal static IReadOnlyCollection<string> SuppliedValues(ParseResult parseResult)
    {
        ArgumentNullException.ThrowIfNull(parseResult);

        var values = new HashSet<string>(StringComparer.Ordinal);

        foreach (var token in parseResult.Tokens)
        {
            Collect(token.Value);
        }

        foreach (var token in parseResult.UnmatchedTokens)
        {
            Collect(token);
        }

        return values;

        void Collect(string value)
        {
            if (!string.IsNullOrEmpty(value) && !IsOptionName(value))
            {
                values.Add(value);
            }
        }
    }

    /// <summary>Reduces a value to the most that can be shown of it without risking a secret.</summary>
    /// <param name="value">The value as supplied.</param>
    /// <returns>A redacted address for an http or https URL, and a bare marker for anything else.</returns>
    /// <remarks>
    /// An address gets the same treatment here as one that reached <see cref="EndpointGuard"/>
    /// through the option built for it, by calling the same routine rather than a parallel one.
    /// A caller who mistyped a URL into a numeric option is told which host they named, which is
    /// usually enough to see the mistake, and nothing more.
    /// </remarks>
    internal static string RedactValue(string value)
    {
        ArgumentNullException.ThrowIfNull(value);

        return
            Uri.TryCreate(value, UriKind.Absolute, out var uri)
            && (
                string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.Ordinal)
                || string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.Ordinal)
            )
            ? EndpointGuard.Redact(uri)
            : EndpointGuard.RedactionMarker;
    }

    /// <summary>Reports whether a token is an option or alias name rather than a value.</summary>
    /// <param name="value">The token as supplied.</param>
    /// <returns><see langword="true"/> when the token has the shape of a flag.</returns>
    /// <remarks>
    /// Shape is the only signal available. A mistyped flag is by definition not one of the
    /// parser's aliases, so it cannot be recognized by lookup — and naming it back to the caller
    /// is the entire value of the message that mentions it. The rule is kept narrow for that
    /// reason: a POSIX long form, or a single-character short form, and nothing else. A value that
    /// merely begins with a dash is still treated as a value.
    /// </remarks>
    internal static bool IsOptionName(string value)
    {
        ArgumentNullException.ThrowIfNull(value);

        var name =
            value.StartsWith("--", StringComparison.Ordinal) ? value[2..]
            : value.Length == 2 && value[0] == '-' ? value[1..]
            : null;

        return name is { Length: > 0 }
            && name.All(character => char.IsAsciiLetterOrDigit(character) || character == '-');
    }

    private static bool CarriesASuppliedValue(string span, IReadOnlyCollection<string> suppliedValues)
    {
        foreach (var value in suppliedValues)
        {
            if (string.Equals(span, value, StringComparison.Ordinal))
            {
                return true;
            }

            if (value.Length >= MinimumEmbeddedValueLength && span.Contains(value, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }
}
