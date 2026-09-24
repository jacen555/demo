using FluentAssertions;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Tests.Support;
using Forge.EvalEngine.Comparison;

namespace Forge.EvalCli.Tests.Cli;

public class ExitCodeReporterTests
{
    [Fact]
    public void Classify_WhenTheToolRefused_ReturnsTheCodeTheRefusalCarried()
    {
        var exception = new EvalCliException(ExitCode.SuiteError, "no");

        ExitCodeReporter.Classify(exception).Should().Be(ExitCode.SuiteError);
    }

    [Fact]
    public void Classify_WhenTheRunWasCancelled_ReturnsInterrupted() =>
        ExitCodeReporter.Classify(new OperationCanceledException()).Should().Be(ExitCode.Interrupted);

    [Fact]
    public void Classify_WhenATaskWasCancelled_ReturnsInterrupted() =>
        ExitCodeReporter.Classify(new TaskCanceledException()).Should().Be(ExitCode.Interrupted);

    [Fact]
    public void Classify_WhenTheComparatorRefused_ReturnsComparisonRefused() =>
        ExitCodeReporter
            .Classify(new ComparisonRefusedException("the two runs were not conducted alike"))
            .Should()
            .Be(ExitCode.ComparisonRefused);

    [Fact]
    public void Classify_WhenTheFailureIsUnrecognized_ReturnsUnexpectedErrorRatherThanSuccess()
    {
        var code = ExitCodeReporter.Classify(new InvalidOperationException("something nobody anticipated"));

        code.Should().Be(ExitCode.UnexpectedError);
        code.Should().NotBe(ExitCode.Success);
    }

    [Fact]
    public void Classify_ForEveryFailure_NeverReturnsSuccess()
    {
        Exception[] failures =
        [
            new EvalCliException(ExitCode.RunFailed, "no"),
            new OperationCanceledException(),
            new ComparisonRefusedException("no"),
            new InvalidOperationException("no"),
            new IOException("no"),
        ];

        failures.Select(ExitCodeReporter.Classify).Should().NotContain(ExitCode.Success);
    }

    [Fact]
    public void Report_ForARefusal_WritesToStandardErrorAndLeavesStandardOutUntouched()
    {
        using var console = new RecordingConsole();

        var code = ExitCodeReporter.Report(
            new EvalCliException(ExitCode.SuiteError, "the suite did not validate"),
            console
        );

        code.Should().Be(ExitCode.SuiteError);
        console.StandardOut.Should().BeEmpty();
        console.StandardError.Should().Contain("the suite did not validate");
    }

    [Fact]
    public void Report_WhenTheRefusalCarriesARemedy_TellsTheUserWhatToDo()
    {
        using var console = new RecordingConsole();

        ExitCodeReporter.Report(
            new EvalCliException(ExitCode.ComparisonRefused, "not comparable", "regenerate the baseline"),
            console
        );

        console.StandardError.Should().Contain("regenerate the baseline");
    }

    [Fact]
    public void Report_WhenTheFailureIsADefect_SaysSoRatherThanPresentingItAsARefusal()
    {
        using var console = new RecordingConsole();

        ExitCodeReporter.Report(new InvalidOperationException("boom"), console);

        console.StandardError.Should().Contain("defect in eval-cli");
    }

    [Fact]
    public void Report_ForEveryFailure_StatesTheCodeItIsExitingWith()
    {
        using var console = new RecordingConsole();

        ExitCodeReporter.Report(new EvalCliException(ExitCode.NotImplemented, "not wired"), console);

        console.StandardError.Should().Contain("exiting 70");
    }

    [Fact]
    public void Report_WhenInterrupted_SaysNothingWasWritten()
    {
        using var console = new RecordingConsole();

        var code = ExitCodeReporter.Report(new OperationCanceledException(), console);

        code.Should().Be(ExitCode.Interrupted);
        console.StandardError.Should().Contain("nothing was written");
        console.StandardOut.Should().BeEmpty();
    }
}
