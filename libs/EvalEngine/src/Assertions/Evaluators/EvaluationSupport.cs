using System.Globalization;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Assertions.Evaluators;

/// <summary>
/// The selector plus optional operand an evaluator reads out of an
/// <see cref="AssertionSpec.Parameter"/>.
/// </summary>
/// <remarks>
/// Split on the <b>first</b> <c>/</c>, mirroring the way an expression splits on its first
/// <c>:</c>. That is what lets an operand carry further slashes — a flattened field key such as
/// <c>scope/confirm</c>, or a route such as <c>triage/resolve</c> — without needing to be escaped.
/// </remarks>
internal readonly record struct EvaluationParameter(string Selector, string? Operand);

/// <summary>
/// Parameter parsing, turn attribution and verdict construction, shared by every evaluator.
/// </summary>
/// <remarks>
/// <para>
/// Two rules live here because getting them wrong in one evaluator and right in another is how
/// this library would rot:
/// </para>
/// <list type="bullet">
/// <item>
/// A parameter that cannot be read is <b>refused</b>, never graded. Grading it would either
/// invent a regression no system caused, or — far worse — quietly pass forever.
/// </item>
/// <item>
/// <see cref="AssertionResult.ExaminedTurns"/> reports the turns that actually determined the
/// verdict, so a reader can cross-reference <see cref="Turn.Provenance"/> and see whether an
/// assertion leaned on a turn the simulated caller invented.
/// </item>
/// <item>
/// An assertion's declared scope is <b>honoured</b>, not merely reported: a scan reads only the
/// turns in scope, and a claim the scope cannot reach is refused rather than widened.
/// </item>
/// <item>
/// Keys are matched <b>ordinally</b>, independently of the comparer the evidence arrived with,
/// so no verdict depends on how a transcript happened to be assembled.
/// </item>
/// </list>
/// </remarks>
internal static class EvaluationSupport
{
    /// <summary>Reads the parameter, refusing an assertion that omitted one.</summary>
    public static EvaluationParameter ReadParameter(AssertionSpec spec, params string[] knownSelectors)
    {
        if (spec.Parameter is not { } parameter)
        {
            throw Refuse(spec, $"it declares no parameter. Expected one of: {Describe(knownSelectors)}.");
        }

        var separator = parameter.IndexOf('/', StringComparison.Ordinal);

        return separator < 0
            ? new EvaluationParameter(parameter, null)
            : new EvaluationParameter(parameter[..separator], parameter[(separator + 1)..]);
    }

    /// <summary>Refuses a selector this evaluator does not implement.</summary>
    public static AssertionEvaluationException UnknownSelector(
        AssertionSpec spec,
        EvaluationParameter parameter,
        params string[] knownSelectors
    ) =>
        Refuse(
            spec,
            $"'{parameter.Selector}' is not a selector this category implements. Expected one of: "
                + $"{Describe(knownSelectors)}. Selectors are matched ordinally, so case must match exactly."
        );

    /// <summary>Requires a non-blank operand — a token, key, or route.</summary>
    public static string RequireOperand(AssertionSpec spec, EvaluationParameter parameter, string what)
    {
        if (string.IsNullOrWhiteSpace(parameter.Operand))
        {
            throw Refuse(
                spec,
                $"selector '{parameter.Selector}' needs {what}, written as '{parameter.Selector}/<value>'. "
                    + "A blank one would match everything, which is an assertion that can never fail."
            );
        }

        return parameter.Operand;
    }

    /// <summary>Requires a selector that takes no operand to have been written without one.</summary>
    public static void RequireNoOperand(AssertionSpec spec, EvaluationParameter parameter)
    {
        if (parameter.Operand is not null)
        {
            throw Refuse(
                spec,
                $"selector '{parameter.Selector}' takes no operand, but '{parameter.Operand}' was supplied. "
                    + "Ignoring it would hide a typo in a suite file."
            );
        }
    }

    /// <summary>Requires an operand of the form <c>key=value</c>, split on the first <c>=</c>.</summary>
    public static (string Key, string Value) RequireKeyAndValue(
        AssertionSpec spec,
        EvaluationParameter parameter,
        string what
    )
    {
        var operand = RequireOperand(spec, parameter, what);
        var separator = operand.IndexOf('=', StringComparison.Ordinal);

        if (separator < 0)
        {
            throw Refuse(
                spec,
                $"selector '{parameter.Selector}' needs {what}, written as '{parameter.Selector}/<key>=<value>'. "
                    + $"'{operand}' declares no expected value."
            );
        }

        var key = operand[..separator];
        var value = operand[(separator + 1)..];

        if (string.IsNullOrWhiteSpace(key))
        {
            throw Refuse(spec, $"selector '{parameter.Selector}' was given no key before its '='.");
        }

        if (string.IsNullOrEmpty(value))
        {
            throw Refuse(
                spec,
                $"selector '{parameter.Selector}' was given no expected value after '{key}='. Use the "
                    + "'presence' category to assert that something is merely absent."
            );
        }

        return (key, value);
    }

    /// <summary>
    /// Requires an operand that is a positive whole number, written in plain digits.
    /// </summary>
    /// <remarks>
    /// <see cref="NumberStyles.None"/> is deliberate: it refuses <c>+4</c>, <c>4.0</c>,
    /// <c>1e3</c> and leading whitespace rather than quietly accepting a depth the author did not
    /// write. Values too large for an <see cref="int"/> fail to parse and are refused too.
    /// </remarks>
    public static int RequireCount(AssertionSpec spec, EvaluationParameter parameter)
    {
        var operand = RequireOperand(spec, parameter, "a depth");

        if (!int.TryParse(operand, NumberStyles.None, CultureInfo.InvariantCulture, out var count) || count < 1)
        {
            throw Refuse(
                spec,
                $"'{operand}' is not a depth. It must be a whole number of one or greater, written in plain "
                    + "digits with no sign, decimal point or exponent."
            );
        }

        return count;
    }

    /// <summary>Requires a threshold that is a real, finite number.</summary>
    public static double RequireThreshold(AssertionSpec spec, EvaluationParameter parameter, string text)
    {
        if (!TryReadNumber(text, out var threshold))
        {
            throw Refuse(
                spec,
                $"'{text}' is not a usable threshold for selector '{parameter.Selector}'. It must be a finite "
                    + "number in invariant form — NaN and infinity cannot order anything."
            );
        }

        return threshold;
    }

    /// <summary>Reads an observed value as a finite number.</summary>
    /// <remarks>
    /// Failure here is the <i>system's</i> behaviour, not the author's mistake, so it returns
    /// false for the caller to grade rather than throwing.
    /// </remarks>
    public static bool TryReadNumber(string? text, out double value)
    {
        value = 0;

        return !string.IsNullOrWhiteSpace(text)
            && double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out value)
            && double.IsFinite(value);
    }

    /// <summary>Refuses an assertion as un-evaluable, naming it and the reason.</summary>
    public static AssertionEvaluationException Refuse(AssertionSpec spec, string reason) =>
        new($"Assertion '{spec.ToExpression()}' could not be evaluated: {reason}");

    /// <summary>
    /// The turns an assertion is allowed to look at, given the scope it declared.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <see cref="AssertionSpec.TurnDependency"/> is a <b>ceiling</b>, read exactly as
    /// <see cref="Loading.SuiteValidator"/> reads it: the furthest turn the assertion depends on.
    /// Turns at or before it are in scope; turns after it are not. An assertion that declares no
    /// turn depends on every turn the run reached, which is why leaving it unset is not a way
    /// around the guard — the loader refuses it instead, up front.
    /// </para>
    /// <para>
    /// Honouring the scope here is what gives that guard teeth. The loader can refuse a scenario
    /// whose assertions <i>could</i> land past the script, but a run that outlasts its script at
    /// execution time still produces synthesized turns, and an evaluator that scans all of them
    /// would let an assertion declared for scripted turn 2 pass on evidence from turn 3 — the
    /// precise false green the guard exists to prevent. Reporting that turn in
    /// <see cref="AssertionResult.ExaminedTurns"/> documents it; only narrowing the scan fixes it.
    /// </para>
    /// </remarks>
    public static IReadOnlyList<Turn> TurnsInScope(AssertionSpec spec, Transcript transcript) =>
        spec.TurnDependency is int declared
            ? transcript.Turns.Where(turn => turn.Index <= declared).ToArray()
            : transcript.Turns;

    /// <summary>
    /// Requires that a claim derived from run-level evidence can actually be judged from the
    /// scope the assertion declared.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A transcript carries exactly one <see cref="Outcome"/> — what the run finished holding —
    /// and one <see cref="TransportMetadata"/>, both attributed to the turn the run ended on.
    /// Neither holds a record of what it looked like earlier, so "the outcome as of turn 2" of a
    /// run that reached turn 3 is a question the evidence cannot answer for any system behaviour.
    /// </para>
    /// <para>
    /// That makes it <b>un-evaluable</b> rather than false, so it is refused rather than quietly
    /// widened to the final turn. Widening is the failure mode worth naming: the outcome of a run
    /// that outlasted its script was produced with the simulated caller's help, and grading a
    /// scoped assertion against it would report a confident verdict about the caller while the
    /// author believed they had narrowed the claim to scripted material.
    /// </para>
    /// </remarks>
    public static void RequireOutcomeWithinScope(AssertionSpec spec, Transcript transcript)
    {
        if (spec.TurnDependency is not int declared || transcript.Turns.Count == 0)
        {
            return;
        }

        // The outcome is attributed to the turn the run ended on — the same turn
        // TurnTheRunEndedOn reports — so that is the turn the scope has to cover.
        var ended = transcript.Turns[^1].Index;

        if (ended <= declared)
        {
            return;
        }

        throw Refuse(
            spec,
            $"it declares that it depends on turn {declared.ToString(CultureInfo.InvariantCulture)}, but the run "
                + $"continued to turn {ended.ToString(CultureInfo.InvariantCulture)}. This category judges the "
                + "outcome the run ended holding, and a transcript records no earlier version of it, so the "
                + "declared scope cannot be honoured. Widening the assertion to the final turn would judge an "
                + "outcome the simulated caller helped produce. Bound the run to its scripted budget — lower "
                + "terminalCondition.maxTurns, or leave terminalCondition.stopOnParticipantCompletion enabled — or "
                + "assert against the turns themselves."
        );
    }

    /// <summary>
    /// Looks a key up <b>ordinally</b>, whatever comparer the supplied map happens to carry.
    /// </summary>
    /// <remarks>
    /// Every category documents ordinal, case-sensitive matching. But a transcript is data that
    /// arrives from a runner, a deserializer or a baseline artifact, and an
    /// <see cref="IReadOnlyDictionary{TKey, TValue}"/> brings its comparer along with it. Calling
    /// <c>TryGetValue</c> would inherit that comparer, so a map assembled case-insensitively
    /// would make <c>field/Status</c> match a field the system actually named <c>status</c> — a
    /// verdict decided by how the evidence was built rather than by what the system did. The
    /// matching is enforced here rather than delegated to the evidence.
    /// </remarks>
    /// <typeparam name="TValue">The value type held in the map.</typeparam>
    /// <param name="values">The map to read, with whatever comparer it carries.</param>
    /// <param name="key">The key to match ordinally.</param>
    /// <param name="value">The value held under that key, or default when there is none.</param>
    /// <returns><see langword="true"/> when the map holds that exact key.</returns>
    public static bool TryReadKey<TValue>(IReadOnlyDictionary<string, TValue> values, string key, out TValue? value)
    {
        foreach (var (candidate, held) in values)
        {
            if (string.Equals(candidate, key, StringComparison.Ordinal))
            {
                value = held;
                return true;
            }
        }

        value = default;
        return false;
    }

    /// <summary>
    /// Re-keys a map ordinally, for a comparison that reads every key rather than one.
    /// </summary>
    /// <remarks>
    /// Re-keying can never collide: ordinal equality is finer than any comparer the source could
    /// have used, so two keys distinct there stay distinct here.
    /// </remarks>
    /// <typeparam name="TValue">The value type held in the map.</typeparam>
    /// <param name="values">The map to re-key.</param>
    /// <returns>The same entries, keyed ordinally.</returns>
    public static Dictionary<string, TValue> KeyedOrdinally<TValue>(IReadOnlyDictionary<string, TValue> values) =>
        new(values, StringComparer.Ordinal);

    /// <summary>
    /// The turns an outcome-derived assertion depends on: the one the run ended on.
    /// </summary>
    /// <remarks>
    /// An <see cref="Outcome"/> is what the run finished holding, so it is attributed to the final
    /// turn. That attribution is the point: if the run outlasted its script, the final turn is
    /// <see cref="TurnProvenance.Synthesized"/>, and reporting it lets a reader see that the
    /// verdict rested on a stimulus the simulated caller invented.
    /// </remarks>
    public static IReadOnlyList<int> TurnTheRunEndedOn(Transcript transcript) =>
        transcript.Turns.Count == 0 ? [] : [transcript.Turns[^1].Index];

    /// <summary>Every turn in scope, for a claim that could only be settled by reading all of them.</summary>
    public static IReadOnlyList<int> EveryTurn(IReadOnlyList<Turn> turns) =>
        turns.Count == 0 ? [] : turns.Select(turn => turn.Index).ToArray();

    /// <summary>
    /// The turns that settled a scan: the ones that matched, or — when nothing matched — every
    /// turn in scope, because establishing absence required reading all of them.
    /// </summary>
    public static IReadOnlyList<int> TurnsThatSettledIt(IReadOnlyList<Turn> turns, IReadOnlyList<int> matches) =>
        matches.Count > 0 ? matches : EveryTurn(turns);

    /// <summary>Builds the verdict, applying the assertion's polarity.</summary>
    /// <param name="spec">The assertion being judged.</param>
    /// <param name="conditionHolds">Whether the evaluator's condition held, before polarity.</param>
    /// <param name="evidence">What was expected and what was seen.</param>
    /// <param name="examinedTurns">The turns that determined the verdict.</param>
    /// <returns>The verdict.</returns>
    public static AssertionResult Verdict(
        AssertionSpec spec,
        bool conditionHolds,
        string evidence,
        IReadOnlyList<int> examinedTurns
    )
    {
        var negated = spec.Polarity == AssertionPolarity.Negative;
        var pass = negated ? !conditionHolds : conditionHolds;
        var requirement = negated ? "must not hold" : "must hold";

        return new AssertionResult
        {
            Spec = spec,
            Pass = pass,
            Detail =
                $"{spec.ToExpression()} ({requirement}): {evidence}. The condition "
                + $"{(conditionHolds ? "held" : "did not hold")}, so the assertion {(pass ? "passed" : "failed")}.",
            ExaminedTurns = examinedTurns,
        };
    }

    /// <summary>Renders a value for a caller-facing detail string.</summary>
    public static string Show(string? value) => value is null ? "nothing" : $"'{value}'";

    private static string Describe(IReadOnlyList<string> selectors) => string.Join(", ", selectors);
}
