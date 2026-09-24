using FluentAssertions;
using Forge.EvalEngine.Impact;

namespace Forge.EvalEngine.Tests.Impact;

/// <summary>
/// The glob engine itself, pinned against the cases real <c>.gitignore</c>-style patterns
/// produce.
/// </summary>
/// <remarks>
/// <para>
/// This is hand-rolled matching, which is a classic source of subtle bugs, and every bug it can
/// have is <b>silent</b>: a pattern that fails to match a file it should have matched removes a
/// scenario from the run, and a scenario that does not run produces no output to be wrong about.
/// So the engine is pinned directly here rather than only through
/// <see cref="ImpactSelector"/> — the same reasoning that pins the statistical primitives
/// directly instead of through their callers.
/// </para>
/// <para>
/// Each table states a rule and the near-miss that would pass if the rule were not implemented:
/// <c>*</c> that crosses a separator, a prefix match that ignores segment boundaries, a
/// character class silently treated as literal text.
/// </para>
/// </remarks>
public sealed class ImpactGlobMatchingTests
{
    // -----------------------------------------------------------------------------------------
    // Literal, `*`, `?` — matching within one segment.
    // -----------------------------------------------------------------------------------------

    [Theory]
    // A literal pattern matches that path and nothing adjacent to it.
    [InlineData("src/a.cs", "src/a.cs", true)]
    [InlineData("src/a.cs", "src/b.cs", false)]
    [InlineData("src/a.cs", "src/a.cs.bak", false)]
    [InlineData("src/a.cs", "other/a.cs", false)]
    // `*` matches within a segment and MUST NOT cross one. A `*` that crossed would make
    // `src/*.cs` match every .cs file in the tree — over-matching, harmless — but the same bug
    // implemented the other way round is what silently drops files.
    [InlineData("src/*.cs", "src/a.cs", true)]
    [InlineData("src/*.cs", "src/deep/a.cs", false)]
    [InlineData("src/*", "src/a.cs", true)]
    [InlineData("*.cs", "a.cs", true)]
    [InlineData("*.cs", "src/a.cs", false)]
    [InlineData("src/a*.cs", "src/abc.cs", true)]
    [InlineData("src/a*.cs", "src/a.cs", true)]
    [InlineData("src/a*.cs", "src/b.cs", false)]
    // `?` is exactly one character — not "zero or one", which is the DOS-expression behaviour.
    [InlineData("src/?.cs", "src/a.cs", true)]
    [InlineData("src/?.cs", "src/ab.cs", false)]
    [InlineData("src/?.cs", "src/.cs", false)]
    [InlineData("src/a?c.cs", "src/abc.cs", true)]
    public void Matches_WithinASegment_HonoursTheDeclaredSyntax(string pattern, string path, bool expected) =>
        Match(pattern, path).Should().Be(expected);

    // -----------------------------------------------------------------------------------------
    // `**` — zero or more whole segments, including the backtracking cases.
    // -----------------------------------------------------------------------------------------

    [Theory]
    [InlineData("src/**", "src/a.cs", true)]
    [InlineData("src/**", "src/deep/deeper/a.cs", true)]
    [InlineData("src/**", "other/a.cs", false)]
    [InlineData("**", "anything/at/all.cs", true)]
    [InlineData("**/a.cs", "a.cs", true)]
    [InlineData("**/a.cs", "x/y/a.cs", true)]
    [InlineData("**/a.cs", "x/y/b.cs", false)]
    // `**` matching ZERO segments is the case a naive implementation gets wrong.
    [InlineData("src/**/a.cs", "src/a.cs", true)]
    [InlineData("src/**/a.cs", "src/x/y/a.cs", true)]
    [InlineData("src/**/a.cs", "src/x/y/b.cs", false)]
    // Two globstars force real backtracking: the first cannot be resolved greedily.
    [InlineData("a/**/b/**/c.cs", "a/b/c.cs", true)]
    [InlineData("a/**/b/**/c.cs", "a/x/b/y/c.cs", true)]
    [InlineData("a/**/b/**/c.cs", "a/x/y/b/z/w/c.cs", true)]
    [InlineData("a/**/b/**/c.cs", "a/x/y/c.cs", false)]
    // A greedy first match of `**` consumes the `b` the pattern still needs.
    [InlineData("a/**/b/b/c.cs", "a/b/b/b/c.cs", true)]
    [InlineData("a/**/b/b/c.cs", "a/b/b/c.cs", true)]
    [InlineData("a/**/b/b/c.cs", "a/b/c.cs", false)]
    [InlineData("**/x/**", "a/b/x/c/d.cs", true)]
    [InlineData("**/x/**", "a/b/c/d.cs", false)]
    [InlineData("**/**/a.cs", "x/a.cs", true)]
    // Mixed with single-segment wildcards.
    [InlineData("libs/*/src/**/*.cs", "libs/EvalEngine/src/Impact/ImpactSelector.cs", true)]
    [InlineData("libs/*/src/**/*.cs", "libs/EvalEngine/src/A.cs", true)]
    [InlineData("libs/*/src/**/*.cs", "libs/EvalEngine/tests/A.cs", false)]
    [InlineData("libs/*/src/**/*.cs", "libs/EvalEngine/src/A.json", false)]
    public void Matches_AcrossSegments_TreatsGlobstarAsZeroOrMoreSegments(string pattern, string path, bool expected) =>
        Match(pattern, path).Should().Be(expected);

    // -----------------------------------------------------------------------------------------
    // A pattern naming a directory covers what is under it — deliberately, and only at a
    // segment boundary.
    // -----------------------------------------------------------------------------------------

    [Theory]
    // `libs/EvalEngine` almost certainly means "anything under it". Matching it literally would
    // silently drop every file in the tree it names, so the pattern covers its descendants.
    [InlineData("libs/EvalEngine", "libs/EvalEngine/src/Foo.cs", true)]
    [InlineData("libs/EvalEngine", "libs/EvalEngine", true)]
    [InlineData("libs/*", "libs/EvalEngine/src/Foo.cs", true)]
    // ...but the boundary is a SEGMENT boundary, never a string prefix. A neighbouring domain
    // whose name merely starts with the same characters is a different domain.
    [InlineData("libs/EvalEngine", "libs/EvalEngineOther/src/Foo.cs", false)]
    [InlineData("libs/Eval", "libs/EvalEngine/src/Foo.cs", false)]
    // The relationship does not run the other way: a pattern naming a file below a changed
    // directory is not covered by it.
    [InlineData("libs/EvalEngine/src/Foo.cs", "libs/EvalEngine", false)]
    public void Matches_PatternNamingADirectory_CoversItsDescendantsAtSegmentBoundariesOnly(
        string pattern,
        string path,
        bool expected
    ) => Match(pattern, path).Should().Be(expected);

    // -----------------------------------------------------------------------------------------
    // Case. Documented as insensitive on EVERY platform, so the same inputs select the same
    // scenarios on Windows and on Linux.
    // -----------------------------------------------------------------------------------------

    [Theory]
    [InlineData("SRC/**/*.CS", "src/deep/a.cs", true)]
    [InlineData("src/**/*.cs", "SRC/DEEP/A.CS", true)]
    [InlineData("libs/EvalEngine/**", "LIBS/EVALENGINE/src/A.cs", true)]
    [InlineData("src/a.cs", "SRC/A.CS", true)]
    public void Matches_PathsDifferingOnlyInCase_MatchOnEveryPlatform(string pattern, string path, bool expected) =>
        Match(pattern, path).Should().Be(expected);

    // -----------------------------------------------------------------------------------------
    // Separators and `.`/`..` — both sides are reduced to one canonical form before matching.
    // -----------------------------------------------------------------------------------------

    [Theory]
    [InlineData("src\\**", "src/a.cs", true)]
    [InlineData("src/**", "src\\a.cs", true)]
    [InlineData("src\\deep\\*.cs", "src/deep/a.cs", true)]
    [InlineData("./src/**", "src/a.cs", true)]
    [InlineData("src/**", "./src/a.cs", true)]
    [InlineData("src/**", ".\\src\\a.cs", true)]
    [InlineData("src//**", "src//a.cs", true)]
    [InlineData("src/./**", "src/./a.cs", true)]
    [InlineData("src/**", "src/a.cs/", true)]
    // Interior traversal is resolved lexically rather than refused: it names a real file.
    [InlineData("src/**", "src/deep/../a.cs", true)]
    [InlineData("src/**", "other/../src/a.cs", true)]
    [InlineData("other/**", "src/../other/a.cs", true)]
    [InlineData("src/**", "src/../other/a.cs", false)]
    public void Matches_MixedSeparatorsAndRelativeSegments_AreNormalizedOnBothSides(
        string pattern,
        string path,
        bool expected
    ) => Match(pattern, path).Should().Be(expected);

    [Theory]
    [InlineData("src/a.cs", "src/a.cs")]
    [InlineData("src\\deep\\..\\a.cs", "src/a.cs")]
    [InlineData("./src/a.cs", "src/a.cs")]
    [InlineData(".\\src\\a.cs", "src/a.cs")]
    [InlineData("src//a.cs", "src/a.cs")]
    [InlineData("src/./a.cs", "src/a.cs")]
    [InlineData("src/a.cs/", "src/a.cs")]
    [InlineData("./././src/a.cs", "src/a.cs")]
    [InlineData("a/b/c/../../d.cs", "a/d.cs")]
    public void TryNormalize_APathAnyToolingMightEmit_ReducesToTheCanonicalForm(string raw, string canonical)
    {
        ChangedPath.TryNormalize(raw, out var path, out var rejection).Should().BeTrue(rejection);

        path!.Normalized.Should().Be(canonical);
        path.AsWritten.Should().Be(raw, "the caller's own text is what a report has to quote back");
    }

    // -----------------------------------------------------------------------------------------
    // Untrusted paths (§V). A path that cannot be made repo-relative is refused rather than
    // matched approximately.
    // -----------------------------------------------------------------------------------------

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("/etc/passwd")]
    [InlineData("\\\\server\\share\\a.cs")]
    [InlineData("C:\\repo\\src\\a.cs")]
    [InlineData("C:/repo/src/a.cs")]
    [InlineData("c:src/a.cs")]
    [InlineData("../outside.cs")]
    [InlineData("src/../../outside.cs")]
    [InlineData("..")]
    [InlineData(".")]
    [InlineData("./")]
    [InlineData("src/..")]
    public void TryNormalize_APathThatIsNotRepoRelative_IsRefusedRatherThanMatchedApproximately(string? raw)
    {
        ChangedPath.TryNormalize(raw, out var path, out var rejection).Should().BeFalse();

        path.Should().BeNull();
        rejection.Should().NotBeNullOrWhiteSpace("a refusal that says nothing is as silent as no refusal");
    }

    // -----------------------------------------------------------------------------------------
    // Quoting left in by the producer. `git diff --name-only` — the command the README hands
    // callers — C-quotes a path containing a non-ASCII byte, a quote, or a control character.
    // -----------------------------------------------------------------------------------------

    [Theory]
    // Non-ASCII: `src/café.cs`. The octal escapes and the wrapping quotes together name a
    // directory that does not exist, so `src/**` misses the file that actually changed.
    [InlineData("\"src/caf\\303\\251.cs\"")]
    // A quote in the name: `src/a"b.cs`.
    [InlineData("\"src/a\\\"b.cs\"")]
    // A backslash in the name on a POSIX checkout: `src/a\b.cs`.
    [InlineData("\"src/a\\\\b.cs\"")]
    // A tab in the name.
    [InlineData("\"src/a\\tb.cs\"")]
    // Shell quoting, which arrives with the same leading character and mismatches the same way.
    [InlineData("\"src/a.cs\"")]
    // Half-decoded: a caller who stripped the wrapping quotes and left the escapes behind. The
    // quote is no longer the first character, and this is the case that separates "is quoted"
    // from "starts with a quote" — matched as written it names a file under a directory called
    // `a\`, which nothing in the repository is.
    [InlineData("src/a\\\"b.cs")]
    public void TryNormalize_APathLeftQuotedByItsProducer_IsRefusedRatherThanMatchedAsQuotedText(string raw)
    {
        ChangedPath.TryNormalize(raw, out var path, out var rejection).Should().BeFalse();

        path.Should().BeNull();

        // The reader's next action is to decode the path or re-run git differently, so the
        // refusal has to say which of those it is — "not repo-relative" would send them hunting
        // for an absolute path that is not there.
        rejection.Should().Contain("quote");
    }

    [Fact]
    public void TryNormalize_TheDecodedFormOfAQuotedPath_IsAcceptedSoTheRefusalIsAboutQuotingAndNotAboutNonAscii()
    {
        // The refusal is of the quoting, never of the characters that provoked it. A caller who
        // decodes before handing the set in — or runs `git diff -z --name-only` — gets a normal
        // match, which is what makes the refusal actionable rather than a dead end.
        ChangedPath.TryNormalize("src/caf\u00e9.cs", out var path, out var rejection).Should().BeTrue(rejection);

        path!.Normalized.Should().Be("src/caf\u00e9.cs");
    }

    // -----------------------------------------------------------------------------------------
    // Unsupported glob constructs are REFUSED, never reinterpreted as literal text.
    // -----------------------------------------------------------------------------------------

    [Theory]
    // Character classes. `FileSystemName` treats `[a-z]` as four literal characters, so
    // accepting this pattern would match nothing and quietly shrink the run.
    [InlineData("src/[a-z].cs")]
    [InlineData("src/[!a].cs")]
    // Brace alternation, likewise literal to every matcher in the BCL.
    [InlineData("src/{a,b}/**")]
    // gitignore negation. Taking `!` literally inverts the author's intent exactly.
    [InlineData("!src/**")]
    // `**` is a whole segment or nothing. `**.cs` reads as "any .cs anywhere" and would behave
    // as `*.cs` in one segment.
    [InlineData("**.cs")]
    [InlineData("src/a**b/*.cs")]
    [InlineData("src/**deep/*.cs")]
    // Absolute and traversing patterns cannot be resolved against repo-relative paths.
    [InlineData("/abs/**")]
    [InlineData("C:\\repo\\**")]
    [InlineData("\\\\server\\share\\**")]
    [InlineData("../x/**")]
    [InlineData("src/../x/**")]
    // Nothing at all.
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(".")]
    [InlineData("./")]
    public void TryParse_AnUnsupportedOrUnresolvablePattern_IsRefusedRatherThanTakenLiterally(string? pattern)
    {
        ImpactGlob.TryParse(pattern, out var glob, out var rejection).Should().BeFalse();

        glob.Should().BeNull();
        rejection.Should().NotBeNullOrWhiteSpace();
    }

    [Theory]
    [InlineData("src/**")]
    [InlineData("**")]
    [InlineData("*")]
    [InlineData("src/*.cs")]
    [InlineData("src/?.cs")]
    [InlineData("./src/**")]
    [InlineData("src\\**")]
    [InlineData("libs/EvalEngine")]
    // Only the OPENERS of an unsupported construct are refused. A lone `]` or `}` is an
    // ordinary character in a file name and is matched as one.
    [InlineData("src/a]b.cs")]
    [InlineData("src/a}b.cs")]
    public void TryParse_ASupportedPattern_IsAccepted(string pattern)
    {
        ImpactGlob.TryParse(pattern, out var glob, out var rejection).Should().BeTrue(rejection);

        glob!.Pattern.Should().Be(pattern, "a report has to quote the pattern the suite actually declared");
    }

    [Theory]
    [InlineData("src/a]b.cs", "src/a]b.cs", true)]
    [InlineData("src/a]b.cs", "src/ab.cs", false)]
    [InlineData("src/a}b.cs", "src/a}b.cs", true)]
    public void Matches_ALoneClosingBracket_IsAnOrdinaryCharacter(string pattern, string path, bool expected) =>
        Match(pattern, path).Should().Be(expected);

    // -----------------------------------------------------------------------------------------
    // A backslash must never survive into the underlying matcher, where it is an ESCAPE.
    // -----------------------------------------------------------------------------------------

    [Fact]
    public void Matches_APatternContainingABackslash_TreatsItAsASeparatorRatherThanAnEscape()
    {
        // FileSystemName.MatchesSimpleExpression("a\\b", "ab") is TRUE: the backslash escapes the
        // `b`. If a segment ever reached it with a backslash intact, `a\b` would match the file
        // `ab` and miss the directory `a/b` — a wrong answer in both directions at once.
        Match("a\\b/**", "a/b/x.cs").Should().BeTrue("a backslash is a separator on the way in");
        Match("a\\b/**", "ab/x.cs").Should().BeFalse("...and never an escape once it gets there");

        ImpactGlob.TryParse("a\\b/**", out var glob, out _).Should().BeTrue();
        glob!.Segments.Should().Equal("a", "b", "**");
        glob.Segments.Should().NotContain(segment => segment.Contains('\\', StringComparison.Ordinal));
    }

    private static bool Match(string pattern, string path)
    {
        ImpactGlob.TryParse(pattern, out var glob, out var globRejection).Should().BeTrue(globRejection);
        ChangedPath.TryNormalize(path, out var changed, out var pathRejection).Should().BeTrue(pathRejection);

        return glob!.Matches(changed!);
    }
}
