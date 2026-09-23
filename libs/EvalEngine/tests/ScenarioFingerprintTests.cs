using FluentAssertions;
using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Scenarios;

namespace Forge.EvalEngine.Tests;

/// <summary>
/// What makes two artifacts agree that they ran the same scenario.
/// </summary>
/// <remarks>
/// The fingerprint exists because the emitted assertion specs do not carry the values they are
/// checked against. Each test here mutates one part of a definition and asserts the fingerprint
/// moved — a fingerprint that did not move is a redefinition the comparator would report as a
/// fix the change earned.
/// </remarks>
public sealed class ScenarioFingerprintTests
{
    [Fact]
    public void Of_TheSameDefinitionTwice_ProducesTheSameFingerprint()
    {
        ScenarioFingerprint.Of(Scenario()).Should().Be(ScenarioFingerprint.Of(Scenario()));
    }

    [Fact]
    public void Of_Always_NamesTheDigestItUsed()
    {
        ScenarioFingerprint.Of(Scenario()).Should().MatchRegex("^sha256:[0-9a-f]{64}$");
    }

    [Fact]
    public void Of_ExpectedOutcomeChangedWhileTheAssertionSpecIsUnchanged_ProducesADifferentFingerprint()
    {
        // The exact fabrication: the spec `exactMatch:outcome` is identical on both sides and
        // only the value it compares against moved.
        var before = Scenario(grading: GradingFor("escalated"));
        var after = Scenario(grading: GradingFor("resolved"));

        ScenarioFingerprint.Of(before).Should().NotBe(ScenarioFingerprint.Of(after));
    }

    [Fact]
    public void Of_ExpectedPathChanged_ProducesADifferentFingerprint()
    {
        var before = Scenario(grading: GradingFor("resolved", expectedPath: "triage/resolve"));
        var after = Scenario(grading: GradingFor("resolved", expectedPath: "triage/escalate"));

        ScenarioFingerprint.Of(before).Should().NotBe(ScenarioFingerprint.Of(after));
    }

    [Fact]
    public void Of_AssertionSetChanged_ProducesADifferentFingerprint()
    {
        var before = Scenario(grading: GradingFor("resolved", assertions: ["exactMatch:outcome"]));
        var after = Scenario(grading: GradingFor("resolved", assertions: ["exactMatch:outcome", "slotAbsent:scope"]));

        ScenarioFingerprint.Of(before).Should().NotBe(ScenarioFingerprint.Of(after));
    }

    [Fact]
    public void Of_OpeningStimulusChanged_ProducesADifferentFingerprint()
    {
        // What the system was asked is an execution input. A different question answered the
        // same way is not the same evidence.
        var before = Scenario(simulation: new Simulation { Opening = "cancel my order" });
        var after = Scenario(simulation: new Simulation { Opening = "refund my order" });

        ScenarioFingerprint.Of(before).Should().NotBe(ScenarioFingerprint.Of(after));
    }

    [Fact]
    public void Of_ScriptedStimuliChanged_ProducesADifferentFingerprint()
    {
        var before = Scenario(
            simulation: new Simulation
            {
                Opening = "cancel my order",
                ScriptedStimuli = [new ScriptedStimulus { Text = "yes, please" }],
            }
        );
        var after = Scenario(
            simulation: new Simulation
            {
                Opening = "cancel my order",
                ScriptedStimuli = [new ScriptedStimulus { Text = "no, thanks" }],
            }
        );

        ScenarioFingerprint.Of(before).Should().NotBe(ScenarioFingerprint.Of(after));
    }

    [Fact]
    public void Of_ExecutionModeChanged_ProducesADifferentFingerprint()
    {
        var before = Scenario(execution: new Execution { Mode = ExecutionMode.Deterministic });
        var after = Scenario(execution: new Execution { Mode = ExecutionMode.Simulated });

        ScenarioFingerprint.Of(before).Should().NotBe(ScenarioFingerprint.Of(after));
    }

    [Fact]
    public void Of_RepetitionPolicyChanged_ProducesADifferentFingerprint()
    {
        var before = Scenario(
            execution: new Execution { Mode = ExecutionMode.Deterministic, RepetitionPolicy = RepetitionPolicy.Once }
        );
        var after = Scenario(
            execution: new Execution
            {
                Mode = ExecutionMode.Deterministic,
                RepetitionPolicy = RepetitionPolicy.Repeat(5),
            }
        );

        ScenarioFingerprint.Of(before).Should().NotBe(ScenarioFingerprint.Of(after));
    }

    [Fact]
    public void Of_OnlyTheReportingLabelsChanged_ProducesTheSameFingerprint()
    {
        // Renaming a description or re-tagging a scenario for slicing does not change what was
        // asked or what counts as correct, so it must not sever a comparison.
        var before = Scenario();
        var after = before with
        {
            Identity = before.Identity with { Description = "a rewritten description", ProbeClass = "regression" },
            Slicing = new Slicing
            {
                Tags = new Dictionary<string, string>(StringComparer.Ordinal) { ["area"] = "scope" },
            },
            Selection = new Selection { ImpactGlobs = ["src/**/*.cs"] },
        };

        ScenarioFingerprint.Of(before).Should().Be(ScenarioFingerprint.Of(after));
    }

    [Fact]
    public void Of_NullScenario_Refuses()
    {
        var act = () => ScenarioFingerprint.Of(null!);

        act.Should().Throw<ArgumentNullException>();
    }

    private static Grading GradingFor(
        string expectedOutcome,
        string? expectedPath = null,
        IEnumerable<string>? assertions = null
    ) =>
        new()
        {
            ExpectedOutcome = expectedOutcome,
            ExpectedPath = expectedPath,
            Assertions = [.. (assertions ?? ["exactMatch:outcome"]).Select(AssertionSpec.Parse)],
        };

    private static Scenario Scenario(
        Execution? execution = null,
        Simulation? simulation = null,
        Grading? grading = null
    ) =>
        new()
        {
            Identity = new ScenarioIdentity { Id = "a", Kind = ScenarioKind.Rest },
            Execution = execution ?? new Execution { Mode = ExecutionMode.Deterministic },
            Simulation = simulation ?? new Simulation { Opening = "cancel my order" },
            Grading = grading ?? GradingFor("resolved"),
        };
}
