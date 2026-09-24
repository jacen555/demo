using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Forge.EvalCli.Cli;

/// <summary>
/// Validates the address the suite is pointed at, and produces the only form of it that is ever
/// allowed to be printed, logged, or written into an artifact.
/// </summary>
/// <remarks>
/// <para>
/// An endpoint on a command line is where a credential most often leaks by accident. Userinfo
/// (<c>https://user:secret@host</c>) is refused outright rather than stripped, because a user who
/// put a credential there needs to know it did not work; silently dropping it would leave them
/// believing the tool authenticated. Everything after the host — path, query, and fragment — is
/// removed from the printable form, because a bearer token, a SAS signature, and an API key are
/// each at home in any of the three, and none of them can be told apart from an ordinary routing
/// segment by inspection.
/// </para>
/// <para>
/// The engine applies the same rule to whatever it is handed. Redacting here as well is not
/// redundant: it means no unredacted address exists anywhere in this tool's output path, so a
/// future log line or error message cannot reintroduce one by interpolating the wrong field.
/// </para>
/// </remarks>
internal static partial class EndpointGuard
{
    /// <summary>The placeholder left where a removed component was.</summary>
    internal const string RedactionMarker = "<redacted>";

    /// <summary>
    /// What to do instead of selecting a baseline deployment with a query string.
    /// </summary>
    /// <remarks>
    /// Stated once and used by every path that refuses one, so the argument-time refusal and the
    /// engine's own refusal give a reader the same instruction.
    /// </remarks>
    internal const string DeploymentSelectorRemedy =
        "A query and a fragment are stripped before an address is recorded, because that is where a bearer token "
        + "or a SAS signature lives — so '?deployment=old' and '?deployment=new' are the same text in the "
        + "artifact, and the harness cannot then tell whether the baseline it compared against was the one asked "
        + "for. Select the deployment by path instead, or from the composition root with a header.";

    /// <summary>Validates an endpoint and returns it alongside the form that is safe to display.</summary>
    /// <param name="value">The endpoint as supplied.</param>
    /// <param name="optionName">The option this value came from, for the error message.</param>
    /// <returns>
    /// The parsed address, for a later stage that has to dial it, and the redacted string that is
    /// the only form anything may print.
    /// </returns>
    /// <exception cref="EvalCliException">
    /// The value is blank, is not an absolute URI, does not use http or https, or carries
    /// credentials in its userinfo component.
    /// </exception>
    public static (Uri Endpoint, string Display) Validate(string value, string optionName)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                $"{optionName} was given a blank address.",
                $"Supply an absolute http or https URL, or omit {optionName}."
            );
        }

        if (!Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri))
        {
            // The raw value is deliberately not echoed: it is the one argument most likely to
            // carry a credential, and it has not been parsed yet, so it cannot be redacted.
            throw new EvalCliException(
                ExitCode.UsageError,
                $"{optionName} is not an absolute URL.",
                "Supply something like https://localhost:5001 — scheme included."
            );
        }

        if (
            !string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.Ordinal)
            && !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.Ordinal)
        )
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                $"{optionName} uses the '{uri.Scheme}' scheme, which this tool does not evaluate against.",
                "Supply an http or https URL."
            );
        }

        if (!string.IsNullOrEmpty(uri.UserInfo))
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                $"{optionName} carries credentials in the URL, which is refused.",
                "Remove the user:password part. Supply credentials through the environment instead, "
                    + "so they cannot reach a shell history, a process listing, or a committed artifact."
            );
        }

        return (uri, Redact(uri));
    }

    /// <summary>
    /// Validates an address a baseline will be resolved from, which is held to a stricter rule.
    /// </summary>
    /// <param name="value">The endpoint as supplied.</param>
    /// <param name="optionName">The option this value came from, for the error message.</param>
    /// <returns>The parsed address and the redacted form that is the only printable one.</returns>
    /// <remarks>
    /// <para>
    /// Everything <see cref="Validate"/> refuses, plus a query string and a fragment. The rule
    /// belongs to the engine — <c>LiveEndpointBaseline</c> refuses the same shapes, for the reason
    /// spelled out in <see cref="DeploymentSelectorRemedy"/> — and this is not a second reading of
    /// it. It is the same refusal made at argument time, where it costs nothing, carries the
    /// remedy, and earns a usage exit code instead of surfacing as an unhandled engine failure.
    /// </para>
    /// <para>
    /// The consequence is worth stating plainly: a deployment selected by query string cannot be
    /// used as a baseline here at all. That is the deliberate trade — an address whose identity
    /// cannot survive redaction cannot be verified, and an unverifiable baseline is the one that
    /// silently compares the wrong pair.
    /// </para>
    /// </remarks>
    /// <exception cref="EvalCliException">
    /// The value is refused by <see cref="Validate"/>, or carries a query or a fragment.
    /// </exception>
    public static (Uri Endpoint, string Display) ValidateBaselineReference(string value, string optionName)
    {
        var (uri, display) = Validate(value, optionName);

        if (!string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment))
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                $"{optionName} carries a query string or a fragment, which a baseline address may not.",
                DeploymentSelectorRemedy
            );
        }

        return (uri, display);
    }

    /// <summary>
    /// Rewrites every address in a message composed somewhere that does not know this rule.
    /// </summary>
    /// <param name="message">Text composed elsewhere, which may quote an address.</param>
    /// <returns>The message with every http or https address reduced to its printable form.</returns>
    /// <remarks>
    /// <para>
    /// <b>This exists because the engine's refusals name the address they were checking.</b> They
    /// are right to — a caller has to know which address could not be confirmed — but the engine
    /// keeps the path, and the path is where a token is as much at home as in a query string. A
    /// message forwarded verbatim from there to standard error carries it out of the process.
    /// </para>
    /// <para>
    /// Applied at the boundary rather than at each interpolation, for the same reason
    /// <see cref="ArgumentRedactor"/> is: a rule applied where a value is understood protects
    /// nothing composed by code that never heard of it, and the set of such code grows.
    /// </para>
    /// </remarks>
    /// <exception cref="ArgumentNullException"><paramref name="message"/> is null.</exception>
    internal static string RedactAddresses(string message)
    {
        ArgumentNullException.ThrowIfNull(message);

        return Addresses()
            .Replace(
                message,
                match =>
                {
                    // Sentence punctuation sits inside the match because a path may legitimately
                    // contain any of it. Trimmed from the tail so a redacted address does not
                    // swallow the full stop after it.
                    var address = match.Value.TrimEnd('.', ',', ';', ':', ')', ']');
                    var trailing = match.Value[address.Length..];

                    return (Uri.TryCreate(address, UriKind.Absolute, out var uri) ? Redact(uri) : RedactionMarker)
                        + trailing;
                }
            );
    }

    /// <summary>Matches an absolute http or https address inside composed text.</summary>
    /// <remarks>
    /// Stops at whitespace and at the characters that quote a value in the messages this tool
    /// forwards, so a quoted address is rewritten and its quotes are left where they were.
    /// </remarks>
    [GeneratedRegex("https?://[^\\s'\"<>]+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Addresses();

    /// <summary>Removes every component of an address that could carry a secret.</summary>
    /// <param name="uri">The parsed address.</param>
    /// <returns>Scheme, host, and non-default port, with a marker where anything was removed.</returns>
    /// <remarks>
    /// <para>
    /// <b>The path goes too.</b> A path segment carries a credential as readily as a query
    /// parameter does — <c>https://host/api/sk-live-abc123/run</c> is an entirely ordinary shape —
    /// and nothing here can tell a routing segment from a key by looking at it. Since the
    /// distinction is not decidable, the component is not printed.
    /// </para>
    /// <para>
    /// What survives is what identifies the environment: scheme, host, and a port that is not the
    /// scheme's default. That is enough for a reader to confirm they are pointed at staging rather
    /// than production, which is the only question this string exists to answer. A marker is left
    /// wherever something was removed, so a reader can tell "no path" from "a path you may not
    /// see".
    /// </para>
    /// </remarks>
    internal static string Redact(Uri uri)
    {
        ArgumentNullException.ThrowIfNull(uri);

        var builder = new StringBuilder();

        builder.Append(uri.Scheme).Append("://");

        if (!string.IsNullOrEmpty(uri.UserInfo))
        {
            builder.Append(RedactionMarker).Append('@');
        }

        builder.Append(uri.Host);

        if (!uri.IsDefaultPort)
        {
            builder.Append(':').Append(uri.Port.ToString(CultureInfo.InvariantCulture));
        }

        if (uri.AbsolutePath.Length > 1)
        {
            builder.Append('/').Append(RedactionMarker);
        }

        if (uri.Query.Length > 1)
        {
            builder.Append('?').Append(RedactionMarker);
        }

        if (uri.Fragment.Length > 1)
        {
            builder.Append('#').Append(RedactionMarker);
        }

        return builder.ToString();
    }
}
