using FluentAssertions;
using Forge.EvalEngine.Impact;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;

namespace Forge.EvalEngine.Tests.Impact;

/// <summary>
/// The safety net: what has to be true of the baseline before a scenario is allowed NOT to run.
/// </summary>
/// <remarks>
/// <para>
/// There is exactly one road to being skipped — every declared glob interpreted, none of them
/// matched, and a baseline that records a trustworthy pass. Everything else runs. These tests
/// walk the ways a baseline can look like a pass without being one.
/// </para>
/// <para>
/// That is the recurring defect in its selection form, and it is the most dangerous shape it
/// takes: a wrongly-skipped scenario emits nothing at all. There is no wrong count to notice,
/// no missing assertion to trip — just a smaller run and a green report.
/// </para>
/// </remarks>
public sealed class ImpactSelectorSafetyNetTests
{
    private static readonly Scenario Unmatched = ImpactFixtures.Declaring("unmatched", "docs/**");
    private static readonly string[] ChangedFiles = ["src/a.cs"];

    private static SelectionResult SelectAgainst(ScenarioResult recorded) =>
        ImpactSelector.Select(ImpactFixtures.SuiteOf(Unmatched), ChangedFiles, ImpactFixtures.Artifact(recorded));

    // -----------------------------------------------------------------------------------------
    // The one way to be skipped.
    // -----------------------------------------------------------------------------------------

    [Fact]
    public void Select_MappedUnmatchedAndRecordedAsPassing_IsTheOnlyRoadToBeingSkipped()
    {
        var result = SelectAgainst(ImpactFixtures.Recorded(Unmatched, [RunStatus.Pass, RunStatus.Pass]));

        result.Skipped.Should().Equal("unmatched");
        result.Selected.Should().BeEmpty();
    }

    // -----------------------------------------------------------------------------------------
    // A recorded failure re-runs whatever the mapping says.
    // -----------------------------------------------------------------------------------------

    [Theory]
    [InlineData(RunStatus.Fail)]
    [InlineData(RunStatus.ExpectedFailure)]
    public void Select_AScenarioTheBaselineRecordsAsNotPassing_RunsEvenThoughNoGlobMatched(RunStatus status)
    {
        // Without this the fix is never observed: the change that repairs a scenario is rarely
        // the change that matches its globs, so the repaired scenario would sit out the run that
        // was supposed to show the repair. ExpectedFailure counts too — a known gap clearing is
        // the headline the harness exists to produce.
        var result = SelectAgainst(ImpactFixtures.Recorded(Unmatched, [status]));

        result.Skipped.Should().BeEmpty();
        ImpactFixtures.For(result, "unmatched").Reason.Should().Be(SelectionReason.PreviouslyFailing);
    }

    [Fact]
    public void Select_AScenarioThatPassedSomeRepetitionsAndNotOthers_CountsAsPreviouslyFailing()
    {
        var result = SelectAgainst(ImpactFixtures.Recorded(Unmatched, [RunStatus.Pass, RunStatus.Fail]));

        ImpactFixtures.For(result, "unmatched").Reason.Should().Be(SelectionReason.PreviouslyFailing);
    }

    // -----------------------------------------------------------------------------------------
    // The baseline looks like a pass but is not one. Each of these would silently shrink the run.
    // -----------------------------------------------------------------------------------------

    [Fact]
    public void Select_AScenarioAbsentFromTheBaseline_RunsBecauseThereIsNoEvidenceToSkipItOn()
    {
        var result = ImpactSelector.Select(
            ImpactFixtures.SuiteOf(Unmatched),
            ChangedFiles,
            ImpactFixtures.Artifact(ImpactFixtures.Recorded(ImpactFixtures.Declaring("someone-else", "docs/**")))
        );

        result.Skipped.Should().BeEmpty();
        ImpactFixtures.For(result, "unmatched").Reason.Should().Be(SelectionReason.New);
    }

    [Fact]
    public void Select_NoBaselineAtAll_RunsEveryUnmatchedScenario()
    {
        var result = ImpactSelector.Select(ImpactFixtures.SuiteOf(Unmatched), ChangedFiles, null);

        result.Skipped.Should().BeEmpty();
        ImpactFixtures.For(result, "unmatched").Reason.Should().Be(SelectionReason.New);
        result.FellBackToFullSuite.Should().BeFalse("selection ran; it simply had nothing to skip on");
    }

    [Fact]
    public void Select_AScenarioWhoseBaselineRunsAllErrored_RunsBecauseNoVerdictIsNotAPass()
    {
        // An errored run says the harness fell over, not that the system under test behaved. An
        // absence of recorded failure is not a record of passing.
        var result = SelectAgainst(ImpactFixtures.Recorded(Unmatched, [RunStatus.Error, RunStatus.Error]));

        result.Skipped.Should().BeEmpty();
        ImpactFixtures.For(result, "unmatched").Reason.Should().Be(SelectionReason.New);
    }

    [Fact]
    public void Select_AScenarioWithNoBaselineRunsAtAll_RunsBecauseNoVerdictIsNotAPass()
    {
        var result = SelectAgainst(ImpactFixtures.Recorded(Unmatched, []));

        ImpactFixtures.For(result, "unmatched").Reason.Should().Be(SelectionReason.New);
    }

    [Fact]
    public void Select_ABaselineVerdictProducedFromADifferentDefinition_RunsRatherThanSkippingOnIt()
    {
        // The headline of this layer. The suite now asks for `escalated`; the baseline's pass was
        // earned against `resolved`. The id joins, the fingerprint does not, and skipping here
        // would retire a scenario on evidence about a different question — the same false-green
        // the comparator refuses at T10, arriving one stage earlier and far more quietly.
        var asked = ImpactFixtures.Expecting(Unmatched, "escalated");
        var recordedAgainst = ImpactFixtures.Expecting(Unmatched, "resolved");

        var result = ImpactSelector.Select(
            ImpactFixtures.SuiteOf(asked),
            ChangedFiles,
            ImpactFixtures.Artifact(ImpactFixtures.Recorded(recordedAgainst, [RunStatus.Pass]))
        );

        result.Skipped.Should().BeEmpty();

        var selection = ImpactFixtures.For(result, "unmatched");
        selection.Reason.Should().Be(SelectionReason.New);
        selection.Detail.Should().Contain("fingerprint");
    }

    [Fact]
    public void Select_ABaselineThatRecordsNoFingerprintAtAll_RunsRatherThanSkippingOnIt()
    {
        // The comparator treats a missing fingerprint as not-comparable rather than as a match;
        // the same absence means the same thing here.
        var result = SelectAgainst(ImpactFixtures.Recorded(Unmatched, [RunStatus.Pass], recordFingerprint: false));

        result.Skipped.Should().BeEmpty();

        var selection = ImpactFixtures.For(result, "unmatched");
        selection.Reason.Should().Be(SelectionReason.New);

        // Asserting the reported cause, not just the outcome. An absent fingerprint and a
        // mismatched one both select the scenario, so the outcome alone cannot tell whether this
        // case was recognised — only the detail can, and the detail is what a suite author reads
        // to find out that their baseline predates fingerprinting.
        selection.Detail.Should().Contain("records no definition fingerprint");
    }

    [Fact]
    public void Select_ABaselineFingerprintMatchingTheDefinition_IsWhatMakesTheSkipLegitimate()
    {
        // The complement of the two tests above: the guard must be satisfiable by the real
        // fingerprint of the real scenario, or it is not a guard, it is a blanket refusal that
        // would make selection do nothing at all.
        var result = SelectAgainst(
            ImpactFixtures.Recorded(Unmatched, [RunStatus.Pass], fingerprint: ScenarioFingerprint.Of(Unmatched))
        );

        result.Skipped.Should().Equal("unmatched");
    }

    [Fact]
    public void Select_ABaselineRunFiledUnderAnotherScenario_RunsRatherThanCountingThatRunAsEvidence()
    {
        // A transcript naming a different scenario is another scenario's evidence sitting under
        // this id. Counting it as a pass here retires this scenario on somebody else's result.
        var result = SelectAgainst(
            ImpactFixtures.Recorded(Unmatched, [RunStatus.Pass], transcriptScenarioId: "someone-else")
        );

        result.Skipped.Should().BeEmpty();
        ImpactFixtures.For(result, "unmatched").Reason.Should().Be(SelectionReason.New);
    }

    [Fact]
    public void Select_ABaselineRunRecordedAsPassingBesideAFailedAssertion_RunsRatherThanBelievingTheStatus()
    {
        // The verdicts are the evidence; the status is a claim about them. An artifact whose own
        // run contradicts itself cannot establish that the scenario is covered.
        var result = SelectAgainst(ImpactFixtures.Recorded(Unmatched, [RunStatus.Pass], contradictAssertions: true));

        result.Skipped.Should().BeEmpty();
        ImpactFixtures.For(result, "unmatched").Reason.Should().Be(SelectionReason.New);
    }

    [Fact]
    public void Select_ABaselineVerdictProducedAgainstAnotherKindOfSystem_RunsRatherThanSkippingOnIt()
    {
        // The one redefinition the fingerprint cannot see. `ScenarioFingerprint` covers
        // execution, simulation, and grading; the kind lives in Identity beside the id, so a
        // scenario switched from Rest to Llm keeps its fingerprint exactly. The pass being
        // skipped on was produced by an entirely different runner, against a different system.
        var asked = ImpactFixtures.Conducting(Unmatched, ScenarioKind.Llm);
        var recordedAgainst = ImpactFixtures.Conducting(Unmatched, ScenarioKind.Rest);

        ScenarioFingerprint
            .Of(asked)
            .Should()
            .Be(
                ScenarioFingerprint.Of(recordedAgainst),
                "the fingerprint is identical across a kind change, so it cannot be what catches this"
            );

        var result = ImpactSelector.Select(
            ImpactFixtures.SuiteOf(asked),
            ChangedFiles,
            ImpactFixtures.Artifact(ImpactFixtures.Recorded(recordedAgainst, [RunStatus.Pass]))
        );

        result.Skipped.Should().BeEmpty();

        var selection = ImpactFixtures.For(result, "unmatched");
        selection.Reason.Should().Be(SelectionReason.New);

        // Both kinds named, not merely "a mismatch": the reader's next question is which runner
        // produced the verdict and which one the suite now wants.
        selection.Detail.Should().Contain("Rest").And.Contain("Llm");
    }

    [Theory]
    [InlineData(1, 2)]
    [InlineData(2, 1)]
    public void Select_ABaselineWhoseRunCountDisagreesWithTheRepetitionsItApplied_RunsRatherThanSkippingOnIt(
        int recorded,
        int declared
    )
    {
        // Two repetitions applied and one run written down reads, to anything counting runs
        // alone, as "one graded, one passed" — and the scenario retires on a record missing the
        // repetition that might have failed. Both directions are refused: an entry claiming
        // fewer repetitions than it carries disagrees with itself just as badly, and testing
        // only the short side would let `<` stand in for `!=`.
        var statuses = Enumerable.Repeat(RunStatus.Pass, recorded).ToArray();

        var result = SelectAgainst(ImpactFixtures.Recorded(Unmatched, statuses, declaredRepetitions: declared));

        result.Skipped.Should().BeEmpty();

        var selection = ImpactFixtures.For(result, "unmatched");
        selection.Reason.Should().Be(SelectionReason.New);
        selection.Detail.Should().Contain($"{declared} repetition").And.Contain($"{recorded} run");
    }

    [Fact]
    public void Select_APassingBaselineRunCarryingNoVerdictForADeclaredAssertion_RunsRatherThanSkippingOnIt()
    {
        // A pass with no verdicts at all satisfies "no verdict failed" vacuously. The scenario
        // declares an assertion and nothing in the record shows it was ever evaluated, so the
        // status is a claim about checks that may never have run.
        var result = SelectAgainst(ImpactFixtures.Recorded(Unmatched, [RunStatus.Pass], recordVerdicts: false));

        result.Skipped.Should().BeEmpty();

        var selection = ImpactFixtures.For(result, "unmatched");
        selection.Reason.Should().Be(SelectionReason.New);
        selection.Detail.Should().Contain(ImpactFixtures.DeclaredAssertion);
    }

    [Fact]
    public void Select_APassingBaselineRunCarryingAVerdictForADifferentAssertion_RunsRatherThanSkippingOnIt()
    {
        // Harder than the case above, and the reason coverage is checked per declared spec
        // rather than by counting: the run carries exactly as many verdicts as the scenario
        // declares, and all of them passed. None of them is the assertion the suite asked for.
        var result = SelectAgainst(
            ImpactFixtures.Recorded(Unmatched, [RunStatus.Pass], verdictSpec: "slotAbsent:scope/somewhere-else")
        );

        result.Skipped.Should().BeEmpty();

        var selection = ImpactFixtures.For(result, "unmatched");
        selection.Reason.Should().Be(SelectionReason.New);
        selection.Detail.Should().Contain(ImpactFixtures.DeclaredAssertion);
    }

    [Fact]
    public void Select_AScenarioDeclaringNoAssertionsWhoseBaselineRunCarriesNone_IsStillSkippable()
    {
        // The complement, and the boundary of the guard above: a scenario that grades on nothing
        // asserted nothing, and nothing it asserted went unevaluated. Requiring a verdict here
        // would turn the coverage check into a blanket refusal that never skips anything.
        var ungraded = ImpactFixtures.Ungraded(ImpactFixtures.Declaring("ungraded", "docs/**"));

        var result = ImpactSelector.Select(
            ImpactFixtures.SuiteOf(ungraded),
            ChangedFiles,
            ImpactFixtures.Artifact(ImpactFixtures.Recorded(ungraded, [RunStatus.Pass], recordVerdicts: false))
        );

        result.Skipped.Should().Equal("ungraded");
    }

    [Fact]
    public void Select_ABaselineRunWithAnUndeclaredStatus_RunsRatherThanTreatingItAsAVerdict()
    {
        // Two runs, not one: with a single corrupt run the scenario would be ungradeable and
        // would run anyway, so the test would pass without the guard doing anything. The passing
        // sibling is what makes the guard load-bearing — without it the entry reads as one
        // graded, one passed, and the scenario is skipped.
        var recorded = ImpactFixtures.Recorded(Unmatched, [RunStatus.Pass, RunStatus.Pass]);
        var corrupted = recorded with { Runs = [recorded.Runs[0], recorded.Runs[1] with { Status = (RunStatus)937 }] };

        var result = SelectAgainst(corrupted);

        result.Skipped.Should().BeEmpty();
        ImpactFixtures.For(result, "unmatched").Reason.Should().Be(SelectionReason.New);
    }

    // -----------------------------------------------------------------------------------------
    // The mapping stage, and the order the reasons are reported in.
    // -----------------------------------------------------------------------------------------

    [Fact]
    public void Select_AScenarioDeclaringNoGlobs_RunsBecauseNothingIsKnownAboutWhatAffectsIt()
    {
        var result = ImpactSelector.Select(
            ImpactFixtures.SuiteOf(ImpactFixtures.Declaring("unmapped")),
            ChangedFiles,
            ImpactFixtures.Artifact(ImpactFixtures.Recorded(ImpactFixtures.Declaring("unmapped")))
        );

        result.Skipped.Should().BeEmpty();
        ImpactFixtures.For(result, "unmapped").Reason.Should().Be(SelectionReason.NoGlobsDeclared);
    }

    [Fact]
    public void Select_AScenarioWhoseGlobsAllFailedToParse_RunsRatherThanConcludingNothingMatched()
    {
        var scenario = ImpactFixtures.Declaring("badly-mapped", "src/[a-z].cs");

        var result = ImpactSelector.Select(
            ImpactFixtures.SuiteOf(scenario),
            ChangedFiles,
            ImpactFixtures.Artifact(ImpactFixtures.Recorded(scenario))
        );

        result.Skipped.Should().BeEmpty();

        var selection = ImpactFixtures.For(result, "badly-mapped");
        selection.Reason.Should().Be(SelectionReason.NoGlobsDeclared);
        selection.Detail.Should().Contain("src/[a-z].cs", "a pattern nobody can find is a pattern nobody fixes");
    }

    [Fact]
    public void Select_AScenarioMixingAGoodGlobWithAnUnparseableOne_RunsBecauseTheMappingIsIncomplete()
    {
        // The good glob does not match, but the rejected one might have. "None of the patterns I
        // could read matched" is not "nothing matched".
        var scenario = ImpactFixtures.Declaring("partly-mapped", "docs/**", "src/{a,b}.cs");

        var result = ImpactSelector.Select(
            ImpactFixtures.SuiteOf(scenario),
            ChangedFiles,
            ImpactFixtures.Artifact(ImpactFixtures.Recorded(scenario))
        );

        result.Skipped.Should().BeEmpty();

        var selection = ImpactFixtures.For(result, "partly-mapped");
        selection.Reason.Should().Be(SelectionReason.NoGlobsDeclared);
        selection.Detail.Should().Contain("src/{a,b}.cs");
    }

    [Fact]
    public void Select_AScenarioWhoseReadableGlobMatches_ReportsTheMatchRatherThanTheUnreadableSibling()
    {
        var scenario = ImpactFixtures.Declaring("partly-mapped", "src/**", "src/{a,b}.cs");

        var result = ImpactSelector.Select(ImpactFixtures.SuiteOf(scenario), ChangedFiles, null);

        ImpactFixtures.For(result, "partly-mapped").Reason.Should().Be(SelectionReason.GlobMatch);
    }

    [Fact]
    public void Select_AGlobMatch_NamesTheChangedFileAndThePatternThatMatchedIt()
    {
        var result = ImpactSelector.Select(
            ImpactFixtures.SuiteOf(ImpactFixtures.Declaring("mapped", "docs/**", "libs/*/src/**")),
            ["README.md", "libs/EvalEngine/src/Impact/ImpactSelector.cs"],
            null
        );

        var selection = ImpactFixtures.For(result, "mapped");
        selection.Reason.Should().Be(SelectionReason.GlobMatch);
        selection.Detail.Should().Contain("libs/EvalEngine/src/Impact/ImpactSelector.cs").And.Contain("libs/*/src/**");
    }

    [Fact]
    public void Select_AScenarioBothMatchedAndPreviouslyFailing_ReportsTheMatchSoTheRescueCountStaysHonest()
    {
        // Reported reasons are counted in a PR report. If the net's reason won here, "12 rescued
        // by the safety net" would include scenarios the mapping would have selected anyway.
        var scenario = ImpactFixtures.Declaring("both", "src/**");

        var result = ImpactSelector.Select(
            ImpactFixtures.SuiteOf(scenario),
            ChangedFiles,
            ImpactFixtures.Artifact(ImpactFixtures.Recorded(scenario, [RunStatus.Fail]))
        );

        ImpactFixtures.For(result, "both").Reason.Should().Be(SelectionReason.GlobMatch);
    }

    [Fact]
    public void Select_AScenarioBothUnmappedAndPreviouslyFailing_ReportsTheMissingMapping()
    {
        var scenario = ImpactFixtures.Declaring("both");

        var result = ImpactSelector.Select(
            ImpactFixtures.SuiteOf(scenario),
            ChangedFiles,
            ImpactFixtures.Artifact(ImpactFixtures.Recorded(scenario, [RunStatus.Fail]))
        );

        ImpactFixtures.For(result, "both").Reason.Should().Be(SelectionReason.NoGlobsDeclared);
    }

    // -----------------------------------------------------------------------------------------
    // The report a reviewer actually reads.
    // -----------------------------------------------------------------------------------------

    [Fact]
    public void Select_AMixedSuite_ReportsEveryScenarioExactlyOnceInSuiteOrderWithItsOwnReason()
    {
        var matched = ImpactFixtures.Declaring("matched", "src/**");
        var failing = ImpactFixtures.Declaring("failing", "docs/**");
        var fresh = ImpactFixtures.Declaring("fresh", "docs/**");
        var unmapped = ImpactFixtures.Declaring("unmapped");
        var settled = ImpactFixtures.Declaring("settled", "docs/**");

        var result = ImpactSelector.Select(
            ImpactFixtures.SuiteOf(matched, failing, fresh, unmapped, settled),
            ChangedFiles,
            ImpactFixtures.Artifact(
                ImpactFixtures.Recorded(matched, [RunStatus.Pass]),
                ImpactFixtures.Recorded(failing, [RunStatus.Fail]),
                ImpactFixtures.Recorded(unmapped, [RunStatus.Pass]),
                ImpactFixtures.Recorded(settled, [RunStatus.Pass])
            )
        );

        result
            .Selected.Select(selection => (selection.ScenarioId, selection.Reason))
            .Should()
            .Equal(
                ("matched", SelectionReason.GlobMatch),
                ("failing", SelectionReason.PreviouslyFailing),
                ("fresh", SelectionReason.New),
                ("unmapped", SelectionReason.NoGlobsDeclared)
            );
        result.Skipped.Should().Equal("settled");
        result.FellBackToFullSuite.Should().BeFalse();
    }
}
