using System.Globalization;
using System.Text;

namespace Forge.EvalCli.Tests.Support;

/// <summary>
/// Builds suite documents that the engine's loader actually accepts.
/// </summary>
/// <remarks>
/// Written as JSON text rather than serialized from engine records on purpose: what these tests
/// exercise is the path a real suite file takes through the loader, and a fixture that skipped
/// parsing would agree with the code about a shape the loader might reject.
/// </remarks>
internal static class SuiteFixture
{
    /// <summary>Builds a suite document.</summary>
    /// <param name="name">The suite name, which labels the artifact.</param>
    /// <param name="scenarios">Scenario fragments, from <see cref="Scenario"/>.</param>
    /// <returns>The document.</returns>
    public static string Suite(string name, params string[] scenarios)
    {
        var text = new StringBuilder();

        text.Append("{ \"schemaVersion\": \"1.0\", \"name\": \"").Append(name).Append("\", \"scenarios\": [");
        text.Append(string.Join(",", scenarios));
        text.Append("] }");

        return text.ToString();
    }

    /// <summary>Builds one REST scenario fragment.</summary>
    /// <param name="id">The scenario id, which is the join key against a baseline.</param>
    /// <param name="impactGlobs">The impact globs it declares, or none.</param>
    /// <param name="opening">The opening stimulus.</param>
    /// <param name="expectedOutcome">
    /// The outcome the scenario is graded against with <c>exactMatch:outcome</c>, or null for a
    /// scenario that declares no assertions.
    /// </param>
    /// <param name="repetitions">
    /// How many times the scenario is repeated. More than one is what lets a test produce a
    /// scenario that was only partly conducted — one repetition graded, another errored.
    /// </param>
    /// <returns>The fragment.</returns>
    /// <remarks>
    /// <paramref name="expectedOutcome"/> is what lets a test produce a real pass and a real
    /// failure from the same suite by changing only what the system under test answers — which
    /// is the only honest way to exercise a comparison. <paramref name="opening"/> feeds the
    /// definition fingerprint, so changing it is also how a test produces a genuine redefinition.
    /// </remarks>
    public static string Scenario(
        string id,
        string[]? impactGlobs = null,
        string opening = "hello",
        string? expectedOutcome = null,
        int repetitions = 1
    )
    {
        var globs = impactGlobs is null
            ? string.Empty
            : ", \"selection\": { \"impactGlobs\": [" + string.Join(",", impactGlobs.Select(Quote)) + "] }";

        var grading = expectedOutcome is null
            ? string.Empty
            : ", \"grading\": { \"expectedOutcome\": "
                + Quote(expectedOutcome)
                + ", \"assertions\": [\"exactMatch:outcome\"] }";

        var policy =
            repetitions == 1
                ? string.Empty
                : ", \"repetitionPolicy\": " + repetitions.ToString(CultureInfo.InvariantCulture);

        return "{ \"identity\": { \"id\": \""
            + id
            + "\", \"kind\": \"rest\" }, \"execution\": { \"mode\": \"deterministic\""
            + policy
            + " }, "
            + "\"simulation\": { \"opening\": \""
            + opening
            + "\" }"
            + grading
            + globs
            + " }";
    }

    private static string Quote(string value) => "\"" + value + "\"";
}
