using FluentAssertions;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Tests.Support;

namespace Forge.EvalCli.Tests.Cli;

public class PathGuardTests
{
    private static PathGuard Guard(TempWorkspace workspace) =>
        PathGuard.ForRoot(PathValue.FromArgument(workspace.Root), "--root");

    [Fact]
    public void ForRoot_WhenTheDirectoryDoesNotExist_Refuses()
    {
        using var workspace = new TempWorkspace();

        var act = () => PathGuard.ForRoot(PathValue.FromArgument(Path.Combine(workspace.Root, "nowhere")), "--root");

        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Fact]
    public void ForRoot_ForAnExistingDirectory_ReturnsItWithoutATrailingSeparator()
    {
        using var workspace = new TempWorkspace();

        var guard = PathGuard.ForRoot(PathValue.FromArgument(workspace.Root + Path.DirectorySeparatorChar), "--root");

        guard.Root.Should().Be(Path.TrimEndingDirectorySeparator(workspace.Root));
    }

    [Fact]
    public void ForRoot_WhenTheRootIsALink_ReportsTheDirectoryItLeadsTo()
    {
        using var workspace = new TempWorkspace();

        var link = workspace.CreateDirectoryLink("linked-root", workspace.Outside);

        // The boundary the file system will enforce is the resolved one, so that is what is
        // reported and what every later path is measured against. Reporting the text the caller
        // typed would describe a boundary nothing checks.
        PathGuard
            .ForRoot(PathValue.FromArgument(link), "--root")
            .Root.Should()
            .Be(Path.TrimEndingDirectorySeparator(workspace.Outside));
    }

    [Fact]
    public void ResolveExistingFile_ForAPathRelativeToTheRoot_ResolvesAgainstTheRootNotTheWorkingDirectory()
    {
        using var workspace = new TempWorkspace();

        Guard(workspace).ResolveExistingFile("eval-suites/regression.json", "--suite").Should().Be(workspace.SuitePath);
    }

    [Fact]
    public void ResolveExistingFile_WhenThePathTraversesOutOfTheRoot_Refuses()
    {
        using var workspace = new TempWorkspace();

        var act = () => Guard(workspace).ResolveExistingFile("../../escaped.json", "--suite");

        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Fact]
    public void ResolveExistingFile_WhenThePathTraversesUpAndBackInsideTheRoot_Resolves()
    {
        using var workspace = new TempWorkspace();

        Guard(workspace)
            .ResolveExistingFile("artifacts/../eval-suites/regression.json", "--suite")
            .Should()
            .Be(workspace.SuitePath);
    }

    [Fact]
    public void ResolveExistingFile_WhenADirectoryLinkInTheRootLeadsOutOfIt_Refuses()
    {
        using var workspace = new TempWorkspace();

        File.WriteAllText(Path.Combine(workspace.Outside, "someone-elses.json"), "{ \"name\": \"not yours\" }");
        workspace.CreateDirectoryLink("linked", workspace.Outside);

        var act = () => Guard(workspace).ResolveExistingFile("linked/someone-elses.json", "--suite");

        // This is the case a lexical containment check cannot see: the path starts with the root
        // as text and lands outside it on disk. The engine's boundary resolves the link before it
        // answers, which is the whole reason the local copy of this rule was deleted.
        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Fact]
    public void ResolveExistingFile_WhenTheFileItselfIsALinkOutOfTheRoot_Refuses()
    {
        using var workspace = new TempWorkspace();

        var bystander = Path.Combine(workspace.Outside, "someone-elses.json");

        File.WriteAllText(bystander, "{ \"name\": \"not yours\" }");
        workspace.CreateFileLink(Path.Combine("eval-suites", "linked.json"), bystander);

        var act = () => Guard(workspace).ResolveExistingFile("eval-suites/linked.json", "--suite");

        act.Should().Throw<EvalCliException>().WithMessage("*outside the root*");
    }

    [Fact]
    public void ResolveExistingFile_WhenTheFileDoesNotExist_Refuses()
    {
        using var workspace = new TempWorkspace();

        var act = () => Guard(workspace).ResolveExistingFile("eval-suites/absent.json", "--suite");

        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Fact]
    public void ResolveExistingFile_WhenThePathNamesADirectory_Refuses()
    {
        using var workspace = new TempWorkspace();

        var act = () => Guard(workspace).ResolveExistingFile("eval-suites", "--suite");

        act.Should().Throw<EvalCliException>().WithMessage("*directory*");
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void ResolveExistingFile_WhenThePathIsBlank_Refuses(string value)
    {
        using var workspace = new TempWorkspace();

        var act = () => Guard(workspace).ResolveExistingFile(value, "--suite");

        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Fact]
    public void ResolveOutputFile_WhenTheFileAlreadyExistsAndOverwriteWasNotRequested_RefusesAndLeavesItUntouched()
    {
        using var workspace = new TempWorkspace();

        var existing = workspace.WriteFile(Path.Combine("artifacts", "eval.json"), "original contents");

        var act = () =>
            Guard(workspace).ResolveOutputFile("artifacts/eval.json", overwriteAllowed: false, "--out", "--overwrite");

        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);

        // The safe default is not just a refusal: the file the caller already had is still theirs.
        File.ReadAllText(existing).Should().Be("original contents");
    }

    [Fact]
    public void ResolveOutputFile_WhenTheFileAlreadyExistsAndOverwriteWasRequested_Resolves()
    {
        using var workspace = new TempWorkspace();

        var existing = workspace.WriteFile(Path.Combine("artifacts", "eval.json"), "original contents");

        Guard(workspace)
            .ResolveOutputFile("artifacts/eval.json", overwriteAllowed: true, "--out", "--overwrite")
            .Should()
            .Be(existing);
    }

    [Fact]
    public void ResolveOutputFile_WhenNothingIsThereYet_ResolvesWithoutRequiringTheOptIn()
    {
        using var workspace = new TempWorkspace();

        var resolved = Guard(workspace)
            .ResolveOutputFile("artifacts/fresh.json", overwriteAllowed: false, "--out", "--overwrite");

        resolved.Should().Be(Path.Combine(workspace.Root, "artifacts", "fresh.json"));
        File.Exists(resolved).Should().BeFalse("resolving a destination must not create anything");
    }

    [Fact]
    public void ResolveOutputFile_WhenTheParentDirectoryDoesNotExist_Refuses()
    {
        using var workspace = new TempWorkspace();

        var act = () =>
            Guard(workspace)
                .ResolveOutputFile("no/such/place/eval.json", overwriteAllowed: true, "--out", "--overwrite");

        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Fact]
    public void ResolveOutputFile_WhenThePathEscapesTheRoot_RefusesEvenWithTheOptIn()
    {
        using var workspace = new TempWorkspace();

        var act = () =>
            Guard(workspace).ResolveOutputFile("../escaped.json", overwriteAllowed: true, "--out", "--overwrite");

        // --overwrite opts in to replacing a file, not to leaving the root.
        act.Should().Throw<EvalCliException>().WithMessage("*outside the root*");
    }

    [Fact]
    public void ResolveOutputFile_WhenADirectoryLinkInTheRootLeadsOutOfIt_Refuses()
    {
        using var workspace = new TempWorkspace();

        var bystander = Path.Combine(workspace.Outside, "someone-elses.json");

        File.WriteAllText(bystander, "not this tool's to touch");
        workspace.CreateDirectoryLink("linked", workspace.Outside);

        var act = () =>
            Guard(workspace)
                .ResolveOutputFile("linked/someone-elses.json", overwriteAllowed: true, "--out", "--overwrite");

        // Lexical containment says this is inside the root. The file system disagrees, and the
        // file system is the one that does the writing.
        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
        File.ReadAllText(bystander).Should().Be("not this tool's to touch");
    }

    [Fact]
    public void ResolveOutputFile_WhenTheDestinationItselfIsAFileLinkOutOfTheRoot_Refuses()
    {
        using var workspace = new TempWorkspace();

        var bystander = Path.Combine(workspace.Outside, "someone-elses.json");

        File.WriteAllText(bystander, "not this tool's to touch");
        workspace.CreateFileLink(Path.Combine("artifacts", "eval.json"), bystander);

        var act = () =>
            Guard(workspace).ResolveOutputFile("artifacts/eval.json", overwriteAllowed: true, "--out", "--overwrite");

        // The last segment is a link too, and writing through it lands outside just as surely.
        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
        File.ReadAllText(bystander).Should().Be("not this tool's to touch");
    }

    [Fact]
    public void ResolveOutputFile_WhenALinkInsideTheRootStaysInsideIt_IsStillRefused()
    {
        using var workspace = new TempWorkspace();

        workspace.CreateDirectoryLink("linked-artifacts", Path.Combine(workspace.Root, "artifacts"));

        var act = () =>
            Guard(workspace)
                .ResolveOutputFile("linked-artifacts/eval.json", overwriteAllowed: true, "--out", "--overwrite");

        // The boundary permits this: it leads inside the root. A destination is held to the
        // stricter rule anyway, because nothing downstream re-checks where a write lands.
        act.Should().Throw<EvalCliException>().WithMessage("*reached through a link*");
    }

    [Fact]
    public void ResolveOutputFile_WhenTheRootItselfIsALink_StillResolvesInsideWhatItLeadsTo()
    {
        using var workspace = new TempWorkspace();

        var linkedRoot = workspace.CreateDirectoryLink("linked-root", workspace.Outside);

        var resolved = PathGuard
            .ForRoot(PathValue.FromArgument(linkedRoot), "--root")
            .ResolveOutputFile("fresh.json", overwriteAllowed: false, "--out", "--overwrite");

        // The root is the boundary the caller declared. Whether they reached it through a link is
        // their decision to have made, and a developer whose repository is a junction must not
        // find every destination refused — but the path reported is the one on disk.
        resolved.Should().Be(Path.Combine(Path.TrimEndingDirectorySeparator(workspace.Outside), "fresh.json"));
    }

    [Fact]
    public void ResolveOutputFile_WhenNoSegmentIsALink_Resolves()
    {
        using var workspace = new TempWorkspace();

        var resolved = Guard(workspace)
            .ResolveOutputFile("artifacts/fresh.json", overwriteAllowed: false, "--out", "--overwrite");

        // The guard must refuse a link, not every destination.
        resolved.Should().Be(Path.Combine(workspace.Root, "artifacts", "fresh.json"));
    }

    // -------------------------------------------------------------------------------------
    // What a refusal is allowed to print.
    //
    // Every message here goes to stderr and from there to the build log, which is read by
    // anyone who can read the repository. A CI checkout directory names the account the job
    // runs as and the layout of the machine it runs on, and none of that is evidence about
    // the invocation that was refused (§V). Each of these previously printed the resolved,
    // canonical, absolute path.
    //
    // They are asserted as a group rather than one at a time on purpose: ADR 0005's finding is
    // that fixing the instance in front of you and leaving its siblings is how five rounds of
    // a redaction rule each stayed correct about one case and silent about the next.
    // -------------------------------------------------------------------------------------

    [Fact]
    public void ResolveExistingDirectory_ForADirectoryInsideTheRoot_Resolves()
    {
        using var workspace = new TempWorkspace();

        Guard(workspace)
            .ResolveExistingDirectory("artifacts", "--artifacts")
            .Should()
            .Be(Path.Combine(workspace.Root, "artifacts"));
    }

    public static TheoryData<string, string> RefusalsNamingAPath() =>
        new()
        {
            { "--artifacts", "directory-missing" },
            { "--artifacts", "directory-is-a-file" },
            { "--suite", "file-missing" },
            { "--suite", "file-is-a-directory" },
            { "--out", "destination-is-a-directory" },
            { "--out", "destination-parent-missing" },
            { "--out", "destination-taken" },
        };

    private static string Refused(PathGuard guard, string optionName, string shape) =>
        shape switch
        {
            "directory-missing" => guard.ResolveExistingDirectory("nowhere", optionName),
            "directory-is-a-file" => guard.ResolveExistingDirectory("eval-suites/regression.json", optionName),
            "file-missing" => guard.ResolveExistingFile("nowhere.json", optionName),
            "file-is-a-directory" => guard.ResolveExistingFile("artifacts", optionName),
            "destination-is-a-directory" => guard.ResolveOutputFile("artifacts", false, optionName, "--overwrite"),
            "destination-parent-missing" => guard.ResolveOutputFile("nowhere/x.json", false, optionName, "--overwrite"),
            "destination-taken" => guard.ResolveOutputFile(
                "eval-suites/regression.json",
                false,
                optionName,
                "--overwrite"
            ),
            _ => throw new ArgumentOutOfRangeException(nameof(shape), shape, "unknown shape"),
        };

    [Theory]
    [MemberData(nameof(RefusalsNamingAPath))]
    public void Refusals_NameThePathRelativeToTheRootAndNeverTheMachineItIsOn(string optionName, string shape)
    {
        using var workspace = new TempWorkspace();

        var refusal = Assert.Throws<EvalCliException>(() => Refused(Guard(workspace), optionName, shape));

        refusal.ExitCode.Should().Be(ExitCode.UsageError);
        refusal.Message.Should().Contain(optionName);
        (refusal.Message + refusal.Remedy).Should().NotContain(workspace.Root);
    }

    [Fact]
    public void ResolveExistingDirectory_WhenTheDirectoryIsMissing_StillSaysEnoughToFindIt()
    {
        // Relative, not absent. A message that named nothing would be safe and useless.
        using var workspace = new TempWorkspace();

        var refusal = Assert.Throws<EvalCliException>(() =>
            Guard(workspace).ResolveExistingDirectory("artifacts/nightly", "--artifacts")
        );

        refusal.Message.Should().Contain("artifacts/nightly");
    }

    [Fact]
    public void ResolveOutputFile_WhenTheFileAlreadyExists_NamesItRelativelyAndNotAbsolutely()
    {
        using var workspace = new TempWorkspace();

        workspace.WriteFile(Path.Combine("artifacts", "taken.json"), "original contents");

        var refusal = Assert.Throws<EvalCliException>(() =>
            Guard(workspace).ResolveOutputFile("artifacts/taken.json", false, "--out", "--overwrite")
        );

        refusal.Message.Should().Contain("artifacts/taken.json").And.NotContain(workspace.Root);
        refusal.Remedy.Should().Contain("--overwrite");
    }

    [Fact]
    public void ResolveOutputFile_WhenTheDestinationIsReachedThroughALink_NamesTheSegmentRelatively()
    {
        // A link that stays inside the root, so the link guard is what refuses rather than the
        // containment check ahead of it.
        using var workspace = new TempWorkspace();

        workspace.CreateDirectoryLink(Path.Combine("artifacts", "linked"), Path.Combine(workspace.Root, "eval-suites"));

        var refusal = Assert.Throws<EvalCliException>(() =>
            Guard(workspace).ResolveOutputFile("artifacts/linked/x.json", false, "--out", "--overwrite")
        );

        refusal.Message.Should().Contain("reached through a link").And.NotContain(workspace.Root);
        (refusal.Message + refusal.Remedy).Should().NotContain(workspace.Root);
    }

    [Fact]
    public void ResolveExistingFile_WhenThePathEscapesTheRoot_NamesNeitherTheValueNorTheRootAbsolutely()
    {
        using var workspace = new TempWorkspace();

        var outside = Path.Combine(workspace.Outside, "elsewhere.json");

        var refusal = Assert.Throws<EvalCliException>(() =>
            Guard(workspace).ResolveExistingFile(outside, "--baseline")
        );

        refusal.Message.Should().Contain("outside the root");
        (refusal.Message + refusal.Remedy).Should().NotContain(workspace.Outside).And.NotContain(workspace.Root);
    }

    [Fact]
    public void ResolveExistingFile_WhenTheEscapingPathSitsUnderARootTheNetDoesNotList_StillDoesNotPrintIt()
    {
        // The net's published holes are real: `/data` is not a listed system root, so `Supplied`
        // returns this verbatim. `Supplied` exists for refusals that precede any root, where
        // there is nothing to be relative to — and here a root has been established, so the
        // exception does not apply and a root-aware label is available. ADR 0005's amendment is
        // exactly this shape: a trade-off scoped to the surfaces that existed when it was made,
        // reused on a surface it was never reasoned about.
        using var workspace = new TempWorkspace();

        var refusal = Assert.Throws<EvalCliException>(() =>
            Guard(workspace).ResolveExistingFile("/data/ci-user/runs/elsewhere.json", "--baseline")
        );

        (refusal.Message + refusal.Remedy).Should().NotContain("ci-user").And.NotContain("/data/");
        refusal.Message.Should().Contain("--baseline");
    }

    [Fact]
    public void ResolveExistingFile_WhenTheLinksAlongThePathFormACycle_RefusesWithoutNamingTheMachine()
    {
        // The branch that reports a containment that could not be *established*, as opposed to
        // one that failed. It is refused rather than assumed safe, and like every other refusal
        // here it must state the path relative to the root.
        //
        // The value is given absolutely on purpose: a relative one renders identically through
        // either label, so a test using one cannot tell the root-aware label from the root-less
        // hatch. An absolute in-root path separates them — the label states `loop-a/artifact.json`
        // and the hatch states an alias, because the workspace lives under a system root the net
        // does catch.
        using var workspace = new TempWorkspace();

        var first = Path.Combine(workspace.Root, "loop-a");
        var second = Path.Combine(workspace.Root, "loop-b");

        Directory.CreateSymbolicLink(first, second);
        Directory.CreateSymbolicLink(second, first);

        var refusal = Assert.Throws<EvalCliException>(() =>
            Guard(workspace).ResolveExistingFile(Path.Combine(first, "artifact.json"), "--baseline")
        );

        refusal.ExitCode.Should().Be(ExitCode.UsageError);
        (refusal.Message + refusal.Remedy).Should().NotContain(workspace.Root);
        refusal.Message.Should().Contain("--baseline").And.Contain("loop-a/artifact.json");
        refusal.Message.Should().NotContain("[path-redacted:");
    }

    [Fact]
    public void ResolveExistingFile_WhenTheValueIsNotAUsablePath_RefusesWithoutRepeatingIt()
    {
        // A value the platform will not parse as a path at all. Neither label can be trusted to
        // render it — both hand it back to `Path`, which is what just refused it — so it is
        // omitted, and the message says that it was omitted rather than leaving a reader to
        // wonder which argument was meant.
        using var workspace = new TempWorkspace();

        var refusal = Assert.Throws<EvalCliException>(() =>
            Guard(workspace).ResolveExistingFile("artifacts/bad\0name.json", "--baseline")
        );

        refusal.ExitCode.Should().Be(ExitCode.UsageError);
        refusal.Message.Should().Contain("--baseline").And.Contain("not repeated here");
        refusal.Message.Should().NotContain("bad").And.NotContain("name.json");
    }

    [Fact]
    public void ForRoot_WhenTheValueIsOneThisToolDerived_DoesNotRepeatItEvenUnderARootTheNetDoesNotList()
    {
        // The recheck shape: a root this tool already canonicalised, re-resolved at the moment of
        // a write because the file system may have moved under the invocation. The value is no
        // longer anything the caller typed — it is a machine path this tool produced — so the
        // net's published holes must not be relied on to cover it. `/data` is one of those holes.
        var refusal = Assert.Throws<EvalCliException>(() =>
            PathGuard.ForRoot(PathValue.Derived("/data/ci-user/runs"), "--root")
        );

        refusal.ExitCode.Should().Be(ExitCode.UsageError);
        (refusal.Message + refusal.Remedy).Should().NotContain("ci-user").And.NotContain("/data");
        refusal.Message.Should().Contain("--root").And.Contain("not repeated");
    }

    [Fact]
    public void ForRoot_WhenTheValueIsOneTheCallerTyped_StillSaysWhatItWasGiven()
    {
        // The other side of the same rule. Echoing text the caller typed returns their own words,
        // which is what keeps the common mistake diagnosable.
        var refusal = Assert.Throws<EvalCliException>(() =>
            PathGuard.ForRoot(PathValue.FromArgument("no-such-directory"), "--root")
        );

        refusal.Message.Should().Contain("no-such-directory");
    }

    [Fact]
    public void ForRoot_WhenTheRootItselfWillNotResolve_DoesNotPrintTheMachinePathItWasGiven()
    {
        // The case the rest of the machinery cannot cover: there is no root yet, so there is
        // nothing to state a path relative to. The published redaction net is all that is left,
        // and it is applied to the value as supplied rather than to the canonical form — which
        // is strictly less than the caller already typed, never more.
        using var workspace = new TempWorkspace();

        var missing = Path.Combine(workspace.Root, "nowhere");

        var refusal = Assert.Throws<EvalCliException>(() =>
            PathGuard.ForRoot(PathValue.FromArgument(missing), "--root")
        );

        refusal.ExitCode.Should().Be(ExitCode.UsageError);
        (refusal.Message + refusal.Remedy).Should().NotContain(missing).And.NotContain(workspace.Root);
        refusal.Message.Should().Contain("--root");
    }

    [Fact]
    public void ForRoot_WhenTheSuppliedRootCarriesNoMachinePath_StillSaysWhatItWasGiven()
    {
        // The net's holes are published and this is one of them: a relative path is not redacted,
        // because nothing in the text distinguishes it from an identifier. That is the documented
        // trade, and it is what keeps the common case readable.
        var refusal = Assert.Throws<EvalCliException>(() =>
            PathGuard.ForRoot(PathValue.FromArgument("no-such-directory"), "--root")
        );

        refusal.Message.Should().Contain("no-such-directory");
    }
}
