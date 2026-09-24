using FluentAssertions;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Tests.Support;

namespace Forge.EvalCli.Tests.Cli;

public class PathGuardTests
{
    private static PathGuard Guard(TempWorkspace workspace) => PathGuard.ForRoot(workspace.Root, "--root");

    [Fact]
    public void ForRoot_WhenTheDirectoryDoesNotExist_Refuses()
    {
        using var workspace = new TempWorkspace();

        var act = () => PathGuard.ForRoot(Path.Combine(workspace.Root, "nowhere"), "--root");

        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Fact]
    public void ForRoot_ForAnExistingDirectory_ReturnsItWithoutATrailingSeparator()
    {
        using var workspace = new TempWorkspace();

        var guard = PathGuard.ForRoot(workspace.Root + Path.DirectorySeparatorChar, "--root");

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
        PathGuard.ForRoot(link, "--root").Root.Should().Be(Path.TrimEndingDirectorySeparator(workspace.Outside));
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
            .ForRoot(linkedRoot, "--root")
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
}
