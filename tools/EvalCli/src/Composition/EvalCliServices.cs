using Forge.EvalCli.Changes;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Diagnostics;
using Forge.EvalCli.Exchanges;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Baselines;
using Forge.EvalEngine.Comparison;
using Forge.EvalEngine.Coordination;
using Forge.EvalEngine.Loading;
using Forge.EvalEngine.Runners;
using Forge.EvalEngine.Statistics;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Forge.EvalCli.Composition;

/// <summary>
/// The composition root. Every seam the engine leaves open is closed here, once.
/// </summary>
/// <remarks>
/// <para>
/// The engine takes its clock, its seeds, its runners, its participants, its evaluators, its
/// significance test, and its logger by injection, and ships conservative defaults for none of the
/// consequential ones. That is deliberate: a library that cannot see where it is running should
/// not decide where its signals go, which credentials it holds, or how much load it puts on
/// somebody else's system. This file is where those decisions are actually made and where they can
/// be read in one place.
/// </para>
/// <para>
/// <b>Lifetimes here are load-bearing, not incidental.</b> Two registrations would fail at
/// runtime if they were shared: <see cref="ISeedSource"/> is not thread-safe and the engine asks
/// for one per suite run, and a participant must be fresh for every single run. Both are
/// registered accordingly, and the tests pin that.
/// </para>
/// </remarks>
internal static class EvalCliServices
{
    /// <summary>Builds the provider for one invocation.</summary>
    /// <param name="plan">The validated plan the registrations are configured from.</param>
    /// <param name="diagnostics">Where log records go. Standard error, so stdout stays composable.</param>
    /// <returns>The provider. The caller owns it and must dispose it.</returns>
    /// <exception cref="ArgumentNullException">Any argument is null.</exception>
    public static ServiceProvider Build(RunPlan plan, TextWriter diagnostics)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(diagnostics);

        var services = new ServiceCollection();

        services.AddLogging(builder =>
        {
            // The engine's own default is NullLogger. Replacing it is the whole point of being a
            // composition root; leaving it would mean a terminal failure inside a run had nowhere
            // to be reported except the artifact.
            builder.ClearProviders();
            builder.SetMinimumLevel(MinimumLevel(plan));
            builder.AddProvider(new StandardErrorLoggerProvider(diagnostics));
        });

        services.AddSingleton<IClock>(SystemClock.Instance);

        // Not thread-safe by contract, and the engine wants one per suite run. A singleton here
        // would make the seed a scenario was driven with depend on scheduling, which silently
        // breaks both reproducibility and the pairing a comparison rests on.
        services.AddTransient<ISeedSource>(_ => new DeterministicSeedSource(plan.RootSeed));

        services.AddSingleton(AssertionEvaluatorRegistry.CreateDefault());

        // The factory is stateless and shared; what it returns is not. See the type's remarks.
        services.AddSingleton<IParticipantFactory, DeterministicParticipantFactory>();

        services.AddSingleton<ISignificanceTest>(_ => new McNemarTest());
        services.AddSingleton<IMultipleComparisonCorrection>(BenjaminiHochbergCorrection.Instance);
        services.AddSingleton(plan.ToCoordinatorOptions());

        // Both are confined to the same root the arguments were validated against, so there is
        // one boundary per invocation rather than one per reader. Each canonicalizes that root
        // itself, through the engine's single implementation of what containment means.
        services.AddSingleton(_ => new SuiteLoader(plan.RootDirectory));
        services.AddSingleton(_ => new ArtifactBaseline(plan.RootDirectory));

        RegisterChangedFiles(services, plan);
        RegisterExchanges(services, plan);

        // The two kinds no runner in this build conducts. They report the gap cleanly rather than
        // letting a mixed suite fail to route, so registering them is not a placeholder.
        services.AddTransient<IScenarioRunner, NotImplementedMcpRunner>();
        services.AddTransient<IScenarioRunner, NotImplementedUiRunner>();

        // Constructed explicitly rather than by greediest-constructor discovery, so that the
        // overload carrying a real logger is the one that is definitely used.
        services.AddTransient(provider => new RunCoordinator(
            provider.GetServices<IScenarioRunner>(),
            provider.GetRequiredService<AssertionEvaluatorRegistry>(),
            provider.GetRequiredService<IParticipantFactory>(),
            provider.GetRequiredService<IClock>(),
            provider.GetRequiredService<ISeedSource>(),
            provider.GetRequiredService<RunCoordinatorOptions>(),
            provider.GetRequiredService<ILogger<RunCoordinator>>()
        ));

        services.AddTransient(provider => new SuiteComparator(
            provider.GetRequiredService<ISignificanceTest>(),
            provider.GetRequiredService<IMultipleComparisonCorrection>()
        ));

        return services.BuildServiceProvider(
            new ServiceProviderOptions { ValidateOnBuild = true, ValidateScopes = true }
        );
    }

    /// <summary>Chooses the log threshold for an invocation.</summary>
    /// <param name="plan">The validated plan.</param>
    /// <returns>Debug when verbose was asked for, warning otherwise.</returns>
    /// <remarks>
    /// Quiet by default and verbose on request, rather than the reverse: a tool that chatters
    /// trains its users to stop reading it, and the line they then miss is the one that mattered.
    /// </remarks>
    internal static LogLevel MinimumLevel(RunPlan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);

        return plan.Verbose ? LogLevel.Debug : LogLevel.Warning;
    }

    /// <summary>Registers where the changed-file set comes from.</summary>
    /// <remarks>
    /// Without <c>--changed-since</c> there is no source to ask, and that is registered as an
    /// explicit answer rather than left as a null nobody handles. Both implementations report the
    /// same thing when they have nothing: a reason, not an empty list — because "nothing changed"
    /// and "the set could not be read" select the same scenarios but mean opposite things, and
    /// only one of them should be quiet.
    /// </remarks>
    private static void RegisterChangedFiles(IServiceCollection services, RunPlan plan)
    {
        if (plan.ChangedSince is null)
        {
            services.AddSingleton<IChangedFileSource, FullSuiteChangedFileSource>();

            return;
        }

        services.AddSingleton<IChangedFileSource>(provider => new GitChangedFileSource(
            plan.RootDirectory,
            plan.ChangedSince,
            provider.GetRequiredService<ILogger<GitChangedFileSource>>()
        ));
    }

    /// <summary>Registers the runners whose transport the caller described.</summary>
    /// <remarks>
    /// <para>
    /// <b>A runner appears only when its adapter was named.</b> The engine will not guess the
    /// shape of a system it has never seen, and neither will this: an unselected kind is left
    /// without a runner, and the coordinator records that gap as a harness failure rather than as
    /// a pass. Registering a speculative adapter would convert "nobody told the harness what this
    /// system looks like" into "this system returned something unexpected", which is a finding
    /// about the wrong party.
    /// </para>
    /// <para>
    /// The <see cref="HttpClient"/> is a singleton owned by the container, so one handler serves
    /// the whole invocation and is disposed with the provider. Its base address is the only place
    /// the unredacted endpoint is held — everything printed or recorded takes the redacted form.
    /// </para>
    /// </remarks>
    private static void RegisterExchanges(IServiceCollection services, RunPlan plan)
    {
        if (!plan.RequiresEndpoint)
        {
            return;
        }

        services.AddSingleton(_ => new HttpClient { BaseAddress = plan.Endpoint });

        if (plan.RestExchange is ExchangeAdapter.Json)
        {
            services.AddSingleton<IRestExchange, JsonRestExchange>();
            services.AddTransient<IScenarioRunner>(provider => new RestRunner(
                provider.GetRequiredService<HttpClient>(),
                provider.GetRequiredService<IRestExchange>(),
                provider.GetRequiredService<IClock>()
            ));
        }

        if (plan.LlmExchange is ExchangeAdapter.Json)
        {
            services.AddSingleton<IConversationExchange>(provider => new JsonConversationExchange(
                provider.GetRequiredService<HttpClient>(),
                plan.EndpointDisplay
            ));
            services.AddTransient<IScenarioRunner>(provider => new LlmConversationRunner(
                provider.GetRequiredService<IConversationExchange>(),
                provider.GetRequiredService<IClock>()
            ));
        }
    }
}
