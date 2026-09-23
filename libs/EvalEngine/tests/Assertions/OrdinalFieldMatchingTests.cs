using FluentAssertions;

namespace Forge.EvalEngine.Tests.Assertions;

/// <summary>
/// Field and attribute keys are matched <b>ordinally</b>, whatever comparer the evidence happens
/// to carry.
/// </summary>
/// <remarks>
/// <para>
/// Every category documents ordinal, case-sensitive matching, and says why: a token means exactly
/// what it says, and no verdict depends on ambient configuration. But a transcript is data that
/// arrives from somewhere — a runner, a deserializer, a baseline artifact — and an
/// <see cref="IReadOnlyDictionary{TKey, TValue}"/> carries its comparer with it. An evaluator that
/// simply calls <c>TryGetValue</c> inherits that comparer, so a map built case-insensitively
/// quietly makes <c>field/Status</c> match a field the system actually named <c>status</c>.
/// </para>
/// <para>
/// That is a verdict decided by how the evidence was assembled rather than by what the system did
/// — the documented contract silently not holding, which is worse than it never having been
/// claimed. The matching is therefore enforced by the evaluators rather than delegated to the
/// evidence.
/// </para>
/// </remarks>
public class OrdinalFieldMatchingTests
{
    private static readonly StringComparer CaseInsensitive = StringComparer.OrdinalIgnoreCase;

    // -------------------------------------------------------------------------------------
    // presence — the field is looked up, not the map's idea of it.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task EvaluateAsync_FieldDiffersOnlyInCaseInACaseInsensitiveMap_IsStillAbsent()
    {
        var context = Evidence.Context(
            Evidence.Transcript(Evidence.OutcomeKeyedBy(CaseInsensitive, entries: [("status", "ok")]))
        );

        var result = await Evidence.Evaluate("presence:field/Status", context);

        result.Pass.Should().BeFalse("the system returned 'status'; the assertion asked about 'Status'");
    }

    [Fact]
    public async Task EvaluateAsync_NegatedFieldDiffersOnlyInCaseInACaseInsensitiveMap_Passes()
    {
        var context = Evidence.Context(
            Evidence.Transcript(Evidence.OutcomeKeyedBy(CaseInsensitive, entries: [("status", "ok")]))
        );

        var result = await Evidence.Evaluate("!presence:field/Status", context);

        result.Pass.Should().BeTrue();
    }

    [Fact]
    public async Task EvaluateAsync_FieldMatchesExactlyInACaseInsensitiveMap_IsStillFound()
    {
        var context = Evidence.Context(
            Evidence.Transcript(Evidence.OutcomeKeyedBy(CaseInsensitive, entries: [("status", "ok")]))
        );

        var result = await Evidence.Evaluate("presence:field/status", context);

        result.Pass.Should().BeTrue("an exact key is an exact key regardless of the map's comparer");
    }

    // -------------------------------------------------------------------------------------
    // expectedBehavior — field, threshold and transport lookups.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task EvaluateAsync_ExpectedFieldDiffersOnlyInCaseInACaseInsensitiveMap_Fails()
    {
        var context = Evidence.Context(
            Evidence.Transcript(Evidence.OutcomeKeyedBy(CaseInsensitive, entries: [("escalateReason", "out_of_scope")]))
        );

        var result = await Evidence.Evaluate("expectedBehavior:field/EscalateReason=out_of_scope", context);

        result.Pass.Should().BeFalse();
        result.Detail.Should().Contain("was not returned at all");
    }

    [Fact]
    public async Task EvaluateAsync_ThresholdFieldDiffersOnlyInCaseInACaseInsensitiveMap_Fails()
    {
        var context = Evidence.Context(
            Evidence.Transcript(Evidence.OutcomeKeyedBy(CaseInsensitive, entries: [("routeConfidence", "0.9")]))
        );

        var result = await Evidence.Evaluate("expectedBehavior:fieldAtLeast/RouteConfidence=0.4", context);

        result.Pass.Should().BeFalse("the field the assertion named was never returned");
    }

    [Fact]
    public async Task EvaluateAsync_TransportAttributeDiffersOnlyInCaseInACaseInsensitiveMap_Fails()
    {
        var context = Evidence.Context(
            Evidence.Transcript(transport: Evidence.TransportKeyedBy(CaseInsensitive, ("statusCode", "429")))
        );

        var result = await Evidence.Evaluate("expectedBehavior:transport/StatusCode=429", context);

        result.Pass.Should().BeFalse();
    }

    // -------------------------------------------------------------------------------------
    // baseline — both sides of the comparison are re-keyed, not just the one being read.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task EvaluateAsync_BaselineAndCandidateFieldsDifferOnlyInCaseInCaseInsensitiveMaps_ReportsTheDivergence()
    {
        var result = await Evidence.Evaluate(
            "baseline:fields",
            Evidence.Context(
                Evidence.Transcript(Evidence.OutcomeKeyedBy(CaseInsensitive, entries: [("status", "ok")])),
                baseline: Evidence.Transcript(Evidence.OutcomeKeyedBy(CaseInsensitive, entries: [("Status", "ok")]))
            )
        );

        result
            .Pass.Should()
            .BeFalse("the system renamed the field it returns, which is exactly the kind of drift this catches");
        result.Detail.Should().Contain("Status").And.Contain("status");
    }

    [Fact]
    public async Task EvaluateAsync_BaselineFieldsMatchExactlyInCaseInsensitiveMaps_StillCountsAsUnchanged()
    {
        var result = await Evidence.Evaluate(
            "baseline:fields",
            Evidence.Context(
                Evidence.Transcript(Evidence.OutcomeKeyedBy(CaseInsensitive, entries: [("status", "ok")])),
                baseline: Evidence.Transcript(Evidence.OutcomeKeyedBy(CaseInsensitive, entries: [("status", "ok")]))
            )
        );

        result.Pass.Should().BeTrue();
    }
}
