using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Coordination;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;

namespace Forge.EvalEngine.Baselines;

/// <summary>
/// Resolves a baseline by running the suite against a baseline endpoint.
/// </summary>
/// <remarks>
/// <para>
/// This is the provider for a deployed system, where the baseline is not a file but the version
/// already running. It yields the same <see cref="SuiteResult"/> a committed artifact would, so
/// one <see cref="Comparison.SuiteComparator"/> serves both.
/// </para>
/// <para>
/// <b>The endpoint is supplied per call, so the coordinator has to be too.</b> A
/// <see cref="RunCoordinator"/> is built around runners already bound to a transport and an
/// address, and re-pointing one is not possible — which is correct, because which runners a
/// baseline endpoint deserves is a composition-root decision. The factory is therefore handed the
/// validated <see cref="Uri"/> and returns a coordinator wired for it.
/// </para>
/// <para>
/// <b>The reference is untrusted input</b> (§V). Only absolute <c>http</c> and <c>https</c>
/// references are dialled: a reference naming another scheme would have this type issue a request
/// on its author's behalf to something that is not an evaluation endpoint. A reference carrying
/// userinfo is refused outright rather than stripped, because a credential in a reference ends up
/// wherever the reference is recorded.
/// </para>
/// <para>
/// <b>Redaction and verification pull against each other, and verification decides what may be
/// referenced.</b> A query and a fragment are stripped from every recorded address, because that
/// is where a bearer token, a SAS signature, or an OAuth access token lives — which means two
/// references differing only there are the same text in the artifact. Rather than let this type
/// pair two different deployments with confidence, a reference carrying either is refused, and
/// what the runs actually recorded is checked against what was asked for.
/// </para>
/// <para>
/// <b>Never returns null.</b> Running a suite always produces an artifact, so there is no "there
/// is no baseline" outcome to report — and a null here would read downstream as "nothing to
/// compare", which is a false green. Every failure throws instead.
/// </para>
/// </remarks>
public sealed class LiveEndpointBaseline : IBaselineProvider
{
    /// <summary>What a runner's sanitized address carries in place of a dropped component.</summary>
    private static readonly string[] RedactionMarkers = ["?[redacted]", "#[redacted]"];

    private readonly Suite _suite;
    private readonly Func<Uri, RunCoordinator> _coordinatorFactory;

    /// <summary>Initializes a new instance of the <see cref="LiveEndpointBaseline"/> class.</summary>
    /// <param name="suite">The suite to run against the baseline endpoint.</param>
    /// <param name="coordinatorFactory">
    /// Supplies a coordinator wired for the endpoint it is handed. The coordinator's
    /// <see cref="RunCoordinatorOptions.Endpoint"/> must name that same endpoint: the artifact it
    /// stamps is the only record of what was actually evaluated, and it is checked rather than
    /// trusted.
    /// </param>
    /// <exception cref="ArgumentNullException">Either argument is null.</exception>
    public LiveEndpointBaseline(Suite suite, Func<Uri, RunCoordinator> coordinatorFactory)
    {
        ArgumentNullException.ThrowIfNull(suite);
        ArgumentNullException.ThrowIfNull(coordinatorFactory);

        _suite = suite;
        _coordinatorFactory = coordinatorFactory;
    }

    /// <inheritdoc/>
    /// <remarks>
    /// <paramref name="reference"/> is the absolute <c>http</c> or <c>https</c> address of the
    /// baseline system.
    /// </remarks>
    /// <exception cref="ArgumentException">
    /// <paramref name="reference"/> is empty, is not an absolute URI, names a scheme other than
    /// <c>http</c> or <c>https</c>, carries userinfo, or carries a query or fragment — the parts
    /// of an address that are redacted before recording and therefore cannot be verified.
    /// </exception>
    /// <exception cref="ArgumentNullException"><paramref name="reference"/> is null.</exception>
    /// <exception cref="InvalidOperationException">
    /// The factory returned null, returned a coordinator that recorded a different endpoint from
    /// the one requested, or returned one whose runs recorded a request to somewhere else — in
    /// any of which cases the artifact describes a system other than the one this baseline was
    /// asked for.
    /// </exception>
    /// <exception cref="OperationCanceledException"><paramref name="cancellationToken"/> was cancelled.</exception>
    public async Task<SuiteResult?> TryGetBaselineAsync(string reference, CancellationToken cancellationToken)
    {
        var endpoint = Validate(reference);

        cancellationToken.ThrowIfCancellationRequested();

        var coordinator =
            _coordinatorFactory(endpoint)
            ?? throw new InvalidOperationException(
                "The coordinator factory returned null, so the suite was never run against the baseline endpoint. "
                    + "Reporting no baseline here would have the caller conclude there was nothing to compare."
            );

        var result = await coordinator.RunAsync(_suite, cancellationToken).ConfigureAwait(false);

        // The artifact is the only record of what was actually evaluated. A coordinator wired to
        // a different address produces a perfectly well-formed baseline for the wrong system,
        // and comparing against it attributes that system's behaviour to this one — checked
        // rather than assumed.
        var expected = Runners.RunnerSupport.SanitizeEndpoint(endpoint);

        if (!string.Equals(result.Environment.Endpoint, expected, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                $"The baseline was requested for '{expected}' but the coordinator recorded "
                    + $"'{result.Environment.Endpoint ?? "(none)"}'. The artifact describes a different system from "
                    + "the one asked for, so it is refused rather than compared against."
            );
        }

        RequireRunsDialledTheEndpoint(result, endpoint);

        return result;
    }

    /// <summary>
    /// Refuses an artifact whose runs did not reach the endpoint the baseline was asked for.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <see cref="EvaluationEnvironment.Endpoint"/> is copied from
    /// <see cref="RunCoordinatorOptions.Endpoint"/>: it is a label the composition root supplied,
    /// not evidence of where a request went. The runners are injected, and a factory can return a
    /// coordinator labelled correctly whose runners are bound somewhere else entirely. What the
    /// runs themselves recorded is the closest thing to evidence available, so it is checked (§V).
    /// </para>
    /// <para>
    /// <b>What this does and does not establish.</b> A recorded address is compared on scheme,
    /// host, port, and path — everything that survives redaction. A run that recorded
    /// <see langword="null"/> is skipped: <see cref="Runners.IConversationExchange.Endpoint"/>
    /// documents that as "no address to report", and refusing every artifact that omits one would
    /// refuse honest runners rather than miswired ones. A run that recorded something which is
    /// <i>not</i> an address is refused rather than skipped — it is a positive claim about a
    /// destination that cannot be reconciled with the one asked for, and admitting an
    /// unverifiable claim is the false green this check exists to prevent. The consequence is
    /// deliberate: an adapter that names a model deployment rather than an address cannot sit
    /// behind a baseline requested by URL.
    /// </para>
    /// <para>
    /// So this catches a runner that <i>says</i> where it went and went elsewhere; it cannot
    /// catch one that says nothing, which is why the endpoint check above is kept rather than
    /// replaced.
    /// </para>
    /// </remarks>
    private static void RequireRunsDialledTheEndpoint(SuiteResult result, Uri endpoint)
    {
        var expected = endpoint.GetLeftPart(UriPartial.Path);

        foreach (var scenario in result.ScenarioResults)
        {
            foreach (var run in scenario.Runs)
            {
                var recorded = run.Transcript.Transport.Endpoint;

                if (string.IsNullOrEmpty(recorded))
                {
                    // A runner is not required to report where it went, and refusing every
                    // artifact that omits it would refuse honest runners rather than miswired
                    // ones. The run makes no claim this check could contradict.
                    continue;
                }

                if (Dialled(recorded) is not { } address)
                {
                    throw new InvalidOperationException(
                        $"A run of scenario '{scenario.ScenarioId}' recorded a destination that is not an address, "
                            + "so it cannot be confirmed to have reached the endpoint this baseline was asked for. "
                            + "It is refused rather than attributed to that endpoint."
                    );
                }

                if (!string.Equals(address, expected, StringComparison.Ordinal))
                {
                    throw new InvalidOperationException(
                        $"The baseline was requested for '{expected}' but a run of scenario "
                            + $"'{scenario.ScenarioId}' recorded a request to '{address}'. The coordinator's "
                            + "options are a label and the transcripts are the evidence, so an artifact whose runs "
                            + "went elsewhere is refused rather than compared against."
                    );
                }
            }
        }
    }

    /// <summary>
    /// The address a recorded destination names, up to and including its path, or null when it
    /// does not name one.
    /// </summary>
    /// <remarks>
    /// The value has already been through
    /// <see cref="Runners.RunnerSupport.SanitizeEndpoint(string?)"/>, so any query or fragment it
    /// carried is a marker rather than the original text. Both markers are dropped before the
    /// address is read: what remains is exactly the part of an endpoint's identity that survives
    /// into a committed artifact, and therefore the only part that can honestly be compared.
    /// </remarks>
    private static string? Dialled(string recorded)
    {
        var address = recorded;

        foreach (var marker in RedactionMarkers)
        {
            var at = address.IndexOf(marker, StringComparison.Ordinal);

            if (at >= 0)
            {
                address = address[..at];
            }
        }

        return Uri.TryCreate(address, UriKind.Absolute, out var uri) && !string.IsNullOrEmpty(uri.Authority)
            ? uri.GetLeftPart(UriPartial.Path)
            : null;
    }

    /// <summary>Refuses a reference this type must not dial.</summary>
    /// <remarks>
    /// Applied before the factory is called, so a reference that is refused never reaches
    /// anything that could dial it, record it, or log it.
    /// </remarks>
    private static Uri Validate(string reference)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentException.ThrowIfNullOrWhiteSpace(reference);

        if (!Uri.TryCreate(reference, UriKind.Absolute, out var endpoint))
        {
            throw new ArgumentException(
                "A live baseline reference must be an absolute URI naming the baseline system.",
                nameof(reference)
            );
        }

        if (
            !string.Equals(endpoint.Scheme, Uri.UriSchemeHttp, StringComparison.Ordinal)
            && !string.Equals(endpoint.Scheme, Uri.UriSchemeHttps, StringComparison.Ordinal)
        )
        {
            // Resolving a reference means issuing a request to whatever it names. Write access
            // to a baseline reference is not authority to make this library read a local file or
            // reach an arbitrary protocol on its author's behalf (§V).
            throw new ArgumentException(
                $"A live baseline reference must use http or https; this one uses '{endpoint.Scheme}'. Resolving it "
                    + "means issuing a request to whatever it names, which is not something an arbitrary scheme may "
                    + "direct.",
                nameof(reference)
            );
        }

        if (!string.IsNullOrEmpty(endpoint.UserInfo))
        {
            // Refused rather than stripped, and the message must not echo it back. A credential
            // in a reference ends up wherever the reference is recorded (§V).
            throw new ArgumentException(
                "A live baseline reference must not carry userinfo. A credential in a reference is recorded "
                    + "wherever the reference is, so it is refused rather than quietly removed — send it as a "
                    + "header from the composition root instead.",
                nameof(reference)
            );
        }

        if (!string.IsNullOrEmpty(endpoint.Query) || !string.IsNullOrEmpty(endpoint.Fragment))
        {
            // Redaction and verification pull against each other here, and the resolution is
            // deliberate. A query is where a bearer token or a SAS signature lives and a
            // fragment carries an OAuth access token by design, so neither may reach a committed
            // artifact — both are recorded as a fixed marker. That makes '?deployment=old' and
            // '?deployment=new' the same recorded text, and an identity check over that text
            // would confidently pair two different deployments. The part of an endpoint that
            // cannot be verified is therefore not admitted at all: a deployment is selected by
            // path, or by a header the composition root sets, neither of which is redacted (§V).
            throw new ArgumentException(
                "A live baseline reference must not carry a query or a fragment. Both are stripped before the "
                    + "endpoint is recorded, because that is where a credential usually lives — so two references "
                    + "differing only there are indistinguishable in the artifact, and this type would be unable "
                    + "to tell whether the baseline it compared against was the one asked for. Select the "
                    + "deployment by path, or from the composition root.",
                nameof(reference)
            );
        }

        return endpoint;
    }
}
