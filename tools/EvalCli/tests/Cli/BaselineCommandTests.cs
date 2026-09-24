using System.Text.Json;
using FluentAssertions;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Tests.Support;

namespace Forge.EvalCli.Tests.Cli;

/// <summary>
/// The destructive command. Every test here is ultimately about one question: did the committed
/// baseline survive?
/// </summary>
/// <remarks>
/// The assertions are written against the <b>bytes on disk</b> rather than against a return value
/// or a message, because the message is not what a developer loses. A command that printed
/// "nothing was written" and had written is precisely the defect these exist to catch, and only
/// reading the file back can tell the two apart.
/// </remarks>
public class BaselineCommandTests
{
    private static RunPlan Plan(TempWorkspace workspace, StubEndpoint endpoint, bool apply) =>
        RunPlan.CreateForBaselineUpdate(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = workspace.Root,
                Baseline = "artifacts/baseline.json",
                Endpoint = endpoint.Address.ToString(),
                RestExchange = "json",
                Apply = apply,
            }
        );

    /// <summary>Produces a real baseline at artifacts/baseline.json by conducting the suite.</summary>
    private static async Task<string> SeedBaselineAsync(TempWorkspace workspace, StubEndpoint endpoint)
    {
        using var console = new RecordingConsole();

        var plan = RunPlan.Create(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = workspace.Root,
                Out = "artifacts/baseline.json",
                Endpoint = endpoint.Address.ToString(),
                RestExchange = "json",
            }
        );

        var code = await RunCommand.ExecuteAsync(plan, console, CancellationToken.None);

        code.Should().Be(ExitCode.Success, console.StandardError);

        return Path.Combine(workspace.Root, "artifacts", "baseline.json");
    }

    [Fact]
    public async Task ExecuteAsync_WithoutTheOptIn_WritesNothingAndLeavesTheBaselineByteForByte()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var original = ComparisonWorkspace.Endpoint();

        var path = await SeedBaselineAsync(workspace, original);
        var before = await File.ReadAllBytesAsync(path, CancellationToken.None);

        // The system under test now behaves differently, so the replacement really would differ.
        // Without that, "unchanged" would be indistinguishable from "wrote the same bytes back".
        await using var changed = ComparisonWorkspace.Endpoint(ComparisonWorkspace.Checkout);
        using var console = new RecordingConsole();

        var code = await BaselineCommand.ExecuteAsync(
            Plan(workspace, changed, apply: false),
            console,
            CancellationToken.None
        );

        code.Should().Be(ExitCode.Success, console.StandardError);

        // The single most valuable assertion in this kind: the default invocation of the
        // destructive command did not destroy anything.
        (await File.ReadAllBytesAsync(path, CancellationToken.None))
            .Should()
            .Equal(before, "the default invocation of a destructive command must not write");

        console.StandardOut.Should().Contain("preview").And.Contain("Nothing was written");
        console.StandardOut.Should().Contain("--apply");

        // And nothing was staged and left behind either.
        Directory
            .EnumerateFiles(Path.Combine(workspace.Root, "artifacts"))
            .Should()
            .ContainSingle("a preview must not leave a staged file behind");
    }

    [Fact]
    public async Task ExecuteAsync_WithoutTheOptIn_StillReportsTheDiffShapeItWouldApply()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var original = ComparisonWorkspace.Endpoint();

        await SeedBaselineAsync(workspace, original);

        await using var changed = ComparisonWorkspace.Endpoint(ComparisonWorkspace.Checkout);
        using var console = new RecordingConsole();

        await BaselineCommand.ExecuteAsync(
            Plan(workspace, changed, apply: false) with
            {
                Json = true,
            },
            console,
            CancellationToken.None
        );

        using var report = JsonDocument.Parse(console.StandardOut);
        var root = report.RootElement;

        // "Will overwrite" says nothing about how consequential the replacement is. The shape of
        // the diff does.
        root.GetProperty("applied").GetBoolean().Should().BeFalse();
        root.GetProperty("scenariosChanged").GetInt32().Should().Be(1);
        root.GetProperty("regressed").EnumerateArray().Select(e => e.GetString()).Should().Equal("checkout");
        root.GetProperty("classificationCounts").GetProperty("stable-pass").GetInt32().Should().Be(1);
    }

    [Fact]
    public async Task ExecuteAsync_WithTheOptIn_ReplacesTheBaselineWithTheRunItJustConducted()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var original = ComparisonWorkspace.Endpoint();

        var path = await SeedBaselineAsync(workspace, original);
        var before = await File.ReadAllTextAsync(path, CancellationToken.None);

        await using var changed = ComparisonWorkspace.Endpoint(ComparisonWorkspace.Checkout);
        using var console = new RecordingConsole();

        var code = await BaselineCommand.ExecuteAsync(
            Plan(workspace, changed, apply: true),
            console,
            CancellationToken.None
        );

        code.Should().Be(ExitCode.Success, console.StandardError);

        var after = await File.ReadAllTextAsync(path, CancellationToken.None);

        after.Should().NotBe(before, "--apply is the opt-in, and it must actually do the thing");
        console.StandardOut.Should().Contain("Baseline replaced");

        // The replacement is a real artifact: comparing the new baseline against a run of the
        // same behaviour now finds no change at all.
        using var second = new RecordingConsole();

        await BaselineCommand.ExecuteAsync(
            Plan(workspace, changed, apply: false) with
            {
                Json = true,
            },
            second,
            CancellationToken.None
        );

        using var report = JsonDocument.Parse(second.StandardOut);

        report.RootElement.GetProperty("scenariosChanged").GetInt32().Should().Be(0);
    }

    [Fact]
    public void CreateForBaselineUpdate_WhenTheBaselineDoesNotExist_RefusesAsBaselineMissingAndCreatesNothing()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        var act = () =>
            RunPlan.CreateForBaselineUpdate(
                new RunRequest
                {
                    Suite = "eval-suites/regression.json",
                    Root = workspace.Root,
                    Baseline = "artifacts/baselne.json",
                    Apply = true,
                }
            );

        // This command replaces a baseline and never creates one. A typo would otherwise write a
        // plausible baseline somewhere nobody reads while the real one stayed stale — so it is
        // the missing-baseline code, not a generic usage error, and nothing is created.
        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.BaselineMissing);

        File.Exists(Path.Combine(workspace.Root, "artifacts", "baselne.json")).Should().BeFalse();
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheBaselineIsARunOfAnotherSuite_RefusesRatherThanReplacingIt()
    {
        using var workspace = new TempWorkspace();

        // Seed a baseline for a suite called "other", then point the update at it while running
        // the suite called "regression".
        workspace.WriteFile(
            Path.Combine("eval-suites", "regression.json"),
            SuiteFixture.Suite(
                "other",
                SuiteFixture.Scenario(
                    ComparisonWorkspace.Checkout,
                    expectedOutcome: ComparisonWorkspace.ExpectedOutcome
                )
            )
        );

        await using var endpoint = ComparisonWorkspace.Endpoint();

        var path = await SeedBaselineAsync(workspace, endpoint);
        var before = await File.ReadAllTextAsync(path, CancellationToken.None);

        ComparisonWorkspace.WriteSuite(workspace);

        using var console = new RecordingConsole();

        var act = async () =>
            await BaselineCommand.ExecuteAsync(Plan(workspace, endpoint, apply: true), console, CancellationToken.None);

        var refusal = await act.Should().ThrowAsync<EvalCliException>();

        // Naming a baseline that belongs to another suite is not a regression, it is the wrong
        // file — and replacing it destroys evidence for a suite this run never evaluated.
        refusal.Which.ExitCode.Should().Be(ExitCode.ComparisonRefused);
        (await File.ReadAllTextAsync(path, CancellationToken.None)).Should().Be(before);
    }

    [Fact]
    public async Task ExecuteAsync_WhenARunWasRecordedAsAnError_RefusesToCommitItAsABaseline()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var endpoint = ComparisonWorkspace.Endpoint();

        var path = await SeedBaselineAsync(workspace, endpoint);
        var before = await File.ReadAllTextAsync(path, CancellationToken.None);

        // No --rest-exchange, so nothing conducts the REST scenarios and the engine records the
        // gap as a harness failure on every one of them.
        var plan = RunPlan.CreateForBaselineUpdate(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = workspace.Root,
                Baseline = "artifacts/baseline.json",
                Apply = true,
            }
        );

        using var console = new RecordingConsole();

        var act = async () => await BaselineCommand.ExecuteAsync(plan, console, CancellationToken.None);
        var refusal = await act.Should().ThrowAsync<EvalCliException>();

        // A baseline carrying an errored run makes every later comparison of that scenario
        // unanswerable, forever. Refused before the write rather than committed.
        refusal.Which.ExitCode.Should().Be(ExitCode.RunFailed);
        refusal.Which.Message.Should().Contain("not a baseline");
        (await File.ReadAllTextAsync(path, CancellationToken.None)).Should().Be(before);
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheBaselineBecomesUnreadableBeforeTheRun_RefusesBeforeConductingAnything()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var seeding = ComparisonWorkspace.Endpoint();

        await SeedBaselineAsync(workspace, seeding);

        var bystander = Path.Combine(workspace.Outside, "baseline.json");

        await File.WriteAllTextAsync(bystander, "somebody else's file", CancellationToken.None);

        var plan = Plan(workspace, seeding, apply: true);

        // The directory is swapped for a link out of the root between validation and execution,
        // so --baseline now resolves outside it. The baseline is read before the suite is
        // conducted precisely so this costs nothing: a baseline that cannot be read is a reason
        // to stop, not a reason to spend a run finding out.
        Directory.Delete(Path.Combine(workspace.Root, "artifacts"), recursive: true);
        workspace.CreateDirectoryLink("artifacts", workspace.Outside);

        await using var endpoint = ComparisonWorkspace.Endpoint();
        using var console = new RecordingConsole();

        var act = async () =>
            await BaselineCommand.ExecuteAsync(
                plan with
                {
                    Endpoint = endpoint.Address,
                    EndpointDisplay = endpoint.Address.ToString(),
                },
                console,
                CancellationToken.None
            );

        (await act.Should().ThrowAsync<EvalCliException>()).Which.ExitCode.Should().Be(ExitCode.UsageError);

        endpoint.Requests.Should().Be(0, "nothing should be conducted once the baseline cannot be read");

        (await File.ReadAllTextAsync(bystander, CancellationToken.None)).Should().Be("somebody else's file");
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheBaselinePathBecomesALinkDuringTheRun_ReplacesNothingOutsideTheRoot()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var seeding = ComparisonWorkspace.Endpoint();

        await SeedBaselineAsync(workspace, seeding);

        var bystander = Path.Combine(workspace.Outside, "baseline.json");

        await File.WriteAllTextAsync(bystander, "somebody else's file", CancellationToken.None);

        // The swap happens from inside the run, on the first request the suite makes. That is the
        // window a check before the run cannot close: the baseline path was validated against a
        // real directory, the suite then took as long as the system under test does, and the path
        // to the destination moved in between. Doing it here rather than before the call is what
        // makes this a test of the re-verification at the moment of the write.
        var swapped = false;

        await using var endpoint = new StubEndpoint(_ =>
        {
            if (!swapped)
            {
                swapped = true;

                Directory.Delete(Path.Combine(workspace.Root, "artifacts"), recursive: true);
                workspace.CreateDirectoryLink("artifacts", workspace.Outside);
            }

            return (200, $"{{ \"output\": \"ok\", \"outcome\": \"{ComparisonWorkspace.ExpectedOutcome}\" }}");
        });

        var plan = Plan(workspace, endpoint, apply: true);

        using var console = new RecordingConsole();

        var act = async () => await BaselineCommand.ExecuteAsync(plan, console, CancellationToken.None);

        (await act.Should().ThrowAsync<EvalCliException>()).Which.ExitCode.Should().Be(ExitCode.RunFailed);

        swapped.Should().BeTrue("the test is only meaningful if the swap actually happened mid-run");

        (await File.ReadAllTextAsync(bystander, CancellationToken.None))
            .Should()
            .Be("somebody else's file", "--apply replaces the baseline inside the root, not whatever a link leads to");
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheBaselineIsDeletedDuringTheRun_RefusesRatherThanCreatingOne()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var seeding = ComparisonWorkspace.Endpoint();

        var path = await SeedBaselineAsync(workspace, seeding);

        // Deleted from inside the run, which is the window a check before the run cannot close:
        // the baseline was read and vouched for, the suite then took as long as the system under
        // test does, and the file went away in between.
        var deleted = false;

        await using var endpoint = new StubEndpoint(_ =>
        {
            if (!deleted)
            {
                deleted = true;
                File.Delete(path);
            }

            return new StubReply
            {
                Status = 200,
                Body = $"{{ \"output\": \"ok\", \"outcome\": \"{ComparisonWorkspace.ExpectedOutcome}\" }}",
            };
        });

        using var console = new RecordingConsole();

        var act = async () =>
            await BaselineCommand.ExecuteAsync(Plan(workspace, endpoint, apply: true), console, CancellationToken.None);

        var refusal = await act.Should().ThrowAsync<EvalCliException>();

        deleted.Should().BeTrue("the test is only meaningful if the deletion actually happened mid-run");

        // This command replaces a baseline and never creates one. A replacing move that does not
        // require its target to still be there turns a mistyped or vanished path into a plausible
        // baseline sitting somewhere nobody reads.
        refusal.Which.ExitCode.Should().Be(ExitCode.BaselineMissing);
        File.Exists(path).Should().BeFalse("--apply may replace a baseline, never create one");

        Directory
            .EnumerateFiles(Path.Combine(workspace.Root, "artifacts"))
            .Should()
            .BeEmpty("a refused write must not leave a staged file behind either");
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheBaselineIsSwappedForAnotherSuitesDuringTheRun_RefusesRatherThanReplacingIt()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var seeding = ComparisonWorkspace.Endpoint();

        var path = await SeedBaselineAsync(workspace, seeding);

        // Another suite's baseline, produced the same way this one was.
        using var other = new TempWorkspace();

        other.WriteFile(
            Path.Combine("eval-suites", "regression.json"),
            SuiteFixture.Suite(
                "other",
                SuiteFixture.Scenario(
                    ComparisonWorkspace.Checkout,
                    expectedOutcome: ComparisonWorkspace.ExpectedOutcome
                )
            )
        );

        var foreign = await File.ReadAllTextAsync(await SeedBaselineAsync(other, seeding), CancellationToken.None);

        // The foreign-suite refusal ran against the file that was read before the suite was
        // conducted. Swapping the file afterwards means the run replaces a file nothing checked.
        var swapped = false;

        await using var endpoint = new StubEndpoint(_ =>
        {
            if (!swapped)
            {
                swapped = true;
                File.WriteAllText(path, foreign);
            }

            return new StubReply
            {
                Status = 200,
                Body = $"{{ \"output\": \"ok\", \"outcome\": \"{ComparisonWorkspace.ExpectedOutcome}\" }}",
            };
        });

        using var console = new RecordingConsole();

        var act = async () =>
            await BaselineCommand.ExecuteAsync(Plan(workspace, endpoint, apply: true), console, CancellationToken.None);

        var refusal = await act.Should().ThrowAsync<EvalCliException>();

        swapped.Should().BeTrue("the test is only meaningful if the swap actually happened mid-run");

        refusal.Which.ExitCode.Should().NotBe(ExitCode.Success);

        // The assertion that matters: another suite's evidence survived.
        (await File.ReadAllTextAsync(path, CancellationToken.None))
            .Should()
            .Be(foreign, "--apply must replace only the file it read and vouched for");
    }

    [Fact]
    public async Task ExecuteAsync_WhenNoDiffCanBeShown_ReportsTheCountAsUnknownRatherThanZero()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var endpoint = ComparisonWorkspace.Endpoint();

        // The baseline was driven from a different root seed, so the comparison is refused and
        // no diff can be shown. That is a legitimate reason to re-baseline — it must not also be
        // a reason to report that nothing would change.
        using var seeding = new RecordingConsole();

        var seeded = await RunCommand.ExecuteAsync(
            RunPlan.Create(
                new RunRequest
                {
                    Suite = "eval-suites/regression.json",
                    Root = workspace.Root,
                    Out = "artifacts/baseline.json",
                    Endpoint = endpoint.Address.ToString(),
                    RestExchange = "json",
                    Seed = 4242,
                }
            ),
            seeding,
            CancellationToken.None
        );

        seeded.Should().Be(ExitCode.Success, seeding.StandardError);

        using var console = new RecordingConsole();

        var code = await BaselineCommand.ExecuteAsync(
            Plan(workspace, endpoint, apply: false) with
            {
                Json = true,
            },
            console,
            CancellationToken.None
        );

        code.Should().Be(ExitCode.Success, console.StandardError);

        using var report = JsonDocument.Parse(console.StandardOut);
        var root = report.RootElement;

        root.GetProperty("diffAvailable").GetBoolean().Should().BeFalse();

        // Zero is a claim. "Unknown" is the truth, and the difference is the whole point of a
        // preview: a reader deciding whether to replace a committed file needs to know that
        // nothing here measured how much of it changes.
        root.GetProperty("scenariosChanged").ValueKind.Should().Be(JsonValueKind.Null);
        root.GetProperty("classificationCounts").ValueKind.Should().Be(JsonValueKind.Null);
        root.GetProperty("newlyCovered").ValueKind.Should().Be(JsonValueKind.Null);
        root.GetProperty("regressed").ValueKind.Should().Be(JsonValueKind.Null);
        root.GetProperty("noDiffReason").GetString().Should().Contain("not conducted alike");
    }

    [Fact]
    public async Task RenderText_WhenNoDiffCanBeShown_LeadsWithTheUnknownRatherThanAZero()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var endpoint = ComparisonWorkspace.Endpoint();

        using var seeding = new RecordingConsole();

        await RunCommand.ExecuteAsync(
            RunPlan.Create(
                new RunRequest
                {
                    Suite = "eval-suites/regression.json",
                    Root = workspace.Root,
                    Out = "artifacts/baseline.json",
                    Endpoint = endpoint.Address.ToString(),
                    RestExchange = "json",
                    Seed = 4242,
                }
            ),
            seeding,
            CancellationToken.None
        );

        using var console = new RecordingConsole();

        await BaselineCommand.ExecuteAsync(Plan(workspace, endpoint, apply: false), console, CancellationToken.None);

        var headline = console.StandardOut.Split(Environment.NewLine)[0];

        // The first line is the one a reader acts on. "0 of 2 scenarios would change" over a
        // comparison that never happened is worse than saying nothing.
        headline.Should().NotContain("0 of");
        headline.Should().Contain("unknown");
    }

    [Fact]
    public async Task ExecuteAsync_WhenInterruptedAfterTheBaselineWasReplaced_DoesNotClaimNothingWasWritten()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var original = ComparisonWorkspace.Endpoint();

        var path = await SeedBaselineAsync(workspace, original);
        var before = await File.ReadAllTextAsync(path, CancellationToken.None);

        await using var changed = ComparisonWorkspace.Endpoint(ComparisonWorkspace.Checkout);

        using var cancellation = new CancellationTokenSource();

        // Cancelled the instant the command reaches for standard output, which is after the
        // replacement and before a word of it is reported.
        using var console = new RecordingConsole(cancellation.Cancel);

        var act = async () =>
            await BaselineCommand.ExecuteAsync(Plan(workspace, changed, apply: true), console, cancellation.Token);

        var interruption = (await act.Should().ThrowAsync<OperationCanceledException>()).Which;

        (await File.ReadAllTextAsync(path, CancellationToken.None))
            .Should()
            .NotBe(before, "the test is only meaningful if the replacement actually landed first");

        using var reported = new RecordingConsole();

        var code = ExitCodeReporter.Report(interruption, reported);

        code.Should().Be(ExitCode.Interrupted, "an interruption is still an interruption");

        // The committed baseline has changed. Telling a developer otherwise sends them looking
        // for a file they still have and past the one they no longer do.
        reported.StandardError.Should().NotContain("nothing was written");
        reported.StandardError.Should().Contain("was replaced");
    }

    [Fact]
    public async Task ExecuteAsync_WhenOneScenarioIsNotComparable_StillPreviewsBecauseRegeneratingIsTheFix()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var endpoint = ComparisonWorkspace.Endpoint();

        var path = await SeedBaselineAsync(workspace, endpoint);
        var before = await File.ReadAllTextAsync(path, CancellationToken.None);

        // One scenario redefined, so exactly one pair is not comparable. In `run` that is fatal —
        // a zero beside an unexamined scenario reads as agreement. Here it must not be: a stale
        // fingerprint is the state this command exists to clear, and refusing would leave a user
        // unable to fix the thing the refusal complained about.
        ComparisonWorkspace.WriteSuite(workspace, checkoutOpening: "goodbye");

        using var console = new RecordingConsole();

        var code = await BaselineCommand.ExecuteAsync(
            Plan(workspace, endpoint, apply: false) with
            {
                Json = true,
            },
            console,
            CancellationToken.None
        );

        code.Should().Be(ExitCode.Success, console.StandardError);

        using var report = JsonDocument.Parse(console.StandardOut);
        var root = report.RootElement;

        root.GetProperty("diffAvailable").GetBoolean().Should().BeTrue();
        root.GetProperty("classificationCounts").GetProperty("not-comparable").GetInt32().Should().Be(1);
        root.GetProperty("scenariosChanged").GetInt32().Should().Be(1, "a pair nobody could compare is not unchanged");

        // And the preview is still a preview.
        (await File.ReadAllTextAsync(path, CancellationToken.None))
            .Should()
            .Be(before);
    }

    [Fact]
    public async Task ExecuteAsync_WhenOneScenarioIsNotComparable_NamesItAndWhyInTheRenderedText()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var endpoint = ComparisonWorkspace.Endpoint();

        var path = await SeedBaselineAsync(workspace, endpoint);
        var before = await File.ReadAllTextAsync(path, CancellationToken.None);

        // One scenario redefined, so exactly one pair is not comparable — and this command
        // previews rather than refusing, which means the rendered text is the only place a user
        // is told that scenario went unexamined.
        ComparisonWorkspace.WriteSuite(workspace, checkoutOpening: "goodbye");

        using var console = new RecordingConsole();

        var code = await BaselineCommand.ExecuteAsync(
            Plan(workspace, endpoint, apply: false) with
            {
                Json = false,
            },
            console,
            CancellationToken.None
        );

        code.Should().Be(ExitCode.Success, console.StandardError);

        var text = console.StandardOut;

        // Named, with the comparator's own reason, and with the instruction to regenerate rather
        // than hand-edit beside it. A count of one in a classification table is not that.
        text.Should().Contain("not comparable - these scenarios were not examined by this comparison");
        text.Should().Contain(ComparisonWorkspace.Checkout);
        text.Should().Contain("redefined");
        text.Should().Contain("Never edit a baseline by hand");

        // And the preview is still a preview.
        (await File.ReadAllTextAsync(path, CancellationToken.None))
            .Should()
            .Be(before);
    }

    [Fact]
    public void CreateForBaselineUpdate_WithNoBaselineNamed_Refuses()
    {
        using var workspace = new TempWorkspace();

        var act = () =>
            RunPlan.CreateForBaselineUpdate(
                new RunRequest { Suite = "eval-suites/regression.json", Root = workspace.Root }
            );

        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Theory]
    [InlineData("changed-since")]
    [InlineData("out")]
    [InlineData("baseline-endpoint")]
    public void CreateForBaselineUpdate_WithAnOptionThatBelongsToRun_Refuses(string option)
    {
        using var workspace = new TempWorkspace();

        workspace.WriteFile(Path.Combine("artifacts", "baseline.json"), "{}");

        var request = new RunRequest
        {
            Suite = "eval-suites/regression.json",
            Root = workspace.Root,
            Baseline = "artifacts/baseline.json",
            ChangedSince = option is "changed-since" ? "HEAD" : null,
            Out = option is "out" ? "artifacts/eval.json" : null,
            BaselineEndpoint = option is "baseline-endpoint" ? "http://localhost:9/other" : null,
        };

        var act = () => RunPlan.CreateForBaselineUpdate(request);

        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Fact]
    public void CreateForBaselineUpdate_WithoutTheOptIn_PlansToWriteNothing()
    {
        using var workspace = new TempWorkspace();

        workspace.WriteFile(Path.Combine("artifacts", "baseline.json"), "{}");

        var plan = RunPlan.CreateForBaselineUpdate(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = workspace.Root,
                Baseline = "artifacts/baseline.json",
            }
        );

        plan.ApplyBaselineUpdate.Should().BeFalse("the opt-in is absent, so nothing may be replaced");
        plan.Operation.Should().Be(CliOperation.BaselineUpdate);
    }
}
