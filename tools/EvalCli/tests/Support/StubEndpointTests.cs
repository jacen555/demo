using System.Net;
using System.Net.Sockets;
using FluentAssertions;

namespace Forge.EvalCli.Tests.Support;

/// <summary>
/// Pins how <see cref="StubEndpoint"/> takes a loopback port.
/// </summary>
/// <remarks>
/// <para>
/// Asking the operating system for a free port and then binding to it cannot be made atomic here.
/// The probe has to release the port before HTTP.SYS can take it, because a socket still holding it
/// makes <see cref="HttpListener.Start"/> fail with error 32 — the very failure the probe exists to
/// avoid. Holding the probe across the bind is therefore not an option, so the contract is the
/// other one available: a collision inside the window is retried on a fresh candidate rather than
/// thrown at whoever ran the suite.
/// </para>
/// <para>
/// These tests <b>construct</b> the collision — a second listener really does hold the port across
/// the window — rather than running the suite repeatedly and trusting green. Frequency is the
/// evidence that let this defect read as "occasional" for as long as it did, and a suite that is
/// wrong one run in three teaches people to re-run rather than read.
/// </para>
/// </remarks>
public class StubEndpointTests
{
    [Fact]
    public void Listen_WhenTheCandidatePortIsTakenBeforeTheBind_RetriesAndBinds()
    {
        using var held = new HeldPort();

        // Attempt 1 is handed a port another process is holding: the race, made to happen.
        // Attempt 2 is handed the same port, freed at the instant it is asked for — so what this
        // asserts is that the bind was genuinely re-attempted, not merely renumbered.
        var candidates = new Candidates(() => held.Port, held.Release);

        var (listener, address) = StubEndpoint.Listen("evaluate", [], candidates.Next, attempts: 4);

        using var bound = listener;

        bound.IsListening.Should().BeTrue();
        address.Port.Should().Be(held.Port);
        candidates.Calls.Should().Be(2, "the first candidate was taken, so exactly one retry was needed");
    }

    [Fact]
    public void Listen_WhenAnotherListenerHoldsTheIdenticalPrefix_RetriesAndBinds()
    {
        // The other collision, and the one two stub endpoints racing inside this assembly would
        // hit: HTTP.SYS refuses a duplicate registration with error 183 rather than 32. A retry
        // that only recognised the socket-level error would still fail this run.
        using var held = new HeldPort();

        var port = held.Release();

        using var rival = new HttpListener();

        rival.Prefixes.Add($"http://localhost:{port}/evaluate/");
        rival.Start();

        var candidates = new Candidates(
            () => port,
            () =>
            {
                rival.Close();

                return port;
            }
        );

        var (listener, address) = StubEndpoint.Listen("evaluate", [], candidates.Next, attempts: 4);

        using var bound = listener;

        bound.IsListening.Should().BeTrue();
        address.Port.Should().Be(port);
        candidates.Calls.Should().Be(2, "the registration conflict is a collision like any other");
    }

    [Fact]
    public void Listen_WhenEveryCandidateStaysTaken_FailsAfterTheBoundedNumberOfAttempts()
    {
        using var held = new HeldPort();

        var candidates = new Candidates(() => held.Port, () => held.Port, () => held.Port);

        var listen = () => StubEndpoint.Listen("evaluate", [], candidates.Next, attempts: 3);

        var thrown = listen.Should().Throw<InvalidOperationException>();

        thrown.WithInnerException<HttpListenerException>("the refusal has to say what actually went wrong");
        thrown.Which.Message.Should().Contain("3");

        candidates.Calls.Should().Be(3, "the bound is the number of attempts — not one more, not one fewer");
    }

    [Fact]
    public void Listen_WhenTheAttemptBoundIsNotPositive_Refuses()
    {
        using var held = new HeldPort();

        var listen = () => StubEndpoint.Listen("evaluate", [], () => held.Port, attempts: 0);

        listen.Should().Throw<ArgumentOutOfRangeException>();
    }

    [Fact]
    public void Listen_WithAdditionalPaths_RegistersOnePrefixPerPathOnOnePort()
    {
        var candidates = new Candidates(FreeLoopbackPort, FreeLoopbackPort, FreeLoopbackPort, FreeLoopbackPort);

        var (listener, address) = StubEndpoint.Listen("evaluate", ["baseline", "other"], candidates.Next, attempts: 4);

        using var bound = listener;

        bound
            .Prefixes.Should()
            .BeEquivalentTo([
                $"http://localhost:{address.Port}/evaluate/",
                $"http://localhost:{address.Port}/baseline/",
                $"http://localhost:{address.Port}/other/",
            ]);
    }

    [Fact]
    public void BindAttempts_OnTheConstructedPath_AllowsMoreThanOneAttempt()
    {
        // A bound of one is not a bound — it is the original defect restored: probe, bind, and
        // hand the collision to whoever ran the suite. The constructor's own attempt count is
        // otherwise unobservable, so it is pinned as a value.
        StubEndpoint.BindAttempts.Should().BeGreaterThan(1);
    }

    private static int FreeLoopbackPort()
    {
        using var probe = new TcpListener(IPAddress.Loopback, 0);

        probe.Start();

        return ((IPEndPoint)probe.LocalEndpoint).Port;
    }

    /// <summary>Holds a loopback port the way a colliding process does, until released.</summary>
    private sealed class HeldPort : IDisposable
    {
        private readonly TcpListener _holder;
        private bool _released;

        public HeldPort()
        {
            _holder = new TcpListener(IPAddress.Loopback, 0);

            _holder.Start();

            Port = ((IPEndPoint)_holder.LocalEndpoint).Port;
        }

        /// <summary>Gets the port being held.</summary>
        public int Port { get; }

        /// <summary>Gives the port up so the next attempt on it can succeed.</summary>
        /// <returns>The port, now free.</returns>
        public int Release()
        {
            if (!_released)
            {
                _holder.Dispose();

                _released = true;
            }

            return Port;
        }

        public void Dispose() => Release();
    }

    /// <summary>
    /// Offers a fixed sequence of candidate ports, and fails the test if asked for one more.
    /// </summary>
    /// <remarks>
    /// An unbounded retry would otherwise hang the suite rather than fail it, and a test helper
    /// that hangs is worse than one that races: nobody gets a stack trace from a hang.
    /// </remarks>
    private sealed class Candidates(params Func<int>[] ports)
    {
        /// <summary>Gets how many candidates have been asked for.</summary>
        public int Calls { get; private set; }

        /// <summary>Supplies the next candidate port.</summary>
        /// <returns>The port.</returns>
        public int Next()
        {
            Calls++;

            if (Calls > ports.Length)
            {
                Assert.Fail(
                    $"The bind loop asked for candidate {Calls} after {ports.Length} were offered — "
                        + "the retry is not bounded."
                );
            }

            return ports[Calls - 1]();
        }
    }
}
