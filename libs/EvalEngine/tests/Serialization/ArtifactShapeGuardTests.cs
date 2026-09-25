using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using FluentAssertions;
using Forge.EvalEngine.Baselines;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Serialization;

namespace Forge.EvalEngine.Tests.Serialization;

/// <summary>
/// The shape guard on a durable artifact: a null sitting in a position the artifact's own types
/// declare as never being null.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why this is not covered by the nullable-annotation setting already in force.</b>
/// <c>RespectNullableAnnotations</c> is enforced for properties and constructor parameters only.
/// It says nothing about the <i>element</i> type of a collection or the <i>value</i> type of a
/// dictionary, so <c>"scenarioResults": [null]</c> binds a null into a list whose element type
/// says it cannot hold one, and the failure surfaces as a dereference somewhere downstream. The
/// suite-side converters already say exactly this in their own remarks; the artifact reader had
/// no equivalent.
/// </para>
/// <para>
/// <b>These artifacts are written to disk and read back through the real reader.</b> The refusal
/// that already existed for this case was written against an object constructed in memory, which
/// is a door production does not use: on the on-disk path the value is bound by the deserializer
/// first and reaches the engine's identifier check before any consumer-side guard.
/// </para>
/// </remarks>
public class ArtifactShapeGuardTests
{
    /// <summary>
    /// Every position in the artifact graph whose declared type forbids a null.
    /// </summary>
    /// <remarks>
    /// Enumerated from the type graph rather than from the one case that was reported. The
    /// reported case is the first row; the other seven were found by walking every collection and
    /// dictionary an artifact can carry.
    /// </remarks>
    public static TheoryData<string, string, string?> ForbiddenNulls() =>
        new()
        {
            { "scenarioResults[0]", "scenarioResults", "scenario #1" },
            { "slicingDimensions[0]", "slicingDimensions", "entry #1" },
            { "environment/harnessConfig/repetitions", "environment.harnessConfig", null },
            { "scenarioResults[0]/tags/area", "tags", "scenario #1" },
            { "scenarioResults[0]/runs[0]", "runs", "scenario #1, run #1" },
            { "scenarioResults[0]/runs[0]/assertionResults[0]", "assertionResults", "scenario #1, run #1, entry #1" },
            { "scenarioResults[0]/runs[0]/transcript/turns[0]", "transcript.turns", "scenario #1, run #1, entry #1" },
            {
                "scenarioResults[0]/runs[0]/transcript/transport/attributes/statusCode",
                "transcript.transport.attributes",
                "scenario #1, run #1"
            },
        };

    /// <summary>
    /// Every position where a null is the artifact's own way of saying "there was none".
    /// </summary>
    /// <remarks>
    /// <b>The reverse case matters at least as much as the forbidden one.</b> Turning a valid
    /// artifact into a refusal is worse than the crash it prevents, because the crash is loud and
    /// the refusal will be believed. <c>Outcome.Fields</c> is the decisive row: it is declared
    /// <c>IReadOnlyDictionary&lt;string, string?&gt;</c> while every other dictionary in the graph
    /// is declared with a non-nullable value, so the distinction is one the types already draw on
    /// purpose.
    /// </remarks>
    public static TheoryData<string> PermittedNulls() =>
        new()
        {
            "scenarioResults[0]/runs[0]/transcript/outcome/fields/escalateReason",
            "scenarioResults[0]/summary",
            "scenarioResults[0]/definitionFingerprint",
            "scenarioResults[0]/runs[0]/errorDetail",
            "scenarioResults[0]/runs[0]/assertionResults[0]/detail",
            "scenarioResults[0]/runs[0]/transcript/turns[0]/response",
            "scenarioResults[0]/runs[0]/transcript/outcome/observedOutcome",
            "scenarioResults[0]/runs[0]/transcript/outcome/observedPath",
            "scenarioResults[0]/runs[0]/transcript/transport/kind",
            "scenarioResults[0]/runs[0]/transcript/transport/endpoint",
            "environment/endpoint",
            "environment/baselineRef",
        };

    /// <summary>
    /// The reported defect, on the path production actually uses.
    /// </summary>
    /// <remarks>
    /// The artifact is written to a real file and read back through <see cref="ArtifactBaseline"/>
    /// — the engine's on-disk reader — rather than constructed in memory. Before the guard this
    /// threw <see cref="NullReferenceException"/> from the identifier check, which the consuming
    /// tool does not classify as an unreadable artifact, so it reached the defect handler and
    /// printed a stack trace carrying the checkout path.
    /// </remarks>
    [Fact]
    public async Task TryGetBaselineAsync_ScenarioResultsCarriesANullEntry_RefusesItRatherThanDereferencingIt()
    {
        var root = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName());
        Directory.CreateDirectory(root);

        try
        {
            await File.WriteAllTextAsync(
                Path.Combine(root, "baseline.json"),
                Mutated("scenarioResults[0]"),
                CancellationToken.None
            );

            var load = () => new ArtifactBaseline(root).TryGetBaselineAsync("baseline.json", CancellationToken.None);

            var thrown = (await load.Should().ThrowAsync<MalformedArtifactException>()).Which;
            thrown.Field.Should().Be("scenarioResults");
            thrown.Position.Should().Be("scenario #1");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Theory]
    [MemberData(nameof(ForbiddenNulls))]
    public void DeserializeSuiteResult_ANullWhereTheShapeForbidsOne_RefusesItNamingTheFieldAndPosition(
        string locator,
        string field,
        string? position
    )
    {
        var read = () => CanonicalJson.DeserializeSuiteResult(Mutated(locator));

        var thrown = read.Should().Throw<MalformedArtifactException>().Which;
        thrown.Field.Should().Be(field);
        thrown.Position.Should().Be(position);
    }

    [Theory]
    [MemberData(nameof(PermittedNulls))]
    public void DeserializeSuiteResult_ANullWhereTheShapeAllowsOne_ReadsIt(string locator)
    {
        var read = () => CanonicalJson.DeserializeSuiteResult(Mutated(locator));

        read.Should().NotThrow();
    }

    /// <summary>
    /// A refusal is an unreadable artifact, which is a category every existing reader already
    /// classifies. Deriving from <see cref="JsonException"/> is what keeps that true without the
    /// consuming tool having to learn a new type.
    /// </summary>
    [Fact]
    public void DeserializeSuiteResult_ANullEntry_ThrowsAJsonExceptionSoExistingReadersClassifyItAsUnreadable()
    {
        var read = () => CanonicalJson.DeserializeSuiteResult(Mutated("scenarioResults[0]"));

        read.Should().Throw<JsonException>();
    }

    /// <summary>The position is the entry's own place, not the first one in the collection.</summary>
    [Fact]
    public void DeserializeSuiteResult_ANullRunInTheSecondScenario_NamesBothPositions()
    {
        var read = () => CanonicalJson.DeserializeSuiteResult(Mutated("scenarioResults[1]/runs[0]", scenarios: 2));

        var thrown = read.Should().Throw<MalformedArtifactException>().Which;
        thrown.Field.Should().Be("runs");
        thrown.Position.Should().Be("scenario #2, run #1");
        thrown.Message.Should().Contain("scenario #2, run #1");
    }

    /// <summary>
    /// The refusal names the field and the position, and nothing the author wrote.
    /// </summary>
    /// <remarks>
    /// A tag key is author-supplied and reaches the same build log the refusal does, so naming it
    /// would move a disclosure rather than remove one — the rule ADR 0005 settled for every other
    /// message on this path. A dictionary has no stable order either, so an ordinal would send a
    /// reader to the wrong entry.
    /// </remarks>
    [Fact]
    public void DeserializeSuiteResult_ANullTagValue_NamesNeitherTheKeyNorTheValue()
    {
        var json = JsonNode.Parse(Artifact())!.AsObject();
        json["scenarioResults"]![0]!["tags"]!.AsObject()["/home/ci-user/repo"] = null;

        var read = () => CanonicalJson.DeserializeSuiteResult(json.ToJsonString());

        var thrown = read.Should().Throw<MalformedArtifactException>().Which;
        thrown.Field.Should().Be("tags");
        thrown.Message.Should().NotContain("/home/ci-user");
    }

    /// <summary>
    /// The shape guard runs before the identifier guard, because the identifier guard is what a
    /// null entry crashes.
    /// </summary>
    /// <remarks>
    /// Ordering rather than preference: the identifier check indexes into the scenario list and
    /// reads <c>ScenarioId</c> off each entry. Nothing is disclosed by going first — the shape
    /// refusal names only field names this engine owns and an integer position.
    /// </remarks>
    [Fact]
    public void DeserializeSuiteResult_ANullEntryBesideAMachinePath_RefusesTheShapeWithoutDereferencingIt()
    {
        var json = JsonNode.Parse(Artifact(scenarios: 2))!.AsObject();
        json["scenarioResults"]![1]!["scenarioId"] = "/home/ci-user/repo";
        json["scenarioResults"]!.AsArray()[0] = null;

        var read = () => CanonicalJson.DeserializeSuiteResult(json.ToJsonString());

        var thrown = read.Should().Throw<MalformedArtifactException>().Which;
        thrown.Field.Should().Be("scenarioResults");
        thrown.Message.Should().NotContain("/home/ci-user");
    }

    /// <summary>The generic entry point carries the same guard as the named one.</summary>
    [Fact]
    public void Deserialize_SuiteResultWithANullEntry_Refuses()
    {
        var read = () => CanonicalJson.Deserialize<SuiteResult>(Mutated("scenarioResults[0]"));

        read.Should().Throw<MalformedArtifactException>();
    }

    /// <summary>
    /// An artifact this engine wrote still reads back.
    /// </summary>
    /// <remarks>
    /// The guard against the guard. A rule that refuses artifacts the engine itself produces
    /// would be a false green with extra steps — the run would be refused and believed.
    /// </remarks>
    [Fact]
    public void DeserializeSuiteResult_AnArtifactThisEngineWrote_ReadsItBack()
    {
        var read = () => CanonicalJson.DeserializeSuiteResult(Artifact());

        read.Should().NotThrow();
    }

    private static string Artifact(int scenarios = 1)
    {
        var json = JsonNode.Parse(CanonicalJson.Serialize(TestData.SuiteResult()))!.AsObject();
        var results = json["scenarioResults"]!.AsArray();

        for (var index = 1; index < scenarios; index++)
        {
            var clone = results[0]!.DeepClone();
            clone["scenarioId"] = "scenario-" + index.ToString(CultureInfo.InvariantCulture);
            results.Add(clone);
        }

        return json.ToJsonString();
    }

    /// <summary>Writes a null at <paramref name="locator"/> in an otherwise valid artifact.</summary>
    private static string Mutated(string locator, int scenarios = 1)
    {
        var root = JsonNode.Parse(Artifact(scenarios))!.AsObject();
        JsonNode current = root;
        var segments = locator.Split('/');

        for (var index = 0; index < segments.Length; index++)
        {
            var segment = segments[index];
            var last = index == segments.Length - 1;
            var bracket = segment.IndexOf('[', StringComparison.Ordinal);

            if (bracket < 0)
            {
                if (last)
                {
                    current.AsObject()[segment] = null;
                    break;
                }

                current = current.AsObject()[segment]!;
                continue;
            }

            var array = current.AsObject()[segment[..bracket]]!.AsArray();
            var position = int.Parse(segment[(bracket + 1)..^1], CultureInfo.InvariantCulture);

            if (last)
            {
                array[position] = null;
                break;
            }

            current = array[position]!;
        }

        return root.ToJsonString();
    }
}
