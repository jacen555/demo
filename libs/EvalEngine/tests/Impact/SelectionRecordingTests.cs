using FluentAssertions;
using Forge.EvalEngine.Impact;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Serialization;

namespace Forge.EvalEngine.Tests.Impact;

/// <summary>
/// The selector's decision reaching the durable artifact, and surviving read-back.
/// </summary>
/// <remarks>
/// <para>
/// A <see cref="SuiteResult"/> used to carry the scenarios that ran and nothing about the ones
/// that did not, so a consumer reading it could not tell a scenario the selector <b>skipped</b>
/// from one that was never in the suite, nor either from one the suite declared and the run
/// failed to produce. Those are different facts with different consequences: a skip is a
/// deliberate economy, an absence is a suite change, and a selected scenario missing from the
/// results is a harness that lost work.
/// </para>
/// <para>
/// The distinction <see cref="Comparison.ScenarioClassification.Removed"/> rests on is the same
/// one: a scenario the <i>suite</i> no longer declares really was removed, and a scenario the
/// selector merely skipped was not. Recording the decision is what lets a reader of the artifact
/// alone tell them apart.
/// </para>
/// </remarks>
public class SelectionRecordingTests
{
    private static Suite Suite(params string[] ids) =>
        ImpactFixtures.SuiteOf([.. ids.Select(id => ImpactFixtures.Declaring(id, "src/" + id + "/**"))]);

    private static SelectionDecision DecisionFor(SuiteResult artifact, string scenarioId) =>
        artifact
            .SelectionDecisions.Should()
            .NotBeNull()
            .And.ContainSingle(entry => entry.ScenarioId == scenarioId)
            .Subject.Decision;

    // -----------------------------------------------------------------------------------------
    // The projection: every scenario the selector was offered gets a decision.
    // -----------------------------------------------------------------------------------------

    [Fact]
    public void ToDecisions_SelectorSkippedOne_RecordsADecisionForEveryScenarioItWasOffered()
    {
        var suite = Suite("alpha", "bravo");
        var baseline = ImpactFixtures.Artifact([
            .. suite.Scenarios.Select(scenario => ImpactFixtures.Recorded(scenario, [RunStatus.Pass])),
        ]);

        var selection = ImpactSelector.Select(suite, ["src/alpha/handler.cs"], baseline);

        selection.Skipped.Should().Equal("bravo");
        selection
            .ToDecisions()
            .Should()
            .BeEquivalentTo(
                new[]
                {
                    new RecordedSelection { ScenarioId = "alpha", Decision = SelectionDecision.Selected },
                    new RecordedSelection { ScenarioId = "bravo", Decision = SelectionDecision.Skipped },
                }
            );
    }

    [Fact]
    public void ToDecisions_FullSuiteFallback_RecordsEveryScenarioAsSelected()
    {
        var suite = Suite("alpha", "bravo");

        var selection = ImpactSelector.Select(suite, ["   "]);

        selection.FellBackToFullSuite.Should().BeTrue();
        selection
            .ToDecisions()
            .Should()
            .OnlyContain(entry => entry.Decision == SelectionDecision.Selected)
            .And.HaveCount(2);
    }

    /// <summary>
    /// The decisions are a set, so their order carries nothing and is made canonical.
    /// </summary>
    /// <remarks>
    /// Ordered by identifier rather than by suite position, matching
    /// <see cref="SuiteResult.SlicingDimensions"/>. An artifact is read as a committed diff, and
    /// a field whose order tracked suite position would turn an unrelated reordering of the suite
    /// file into a diff across this whole list — the noise canonical serialization exists to stop.
    /// </remarks>
    [Fact]
    public void ToDecisions_SuiteReorderedWithoutAnyDecisionChanging_ProducesTheSameDecisions()
    {
        var forward = Suite("zulu", "alpha");
        var reversed = Suite("alpha", "zulu");
        var baseline = ImpactFixtures.Artifact([
            .. forward.Scenarios.Select(scenario => ImpactFixtures.Recorded(scenario, [RunStatus.Pass])),
        ]);

        var one = ImpactSelector.Select(forward, ["src/zulu/handler.cs"], baseline).ToDecisions();
        var other = ImpactSelector.Select(reversed, ["src/zulu/handler.cs"], baseline).ToDecisions();

        // The selected scenario sorts AFTER the skipped one, so the concatenation the projection
        // builds from ([selected..., skipped...]) and the canonical order genuinely disagree.
        // Matching them would let this pass whether or not anything was ordered at all.
        one.Should()
            .ContainSingle(entry => entry.Decision == SelectionDecision.Selected)
            .Which.ScenarioId.Should()
            .Be("zulu");
        one.Select(entry => entry.ScenarioId).Should().Equal("alpha", "zulu");
        one.Should().BeEquivalentTo(other, options => options.WithStrictOrdering());
    }

    // -----------------------------------------------------------------------------------------
    // The four states a consumer has to tell apart.
    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// A skipped scenario is distinguishable from one the suite never declared.
    /// </summary>
    /// <remarks>
    /// Both are absent from <see cref="SuiteResult.ScenarioResults"/>, which is exactly why the
    /// artifact could not previously separate them.
    /// </remarks>
    [Fact]
    public void SelectionDecisions_SkippedScenario_IsDistinguishableFromOneTheSuiteNeverDeclared()
    {
        var suite = Suite("ran", "skipped");
        var baseline = ImpactFixtures.Artifact([
            .. suite.Scenarios.Select(scenario => ImpactFixtures.Recorded(scenario, [RunStatus.Pass])),
        ]);
        var selection = ImpactSelector.Select(suite, ["src/ran/handler.cs"], baseline);

        var artifact = ImpactFixtures.Artifact(ImpactFixtures.Recorded(suite.Scenarios[0], [RunStatus.Pass])) with
        {
            SelectionDecisions = selection.ToDecisions(),
        };

        artifact.ScenarioResults.Should().ContainSingle().Which.ScenarioId.Should().Be("ran");
        DecisionFor(artifact, "skipped").Should().Be(SelectionDecision.Skipped);
        artifact.SelectionDecisions.Should().NotContain(entry => entry.ScenarioId == "never-declared");
    }

    /// <summary>
    /// A selected scenario missing from the results is distinguishable from a deliberate skip.
    /// </summary>
    /// <remarks>
    /// This is the state that previously had nowhere to live. A scenario the suite declares and
    /// the run genuinely failed to produce must not be quietly excused as a skip — that is a
    /// harness losing work, and it reads as silence.
    /// </remarks>
    [Fact]
    public void SelectionDecisions_SelectedScenarioAbsentFromTheResults_IsDistinguishableFromOneThatWasSkipped()
    {
        var suite = Suite("lost", "skipped");
        var baseline = ImpactFixtures.Artifact([
            .. suite.Scenarios.Select(scenario => ImpactFixtures.Recorded(scenario, [RunStatus.Pass])),
        ]);
        var selection = ImpactSelector.Select(suite, ["src/lost/handler.cs"], baseline);

        var artifact = ImpactFixtures.Artifact() with { SelectionDecisions = selection.ToDecisions() };

        artifact.ScenarioResults.Should().BeEmpty();
        DecisionFor(artifact, "lost").Should().Be(SelectionDecision.Selected);
        DecisionFor(artifact, "skipped").Should().Be(SelectionDecision.Skipped);
    }

    /// <summary>
    /// No selection recorded is not the same as a selection that skipped nothing.
    /// </summary>
    /// <remarks>
    /// An artifact written before this field existed, or by a run that made no selection at all,
    /// establishes nothing about absence. An empty-but-present list establishes that the selector
    /// ran and skipped no scenario. Collapsing them onto one empty list would let a reader draw
    /// the second conclusion from the first artifact.
    /// </remarks>
    [Fact]
    public void SelectionDecisions_ArtifactThatRecordedNoSelection_IsNullRatherThanEmpty()
    {
        ImpactFixtures.Artifact().SelectionDecisions.Should().BeNull();

        var recorded = ImpactFixtures.Artifact() with { SelectionDecisions = [] };

        recorded.SelectionDecisions.Should().NotBeNull().And.BeEmpty();
    }

    // -----------------------------------------------------------------------------------------
    // Serialization: additive, optional, and absent when unset.
    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// An unset selection serializes as absent, which is what keeps the schema version still.
    /// </summary>
    [Fact]
    public void Serialize_ArtifactWithNoSelectionRecorded_OmitsTheFieldAndKeepsTheSchemaVersion()
    {
        var json = CanonicalJson.Serialize(ImpactFixtures.Artifact());

        json.Should().NotContain("selectionDecisions");
        CanonicalJson.DeserializeSuiteResult(json).SchemaVersion.Should().Be(SchemaVersions.SuiteResult);
    }

    [Fact]
    public void DeserializeSuiteResult_ArtifactCarryingSelectionDecisions_RoundTripsEveryDecision()
    {
        var suite = Suite("ran", "skipped");
        var baseline = ImpactFixtures.Artifact([
            .. suite.Scenarios.Select(scenario => ImpactFixtures.Recorded(scenario, [RunStatus.Pass])),
        ]);
        var artifact = ImpactFixtures.Artifact(ImpactFixtures.Recorded(suite.Scenarios[0], [RunStatus.Pass])) with
        {
            SelectionDecisions = ImpactSelector.Select(suite, ["src/ran/handler.cs"], baseline).ToDecisions(),
        };

        var read = CanonicalJson.DeserializeSuiteResult(CanonicalJson.Serialize(artifact));

        read.SelectionDecisions.Should().BeEquivalentTo(artifact.SelectionDecisions);
        DecisionFor(read, "skipped").Should().Be(SelectionDecision.Skipped);
        DecisionFor(read, "ran").Should().Be(SelectionDecision.Selected);
    }

    [Fact]
    public void Equals_ArtifactsDifferingOnlyInASelectionDecision_AreNotEqual()
    {
        var selected = ImpactFixtures.Artifact() with
        {
            SelectionDecisions = [new RecordedSelection { ScenarioId = "a", Decision = SelectionDecision.Selected }],
        };
        var skipped = selected with
        {
            SelectionDecisions = [new RecordedSelection { ScenarioId = "a", Decision = SelectionDecision.Skipped }],
        };

        selected.Equals(skipped).Should().BeFalse();
        selected.Equals(ImpactFixtures.Artifact()).Should().BeFalse();
    }

    // -----------------------------------------------------------------------------------------
    // §V — this is a new surface, and it is guarded rather than inheriting a trade-off.
    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// A skipped scenario's identifier is guarded on read-back like every other identifier.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This is the reason the guard had to be extended rather than left alone. A skipped scenario
    /// has no <see cref="ScenarioResult"/>, so its identifier appears <b>nowhere else</b> in the
    /// artifact and has never been through the artifact-side check before. It is still rendered
    /// into a committed artifact and a published comment.
    /// </para>
    /// <para>
    /// ADR 0005 is explicit that a documented trade-off is scoped to the surfaces that existed
    /// when it was made. This is a new surface.
    /// </para>
    /// </remarks>
    [Theory]
    [InlineData("/home/ci-user/repo")]
    [InlineData(@"C:\Users\ci-user\repo")]
    [InlineData("checkout path:/home/ci-user/repo")]
    public void DeserializeSuiteResult_SkippedScenarioIdIsAMachinePath_ThrowsWithoutRepeatingTheValue(string id)
    {
        var json = CanonicalJson.Serialize(
            ImpactFixtures.Artifact() with
            {
                SelectionDecisions = [new RecordedSelection { ScenarioId = id, Decision = SelectionDecision.Skipped }],
            }
        );

        var read = () => CanonicalJson.DeserializeSuiteResult(json);

        var thrown = read.Should().Throw<UnsafeIdentifierException>().Which;
        thrown.Field.Should().Be("selectionDecisions");
        thrown.Message.Should().NotContain("ci-user").And.Contain("#1");
    }

    /// <summary>
    /// A route-shaped identifier still reads, exactly as it does everywhere else.
    /// </summary>
    /// <remarks>
    /// The guard is start-anchored and case-sensitive so that a legitimate REST route survives.
    /// A new surface that quietly applied a broader rule would destroy identifiers this one has
    /// always admitted.
    /// </remarks>
    [Theory]
    [InlineData("/api/v1/refund")]
    [InlineData("/users/{id}/orders")]
    public void DeserializeSuiteResult_RouteShapedSkippedScenarioId_ReadsIt(string id)
    {
        var json = CanonicalJson.Serialize(
            ImpactFixtures.Artifact() with
            {
                SelectionDecisions = [new RecordedSelection { ScenarioId = id, Decision = SelectionDecision.Skipped }],
            }
        );

        CanonicalJson
            .DeserializeSuiteResult(json)
            .SelectionDecisions.Should()
            .ContainSingle()
            .Which.ScenarioId.Should()
            .Be(id);
    }

    /// <summary>
    /// A null entry is refused as malformed rather than crashing the identifier check.
    /// </summary>
    /// <remarks>
    /// The serializer does not enforce non-nullability on a collection's element type, so
    /// <c>"selectionDecisions": [null]</c> binds cleanly into a list whose element type forbids
    /// one. Left unchecked it reaches the identifier guard as a
    /// <see cref="NullReferenceException"/>, which a consumer reports as a defect complete with a
    /// stack trace naming the machine it ran on.
    /// </remarks>
    [Fact]
    public void DeserializeSuiteResult_NullSelectionDecisionEntry_IsRefusedAsMalformed()
    {
        var json = """
            {
              "schemaVersion": "1.0",
              "suiteName": "regression",
              "scenarioResults": [],
              "selectionDecisions": [null],
              "environment": { "seed": 1, "timestamp": "1970-01-01T00:00:00+00:00" }
            }
            """;

        var read = () => CanonicalJson.DeserializeSuiteResult(json);

        read.Should().Throw<MalformedArtifactException>().Which.Field.Should().Be("selectionDecisions");
    }
}
