using Forge.EvalCli.Cli;
using Forge.EvalCli.Diagnostics;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Comparison;
using Forge.EvalEngine.Coordination;
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
}
