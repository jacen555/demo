using System.Text;

namespace Forge.EvalCli.Diagnostics;

/// <summary>
/// The one way a line of diagnostics reaches standard error while a suite runs: log records and
/// streamed progress alike.
/// </summary>
/// <remarks>
/// <para>
/// <b>Every line is written whole, under one lock.</b> <see cref="TextWriter.WriteLine(string)"/>
/// is two writes in the base class — the text, then the newline — so two writers sharing a stream
/// can interleave between them. Once a suite runs with more than one run in flight, a log record
/// and a progress line are written from different workers at once, and the result is a progress
/// line glued to the end of an error. Funnelling both through here makes each line one write.
/// </para>
/// <para>
/// <b>A live display can take lines over while it is drawing.</b> A live display redraws its
/// region in place by moving the cursor back up over it, so a record written beneath it is
/// spliced into that region at the next redraw. Measured in a real pseudo-console: none of three
/// records written that way ended up on a line of its own — each was shifted to the region's right
/// edge, and the last was glued onto the bar. While a display is
/// <see cref="Divert">diverting</see>, each line is handed to it to draw above its region instead.
/// A line it declines is written here as usual, so a display that has failed cannot lose a record.
/// </para>
/// <para>
/// The destination belongs to the console this tool was invoked with, and is never disposed here.
/// </para>
/// </remarks>
internal sealed class DiagnosticsWriter : TextWriter
{
    private readonly TextWriter _destination;
    private readonly object _gate = new();
    private readonly StringBuilder _pending = new();
    private Func<string, bool>? _route;

    /// <summary>Initializes a new instance of the <see cref="DiagnosticsWriter"/> class.</summary>
    /// <param name="destination">Standard error. Owned by the caller and never disposed here.</param>
    /// <exception cref="ArgumentNullException"><paramref name="destination"/> is null.</exception>
    public DiagnosticsWriter(TextWriter destination)
    {
        ArgumentNullException.ThrowIfNull(destination);

        _destination = destination;
    }

    /// <inheritdoc/>
    public override Encoding Encoding => _destination.Encoding;

    /// <inheritdoc/>
    public override void Write(char value)
    {
        lock (_gate)
        {
            if (value == '\n')
            {
                Emit(_pending.ToString().TrimEnd('\r'));
                _pending.Clear();

                return;
            }

            _pending.Append(value);
        }
    }

    /// <inheritdoc/>
    public override void Write(string? value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return;
        }

        lock (_gate)
        {
            foreach (var character in value)
            {
                Write(character);
            }
        }
    }

    /// <inheritdoc/>
    /// <remarks>The line is written in one piece, with anything already pending in front of it.</remarks>
    public override void WriteLine(string? value)
    {
        lock (_gate)
        {
            Emit(_pending.Append(value).ToString());
            _pending.Clear();
        }
    }

    /// <inheritdoc/>
    public override void Flush()
    {
        lock (_gate)
        {
            _destination.Flush();
        }
    }

    /// <inheritdoc/>
    /// <remarks>
    /// <para>
    /// <b>Cancellation reaches the write, not into it.</b> A token cancelled before the write starts
    /// means nothing is written. A write already under way runs to completion: the console stream
    /// underneath is written synchronously, and a write blocked on a stalled pipe stays blocked
    /// whatever the token says.
    /// </para>
    /// <para>
    /// <b>Overridden because the inherited one breaks this type's one promise.</b> TextWriter writes
    /// this overload a character at a time, each taking the lock afresh — measured: eight concurrent
    /// writers produced 1,857 lines from 2,000, some of them spliced mid-word. Routed through
    /// <see cref="WriteLine(string)"/>, it is written whole like every other line.
    /// </para>
    /// </remarks>
    public override Task WriteLineAsync(ReadOnlyMemory<char> buffer, CancellationToken cancellationToken = default) =>
        Task.Factory.StartNew(
            static state =>
            {
                var (writer, line) = ((DiagnosticsWriter Writer, string Line))state!;

                writer.WriteLine(line);
            },
            (this, buffer.ToString()),
            cancellationToken,
            TaskCreationOptions.DenyChildAttach,
            TaskScheduler.Default
        );

    /// <summary>Hands every line to <paramref name="route"/> until the returned scope is disposed.</summary>
    /// <param name="route">
    /// Draws a line, and reports whether it did. A line it declines is written to standard error.
    /// </param>
    /// <returns>The scope. Disposing it writes lines to standard error again.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="route"/> is null.</exception>
    /// <exception cref="InvalidOperationException">Something is already diverting.</exception>
    internal IDisposable Divert(Func<string, bool> route)
    {
        ArgumentNullException.ThrowIfNull(route);

        lock (_gate)
        {
            if (_route is not null)
            {
                throw new InvalidOperationException("Diagnostics are already being diverted to a display.");
            }

            _route = route;
        }

        return new Diversion(this);
    }

    private void Emit(string line)
    {
        if (_route?.Invoke(line) == true)
        {
            return;
        }

        _destination.Write(line + NewLine);
        _destination.Flush();
    }

    private void Restore()
    {
        lock (_gate)
        {
            _route = null;
        }
    }

    private sealed class Diversion(DiagnosticsWriter writer) : IDisposable
    {
        private int _disposed;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
            {
                writer.Restore();
            }
        }
    }
}
