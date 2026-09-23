using System.Globalization;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Runners;

/// <summary>
/// The parts of conducting a run that every runner does the same way.
/// </summary>
/// <remarks>
/// Internal, and kept small on purpose. Anything that grows here is a candidate for being a
/// difference between transports, which is the one thing a runner must not introduce. The
/// converse is what put <see cref="SanitizeEndpoint(Uri?)"/> here: a redaction rule implemented
/// correctly in one runner and forgotten in another is not a difference in transport, it is a
/// credential in a committed artifact.
/// </remarks>
internal static class RunnerSupport
{
    /// <summary>What replaces a query string that was dropped from a recorded address.</summary>
    private const string RedactedQuery = "?[redacted]";

    /// <summary>What replaces a fragment that was dropped from a recorded address.</summary>
    private const string RedactedFragment = "#[redacted]";

    /// <summary>What replaces an address that could not be stripped component by component.</summary>
    private const string RedactedAddress = "[redacted]";

    /// <summary>
    /// Refuses a scenario routed to the wrong runner.
    /// </summary>
    /// <remarks>
    /// Mis-routing is a harness fault, not a finding about the system under test. Running the
    /// scenario anyway would produce a transcript that grades exactly like a real one, which is
    /// the shape of a false green rather than of a failure someone notices.
    /// </remarks>
    /// <param name="scenario">The scenario handed to the runner.</param>
    /// <param name="expected">The kind the runner conducts.</param>
    /// <param name="token">How that kind is written in a suite file.</param>
    /// <exception cref="ArgumentException">The scenario declares another kind.</exception>
    public static void RequireKind(Scenario scenario, ScenarioKind expected, string token)
    {
        if (scenario.Identity.Kind == expected)
        {
            return;
        }

        throw new ArgumentException(
            $"Scenario '{scenario.Identity.Id}' declares kind '{scenario.Identity.Kind}', and this runner "
                + $"conducts '{token}' runs. A scenario routed to the wrong runner is a harness fault rather "
                + "than a finding about the system under test, and the transcript it produced would be graded "
                + "as though the right transport had been used — so it is refused rather than run.",
            nameof(scenario)
        );
    }

    /// <summary>
    /// Refuses a participant that was not built for the mode the scenario declares.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The kind check above catches a scenario routed to the wrong runner. This catches the other
    /// half of the same mis-wiring: the right runner, driven by the wrong <i>caller</i>. A
    /// <see cref="ExecutionMode.Deterministic"/> scenario is approved by the suite loader as
    /// bounded by its script, and running it with a model-backed caller leaves that approval
    /// resting on a fiction — every otherwise-unscoped assertion then grades turns the script
    /// never drove, which is the false green this library's guards exist to prevent.
    /// </para>
    /// <para>
    /// Thrown rather than recorded, exactly as a mis-routed kind is: a participant is chosen once
    /// for a scenario, so the mismatch affects every run of it rather than being a property of one
    /// run, and a transcript produced this way would grade exactly like a real one.
    /// </para>
    /// <para>
    /// A participant that does not implement <see cref="IModeBoundParticipant"/> cannot be checked
    /// here and is checked turn by turn instead — see
    /// <see cref="DescribeScriptedPrefixMismatch(Scenario, int, string, TurnProvenance)"/>.
    /// </para>
    /// </remarks>
    /// <param name="scenario">The scenario about to be run.</param>
    /// <param name="participant">The participant supplied for this run.</param>
    /// <exception cref="ArgumentException">The participant declares another mode.</exception>
    public static void RequireParticipantMatchesMode(Scenario scenario, IParticipant participant)
    {
        if (participant is not IModeBoundParticipant bound || bound.Mode == scenario.Execution.Mode)
        {
            return;
        }

        throw new ArgumentException(
            $"Scenario '{scenario.Identity.Id}' declares execution mode '{scenario.Execution.Mode}', and the "
                + $"participant supplied for this run ({participant.GetType().Name}) produces stimuli for "
                + $"'{bound.Mode}'. The mode decides where a turn's text comes from and therefore what its "
                + "provenance means: the suite loader approves otherwise-unscoped assertions on the premise that "
                + "a deterministic scenario is bounded by its script, so a caller that generates turns instead "
                + "would have those assertions grade material the script never drove. That is a harness fault "
                + "rather than a finding about the system under test, so it is refused rather than run.",
            nameof(participant)
        );
    }

    /// <summary>
    /// How an offered turn diverged from the scripted material the scenario declares: a
    /// classification that is always safe to record, and the specifics that are not.
    /// </summary>
    /// <remarks>
    /// Split because the refused turn is never recorded as a <see cref="Turn"/>, which makes the
    /// failure message the only thing that could carry the text the participant offered — and a
    /// transcript is committed. Text of unknown provenance is withheld by default for the reason
    /// an exception message is (§V); the classification names which of the script's three claims
    /// broke, which is what a reader needs to act and carries nothing a caller wrote.
    /// </remarks>
    /// <param name="Classification">A fixed token naming the kind of divergence.</param>
    /// <param name="Detail">The specifics, quoting material the runner cannot vouch for.</param>
    public sealed record ScriptedPrefixMismatch(string Classification, string Detail);

    /// <summary>
    /// How an offered turn diverges from the scripted material the scenario declares, or
    /// <see langword="null"/> when it does not.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Only <see cref="ExecutionMode.Deterministic"/> is policed, because that is the only mode in
    /// which anything rests on the answer: the suite loader's script-overrun guard reads
    /// <see cref="Simulation.ScriptedTurnBudget"/> and approves assertions on the premise that
    /// turns one through the budget were replayed verbatim from the suite file. The loader runs at
    /// load time and the evaluators at grading time; neither can establish that premise, and a
    /// participant declaring its mode does not establish it either — a participant could still go
    /// off script mid-run. This is the one place the turn about to be sent can still be compared
    /// against the file it is supposed to have come from.
    /// </para>
    /// <para>
    /// Past the budget there is no scripted material left to have been replayed, so a turn still
    /// claiming <see cref="TurnProvenance.Scripted"/> widens the window the guard defends and is
    /// refused too.
    /// </para>
    /// <para>
    /// <b>This reads <see cref="Scenario.Simulation"/>, which the participant owns.</b> That is
    /// deliberate and is the one legitimate reason to: nothing here consumes simulation material
    /// to <i>drive</i> anything — no stimulus is selected, no material is sent — it is read only to
    /// check the participant it was handed against the scenario it was handed, which is a
    /// comparison no single owner can make alone.
    /// </para>
    /// </remarks>
    /// <param name="scenario">The scenario being run.</param>
    /// <param name="index">The one-based index of the turn being offered.</param>
    /// <param name="stimulus">The text the participant offered.</param>
    /// <param name="provenance">The provenance the participant declared.</param>
    /// <returns>The divergence, or <see langword="null"/> when there is none.</returns>
    public static ScriptedPrefixMismatch? DescribeScriptedPrefixMismatch(
        Scenario scenario,
        int index,
        string stimulus,
        TurnProvenance provenance
    )
    {
        if (scenario.Execution.Mode != ExecutionMode.Deterministic)
        {
            return null;
        }

        var script = ScriptedStimuli(scenario.Simulation);
        var turn = index.ToString(CultureInfo.InvariantCulture);

        if (index > script.Count)
        {
            return provenance == TurnProvenance.Scripted
                ? new ScriptedPrefixMismatch(
                    "scriptedPastTheBudget",
                    $"turn {turn} is tagged {nameof(TurnProvenance.Scripted)}, but the script drives only "
                        + $"{script.Count.ToString(CultureInfo.InvariantCulture)} turn(s), so there is no scripted "
                        + "material it could have been replayed from"
                )
                : null;
        }

        var scripted = script[index - 1];

        if (provenance != TurnProvenance.Scripted)
        {
            return new ScriptedPrefixMismatch(
                "turnNotScripted",
                $"turn {turn} is tagged {provenance}, but the scenario's script drives it and the suite loader "
                    + $"approves assertions on the premise that it is {nameof(TurnProvenance.Scripted)}"
            );
        }

        return string.Equals(stimulus, scripted, StringComparison.Ordinal)
            ? null
            : new ScriptedPrefixMismatch(
                "stimulusNotTheScriptedLine",
                $"turn {turn} offered '{stimulus}' rather than the scripted line '{scripted}' (compared ordinally, "
                    + "so case must match exactly)"
            );
    }

    /// <summary>
    /// The stimuli a scenario's script drives, in the order it drives them.
    /// </summary>
    /// <remarks>
    /// Built the way <see cref="Participants.DeterministicCaller"/> builds it and counted the way
    /// <see cref="Simulation.ScriptedTurnBudget"/> counts it — the opening is turn one, and blank
    /// entries are dropped rather than allowed to occupy an index. Three readings of one premise
    /// that disagreed would be worse than none.
    /// </remarks>
    private static List<string> ScriptedStimuli(Simulation simulation)
    {
        var script = new List<string>(simulation.ScriptedStimuli.Count + 1);

        if (!string.IsNullOrWhiteSpace(simulation.Opening))
        {
            script.Add(simulation.Opening);
        }

        script.AddRange(
            simulation
                .ScriptedStimuli.Where(stimulus => !string.IsNullOrWhiteSpace(stimulus?.Text))
                .Select(stimulus => stimulus.Text)
        );

        return script;
    }

    /// <summary>
    /// Strips credentials from an address before it is recorded.
    /// </summary>
    /// <remarks>
    /// The overload every runner reaches for when the adapter states its own address as text.
    /// An address that does not parse into components cannot be stripped component by component,
    /// so it is recorded only when it carries none of the delimiters a credential-bearing part
    /// would follow — <c>@</c>, <c>?</c>, or <c>#</c>. Redacting wholesale is the conservative
    /// direction: an opaque label is a convenience, and a leaked credential is not recoverable
    /// once it is committed (§V).
    /// </remarks>
    /// <param name="endpoint">The address the adapter reported, which may be null or blank.</param>
    /// <returns>The address as it may be recorded, or <see langword="null"/> when there is none.</returns>
    public static string? SanitizeEndpoint(string? endpoint)
    {
        if (string.IsNullOrWhiteSpace(endpoint))
        {
            return null;
        }

        var address = endpoint.Trim();

        // A URI with no authority is opaque — 'scheme:everything-else' — so UserInfo is empty even
        // when the text carries 'user:password@host', and stripping components would leave it
        // verbatim. Only a hierarchical address can be taken apart safely.
        if (Uri.TryCreate(address, UriKind.Absolute, out var uri) && !string.IsNullOrEmpty(uri.Authority))
        {
            return SanitizeEndpoint(uri);
        }

        return address.AsSpan().IndexOfAny('@', '?', '#') < 0 ? address : RedactedAddress;
    }

    /// <summary>
    /// Strips credentials from a resolved address before it is recorded.
    /// </summary>
    /// <remarks>
    /// The endpoint travels into a committed artifact, so every part of a URI that can carry a
    /// credential is removed: the userinfo segment, the query, and the fragment (§V). A query
    /// string is where a bearer token, a SAS signature, or an API key most often lives, and an
    /// OAuth fragment carries an access token by design — so neither survives. A marker is left in
    /// place of what was dropped, because silently recording a bare path would claim an address
    /// the run never used, and would make two runs that differed only by query string look
    /// identical.
    /// </remarks>
    /// <param name="uri">The address the run was directed at, or null.</param>
    /// <returns>The address as it may be recorded, or <see langword="null"/> when there is none.</returns>
    public static string? SanitizeEndpoint(Uri? uri)
    {
        if (uri is null)
        {
            return null;
        }

        if (!uri.IsAbsoluteUri || string.IsNullOrEmpty(uri.Authority))
        {
            return SanitizeEndpoint(uri.ToString());
        }

        var hasQuery = !string.IsNullOrEmpty(uri.Query);
        var hasFragment = !string.IsNullOrEmpty(uri.Fragment);

        if (!hasQuery && !hasFragment && string.IsNullOrEmpty(uri.UserInfo))
        {
            return uri.ToString();
        }

        var address = new UriBuilder(uri)
        {
            UserName = string.Empty,
            Password = string.Empty,
            Query = string.Empty,
            Fragment = string.Empty,
        }.Uri.ToString();

        return address + (hasQuery ? RedactedQuery : string.Empty) + (hasFragment ? RedactedFragment : string.Empty);
    }

    /// <summary>
    /// Merges what an adapter reported <b>beneath</b> the runner's own record of what happened.
    /// </summary>
    /// <remarks>
    /// An adapter may add to the record of what happened on the wire; it may not rewrite it. The
    /// reserved keys in <see cref="TransportAttributes"/> are written last for that reason — a
    /// downstream stage deciding whether a run is gradeable must be reading the runner's account,
    /// not an adapter's account of itself.
    /// </remarks>
    /// <param name="fromAdapter">Attributes the adapter supplied.</param>
    /// <param name="observed">Attributes the runner observed on the wire.</param>
    /// <param name="exchange">The <see cref="ExchangeState"/> the run reached.</param>
    /// <param name="stoppedBy">The <see cref="StopReason"/> that ended the turn loop.</param>
    /// <param name="failure">Why the exchange did not complete normally, or null when it did.</param>
    /// <returns>The transport attributes for the transcript.</returns>
    public static IReadOnlyDictionary<string, string> Attributes(
        IReadOnlyDictionary<string, string> fromAdapter,
        IReadOnlyDictionary<string, string> observed,
        string exchange,
        string stoppedBy,
        string? failure
    )
    {
        var merged = new Dictionary<string, string>(fromAdapter, StringComparer.Ordinal);

        foreach (var attribute in observed)
        {
            merged[attribute.Key] = attribute.Value;
        }

        merged[TransportAttributes.Exchange] = exchange;
        merged[TransportAttributes.StoppedBy] = stoppedBy;

        if (string.IsNullOrWhiteSpace(failure))
        {
            merged.Remove(TransportAttributes.Failure);
        }
        else
        {
            merged[TransportAttributes.Failure] = failure;
        }

        return merged;
    }
}
