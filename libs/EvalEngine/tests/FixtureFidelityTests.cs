using System.Net;
using System.Reflection;
using FluentAssertions;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Loading;
using Forge.EvalEngine.Runners;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Tests.Coordination;
using Forge.EvalEngine.Tests.Impact;
using Forge.EvalEngine.Tests.Runners;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Tests;

/// <summary>
/// The fixtures have to describe runs this engine actually produces.
/// </summary>
/// <remarks>
/// <para>
/// A comparator or selector test is only evidence about production if the artifact it is handed
/// looks like one. Every comparator and selector test in this suite once passed against
/// transcripts carrying <b>no transport attributes at all</b> — a shape no runner has ever
/// emitted — which is why a run recorded as a pass beside an exchange that gathered nothing was
/// invisible to 1779 green tests.
/// </para>
/// <para>
/// <b>The first version of this guard repeated the defect one layer along.</b> It compared
/// attribute <i>keys</i> rather than values, so a wrong stop reason passed — and the shared
/// description it checked paired <c>malformedResponse</c> with <c>terminalOutcome</c> where the
/// real runner records <c>exchangeFailed</c>. It also enumerated three hand-picked scenario
/// factories and missed a fourth. Both are the sampling error the fixtures themselves
/// demonstrated. So this file asserts over the <b>closed inventory</b> in
/// <see cref="ArtifactShapes.Modelled"/>, by full value, and over <b>every</b> scenario factory in
/// the assembly, found by reflection rather than by list.
/// </para>
/// </remarks>
public sealed class FixtureFidelityTests
{
    // -----------------------------------------------------------------------------------------
    // Every modelled shape is pinned against a real runner, by full value.
    // -----------------------------------------------------------------------------------------

    /// <summary>How a real runner is driven into each modelled shape.</summary>
    /// <remarks>
    /// Keyed by the shape it produces, so the completeness checks below compare this table
    /// against the inventory in both directions. A modelled shape with no driver is a claim
    /// nothing verified; a driver for an unmodelled shape is a shape no fixture can request.
    /// </remarks>
    private static IReadOnlyDictionary<TransportShape, Func<Task<Transcript>>> Drivers { get; } =
        new Dictionary<TransportShape, Func<Task<Transcript>>>
        {
            [new(ExchangeState.Responded, StopReason.TerminalOutcome)] = () => Rest(new StubExchange(), ["opening"]),

            [new(ExchangeState.Responded, StopReason.ParticipantComplete)] = () => Rest(NonTerminal(), ["opening"]),

            [new(ExchangeState.Responded, StopReason.TurnCeiling)] = () =>
                Rest(NonTerminal(), ["first", "second"], maxTurns: 1),

            // A non-2xx reply. The system answered — so the exchange responded, and a scenario
            // can assert on the refusal it was written to provoke — but the body is not the shape
            // the adapter agreed to parse, so the loop ends on a failed exchange. This pair was
            // missing from the inventory while a real runner emitted it: both of its constants
            // appear in other pairs, so a check anchored on constants alone stayed green.
            [new(ExchangeState.Responded, StopReason.ExchangeFailed)] = () =>
                Rest(new StubExchange(), ["opening"], status: HttpStatusCode.InternalServerError),

            [new(ExchangeState.MalformedResponse, StopReason.ExchangeFailed)] = () =>
                Rest(Throwing(new MalformedResponseException("the body was not JSON")), ["opening"]),

            [new(ExchangeState.AdapterFailed, StopReason.ExchangeFailed)] = () =>
                Rest(Throwing(new InvalidOperationException("the adapter fell over")), ["opening"]),

            [new(ExchangeState.RequestFailed, StopReason.ExchangeFailed)] = () =>
                Rest(new StubExchange(), ["opening"], transportFailure: new HttpRequestException("refused")),

            [new(ExchangeState.TimedOut, StopReason.ExchangeFailed)] = () =>
                Rest(
                    new StubExchange(),
                    ["opening"],
                    transportFailure: new TaskCanceledException("the transport timed out")
                ),

            // The caller completed before the first turn, so nothing was ever sent.
            [new(ExchangeState.NotAttempted, StopReason.ParticipantComplete)] = () => Rest(new StubExchange(), []),

            [new(ExchangeState.ParticipantFailed, StopReason.ParticipantFailed)] = async () =>
                await ConversationFixtures
                    .Runner(new StubConversationExchange())
                    .RunAsync(
                        ConversationFixtures.Scenario(),
                        RunnerFixtures.Context(new FailingParticipant(new InvalidOperationException("no stimulus"))),
                        CancellationToken.None
                    ),

            [new(ExchangeState.Unsupported, StopReason.Unsupported)] = async () =>
                await new NotImplementedMcpRunner(new FrozenClock(RunnerFixtures.Instant)).RunAsync(
                    RunnerFixtures.Scenario(ScenarioKind.Mcp),
                    RunnerFixtures.Context(new ScriptedParticipant("opening")),
                    CancellationToken.None
                ),

            // Written by the coordinator rather than by a runner: none is registered for the
            // scenario's kind, so no transcript was ever obtained.
            [new(ExchangeState.RunnerFailed, StopReason.RunnerFailed)] = async () =>
            {
                var result = await CoordinatorFixtures
                    .Coordinator([new StubRunner(ScenarioKind.Rest)])
                    .RunAsync(
                        CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario(kind: ScenarioKind.Llm)),
                        CancellationToken.None
                    );

                return result.ScenarioResults.Single().Runs.Single().Transcript;
            },
        };

    public static TheoryData<TransportShape> ModelledShapes()
    {
        var data = new TheoryData<TransportShape>();

        foreach (var shape in ArtifactShapes.Modelled)
        {
            data.Add(shape);
        }

        return data;
    }

    /// <summary>
    /// The shape the fixtures describe is the shape a real runner records — values, not keys.
    /// </summary>
    [Theory]
    [MemberData(nameof(ModelledShapes))]
    public async Task EveryModelledShape_MatchesWhatARealRunnerRecords(TransportShape shape)
    {
        Drivers.Should().ContainKey(shape, "every modelled shape must be produced by a real runner somewhere");

        var real = await Drivers[shape]();

        Reserved(real.Transport.Attributes)
            .Should()
            .BeEquivalentTo(
                new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    [TransportAttributes.Exchange] = shape.Exchange,
                    [TransportAttributes.StoppedBy] = shape.StoppedBy,
                },
                because: $"{shape} is what {nameof(ArtifactShapes)} tells every fixture to describe"
            );
    }

    [Fact]
    public void EveryModelledShape_HasADriver() =>
        ArtifactShapes.Modelled.Should().BeSubsetOf(Drivers.Keys, "a shape nothing produces is a shape nothing pins");

    [Fact]
    public void EveryDriver_ProducesAModelledShape() =>
        Drivers
            .Keys.Should()
            .BeSubsetOf(ArtifactShapes.Modelled, "a shape no fixture can request is a driver with nothing to guard");

    /// <summary>
    /// The inventory is pinned to what the library <b>declares</b>, not to what either list says.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The two subset checks above compare two hand-maintained sets against each other, and two
    /// lists agreeing is not evidence: deleting an entry from <b>both</b> leaves them satisfied
    /// while a real runner still emits the pair. These three anchor the inventory to
    /// <see cref="ExchangeState"/> and <see cref="StopReason"/> — the library's own declared
    /// constants, which neither list controls — and to what the drivers were <i>observed</i> to
    /// emit rather than to what they are labelled with.
    /// </para>
    /// <para>
    /// Deleting <c>responded/turnCeiling</c> from both lists now fails: nothing else emits
    /// <see cref="StopReason.TurnCeiling"/>, so the constant is left unobserved.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task EveryDeclaredExchangeState_IsObservedFromARealRunner() =>
        (await ObservedAsync())
            .Select(shape => shape.Exchange)
            .Distinct(StringComparer.Ordinal)
            .Should()
            .BeEquivalentTo(Declared(typeof(ExchangeState)), "a declared state nothing emits is a state nothing pins");

    [Fact]
    public async Task EveryDeclaredStopReason_IsObservedFromARealRunner() =>
        (await ObservedAsync())
            .Select(shape => shape.StoppedBy)
            .Distinct(StringComparer.Ordinal)
            .Should()
            .BeEquivalentTo(Declared(typeof(StopReason)), "a declared reason nothing emits is a reason nothing pins");

    /// <summary>The inventory is exactly what the drivers were seen to produce.</summary>
    [Fact]
    public async Task Modelled_IsExactlyWhatTheDriversWereObservedToEmit() =>
        (await ObservedAsync()).Should().BeEquivalentTo(ArtifactShapes.Modelled);

    /// <summary>
    /// A tripwire on the size of the inventory, because the checks above can still be satisfied
    /// by a matched pair of deletions.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Deleting a shape from <see cref="ArtifactShapes.Modelled"/> and its driver together leaves
    /// the equality check satisfied, and leaves the constant checks satisfied too whenever both
    /// of its constants appear in another pair — which is now true of
    /// <c>responded/exchangeFailed</c>, so the hole named in review is live rather than empty.
    /// </para>
    /// <para>
    /// This does not prove reachability; nothing short of a disposition for every cell of the
    /// constant cross-product would, and that is disproportionate. What it does is make a
    /// deletion <b>deliberate</b>: all three checks have to be edited, and this one states what
    /// editing it means.
    /// </para>
    /// </remarks>
    [Fact]
    public void Modelled_Count_IsTheNumberOfShapesRunnersAreKnownToEmit() =>
        ArtifactShapes
            .Modelled.Should()
            .HaveCount(
                12,
                "lowering this number removes a transport shape a real runner emits — confirm against the runner "
                    + "before changing it, and add or remove the driver in the same edit"
            );

    /// <summary>Every driver run, reduced to the shape it actually recorded.</summary>
    private static async Task<IReadOnlySet<TransportShape>> ObservedAsync()
    {
        var observed = new HashSet<TransportShape>();

        foreach (var driver in Drivers.Values)
        {
            var attributes = (await driver()).Transport.Attributes;

            observed.Add(
                new TransportShape(attributes[TransportAttributes.Exchange], attributes[TransportAttributes.StoppedBy])
            );
        }

        return observed;
    }

    /// <summary>
    /// The declared-state membership test is derived from the declarations, not a second list.
    /// </summary>
    /// <remarks>
    /// <see cref="ExchangeState.IsDeclared(string?)"/> spells its membership out as a pattern for
    /// speed. That is a second enumeration of the same constants, and two lists that agree today
    /// is the shape this file exists to distrust — so parity with the declarations is asserted
    /// rather than assumed.
    /// </remarks>
    [Fact]
    public void IsDeclared_Membership_MatchesTheConstantsExchangeStateDeclares()
    {
        foreach (var state in Declared(typeof(ExchangeState)))
        {
            ExchangeState.IsDeclared(state).Should().BeTrue($"'{state}' is declared by {nameof(ExchangeState)}");
        }

        ExchangeState.IsDeclared("somethingNobodyHasWrittenYet").Should().BeFalse();
        ExchangeState.IsDeclared(null).Should().BeFalse();
    }

    /// <summary>The constants a transport vocabulary type declares.</summary>
    private static IReadOnlyCollection<string> Declared(Type vocabulary) =>
        [
            .. vocabulary
                .GetFields(BindingFlags.Public | BindingFlags.Static | BindingFlags.FlattenHierarchy)
                .Where(field => field is { IsLiteral: true, IsInitOnly: false } && field.FieldType == typeof(string))
                .Select(field => (string)field.GetRawConstantValue()!)
                .Distinct(StringComparer.Ordinal),
        ];

    // -----------------------------------------------------------------------------------------
    // Every fixture that builds a scenario builds a runnable one — found, not listed.
    // -----------------------------------------------------------------------------------------

    /// <summary>Every static factory in this assembly that produces a <see cref="Scenario"/>.</summary>
    /// <remarks>
    /// Found by reflection rather than named, because the previous version listed three and
    /// missed a fourth. A factory this cannot call fails by name instead of being skipped, so
    /// adding one that needs arguments is a decision somebody makes rather than a gap that opens
    /// quietly.
    /// </remarks>
    public static TheoryData<string> ScenarioFactories()
    {
        var data = new TheoryData<string>();

        foreach (var method in Factories())
        {
            data.Add(Name(method));
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(ScenarioFactories))]
    public void EveryFixtureScenario_IsOneTheSuiteValidatorAccepts(string factory)
    {
        var method = Factories().Single(candidate => Name(candidate) == factory);
        var scenario = (Scenario)method.Invoke(null, [.. method.GetParameters().Select(Argument)])!;

        var findings = SuiteValidator
            .Validate([scenario])
            .Where(message => message.Severity == ValidationSeverity.Error)
            .ToArray();

        findings
            .Should()
            .BeEmpty(
                because: $"{factory} must describe a scenario a suite could contain: "
                    + string.Join("; ", findings.Select(finding => finding.Message))
            );
    }

    /// <summary>The inventory is discovered, and it reaches every fixture file that has one.</summary>
    [Fact]
    public void ScenarioFactories_CoverEveryFixtureFileThatBuildsOne() =>
        Factories()
            .Select(method => method.DeclaringType!.Name)
            .Should()
            .Contain(["ImpactFixtures", "CoordinatorFixtures", "RunnerFixtures", "ConversationFixtures"]);

    // -----------------------------------------------------------------------------------------
    // Every fixture that builds a transcript builds a modelled one — found, not listed.
    // -----------------------------------------------------------------------------------------

    /// <summary>Every static factory in this assembly that produces a <see cref="Transcript"/>.</summary>
    public static TheoryData<string> TranscriptFactories()
    {
        var data = new TheoryData<string>();

        foreach (var method in TranscriptBuilders())
        {
            data.Add(Name(method));
        }

        return data;
    }

    /// <summary>
    /// A fixture transcript's stop reason has to follow from its own outcome.
    /// </summary>
    /// <remarks>
    /// This is the check that catches a builder bypassing <see cref="ArtifactShapes"/> altogether.
    /// Asserting only that the shape is <i>modelled</i> would not: <c>responded</c> paired with
    /// <c>participantComplete</c> is a perfectly real shape — just not the one a run that reached
    /// a terminal outcome records, which is exactly the pairing a fixture got wrong twice.
    /// </remarks>
    [Theory]
    [MemberData(nameof(TranscriptFactories))]
    public void EveryFixtureTranscript_PairsItsStopReasonWithItsOwnOutcome(string factory)
    {
        var method = TranscriptBuilders().Single(candidate => Name(candidate) == factory);
        var transcript = (Transcript)method.Invoke(null, [.. method.GetParameters().Select(Argument)])!;
        var reserved = Reserved(transcript.Transport.Attributes);

        reserved.Should().ContainKey(TransportAttributes.Exchange, "no runner omits it");

        var reachedTerminalOutcome = !string.IsNullOrWhiteSpace(transcript.Outcome.ObservedOutcome);

        reserved
            .Should()
            .BeEquivalentTo(
                ArtifactShapes.For(reserved[TransportAttributes.Exchange], reachedTerminalOutcome),
                because: $"{factory} must describe a run this engine can produce"
            );
    }

    [Fact]
    public void TranscriptFactories_CoverEveryFixtureFileThatBuildsOne() =>
        TranscriptBuilders()
            .Select(method => method.DeclaringType!.Name)
            .Should()
            .Contain(["ImpactFixtures", "CoordinatorFixtures", "ComparisonFixtures", "TestData"]);

    private static IEnumerable<MethodInfo> TranscriptBuilders() =>
        typeof(FixtureFidelityTests)
            .Assembly.GetTypes()
            .Where(type =>
                type.IsAbstract
                && type.IsSealed
                && (type.Name.EndsWith("Fixtures", StringComparison.Ordinal) || type.Name == "TestData")
            )
            .SelectMany(type => type.GetMethods(BindingFlags.Public | BindingFlags.Static))
            .Where(method => method.ReturnType == typeof(Transcript))
            .OrderBy(Name, StringComparer.Ordinal);

    private static string Name(MethodInfo method) => $"{method.DeclaringType!.Name}.{method.Name}";

    private static IEnumerable<MethodInfo> Factories() =>
        typeof(FixtureFidelityTests)
            .Assembly.GetTypes()
            .Where(type => type.IsAbstract && type.IsSealed && type.Name.EndsWith("Fixtures", StringComparison.Ordinal))
            .SelectMany(type => type.GetMethods(BindingFlags.Public | BindingFlags.Static))
            .Where(method => method.ReturnType == typeof(Scenario))
            .OrderBy(Name, StringComparer.Ordinal);

    /// <summary>An argument for one factory parameter, or a stated refusal to guess.</summary>
    private static object? Argument(ParameterInfo parameter)
    {
        // A transforming factory takes a scenario and returns a variant of it.
        if (parameter.ParameterType == typeof(Scenario))
        {
            return ImpactFixtures.Declaring("a", "src/**");
        }

        if (parameter.ParameterType == typeof(RunContext))
        {
            return RunnerFixtures.Context(new ScriptedParticipant("opening"));
        }

        if (parameter.HasDefaultValue)
        {
            return parameter.DefaultValue;
        }

        if (parameter.ParameterType.IsArray)
        {
            return Array.CreateInstance(parameter.ParameterType.GetElementType()!, 0);
        }

        if (parameter.ParameterType == typeof(string))
        {
            return "a";
        }

        if (parameter.ParameterType.IsEnum)
        {
            return Enum.GetValues(parameter.ParameterType).GetValue(0);
        }

        if (parameter.ParameterType == typeof(long) || parameter.ParameterType == typeof(int))
        {
            return Convert.ChangeType(1, parameter.ParameterType, System.Globalization.CultureInfo.InvariantCulture);
        }

        throw new InvalidOperationException(
            $"No argument can be synthesized for '{parameter.Name}' of {Name((MethodInfo)parameter.Member)}. Teach "
                + $"{nameof(FixtureFidelityTests)}.{nameof(Argument)} how to supply one rather than dropping the "
                + "factory from the inventory — a factory nothing checks is how the last gap opened."
        );
    }

    // -----------------------------------------------------------------------------------------
    // Material.
    // -----------------------------------------------------------------------------------------

    private static async Task<Transcript> Rest(
        IRestExchange exchange,
        string[] script,
        int? maxTurns = null,
        Exception? transportFailure = null,
        HttpStatusCode status = HttpStatusCode.OK
    )
    {
        var reply = transportFailure is null
            ? new StubbedReply { Status = status }
            : new StubbedReply { Throws = transportFailure };

        return await RunnerFixtures
            .Runner(new StubHandler(reply, reply), exchange)
            .RunAsync(
                RunnerFixtures.Scenario(maxTurns: maxTurns),
                RunnerFixtures.Context(new ScriptedParticipant(script)),
                CancellationToken.None
            );
    }

    /// <summary>An adapter whose responses never reach a terminal outcome.</summary>
    private static StubExchange NonTerminal() =>
        new(_ => new RestResponse { Text = "a response", ObservedOutcome = null });

    /// <summary>An adapter that fails while reading, in whatever way the exception dictates.</summary>
    private static StubExchange Throwing(Exception failure) => new(_ => throw failure);

    /// <summary>Only the keys with a defined cross-stage meaning, which is what a fixture owes.</summary>
    private static Dictionary<string, string> Reserved(IReadOnlyDictionary<string, string> attributes) =>
        attributes
            .Where(attribute => attribute.Key is TransportAttributes.Exchange or TransportAttributes.StoppedBy)
            .ToDictionary(attribute => attribute.Key, attribute => attribute.Value, StringComparer.Ordinal);
}
