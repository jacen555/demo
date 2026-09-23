using System.Diagnostics.CodeAnalysis;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Assertions.Evaluators;

namespace Forge.EvalEngine.Assertions;

/// <summary>
/// Dispatches an <see cref="AssertionSpec"/> to the evaluator registered for its
/// <see cref="AssertionSpec.Category"/>.
/// </summary>
/// <remarks>
/// <para>
/// There is exactly one evaluator per category, and a category is an open token rather than a
/// closed enum. That is what keeps a new assertion a <b>new row of data in a suite file</b>
/// rather than a new class here: <c>presence:field/scope/confirm</c> and
/// <c>presence:response/please confirm</c> are two rows served by one evaluator.
/// </para>
/// <para>
/// <b>An unknown category is refused, never passed over.</b> Silently skipping an assertion whose
/// category nobody implements turns a typo into a permanently green check, which is strictly
/// worse than a permanently red one: the red one gets fixed.
/// </para>
/// <para>
/// Lookup is ordinal and case-sensitive, matching every other keyed collection in this library
/// (<see cref="Transcripts.Outcome.Fields"/>, <see cref="Scenarios.Slicing.Tags"/>).
/// <c>ExactMatch</c> is therefore not a spelling of <c>exactMatch</c> — it is an unknown
/// category, and is reported as one.
/// </para>
/// </remarks>
public sealed class AssertionEvaluatorRegistry
{
    private readonly Dictionary<string, IAssertionEvaluator> _evaluators;

    /// <summary>
    /// Initializes a new instance of the <see cref="AssertionEvaluatorRegistry"/> class.
    /// </summary>
    /// <param name="evaluators">
    /// The evaluators to register, each under its own <see cref="IAssertionEvaluator.Category"/>.
    /// </param>
    /// <exception cref="ArgumentNullException"><paramref name="evaluators"/> is null.</exception>
    /// <exception cref="ArgumentException">
    /// An evaluator is null, declares a blank category, or two evaluators declare the same
    /// category. A silently-dropped duplicate would make which evaluator runs depend on
    /// registration order.
    /// </exception>
    public AssertionEvaluatorRegistry(IEnumerable<IAssertionEvaluator> evaluators)
    {
        ArgumentNullException.ThrowIfNull(evaluators);

        _evaluators = new Dictionary<string, IAssertionEvaluator>(StringComparer.Ordinal);

        foreach (var evaluator in evaluators)
        {
            if (evaluator is null)
            {
                throw new ArgumentException("An assertion evaluator must not be null.", nameof(evaluators));
            }

            if (string.IsNullOrWhiteSpace(evaluator.Category))
            {
                throw new ArgumentException(
                    $"Evaluator '{evaluator.GetType().Name}' declares no category, so nothing could ever "
                        + "dispatch to it.",
                    nameof(evaluators)
                );
            }

            if (!_evaluators.TryAdd(evaluator.Category, evaluator))
            {
                throw new ArgumentException(
                    $"More than one evaluator declares category '{evaluator.Category}'. Which one ran would "
                        + "depend on registration order, so the ambiguity is refused rather than resolved.",
                    nameof(evaluators)
                );
            }
        }

        Categories = [.. _evaluators.Keys.Order(StringComparer.Ordinal)];
    }

    /// <summary>Gets the registered category tokens, ordered ordinally.</summary>
    public IReadOnlyList<string> Categories { get; }

    /// <summary>Creates a registry holding the evaluator for every built-in category.</summary>
    /// <returns>The default registry.</returns>
    public static AssertionEvaluatorRegistry CreateDefault() =>
        new([
            new ExactMatchEvaluator(),
            new StructuralEvaluator(),
            new PresenceAbsenceEvaluator(),
            new BaselineComparisonEvaluator(),
            new ExpectedBehaviorEvaluator(),
        ]);

    /// <summary>Attempts to find the evaluator registered for a category.</summary>
    /// <param name="category">The category token to look up.</param>
    /// <param name="evaluator">The evaluator, or null when the category is not registered.</param>
    /// <returns><see langword="true"/> when the category is registered.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="category"/> is null.</exception>
    public bool TryGetEvaluator(string category, [NotNullWhen(true)] out IAssertionEvaluator? evaluator)
    {
        ArgumentNullException.ThrowIfNull(category);

        return _evaluators.TryGetValue(category, out evaluator);
    }

    /// <summary>Evaluates one assertion using the evaluator registered for its category.</summary>
    /// <param name="spec">The assertion to evaluate.</param>
    /// <param name="context">What the evaluator is allowed to look at.</param>
    /// <param name="cancellationToken">Cancels the evaluation.</param>
    /// <returns>The verdict, including the turns that were examined.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="spec"/> or <paramref name="context"/> is null.</exception>
    /// <exception cref="AssertionEvaluationException">
    /// No evaluator is registered for the assertion's category, or the assertion could not be
    /// evaluated.
    /// </exception>
    /// <exception cref="OperationCanceledException"><paramref name="cancellationToken"/> was cancelled.</exception>
    public ValueTask<AssertionResult> EvaluateAsync(
        AssertionSpec spec,
        EvaluationContext context,
        CancellationToken cancellationToken
    )
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(spec);
        ArgumentNullException.ThrowIfNull(context);

        if (!_evaluators.TryGetValue(spec.Category, out var evaluator))
        {
            throw new AssertionEvaluationException(
                $"Assertion '{spec.ToExpression()}' names category '{spec.Category}', which no evaluator "
                    + $"implements. Known categories are: {string.Join(", ", Categories)}. Categories are matched "
                    + "ordinally, so case must match exactly. The assertion is refused rather than skipped, "
                    + "because an assertion that is silently skipped passes forever."
            );
        }

        return evaluator.EvaluateAsync(spec, context, cancellationToken);
    }
}
