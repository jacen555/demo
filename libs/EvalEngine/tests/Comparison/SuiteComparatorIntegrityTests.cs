using FluentAssertions;
using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Comparison;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Transcripts;

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

    /// <summary>One check, and the two together — the material the per-repetition tests pair on.</summary>
    private static readonly string[] OneCheck = ["exactMatch:outcome"];
    private static readonly string[] BothChecks = ["exactMatch:outcome", "slotAbsent:scope/confirm"];

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
        ComparisonFixtures.Withheld(result, "a").Cause.Should().Be(CoverageWithholdingCause.Errored);
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
    // The assertions each repetition was actually graded against.
    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// A set unioned across a scenario's repetitions cannot see a repetition that checked less.
    /// </summary>
    /// <remarks>
    /// The fabrication in full. Both artifacts grade repetition two against both assertions, so
    /// the union of specs across each scenario is identical and any comparison of those unions
    /// agrees the two scenarios ask the same thing. Repetition <i>one</i> of the candidate was
    /// graded against only the first assertion — the second was never evaluated — so its pass is
    /// "nothing that ran failed" rather than "every declared check held". Paired against a
    /// baseline repetition that did evaluate both, it becomes a discordant pair: a fifty-point
    /// effect size and a p-value, earned by an assertion that never ran.
    /// </remarks>
    [Fact]
    public void Compare_CandidateRepetitionGradedAgainstFewerAssertionsThanItsPair_ReportsNoEffectItCannotPair()
    {
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario(
                "a",
                [RunStatus.Fail, RunStatus.Fail],
                perRunAssertions: [BothChecks, BothChecks]
            ),
        ]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario(
                "a",
                [RunStatus.Pass, RunStatus.Fail],
                perRunAssertions: [OneCheck, BothChecks]
            ),
        ]);

        var comparison = ComparisonFixtures.For(ComparisonFixtures.WithStatistics().Compare(baseline, candidate), "a");

        comparison.Classification.Should().Be(ScenarioClassification.NotComparable);
        comparison.NotComparableReason.Should().Contain("'a'").And.Contain("Repetition");
        comparison.GradedPairs.Should().Be(0);
        comparison.Comparison.Should().BeNull();
    }

    /// <summary>
    /// The same fabrication carried all the way to a reported fix.
    /// </summary>
    /// <remarks>
    /// Every candidate repetition passes, so the scenario reads as fixed — but one of those
    /// passes was drawn over a strictly smaller set of checks than the baseline repetition it is
    /// paired against, so what it establishes is not what the baseline failed.
    /// </remarks>
    [Fact]
    public void Compare_EveryCandidateRepetitionPassesButOneCheckedLessThanItsPair_IsNotComparableRatherThanFixed()
    {
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario(
                "a",
                [RunStatus.Fail, RunStatus.Fail],
                perRunAssertions: [BothChecks, BothChecks]
            ),
        ]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario(
                "a",
                [RunStatus.Pass, RunStatus.Pass],
                perRunAssertions: [OneCheck, BothChecks]
            ),
        ]);

        var result = new SuiteComparator().Compare(baseline, candidate);

        ComparisonFixtures.For(result, "a").Classification.Should().Be(ScenarioClassification.NotComparable);
        result.NewlyCovered.Should().BeEmpty();
    }

    /// <summary>
    /// The same divergence in the other direction: the candidate checked <i>more</i>.
    /// </summary>
    /// <remarks>
    /// Not a false green on its own, but it is the same pair of repetitions graded against
    /// different questions — and a regression reported from it would be earned by the extra
    /// assertion rather than by the change.
    /// </remarks>
    [Fact]
    public void Compare_CandidateRepetitionGradedAgainstAnExtraAssertionItsPairNeverRan_IsNotComparable()
    {
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario(
                "a",
                [RunStatus.Pass, RunStatus.Pass],
                perRunAssertions: [OneCheck, BothChecks]
            ),
        ]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario(
                "a",
                [RunStatus.Fail, RunStatus.Pass],
                perRunAssertions: [BothChecks, BothChecks]
            ),
        ]);

        var comparison = ComparisonFixtures.For(new SuiteComparator().Compare(baseline, candidate), "a");

        comparison.Classification.Should().Be(ScenarioClassification.NotComparable);
        comparison.NotComparableReason.Should().Contain("Repetition");
    }

    /// <summary>
    /// Repetitions graded against different checks on <b>both</b> sides, pairwise identical.
    /// </summary>
    /// <remarks>
    /// Each pair was asked the same question, which is all the pairing needs. A rule phrased
    /// over the scenario rather than over the pair would refuse this, and refusing a comparison
    /// that is genuinely matched spends the guard's credibility for nothing.
    /// </remarks>
    [Fact]
    public void Compare_RepetitionsGradedAgainstDifferentChecksButMatchedPairwise_StillCompares()
    {
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario(
                "a",
                [RunStatus.Fail, RunStatus.Fail],
                perRunAssertions: [OneCheck, BothChecks]
            ),
        ]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario(
                "a",
                [RunStatus.Pass, RunStatus.Pass],
                perRunAssertions: [OneCheck, BothChecks]
            ),
        ]);

        var comparison = ComparisonFixtures.For(new SuiteComparator().Compare(baseline, candidate), "a");

        comparison.Classification.Should().Be(ScenarioClassification.Fixed);
        comparison.GradedPairs.Should().Be(2);
    }

    /// <summary>
    /// A repetition that errored under one variant must not veto the scenario.
    /// </summary>
    /// <remarks>
    /// An errored run never reached grading, so it carries no verdicts at all. Comparing its
    /// empty set against its pair's would make every mixed scenario not-comparable — and the
    /// errored pair is already conditioned out of the denominator everywhere else, so it has no
    /// business vetoing the repetitions that did produce evidence.
    /// </remarks>
    [Fact]
    public void Compare_RepetitionThatErroredUnderOneVariant_StillComparesOnTheRepetitionsThatGraded()
    {
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Error, RunStatus.Fail]),
        ]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Pass, RunStatus.Pass]),
        ]);

        var comparison = ComparisonFixtures.For(new SuiteComparator().Compare(baseline, candidate), "a");

        comparison.Classification.Should().Be(ScenarioClassification.Fixed);
        comparison.GradedPairs.Should().Be(1);
    }

    // -----------------------------------------------------------------------------------------
    // A verdict has to be backed by an exchange that gathered evidence.
    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// A pass whose own transcript says the system under test was never reached.
    /// </summary>
    /// <remarks>
    /// The coordinator never writes this: a run whose exchange state
    /// <see cref="Transcripts.ExchangeState.IsHarnessFailure(string?)"/> classifies as a harness
    /// failure is recorded <see cref="RunStatus.Error"/> and its assertions are not evaluated at
    /// all. An artifact read from disk carries no such guarantee, and a pass with no assertions
    /// beside it satisfies "nothing failed" vacuously — so a baseline truncated to the runs that
    /// never happened is indistinguishable from one that genuinely passed.
    /// </remarks>
    [Theory]
    [InlineData(ExchangeState.RunnerFailed)]
    [InlineData(ExchangeState.Unsupported)]
    [InlineData(ExchangeState.TimedOut)]
    [InlineData(ExchangeState.RequestFailed)]
    [InlineData(ExchangeState.NotAttempted)]
    [InlineData(ExchangeState.ParticipantFailed)]
    [InlineData(ExchangeState.AdapterFailed)]
    public void Compare_PassRecordedBesideATranscriptThatGatheredNoEvidence_RefusesRatherThanCountingIt(string exchange)
    {
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Pass], gradedExchange: exchange),
        ]);
        var candidate = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)]);

        var act = () => new SuiteComparator().Compare(baseline, candidate);

        act.Should().Throw<ArgumentException>().WithMessage("*'a'*");
    }

    /// <summary>
    /// A transcript that recorded no exchange state at all is not a transcript that succeeded.
    /// </summary>
    [Fact]
    public void Compare_PassRecordedWithNoExchangeStateAtAll_RefusesBecauseAbsenceIsNotEvidence()
    {
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Pass], gradedExchange: null),
        ]);
        var candidate = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)]);

        var act = () => new SuiteComparator().Compare(baseline, candidate);

        act.Should().Throw<ArgumentException>().WithMessage("*'a'*");
    }

    /// <summary>
    /// The same refusal for a graded non-pass, because the predicate is the same fact.
    /// </summary>
    /// <remarks>
    /// A <see cref="RunStatus.Fail"/> beside a transcript that gathered nothing is not a false
    /// green, but it is the same self-contradiction: a verdict about a system that was never
    /// successfully asked. Counting it would put a fabricated failure into the denominator of a
    /// paired test.
    /// </remarks>
    [Theory]
    [InlineData(RunStatus.Fail)]
    [InlineData(RunStatus.ExpectedFailure)]
    public void Compare_GradedNonPassRecordedBesideATranscriptThatGatheredNoEvidence_Refuses(RunStatus status)
    {
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [status], gradedExchange: ExchangeState.RequestFailed),
        ]);
        var candidate = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)]);

        var act = () => new SuiteComparator().Compare(baseline, candidate);

        act.Should().Throw<ArgumentException>().WithMessage("*'a'*");
    }

    /// <summary>
    /// A malformed response <i>is</i> evidence, so a verdict drawn from one stands.
    /// </summary>
    /// <remarks>
    /// The request was delivered and the adapter reached a considered verdict on the body, so
    /// what is wrong is the system's output. Refusing it here would excuse a real regression —
    /// which is the exact reason <see cref="Transcripts.ExchangeState.IsHarnessFailure(string?)"/>
    /// names it beside <see cref="Transcripts.ExchangeState.Responded"/> rather than with the
    /// harness failures.
    /// </remarks>
    [Fact]
    public void Compare_VerdictRecordedBesideAMalformedResponse_IsCountedBecauseTheSystemAnswered()
    {
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Fail], gradedExchange: ExchangeState.MalformedResponse),
        ]);
        var candidate = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)]);

        ComparisonFixtures
            .For(new SuiteComparator().Compare(baseline, candidate), "a")
            .Classification.Should()
            .Be(ScenarioClassification.Fixed);
    }

    /// <summary>
    /// An errored run is allowed to carry a harness-failure state — that is what it records.
    /// </summary>
    [Fact]
    public void Compare_ErroredRunCarryingAHarnessFailureState_IsAcceptedBecauseThatIsWhatAnErrorIs()
    {
        var baseline = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Error, RunStatus.Fail]),
        ]);
        var candidate = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Error, RunStatus.Pass]),
        ]);

        ComparisonFixtures
            .For(new SuiteComparator().Compare(baseline, candidate), "a")
            .Classification.Should()
            .Be(ScenarioClassification.Fixed);
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
