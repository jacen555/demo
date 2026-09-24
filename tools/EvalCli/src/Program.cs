using System.CommandLine.Parsing;
using Forge.EvalCli.Cli;

namespace Forge.EvalCli;

/// <summary>
/// The entry point. Builds the command line and returns whatever exit code the invocation earned.
/// </summary>
/// <remarks>
/// Deliberately thin. Everything that could fail lives behind the parser pipeline, where a single
/// exception-handler middleware turns a failure into one message and one exit code. There is no
/// branch here that could swallow a failure and return zero.
/// </remarks>
internal static class Program
{
    /// <summary>Runs the tool.</summary>
    /// <param name="args">The raw command-line arguments.</param>
    /// <returns>The process exit code. See <see cref="ExitCode"/>.</returns>
    internal static Task<int> Main(string[] args) => EvalCommandLine.Build().InvokeAsync(args);
}
