using System.Globalization;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Serialization;
using Forge.EvalEngine.Statistics;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Forge.EvalEngine.Comparison;

/// <summary>
/// Diffs a baseline artifact against a candidate artifact.
/// </summary>
/// <remarks>
/// <para>
/// <b>Source-agnostic.</b> This type diffs two <see cref="SuiteResult"/>s and neither knows nor
/// cares where they came from — a committed file, a run against a deployed baseline endpoint, or
/// two runs in the same process are all just two artifacts. That is what lets one comparator
/// serve both <see cref="Baselines.ArtifactBaseline"/> and
/// <see cref="Baselines.LiveEndpointBaseline"/>.
/// </para>
/// <para>
/// <b>The pairing is verified, not assumed.</b> A scenario id is a join key, and a join key is
/// only as good as the claim that both sides mean the same thing by it. Two artifacts can agree
/// on every id and still be describing different work: a scenario redefined between runs, a
/// different set of assertions, a different repetition count, or a run driven with different
/// seeds. Each of those produces a confident delta that measures the harness rather than the
/// change. What makes two scenarios comparable is stated in
/// <see cref="Compare(SuiteResult, SuiteResult, CancellationToken)"/> and enforced there.
/// </para>
/// <para>
/// <b>The evidence is the runs, not the reported summary.</b> Classification and effect size are
/// derived from <see cref="ScenarioResult.Runs"/> rather than from
/// <see cref="ScenarioResult.Summary"/>. A baseline read from disk is untrusted input (§V), and
/// a summary is a derived claim about the runs — reading the runs means a hand-edited point
/// estimate cannot manufacture a fix or hide a regression.
/// </para>
/// <para>
/// <b>Classification never depends on the statistics.</b> Which scenarios were fixed, regressed,
/// or newly covered is a factual statement about what happened and is produced whether or not a
/// significance test was supplied. The statistics are an overlay on top of it, and where one
/// cannot be computed the verdict is <see cref="SignificanceVerdict.NotComputed"/> rather than a
/// figure nobody calculated.
/// </para>
/// </remarks>
public sealed partial class SuiteComparator
{
    /// <summary>The level a p-value is judged against when a caller does not state one.</summary>
    public const double DefaultSignificanceLevel = 0.05;

    private readonly ISignificanceTest? _suiteTest;
    private readonly IMultipleComparisonCorrection? _correction;
    private readonly ILogger<SuiteComparator> _logger;

    /// <summary>
    /// Initializes a comparator that classifies scenarios without computing any statistics.
    /// </summary>
    public SuiteComparator()
        : this(null, null, DefaultSignificanceLevel, NullLogger<SuiteComparator>.Instance) { }

    /// <summary>
    /// Initializes a comparator that classifies scenarios and judges them at the conventional 5%
    /// level.
    /// </summary>
    /// <param name="suiteTest">The paired test used for the suite-wide delta.</param>
    /// <param name="correction">
    /// The correction applied across the family of per-scenario p-values.
    /// </param>
    /// <exception cref="ArgumentNullException">Either argument is null.</exception>
    public SuiteComparator(ISignificanceTest suiteTest, IMultipleComparisonCorrection correction)
        : this(
            suiteTest ?? throw new ArgumentNullException(nameof(suiteTest)),
            correction ?? throw new ArgumentNullException(nameof(correction)),
            DefaultSignificanceLevel,
            NullLogger<SuiteComparator>.Instance
        ) { }

    /// <summary>Initializes a new instance of the <see cref="SuiteComparator"/> class.</summary>
    /// <param name="suiteTest">
    /// The paired test used for the suite-wide delta, or null for no statistics.
    /// </param>
    /// <param name="correction">
    /// The correction applied across the family of per-scenario p-values, or null for no
    /// statistics.
    /// </param>
    /// <param name="significanceLevel">
    /// The level an <i>adjusted</i> p-value is judged against. Strictly between zero and one.
    /// </param>
    /// <param name="logger">
    /// Where a refusal to compare is signalled, in addition to the returned result. Only ever
    /// handed text this library composed (§V).
    /// </param>
    /// <remarks>
    /// <paramref name="suiteTest"/> and <paramref name="correction"/> are supplied together or
    /// not at all. A test without a correction is the specific mistake
    /// <see cref="IMultipleComparisonCorrection"/> exists to prevent — a suite of a hundred and
    /// fifty scenarios tested individually at the 5% level flags around seven of them with no
    /// real regression anywhere — so the combination is refused rather than silently producing
    /// uncorrected p-values.
    /// </remarks>
    /// <exception cref="ArgumentNullException"><paramref name="logger"/> is null.</exception>
    /// <exception cref="ArgumentException">
    /// One of <paramref name="suiteTest"/> and <paramref name="correction"/> was supplied without
    /// the other.
    /// </exception>
    /// <exception cref="ArgumentOutOfRangeException">
    /// <paramref name="significanceLevel"/> is not strictly between zero and one.
    /// </exception>
    public SuiteComparator(
        ISignificanceTest? suiteTest,
        IMultipleComparisonCorrection? correction,
        double significanceLevel,
        ILogger<SuiteComparator> logger
    )
    {
        ArgumentNullException.ThrowIfNull(logger);

        if (suiteTest is null != correction is null)
        {
            throw new ArgumentException(
                "A significance test and a multiple-comparison correction are supplied together or not at all. "
                    + "Testing every scenario in a suite individually without correcting the family is the exact "
                    + "false-positive problem the correction exists to prevent.",
                suiteTest is null ? nameof(suiteTest) : nameof(correction)
            );
        }

        if (!(significanceLevel > 0 && significanceLevel < 1))
        {
            throw new ArgumentOutOfRangeException(
                nameof(significanceLevel),
                significanceLevel,
                "A significance level must be strictly between zero and one."
            );
        }

        _suiteTest = suiteTest;
        _correction = correction;
        _logger = logger;
        SignificanceLevel = significanceLevel;
    }

    /// <summary>Gets the level an adjusted p-value is judged against.</summary>
    public double SignificanceLevel { get; }

    /// <summary>Diffs a baseline artifact against a candidate artifact.</summary>
    /// <param name="baseline">The artifact to compare against.</param>
    /// <param name="candidate">The artifact produced by the change under review.</param>
    /// <param name="cancellationToken">
    /// Cancels the comparison. A paired bootstrap runs many resamples and honours it.
    /// </param>
    /// <returns>The classification of every scenario, and the statistics where they could be computed.</returns>
    /// <remarks>
    /// <para><b>Two artifacts are comparable when they agree on all of:</b></para>
    /// <list type="bullet">
    /// <item><description>the schema version they were written at;</description></item>
    /// <item><description>the suite name;</description></item>
    /// <item><description>
    /// the root seed — the figure a reader reproduces a run from, and the reason the comparison is
    /// paired at all;
    /// </description></item>
    /// <item><description>
    /// every entry of <see cref="EvaluationEnvironment.HarnessConfig"/>, which is by definition
    /// the settings in force. A different throttle changes what a rate-limited system returns.
    /// </description></item>
    /// </list>
    /// <para>
    /// <see cref="EvaluationEnvironment.Endpoint"/>,
    /// <see cref="EvaluationEnvironment.BaselineRef"/>, and
    /// <see cref="EvaluationEnvironment.Timestamp"/> are deliberately <b>not</b> compared: two
    /// variants at two addresses run at two times is the case this whole stage exists for.
    /// </para>
    /// <para><b>Two scenarios are comparable when they agree on all of:</b></para>
    /// <list type="bullet">
    /// <item><description>the scenario kind;</description></item>
    /// <item><description>
    /// the <see cref="ScenarioResult.DefinitionFingerprint"/> of the definition each was run
    /// from — the execution inputs and the grading expectations. This is what makes the id mean
    /// the same thing in both artifacts: an assertion spec names what was checked, never the
    /// expectation it was checked against, so a scenario can keep every spec and still be
    /// graded against a different answer. A fingerprint absent from either side is
    /// <see cref="ScenarioClassification.NotComparable"/> rather than a match;
    /// </description></item>
    /// <item><description>
    /// the repetition policy actually used, and the number of runs recorded under it;
    /// </description></item>
    /// <item><description>
    /// the set of assertions the runs were graded against — same id, different assertions is a
    /// different scenario wearing the same name;
    /// </description></item>
    /// <item><description>
    /// the seed of every repetition, pairwise and in order. This is the pairing itself:
    /// <see cref="PairedObservation.Seed"/> is carried precisely so a reader can confirm the two
    /// runs really were driven identically, and comparing runs driven with different seeds
    /// attributes seed variation to the change.
    /// </description></item>
    /// <item><description>
    /// both sides having produced at least one gradeable run. A baseline whose every run errored
    /// says nothing about whether the candidate fixed anything.
    /// </description></item>
    /// </list>
    /// <para>
    /// <b>Outcomes are drawn from every graded run, and a transition has to be paired.</b> What
    /// each artifact says about a scenario is a statement about that artifact's own runs, so it
    /// counts all of them — a candidate that passed one repetition and failed another has not
    /// passed, whichever repetition happened to be pairable. A
    /// <see cref="ScenarioClassification.Fixed"/> or
    /// <see cref="ScenarioClassification.Regressed"/> that no repetition pair demonstrates is
    /// reported <see cref="ScenarioClassification.NotComparable"/>: its only evidence would be
    /// one variant's repetition read against another's.
    /// </para>
    /// <para>
    /// A scenario failing any of those is reported as
    /// <see cref="ScenarioClassification.NotComparable"/> with a stated reason, logged once, and
    /// excluded from <see cref="ComparisonResult.NewlyCovered"/> and from the observations handed
    /// to the significance test. It does not veto the rest of the suite.
    /// </para>
    /// </remarks>
    /// <exception cref="ArgumentNullException">Either artifact is null.</exception>
    /// <exception cref="ArgumentException">
    /// An artifact names the same scenario twice, carries a null scenario or run, carries a
    /// <see cref="RunStatus"/> outside the declared values, files a run whose transcript names
    /// another scenario, records a <see cref="RunStatus.Pass"/> beside an assertion verdict that
    /// did not hold, or reuses one seed across a scenario's repetitions.
    /// </exception>
    /// <exception cref="ComparisonRefusedException">
    /// The two artifacts were not produced under conditions that can be compared.
    /// </exception>
    /// <exception cref="OperationCanceledException">
    /// <paramref name="cancellationToken"/> was cancelled.
    /// </exception>
    public ComparisonResult Compare(
        SuiteResult baseline,
        SuiteResult candidate,
        CancellationToken cancellationToken = default
    )
    {
        ArgumentNullException.ThrowIfNull(baseline);
        ArgumentNullException.ThrowIfNull(candidate);
        cancellationToken.ThrowIfCancellationRequested();

        RequireComparableRuns(baseline, candidate);

        var previous = Index(baseline, nameof(baseline));
        var current = Index(candidate, nameof(candidate));
        var comparisons = new List<ScenarioComparison>(previous.Count + current.Count);

        foreach (var scenario in candidate.ScenarioResults)
        {
            cancellationToken.ThrowIfCancellationRequested();

            comparisons.Add(
                previous.TryGetValue(scenario.ScenarioId, out var before)
                    ? ComparePair(before, scenario)
                    : new ScenarioComparison
                    {
                        ScenarioId = scenario.ScenarioId,
                        Classification = ScenarioClassification.New,
                        BaselineOutcome = ScenarioOutcome.Absent,
                        CandidateOutcome = Measure(scenario).Outcome,
                    }
            );
        }

        foreach (var scenario in baseline.ScenarioResults)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (!current.ContainsKey(scenario.ScenarioId))
            {
                comparisons.Add(
                    new ScenarioComparison
                    {
                        ScenarioId = scenario.ScenarioId,
                        Classification = ScenarioClassification.Removed,
                        BaselineOutcome = Measure(scenario).Outcome,
                        CandidateOutcome = ScenarioOutcome.Absent,
                    }
                );
            }
        }

        foreach (var comparison in comparisons)
        {
            if (comparison.NotComparableReason is { } reason)
            {
                // Terminal here: this comparator is what decides the scenario cannot be diffed,
                // so this is the one place it is signalled (§IV).
                LogScenarioNotComparable(comparison.ScenarioId, reason);
            }
        }

        Correct(comparisons);

        var covered = new List<string>();
        var withheld = new List<WithheldCoverage>();

        foreach (var comparison in comparisons)
        {
            if (!ClaimsCoverage(comparison))
            {
                continue;
            }

            // Both branches rest on the candidate having passed, and that outcome is conditional
            // on the repetitions which produced a verdict. A scenario the harness did not
            // conduct in full passed everything that happened to be gradeable, which is not the
            // coverage a change earned. Fixed is present in the candidate by definition and New
            // is candidate-only, so the lookup always resolves.
            if (CoverageShortfall(current[comparison.ScenarioId]) is not { } cause)
            {
                covered.Add(comparison.ScenarioId);
                continue;
            }

            var entry = new WithheldCoverage { ScenarioId = comparison.ScenarioId, Cause = cause };

            withheld.Add(entry);

            // Named and signalled rather than dropped, and signalled with the cause that applies
            // to this scenario rather than a general one. A shorter list and a withheld scenario
            // read identically, so a refusal that renders as an absence is indistinguishable
            // from nothing having happened. Terminal here: this comparator is what decides the
            // claim is unsupported, so this is the one place it is signalled (§IV). The log and
            // the report now carry the same value rather than the log carrying an attribution
            // the report could not reach.
            LogCoverageWithheld(entry.ScenarioId, entry.Reason);
        }

        return new ComparisonResult
        {
            SuiteName = candidate.SuiteName,
            ScenarioComparisons = comparisons,
            NewlyCovered = covered,
            NewlyCoveredWithheld = withheld,
            Suite = CompareSuite(previous, current, comparisons, cancellationToken),
            Correction = _correction?.Name,
        };
    }

    /// <summary>
    /// Whether a comparison is claiming the change covered something the baseline did not.
    /// </summary>
    /// <remarks>
    /// Classification is untouched by this: a scenario keeps the classification its runs earned
    /// whether or not the coverage claim survives. This decides only what gets claimed. The
    /// <see cref="ScenarioOutcome.Passed"/> guard on the new branch still carries its own weight
    /// — it is what excludes a new scenario that failed, or whose every repetition errored.
    /// </remarks>
    private static bool ClaimsCoverage(ScenarioComparison comparison) =>
        comparison.Classification == ScenarioClassification.Fixed
        || (
            comparison.Classification == ScenarioClassification.New
            && comparison.CandidateOutcome == ScenarioOutcome.Passed
        );

    /// <summary>
    /// States why a scenario's own record falls short of the work it declared, or null when it
    /// does not.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The question is whether the scenario was <b>conducted in full</b>, which is not the same
    /// as whether a repetition errored. A run that never happened leaves no
    /// <see cref="RunStatus.Error"/> behind to find, so counting errored runs answers a narrower
    /// question than the coverage claim depends on.
    /// </para>
    /// <para>
    /// Read from <see cref="ScenarioResult.RepetitionPolicyUsed"/> against the runs actually
    /// recorded, and reported in the direction the mismatch went: too few runs means evidence
    /// was never gathered, too many means the artifact carries runs its own policy never asked
    /// for. Both withhold the claim, but they are different faults and a reader sent after the
    /// wrong one is worse served than one told nothing. That figure is safe to count against:
    /// <see cref="Scenarios.RepetitionPolicy"/> has no public constructor, every factory and
    /// every deserialization path goes through <see cref="Scenarios.RepetitionPolicy.Repeat"/>
    /// which refuses anything below one, and the property is <c>required</c> — so it can be
    /// neither absent nor zero, and a count against it is not a false guard.
    /// </para>
    /// <para>
    /// The structural causes are tested first, and in the direction the mismatch actually went.
    /// An artifact that did not record what it declared is untrustworthy about the runs it did
    /// record, so that is reported ahead of their verdicts.
    /// </para>
    /// <para>
    /// A scenario present in both artifacts is already refused by
    /// <see cref="Divergence"/> when its runs and its policy disagree, per side and against its
    /// own declared count rather than against the other side's — so two equally short artifacts
    /// do not agree their way past it. This check is what covers the candidate-only case, which
    /// has no counterpart to be paired against and so never reaches that one.
    /// </para>
    /// </remarks>
    private static CoverageWithholdingCause? CoverageShortfall(ScenarioResult scenario)
    {
        if (scenario.Runs.Count < scenario.RepetitionPolicyUsed.Repetitions)
        {
            return CoverageWithholdingCause.Incomplete;
        }

        if (scenario.Runs.Count > scenario.RepetitionPolicyUsed.Repetitions)
        {
            return CoverageWithholdingCause.OverRecorded;
        }

        return scenario.Runs.Any(run => run.Status == RunStatus.Error) ? CoverageWithholdingCause.Errored : null;
    }

    /// <summary>
    /// Refuses two artifacts that were not produced under conditions that can be compared.
    /// </summary>
    /// <remarks>
    /// <see cref="SuiteResult.SchemaVersion"/> is deliberately absent from these checks. It is
    /// stamped rather than settable, so two instances cannot disagree on it; the guard that
    /// matters lives where an artifact is <i>read</i>, in
    /// <see cref="Serialization.CanonicalJson.DeserializeSuiteResult(string)"/>, which
    /// <see cref="Baselines.ArtifactBaseline"/> goes through. A check here could never fail, and
    /// a check that cannot fail reads like protection that is not there.
    /// </remarks>
    private static void RequireComparableRuns(SuiteResult baseline, SuiteResult candidate)
    {
        if (!string.Equals(baseline.SuiteName, candidate.SuiteName, StringComparison.Ordinal))
        {
            throw new ComparisonRefusedException(
                $"The baseline is a run of suite '{baseline.SuiteName}' and the candidate is a run of suite "
                    + $"'{candidate.SuiteName}'. Two different suites share no scenario definitions, so a delta "
                    + "between them would be arithmetic over unrelated work."
            )
            {
                Property = "suiteName",
            };
        }

        if (baseline.Environment.Seed != candidate.Environment.Seed)
        {
            throw new ComparisonRefusedException(
                $"The baseline was driven from root seed {Render(baseline.Environment.Seed)} and the candidate from "
                    + $"{Render(candidate.Environment.Seed)}. The comparison is paired by construction — the same "
                    + "scenarios under the same seeds — so two runs driven from different roots are not matched "
                    + "observations, and a test conditioned on their differences would attribute seed variation to "
                    + "the change."
            )
            {
                Property = "seed",
            };
        }

        // HarnessConfig is by definition the settings in force. A reader reproduces a run from
        // it, so two runs that disagree on any of it are not reproductions of each other: a
        // different throttle changes what a rate-limited system returns, and a different
        // interval method changes what the artifact's figures mean.
        foreach (var setting in baseline.Environment.HarnessConfig)
        {
            if (
                !candidate.Environment.HarnessConfig.TryGetValue(setting.Key, out var value)
                || !string.Equals(setting.Value, value, StringComparison.Ordinal)
            )
            {
                throw new ComparisonRefusedException(
                    $"The baseline and the candidate disagree on harness setting '{setting.Key}'. That setting is "
                        + "part of what a reader reproduces the run from, so the two runs were not conducted alike "
                        + "and a delta between them would measure the harness rather than the change."
                )
                {
                    Property = setting.Key,
                };
            }
        }

        foreach (var setting in candidate.Environment.HarnessConfig)
        {
            if (!baseline.Environment.HarnessConfig.ContainsKey(setting.Key))
            {
                throw new ComparisonRefusedException(
                    $"The candidate declares harness setting '{setting.Key}' and the baseline does not. A setting "
                        + "that was in force for only one of the two runs means they were not conducted alike."
                )
                {
                    Property = setting.Key,
                };
            }
        }
    }

    private static Dictionary<string, ScenarioResult> Index(SuiteResult artifact, string parameterName)
    {
        var scenarios = new Dictionary<string, ScenarioResult>(StringComparer.Ordinal);

        foreach (var scenario in artifact.ScenarioResults)
        {
            if (scenario is null)
            {
                throw new ArgumentException("A scenario result must not be null.", parameterName);
            }

            // The id is the join key. Two scenarios filed under one make either of them satisfy
            // a lookup for the other, so whichever this comparator picked would decide the
            // verdict — refused rather than resolved, exactly as the coordinator refuses it.
            if (!scenarios.TryAdd(scenario.ScenarioId, scenario))
            {
                throw new ArgumentException(
                    $"Scenario '{scenario.ScenarioId}' appears more than once in the artifact. That id is the key "
                        + "the two artifacts are joined on, so a duplicate makes the comparison depend on which "
                        + "entry was reached first.",
                    parameterName
                );
            }

            // Validated here, before anything is classified, so a malformed artifact is refused
            // whole rather than half-reported.
            _ = Measure(scenario);
        }

        return scenarios;
    }

    /// <summary>Counts the runs of one scenario that produced a verdict, and how many passed.</summary>
    /// <remarks>
    /// <para>
    /// Read from <see cref="ScenarioResult.Runs"/> rather than
    /// <see cref="ScenarioResult.Summary"/>: the runs are the evidence and the summary is a
    /// derived claim about them, and a baseline read from disk is untrusted input.
    /// </para>
    /// <para>
    /// The runs are also checked here, before anything is classified, because an artifact this
    /// comparator did not produce is untrusted in three further ways (§V). A run whose transcript
    /// names another scenario is evidence from one context filed under another. A run stamped
    /// <see cref="RunStatus.Pass"/> beside a failed assertion verdict claims coverage its own
    /// evidence denies. And repetitions sharing a seed are one observation recorded several
    /// times, which the paired test would read as several independent ones.
    /// </para>
    /// </remarks>
    private static Evidence Measure(ScenarioResult scenario)
    {
        var graded = 0;
        var passed = 0;

        // A seed is half of a run's identity, and the coordinator refuses to issue one twice
        // within a scenario for exactly this reason. An artifact from elsewhere carries no such
        // guarantee, so the same property is established rather than assumed: six repetitions
        // from one seed paired against six of the other verdict read as six discordant pairs and
        // return a significant p-value drawn from a single observation.
        var seeds = new HashSet<long>();

        foreach (var run in scenario.Runs)
        {
            if (run is null)
            {
                throw new ArgumentException($"Scenario '{scenario.ScenarioId}' carries a null run.", nameof(scenario));
            }

            if (!string.Equals(run.Transcript.ScenarioId, scenario.ScenarioId, StringComparison.Ordinal))
            {
                throw new ArgumentException(
                    $"A run filed under scenario '{scenario.ScenarioId}' carries a transcript for "
                        + $"'{run.Transcript.ScenarioId}'. The identifier is what a run is compared under, so "
                        + "counting that transcript here would judge one scenario's behaviour against another "
                        + "scenario's baseline.",
                    nameof(scenario)
                );
            }

            if (run.Status == RunStatus.Pass && run.AssertionResults.Any(verdict => !verdict.Pass))
            {
                throw new ArgumentException(
                    $"A run of scenario '{scenario.ScenarioId}' is recorded as a pass beside an assertion verdict "
                        + "that did not hold. The verdicts are the evidence and the status is a claim about them, "
                        + "so an artifact whose own run contradicts itself cannot establish that the scenario is "
                        + "covered.",
                    nameof(scenario)
                );
            }

            if (!seeds.Add(run.Transcript.Seed))
            {
                throw new ArgumentException(
                    $"Scenario '{scenario.ScenarioId}' records seed {Render(run.Transcript.Seed)} for more than one "
                        + "repetition. A run is identified by its scenario and its seed, so repetitions sharing one "
                        + "are the same observation recorded twice rather than independent samples — and paired "
                        + "against the other variant they would be counted as that many discordant pairs.",
                    nameof(scenario)
                );
            }

            switch (run.Status)
            {
                case RunStatus.Error:
                    break;

                case RunStatus.Pass:
                    graded++;
                    passed++;
                    break;

                case RunStatus.Fail:
                case RunStatus.ExpectedFailure:
                    graded++;
                    break;

                // The same refusal the aggregator makes, for the same reason: a value outside
                // the declared enum is not a verdict, and treating it as one would let an
                // undefined status become a pass rate, a delta, and a merge decision.
                default:
                    throw new ArgumentException(
                        $"Run status '{run.Status}' in scenario '{scenario.ScenarioId}' is not a declared "
                            + $"{nameof(RunStatus)}. A run whose verdict is undefined cannot be counted as a pass, "
                            + "as a failure, or as ungradeable.",
                        nameof(scenario)
                    );
            }
        }

        return new Evidence(graded, passed);
    }

    private ScenarioComparison ComparePair(ScenarioResult baseline, ScenarioResult candidate)
    {
        var reason = Divergence(baseline, candidate);

        if (reason is not null)
        {
            return NotComparable(baseline, candidate, reason);
        }

        var paired = Pair(baseline, candidate);

        // The outcome each artifact reports is a statement about that artifact's own runs, so it
        // is drawn from every graded run rather than only from the mutually gradeable ones. A
        // candidate of [Pass, Fail] against a baseline of [Fail, Error] has a graded failure;
        // reading only the pairable repetition would report it Passed and the scenario Fixed
        // while that failure sat in plain sight (§VI). This is also what the New and Removed
        // branches already report, so one id means one thing throughout the result.
        var before = Measure(baseline);
        var after = Measure(candidate);
        var classification = Classify(before.Outcome, after.Outcome);

        // A transition is a claim about the same repetition under two variants. Where the
        // outcomes say one happened but no repetition pair shows it, the only evidence for it is
        // one variant's repetition read against the other's — which is the cross-context
        // attribution this whole stage exists to prevent.
        if (Unestablished(classification, paired, candidate.ScenarioId) is { } unestablished)
        {
            return NotComparable(baseline, candidate, unestablished);
        }

        // Computed once: the p-value and the test stamped beside it must describe the same
        // decision, and deriving them independently is how those two drift apart.
        var pValue = _correction is null ? null : PValue(paired);

        return new ScenarioComparison
        {
            ScenarioId = candidate.ScenarioId,
            Classification = classification,
            BaselineOutcome = before.Outcome,
            CandidateOutcome = after.Outcome,
            GradedPairs = paired.GradedPairs,
            Comparison = new ComparisonSummary
            {
                // Always stated, whether or not a test could be run. Both rates are drawn from
                // the same repetitions, so the difference is a paired quantity rather than two
                // estimates over different denominators.
                EffectSize = paired.Candidate.PassRate - paired.Baseline.PassRate,
                PValue = pValue,
                Test = pValue is null ? null : SignificanceTestKind.McNemar,
            },
        };
    }

    /// <summary>
    /// States why the paired repetitions cannot establish the transition the outcomes describe,
    /// or null when they can.
    /// </summary>
    /// <remarks>
    /// Only <see cref="ScenarioClassification.Fixed"/> and
    /// <see cref="ScenarioClassification.Regressed"/> are transitions. The stable classifications
    /// assert that nothing changed, which needs no pair to demonstrate.
    /// </remarks>
    private static string? Unestablished(ScenarioClassification classification, PairedEvidence paired, string id) =>
        classification switch
        {
            ScenarioClassification.Fixed when paired.Fixed == 0 =>
                $"Scenario '{id}' is reported as fixed by its graded runs, but no repetition pair went from not "
                    + "passing to passing — every repetition that could have shown the transition was ungradeable "
                    + "under one variant. The only evidence for it would be one variant's repetition read against "
                    + "another's, which is not a matched pair.",
            ScenarioClassification.Regressed when paired.Regressed == 0 =>
                $"Scenario '{id}' is reported as regressed by its graded runs, but no repetition pair went from "
                    + "passing to not passing — every repetition that could have shown the transition was "
                    + "ungradeable under one variant. The only evidence for it would be one variant's repetition "
                    + "read against another's, which is not a matched pair.",
            _ => null,
        };

    /// <summary>One scenario reported per side, because no pairing is available to diff.</summary>
    private static ScenarioComparison NotComparable(ScenarioResult baseline, ScenarioResult candidate, string reason) =>
        new()
        {
            ScenarioId = candidate.ScenarioId,
            Classification = ScenarioClassification.NotComparable,

            // Reported per side, because with no pairing available that is all either
            // artifact can honestly be said to have found.
            BaselineOutcome = Measure(baseline).Outcome,
            CandidateOutcome = Measure(candidate).Outcome,
            NotComparableReason = reason,
        };

    /// <summary>
    /// States why two scenarios filed under one id are not the same scenario, or null when they
    /// are.
    /// </summary>
    private static string? Divergence(ScenarioResult baseline, ScenarioResult candidate)
    {
        var id = candidate.ScenarioId;

        if (baseline.Kind != candidate.Kind)
        {
            return $"Scenario '{id}' exercises a '{baseline.Kind}' system in the baseline and a "
                + $"'{candidate.Kind}' system in the candidate. One id naming two kinds is a redefinition rather "
                + "than a change in behaviour.";
        }

        // What actually establishes "these are the same scenario". The assertion specs below say
        // what was checked; they do not carry the expectation each was checked against, so an
        // author can retain `exactMatch:outcome`, edit grading.expectedOutcome, and have an
        // unchanged system response turn from a failure into a pass. Reported as a redefinition
        // rather than as a fix the change earned (§V, §VI).
        if (
            string.IsNullOrEmpty(baseline.DefinitionFingerprint)
            || string.IsNullOrEmpty(candidate.DefinitionFingerprint)
        )
        {
            return $"Scenario '{id}' does not record the fingerprint of the definition it was run from in "
                + (baseline.DefinitionFingerprint is null or "" ? "the baseline" : "the candidate")
                + " artifact. An artifact that never stated what it was run against cannot establish that both "
                + "sides were run against the same thing, and absent is not the same as matching.";
        }

        if (!string.Equals(baseline.DefinitionFingerprint, candidate.DefinitionFingerprint, StringComparison.Ordinal))
        {
            return $"Scenario '{id}' was redefined between the two artifacts: its execution inputs or its grading "
                + "expectations differ. The same id driven with different stimuli, or graded against a different "
                + "expectation, is a different scenario wearing the same name — and an unchanged system would be "
                + "reported as fixed by the edit rather than by the change.";
        }

        if (baseline.RepetitionPolicyUsed.Repetitions != candidate.RepetitionPolicyUsed.Repetitions)
        {
            return $"Scenario '{id}' ran {Render(baseline.RepetitionPolicyUsed.Repetitions)} repetition(s) in the "
                + $"baseline and {Render(candidate.RepetitionPolicyUsed.Repetitions)} in the candidate. Repetitions "
                + "are what the two variants are paired on, so unequal counts leave nothing to pair.";
        }

        if (
            baseline.Runs.Count != baseline.RepetitionPolicyUsed.Repetitions
            || candidate.Runs.Count != candidate.RepetitionPolicyUsed.Repetitions
        )
        {
            return $"Scenario '{id}' declares a repetition policy that does not match the runs recorded under it — "
                + $"{Render(baseline.RepetitionPolicyUsed.Repetitions)} declared against "
                + $"{Render(baseline.Runs.Count)} baseline run(s) and {Render(candidate.Runs.Count)} candidate "
                + "run(s). An artifact whose own structure disagrees is not evidence of anything.";
        }

        for (var index = 0; index < baseline.Runs.Count; index++)
        {
            var before = baseline.Runs[index].Transcript.Seed;
            var after = candidate.Runs[index].Transcript.Seed;

            if (before != after)
            {
                // The pairing itself. PairedObservation carries the seed precisely so a reader
                // can confirm the two runs were driven identically; comparing repetitions driven
                // from different seeds attributes seed variation to the change under review.
                return $"Repetition {Render(index + 1)} of scenario '{id}' was driven with seed {Render(before)} in "
                    + $"the baseline and {Render(after)} in the candidate. The two runs were not driven "
                    + "identically, so they are not a matched pair.";
            }
        }

        var gradedPairs = 0;

        for (var index = 0; index < baseline.Runs.Count; index++)
        {
            if (baseline.Runs[index].Status != RunStatus.Error && candidate.Runs[index].Status != RunStatus.Error)
            {
                gradedPairs++;
            }
        }

        if (gradedPairs == 0)
        {
            return $"Scenario '{id}' has no repetition in which both variants produced a verdict. An ungradeable "
                + "run says nothing about the system under test, so there is no paired evidence here — reporting a "
                + "fix or a regression from it would manufacture one out of a harness fault.";
        }

        var before2 = Assertions(baseline);
        var after2 = Assertions(candidate);

        if (!before2.SequenceEqual(after2, StringComparer.Ordinal))
        {
            return $"Scenario '{id}' was graded against a different set of assertions in each artifact. The same id "
                + "asserting different things is a different scenario wearing the same name, and a delta between "
                + "them measures the change in the assertions.";
        }

        return null;
    }

    /// <summary>The assertions a scenario's runs were graded against, in a canonical order.</summary>
    /// <remarks>
    /// Compared as a set: the order assertions are evaluated in is not part of what a scenario
    /// checks. Each spec is reduced to its canonical JSON rather than compared with
    /// <c>==</c>, which is the notion of sameness the rest of this library uses for its records.
    /// </remarks>
    private static List<string> Assertions(ScenarioResult scenario)
    {
        var specs = new SortedSet<string>(StringComparer.Ordinal);

        foreach (var run in scenario.Runs)
        {
            foreach (var assertion in run.AssertionResults)
            {
                specs.Add(CanonicalJson.Serialize(assertion.Spec));
            }
        }

        return [.. specs];
    }

    /// <summary>Walks the repetitions the two variants have in common.</summary>
    private static PairedEvidence Pair(ScenarioResult baseline, ScenarioResult candidate)
    {
        var gradedPairs = 0;
        var baselinePassed = 0;
        var candidatePassed = 0;
        var regressed = 0;
        var fixedUp = 0;

        for (var index = 0; index < baseline.Runs.Count; index++)
        {
            var before = baseline.Runs[index].Status;
            var after = candidate.Runs[index].Status;

            // A repetition that errored under either variant produced no verdict about the
            // change. Conditioned away rather than counted, exactly as the aggregator conditions
            // an errored run out of a pass rate.
            if (before == RunStatus.Error || after == RunStatus.Error)
            {
                continue;
            }

            gradedPairs++;

            var passedBefore = before == RunStatus.Pass;
            var passedAfter = after == RunStatus.Pass;

            if (passedBefore)
            {
                baselinePassed++;
            }

            if (passedAfter)
            {
                candidatePassed++;
            }

            if (passedBefore && !passedAfter)
            {
                regressed++;
            }
            else if (!passedBefore && passedAfter)
            {
                fixedUp++;
            }
        }

        return new PairedEvidence(
            new Evidence(gradedPairs, baselinePassed),
            new Evidence(gradedPairs, candidatePassed),
            gradedPairs,
            regressed,
            fixedUp
        );
    }

    /// <summary>
    /// The per-scenario p-value, from the exact conditional test on the discordant repetitions.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Why this does not go through <see cref="ISignificanceTest"/>.</b> That seam is the
    /// <i>cross-scenario</i> one: <see cref="PairedObservations"/> admits exactly one pair per
    /// scenario, deliberately, so a family of pairs drawn from one scenario's repetitions is not
    /// expressible through it. Synthesizing a composite identifier to get around that would be
    /// the precise cross-context misattribution this stage exists to prevent. The arithmetic
    /// below is <see cref="Statistics.McNemarTest"/>'s own exact branch, not a second
    /// implementation of it.
    /// </para>
    /// <para>
    /// The exact test is used at every count rather than only below
    /// <see cref="Statistics.McNemarTest.ExactThreshold"/>. A repetition count is small by
    /// nature, the chi-squared form is an approximation adopted for speed at large samples, and
    /// the exact conditional test is valid at every size.
    /// </para>
    /// <para>
    /// <b>No discordant repetitions means no p-value.</b> A scenario that agreed with itself
    /// under both variants carries no information about the direction of a change; the statistic
    /// is <c>0 / 0</c>, and the honest report is that nothing was computed.
    /// </para>
    /// </remarks>
    private static double? PValue(PairedEvidence evidence) =>
        evidence.Regressed + evidence.Fixed == 0
            ? null
            : SignTest.TwoSidedExactPValue(evidence.Regressed, evidence.Fixed);

    private static ScenarioClassification Classify(ScenarioOutcome baseline, ScenarioOutcome candidate) =>
        (baseline, candidate) switch
        {
            (ScenarioOutcome.Passed, ScenarioOutcome.Passed) => ScenarioClassification.StablePass,
            (ScenarioOutcome.Passed, ScenarioOutcome.Failed) => ScenarioClassification.Regressed,
            (ScenarioOutcome.Failed, ScenarioOutcome.Passed) => ScenarioClassification.Fixed,
            (ScenarioOutcome.Failed, ScenarioOutcome.Failed) => ScenarioClassification.StableFail,
            _ => ScenarioClassification.NotComparable,
        };

    /// <summary>
    /// Adjusts the family of per-scenario p-values, in place, and judges each against the level.
    /// </summary>
    /// <remarks>
    /// Only the scenarios that actually produced a p-value form the family. A scenario reporting
    /// <see cref="SignificanceVerdict.NotComputed"/> was not a test, and counting it would
    /// inflate the family size and weaken every real finding in it.
    /// </remarks>
    private void Correct(List<ScenarioComparison> comparisons)
    {
        if (_correction is null)
        {
            return;
        }

        var tested = new List<int>();
        var pValues = new List<double>();

        for (var index = 0; index < comparisons.Count; index++)
        {
            if (comparisons[index].Comparison?.PValue is { } pValue)
            {
                tested.Add(index);
                pValues.Add(pValue);
            }
        }

        if (tested.Count == 0)
        {
            return;
        }

        var adjusted = _correction.Adjust(pValues);

        for (var rank = 0; rank < tested.Count; rank++)
        {
            var comparison = comparisons[tested[rank]];
            var value = adjusted[rank];

            comparisons[tested[rank]] = comparison with
            {
                Comparison = comparison.Comparison! with
                {
                    AdjustedPValue = value,

                    // Judged on the adjusted value, not the raw one. Judging the raw value would
                    // make the correction decorative.
                    Significant =
                        value <= SignificanceLevel
                            ? SignificanceVerdict.Significant
                            : SignificanceVerdict.NotSignificant,
                },
            };
        }
    }

    /// <summary>The suite-wide delta, through the injected cross-scenario test.</summary>
    private ComparisonSummary? CompareSuite(
        Dictionary<string, ScenarioResult> baseline,
        Dictionary<string, ScenarioResult> candidate,
        List<ScenarioComparison> comparisons,
        CancellationToken cancellationToken
    )
    {
        if (_suiteTest is null)
        {
            return null;
        }

        var observations = new List<PairedObservation>();

        foreach (var comparison in comparisons)
        {
            // A null summary is exactly the set that must not contribute an observation:
            // New and Removed have no counterpart to pair against, and NotComparable has one
            // that cannot honestly be paired. Each would otherwise enter the test as a fabricated
            // pair and be conditioned on as though it were evidence.
            if (comparison.Comparison is null)
            {
                continue;
            }

            if (
                !baseline.TryGetValue(comparison.ScenarioId, out var before)
                || !candidate.TryGetValue(comparison.ScenarioId, out var after)
            )
            {
                continue;
            }

            var paired = Pair(before, after);

            observations.Add(
                new PairedObservation
                {
                    ScenarioId = comparison.ScenarioId,

                    // The seed of the scenario's first repetition. The pairing check has already
                    // confirmed every repetition's seed is identical on both sides, so this
                    // carries the audit trail the observation is required to.
                    Seed = before.Runs[0].Transcript.Seed,
                    BaselineValue = paired.Baseline.PassRate,
                    CandidateValue = paired.Candidate.PassRate,
                }
            );
        }

        if (observations.Count == 0)
        {
            // A degraded outcome, not a silent one (§IV). The result says so too, by carrying a
            // null suite delta rather than a zero.
            LogSuiteDeltaNotComputed(
                "no scenario appears in both artifacts in a form that can be compared, so there are no matched "
                    + "observations to test"
            );

            return null;
        }

        return _suiteTest.Compare(PairedObservations.Create(observations), cancellationToken);
    }

    private static string Render(long value) => value.ToString(CultureInfo.InvariantCulture);

    /// <summary>What one variant's runs of one scenario amounted to.</summary>
    private readonly record struct Evidence(int Graded, int Passed)
    {
        public ScenarioOutcome Outcome =>
            Graded == 0 ? ScenarioOutcome.Ungradeable
            : Passed == Graded ? ScenarioOutcome.Passed
            : ScenarioOutcome.Failed;

        /// <summary>The pass rate over the runs that produced a verdict.</summary>
        public double PassRate => Graded == 0 ? 0 : (double)Passed / Graded;
    }

    /// <summary>What the two variants amounted to over the repetitions they have in common.</summary>
    private readonly record struct PairedEvidence(
        Evidence Baseline,
        Evidence Candidate,
        int GradedPairs,
        int Regressed,
        int Fixed
    );

    // Composed entirely by this library, bar the scenario id it is reporting on — the same
    // material the artifact already carries as a join key (§V).

    [LoggerMessage(
        EventId = 1100,
        Level = LogLevel.Warning,
        Message = "Scenario {ScenarioId} was not compared: {Reason}"
    )]
    private partial void LogScenarioNotComparable(string scenarioId, string reason);

    [LoggerMessage(EventId = 1101, Level = LogLevel.Warning, Message = "No suite-wide delta was computed: {Detail}")]
    private partial void LogSuiteDeltaNotComputed(string detail);

    [LoggerMessage(
        EventId = 1102,
        Level = LogLevel.Warning,
        Message = "Scenario {ScenarioId} was not claimed as newly covered: {Reason}"
    )]
    private partial void LogCoverageWithheld(string scenarioId, string reason);
}
