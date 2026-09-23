using FluentAssertions;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Assertions;
using NSubstitute;

namespace Forge.EvalEngine.Tests.Assertions;

/// <summary>
/// Dispatch rules. The one that matters most is that an unrecognised category is refused —
/// a typo'd assertion that always passes is worse than one that always fails.
/// </summary>
public class AssertionEvaluatorRegistryTests
{
    private static AssertionEvaluatorRegistry Registry => AssertionEvaluatorRegistry.CreateDefault();

    private static IAssertionEvaluator Stub(string category, AssertionCategory family = AssertionCategory.ExactMatch)
    {
        var evaluator = Substitute.For<IAssertionEvaluator>();
        evaluator.Category.Returns(category);
        evaluator.Family.Returns(family);
        return evaluator;
    }

    /// <summary>A hand-written evaluator, so the dispatch test does not depend on a mock's
    /// handling of <see cref="ValueTask{TResult}"/>, which may only be consumed once.</summary>
    private sealed class FixedEvaluator(string category, AssertionResult result) : IAssertionEvaluator
    {
        public string Category => category;

        public AssertionCategory Family => AssertionCategory.ExactMatch;

        public ValueTask<AssertionResult> EvaluateAsync(
            AssertionSpec spec,
            EvaluationContext context,
            CancellationToken cancellationToken
        ) => new(result);
    }

    // -------------------------------------------------------------------------------------
    // One evaluator per category, registered by key.
    // -------------------------------------------------------------------------------------

    [Fact]
    public void CreateDefault_Always_RegistersExactlyOneEvaluatorPerAssertionFamily()
    {
        var registry = Registry;

        var families = registry
            .Categories.Select(category =>
            {
                registry.TryGetEvaluator(category, out var evaluator).Should().BeTrue();
                return evaluator!.Family;
            })
            .ToArray();

        families.Should().BeEquivalentTo(Enum.GetValues<AssertionCategory>());
        families.Should().OnlyHaveUniqueItems("a family served by two evaluators is a code fork waiting to happen");
    }

    [Fact]
    public void Categories_Always_ReturnsTheRegisteredTokensInOrdinalOrder()
    {
        var categories = Registry.Categories;

        categories.Should().BeInAscendingOrder(StringComparer.Ordinal);
        categories.Should().OnlyHaveUniqueItems();
    }

    [Fact]
    public void TryGetEvaluator_KnownCategory_ReturnsTheEvaluatorDeclaringThatCategory()
    {
        Registry.TryGetEvaluator("presence", out var evaluator).Should().BeTrue();

        evaluator.Should().NotBeNull();
        evaluator!.Category.Should().Be("presence");
        evaluator.Family.Should().Be(AssertionCategory.PresenceAbsence);
    }

    // -------------------------------------------------------------------------------------
    // An unknown category is refused, not silently passed.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task EvaluateAsync_UnknownCategory_ThrowsRatherThanReturningAPass()
    {
        var act = async () =>
            await Registry.EvaluateAsync(
                AssertionSpec.Parse("slotAbsent:scope/confirm"),
                Evidence.Context(),
                CancellationToken.None
            );

        await act.Should().ThrowAsync<AssertionEvaluationException>();
    }

    [Fact]
    public async Task EvaluateAsync_UnknownCategory_NamesTheCategoryAndTheKnownOnes()
    {
        var act = async () =>
            await Registry.EvaluateAsync(AssertionSpec.Parse("typo:x"), Evidence.Context(), CancellationToken.None);

        (await act.Should().ThrowAsync<AssertionEvaluationException>())
            .Which.Message.Should()
            .Contain("typo")
            .And.Contain("presence", "a suite author needs to see what they could have meant");
    }

    [Fact]
    public async Task EvaluateAsync_CategoryDifferingOnlyInCase_IsRefusedAsUnknown()
    {
        var act = async () =>
            await Registry.EvaluateAsync(
                AssertionSpec.Parse("ExactMatch:outcome"),
                Evidence.Context(),
                CancellationToken.None
            );

        await act.Should().ThrowAsync<AssertionEvaluationException>();
    }

    [Fact]
    public void TryGetEvaluator_UnknownCategory_ReturnsFalseAndNoEvaluator()
    {
        Registry.TryGetEvaluator("nope", out var evaluator).Should().BeFalse();

        evaluator.Should().BeNull();
    }

    [Fact]
    public void TryGetEvaluator_NullCategory_ThrowsArgumentNullException()
    {
        Action act = () => Registry.TryGetEvaluator(null!, out _);

        act.Should().Throw<ArgumentNullException>();
    }

    // -------------------------------------------------------------------------------------
    // Registration is validated, so which evaluator runs never depends on ordering.
    // -------------------------------------------------------------------------------------

    [Fact]
    public void Constructor_TwoEvaluatorsDeclaringTheSameCategory_ThrowsArgumentException()
    {
        Action act = () => _ = new AssertionEvaluatorRegistry([Stub("duplicated"), Stub("duplicated")]);

        act.Should().Throw<ArgumentException>().WithMessage("*duplicated*");
    }

    [Fact]
    public void Constructor_NullEvaluatorInTheCollection_ThrowsArgumentException()
    {
        Action act = () => _ = new AssertionEvaluatorRegistry([Stub("fine"), null!]);

        act.Should().Throw<ArgumentException>();
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Constructor_EvaluatorDeclaringABlankCategory_ThrowsArgumentException(string category)
    {
        Action act = () => _ = new AssertionEvaluatorRegistry([Stub(category)]);

        act.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void Constructor_EvaluatorDeclaringANullCategory_ThrowsArgumentException()
    {
        Action act = () => _ = new AssertionEvaluatorRegistry([Stub(null!)]);

        act.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void Constructor_NullCollection_ThrowsArgumentNullException()
    {
        Action act = () => _ = new AssertionEvaluatorRegistry(null!);

        act.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Constructor_EmptyCollection_RegistersNothingRatherThanFailing()
    {
        var registry = new AssertionEvaluatorRegistry([]);

        registry.Categories.Should().BeEmpty();
    }

    [Fact]
    public async Task EvaluateAsync_CustomEvaluator_IsDispatchedToByItsCategory()
    {
        var expected = new AssertionResult { Spec = AssertionSpec.Parse("custom:x"), Pass = true };
        var registry = new AssertionEvaluatorRegistry([new FixedEvaluator("custom", expected)]);

        var result = await registry.EvaluateAsync(
            AssertionSpec.Parse("custom:x"),
            Evidence.Context(),
            CancellationToken.None
        );

        result.Should().BeSameAs(expected);
    }

    // -------------------------------------------------------------------------------------
    // Argument and cancellation discipline.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task EvaluateAsync_NullSpec_ThrowsArgumentNullException()
    {
        var act = async () => await Registry.EvaluateAsync(null!, Evidence.Context(), CancellationToken.None);

        await act.Should().ThrowAsync<ArgumentNullException>();
    }

    [Fact]
    public async Task EvaluateAsync_NullContext_ThrowsArgumentNullException()
    {
        var act = async () =>
            await Registry.EvaluateAsync(AssertionSpec.Parse("exactMatch:outcome"), null!, CancellationToken.None);

        await act.Should().ThrowAsync<ArgumentNullException>();
    }

    [Fact]
    public async Task EvaluateAsync_AlreadyCancelledToken_ThrowsOperationCanceledException()
    {
        using var source = new CancellationTokenSource();
        await source.CancelAsync();

        var act = async () =>
            await Registry.EvaluateAsync(
                AssertionSpec.Parse("exactMatch:outcome"),
                Evidence.Context(grading: new Scenarios.Grading { ExpectedOutcome = "resolved" }),
                source.Token
            );

        await act.Should().ThrowAsync<OperationCanceledException>();
    }

    [Fact]
    public async Task EvaluateAsync_AlreadyCancelledTokenAndUnknownCategory_StillObservesCancellation()
    {
        using var source = new CancellationTokenSource();
        await source.CancelAsync();

        var act = async () =>
            await Registry.EvaluateAsync(AssertionSpec.Parse("nope:x"), Evidence.Context(), source.Token);

        await act.Should().ThrowAsync<OperationCanceledException>();
    }

    [Theory]
    [InlineData("exactMatch")]
    [InlineData("structural")]
    [InlineData("presence")]
    [InlineData("baseline")]
    [InlineData("expectedBehavior")]
    public async Task EvaluateAsync_EvaluatorResolvedDirectlyWithACancelledToken_ObservesCancellation(string category)
    {
        Registry.TryGetEvaluator(category, out var evaluator).Should().BeTrue();

        using var source = new CancellationTokenSource();
        await source.CancelAsync();

        var act = async () =>
            await evaluator!.EvaluateAsync(
                AssertionSpec.Parse($"{category}:anything"),
                Evidence.Context(),
                source.Token
            );

        await act.Should()
            .ThrowAsync<OperationCanceledException>("cancellation is checked before any parameter is read");
    }
}
