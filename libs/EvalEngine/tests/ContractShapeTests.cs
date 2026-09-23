using System.Reflection;
using FluentAssertions;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Tests;

/// <summary>
/// Structural rules the contracts have to keep holding, checked against the shipped surface
/// rather than against a comment that says they hold.
/// </summary>
public class ContractShapeTests
{
    private static IEnumerable<Type> ExportedTypes => typeof(Scenario).Assembly.GetExportedTypes();

    // ---------------------------------------------------------------------------------------
    // The core carries no one domain's vocabulary.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public void PublicSurface_Always_UsesStimulusVocabularyRatherThanQuestionAnswerVocabulary()
    {
        string[] prohibited = ["answer", "question"];

        var offenders = new List<string>();
        foreach (var type in ExportedTypes)
        {
            if (prohibited.Any(word => type.Name.Contains(word, StringComparison.OrdinalIgnoreCase)))
            {
                offenders.Add(type.FullName!);
            }

            var members = type.GetMembers(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static)
                .Where(m => m.DeclaringType == type)
                .Select(m => m.Name);

            offenders.AddRange(
                members
                    .Where(name => prohibited.Any(word => name.Contains(word, StringComparison.OrdinalIgnoreCase)))
                    .Select(name => $"{type.FullName}.{name}")
            );
        }

        offenders
            .Should()
            .BeEmpty(
                "the core must not encode one domain's assumptions; a REST scenario flows through these same types"
            );
    }

    [Fact]
    public void Simulation_Always_NamesItsScriptedMaterialInStimulusTerms()
    {
        var names = typeof(Simulation).GetProperties().Select(p => p.Name).ToArray();

        names.Should().Contain("ScriptedStimuli").And.Contain("StimulusPool").And.Contain("Opening");
    }

    // ---------------------------------------------------------------------------------------
    // An assertion evaluator is stage-isolated and kind-blind by construction.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public void EvaluationContext_Always_ExposesNeitherTheScenarioNorItsKind()
    {
        var exposed = typeof(EvaluationContext).GetProperties().Select(p => p.PropertyType).ToArray();

        exposed
            .Should()
            .NotContain(typeof(Scenario), "an evaluator that can see the scenario can come to depend on its kind")
            .And.NotContain(typeof(ScenarioKind))
            .And.NotContain(typeof(Execution))
            .And.NotContain(typeof(ScenarioIdentity))
            .And.NotContain(typeof(Selection))
            .And.NotContain(typeof(Slicing));
    }

    [Fact]
    public void EvaluationContext_Always_ExposesTheGradingDataAndTheKindNeutralEvidence()
    {
        var properties = typeof(EvaluationContext).GetProperties().ToDictionary(p => p.Name, p => p.PropertyType);

        properties.Should().ContainKey("Grading").WhoseValue.Should().Be<Grading>();
        properties.Should().ContainKey("Transcript").WhoseValue.Should().Be<Transcript>();
        properties.Should().ContainKey("Baseline").WhoseValue.Should().Be<Transcript>();
        properties.Should().ContainKey("ScenarioId").WhoseValue.Should().Be<string>();
    }

    // ---------------------------------------------------------------------------------------
    // The significance seam cannot express an unpaired comparison.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public void PairedObservations_Always_CarriesMatchedObservationsRatherThanTwoParallelLists()
    {
        var properties = typeof(PairedObservations).GetProperties();

        properties
            .Should()
            .NotContain(
                p => p.PropertyType == typeof(IReadOnlyList<bool>),
                "two independent lists establish no matching by scenario or seed"
            );
    }

    [Fact]
    public void PairedObservation_Always_CarriesIdentitySeedAndANonBinaryStatistic()
    {
        var observation = typeof(PairedObservations).Assembly.GetType(
            "Forge.EvalEngine.Abstractions.PairedObservation"
        );

        observation.Should().NotBeNull("a paired bootstrap needs one matched record per scenario");

        var properties = observation!.GetProperties().ToDictionary(p => p.Name, p => p.PropertyType);
        properties.Should().ContainKey("ScenarioId").WhoseValue.Should().Be<string>();
        properties.Should().ContainKey("Seed").WhoseValue.Should().Be<long>();
        properties.Should().ContainKey("BaselineValue").WhoseValue.Should().Be<double>();
        properties.Should().ContainKey("CandidateValue").WhoseValue.Should().Be<double>();
    }

    [Fact]
    public void PairedObservations_Always_IsOnlyConstructibleThroughValidation()
    {
        typeof(PairedObservations)
            .GetConstructors(BindingFlags.Public | BindingFlags.Instance)
            .Should()
            .BeEmpty("an unvalidated set of observations must not be constructible");
    }

    // ---------------------------------------------------------------------------------------
    // The artifact stamps its own schema version.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public void SuiteResult_SchemaVersion_IsNotCallerSettable()
    {
        var property = typeof(SuiteResult).GetProperty(nameof(SuiteResult.SchemaVersion))!;

        property
            .CanWrite.Should()
            .BeFalse("a caller that can stamp any version can write an artifact that lies about its own shape");
    }

    // ---------------------------------------------------------------------------------------
    // Durable artifacts compare by value, not by collection reference.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public void SuiteResult_TwoArtifactsWithEqualValues_AreEqual()
    {
        TestData.SuiteResult().Should().Be(TestData.SuiteResult());
        (TestData.SuiteResult() == TestData.SuiteResult()).Should().BeTrue();
        TestData.SuiteResult().GetHashCode().Should().Be(TestData.SuiteResult().GetHashCode());
    }

    [Fact]
    public void SuiteResult_ArtifactsDifferingInAValue_AreNotEqual()
    {
        var changed = TestData.SuiteResult() with { SuiteName = "something-else" };

        TestData.SuiteResult().Should().NotBe(changed);
    }

    [Fact]
    public void Transcript_TwoTranscriptsWithEqualValues_AreEqual()
    {
        TestData.Transcript().Should().Be(TestData.Transcript());
        TestData.Transcript().GetHashCode().Should().Be(TestData.Transcript().GetHashCode());
    }

    [Fact]
    public void Transcript_TranscriptsDifferingInAValue_AreNotEqual()
    {
        TestData.Transcript().Should().NotBe(TestData.Transcript() with { Seed = 1 });
    }
}
