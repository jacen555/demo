using System.Globalization;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Paths;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Serialization;

namespace Forge.EvalEngine.Baselines;

/// <summary>
/// Resolves a baseline from a committed <see cref="SuiteResult"/> artifact under a confined root.
/// </summary>
/// <remarks>
/// <para>
/// This is the provider for evaluations with nothing to deploy — an in-process or local suite
/// whose baseline is a file in the repository. It yields the same
/// <see cref="SuiteResult"/> a live run would, so one
/// <see cref="Comparison.SuiteComparator"/> serves both.
/// </para>
/// <para>
/// <b>The reference is untrusted input</b> (§V). A reference that reads outside
/// <see cref="RootDirectory"/> is refused on the text alone before the file system is touched;
/// one that does not is then resolved to the location the file system will actually read from —
/// following symbolic links and junctions at every segment — and checked again. That is the same
/// pair of checks, through the same implementation, that <see cref="Loading.SuiteLoader"/>
/// applies to a suite path: a containment rule implemented twice is a containment rule that will
/// eventually disagree with itself.
/// </para>
/// <para>
/// <b>Only a genuinely absent artifact yields null.</b> A reference that names a directory, one
/// whose metadata cannot be inspected, and a file that exists but cannot be read, is too large,
/// is not valid JSON, carries a null where its shape declares one cannot be, or declares a schema
/// version this engine does not understand all throw. Returning null for any of those would tell
/// the caller "there is no baseline", the caller would report "no regression", and the reason
/// would be that nothing was ever compared — a false green produced by an unreadable reference
/// rather than by working software.
/// </para>
/// </remarks>
public sealed class ArtifactBaseline : IBaselineProvider
{
    /// <summary>The largest artifact read without asking — sixteen mebibytes.</summary>
    public const int DefaultMaxBytes = 16 * 1024 * 1024;

    private readonly PathBoundary _root;

    /// <summary>Initializes a new instance confined to <paramref name="rootDirectory"/>.</summary>
    /// <param name="rootDirectory">
    /// The only directory tree baselines may be read from. It is canonicalized on construction.
    /// </param>
    /// <exception cref="ArgumentException"><paramref name="rootDirectory"/> is empty or whitespace.</exception>
    /// <exception cref="ArgumentNullException"><paramref name="rootDirectory"/> is null.</exception>
    /// <exception cref="IOException">
    /// The root contains a cycle of links, or a segment of it could not be inspected.
    /// </exception>
    public ArtifactBaseline(string rootDirectory)
        : this(rootDirectory, DefaultMaxBytes) { }

    /// <summary>Initializes a new instance of the <see cref="ArtifactBaseline"/> class.</summary>
    /// <param name="rootDirectory">
    /// The only directory tree baselines may be read from. It is canonicalized on construction.
    /// </param>
    /// <param name="maxBytes">
    /// The largest artifact that will be read. Checked against the file's length <b>before</b>
    /// anything is allocated, so a reference pointing at something enormous is a stated refusal
    /// rather than an exhausted host — the same shape as
    /// <see cref="Coordination.RunCoordinatorOptions.MaxTotalRuns"/>.
    /// </param>
    /// <exception cref="ArgumentException"><paramref name="rootDirectory"/> is empty or whitespace.</exception>
    /// <exception cref="ArgumentNullException"><paramref name="rootDirectory"/> is null.</exception>
    /// <exception cref="ArgumentOutOfRangeException"><paramref name="maxBytes"/> is less than one.</exception>
    /// <exception cref="IOException">
    /// The root contains a cycle of links, or a segment of it could not be inspected.
    /// </exception>
    public ArtifactBaseline(string rootDirectory, int maxBytes)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(rootDirectory);
        ArgumentOutOfRangeException.ThrowIfLessThan(maxBytes, 1);

        _root = new PathBoundary(rootDirectory);
        MaxBytes = maxBytes;
    }

    /// <summary>Gets the canonical root directory baselines are confined to.</summary>
    public string RootDirectory => _root.Root;

    /// <summary>Gets the largest artifact this provider will read.</summary>
    public int MaxBytes { get; }

    /// <inheritdoc/>
    /// <remarks>
    /// <paramref name="reference"/> is a path relative to <see cref="RootDirectory"/>, or an
    /// absolute path inside it.
    /// </remarks>
    /// <exception cref="ArgumentException">
    /// <paramref name="reference"/> is empty, or resolves outside <see cref="RootDirectory"/>.
    /// </exception>
    /// <exception cref="ArgumentNullException"><paramref name="reference"/> is null.</exception>
    /// <exception cref="InvalidOperationException">The artifact is larger than <see cref="MaxBytes"/>.</exception>
    /// <exception cref="IOException">
    /// The reference names a directory, or the artifact exists but could not be inspected or read.
    /// </exception>
    /// <exception cref="System.Text.Json.JsonException">The artifact is not valid JSON, or not the expected shape.</exception>
    /// <exception cref="MalformedArtifactException">
    /// The artifact carries a null in a position its shape declares as never holding one.
    /// </exception>
    /// <exception cref="SchemaVersionException">
    /// The artifact declares a schema version this engine cannot read, or declares none.
    /// </exception>
    /// <exception cref="OperationCanceledException"><paramref name="cancellationToken"/> was cancelled.</exception>
    public async Task<SuiteResult?> TryGetBaselineAsync(string reference, CancellationToken cancellationToken)
    {
        var resolved = ResolveWithinRoot(reference);

        cancellationToken.ThrowIfCancellationRequested();

        // Asked through File.GetAttributes rather than FileInfo.Exists, which answers "is there
        // a readable file here" and returns false for three different reasons: the artifact is
        // absent, the reference names a directory, or its metadata could not be inspected at
        // all. Only the first of those means "there is no baseline"; collapsing the other two
        // into it has the caller report "no regression" because nothing was ever compared
        // (§IV, §V).
        FileAttributes attributes;

        try
        {
            attributes = File.GetAttributes(resolved);
        }
        catch (Exception exception) when (exception is FileNotFoundException or DirectoryNotFoundException)
        {
            // The one outcome that genuinely means "there is no baseline for that reference".
            return null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            throw new IOException(
                $"Baseline artifact '{reference}' could not be inspected, so whether there is a baseline at that "
                    + "reference is unknown. Unknown is not absent: it is refused rather than reported as no "
                    + "baseline.",
                exception
            );
        }

        if (attributes.HasFlag(FileAttributes.Directory))
        {
            throw new IOException(
                $"Baseline reference '{reference}' names a directory rather than an artifact. A directory is not an "
                    + "absent baseline, and reporting it as one would have the caller conclude there was nothing to "
                    + "compare against."
            );
        }

        var file = new FileInfo(resolved);

        // Budgeted against the file's length before a byte is read, so a reference pointing at
        // something enormous costs a stated refusal rather than the host's memory (§V).
        if (file.Length > MaxBytes)
        {
            throw new InvalidOperationException(
                $"Baseline artifact '{reference}' is {Render(file.Length)} bytes, above the {Render(MaxBytes)}-byte "
                    + "budget this provider was configured with. It is refused before being read rather than "
                    + "allocated first."
            );
        }

        string json;
        try
        {
            json = await File.ReadAllTextAsync(resolved, cancellationToken).ConfigureAwait(false);
        }
        catch (FileNotFoundException)
        {
            return null;
        }
        catch (DirectoryNotFoundException)
        {
            return null;
        }

        // An artifact that exists but cannot be read, is malformed, or declares a shape this
        // engine does not understand is NOT "no baseline". Returning null for any of those would
        // have the caller report "no regression" on the strength of never having compared
        // anything, so each of them throws instead — including the schema check inside
        // DeserializeSuiteResult.
        return CanonicalJson.DeserializeSuiteResult(json);
    }

    /// <summary>
    /// Resolves a reference to a real path inside the root, refusing anything that leaves it.
    /// </summary>
    /// <remarks>
    /// The containment rules themselves belong to <see cref="PathBoundary"/> and are documented
    /// there — the ordering, the boundary applied to each link target while it is still text, and
    /// failing closed on a segment that cannot be inspected. What is left here is the baseline
    /// vocabulary: every way out of the root is the same answer to the caller, so all of them
    /// become one <see cref="ArgumentException"/> naming the reference, carrying no cause because
    /// nothing failed.
    /// </remarks>
    private string ResolveWithinRoot(string reference)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentException.ThrowIfNullOrWhiteSpace(reference);

        try
        {
            return _root.Resolve(reference);
        }
        catch (PathEscapesBoundaryException)
        {
            throw OutsideRoot(reference);
        }
        catch (IOException exception)
        {
            throw new ArgumentException(
                $"Baseline reference '{reference}' could not be resolved safely and was refused.",
                nameof(reference),
                exception
            );
        }
    }

    private static ArgumentException OutsideRoot(string reference) =>
        new($"Baseline reference '{reference}' resolves outside the baseline root and was refused.", nameof(reference));

    private static string Render(long value) => value.ToString(CultureInfo.InvariantCulture);
}
