using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Tests;

/// <summary>One transport shape: what happened on the wire, and why the turn loop ended.</summary>
/// <remarks>
/// A pair rather than a bare exchange state, because the two are not independent. A run that
/// responded stops for a different reason depending on whether it reached a terminal outcome, ran
/// its caller out of script, or hit a ceiling — and a fixture that pairs a resolved outcome with
/// <see cref="StopReason.ParticipantComplete"/> is describing a run that cannot happen.
/// </remarks>
public readonly record struct TransportShape(string Exchange, string StoppedBy)
{
    public override string ToString() => $"{Exchange}/{StoppedBy}";
}

/// <summary>
/// The one description of what a run of this engine looks like, for every fixture that builds one.
/// </summary>
/// <remarks>
/// <para>
/// Fixture files used to spell the transport attributes out independently, and they spelled them
/// wrong in the same ways — a missing exchange state, and a stop reason belonging to a different
/// run. That is the predictable end of a shape written from memory in more than one place.
/// </para>
/// <para>
/// <b><see cref="Modelled"/> is the inventory, and it is closed.</b>
/// <see cref="FixtureFidelityTests"/> drives a real runner into every entry and compares the full
/// attribute values, and it fails in <i>both</i> directions: a modelled shape with no driver, and
/// a driver for a shape nobody modelled. Listing the shapes a test happens to check is how the
/// first version of this guard came to have holes in it — it compared attribute <i>keys</i>, so a
/// wrong stop reason passed.
/// </para>
/// </remarks>
internal static class ArtifactShapes
{
    /// <summary>Every transport shape a runner in this library can record.</summary>
    public static IReadOnlySet<TransportShape> Modelled { get; } =
        new HashSet<TransportShape>
        {
            // A response, ended by the system reaching a terminal outcome. TerminalCondition
            // declares StopOnTerminalOutcome by default, so this is the common healthy shape —
            // and the one the fixtures previously mislabelled as participantComplete.
            new(ExchangeState.Responded, StopReason.TerminalOutcome),
            // A response, ended because the caller ran out of things to say.
            new(ExchangeState.Responded, StopReason.ParticipantComplete),
            // A response, ended because the run hit its declared ceiling.
            new(ExchangeState.Responded, StopReason.TurnCeiling),
            // A response the adapter was never asked to parse: a non-2xx reply is an answer from
            // the system, so the exchange responded, but the loop ends on a failed exchange.
            new(ExchangeState.Responded, StopReason.ExchangeFailed),
            // The system answered and the adapter rejected the body. Evidence about the system,
            // so the run stays gradeable — but the loop still ended on a failed exchange, which
            // is the pairing the first version of this file got wrong.
            new(ExchangeState.MalformedResponse, StopReason.ExchangeFailed),
            new(ExchangeState.TimedOut, StopReason.ExchangeFailed),
            new(ExchangeState.RequestFailed, StopReason.ExchangeFailed),
            new(ExchangeState.AdapterFailed, StopReason.ExchangeFailed),
            // Nothing was ever sent: the caller completed before the first turn.
            new(ExchangeState.NotAttempted, StopReason.ParticipantComplete),
            new(ExchangeState.ParticipantFailed, StopReason.ParticipantFailed),
            new(ExchangeState.Unsupported, StopReason.Unsupported),
            new(ExchangeState.RunnerFailed, StopReason.RunnerFailed),
        };

    /// <summary>The shape a run that reached a terminal outcome records.</summary>
    public static Dictionary<string, string> GradedSuccess() =>
        Attributes(new TransportShape(ExchangeState.Responded, StopReason.TerminalOutcome));

    /// <summary>The shape a run whose request never arrived records.</summary>
    public static Dictionary<string, string> HarnessFailure(string exchange = ExchangeState.RequestFailed) =>
        Attributes(Canonical(exchange));

    /// <summary>
    /// The shape for an exchange state this library does not define.
    /// </summary>
    /// <remarks>
    /// No runner writes one — this exists so a test can prove that
    /// <see cref="ExchangeState.IsHarnessFailure(string?)"/> fails closed on a state nobody has
    /// written yet. It is deliberately outside <see cref="Modelled"/>, because modelling it would
    /// claim a real runner produces it.
    /// </remarks>
    public static Dictionary<string, string> Unrecognised(string exchange) =>
        Attributes(new TransportShape(exchange, StopReason.ExchangeFailed));

    /// <summary>Whether this inventory describes a run with the given exchange state.</summary>
    public static bool Models(string? exchange) =>
        exchange is not null && Modelled.Any(shape => shape.Exchange == exchange);

    /// <summary>The attributes for a run with the given exchange state, or none at all.</summary>
    /// <param name="exchange">
    /// The exchange state, or <see langword="null"/> to record nothing — the shape of an artifact
    /// whose transcript never says whether the system under test was reached.
    /// </param>
    /// <param name="reachedTerminalOutcome">
    /// Whether the system reached a terminal outcome, which is what decides why a <i>responding</i>
    /// run stopped. Ignored for every other exchange state, which has one modelled shape.
    /// </param>
    public static Dictionary<string, string> For(string? exchange, bool reachedTerminalOutcome = true) =>
        exchange is null ? new Dictionary<string, string>(StringComparer.Ordinal)
        : exchange == ExchangeState.Responded && !reachedTerminalOutcome
            ? Attributes(new TransportShape(ExchangeState.Responded, StopReason.ParticipantComplete))
        : Attributes(Canonical(exchange));

    /// <summary>The shape this inventory models for one exchange state.</summary>
    /// <remarks>
    /// <see cref="ExchangeState.Responded"/> has three, so a caller states which it means through
    /// <see cref="For(string?, bool)"/>; every other state has exactly one. An unmodelled state
    /// throws rather than defaulting, because a shape nobody described is exactly what this file
    /// exists to stop a fixture from inventing.
    /// </remarks>
    private static TransportShape Canonical(string exchange)
    {
        var matches = Modelled.Where(shape => shape.Exchange == exchange).ToArray();

        if (matches.Length == 0)
        {
            throw new InvalidOperationException(
                $"No transport shape is modelled for exchange state '{exchange}'. Add it to "
                    + $"{nameof(ArtifactShapes)}.{nameof(Modelled)} together with a driver in "
                    + $"{nameof(FixtureFidelityTests)} that produces it from a real runner."
            );
        }

        return matches.FirstOrDefault(shape => shape.StoppedBy == StopReason.TerminalOutcome, matches[0]);
    }

    private static Dictionary<string, string> Attributes(TransportShape shape) =>
        new(StringComparer.Ordinal)
        {
            [TransportAttributes.Exchange] = shape.Exchange,
            [TransportAttributes.StoppedBy] = shape.StoppedBy,
        };
}
