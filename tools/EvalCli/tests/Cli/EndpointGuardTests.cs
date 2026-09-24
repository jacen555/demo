using FluentAssertions;
using Forge.EvalCli.Cli;

namespace Forge.EvalCli.Tests.Cli;

public class EndpointGuardTests
{
    [Fact]
    public void Validate_WhenTheUrlCarriesCredentials_Refuses()
    {
        var act = () => EndpointGuard.Validate("https://someone:hunter2@example.com/api", "--endpoint");

        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Fact]
    public void Validate_WhenTheUrlCarriesCredentials_DoesNotEchoTheSecret()
    {
        var act = () => EndpointGuard.Validate("https://someone:hunter2@example.com/api", "--endpoint");

        var refusal = act.Should().Throw<EvalCliException>().Which;

        refusal.Message.Should().NotContain("hunter2");
        refusal.Message.Should().NotContain("someone");
        refusal.Remedy.Should().NotContain("hunter2");
    }

    [Fact]
    public void Validate_WhenTheValueIsNotAnAbsoluteUrl_RefusesWithoutEchoingIt()
    {
        var act = () => EndpointGuard.Validate("not a url ?token=abcdef", "--endpoint");

        var refusal = act.Should().Throw<EvalCliException>().Which;

        refusal.ExitCode.Should().Be(ExitCode.UsageError);
        refusal.Message.Should().NotContain("abcdef");
    }

    [Theory]
    [InlineData("ftp://example.com/api")]
    [InlineData("file:///C:/secrets.json")]
    public void Validate_WhenTheSchemeIsNotHttpOrHttps_Refuses(string value)
    {
        var act = () => EndpointGuard.Validate(value, "--endpoint");

        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Fact]
    public void Validate_WhenTheValueIsBlank_Refuses()
    {
        var act = () => EndpointGuard.Validate("   ", "--endpoint");

        act.Should().Throw<EvalCliException>().Which.ExitCode.Should().Be(ExitCode.UsageError);
    }

    [Fact]
    public void Validate_WhenTheUrlCarriesAQueryString_KeepsItForDiallingButRedactsTheDisplayForm()
    {
        var (endpoint, display) = EndpointGuard.Validate("https://example.com/api?token=abcdef", "--endpoint");

        // A dialling stage needs the query; nothing that prints may have it.
        endpoint.Query.Should().Contain("abcdef");
        display.Should().NotContain("abcdef");
        display.Should().Be($"https://example.com/{EndpointGuard.RedactionMarker}?{EndpointGuard.RedactionMarker}");
    }

    [Fact]
    public void Validate_WhenTheUrlCarriesAFragment_RedactsTheDisplayForm()
    {
        var (_, display) = EndpointGuard.Validate("https://example.com/api#access_token=abcdef", "--endpoint");

        display.Should().NotContain("abcdef");
        display.Should().Be($"https://example.com/{EndpointGuard.RedactionMarker}#{EndpointGuard.RedactionMarker}");
    }

    [Fact]
    public void Validate_WhenTheUrlHidesACredentialInThePath_DropsThePathFromTheDisplayForm()
    {
        var (endpoint, display) = EndpointGuard.Validate("https://example.com/api/sk-live-abc123/run", "--endpoint");

        // A path segment is as capable of carrying a key as a query parameter is, and nothing here
        // can tell a routing segment from a credential by looking at it.
        endpoint.AbsolutePath.Should().Contain("sk-live-abc123");
        display.Should().NotContain("sk-live-abc123");
        display.Should().Be($"https://example.com/{EndpointGuard.RedactionMarker}");
    }

    [Fact]
    public void Validate_ForAnAddressWithAPath_KeepsOnlyWhatIdentifiesTheEnvironment()
    {
        var (_, display) = EndpointGuard.Validate("https://localhost:5001/eval", "--endpoint");

        // Scheme, host, and port answer "am I pointed at the right environment", which is the only
        // question this string exists to answer.
        display.Should().Be($"https://localhost:5001/{EndpointGuard.RedactionMarker}");
    }

    [Fact]
    public void Validate_ForAnAddressWithNoPath_LeavesNoMarkerBehind()
    {
        var (_, display) = EndpointGuard.Validate("https://localhost:5001", "--endpoint");

        display.Should().Be("https://localhost:5001");
    }

    [Fact]
    public void Redact_WhenThePortIsTheSchemeDefault_LeavesItOut() =>
        EndpointGuard
            .Redact(new Uri("https://example.com:443/api"))
            .Should()
            .Be($"https://example.com/{EndpointGuard.RedactionMarker}");

    [Fact]
    public void Redact_WhenThePortIsNotTheSchemeDefault_KeepsIt() =>
        EndpointGuard
            .Redact(new Uri("http://example.com:8080/api"))
            .Should()
            .Be($"http://example.com:8080/{EndpointGuard.RedactionMarker}");

    [Fact]
    public void Redact_WhenTheAddressCarriesUserInfo_ReplacesItWithAMarker()
    {
        var redacted = EndpointGuard.Redact(new Uri("https://someone:hunter2@example.com/api"));

        redacted.Should().NotContain("hunter2");
        redacted.Should().Be($"https://{EndpointGuard.RedactionMarker}@example.com/{EndpointGuard.RedactionMarker}");
    }
}
