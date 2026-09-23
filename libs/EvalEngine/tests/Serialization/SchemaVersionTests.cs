using FluentAssertions;
using Forge.EvalEngine.Serialization;

namespace Forge.EvalEngine.Tests.Serialization;

/// <summary>
/// Schema version support.
/// </summary>
/// <remarks>
/// A durable artifact outlives the code that wrote it. A reader that does not check the version
/// will happily misread a future shape and report a confident wrong answer.
/// </remarks>
public class SchemaVersionTests
{
    [Fact]
    public void IsSuiteSupported_TheCurrentVersion_IsTrue()
    {
        SchemaVersions.IsSuiteSupported(SchemaVersions.Suite).Should().BeTrue();
    }

    [Fact]
    public void IsSuiteResultSupported_TheCurrentVersion_IsTrue()
    {
        SchemaVersions.IsSuiteResultSupported(SchemaVersions.SuiteResult).Should().BeTrue();
    }

    [Theory]
    [InlineData("2.0")]
    [InlineData("0.9")]
    [InlineData("1.1")]
    [InlineData("1")]
    [InlineData("1.0.0")]
    [InlineData("v1.0")]
    [InlineData("1.x")]
    [InlineData("-1.0")]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    public void IsSuiteSupported_AnythingElse_IsFalse(string? version)
    {
        SchemaVersions.IsSuiteSupported(version).Should().BeFalse();
    }

    [Theory]
    [InlineData("2.0")]
    [InlineData("0.9")]
    [InlineData("1.1")]
    [InlineData(null)]
    public void IsSuiteResultSupported_AnythingElse_IsFalse(string? version)
    {
        SchemaVersions.IsSuiteResultSupported(version).Should().BeFalse();
    }

    [Fact]
    public void IsSupported_AnOlderMinorOfTheSameMajor_IsTrue()
    {
        // The bump policy is that an additive change does not bump, so an older minor of the same
        // major is a shape this reader still understands.
        SchemaVersions.IsSuiteSupported("1.0").Should().BeTrue();
    }
}
