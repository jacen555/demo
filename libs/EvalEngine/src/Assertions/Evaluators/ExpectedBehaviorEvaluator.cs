using System.Globalization;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Assertions.Evaluators;

/// <summary>
/// <c>expectedBehavior</c> — the system behaved a named way, <b>including failing the way it was
/// supposed to</b>.
/// </summary>
/// <remarks>
/// <para>
/// This is the expected-failure category, and that is a first-class requirement rather than an
/// afterthought. A scenario whose entire point is "this request should be refused with 429", or
/// "this out-of-scope prompt should be declined", or "this malformed input should degrade
/// gracefully", is expressed here — and <b>passes</b> when the system does exactly that.
/// </para>
/// <list type="table">
/// <listheader><term>Expression</term><description>Meaning</description></listheader>
/// <item><term><c>expectedBehavior:transport/statusCode=429</c></term><description>The transport reported that status.</description></item>
/// <item><term><c>expectedBehavior:outcome/out_of_scope</c></term><description>The run ended on that outcome.</description></item>
/// <item><term><c>expectedBehavior:path/triage/refuse</c></term><description>The run took that route.</description></item>
/// <item><term><c>expectedBehavior:field/escalateReason=out_of_scope</c></term><description>That field carries that token.</description></item>
/// <item><term><c>expectedBehavior:fieldAtLeast/routeConfidence=0.4</c></term><description>That numeric field is at or above the threshold.</description></item>
/// </list>
/// <para>
/// Unlike <see cref="ExactMatchEvaluator"/>, the expected value is named <i>in the assertion</i>
/// rather than read from <see cref="Scenarios.Grading"/>. That is the distinction between the two
/// categories: exact-match asks "did it do what this scenario declared it should", and this asks
/// "did it do this specific named thing" — which a suite needs when the interesting behaviour is
/// a refusal that no <c>expectedOutcome</c> would sensibly describe.
/// </para>
/// <para>
/// A <i>conditional</i> expectation — "the route survives when it escalates" — is two data rows
/// in the same scenario, not a conditional evaluator. Two assertions are already a conjunction,
/// and giving the expression grammar a branch operator would start the slide back towards code.
/// </para>
/// </remarks>
internal sealed class ExpectedBehaviorEvaluator : IAssertionEvaluator
{
    private const string OutcomeSelector = "outcome";
    private const string PathSelector = "path";
    private const string FieldSelector = "field";
    private const string FieldAtLeastSelector = "fieldAtLeast";
    private const string TransportSelector = "transport";

    private static readonly string[] KnownSelectors =
    [
        FieldSelector,
        FieldAtLeastSelector,
        OutcomeSelector,
        PathSelector,
        TransportSelector,
    ];

    public string Category => "expectedBehavior";

    public AssertionCategory Family => AssertionCategory.ExpectedBehavior;

    public ValueTask<AssertionResult> EvaluateAsync(
        AssertionSpec spec,
        EvaluationContext context,
        CancellationToken cancellationToken
    )
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(spec);
        ArgumentNullException.ThrowIfNull(context);

        var parameter = EvaluationSupport.ReadParameter(spec, KnownSelectors);
        var transcript = context.Transcript;

        // Every selector here reads run-level evidence — the outcome the run ended holding, or
        // the transport it ended up using — so a scope stopping short of the final turn cannot
        // judge any of them.
        EvaluationSupport.RequireOutcomeWithinScope(spec, transcript);

        var (holds, evidence) = parameter.Selector switch
        {
            OutcomeSelector => JudgeValue(spec, parameter, "outcome", transcript.Outcome.ObservedOutcome),
            PathSelector => JudgeValue(spec, parameter, "route", transcript.Outcome.ObservedPath),
            FieldSelector => JudgeField(spec, parameter, transcript),
            FieldAtLeastSelector => JudgeThreshold(spec, parameter, transcript),
            TransportSelector => JudgeTransport(spec, parameter, transcript),
            _ => throw EvaluationSupport.UnknownSelector(spec, parameter, KnownSelectors),
        };

        return new ValueTask<AssertionResult>(
            EvaluationSupport.Verdict(spec, holds, evidence, EvaluationSupport.TurnTheRunEndedOn(transcript))
        );
    }

    private static (bool Holds, string Evidence) JudgeValue(
        AssertionSpec spec,
        EvaluationParameter parameter,
        string what,
        string? observed
    )
    {
        var expected = EvaluationSupport.RequireOperand(spec, parameter, $"the {what} to expect");

        return (
            string.Equals(observed, expected, StringComparison.Ordinal),
            $"the assertion expects {what} '{expected}'; the run observed {EvaluationSupport.Show(observed)}"
        );
    }

    private static (bool Holds, string Evidence) JudgeField(
        AssertionSpec spec,
        EvaluationParameter parameter,
        Transcript transcript
    )
    {
        var (key, expected) = EvaluationSupport.RequireKeyAndValue(spec, parameter, "a field and its expected value");
        var returned = EvaluationSupport.TryReadKey(transcript.Outcome.Fields, key, out var observed);

        return (
            returned && string.Equals(observed, expected, StringComparison.Ordinal),
            returned
                ? $"the assertion expects outcome field '{key}' to be '{expected}'; it held "
                    + EvaluationSupport.Show(observed)
                : $"the assertion expects outcome field '{key}' to be '{expected}'; it was not returned at all"
        );
    }

    private static (bool Holds, string Evidence) JudgeThreshold(
        AssertionSpec spec,
        EvaluationParameter parameter,
        Transcript transcript
    )
    {
        var (key, text) = EvaluationSupport.RequireKeyAndValue(spec, parameter, "a field and its minimum value");
        var threshold = EvaluationSupport.RequireThreshold(spec, parameter, text);

        EvaluationSupport.TryReadKey(transcript.Outcome.Fields, key, out var observed);

        // A field that is missing, blank, or not a finite number is the system's behaviour, not
        // the author's mistake — so it is graded as a failure rather than refused.
        if (!EvaluationSupport.TryReadNumber(observed, out var value))
        {
            return (
                false,
                $"the assertion expects outcome field '{key}' to be at least "
                    + $"{threshold.ToString(CultureInfo.InvariantCulture)}, but it held "
                    + $"{EvaluationSupport.Show(observed)}, which is not a finite number"
            );
        }

        return (
            value >= threshold,
            $"the assertion expects outcome field '{key}' to be at least "
                + $"{threshold.ToString(CultureInfo.InvariantCulture)}; it held "
                + value.ToString(CultureInfo.InvariantCulture)
        );
    }

    private static (bool Holds, string Evidence) JudgeTransport(
        AssertionSpec spec,
        EvaluationParameter parameter,
        Transcript transcript
    )
    {
        var (key, expected) = EvaluationSupport.RequireKeyAndValue(
            spec,
            parameter,
            "a transport attribute and its expected value"
        );
        var returned = EvaluationSupport.TryReadKey(transcript.Transport.Attributes, key, out var observed);

        return (
            returned && string.Equals(observed, expected, StringComparison.Ordinal),
            returned
                ? $"the assertion expects transport attribute '{key}' to be '{expected}'; it reported "
                    + EvaluationSupport.Show(observed)
                : $"the assertion expects transport attribute '{key}' to be '{expected}'; it was not reported at all"
        );
    }
}
