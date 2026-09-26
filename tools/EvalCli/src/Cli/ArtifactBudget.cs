using System.Globalization;
using System.Text;
using System.Text.Json;
using Forge.EvalEngine.Baselines;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Serialization;

namespace Forge.EvalCli.Cli;

/// <summary>
/// The one place artifact bytes are produced, and the budget they have to fit inside to be worth
/// producing.
/// </summary>
/// <remarks>
/// <para>
/// <b>An artifact above the reader's budget is an artifact nothing can read.</b>
/// <see cref="ArtifactBaseline"/> refuses a file larger than the budget it was configured with —
/// before a byte is allocated, so a reference to something enormous is a stated refusal rather
/// than an exhausted host. Publishing above that budget therefore produces a file that every
/// later comparison and every trend refuses, and <c>baseline update --apply</c> would have
/// reported a successful update after replacing a readable baseline with one nothing can load.
/// That is the destructive command's whole safety story failing quietly: it replaces something
/// valid with something valid, or it must not replace at all.
/// </para>
/// <para>
/// <b>The budget is the engine's and is read, not redefined.</b>
/// <see cref="ArtifactBaseline.DefaultMaxBytes"/> is the number; a second copy of it here would
/// be the pair of readings that eventually disagree, and the direction they would disagree in is
/// publishing something unreadable. <c>EvalCliServicesTests</c> pins that the reader this tool
/// actually registers accepts exactly what <see cref="Bytes"/> allows.
/// </para>
/// <para>
/// <b>Measured in UTF-8 bytes, because that is what lands on disk.</b> <c>ArtifactWriter</c>
/// writes with a UTF-8 encoder that emits no byte-order mark, so the count taken here is the
/// length the reader will stat — the comparison is exact at the boundary rather than
/// approximately right. Characters would not be: one emoji in a scenario id is four bytes.
/// </para>
/// <para>
/// <b>Redaction happens here too, and deliberately so.</b> Both publication paths need both
/// rules, and a type that produced publishable bytes while leaving one of them to the caller
/// would be a type whose name was a claim it did not keep (§V).
/// </para>
/// </remarks>
internal static partial class ArtifactBudget
{
    /// <summary>The largest artifact this tool will publish — the engine reader's own budget.</summary>
    public static int Bytes => ArtifactBaseline.DefaultMaxBytes;

    /// <summary>Redacts, serializes, and budgets an artifact on its way to disk.</summary>
    /// <param name="result">The artifact the run produced.</param>
    /// <returns>The bytes to write, as text.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="result"/> is null.</exception>
    /// <exception cref="EvalCliException">The artifact is larger than the reader will accept.</exception>
    public static string Publishable(SuiteResult result) => Publishable(result, Bytes);

    /// <summary>Redacts, serializes, and budgets an artifact against a stated ceiling.</summary>
    /// <param name="result">The artifact the run produced.</param>
    /// <param name="maxBytes">
    /// The ceiling to hold it to, in UTF-8 bytes. May be lowered for a test; may never be raised
    /// above <see cref="Bytes"/>.
    /// </param>
    /// <returns>The bytes to write, as text.</returns>
    /// <remarks>
    /// <para>
    /// The ceiling is a parameter so the boundary can be exercised at a size a test can produce.
    /// A guard that only fires sixteen mebibytes in is a guard nothing demonstrates, and this tool
    /// already holds that a protection nobody can exercise reads like protection that is not
    /// there.
    /// </para>
    /// <para>
    /// <b>It is bounded above, because a seam that can be widened is not a barrier.</b> Redaction
    /// is private to this type precisely so publishable bytes cannot be obtained around the
    /// budget; a ceiling any caller could raise to <see cref="int.MaxValue"/> would be the same
    /// door with a different handle. Refused rather than clamped: a caller asking for a ceiling
    /// this cannot honour has misunderstood what the number is, and silently substituting a
    /// different one would answer a question they did not ask.
    /// </para>
    /// </remarks>
    /// <exception cref="ArgumentNullException"><paramref name="result"/> is null.</exception>
    /// <exception cref="ArgumentOutOfRangeException">
    /// <paramref name="maxBytes"/> is less than one, or above <see cref="Bytes"/>.
    /// </exception>
    /// <exception cref="EvalCliException">The artifact is one the reader would refuse.</exception>
    public static string Publishable(SuiteResult result, int maxBytes)
    {
        ArgumentNullException.ThrowIfNull(result);
        ArgumentOutOfRangeException.ThrowIfLessThan(maxBytes, 1);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(maxBytes, Bytes);

        var text = CanonicalJson.Serialize(ArtifactRedaction.Redact(result));
        var size = Encoding.UTF8.GetByteCount(text);

        // Strictly greater, because the reader's own check is strictly greater: an artifact of
        // exactly the budget reads back. An off-by-one in the safe direction would refuse a file
        // the reader accepts, which is a different defect but still a completed run reported as a
        // failed one.
        if (size > maxBytes)
        {
            throw new EvalCliException(
                ExitCode.RunFailed,
                $"The suite was conducted, but the artifact it produced is {Number(size)} bytes and the artifact "
                    + $"reader refuses anything above {Number(maxBytes)}.",
                "Nothing was written, and nothing that was already there was replaced. Publishing it would have put "
                    + "a file on disk that every later comparison and every trend refuses to read, and reported that "
                    + "as a successful write. Narrow the suite, lower the repetition count, or shorten what the "
                    + "transcripts record, and re-run."
            );
        }

        RequireTheReaderWouldAcceptIt(text);

        return text;
    }

    /// <summary>
    /// Puts the serialized bytes through the reader's own acceptance before they are published.
    /// </summary>
    /// <param name="text">The serialized, redacted artifact.</param>
    /// <remarks>
    /// <para>
    /// <b>Size is not shape, and "published implies readable" has to hold for both.</b> The budget
    /// above answers whether the reader will open the file; this answers whether it will accept
    /// what is inside it — schema version, the nulls its shape forbids, and the identifiers it
    /// refuses to carry. Checking one and claiming both is the same class of defect as the gate
    /// that was accepted and never ran.
    /// </para>
    /// <para>
    /// <b>Through <see cref="CanonicalJson.DeserializeSuiteResult"/>, which <i>is</i> the reader's
    /// acceptance</b> — <see cref="ArtifactBaseline"/> calls exactly this after its own size
    /// check. Re-implementing the conditions here would be a second reading of a rule the engine
    /// owns, and the direction it would eventually disagree in is publishing something
    /// unreadable.
    /// </para>
    /// <para>
    /// <b>Nothing the engine withheld is repeated.</b> A refused identifier is named by field and
    /// position only; the value is what the refusal exists to keep out of the build log (§V, ADR
    /// 0005). Engine prose for the remaining categories is netted rather than forwarded, for the
    /// reason <c>SuiteDiscovery</c> nets it: those messages quote the artifact.
    /// </para>
    /// </remarks>
    /// <exception cref="EvalCliException">The reader would refuse the artifact.</exception>
    private static void RequireTheReaderWouldAcceptIt(string text)
    {
        try
        {
            _ = CanonicalJson.DeserializeSuiteResult(text);
        }
        catch (UnsafeIdentifierException refusal)
        {
            throw Unpublishable(
                $"its {Located(refusal)} is a path on somebody's machine",
                "Rename the identifier in the suite and re-run. The value itself is not repeated here because this "
                    + "message is written to the build log."
            );
        }
        catch (Exception refusal)
            when (refusal is JsonException or MalformedArtifactException or SchemaVersionException)
        {
            throw Unpublishable(
                $"the reader refuses its shape: {MarkdownReport.Sanitize(refusal.Message, MarkdownReport.MaxReasonCharacters)}",
                "This is a defect in how the artifact was assembled rather than anything the suite did. Report it "
                    + "with the suite that produced it."
            );
        }
    }

    /// <summary>The refusal shared by every way the reader would decline the bytes.</summary>
    private static EvalCliException Unpublishable(string because, string remedy) =>
        new(
            ExitCode.RunFailed,
            $"The suite was conducted, but the artifact it produced is not one the artifact reader accepts: {because}.",
            $"Nothing was written, and nothing that was already there was replaced. Publishing it would have put a "
                + $"file on disk that every later comparison and every trend refuses to read, and reported that as a "
                + $"successful write. {remedy}"
        );

    /// <summary>Names where a refused identifier sits, without naming the identifier.</summary>
    /// <remarks>
    /// The same form <c>SuiteDiscovery.Located</c> uses on the read side, because a reader meeting
    /// both messages is looking at one artifact and should not have to learn two vocabularies.
    /// </remarks>
    private static string Located(UnsafeIdentifierException refusal) =>
        (refusal.Field ?? "identifier")
        + (refusal.Position is { } position ? $" at scenario {position}" : string.Empty);

    /// <summary>A byte count, grouped, in the invariant culture this tool's messages are written in.</summary>
    private static string Number(int value) => value.ToString("N0", CultureInfo.InvariantCulture);
}
