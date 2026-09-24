using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Forge.EvalEngine.Paths;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Serialization;

namespace Forge.EvalEngine.Loading;

/// <summary>
/// Loads and validates a suite file from a confined root directory.
/// </summary>
/// <remarks>
/// <para>
/// The suite path is untrusted input. A path that is outside <see cref="SuiteLoader.RootDirectory"/>
/// as written is refused on the text alone, before the file system is touched at all; one that is
/// not is then resolved to the location the file system will actually read from — following
/// symbolic links and junctions, not just normalizing text — and checked again. A traversal such
/// as <c>../../secrets.json</c> and a junction inside the root pointing out of it are both
/// refused, and neither check would catch the other's case.
/// </para>
/// <para>
/// That same pair of checks applies at every link met along the way, because a link is a path the
/// suite author chose and following one re-enters resolution with it. A link inside the root that
/// points out of the root is refused before its target is read, not after.
/// </para>
/// <para>
/// Scenarios are deserialized one at a time so that a finding always names the scenario that
/// caused it, rather than handing the suite author a JSON path to decode. Content problems are
/// returned rather than thrown, so every finding can be reported at once.
/// </para>
/// </remarks>
public sealed class SuiteLoader
{
    private readonly PathBoundary _root;

    /// <summary>Initializes a new instance confined to <paramref name="rootDirectory"/>.</summary>
    /// <param name="rootDirectory">
    /// The only directory tree suites may be loaded from. It is canonicalized on construction.
    /// </param>
    /// <exception cref="ArgumentException"><paramref name="rootDirectory"/> is empty or whitespace.</exception>
    /// <exception cref="ArgumentNullException"><paramref name="rootDirectory"/> is null.</exception>
    /// <exception cref="IOException">
    /// The root contains a cycle of links, or a segment of it could not be inspected, so it
    /// cannot be resolved to a real path.
    /// </exception>
    public SuiteLoader(string rootDirectory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(rootDirectory);

        _root = new PathBoundary(rootDirectory);
    }

    /// <summary>Gets the canonical root directory suites are confined to.</summary>
    public string RootDirectory => _root.Root;

    /// <summary>Loads and validates a suite file.</summary>
    /// <param name="suitePath">
    /// The suite path, relative to <see cref="RootDirectory"/> or absolute within it.
    /// </param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The loaded suite, or the findings that prevented it.</returns>
    /// <exception cref="ArgumentException">
    /// <paramref name="suitePath"/> is empty, or resolves outside <see cref="RootDirectory"/>.
    /// </exception>
    /// <exception cref="ArgumentNullException"><paramref name="suitePath"/> is null.</exception>
    /// <exception cref="OperationCanceledException">The token was cancelled.</exception>
    public async Task<SuiteLoadResult> LoadAsync(string suitePath, CancellationToken cancellationToken = default)
    {
        var resolved = ResolveWithinRoot(suitePath);

        string json;
        try
        {
            json = await File.ReadAllTextAsync(resolved, cancellationToken).ConfigureAwait(false);
        }
        catch (FileNotFoundException)
        {
            return Failed("suite.notFound", $"Suite file '{suitePath}' was not found under the suite root.");
        }
        catch (DirectoryNotFoundException)
        {
            return Failed("suite.notFound", $"Suite file '{suitePath}' was not found under the suite root.");
        }
        catch (IOException)
        {
            return Failed("suite.unreadable", $"Suite file '{suitePath}' could not be read.");
        }
        catch (UnauthorizedAccessException)
        {
            return Failed("suite.unreadable", $"Suite file '{suitePath}' could not be read: access was denied.");
        }

        return LoadFromJson(json, suitePath);
    }

    /// <summary>Validates suite content that has already been read.</summary>
    /// <param name="json">The suite document.</param>
    /// <param name="sourceName">A label for the source, used in findings.</param>
    /// <returns>The loaded suite, or the findings that prevented it.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="json"/> is null.</exception>
    public static SuiteLoadResult LoadFromJson(string json, string sourceName)
    {
        ArgumentNullException.ThrowIfNull(json);

        JsonObject document;
        try
        {
            if (JsonNode.Parse(json) is not JsonObject parsed)
            {
                return Failed("suite.malformed", $"Suite '{sourceName}' must be a JSON object.");
            }

            // A JsonObject builds its key index lazily, so a duplicate key does not surface at
            // parse time — it surfaces as an ArgumentException from whatever first indexes into
            // the object. Forcing it here keeps that a finding rather than a throw escaping a
            // method documented to return its problems.
            _ = parsed.Count;
            document = parsed;
        }
        catch (JsonException)
        {
            return Failed("suite.malformed", $"Suite '{sourceName}' is not valid JSON.");
        }
        catch (ArgumentException exception)
        {
            return Failed("suite.malformed", $"Suite '{sourceName}' is not valid JSON: {exception.Message}");
        }

        var messages = new List<ValidationMessage>();
        var name = ReadString(document["name"]);

        if (string.IsNullOrWhiteSpace(name))
        {
            messages.Add(
                SuiteValidator.Error(
                    "suite.name.missing",
                    null,
                    $"Suite '{sourceName}' does not declare a name. The name labels the resulting artifact."
                )
            );
            name = sourceName;
        }

        var schemaVersion = ValidateSchemaVersion(document, sourceName, messages);
        var scenarios = ReadScenarios(document["scenarios"], sourceName, messages);
        messages.AddRange(SuiteValidator.Validate(scenarios));

        return new SuiteLoadResult
        {
            Suite = new Suite
            {
                SchemaVersion = schemaVersion,
                Name = name,
                Scenarios = scenarios,
            },
            Messages = messages,
        };
    }

    private static string ValidateSchemaVersion(
        JsonObject document,
        string sourceName,
        List<ValidationMessage> messages
    )
    {
        if (!document.ContainsKey("schemaVersion"))
        {
            messages.Add(
                SuiteValidator.Warning(
                    "suite.schemaVersion.missing",
                    null,
                    $"Suite '{sourceName}' declares no schemaVersion, so it is being read as "
                        + $"'{SchemaVersions.Suite}'. Declare it so a future reader does not have to guess."
                )
            );
            return SchemaVersions.Suite;
        }

        var declared = ReadString(document["schemaVersion"]);

        if (!SchemaVersions.IsSuiteSupported(declared))
        {
            messages.Add(
                SuiteValidator.Error(
                    "suite.schemaVersion.unsupported",
                    null,
                    $"Suite '{sourceName}' declares schemaVersion '{declared ?? "(null)"}', which this engine "
                        + $"cannot read. It reads version '{SchemaVersions.Suite}'."
                )
            );
        }

        return declared ?? SchemaVersions.Suite;
    }

    private static List<Scenario> ReadScenarios(JsonNode? node, string sourceName, List<ValidationMessage> messages)
    {
        var scenarios = new List<Scenario>();

        if (node is not JsonArray entries)
        {
            messages.Add(
                SuiteValidator.Error(
                    "suite.scenarios.missing",
                    null,
                    $"Suite '{sourceName}' does not declare a 'scenarios' array."
                )
            );
            return scenarios;
        }

        if (entries.Count == 0)
        {
            messages.Add(
                SuiteValidator.Warning(
                    "suite.scenarios.empty",
                    null,
                    $"Suite '{sourceName}' declares no scenarios, so a run against it would prove nothing."
                )
            );
        }

        for (var index = 0; index < entries.Count; index++)
        {
            var position = "#" + (index + 1).ToString(CultureInfo.InvariantCulture);

            // The entry is untrusted input, so its shape is established before anything indexes
            // into it. Reading an identity out of a scalar throws, and a throw here would lose
            // every other finding in the suite.
            if (entries[index] is not JsonObject entry)
            {
                messages.Add(Unreadable(position, null, "a scenario must be a JSON object."));
                continue;
            }

            var declaredId = default(string?);
            var label = position;

            try
            {
                // Same lazy-index hazard as at the suite level, and the identity read below is
                // what would trigger it.
                _ = entry.Count;

                declaredId = entry["identity"] is JsonObject identity ? ReadString(identity["id"]) : null;
                label = string.IsNullOrWhiteSpace(declaredId) ? position : declaredId;

                var scenario =
                    entry.Deserialize<Scenario>(CanonicalJson.Options) ?? throw new JsonException("the entry is null.");
                scenarios.Add(scenario);
            }
            catch (JsonException exception)
            {
                messages.Add(Unreadable(label, declaredId, exception.Message));
            }
            catch (ArgumentException exception)
            {
                messages.Add(Unreadable(label, declaredId, exception.Message));
            }
            catch (NotSupportedException exception)
            {
                messages.Add(Unreadable(label, declaredId, exception.Message));
            }
        }

        return scenarios;
    }

    private static ValidationMessage Unreadable(string label, string? scenarioId, string reason) =>
        SuiteValidator.Error("scenario.malformed", scenarioId, $"scenario {label} could not be read: {reason}");

    private static SuiteLoadResult Failed(string code, string message) =>
        new() { Messages = [SuiteValidator.Error(code, null, message)] };

    private static string? ReadString(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    /// <summary>
    /// Canonicalizes a caller-supplied path and refuses anything that escapes the root.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The containment rules themselves — refuse on the text before any I/O, apply the boundary to
    /// every link target while it is still text, check the resolved path again, and fail closed on
    /// a segment that cannot be inspected — belong to <see cref="PathBoundary"/> and are documented
    /// there. They are stated once, in one place, because a containment rule implemented twice is
    /// one that will eventually disagree with itself.
    /// </para>
    /// <para>
    /// What is left here is the suite vocabulary. Every way out of the root is the same answer to a
    /// suite author, so all of them become one <see cref="ArgumentException"/> naming the suite
    /// path — and it carries no cause, because nothing failed: the loader declined to look. A path
    /// whose containment could not be <i>established</i> is the different answer, and keeps the
    /// underlying failure as its cause.
    /// </para>
    /// </remarks>
    private string ResolveWithinRoot(string suitePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(suitePath);

        try
        {
            return _root.Resolve(suitePath);
        }
        catch (PathEscapesBoundaryException)
        {
            throw OutsideRoot(suitePath);
        }
        catch (IOException exception)
        {
            throw new ArgumentException(
                $"Suite path '{suitePath}' could not be resolved safely and was refused.",
                nameof(suitePath),
                exception
            );
        }
    }

    private static ArgumentException OutsideRoot(string suitePath) =>
        new($"Suite path '{suitePath}' resolves outside the suite root and was refused.", nameof(suitePath));
}
