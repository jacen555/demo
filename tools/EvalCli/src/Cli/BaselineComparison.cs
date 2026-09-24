using Forge.EvalCli.Composition;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Baselines;
using Forge.EvalEngine.Comparison;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;
using Microsoft.Extensions.DependencyInjection;

namespace Forge.EvalCli.Cli;

/// <summary>Which mechanism supplied the baseline a candidate was compared against.</summary>
internal enum BaselineMechanism
{
    /// <summary>No baseline was named, so no comparison was attempted.</summary>
    None,

    /// <summary>A committed <see cref="SuiteResult"/> artifact, read through <see cref="ArtifactBaseline"/>.</summary>
    Artifact,

    /// <summary>A run of the same suite against a baseline address, through <see cref="LiveEndpointBaseline"/>.</summary>
    LiveEndpoint,
}

/// <summary>
/// A comparison that actually happened, with the provenance a reader needs to trust it.
/// </summary>
/// <remarks>
/// A refusal is never one of these. <see cref="BaselineComparison"/> throws for a comparison that
/// could not honestly be made, because an outcome object carrying "refused" would be rendered
/// beside the ones carrying counts, and a reader skimming "0 regressed" cannot tell a clean
/// comparison from one that never happened.
/// </remarks>
internal sealed record ComparisonOutcome
{
    /// <summary>Gets which mechanism supplied the baseline.</summary>
    public required BaselineMechanism Mechanism { get; init; }

    /// <summary>Gets the reference the baseline came from — a path, or a redacted address.</summary>
    public required string Reference { get; init; }

    /// <summary>Gets what the comparator found.</summary>
    public required ComparisonResult Result { get; init; }

    /// <summary>
    /// Gets the scenarios withheld from the comparison because this run did not conduct them.
    /// </summary>
    /// <remarks>
    /// Reported rather than dropped. These are not
    /// <see cref="ScenarioClassification.Removed"/> and they are not unchanged: this run produced
    /// no candidate evidence about them at all, and a report that stayed silent would let a
    /// reader believe the whole suite had been re-examined.
    /// </remarks>
    public IReadOnlyList<string> WithheldScenarios { get; init; } = [];

    /// <summary>
    /// Gets the scenarios this run conducted only partly — at least one repetition errored.
    /// </summary>
    /// <remarks>
    /// <b>Carried because the comparison cannot see it.</b> A scenario's outcome is drawn from
    /// the repetitions that produced a verdict, so one that passed once and errored once measures
    /// as passing — correctly, as far as the graded evidence goes. What that evidence does not
    /// support is the stronger claim the headline makes: that the change <i>covers</i> the
    /// scenario. The suite asked for a number of repetitions and got fewer, so what this change
    /// covers there is unknown rather than gained. Read from the candidate artifact, which is the
    /// only place the errored repetitions survive.
    /// </remarks>
    public IReadOnlyList<string> PartiallyConductedScenarios { get; init; } = [];
}

/// <summary>
/// Pairs a candidate with a baseline and diffs them — or refuses.
/// </summary>
/// <remarks>
/// <para>
/// <b>The failure this stage exists to prevent is comparing the wrong pair.</b> The engine
/// already refuses a mismatched definition fingerprint, a differing harness config, a differing
/// root seed, and a foreign-suite baseline. None of that helps if this layer hands it two
/// artifacts that should never have been put beside each other in the first place, so the pairing
/// decisions are made here and stated:
/// </para>
/// <list type="bullet">
/// <item><description>
/// <b>A scenario this run did not conduct is withheld from the baseline</b>, not compared. A
/// narrowed run produces a candidate carrying only the selected scenarios; handing the comparator
/// the whole baseline would classify every skipped scenario as
/// <see cref="ScenarioClassification.Removed"/> — a confident claim about a change nobody made.
/// A scenario the <i>suite</i> no longer declares is a different thing and is left in, because
/// that one really was removed.
/// </description></item>
/// <item><description>
/// <b>A pair that could not be compared is a refusal, not a clean result.</b> A pair coming back
/// <see cref="ScenarioClassification.NotComparable"/> would otherwise render as "0 regressed, 0
/// newly covered" for that scenario and exit zero — a green check over an unexamined change,
/// which is the worst thing this tool can produce. That is true of one such pair among many, not
/// only of a run where every pair is refused.
/// </description></item>
/// </list>
/// <para>
/// The other half of the pairing is made earlier, in <see cref="RunPlan"/>, where two references
/// that would compare a suite against itself are refused before anything runs.
/// </para>
/// </remarks>
internal static class BaselineComparison
{
    /// <summary>
    /// What to tell a user whose baseline cannot be compared against the current suite.
    /// </summary>
    /// <remarks>
    /// <b>Regenerate, never hand-edit.</b> The fingerprint is what establishes that both sides
    /// were run against the same definition; editing one to make a comparison succeed defeats
    /// precisely the guard that stops a redefinition being reported as a fix the change earned.
    /// Stated in one place so every path that reports a refusal says the same thing.
    /// </remarks>
    internal const string RegenerateRemedy =
        "Regenerate the baseline from a run of the current suite — `eval-cli baseline update --apply`, or a fresh "
        + "`eval-cli run --out`. Never edit a baseline by hand to make a comparison succeed: the fingerprint is "
        + "what proves both sides were run against the same definition, and editing it would turn a redefinition "
        + "into a fix the change did not earn.";

    /// <summary>Compares the candidate against whichever baseline the plan named.</summary>
    /// <param name="provider">The composition root, for the comparator and the live provider.</param>
    /// <param name="plan">The validated plan.</param>
    /// <param name="conducted">The suite as conducted — already narrowed to the selected scenarios.</param>
    /// <param name="skipped">The scenarios the selector chose not to conduct.</param>
    /// <param name="candidate">The artifact this run produced.</param>
    /// <param name="artifactBaseline">
    /// The baseline already read for selection, when <c>--baseline</c> named one. Reused rather
    /// than read again: a second read is a second file, and the two could differ.
    /// </param>
    /// <param name="cancellationToken">Cancels the comparison, including a live baseline run.</param>
    /// <returns>The comparison, or null when no baseline was named.</returns>
    /// <exception cref="ArgumentNullException">Any required argument is null.</exception>
    /// <exception cref="EvalCliException">The comparison was refused.</exception>
    /// <exception cref="OperationCanceledException"><paramref name="cancellationToken"/> was cancelled.</exception>
    public static async Task<ComparisonOutcome?> CompareAsync(
        IServiceProvider provider,
        RunPlan plan,
        Suite conducted,
        IReadOnlyList<string> skipped,
        SuiteResult candidate,
        SuiteResult? artifactBaseline,
        CancellationToken cancellationToken
    )
    {
        ArgumentNullException.ThrowIfNull(provider);
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(conducted);
        ArgumentNullException.ThrowIfNull(skipped);
        ArgumentNullException.ThrowIfNull(candidate);

        cancellationToken.ThrowIfCancellationRequested();

        var (mechanism, reference, baseline, withheld) = plan.BaselineEndpoint is not null
            ? await LiveAsync(provider, plan, conducted, cancellationToken).ConfigureAwait(false)
            : Artifact(plan, artifactBaseline, skipped);

        if (mechanism is BaselineMechanism.None || baseline is null)
        {
            return null;
        }

        var comparison = Compare(provider.GetRequiredService<SuiteComparator>(), baseline, candidate, reference, plan);

        RequireEveryPairWasCompared(comparison, reference);

        return new ComparisonOutcome
        {
            Mechanism = mechanism,
            Reference = reference,
            Result = comparison,
            WithheldScenarios = withheld,
            PartiallyConductedScenarios = PartlyConducted(candidate),
        };
    }

    /// <summary>The scenarios whose repetitions were not all conducted.</summary>
    /// <param name="result">The artifact to read.</param>
    /// <returns>The scenario ids, in artifact order.</returns>
    /// <remarks>
    /// <see cref="RunStatus.Error"/> means the harness could not ask the question for that
    /// repetition — the same line <see cref="RunReport.HarnessFailed"/> draws for the exit code,
    /// read per scenario rather than over the suite.
    /// </remarks>
    /// <exception cref="ArgumentNullException"><paramref name="result"/> is null.</exception>
    internal static IReadOnlyList<string> PartlyConducted(SuiteResult result)
    {
        ArgumentNullException.ThrowIfNull(result);

        return
        [
            .. result
                .ScenarioResults.Where(scenario => scenario.Runs.Any(run => run.Status is RunStatus.Error))
                .Select(scenario => scenario.ScenarioId),
        ];
    }

    /// <summary>Runs the comparator, turning its refusals into this tool's vocabulary.</summary>
    /// <remarks>
    /// <see cref="ComparisonRefusedException"/> already reaches the right exit code through
    /// <see cref="ExitCodeReporter"/>. It is caught anyway, because the code alone does not tell a
    /// user what to do, and for every divergence the comparator names the answer is the same one:
    /// regenerate the baseline rather than edit it.
    /// </remarks>
    private static ComparisonResult Compare(
        SuiteComparator comparator,
        SuiteResult baseline,
        SuiteResult candidate,
        string reference,
        RunPlan plan
    )
    {
        try
        {
            return comparator.Compare(baseline, candidate, CancellationToken.None);
        }
        catch (ComparisonRefusedException refusal)
        {
            throw new EvalCliException(
                ExitCode.ComparisonRefused,
                $"The candidate could not be compared against the baseline at {reference}: {refusal.Message}",
                Remedy(refusal, plan)
            );
        }
        catch (ArgumentException malformed)
        {
            // An artifact whose own structure disagrees — a duplicated scenario id, a run filed
            // under the wrong scenario, a pass recorded beside an assertion that did not hold.
            // Refused rather than partly read: whichever entry this happened to reach first
            // would decide the verdict.
            throw new EvalCliException(
                ExitCode.ComparisonRefused,
                $"The baseline at {reference} is not internally consistent, so nothing was compared against it: "
                    + malformed.Message,
                RegenerateRemedy
            );
        }
    }

    /// <summary>What to do about a whole-artifact refusal, by the property that diverged.</summary>
    private static string Remedy(ComparisonRefusedException refusal, RunPlan plan) =>
        refusal.Property switch
        {
            "suiteName" =>
                "Nothing was compared. The baseline is a run of a different suite, which almost always means the "
                    + "wrong artifact was named rather than that anything regressed — check the path before doing "
                    + "anything else.",
            "seed" => "Nothing was compared. The comparison is paired by seed, so re-run with --seed set to the figure "
                + $"the baseline was driven from (this run used {plan.RootSeed.ToString(System.Globalization.CultureInfo.InvariantCulture)}), "
                + "or regenerate the baseline under the seed you want to keep.",
            _ => "Nothing was compared. The two runs were conducted under different harness settings, so a delta "
                + "between them would measure the harness rather than the change. Re-run with the settings the "
                + "baseline records, or regenerate the baseline under the current ones.",
        };

    /// <summary>
    /// Refuses a comparison in which any available pair could not actually be compared.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>This is the false green this stage exists for, and it is not confined to the total
    /// case.</b> A baseline written before the engine recorded a definition fingerprint compares
    /// as <see cref="ScenarioClassification.NotComparable"/> on every scenario — which is correct,
    /// the two runs genuinely cannot be shown to have been conducted against the same
    /// definitions. Reported as counts that reads "0 regressed, 0 newly covered", which is
    /// indistinguishable from a change that broke nothing.
    /// </para>
    /// <para>
    /// <b>One such scenario is the same failure at a smaller scale, and the smaller scale is the
    /// dangerous one.</b> A run where nine of ten pairs are refused still reports nine zeroes
    /// beside one real comparison, and a reader who sees any green at all stops reading. Every
    /// refused pair is a scenario about which this run says nothing, so the refusal is per pair
    /// rather than per suite — and the message says how much of the suite <i>did</i> compare, so
    /// the refusal is not itself read as covering everything.
    /// </para>
    /// <para>
    /// <b>Zero pairs is not the same as zero comparable pairs.</b> A run that conducted nothing,
    /// or one whose scenarios are all new, offers the comparator no pair to refuse and has
    /// nothing to report — that is an honest empty result, not a refusal, so it is left alone.
    /// </para>
    /// <para>
    /// <b>Fatal here and deliberately not in <c>baseline update</c>.</b> Regenerating a baseline
    /// is what clears a stale fingerprint, and refusing there would leave a user unable to fix
    /// the thing the refusal complained about. That command runs its own comparison for the
    /// preview and never reaches this.
    /// </para>
    /// </remarks>
    private static void RequireEveryPairWasCompared(ComparisonResult comparison, string reference)
    {
        var pairs = comparison
            .ScenarioComparisons.Where(scenario =>
                scenario.Classification is not ScenarioClassification.New and not ScenarioClassification.Removed
            )
            .ToArray();

        var refused = pairs
            .Where(scenario => scenario.Classification == ScenarioClassification.NotComparable)
            .ToArray();

        if (refused.Length == 0)
        {
            return;
        }

        var compared = pairs.Length - refused.Length;
        var reasons = string.Join(
            System.Environment.NewLine + "          ",
            refused.Select(scenario => $"{scenario.ScenarioId}: {ComparisonReport.Refusal(scenario)}.")
        );

        throw new EvalCliException(
            ExitCode.ComparisonRefused,
            $"{Render(refused.Length)} of {Render(pairs.Length)} scenario(s) could not be compared against the "
                + $"baseline at {reference}, so this run says nothing about whether the change helped or hurt them "
                + $"({Render(compared)} of {Render(pairs.Length)} did compare)."
                + $"{System.Environment.NewLine}          {reasons}",
            "Reported as a refusal rather than as no regressions found, because those scenarios were not examined "
                + "and a count of zero beside them reads as agreement. "
                + RegenerateRemedy
        );
    }

    private static string Render(int value) => value.ToString(System.Globalization.CultureInfo.InvariantCulture);

    /// <summary>
    /// Prepares the committed baseline for a comparison against what this run actually conducted.
    /// </summary>
    /// <remarks>
    /// See the type's remarks for why the skipped scenarios are withheld rather than compared.
    /// The withholding is keyed on the selector's own skipped list, not on "absent from the
    /// candidate", so a scenario that the suite still declares and the run genuinely failed to
    /// produce would not be quietly excused.
    /// </remarks>
    private static (
        BaselineMechanism Mechanism,
        string Reference,
        SuiteResult? Baseline,
        IReadOnlyList<string> Withheld
    ) Artifact(RunPlan plan, SuiteResult? baseline, IReadOnlyList<string> skipped)
    {
        if (plan.BaselinePath is not { } reference || baseline is null)
        {
            return (BaselineMechanism.None, string.Empty, null, []);
        }

        if (skipped.Count == 0)
        {
            return (BaselineMechanism.Artifact, reference, baseline, []);
        }

        var withheld = skipped.ToHashSet(StringComparer.Ordinal);
        var carried = baseline
            .ScenarioResults.Where(scenario => withheld.Contains(scenario.ScenarioId))
            .Select(scenario => scenario.ScenarioId)
            .ToArray();

        return (
            BaselineMechanism.Artifact,
            reference,
            baseline with
            {
                ScenarioResults =
                [
                    .. baseline.ScenarioResults.Where(scenario => !withheld.Contains(scenario.ScenarioId)),
                ],
            },
            carried
        );
    }

    /// <summary>Conducts the suite against the baseline address and uses that as the baseline.</summary>
    /// <remarks>
    /// <para>
    /// The suite handed over is the one this run <i>conducted</i>, not the one it declared, so
    /// both sides exercise exactly the same scenarios and there is nothing to withhold.
    /// </para>
    /// <para>
    /// <see cref="LiveEndpointBaseline"/> never answers "there is no baseline" — running a suite
    /// always produces an artifact — but it is reached through <see cref="IBaselineProvider"/>,
    /// whose contract permits null, and a null flowing on from here would read downstream as
    /// nothing to compare. It is treated as a missing baseline rather than as no comparison.
    /// </para>
    /// </remarks>
    private static async Task<(
        BaselineMechanism Mechanism,
        string Reference,
        SuiteResult? Baseline,
        IReadOnlyList<string> Withheld
    )> LiveAsync(IServiceProvider provider, RunPlan plan, Suite conducted, CancellationToken cancellationToken)
    {
        var endpoint = plan.BaselineEndpoint!;
        var reference = plan.BaselineEndpointDisplay!;
        var coordinators = provider.GetRequiredService<BaselineEndpointCoordinators>();
        var live = new LiveEndpointBaseline(conducted, coordinators.ForEndpoint);

        SuiteResult? baseline;

        try
        {
            baseline = await live.TryGetBaselineAsync(endpoint.ToString(), cancellationToken).ConfigureAwait(false);
        }
        catch (ArgumentException refusal)
        {
            // The engine owns this rule and states it in full; the CLI refuses the same shapes at
            // argument time so it costs nothing. Reaching here means a shape this build did not
            // anticipate, so the engine's own words are reported rather than a guess at them.
            throw new EvalCliException(
                ExitCode.UsageError,
                $"--baseline-endpoint was refused: {EndpointGuard.RedactAddresses(refusal.Message)}",
                EndpointGuard.DeploymentSelectorRemedy
            );
        }
        catch (InvalidOperationException mismatch)
        {
            // The coordinator recorded, or its runs dialled, somewhere other than the address
            // this baseline was asked for. Refused rather than compared against: an artifact
            // describing a different system attributes that system's behaviour to this one.
            //
            // The engine names the addresses it was checking, correctly — a caller has to know
            // which one could not be confirmed — but it names them in full, and the path is where
            // a token lives. Forwarded through the redactor rather than verbatim, because this
            // message goes to standard error (§V).
            throw new EvalCliException(
                ExitCode.ComparisonRefused,
                $"The baseline run against {reference} could not be confirmed to have reached it: "
                    + EndpointGuard.RedactAddresses(mismatch.Message),
                "Nothing was compared. A baseline that cannot be shown to describe the system it was asked about "
                    + "is refused rather than trusted, because the delta would be attributed to the change under "
                    + "review."
            );
        }

        return baseline is null
            ? throw new EvalCliException(
                ExitCode.BaselineMissing,
                $"The baseline provider returned no artifact for {reference}, so there was nothing to compare "
                    + "against.",
                "No baseline is not the same as no regression, so this stops rather than reporting a clean "
                    + "comparison it never made."
            )
            : (BaselineMechanism.LiveEndpoint, reference, baseline, []);
    }
}
