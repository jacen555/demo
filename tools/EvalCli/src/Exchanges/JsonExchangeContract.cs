using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Forge.EvalEngine.Runners;

namespace Forge.EvalCli.Exchanges;

/// <summary>
/// The one JSON contract this tool's built-in exchanges speak, in both directions.
/// </summary>
/// <remarks>
/// <para>
/// <b>The engine ships no exchange on purpose, and that reasoning does not transfer here.</b> A
/// library cannot know the request shape or the response shape of a system it has never seen, so
/// any default it shipped would be one system's JSON frozen into a generic engine. A composition
/// root is the opposite case: it exists precisely to make that decision for one invocation, and
/// this is where it is made and where it can be read.
/// </para>
/// <para>
/// <b>It is still opt-in.</b> <c>--rest-exchange json</c> and <c>--llm-exchange json</c> have to
/// be asked for; without them no runner is registered for that kind and the engine records the
/// gap as a harness failure. An exchange that was on by default would mean every suite pointed at
/// a system with a different shape produced malformed-response findings that look like findings
/// <i>about the system</i>, when they are really findings about an assumption nobody made
/// deliberately. Naming it on the command line is what keeps the assumption auditable.
/// </para>
/// <para>
/// <b>Request.</b> <c>POST</c> to <c>--endpoint</c>, <c>Content-Type: application/json</c>:
/// </para>
/// <code>
/// { "input": "...", "scenarioId": "...", "turn": 1, "repetition": 1, "seed": 0 }
/// </code>
/// <para>
/// <b>Response.</b> A JSON object. <c>output</c> is required and must be a string;
/// <c>outcome</c> and <c>path</c> are optional strings; every other top-level scalar is exposed
/// to structural and presence assertions as a field keyed by its property name:
/// </para>
/// <code>
/// { "output": "...", "outcome": "refund.approved", "path": "verify/refund" }
/// </code>
/// <para>
/// Anything else is reported as a <see cref="MalformedResponseException"/>, which the engine
/// records as a finding about the system under test rather than as a harness fault — so a suite
/// can assert on it, and a mismatched contract shows up as a named malformed response rather than
/// as a pass.
/// </para>
/// </remarks>
internal static class JsonExchangeContract
{
    /// <summary>The name this contract is selected by on the command line.</summary>
    public const string Name = "json";

    /// <summary>The media type sent and expected.</summary>
    public const string MediaType = "application/json";

    private static readonly JsonSerializerOptions WriteOptions = new() { WriteIndented = false };

    /// <summary>Builds the request body for one stimulus.</summary>
    /// <param name="scenarioId">The scenario the stimulus belongs to.</param>
    /// <param name="text">The stimulus text.</param>
    /// <param name="turnIndex">The one-based turn index.</param>
    /// <param name="repetition">The one-based repetition number.</param>
    /// <param name="seed">The seed this run was driven with.</param>
    /// <returns>The body, ready to send.</returns>
    public static StringContent CreateBody(string scenarioId, string text, int turnIndex, int repetition, long seed)
    {
        var body = new JsonObject
        {
            ["input"] = text,
            ["scenarioId"] = scenarioId,
            ["turn"] = turnIndex,
            ["repetition"] = repetition,
            ["seed"] = seed,
        };

        return new StringContent(body.ToJsonString(WriteOptions), Encoding.UTF8, MediaType);
    }

    /// <summary>Reads a response body into the engine's vocabulary.</summary>
    /// <param name="body">The body exactly as it came back.</param>
    /// <returns>What the system said, in the shared form.</returns>
    /// <remarks>
    /// <b>No fragment of the body reaches the exception message.</b> A malformed-response message
    /// travels into a committed artifact whenever a caller opts into unredacted evidence, and a
    /// body that was not understood is exactly the one that has not been through any redaction —
    /// an error page carrying a session token looks no different from a valid reply here (§V). The
    /// message names the shape that was expected instead.
    /// </remarks>
    /// <exception cref="MalformedResponseException">The body is not a response in this contract.</exception>
    public static ExchangeReading Read(string body)
    {
        ArgumentNullException.ThrowIfNull(body);

        JsonObject document;

        try
        {
            if (JsonNode.Parse(body) is not JsonObject parsed)
            {
                throw new MalformedResponseException(
                    "the response body is valid JSON but not a JSON object, and this contract expects an object "
                        + "carrying at least an 'output' string."
                );
            }

            // A JsonObject indexes lazily, so a duplicate key surfaces from whatever first reads
            // the object rather than from the parse. Forced here so it is reported as a malformed
            // response instead of escaping as an ArgumentException.
            _ = parsed.Count;
            document = parsed;
        }
        catch (JsonException)
        {
            throw new MalformedResponseException("the response body is not valid JSON.");
        }
        catch (ArgumentException)
        {
            throw new MalformedResponseException("the response body declares the same property more than once.");
        }

        if (!document.TryGetPropertyValue("output", out var output) || !TryReadString(output, out var text))
        {
            throw new MalformedResponseException(
                "the response body carries no 'output' string. This contract reads the system's reply from that "
                    + "property; a body without one says nothing that could be graded."
            );
        }

        return new ExchangeReading
        {
            Text = text,
            ObservedOutcome = ReadOptional(document, "outcome"),
            ObservedPath = ReadOptional(document, "path"),
            Fields = ReadFields(document),
        };
    }

    private static string? ReadOptional(JsonObject document, string property) =>
        document.TryGetPropertyValue(property, out var node)
        && TryReadString(node, out var text)
        && !string.IsNullOrWhiteSpace(text)
            ? text
            : null;

    private static bool TryReadString(JsonNode? node, out string? text)
    {
        if (node is JsonValue value && value.TryGetValue<string>(out var read))
        {
            text = read;
            return true;
        }

        text = null;
        return false;
    }

    /// <summary>Exposes the top-level scalars so structural and presence assertions have something to read.</summary>
    /// <remarks>
    /// Scalars only, keyed by property name. Nested objects and arrays are left out rather than
    /// flattened under a path syntax this contract would then have to define and a suite author
    /// would have to guess at.
    /// </remarks>
    private static Dictionary<string, string?> ReadFields(JsonObject document)
    {
        var fields = new Dictionary<string, string?>(StringComparer.Ordinal);

        foreach (var (name, node) in document)
        {
            fields[name] = node switch
            {
                null => null,
                JsonValue value when value.TryGetValue<string>(out var text) => text,
                JsonValue value => value.ToJsonString(WriteOptions),
                _ => null,
            };
        }

        return fields;
    }
}

/// <summary>What one reading of a response body produced, before it is shaped for a runner.</summary>
/// <remarks>
/// A single record so the REST and conversational exchanges read a body through one
/// implementation and cannot drift into two contracts that share a name.
/// </remarks>
internal sealed record ExchangeReading
{
    /// <summary>Gets the system's reply.</summary>
    public required string? Text { get; init; }

    /// <summary>Gets the terminal outcome the system named, or null.</summary>
    public string? ObservedOutcome { get; init; }

    /// <summary>Gets the route the system reported taking, or null.</summary>
    public string? ObservedPath { get; init; }

    /// <summary>Gets the top-level scalar fields, keyed by property name.</summary>
    public IReadOnlyDictionary<string, string?> Fields { get; init; } =
        new Dictionary<string, string?>(StringComparer.Ordinal);

    /// <summary>Gets the transport detail an adapter learned, keyed by attribute name.</summary>
    public IReadOnlyDictionary<string, string> Attributes { get; init; } =
        new Dictionary<string, string>(StringComparer.Ordinal);
}
