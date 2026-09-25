using System.CommandLine;
using System.CommandLine.IO;
using System.Globalization;
using Forge.EvalEngine.Comparison;
using Forge.EvalEngine.Serialization;

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
/// <para>
/// <b>A stack trace is printed for one outcome only: a defect.</b> Frames carry the checkout
/// directory and the source layout of the machine that built the tool, so dumping them for a
/// refusal the engine made on purpose discloses exactly what that refusal was protecting — and
/// tells the user to report working software as a bug. Every deliberate refusal is classified
/// before it can reach that branch (§V).
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
            UnsafeIdentifierException => ExitCode.UsageError,
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
            // The blanket sentence is two claims, and a command that got as far as replacing
            // something can only honestly make the first of them.
            console.Error.WriteLine(
                exception is InterruptedAfterWritingException written
                    ? $"eval-cli: interrupted. Nothing further was run, but {written.WhatWasWritten}"
                    : "eval-cli: interrupted. Nothing further was run and nothing was written."
            );

            return code;
        }

        console.Error.WriteLine($"eval-cli: {Words(exception)}");

        if (exception is EvalCliException { Remedy: { } remedy })
        {
            console.Error.WriteLine($"          {remedy}");
        }

        if (exception is UnsafeIdentifierException refused)
        {
            console.Error.WriteLine($"          {Located(refused)}");
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

    /// <summary>
    /// The words to print for a failure, depending on who composed them.
    /// </summary>
    /// <param name="exception">The failure.</param>
    /// <returns>The message.</returns>
    /// <remarks>
    /// <para>
    /// <b>An <see cref="EvalCliException"/> is this tool's own sentence and is printed as
    /// written.</b> It was composed against the rules in ADR 0005 at the point it was thrown —
    /// paths already stated relative to the root, artifact text already netted — and putting it
    /// through the net a second time would alias values that are deliberately there.
    /// </para>
    /// <para>
    /// <b>Anything else reaching here is engine-composed and is netted.</b>
    /// <see cref="Classify"/> has arms for <c>ComparisonRefusedException</c> and
    /// <c>UnsafeIdentifierException</c> precisely because they arrive unwrapped, and the first of
    /// those quotes the suite names that disagreed. A suite name is author-supplied and the
    /// authoring-time control admits one behind a leading request method, so it reaches this line
    /// intact — the same concession, on one more surface (§V, ADR 0005).
    /// </para>
    /// </remarks>
    private static string Words(Exception exception) =>
        exception is EvalCliException
            ? exception.Message
            : MarkdownReport.Sanitize(exception.Message, MarkdownReport.MaxReasonCharacters);

    /// <summary>
    /// Says where a refused identifier sits and what to do about it, without repeating it.
    /// </summary>
    /// <param name="refusal">The engine's refusal.</param>
    /// <returns>The line that follows the message.</returns>
    /// <remarks>
    /// <para>
    /// <b>No path in this build reaches here.</b> Every stage that reads a durable artifact knows
    /// which argument named it and turns the refusal into an <see cref="EvalCliException"/> that
    /// says so — see <see cref="SuiteDiscovery.LoadBaselineAsync"/>. What matters is the arm in
    /// <see cref="Classify"/> above it: it keeps this type out of the stack-trace branch no matter
    /// which stage throws it, and a classification with no message behind it would report a
    /// refusal as a bare code. This is that message, and it is exercised directly by test rather
    /// than left as protection nothing can demonstrate.
    /// </para>
    /// <para>
    /// The field and the position are the most that can be said. The engine withheld the value on
    /// purpose, and re-deriving it here would move the disclosure rather than remove it.
    /// </para>
    /// </remarks>
    private static string Located(UnsafeIdentifierException refusal) =>
        "Refused rather than read: the artifact's "
        + (refusal.Field ?? "identifier")
        + (refusal.Position is { } position ? $" at scenario {position}" : string.Empty)
        + " names a machine. Rename it in the suite and regenerate the artifact. The value is not repeated here, "
        + "because this message is written to the build log.";
}
