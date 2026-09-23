using System.Text.Json;
using System.Text.Json.Serialization;
using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Scenarios;

namespace Forge.EvalEngine.Serialization;

/// <summary>
/// Reads a scripted stimulus written either as a bare string or as an object.
/// </summary>
/// <remarks>
/// The legacy input names <c>answer</c> and <c>slot</c> are accepted here, at the loading
/// boundary, and nowhere else. They are never written back: the canonical form is
/// <c>text</c>/<c>field</c>, so the prohibited vocabulary cannot leak into an artifact.
/// </remarks>
internal sealed class ScriptedStimulusJsonConverter : JsonConverter<ScriptedStimulus>
{
    /// <summary>
    /// Gets a value indicating that a null is handed to this converter rather than bound.
    /// </summary>
    /// <remarks>
    /// Element nullability inside a collection is not enforced by the serializer, so without this
    /// a <c>[null]</c> entry becomes a null sitting in a list whose element type says it cannot
    /// be, and the failure surfaces as a dereference somewhere downstream.
    /// </remarks>
    public override bool HandleNull => true;

    public override ScriptedStimulus Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.Null)
        {
            throw new JsonException("A scripted stimulus must not be null.");
        }

        if (reader.TokenType == JsonTokenType.String)
        {
            return Create(reader.GetString(), field: null);
        }

        if (reader.TokenType != JsonTokenType.StartObject)
        {
            throw new JsonException("A scripted stimulus must be a string, or an object with a 'text' property.");
        }

        string? text = null;
        string? field = null;
        string? textDeclaredAs = null;
        string? fieldDeclaredAs = null;

        while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
        {
            var name = reader.GetString();
            reader.Read();

            if (JsonReaderGuard.IsAnyOf(name, "text", "answer"))
            {
                JsonReaderGuard.Claim(ref textDeclaredAs, name);
                text = JsonReaderGuard.ReadString(ref reader, "text");
            }
            else if (JsonReaderGuard.IsAnyOf(name, "field", "slot"))
            {
                JsonReaderGuard.Claim(ref fieldDeclaredAs, name);
                field = JsonReaderGuard.ReadString(ref reader, "field");
            }
            else
            {
                reader.Skip();
            }
        }

        return Create(text, field);
    }

    public override void Write(Utf8JsonWriter writer, ScriptedStimulus value, JsonSerializerOptions options)
    {
        ArgumentNullException.ThrowIfNull(writer);

        if (value is null)
        {
            // Writing the null would produce an artifact this converter then refuses to read.
            throw new JsonException("A scripted stimulus must not be null.");
        }

        if (value.Field is null)
        {
            writer.WriteStringValue(value.Text);
            return;
        }

        writer.WriteStartObject();
        writer.WriteString("text", value.Text);
        writer.WriteString("field", value.Field);
        writer.WriteEndObject();
    }

    /// <summary>
    /// Builds a stimulus, refusing anything the participant could not actually send.
    /// </summary>
    /// <remarks>
    /// A blank entry still occupies a slot in the script, so it would be counted into
    /// <see cref="Simulation.ScriptedTurnBudget"/> and widen the budget the overrun guard trusts —
    /// approving an assertion for a turn the script cannot drive. It is refused here, at the
    /// boundary it arrives on.
    /// </remarks>
    private static ScriptedStimulus Create(string? text, string? field)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            throw new JsonException(
                "A scripted stimulus requires non-blank 'text'. A blank one drives no turn, but would still be "
                    + "counted as one."
            );
        }

        if (field is not null && string.IsNullOrWhiteSpace(field))
        {
            throw new JsonException("'field' must name a field when it is declared; omit it instead of blanking it.");
        }

        return new ScriptedStimulus { Text = text, Field = field };
    }
}

/// <summary>
/// Reads the simulated caller's material, mapping the legacy <c>scriptedAnswers</c> and
/// <c>answerPool</c> input names onto the kind-neutral core vocabulary.
/// </summary>
/// <remarks>
/// This is the only place those names are understood. Keeping the mapping at the boundary is what
/// lets a suite written for the origin harness still load without that harness's assumptions
/// reaching the core types a REST scenario also flows through.
/// </remarks>
internal sealed class SimulationJsonConverter : JsonConverter<Simulation>
{
    public override Simulation Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.StartObject)
        {
            throw new JsonException("A simulation must be a JSON object.");
        }

        string? opening = null;
        IReadOnlyList<string>? facts = null;
        IReadOnlyList<string>? stimulusPool = null;
        IReadOnlyList<ScriptedStimulus>? scriptedStimuli = null;
        string? openingDeclaredAs = null;
        string? factsDeclaredAs = null;
        string? poolDeclaredAs = null;
        string? scriptDeclaredAs = null;

        while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
        {
            var name = reader.GetString();
            reader.Read();

            if (JsonReaderGuard.IsAnyOf(name, "opening"))
            {
                JsonReaderGuard.Claim(ref openingDeclaredAs, name);
                opening = JsonReaderGuard.ReadString(ref reader, "opening");
            }
            else if (JsonReaderGuard.IsAnyOf(name, "facts"))
            {
                JsonReaderGuard.Claim(ref factsDeclaredAs, name);
                facts = JsonReaderGuard.ReadTextArray(ref reader, "facts", options);
            }
            else if (JsonReaderGuard.IsAnyOf(name, "stimulusPool", "answerPool"))
            {
                JsonReaderGuard.Claim(ref poolDeclaredAs, name);
                stimulusPool = JsonReaderGuard.ReadTextArray(ref reader, "stimulusPool", options);
            }
            else if (JsonReaderGuard.IsAnyOf(name, "scriptedStimuli", "scriptedAnswers"))
            {
                JsonReaderGuard.Claim(ref scriptDeclaredAs, name);
                scriptedStimuli = JsonReaderGuard.ReadList<ScriptedStimulus>(ref reader, "scriptedStimuli", options);
            }
            else
            {
                reader.Skip();
            }
        }

        return new Simulation
        {
            Opening = opening,
            // An omitted property takes the empty default. An explicitly null one never reaches
            // here — it is refused above, because it is a declaration that cannot be honoured
            // rather than a way of saying "nothing".
            Facts = facts ?? [],
            StimulusPool = stimulusPool ?? [],
            ScriptedStimuli = scriptedStimuli ?? [],
        };
    }

    public override void Write(Utf8JsonWriter writer, Simulation value, JsonSerializerOptions options)
    {
        ArgumentNullException.ThrowIfNull(writer);
        ArgumentNullException.ThrowIfNull(value);

        writer.WriteStartObject();

        if (value.Opening is not null)
        {
            writer.WriteString("opening", value.Opening);
        }

        WriteArray(writer, "facts", value.Facts, options);
        WriteArray(writer, "stimulusPool", value.StimulusPool, options);
        WriteArray(writer, "scriptedStimuli", value.ScriptedStimuli, options);

        writer.WriteEndObject();
    }

    private static void WriteArray<T>(
        Utf8JsonWriter writer,
        string propertyName,
        IReadOnlyList<T> items,
        JsonSerializerOptions options
    )
    {
        writer.WritePropertyName(propertyName);
        JsonSerializer.Serialize(writer, items, options);
    }
}

/// <summary>
/// Reads an assertion written either as a bare expression string or as an object carrying the
/// turn it depends on.
/// </summary>
internal sealed class AssertionSpecJsonConverter : JsonConverter<AssertionSpec>
{
    /// <summary>
    /// Gets a value indicating that a null is handed to this converter rather than bound.
    /// </summary>
    /// <remarks>
    /// A null in <c>grading.assertions</c> otherwise reaches the script-overrun guard as a
    /// dereference, which escapes a loader documented to return its problems as findings.
    /// </remarks>
    public override bool HandleNull => true;

    public override AssertionSpec Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.Null)
        {
            throw new JsonException("An assertion must not be null.");
        }

        if (reader.TokenType == JsonTokenType.String)
        {
            return Parse(reader.GetString());
        }

        if (reader.TokenType != JsonTokenType.StartObject)
        {
            throw new JsonException(
                "An assertion must be an expression string, or an object with an 'expression' property."
            );
        }

        string? expression = null;
        int? turn = null;
        string? expressionDeclaredAs = null;
        string? turnDeclaredAs = null;

        while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
        {
            var name = reader.GetString();
            reader.Read();

            if (string.Equals(name, "expression", StringComparison.OrdinalIgnoreCase))
            {
                JsonReaderGuard.Claim(ref expressionDeclaredAs, name);
                expression = JsonReaderGuard.ReadString(ref reader, "expression");
            }
            else if (string.Equals(name, "turn", StringComparison.OrdinalIgnoreCase))
            {
                JsonReaderGuard.Claim(ref turnDeclaredAs, name);
                turn = JsonReaderGuard.ReadInt32(ref reader, "turn");
            }
            else
            {
                reader.Skip();
            }
        }

        var spec = Parse(expression);

        if (turn is null)
        {
            return spec;
        }

        try
        {
            return spec with { TurnDependency = turn };
        }
        catch (ArgumentOutOfRangeException exception)
        {
            throw new JsonException(exception.Message);
        }
    }

    public override void Write(Utf8JsonWriter writer, AssertionSpec value, JsonSerializerOptions options)
    {
        ArgumentNullException.ThrowIfNull(writer);

        if (value is null)
        {
            // Writing the null would produce an artifact this converter then refuses to read.
            throw new JsonException("An assertion must not be null.");
        }

        if (value.TurnDependency is null)
        {
            writer.WriteStringValue(value.ToExpression());
            return;
        }

        writer.WriteStartObject();
        writer.WriteString("expression", value.ToExpression());
        writer.WriteNumber("turn", value.TurnDependency.Value);
        writer.WriteEndObject();
    }

    private static AssertionSpec Parse(string? expression) =>
        AssertionSpec.TryParse(expression, out var spec, out var error) ? spec : throw new JsonException(error);
}

/// <summary>
/// Reads a repetition policy written as <c>"once"</c>, as a count, or as an object.
/// </summary>
internal sealed class RepetitionPolicyJsonConverter : JsonConverter<RepetitionPolicy>
{
    public override RepetitionPolicy Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        switch (reader.TokenType)
        {
            case JsonTokenType.String:
                var literal = reader.GetString();
                return string.Equals(literal, "once", StringComparison.OrdinalIgnoreCase)
                    ? RepetitionPolicy.Once
                    : throw new JsonException(
                        $"'{literal}' is not a valid repetition policy. Use \"once\", or a count of one or more."
                    );

            case JsonTokenType.Number:
                return Repeat(JsonReaderGuard.ReadInt32(ref reader, "repetitionPolicy"));

            case JsonTokenType.StartObject:
                int? repetitions = null;
                string? repetitionsDeclaredAs = null;
                while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
                {
                    var name = reader.GetString();
                    reader.Read();

                    if (string.Equals(name, "repetitions", StringComparison.OrdinalIgnoreCase))
                    {
                        JsonReaderGuard.Claim(ref repetitionsDeclaredAs, name);
                        repetitions = JsonReaderGuard.ReadInt32(ref reader, "repetitions");
                    }
                    else
                    {
                        reader.Skip();
                    }
                }

                return repetitions is null
                    ? throw new JsonException("A repetition policy object requires a 'repetitions' property.")
                    : Repeat(repetitions.Value);

            default:
                throw new JsonException(
                    "A repetition policy must be \"once\", a count, or an object with a 'repetitions' property."
                );
        }
    }

    public override void Write(Utf8JsonWriter writer, RepetitionPolicy value, JsonSerializerOptions options)
    {
        ArgumentNullException.ThrowIfNull(writer);
        ArgumentNullException.ThrowIfNull(value);

        writer.WriteNumberValue(value.Repetitions);
    }

    private static RepetitionPolicy Repeat(int repetitions)
    {
        try
        {
            return RepetitionPolicy.Repeat(repetitions);
        }
        catch (ArgumentOutOfRangeException exception)
        {
            throw new JsonException(exception.Message);
        }
    }
}

/// <summary>
/// Turns malformed values into <see cref="JsonException"/> rather than letting the reader's own
/// <see cref="InvalidOperationException"/> escape, so every boundary failure looks the same to a
/// caller.
/// </summary>
internal static class JsonReaderGuard
{
    public static bool IsAnyOf(string? propertyName, params string[] candidates) =>
        candidates.Any(candidate => string.Equals(propertyName, candidate, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Records that a property has been supplied, and refuses a second name for the same one.
    /// </summary>
    /// <param name="declaredAs">The name this property was already declared under, if any.</param>
    /// <param name="propertyName">The name now being read.</param>
    /// <remarks>
    /// A canonical name and its legacy alias both present is ambiguous, and letting the later one
    /// win discards authored material silently — which surfaces much later as an eval result
    /// nobody can explain, rather than as an error at the boundary where it can still be fixed.
    /// </remarks>
    /// <exception cref="JsonException">The property was already supplied.</exception>
    public static void Claim(ref string? declaredAs, string? propertyName)
    {
        if (declaredAs is null)
        {
            declaredAs = propertyName ?? string.Empty;
            return;
        }

        throw new JsonException(
            string.Equals(declaredAs, propertyName, StringComparison.OrdinalIgnoreCase)
                ? $"'{propertyName}' is declared more than once."
                : $"'{declaredAs}' and '{propertyName}' are two names for the same property. Declare only one."
        );
    }

    public static string? ReadString(ref Utf8JsonReader reader, string propertyName) =>
        reader.TokenType switch
        {
            JsonTokenType.String => reader.GetString(),
            JsonTokenType.Null => null,
            _ => throw new JsonException($"'{propertyName}' must be a string."),
        };

    /// <summary>Reads an array of text, refusing any entry that carries nothing.</summary>
    /// <param name="reader">The reader, positioned on the array.</param>
    /// <param name="propertyName">The canonical property name, used in the failure message.</param>
    /// <param name="options">The serializer options.</param>
    /// <returns>The entries.</returns>
    /// <remarks>
    /// Element nullability inside a collection is not enforced by the serializer, so a null entry
    /// would otherwise sit in a list whose element type says it cannot, and a blank one would be
    /// carried as material the participant can never send.
    /// </remarks>
    /// <exception cref="JsonException">
    /// The property is the literal null, or an entry is null, empty, or whitespace.
    /// </exception>
    public static IReadOnlyList<string> ReadTextArray(
        ref Utf8JsonReader reader,
        string propertyName,
        JsonSerializerOptions options
    )
    {
        var entries = ReadList<string?>(ref reader, propertyName, options);
        var validated = new List<string>(entries.Count);

        foreach (var entry in entries)
        {
            if (string.IsNullOrWhiteSpace(entry))
            {
                throw new JsonException($"'{propertyName}' must not contain a blank entry.");
            }

            validated.Add(entry);
        }

        return validated;
    }

    /// <summary>Reads a declared array, refusing the literal null.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="reader">The reader, positioned on the array.</param>
    /// <param name="propertyName">The canonical property name, used in the failure message.</param>
    /// <param name="options">The serializer options.</param>
    /// <returns>The entries.</returns>
    /// <remarks>
    /// Omitting a property and writing null into it are two different things an author can mean,
    /// and the properties read through here are declared as never being null. Omission takes the
    /// empty default at the point the record is built; a null arriving <i>here</i> was declared,
    /// and defaulting it would discard that declaration silently rather than say it cannot be
    /// honoured. Deserializing the null directly would do exactly that, since it yields the same
    /// <see langword="null"/> an absent property does.
    /// </remarks>
    /// <exception cref="JsonException">The property is the literal null.</exception>
    public static IReadOnlyList<T> ReadList<T>(
        ref Utf8JsonReader reader,
        string propertyName,
        JsonSerializerOptions options
    )
    {
        if (reader.TokenType == JsonTokenType.Null)
        {
            throw new JsonException(
                $"'{propertyName}' must not be null. Omit it, or declare an empty array, to say there is none."
            );
        }

        return JsonSerializer.Deserialize<IReadOnlyList<T>>(ref reader, options) ?? [];
    }

    public static int ReadInt32(ref Utf8JsonReader reader, string propertyName) =>
        reader.TokenType == JsonTokenType.Number && reader.TryGetInt32(out var value)
            ? value
            : throw new JsonException($"'{propertyName}' must be a whole number.");
}
