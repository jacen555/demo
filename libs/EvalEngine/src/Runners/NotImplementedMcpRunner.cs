using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Runners;

/// <summary>
/// Handles <see cref="ScenarioKind.Mcp"/> scenarios by reporting, cleanly, that this build cannot
/// speak that transport.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why this exists rather than nothing.</b> A suite is mixed. Without a runner registered for
/// <see cref="ScenarioKind.Mcp"/>, either the loader must reject a suite that contains one — which
/// makes a declared gap look like a broken suite — or the router must special-case a missing kind,
/// which is exactly the kind-awareness the engine is built to keep out. A stub keeps routing
/// uniform: every kind has a runner, every runner returns a transcript, and nothing in the loop
/// knows one of them is a stub.
/// </para>
/// <para>
/// <b>Why it does not throw.</b> One unsupported scenario must not take down a run that also
/// contains supported ones. Throwing would make the blast radius of a declared gap depend on where
/// in the suite it happened to sit.
/// </para>
/// <para>
/// <b>Why it is not a new <see cref="Results.RunStatus"/>.</b> This was a real decision, so it is
/// recorded here rather than left to be rediscovered:
/// </para>
/// <list type="number">
/// <item><description>
/// <see cref="Results.RunStatus"/> is a <i>grading verdict</i> — how a run came out. "This build
/// cannot speak MCP" is a <i>capability</i> fact. Putting it in the verdict enum would oblige
/// aggregation, comparison, reporting, and the statistics each to grow a branch, which is the rule
/// in <see cref="IScenarioRunner"/> — adding a kind must not require a change anywhere else —
/// violated for a gap instead of for a kind.
/// </description></item>
/// <item><description>
/// It would change an enum serialized into the committed artifact, so every existing reader would
/// meet a member it does not know. That is a schema decision, and not a runner's to make.
/// </description></item>
/// <item><description>
/// <see cref="Results.RunStatus.Error"/> — "transport, configuration, or harness failure" — already
/// fits. A transport the harness cannot speak <i>is</i> a harness failure. What makes it feel
/// different is that it is known rather than surprising, and "known" is carried by
/// <see cref="Results.RunResult.ErrorDetail"/>, which exists for exactly that. The status answers
/// "can a verdict from this run be trusted?" — no, either way — and the detail answers "why not".
/// </description></item>
/// <item><description>
/// A distinct status would be a false-green vector. Any consumer treating "not Fail" as "no
/// regression" would report a suite of entirely unsupported scenarios as clean.
/// <see cref="ExchangeState.IsHarnessFailure(string?)"/> classifies
/// <see cref="ExchangeState.Unsupported"/> with the other states that gathered no evidence, so it
/// cannot.
/// </description></item>
/// </list>
/// <para>
/// So the signal lives where a runner's signals belong — in the transcript's transport metadata,
/// as <see cref="ExchangeState.Unsupported"/> with a
/// <see cref="TransportAttributes.Failure"/> reason — and a suite can assert on it today with
/// <c>expectedBehavior:transport/exchange=unsupported</c>. Real MCP transport is out of scope;
/// when it lands, this type is deleted and nothing else changes.
/// </para>
/// </remarks>
public sealed class NotImplementedMcpRunner : IScenarioRunner
{
    private readonly IClock _clock;

    /// <summary>Initializes a new instance of the <see cref="NotImplementedMcpRunner"/> class.</summary>
    /// <param name="clock">
    /// The clock the transcript is stamped from. A run that did nothing is still a run, and it is
    /// timestamped the same way as any other so nothing downstream has to special-case it.
    /// </param>
    /// <exception cref="ArgumentNullException"><paramref name="clock"/> is null.</exception>
    public NotImplementedMcpRunner(IClock clock)
    {
        ArgumentNullException.ThrowIfNull(clock);

        _clock = clock;
    }

    /// <inheritdoc/>
    public ScenarioKind Kind => ScenarioKind.Mcp;

    /// <summary>Reports that this build cannot run the scenario, without throwing.</summary>
    /// <param name="scenario">The scenario. Must declare <see cref="ScenarioKind.Mcp"/>.</param>
    /// <param name="context">The participant and seed for this run. The participant is not consulted.</param>
    /// <param name="cancellationToken">Cancels the run.</param>
    /// <returns>
    /// A transcript with no turns, nothing observed, and
    /// <see cref="ExchangeState.Unsupported"/> recorded as its exchange state.
    /// </returns>
    /// <exception cref="ArgumentNullException">
    /// <paramref name="scenario"/> or <paramref name="context"/> is null.
    /// </exception>
    /// <exception cref="ArgumentException"><paramref name="scenario"/> declares another kind.</exception>
    /// <exception cref="OperationCanceledException"><paramref name="cancellationToken"/> was cancelled.</exception>
    public Task<Transcript> RunAsync(Scenario scenario, RunContext context, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(scenario);
        ArgumentNullException.ThrowIfNull(context);
        cancellationToken.ThrowIfCancellationRequested();
        RunnerSupport.RequireKind(scenario, Kind, "mcp");

        var now = _clock.UtcNow;

        return Task.FromResult(
            new Transcript
            {
                ScenarioId = scenario.Identity.Id,
                Seed = context.Seed,
                StartedAt = now,
                Duration = TimeSpan.Zero,
                Turns = [],

                // Nothing was observed, so nothing may look as though it was. An empty outcome
                // beside a green assertion is the false green this whole chain of guards exists
                // to prevent.
                Outcome = new Outcome(),
                Transport = new TransportMetadata
                {
                    Kind = "mcp",

                    // No address was contacted, so none is claimed.
                    Endpoint = null,
                    Attributes = RunnerSupport.Attributes(
                        fromAdapter: new Dictionary<string, string>(StringComparer.Ordinal),
                        observed: new Dictionary<string, string>(StringComparer.Ordinal),
                        exchange: ExchangeState.Unsupported,
                        stoppedBy: StopReason.Unsupported,
                        failure: $"Scenario '{scenario.Identity.Id}' declares the mcp transport, which this build "
                            + "does not implement. No exchange was attempted, so this run carries no evidence "
                            + "about the system under test and must not be graded as though it did. This is a "
                            + "declared gap rather than a fault: the scenario is reported rather than refused so "
                            + "that the rest of a mixed suite still runs."
                    ),
                },
            }
        );
    }
}
