using System.Collections.Frozen;
using System.Globalization;
using System.Text.Json;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Paths;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Statistics;

namespace Forge.EvalEngine.Coordination;

/// <summary>
/// How a <see cref="RunCoordinator"/> conducts a suite, and what it may write into the artifact.
/// </summary>
/// <remarks>
/// A suite result is committed, diffed, and attached to pull requests, so the defaults here are
/// the conservative ones and a caller asks for more explicitly (§V).
/// </remarks>
public sealed record RunCoordinatorOptions
{
    private readonly int _maxConcurrency = 1;
    private readonly int _maxTotalRuns = DefaultMaxTotalRuns;
    private readonly ScenarioAggregator _aggregator = ScenarioAggregator.Default;
    private readonly IReadOnlyDictionary<string, string> _harnessConfig = FrozenDictionary<string, string>.Empty;

    /// <summary>The run budget a caller gets without asking for one.</summary>
    private const int DefaultMaxTotalRuns = 100_000;

    /// <summary>Gets the conservative defaults every constructor overload uses.</summary>
    public static RunCoordinatorOptions Default { get; } = new();

    /// <summary>
    /// Gets the greatest number of runs that may be in flight at once. One by default.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>This is a hard ceiling, not a target.</b> The coordinator is frequently pointed at a
    /// system somebody else operates, and it is also the lever for deliberately exercising that
    /// system's own throttling — a suite that asserts on a 429 is asserting about the load this
    /// number produced. A ceiling that was approximate would make both of those dishonest, so the
    /// count of in-flight runs never exceeds it.
    /// </para>
    /// <para>
    /// The default of one is deliberate. Concurrency against a real system is a decision with
    /// consequences for whoever runs it, so it is opted into rather than inherited.
    /// </para>
    /// </remarks>
    /// <exception cref="ArgumentOutOfRangeException">The value is less than one.</exception>
    public int MaxConcurrency
    {
        get => _maxConcurrency;
        init
        {
            ArgumentOutOfRangeException.ThrowIfLessThan(value, 1);

            _maxConcurrency = value;
        }
    }

    /// <summary>
    /// Gets the greatest number of runs a whole suite may plan. One hundred thousand by default.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A repetition count only has to be positive to be valid, so a suite may legitimately
    /// declare <see cref="int.MaxValue"/> of them. The plan — a results array per scenario and
    /// one entry per run — is built before anything is dispatched, so a count that large
    /// exhausts memory during planning rather than failing as a run that did not happen. A
    /// budget checked <b>before</b> each allocation turns that into a stated refusal (§IV, §V).
    /// </para>
    /// <para>
    /// The default is high enough that no honest suite meets it and low enough that a typo in a
    /// repetition count is refused in constant time rather than taking the host down with it. A
    /// caller with a genuinely larger suite raises it deliberately, which is the same shape as
    /// <see cref="MaxConcurrency"/>: the consequential number is opted into.
    /// </para>
    /// </remarks>
    /// <exception cref="ArgumentOutOfRangeException">The value is less than one.</exception>
    public int MaxTotalRuns
    {
        get => _maxTotalRuns;
        init
        {
            ArgumentOutOfRangeException.ThrowIfLessThan(value, 1);

            _maxTotalRuns = value;
        }
    }

    /// <summary>
    /// Gets the address the suite was run against, recorded in the artifact so a reader can tell
    /// what was evaluated. Optional.
    /// </summary>
    /// <remarks>
    /// Stripped of its userinfo, query, and fragment before it is recorded, by the same single
    /// implementation every runner uses for the endpoints it resolves itself. A query string is
    /// where a bearer token or a SAS signature usually lives and an OAuth fragment carries an
    /// access token by design, so neither survives into a committed artifact (§V).
    /// </remarks>
    public string? Endpoint { get; init; }

    /// <summary>
    /// Gets the verdict-bearing harness settings that this layer cannot see. Empty by default.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>A verdict is only meaningful relative to the configuration that produced it.</b>
    /// <see cref="Results.EvaluationEnvironment.HarnessConfig"/> is what
    /// <see cref="Comparison.SuiteComparator"/> refuses two unlike runs on, so a verdict-bearing
    /// setting that never reaches it is a setting two runs may silently disagree about while a
    /// delta between them is reported as the change's doing.
    /// </para>
    /// <para>
    /// The coordinator records what it can see — its throttle and its interval parameters.
    /// Transport timeouts, model temperature and sampling parameters, and adapter strictness are
    /// configured on <see cref="Abstractions.IScenarioRunner"/> and
    /// <see cref="Abstractions.IParticipantFactory"/> implementations it holds only as
    /// interfaces, and each of those changes what a run observes. A composition root knows them,
    /// so it states them here and they travel into the artifact beside the settings this layer
    /// owns.
    /// </para>
    /// <para>
    /// <b>The keys the coordinator writes itself are not settable here.</b> Two sources of truth
    /// for one setting is the defect this surface exists to close, so a caller that names one is
    /// refused at construction rather than silently overwritten at write time. A caller whose
    /// setting genuinely is the throttle should set <see cref="MaxConcurrency"/>.
    /// </para>
    /// <para>
    /// Validated and copied on assignment (§V): this is caller-supplied text bound for a
    /// committed, published artifact, and a live reference to a caller's dictionary would let
    /// what the artifact says the run was conducted under change after the run it describes.
    /// </para>
    /// </remarks>
    /// <exception cref="ArgumentNullException">The value is null.</exception>
    /// <exception cref="ArgumentException">
    /// An entry names a setting the coordinator records itself, or carries a null or blank key,
    /// or carries a null value.
    /// </exception>
    public IReadOnlyDictionary<string, string> HarnessConfig
    {
        get => _harnessConfig;
        init => _harnessConfig = Validated(value);
    }

    /// <summary>
    /// The harness settings the coordinator writes itself, which a caller may not also declare.
    /// </summary>
    /// <remarks>
    /// Derived from <see cref="OwnSettings"/> rather than listed beside it. Two magic lists that
    /// must agree and are never checked against each other is how a reserved key quietly stops
    /// being reserved — so there is one list, and adding a setting to the composition below
    /// reserves it by construction.
    /// </remarks>
    internal static IReadOnlySet<string> ReservedSettings { get; } =
        new HashSet<string>(Compose(1, ScenarioAggregator.Default).Keys, StringComparer.Ordinal);

    /// <summary>The settings this layer records, from the configuration actually in force.</summary>
    /// <param name="runners">
    /// The runners the suite will be conducted through, each of which attests the settings the
    /// coordinator cannot see. Namespaced by kind, so one runner cannot overwrite another's.
    /// </param>
    /// <param name="participants">
    /// The factory building this run's callers, which attests what it and they change about the
    /// stimulus sent.
    /// </param>
    /// <remarks>
    /// Each attestation is validated as it is read: this value travels verbatim into a committed,
    /// published artifact, and it comes from an injected collaborator rather than from this
    /// library. The refusals name the seam — a <see cref="ScenarioKind"/> this library declares,
    /// or a fixed phrase — and never the key or the value, which are the seam's own text.
    /// </remarks>
    /// <exception cref="ArgumentException">
    /// A seam attests no map, a null or blank key, a null value, or a machine path.
    /// </exception>
    internal IReadOnlyDictionary<string, string> OwnSettings(
        IEnumerable<IScenarioRunner> runners,
        IParticipantFactory participants
    )
    {
        var settings = Compose(MaxConcurrency, Aggregator);

        foreach (var runner in runners)
        {
            Collect(
                settings,
                runner.VerdictBearingSettings,
                RunnerNamespace(runner.Kind),
                RunnerSetting(runner.Kind, string.Empty)
            );
        }

        Collect(settings, participants.VerdictBearingSettings, ParticipantSource, ParticipantPrefix);

        return settings;
    }

    /// <summary>Validates one seam's attestation and namespaces it into the artifact's map.</summary>
    private static void Collect(
        Dictionary<string, string> settings,
        IReadOnlyDictionary<string, string>? attested,
        string source,
        string prefix
    )
    {
        if (attested is null)
        {
            throw Unusable(source, "attests no settings map at all; return an empty one instead");
        }

        foreach (var setting in attested)
        {
            if (string.IsNullOrWhiteSpace(setting.Key))
            {
                throw Unusable(source, "attests a setting with no name");
            }

            if (setting.Value is null)
            {
                throw Unusable(source, "attests a setting with no value");
            }

            if (MachinePath.IsPresentIn(setting.Key) || MachinePath.IsPresentIn(setting.Value))
            {
                throw Unusable(
                    source,
                    "attests a setting naming a machine path, which would disclose the account a job runs as and "
                        + "the layout of the machine it runs on in a committed, published artifact"
                );
            }

            settings[prefix + setting.Key] = setting.Value;
        }
    }

    /// <summary>
    /// A refusal naming the seam and the rule, never its text.
    /// </summary>
    /// <remarks>
    /// The seam is named by a <see cref="ScenarioKind"/> this library declares, or by a fixed
    /// phrase. The attested key and value are the implementation's own and reach the build log,
    /// so they are described rather than quoted (§V, ADR 0005).
    /// </remarks>
    private static ArgumentException Unusable(string source, string what, string paramName = "runners") =>
        new(
            $"{source} {what}. What a seam attests is written verbatim into a committed artifact and is what a "
                + "comparison refuses two unlike runs on, so it is refused before anything is dispatched rather "
                + "than after a whole suite's evidence exists. The offending text is not repeated here, because "
                + "it is the implementation's own and this message reaches the build log.",
            paramName
        );

    private static string RunnerNamespace(ScenarioKind kind) =>
        $"The runner registered for '{JsonNamingPolicy.CamelCase.ConvertName(kind.ToString())}' scenarios";

    /// <summary>How a refusal names the participant seam, which has no kind to name.</summary>
    private const string ParticipantSource = "The participant factory";

    /// <summary>
    /// The namespace the coordinator writes participant-attested settings under.
    /// </summary>
    /// <remarks>
    /// Flat rather than keyed by type. There is exactly one <see cref="IParticipantFactory"/> per
    /// run, and keying by its type would make two artifacts incomparable for swapping an
    /// implementation that attests the same thing.
    /// </remarks>
    internal const string ParticipantPrefix = "participants.";

    /// <summary>The artifact key one runner's setting is recorded under.</summary>
    /// <remarks>
    /// Namespaced by kind rather than by runner type: the type is an implementation detail that a
    /// composition root may swap, and two artifacts produced by different implementations of the
    /// same kind should still be comparable on what they attest.
    /// </remarks>
    internal static string RunnerSetting(ScenarioKind kind, string key) =>
        $"{RunnerPrefix}{JsonNamingPolicy.CamelCase.ConvertName(kind.ToString())}.{key}";

    /// <summary>The namespace the coordinator writes runner-attested settings under.</summary>
    internal const string RunnerPrefix = "runner.";

    private static Dictionary<string, string> Compose(int maxConcurrency, ScenarioAggregator aggregator) =>
        new(StringComparer.Ordinal)
        {
            // The throttle changes what a run against a rate-limited system observes, so a
            // reader trying to reproduce the run needs the figure it ran under.
            ["maxConcurrency"] = maxConcurrency.ToString(CultureInfo.InvariantCulture),

            // An interval is uninterpretable without the confidence level it was computed at,
            // and ConfidenceInterval has nowhere to carry one — adding a member would churn a
            // schema T3 deliberately fixed in advance. It goes here instead, named the same way
            // the artifact names the method itself so the two read as one setting.
            ["intervalMethod"] = JsonNamingPolicy.CamelCase.ConvertName(aggregator.IntervalMethod.ToString()),
            ["intervalConfidence"] = aggregator.ConfidenceLevel.ToString(CultureInfo.InvariantCulture),

            // The scheme a run's seeds were derived under. An artifact written before seeds were
            // derived from a scenario's identity carries no such key, so the comparison refuses
            // it by name rather than pairing it and reporting every scenario not-comparable as
            // its per-repetition seeds fail to line up — a refusal a reader can act on instead of
            // a suite-wide silence that reads like nothing changed.
            ["seedDerivation"] = "scenarioId",
        };

    private static FrozenDictionary<string, string> Validated(IReadOnlyDictionary<string, string> value)
    {
        ArgumentNullException.ThrowIfNull(value);

        var copy = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var setting in value)
        {
            if (string.IsNullOrWhiteSpace(setting.Key))
            {
                throw new ArgumentException(
                    "A harness setting must be named. A blank key is written into a committed artifact and "
                        + "compared against a baseline's, so a reader could neither reproduce the run from it nor "
                        + "tell which setting two runs disagreed about.",
                    nameof(value)
                );
            }

            // The key is not named here. It is caller-supplied, it may itself be the machine path
            // the artifact guard refuses, and this message reaches the build log — so the refusal
            // states the rule rather than the value (§V, ADR 0005). A caller reading it knows
            // which map it handed over; naming the entry would move a disclosure, not remove one.
            if (setting.Value is null)
            {
                throw new ArgumentException(
                    "A harness setting carries no value. The artifact's shape declares that these values are "
                        + "never null, so writing one would produce a file this engine then refuses to read. The "
                        + "offending key is not repeated here, because it is caller-supplied text and this message "
                        + "reaches the build log.",
                    nameof(value)
                );
            }

            // Split deliberately. An *exactly* matching reserved key is a value this library
            // chose, so quoting it back discloses nothing the caller did not read out of this
            // type. A *prefix* match says only that the first seven characters are ours — the
            // suffix after 'runner.' is entirely caller-supplied and may itself be the machine
            // path the artifact guard refuses, so it is described rather than quoted (§V,
            // ADR 0005). Fixing the null-value echo beside this one and then introducing the
            // same disclosure here is the trap: new code written under a fresh understanding of
            // a defect feels immune and is not.
            if (
                ReservedSettings.Contains(setting.Key)
                || setting.Key.StartsWith(RunnerPrefix, StringComparison.Ordinal)
                || setting.Key.StartsWith(ParticipantPrefix, StringComparison.Ordinal)
            )
            {
                // Named only when it matches a reserved key exactly, which is a value this
                // library chose. A prefix match says only that the first characters are ours —
                // the suffix is caller-supplied and may itself be the machine path the artifact
                // guard refuses, so it is described rather than quoted.
                throw ReservedSettings.Contains(setting.Key)
                    ? new ArgumentException(
                        $"Harness setting '{setting.Key}' is recorded by the coordinator from the configuration it "
                            + "actually ran under, so it cannot also be declared here. Two sources of truth for one "
                            + "setting is the failure this surface exists to prevent: a caller stating a figure the "
                            + "run did not use would put it in a committed artifact and into the comparison that "
                            + "refuses unlike runs.",
                        nameof(value)
                    )
                    : new ArgumentException(
                        $"A harness setting is named under '{RunnerPrefix}' or '{ParticipantPrefix}', which the "
                            + $"coordinator writes from what each {nameof(IScenarioRunner)} and the "
                            + $"{nameof(IParticipantFactory)} attest, so it cannot also be declared here. Two "
                            + "sources of truth for one setting is the failure this surface exists to prevent. The "
                            + "offending key is not repeated: only its prefix is this library's, and the rest is "
                            + "caller-supplied text that reaches the build log.",
                        nameof(value)
                    );
            }

            if (MachinePath.IsPresentIn(setting.Key) || MachinePath.IsPresentIn(setting.Value))
            {
                throw new ArgumentException(
                    "A harness setting names a machine path, in its key or its value. That value discloses the "
                        + "account a job runs as and the layout of the machine it runs on; it would be written "
                        + "into a committed, published artifact and quoted back by the comparison that refuses two "
                        + "runs disagreeing on it. The offending text is not repeated here, because this message "
                        + "reaches the build log.",
                    nameof(value)
                );
            }

            copy[setting.Key] = setting.Value;
        }

        // Frozen, not merely copied. The previous shape validated the input and handed the
        // validated store back as IReadOnlyDictionary — an interface, not a guarantee — so a
        // caller could cast the getter's result to IDictionary and edit what had been validated,
        // including on the shared Default for every later run in the process. An immutable
        // snapshot removes the thing to cast to rather than asking callers not to (§IV).
        return copy.ToFrozenDictionary(StringComparer.Ordinal);
    }

    /// <summary>
    /// Gets how a scenario's repetitions are collapsed into a
    /// <see cref="Results.StatisticalSummary"/>. A Wilson interval at 95% confidence by default.
    /// </summary>
    /// <remarks>
    /// The confidence level and the interval method are reporting choices rather than execution
    /// ones, so they live here instead of growing the coordinator a set of statistics knobs.
    /// Whatever is configured is recorded in
    /// <see cref="Results.EvaluationEnvironment.HarnessConfig"/>: an interval without the level
    /// it was computed at is not interpretable, and <see cref="Results.ConfidenceInterval"/> has
    /// no room to carry one.
    /// </remarks>
    /// <exception cref="ArgumentNullException">The value is null.</exception>
    public ScenarioAggregator Aggregator
    {
        get => _aggregator;
        init
        {
            ArgumentNullException.ThrowIfNull(value);

            _aggregator = value;
        }
    }
}
