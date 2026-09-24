using System.Text;
using FluentAssertions;
using Forge.EvalCli.Changes;

namespace Forge.EvalCli.Tests.Changes;

/// <summary>
/// Pins how a <c>git diff</c> answer is framed, decoded, and rebased.
/// </summary>
/// <remarks>
/// Every case here fails <i>silently</i> in production if it is wrong: a mis-framed or mis-based
/// path does not error, it simply fails to match its impact glob, and the scenario mapped to the
/// file that really changed is skipped on a prior pass. There is no wrong number in the report to
/// catch that, so the rules are pinned against literal bytes.
/// </remarks>
public class GitDiffReadingTests
{
    private static byte[] NulSeparated(params string[] paths) =>
        Encoding.UTF8.GetBytes(string.Concat(paths.Select(path => path + "\0")));

    [Fact]
    public void TryDecodeNulSeparated_ForSeveralPaths_ReadsEachOneWithoutTheTerminator()
    {
        var read = GitDiffReading.TryDecodeNulSeparated(
            NulSeparated("src/Checkout.cs", "docs/readme.md"),
            out var paths,
            out var rejection
        );

        read.Should().BeTrue();
        rejection.Should().BeNull();
        paths.Should().Equal("src/Checkout.cs", "docs/readme.md");
    }

    [Fact]
    public void TryDecodeNulSeparated_ForAPathWithANonAsciiName_ReadsItAsItExistsOnDisk()
    {
        // This is the case `--name-only` without `-z` gets wrong: it would arrive as the literal
        // text "src/caf\303\251.cs", which sits in no directory any glob names.
        var read = GitDiffReading.TryDecodeNulSeparated(NulSeparated("src/café.cs"), out var paths, out _);

        read.Should().BeTrue();
        paths.Should().Equal("src/café.cs");
        paths[0].Should().NotContain("\\303", "a -z diff is never C-quoted, so nothing needs unescaping");
    }

    [Fact]
    public void TryDecodeNulSeparated_ForAPathContainingASpaceOrQuote_KeepsItIntact()
    {
        var read = GitDiffReading.TryDecodeNulSeparated(
            NulSeparated("src/my file.cs", "src/od\"d.cs"),
            out var paths,
            out _
        );

        read.Should().BeTrue();
        paths.Should().Equal("src/my file.cs", "src/od\"d.cs");
    }

    [Fact]
    public void TryDecodeNulSeparated_ForNoOutputAtAll_ReadsAnEmptySet()
    {
        var read = GitDiffReading.TryDecodeNulSeparated([], out var paths, out var rejection);

        read.Should().BeTrue();
        rejection.Should().BeNull();
        paths.Should().BeEmpty();
    }

    [Fact]
    public void TryDecodeNulSeparated_WhenTheOutputDoesNotEndWithANul_Refuses()
    {
        var truncated = Encoding.UTF8.GetBytes("src/Checkout.cs\0src/Half");

        var read = GitDiffReading.TryDecodeNulSeparated(truncated, out var paths, out var rejection);

        // A truncated set is a set that is missing files, and a missing file is a scenario that
        // does not run. Refused rather than partly used.
        read.Should().BeFalse();
        rejection.Should().Contain("truncated");
        paths.Should().BeEmpty();
    }

    [Fact]
    public void TryDecodeNulSeparated_WhenAnEntryIsEmpty_Refuses()
    {
        var read = GitDiffReading.TryDecodeNulSeparated(
            Encoding.UTF8.GetBytes("src/Checkout.cs\0\0docs/readme.md\0"),
            out var paths,
            out var rejection
        );

        read.Should().BeFalse();
        rejection.Should().Contain("empty entry");
        paths.Should().BeEmpty();
    }

    [Fact]
    public void TryDecodeNulSeparated_WhenABytePathIsNotValidUtf8_RefusesRatherThanSubstituting()
    {
        // 0xFF never appears in UTF-8. A replacement character here would produce a path that
        // looks real and matches the wrong glob, or none.
        byte[] undecodable = [(byte)'s', (byte)'r', (byte)'c', (byte)'/', 0xFF, (byte)'.', (byte)'c', (byte)'s', 0];

        var read = GitDiffReading.TryDecodeNulSeparated(undecodable, out var paths, out var rejection);

        read.Should().BeFalse();
        rejection.Should().Contain("not valid UTF-8");
        paths.Should().BeEmpty();
    }

    [Fact]
    public void TryDecodeNulSeparated_ForAUnixFilenameCarryingALiteralBackslash_RefusesRatherThanHandingItOn()
    {
        // These are the bytes git emits on Unix for a file genuinely named `a\b.cs` inside `src`.
        // They decode perfectly — that is the trap. ImpactSelector reads a backslash as a
        // separator, so handed on it becomes `src/a/b.cs`, matches no glob anchored at `src`, and
        // the scenario mapped to the file that changed is skipped with nothing in the report.
        var read = GitDiffReading.TryDecodeNulSeparated(NulSeparated("src/a\\b.cs"), out var paths, out var rejection);

        read.Should().BeFalse();
        rejection.Should().Contain("backslash").And.Contain("src/a\\b.cs");
        paths.Should().BeEmpty();
    }

    [Fact]
    public void TryDecodeNulSeparated_WhenOneEntryCarriesABackslash_RefusesTheWholeSetRatherThanDroppingIt()
    {
        // Dropping the ambiguous entry and keeping the rest is the tempting answer and the
        // dangerous one: it leaves a non-empty set that nothing falls back from.
        var read = GitDiffReading.TryDecodeNulSeparated(
            NulSeparated("src/Checkout.cs", "src/a\\b.cs"),
            out var paths,
            out _
        );

        read.Should().BeFalse();
        paths.Should().BeEmpty();
    }

    [Fact]
    public void TryDecodeNulSeparated_WhenAPathCarriesAControlCharacter_DoesNotLetItReachTheMessage()
    {
        // The refusal quotes a path git produced, and subprocess output is untrusted (§V). An
        // escape sequence left intact would rewrite the terminal of whoever reads the report.
        var read = GitDiffReading.TryDecodeNulSeparated(
            NulSeparated("src/\u001b[31ma\\b.cs"),
            out _,
            out var rejection
        );

        read.Should().BeFalse();
        rejection.Should().NotContain("\u001b");
    }

    [Fact]
    public void TryComputePrefix_WhenTheRootIsTheRepositoryRoot_IsEmpty()
    {
        var root = Path.Combine(Path.GetTempPath(), "repo");

        var computed = GitDiffReading.TryComputePrefix(root, root, out var prefix, out var rejection);

        computed.Should().BeTrue();
        rejection.Should().BeNull();
        prefix.Should().BeEmpty();
    }

    [Fact]
    public void TryComputePrefix_WhenTheRootIsBelowTheRepositoryRoot_IsTheSegmentsBetweenThem()
    {
        var repository = Path.Combine(Path.GetTempPath(), "repo");
        var root = Path.Combine(repository, "tools", "EvalCli");

        var computed = GitDiffReading.TryComputePrefix(repository, root, out var prefix, out _);

        computed.Should().BeTrue();
        prefix.Should().Equal("tools", "EvalCli");
    }

    [Fact]
    public void TryComputePrefix_WhenTheRootIsAboveTheRepositoryRoot_Refuses()
    {
        var repository = Path.Combine(Path.GetTempPath(), "repo", "nested");
        var root = Path.Combine(Path.GetTempPath(), "repo");

        var computed = GitDiffReading.TryComputePrefix(repository, root, out var prefix, out var rejection);

        computed.Should().BeFalse();
        rejection.Should().Contain("not inside the git repository");
        prefix.Should().BeEmpty();
    }

    [Fact]
    public void Rebase_WhenTheRootIsTheRepositoryRoot_LeavesThePathAlone() =>
        GitDiffReading.Rebase("src/Checkout.cs", []).Should().Be("src/Checkout.cs");

    [Fact]
    public void Rebase_WhenTheRootIsASubdirectory_StripsThePrefixSoGlobsMatch()
    {
        // The defect this exists to prevent: git says `tools/EvalCli/src/Foo.cs`, the suite
        // declares `src/**`, and an unrebased path matches nothing at all.
        GitDiffReading.Rebase("tools/EvalCli/src/Foo.cs", ["tools", "EvalCli"]).Should().Be("src/Foo.cs");
    }

    [Fact]
    public void Rebase_WhenThePathIsOutsideTheRoot_AnswersNullRatherThanDroppingIt()
    {
        // Answering null is what makes the caller widen the run and name the file. Dropping it
        // would look identical to a run in which it had genuinely matched nothing.
        GitDiffReading.Rebase("services/Ledger/Foo.cs", ["tools", "EvalCli"]).Should().BeNull();
    }

    [Fact]
    public void Rebase_WhenThePathIsTheRootDirectoryItself_AnswersNull() =>
        GitDiffReading.Rebase("tools/EvalCli", ["tools", "EvalCli"]).Should().BeNull();

    [Fact]
    public void Rebase_WhenASiblingDirectorySharesThePrefixText_AnswersNull() =>
        GitDiffReading.Rebase("tools/EvalCliOther/src/Foo.cs", ["tools", "EvalCli"]).Should().BeNull();
}
