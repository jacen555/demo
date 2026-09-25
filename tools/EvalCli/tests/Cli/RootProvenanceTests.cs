using System.CommandLine.Parsing;
using FluentAssertions;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Tests.Support;

namespace Forge.EvalCli.Tests.Cli;

/// <summary>
/// Where a path's text actually came from, as opposed to which factory somebody reached for.
/// </summary>
/// <remarks>
/// <para>
/// <b><see cref="PathValue"/> made every call site answer the question; it cannot make the answer
/// true.</b> A wrong answer compiles exactly as well as a right one, and the first wrong answer
/// was the obvious one: <c>--root</c> carried a default factory, so an omitted option arrived at
/// binding already materialised into <c>Directory.GetCurrentDirectory()</c> — a path this process
/// derived, indistinguishable at that point from one a caller typed.
/// </para>
/// <para>
/// The fix is to stop materialising it before the distinction can be recorded: absence is carried
/// as absence, and the one place that turns absence into a working directory is the one place
/// that marks it derived.
/// </para>
/// </remarks>
public class RootProvenanceTests
{
    [Fact]
    public void RootFrom_WhenTheCallerSuppliedNothing_MarksTheWorkingDirectoryAsDerived()
    {
        var root = PathValue.RootFrom(null);

        root.TypedByCaller.Should().BeFalse("the working directory is this process's, not the caller's");
        root.Text.Should().Be(Directory.GetCurrentDirectory());
    }

    [Fact]
    public void RootFrom_WhenTheCallerSuppliedAValue_MarksItAsTheirs()
    {
        var root = PathValue.RootFrom("some/where");

        root.TypedByCaller.Should().BeTrue();
        root.Text.Should().Be("some/where");
    }

    [Fact]
    public void BindTrendRequest_WhenRootIsOmitted_CarriesItsAbsenceRatherThanAWorkingDirectory()
    {
        var cli = new EvalCommandLine();

        cli.BindTrendRequest(Parse(cli, "trend", "--artifacts", "trend"))
            .Root.Should()
            .BeNull("a value the caller did not give must not arrive looking like one they did");
    }

    [Fact]
    public void BindTrendRequest_WhenRootIsGiven_CarriesWhatTheCallerTyped()
    {
        // Parsed and bound through one instance. The options are instance fields, so a result
        // from a different instance binds every value to its default — which is indistinguishable
        // from a correct answer, and is how the absence test above passed while proving nothing.
        var cli = new EvalCommandLine();

        cli.BindTrendRequest(Parse(cli, "trend", "--artifacts", "trend", "--root", "some/where"))
            .Root.Should()
            .Be("some/where");
    }

    [Fact]
    public void BindRequest_WhenRootIsOmitted_CarriesItsAbsenceRatherThanAWorkingDirectory()
    {
        var cli = new EvalCommandLine();

        cli.BindRequest(Parse(cli, "run", "--suite", "eval-suites/regression.json")).Root.Should().BeNull();
    }

    [Fact]
    public void BindRequest_WhenRootIsGiven_CarriesWhatTheCallerTyped()
    {
        var cli = new EvalCommandLine();

        cli.BindRequest(Parse(cli, "run", "--suite", "s.json", "--root", "some/where")).Root.Should().Be("some/where");
    }

    [Fact]
    public async Task Help_DoesNotPrintTheWorkingDirectoryOfTheMachineItRanOn()
    {
        // A default factory does not only reach a refusal: `System.CommandLine` renders it into
        // `--help` as `[default: <cwd>]`, and help is written to a build log like everything
        // else. Removing the factory removes that too.
        using var console = new RecordingConsole();

        await EvalCommandLine.Build().InvokeAsync(["trend", "--help"], console);

        var printed = console.StandardOut + console.StandardError;

        printed.Should().Contain("--root").And.Contain("Defaults to the working directory");
        printed.Should().NotContain(Directory.GetCurrentDirectory());
    }

    [Fact]
    public void Create_WhenTheRootIsOmitted_StillResolvesAgainstTheWorkingDirectory()
    {
        // The behaviour has not changed, only where the default is materialised.
        using var workspace = new TempWorkspace();

        var previous = Directory.GetCurrentDirectory();

        try
        {
            Directory.SetCurrentDirectory(workspace.Root);

            TrendPlan
                .Create(new TrendRequest { Artifacts = "artifacts", Root = null })
                .RootDirectory.Should()
                .Be(Path.TrimEndingDirectorySeparator(workspace.Root));
        }
        finally
        {
            Directory.SetCurrentDirectory(previous);
        }
    }

    private static ParseResult Parse(EvalCommandLine cli, params string[] args) => cli.BuildParser().Parse(args);
}
