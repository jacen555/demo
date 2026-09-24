using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Scenarios;
using Microsoft.Extensions.DependencyInjection;

namespace Forge.EvalCli.Composition;

/// <summary>One scenario kind and the runner, if any, that would conduct it.</summary>
/// <param name="Kind">The scenario kind.</param>
/// <param name="Runner">The registered runner's type name, or <see langword="null"/> when none is wired.</param>
/// <param name="Wired">Whether a runner is registered for this kind.</param>
/// <param name="Note">What a reader should understand about it, in one line.</param>
internal sealed record RunnerDescription(string Kind, string? Runner, bool Wired, string Note);

/// <summary>
/// What the composition root actually wired, read back out of the container.
/// </summary>
/// <remarks>
/// <para>
/// Derived from the provider rather than restated by hand, so a dry run cannot describe a harness
/// that differs from the one that would run. A plan that is written down separately from the
/// wiring is a plan that drifts from it.
/// </para>
/// <para>
/// <b>An unwired kind is reported, never omitted.</b> Leaving it out would let a reader conclude
/// the suite is fully covered when two of its four kinds have no transport at all.
/// </para>
/// </remarks>
internal sealed record HarnessDescription
{
    /// <summary>Gets one entry per scenario kind, in declaration order.</summary>
    public required IReadOnlyList<RunnerDescription> Runners { get; init; }

    /// <summary>Gets the registered participant factory's type name.</summary>
    public required string ParticipantFactory { get; init; }

    /// <summary>Gets the assertion categories the registry can evaluate.</summary>
    public required IReadOnlyList<string> AssertionCategories { get; init; }

    /// <summary>Gets the registered significance test.</summary>
    public required string SignificanceTest { get; init; }

    /// <summary>Gets the registered multiple-comparison correction.</summary>
    public required string MultipleComparisonCorrection { get; init; }

    /// <summary>Gets the registered clock's type name.</summary>
    public required string Clock { get; init; }

    /// <summary>Reads the wiring back out of a built provider.</summary>
    /// <param name="provider">The provider built by <see cref="EvalCliServices"/>.</param>
    /// <returns>The description.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="provider"/> is null.</exception>
    public static HarnessDescription Describe(IServiceProvider provider)
    {
        ArgumentNullException.ThrowIfNull(provider);

        var registered = provider
            .GetServices<IScenarioRunner>()
            .ToDictionary(runner => runner.Kind, runner => runner.GetType().Name);

        var runners = Enum.GetValues<ScenarioKind>()
            .Select(kind =>
                registered.TryGetValue(kind, out var runner)
                    ? new RunnerDescription(kind.ToString(), runner, true, RunnerNote(kind))
                    : new RunnerDescription(kind.ToString(), null, false, UnwiredNote(kind))
            )
            .ToArray();

        return new HarnessDescription
        {
            Runners = runners,
            ParticipantFactory = provider.GetRequiredService<IParticipantFactory>().GetType().Name,
            AssertionCategories = provider.GetRequiredService<AssertionEvaluatorRegistry>().Categories,
            SignificanceTest = provider.GetRequiredService<ISignificanceTest>().Kind.ToString(),
            MultipleComparisonCorrection = provider.GetRequiredService<IMultipleComparisonCorrection>().Name,
            Clock = provider.GetRequiredService<IClock>().GetType().Name,
        };
    }

    private static string RunnerNote(ScenarioKind kind) =>
        kind switch
        {
            ScenarioKind.Mcp or ScenarioKind.Ui =>
                "the engine's stub - it records the gap as a harness failure rather than a pass",
            _ => "registered",
        };

    private static string UnwiredNote(ScenarioKind kind) =>
        kind switch
        {
            ScenarioKind.Rest =>
                "no runner registered - needs an IRestExchange, which is a property of the system under test",
            ScenarioKind.Llm =>
                "no runner registered - needs an IConversationExchange, which is a property of the system under test",
            _ => "no runner registered",
        };
}
