using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Abstractions;

/// <summary>
/// Everything an assertion evaluator is allowed to look at.
/// </summary>
/// <remarks>
/// <para>
/// Deliberately narrow, and narrow by <i>construction</i> rather than by convention. An evaluator
/// sees the scenario's identifier, the <see cref="Scenarios.Grading"/> sub-record it owns, the
/// transcript, and — only for <see cref="AssertionCategory.BaselineComparison"/> — a baseline
/// transcript.
/// </para>
/// <para>
/// It does <b>not</b> see the <see cref="Scenario"/>. Handing over the whole scenario would hand
/// over <see cref="ScenarioKind"/>, <see cref="Execution"/>, <see cref="Selection"/> and
/// <see cref="Slicing"/> along with it, and an evaluator that can read the kind is one refactor
/// away from branching on it — at which point the engine is no longer kind-agnostic and the
/// claim that a REST call is the degenerate case of the same pipeline stops being true.
/// </para>
/// <para>
/// Everything an evaluator needs about <i>how</i> a turn was produced is already on the evidence:
/// <see cref="Turn.Provenance"/> says whether a stimulus was scripted, synthesized or live, and
/// it says so without naming a kind.
/// </para>
/// </remarks>
public sealed record EvaluationContext
{
    /// <summary>
    /// Gets the identifier of the scenario that was run, for naming it in
    /// <see cref="AssertionResult.Detail"/>.
    /// </summary>
    public required string ScenarioId { get; init; }

    /// <summary>Gets what a correct result looks like — the evaluators' own sub-record.</summary>
    public required Grading Grading { get; init; }

    /// <summary>Gets what happened during the run being judged.</summary>
    public required Transcript Transcript { get; init; }

    /// <summary>
    /// Gets the corresponding transcript from the baseline artifact, or null when there is no
    /// baseline. Only <see cref="AssertionCategory.BaselineComparison"/> evaluators may need it.
    /// </summary>
    public Transcript? Baseline { get; init; }
}

/// <summary>
/// Evaluates one category of assertion against a transcript.
/// </summary>
/// <remarks>
/// Assertions are data, so evaluators are few: one per category token, selected by
/// <see cref="Category"/>. Adding an assertion to a suite must not require adding a class here.
/// </remarks>
public interface IAssertionEvaluator
{
    /// <summary>
    /// Gets the category token this evaluator handles, matched against
    /// <see cref="AssertionSpec.Category"/>.
    /// </summary>
    string Category { get; }

    /// <summary>Gets the family this evaluator belongs to.</summary>
    AssertionCategory Family { get; }

    /// <summary>Evaluates one assertion.</summary>
    /// <param name="spec">The assertion to evaluate.</param>
    /// <param name="context">What the evaluator is allowed to look at.</param>
    /// <param name="cancellationToken">Cancels the evaluation.</param>
    /// <returns>The verdict, including the turns that were examined.</returns>
    ValueTask<AssertionResult> EvaluateAsync(
        AssertionSpec spec,
        EvaluationContext context,
        CancellationToken cancellationToken
    );
}
