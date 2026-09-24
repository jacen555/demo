using System.Globalization;
using System.Text;

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
internal static class EndpointGuard
{
    /// <summary>The placeholder left where a removed component was.</summary>
    internal const string RedactionMarker = "<redacted>";

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
