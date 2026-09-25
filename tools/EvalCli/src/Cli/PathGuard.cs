using System.Globalization;
using Forge.EvalEngine.Paths;

namespace Forge.EvalCli.Cli;

/// <summary>
/// A path, together with where its text came from.
/// </summary>
/// <remarks>
/// <para>
/// <b>Provenance is a property of the value, not of the method holding it.</b> A refusal may echo
/// text the caller typed — that returns their own words, and it is what keeps a mistyped argument
/// diagnosable. It may not echo a path this tool derived and canonicalised, because that names
/// the machine the job runs on and the account it runs as (§V), and it reaches stderr and from
/// there the build log.
/// </para>
/// <para>
/// <b>Carried in the type because the convention did not hold.</b> The rule was first written as
/// "redact everywhere", then as "reserve the raw form for <see cref="PathGuard.ForRoot"/>" — and
/// each time a later call site passed the wrong kind of value and compiled. Naming a method
/// cannot express a fact about a string; a reader has to ask <i>where did this text come from</i>,
/// and now the answer is at the construction site and nowhere else.
/// </para>
/// </remarks>
internal readonly record struct PathValue
{
    private PathValue(string text, bool typedByCaller)
    {
        Text = text;
        TypedByCaller = typedByCaller;
    }

    /// <summary>Gets the path text.</summary>
    internal string Text { get; }

    /// <summary>Gets whether a refusal may repeat this text, netted.</summary>
    internal bool TypedByCaller { get; }

    /// <summary>Text taken straight from a command-line argument.</summary>
    /// <param name="text">The argument's value.</param>
    /// <returns>The value.</returns>
    public static PathValue FromArgument(string text) => new(text, typedByCaller: true);

    /// <summary>A path this tool resolved, canonicalised, or stored — never one a caller typed.</summary>
    /// <param name="text">The derived path.</param>
    /// <returns>The value.</returns>
    /// <remarks>
    /// Used where an already-contained root is re-resolved because the file system may have moved
    /// under the invocation. The check is worth making; repeating its subject is not.
    /// </remarks>
    public static PathValue Derived(string text) => new(text, typedByCaller: false);

    /// <summary>
    /// The containment root, from what the caller gave for it — or from this process when they
    /// gave nothing.
    /// </summary>
    /// <param name="supplied">The value of <c>--root</c>, or null when it was omitted.</param>
    /// <returns>The root, marked with where its text came from.</returns>
    /// <remarks>
    /// <para>
    /// <b>The one place an absent <c>--root</c> becomes a working directory, and therefore the one
    /// place that can honestly mark it derived.</b> The option previously carried a default
    /// factory, so an omitted <c>--root</c> arrived at binding already materialised into
    /// <c>Directory.GetCurrentDirectory()</c> — and at that point nothing downstream could tell it
    /// from a path the caller typed. Every call site was made to declare provenance and the
    /// declaration was simply false.
    /// </para>
    /// <para>
    /// <b>Absence is carried as absence.</b> A type can force the question to be asked; only
    /// keeping the distinction intact until this point can make the answer true.
    /// </para>
    /// </remarks>
    public static PathValue RootFrom(string? supplied) =>
        supplied is null ? Derived(Directory.GetCurrentDirectory()) : FromArgument(supplied);
}

/// <summary>
/// Resolves a path taken from an argument against the one root every path must stay inside, and
/// turns the engine's refusals into this tool's vocabulary.
/// </summary>
/// <remarks>
/// <para>
/// <b>The containment rule is not implemented here.</b> It belongs to
/// <see cref="PathBoundary"/>, which refuses on the text before touching the file system, applies
/// the boundary to every link target while it is still text, and checks the resolved path again.
/// This type previously carried a lexical-only copy of that rule; a containment rule implemented
/// twice is one that will eventually disagree with itself, and the weaker copy is the one that
/// disagrees in the direction of letting a path through.
/// </para>
/// <para>
/// This is an instance rather than a set of static helpers because the boundary owns its root.
/// A helper that takes a root as a parameter invites a caller to pass a different one at each
/// call site, which is the shape that lets <c>--out</c> end up measured against something
/// <c>--suite</c> was not.
/// </para>
/// <para>
/// What is left here is the argument vocabulary — which option a refusal names, what the user
/// should do about it, and the exit code it earns — plus the one rule
/// <see cref="PathBoundary"/> deliberately does not make: a <i>destination</i> reached through a
/// link is refused outright. See <see cref="EnsureNoLinkOnWritePath"/> for why that guard detects
/// links rather than resolving them.
/// </para>
/// </remarks>
internal sealed class PathGuard
{
    private readonly PathBoundary _boundary;

    private PathGuard(PathBoundary boundary) => _boundary = boundary;

    /// <summary>Gets the canonical root every path resolved through this guard stays inside.</summary>
    /// <remarks>
    /// The <i>resolved</i> root, which may differ from the text the caller supplied — a root
    /// reached through a junction reports the directory it leads to. That is the boundary the
    /// file system will enforce, so it is the one to report and the one to compare against.
    /// </remarks>
    public string Root => _boundary.Root;

    /// <summary>Builds a guard confined to the containment root itself.</summary>
    /// <param name="value">The root, and where its text came from.</param>
    /// <param name="optionName">The option this value came from, for the error message.</param>
    /// <returns>The guard.</returns>
    /// <remarks>
    /// <b>Takes a <see cref="PathValue"/> rather than a string so every call site declares
    /// provenance.</b> Two of the four call sites re-resolve a root this tool had already
    /// canonicalised, because the file system may have moved since the arguments were validated —
    /// and a refusal from one of those must not echo its subject. That distinction is about the
    /// value, so it travels with the value.
    /// </remarks>
    /// <exception cref="EvalCliException">The value is blank, malformed, or not an existing directory.</exception>
    public static PathGuard ForRoot(PathValue value, string optionName)
    {
        if (string.IsNullOrWhiteSpace(value.Text))
        {
            throw Blank(optionName);
        }

        PathBoundary boundary;

        try
        {
            boundary = new PathBoundary(value.Text.Trim());
        }
        catch (IOException)
        {
            // The root is resolved through its own links on construction. One that cannot be
            // established is refused rather than assumed, because every later containment
            // judgement is made against it. The cause is not forwarded: it carries the reference
            // it was handed, and this message reaches the build log (§V, ADR 0005).
            throw new EvalCliException(
                ExitCode.UsageError,
                $"{optionName} could not be resolved to a real directory. {Supplied(value)}",
                $"A segment of it could not be inspected, or its links form a cycle. Point {optionName} at a "
                    + "directory that can be read. It is the boundary every other path must stay inside, so it is "
                    + "refused rather than assumed safe."
            );
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException)
        {
            throw Unusable(optionName);
        }

        if (!Directory.Exists(boundary.Root))
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                $"{optionName} is not an existing directory. {Supplied(value)}",
                $"Point {optionName} at a directory that exists. It is the boundary every other path must stay inside."
            );
        }

        return new PathGuard(boundary);
    }

    /// <summary>Resolves an input file that must already exist inside the root.</summary>
    /// <param name="value">The path as supplied, absolute or relative to <see cref="Root"/>.</param>
    /// <param name="optionName">The option this value came from, for the error message.</param>
    /// <returns>The real path the file system would read from.</returns>
    /// <exception cref="EvalCliException">
    /// The value is blank or malformed, resolves outside <see cref="Root"/>, or does not name an
    /// existing file.
    /// </exception>
    public string ResolveExistingFile(string value, string optionName)
    {
        var resolved = Contain(value, optionName);

        if (Directory.Exists(resolved))
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                $"{optionName} names a directory, not a file: {Label(resolved)}",
                $"Point {optionName} at the file itself."
            );
        }

        if (!File.Exists(resolved))
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                $"{optionName} does not name an existing file: {Label(resolved)}",
                $"Check the path. {optionName} is resolved relative to the root, not to the working directory."
            );
        }

        return resolved;
    }

    /// <summary>
    /// Resolves an input directory that must already exist inside the root.
    /// </summary>
    /// <param name="value">The path as supplied, absolute or relative to <see cref="Root"/>.</param>
    /// <param name="optionName">The option this value came from, for the error message.</param>
    /// <returns>The real path the file system would read from.</returns>
    /// <remarks>
    /// The sibling of <see cref="ResolveExistingFile"/>, and it makes the same distinction for the
    /// same reason: a value naming the wrong <i>kind</i> of entry gets its own message, because
    /// "that is a file" and "that is not there" send the caller to two different places. A
    /// directory is only ever enumerated and read through this — nothing is written into one.
    /// </remarks>
    /// <exception cref="EvalCliException">
    /// The value is blank or malformed, resolves outside <see cref="Root"/>, or does not name an
    /// existing directory.
    /// </exception>
    public string ResolveExistingDirectory(string value, string optionName)
    {
        var resolved = Contain(value, optionName);

        if (File.Exists(resolved))
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                $"{optionName} names a file, not a directory: {Label(resolved)}",
                $"Point {optionName} at the directory the files are in."
            );
        }

        if (!Directory.Exists(resolved))
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                $"{optionName} does not name an existing directory: {Label(resolved)}",
                $"Check the path. {optionName} is resolved relative to the root, not to the working directory."
            );
        }

        return resolved;
    }

    /// <summary>
    /// Resolves a destination file, refusing to clobber an existing one unless overwriting was
    /// asked for explicitly.
    /// </summary>
    /// <param name="value">The path as supplied, absolute or relative to <see cref="Root"/>.</param>
    /// <param name="overwriteAllowed">Whether the caller opted in to replacing an existing file.</param>
    /// <param name="optionName">The option this value came from, for the error message.</param>
    /// <param name="overwriteOptionName">The opt-in flag to name in the refusal message.</param>
    /// <returns>The path the artifact would be written to.</returns>
    /// <remarks>
    /// <b>This is the safe default.</b> Replacing a file a developer already has is the one
    /// irreversible thing this argument can cause, so it is refused unless
    /// <paramref name="overwriteAllowed"/> says otherwise — checked before anything is opened, so
    /// a refusal costs the caller nothing and leaves the existing file exactly as it was.
    /// </remarks>
    /// <exception cref="EvalCliException">
    /// The value is blank or malformed, resolves outside <see cref="Root"/>, is reached through a
    /// link, names a directory, has no existing parent directory, or already exists without
    /// <paramref name="overwriteAllowed"/>.
    /// </exception>
    public string ResolveOutputFile(string value, bool overwriteAllowed, string optionName, string overwriteOptionName)
    {
        var resolved = VerifyWritePath(value, optionName);

        if (Directory.Exists(resolved))
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                $"{optionName} names an existing directory, not a file: {Label(resolved)}",
                $"Give {optionName} a file name inside that directory."
            );
        }

        var parent = Path.GetDirectoryName(resolved);

        if (string.IsNullOrEmpty(parent) || !Directory.Exists(parent))
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                $"{optionName} points into a directory that does not exist: {Label(parent)}",
                "Create the directory first, or choose a path inside one that already exists."
            );
        }

        if (File.Exists(resolved) && !overwriteAllowed)
        {
            throw new EvalCliException(
                ExitCode.UsageError,
                $"{optionName} already exists and would be replaced: {Label(resolved)}",
                $"Nothing was written. Choose another path, or pass {overwriteOptionName} to replace it deliberately."
            );
        }

        return resolved;
    }

    /// <summary>
    /// Asserts that a write path is inside the root and is reached through no link.
    /// </summary>
    /// <param name="value">The path as supplied, absolute or relative to <see cref="Root"/>.</param>
    /// <param name="optionName">The option this value came from, for the error message.</param>
    /// <returns>The real path the file system would write to.</returns>
    /// <remarks>
    /// <para>
    /// <b>Separated from <see cref="ResolveOutputFile"/> so that it can be asked twice</b>: once
    /// while the arguments are being validated, and again at the moment of the write. Those are
    /// minutes apart — a run takes as long as the system under test does — and the answer is a
    /// property of the file system, not of the argument, so the first answer is evidence about a
    /// directory tree that has since had time to change. A directory swapped for a link in
    /// between redirects a write that was authorized against somewhere else entirely, and no file
    /// mode defends against that: the mode governs the leaf, while what moved was the path to it.
    /// </para>
    /// <para>
    /// Asking twice narrows that window; it does not close it. Closing it needs a handle the
    /// platform will not open through a link, which .NET does not portably expose. What closes it
    /// here instead is that the write is <i>never</i> a truncating one — see
    /// <c>RunCommand.WriteArtifactAsync</c>, where the artifact is staged under a fresh name and
    /// renamed into place.
    /// </para>
    /// </remarks>
    /// <exception cref="EvalCliException">
    /// The value is blank or malformed, resolves outside <see cref="Root"/>, or is reached
    /// through a link.
    /// </exception>
    public string VerifyWritePath(string value, string optionName)
    {
        // Containment first, and with no I/O on a path that is already out of the root as text.
        // A destination that escapes is refused here, including one that escapes only through a
        // link, because the boundary resolves every reparse point before it answers.
        var resolved = Contain(value, optionName);

        // The boundary's answer is "where this leads, and it leads inside the root". For a
        // destination that is not enough: the guard below refuses a link that stays inside the
        // root as well, so it is asked about the path as supplied rather than the one links led
        // to. Combining against the root is normalization, not a containment verdict — the
        // verdict was made above.
        var asSupplied = Path.TrimEndingDirectorySeparator(Path.GetFullPath(value.Trim(), Root));

        EnsureNoLinkOnWritePath(asSupplied, optionName);

        return resolved;
    }

    /// <summary>Puts one supplied path through the boundary and translates its refusals.</summary>
    /// <remarks>
    /// Every way out of the root is the same answer to a caller, so all of them become one usage
    /// error naming the option. A path whose containment could not be <i>established</i> is the
    /// different answer, and says so: it was refused rather than assumed safe.
    /// </remarks>
    private string Contain(string value, string optionName)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw Blank(optionName);
        }

        try
        {
            return _boundary.Resolve(value.Trim());
        }
        catch (PathEscapesBoundaryException)
        {
            // Nothing failed and nothing was read — the boundary declined to look — so this
            // carries no cause.
            throw new EvalCliException(
                ExitCode.UsageError,
                $"{optionName} resolves outside the root: {Label(value)}",
                "Every path must stay inside the --root directory. Staying inside it as text is not enough: a link "
                    + "inside the root can point anywhere on the machine. Move the file inside it, or widen the "
                    + "root with --root."
            );
        }
        catch (IOException)
        {
            // Not forwarded. The engine's message carries the reference it was handed, and this
            // one reaches the build log (§V, ADR 0005). The category is what a caller acts on.
            throw new EvalCliException(
                ExitCode.UsageError,
                $"{optionName} could not be resolved safely and was refused: {Label(value)}",
                "A segment of it could not be inspected, or its links form a cycle. It was refused rather than "
                    + "assumed to stay inside the root. Check the permissions along that path, or choose another."
            );
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException)
        {
            throw Unusable(optionName);
        }
    }

    private static EvalCliException Blank(string optionName) =>
        new(
            ExitCode.UsageError,
            $"{optionName} was given a blank path.",
            $"Supply a path, or omit {optionName} entirely."
        );

    /// <summary>
    /// States a path the way a refusal may carry it: relative to the root, and redacted.
    /// </summary>
    /// <param name="path">The resolved, canonical path.</param>
    /// <returns>The label.</returns>
    /// <remarks>
    /// <para>
    /// <b>Every message this type produces goes to stderr and from there to the build log</b>,
    /// which is read by anyone who can read the repository. A checkout directory names the
    /// account the job runs as and the layout of the machine it runs on, and none of that is
    /// evidence about the invocation that was refused (§V). These previously printed the
    /// resolved, canonical, absolute path.
    /// </para>
    /// <para>
    /// <b>Fixed as a group rather than one message at a time.</b> ADR 0005's finding is that a
    /// rule corrected only where it was caught stays correct about one case and silent about the
    /// next; five rounds of that produced a net that leaked and mangled at the same time. A new
    /// command reaching an old message is the same shape, so the whole type goes through one
    /// rule.
    /// </para>
    /// </remarks>
    private string Label(string? path) => MarkdownReport.Display(Root, path ?? string.Empty);

    /// <summary>
    /// States a root when — and only when — there is no boundary to state it relative to.
    /// </summary>
    /// <param name="value">The root, and where its text came from.</param>
    /// <returns>The sentence naming it, or the one declining to.</returns>
    /// <remarks>
    /// <para>
    /// <b>Reached only from <see cref="ForRoot"/>, and it branches on the value rather than on
    /// that fact.</b> <see cref="ForRoot"/> refuses before a boundary exists, so there is nothing
    /// to relativise against and the published net is all that is left — but "this is
    /// <c>ForRoot</c>" is not the same claim as "this text is the caller's". Two of the four call
    /// sites re-resolve a root this tool canonicalised, and for those the net's published holes
    /// are the only thing between a machine path and the build log: an absolute path under an
    /// unlisted root such as <c>/data/ci-user/runs</c> passes straight through it.
    /// </para>
    /// <para>
    /// <b>That is the third depth at which this rule needed stating.</b> First it was applied
    /// everywhere and mangled identifiers; then it was scoped to this method and a caller handed
    /// this method a derived value; now it is a property of the value and the compiler asks every
    /// call site which kind it has. ADR 0005's amendment records the general form — a documented
    /// trade-off is scoped to the surfaces that existed when it was made — and a convention is
    /// not a surface, it is a hope about one.
    /// </para>
    /// <para>
    /// For caller text the net's holes still apply and are published on
    /// <c>MarkdownReport.MachinePath</c>: an unlisted root, a tilde or relative path,
    /// forward-slash UNC, and a drive letter with no separator all pass through. This is a net,
    /// not a control; the control is the author not putting a machine path in a committed file.
    /// </para>
    /// </remarks>
    private static string Supplied(PathValue value) =>
        value.TypedByCaller
            ? $"It was given: {MarkdownReport.Sanitize(value.Text.Trim(), MarkdownReport.MaxPathCharacters)}"
            : "The value is not repeated here: this check re-resolved a path this tool had already canonicalised, "
                + "which names the machine rather than anything you typed.";

    /// <summary>
    /// Refuses a value that is not a usable path, without repeating it.
    /// </summary>
    /// <param name="optionName">The option this value came from.</param>
    /// <returns>The refusal.</returns>
    /// <remarks>
    /// <b>The value is omitted rather than labelled.</b> It failed to parse as a path at all, so
    /// neither <see cref="Label"/> nor <see cref="Supplied"/> can be trusted to render it — both
    /// hand it back to <c>Path</c>, which is what just refused it. The option name and the
    /// categories to check are what a caller acts on.
    /// </remarks>
    private static EvalCliException Unusable(string optionName) =>
        new(
            ExitCode.UsageError,
            $"{optionName} is not a usable path, so it was refused before anything was read. The value is not "
                + "repeated here, because this message is written to the build log.",
            "Check for invalid characters, a reserved device name, or a path that is too long."
        );

    /// <summary>Refuses a destination that is reached through a reparse point.</summary>
    /// <param name="asSupplied">The normalized destination, before links were followed.</param>
    /// <param name="optionName">The option this value came from, for the error message.</param>
    /// <remarks>
    /// <para>
    /// <see cref="PathBoundary"/> answers where a path leads and whether that is inside the root.
    /// For a destination this asks the smaller, stricter question instead: is any segment below
    /// the root a link <i>at all</i>? It refuses a link that leaves the root and one that stays
    /// inside it, on the grounds that an artifact destination has no reason to be reached through
    /// either — and it is asked now, while the answer still costs nothing, rather than when there
    /// is a stream open on the wrong file. Nothing downstream re-checks a destination.
    /// </para>
    /// <para>
    /// This is not a second containment rule. It never asks where a link leads, so it cannot
    /// disagree with the boundary about that; it only observes that one is present.
    /// </para>
    /// </remarks>
    /// <exception cref="EvalCliException">
    /// A segment is a link, or exists but could not be inspected.
    /// </exception>
    private void EnsureNoLinkOnWritePath(string asSupplied, string optionName)
    {
        foreach (var segment in SegmentsBelowRoot(asSupplied))
        {
            if (LinkTargetOf(segment, optionName) is null)
            {
                continue;
            }

            throw new EvalCliException(
                ExitCode.UsageError,
                $"{optionName} is reached through a link, so where it would be written cannot be established from "
                    + $"the path: {Label(segment)}",
                "Nothing was written. A link inside the --root directory can point anywhere on the machine, so "
                    + $"staying inside the root as text is not the same as staying inside it on disk. Give "
                    + $"{optionName} a path with no link along it, or point --root at the directory the link leads "
                    + "to."
            );
        }
    }

    /// <summary>Lists each path from just below the root down to the destination, outermost first.</summary>
    /// <param name="asSupplied">The normalized destination, already known to be inside the root.</param>
    /// <returns>The segments to inspect, in the order the file system would traverse them.</returns>
    /// <remarks>
    /// <para>
    /// Built forwards from the root by walking the relative path, rather than backwards by
    /// comparing each parent against the root. There is no path equality test here at all, which
    /// is deliberate: comparing two paths for "is this the root yet" is the first half of a
    /// containment rule, and that rule lives in <see cref="PathBoundary"/>.
    /// </para>
    /// <para>
    /// The root itself is excluded. It is the boundary the caller declared, so whether they
    /// reached it through a link is their decision to have made, not this guard's to overturn.
    /// </para>
    /// </remarks>
    private IEnumerable<string> SegmentsBelowRoot(string asSupplied)
    {
        var relative = Path.GetRelativePath(Root, asSupplied);
        var current = Root;

        foreach (
            var segment in relative.Split(
                [Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar],
                StringSplitOptions.RemoveEmptyEntries
            )
        )
        {
            if (segment is "." or "..")
            {
                // Unreachable for a path the boundary has already contained, and never a segment
                // worth inspecting. Skipped rather than asserted against: containment is settled.
                continue;
            }

            current = Path.Combine(current, segment);

            yield return current;
        }
    }

    /// <summary>The link target of one segment, or <see langword="null"/> when it is confirmed not to be a link.</summary>
    /// <param name="segment">The path to inspect.</param>
    /// <param name="optionName">The option this value came from, for the error message.</param>
    /// <returns>The target, or <see langword="null"/> for a segment that is absent or is a plain entry.</returns>
    /// <remarks>
    /// The two negative answers here are not the same answer. "This segment does not exist" proves
    /// it is not a link — and a destination that does not exist yet is the ordinary case, not a
    /// fault. "This segment could not be inspected" proves nothing, and treating it as the former
    /// is exactly what lets an unverified segment through.
    /// <see cref="FileSystemInfo.LinkTarget"/> cannot express the difference; on Windows it answers
    /// null for an unreadable entry just as it does for a plain file.
    /// <see cref="FileSystemInfo.ResolveLinkTarget(bool)"/> throws instead, which is the
    /// distinction this is built on.
    /// </remarks>
    /// <exception cref="EvalCliException">The segment exists but could not be inspected.</exception>
    private string? LinkTargetOf(string segment, string optionName)
    {
        try
        {
            FileSystemInfo entry = Directory.Exists(segment) ? new DirectoryInfo(segment) : new FileInfo(segment);

            return entry.ResolveLinkTarget(returnFinalTarget: false)?.FullName;
        }
        catch (Exception exception) when (exception is FileNotFoundException or DirectoryNotFoundException)
        {
            // Confirmed absent, so confirmed not a link.
            return null;
        }
        catch (Exception exception)
            when (exception is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            // The cause is not forwarded: it carries the absolute path it was handed, and this
            // message reaches the build log (§V, ADR 0005). The segment is named relatively.
            throw new EvalCliException(
                ExitCode.UsageError,
                $"{optionName} passes through '{Label(segment)}', which exists but could not be inspected, so "
                    + "whether it is a link out of the root could not be established.",
                "Nothing was written. It was refused rather than assumed safe. Check the permissions on that "
                    + $"directory, or give {optionName} a destination elsewhere."
            );
        }
    }
}
