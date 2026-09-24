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
                string.Create(CultureInfo.InvariantCulture, $"{Abbreviate(level)}: {category}: {message}")
            );

            if (exception is not null)
            {
                _writer.WriteLine(exception.ToString());
            }

            _writer.Flush();
        }
    }

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
