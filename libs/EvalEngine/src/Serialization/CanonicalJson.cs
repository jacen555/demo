using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Forge.EvalEngine.Results;

namespace Forge.EvalEngine.Serialization;

/// <summary>
/// Canonical JSON for the engine's durable artifacts.
/// </summary>
/// <remarks>
/// <para>
/// A suite result is committed and diffed, so its text has to be a function of its value and
/// nothing else. This class guarantees that by rewriting the serialized document so that
/// <b>object keys are ordered by ordinal comparison at every level</b> before it is written.
/// Array order is meaningful and is preserved.
/// </para>
/// <para>
/// One rule, no exceptions — <c>schemaVersion</c> sorts where the alphabet puts it. A special
/// case would be another thing to remember and another way for two writers to disagree.
/// </para>
/// <para>Also fixed here, for the same reason:</para>
/// <list type="bullet">
///   <item><description>Unset optional values are written as <b>absent</b>, never as nulls.</description></item>
///   <item><description>Enums are written as camel-case strings, and <b>integer input is refused</b> — an ordinal from a suite file is not a way into a closed set.</description></item>
///   <item><description>A null assigned to a non-nullable member is refused rather than bound, so a required sub-record cannot arrive null.</description></item>
///   <item><description>Line endings are <c>\n</c> regardless of platform.</description></item>
/// </list>
/// <para>
/// The default HTML-safe encoder is kept deliberately, which is why characters such as <c>+</c>
/// appear escaped (<c>\u002B</c>) in timestamps. Relaxing it would read better, but this artifact
/// carries responses from the system under test verbatim, and a reporter that embeds it in HTML
/// would then be one naive interpolation away from injecting them. The escaping is stable, so it
/// costs nothing in a diff.
/// </para>
/// </remarks>
public static class CanonicalJson
{
    internal static JsonSerializerOptions Options { get; } = CreateOptions();

    /// <summary>Serializes a value to canonical JSON.</summary>
    /// <typeparam name="T">The type being serialized.</typeparam>
    /// <param name="value">The value.</param>
    /// <returns>Canonical JSON text, with keys ordered and <c>\n</c> line endings.</returns>
    /// <exception cref="JsonException">The value could not be serialized.</exception>
    public static string Serialize<T>(T value)
    {
        var node = JsonSerializer.SerializeToNode(value, Options);

        return Canonicalize(node)?.ToJsonString(Options) ?? "null";
    }

    /// <summary>Deserializes a value from JSON.</summary>
    /// <typeparam name="T">The type to deserialize.</typeparam>
    /// <param name="json">The JSON text. Key order is irrelevant on the way in.</param>
    /// <returns>The deserialized value.</returns>
    /// <remarks>
    /// A <see cref="SuiteResult"/> is read through the same version guard as
    /// <see cref="DeserializeSuiteResult(string)"/>. It is a durable artifact whichever entry
    /// point reads it, and a guard one call away from being bypassed is not a guard.
    /// </remarks>
    /// <exception cref="ArgumentNullException"><paramref name="json"/> is null.</exception>
    /// <exception cref="JsonException">The JSON was malformed or did not match the shape.</exception>
    /// <exception cref="SchemaVersionException">
    /// <typeparamref name="T"/> is <see cref="SuiteResult"/> and the artifact declares a schema
    /// version this engine cannot read, or declares none.
    /// </exception>
    public static T? Deserialize<T>(string json)
    {
        ArgumentNullException.ThrowIfNull(json);

        return typeof(T) == typeof(SuiteResult) ? (T)(object)DeserializeSuiteResult(json) : Bind<T>(json);
    }

    /// <summary>
    /// Reads a durable suite result, refusing any schema version this engine does not understand.
    /// </summary>
    /// <param name="json">The artifact text.</param>
    /// <returns>The artifact.</returns>
    /// <remarks>
    /// Prefer this over <see cref="Deserialize{T}(string)"/> for anything read back from disk or
    /// from a baseline reference: it says at the call site that a durable artifact is being read.
    /// Both carry the version check. An artifact outlives the code that wrote it, and a reader
    /// that binds a future shape to today's types produces a confident wrong answer rather than
    /// an error — the version is stamped on write rather than bound, so the evidence that the
    /// shape was unsupported is gone the moment it is read without checking.
    /// </remarks>
    /// <exception cref="ArgumentNullException"><paramref name="json"/> is null.</exception>
    /// <exception cref="JsonException">The JSON was malformed or did not match the shape.</exception>
    /// <exception cref="SchemaVersionException">
    /// The artifact declares a schema version this engine cannot read, or declares none.
    /// </exception>
    public static SuiteResult DeserializeSuiteResult(string json)
    {
        ArgumentNullException.ThrowIfNull(json);

        if (JsonNode.Parse(json) is not JsonObject root)
        {
            throw new JsonException("A suite result must be a JSON object.");
        }

        var declared =
            root["schemaVersion"] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

        if (!SchemaVersions.IsSuiteResultSupported(declared))
        {
            throw new SchemaVersionException(
                $"This artifact declares schema version '{declared ?? "(none)"}', which this engine cannot read. "
                    + $"It reads version '{SchemaVersions.SuiteResult}'."
            )
            {
                DeclaredVersion = declared,
                SupportedVersion = SchemaVersions.SuiteResult,
            };
        }

        return Bind<SuiteResult>(json) ?? throw new JsonException("A suite result must not be the literal null.");
    }

    private static T? Bind<T>(string json) => JsonSerializer.Deserialize<T>(json, Options);

    /// <summary>
    /// Determines whether two values have the same canonical form.
    /// </summary>
    /// <typeparam name="T">The type being compared.</typeparam>
    /// <param name="left">The first value, or null.</param>
    /// <param name="right">The second value, or null.</param>
    /// <returns><see langword="true"/> when both serialize to identical canonical JSON.</returns>
    /// <remarks>
    /// This is value equality for the engine's types. Several of them hold collections, and a
    /// record's compiler-generated equality compares those by <i>reference</i> — so two artifacts
    /// built from identical data would otherwise compare unequal. Comparing canonical text is the
    /// same notion of "the same" that a committed diff uses, which is the notion a comparator
    /// wants.
    /// </remarks>
    /// <exception cref="JsonException">A value could not be serialized.</exception>
    public static bool AreEquivalent<T>(T? left, T? right)
    {
        if (left is null || right is null)
        {
            return left is null && right is null;
        }

        return string.Equals(Serialize(left), Serialize(right), StringComparison.Ordinal);
    }

    private static JsonSerializerOptions CreateOptions()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            WriteIndented = true,
            NewLine = "\n",
            RespectNullableAnnotations = true,
        };

        options.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase, allowIntegerValues: false));
        options.MakeReadOnly(populateMissingResolver: true);
        return options;
    }

    private static JsonNode? Canonicalize(JsonNode? node)
    {
        switch (node)
        {
            case JsonObject source:
                var ordered = new JsonObject();
                foreach (var member in source.OrderBy(m => m.Key, StringComparer.Ordinal))
                {
                    ordered[member.Key] = Canonicalize(member.Value);
                }

                return ordered;

            case JsonArray source:
                var items = new JsonArray();
                foreach (var item in source)
                {
                    items.Add(Canonicalize(item));
                }

                return items;

            default:
                return node?.DeepClone();
        }
    }
}
