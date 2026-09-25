using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Forge.EvalCli.Tests.Support;

/// <summary>
/// What a <see cref="StubEndpoint"/> answers one request with.
/// </summary>
/// <remarks>
/// Richer than a status and a body because two of the failures these tests pin are not expressible
/// as either: a redirect is a status plus a <c>Location</c>, and a run the harness could not
/// conduct is a connection that went away rather than any response at all.
/// </remarks>
internal sealed record StubReply
{
    /// <summary>Gets the HTTP status code to answer with.</summary>
    public required int Status { get; init; }

    /// <summary>Gets the body to answer with.</summary>
    public string Body { get; init; } = string.Empty;

    /// <summary>Gets the <c>Location</c> header to send, or null to send none.</summary>
    public string? Location { get; init; }

    /// <summary>
    /// Gets whether to drop the connection instead of answering.
    /// </summary>
    /// <remarks>
    /// The only way to make one repetition of a scenario error while another passes: the client
    /// sees a transport failure, which the engine records as a run it could not conduct rather
    /// than as a verdict about the system.
    /// </remarks>
    public bool Abort { get; init; }
}

/// <summary>
/// A minimal HTTP endpoint that speaks the tool's built-in JSON contract.
/// </summary>
/// <remarks>
/// <para>
/// A real socket rather than a stubbed <see cref="HttpMessageHandler"/>, because what these tests
/// exercise is the whole invocation — parse, load, select, run, write, report — and a handler
/// swapped in underneath would leave the composition root's own wiring unexercised. That wiring
/// is the part of this tool that decides whether anything is dialled at all.
/// </para>
/// <para>
/// Bound to a loopback port chosen by the operating system, so concurrent tests cannot collide on
/// a fixed one.
/// </para>
/// <para>
/// <b><see cref="IAsyncDisposable"/> only, deliberately.</b> Stopping the listener means waiting
/// for the serve loop, and waiting for it synchronously is blocking on async (§IV) — in a fixture
/// held by every end-to-end test here. Not implementing <see cref="IDisposable"/> means a
/// <c>using</c> that would reintroduce that block does not compile.
/// </para>
/// </remarks>
internal sealed class StubEndpoint : IAsyncDisposable
{
    private readonly HttpListener _listener = new();
    private readonly Task _loop;
    private readonly Func<string, StubReply> _respond;
    private int _requests;

    /// <summary>Starts an endpoint that answers every request through <paramref name="respond"/>.</summary>
    /// <param name="respond">Given the request body, returns the status and body to answer with.</param>
    public StubEndpoint(Func<string, (int Status, string Body)> respond)
        : this(body =>
        {
            var (status, text) = respond(body);

            return new StubReply { Status = status, Body = text };
        }) { }

    /// <summary>Starts an endpoint that answers every request through <paramref name="respond"/>.</summary>
    /// <param name="respond">Given the request body, returns what to answer with.</param>
    /// <param name="path">
    /// The path to listen on, without a leading slash. A path is a parameter because it is where a
    /// credential hides as readily as a query string does, and the tests that pin redaction need
    /// an address carrying one.
    /// </param>
    public StubEndpoint(Func<string, StubReply> respond, string path = "evaluate")
        : this(respond, path, []) { }

    /// <summary>Starts an endpoint answering on several paths of one host and port.</summary>
    /// <param name="respond">Given the request body, returns what to answer with.</param>
    /// <param name="path">The path <see cref="Address"/> points at, without a leading slash.</param>
    /// <param name="alsoServe">
    /// Further paths on the same host and port. Two deployments distinguished only by path is
    /// exactly the shape a baseline identity has to keep apart, and it cannot be built from two
    /// listeners on two ports.
    /// </param>
    public StubEndpoint(Func<string, StubReply> respond, string path, IReadOnlyList<string> alsoServe)
    {
        ArgumentNullException.ThrowIfNull(alsoServe);

        _respond = respond;

        Address = new Uri($"http://localhost:{FreePort()}/{path}");

        _listener.Prefixes.Add(Address.GetLeftPart(UriPartial.Path) + "/");

        foreach (var extra in alsoServe)
        {
            _listener.Prefixes.Add($"http://localhost:{Address.Port}/{extra}/");
        }

        _listener.Start();

        _loop = Task.Run(ServeAsync);
    }

    /// <summary>An address on this endpoint's host and port, at another path.</summary>
    /// <param name="path">The path, without a leading slash.</param>
    /// <returns>The address.</returns>
    public Uri At(string path) => new($"http://localhost:{Address.Port}/{path}");

    /// <summary>Gets the address to point <c>--endpoint</c> at.</summary>
    public Uri Address { get; }

    /// <summary>Gets how many requests have been answered.</summary>
    public int Requests => Volatile.Read(ref _requests);

    public async ValueTask DisposeAsync()
    {
        _listener.Close();

        try
        {
            await _loop.ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is HttpListenerException or ObjectDisposedException)
        {
            // Closing the listener is how the loop is stopped.
        }
    }

    private async Task ServeAsync()
    {
        while (_listener.IsListening)
        {
            HttpListenerContext context;

            try
            {
                context = await _listener.GetContextAsync().ConfigureAwait(false);
            }
            catch (Exception exception) when (exception is HttpListenerException or ObjectDisposedException)
            {
                return;
            }

            using var reader = new StreamReader(context.Request.InputStream, Encoding.UTF8);

            var request = await reader.ReadToEndAsync().ConfigureAwait(false);
            var reply = _respond(request);

            Interlocked.Increment(ref _requests);

            if (reply.Abort)
            {
                context.Response.Abort();

                continue;
            }

            var bytes = Encoding.UTF8.GetBytes(reply.Body);

            context.Response.StatusCode = reply.Status;
            context.Response.ContentType = "application/json";
            context.Response.ContentLength64 = bytes.Length;

            if (reply.Location is { } location)
            {
                context.Response.Headers["Location"] = location;
            }

            await context.Response.OutputStream.WriteAsync(bytes).ConfigureAwait(false);

            context.Response.Close();
        }
    }

    private static int FreePort()
    {
        using var probe = new TcpListener(IPAddress.Loopback, 0);

        probe.Start();

        var port = ((IPEndPoint)probe.LocalEndpoint).Port;

        probe.Stop();

        return port;
    }
}
