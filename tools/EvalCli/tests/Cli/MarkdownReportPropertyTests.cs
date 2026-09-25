using System.Globalization;
using System.Text.RegularExpressions;
using FluentAssertions;
using Forge.EvalCli.Cli;
using Forge.EvalCli.Tests.Support;
using Forge.EvalEngine.Comparison;
using Forge.EvalEngine.Results;
using Forge.EvalEngine.Statistics;

namespace Forge.EvalCli.Tests.Cli;

/// <summary>
/// The three properties the renderer has to hold, tested as properties rather than as instances.
/// </summary>
/// <remarks>
/// Each of these covers a fix that previously reintroduced, at a smaller scale, the defect it was
/// written to remove. Aiming at the instance is what produced that; these aim at the rule:
/// <list type="bullet">
/// <item><description>
/// <b>The marker is injective over its inputs.</b> Not "unclipped and unredacted" — no two
/// distinct pairs of inputs may produce one digest, whatever the transformation in between.
/// </description></item>
/// <item><description>
/// <b>The consistency check covers every figure rendered as evidence.</b> Not "the ones the check
/// was written for" — a reader weighs the interval as heavily as the rate it brackets.
/// </description></item>
/// <item><description>
/// <b>A count of tested scenarios comes from an explicit verdict.</b> Not "not equal to a
/// sentinel" — a null lifted into a nullable comparison is not a verdict.
/// </description></item>
/// </list>
/// </remarks>
public class MarkdownReportPropertyTests
{
    private const string Root = "/repo";

    /// <summary>What a redacted path renders as, so a test can assert on its presence or absence.</summary>
    private const string RedactedPrefix = "[path-redacted:";

    private static MarkdownReportRequest Request(ComparisonOutcome comparison, int? budget = null) =>
        new()
        {
            Comparison = comparison,
            RootDirectory = Root,
            SuitePath = "/repo/eval-suites/regression.json",
            ArtifactPath = "/repo/artifacts/candidate.json",
            GateMode = RunPlan.ReportOnlyGate,
            CharacterBudget = budget ?? MarkdownReport.CommentCharacterLimit,
        };

    // ---- P1: the marker is injective over its inputs -----------------------------------------

    [Fact]
    public void ForSegments_WhenASegmentContainsASeparator_DoesNotMatchTwoSegments()
    {
        // On Linux `a\b.json` is one file whose name contains a backslash, and `a/b.json` is
        // `b.json` inside `a`. Normalising every backslash to a slash inside the hash input maps
        // both to the same string, so two distinct suites share a marker and one pull-request
        // report replaces the other. Tested on the encoder so the property holds on every
        // platform, not only on the one the tests happen to run on.
        var single = ReportIdentity.ForSegments([@"a\b.json"]);
        var nested = ReportIdentity.ForSegments(["a", "b.json"]);

        single.Should().NotBe(nested);
    }

    [Fact]
    public void ForSegments_WhenASegmentContainsTheJoiningCharacter_DoesNotMatchTwoSegments()
    {
        ReportIdentity.ForSegments(["a/b.json"]).Should().NotBe(ReportIdentity.ForSegments(["a", "b.json"]));
    }

    [Fact]
    public void RequireDistinctAliases_WhenTwoPathsShareAnAlias_Refuses()
    {
        // Narrowed so the branch is reachable: at the real sixteen digits no test can construct a
        // collision, and a guard nothing can exercise reads like protection that is not there.
        // The logic under test does not depend on the width.
        var paths = Enumerable.Range(0, 64).Select(index => $"/home/user{index}/repo").ToArray();

        var refuse = () => MarkdownReport.RequireDistinctAliases(paths, hexLength: 1);

        refuse.Should().Throw<InvalidOperationException>().WithMessage("*redact to the same alias*");
    }

    [Fact]
    public void RequireDistinctAliases_WhenTheSamePathAppearsTwice_Accepts()
    {
        // One path named twice is one alias, which is correct rather than a collision.
        var accept = () =>
            MarkdownReport.RequireDistinctAliases(["a /home/user/repo", "b /home/user/repo"], hexLength: 1);

        accept.Should().NotThrow();
    }

    [Fact]
    public void AliasedValues_WhenACoverageClaimHasNoComparison_CarriesItIntoTheAliasCheck()
    {
        var outcome = Orphaned(
            [.. Enumerable.Range(0, 32).Select(index => $"/home/covered{index}/repo")],
            [.. Enumerable.Range(0, 32).Select(index => $"/home/withheld{index}/repo")]
        );

        var refuse = () => MarkdownReport.RequireDistinctAliases(MarkdownReport.AliasedValues(outcome), hexLength: 1);

        // The claim lists were not in the set the collision guard checked, so an orphan id — one
        // that appears in the document only under "Coverage claims with no comparison", because
        // no comparison entry names it — could render as another value's alias with nothing
        // refusing it. Two scenarios collapsing into one string is the disappearance the alias
        // exists to prevent, and an orphan is already the entry a reader is least able to
        // cross-check.
        refuse.Should().Throw<InvalidOperationException>().WithMessage("*redact to the same alias*");
    }

    [Fact]
    public void Render_WhenTwoOrphanCoverageClaimsCarryMachinePaths_RendersThemAsDistinctAliases()
    {
        var text = MarkdownReport.Render(Request(Orphaned(["/home/one/repo"], ["/home/two/repo"]))).Text;

        var section = text[text.IndexOf("### Coverage claims with no comparison", StringComparison.Ordinal)..];

        // Through the renderer, not only through the guard: both claims reach the page, neither
        // carries the path, and the two do not read as the same scenario.
        section.Should().NotContain("/home/one").And.NotContain("/home/two");

        Regex
            .Matches(section, @"\[path-redacted:[0-9a-f]+\]")
            .Select(match => match.Value)
            .Distinct(StringComparer.Ordinal)
            .Should()
            .HaveCount(2);
    }

    /// <summary>A comparison whose only coverage claims name scenarios it carries no entry for.</summary>
    private static ComparisonOutcome Orphaned(string[] covered, string[] withheld) =>
        ReportFixture.Outcome(
            new ComparisonResult
            {
                SuiteName = "regression",
                ScenarioComparisons = [],
                NewlyCovered = covered,
                NewlyCoveredWithheld = withheld,
            },
            ReportFixture.Artifact(),
            ReportFixture.Artifact()
        );

    [Fact]
    public void Render_WhenAMachinePathHasADoubledLeadingSlash_StillRedactsIt()
    {
        // The first slash cannot begin the Unix alternative and the second is blocked by the
        // lookbehind, so the whole path printed verbatim. `//` is ordinary in a shell-built path.
        Named("checkout //home/ci-user/repo").Should().NotContain("/home/ci-user");
    }

    [Fact]
    public void Render_WhenAMachinePathContainsASpace_DoesNotLeaveItsRemainderVisible()
    {
        // Stopping at the first space redacted `/home/john` and left ` smith/repo` on the page —
        // half an account name, which is most of what the redaction existed to prevent.
        var text = Named("checkout /home/john smith/repo");

        text.Should().NotContain("/home/john").And.NotContain("smith");
    }

    [Fact]
    public void Render_WhenSeveralPathsAreRedacted_GivesEachADistinctAlias()
    {
        var text = Named("a /home/one/x b /home/two/y c /home/three/z");

        var aliases = Regex
            .Matches(text, @"\[path-redacted:[0-9a-f]+\]")
            .Select(match => match.Value)
            .Distinct(StringComparer.Ordinal)
            .ToArray();

        // One value per distinct path. Two originals sharing an alias would make two scenarios
        // indistinguishable, which is what the alias exists to prevent.
        aliases.Should().HaveCount(1, "the whole remainder is treated as one path");
        Named("/home/one/x").Should().NotBe(Named("/home/two/y"));
    }

    [Fact]
    public void Render_WhenAnIntervalMismatchIsReported_DoesNotPrintRecomputedBounds()
    {
        var text = Rendered(ReportFixture.ForgedInterval("checkout"));

        // Derived here rather than written as a literal, so the assertion tracks the renderer's
        // own arithmetic instead of a number that was true on the day it was pasted in.
        var recomputed = ProportionInterval.Wilson(5, 5, ReportFixture.ConfidenceLevel);

        // The footer states that every interval shown is the figure the run recorded and that
        // none was computed here. Printing recomputed bounds on the mismatch path contradicts
        // that in the one place the data is known to be untrustworthy — and hands the reader a
        // figure the run never produced, which hides the edit that motivated the check.
        text.Should().Contain("does not match the runs beside it");
        text.Should().NotContain(Percent(recomputed.Lower), "the recomputed lower bound must not appear anywhere");

        // What the mismatch may name is the artifact's own recorded interval — the thing that is
        // wrong — so a reader can see which figure was edited.
        text.Should().Contain("an interval of 99%-100% that its own runs and settings do not produce");
    }

    /// <summary>Formats a proportion the way the report does, so an assertion can match it.</summary>
    private static string Percent(double value) => (value * 100).ToString("0.#", CultureInfo.InvariantCulture) + "%";

    [Fact]
    public void List_WhenTheCallersCollectionChangesAfterwards_KeepsItsCountAndItsEntriesTogether()
    {
        var entries = new List<string>();
        var section = MarkdownSection.List("Regressions", "lead", "empty", entries, always: true);

        entries.Add("- `checkout`");

        // Storing the caller's reference while snapshotting the count gave a heading of zero over
        // one entry, without touching ComparisonAnalysis at all. A count derived from a snapshot
        // cannot drift from the thing it counts.
        section.Count.Should().Be(section.Entries.Count);
        section.Entries.Should().BeEmpty();
    }

    [Fact]
    public void Aggregate_WhenBuilt_StatesTheSameFigureInItsHeadingAndItsProse()
    {
        var section = MarkdownSection.Aggregate("Unchanged", 3, total => $"{total} scenario(s) were unchanged.");

        section.Count.Should().Be(3);
        section.Lead.Should().Contain("3 scenario(s)");
    }

    [Fact]
    public void ForSegments_WhenThereAreNoSegments_DoesNotMatchOneEmptySegment()
    {
        ReportIdentity.ForSegments([]).Should().NotBe(ReportIdentity.ForSegments([""]));
    }

    [Fact]
    public void ForPath_WhenThePathLeavesTheRoot_DoesNotMatchTheSameSegmentsInsideIt()
    {
        // Falling back to the whole path drops its leading separator once it is split, so
        // `/elsewhere/a` and `/repo/elsewhere/a` reduce to the same segments.
        var outside = ReportIdentity.ForPath("/repo", "/elsewhere/a.json");
        var inside = ReportIdentity.ForPath("/repo", "/repo/elsewhere/a.json");

        outside.Should().NotBe(inside);
    }

    [Fact]
    public void ForPath_WhenOnlySlashSeparates_TreatsABackslashAsPartOfAName()
    {
        // The Linux case, reached without Linux. There `a\b.json` is one file and `a/b.json` is
        // two, so any normalisation applied before the split merges them — the same collision the
        // encoding prevents, moved one step earlier and out of its reach. Relative paths, because
        // `Path.GetRelativePath` is itself platform-dependent and would normalise both on Windows
        // before this code ever saw them.
        var single = ReportIdentity.ForPath("/repo", @"a\b.json", ['/']);
        var nested = ReportIdentity.ForPath("/repo", "a/b.json", ['/']);

        single.Should().NotBe(nested);
    }

    [Fact]
    public void MarkerFor_WhenTheInputsCouldBeSplitTwoWays_DoesNotAliasThem()
    {
        // Encoded identities contain the joining character, so concatenating them with any
        // separator makes ("a/b", "c") and ("a", "b/c") one byte sequence. Both are reachable —
        // a suite one directory deeper, a baseline one shallower — and the consequence is two
        // reports sharing a comment slot. Length prefixes need no separator to be safe against.
        var first = MarkdownReport.MarkerFor(ReportIdentity.ForSegments(["a", "b"]), ReportIdentity.ForSegments(["c"]));

        var second = MarkdownReport.MarkerFor(
            ReportIdentity.ForSegments(["a"]),
            ReportIdentity.ForSegments(["b", "c"])
        );

        first.Should().NotBe(second);
    }

    // ---- P2: the check covers every figure rendered as evidence -------------------------------

    [Fact]
    public void Render_WhenOnlyTheIntervalWasEdited_WithholdsTheFiguresRatherThanPrintingIt()
    {
        var text = Rendered(ReportFixture.ForgedInterval("checkout"));

        // `n` and the point estimate both agree with the runs; only the bounds were edited. A
        // check aimed at the two fields it was written for leaves the most persuasive figure on
        // the page unverified. The discrepancy names the forged bounds — what it must not do is
        // present them as a result.
        text.Should().Contain("does not match the runs beside it");
        text.Should().Contain("an interval of 99%-100% that its own runs and settings do not produce");
        text.Should().NotContain("Wilson CI 99%-100%");
    }

    [Fact]
    public void Render_WhenTheIntervalMethodIsNotTheOneTheRunRecorded_WithholdsTheFigures()
    {
        var text = Rendered(ReportFixture.ForeignIntervalMethod("checkout"));

        // The method is part of what the bounds mean. An artifact whose interval was computed one
        // way while its settings record another is two accounts of the same run, and the reader
        // is shown the one nobody checked.
        text.Should().Contain("does not match the runs beside it").And.Contain("Agresti-Coull");
    }

    [Fact]
    public void Render_WhenTheIntervalWasRemovedFromARunThatComputedOne_WithholdsTheFigures()
    {
        var text = Rendered(ReportFixture.WithoutInterval("checkout"));

        // The artifact records the method and the confidence level it computed intervals at, so a
        // summary with none contradicts its own harness settings. Printing the rate alone would
        // let a tamperer suppress a wide interval by deleting it.
        text.Should().Contain("does not match the runs beside it");
    }

    [Fact]
    public void Render_WhenTheConfidenceLevelWasNotRecorded_DoesNotPresentTheIntervalAsVerified()
    {
        var baseline = ReportFixture.Artifact(
            recordsConfidence: false,
            ReportFixture.Scenario("checkout", passed: 5, graded: 5)
        );

        var candidate = ReportFixture.Artifact(
            recordsConfidence: false,
            ReportFixture.Scenario("checkout", passed: 0, graded: 5)
        );

        var text = MarkdownReport.Render(Request(Outcome(baseline, candidate))).Text;

        // Without the level the bounds cannot be checked against anything, so they are not shown
        // as though they had been.
        text.Should().Contain("could not be verified").And.NotContain("Wilson CI");
    }

    // ---- P3: the tested count comes from an explicit verdict ----------------------------------

    [Fact]
    public void Render_WhenEveryCoveredScenarioIsNew_ReportsThemAsUntestedRatherThanAsTested()
    {
        var baseline = ReportFixture.Artifact();
        var candidate = ReportFixture.Artifact(ReportFixture.Scenario("brandnew", passed: 5, graded: 5));

        var outcome = ReportFixture.Outcome(
            new ComparisonResult
            {
                SuiteName = "regression",
                ScenarioComparisons =
                [
                    ReportFixture.Compared(
                        "brandnew",
                        ScenarioClassification.New,
                        ScenarioOutcome.Absent,
                        ScenarioOutcome.Passed
                    ),
                ],
                NewlyCovered = ["brandnew"],
                Correction = "benjamini-hochberg",
            },
            baseline,
            candidate
        );

        var text = MarkdownReport.Render(Request(outcome)).Text;

        // A new scenario has no counterpart to pair against, so no test was run. Reading a null
        // comparison through a nullable `!= NotComputed` counts it as tested and reports
        // "1 tested and not judged significant" about a test that never happened — the defect
        // class inside the fix for the defect class.
        text.Should().Contain("1 carried no test at all");
        text.Should().NotContain("1 were tested and not judged significant");
    }

    // ---- The redaction boundary, in both directions -------------------------------------------

    [Theory]
    [InlineData("/home/ci-user/repo")]
    [InlineData("checkout /home/ci-user/repo")]
    [InlineData("checkout '/home/ci-user/repo' done")]
    [InlineData("checkout //home/ci-user/repo")]
    [InlineData("/Users/someone/work")]
    [InlineData("/var/lib/agent/state")]
    [InlineData("/tmp/build-4213/out")]
    [InlineData(@"C:\Users\someone\work")]
    [InlineData("D:/build/agent/_work")]
    [InlineData(@"\\build-host\share\repo")]
    public void Render_WhenAnIdentifierCarriesAnUnmistakableMachinePath_StillRedactsIt(string id)
    {
        // What the net keeps: a rooted path under a directory that names a machine rather than a
        // resource, a drive letter with a separator, and a UNC host. These are the shapes nobody
        // writes as an identifier on purpose.
        Named(id).Should().Contain(RedactedPrefix);
    }

    [Theory]
    [InlineData("https:///home/ci-user/repo")]
    [InlineData("path:///home/ci-user/repo")]
    [InlineData("file://home/ci-user/repo")]
    [InlineData("file:///home/ci-user/repo")]
    [InlineData("foo-https://home/ci-user/repo")]
    [InlineData("checkout path:/home/ci-user/repo")]
    public void Render_WhenAColonDoesNotOpenAnAbsoluteUrl_ReadsWhatFollowsItAsAPath(string id)
    {
        // The authority rule, from the refusing side. A colon waives the path check only when
        // what surrounds it is an absolute URL — a recognised scheme, `//`, and a **non-empty**
        // authority. Everything else a colon can be is a label:
        //
        //   https:///…  recognised scheme, but three slashes and no host at all
        //   path:///…   the same, with a scheme nobody recognises
        //   file://…    an absolute URL whose authority *is* a machine path — the thing being
        //               refused, not admitted, which is why `file` is not in the scheme set
        //   foo-https:  the scheme is the whole run of scheme characters before the colon, so
        //               this is `foo-https` and not `https`
        //
        // Every one of these was a hole while the rule was written as "skip a colon"; each is
        // closed by stating what the colon has to *be* instead.
        Named(id).Should().Contain(RedactedPrefix);
    }

    [Theory]
    [InlineData("https://home/dashboard")]
    [InlineData("http://home/dashboard")]
    [InlineData("HTTPS://home/dashboard")]
    [InlineData("ws://home/events")]
    [InlineData("wss://home/events")]
    [InlineData("checkout https://home/dashboard")]
    public void Render_WhenAColonOpensAnAbsoluteUrl_RendersTheAuthorityVerbatim(string id)
    {
        // The authority rule, from the admitting side: an authority is allowed to be spelled the
        // same as a system root. The scheme is matched case-insensitively per RFC 3986 §3.1 —
        // which is deliberately *not* how the engine matches a request method, because RFC 9110
        // §9.1 defines that one as case-sensitive. Two specifications, not two conventions.
        var text = Named(id);

        text.Should().Contain(id);
        text.Should().NotContain(RedactedPrefix);
    }

    [Theory]
    [InlineData("/api/v1/refund")]
    [InlineData("/orders/{id}/refund")]
    [InlineData("GET /orders/{id}/refund")]
    [InlineData("/users/42")]
    [InlineData("/media/upload")]
    [InlineData("/workspace/42")]
    [InlineData("/home")]
    [InlineData("/home/")]
    [InlineData("https://example.com/home/dashboard")]
    [InlineData("https://host/a//home/x")]
    [InlineData("https://host/a/b")]
    [InlineData("X:12")]
    public void Render_WhenAnIdentifierIsRouteShaped_RendersItVerbatim(string id)
    {
        // The live legibility bug. A shape rule cannot tell `/home/ci-user/repo` from
        // `/orders/{id}/refund` — both are a rooted path of two or more segments — so the old
        // pattern reduced every route an author wrote to an alias. An identifier destroyed on
        // every push is a worse failure than the disclosure it was guessing at, and the engine
        // now refuses the disclosure at authoring time.
        var text = Named(id);

        text.Should().Contain(id);
        text.Should().NotContain(RedactedPrefix);
    }

    [Fact]
    public void Render_WhenAPathLiesUnderARootTheNetDoesNotList_RendersItVerbatim()
    {
        // Deliberately admitted, and the inverse of what this test asserted before the engine's
        // guard landed. `/workspace/…` and `/media/…` are ordinary REST collections before they
        // are directories, and a net that redacts them is back to guessing at free text — the
        // failure mode that cost five rounds. The control is the engine's suite-load refusal;
        // this is the net, and a net has holes by construction. State them rather than pretend.
        var text = Named("checkout /workspace/ci-user/repo");

        text.Should().Contain("/workspace/ci-user/repo");
        text.Should().NotContain(RedactedPrefix);
    }

    [Fact]
    public void Render_WhenTwoDifferentPathsAreRedacted_GivesThemDistinctStableAliases()
    {
        var first = Named("/home/v1/refund");
        var second = Named("/home/v1/checkout");

        // Collapsing both to one marker makes two scenarios indistinguishable in the report,
        // which is the disappearance the document exists to prevent. The alias has to be stable
        // across runs and distinct between values.
        Alias(first).Should().NotBe(Alias(second));
        Alias(first).Should().Be(Alias(Named("/home/v1/refund")));
    }

    // ---- The reservation has to be an upper bound ---------------------------------------------

    [Fact]
    public void Render_AtTheBudgetsWhereTheShownCountGrowsADigit_FitsWithoutOverrunning()
    {
        var outcome = Crowded(60);

        // `Notice(total, total)` is not the widest notice: it renders the omitted count as zero,
        // while the widest carries the full digit count in both slots. The under-reservation only
        // bites once the *shown* count grows a digit, so the budgets either side of that
        // transition are the ones worth testing — a sweep that stopped a few characters above the
        // frame never reached it.
        foreach (var target in (int[])[9, 10, 11])
        {
            var boundary = SmallestBudgetShowing(outcome, target);

            for (var budget = boundary - 3; budget <= boundary + 3; budget++)
            {
                var render = () => MarkdownReport.Render(Request(outcome, budget));

                render.Should().NotThrow($"budget {budget} was accepted by the renderer");
                MarkdownReport.Render(Request(outcome, budget)).Text.Length.Should().BeLessThanOrEqualTo(budget);
            }
        }
    }

    /// <summary>The smallest budget at which the regressions section shows at least so many entries.</summary>
    private static int SmallestBudgetShowing(ComparisonOutcome outcome, int target)
    {
        var low = SmallestAcceptedBudget(outcome);
        var high = low + 40_000;

        while (low < high)
        {
            var middle = low + ((high - low) / 2);

            if (Shown(outcome, middle) >= target)
            {
                high = middle;
            }
            else
            {
                low = middle + 1;
            }
        }

        Shown(outcome, low).Should().BeGreaterThanOrEqualTo(target, "the search must find such a budget");

        return low;
    }

    private static int Shown(ComparisonOutcome outcome, int budget) =>
        MarkdownReport.Render(Request(outcome, budget)).Sections.First(s => s.Section == "Regressions").Shown;

    private static int SmallestAcceptedBudget(ComparisonOutcome outcome)
    {
        for (var budget = MarkdownReport.MinimumCharacterBudget; budget < 60_000; budget++)
        {
            try
            {
                _ = MarkdownReport.Render(Request(outcome, budget));

                return budget;
            }
            catch (ArgumentOutOfRangeException)
            {
                // Still below the frame. Keep climbing.
            }
        }

        throw new InvalidOperationException("no budget below 60,000 characters was accepted.");
    }

    private static string Rendered(ScenarioResult baselineScenario)
    {
        var baseline = ReportFixture.Artifact(baselineScenario);
        var candidate = ReportFixture.Artifact(ReportFixture.Scenario("checkout", passed: 0, graded: 5));

        return MarkdownReport.Render(Request(Outcome(baseline, candidate))).Text;
    }

    private static ComparisonOutcome Outcome(SuiteResult baseline, SuiteResult candidate) =>
        ReportFixture.Outcome(
            new ComparisonResult
            {
                SuiteName = "regression",
                ScenarioComparisons =
                [
                    ReportFixture.Compared(
                        "checkout",
                        ScenarioClassification.Regressed,
                        ScenarioOutcome.Passed,
                        ScenarioOutcome.Failed,
                        gradedPairs: 5,
                        effect: -1.0
                    ),
                ],
            },
            baseline,
            candidate
        );

    /// <summary>Renders a comparison whose single scenario carries the given identifier.</summary>
    private static string Named(string id)
    {
        var outcome = ReportFixture.Outcome(
            new ComparisonResult
            {
                SuiteName = "regression",
                ScenarioComparisons =
                [
                    ReportFixture.Compared(
                        id,
                        ScenarioClassification.New,
                        ScenarioOutcome.Absent,
                        ScenarioOutcome.Failed
                    ),
                ],
            },
            ReportFixture.Artifact(),
            ReportFixture.Artifact(ReportFixture.Scenario(id, passed: 0, graded: 1))
        );

        return MarkdownReport.Render(Request(outcome)).Text;
    }

    /// <summary>The redaction alias a rendering carries, so two of them can be compared.</summary>
    private static string Alias(string text)
    {
        var start = text.IndexOf("[path-redacted:", StringComparison.Ordinal);

        start.Should().BeGreaterThanOrEqualTo(0, "the path should have been redacted");

        return text[start..(text.IndexOf(']', start) + 1)];
    }

    private static ComparisonOutcome Crowded(int count)
    {
        var comparisons = new List<ScenarioComparison>();
        var baseline = new List<ScenarioResult>();
        var candidate = new List<ScenarioResult>();

        for (var index = 0; index < count; index++)
        {
            var id = $"regressed-{index:D3}";

            comparisons.Add(
                ReportFixture.Compared(
                    id,
                    ScenarioClassification.Regressed,
                    ScenarioOutcome.Passed,
                    ScenarioOutcome.Failed,
                    gradedPairs: 5,
                    effect: -1.0,
                    pValue: 0.0312,
                    adjusted: 0.0625
                )
            );

            baseline.Add(ReportFixture.Scenario(id, passed: 5, graded: 5));
            candidate.Add(ReportFixture.Scenario(id, passed: 0, graded: 5));
        }

        return ReportFixture.Outcome(
            new ComparisonResult
            {
                SuiteName = "regression",
                ScenarioComparisons = comparisons,
                Correction = "benjamini-hochberg",
            },
            ReportFixture.Artifact([.. baseline]),
            ReportFixture.Artifact([.. candidate])
        );
    }
}
