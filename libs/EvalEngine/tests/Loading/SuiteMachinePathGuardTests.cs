using System.Text.Json;
using System.Text.Json.Nodes;
using FluentAssertions;
using Forge.EvalEngine.Loading;

namespace Forge.EvalEngine.Tests.Loading;

/// <summary>
/// The machine-path guard on author-supplied identifiers.
/// </summary>
/// <remarks>
/// <para>
/// A suite name, a scenario id, and a slicing tag are free text written by whoever wrote the
/// suite, and every one of them is carried into a committed JSON artifact; the first two are also
/// rendered into a published pull-request comment. A path such as <c>/home/ci-user/repo</c> names
/// the account a job runs as and the layout of the machine it runs on (§V).
/// </para>
/// <para>
/// <b>The guard refuses; it never rewrites.</b> Deciding what is a path inside arbitrary free
/// text is under-constrained — the consuming report spent five rounds proving it. An identifier is
/// authored once, in a committed file, so it can be refused and the author told to rename it.
/// </para>
/// <para>
/// <b>The refusal never repeats the value.</b> A finding is written to standard error and lands in
/// CI logs, which on many setups are readable by anyone who can read the repository. A guard that
/// prints the path it refused has moved the disclosure rather than removed it, so findings name
/// the offending <i>field</i> and the scenario's <i>position</i> instead.
/// </para>
/// </remarks>
public class SuiteMachinePathGuardTests
{
    private const string ScenarioCode = "scenario.id.machinePath";
    private const string SuiteCode = "suite.name.machinePath";
    private const string TagCode = "scenario.tag.machinePath";

    private static string SuiteWith(string scenarioId, string name = "regression", string? tags = null) =>
        $$"""
            {
              "name": {{JsonSerializer.Serialize(name)}},
              "scenarios": [
                {
                  "identity": { "id": {{JsonSerializer.Serialize(scenarioId)}}, "kind": "rest" },
                  "execution": { "mode": "live" },
                  "simulation": { "opening": "GET /health" },
                  "slicing": { "tags": {{tags ?? "{}"}} }
                }
              ]
            }
            """;

    public static TheoryData<string> MachinePaths() =>
        [
            @"C:\Users\ci-user\repo",
            @"c:\build\agent\work",
            "D:/build/agent/work",
            @"\\build-host\share\repo",
            "/home/ci-user/repo",
            "/Users/ci-user/repo",
            "/root/.cache/agent",
            "/var/lib/agent",
            "/tmp/build-1234",
            "/mnt/d/work",
            "/opt/agent/bin",
            "/srv/ci/checkout",
            "//home/ci-user/repo",
            "///Users/ci-user/repo",
            "  /home/ci-user/repo",
            "\t/home/ci-user/repo",
            @"   C:\Users\ci-user\repo",
        ];

    /// <summary>
    /// Identifiers that must keep loading, unchanged.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>/api/v1/refund</c> is the headline case: the report-side pattern destroys it today.
    /// <c>/users/{id}/orders</c> is what fixes the root comparison as <b>case-sensitive</b> — the
    /// macOS home root is <c>/Users</c> and the canonical REST collection route is <c>/users</c>,
    /// and no case-insensitive rule keeps both.
    /// </para>
    /// <para>
    /// <c>/media/upload</c> and <c>/workspace/42</c> are here because <c>media</c> and
    /// <c>workspace</c> are ordinary REST resource names before they are system directories.
    /// <c>/api/v1/tmp/cleanup</c> is here because a system root appearing as an <i>interior</i>
    /// segment is a route, not a path.
    /// </para>
    /// </remarks>
    public static TheoryData<string> Identifiers() =>
        [
            "/api/v1/refund",
            "/checkout",
            "/orders/{id}/refund",
            "/users/{id}/orders",
            "/media/upload",
            "/workspace/42",
            "/api/v1/media/upload",
            "/api/v1/tmp/cleanup",
            "/Home/dashboard",
            "/home",
            "/home/",
            "/var",
            "X:12",
            "refund-flow",
            "https://api.example.com/v1/refund",
            "https://home/dashboard",
        ];

    [Theory]
    [MemberData(nameof(MachinePaths))]
    public void LoadFromJson_ScenarioIdIsAMachinePath_IsRefusedWithoutRepeatingTheValue(string scenarioId)
    {
        var result = SuiteLoader.LoadFromJson(SuiteWith(scenarioId), "regression.json");

        result.Succeeded.Should().BeFalse();

        var finding = result.Messages.Should().ContainSingle(message => message.Code == ScenarioCode).Subject;
        finding.Severity.Should().Be(ValidationSeverity.Error);
        finding.ScenarioId.Should().BeNull(because: "a finding is written to CI logs; it must not carry the path");
        finding.Message.Should().NotContain(scenarioId.Trim()).And.Contain("#1").And.Contain("rename");
        finding.ToString().Should().NotContain(scenarioId.Trim());
    }

    [Theory]
    [MemberData(nameof(Identifiers))]
    public void LoadFromJson_OrdinaryScenarioId_LoadsUnchanged(string scenarioId)
    {
        var result = SuiteLoader.LoadFromJson(SuiteWith(scenarioId), "regression.json");

        result.Succeeded.Should().BeTrue(because: string.Join("; ", result.Messages));
        result.Suite!.Scenarios[0].Identity.Id.Should().Be(scenarioId);
    }

    /// <summary>
    /// A machine path is refused wherever a token of the value starts with one.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>checkout path:/home/ci-user/repo</c> is a live end-to-end leak: the report-side pattern
    /// excludes <c>:</c> to protect <c>https://</c>, so it reaches the published comment untouched.
    /// Anchoring only at the very start of the value would leave it open here too.
    /// </para>
    /// <para>
    /// The boundary is a <b>token</b> boundary, not "anywhere". Whitespace starts a new token, and
    /// so does a <c>label:</c> separator — but a <c>/</c> does not, which is what keeps
    /// <c>/api/v1/media/upload</c> loading. A <c>://</c> is an address authority rather than a
    /// label, so it is excluded.
    /// </para>
    /// </remarks>
    [Theory]
    [InlineData("checkout path:/home/ci-user/repo")]
    [InlineData("checkout /home/ci-user/repo")]
    [InlineData("built at   /Users/ci-user/repo")]
    [InlineData(@"checkout C:\Users\ci-user\repo")]
    public void LoadFromJson_ScenarioIdCarriesAMachinePathToken_IsRefused(string scenarioId)
    {
        var result = SuiteLoader.LoadFromJson(SuiteWith(scenarioId), "regression.json");

        result.Succeeded.Should().BeFalse();
        result.Messages.Should().Contain(message => message.Code == ScenarioCode);
    }

    [Theory]
    [InlineData(@"C:\Users\ci-user\suites")]
    [InlineData("/home/ci-user/suites")]
    [InlineData("checkout /home/ci-user/build regression")]
    public void LoadFromJson_SuiteNameIsAMachinePath_IsRefusedWithoutRepeatingTheValue(string name)
    {
        var result = SuiteLoader.LoadFromJson(SuiteWith("refund-flow", name), "regression.json");

        result.Succeeded.Should().BeFalse();

        var finding = result.Messages.Should().ContainSingle(message => message.Code == SuiteCode).Subject;
        finding.Severity.Should().Be(ValidationSeverity.Error);
        finding.ScenarioId.Should().BeNull();
        finding.Message.Should().NotContain(name.Trim()).And.Contain("name").And.Contain("rename");
        finding.ToString().Should().NotContain(name.Trim());
    }

    /// <summary>
    /// The refusal names no path of its own either.
    /// </summary>
    /// <remarks>
    /// <c>sourceName</c> is whatever path the caller asked to load, and through the command-line
    /// tool that is an absolute one — <c>C:\Users\someone\...</c>. Interpolating it into the very
    /// finding that exists to keep an account name out of the build log reintroduces the
    /// disclosure one field over. Caught by reading real output, not by reasoning about it.
    /// </remarks>
    [Fact]
    public void LoadFromJson_RefusedSuiteName_NamesNeitherTheValueNorTheSuitePath()
    {
        var source = @"C:\Users\ci-user\AppData\Local\Temp\suites\regression.json";

        var result = SuiteLoader.LoadFromJson(SuiteWith("refund-flow", "/home/ci-user/suites"), source);

        var finding = result.Messages.Should().ContainSingle(message => message.Code == SuiteCode).Subject;
        finding.ToString().Should().NotContain("ci-user").And.NotContain("Users").And.NotContain("AppData");
    }

    /// <summary>
    /// A leading HTTP method token exempts the route it addresses.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>METHOD /route</c> is idiomatic in this domain — this repository's own fixtures use
    /// <c>GET /health</c> — and without an exemption the token rule refuses
    /// <c>GET /home/dashboard</c>. Keeping <c>home</c> in the allowlist matters more:
    /// <c>/home/&lt;account&gt;</c> is the classic CI disclosure, so the exemption is the narrower
    /// concession than dropping the root.
    /// </para>
    /// <para>
    /// <b>The exemption necessarily admits <c>GET /home/ci-user/repo</c> too.</b> Nothing in the
    /// text separates that from <c>GET /home/dashboard</c> — that is the same under-constraint
    /// this guard exists to avoid pretending it can solve. The concession is bounded to exactly
    /// one token after exactly one leading method.
    /// </para>
    /// </remarks>
    [Theory]
    [InlineData("GET /home/dashboard")]
    [InlineData("POST /home/dashboard")]
    [InlineData("PUT /var/config")]
    [InlineData("PATCH /tmp/draft")]
    [InlineData("DELETE /home/session")]
    [InlineData("HEAD /home/dashboard")]
    [InlineData("OPTIONS /home/dashboard")]
    [InlineData("TRACE /home/dashboard")]
    [InlineData("CONNECT /home/dashboard")]
    [InlineData("GET /health")]
    [InlineData("GET")]
    public void LoadFromJson_ScenarioIdIsAMethodAndRoute_Loads(string scenarioId)
    {
        var result = SuiteLoader.LoadFromJson(SuiteWith(scenarioId), "regression.json");

        result.Succeeded.Should().BeTrue(because: string.Join("; ", result.Messages));
        result.Suite!.Scenarios[0].Identity.Id.Should().Be(scenarioId);
    }

    /// <summary>
    /// The exemption is a closed set of methods, matched exactly, in the leading position only.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Every one of these would load if the exemption were "a word followed by a path", which is
    /// the label hole reopened under another name. <c>FETCH</c> is not an HTTP method;
    /// <c>GETX</c> merely starts with one; <c>get</c> and <c>Get</c> are not the same token as
    /// <c>GET</c>, which RFC 9110 defines as case-sensitive and uppercase.
    /// </para>
    /// <para>
    /// A case-insensitive exemption would be the wider hole for no gain the convention does not
    /// already give, and the guard is case-sensitive elsewhere for the same reason — the macOS
    /// <c>/Users</c> against the REST <c>/users</c>.
    /// </para>
    /// </remarks>
    [Theory]
    [InlineData("FETCH /home/ci-user/repo")]
    [InlineData("GETX /home/ci-user/repo")]
    [InlineData("get /home/ci-user/repo")]
    [InlineData("Get /home/ci-user/repo")]
    [InlineData("checkout /home/ci-user/repo")]
    [InlineData("/home/ci-user/repo GET")]
    [InlineData("GET /home/dashboard /home/ci-user/repo")]
    [InlineData("GET path:/home/ci-user/repo")]
    public void LoadFromJson_MachinePathOutsideTheMethodExemption_IsRefused(string scenarioId)
    {
        var result = SuiteLoader.LoadFromJson(SuiteWith(scenarioId), "regression.json");

        result.Succeeded.Should().BeFalse();
        result.Messages.Should().Contain(message => message.Code == ScenarioCode);
    }

    /// <summary>
    /// The exemption waives the route shape only — never a drive prefix or a UNC path.
    /// </summary>
    /// <remarks>
    /// The concession was granted for one specific ambiguity: <c>/home/dashboard</c> is a
    /// plausible REST route and is not distinguishable in text from <c>/home/&lt;account&gt;</c>.
    /// <c>C:\Users\…</c> and <c>\\host\share\…</c> carry no such ambiguity — neither is ever a
    /// route — so there is nothing to concede and the exemption must not reach them.
    /// </remarks>
    [Theory]
    [InlineData(@"GET C:\Users\ci-user\repo")]
    [InlineData("GET D:/build/agent/work")]
    [InlineData(@"POST \\build-host\share\repo")]
    public void LoadFromJson_MethodFollowedByADriveOrUncPath_IsRefused(string scenarioId)
    {
        var result = SuiteLoader.LoadFromJson(SuiteWith(scenarioId), "regression.json");

        result.Succeeded.Should().BeFalse();
        result.Messages.Should().Contain(message => message.Code == ScenarioCode);
    }

    /// <summary>
    /// A colon is only an address when what follows is genuinely an absolute URL.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>path:///home/ci-user/repo</c> has no authority — it is three slashes, not
    /// <c>scheme://host</c>. Treating every <c>://</c> as an address let it through, and the
    /// report-side pattern also misses a path after a colon, so it reached the published comment.
    /// </para>
    /// <para>
    /// <c>path://home/ci-user/repo</c> has an authority but no recognised address scheme, so it
    /// is not admitted either.
    /// </para>
    /// </remarks>
    [Theory]
    [InlineData("checkout path:///home/ci-user/repo")]
    [InlineData("checkout path:////home/ci-user/repo")]
    [InlineData("checkout path://home/ci-user/repo")]
    [InlineData("checkout https:///home/ci-user/repo")]
    [InlineData("checkout ws:///Users/ci-user/repo")]
    [InlineData("checkout file:///home/ci-user/repo")]
    [InlineData("checkout ref:/Users/ci-user/repo")]
    public void LoadFromJson_ColonFollowedByAPathThatIsNotAnAddress_IsRefused(string scenarioId)
    {
        var result = SuiteLoader.LoadFromJson(SuiteWith(scenarioId), "regression.json");

        result.Succeeded.Should().BeFalse();
        result.Messages.Should().Contain(message => message.Code == ScenarioCode);
    }

    /// <summary>
    /// A genuine absolute URL keeps loading, whatever its authority is called.
    /// </summary>
    /// <remarks>
    /// The scheme is matched case-insensitively because RFC 3986 §3.1 defines schemes as
    /// case-insensitive. That is a deliberate asymmetry with the method exemption, which RFC 9110
    /// §9.1 defines as case-sensitive — two different specifications, not two conventions.
    /// </remarks>
    [Theory]
    [InlineData("https://home/dashboard")]
    [InlineData("HTTPS://home/dashboard")]
    [InlineData("http://var/status")]
    [InlineData("ws://home/socket")]
    [InlineData("wss://tmp/stream")]
    [InlineData("https://api.example.com/v1/refund")]
    public void LoadFromJson_AbsoluteUrl_Loads(string scenarioId)
    {
        var result = SuiteLoader.LoadFromJson(SuiteWith(scenarioId), "regression.json");

        result.Succeeded.Should().BeTrue(because: string.Join("; ", result.Messages));
        result.Suite!.Scenarios[0].Identity.Id.Should().Be(scenarioId);
    }

    /// <summary>
    /// A deserializer diagnostic must not carry a refused tag key out to the log.
    /// </summary>
    /// <remarks>
    /// The scenario-id guard runs before binding precisely because any later rule would carry the
    /// value into its own finding. Tags were checked after binding, so a path-shaped tag key with
    /// an invalid value type produced a JSON-path diagnostic naming that key, which was then
    /// copied verbatim into a <c>scenario.malformed</c> finding. Asserted across <b>every</b>
    /// finding, not just the tag one — which is the whole point.
    /// </remarks>
    [Fact]
    public void LoadFromJson_MalformedValueUnderAMachinePathTagKey_RepeatsTheValueInNoFinding()
    {
        var json = """
            {
              "name": "regression",
              "scenarios": [
                {
                  "identity": { "id": "refund-flow", "kind": "rest" },
                  "execution": { "mode": "live" },
                  "simulation": { "opening": "GET /health" },
                  "slicing": { "tags": { "/home/ci-user/repo": 12 } }
                }
              ]
            }
            """;

        var result = SuiteLoader.LoadFromJson(json, "regression.json");

        result.Succeeded.Should().BeFalse();
        result.Messages.Should().NotContain(message => message.ToString().Contains("/home/ci-user"));
    }

    /// <summary>
    /// A duplicate JSON key named as a machine path must not reach the log either.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This is the one author-controlled string that still reaches a deserializer diagnostic.
    /// Duplicate keys are forced early so they surface as a finding rather than as a throw, and
    /// the resulting <see cref="ArgumentException"/> names the offending key — which is then
    /// copied into a <c>scenario.malformed</c> finding bound for the build log.
    /// </para>
    /// <para>
    /// It arrives <b>before</b> the identifier checks, so no amount of pre-binding inspection
    /// prevents it; the message itself has to be withheld. Found by a surviving mutant, not by
    /// reading the code.
    /// </para>
    /// </remarks>
    [Fact]
    public void LoadFromJson_DuplicateKeyNamedAsAMachinePath_RepeatsTheValueInNoFinding()
    {
        var json = """
            {
              "name": "regression",
              "scenarios": [
                {
                  "identity": { "id": "refund-flow", "kind": "rest" },
                  "execution": { "mode": "live" },
                  "/home/ci-user/repo": 1,
                  "/home/ci-user/repo": 2
                }
              ]
            }
            """;

        var result = SuiteLoader.LoadFromJson(json, "regression.json");

        result.Succeeded.Should().BeFalse();
        result.Messages.Should().NotContain(message => message.ToString().Contains("/home/ci-user"));

        // The reason is composed from the cause's type, so it must actually describe that type
        // rather than collapse to a generic one.
        result.Messages.Should().Contain(message => message.Message.Contains("same property more than once"));
    }

    /// <summary>
    /// No finding repeats material this library did not compose.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Each of these reaches a finding through a different door, and all three arrive
    /// <b>before</b> any identifier check can run: a duplicate key at the suite root, a declared
    /// schema version, and a converter that quotes the author's own literal back.
    /// </para>
    /// <para>
    /// The third is why filtering was abandoned. <c>Converters</c> renders an invalid repetition
    /// policy as <c>'&lt;literal&gt;' is not a valid repetition policy</c>, so the token begins
    /// with a quote and no identifier rule recognises it — the same quote-delimited case that was
    /// the first of five holes in the report-side pattern. Prose does not tokenize like an
    /// identifier, and it never will.
    /// </para>
    /// </remarks>
    [Theory]
    [InlineData(
        """
            {
              "name": "regression",
              "/home/ci-user/repo": 1,
              "/home/ci-user/repo": 2,
              "scenarios": []
            }
            """
    )]
    [InlineData(
        """
            {
              "name": "regression",
              "schemaVersion": "/home/ci-user/repo",
              "scenarios": []
            }
            """
    )]
    [InlineData(
        """
            {
              "name": "regression",
              "scenarios": [
                {
                  "identity": { "id": "refund-flow", "kind": "rest" },
                  "execution": { "mode": "live", "repetitionPolicy": "/home/ci-user/repo" },
                  "simulation": { "opening": "GET /health" }
                }
              ]
            }
            """
    )]
    public void LoadFromJson_DiagnosticCarryingAMachinePath_RepeatsItInNoFinding(string json)
    {
        var result = SuiteLoader.LoadFromJson(json, "regression.json");

        result.Succeeded.Should().BeFalse();
        result.Messages.Should().NotContain(message => message.ToString().Contains("/home/ci-user"));
    }

    /// <summary>
    /// A terse finding is still an actionable one.
    /// </summary>
    /// <remarks>
    /// Withholding the underlying prose is only defensible if what remains locates the problem.
    /// The finding names the scenario — by its declared id where there is one, which is safe here
    /// because a machine-path id is refused before binding, and by its position otherwise.
    /// </remarks>
    [Fact]
    public void LoadFromJson_UnreadableScenario_StillNamesItWithoutQuotingTheValue()
    {
        var json = """
            {
              "name": "regression",
              "scenarios": [
                { "identity": { "id": "first", "kind": "rest" }, "execution": { "mode": "live" }, "simulation": { "opening": "a" } },
                { "identity": { "id": "second", "kind": "rest" }, "execution": { "mode": "live", "repetitionPolicy": "nonsense" } }
              ]
            }
            """;

        var result = SuiteLoader.LoadFromJson(json, "regression.json");

        var finding = result.Messages.Should().ContainSingle(message => message.Code == "scenario.malformed").Subject;
        finding.ToString().Should().Contain("second").And.NotContain("nonsense");
    }

    /// <summary>
    /// The seam between the raw precheck and the binder.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The pre-binding checks read the <see cref="JsonObject"/> by ordinal key, but
    /// <c>CanonicalJson</c>'s options are built from <see cref="JsonSerializerDefaults.Web"/>,
    /// which sets <c>PropertyNameCaseInsensitive</c>. So <c>"ID"</c> and <c>"Tags"</c> miss the
    /// precheck, bind successfully, and reach the committed artifact.
    /// </para>
    /// <para>
    /// Both mechanisms were individually correct; the gap between them was the hole. The remedy
    /// is not to teach the raw check the binder's key-matching rules — that is re-deriving them
    /// by hand, and a future change to those options would silently reopen this — but to check
    /// the <b>bound</b> values, which are by construction what the binder produced.
    /// </para>
    /// </remarks>
    [Theory]
    [InlineData(""" "identity": { "ID": "/home/ci-user/repo", "kind": "rest" }, "execution": { "mode": "live" } """)]
    [InlineData(""" "Identity": { "id": "/home/ci-user/repo", "kind": "rest" }, "execution": { "mode": "live" } """)]
    [InlineData(
        """ "identity": { "id": "refund-flow", "kind": "rest" }, "execution": { "mode": "live" }, "Slicing": { "tags": { "area": "/home/ci-user/repo" } } """
    )]
    [InlineData(
        """ "identity": { "id": "refund-flow", "kind": "rest" }, "execution": { "mode": "live" }, "slicing": { "Tags": { "area": "/home/ci-user/repo" } } """
    )]
    [InlineData(
        """ "identity": { "id": "refund-flow", "kind": "rest" }, "execution": { "mode": "live" }, "slicing": { "Tags": { "/home/ci-user/repo": "health" } } """
    )]
    public void LoadFromJson_MachinePathUnderAMixedCaseProperty_IsRefusedWithoutRepeatingTheValue(string body)
    {
        var json = $$"""
            {
              "name": "regression",
              "scenarios": [ { {{body}} } ]
            }
            """;

        var result = SuiteLoader.LoadFromJson(json, "regression.json");

        result.Succeeded.Should().BeFalse();
        result.Suite.Should().BeNull();
        result.Messages.Should().NotContain(message => message.ToString().Contains("/home/ci-user"));
    }

    /// <summary>
    /// The pre-binding check is load-bearing, and this is what proves it.
    /// </summary>
    /// <remarks>
    /// A post-binding check cannot cover this: the entry never binds. The identifier is a machine
    /// path <i>and</i> the repetition policy is invalid, so without the pre-binding refusal the
    /// id is still in <c>label</c> and <c>declaredId</c> when the binding failure is reported, and
    /// <c>scenario.malformed</c> carries it into the build log.
    /// </remarks>
    [Fact]
    public void LoadFromJson_UnbindableScenarioWhoseIdIsAMachinePath_RepeatsTheValueInNoFinding()
    {
        var json = """
            {
              "name": "regression",
              "scenarios": [
                {
                  "identity": { "id": "/home/ci-user/repo", "kind": "rest" },
                  "execution": { "mode": "live", "repetitionPolicy": "nonsense" }
                }
              ]
            }
            """;

        var result = SuiteLoader.LoadFromJson(json, "regression.json");

        result.Succeeded.Should().BeFalse();
        result.Messages.Should().NotContain(message => message.ToString().Contains("/home/ci-user"));
        result
            .Messages.Should()
            .NotContain(message => message.ScenarioId != null && message.ScenarioId.Contains("/home"));
    }

    /// <summary>
    /// The raw tag check earns its place by being specific, not by being secure.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This entry cannot bind — the tag value is a number where a string is required — so without
    /// the pre-binding tag read it would be reported as a vague <c>scenario.malformed</c>. The
    /// author would learn that something in scenario #1 is wrong, but not that the problem is a
    /// machine path in a tag key, which is the one thing they can act on.
    /// </para>
    /// <para>
    /// That specificity is the <b>entire</b> remaining justification for the raw tag check, and
    /// it is asserted here because describing a benefit is not the same as having one. Without
    /// this test the check is unexercised, which is what let a mutant removing it survive.
    /// </para>
    /// </remarks>
    [Fact]
    public void LoadFromJson_UnbindableScenarioWithAMachinePathTagKey_ReportsTheTagCodeNotAMalformedScenario()
    {
        var json = """
            {
              "name": "regression",
              "scenarios": [
                {
                  "identity": { "id": "refund-flow", "kind": "rest" },
                  "execution": { "mode": "live" },
                  "simulation": { "opening": "GET /health" },
                  "slicing": { "tags": { "/home/ci-user/repo": 12 } }
                }
              ]
            }
            """;

        var result = SuiteLoader.LoadFromJson(json, "regression.json");

        var finding = result.Messages.Should().ContainSingle(message => message.Code == TagCode).Subject;
        finding.Message.Should().Contain("#1").And.Contain("tag key").And.Contain("slicing.tags");
        finding.ToString().Should().NotContain("/home/ci-user");

        // The distinction itself: the vague finding is not what the author gets.
        result.Messages.Should().NotContain(message => message.Code == "scenario.malformed");
    }

    [Theory]
    [InlineData("regression")]
    [InlineData("/api/v1 regression")]
    public void LoadFromJson_OrdinarySuiteName_Loads(string name)
    {
        var result = SuiteLoader.LoadFromJson(SuiteWith("refund-flow", name), "regression.json");

        result.Succeeded.Should().BeTrue(because: string.Join("; ", result.Messages));
        result.Suite!.Name.Should().Be(name);
    }

    /// <summary>
    /// Slicing tags reach the committed artifact, so they are guarded too.
    /// </summary>
    /// <remarks>
    /// <c>ScenarioResult.Tags</c> and <c>SuiteResult.SlicingDimensions</c> carry tag values and
    /// tag keys into the durable JSON artifact, which is committed. That artifact is published
    /// evidence even though no tag is rendered into the pull-request comment today.
    /// </remarks>
    [Theory]
    [InlineData("""{ "area": "/home/ci-user/repo" }""")]
    [InlineData("""{ "/home/ci-user/repo": "health" }""")]
    [InlineData("""{ "area": "checkout /home/ci-user/repo" }""")]
    public void LoadFromJson_SlicingTagIsAMachinePath_IsRefusedWithoutRepeatingTheValue(string tags)
    {
        var result = SuiteLoader.LoadFromJson(SuiteWith("refund-flow", "regression", tags), "regression.json");

        result.Succeeded.Should().BeFalse();

        var finding = result.Messages.Should().ContainSingle(message => message.Code == TagCode).Subject;
        finding.Severity.Should().Be(ValidationSeverity.Error);
        finding.Message.Should().NotContain("/home/ci-user").And.Contain("#1").And.Contain("rename");
        finding.ToString().Should().NotContain("/home/ci-user");
    }

    [Fact]
    public void LoadFromJson_OrdinarySlicingTags_Load()
    {
        var tags = """{ "area": "health", "team": "payments" }""";

        var result = SuiteLoader.LoadFromJson(SuiteWith("refund-flow", "regression", tags), "regression.json");

        result.Succeeded.Should().BeTrue(because: string.Join("; ", result.Messages));
        result.Suite!.Scenarios[0].Slicing.Tags.Should().Contain(new KeyValuePair<string, string>("area", "health"));
    }

    /// <summary>
    /// A failed load yields no suite, as <see cref="SuiteLoadResult.Suite"/> documents.
    /// </summary>
    /// <remarks>
    /// The command-line tool checks <see cref="SuiteLoadResult.Succeeded"/>, so it is safe either
    /// way — but a library consumer reading the documented contract and testing
    /// <c>Suite is not null</c> would otherwise be handed the very value that was refused, which
    /// turns the guard into a suggestion.
    /// </remarks>
    [Theory]
    [InlineData("/home/ci-user/repo", "regression")]
    [InlineData("refund-flow", "/home/ci-user/suites")]
    public void LoadFromJson_RefusedIdentifier_YieldsNoSuite(string scenarioId, string name)
    {
        var result = SuiteLoader.LoadFromJson(SuiteWith(scenarioId, name), "regression.json");

        result.Suite.Should().BeNull();
        result.Succeeded.Should().BeFalse();
    }

    [Fact]
    public void LoadFromJson_AnyValidationError_YieldsNoSuite()
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

        result.Messages.Should().Contain(message => message.Code == "scenario.id.duplicate");
        result.Suite.Should().BeNull();
    }

    /// <summary>
    /// No other finding repeats a refused identifier either.
    /// </summary>
    /// <remarks>
    /// Every scenario-level finding carries the scenario id, so a scenario whose id is a machine
    /// path and which <i>also</i> trips another rule would disclose the path through that other
    /// finding. The refused scenario is therefore dropped before any further rule sees it.
    /// </remarks>
    [Fact]
    public void LoadFromJson_RefusedScenarioAlsoBreakingAnotherRule_RepeatsTheValueInNoFinding()
    {
        var json = """
            {
              "name": "regression",
              "scenarios": [
                { "identity": { "id": "/home/ci-user/repo", "kind": "llm" }, "execution": { "mode": "deterministic" } }
              ]
            }
            """;

        var result = SuiteLoader.LoadFromJson(json, "regression.json");

        result.Succeeded.Should().BeFalse();
        result.Messages.Should().NotContain(message => message.ToString().Contains("/home/ci-user"));
    }

    /// <summary>
    /// The guard is reached through the door the command-line tool actually uses.
    /// </summary>
    [Fact]
    public async Task LoadAsync_ScenarioIdIsAMachinePath_IsRefusedWithoutRepeatingTheValue()
    {
        var root = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName());
        Directory.CreateDirectory(root);

        try
        {
            await File.WriteAllTextAsync(
                Path.Combine(root, "suite.json"),
                SuiteWith("/home/ci-user/repo"),
                CancellationToken.None
            );

            var result = await new SuiteLoader(root).LoadAsync("suite.json", CancellationToken.None);

            result.Succeeded.Should().BeFalse();
            result.Suite.Should().BeNull();
            result.Messages.Should().Contain(message => message.Code == ScenarioCode);
            result.Messages.Should().NotContain(message => message.ToString().Contains("/home/ci-user"));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
