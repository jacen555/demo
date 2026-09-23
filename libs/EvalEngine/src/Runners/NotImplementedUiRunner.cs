using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Runners;

/// <summary>
/// Handles <see cref="ScenarioKind.Ui"/> scenarios by reporting, cleanly, that this build cannot
/// drive a user interface.
/// </summary>
/// <remarks>
/// <para>
/// The twin of <see cref="NotImplementedMcpRunner"/>, and deliberately identical to it in every
/// respect that matters: it registers for a kind so routing stays uniform, it returns a transcript
/// rather than throwing so one declared gap cannot take down a mixed suite, it never consults the
/// participant, and it records <see cref="ExchangeState.Unsupported"/> so
/// <see cref="ExchangeState.IsHarnessFailure(string?)"/> classifies it with the other states that
/// gathered no evidence. A suite of entirely unsupported scenarios therefore cannot report as
/// clean. The full reasoning — including why this is not a new
/// <see cref="Results.RunStatus"/> member — is recorded once on
/// <see cref="NotImplementedMcpRunner"/> and is not repeated here.
/// </para>
/// <para>
/// <b>What a real UI runner would be, and why none of it is here.</b> Driving a real web UI with
/// scripted browser interaction and capturing the result deterministically is achievable — that
/// was established separately, and it needs three determinism controls applied together, none of
/// which belongs in this library until a runner actually needs them. Building any of it now would
/// be speculation dressed as a seam. What this type buys today is the routing slot and the
/// vocabulary: a mixed suite containing a <c>ui</c> scenario runs, reports the gap in the same
/// terms it reports an MCP gap, and the eventual runner replaces this type without anything
/// downstream changing.
/// </para>
/// <para>
/// <b>What a suite actually gets back.</b> The transcript records
/// <c>transport/exchange=unsupported</c>, and an evaluator reads that attribute like any other —
/// but a suite cannot obtain a passing assertion for it through
/// <see cref="Coordination.RunCoordinator"/>. The coordinator classifies the run as a harness
/// failure and does not evaluate its assertions at all, so the gap is reported as a
/// <see cref="Results.RunStatus.Error"/> carrying a stated reason rather than as an assertion
/// verdict. That is the intended behaviour, not a limitation: grading a run that gathered no
/// evidence is precisely the false green this chain of guards exists to prevent. When a real UI
/// runner lands, this type is deleted and nothing else changes.
/// </para>
/// </remarks>
public sealed class NotImplementedUiRunner : IScenarioRunner
{
    private readonly IClock _clock;

    /// <summary>Initializes a new instance of the <see cref="NotImplementedUiRunner"/> class.</summary>
    /// <param name="clock">
    /// The clock the transcript is stamped from. A run that did nothing is still a run, and it is
    /// timestamped the same way as any other so nothing downstream has to special-case it.
    /// </param>
    /// <exception cref="ArgumentNullException"><paramref name="clock"/> is null.</exception>
    public NotImplementedUiRunner(IClock clock)
    {
        ArgumentNullException.ThrowIfNull(clock);

        _clock = clock;
    }

    /// <inheritdoc/>
    public ScenarioKind Kind => ScenarioKind.Ui;

    /// <summary>Reports that this build cannot run the scenario, without throwing.</summary>
    /// <param name="scenario">The scenario. Must declare <see cref="ScenarioKind.Ui"/>.</param>
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
        RunnerSupport.RequireKind(scenario, Kind, "ui");

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
                    Kind = "ui",

                    // No interface was opened and no address was contacted, so none is claimed.
                    Endpoint = null,
                    Attributes = RunnerSupport.Attributes(
                        fromAdapter: new Dictionary<string, string>(StringComparer.Ordinal),
                        observed: new Dictionary<string, string>(StringComparer.Ordinal),
                        exchange: ExchangeState.Unsupported,
                        stoppedBy: StopReason.Unsupported,
                        failure: $"Scenario '{scenario.Identity.Id}' declares the ui transport, which this build "
                            + "does not implement. No interaction was attempted, so this run carries no evidence "
                            + "about the system under test and must not be graded as though it did. This is a "
                            + "declared gap rather than a fault: the scenario is reported rather than refused so "
                            + "that the rest of a mixed suite still runs."
                    ),
                },
            }
        );
    }
}
