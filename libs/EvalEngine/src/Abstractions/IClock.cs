using System.Text;

namespace Forge.EvalEngine.Abstractions;

/// <summary>
/// Supplies the current time.
/// </summary>
/// <remarks>
/// Injected rather than read from <see cref="DateTimeOffset.UtcNow"/> inline, because the
/// timestamp is stamped into a committed artifact and a test needs to be able to pin it.
/// </remarks>
public interface IClock
{
    /// <summary>Gets the current UTC time.</summary>
    DateTimeOffset UtcNow { get; }
}

/// <summary>
/// An <see cref="IClock"/> backed by the system clock. The composition-root default.
/// </summary>
public sealed class SystemClock : IClock
{
    /// <summary>Gets a shared instance.</summary>
    public static SystemClock Instance { get; } = new();

    /// <inheritdoc/>
    public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;
}

/// <summary>
/// Supplies the seeds that drive runs.
/// </summary>
/// <remarks>
/// <para>
/// A seed is stamped into every transcript and into the suite artifact, so a run can be
/// reproduced exactly and so a comparison can be genuinely paired. Ambient randomness would
/// silently break both.
/// </para>
/// <para>
/// <b>A run's seed is a function of the run, never of where the run sits in a list.</b> The
/// comparison is paired by seed, so whatever the seed depends on becomes a precondition of every
/// comparison against every baseline. A seed drawn by position makes the order of the suite file
/// and the outcome of impact selection into that precondition — reorder the suite or narrow it,
/// and every scenario after the first change is driven with a seed its own baseline recorded
/// against a different scenario, and the pairing guard then reports it not-comparable. That
/// failure is silent in the worst direction: a narrowed run un-examines exactly the scenarios the
/// narrowing was for, and the report shows no regression because nothing was compared.
/// </para>
/// <para>
/// <see cref="SeedFor(string, int)"/> is therefore what the coordinator draws from, and an
/// implementation must derive the seed from the root seed, the scenario's own id, and the
/// repetition number. It has no working default: a source that implements only
/// <see cref="NextSeed"/> is <b>refused</b> before anything is dispatched, because silently
/// deriving a seed on its behalf would discard the sequence it was written to supply and unpair
/// every baseline it had already produced.
/// </para>
/// </remarks>
public interface ISeedSource
{
    /// <summary>Gets the root seed this source was derived from.</summary>
    long RootSeed { get; }

    /// <summary>Produces the next seed in the sequence.</summary>
    /// <returns>The seed for the next run.</returns>
    /// <remarks>
    /// A positional draw, kept for callers that genuinely want a sequence. Nothing in this
    /// library's execution path uses it: the coordinator asks for a run's seed by name through
    /// <see cref="SeedFor(string, int)"/>.
    /// </remarks>
    long NextSeed();

    /// <summary>Gets the seed one repetition of one scenario is driven with.</summary>
    /// <param name="scenarioId">The scenario the run belongs to — the join key a baseline is matched on.</param>
    /// <param name="repetition">The one-based repetition number within that scenario.</param>
    /// <returns>The seed for that run.</returns>
    /// <remarks>
    /// <para>
    /// <b>The default throws, and that is the point.</b> This member could not be made abstract
    /// without breaking every existing implementer at compile time, and a default that derived a
    /// seed here would be worse: an implementer written against <see cref="NextSeed"/> alone
    /// would keep compiling, stop being consulted, and its runs would pair against nothing in any
    /// baseline it had already produced. A source that does not implement this is refused before
    /// anything is dispatched rather than quietly bypassed.
    /// </para>
    /// <para>
    /// An implementation must derive the seed from <see cref="RootSeed"/>,
    /// <paramref name="scenarioId"/>, and <paramref name="repetition"/> and nothing else, and must
    /// be injective in the repetition — two repetitions of one scenario sharing a seed is refused
    /// by the coordinator. <see cref="DeterministicSeedSource"/> is the implementation a
    /// composition root normally registers.
    /// </para>
    /// </remarks>
    /// <exception cref="NotSupportedException">
    /// The implementation does not derive seeds from a run's identity.
    /// </exception>
    long SeedFor(string scenarioId, int repetition) =>
        throw new NotSupportedException(
            $"{GetType().Name} does not implement {nameof(ISeedSource)}.{nameof(SeedFor)}, so it can only issue "
                + "seeds by position in a sequence. A run's seed is part of its identity and the comparison is "
                + "paired on it, so a positional source makes reordering or narrowing a suite move every later "
                + "scenario's seed out from under its own baseline. Implement SeedFor as a function of the root "
                + "seed, the scenario id, and the repetition — or register DeterministicSeedSource, which does. "
                + "This source is refused rather than bypassed, because bypassing it would silently discard the "
                + "sequence it was written to supply."
        );
}

/// <summary>
/// The default seed derivation: a run's seed from the run's own identity.
/// </summary>
/// <remarks>
/// <para>
/// <b>The identifier is digested rather than hashed with <see cref="string.GetHashCode()"/>.</b>
/// That hash is randomized per process, so a seed derived from it would differ between two runs
/// of the same suite on the same machine — which is the defect this derivation exists to remove,
/// in a form that no test on one process could ever observe.
/// </para>
/// <para>
/// <b>Repetitions of one scenario cannot collide.</b> The repetition is multiplied by an odd
/// constant, which is invertible modulo 2^64, and the result is passed through the SplitMix64
/// finalizer, which is a bijection. Distinct repetitions therefore produce distinct seeds by
/// construction rather than by the coordinator noticing afterwards.
/// </para>
/// </remarks>
internal static class SeedDerivation
{
    /// <summary>The golden-ratio odd constant SplitMix64 advances by.</summary>
    private const ulong Golden = 0x9E3779B97F4A7C15UL;

    /// <summary>Derives the seed for one repetition of one scenario.</summary>
    /// <param name="rootSeed">The root seed the whole run is reproduced from.</param>
    /// <param name="scenarioId">The scenario's identifier.</param>
    /// <param name="repetition">The one-based repetition number.</param>
    /// <returns>The seed, a pure function of the three arguments.</returns>
    public static long Derive(long rootSeed, string scenarioId, int repetition)
    {
        ArgumentNullException.ThrowIfNull(scenarioId);
        unchecked
        {
            var state = Mix((ulong)rootSeed + Digest(scenarioId));

            return (long)Mix(state + ((ulong)(uint)repetition * Golden));
        }
    }

    /// <summary>FNV-1a over the identifier's UTF-8 bytes — stable across processes and builds.</summary>
    private static ulong Digest(string value)
    {
        unchecked
        {
            var hash = 0xCBF29CE484222325UL;

            foreach (var octet in Encoding.UTF8.GetBytes(value))
            {
                hash = (hash ^ octet) * 0x100000001B3UL;
            }

            return hash;
        }
    }

    /// <summary>The SplitMix64 finalizer — the mixer this library already uses, and a bijection.</summary>
    private static ulong Mix(ulong value)
    {
        unchecked
        {
            var mixed = value + Golden;
            mixed = (mixed ^ (mixed >> 30)) * 0xBF58476D1CE4E5B9UL;
            mixed = (mixed ^ (mixed >> 27)) * 0x94D049BB133111EBUL;

            return mixed ^ (mixed >> 31);
        }
    }
}

/// <summary>
/// An <see cref="ISeedSource"/> whose sequence is fully determined by its root seed.
/// </summary>
/// <remarks>
/// <para>
/// Two instances constructed with the same root seed produce the same sequence, which is what
/// lets a baseline run and a candidate run be paired scenario-by-scenario. Record the root seed
/// in the artifact and the whole run can be replayed.
/// </para>
/// <para>This type is not thread-safe. Give each concurrent worker its own instance.</para>
/// </remarks>
public sealed class DeterministicSeedSource : ISeedSource
{
    private ulong _state;

    /// <summary>Initializes a new instance seeded from <paramref name="rootSeed"/>.</summary>
    /// <param name="rootSeed">The root seed. Any value is valid.</param>
    public DeterministicSeedSource(long rootSeed)
    {
        RootSeed = rootSeed;
        _state = unchecked((ulong)rootSeed);
    }

    /// <inheritdoc/>
    public long RootSeed { get; }

    /// <inheritdoc/>
    public long NextSeed()
    {
        // SplitMix64: a small, well-distributed mixer whose only state is a counter, so the
        // sequence is a pure function of the root seed and the call index.
        unchecked
        {
            _state += 0x9E3779B97F4A7C15UL;
            var mixed = _state;
            mixed = (mixed ^ (mixed >> 30)) * 0xBF58476D1CE4E5B9UL;
            mixed = (mixed ^ (mixed >> 27)) * 0x94D049BB133111EBUL;
            mixed ^= mixed >> 31;
            return (long)mixed;
        }
    }

    /// <inheritdoc/>
    /// <remarks>
    /// The derivation the interface requires and does not supply. Unlike <see cref="NextSeed"/>
    /// this carries no state: the same source asked twice for the same run answers the same way,
    /// and a narrowed run draws exactly the seeds the full suite would have given the scenarios it
    /// kept.
    /// </remarks>
    public long SeedFor(string scenarioId, int repetition) => SeedDerivation.Derive(RootSeed, scenarioId, repetition);
}
