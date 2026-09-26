using System.Collections.Generic;
using FluentAssertions;
using Forge.EvalEngine.Coordination;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Serialization;

namespace Forge.EvalEngine.Tests.Serialization;

/// <summary>
/// The write door: what a direct library caller can put into an artifact it then publishes.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="CanonicalJson.DeserializeSuiteResult(string)"/> refuses a machine path on read, and
/// <see cref="Loading.SuiteLoader"/> refuses one on the way in from a suite file. Neither is
/// reached by a caller that constructs a <see cref="SuiteResult"/> in process and serializes it —
/// which is exactly what the coordinator's consumers do. Two doors out of three is not a guard;
/// the value has to be refused where it <b>enters the type</b>.
/// </para>
/// <para>
/// These are also the surfaces that carry author-supplied free text verbatim, so the refusals
/// name the rule rather than the value (§V, ADR 0005).
/// </para>
/// </remarks>
public sealed class ArtifactWriteDoorTests
{
    private const string Path = "/home/ci-user/repo/fixtures";
    private const string WindowsPath = @"C:\Users\ci-user\repo";

    // -----------------------------------------------------------------------------------------
    // The value cannot leave through the writer.
    // -----------------------------------------------------------------------------------------

    private static SuiteResult Artifact(
        IReadOnlyDictionary<string, string>? harnessConfig = null,
        string? expectedFailureReason = null
    ) =>
        new()
        {
            SuiteName = "regression",
            Environment = new EvaluationEnvironment
            {
                Seed = 1,
                Timestamp = DateTimeOffset.UnixEpoch,
                HarnessConfig = harnessConfig ?? new Dictionary<string, string>(StringComparer.Ordinal),
            },
            ScenarioResults =
            [
                new ScenarioResult
                {
                    ScenarioId = "refund-flow",
                    Kind = ScenarioKind.Rest,
                    RepetitionPolicyUsed = RepetitionPolicy.Once,
                    ExpectedFailure = expectedFailureReason is null
                        ? null
                        : new ExpectedFailure { Reason = expectedFailureReason },
                },
            ],
        };

    [Theory]
    [InlineData(Path)]
    [InlineData(WindowsPath)]
    [InlineData("blocked on the fixture at /home/ci-user/repo/fixtures")]
    public void Serialize_CarveOutReasonNamingAMachinePath_IsRefusedWithoutRepeatingTheValue(string reason)
    {
        var write = () => CanonicalJson.Serialize(Artifact(expectedFailureReason: reason));

        var thrown = write.Should().Throw<UnsafeIdentifierException>().Which;
        thrown.Field.Should().Be("expectedFailure");
        thrown.Message.Should().NotContain("/home/ci-user").And.NotContain("Users");
    }

    [Theory]
    [InlineData(Path)]
    [InlineData(WindowsPath)]
    public void Serialize_HarnessSettingValueNamingAMachinePath_IsRefusedWithoutRepeatingTheValue(string value)
    {
        var config = new Dictionary<string, string>(StringComparer.Ordinal) { ["suiteRoot"] = value };

        var write = () => CanonicalJson.Serialize(Artifact(config));

        var thrown = write.Should().Throw<UnsafeIdentifierException>().Which;
        thrown.Field.Should().Be("environment.harnessConfig");
        thrown.Message.Should().NotContain("/home/ci-user").And.NotContain("Users");
    }

    [Fact]
    public void Serialize_HarnessSettingKeyNamingAMachinePath_IsRefusedWithoutRepeatingTheValue()
    {
        var config = new Dictionary<string, string>(StringComparer.Ordinal) { [Path] = "30" };

        var write = () => CanonicalJson.Serialize(Artifact(config));

        write.Should().Throw<UnsafeIdentifierException>().Which.Message.Should().NotContain("/home/ci-user");
    }

    [Fact]
    public void Serialize_ScenarioIdNamingAMachinePath_IsRefusedTooBecauseTheRuleIsShared()
    {
        var artifact = Artifact() with { ScenarioResults = [Artifact().ScenarioResults[0] with { ScenarioId = Path }] };

        var write = () => CanonicalJson.Serialize(artifact);

        write.Should().Throw<UnsafeIdentifierException>().Which.Field.Should().Be("scenarioId");
    }

    [Fact]
    public void Serialize_OrdinaryArtifact_RoundTripsThroughTheReader()
    {
        var config = new Dictionary<string, string>(StringComparer.Ordinal) { ["restTimeoutSeconds"] = "30" };

        var json = CanonicalJson.Serialize(Artifact(config, "known gap, tracked as FORGE-214"));
        var read = CanonicalJson.DeserializeSuiteResult(json);

        read.Environment.HarnessConfig.Should().Contain("restTimeoutSeconds", "30");
        read.ScenarioResults[0].ExpectedFailure!.Reason.Should().Be("known gap, tracked as FORGE-214");
    }

    // -----------------------------------------------------------------------------------------
    // The stored map cannot be reached through the getter.
    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// The refusal for a null value must not echo the key it came from.
    /// </summary>
    /// <remarks>
    /// The key is caller-supplied and may itself be the machine path the guard above exists to
    /// refuse, and this message reaches the build log. A refusal names the rule, never the value.
    /// </remarks>
    [Fact]
    public void HarnessConfig_RefusingANullValue_NamesTheRuleAndNotTheKey()
    {
        var entries = new Dictionary<string, string>(StringComparer.Ordinal) { ["deploymentRoot"] = null! };

        var act = () => new RunCoordinatorOptions { HarnessConfig = entries };

        act.Should().Throw<ArgumentException>().Which.Message.Should().NotContain("deploymentRoot");
    }

    // -----------------------------------------------------------------------------------------
    // The stored map cannot be reached through the getter.
    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// Validating the input and exposing the store is not a snapshot.
    /// </summary>
    /// <remarks>
    /// The previous fix copied the caller's dictionary and then handed the copy back as
    /// <see cref="IReadOnlyDictionary{TKey,TValue}"/>. A caller casts the returned reference to
    /// the mutable interface it actually is and edits the validated store — after validation, and
    /// on the shared <see cref="RunCoordinatorOptions.Default"/> for every later run in the
    /// process. The distinction this test turns on is mutating <b>through the getter</b> rather
    /// than mutating the original input.
    /// </remarks>
    [Fact]
    public void HarnessConfig_MutatedThroughTheGetter_DoesNotChangeWhatWasValidated()
    {
        var options = new RunCoordinatorOptions
        {
            HarnessConfig = new Dictionary<string, string>(StringComparer.Ordinal) { ["restTimeoutSeconds"] = "30" },
        };

        var escape = () => ((IDictionary<string, string>)options.HarnessConfig)["restTimeoutSeconds"] = "300";

        escape.Should().Throw<NotSupportedException>();
        options.HarnessConfig["restTimeoutSeconds"].Should().Be("30");
    }

    [Fact]
    public void HarnessConfig_OfTheSharedDefault_CannotBeMutatedThroughTheGetter()
    {
        var escape = () => ((IDictionary<string, string>)RunCoordinatorOptions.Default.HarnessConfig)["x"] = "1";

        escape.Should().Throw<NotSupportedException>();
        RunCoordinatorOptions.Default.HarnessConfig.Should().BeEmpty();
    }

    [Fact]
    public void HarnessConfig_OfAnEvaluationEnvironment_CannotBeMutatedThroughTheGetter()
    {
        var environment = new EvaluationEnvironment
        {
            Seed = 1,
            Timestamp = DateTimeOffset.UnixEpoch,
            HarnessConfig = new Dictionary<string, string>(StringComparer.Ordinal) { ["a"] = "1" },
        };

        var escape = () => ((IDictionary<string, string>)environment.HarnessConfig)["a"] = "2";

        escape.Should().Throw<NotSupportedException>();
        environment.HarnessConfig["a"].Should().Be("1");
    }
}
