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
- **`--baseline` and `--out` may not name the same file.** Writing a run over the baseline it was
  compared against is a baseline update, and that has its own command and its own opt-in.
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
  scenarios move to `newlyCoveredWithheld` with a reason rather than inflating the headline.
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

## Updating a committed baseline

This is the one genuinely destructive thing this tool does, and it lives in its own command.
**Nothing under `run` replaces a baseline**, so no invocation that is safe today becomes
destructive because an option was added later.

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
| `--out <path>` | none | Where the run artifact would be written. **Omit it and nothing is written at all.** May not be the same file as `--baseline`. |
| `--report-markdown <path>` | none | Where to write the [Markdown comparison report](#the-pull-request-report) for a pull request. Needs a baseline; refused without one. May not be the same file as `--out` or `--baseline`. This tool writes the file and never posts it. |
| `--overwrite` | off | Opt in to replacing an existing file at `--out` or `--report-markdown`. Without it, an existing file stops the run. Never permits replacing `--baseline`. |
| `--seed <n>` | `0` | The root seed. Fixed, not random: a baseline and a candidate must share it for the comparison to be paired. |
| `--max-concurrency <n>` | `1` | Hard ceiling on runs in flight. Load on somebody else's system is opted into. |
| `--max-total-runs <n>` | `100000` | Ceiling on the runs a suite may plan, so a mistyped repetition count is refused rather than executed. |
| `--endpoint <url>` | none | The address the run is directed at, and the address recorded in the artifact. Credentials in the URL are refused; everything after the host — path, query, and fragment — is redacted from all output. |
| `--changed-since <rev>` | none | Read the changed-file set from `git diff <rev>` plus the untracked files, and run only the scenarios it impacts. **Omit it and the whole suite runs**; see [Selection](#selection-is-opt-in). |
| `--rest-exchange <name>` | `none` | Which adapter describes the REST system under test: `none` or `json`. Needs `--endpoint`. See [The built-in JSON contract](#the-built-in-json-contract). |
| `--llm-exchange <name>` | `none` | Which adapter describes the conversational system under test: `none` or `json`. Needs `--endpoint`. |
| `--dry-run` | off | Print the planned run and execute nothing. |
| `--json` | off | Emit the result as JSON on stdout. |
| `--fail-on-regression` | off | **Reserved.** Parsed and reported; this build is report-only and the flag changes nothing. |
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
  runs, so it costs nothing and leaves the file exactly as it was.
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
- **Updating a committed baseline is its own command with its own opt-in.** Nothing under `run`
  replaces a baseline, so no invocation that is safe today becomes destructive because an option
  was added later. Its default is a preview that writes nothing, it never *creates* a baseline, it
  refuses one belonging to another suite, and it refuses to commit a run with errored scenarios.
  See [Updating a committed baseline](#updating-a-committed-baseline).
- **A comparison cannot be made against the wrong pair.** `--endpoint` and `--baseline-endpoint`
  may not name the same address, `--baseline` and `--out` may not name the same file, scenarios
  this run did not conduct are withheld rather than reported as removed, and a pair that could not
  be compared exits non-zero instead of printing "0 regressed".
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
| `3` | The run could not complete — at least one run was recorded as an error (including an address that answered with a redirect), or the artifact could not be written, or the destination stopped being the file the command read. |
| `4` | Baseline and candidate were not conducted alike, so the comparison was refused. Also produced when *any* available pair could not be compared — reported as a refusal rather than as "no regressions found", because those scenarios were not examined. |
| `5` | A baseline was required and none was found — including one that goes away between being read and being replaced. *(No baseline is not the same as no regression.)* |
| `10`–`19` | **Reserved for the gate.** `10` is "regressions found"; nothing produces it yet. |
| `70` | The requested operation is not wired up in this build. |
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

**`partial` — the suite runs, the comparison reports, and the report is attachable (T15a).**
Argument parsing and validation, the exit-code contract, `--help`, `--dry-run`, `--json`, suite
discovery and validation, impacted-scenario selection, the run itself, artifact writing, both
baseline mechanisms, the comparison and its refusals, the [Markdown pull-request
report](#the-pull-request-report), and `baseline update` are complete and tested. Deliberately not
here yet:

- **No gate.** `--fail-on-regression` is parsed, documented, and reported, and changes nothing: a
  regression is reported, not enforced. Exit codes `10`–`19` are reserved so the gate can be added
  without renumbering. A *refused* comparison is a different thing and is already non-zero (`4`) —
  that is not the gate, it is the refusal to pretend a comparison happened.
- **No trend report.** `--report-markdown` renders one comparison. A report across a run of
  comparisons is a separate task.
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
