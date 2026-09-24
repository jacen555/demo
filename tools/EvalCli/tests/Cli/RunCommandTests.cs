using FluentAssertions;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Tests.Support;

namespace Forge.EvalCli.Tests.Cli;

public class RunCommandTests
{
    private static RunPlan Plan(TempWorkspace workspace, bool dryRun) =>
        RunPlan.Create(
            new RunRequest
            {
                Suite = "eval-suites/regression.json",
                Root = workspace.Root,
                DryRun = dryRun,
            }
        );

    [Fact]
    public async Task ExecuteAsync_ForADryRun_WritesThePlanToStandardOutAndSucceeds()
    {
        using var workspace = new TempWorkspace();
        using var console = new RecordingConsole();

        var code = await RunCommand.ExecuteAsync(Plan(workspace, dryRun: true), console, CancellationToken.None);

        code.Should().Be(ExitCode.Success);
        console.StandardOut.Should().Contain("Planned run");
        console.StandardError.Should().BeEmpty();
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheRunIsNotADryRun_RefusesRatherThanReportingSuccess()
    {
        using var workspace = new TempWorkspace();
        using var console = new RecordingConsole();

        var act = async () =>
            await RunCommand.ExecuteAsync(Plan(workspace, dryRun: false), console, CancellationToken.None);

        // Nothing ran, so nothing may report that it passed.
        var refusal = await act.Should().ThrowAsync<EvalCliException>();

        refusal.Which.ExitCode.Should().Be(ExitCode.NotImplemented);
        refusal.Which.ExitCode.Should().NotBe(ExitCode.Success);
        console.StandardOut.Should().BeEmpty();
    }

    [Fact]
    public async Task ExecuteAsync_WhenTheRunIsNotADryRun_TellsTheUserWhatToDoInstead()
    {
        using var workspace = new TempWorkspace();
        using var console = new RecordingConsole();

        var act = async () =>
            await RunCommand.ExecuteAsync(Plan(workspace, dryRun: false), console, CancellationToken.None);

        (await act.Should().ThrowAsync<EvalCliException>()).Which.Remedy.Should().Contain("--dry-run");
    }

    [Fact]
    public async Task ExecuteAsync_WhenCancellationWasAlreadyRequested_ThrowsRatherThanReportingAPlan()
    {
        using var workspace = new TempWorkspace();
        using var console = new RecordingConsole();
        using var cancelled = new CancellationTokenSource();

        await cancelled.CancelAsync();

        var act = async () => await RunCommand.ExecuteAsync(Plan(workspace, dryRun: true), console, cancelled.Token);

        await act.Should().ThrowAsync<OperationCanceledException>();

        // And the reporter turns that into a non-zero exit, not a silent success.
        ExitCodeReporter.Classify(new OperationCanceledException()).Should().Be(ExitCode.Interrupted);
        console.StandardOut.Should().BeEmpty();
    }

    [Fact]
    public async Task ExecuteAsync_WhenThePlanIsNull_Throws()
    {
        using var console = new RecordingConsole();

        var act = async () => await RunCommand.ExecuteAsync(null!, console, CancellationToken.None);

        await act.Should().ThrowAsync<ArgumentNullException>();
    }
}
