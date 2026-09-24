using Forge.EvalEngine.Runners;

namespace Forge.EvalCli.Exchanges;

/// <summary>
/// The built-in <see cref="IRestExchange"/> for a system that speaks the JSON contract described
/// on <see cref="JsonExchangeContract"/>.
/// </summary>
/// <remarks>
/// <para>
/// Selected with <c>--rest-exchange json</c>, and never registered without it. The request URI is
/// left null so the runner resolves it against the client's base address — which the composition
/// root sets from <c>--endpoint</c>, the one place the unredacted address is allowed to live.
/// </para>
/// <para>
/// Stateless and therefore safe to share across concurrent runs, which is what
/// <see cref="RestRunner"/> requires of an exchange it may drive from several runs at once.
/// </para>
/// </remarks>
internal sealed class JsonRestExchange : IRestExchange
{
    /// <inheritdoc/>
    public HttpRequestMessage CreateRequest(RestStimulus stimulus)
    {
        ArgumentNullException.ThrowIfNull(stimulus);

        return new HttpRequestMessage
        {
            Method = HttpMethod.Post,

            // Null on purpose: the runner resolves a null request URI against the client's base
            // address, which is the endpoint including its path and query. Naming a relative URI
            // here would silently drop the last segment of that path.
            RequestUri = null,
            Content = JsonExchangeContract.CreateBody(
                stimulus.Scenario.Identity.Id,
                stimulus.Text,
                stimulus.TurnIndex,
                stimulus.Repetition,
                stimulus.Seed
            ),
        };
    }

    /// <inheritdoc/>
    /// <remarks>
    /// A non-2xx reply is read through the same contract rather than short-circuited. A refusal
    /// or a rate limit is frequently the <i>point</i> of a scenario, and the runner already
    /// records the status code as transport metadata an expected-behaviour assertion can assert
    /// against. A body that is not in this contract — an HTML error page, most often — surfaces
    /// as a malformed response, which stays gradeable.
    /// </remarks>
    public RestResponse Read(RestReply reply)
    {
        ArgumentNullException.ThrowIfNull(reply);

        var reading = JsonExchangeContract.Read(reply.Body);

        return new RestResponse
        {
            Text = reading.Text,
            ObservedOutcome = reading.ObservedOutcome,
            ObservedPath = reading.ObservedPath,
            Fields = reading.Fields,
        };
    }
}
