using System.CommandLine;
using System.CommandLine.Builder;
using System.CommandLine.Help;
using System.CommandLine.Invocation;
using System.CommandLine.IO;
using System.CommandLine.Parsing;
using System.Globalization;
using System.Text;

namespace Forge.EvalCli.Cli;

/// <summary>
/// The command-line surface: the options, the parser pipeline, and the binding from a parse result
/// to a validated plan.
/// </summary>
/// <remarks>
/// <para>
/// <b>The shape here is chosen for what comes next.</b> Everything lives under a <c>run</c>
/// subcommand, so the one genuinely destructive thing this tool will ever do — replacing a
/// committed baseline — arrives as a separate command with its own explicit opt-in, and no
/// invocation that is safe today can become destructive by a later change. The only write this
/// build's arguments can cause is <c>--out</c>, and an existing file there is refused unless
/// <c>--overwrite</c> is passed as well.
/// </para>
/// <para>
/// Parsing is delegated to <c>System.CommandLine</c> rather than hand-rolled. Validation is not
/// spread across option validators: it lives in <see cref="RunPlan.Create(RunRequest)"/>, in one
/// place, so the rules a test pins are the same rules the tool applies.
/// </para>
/// </remarks>
internal sealed class EvalCommandLine
{
    /// <summary>
    /// The seed used when the caller does not choose one.
    /// </summary>
    /// <remarks>
    /// A fixed value rather than a random one. A baseline and a candidate have to be driven from
    /// the same root seed for the comparison between them to be paired at all, and a default that
    /// varied per invocation would quietly make every default-configured comparison unpaired.
    /// </remarks>
    internal const long DefaultRootSeed = 0;

    private readonly Option<string> _suite = new("--suite", "Path to the suite definition, relative to --root.")
    {
        IsRequired = true,
        ArgumentHelpName = "path",
    };

    private readonly Option<string> _root = new(
        "--root",
        Directory.GetCurrentDirectory,
        "Directory every path must resolve inside. Defaults to the working directory."
    )
    {
        ArgumentHelpName = "dir",
    };

    private readonly Option<string?> _baseline = new(
        "--baseline",
        "Path to a committed baseline artifact to compare against. Read only; never modified."
    )
    {
        ArgumentHelpName = "path",
    };

    private readonly Option<string?> _out = new(
        "--out",
        "Where the run artifact would be written. Omit it and nothing is written at all."
    )
    {
        ArgumentHelpName = "path",
    };

    private readonly Option<bool> _overwrite = new(
        "--overwrite",
        "Allow --out to replace a file that already exists. Refused without this."
    );

    private readonly Option<long> _seed = new(
        "--seed",
        () => DefaultRootSeed,
        "Root seed every run is derived from. Fixed by default so comparisons stay paired."
    )
    {
        ArgumentHelpName = "n",
    };

    private readonly Option<int> _maxConcurrency = new(
        "--max-concurrency",
        () => 1,
        "Hard ceiling on runs in flight at once. One by default: load on somebody else's system is opted into."
    )
    {
        ArgumentHelpName = "n",
    };

    private readonly Option<int> _maxTotalRuns = new(
        "--max-total-runs",
        () => RunPlan.DefaultMaxTotalRuns,
        "Ceiling on the runs a whole suite may plan, so a mistyped repetition count is refused rather than executed."
    )
    {
        ArgumentHelpName = "n",
    };

    private readonly Option<string?> _endpoint = new(
        "--endpoint",
        "Address the suite is evaluated against, recorded in the artifact. Credentials in the URL are refused."
    )
    {
        ArgumentHelpName = "url",
    };

    private readonly Option<bool> _dryRun = new("--dry-run", "Print the planned run and execute nothing. Start here.");

    private readonly Option<bool> _json = new("--json", "Emit the result as JSON on stdout.");

    private readonly Option<bool> _failOnRegression = new(
        "--fail-on-regression",
        "RESERVED. Accepted and reported, but this build is report-only and the flag changes nothing."
    );

    private readonly Option<bool> _verbose = new(new[] { "--verbose", "-v" }, "Write debug diagnostics to stderr.");

    /// <summary>Builds the parser for this tool.</summary>
    /// <returns>The configured parser.</returns>
    public static Parser Build() => new EvalCommandLine().BuildParser();

    /// <summary>Reads the raw option values out of a parse result.</summary>
    /// <param name="parseResult">The parse result for a <c>run</c> invocation.</param>
    /// <returns>The unvalidated request.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="parseResult"/> is null.</exception>
    internal RunRequest BindRequest(ParseResult parseResult)
    {
        ArgumentNullException.ThrowIfNull(parseResult);

        return new RunRequest
        {
            Suite = parseResult.GetValueForOption(_suite) ?? string.Empty,
            Root = parseResult.GetValueForOption(_root) ?? string.Empty,
            Baseline = parseResult.GetValueForOption(_baseline),
            Out = parseResult.GetValueForOption(_out),
            Overwrite = parseResult.GetValueForOption(_overwrite),
            Seed = parseResult.GetValueForOption(_seed),
            MaxConcurrency = parseResult.GetValueForOption(_maxConcurrency),
            MaxTotalRuns = parseResult.GetValueForOption(_maxTotalRuns),
            Endpoint = parseResult.GetValueForOption(_endpoint),
            DryRun = parseResult.GetValueForOption(_dryRun),
            Json = parseResult.GetValueForOption(_json),
            FailOnRegression = parseResult.GetValueForOption(_failOnRegression),
            Verbose = parseResult.GetValueForOption(_verbose),
        };
    }

    private Parser BuildParser()
    {
        var root = new RootCommand("Run an evaluation suite against a system under test and report what happened.")
        {
            Name = "eval-cli",
        };

        root.AddCommand(BuildRunCommand());

        // No subcommand was given. Show the safe path — on stderr, so a piped stdout stays clean —
        // and report a usage error, because nothing was asked for and nothing ran.
        root.SetHandler(context =>
        {
            context.Console.Error.Write(RenderHelp(context.HelpBuilder, root, context.ParseResult));
            context.ExitCode = (int)ExitCode.UsageError;
        });

        return new CommandLineBuilder(root)
            .UseHelp(customize: CustomizeHelp)
            .AddMiddleware(ReportParseErrorsAsync, MiddlewareOrder.ErrorReporting)
            .UseExceptionHandler(
                (exception, context) => context.ExitCode = (int)ExitCodeReporter.Report(exception, context.Console),
                (int)ExitCode.UnexpectedError
            )
            .CancelOnProcessTermination()
            .Build();
    }

    /// <summary>
    /// Reports parse errors on stderr and stops the invocation with
    /// <see cref="ExitCode.UsageError"/>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Hand-written rather than <c>UseParseErrorReporting</c>, which writes the usage text it
    /// emits to <b>stdout</b>. That would put help output into the stream a caller is parsing as
    /// the tool's result, so this writes the whole refusal — errors and usage — to stderr instead.
    /// <c>UseTypoCorrections</c> is left off for the same reason; it writes its suggestions to
    /// stdout and offers no way to redirect them.
    /// </para>
    /// <para>
    /// <b>This is where argument values are redacted, because this is where they are printed.</b>
    /// A parse error fires before <see cref="HandleRunAsync"/> is reached, so nothing that
    /// understands an option has run and nothing can have redacted its value — the parser simply
    /// quotes back what it could not use. Passing every error through
    /// <see cref="ArgumentRedactor"/> covers each option the tool has and each one it later gains,
    /// rather than each one somebody remembered. The help block is left alone: it is generated
    /// from the parser's own symbols and contains nothing the caller supplied.
    /// </para>
    /// </remarks>
    private static async Task ReportParseErrorsAsync(InvocationContext context, Func<InvocationContext, Task> next)
    {
        if (context.ParseResult.Errors.Count == 0)
        {
            await next(context).ConfigureAwait(false);

            return;
        }

        var suppliedValues = ArgumentRedactor.SuppliedValues(context.ParseResult);
        var message = new StringBuilder();

        foreach (var parseError in context.ParseResult.Errors)
        {
            message.Append("eval-cli: ").AppendLine(ArgumentRedactor.Redact(parseError.Message, suppliedValues));
        }

        message.AppendLine();
        message.Append(RenderHelp(context.HelpBuilder, context.ParseResult.CommandResult.Command, context.ParseResult));
        message.AppendLine(
            string.Create(CultureInfo.InvariantCulture, $"eval-cli: exiting {(int)ExitCode.UsageError}.")
        );

        var error = context.Console.Error.CreateTextWriter();

        await error.WriteAsync(message.ToString().AsMemory(), context.GetCancellationToken()).ConfigureAwait(false);
        await error.FlushAsync(context.GetCancellationToken()).ConfigureAwait(false);

        context.ExitCode = (int)ExitCode.UsageError;
    }

    private Command BuildRunCommand()
    {
        var run = new Command("run", "Evaluate a suite. Use --dry-run first; it executes nothing.")
        {
            _suite,
            _root,
            _baseline,
            _out,
            _overwrite,
            _seed,
            _maxConcurrency,
            _maxTotalRuns,
            _endpoint,
            _dryRun,
            _json,
            _failOnRegression,
            _verbose,
        };

        run.SetHandler(HandleRunAsync);

        return run;
    }

    private async Task HandleRunAsync(InvocationContext context)
    {
        // Nothing is caught here. A refusal from this tool or from the engine travels to the
        // exception-handler middleware, which is the single place that turns a failure into both
        // a message and an exit code.
        var plan = RunPlan.Create(BindRequest(context.ParseResult));

        var code = await RunCommand
            .ExecuteAsync(plan, context.Console, context.GetCancellationToken())
            .ConfigureAwait(false);

        context.ExitCode = (int)code;
    }

    private static void CustomizeHelp(HelpContext context)
    {
        context.HelpBuilder.CustomizeLayout(_ =>
            new HelpSectionDelegate[] { HelpBuilder.Default.SynopsisSection(), WriteSafePath }
                .Concat(HelpBuilder.Default.GetLayout().Skip(1))
                .Append(WriteExitCodes)
        );
    }

    /// <summary>Renders help with this tool's layout, for writing wherever the caller needs it.</summary>
    /// <remarks>
    /// The <c>customize</c> callback handed to <c>UseHelp</c> is invoked only by the help option's
    /// own handler, so every other place that renders help — a parse error, a bare invocation —
    /// has to apply the same layout itself or silently fall back to the default one.
    /// </remarks>
    private static string RenderHelp(HelpBuilder builder, Command command, ParseResult parseResult)
    {
        using var writer = new StringWriter(CultureInfo.InvariantCulture);

        var helpContext = new HelpContext(builder, command, writer, parseResult);

        CustomizeHelp(helpContext);
        builder.Write(helpContext);

        return writer.ToString();
    }

    private static void WriteSafePath(HelpContext context)
    {
        var output = context.Output;

        output.WriteLine("Start here - previews the run and executes nothing:");
        output.WriteLine();
        output.WriteLine("  eval-cli run --suite eval-suites/regression.json --dry-run");
        output.WriteLine();
        output.WriteLine("The default invocation writes nothing and mutates nothing. --out names a");
        output.WriteLine("destination for the run artifact, and a file that already exists there is");
        output.WriteLine("refused unless --overwrite is passed as well.");
        output.WriteLine();
    }

    private static void WriteExitCodes(HelpContext context)
    {
        var output = context.Output;

        output.WriteLine();
        output.WriteLine("Exit codes:");

        foreach (var entry in ExitCodes.Documented)
        {
            output.WriteLine(string.Create(CultureInfo.InvariantCulture, $"  {(int)entry.Code, -6}{entry.Meaning}"));
        }

        output.WriteLine();
        output.WriteLine(
            string.Create(
                CultureInfo.InvariantCulture,
                $"  {ExitCodes.GateRangeStart}-{ExitCodes.GateRangeEnd} is reserved for gate outcomes and will not be reused."
            )
        );
        output.WriteLine();
    }
}
