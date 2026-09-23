using FluentAssertions;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Baselines;
using Forge.EvalEngine.Coordination;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Tests.Coordination;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Tests.Baselines;

/// <summary>
/// The deployed-service baseline: run the suite against the version already running.
/// </summary>
/// <remarks>
/// The reference is untrusted, and the two ways it goes wrong are dialling something that is not
/// an evaluation endpoint, and evaluating something other than what was asked for.
/// </remarks>
public sealed class LiveEndpointBaselineTests
{
    private const string BaselineEndpoint = "https://baseline.example/eval";

    private static Suite Suite() => CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a"));

    private static RunCoordinator Coordinator(string? endpoint) =>
        CoordinatorFixtures.Coordinator(
            [new StubRunner(ScenarioKind.Rest)],
            options: new RunCoordinatorOptions { Endpoint = endpoint }
        );

    [Fact]
    public async Task TryGetBaselineAsync_HttpsReference_RunsTheSuiteAgainstIt()
    {
        Uri? asked = null;
        var provider = new LiveEndpointBaseline(
            Suite(),
            endpoint =>
            {
                asked = endpoint;

                return Coordinator(endpoint.ToString());
            }
        );

        var baseline = await provider.TryGetBaselineAsync(BaselineEndpoint, CancellationToken.None);

        asked.Should().Be(new Uri(BaselineEndpoint));
        baseline.Should().NotBeNull();
        baseline!.SuiteName.Should().Be("regression-suite");
        baseline.ScenarioResults.Should().ContainSingle().Which.ScenarioId.Should().Be("a");
    }

    [Fact]
    public async Task TryGetBaselineAsync_PlainHttpReference_IsAccepted()
    {
        const string Endpoint = "http://localhost:5001/eval";
        var provider = new LiveEndpointBaseline(Suite(), _ => Coordinator(Endpoint));

        (await provider.TryGetBaselineAsync(Endpoint, CancellationToken.None)).Should().NotBeNull();
    }

    [Fact]
    public async Task TryGetBaselineAsync_ProducedArtifact_RecordsTheEndpointItRanAgainst()
    {
        var provider = new LiveEndpointBaseline(Suite(), endpoint => Coordinator(endpoint.ToString()));

        var baseline = await provider.TryGetBaselineAsync(BaselineEndpoint, CancellationToken.None);

        baseline!.Environment.Endpoint.Should().Be(BaselineEndpoint);
    }

    [Theory]
    [InlineData("file:///C:/secrets/baseline.json")]
    [InlineData("ftp://baseline.example/eval")]
    [InlineData("data:text/plain,nothing")]
    public async Task TryGetBaselineAsync_ReferenceNamingAnotherScheme_Refuses(string reference)
    {
        var provider = new LiveEndpointBaseline(Suite(), _ => Coordinator(reference));
        var act = async () => await provider.TryGetBaselineAsync(reference, CancellationToken.None);

        await act.Should().ThrowAsync<ArgumentException>();
    }

    [Fact]
    public async Task TryGetBaselineAsync_ReferenceCarryingACredential_RefusesRatherThanStrippingIt()
    {
        const string Reference = "https://user:secret@baseline.example/eval";
        var invoked = false;

        var provider = new LiveEndpointBaseline(
            Suite(),
            _ =>
            {
                invoked = true;

                return Coordinator(BaselineEndpoint);
            }
        );

        var act = async () => await provider.TryGetBaselineAsync(Reference, CancellationToken.None);

        // Refused before the factory is called, so the credential never reaches anything that
        // could record or dial it. The message must not echo it back either.
        var thrown = await act.Should().ThrowAsync<ArgumentException>();
        thrown.Which.Message.Should().NotContain("secret");
        invoked.Should().BeFalse();
    }

    [Theory]
    [InlineData("baseline.example/eval")]
    [InlineData("/eval")]
    [InlineData("not a uri at all")]
    public async Task TryGetBaselineAsync_ReferenceThatIsNotAnAbsoluteUri_Refuses(string reference)
    {
        var provider = new LiveEndpointBaseline(Suite(), _ => Coordinator(BaselineEndpoint));
        var act = async () => await provider.TryGetBaselineAsync(reference, CancellationToken.None);

        await act.Should().ThrowAsync<ArgumentException>();
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public async Task TryGetBaselineAsync_BlankReference_Refuses(string reference)
    {
        var provider = new LiveEndpointBaseline(Suite(), _ => Coordinator(BaselineEndpoint));
        var act = async () => await provider.TryGetBaselineAsync(reference, CancellationToken.None);

        await act.Should().ThrowAsync<ArgumentException>();
    }

    [Fact]
    public async Task TryGetBaselineAsync_NullReference_Refuses()
    {
        var provider = new LiveEndpointBaseline(Suite(), _ => Coordinator(BaselineEndpoint));
        var act = async () => await provider.TryGetBaselineAsync(null!, CancellationToken.None);

        await act.Should().ThrowAsync<ArgumentNullException>();
    }

    [Fact]
    public async Task TryGetBaselineAsync_FactoryReturnedNull_RefusesRatherThanReportingNoBaseline()
    {
        var provider = new LiveEndpointBaseline(Suite(), _ => null!);
        var act = async () => await provider.TryGetBaselineAsync(BaselineEndpoint, CancellationToken.None);

        await act.Should().ThrowAsync<InvalidOperationException>();
    }

    [Fact]
    public async Task TryGetBaselineAsync_CoordinatorRecordedAnotherEndpoint_RefusesTheArtifact()
    {
        // The artifact is the only record of what was evaluated. A coordinator wired to a
        // different address produces a perfectly well-formed baseline for the wrong system, and
        // comparing against it attributes that system's behaviour to this one.
        var provider = new LiveEndpointBaseline(Suite(), _ => Coordinator("https://elsewhere.example/eval"));

        var act = async () => await provider.TryGetBaselineAsync(BaselineEndpoint, CancellationToken.None);

        (await act.Should().ThrowAsync<InvalidOperationException>()).WithMessage("*elsewhere.example*");
    }

    [Fact]
    public async Task TryGetBaselineAsync_CoordinatorRecordedNoEndpoint_RefusesTheArtifact()
    {
        var provider = new LiveEndpointBaseline(Suite(), _ => Coordinator(null));

        var act = async () => await provider.TryGetBaselineAsync(BaselineEndpoint, CancellationToken.None);

        await act.Should().ThrowAsync<InvalidOperationException>();
    }

    // -------------------------------------------------------------------------------------------
    // Redaction and verification pull against each other. Only what survives redaction can be
    // verified, so only that may be referenced — and the runner's own destination is checked
    // against the evidence rather than against the label the coordinator was configured with.
    // -------------------------------------------------------------------------------------------

    [Theory]
    [InlineData("https://baseline.example/eval?deployment=old")]
    [InlineData("https://baseline.example/eval?deployment=new")]
    [InlineData("https://baseline.example/eval#slot-two")]
    public async Task TryGetBaselineAsync_ReferenceWhoseIdentityCannotSurviveRedaction_Refuses(string reference)
    {
        // A query is where a bearer token lives, so it never reaches a committed artifact — it
        // is recorded as "?[redacted]". Two different deployments therefore record the same
        // text, and a check over that text cannot tell them apart.
        var invoked = false;
        var provider = new LiveEndpointBaseline(
            Suite(),
            _ =>
            {
                invoked = true;

                return Coordinator(reference);
            }
        );

        var act = async () => await provider.TryGetBaselineAsync(reference, CancellationToken.None);

        await act.Should().ThrowAsync<ArgumentException>();
        invoked.Should().BeFalse();
    }

    [Fact]
    public async Task TryGetBaselineAsync_ReferenceDifferingFromTheCoordinatorOnlyInItsQuery_IsNotAccepted()
    {
        // The fabrication this refusal prevents: a coordinator wired for ?deployment=new
        // satisfying a request for ?deployment=old, because both record as "?[redacted]".
        var provider = new LiveEndpointBaseline(
            Suite(),
            _ => Coordinator("https://baseline.example/eval?deployment=new")
        );

        var act = async () =>
            await provider.TryGetBaselineAsync("https://baseline.example/eval?deployment=old", CancellationToken.None);

        await act.Should().ThrowAsync<ArgumentException>();
    }

    [Fact]
    public async Task TryGetBaselineAsync_RunnerDialledAnotherDestination_RefusesTheArtifact()
    {
        // The miswired runner: the coordinator's options name the endpoint that was asked for,
        // and the runs went somewhere else. The options are a label; the transcripts are the
        // evidence.
        var provider = new LiveEndpointBaseline(
            Suite(),
            _ =>
                CoordinatorFixtures.Coordinator(
                    [DialsRunner("https://elsewhere.example/eval")],
                    options: new RunCoordinatorOptions { Endpoint = BaselineEndpoint }
                )
        );

        var act = async () => await provider.TryGetBaselineAsync(BaselineEndpoint, CancellationToken.None);

        (await act.Should().ThrowAsync<InvalidOperationException>()).WithMessage("*elsewhere.example*");
    }

    [Fact]
    public async Task TryGetBaselineAsync_RunnerDialledTheRequestedDestination_IsAccepted()
    {
        // The guard must pass the honest case, including a runner that appended its own query:
        // that is redacted on the way into the artifact and the address underneath still matches.
        var provider = new LiveEndpointBaseline(
            Suite(),
            _ =>
                CoordinatorFixtures.Coordinator(
                    [DialsRunner(BaselineEndpoint + "?api-version=2024-10-01")],
                    options: new RunCoordinatorOptions { Endpoint = BaselineEndpoint }
                )
        );

        var baseline = await provider.TryGetBaselineAsync(BaselineEndpoint, CancellationToken.None);

        baseline!.Environment.Endpoint.Should().Be(BaselineEndpoint);
    }

    [Fact]
    public async Task TryGetBaselineAsync_RunnerRecordedADestinationThatIsNotAnAddress_RefusesTheArtifact()
    {
        var provider = new LiveEndpointBaseline(
            Suite(),
            _ =>
                CoordinatorFixtures.Coordinator(
                    [DialsRunner("the baseline deployment")],
                    options: new RunCoordinatorOptions { Endpoint = BaselineEndpoint }
                )
        );

        var act = async () => await provider.TryGetBaselineAsync(BaselineEndpoint, CancellationToken.None);

        await act.Should().ThrowAsync<InvalidOperationException>();
    }

    /// <summary>A runner whose transcripts record the address it actually dialled.</summary>
    private static StubRunner DialsRunner(string dialled) =>
        new(
            ScenarioKind.Rest,
            (scenario, context, _) =>
            {
                var transcript = CoordinatorFixtures.Transcript(scenario, context);

                return Task.FromResult(
                    transcript with
                    {
                        Transport = transcript.Transport with { Endpoint = dialled },
                    }
                );
            }
        );

    [Fact]
    public async Task TryGetBaselineAsync_Cancelled_PropagatesThroughTheWholeSuiteRun()
    {
        using var cts = new CancellationTokenSource();
        var observed = CancellationToken.None;

        var runner = new StubRunner(
            ScenarioKind.Rest,
            async (scenario, context, token) =>
            {
                observed = token;
                await cts.CancelAsync();
                token.ThrowIfCancellationRequested();

                return CoordinatorFixtures.Transcript(scenario, context);
            }
        );

        var provider = new LiveEndpointBaseline(
            Suite(),
            _ =>
                CoordinatorFixtures.Coordinator(
                    [runner],
                    options: new RunCoordinatorOptions { Endpoint = BaselineEndpoint }
                )
        );

        var act = async () => await provider.TryGetBaselineAsync(BaselineEndpoint, cts.Token);

        await act.Should().ThrowAsync<OperationCanceledException>();

        // The coordinator may hand its workers a linked token rather than the caller's own, so
        // the claim is that cancelling the caller's token reached the innermost runner — not
        // that the same instance arrived there.
        observed.CanBeCanceled.Should().BeTrue();
        observed.IsCancellationRequested.Should().BeTrue();
    }

    [Fact]
    public async Task TryGetBaselineAsync_AlreadyCancelled_ThrowsWithoutRunningTheSuite()
    {
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        var invoked = false;
        var provider = new LiveEndpointBaseline(
            Suite(),
            _ =>
            {
                invoked = true;

                return Coordinator(BaselineEndpoint);
            }
        );

        var act = async () => await provider.TryGetBaselineAsync(BaselineEndpoint, cts.Token);

        await act.Should().ThrowAsync<OperationCanceledException>();
        invoked.Should().BeFalse();
    }

    [Fact]
    public void Constructor_NullSuite_Refuses()
    {
        var act = () => new LiveEndpointBaseline(null!, _ => Coordinator(BaselineEndpoint));

        act.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Constructor_NullFactory_Refuses()
    {
        var act = () => new LiveEndpointBaseline(Suite(), null!);

        act.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public async Task TryGetBaselineAsync_ResultFeedsTheComparatorDirectly()
    {
        // Both providers yield a SuiteResult, which is the whole reason one comparator serves
        // both: the live baseline is diffed against a candidate with no conversion step.
        var provider = new LiveEndpointBaseline(Suite(), endpoint => Coordinator(endpoint.ToString()));
        var baseline = await provider.TryGetBaselineAsync(BaselineEndpoint, CancellationToken.None);

        baseline.Should().BeAssignableTo<SuiteResult>();
        baseline!.ScenarioResults.Should().ContainSingle();
    }

    [Fact]
    public void LiveEndpointBaseline_IsABaselineProvider() =>
        new LiveEndpointBaseline(Suite(), _ => Coordinator(BaselineEndpoint))
            .Should()
            .BeAssignableTo<IBaselineProvider>();
}
