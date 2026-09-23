using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Tests.Assertions;

/// <summary>
/// Builders for the evidence an evaluator is allowed to see.
/// </summary>
/// <remarks>
/// Deliberately kind-free: these build a <see cref="Transcript"/> with N turns and nothing that
/// says whether N came from a REST call or a conversation, which is the property the evaluators
/// are supposed to preserve.
/// </remarks>
internal static class Evidence
{
    public const string ScenarioId = "scenario-a";

    public static Turn Turn(
        int index,
        string stimulus = "a stimulus",
        string? response = "a response",
        TurnProvenance provenance = TurnProvenance.Scripted
    ) =>
        new()
        {
            Index = index,
            Stimulus = stimulus,
            Response = response,
            Provenance = provenance,
            Elapsed = TimeSpan.FromMilliseconds(10),
        };

    public static Outcome Outcome(
        string? observedOutcome = "resolved",
        string? observedPath = "triage/resolve",
        IDictionary<string, string?>? fields = null
    ) =>
        new()
        {
            ObservedOutcome = observedOutcome,
            ObservedPath = observedPath,
            Fields = new Dictionary<string, string?>(
                fields ?? new Dictionary<string, string?>(StringComparer.Ordinal),
                StringComparer.Ordinal
            ),
        };

    public static Dictionary<string, string?> Fields(params (string Key, string? Value)[] entries)
    {
        var fields = new Dictionary<string, string?>(StringComparer.Ordinal);
        foreach (var (key, value) in entries)
        {
            fields[key] = value;
        }

        return fields;
    }

    /// <summary>
    /// An outcome whose field map keeps <b>the caller's</b> comparer rather than being re-keyed
    /// ordinally on the way in.
    /// </summary>
    /// <remarks>
    /// <see cref="Outcome(string?, string?, IDictionary{string, string?})"/> deliberately copies
    /// into an ordinal map, which is the shape a well-behaved runner produces. This builder exists
    /// to produce the shape a <i>badly</i>-behaved one produces — a transcript deserialized or
    /// assembled with a case-insensitive comparer — because whether that comparer can decide a
    /// verdict is precisely what is under test.
    /// </remarks>
    public static Outcome OutcomeKeyedBy(
        IEqualityComparer<string> comparer,
        string? observedOutcome = "resolved",
        string? observedPath = "triage/resolve",
        params (string Key, string? Value)[] entries
    )
    {
        var fields = new Dictionary<string, string?>(comparer);
        foreach (var (key, value) in entries)
        {
            fields[key] = value;
        }

        return new Outcome
        {
            ObservedOutcome = observedOutcome,
            ObservedPath = observedPath,
            Fields = fields,
        };
    }

    /// <summary>Transport metadata whose attribute map keeps the caller's comparer.</summary>
    public static TransportMetadata TransportKeyedBy(
        IEqualityComparer<string> comparer,
        params (string Key, string Value)[] attributes
    )
    {
        var values = new Dictionary<string, string>(comparer);
        foreach (var (key, value) in attributes)
        {
            values[key] = value;
        }

        return new TransportMetadata
        {
            Kind = "http",
            Endpoint = "https://localhost:5001/eval",
            Attributes = values,
        };
    }

    public static TransportMetadata Transport(params (string Key, string Value)[] attributes)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (key, value) in attributes)
        {
            values[key] = value;
        }

        return new TransportMetadata
        {
            Kind = "http",
            Endpoint = "https://localhost:5001/eval",
            Attributes = values,
        };
    }

    public static Transcript Transcript(
        Outcome? outcome = null,
        IReadOnlyList<Turn>? turns = null,
        TransportMetadata? transport = null,
        string scenarioId = ScenarioId
    ) =>
        new()
        {
            ScenarioId = scenarioId,
            Seed = 4242,
            StartedAt = TestData.FixedInstant,
            Duration = TimeSpan.FromMilliseconds(120),
            Turns = turns ?? [Turn(1)],
            Outcome = outcome ?? Outcome(),
            Transport = transport ?? Transport(),
        };

    /// <summary>A one-turn transcript — the degenerate REST case of the same pipeline.</summary>
    public static Transcript OneTurn(Outcome? outcome = null) => Transcript(outcome, [Turn(1)]);

    /// <summary>An N-turn transcript whose final turn was invented by the simulated caller.</summary>
    public static Transcript EndingOnSynthesizedTurn(Outcome? outcome = null) =>
        Transcript(
            outcome,
            [Turn(1), Turn(2), Turn(3, stimulus: "invented follow-up", provenance: TurnProvenance.Synthesized)]
        );

    public static EvaluationContext Context(
        Transcript? transcript = null,
        Grading? grading = null,
        Transcript? baseline = null,
        string scenarioId = ScenarioId
    ) =>
        new()
        {
            ScenarioId = scenarioId,
            Grading = grading ?? new Grading(),
            Transcript = transcript ?? Transcript(),
            Baseline = baseline,
        };

    /// <summary>
    /// Evaluates an assertion the way the pipeline will — through the registry, by category.
    /// </summary>
    /// <param name="expression">The assertion expression.</param>
    /// <param name="context">The evidence the evaluator may look at.</param>
    /// <param name="turn">
    /// The turn the assertion declares it depends on, or null when it declares none. This is
    /// carried beside the expression rather than inside it, exactly as a suite file carries it.
    /// </param>
    public static ValueTask<AssertionResult> Evaluate(string expression, EvaluationContext context, int? turn = null) =>
        AssertionEvaluatorRegistry
            .CreateDefault()
            .EvaluateAsync(Spec(expression, turn), context, CancellationToken.None);

    /// <summary>Parses an expression, attaching a declared turn dependency when one is given.</summary>
    public static AssertionSpec Spec(string expression, int? turn = null)
    {
        var spec = AssertionSpec.Parse(expression);

        return turn is int declared ? spec with { TurnDependency = declared } : spec;
    }

    /// <summary>Asserts that an expression is refused as un-evaluable rather than graded.</summary>
    public static async Task<AssertionEvaluationException> Refuses(
        string expression,
        EvaluationContext context,
        int? turn = null
    )
    {
        try
        {
            var result = await Evaluate(expression, context, turn);
            throw new Xunit.Sdk.XunitException(
                $"'{expression}' was graded (pass: {result.Pass}) instead of being refused as un-evaluable."
            );
        }
        catch (AssertionEvaluationException exception)
        {
            return exception;
        }
    }
}
