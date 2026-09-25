using FluentAssertions;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Tests.Support;

namespace Forge.EvalCli.Tests.Cli;

/// <summary>
/// What a write failure is allowed to say.
/// </summary>
/// <remarks>
/// <b><see cref="ArtifactWriter"/> is the second shared surface the trend command newly reaches.</b>
/// <c>PathGuard</c> was swept for absolute paths and engine prose; this was not, and it produces
/// the messages that fire when a destination stops being writable <i>after</i> the arguments were
/// validated — the window <c>--overwrite</c> cannot cover, because the file was not there when the
/// opt-in would have been asked for. Every one of these reaches stderr and from there the build
/// log (§V).
/// </remarks>
public class ArtifactWriteFailureTests
{
    private const string ArtifactsDirectory = "trend";

    private static async Task SeedAsync(TempWorkspace workspace)
    {
        ComparisonWorkspace.WriteSuite(workspace);
        Directory.CreateDirectory(Path.Combine(workspace.Root, ArtifactsDirectory));

        for (var day = 1; day <= 2; day++)
        {
            await using var endpoint = ComparisonWorkspace.Endpoint();

            using var console = new RecordingConsole();

            var code = await RunCommand.ExecuteAsync(
                RunPlan.Create(
                    new RunRequest
                    {
                        Suite = "eval-suites/regression.json",
                        Root = workspace.Root,
                        Out = $"{ArtifactsDirectory}/run-{day}.json",
                        Endpoint = endpoint.Address.ToString(),
                        RestExchange = "json",
                    }
                ),
                console,
                CancellationToken.None
            );

            code.Should().Be(ExitCode.Success, console.StandardError);

            var path = Path.Combine(workspace.Root, ArtifactsDirectory, $"run-{day}.json");
            var artifact = Forge.EvalEngine.Serialization.CanonicalJson.DeserializeSuiteResult(
                await File.ReadAllTextAsync(path)
            );

            await File.WriteAllTextAsync(
                path,
                Forge.EvalEngine.Serialization.CanonicalJson.Serialize(
                    artifact with
                    {
                        Environment = artifact.Environment with { Timestamp = TrendFixture.Start.AddDays(day - 1) },
                    }
                )
            );
        }
    }

    [Fact]
    public async Task WriteAsync_WhenTheDestinationAppearsAfterTheArgumentsWereValidated_NamesItRelatively()
    {
        // The window --overwrite cannot cover: nothing was there when the opt-in would have been
        // asked for, and a file exists by the time the rename happens. The refusal is correct;
        // what it prints is the finding.
        using var workspace = new TempWorkspace();

        await SeedAsync(workspace);

        Directory.CreateDirectory(Path.Combine(workspace.Root, "out"));

        var plan = TrendPlan.Create(
            new TrendRequest
            {
                Artifacts = ArtifactsDirectory,
                Root = workspace.Root,
                ReportMarkdown = "out/trend.md",
            }
        );

        await File.WriteAllTextAsync(Path.Combine(workspace.Root, "out", "trend.md"), "appeared in between");

        using var console = new RecordingConsole();

        var refusal = await Assert.ThrowsAsync<EvalCliException>(() =>
            TrendCommand.ExecuteAsync(plan, console, CancellationToken.None)
        );

        refusal.ExitCode.Should().Be(ExitCode.RunFailed);
        (refusal.Message + refusal.Remedy).Should().NotContain(workspace.Root);
        refusal.Message.Should().Contain("out/trend.md");

        // The file that was already there is untouched.
        (await File.ReadAllTextAsync(Path.Combine(workspace.Root, "out", "trend.md")))
            .Should()
            .Be("appeared in between");
    }

    [Fact]
    public async Task WriteAsync_WhenTheDestinationAppearsAfterValidation_ForwardsNoOperatingSystemProse()
    {
        using var workspace = new TempWorkspace();

        await SeedAsync(workspace);

        Directory.CreateDirectory(Path.Combine(workspace.Root, "out"));

        var plan = TrendPlan.Create(
            new TrendRequest
            {
                Artifacts = ArtifactsDirectory,
                Root = workspace.Root,
                ReportMarkdown = "out/trend.md",
            }
        );

        await File.WriteAllTextAsync(Path.Combine(workspace.Root, "out", "trend.md"), "appeared in between");

        using var console = new RecordingConsole();

        var refusal = await Assert.ThrowsAsync<EvalCliException>(() =>
            TrendCommand.ExecuteAsync(plan, console, CancellationToken.None)
        );

        refusal.Message.Should().Contain("the file system refused the write");
        refusal.Remedy.Should().Contain("--overwrite");
    }

    [Fact]
    public async Task WriteAsync_WhenTheStagedFileIsExchangedBeforeItsIdentityIsChecked_LeavesTheExchangedFileAlone()
    {
        // **The guard refuses to publish a file it cannot identify; the cleanup must not then
        // delete it.** The refusal is about the staged pathname no longer denoting this run's
        // bytes — and unlinking that same pathname afterwards destroys exactly the thing the
        // refusal was about, by name, after identity has already failed.
        using var workspace = new TempWorkspace();

        Directory.CreateDirectory(Path.Combine(workspace.Root, "out"));

        var destination = Path.Combine(workspace.Root, "out", "report.md");
        var staged = destination + ArtifactWriter.StagedSuffix;

        var refusal = await Assert.ThrowsAsync<EvalCliException>(() =>
            Published(
                Write(
                    workspace,
                    destination,
                    afterStaging: async token => await File.WriteAllTextAsync(staged, "somebody else's bytes", token)
                ),
                CancellationToken.None
            )
        );

        refusal.Message.Should().Contain("is not the one this run");
        File.Exists(staged).Should().BeTrue("a file this run could not identify is not this run's to delete");
        (await File.ReadAllTextAsync(staged)).Should().Be("somebody else's bytes");
        File.Exists(destination).Should().BeFalse();

        // And the caller is told. A file left on disk and not mentioned is the same silence this
        // repository keeps designing against, one directory over: it would be found later with
        // nothing to attach it to.
        refusal.Remedy.Should().Contain("A staged file remains at").And.Contain("out/report.md.partial");
        refusal.Remedy.Should().NotContain(workspace.Root);
    }

    [Fact]
    public async Task WriteAsync_WhenTheStagedPathIsRedirectedOutOfTheRoot_DeletesNothingThere()
    {
        // The damage the previous test's rule prevents, constructed rather than argued. The
        // parent directory is exchanged for a link out of the root while the write is in flight,
        // so the staged pathname now denotes a file the caller never named and that no argument
        // points at. Deleting by pathname would remove it.
        using var workspace = new TempWorkspace();

        Directory.CreateDirectory(Path.Combine(workspace.Root, "out"));

        var destination = Path.Combine(workspace.Root, "out", "report.md");
        var staged = destination + ArtifactWriter.StagedSuffix;
        var bystander = Path.Combine(workspace.Outside, "report.md" + ArtifactWriter.StagedSuffix);

        await Assert.ThrowsAnyAsync<Exception>(() =>
            Published(
                Write(
                    workspace,
                    destination,
                    afterStaging: async token =>
                    {
                        await File.WriteAllTextAsync(bystander, "not this tool's to touch", token);

                        Directory.Delete(Path.Combine(workspace.Root, "out"), recursive: true);
                        workspace.CreateDirectoryLink("out", workspace.Outside);
                    }
                ),
                CancellationToken.None
            )
        );

        File.Exists(bystander).Should().BeTrue("nothing outside the root may be unlinked by a cleanup");
        (await File.ReadAllTextAsync(bystander)).Should().Be("not this tool's to touch");
        File.Exists(staged).Should().BeTrue("the redirected pathname resolves to the bystander");
    }

    [Fact]
    public async Task WriteAsync_WhenInterruptedBeforeIdentityIsConfirmed_LeavesTheStagedFileForInspection()
    {
        // Identity was never established, so the pathname cannot be said to denote this run's
        // file. A stray `.partial` a human can inspect is the better outcome, and the name is
        // derived from the destination so the next attempt refuses to stage over it and says so.
        using var workspace = new TempWorkspace();

        Directory.CreateDirectory(Path.Combine(workspace.Root, "out"));

        var destination = Path.Combine(workspace.Root, "out", "report.md");
        var staged = destination + ArtifactWriter.StagedSuffix;

        using var source = new CancellationTokenSource();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            Published(Write(workspace, destination, afterStaging: async _ => await source.CancelAsync()), source.Token)
        );

        File.Exists(staged).Should().BeTrue();
        File.Exists(destination).Should().BeFalse();
    }

    [Fact]
    public async Task WriteAsync_WhenPublicationFailsAfterIdentityWasConfirmed_StillRemovesTheStagedFile()
    {
        // The other half of the rule: where ownership *was* established a moment earlier, the
        // staged file is this run's to clean up, and leaving one behind on every ordinary
        // collision would be litter rather than caution.
        using var workspace = new TempWorkspace();

        Directory.CreateDirectory(Path.Combine(workspace.Root, "out"));

        var destination = Path.Combine(workspace.Root, "out", "report.md");
        var staged = destination + ArtifactWriter.StagedSuffix;

        await File.WriteAllTextAsync(destination, "appeared after the arguments were validated");

        await Assert.ThrowsAsync<EvalCliException>(() =>
            Published(Write(workspace, destination), CancellationToken.None)
        );

        File.Exists(staged).Should().BeFalse();
        (await File.ReadAllTextAsync(destination)).Should().Be("appeared after the arguments were validated");
    }

    [Fact]
    public async Task WriteAsync_WhenItSucceeds_LeavesNoStagedFileBehind()
    {
        using var workspace = new TempWorkspace();

        Directory.CreateDirectory(Path.Combine(workspace.Root, "out"));

        var destination = Path.Combine(workspace.Root, "out", "report.md");

        await Published(Write(workspace, destination), CancellationToken.None);

        File.Exists(destination + ArtifactWriter.StagedSuffix).Should().BeFalse();
        (await File.ReadAllTextAsync(destination)).Should().Be(Contents);
    }

    [Fact]
    public async Task WriteAsync_WhenTheRootHasGoneAwayByTheTimeOfTheWrite_DoesNotRepeatIt()
    {
        // The writer re-resolves the root it was handed, and that root came from a plan rather
        // than from an argument. Its refusal must say so rather than echoing a machine path.
        using var workspace = new TempWorkspace();

        var vanished = Path.Combine(workspace.Root, "vanished");

        Directory.CreateDirectory(vanished);

        var write = Write(workspace, Path.Combine(vanished, "report.md")) with { RootDirectory = vanished };

        Directory.Delete(vanished, recursive: true);

        var refusal = await Assert.ThrowsAsync<EvalCliException>(() => Published(write, CancellationToken.None));

        refusal.Message.Should().Contain("not repeated");
        (refusal.Message + refusal.Remedy).Should().NotContain(workspace.Root);
    }

    [Fact]
    public async Task WriteAsync_WhenTheStagedPathIsRedirectedToAFileWithIdenticalBytes_DeletesNothingThere()
    {
        // **The case the content hash cannot catch, and the one the seam exists for.** The
        // previous test exchanges *different* bytes, which the fingerprint sees. Equal bytes at a
        // redirected pathname match it exactly — and a fact about bytes is not a fact about
        // *where*. Two files with the same content are indistinguishable to a hash and are not
        // the same file, so ownership must be re-established by containment as well before
        // anything is published or removed.
        using var workspace = new TempWorkspace();

        Directory.CreateDirectory(Path.Combine(workspace.Root, "out"));

        var destination = Path.Combine(workspace.Root, "out", "report.md");
        var bystander = Path.Combine(workspace.Outside, "report.md" + ArtifactWriter.StagedSuffix);
        var occupied = Path.Combine(workspace.Outside, "report.md");

        await Assert.ThrowsAnyAsync<Exception>(() =>
            Published(
                Write(
                    workspace,
                    destination,
                    afterStaging: async token =>
                    {
                        // Same bytes this run wrote, so the fingerprint agrees.
                        await File.WriteAllTextAsync(bystander, Contents, token);

                        // And something already at the destination the redirect leads to, so
                        // publication fails and the cleanup is the path under test.
                        await File.WriteAllTextAsync(occupied, "not this tool's to touch", token);

                        Directory.Delete(Path.Combine(workspace.Root, "out"), recursive: true);
                        workspace.CreateDirectoryLink("out", workspace.Outside);
                    }
                ),
                CancellationToken.None
            )
        );

        File.Exists(bystander).Should().BeTrue("matching bytes do not make a redirected path this run's to unlink");
        (await File.ReadAllTextAsync(bystander)).Should().Be(Contents);
        (await File.ReadAllTextAsync(occupied)).Should().Be("not this tool's to touch");
    }

    [Fact]
    public async Task WriteAsync_WhenTheStagedPathIsRedirectedToAFileWithIdenticalBytes_PublishesNothingOutsideTheRoot()
    {
        // **The live half of the same defect.** The test above pre-occupies the redirected
        // destination so publication fails and the cleanup is what gets exercised — and the
        // cleanup already re-asserts containment. With nothing in the way, a `Confirmed` reached
        // on a content match alone goes straight on to rename the file **outside the root**. A
        // fact about bytes is not a fact about where.
        using var workspace = new TempWorkspace();

        Directory.CreateDirectory(Path.Combine(workspace.Root, "out"));

        var destination = Path.Combine(workspace.Root, "out", "report.md");
        var bystander = Path.Combine(workspace.Outside, "report.md" + ArtifactWriter.StagedSuffix);
        var outside = Path.Combine(workspace.Outside, "report.md");

        await Assert.ThrowsAnyAsync<Exception>(() =>
            Published(
                Write(
                    workspace,
                    destination,
                    afterStaging: async token =>
                    {
                        await File.WriteAllTextAsync(bystander, Contents, token);

                        Directory.Delete(Path.Combine(workspace.Root, "out"), recursive: true);
                        workspace.CreateDirectoryLink("out", workspace.Outside);
                    }
                ),
                CancellationToken.None
            )
        );

        File.Exists(outside).Should().BeFalse("nothing may be published outside the root");
        File.Exists(bystander).Should().BeTrue();
    }

    [Fact]
    public async Task WriteAsync_WhenTheTokenIsAlreadyCancelled_StagesNothingAtAll()
    {
        using var workspace = new TempWorkspace();

        Directory.CreateDirectory(Path.Combine(workspace.Root, "out"));

        var destination = Path.Combine(workspace.Root, "out", "report.md");

        using var source = new CancellationTokenSource();

        await source.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            Published(Write(workspace, destination), source.Token)
        );

        File.Exists(destination + ArtifactWriter.StagedSuffix)
            .Should()
            .BeFalse("an invocation cancelled before it started has nothing to leave behind");
    }

    [Fact]
    public async Task WriteAsync_WhenCancelledAfterStaging_TellsTheCallerWhatWasLeftBehind()
    {
        // **Asserted on the diagnostic the caller reads, not on the internal state.** The blanket
        // interruption sentence is two claims and only the first is always true; a `.partial` on
        // disk with "nothing was written" printed over it sends somebody past the file they now
        // have. This is the fifth instance of that shape in this tool — the cleanup path created
        // a new one after T14 swept for a fourth and correctly found none.
        using var workspace = new TempWorkspace();

        Directory.CreateDirectory(Path.Combine(workspace.Root, "out"));

        var destination = Path.Combine(workspace.Root, "out", "report.md");
        var staged = destination + ArtifactWriter.StagedSuffix;

        using var source = new CancellationTokenSource();

        var interrupted = await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            Published(Write(workspace, destination, afterStaging: async _ => await source.CancelAsync()), source.Token)
        );

        File.Exists(staged).Should().BeTrue();

        using var console = new RecordingConsole();

        ExitCodeReporter.Report(interrupted, console).Should().Be(ExitCode.Interrupted);

        console.StandardError.Should().NotContain("nothing was written");
        console.StandardError.Should().Contain("out/report.md.partial").And.NotContain(workspace.Root);
    }

    [Fact]
    public async Task WriteAsync_WhenOnlyTheDestinationLeafBecomesALink_IsStillRefused()
    {
        // The stage and the destination share a parent, so a redirect above them is caught by a
        // check on either one. A link at the *destination leaf* moves only that path — and the
        // stage's own check would pass it straight through to publication.
        using var workspace = new TempWorkspace();

        Directory.CreateDirectory(Path.Combine(workspace.Root, "out"));

        var destination = Path.Combine(workspace.Root, "out", "report.md");
        var outside = Path.Combine(workspace.Outside, "report.md");

        await File.WriteAllTextAsync(outside, "not this tool's to touch");

        await Assert.ThrowsAnyAsync<Exception>(() =>
            Published(
                Write(
                    workspace,
                    destination,
                    afterStaging: _ =>
                    {
                        File.CreateSymbolicLink(destination, outside);

                        return Task.CompletedTask;
                    }
                ),
                CancellationToken.None
            )
        );

        (await File.ReadAllTextAsync(outside)).Should().Be("not this tool's to touch");
    }

    [Fact]
    public async Task WriteAsync_WhenOnlyTheStagedLeafBecomesALink_IsStillRefused()
    {
        // The mirror: a link at the *staged leaf*, pointing at a file whose bytes match, so the
        // fingerprint agrees and only a containment check on the stage can tell. Publishing it
        // would move the link into the destination and leave something inside the root that reads
        // out of it.
        using var workspace = new TempWorkspace();

        Directory.CreateDirectory(Path.Combine(workspace.Root, "out"));

        var destination = Path.Combine(workspace.Root, "out", "report.md");
        var staged = destination + ArtifactWriter.StagedSuffix;
        var outside = Path.Combine(workspace.Outside, "identical.md");

        await Assert.ThrowsAnyAsync<Exception>(() =>
            Published(
                Write(
                    workspace,
                    destination,
                    afterStaging: async token =>
                    {
                        await File.WriteAllTextAsync(outside, Contents, token);

                        File.Delete(staged);
                        File.CreateSymbolicLink(staged, outside);
                    }
                ),
                CancellationToken.None
            )
        );

        File.Exists(destination).Should().BeFalse("a link out of the root is not a file to publish");
        (await File.ReadAllTextAsync(outside)).Should().Be(Contents);
    }

    [Fact]
    public async Task Discard_WhenTheStagedPathNoLongerResolvesInsideTheRoot_RemovesNothing()
    {
        // The cleanup re-asserts containment immediately before unlinking, which covers the
        // window between the pre-publication recheck and the `finally`. Nothing in the command
        // can be made to move a path inside that window, so the guard is exercised directly
        // rather than left as protection nothing can demonstrate.
        using var workspace = new TempWorkspace();

        var bystander = Path.Combine(workspace.Outside, "report.md" + ArtifactWriter.StagedSuffix);

        await File.WriteAllTextAsync(bystander, "not this tool's to touch");

        workspace.CreateDirectoryLink("linked", workspace.Outside);

        var guard = PathGuard.ForRoot(PathValue.FromArgument(workspace.Root), "--root");
        var staged = Path.Combine(workspace.Root, "linked", "report.md" + ArtifactWriter.StagedSuffix);

        ArtifactWriter.Discard(guard, staged, Write(workspace, Path.Combine(workspace.Root, "out", "report.md")));

        File.Exists(bystander).Should().BeTrue();
        (await File.ReadAllTextAsync(bystander)).Should().Be("not this tool's to touch");
    }

    [Fact]
    public async Task Discard_WhenTheStagedPathIsAPlainFileInsideTheRoot_RemovesIt()
    {
        using var workspace = new TempWorkspace();

        Directory.CreateDirectory(Path.Combine(workspace.Root, "out"));

        var staged = Path.Combine(workspace.Root, "out", "report.md" + ArtifactWriter.StagedSuffix);

        await File.WriteAllTextAsync(staged, Contents);

        var guard = PathGuard.ForRoot(PathValue.FromArgument(workspace.Root), "--root");

        ArtifactWriter.Discard(guard, staged, Write(workspace, Path.Combine(workspace.Root, "out", "report.md")));

        File.Exists(staged).Should().BeFalse();
    }

    [Fact]
    public async Task WriteAsync_WhenAVerifiedReplacementsDestinationBecomesALink_RefusesRatherThanReplacingThrough()
    {
        // **Where the destination's own recheck earns its place.** Under `CreateOnly` a link at
        // the destination leaf is refused by the operating system anyway, so the check looks
        // redundant from `trend`. Under `ReplaceVerified` — which is `baseline update --apply`,
        // the genuinely destructive command — the target is fingerprinted *through* the link, and
        // a copy outside the root with matching bytes satisfies that check exactly. Replacing
        // then writes out of the root over a file nobody named.
        using var workspace = new TempWorkspace();

        Directory.CreateDirectory(Path.Combine(workspace.Root, "out"));

        const string Vouched = "baseline bytes";

        var destination = Path.Combine(workspace.Root, "out", "report.md");
        var outside = Path.Combine(workspace.Outside, "report.md");

        await File.WriteAllTextAsync(destination, Vouched);
        await File.WriteAllTextAsync(outside, Vouched);

        var write = Write(
            workspace,
            destination,
            afterStaging: _ =>
            {
                File.Delete(destination);
                File.CreateSymbolicLink(destination, outside);

                return Task.CompletedTask;
            }
        ) with
        {
            Publication = ArtifactPublication.ReplaceVerified,
            RequiredTarget = new ArtifactTarget
            {
                ContentHash = ArtifactTarget.Fingerprint(Vouched),
                Vouched = "the baseline this run read",
                AbsentExitCode = ExitCode.BaselineMissing,
            },
        };

        await Assert.ThrowsAnyAsync<Exception>(() => Published(write, CancellationToken.None));

        (await File.ReadAllTextAsync(outside)).Should().Be(Vouched, "nothing outside the root may be replaced");
    }

    [Theory]
    [InlineData("CreateOnly", "was written")]
    [InlineData("CreateOrReplace", "may have replaced")]
    [InlineData("ReplaceVerified", "was replaced with this run")]
    public async Task WriteAsync_RecordsWhatThePublicationActuallyLicenses(string mode, string expected)
    {
        // **The verb is derived from the publication so a replacement and a creation cannot read
        // alike** — and for two of the three it was deriving the same word. `CreateOnly` cannot
        // have replaced anything: the mode refuses if a file is there. `ReplaceVerified` replaced
        // a specific file this run vouched for, which is known. `CreateOrReplace` is neither —
        // the opt-in was in force and whether a file was there is not something this can say, so
        // it says that rather than claiming either.
        //
        // The mode is named rather than passed: `ArtifactPublication` is internal, so a public
        // theory parameter cannot carry one.
        var publication = Enum.Parse<ArtifactPublication>(mode);

        using var workspace = new TempWorkspace();

        Directory.CreateDirectory(Path.Combine(workspace.Root, "out"));

        var destination = Path.Combine(workspace.Root, "out", "report.md");

        if (publication is not ArtifactPublication.CreateOnly)
        {
            await File.WriteAllTextAsync(destination, Contents);
        }

        var write = Write(workspace, destination) with
        {
            Publication = publication,
            RequiredTarget =
                publication is ArtifactPublication.ReplaceVerified
                    ? new ArtifactTarget
                    {
                        ContentHash = ArtifactTarget.Fingerprint(Contents),
                        Vouched = "the file this run read",
                        AbsentExitCode = ExitCode.BaselineMissing,
                    }
                    : null,
        };

        var interrupted = await Interrupted(write);

        interrupted.WhatWasWritten.Should().Contain(expected).And.Contain("out/report.md");
    }

    [Fact]
    public async Task WriteAsync_WhenTheModeRefusesToReplace_NeverSuggestsItMightHave()
    {
        using var workspace = new TempWorkspace();

        Directory.CreateDirectory(Path.Combine(workspace.Root, "out"));

        var interrupted = await Interrupted(Write(workspace, Path.Combine(workspace.Root, "out", "report.md")));

        interrupted.WhatWasWritten.Should().NotContain("replace");
    }

    /// <summary>Publishes, then interrupts, so the clause the ledger recorded can be read.</summary>
    private static async Task<InterruptedAfterWritingException> Interrupted(ArtifactWrite write) =>
        await Assert.ThrowsAsync<InterruptedAfterWritingException>(() =>
            DurableWrites.GuardAsync<string>(async written =>
            {
                await ArtifactWriter.WriteAsync(write, written, CancellationToken.None);

                throw new OperationCanceledException();
            })
        );

    /// <summary>
    /// A write, through the guard that production always wraps one in.
    /// </summary>
    /// <remarks>
    /// Calling <c>ArtifactWriter.WriteAsync</c> bare would test the writer in a configuration no
    /// command uses. The ledger and the catch are issued together by <c>DurableWrites</c>, so a
    /// test that wants one gets both — which is the property, exercised rather than described.
    /// </remarks>
    private static Task<string> Published(ArtifactWrite write, CancellationToken cancellationToken) =>
        DurableWrites.GuardAsync(written => ArtifactWriter.WriteAsync(write, written, cancellationToken));

    private const string Contents = "# trend\n";

    private static ArtifactWrite Write(
        TempWorkspace workspace,
        string destination,
        Func<CancellationToken, Task>? afterStaging = null
    ) =>
        new()
        {
            Destination = destination,
            RootDirectory = Path.TrimEndingDirectorySeparator(workspace.Root),
            OptionName = "--report-markdown",
            ReplaceOptionName = "--overwrite",
            Publication = ArtifactPublication.CreateOnly,
            Contents = Contents,
            FailureContext = "The trend was produced but its report could not be written",
            LossNote = "The artifacts it was read from are untouched",
            DurableNote = "the trend report",
            AfterStaging = afterStaging,
        };
}
