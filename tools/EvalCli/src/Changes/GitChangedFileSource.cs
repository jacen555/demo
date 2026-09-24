using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using Microsoft.Extensions.Logging;

namespace Forge.EvalCli.Changes;

/// <summary>
/// Acquires the changed-file set by asking git, and refuses anything it cannot vouch for.
/// </summary>
/// <remarks>
/// <para>
/// <b>Every refusal here ends in a full-suite run, never in a smaller one.</b> Git missing, a
/// directory that is not a repository, an unknown revision, output that would not decode, a path
/// outside <c>--root</c> — each of them means the set is not known to be complete, and a set that
/// is not known to be complete must not be used to decide what to skip. Over-selecting costs
/// time; under-selecting costs correctness and costs it invisibly.
/// </para>
/// <para>
/// <b>Arguments are passed as an array, never as one concatenated string</b> (§V). Nothing here
/// goes through a shell, so a revision cannot smuggle in another command. The revision is
/// validated as well, and <c>--end-of-options</c> stands between it and git's own option parser,
/// so a value beginning with <c>-</c> cannot become a flag.
/// </para>
/// <para>
/// Three facts are read, in order, because each is meaningless without the one before it: the
/// repository's top level, the diff against the named revision, and the untracked files. The top
/// level is what makes the other two interpretable at all — <c>git diff</c> emits paths relative
/// to it, not to the working directory and not to <c>-C</c> — and <c>git ls-files --others</c> is
/// run from there for the same reason, because it would otherwise answer relative to, and only
/// about, whatever directory it was started in.
/// </para>
/// <para>
/// <b>Untracked files are part of the answer, not an afterthought.</b> A diff reports tracked
/// files only, so a brand new source file is invisible to it. The shape that costs a scenario its
/// run is the mixed one: one tracked file also changed, so the set is non-empty and looks
/// authoritative, while the new file that actually breaks something is missing. An empty set
/// already widens the run; a merely incomplete one does not.
/// </para>
/// </remarks>
internal sealed partial class GitChangedFileSource : IChangedFileSource
{
    /// <summary>The most diff output that will be read without asking — eight mebibytes.</summary>
    /// <remarks>
    /// A diff naming enough files to exceed this is not a change anybody is impact-selecting for,
    /// and the alternative to a stated ceiling is an exhausted host. The same shape as the
    /// engine's run budget: the consequential number is bounded rather than trusted.
    /// </remarks>
    internal const int MaxDiffBytes = 8 * 1024 * 1024;

    /// <summary>The most of git's own error output that is kept — sixty-four kibibytes.</summary>
    /// <remarks>
    /// Only the first line of it is ever used, so this is a ceiling on memory rather than a
    /// judgement about the message. It is bounded for the same reason standard output is: a
    /// subprocess decides how much it writes, and this process decides how much it holds.
    /// </remarks>
    internal const int MaxStandardErrorBytes = 64 * 1024;

    private readonly string _root;
    private readonly string _revision;
    private readonly ILogger<GitChangedFileSource> _logger;

    /// <summary>Initializes a new instance of the <see cref="GitChangedFileSource"/> class.</summary>
    /// <param name="rootDirectory">The canonical containment root. Impact globs are anchored here.</param>
    /// <param name="revision">The revision to diff against, already validated.</param>
    /// <param name="logger">Where a refusal is signalled, in addition to being returned.</param>
    /// <exception cref="ArgumentException">Either string argument is blank.</exception>
    /// <exception cref="ArgumentNullException"><paramref name="logger"/> is null.</exception>
    public GitChangedFileSource(string rootDirectory, string revision, ILogger<GitChangedFileSource> logger)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(rootDirectory);
        ArgumentException.ThrowIfNullOrWhiteSpace(revision);
        ArgumentNullException.ThrowIfNull(logger);

        _root = rootDirectory;
        _revision = revision;
        _logger = logger;
    }

    /// <summary>Validates a revision supplied on the command line.</summary>
    /// <param name="revision">The value as supplied.</param>
    /// <param name="rejection">Why it was refused, or null.</param>
    /// <returns><see langword="true"/> when the value is shaped like a revision.</returns>
    /// <remarks>
    /// Not an attempt to decide whether the revision <i>exists</i> — git owns that, and answers
    /// it when asked. This refuses the shapes that would stop the value being read as a revision
    /// at all: a leading <c>-</c>, which git's own parser would take for an option, and the
    /// control characters that cannot appear in a ref name.
    /// </remarks>
    public static bool TryValidateRevision(string? revision, out string? rejection)
    {
        if (string.IsNullOrWhiteSpace(revision))
        {
            rejection = "is blank, so it names no revision";
            return false;
        }

        if (revision.StartsWith('-'))
        {
            rejection =
                "begins with '-', which git would read as an option rather than a revision. Use a revision name, "
                + "a branch, or a commit id";
            return false;
        }

        if (revision.Any(char.IsControl))
        {
            rejection = "contains a control character, which a git revision name cannot";
            return false;
        }

        rejection = null;
        return true;
    }

    /// <inheritdoc/>
    public async Task<ChangedFileSet> GetChangedFilesAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        var topLevel = await RunAsync(["-C", _root, "rev-parse", "--show-toplevel"], cancellationToken)
            .ConfigureAwait(false);

        if (!topLevel.Started)
        {
            return Refuse(
                "git could not be started, so no changed-file set could be acquired. It is either not installed "
                    + "or not on PATH",
                topLevel.Command
            );
        }

        if (topLevel.ExitCode != 0)
        {
            return Refuse(
                $"'{_root}' is not inside a git repository, so there is no diff to read a changed-file set from"
                    + Because(topLevel.StandardError),
                topLevel.Command
            );
        }

        if (!TryCanonicalize(topLevel, out var repositoryRoot, out var canonicalizeRejection))
        {
            return Refuse(canonicalizeRejection!, topLevel.Command);
        }

        if (!GitDiffReading.TryComputePrefix(repositoryRoot!, _root, out var prefix, out var prefixRejection))
        {
            return Refuse(prefixRejection!, topLevel.Command);
        }

        var diff = await RunAsync(
                [
                    "-C",
                    _root,
                    "--no-pager",
                    "diff",
                    "-z",
                    "--name-only",
                    "--no-renames",
                    "--end-of-options",
                    _revision,
                    "--",
                ],
                cancellationToken
            )
            .ConfigureAwait(false);

        if (!diff.Started)
        {
            return Refuse("git could not be started to read the diff", diff.Command);
        }

        if (diff.ExitCode != 0)
        {
            return Refuse(
                $"git could not diff against revision '{_revision}'" + Because(diff.StandardError),
                diff.Command
            );
        }

        if (diff.Truncated)
        {
            return Refuse(
                "git's diff output exceeded "
                    + MaxDiffBytes.ToString(CultureInfo.InvariantCulture)
                    + " bytes and was not read to the end, so the changed-file set it describes is incomplete",
                diff.Command
            );
        }

        if (!GitDiffReading.TryDecodeNulSeparated(diff.StandardOutput, out var repoRelative, out var framingRejection))
        {
            return Refuse(framingRejection!, diff.Command);
        }

        // `git diff` reports tracked files only, so a brand new file is invisible to it. That is
        // the dangerous half of this: a change that also touched one tracked file produces a
        // non-empty set, and a non-empty set is never fallen back from — so the run narrows
        // around a file nobody mentioned. Asked as a second question because git has no single
        // command that answers both.
        var untracked = await RunAsync(
                ["-C", repositoryRoot!, "ls-files", "-z", "--others", "--exclude-standard", "--full-name", "--"],
                cancellationToken
            )
            .ConfigureAwait(false);

        if (!untracked.Started)
        {
            return Refuse("git could not be started to list untracked files", untracked.Command);
        }

        if (untracked.ExitCode != 0)
        {
            return Refuse(
                "git could not list the untracked files, so a new file that nothing has staged could be missing "
                    + "from the changed-file set"
                    + Because(untracked.StandardError),
                untracked.Command
            );
        }

        if (untracked.Truncated)
        {
            return Refuse(
                "git's untracked-file list exceeded "
                    + MaxDiffBytes.ToString(CultureInfo.InvariantCulture)
                    + " bytes and was not read to the end, so the changed-file set it describes is incomplete",
                untracked.Command
            );
        }

        if (
            !GitDiffReading.TryDecodeNulSeparated(
                untracked.StandardOutput,
                out var untrackedPaths,
                out var untrackedRejection
            )
        )
        {
            return Refuse(untrackedRejection!, untracked.Command);
        }

        var source = $"{diff.Command} + {untracked.Command}";
        var rebased = new List<string>(repoRelative.Count + untrackedPaths.Count);
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var path in repoRelative.Concat(untrackedPaths))
        {
            var relative = GitDiffReading.Rebase(path, prefix);

            if (relative is null)
            {
                // Named rather than dropped. A file this run cannot express is a hole in the
                // mapping, and a hole in the mapping that nobody is told about is a scenario
                // quietly retired on a prior pass.
                return Refuse(
                    $"changed file {GitDiffReading.Quote(path)} is inside the repository but outside the --root "
                        + $"directory '{_root}', so it cannot be matched against impact globs anchored there",
                    source
                );
            }

            if (seen.Add(relative))
            {
                rebased.Add(relative);
            }
        }

        return ChangedFileSet.Acquired(rebased, source);
    }

    /// <summary>Resolves git's reported top level the way <c>--root</c> was resolved.</summary>
    /// <remarks>
    /// git answers with forward separators and without following the links a caller's own root
    /// was resolved through, so the two are made comparable before they are compared. The engine's
    /// boundary is used as the canonicalizer rather than a second local one, for the same reason
    /// the containment rule is not restated here.
    /// </remarks>
    private static bool TryCanonicalize(GitResult topLevel, out string? repositoryRoot, out string? rejection)
    {
        repositoryRoot = null;
        rejection = null;

        var reported = topLevel.StandardOutputText.Trim();

        if (string.IsNullOrWhiteSpace(reported))
        {
            rejection = "git reported no repository top level, so a diff path could not be related to --root";
            return false;
        }

        try
        {
            repositoryRoot = new EvalEngine.Paths.PathBoundary(reported).Root;
            return true;
        }
        catch (Exception exception) when (exception is IOException or ArgumentException or NotSupportedException)
        {
            rejection =
                "the repository top level git reported could not be resolved to a real directory, so a diff path "
                + "could not be related to --root";
            return false;
        }
    }

    /// <summary>Records the refusal once, at the point it is decided, and returns it.</summary>
    /// <remarks>
    /// One signal per root cause (§IV). The reason travels in the return value and is printed in
    /// the selection report; the log line exists because a full-suite fallback is quiet by nature
    /// — the run still succeeds — and a fallback nobody notices is the same as no safety net.
    /// </remarks>
    private ChangedFileSet Refuse(string reason, string command)
    {
        LogSetNotEstablished(reason);

        return ChangedFileSet.Unavailable(reason, command);
    }

    // A source-generated delegate rather than a formatted call (CA1848). Its one argument is
    // composed by this type, from this tool's own argument list and — where git explained itself
    // — a sanitized first line, never a raw subprocess message (§V).
    [LoggerMessage(
        EventId = 2000,
        Level = LogLevel.Warning,
        Message = "The changed-file set could not be established, so the whole suite was selected: {Reason}"
    )]
    private partial void LogSetNotEstablished(string reason);

    /// <summary>Appends git's own explanation, sanitized, when it gave one.</summary>
    /// <remarks>
    /// Subprocess output is untrusted (§V). Only the first line survives, control characters are
    /// dropped so nothing can rewrite the terminal, and the length is capped so a flood cannot
    /// bury the message it is attached to.
    /// </remarks>
    private static string Because(string standardError)
    {
        var firstLine = standardError.Split('\n', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()?.Trim();

        if (string.IsNullOrWhiteSpace(firstLine))
        {
            return ".";
        }

        var sanitized = new string([.. firstLine.Where(character => !char.IsControl(character)).Take(200)]);

        return string.IsNullOrWhiteSpace(sanitized) ? "." : $": {sanitized}";
    }

    /// <summary>One completed git invocation.</summary>
    private sealed record GitResult
    {
        public required bool Started { get; init; }

        public required string Command { get; init; }

        public int ExitCode { get; init; }

        public byte[] StandardOutput { get; init; } = [];

        public string StandardError { get; init; } = string.Empty;

        public bool Truncated { get; init; }

        public string StandardOutputText => Encoding.UTF8.GetString(StandardOutput);
    }

    /// <summary>Runs git once and collects what it said.</summary>
    /// <remarks>
    /// Standard output is read as <b>bytes</b>. A path is a sequence of bytes until something
    /// decides otherwise, and letting a <see cref="StreamReader"/> decide would silently
    /// substitute replacement characters for anything it could not read — which is the whole
    /// defect this layer exists to prevent. Framing and decoding happen together, in
    /// <see cref="GitDiffReading"/>, where they are testable against literal bytes.
    /// </remarks>
    private static async Task<GitResult> RunAsync(string[] arguments, CancellationToken cancellationToken)
    {
        var command = "git " + string.Join(' ', arguments);

        var startInfo = new ProcessStartInfo("git")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        foreach (var argument in arguments)
        {
            // An argument list, never a concatenated command line: nothing here is parsed by a
            // shell, so no value can become another command (§V).
            startInfo.ArgumentList.Add(argument);
        }

        using var process = new Process { StartInfo = startInfo };

        try
        {
            process.Start();
        }
        catch (Exception exception) when (exception is Win32Exception or InvalidOperationException)
        {
            return new GitResult { Started = false, Command = command };
        }

        try
        {
            var standardError = ReadCappedAsync(
                process.StandardError.BaseStream,
                MaxStandardErrorBytes,
                cancellationToken
            );
            var (standardOutput, truncated) = await ReadCappedAsync(
                    process.StandardOutput.BaseStream,
                    MaxDiffBytes,
                    cancellationToken
                )
                .ConfigureAwait(false);

            var (errorBytes, _) = await standardError.ConfigureAwait(false);

            await process.WaitForExitAsync(cancellationToken).ConfigureAwait(false);

            return new GitResult
            {
                Started = true,
                Command = command,
                ExitCode = process.ExitCode,
                StandardOutput = standardOutput,
                // Lenient on purpose, unlike the paths: this is a human-readable message that is
                // sanitized and truncated before it is shown, so a byte that will not decode
                // costs a character rather than the message.
                StandardError = Encoding.UTF8.GetString(errorBytes),
                Truncated = truncated,
            };
        }
        catch (OperationCanceledException)
        {
            Terminate(process);

            throw;
        }
    }

    /// <summary>Reads a stream to the end, keeping at most <paramref name="cap"/> bytes of it.</summary>
    /// <param name="stream">The pipe to read.</param>
    /// <param name="cap">The most that will be held in memory.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>What was kept, and whether there was more of it.</returns>
    /// <remarks>
    /// <para>
    /// <b>Reading stops keeping at the ceiling; it does not stop reading.</b> Abandoning a pipe
    /// that is still being written to leaves git blocked on a full buffer, and a git that never
    /// exits is a <see cref="Process.WaitForExitAsync(CancellationToken)"/> that never returns —
    /// so the run neither narrows nor widens, it hangs. Draining costs the time it takes git to
    /// finish writing output nobody will use; the alternative costs the invocation.
    /// </para>
    /// <para>
    /// What is kept is the <i>first</i> <paramref name="cap"/> bytes rather than the last,
    /// because the one caller that reads a capped stream for content wants git's opening line.
    /// The other refuses outright on <c>Truncated</c> and never looks at the bytes.
    /// </para>
    /// </remarks>
    internal static async Task<(byte[] Bytes, bool Truncated)> ReadCappedAsync(
        Stream stream,
        int cap,
        CancellationToken cancellationToken
    )
    {
        using var buffer = new MemoryStream();
        var chunk = new byte[64 * 1024];
        var truncated = false;

        while (true)
        {
            var read = await stream.ReadAsync(chunk, cancellationToken).ConfigureAwait(false);

            if (read == 0)
            {
                return (buffer.ToArray(), truncated);
            }

            var room = (int)Math.Min(read, Math.Max(0, cap - buffer.Length));

            if (room < read)
            {
                truncated = true;
            }

            if (room > 0)
            {
                await buffer.WriteAsync(chunk.AsMemory(0, room), cancellationToken).ConfigureAwait(false);
            }
        }
    }

    /// <summary>Stops a git process that outlived the invocation that started it.</summary>
    private static void Terminate(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch (Exception exception) when (exception is InvalidOperationException or NotSupportedException)
        {
            // It exited between the check and the kill, which is the outcome that was wanted.
        }
        catch (Win32Exception)
        {
            // It could not be signalled. Nothing further can be done here, and the cancellation
            // this is unwinding is already on its way to the caller as the reported outcome.
        }
    }
}
