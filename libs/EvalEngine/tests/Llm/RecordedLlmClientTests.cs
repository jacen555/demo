using FluentAssertions;
using Forge.EvalEngine.Abstractions;
using Forge.EvalEngine.Llm;

namespace Forge.EvalEngine.Tests.Llm;

/// <summary>
/// The fake that makes a model-driven run reproducible.
/// </summary>
/// <remarks>
/// The claim under test is narrow and load-bearing: <b>replay is a function of request content
/// alone</b>. Sampling parameters are excluded from a request's identity because a seed is a
/// best-effort provider hint rather than a reproducibility guarantee, and because providers are
/// withdrawing the sampling parameters outright. A fake that keyed on them would be reproducible
/// only while the provider co-operated.
/// </remarks>
public sealed class RecordedLlmClientTests
{
    private static LlmRecording Recording(string prompt, string completion, params string[] context) =>
        new()
        {
            Prompt = prompt,
            Context = context,
            Completion = completion,
        };

    private static RecordedLlmClient Client(params LlmRecording[] recordings) => new(recordings);

    [Fact]
    public async Task CompleteAsync_RequestMatchingARecording_ReplaysThatCompletion()
    {
        var client = Client(Recording("say hello", "hello there"));

        var completion = await client.CompleteAsync(new LlmRequest { Prompt = "say hello" }, default);

        completion.Should().Be("hello there");
    }

    /// <summary>
    /// The headline property. A seed is a hint, so it must not participate in identity — a caller
    /// that varied its seed per repetition would otherwise start missing every recording.
    /// </summary>
    [Fact]
    public async Task CompleteAsync_SameContentDifferentSeed_ReplaysTheSameCompletion()
    {
        var client = Client(Recording("say hello", "hello there"));

        var first = await client.CompleteAsync(new LlmRequest { Prompt = "say hello", Seed = 1 }, default);
        var second = await client.CompleteAsync(new LlmRequest { Prompt = "say hello", Seed = 999 }, default);
        var none = await client.CompleteAsync(new LlmRequest { Prompt = "say hello", Seed = null }, default);

        first.Should().Be("hello there");
        second.Should().Be(first);
        none.Should().Be(first);
    }

    /// <summary>
    /// The same property for the parameter providers are actively removing. A request that omits
    /// it must not be a different request.
    /// </summary>
    [Fact]
    public async Task CompleteAsync_SameContentDifferentTemperature_ReplaysTheSameCompletion()
    {
        var client = Client(Recording("say hello", "hello there"));

        var hot = await client.CompleteAsync(new LlmRequest { Prompt = "say hello", Temperature = 1.5 }, default);
        var cold = await client.CompleteAsync(new LlmRequest { Prompt = "say hello", Temperature = 0 }, default);
        var absent = await client.CompleteAsync(new LlmRequest { Prompt = "say hello" }, default);

        hot.Should().Be("hello there");
        cold.Should().Be(hot);
        absent.Should().Be(hot);
    }

    [Fact]
    public async Task CompleteAsync_SameRequestTwice_ReplaysTheSameCompletionBothTimes()
    {
        var client = Client(Recording("say hello", "hello there"));

        var first = await client.CompleteAsync(new LlmRequest { Prompt = "say hello" }, default);
        var second = await client.CompleteAsync(new LlmRequest { Prompt = "say hello" }, default);

        second.Should().Be(first);
    }

    [Fact]
    public async Task CompleteAsync_ContextDiffers_ReplaysTheRecordingForThatContext()
    {
        var client = Client(
            Recording("what next", "ask about the order", "system: hello"),
            Recording("what next", "give the order number", "system: what is your order number?")
        );

        var opening = await client.CompleteAsync(
            new LlmRequest { Prompt = "what next", Context = ["system: hello"] },
            default
        );
        var later = await client.CompleteAsync(
            new LlmRequest { Prompt = "what next", Context = ["system: what is your order number?"] },
            default
        );

        opening.Should().Be("ask about the order");
        later.Should().Be("give the order number");
    }

    /// <summary>
    /// A fallback for an unmatched request is how a fake manufactures a false green: the test
    /// stops exercising what it was written to exercise and the transcript still looks real.
    /// </summary>
    [Fact]
    public async Task CompleteAsync_NoRecordingForTheRequest_ThrowsMissingRecordingException()
    {
        var client = Client(Recording("say hello", "hello there"));

        var complete = async () => await client.CompleteAsync(new LlmRequest { Prompt = "say goodbye" }, default);

        await complete.Should().ThrowAsync<MissingRecordingException>();
    }

    [Fact]
    public async Task CompleteAsync_RecordingMatchesOnPromptButNotContext_ThrowsMissingRecordingException()
    {
        var client = Client(Recording("what next", "ask about the order", "system: hello"));

        var complete = async () =>
            await client.CompleteAsync(
                new LlmRequest { Prompt = "what next", Context = ["system: something else"] },
                default
            );

        await complete.Should().ThrowAsync<MissingRecordingException>();
    }

    /// <summary>
    /// A model that says nothing is a real case, and the one a conversational harness most needs
    /// to be able to reproduce. Refusing to record it would put it out of reach.
    /// </summary>
    [Fact]
    public async Task CompleteAsync_RecordingWithABlankCompletion_ReplaysTheBlank()
    {
        var client = Client(Recording("say hello", string.Empty));

        var completion = await client.CompleteAsync(new LlmRequest { Prompt = "say hello" }, default);

        completion.Should().BeEmpty();
    }

    /// <summary>
    /// The key is length-prefixed, so there is no separator to inject. Without that, a prompt
    /// could be written to collide with a different prompt-plus-context and replay the wrong
    /// completion — a false green built out of string formatting.
    /// </summary>
    [Fact]
    public async Task CompleteAsync_ContentThatCouldCollideOnASeparator_StaysDistinct()
    {
        var client = Client(
            Recording("alpha\u001fbeta", "from the joined prompt"),
            Recording("alpha", "from the split context", "beta")
        );

        var joined = await client.CompleteAsync(new LlmRequest { Prompt = "alpha\u001fbeta" }, default);
        var split = await client.CompleteAsync(new LlmRequest { Prompt = "alpha", Context = ["beta"] }, default);

        joined.Should().Be("from the joined prompt");
        split.Should().Be("from the split context");
    }

    [Fact]
    public void Constructor_TwoRecordingsWithTheSameContent_ThrowsArgumentException()
    {
        Action build = () => Client(Recording("say hello", "one"), Recording("say hello", "two"));

        build.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void Constructor_TwoRecordingsDifferingOnlyByContext_IsAccepted()
    {
        Action build = () => Client(Recording("say hello", "one", "a"), Recording("say hello", "two", "b"));

        build.Should().NotThrow();
    }

    [Fact]
    public void Constructor_NullRecordings_ThrowsArgumentNullException()
    {
        Action build = () => _ = new RecordedLlmClient(null!);

        build.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Constructor_ARecordingIsNull_ThrowsArgumentNullException()
    {
        Action build = () => _ = new RecordedLlmClient([Recording("say hello", "one"), null!]);

        build.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public async Task CompleteAsync_NullRequest_ThrowsArgumentNullException()
    {
        var client = Client(Recording("say hello", "hello there"));

        var complete = async () => await client.CompleteAsync(null!, default);

        await complete.Should().ThrowAsync<ArgumentNullException>();
    }

    [Fact]
    public async Task CompleteAsync_CancelledToken_ThrowsOperationCanceledException()
    {
        var client = Client(Recording("say hello", "hello there"));
        using var cancellation = new CancellationTokenSource();
        await cancellation.CancelAsync();

        var complete = async () =>
            await client.CompleteAsync(new LlmRequest { Prompt = "say hello" }, cancellation.Token);

        await complete.Should().ThrowAsync<OperationCanceledException>();
    }

    [Fact]
    public async Task Requests_AfterSeveralCalls_RecordsWhatTheCallerAsked()
    {
        var client = Client(Recording("say hello", "one"), Recording("say goodbye", "two"));

        await client.CompleteAsync(new LlmRequest { Prompt = "say hello" }, default);
        await client.CompleteAsync(new LlmRequest { Prompt = "say goodbye" }, default);

        client.Requests.Select(request => request.Prompt).Should().Equal("say hello", "say goodbye");
    }

    [Fact]
    public async Task Requests_AfterAMissingRecording_StillRecordsTheAttempt()
    {
        var client = Client(Recording("say hello", "one"));

        var complete = async () => await client.CompleteAsync(new LlmRequest { Prompt = "say goodbye" }, default);
        await complete.Should().ThrowAsync<MissingRecordingException>();

        client.Requests.Should().ContainSingle().Which.Prompt.Should().Be("say goodbye");
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Prompt_Blank_IsRefusedByTheRecordingAndTheRequest(string prompt)
    {
        Action recording = () => _ = new LlmRecording { Prompt = prompt, Completion = "x" };
        Action request = () => _ = new LlmRequest { Prompt = prompt };

        recording.Should().Throw<ArgumentException>();
        request.Should().Throw<ArgumentException>();
    }
}
