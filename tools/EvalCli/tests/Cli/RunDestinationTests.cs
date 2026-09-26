using FluentAssertions;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Tests.Support;

namespace Forge.EvalCli.Tests.Cli;

/// <summary>
/// What <c>run</c> may write over, and what it may never write over.
/// </summary>
/// <remarks>
/// <para>
/// <b>The assertions are written against the bytes on disk</b>, not against a message, because a
/// message is not what a developer loses. <c>trend</c> already holds this property — a report
/// destination inside <c>--artifacts</c> is refused regardless of <c>--overwrite</c>, and
/// re-established immediately before the write — and <c>run</c> is the command people invoke
/// constantly, so it is the one where an unguarded destination costs the most.
/// </para>
/// <para>
/// The property under test is stated once and holds over the whole matrix: <b>no destination this
/// invocation writes may be a file this same invocation reads</b>. The inputs are <c>--suite</c>
/// and <c>--baseline</c>; the destinations are <c>--out</c> and <c>--report-markdown</c>.
/// </para>
/// </remarks>
public class RunDestinationTests
{
    private const string SuiteReference = "eval-suites/regression.json";

    private static RunRequest Request(TempWorkspace workspace) =>
        new() { Suite = SuiteReference, Root = workspace.Root };

    private static string SuitePath(TempWorkspace workspace) =>
        Path.Combine(workspace.Root, "eval-suites", "regression.json");

    // -------------------------------------------------------------------------------------
    // A destination may never be the suite. Refused with the opt-in, and without it.
    // -------------------------------------------------------------------------------------

    [Fact]
    public void Create_WhenTheArtifactDestinationIsTheSuite_RefusesEvenWithTheOptIn()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        var refusal = Assert.Throws<EvalCliException>(() =>
            RunPlan.Create(Request(workspace) with { Out = SuiteReference, Overwrite = true })
        );

        refusal.ExitCode.Should().Be(ExitCode.UsageError);
        refusal.Message.Should().Contain("--out").And.Contain("--suite");
        refusal.Remedy.Should().Contain("--overwrite", "the opt-in must be named as the thing that does not lift this");
    }

    [Fact]
    public void Create_WhenTheArtifactDestinationIsTheSuite_LeavesTheSuiteByteForByte()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        var before = File.ReadAllBytes(SuitePath(workspace));

        Assert.Throws<EvalCliException>(() =>
            RunPlan.Create(Request(workspace) with { Out = SuiteReference, Overwrite = true })
        );

        // The single most valuable assertion in this kind: the input the tool was pointed at
        // survived the invocation that was aimed at it.
        File.ReadAllBytes(SuitePath(workspace)).Should().Equal(before);
    }

    [Fact]
    public void Create_WhenTheReportDestinationIsTheSuite_RefusesEvenWithTheOptIn()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);
        workspace.WriteFile(Path.Combine("artifacts", "baseline.json"), "{}");

        var before = File.ReadAllBytes(SuitePath(workspace));

        var refusal = Assert.Throws<EvalCliException>(() =>
            RunPlan.Create(
                Request(workspace) with
                {
                    Baseline = "artifacts/baseline.json",
                    ReportMarkdown = SuiteReference,
                    Overwrite = true,
                }
            )
        );

        refusal.ExitCode.Should().Be(ExitCode.UsageError);
        refusal.Message.Should().Contain("--report-markdown").And.Contain("--suite");
        File.ReadAllBytes(SuitePath(workspace)).Should().Equal(before);
    }

    [Fact]
    public void Create_WhenADestinationIsTheSuite_StatesThePathRelativeToTheRoot()
    {
        // Every refusal reaches stderr and from there the build log, which is read by anyone who
        // can read the repository and whose checkout directory names the account CI runs as (§V).
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        var refusal = Assert.Throws<EvalCliException>(() =>
            RunPlan.Create(Request(workspace) with { Out = SuiteReference, Overwrite = true })
        );

        (refusal.Message + refusal.Remedy).Should().NotContain(workspace.Root);
        refusal.Message.Should().Contain("eval-suites/regression.json");
    }

    // -------------------------------------------------------------------------------------
    // The baseline collisions the tool already refused must survive the sweep that generalised
    // them. These are the regression guards on consolidating four cells into one rule.
    // -------------------------------------------------------------------------------------

    [Fact]
    public void Create_WhenTheArtifactDestinationIsTheBaseline_IsStillRefusedAndNamesTheOtherCommand()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);
        workspace.WriteFile(Path.Combine("artifacts", "baseline.json"), "{}");

        var refusal = Assert.Throws<EvalCliException>(() =>
            RunPlan.Create(
                Request(workspace) with
                {
                    Baseline = "artifacts/baseline.json",
                    Out = "artifacts/baseline.json",
                    Overwrite = true,
                }
            )
        );

        refusal.ExitCode.Should().Be(ExitCode.UsageError);
        refusal.Remedy.Should().Contain("baseline update");
    }

    [Fact]
    public void Create_WhenTheReportDestinationIsTheBaseline_IsStillRefused()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);
        workspace.WriteFile(Path.Combine("artifacts", "baseline.json"), "{}");

        var refusal = Assert.Throws<EvalCliException>(() =>
            RunPlan.Create(
                Request(workspace) with
                {
                    Baseline = "artifacts/baseline.json",
                    ReportMarkdown = "artifacts/baseline.json",
                    Overwrite = true,
                }
            )
        );

        refusal.ExitCode.Should().Be(ExitCode.UsageError);
        refusal.Message.Should().Contain("--report-markdown").And.Contain("--baseline");
    }

    [Fact]
    public void Create_WhenTheDestinationsDifferFromEveryInput_IsAllowed()
    {
        // The guards above must refuse a collision, not the ordinary case of reading two files and
        // writing two others.
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);
        workspace.WriteFile(Path.Combine("artifacts", "baseline.json"), "{}");

        var plan = RunPlan.Create(
            Request(workspace) with
            {
                Baseline = "artifacts/baseline.json",
                Out = "artifacts/candidate.json",
                ReportMarkdown = "artifacts/report.md",
            }
        );

        plan.ArtifactPath.Should().NotBe(plan.SuitePath).And.NotBe(plan.BaselinePath);
        plan.MarkdownReportPath.Should().NotBe(plan.SuitePath).And.NotBe(plan.BaselinePath);
    }

    [Fact]
    public void Create_WhenTheBaselineUpdateDestinationIsTheSuite_RefusesAndNamesThatCommandsOwnOptIn()
    {
        // The destructive command aimed at the suite. The opt-in named in the remedy has to be
        // the one this command actually has — `--apply` — because sending a reader after
        // `--overwrite`, which `baseline update` does not declare, is its own small untruth.
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        var refusal = Assert.Throws<EvalCliException>(() =>
            RunPlan.CreateForBaselineUpdate(Request(workspace) with { Baseline = SuiteReference, Apply = true })
        );

        refusal.ExitCode.Should().Be(ExitCode.UsageError);
        refusal.Message.Should().Contain("--baseline").And.Contain("--suite");
        refusal.Remedy.Should().Contain("--apply").And.NotContain("--overwrite");
    }

    [Fact]
    public void Create_WhenTheArtifactDestinationCollides_NamesTheOptInThatRunActuallyHas()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        var refusal = Assert.Throws<EvalCliException>(() =>
            RunPlan.Create(Request(workspace) with { Out = SuiteReference, Overwrite = true })
        );

        refusal.Remedy.Should().Contain("--overwrite").And.NotContain("--apply");
    }

    [Fact]
    public void RefuseWritingOverAnInput_WithNoInputsSupplied_RefusesRatherThanCheckingNothing()
    {
        // The same shape as an unbounded ceiling: a guard whose strictness is a parameter the
        // caller supplies. An empty input set silently disables the whole matrix, and no
        // invocation of this tool reads nothing — there is always a suite.
        var act = () => RunPlan.RefuseWritingOverAnInput(@"C:\root", [], [("--out", @"C:\root\artifacts\eval.json")]);

        act.Should().Throw<ArgumentException>();
    }

    // -------------------------------------------------------------------------------------
    // Re-established at the moment of the write, because the argument-time answer has expired.
    // -------------------------------------------------------------------------------------

    [Fact]
    public void RecheckDestination_WhenTheDestinationHasBecomeTheSuiteSinceValidation_Refuses()
    {
        // A run takes as long as the system under test does, and containment is a property of the
        // file system rather than of the argument. The end-to-end route cannot be provoked — the
        // suite has to be read and the destination has to move before the write, with no seam in
        // between — so the step is exercised directly, exactly as `trend`'s is.
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        var plan = RunPlan.Create(Request(workspace) with { Out = "artifacts/candidate.json" });

        var refusal = Assert.Throws<EvalCliException>(() => plan.RecheckDestination(plan.SuitePath, "--out"));

        refusal.ExitCode.Should().Be(ExitCode.UsageError);
        refusal.Message.Should().Contain("--out").And.Contain("--suite");
    }

    [Fact]
    public void RecheckDestination_WhenTheDestinationStillDiffersFromEveryInput_Allows()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        var plan = RunPlan.Create(Request(workspace) with { Out = "artifacts/candidate.json" });

        var act = () => plan.RecheckDestination(plan.ArtifactPath!, "--out");

        act.Should().NotThrow();
    }

    [Fact]
    public void RecheckDestination_WhenTheRootHasGoneAwayByTheTimeOfTheWrite_DoesNotRepeatIt()
    {
        // Both paths this step re-resolves were produced by this tool, not typed by the caller, so
        // a refusal out of them must not echo its subject. Asserted at the call site because which
        // `PathValue` factory a call site reaches for is the thing that has been wrong before.
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        var plan = RunPlan.Create(Request(workspace) with { Out = "artifacts/candidate.json" });
        var gone = plan with { RootDirectory = Path.Combine(workspace.Root, "vanished") };

        var refusal = Assert.Throws<EvalCliException>(() => gone.RecheckDestination(gone.ArtifactPath!, "--out"));

        refusal.Message.Should().Contain("--root").And.Contain("not repeated");
        (refusal.Message + refusal.Remedy).Should().NotContain(workspace.Root);
    }

    // -------------------------------------------------------------------------------------
    // And it is actually reached. A guard that is wired but never invoked reads exactly like
    // protection that is not there, so each write path is driven end to end with a destination
    // that became an input after the arguments were validated.
    //
    // The plan is amended directly rather than provoked with a link swap: a link on the write
    // path is refused by containment first, so the collision check would never be the thing that
    // fired and the test would pass whether or not it ran at all.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task ExecuteAsync_WhenTheArtifactDestinationBecameTheSuiteAfterValidation_RefusesAndLeavesItIntact()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var endpoint = ComparisonWorkspace.Endpoint();

        using var console = new RecordingConsole();

        var plan = RunPlan.Create(
            Request(workspace) with
            {
                Out = "artifacts/candidate.json",
                Endpoint = endpoint.Address.ToString(),
                RestExchange = "json",
                Overwrite = true,
            }
        );

        var before = await File.ReadAllBytesAsync(SuitePath(workspace), CancellationToken.None);

        var refusal = await Assert.ThrowsAsync<EvalCliException>(() =>
            RunCommand.ExecuteAsync(plan with { ArtifactPath = plan.SuitePath }, console, CancellationToken.None)
        );

        // The write stage owns this refusal, not the argument stage: the invocation was well
        // formed and what moved was the file system underneath it.
        refusal.ExitCode.Should().Be(ExitCode.RunFailed);
        refusal.Message.Should().Contain("--out").And.Contain("--suite");

        (await File.ReadAllBytesAsync(SuitePath(workspace), CancellationToken.None))
            .Should()
            .Equal(before, "the suite must survive a write aimed at it after the arguments were checked");

        Directory
            .EnumerateFiles(Path.Combine(workspace.Root, "eval-suites"))
            .Should()
            .ContainSingle("a refused write must not leave a staged file beside the suite");
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheReportDestinationBecameTheBaselineAfterValidation_RefusesAndLeavesItIntact()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var endpoint = ComparisonWorkspace.Endpoint();

        // A real baseline, produced by a real run, so the comparison the report is rendered from
        // genuinely happens and the report write stage is genuinely reached.
        using var seeding = new RecordingConsole();

        var seeded = await RunCommand.ExecuteAsync(
            RunPlan.Create(
                Request(workspace) with
                {
                    Out = "artifacts/baseline.json",
                    Endpoint = endpoint.Address.ToString(),
                    RestExchange = "json",
                }
            ),
            seeding,
            CancellationToken.None
        );

        seeded.Should().Be(ExitCode.Success, seeding.StandardError);

        var baseline = Path.Combine(workspace.Root, "artifacts", "baseline.json");
        var before = await File.ReadAllBytesAsync(baseline, CancellationToken.None);

        var plan = RunPlan.Create(
            Request(workspace) with
            {
                Baseline = "artifacts/baseline.json",
                ReportMarkdown = "artifacts/report.md",
                Endpoint = endpoint.Address.ToString(),
                RestExchange = "json",
                Overwrite = true,
            }
        );

        using var console = new RecordingConsole();

        var refusal = await Assert.ThrowsAsync<EvalCliException>(() =>
            RunCommand.ExecuteAsync(
                plan with
                {
                    MarkdownReportPath = plan.BaselinePath,
                },
                console,
                CancellationToken.None
            )
        );

        refusal.ExitCode.Should().Be(ExitCode.RunFailed);
        refusal.Message.Should().Contain("--report-markdown").And.Contain("--baseline");

        (await File.ReadAllBytesAsync(baseline, CancellationToken.None))
            .Should()
            .Equal(before, "the baseline the run was compared against must survive the report write");
    }
}
