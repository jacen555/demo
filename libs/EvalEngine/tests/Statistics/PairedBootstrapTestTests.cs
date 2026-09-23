using FluentAssertions;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Statistics;

namespace Forge.EvalEngine.Tests.Statistics;

/// <summary>
/// The paired bootstrap, for per-scenario statistics that are not binary.
/// </summary>
/// <remarks>
/// <para>
/// A bootstrap has no closed-form answer to check against, so it is pinned two ways. First,
/// against an <b>external benchmark computed by a different method</b>: for a 100-scenario set
/// with mean difference 0.03 and population standard deviation 0.29597297173897485, the
/// normal-approximation two-sided p-value is 0.3107707612635575 (computed with Python 3.14's
/// <c>statistics.NormalDist</c>). The bootstrap of a mean is asymptotically equivalent to that,
/// so at n = 100 it must land on it. Second, against the <b>properties the procedure must have</b>
/// regardless of the resampling draw — reproducibility, the resolution floor, and the boundaries.
/// </para>
/// <para>
/// The p-value definition is the standard one for a bootstrap hypothesis test:
/// (1 + #{|t* - t| &gt;= |t|}) / (B + 1), from Davison, A.C. &amp; Hinkley, D.V. (1997),
/// <i>Bootstrap Methods and Their Application</i>, section 4.4.
/// </para>
/// </remarks>
public class PairedBootstrapTestTests
{
    private const long Seed = 20260923;

    /// <summary>
    /// The external cross-check. A tolerance of 0.03 is roughly six times the Monte Carlo
    /// standard error at B = 9999, so it is loose enough not to be flaky and far tighter than
    /// any genuine implementation error would be.
    /// </summary>
    [Fact]
    public void Compare_AHundredScenarios_ConvergesOnTheNormalApproximationPValue()
    {
        var comparison = new PairedBootstrapTest(Seed).Compare(
            StatisticsFixtures.Continuous(StatisticsFixtures.ConvergenceDifferences)
        );

        comparison.PValue.Should().BeApproximately(0.3107707612635575, 0.03);
        comparison.EffectSize.Should().BeApproximately(0.03, 1e-12);
        comparison.Test.Should().Be(SignificanceTestKind.PairedBootstrap);
        comparison.Significant.Should().Be(SignificanceVerdict.NotSignificant);
    }

    [Fact]
    public void Compare_TheSameSeed_ProducesTheSamePValueEveryTime()
    {
        var observations = StatisticsFixtures.Continuous(StatisticsFixtures.ConvergenceDifferences);

        var first = new PairedBootstrapTest(Seed).Compare(observations);
        var second = new PairedBootstrapTest(Seed).Compare(observations);

        second.PValue.Should().Be(first.PValue);
    }

    /// <summary>
    /// Reproducibility must come from the injected seed, not from the resampling happening to be
    /// stable. Different seeds have to move the answer, or the seed is not being used — checked
    /// across five of them, because two draws from the same distribution can coincide.
    /// </summary>
    [Fact]
    public void Compare_ADifferentSeed_ProducesADifferentDrawWithinMonteCarloError()
    {
        var observations = StatisticsFixtures.Continuous(StatisticsFixtures.ConvergenceDifferences);

        var drawn = Enumerable
            .Range(1, 5)
            .Select(seed => new PairedBootstrapTest(seed).Compare(observations).PValue!.Value)
            .ToArray();

        drawn.Distinct().Should().HaveCountGreaterThan(1, "the seed has to drive the resampling");
        (drawn.Max() - drawn.Min()).Should().BeLessThan(0.05, "every draw estimates the same quantity");
    }

    [Fact]
    public void Compare_Always_RunsTwiceOnOneInstanceWithoutCarryingStateBetweenTheRuns()
    {
        var test = new PairedBootstrapTest(Seed);
        var observations = StatisticsFixtures.Continuous(StatisticsFixtures.ConvergenceDifferences);

        test.Compare(observations).PValue.Should().Be(test.Compare(observations).PValue);
    }

    /// <summary>
    /// The boundary that would otherwise be catastrophic. With one scenario every resample is
    /// that same scenario, so the resampled statistic never moves, and the naive formula reports
    /// 1 / (B + 1) — a p-value of 0.0001 drawn from a single observation. Nothing is claimed
    /// instead.
    /// </summary>
    [Fact]
    public void Compare_ASingleScenario_ReportsNotComputedRatherThanACertaintyFromOneObservation()
    {
        var comparison = new PairedBootstrapTest(Seed).Compare(StatisticsFixtures.Continuous(0.9));

        comparison.PValue.Should().BeNull();
        comparison.Significant.Should().Be(SignificanceVerdict.NotComputed);
        comparison.Test.Should().BeNull();
        comparison.EffectSize.Should().Be(0.9, "the raw difference is still real and still reported");
    }

    /// <summary>
    /// <b>The case that made this test statistically wrong.</b> Two differences that both move
    /// the same way — 0.4 and 0.6 — have an observed mean of 0.5, while the four possible
    /// resample means are 0.4, 0.5, 0.5 and 0.6. Not one of them sits 0.5 or further from the
    /// observed mean, so the recentred null never reaches the observed effect and the bootstrap
    /// reports its resolution floor of 1 / (B + 1) = 0.0001 <i>deterministically</i>, whatever
    /// the evidence. A 5% test built on that would reject half the time.
    /// </summary>
    /// <remarks>
    /// The honest figure is derivable in one line, and this asserts the figure rather than its
    /// presence. Under the symmetric no-effect null a paired difference is as likely to fall
    /// negative as positive, so the 2^n sign assignments of the observed magnitudes are equally
    /// likely. The observed assignment and its complete negation both produce a mean at least as
    /// extreme as the observed one, so no exact two-sided randomization p-value can fall below
    /// 2 / 2^n = 2^(1-n). At n = 2 that bound is 0.5 — two equal-sign observations occur half the
    /// time — and exhaustive sign-flip enumeration over {0.4, 0.6} returns exactly 0.5, so the
    /// bound is attained here and not merely respected.
    /// </remarks>
    [Fact]
    public void Compare_TwoScenariosMovingTheSameWay_ReportsAHalfRatherThanTheBootstrapFloor()
    {
        var comparison = new PairedBootstrapTest(Seed).Compare(StatisticsFixtures.Continuous(0.4, 0.6));

        comparison.PValue.Should().Be(0.5, "two equal-sign differences occur half the time under a symmetric null");
        comparison.Significant.Should().Be(SignificanceVerdict.NotSignificant);
        comparison.EffectSize.Should().BeApproximately(0.5, 1e-15);
    }

    /// <summary>
    /// The same collapse at every small count, not only the one that was reported. A set whose
    /// differences all share a sign drives the recentred null entirely to one side, so the
    /// bootstrap alone reports 1 / (B + 1) at every n. For an all-same-sign set the exact
    /// sign-flip test attains the 2^(1-n) bound exactly — only the observed assignment and its
    /// negation are as extreme — so equality is asserted rather than an inequality.
    /// </summary>
    /// <remarks>
    /// Swept to twelve, comfortably inside the range where the randomization bound dominates the
    /// Monte Carlo floor: 2^(1-12) = 0.000488 against 1 / (9999 + 1) = 0.0001.
    /// </remarks>
    [Fact]
    public void Compare_DifferencesThatAllShareASign_ReportsTheExactSignFlipProbabilityAtEveryCount()
    {
        for (var count = 2; count <= 12; count++)
        {
            var comparison = new PairedBootstrapTest(Seed).Compare(
                StatisticsFixtures.Continuous(Enumerable.Range(0, count).Select(i => 0.4 + (i * 0.02)))
            );

            comparison.PValue.Should().Be(Math.Pow(2.0, 1 - count), $"count={count}");
        }
    }

    /// <summary>
    /// Where the bound bites, derived rather than chosen. A two-sided exact p-value cannot fall
    /// below 2^(1-n), so a 5% test can only ever reject once 2^(1-n) &lt;= 0.05 — that is
    /// n &gt;= 1 - log2(0.05) = 5.32, so six scenarios. At five, every difference pointing the
    /// same way is a one-in-sixteen event and must not be called significant.
    /// </summary>
    [Fact]
    public void Compare_FiveScenariosAllMovingTheSameWay_IsTooFewToReachSignificanceAtFivePercent()
    {
        var comparison = new PairedBootstrapTest(Seed).Compare(
            StatisticsFixtures.Continuous(0.40, 0.42, 0.44, 0.46, 0.48)
        );

        comparison.PValue.Should().Be(0.0625, "2^(1-5) — a one-in-sixteen event is not evidence at 5%");
        comparison.Significant.Should().Be(SignificanceVerdict.NotSignificant);
    }

    /// <summary>The first count at which a unanimous result may legitimately be called significant.</summary>
    [Fact]
    public void Compare_SixScenariosAllMovingTheSameWay_IsTheSmallestSetThatCanReachSignificance()
    {
        var comparison = new PairedBootstrapTest(Seed).Compare(
            StatisticsFixtures.Continuous(0.40, 0.42, 0.44, 0.46, 0.48, 0.50)
        );

        comparison.PValue.Should().Be(0.03125, "2^(1-6) — one in thirty-two, which clears 5%");
        comparison.Significant.Should().Be(SignificanceVerdict.Significant);
    }

    /// <summary>
    /// Both values are finite and pass <see cref="PairedObservations"/>' validation, but their
    /// difference is not: -MaxValue to +MaxValue overflows to infinity. Left unchecked the
    /// observed effect is infinite, every <c>|t* - t|</c> comparison evaluates to NaN, NaN is not
    /// greater than or equal to anything, so no resample counts as extreme and the procedure
    /// reports its floor as a <i>significant</i> result — a verdict manufactured out of an
    /// arithmetic overflow.
    /// </summary>
    [Fact]
    public void Compare_ADifferenceThatOverflowsToInfinity_ThrowsArgumentExceptionRatherThanReportingAVerdict()
    {
        var observations = PairedObservations.Create([
            new PairedObservation
            {
                ScenarioId = "overflows",
                Seed = 1,
                BaselineValue = -double.MaxValue,
                CandidateValue = double.MaxValue,
            },
            new PairedObservation
            {
                ScenarioId = "ordinary",
                Seed = 2,
                BaselineValue = 0,
                CandidateValue = 1,
            },
        ]);

        Action compare = () => new PairedBootstrapTest(Seed).Compare(observations);

        compare.Should().Throw<ArgumentException>().WithMessage("*finite*");
    }

    /// <summary>
    /// Every difference here is finite and their naive total is not: eight values of 1e308 sum to
    /// 8e308, which overflows to infinity before the division by n ever happens. The mean has to
    /// be accumulated so that the running figure never leaves the range of the values themselves.
    /// </summary>
    [Fact]
    public void Compare_ExtremeFiniteDifferences_ReportsAFiniteEffectSizeRatherThanOverflowingTheTotal()
    {
        var comparison = new PairedBootstrapTest(Seed, 199, 0.05).Compare(
            StatisticsFixtures.Continuous(Enumerable.Repeat(1e308, 8))
        );

        double.IsFinite(comparison.EffectSize).Should().BeTrue("eight finite differences have a finite mean");
        comparison.EffectSize.Should().Be(1e308);
        comparison.PValue!.Value.Should().Be(0.0078125, "2^(1-8) — eight same-sign differences, one in 128");
    }

    /// <summary>
    /// No observed difference at all is the null hypothesis exactly, and every resample of it is
    /// also zero, so the procedure must report the largest p-value it can rather than the
    /// smallest.
    /// </summary>
    [Fact]
    public void Compare_NoDifferenceAnywhere_ReportsAPValueOfOne()
    {
        var comparison = new PairedBootstrapTest(Seed).Compare(StatisticsFixtures.Continuous(0, 0, 0, 0, 0));

        comparison.EffectSize.Should().Be(0);
        comparison.PValue.Should().Be(1);
        comparison.Significant.Should().Be(SignificanceVerdict.NotSignificant);
    }

    /// <summary>
    /// A bootstrap cannot resolve a p-value finer than one resample, so it never reports one
    /// below 1 / (B + 1). Claiming 1e-9 from 9999 resamples would be reporting a precision that
    /// was never computed.
    /// </summary>
    [Fact]
    public void Compare_OverwhelminglySeparatedScenarios_IsFlooredAtOneOverTheResampleCountPlusOne()
    {
        var differences = Enumerable.Range(0, 60).Select(i => 5.0 + (i * 0.001));

        var comparison = new PairedBootstrapTest(Seed, 999, 0.05).Compare(StatisticsFixtures.Continuous(differences));

        comparison.PValue.Should().Be(1.0 / 1000.0);
        comparison.Significant.Should().Be(SignificanceVerdict.Significant);
    }

    /// <summary>
    /// A paired bootstrap over binary outcomes is legitimate — it is a bootstrap of the
    /// difference in pass rate — so unlike McNemar it accepts them rather than refusing.
    /// </summary>
    [Fact]
    public void Compare_BinaryOutcomes_IsAcceptedAndAgreesWithMcNemarOnTheDirection()
    {
        var observations = StatisticsFixtures.Table(baselineOnly: 4, candidateOnly: 16, bothPass: 20, bothFail: 20);

        var bootstrap = new PairedBootstrapTest(Seed).Compare(observations);

        bootstrap.EffectSize.Should().BeApproximately(0.2, 1e-15);
        bootstrap.PValue.Should().BeLessThan(0.05);
        bootstrap.Significant.Should().Be(SignificanceVerdict.Significant);
    }

    /// <summary>
    /// The exact test against values a reader can redo by hand in rational arithmetic, which is
    /// the only way to pin it without asserting that the code agrees with itself. With
    /// magnitudes 1, 1 and 2 the eight signed sums are +/-4, +/-2, +/-2 and 0, 0; the observed
    /// sum of 4 is matched or exceeded by two of them, so p = 2/8. Flip the middle difference
    /// and the observed sum is 2, matched or exceeded by six of the eight, so p = 6/8. Two
    /// differences pointing opposite ways can never be beaten by any assignment, so p = 1.
    /// </summary>
    [Theory]
    [InlineData(new[] { 1.0, 1.0, 2.0 }, 0.25)]
    [InlineData(new[] { 1.0, -1.0, 2.0 }, 0.75)]
    [InlineData(new[] { -0.4, 0.6 }, 1.0)]
    public void Compare_ASmallSet_ReportsTheExactSignFlipProbability(double[] differences, double expected)
    {
        var comparison = new PairedBootstrapTest(Seed).Compare(StatisticsFixtures.Continuous(differences));

        comparison.PValue.Should().Be(expected);
    }

    /// <summary>
    /// The exact test enumerates every sign assignment, so it has no randomness in it at all and
    /// the seed cannot move the answer. Above the threshold the bootstrap resumes and the seed
    /// matters again — which the seed-sensitivity test at a hundred scenarios covers.
    /// </summary>
    [Fact]
    public void Compare_AtOrBelowTheExactThreshold_IgnoresTheSeedBecauseTheAnswerIsExact()
    {
        var observations = StatisticsFixtures.Continuous(0.3, -0.1, 0.8, 0.2, 0.5, -0.4, 0.9);

        var drawn = Enumerable
            .Range(1, 5)
            .Select(seed => new PairedBootstrapTest(seed).Compare(observations).PValue!.Value)
            .ToArray();

        drawn.Distinct().Should().ContainSingle("an exhaustive enumeration has nothing left to randomize");
    }

    /// <summary>
    /// The boundary between the two procedures, pinned from both sides. At the threshold a
    /// unanimous set is enumerated exactly and only the two extreme assignments qualify, giving
    /// 2 / 2^20 = 2^-19. One scenario further the bootstrap resumes, cannot reach the observed
    /// effect, and reports its resolution floor of 1 / (B + 1) — which at 21 scenarios is a
    /// genuine limit of the resampling rather than the miscalibration this guards against, since
    /// 2^-20 sits below it.
    /// </summary>
    [Fact]
    public void Compare_AtTheExactThreshold_ReportsTheExactProbability()
    {
        var comparison = new PairedBootstrapTest(Seed).Compare(
            StatisticsFixtures.Continuous(
                Enumerable.Range(0, PairedBootstrapTest.ExactScenarios).Select(i => 0.4 + (i * 0.02))
            )
        );

        comparison.PValue.Should().Be(Math.Pow(2.0, 1 - PairedBootstrapTest.ExactScenarios));
    }

    [Fact]
    public void Compare_JustAboveTheExactThreshold_FallsBackToTheBootstrap()
    {
        var comparison = new PairedBootstrapTest(Seed).Compare(
            StatisticsFixtures.Continuous(
                Enumerable.Range(0, PairedBootstrapTest.ExactScenarios + 1).Select(i => 0.4 + (i * 0.02))
            )
        );

        comparison.PValue.Should().Be(1.0 / (PairedBootstrapTest.DefaultResamples + 1.0));
    }

    /// <summary>
    /// The property that actually matters, asserted directly rather than inferred: against a
    /// symmetric no-effect null, a 5% test must reject at most 5% of the time. The uncorrected
    /// procedure rejected roughly half the time at two scenarios. The differences are built by
    /// sign-flipping a fixed set of magnitudes, which is exactly the null the test assumes, so
    /// the rejection rate is checked over every one of the 2^n possible null datasets rather
    /// than over a sample of them — no randomness, no flake.
    /// </summary>
    [Theory]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    [InlineData(6)]
    [InlineData(8)]
    [InlineData(10)]
    public void Compare_EveryDatasetASymmetricNullCanProduce_RejectsAtMostFivePercentOfTheTime(int count)
    {
        var magnitudes = Enumerable.Range(0, count).Select(i => 0.5 + (i * 0.37)).ToArray();
        var test = new PairedBootstrapTest(Seed);
        var total = 1 << count;
        var rejected = 0;

        for (var assignment = 0; assignment < total; assignment++)
        {
            var differences = magnitudes.Select((m, i) => ((assignment >> i) & 1) == 1 ? m : -m);

            if (test.Compare(StatisticsFixtures.Continuous(differences)).Significant == SignificanceVerdict.Significant)
            {
                rejected++;
            }
        }

        ((double)rejected / total)
            .Should()
            .BeLessThanOrEqualTo(0.05, $"a 5% test over all {total} null datasets at count={count}");
    }

    [Fact]
    public void Compare_Always_ReportsAFiniteProbabilityForEverySmallSet()
    {
        for (var count = 2; count <= 12; count++)
        {
            var comparison = new PairedBootstrapTest(Seed, 199, 0.05).Compare(
                StatisticsFixtures.Continuous(Enumerable.Range(0, count).Select(i => (i % 3) - 1.0))
            );

            var p = comparison.PValue!.Value;
            double.IsFinite(p).Should().BeTrue($"count={count}");
            p.Should().BeInRange(1.0 / 200.0, 1, $"count={count}");
        }
    }

    /// <summary>A large bootstrap is the one computation here long enough to be worth cancelling.</summary>
    [Fact]
    public void Compare_CancelledToken_ThrowsOperationCanceledException()
    {
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();

        Action compare = () =>
            new PairedBootstrapTest(Seed).Compare(
                StatisticsFixtures.Continuous(StatisticsFixtures.ConvergenceDifferences),
                cancelled.Token
            );

        compare.Should().Throw<OperationCanceledException>();
    }

    /// <summary>
    /// The seed and the resample count are what make this run reproducible, so an instance has
    /// to be able to state them — there is nowhere in the committed artifact's shape to put them.
    /// </summary>
    [Fact]
    public void Constructor_Always_StampsTheSeedAndResampleCountItWillUse()
    {
        var test = new PairedBootstrapTest(4242);

        test.Seed.Should().Be(4242);
        test.Resamples.Should().Be(PairedBootstrapTest.DefaultResamples);
        test.SignificanceLevel.Should().Be(0.05);
        test.Kind.Should().Be(SignificanceTestKind.PairedBootstrap);
    }

    [Fact]
    public void Compare_NullObservations_ThrowsArgumentNullException()
    {
        Action compare = () => new PairedBootstrapTest(Seed).Compare(null!);

        compare.Should().Throw<ArgumentNullException>();
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void Constructor_NonPositiveResampleCount_ThrowsArgumentOutOfRangeException(int resamples)
    {
        Action construct = () => _ = new PairedBootstrapTest(Seed, resamples, 0.05);

        construct.Should().Throw<ArgumentOutOfRangeException>();
    }

    [Theory]
    [InlineData(0.0)]
    [InlineData(1.0)]
    [InlineData(double.NaN)]
    public void Constructor_SignificanceLevelOutsideTheOpenUnitInterval_ThrowsArgumentOutOfRangeException(double level)
    {
        Action construct = () => _ = new PairedBootstrapTest(Seed, 999, level);

        construct.Should().Throw<ArgumentOutOfRangeException>();
    }
}
