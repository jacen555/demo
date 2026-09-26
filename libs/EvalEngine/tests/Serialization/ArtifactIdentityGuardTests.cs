using FluentAssertions;
using Forge.EvalEngine.Baselines;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Serialization;

namespace Forge.EvalEngine.Tests.Serialization;

/// <summary>
/// The machine-path guard on identifiers read back out of a durable artifact.
/// </summary>
/// <remarks>
/// <para>
/// Validating a suite on load does not cover this. A baseline artifact was written by an earlier
/// run, possibly by an earlier build, and its identifiers never pass through
/// <see cref="Loading.SuiteLoader"/> again. A scenario that has since been <b>removed</b> from the
/// suite exists only in the baseline — current-suite validation cannot see it — and it is still
/// rendered into the published report as a removed scenario.
/// </para>
/// <para>
/// The check sits in <see cref="CanonicalJson.DeserializeSuiteResult(string)"/> rather than in
/// <see cref="ArtifactBaseline"/> because that is the one door every reader of a durable artifact
/// passes through, and — in the words this file's subject already uses — a guard one call away
/// from being bypassed is not a guard.
/// </para>
/// <para>
/// A refusal <b>throws</b> rather than yielding no baseline. Yielding null would have the caller
/// report "no regression" on the strength of never having compared anything, which is the failure
/// this type is built to prevent.
/// </para>
/// </remarks>
public class ArtifactIdentityGuardTests
{
    private static string Artifact(
        string suiteName = "regression",
        string scenarioId = "refund-flow",
        string? tag = null,
        IReadOnlyDictionary<string, string>? harnessConfig = null,
        string? expectedFailureReason = null
    )
    {
        // Serialized with safe placeholders and substituted afterwards. The writer refuses an
        // unsafe identifier too now, and the subject of these tests is the *reader* — a file
        // written by something else, which is the only way such an artifact can exist.
        var json = CanonicalJson.Serialize(
            new SuiteResult
            {
                SuiteName = "suite-placeholder",
                Environment = new EvaluationEnvironment
                {
                    Seed = 1,
                    Timestamp = DateTimeOffset.UnixEpoch,
                    HarnessConfig = harnessConfig is null
                        ? new Dictionary<string, string>(StringComparer.Ordinal)
                        : new Dictionary<string, string>(StringComparer.Ordinal)
                        {
                            ["config-placeholder"] = "value-placeholder",
                        },
                },
                ScenarioResults =
                [
                    new ScenarioResult
                    {
                        ScenarioId = "id-placeholder",
                        Kind = ScenarioKind.Rest,
                        RepetitionPolicyUsed = RepetitionPolicy.Once,
                        ExpectedFailure = expectedFailureReason is null
                            ? null
                            : new ExpectedFailure { Reason = "reason-placeholder" },
                        Tags = tag is null
                            ? new Dictionary<string, string>(StringComparer.Ordinal)
                            : new Dictionary<string, string>(StringComparer.Ordinal) { ["area"] = "tag-placeholder" },
                    },
                ],
            }
        );

        json = Substitute(json, "suite-placeholder", suiteName);
        json = Substitute(json, "id-placeholder", scenarioId);

        if (tag is not null)
        {
            json = Substitute(json, "tag-placeholder", tag);
        }

        if (expectedFailureReason is not null)
        {
            json = Substitute(json, "reason-placeholder", expectedFailureReason);
        }

        if (harnessConfig is not null)
        {
            var entry = harnessConfig.Single();
            json = Substitute(json, "config-placeholder", entry.Key);
            json = Substitute(json, "value-placeholder", entry.Value);
        }

        return json;
    }

    private static string Substitute(string json, string placeholder, string value) =>
        json.Replace(
            System.Text.Json.JsonSerializer.Serialize(placeholder),
            System.Text.Json.JsonSerializer.Serialize(value),
            StringComparison.Ordinal
        );

    [Fact]
    public void DeserializeSuiteResult_ValidArtifact_ReadsIt()
    {
        var artifact = CanonicalJson.DeserializeSuiteResult(Artifact());

        artifact.SuiteName.Should().Be("regression");
        artifact.ScenarioResults.Should().ContainSingle().Which.ScenarioId.Should().Be("refund-flow");
    }

    [Theory]
    [InlineData("/api/v1/refund")]
    [InlineData("/media/upload")]
    [InlineData("/users/{id}/orders")]
    public void DeserializeSuiteResult_RouteShapedScenarioId_ReadsIt(string scenarioId)
    {
        var artifact = CanonicalJson.DeserializeSuiteResult(Artifact(scenarioId: scenarioId));

        artifact.ScenarioResults[0].ScenarioId.Should().Be(scenarioId);
    }

    /// <summary>
    /// The removed-scenario case the reviewer named: baseline-only, and still rendered.
    /// </summary>
    /// <remarks>
    /// The colon also defeats the report-side pattern, so without this the value reaches the
    /// published comment through a route current-suite validation never touches.
    /// </remarks>
    [Theory]
    [InlineData("checkout path:/home/ci-user/repo")]
    [InlineData("/home/ci-user/repo")]
    [InlineData(@"C:\Users\ci-user\repo")]
    public void DeserializeSuiteResult_ScenarioIdIsAMachinePath_ThrowsWithoutRepeatingTheValue(string scenarioId)
    {
        var read = () => CanonicalJson.DeserializeSuiteResult(Artifact(scenarioId: scenarioId));

        var thrown = read.Should().Throw<UnsafeIdentifierException>().Which;
        thrown.Field.Should().Be("scenarioId");
        thrown.Message.Should().NotContain("/home/ci-user").And.NotContain("Users").And.Contain("#1");
    }

    [Fact]
    public void DeserializeSuiteResult_SuiteNameIsAMachinePath_ThrowsWithoutRepeatingTheValue()
    {
        var read = () => CanonicalJson.DeserializeSuiteResult(Artifact(suiteName: "checkout /home/ci-user/build"));

        var thrown = read.Should().Throw<UnsafeIdentifierException>().Which;
        thrown.Field.Should().Be("suiteName");
        thrown.Message.Should().NotContain("/home/ci-user");
    }

    [Fact]
    public void DeserializeSuiteResult_SlicingTagIsAMachinePath_ThrowsWithoutRepeatingTheValue()
    {
        var read = () => CanonicalJson.DeserializeSuiteResult(Artifact(tag: "/home/ci-user/repo"));

        var thrown = read.Should().Throw<UnsafeIdentifierException>().Which;
        thrown.Field.Should().Be("tags");
        thrown.Message.Should().NotContain("/home/ci-user");
    }

    /// <summary>
    /// The generic entry point carries the same guard as the named one.
    /// </summary>
    [Fact]
    public void Deserialize_SuiteResultWithAMachinePathIdentifier_Throws()
    {
        var read = () => CanonicalJson.Deserialize<SuiteResult>(Artifact(scenarioId: "/home/ci-user/repo"));

        read.Should().Throw<UnsafeIdentifierException>();
    }

    /// <summary>
    /// Two surfaces that did not exist when the trade-off was reasoned about.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The harness settings and the failure carve-out are both <b>author-supplied free text</b>
    /// written verbatim into a committed, published artifact — the first surfaces of that shape
    /// the artifact has carried. ADR 0005 is explicit that a documented trade-off is scoped to
    /// the surfaces that existed when it was made, so neither inherits the reasoning: they are
    /// guarded, exactly as the selection decisions were when they were added.
    /// </para>
    /// <para>
    /// A harness setting is guarded on both its key and its value. A key is as author-supplied as
    /// a value, and a reader who tried to reproduce the run would read either.
    /// </para>
    /// </remarks>
    [Fact]
    public void DeserializeSuiteResult_HarnessSettingValueIsAMachinePath_ThrowsWithoutRepeatingTheValue()
    {
        var config = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["suiteRoot"] = "/home/ci-user/repo/suites",
        };

        var read = () => CanonicalJson.DeserializeSuiteResult(Artifact(harnessConfig: config));

        var thrown = read.Should().Throw<UnsafeIdentifierException>().Which;
        thrown.Field.Should().Be("environment.harnessConfig");
        thrown.Message.Should().NotContain("/home/ci-user");
    }

    [Fact]
    public void DeserializeSuiteResult_HarnessSettingKeyIsAMachinePath_ThrowsWithoutRepeatingTheValue()
    {
        var config = new Dictionary<string, string>(StringComparer.Ordinal) { [@"C:\Users\ci-user\repo"] = "30" };

        var read = () => CanonicalJson.DeserializeSuiteResult(Artifact(harnessConfig: config));

        var thrown = read.Should().Throw<UnsafeIdentifierException>().Which;
        thrown.Field.Should().Be("environment.harnessConfig");
        thrown.Message.Should().NotContain("Users");
    }

    [Fact]
    public void DeserializeSuiteResult_ExpectedFailureReasonIsAMachinePath_ThrowsWithoutRepeatingTheValue()
    {
        var read = () =>
            CanonicalJson.DeserializeSuiteResult(
                Artifact(expectedFailureReason: "blocked on the fixture at /home/ci-user/repo/fixtures")
            );

        var thrown = read.Should().Throw<UnsafeIdentifierException>().Which;
        thrown.Field.Should().Be("expectedFailure");
        thrown.Message.Should().NotContain("/home/ci-user").And.Contain("#1");
    }

    [Fact]
    public void DeserializeSuiteResult_OrdinaryHarnessSettingsAndCarveOut_ReadsThem()
    {
        var config = new Dictionary<string, string>(StringComparer.Ordinal) { ["restTimeoutSeconds"] = "30" };

        var artifact = CanonicalJson.DeserializeSuiteResult(
            Artifact(harnessConfig: config, expectedFailureReason: "known gap, tracked as FORGE-214")
        );

        artifact.Environment.HarnessConfig.Should().Contain("restTimeoutSeconds", "30");
        artifact.ScenarioResults[0].ExpectedFailure!.Reason.Should().Be("known gap, tracked as FORGE-214");
    }

    /// <summary>
    /// The version refusal does not repeat the version it refused.
    /// </summary>
    /// <remarks>
    /// The declared version is read straight out of an untrusted artifact, and this message
    /// reaches standard error. <see cref="SchemaVersionException.DeclaredVersion"/> still carries
    /// it as structured data for a caller that deliberately wants it — which is the difference
    /// between an opt-in and a splice into prose.
    /// </remarks>
    [Fact]
    public void DeserializeSuiteResult_SchemaVersionIsAMachinePath_ThrowsWithoutRepeatingTheValue()
    {
        var json = """
            {
              "schemaVersion": "/home/ci-user/repo",
              "suiteName": "regression",
              "scenarioResults": [],
              "environment": { "seed": 1, "timestamp": "1970-01-01T00:00:00+00:00" }
            }
            """;

        var read = () => CanonicalJson.DeserializeSuiteResult(json);

        var thrown = read.Should().Throw<SchemaVersionException>().Which;
        thrown.Message.Should().NotContain("/home/ci-user");
        thrown.DeclaredVersion.Should().Be("/home/ci-user/repo");
    }

    /// <summary>
    /// The baseline provider inherits the guard rather than restating it.
    /// </summary>
    [Fact]
    public async Task TryGetBaselineAsync_ArtifactWithAMachinePathIdentifier_ThrowsRatherThanYieldingNoBaseline()
    {
        var root = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName());
        Directory.CreateDirectory(root);

        try
        {
            await File.WriteAllTextAsync(
                Path.Combine(root, "baseline.json"),
                Artifact(scenarioId: "/home/ci-user/removed-scenario"),
                CancellationToken.None
            );

            var load = () => new ArtifactBaseline(root).TryGetBaselineAsync("baseline.json", CancellationToken.None);

            (await load.Should().ThrowAsync<UnsafeIdentifierException>())
                .Which.Message.Should()
                .NotContain("/home/ci-user");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
