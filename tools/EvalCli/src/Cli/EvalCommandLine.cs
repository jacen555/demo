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
/// <b>The shape here is chosen so the <i>verified</i> replacement route stays in its own
/// command.</b> Everything a run does lives under <c>run</c>; replacing a committed baseline with
/// knowledge of what is being replaced lives under <c>baseline update</c> with its own explicit
/// opt-in. No option added to <c>run</c> reaches the code that verifies and replaces a baseline.
/// </para>
/// <para>
/// <b><c>run</c> is not non-destructive, and saying so would be the more useful accuracy.</b> It
/// has two destinations — <c>--out</c> and <c>--report-markdown</c> — and with <c>--overwrite</c>
/// either will replace an existing file at the path it was given, including a committed baseline
/// the invocation did not name. The guarantee it does hold is narrower and worth stating exactly:
/// <b>no <c>run</c> invocation replaces a file that same invocation reads.</b> <c>--suite</c> and
/// <c>--baseline</c> are refused as destinations regardless of the opt-in, and that refusal is
/// re-established at the moment of each write rather than only when the arguments were checked.
/// </para>
/// <para>
/// Parsing is delegated to <c>System.CommandLine</c> rather than hand-rolled. Validation is not
/// spread across option validators: it lives in <see cref="RunPlan.Create(RunRequest)"/> and
/// <see cref="RunPlan.CreateForBaselineUpdate(RunRequest)"/>, so the rules a test pins are the
/// same rules the tool applies.
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

    private readonly Option<string?> _root = new(
        "--root",
        "Directory every path must resolve inside. Defaults to the working directory."
    )
    {
        ArgumentHelpName = "dir",
    };

    /// <summary>
    /// The committed baseline, shared by <c>run</c> and <c>baseline update</c>.
    /// </summary>
    /// <remarks>
    /// <b>The sentence has to be true in both renderings, because one string is rendered by two
    /// commands that do opposite things to the file.</b> Written against <c>run</c> alone it said
    /// "read only; never modified" — correct there, and false in <c>baseline update --help</c>,
    /// where it appears directly above <c>--apply</c>. The text never changed; the set of commands
    /// rendering it did, which is the same shape as a trade-off scoped to the surfaces that
    /// existed when it was made.
    /// </remarks>
    private readonly Option<string?> _baseline = new(
        "--baseline",
        "Path to a committed baseline artifact. `run` compares against it and never modifies it; "
            + "`baseline update --apply` replaces it."
    )
    {
        ArgumentHelpName = "path",
    };

    /// <summary>
    /// The run artifact destination. <c>run</c> only.
    /// </summary>
    /// <remarks>
    /// <b>Not a sharing defect — a description that was wrong about its own command.</b> "Omit it
    /// and nothing is written at all" was true when <c>--out</c> was the only destination
    /// <c>run</c> had; <c>--report-markdown</c> arrived later and writes a file with no
    /// <c>--out</c> given. The claim it can honestly make is about the artifact, not about the
    /// command.
    /// </remarks>
    private readonly Option<string?> _out = new(
        "--out",
        "Where the run artifact would be written. Omit it and no artifact is written. Does not govern "
            + "--report-markdown, which writes its own file."
    )
    {
        ArgumentHelpName = "path",
    };

    private readonly Option<string?> _reportMarkdown = new(
        "--report-markdown",
        "Where to write the Markdown comparison report for a pull request. Needs a baseline. This tool writes the "
            + "file and never posts it: CI attaches it."
    )
    {
        ArgumentHelpName = "path",
    };

    /// <summary>
    /// The replace opt-in for <c>run</c>. <c>trend</c> has <see cref="_trendOverwrite"/> instead.
    /// </summary>
    /// <remarks>
    /// <b>Two instances sharing a name, not one sentence covering two commands.</b> This is the
    /// shape <see cref="_reportMarkdown"/> and <see cref="_trendReport"/> already use, and the
    /// reason they are the only options in this file that never drifted: text written against one
    /// command cannot be wrong for a command that does not render it. The single-instance form
    /// described "--out and --report-markdown" and was rendered verbatim under
    /// <c>trend --help</c>, which declares no <c>--out</c>. A two-clause sentence would have
    /// fixed that reading and left the next option set to be remembered; this cannot go wrong
    /// again without someone deleting a field.
    /// <para>
    /// <see cref="_baseline"/> is deliberately <i>not</i> split: both commands take the same file
    /// and mean the same thing by it, so two instances would say one thing twice and drift apart
    /// on their own.
    /// </para>
    /// </remarks>
    private readonly Option<bool> _overwrite = new(
        "--overwrite",
        "Allow --out and --report-markdown to replace a file that already exists. Refused without this, and "
            + "refused if neither is named. Never lifts a collision with an input: the file replaced is never a "
            + "file this invocation reads."
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

    private readonly Option<string?> _baselineEndpoint = new(
        "--baseline-endpoint",
        "Address to conduct a baseline run against and compare the candidate to. Must differ from --endpoint, "
            + "and may not carry a query string or a fragment."
    )
    {
        ArgumentHelpName = "url",
    };

    private readonly Option<bool> _apply = new(
        "--apply",
        "Replace the committed baseline. Without this, `baseline update` previews the change and writes nothing."
    );

    private readonly Option<string?> _changedSince = new(
        "--changed-since",
        "Revision to read the changed-file set from, narrowing the run to the scenarios a change touched. "
            + "Omit it and the whole suite runs."
    )
    {
        ArgumentHelpName = "rev",
    };

    private readonly Option<string?> _restExchange = new(
        "--rest-exchange",
        "Adapter describing the REST system under test: none (default) or json. Needs --endpoint."
    )
    {
        ArgumentHelpName = "name",
    };

    private readonly Option<string?> _llmExchange = new(
        "--llm-exchange",
        "Adapter describing the conversational system under test: none (default) or json. Needs --endpoint."
    )
    {
        ArgumentHelpName = "name",
    };

    private readonly Option<bool> _dryRun = new("--dry-run", "Print the planned run and execute nothing. Start here.");

    private readonly Option<bool> _json = new("--json", "Emit the result as JSON on stdout.");

    private readonly Option<bool> _failOnRegression = new(
        "--fail-on-regression",
        "Not yet available. Will exit in the reserved 10-19 range when the comparison finds a regression; until "
            + "then this invocation is refused rather than passing an unenforced gate."
    );

    private readonly Option<bool> _verbose = new(new[] { "--verbose", "-v" }, "Write debug diagnostics to stderr.");

    private readonly Option<string> _artifacts = new(
        "--artifacts",
        "Directory of run artifacts to trend, relative to --root. Read only; nothing in it is written or replaced."
    )
    {
        IsRequired = true,
        ArgumentHelpName = "dir",
    };

    private readonly Option<string?> _trendReport = new(
        "--report-markdown",
        "Where to write the Markdown trend report. Omit it and the report is printed and nothing is written. This "
            + "tool writes the file and never posts it: CI attaches it."
    )
    {
        ArgumentHelpName = "path",
    };

    /// <summary>
    /// The replace opt-in for <c>trend</c>. See <see cref="_overwrite"/> for why this is a second
    /// instance rather than a second clause.
    /// </summary>
    private readonly Option<bool> _trendOverwrite = new(
        "--overwrite",
        "Allow --report-markdown to replace an existing trend report. Refused without this, and refused if "
            + "--report-markdown was not given. Never lifts a collision with the --artifacts directory: nothing "
            + "this command reads can be written over."
    );

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
            Root = parseResult.GetValueForOption(_root),
            Baseline = parseResult.GetValueForOption(_baseline),
            Out = parseResult.GetValueForOption(_out),
            ReportMarkdown = parseResult.GetValueForOption(_reportMarkdown),
            Overwrite = parseResult.GetValueForOption(_overwrite),
            Seed = parseResult.GetValueForOption(_seed),
            MaxConcurrency = parseResult.GetValueForOption(_maxConcurrency),
            MaxTotalRuns = parseResult.GetValueForOption(_maxTotalRuns),
            Endpoint = parseResult.GetValueForOption(_endpoint),
            BaselineEndpoint = parseResult.GetValueForOption(_baselineEndpoint),
            Apply = parseResult.GetValueForOption(_apply),
            ChangedSince = parseResult.GetValueForOption(_changedSince),
            RestExchange = parseResult.GetValueForOption(_restExchange),
            LlmExchange = parseResult.GetValueForOption(_llmExchange),
            DryRun = parseResult.GetValueForOption(_dryRun),
            Json = parseResult.GetValueForOption(_json),
            FailOnRegression = parseResult.GetValueForOption(_failOnRegression),
            Verbose = parseResult.GetValueForOption(_verbose),
        };
    }

    /// <summary>Reads the raw option values out of a <c>trend</c> parse result.</summary>
    /// <param name="parseResult">The parse result for a <c>trend</c> invocation.</param>
    /// <returns>The unvalidated request.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="parseResult"/> is null.</exception>
    internal TrendRequest BindTrendRequest(ParseResult parseResult)
    {
        ArgumentNullException.ThrowIfNull(parseResult);

        return new TrendRequest
        {
            Artifacts = parseResult.GetValueForOption(_artifacts) ?? string.Empty,
            Root = parseResult.GetValueForOption(_root),
            ReportMarkdown = parseResult.GetValueForOption(_trendReport),
            Overwrite = parseResult.GetValueForOption(_trendOverwrite),
        };
    }

    /// <summary>
    /// Builds the parser from <i>this</i> instance's options.
    /// </summary>
    /// <returns>The parser.</returns>
    /// <remarks>
    /// Internal so a test can parse and bind through one instance. The options are instance
    /// fields, so a parse result produced by a different instance looks up nothing and every
    /// bound value comes back as its default — which reads exactly like a correct answer.
    /// </remarks>
    internal Parser BuildParser()
    {
        var root = new RootCommand("Run an evaluation suite against a system under test and report what happened.")
        {
            Name = "eval-cli",
        };

        root.AddCommand(BuildRunCommand());
        root.AddCommand(BuildBaselineCommand());
        root.AddCommand(BuildTrendCommand());

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
            _reportMarkdown,
            _overwrite,
            _seed,
            _maxConcurrency,
            _maxTotalRuns,
            _endpoint,
            _baselineEndpoint,
            _changedSince,
            _restExchange,
            _llmExchange,
            _dryRun,
            _json,
            _failOnRegression,
            _verbose,
        };

        run.SetHandler(HandleRunAsync);

        return run;
    }

    /// <summary>
    /// Builds the <c>baseline</c> command group, which owns the verified replacement route.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Separate from <c>run</c> on purpose, and that separation is the safety property.</b>
    /// Nothing a <c>run</c> invocation can be given replaces a file that same invocation reads, so
    /// no invocation that is safe today becomes destructive because an option was added later. The
    /// shape was chosen in the previous build for exactly this arrival.
    /// </para>
    /// <para>
    /// <b>This is not the only way a file gets replaced — it is the only way one gets
    /// <i>verified</i> before it is replaced.</b> <c>run --out --overwrite</c> will replace
    /// whatever sits at the path it was given, including a baseline it was not handed as
    /// <c>--baseline</c>; what it cannot do is reach a file this invocation also reads. What this
    /// command adds on top is knowledge of the thing being replaced: it never creates, it refuses
    /// a foreign suite, it refuses an errored run, and it replaces only the bytes it read.
    /// </para>
    /// <para>
    /// <c>--apply</c> is the opt-in and it is the only thing that writes. A bare
    /// <c>baseline update</c> conducts the suite, compares, prints the diff shape, and leaves the
    /// file alone — the preview is the default rather than a flag, so forgetting a flag can only
    /// make this command do less.
    /// </para>
    /// <para>
    /// <c>--out</c>, <c>--overwrite</c>, <c>--changed-since</c>, <c>--baseline-endpoint</c>, and
    /// <c>--dry-run</c> are deliberately absent: the first two because this command writes one
    /// file and it is <c>--baseline</c>, the third because a baseline is a statement about a whole
    /// suite, the fourth because a live system is not something that can be written over, and the
    /// fifth because the safe default already is the preview.
    /// </para>
    /// </remarks>
    private Command BuildBaselineCommand()
    {
        var update = new Command(
            "update",
            "Replace a committed baseline with a fresh run. Previews by default; --apply writes."
        )
        {
            _suite,
            _root,
            _baseline,
            _seed,
            _maxConcurrency,
            _maxTotalRuns,
            _endpoint,
            _restExchange,
            _llmExchange,
            _apply,
            _json,
            _verbose,
        };

        update.SetHandler(HandleBaselineUpdateAsync);

        var baseline = new Command("baseline", "Manage committed baselines.") { update };

        // No subcommand under `baseline` is the same refusal a bare invocation earns: help on
        // stderr so a piped stdout stays clean, and a usage code because nothing was asked for.
        baseline.SetHandler(context =>
        {
            context.Console.Error.Write(RenderHelp(context.HelpBuilder, baseline, context.ParseResult));
            context.ExitCode = (int)ExitCode.UsageError;
        });

        return baseline;
    }

    /// <summary>
    /// Builds the <c>trend</c> command, which reads a directory of artifacts and writes nothing
    /// into it.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>A separate command because it answers a separate question.</b> <c>run --report-markdown</c>
    /// asks whether this change is better or worse than the baseline. This asks where the suite has
    /// been going. Merging them would produce one report that answers neither well, and one
    /// pull-request comment that alternated between two documents.
    /// </para>
    /// <para>
    /// <c>--suite</c>, <c>--endpoint</c> and every option that conducts anything are absent: this
    /// command runs no scenario and dials nothing. <c>--fail-on-regression</c> is absent too —
    /// the gate is reserved, and an option accepted here would read as one that might act.
    /// <c>--verbose</c> is absent for the same reason: this command builds no service provider,
    /// so there is nothing for it to turn on, and a flag that is accepted and does nothing is a
    /// smaller version of the same lie.
    /// </para>
    /// </remarks>
    private Command BuildTrendCommand()
    {
        var trend = new Command(
            "trend",
            "Report how a suite has moved across a directory of run artifacts. Reads only; prints by default."
        )
        {
            _artifacts,
            _root,
            _trendReport,
            _trendOverwrite,
        };

        trend.SetHandler(HandleTrendAsync);

        return trend;
    }

    private async Task HandleTrendAsync(InvocationContext context)
    {
        var plan = TrendPlan.Create(BindTrendRequest(context.ParseResult));

        var code = await TrendCommand
            .ExecuteAsync(plan, context.Console, context.GetCancellationToken())
            .ConfigureAwait(false);

        context.ExitCode = (int)code;
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

    private async Task HandleBaselineUpdateAsync(InvocationContext context)
    {
        var plan = RunPlan.CreateForBaselineUpdate(BindRequest(context.ParseResult));

        var code = await BaselineCommand
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
        output.WriteLine("run never replaces a file it was also asked to read: --out and");
        output.WriteLine("--report-markdown may not be --suite or --baseline, and --overwrite does not");
        output.WriteLine("lift that. With --overwrite it will replace any other existing file at the");
        output.WriteLine("path you name, including a committed baseline you did not pass as --baseline.");
        output.WriteLine();
        output.WriteLine("Replacing a committed baseline has its own command, which previews by default");
        output.WriteLine("and verifies what it replaces - it refuses a foreign suite, refuses a run with");
        output.WriteLine("errored scenarios, and replaces only the bytes it read:");
        output.WriteLine();
        output.WriteLine("  eval-cli baseline update --suite eval-suites/regression.json \\");
        output.WriteLine("      --baseline artifacts/baseline.json --endpoint <url> --rest-exchange json");
        output.WriteLine();
        output.WriteLine("That conducts the suite, reports how many scenarios would change, and writes");
        output.WriteLine("nothing. Add --apply to replace the baseline.");
        output.WriteLine();
        output.WriteLine("How a suite has moved across a series of runs is a separate report, from a");
        output.WriteLine("separate command. It reads the directory and writes nothing into it:");
        output.WriteLine();
        output.WriteLine("  eval-cli trend --artifacts artifacts/nightly");
        output.WriteLine();
        output.WriteLine("Add --report-markdown <path> to write the report for CI to post instead of");
        output.WriteLine("printing it. An existing file there is refused unless --overwrite is passed.");
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
