using FluentAssertions;
using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Comparison;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;

namespace Forge.EvalEngine.Tests.Comparison;

/// <summary>
/// The ways a well-formed pair of artifacts can still produce a delta nobody earned.
/// </summary>
/// <remarks>
/// Every test here is a fabrication that the id-level pairing checks let through: a scenario
/// redefined rather than fixed, a verdict established from evidence that was never paired, an
/// artifact whose own runs contradict it, and repetitions that are one observation wearing six
/// hats. <see cref="ComparisonResult.NewlyCovered"/> is what gets attached to a pull request, so
/// each of these is a claim about a change that the change did not make.
/// </remarks>
public sealed class SuiteComparatorIntegrityTests
{
    private const string ExpectsEscalated = "sha256:expects-escalated";
    private const string ExpectsResolved = "sha256:expects-resolved";

    // -----------------------------------------------------------------------------------------
    // The definition fingerprint: same id, same assertions, different expectations.
    // -----------------------------------------------------------------------------------------

    [Fact]
    public void Compare_GradingExpectationChangedWhileTheAssertionSpecIsUnchanged_IsNotComparableRatherThanFixed()
    {
        // The fabrication in full: keep `exactMatch:outcome`, edit grading.expectedOutcome, and
        // an unchanged system response flips Fail to Pass. The emitted specs are identical, so
        // nothing that compares only those can tell this from a fix the change earned.
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario(
                "a",
                [RunStatus.Fail],
                assertions: ["exactMatch:outcome"],
                definitionFingerprint: ExpectsEscalated
            ),
        ]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario(
                "a",
                [RunStatus.Pass],
                assertions: ["exactMatch:outcome"],
                definitionFingerprint: ExpectsResolved
            ),
        ]);

        var result = new SuiteComparator().Compare(baseline, candidate);
        var comparison = ComparisonFixtures.For(result, "a");

        comparison.Classification.Should().Be(ScenarioClassification.NotComparable);
        comparison.NotComparableReason.Should().Contain("'a'").And.Contain("redefined");
        result.NewlyCovered.Should().BeEmpty();
    }

    [Fact]
    public void Compare_DefinitionFingerprintsDiffer_ReportsEachSidesOwnOutcomeWithoutADelta()
    {
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Fail], definitionFingerprint: ExpectsEscalated),
        ]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Pass], definitionFingerprint: ExpectsResolved),
        ]);

        var comparison = ComparisonFixtures.For(ComparisonFixtures.WithStatistics().Compare(baseline, candidate), "a");

        comparison.BaselineOutcome.Should().Be(ScenarioOutcome.Failed);
        comparison.CandidateOutcome.Should().Be(ScenarioOutcome.Passed);
        comparison.Comparison.Should().BeNull();
        comparison.GradedPairs.Should().Be(0);
    }

    [Theory]
    [InlineData(null, ComparisonFixtures.DefaultFingerprint)]
    [InlineData(ComparisonFixtures.DefaultFingerprint, null)]
    [InlineData(null, null)]
    public void Compare_ScenarioWithoutADefinitionFingerprint_IsNotComparable(string? before, string? after)
    {
        // Absent is not "matches". An artifact that never stated what it was run against cannot
        // establish that it was run against the same thing.
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Fail], definitionFingerprint: before),
        ]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Pass], definitionFingerprint: after),
        ]);

        var result = new SuiteComparator().Compare(baseline, candidate);

        ComparisonFixtures.For(result, "a").Classification.Should().Be(ScenarioClassification.NotComparable);
        result.NewlyCovered.Should().BeEmpty();
    }

    [Fact]
    public void Compare_DefinitionFingerprintsMatch_StillComparesNormally()
    {
        // The guard must refuse a redefinition, not every comparison. Same fingerprint on both
        // sides is the ordinary case and still produces a delta.
        var baseline = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Fail)]);
        var candidate = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)]);

        var result = new SuiteComparator().Compare(baseline, candidate);

        ComparisonFixtures.For(result, "a").Classification.Should().Be(ScenarioClassification.Fixed);
        result.NewlyCovered.Should().Equal("a");
    }

    [Fact]
    public void Compare_DefinitionFingerprintsDiffer_SignalsTheRefusalOnce()
    {
        var logger = new RecordingComparatorLogger();
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Fail], definitionFingerprint: ExpectsEscalated),
        ]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Pass], definitionFingerprint: ExpectsResolved),
        ]);

        new SuiteComparator(null, null, SuiteComparator.DefaultSignificanceLevel, logger).Compare(baseline, candidate);

        logger.Entries.Should().ContainSingle().Which.Message.Should().Contain("redefined");
    }

    // -----------------------------------------------------------------------------------------
    // Outcomes come from every graded run, and a transition must be established by the pairing.
    // -----------------------------------------------------------------------------------------

    [Fact]
    public void Compare_CandidateFailsAGradedRunOutsideThePairedRepetitions_DoesNotReportItFixed()
    {
        // Baseline [Fail, Error] against candidate [Pass, Fail]. Restricting the outcome to the
        // mutually gradeable repetitions throws away the candidate's graded failure and reports
        // Fixed with CandidateOutcome.Passed, while the failure sits in plain sight.
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Fail, RunStatus.Error]),
        ]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Pass, RunStatus.Fail]),
        ]);

        var result = new SuiteComparator().Compare(baseline, candidate);
        var comparison = ComparisonFixtures.For(result, "a");

        comparison.CandidateOutcome.Should().Be(ScenarioOutcome.Failed);
        comparison.BaselineOutcome.Should().Be(ScenarioOutcome.Failed);
        comparison.Classification.Should().Be(ScenarioClassification.StableFail);
        result.NewlyCovered.Should().BeEmpty();
    }

    [Fact]
    public void Compare_FixVisibleOnlyAcrossUnpairedRepetitions_IsNotComparable()
    {
        // Baseline [Fail, Pass] against candidate [Error, Pass]. Every graded candidate run
        // passed and a graded baseline run failed, but the only repetition that could show the
        // transition was never graded on both sides — the "fix" would be baseline repetition one
        // read against candidate repetition two.
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Fail, RunStatus.Pass]),
        ]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Error, RunStatus.Pass]),
        ]);

        var result = new SuiteComparator().Compare(baseline, candidate);
        var comparison = ComparisonFixtures.For(result, "a");

        comparison.Classification.Should().Be(ScenarioClassification.NotComparable);
        comparison.NotComparableReason.Should().Contain("'a'").And.Contain("no repetition pair");
        result.NewlyCovered.Should().BeEmpty();
    }

    [Fact]
    public void Compare_RegressionVisibleOnlyAcrossUnpairedRepetitions_IsNotComparable()
    {
        // The mirror image: baseline [Pass, Error] against candidate [Pass, Fail]. The claim is
        // refused in the same direction, because a regression the pairing cannot establish is
        // the same fabrication pointed the other way.
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Pass, RunStatus.Error]),
        ]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Pass, RunStatus.Fail]),
        ]);

        var comparison = ComparisonFixtures.For(new SuiteComparator().Compare(baseline, candidate), "a");

        comparison.Classification.Should().Be(ScenarioClassification.NotComparable);
        comparison.BaselineOutcome.Should().Be(ScenarioOutcome.Passed);
        comparison.CandidateOutcome.Should().Be(ScenarioOutcome.Failed);
    }

    [Fact]
    public void Compare_FixEstablishedByAPairedRepetition_IsStillReportedFixed()
    {
        // Baseline [Fail, Fail] against candidate [Pass, Error]: repetition one is graded on
        // both sides and shows the transition, so the fix is earned and reported as such.
        //
        // The coverage claim is a separate question from the classification, and it is not
        // earned: the candidate passed the one repetition that produced a verdict, not the two
        // the suite asked for. Withheld by name rather than dropped.
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Fail, RunStatus.Fail]),
        ]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Pass, RunStatus.Error]),
        ]);

        var result = new SuiteComparator().Compare(baseline, candidate);

        ComparisonFixtures.For(result, "a").Classification.Should().Be(ScenarioClassification.Fixed);
        result.NewlyCovered.Should().BeEmpty();
        result.NewlyCoveredWithheld.Should().Equal("a");
    }

    // -----------------------------------------------------------------------------------------
    // An artifact is untrusted input: its runs must belong to it and agree with themselves.
    // -----------------------------------------------------------------------------------------

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void Compare_RunTranscriptNamesAnotherScenario_RefusesTheArtifact(bool inBaseline)
    {
        var misfiled = Scenario("a", Run(RunStatus.Pass, transcriptScenarioId: "b"));
        var honest = ComparisonFixtures.Scenario("a", RunStatus.Pass);

        var baseline = ComparisonFixtures.Artifact([inBaseline ? misfiled : honest]);
        var candidate = ComparisonFixtures.Artifact([inBaseline ? honest : misfiled]);

        var act = () => new SuiteComparator().Compare(baseline, candidate);

        act.Should().Throw<ArgumentException>().WithMessage("*'a'*'b'*");
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void Compare_PassingRunContradictsItsOwnAssertionVerdicts_RefusesTheArtifact(bool inBaseline)
    {
        // A run stamped Pass carrying a failed verdict claims coverage the evidence beside it
        // denies. Counted as a pass, it becomes a pass rate, a delta, and a merge decision.
        var contradictory = Scenario("a", Run(RunStatus.Pass, verdicts: [false]));
        var honest = ComparisonFixtures.Scenario("a", RunStatus.Fail);

        var baseline = ComparisonFixtures.Artifact([inBaseline ? contradictory : honest]);
        var candidate = ComparisonFixtures.Artifact([inBaseline ? honest : contradictory]);

        var act = () => new SuiteComparator().Compare(baseline, candidate);

        act.Should().Throw<ArgumentException>().WithMessage("*'a'*");
    }

    [Fact]
    public void Compare_PassingRunWithNoAssertionsAtAll_IsAccepted()
    {
        // A scenario that declares no assertions passes vacuously — it asserted nothing, and
        // nothing it asserted failed. The consistency guard must not turn that into a refusal.
        var baseline = ComparisonFixtures.Artifact([Scenario("a", Run(RunStatus.Pass, verdicts: []))]);
        var candidate = ComparisonFixtures.Artifact([Scenario("a", Run(RunStatus.Pass, verdicts: []))]);

        var result = new SuiteComparator().Compare(baseline, candidate);

        ComparisonFixtures.For(result, "a").Classification.Should().Be(ScenarioClassification.StablePass);
    }

    // -----------------------------------------------------------------------------------------
    // Repetitions driven from one seed are one observation, not several.
    // -----------------------------------------------------------------------------------------

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void Compare_ScenarioRepeatingOneSeedAcrossRepetitions_RefusesTheArtifact(bool inBaseline)
    {
        // Six repetitions from one seed are one observation recorded six times. Paired against
        // six of the other verdict they read as six discordant pairs, and the exact conditional
        // test returns 2 * (1/2)^6 = 0.03125 — a significant finding manufactured from a single
        // run of the system.
        long[] oneSeed = [7, 7, 7, 7, 7, 7];
        long[] distinct = [1, 2, 3, 4, 5, 6];

        var repeated = ComparisonFixtures.Scenario(
            "a",
            ComparisonFixtures.Repeated(inBaseline ? RunStatus.Fail : RunStatus.Pass, 6),
            seeds: oneSeed
        );
        var honest = ComparisonFixtures.Scenario(
            "a",
            ComparisonFixtures.Repeated(inBaseline ? RunStatus.Pass : RunStatus.Fail, 6),
            seeds: distinct
        );

        var baseline = ComparisonFixtures.Artifact([inBaseline ? repeated : honest]);
        var candidate = ComparisonFixtures.Artifact([inBaseline ? honest : repeated]);

        var act = () => ComparisonFixtures.WithStatistics().Compare(baseline, candidate);

        act.Should().Throw<ArgumentException>().WithMessage("*'a'*seed 7*");
    }

    [Fact]
    public void Compare_ScenarioPresentInOnlyOneArtifactRepeatingOneSeed_RefusesTheArtifact()
    {
        // A scenario the baseline never carried still reaches NewlyCovered on the strength of
        // its own runs, so its repetitions have to be independent too.
        var baseline = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", RunStatus.Pass),
            ComparisonFixtures.Scenario("b", ComparisonFixtures.Repeated(RunStatus.Pass, 3), seeds: [9, 9, 9]),
        ]);

        var act = () => new SuiteComparator().Compare(baseline, candidate);

        act.Should().Throw<ArgumentException>().WithMessage("*'b'*seed 9*");
    }

    [Fact]
    public void Compare_RepetitionsWithDistinctSeeds_AreStillCompared()
    {
        // The guard is about reused seeds, not about repeated verdicts: six distinct seeds are
        // six observations and the p-value stands.
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", ComparisonFixtures.Repeated(RunStatus.Fail, 6), seeds: [1, 2, 3, 4, 5, 6]),
        ]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", ComparisonFixtures.Repeated(RunStatus.Pass, 6), seeds: [1, 2, 3, 4, 5, 6]),
        ]);

        var comparison = ComparisonFixtures.For(ComparisonFixtures.WithStatistics().Compare(baseline, candidate), "a");

        comparison.Classification.Should().Be(ScenarioClassification.Fixed);
        comparison.Comparison!.PValue.Should().BeApproximately(0.03125, 1e-12);
    }

    // -----------------------------------------------------------------------------------------
    // Material.
    // -----------------------------------------------------------------------------------------

    private static ScenarioResult Scenario(string id, params RunResult[] runs) =>
        new()
        {
            ScenarioId = id,
            Kind = ScenarioKind.Rest,
            Runs = runs,
            RepetitionPolicyUsed = RepetitionPolicy.Repeat(runs.Length),
            DefinitionFingerprint = ComparisonFixtures.DefaultFingerprint,
        };

    private static RunResult Run(
        RunStatus status,
        string? transcriptScenarioId = null,
        IReadOnlyList<bool>? verdicts = null,
        long seed = 1000
    ) =>
        new()
        {
            Transcript = ComparisonFixtures.Transcript(transcriptScenarioId ?? "a", seed),
            Status = status,
            AssertionResults =
            [
                .. (verdicts ?? [true]).Select(pass => new AssertionResult
                {
                    Spec = AssertionSpec.Parse("slotAbsent:scope/confirm"),
                    Pass = pass,
                }),
            ],
        };
}
