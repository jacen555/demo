# EvalCli

> **Kind:** `tool` · **Tier:** 2 · **Registry id:** `eval-cli`

## What this is

The command-line front end for [`libs/EvalEngine`](../../libs/EvalEngine) (`eval-engine`). It
runs an evaluation suite against a system under test, compares the result against a committed
baseline, and reports what changed — the evidence you attach to a pull request to show whether a
change made things better or worse.

Today it **runs a suite**: it loads and validates the suite file, works out which scenarios a
change actually impacts, conducts them, writes the artifact, and reports what ran and why. It
wires every seam the engine leaves open — clock, seed source, runners, participant factory,
assertion registry, significance test, logger — and `--dry-run` still prints exactly what a run
*would* do without executing anything. Comparing a candidate against a baseline, and the gate that
turns a regression into a non-zero exit, arrive next.

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
```

Machine-readable, for a CI step:

```powershell
dotnet run --project tools/EvalCli/src -- run --suite eval-suites/regression.json --root . --dry-run --json
```

Full help, which leads with the safe path and ends with the exit-code table:

```powershell
dotnet run --project tools/EvalCli/src -- --help
```

### Options

| Option | Default | What it does |
|---|---|---|
| `--suite <path>` | **required** | The suite definition, resolved relative to `--root`. |
| `--root <dir>` | working directory | The boundary. Every other path must resolve inside it or it is refused. |
| `--baseline <path>` | none | A committed baseline artifact to compare against. Read only; never modified. |
| `--out <path>` | none | Where the run artifact would be written. **Omit it and nothing is written at all.** |
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
- The only write is `--out`, and an existing file there is refused unless `--overwrite` is passed
  as well. The refusal happens before anything runs, so it costs nothing and leaves the file
  exactly as it was.
- **The artifact is never written through a truncating open.** A run takes as long as the system
  under test does, so a destination validated before it started is evidence about a directory tree
  that has had minutes to change — a directory swapped for a link in between would redirect the
  write, and no file mode defends against that, because the mode governs the leaf while what moved
  was the path to it. The destination is therefore re-checked at the moment of the write, the
  artifact is staged under a `.partial` name that `CreateNew` creates or refuses, the path it
  actually landed on is verified again with the file in hand, and only then is it renamed into
  place. A rename replaces the destination entry itself rather than following a link through it,
  and without `--overwrite` it refuses an occupied destination atomically. What is left is the
  interval between the last check and the rename, which no portable .NET API can close; the worst
  it can do is leave a new file somewhere unintended, never destroy one that was there.
- Every path argument is resolved through the engine's `PathBoundary` and refused if it leaves
  `--root` — checked on the text before any I/O, then again on the path links actually lead to, so
  a junction inside the root pointing elsewhere on the machine is caught rather than trusted. That
  containment rule has exactly one implementation, in the engine; this tool does not carry a second
  one. `--out` is held to a stricter rule on top of it and is refused when *any* segment below the
  root is a link, because nothing downstream re-checks where a write lands. The root itself may be
  a link: it is the boundary you declared, and the resolved location is what gets reported.
- Updating a committed baseline — the one genuinely destructive thing this tool will ever do —
  will arrive as its own `baseline` command with its own explicit opt-in, so no invocation that is
  safe today can become destructive later.
- **`git` is invoked with an argument array, never a concatenated command line**, and never
  through a shell. `--changed-since` is validated as well, and `--end-of-options` stands between
  its value and git's own option parser, so a value beginning with `-` cannot become a flag.
- **Credentials never belong on the command line.** `--endpoint` refuses a URL carrying userinfo,
  and its path, query string, and fragment are stripped from everything printed, logged, or
  recorded — a key is as much at home in a path segment as in a query parameter, and neither can
  be told apart from ordinary routing by inspection. What survives is scheme, host, and a
  non-default port, which is what identifies the environment.
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
| `3` | The run could not complete — at least one run was recorded as an error, or the artifact could not be written. |
| `4` | Baseline and candidate were not conducted alike, so the comparison was refused. |
| `5` | A baseline was required and none was found. *(No baseline is not the same as no regression.)* |
| `10`–`19` | **Reserved for the gate.** `10` is "regressions found"; nothing produces it yet. |
| `70` | The requested operation is not wired up in this build. |
| `71` | An unhandled internal failure — a defect in this tool. |
| `130` | Interrupted (Ctrl+C). Partial state; nothing was written. |

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

`5` is wired but is only reachable on a race: `--baseline` is checked for existence while the
arguments are validated, so the artifact can only be absent by the time it is read if something
removed it in between. It is there so that case cannot silently widen the selection instead.

## Current state

**`partial` — the suite runs (T13).** Argument parsing and validation, the exit-code contract,
`--help`, `--dry-run`, `--json`, suite discovery and validation, impacted-scenario selection, the
run itself, and artifact writing are complete and tested. Deliberately not here yet:

- **No comparison and no baseline verdict.** `SuiteComparator` is wired and resolvable; nothing
  calls it. `--baseline` is read, but only as an input to *selection* — it decides which scenarios
  there is trustworthy evidence to skip. Comparing a candidate against it lands next.
- **No gate.** `--fail-on-regression` is parsed, documented, and reported, and changes nothing.
  Exit codes `10`–`19` are reserved so it can be added without renumbering.
- **No MCP or UI runner.** The engine's `NotImplementedMcpRunner` and `NotImplementedUiRunner` are
  registered, so a mixed suite still routes and the gap is recorded as a harness failure.
- **One built-in exchange shape, and no credentials.** `json` is the only adapter this build has,
  it carries no conversation history, and the tool sends no authentication of any kind. A system
  with another shape, or any system that needs a token, needs an adapter of its own.
- **No typo correction on a mistyped flag.** `System.CommandLine`'s `UseTypoCorrections` writes its
  suggestions to stdout with no way to redirect them, which would break the output contract, so it
  is left off.

When comparison arrives: baseline artifacts written before the engine gained
`DefinitionFingerprint` will compare as `NotComparable`. That is correct — the two runs genuinely
were not conducted alike. The instruction to a user in that case is to **regenerate** the baseline,
never to hand-edit it.

## Build and test

```powershell
dotnet build tools/EvalCli/src/Forge.EvalCli.csproj
dotnet test tools/EvalCli/tests/Forge.EvalCli.Tests.csproj
```
