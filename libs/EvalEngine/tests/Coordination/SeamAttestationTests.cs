using FluentAssertions;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Coordination;
using Forge.EvalEngine.Participants;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Runners;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Tests.Runners;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Tests.Coordination;

/// <summary>
/// What an injected seam has to attest before a verdict drawn through it can be compared.
/// </summary>
/// <remarks>
/// <para>
/// Two seams, one rule. A seed source that cannot derive a seed from a run's identity, and a
/// runner that does not state the settings it ran under, both make a verdict that <i>looks</i>
/// comparable and is not. Neither may be silently substituted for or defaulted: a default is the
/// coordinator deciding, on the implementer's behalf, something the implementer is the only one
/// who knows.
/// </para>
/// <para>
/// The seed case is the one with a data-migration consequence. An implementer written against
/// <see cref="ISeedSource.NextSeed"/> alone still compiles against the current interface — a
/// default interface member is the compiler promising the <i>call site</i> is fine, which is a
/// true answer to a question nobody asked. What matters is whether that implementer still
/// participates, and it must not be possible for the answer to be "no, silently".
/// </para>
/// </remarks>
public sealed class SeamAttestationTests
{
    // -----------------------------------------------------------------------------------------
    // A seed source that only knows how to count is refused, not bypassed.
    // -----------------------------------------------------------------------------------------

    /// <summary>A source written against the interface as it was before seeds became identity-derived.</summary>
    /// <remarks>
    /// Deliberately implements <b>only</b> <see cref="ISeedSource.NextSeed"/> — this is
    /// `tools/EvalCli`'s `PinnedSeedSource` in miniature, and the shape the whole finding is
    /// about.
    /// </remarks>
    private sealed class PositionalSeedSource(params long[] schedule) : ISeedSource
    {
        private int _drawn;

        public int Drawn => _drawn;

        public long RootSeed => 4242;

        public long NextSeed() => schedule[_drawn++];
    }

    [Fact]
    public async Task RunAsync_SeedSourceThatOnlyImplementsNextSeed_IsRefusedRatherThanSilentlyBypassed()
    {
        var seeds = new PositionalSeedSource(11, 22, 33);
        var runner = new StubRunner(ScenarioKind.Rest);

        var act = () =>
            CoordinatorFixtures
                .Coordinator([runner], seeds: seeds)
                .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a", repetitions: 3)), default);

        (await act.Should().ThrowAsync<NotSupportedException>())
            .Which.Message.Should()
            .Contain(nameof(ISeedSource.SeedFor))
            .And.Contain(nameof(DeterministicSeedSource));

        runner.Seen.Should().BeEmpty("nothing may be dispatched on seeds the source did not supply");
    }

    /// <summary>
    /// The refusal must not consume the legacy sequence on its way out.
    /// </summary>
    /// <remarks>
    /// A refusal that first drew from <see cref="ISeedSource.NextSeed"/> would be conceding that
    /// the positional source is still participating, which is the thing being refused.
    /// </remarks>
    [Fact]
    public async Task RunAsync_SeedSourceThatOnlyImplementsNextSeed_DrawsNothingFromItsSequence()
    {
        var seeds = new PositionalSeedSource(11, 22, 33);

        var act = () =>
            CoordinatorFixtures
                .Coordinator([new StubRunner(ScenarioKind.Rest)], seeds: seeds)
                .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a", repetitions: 3)), default);

        await act.Should().ThrowAsync<NotSupportedException>();
        seeds.Drawn.Should().Be(0);
    }

    // -----------------------------------------------------------------------------------------
    // The artifact states which derivation produced its seeds, so an old baseline is refused
    // with a reason instead of un-pairing scenario by scenario.
    // -----------------------------------------------------------------------------------------

    [Fact]
    public async Task RunAsync_Always_RecordsTheSeedDerivationTheRunUsed()
    {
        var result = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)], seeds: new DeterministicSeedSource(1))
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario()), default);

        result.Environment.HarnessConfig.Should().ContainKey("seedDerivation").WhoseValue.Should().Be("scenarioId");
    }

    // -----------------------------------------------------------------------------------------
    // A runner states the settings it ran under, and the coordinator records them.
    // -----------------------------------------------------------------------------------------

    /// <summary>A runner whose one setting changes what every run it drives observes.</summary>
    private sealed class CeilingRunner(int ceiling) : IScenarioRunner
    {
        public ScenarioKind Kind => ScenarioKind.Llm;

        public IReadOnlyDictionary<string, string> VerdictBearingSettings { get; } =
            new Dictionary<string, string>(StringComparer.Ordinal) { ["maxTurnCeiling"] = ceiling.ToString() };

        public Task<Transcript> RunAsync(Scenario scenario, RunContext context, CancellationToken cancellationToken) =>
            Task.FromResult(CoordinatorFixtures.Transcript(scenario, context));
    }

    [Fact]
    public async Task RunAsync_RunnerDeclaringASetting_RecordsItNamespacedByTheKindItDrives()
    {
        var result = await CoordinatorFixtures
            .Coordinator([new CeilingRunner(12)])
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a", kind: ScenarioKind.Llm)), default);

        result.Environment.HarnessConfig.Should().Contain("runner.llm.maxTurnCeiling", "12");
    }

    [Fact]
    public async Task RunAsync_TwoRunsUnderDifferentRunnerCeilings_RecordDifferentHarnessSettings()
    {
        var suite = CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a", kind: ScenarioKind.Llm));

        var twelve = await CoordinatorFixtures.Coordinator([new CeilingRunner(12)]).RunAsync(suite, default);
        var three = await CoordinatorFixtures.Coordinator([new CeilingRunner(3)]).RunAsync(suite, default);

        twelve.Environment.HarnessConfig.Should().NotBeEquivalentTo(three.Environment.HarnessConfig);
    }

    /// <summary>The settings a runner states are the coordinator's to write, not a caller's.</summary>
    [Fact]
    public void HarnessConfig_NamingARunnerNamespacedSetting_IsRefused()
    {
        var act = () =>
            new RunCoordinatorOptions
            {
                HarnessConfig = new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["runner.llm.maxTurnCeiling"] = "999",
                },
            };

        act.Should().Throw<ArgumentException>();
    }

    // -----------------------------------------------------------------------------------------
    // The engine's own runners attest the settings that actually vary their verdicts.
    // -----------------------------------------------------------------------------------------

    [Fact]
    public void VerdictBearingSettings_OfTheConversationRunner_StatesItsTurnCeiling()
    {
        var runner = new LlmConversationRunner(
            new StubConversationExchange(),
            new FrozenClock(CoordinatorFixtures.Instant),
            new LlmConversationRunnerOptions { MaxTurnCeiling = 5 }
        );

        runner.VerdictBearingSettings.Should().Contain("maxTurnCeiling", "5");
    }

    [Fact]
    public void VerdictBearingSettings_OfARunnerWithNoSettings_IsEmptyRatherThanAbsent()
    {
        new NotImplementedMcpRunner(new FrozenClock(CoordinatorFixtures.Instant))
            .VerdictBearingSettings.Should()
            .BeEmpty();
    }

    // -----------------------------------------------------------------------------------------
    // The participant factory attests too, for the same reason and under the same rules.
    // -----------------------------------------------------------------------------------------

    /// <summary>A factory whose one setting changes the stimulus its callers send.</summary>
    private sealed class AttestingParticipantFactory(string maxStimulusLength = "2000") : IParticipantFactory
    {
        public IReadOnlyDictionary<string, string> VerdictBearingSettings { get; } =
            new Dictionary<string, string>(StringComparer.Ordinal) { ["maxStimulusLength"] = maxStimulusLength };

        public IParticipant Create(Scenario scenario, long seed, int repetition) => new CountingParticipant();
    }

    /// <summary>
    /// A truncated stimulus is a different question asked of the system under test.
    /// </summary>
    /// <remarks>
    /// <see cref="LlmCallerOptions.MaxStimulusLength"/> truncates <b>before</b>
    /// sending, so two runs differing only in it send different text and are compared as though
    /// the system changed. The coordinator holds the factory only as an interface, so the factory
    /// has to say.
    /// </remarks>
    [Fact]
    public async Task RunAsync_FactoryDeclaringASetting_RecordsItUnderTheParticipantNamespace()
    {
        var result = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)], participants: new AttestingParticipantFactory("512"))
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a")), default);

        result.Environment.HarnessConfig.Should().Contain("participants.maxStimulusLength", "512");
    }

    [Fact]
    public async Task RunAsync_TwoRunsUnderDifferentStimulusCeilings_RecordDifferentHarnessSettings()
    {
        var suite = CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a"));

        var wide = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)], participants: new AttestingParticipantFactory("2000"))
            .RunAsync(suite, default);
        var narrow = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)], participants: new AttestingParticipantFactory("40"))
            .RunAsync(suite, default);

        wide.Environment.HarnessConfig.Should().NotBeEquivalentTo(narrow.Environment.HarnessConfig);
    }

    [Fact]
    public void HarnessConfig_NamingAParticipantNamespacedSetting_IsRefused()
    {
        var act = () =>
            new RunCoordinatorOptions
            {
                HarnessConfig = new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["participants.maxStimulusLength"] = "1",
                },
            };

        act.Should().Throw<ArgumentException>().Which.Message.Should().NotContain("maxStimulusLength");
    }

    /// <summary>A factory whose attestation a test can move out from under the coordinator.</summary>
    private sealed class DriftingParticipantFactory : IParticipantFactory
    {
        private int _created;

        public IReadOnlyDictionary<string, string> VerdictBearingSettings =>
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["maxStimulusLength"] = Volatile.Read(ref _created) >= 1 ? "40" : "2000",
            };

        public IParticipant Create(Scenario scenario, long seed, int repetition)
        {
            Interlocked.Increment(ref _created);

            return new CountingParticipant();
        }
    }

    [Fact]
    public async Task RunAsync_FactoryWhoseAttestationChangesMidRun_IsRefusedRatherThanStamped()
    {
        var act = () =>
            CoordinatorFixtures
                .Coordinator([new StubRunner(ScenarioKind.Rest)], participants: new DriftingParticipantFactory())
                .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a", repetitions: 3)), default);

        (await act.Should().ThrowAsync<InvalidOperationException>())
            .Which.Message.Should()
            .NotContain("maxStimulusLength", "the setting's name is the factory's own text");
    }

    /// <summary>A factory whose attestation is unusable.</summary>
    private sealed class MalformedParticipantFactory(IReadOnlyDictionary<string, string>? settings)
        : IParticipantFactory
    {
        public IReadOnlyDictionary<string, string> VerdictBearingSettings => settings!;

        public IParticipant Create(Scenario scenario, long seed, int repetition) => new CountingParticipant();
    }

    public static TheoryData<string, IReadOnlyDictionary<string, string>?> MalformedFactoryAttestations() =>
        new()
        {
            { "a null map", null },
            {
                "a null value",
                new Dictionary<string, string>(StringComparer.Ordinal) { ["persona"] = null! }
            },
            {
                "a blank key",
                new Dictionary<string, string>(StringComparer.Ordinal) { ["  "] = "x" }
            },
            {
                "a machine path",
                new Dictionary<string, string>(StringComparer.Ordinal) { ["root"] = "/home/ci-user/repo" }
            },
        };

    [Theory]
    [MemberData(nameof(MalformedFactoryAttestations))]
    public async Task RunAsync_FactoryAttestingSomethingUnusable_IsRefusedBeforeAnythingIsDispatched(
        string label,
        IReadOnlyDictionary<string, string>? settings
    )
    {
        var runner = new StubRunner(ScenarioKind.Rest);

        var act = () =>
            CoordinatorFixtures
                .Coordinator([runner], participants: new MalformedParticipantFactory(settings))
                .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a")), default);

        var thrown = (await act.Should().ThrowAsync<ArgumentException>(because: label)).Which;
        thrown.Message.Should().NotContain("/home/ci-user");
        runner.Seen.Should().BeEmpty("a refusal after the runs would discard the evidence they produced");
    }

    /// <summary>
    /// The engine states its own caller's settings, so a factory does not re-derive the key names.
    /// </summary>
    /// <remarks>
    /// Every composition root that builds an <see cref="Participants.LlmCaller"/> would otherwise
    /// have to spell these out, and two roots spelling them differently would make two artifacts
    /// incomparable for no reason. The persona is carried as a fingerprint rather than as prose:
    /// what a comparison needs is whether it changed, and the text is operator-authored free-form
    /// bound for a committed artifact.
    /// </remarks>
    [Fact]
    public void VerdictBearingSettings_OfLlmCallerOptions_StateTheCeilingAndWitnessThePersona()
    {
        var settings = new LlmCallerOptions { MaxStimulusLength = 512, Persona = "terse" }.VerdictBearingSettings;

        settings.Should().Contain("maxStimulusLength", "512");
        settings.Should().ContainKey("persona").WhoseValue.Should().NotContain("terse");
    }

    [Fact]
    public void VerdictBearingSettings_OfLlmCallerOptions_WitnessTwoPersonasDifferently()
    {
        var first = new LlmCallerOptions { Persona = "terse and impatient" }.VerdictBearingSettings;
        var second = new LlmCallerOptions { Persona = "rambling" }.VerdictBearingSettings;

        first["persona"].Should().NotBe(second["persona"]);
    }

    /// <summary>
    /// A witness must be of what was used, not of what was supplied.
    /// </summary>
    /// <remarks>
    /// <see cref="Participants.LlmCaller"/> trims the persona before placing it in the
    /// instruction, so two options differing only in surrounding whitespace produce an identical
    /// effective instruction. Witnessing the raw value would make those two runs disagree on a
    /// harness setting and refuse a comparison over nothing — which is the inverse of the false
    /// green this attestation exists to prevent, and just as wrong.
    /// </remarks>
    [Theory]
    [InlineData("terse", " terse ")]
    [InlineData("rambling, mentions their dog", "\trambling, mentions their dog\n")]
    public void VerdictBearingSettings_OfPersonasThatTrimToTheSameInstruction_WitnessThemIdentically(
        string supplied,
        string padded
    )
    {
        var first = new LlmCallerOptions { Persona = supplied }.VerdictBearingSettings;
        var second = new LlmCallerOptions { Persona = padded }.VerdictBearingSettings;

        second["persona"].Should().Be(first["persona"]);
    }

    [Fact]
    public void VerdictBearingSettings_OfLlmCallerOptionsWithNoPersona_SaysSoRatherThanOmittingIt()
    {
        LlmCallerOptions.Default.VerdictBearingSettings.Should().ContainKey("persona");
    }

    // -----------------------------------------------------------------------------------------
    // The attestation has to be true of the runs it is stamped beside.
    // -----------------------------------------------------------------------------------------

    /// <summary>A runner whose attestation a test can change out from under the coordinator.</summary>
    private sealed class DriftingRunner : IScenarioRunner
    {
        private int _conducted;

        public ScenarioKind Kind => ScenarioKind.Rest;

        /// <summary>The value reported after <see cref="DriftsAfter"/> runs have been conducted.</summary>
        public string Later { get; init; } = "3";

        public int DriftsAfter { get; init; } = 1;

        public IReadOnlyDictionary<string, string> VerdictBearingSettings =>
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["maxTurnCeiling"] = Volatile.Read(ref _conducted) >= DriftsAfter ? Later : "12",
            };

        public Task<Transcript> RunAsync(Scenario scenario, RunContext context, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _conducted);

            return Task.FromResult(CoordinatorFixtures.Transcript(scenario, context));
        }
    }

    /// <summary>
    /// A setting read after the runs is a record of what the runner says now, not of what governed
    /// them.
    /// </summary>
    /// <remarks>
    /// The whole point of attesting is that the artifact states what actually applied. Collecting
    /// the attestation in the assembly step stamps a value that may have changed halfway through —
    /// and a comparison would then refuse, or accept, on a figure no run was conducted under.
    /// </remarks>
    [Fact]
    public async Task RunAsync_RunnerWhoseAttestationChangesMidRun_IsRefusedRatherThanStamped()
    {
        var act = () =>
            CoordinatorFixtures
                .Coordinator([new DriftingRunner { DriftsAfter = 1, Later = "3" }])
                .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a", repetitions: 3)), default);

        (await act.Should().ThrowAsync<InvalidOperationException>())
            .Which.Message.Should()
            .Contain("rest", because: "the scenario kind is a closed set this library declares")
            .And.NotContain(
                "maxTurnCeiling",
                because: "the setting's name is the runner's own text and this message reaches the build log"
            );
    }

    [Fact]
    public async Task RunAsync_RunnerWhoseAttestationHoldsSteady_StampsIt()
    {
        var result = await CoordinatorFixtures
            .Coordinator([new DriftingRunner { DriftsAfter = int.MaxValue }])
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a", repetitions: 3)), default);

        result.Environment.HarnessConfig.Should().Contain("runner.rest.maxTurnCeiling", "12");
    }

    /// <summary>A runner whose attestation is unusable.</summary>
    private sealed class MalformedAttestationRunner(IReadOnlyDictionary<string, string>? settings) : IScenarioRunner
    {
        public ScenarioKind Kind => ScenarioKind.Rest;

        public IReadOnlyDictionary<string, string> VerdictBearingSettings => settings!;

        public Task<Transcript> RunAsync(Scenario scenario, RunContext context, CancellationToken cancellationToken) =>
            Task.FromResult(CoordinatorFixtures.Transcript(scenario, context));
    }

    /// <summary>
    /// A malformed attestation is refused before dispatch, not after the evidence exists.
    /// </summary>
    /// <remarks>
    /// Read in the assembly step it would throw with every run already conducted, discarding a
    /// whole suite's evidence over a defect that was visible before anything was sent. Refusing
    /// costs nothing at plan time, which is the rule the coordinator already applies to a
    /// duplicate scenario id and a colliding seed.
    /// </remarks>
    public static TheoryData<string, IReadOnlyDictionary<string, string>?> MalformedAttestations() =>
        new()
        {
            { "a null map", null },
            {
                "a null value",
                new Dictionary<string, string>(StringComparer.Ordinal) { ["maxTurnCeiling"] = null! }
            },
            {
                "a blank key",
                new Dictionary<string, string>(StringComparer.Ordinal) { ["   "] = "12" }
            },
            {
                "a machine path",
                new Dictionary<string, string>(StringComparer.Ordinal) { ["root"] = "/home/ci-user/repo" }
            },
        };

    [Theory]
    [MemberData(nameof(MalformedAttestations))]
    public async Task RunAsync_RunnerAttestingSomethingUnusable_IsRefusedBeforeAnythingIsDispatched(
        string label,
        IReadOnlyDictionary<string, string>? settings
    )
    {
        var runner = new MalformedAttestationRunner(settings);

        var act = () =>
            CoordinatorFixtures
                .Coordinator([runner])
                .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a")), default);

        var thrown = (await act.Should().ThrowAsync<ArgumentException>(because: label)).Which;
        thrown.Message.Should().NotContain("/home/ci-user");
    }

    [Fact]
    public async Task RunAsync_RunnerAttestingAMachinePath_IsRefusedBeforeAnyRunIsConducted()
    {
        var runner = new CountingDriftingRunner();

        var act = () =>
            CoordinatorFixtures
                .Coordinator([runner])
                .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a", repetitions: 4)), default);

        await act.Should().ThrowAsync<ArgumentException>();
        runner.Conducted.Should().Be(0, "a refusal after the runs would discard the evidence they produced");
    }

    /// <summary>A runner that attests a machine path and counts what it was asked to conduct.</summary>
    private sealed class CountingDriftingRunner : IScenarioRunner
    {
        private int _conducted;

        public int Conducted => Volatile.Read(ref _conducted);

        public ScenarioKind Kind => ScenarioKind.Rest;

        public IReadOnlyDictionary<string, string> VerdictBearingSettings =>
            new Dictionary<string, string>(StringComparer.Ordinal) { ["suiteRoot"] = "/home/ci-user/repo" };

        public Task<Transcript> RunAsync(Scenario scenario, RunContext context, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _conducted);

            return Task.FromResult(CoordinatorFixtures.Transcript(scenario, context));
        }
    }
}
