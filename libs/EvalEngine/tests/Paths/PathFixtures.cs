namespace Forge.EvalEngine.Tests.Paths;

/// <summary>
/// A throwaway directory tree, with the link-making the containment tests need.
/// </summary>
/// <remarks>
/// Deliberately not shared with <c>SuiteLoaderTests</c>'s equivalent. Those tests are the
/// regression record of four review rounds against the loader, and reaching into them to hoist a
/// helper would churn a file this change has no reason to touch. Test scaffolding duplicated is a
/// different risk from a containment rule duplicated — the latter is what this change exists to
/// remove.
/// </remarks>
internal sealed class TempDirectory : IDisposable
{
    public TempDirectory()
    {
        Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), System.IO.Path.GetRandomFileName());
        Directory.CreateDirectory(Path);
    }

    public string Path { get; }

    public string Write(string relativePath, string content)
    {
        var full = System.IO.Path.Combine(Path, relativePath);
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(full)!);
        File.WriteAllText(full, content);

        return full;
    }

    public string CreateDirectory(string relativePath)
    {
        var full = System.IO.Path.Combine(Path, relativePath);
        Directory.CreateDirectory(full);

        return full;
    }

    public void LinkDirectory(string relativePath, string target)
    {
        var full = Prepare(relativePath);

        try
        {
            Directory.CreateSymbolicLink(full, target);
        }
        catch (Exception exception) when (exception is UnauthorizedAccessException or IOException)
        {
            CreateJunction(full, target);
        }
    }

    public void LinkFile(string relativePath, string target) => File.CreateSymbolicLink(Prepare(relativePath), target);

    public void Dispose()
    {
        if (Directory.Exists(Path))
        {
            Directory.Delete(Path, recursive: true);
        }
    }

    private string Prepare(string relativePath)
    {
        var full = System.IO.Path.Combine(Path, relativePath);
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(full)!);

        return full;
    }

    private static void CreateJunction(string link, string target)
    {
        using var process =
            System.Diagnostics.Process.Start(
                new System.Diagnostics.ProcessStartInfo("cmd.exe", ["/c", "mklink", "/J", link, target])
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
}
