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

    public RecordingConsole()
    {
        Out = StandardStreamWriter.Create(_out);
        Error = StandardStreamWriter.Create(_error);
    }

    public IStandardStreamWriter Out { get; }

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
