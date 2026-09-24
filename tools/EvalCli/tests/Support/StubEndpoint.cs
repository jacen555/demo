using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Forge.EvalCli.Tests.Support;

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
    private readonly Func<string, (int Status, string Body)> _respond;
    private int _requests;

    /// <summary>Starts an endpoint that answers every request through <paramref name="respond"/>.</summary>
    /// <param name="respond">Given the request body, returns the status and body to answer with.</param>
    public StubEndpoint(Func<string, (int Status, string Body)> respond)
    {
        _respond = respond;

        Address = new Uri($"http://localhost:{FreePort()}/evaluate");

        _listener.Prefixes.Add(Address.GetLeftPart(UriPartial.Path) + "/");
        _listener.Start();

        _loop = Task.Run(ServeAsync);
    }

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
            var (status, body) = _respond(request);
            var bytes = Encoding.UTF8.GetBytes(body);

            Interlocked.Increment(ref _requests);

            context.Response.StatusCode = status;
            context.Response.ContentType = "application/json";
            context.Response.ContentLength64 = bytes.Length;

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
