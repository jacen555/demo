using System.CommandLine.IO;
using FluentAssertions;
using Forge.EvalCli.Changes;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Diagnostics;
using Forge.EvalCli.Tests.Support;
using Microsoft.Extensions.Logging;

namespace Forge.EvalCli.Tests.Cli;

/// <summary>
/// What a <c>run</c> or <c>baseline update</c> refusal is allowed to put on stderr.
/// </summary>
/// <remarks>
/// <para>
/// <b>Asserted against what the caller reads, never against an internal property.</b> Every case
/// here puts the refusal through <see cref="ExitCodeReporter.Report"/> and reads the captured
/// stderr, because the message and the remedy are two separate strings and a path moved from one
/// into the other would pass a test written against either alone. The remedy is where several of
/// these paths actually sat.
/// </para>
/// <para>
/// <b><see cref="TempWorkspace"/> is the disclosure under test, not a stand-in for it.</b> Its
/// root is a real temp directory — on Windows that is under <c>C:\Users\{account}\AppData</c>,
/// which is precisely the shape ADR 0005 §V is about: a path that names the account the job runs
/// as. Asserting the root does not appear is therefore the same assertion a CI log would make.
/// </para>
/// <para>
/// ADR 0005's amendment is the reason these are grouped rather than written one per defect: a
/// rule corrected only where it was caught stays correct about one case and silent about the
/// next. The sites here were enumerated from the five files rather than from a prior list.
/// </para>
/// </remarks>
public class RunPathDisclosureTests
{
    /// <summary>A machine path the engine admits into an identifier behind a request method.</summary>
    /// <remarks>
    /// ADR 0005 records that the authoring-time control exempts a leading request method so
    /// <c>GET /home/dashboard</c> loads, and that the exemption necessarily admits this. The
    /// concession was reasoned about for the Markdown document, where the net is a second layer.
    /// stderr is a different channel and does not inherit it.
    /// </remarks>
    private const string ExemptedPath = "GET /home/ci-runner/work";

    /// <summary>The part of it that must never reach a message.</summary>
    private const string Disclosed = "/home/ci-runner/work";

    private static string Alias => "[path-redacted:";

    /// <summary>Runs a refusal through the reporter and returns exactly what stderr received.</summary>
    /// <remarks>
    /// Catches <see cref="EvalCliException"/> specifically rather than every exception: every site
    /// under test is a refusal this tool makes deliberately, so anything else reaching here is a
    /// defect and should fail the test rather than be rendered and asserted against.
    /// </remarks>
    private static string Reported(Action act)
    {
        using var console = new RecordingConsole();

        try
        {
            act();
        }
        catch (EvalCliException refusal)
        {
            ExitCodeReporter.Report(refusal, console);

            return console.StandardError;
        }

        throw new InvalidOperationException("Expected a refusal, and nothing was thrown.");
    }

    /// <summary>The asynchronous sibling of <see cref="Reported(Action)"/>.</summary>
    private static async Task<string> ReportedAsync(Func<Task> act)
    {
        using var console = new RecordingConsole();

        try
        {
            await act();
        }
        catch (EvalCliException refusal)
        {
            ExitCodeReporter.Report(refusal, console);

            return console.StandardError;
        }

        throw new InvalidOperationException("Expected a refusal, and nothing was thrown.");
    }

    // -------------------------------------------------------------------------------------
    // RunPlan — argument-time refusals. A root is established before every one of these.
    // -------------------------------------------------------------------------------------

    [Fact]
    public void Create_WhenBaselineAndOutNameTheSameFile_StatesThePathRelativeToTheRoot()
    {
        using var workspace = new TempWorkspace();

        workspace.WriteFile(Path.Combine("artifacts", "baseline.json"), "{}");

        var stderr = Reported(() =>
            RunPlan.Create(
                new RunRequest
                {
                    Suite = "eval-suites/regression.json",
                    Root = workspace.Root,
                    Baseline = "artifacts/baseline.json",
                    Out = "artifacts/baseline.json",
                    Overwrite = true,
                }
            )
        );

        stderr.Should().NotContain(workspace.Root);
        stderr.Should().Contain("artifacts/baseline.json");
    }

    [Fact]
    public void Create_WhenReportMarkdownAndOutNameTheSameFile_StatesThePathRelativeToTheRoot()
    {
        using var workspace = new TempWorkspace();

        workspace.WriteFile(Path.Combine("artifacts", "baseline.json"), "{}");

        var stderr = Reported(() =>
            RunPlan.Create(
                new RunRequest
                {
                    Suite = "eval-suites/regression.json",
                    Root = workspace.Root,
                    Baseline = "artifacts/baseline.json",
                    Out = "artifacts/report.md",
                    ReportMarkdown = "artifacts/report.md",
                }
            )
        );

        stderr.Should().NotContain(workspace.Root);
        stderr.Should().Contain("artifacts/report.md");
    }

    [Fact]
    public void Create_WhenReportMarkdownAndBaselineNameTheSameFile_StatesThePathRelativeToTheRoot()
    {
        using var workspace = new TempWorkspace();

        workspace.WriteFile(Path.Combine("artifacts", "baseline.json"), "{}");

        var stderr = Reported(() =>
            RunPlan.Create(
                new RunRequest
                {
                    Suite = "eval-suites/regression.json",
                    Root = workspace.Root,
                    Baseline = "artifacts/baseline.json",
                    ReportMarkdown = "artifacts/baseline.json",
                    Overwrite = true,
                }
            )
        );

        stderr.Should().NotContain(workspace.Root);
        stderr.Should().Contain("artifacts/baseline.json");
    }

    [Fact]
    public void CreateForBaselineUpdate_WhenTheBaselineNamesADirectory_StatesThePathRelativeToTheRoot()
    {
        using var workspace = new TempWorkspace();

        var stderr = Reported(() =>
            RunPlan.CreateForBaselineUpdate(
                new RunRequest
                {
                    Suite = "eval-suites/regression.json",
                    Root = workspace.Root,
                    Baseline = "artifacts",
                }
            )
        );

        stderr.Should().NotContain(workspace.Root);
        stderr.Should().Contain("artifacts").And.Contain("directory");
    }

    [Fact]
    public void CreateForBaselineUpdate_WhenTheBaselineIsNotThere_StatesThePathRelativeToTheRoot()
    {
        using var workspace = new TempWorkspace();

        var stderr = Reported(() =>
            RunPlan.CreateForBaselineUpdate(
                new RunRequest
                {
                    Suite = "eval-suites/regression.json",
                    Root = workspace.Root,
                    Baseline = "artifacts/missing.json",
                }
            )
        );

        stderr.Should().NotContain(workspace.Root);
        stderr.Should().Contain("artifacts/missing.json");
    }

    // -------------------------------------------------------------------------------------
    // SuiteDiscovery — the suite and the baseline a run reads.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task ExecuteAsync_WhenTheSuiteDoesNotValidate_StatesThePathRelativeToTheRoot()
    {
        using var workspace = new TempWorkspace();

        workspace.WriteFile(Path.Combine("eval-suites", "regression.json"), "{ \"schemaVersion\": \"1.0\" }");

        using var console = new RecordingConsole();

        var stderr = await ReportedAsync(() =>
            RunCommand.ExecuteAsync(
                RunPlan.Create(new RunRequest { Suite = "eval-suites/regression.json", Root = workspace.Root }),
                console,
                CancellationToken.None
            )
        );

        stderr.Should().NotContain(workspace.Root);
        stderr.Should().Contain("eval-suites/regression.json");
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheSuiteDeclaresNoScenarios_StatesThePathRelativeToTheRoot()
    {
        using var workspace = new TempWorkspace();

        workspace.WriteFile(Path.Combine("eval-suites", "regression.json"), SuiteFixture.Suite("regression"));

        using var console = new RecordingConsole();

        var stderr = await ReportedAsync(() =>
            RunCommand.ExecuteAsync(
                RunPlan.Create(new RunRequest { Suite = "eval-suites/regression.json", Root = workspace.Root }),
                console,
                CancellationToken.None
            )
        );

        stderr.Should().NotContain(workspace.Root);
        stderr.Should().Contain("eval-suites/regression.json");
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheBaselineIsNotAReadableArtifact_StatesThePathRelativeToTheRoot()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);
        workspace.WriteFile(Path.Combine("artifacts", "baseline.json"), "not json at all");

        using var console = new RecordingConsole();

        var stderr = await ReportedAsync(() =>
            RunCommand.ExecuteAsync(
                RunPlan.Create(
                    new RunRequest
                    {
                        Suite = "eval-suites/regression.json",
                        Root = workspace.Root,
                        Baseline = "artifacts/baseline.json",
                    }
                ),
                console,
                CancellationToken.None
            )
        );

        stderr.Should().NotContain(workspace.Root);
        stderr.Should().Contain("artifacts/baseline.json");
    }

    // -------------------------------------------------------------------------------------
    // BaselineCommand — the destructive command's refusals.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task ExecuteAsync_WhenTheBaselineDisappearsBeforeTheRun_StatesThePathRelativeToTheRoot()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        var baseline = workspace.WriteFile(Path.Combine("artifacts", "baseline.json"), "{}");

        var plan = RunPlan.CreateForBaselineUpdate(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = workspace.Root,
                Baseline = "artifacts/baseline.json",
            }
        );

        // The plan required it to exist; removing it now is the race the refusal is written for.
        File.Delete(baseline);

        using var console = new RecordingConsole();

        var stderr = await ReportedAsync(() => BaselineCommand.ExecuteAsync(plan, console, CancellationToken.None));

        stderr.Should().NotContain(workspace.Root);
        stderr.Should().Contain("artifacts/baseline.json");
    }

    // -------------------------------------------------------------------------------------
    // Artifact-derived identifiers. ADR 0005's amendment: the authoring-time control's method
    // exemption was reasoned about for the Markdown document, not for stderr.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task ExecuteAsync_WhenTheBaselineIsARunOfAForeignSuiteNamedForAMachine_DoesNotPrintThatName()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var endpoint = ComparisonWorkspace.Endpoint();

        var baseline = await SeedBaselineAsync(workspace, endpoint);

        // Recorded under a suite name the engine admits behind a request method, so it survives
        // both the authoring-time control and artifact read-back and reaches the comparator.
        Rename(baseline, ExemptedPath);

        var plan = RunPlan.CreateForBaselineUpdate(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = workspace.Root,
                Baseline = "artifacts/baseline.json",
                Endpoint = endpoint.Address.ToString(),
                RestExchange = "json",
            }
        );

        using var console = new RecordingConsole();

        var stderr = await ReportedAsync(() => BaselineCommand.ExecuteAsync(plan, console, CancellationToken.None));

        stderr.Should().NotContain(Disclosed).And.Contain(Alias);
        stderr.Should().NotContain(workspace.Root);
        stderr.Should().Contain("artifacts/baseline.json");
    }

    /// <summary>Produces a real baseline at artifacts/baseline.json by conducting the suite.</summary>
    private static async Task<string> SeedBaselineAsync(TempWorkspace workspace, StubEndpoint endpoint)
    {
        using var console = new RecordingConsole();

        var code = await RunCommand.ExecuteAsync(
            RunPlan.Create(
                new RunRequest
                {
                    Suite = "eval-suites/regression.json",
                    Root = workspace.Root,
                    Out = "artifacts/baseline.json",
                    Endpoint = endpoint.Address.ToString(),
                    RestExchange = "json",
                }
            ),
            console,
            CancellationToken.None
        );

        code.Should().Be(ExitCode.Success, console.StandardError);

        return Path.Combine(workspace.Root, "artifacts", "baseline.json");
    }

    /// <summary>Rewrites a recorded artifact's suite name, leaving everything else as conducted.</summary>
    private static void Rename(string artifact, string suiteName)
    {
        var document =
            System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(artifact))
            ?? throw new InvalidOperationException("the seeded artifact did not parse.");

        document["suiteName"] = suiteName;

        File.WriteAllText(artifact, document.ToJsonString());
    }

    // -------------------------------------------------------------------------------------
    // BaselineComparison — the comparison a `run --baseline` makes. Its reference is a path
    // for the artifact mechanism and an already-redacted address for the live one.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task ExecuteAsync_WhenTheComparedBaselineIsARunOfAForeignSuite_StatesThePathRelativeToTheRoot()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var endpoint = ComparisonWorkspace.Endpoint();

        Rename(await SeedBaselineAsync(workspace, endpoint), ExemptedPath);

        using var console = new RecordingConsole();

        var stderr = await ReportedAsync(() =>
            RunCommand.ExecuteAsync(
                RunPlan.Create(
                    new RunRequest
                    {
                        Suite = "eval-suites/regression.json",
                        Root = workspace.Root,
                        Baseline = "artifacts/baseline.json",
                        Endpoint = endpoint.Address.ToString(),
                        RestExchange = "json",
                    }
                ),
                console,
                CancellationToken.None
            )
        );

        stderr.Should().NotContain(Disclosed).And.Contain(Alias);
        stderr.Should().NotContain(workspace.Root);
        stderr.Should().Contain("artifacts/baseline.json");
    }

    [Fact]
    public async Task ExecuteAsync_WhenAScenarioNamedForAMachineCannotBeCompared_NetsItAndStatesThePathRelativeToTheRoot()
    {
        using var workspace = new TempWorkspace();

        // The id is what reaches stderr in the per-pair refusal, so it carries the exempted path.
        workspace.WriteFile(
            Path.Combine("eval-suites", "regression.json"),
            SuiteFixture.Suite(
                "regression",
                SuiteFixture.Scenario(
                    ExemptedPath,
                    opening: "hello",
                    expectedOutcome: ComparisonWorkspace.ExpectedOutcome
                )
            )
        );

        await using var endpoint = ComparisonWorkspace.Endpoint();

        await SeedBaselineAsync(workspace, endpoint);

        // The opening feeds the definition fingerprint, so changing it makes the committed entry
        // and this run's entry a pair nothing can be concluded from — a genuine redefinition
        // rather than an edited artifact.
        workspace.WriteFile(
            Path.Combine("eval-suites", "regression.json"),
            SuiteFixture.Suite(
                "regression",
                SuiteFixture.Scenario(
                    ExemptedPath,
                    opening: "changed",
                    expectedOutcome: ComparisonWorkspace.ExpectedOutcome
                )
            )
        );

        using var console = new RecordingConsole();

        var stderr = await ReportedAsync(() =>
            RunCommand.ExecuteAsync(
                RunPlan.Create(
                    new RunRequest
                    {
                        Suite = "eval-suites/regression.json",
                        Root = workspace.Root,
                        Baseline = "artifacts/baseline.json",
                        Endpoint = endpoint.Address.ToString(),
                        RestExchange = "json",
                    }
                ),
                console,
                CancellationToken.None
            )
        );

        stderr.Should().NotContain(Disclosed).And.Contain(Alias);
        stderr.Should().NotContain(workspace.Root);
        stderr.Should().Contain("artifacts/baseline.json").And.Contain("could not be compared");
    }

    // -------------------------------------------------------------------------------------
    // The remedy and the no-diff reason. Both carry a path, and only one of them is on stderr —
    // so both are checked against the channel they actually reach.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task ExecuteAsync_WhenARunWasRecordedAsAnError_StatesThePathRelativeToTheRootInTheRemedy()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var seeding = ComparisonWorkspace.Endpoint();

        await SeedBaselineAsync(workspace, seeding);

        // The connection goes away rather than answering, which the engine records as a run it
        // could not conduct — the one thing `baseline update` refuses to freeze into a baseline.
        await using var broken = new StubEndpoint(_ => new StubReply { Status = 200, Abort = true });

        using var console = new RecordingConsole();

        var stderr = await ReportedAsync(() =>
            BaselineCommand.ExecuteAsync(
                RunPlan.CreateForBaselineUpdate(
                    new RunRequest
                    {
                        Suite = "eval-suites/regression.json",
                        Root = workspace.Root,
                        Baseline = "artifacts/baseline.json",
                        Endpoint = broken.Address.ToString(),
                        RestExchange = "json",
                    }
                ),
                console,
                CancellationToken.None
            )
        );

        stderr.Should().NotContain(workspace.Root);
        stderr.Should().Contain("artifacts/baseline.json").And.Contain("is unchanged");
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheBaselineWasDrivenFromAnotherSeed_NetsTheReasonItCannotDiff()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var endpoint = ComparisonWorkspace.Endpoint();

        await SeedBaselineAsync(workspace, endpoint);

        using var console = new RecordingConsole();

        // A different seed is not fatal — it is exactly the staleness re-baselining clears — so
        // the comparator's reason is carried into the document rather than into a refusal, and
        // reaches stdout. The engine composes that reason from the artifact, so it goes through
        // the same net as everything else artifact-derived.
        var code = await BaselineCommand.ExecuteAsync(
            RunPlan.CreateForBaselineUpdate(
                new RunRequest
                {
                    Suite = "eval-suites/regression.json",
                    Root = workspace.Root,
                    Baseline = "artifacts/baseline.json",
                    Endpoint = endpoint.Address.ToString(),
                    RestExchange = "json",
                    Seed = 7,
                }
            ),
            console,
            CancellationToken.None
        );

        code.Should().Be(ExitCode.Success, console.StandardError);

        // Scoped to the reason, which is what this change nets. The surrounding document still
        // prints `root` and `baseline` as absolute paths on stdout — a separate, coherent class
        // of ~20 sites spanning this document, PlanRenderer and RunReport, reported rather than
        // half-fixed here. See the task report.
        var reason = console
            .StandardOut.Split('\n')
            .Single(line => line.Contains("no diff to show:", StringComparison.Ordinal));

        reason.Should().Contain("seed").And.NotContain(workspace.Root);
    }

    // -------------------------------------------------------------------------------------
    // Forwarded engine text. A different search from the one above: these are engine-composed
    // *strings* that happen to contain an admitted identifier, not path-shaped values.
    // -------------------------------------------------------------------------------------

    /// <summary>A suite whose one scenario is named for a machine and trips a loader finding.</summary>
    /// <param name="workspace">Where to write it.</param>
    /// <param name="mode">
    /// <c>simulated</c> produces a warning and a suite that loads; <c>deterministic</c> with no
    /// stimulus produces an error and a suite that does not. Both quote the id.
    /// </param>
    private static void WriteSuiteNamedForAMachine(TempWorkspace workspace, string mode)
    {
        var simulation = mode == "simulated" ? "{ \"opening\": \"hello\" }" : "{ }";

        workspace.WriteFile(
            Path.Combine("eval-suites", "regression.json"),
            "{ \"schemaVersion\": \"1.0\", \"name\": \"regression\", \"scenarios\": [ { \"identity\": { \"id\": \""
                + ExemptedPath
                + "\", \"kind\": \"rest\" }, \"execution\": { \"mode\": \""
                + mode
                + "\" }, \"simulation\": "
                + simulation
                + " } ] }"
        );
    }

    [Fact]
    public async Task ExecuteAsync_WhenAValidationWarningQuotesAMachineNamedScenario_DoesNotPrintIt()
    {
        using var workspace = new TempWorkspace();

        WriteSuiteNamedForAMachine(workspace, "simulated");

        using var console = new RecordingConsole();

        // Loads, so the warning prints and the run proceeds. Asserted on the console the command
        // actually writes to rather than on a message object.
        await RunCommand.ExecuteAsync(
            RunPlan.Create(new RunRequest { Suite = "eval-suites/regression.json", Root = workspace.Root }),
            console,
            CancellationToken.None
        );

        console.StandardError.Should().Contain("terminalCondition.unbounded");
        console.StandardError.Should().NotContain(Disclosed).And.Contain(Alias);

        // The explanation survives. Filtering ToString() whole would net the id and take the
        // sentence after it as well, leaving a finding with no finding in it.
        console.StandardError.Should().Contain("Set terminalCondition.maxTurns");
    }

    [Fact]
    public async Task ExecuteAsync_WhenAValidationErrorQuotesAMachineNamedScenario_DoesNotPrintIt()
    {
        using var workspace = new TempWorkspace();

        WriteSuiteNamedForAMachine(workspace, "deterministic");

        using var console = new RecordingConsole();

        var stderr = await ReportedAsync(() =>
            RunCommand.ExecuteAsync(
                RunPlan.Create(new RunRequest { Suite = "eval-suites/regression.json", Root = workspace.Root }),
                console,
                CancellationToken.None
            )
        );

        stderr.Should().Contain("deterministic.noStimulus");
        stderr.Should().NotContain(Disclosed).And.Contain(Alias);
        stderr.Should().Contain("nothing to send");
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheEngineLogsAboutAMachineNamedScenario_DoesNotPrintIt()
    {
        using var workspace = new TempWorkspace();

        WriteSuiteNamedForAMachine(workspace, "simulated");

        using var console = new RecordingConsole();

        // No exchange is wired, so the coordinator records a run it could not conduct and logs
        // it through the provider this tool installs — a third channel for the same identifier.
        await RunCommand.ExecuteAsync(
            RunPlan.Create(new RunRequest { Suite = "eval-suites/regression.json", Root = workspace.Root }),
            console,
            CancellationToken.None
        );

        console.StandardError.Should().Contain("RunCoordinator");
        console.StandardError.Should().NotContain(Disclosed).And.Contain(Alias);
    }

    [Fact]
    public void Report_WhenAnEngineRefusalQuotesAMachineNamedSuite_DoesNotPrintIt()
    {
        using var console = new RecordingConsole();

        // Reaches the reporter unwrapped: ExitCodeReporter.Classify has an arm for exactly this
        // type, so its own words are what stderr receives.
        ExitCodeReporter.Report(
            new Forge.EvalEngine.Comparison.ComparisonRefusedException(
                $"The baseline is a run of suite '{ExemptedPath}' and the candidate is a run of suite 'regression'."
            ),
            console
        );

        console.StandardError.Should().NotContain(Disclosed).And.Contain(Alias);
    }

    // -------------------------------------------------------------------------------------
    // A rejected argument value. A different vector again: caller text, not authored text, so
    // the net does not cover it — a token is not path-shaped.
    // -------------------------------------------------------------------------------------

    [Theory]
    [InlineData("/home/ci-runner/work/adapter")]
    [InlineData("ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8")]
    public void Create_WhenTheExchangeIsNotOneThisBuildHas_DoesNotEchoTheRejectedValue(string supplied)
    {
        using var workspace = new TempWorkspace();

        var stderr = Reported(() =>
            RunPlan.Create(
                new RunRequest
                {
                    Suite = "eval-suites/regression.json",
                    Root = workspace.Root,
                    RestExchange = supplied,
                }
            )
        );

        stderr.Should().NotContain(supplied);
        stderr.Should().Contain("--rest-exchange").And.Contain("json");
    }

    // -------------------------------------------------------------------------------------
    // Round three. Found by tracing the sinks rather than the sources: there are few consoles
    // and many values, so the sink-first search is the one that terminates.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task ExecuteAsync_WhenAFindingQuotesAnAssertionNamedForAMachine_WithholdsItAndSaysSo()
    {
        using var workspace = new TempWorkspace();

        // A deterministic scenario that can outlast its script produces two findings at once:
        // one quoting the author's assertion expression, one composed wholly by the engine.
        workspace.WriteFile(
            Path.Combine("eval-suites", "regression.json"),
            "{ \"schemaVersion\": \"1.0\", \"name\": \"regression\", \"scenarios\": [ { \"identity\": "
                + "{ \"id\": \"checkout\", \"kind\": \"rest\" }, \"execution\": { \"mode\": \"deterministic\", "
                + "\"terminalCondition\": { \"maxTurns\": 5, \"stopOnParticipantCompletion\": false } }, "
                + "\"simulation\": { \"opening\": \"hello\" }, \"grading\": { \"expectedOutcome\": \"done\", "
                + "\"assertions\": [\"exactMatch:"
                + Disclosed
                + "\"] } } ] }"
        );

        using var console = new RecordingConsole();

        var stderr = await ReportedAsync(() =>
            RunCommand.ExecuteAsync(
                RunPlan.Create(new RunRequest { Suite = "eval-suites/regression.json", Root = workspace.Root }),
                console,
                CancellationToken.None
            )
        );

        stderr.Should().NotContain(Disclosed);
        stderr.Should().Contain("assertion.turnScopeRequired").And.Contain("withheld");

        // The sibling finding embeds no author text, so the net is a no-op on it and its
        // explanation must survive whole. Netting every finding defensively would lose this.
        stderr.Should().Contain("grading.expectedOutcome judges the outcome the run ended on");
    }

    [Fact]
    public async Task ExecuteAsync_WhenThePlanExceedsTheRunBudget_RefusesWithoutFramesOrTheScenarioId()
    {
        using var workspace = new TempWorkspace();

        workspace.WriteFile(
            Path.Combine("eval-suites", "regression.json"),
            "{ \"schemaVersion\": \"1.0\", \"name\": \"regression\", \"scenarios\": [ { \"identity\": { \"id\": \""
                + ExemptedPath
                + "\", \"kind\": \"rest\" }, \"execution\": { \"mode\": \"deterministic\", "
                + "\"repetitionPolicy\": 2 }, \"simulation\": { \"opening\": \"hello\" } } ] }"
        );

        using var console = new RecordingConsole();

        var stderr = await ReportedAsync(() =>
            RunCommand.ExecuteAsync(
                RunPlan.Create(
                    new RunRequest
                    {
                        Suite = "eval-suites/regression.json",
                        Root = workspace.Root,
                        MaxTotalRuns = 1,
                    }
                ),
                console,
                CancellationToken.None
            )
        );

        // A refusal the engine means to make, so it must not reach the branch built for defects.
        stderr.Should().NotContain(Disclosed);
        stderr.Should().NotContain("This is a defect in eval-cli");
        stderr.Should().NotContain("   at Forge.EvalEngine");
        stderr.Should().Contain("--max-total-runs").And.Contain("exiting 1");
    }

    [Fact]
    public void Report_WhenTheFailureIsAGenuineDefect_StillPrintsFrames()
    {
        using var console = new RecordingConsole();

        Exception captured;

        try
        {
            throw new InvalidOperationException("a defect nobody planned for");
        }
        catch (InvalidOperationException exception)
        {
            captured = exception;
        }

        ExitCodeReporter.Report(captured, console).Should().Be(ExitCode.UnexpectedError);

        // The other half of the rule: narrowing the defect branch must not empty it.
        console.StandardError.Should().Contain("This is a defect in eval-cli");
        console.StandardError.Should().Contain("   at ");
    }

    [Fact]
    public async Task ResolveAsync_WhenTheRevisionIsUnknown_EchoesNeitherItNorGitsProse()
    {
        using var repository = new GitWorkspace();

        repository.Write("src/app.cs", "// code");
        repository.Commit("initial");

        using var recorder = new RecordingConsole();
        using var provider = new StandardErrorLoggerProvider(recorder.Error.CreateTextWriter());
        using var factory = new LoggerFactory([provider]);

        // Token-shaped, so the report's net — which is path-only by design — cannot help.
        const string Revision = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";

        var source = new GitChangedFileSource(repository.Root, Revision, factory.CreateLogger<GitChangedFileSource>());

        var changes = await source.GetChangedFilesAsync(CancellationToken.None);

        changes.UnavailableReason.Should().NotBeNull();
        recorder.StandardError.Should().NotContain(Revision);
        recorder.StandardError.Should().Contain("--changed-since");
    }

    [Fact]
    public void Write_WhenARecordCarriesAnException_PrintsItsTypeAndMessageWithoutFrames()
    {
        using var recorder = new RecordingConsole();
        using var provider = new StandardErrorLoggerProvider(recorder.Error.CreateTextWriter());

        Exception captured;

        try
        {
            throw new TimeoutException("the endpoint stopped answering");
        }
        catch (TimeoutException exception)
        {
            captured = exception;
        }

        provider
            .CreateLogger("Forge.EvalEngine.Coordination.RunCoordinator")
            .Log(LogLevel.Error, default, "a run could not be conducted", captured, (state, _) => state);

        // The type and the message are the diagnostic; the frames are the disclosure.
        recorder.StandardError.Should().Contain("TimeoutException").And.Contain("stopped answering");
        recorder.StandardError.Should().Contain("a run could not be conducted");
        recorder.StandardError.Should().NotContain("   at ").And.NotContain("StandardErrorLoggerProvider");
    }

    // -------------------------------------------------------------------------------------
    // Round four. Sanitize has four effects — it flattens control characters, replaces comment
    // delimiters, aliases machine paths, and clips — and three of these turn on not confusing
    // the one it is named for with the other three.
    // -------------------------------------------------------------------------------------

    /// <summary>A git repository whose --root is a subdirectory, so a sibling change is outside it.</summary>
    private static GitChangedFileSource OutsideRootSource(GitWorkspace repository, ILoggerFactory factory)
    {
        repository.Write("tools/EvalCli/keep.cs", "// inside the root");
        repository.Write("docs/outside.md", "outside the root");
        repository.Commit("baseline");

        repository.Write("docs/outside.md", "changed outside the root");

        return new GitChangedFileSource(
            Path.Combine(repository.Root, "tools", "EvalCli"),
            "HEAD",
            factory.CreateLogger<GitChangedFileSource>()
        );
    }

    [Fact]
    public async Task GetChangedFilesAsync_WhenAChangedFileIsOutsideTheRoot_NamesNeitherTheRootNorLogsIt()
    {
        using var repository = new GitWorkspace();
        using var recorder = new RecordingConsole();
        using var provider = new StandardErrorLoggerProvider(recorder.Error.CreateTextWriter());
        using var factory = new LoggerFactory([provider]);

        var changes = await OutsideRootSource(repository, factory).GetChangedFilesAsync(CancellationToken.None);

        var root = Path.Combine(repository.Root, "tools", "EvalCli");

        // Both the value the caller reads and the line the log carries. Quote() strips control
        // characters, which is not path redaction — the same reason Because() was deleted.
        changes.UnavailableReason.Should().NotBeNull().And.Subject.ToString().Should().NotContain(root);
        recorder.StandardError.Should().NotContain(root).And.NotContain(repository.Root);

        // The diagnostic still has to do its job: which file, and why it could not be matched.
        changes.UnavailableReason.Should().Contain("outside.md").And.Contain("--root");
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheRevisionIsRejected_DoesNotRecordTheAttemptedCommandAsProvenance()
    {
        using var repository = new GitWorkspace();

        repository.Write("eval-suites/regression.json", SuiteFixture.Suite("regression"));
        repository.Commit("baseline");

        const string Revision = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";

        using var recorder = new RecordingConsole();
        using var provider = new StandardErrorLoggerProvider(recorder.Error.CreateTextWriter());
        using var factory = new LoggerFactory([provider]);

        var changes = await new GitChangedFileSource(
            repository.Root,
            Revision,
            factory.CreateLogger<GitChangedFileSource>()
        ).GetChangedFilesAsync(CancellationToken.None);

        // Source is provenance for a set that was established. Nothing was established here, so
        // recording the attempted command hands the rejected revision to the JSON on stdout.
        changes.Established.Should().BeFalse();
        changes.Source.Should().BeNull();
        changes.UnavailableReason.Should().NotContain(Revision);
    }

    [Fact]
    public async Task ExecuteAsync_WhenAFindingIsTransformedWithoutAMachinePath_DoesNotAccuseTheAuthorOfOne()
    {
        using var workspace = new TempWorkspace();

        // A comment delimiter is replaced by Sanitize, so the text changes — but no path was
        // found, and telling the author to rename one sends them looking for nothing.
        workspace.WriteFile(
            Path.Combine("eval-suites", "regression.json"),
            "{ \"schemaVersion\": \"1.0\", \"name\": \"regression\", \"scenarios\": [ { \"identity\": "
                + "{ \"id\": \"checkout\", \"kind\": \"rest\" }, \"execution\": { \"mode\": \"deterministic\", "
                + "\"terminalCondition\": { \"maxTurns\": 5, \"stopOnParticipantCompletion\": false } }, "
                + "\"simulation\": { \"opening\": \"hello\" }, \"grading\": { \"expectedOutcome\": \"done\", "
                + "\"assertions\": [\"exactMatch:a<!--b\"] } } ] }"
        );

        using var console = new RecordingConsole();

        var stderr = await ReportedAsync(() =>
            RunCommand.ExecuteAsync(
                RunPlan.Create(new RunRequest { Suite = "eval-suites/regression.json", Root = workspace.Root }),
                console,
                CancellationToken.None
            )
        );

        stderr.Should().Contain("assertion.turnScopeRequired");
        stderr.Should().NotContain("carrying a machine path").And.NotContain("rename it");
    }

    // -------------------------------------------------------------------------------------
    // Round five. Both of these are a property violated somewhere I had already fixed its
    // twin: a message composed from a path the type holds, and a guard asking its question
    // about different text than the renderer answers it with.
    // -------------------------------------------------------------------------------------

    [Fact]
    public void TryComputePrefix_WhenTheRootIsNotInsideTheRepository_NamesNeitherRoot()
    {
        using var repository = new GitWorkspace();

        var outside = Path.Combine(Path.GetTempPath(), "forge-evalcli-outside", Guid.NewGuid().ToString("N"));

        GitDiffReading.TryComputePrefix(repository.Root, outside, out _, out var rejection).Should().BeFalse();

        // The fourth helper in this file family to compose a message from a path it holds.
        rejection.Should().NotBeNull();
        rejection!.Should().NotContain(repository.Root).And.NotContain(outside);

        // And it still has to say what went wrong and which option to look at.
        rejection.Should().Contain("--root").And.Contain("git repository");
    }

    [Fact]
    public void RequireDistinctAliases_WhenTwoValuesDifferOnlyByAControlCharacterInsideAPath_Refuses()
    {
        // Flatten turns the tab into a space, so both render as exactly the same string — two
        // different scenarios shown to a reviewer as one. The guard hashed the raw values, where
        // they differ, and so agreed they were distinct.
        var refuse = () => MarkdownReport.RequireDistinctAliases(["/home/a\tb/repo", "/home/a b/repo"]);

        refuse.Should().Throw<InvalidOperationException>();
    }

    [Fact]
    public void RequireDistinctAliases_WhenAControlCharacterBreaksThePathShape_DoesNotTreatItAsAPath()
    {
        // Raw, each of these matches the net; flattened, none does — the space after /home/ ends
        // the shape. Hashing the raw value invents aliases for paths that are never rendered as
        // one, and at this width they collide with each other.
        var values = Enumerable.Range(0, 64).Select(index => $"/home/\u0007user{index}/repo").ToArray();

        var accept = () => MarkdownReport.RequireDistinctAliases(values, hexLength: 1);

        accept.Should().NotThrow();
    }

    [Fact]
    public async Task ExecuteAsync_WhenAControlCharacterBreaksAPathShape_DoesNotClaimAPathWasRedacted()
    {
        using var workspace = new TempWorkspace();

        // Sanitize flattens control characters *before* it runs the net, so this never matches
        // and is never aliased. Asking the net about the raw value instead would say a path was
        // found and redacted when neither happened — the same confusion, one layer down.
        workspace.WriteFile(
            Path.Combine("eval-suites", "regression.json"),
            "{ \"schemaVersion\": \"1.0\", \"name\": \"regression\", \"scenarios\": [ { \"identity\": "
                + "{ \"id\": \"checkout\", \"kind\": \"rest\" }, \"execution\": { \"mode\": \"deterministic\", "
                + "\"terminalCondition\": { \"maxTurns\": 5, \"stopOnParticipantCompletion\": false } }, "
                + "\"simulation\": { \"opening\": \"hello\" }, \"grading\": { \"expectedOutcome\": \"done\", "
                + "\"assertions\": [\"exactMatch:/home/\\u0007ci-runner\"] } } ] }"
        );

        using var console = new RecordingConsole();

        var stderr = await ReportedAsync(() =>
            RunCommand.ExecuteAsync(
                RunPlan.Create(new RunRequest { Suite = "eval-suites/regression.json", Root = workspace.Root }),
                console,
                CancellationToken.None
            )
        );

        stderr.Should().Contain("assertion.turnScopeRequired");
        stderr.Should().NotContain("carrying a machine path").And.NotContain("rename it");
    }

    [Fact]
    public async Task Report_WhenARefusalCarriesSeveralFindings_KeepsThemOnSeparateLines()
    {
        using var workspace = new TempWorkspace();

        // Two findings at once, which the refusal joins with newlines. Sanitize flattens control
        // characters, so netting this tool's own message would run them into one line.
        workspace.WriteFile(
            Path.Combine("eval-suites", "regression.json"),
            "{ \"schemaVersion\": \"1.0\", \"name\": \"regression\", \"scenarios\": [ { \"identity\": "
                + "{ \"id\": \"checkout\", \"kind\": \"rest\" }, \"execution\": { \"mode\": \"deterministic\", "
                + "\"terminalCondition\": { \"maxTurns\": 5, \"stopOnParticipantCompletion\": false } }, "
                + "\"simulation\": { \"opening\": \"hello\" }, \"grading\": { \"expectedOutcome\": \"done\", "
                + "\"assertions\": [\"exactMatch:outcome\"] } } ] }"
        );

        using var console = new RecordingConsole();

        var stderr = await ReportedAsync(() =>
            RunCommand.ExecuteAsync(
                RunPlan.Create(new RunRequest { Suite = "eval-suites/regression.json", Root = workspace.Root }),
                console,
                CancellationToken.None
            )
        );

        stderr
            .Split('\n')
            .Count(line => line.Contains("Error: [", StringComparison.Ordinal))
            .Should()
            .Be(2, "each finding is its own line, and flattening would merge them");
    }
}
