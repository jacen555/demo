using System.CommandLine.IO;
using FluentAssertions;
using Forge.EvalCli.Diagnostics;

namespace Forge.EvalCli.Tests.Diagnostics;

public class DiagnosticsWriterTests
{
    [Fact]
    public void WriteLine_WhenNothingIsDiverting_WritesTheLineToTheDestination()
    {
        using var destination = new StringWriter();
        using var writer = new DiagnosticsWriter(destination);

        writer.WriteLine("fail: a record");

        destination.ToString().Should().Be("fail: a record" + Environment.NewLine);
    }

    [Fact]
    public void WriteLine_HandsTheDestinationTheLineAndItsNewlineInOneWrite()
    {
        // The positive control, through the same recorder: the console's own adapter turns one
        // WriteLine into two writes, which is the gap another writer's line can land in.
        var adapterCalls = new List<string>();
        var adapter = StandardStreamWriter.Create(new CallRecorder(adapterCalls)).CreateTextWriter();

        adapter.WriteLine("fail: a record");

        adapterCalls.Should().HaveCount(2, "the adapter writes the text, then the newline");

        var calls = new List<string>();
        using var writer = new DiagnosticsWriter(
            StandardStreamWriter.Create(new CallRecorder(calls)).CreateTextWriter()
        );

        writer.WriteLine("fail: a record");

        calls.Should().Equal("fail: a record" + Environment.NewLine);
    }

    [Fact]
    public async Task WriteLine_FromConcurrentWriters_KeepsEveryLineWhole()
    {
        using var destination = new StringWriter();
        using var writer = new DiagnosticsWriter(destination);

        await Task.WhenAll(
            Enumerable
                .Range(0, 8)
                .Select(thread =>
                    Task.Run(() =>
                    {
                        for (var line = 0; line < 250; line++)
                        {
                            writer.WriteLine($"thread {thread} line {line} end");
                        }
                    })
                )
        );

        var lines = destination.ToString().Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries);

        lines.Should().HaveCount(8 * 250);
        lines.Should().OnlyContain(line => line.StartsWith("thread ") && line.EndsWith(" end"));
    }

    [Fact]
    public async Task WriteLineAsync_FromConcurrentWriters_KeepsEveryLineWhole()
    {
        // The overload the start line is written with. TextWriter's own implementation of it writes
        // one character at a time, each taking the lock afresh, so lines from two writers would mix.
        using var destination = new StringWriter();
        using var writer = new DiagnosticsWriter(destination);

        await Task.WhenAll(
            Enumerable
                .Range(0, 8)
                .Select(thread =>
                    Task.Run(async () =>
                    {
                        for (var line = 0; line < 250; line++)
                        {
                            await writer.WriteLineAsync(
                                $"thread {thread} line {line} end".AsMemory(),
                                CancellationToken.None
                            );
                        }
                    })
                )
        );

        var lines = destination.ToString().Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries);

        lines.Should().HaveCount(8 * 250);
        lines.Should().OnlyContain(line => line.StartsWith("thread ") && line.EndsWith(" end"));
    }

    [Fact]
    public async Task WriteLineAsync_WithACancelledToken_WritesNothing()
    {
        using var destination = new StringWriter();
        using var writer = new DiagnosticsWriter(destination);

        var act = () =>
            writer.WriteLineAsync("eval-cli: starting suite".AsMemory(), new CancellationToken(canceled: true));

        await act.Should().ThrowAsync<OperationCanceledException>();
        destination.ToString().Should().BeEmpty();
    }

    [Fact]
    public void WriteLine_WhileDiverted_HandsTheLineToTheDisplayInsteadOfTheDestination()
    {
        using var destination = new StringWriter();
        using var writer = new DiagnosticsWriter(destination);
        var drawn = new List<string>();

        using (
            writer.Divert(line =>
            {
                drawn.Add(line);

                return true;
            })
        )
        {
            writer.WriteLine("fail: while the display is up");
        }

        writer.WriteLine("fail: after it is down");

        drawn.Should().Equal("fail: while the display is up");

        // The positive control for the absence above: the destination receives what is not diverted.
        destination.ToString().Should().Be("fail: after it is down" + Environment.NewLine);
    }

    [Fact]
    public void WriteLine_WhenTheDisplayDeclinesALine_StillWritesItToTheDestination()
    {
        using var destination = new StringWriter();
        using var writer = new DiagnosticsWriter(destination);

        using (writer.Divert(_ => false))
        {
            writer.WriteLine("fail: a display that failed must not lose this");
        }

        destination.ToString().Should().Be("fail: a display that failed must not lose this" + Environment.NewLine);
    }

    [Fact]
    public void Write_InPieces_EmitsOneWholeLinePerNewline()
    {
        using var destination = new StringWriter();
        using var writer = new DiagnosticsWriter(destination);

        writer.Write("fail: ");
        writer.Write("in pieces\r\n");
        writer.Write('x');
        writer.Write('\n');

        destination.ToString().Should().Be("fail: in pieces" + Environment.NewLine + "x" + Environment.NewLine);
    }

    [Fact]
    public void Divert_WhileAlreadyDiverted_Refuses()
    {
        using var destination = new StringWriter();
        using var writer = new DiagnosticsWriter(destination);

        using var first = writer.Divert(_ => true);

        var act = () => writer.Divert(_ => true);

        act.Should().Throw<InvalidOperationException>();
    }

    /// <summary>Records each write it receives as one entry, so a split line shows as two.</summary>
    private sealed class CallRecorder(List<string> calls) : TextWriter
    {
        public override System.Text.Encoding Encoding => System.Text.Encoding.UTF8;

        public override void Write(char value) => calls.Add(value.ToString());

        public override void Write(string? value) => calls.Add(value ?? string.Empty);
    }
}
