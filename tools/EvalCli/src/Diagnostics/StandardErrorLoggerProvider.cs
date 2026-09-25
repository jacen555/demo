using System.Globalization;
using Microsoft.Extensions.Logging;

namespace Forge.EvalCli.Diagnostics;

/// <summary>
/// Writes log records to standard error.
/// </summary>
/// <remarks>
/// <para>
/// <b>Diagnostics go to stderr so the tool composes.</b> Standard output carries the result — the
/// dry-run plan, and later the report — and a caller must be able to pipe that into another
/// process without log lines contaminating it. The console provider that ships with
/// <c>Microsoft.Extensions.Logging</c> writes to stdout, which would break exactly that, so this
/// tool supplies its own rather than reconfiguring one that is wrong by default.
/// </para>
/// <para>
/// The engine's own default is a null logger. Replacing it here is the point of a composition
/// root: a library that cannot see where it is running should not choose where its signals go.
/// </para>
/// <para>
/// <b>No stack trace is written, and the record's text is netted.</b> Frames carry the checkout
/// directory and the source layout of the machine that built the tool, which is the disclosure
/// <see cref="Cli.ExitCodeReporter"/> already refuses for every outcome except a defect — and a
/// run the harness could not conduct is a deliberate refusal, not a defect, so dumping its trace
/// here would reintroduce exactly what that policy exists to prevent (§V). The exception's type
/// and its netted message say what happened; the trace said where this machine keeps its sources.
/// </para>
/// </remarks>
internal sealed class StandardErrorLoggerProvider : ILoggerProvider
{
    private readonly TextWriter _writer;
    private readonly object _gate = new();

    /// <summary>Initializes a new instance of the <see cref="StandardErrorLoggerProvider"/> class.</summary>
    /// <param name="writer">Where records are written. Owned by the caller and never disposed here.</param>
    /// <exception cref="ArgumentNullException"><paramref name="writer"/> is null.</exception>
    public StandardErrorLoggerProvider(TextWriter writer)
    {
        ArgumentNullException.ThrowIfNull(writer);

        _writer = writer;
    }

    /// <inheritdoc/>
    public ILogger CreateLogger(string categoryName) => new StandardErrorLogger(this, categoryName);

    /// <inheritdoc/>
    /// <remarks>
    /// The writer belongs to the console this tool was invoked with, so disposing it here would
    /// close a stream this provider does not own.
    /// </remarks>
    public void Dispose() => GC.SuppressFinalize(this);

    private void Write(LogLevel level, string category, string message, Exception? exception)
    {
        // Runs concurrently once a suite is executing with more than one run in flight, and a
        // half-interleaved log line is worse than a slow one.
        lock (_gate)
        {
            _writer.WriteLine(
                string.Create(CultureInfo.InvariantCulture, $"{Abbreviate(level)}: {category}: {Netted(message)}")
            );

            if (exception is not null)
            {
                _writer.WriteLine(
                    string.Create(
                        CultureInfo.InvariantCulture,
                        $"      {exception.GetType().Name}: {Netted(exception.Message)}"
                    )
                );
            }

            _writer.Flush();
        }
    }

    /// <summary>
    /// Puts engine-composed log text through the report's redaction net.
    /// </summary>
    /// <param name="text">The formatted record, or an exception's message.</param>
    /// <returns>The text, with any machine path aliased.</returns>
    /// <remarks>
    /// <para>
    /// <b>The engine names the scenario it is logging about, and that name is author-supplied.</b>
    /// ADR 0005 puts the control at authoring time and records that it exempts a leading request
    /// method, so a scenario called <c>GET /home/ci-runner/work</c> loads by design — and a run it
    /// could not conduct is then logged, by name, to stderr and from there to the build log.
    /// </para>
    /// <para>
    /// That concession was reasoned about for the Markdown document, where the report's net is a
    /// second layer. A log stream is another surface it was never reasoned about, which is the
    /// shape ADR 0005's amendment predicts: the exemption has not changed, the number of channels
    /// it reaches has.
    /// </para>
    /// <para>
    /// <b>Unlike a loader finding, this cannot be composed from parts — it arrives already
    /// formatted — so the net is applied to prose and takes the rest of the line with it.</b>
    /// <c>MachinePath</c> matches to the end of the value on purpose, and in a sentence that
    /// means the explanation after the identifier is lost. ADR 0005 records why a better filter
    /// is not the answer: prose does not tokenise like an identifier. The cost is bounded and
    /// falls where it should — the net only fires on machine-path-shaped text, so an ordinarily
    /// named scenario logs verbatim and only a suite that named one after a checkout directory
    /// pays, which is the authoring error the control exists to discourage. "Diagnostics are
    /// terser" is ADR 0005's own stated consequence.
    /// </para>
    /// </remarks>
    private static string Netted(string text) =>
        Cli.MarkdownReport.Sanitize(text, Cli.MarkdownReport.MaxReasonCharacters);

    private static string Abbreviate(LogLevel level) =>
        level switch
        {
            LogLevel.Trace => "trce",
            LogLevel.Debug => "dbug",
            LogLevel.Information => "info",
            LogLevel.Warning => "warn",
            LogLevel.Error => "fail",
            LogLevel.Critical => "crit",
            _ => "none",
        };

    private sealed class StandardErrorLogger : ILogger
    {
        private readonly StandardErrorLoggerProvider _provider;
        private readonly string _category;

        public StandardErrorLogger(StandardErrorLoggerProvider provider, string category)
        {
            _provider = provider;
            _category = category;
        }

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter
        )
        {
            ArgumentNullException.ThrowIfNull(formatter);

            if (!IsEnabled(logLevel))
            {
                return;
            }

            _provider.Write(logLevel, _category, formatter(state, exception), exception);
        }
    }
}
