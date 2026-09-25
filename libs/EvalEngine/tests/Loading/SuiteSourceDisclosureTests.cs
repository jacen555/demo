using FluentAssertions;
using Forge.EvalEngine.Loading;

namespace Forge.EvalEngine.Tests.Loading;

/// <summary>
/// The rule that a finding never names the suite by a path on the caller's machine.
/// </summary>
/// <remarks>
/// <para>
/// <b>This is a different vector from the machine-path guard on identifiers.</b> That guard
/// (<see cref="SuiteMachinePathGuardTests"/>) refuses an <i>author-supplied</i> value — a suite
/// name, a scenario id, a tag key — because a human wrote it into a committed file and can be
/// told to rename it. The source name is <i>caller-supplied</i>: it is a real file the user
/// legitimately chose, and the library has no standing to refuse it. So the rule here is not
/// "refuse it", it is <b>"do not print it"</b>.
/// </para>
/// <para>
/// Through the command-line tool the source name is an absolute path, and the tool writes every
/// finding to standard error. On a build agent that path names the account the job runs as. The
/// warning findings are the sharpest case: the tool prints those with no message of its own
/// beside them, so the finding is the only thing in the log.
/// </para>
/// <para>
/// <b>Every assertion here is against <see cref="ValidationMessage.ToString()"/></b>, because
/// that rendering — not the <see cref="ValidationMessage.Message"/> property — is what the
/// command-line tool actually writes. And every assertion sweeps <b>all</b> findings a load
/// produced, not the one code under test: the defect this fixes was a finding that sanitised the
/// value it was warned about and interpolated an unsanitised one immediately beside it.
/// </para>
/// <para>
/// <b>The guard cannot be expressed through <c>MachinePath</c>.</b> Every one of these messages
/// wraps the label in single quotes, and a quoted path is documented on that type as out of
/// scope — so it would answer "clean" for the exact string this test suite exists to catch. The
/// assertion is therefore an exact containment check against the root that was used.
/// </para>
/// </remarks>
public class SuiteSourceDisclosureTests
{
    private const string ValidScenario = """
        {
          "identity": { "id": "refund-flow", "kind": "rest" },
          "execution": { "mode": "live" },
          "simulation": { "opening": "GET /health" },
          "grading": { "assertions": ["statusIs:200"] }
        }
        """;

    /// <summary>
    /// Every suite shape that makes <see cref="SuiteLoader"/> compose a finding naming the source,
    /// crossed with both shapes a caller can name it in.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>This is an enumeration, not a sample.</b> It was built by reading every message
    /// <see cref="SuiteLoader"/> and everything it calls composes, rather than by following the
    /// codes a review happened to name. Three of these — <c>suite.malformed</c>,
    /// <c>suite.schemaVersion.unsupported</c> and <c>suite.scenarios.empty</c> — were absent from
    /// the reported list and leaked exactly as the reported ones did.
    /// </para>
    /// <para>
    /// <b>The absolute shape is the one that carries the defect, and it is how the command-line
    /// tool calls this.</b> Its plan resolves <c>--suite</c> to a real path before handing it
    /// over, so the label the loader was printing was a full checkout path. A first draft of this
    /// sweep passed against the unfixed loader because it only ever named suites relatively —
    /// which proves nothing, since the loader was echoing the caller's own spelling back. Both
    /// shapes are covered so the rule cannot be satisfied by the caller's spelling.
    /// </para>
    /// <para>
    /// A null document means "write no file", which is how <c>suite.notFound</c> is reached.
    /// </para>
    /// </remarks>
    public static TheoryData<string, string, string?, bool> LeakySuites()
    {
        var documents = new (string Expectation, string FileName, string? Document)[]
        {
            ("suite.name.missing", "unnamed.json", """{ "schemaVersion": "1.0", "scenarios": [] }"""),
            ("suite.schemaVersion.missing", "noversion.json", """{ "name": "regression", "scenarios": [] }"""),
            (
                "suite.schemaVersion.unsupported",
                "badversion.json",
                """{ "name": "regression", "schemaVersion": "99.0", "scenarios": [] }"""
            ),
            ("suite.scenarios.missing", "noscenarios.json", """{ "name": "regression", "schemaVersion": "1.0" }"""),
            (
                "suite.scenarios.empty",
                "empty.json",
                """{ "name": "regression", "schemaVersion": "1.0", "scenarios": [] }"""
            ),
            ("suite.malformed/notJson", "broken.json", "{ not json"),
            ("suite.malformed/notAnObject", "array.json", "[]"),
            (
                "suite.malformed/duplicateKey",
                "dupes.json",
                """{ "name": "a", "name": "b", "schemaVersion": "1.0", "scenarios": [] }"""
            ),
            ("suite.notFound", "absent.json", null),
        };

        var data = new TheoryData<string, string, string?, bool>();

        foreach (var (expectation, fileName, document) in documents)
        {
            data.Add(expectation, fileName, document, true);
            data.Add(expectation, fileName, document, false);
        }

        return data;
    }

    /// <summary>
    /// The sweep: no finding from any of these loads repeats the checkout path.
    /// </summary>
    /// <remarks>
    /// Asserted against the root directory string rather than a pattern, so a mutant that
    /// restores <i>any</i> interpolation of the resolved path — in the finding under test or in
    /// any other finding the same load produced — fails this test.
    /// </remarks>
    [Theory]
    [MemberData(nameof(LeakySuites))]
    public async Task LoadAsync_SuiteThatProducesFindings_RepeatsTheCheckoutPathInNoFinding(
        string expectation,
        string fileName,
        string? document,
        bool namedAbsolutely
    )
    {
        using var checkout = new CheckoutRoot();

        if (document is not null)
        {
            checkout.Write($"suites/{fileName}", document);
        }

        var loader = new SuiteLoader(checkout.Path);
        var result = await loader.LoadAsync(SuitePath(loader, fileName, namedAbsolutely), CancellationToken.None);

        result.Messages.Should().NotBeEmpty(because: $"{expectation} is meant to be produced by this document");

        foreach (var message in result.Messages)
        {
            AssertNamesNoMachinePath(message, loader, checkout, result);
        }
    }

    /// <summary>
    /// Names a suite under <c>suites/</c> the way a caller would.
    /// </summary>
    /// <param name="loader">The loader, for the root it actually resolved to.</param>
    /// <param name="fileName">The suite file name.</param>
    /// <param name="absolutely">
    /// <see langword="true"/> for the shape the command-line tool uses — its plan resolves
    /// <c>--suite</c> to a real path before the loader ever sees it.
    /// </param>
    /// <returns>The suite path to hand to the loader.</returns>
    /// <remarks>
    /// <b>An absolute input is built from the canonical root, never from the supplied one.</b>
    /// The boundary resolves its root on construction and measures an absolute path against that
    /// resolved form, so where the two differ — macOS resolving <c>/var</c> to <c>/private/var</c>,
    /// or any temporary directory reached through a link — a path built from the supplied
    /// spelling is refused outright with an <see cref="ArgumentException"/> and the test errors
    /// for a reason that has nothing to do with what it is testing. Measured against a junction,
    /// not assumed.
    /// </remarks>
    private static string SuitePath(SuiteLoader loader, string fileName, bool absolutely) =>
        absolutely ? Path.Combine(loader.RootDirectory, "suites", fileName) : $"suites/{fileName}";

    /// <summary>
    /// The disclosure assertion every other test in this file rests on.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>The canonical root is checked, not just the one that was supplied.</b>
    /// <c>PathBoundary</c> resolves the root through its own links on construction, so the path
    /// the loader actually works from can differ from the string handed to it — macOS resolving
    /// <c>/var</c> to <c>/private/var</c> is the everyday case, and a temporary directory lands
    /// squarely in it. A sweep that only knew the supplied spelling would let a mutant printing
    /// the <i>resolved</i> path through, which is precisely the value every finding is built
    /// from.
    /// </para>
    /// <para>
    /// <see cref="SuiteLoadResult.SourcePath"/> is asserted too: it is the exact string a mutant
    /// would reach for, so naming it directly states the property rather than implying it.
    /// </para>
    /// </remarks>
    private static void AssertNamesNoMachinePath(
        ValidationMessage message,
        SuiteLoader loader,
        CheckoutRoot checkout,
        SuiteLoadResult result
    )
    {
        var rendered = message.ToString();

        rendered
            .Should()
            .NotContain(
                loader.RootDirectory,
                because: "the boundary canonicalises the root, and the resolved form is what findings are built from"
            )
            .And.NotContain(checkout.Path, because: "the supplied spelling must not survive either")
            .And.NotContain(CheckoutRoot.TempPrefix, because: "no fragment of the machine path belongs in a finding");

        if (result.SourcePath is { } source)
        {
            rendered.Should().NotContain(source, because: "that is the string a mutant would print");
        }
    }

    /// <summary>
    /// The positive half: a finding still names the suite, relative to the containment root.
    /// </summary>
    /// <remarks>
    /// Refusing to say anything useful would trade a disclosure for a usability defect. The root
    /// is the part that names the machine and the relative path is the part the caller could have
    /// got wrong, so naming the second and dropping the first loses no diagnostic value at all.
    /// </remarks>
    [Theory]
    [MemberData(nameof(LeakySuites))]
    public async Task LoadAsync_SuiteThatProducesFindings_NamesItRelativeToTheRoot(
        string expectation,
        string fileName,
        string? document,
        bool namedAbsolutely
    )
    {
        using var checkout = new CheckoutRoot();

        if (document is not null)
        {
            checkout.Write($"suites/{fileName}", document);
        }

        var loader = new SuiteLoader(checkout.Path);
        var result = await loader.LoadAsync(SuitePath(loader, fileName, namedAbsolutely), CancellationToken.None);

        var relative = Path.Combine("suites", fileName);

        result
            .Messages.Should()
            .Contain(
                message => message.Message.Contains(relative, StringComparison.Ordinal),
                because: $"{expectation} must still tell the caller which suite under the root it means"
            );
    }

    /// <summary>
    /// <c>suite.notFound</c> keeps the path, because there the path is the information.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A caller debugging a typo needs to read back what was looked for, so this is the one code
    /// where saying nothing useful would be a real regression. The root-relative form answers it
    /// completely: a mistyped <c>--suite</c> argument is wrong <i>within</i> the root, and the
    /// root is supplied separately and has its own diagnostics. The absolute path is the relative
    /// path plus the one component that contributes nothing to the typo and everything to the
    /// disclosure.
    /// </para>
    /// <para>
    /// Both a mistyped directory and a mistyped file name survive the reduction, which is what
    /// makes the relative form sufficient rather than merely better.
    /// </para>
    /// </remarks>
    [Theory]
    [InlineData("suites/regresion.json")]
    [InlineData("suties/regression.json")]
    public async Task LoadAsync_MissingSuite_NamesWhatItLookedForRelativeToTheRoot(string mistyped)
    {
        using var checkout = new CheckoutRoot();
        checkout.Write("suites/regression.json", $$"""{ "name": "r", "scenarios": [{{ValidScenario}}] }""");

        // Named absolutely, the way the command-line tool's plan hands it over, and built from
        // the root the boundary resolved to rather than the one supplied — see SuitePath.
        var loader = new SuiteLoader(checkout.Path);
        var result = await loader.LoadAsync(Path.Combine(loader.RootDirectory, mistyped), CancellationToken.None);

        var finding = result.Messages.Should().ContainSingle(message => message.Code == "suite.notFound").Subject;

        AssertNamesNoMachinePath(finding, loader, checkout, result);
        finding
            .Message.Should()
            .Contain(
                mistyped.Replace('/', Path.DirectorySeparatorChar),
                because: "the typo is what the caller has to see to fix it"
            );
    }

    /// <summary>A suite that cannot be read names itself the same way a missing one does.</summary>
    [Fact]
    public async Task LoadAsync_SuiteThatCannotBeRead_NamesItRelativeToTheRootWithoutTheCheckoutPath()
    {
        using var checkout = new CheckoutRoot();

        // A directory where a file was expected. Opening it for reading fails with the same
        // access error an unreadable file produces, which is the branch under test.
        Directory.CreateDirectory(Path.Combine(checkout.Path, "suites", "regression.json"));

        var loader = new SuiteLoader(checkout.Path);
        var result = await loader.LoadAsync(
            Path.Combine(loader.RootDirectory, "suites", "regression.json"),
            CancellationToken.None
        );

        var finding = result.Messages.Should().ContainSingle(message => message.Code == "suite.unreadable").Subject;

        AssertNamesNoMachinePath(finding, loader, checkout, result);
        finding.Message.Should().Contain(Path.Combine("suites", "regression.json"));
    }

    /// <summary>
    /// The other half of <c>suite.unreadable</c>: a file held open against sharing.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The access-denied branch above and this one are separate catches composing separate
    /// messages, so a check that covered only the first would leave the second free to leak.
    /// </para>
    /// <para>
    /// <b>The skip is decided by probing the platform, never by looking at the result.</b> An
    /// earlier version of this test returned green whenever no <c>suite.unreadable</c> finding
    /// appeared — which is exactly the state a broken read branch produces, so it passed when it
    /// proved nothing. Sharing is advisory on Unix, so the capability is established first; once
    /// established, the finding is <b>required</b>.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task LoadAsync_SuiteLockedAgainstSharing_NamesItRelativeToTheRootWithoutTheCheckoutPath()
    {
        using var checkout = new CheckoutRoot();
        checkout.Write("suites/regression.json", """{ "name": "r", "scenarios": [] }""");

        var loader = new SuiteLoader(checkout.Path);
        var full = Path.Combine(loader.RootDirectory, "suites", "regression.json");
        using var exclusive = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.None);

        if (!SharingIsEnforced(full))
        {
            return;
        }

        var result = await loader.LoadAsync(full, CancellationToken.None);

        var finding = result.Messages.Should().ContainSingle(message => message.Code == "suite.unreadable").Subject;

        AssertNamesNoMachinePath(finding, loader, checkout, result);
        finding.Message.Should().Contain(Path.Combine("suites", "regression.json"));
    }

    /// <summary>
    /// Whether this platform actually denies a second reader, so the test above means something.
    /// </summary>
    /// <param name="path">The file already held open with <see cref="FileShare.None"/>.</param>
    /// <returns><see langword="true"/> when the lock is enforced.</returns>
    private static bool SharingIsEnforced(string path)
    {
        try
        {
            using var probe = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            return false;
        }
        catch (IOException)
        {
            return true;
        }
    }

    /// <summary>
    /// A directory whose name merely begins with <c>..</c> is contained, and keeps its name.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The fail-closed fallback in the relative-label computation asks whether the relative path
    /// ascends out of the root. Asking that as <c>StartsWith("..")</c> also matches
    /// <c>..draft/</c>, which is an ordinary contained directory — so a valid in-root suite
    /// silently lost its directory and reported only a file name.
    /// </para>
    /// <para>
    /// That matters precisely because of the argument made for <c>suite.notFound</c>: the
    /// relative path is kept because a mistyped <i>directory</i> is half of what a caller can get
    /// wrong. A guard that drops the directory for a legitimate path gives away the thing the
    /// design was defending. The question is about a path <b>segment</b>, so it is asked about a
    /// segment.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task LoadAsync_SuiteInADirectoryNamedLikeAnAscent_KeepsTheDirectoryInTheFinding()
    {
        using var checkout = new CheckoutRoot();
        checkout.Write("..draft/regression.json", """{ "schemaVersion": "1.0", "scenarios": [] }""");

        var loader = new SuiteLoader(checkout.Path);
        var result = await loader.LoadAsync(
            Path.Combine(loader.RootDirectory, "..draft", "regression.json"),
            CancellationToken.None
        );

        var finding = result.Messages.Should().ContainSingle(message => message.Code == "suite.name.missing").Subject;

        finding.ToString().Should().NotContain(checkout.Path).And.NotContain(CheckoutRoot.TempPrefix);
        finding
            .Message.Should()
            .Contain(
                Path.Combine("..draft", "regression.json"),
                because: "..draft is a contained directory, not an ascent, and a mistyped directory is half of "
                    + "what a caller can get wrong"
            );
    }

    /// <summary>
    /// A contained directory whose name merely <i>contains</i> a backslash keeps its name.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The sibling of the <c>..draft</c> case, and the reason the ascent check uses <b>native</b>
    /// separators. On Unix <c>\</c> is an ordinary filename character, so <c>..\draft</c> is a
    /// real contained directory — and a both-separator rule reads it as an ascent, falls through
    /// to the file name, and loses the directory from the finding.
    /// </para>
    /// <para>
    /// <b>Windows cannot host this test and says so by probing, not by assuming</b>: the name
    /// cannot exist there because <c>\</c> separates. The probe also keeps the attempt from
    /// creating a directory outside the root, which is what that name means on Windows.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task LoadAsync_SuiteInADirectoryWhoseNameContainsABackslash_KeepsTheDirectoryInTheFinding()
    {
        using var checkout = new CheckoutRoot();

        const string Awkward = @"..\draft";

        if (!checkout.TryCreateLiteralDirectory(Awkward))
        {
            return;
        }

        checkout.WriteLiteral(Awkward, "regression.json", """{ "schemaVersion": "1.0", "scenarios": [] }""");

        var loader = new SuiteLoader(checkout.Path);
        var result = await loader.LoadAsync($"{Awkward}/regression.json", CancellationToken.None);

        var finding = result.Messages.Should().ContainSingle(message => message.Code == "suite.name.missing").Subject;

        AssertNamesNoMachinePath(finding, loader, checkout, result);
        finding
            .Message.Should()
            .Contain(
                Awkward,
                because: "on this host a backslash is a filename character, so that is a contained directory"
            );
    }

    /// <summary>
    /// A root reached through a link discloses neither spelling of itself.
    /// </summary>
    /// <remarks>
    /// The boundary canonicalises its root, so there are two machine paths in play — the one the
    /// caller supplied and the one the file system resolved it to. A finding must repeat
    /// neither. The test asserts the two actually differ before it proves anything about them,
    /// so an environment that cannot make links skips rather than passing vacuously.
    /// </remarks>
    [Fact]
    public async Task LoadAsync_RootReachedThroughALink_RepeatsNeitherSpellingOfTheRoot()
    {
        using var checkout = new CheckoutRoot();

        if (!checkout.TryLinkRoot(out var linkedRoot))
        {
            return;
        }

        checkout.Write("suites/unnamed.json", """{ "scenarios": [] }""");

        var loader = new SuiteLoader(linkedRoot);

        if (loader.RootDirectory.Equals(linkedRoot, StringComparison.OrdinalIgnoreCase))
        {
            // The link did not produce a divergence, so there is no second spelling to test.
            return;
        }

        var result = await loader.LoadAsync("suites/unnamed.json", CancellationToken.None);

        result.Messages.Should().NotBeEmpty();

        foreach (var message in result.Messages)
        {
            message
                .ToString()
                .Should()
                .NotContain(linkedRoot, because: "that is the root as the caller spelled it")
                .And.NotContain(loader.RootDirectory, because: "that is the root the boundary resolved it to")
                .And.NotContain(CheckoutRoot.TempPrefix);
        }
    }

    /// <summary>
    /// The static entry point has no root, so it reduces to the file name.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <see cref="SuiteLoader.LoadFromJson"/> is public and static: it is handed a label and
    /// cannot prove anything about it, so it takes the one reduction that is safe without a root.
    /// That loses directory context, which is the honest cost of not having a root to be relative
    /// to.
    /// </para>
    /// <para>
    /// <b>The reduction is applied here rather than at the call site</b> so that a direct caller
    /// of this overload is protected too — fixing only <see cref="SuiteLoader.LoadAsync"/> would
    /// leave the public static surface leaking for every consumer that reads its own bytes.
    /// </para>
    /// </remarks>
    [Theory]
    [InlineData(@"C:\Users\ci-user\agent\_work\1\s\suites\regression.json", @"C:\Users\ci-user")]
    [InlineData("/home/ci-user/agent/_work/1/s/suites/regression.json", "/home/ci-user")]
    public void LoadFromJson_SourceNameIsAnAbsolutePath_NamesOnlyTheFileNameInEveryFinding(
        string sourceName,
        string disclosure
    )
    {
        var result = SuiteLoader.LoadFromJson("""{ "scenarios": [] }""", sourceName);

        result.Messages.Should().NotBeEmpty();

        foreach (var message in result.Messages)
        {
            message.ToString().Should().NotContain(disclosure).And.Contain("regression.json");
        }
    }

    /// <summary>A label that is already just a file name is passed through unchanged.</summary>
    [Fact]
    public void LoadFromJson_SourceNameIsAlreadyAFileName_NamesItUnchanged()
    {
        var result = SuiteLoader.LoadFromJson("""{ "scenarios": [] }""", "regression.json");

        result.Messages.Should().Contain(message => message.Message.Contains("'regression.json'"));
    }

    /// <summary>A label that reduces to nothing still produces a readable finding.</summary>
    /// <remarks>
    /// <para>
    /// Reducing a label can leave an empty string — a caller passing a bare separator, or a
    /// directory path with a trailing one. A finding reading <c>Suite '' is not valid JSON</c>
    /// would be the usability defect this change is trying not to introduce, so the placeholder
    /// is engine-owned text rather than anything the caller supplied.
    /// </para>
    /// <para>
    /// A bare drive specification is here for the same reason it is handled at all: reducing
    /// <c>C:\</c> by scanning for separators leaves <c>C:</c>, which names no file. It is kept
    /// out because the reduction exists to name a suite, not to print whatever is left over.
    /// </para>
    /// </remarks>
    [Theory]
    [InlineData("/")]
    [InlineData(@"\")]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(@"C:\")]
    [InlineData("C:")]
    [InlineData(@"\\build-host")]
    [InlineData("//build-host")]
    [InlineData(@"\/build-host")]
    [InlineData(@"/\build-host")]
    public void LoadFromJson_SourceNameThatNamesNoFile_StillNamesTheSuiteReadably(string sourceName)
    {
        var result = SuiteLoader.LoadFromJson("{ not json", sourceName);

        var finding = result.Messages.Should().ContainSingle().Subject;

        finding
            .Message.Should()
            .NotContain("''")
            .And.Contain("<unnamed>")
            .And.NotContain(
                "build-host",
                because: "what is left of a bare authority is the name of a machine, in any mix of separators"
            );
    }

    /// <summary>
    /// The reduction reads both separator styles, on every host.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>This is why the reduction does not go through <see cref="Path"/>.</b>
    /// <c>Path.GetFileName</c> is host-dependent: on Windows it treats <c>\</c> and <c>/</c> as
    /// separators, but on Unix <b>only</b> <c>/</c> is one. A Windows-shaped absolute label
    /// therefore comes back <i>intact</i> from a Unix host — the full checkout path, printed into
    /// the log, on exactly the platform most CI runs on. The same class of trap as
    /// <c>FileSystemName.MatchesSimpleExpression</c> treating <c>\</c> as an escape.
    /// </para>
    /// <para>
    /// <b>The Windows host this was written on cannot observe that case</b>, because Windows
    /// handles both separators. The mixed and trailing rows below <i>are</i> observable here and
    /// were failing before the reduction stopped calling <c>Path</c>. The rule the whole theory
    /// pins is the one that makes the host irrelevant: separators are scanned explicitly, so the
    /// answer does not depend on where the test runs.
    /// </para>
    /// </remarks>
    [Theory]
    [InlineData(@"C:\Users\ci-user\agent\_work\1\s\suites\regression.json", "regression.json")]
    [InlineData("/home/ci-user/agent/_work/1/s/suites/regression.json", "regression.json")]
    [InlineData(@"\\build-host\share\suites\regression.json", "regression.json")]
    [InlineData(@"C:\a/b\regression.json", "regression.json")]
    [InlineData("/home/ci-user/a/b//", "b")]
    [InlineData(@"C:\home\ci-user\a\b\\", "b")]
    [InlineData("regression.json", "regression.json")]
    public void LoadFromJson_SourceNameInEitherSeparatorStyle_ReducesToTheFileNameOnEveryHost(
        string sourceName,
        string expected
    )
    {
        var result = SuiteLoader.LoadFromJson("{ not json", sourceName);

        var finding = result.Messages.Should().ContainSingle().Subject;

        finding.Message.Should().Contain($"'{expected}'");
        finding
            .ToString()
            .Should()
            .NotContain("\\", because: "a separator left in the label means a directory came with it")
            .And.NotContain("/", because: "a separator left in the label means a directory came with it");
    }

    // ---------------------------------------------------------------------------------------
    // The path is removed from the message, not from the result. Losing it entirely would trade
    // a disclosure for a usability defect, and a caller that wants to print it under its own
    // policy — as the command-line tool does — has to be able to get it back.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public async Task LoadAsync_SuiteThatFailedToValidate_KeepsTheResolvedPathOnTheResult()
    {
        using var checkout = new CheckoutRoot();
        checkout.Write("suites/unnamed.json", """{ "scenarios": [] }""");

        var loader = new SuiteLoader(checkout.Path);
        var result = await loader.LoadAsync("suites/unnamed.json", CancellationToken.None);

        result.Succeeded.Should().BeFalse();
        result.SourcePath.Should().Be(Path.Combine(loader.RootDirectory, "suites", "unnamed.json"));
    }

    [Fact]
    public async Task LoadAsync_MissingSuite_KeepsTheResolvedPathOnTheResult()
    {
        using var checkout = new CheckoutRoot();

        var loader = new SuiteLoader(checkout.Path);
        var result = await loader.LoadAsync("suites/absent.json", CancellationToken.None);

        result.SourcePath.Should().Be(Path.Combine(loader.RootDirectory, "suites", "absent.json"));
    }

    [Fact]
    public async Task LoadAsync_SuiteThatLoaded_KeepsTheResolvedPathOnTheResult()
    {
        using var checkout = new CheckoutRoot();
        checkout.Write(
            "suites/regression.json",
            $$"""{ "name": "r", "schemaVersion": "1.0", "scenarios": [{{ValidScenario}}] }"""
        );

        var loader = new SuiteLoader(checkout.Path);
        var result = await loader.LoadAsync("suites/regression.json", CancellationToken.None);

        result.Succeeded.Should().BeTrue(because: string.Join("; ", result.Messages));
        result.SourcePath.Should().Be(Path.Combine(loader.RootDirectory, "suites", "regression.json"));
    }

    [Fact]
    public void LoadFromJson_AnySource_KeepsTheSourceNameOnTheResultUnreduced()
    {
        const string SourceName = @"C:\Users\ci-user\agent\_work\1\s\suites\regression.json";

        var result = SuiteLoader.LoadFromJson("""{ "scenarios": [] }""", SourceName);

        result.SourcePath.Should().Be(SourceName);
    }

    /// <summary>
    /// A root-shaped temporary directory: <c>&lt;temp&gt;/&lt;random&gt;/agent/_work/1/s</c>.
    /// </summary>
    /// <remarks>
    /// Shaped like a build-agent checkout on purpose. The temporary directory on a developer
    /// machine already sits under the user profile, so the absolute path genuinely carries the
    /// account name — which is the thing being kept out of the log, and which
    /// <see cref="TempPrefix"/> lets the assertions check for directly.
    /// </remarks>
    private sealed class CheckoutRoot : IDisposable
    {
        private readonly string _scratch;
        private readonly string _real;

        public CheckoutRoot()
        {
            _scratch = System.IO.Path.Combine(System.IO.Path.GetTempPath(), System.IO.Path.GetRandomFileName());
            _real = System.IO.Path.Combine(_scratch, "real");
            Path = System.IO.Path.Combine(_real, "agent", "_work", "1", "s");
            Directory.CreateDirectory(Path);
        }

        /// <summary>Gets the containment root, absolute.</summary>
        public string Path { get; }

        /// <summary>Gets the machine-identifying prefix every finding must stay clear of.</summary>
        public static string TempPrefix => System.IO.Path.TrimEndingDirectorySeparator(System.IO.Path.GetTempPath());

        public void Write(string relativePath, string content)
        {
            var full = System.IO.Path.Combine(Path, relativePath);
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(full)!);
            File.WriteAllText(full, content);
        }

        /// <summary>
        /// Creates a child directory carrying <paramref name="literalName"/> verbatim.
        /// </summary>
        /// <param name="literalName">The name to create, which may contain a backslash.</param>
        /// <returns><see langword="false"/> when this host reads the name as a path instead.</returns>
        /// <remarks>
        /// The full path is checked to still end with the name before anything is created. On
        /// Windows <c>..\draft</c> resolves to a sibling of the root, so without this the attempt
        /// would create a directory <i>outside</i> the checkout rather than skip.
        /// </remarks>
        public bool TryCreateLiteralDirectory(string literalName)
        {
            var candidate = System.IO.Path.Combine(Path, literalName);

            if (!System.IO.Path.GetFullPath(candidate).EndsWith(literalName, StringComparison.Ordinal))
            {
                return false;
            }

            Directory.CreateDirectory(candidate);
            return Directory.Exists(candidate);
        }

        /// <summary>Writes a file into a directory created by <see cref="TryCreateLiteralDirectory"/>.</summary>
        public void WriteLiteral(string literalDirectory, string fileName, string content) =>
            File.WriteAllText(System.IO.Path.Combine(Path, literalDirectory, fileName), content);

        /// <summary>
        /// Exposes the same root through a directory link, giving it a second spelling.
        /// </summary>
        /// <param name="linkedRoot">The root as reached through the link.</param>
        /// <returns><see langword="false"/> when this environment cannot create the link.</returns>
        /// <remarks>
        /// <b>A capability probe has to report incapacity, not raise it.</b> A junction is the
        /// Windows fallback for when symbolic links need a privilege this process does not hold;
        /// there is no equivalent elsewhere, and reaching for <c>cmd.exe</c> on a host that has
        /// none would throw out of the very method whose job is to answer "can this environment
        /// do it?". So the fallback is attempted only on Windows, and it answers with a bool
        /// rather than an exception.
        /// </remarks>
        public bool TryLinkRoot(out string linkedRoot)
        {
            var link = System.IO.Path.Combine(_scratch, "link");
            linkedRoot = System.IO.Path.Combine(link, "agent", "_work", "1", "s");

            try
            {
                Directory.CreateSymbolicLink(link, _real);
            }
            catch (Exception exception) when (exception is UnauthorizedAccessException or IOException)
            {
                if (!OperatingSystem.IsWindows() || !TryCreateJunction(link, _real))
                {
                    return false;
                }
            }

            return Directory.Exists(linkedRoot);
        }

        [System.Runtime.Versioning.SupportedOSPlatform("windows")]
        private static bool TryCreateJunction(string link, string target)
        {
            try
            {
                using var process = System.Diagnostics.Process.Start(
                    new System.Diagnostics.ProcessStartInfo("cmd.exe", ["/c", "mklink", "/J", link, target])
                    {
                        CreateNoWindow = true,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                    }
                );

                process?.WaitForExit();
            }
            catch (System.ComponentModel.Win32Exception)
            {
                return false;
            }

            return Directory.Exists(link);
        }

        public void Dispose()
        {
            // A junction inside the tree makes a recursive delete fail outright with an access
            // error, so the reparse point goes first — non-recursively, which removes the link
            // and never what it points at. Found by a probe whose teardown failed, not by
            // reading: on a machine without the symbolic-link privilege TryLinkRoot falls back
            // to a junction, and this teardown would have thrown there while passing here.
            var link = System.IO.Path.Combine(_scratch, "link");

            if (Directory.Exists(link))
            {
                Directory.Delete(link, recursive: false);
            }

            if (Directory.Exists(_scratch))
            {
                Directory.Delete(_scratch, recursive: true);
            }
        }
    }
}
