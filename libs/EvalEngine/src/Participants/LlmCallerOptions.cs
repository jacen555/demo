namespace Forge.EvalEngine.Participants;

/// <summary>
/// What a <see cref="LlmCaller"/> may tell its model, and what it will accept back.
/// </summary>
public sealed record LlmCallerOptions
{
    /// <summary>
    /// The default ceiling on a stimulus, in characters. Generous for a caller's turn in a
    /// conversation, and far below the length at which an unbounded completion becomes a problem
    /// in a committed artifact.
    /// </summary>
    public const int DefaultMaxStimulusLength = 2000;

    private readonly int _maxStimulusLength = DefaultMaxStimulusLength;
    private readonly string? _persona;

    /// <summary>Gets the conservative defaults every constructor overload uses.</summary>
    public static LlmCallerOptions Default { get; } = new();

    /// <summary>
    /// Gets how the caller should express itself, or <see langword="null"/> for no instruction.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>A persona governs delivery, never truth.</b> "Terse and impatient", "rambling, mentions
    /// their dog" — style. What is actually the case is
    /// <see cref="Scenarios.Simulation.Facts"/>, and the two are kept apart in the prompt for a
    /// measured reason: an unconstrained persona simulator errs on roughly 40–47% of turns, while
    /// one constrained to a stated state errs on roughly 16%. A persona invited to supply facts is
    /// the unconstrained case, and the errors it invents are indistinguishable, in a transcript,
    /// from the system under test mishandling a real caller.
    /// </para>
    /// <para>
    /// Kept here rather than on <see cref="Scenarios.Simulation"/> deliberately. It is a property
    /// of the harness a run was driven with, not material a suite file declares, so putting it in
    /// the suite schema would version a committed artifact for something no other stage reads.
    /// </para>
    /// <para>
    /// This text is authored by the harness operator and is placed in the instruction, so it is
    /// the one input to the prompt that is <i>not</i> treated as untrusted. Do not build it from
    /// anything the system under test returned.
    /// </para>
    /// </remarks>
    /// <exception cref="ArgumentException">The value is empty or whitespace.</exception>
    public string? Persona
    {
        get => _persona;
        init =>
            _persona =
                value is null || !string.IsNullOrWhiteSpace(value)
                    ? value
                    : throw new ArgumentException(
                        "persona must not be blank when it is declared; omit it instead of blanking it.",
                        nameof(value)
                    );
    }

    /// <summary>
    /// Gets the longest stimulus the caller will send, in characters. Defaults to
    /// <see cref="DefaultMaxStimulusLength"/>.
    /// </summary>
    /// <remarks>
    /// A completion is untrusted output that becomes a persisted <see cref="Transcripts.Turn"/>
    /// in a committed artifact, and a model that loops or dumps its context produces a very large
    /// one. The caller truncates <b>before</b> sending rather than after recording, so the
    /// transcript always says exactly what the system under test was given — a runner that
    /// recorded less than it sent would be the false-green shape this library is built against
    /// (§V).
    /// </remarks>
    /// <exception cref="ArgumentOutOfRangeException">The value is less than one.</exception>
    public int MaxStimulusLength
    {
        get => _maxStimulusLength;
        init
        {
            ArgumentOutOfRangeException.ThrowIfLessThan(value, 1);

            _maxStimulusLength = value;
        }
    }
}
