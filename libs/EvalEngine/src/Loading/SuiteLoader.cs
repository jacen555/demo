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
        catch (ArgumentException)
        {
            // The cause's message names the duplicated property, and a property name is
            // author-supplied. Described from the type instead — see Unreadable.
            return Failed(
                "suite.malformed",
                $"Suite '{sourceName}' is not valid JSON: it declares the same property more than once."
            );
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
        else if (MachinePath.IsPresentIn(name))
        {
            messages.Add(
                SuiteValidator.Error(
                    "suite.name.machinePath",
                    null,
                    "This suite declares a name containing a machine path. A suite name is author-supplied text "
                        + "that is copied into the committed artifact and rendered into published reports, so a "
                        + "machine path in it discloses the account a job runs as and the layout of the machine it "
                        + "runs on. Please rename the suite to describe what it evaluates. Neither the offending "
                        + "value nor the suite's own path is repeated here, because this finding is written to the "
                        + "build log."
                )
            );
        }

        var schemaVersion = ValidateSchemaVersion(document, sourceName, messages);
        var scenarios = ReadScenarios(document["scenarios"], sourceName, messages);
        messages.AddRange(SuiteValidator.Validate(scenarios));

        // A refused suite yields no suite. SuiteLoadResult documents Suite as null on failure,
        // and a consumer that trusts that documentation would otherwise be handed the very
        // identifier the loader just refused — which turns the guard into a suggestion for
        // anyone who checks `Suite is not null` rather than `Succeeded`.
        var refused = messages.Any(message => message.Severity == ValidationSeverity.Error);

        return new SuiteLoadResult
        {
            Suite = refused
                ? null
                : new Suite
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
                    $"Suite '{sourceName}' declares a schemaVersion this engine cannot read. It reads version "
                        + $"'{SchemaVersions.Suite}'. The declared value is not repeated here because this finding "
                        + "is written to the build log."
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
                // Composed here in full, rather than through an overload that takes a reason:
                // a string parameter on Unreadable is exactly the door that let untrusted prose
                // in. This literal is visibly the engine's own.
                messages.Add(
                    SuiteValidator.Error(
                        "scenario.malformed",
                        null,
                        $"scenario {position} could not be read: a scenario must be a JSON object."
                    )
                );
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

                // SECURITY-CRITICAL, and not the same category as the tag read below. Refused
                // before anything else looks at it, and before it is ever used as a label. Every
                // scenario-level finding carries the scenario id, so a scenario whose id is a
                // machine path and which also trips another rule would disclose the path through
                // that other finding instead. An entry that fails to bind never reaches
                // BoundUnsafeIdentifier, so this is the only thing standing between a
                // path-shaped id and the build log. Dropping it here means no later rule sees it.
                if (MachinePath.IsPresentIn(declaredId))
                {
                    messages.Add(UnsafeIdentifier(position, "identity.id", "scenario"));
                    continue;
                }

                label = string.IsNullOrWhiteSpace(declaredId) ? position : declaredId;

                // Diagnostic specificity, not security — see UnsafeTag. Without this the entry
                // below would fail to bind and report a bare scenario.malformed instead.
                if (UnsafeTag(entry) is string offending)
                {
                    messages.Add(UnsafeIdentifier(position, "slicing.tags", offending));
                    continue;
                }

                var scenario =
                    entry.Deserialize<Scenario>(CanonicalJson.Options) ?? throw new JsonException("the entry is null.");

                // And again on what the binder actually produced. The raw checks above read
                // ordinal keys; CanonicalJson's options come from JsonSerializerDefaults.Web,
                // which is case-insensitive, so "ID" and "Tags" miss the raw read and bind
                // anyway. The two checks have different jobs and neither subsumes the other:
                // the raw one keeps a refused value out of a *diagnostic*, and this one keeps it
                // out of the *artifact*. Checking the bound values rather than teaching the raw
                // read the binder's key rules is deliberate — those rules are the binder's to
                // change, and re-deriving them here is how this seam opened.
                if (BoundUnsafeIdentifier(scenario) is { } bound)
                {
                    messages.Add(UnsafeIdentifier(position, bound.Field, bound.What));
                    continue;
                }

                scenarios.Add(scenario);
            }
            catch (JsonException exception)
            {
                messages.Add(Unreadable(label, declaredId, exception));
            }
            catch (ArgumentException exception)
            {
                messages.Add(Unreadable(label, declaredId, exception));
            }
            catch (NotSupportedException exception)
            {
                messages.Add(Unreadable(label, declaredId, exception));
            }
        }

        return scenarios;
    }

    /// <summary>
    /// Reports an identifier that is a path on somebody's machine, without repeating it.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The value is named by its <paramref name="field"/> and the scenario's
    /// <paramref name="position"/> in the suite file rather than quoted back. This finding is
    /// written to standard error by the command-line tool and from there into CI logs, which on
    /// many setups are readable by anyone who can read the repository — so quoting the path here
    /// would move the disclosure rather than remove it (§V).
    /// </para>
    /// <para>
    /// <b>That applies to every value interpolated into a finding, not just the refused one.</b>
    /// An earlier draft of the sibling suite-name finding named the offending value safely and
    /// then interpolated <c>sourceName</c> beside it — which through the command-line tool is an
    /// absolute path, so the message printed <c>C:\Users\&lt;account&gt;\...</c> into the very log
    /// the guard exists to keep it out of. It sanitised the value it was warned about and printed
    /// an unsanitised one immediately next to it. <b>Reasoning did not catch that; running it and
    /// reading the real output did.</b> If you add a finding here, read what it actually prints.
    /// </para>
    /// <para>
    /// A position is still enough to act on, which is the point: a refusal a reader cannot act on
    /// just moves the problem somewhere else.
    /// </para>
    /// </remarks>
    private static ValidationMessage UnsafeIdentifier(string position, string field, string what) =>
        SuiteValidator.Error(
            what == "scenario" ? "scenario.id.machinePath" : "scenario.tag.machinePath",
            null,
            $"scenario {position} declares a {what} containing a machine path, in '{field}'. That value is copied "
                + "into the committed artifact, so it discloses the account a job runs as and the layout of the "
                + "machine it runs on. Please rename it to describe what it evaluates. The offending value is not "
                + "repeated here because this finding is written to the build log."
        );

    /// <summary>
    /// The identifier a bound scenario carries that is a machine path, if any.
    /// </summary>
    /// <param name="scenario">The scenario as the binder produced it.</param>
    /// <returns>The offending field and what it is, or null when the scenario is safe.</returns>
    /// <remarks>
    /// The companion to <see cref="UnsafeTag"/> and the raw id read, not a replacement for them.
    /// Those run before binding so a refused value cannot reach a deserializer diagnostic; this
    /// runs after, so a value that reached the model through key matching this loader does not
    /// perform — <c>PropertyNameCaseInsensitive</c> is set by
    /// <see cref="System.Text.Json.JsonSerializerDefaults.Web"/> — cannot reach the committed
    /// artifact. Two surfaces, two checks; neither covers the other's case.
    /// </remarks>
    private static (string Field, string What)? BoundUnsafeIdentifier(Scenario scenario)
    {
        if (MachinePath.IsPresentIn(scenario.Identity.Id))
        {
            return ("identity.id", "scenario");
        }

        foreach (var tag in scenario.Slicing.Tags)
        {
            if (MachinePath.IsPresentIn(tag.Key))
            {
                return ("slicing.tags", "tag key");
            }

            if (MachinePath.IsPresentIn(tag.Value))
            {
                return ("slicing.tags", "tag value");
            }
        }

        return null;
    }

    /// <summary>
    /// The kind of slicing tag that is a machine path, read from the raw entry.
    /// </summary>
    /// <param name="entry">The unbound scenario entry.</param>
    /// <returns><c>"tag key"</c>, <c>"tag value"</c>, or null when the tags are safe.</returns>
    /// <remarks>
    /// <para>
    /// <b>This check is diagnostic specificity, not security.</b> It once stopped the
    /// deserializer from naming a path-shaped tag key in its own message, but that channel closed
    /// when <see cref="Unreadable"/> stopped forwarding exception prose and began composing the
    /// reason from the cause's type. Nothing leaks through that route now with or without this.
    /// </para>
    /// <para>
    /// What it still does is worth keeping on its own terms: an entry whose tag value will not
    /// bind would otherwise be reported as a bare <c>scenario.malformed</c>, telling the author
    /// that something in the scenario is wrong but not that the problem is a machine path in a
    /// tag key — the one thing they can act on. Reading the tags first turns that into
    /// <c>scenario.tag.machinePath</c> naming the field.
    /// </para>
    /// <para>
    /// <b>Do not read this as the same category as the raw id read above.</b> That one is
    /// security-critical and must stay: an entry that fails to bind never reaches
    /// <see cref="BoundUnsafeIdentifier"/>, so without it a path-shaped id is still in
    /// <c>label</c> and <c>ScenarioId</c> when the binding failure is reported, and it reaches
    /// the build log. This one carries no such consequence. A reader who cannot tell the two
    /// apart will trust the wrong one or delete the wrong one.
    /// </para>
    /// <para>
    /// The <i>artifact</i> surface is covered by <see cref="BoundUnsafeIdentifier"/>, which reads
    /// what the binder produced rather than what the raw keys say.
    /// </para>
    /// </remarks>
    private static string? UnsafeTag(JsonObject entry)
    {
        if (entry["slicing"] is not JsonObject slicing || slicing["tags"] is not JsonObject tags)
        {
            return null;
        }

        foreach (var tag in tags)
        {
            if (MachinePath.IsPresentIn(tag.Key))
            {
                return "tag key";
            }

            if (MachinePath.IsPresentIn(ReadString(tag.Value)))
            {
                return "tag value";
            }
        }

        return null;
    }

    /// <summary>
    /// Reports a scenario that could not be read, describing <b>why</b> from the cause's type
    /// alone.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>This takes the exception, not its message, deliberately.</b> A finding is written to
    /// standard error and lands in the build log. An exception message is prose composed by
    /// somebody else — the JSON reader, a converter, the framework — and it routinely quotes the
    /// author's own material back: a JSON path naming a property, or a literal wrapped in quotes
    /// by <c>Converters</c>. Forwarding it and filtering afterwards is the same under-constrained
    /// problem this whole guard exists to escape, and it holed twice before being removed: prose
    /// does not tokenize like an identifier, so <c>'/home/ci-user/repo'</c> behind a quote slipped
    /// straight through.
    /// </para>
    /// <para>
    /// So the signature takes an <see cref="Exception"/> and there is no overload that takes a
    /// string. The reason is chosen from the cause's <i>type</i>, which is not author-controlled,
    /// and the position is what makes the finding actionable. If you need more detail here,
    /// surface it through structured data or a debug log — do not splice it into this message.
    /// </para>
    /// </remarks>
    private static ValidationMessage Unreadable(string label, string? scenarioId, Exception cause) =>
        SuiteValidator.Error(
            "scenario.malformed",
            scenarioId,
            $"scenario {label} could not be read: {Describe(cause)}"
        );

    /// <summary>The reason, composed here, keyed off a type the author cannot influence.</summary>
    private static string Describe(Exception cause) =>
        cause switch
        {
            ArgumentException => "it declares the same property more than once.",
            NotSupportedException => "it declares a value of a type this engine cannot convert.",
            _ => "its JSON does not match the shape this engine reads.",
        };

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
