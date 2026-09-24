using Forge.EvalEngine.Results;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalCli.Cli;

/// <summary>
/// Reduces every address an artifact carries to the only form this tool may record.
/// </summary>
/// <remarks>
/// <para>
/// <b>A report and an artifact are different objects, and only one of them was covered.</b> Every
/// rendered report names <see cref="RunPlan.EndpointDisplay"/>, which was redacted at argument
/// time. A transcript is not built from that: the engine records where a run actually went, from
/// the client's base address, because that record is the evidence a baseline was conducted against
/// the system it claims. It keeps the path — and a path segment carries a bearer token as readily
/// as a query parameter does, with nothing able to tell a routing segment from a key by looking.
/// </para>
/// <para>
/// <b>Applied at the write, not at the run.</b> The unredacted address has to survive in memory:
/// <c>LiveEndpointBaseline</c> verifies the artifact it gets back against the address it asked
/// for, transcript by transcript, and that check is what catches a baseline conducted against the
/// wrong system. Redacting earlier would defeat it. What must not happen is the address reaching
/// disk, so the rule is applied to the bytes on their way out — the one place both destinations,
/// <c>run --out</c> and <c>baseline update --apply</c>, pass through.
/// </para>
/// <para>
/// <b>Nothing downstream reads what this removes.</b> <c>SuiteComparator</c> pairs on the suite
/// name, the root seed, the harness settings, the scenario ids, the definition fingerprints, and
/// the per-repetition seeds. No endpoint is among them, so a redacted artifact compares exactly as
/// the artifact it was made from would have.
/// </para>
/// </remarks>
internal static class ArtifactRedaction
{
    /// <summary>Returns the artifact as it may be written down.</summary>
    /// <param name="result">The artifact the run produced.</param>
    /// <returns>The same artifact with every recorded address reduced to scheme, host, and port.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="result"/> is null.</exception>
    public static SuiteResult Redact(SuiteResult result)
    {
        ArgumentNullException.ThrowIfNull(result);

        return result with
        {
            Environment = result.Environment with { Endpoint = Address(result.Environment.Endpoint) },
            ScenarioResults =
            [
                .. result.ScenarioResults.Select(scenario =>
                    scenario with
                    {
                        Runs = [.. scenario.Runs.Select(Redact)],
                    }
                ),
            ],
        };
    }

    private static RunResult Redact(RunResult run) =>
        run with
        {
            Transcript = run.Transcript with
            {
                Transport = run.Transcript.Transport with { Endpoint = Address(run.Transcript.Transport.Endpoint) },
            },
        };

    /// <summary>
    /// One recorded address, reduced to what identifies the environment and nothing more.
    /// </summary>
    /// <remarks>
    /// Through <see cref="EndpointGuard.Redact(Uri)"/>, which is the same routine the printable
    /// form of <c>--endpoint</c> comes from, rather than a second reading of the same rule. A
    /// value that does not parse as an address is not a value this can take apart component by
    /// component, so it is replaced wholesale — the conservative direction, because an opaque
    /// label is a convenience and a committed credential is not recoverable (§V).
    /// </remarks>
    private static string? Address(string? recorded)
    {
        if (string.IsNullOrWhiteSpace(recorded))
        {
            return recorded;
        }

        return Uri.TryCreate(recorded.Trim(), UriKind.Absolute, out var uri) && !string.IsNullOrEmpty(uri.Authority)
            ? EndpointGuard.Redact(uri)
            : EndpointGuard.RedactionMarker;
    }
}
