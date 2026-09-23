using System.Globalization;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Assertions.Evaluators;

/// <summary>
/// <c>baseline</c> — the run is judged against the recorded run rather than against an absolute
/// expectation.
/// </summary>
/// <remarks>
/// <para>
/// The parameter names <b>what to compare</b>, not which baseline to compare against. Which
/// baseline is already settled upstream — an <see cref="IBaselineProvider"/> resolves the
/// reference recorded in <see cref="Results.EvaluationEnvironment.BaselineRef"/>, and hands the
/// matching transcript over as <see cref="EvaluationContext.Baseline"/>. Letting an assertion
/// name a different reference would create a second resolution path that bypasses that seam,
/// and would mean one suite run comparing against several baselines without saying so in its
/// artifact.
/// </para>
/// <list type="table">
/// <listheader><term>Expression</term><description>Meaning</description></listheader>
/// <item><term><c>baseline:outcome</c></term><description>The terminal outcome is unchanged.</description></item>
/// <item><term><c>baseline:path</c></term><description>The route taken is unchanged.</description></item>
/// <item><term><c>baseline:fields</c></term><description>Every returned field is unchanged.</description></item>
/// </list>
/// <para>
/// Negating it asserts a <i>deliberate</i> change: <c>!baseline:outcome</c> holds when the
/// outcome moved, which is how an intended fix is pinned so it cannot silently revert.
/// </para>
/// <para>
/// <b>A missing or mis-joined baseline is refused, not graded.</b> Passing would report "no
/// regression" on the strength of no evidence, and failing would report a regression against a
/// baseline that does not exist. Neither is true, so the assertion is un-evaluable and the run
/// is an error. A join has two sides, so <b>both</b> transcripts are checked against the scenario
/// being judged — a candidate from the wrong scenario tends to agree with the baseline by
/// coincidence, which reports "unchanged" about two unrelated runs.
/// </para>
/// </remarks>
internal sealed class BaselineComparisonEvaluator : IAssertionEvaluator
{
    private const string OutcomeSelector = "outcome";
    private const string PathSelector = "path";
    private const string FieldsSelector = "fields";

    private static readonly string[] KnownSelectors = [FieldsSelector, OutcomeSelector, PathSelector];

    public string Category => "baseline";

    public AssertionCategory Family => AssertionCategory.BaselineComparison;

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

        if (parameter.Selector is not (OutcomeSelector or PathSelector or FieldsSelector))
        {
            throw EvaluationSupport.UnknownSelector(spec, parameter, KnownSelectors);
        }

        EvaluationSupport.RequireNoOperand(spec, parameter);

        var candidate = context.Transcript;

        // Every selector here judges the outcome the run ended holding.
        EvaluationSupport.RequireOutcomeWithinScope(spec, candidate);

        var baseline = RequireJoinedTranscripts(spec, context);

        var (holds, evidence) = parameter.Selector switch
        {
            OutcomeSelector => CompareValue(
                "outcome",
                candidate.Outcome.ObservedOutcome,
                baseline.Outcome.ObservedOutcome
            ),
            PathSelector => CompareValue("route", candidate.Outcome.ObservedPath, baseline.Outcome.ObservedPath),
            _ => CompareFields(candidate.Outcome.Fields, baseline.Outcome.Fields),
        };

        return new ValueTask<AssertionResult>(
            EvaluationSupport.Verdict(spec, holds, evidence, EvaluationSupport.TurnTheRunEndedOn(candidate))
        );
    }

    /// <summary>
    /// The baseline transcript, once it is established that there is one and that <b>both</b>
    /// transcripts belong to the scenario being judged.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <see cref="Transcript.ScenarioId"/> is the join key between a baseline artifact and a
    /// candidate one, and a join has two sides. Validating only the baseline leaves the other
    /// half open: a candidate transcript carrying a different id was mis-joined just as wrongly,
    /// and because a mismatch there tends to <i>agree</i> with the baseline by coincidence — two
    /// unrelated runs that both ended "resolved" — the failure reports "no regression" rather
    /// than a difference. That is the worse direction for it to fail in.
    /// </para>
    /// <para>
    /// Both are therefore checked against <see cref="EvaluationContext.ScenarioId"/>, which names
    /// the run being judged, rather than against each other — two artifacts that agree with each
    /// other and not with the context are still the wrong pair.
    /// </para>
    /// </remarks>
    private static Transcript RequireJoinedTranscripts(AssertionSpec spec, EvaluationContext context)
    {
        if (context.Baseline is not { } baseline)
        {
            throw EvaluationSupport.Refuse(
                spec,
                "no baseline transcript was supplied for this run, so there is nothing to compare against. "
                    + "A scenario with no recorded baseline — a newly added one, for example — cannot be judged "
                    + "by this category; assert against an absolute expectation instead."
            );
        }

        RequireJoinedTo(spec, context.ScenarioId, context.Transcript.ScenarioId, "the transcript being judged");
        RequireJoinedTo(spec, context.ScenarioId, baseline.ScenarioId, "the supplied baseline");

        return baseline;
    }

    private static void RequireJoinedTo(AssertionSpec spec, string scenarioId, string observed, string what)
    {
        if (string.Equals(observed, scenarioId, StringComparison.Ordinal))
        {
            return;
        }

        throw EvaluationSupport.Refuse(
            spec,
            $"{what} belongs to scenario '{observed}' but this run is scenario '{scenarioId}'. The scenario id "
                + "is the join key against a baseline artifact, so comparing these would judge two unrelated runs "
                + "against each other."
        );
    }

    private static (bool Holds, string Evidence) CompareValue(string what, string? candidate, string? baseline) =>
        (
            string.Equals(candidate, baseline, StringComparison.Ordinal),
            $"the baseline recorded {what} {EvaluationSupport.Show(baseline)}; this run observed "
                + EvaluationSupport.Show(candidate)
        );

    private static (bool Holds, string Evidence) CompareFields(
        IReadOnlyDictionary<string, string?> candidateFields,
        IReadOnlyDictionary<string, string?> baselineFields
    )
    {
        // Both sides are re-keyed ordinally: the comparer a transcript happens to carry must not
        // decide whether a field was renamed or merely re-cased.
        var candidate = EvaluationSupport.KeyedOrdinally(candidateFields);
        var baseline = EvaluationSupport.KeyedOrdinally(baselineFields);

        var divergences = new List<string>();

        foreach (var (key, value) in baseline)
        {
            if (!candidate.TryGetValue(key, out var observed))
            {
                divergences.Add($"'{key}' was dropped");
            }
            else if (!string.Equals(observed, value, StringComparison.Ordinal))
            {
                divergences.Add(
                    $"'{key}' moved from {EvaluationSupport.Show(value)} to {EvaluationSupport.Show(observed)}"
                );
            }
        }

        foreach (var key in candidate.Keys.Where(key => !baseline.ContainsKey(key)))
        {
            divergences.Add($"'{key}' is new");
        }

        return (
            divergences.Count == 0,
            divergences.Count == 0
                ? $"all {baseline.Count.ToString(CultureInfo.InvariantCulture)} baseline field(s) are unchanged"
                : $"fields diverged from the baseline: {string.Join("; ", divergences.Order(StringComparer.Ordinal))}"
        );
    }
}
