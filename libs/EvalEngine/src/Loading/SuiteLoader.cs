using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
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
    private readonly string _rootDirectory;

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

        _rootDirectory = RealPath.Resolve(Path.TrimEndingDirectorySeparator(Path.GetFullPath(rootDirectory)));
    }

    /// <summary>Gets the canonical root directory suites are confined to.</summary>
    public string RootDirectory => _rootDirectory;

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
    /// Containment is checked twice at the entry point, and neither check covers the other. The
    /// first is on the text, <i>before</i> the file system is touched: inspecting a path for links
    /// reads it, and reading a path the caller chose is an action taken on their behalf — a UNC
    /// path makes it an outbound request to a host they named. A path that is already outside the
    /// root as written is never a reason to do that, so it is refused on the text alone.
    /// </para>
    /// <para>
    /// The second is on the <i>real</i> path — the one reparse points actually resolve to. A
    /// lexical check answers "does this string start with the root", which a symlink or junction
    /// sitting inside the root satisfies while pointing anywhere on the volume. A path that
    /// cannot be resolved at all is refused rather than read.
    /// </para>
    /// <para>
    /// Following a link re-enters this same resolution with a path the link chose, so the first
    /// check has to hold there too: the target is measured against the root while it is still
    /// text, before anything inspects it. Leaving it to the second check would refuse the suite
    /// just as surely, but only after walking the target — and walking a target on another host
    /// is an outbound request to whichever host was named. Write access to the suite root is not
    /// authority to make the loader issue that request.
    /// </para>
    /// </remarks>
    private string ResolveWithinRoot(string suitePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(suitePath);

        var lexical = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.Combine(_rootDirectory, suitePath)));

        if (!IsContained(lexical))
        {
            throw OutsideRoot(suitePath);
        }

        string resolved;
        try
        {
            resolved = RealPath.Resolve(lexical, isTargetPermitted: IsContained);
        }
        catch (LinkLeavesBoundaryException)
        {
            // The same answer as a path that reads outside the root, reached the same way: from
            // the text, before the target was touched. There is no cause to report because
            // nothing failed — the loader declined to look.
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

        return IsContained(resolved) ? resolved : throw OutsideRoot(suitePath);
    }

    private static ArgumentException OutsideRoot(string suitePath) =>
        new($"Suite path '{suitePath}' resolves outside the suite root and was refused.", nameof(suitePath));

    private bool IsContained(string candidate)
    {
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

        return candidate.Equals(_rootDirectory, comparison)
            || candidate.StartsWith(_rootDirectory + Path.DirectorySeparatorChar, comparison);
    }
}

/// <summary>
/// Resolves a path to the location the file system will actually read from, following symbolic
/// links and junctions at every level of the path rather than only at its last segment.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="Path.GetFullPath(string)"/> is purely lexical: it normalizes <c>..</c> and casing
/// and stops there. Containment built on it alone is a text comparison, and a reparse point is
/// exactly the case where the text and the bytes disagree.
/// </para>
/// <para>
/// This type knows nothing about suites or roots. The boundary it must not resolve past is handed
/// to it, because following a link is an action taken on a path the link chose and only the caller
/// can say which paths it is willing to have read on its behalf.
/// </para>
/// </remarks>
internal static class RealPath
{
    private const int MaxLinkHops = 40;

    /// <summary>Resolves every reparse point along a path.</summary>
    /// <param name="path">The path to resolve. It need not exist.</param>
    /// <param name="isTargetPermitted">
    /// The boundary resolution is confined to, asked about each link target <i>before</i> that
    /// target is inspected. A rejected target stops resolution rather than being walked. Omitting
    /// it resolves without a boundary, which is only appropriate for a path the caller chose
    /// itself rather than one it was handed.
    /// </param>
    /// <returns>
    /// The real path. A segment that does not exist cannot be a link, so it is kept as written.
    /// </returns>
    /// <exception cref="LinkLeavesBoundaryException">
    /// A link points outside <paramref name="isTargetPermitted"/>. Raised before its target is
    /// touched.
    /// </exception>
    /// <exception cref="IOException">
    /// The path exceeds the maximum link depth, or a segment could not be inspected — in which
    /// case whether it leaves the root is unknowable and it is refused rather than assumed safe.
    /// </exception>
    public static string Resolve(string path, Func<string, bool>? isTargetPermitted = null)
    {
        var pending = Split(Path.GetFullPath(path), out var resolved);
        var hops = 0;

        while (pending.Count > 0)
        {
            var candidate = Path.Combine(resolved, pending.Dequeue());

            if (LinkTarget(candidate) is not string target)
            {
                resolved = candidate;
                continue;
            }

            if (++hops > MaxLinkHops)
            {
                throw new IOException(
                    $"Resolving '{path}' exceeded {MaxLinkHops.ToString(CultureInfo.InvariantCulture)} links, "
                        + "which means the path contains a cycle."
                );
            }

            // Reading the link said nothing about where it points; every step after this one is
            // taken on a path the link chose. Inspecting the target's segments reads them, and a
            // target on another host makes the first of those reads an outbound request. So the
            // boundary is applied to the target here, while it is still only text — checking it
            // afterwards reaches the same verdict, but only by first making the request that the
            // verdict exists to prevent.
            var followed = Path.TrimEndingDirectorySeparator(Path.GetFullPath(target, resolved));

            if (isTargetPermitted is not null && !isTargetPermitted(followed))
            {
                throw new LinkLeavesBoundaryException(candidate, followed);
            }

            // The target's own ancestors may themselves be links, so resolution restarts from the
            // target with whatever segments were still outstanding appended to it.
            var outstanding = pending;
            pending = Split(followed, out resolved);

            while (outstanding.Count > 0)
            {
                pending.Enqueue(outstanding.Dequeue());
            }
        }

        return resolved;
    }

    private static Queue<string> Split(string fullPath, out string root)
    {
        var path = Path.TrimEndingDirectorySeparator(fullPath);
        var segments = new Stack<string>();

        while (true)
        {
            var parent = Path.GetDirectoryName(path);

            if (string.IsNullOrEmpty(parent))
            {
                root = path;
                return new Queue<string>(segments);
            }

            segments.Push(Path.GetFileName(path));
            path = parent;
        }
    }

    /// <summary>
    /// The target of a segment's link, or <see langword="null"/> when it is confirmed not to be
    /// one.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The two negative answers here are not the same answer. "This segment does not exist" is
    /// proof that it is not a link. "I could not inspect this segment" is proof of nothing — and
    /// treating it as the former is what lets an unverified segment through, after which a read
    /// can follow it out of the root.
    /// </para>
    /// <para>
    /// <see cref="FileSystemInfo.LinkTarget"/> cannot express that difference: on Windows it
    /// answers <see langword="null"/> for an entry whose attributes could not be read just as it
    /// does for a plain file. <see cref="FileSystemInfo.ResolveLinkTarget(bool)"/> throws instead,
    /// which is the distinction this method is built on.
    /// </para>
    /// </remarks>
    /// <exception cref="IOException">The segment exists but could not be inspected.</exception>
    private static string? LinkTarget(string path)
    {
        try
        {
            FileSystemInfo entry = Directory.Exists(path) ? new DirectoryInfo(path) : new FileInfo(path);

            return entry.ResolveLinkTarget(returnFinalTarget: false)?.FullName;
        }
        catch (Exception exception) when (exception is FileNotFoundException or DirectoryNotFoundException)
        {
            // Confirmed absent. A segment that is not there cannot be a link, and a suite path
            // that does not exist is an ordinary not-found rather than a refusal.
            return null;
        }
        catch (Exception exception)
            when (exception is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            throw new IOException(
                $"Path segment '{path}' exists but could not be inspected, so whether it is a link that leaves the "
                    + "suite root could not be established. It was refused rather than assumed safe.",
                exception
            );
        }
    }
}

/// <summary>
/// Signals that resolution stopped at a link pointing outside the boundary it was confined to.
/// </summary>
/// <remarks>
/// <para>
/// It is raised <i>before</i> the target is inspected, so nothing has been read on the link's
/// say-so. That is the whole point of the type: the refusal must not cost the read it refuses.
/// </para>
/// <para>
/// It derives from <see cref="IOException"/> so that a caller which handles only that still fails
/// closed, and so that the compiler forces a caller which wants to tell the two apart to catch
/// this one first.
/// </para>
/// </remarks>
internal sealed class LinkLeavesBoundaryException : IOException
{
    /// <summary>Initializes a new instance naming the link and the target it was refused for.</summary>
    /// <param name="linkPath">The link that was not followed.</param>
    /// <param name="target">The path it points at.</param>
    public LinkLeavesBoundaryException(string linkPath, string target)
        : base(
            $"Link '{linkPath}' points to '{target}', which is outside the boundary resolution was confined to. "
                + "It was refused without being read."
        ) { }
}
