using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Forge.EvalEngine.Paths;
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
///   <item><description>Unset optional <b>properties</b> are written as <b>absent</b>, never as nulls.</description></item>
///   <item><description>Enums are written as camel-case strings, and <b>integer input is refused</b> — an ordinal from a suite file is not a way into a closed set.</description></item>
///   <item><description>A null assigned to a non-nullable member is refused rather than bound, so a required sub-record cannot arrive null. That enforcement is <b>member-only</b>: the serializer does not apply it to the element type of a collection or the value type of a dictionary, so <see cref="DeserializeSuiteResult(string)"/> checks those itself.</description></item>
///   <item><description>Line endings are <c>\n</c> regardless of platform.</description></item>
/// </list>
/// <para>
/// <b>Both of those null rules govern properties and nothing else, and that boundary has now
/// caught this library twice.</b> <c>WhenWritingNull</c> omits an unset <i>property</i>;
/// <c>RespectNullableAnnotations</c> refuses a null bound to a non-nullable <i>property</i>.
/// Neither reaches the element type of a collection or the value type of a dictionary. So this
/// artifact <i>can</i> carry a null: a null dictionary value and a null array element are both
/// written as they stand. <see cref="Transcripts.Outcome.Fields"/> is the one place that is
/// deliberate and legitimate — its value type is declared nullable because a null is how a run
/// records that the system returned no value for a field. Everywhere else a null in one of those
/// positions is refused on read-back by <see cref="DeserializeSuiteResult(string)"/>, so writing
/// one produces an artifact this engine will not read.
/// </para>
/// <para>
/// One misreading of where those two options apply produced both defects: a null element that
/// bound silently and was dereferenced into a <see cref="NullReferenceException"/>, and the
/// remark above — which until it was qualified said "unset optional <i>values</i>" and was read,
/// reasonably, as "this artifact never contains a null". <b>Before stating what the serializer
/// guarantees, check where the option actually applies, by running it.</b> Every claim in this
/// remark was verified that way rather than from the documentation.
/// </para>
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
    /// <exception cref="UnsafeIdentifierException">
    /// <typeparamref name="T"/> is <see cref="SuiteResult"/> and it names a machine path in a
    /// position that reaches a committed, published file.
    /// </exception>
    public static string Serialize<T>(T value)
    {
        // The write door. DeserializeSuiteResult refuses an artifact that names somebody's
        // machine; nothing refused one on the way out, so a caller that builds a SuiteResult in
        // process — which is what every consumer of the coordinator does — could serialize one
        // and publish it without ever passing a guard. Same rule, same implementation, both
        // directions, special-cased on the same type Deserialize<T> special-cases.
        if (value is SuiteResult artifact)
        {
            _ = RequireSafeIdentifiers(artifact);
        }

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
    /// <exception cref="MalformedArtifactException">
    /// <typeparamref name="T"/> is <see cref="SuiteResult"/> and the artifact carries a null in a
    /// position its shape declares as never holding one.
    /// </exception>
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
    /// <exception cref="MalformedArtifactException">
    /// The artifact carries a null in a position its shape declares as never holding one — a null
    /// element in a list, or a null value in a dictionary whose value type forbids one.
    /// </exception>
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
                "This artifact declares a schema version this engine cannot read. It reads version "
                    + $"'{SchemaVersions.SuiteResult}'. The declared value is carried on "
                    + $"{nameof(SchemaVersionException.DeclaredVersion)} rather than repeated here, because this "
                    + "message reaches the build log and the value came out of an untrusted artifact."
            )
            {
                DeclaredVersion = declared,
                SupportedVersion = SchemaVersions.SuiteResult,
            };
        }

        return RequireBackedVerdicts(
            RequireSafeIdentifiers(
                RequireWellFormedShape(
                    Bind<SuiteResult>(json) ?? throw new JsonException("A suite result must not be the literal null.")
                )
            )
        );
    }

    /// <summary>
    /// Refuses an artifact recording a verdict its own evidence cannot support.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>The read door, not a duplicate of the decision points.</b>
    /// <see cref="Comparison.SuiteComparator"/> and <see cref="Impact.ImpactSelector"/> establish
    /// the same property because a <see cref="SuiteResult"/> is also built in process and never
    /// serialized — which is a reason to keep those checks, not a reason to leave file input
    /// unvalidated. Every consumer that reads an artifact and counts its runs <i>without</i> going
    /// through the comparator — a trend report, a summary table — otherwise reads the
    /// contradiction as a pass and exits successfully.
    /// </para>
    /// <para>
    /// The rule itself lives in <see cref="VerdictEvidence"/> and is asked rather than restated,
    /// so the four places that enforce it cannot drift into four rules.
    /// </para>
    /// <para>
    /// This runs after <see cref="RequireSafeIdentifiers"/> so that a refusal here cannot be the
    /// first thing to touch an artifact whose identifiers are unsafe to name — and it names none
    /// of them anyway, only a field and a position.
    /// </para>
    /// </remarks>
    private static SuiteResult RequireBackedVerdicts(SuiteResult artifact)
    {
        for (var index = 0; index < artifact.ScenarioResults.Count; index++)
        {
            var scenario = artifact.ScenarioResults[index];

            for (var position = 0; position < scenario.Runs.Count; position++)
            {
                if (!VerdictEvidence.IsUnbacked(scenario.Runs[position]))
                {
                    continue;
                }

                throw new ContradictoryArtifactException(
                    $"This artifact records a verdict for a run whose own transcript says no successful exchange "
                        + $"with the system under test took place, at scenario {Ordinal(index)}, run "
                        + $"{Ordinal(position)}. A run that gathered no evidence is recorded as an error by the "
                        + $"harness that conducts it, so {VerdictEvidence.Why}. The run needs to happen — "
                        + "regenerating the file from the same incomplete state would reproduce it. No value read "
                        + "out of the artifact is repeated here, because this message is written to the build log."
                )
                {
                    Field = "runs",
                    Position = "scenario " + Ordinal(index) + ", run " + Ordinal(position),
                };
            }
        }

        return artifact;
    }

    /// <summary>
    /// Refuses an artifact carrying a null where its own shape says one cannot be.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>The serializer does not cover this, and the class remarks above say where it stops.</b>
    /// <c>RespectNullableAnnotations</c> is enforced for properties and constructor parameters. It
    /// is not enforced for the <i>element</i> type of a collection or the <i>value</i> type of a
    /// dictionary, so <c>"scenarioResults": [null]</c> binds cleanly into a list whose element type
    /// says it cannot hold one. The suite-side converters state this for the material they read —
    /// see <see cref="ScriptedStimulusJsonConverter.HandleNull"/> — and nothing stated it for the
    /// artifact.
    /// </para>
    /// <para>
    /// <b>This runs before <see cref="RequireSafeIdentifiers"/> because that is what a null
    /// crashes.</b> The identifier check indexes the scenario list and reads an id off each entry,
    /// so a null element reached it as a <see cref="NullReferenceException"/> — which a consumer
    /// does not classify as an unreadable artifact, so it falls through to a defect handler and
    /// reports a stack trace naming the machine it ran on. Going first discloses nothing: a shape
    /// refusal names only field names this engine owns and an integer position.
    /// </para>
    /// <para>
    /// <b>A null is refused only where the declared type forbids one.</b>
    /// <see cref="Transcripts.Outcome.Fields"/> is declared with a <i>nullable</i> value type and
    /// is deliberately left alone, as is every optional member. That asymmetry is the artifact's
    /// own: one dictionary in the graph says <c>string?</c> and every other says <c>string</c>.
    /// Turning a valid artifact into a refusal is the worse failure of the two — the crash is
    /// loud, and the refusal would be believed.
    /// </para>
    /// </remarks>
    private static SuiteResult RequireWellFormedShape(SuiteResult artifact)
    {
        RequireNoNullEntry(artifact.SlicingDimensions, "slicingDimensions", null);
        RequireNoNullValue(artifact.Environment.HarnessConfig, "environment.harnessConfig", null);

        if (artifact.SelectionDecisions is { } decisions)
        {
            RequireNoNullEntry(decisions, "selectionDecisions", null);
        }

        for (var index = 0; index < artifact.ScenarioResults.Count; index++)
        {
            var at = "scenario " + Ordinal(index);

            if (artifact.ScenarioResults[index] is not { } scenario)
            {
                throw Malformed("scenarioResults", at);
            }

            RequireNoNullValue(scenario.Tags, "tags", at);

            for (var position = 0; position < scenario.Runs.Count; position++)
            {
                var within = at + ", run " + Ordinal(position);

                if (scenario.Runs[position] is not { } run)
                {
                    throw Malformed("runs", within);
                }

                RequireNoNullEntry(run.AssertionResults, "assertionResults", within);
                RequireNoNullEntry(run.Transcript.Turns, "transcript.turns", within);
                RequireNoNullValue(run.Transcript.Transport.Attributes, "transcript.transport.attributes", within);
            }
        }

        return artifact;
    }

    /// <summary>Refuses a null element in a list whose element type forbids one.</summary>
    /// <typeparam name="T">The element type, as the artifact declares it.</typeparam>
    /// <param name="entries">The bound collection.</param>
    /// <param name="field">The artifact field it came from.</param>
    /// <param name="within">The position of the entry that owns it, or null at artifact level.</param>
    private static void RequireNoNullEntry<T>(IReadOnlyList<T> entries, string field, string? within)
        where T : class
    {
        for (var index = 0; index < entries.Count; index++)
        {
            if (entries[index] is null)
            {
                var at = "entry " + Ordinal(index);

                throw Malformed(field, within is null ? at : within + ", " + at);
            }
        }
    }

    /// <summary>Refuses a null value in a dictionary whose value type forbids one.</summary>
    /// <param name="entries">The bound dictionary.</param>
    /// <param name="field">The artifact field it came from.</param>
    /// <param name="within">The position of the entry that owns it, or null at artifact level.</param>
    /// <remarks>
    /// <b>The key is not named, and no ordinal is offered in its place.</b> A key is
    /// author-supplied and reaches the same build log this refusal does, so it may itself be the
    /// machine path <see cref="RequireSafeIdentifiers"/> exists to refuse — naming it would move a
    /// disclosure rather than remove one. An ordinal would be worse than nothing: a dictionary has
    /// no stable order, so it would send a reader to a different entry than the one that failed.
    /// </remarks>
    private static void RequireNoNullValue(IReadOnlyDictionary<string, string> entries, string field, string? within)
    {
        foreach (var entry in entries)
        {
            if (entry.Value is null)
            {
                throw Malformed(field, within);
            }
        }
    }

    /// <summary>A one-based position, spelled the way the identifier refusal spells it.</summary>
    private static string Ordinal(int index) => "#" + (index + 1).ToString(CultureInfo.InvariantCulture);

    /// <summary>
    /// The refusal, naming the field and the position but never anything read out of the artifact.
    /// </summary>
    /// <remarks>
    /// Same rule as <see cref="Unsafe"/>, for the same reason: this message reaches standard error
    /// and from there the build log (§V).
    /// </remarks>
    private static MalformedArtifactException Malformed(string field, string? position) =>
        new(
            $"This artifact carries a null in '{field}'"
                + (position is null ? string.Empty : $", at {position}")
                + ". That position is declared as never holding one, so the artifact does not match the shape this "
                + "engine reads and is refused rather than dereferenced into a failure somewhere further on. "
                + "Regenerate it from a run rather than editing it by hand. No value read out of the artifact is "
                + "repeated here, because this message is written to the build log."
        )
        {
            Field = field,
            Position = position,
        };

    /// <summary>
    /// Refuses an artifact whose identifiers name somebody's machine.
    /// </summary>
    /// <param name="artifact">The artifact to check.</param>
    /// <returns>The same artifact, when every identifier in it is safe to name.</returns>
    /// <remarks>
    /// <para>
    /// Validating a suite on load does not cover this. An artifact was written by an earlier run,
    /// possibly by an earlier build, and its identifiers never pass through
    /// <see cref="Loading.SuiteLoader"/> again. A scenario since <b>removed</b> from the suite
    /// exists only in the baseline, so current-suite validation cannot see it — and it is still
    /// rendered into the published report as a removed scenario.
    /// </para>
    /// <para>
    /// <b>Internal rather than private, because reading a file is not the only way an artifact
    /// arrives.</b> <see cref="Comparison.SuiteComparator"/> and
    /// <see cref="Impact.ImpactSelector"/> are handed <see cref="SuiteResult"/> instances built in
    /// process, which reach neither this reader nor <see cref="Serialize{T}(T)"/> — and both then
    /// compose refusals and log lines naming the identifiers they were given. Each stage runs this
    /// on what it is handed, so every message downstream of it is safe by construction rather than
    /// by a per-message audit that has to be redone every time a message is added.
    /// </para>
    /// </remarks>
    /// <exception cref="UnsafeIdentifierException">An identifier names a machine path.</exception>
    internal static SuiteResult RequireSafeIdentifiers(SuiteResult artifact)
    {
        if (MachinePath.IsPresentIn(artifact.SuiteName))
        {
            throw Unsafe("suiteName", null);
        }

        if (MachinePath.IsPresentInAny(artifact.SlicingDimensions))
        {
            throw Unsafe("slicingDimensions", null);
        }

        // Two surfaces that did not exist when the machine-path trade-off was reasoned about,
        // and both carry author-supplied free text verbatim into a committed, published file.
        // ADR 0005 is explicit that a documented trade-off is scoped to the surfaces that existed
        // when it was made, so neither inherits the reasoning — the same call the selection
        // decisions got below. The key is guarded as well as the value: a key is as
        // author-supplied as a value, and a reader reproducing the run reads both.
        if (
            MachinePath.IsPresentInAny(artifact.Environment.HarnessConfig.Keys)
            || MachinePath.IsPresentInAny(artifact.Environment.HarnessConfig.Values)
        )
        {
            throw Unsafe("environment.harnessConfig", null);
        }

        for (var index = 0; index < artifact.ScenarioResults.Count; index++)
        {
            var scenario = artifact.ScenarioResults[index];
            var position = "#" + (index + 1).ToString(CultureInfo.InvariantCulture);

            if (MachinePath.IsPresentIn(scenario.ScenarioId))
            {
                throw Unsafe("scenarioId", position);
            }

            if (MachinePath.IsPresentIn(scenario.ExpectedFailure?.Reason))
            {
                throw Unsafe("expectedFailure", position);
            }

            if (MachinePath.IsPresentInAny(scenario.Tags.Keys) || MachinePath.IsPresentInAny(scenario.Tags.Values))
            {
                throw Unsafe("tags", position);
            }

            // The fingerprint is a label the engine stamps, and the selector quotes both sides of
            // a mismatch into a selection reason. An artifact from elsewhere can carry anything
            // in it.
            if (MachinePath.IsPresentIn(scenario.DefinitionFingerprint))
            {
                throw Unsafe("definitionFingerprint", position);
            }

            // Each run's transcript carries its own scenario id, and the comparator and the
            // selector both name it when it disagrees with the one the run is filed under — which
            // is precisely the misattribution they exist to catch. Checking only the
            // ScenarioResult's id left the value that actually gets quoted unguarded.
            for (var run = 0; run < scenario.Runs.Count; run++)
            {
                if (MachinePath.IsPresentIn(scenario.Runs[run].Transcript?.ScenarioId))
                {
                    throw Unsafe("transcript.scenarioId", position + ", run " + Ordinal(run));
                }
            }
        }

        // A separate surface, not a restatement of the loop above. A scenario the selector
        // skipped has no ScenarioResult, so its identifier appears nowhere else in the artifact
        // and has never been through this check — and it is still written into a committed file
        // and rendered into a published comment. ADR 0005 is explicit that a documented
        // trade-off is scoped to the surfaces that existed when it was made; this is a new one,
        // so it is guarded rather than left to inherit the reasoning.
        if (artifact.SelectionDecisions is { } decisions)
        {
            for (var index = 0; index < decisions.Count; index++)
            {
                if (MachinePath.IsPresentIn(decisions[index].ScenarioId))
                {
                    throw Unsafe("selectionDecisions", "#" + (index + 1).ToString(CultureInfo.InvariantCulture));
                }
            }
        }

        return artifact;
    }

    /// <summary>
    /// The refusal, naming the field and the position but never the value.
    /// </summary>
    /// <remarks>
    /// This message reaches standard error and from there the build log, so repeating the path
    /// would move the disclosure rather than remove it (§V).
    /// </remarks>
    private static UnsafeIdentifierException Unsafe(string field, string? position) =>
        new(
            $"This artifact carries a machine path in '{field}'"
                + (position is null ? string.Empty : $", at scenario {position}")
                + ". That value names the account a job runs as and the layout of the machine it runs on, and this "
                + "artifact is committed and published, so it is refused rather than read. Rename the identifier in "
                + "the suite and regenerate the artifact. The offending value is not repeated here because this "
                + "message is written to the build log."
        )
        {
            Field = field,
            Position = position,
        };

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
