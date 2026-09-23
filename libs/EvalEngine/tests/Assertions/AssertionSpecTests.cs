using FluentAssertions;
using Forge.EvalEngine.Assertions;

namespace Forge.EvalEngine.Tests.Assertions;

public class AssertionSpecTests
{
    [Fact]
    public void Parse_CategoryWithParameter_SplitsOnFirstColon()
    {
        var spec = AssertionSpec.Parse("slotAbsent:scope/confirm");

        spec.Category.Should().Be("slotAbsent");
        spec.Parameter.Should().Be("scope/confirm");
        spec.Polarity.Should().BeNull();
        spec.TurnDependency.Should().BeNull();
    }

    [Fact]
    public void Parse_ParameterContainingColon_KeepsRemainderVerbatim()
    {
        var spec = AssertionSpec.Parse("escalateReasonIs:out:of:scope");

        spec.Category.Should().Be("escalateReasonIs");
        spec.Parameter.Should().Be("out:of:scope");
    }

    [Fact]
    public void Parse_ParameterContainingSlash_KeepsRemainderVerbatim()
    {
        AssertionSpec.Parse("slotPresent:a/b/c").Parameter.Should().Be("a/b/c");
    }

    [Fact]
    public void Parse_CategoryWithoutParameter_LeavesParameterNull()
    {
        var spec = AssertionSpec.Parse("reachedTerminalOutcome");

        spec.Category.Should().Be("reachedTerminalOutcome");
        spec.Parameter.Should().BeNull();
    }

    [Fact]
    public void Parse_NumericParameter_KeepsItAsText()
    {
        AssertionSpec.Parse("reachedDepth:4").Parameter.Should().Be("4");
    }

    [Fact]
    public void Parse_NegationPrefix_SetsNegativePolarity()
    {
        var spec = AssertionSpec.Parse("!slotAbsent:scope/confirm");

        spec.Polarity.Should().Be(AssertionPolarity.Negative);
        spec.Category.Should().Be("slotAbsent");
        spec.Parameter.Should().Be("scope/confirm");
    }

    [Fact]
    public void Parse_AffirmationPrefix_SetsPositivePolarity()
    {
        var spec = AssertionSpec.Parse("+slotAbsent:scope/confirm");

        spec.Polarity.Should().Be(AssertionPolarity.Positive);
        spec.Category.Should().Be("slotAbsent");
    }

    [Fact]
    public void Parse_PrefixCharacterAfterColon_IsPartOfTheParameter()
    {
        var spec = AssertionSpec.Parse("contains:!literal");

        spec.Polarity.Should().BeNull();
        spec.Parameter.Should().Be("!literal");
    }

    [Fact]
    public void Parse_SurroundingWhitespace_IsTrimmed()
    {
        var spec = AssertionSpec.Parse("  slotAbsent:scope/confirm  ");

        spec.Category.Should().Be("slotAbsent");
        spec.Parameter.Should().Be("scope/confirm");
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("!")]
    [InlineData("+")]
    [InlineData(":")]
    [InlineData(":parameter")]
    [InlineData("!:parameter")]
    [InlineData("9startsWithDigit")]
    [InlineData("has space:x")]
    [InlineData("!!doubleNegated")]
    public void Parse_MalformedExpression_ThrowsFormatException(string expression)
    {
        Action parse = () => AssertionSpec.Parse(expression);

        parse.Should().Throw<FormatException>();
    }

    [Fact]
    public void Parse_TrailingColonWithNoParameter_ThrowsFormatException()
    {
        Action parse = () => AssertionSpec.Parse("reachedDepth:");

        parse.Should().Throw<FormatException>();
    }

    [Fact]
    public void Parse_NullExpression_ThrowsArgumentNullException()
    {
        Action parse = () => AssertionSpec.Parse(null!);

        parse.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void TryParse_ValidExpression_ReturnsTrueWithSpecAndNoError()
    {
        var parsed = AssertionSpec.TryParse("slotAbsent:scope/confirm", out var spec, out var error);

        parsed.Should().BeTrue();
        spec.Should().NotBeNull();
        error.Should().BeNull();
    }

    [Fact]
    public void TryParse_MalformedExpression_ReturnsFalseWithExplanation()
    {
        var parsed = AssertionSpec.TryParse("!:nope", out var spec, out var error);

        parsed.Should().BeFalse();
        spec.Should().BeNull();
        error.Should().NotBeNullOrWhiteSpace();
    }

    [Fact]
    public void TryParse_NullExpression_ReturnsFalseWithExplanation()
    {
        AssertionSpec.TryParse(null, out _, out var error).Should().BeFalse();

        error.Should().NotBeNullOrWhiteSpace();
    }

    [Theory]
    [InlineData("slotAbsent:scope/confirm")]
    [InlineData("reachedDepth:4")]
    [InlineData("escalateReasonIs:out_of_scope")]
    [InlineData("escalateReasonIs:out:of:scope")]
    [InlineData("reachedTerminalOutcome")]
    [InlineData("!slotAbsent:scope/confirm")]
    [InlineData("+slotAbsent:scope/confirm")]
    [InlineData("!reachedTerminalOutcome")]
    [InlineData("contains:!literal")]
    public void ToExpression_AfterParse_RoundTripsExactly(string expression)
    {
        AssertionSpec.Parse(expression).ToExpression().Should().Be(expression);
    }

    [Fact]
    public void ToExpression_TurnDependency_IsNotPartOfTheExpression()
    {
        var spec = AssertionSpec.Parse("reachedDepth:4") with { TurnDependency = 4 };

        spec.ToExpression().Should().Be("reachedDepth:4");
    }
}
