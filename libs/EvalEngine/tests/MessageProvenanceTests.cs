using FluentAssertions;
using Forge.EvalEngine.Assertions;
using Forge.EvalEngine.Comparison;
using Forge.EvalEngine.Coordination;
using Forge.EvalEngine.Impact;
using Forge.EvalEngine.Loading;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Scenarios;
using Forge.EvalEngine.Serialization;
using Forge.EvalEngine.Tests.Comparison;
using Forge.EvalEngine.Tests.Coordination;
using Forge.EvalEngine.Tests.Impact;
using Forge.EvalEngine.Tests.Runners;
using Forge.EvalEngine.Transcripts;
using Microsoft.Extensions.Logging;

namespace Forge.EvalEngine.Tests;

/// <summary>
/// What a stage may name in a message it composes, taken sink by sink.
/// </summary>
/// <remarks>
/// <para>
/// Three source-first sweeps for path disclosures in this repository found sixteen, then
/// twenty-two, then twenty-five, and each one missed by scope because it searched for the kind of
/// thing the last fix had been about. The sink-first question is different and it terminates:
/// enumerate every <c>throw</c> and every log call in a stage, and for each one ask what the
/// provenance of every value in the message is.
/// </para>
/// <para>
/// Doing that over the comparator and the coordinator produces one structural answer rather than
/// twenty message edits. Both stages accept a <see cref="SuiteResult"/> or a <see cref="Suite"/>
/// built <b>in process</b>, which reaches neither the reader's identifier guard nor the writer's —
/// so every message naming an identifier is only as safe as the caller. Each stage now runs the
/// guard on what it is handed, which makes the whole class closed instead of closed at the
/// messages somebody remembered.
/// </para>
/// </remarks>
public sealed class MessageProvenanceTests
{
    private const string Path = "/home/ci-user/repo";

    // -----------------------------------------------------------------------------------------
    // The comparator guards what it is handed.
    // -----------------------------------------------------------------------------------------

    [Fact]
    public void Compare_InProcessArtifactWhoseSuiteNameIsAMachinePath_IsRefusedWithoutRepeatingIt()
    {
        var baseline = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Fail)], suiteName: Path);
        var candidate = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)]);

        var act = () => new SuiteComparator().Compare(baseline, candidate);

        act.Should().Throw<UnsafeIdentifierException>().Which.Message.Should().NotContain("ci-user");
    }

    [Fact]
    public void Compare_InProcessArtifactWhoseScenarioIdIsAMachinePath_IsRefusedWithoutRepeatingIt()
    {
        var baseline = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario(Path, RunStatus.Fail)]);
        var candidate = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario(Path, RunStatus.Pass)]);

        var act = () => new SuiteComparator().Compare(baseline, candidate);

        act.Should().Throw<UnsafeIdentifierException>().Which.Message.Should().NotContain("ci-user");
    }

    /// <summary>
    /// The suite-name refusal describes the disagreement rather than quoting both names.
    /// </summary>
    /// <remarks>
    /// Belt and braces beside the guard above: the guard is what makes the class closed, and this
    /// is what keeps the message from being the thing that reopens it if an identifier ever
    /// becomes legitimately unguardable. A caller passed both artifacts and does not learn their
    /// names from a refusal.
    /// </remarks>
    [Fact]
    public void Compare_SuiteNamesDiffer_DescribesTheDisagreementWithoutQuotingEitherName()
    {
        var baseline = ComparisonFixtures.Artifact(
            [ComparisonFixtures.Scenario("a", RunStatus.Fail)],
            suiteName: "checkout-suite"
        );
        var candidate = ComparisonFixtures.Artifact(
            [ComparisonFixtures.Scenario("a", RunStatus.Pass)],
            suiteName: "billing-suite"
        );

        var act = () => new SuiteComparator().Compare(baseline, candidate);

        var thrown = act.Should().Throw<ComparisonRefusedException>().Which;
        thrown.Message.Should().NotContain("checkout-suite").And.NotContain("billing-suite");
        thrown.Property.Should().Be("suiteName");
    }

    // -----------------------------------------------------------------------------------------
    // The coordinator guards the suite it is handed.
    // -----------------------------------------------------------------------------------------

    [Fact]
    public async Task RunAsync_SuiteScenarioIdNamingAMachinePath_IsRefusedBeforeAnythingIsDispatched()
    {
        var runner = new StubRunner(ScenarioKind.Rest);

        var act = () =>
            CoordinatorFixtures
                .Coordinator([runner])
                .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario(Path)), default);

        (await act.Should().ThrowAsync<UnsafeIdentifierException>()).Which.Message.Should().NotContain("ci-user");
        runner.Seen.Should().BeEmpty();
    }

    // -----------------------------------------------------------------------------------------
    // The selector guards both the suite and the baseline it is handed.
    // -----------------------------------------------------------------------------------------

    [Fact]
    public void Select_BaselineScenarioIdNamingAMachinePath_IsRefusedWithoutRepeatingIt()
    {
        var scenario = ImpactFixtures.Declaring("unmatched", "docs/**");
        var baseline = ImpactFixtures.Artifact(ImpactFixtures.Recorded(scenario) with { ScenarioId = Path });

        var act = () => ImpactSelector.Select(ImpactFixtures.SuiteOf(scenario), ["src/a.cs"], baseline);

        act.Should().Throw<UnsafeIdentifierException>().Which.Message.Should().NotContain("ci-user");
    }

    [Fact]
    public void Select_SuiteScenarioIdNamingAMachinePath_IsRefusedWithoutRepeatingIt()
    {
        var scenario = ImpactFixtures.Declaring(Path, "docs/**");

        var act = () => ImpactSelector.Select(ImpactFixtures.SuiteOf(scenario), ["src/a.cs"]);

        act.Should().Throw<UnsafeIdentifierException>().Which.Message.Should().NotContain("ci-user");
    }

    // -----------------------------------------------------------------------------------------
    // A runner's own text is a separate channel, and it reaches two sinks.
    // -----------------------------------------------------------------------------------------

    private static StubRunner Stating(string failure, string exchange = ExchangeState.RequestFailed) =>
        new(
            ScenarioKind.Rest,
            (scenario, context, _) =>
                Task.FromResult(CoordinatorFixtures.Transcript(scenario, context, exchange, failure: failure))
        );

    /// <summary>
    /// Validating what a runner <i>declares</i> does not validate what a runner <i>produces</i>.
    /// </summary>
    /// <remarks>
    /// The transport failure attribute is written by an injected runner. The coordinator copied it
    /// into <see cref="RunResult.ErrorDetail"/> — a second artifact field — and into a warning log
    /// line, which the transcript attribute does not reach. The runners in this library redact
    /// their own; an injected one need not, and the coordinator cannot tell the two apart.
    /// </remarks>
    [Fact]
    public async Task RunAsync_RunnerStatingAFailureNamingAMachinePath_KeepsItOutOfTheArtifact()
    {
        var result = await CoordinatorFixtures
            .Coordinator([Stating($"could not reach the fixture at {Path}")])
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a")), default);

        var run = result.ScenarioResults.Single().Runs.Single();

        run.Status.Should().Be(RunStatus.Error);
        run.ErrorDetail.Should().NotContain("ci-user");
    }

    [Fact]
    public async Task RunAsync_RunnerStatingAFailureNamingAMachinePath_KeepsItOutOfTheLog()
    {
        var logger = new RecordingLogger();

        await CoordinatorFixtures
            .Coordinator([Stating($"could not reach the fixture at {Path}")], logger: logger)
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a")), default);

        logger.Entries.Should().NotBeEmpty();
        logger.Entries.Select(entry => entry.Message).Should().NotContain(message => message.Contains("ci-user"));
    }

    /// <summary>
    /// An exchange state this library declares may be named; anything else is described.
    /// </summary>
    /// <remarks>
    /// The same rule a reserved harness key draws. The recorded state is the runner's text, and
    /// an unrecognised one is the case that exists precisely because a runner can write anything.
    /// </remarks>
    [Fact]
    public async Task RunAsync_RunnerRecordingAnUndeclaredExchangeState_DescribesItWithoutQuotingIt()
    {
        var result = await CoordinatorFixtures
            .Coordinator([Stating("nothing sensitive", exchange: $"leaked {Path}")])
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a")), default);

        result.ScenarioResults.Single().Runs.Single().ErrorDetail.Should().NotContain("ci-user");
    }

    [Fact]
    public async Task RunAsync_RunnerRecordingADeclaredExchangeState_NamesItBecauseThisLibraryChoseIt()
    {
        var result = await CoordinatorFixtures
            .Coordinator([Stating("nothing sensitive", exchange: ExchangeState.Unsupported)])
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a")), default);

        result.ScenarioResults.Single().Runs.Single().ErrorDetail.Should().Contain(ExchangeState.Unsupported);
    }

    /// <summary>The redaction still tells two different failures apart.</summary>
    [Fact]
    public async Task RunAsync_TwoRunnersStatingDifferentFailures_AreStillDistinguishableInTheArtifact()
    {
        var first = await CoordinatorFixtures
            .Coordinator([Stating("the first reason")])
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a")), default);
        var second = await CoordinatorFixtures
            .Coordinator([Stating("a different reason")])
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a")), default);

        first
            .ScenarioResults.Single()
            .Runs.Single()
            .ErrorDetail.Should()
            .NotBe(second.ScenarioResults.Single().Runs.Single().ErrorDetail);
    }

    // -----------------------------------------------------------------------------------------
    // The rest of what each stage is handed. "These three are the entry points" was a claim
    // about a set, and the set was larger than the one I remembered guarding.
    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// A run's transcript carries its own scenario id, and two stages quote it.
    /// </summary>
    /// <remarks>
    /// An artifact filed under a safe id may carry a transcript naming a different one — that is
    /// the misattribution the comparator and the selector both look for, and both name the
    /// offending value when they find it. The shared sweep checked the
    /// <see cref="ScenarioResult.ScenarioId"/> and not the transcript's, so the artifact passed
    /// every door and the value reached both messages intact.
    /// </remarks>
    [Fact]
    public void Compare_ArtifactWhoseTranscriptScenarioIdIsAMachinePath_IsRefusedWithoutRepeatingIt()
    {
        var scenario = ComparisonFixtures.Scenario("a", RunStatus.Pass);
        var tampered = scenario with
        {
            Runs = [scenario.Runs[0] with { Transcript = ComparisonFixtures.Transcript(Path, 1000) }],
        };

        var act = () =>
            new SuiteComparator().Compare(
                ComparisonFixtures.Artifact([tampered]),
                ComparisonFixtures.Artifact([scenario])
            );

        act.Should().Throw<UnsafeIdentifierException>().Which.Message.Should().NotContain("ci-user");
    }

    [Fact]
    public void DeserializeSuiteResult_TranscriptScenarioIdIsAMachinePath_IsRefusedWithoutRepeatingIt()
    {
        var scenario = ComparisonFixtures.Scenario("a", RunStatus.Pass);
        var tampered = scenario with
        {
            Runs = [scenario.Runs[0] with { Transcript = ComparisonFixtures.Transcript(Path, 1000) }],
        };

        var write = () => CanonicalJson.Serialize(ComparisonFixtures.Artifact([tampered]));

        write.Should().Throw<UnsafeIdentifierException>().Which.Message.Should().NotContain("ci-user");
    }

    /// <summary>
    /// A baseline's definition fingerprint is quoted into a selection reason.
    /// </summary>
    [Fact]
    public void Select_BaselineDefinitionFingerprintIsAMachinePath_IsRefusedWithoutRepeatingIt()
    {
        var scenario = ImpactFixtures.Declaring("unmatched", "docs/**");
        var baseline = ImpactFixtures.Artifact(ImpactFixtures.Recorded(scenario, fingerprint: $"sha256:{Path}"));

        var act = () => ImpactSelector.Select(ImpactFixtures.SuiteOf(scenario), ["src/a.cs"], baseline);

        act.Should().Throw<UnsafeIdentifierException>().Which.Message.Should().NotContain("ci-user");
    }

    /// <summary>The suite's own name is quoted by the selector and stamped by the coordinator.</summary>
    [Fact]
    public void Select_SuiteNameIsAMachinePath_IsRefusedWithoutRepeatingIt()
    {
        var scenario = ImpactFixtures.Declaring("unmatched", "docs/**");
        var suite = new Suite { Name = Path, Scenarios = [scenario] };

        var act = () => ImpactSelector.Select(suite, ["src/a.cs"]);

        act.Should().Throw<UnsafeIdentifierException>().Which.Message.Should().NotContain("ci-user");
    }

    [Fact]
    public async Task RunAsync_SuiteNameIsAMachinePath_IsRefusedBeforeAnythingIsDispatched()
    {
        var runner = new StubRunner(ScenarioKind.Rest);
        var suite = new Suite { Name = Path, Scenarios = [CoordinatorFixtures.Scenario("a")] };

        var act = () => CoordinatorFixtures.Coordinator([runner]).RunAsync(suite, default);

        (await act.Should().ThrowAsync<UnsafeIdentifierException>()).Which.Message.Should().NotContain("ci-user");
        runner.Seen.Should().BeEmpty();
    }

    /// <summary>
    /// A changed-file entry is a caller-supplied path, and the rejection quoted it back.
    /// </summary>
    /// <remarks>
    /// Not an identifier an author chose — it arrives from a revision range, machine-generated —
    /// so it cannot be guarded by refusing the author's spelling. It is described instead, which
    /// still tells two rejected entries apart.
    /// </remarks>
    [Fact]
    public void Select_ChangedFileEntryThatCannotBeNormalised_DescribesItWithoutQuotingIt()
    {
        var scenario = ImpactFixtures.Declaring("unmatched", "docs/**");

        var result = ImpactSelector.Select(ImpactFixtures.SuiteOf(scenario), [$"{Path}/src/a.cs"]);

        result.FellBackToFullSuite.Should().BeTrue();
        result.FallbackReason.Should().NotBeNull().And.NotContain("ci-user");
    }

    [Fact]
    public void Select_TwoDifferentUnnormalisableEntries_AreStillDistinguishable()
    {
        var scenario = ImpactFixtures.Declaring("unmatched", "docs/**");

        var first = ImpactSelector.Select(ImpactFixtures.SuiteOf(scenario), [$"{Path}/a.cs"]);
        var second = ImpactSelector.Select(ImpactFixtures.SuiteOf(scenario), [$"{Path}/b.cs"]);

        first.FallbackReason.Should().NotBe(second.FallbackReason);
    }

    // -----------------------------------------------------------------------------------------
    // Labels are guarded; evidence is not. This is ADR 0005's line, not a new one.
    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// A route-shaped operand is evidence, and a suite using one must load.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This is the positive case, written first and kept first. A previous round applied the
    /// identifier rule to the whole assertion expression, which refused
    /// <c>presence:response/GET /home/dashboard</c> — a legitimate response-token assertion whose
    /// second whitespace-delimited token reads as a machine path, and which the HTTP-method
    /// exemption cannot rescue because the leading token is <c>presence:response/GET</c>.
    /// </para>
    /// <para>
    /// <see cref="Paths.MachinePath"/>'s own remarks say it is deliberately not applied to
    /// stimuli, transcripts, or assertion expressions, and say not to tighten it onto them.
    /// Every other refusal in this library fails closed; a guard that refuses valid input fails
    /// in the direction that costs a user their suite.
    /// </para>
    /// </remarks>
    [Theory]
    [InlineData("presence:response/GET /home/dashboard")]
    [InlineData("exactMatch:/home/dashboard")]
    [InlineData("slotAbsent:/var/log/entry")]
    [InlineData("expectedBehavior:transport/statusCode=404")]
    public void LoadFromJson_AssertionWhoseOperandIsRouteShaped_Loads(string expression)
    {
        var json = $$"""
            {
              "name": "regression",
              "scenarios": [
                {
                  "identity": { "id": "refund-flow", "kind": "rest" },
                  "execution": { "mode": "live" },
                  "simulation": { "opening": "GET /health" },
                  "grading": { "assertions": [{{System.Text.Json.JsonSerializer.Serialize(expression)}}] }
                }
              ]
            }
            """;

        var result = SuiteLoader.LoadFromJson(json, "regression.json");

        result.Succeeded.Should().BeTrue(because: string.Join("; ", result.Messages));
        result.Suite!.Scenarios[0].Grading.Assertions[0].ToExpression().Should().Be(expression);
    }

    [Fact]
    public void Serialize_ArtifactWhoseAssertionOperandIsRouteShaped_RoundTripsThroughTheReader()
    {
        var artifact = ComparisonFixtures.Artifact([
            ComparisonFixtures.Scenario("a", [RunStatus.Pass], assertions: ["exactMatch:/home/dashboard"]),
        ]);

        var read = CanonicalJson.DeserializeSuiteResult(CanonicalJson.Serialize(artifact));

        read.ScenarioResults[0]
            .Runs[0]
            .AssertionResults[0]
            .Spec.ToExpression()
            .Should()
            .Be("exactMatch:/home/dashboard");
    }

    /// <summary>
    /// Guarding only the label would be a check that cannot fail, so it is not added.
    /// </summary>
    /// <remarks>
    /// The grammar is <c>category := [A-Za-z][A-Za-z0-9_.-]*</c> — no separator, no slash, no
    /// backslash, no whitespace — so a machine path is unrepresentable in the label half of an
    /// expression whatever the operand looks like. A guard there would read like protection that
    /// is not there, which is the reasoning this library already applies to the schema-version
    /// check it deliberately omits from the comparator.
    /// </remarks>
    /// <summary>
    /// The grammar is enforced by `Parse`, and `Parse` is not the only way in.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <see cref="AssertionSpec.Category"/> is a public <c>init</c> property. The argument that a
    /// path is unrepresentable in the label was true of the parser and false of the type: direct
    /// initialisation reaches the same field with no grammar applied, and the coordinator then
    /// names the category in an evaluator refusal.
    /// </para>
    /// <para>
    /// This is the session's signature defect in its purest form — a claim true of one route,
    /// asserted of every route — so the grammar moves onto the property, where every route passes.
    /// </para>
    /// </remarks>
    [Theory]
    [InlineData("/home/ci-user/repo")]
    [InlineData(@"C:\Users\ci-user")]
    [InlineData("has space")]
    [InlineData("trailing:colon")]
    [InlineData("")]
    [InlineData("9startsWithDigit")]
    public void Category_SetByDirectInitialisation_IsHeldToTheSameGrammarAsParse(string category)
    {
        var act = () => new AssertionSpec { Category = category };

        act.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void Category_SetByDirectInitialisationToAValidToken_IsAccepted()
    {
        new AssertionSpec { Category = "slotAbsent", Parameter = "/home/dashboard" }
            .ToExpression()
            .Should()
            .Be("slotAbsent:/home/dashboard");
    }

    /// <summary>
    /// ADR 0005 accepts evidence living in the suite and the transcript. It does not license
    /// copying an operand into a build-log-bound diagnostic.
    /// </summary>
    /// <remarks>
    /// The consumer's published-report net acts on findings it renders; it cannot reach a
    /// diagnostic the engine writes into <see cref="RunResult.ErrorDetail"/> and a log line. The
    /// refusal therefore identifies <i>which</i> assertion was refused — its category, now
    /// grammar-enforced, plus a fingerprint of the whole expression — while the operand stays
    /// where it belongs, in the suite file and in the scenario's own grading.
    /// </remarks>
    [Fact]
    public async Task RunAsync_EvaluatorRefusingAnAssertionWithAPathOperand_KeepsItOutOfTheArtifact()
    {
        var result = await RefusedAsync($"slotAbsent:{Path}");

        var run = result.ScenarioResults.Single().Runs.Single();

        run.Status.Should().Be(RunStatus.Error);
        run.ErrorDetail.Should().NotContain("ci-user").And.Contain("slotAbsent");
    }

    [Fact]
    public async Task RunAsync_EvaluatorRefusingAnAssertionWithAPathOperand_KeepsItOutOfTheLog()
    {
        var logger = new RecordingLogger();

        _ = await RefusedAsync($"slotAbsent:{Path}", logger);

        logger.Entries.Should().NotBeEmpty();
        logger.Entries.Select(entry => entry.Message).Should().NotContain(message => message.Contains("ci-user"));
    }

    [Fact]
    public async Task RunAsync_EvaluatorRefusingTwoDifferentAssertions_ProducesDistinguishableDiagnostics()
    {
        var first = await RefusedAsync("slotAbsent:/home/dashboard");
        var second = await RefusedAsync("slotAbsent:/home/settings");

        first
            .ScenarioResults.Single()
            .Runs.Single()
            .ErrorDetail.Should()
            .NotBe(second.ScenarioResults.Single().Runs.Single().ErrorDetail);
    }

    private static Task<SuiteResult> RefusedAsync(string expression, RecordingLogger? logger = null) =>
        CoordinatorFixtures
            .Coordinator(
                [new StubRunner(ScenarioKind.Rest)],
                assertions: new AssertionEvaluatorRegistry([new RefusingEvaluator("slotAbsent", "refused")]),
                logger: logger
            )
            .RunAsync(CoordinatorFixtures.Suite(CoordinatorFixtures.Scenario("a", assertions: [expression])), default);

    // -----------------------------------------------------------------------------------------
    // Two correct components, a hole at their intersection.
    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// A quoted machine path is rejected before its shape is examined, and unrecognised after.
    /// </summary>
    /// <remarks>
    /// <c>ChangedPath.TryNormalize</c> refuses a double-quoted entry before looking at the path,
    /// and <see cref="Paths.MachinePath"/> deliberately does not see through a leading quote. Each
    /// is correct alone; composed, a git C-quoted machine path takes the ordinary branch and
    /// reaches the published fallback reason verbatim. Neither component's tests look here.
    /// </remarks>
    [Theory]
    [InlineData("\"/home/ci-user/repo/src/caf\\303\\251.cs\"")]
    [InlineData("\"C:\\\\Users\\\\ci-user\\\\a.cs\"")]
    public void Select_AQuotedMachinePath_IsDescribedRatherThanQuotedIntoTheFallbackReason(string entry)
    {
        var scenario = ImpactFixtures.Declaring("unmatched", "docs/**");

        var result = ImpactSelector.Select(ImpactFixtures.SuiteOf(scenario), ["src/a.cs", entry]);

        result.FellBackToFullSuite.Should().BeTrue();
        result.FallbackReason.Should().NotContain("ci-user").And.NotContain("Users");
    }

    /// <summary>The quoted-relative case keeps its text, because it discloses nothing.</summary>
    [Fact]
    public void Select_AQuotedRelativePath_IsStillNamedSoTheFallbackStaysTraceable()
    {
        var scenario = ImpactFixtures.Declaring("unmatched", "docs/**");

        var result = ImpactSelector.Select(ImpactFixtures.SuiteOf(scenario), ["src/a.cs", "\"src/caf\\303\\251.cs\""]);

        result.FellBackToFullSuite.Should().BeTrue();
        result.FallbackReason.Should().Contain("caf", "a fallback nobody can trace is noise");
    }

    // -----------------------------------------------------------------------------------------
    // The same test, applied to the selector's own published output.
    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// A rejected impact glob is author text the consumer publishes without netting.
    /// </summary>
    /// <remarks>
    /// <c>Selection.ImpactGlobs</c> is authored in the suite file and the loader's identifier
    /// check does not inspect it. A rooted pattern is refused by <c>ImpactGlob.TryParse</c> and
    /// was then quoted verbatim into <see cref="ScenarioSelection.Detail"/>, which <c>eval-cli</c>
    /// copies into its JSON run report and its verbose text report. This is the changed-file
    /// split one field along, on the same type — the input I fixed and the one beside it that I
    /// did not look at.
    /// </remarks>
    [Theory]
    [InlineData("/home/ci-user/repo/**")]
    [InlineData(@"C:\Users\ci-user\repo\**")]
    public void Select_AnImpactGlobNamingAMachinePath_IsDescribedRatherThanQuotedIntoTheDetail(string pattern)
    {
        var scenario = ImpactFixtures.Declaring("mapped", pattern);

        var result = ImpactSelector.Select(ImpactFixtures.SuiteOf(scenario), ["src/a.cs"]);

        var selection = ImpactFixtures.For(result, "mapped");
        selection.Reason.Should().Be(SelectionReason.NoGlobsDeclared);
        selection.Detail.Should().NotContain("ci-user").And.NotContain("Users");
    }

    [Fact]
    public void Select_AnOrdinaryInvalidImpactGlob_IsStillNamedSoTheAuthorCanFixIt()
    {
        var scenario = ImpactFixtures.Declaring("mapped", "src/[a-z].cs");

        var result = ImpactSelector.Select(ImpactFixtures.SuiteOf(scenario), ["src/a.cs"]);

        ImpactFixtures
            .For(result, "mapped")
            .Detail.Should()
            .Contain("src/[a-z].cs", "a pattern nobody can find is a pattern nobody fixes");
    }

    /// <summary>
    /// An unevaluated assertion is identified, not quoted, in published selection detail.
    /// </summary>
    /// <remarks>
    /// The safety net reports which declared assertion a baseline pass carries no verdict for. It
    /// copied the whole expression — operand included — into
    /// <see cref="ScenarioSelection.Detail"/>, which the consumer publishes unnetted. Identified
    /// now by its category, which the grammar keeps free of separators, and by a fingerprint that
    /// tells two of them apart.
    /// </remarks>
    [Fact]
    public void Select_BaselinePassMissingAVerdictForAPathShapedAssertion_IdentifiesItWithoutQuotingTheOperand()
    {
        var detail = DetailForUnevaluated($"slotAbsent:{Path}");

        detail.Should().NotContain("ci-user").And.Contain("slotAbsent");
    }

    [Fact]
    public void Select_TwoDifferentUnevaluatedAssertions_AreIdentifiedDistinguishably()
    {
        DetailForUnevaluated("slotAbsent:/home/dashboard")
            .Should()
            .NotBe(DetailForUnevaluated("slotAbsent:/home/settings"));
    }

    private static string DetailForUnevaluated(string expression)
    {
        var scenario = ImpactFixtures.Declaring("unmatched", "docs/**") with
        {
            Grading = new Grading { Assertions = [AssertionSpec.Parse(expression)] },
        };
        var baseline = ImpactFixtures.Artifact(ImpactFixtures.Recorded(scenario, recordVerdicts: false));
        var result = ImpactSelector.Select(ImpactFixtures.SuiteOf(scenario), ["src/a.cs"], baseline);

        return ImpactFixtures.For(result, "unmatched").Detail!;
    }

    // -----------------------------------------------------------------------------------------
    // Rootedness survives lexical normalisation, so it has to be rechecked after it.
    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// A drive qualification hidden behind a <c>./</c> prefix is still a drive qualification.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Both <c>ChangedPath.TryNormalize</c> and <c>ImpactGlob.TryParse</c> test rootedness on the
    /// value as written and <i>then</i> drop <c>.</c> segments, so <c>./C:/Users/x</c> passes the
    /// test and normalises to a drive-qualified first segment. Two lines apart, in the same
    /// method, on both paths.
    /// </para>
    /// <para>
    /// <b>The routing is the finding, not the text.</b> A drive-qualified glob that matches a
    /// drive-qualified path takes the <see cref="SelectionReason.GlobMatch"/> branch, so every
    /// other scenario is <b>skipped</b> on a comparison between two paths that name a machine
    /// rather than this repository — under-selection, which is the failure this whole layer
    /// exists to prevent, arriving through a two-character prefix.
    /// </para>
    /// </remarks>
    [Fact]
    public void Select_ADriveQualifiedGlobAndPathBehindADotPrefix_DoesNotSkipEveryOtherScenario()
    {
        var mapped = ImpactFixtures.Declaring("mapped", "./C:/Users/ci-user/repo/**");
        var skippable = ImpactFixtures.Declaring("skippable", "docs/**");
        var baseline = ImpactFixtures.Artifact(ImpactFixtures.Recorded(mapped), ImpactFixtures.Recorded(skippable));

        var result = ImpactSelector.Select(
            ImpactFixtures.SuiteOf(mapped, skippable),
            ["./C:/Users/ci-user/repo/a.cs"],
            baseline
        );

        result
            .Skipped.Should()
            .BeEmpty("a match between two machine-qualified paths must not retire the rest of the suite");
        ImpactFixtures.For(result, "skippable").Reason.Should().Be(SelectionReason.Fallback);
    }

    [Theory]
    [InlineData("./C:/Users/ci-user/repo/a.cs")]
    [InlineData(@".\C:\Users\ci-user\repo\a.cs")]
    public void Select_ADriveQualifiedChangedPathBehindADotPrefix_FallsBackWithoutDisclosingIt(string entry)
    {
        var scenario = ImpactFixtures.Declaring("unmatched", "docs/**");

        var result = ImpactSelector.Select(ImpactFixtures.SuiteOf(scenario), ["src/a.cs", entry]);

        result.FellBackToFullSuite.Should().BeTrue();
        result.FallbackReason.Should().NotContain("ci-user").And.NotContain("Users");
    }

    [Theory]
    [InlineData("./C:/Users/ci-user/repo/**")]
    [InlineData(@".\C:\Users\ci-user\repo\**")]
    public void Select_ADriveQualifiedGlobBehindADotPrefix_IsRefusedWithoutDisclosingIt(string pattern)
    {
        var scenario = ImpactFixtures.Declaring("mapped", pattern);

        var result = ImpactSelector.Select(ImpactFixtures.SuiteOf(scenario), ["src/a.cs"]);

        var selection = ImpactFixtures.For(result, "mapped");
        selection.Reason.Should().Be(SelectionReason.NoGlobsDeclared);
        selection.Detail.Should().NotContain("ci-user").And.NotContain("Users");
    }

    /// <summary>An ordinary leading <c>./</c> still resolves, because it names a real file.</summary>
    [Fact]
    public void Select_AnOrdinaryDotPrefixedPathAndGlob_StillMatchNormally()
    {
        var mapped = ImpactFixtures.Declaring("mapped", "./src/**");

        var result = ImpactSelector.Select(ImpactFixtures.SuiteOf(mapped), ["./src/a.cs"]);

        result.FellBackToFullSuite.Should().BeFalse();
        ImpactFixtures.For(result, "mapped").Reason.Should().Be(SelectionReason.GlobMatch);
    }

    /// <summary>
    /// A drive outside the system-root allowlist has no second route to recognition.
    /// </summary>
    /// <remarks>
    /// The earlier tests all used <c>C:\Users</c>, and <c>Users</c> is in the allowlist — so
    /// recognition succeeded through the system-root route even while the drive-rooted one was
    /// being sidestepped by the <c>./</c> prefix. <c>D:\build</c> has no such luck, which is why
    /// it is the case that distinguishes a fix generalised across spellings from one generalised
    /// across spellings <i>and</i> the allowlist.
    /// </remarks>
    [Theory]
    [InlineData("./D:/build/ci-user/repo/a.cs")]
    [InlineData(@".\D:\build\ci-user\repo\a.cs")]
    public void Select_ADriveOutsideTheAllowlistBehindADotPrefix_IsNotQuotedIntoTheFallbackReason(string entry)
    {
        var scenario = ImpactFixtures.Declaring("unmatched", "docs/**");

        var result = ImpactSelector.Select(ImpactFixtures.SuiteOf(scenario), ["src/a.cs", entry]);

        result.FellBackToFullSuite.Should().BeTrue();
        result.FallbackReason.Should().NotContain("ci-user").And.NotContain("build");
    }

    [Theory]
    [InlineData("./D:/build/ci-user/repo/**")]
    [InlineData(@".\D:\build\ci-user\repo\**")]
    public void Select_AGlobOnADriveOutsideTheAllowlist_IsNotQuotedIntoTheDetail(string pattern)
    {
        var scenario = ImpactFixtures.Declaring("mapped", pattern);

        var result = ImpactSelector.Select(ImpactFixtures.SuiteOf(scenario), ["src/a.cs"]);

        var selection = ImpactFixtures.For(result, "mapped");
        selection.Reason.Should().Be(SelectionReason.NoGlobsDeclared);
        selection.Detail.Should().NotContain("ci-user").And.NotContain("build");
    }
}
