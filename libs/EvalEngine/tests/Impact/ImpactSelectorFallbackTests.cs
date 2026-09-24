using FluentAssertions;
using Forge.EvalEngine.Impact;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;

namespace Forge.EvalEngine.Tests.Impact;

/// <summary>
/// The conditions under which selection refuses to select, and runs everything instead.
/// </summary>
/// <remarks>
/// <para>
/// Every test here pins the same asymmetry. Over-selecting costs time. Under-selecting costs
/// correctness, and costs it <b>invisibly</b>: a scenario that should have run and did not
/// produces no output, so there is no wrong number in the report to catch — only silence, and a
/// green result.
/// </para>
/// <para>
/// So each test is built to prove the fallback <i>changed the answer</i>: the suite always
/// contains a scenario that would otherwise have been skipped, and the assertion is that it ran.
/// A fallback test whose scenario would have run anyway proves nothing.
/// </para>
/// </remarks>
public sealed class ImpactSelectorFallbackTests
{
    /// <summary>A scenario that is skippable: mapped, unmatched, and recorded as passing.</summary>
    private static Scenario Skippable => ImpactFixtures.Declaring("skippable", "docs/**");

    private static SuiteResult PassingBaseline => ImpactFixtures.Artifact(ImpactFixtures.Recorded(Skippable));

    [Fact]
    public void Select_TheControlCase_SkipsTheScenarioSoTheFallbackTestsMeanSomething()
    {
        // Without this, every test below could pass because selection never skips anything.
        var result = ImpactSelector.Select(ImpactFixtures.SuiteOf(Skippable), ["src/a.cs"], PassingBaseline);

        result.Selected.Should().BeEmpty();
        result.Skipped.Should().Equal("skippable");
        result.FellBackToFullSuite.Should().BeFalse();
        result.FallbackReason.Should().BeNull();
    }

    [Fact]
    public void Select_NoChangedFiles_RunsTheWholeSuiteRatherThanNothing()
    {
        var result = ImpactSelector.Select(ImpactFixtures.SuiteOf(Skippable), [], PassingBaseline);

        result.Skipped.Should().BeEmpty();
        ImpactFixtures.For(result, "skippable").Reason.Should().Be(SelectionReason.Fallback);
        result.FellBackToFullSuite.Should().BeTrue();
        result.FallbackReason.Should().NotBeNullOrWhiteSpace();
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("/etc/passwd")]
    [InlineData("C:\\repo\\src\\a.cs")]
    [InlineData("\\\\server\\share\\a.cs")]
    [InlineData("../outside/a.cs")]
    [InlineData("src/../../outside/a.cs")]
    public void Select_AChangedPathThatIsNotRepoRelative_RunsTheWholeSuiteRatherThanDroppingThePath(string offending)
    {
        // Dropping the path silently would be the cheap thing to do, and it is exactly the bug
        // class this whole layer exists to avoid: the scenario that path mapped to would then be
        // skipped, and nothing anywhere would say so.
        var result = ImpactSelector.Select(
            ImpactFixtures.SuiteOf(Skippable),
            ["src/a.cs", offending, "src/b.cs"],
            PassingBaseline
        );

        result.Skipped.Should().BeEmpty();
        ImpactFixtures.For(result, "skippable").Reason.Should().Be(SelectionReason.Fallback);
        result.FallbackReason.Should().NotBeNullOrWhiteSpace();
    }

    [Fact]
    public void Select_AnAbsoluteChangedPath_NamesThatPathInTheFallbackReason()
    {
        var result = ImpactSelector.Select(
            ImpactFixtures.SuiteOf(Skippable),
            ["src/a.cs", "C:\\repo\\src\\a.cs"],
            PassingBaseline
        );

        result.FallbackReason.Should().Contain("C:\\repo\\src\\a.cs", "a fallback nobody can trace is noise");
    }

    [Fact]
    public void Select_AChangedPathWithInteriorTraversalThatStaysInTheRepo_IsResolvedRatherThanRefused()
    {
        // The complement of the test above: `src/deep/../a.cs` names a real, repo-relative file.
        // Refusing it would fall back on every run a tool that emits it produced, which trains a
        // reader to ignore the fallback.
        var result = ImpactSelector.Select(
            ImpactFixtures.SuiteOf(ImpactFixtures.Declaring("mapped", "src/a.cs")),
            ["src/deep/../a.cs"],
            null
        );

        result.FellBackToFullSuite.Should().BeFalse();
        ImpactFixtures.For(result, "mapped").Reason.Should().Be(SelectionReason.GlobMatch);
    }

    [Fact]
    public void Select_AChangedPathStillCQuotedByGit_RunsTheWholeSuiteRatherThanMatchingTheQuotedText()
    {
        // `git diff --name-only` is the command this library's own README hands callers, and it
        // C-quotes any path carrying a non-ASCII byte, a quote, or a control character:
        // `src/café.cs` arrives as `"src/caf\303\251.cs"`. Matched as written, the leading quote
        // and the octal escapes put the file in a directory that does not exist, so `src/**`
        // misses the file that actually changed and the scenario mapped to it retires on a prior
        // pass. That is the under-selection this whole layer exists to prevent, arriving through
        // the documented input path.
        const string quoted = "\"src/caf\\303\\251.cs\"";

        var result = ImpactSelector.Select(ImpactFixtures.SuiteOf(Skippable), ["src/a.cs", quoted], PassingBaseline);

        result.Skipped.Should().BeEmpty();
        ImpactFixtures.For(result, "skippable").Reason.Should().Be(SelectionReason.Fallback);
        result.FallbackReason.Should().Contain(quoted, "a fallback nobody can trace is noise");
    }

    [Fact]
    public void Select_AQuotedChangedPath_DoesNotMatchTheGlobItsDecodedFormWouldHaveMatched()
    {
        // Why the refusal above has to exist rather than being left to match as written. With no
        // baseline at all nothing can be skipped, so this isolates the matching: the quoted path
        // names a file under `src/`, and `src/**` does not see it.
        ImpactSelector
            .Select(ImpactFixtures.SuiteOf(ImpactFixtures.Declaring("mapped", "src/**")), ["src/caf\u00e9.cs"], null)
            .Selected.Should()
            .ContainSingle()
            .Which.Reason.Should()
            .Be(SelectionReason.GlobMatch, "the decoded path is the one the glob is meant to catch");

        var quoted = ImpactSelector.Select(
            ImpactFixtures.SuiteOf(ImpactFixtures.Declaring("mapped", "src/**")),
            ["\"src/caf\\303\\251.cs\""],
            null
        );

        quoted.FellBackToFullSuite.Should().BeTrue("the same file, still quoted, must not be read as unmapped");
    }

    [Fact]
    public void Select_ABaselineForADifferentSuite_RunsTheWholeSuiteRatherThanJoiningOnIdAlone()
    {
        // Two suites share no scenario definitions, so an id that appears in both is a collision
        // rather than a join. Reading the other suite's verdict here is precisely "evidence from
        // one context treated as though it came from another" — and here it would read as a pass
        // and remove the scenario from the run.
        var foreign = ImpactFixtures.Artifact("some-other-suite", ImpactFixtures.Recorded(Skippable));

        var result = ImpactSelector.Select(ImpactFixtures.SuiteOf(Skippable), ["src/a.cs"], foreign);

        result.Skipped.Should().BeEmpty();
        ImpactFixtures.For(result, "skippable").Reason.Should().Be(SelectionReason.Fallback);
        result.FallbackReason.Should().Contain("some-other-suite").And.Contain(ImpactFixtures.SuiteName);
    }

    [Fact]
    public void Select_ABaselineFilingTwoResultsUnderOneId_RunsTheWholeSuiteRatherThanPickingOne()
    {
        // The id is the join key. Two entries under one make whichever was reached first decide
        // whether the scenario runs at all.
        var duplicated = ImpactFixtures.Artifact(
            ImpactFixtures.Recorded(Skippable, [RunStatus.Pass]),
            ImpactFixtures.Recorded(Skippable, [RunStatus.Fail])
        );

        var result = ImpactSelector.Select(ImpactFixtures.SuiteOf(Skippable), ["src/a.cs"], duplicated);

        result.Skipped.Should().BeEmpty();
        ImpactFixtures.For(result, "skippable").Reason.Should().Be(SelectionReason.Fallback);
        result.FallbackReason.Should().Contain("skippable");
    }

    [Fact]
    public void Select_WhenItFallsBack_ReportsTheSuiteWideReasonOnceRatherThanAgainstEveryScenario()
    {
        var result = ImpactSelector.Select(
            ImpactFixtures.SuiteOf(Skippable, ImpactFixtures.Declaring("other", "src/**")),
            [],
            PassingBaseline
        );

        result.Selected.Should().HaveCount(2);
        ImpactFixtures.Reasons(result).Should().AllBeEquivalentTo(SelectionReason.Fallback);
        result.Selected.Should().OnlyContain(selection => selection.Detail == null);
        result.FallbackReason.Should().NotBeNull();
    }

    // -----------------------------------------------------------------------------------------
    // A caller's own bug is a throw, not a fallback. The two are different failures: bad data in
    // an artifact is a reason to run more, a null argument is a reason to stop.
    // -----------------------------------------------------------------------------------------

    [Fact]
    public void Select_NullSuite_Throws() =>
        FluentActions
            .Invoking(() => ImpactSelector.Select(null!, ["src/a.cs"]))
            .Should()
            .Throw<ArgumentNullException>()
            .WithParameterName("suite");

    [Fact]
    public void Select_NullChangedFiles_Throws() =>
        FluentActions
            .Invoking(() => ImpactSelector.Select(ImpactFixtures.SuiteOf(Skippable), null!))
            .Should()
            .Throw<ArgumentNullException>()
            .WithParameterName("changedFiles");

    [Fact]
    public void Select_ASuiteCarryingANullScenario_Throws() =>
        FluentActions
            .Invoking(() =>
                ImpactSelector.Select(new Suite { Name = ImpactFixtures.SuiteName, Scenarios = [null!] }, ["src/a.cs"])
            )
            .Should()
            .Throw<ArgumentException>();

    [Fact]
    public void SelectionReason_Default_ReadsAsFallbackRatherThanAsAConfidentMatch()
    {
        // A reason nobody set must not claim the scenario matched something.
        default(SelectionReason).Should().Be(SelectionReason.Fallback);
    }
}
