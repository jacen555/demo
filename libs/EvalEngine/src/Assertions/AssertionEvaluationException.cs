namespace Forge.EvalEngine.Assertions;

/// <summary>
/// Thrown when an assertion cannot be evaluated at all, as opposed to evaluating to a failure.
/// </summary>
/// <remarks>
/// <para>
/// The distinction this type draws is deliberate and load-bearing. An assertion that does not
/// hold is a statement about the <i>system under test</i> and belongs in
/// <see cref="AssertionResult.Pass"/>. An assertion that names a category nothing implements,
/// omits a parameter it requires, or compares against an expectation the suite never declared is
/// a statement about the <i>suite</i> — nothing was measured, so reporting "did not hold" would
/// invent a regression that no system caused.
/// </para>
/// <para>
/// <see cref="Results.RunStatus"/> already draws exactly this line:
/// <see cref="Results.RunStatus.Fail"/> is "the run completed and an assertion did not hold",
/// while <see cref="Results.RunStatus.Error"/> is "configuration or harness failure". A caller
/// catches this and records the run as <see cref="Results.RunStatus.Error"/> with
/// <see cref="Results.RunResult.ErrorDetail"/> set, which keeps an un-evaluable assertion loud
/// instead of letting it pass silently.
/// </para>
/// </remarks>
public sealed class AssertionEvaluationException : Exception
{
    /// <summary>Initializes a new instance of the <see cref="AssertionEvaluationException"/> class.</summary>
    public AssertionEvaluationException()
        : base("An assertion could not be evaluated.") { }

    /// <summary>Initializes a new instance of the <see cref="AssertionEvaluationException"/> class.</summary>
    /// <param name="message">The caller-facing reason the assertion could not be evaluated.</param>
    public AssertionEvaluationException(string message)
        : base(message) { }

    /// <summary>Initializes a new instance of the <see cref="AssertionEvaluationException"/> class.</summary>
    /// <param name="message">The caller-facing reason the assertion could not be evaluated.</param>
    /// <param name="innerException">The underlying failure.</param>
    public AssertionEvaluationException(string message, Exception innerException)
        : base(message, innerException) { }
}
