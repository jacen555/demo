using System.CommandLine.IO;
using System.Globalization;
using System.Text.Json;
using FluentAssertions;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Composition;
using Forge.EvalCli.Tests.Support;
using Forge.EvalEngine.Coordination;
using Forge.EvalEngine.Loading;
using Forge.EvalEngine.Runners;
using Microsoft.Extensions.DependencyInjection;

namespace Forge.EvalCli.Tests.Cli;

/// <summary>
/// The address never reaches disk or a diagnostic in the form it was supplied.
/// </summary>
/// <remarks>
/// <para>
/// <b>Asserted against the bytes, not against the report.</b> A report is rendered from
/// <see cref="RunPlan.EndpointDisplay"/> and was already redacted; a transcript is a different
/// object built by the engine from the address that was actually dialled, and it travels into a
/// committed artifact. The two are only the same rule if something applies it to both.
/// </para>
/// <para>
/// The token in these addresses sits in the <i>path</i>, which is the shape that reads as an
/// ordinary routing segment and is therefore the one a reader of a diff does not notice.
/// </para>
/// </remarks>
public class EndpointRedactionTests
{
    private const string PathToken = "sk-live-abc123";

    private static StubEndpoint TokenBearingEndpoint() =>
        new(
            _ => new StubReply
            {
                Status = 200,
                Body = $"{{ \"output\": \"ok\", \"outcome\": \"{ComparisonWorkspace.ExpectedOutcome}\" }}",
            },
            path: $"{PathToken}/evaluate"
        );

    [Fact]
    public async Task ExecuteAsync_WhenTheEndpointPathCarriesAToken_KeepsItOutOfTheRunArtifact()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var endpoint = TokenBearingEndpoint();
        using var console = new RecordingConsole();

        var code = await RunCommand.ExecuteAsync(
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
            CancellationToken.None
        );

        code.Should().Be(ExitCode.Success, console.StandardError);

        var path = Path.Combine(workspace.Root, "artifacts", "eval.json");
        var artifact = await File.ReadAllTextAsync(path, CancellationToken.None);

        // The bytes, because the artifact is the thing that gets committed and reviewed. The
        // transcripts record where each run went, and that record is where the path survived.
        artifact.Should().NotContain(PathToken);

        using var written = JsonDocument.Parse(artifact);
        var expected = $"http://localhost:{endpoint.Address.Port.ToString(CultureInfo.InvariantCulture)}/<redacted>";

        written.RootElement.GetProperty("environment").GetProperty("endpoint").GetString().Should().Be(expected);

        // Per transcript, not only on the environment. The environment's label was already
        // redacted at argument time; the transcripts are built by the engine from the address
        // that was actually dialled, which is a different value that nothing had covered.
        foreach (var scenario in written.RootElement.GetProperty("scenarioResults").EnumerateArray())
        {
            foreach (var run in scenario.GetProperty("runs").EnumerateArray())
            {
                run.GetProperty("transcript")
                    .GetProperty("transport")
                    .GetProperty("endpoint")
                    .GetString()
                    .Should()
                    .Be(expected, "a reader must still be able to tell which host was evaluated");
            }
        }

        console.StandardOut.Should().NotContain(PathToken);
        console.StandardError.Should().NotContain(PathToken);
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheEndpointPathCarriesAToken_KeepsItOutOfTheCommittedBaseline()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var endpoint = TokenBearingEndpoint();

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
                }
            ),
            seeding,
            CancellationToken.None
        );

        seeded.Should().Be(ExitCode.Success, seeding.StandardError);

        using var console = new RecordingConsole();

        var code = await BaselineCommand.ExecuteAsync(
            RunPlan.CreateForBaselineUpdate(
                new RunRequest
                {
                    Suite = "eval-suites/regression.json",
                    Root = workspace.Root,
                    Baseline = "artifacts/baseline.json",
                    Endpoint = endpoint.Address.ToString(),
                    RestExchange = "json",
                    Apply = true,
                }
            ),
            console,
            CancellationToken.None
        );

        code.Should().Be(ExitCode.Success, console.StandardError);

        var baseline = await File.ReadAllTextAsync(
            Path.Combine(workspace.Root, "artifacts", "baseline.json"),
            CancellationToken.None
        );

        // A committed baseline is a tracked source file. A token that reaches one is in the
        // repository's history from that commit onwards.
        baseline.Should().NotContain(PathToken);
        console.StandardOut.Should().NotContain(PathToken);
        console.StandardError.Should().NotContain(PathToken);
    }

    [Theory]
    [InlineData(
        "The baseline was requested for 'https://host/api/sk-live-abc123/run' but a run recorded something else.",
        "https://host/<redacted>"
    )]
    [InlineData("A run recorded a request to 'http://localhost:8080/tenants/tok/evaluate'.", "http://localhost:8080/")]
    public void RedactAddresses_WhenAMessageQuotesAnAddress_LeavesOnlyTheRedactedForm(string message, string expected)
    {
        var redacted = EndpointGuard.RedactAddresses(message);

        redacted.Should().NotContain("sk-live-abc123");
        redacted.Should().NotContain("/run");
        redacted.Should().NotContain("/evaluate");
        redacted.Should().Contain(expected);
    }

    [Fact]
    public void RedactAddresses_WhenAMessageNamesNoAddress_LeavesItAlone()
    {
        const string message = "The artifact describes a different system from the one asked for.";

        EndpointGuard.RedactAddresses(message).Should().Be(message);
    }

    [Fact]
    public async Task ExecuteAsync_WhenABaselineAddressCarriesATokenAndIsRefused_DoesNotQuoteItOnStandardError()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var candidate = ComparisonWorkspace.Endpoint();
        using var console = new RecordingConsole();

        // Nothing is listening on the baseline address, so the comparison is refused — and the
        // refusal is the message most likely to quote the address back.
        var plan = RunPlan.Create(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = workspace.Root,
                Endpoint = candidate.Address.ToString(),
                BaselineEndpoint = $"http://localhost:1/{PathToken}/evaluate",
                RestExchange = "json",
            }
        );

        var act = async () => await RunCommand.ExecuteAsync(plan, console, CancellationToken.None);
        var refusal = await act.Should().ThrowAsync<EvalCliException>();

        refusal.Which.Message.Should().NotContain(PathToken);
        refusal.Which.Remedy.Should().NotContain(PathToken);

        ExitCodeReporter.Report(refusal.Which, console);

        console.StandardError.Should().NotContain(PathToken);
    }

    [Fact]
    public async Task CompareAsync_WhenTheBaselineRunsDialledATokenBearingAddress_RefusesWithoutQuotingTheToken()
    {
        using var workspace = new TempWorkspace();

        ComparisonWorkspace.WriteSuite(workspace);

        await using var candidate = ComparisonWorkspace.Endpoint();
        await using var baseline = ComparisonWorkspace.Endpoint();

        // Where the misdirected adapter really dials. The token is in the path, which is the
        // component the engine's mismatch message quotes back in full.
        await using var elsewhere = TokenBearingEndpoint();

        var plan = RunPlan.Create(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = workspace.Root,
                Endpoint = candidate.Address.ToString(),
                BaselineEndpoint = baseline.Address.ToString(),
                RestExchange = "json",
            }
        );

        using var diagnostics = new StringWriter();
        using var provider = EvalCliServices.Build(plan, diagnostics);
        using var console = new RecordingConsole();

        var suite = await SuiteDiscovery.LoadSuiteAsync(
            provider.GetRequiredService<SuiteLoader>(),
            plan,
            console,
            CancellationToken.None
        );

        provider
            .GetRequiredService<SeedSchedule>()
            .PinTo(suite, [.. suite.Scenarios.Select(scenario => scenario.Identity.Id)]);

        var conducted = await provider.GetRequiredService<RunCoordinator>().RunAsync(suite, CancellationToken.None);

        // The seam. BaselineEndpointCoordinators builds the baseline harness's runners around an
        // IRestExchange it resolves from the provider it was handed, and an adapter is free to
        // name an absolute address of its own — so the baseline artifact comes back describing a
        // system the engine can prove is not the one asked for.
        using var misdirected = new MisdirectedHarness(
            provider,
            plan,
            new ElsewhereExchange(provider.GetRequiredService<IRestExchange>(), elsewhere.Address)
        );

        var act = async () =>
            await BaselineComparison.CompareAsync(
                misdirected,
                plan,
                suite,
                [],
                conducted,
                null,
                CancellationToken.None
            );

        var refusal = (await act.Should().ThrowAsync<EvalCliException>()).Which;

        refusal.ExitCode.Should().Be(ExitCode.ComparisonRefused);
        refusal.ExitCode.Should().NotBe(ExitCode.Success);

        elsewhere
            .Requests.Should()
            .BeGreaterThan(0, "the refusal is only the real one if the runs actually went there");

        var port = elsewhere.Address.Port.ToString(CultureInfo.InvariantCulture);

        // The engine is right to name the address it could not confirm — a caller has to know
        // which one — but it names it whole, and this message goes to standard error.
        refusal.Message.Should().Contain($"http://localhost:{port}/<redacted>");
        refusal.Message.Should().NotContain(PathToken);
        refusal.Remedy.Should().NotContain(PathToken);

        using var reported = new RecordingConsole();

        ExitCodeReporter.Report(refusal, reported).Should().Be(ExitCode.ComparisonRefused);

        reported.StandardError.Should().NotContain(PathToken);
        reported.StandardError.Should().Contain($"http://localhost:{port}/<redacted>");
        diagnostics.ToString().Should().NotContain(PathToken);
    }

    /// <summary>An adapter that dials an absolute address of its own rather than the client's.</summary>
    /// <remarks>
    /// The only thing changed is the destination: the body and the reading of the reply are the
    /// real adapter's, so the baseline artifact that comes back is well formed and differs from
    /// an honest one only in where its runs went.
    /// </remarks>
    private sealed class ElsewhereExchange(IRestExchange inner, Uri destination) : IRestExchange
    {
        public HttpRequestMessage CreateRequest(RestStimulus stimulus)
        {
            var request = inner.CreateRequest(stimulus);

            request.RequestUri = destination;

            return request;
        }

        public RestResponse Read(RestReply reply) => inner.Read(reply);
    }

    /// <summary>The composition root with the REST adapter substituted, baseline harness included.</summary>
    /// <remarks>
    /// <see cref="BaselineEndpointCoordinators"/> is rebuilt over this rather than taken from the
    /// container, because the registered instance holds the container's own provider and would
    /// resolve the real adapter however this one answered.
    /// </remarks>
    private sealed class MisdirectedHarness : IServiceProvider, IDisposable
    {
        private readonly IServiceProvider _inner;
        private readonly IRestExchange _exchange;
        private readonly Lazy<BaselineEndpointCoordinators> _coordinators;

        public MisdirectedHarness(IServiceProvider inner, RunPlan plan, IRestExchange exchange)
        {
            _inner = inner;
            _exchange = exchange;
            _coordinators = new Lazy<BaselineEndpointCoordinators>(() => new BaselineEndpointCoordinators(this, plan));
        }

        public object? GetService(Type serviceType)
        {
            ArgumentNullException.ThrowIfNull(serviceType);

            if (serviceType == typeof(IRestExchange))
            {
                return _exchange;
            }

            return serviceType == typeof(BaselineEndpointCoordinators)
                ? _coordinators.Value
                : _inner.GetService(serviceType);
        }

        public void Dispose()
        {
            if (_coordinators.IsValueCreated)
            {
                _coordinators.Value.Dispose();
            }
        }
    }
}
