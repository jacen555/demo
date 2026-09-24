namespace Forge.EvalCli.Cli;

/// <summary>
/// A refusal this tool is reporting deliberately, carrying the exit code the caller should see
/// and — where there is one — what the user should do about it.
/// </summary>
/// <remarks>
/// <para>
/// The engine throws rather than fabricating a result when its input is malformed or
/// untrustworthy. This tool's job is to turn those refusals into a clear message and the correct
/// exit code, never to catch and continue: a refusal that is swallowed and reported as a pass is
/// the exact failure the exit-code contract exists to prevent.
/// </para>
/// <para>
/// <see cref="Remedy"/> exists because an error message that only says what failed leaves the user
/// to guess. It is also the seam a later comparison stage needs: a baseline artifact that predates
/// the current definition fingerprint compares as not-comparable, and the only correct instruction
/// there is to <i>regenerate</i> the baseline — never to hand-edit it.
/// </para>
/// </remarks>
internal sealed class EvalCliException : Exception
{
    /// <summary>Initializes a new instance of the <see cref="EvalCliException"/> class.</summary>
    public EvalCliException()
        : this(ExitCode.UnexpectedError, "eval-cli failed.") { }

    /// <summary>Initializes a new instance of the <see cref="EvalCliException"/> class.</summary>
    /// <param name="message">What went wrong.</param>
    public EvalCliException(string message)
        : this(ExitCode.UnexpectedError, message) { }

    /// <summary>Initializes a new instance of the <see cref="EvalCliException"/> class.</summary>
    /// <param name="message">What went wrong.</param>
    /// <param name="innerException">The underlying failure.</param>
    public EvalCliException(string message, Exception innerException)
        : base(message, innerException) => ExitCode = ExitCode.UnexpectedError;

    /// <summary>Initializes a new instance of the <see cref="EvalCliException"/> class.</summary>
    /// <param name="exitCode">The code the process should exit with.</param>
    /// <param name="message">What went wrong.</param>
    /// <param name="remedy">What the user should do about it, or <see langword="null"/>.</param>
    public EvalCliException(ExitCode exitCode, string message, string? remedy = null)
        : base(message)
    {
        ExitCode = exitCode;
        Remedy = remedy;
    }

    /// <summary>Gets the code the process should exit with.</summary>
    public ExitCode ExitCode { get; }

    /// <summary>Gets what the user should do about it, or <see langword="null"/>.</summary>
    public string? Remedy { get; }
}

/// <summary>
/// An interruption that arrived after something durable had already happened.
/// </summary>
/// <remarks>
/// <para>
/// <b>"Interrupted, and nothing was written" is two claims, and only the first is always true.</b>
/// A command that replaces a committed file and is then cancelled while reporting has already
/// changed the thing the user cares about; telling them otherwise sends them looking for a file
/// they still have and straight past the one they no longer do.
/// </para>
/// <para>
/// Derives from <see cref="OperationCanceledException"/> so the exit code is unchanged — this is
/// still an interruption, and <see cref="ExitCodeReporter.Classify"/> reads it as one. What it
/// adds is the sentence that has to replace the blanket one.
/// </para>
/// </remarks>
internal sealed class InterruptedAfterWritingException : OperationCanceledException
{
    /// <summary>Initializes a new instance of the <see cref="InterruptedAfterWritingException"/> class.</summary>
    public InterruptedAfterWritingException()
        : this("Something was written before the interruption.", null) { }

    /// <summary>Initializes a new instance of the <see cref="InterruptedAfterWritingException"/> class.</summary>
    /// <param name="whatWasWritten">What had already landed on disk, in one sentence.</param>
    public InterruptedAfterWritingException(string whatWasWritten)
        : this(whatWasWritten, null) { }

    /// <summary>Initializes a new instance of the <see cref="InterruptedAfterWritingException"/> class.</summary>
    /// <param name="whatWasWritten">What had already landed on disk, in one sentence.</param>
    /// <param name="innerException">The cancellation this replaces.</param>
    public InterruptedAfterWritingException(string whatWasWritten, Exception? innerException)
        : base(whatWasWritten, innerException) => WhatWasWritten = whatWasWritten;

    /// <summary>Gets what had already landed on disk when the interruption arrived.</summary>
    public string WhatWasWritten { get; }
}
