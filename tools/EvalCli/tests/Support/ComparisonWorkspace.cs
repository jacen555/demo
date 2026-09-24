using System.Text.Json;

namespace Forge.EvalCli.Tests.Support;

/// <summary>
/// The shared scaffolding for a comparison: a workspace, a suite whose scenarios really can pass
/// and really can fail, and a baseline produced by an actual run.
/// </summary>
/// <remarks>
/// <b>Baselines here are produced by running the tool, never hand-written.</b> A hand-written
/// artifact would pin these tests to a definition fingerprint and a schema rather than to the
/// behaviour, and would agree with the code about a shape the loader might reject — which is the
/// same reason <see cref="SuiteFixture"/> writes suite JSON rather than serializing engine
/// records.
/// </remarks>
internal static class ComparisonWorkspace
{
    /// <summary>The scenario whose behaviour a test varies between the two runs.</summary>
    public const string Checkout = "checkout";

    /// <summary>A second scenario, so a test can change one and hold the other still.</summary>
    public const string Billing = "billing";

    /// <summary>What a scenario is graded against. The stub answers this to pass and anything else to fail.</summary>
    public const string ExpectedOutcome = "done";

    /// <summary>Writes the two-scenario suite both variants are conducted from.</summary>
    /// <param name="workspace">Where to write it.</param>
    /// <param name="checkoutOpening">
    /// The opening stimulus for <see cref="Checkout"/>. It feeds the definition fingerprint, so
    /// changing it between two runs is how a test produces a genuine redefinition.
    /// </param>
    public static void WriteSuite(TempWorkspace workspace, string checkoutOpening = "hello") =>
        workspace.WriteFile(
            Path.Combine("eval-suites", "regression.json"),
            SuiteFixture.Suite(
                "regression",
                SuiteFixture.Scenario(Checkout, ["src/**"], opening: checkoutOpening, expectedOutcome: ExpectedOutcome),
                SuiteFixture.Scenario(Billing, ["docs/**"], expectedOutcome: ExpectedOutcome)
            )
        );

    /// <summary>An endpoint that answers <paramref name="failing"/> with a wrong outcome.</summary>
    /// <param name="failing">The scenario ids that should fail. Everything else passes.</param>
    /// <returns>The endpoint.</returns>
    /// <remarks>
    /// The verdict is driven by what the system under test <i>answers</i>, never by editing an
    /// artifact — so a Regressed or Fixed classification in these tests was earned by a change in
    /// behaviour, exactly as it would be in a real comparison.
    /// </remarks>
    public static StubEndpoint Endpoint(params string[] failing) =>
        new(body =>
        {
            using var request = JsonDocument.Parse(body);

            var scenario = request.RootElement.GetProperty("scenarioId").GetString();
            var outcome = failing.Contains(scenario, StringComparer.Ordinal) ? "broken" : ExpectedOutcome;

            return (200, $"{{ \"output\": \"ok\", \"outcome\": \"{outcome}\" }}");
        });
}
