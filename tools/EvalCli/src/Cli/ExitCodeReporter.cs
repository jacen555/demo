using System.CommandLine;
using System.CommandLine.IO;
using System.Globalization;
using Forge.EvalEngine.Comparison;

namespace Forge.EvalCli.Cli;

/// <summary>
/// Turns a thrown failure into the message the user sees and the code the process exits with.
/// </summary>
/// <remarks>
/// <para>
/// One function owns both halves so that a message and its exit code cannot be produced
/// separately and drift apart. Reporting a failure on one channel while exiting zero on the other
/// is the defect this design exists to make unreachable.
/// </para>
/// <para>
/// Diagnostics go to stderr. A caller that is piping the machine-readable result into another
/// process still sees the error, and the result stream stays clean.
/// </para>
/// </remarks>
internal static class ExitCodeReporter
{
    /// <summary>Decides which exit code a failure means.</summary>
    /// <param name="exception">The failure.</param>
    /// <returns>The exit code.</returns>
    /// <remarks>
    /// A refusal from the engine is a distinct outcome from a defect in this tool, so the two get
    /// distinct codes. Anything unrecognized is <see cref="ExitCode.UnexpectedError"/> — never
    /// <see cref="ExitCode.Success"/>, and never quietly folded into a known code.
    /// </remarks>
    /// <exception cref="ArgumentNullException"><paramref name="exception"/> is null.</exception>
    public static ExitCode Classify(Exception exception)
    {
        ArgumentNullException.ThrowIfNull(exception);

        return exception switch
        {
            EvalCliException refusal => refusal.ExitCode,
            OperationCanceledException => ExitCode.Interrupted,
            ComparisonRefusedException => ExitCode.ComparisonRefused,
            _ => ExitCode.UnexpectedError,
        };
    }

    /// <summary>Writes the failure to stderr and returns the code to exit with.</summary>
    /// <param name="exception">The failure.</param>
    /// <param name="console">Where the message goes.</param>
    /// <returns>The exit code.</returns>
    /// <exception cref="ArgumentNullException">Any argument is null.</exception>
    public static ExitCode Report(Exception exception, IConsole console)
    {
        ArgumentNullException.ThrowIfNull(exception);
        ArgumentNullException.ThrowIfNull(console);

        var code = Classify(exception);

        if (code == ExitCode.Interrupted)
        {
            console.Error.WriteLine("eval-cli: interrupted. Nothing further was run and nothing was written.");

            return code;
        }

        console.Error.WriteLine($"eval-cli: {exception.Message}");

        if (exception is EvalCliException { Remedy: { } remedy })
        {
            console.Error.WriteLine($"          {remedy}");
        }

        if (code == ExitCode.UnexpectedError)
        {
            // A defect in this tool rather than a refusal it meant to make. The stack is the only
            // useful thing to say, and saying nothing would leave the user with no way to report it.
            console.Error.WriteLine("          This is a defect in eval-cli. Details follow.");
            console.Error.WriteLine(exception.ToString());
        }

        console.Error.WriteLine(string.Create(CultureInfo.InvariantCulture, $"eval-cli: exiting {(int)code}."));

        return code;
    }
}
