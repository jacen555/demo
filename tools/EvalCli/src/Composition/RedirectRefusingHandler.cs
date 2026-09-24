using System.Globalization;

namespace Forge.EvalCli.Composition;

/// <summary>
/// A redirect, refused rather than followed or graded.
/// </summary>
/// <remarks>
/// <b>An <see cref="HttpRequestException"/> deliberately.</b> That is the shape the engine's
/// runners already classify as <c>ExchangeState.RequestFailed</c> — "the request never reached
/// the system under test" — which is exactly what happened: something in front of the system
/// answered with an instruction to ask elsewhere, and nothing asked the system anything. A
/// harness failure produces no verdict, exits non-zero, and is refused as a baseline, which are
/// all the right consequences.
/// </remarks>
internal sealed class RedirectRefusedException : HttpRequestException
{
    /// <summary>Initializes a new instance of the <see cref="RedirectRefusedException"/> class.</summary>
    public RedirectRefusedException()
        : base("The address answered with a redirect, which this harness does not follow.") { }

    /// <summary>Initializes a new instance of the <see cref="RedirectRefusedException"/> class.</summary>
    /// <param name="message">What went wrong.</param>
    public RedirectRefusedException(string message)
        : base(message) { }

    /// <summary>Initializes a new instance of the <see cref="RedirectRefusedException"/> class.</summary>
    /// <param name="message">What went wrong.</param>
    /// <param name="innerException">The underlying failure.</param>
    public RedirectRefusedException(string message, Exception? innerException)
        : base(message, innerException) { }
}

/// <summary>
/// The only handler this tool dials with: one that goes where it was told, and reports a redirect
/// as a request that never arrived.
/// </summary>
/// <remarks>
/// <para>
/// <b><see cref="HttpClientHandler.AllowAutoRedirect"/> defaults to <see langword="true"/>, and
/// that default is a false green here.</b> Every claim this harness makes about <i>where</i> a
/// run went is made from the address that was requested: the engine's live baseline provider
/// checks an artifact against the address it asked for, a runner records the address it dialled,
/// and this tool's self-comparison guard compares the two references it was given. A transparent
/// redirect changes none of those and changes the system that actually answered.
/// </para>
/// <para>
/// The concrete failure is worth stating, because no single one of those checks can see it: a
/// baseline address that answers <c>307</c> with the candidate's address delivers the baseline
/// run to the system under review. Every guard passes — the requested address really was the
/// baseline's — and the comparison is then the candidate against itself, which agrees about
/// everything and renders as a clean run over an unexamined change.
/// </para>
/// <para>
/// <b>Not following is only half of it.</b> A 3xx left to stand as a reply is recorded as the
/// system under test having answered, and grades: the scenario simply fails. Against a
/// redirecting <i>baseline</i> address that is worse than the original defect — every scenario
/// reads as <c>Fixed</c>, and "newly covered: everything" is the most persuasive false green this
/// tool could print. So a redirect is raised as a failed request instead, which is a harness
/// failure and produces no verdict at all.
/// </para>
/// <para>
/// <b>The trade is deliberate and total: a suite cannot assert on a 3xx.</b> A redirect is a
/// routing instruction rather than an answer, and admitting it as evidence for one address while
/// refusing it for another is the kind of split rule that eventually gets applied to the wrong
/// one. A system whose evaluation endpoint redirects should be pointed at the address that
/// answers.
/// </para>
/// <para>
/// <b>The destination is never recorded.</b> A <c>Location</c> is supplied by whatever answered,
/// and the message travels into a committed artifact through the failure attribute — so the
/// status code is reported and the address it pointed at is not (§V).
/// </para>
/// </remarks>
internal sealed class RedirectRefusingHandler : DelegatingHandler
{
    private RedirectRefusingHandler(HttpMessageHandler inner)
        : base(inner) { }

    /// <summary>Builds the handler an <see cref="HttpClient"/> in this tool is constructed with.</summary>
    /// <returns>The handler. The client owns it and disposes the chain.</returns>
    public static HttpMessageHandler Create() =>
        new RedirectRefusingHandler(new HttpClientHandler { AllowAutoRedirect = false });

    /// <inheritdoc/>
    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken
    )
    {
        var response = await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
        var status = (int)response.StatusCode;

        if (status is < 300 or > 399)
        {
            return response;
        }

        response.Dispose();

        throw new RedirectRefusedException(
            $"The address answered {status.ToString(CultureInfo.InvariantCulture)} rather than a response, so the "
                + "system under test was never asked. A redirect is not followed and is not graded: every record of "
                + "where a run went is the address it was asked to go to, so following one would attribute another "
                + "system's behaviour to this one — and a baseline address redirecting to the candidate's would "
                + "compare the change against itself. Point the endpoint at the address that answers."
        );
    }
}
