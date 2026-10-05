using System.Text;
using Forge.EvalCli.Diagnostics;
using Forge.EvalEngine.Coordination;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;
using Microsoft.Extensions.Logging;
using Spectre.Console;

namespace Forge.EvalCli.Tests.Support;

/// <summary>
/// Standard error as Spectre.Console sees it, with the one fact a test needs to control: whether
/// it is a terminal.
/// </summary>
/// <remarks>
/// <para>
/// <b>The same harness has to be able to see a live display and see its absence.</b> A probe that
/// cannot observe drawing proves nothing when it observes none, so every assertion that something
/// was <i>not</i> drawn here is paired with one, through this same type, that something was.
/// </para>
/// <para>
/// <b>Isolated from the machine it runs on.</b> Spectre's CI enrichers read environment variables,
/// so on a build agent an unisolated console would quietly stop being interactive and these tests
/// would pass or fail by where they ran. Every console built here is handed an explicit
/// environment.
/// </para>
/// </remarks>
internal sealed class FakeTerminal : IAnsiConsoleOutput, IDisposable
{
    private readonly Recorder _recorder;

    /// <summary>Initializes a new instance of the <see cref="FakeTerminal"/> class.</summary>
    /// <param name="isTerminal">What Spectre is told when it asks whether this is a terminal.</param>
    /// <param name="onFirstWrite">
    /// Run once, inside the first write Spectre makes — the moment a display is starting, which a
    /// test can use to cancel at exactly that point rather than racing it.
    /// </param>
    public FakeTerminal(bool isTerminal, Action? onFirstWrite = null)
    {
        IsTerminal = isTerminal;
        _recorder = new Recorder(onFirstWrite);
    }

    public TextWriter Writer => _recorder;

    public bool IsTerminal { get; }

    public int Width => 120;

    public int Height => 40;

    /// <summary>Gets everything Spectre wrote, escape codes included.</summary>
    public string Output => _recorder.Text;

    /// <summary>Makes every later write throw, as a console that has gone away would.</summary>
    public void Fail() => _recorder.Failing = true;

    public void SetEncoding(Encoding encoding) { }

    public void Dispose() => _recorder.Dispose();

    /// <summary>Builds a Spectre console over this output.</summary>
    /// <param name="interactive">Whether Spectre is told the session is interactive.</param>
    /// <param name="ansi">Whether Spectre is told the output understands ANSI.</param>
    /// <param name="environment">The environment Spectre's enrichers read. Empty by default.</param>
    /// <returns>The console.</returns>
    public IAnsiConsole Console(
        bool interactive = true,
        bool ansi = true,
        Dictionary<string, string>? environment = null
    ) =>
        AnsiConsole.Create(
            new AnsiConsoleSettings
            {
                Out = this,
                Ansi = ansi ? AnsiSupport.Yes : AnsiSupport.No,
                Interactive = interactive ? InteractionSupport.Yes : InteractionSupport.No,
                ColorSystem = ColorSystemSupport.NoColors,
                EnvironmentVariables = environment ?? new Dictionary<string, string>(),
            }
        );

    /// <summary>A writer that can be read while another thread writes, and told to fail.</summary>
    private sealed class Recorder(Action? onFirstWrite) : TextWriter
    {
        private readonly StringBuilder _text = new();
        private readonly object _gate = new();
        private volatile bool _failing;
        private Action? _onFirstWrite = onFirstWrite;

        public bool Failing
        {
            set => _failing = value;
        }

        public override Encoding Encoding => Encoding.UTF8;

        public string Text
        {
            get
            {
                lock (_gate)
                {
                    return _text.ToString();
                }
            }
        }

        public override void Write(char value)
        {
            RunFirstWriteHook();

            lock (_gate)
            {
                ThrowIfFailing();
                _text.Append(value);
            }
        }

        public override void Write(string? value)
        {
            RunFirstWriteHook();

            lock (_gate)
            {
                ThrowIfFailing();
                _text.Append(value);
            }
        }

        private void RunFirstWriteHook() => Interlocked.Exchange(ref _onFirstWrite, null)?.Invoke();

        private void ThrowIfFailing()
        {
            if (_failing)
            {
                throw new IOException("The console went away.");
            }
        }
    }
}

/// <summary>Engine values for progress tests, built directly so each test states only what it varies.</summary>
internal static class ProgressFixture
{
    /// <summary>A suite of the given scenarios, each with the given number of repetitions.</summary>
    public static Suite Suite(string name, params (string Id, int Repetitions)[] scenarios) =>
        new()
        {
            Name = name,
            Scenarios =
            [
                .. scenarios.Select(scenario => new Scenario
                {
                    Identity = new ScenarioIdentity { Id = scenario.Id, Kind = ScenarioKind.Rest },
                    Execution = new Execution
                    {
                        Mode = ExecutionMode.Deterministic,
                        RepetitionPolicy = RepetitionPolicy.Repeat(scenario.Repetitions),
                    },
                }),
            ],
        };

    /// <summary>A result for a conduct delegate to return. Its contents are never inspected.</summary>
    public static SuiteResult Result(string name) =>
        new()
        {
            SuiteName = name,
            Environment = new EvaluationEnvironment { Seed = 0, Timestamp = DateTimeOffset.UnixEpoch },
        };

    /// <summary>One completed run, as the coordinator reports it.</summary>
    public static RunProgress Report(
        int completed,
        int total,
        string scenarioId = "checkout",
        int repetition = 1,
        RunStatus status = RunStatus.Pass
    ) => new(completed, total, scenarioId, repetition, status);

    /// <summary>The tool's own stderr logger, writing somewhere a test can read.</summary>
    public static ILogger Logger(StringWriter log) => new StandardErrorLoggerProvider(log).CreateLogger("progress");

    /// <summary>A conduct delegate that reports the given runs in the given order and returns a result.</summary>
    public static Func<IProgress<RunProgress>?, Task<SuiteResult>> Reporting(
        string name,
        Action<IProgress<RunProgress>?>? before,
        params RunProgress[] reports
    ) =>
        sink =>
        {
            before?.Invoke(sink);

            foreach (var report in reports)
            {
                sink?.Report(report);
            }

            return Task.FromResult(Result(name));
        };
}
