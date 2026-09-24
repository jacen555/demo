using FluentAssertions;
using Forge.EvalEngine.Paths;

namespace Forge.EvalEngine.Tests.Paths;

/// <summary>
/// The confinement contract, asserted on the public primitive itself rather than through a caller
/// that rewrites its refusals into its own vocabulary.
/// </summary>
/// <remarks>
/// <c>SuiteLoaderTests</c> and <c>ArtifactBaselineTests</c> already pin this behaviour as the
/// <see cref="ArgumentException"/> each of them maps it to. That mapping is theirs; what a
/// consumer outside this assembly actually catches is
/// <see cref="PathEscapesBoundaryException"/>, and this is where that is held.
/// </remarks>
public class PathBoundaryTests
{
    // -------------------------------------------------------------------------------------------
    // The root is canonicalized on construction, so comparisons are against the tree the file
    // system reads from rather than the string the caller typed.
    // -------------------------------------------------------------------------------------------

    [Fact]
    public void Constructor_RootWithATrailingSeparator_CanonicalizesToTheSameRootAsWithoutOne()
    {
        using var root = new TempDirectory();

        var trailing = new PathBoundary(root.Path + Path.DirectorySeparatorChar);

        trailing.Root.Should().Be(new PathBoundary(root.Path).Root);
    }

    [Fact]
    public void Constructor_RootReachedThroughALink_ResolvesToTheTreeItPointsAt()
    {
        using var root = new TempDirectory();
        var real = root.CreateDirectory("real");
        root.LinkDirectory("alias", real);

        var boundary = new PathBoundary(Path.Combine(root.Path, "alias"));

        // The root is the one path resolved WITHOUT a boundary: the caller chose it itself, so
        // there is no untrusted author whose link is being followed.
        boundary.Root.Should().Be(new PathBoundary(real).Root);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Constructor_BlankRoot_ThrowsArgumentException(string rootDirectory)
    {
        Action build = () => _ = new PathBoundary(rootDirectory);

        build.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void Constructor_NullRoot_ThrowsArgumentNullException()
    {
        Action build = () => _ = new PathBoundary(null!);

        build.Should().Throw<ArgumentNullException>();
    }

    // -------------------------------------------------------------------------------------------
    // The happy path: a path inside the root resolves to what the file system would open.
    // -------------------------------------------------------------------------------------------

    [Fact]
    public void Resolve_PathInsideTheRoot_ReturnsTheRealPath()
    {
        using var root = new TempDirectory();
        var written = root.Write("suites/minimal.json", "{}");
        var boundary = new PathBoundary(root.Path);

        boundary.Resolve("suites/minimal.json").Should().Be(Path.Combine(boundary.Root, "suites", "minimal.json"));
        File.Exists(written).Should().BeTrue();
    }

    [Fact]
    public void Resolve_TheRootItself_IsContainedRatherThanRefused()
    {
        using var root = new TempDirectory();
        var boundary = new PathBoundary(root.Path);

        boundary.Resolve(boundary.Root).Should().Be(boundary.Root);
    }

    [Fact]
    public void Resolve_SegmentThatDoesNotExist_KeepsItAsWrittenRatherThanRefusing()
    {
        using var root = new TempDirectory();
        var boundary = new PathBoundary(root.Path);

        // A segment that is confirmed absent cannot be a link. The result is a path that is safe
        // to open, not a promise that anything is there — so this is a not-found for the caller,
        // not a refusal.
        boundary
            .Resolve("absent/nested/minimal.json")
            .Should()
            .Be(Path.Combine(boundary.Root, "absent", "nested", "minimal.json"));
    }

    // -------------------------------------------------------------------------------------------
    // Rule 1, first half: a path that reads outside the root is refused on the text alone, before
    // the file system is touched. A refusal carries no cause, because nothing failed.
    // -------------------------------------------------------------------------------------------

    [Theory]
    [InlineData("../escape.json")]
    [InlineData("suites/../../escape.json")]
    [InlineData("suites/../../../Windows/win.ini")]
    public void Resolve_PathTraversingOutsideTheRoot_ThrowsPathEscapesBoundaryException(string path)
    {
        using var root = new TempDirectory();
        var boundary = new PathBoundary(root.Path);

        Action resolve = () => boundary.Resolve(path);

        resolve.Should().Throw<PathEscapesBoundaryException>().Which.InnerException.Should().BeNull();
    }

    [Fact]
    public void Resolve_SiblingRootSharingTheRootsNameAsAPrefix_IsRefused()
    {
        using var root = new TempDirectory();
        var boundary = new PathBoundary(root.Path);

        // Containment compares against the root plus a separator. A prefix test without one
        // accepts a sibling whose name merely starts the same way.
        var sibling = boundary.Root + "-elsewhere" + Path.DirectorySeparatorChar + "s.json";

        Action resolve = () => boundary.Resolve(sibling);

        resolve
            .Should()
            .Throw<PathEscapesBoundaryException>("'{0}' is a sibling of the root, not a path inside it", sibling);
    }

    [Fact]
    public void Resolve_UncPathOutsideTheRoot_IsRefusedWithoutContactingTheHost()
    {
        using var root = new TempDirectory();
        var boundary = new PathBoundary(root.Path);

        Action resolve = () => boundary.Resolve(@"\\127.0.0.1\no-such-share$\suite.json");

        // A refusal sourced from the host's answer — reachable, unreachable, or slow — would mean
        // the request went out. Containment here is a property of the text, so there is no cause.
        resolve.Should().Throw<PathEscapesBoundaryException>().Which.InnerException.Should().BeNull();
    }

    // -------------------------------------------------------------------------------------------
    // Rule 1, second half, and rule 2: a link inside the root satisfies a lexical check while
    // pointing anywhere, and its target is judged while still text, before anything inspects it.
    // -------------------------------------------------------------------------------------------

    [Fact]
    public void Resolve_DirectoryLinkInsideTheRootPointingOutside_ThrowsPathEscapesBoundaryException()
    {
        using var root = new TempDirectory();
        using var elsewhere = new TempDirectory();
        elsewhere.Write("secret.json", "{}");
        root.LinkDirectory("escape", elsewhere.Path);
        var boundary = new PathBoundary(root.Path);

        Action resolve = () => boundary.Resolve("escape/secret.json");

        resolve.Should().Throw<PathEscapesBoundaryException>();
    }

    [Fact]
    public void Resolve_LinkInsideTheRootPointingAtAUncPath_IsRefusedWithoutContactingTheHost()
    {
        using var root = new TempDirectory();

        // A host name nothing has resolved before, so a cached negative answer cannot stand in for
        // a request that really does leave the machine.
        root.LinkFile("decoy.json", $@"\\forge-eval-{Guid.NewGuid():N}\share\suite.json");
        var boundary = new PathBoundary(root.Path);

        Action resolve = () => boundary.Resolve("decoy.json");

        // Reading the link's own metadata does not touch what it points at; walking into the
        // target does, and against a UNC target that walk is an outbound request to a host the
        // link's author named. "The network path was not found" is an answer only the network can
        // give, so a refusal carrying it as its cause would mean the request went out.
        resolve.Should().Throw<PathEscapesBoundaryException>().Which.InnerException.Should().BeNull();
    }

    [Fact]
    public void Resolve_LinkThatStaysInsideTheRoot_ReturnsWhatItPointsAt()
    {
        using var root = new TempDirectory();
        root.Write("real/minimal.json", "{}");
        root.LinkFile("alias.json", Path.Combine("real", "minimal.json"));
        var boundary = new PathBoundary(root.Path);

        // Refusing early must not become refusing everything: a relative target is resolved
        // against the link's own directory, not the process's working directory.
        boundary.Resolve("alias.json").Should().Be(Path.Combine(boundary.Root, "real", "minimal.json"));
    }

    // -------------------------------------------------------------------------------------------
    // Rule 3: "could not be established" is a different answer from "escapes", and both fail
    // closed. A caller has to be able to tell them apart, which is why only one is a refusal.
    // -------------------------------------------------------------------------------------------

    [Fact]
    public void Resolve_CycleOfLinks_ThrowsIOExceptionThatIsNotARefusal()
    {
        using var root = new TempDirectory();
        root.LinkFile("a.json", Path.Combine(root.Path, "b.json"));
        root.LinkFile("b.json", Path.Combine(root.Path, "a.json"));
        var boundary = new PathBoundary(root.Path);

        Action resolve = () => boundary.Resolve("a.json");

        // Inside the root the whole way, so nothing escaped: this is the boundary being unable to
        // establish an answer, and it refuses rather than assuming safety.
        resolve.Should().Throw<IOException>().And.Should().NotBeOfType<PathEscapesBoundaryException>();
    }

    // -------------------------------------------------------------------------------------------
    // Invalid input.
    // -------------------------------------------------------------------------------------------

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Resolve_BlankPath_ThrowsArgumentException(string path)
    {
        using var root = new TempDirectory();
        var boundary = new PathBoundary(root.Path);

        Action resolve = () => boundary.Resolve(path);

        resolve.Should().Throw<ArgumentException>().And.Should().NotBeOfType<PathEscapesBoundaryException>();
    }

    [Fact]
    public void Resolve_NullPath_ThrowsArgumentNullException()
    {
        using var root = new TempDirectory();
        var boundary = new PathBoundary(root.Path);

        Action resolve = () => boundary.Resolve(null!);

        resolve.Should().Throw<ArgumentNullException>();
    }
}
