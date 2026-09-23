using System.Globalization;

namespace Forge.EvalEngine.Serialization;

/// <summary>
/// The schema versions stamped into durable artifacts, and the rule for reading them.
/// </summary>
/// <remarks>
/// <para>
/// Bump a version when a change to the corresponding shape would make an older artifact
/// misleading to a reader that assumes the new shape. Adding an optional field that serializes as
/// absent does not require a bump.
/// </para>
/// <para>
/// Support follows from that policy: a reader accepts the <b>same major</b> at a <b>minor at or
/// below</b> its own. A different major is a shape it does not understand; a higher minor was
/// written by a newer engine and may carry fields this reader would silently drop, which for an
/// artifact that exists to be diffed is worse than refusing.
/// </para>
/// </remarks>
public static class SchemaVersions
{
    /// <summary>The current version of the suite <i>input</i> schema.</summary>
    public const string Suite = "1.0";

    /// <summary>The current version of the suite <i>result</i> artifact schema.</summary>
    public const string SuiteResult = "1.0";

    /// <summary>Determines whether a declared suite schema version can be read.</summary>
    /// <param name="declaredVersion">The version declared by the document, if any.</param>
    /// <returns><see langword="true"/> when this engine understands that shape.</returns>
    public static bool IsSuiteSupported(string? declaredVersion) => IsSupported(Suite, declaredVersion);

    /// <summary>Determines whether a declared result schema version can be read.</summary>
    /// <param name="declaredVersion">The version declared by the artifact, if any.</param>
    /// <returns><see langword="true"/> when this engine understands that shape.</returns>
    public static bool IsSuiteResultSupported(string? declaredVersion) => IsSupported(SuiteResult, declaredVersion);

    private static bool IsSupported(string supported, string? declared) =>
        TryParse(declared, out var declaredMajor, out var declaredMinor)
        && TryParse(supported, out var major, out var minor)
        && declaredMajor == major
        && declaredMinor <= minor;

    private static bool TryParse(string? version, out int major, out int minor)
    {
        major = 0;
        minor = 0;

        if (string.IsNullOrWhiteSpace(version))
        {
            return false;
        }

        var parts = version.Split('.');

        return parts.Length == 2 && TryParseComponent(parts[0], out major) && TryParseComponent(parts[1], out minor);
    }

    private static bool TryParseComponent(string text, out int value) =>
        int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out value);
}

/// <summary>
/// Thrown when an artifact declares a schema version this engine cannot read.
/// </summary>
public sealed class SchemaVersionException : Exception
{
    /// <summary>Initializes a new instance.</summary>
    public SchemaVersionException() { }

    /// <summary>Initializes a new instance with a message.</summary>
    /// <param name="message">The caller-facing explanation.</param>
    public SchemaVersionException(string message)
        : base(message) { }

    /// <summary>Initializes a new instance with a message and an inner exception.</summary>
    /// <param name="message">The caller-facing explanation.</param>
    /// <param name="innerException">The underlying failure.</param>
    public SchemaVersionException(string message, Exception innerException)
        : base(message, innerException) { }

    /// <summary>Gets the version the artifact declared, or null when it declared none.</summary>
    public string? DeclaredVersion { get; init; }

    /// <summary>Gets the version this engine writes and reads.</summary>
    public string? SupportedVersion { get; init; }
}
