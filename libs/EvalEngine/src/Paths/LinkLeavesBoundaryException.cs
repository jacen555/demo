namespace Forge.EvalEngine.Paths;

/// <summary>
/// Signals that resolution stopped at a link pointing outside the boundary it was confined to.
/// </summary>
/// <remarks>
/// <para>
/// It is raised <i>before</i> the target is inspected, so nothing has been read on the link's
/// say-so. That is the whole point of the type: the refusal must not cost the read it refuses.
/// </para>
/// <para>
/// It stays internal and derives from <see cref="PathEscapesBoundaryException"/> because no
/// consumer has needed to tell a link escape apart from a textual one — both are the same verdict
/// — while the distinction is worth keeping inside the assembly. A test that asserts a refusal was
/// reached from a link's own metadata, rather than from walking its target, is asserting the
/// measured difference between the two: inspecting an in-root link to a UNC path costs
/// milliseconds and touches nothing, whereas walking that target costs hundreds of milliseconds to
/// seconds and issues a request to a host the link's author named. Collapsing the two types would
/// leave that invariant with nothing but a comment to defend it.
/// </para>
/// </remarks>
internal sealed class LinkLeavesBoundaryException : PathEscapesBoundaryException
{
    /// <summary>Initializes a new instance naming the link and the target it was refused for.</summary>
    /// <param name="linkPath">The link that was not followed.</param>
    /// <param name="target">The path it points at.</param>
    public LinkLeavesBoundaryException(string linkPath, string target)
        : base(
            $"Link '{linkPath}' points to '{target}', which is outside the boundary resolution was confined to. "
                + "It was refused without being read."
        ) { }
}
