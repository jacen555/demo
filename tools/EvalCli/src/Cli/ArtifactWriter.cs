using System.Security.Cryptography;
using System.Text;

namespace Forge.EvalCli.Cli;

/// <summary>How a staged file is allowed to become the destination.</summary>
/// <remarks>
/// Three states rather than a flag, because "replace whatever is there" and "replace the file I
/// read and vouched for" are different guarantees and a boolean cannot hold both. A flag that
/// meant one of them at one call site and the other at the next is how
/// <c>baseline update --apply</c> came to be able to create a baseline it documents itself as
/// never creating.
/// </remarks>
internal enum ArtifactPublication
{
    /// <summary>Create the destination. An occupied one is refused atomically by the rename.</summary>
    CreateOnly,

    /// <summary>Create the destination, or replace whatever is there. The <c>--overwrite</c> opt-in.</summary>
    CreateOrReplace,

    /// <summary>
    /// Replace a destination that is still, byte for byte, the one the caller read. Never creates.
    /// </summary>
    ReplaceVerified,
}

/// <summary>
/// The destination a replacement is conditioned on still being.
/// </summary>
/// <remarks>
/// <para>
/// <b>A path is not an identity.</b> Every refusal a command makes about a destination — this is
/// another suite's baseline, this one carries an errored run — is made against the bytes it read
/// before the suite was conducted. A run takes as long as the system under test does, and a
/// publication conditioned only on the path replaces whatever occupies it at the end, which is
/// not necessarily the file any of those refusals examined.
/// </para>
/// <para>
/// Carried as a hash rather than the text: the comparison is equality, the bytes are already
/// held once by the caller for other reasons, and a second copy of a file in memory to prove it
/// has not changed is the wrong trade.
/// </para>
/// </remarks>
internal sealed record ArtifactTarget
{
    /// <summary>Gets the SHA-256, lower-case hex, of the bytes the caller read and vouched for.</summary>
    public required string ContentHash { get; init; }

    /// <summary>Gets what the caller established about those bytes, for the refusal message.</summary>
    public required string Vouched { get; init; }

    /// <summary>Gets the code a destination that is no longer there earns.</summary>
    public required ExitCode AbsentExitCode { get; init; }

    /// <summary>The SHA-256 of some text, in the form this record carries.</summary>
    /// <param name="contents">The text to fingerprint.</param>
    /// <returns>The hash, lower-case hex.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="contents"/> is null.</exception>
    public static string Fingerprint(string contents)
    {
        ArgumentNullException.ThrowIfNull(contents);

        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(contents)));
    }

    /// <summary>The SHA-256 of a file, without holding it in memory.</summary>
    /// <param name="path">The file to fingerprint.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The hash, lower-case hex.</returns>
    /// <remarks>
    /// Streamed rather than read whole, because the thing being fingerprinted is a path taken
    /// from an argument and nothing here has established how large it is. Reading it to compare
    /// it would let a mistyped path exhaust the host on the way to a refusal.
    /// </remarks>
    /// <exception cref="ArgumentNullException"><paramref name="path"/> is null.</exception>
    /// <exception cref="IOException">The file could not be read.</exception>
    /// <exception cref="UnauthorizedAccessException">The file could not be opened.</exception>
    /// <exception cref="OperationCanceledException"><paramref name="cancellationToken"/> was cancelled.</exception>
    public static async Task<string> FingerprintAsync(string path, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(path);

        var file = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            bufferSize: 4096,
            useAsync: true
        );

        await using (file.ConfigureAwait(false))
        {
            return Convert.ToHexStringLower(await SHA256.HashDataAsync(file, cancellationToken).ConfigureAwait(false));
        }
    }
}

/// <summary>
/// One write, described in the caller's vocabulary.
/// </summary>
/// <remarks>
/// The vocabulary is carried rather than branched on, so <see cref="ArtifactWriter"/> contains no
/// knowledge of which command asked it to write. A writer that knew would grow a second policy
/// per caller, and the whole reason this type exists is that there is exactly one.
/// </remarks>
internal sealed record ArtifactWrite
{
    /// <summary>Gets the canonical destination the bytes are to land on.</summary>
    public required string Destination { get; init; }

    /// <summary>Gets the canonical root the destination must stay inside.</summary>
    public required string RootDirectory { get; init; }

    /// <summary>Gets the option that named the destination, for the refusal message.</summary>
    public required string OptionName { get; init; }

    /// <summary>Gets the opt-in flag to name when an occupied destination is refused.</summary>
    public required string ReplaceOptionName { get; init; }

    /// <summary>
    /// Gets how the staged file is allowed to become the destination.
    /// </summary>
    /// <remarks>
    /// <b>This is the opt-in, and it is decided before any work starts.</b> It is handed to the
    /// publication rather than checked beforehand, because a check followed by a rename is a race
    /// and the rename itself already refuses an occupied destination atomically under
    /// <see cref="ArtifactPublication.CreateOnly"/>.
    /// </remarks>
    public required ArtifactPublication Publication { get; init; }

    /// <summary>
    /// Gets the destination the caller read and vouched for, under
    /// <see cref="ArtifactPublication.ReplaceVerified"/>. Null under the other two.
    /// </summary>
    public ArtifactTarget? RequiredTarget { get; init; }

    /// <summary>Gets the bytes to write.</summary>
    public required string Contents { get; init; }

    /// <summary>Gets the clause naming what could not be written, for the message.</summary>
    public required string FailureContext { get; init; }

    /// <summary>Gets the clause naming what was consequently lost, for the remedy.</summary>
    public required string LossNote { get; init; }
}

/// <summary>
/// The only place this tool puts bytes on disk.
/// </summary>
/// <remarks>
/// <para>
/// <b>One implementation, deliberately.</b> Two writers would be two readings of the same
/// containment and no-clobber rules, and the weaker of the two is always the one that eventually
/// disagrees in the direction of writing somewhere it should not have. Both the run artifact
/// (<c>--out</c>) and the committed baseline (<c>baseline update --apply</c>) come through here.
/// </para>
/// <para>
/// <b>The destination was validated earlier, and that evidence has expired.</b> A run takes as
/// long as the system under test does, and containment is a property of the file system rather
/// than of the argument — so a directory along the way that has since been swapped for a link
/// would redirect this write to somewhere the caller never authorized. The path is therefore
/// re-asserted here, immediately before anything is opened, rather than trusted from minutes ago.
/// </para>
/// <para>
/// <b>Re-checking narrows that window; staging closes what is left of it.</b> The bytes go to a
/// fresh name that <see cref="FileMode.CreateNew"/> creates or refuses — never a mode that
/// truncates, so no file that already exists anywhere can lose its contents to this — and the
/// path it actually landed on is verified again, with the file in hand, before a byte is written.
/// Then it is renamed into place. A rename replaces the destination entry itself rather than
/// following a link through it, and under <see cref="ArtifactPublication.CreateOnly"/> it
/// refuses an occupied destination atomically, which is the same no-clobber guarantee
/// <see cref="FileMode.CreateNew"/> gave before and for the same reason: a second
/// <c>File.Exists</c> would have the same race, just a narrower one.
/// </para>
/// <para>
/// <b>Publication is conditioned on what the two files <i>are</i>, not only on where they sit.</b>
/// Both names are read again immediately before the rename: the staged file must still hash to the
/// bytes this invocation wrote, and under <see cref="ArtifactPublication.ReplaceVerified"/> the
/// destination must still hash to the bytes the caller read and made its refusals against. A path
/// held constant while its contents were exchanged is exactly how a check made before a run stops
/// describing the file replaced after one — and it is why <c>baseline update</c>'s foreign-suite
/// refusal is not, on its own, enough to keep another suite's evidence safe.
/// </para>
/// <para>
/// <b><see cref="ArtifactPublication.ReplaceVerified"/> never creates.</b> It publishes through
/// <see cref="File.Replace(string, string, string?)"/>, which requires the destination to exist
/// and fails rather than creating one — so a baseline that went away mid-run cannot be
/// reconstituted somewhere nobody is reading.
/// </para>
/// <para>
/// What remains is the interval between the last verification and the rename, which cannot be
/// closed without a handle the platform will not open through a link — .NET exposes no portable
/// equivalent. It is microseconds rather than the length of a run; the identity checks above mean
/// a file substituted inside it must carry byte-identical contents to be published, and the worst
/// the window can still do is put a new file somewhere unintended, never destroy one that was
/// there.
/// </para>
/// </remarks>
internal static class ArtifactWriter
{
    /// <summary>What a not-yet-published file is called while it is being written.</summary>
    /// <remarks>
    /// Derived from the destination rather than randomized, so it is deterministic, it lands in
    /// the directory that was just verified, and two invocations racing for one destination
    /// collide on it and are refused instead of interleaving. A file left under this name is a
    /// write that was killed midway: the destination was never touched, and the next attempt says
    /// so rather than staging over it.
    /// </remarks>
    internal const string StagedSuffix = ".partial";

    /// <summary>Writes one file through the staged, re-verified, renamed path.</summary>
    /// <param name="write">What to write, where, and in whose words to refuse.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>The destination the bytes landed on.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="write"/> is null.</exception>
    /// <exception cref="ArgumentException">
    /// <paramref name="write"/> pairs <see cref="ArtifactPublication.ReplaceVerified"/> with no
    /// target, or names a target under a publication that does not verify one.
    /// </exception>
    /// <exception cref="EvalCliException">
    /// The destination stopped being one this tool can vouch for, or the write failed.
    /// </exception>
    /// <exception cref="OperationCanceledException"><paramref name="cancellationToken"/> was cancelled.</exception>
    public static async Task<string> WriteAsync(ArtifactWrite write, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(write);
        RequireCoherentPublication(write);

        var destination = write.Destination;
        var staged = destination + StagedSuffix;
        var stagedIsOurs = false;

        try
        {
            var guard = PathGuard.ForRoot(write.RootDirectory, "--root");

            guard.VerifyWritePath(destination, write.OptionName);

            var file = new FileStream(staged, FileMode.CreateNew, FileAccess.Write, FileShare.None);

            stagedIsOurs = true;

            await using (file.ConfigureAwait(false))
            await using (var writer = new StreamWriter(file, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false)))
            {
                // Asked of the staged file now that it exists: this is what proves the directory
                // the bytes are going into is the verified one, rather than one the path merely
                // pointed at a moment ago.
                guard.VerifyWritePath(staged, write.OptionName);

                await writer.WriteAsync(write.Contents.AsMemory(), cancellationToken).ConfigureAwait(false);
            }

            // Both identities, as late as they can be asked. The staged name was last vouched for
            // through a handle that has now closed, and the destination was last vouched for by
            // the caller before the suite was conducted.
            await RequireStagedFileIsOursAsync(staged, write, cancellationToken).ConfigureAwait(false);
            await RequireTargetIsUnchangedAsync(destination, write, cancellationToken).ConfigureAwait(false);

            Publish(staged, destination, write.Publication);

            stagedIsOurs = false;
        }
        catch (EvalCliException refusal) when (refusal.ExitCode == ExitCode.UsageError)
        {
            // A containment refusal from PathGuard, which speaks in argument-time vocabulary and
            // always earns a usage code. The destination stopped being one this tool can vouch for
            // while the work was in flight. Reported at the write stage rather than as a usage
            // error, because the invocation was well formed: what changed was the file system
            // underneath it. Refusals raised below carry their own words and codes, and pass
            // through untouched.
            throw new EvalCliException(
                ExitCode.RunFailed,
                $"{write.FailureContext} to {destination}: {refusal.Message}",
                $"{write.LossNote}, and nothing outside the root was written or replaced. The destination was "
                    + "checked again at the moment of the write and no longer passed, so it was refused rather "
                    + "than followed. Re-run once that path is stable."
            );
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // The work happened; only the record of it did not. Reported as a failure rather than
            // swallowed, because a caller who asked for a file and got a zero exit would
            // reasonably believe one is there.
            throw new EvalCliException(
                ExitCode.RunFailed,
                $"{write.FailureContext} to {destination}: {exception.Message}",
                write.Publication is ArtifactPublication.CreateOnly
                    ? $"{write.LossNote}, and nothing that was already there was replaced. If a file appeared at "
                        + $"that path while the work was in flight, pass {write.ReplaceOptionName} to replace it "
                        + "deliberately, or choose another destination."
                    : $"{write.LossNote}, so this is reported as a failure rather than as a success with nothing "
                        + "to show for it. Check the permissions on that path and re-run."
            );
        }
        finally
        {
            if (stagedIsOurs)
            {
                Discard(staged);
            }
        }

        return destination;
    }

    /// <summary>Refuses a write whose publication and target contradict each other.</summary>
    /// <remarks>
    /// Two fields that must agree and are never checked against each other is how a guarantee
    /// becomes a comment. Checked here rather than trusted, so a caller that asks for a verified
    /// replacement and supplies nothing to verify against is a defect that surfaces immediately
    /// instead of one that silently degrades to replacing whatever is there.
    /// </remarks>
    private static void RequireCoherentPublication(ArtifactWrite write)
    {
        var verifies = write.Publication is ArtifactPublication.ReplaceVerified;

        if (verifies == (write.RequiredTarget is not null))
        {
            return;
        }

        throw new ArgumentException(
            verifies
                ? $"{nameof(ArtifactPublication)}.{nameof(ArtifactPublication.ReplaceVerified)} requires the "
                    + $"{nameof(ArtifactWrite.RequiredTarget)} it is meant to verify the destination against."
                : $"{nameof(ArtifactWrite.RequiredTarget)} was supplied under "
                    + $"{nameof(ArtifactPublication)}.{write.Publication}, which does not verify one — so it would "
                    + "read as a guarantee nothing makes.",
            nameof(write)
        );
    }

    /// <summary>Refuses to publish a staged file that is no longer the one this invocation wrote.</summary>
    /// <remarks>
    /// The staged name is written through a handle and then published by name, and the handle
    /// closes in between. The window is small, and what it would publish is somebody else's bytes
    /// under this tool's authority — so the file is read back and matched against what was written
    /// rather than assumed to be it.
    /// </remarks>
    private static async Task RequireStagedFileIsOursAsync(
        string staged,
        ArtifactWrite write,
        CancellationToken cancellationToken
    )
    {
        var written = await ArtifactTarget.FingerprintAsync(staged, cancellationToken).ConfigureAwait(false);

        if (string.Equals(written, ArtifactTarget.Fingerprint(write.Contents), StringComparison.Ordinal))
        {
            return;
        }

        throw new EvalCliException(
            ExitCode.RunFailed,
            $"{write.FailureContext} to {write.Destination}: the staged file at {staged} is not the one this run "
                + "wrote, so it was not published",
            $"{write.LossNote}, and nothing that was already at the destination was replaced. The bytes are staged "
                + "under a name derived from the destination and published from it; something exchanged that file "
                + "between the two. Re-run."
        );
    }

    /// <summary>Refuses to replace a destination that is no longer the one the caller vouched for.</summary>
    /// <remarks>
    /// This is where a refusal made before the run reaches the file the run actually replaces. The
    /// caller read the destination, judged it — the right suite, no errored runs — and that
    /// judgement is about those bytes and no others.
    /// </remarks>
    private static async Task RequireTargetIsUnchangedAsync(
        string destination,
        ArtifactWrite write,
        CancellationToken cancellationToken
    )
    {
        if (write.RequiredTarget is not { } target)
        {
            return;
        }

        string occupant;

        try
        {
            occupant = await ArtifactTarget.FingerprintAsync(destination, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is FileNotFoundException or DirectoryNotFoundException)
        {
            throw new EvalCliException(
                target.AbsentExitCode,
                $"{write.FailureContext} to {destination}: it is no longer there, and this replaces a file rather "
                    + "than creating one",
                $"{write.LossNote} and nothing was created. A destination that went away between being read and "
                    + "being replaced is not one this can vouch for — recreating it would leave a plausible file "
                    + "somewhere nobody is reading while the real one stayed missing. Re-run once the path is "
                    + "stable."
            );
        }

        if (string.Equals(occupant, target.ContentHash, StringComparison.Ordinal))
        {
            return;
        }

        throw new EvalCliException(
            ExitCode.RunFailed,
            $"{write.FailureContext} to {destination}: it is not the file this run read and checked "
                + $"({target.Vouched}), so it was not replaced",
            $"{write.LossNote}. Every check made about that destination was made against the bytes read before the "
                + "suite was conducted; what is at that path now is a different file, and replacing it would "
                + "destroy something nothing examined. Re-run."
        );
    }

    /// <summary>Moves the staged file into place under the publication the caller asked for.</summary>
    /// <remarks>
    /// <see cref="File.Replace(string, string, string?)"/> is used for a verified replacement
    /// rather than a move that overwrites, because it requires the destination to exist and says
    /// so atomically. The distinction is the whole of <c>baseline update</c>'s first guard: a
    /// move that overwrites is equally happy to create.
    /// </remarks>
    private static void Publish(string staged, string destination, ArtifactPublication publication)
    {
        if (publication is ArtifactPublication.ReplaceVerified)
        {
            File.Replace(staged, destination, destinationBackupFileName: null);

            return;
        }

        File.Move(staged, destination, publication is ArtifactPublication.CreateOrReplace);
    }

    /// <summary>Removes a staged file that never made it into place.</summary>
    /// <remarks>
    /// Only ever called for a file this invocation created with <see cref="FileMode.CreateNew"/>,
    /// which is what makes deleting it safe to do without asking: if anything had been there,
    /// that mode would have refused and there would be nothing here to remove. A failure to
    /// remove it is not worth failing over — the write it belonged to has already reported its
    /// own outcome, and this would be a second signal for one cause (§IV).
    /// </remarks>
    private static void Discard(string staged)
    {
        try
        {
            File.Delete(staged);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // Left behind rather than retried. The name is derived from the destination, so the
            // next attempt refuses to stage over it and says so.
        }
    }
}
