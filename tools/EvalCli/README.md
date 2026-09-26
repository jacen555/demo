# EvalCli

> **Kind:** `tool` · **Tier:** 2 · **Registry id:** `eval-cli`

## What this is

The command-line front end for [`libs/EvalEngine`](../../libs/EvalEngine) (`eval-engine`). It
runs an evaluation suite against a system under test, compares the result against a committed
baseline, and reports what changed — the evidence you attach to a pull request to show whether a
change made things better or worse.

Today it **runs a suite and compares it against a baseline**: it loads and validates the suite file,
works out which scenarios a change actually impacts, conducts them, writes the artifact, diffs the
result against a baseline, and reports what changed — leading with **what the change fixed**. It
wires every seam the engine leaves open — clock, seed source, runners, participant factory,
assertion registry, significance test, baseline providers, logger — and `--dry-run` still prints
exactly what a run *would* do without executing anything. The gate that turns a regression into a
non-zero exit arrives next; this build reports.

## What it was built to learn or do

The engine is deliberately unopinionated: it ships no HTTP adapter, no LLM provider, no logger, and
no participant factory, because each of those is a property of the system being evaluated or of the
environment the harness runs in. That makes the composition root the interesting part, and this is
it — the one place where those decisions are made and can be read together.

It is also an exercise in a tool that **cannot report a green over a red**. A harness whose CI step
passes while the run underneath it failed is worse than no harness, so the exit code is treated as
the primary output and the tests pin it directly.

## How to run

**Start with a dry run. It executes nothing and writes nothing.**

```powershell
dotnet run --project tools/EvalCli/src -- run --suite eval-suites/regression.json --root . --dry-run
```

```
Planned run - dry run, nothing was executed.

  suite             C:\repo\eval-suites\regression.json
  root              C:\repo
  baseline          (none)
  artifact          (none) - no --out, so nothing would be written
  report markdown   (none) - no --report-markdown, so no pull-request report would be written
  overwrite         refused - an existing file at --out or --report-markdown would stop the run
  root seed         0
  max concurrency   1
  max total runs    100000
  endpoint          (none)
  comparison        none - no --baseline and no --baseline-endpoint, so nothing would be compared. That is not the same as nothing having regressed
  selection         full suite - no --changed-since, so nothing is skipped
  gate              report-only - regressions are reported, not enforced

  runners
    rest              -  no runner registered - needs an IRestExchange, which is a property of the system under test
    mcp               NotImplementedMcpRunner  the engine's stub - it records the gap as a harness failure rather than a pass
    llm               -  no runner registered - needs an IConversationExchange, which is a property of the system under test
    ui                NotImplementedUiRunner  the engine's stub - it records the gap as a harness failure rather than a pass

  clock             SystemClock
  participants      DeterministicParticipantFactory - a fresh participant per run
  assertions        baseline, exactMatch, expectedBehavior, presence, structural
  significance      McNemar, corrected with benjamini-hochberg
  diagnostics       stderr; results on stdout

Nothing was executed and nothing was written.
```

Then run it for real. `--rest-exchange json` is what wires a transport; without it nothing conducts
a REST scenario and the run reports that rather than passing:

```powershell
dotnet run --project tools/EvalCli/src -- run --suite eval-suites/regression.json --root . `
    --endpoint http://localhost:8787/evaluate --rest-exchange json --out artifacts/baseline.json
```

```
Run complete - 2 of 2 scenarios ran.

  suite             checkout-regression
  root              C:\repo
  endpoint          http://localhost:8787/<redacted>
  artifact          C:\repo\artifacts\baseline.json
  gate              report-only - regressions are reported, not enforced

  selection
    changed files       no --changed-since revision was given, so no changed-file set was acquired and the whole suite was selected. Pass --changed-since <rev> to narrow the run to what a change actually touched.
    why the full suite  No changed files were supplied, so there is nothing to map scenarios against. An empty set is not evidence that nothing changed.

    fallback            2
    glob-match          0
    no-globs-declared   0
    previously-failing  0
    new                 0
    skipped             0

  runs
    pass                2
    fail                0
    error               0
    expected-failure    0

Every selected scenario was conducted.
```

Narrow the run to what a change actually touched, against a baseline that says which scenarios
there is evidence to skip:

```powershell
dotnet run --project tools/EvalCli/src -- run --suite eval-suites/regression.json --root . `
    --endpoint http://localhost:8787/evaluate --rest-exchange json `
    --changed-since HEAD --baseline artifacts/baseline.json --verbose
```

```
Run complete - 1 of 2 scenarios ran.
...
  selection
    changed files       1 from `git -C C:\repo --no-pager diff -z --name-only --no-renames --end-of-options HEAD -- + git -C C:\repo ls-files -z --others --exclude-standard --full-name --`

    fallback            0
    glob-match          1
    no-globs-declared   0
    previously-failing  0
    new                 0
    skipped             1

  scenarios
    checkout-happy-path         glob-match - changed file 'src/Checkout.cs' matched impact glob 'src/**'

  comparison
    baseline            artifact C:\repo\artifacts\baseline.json
    newly covered       1 - checkout-happy-path
    regressed           0

    not-comparable      0
    stable-pass         0
    stable-fail         0
    fixed               1
    regressed           0
    new                 0
    removed             0
    not compared        1 - billing-invoice - skipped by selection, so this run produced no candidate evidence about them. They are not unchanged and they were not removed
    gate                report-only - the comparison is reported, not enforced
```

Machine-readable, for a CI step:

```powershell
dotnet run --project tools/EvalCli/src -- run --suite eval-suites/regression.json --root . --dry-run --json
```

Full help, which leads with the safe path and ends with the exit-code table:

```powershell
dotnet run --project tools/EvalCli/src -- --help
```

How the suite has moved across a directory of past runs. It reads the directory, writes nothing
into it, and prints the report unless `--report-markdown` names a file:

```powershell
dotnet run --project tools/EvalCli/src -- trend --artifacts artifacts/nightly --root .
```

See [the trend report](#the-trend-report) for what it refuses and why.

## Comparing against a baseline

**`newlyCovered` is the headline, not a byproduct.** A harness that reported only what broke would
be a worse version of a test suite; the reason to run a suite against two variants is to show what
a change *fixed*. It leads the report, and it is the first field of the JSON `comparison` object.

There are two mechanisms, and **one comparator serves both** — it diffs two `SuiteResult`s and
neither knows nor cares where they came from:

| Mechanism | Flag | What it is |
|---|---|---|
| Committed artifact | `--baseline <path>` | A `SuiteResult` JSON in the repository. Read only; never modified by `run`. |
| Live endpoint | `--baseline-endpoint <url>` | The version already deployed. The suite is conducted against it, and that run is the baseline. |

Passing both is refused: two baselines and no rule for choosing between them is how a tool ends up
comparing against whichever one the code happened to reach first.

### What gets refused, and why that matters more than what gets reported

The engine already refuses a mismatched definition fingerprint, a differing harness config, a
differing root seed, and a foreign-suite baseline. **None of that helps if the wrong two artifacts
are put beside each other in the first place** — nothing it checks would disagree. So the pairing
is decided before anything runs:

- **`--endpoint` and `--baseline-endpoint` may not name the same address.** A suite compared
  against itself reports that nothing changed whatever the change did. The comparison is on
  scheme, host, port, and path — everything that identifies a system and survives redaction. Two
  addresses differing *only* by query string are not treated as distinct, for the reason below.
- **No destination may be one of this invocation's own inputs.** `--out` and `--report-markdown`
  are each held against `--suite` and against `--baseline`, and **`--overwrite` does not lift it**:
  that opt-in is about replacing a file you chose, not about destroying one the same command reads.
  Writing a run over the baseline it was compared against is a baseline update, and that has its
  own command and its own opt-in. Writing either over the suite would destroy the definitions the
  run was conducted from, leaving nothing to re-read. The rule is enumerated over inputs × 
  destinations rather than written per pair, because the per-pair form is what left `--suite`
  unguarded while both baseline cells were covered — and it is **asked again immediately before
  each write**, because whether two paths are the same file is a property of the file system and a
  directory swapped for a link mid-run redirects a destination onto an input.
- **A scenario this run did not conduct is withheld from the baseline, not compared.** A narrowed
  run produces a candidate carrying only the selected scenarios; handing the comparator the whole
  baseline would classify every skipped scenario as `removed` — a confident claim about a change
  nobody made. They are reported under `notCompared` with the reason. A scenario the *suite* no
  longer declares is a different thing and really is reported as `removed`.
- **A pair that could not be compared is a refusal, not a clean result.** If *any* available pair
  comes back `not-comparable`, the run exits `4` rather than printing "0 regressed, 0 newly
  covered" for that scenario and exiting `0`. That output is indistinguishable from a change that
  broke nothing, and it is a green check over something nothing examined. **One refused pair among
  many is the same failure at a smaller scale, and the smaller scale is the dangerous one** — nine
  zeroes beside one real comparison still read as green. The refusal names every scenario it could
  not examine, why, and how many did compare. (`baseline update` deliberately does *not* refuse
  here: regenerating is what clears a stale fingerprint.)
- **A scenario the harness could not fully conduct is not counted as newly covered.** A scenario
  whose repetitions were part graded and part errored measures as passing — correctly, for what
  the graded evidence shows — but the suite asked more of it than it got an answer to. Those
  scenarios move to `newlyCoveredWithheld` rather than inflating the headline, **each carrying the
  cause the comparator attributed to it** — `incomplete`, `over-recorded`, or `errored` — and the
  sentence explaining it. The causes lead to different actions: a repetition that errored is a
  flake to re-run, a repetition that never happened is a harness that lost work, and an artifact
  recording more runs than its policy declared is neither.
- **A redirect is a request that never arrived.** Neither client follows one, and a `3xx` is
  recorded as a harness failure rather than graded. See [Safety](#safety).

### Two engine behaviours that look like bugs and are not

**1. A baseline predating `DefinitionFingerprint` compares as `not-comparable`.** That is correct.
The fingerprint covers a scenario's execution inputs *and* its grading expectations, and an
artifact that never recorded one cannot establish that both sides were run against the same thing
— absent is not the same as matching. The instruction is always to **regenerate** the baseline:

```powershell
dotnet run --project tools/EvalCli/src -- baseline update --suite eval-suites/regression.json `
    --root . --baseline artifacts/baseline.json `
    --endpoint http://localhost:8787/evaluate --rest-exchange json --apply
```

**Never edit a baseline by hand to make a comparison succeed.** The fingerprint is precisely what
stops a redefined scenario being reported as a fix the change earned; editing it defeats the guard
rather than satisfying it.

**2. A live baseline address carrying a query string or a fragment is refused.** Both are stripped
before an address is recorded, because that is where a bearer token or a SAS signature lives — so
`?deployment=old` and `?deployment=new` are the *same text* in the artifact, and the harness cannot
then tell whether the baseline it compared against was the one asked for. Rather than pair two
deployments it cannot distinguish, it refuses the reference. **Select the deployment by path, or
from the composition root with a header** — neither is redacted.

### A live baseline runs the whole suite

`--baseline-endpoint` gives the selector nothing to skip on. Only a committed artifact records a
prior trustworthy pass, so with a live baseline every scenario is selected as `new` and the whole
suite runs even when `--changed-since` narrows nothing away. That is deliberate: over-selecting
costs time, and the alternative is a scenario retired on evidence nobody has. It also means the
suite is conducted **twice**, once against each address — the dry run says so before you spend it.

## The pull-request report

`--report-markdown <path>` writes the comparison as a Markdown file for attaching to a pull
request — testing evidence in the same sense as a green integration-test run, except that **what
the change newly covered leads it**, because that is the thing a test suite on its own cannot show
you.

**This tool writes a file. CI posts it.** There is no GitHub API here, no token, and no network —
which keeps §V simple and keeps the harness usable outside GitHub.

```powershell
dotnet run --project tools/EvalCli/src -- run --suite eval-suites/regression.json --root . `
    --endpoint http://localhost:8787/evaluate --rest-exchange json `
    --baseline artifacts/baseline.json --out artifacts/candidate.json `
    --report-markdown artifacts/report.md
```

```markdown
<!-- eval-cli:report:ccf334d37370a05d -->
## Evaluation report — `checkout-regression`

> **Newly covered: 1 observed, 0 judged significant.** Regressions: 1 observed, 0 judged significant. Compared: 3 scenario(s). Not comparable: 0. Coverage claims withheld: 1. Unchanged: 1.

### Regressions (1)

Passed under the baseline and does not pass under this change. **An observed transition is not by itself a confirmed regression.** Of 1 here, 0 were judged significant against the run's significance level, 1 were tested and not judged significant, and 0 carried no test at all. Read the `n` and the adjusted p-value on each entry before acting.

- `checkout` — passed under the baseline and now records failed.
  - Pass rate: 100% (n=5, 95% Wilson CI 56.6%-100%) -> 0% (n=5, 95% Wilson CI 0%-43.4%)
  - Change: -100 points over 5 graded repetition pair(s). p=0.063, benjamini-hochberg adjusted p=0.063 — judged not significant against the run's significance level.
```

The sections run in severity order — **regressions, newly covered, not comparable, withheld from
coverage, new scenarios that did not pass, removed, unchanged, not run by this invocation** — while
the summary line leads with the coverage the change gained. Both orderings are deliberate: a
reviewer acts on the regression first and *reads* the report for what the change fixed.

### An observed transition is not a confirmed regression

A scenario that passed five times and now fails five times is **one observation of a change**, and
at the repetition counts an evaluation suite runs at the adjusted p-value frequently does not
support calling it real. So the qualification is in the summary and in the section lead, not only
in the per-entry detail: a reviewer who reads the first line and stops must not come away believing
a regression was confirmed. The same applies to a coverage claim.

### Every rate carries its `n` and its interval

`80% → 90%` on ten repetitions is noise presented as a result, so a pass rate is never printed
without the denominator it rests on and the confidence interval the run recorded:

- Two or more graded repetitions: `80% (n=5, 95% Wilson CI 37.6%-96.4%)`. The method and the
  confidence level are read out of the artifact's harness settings, never assumed — an artifact
  that recorded no level says `confidence level not recorded` rather than claiming 95%.
- **One graded repetition** — the ordinary case for a deterministic REST scenario — says
  `n=1 — a single observation, so no interval is reported: one run cannot bound a rate` instead of
  printing an interval spanning most of the unit interval as though it were a measurement.
- **No graded repetition at all** says `no pass rate`, which is a different claim from `0%`: one
  says the system failed, the other says nothing was ever learned about it.
- **A summary that disagrees with its own runs is refused, not printed and not recomputed.** A
  committed baseline is a file anyone can edit, so every figure rendered as evidence is checked
  against the runs beside it: the denominator, the point estimate, **and the interval** — its
  bounds recomputed from the runs, its method and its confidence level checked against the ones
  the run recorded. An interval that was edited, deleted, or computed by another method withholds
  the whole set of figures with the discrepancy named. The bounds shown are always the artifact's
  own; recomputation decides only whether they may be shown.
- **An artifact that recorded no interval settings has its bounds withheld rather than shown
  unverified.** The rate and its denominator were still checked, so those stand.

Every interval and p-value is the figure the engine computed. This report surfaces them and
calculates none of its own.

### The marker, so CI replaces one comment instead of spamming a thread

The first line is `<!-- eval-cli:report:<id> -->`. The id is a SHA-256 over **the complete suite
path relative to `--root` and the baseline's identity**, truncated to sixteen hex characters — so a
CI step can find its previous comment and replace it:

```powershell
$report = Get-Content artifacts/report.md -Raw
$marker = ($report -split "`n")[0]
$existing = gh pr view $PR --json comments --jq ".comments[] | select(.body | startswith(""$marker"")) | .id"
# ... update $existing if there is one, otherwise create
```

**The identity is a separate type from the display string**, and that is the point. `ReportIdentity`
can only be built from a root and a path, or from a `Uri` — there is no factory that takes the
redacted text, so wiring the wrong one is a compile error rather than a convention somebody has to
remember. Clipping a long path and redacting an address are presentation controls: feeding either
into the marker makes two distinct reports hash to one identity, and the second then silently
replaces the first — a §V control corrupting a §IV correctness property. For a live baseline the
identity is the *unredacted* scheme, host, port and path, which is the same notion of "a different
deployment" that `--baseline-endpoint` already refuses a self-comparison on. Neither value is ever
printed.

**The encoding is injective**, which is the property the marker actually needs — "unclipped and
unredacted" was only the instance. Each path segment is percent-encoded before the segments are
joined, so a Linux file genuinely named `a\b.json` cannot collide with `b.json` inside `a`; and the
two inputs are length-prefixed rather than delimited, so `("a/b", "c")` and `("a", "b/c")` stay
distinct. A lossy step *inside* the hash collides two inputs just as surely as one outside it.

What else is **in** and **out** is equally deliberate:

- **Out: everything the run found.** Counts, classifications, and scenario fingerprints all change
  as a pull request evolves — a marker derived from them would post a new comment on every push,
  which is the behaviour it exists to prevent.
- **Out: the containment root.** A build agent's checkout is somewhere else than a developer's, so
  an absolute path would make CI post a second comment rather than update the one already there.
  Separators are normalised for the same reason.
- **In: the baseline.** The same suite compared against trunk and against a release branch is two
  different claims, and a shared marker would have the second silently replace the first.

### Truncation is deterministic, and it says so

GitHub refuses a comment over **65,536 characters**, and the reports this was generalised from
reached 19 MB. So the document is fitted to the limit, and **never quietly**:

- The frame is paid for first — every heading, every standing explanation, the footer, and a
  worst-case omission notice per section. **A budget that cannot hold the frame is refused**, so
  "no section can be truncated out of existence" is a property of every report that renders rather
  than of the inputs that happened to be small enough. The real 65,536 always holds it.
- What remains is allocated as a **strict prefix in severity order**. The first entry that does not
  fit ends the allocation for the whole document rather than skipping ahead to a shorter one lower
  down, so the budget cannot end up spent on removals while a regression goes unnamed.
- A truncated section keeps its **true total** in the heading and states what it dropped:
  `145 of 300 shown — 155 omitted to fit the comment limit.` A section that could show nothing
  still renders, with the same notice. **A silently shortened list is a refusal rendering as an
  absence**, which is the failure this whole report is designed against.
- **The recovery pointer is truthful.** `--report-markdown` does not require `--out`, and where no
  JSON artifact was written the notice says so — *"There is no fuller record… Re-run with `--out`
  to keep them"* — rather than directing a reader to a file that does not exist.
- The same comparison and the same budget always produce byte-identical output.

### What it will not print

- **"No regressions" is not printable when nothing was compared.** The empty form of that section
  is chosen on the number of pairs actually diffed, not on the number that regressed — a zero
  drawn from nothing examined is not a finding, and the report says `Nothing was compared` instead.
- **`--report-markdown` without a baseline is refused at argument time** (exit `1`). Rendered with
  nothing to compare against, every heading would carry a zero, and a zero under "Regressions"
  reads as a finding rather than as an unexamined change.
- **No file is written when the comparison is refused.** The run exits `4` and says why on stderr.
  A Markdown file whose contents could only be the refusal would still be posted and read, and a
  reader who sees a comment stops looking for the failed step above it.
- **No absolute path reaches the document.** Every path is stated relative to `--root`. Separately,
  an *unmistakable machine path* appearing in a **suite name or scenario id** — free text the suite
  author controls — is replaced with `[path-redacted:<digest>]`, along with the remainder of that
  value: nothing in the text distinguishes a space inside a path from one after it, and a partial
  redaction leaving half an account name is worse than losing a trailing word. **The alias is a
  stand-in, not concealment**: the digest is unkeyed, so a guessable path is confirmable by anyone
  who tries. What it buys is that two different paths do not collapse into one indistinguishable
  string, and the renderer refuses outright if two ever share an alias.

  **This is a safety net, not the control, and it is deliberately narrow.** The control is
  `Forge.EvalEngine`, which refuses a machine path in an identifier at *suite load* and at
  *artifact read-back* — the layer that can tell the author to rename the value instead of the
  report mangling it on every push forever. This net catches what gets past that: an artifact
  written by an older build, and any gap that guard turns out to have.

  | | |
  |---|---|
  | **Redacted** | a path under `home`, `Users`, `root`, `var`, `tmp`, `mnt`, `opt`, or `srv` with a segment beneath it (`/home/ci-user/repo`, `//home/ci-user/repo`, `checkout path:/home/ci-user/repo`); a drive letter with a separator (`C:\Users\someone`, `D:/build/x`); a UNC host (`\\build-host\share`); anything behind a colon that does **not** open an absolute URL (`https:///home/ci-user/repo`, `file://home/ci-user/repo`, `foo-https://home/ci-user/repo`) |
  | **Verbatim** | every route-shaped identifier — `/api/v1/refund`, `/orders/{id}/refund`, `/users/42`, `/media/upload`, `/workspace/42` — and absolute URLs, including one whose authority is spelled like a system root (`https://home/dashboard`, `HTTPS://home/dashboard`, `ws://home/events`) |
  | **Not caught** | a machine path under any other root (`/workspace/ci-user/repo`, `/data/…`); a relative or tilde path (`ci-user/repo`, `~/repo`); UNC with forward slashes (`//host/share`, indistinguishable from a protocol-relative URL); a drive letter with no separator (`C:work`, indistinguishable from `X:12`); a path in the *path* of a URL (`https://example.com/home/dashboard`) |

  **A colon is read as an address only when it opens an absolute URL** — a scheme from a closed set
  (`http`, `https`, `ws`, `wss`), then `//`, then a **non-empty** authority. All three requirements
  are positive, and each is load-bearing: `https:///home/ci-user/repo` fails the third and is a
  path; `file://` is absent from the set because a `file://` URL *is* a machine path; and the
  scheme is the whole run of RFC 3986 §3.1 scheme characters before the colon, so
  `foo-https://home/ci-user/repo` has the scheme `foo-https` and is a path. Schemes are matched
  case-**insensitively** per RFC 3986 §3.1 — deliberately unlike the engine's request-method
  exemption, which RFC 9110 §9.1 defines as case-sensitive. Two specifications, not two
  conventions.

  The earlier rule matched *any* rooted path of two or more segments. That shape cannot tell
  `/home/ci-user/repo` from `/orders/{id}/refund`, so it destroyed legitimate route identifiers on
  every push while still leaking `checkout path:/home/ci-user/repo` — it excluded `:` from its
  lookbehind to protect `https://`. A heuristic that mangles good data and misses bad data is worse
  than a narrow one that admits what it cannot see, so the net was narrowed rather than broadened a
  fifth time. **Every hole this rule has ever had came from writing it as an exclusion** — `//home`,
  `path:/`, `path:///`, quoted, spaced — each fix correct about the case in front of it and silent
  about the next variant. If a new variant appears, restate what the rule admits; do not add
  another thing for it to skip. It is also **stricter than the engine in one place**: the engine
  exempts a leading request method so `GET /home/dashboard` loads, and this redacts it — a net that
  copies the control's exemptions inherits its blind spots, and a false positive here costs one
  heading while the JSON artifact still carries the value verbatim.
- **Nothing author-supplied can forge the document.** Scenario identifiers are escaped into code
  spans that survive backticks, line breaks are flattened, an HTML comment delimiter inside an
  identifier is visibly replaced — otherwise a suite author could plant a second marker and send a
  find-and-replace at the wrong comment — and free-form prose such as a refusal reason is HTML- and
  Markdown-escaped so it renders as text rather than as structure.

**The JSON artifact stays the durable record.** The Markdown is a rendering of it: never a
baseline, never an input, never read back, and never compared against. `--report-markdown` is
refused if it names the same file as `--out` or as `--baseline`, the second even with
`--overwrite` — that opt-in is for replacing a stale report, not for destroying evidence.

### Every number comes from one accounting

The summary, the section headings, the section bodies and the footer all read a single partition
of the comparison. Nothing counts anything twice, so no two of them can disagree — and the footer
prints the arithmetic so a reader can check it:

```
**Accounting** — 1 regressed + 1 newly covered + 0 not comparable + 1 withheld + 1 new and not passing + 1 removed + 1 unchanged = 6 of 6 scenario entries in the comparison.
```

Every scenario the comparator reported lands in exactly one section. **The catch-all is
deliberately not a term on the left of that equation**: with it there the sum balances however the
partition behaves, and a check that cannot fail is not protection against a scenario falling
between two sections. Excluded, a shortfall in the left-hand total *is* the warning, and it names
how many entries reached no classified section.

A section that lists scenarios takes its heading count **from a snapshot of its own entries** —
there is no way to supply a different one, and no way for the caller to change the list afterwards
— and the single section whose count is deliberately not an entry count is a different
construction whose prose is derived from that same figure. Requiring a number only obliges a
caller to supply one; deriving it from a copy nobody else holds is what makes a heading that
contradicts its body unwritable.

## The trend report

`run --report-markdown` answers *is this change better or worse than the baseline*. The trend
answers *where has this suite been going*. They are deliberately **two commands producing two
artifacts with two comment markers** — merging them produces a document that answers neither well,
and one pull-request comment that each push replaces with the other's report.

**It reads a directory and writes nothing into it. The default invocation prints and writes
nothing at all.**

```powershell
dotnet run --project tools/EvalCli/src -- trend --artifacts artifacts/nightly --root .
```

Add `--report-markdown <path>` to write the report for CI to attach instead of printing it. An
existing file there is refused unless `--overwrite` is passed as well, exactly as `run --out` is.
There is no GitHub call, no token and no network: the tool emits, CI posts.

### The series is ordered by what the runs recorded, and by nothing else

`SuiteResult.Environment.Timestamp` is stamped from the injected clock at run start, which makes it
the only thing in the directory that records when the runs actually happened.

- **Never by file name.** Whoever wrote the artifact chose it.
- **Never by modification time.** A copy, a checkout, or an artifact-download step rewrites it.
- **Compared as an instant, not as a wall-clock reading.** `08:30-02:00` is later than `09:00Z`
  and looks earlier; a run conducted outside UTC produces exactly that, and sorting on the local
  reading draws the series backwards while every timestamp on the page still looks plausible.

**Two artifacts stamped with the same instant are refused** rather than ordered on either of the
above. A trend is a claim about order; a tie makes that claim undecidable at one point, and every
figure downstream of it — the movement between two positions, which artifact first recorded a
scenario, whether a hole is interior or trailing — would then rest on an order the data does not
support. A duplicated timestamp is almost always a copied artifact or a pinned clock, and both are
conditions under which the trend would be describing one run twice.

### A gap never renders as a flat line

This is the failure this report is built against, and it is worse here than in the comparison: a
reader looking at a trend is specifically looking for movement, so a line that appears steady is a
**positive claim of stability**. Nothing is interpolated, carried forward, or carried back.

An artifact records the scenarios that ran. It records neither the suite's membership nor the
selector's decision, so of the four things a missing scenario could mean, **only one is decidable
from the artifacts** — and the report says so rather than guessing:

| Cause | Decidable? | How it reaches the page |
|---|---|---|
| Selected but ungradeable | **yes** | The scenario is in the artifact, it ran, and no repetition produced a verdict. Printed as its own state, never as a pass rate of zero. |
| Not yet present | no | No artifact records it at or before that position. |
| Present but not selected | no | Nothing in an artifact distinguishes a scenario the selector skipped from one that was not in the suite. |
| Absent for an unknown reason | no | A run that errored before it could record the scenario leaves the same hole as the two above. |

What the series *does* establish is **where the hole sits**, and each shape narrows the causes it
is consistent with. The three shapes are worded differently and each says what it does not know:

```
- `search-ranking` — graded at 2 of 4 position(s), outside the stable core.
  - **1.** **no record** — no artifact up to this point records it
  - **2.** 80% (n=5, 95% Wilson CI 37.6%-96.4%)
  - **3.** **no record** — a gap: artifacts on both sides of this one record it and this one does not
  - **4.** 60% (n=5, 95% Wilson CI 23.1%-88.2%)
  - Movement: -20 points, 80% (n=5) at position 2 → 60% (n=5) at position 4. …
```

Closing the undecidable three would take a field in the artifact recording what the selector
decided. There is none, and inferring one from the shape of the record would be the same defect
wearing a different hat.

### The suite figure moves over a population that does not

The subtle one. A suite-level rate pooled over whatever each artifact happened to carry moves when
the **population** changes rather than when **behaviour** does — dropping three failing scenarios
would read as an improvement nobody earned, and adding three would read as a regression nobody
caused.

So the suite figure is pooled over the **stable core**: the scenarios graded at *every* position.
Everything outside the core appears in the per-scenario series with its own figures and in no
suite line. The report states this in the body, not only here, because a reader cannot check a
population they were never told about.

**An empty core is a refusal, not a zero.** If no scenario was graded in every artifact, no
suite-level rate is reported and the headline says why — a zero there would read as a suite that
failed everything rather than as a population that never held still.

**No interval is printed beside a suite figure, and that is stated as a decision rather than left
as an omission.** Pooling repetitions of different scenarios is not a single binomial experiment,
so an interval over them would have the shape of evidence and none of its meaning. Every
per-scenario interval is the figure the run recorded; this report computes none of its own and
runs **no significance test anywhere** — the artifacts in a series are independent runs rather
than a matched pair, so there is nothing for a paired test to pair.

Where two ends of a series are compared, whether their recorded intervals overlap is stated, and
stated carefully: non-overlap is suggestive and is not a test, and overlap establishes nothing
either way. Neither branch uses the word "significant", which no figure on this page is entitled
to.

**And it is stated only where both ends carry bounds this report is willing to show.** One method
decides whether bounds may be displayed and the same method is asked before anything reasons from
them, so a value untrustworthy enough to withhold from the page cannot reach a conclusion printed
beside it. It answers "no" in five cases:

| Case | Why no bound is shown |
|---|---|
| The summary disagrees with its own runs | Its figures do not describe the runs beneath them. |
| **No repetition produced a verdict** | There is nothing for a bound to be about — and verification would recompute through a routine that refuses fewer than one trial, faulting out of the renderer. |
| A single observation | At `n=1` the interval spans most of the unit interval and reads as a measurement. |
| The run recorded no interval method | A bound is checked by recomputing it; without the method there is nothing to recompute. |
| The run recorded no confidence level | Likewise — and printing one needs the level to label it with. |

**Both settings, not either.** A run carrying a level and a method this build does not recognise
has settings present enough to pass a null check and not enough to check a bound with, so
verification is skipped entirely while the bounds still look recorded. Requiring only one let
exactly that through. Worth stating because the earlier fix made the two consumers *consistent*
and left the rule underneath them wrong: consistency is a property of the mechanism and
correctness is a property of the rule, and the first can hide the absence of the second.

**A recorded summary is never trusted before the runs beneath it.** An artifact claiming an
aggregate over repetitions that all errored is checked for graded runs first, in the
classification and in the rendering alike — otherwise it reports a pass rate of zero from a
scenario nobody graded, and enters the stable core, where it moves the most authoritative figure
in the document.

### What gets refused

| Refusal | Why |
|---|---|
| Fewer than two readable artifacts | A trend is movement, and one point has none. "Nothing to compare" and "nothing moved" must not render alike, and a single-column chart reads as the second. |
| Two artifacts at the same instant | See above — the order is undecidable and every figure below rests on it. |
| Runs of two different suites | Two suites share no scenario definitions. |
| A shared id whose **definition fingerprint** disagrees | A rate recorded before an edit and one recorded after it answer different questions; a line between them reports the edit as movement the suite made. |
| A shared id whose **kind** disagrees | `ScenarioFingerprint` deliberately excludes the kind and says every consumer owes it a second comparison. This is that comparison. |
| A shared id with **no** fingerprint on one side | Absent is not the same as matching. (An id only one artifact carries is trended as the single point it is — there is nothing to establish.) |
| `intervalMethod` or `intervalConfidence` disagreeing | Those decide what every printed interval *means*; a 95% Wilson bound beside a 99% Agresti-Coull bound under one heading is evidence from one context presented as another. |
| One artifact recorded twice under one id | The id is the join key; picking a side would make every figure below it a silent choice between two runs. |
| Any file in the directory that will not read | Refused rather than skipped — dropping it would take a run out of the series silently, and every scenario would then carry a hole at that position that nothing caused. This includes a directory that cannot be listed and a file that is listed and gone when it is read. |
| `--report-markdown` resolving inside `--artifacts` | Exits `1`, not `4`: the invocation was refused before anything was read. `--overwrite` does not lift it. |

All of the trend-analysis refusals exit `4`. **The refusal names the file by its path relative to `--root`**, through the
same display and redaction rules the Markdown uses, because the message reaches stderr and from
there the build log. The engine's own message is deliberately not forwarded: it carries the
reference it was handed.

**Membership moving is not a fingerprint disagreement.** A scenario appearing or disappearing is
the movement this report exists to show, so the fingerprint check is a relation over the scenarios
two artifacts *share* rather than a digest over the whole set. Folding membership into it would
refuse exactly the series worth trending.

### What it will not do

- **No chart and no image.** Text and tables only.
- **No gate.** `--fail-on-regression` is not declared by this command at all; exit codes `10`–`19`
  stay unallocated. An option accepted here would read as one that might act — which is the same
  rule `run` now applies by refusing the flag outright rather than parsing and ignoring it.
- **No posting.** Same as the comparison report: the tool writes a file, CI attaches it.
- **It conducts nothing.** There is no `--suite` and no `--endpoint`; this command runs no scenario
  and dials nothing.
- **It is never read back.** The JSON artifacts are the durable evidence. This Markdown is a
  rendering of them and is never itself trended against.

### Size

The same 65,536-character comment budget and the same deterministic, severity-ordered truncation
as the comparison report — one implementation, shared, because two budget allocators would
eventually disagree about what "truncated" means and the one that disagrees drops a section
silently. The roster of runs is allocated first, because every position number below it is
unreadable without it; the gaps come next. A budget too small to hold the headings and standing
explanations is refused rather than fitted: in this report those explanations are what stop a hole
being read as a flat line.

## Updating a committed baseline

This is the destructive command, and it is the **previewed, verified** route to replacing a
committed baseline: it previews by default, never creates, refuses a baseline belonging to another
suite, refuses a run with errored scenarios, and replaces only the bytes it read and made those
refusals against. **No `run` invocation replaces a file that same invocation reads** — not the
suite, and not a baseline it was pointed at — so no invocation that is safe today becomes
destructive because an option was added later.

> **What this does *not* claim.** `run --out <path> --overwrite` will replace an existing file at
> `<path>`, and that file may happen to be a baseline somebody committed. The tool cannot tell:
> a baseline and a run artifact are the same document, so "is this a baseline" is not a property
> of a file this or any other check could read. What `run` can tell — and now does — is when a
> destination is a file **this same invocation was also asked to read**, which is the case where
> the caller demonstrably cannot have meant it. Everywhere else, `--overwrite` on a path you typed
> means what it says. Making `--out` create-only instead was considered and rejected: it would
> push the ordinary re-run-into-the-same-artifact loop out of a guarded tool and into an
> unguarded `rm`, which has no containment, no link refusal, and no staging.
>
> So the division is not "`run` cannot replace a baseline and `baseline update` can". It is that
> **`baseline update` is the only route that checks what it is replacing before it replaces it.**
> `run --out --overwrite` gets containment, link refusal, staging and an atomic rename — and none
> of the foreign-suite, errored-run, or byte-identity verification above.

**The default invocation is a preview. Start there — it writes nothing.**

```powershell
dotnet run --project tools/EvalCli/src -- baseline update --suite eval-suites/regression.json `
    --root . --baseline artifacts/baseline.json `
    --endpoint http://localhost:8787/evaluate --rest-exchange json
```

```
Baseline update preview - 1 of 2 scenarios would change classification.

  suite             regression
  root              C:\repo
  baseline          C:\repo\artifacts\baseline.json
  endpoint          http://localhost:8787/<redacted>
  opt-in            absent - nothing was written; pass --apply to replace the baseline
  scenarios         2 recorded -> 2 recorded

  comparison
    baseline            artifact C:\repo\artifacts\baseline.json
    newly covered       0
    regressed           1 - checkout-happy-path
    ...

Nothing was written. The baseline at C:\repo\artifacts\baseline.json is unchanged.
```

It conducts the suite and compares, so the preview reports **the diff shape** — how many scenarios
change classification and which ones — rather than just "will overwrite". You cannot know the first
without running, and the second is not information.

Then, deliberately:

```powershell
dotnet run --project tools/EvalCli/src -- baseline update --suite eval-suites/regression.json `
    --root . --baseline artifacts/baseline.json `
    --endpoint http://localhost:8787/evaluate --rest-exchange json --apply
```

### Why this command is stricter than `--out`

A committed baseline is a **tracked source file**. Replacing one is more consequential than writing
a fresh artifact, so four rules apply here that do not apply to `--out`:

- **It never creates, only replaces.** The baseline must already exist — checked while the
  arguments are validated, **and again at the moment of the write**, where the replacement is
  performed by an operation that fails rather than creating. A path that is not there exits `5`,
  not `1`. A typo, or a file that vanishes mid-run, would otherwise write a plausible-looking
  baseline somewhere nobody reads while the real one stayed stale forever, and every later
  comparison would be made against the stale file with nothing to indicate it. Write the first
  baseline with `run --out`.
- **It replaces only the file it read.** The committed baseline is fingerprinted before the suite
  is conducted, and the fingerprint is checked again immediately before the replacement. Every
  refusal below is a statement about *contents*; without this, the file destroyed at the end of a
  run is not necessarily the one any of them examined — so another suite's baseline swapped in
  mid-run would be overwritten by the very command whose second rule exists to prevent that.
- **It refuses a baseline belonging to another suite** (exit `4`). That is not a regression, it is
  the wrong file, and replacing it destroys evidence for a suite this run never evaluated.
- **It refuses to commit a run with errored scenarios** (exit `3`). An errored run means the
  harness could not ask the question. Freezing one into a baseline makes every later comparison of
  that scenario report that neither side has a verdict — permanently unanswerable rather than
  merely unknown for one run.
- **`--changed-since` is not accepted.** A baseline assembled from a narrowed run records only the
  scenarios that ran, and every later comparison would read the rest as removed. A baseline is a
  statement about a whole suite.

A scenario that compares as `not-comparable` is **not** fatal here, unlike in a run: a stale
fingerprint is exactly the state regenerating the baseline resolves, and refusing would leave you
unable to fix the thing the refusal complained about.

**When nothing could be compared at all, the counts are reported as unknown rather than as zero.**
A committed baseline driven from a different root seed, or under different harness settings, is a
legitimate reason to re-baseline — and it means nothing measured how much of the file changes. The
headline says so, `diffAvailable` is `false`, and `scenariosChanged`, `classificationCounts`,
`newlyCovered`, `newlyCoveredWithheld`, and `regressed` are all `null`:

```
Baseline update preview - how many scenarios would change classification is unknown: nothing could compare the two.
```

Zero would be a claim — "replacing this file changes nothing" — and it is exactly the claim
somebody deciding whether to replace a committed file would act on.

The write itself goes through the same code `--out` does — containment against `--root`, refusal of
any link below it, staging under a `.partial` name that `CreateNew` creates or refuses,
re-verification with the file in hand, then an atomic rename. There is deliberately not a second,
weaker write path.

**If the command is interrupted after the baseline has been replaced**, it exits `130` like any
other interruption, but it does **not** claim nothing was written — it names the file that changed.

### Options

| Option | Default | What it does |
|---|---|---|
| `--suite <path>` | **required** | The suite definition, resolved relative to `--root`. |
| `--root <dir>` | working directory | The boundary. |
| `--baseline <path>` | **required** | The committed baseline to replace. Must already exist. |
| `--apply` | **off** | **The opt-in.** Without it nothing is written. |
| `--endpoint`, `--rest-exchange`, `--llm-exchange`, `--seed`, `--max-concurrency`, `--max-total-runs`, `--json`, `--verbose` | as for `run` | |

## `run` options

| Option | Default | What it does |
|---|---|---|
| `--suite <path>` | **required** | The suite definition, resolved relative to `--root`. |
| `--root <dir>` | working directory | The boundary. Every other path must resolve inside it or it is refused. |
| `--baseline <path>` | none | A committed baseline artifact to compare against. Read only; never modified. Also tells [selection](#selection-is-opt-in) which scenarios there is evidence to skip. |
| `--baseline-endpoint <url>` | none | Conduct the suite against this address and compare the candidate to that run. Must differ from `--endpoint`, may not carry a query string or a fragment, needs an exchange, and conducts the suite twice. Mutually exclusive with `--baseline`. |
| `--out <path>` | none | Where the run artifact would be written. **Omit it and no artifact is written** — this does not govern `--report-markdown`, which writes its own file whether or not `--out` was given. May never be the same file as `--suite` or `--baseline`, with or without `--overwrite`. |
| `--report-markdown <path>` | none | Where to write the [Markdown comparison report](#the-pull-request-report) for a pull request. Needs a baseline; refused without one. May never be the same file as `--out`, `--suite`, or `--baseline`. This tool writes the file and never posts it. |
| `--overwrite` | off | Opt in to replacing an existing file at `--out` or `--report-markdown`. Without it, an existing file stops the run. Never permits replacing `--suite` or `--baseline`, and is refused outright if neither destination is named. **Does** permit replacing any other existing file at the path you name, including a baseline not passed as `--baseline`. |
| `--seed <n>` | `0` | The root seed. Fixed, not random: a baseline and a candidate must share it for the comparison to be paired. |
| `--max-concurrency <n>` | `1` | Hard ceiling on runs in flight. Load on somebody else's system is opted into. |
| `--max-total-runs <n>` | `100000` | Ceiling on the runs a suite may plan, so a mistyped repetition count is refused rather than executed. |
| `--endpoint <url>` | none | The address the run is directed at, and the address recorded in the artifact. Credentials in the URL are refused; everything after the host — path, query, and fragment — is redacted from all output. |
| `--changed-since <rev>` | none | Read the changed-file set from `git diff <rev>` plus the untracked files, and run only the scenarios it impacts. **Omit it and the whole suite runs**; see [Selection](#selection-is-opt-in). |
| `--rest-exchange <name>` | `none` | Which adapter describes the REST system under test: `none` or `json`. Needs `--endpoint`. See [The built-in JSON contract](#the-built-in-json-contract). |
| `--llm-exchange <name>` | `none` | Which adapter describes the conversational system under test: `none` or `json`. Needs `--endpoint`. |
| `--dry-run` | off | Print the planned run and execute nothing. |
| `--json` | off | Emit the result as JSON on stdout. |
| `--fail-on-regression` | off | **Not available.** The invocation is refused with exit `70` rather than accepted and ignored — a flag that goes green without gating tells a CI step it is guarded when nothing is. Exits `10`–`19` stay reserved for it. |
| `--verbose`, `-v` | off | Debug diagnostics on stderr. |

### Selection is opt-in

**Without `--changed-since`, every scenario runs.** Choosing a revision to diff against is a
judgement this tool will not make for you: `HEAD` misses everything already committed on a branch,
a merge base needs to know which branch is the trunk, and picking wrong makes the run *smaller*.
A scenario that should have run and did not produces no output at all — there is no wrong number
in the report to catch it, only silence and a green result — so the default is to run everything
and say so.

When you do pass it, the set is read with **`git diff -z --name-only --no-renames`** *and*
**`git ls-files -z --others --exclude-standard`**, each passed as an argument array and never as a
shell string:

- **Untracked files are part of the set.** `git diff` reports tracked files only, so a brand new
  source file is invisible to it. The shape that costs a scenario its run is the *mixed* one: one
  tracked file also changed, so the set is non-empty and looks authoritative, while the new file
  that actually breaks something is missing — and an empty set already widens the run, whereas an
  incomplete one does not. Files git is ignoring stay out (`--exclude-standard`): without that,
  every `bin/` and `obj/` artifact joins the set on every run and selection stops narrowing
  anything at all.
- **`-z`, not plain `--name-only`.** Without it git *C-quotes* any path containing a non-ASCII
  byte, a quote, or a control character, so `src/café.cs` arrives as the literal text
  `"src/caf\303\251.cs"`. That still looks like a path, it still matches no glob, and the scenario
  mapped to the file that really changed would sit out the run meant to catch its regression.
  `-z` turns quoting off and separates entries with a NUL, which no path may contain.
- **Bytes, not text.** The output is decoded as strict UTF-8. A path that will not decode is
  refused rather than approximated, because a replacement character produces a path that looks
  real and matches the wrong thing.
- **A path carrying a literal backslash is refused.** On Linux and macOS a backslash is an
  ordinary character in a file name, so `src/a\b.cs` is one file inside `src` — but impact globs
  are matched with a backslash read as a separator, which is right on Windows and wrong here. It
  would be matched as `src/a/b.cs`, miss `src/*.cs`, and retire the scenario mapped to it. There
  is no lossless way to hand it over, so the run widens instead.
- **`--no-renames`.** A detected rename reports only the destination, so a scenario mapped to the
  path that went away would never run. Turning detection off reports both sides.
- **Paths are rebased onto `--root`.** git reports paths relative to the *repository* root; impact
  globs are relative to `--root`. When those differ — `--root tools/EvalCli` in a repo whose top
  level is two directories up — every path is rebased before it is matched. A changed file that
  cannot be expressed relative to `--root` is **named and the run widens**, never dropped.

Anything that makes the set untrustworthy — git missing, a directory that is not a repository, an
unknown revision, output that would not decode, a path a glob cannot be matched against, a file
outside `--root` — runs the **whole suite** and says why, on stderr and in the report.
Over-selecting costs time; under-selecting costs correctness, invisibly.

### Why a scenario ran

A count is not a claim anybody can check. `47 of 150` is indistinguishable from a broken selection
that happened to produce a plausible number, so every run reports the rule that selected each
scenario — `glob-match`, `previously-failing`, `new`, `no-globs-declared`, or `fallback` — with the
per-reason totals, the command the changed-file set came from, and, when the suite ran whole, the
reason it did. Every reason is listed even when its count is zero: a reason omitted reads as a
reason that does not exist, and "the safety net rescued nothing" would be indistinguishable from
"there is no safety net". Per-scenario detail is printed under `--verbose`, and always in `--json`.

### The built-in JSON contract

The engine deliberately ships no `IRestExchange` or `IConversationExchange`: a library cannot know
the request shape or the reply shape of a system it has never seen, and any default it shipped
would be one system's JSON frozen into a generic engine. A composition root is the opposite case —
it exists to make that decision for one invocation — so the decision is made here, and naming it on
the command line is what keeps it auditable.

**It is never on by default.** Without `--rest-exchange json` no runner is registered for REST
scenarios, and the engine records that gap as a harness failure. An exchange that was wired
speculatively would turn "nobody told the harness what this system looks like" into "this system
returned something unexpected" — a finding about the wrong party.

Request: `POST` to `--endpoint`, `Content-Type: application/json`.

```json
{ "input": "refund order 4471", "scenarioId": "checkout-happy-path", "turn": 1, "repetition": 1, "seed": 0 }
```

Response: a JSON object. `output` is required and must be a string; `outcome` and `path` are
optional strings; every other top-level scalar is exposed to structural and presence assertions as
a field keyed by its property name.

```json
{ "output": "refund issued", "outcome": "refund.approved", "path": "verify/refund" }
```

Anything else is reported as a malformed response, which the engine records as a finding *about the
system under test* rather than as a harness fault — so a suite can assert on it, and a mismatched
contract shows up as a named malformed response rather than as a pass. No fragment of the body ever
reaches the error message: an uninterpreted body is precisely the one nothing has redacted.

Two limits worth knowing before you point it at anything real. The conversational adapter sends
**each turn independently and carries no history** — accumulating it would mean per-run state on an
object the engine shares across concurrent runs, and keyed wrongly that leaks one run's
conversation into another's. And there is **no authentication surface**: the tool sends no
credential of any kind, so this reaches unauthenticated systems only. A system needing either needs
its own adapter.

### Safety

- **The default invocation writes nothing and mutates nothing.** There is no flag combination in
  this build that deletes anything.
- The only writes `run` performs are `--out` and `--report-markdown`, and an existing file at
  either is refused unless `--overwrite` is passed as well. The refusal happens before anything
  runs, so it costs nothing and leaves the file exactly as it was. **`--overwrite` never reaches a
  file this same invocation reads** — the suite or a named baseline — and that refusal is
  re-established at the moment of each write rather than only when the arguments were checked.
  `--overwrite` with neither destination named is refused outright, as it is on `trend`: an opt-in
  with nothing to opt in to reads as one that might act.
- **Nothing is written through a truncating open, by either command.** A run takes as long as the
  system under test does, so a destination validated before it started is evidence about a
  directory tree that has had minutes to change — a directory swapped for a link in between would
  redirect the write, and no file mode defends against that, because the mode governs the leaf
  while what moved was the path to it. The destination is therefore re-checked at the moment of the
  write, the file is staged under a `.partial` name that `CreateNew` creates or refuses, the path it
  actually landed on is verified again with the file in hand, and only then is it renamed into
  place. A rename replaces the destination entry itself rather than following a link through it,
  and without the opt-in it refuses an occupied destination atomically. **Publication is also
  conditioned on what the two files *are*, not only on where they sit**: the staged file must
  still hash to the bytes this invocation wrote, and a `baseline update --apply` destination must
  still hash to the bytes the command read and made its refusals against. What is left is the
  interval between the last check and the rename, which no portable .NET API can close; a file
  substituted inside it has to carry byte-identical contents to be published, and the worst it can
  do is leave a new file somewhere unintended, never destroy one that was there. **There is
  one implementation of this**, used by `--out` and by `baseline update --apply`: a second, weaker
  copy is the one that eventually disagrees in the direction of writing somewhere it should not.
- Every path argument is resolved through the engine's `PathBoundary` and refused if it leaves
  `--root` — checked on the text before any I/O, then again on the path links actually lead to, so
  a junction inside the root pointing elsewhere on the machine is caught rather than trusted. That
  containment rule has exactly one implementation, in the engine; this tool does not carry a second
  one. A *destination* — `--out`, or `--baseline` under `baseline update` — is held to a stricter
  rule on top of it and is refused when *any* segment below the root is a link, because nothing
  downstream re-checks where a write lands. The root itself may be a link: it is the boundary you
  declared, and the resolved location is what gets reported.
- **`baseline update` is the *verified* route to replacing a baseline, not the only one.** No
  `run` invocation replaces a file it reads, so no invocation that is safe today becomes
  destructive because an option was added later — but `run --out --overwrite` will replace any
  other existing file at the path you name, including a baseline it was not given as `--baseline`.
  What `baseline update` adds is verification of the thing being replaced: its default is a
  preview that writes nothing, it never *creates* a baseline, it refuses one belonging to another
  suite, it refuses to commit a run with errored scenarios, it refuses to publish an artifact the
  reader would decline, and it replaces only the bytes it read.
  See [Updating a committed baseline](#updating-a-committed-baseline).
- **Nothing is published that cannot be read back — in size *and* in shape.** The artifact reader
  refuses a file above a fixed byte budget (before allocating, so a reference to something
  enormous is a refusal rather than an exhausted host) and refuses what is inside it if the schema
  version is unsupported, a null sits where the shape forbids one, or an identifier carries a
  machine path. Both publication paths, `run --out` and `baseline update --apply`, are held to
  **both** checks before anything is staged: the size against the engine's own budget, read rather
  than restated so the two cannot drift, and the shape by putting the serialized bytes through the
  reader's own deserializer. Checking size alone and claiming read-back whole is the same class of
  defect as a gate that is accepted and never runs. `baseline update` applies both in its
  **preview** as well, so it never advises `--apply` for a candidate `--apply` would refuse.
- **The publishing budget cannot be widened.** Redaction is private to the budget so publishable
  bytes cannot be obtained around it, and the ceiling the budget takes is refused above the
  engine's value — a barrier with a parameter that reopens it is not a barrier.
- **A comparison cannot be made against the wrong pair.** `--endpoint` and `--baseline-endpoint`
  may not name the same address, no destination may be one of the files the same invocation reads,
  scenarios this run did not conduct are withheld rather than reported as removed, and a pair that
  could not be compared exits non-zero instead of printing "0 regressed".
- **A gate that is not implemented is not accepted.** `--fail-on-regression` refuses the
  invocation with exit `70` rather than parsing and ignoring it. The reservation of `10`–`19` is
  documentation, and documentation does not reach the person who wired the flag into CI and saw
  the step go green.
- **`trend` cannot destroy the evidence it was asked to read.** `--report-markdown` is refused when
  it resolves inside the directory `--artifacts` names, and **`--overwrite` does not lift that**:
  the opt-in is about replacing a file you chose, not about writing Markdown over one of the run
  artifacts the report is made of. Doing so would take a run out of the series permanently, and the
  next trend would classify the resulting hole in every scenario as though something had caused it.
  It is a containment test rather than a prefix test — `trendy/report.md` is not inside `trend` —
  and it is **asked again immediately before the write**, because the answer is a property of the
  file system and a directory swapped for a link in between would redirect the write into the
  series. `--overwrite` without `--report-markdown` is refused outright: it names the only
  irreversible thing this command can do, and an opt-in with nothing to opt in to reads as one that
  might act.
- **An interruption after a durable write says so.** "Interrupted, and nothing was written" is two
  claims and only the first is always true. This defect arrived **six times** — `baseline update
  --apply`, `run --out`, the live-baseline comparison, the staged-file cleanup, and the report
  write — and each fix was correct about the operation it named and silent about the next, because
  the property was written as *this step, after this write* and kept being a local flag beside a
  filtered `catch`. It is now structural: `ArtifactWriter` records every publication into a ledger
  it is handed, and `DurableWrites.GuardAsync` issues that ledger **together with** the catch that
  wraps the whole command body, so every later step is covered including ones nobody has written
  yet. The ledger's constructor is private, so a command cannot skip the guard and still have
  somewhere to record — that does not compile. The residual hole is named in the code: a step
  added *outside* the command body, after the guard returns. Each entry point is an expression
  body precisely so there is no statement position there to add one into.
- **A staged file this tool cannot identify is never unlinked.** Every write is staged under
  `<destination>.partial` and renamed into place. Before publication the staged file is read back
  and matched against the bytes this run wrote **and both paths are re-contained** — a content
  hash says what the bytes are, not where they live, and a pathname redirected onto an identical
  copy satisfies it exactly. **If either check fails, the cleanup leaves the file alone**: the
  refusal is precisely that the pathname no longer denotes this run's file, and deleting it
  afterwards would destroy the thing the refusal was about. A parent directory exchanged for a
  link in that window makes it a file outside the root that no argument named; this is the only
  place in the tool that could destroy something the caller never named. Removal is taken **only**
  where identity and containment were established a moment earlier, and the cleanup re-asserts
  containment once more immediately before unlinking. .NET exposes no portable unlink through an
  open handle, so even that is by pathname and has a residual window. Everywhere else the
  `.partial` is left, and the refusal **says it was left and where** — including on interruption,
  where the blanket "nothing was written" sentence would otherwise send a reader past a file they
  now have.
- **No refusal names a path on your machine.** Every message `PathGuard`, `ArtifactWriter`,
  `RunPlan`, `SuiteDiscovery`, `BaselineCommand` and `BaselineComparison` produce states its path
  **relative to `--root`**, through the same display and redaction rules
  the Markdown report uses, and no exception prose is forwarded — an engine refusal carries the
  reference it was handed, and the operating system's own wording carries the absolute path it was
  handed, on every platform and in every locale. A refusal reaches stderr and from there the build
  log, which is read by anyone who can read the repository, and a CI checkout directory names the
  account the job runs as. `ArtifactWriter`'s messages matter particularly: they fire when a
  destination stops being writable *after* the arguments were validated, which is the window an
  opt-in cannot cover because nothing was there when the opt-in would have been asked for.

  **The relative form is not a loss.** What an argument can get wrong is the part below the root;
  a wrong `--root` fails earlier and differently, in `PathGuard.ForRoot`. The engine makes the
  same judgement for the same reason — `suite.notFound` names its `sourceLabel`, which carries no
  machine path — so a refusal from either layer names the same path in the same form.

  **The `run` and `baseline update` *result* documents are a known exception and still print
  absolute paths.** The `root`, `suite`, `baseline` and `artifact` values in `--dry-run` output,
  in the `baseline update` preview, and in a completed run's summary are the command's result on
  **stdout**, not a refusal on stderr: they are a declared schema (`eval-cli/dry-run/1`) and the
  documented way to confirm what an invocation resolved to before it is spent. `root` in
  particular has no relative form. Closing them is a contract change and is tracked separately
  from the refusal surface above.

  The one case that cannot be covered is `--root` itself failing to resolve: there is no boundary
  yet to state anything relative to, so the published net is applied to the value **as supplied**,
  which is strictly less than the caller already typed. **That applies to text the caller typed
  and to nothing else** — a root this tool derived and canonicalised is re-resolved at the moment
  of a write, and a refusal out of *that* check says so rather than echoing a machine path. The
  distinction is carried by `PathValue`, whose two factories every call site must choose between,
  because the rule was twice written as a convention about which method you were in and twice
  compiled with the wrong value. **A type can force the question to be asked; it cannot make the
  answer true** — the first wrong answer was `--root` itself, whose default factory materialised
  `Directory.GetCurrentDirectory()` at binding, so an omitted option arrived indistinguishable
  from one the caller typed. The option now carries no default: absence is carried as absence, and
  the single place that turns it into a working directory is the place that marks it derived.
  (It also means `--help` no longer prints the machine's working directory.) A value that will not
  parse as a path at all is refused **without being repeated**, because neither label can be
  trusted to render something `Path` has just rejected. The net's holes are listed under
  [What it will not print](#what-it-will-not-print).
- **Artifact-derived text is netted before it reaches stderr.** A suite name or scenario id in a
  `trend`, `run` or `baseline update` refusal goes through the report's own redaction net rather
  than being printed as
  recorded. The engine's authoring-time control exempts a leading request method — ADR 0005 records
  that `GET /home/dashboard` must load and that the exemption *necessarily* admits
  `GET /home/ci-user/repo` — so an identifier carrying a machine path behind a method token reaches
  artifact read-back intact. That concession was documented against the Markdown document, where
  the report's stricter net catches it; a refusal in the build log is a second published surface and
  does not inherit the concession by omission. This covers the comparator's own account of a
  divergence — which quotes the suite names and setting keys that disagreed — and the per-scenario
  reasons in a partial-comparison refusal.

  **Four channels, not one.** The same admitted identifier reaches stderr through a loader
  **warning**, a loader **error**, the engine's **log stream**, and an engine refusal printed by
  the **exit-code reporter**. All four are netted. The exemption never changed; the number of
  surfaces it reaches did, which is the failure mode ADR 0005's amendment predicts.

  **A finding carries author text in two places.** The scenario id is exposed structurally and is
  netted as a value, which is where the net works. The *explanation* can also quote the author
  back — an assertion finding embeds `category:parameter`, so `exactMatch:/home/ci-user/repo`
  arrives mid-sentence. Both are netted, fail-closed, rather than against a list of codes known to
  embed author text: a list would be right about today's branches and silent about the next one
  added upstream.

  **Where the net shortens a message, the message says so — and says why.** `MachinePath` matches
  to the end of the value by design, so in a sentence it takes the explanation with it. Rather
  than let that read as a finding with no finding in it, the line states that the rest was
  withheld and where to look. An ordinary finding matches nothing and is carried through whole;
  only one that embeds a machine path pays. A better pattern is not the answer, because prose does
  not tokenise like an identifier.

  **The cause is asked, not inferred.** `Sanitize` has four effects — it flattens control
  characters, replaces comment delimiters, aliases machine paths, and clips over-long text — so
  "the string changed" is evidence for any of them, and only one is a reason to tell an author to
  rename something. Redaction is therefore asked about directly, through
  `MarkdownReport.ContainsMachinePath`, which shares its pre-steps with `Sanitize` so it sees the
  same text the net runs over. Any other transformation gets a cause-neutral note instead. A
  message that accuses an author of a machine path that is not there sends them looking for
  nothing and teaches them the tool is unreliable.

  **The alias-collision guard checks what is rendered, not what was recorded.** It nets the same
  flattened text the renderer does — asking about the raw value invents aliases for shapes that
  flatten away and misses collisions that only appear once flattened — and it additionally refuses
  two *different* values that render to the same string for any reason, because that, not the hash
  collision, is the defect it exists to prevent.

  **No log record prints a stack trace.** Frames carry the checkout directory and the source
  layout of the build machine. `ExitCodeReporter` already refused that for everything except a
  defect; the log provider now refuses it too, printing the exception's type and netted message
  instead. A run the harness could not conduct is a deliberate refusal, not a defect.

  **A deliberate refusal never reaches the defect branch.** The coordinator refuses a suite whose
  plan would exceed the run budget, and signals it with an exception type that would otherwise be
  classified as an unexpected defect — which prints the scenario id unredacted *and* the frames.
  It is translated where the suite is conducted, in one place for both commands, into a usage
  error that names `--max-total-runs` and not the scenario. The defect branch still prints frames
  for genuine defects, which is the other half of the rule and is tested as such.
- **A rejected option value is not echoed.** `--rest-exchange`/`--llm-exchange` name a closed set,
  and a value outside it is refused **without being repeated** — the option name and the valid
  values are what a caller acts on, and they already have what they typed. Netting it would not
  do: the net catches machine paths, and a credential is not path-shaped. This is the same choice
  `PathGuard` makes for a value that will not parse as a path at all, and the same reason
  `ArgumentRedactor` strips supplied values out of parser diagnostics.
- **The changed-file set names neither the revision nor git's own wording.** `--changed-since`
  takes a caller-supplied value that can be neither a path nor safe, and git echoes whatever it
  was handed straight back on its standard error. The refusal that reaches the log therefore names
  the *option* and the category of failure, and nothing else — git's explanation is not forwarded,
  for the same reason no operating-system message is.

  **Known gap, tracked with the stdout class:** on the *success* path the report's
  `changed files` line still prints the full git command it ran, which carries the absolute root
  and the revision. It reaches stdout and the run-report JSON — the same result-document surface
  as `--dry-run`'s `root` and `suite` rows — and is deferred with them rather than half-fixed here.
- **No harness setting's recorded text is ever printed.** `HarnessConfig` is an open map of strings
  in a file anyone can write, so a setting could carry a credential. Only values this build
  re-derives into a typed form reach the page — a method name matched against a closed set prints
  the *matched literal*, a number is parsed and re-rendered — and a setting this build does not
  recognise is **counted without its name or its value**, with the count stated so a change that
  moved is never indistinguishable from one that did not.
- **Redirects are neither followed nor graded.** `HttpClient` follows them by default, and that
  default is a false green here: every claim this harness makes about *where* a run went is made
  from the address that was **requested**, so a baseline address answering `307` with the
  candidate's address delivers the baseline run to the system under review. Every guard still
  passes — the requested address really was the baseline's — and the comparison becomes the change
  against itself, which agrees about everything. Not following is only half of it: a `3xx` left to
  stand as a reply *grades*, and against a redirecting baseline that reports every scenario as
  fixed. So a redirect is raised as a request that never arrived, which produces no verdict at all.
  **The trade is total: a suite cannot assert on a `3xx`.** Point the endpoint at the address that
  answers.
- **Narrowing a run does not change the seeds its scenarios are driven with.** Seeds are drawn in
  suite order, so dropping a scenario before the run would shift the draw of every scenario after
  it — and the comparison is paired *by seed*, so the selected scenarios would stop comparing
  against their own baseline. The schedule is computed from the suite as declared and replayed for
  the scenarios that run.
- **`git` is invoked with an argument array, never a concatenated command line**, and never
  through a shell. `--changed-since` is validated as well, and `--end-of-options` stands between
  its value and git's own option parser, so a value beginning with `-` cannot become a flag.
- **Credentials never belong on the command line.** `--endpoint` refuses a URL carrying userinfo,
  and its path, query string, and fragment are stripped from everything printed, logged, or
  recorded — a key is as much at home in a path segment as in a query parameter, and neither can
  be told apart from ordinary routing by inspection. What survives is scheme, host, and a
  non-default port, which is what identifies the environment.
- **That applies to the artifact bytes, not only to the report.** A report is rendered from the
  redacted address; a transcript is built by the engine from the address that was *actually
  dialled*, because that record is the evidence a baseline was conducted against the system it
  claims. The unredacted address therefore survives in memory — the live baseline provider needs
  it — and is reduced to the printable form on its way to disk, for both `run --out` and
  `baseline update --apply`. Engine messages quoting an address are put through the same rule
  before they reach stderr.
- **A value that fails to parse is redacted too.** A parse error is produced before any option has
  been interpreted, so redaction sits at the output boundary rather than at the option: a secret
  typed into the wrong flag, or with no subcommand at all, still does not reach stderr.

### Output contract

Results go to **stdout**; diagnostics, warnings, log records, usage errors, and help shown because
of an error go to **stderr**. A caller can pipe stdout into another process without contaminating
it.

## Exit codes

Exit codes are an API — every caller that checks one depends on these values, so they are additive
only and are never renumbered.

| Code | Meaning |
|---|---|
| `0` | The run completed and nothing asked for a non-zero exit. |
| `1` | The invocation was refused — bad argument, value, or path. This includes a `--baseline` that exists but is not a readable run artifact: the invocation named it, and a baseline that cannot be read is not the same as no baseline. It also includes a `--baseline` that reads cleanly but carries a **machine path in one of its identifiers** — the engine refuses those on read-back, and this tool reports the field and the scenario position so the author can rename it, never the offending value itself (that message goes to the build log). |
| `2` | The suite could not be loaded or did not validate — including a suite that declares no scenarios, which is refused before anything runs rather than reported as `0 of 0`, and a suite name, scenario id, or slicing tag carrying a machine path (`suite.name.machinePath`, `scenario.id.machinePath`), which the engine refuses at load so the author can rename it. |
| `3` | The run could not complete, **or what it produced could not be published** — at least one run was recorded as an error (including an address that answered with a redirect), or the artifact could not be written, or the destination stopped being the file the command read, or the artifact was one the reader would refuse (too large, or carrying a shape or an identifier it declines). Deliberately coarse: every one of these leaves the caller without usable evidence, and the message says which. |
| `4` | Baseline and candidate were not conducted alike, so the comparison was refused. Also produced when *any* available pair could not be compared — reported as a refusal rather than as "no regressions found", because those scenarios were not examined. **`trend` uses the same code for every refusal it makes**: fewer than two readable artifacts, two artifacts stamped with the same instant, runs of two suites, a scenario redefined mid-series, disagreeing interval settings, or a file in `--artifacts` that will not read. The meaning is the same in both commands — two or more runs could not be set against each other, and the analysis did not happen. The message says which. |
| `5` | A baseline was required and none was found — including one that goes away between being read and being replaced. *(No baseline is not the same as no regression.)* |
| `10`–`19` | **Reserved for the gate.** `10` is "regressions found"; nothing produces it yet, and the range stays held rather than released. |
| `70` | The requested operation is not wired up in this build. **Produced by `--fail-on-regression`**, which is refused rather than accepted and ignored. |
| `71` | An unhandled internal failure — a defect in this tool. **The only code that prints a stack trace**: frames carry the checkout directory and the source layout of the machine that built the tool, so a deliberate refusal never reaches this branch. |
| `130` | Interrupted (Ctrl+C). Partial state. Nothing was written **unless the message says otherwise** — `baseline update --apply` interrupted after the replacement names the file that changed. |

`0` means *the run completed and nothing asked for a non-zero exit*. It never means "the tool
finished printing."

**A scenario that ran and failed is report-only; a run recorded as an *error* is not.** An error
means the harness could not ask the question — no runner registered for the kind, no transport, an
adapter that fell over — so that scenario produced no evidence at all, and the run exits `3`. A
green check over a suite that was never conducted is worse than no check.

- **A suite declaring no scenarios is refused, not run.** The loader only warns — a library cannot
  know whether an empty suite is a mistake or a placeholder — but this tool owns the exit code,
  and `0` tells an automated caller the evaluation passed. Nothing was evaluated, so it exits `2`
  before conducting anything. A suite that declares scenarios and *selects* none of them is a
  different thing and still succeeds: those scenarios exist, and the report names the rule that
  skipped each one.

`5` is produced by **`baseline update` pointed at a baseline that is not there**. That command
replaces a baseline and never creates one, so a path that does not exist is a mistyped path rather
than a first run — writing one anyway would leave the real baseline stale with nothing to show for
it. The same code is produced when the baseline was there at argument time and has gone by the
time the replacement would happen: the file is fingerprinted before the suite is conducted and
checked again before it is replaced, and a destination that went away is refused rather than
recreated. It is also produced if a baseline provider answers "no artifact for that reference"
during a comparison. On `run`, `--baseline` is checked for existence while the arguments are
validated, so there it stays reachable only on a race — it is there so that case cannot silently
widen the selection instead.

## Current state

**`partial` — the suite runs, the comparison reports, the report is attachable (T15a), and the
trend reports across a series (T15b).** Argument parsing and validation, the exit-code contract,
`--help`, `--dry-run`, `--json`, suite discovery and validation, impacted-scenario selection, the
run itself, artifact writing, both baseline mechanisms, the comparison and its refusals, the
[Markdown pull-request report](#the-pull-request-report), the [trend report](#the-trend-report),
and `baseline update` are complete and tested. Deliberately not here yet:

- **No gate, and the flag for it is refused rather than accepted.** Passing
  `--fail-on-regression` to `run` exits `70` and says what the gate will do and that it is not
  here; `trend` does not declare the option at all. A regression is reported, not enforced. Exit
  codes `10`–`19` stay reserved so the gate can be added without renumbering. **Leaving the gate
  unimplemented is the deliberate decision (ADR 0004) — gating before the reports are trusted
  teaches people to bypass the harness. Accepting the flag was the defect**: a CI step that passes
  it and goes green teaches its author that a regression would have stopped the build, and a
  reservation written in a README never reaches that person. A *refused* comparison or a refused
  trend is a different thing and is already non-zero (`4`) — that is not the gate, it is the
  refusal to pretend an analysis happened.
- **No selection record in the artifact.** The engine's `SuiteResult` can now carry one —
  `selectionDecisions`, optional and absent when unset — but **this tool does not write it yet**,
  so every artifact it produces still carries the scenarios that ran and nothing about the ones
  that did not. That is why the trend can tell "selected but ungradeable" from a hole and cannot
  tell the three causes of a hole apart. The limit is unchanged; what changed is that closing it
  is now a change to this tool rather than to the engine's schema. The report states the limit
  rather than guessing past it.
- **No posting.** The tool writes a file and CI attaches it. That is settled, not pending: a
  GitHub API client here would need a token, a network, and a host, and would stop the harness
  working anywhere else.
- **The Markdown's `not comparable` section is unreachable from `run`.** It renders correctly and
  is tested, but `run` refuses the whole invocation (`4`) when *any* pair comes back
  `not-comparable`, so no report is written in the only case that would populate it. The section
  exists because `ComparisonResult` can carry the classification and because a future reporting
  path — `baseline update`, or a report written alongside a refusal — would.
- **No MCP or UI runner.** The engine's `NotImplementedMcpRunner` and `NotImplementedUiRunner` are
  registered, so a mixed suite still routes and the gap is recorded as a harness failure.
- **One built-in exchange shape, and no credentials.** `json` is the only adapter this build has,
  it carries no conversation history, and the tool sends no authentication of any kind. A system
  with another shape, or any system that needs a token, needs an adapter of its own. A live
  baseline therefore reaches unauthenticated systems only.
- **No `baseline` subcommand other than `update`.** There is no `baseline show` or `baseline diff`;
  `run --baseline` already reports the diff.
- **No typo correction on a mistyped flag.** `System.CommandLine`'s `UseTypoCorrections` writes its
  suggestions to stdout with no way to redirect them, which would break the output contract, so it
  is left off.

Two upstream behaviours are load-bearing rather than incidental, and are documented above so they
are not mistaken for defects: a baseline predating `DefinitionFingerprint` compares as
`not-comparable` and must be **regenerated, never hand-edited**; and a live baseline address that
selects a deployment by query string is **refused**, because redaction makes two such addresses
indistinguishable in the artifact.

## Build and test

```powershell
dotnet build tools/EvalCli/src/Forge.EvalCli.csproj
dotnet test tools/EvalCli/tests/Forge.EvalCli.Tests.csproj
```
