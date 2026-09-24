using FluentAssertions;
using Forge.EvalCli.Cli;

namespace Forge.EvalCli.Tests.Cli;

/// <summary>
/// The exit-code table is this tool's public contract. These tests pin the properties a caller
/// relies on, so a later change cannot renumber a code or let a failure become a green check
/// without something going red first.
/// </summary>
public class ExitCodeTests
{
    [Fact]
    public void Documented_EveryCodeOtherThanSuccess_IsNonZero()
    {
        var failures = ExitCodes.Documented.Where(entry => entry.Code != ExitCode.Success);

        failures.Should().NotBeEmpty();
        failures.Should().OnlyContain(entry => (int)entry.Code != 0);
    }

    [Fact]
    public void Documented_TheTable_CoversEveryDeclaredExitCode()
    {
        var documented = ExitCodes.Documented.Select(entry => entry.Code);

        documented.Should().BeEquivalentTo(Enum.GetValues<ExitCode>());
    }

    [Fact]
    public void Documented_EveryCode_IsUnique()
    {
        var codes = ExitCodes.Documented.Select(entry => (int)entry.Code).ToArray();

        codes.Should().OnlyHaveUniqueItems();
    }

    [Fact]
    public void Documented_NoCodeOutsideTheGateBlock_OccupiesTheReservedRange()
    {
        var reserved = ExitCodes
            .Documented.Where(entry => (int)entry.Code is >= ExitCodes.GateRangeStart and <= ExitCodes.GateRangeEnd)
            .Select(entry => entry.Code);

        // The block exists so a future gate outcome can be added without renumbering anything.
        // Only RegressionsFound has claimed one so far; the rest of the range must stay free.
        reserved.Should().Equal(ExitCode.RegressionsFound);
    }

    [Fact]
    public void IsGateCode_ForTheGateOutcome_IsTrue() =>
        ExitCodes.IsGateCode(ExitCode.RegressionsFound).Should().BeTrue();

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    [InlineData(70)]
    [InlineData(71)]
    [InlineData(130)]
    public void IsGateCode_ForEveryCodeOutsideTheBlock_IsFalse(int code) =>
        ExitCodes.IsGateCode((ExitCode)code).Should().BeFalse();

    [Fact]
    public void IsFailure_ForSuccess_IsFalse() => ExitCodes.IsFailure(ExitCode.Success).Should().BeFalse();

    [Fact]
    public void IsFailure_ForEveryOtherCode_IsTrue()
    {
        var others = Enum.GetValues<ExitCode>().Where(code => code != ExitCode.Success);

        others.Should().OnlyContain(code => ExitCodes.IsFailure(code));
    }

    [Fact]
    public void Interrupted_FollowsTheShellConventionForSigint() => ((int)ExitCode.Interrupted).Should().Be(130);
}
