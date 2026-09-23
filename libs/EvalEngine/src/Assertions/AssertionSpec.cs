using System.Diagnostics.CodeAnalysis;
using System.Text.Json.Serialization;
using Forge.EvalEngine.Serialization;

namespace Forge.EvalEngine.Assertions;

/// <summary>
/// The family an assertion evaluator belongs to.
/// </summary>
/// <remarks>
/// This is a taxonomy for reporting and for reasoning about what an evaluator needs, not the
/// dispatch key. Dispatch is by <see cref="AssertionSpec.Category"/>, which is an open token —
/// that is what keeps the engine from needing one class per assertion.
/// </remarks>
public enum AssertionCategory
{
    /// <summary>The observed value must equal an expected value exactly.</summary>
    ExactMatch,

    /// <summary>The shape of the returned structure must hold, independent of its values.</summary>
    Structural,

    /// <summary>Something must be present, or must be absent.</summary>
    PresenceAbsence,

    /// <summary>
    /// The result is judged against a recorded baseline rather than an absolute expectation.
    /// Requires <see cref="Abstractions.EvaluationContext.Baseline"/>.
    /// </summary>
    BaselineComparison,

    /// <summary>The system must have behaved a particular way, judged over the transcript.</summary>
    ExpectedBehavior,
}

/// <summary>
/// Whether an assertion expects its condition to hold or to fail.
/// </summary>
public enum AssertionPolarity
{
    /// <summary>The condition must hold. Written as a leading <c>+</c>.</summary>
    Positive,

    /// <summary>The condition must not hold. Written as a leading <c>!</c>.</summary>
    Negative,
}

/// <summary>
/// An assertion expressed as <b>data</b>, parsed from a <c>category:parameter</c> expression.
/// </summary>
/// <remarks>
/// <para>
/// The colon-suffix form is the generalization that keeps this library from growing one class per
/// assertion: <c>slotAbsent:scope/confirm</c>, <c>reachedDepth:4</c>,
/// <c>escalateReasonIs:out_of_scope</c>. The expression is split on the <b>first</b> colon only,
/// because a parameter may itself contain a <c>:</c> or a <c>/</c>.
/// </para>
/// <para>Grammar:</para>
/// <code>
/// expression := polarity? category ( ':' parameter )?
/// polarity   := '+' | '!'
/// category   := [A-Za-z] [A-Za-z0-9_.-]*
/// parameter  := any non-empty text, taken verbatim
/// </code>
/// <para>
/// Polarity is optional because many categories encode it in the name already
/// (<c>slotAbsent</c> against <c>slotPresent</c>). When no prefix is present,
/// <see cref="Polarity"/> is <see langword="null"/>, meaning "as the evaluator defines it".
/// </para>
/// </remarks>
[JsonConverter(typeof(AssertionSpecJsonConverter))]
public sealed record AssertionSpec
{
    private readonly int? _turnDependency;

    /// <summary>
    /// Gets the category token — the text before the first colon. This is the dispatch key that
    /// selects an <see cref="Abstractions.IAssertionEvaluator"/>.
    /// </summary>
    public required string Category { get; init; }

    /// <summary>
    /// Gets the text after the first colon, verbatim, or <see langword="null"/> when the
    /// expression had no parameter. It may contain further colons and slashes.
    /// </summary>
    public string? Parameter { get; init; }

    /// <summary>
    /// Gets the stated polarity, or <see langword="null"/> when the expression did not state one.
    /// </summary>
    public AssertionPolarity? Polarity { get; init; }

    /// <summary>
    /// Gets the one-based turn this assertion depends on, or <see langword="null"/> when it does
    /// not target a specific turn.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This is declared data rather than something inferred from the category token, so the core
    /// stays free of any one domain's vocabulary. In a suite file it comes from the object form
    /// of an assertion entry: <c>{ "expression": "reachedDepth:4", "turn": 4 }</c>.
    /// </para>
    /// <para>
    /// <see cref="Loading.SuiteLoader"/> uses it to enforce the script-overrun guard: an
    /// assertion that depends on a turn past the scripted budget measures the simulated caller,
    /// not the system under test. Leaving it unset is <b>not</b> a way around that guard — an
    /// assertion with no declared turn is read as depending on the last turn the run could reach,
    /// and is refused unless the scenario cannot reach past its script.
    /// </para>
    /// </remarks>
    /// <exception cref="ArgumentOutOfRangeException">The value is zero or negative.</exception>
    public int? TurnDependency
    {
        get => _turnDependency;
        init
        {
            if (value is <= 0)
            {
                throw new ArgumentOutOfRangeException(
                    nameof(value),
                    value,
                    "An assertion's turn dependency must be one or greater when specified."
                );
            }

            _turnDependency = value;
        }
    }

    /// <summary>Parses an assertion expression.</summary>
    /// <param name="expression">The expression, for example <c>slotAbsent:scope/confirm</c>.</param>
    /// <returns>The parsed specification.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="expression"/> is null.</exception>
    /// <exception cref="FormatException">The expression does not match the grammar.</exception>
    public static AssertionSpec Parse(string expression)
    {
        ArgumentNullException.ThrowIfNull(expression);

        return TryParse(expression, out var spec, out var error) ? spec : throw new FormatException(error);
    }

    /// <summary>Attempts to parse an assertion expression.</summary>
    /// <param name="expression">The expression to parse.</param>
    /// <param name="spec">The parsed specification, or null when parsing failed.</param>
    /// <param name="error">A caller-facing reason for the failure, or null on success.</param>
    /// <returns><see langword="true"/> when parsing succeeded.</returns>
    public static bool TryParse(
        string? expression,
        [NotNullWhen(true)] out AssertionSpec? spec,
        [NotNullWhen(false)] out string? error
    )
    {
        spec = null;

        if (string.IsNullOrWhiteSpace(expression))
        {
            error = "An assertion expression must not be empty.";
            return false;
        }

        var text = expression.Trim();
        AssertionPolarity? polarity = null;

        if (text[0] is '!' or '+')
        {
            polarity = text[0] == '!' ? AssertionPolarity.Negative : AssertionPolarity.Positive;
            text = text[1..];
        }

        var separator = text.IndexOf(':', StringComparison.Ordinal);
        var category = separator < 0 ? text : text[..separator];
        var parameter = separator < 0 ? null : text[(separator + 1)..];

        if (!IsValidCategory(category))
        {
            error =
                $"'{category}' is not a valid assertion category. A category must start with a letter and "
                + "contain only letters, digits, '_', '.' or '-'.";
            return false;
        }

        if (separator >= 0 && string.IsNullOrEmpty(parameter))
        {
            error = $"Assertion '{text}' ends with ':' but declares no parameter.";
            return false;
        }

        spec = new AssertionSpec
        {
            Category = category,
            Parameter = parameter,
            Polarity = polarity,
        };
        error = null;
        return true;
    }

    /// <summary>
    /// Renders this specification back to its expression form.
    /// </summary>
    /// <returns>
    /// The expression. Round-trips through <see cref="Parse(string)"/> exactly.
    /// <see cref="TurnDependency"/> is not part of the expression grammar and is carried
    /// separately.
    /// </returns>
    public string ToExpression()
    {
        var prefix = Polarity switch
        {
            AssertionPolarity.Negative => "!",
            AssertionPolarity.Positive => "+",
            _ => string.Empty,
        };

        return Parameter is null ? prefix + Category : $"{prefix}{Category}:{Parameter}";
    }

    private static bool IsValidCategory(string category)
    {
        if (category.Length == 0 || !char.IsAsciiLetter(category[0]))
        {
            return false;
        }

        foreach (var character in category)
        {
            if (!char.IsAsciiLetterOrDigit(character) && character is not ('_' or '.' or '-'))
            {
                return false;
            }
        }

        return true;
    }
}

/// <summary>
/// The verdict one assertion reached against one transcript.
/// </summary>
public sealed record AssertionResult
{
    /// <summary>Gets the assertion that was evaluated.</summary>
    public required AssertionSpec Spec { get; init; }

    /// <summary>Gets a value indicating whether the assertion held.</summary>
    public required bool Pass { get; init; }

    /// <summary>
    /// Gets the evidence for the verdict — what was expected, what was seen. Required reading for
    /// a failure to be actionable in a pull request comment.
    /// </summary>
    public string? Detail { get; init; }

    /// <summary>
    /// Gets the one-based indices of the turns the evaluator actually looked at.
    /// </summary>
    /// <remarks>
    /// Recorded so a reader can check the verdict against
    /// <see cref="Transcripts.Turn.Provenance"/> and see for themselves whether the assertion
    /// examined script-driven turns.
    /// </remarks>
    public IReadOnlyList<int> ExaminedTurns { get; init; } = [];
}
