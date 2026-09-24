using System.Reflection;
using FluentAssertions;
using Forge.EvalEngine.Scenarios;

namespace Forge.EvalEngine.Tests.Paths;

/// <summary>
/// Proves the confined-resolution primitive is reachable from <i>outside</i> this assembly.
/// </summary>
/// <remarks>
/// <para>
/// This test project is named in <c>InternalsVisibleTo</c>, so calling the primitive directly
/// would compile whether it is public or internal and would therefore prove nothing about what a
/// consumer can reach. Everything here is asked through <see cref="Assembly.GetExportedTypes"/>,
/// which lists only the public surface and is blind to the friend grant — the same mechanism
/// <c>ContractShapeTests</c> uses for the rest of the shipped contract.
/// </para>
/// <para>
/// The types are located by name rather than referenced directly for the same reason: a test that
/// names the type in code would fail to <i>compile</i> against an assembly that does not export
/// it, which is a build error rather than a failing test. Located by name, this fails as a test
/// against the un-promoted engine and passes against the promoted one.
/// </para>
/// <para>
/// It exists because the alternative to a reachable primitive is a second implementation of path
/// confinement in every consumer, and a containment rule implemented twice is one that will
/// eventually disagree with itself.
/// </para>
/// </remarks>
public class PublicResolutionSurfaceTests
{
    private const string BoundaryTypeName = "Forge.EvalEngine.Paths.PathBoundary";
    private const string EscapeTypeName = "Forge.EvalEngine.Paths.PathEscapesBoundaryException";

    private static IReadOnlyList<Type> Exported => typeof(Scenario).Assembly.GetExportedTypes();

    private static Type? ExportedType(string fullName) => Exported.SingleOrDefault(type => type.FullName == fullName);

    [Fact]
    public void PathBoundary_Always_IsExportedSoAConsumerOutsideTheAssemblyCanConstructIt()
    {
        var boundary = ExportedType(BoundaryTypeName);

        boundary
            .Should()
            .NotBeNull(
                "a consumer that cannot reach the confinement primitive has to write its own, and the second "
                    + "implementation is the one that gets the ordering wrong"
            );

        boundary!
            .GetConstructor(BindingFlags.Public | BindingFlags.Instance, [typeof(string)])
            .Should()
            .NotBeNull("the boundary is constructed from the root it confines to");
    }

    [Fact]
    public void PathBoundary_Resolve_IsExportedWithOnlyExportedTypesInItsSignature()
    {
        var boundary = ExportedType(BoundaryTypeName);

        boundary.Should().NotBeNull();

        var resolve = boundary!.GetMethod("Resolve", BindingFlags.Public | BindingFlags.Instance, [typeof(string)]);

        resolve.Should().NotBeNull("'resolve this path, confined to this root' is the whole consumer need");
        resolve!.ReturnType.Should().Be<string>();

        // A public method whose signature mentions an internal type is not callable from outside,
        // so exporting the type alone is not the same as exporting a usable operation.
        resolve
            .GetParameters()
            .Select(parameter => parameter.ParameterType)
            .Append(resolve.ReturnType)
            .Should()
            .OnlyContain(type => type.IsPublic, "a signature a consumer cannot name is a signature it cannot call");
    }

    [Fact]
    public void PathBoundary_Root_IsExportedSoACallerCanReportTheBoundaryItGot()
    {
        var boundary = ExportedType(BoundaryTypeName);

        boundary.Should().NotBeNull();

        var root = boundary!.GetProperty("Root", BindingFlags.Public | BindingFlags.Instance);

        root.Should().NotBeNull("the root is canonicalized on construction, so the caller's own string is not it");
        root!.PropertyType.Should().Be<string>();
        root.CanWrite.Should().BeFalse("a boundary whose root can be moved after construction confines nothing");
    }

    [Fact]
    public void PathEscapesBoundaryException_Always_IsExportedAndDerivesFromIOException()
    {
        var escape = ExportedType(EscapeTypeName);

        escape
            .Should()
            .NotBeNull("refusal is the primitive's main answer, so the type carrying it is part of the contract");

        escape!
            .Should()
            .BeDerivedFrom<IOException>(
                "a caller that handles only IOException must still fail closed rather than see the refusal escape"
            );
    }
}
