using Forge.EvalEngine.Abstractions;

namespace Forge.EvalEngine.Tests.Llm;

/// <summary>
/// A model under the test's control. Deliberately not <see cref="EvalEngine.Llm.RecordedLlmClient"/>:
/// a test of the caller must not depend on the fake's matching rules, and a test of the fake must
/// not depend on the caller's prompt shape.
/// </summary>
internal sealed class StubLlmClient(Func<LlmRequest, string> complete) : ILlmClient
{
    private readonly List<LlmRequest> _requests = [];

    /// <summary>A client that answers every request with the same completion.</summary>
    public StubLlmClient(string completion)
        : this(_ => completion) { }

    public IReadOnlyList<LlmRequest> Requests => _requests;

    public LlmRequest LastRequest =>
        _requests.Count == 0
            ? throw new Xunit.Sdk.XunitException("the caller never asked the model anything")
            : _requests[^1];

    /// <summary>Work performed before answering — used to cancel mid-call.</summary>
    public Action? BeforeAnswering { get; init; }

    /// <summary>An exception raised instead of answering.</summary>
    public Func<Exception>? Throws { get; init; }

    public Task<string> CompleteAsync(LlmRequest request, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(request);
        _requests.Add(request);
        BeforeAnswering?.Invoke();
        cancellationToken.ThrowIfCancellationRequested();

        return Throws is null ? Task.FromResult(complete(request)) : Task.FromException<string>(Throws());
    }
}
