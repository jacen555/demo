using System.Text.Json;
using FluentAssertions;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Composition;
using Forge.EvalCli.Tests.Support;
using Microsoft.Extensions.DependencyInjection;

namespace Forge.EvalCli.Tests.Cli;

/// <summary>
/// The second baseline mechanism: conduct the suite against a baseline address and compare the
/// candidate to that.
/// </summary>
/// <remarks>
/// <para>
/// Two real endpoints, because what this exercises is the composition root building a second
/// harness bound to a second address. A stubbed handler would leave exactly that wiring
/// unexercised — and the wiring is the part that can produce a well-formed baseline describing
/// the wrong system.
/// </para>
/// <para>
/// <b>One comparator serves both mechanisms.</b> Nothing downstream of the provider knows or
/// cares where a <c>SuiteResult</c> came from, and these tests assert the same report shape the
/// committed-artifact tests do.
/// </para>
/// </remarks>
public class LiveBaselineTests
{
    private static RunPlan Plan(TempWorkspace workspace, StubEndpoint candidate, StubEndpoint baseline) =>
        RunPlan.Create(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = workspace.Root,
                Endpoint = candidate.Address.ToString(),
                BaselineEndpoint = baseline.Address.ToString(),
                RestExchange = "json",
                Json = true,
            }
        );

    [Fact]
    public async Task ExecuteAsync_AgainstALiveBaseline_ConductsBothSidesAndReportsTheRegression()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var baseline = ComparisonWorkspace.Endpoint();
        await using var candidate = ComparisonWorkspace.Endpoint(ComparisonWorkspace.Checkout);
        using var console = new RecordingConsole();

        var code = await RunCommand.ExecuteAsync(Plan(workspace, candidate, baseline), console, CancellationToken.None);

        code.Should().Be(ExitCode.Success, console.StandardError);

        var comparison = JsonDocument.Parse(console.StandardOut).RootElement.GetProperty("comparison");

        comparison.GetProperty("mechanism").GetString().Should().Be("live-endpoint");
        comparison.GetProperty("regressed").EnumerateArray().Select(e => e.GetString()).Should().Equal("checkout");
        comparison.GetProperty("classificationCounts").GetProperty("stable-pass").GetInt32().Should().Be(1);

        // Both sides were actually conducted, against their own addresses.
        baseline.Requests.Should().Be(2);
        candidate.Requests.Should().Be(2);
    }

    [Fact]
    public async Task ExecuteAsync_AgainstALiveBaseline_ReportsWhatTheChangeFixed()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var baseline = ComparisonWorkspace.Endpoint(ComparisonWorkspace.Checkout);
        await using var candidate = ComparisonWorkspace.Endpoint();
        using var console = new RecordingConsole();

        await RunCommand.ExecuteAsync(Plan(workspace, candidate, baseline), console, CancellationToken.None);

        var comparison = JsonDocument.Parse(console.StandardOut).RootElement.GetProperty("comparison");

        comparison.GetProperty("newlyCovered").EnumerateArray().Select(e => e.GetString()).Should().Equal("checkout");
    }

    [Fact]
    public async Task ExecuteAsync_AgainstALiveBaseline_NamesOnlyTheRedactedAddress()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var baseline = ComparisonWorkspace.Endpoint();
        await using var candidate = ComparisonWorkspace.Endpoint();
        using var console = new RecordingConsole();

        await RunCommand.ExecuteAsync(
            Plan(workspace, candidate, baseline) with
            {
                Json = false,
            },
            console,
            CancellationToken.None
        );

        // The unredacted address is handed to the engine so it can verify the artifact it gets
        // back. It must not reach anything printed: the path is where a key is as much at home as
        // in a query string.
        console.StandardOut.Should().Contain("<redacted>");
        console.StandardOut.Should().NotContain("/evaluate");
        console.StandardError.Should().NotContain("/evaluate");
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheBaselineEndpointCannotBeReached_RefusesRatherThanCreditingTheChange()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var candidate = ComparisonWorkspace.Endpoint();
        using var console = new RecordingConsole();

        // Nothing is listening on the baseline address, so every baseline run is recorded as an
        // error — the harness could not ask the question, rather than the system answering badly.
        var plan = RunPlan.Create(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = workspace.Root,
                Endpoint = candidate.Address.ToString(),
                BaselineEndpoint = "http://localhost:1/evaluate",
                RestExchange = "json",
            }
        );

        var act = async () => await RunCommand.ExecuteAsync(plan, console, CancellationToken.None);
        var refusal = await act.Should().ThrowAsync<EvalCliException>();

        // No repetition has a verdict on both sides, so nothing is comparable. Reported as a
        // refusal: a baseline system that was down must never be rendered as a change that fixed
        // everything.
        refusal.Which.ExitCode.Should().Be(ExitCode.ComparisonRefused);
        refusal.Which.ExitCode.Should().NotBe(ExitCode.Success);
        console.StandardOut.Should().BeEmpty();
    }

    [Fact]
    public async Task ExecuteAsync_WithALiveBaselineAndSelection_RunsTheWholeSuiteBecauseNothingRecordsAPriorPass()
    {
        using var repository = new GitWorkspace();

        await using var baseline = ComparisonWorkspace.Endpoint();
        await using var candidate = ComparisonWorkspace.Endpoint();

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
        repository.Commit("baseline");
        repository.Write("src/Checkout.cs", "changed");

        using var console = new RecordingConsole();

        var code = await RunCommand.ExecuteAsync(
            RunPlan.Create(
                new RunRequest
                {
                    Suite = "eval-suites/regression.json",
                    Root = repository.Root,
                    Endpoint = candidate.Address.ToString(),
                    BaselineEndpoint = baseline.Address.ToString(),
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

        // A live baseline gives the selector nothing to skip on: only a committed artifact
        // records a prior trustworthy pass, so every scenario is selected as `new` and the whole
        // suite runs even though only one file changed. Over-selecting costs time; the
        // alternative is a scenario retired on evidence nobody has, which costs correctness.
        report.GetProperty("scenariosSelected").GetInt32().Should().Be(2);
        report.GetProperty("selectionCounts").GetProperty("new").GetInt32().Should().Be(1);
        report.GetProperty("selectionCounts").GetProperty("glob-match").GetInt32().Should().Be(1);

        candidate.Requests.Should().Be(2);
        baseline.Requests.Should().Be(2);

        // Both sides conducted the same scenarios, so nothing had to be withheld and nothing is
        // reported as removed.
        var comparison = report.GetProperty("comparison");

        comparison.GetProperty("classificationCounts").GetProperty("removed").GetInt32().Should().Be(0);
        comparison.GetProperty("notCompared").EnumerateArray().Should().BeEmpty();
    }

    [Fact]
    public void ForEndpoint_WhenAskedForAnAddressItWasNotWiredFor_RefusesRatherThanConductingTheSuiteAnyway()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        var plan = RunPlan.Create(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = workspace.Root,
                Endpoint = "http://localhost:8787/evaluate",
                BaselineEndpoint = "http://localhost:8788/evaluate",
                RestExchange = "json",
            }
        );

        using var writer = new StringWriter();
        using var provider = EvalCliServices.Build(plan, writer);

        var coordinators = provider.GetRequiredService<BaselineEndpointCoordinators>();

        var act = () => coordinators.ForEndpoint(new Uri("http://localhost:9999/evaluate"));

        // The engine verifies the artifact it gets back and would refuse a mismatch afterwards.
        // Refusing here means a suite is not conducted against the wrong system first — load on
        // somebody else's machine is not something to discover and then apologise for.
        act.Should().Throw<InvalidOperationException>().WithMessage("*not wired for*");

        // And the address it was wired for is accepted, so the guard is not simply refusing
        // everything.
        coordinators.ForEndpoint(new Uri("http://localhost:8788/evaluate")).Should().NotBeNull();
    }

    [Fact]
    public async Task Build_WhenNoBaselineEndpointWasNamed_WiresNoSecondHarness()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var candidate = ComparisonWorkspace.Endpoint();

        var plan = RunPlan.Create(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = workspace.Root,
                Endpoint = candidate.Address.ToString(),
                RestExchange = "json",
            }
        );

        using var writer = new StringWriter();
        using var provider = EvalCliServices.Build(plan, writer);

        // A second harness that existed unasked-for would hold a client pointed somewhere nobody
        // chose — the same rule that keeps an unselected exchange unregistered.
        provider
            .GetService(typeof(BaselineEndpointCoordinators))
            .Should()
            .BeNull("nothing may be wired to a second address unless one was named");
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheBaselineAddressRedirectsToTheCandidate_DoesNotCompareItAgainstItself()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var candidate = ComparisonWorkspace.Endpoint();

        // The baseline address answers every request with a redirect to the candidate. A client
        // that follows it produces a well-formed baseline artifact describing the candidate,
        // stamped with the baseline address — because both the engine's verification and this
        // tool's self-comparison guard read the address that was *asked for*, and that one is
        // genuinely the baseline's.
        await using var baseline = new StubEndpoint(_ => new StubReply
        {
            Status = 307,
            Location = candidate.Address.ToString(),
        });

        using var console = new RecordingConsole();

        var act = async () =>
            await RunCommand.ExecuteAsync(Plan(workspace, candidate, baseline), console, CancellationToken.None);

        var refusal = await act.Should().ThrowAsync<EvalCliException>();

        // The load is the evidence: every request the candidate saw must be one this run sent it
        // deliberately. Two scenarios, one repetition each.
        candidate
            .Requests.Should()
            .Be(2, "a redirect must not deliver the baseline's runs to the system under review");

        // And nothing may be reported as a comparison. A baseline conducted against the candidate
        // agrees with it about everything, which renders as a clean run over an unexamined change.
        refusal.Which.ExitCode.Should().NotBe(ExitCode.Success);
        console.StandardOut.Should().BeEmpty();
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheEndpointRedirectsElsewhere_DoesNotConductTheSuiteAgainstTheDestination()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var elsewhere = ComparisonWorkspace.Endpoint();

        await using var endpoint = new StubEndpoint(_ => new StubReply
        {
            Status = 308,
            Location = elsewhere.Address.ToString(),
        });

        using var console = new RecordingConsole();

        var code = await RunCommand.ExecuteAsync(
            RunPlan.Create(
                new RunRequest
                {
                    Suite = "eval-suites/regression.json",
                    Root = workspace.Root,
                    Endpoint = endpoint.Address.ToString(),
                    RestExchange = "json",
                    Json = true,
                }
            ),
            console,
            CancellationToken.None
        );

        // The address in the artifact is the address that was asked for, so a run that silently
        // landed somewhere else would be attributed to the wrong system for good.
        elsewhere.Requests.Should().Be(0, "the suite must be conducted against the address it names");

        // And the harness says it could not ask the question, rather than grading the redirect as
        // the system under test answering badly — which would read as a failure, or against a
        // redirecting baseline as every scenario having been fixed.
        code.Should().Be(ExitCode.RunFailed, console.StandardOut);
        console.StandardOut.Should().Contain("\"harnessFailed\": true");
    }
}
