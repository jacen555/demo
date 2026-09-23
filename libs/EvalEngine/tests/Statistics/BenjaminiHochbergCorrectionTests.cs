using FluentAssertions;
using Forge.EvalEngine.Statistics;

namespace Forge.EvalEngine.Tests.Statistics;

/// <summary>
/// Benjamini-Hochberg false-discovery-rate correction.
/// </summary>
/// <remarks>
/// <para>
/// The worked example is the one in the original paper: <b>Benjamini, Y. &amp; Hochberg, Y.
/// (1995), "Controlling the False Discovery Rate: A Practical and Powerful Approach to Multiple
/// Testing", Journal of the Royal Statistical Society Series B 57(1):289-300</b>, whose Table 1
/// carries fifteen p-values from a cardiology trial (Neuhaus et al., 1992). The paper states
/// that at a false-discovery rate of 0.05 its procedure rejects <b>four</b> hypotheses where
/// Bonferroni rejects three. Both counts are re-derived here from the p-value vector, so the
/// vector and the published claim corroborate each other.
/// </para>
/// <para>
/// The adjusted values themselves are not printed in the paper — it reports the rejection
/// decision, not the adjusted p-values — so those expectations were computed by an independent
/// implementation of the step-up procedure (Python 3.14) matching the definition used by R's
/// <c>p.adjust(method = "BH")</c>. That is stated rather than dressed up as a published table.
/// </para>
/// </remarks>
public class BenjaminiHochbergCorrectionTests
{
    /// <summary>Benjamini &amp; Hochberg (1995), Table 1.</summary>
    private static readonly double[] PublishedPValues =
    [
        0.0001,
        0.0004,
        0.0019,
        0.0095,
        0.0201,
        0.0278,
        0.0298,
        0.0344,
        0.0459,
        0.3240,
        0.4262,
        0.5719,
        0.6528,
        0.7590,
        1.0000,
    ];

    /// <summary>
    /// The paper's headline claim, re-derived: four discoveries at a false-discovery rate of
    /// 0.05, against Bonferroni's three. That gap is the entire reason this harness corrects with
    /// BH rather than Bonferroni.
    /// </summary>
    [Fact]
    public void Adjust_TheNineteenNinetyFivePaperExample_RejectsTheFourHypothesesThePaperReports()
    {
        var adjusted = BenjaminiHochbergCorrection.Instance.Adjust(PublishedPValues);

        adjusted.Count(value => value <= 0.05).Should().Be(4, "Benjamini & Hochberg (1995) report four discoveries");
        PublishedPValues
            .Count(value => value <= 0.05 / PublishedPValues.Length)
            .Should()
            .Be(3, "Bonferroni at the same level rejects three, which is the sensitivity being traded for");
    }

    /// <summary>
    /// The step-up procedure to full precision. The seventh and eighth entries matter most: the
    /// raw ratio at rank six is 0.0695 and at rank seven is 0.06386, so a naive implementation
    /// that only scales by m/i reports a <i>larger</i> adjusted value for a <i>smaller</i>
    /// p-value. The running minimum from the top is what stops that, and this is where it bites.
    /// </summary>
    [Fact]
    public void Adjust_TheNineteenNinetyFivePaperExample_MatchesTheStepUpProcedure()
    {
        double[] expected =
        [
            0.0015,
            0.003,
            0.0095,
            0.035625,
            0.0603,
            0.06385714285714286,
            0.06385714285714286,
            0.0645,
            0.0765,
            0.48600000000000004,
            0.5811818181818182,
            0.714875,
            0.7532307692307694,
            0.8132142857142857,
            1.0,
        ];

        var adjusted = BenjaminiHochbergCorrection.Instance.Adjust(PublishedPValues);

        adjusted.Should().HaveCount(expected.Length);

        for (var i = 0; i < expected.Length; i++)
        {
            adjusted[i].Should().BeApproximately(expected[i], 1e-15, $"index {i}");
        }

        adjusted[5].Should().Be(adjusted[6], "the running minimum ties rank six to rank seven");
    }

    /// <summary>
    /// The monotonicity guard, stated as the property rather than as a single pair of numbers:
    /// a smaller p-value can never receive a larger adjusted value.
    /// </summary>
    [Fact]
    public void Adjust_Always_IsMonotoneInTheUnderlyingPValues()
    {
        var adjusted = BenjaminiHochbergCorrection.Instance.Adjust(PublishedPValues);

        for (var i = 1; i < PublishedPValues.Length; i++)
        {
            adjusted[i].Should().BeGreaterThanOrEqualTo(adjusted[i - 1], $"p[{i}] >= p[{i - 1}]");
        }
    }

    /// <summary>
    /// A hand-checkable vector: five evenly spaced p-values whose ratios p * m / i are all
    /// exactly 0.05, so every adjusted value must be 0.05.
    /// </summary>
    [Fact]
    public void Adjust_EvenlySpacedPValues_CollapseToTheSameAdjustedValue()
    {
        BenjaminiHochbergCorrection
            .Instance.Adjust([0.01, 0.02, 0.03, 0.04, 0.05])
            .Should()
            .AllSatisfy(value => value.Should().BeApproximately(0.05, 1e-15));
    }

    /// <summary>Reference: an independent implementation of the step-up procedure.</summary>
    [Fact]
    public void Adjust_AMixedFamily_MatchesTheReferenceImplementation()
    {
        var adjusted = BenjaminiHochbergCorrection.Instance.Adjust([0.005, 0.011, 0.02, 0.04, 0.13]);

        adjusted[0].Should().BeApproximately(0.025, 1e-15);
        adjusted[1].Should().BeApproximately(0.0275, 1e-15);
        adjusted[2].Should().BeApproximately(0.03333333333333333, 1e-15);
        adjusted[3].Should().BeApproximately(0.05, 1e-15);
        adjusted[4].Should().BeApproximately(0.13, 1e-15);
    }

    /// <summary>
    /// The input order is the caller's scenario order and the output has to line up with it, so
    /// the internal sort must not leak. The same family shuffled must adjust to the same values,
    /// permuted the same way.
    /// </summary>
    [Fact]
    public void Adjust_UnsortedInput_ReturnsAdjustedValuesInTheOrderTheyWereSupplied()
    {
        var adjusted = BenjaminiHochbergCorrection.Instance.Adjust([0.9, 0.01, 0.13, 0.005, 0.02]);

        adjusted[3].Should().BeApproximately(0.025, 1e-15);
        adjusted[1].Should().BeApproximately(0.025, 1e-15);
        adjusted[4].Should().BeApproximately(0.03333333333333333, 1e-15);
        adjusted[2].Should().BeApproximately(0.1625, 1e-15);
        adjusted[0].Should().BeApproximately(0.9, 1e-15);
    }

    [Fact]
    public void Adjust_TiedPValues_ReceiveTheSameAdjustedValue()
    {
        BenjaminiHochbergCorrection.Instance.Adjust([0.02, 0.02]).Should().Equal(0.02, 0.02);
    }

    [Fact]
    public void Adjust_ASingleHypothesis_LeavesItUnchanged()
    {
        BenjaminiHochbergCorrection.Instance.Adjust([0.04]).Should().Equal(0.04);
    }

    /// <summary>
    /// An empty family is a suite where nothing was compared, not an error. It corrects to
    /// nothing.
    /// </summary>
    [Fact]
    public void Adjust_NoPValues_ReturnsNothing()
    {
        BenjaminiHochbergCorrection.Instance.Adjust([]).Should().BeEmpty();
    }

    /// <summary>
    /// The scaling m / i drives values above one for a large family of weak results. An
    /// "adjusted p-value" of 3.2 is not a probability.
    /// </summary>
    [Fact]
    public void Adjust_WeakResultsInALargeFamily_ClampsAtOne()
    {
        var adjusted = BenjaminiHochbergCorrection.Instance.Adjust([0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);

        adjusted.Should().AllSatisfy(value => value.Should().BeInRange(0, 1));
        adjusted[^1].Should().BeApproximately(0.9, 1e-15);
    }

    /// <summary>A correction can only ever be conservative: no adjusted value undercuts its input.</summary>
    [Fact]
    public void Adjust_Always_ReturnsValuesNoSmallerThanTheOnesItWasGiven()
    {
        var adjusted = BenjaminiHochbergCorrection.Instance.Adjust(PublishedPValues);

        for (var i = 0; i < PublishedPValues.Length; i++)
        {
            adjusted[i].Should().BeGreaterThanOrEqualTo(PublishedPValues[i] - 1e-15, $"index {i}");
        }
    }

    [Fact]
    public void Adjust_NullFamily_ThrowsArgumentNullException()
    {
        Action adjust = () => BenjaminiHochbergCorrection.Instance.Adjust(null!);

        adjust.Should().Throw<ArgumentNullException>();
    }

    [Theory]
    [InlineData(-0.1)]
    [InlineData(1.1)]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    public void Adjust_AValueThatIsNotAProbability_ThrowsArgumentException(double value)
    {
        Action adjust = () => BenjaminiHochbergCorrection.Instance.Adjust([0.01, value, 0.5]);

        adjust.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void Name_Always_NamesTheProcedureForTheArtifact()
    {
        BenjaminiHochbergCorrection.Instance.Name.Should().Be("benjamini-hochberg");
    }
}
