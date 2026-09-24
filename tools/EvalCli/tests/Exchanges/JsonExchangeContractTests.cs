using FluentAssertions;
using Forge.EvalCli.Exchanges;
using Forge.EvalEngine.Runners;
using Forge.EvalEngine.Scenarios;

namespace Forge.EvalCli.Tests.Exchanges;

public class JsonExchangeContractTests
{
    [Fact]
    public void Read_ForABodyInTheContract_ReadsTheReplyTheOutcomeAndTheRoute()
    {
        var reading = JsonExchangeContract.Read(
            "{ \"output\": \"refunded\", \"outcome\": \"refund.approved\", \"path\": \"verify/refund\" }"
        );

        reading.Text.Should().Be("refunded");
        reading.ObservedOutcome.Should().Be("refund.approved");
        reading.ObservedPath.Should().Be("verify/refund");
    }

    [Fact]
    public void Read_ForATopLevelScalar_ExposesItAsAFieldAssertionsCanRead()
    {
        var reading = JsonExchangeContract.Read("{ \"output\": \"ok\", \"confidence\": 0.9, \"escalated\": false }");

        reading.Fields.Should().ContainKey("confidence").WhoseValue.Should().Be("0.9");
        reading.Fields.Should().ContainKey("escalated").WhoseValue.Should().Be("false");
    }

    [Fact]
    public void Read_WhenOutcomeIsBlank_TreatsItAsAbsentRatherThanAsATerminalSignal()
    {
        // A non-blank observed outcome is what stops the turn loop. A blank one must not.
        JsonExchangeContract.Read("{ \"output\": \"ok\", \"outcome\": \"  \" }").ObservedOutcome.Should().BeNull();
    }

    [Theory]
    [InlineData("not json at all")]
    [InlineData("[ 1, 2, 3 ]")]
    [InlineData("{ \"result\": \"ok\" }")]
    [InlineData("{ \"output\": 42 }")]
    [InlineData("{ \"output\": \"a\", \"output\": \"b\" }")]
    public void Read_ForABodyOutsideTheContract_ReportsItAsMalformedRatherThanGuessing(string body)
    {
        var act = () => JsonExchangeContract.Read(body);

        // Malformed is a finding about the system under test and stays gradeable. Guessing at a
        // field name would let a mismatched contract look like a working one.
        act.Should().Throw<MalformedResponseException>();
    }

    [Fact]
    public void Read_ForABodyItCannotInterpret_KeepsTheBodyOutOfTheMessage()
    {
        var act = () => JsonExchangeContract.Read("{ \"session\": \"sk-live-do-not-commit-this\" }");

        // The message can travel into a committed artifact, and an uninterpreted body is exactly
        // the one nothing has redacted (§V).
        act.Should().Throw<MalformedResponseException>().Which.Message.Should().NotContain("sk-live");
    }

    [Fact]
    public async Task CreateRequest_ForAStimulus_PostsTheContractBodyWithNoRequestUriOfItsOwn()
    {
        using var request = new JsonRestExchange().CreateRequest(
            new RestStimulus
            {
                Scenario = new Scenario
                {
                    Identity = new ScenarioIdentity { Id = "checkout", Kind = ScenarioKind.Rest },
                    Execution = new Execution { Mode = ExecutionMode.Deterministic },
                },
                Text = "hello",
                TurnIndex = 1,
                Seed = 7,
                Repetition = 1,
            }
        );

        request.Method.Should().Be(HttpMethod.Post);

        // Null so the runner resolves it against the client's base address, which carries the
        // endpoint's full path. A relative URI here would silently drop that path's last segment.
        request.RequestUri.Should().BeNull();

        var body = await request.Content!.ReadAsStringAsync(CancellationToken.None);

        body.Should().Contain("\"input\":\"hello\"").And.Contain("checkout");
    }
}
