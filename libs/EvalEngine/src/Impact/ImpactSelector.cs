using System.Globalization;
using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Paths;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Runners;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Serialization;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Impact;

/// <summary>
/// Chooses which scenarios a run should execute, from the impact globs the scenarios declare and
/// the set of files a change touched.
/// </summary>
/// <remarks>
/// <para>
/// <b>Pure.</b> No git, no file system, no clock, no I/O of any kind. The changed-file set is
/// acquired by the caller and handed in, which is what keeps diff parsing out of a Tier 1 library
/// and what makes every rule below testable against a literal list of strings.
/// </para>
/// <para>
/// <b>The bias is deliberate and it is not symmetric.</b> Over-selecting costs time.
/// Under-selecting costs correctness, and costs it invisibly: a scenario that should have run and
/// did not produces no output at all, so there is no wrong number in the report to catch it — only
/// silence and a green result. Classical test-impact analysis does not transfer cleanly to
/// multi-service evaluation topologies, so this falls back to the full suite far more readily than
/// such tooling normally does. <b>Selection must never be the reason a regression goes
/// unobserved.</b>
/// </para>
/// <para>
/// <b>The rules, in the order they are applied.</b> A scenario is reported under the first one
/// that selects it:
/// </para>
/// <list type="number">
///   <item><description>
///     <b>Suite-wide fallback</b> (<see cref="SelectionReason.Fallback"/>). No changed files, a
///     changed path that is not repo-relative, a baseline belonging to another suite, or a
///     baseline that files two results under one id. Any of these makes every verdict below
///     meaningless, so the whole suite runs and
///     <see cref="SelectionResult.FallbackReason"/> says which.
///   </description></item>
///   <item><description>
///     <b>The declared mapping</b> (<see cref="SelectionReason.GlobMatch"/>,
///     <see cref="SelectionReason.NoGlobsDeclared"/>). A changed file matched a glob, or the
///     scenario declares no glob this matcher can interpret — an unknown mapping runs.
///   </description></item>
///   <item><description>
///     <b>The safety net</b> (<see cref="SelectionReason.PreviouslyFailing"/>,
///     <see cref="SelectionReason.New"/>). The baseline records the scenario as not passing, or
///     records no trustworthy verdict for it at all.
///   </description></item>
/// </list>
/// <para>
/// A scenario is skipped from one state only: every declared glob interpreted, none matched, and
/// a baseline that records a trustworthy pass.
/// </para>
/// <para>
/// <b>What "trustworthy" costs.</b> A scenario id is a join key; it is not evidence that the
/// baseline and the suite mean the same thing by it, nor that the verdict filed under it was
/// completely gathered. So a recorded pass is believed only when <b>all</b> of the following
/// hold:
/// </para>
/// <list type="bullet">
///   <item><description>
///     the baseline ran the scenario against the same <see cref="ScenarioKind"/> the suite now
///     declares — the kind selects the runner, so a verdict from another one is a verdict about
///     another system, and it is checked here rather than through the fingerprint because
///     <see cref="ScenarioFingerprint"/> deliberately does not cover it;
///   </description></item>
///   <item><description>
///     the baseline's <see cref="ScenarioFingerprint"/> is the fingerprint of the definition the
///     suite now declares;
///   </description></item>
///   <item><description>
///     it recorded as many runs as the repetition policy it applied — a record missing a
///     repetition cannot say what that repetition did;
///   </description></item>
///   <item><description>its runs are filed under the scenario they claim;</description></item>
///   <item><description>
///     every run carrying a verdict records an exchange that actually gathered evidence — a
///     verdict about a system that was never successfully asked is not a verdict, and a pass
///     recorded that way is indistinguishable from a run that never happened;
///   </description></item>
///   <item><description>
///     no run is recorded as a pass beside an assertion verdict that did not hold, or without a
///     verdict for an assertion the suite declares.
///   </description></item>
/// </list>
/// <para>
/// Anything less is <see cref="SelectionReason.New"/> — no verdict, nothing to skip on. This is
/// the same refusal <see cref="Comparison.SuiteComparator"/> makes one stage later, made here
/// because a scenario wrongly retired at this stage never reaches that one.
/// </para>
/// <para>
/// The seed-reuse check the comparator also makes is deliberately <i>not</i> repeated here:
/// repetitions sharing a seed corrupt a paired significance test, but they do not change whether
/// a scenario passed, and over-selecting on a harmless condition spends the fallback's
/// credibility for nothing.
/// </para>
/// <para>
/// Glob syntax, path normalization, and the case-sensitivity choice are documented on
/// <see cref="ImpactGlob"/> and <see cref="ChangedPath"/>.
/// </para>
/// <para>
/// This type is static because it is a pure function of its arguments: it holds no state, reaches
/// nothing ambient, and has nothing a composition root could usefully substitute — the same shape
/// as <see cref="ScenarioFingerprint"/>.
/// </para>
/// </remarks>
public static class ImpactSelector
{
    /// <summary>Selects the scenarios a run should execute.</summary>
    /// <param name="suite">The suite being run.</param>
    /// <param name="changedFiles">
    /// The repo-relative paths the change touched, in any order. Mixed separators, a leading
    /// <c>./</c>, and interior <c>..</c> segments are all normalized; an entry that cannot be
    /// made repo-relative, or that still carries its producer's quoting — <c>git diff
    /// --name-only</c> C-quotes a path containing a non-ASCII byte, a quote, or a control
    /// character — selects the whole suite rather than being dropped or matched as written.
    /// </param>
    /// <param name="baseline">
    /// The previous run's artifact, or <see langword="null"/> when there is none. Supplying none
    /// is not an error — it means nothing can be skipped, so everything runs.
    /// </param>
    /// <returns>The scenarios to run, each with the rule that selected it.</returns>
    /// <exception cref="ArgumentNullException">
    /// <paramref name="suite"/> or <paramref name="changedFiles"/> is null.
    /// </exception>
    /// <exception cref="ArgumentException">
    /// <paramref name="suite"/> carries a null scenario or a scenario with no identity. That is a
    /// malformed argument rather than untrustworthy data, and it is raised rather than absorbed
    /// into a fallback: running more scenarios cannot repair a suite that cannot be read.
    /// </exception>
    public static SelectionResult Select(Suite suite, IEnumerable<string> changedFiles, SuiteResult? baseline = null)
    {
        ArgumentNullException.ThrowIfNull(suite);
        ArgumentNullException.ThrowIfNull(changedFiles);

        var scenarios = suite.Scenarios;

        foreach (var scenario in scenarios)
        {
            if (scenario?.Identity?.Id is null)
            {
                throw new ArgumentException(
                    "A suite scenario, its identity, or its id is null, so there is nothing to select or to "
                        + "report it under.",
                    nameof(suite)
                );
            }
        }

        var doubt = Normalize(changedFiles, out var changed);
        Dictionary<string, ScenarioResult>? recorded = null;

        // Every finding this stage composes names a scenario id or the suite's name, and both the
        // suite and the baseline can arrive built in process — reaching neither SuiteLoader's
        // guard nor the artifact reader's. Refused rather than described, because unlike an
        // untrustworthy baseline this is not a condition a wider run repairs (§V, ADR 0005).
        if (MachinePath.IsPresentIn(suite.Name))
        {
            throw new UnsafeIdentifierException(
                "This suite's name contains a machine path, and this stage renders it into a selection finding. "
                    + "The offending value is not repeated here because those findings reach the build log."
            )
            {
                Field = "suiteName",
            };
        }

        foreach (var scenario in scenarios)
        {
            if (MachinePath.IsPresentIn(scenario.Identity.Id))
            {
                throw new UnsafeIdentifierException(
                    "A scenario in this suite declares an id containing a machine path, which this stage renders "
                        + "into its selection findings. The offending value is not repeated here because those "
                        + "findings reach the build log."
                )
                {
                    Field = "identity.id",
                };
            }
        }

        if (baseline is not null)
        {
            _ = CanonicalJson.RequireSafeIdentifiers(baseline);
        }

        if (doubt is null)
        {
            doubt = Index(suite, baseline, out recorded);
        }

        if (doubt is not null)
        {
            return FullSuite(scenarios, doubt);
        }

        var selected = new List<ScenarioSelection>();
        var skipped = new List<string>();

        foreach (var scenario in scenarios)
        {
            var (reason, detail) = Decide(scenario, changed, recorded);

            if (reason is null)
            {
                skipped.Add(scenario.Identity.Id);
            }
            else
            {
                selected.Add(
                    new ScenarioSelection
                    {
                        ScenarioId = scenario.Identity.Id,
                        Reason = reason.Value,
                        Detail = detail,
                    }
                );
            }
        }

        return new SelectionResult { Selected = selected, Skipped = skipped };
    }

    /// <summary>Reduces the changed-file set, or says why it cannot be trusted.</summary>
    private static string? Normalize(IEnumerable<string> changedFiles, out List<ChangedPath> changed)
    {
        changed = [];

        foreach (var raw in changedFiles)
        {
            if (!ChangedPath.TryNormalize(raw, out var path, out var rejection))
            {
                // Dropping the entry and matching the rest would be quieter and wrong: whatever
                // this path mapped to would then be skipped, and the report would look identical
                // to a run in which it had genuinely matched nothing.
                //
                // The entry is quoted unless it is a machine path, in which case it is described.
                // It arrives from a caller's revision range rather than from an author, so it
                // cannot be guarded by refusing somebody's spelling — and a fallback nobody can
                // trace is noise, so the ordinary case keeps its text. A redaction still tells
                // two rejected entries apart (§V, ADR 0005).
                return $"Changed-file entry {Describe(raw)} {rejection}. The whole suite was selected rather than "
                    + "matching against a set that is missing a file nobody can account for.";
            }

            changed.Add(path!);
        }

        return changed.Count == 0
            ? "No changed files were supplied, so there is nothing to map scenarios against. An empty set is "
                + "not evidence that nothing changed."
            : null;
    }

    /// <summary>Indexes the baseline by scenario id, or says why it cannot be trusted.</summary>
    private static string? Index(Suite suite, SuiteResult? baseline, out Dictionary<string, ScenarioResult>? recorded)
    {
        recorded = null;

        if (baseline is null)
        {
            return null;
        }

        if (!string.Equals(baseline.SuiteName, suite.Name, StringComparison.Ordinal))
        {
            // Two suites share no scenario definitions, so an id in both is a collision rather
            // than a join — and the collision would resolve, silently, in the direction of
            // skipping. The comparator refuses this pairing outright; selection instead runs
            // everything, because its output is a work list and running more work is always safe.
            return $"The baseline is a run of suite '{baseline.SuiteName}' and this is a run of suite "
                + $"'{suite.Name}'. A scenario id shared between two suites is a collision, not a join, so no "
                + "verdict in it was used.";
        }

        var index = new Dictionary<string, ScenarioResult>(StringComparer.Ordinal);

        foreach (var result in baseline.ScenarioResults)
        {
            if (result?.ScenarioId is null)
            {
                return "The baseline carries a scenario result with no id, so what it records cannot be "
                    + "attributed to any scenario.";
            }

            if (!index.TryAdd(result.ScenarioId, result))
            {
                return $"The baseline files more than one result under scenario '{result.ScenarioId}'. That id is "
                    + "the key selection joins on, so whether the scenario runs would depend on which entry was "
                    + "reached first.";
            }
        }

        recorded = index;
        return null;
    }

    /// <summary>Applies the rules to one scenario. A null reason means it may be skipped.</summary>
    private static (SelectionReason? Reason, string? Detail) Decide(
        Scenario scenario,
        List<ChangedPath> changed,
        Dictionary<string, ScenarioResult>? recorded
    )
    {
        var globs = scenario.Selection?.ImpactGlobs;

        if (globs is null || globs.Count == 0)
        {
            return (
                SelectionReason.NoGlobsDeclared,
                $"scenario '{scenario.Identity.Id}' declares no impact globs, so nothing is known about which "
                    + "changes affect it"
            );
        }

        string? unreadable = null;

        foreach (var pattern in globs)
        {
            if (!ImpactGlob.TryParse(pattern, out var glob, out var rejection))
            {
                unreadable ??=
                    $"impact glob {Describe(pattern)} {rejection}, so this scenario's mapping is incomplete — "
                    + "\"none of the patterns that could be read matched\" is not \"nothing matched\"";
                continue;
            }

            foreach (var path in changed)
            {
                if (glob!.Matches(path))
                {
                    return (
                        SelectionReason.GlobMatch,
                        $"changed file '{path.AsWritten}' matched impact glob '{glob.Pattern}'"
                    );
                }
            }
        }

        return unreadable is not null
            ? (SelectionReason.NoGlobsDeclared, unreadable)
            : FromBaseline(scenario, recorded);
    }

    /// <summary>Asks the baseline whether there is evidence to skip this scenario on.</summary>
    /// <remarks>
    /// A null <paramref name="recorded"/> means no baseline artifact was supplied. A baseline
    /// that was supplied but could not be trusted never reaches here — it is a suite-wide
    /// fallback, decided before any scenario is considered.
    /// </remarks>
    private static (SelectionReason? Reason, string? Detail) FromBaseline(
        Scenario scenario,
        Dictionary<string, ScenarioResult>? recorded
    )
    {
        var id = scenario.Identity.Id;

        if (recorded is null)
        {
            return (
                SelectionReason.New,
                "no baseline artifact was supplied, so nothing records how this scenario last behaved"
            );
        }

        if (!recorded.TryGetValue(id, out var result))
        {
            return (SelectionReason.New, $"the baseline carries no result for scenario '{id}'");
        }

        // Before the fingerprint, because the fingerprint cannot see this. It covers execution,
        // simulation, and grading; the kind lives in ScenarioIdentity beside the id, so a
        // scenario switched from Rest to Llm carries the same fingerprint exactly — and the pass
        // it would be retired on was produced by a different runner against a different system.
        // The kind travels in the artifact as a required field of its own, which is what lets
        // this be checked directly rather than through a digest. SuiteComparator makes the same
        // comparison, for the same reason, one stage later.
        if (result.Kind != scenario.Identity.Kind)
        {
            return (
                SelectionReason.New,
                $"the baseline's verdict for scenario '{id}' was produced against a '{result.Kind}' system and the "
                    + $"suite now declares a '{scenario.Identity.Kind}' one. One id naming two kinds is a "
                    + "redefinition rather than a change in behaviour, so that verdict is about a different system"
            );
        }

        if (string.IsNullOrEmpty(result.DefinitionFingerprint))
        {
            return (
                SelectionReason.New,
                $"the baseline records no definition fingerprint for scenario '{id}', so its verdict cannot be "
                    + "attributed to the definition the suite now declares"
            );
        }

        var expected = ScenarioFingerprint.Of(scenario);

        if (!string.Equals(result.DefinitionFingerprint, expected, StringComparison.Ordinal))
        {
            return (
                SelectionReason.New,
                $"the baseline's verdict for scenario '{id}' was produced from a different definition — it "
                    + $"records fingerprint '{result.DefinitionFingerprint}' and the suite now declares "
                    + $"'{expected}', so that verdict is about a different question"
            );
        }

        if (
            !TryMeasure(
                result,
                scenario.Grading?.Assertions ?? [],
                out var graded,
                out var passed,
                out var contradiction
            )
        )
        {
            return (SelectionReason.New, contradiction);
        }

        if (graded == 0)
        {
            return (
                SelectionReason.New,
                $"no run of scenario '{id}' in the baseline produced a verdict, so it records no pass to skip "
                    + "on — an absence of recorded failure is not a record of passing"
            );
        }

        if (passed < graded)
        {
            return (
                SelectionReason.PreviouslyFailing,
                $"the baseline records {Render(passed)} of {Render(graded)} graded runs passing for scenario "
                    + $"'{id}'; a fix that is never re-run is never observed"
            );
        }

        return (null, null);
    }

    /// <summary>
    /// Counts the baseline runs of one scenario that produced a verdict, and how many passed.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Read from <see cref="ScenarioResult.Runs"/> rather than
    /// <see cref="ScenarioResult.Summary"/>, for the reason the comparator reads them: the runs
    /// are the evidence and the summary is a derived claim about them, and a baseline read from
    /// disk is untrusted input (§V). Any contradiction makes the whole entry unusable rather than
    /// partially counted — a record that disagrees with itself cannot establish coverage for the
    /// runs that happen to look consistent either.
    /// </para>
    /// <para>
    /// <b>A pass has to be complete as well as green.</b> A record carrying fewer runs than the
    /// repetitions it applied, or a run recorded as a pass with no verdict for an assertion the
    /// suite declares, is evidence that was never fully gathered — and counting it retires the
    /// scenario on the part of the work that happens to have been written down.
    /// </para>
    /// </remarks>
    private static bool TryMeasure(
        ScenarioResult result,
        IReadOnlyList<AssertionSpec> declared,
        out int graded,
        out int passed,
        out string? contradiction
    )
    {
        graded = 0;
        passed = 0;

        var applied = result.RepetitionPolicyUsed.Repetitions;

        if (result.Runs.Count != applied)
        {
            // Both directions, because both are the entry disagreeing with itself. The short
            // side is the dangerous one: the missing repetition is precisely the one whose
            // verdict is unknown, and the runs that were written down cannot speak for it.
            contradiction =
                $"the baseline applied {Render(applied)} repetition(s) to scenario '{result.ScenarioId}' and "
                + $"recorded {Render(result.Runs.Count)} run(s) under it. A record that does not contain the "
                + "repetitions it claims to have run cannot establish that they passed";
            return false;
        }

        foreach (var run in result.Runs)
        {
            if (run?.Transcript is null)
            {
                contradiction =
                    $"the baseline's record of scenario '{result.ScenarioId}' carries a run with no transcript, "
                    + "so what that run observed cannot be established";
                return false;
            }

            if (!string.Equals(run.Transcript.ScenarioId, result.ScenarioId, StringComparison.Ordinal))
            {
                contradiction =
                    $"a baseline run filed under scenario '{result.ScenarioId}' carries a transcript for "
                    + $"'{run.Transcript.ScenarioId}', so counting it would retire this scenario on another "
                    + "scenario's evidence";
                return false;
            }

            // A graded verdict claims the system under test behaved, or misbehaved. The
            // transcript beside it says whether the system was ever successfully asked, and the
            // coordinator refuses to grade a run whose exchange gathered nothing — it records
            // Error and never evaluates an assertion. A baseline read from disk carries no such
            // guarantee (§V), and this is the road with no downstream catch: a pass believed here
            // retires the scenario, so it never runs, emits nothing, and never reaches the
            // comparator that would have refused it. A pass with no verdicts beside it satisfies
            // both checks below vacuously, which is precisely an absence rendering as a result.
            if (VerdictEvidence.IsUnbacked(run))
            {
                contradiction =
                    $"a baseline run of scenario '{result.ScenarioId}' records the verdict "
                    + $"'{Render((int)run.Status)}' beside a transcript recording no successful exchange with the "
                    + $"system under test; {VerdictEvidence.Why}, so it cannot retire the scenario";
                return false;
            }
            switch (run.Status)
            {
                case RunStatus.Error:
                    // The harness fell over; the system under test said nothing. Not a verdict.
                    break;

                case RunStatus.Pass:
                    if (run.AssertionResults.Any(verdict => verdict is null || !verdict.Pass))
                    {
                        contradiction =
                            $"a baseline run of scenario '{result.ScenarioId}' is recorded as a pass beside an "
                            + "assertion verdict that did not hold; the verdicts are the evidence and the status "
                            + "is only a claim about them";
                        return false;
                    }

                    if (Unevaluated(declared, run) is { } missing)
                    {
                        // "Nothing failed" is satisfied vacuously by a run that checked nothing.
                        // A pass claims every declared assertion held, so a pass with no verdict
                        // for one of them is a claim with no evidence under it.
                        contradiction =
                            $"a baseline run of scenario '{result.ScenarioId}' is recorded as a pass but carries no "
                            + $"verdict for {missing}; a status of 'pass' asserts that every declared check held, "
                            + "and nothing here shows that one was evaluated at all";
                        return false;
                    }

                    graded++;
                    passed++;
                    break;

                case RunStatus.Fail:
                // A known gap clearing is newly-covered coverage, which is the headline the
                // harness exists to produce — so it has to be re-run to be seen clearing.
                case RunStatus.ExpectedFailure:
                    graded++;
                    break;

                default:
                    contradiction =
                        $"a baseline run of scenario '{result.ScenarioId}' records status "
                        + $"'{Render((int)run.Status)}', which is not a declared {nameof(RunStatus)}; an "
                        + "undefined verdict cannot be counted as a pass";
                    return false;
            }
        }

        contradiction = null;
        return true;
    }

    /// <summary>
    /// Names a declared assertion the run records no verdict for, or null when every one of them
    /// was evaluated.
    /// </summary>
    /// <remarks>
    /// Coverage is checked per declared specification rather than by counting verdicts: a run
    /// carrying exactly as many passing verdicts as the suite declares assertions, for a
    /// different assertion, is no more evidence than a run carrying none. A verdict for something
    /// the suite does <i>not</i> declare is left alone — it is a check the baseline ran and this
    /// definition no longer asks for, which cannot make a declared assertion any less evaluated.
    /// </remarks>
    private static string? Unevaluated(IReadOnlyList<AssertionSpec> declared, RunResult run)
    {
        if (declared.Count == 0)
        {
            // Vacuously covered, symmetrically with the coordinator that writes these runs: a
            // scenario grading on nothing passes having asserted nothing.
            return null;
        }

        var evaluated = new HashSet<AssertionSpec>(run.AssertionResults.Select(verdict => verdict.Spec));

        for (var index = 0; index < declared.Count; index++)
        {
            var assertion = declared[index];

            if (evaluated.Contains(assertion))
            {
                continue;
            }

            // Identified, not quoted. This text becomes ScenarioSelection.Detail, which the
            // consumer copies into its JSON run report and its verbose text report without
            // netting it — so an operand here is published rather than merely living in the
            // suite file, which is the line ADR 0005 actually draws. The category carries no
            // separator by grammar, the ordinal locates it in the scenario's own grading, and the
            // fingerprint tells two of them apart (§V).
            return assertion is null
                ? "an assertion this suite declares as null"
                : $"declared assertion {Render(index + 1)}, of category '{assertion.Category}' "
                    + $"({RunnerSupport.Redact(assertion.ToExpression())}) — its operand is not repeated here "
                    + "because this detail is published";
        }

        return null;
    }

    private static SelectionResult FullSuite(IReadOnlyList<Scenario> scenarios, string reason) =>
        new()
        {
            // Detail stays null: the explanation belongs to the run rather than to any one
            // scenario, and repeating it against every entry would bury it.
            Selected =
            [
                .. scenarios.Select(scenario => new ScenarioSelection
                {
                    ScenarioId = scenario.Identity.Id,
                    Reason = SelectionReason.Fallback,
                }),
            ],
            Skipped = [],
            FallbackReason = reason,
        };

    private static string Render(int value) => value.ToString(CultureInfo.InvariantCulture);

    /// <summary>
    /// A rejected author-supplied pattern or entry, as a selection finding may state it.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Quoted when it is ordinary — a pattern nobody can find is a pattern nobody fixes, and a
    /// fallback nobody can trace is noise. Described when it names a machine, because this text
    /// becomes <see cref="ScenarioSelection.Detail"/> and
    /// <see cref="SelectionResult.FallbackReason"/>, which the consumer publishes into its run
    /// report without netting.
    /// </para>
    /// <para>
    /// <b>The unquoted form is tested too, and that is the whole subtlety.</b>
    /// <see cref="ChangedPath.TryNormalize"/> refuses a double-quoted entry <i>before</i> looking
    /// at its path, and <see cref="MachinePath"/> deliberately does not see through a leading
    /// quote. Each is right alone; composed, a git C-quoted machine path takes the ordinary
    /// branch and reaches the report verbatim — a gap exactly where neither component's own rules
    /// look.
    /// </para>
    /// <para>
    /// Used for <b>both</b> author-supplied inputs this stage rejects: a changed-file entry and
    /// an impact glob. Fixing one and leaving the other is how the second was found.
    /// </para>
    /// </remarks>
    private static string Describe(string raw) => NamesAMachine(raw) ? RunnerSupport.Redact(raw) : $"'{raw}'";

    /// <summary>
    /// Whether a rejected entry names a machine, in any spelling this stage would reduce it to.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <see cref="MachinePath"/> reasons about one spelling: forward separators, no wrapping
    /// quotes. The values reaching this stage arrive in the spellings a producer emits — git
    /// C-quotes a non-ASCII name, Windows tools emit backslashes — and both
    /// <see cref="ChangedPath"/> and <see cref="ImpactGlob"/> unify separators before reasoning
    /// about a path for exactly that reason.
    /// </para>
    /// <para>
    /// So the guard is asked about the forms the code around it normalises to, rather than only
    /// the one it was handed. Neither transformation decodes anything: the escapes inside a
    /// C-quoted name are left alone, because decoding has its own silent failure modes and the
    /// value is refused rather than interpreted either way.
    /// </para>
    /// </remarks>
    private static bool NamesAMachine(string raw)
    {
        // Two questions, not a list of spellings. MachinePath reduces a token's relative prefix
        // and understands both separator conventions itself, so it is asked about the value as
        // written; the only thing it deliberately does not see through is a producer's wrapping
        // quotes, and git C-quoting is this stage's own domain knowledge rather than the
        // recogniser's. Nothing is decoded: the escapes inside a C-quoted name are left alone,
        // because the value is refused rather than interpreted either way.
        return MachinePath.IsPresentIn(raw)
            || MachinePath.IsPresentIn(raw.Replace("\"", string.Empty, StringComparison.Ordinal));
    }
}
