using Forge.EvalEngine.Results;

namespace Forge.EvalEngine.Abstractions;

/// <summary>
/// Retrieves a previously recorded suite artifact to compare against.
/// </summary>
/// <remarks>
/// This is what makes before/after comparison possible without the harness knowing where
/// baselines live — a committed file, a build artifact, or a git reference are all just
/// implementations of this seam.
/// </remarks>
public interface IBaselineProvider
{
    /// <summary>Attempts to retrieve a baseline artifact.</summary>
    /// <param name="reference">
    /// The caller-supplied reference to resolve. It is untrusted input: an implementation that
    /// resolves it against the file system must confine it to an expected root.
    /// </param>
    /// <param name="cancellationToken">Cancels the retrieval.</param>
    /// <returns>The baseline, or null when there is none for that reference.</returns>
    Task<SuiteResult?> TryGetBaselineAsync(string reference, CancellationToken cancellationToken);
}
