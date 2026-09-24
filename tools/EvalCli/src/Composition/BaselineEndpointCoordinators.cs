using Forge.EvalCli.Cli;
using Forge.EvalCli.Exchanges;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Coordination;
using Forge.EvalEngine.Runners;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Forge.EvalCli.Composition;

/// <summary>
/// Supplies a coordinator wired for the baseline address, for the engine's live baseline provider.
/// </summary>
/// <remarks>
/// <para>
/// A <see cref="RunCoordinator"/> is built around runners already bound to a transport and an
/// address, and re-pointing one is not possible — so a baseline run against a second address
/// needs a second set of runners and a second client. Which runners a baseline deserves is a
/// composition-root decision, which is why the engine asks for a factory rather than making one.
/// </para>
/// <para>
/// <b>Everything except the address is held identical to the candidate's wiring, deliberately.</b>
/// The comparator refuses two artifacts that disagree on any harness setting, so the concurrency
/// ceiling, the run budget, the clock, the evaluators, the participants, and the seed source all
/// come from the same registrations the candidate uses. The seed source is resolved per call
/// because it is not thread-safe and the engine wants one per suite run — and because the two
/// runs being driven from the same root seed is what makes the comparison paired at all.
/// </para>
/// <para>
/// <b>The address handed to the coordinator is the real one, not the redacted one.</b> The
/// engine's live provider verifies the artifact it gets back against the address it asked for,
/// and that check is what catches a baseline conducted against the wrong system — the precise
/// failure a comparison cannot recover from. Handing it a redacted label to satisfy this tool's
/// printing rule would defeat the check. Nothing here is printed or written: the baseline artifact
/// is held in memory for the length of one comparison, and every report names
/// <see cref="RunPlan.BaselineEndpointDisplay"/> instead.
/// </para>
/// <para>
/// <b>Redirects are neither followed nor graded.</b> The engine's live provider verifies a
/// baseline artifact against the address it <i>asked for</i>, and a runner records the address
/// it dialled — so a client that quietly followed a 307 from the baseline address to the
/// candidate's would produce an artifact that passes every one of those checks while
/// describing the system under review. The comparison would then be the candidate against
/// itself, and it would be green. See <see cref="RedirectRefusingHandler"/>.
/// </para>
/// </remarks>
internal sealed class BaselineEndpointCoordinators : IDisposable
{
    private readonly IServiceProvider _provider;
    private readonly RunPlan _plan;
    private readonly HttpClient _client;
    private readonly Uri _endpoint;

    /// <summary>Initializes a new instance of the <see cref="BaselineEndpointCoordinators"/> class.</summary>
    /// <param name="provider">The composition root, for the seams shared with the candidate run.</param>
    /// <param name="plan">The validated plan, which carries the baseline address.</param>
    /// <exception cref="ArgumentNullException">Any argument is null.</exception>
    /// <exception cref="InvalidOperationException">The plan names no baseline address.</exception>
    public BaselineEndpointCoordinators(IServiceProvider provider, RunPlan plan)
    {
        ArgumentNullException.ThrowIfNull(provider);
        ArgumentNullException.ThrowIfNull(plan);

        _provider = provider;
        _plan = plan;
        _endpoint =
            plan.BaselineEndpoint
            ?? throw new InvalidOperationException(
                "A baseline coordinator source was built for a plan that names no baseline address."
            );

        _client = new HttpClient(RedirectRefusingHandler.Create(), disposeHandler: true) { BaseAddress = _endpoint };
    }

    /// <summary>Builds a coordinator wired for the baseline address.</summary>
    /// <param name="endpoint">The address the engine's provider validated and is asking about.</param>
    /// <returns>The coordinator.</returns>
    /// <remarks>
    /// The requested address is checked against the one this was built for rather than assumed.
    /// The engine verifies the artifact against what it asked for and would refuse a mismatch
    /// afterwards; refusing here means a suite is not conducted against the wrong system first.
    /// </remarks>
    /// <exception cref="ArgumentNullException"><paramref name="endpoint"/> is null.</exception>
    /// <exception cref="InvalidOperationException">A different address was asked for.</exception>
    public RunCoordinator ForEndpoint(Uri endpoint)
    {
        ArgumentNullException.ThrowIfNull(endpoint);

        if (endpoint != _endpoint)
        {
            throw new InvalidOperationException(
                "A baseline was asked for at an address this harness was not wired for, so no suite was conducted "
                    + "against it. The coordinator is built around runners already bound to one address, and "
                    + "answering with them anyway would produce a well-formed artifact describing the wrong system."
            );
        }

        return new RunCoordinator(
            Runners(),
            _provider.GetRequiredService<AssertionEvaluatorRegistry>(),
            _provider.GetRequiredService<IParticipantFactory>(),
            _provider.GetRequiredService<IClock>(),
            _provider.GetRequiredService<ISeedSource>(),
            Options(),
            _provider.GetRequiredService<ILogger<RunCoordinator>>()
        );
    }

    public void Dispose() => _client.Dispose();

    /// <summary>The coordinator options for the baseline run.</summary>
    /// <remarks>
    /// Identical to the candidate's but for the address, because every entry of
    /// <c>HarnessConfig</c> is derived from these and the comparator refuses two artifacts that
    /// disagree on any of them.
    /// </remarks>
    private RunCoordinatorOptions Options() =>
        new()
        {
            MaxConcurrency = _plan.MaxConcurrency,
            MaxTotalRuns = _plan.MaxTotalRuns,
            Endpoint = _endpoint.ToString(),
        };

    /// <summary>
    /// The runners for the baseline address — the same adapters the candidate was given.
    /// </summary>
    /// <remarks>
    /// Built here rather than resolved from the container, because the registered ones are bound
    /// to the candidate's client. The stubs for the kinds nothing conducts are included so a
    /// mixed suite routes on both sides and the gap is recorded identically in both artifacts;
    /// leaving them out would make the two runs differ in a way the comparator would report as a
    /// change in the system under test.
    /// </remarks>
    private IEnumerable<IScenarioRunner> Runners()
    {
        var clock = _provider.GetRequiredService<IClock>();

        if (_plan.RestExchange is ExchangeAdapter.Json)
        {
            yield return new RestRunner(_client, _provider.GetRequiredService<IRestExchange>(), clock);
        }

        if (_plan.LlmExchange is ExchangeAdapter.Json)
        {
            // The address this adapter reports is the one the engine's live provider checks the
            // transcripts against, so it is the dialled address up to its path — the components
            // that survive redaction and can therefore be verified. A query and a fragment cannot
            // appear here: a baseline address carrying either is refused before anything is built.
            yield return new LlmConversationRunner(
                new JsonConversationExchange(_client, _endpoint.GetLeftPart(UriPartial.Path)),
                clock
            );
        }

        yield return new NotImplementedMcpRunner(clock);
        yield return new NotImplementedUiRunner(clock);
    }
}
