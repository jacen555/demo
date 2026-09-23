using Forge.EvalEngine.Abstractions;

namespace Forge.EvalEngine.Assertions.Evaluators;

/// <summary>
/// <c>exactMatch</c> — an observed outcome field equals the expectation the suite declared.
/// </summary>
/// <remarks>
/// <para>
/// The parameter names <i>which</i> field to compare; the value to compare against comes from
/// <see cref="Scenarios.Grading"/>. That is what collapses a family of per-field exact checks
/// into one evaluator plus a data row.
/// </para>
/// <list type="table">
/// <listheader><term>Expression</term><description>Meaning</description></listheader>
/// <item>
/// <term><c>exactMatch:outcome</c></term>
/// <description><see cref="Transcripts.Outcome.ObservedOutcome"/> equals <c>grading.expectedOutcome</c>.</description>
/// </item>
/// <item>
/// <term><c>exactMatch:path</c></term>
/// <description><see cref="Transcripts.Outcome.ObservedPath"/> equals <c>grading.expectedPath</c>.</description>
/// </item>
/// </list>
/// <para>
/// Comparison is ordinal. An expectation that was never declared is <b>refused</b>, not passed:
/// there is nothing to compare against, so any verdict would be invented.
/// </para>
/// </remarks>
internal sealed class ExactMatchEvaluator : IAssertionEvaluator
{
    private const string OutcomeSelector = "outcome";
    private const string PathSelector = "path";

    private static readonly string[] KnownSelectors = [OutcomeSelector, PathSelector];

    public string Category => "exactMatch";

    public AssertionCategory Family => AssertionCategory.ExactMatch;

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
        var outcome = context.Transcript.Outcome;

        var (observed, expected, field) = parameter.Selector switch
        {
            OutcomeSelector => (outcome.ObservedOutcome, context.Grading.ExpectedOutcome, "expectedOutcome"),
            PathSelector => (outcome.ObservedPath, context.Grading.ExpectedPath, "expectedPath"),
            _ => throw EvaluationSupport.UnknownSelector(spec, parameter, KnownSelectors),
        };

        EvaluationSupport.RequireNoOperand(spec, parameter);

        // Both selectors judge what the run ended holding, so a scope that stops short of the
        // turn the run ended on cannot judge either.
        EvaluationSupport.RequireOutcomeWithinScope(spec, context.Transcript);

        if (expected is null)
        {
            throw EvaluationSupport.Refuse(
                spec,
                $"grading.{field} was never declared, so there is nothing to match against. Declare it, or "
                    + "use the 'expectedBehavior' category to name the expected value in the assertion itself."
            );
        }

        var holds = string.Equals(observed, expected, StringComparison.Ordinal);

        return new ValueTask<AssertionResult>(
            EvaluationSupport.Verdict(
                spec,
                holds,
                $"grading.{field} declared {EvaluationSupport.Show(expected)}; the run observed "
                    + EvaluationSupport.Show(observed),
                EvaluationSupport.TurnTheRunEndedOn(context.Transcript)
            )
        );
    }
}
