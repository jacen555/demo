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
  overwrite         refused - an existing artifact at --out would stop the run
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
| `--overwrite` | off | Opt in to replacing an existing file at `--out`. Without it, an existing file stops the run. |
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
- The only write `run` performs is `--out`, and an existing file there is refused unless
  `--overwrite` is passed as well. The refusal happens before anything runs, so it costs nothing
  and leaves the file exactly as it was.
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
| `1` | The invocation was refused — bad argument, value, or path. This includes a `--baseline` that exists but is not a readable run artifact: the invocation named it, and a baseline that cannot be read is not the same as no baseline. |
| `2` | The suite could not be loaded or did not validate — including a suite that declares no scenarios, which is refused before anything runs rather than reported as `0 of 0`. |
| `3` | The run could not complete — at least one run was recorded as an error (including an address that answered with a redirect), or the artifact could not be written, or the destination stopped being the file the command read. |
| `4` | Baseline and candidate were not conducted alike, so the comparison was refused. Also produced when *any* available pair could not be compared — reported as a refusal rather than as "no regressions found", because those scenarios were not examined. |
| `5` | A baseline was required and none was found — including one that goes away between being read and being replaced. *(No baseline is not the same as no regression.)* |
| `10`–`19` | **Reserved for the gate.** `10` is "regressions found"; nothing produces it yet. |
| `70` | The requested operation is not wired up in this build. |
| `71` | An unhandled internal failure — a defect in this tool. |
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

**`partial` — the suite runs and the comparison reports (T14).** Argument parsing and validation,
the exit-code contract, `--help`, `--dry-run`, `--json`, suite discovery and validation,
impacted-scenario selection, the run itself, artifact writing, both baseline mechanisms, the
comparison and its refusals, and `baseline update` are complete and tested. Deliberately not here
yet:

- **No gate.** `--fail-on-regression` is parsed, documented, and reported, and changes nothing: a
  regression is reported, not enforced. Exit codes `10`–`19` are reserved so the gate can be added
  without renumbering. A *refused* comparison is a different thing and is already non-zero (`4`) —
  that is not the gate, it is the refusal to pretend a comparison happened.
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
