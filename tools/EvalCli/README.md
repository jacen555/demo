# EvalCli

> **Kind:** `tool` · **Tier:** 2 · **Registry id:** `eval-cli`

## What this is

The command-line front end for [`libs/EvalEngine`](../../libs/EvalEngine) (`eval-engine`). It
runs an evaluation suite against a system under test, compares the result against a committed
baseline, and reports what changed — the evidence you attach to a pull request to show whether a
change made things better or worse.

Today it is the **skeleton**: the composition root, the argument surface, the exit-code contract,
`--help`, and `--dry-run`. It wires every seam the engine leaves open — clock, seed source,
runners, participant factory, assertion registry, significance test, logger — and prints exactly
what a run *would* do. Executing a suite, selecting by impacted files, writing artifacts, and
reporting arrive next.

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
| `--endpoint <url>` | none | The address recorded in the artifact. Credentials in the URL are refused; everything after the host — path, query, and fragment — is redacted from all output. |
| `--dry-run` | off | Print the planned run and execute nothing. |
| `--json` | off | Emit the result as JSON on stdout. |
| `--fail-on-regression` | off | **Reserved.** Parsed and reported; this build is report-only and the flag changes nothing. |
| `--verbose`, `-v` | off | Debug diagnostics on stderr. |

### Safety

- **The default invocation writes nothing and mutates nothing.** There is no flag combination in
  this build that deletes anything.
- The only write the argument surface can cause is `--out`, and an existing file there is refused
  unless `--overwrite` is passed as well.
- Every path argument is canonicalized and refused if it resolves outside `--root`. Staying inside
  the root as *text* is not the same as staying inside it on *disk*, so `--out` is additionally
  refused when any segment below the root is a symlink or junction — a link inside the root can
  point anywhere on the machine. (For paths the tool reads, `SuiteLoader` applies the engine's
  link-aware check at the moment the file is opened.) The root itself may be a link: it is the
  boundary you declared.
- Updating a committed baseline — the one genuinely destructive thing this tool will ever do —
  will arrive as its own `baseline` command with its own explicit opt-in, so no invocation that is
  safe today can become destructive later.
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
| `1` | The invocation was refused — bad argument, value, or path. |
| `2` | The suite could not be loaded or did not validate. |
| `3` | The run could not complete. |
| `4` | Baseline and candidate were not conducted alike, so the comparison was refused. |
| `5` | A baseline was required and none was found. *(No baseline is not the same as no regression.)* |
| `10`–`19` | **Reserved for the gate.** `10` is "regressions found"; nothing produces it yet. |
| `70` | The requested operation is not wired up in this build. |
| `71` | An unhandled internal failure — a defect in this tool. |
| `130` | Interrupted (Ctrl+C). Partial state; nothing was written. |

`0` means *the run completed and nothing asked for a non-zero exit*. It never means "the tool
finished printing." Running a suite without `--dry-run` currently exits `70`, because nothing ran
and nothing that did not run may report that it passed.

## Current state

**`partial` — the CLI skeleton (T12).** The composition root, argument parsing and validation, the
exit-code contract, `--help`, `--dry-run`, and `--json` are complete and tested. Deliberately not
here yet:

- **No suite execution.** `run` without `--dry-run` exits `70`. Loading, selecting, running, and
  writing the artifact land next.
- **No REST or LLM runner.** Both need an `IRestExchange` / `IConversationExchange`, which are
  properties of the system under test and belong to the composition root. The dry run names both
  gaps rather than omitting them. The engine's `NotImplementedMcpRunner` and
  `NotImplementedUiRunner` are registered, so a mixed suite still routes.
- **No comparison and no baseline resolution.** `SuiteComparator` is wired and resolvable;
  nothing calls it.
- **No gate.** `--fail-on-regression` is parsed, documented, and reported, and changes nothing.
  Exit codes `10`–`19` are reserved so it can be added without renumbering.
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
