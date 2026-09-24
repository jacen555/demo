using System.Diagnostics;
using System.Text;

namespace Forge.EvalCli.Tests.Support;

/// <summary>
/// A throwaway git repository on disk.
/// </summary>
/// <remarks>
/// <para>
/// A real repository rather than a stubbed process, because what is under test is how git's
/// actual output is framed and decoded. A fake that emitted what this tool expects would agree
/// with the tool about a format git might not use — which is precisely the class of mistake the
/// changed-file set is vulnerable to.
/// </para>
/// <para>
/// Configuration is set locally and identity is supplied per-command, so the test does not depend
/// on — or disturb — whatever the developer running it has configured globally.
/// </para>
/// </remarks>
internal sealed class GitWorkspace : IDisposable
{
    public GitWorkspace()
    {
        Root = Path.Combine(Path.GetTempPath(), "forge-evalcli-git", Guid.NewGuid().ToString("N"));

        Directory.CreateDirectory(Root);

        Git("init", "-q", "-b", "main");
        Git("config", "user.email", "harness@example.invalid");
        Git("config", "user.name", "Forge Test Harness");
        Git("config", "commit.gpgsign", "false");
        Git("config", "core.autocrlf", "false");
    }

    /// <summary>Gets the repository root, as created.</summary>
    public string Root { get; }

    /// <summary>Writes a file inside the repository and returns its full path.</summary>
    /// <param name="relativePath">Where to write it, relative to <see cref="Root"/>, with <c>/</c>.</param>
    /// <param name="contents">What to write.</param>
    /// <returns>The full path.</returns>
    public string Write(string relativePath, string contents)
    {
        var full = Path.Combine(Root, relativePath.Replace('/', Path.DirectorySeparatorChar));

        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        File.WriteAllText(full, contents, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));

        return full;
    }

    /// <summary>Stages everything and commits it.</summary>
    /// <param name="message">The commit message.</param>
    public void Commit(string message)
    {
        Git("add", "-A");
        Git("commit", "-q", "-m", message);
    }

    /// <summary>Runs one git command in the repository, failing the test if it does not succeed.</summary>
    /// <param name="arguments">The argument list.</param>
    public void Git(params string[] arguments)
    {
        var startInfo = new ProcessStartInfo("git")
        {
            WorkingDirectory = Root,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        using var process =
            Process.Start(startInfo) ?? throw new InvalidOperationException("git could not be started.");

        var standardError = process.StandardError.ReadToEnd();

        process.WaitForExit();

        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException(
                $"git {string.Join(' ', arguments)} exited {process.ExitCode}: {standardError}"
            );
        }
    }

    public void Dispose()
    {
        try
        {
            // git marks objects read-only, which blocks a plain recursive delete on Windows.
            foreach (var entry in Directory.EnumerateFiles(Root, "*", SearchOption.AllDirectories))
            {
                File.SetAttributes(entry, FileAttributes.Normal);
            }

            Directory.Delete(Root, recursive: true);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // A leftover temp directory is noise, not a test failure.
        }
    }
}
