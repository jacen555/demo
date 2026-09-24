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
    /// <returns>The fragment.</returns>
    public static string Scenario(string id, string[]? impactGlobs = null, string opening = "hello")
    {
        var globs = impactGlobs is null
            ? string.Empty
            : ", \"selection\": { \"impactGlobs\": [" + string.Join(",", impactGlobs.Select(Quote)) + "] }";

        return "{ \"identity\": { \"id\": \""
            + id
            + "\", \"kind\": \"rest\" }, \"execution\": { \"mode\": \"deterministic\" }, "
            + "\"simulation\": { \"opening\": \""
            + opening
            + "\" }"
            + globs
            + " }";
    }

    private static string Quote(string value) => "\"" + value + "\"";
}
