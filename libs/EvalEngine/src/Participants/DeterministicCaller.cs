using System.Globalization;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Participants;

/// <summary>
/// A simulated caller that draws every stimulus from the scenario's own material, so that a run
/// contains no stochastic element other than the system under test.
/// </summary>
/// <remarks>
/// <para>
/// <b>This is the harness's primary variance-reduction mechanism.</b> It replays
/// <see cref="Simulation.ScriptedStimuli"/> and, where the mode allows it, picks from
/// <see cref="Simulation.StimulusPool"/> by token overlap — it never asks a model what to say
/// next. A persona-driven model standing in for the caller is itself a source of error, so a
/// suite driven by one measures the harness and the system together. This caller contributes
/// none: re-running a scenario changes the result only if the system changed. That is what makes
/// it the right default for a regression suite, and why a model-driven caller belongs only in
/// scenarios whose purpose is realism testing.
/// </para>
/// <para>
/// <b>Trade-off a scenario author needs to know: a synthesized caller can only ever stay ON
/// topic.</b> It answers out of the scenario's own facts, so a whole class of bug — how the
/// system copes with an irrelevant, adversarial, or abruptly changed subject — is not merely
/// untested but <i>inexpressible</i> by pool selection. <see cref="Simulation.ScriptedStimuli"/>
/// is the escape hatch: write the off-topic line there and it is replayed verbatim, as
/// <see cref="TurnProvenance.Scripted"/>. If a scenario needs to probe off-topic handling, script
/// it — do not expect the pool to wander there.
/// </para>
/// <para>
/// <b>Provenance is load-bearing.</b> Turns <c>1..</c><see cref="Simulation.ScriptedTurnBudget"/>
/// are the scripted ones and are tagged <see cref="TurnProvenance.Scripted"/>; anything past them
/// is tagged <see cref="TurnProvenance.Synthesized"/>. The suite loader's script-overrun guard
/// trusts that boundary at load time and the assertion evaluators re-derive scope from it at
/// grading time, so a turn tagged wrongly here would let an assertion measure this caller while
/// its author believed it measured the system.
/// </para>
/// </remarks>
public sealed class DeterministicCaller : IParticipant
{
    private readonly ExecutionMode _mode;
    private readonly string[] _script;
    private readonly string[] _pool;
    private readonly HashSet<string>[] _poolTokens;

    /// <summary>
    /// Creates a caller over one scenario's simulation material.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <paramref name="mode"/> is supplied by the runner, which owns
    /// <see cref="Scenarios.Execution"/>, rather than read from the scenario here — the
    /// participant owns <see cref="Simulation"/> and nothing else.
    /// </para>
    /// <para>
    /// The mode decides what happens when the script runs out, and the difference is not
    /// cosmetic. Under <see cref="ExecutionMode.Deterministic"/> the caller <b>completes</b>,
    /// because the suite validator bounds a run to
    /// <see cref="Simulation.ScriptedTurnBudget"/> whenever
    /// <see cref="TerminalCondition.StopOnParticipantCompletion"/> is enabled, and approves
    /// otherwise-unscoped assertions on the strength of it. A caller that kept talking would
    /// make that approval false. Under <see cref="ExecutionMode.Simulated"/> the caller falls
    /// through to the pool, which is the mode the overrun guard deliberately does not police.
    /// </para>
    /// </remarks>
    /// <param name="simulation">The material this caller may draw on.</param>
    /// <param name="mode">How stimuli are produced once the script is exhausted.</param>
    /// <exception cref="ArgumentNullException"><paramref name="simulation"/> is null.</exception>
    /// <exception cref="ArgumentOutOfRangeException">
    /// <paramref name="mode"/> is <see cref="ExecutionMode.Live"/>, which means stimuli come from
    /// a real external caller. This type cannot produce one, and tagging its own output
    /// <see cref="TurnProvenance.Live"/> would misreport where the text came from.
    /// </exception>
    public DeterministicCaller(Simulation simulation, ExecutionMode mode)
    {
        ArgumentNullException.ThrowIfNull(simulation);

        if (mode is not (ExecutionMode.Deterministic or ExecutionMode.Simulated))
        {
            throw new ArgumentOutOfRangeException(
                nameof(mode),
                mode,
                "A deterministic caller produces scripted and synthesized stimuli only. Live stimuli come from "
                    + "a real external caller, so this participant cannot serve that mode."
            );
        }

        _mode = mode;
        _script = BuildScript(simulation);
        _pool = simulation.StimulusPool.Where(entry => !string.IsNullOrWhiteSpace(entry)).ToArray();
        _poolTokens = _pool.Select(Tokenize).ToArray();
    }

    /// <summary>
    /// Supplies the next stimulus: the scripted line for this turn, a pool entry chosen by token
    /// overlap with the system's most recent response, or completion.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The turn being answered is <c>transcriptSoFar.Turns.Count + 1</c>, and every decision is a
    /// function of that transcript alone — including which stimuli have already been sent.
    /// Holding no mutable state of its own is what makes this caller reproducible rather than
    /// merely repeatable: the same transcript yields the same stimulus however many times it is
    /// asked, so a retried or re-driven turn cannot drift.
    /// </para>
    /// <para>
    /// <b>That makes the transcript load-bearing input, so it is verified rather than trusted.</b>
    /// Deriving position from a transcript is only sound if the transcript is the one this caller
    /// drove, so the prefix it claims authorship of must be the prefix it would have produced —
    /// the script's text, one-based indices, and <see cref="TurnProvenance.Scripted"/> provenance.
    /// Without that check a two-turn script handed a transcript whose opening came from elsewhere
    /// would emit the <i>second</i> line, tag it <see cref="TurnProvenance.Scripted"/>, and
    /// complete, leaving the suite loader's approval of unscoped assertions resting on a premise
    /// nothing established.
    /// </para>
    /// <para>
    /// Because the opening occupies turn one, <c>ScriptedStimuli[0]</c> drives turn <b>two</b>
    /// whenever <see cref="Simulation.Opening"/> is present.
    /// </para>
    /// </remarks>
    /// <param name="transcriptSoFar">Everything that has happened in this run so far.</param>
    /// <param name="cancellationToken">Cancels the request.</param>
    /// <returns>The next stimulus, or <see cref="ParticipantTurn.Complete"/>.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="transcriptSoFar"/> is null.</exception>
    /// <exception cref="ArgumentException">
    /// <paramref name="transcriptSoFar"/> was not driven by this caller's script, so the position
    /// derived from it would be wrong. Refused rather than completed — a harness fault is not a
    /// finding about the system under test.
    /// </exception>
    /// <exception cref="OperationCanceledException">The token was cancelled.</exception>
    public ValueTask<ParticipantTurn> NextAsync(Transcript transcriptSoFar, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(transcriptSoFar);
        RequireScriptDroveThePrefix(transcriptSoFar);

        var position = transcriptSoFar.Turns.Count;

        if (position < _script.Length)
        {
            return new ValueTask<ParticipantTurn>(ParticipantTurn.Next(_script[position], TurnProvenance.Scripted));
        }

        // The script is exhausted. Under Deterministic mode that is the end of the run, and the
        // suite loader has already approved assertions on the strength of it.
        return new ValueTask<ParticipantTurn>(
            _mode == ExecutionMode.Deterministic ? ParticipantTurn.Complete : Synthesize(transcriptSoFar)
        );
    }

    /// <summary>
    /// Requires that the turns this caller is deriving its position from are the ones it emitted.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The suite loader approves otherwise-unscoped assertions on the premise that turns
    /// <c>1..</c><see cref="Simulation.ScriptedTurnBudget"/> are script-driven, and the assertion
    /// evaluators narrow their scope to that same premise. Neither can establish it — they run
    /// at load time and at grading time. This caller is what makes it true at run time, so the
    /// prefix it is about to extend has to be checked on all three things the premise asserts:
    /// the script's <b>text</b>, compared ordinally like every other verdict-bearing comparison
    /// in this library; the <b>one-based index</b> the loader reasons in; and
    /// <see cref="TurnProvenance.Scripted"/> <b>provenance</b>.
    /// </para>
    /// <para>
    /// <b>Only the scripted prefix is checked, deliberately.</b> Turns past the budget carry no
    /// claim this caller made and no stage derives scope from their provenance — the overrun
    /// guard does not police <see cref="ExecutionMode.Simulated"/> at all — so verifying them
    /// would defend a premise nothing rests on.
    /// </para>
    /// <para>
    /// <b>Why this throws rather than completing.</b> The library already draws the line this
    /// decision needs: a statement that does not hold about the <i>system under test</i> is
    /// graded, while one that cannot be evaluated at all is refused, because reporting it as a
    /// failure would invent a regression no system caused. A transcript the script did not drive
    /// is neither — it is a <i>harness</i> fault, and
    /// <see cref="Results.RunStatus.Error"/> is the bucket that exists for exactly that.
    /// Completing would be indistinguishable from a clean end-of-script: the runner would stop,
    /// the transcript would be graded, and a verdict about the system would be reported from
    /// evidence its caller never produced — the same false green this chain of guards exists to
    /// prevent. It would also be a silent hard failure, since abandoning the remaining script
    /// leaves no observable signal a participant could emit. Refusing is the loud option, and
    /// the only honest one.
    /// </para>
    /// </remarks>
    /// <param name="transcriptSoFar">The transcript position is being derived from.</param>
    /// <exception cref="ArgumentException">A turn in the scripted prefix is not the one this
    /// caller emitted for that position.</exception>
    private void RequireScriptDroveThePrefix(Transcript transcriptSoFar)
    {
        var claimed = Math.Min(transcriptSoFar.Turns.Count, _script.Length);

        for (var index = 0; index < claimed; index++)
        {
            if (DescribeMismatch(transcriptSoFar.Turns[index], index, _script[index]) is not { } mismatch)
            {
                continue;
            }

            throw new ArgumentException(
                $"Turn {Number(index + 1)} was not driven by this caller's script: {mismatch}. This caller reads "
                    + "how far the script has run from the transcript it is given, so continuing would replay the "
                    + $"wrong line and tag it {nameof(TurnProvenance.Scripted)} — and the suite loader approves "
                    + "otherwise-unscoped assertions on the premise that turns 1 to the scripted budget are "
                    + "script-driven. Drive the run with the participant that produced this transcript, or start a "
                    + "fresh run.",
                nameof(transcriptSoFar)
            );
        }
    }

    /// <summary>
    /// How a recorded turn differs from the scripted turn for its position, or
    /// <see langword="null"/> when it does not.
    /// </summary>
    private static string? DescribeMismatch(Turn turn, int index, string scripted)
    {
        if (turn.Index != index + 1)
        {
            return $"it is numbered {Number(turn.Index)} rather than {Number(index + 1)}";
        }

        if (turn.Provenance != TurnProvenance.Scripted)
        {
            return $"its provenance is {turn.Provenance}, not {nameof(TurnProvenance.Scripted)}";
        }

        return string.Equals(turn.Stimulus, scripted, StringComparison.Ordinal)
            ? null
            : $"its stimulus is '{turn.Stimulus}' rather than the scripted line '{scripted}' (compared ordinally, "
                + "so case must match exactly)";
    }

    private static string Number(int value) => value.ToString(CultureInfo.InvariantCulture);

    /// <summary>
    /// The stimuli that can actually drive a turn, in the order they drive them.
    /// </summary>
    /// <remarks>
    /// Blank and missing entries are dropped rather than allowed to occupy a turn index, which
    /// keeps this list exactly as long as <see cref="Simulation.ScriptedTurnBudget"/> — the
    /// number the overrun guard trusts. Letting an unusable entry consume an index would shift
    /// every later scripted turn past the budget and tag it as synthesized, quietly moving the
    /// boundary the guard defends.
    /// </remarks>
    private static string[] BuildScript(Simulation simulation)
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

        return [.. script];
    }

    /// <summary>
    /// Picks the unused pool entry sharing the most tokens with the system's latest response.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Entries already sent this run are excluded, so the caller cannot loop on its strongest
    /// match — an exchange where the caller repeats itself tells you nothing about the system.
    /// "Already sent" is read from the transcript, so a pool entry that duplicates a scripted
    /// line is spent by that line too.
    /// </para>
    /// <para>
    /// <b>Ties are resolved by pool order — the earliest entry wins.</b> Scores are compared
    /// strictly, so the first entry to reach the best score keeps it. That rule is arbitrary but
    /// it must be <i>stated</i>: a tie broken by hash order, or by whichever entry the runtime
    /// happened to enumerate first, would make the whole run irreproducible — the one property
    /// this type exists to provide. A blank or absent response scores every entry zero, so the
    /// first unused entry is taken.
    /// </para>
    /// <para>
    /// Returning <see cref="ParticipantTurn.Complete"/> when nothing is left is a terminal
    /// signal, not a swallowed failure: the caller genuinely has nothing further to contribute,
    /// and the transcript records exactly the turns that occurred.
    /// </para>
    /// </remarks>
    private ParticipantTurn Synthesize(Transcript transcriptSoFar)
    {
        var alreadySent = transcriptSoFar.Turns.Select(turn => turn.Stimulus).ToHashSet(StringComparer.Ordinal);
        var responseTokens = Tokenize(transcriptSoFar.Turns.Count == 0 ? null : transcriptSoFar.Turns[^1].Response);

        var best = -1;
        var bestScore = -1;

        for (var index = 0; index < _pool.Length; index++)
        {
            if (alreadySent.Contains(_pool[index]))
            {
                continue;
            }

            var score = Overlap(responseTokens, _poolTokens[index]);

            if (score > bestScore)
            {
                bestScore = score;
                best = index;
            }
        }

        return best < 0 ? ParticipantTurn.Complete : ParticipantTurn.Next(_pool[best], TurnProvenance.Synthesized);
    }

    /// <summary>How many of a candidate's distinct tokens the response also used.</summary>
    private static int Overlap(HashSet<string> responseTokens, HashSet<string> candidateTokens)
    {
        if (responseTokens.Count == 0)
        {
            return 0;
        }

        var score = 0;

        foreach (var token in candidateTokens)
        {
            if (responseTokens.Contains(token))
            {
                score++;
            }
        }

        return score;
    }

    /// <summary>
    /// Splits text into distinct comparison tokens.
    /// </summary>
    /// <remarks>
    /// Runs of letters and digits are tokens and everything else separates them, so punctuation
    /// cannot stop <c>number?</c> matching <c>number</c>. Folding is
    /// <see cref="string.ToLowerInvariant"/> rather than a culture-sensitive lower-casing,
    /// because a selection that depended on the ambient culture would not be reproducible across
    /// machines — the defect would surface as a scenario that grades differently on a build agent
    /// than on a developer's box. Case-folding is right <i>here</i> and wrong in an evaluator:
    /// this picks which line to say next, where a loose match is a feature, whereas an assertion
    /// decides a verdict and stays ordinal and case-sensitive.
    /// </remarks>
    private static HashSet<string> Tokenize(string? text)
    {
        var tokens = new HashSet<string>(StringComparer.Ordinal);

        if (string.IsNullOrWhiteSpace(text))
        {
            return tokens;
        }

        var start = -1;

        for (var index = 0; index <= text.Length; index++)
        {
            if (index < text.Length && char.IsLetterOrDigit(text[index]))
            {
                start = start < 0 ? index : start;
                continue;
            }

            if (start >= 0)
            {
                tokens.Add(text[start..index].ToLowerInvariant());
                start = -1;
            }
        }

        return tokens;
    }
}
