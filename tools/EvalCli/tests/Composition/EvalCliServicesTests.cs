using FluentAssertions;
using Forge.EvalCli.Changes;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Composition;
using Forge.EvalCli.Tests.Support;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Baselines;
using Forge.EvalEngine.Comparison;
using Forge.EvalEngine.Coordination;
using Forge.EvalEngine.Loading;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Runners;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Statistics;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Forge.EvalCli.Tests.Composition;

public class EvalCliServicesTests
{
    private static RunPlan Plan(TempWorkspace workspace, bool verbose = false, long seed = 7) =>
        RunPlan.Create(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = workspace.Root,
                Seed = seed,
                Verbose = verbose,
            }
        );

    [Fact]
    public void Build_ForEverySeamTheEngineLeavesOpen_Resolves()
    {
        using var workspace = new TempWorkspace();
        using var diagnostics = new StringWriter();
        using var provider = EvalCliServices.Build(Plan(workspace), diagnostics);

        provider.GetRequiredService<IClock>().Should().NotBeNull();
        provider.GetRequiredService<ISeedSource>().Should().NotBeNull();
        provider.GetRequiredService<IParticipantFactory>().Should().NotBeNull();
        provider.GetRequiredService<AssertionEvaluatorRegistry>().Should().NotBeNull();
        provider.GetRequiredService<ISignificanceTest>().Should().NotBeNull();
        provider.GetRequiredService<IMultipleComparisonCorrection>().Should().NotBeNull();
        provider.GetRequiredService<RunCoordinatorOptions>().Should().NotBeNull();
        provider.GetServices<IScenarioRunner>().Should().NotBeEmpty();
        provider.GetRequiredService<RunCoordinator>().Should().NotBeNull();
        provider.GetRequiredService<SuiteComparator>().Should().NotBeNull();
    }

    [Fact]
    public void Build_ForTheParticipantFactory_RegistersAFactoryRatherThanAParticipant()
    {
        using var workspace = new TempWorkspace();
        using var diagnostics = new StringWriter();
        using var provider = EvalCliServices.Build(Plan(workspace), diagnostics);

        // The coordinator refuses a participant it has already handed to another run, so the
        // registration that matters is the one that mints a new one per call - not a shared
        // IParticipant, which would fail at runtime on the second repetition.
        provider.GetService<IParticipant>().Should().BeNull();
        provider.GetRequiredService<IParticipantFactory>().Should().BeOfType<DeterministicParticipantFactory>();
    }

    [Fact]
    public void Build_ForTheSeedSource_GivesEveryResolutionItsOwnInstance()
    {
        using var workspace = new TempWorkspace();
        using var diagnostics = new StringWriter();
        using var provider = EvalCliServices.Build(Plan(workspace), diagnostics);

        var first = provider.GetRequiredService<ISeedSource>();
        var second = provider.GetRequiredService<ISeedSource>();

        // DeterministicSeedSource is not thread-safe and the engine wants one per suite run.
        first.Should().NotBeSameAs(second);
    }

    [Fact]
    public void Build_ForTheSeedSource_ProducesTheSameSequenceFromTheSameRootSeed()
    {
        using var workspace = new TempWorkspace();
        using var diagnostics = new StringWriter();
        using var provider = EvalCliServices.Build(Plan(workspace, seed: 4242), diagnostics);

        var first = provider.GetRequiredService<ISeedSource>();
        var second = provider.GetRequiredService<ISeedSource>();

        first.RootSeed.Should().Be(4242);
        Enumerable
            .Range(0, 5)
            .Select(_ => first.NextSeed())
            .Should()
            .Equal(Enumerable.Range(0, 5).Select(_ => second.NextSeed()));
    }

    [Fact]
    public void Build_ForTheSeedSource_RegistersTheEnginesIdentityDerivedSourceItself()
    {
        // The registration the coordinator actually draws through, and the one nothing else here
        // pins. RunCoordinator asks for a run's seed by identity through ISeedSource.SeedFor and
        // never calls NextSeed, so every sibling test above — all of which assert on the sequence
        // — would go on passing against a registration the engine refuses at plan time. That is
        // not hypothetical: the interface's default SeedFor throws NotSupportedException, and a
        // wrapper registered here that implemented only NextSeed is exactly what took this suite
        // to 106 failures.
        using var workspace = new TempWorkspace();
        using var diagnostics = new StringWriter();
        using var provider = EvalCliServices.Build(Plan(workspace, seed: 4242), diagnostics);

        var source = provider.GetRequiredService<ISeedSource>();

        // The engine's own implementation, resolved directly rather than through anything that
        // wraps or replays it. A wrapper is free to delegate SeedFor today and stop tomorrow.
        source.Should().BeOfType<DeterministicSeedSource>();
        source.RootSeed.Should().Be(4242);

        // And it answers from the configured root by identity, so the seed a scenario is driven
        // with survives the suite being narrowed or reordered — the property the README states and
        // the one a baseline comparison is paired on.
        source.SeedFor("checkout", 1).Should().Be(new DeterministicSeedSource(4242).SeedFor("checkout", 1));

        // **This assembly contributes no seed source of its own, and that is what the assertions
        // above cannot establish by themselves.** The scheduler this replaced handed out a plain
        // DeterministicSeedSource until something pinned it, so a provider built and resolved
        // without a pinning step — which is every provider this test file builds — got the right
        // type out of the wrong wiring. Resolving therefore cannot tell the two apart, and a test
        // that only resolves would go green against the very thing it was written to forbid.
        //
        // Asserted on the deletion instead of on the wiring, so no fallback can satisfy it, and by
        // shape rather than by name, so a wrapper reintroduced under any other name is caught too.
        typeof(EvalCliServices)
            .Assembly.GetTypes()
            .Where(type => typeof(ISeedSource).IsAssignableFrom(type))
            .Should()
            .BeEmpty("seeds are the engine's to derive; this assembly registers its type and adds none");
    }

    [Fact]
    public void Build_ForTheArtifactReader_AcceptsExactlyWhatThePublishingBudgetAllows()
    {
        // The correspondence this tool's honesty rests on: an artifact it agrees to publish must
        // be one the reader it configures agrees to read. Two numbers that drifted apart would
        // let `baseline update --apply` report a successful update after replacing a readable
        // baseline with one no later comparison could load.
        using var workspace = new TempWorkspace();
        using var diagnostics = new StringWriter();
        using var provider = EvalCliServices.Build(Plan(workspace), diagnostics);

        provider.GetRequiredService<ArtifactBaseline>().MaxBytes.Should().Be(ArtifactBudget.Bytes);
    }

    [Fact]
    public void Build_ForTheCoordinator_GivesEveryCoordinatorItsOwnInstance()
    {
        using var workspace = new TempWorkspace();
        using var diagnostics = new StringWriter();
        using var provider = EvalCliServices.Build(Plan(workspace), diagnostics);

        provider
            .GetRequiredService<RunCoordinator>()
            .Should()
            .NotBeSameAs(provider.GetRequiredService<RunCoordinator>());
    }

    [Fact]
    public void Build_ForTheLogger_ReplacesTheEnginesNullLoggerWithOneThatWritesSomewhere()
    {
        using var workspace = new TempWorkspace();
        using var diagnostics = new StringWriter();
        using var provider = EvalCliServices.Build(Plan(workspace), diagnostics);

        var logger = provider.GetRequiredService<ILogger<RunCoordinator>>();

        logger.Should().NotBeOfType<NullLogger<RunCoordinator>>();

        logger.Log(
            LogLevel.Warning,
            new EventId(1),
            "a terminal failure the artifact alone would not surface",
            null,
            static (state, _) => state
        );

        diagnostics.ToString().Should().Contain("a terminal failure the artifact alone would not surface");
    }

    [Fact]
    public void Build_ForTheLogger_WritesTheCategorySoARecordCanBeTracedBack()
    {
        using var workspace = new TempWorkspace();
        using var diagnostics = new StringWriter();
        using var provider = EvalCliServices.Build(Plan(workspace), diagnostics);

        provider
            .GetRequiredService<ILogger<RunCoordinator>>()
            .Log(LogLevel.Warning, new EventId(1), "something", null, static (state, _) => state);

        diagnostics.ToString().Should().Contain(typeof(RunCoordinator).FullName);
    }

    [Fact]
    public void Build_WhenVerboseWasNotRequested_SuppressesDebugRecords()
    {
        using var workspace = new TempWorkspace();
        using var diagnostics = new StringWriter();
        using var provider = EvalCliServices.Build(Plan(workspace), diagnostics);

        provider
            .GetRequiredService<ILogger<RunCoordinator>>()
            .Log(LogLevel.Debug, new EventId(1), "chatter", null, static (state, _) => state);

        diagnostics.ToString().Should().NotContain("chatter");
    }

    [Fact]
    public void Build_WhenVerboseWasRequested_EmitsDebugRecords()
    {
        using var workspace = new TempWorkspace();
        using var diagnostics = new StringWriter();
        using var provider = EvalCliServices.Build(Plan(workspace, verbose: true), diagnostics);

        provider
            .GetRequiredService<ILogger<RunCoordinator>>()
            .Log(LogLevel.Debug, new EventId(1), "chatter", null, static (state, _) => state);

        diagnostics.ToString().Should().Contain("chatter");
    }

    [Fact]
    public void MinimumLevel_WhenVerboseWasNotRequested_IsQuiet()
    {
        using var workspace = new TempWorkspace();

        EvalCliServices.MinimumLevel(Plan(workspace)).Should().Be(LogLevel.Warning);
    }

    [Fact]
    public void MinimumLevel_WhenVerboseWasRequested_IsDebug()
    {
        using var workspace = new TempWorkspace();

        EvalCliServices.MinimumLevel(Plan(workspace, verbose: true)).Should().Be(LogLevel.Debug);
    }

    [Fact]
    public void Build_ForTheSignificanceTest_WiresThePairedTestAndTheFalseDiscoveryCorrection()
    {
        using var workspace = new TempWorkspace();
        using var diagnostics = new StringWriter();
        using var provider = EvalCliServices.Build(Plan(workspace), diagnostics);

        provider.GetRequiredService<ISignificanceTest>().Kind.Should().Be(SignificanceTestKind.McNemar);
        provider.GetRequiredService<IMultipleComparisonCorrection>().Name.Should().Be("benjamini-hochberg");
    }

    [Fact]
    public void Build_ForTheCoordinatorOptions_CarriesThePlansCeilings()
    {
        using var workspace = new TempWorkspace();
        using var diagnostics = new StringWriter();

        var plan = RunPlan.Create(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = workspace.Root,
                MaxConcurrency = 3,
                MaxTotalRuns = 55,
            }
        );

        using var provider = EvalCliServices.Build(plan, diagnostics);

        var options = provider.GetRequiredService<RunCoordinatorOptions>();

        options.MaxConcurrency.Should().Be(3);
        options.MaxTotalRuns.Should().Be(55);
    }

    [Fact]
    public void Build_WhenThePlanIsNull_Throws()
    {
        using var diagnostics = new StringWriter();

        var act = () => EvalCliServices.Build(null!, diagnostics);

        act.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Build_WhenTheDiagnosticsWriterIsNull_Throws()
    {
        using var workspace = new TempWorkspace();

        var act = () => EvalCliServices.Build(Plan(workspace), null!);

        act.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Build_WhenNoExchangeWasNamed_LeavesTheKindsThatNeedOneWithoutARunner()
    {
        using var workspace = new TempWorkspace();
        using var diagnostics = new StringWriter();
        using var provider = EvalCliServices.Build(Plan(workspace), diagnostics);

        var kinds = provider.GetServices<IScenarioRunner>().Select(runner => runner.Kind).ToArray();

        // Nothing speculative. A kind with no runner is recorded by the engine as a harness
        // failure, which is honest; a guessed adapter would produce findings about the wrong party.
        kinds.Should().NotContain(ScenarioKind.Rest).And.NotContain(ScenarioKind.Llm);
        kinds.Should().Contain(ScenarioKind.Mcp).And.Contain(ScenarioKind.Ui);
        provider.GetService<IRestExchange>().Should().BeNull();
        provider.GetService<HttpClient>().Should().BeNull();
    }

    [Fact]
    public void Build_WhenAnExchangeWasNamed_WiresItsRunnerAgainstTheUnredactedEndpoint()
    {
        using var workspace = new TempWorkspace();
        using var diagnostics = new StringWriter();

        var plan = RunPlan.Create(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = workspace.Root,
                Endpoint = "https://example.com/api?token=abcdef",
                RestExchange = "json",
                LlmExchange = "json",
            }
        );

        using var provider = EvalCliServices.Build(plan, diagnostics);

        var kinds = provider.GetServices<IScenarioRunner>().Select(runner => runner.Kind).ToArray();

        kinds.Should().Contain(ScenarioKind.Rest).And.Contain(ScenarioKind.Llm);

        // The client is the one place the dialling form lives; everything recorded is redacted.
        provider.GetRequiredService<HttpClient>().BaseAddress!.Query.Should().Contain("abcdef");
        provider.GetRequiredService<IConversationExchange>().Endpoint.Should().NotContain("abcdef");
    }

    [Fact]
    public void Build_WhenAnExchangeWasNamed_SharesOneClientAcrossTheWholeInvocation()
    {
        using var workspace = new TempWorkspace();
        using var diagnostics = new StringWriter();

        var plan = RunPlan.Create(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = workspace.Root,
                Endpoint = "https://example.com/api",
                RestExchange = "json",
            }
        );

        using var provider = EvalCliServices.Build(plan, diagnostics);

        provider.GetRequiredService<HttpClient>().Should().BeSameAs(provider.GetRequiredService<HttpClient>());
    }

    [Fact]
    public void Build_WhenNoRevisionWasNamed_RegistersTheSourceThatSelectsEverything()
    {
        using var workspace = new TempWorkspace();
        using var diagnostics = new StringWriter();
        using var provider = EvalCliServices.Build(Plan(workspace), diagnostics);

        provider.GetRequiredService<IChangedFileSource>().Should().BeOfType<FullSuiteChangedFileSource>();
    }

    [Fact]
    public void Build_WhenARevisionWasNamed_RegistersTheGitSource()
    {
        using var workspace = new TempWorkspace();
        using var diagnostics = new StringWriter();

        var plan = RunPlan.Create(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = workspace.Root,
                ChangedSince = "HEAD",
            }
        );

        using var provider = EvalCliServices.Build(plan, diagnostics);

        provider.GetRequiredService<IChangedFileSource>().Should().BeOfType<GitChangedFileSource>();
    }

    [Fact]
    public void Build_ForTheReadersOfCommittedFiles_ConfinesThemToTheSameRootTheArgumentsWereCheckedAgainst()
    {
        using var workspace = new TempWorkspace();
        using var diagnostics = new StringWriter();

        var plan = Plan(workspace);

        using var provider = EvalCliServices.Build(plan, diagnostics);

        provider.GetRequiredService<SuiteLoader>().RootDirectory.Should().Be(plan.RootDirectory);
        provider.GetRequiredService<ArtifactBaseline>().RootDirectory.Should().Be(plan.RootDirectory);
    }
}
