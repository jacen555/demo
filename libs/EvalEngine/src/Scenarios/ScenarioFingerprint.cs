using System.Security.Cryptography;
using System.Text;
using Forge.EvalEngine.Serialization;

namespace Forge.EvalEngine.Scenarios;

/// <summary>
/// The canonical fingerprint of what a scenario actually asks and what it accepts as correct.
/// </summary>
/// <remarks>
/// <para>
/// A scenario id is a join key, and a join key says nothing about whether two artifacts mean the
/// same thing by it. The parts that decide whether a run passed are the <b>execution inputs</b> —
/// how the runner drives the scenario and what the simulated caller sends — and the <b>grading
/// expectations</b> — what a correct result looks like. Change either, and an unchanged system
/// produces a different verdict.
/// </para>
/// <para>
/// <b>Why the emitted assertion specs are not enough.</b> An assertion such as
/// <c>exactMatch:outcome</c> names what is checked, not what it is checked against: the value it
/// compares to lives in <see cref="Grading.ExpectedOutcome"/>. Editing that expectation while
/// leaving the spec alone turns an unchanged system response from a failure into a pass, and a
/// comparator that pairs on the specs alone reports it as a fix the change earned. This
/// fingerprint closes that gap by covering the expectations themselves.
/// </para>
/// <para>
/// <b>A hash, not the definition.</b> The value is a SHA-256 over the definition's canonical JSON
/// rather than the JSON itself, so the artifact carries a constant-size witness instead of a
/// second copy of the suite file. It is not a security boundary — a suite author who can change
/// the definition can change the fingerprint beside it — it is a witness that two artifacts were
/// produced from the same definition, which is the question the comparator has to answer.
/// </para>
/// </remarks>
public static class ScenarioFingerprint
{
    /// <summary>The prefix naming the digest, so a later change of algorithm is legible.</summary>
    private const string Algorithm = "sha256";

    /// <summary>Fingerprints the execution inputs and grading expectations of a scenario.</summary>
    /// <param name="scenario">The scenario definition the runs were produced from.</param>
    /// <returns>
    /// A stable, canonical fingerprint of the form <c>sha256:&lt;hex&gt;</c>. Two scenarios with
    /// equal execution, simulation, and grading produce the same value; a difference in any of
    /// them produces a different one.
    /// </returns>
    /// <remarks>
    /// <para>
    /// <see cref="ScenarioIdentity"/> is deliberately excluded: the id is the join key the
    /// fingerprint qualifies, and the labelling beside it — probe class, description, note — is
    /// read only by the reporter and changing it does not change what was asked.
    /// <see cref="Selection"/> and <see cref="Slicing"/> are excluded for the same reason: they
    /// decide whether a scenario runs and how its results are grouped, never how it is driven or
    /// graded.
    /// </para>
    /// <para>
    /// <b><see cref="ScenarioIdentity.Kind"/> is the exclusion with teeth, and every consumer
    /// owes it a second comparison.</b> The kind selects the runner, so two scenarios that
    /// differ only in it are driven against different systems while carrying an identical
    /// fingerprint. It is kept out of the digest rather than folded into it because the kind
    /// already travels in the artifact as <see cref="Results.ScenarioResult.Kind"/>, which is
    /// <b>required</b> where <see cref="Results.ScenarioResult.DefinitionFingerprint"/> is
    /// optional — checking it directly is both stronger and readable on artifacts written before
    /// fingerprinting existed, and folding it in would sever every comparison against every
    /// artifact already written for a check those artifacts can already answer.
    /// <see cref="Comparison.SuiteComparator"/> and <see cref="Impact.ImpactSelector"/> both
    /// compare it beside this value; anything else that pairs two scenarios on a fingerprint
    /// must do the same.
    /// </para>
    /// </remarks>
    /// <exception cref="ArgumentNullException"><paramref name="scenario"/> is null.</exception>
    public static string Of(Scenario scenario)
    {
        ArgumentNullException.ThrowIfNull(scenario);

        // Through CanonicalJson rather than the default serializer, so the digest is a function
        // of the definition's value and nothing else: keys are ordered at every level, unset
        // optionals are absent rather than null, and enums are their camel-case names. Without
        // that, re-ordering a property declaration would move every fingerprint in the suite and
        // sever every comparison in it.
        var canonical = CanonicalJson.Serialize(
            new Definition(scenario.Execution, scenario.Simulation, scenario.Grading)
        );

        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(canonical));

        return $"{Algorithm}:{Convert.ToHexStringLower(digest)}";
    }

    /// <summary>The parts of a scenario that decide what a run asked and how it was judged.</summary>
    private sealed record Definition(Execution Execution, Simulation Simulation, Grading Grading);
}
