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
/// <para>
/// <b>No finding names the suite by a path on the caller's machine.</b> Findings are written to
/// standard error by the command-line tool and land in CI logs, and the suite path it supplies is
/// absolute, so a checkout path in a finding discloses the account a job runs as (§V). This is
/// not the identifier guard and must not be built out of it: a suite path is caller-supplied and
/// legitimate, so it is <i>not printed</i> rather than refused. The label a finding uses comes
/// from <see cref="RootRelativeLabel"/> or <see cref="FileNameLabel"/>, and the unreduced path is
/// returned on <see cref="SuiteLoadResult.SourcePath"/> for a caller that wants it.
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
        var label = RootRelativeLabel(resolved);
        var (text, outcome) = await ReadTextAsync(resolved, cancellationToken).ConfigureAwait(false);

        // Attached here, after every finding has already been composed. This method holds the
        // path and writes no message; FromOutcome and LoadDocument write every message and do
        // not have the path.
        return FromOutcome(text, outcome, label) with
        {
            SourcePath = resolved,
        };
    }

    /// <summary>Validates suite content that has already been read.</summary>
    /// <param name="json">The suite document.</param>
    /// <param name="sourceName">
    /// A label for the source, used in findings. Reduced to a file name before it is used — see
    /// the remarks.
    /// </param>
    /// <returns>The loaded suite, or the findings that prevented it.</returns>
    /// <remarks>
    /// <para>
    /// <b>This overload has no containment root, so it cannot name the source relatively.</b> It
    /// reduces <paramref name="sourceName"/> to its file name, which is the only reduction that
    /// is safe without a root to be relative to, and loses directory context as the honest price
    /// of that. <see cref="LoadAsync"/> does have a root and names the suite relative to it.
    /// </para>
    /// <para>
    /// The reduction happens here rather than at the call site so that a direct caller of this
    /// method is covered too. The unreduced value is returned on
    /// <see cref="SuiteLoadResult.SourcePath"/>.
    /// </para>
    /// </remarks>
    /// <exception cref="ArgumentNullException"><paramref name="json"/> is null.</exception>
    public static SuiteLoadResult LoadFromJson(string json, string sourceName)
    {
        ArgumentNullException.ThrowIfNull(json);

        return LoadDocument(json, FileNameLabel(sourceName)) with
        {
            SourcePath = sourceName,
        };
    }

    /// <summary>Why a suite file could not be read.</summary>
    /// <remarks>
    /// The read reports its outcome as one of these rather than composing a message, so that the
    /// only method holding the path holds nothing to print it into. See
    /// <see cref="ReadTextAsync"/> and <see cref="FromOutcome"/>.
    /// </remarks>
    private enum ReadOutcome
    {
        /// <summary>The bytes were read.</summary>
        Read,

        /// <summary>Nothing is there.</summary>
        NotFound,

        /// <summary>Something is there and could not be read.</summary>
        Unreadable,

        /// <summary>Something is there and access to it was refused.</summary>
        AccessDenied,
    }

    /// <summary>Turns a read outcome into findings, without the path that produced it.</summary>
    /// <param name="text">The document, when it was read.</param>
    /// <param name="outcome">Why it was or was not read.</param>
    /// <param name="sourceLabel">What findings call the suite. Carries no machine path.</param>
    /// <returns>The loaded suite, or the findings that prevented it.</returns>
    /// <remarks>
    /// <b>There is deliberately no path parameter here, and there must not be one.</b> Reading a
    /// file requires the path, so some method has to hold it — <see cref="ReadTextAsync"/> does,
    /// and it reports an outcome rather than a message. Splitting it this way is what makes the
    /// isolation a property the compiler enforces instead of a rule stated in a comment: the
    /// method that could name the path has nothing to name it in, and the method that writes the
    /// message cannot reach it.
    /// </remarks>
    private static SuiteLoadResult FromOutcome(string? text, ReadOutcome outcome, string sourceLabel) =>
        outcome switch
        {
            ReadOutcome.Read => LoadDocument(text!, sourceLabel),
            ReadOutcome.NotFound => Failed(
                "suite.notFound",
                $"Suite file '{sourceLabel}' was not found under the suite root."
            ),
            ReadOutcome.AccessDenied => Failed(
                "suite.unreadable",
                $"Suite file '{sourceLabel}' could not be read: access was denied."
            ),
            _ => Failed("suite.unreadable", $"Suite file '{sourceLabel}' could not be read."),
        };

    /// <summary>
    /// The only method that both holds the suite path and touches the file system.
    /// </summary>
    /// <param name="resolvedPath">The real path to read.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The text, or why it could not be read.</returns>
    /// <remarks>
    /// <b>It reports an outcome, not a message.</b> Reading a file requires the path, so some
    /// method has to hold it; what this shape guarantees is that the method holding it has no
    /// message to interpolate it into, and the methods that compose messages do not have it.
    /// That is the difference between a rule stated in a comment and one the compiler enforces.
    /// </remarks>
    private static async Task<(string? Text, ReadOutcome Outcome)> ReadTextAsync(
        string resolvedPath,
        CancellationToken cancellationToken
    )
    {
        try
        {
            return (
                await File.ReadAllTextAsync(resolvedPath, cancellationToken).ConfigureAwait(false),
                ReadOutcome.Read
            );
        }
        catch (FileNotFoundException)
        {
            return (null, ReadOutcome.NotFound);
        }
        catch (DirectoryNotFoundException)
        {
            return (null, ReadOutcome.NotFound);
        }
        catch (IOException)
        {
            return (null, ReadOutcome.Unreadable);
        }
        catch (UnauthorizedAccessException)
        {
            return (null, ReadOutcome.AccessDenied);
        }
    }

    /// <summary>
    /// Validates a suite document against a label already made safe to print.
    /// </summary>
    /// <param name="json">The suite document.</param>
    /// <param name="sourceLabel">
    /// What findings call the suite. Already reduced to a form carrying no machine path.
    /// </param>
    /// <returns>The loaded suite, or the findings that prevented it.</returns>
    /// <remarks>
    /// <b>There is deliberately no path parameter here, and there must not be one.</b> Every
    /// suite-level finding is composed in this method or below it, so the isolation is only real
    /// if the path is absent from the scope rather than merely unused in it. An earlier shape
    /// carried the path alongside the label so it could be attached to the result; that left a
    /// new finding one identifier away from the original defect. The caller attaches
    /// <see cref="SuiteLoadResult.SourcePath"/> to what this returns.
    /// </remarks>
    private static SuiteLoadResult LoadDocument(string json, string sourceLabel)
    {
        JsonObject document;
        try
        {
            if (JsonNode.Parse(json) is not JsonObject parsed)
            {
                return Failed("suite.malformed", $"Suite '{sourceLabel}' must be a JSON object.");
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
            return Failed("suite.malformed", $"Suite '{sourceLabel}' is not valid JSON.");
        }
        catch (ArgumentException)
        {
            // The cause's message names the duplicated property, and a property name is
            // author-supplied. Described from the type instead — see Unreadable.
            return Failed(
                "suite.malformed",
                $"Suite '{sourceLabel}' is not valid JSON: it declares the same property more than once."
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
                    $"Suite '{sourceLabel}' does not declare a name. The name labels the resulting artifact."
                )
            );

            // The label, not the path. This finding is an error, so `refused` below is always
            // true and this value never reaches an artifact today — but it is one severity
            // change away from writing a caller's checkout path into the committed JSON, which
            // is the disclosure the name guard above exists to prevent.
            name = sourceLabel;
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

        var schemaVersion = ValidateSchemaVersion(document, sourceLabel, messages);
        var scenarios = ReadScenarios(document["scenarios"], sourceLabel, messages);
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

    /// <summary>
    /// Names a suite for a finding, relative to the root it is confined to.
    /// </summary>
    /// <param name="resolvedPath">The real path, already proven to lie under the root.</param>
    /// <returns>A label carrying no machine path.</returns>
    /// <remarks>
    /// <para>
    /// <b>The suite path is caller-supplied, and through the command-line tool it is absolute.</b>
    /// Findings are written to standard error and land in CI logs, which on many setups are
    /// readable by anyone who can read the repository, and a checkout path names the account the
    /// job runs as (§V). This is <i>not</i> the same problem as an identifier containing a
    /// machine path: that value is author-supplied and can be refused, whereas a caller naming a
    /// real file they chose has done nothing wrong. So the path is not validated and not refused
    /// — it is simply not printed.
    /// </para>
    /// <para>
    /// <b>Relative to the root loses nothing a reader needs.</b> The root is supplied separately
    /// and has its own diagnostics; the relative portion is the whole of what a caller can get
    /// wrong in a suite argument, and it is the whole of what a typo shows up in. The absolute
    /// path is that plus exactly the component that identifies the machine.
    /// </para>
    /// <para>
    /// Falls back to the file name if the relative form is not actually relative, or ascends out
    /// of the root. Containment makes that unreachable — <see cref="PathBoundary.Resolve"/> has
    /// already proven <paramref name="resolvedPath"/> lies under the root — and it is kept
    /// because the failure it guards is a silent disclosure rather than a crash.
    /// </para>
    /// </remarks>
    private string RootRelativeLabel(string resolvedPath)
    {
        var relative = Path.GetRelativePath(_root.Root, resolvedPath);

        return Path.IsPathRooted(relative) || AscendsFromRoot(relative) ? FileNameLabel(resolvedPath) : relative;
    }

    /// <summary>
    /// Whether a relative path's <b>first segment</b> is an ascent.
    /// </summary>
    /// <param name="relative">The path relative to the root, as the runtime produced it.</param>
    /// <returns><see langword="true"/> when the path climbs above the root.</returns>
    /// <remarks>
    /// <para>
    /// <b>Category: a path this machine resolved, so the host's separators are the correct
    /// ones.</b> This string came out of <see cref="Path.GetRelativePath"/> against a root the
    /// boundary canonicalised, so it is spelled the way this OS spells paths. That is the
    /// opposite of <see cref="FileNameLabel"/>, whose input is caller text of unknown
    /// provenance — and the two rules must not be swapped. Reading <c>\</c> as a separator here
    /// is wrong on Unix, where it is an ordinary filename character: a contained directory named
    /// <c>..\draft</c> would be read as an ascent and lose its name from the finding.
    /// </para>
    /// <para>
    /// <b>Asked about a segment, because the question is about a segment.</b> Asking it as
    /// <c>StartsWith("..")</c> also matches <c>..draft/</c>, an ordinary contained directory, so
    /// a perfectly valid in-root suite fell through to the file name. That is the opposite of
    /// what the relative label exists for: a mistyped directory is half of what a caller can get
    /// wrong in a suite argument.
    /// </para>
    /// </remarks>
    private static bool AscendsFromRoot(string relative) =>
        relative.Equals("..", StringComparison.Ordinal)
        || (
            relative.Length > 2 && relative.StartsWith("..", StringComparison.Ordinal) && IsNativeSeparator(relative[2])
        );

    /// <summary>Whether a character separates path segments <b>on this host</b>.</summary>
    /// <remarks>
    /// On Unix both of these are <c>/</c>, so <c>\</c> is correctly not a separator. On Windows
    /// they are <c>\</c> and <c>/</c>, so both are.
    /// </remarks>
    private static bool IsNativeSeparator(char character) =>
        character == Path.DirectorySeparatorChar || character == Path.AltDirectorySeparatorChar;

    /// <summary>
    /// Names a suite for a finding when there is no root to be relative to.
    /// </summary>
    /// <param name="sourceName">The caller's label, which may be an absolute path.</param>
    /// <returns>A label carrying no machine path.</returns>
    /// <remarks>
    /// <para>
    /// <b>Category: caller text of unknown provenance, so both separator styles are read and
    /// <see cref="Path"/> is deliberately not used.</b> <see cref="Path.GetFileName(string)"/> is
    /// host-dependent: on Windows both <c>\</c> and <c>/</c> separate, but on Unix only <c>/</c>
    /// does. A Windows-shaped absolute label therefore comes back <i>whole</i> from a Unix host —
    /// the full checkout path, printed into the log, on the platform most CI runs on. A label is
    /// not a path being resolved against this machine's file system; it is text that may have
    /// come from anywhere, so it is reduced by the rule rather than by the host. That is the
    /// opposite of <see cref="AscendsFromRoot"/>, which inspects a path this machine produced and
    /// must therefore use the host's own separators — <b>do not unify the two.</b>
    /// </para>
    /// <para>
    /// A label that is already a bare name is returned unchanged, so a caller that passes
    /// something descriptive keeps it. One that names no file — blank, a bare separator, a bare
    /// drive such as <c>C:\</c>, or a UNC authority with no share — becomes
    /// <see cref="UnnamedSource"/>, because what is left of those is either nothing or the name
    /// of a machine.
    /// </para>
    /// </remarks>
    private static string FileNameLabel(string? sourceName)
    {
        if (string.IsNullOrWhiteSpace(sourceName))
        {
            return UnnamedSource;
        }

        var trimmed = sourceName.Trim().TrimEnd(Separators);
        var cut = trimmed.LastIndexOfAny(Separators);

        // An authority with no share reduces to the host, which names a machine rather than a
        // file. Each of the two leading positions is tested for *either* separator: the pair is
        // not necessarily matching, and reading it as one of "\\" or "//" let "\/host" through.
        if (cut <= 1 && trimmed.Length > 1 && IsEitherSeparator(trimmed[0]) && IsEitherSeparator(trimmed[1]))
        {
            return UnnamedSource;
        }

        var name = cut < 0 ? trimmed : trimmed[(cut + 1)..];

        return string.IsNullOrWhiteSpace(name) || IsDriveSpecification(name) ? UnnamedSource : name;
    }

    /// <summary>Whether a reduced label is a bare drive such as <c>C:</c>, all that is left of <c>C:\</c>.</summary>
    private static bool IsDriveSpecification(string name) =>
        name.Length == 2 && char.IsAsciiLetter(name[0]) && name[1] == ':';

    /// <summary>Whether a character separates path segments <b>in caller text</b>, on any host.</summary>
    private static bool IsEitherSeparator(char character) => character is '/' or '\\';

    /// <summary>Both path separators, because a label may have been written on another host.</summary>
    private static readonly char[] Separators = ['/', '\\'];

    private static string ValidateSchemaVersion(
        JsonObject document,
        string sourceLabel,
        List<ValidationMessage> messages
    )
    {
        if (!document.ContainsKey("schemaVersion"))
        {
            messages.Add(
                SuiteValidator.Warning(
                    "suite.schemaVersion.missing",
                    null,
                    $"Suite '{sourceLabel}' declares no schemaVersion, so it is being read as "
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
                    $"Suite '{sourceLabel}' declares a schemaVersion this engine cannot read. It reads version "
                        + $"'{SchemaVersions.Suite}'. The declared value is not repeated here because this finding "
                        + "is written to the build log."
                )
            );
        }

        return declared ?? SchemaVersions.Suite;
    }

    private static List<Scenario> ReadScenarios(JsonNode? node, string sourceLabel, List<ValidationMessage> messages)
    {
        var scenarios = new List<Scenario>();

        if (node is not JsonArray entries)
        {
            messages.Add(
                SuiteValidator.Error(
                    "suite.scenarios.missing",
                    null,
                    $"Suite '{sourceLabel}' does not declare a 'scenarios' array."
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
                    $"Suite '{sourceLabel}' declares no scenarios, so a run against it would prove nothing."
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

                // The value arrived as the literal null and bound into a dictionary whose value
                // type says it cannot hold one — the serializer enforces nullable annotations on
                // members, not on the value type of a dictionary. This is not cosmetic:
                // RunCoordinator copies a scenario's tags straight into the artifact and
                // CanonicalJson writes the null out, so admitting it here produces a committed
                // artifact that CanonicalJson.DeserializeSuiteResult then refuses to read.
                // Refused at authoring time, where the value is in a committed file with a human
                // attached to it and the fix costs one edit (ADR 0005). After the machine-path
                // check above, which is security-critical and must see the scenario first.
                if (HasNullTagValue(scenario))
                {
                    messages.Add(NullTag(position));
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
    /// <b>The suite path is now structurally out of reach of a finding.</b> Every message is
    /// composed from a <c>sourceLabel</c> that was reduced before it was passed down, and the
    /// unreduced path is carried separately to <see cref="SuiteLoadResult.SourcePath"/>. That is
    /// deliberate: the previous shape kept the raw path in scope everywhere a finding was written,
    /// so the fix for one site left the next one an identical trap. If you need to name the suite
    /// in a new finding, use the label you were given — there is no path in scope to reach for.
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
    /// Reports a slicing tag whose value arrived as the literal null.
    /// </summary>
    /// <param name="position">The scenario's position in the suite file.</param>
    /// <returns>The finding.</returns>
    /// <remarks>
    /// <para>
    /// <b>A finding of its own rather than a bare <c>scenario.malformed</c>.</b> Same reasoning as
    /// <see cref="UnsafeTag"/>: an author told that "something in the scenario is wrong" cannot act
    /// on it, and told that a named tag declares no value can. Nothing else in the suite is wrong.
    /// </para>
    /// <para>
    /// <b>Named by position, not by key.</b> A tag key is author-supplied and this finding is
    /// written to standard error and from there into CI logs, so quoting it would move a
    /// disclosure rather than remove one — the key could itself be the machine path
    /// <see cref="UnsafeIdentifier"/> exists to refuse (§V). The position is enough to act on,
    /// which is the standard the sibling finding already sets.
    /// </para>
    /// </remarks>
    private static ValidationMessage NullTag(string position) =>
        SuiteValidator.Error(
            "scenario.tag.null",
            null,
            $"scenario {position} declares a slicing tag whose value is the literal null. A tag value is declared as "
                + "never being null, and these tags are copied verbatim into the committed artifact, which would "
                + "then fail to read back. Give the tag a value, or omit the tag — an absent tag says 'not sliced on "
                + "this dimension', which is what a null was reaching for. The key is not repeated here because this "
                + "finding is written to the build log."
        );

    /// <summary>Whether a bound scenario carries a slicing tag whose value is null.</summary>
    /// <param name="scenario">The scenario as the binder produced it.</param>
    /// <returns><see langword="true"/> when at least one tag value is null.</returns>
    /// <remarks>
    /// Read off what the binder produced rather than off the raw entry, for the same reason
    /// <see cref="BoundUnsafeIdentifier"/> is: this loader does not perform the binder's key
    /// matching — <c>PropertyNameCaseInsensitive</c> is set by
    /// <see cref="System.Text.Json.JsonSerializerDefaults.Web"/> — and re-deriving those rules here
    /// is how the seam this closes was opened.
    /// </remarks>
    private static bool HasNullTagValue(Scenario scenario)
    {
        foreach (var tag in scenario.Slicing.Tags)
        {
            if (tag.Value is null)
            {
                return true;
            }
        }

        return false;
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

    /// <summary>What a finding calls a source that reduced to nothing printable.</summary>
    private const string UnnamedSource = "<unnamed>";

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
