using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;

namespace Forge.EvalEngine.Statistics;

/// <summary>
/// Collapses a scenario's repetitions into a single <see cref="StatisticalSummary"/>.
/// </summary>
/// <remarks>
/// <para>
/// <b>Repetition lives here, not in a runner.</b> A runner conducts exactly one execution and
/// knows nothing about how many times it will be asked. <see cref="RepetitionPolicy.Once"/> is
/// <see cref="RepetitionPolicy.Repeat(int)"/> of one, so a single-run REST scenario and a
/// twenty-run model scenario travel the same path through this type — there is no branch here
/// that reads "if this ran more than once".
/// </para>
/// <para>
/// <b>An ungradeable run is not evidence the system failed.</b> A run whose status is
/// <see cref="RunStatus.Error"/> never produced a verdict: the transport fell over, the
/// participant could not be built, or an assertion could not be evaluated. Counting it as a
/// failure would manufacture a regression out of a harness fault, and counting it as a pass
/// would manufacture a green. It is excluded from both the denominator and the estimate, so the
/// figures reported are conditional on the runs that actually produced evidence. The consequence
/// is visible rather than hidden: <see cref="StatisticalSummary.N"/> falls, the interval widens
/// to match the thinner evidence, and the errored runs remain in
/// <see cref="ScenarioResult.Runs"/> with their <see cref="RunResult.ErrorDetail"/> intact —
/// already logged once, by the coordinator, at the point it decided they had failed.
/// </para>
/// <para>
/// <b>When nothing is gradeable, nothing is reported.</b> A scenario whose every run errored has
/// no pass rate, so this returns <see langword="null"/> and
/// <see cref="ScenarioResult.Summary"/> stays unset. A zero would read as "the system failed
/// every time"; a NaN would not even serialize as valid JSON. Withholding the figure is the only
/// honest option, and it is the one T3 left room for.
/// </para>
/// <para>
/// <b><see cref="RunStatus.ExpectedFailure"/> counts as a graded non-pass.</b> The run happened
/// and the system did not do the right thing; that the gap was already known is a reporting
/// concern, not an estimation one.
/// </para>
/// <para>
/// <b>The four declared statuses are handled exhaustively and anything else is refused.</b> A
/// value outside the enum is not a verdict, and a rule phrased as "everything that is not an
/// error is graded" quietly turns one into a graded failure complete with a point estimate, a
/// dispersion and a confidence interval — an estimate manufactured from a value this domain
/// never defined, and indistinguishable in the committed artifact from a real one.
/// </para>
/// </remarks>
public sealed class ScenarioAggregator
{
    /// <summary>Initializes a new instance of the <see cref="ScenarioAggregator"/> class.</summary>
    /// <param name="intervalMethod">The interval method to compute and to stamp.</param>
    /// <param name="confidenceLevel">The two-sided confidence level, strictly between zero and one.</param>
    /// <exception cref="ArgumentOutOfRangeException">
    /// The method is not a declared <see cref="Results.IntervalMethod"/>, or the confidence level
    /// is not strictly between zero and one.
    /// </exception>
    public ScenarioAggregator(IntervalMethod intervalMethod, double confidenceLevel)
    {
        if (intervalMethod is not (IntervalMethod.Wilson or IntervalMethod.AgrestiCoull))
        {
            throw new ArgumentOutOfRangeException(nameof(intervalMethod), intervalMethod, "Unknown interval method.");
        }

        if (!(confidenceLevel > 0 && confidenceLevel < 1))
        {
            throw new ArgumentOutOfRangeException(
                nameof(confidenceLevel),
                confidenceLevel,
                "A confidence level must be strictly between zero and one."
            );
        }

        IntervalMethod = intervalMethod;
        ConfidenceLevel = confidenceLevel;
    }

    /// <summary>
    /// Gets the aggregator a caller gets without asking: a Wilson interval at 95% confidence.
    /// </summary>
    public static ScenarioAggregator Default { get; } =
        new(IntervalMethod.Wilson, ProportionInterval.DefaultConfidenceLevel);

    /// <summary>Gets the interval method this aggregator computes.</summary>
    public IntervalMethod IntervalMethod { get; }

    /// <summary>Gets the two-sided confidence level its intervals are computed at.</summary>
    /// <remarks>
    /// An interval means nothing without the level it was computed at, and
    /// <see cref="ConfidenceInterval"/> carries no room for one. The coordinator records this
    /// figure in <see cref="EvaluationEnvironment.HarnessConfig"/> instead.
    /// </remarks>
    public double ConfidenceLevel { get; }

    /// <summary>Summarizes one scenario's runs.</summary>
    /// <param name="runs">The runs, in execution order.</param>
    /// <returns>
    /// The aggregate, or <see langword="null"/> when no run produced a gradeable verdict.
    /// </returns>
    /// <exception cref="ArgumentNullException"><paramref name="runs"/> is null.</exception>
    /// <exception cref="ArgumentException">
    /// A run is null, or a run carries a status outside the declared
    /// <see cref="RunStatus"/> values.
    /// </exception>
    public StatisticalSummary? Summarize(IReadOnlyList<RunResult> runs)
    {
        ArgumentNullException.ThrowIfNull(runs);

        var graded = 0;
        var passed = 0;

        foreach (var run in runs)
        {
            if (run is null)
            {
                throw new ArgumentException("A run must not be null.", nameof(runs));
            }

            switch (run.Status)
            {
                // Error is the one status that produced no verdict about the system under test,
                // so it is the one status that does not reach the denominator.
                case RunStatus.Error:
                    break;

                case RunStatus.Pass:
                    graded++;
                    passed++;
                    break;

                // Both ran, and neither did the right thing.
                case RunStatus.Fail:
                case RunStatus.ExpectedFailure:
                    graded++;
                    break;

                // A value outside the declared enum is not a verdict. Falling through to the
                // graded branch would give an undefined status a point estimate, a dispersion
                // and a confidence interval — an estimate manufactured from a value this domain
                // never defined, and indistinguishable in the artifact from a real one.
                default:
                    throw new ArgumentException(
                        $"Run status '{run.Status}' is not a declared {nameof(RunStatus)}. A run whose verdict is "
                            + "undefined cannot be counted as a pass, as a failure, or as ungradeable.",
                        nameof(runs)
                    );
            }
        }

        if (graded == 0)
        {
            return null;
        }

        var estimate = (double)passed / graded;

        return new StatisticalSummary
        {
            N = graded,
            PointEstimate = estimate,

            // The population standard deviation of the Bernoulli sample, sqrt(p * (1 - p)) —
            // the figure T3 already committed to the artifact, where n = 5 at a pass rate of 0.8
            // carries a dispersion of 0.4. The Bessel-corrected form would report 0.4472 there
            // and would be undefined at a single repetition, which is the commonest case of all.
            Dispersion = Math.Sqrt(estimate * (1.0 - estimate)),
            Interval = ProportionInterval.Compute(passed, graded, IntervalMethod, ConfidenceLevel),

            // Comparing against a baseline needs a baseline. This stage has none, so it claims
            // nothing rather than reporting a delta against zero.
            Comparison = null,
        };
    }
}
