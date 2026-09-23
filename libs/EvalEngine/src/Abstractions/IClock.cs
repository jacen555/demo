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
/// A seed is stamped into every transcript and into the suite artifact, so a run can be
/// reproduced exactly and so a comparison can be genuinely paired. Ambient randomness would
/// silently break both.
/// </remarks>
public interface ISeedSource
{
    /// <summary>Gets the root seed this source was derived from.</summary>
    long RootSeed { get; }

    /// <summary>Produces the next seed in the sequence.</summary>
    /// <returns>The seed for the next run.</returns>
    long NextSeed();
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
}
