using System.Text.Json;
using FluentAssertions;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Serialization;

namespace Forge.EvalEngine.Tests.Serialization;

public class CanonicalJsonTests
{
    [Fact]
    public void Serialize_AnyDocument_OrdersObjectKeysOrdinallyAtEveryLevel()
    {
        var json = CanonicalJson.Serialize(TestData.SuiteResult());

        using var document = JsonDocument.Parse(json);
        AssertKeysAreOrdered(document.RootElement, "$");
    }

    [Fact]
    public void Serialize_ArrayMembers_PreservesTheirOrder()
    {
        var result = TestData.SuiteResult() with { SlicingDimensions = ["zulu", "alpha", "mike"] };

        var json = CanonicalJson.Serialize(result);

        using var document = JsonDocument.Parse(json);
        document
            .RootElement.GetProperty("slicingDimensions")
            .EnumerateArray()
            .Select(e => e.GetString())
            .Should()
            .Equal("zulu", "alpha", "mike");
    }

    [Fact]
    public void Serialize_SameValueTwice_ProducesIdenticalText()
    {
        CanonicalJson.Serialize(TestData.SuiteResult()).Should().Be(CanonicalJson.Serialize(TestData.SuiteResult()));
    }

    [Fact]
    public void Serialize_DocumentsDifferingOnlyInKeyOrder_ProduceIdenticalText()
    {
        var canonical = CanonicalJson.Serialize(TestData.SuiteResult());
        var shuffled = ShuffleKeys(canonical);

        var reordered = CanonicalJson.Serialize(CanonicalJson.Deserialize<SuiteResult>(shuffled)!);

        reordered.Should().Be(canonical);
    }

    [Fact]
    public void Serialize_SuiteResult_RoundTripsExactly()
    {
        var original = CanonicalJson.Serialize(TestData.SuiteResult());

        var roundTripped = CanonicalJson.Serialize(CanonicalJson.Deserialize<SuiteResult>(original)!);

        roundTripped.Should().Be(original);
    }

    [Fact]
    public void Deserialize_SuiteResult_RestoresEveryValue()
    {
        var expected = TestData.SuiteResult();

        var actual = CanonicalJson.Deserialize<SuiteResult>(CanonicalJson.Serialize(expected));

        actual.Should().BeEquivalentTo(expected);
    }

    [Fact]
    public void Serialize_SuiteResult_StampsTheSchemaVersion()
    {
        var json = CanonicalJson.Serialize(TestData.SuiteResult());

        using var document = JsonDocument.Parse(json);
        document.RootElement.GetProperty("schemaVersion").GetString().Should().Be(SchemaVersions.SuiteResult);
    }

    // -------------------------------------------------------------------------------------------
    // Version discipline: stamped on write, checked on read.
    // -------------------------------------------------------------------------------------------

    [Fact]
    public void DeserializeSuiteResult_ArtifactAtTheSupportedVersion_RestoresIt()
    {
        var json = CanonicalJson.Serialize(TestData.SuiteResult());

        var restored = CanonicalJson.DeserializeSuiteResult(json);

        restored.SuiteName.Should().Be("regression-suite");
        restored.SchemaVersion.Should().Be(SchemaVersions.SuiteResult);
    }

    [Theory]
    [InlineData("2.0")]
    [InlineData("0.9")]
    [InlineData("1.1")]
    [InlineData("not-a-version")]
    public void DeserializeSuiteResult_UnsupportedVersion_ThrowsSchemaVersionException(string version)
    {
        var json = CanonicalJson
            .Serialize(TestData.SuiteResult())
            .Replace(
                $"\"schemaVersion\": \"{SchemaVersions.SuiteResult}\"",
                $"\"schemaVersion\": \"{version}\"",
                StringComparison.Ordinal
            );

        Action deserialize = () => CanonicalJson.DeserializeSuiteResult(json);

        deserialize.Should().Throw<SchemaVersionException>().Which.DeclaredVersion.Should().Be(version);
    }

    [Fact]
    public void DeserializeSuiteResult_NoVersionAtAll_ThrowsSchemaVersionException()
    {
        var json =
            """{ "suiteName": "unversioned", "environment": { "seed": 1, "timestamp": "2026-09-22T00:00:00+00:00" } }""";

        Action deserialize = () => CanonicalJson.DeserializeSuiteResult(json);

        deserialize.Should().Throw<SchemaVersionException>();
    }

    [Fact]
    public void DeserializeSuiteResult_MalformedJson_ThrowsJsonException()
    {
        Action deserialize = () => CanonicalJson.DeserializeSuiteResult("{ not json");

        deserialize.Should().Throw<JsonException>();
    }

    [Fact]
    public void DeserializeSuiteResult_NullJson_ThrowsArgumentNullException()
    {
        Action deserialize = () => CanonicalJson.DeserializeSuiteResult(null!);

        deserialize.Should().Throw<ArgumentNullException>();
    }

    [Theory]
    [InlineData("2.0")]
    [InlineData("1.1")]
    [InlineData("not-a-version")]
    public void Deserialize_SuiteResultDeclaringAnUnsupportedVersion_ThrowsThroughTheGenericEntryPointToo(
        string version
    )
    {
        // SchemaVersion is stamped rather than bound, so a generic read of a future artifact
        // returns one labelled with today's version and the warning disappears. Every public way
        // in has to carry the same guard.
        var json = CanonicalJson
            .Serialize(TestData.SuiteResult())
            .Replace(
                $"\"schemaVersion\": \"{SchemaVersions.SuiteResult}\"",
                $"\"schemaVersion\": \"{version}\"",
                StringComparison.Ordinal
            );

        Action deserialize = () => CanonicalJson.Deserialize<SuiteResult>(json);

        deserialize.Should().Throw<SchemaVersionException>().Which.DeclaredVersion.Should().Be(version);
    }

    [Fact]
    public void Deserialize_SuiteResultWithNoVersionAtAll_ThrowsThroughTheGenericEntryPointToo()
    {
        var json =
            """{ "suiteName": "unversioned", "environment": { "seed": 1, "timestamp": "2026-09-22T00:00:00+00:00" } }""";

        Action deserialize = () => CanonicalJson.Deserialize<SuiteResult>(json);

        deserialize.Should().Throw<SchemaVersionException>();
    }

    // -------------------------------------------------------------------------------------------
    // Canonical value comparison — the thing a comparator actually needs.
    // -------------------------------------------------------------------------------------------

    [Fact]
    public void AreEquivalent_TwoArtifactsWithEqualValues_IsTrue()
    {
        CanonicalJson.AreEquivalent(TestData.SuiteResult(), TestData.SuiteResult()).Should().BeTrue();
    }

    [Fact]
    public void AreEquivalent_ArtifactsDifferingInANestedValue_IsFalse()
    {
        var changed = TestData.SuiteResult();
        changed = changed with { ScenarioResults = [changed.ScenarioResults[0] with { ScenarioId = "scenario-b" }] };

        CanonicalJson.AreEquivalent(TestData.SuiteResult(), changed).Should().BeFalse();
    }

    [Fact]
    public void AreEquivalent_ValuesDifferingOnlyInCollectionIdentity_IsTrue()
    {
        var left = TestData.Transcript();
        var right = TestData.Transcript();

        ReferenceEquals(left.Turns, right.Turns).Should().BeFalse();
        CanonicalJson.AreEquivalent(left, right).Should().BeTrue();
    }

    [Fact]
    public void AreEquivalent_BothNull_IsTrue()
    {
        CanonicalJson.AreEquivalent<SuiteResult>(null, null).Should().BeTrue();
    }

    [Fact]
    public void AreEquivalent_OneNull_IsFalse()
    {
        CanonicalJson.AreEquivalent(TestData.SuiteResult(), null).Should().BeFalse();
        CanonicalJson.AreEquivalent(null, TestData.SuiteResult()).Should().BeFalse();
    }

    [Fact]
    public void Serialize_UnsetStatisticalFields_AreAbsentRatherThanNull()
    {
        var summary = new StatisticalSummary
        {
            N = 5,
            PointEstimate = 0.8,
            Dispersion = 0.4,
        };

        var json = CanonicalJson.Serialize(summary);

        using var document = JsonDocument.Parse(json);
        document.RootElement.TryGetProperty("interval", out _).Should().BeFalse();
        document.RootElement.TryGetProperty("comparison", out _).Should().BeFalse();
        json.Should().NotContain("null");
    }

    [Fact]
    public void Serialize_UnsetComparisonFields_AreAbsentRatherThanNull()
    {
        var summary = new StatisticalSummary
        {
            N = 5,
            PointEstimate = 0.8,
            Dispersion = 0.4,
            Comparison = new ComparisonSummary { EffectSize = -0.2 },
        };

        var json = CanonicalJson.Serialize(summary);

        using var document = JsonDocument.Parse(json);
        var comparison = document.RootElement.GetProperty("comparison");
        comparison.TryGetProperty("pValue", out _).Should().BeFalse();
        comparison.TryGetProperty("adjustedPValue", out _).Should().BeFalse();
        comparison.TryGetProperty("test", out _).Should().BeFalse();
        comparison.GetProperty("significant").GetString().Should().Be("notComputed");
    }

    [Fact]
    public void Serialize_PopulatedStatisticalFields_AreWritten()
    {
        var summary = new StatisticalSummary
        {
            N = 40,
            PointEstimate = 0.75,
            Dispersion = 0.43,
            Interval = new ConfidenceInterval
            {
                Lower = 0.6,
                Upper = 0.86,
                Method = IntervalMethod.Wilson,
            },
            Comparison = new ComparisonSummary
            {
                EffectSize = -0.1,
                PValue = 0.03,
                AdjustedPValue = 0.06,
                Test = SignificanceTestKind.McNemar,
                Significant = SignificanceVerdict.NotSignificant,
            },
        };

        var json = CanonicalJson.Serialize(summary);

        using var document = JsonDocument.Parse(json);
        document.RootElement.GetProperty("interval").GetProperty("method").GetString().Should().Be("wilson");
        document.RootElement.GetProperty("comparison").GetProperty("test").GetString().Should().Be("mcNemar");
    }

    [Fact]
    public void Serialize_Enum_WritesACamelCaseStringRatherThanAnOrdinal()
    {
        var json = CanonicalJson.Serialize(TestData.SuiteResult());

        using var document = JsonDocument.Parse(json);
        document.RootElement.GetProperty("scenarioResults")[0].GetProperty("kind").GetString().Should().Be("llm");
    }

    [Fact]
    public void Serialize_AnyDocument_UsesLineFeedNewLinesOnEveryPlatform()
    {
        CanonicalJson.Serialize(TestData.SuiteResult()).Should().NotContain("\r");
    }

    [Fact]
    public void Deserialize_MalformedJson_ThrowsJsonException()
    {
        Action deserialize = () => CanonicalJson.Deserialize<SuiteResult>("{ not json");

        deserialize.Should().Throw<JsonException>();
    }

    [Fact]
    public void Deserialize_NullJson_ThrowsArgumentNullException()
    {
        Action deserialize = () => CanonicalJson.Deserialize<SuiteResult>(null!);

        deserialize.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Serialize_RepetitionPolicy_WritesTheCount()
    {
        var json = CanonicalJson.Serialize(TestData.SuiteResult());

        using var document = JsonDocument.Parse(json);
        document
            .RootElement.GetProperty("scenarioResults")[0]
            .GetProperty("repetitionPolicyUsed")
            .GetInt32()
            .Should()
            .Be(5);
    }

    [Fact]
    public void Deserialize_RepetitionPolicyWrittenAsCount_RestoresThePolicy()
    {
        var restored = CanonicalJson.Deserialize<SuiteResult>(CanonicalJson.Serialize(TestData.SuiteResult()))!;

        restored.ScenarioResults[0].RepetitionPolicyUsed.Repetitions.Should().Be(5);
    }

    private static void AssertKeysAreOrdered(JsonElement element, string path)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                var keys = element.EnumerateObject().Select(p => p.Name).ToArray();
                keys.Should()
                    .BeInAscendingOrder(StringComparer.Ordinal, $"object at {path} must have ordinally ordered keys");
                foreach (var property in element.EnumerateObject())
                {
                    AssertKeysAreOrdered(property.Value, $"{path}.{property.Name}");
                }

                break;
            case JsonValueKind.Array:
                var index = 0;
                foreach (var item in element.EnumerateArray())
                {
                    AssertKeysAreOrdered(item, $"{path}[{index++}]");
                }

                break;
            default:
                break;
        }
    }

    private static string ShuffleKeys(string json)
    {
        using var document = JsonDocument.Parse(json);
        return Reverse(document.RootElement);

        static string Reverse(JsonElement element)
        {
            switch (element.ValueKind)
            {
                case JsonValueKind.Object:
                    var members = element
                        .EnumerateObject()
                        .Reverse()
                        .Select(p => $"{JsonSerializer.Serialize(p.Name)}:{Reverse(p.Value)}");
                    return $"{{{string.Join(",", members)}}}";
                case JsonValueKind.Array:
                    return $"[{string.Join(",", element.EnumerateArray().Select(Reverse))}]";
                default:
                    return element.GetRawText();
            }
        }
    }
}
