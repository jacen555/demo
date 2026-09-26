using FluentAssertions;
using Forge.EvalEngine.Coordination;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Serialization;

namespace Forge.EvalEngine.Tests.Coordination;

/// <summary>
/// The settings a verdict is only meaningful relative to.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="Results.EvaluationEnvironment.HarnessConfig"/> is what
/// <see cref="Comparison.SuiteComparator"/> refuses two unlike runs on, so a verdict-bearing
/// setting that never reaches it is a setting two runs may silently disagree about. The
/// coordinator can only record what it can see: its own throttle and its own interval
/// parameters. Transport timeouts, model temperature, and adapter strictness are configured on
/// runners and participants the coordinator holds only as interfaces — so a composition root
/// that knows them states them, and they travel into the artifact beside the ones this layer
/// owns.
/// </para>
/// <para>
/// The keys this layer owns are not caller-settable. Two sources of truth for one setting is the
/// defect the whole surface exists to prevent, so a caller that names one is refused at
/// construction rather than silently overwritten at write time.
/// </para>
/// </remarks>
public sealed class RunCoordinatorHarnessConfigTests
{
    private static Dictionary<string, string> Config(params (string Key, string Value)[] entries) =>
        entries.ToDictionary(entry => entry.Key, entry => entry.Value, StringComparer.Ordinal);

    // -----------------------------------------------------------------------------------------
    // What the coordinator records on its own.
    // -----------------------------------------------------------------------------------------

    [Fact]
    public async Task RunAsync_Always_RecordsTheSettingsThisLayerOwns()
    {
        var result = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)])
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario()), default);

        result
            .Environment.HarnessConfig.Keys.Should()
            .Contain(["maxConcurrency", "intervalMethod", "intervalConfidence"]);
    }

    // -----------------------------------------------------------------------------------------
    // What only the composition root can see.
    // -----------------------------------------------------------------------------------------

    [Fact]
    public async Task RunAsync_CallerSuppliedHarnessSettings_RecordsThemBesideTheOnesThisLayerOwns()
    {
        var options = new RunCoordinatorOptions
        {
            HarnessConfig = Config(("restTimeoutSeconds", "30"), ("modelTemperature", "0")),
        };

        var result = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)], options: options)
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario()), default);

        result
            .Environment.HarnessConfig.Should()
            .Contain("restTimeoutSeconds", "30")
            .And.Contain("modelTemperature", "0");
        result.Environment.HarnessConfig.Should().ContainKey("maxConcurrency");
    }

    [Fact]
    public async Task RunAsync_CallerSuppliedHarnessSettings_SurvivesCanonicalSerialization()
    {
        var options = new RunCoordinatorOptions { HarnessConfig = Config(("restTimeoutSeconds", "30")) };

        var result = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)], options: options)
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario()), default);

        CanonicalJson
            .DeserializeSuiteResult(CanonicalJson.Serialize(result))
            .Environment.HarnessConfig.Should()
            .Contain("restTimeoutSeconds", "30");
    }

    /// <summary>
    /// An exact reserved key is trusted because this library chose it. A prefix match is not.
    /// </summary>
    /// <remarks>
    /// <c>runner.note /home/ci-user/repo</c> passes the prefix test, and the suffix after
    /// <c>runner.</c> is entirely caller-supplied — so quoting the whole key back puts a machine
    /// path into a build-log-bound message, ahead of the serialization guard that would have
    /// refused it. The null-value refusal beside this one already states the rule rather than the
    /// value; a fix that closed that hole and opened this one in the same round is the shape
    /// worth naming.
    /// </remarks>
    [Theory]
    [InlineData("runner.note /home/ci-user/repo")]
    [InlineData(@"runner.rest.root C:\Users\ci-user\repo")]
    public void HarnessConfig_PrefixMatchedKeyNamingAMachinePath_IsRefusedWithoutRepeatingTheKey(string key)
    {
        // A non-null value, because the null path is refused earlier and would not reach the
        // reservation branch this test is about.
        var entries = new Dictionary<string, string>(StringComparer.Ordinal) { [key] = "12" };

        var act = () => new RunCoordinatorOptions { HarnessConfig = entries };

        var thrown = act.Should().Throw<ArgumentException>().Which;
        thrown.Message.Should().NotContain("/home/ci-user").And.NotContain("Users").And.NotContain(key);
        thrown.Message.Should().Contain("runner.");
    }

    /// <summary>An exactly-matching reserved key is this library's own text, so it may be named.</summary>
    [Theory]
    [InlineData("maxConcurrency")]
    [InlineData("intervalMethod")]
    [InlineData("seedDerivation")]
    public void HarnessConfig_ExactlyReservedKey_IsNamedBecauseThisLibraryChoseIt(string key)
    {
        var act = () =>
            new RunCoordinatorOptions
            {
                HarnessConfig = new Dictionary<string, string>(StringComparer.Ordinal) { [key] = "whatever" },
            };

        act.Should().Throw<ArgumentException>().Which.Message.Should().Contain(key);
    }

    /// <summary>
    /// The caller's own settings are guarded here, where they enter, and not only at the writer.
    /// </summary>
    /// <remarks>
    /// Found by auditing this round's own fix for the class it fixes. A machine path admitted
    /// here reaches the artifact <i>and</i> the comparator's refusal message, which quotes the
    /// key of a setting two runs disagree on. Refusing at the options boundary closes both, and
    /// has no ordering conflict with the read door: nothing deserializes into this type.
    /// </remarks>
    [Theory]
    [InlineData("suiteRoot", "/home/ci-user/repo")]
    [InlineData("/home/ci-user/repo", "30")]
    [InlineData("deploymentRoot", @"C:\Users\ci-user\repo")]
    public void HarnessConfig_NamingAMachinePath_IsRefusedWithoutRepeatingTheValue(string key, string value)
    {
        var entries = new Dictionary<string, string>(StringComparer.Ordinal) { [key] = value };

        var act = () => new RunCoordinatorOptions { HarnessConfig = entries };

        act.Should()
            .Throw<ArgumentException>()
            .Which.Message.Should()
            .NotContain("/home/ci-user")
            .And.NotContain("Users");
    }

    [Fact]
    public void HarnessConfig_NotSupplied_DefaultsToNoAdditionalSettings()
    {
        RunCoordinatorOptions.Default.HarnessConfig.Should().BeEmpty();
    }

    // -----------------------------------------------------------------------------------------
    // The boundary: this is caller-supplied text bound for a committed artifact (§V).
    // -----------------------------------------------------------------------------------------

    [Theory]
    [InlineData("maxConcurrency")]
    [InlineData("intervalMethod")]
    [InlineData("intervalConfidence")]
    public void HarnessConfig_NamingASettingTheCoordinatorOwns_IsRefusedRatherThanSilentlyOverwritten(string key)
    {
        var act = () => new RunCoordinatorOptions { HarnessConfig = Config((key, "whatever")) };

        act.Should().Throw<ArgumentException>().WithMessage($"*{key}*");
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void HarnessConfig_CarryingABlankKey_IsRefused(string key)
    {
        var act = () => new RunCoordinatorOptions { HarnessConfig = Config((key, "30")) };

        act.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void HarnessConfig_CarryingANullKey_IsRefused()
    {
        var act = () => new RunCoordinatorOptions { HarnessConfig = new NullKeyedConfig() };

        act.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void HarnessConfig_CarryingANullValue_IsRefused()
    {
        var entries = new Dictionary<string, string>(StringComparer.Ordinal) { ["restTimeoutSeconds"] = null! };

        var act = () => new RunCoordinatorOptions { HarnessConfig = entries };

        act.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void HarnessConfig_SetToNull_IsRefused()
    {
        var act = () => new RunCoordinatorOptions { HarnessConfig = null! };

        act.Should().Throw<ArgumentNullException>();
    }

    /// <summary>
    /// The recorded map is a snapshot, not the caller's dictionary.
    /// </summary>
    /// <remarks>
    /// A caller holding a reference to a mutable dictionary could otherwise change what the
    /// artifact says the run was conducted under, after the validation that admitted it and
    /// after the run it describes.
    /// </remarks>
    [Fact]
    public async Task RunAsync_CallerMutatesTheDictionaryAfterConstruction_RecordsWhatWasValidated()
    {
        var entries = new Dictionary<string, string>(StringComparer.Ordinal) { ["restTimeoutSeconds"] = "30" };
        var options = new RunCoordinatorOptions { HarnessConfig = entries };

        entries["restTimeoutSeconds"] = "300";
        entries["maxConcurrency"] = "64";

        var result = await CoordinatorFixtures
            .Coordinator([new StubRunner(ScenarioKind.Rest)], options: options)
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario()), default);

        result.Environment.HarnessConfig.Should().Contain("restTimeoutSeconds", "30");
        result.Environment.HarnessConfig["maxConcurrency"].Should().Be("1");
    }

    /// <summary>A dictionary that yields a null key, which a plain one cannot hold.</summary>
    private sealed class NullKeyedConfig : IReadOnlyDictionary<string, string>
    {
        public IEnumerable<string> Keys => [null!];

        public IEnumerable<string> Values => ["30"];

        public int Count => 1;

        public string this[string key] => "30";

        public bool ContainsKey(string key) => false;

        public bool TryGetValue(string key, out string value)
        {
            value = "30";
            return false;
        }

        public IEnumerator<KeyValuePair<string, string>> GetEnumerator()
        {
            yield return new KeyValuePair<string, string>(null!, "30");
        }

        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
    }
}
