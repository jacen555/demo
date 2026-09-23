using System.Text.Json;
using FluentAssertions;
using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Serialization;

namespace Forge.EvalEngine.Tests.Serialization;

public class ScriptedStimulusConverterTests
{
    [Fact]
    public void Deserialize_BareString_ProducesAStimulusWithNoField()
    {
        var stimulus = CanonicalJson.Deserialize<ScriptedStimulus>("\"yes please\"")!;

        stimulus.Text.Should().Be("yes please");
        stimulus.Field.Should().BeNull();
    }

    [Fact]
    public void Deserialize_ObjectForm_ProducesTheTextAndTheField()
    {
        var stimulus = CanonicalJson.Deserialize<ScriptedStimulus>(
            """{ "text": "yes please", "field": "scope/confirm" }"""
        )!;

        stimulus.Text.Should().Be("yes please");
        stimulus.Field.Should().Be("scope/confirm");
    }

    [Fact]
    public void Deserialize_LegacyAnswerAndSlotNames_AreAcceptedAtTheLoadingBoundary()
    {
        var stimulus = CanonicalJson.Deserialize<ScriptedStimulus>(
            """{ "answer": "yes please", "slot": "scope/confirm" }"""
        )!;

        stimulus.Text.Should().Be("yes please");
        stimulus.Field.Should().Be("scope/confirm");
    }

    [Fact]
    public void Serialize_StimulusWithNoField_WritesABareString()
    {
        CanonicalJson.Serialize(new ScriptedStimulus { Text = "yes please" }).Should().Be("\"yes please\"");
    }

    [Fact]
    public void Serialize_StimulusWithAField_WritesTheNeutralNamesOnly()
    {
        var json = CanonicalJson.Serialize(new ScriptedStimulus { Text = "yes", Field = "scope/confirm" });

        using var document = JsonDocument.Parse(json);
        document.RootElement.GetProperty("text").GetString().Should().Be("yes");
        document.RootElement.GetProperty("field").GetString().Should().Be("scope/confirm");
        json.Should().NotContain("answer").And.NotContain("slot");
    }

    [Theory]
    [InlineData("\"bare\"")]
    [InlineData("""{ "text": "with field", "field": "scope/confirm" }""")]
    [InlineData("""{ "answer": "legacy", "slot": "scope/confirm" }""")]
    public void Serialize_AfterDeserialize_RoundTripsEveryForm(string json)
    {
        var stimulus = CanonicalJson.Deserialize<ScriptedStimulus>(json)!;

        CanonicalJson.Deserialize<ScriptedStimulus>(CanonicalJson.Serialize(stimulus)).Should().Be(stimulus);
    }

    [Fact]
    public void Deserialize_ObjectMissingTheText_ThrowsJsonException()
    {
        Action deserialize = () => CanonicalJson.Deserialize<ScriptedStimulus>("""{ "field": "scope/confirm" }""");

        deserialize.Should().Throw<JsonException>();
    }

    [Fact]
    public void Deserialize_UnsupportedTokenKind_ThrowsJsonException()
    {
        Action deserialize = () => CanonicalJson.Deserialize<ScriptedStimulus>("42");

        deserialize.Should().Throw<JsonException>();
    }

    // -------------------------------------------------------------------------------------------
    // A scripted entry is counted into the turn budget the overrun guard trusts, so an entry the
    // participant could never actually send must be refused here rather than inflating it.
    // -------------------------------------------------------------------------------------------

    [Fact]
    public void Deserialize_NullLiteral_ThrowsJsonException()
    {
        Action deserialize = () => CanonicalJson.Deserialize<ScriptedStimulus>("null");

        deserialize.Should().Throw<JsonException>();
    }

    [Theory]
    [InlineData("\"\"")]
    [InlineData("\"   \"")]
    [InlineData("\"\\t\"")]
    public void Deserialize_BlankBareString_ThrowsJsonException(string json)
    {
        Action deserialize = () => CanonicalJson.Deserialize<ScriptedStimulus>(json);

        deserialize.Should().Throw<JsonException>();
    }

    [Theory]
    [InlineData("""{ "text": "" }""")]
    [InlineData("""{ "text": "   " }""")]
    [InlineData("""{ "text": null }""")]
    public void Deserialize_BlankText_ThrowsJsonException(string json)
    {
        Action deserialize = () => CanonicalJson.Deserialize<ScriptedStimulus>(json);

        deserialize.Should().Throw<JsonException>();
    }

    [Fact]
    public void Deserialize_BlankField_ThrowsJsonException()
    {
        Action deserialize = () => CanonicalJson.Deserialize<ScriptedStimulus>("""{ "text": "yes", "field": "  " }""");

        deserialize.Should().Throw<JsonException>();
    }

    [Theory]
    [InlineData("""{ "text": "canonical", "answer": "legacy" }""")]
    [InlineData("""{ "text": "yes", "field": "canonical", "slot": "legacy" }""")]
    [InlineData("""{ "text": "first", "text": "second" }""")]
    public void Deserialize_ConflictingNamesForTheSameProperty_ThrowsJsonException(string json)
    {
        Action deserialize = () => CanonicalJson.Deserialize<ScriptedStimulus>(json);

        deserialize.Should().Throw<JsonException>();
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void Construct_BlankText_ThrowsArgumentException(string? text)
    {
        Action construct = () => _ = new ScriptedStimulus { Text = text! };

        construct.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void Serialize_NullStimulus_ThrowsJsonExceptionRatherThanWritingANull()
    {
        // Accepting the null on the way out would write an artifact this library then refuses to
        // read. Every boundary failure should look the same to a caller, so it is a JsonException
        // like the read side.
        Action serialize = () => CanonicalJson.Serialize(new Simulation { ScriptedStimuli = [null!] });

        serialize.Should().Throw<JsonException>();
    }
}

public class SimulationConverterTests
{
    [Fact]
    public void Deserialize_NeutralNames_PopulatesTheMaterial()
    {
        var simulation = CanonicalJson.Deserialize<Simulation>(
            """
            {
              "opening": "GET /health",
              "facts": ["order 42 exists"],
              "stimulusPool": ["yes", "no"],
              "scriptedStimuli": ["one", "two"]
            }
            """
        )!;

        simulation.Opening.Should().Be("GET /health");
        simulation.Facts.Should().Equal("order 42 exists");
        simulation.StimulusPool.Should().Equal("yes", "no");
        simulation.ScriptedStimuli.Select(s => s.Text).Should().Equal("one", "two");
    }

    [Fact]
    public void Deserialize_LegacyAnswerNames_AreAcceptedAtTheLoadingBoundary()
    {
        var simulation = CanonicalJson.Deserialize<Simulation>(
            """
            {
              "opening": "hello",
              "answerPool": ["yes", "no"],
              "scriptedAnswers": ["one", "two"]
            }
            """
        )!;

        simulation.StimulusPool.Should().Equal("yes", "no");
        simulation.ScriptedStimuli.Select(s => s.Text).Should().Equal("one", "two");
    }

    [Fact]
    public void Serialize_AnySimulation_WritesTheNeutralNamesOnly()
    {
        var json = CanonicalJson.Serialize(
            new Simulation
            {
                Opening = "hello",
                StimulusPool = ["yes"],
                ScriptedStimuli = [new ScriptedStimulus { Text = "one" }],
            }
        );

        json.Should().NotContain("answer").And.Contain("stimulusPool").And.Contain("scriptedStimuli");
    }

    [Fact]
    public void ScriptedTurnBudget_OpeningAndScript_CountsTheOpeningAsTheFirstTurn()
    {
        var simulation = new Simulation
        {
            Opening = "hello",
            ScriptedStimuli = [new ScriptedStimulus { Text = "one" }, new ScriptedStimulus { Text = "two" }],
        };

        simulation.ScriptedTurnBudget.Should().Be(3);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void ScriptedTurnBudget_NoOpening_CountsOnlyTheScript(string? opening)
    {
        var simulation = new Simulation
        {
            Opening = opening,
            ScriptedStimuli = [new ScriptedStimulus { Text = "one" }],
        };

        simulation.ScriptedTurnBudget.Should().Be(1);
    }

    [Fact]
    public void ScriptedTurnBudget_NothingScripted_IsZero()
    {
        new Simulation().ScriptedTurnBudget.Should().Be(0);
    }

    [Fact]
    public void Deserialize_UnsupportedTokenKind_ThrowsJsonException()
    {
        Action deserialize = () => CanonicalJson.Deserialize<Simulation>("42");

        deserialize.Should().Throw<JsonException>();
    }

    // -------------------------------------------------------------------------------------------
    // A canonical name and its legacy alias both present is ambiguous. Letting the last one win
    // silently discards authored script material, which surfaces later as a baffling eval result
    // rather than as an error.
    // -------------------------------------------------------------------------------------------

    [Theory]
    [InlineData("""{ "scriptedStimuli": ["canonical"], "scriptedAnswers": ["legacy"] }""")]
    [InlineData("""{ "stimulusPool": ["canonical"], "answerPool": ["legacy"] }""")]
    [InlineData("""{ "opening": "first", "opening": "second" }""")]
    public void Deserialize_ConflictingNamesForTheSameProperty_ThrowsJsonException(string json)
    {
        Action deserialize = () => CanonicalJson.Deserialize<Simulation>(json);

        deserialize.Should().Throw<JsonException>();
    }

    [Theory]
    [InlineData("""{ "scriptedStimuli": [null] }""")]
    [InlineData("""{ "scriptedStimuli": ["  "] }""")]
    [InlineData("""{ "facts": ["real", null] }""")]
    [InlineData("""{ "stimulusPool": ["yes", "   "] }""")]
    public void Deserialize_AnEntryThatCannotBeUsed_ThrowsJsonException(string json)
    {
        Action deserialize = () => CanonicalJson.Deserialize<Simulation>(json);

        deserialize.Should().Throw<JsonException>();
    }

    [Fact]
    public void ScriptedTurnBudget_AnEntryThatCannotDriveATurn_IsNotCounted()
    {
        // The guard trusts this number, so it counts turns the script can actually drive — not
        // entries that merely occupy a slot in the list.
        var simulation = new Simulation
        {
            Opening = "hello",
            ScriptedStimuli = [new ScriptedStimulus { Text = "one" }, null!],
        };

        simulation.ScriptedTurnBudget.Should().Be(2);
    }

    // -------------------------------------------------------------------------------------------
    // Leaving a property out and writing null into it are two different things an author can
    // mean, and these collections are declared as never being null. Omission takes the empty
    // default; an explicit null is a declaration that cannot be honoured, so it is refused rather
    // than quietly rewritten into an empty list — the same answer a null *entry* already gets.
    // -------------------------------------------------------------------------------------------

    [Theory]
    [InlineData("""{ "facts": null }""")]
    [InlineData("""{ "stimulusPool": null }""")]
    [InlineData("""{ "answerPool": null }""")]
    [InlineData("""{ "scriptedStimuli": null }""")]
    [InlineData("""{ "scriptedAnswers": null }""")]
    public void Deserialize_ExplicitlyNullCollection_ThrowsJsonException(string json)
    {
        Action deserialize = () => CanonicalJson.Deserialize<Simulation>(json);

        deserialize.Should().Throw<JsonException>();
    }

    [Fact]
    public void Deserialize_OmittedCollections_AreStillEmptyRatherThanRefused()
    {
        var simulation = CanonicalJson.Deserialize<Simulation>("""{ "opening": "GET /health" }""")!;

        simulation.Facts.Should().BeEmpty();
        simulation.StimulusPool.Should().BeEmpty();
        simulation.ScriptedStimuli.Should().BeEmpty();
    }

    [Fact]
    public void Deserialize_ExplicitlyEmptyCollections_AreAccepted()
    {
        var simulation = CanonicalJson.Deserialize<Simulation>(
            """{ "facts": [], "stimulusPool": [], "scriptedStimuli": [] }"""
        )!;

        simulation.Facts.Should().BeEmpty();
        simulation.StimulusPool.Should().BeEmpty();
        simulation.ScriptedStimuli.Should().BeEmpty();
    }
}

public class AssertionSpecConverterTests
{
    [Fact]
    public void Deserialize_BareExpression_ParsesIt()
    {
        var spec = CanonicalJson.Deserialize<AssertionSpec>("\"slotAbsent:scope/confirm\"")!;

        spec.Category.Should().Be("slotAbsent");
        spec.Parameter.Should().Be("scope/confirm");
        spec.TurnDependency.Should().BeNull();
    }

    [Fact]
    public void Deserialize_ObjectForm_ParsesTheExpressionAndTheTurn()
    {
        var spec = CanonicalJson.Deserialize<AssertionSpec>("""{ "expression": "reachedDepth:4", "turn": 4 }""")!;

        spec.Category.Should().Be("reachedDepth");
        spec.Parameter.Should().Be("4");
        spec.TurnDependency.Should().Be(4);
    }

    [Fact]
    public void Serialize_SpecWithNoTurnDependency_WritesABareExpression()
    {
        CanonicalJson
            .Serialize(AssertionSpec.Parse("slotAbsent:scope/confirm"))
            .Should()
            .Be("\"slotAbsent:scope/confirm\"");
    }

    [Fact]
    public void Serialize_SpecWithATurnDependency_WritesAnObject()
    {
        var spec = AssertionSpec.Parse("reachedDepth:4") with { TurnDependency = 4 };

        var json = CanonicalJson.Serialize(spec);

        using var document = JsonDocument.Parse(json);
        document.RootElement.GetProperty("expression").GetString().Should().Be("reachedDepth:4");
        document.RootElement.GetProperty("turn").GetInt32().Should().Be(4);
    }

    [Theory]
    [InlineData("\"slotAbsent:scope/confirm\"")]
    [InlineData("\"!slotAbsent:scope/confirm\"")]
    [InlineData("""{ "expression": "reachedDepth:4", "turn": 4 }""")]
    public void Serialize_AfterDeserialize_RoundTripsBothForms(string json)
    {
        var spec = CanonicalJson.Deserialize<AssertionSpec>(json)!;

        CanonicalJson.Deserialize<AssertionSpec>(CanonicalJson.Serialize(spec)).Should().Be(spec);
    }

    [Fact]
    public void Deserialize_MalformedExpression_ThrowsJsonException()
    {
        Action deserialize = () => CanonicalJson.Deserialize<AssertionSpec>("\":no-category\"");

        deserialize.Should().Throw<JsonException>();
    }

    [Fact]
    public void Deserialize_ObjectMissingTheExpression_ThrowsJsonException()
    {
        Action deserialize = () => CanonicalJson.Deserialize<AssertionSpec>("""{ "turn": 3 }""");

        deserialize.Should().Throw<JsonException>();
    }

    [Fact]
    public void Deserialize_NullLiteral_ThrowsJsonException()
    {
        // A null assertion reaches the grading validator as a dereference rather than a finding,
        // so it is refused at the boundary where it arrives.
        Action deserialize = () => CanonicalJson.Deserialize<AssertionSpec>("null");

        deserialize.Should().Throw<JsonException>();
    }

    [Theory]
    [InlineData("""{ "expression": "statusIs:200", "expression": "statusIs:404" }""")]
    [InlineData("""{ "expression": "statusIs:200", "turn": 1, "turn": 2 }""")]
    public void Deserialize_TheSamePropertyTwice_ThrowsJsonException(string json)
    {
        Action deserialize = () => CanonicalJson.Deserialize<AssertionSpec>(json);

        deserialize.Should().Throw<JsonException>();
    }

    [Fact]
    public void Serialize_NullAssertion_ThrowsJsonExceptionRatherThanWritingANull()
    {
        Action serialize = () => CanonicalJson.Serialize(new Grading { Assertions = [null!] });

        serialize.Should().Throw<JsonException>();
    }
}

public class RepetitionPolicyConverterTests
{
    [Fact]
    public void Deserialize_OnceKeyword_ProducesASingleRepetition()
    {
        CanonicalJson.Deserialize<RepetitionPolicy>("\"once\"")!.IsOnce.Should().BeTrue();
    }

    [Fact]
    public void Deserialize_Count_ProducesThatManyRepetitions()
    {
        CanonicalJson.Deserialize<RepetitionPolicy>("25")!.Repetitions.Should().Be(25);
    }

    [Fact]
    public void Deserialize_ObjectForm_ProducesThatManyRepetitions()
    {
        CanonicalJson.Deserialize<RepetitionPolicy>("""{ "repetitions": 7 }""")!.Repetitions.Should().Be(7);
    }

    [Fact]
    public void Serialize_AnyPolicy_WritesTheCount()
    {
        CanonicalJson.Serialize(RepetitionPolicy.Repeat(7)).Should().Be("7");
        CanonicalJson.Serialize(RepetitionPolicy.Once).Should().Be("1");
    }

    [Theory]
    [InlineData("0")]
    [InlineData("-4")]
    [InlineData("\"twice\"")]
    [InlineData("true")]
    [InlineData("""{ "repetitions": 0 }""")]
    [InlineData("""{ "repetitions": 1, "repetitions": 5 }""")]
    public void Deserialize_InvalidPolicy_ThrowsJsonException(string json)
    {
        Action deserialize = () => CanonicalJson.Deserialize<RepetitionPolicy>(json);

        deserialize.Should().Throw<JsonException>();
    }
}
