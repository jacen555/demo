using System.Globalization;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Assertions.Evaluators;

/// <summary>
/// <c>structural</c> — the shape of what came back, independent of its values.
/// </summary>
/// <remarks>
/// <para>
/// Structure exists in two places in a kind-agnostic transcript, and this evaluator serves both
/// without knowing which kind produced them: the route
/// (<see cref="Transcripts.Outcome.ObservedPath"/>, a <c>/</c>-delimited hierarchy) and the turn
/// sequence itself.
/// </para>
/// <list type="table">
/// <listheader><term>Expression</term><description>Meaning</description></listheader>
/// <item><term><c>structural:pathPresent</c></term><description>A route was returned at all.</description></item>
/// <item><term><c>structural:pathDepth/3</c></term><description>The route declares at least three levels.</description></item>
/// <item><term><c>structural:levelsPopulated</c></term><description>Every declared level carries something.</description></item>
/// <item><term><c>structural:turnDepth/3</c></term><description>The exchange reached at least three turns.</description></item>
/// </list>
/// <para>
/// Polarity supplies the other half of each claim without a second selector:
/// <c>!structural:pathPresent</c> is "no route came back", and <c>!structural:pathDepth/5</c> is
/// "the structure did not run deeper than four levels" — depth the system would have had to
/// fabricate.
/// </para>
/// <para>
/// <b>Depth and populated-ness are deliberately separate.</b> A route of <c>a//b</c> declares
/// three levels and has an empty one, so it satisfies <c>pathDepth/3</c> and fails
/// <c>levelsPopulated</c>. Folding those together would make one of the two questions
/// unanswerable.
/// </para>
/// </remarks>
internal sealed class StructuralEvaluator : IAssertionEvaluator
{
    private const string PathPresentSelector = "pathPresent";
    private const string PathDepthSelector = "pathDepth";
    private const string LevelsPopulatedSelector = "levelsPopulated";
    private const string TurnDepthSelector = "turnDepth";

    private static readonly string[] KnownSelectors =
    [
        LevelsPopulatedSelector,
        PathDepthSelector,
        PathPresentSelector,
        TurnDepthSelector,
    ];

    public string Category => "structural";

    public AssertionCategory Family => AssertionCategory.Structural;

    public ValueTask<AssertionResult> EvaluateAsync(
        AssertionSpec spec,
        EvaluationContext context,
        CancellationToken cancellationToken
    )
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(spec);
        ArgumentNullException.ThrowIfNull(context);

        var parameter = EvaluationSupport.ReadParameter(spec, KnownSelectors);
        var transcript = context.Transcript;
        var path = transcript.Outcome.ObservedPath;

        var result = parameter.Selector switch
        {
            PathPresentSelector => JudgePathPresent(spec, parameter, transcript, path),
            LevelsPopulatedSelector => JudgeLevelsPopulated(spec, parameter, transcript, path),
            PathDepthSelector => JudgePathDepth(spec, parameter, transcript, path),
            TurnDepthSelector => JudgeTurnDepth(spec, parameter, EvaluationSupport.TurnsInScope(spec, transcript)),
            _ => throw EvaluationSupport.UnknownSelector(spec, parameter, KnownSelectors),
        };

        return new ValueTask<AssertionResult>(result);
    }

    /// <summary>The levels a route declares. A blank route declares none.</summary>
    private static string[] Levels(string? path) => string.IsNullOrWhiteSpace(path) ? [] : path.Split('/');

    private static AssertionResult JudgePathPresent(
        AssertionSpec spec,
        EvaluationParameter parameter,
        Transcript transcript,
        string? path
    )
    {
        EvaluationSupport.RequireNoOperand(spec, parameter);
        EvaluationSupport.RequireOutcomeWithinScope(spec, transcript);

        var holds = !string.IsNullOrWhiteSpace(path);

        return EvaluationSupport.Verdict(
            spec,
            holds,
            holds ? $"the run returned route {EvaluationSupport.Show(path)}" : "the run returned no route",
            EvaluationSupport.TurnTheRunEndedOn(transcript)
        );
    }

    private static AssertionResult JudgeLevelsPopulated(
        AssertionSpec spec,
        EvaluationParameter parameter,
        Transcript transcript,
        string? path
    )
    {
        EvaluationSupport.RequireNoOperand(spec, parameter);
        EvaluationSupport.RequireOutcomeWithinScope(spec, transcript);

        var levels = Levels(path);
        var holds = levels.Length > 0 && Array.TrueForAll(levels, level => !string.IsNullOrWhiteSpace(level));

        var evidence =
            levels.Length == 0
                ? "the run returned no route, so it has no populated levels"
                : $"route {EvaluationSupport.Show(path)} declares "
                    + $"{levels.Length.ToString(CultureInfo.InvariantCulture)} level(s), "
                    + $"{levels.Count(level => string.IsNullOrWhiteSpace(level)).ToString(CultureInfo.InvariantCulture)} of them blank";

        return EvaluationSupport.Verdict(spec, holds, evidence, EvaluationSupport.TurnTheRunEndedOn(transcript));
    }

    private static AssertionResult JudgePathDepth(
        AssertionSpec spec,
        EvaluationParameter parameter,
        Transcript transcript,
        string? path
    )
    {
        var required = EvaluationSupport.RequireCount(spec, parameter);
        EvaluationSupport.RequireOutcomeWithinScope(spec, transcript);

        var depth = Levels(path).Length;

        return EvaluationSupport.Verdict(
            spec,
            depth >= required,
            $"route {EvaluationSupport.Show(path)} reached depth "
                + $"{depth.ToString(CultureInfo.InvariantCulture)}; {required.ToString(CultureInfo.InvariantCulture)} was required",
            EvaluationSupport.TurnTheRunEndedOn(transcript)
        );
    }

    private static AssertionResult JudgeTurnDepth(
        AssertionSpec spec,
        EvaluationParameter parameter,
        IReadOnlyList<Turn> scope
    )
    {
        var required = EvaluationSupport.RequireCount(spec, parameter);
        var reached = scope.Count;

        return EvaluationSupport.Verdict(
            spec,
            reached >= required,
            $"the exchange reached {reached.ToString(CultureInfo.InvariantCulture)} turn(s); "
                + $"{required.ToString(CultureInfo.InvariantCulture)} was required",
            EvaluationSupport.EveryTurn(scope)
        );
    }
}
