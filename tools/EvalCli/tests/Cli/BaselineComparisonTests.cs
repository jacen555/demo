using System.Text;
using System.Text.Json;
using FluentAssertions;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Tests.Support;
using Forge.EvalEngine.Comparison;

namespace Forge.EvalCli.Tests.Cli;

/// <summary>
/// Comparison wired into a run: what it reports, and — more importantly — what it refuses.
/// </summary>
/// <remarks>
/// <b>Every baseline in this file was produced by conducting the suite.</b> The verdicts these
/// tests assert on were earned by a system under test answering differently between two runs,
/// which is the only way to establish that the comparison reflects behaviour rather than an
/// artifact somebody typed.
/// </remarks>
public class BaselineComparisonTests
{
    private static RunPlan Plan(
        TempWorkspace workspace,
        StubEndpoint endpoint,
        string? baseline = "artifacts/baseline.json",
        string? output = null,
        string? changedSince = null,
        bool json = true
    ) =>
        RunPlan.Create(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = workspace.Root,
                Baseline = baseline,
                Out = output,
                Endpoint = endpoint.Address.ToString(),
                RestExchange = "json",
                ChangedSince = changedSince,
                Json = json,
            }
        );

    private static async Task SeedBaselineAsync(TempWorkspace workspace, StubEndpoint endpoint)
    {
        using var console = new RecordingConsole();

        var code = await RunCommand.ExecuteAsync(
            Plan(workspace, endpoint, baseline: null, output: "artifacts/baseline.json", json: false),
            console,
            CancellationToken.None
        );

        code.Should().Be(ExitCode.Success, console.StandardError);
    }

    private static async Task<(ExitCode Code, JsonElement Report, string StandardOut)> CompareAsync(
        TempWorkspace workspace,
        StubEndpoint endpoint,
        string? changedSince = null
    )
    {
        using var console = new RecordingConsole();

        var code = await RunCommand.ExecuteAsync(
            Plan(workspace, endpoint, changedSince: changedSince),
            console,
            CancellationToken.None
        );

        return (code, JsonDocument.Parse(console.StandardOut).RootElement.Clone(), console.StandardOut);
    }

    [Fact]
    public async Task ExecuteAsync_WhenAScenarioStoppedPassing_ReportsItAsARegression()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var before = ComparisonWorkspace.Endpoint();

        await SeedBaselineAsync(workspace, before);

        await using var after = ComparisonWorkspace.Endpoint(ComparisonWorkspace.Checkout);

        var (code, report, _) = await CompareAsync(workspace, after);
        var comparison = report.GetProperty("comparison");

        comparison.GetProperty("regressed").EnumerateArray().Select(e => e.GetString()).Should().Equal("checkout");
        comparison.GetProperty("classificationCounts").GetProperty("stable-pass").GetInt32().Should().Be(1);

        // Report-only in this build: the gate that turns a regression into a non-zero exit is
        // reserved, and --fail-on-regression is deliberately inert.
        code.Should().Be(ExitCode.Success);
        comparison.GetProperty("enforced").GetBoolean().Should().BeFalse();
    }

    [Fact]
    public async Task ExecuteAsync_WhenAScenarioStartedPassing_ReportsItAsNewlyCovered()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var broken = ComparisonWorkspace.Endpoint(ComparisonWorkspace.Checkout);

        await SeedBaselineAsync(workspace, broken);

        await using var fixedUp = ComparisonWorkspace.Endpoint();

        var (code, report, standardOut) = await CompareAsync(workspace, fixedUp);
        var comparison = report.GetProperty("comparison");

        // The headline. A harness that reported only what broke would be a worse test suite.
        comparison.GetProperty("newlyCovered").EnumerateArray().Select(e => e.GetString()).Should().Equal("checkout");
        comparison.GetProperty("classificationCounts").GetProperty("fixed").GetInt32().Should().Be(1);
        comparison.GetProperty("regressed").EnumerateArray().Should().BeEmpty();

        code.Should().Be(ExitCode.Success);
        standardOut.Should().Contain("newlyCovered");
    }

    [Fact]
    public async Task RenderText_WhenAScenarioWasNewlyCovered_NamesItBeforeAnythingThatBroke()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var broken = ComparisonWorkspace.Endpoint(
            ComparisonWorkspace.Checkout,
            ComparisonWorkspace.Billing
        );

        await SeedBaselineAsync(workspace, broken);

        await using var partiallyFixed = ComparisonWorkspace.Endpoint(ComparisonWorkspace.Billing);
        using var console = new RecordingConsole();

        await RunCommand.ExecuteAsync(Plan(workspace, partiallyFixed, json: false), console, CancellationToken.None);

        var text = console.StandardOut;

        text.Should().Contain("newly covered").And.Contain("checkout");
        text.Should()
            .Match("*newly covered*regressed*", "what a change fixed is the reason this harness exists, so it leads");
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheSuiteDefinitionChanged_RefusesRatherThanReportingOnTheRest()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var endpoint = ComparisonWorkspace.Endpoint();

        await SeedBaselineAsync(workspace, endpoint);

        // The scenario is redefined: a different opening stimulus is a different definition
        // fingerprint, so the baseline's entry and this run's entry are not the same scenario.
        // Only one of the two scenarios is redefined, so the other one still compares — and that
        // is the whole point. A guard that fired only when *every* pair was uncomparable would
        // return zero over this, and the report would read "0 regressed" across a scenario
        // nothing examined.
        ComparisonWorkspace.WriteSuite(workspace, checkoutOpening: "goodbye");

        using var console = new RecordingConsole();

        var act = async () =>
            await RunCommand.ExecuteAsync(Plan(workspace, endpoint, json: false), console, CancellationToken.None);

        var refusal = await act.Should().ThrowAsync<EvalCliException>();

        refusal.Which.ExitCode.Should().Be(ExitCode.ComparisonRefused);
        refusal.Which.ExitCode.Should().NotBe(ExitCode.Success);

        // The refusal names what was not examined and why, rather than a bare count.
        refusal.Which.Message.Should().Contain("checkout").And.Contain("redefined");

        // Billing did compare. The message says so, so a reader is not left believing the whole
        // suite went unexamined.
        refusal.Which.Message.Should().Contain("1 of 2");

        // And the instruction is to regenerate, never to edit — editing is what would defeat the
        // fingerprint guard entirely.
        refusal.Which.Remedy.Should().Contain("baseline update --apply");
        refusal.Which.Remedy.Should().Contain("Never edit a baseline by hand");

        console.StandardOut.Should().BeEmpty("a refused comparison must not also render as a result");
    }

    [Fact]
    public async Task ExecuteAsync_WhenNoScenarioCouldBeCompared_RefusesRatherThanReportingNoChanges()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var endpoint = ComparisonWorkspace.Endpoint();

        await SeedBaselineAsync(workspace, endpoint);

        // Both scenarios redefined, so every available pair is NotComparable. This is the shape a
        // baseline predating DefinitionFingerprint has against any current run.
        workspace.WriteFile(
            Path.Combine("eval-suites", "regression.json"),
            SuiteFixture.Suite(
                "regression",
                SuiteFixture.Scenario(
                    ComparisonWorkspace.Checkout,
                    ["src/**"],
                    opening: "goodbye",
                    expectedOutcome: ComparisonWorkspace.ExpectedOutcome
                ),
                SuiteFixture.Scenario(
                    ComparisonWorkspace.Billing,
                    ["docs/**"],
                    opening: "goodbye",
                    expectedOutcome: ComparisonWorkspace.ExpectedOutcome
                )
            )
        );

        using var console = new RecordingConsole();

        var act = async () =>
            await RunCommand.ExecuteAsync(Plan(workspace, endpoint, json: false), console, CancellationToken.None);

        var refusal = await act.Should().ThrowAsync<EvalCliException>();

        // The false green this whole stage exists for: rendered as counts, this reads
        // "0 regressed, 0 newly covered" and exits zero — a green check over a change nothing
        // examined.
        refusal.Which.ExitCode.Should().Be(ExitCode.ComparisonRefused);
        refusal.Which.ExitCode.Should().NotBe(ExitCode.Success);
        refusal.Which.Message.Should().Contain("2 of 2 scenario(s) could not be compared");
        refusal.Which.Message.Should().Contain("0 of 2 did compare");
        refusal.Which.Remedy.Should().Contain("Never edit a baseline by hand");
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheRunWasNarrowed_WithholdsTheSkippedScenariosRatherThanCallingThemRemoved()
    {
        using var repository = new GitWorkspace();

        await using var endpoint = ComparisonWorkspace.Endpoint();

        repository.Write("src/Checkout.cs", "original");
        repository.Write("docs/billing.md", "original");
        repository.Write(
            "eval-suites/regression.json",
            SuiteFixture.Suite(
                "regression",
                SuiteFixture.Scenario(
                    ComparisonWorkspace.Checkout,
                    ["src/**"],
                    expectedOutcome: ComparisonWorkspace.ExpectedOutcome
                ),
                SuiteFixture.Scenario(
                    ComparisonWorkspace.Billing,
                    ["docs/**"],
                    expectedOutcome: ComparisonWorkspace.ExpectedOutcome
                )
            )
        );
        repository.Write(".gitignore", "artifacts/\n");
        repository.Commit("baseline");
        Directory.CreateDirectory(Path.Combine(repository.Root, "artifacts"));

        using var seeding = new RecordingConsole();

        var seeded = await RunCommand.ExecuteAsync(
            RunPlan.Create(
                new RunRequest
                {
                    Suite = "eval-suites/regression.json",
                    Root = repository.Root,
                    Out = "artifacts/baseline.json",
                    Endpoint = endpoint.Address.ToString(),
                    RestExchange = "json",
                }
            ),
            seeding,
            CancellationToken.None
        );

        seeded.Should().Be(ExitCode.Success, seeding.StandardError);

        repository.Write("src/Checkout.cs", "changed");

        using var console = new RecordingConsole();

        await RunCommand.ExecuteAsync(
            RunPlan.Create(
                new RunRequest
                {
                    Suite = "eval-suites/regression.json",
                    Root = repository.Root,
                    Baseline = "artifacts/baseline.json",
                    Endpoint = endpoint.Address.ToString(),
                    RestExchange = "json",
                    ChangedSince = "HEAD",
                    Json = true,
                }
            ),
            console,
            CancellationToken.None
        );

        var comparison = JsonDocument.Parse(console.StandardOut).RootElement.GetProperty("comparison");

        // billing did not run, so this run produced no candidate evidence about it. Handing the
        // comparator the whole baseline would classify it Removed — a confident claim about a
        // change nobody made.
        comparison.GetProperty("classificationCounts").GetProperty("removed").GetInt32().Should().Be(0);
        comparison.GetProperty("notCompared").EnumerateArray().Select(e => e.GetString()).Should().Equal("billing");
        comparison.GetProperty("notComparedReason").GetString().Should().Contain("skipped by selection");

        // And the scenario that did run was compared.
        comparison.GetProperty("classificationCounts").GetProperty("stable-pass").GetInt32().Should().Be(1);
    }

    [Fact]
    public async Task ExecuteAsync_WhenInterruptedAfterTheArtifactWasWritten_DoesNotClaimNothingWasWritten()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var endpoint = ComparisonWorkspace.Endpoint();

        using var cancellation = new CancellationTokenSource();

        // Cancelled the instant the command reaches for standard output, which is after the
        // artifact is on disk and before a word of the report is written.
        using var console = new RecordingConsole(cancellation.Cancel);

        var act = async () =>
            await RunCommand.ExecuteAsync(
                RunPlan.Create(
                    new RunRequest
                    {
                        Suite = "eval-suites/regression.json",
                        Root = workspace.Root,
                        Out = "artifacts/eval.json",
                        Endpoint = endpoint.Address.ToString(),
                        RestExchange = "json",
                    }
                ),
                console,
                cancellation.Token
            );

        var interruption = (await act.Should().ThrowAsync<OperationCanceledException>()).Which;

        File.Exists(Path.Combine(workspace.Root, "artifacts", "eval.json"))
            .Should()
            .BeTrue("the test is only meaningful if the artifact actually landed first");

        using var reported = new RecordingConsole();

        ExitCodeReporter.Report(interruption, reported).Should().Be(ExitCode.Interrupted);

        reported.StandardError.Should().NotContain("nothing was written");
        reported.StandardError.Should().Contain("eval.json");
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheBaselineRunIsInterruptedAfterTheArtifactWasWritten_DoesNotClaimNothingWasWritten()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var candidate = ComparisonWorkspace.Endpoint();

        using var cancellation = new CancellationTokenSource();

        // Cancelled by the baseline endpoint itself, on the first request it is asked to answer.
        // That instant is inside the comparison: the candidate has already run and --out is
        // already on disk, and nothing has been rendered or printed.
        await using var baseline = new StubEndpoint(_ =>
        {
            cancellation.Cancel();

            return new StubReply
            {
                Status = 200,
                Body = $"{{ \"output\": \"ok\", \"outcome\": \"{ComparisonWorkspace.ExpectedOutcome}\" }}",
            };
        });

        using var console = new RecordingConsole();

        var act = async () =>
            await RunCommand.ExecuteAsync(
                RunPlan.Create(
                    new RunRequest
                    {
                        Suite = "eval-suites/regression.json",
                        Root = workspace.Root,
                        Out = "artifacts/eval.json",
                        Endpoint = candidate.Address.ToString(),
                        BaselineEndpoint = baseline.Address.ToString(),
                        RestExchange = "json",
                    }
                ),
                console,
                cancellation.Token
            );

        var interruption = (await act.Should().ThrowAsync<OperationCanceledException>()).Which;

        File.Exists(Path.Combine(workspace.Root, "artifacts", "eval.json"))
            .Should()
            .BeTrue("the test is only meaningful if the artifact actually landed first");

        using var reported = new RecordingConsole();

        ExitCodeReporter.Report(interruption, reported).Should().Be(ExitCode.Interrupted);

        // Interruption during the comparison is the same defect as interruption during the
        // report: the artifact is on disk either way, and the blanket sentence sends a caller
        // looking straight past the file they now have.
        reported.StandardError.Should().NotContain("nothing was written");
        reported.StandardError.Should().Contain("eval.json");
    }

    [Fact]
    public void AppendTo_WhenARefusedPairRecordsNoReason_StillNamesItAmongTheScenariosNobodyExamined()
    {
        // Constructed rather than conducted, deliberately. ScenarioComparison.NotComparableReason
        // is a nullable member of a public record this tool does not own, and the section below
        // is defined by the classification — so the renderer has to be total over the contract
        // rather than over what today's comparator happens to emit. See AppendRefusals.
        var outcome = new ComparisonOutcome
        {
            Mechanism = BaselineMechanism.Artifact,
            Reference = "artifacts/baseline.json",
            ReferenceIdentity = ReportIdentity.ForSegments(["artifacts", "baseline.json"]),
            Baseline = ReportFixture.Artifact(ReportFixture.Ungradeable(ComparisonWorkspace.Checkout)),
            Candidate = ReportFixture.Artifact(ReportFixture.Scenario(ComparisonWorkspace.Checkout, 1, 1)),
            Result = new ComparisonResult
            {
                SuiteName = "regression",
                ScenarioComparisons =
                [
                    new ScenarioComparison
                    {
                        ScenarioId = ComparisonWorkspace.Checkout,
                        Classification = ScenarioClassification.NotComparable,
                        BaselineOutcome = ScenarioOutcome.Ungradeable,
                        CandidateOutcome = ScenarioOutcome.Passed,
                        NotComparableReason = null,
                    },
                ],
            },
        };

        var text = new StringBuilder();

        ComparisonReport.AppendTo(text, outcome, verbose: true);

        var rendered = text.ToString();

        // The verbose per-scenario list excludes this entry by classification. Selecting the
        // refusals by the reason instead would drop it from there too, and a scenario nothing
        // examined would be absent from the whole report rather than named in it.
        rendered.Should().Contain("not comparable - these scenarios were not examined by this comparison");
        rendered.Should().Contain(ComparisonWorkspace.Checkout);

        // And the fallback sentence is what makes selecting by classification total: the entry is
        // named with the outcomes that could not be paired, rather than with a blank.
        rendered.Should().Contain("the baseline recorded ungradeable and this run recorded passed");
        rendered.Should().Contain(BaselineComparison.RegenerateRemedy);
    }

    [Fact]
    public async Task ExecuteAsync_WhenNoBaselineWasNamed_ReportsNoComparisonRatherThanAnEmptyOne()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var endpoint = ComparisonWorkspace.Endpoint();
        using var console = new RecordingConsole();

        await RunCommand.ExecuteAsync(Plan(workspace, endpoint, baseline: null), console, CancellationToken.None);

        var report = JsonDocument.Parse(console.StandardOut).RootElement;

        // Null is "no comparison was asked for". A consumer must not be able to read it as "the
        // comparison found nothing".
        report.GetProperty("comparison").ValueKind.Should().Be(JsonValueKind.Null);
    }

    [Fact]
    public async Task ExecuteAsync_WhenSelectionSkipsAnEarlierScenario_StillPairsTheSelectedOneWithItsBaseline()
    {
        using var repository = new GitWorkspace();

        await using var endpoint = ComparisonWorkspace.Endpoint();

        repository.Write("src/Checkout.cs", "original");
        repository.Write("docs/billing.md", "original");
        repository.Write(
            "eval-suites/regression.json",
            SuiteFixture.Suite(
                "regression",
                SuiteFixture.Scenario(
                    ComparisonWorkspace.Checkout,
                    ["src/**"],
                    expectedOutcome: ComparisonWorkspace.ExpectedOutcome
                ),
                SuiteFixture.Scenario(
                    ComparisonWorkspace.Billing,
                    ["docs/**"],
                    expectedOutcome: ComparisonWorkspace.ExpectedOutcome
                )
            )
        );
        repository.Write(".gitignore", "artifacts/\n");
        repository.Commit("baseline");
        Directory.CreateDirectory(Path.Combine(repository.Root, "artifacts"));

        using var seeding = new RecordingConsole();

        var seeded = await RunCommand.ExecuteAsync(
            RunPlan.Create(
                new RunRequest
                {
                    Suite = "eval-suites/regression.json",
                    Root = repository.Root,
                    Out = "artifacts/baseline.json",
                    Endpoint = endpoint.Address.ToString(),
                    RestExchange = "json",
                }
            ),
            seeding,
            CancellationToken.None
        );

        seeded.Should().Be(ExitCode.Success, seeding.StandardError);

        // The *second* scenario is the one that changed, so the selected run skips the first.
        // Seeds are drawn in suite order, so a narrowed run that closed the gap would hand
        // billing the seed checkout was driven with in the baseline, and the pairing — which is
        // by seed, deliberately — would then refuse the one scenario the run was for.
        repository.Write("docs/billing.md", "changed");

        using var console = new RecordingConsole();

        var code = await RunCommand.ExecuteAsync(
            RunPlan.Create(
                new RunRequest
                {
                    Suite = "eval-suites/regression.json",
                    Root = repository.Root,
                    Baseline = "artifacts/baseline.json",
                    Endpoint = endpoint.Address.ToString(),
                    RestExchange = "json",
                    ChangedSince = "HEAD",
                    Json = true,
                }
            ),
            console,
            CancellationToken.None
        );

        code.Should().Be(ExitCode.Success, console.StandardError);

        var report = JsonDocument.Parse(console.StandardOut).RootElement;

        report.GetProperty("scenariosSelected").GetInt32().Should().Be(1);
        report.GetProperty("scenariosSkipped").EnumerateArray().Select(e => e.GetString()).Should().Equal("checkout");

        var comparison = report.GetProperty("comparison");

        comparison.GetProperty("classificationCounts").GetProperty("not-comparable").GetInt32().Should().Be(0);
        comparison.GetProperty("classificationCounts").GetProperty("stable-pass").GetInt32().Should().Be(1);
        comparison.GetProperty("notCompared").EnumerateArray().Select(e => e.GetString()).Should().Equal("checkout");
    }

    /// <summary>
    /// Conducts a run whose second scenario the harness could only partly conduct.
    /// </summary>
    /// <param name="workspace">The workspace to seed the baseline in and conduct against.</param>
    /// <param name="json">Whether to ask for the machine-readable report or the rendered text.</param>
    /// <returns>The exit code and whatever went to standard out.</returns>
    /// <remarks>
    /// The errored repetition is produced by a real aborted exchange rather than by editing an
    /// artifact, for the reason every baseline in this file is conducted: the withholding has to
    /// follow from what the harness could and could not do.
    /// </remarks>
    private static async Task<(ExitCode Code, string StandardOut)> PartlyConductedRunAsync(
        TempWorkspace workspace,
        bool json
    )
    {
        workspace.WriteFile(
            Path.Combine("eval-suites", "regression.json"),
            SuiteFixture.Suite(
                "regression",
                SuiteFixture.Scenario(
                    ComparisonWorkspace.Checkout,
                    expectedOutcome: ComparisonWorkspace.ExpectedOutcome
                )
            )
        );

        await using var seeding = ComparisonWorkspace.Endpoint();

        await SeedBaselineAsync(workspace, seeding);

        // A second scenario the baseline has never seen, repeated twice. One repetition is
        // graded and passes; the other never completes, so the harness asked the question once
        // and could not ask it again.
        workspace.WriteFile(
            Path.Combine("eval-suites", "regression.json"),
            SuiteFixture.Suite(
                "regression",
                SuiteFixture.Scenario(
                    ComparisonWorkspace.Checkout,
                    expectedOutcome: ComparisonWorkspace.ExpectedOutcome
                ),
                SuiteFixture.Scenario("flaky", expectedOutcome: ComparisonWorkspace.ExpectedOutcome, repetitions: 2)
            )
        );

        await using var endpoint = new StubEndpoint(body =>
        {
            using var request = JsonDocument.Parse(body);

            var scenario = request.RootElement.GetProperty("scenarioId").GetString();
            var repetition = request.RootElement.GetProperty("repetition").GetInt32();

            return string.Equals(scenario, "flaky", StringComparison.Ordinal) && repetition == 2
                ? new StubReply { Status = 200, Abort = true }
                : new StubReply
                {
                    Status = 200,
                    Body = $"{{ \"output\": \"ok\", \"outcome\": \"{ComparisonWorkspace.ExpectedOutcome}\" }}",
                };
        });

        using var console = new RecordingConsole();

        var code = await RunCommand.ExecuteAsync(
            Plan(workspace, endpoint, json: json),
            console,
            CancellationToken.None
        );

        return (code, console.StandardOut);
    }

    [Fact]
    public async Task ExecuteAsync_WhenAScenarioWasOnlyPartlyConducted_DoesNotCountItAsNewlyCovered()
    {
        using var workspace = new TempWorkspace();

        var (code, standardOut) = await PartlyConductedRunAsync(workspace, json: true);

        code.Should().Be(ExitCode.RunFailed, "a run the harness could not conduct is never a success");

        var comparison = JsonDocument.Parse(standardOut).RootElement.GetProperty("comparison");

        // The suite asked for two repetitions and got one, so what this change covers is unknown
        // rather than gained. The headline may not claim it — and the scenario may not vanish
        // from the report either, which is what the two fields below are for.
        comparison.GetProperty("newlyCovered").EnumerateArray().Should().BeEmpty();

        var withheld = comparison.GetProperty("newlyCoveredWithheld").EnumerateArray().ToArray();

        withheld.Should().ContainSingle();
        withheld[0].GetProperty("scenarioId").GetString().Should().Be("flaky");

        // End-to-end, against what the comparator actually attributed rather than a constructed
        // fixture: the harness recorded both repetitions and one of them errored, so the cause is
        // `errored` and not `incomplete`. A run that errored is a flake to re-run; a run that
        // never happened is a harness that lost work. The document has to tell them apart.
        withheld[0].GetProperty("cause").GetString().Should().Be("errored");
        withheld[0]
            .GetProperty("reason")
            .GetString()
            .Should()
            .Be(WithheldCoverage.Describe(CoverageWithholdingCause.Errored));
    }

    [Fact]
    public async Task RenderText_WhenAScenarioWasOnlyPartlyConducted_NamesItAndWhyBesideTheHeadline()
    {
        using var workspace = new TempWorkspace();

        var (code, text) = await PartlyConductedRunAsync(workspace, json: false);

        code.Should().Be(ExitCode.RunFailed, "a run the harness could not conduct is never a success");

        // An empty "newly covered" row and a scenario nobody could fully conduct read identically
        // to somebody skimming the text, which is the whole defect. The name has to be on the
        // page, beside the headline, with the reason next to it.
        text.Should().Contain("newly covered").And.Contain("not fully conducted").And.Contain("flaky");

        // The comparator's words, not this tool's. Asserting the engine's phrasing is what pins
        // the reason as passed through rather than re-derived at the report boundary.
        text.Should().Contain("passed every run that produced a verdict rather than every run the suite asked for");
    }

    [Fact]
    public void Document_WhenTheComparatorWithheldCoverage_PassesItsScenariosAndCausesThrough()
    {
        var document = ComparisonReport.Document(
            Withholding(ReportFixture.Withheld("flaky", CoverageWithholdingCause.Errored))
        );

        // Straight from ComparisonResult. The report boundary does not re-derive which scenarios
        // were withheld: the comparator is what measured the repetitions, so anything computed
        // here is a second opinion that can silently disagree with the one that has the evidence.
        document.NewlyCovered.Should().Equal(ComparisonWorkspace.Checkout);
        document.NewlyCoveredWithheld.Should().ContainSingle();

        var withheld = document.NewlyCoveredWithheld[0];

        withheld.ScenarioId.Should().Be("flaky");
        withheld.Cause.Should().Be("errored");
        withheld.Reason.Should().Be(WithheldCoverage.Describe(CoverageWithholdingCause.Errored));
    }

    [Fact]
    public void Document_WhenTwoScenariosWereWithheldForDifferentCauses_KeepsTheirReasonsApart()
    {
        var document = ComparisonReport.Document(
            Withholding(
                ReportFixture.Withheld("flaky", CoverageWithholdingCause.Errored),
                ReportFixture.Withheld("lost", CoverageWithholdingCause.Incomplete)
            )
        );

        // The defect this migration exists to close. A single suite-level reason carried both
        // sentences and said nothing about which scenario had which, so a consumer reading the
        // machine-readable document had to guess an attribution the comparator already computed.
        document
            .NewlyCoveredWithheld.Select(entry => (entry.ScenarioId, entry.Cause))
            .Should()
            .Equal(("flaky", "errored"), ("lost", "incomplete"));

        document
            .NewlyCoveredWithheld.Should()
            .AllSatisfy(entry =>
                entry
                    .Reason.Should()
                    .NotContain(
                        WithheldCoverage.Describe(
                            entry.Cause == "errored"
                                ? CoverageWithholdingCause.Incomplete
                                : CoverageWithholdingCause.Errored
                        ),
                        "no entry may carry the other entry's cause"
                    )
            );
    }

    [Fact]
    public void AppendTo_WhenTheComparatorWithheldCoverage_NamesTheScenariosWithItsReason()
    {
        var text = new StringBuilder();

        ComparisonReport.AppendTo(
            text,
            Withholding(ReportFixture.Withheld("flaky", CoverageWithholdingCause.Errored)),
            verbose: false
        );

        text.ToString().Should().Contain("not fully conducted").And.Contain("flaky");
        text.ToString().Should().Contain(WithheldCoverage.Describe(CoverageWithholdingCause.Errored));
    }

    [Fact]
    public void AppendTo_WhenTwoScenariosWereWithheldForDifferentCauses_StatesWhichScenarioHadWhich()
    {
        var text = new StringBuilder();

        ComparisonReport.AppendTo(
            text,
            Withholding(
                ReportFixture.Withheld("flaky", CoverageWithholdingCause.Errored),
                ReportFixture.Withheld("lost", CoverageWithholdingCause.Incomplete)
            ),
            verbose: false
        );

        var rendered = text.ToString();
        var flaky = rendered.IndexOf("flaky ", StringComparison.Ordinal);
        var lost = rendered.IndexOf("lost ", StringComparison.Ordinal);

        // Both named beside the headline, then one row each. "A run errored" is a flake to
        // re-run and "a run never happened" is a harness that lost work; a reader who cannot see
        // which scenario had which takes the wrong action on one of them.
        rendered.Should().Contain("not fully conducted");
        flaky.Should().BeGreaterThanOrEqualTo(0);
        lost.Should().BeGreaterThan(flaky);

        rendered[flaky..lost].Should().Contain(WithheldCoverage.Describe(CoverageWithholdingCause.Errored));
        rendered[lost..].Should().Contain(WithheldCoverage.Describe(CoverageWithholdingCause.Incomplete));
    }

    [Fact]
    public void AppendTo_WhenAWithheldCauseIsNotDeclared_StillNamesTheScenarios()
    {
        var text = new StringBuilder();

        // WithheldCoverage.Reason throws on a cause outside the enum, on a record this tool does
        // not own. Asking it unguarded would take down the whole rendering — the regressions and
        // the counts with it — because one row carried a value this build does not know.
        ComparisonReport.AppendTo(
            text,
            Withholding(ReportFixture.Withheld("flaky", (CoverageWithholdingCause)(-1))),
            verbose: false
        );

        text.ToString().Should().Contain("not fully conducted").And.Contain("flaky");
        text.ToString().Should().Contain("does not recognise");
    }

    /// <summary>A comparison the comparator withheld some scenarios' coverage from.</summary>
    /// <param name="withheld">The withheld claims, with the cause attributed to each.</param>
    /// <returns>The outcome.</returns>
    /// <remarks>
    /// Constructed rather than conducted: these pin the rendering against the contract
    /// <see cref="ComparisonResult"/> states, not against what today's comparator happens to emit.
    /// </remarks>
    private static ComparisonOutcome Withholding(params WithheldCoverage[] withheld) =>
        new()
        {
            Mechanism = BaselineMechanism.Artifact,
            Reference = "artifacts/baseline.json",
            ReferenceIdentity = ReportIdentity.ForSegments(["artifacts", "baseline.json"]),
            Baseline = ReportFixture.Artifact(ReportFixture.Scenario(ComparisonWorkspace.Checkout, 0, 1)),
            Candidate = ReportFixture.Artifact(
                ReportFixture.Scenario(ComparisonWorkspace.Checkout, 1, 1),
                ReportFixture.Scenario("flaky", 1, 1)
            ),
            Result = new ComparisonResult
            {
                SuiteName = "regression",
                ScenarioComparisons =
                [
                    new ScenarioComparison
                    {
                        ScenarioId = ComparisonWorkspace.Checkout,
                        Classification = ScenarioClassification.Fixed,
                        BaselineOutcome = ScenarioOutcome.Failed,
                        CandidateOutcome = ScenarioOutcome.Passed,
                    },
                    .. withheld.Select(entry => new ScenarioComparison
                    {
                        ScenarioId = entry.ScenarioId,
                        Classification = ScenarioClassification.New,
                        BaselineOutcome = ScenarioOutcome.Absent,
                        CandidateOutcome = ScenarioOutcome.Passed,
                    }),
                ],
                NewlyCovered = [ComparisonWorkspace.Checkout],
                NewlyCoveredWithheld = withheld,
            },
        };
}
