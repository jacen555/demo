using FluentAssertions;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Tests.Support;
using Forge.EvalEngine.Results;

namespace Forge.EvalCli.Tests.Cli;

/// <summary>
/// What a trend refusal and a trend report are allowed to put on the page, and on stderr.
/// </summary>
/// <remarks>
/// <para>
/// <b>stderr is a published surface, and the report's net did not previously cover it.</b> ADR
/// 0005 puts the control at authoring time and keeps a narrow net at the rendering boundary; the
/// authoring-time control exempts a leading request method, so <c>GET /home/ci-user/repo</c>
/// loads and reaches artifact read-back intact. That concession was made for one output channel.
/// A refusal written to the build log is a second one, and it must not inherit the concession
/// silently.
/// </para>
/// <para>
/// <b>No string out of an artifact's harness settings is printed at all.</b> An artifact is a file
/// anyone can write; a setting this build does not recognise could carry anything, including a
/// token. Only values re-parsed into a typed form reach the page.
/// </para>
/// </remarks>
public class TrendRedactionTests
{
    /// <summary>A machine path the engine admits into an identifier behind a request method.</summary>
    private const string ExemptedPath = "GET /home/ci-runner/work";

    /// <summary>The part of it that must never reach a message.</summary>
    private const string Disclosed = "/home/ci-runner/work";

    private static string Alias => "[path-redacted:";

    // -------------------------------------------------------------------------------------
    // Identifiers in refusals.
    // -------------------------------------------------------------------------------------

    [Fact]
    public void Build_WhenARedefinedScenarioIdCarriesAnExemptedMachinePath_DoesNotPrintIt()
    {
        var refusal = Assert.Throws<EvalCliException>(() =>
            SuiteTrend.Build([
                TrendFixture.Artifact(1, TrendFixture.Scenario(ExemptedPath, 5, 5)),
                TrendFixture.Artifact(
                    TrendFixture.Start.AddDays(1),
                    "artifacts/two.json",
                    [TrendFixture.Fingerprinted(ReportFixture.Scenario(ExemptedPath, 5, 5), "sha256:bbbb")]
                ),
            ])
        );

        refusal.Message.Should().NotContain(Disclosed);
        refusal.Message.Should().Contain(Alias).And.Contain("redefined");
    }

    [Fact]
    public void Build_WhenADuplicatedScenarioIdCarriesAMachinePath_DoesNotPrintIt()
    {
        var refusal = Assert.Throws<EvalCliException>(() =>
            SuiteTrend.Build([
                TrendFixture.Artifact(
                    1,
                    TrendFixture.Scenario(ExemptedPath, 5, 5),
                    TrendFixture.Scenario(ExemptedPath, 1, 5)
                ),
                TrendFixture.Artifact(2, TrendFixture.Scenario("checkout", 5, 5)),
            ])
        );

        refusal.Message.Should().NotContain(Disclosed).And.Contain(Alias);
    }

    [Fact]
    public void Build_WhenAnUnfingerprintedScenarioIdCarriesAMachinePath_DoesNotPrintIt()
    {
        var refusal = Assert.Throws<EvalCliException>(() =>
            SuiteTrend.Build([
                TrendFixture.Artifact(1, TrendFixture.Scenario(ExemptedPath, 5, 5)),
                TrendFixture.Artifact(
                    TrendFixture.Start.AddDays(1),
                    "artifacts/two.json",
                    [TrendFixture.Fingerprinted(ReportFixture.Scenario(ExemptedPath, 5, 5), fingerprint: null)]
                ),
            ])
        );

        refusal.Message.Should().NotContain(Disclosed).And.Contain(Alias);
    }

    [Fact]
    public void Build_WhenARedefinedScenarioChangedKindAndCarriesAMachinePath_DoesNotPrintIt()
    {
        var refusal = Assert.Throws<EvalCliException>(() =>
            SuiteTrend.Build([
                TrendFixture.Artifact(1, TrendFixture.Scenario(ExemptedPath, 5, 5)),
                TrendFixture.Artifact(
                    TrendFixture.Start.AddDays(1),
                    "artifacts/two.json",
                    [
                        TrendFixture.Scenario(ExemptedPath, 5, 5) with
                        {
                            Kind = Forge.EvalEngine.Scenarios.ScenarioKind.Ui,
                        },
                    ]
                ),
            ])
        );

        refusal.Message.Should().NotContain(Disclosed).And.Contain(Alias);
    }

    [Fact]
    public void Build_WhenTwoSuiteNamesDisagreeAndOneCarriesAMachinePath_DoesNotPrintIt()
    {
        var refusal = Assert.Throws<EvalCliException>(() =>
            SuiteTrend.Build([
                TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 5, 5)),
                TrendFixture.Artifact(
                    TrendFixture.Start.AddDays(1),
                    "artifacts/two.json",
                    [TrendFixture.Scenario("checkout", 5, 5)],
                    suiteName: ExemptedPath
                ),
            ])
        );

        refusal.Message.Should().NotContain(Disclosed).And.Contain(Alias);
    }

    [Fact]
    public void Build_WhenAnArtifactCarriesANullScenarioAndItsLabelIsAMachinePath_DoesNotPrintIt()
    {
        var refusal = Assert.Throws<EvalCliException>(() =>
            SuiteTrend.Build([
                TrendFixture.Artifact(
                    TrendFixture.Start,
                    "/home/ci-runner/work/one.json",
                    [null!, TrendFixture.Scenario("checkout", 5, 5)]
                ),
                TrendFixture.Artifact(2, TrendFixture.Scenario("checkout", 5, 5)),
            ])
        );

        refusal.Message.Should().NotContain("ci-runner").And.Contain(Alias);
    }

    // -------------------------------------------------------------------------------------
    // Harness settings.
    // -------------------------------------------------------------------------------------

    private static TrendArtifact WithSetting(int day, string key, string value) =>
        TrendFixture.Artifact(
            TrendFixture.Start.AddDays(day - 1),
            $"artifacts/run-{day}.json",
            [TrendFixture.Scenario("checkout", 5, 5)],
            extraConfig: new Dictionary<string, string>(StringComparer.Ordinal) { [key] = value }
        );

    [Fact]
    public void Build_WhenAnUnrecognisedHarnessSettingChanged_CarriesNeitherItsNameNorItsValue()
    {
        var trend = SuiteTrend.Build([
            WithSetting(1, "authHeader", "Bearer hunter2"),
            WithSetting(2, "authHeader", "Bearer hunter3"),
        ]);

        trend.UnnamedSettingChanges.Should().Be(1);
        trend.Caveats.Should().BeEmpty();
    }

    [Fact]
    public void Render_WhenAnUnrecognisedHarnessSettingChanged_PrintsNeitherItsNameNorItsValue()
    {
        var markdown = TrendFixture.Render(
            SuiteTrend.Build([
                WithSetting(1, "authHeader", "Bearer hunter2"),
                WithSetting(2, "authHeader", "Bearer hunter3"),
            ])
        );

        markdown.Should().NotContain("hunter2").And.NotContain("hunter3").And.NotContain("authHeader");
        markdown.Should().Contain("1 harness setting(s) this build does not recognise");
    }

    [Fact]
    public void Render_WhenTheThrottleCarriesTextRatherThanANumber_PrintsThatItIsUnrecognisedRatherThanTheText()
    {
        var markdown = TrendFixture.Render(
            SuiteTrend.Build([
                WithSetting(1, "maxConcurrency", "1"),
                WithSetting(2, "maxConcurrency", "1; Authorization: Bearer hunter2"),
            ])
        );

        markdown.Should().NotContain("hunter2");
        markdown.Should().Contain("maxConcurrency").And.Contain("an unrecognised value");
    }

    [Fact]
    public void Build_WhenIntervalMethodDisagreesAndCarriesAnUnrecognisedValue_DoesNotPrintTheValue()
    {
        var refusal = Assert.Throws<EvalCliException>(() =>
            SuiteTrend.Build([
                TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 5, 5)),
                TrendFixture.Artifact(
                    TrendFixture.Start.AddDays(1),
                    "artifacts/two.json",
                    [TrendFixture.Scenario("checkout", 5, 5)],
                    intervalMethod: "wilson; Authorization: Bearer hunter2"
                ),
            ])
        );

        refusal.Message.Should().NotContain("hunter2");
        refusal.Message.Should().Contain("intervalMethod").And.Contain("an unrecognised value");
    }

    [Fact]
    public void Build_WhenIntervalConfidenceDisagrees_PrintsTheReparsedNumberRatherThanTheRecordedText()
    {
        var refusal = Assert.Throws<EvalCliException>(() =>
            SuiteTrend.Build([
                TrendFixture.Artifact(1, TrendFixture.Scenario("checkout", 5, 5)),
                TrendFixture.Artifact(
                    TrendFixture.Start.AddDays(1),
                    "artifacts/two.json",
                    [TrendFixture.Scenario("checkout", 5, 5)],
                    confidence: 0.99
                ),
            ])
        );

        refusal.Message.Should().Contain("intervalConfidence").And.Contain("0.99");
    }

    [Fact]
    public void Build_WhenTheThrottleChanged_StillNamesItBecauseItIsARecognisedSetting()
    {
        var trend = SuiteTrend.Build([WithSetting(1, "maxConcurrency", "1"), WithSetting(2, "maxConcurrency", "8")]);

        trend.Caveats.Should().ContainSingle(caveat => caveat.Setting == "maxConcurrency");
        trend.UnnamedSettingChanges.Should().Be(0);
    }
}
