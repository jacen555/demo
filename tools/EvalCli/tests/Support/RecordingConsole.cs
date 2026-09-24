using System.CommandLine;
using System.CommandLine.IO;

namespace Forge.EvalCli.Tests.Support;

/// <summary>
/// A console that keeps standard output and standard error apart, so a test can assert on the
/// contract that results go to one and diagnostics go to the other.
/// </summary>
internal sealed class RecordingConsole : IConsole, IDisposable
{
    private readonly StringWriter _out = new();
    private readonly StringWriter _error = new();
    private readonly IStandardStreamWriter _outWriter;
    private readonly Action? _whenOutIsFirstRead;
    private int _outReads;

    public RecordingConsole()
        : this(whenOutIsFirstRead: null) { }

    /// <summary>Records output, and runs <paramref name="whenOutIsFirstRead"/> before the first write.</summary>
    /// <param name="whenOutIsFirstRead">
    /// Run once, the first time a command reaches for standard output. That is the instant after
    /// every side effect a command has and before any of it is reported, which is the only place a
    /// test can interrupt a command between the two.
    /// </param>
    public RecordingConsole(Action? whenOutIsFirstRead)
    {
        _whenOutIsFirstRead = whenOutIsFirstRead;
        _outWriter = StandardStreamWriter.Create(_out);
        Error = StandardStreamWriter.Create(_error);
    }

    public IStandardStreamWriter Out
    {
        get
        {
            if (Interlocked.Exchange(ref _outReads, 1) == 0)
            {
                _whenOutIsFirstRead?.Invoke();
            }

            return _outWriter;
        }
    }

    public IStandardStreamWriter Error { get; }

    public bool IsOutputRedirected => true;

    public bool IsErrorRedirected => true;

    public bool IsInputRedirected => false;

    /// <summary>Gets everything written to standard output.</summary>
    public string StandardOut => _out.ToString();

    /// <summary>Gets everything written to standard error.</summary>
    public string StandardError => _error.ToString();

    public void Dispose()
    {
        _out.Dispose();
        _error.Dispose();
    }
}
