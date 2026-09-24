using FluentAssertions;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Tests.Support;

namespace Forge.EvalCli.Tests.Cli;

public class PathGuardTests
{
    [Fact]
    public void ResolveRoot_WhenTheDirectoryDoesNotExist_Refuses()
    {
        using var workspace = new TempWorkspace();

        var act = () => PathGuard.ResolveRoot(Path.Combine(workspace.Root, "nowhere"), "--root");

        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Fact]
    public void ResolveRoot_ForAnExistingDirectory_ReturnsItWithoutATrailingSeparator()
    {
        using var workspace = new TempWorkspace();

        var resolved = PathGuard.ResolveRoot(workspace.Root + Path.DirectorySeparatorChar, "--root");

        resolved.Should().Be(Path.TrimEndingDirectorySeparator(workspace.Root));
    }

    [Fact]
    public void ResolveExistingFile_ForAPathRelativeToTheRoot_ResolvesAgainstTheRootNotTheWorkingDirectory()
    {
        using var workspace = new TempWorkspace();

        var resolved = PathGuard.ResolveExistingFile("eval-suites/regression.json", workspace.Root, "--suite");

        resolved.Should().Be(workspace.SuitePath);
    }

    [Fact]
    public void ResolveExistingFile_WhenThePathTraversesOutOfTheRoot_Refuses()
    {
        using var workspace = new TempWorkspace();

        var act = () => PathGuard.ResolveExistingFile("../../escaped.json", workspace.Root, "--suite");

        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Fact]
    public void ResolveExistingFile_WhenThePathTraversesUpAndBackInsideTheRoot_Resolves()
    {
        using var workspace = new TempWorkspace();

        var resolved = PathGuard.ResolveExistingFile(
            "artifacts/../eval-suites/regression.json",
            workspace.Root,
            "--suite"
        );

        resolved.Should().Be(workspace.SuitePath);
    }

    [Fact]
    public void ResolveExistingFile_WhenTheFileDoesNotExist_Refuses()
    {
        using var workspace = new TempWorkspace();

        var act = () => PathGuard.ResolveExistingFile("eval-suites/absent.json", workspace.Root, "--suite");

        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Fact]
    public void ResolveExistingFile_WhenThePathNamesADirectory_Refuses()
    {
        using var workspace = new TempWorkspace();

        var act = () => PathGuard.ResolveExistingFile("eval-suites", workspace.Root, "--suite");

        act.Should().Throw<EvalCliException>().WithMessage("*directory*");
    }

    [Fact]
    public void ResolveOutputFile_WhenTheFileAlreadyExistsAndOverwriteWasNotRequested_RefusesAndLeavesItUntouched()
    {
        using var workspace = new TempWorkspace();

        var existing = workspace.WriteFile(Path.Combine("artifacts", "eval.json"), "original contents");

        var act = () =>
            PathGuard.ResolveOutputFile(
                "artifacts/eval.json",
                workspace.Root,
                overwriteAllowed: false,
                "--out",
                "--overwrite"
            );

        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);

        // The safe default is not just a refusal: the file the caller already had is still theirs.
        File.ReadAllText(existing).Should().Be("original contents");
    }

    [Fact]
    public void ResolveOutputFile_WhenTheFileAlreadyExistsAndOverwriteWasRequested_Resolves()
    {
        using var workspace = new TempWorkspace();

        var existing = workspace.WriteFile(Path.Combine("artifacts", "eval.json"), "original contents");

        var resolved = PathGuard.ResolveOutputFile(
            "artifacts/eval.json",
            workspace.Root,
            overwriteAllowed: true,
            "--out",
            "--overwrite"
        );

        resolved.Should().Be(existing);
    }

    [Fact]
    public void ResolveOutputFile_WhenNothingIsThereYet_ResolvesWithoutRequiringTheOptIn()
    {
        using var workspace = new TempWorkspace();

        var resolved = PathGuard.ResolveOutputFile(
            "artifacts/fresh.json",
            workspace.Root,
            overwriteAllowed: false,
            "--out",
            "--overwrite"
        );

        resolved.Should().Be(Path.Combine(workspace.Root, "artifacts", "fresh.json"));
        File.Exists(resolved).Should().BeFalse("resolving a destination must not create anything");
    }

    [Fact]
    public void ResolveOutputFile_WhenTheParentDirectoryDoesNotExist_Refuses()
    {
        using var workspace = new TempWorkspace();

        var act = () =>
            PathGuard.ResolveOutputFile(
                "no/such/place/eval.json",
                workspace.Root,
                overwriteAllowed: true,
                "--out",
                "--overwrite"
            );

        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Fact]
    public void ResolveOutputFile_WhenThePathEscapesTheRoot_RefusesEvenWithTheOptIn()
    {
        using var workspace = new TempWorkspace();

        var act = () =>
            PathGuard.ResolveOutputFile(
                "../escaped.json",
                workspace.Root,
                overwriteAllowed: true,
                "--out",
                "--overwrite"
            );

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
            PathGuard.ResolveOutputFile(
                "linked/someone-elses.json",
                workspace.Root,
                overwriteAllowed: true,
                "--out",
                "--overwrite"
            );

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
            PathGuard.ResolveOutputFile(
                "artifacts/eval.json",
                workspace.Root,
                overwriteAllowed: true,
                "--out",
                "--overwrite"
            );

        // The last segment is a link too, and writing through it lands outside just as surely.
        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
        File.ReadAllText(bystander).Should().Be("not this tool's to touch");
    }

    [Fact]
    public void ResolveOutputFile_WhenTheRootItselfIsALink_StillResolves()
    {
        using var workspace = new TempWorkspace();

        var linkedRoot = workspace.CreateDirectoryLink("linked-root", workspace.Outside);

        var resolved = PathGuard.ResolveOutputFile(
            "fresh.json",
            linkedRoot,
            overwriteAllowed: false,
            "--out",
            "--overwrite"
        );

        // The root is the boundary the caller declared. Whether they reached it through a link is
        // their decision to have made, and a developer whose repository is a junction must not
        // find every destination refused.
        resolved.Should().Be(Path.Combine(linkedRoot, "fresh.json"));
    }

    [Fact]
    public void ResolveOutputFile_WhenNoSegmentIsALink_Resolves()
    {
        using var workspace = new TempWorkspace();

        var resolved = PathGuard.ResolveOutputFile(
            "artifacts/fresh.json",
            workspace.Root,
            overwriteAllowed: false,
            "--out",
            "--overwrite"
        );

        // The guard must refuse a link, not every destination.
        resolved.Should().Be(Path.Combine(workspace.Root, "artifacts", "fresh.json"));
    }

    [Fact]
    public void IsInside_WhenASiblingDirectorySharesThePrefix_IsFalse() =>
        PathGuard
            .IsInside(Path.Combine("C:", "repo-elsewhere", "file.json"), Path.Combine("C:", "repo"))
            .Should()
            .BeFalse();

    [Fact]
    public void IsInside_ForTheRootItself_IsTrue()
    {
        var root = Path.Combine("C:", "repo");

        PathGuard.IsInside(root, root).Should().BeTrue();
    }

    [Fact]
    public void IsInside_ForAPathBeneathTheRoot_IsTrue() =>
        PathGuard.IsInside(Path.Combine("C:", "repo", "a", "b.json"), Path.Combine("C:", "repo")).Should().BeTrue();

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Canonicalize_WhenThePathIsBlank_Refuses(string value)
    {
        var act = () => PathGuard.Canonicalize(value, "--suite");

        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }
}
