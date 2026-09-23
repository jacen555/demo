using System.Globalization;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Assertions.Evaluators;

/// <summary>
/// <c>presence</c> — something is in the evidence, or is not.
/// </summary>
/// <remarks>
/// <para>
/// <b>Polarity carries the observed-versus-absent half of the claim</b>, which is what lets one
/// evaluator absorb what would otherwise be a matched pair of categories for every kind of thing
/// worth looking for. <c>presence:field/scope/confirm</c> asserts a field came back;
/// <c>!presence:field/scope/confirm</c> asserts it did not.
/// </para>
/// <list type="table">
/// <listheader><term>Expression</term><description>Meaning</description></listheader>
/// <item><term><c>presence:field/scope/confirm</c></term><description>That outcome field came back carrying a value.</description></item>
/// <item><term><c>presence:response/please confirm</c></term><description>Some response contains that token.</description></item>
/// <item><term><c>presence:stimulus/billing</c></term><description>Some stimulus contains that token.</description></item>
/// <item><term><c>presence:anyResponse</c></term><description>The system responded at least once.</description></item>
/// <item><term><c>presence:repeatedResponse</c></term><description>The system returned the same response twice.</description></item>
/// </list>
/// <para>
/// A field key that is present but carries <see langword="null"/> or blank counts as
/// <b>absent</b>. The system enumerated the key without filling it, and treating that as
/// "observed" is how a hollow result quietly passes a suite.
/// </para>
/// <para>
/// Matching is ordinal and case-sensitive, so a token means exactly what it says and no result
/// depends on the ambient culture. Field keys are matched ordinally <b>regardless of the comparer
/// the evidence carries</b> — a transcript assembled case-insensitively must not be able to turn
/// <c>field/Status</c> into a match on a field the system named <c>status</c>.
/// </para>
/// <para>
/// A scan reads only the turns in the assertion's declared scope
/// (<see cref="AssertionSpec.TurnDependency"/>), so an assertion pinned to a scripted turn cannot
/// pass on a token that appeared only after the script ran out. The outcome-derived
/// <c>field</c> selector cannot be narrowed that way at all, so it is refused when the declared
/// scope stops short of the turn the run ended on.
/// </para>
/// </remarks>
internal sealed class PresenceAbsenceEvaluator : IAssertionEvaluator
{
    private const string FieldSelector = "field";
    private const string ResponseSelector = "response";
    private const string StimulusSelector = "stimulus";
    private const string AnyResponseSelector = "anyResponse";
    private const string RepeatedResponseSelector = "repeatedResponse";

    private static readonly string[] KnownSelectors =
    [
        AnyResponseSelector,
        FieldSelector,
        RepeatedResponseSelector,
        ResponseSelector,
        StimulusSelector,
    ];

    public string Category => "presence";

    public AssertionCategory Family => AssertionCategory.PresenceAbsence;

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
        var scope = EvaluationSupport.TurnsInScope(spec, transcript);

        var result = parameter.Selector switch
        {
            FieldSelector => JudgeField(spec, parameter, transcript),
            ResponseSelector => JudgeToken(spec, parameter, scope, response: true),
            StimulusSelector => JudgeToken(spec, parameter, scope, response: false),
            AnyResponseSelector => JudgeAnyResponse(spec, parameter, scope),
            RepeatedResponseSelector => JudgeRepeatedResponse(spec, parameter, scope),
            _ => throw EvaluationSupport.UnknownSelector(spec, parameter, KnownSelectors),
        };

        return new ValueTask<AssertionResult>(result);
    }

    private static AssertionResult JudgeField(AssertionSpec spec, EvaluationParameter parameter, Transcript transcript)
    {
        var key = EvaluationSupport.RequireOperand(spec, parameter, "a field key");

        // The outcome is what the run ended holding, so a scope that stops short of the final
        // turn cannot judge it.
        EvaluationSupport.RequireOutcomeWithinScope(spec, transcript);

        var returned = EvaluationSupport.TryReadKey(transcript.Outcome.Fields, key, out var value);
        var holds = returned && !string.IsNullOrWhiteSpace(value);

        var evidence = returned
            ? $"outcome field '{key}' was returned holding {EvaluationSupport.Show(value)}"
            : $"outcome field '{key}' was not returned at all";

        return EvaluationSupport.Verdict(spec, holds, evidence, EvaluationSupport.TurnTheRunEndedOn(transcript));
    }

    private static AssertionResult JudgeToken(
        AssertionSpec spec,
        EvaluationParameter parameter,
        IReadOnlyList<Turn> scope,
        bool response
    )
    {
        var side = response ? "response" : "stimulus";
        var token = EvaluationSupport.RequireOperand(spec, parameter, $"a token to look for in each {side}");

        var matches = scope
            .Where(turn =>
                (response ? turn.Response : turn.Stimulus)?.Contains(token, StringComparison.Ordinal) == true
            )
            .Select(turn => turn.Index)
            .ToArray();

        return EvaluationSupport.Verdict(
            spec,
            matches.Length > 0,
            matches.Length > 0
                ? $"token '{token}' appears in the {side} of turn(s) {Describe(matches)}"
                : $"token '{token}' appears in no {side} across "
                    + $"{scope.Count.ToString(CultureInfo.InvariantCulture)} turn(s)",
            EvaluationSupport.TurnsThatSettledIt(scope, matches)
        );
    }

    private static AssertionResult JudgeAnyResponse(
        AssertionSpec spec,
        EvaluationParameter parameter,
        IReadOnlyList<Turn> scope
    )
    {
        EvaluationSupport.RequireNoOperand(spec, parameter);

        var matches = scope
            .Where(turn => !string.IsNullOrWhiteSpace(turn.Response))
            .Select(turn => turn.Index)
            .ToArray();

        return EvaluationSupport.Verdict(
            spec,
            matches.Length > 0,
            matches.Length > 0
                ? $"the system responded on turn(s) {Describe(matches)}"
                : $"the system returned nothing across "
                    + $"{scope.Count.ToString(CultureInfo.InvariantCulture)} turn(s)",
            EvaluationSupport.TurnsThatSettledIt(scope, matches)
        );
    }

    /// <summary>
    /// Whether the system under test returned the same response more than once.
    /// </summary>
    /// <remarks>
    /// Deliberately the <i>system's</i> side of the exchange. A repeated stimulus would be the
    /// simulated caller looping, and an assertion about the caller measures the harness rather
    /// than the thing under test.
    /// </remarks>
    private static AssertionResult JudgeRepeatedResponse(
        AssertionSpec spec,
        EvaluationParameter parameter,
        IReadOnlyList<Turn> scope
    )
    {
        EvaluationSupport.RequireNoOperand(spec, parameter);

        var matches = scope
            .Where(turn => !string.IsNullOrWhiteSpace(turn.Response))
            .GroupBy(turn => turn.Response!, StringComparer.Ordinal)
            .Where(group => group.Count() > 1)
            .SelectMany(group => group)
            .Select(turn => turn.Index)
            .Order()
            .ToArray();

        return EvaluationSupport.Verdict(
            spec,
            matches.Length > 0,
            matches.Length > 0
                ? $"the system repeated itself on turn(s) {Describe(matches)}"
                : "the system never returned the same response twice",
            EvaluationSupport.TurnsThatSettledIt(scope, matches)
        );
    }

    private static string Describe(IReadOnlyList<int> turns) =>
        string.Join(", ", turns.Select(turn => turn.ToString(CultureInfo.InvariantCulture)));
}
