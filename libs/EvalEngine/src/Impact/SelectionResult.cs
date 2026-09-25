using Forge.EvalEngine.Results;

namespace Forge.EvalEngine.Impact;

/// <summary>
/// Why a scenario was selected to run.
/// </summary>
/// <remarks>
/// <para>
/// A reason is an <b>output</b>, not an internal detail. "47 of 150 scenarios ran" is not a claim
/// a reviewer can check; "31 matched a changed file, 4 declare no mapping, 12 failed last run" is.
/// A selective run is only trustworthy if the reader can see what the selection was made of.
/// </para>
/// <para>
/// <see cref="Fallback"/> is first, and therefore the default, for the same reason
/// <see cref="Comparison.ScenarioOutcome.Absent"/> and
/// <see cref="Comparison.ScenarioClassification.NotComparable"/> are: a value nobody set must
/// read as "this ran because nothing could be established", never as "this ran because it
/// matched".
/// </para>
/// <para>
/// <b>Exactly one reason is reported per scenario — the first rule that selected it</b>, in the
/// order <see cref="ImpactSelector"/> applies them: <see cref="Fallback"/> (suite-wide), then the
/// declared mapping (<see cref="GlobMatch"/>, <see cref="NoGlobsDeclared"/>), then the safety net
/// (<see cref="PreviouslyFailing"/>, <see cref="New"/>). That ordering is what makes the counts
/// mean something: a scenario reported <see cref="PreviouslyFailing"/> is one the safety net
/// <i>rescued</i>, not one that would have run anyway. Reporting the net's reason ahead of a glob
/// match would inflate the rescue count and hide how much work the mapping is really doing.
/// </para>
/// </remarks>
public enum SelectionReason
{
    /// <summary>
    /// Selection could not be trusted at all, so the whole suite was selected.
    /// <see cref="SelectionResult.FallbackReason"/> says why.
    /// </summary>
    /// <remarks>
    /// Every scenario in the run carries this reason when it is used. That is deliberate: "150 of
    /// 150 — fallback" is unmistakable in a report, and cannot be misread as a mapping that
    /// happened to match everything.
    /// </remarks>
    Fallback,

    /// <summary>A changed file matched one of the scenario's declared impact globs.</summary>
    GlobMatch,

    /// <summary>
    /// The scenario declares no impact glob that could be interpreted, so nothing is known about
    /// which changes affect it.
    /// </summary>
    /// <remarks>
    /// This covers two states that are epistemically identical: the scenario declares no globs at
    /// all, or every glob it declares was rejected as uninterpretable — an unsupported construct,
    /// an absolute pattern, or a traversal. <see cref="ScenarioSelection.Detail"/> distinguishes
    /// them, and names the rejected pattern. Both mean the mapping is unknown, and an unknown
    /// mapping runs.
    /// </remarks>
    NoGlobsDeclared,

    /// <summary>
    /// The baseline records that this scenario did not pass, so it runs whatever the mapping
    /// said.
    /// </summary>
    /// <remarks>
    /// Without this rule a fix is never observed: the change that repairs a scenario is rarely
    /// the change that matches its globs, so the repaired scenario would sit out the very run
    /// that was supposed to show the repair. <see cref="Results.RunStatus.ExpectedFailure"/>
    /// counts here too — a known gap clearing is
    /// <see cref="Comparison.ComparisonResult.NewlyCovered"/>, which is the headline the harness
    /// exists to produce.
    /// </remarks>
    PreviouslyFailing,

    /// <summary>
    /// The baseline carries no trustworthy verdict for this scenario, so there is no evidence to
    /// skip it on.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The name is the common case; the meaning is broader, and every case it covers is the same
    /// state — <b>the baseline says nothing about this scenario</b>:
    /// </para>
    /// <list type="bullet">
    ///   <item><description>No baseline artifact was supplied at all.</description></item>
    ///   <item><description>The scenario is absent from the baseline — genuinely new.</description></item>
    ///   <item><description>
    ///     The baseline carries it but no run produced a verdict, so it is ungradeable. An
    ///     absence of recorded failure is not a record of passing.
    ///   </description></item>
    ///   <item><description>
    ///     The baseline's verdict was produced from a <i>different definition</i> of the
    ///     scenario — a different <see cref="Scenarios.ScenarioFingerprint"/>, or none recorded
    ///     at all. The id is a join key; it is not evidence that the two runs asked the same
    ///     question.
    ///   </description></item>
    ///   <item><description>
    ///     The baseline's own record of the scenario contradicts itself, so none of it can be
    ///     relied on.
    ///   </description></item>
    /// </list>
    /// <para>
    /// <see cref="ScenarioSelection.Detail"/> says which. They are one reason rather than five
    /// because the selector's only question is whether there is evidence to skip on, and in all
    /// five there is not.
    /// </para>
    /// </remarks>
    New,
}

/// <summary>
/// One scenario's place in a selected run, and why it has one.
/// </summary>
public sealed record ScenarioSelection
{
    /// <summary>Gets the scenario's identifier.</summary>
    public required string ScenarioId { get; init; }

    /// <summary>Gets the rule that selected the scenario.</summary>
    public required SelectionReason Reason { get; init; }

    /// <summary>
    /// Gets the caller-facing explanation of that reason — the glob and the changed file that
    /// matched, the pattern that was rejected, or what the baseline failed to establish.
    /// </summary>
    /// <remarks>
    /// Always text this library composed from its own inputs, in the manner of
    /// <see cref="Comparison.ScenarioComparison.NotComparableReason"/>. It is
    /// <see langword="null"/> for <see cref="SelectionReason.Fallback"/>, where the explanation is
    /// a property of the whole run rather than of any one scenario and is carried once on
    /// <see cref="SelectionResult.FallbackReason"/> instead of repeated against every entry.
    /// </remarks>
    public string? Detail { get; init; }
}

/// <summary>
/// Which scenarios a run should execute, and why each one earned its place.
/// </summary>
/// <remarks>
/// <para>
/// <b>Over-selecting costs time; under-selecting costs correctness.</b> A scenario that should
/// have run and did not produces no output at all — there is no wrong number in the report to
/// catch it, just silence and a green result. Every judgement in <see cref="ImpactSelector"/>
/// leans the same way because of that asymmetry, and this record is where the leaning is made
/// visible: <see cref="FallbackReason"/> and <see cref="ScenarioSelection.Detail"/> exist so that
/// a reader can tell a confident selection from a defensive one.
/// </para>
/// <para>
/// This is a computed work list rather than a committed artifact, so it carries no schema version
/// and no canonical-value equality. It holds collections, so the compiler-generated equality
/// compares those by <b>reference</b> — consume it by iterating, not by comparing.
/// </para>
/// </remarks>
public sealed record SelectionResult
{
    /// <summary>
    /// Gets the scenarios to run, in suite order, each with the rule that selected it.
    /// </summary>
    public IReadOnlyList<ScenarioSelection> Selected { get; init; } = [];

    /// <summary>
    /// Gets the identifiers of the scenarios that were not selected, in suite order.
    /// </summary>
    /// <remarks>
    /// A scenario reaches this list from one state only: its declared globs were all interpreted,
    /// none of them matched a changed file, and the baseline records a trustworthy pass for it.
    /// </remarks>
    public IReadOnlyList<string> Skipped { get; init; } = [];

    /// <summary>
    /// Gets why the whole suite was selected regardless of its mapping, or
    /// <see langword="null"/> when selection was actually performed.
    /// </summary>
    /// <remarks>
    /// The fallback is not a swallowed failure — it <i>is</i> this type's answer, reported to the
    /// caller that asked. That is why the selector takes no logger: a second signal for an
    /// outcome already carried in the return value would be the same event logged twice (§IV).
    /// </remarks>
    public string? FallbackReason { get; init; }

    /// <summary>
    /// Gets a value indicating whether the whole suite was selected because selection could not
    /// be trusted.
    /// </summary>
    public bool FellBackToFullSuite => FallbackReason is not null;

    /// <summary>
    /// Projects the decisions into the form a durable artifact records them in.
    /// </summary>
    /// <returns>
    /// One <see cref="RecordedSelection"/> for every scenario the selector was offered, ordered
    /// by identifier.
    /// </returns>
    /// <remarks>
    /// <para>
    /// Here rather than in the caller so that the journey from a decision to the artifact is made
    /// once. A consumer zipping <see cref="Selected"/> and <see cref="Skipped"/> back together
    /// itself would be re-deriving a fact this type already holds, which is the defect this
    /// record exists to close rather than to relocate.
    /// </para>
    /// <para>
    /// Only the decision travels. See <see cref="SuiteResult.SelectionDecisions"/> for why
    /// <see cref="ScenarioSelection.Reason"/> and <see cref="ScenarioSelection.Detail"/> stay
    /// behind.
    /// </para>
    /// </remarks>
    public IReadOnlyList<RecordedSelection> ToDecisions() =>
        [
            .. Selected
                .Select(entry => new RecordedSelection
                {
                    ScenarioId = entry.ScenarioId,
                    Decision = SelectionDecision.Selected,
                })
                .Concat(
                    Skipped.Select(id => new RecordedSelection
                    {
                        ScenarioId = id,
                        Decision = SelectionDecision.Skipped,
                    })
                )
                .OrderBy(entry => entry.ScenarioId, StringComparer.Ordinal),
        ];
}
