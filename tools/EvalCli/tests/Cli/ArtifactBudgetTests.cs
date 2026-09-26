using System.Text;
using FluentAssertions;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Tests.Support;
using Forge.EvalEngine.Baselines;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Serialization;

namespace Forge.EvalCli.Tests.Cli;

/// <summary>
/// The budget an artifact has to fit inside to be worth publishing.
/// </summary>
/// <remarks>
/// <para>
/// <b>The destructive command's whole safety story is that it replaces something valid with
/// something valid.</b> The configured artifact reader refuses a file above its budget, so an
/// artifact published above it is one no later comparison and no trend can read — and
/// <c>baseline update --apply</c> would have reported a successful update after replacing a
/// readable baseline with an unreadable one.
/// </para>
/// <para>
/// <b>The limit is the engine's and is read, not redefined.</b> These tests assert the
/// correspondence at the boundary in both directions: the largest artifact this tool will publish
/// is exactly the largest one the reader it configures will accept.
/// </para>
/// </remarks>
public class ArtifactBudgetTests
{
    /// <summary>Conducts a real run and hands back the result it produced.</summary>
    /// <remarks>
    /// A real artifact rather than a hand-built record, for the reason <c>ComparisonWorkspace</c>
    /// gives: a hand-written one would agree with this code about a shape the reader might reject,
    /// and the property under test is exactly whether the reader accepts what the writer allows.
    /// </remarks>
    private static async Task<SuiteResult> ConductAsync(TempWorkspace workspace)
    {
        ComparisonWorkspace.WriteSuite(workspace);

        await using var endpoint = ComparisonWorkspace.Endpoint();

        using var console = new RecordingConsole();

        var code = await RunCommand.ExecuteAsync(
            RunPlan.Create(
                new RunRequest
                {
                    Suite = "eval-suites/regression.json",
                    Root = workspace.Root,
                    Out = "artifacts/run.json",
                    Endpoint = endpoint.Address.ToString(),
                    RestExchange = "json",
                }
            ),
            console,
            CancellationToken.None
        );

        code.Should().Be(ExitCode.Success, console.StandardError);

        return CanonicalJson.DeserializeSuiteResult(
            await File.ReadAllTextAsync(Path.Combine(workspace.Root, "artifacts", "run.json"))
        );
    }

    // -------------------------------------------------------------------------------------
    // The boundary, from the writing side.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task Publishable_WhenTheArtifactIsExactlyTheBudget_ProducesTheBytes()
    {
        using var workspace = new TempWorkspace();

        var result = await ConductAsync(workspace);
        var exact = Encoding.UTF8.GetByteCount(ArtifactBudget.Publishable(result));

        ArtifactBudget.Publishable(result, exact).Should().NotBeNullOrEmpty();
    }

    [Fact]
    public async Task Publishable_WhenTheArtifactIsOneByteOverTheBudget_RefusesRatherThanPublishing()
    {
        using var workspace = new TempWorkspace();

        var result = await ConductAsync(workspace);
        var exact = Encoding.UTF8.GetByteCount(ArtifactBudget.Publishable(result));

        var refusal = Assert.Throws<EvalCliException>(() => ArtifactBudget.Publishable(result, exact - 1));

        refusal.ExitCode.Should().Be(ExitCode.RunFailed);
        refusal.ExitCode.Should().NotBe(ExitCode.Success);
    }

    [Fact]
    public async Task Publishable_WhenTheArtifactIsOverTheBudget_SaysWhatWillNotBeAbleToReadIt()
    {
        using var workspace = new TempWorkspace();

        var result = await ConductAsync(workspace);
        var exact = Encoding.UTF8.GetByteCount(ArtifactBudget.Publishable(result));

        var refusal = Assert.Throws<EvalCliException>(() => ArtifactBudget.Publishable(result, exact - 1));

        // A refusal has to tell the caller what to do, not only what failed.
        refusal.Message.Should().Contain(exact.ToString("N0", System.Globalization.CultureInfo.InvariantCulture));
        refusal.Remedy.Should().NotBeNullOrWhiteSpace();
    }

    [Fact]
    public async Task Publishable_ForAnArtifactWithinTheBudget_StillRedactsTheAddressItRecords()
    {
        // The budget sits on the same step redaction does, so a change to one must not quietly
        // drop the other: an address recorded in a committed baseline is in the repository's
        // history from that commit onwards (§V).
        using var workspace = new TempWorkspace();

        var result = await ConductAsync(workspace);

        var published = ArtifactBudget.Publishable(
            result with
            {
                Environment = result.Environment with { Endpoint = "https://example.com/api?token=abcdef" },
            }
        );

        published.Should().NotContain("abcdef");
    }

    // -------------------------------------------------------------------------------------
    // The same boundary, from the reading side. This is the pair that makes the number mean
    // something: one byte either side of it, the writer and the reader must agree.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task TryGetBaselineAsync_ForAnArtifactTheBudgetAllowed_ReadsItBackAtTheBoundary()
    {
        using var workspace = new TempWorkspace();

        var result = await ConductAsync(workspace);
        var published = ArtifactBudget.Publishable(result);
        var exact = Encoding.UTF8.GetByteCount(published);

        await File.WriteAllTextAsync(
            Path.Combine(workspace.Root, "artifacts", "published.json"),
            published,
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false)
        );

        var read = await new ArtifactBaseline(workspace.Root, exact).TryGetBaselineAsync(
            "artifacts/published.json",
            CancellationToken.None
        );

        read.Should().NotBeNull("the largest artifact this tool publishes must be one the reader accepts");
    }

    [Fact]
    public async Task TryGetBaselineAsync_ForAnArtifactOneByteOverTheBudget_RefusesToReadIt()
    {
        // The other half. Without this, the boundary above could be satisfied by a reader whose
        // budget was simply larger than anything these tests produce.
        using var workspace = new TempWorkspace();

        var result = await ConductAsync(workspace);
        var published = ArtifactBudget.Publishable(result);
        var exact = Encoding.UTF8.GetByteCount(published);

        await File.WriteAllTextAsync(
            Path.Combine(workspace.Root, "artifacts", "published.json"),
            published,
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false)
        );

        var act = async () =>
            await new ArtifactBaseline(workspace.Root, exact - 1).TryGetBaselineAsync(
                "artifacts/published.json",
                CancellationToken.None
            );

        await act.Should().ThrowAsync<InvalidOperationException>();
    }

    [Fact]
    public void Bytes_IsTheEnginesOwnBudgetRatherThanASecondCopyOfIt() =>
        ArtifactBudget.Bytes.Should().Be(ArtifactBaseline.DefaultMaxBytes);

    // -------------------------------------------------------------------------------------
    // The ceiling is a test seam, and a test seam that can be widened is not a barrier.
    // -------------------------------------------------------------------------------------

    [Fact]
    public async Task Publishable_WhenTheCeilingIsAboveTheReadersBudget_RefusesRatherThanProducingBytes()
    {
        // The parameter exists so the boundary can be exercised at a size a test can produce.
        // Left unbounded it is also a way to obtain redacted, publishable bytes larger than the
        // reader accepts — which is the barrier this type claims, with a door in it.
        using var workspace = new TempWorkspace();

        var result = await ConductAsync(workspace);

        var act = () => ArtifactBudget.Publishable(result, ArtifactBudget.Bytes + 1);

        act.Should().Throw<ArgumentOutOfRangeException>();
    }

    [Fact]
    public async Task Publishable_WhenTheCeilingIsTheReadersBudget_IsAccepted()
    {
        // The clamp refuses above the budget, not at it: the default overload passes exactly this
        // value, so refusing here would refuse every production call.
        using var workspace = new TempWorkspace();

        var result = await ConductAsync(workspace);

        ArtifactBudget.Publishable(result, ArtifactBudget.Bytes).Should().NotBeNullOrEmpty();
    }

    // -------------------------------------------------------------------------------------
    // Size is not shape. "Published implies readable" has to hold for both, or it is a
    // guarantee that is half-enforced and stated whole.
    // -------------------------------------------------------------------------------------

    /// <summary>A suite name the reader refuses: a machine path at a token boundary.</summary>
    private const string MachinePathName = @"regression C:\Users\ci-user\checkout";

    [Fact]
    public async Task Publishable_WhenTheArtifactCarriesAMachinePathIdentifier_RefusesBeforePublication()
    {
        using var workspace = new TempWorkspace();

        var result = await ConductAsync(workspace);

        var refusal = Assert.Throws<EvalCliException>(() =>
            ArtifactBudget.Publishable(result with { SuiteName = MachinePathName })
        );

        refusal.ExitCode.Should().Be(ExitCode.RunFailed);
        refusal.ExitCode.Should().NotBe(ExitCode.Success);
        refusal.Message.Should().Contain("suiteName");
    }

    [Fact]
    public async Task Publishable_WhenTheArtifactCarriesAMachinePathIdentifier_NeverRepeatsTheValue()
    {
        // The engine withheld the value on purpose: this message reaches stderr and from there the
        // build log. A tool that re-prints it has moved the disclosure rather than removed it (§V).
        using var workspace = new TempWorkspace();

        var result = await ConductAsync(workspace);

        var refusal = Assert.Throws<EvalCliException>(() =>
            ArtifactBudget.Publishable(result with { SuiteName = MachinePathName })
        );

        (refusal.Message + refusal.Remedy).Should().NotContain("ci-user").And.NotContain(@"C:\Users");
    }

    [Fact]
    public async Task Publishable_ForAnArtifactItAccepts_ProducesOneTheReadersOwnShapeCheckAccepts()
    {
        // The positive half. Without it the refusal above could be satisfied by a check that
        // refuses everything, and every run would report a failure it did not have.
        using var workspace = new TempWorkspace();

        var result = await ConductAsync(workspace);

        var act = () => CanonicalJson.DeserializeSuiteResult(ArtifactBudget.Publishable(result));

        act.Should().NotThrow();
    }
}
