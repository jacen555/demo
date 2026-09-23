using FluentAssertions;
using Forge.EvalEngine.Loading;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Serialization;

namespace Forge.EvalEngine.Tests.Loading;

public class SuiteLoaderTests
{
    private const string MinimalSuite = """
        {
          "name": "minimal",
          "scenarios": [
            {
              "identity": { "id": "rest-once", "kind": "rest", "probeClass": "smoke" },
              "execution": { "mode": "deterministic", "repetitionPolicy": "once" },
              "simulation": { "opening": "GET /health" },
              "grading": { "expectedOutcome": "healthy", "assertions": ["statusIs:200"] },
              "selection": { "impactGlobs": ["services/**"] },
              "slicing": { "tags": { "area": "health" } }
            }
          ]
        }
        """;

    [Fact]
    public void LoadFromJson_ValidSuite_ProducesEveryScenario()
    {
        var result = SuiteLoader.LoadFromJson(MinimalSuite, "minimal.json");

        result.Succeeded.Should().BeTrue(because: string.Join("; ", result.Messages));
        result.Suite!.Name.Should().Be("minimal");
        result.Suite.Scenarios.Should().HaveCount(1);

        var scenario = result.Suite.Scenarios[0];
        scenario.Identity.Id.Should().Be("rest-once");
        scenario.Identity.Kind.Should().Be(ScenarioKind.Rest);
        scenario.Identity.ProbeClass.Should().Be("smoke");
        scenario.Execution.Mode.Should().Be(ExecutionMode.Deterministic);
        scenario.Execution.RepetitionPolicy.IsOnce.Should().BeTrue();
        scenario.Simulation.Opening.Should().Be("GET /health");
        scenario.Grading.ExpectedOutcome.Should().Be("healthy");
        scenario.Grading.Assertions.Should().ContainSingle().Which.Category.Should().Be("statusIs");
        scenario.Selection.ImpactGlobs.Should().Equal("services/**");
        scenario.Slicing.Tags.Should().Contain(new KeyValuePair<string, string>("area", "health"));
    }

    [Fact]
    public void LoadFromJson_RepetitionPolicyAsCount_ProducesThatManyRepetitions()
    {
        var json = MinimalSuite.Replace("\"once\"", "12", StringComparison.Ordinal);

        var result = SuiteLoader.LoadFromJson(json, "minimal.json");

        result.Succeeded.Should().BeTrue();
        result.Suite!.Scenarios[0].Execution.RepetitionPolicy.Repetitions.Should().Be(12);
    }

    [Fact]
    public void LoadFromJson_RepetitionCountBelowOne_ReportsAnErrorNamingTheScenario()
    {
        var json = MinimalSuite.Replace("\"once\"", "0", StringComparison.Ordinal);

        var result = SuiteLoader.LoadFromJson(json, "minimal.json");

        result.Succeeded.Should().BeFalse();
        result.Messages.Should().Contain(m => m.ScenarioId == "rest-once" && m.Severity == ValidationSeverity.Error);
    }

    [Fact]
    public void LoadFromJson_MalformedAssertionExpression_ReportsAnErrorNamingTheScenario()
    {
        var json = MinimalSuite.Replace("\"statusIs:200\"", "\":200\"", StringComparison.Ordinal);

        var result = SuiteLoader.LoadFromJson(json, "minimal.json");

        result.Succeeded.Should().BeFalse();
        result.Messages.Should().Contain(m => m.ScenarioId == "rest-once" && m.Severity == ValidationSeverity.Error);
    }

    [Fact]
    public void LoadFromJson_DuplicateScenarioIds_ReportsAnErrorNamingTheScenario()
    {
        var json = """
            {
              "name": "dupes",
              "scenarios": [
                { "identity": { "id": "same", "kind": "rest" }, "execution": { "mode": "live" }, "simulation": { "opening": "a" } },
                { "identity": { "id": "same", "kind": "rest" }, "execution": { "mode": "live" }, "simulation": { "opening": "b" } }
              ]
            }
            """;

        var result = SuiteLoader.LoadFromJson(json, "dupes.json");

        result.Succeeded.Should().BeFalse();
        result.Messages.Should().Contain(m => m.Code == "scenario.id.duplicate" && m.ScenarioId == "same");
    }

    [Fact]
    public void LoadFromJson_BlankScenarioId_ReportsAnError()
    {
        var json = MinimalSuite.Replace("\"rest-once\"", "\"  \"", StringComparison.Ordinal);

        var result = SuiteLoader.LoadFromJson(json, "minimal.json");

        result.Succeeded.Should().BeFalse();
        result.Messages.Should().Contain(m => m.Code == "scenario.id.missing");
    }

    [Fact]
    public void LoadFromJson_DeterministicModeWithNoOpeningOrScript_ReportsAnError()
    {
        var json = """
            {
              "name": "no-stimulus",
              "scenarios": [
                { "identity": { "id": "silent", "kind": "llm" }, "execution": { "mode": "deterministic" } }
              ]
            }
            """;

        var result = SuiteLoader.LoadFromJson(json, "no-stimulus.json");

        result.Succeeded.Should().BeFalse();
        result
            .Messages.Should()
            .Contain(m => m.Code == "scenario.deterministic.noStimulus" && m.ScenarioId == "silent");
    }

    [Fact]
    public void LoadFromJson_SimulatedModeWithNoTurnCeiling_ReportsAWarningNotAnError()
    {
        var json = """
            {
              "name": "unbounded",
              "scenarios": [
                {
                  "identity": { "id": "runaway", "kind": "llm" },
                  "execution": { "mode": "simulated" },
                  "simulation": { "opening": "hello" }
                }
              ]
            }
            """;

        var result = SuiteLoader.LoadFromJson(json, "unbounded.json");

        result.Succeeded.Should().BeTrue();
        result
            .Messages.Should()
            .Contain(m => m.Code == "scenario.terminalCondition.unbounded" && m.Severity == ValidationSeverity.Warning);
    }

    [Fact]
    public void LoadFromJson_NoScenarios_ReportsAWarningNotAnError()
    {
        var result = SuiteLoader.LoadFromJson("""{ "name": "empty", "scenarios": [] }""", "e.json");

        result.Succeeded.Should().BeTrue();
        result.Messages.Should().Contain(m => m.Code == "suite.scenarios.empty");
    }

    [Fact]
    public void LoadFromJson_MalformedDocument_ReportsAnErrorAndNoSuite()
    {
        var result = SuiteLoader.LoadFromJson("{ not json", "broken.json");

        result.Succeeded.Should().BeFalse();
        result.Suite.Should().BeNull();
        result.Messages.Should().Contain(m => m.Code == "suite.malformed");
    }

    [Fact]
    public void LoadFromJson_MissingSuiteName_ReportsAnError()
    {
        var result = SuiteLoader.LoadFromJson("""{ "scenarios": [] }""", "unnamed.json");

        result.Succeeded.Should().BeFalse();
        result.Messages.Should().Contain(m => m.Code == "suite.name.missing");
    }

    [Fact]
    public void LoadFromJson_NullJson_ThrowsArgumentNullException()
    {
        Action load = () => SuiteLoader.LoadFromJson(null!, "x.json");

        load.Should().Throw<ArgumentNullException>();
    }

    // -------------------------------------------------------------------------------------------
    // Malformed entries are findings, never exceptions. Every one of these is untrusted input.
    // -------------------------------------------------------------------------------------------

    [Theory]
    [InlineData("42")]
    [InlineData("\"rest-once\"")]
    [InlineData("true")]
    [InlineData("null")]
    [InlineData("[]")]
    public void LoadFromJson_ScenarioEntryIsNotAnObject_ReportsAnErrorRatherThanThrowing(string entry)
    {
        var json = $$"""{ "name": "malformed", "scenarios": [ {{entry}} ] }""";

        var act = () => SuiteLoader.LoadFromJson(json, "malformed.json");

        var result = act.Should().NotThrow().Subject;
        result.Succeeded.Should().BeFalse();
        result.Messages.Should().Contain(m => m.Code == "scenario.malformed");
    }

    [Theory]
    [InlineData("identity")]
    [InlineData("execution")]
    [InlineData("simulation")]
    [InlineData("grading")]
    [InlineData("selection")]
    [InlineData("slicing")]
    public void LoadFromJson_RequiredSubRecordIsNull_ReportsAnErrorRatherThanThrowing(string member)
    {
        var members = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["identity"] = """{ "id": "nulls", "kind": "rest" }""",
            ["execution"] = """{ "mode": "deterministic" }""",
            ["simulation"] = """{ "opening": "GET /health" }""",
            ["grading"] = """{ "assertions": ["statusIs:200"] }""",
            ["selection"] = """{ "impactGlobs": [] }""",
            ["slicing"] = """{ "tags": {} }""",
        };
        members[member] = "null";
        var entry = string.Join(", ", members.Select(m => $"\"{m.Key}\": {m.Value}"));
        var json = $$"""{ "name": "null-members", "scenarios": [ { {{entry}} } ] }""";

        var act = () => SuiteLoader.LoadFromJson(json, "null-members.json");

        var result = act.Should().NotThrow().Subject;
        result.Succeeded.Should().BeFalse();
        result.Messages.Should().Contain(m => m.Severity == ValidationSeverity.Error);
    }

    [Fact]
    public void LoadFromJson_DuplicateKeysAtTheSuiteLevel_ReportsAnErrorRatherThanThrowing()
    {
        var json = """{ "name": "first", "name": "second", "scenarios": [] }""";

        var act = () => SuiteLoader.LoadFromJson(json, "dupe-keys.json");

        var result = act.Should().NotThrow().Subject;
        result.Succeeded.Should().BeFalse();
        result.Messages.Should().Contain(m => m.Code == "suite.malformed");
    }

    [Fact]
    public void LoadFromJson_DuplicateKeysInsideAScenario_ReportsAnErrorRatherThanThrowing()
    {
        var json = """
            {
              "name": "dupes",
              "scenarios": [
                {
                  "identity": { "id": "a", "kind": "rest" },
                  "identity": { "id": "b", "kind": "rest" },
                  "execution": { "mode": "live" }
                }
              ]
            }
            """;

        var act = () => SuiteLoader.LoadFromJson(json, "dupe-keys.json");

        var result = act.Should().NotThrow().Subject;
        result.Succeeded.Should().BeFalse();
        result.Messages.Should().Contain(m => m.Code == "scenario.malformed");
    }

    [Fact]
    public void LoadFromJson_RequiredIdentityFieldIsNull_ReportsAnErrorRatherThanThrowing()
    {
        var json = """
            {
              "name": "null-id",
              "scenarios": [
                { "identity": { "id": null, "kind": "rest" }, "execution": { "mode": "live" } }
              ]
            }
            """;

        var act = () => SuiteLoader.LoadFromJson(json, "null-id.json");

        var result = act.Should().NotThrow().Subject;
        result.Succeeded.Should().BeFalse();
    }

    // -------------------------------------------------------------------------------------------
    // A null element, a blank stimulus and a conflicting alias are all untrusted input arriving in
    // a shape the types say is impossible. Each one is refused with a finding that names the
    // scenario; none of them may escape as a throw or, worse, be quietly accepted.
    // -------------------------------------------------------------------------------------------

    [Fact]
    public void LoadFromJson_NullAssertionElement_ReportsAnErrorRatherThanThrowing()
    {
        var json = """
            {
              "name": "null-assertion",
              "scenarios": [
                {
                  "identity": { "id": "nulls", "kind": "rest" },
                  "execution": { "mode": "deterministic" },
                  "simulation": { "opening": "GET /health" },
                  "grading": { "assertions": [null] }
                }
              ]
            }
            """;

        var act = () => SuiteLoader.LoadFromJson(json, "null-assertion.json");

        var result = act.Should().NotThrow().Subject;
        result.Succeeded.Should().BeFalse();
        result.Messages.Should().Contain(m => m.Code == "scenario.malformed" && m.ScenarioId == "nulls");
    }

    [Fact]
    public void LoadFromJson_NullScriptedStimulusElement_ReportsAnErrorRatherThanThrowing()
    {
        var act = () => SuiteLoader.LoadFromJson(SuiteWithScript("[null]"), "null-stimulus.json");

        var result = act.Should().NotThrow().Subject;
        result.Succeeded.Should().BeFalse();
        result.Messages.Should().Contain(m => m.Code == "scenario.malformed" && m.ScenarioId == "scripted");
    }

    [Theory]
    [InlineData("""["   "]""")]
    [InlineData("""[{ "text": "  " }]""")]
    [InlineData("""[""]""")]
    public void LoadFromJson_BlankScriptedStimulus_ReportsAnErrorRatherThanAcceptingIt(string script)
    {
        var result = SuiteLoader.LoadFromJson(SuiteWithScript(script), "blank-stimulus.json");

        result.Succeeded.Should().BeFalse();
        result.Messages.Should().Contain(m => m.Code == "scenario.malformed" && m.ScenarioId == "scripted");
    }

    [Fact]
    public void LoadFromJson_BothScriptedStimuliAndItsLegacyAlias_ReportsAnErrorRatherThanDiscardingOne()
    {
        var json = """
            {
              "name": "conflicting-aliases",
              "scenarios": [
                {
                  "identity": { "id": "scripted", "kind": "llm" },
                  "execution": { "mode": "deterministic" },
                  "simulation": {
                    "opening": "hello",
                    "scriptedStimuli": ["canonical"],
                    "scriptedAnswers": ["legacy"]
                  },
                  "grading": { "assertions": [{ "expression": "statusIs:200", "turn": 1 }] }
                }
              ]
            }
            """;

        var result = SuiteLoader.LoadFromJson(json, "conflicting-aliases.json");

        result.Succeeded.Should().BeFalse();
        result.Messages.Should().Contain(m => m.Code == "scenario.malformed" && m.ScenarioId == "scripted");
    }

    private static string SuiteWithScript(string scriptJson) =>
        $$"""
            {
              "name": "scripted",
              "scenarios": [
                {
                  "identity": { "id": "scripted", "kind": "llm" },
                  "execution": { "mode": "deterministic" },
                  "simulation": { "opening": "hello", "scriptedStimuli": {{scriptJson}} },
                  "grading": { "assertions": [{ "expression": "statusIs:200", "turn": 1 }] }
                }
              ]
            }
            """;

    [Fact]
    public void LoadFromJson_OneMalformedEntry_StillReportsFindingsForTheRest()
    {
        var json = """
            {
              "name": "mixed",
              "scenarios": [
                42,
                { "identity": { "id": "", "kind": "rest" }, "execution": { "mode": "live" }, "simulation": { "opening": "a" } }
              ]
            }
            """;

        var result = SuiteLoader.LoadFromJson(json, "mixed.json");

        result.Messages.Should().Contain(m => m.Code == "scenario.malformed");
        result.Messages.Should().Contain(m => m.Code == "scenario.id.missing");
    }

    // -------------------------------------------------------------------------------------------
    // Enums are a closed set. An ordinal from a suite file is not a way into it.
    // -------------------------------------------------------------------------------------------

    [Theory]
    [InlineData("\"kind\": 99")]
    [InlineData("\"kind\": 0")]
    public void LoadFromJson_ScenarioKindAsAnInteger_ReportsAnError(string kind)
    {
        var json = $$"""
            {
              "name": "ordinal-kind",
              "scenarios": [
                { "identity": { "id": "sneaky", {{kind}} }, "execution": { "mode": "live" }, "simulation": { "opening": "a" } }
              ]
            }
            """;

        var result = SuiteLoader.LoadFromJson(json, "ordinal-kind.json");

        result.Succeeded.Should().BeFalse();
        result.Messages.Should().Contain(m => m.Code == "scenario.malformed");
    }

    [Fact]
    public void LoadFromJson_ExecutionModeAsAnInteger_ReportsAnError()
    {
        var json = """
            {
              "name": "ordinal-mode",
              "scenarios": [
                { "identity": { "id": "sneaky", "kind": "rest" }, "execution": { "mode": 2 }, "simulation": { "opening": "a" } }
              ]
            }
            """;

        var result = SuiteLoader.LoadFromJson(json, "ordinal-mode.json");

        result.Succeeded.Should().BeFalse();
        result.Messages.Should().Contain(m => m.Code == "scenario.malformed");
    }

    [Fact]
    public void LoadFromJson_UndefinedScenarioKindName_ReportsAnError()
    {
        var json = MinimalSuite.Replace("\"rest\"", "\"quantum\"", StringComparison.Ordinal);

        var result = SuiteLoader.LoadFromJson(json, "minimal.json");

        result.Succeeded.Should().BeFalse();
    }

    [Fact]
    public void LoadFromJson_EveryLoadedScenario_HasADefinedKindAndMode()
    {
        var result = SuiteLoader.LoadFromJson(MinimalSuite, "minimal.json");

        foreach (var scenario in result.Suite!.Scenarios)
        {
            Enum.IsDefined(scenario.Identity.Kind).Should().BeTrue();
            Enum.IsDefined(scenario.Execution.Mode).Should().BeTrue();
        }
    }

    // -------------------------------------------------------------------------------------------
    // Schema version. A reader that does not check it will happily misread a future shape.
    // -------------------------------------------------------------------------------------------

    [Theory]
    [InlineData("2.0")]
    [InlineData("0.9")]
    [InlineData("1.5")]
    [InlineData("not-a-version")]
    [InlineData("")]
    public void LoadFromJson_UnsupportedSuiteSchemaVersion_ReportsAnError(string version)
    {
        var json = $$"""
            { "schemaVersion": "{{version}}", "name": "versioned", "scenarios": [] }
            """;

        var result = SuiteLoader.LoadFromJson(json, "versioned.json");

        result.Succeeded.Should().BeFalse();
        result
            .Messages.Should()
            .Contain(m => m.Code == "suite.schemaVersion.unsupported" && m.Severity == ValidationSeverity.Error);
    }

    [Fact]
    public void LoadFromJson_SupportedSuiteSchemaVersion_IsAccepted()
    {
        var json = $$"""
            { "schemaVersion": "{{SchemaVersions.Suite}}", "name": "versioned", "scenarios": [] }
            """;

        var result = SuiteLoader.LoadFromJson(json, "versioned.json");

        result.Succeeded.Should().BeTrue(because: string.Join("; ", result.Messages));
        result.Messages.Should().NotContain(m => m.Code == "suite.schemaVersion.unsupported");
    }

    [Fact]
    public void LoadFromJson_MissingSuiteSchemaVersion_ReportsAWarningNotAnError()
    {
        var result = SuiteLoader.LoadFromJson(MinimalSuite, "minimal.json");

        result.Succeeded.Should().BeTrue(because: string.Join("; ", result.Messages));
        result
            .Messages.Should()
            .Contain(m => m.Code == "suite.schemaVersion.missing" && m.Severity == ValidationSeverity.Warning);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Constructor_BlankRootDirectory_ThrowsArgumentException(string root)
    {
        Action build = () => _ = new SuiteLoader(root);

        build.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void Constructor_NullRootDirectory_ThrowsArgumentNullException()
    {
        Action build = () => _ = new SuiteLoader(null!);

        build.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public async Task LoadAsync_SuiteInsideTheRoot_LoadsIt()
    {
        using var root = new TempRoot();
        root.Write("suites/minimal.json", MinimalSuite);

        var result = await new SuiteLoader(root.Path).LoadAsync("suites/minimal.json", CancellationToken.None);

        result.Succeeded.Should().BeTrue(because: string.Join("; ", result.Messages));
        result.Suite!.Scenarios.Should().ContainSingle();
    }

    [Theory]
    [InlineData("../escape.json")]
    [InlineData("suites/../../escape.json")]
    [InlineData("suites/../../../Windows/win.ini")]
    public async Task LoadAsync_PathTraversingOutsideTheRoot_ThrowsArgumentException(string suitePath)
    {
        using var root = new TempRoot();

        Func<Task> load = () => new SuiteLoader(root.Path).LoadAsync(suitePath, CancellationToken.None);

        await load.Should().ThrowAsync<ArgumentException>();
    }

    [Fact]
    public async Task LoadAsync_AbsolutePathOutsideTheRoot_ThrowsArgumentException()
    {
        using var root = new TempRoot();
        using var elsewhere = new TempRoot();
        elsewhere.Write("minimal.json", MinimalSuite);

        Func<Task> load = () =>
            new SuiteLoader(root.Path).LoadAsync(Path.Combine(elsewhere.Path, "minimal.json"), CancellationToken.None);

        await load.Should().ThrowAsync<ArgumentException>();
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public async Task LoadAsync_BlankSuitePath_ThrowsArgumentException(string suitePath)
    {
        using var root = new TempRoot();

        Func<Task> load = () => new SuiteLoader(root.Path).LoadAsync(suitePath, CancellationToken.None);

        await load.Should().ThrowAsync<ArgumentException>();
    }

    [Fact]
    public async Task LoadAsync_MissingFile_ReportsAnErrorRatherThanThrowing()
    {
        using var root = new TempRoot();

        var result = await new SuiteLoader(root.Path).LoadAsync("absent.json", CancellationToken.None);

        result.Succeeded.Should().BeFalse();
        result.Messages.Should().Contain(m => m.Code == "suite.notFound");
    }

    [Fact]
    public async Task LoadAsync_CancelledToken_ThrowsOperationCanceledException()
    {
        using var root = new TempRoot();
        root.Write("minimal.json", MinimalSuite);
        using var cancellation = new CancellationTokenSource();
        await cancellation.CancelAsync();

        Func<Task> load = () => new SuiteLoader(root.Path).LoadAsync("minimal.json", cancellation.Token);

        await load.Should().ThrowAsync<OperationCanceledException>();
    }

    // -------------------------------------------------------------------------------------------
    // Containment is about where the bytes actually come from, not about how the text reads. A
    // link inside the root that points outside it is an escape, and a lexical check cannot see it.
    // -------------------------------------------------------------------------------------------

    [Fact]
    public async Task LoadAsync_DirectoryLinkInsideTheRootPointingOutside_ThrowsArgumentException()
    {
        using var root = new TempRoot();
        using var elsewhere = new TempRoot();
        elsewhere.Write("secret.json", MinimalSuite);
        root.LinkDirectory("escape", elsewhere.Path);

        Func<Task> load = () => new SuiteLoader(root.Path).LoadAsync("escape/secret.json", CancellationToken.None);

        await load.Should().ThrowAsync<ArgumentException>();
    }

    [Fact]
    public async Task LoadAsync_NestedDirectoryLinkPointingOutside_ThrowsArgumentException()
    {
        using var root = new TempRoot();
        using var elsewhere = new TempRoot();
        elsewhere.Write("nested/secret.json", MinimalSuite);
        root.LinkDirectory("suites/escape", elsewhere.Path);

        Func<Task> load = () =>
            new SuiteLoader(root.Path).LoadAsync("suites/escape/nested/secret.json", CancellationToken.None);

        await load.Should().ThrowAsync<ArgumentException>();
    }

    [Fact]
    public async Task LoadAsync_FileLinkInsideTheRootPointingOutside_ThrowsArgumentException()
    {
        using var root = new TempRoot();
        using var elsewhere = new TempRoot();
        elsewhere.Write("secret.json", MinimalSuite);
        root.LinkFile("decoy.json", Path.Combine(elsewhere.Path, "secret.json"));

        Func<Task> load = () => new SuiteLoader(root.Path).LoadAsync("decoy.json", CancellationToken.None);

        await load.Should().ThrowAsync<ArgumentException>();
    }

    [Fact]
    public async Task LoadAsync_DirectoryLinkThatStaysInsideTheRoot_LoadsIt()
    {
        using var root = new TempRoot();
        root.Write("real/minimal.json", MinimalSuite);
        root.LinkDirectory("alias", Path.Combine(root.Path, "real"));

        var result = await new SuiteLoader(root.Path).LoadAsync("alias/minimal.json", CancellationToken.None);

        result.Succeeded.Should().BeTrue(because: string.Join("; ", result.Messages));
    }

    [Fact]
    public async Task LoadAsync_CycleOfLinks_ThrowsArgumentExceptionRatherThanLooping()
    {
        using var root = new TempRoot();
        root.LinkFile("a.json", Path.Combine(root.Path, "b.json"));
        root.LinkFile("b.json", Path.Combine(root.Path, "a.json"));

        Func<Task> load = () => new SuiteLoader(root.Path).LoadAsync("a.json", CancellationToken.None);

        await load.Should().ThrowAsync<ArgumentException>();
    }

    // -------------------------------------------------------------------------------------------
    // Inspecting a path for links reads it, and reading a path the caller chose is an action on
    // the caller's behalf — a UNC path makes it an outbound request to a host they named. So a
    // path that is already outside the root as written is refused on the text alone, before the
    // file system hears about it. Resolution is for paths that got past that check.
    // -------------------------------------------------------------------------------------------

    [Fact]
    public async Task LoadAsync_PathOutsideTheRootWhoseSegmentsAreLinks_IsRefusedBeforeTheyAreInspected()
    {
        using var root = new TempRoot();
        using var elsewhere = new TempRoot();
        elsewhere.LinkFile("a.json", Path.Combine(elsewhere.Path, "b.json"));
        elsewhere.LinkFile("b.json", Path.Combine(elsewhere.Path, "a.json"));

        Func<Task> load = () =>
            new SuiteLoader(root.Path).LoadAsync(Path.Combine(elsewhere.Path, "a.json"), CancellationToken.None);

        // The cycle out there is discoverable only by walking those links. A refusal that cites
        // the cycle is therefore proof the loader read them first; the refusal this asserts is
        // the one that needs no reading at all.
        var thrown = await load.Should().ThrowAsync<ArgumentException>();
        thrown.WithMessage("*resolves outside the suite root*");
        thrown.Which.InnerException.Should().BeNull();
    }

    [Fact]
    public async Task LoadAsync_UncPathOutsideTheRoot_IsRefusedWithoutContactingTheHost()
    {
        using var root = new TempRoot();

        Func<Task> load = () =>
            new SuiteLoader(root.Path).LoadAsync(@"\\127.0.0.1\no-such-share$\suite.json", CancellationToken.None);

        // A refusal sourced from the host's answer — reachable, unreachable, or slow — would mean
        // the request went out. Containment here is a property of the text.
        var thrown = await load.Should().ThrowAsync<ArgumentException>();
        thrown.WithMessage("*resolves outside the suite root*");
        thrown.Which.InnerException.Should().BeNull();
    }

    // -------------------------------------------------------------------------------------------
    // A link is a re-entry into path resolution, so the rule the entry point applies has to hold
    // again at every link along the way: a target is shown to be inside the root before it is
    // walked, never after. Walking it is itself the harm rather than a step towards discovering
    // one — write access to the suite root buys an attacker wrong eval results, which validation
    // is there to surface, but it does not buy the loader's network access, and a link target is
    // a path the loader reads on the attacker's say-so.
    // -------------------------------------------------------------------------------------------

    [Fact]
    public async Task LoadAsync_LinkInsideTheRootPointingAtAnOutsideCycle_IsRefusedWithoutFollowingTheTarget()
    {
        using var root = new TempRoot();
        using var elsewhere = new TempRoot();
        elsewhere.LinkFile("a.json", Path.Combine(elsewhere.Path, "b.json"));
        elsewhere.LinkFile("b.json", Path.Combine(elsewhere.Path, "a.json"));
        root.LinkFile("entry.json", Path.Combine(elsewhere.Path, "a.json"));

        Func<Task> load = () => new SuiteLoader(root.Path).LoadAsync("entry.json", CancellationToken.None);

        // Same tell as at the entry point: the cycle out there is discoverable only by following
        // the target, so a refusal citing it is proof the target was walked. The refusal asserted
        // here is the one the link's own metadata already supports.
        var thrown = await load.Should().ThrowAsync<ArgumentException>();
        thrown.WithMessage("*resolves outside the suite root*");
        thrown.Which.InnerException.Should().BeNull();
    }

    [Fact]
    public async Task LoadAsync_LinkInsideTheRootPointingAtAUncPath_IsRefusedWithoutContactingTheHost()
    {
        using var root = new TempRoot();

        // A host name nothing has resolved before, so a cached negative answer cannot stand in for
        // a request that really does leave the machine.
        root.LinkFile("decoy.json", $@"\\forge-eval-{Guid.NewGuid():N}\share\suite.json");

        Func<Task> load = () => new SuiteLoader(root.Path).LoadAsync("decoy.json", CancellationToken.None);

        // Reading a link's own metadata does not touch what it points at; walking into the target
        // does, and against a UNC target that walk is an outbound request to a host the attacker
        // named. "The network path was not found" is an answer only the network can give, so a
        // refusal carrying it as its cause would mean the request went out. This one is sourced
        // from the text of the target instead.
        var thrown = await load.Should().ThrowAsync<ArgumentException>();
        thrown.WithMessage("*resolves outside the suite root*");
        thrown.Which.InnerException.Should().BeNull();
    }

    [Fact]
    public async Task LoadAsync_LinkInsideTheRootWithARelativeTargetThatStaysInside_LoadsIt()
    {
        using var root = new TempRoot();
        root.Write("real/minimal.json", MinimalSuite);
        root.LinkFile("alias.json", Path.Combine("real", "minimal.json"));

        // Refusing early must not become refusing everything: a target is judged as the path it
        // actually denotes, which for a relative target is resolved against the link's own
        // directory rather than the process's working directory.
        var result = await new SuiteLoader(root.Path).LoadAsync("alias.json", CancellationToken.None);

        result.Succeeded.Should().BeTrue(because: string.Join("; ", result.Messages));
    }

    // -------------------------------------------------------------------------------------------
    // "I could not inspect this segment, therefore it is not a link" is backwards. Containment is
    // a claim the loader has to be able to prove, so a segment whose link status cannot be
    // established is refused — while a segment that is confirmed absent stays an ordinary
    // not-found, because those are two different answers and only one of them is a hazard.
    // -------------------------------------------------------------------------------------------

    [Fact]
    public async Task LoadAsync_SegmentThatCannotBeInspected_ThrowsArgumentExceptionRatherThanAssumingItIsNotALink()
    {
        using var root = new TempRoot();
        root.Write("locked/minimal.json", MinimalSuite);

        if (!root.TryDenyAccess("locked", "locked/minimal.json"))
        {
            // The environment would not honour the deny, so it cannot host this test. Every other
            // containment test still runs.
            return;
        }

        Func<Task> load = () => new SuiteLoader(root.Path).LoadAsync("locked/minimal.json", CancellationToken.None);

        await load.Should().ThrowAsync<ArgumentException>();
    }

    [Fact]
    public async Task LoadAsync_SegmentBeneathAFile_ReportsNotFoundRatherThanRefusing()
    {
        using var root = new TempRoot();
        root.Write("real.json", MinimalSuite);

        var result = await new SuiteLoader(root.Path).LoadAsync("real.json/child.json", CancellationToken.None);

        result.Messages.Should().Contain(m => m.Code == "suite.notFound");
    }

    [Fact]
    public async Task LoadAsync_MissingNestedDirectory_ReportsNotFoundRatherThanRefusing()
    {
        using var root = new TempRoot();

        var result = await new SuiteLoader(root.Path).LoadAsync("absent/nested/minimal.json", CancellationToken.None);

        result.Messages.Should().Contain(m => m.Code == "suite.notFound");
    }

    private sealed class TempRoot : IDisposable
    {
        private readonly List<string> _denied = [];

        public TempRoot()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), System.IO.Path.GetRandomFileName());
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void Write(string relativePath, string content)
        {
            var full = System.IO.Path.Combine(Path, relativePath);
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(full)!);
            File.WriteAllText(full, content);
        }

        public void LinkDirectory(string relativePath, string target)
        {
            var full = Prepare(relativePath);

            try
            {
                Directory.CreateSymbolicLink(full, target);
            }
            catch (Exception exception) when (exception is UnauthorizedAccessException or IOException)
            {
                CreateJunction(full, target);
            }
        }

        public void LinkFile(string relativePath, string target)
        {
            var full = Prepare(relativePath);

            File.CreateSymbolicLink(full, target);
        }

        /// <summary>
        /// Makes a directory inside the root unreadable, and reports whether that actually took
        /// effect — an environment that will not honour the deny cannot host a test that needs it.
        /// </summary>
        public bool TryDenyAccess(string relativeDirectory, string probeRelativePath)
        {
            var full = System.IO.Path.Combine(Path, relativeDirectory);
            _denied.Add(full);
            RunIcacls(full, "/deny", $"{Environment.UserName}:(OI)(CI)(RX)");

            try
            {
                _ = File.GetAttributes(System.IO.Path.Combine(Path, probeRelativePath));
                return false;
            }
            catch (UnauthorizedAccessException)
            {
                return true;
            }
            catch (IOException)
            {
                return false;
            }
        }

        public void Dispose()
        {
            foreach (var denied in _denied)
            {
                RunIcacls(denied, "/remove:d", Environment.UserName);
            }

            if (Directory.Exists(Path))
            {
                Directory.Delete(Path, recursive: true);
            }
        }

        private static void RunIcacls(string target, params string[] arguments)
        {
            var startInfo = new System.Diagnostics.ProcessStartInfo("icacls")
            {
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            startInfo.ArgumentList.Add(target);
            foreach (var argument in arguments)
            {
                startInfo.ArgumentList.Add(argument);
            }

            using var process = System.Diagnostics.Process.Start(startInfo);
            process?.WaitForExit();
        }

        private string Prepare(string relativePath)
        {
            var full = System.IO.Path.Combine(Path, relativePath);
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(full)!);
            return full;
        }

        private static void CreateJunction(string link, string target)
        {
            using var process =
                System.Diagnostics.Process.Start(
                    new System.Diagnostics.ProcessStartInfo("cmd.exe", ["/c", "mklink", "/J", link, target])
                    {
                        CreateNoWindow = true,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                    }
                ) ?? throw new InvalidOperationException("could not start cmd.exe to create a junction.");

            process.WaitForExit();

            if (!Directory.Exists(link))
            {
                throw new InvalidOperationException($"could not create a directory link at '{link}'.");
            }
        }
    }
}
