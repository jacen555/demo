using System.Text.Json;
using FluentAssertions;
using Forge.EvalEngine.Baselines;
using Forge.EvalEngine.Comparison;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Serialization;
using Forge.EvalEngine.Tests.Comparison;

namespace Forge.EvalEngine.Tests.Baselines;

/// <summary>
/// A committed artifact is untrusted input, and the failure mode that matters is a false "there
/// is no baseline": the caller reports "no regression", and the reason is that nothing was ever
/// compared.
/// </summary>
public sealed class ArtifactBaselineTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("forge-baseline-").FullName;

    public void Dispose() => Directory.Delete(_root, recursive: true);

    private string Write(string relativePath, string content)
    {
        var path = Path.Combine(_root, relativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);

        return path;
    }

    private static SuiteResult Artifact() =>
        ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)]);

    [Fact]
    public async Task TryGetBaselineAsync_ArtifactUnderTheRoot_ReturnsIt()
    {
        Write("baseline.json", CanonicalJson.Serialize(Artifact()));

        var baseline = await new ArtifactBaseline(_root).TryGetBaselineAsync("baseline.json", CancellationToken.None);

        baseline.Should().NotBeNull();
        baseline!.SuiteName.Should().Be(ComparisonFixtures.SuiteName);
        baseline.ScenarioResults.Should().ContainSingle().Which.ScenarioId.Should().Be("a");
    }

    [Fact]
    public async Task TryGetBaselineAsync_ArtifactInASubdirectory_ReturnsIt()
    {
        Write(Path.Combine("main", "baseline.json"), CanonicalJson.Serialize(Artifact()));

        var baseline = await new ArtifactBaseline(_root).TryGetBaselineAsync(
            Path.Combine("main", "baseline.json"),
            CancellationToken.None
        );

        baseline.Should().NotBeNull();
    }

    [Fact]
    public async Task TryGetBaselineAsync_NoArtifactAtThatReference_ReturnsNull()
    {
        var baseline = await new ArtifactBaseline(_root).TryGetBaselineAsync("absent.json", CancellationToken.None);

        baseline.Should().BeNull();
    }

    [Fact]
    public async Task TryGetBaselineAsync_ReferenceNamingADirectory_ThrowsRatherThanReportingNoBaseline()
    {
        // A directory is not an absent file. FileInfo.Exists reports false for one, so the
        // reference reads as "there is no baseline here", the caller reports "no regression",
        // and the reason is that nothing was ever compared.
        Directory.CreateDirectory(Path.Combine(_root, "baseline.json"));

        var provider = new ArtifactBaseline(_root);
        var act = async () => await provider.TryGetBaselineAsync("baseline.json", CancellationToken.None);

        (await act.Should().ThrowAsync<IOException>()).WithMessage("*directory*");
    }

    [Fact]
    public async Task TryGetBaselineAsync_ReferenceNamingADirectoryInASubtree_ThrowsRatherThanReportingNoBaseline()
    {
        Directory.CreateDirectory(Path.Combine(_root, "main", "baseline.json"));

        var provider = new ArtifactBaseline(_root);
        var act = async () =>
            await provider.TryGetBaselineAsync(Path.Combine("main", "baseline.json"), CancellationToken.None);

        // The message matters: without the directory check the length probe throws
        // FileNotFoundException, which is an IOException too, so a bare type assertion would
        // pass on a guard that is not there.
        (await act.Should().ThrowAsync<IOException>()).WithMessage("*directory*");
    }

    [Fact]
    public async Task TryGetBaselineAsync_ReferenceThatCannotBeInspected_IsRefusedRatherThanReportedAbsent()
    {
        // A name the host cannot stat at all. Whether there is a baseline behind it is unknown,
        // and unknown is not absent — this is refused at the resolution boundary rather than
        // reaching the file check and returning null.
        var provider = new ArtifactBaseline(_root);
        var act = async () =>
            await provider.TryGetBaselineAsync(new string('x', 280) + ".json", CancellationToken.None);

        await act.Should().ThrowAsync<ArgumentException>();
    }

    [Fact]
    public async Task TryGetBaselineAsync_MalformedJson_ThrowsRatherThanReportingNoBaseline()
    {
        Write("baseline.json", "{ this is not json");

        var provider = new ArtifactBaseline(_root);
        var act = async () => await provider.TryGetBaselineAsync("baseline.json", CancellationToken.None);

        await act.Should().ThrowAsync<JsonException>();
    }

    [Fact]
    public async Task TryGetBaselineAsync_UnsupportedSchemaVersion_ThrowsRatherThanReportingNoBaseline()
    {
        var artifact = CanonicalJson.Serialize(Artifact()).Replace("\"1.0\"", "\"2.0\"", StringComparison.Ordinal);
        Write("baseline.json", artifact);

        var provider = new ArtifactBaseline(_root);
        var act = async () => await provider.TryGetBaselineAsync("baseline.json", CancellationToken.None);

        (await act.Should().ThrowAsync<SchemaVersionException>()).Which.DeclaredVersion.Should().Be("2.0");
    }

    [Fact]
    public async Task TryGetBaselineAsync_ArtifactDeclaringNoSchemaVersion_Throws()
    {
        Write("baseline.json", "{\"suiteName\":\"regression-suite\"}");

        var provider = new ArtifactBaseline(_root);
        var act = async () => await provider.TryGetBaselineAsync("baseline.json", CancellationToken.None);

        await act.Should().ThrowAsync<SchemaVersionException>();
    }

    [Theory]
    [InlineData("../escape.json")]
    [InlineData("nested/../../escape.json")]
    public async Task TryGetBaselineAsync_ReferenceTraversingOutsideTheRoot_Refuses(string reference)
    {
        var provider = new ArtifactBaseline(_root);
        var act = async () => await provider.TryGetBaselineAsync(reference, CancellationToken.None);

        await act.Should().ThrowAsync<ArgumentException>();
    }

    [Fact]
    public async Task TryGetBaselineAsync_AbsoluteReferenceOutsideTheRoot_Refuses()
    {
        var outside = Path.Combine(Path.GetTempPath(), "forge-outside-baseline.json");

        var provider = new ArtifactBaseline(_root);
        var act = async () => await provider.TryGetBaselineAsync(outside, CancellationToken.None);

        await act.Should().ThrowAsync<ArgumentException>();
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public async Task TryGetBaselineAsync_BlankReference_Refuses(string reference)
    {
        var provider = new ArtifactBaseline(_root);
        var act = async () => await provider.TryGetBaselineAsync(reference, CancellationToken.None);

        await act.Should().ThrowAsync<ArgumentException>();
    }

    [Fact]
    public async Task TryGetBaselineAsync_NullReference_Refuses()
    {
        var provider = new ArtifactBaseline(_root);
        var act = async () => await provider.TryGetBaselineAsync(null!, CancellationToken.None);

        await act.Should().ThrowAsync<ArgumentNullException>();
    }

    [Fact]
    public async Task TryGetBaselineAsync_ArtifactLargerThanTheBudget_RefusesBeforeReadingIt()
    {
        Write("baseline.json", CanonicalJson.Serialize(Artifact()));

        var provider = new ArtifactBaseline(_root, maxBytes: 16);
        var act = async () => await provider.TryGetBaselineAsync("baseline.json", CancellationToken.None);

        (await act.Should().ThrowAsync<InvalidOperationException>()).WithMessage("*16*");
    }

    [Fact]
    public async Task TryGetBaselineAsync_ArtifactWithinTheBudget_IsRead()
    {
        var json = CanonicalJson.Serialize(Artifact());
        Write("baseline.json", json);

        var provider = new ArtifactBaseline(_root, maxBytes: json.Length + 1);

        (await provider.TryGetBaselineAsync("baseline.json", CancellationToken.None)).Should().NotBeNull();
    }

    [Fact]
    public async Task TryGetBaselineAsync_Cancelled_Throws()
    {
        Write("baseline.json", CanonicalJson.Serialize(Artifact()));
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        var provider = new ArtifactBaseline(_root);
        var act = async () => await provider.TryGetBaselineAsync("baseline.json", cts.Token);

        await act.Should().ThrowAsync<OperationCanceledException>();
    }

    [Fact]
    public async Task TryGetBaselineAsync_LinkInsideTheRootPointingOutOfIt_Refuses()
    {
        // The case the text check alone cannot see: the reference reads as a path inside the
        // root, and only resolving it through the link shows it is not. Skipped where the host
        // will not create a link at all, rather than passing on a link that was never made.
        var outside = Directory.CreateTempSubdirectory("forge-outside-").FullName;

        try
        {
            await File.WriteAllTextAsync(
                Path.Combine(outside, "baseline.json"),
                CanonicalJson.Serialize(Artifact()),
                CancellationToken.None
            );

            try
            {
                Directory.CreateSymbolicLink(Path.Combine(_root, "linked"), outside);
            }
            catch (Exception exception) when (exception is UnauthorizedAccessException or IOException)
            {
                return;
            }

            var provider = new ArtifactBaseline(_root);
            var act = async () =>
                await provider.TryGetBaselineAsync(Path.Combine("linked", "baseline.json"), CancellationToken.None);

            await act.Should().ThrowAsync<ArgumentException>();
        }
        finally
        {
            Directory.Delete(outside, recursive: true);
        }
    }

    [Fact]
    public void Constructor_MaxBytesBelowOne_Refuses()
    {
        var act = () => new ArtifactBaseline(_root, maxBytes: 0);

        act.Should().Throw<ArgumentOutOfRangeException>();
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Constructor_BlankRoot_Refuses(string root)
    {
        var act = () => new ArtifactBaseline(root);

        act.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void Constructor_NullRoot_Refuses()
    {
        var act = () => new ArtifactBaseline(null!);

        act.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Constructor_Root_IsCanonicalized() =>
        new ArtifactBaseline(_root + Path.DirectorySeparatorChar).RootDirectory.Should().Be(_root);

    [Fact]
    public async Task TryGetBaselineAsync_RoundTripsThroughTheComparator()
    {
        // The end-to-end claim: a committed artifact and a fresh run are two SuiteResults, and
        // the comparator neither knows nor cares which came from where.
        var baseline = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Fail)]);
        Write("baseline.json", CanonicalJson.Serialize(baseline));

        var restored = await new ArtifactBaseline(_root).TryGetBaselineAsync("baseline.json", CancellationToken.None);
        var candidate = ComparisonFixtures.Artifact([ComparisonFixtures.Scenario("a", RunStatus.Pass)]);

        var result = new SuiteComparator().Compare(restored!, candidate);

        result.NewlyCovered.Should().Equal("a");
    }

    [Fact]
    public async Task TryGetBaselineAsync_RestoredArtifact_EqualsTheOneWritten()
    {
        var artifact = Artifact();
        Write("baseline.json", CanonicalJson.Serialize(artifact));

        var restored = await new ArtifactBaseline(_root).TryGetBaselineAsync("baseline.json", CancellationToken.None);

        restored.Should().Be(artifact);
    }
}
