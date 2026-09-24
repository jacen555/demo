using FluentAssertions;
using Forge.EvalCli.Changes;
using Forge.EvalCli.Tests.Support;
using Forge.EvalEngine.Impact;
using Forge.EvalEngine.Scenarios;
using Microsoft.Extensions.Logging.Abstractions;

namespace Forge.EvalCli.Tests.Changes;

/// <summary>
/// Exercises the changed-file set against a real git repository.
/// </summary>
/// <remarks>
/// The unit tests beside this one pin the framing rules against literal bytes. This one pins that
/// the command actually issued produces bytes of that shape — the half a fake cannot check, and
/// the half where a wrong flag costs a scenario its run without saying anything.
/// </remarks>
public class GitChangedFileSourceTests
{
    private static GitChangedFileSource Source(string root, string revision) =>
        new(root, revision, NullLogger<GitChangedFileSource>.Instance);

    [Fact]
    public async Task GetChangedFilesAsync_ForAPathWithANonAsciiName_ReturnsItDecodedSoItsGlobMatches()
    {
        using var repository = new GitWorkspace();

        repository.Write("src/café.cs", "original");
        repository.Commit("baseline");
        repository.Write("src/café.cs", "changed");

        var changes = await Source(repository.Root, "HEAD").GetChangedFilesAsync(CancellationToken.None);

        changes.Established.Should().BeTrue(changes.UnavailableReason);
        changes.Paths.Should().Equal("src/café.cs");

        // The point of decoding it correctly: the glob the suite declares has to match. Without
        // `-z` this arrives quoted and escaped, matches nothing, and the scenario silently sits
        // out the run that was meant to catch the regression.
        var selection = ImpactSelector.Select(SuiteWith("src/**"), changes.Paths);

        selection.FellBackToFullSuite.Should().BeFalse();
        selection.Selected.Should().ContainSingle().Which.Reason.Should().Be(SelectionReason.GlobMatch);
    }

    [Fact]
    public async Task GetChangedFilesAsync_ForAPathWithASpaceInIt_ReturnsItIntact()
    {
        using var repository = new GitWorkspace();

        repository.Write("src/my file.cs", "original");
        repository.Commit("baseline");
        repository.Write("src/my file.cs", "changed");

        var changes = await Source(repository.Root, "HEAD").GetChangedFilesAsync(CancellationToken.None);

        changes.Established.Should().BeTrue(changes.UnavailableReason);
        changes.Paths.Should().Equal("src/my file.cs");
    }

    [Fact]
    public async Task GetChangedFilesAsync_WhenTheRootIsASubdirectory_RebasesPathsOntoIt()
    {
        using var repository = new GitWorkspace();

        repository.Write("tools/EvalCli/src/Foo.cs", "original");
        repository.Commit("baseline");
        repository.Write("tools/EvalCli/src/Foo.cs", "changed");

        var root = Path.Combine(repository.Root, "tools", "EvalCli");

        var changes = await Source(root, "HEAD").GetChangedFilesAsync(CancellationToken.None);

        // git reports `tools/EvalCli/src/Foo.cs` — relative to the repository, not to --root.
        // Unrebased it would be compared against globs anchored at --root and match nothing.
        changes.Established.Should().BeTrue(changes.UnavailableReason);
        changes.Paths.Should().Equal("src/Foo.cs");

        ImpactSelector
            .Select(SuiteWith("src/**"), changes.Paths)
            .Selected.Should()
            .ContainSingle()
            .Which.Reason.Should()
            .Be(SelectionReason.GlobMatch);
    }

    [Fact]
    public async Task GetChangedFilesAsync_WhenAChangedFileIsOutsideTheRoot_WidensTheRunAndNamesTheFile()
    {
        using var repository = new GitWorkspace();

        repository.Write("tools/EvalCli/src/Foo.cs", "original");
        repository.Write("services/Ledger/Bar.cs", "original");
        repository.Commit("baseline");
        repository.Write("services/Ledger/Bar.cs", "changed");

        var root = Path.Combine(repository.Root, "tools", "EvalCli");

        var changes = await Source(root, "HEAD").GetChangedFilesAsync(CancellationToken.None);

        // It cannot be expressed relative to --root, so it is refused rather than dropped. A
        // dropped entry would leave a set that looks complete and selects too little.
        changes.Established.Should().BeFalse();
        changes.UnavailableReason.Should().Contain("services/Ledger/Bar.cs").And.Contain("outside the --root");
        changes.Paths.Should().BeEmpty();
    }

    [Fact]
    public async Task GetChangedFilesAsync_WhenATrackedFileChangedAndAnUntrackedOneWasAdded_ReportsBoth()
    {
        using var repository = new GitWorkspace();

        repository.Write("src/Checkout.cs", "original");
        repository.Write("docs/billing.md", "original");
        repository.Commit("baseline");

        repository.Write("docs/billing.md", "changed");
        repository.Write("src/Refunds.cs", "a brand new file nobody has staged");

        var changes = await Source(repository.Root, "HEAD").GetChangedFilesAsync(CancellationToken.None);

        // `git diff` never reports an untracked file. This is the shape that makes that
        // dangerous: the tracked change makes the set non-empty, so nothing falls back, and a set
        // that is merely *incomplete* looks exactly like a correct one.
        changes.Established.Should().BeTrue(changes.UnavailableReason);
        changes.Paths.Should().BeEquivalentTo(["docs/billing.md", "src/Refunds.cs"]);

        var selection = ImpactSelector.Select(SuiteWith("src/**"), changes.Paths);

        selection.FellBackToFullSuite.Should().BeFalse();
        selection
            .Selected.Should()
            .ContainSingle("the new file is what breaks the scenario, and it must select it")
            .Which.Reason.Should()
            .Be(SelectionReason.GlobMatch);
    }

    [Fact]
    public async Task GetChangedFilesAsync_WhenOnlyAnUntrackedFileWasAdded_ReportsItRatherThanAnEmptySet()
    {
        using var repository = new GitWorkspace();

        repository.Write("src/Checkout.cs", "original");
        repository.Commit("baseline");
        repository.Write("src/Refunds.cs", "a brand new file nobody has staged");

        var changes = await Source(repository.Root, "HEAD").GetChangedFilesAsync(CancellationToken.None);

        changes.Established.Should().BeTrue(changes.UnavailableReason);
        changes.Paths.Should().Equal("src/Refunds.cs");
    }

    [Fact]
    public async Task GetChangedFilesAsync_ForAFileGitIsIgnoring_LeavesItOutRatherThanWideningEveryRun()
    {
        using var repository = new GitWorkspace();

        repository.Write("src/Checkout.cs", "original");
        repository.Write(".gitignore", "artifacts/\n");
        repository.Commit("baseline");

        repository.Write("src/Checkout.cs", "changed");
        repository.Write("artifacts/eval.json", "{}");

        var changes = await Source(repository.Root, "HEAD").GetChangedFilesAsync(CancellationToken.None);

        // Untracked files are read with `--exclude-standard`. Without it every build output under
        // bin/ and obj/ joins the set, matches `**`, and selection stops narrowing anything —
        // which is how a safety feature gets switched off for being useless.
        changes.Established.Should().BeTrue(changes.UnavailableReason);
        changes.Paths.Should().Equal("src/Checkout.cs");
    }

    [Fact]
    public void Select_ForAPathCarryingALiteralBackslash_ReadsItAsASeparatorAndMissesItsGlob()
    {
        // The engine contract the decoder's refusal rests on, pinned rather than assumed. An
        // ordinary file in `src` selects its scenario by glob match:
        ImpactSelector
            .Select(SuiteWith("src/*.cs"), ["src/b.cs"])
            .Selected.Should()
            .ContainSingle()
            .Which.Reason.Should()
            .Be(SelectionReason.GlobMatch);

        // On Unix `src/a\b.cs` is also one file in `src`, but the matcher reads `\` as a
        // separator — right on Windows, wrong here — so it becomes `src/a/b.cs` and matches
        // nothing. Nothing errors; the scenario mapped to the file that changed simply does not
        // run on that evidence. That is why the decoder refuses such a path and widens instead.
        // If this ever starts matching, the refusal can be relaxed.
        ImpactSelector
            .Select(SuiteWith("src/*.cs"), ["src/a\\b.cs"])
            .Selected.Should()
            .NotContain(entry => entry.Reason == SelectionReason.GlobMatch);
    }

    [Fact]
    public async Task GetChangedFilesAsync_WhenNothingChanged_ReturnsAnEstablishedEmptySet()
    {
        using var repository = new GitWorkspace();

        repository.Write("src/Foo.cs", "original");
        repository.Commit("baseline");

        var changes = await Source(repository.Root, "HEAD").GetChangedFilesAsync(CancellationToken.None);

        changes.Established.Should().BeTrue(changes.UnavailableReason);
        changes.Paths.Should().BeEmpty();

        // An empty set is still not evidence that nothing needs running, and the selector says so.
        ImpactSelector.Select(SuiteWith("src/**"), changes.Paths).FellBackToFullSuite.Should().BeTrue();
    }

    [Fact]
    public async Task GetChangedFilesAsync_WhenTheDirectoryIsNotARepository_RefusesRatherThanSelectingASubset()
    {
        using var workspace = new TempWorkspace();

        var changes = await Source(workspace.Root, "HEAD").GetChangedFilesAsync(CancellationToken.None);

        changes.Established.Should().BeFalse();
        changes.UnavailableReason.Should().Contain("not inside a git repository");
        changes.Paths.Should().BeEmpty();
    }

    [Fact]
    public async Task GetChangedFilesAsync_WhenTheRevisionIsUnknown_RefusesRatherThanSelectingASubset()
    {
        using var repository = new GitWorkspace();

        repository.Write("src/Foo.cs", "original");
        repository.Commit("baseline");

        var changes = await Source(repository.Root, "no-such-revision").GetChangedFilesAsync(CancellationToken.None);

        changes.Established.Should().BeFalse();
        changes.UnavailableReason.Should().Contain("no-such-revision");
        changes.Paths.Should().BeEmpty();
    }

    [Fact]
    public async Task GetChangedFilesAsync_ForARename_ReportsBothTheOldAndTheNewPath()
    {
        using var repository = new GitWorkspace();

        repository.Write("src/Old.cs", "content that is identical either side");
        repository.Commit("baseline");
        repository.Git("mv", "src/Old.cs", "src/New.cs");

        var changes = await Source(repository.Root, "HEAD").GetChangedFilesAsync(CancellationToken.None);

        // `--no-renames` is deliberate: a detected rename reports only the destination, and a
        // scenario mapped to the path that went away would then never run.
        changes.Established.Should().BeTrue(changes.UnavailableReason);
        changes.Paths.Should().BeEquivalentTo(["src/New.cs", "src/Old.cs"]);
    }

    [Fact]
    public async Task ReadCappedAsync_WhenTheStreamRunsPastTheCap_DrainsItSoTheWriterIsNeverLeftBlocked()
    {
        // Larger than the 64 KiB read buffer on purpose: it has to take more than one read for
        // "stopped reading at the ceiling" and "read to the end" to be distinguishable at all.
        using var stream = new MemoryStream(new byte[200_000]);

        var (bytes, truncated) = await GitChangedFileSource.ReadCappedAsync(stream, 100, CancellationToken.None);

        // Abandoning the pipe at the ceiling is what leaves git blocked on a full buffer with
        // nobody reading it — and a git that never exits is a WaitForExitAsync that never
        // returns, so the run neither narrows nor widens. It hangs.
        stream
            .Position.Should()
            .Be(stream.Length, "the stream must be read to the end even once it is over the cap");
        truncated.Should().BeTrue();
        bytes.Should().HaveCount(100, "memory is bounded by the cap, which is the other half of the rule");
    }

    [Fact]
    public async Task ReadCappedAsync_WhenTheStreamFitsWithinTheCap_KeepsAllOfItAndReportsNoTruncation()
    {
        using var stream = new MemoryStream([1, 2, 3, 4]);

        var (bytes, truncated) = await GitChangedFileSource.ReadCappedAsync(stream, 100, CancellationToken.None);

        truncated.Should().BeFalse();
        bytes.Should().Equal(1, 2, 3, 4);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("--output=/tmp/anywhere")]
    [InlineData("-C")]
    [InlineData("main\nrm -rf /")]
    public void TryValidateRevision_ForAValueThatIsNotARevision_Refuses(string? revision)
    {
        GitChangedFileSource.TryValidateRevision(revision, out var rejection).Should().BeFalse();
        rejection.Should().NotBeNullOrWhiteSpace();
    }

    [Theory]
    [InlineData("HEAD")]
    [InlineData("origin/main")]
    [InlineData("9f1b2c3")]
    [InlineData("HEAD~3")]
    public void TryValidateRevision_ForARevisionShapedValue_Accepts(string revision)
    {
        GitChangedFileSource.TryValidateRevision(revision, out var rejection).Should().BeTrue();
        rejection.Should().BeNull();
    }

    private static Suite SuiteWith(string glob) =>
        new()
        {
            Name = "regression",
            Scenarios =
            [
                new Scenario
                {
                    Identity = new ScenarioIdentity { Id = "only", Kind = ScenarioKind.Rest },
                    Execution = new Execution { Mode = ExecutionMode.Deterministic },
                    Selection = new Selection { ImpactGlobs = [glob] },
                },
            ],
        };
}
