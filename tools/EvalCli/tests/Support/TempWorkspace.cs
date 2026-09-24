using System.Diagnostics;

namespace Forge.EvalCli.Tests.Support;

/// <summary>
/// A throwaway directory tree for tests that need real files on disk.
/// </summary>
/// <remarks>
/// Path validation, containment, and the refusal to clobber an existing file are all decisions
/// about the file system, so they are tested against a real one rather than a stubbed abstraction
/// that could agree with the code while the platform disagreed with both.
/// </remarks>
internal sealed class TempWorkspace : IDisposable
{
    public TempWorkspace()
    {
        var identity = Guid.NewGuid().ToString("N");

        Root = Path.Combine(Path.GetTempPath(), "forge-evalcli-tests", identity);
        Outside = Path.Combine(Path.GetTempPath(), "forge-evalcli-tests", identity + "-outside");

        Directory.CreateDirectory(Root);
        Directory.CreateDirectory(Outside);
        Directory.CreateDirectory(Path.Combine(Root, "eval-suites"));
        Directory.CreateDirectory(Path.Combine(Root, "artifacts"));

        SuitePath = WriteFile(Path.Combine("eval-suites", "regression.json"), "{ \"name\": \"regression\" }");
    }

    /// <summary>Gets the canonical root every path in a test resolves inside.</summary>
    public string Root { get; }

    /// <summary>Gets a directory that exists outside <see cref="Root"/>, for containment tests.</summary>
    public string Outside { get; }

    /// <summary>Gets the path of a suite file that exists.</summary>
    public string SuitePath { get; }

    /// <summary>Writes a file inside the workspace and returns its full path.</summary>
    /// <param name="relativePath">Where to write it, relative to <see cref="Root"/>.</param>
    /// <param name="contents">What to write.</param>
    /// <returns>The full path.</returns>
    public string WriteFile(string relativePath, string contents)
    {
        var full = Path.Combine(Root, relativePath);

        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        File.WriteAllText(full, contents);

        return full;
    }

    public void Dispose()
    {
        Delete(Root);
        Delete(Outside);
    }

    /// <summary>Creates a directory link inside the workspace pointing at <paramref name="target"/>.</summary>
    /// <param name="relativePath">Where the link goes, relative to <see cref="Root"/>.</param>
    /// <param name="target">What it points at.</param>
    /// <returns>The full path of the link.</returns>
    /// <remarks>
    /// A symbolic link needs Developer Mode or elevation on Windows; a junction needs neither, so
    /// it is the fallback. Either one is a reparse point, which is the thing under test — and a
    /// junction is the form a developer is most likely to have on a real machine.
    /// </remarks>
    public string CreateDirectoryLink(string relativePath, string target)
    {
        var full = Path.Combine(Root, relativePath);

        Directory.CreateDirectory(Path.GetDirectoryName(full)!);

        try
        {
            Directory.CreateSymbolicLink(full, target);
        }
        catch (Exception exception) when (exception is UnauthorizedAccessException or IOException)
        {
            CreateJunction(full, target);
        }

        return full;
    }

    /// <summary>Creates a file link inside the workspace pointing at <paramref name="target"/>.</summary>
    /// <param name="relativePath">Where the link goes, relative to <see cref="Root"/>.</param>
    /// <param name="target">What it points at.</param>
    /// <returns>The full path of the link.</returns>
    public string CreateFileLink(string relativePath, string target)
    {
        var full = Path.Combine(Root, relativePath);

        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        File.CreateSymbolicLink(full, target);

        return full;
    }

    private static void CreateJunction(string link, string target)
    {
        using var process =
            Process.Start(
                new ProcessStartInfo("cmd.exe", ["/c", "mklink", "/J", link, target])
                {
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                }
            ) ?? throw new InvalidOperationException("could not start cmd.exe to create a junction.");

        process.WaitForExit();

        if (!Directory.Exists(link))
        {
            throw new InvalidOperationException($"could not create a directory link at '{link}'.");
        }
    }

    private static void Delete(string directory)
    {
        try
        {
            Directory.Delete(directory, recursive: true);
        }
        catch (IOException)
        {
            // A leftover temp directory is noise, not a test failure.
        }
        catch (UnauthorizedAccessException)
        {
            // As above.
        }
    }
}
