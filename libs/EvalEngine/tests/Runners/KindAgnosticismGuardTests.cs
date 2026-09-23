using System.Text.Json.Nodes;
using FluentAssertions;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Runners;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Serialization;
using Forge.EvalEngine.Transcripts;

namespace Forge.EvalEngine.Tests.Runners;

/// <summary>
/// The invariant the whole engine rests on: <b>a REST call is the degenerate one-turn case of the
/// same pipeline, not a separate code path.</b>
/// </summary>
/// <remarks>
/// <para>
/// Every previous layer has been caught assuming an invariant the layer beneath did not hold. This
/// is the first round where kind-agnosticism is produced rather than merely declared, so it is
/// tested against transcripts the runner actually built — not against hand-written fixtures, which
/// would only prove that the test author believes the invariant.
/// </para>
/// <para>
/// The claim under test is precise. It is <i>not</i> that no evaluator can distinguish a one-turn
/// run from a three-turn one: <c>structural:turnDepth/3</c> measures exactly that, deliberately,
/// because a suite author asked it to. It is that nothing in the transcript <i>names the kind</i>,
/// that the two transcripts are the same shape, and that every assertion whose subject is the
/// evidence rather than the turn count reaches the same verdict through the same code path.
/// </para>
/// </remarks>
public sealed class KindAgnosticismGuardTests
{
    /// <summary>Assertions whose subject is the evidence, not the number of turns that produced it.</summary>
    private static readonly string[] Battery =
    [
        "exactMatch:outcome",
        "exactMatch:path",
        "structural:pathPresent",
        "structural:pathDepth/2",
        "structural:levelsPopulated",
        "!structural:pathDepth/5",
        "presence:anyResponse",
        "presence:field/scope/confirm",
        "!presence:field/nothing-like-this",
        "!presence:repeatedResponse",
        "expectedBehavior:outcome/resolved",
        "expectedBehavior:path/triage/resolve",
        "expectedBehavior:field/scope/confirm=yes",
        "expectedBehavior:transport/statusCode=200",
        "expectedBehavior:transport/exchange=responded",
    ];

    private static readonly Grading Grading = new() { ExpectedOutcome = "resolved", ExpectedPath = "triage/resolve" };

    /// <summary>
    /// Runs a REST scenario over <paramref name="turns"/> turns. Everything that is not the turn
    /// count is held identical — the same scenario id, seed, endpoint, status, and a frozen clock
    /// so every recorded duration is zero.
    /// </summary>
    private static async Task<Transcript> Run(int turns)
    {
        using var handler = new StubHandler(new StubbedReply());
        var stimuli = Enumerable.Range(1, turns).Select(index => $"stimulus {index}").ToArray();
        var seen = 0;
        var exchange = new StubExchange(_ =>
        {
            seen++;

            return new RestResponse
            {
                // Distinct per turn, so `!presence:repeatedResponse` is judging the system rather
                // than an artefact of the fixture repeating itself.
                Text = $"response {seen}",
                ObservedOutcome = seen == turns ? "resolved" : null,
                ObservedPath = "triage/resolve",
                Fields = new Dictionary<string, string?>(StringComparer.Ordinal) { ["scope/confirm"] = "yes" },
            };
        });

        return await RunnerFixtures
            .Runner(handler, exchange)
            .RunAsync(
                RunnerFixtures.Scenario(id: "shared-shape"),
                RunnerFixtures.Context(new ScriptedParticipant(stimuli)),
                default
            );
    }

    private static string WithoutTurns(Transcript transcript)
    {
        var node =
            JsonNode.Parse(CanonicalJson.Serialize(transcript)) as JsonObject
            ?? throw new Xunit.Sdk.XunitException("a transcript must serialize to a JSON object");
        node.Remove("turns");

        return node.ToJsonString();
    }

    private static IEnumerable<string> TurnKeys(Transcript transcript) =>
        (JsonNode.Parse(CanonicalJson.Serialize(transcript))!["turns"]!.AsArray())
            .SelectMany(turn => turn!.AsObject().Select(member => member.Key))
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal);

    /// <summary>
    /// Everything outside the turn list is byte-identical, so a downstream stage reading anything
    /// other than the turns cannot tell the two runs apart.
    /// </summary>
    [Fact]
    public async Task OneTurnAndMultiTurnRuns_DifferInNothingButTheirTurns()
    {
        var oneTurn = await Run(1);
        var multiTurn = await Run(3);

        oneTurn.Turns.Should().ContainSingle();
        multiTurn.Turns.Should().HaveCount(3);
        WithoutTurns(oneTurn).Should().Be(WithoutTurns(multiTurn));
    }

    /// <summary>A turn is the same record whether it is the only one or one of three.</summary>
    [Fact]
    public async Task OneTurnAndMultiTurnRuns_RecordTurnsOfTheSameShape()
    {
        var oneTurn = await Run(1);
        var multiTurn = await Run(3);

        TurnKeys(oneTurn).Should().Equal(TurnKeys(multiTurn));
    }

    /// <summary>
    /// The load-bearing half: the same registry, the same specs, the same context type — and
    /// identical verdicts. Nothing here branches on kind because there is nothing to branch on.
    /// </summary>
    [Fact]
    public async Task OneTurnAndMultiTurnRuns_AreGradedIdenticallyByTheSameEvaluators()
    {
        var oneTurn = await Run(1);
        var multiTurn = await Run(3);
        var registry = AssertionEvaluatorRegistry.CreateDefault();

        foreach (var expression in Battery)
        {
            var spec = AssertionSpec.Parse(expression);
            var fromOne = await registry.EvaluateAsync(spec, Context(oneTurn), default);
            var fromMany = await registry.EvaluateAsync(spec, Context(multiTurn), default);

            fromOne
                .Pass.Should()
                .Be(
                    fromMany.Pass,
                    because: $"'{expression}' judges the evidence, and the evidence is the same; "
                        + $"one-turn said {fromOne.Detail}, three-turn said {fromMany.Detail}"
                );
            fromOne.Pass.Should().BeTrue(because: $"'{expression}' should hold for this evidence");
        }
    }

    /// <summary>
    /// The strongest form of the claim: graded <i>against each other</i> as baseline and candidate,
    /// the two runs report no regression in either direction. A comparator that could tell them
    /// apart would report one here.
    /// </summary>
    [Theory]
    [InlineData("baseline:outcome")]
    [InlineData("baseline:path")]
    [InlineData("baseline:fields")]
    public async Task OneTurnRunComparedAgainstMultiTurnRun_ReportsNoRegressionEitherWay(string expression)
    {
        var oneTurn = await Run(1);
        var multiTurn = await Run(3);
        var registry = AssertionEvaluatorRegistry.CreateDefault();
        var spec = AssertionSpec.Parse(expression);

        var forward = await registry.EvaluateAsync(spec, Context(oneTurn, baseline: multiTurn), default);
        var backward = await registry.EvaluateAsync(spec, Context(multiTurn, baseline: oneTurn), default);

        forward.Pass.Should().BeTrue(because: forward.Detail);
        backward.Pass.Should().BeTrue(because: backward.Detail);
    }

    /// <summary>
    /// The contrast that keeps the claim honest. An evaluator <i>can</i> measure turn depth — that
    /// is what <c>structural:turnDepth</c> is for, and an author who writes it is asking about the
    /// evidence. What must not exist is a way to learn which <b>kind</b> produced the transcript.
    /// </summary>
    [Fact]
    public async Task TurnDepthAssertion_DistinguishesTheRuns_BecauseTheAuthorAskedItTo()
    {
        var oneTurn = await Run(1);
        var multiTurn = await Run(3);
        var registry = AssertionEvaluatorRegistry.CreateDefault();
        var spec = AssertionSpec.Parse("structural:turnDepth/3");

        (await registry.EvaluateAsync(spec, Context(oneTurn), default)).Pass.Should().BeFalse();
        (await registry.EvaluateAsync(spec, Context(multiTurn), default)).Pass.Should().BeTrue();
    }

    /// <summary>
    /// Nothing in a transcript names a <see cref="ScenarioKind"/>. The transport identifier is
    /// <c>http</c>, not <c>rest</c>, deliberately: a future HTTP-backed LLM runner must be
    /// indistinguishable here.
    /// </summary>
    [Theory]
    [InlineData(1)]
    [InlineData(3)]
    public async Task Transcript_FromTheRestRunner_NeverNamesTheScenarioKind(int turns)
    {
        var json = CanonicalJson.Serialize(await Run(turns));

        foreach (var kind in Enum.GetNames<ScenarioKind>())
        {
            json.Should()
                .NotContainEquivalentOf(
                    $"\"{kind}\"",
                    because: $"a transcript naming '{kind}' would let a downstream stage branch on kind"
                );
        }

        json.Should().Contain("\"kind\": \"http\"");
    }

    private static EvaluationContext Context(Transcript transcript, Transcript? baseline = null) =>
        new()
        {
            ScenarioId = "shared-shape",
            Grading = Grading,
            Transcript = transcript,
            Baseline = baseline,
        };
}
