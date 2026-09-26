using FluentAssertions;
using Forge.EvalEngine.Loading;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Serialization;

namespace Forge.EvalEngine.Tests.Paths;

/// <summary>
/// What the identifier recogniser must keep accepting, and what a relative prefix must not hide.
/// </summary>
/// <remarks>
/// <para>
/// <b>The accepting half is first, and it is the half that matters.</b> Every other refusal in
/// this library fails closed; a recogniser that refuses a valid identifier costs a user their
/// suite, and this audit has already produced one of those. So the route-shaped identifiers a
/// suite author has every reason to write are pinned at <b>both</b> doors — the loader and the
/// artifact reader/writer — before a single spelling is added to what is refused.
/// </para>
/// <para>
/// <b>The refusing half is keyed on a canonical form, not on a list of spellings.</b> A leading
/// <c>./</c> or <c>.\</c> made a drive-qualified or system-rooted path read as relative, in both
/// separator conventions. Recognition now reduces the token before testing it, so the property —
/// "does this name a machine" — holds whatever the producer's spelling, rather than holding for
/// the spellings somebody happened to think of.
/// </para>
/// </remarks>
public sealed class MachinePathRecognitionTests
{
    // -----------------------------------------------------------------------------------------
    // Must keep loading. These are the whole risk.
    // -----------------------------------------------------------------------------------------

    public static TheoryData<string> RouteShapedIdentifiers() =>
        [
            "./api/v1/refund",
            "./src/Checkout.cs",
            "./media/upload",
            "GET ./home/dashboard",
            "GET /home/dashboard",
            "/api/v1/refund",
            "/media/upload",
            "/users/{id}/orders",
            "refund-flow",
            "checkout.v2",
            "checkout path:./api/v1/refund",
            "https://localhost:5001/eval",
            "http://localhost:5001/home/dashboard",
            "scenario:v2",
            "X:12",
            // Reduces to the RELATIVE `home/ci-user/repo`, which this recogniser has always
            // allowed and must keep allowing: it requires rootedness, because a relative path
            // beginning `home/` is indistinguishable from a repository directory of that name.
            // Refusing it while `home/ci-user/repo` loads would be an inconsistency in the other
            // direction — and refusing a valid identifier is the failure this file cares most
            // about.
            "./home/ci-user/repo",
            "checkout path:./home/ci-user/repo",
        ];

    [Theory]
    [MemberData(nameof(RouteShapedIdentifiers))]
    public void LoadFromJson_ARouteShapedScenarioId_StillLoads(string scenarioId)
    {
        var result = SuiteLoader.LoadFromJson(Suite(scenarioId), "regression.json");

        result.Succeeded.Should().BeTrue(because: string.Join("; ", result.Messages));
        result.Suite!.Scenarios[0].Identity.Id.Should().Be(scenarioId);
    }

    [Theory]
    [MemberData(nameof(RouteShapedIdentifiers))]
    public void Serialize_ARouteShapedScenarioId_RoundTripsThroughBothArtifactDoors(string scenarioId)
    {
        var artifact = new SuiteResult
        {
            SuiteName = "regression",
            Environment = new EvaluationEnvironment { Seed = 1, Timestamp = DateTimeOffset.UnixEpoch },
            ScenarioResults =
            [
                new ScenarioResult
                {
                    ScenarioId = scenarioId,
                    Kind = ScenarioKind.Rest,
                    RepetitionPolicyUsed = RepetitionPolicy.Once,
                    Tags = new Dictionary<string, string>(StringComparer.Ordinal) { ["area"] = scenarioId },
                },
            ],
        };

        CanonicalJson
            .DeserializeSuiteResult(CanonicalJson.Serialize(artifact))
            .ScenarioResults[0]
            .ScenarioId.Should()
            .Be(scenarioId);
    }

    // -----------------------------------------------------------------------------------------
    // Must be refused, in every spelling of the same path.
    // -----------------------------------------------------------------------------------------

    public static TheoryData<string> PrefixedMachinePaths() =>
        [
            "./C:/Users/ci-user/repo",
            @".\C:\Users\ci-user\repo",
            ".//home/ci-user/repo",
            // A drive outside the system-root allowlist: recognised because it is drive-rooted,
            // which owes nothing to the allowlist.
            "./D:/build/ci-user/repo",
            @".\D:\build\ci-user\repo",
            "././C:/Users/ci-user/repo",
            // The same reduction, reached through the colon-delimited boundary rather than the
            // whitespace one. `CarriesLabelledPath` is a second entry to the same predicate, and
            // it handed the text after `label:` straight to the path test.
            "checkout path:.//home/ci-user/repo",
            @"checkout path:.\D:\build\ci-user\repo",
            "checkout path:./C:/Users/ci-user/repo",
            // Already refused before the reduction existed; kept so the labelled boundary cannot
            // regress while it is being changed.
            "checkout path:/home/ci-user/repo",
        ];

    [Theory]
    [MemberData(nameof(PrefixedMachinePaths))]
    public void LoadFromJson_AScenarioIdHidingAMachinePathBehindARelativePrefix_IsRefused(string scenarioId)
    {
        var result = SuiteLoader.LoadFromJson(Suite(scenarioId), "regression.json");

        result.Succeeded.Should().BeFalse();
        result.Messages.Should().NotContain(message => message.Message.Contains("ci-user"));
    }

    [Theory]
    [MemberData(nameof(PrefixedMachinePaths))]
    public void Serialize_AScenarioIdHidingAMachinePathBehindARelativePrefix_IsRefused(string scenarioId)
    {
        var artifact = new SuiteResult
        {
            SuiteName = "regression",
            Environment = new EvaluationEnvironment { Seed = 1, Timestamp = DateTimeOffset.UnixEpoch },
            ScenarioResults =
            [
                new ScenarioResult
                {
                    ScenarioId = scenarioId,
                    Kind = ScenarioKind.Rest,
                    RepetitionPolicyUsed = RepetitionPolicy.Once,
                },
            ],
        };

        var write = () => CanonicalJson.Serialize(artifact);

        write.Should().Throw<UnsafeIdentifierException>().Which.Message.Should().NotContain("ci-user");
    }

    /// <summary>The unprefixed spellings must keep being refused, which they already were.</summary>
    [Theory]
    [InlineData("/home/ci-user/repo")]
    [InlineData(@"C:\Users\ci-user\repo")]
    [InlineData("D:/build/ci-user/repo")]
    [InlineData("//home/ci-user/repo")]
    public void LoadFromJson_AnUnprefixedMachinePath_IsStillRefused(string scenarioId)
    {
        SuiteLoader.LoadFromJson(Suite(scenarioId), "regression.json").Succeeded.Should().BeFalse();
    }

    private static string Suite(string scenarioId) =>
        $$"""
            {
              "name": "regression",
              "scenarios": [
                {
                  "identity": { "id": {{System.Text.Json.JsonSerializer.Serialize(scenarioId)}}, "kind": "rest" },
                  "execution": { "mode": "live" },
                  "simulation": { "opening": "GET /health" }
                }
              ]
            }
            """;
}
