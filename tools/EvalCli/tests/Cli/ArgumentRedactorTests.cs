using System.CommandLine.Parsing;
using FluentAssertions;
using Forge.EvalCli.Cli;

namespace Forge.EvalCli.Tests.Cli;

/// <summary>
/// Unit-level cover for the rule the end-to-end parse-error tests exercise through the real
/// pipeline. These pin the edges that a whole-invocation test cannot reach cheaply: what the rule
/// deliberately still echoes, and what happens to a value the parser quotes alongside something
/// else.
/// </summary>
public class ArgumentRedactorTests
{
    private static string[] Supplied(params string[] values) => values;

    [Fact]
    public void Redact_WhenAQuotedSpanIsASuppliedValue_ReplacesIt()
    {
        var redacted = ArgumentRedactor.Redact(
            "Cannot parse argument 'sk-live-abc123' for option '--seed'.",
            Supplied("sk-live-abc123")
        );

        redacted.Should().NotContain("sk-live-abc123");
        redacted.Should().Contain("--seed", "the option is the parser's word, not the caller's");
    }

    [Fact]
    public void Redact_WhenAQuotedSpanIsAnHttpUrl_ShowsOnlyWhatIdentifiesTheEnvironment()
    {
        var redacted = ArgumentRedactor.Redact(
            "Unrecognized command or argument 'https://evals.example.com/api/sk-live-abc123/run?token=xyz'.",
            Supplied("https://evals.example.com/api/sk-live-abc123/run?token=xyz")
        );

        redacted.Should().NotContain("sk-live-abc123");
        redacted.Should().NotContain("token=xyz");
        redacted.Should().Contain("https://evals.example.com");
    }

    [Fact]
    public void Redact_WhenAQuotedSpanCameFromTheParserRatherThanTheCommandLine_EchoesIt()
    {
        var redacted = ArgumentRedactor.Redact(
            "Cannot parse argument 'abcdef' for option '--seed' as expected type 'System.Int64'.",
            Supplied("abcdef")
        );

        // A span nothing supplied cannot be a supplied secret, and dropping it would cost the
        // caller the only part of the message that says what was expected.
        redacted.Should().Contain("System.Int64");
    }

    [Fact]
    public void Redact_WhenAShortValueIsMerelyASubstringOfTheParsersOwnWords_LeavesThemAlone()
    {
        // `--root .` is the documented invocation. Matching a one-character value as a substring
        // would turn every type name in every message into a marker.
        var redacted = ArgumentRedactor.Redact(
            "Cannot parse argument 'x' for option '--seed' as expected type 'System.Int64'.",
            Supplied(".")
        );

        redacted.Should().Contain("System.Int64");
    }

    [Fact]
    public void Redact_WhenASuppliedValueIsQuotedAlongsideSomethingElse_ReplacesTheWholeSpan()
    {
        var redacted = ArgumentRedactor.Redact(
            "Unrecognized command or argument '--seed=sk-live-abc123'.",
            Supplied("sk-live-abc123")
        );

        redacted.Should().NotContain("sk-live-abc123");
    }

    [Fact]
    public void Redact_WhenNothingWasSupplied_ReturnsTheMessageUnchanged()
    {
        const string message = "Required command was not provided.";

        ArgumentRedactor.Redact(message, Supplied()).Should().Be(message);
    }

    [Fact]
    public void Redact_WhenAQuoteIsUnclosed_KeepsTheRemainderRatherThanDroppingIt()
    {
        var redacted = ArgumentRedactor.Redact("Unbalanced 'quote in a message", Supplied("nothing"));

        redacted.Should().Be("Unbalanced 'quote in a message");
    }

    [Fact]
    public void SuppliedValues_ForATokenNoSymbolClaimed_IncludesIt()
    {
        var parseResult = EvalCommandLine.Build().Parse(["https://evals.example.com/api?token=sk-live-abc123"]);

        // The unmatched token is the one the parser echoes verbatim, so it is the one that most
        // needs to be in this set.
        ArgumentRedactor
            .SuppliedValues(parseResult)
            .Should()
            .Contain("https://evals.example.com/api?token=sk-live-abc123");
    }

    [Fact]
    public void SuppliedValues_ForAnOptionName_LeavesItOutSoItCanStillBeNamedBack()
    {
        var parseResult = EvalCommandLine.Build().Parse(["run", "--not-a-real-flag"]);

        ArgumentRedactor.SuppliedValues(parseResult).Should().NotContain("--not-a-real-flag");
    }

    [Theory]
    [InlineData("--suite")]
    [InlineData("--fail-on-regression")]
    [InlineData("-v")]
    [InlineData("--not-a-real-flag")]
    public void IsOptionName_ForAFlagShape_IsTrue(string value) =>
        ArgumentRedactor.IsOptionName(value).Should().BeTrue();

    [Theory]
    [InlineData("https://example.com")]
    [InlineData("-sk-live-abc123")]
    [InlineData("--seed=5")]
    [InlineData("run")]
    [InlineData("--")]
    [InlineData("-")]
    public void IsOptionName_ForAnythingThatCouldBeAValue_IsFalse(string value) =>
        ArgumentRedactor.IsOptionName(value).Should().BeFalse();

    [Fact]
    public void RedactValue_ForANonUrl_GivesNothingButTheMarker() =>
        ArgumentRedactor.RedactValue("sk-live-abc123").Should().Be(EndpointGuard.RedactionMarker);

    [Fact]
    public void RedactValue_ForAFileUrl_GivesNothingButTheMarker() =>
        // Only http and https say anything useful about an environment. A file URL is a path, and
        // a path is not this type's to decide about.
        ArgumentRedactor.RedactValue("file:///C:/secrets.json").Should().Be(EndpointGuard.RedactionMarker);
}
