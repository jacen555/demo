/**
 * How the bounded no-go scan ENDED, classified and reported as the ending that happened.
 *
 * This lives in its own module for one reason: so it can be imported and tested without
 * running the validator. The alternative was exporting it from validate-scene.mjs behind
 * an "am I the entry point?" guard. That guard compares path strings, and review found it
 * can be defeated by a symlink or junction whose spelling differs from the resolved real
 * path -- in which case the CLI silently does not run and the process exits 0 with no
 * report. A guard failure that looks exactly like a clean pass is the worst available
 * outcome for a validator, and this repo has junctions in play. A separate module has no
 * guard to get wrong.
 *
 * THE RULE THIS FILE EXISTS TO HOLD: a timeout bounds cost, it does not establish cause.
 * Report the ending that is evidenced and name candidates with an action; never assert a
 * cause nobody measured. Stated for this engine's guards at envelope-ducking.mjs:418-420:
 * "a guard that invents a cause is worse than one that reports a difference."
 */
import { CliError } from './cli-support.mjs';
/**
 * Decides HOW the scan child ended and refuses with the ending that actually happened.
 * Throws a CliError for every ending this stage cannot use; returns for a clean one.
 *
 * Separated from the spawn so the endings can be tested without one. The case that most
 * needs testing — an external kill, which arrives as a signal and no error — cannot be
 * produced from a harness without polling the process table for a grandchild and racing
 * to kill it, and a load-sensitive test is exactly the shape this domain removed. The
 * decision needs no process, so it is tested directly.
 */
export function classifyScanOutcome(result, budget) {
  // ORDER MATTERS. `maxBuffer` overflow sets error.code ENOBUFS and ALSO kills the child,
  // so it arrives with a signal set. Testing `result.signal` first reported a buffer
  // overflow as catastrophic backtracking and blamed whichever pattern happened to be
  // running — a confident, specific, wrong diagnosis, which is worse than a vague one
  // because it sends the author to rewrite an innocent pattern. Classify by error code
  // first, and reserve the timeout story for an actual timeout.
  if (result.error && result.error.code !== 'ETIMEDOUT') {
    throw new CliError(`the no-go scan could not run: ${result.error.code ?? result.error.message}`);
  }
  // ...and a THIRD time, in the same shape, caught in review. This branch was
  // `ETIMEDOUT || result.signal`, so a child stopped by any signal was told its budget
  // was exceeded. For a timeout that is measured; for an external SIGKILL — an operator,
  // an OOM killer, a CI harness reaping the tree — it is a sentence about a clock nobody
  // read. Same error as the two above: a STOPPED operation reported as a DIAGNOSED one.
  // The signal is the only fact available here, so it is the only thing stated.
  if (!result.error && result.signal) {
    throw new CliError(
      `the no-go scan was stopped by ${result.signal} before it finished. This stage did not ` +
        `stop it: it did not report a timeout against its ${budget.variable} budget of ` +
        `${budget.ms} ms, so nothing here measured how long the scan ran or what it cost, and ` +
        `nothing here can tell you why it was killed. Look for whatever sent the signal — an ` +
        `out-of-memory killer, a CI step timeout reaping the process tree, or a manual kill — ` +
        `and run again once it is gone.`,
    );
  }
  if (result.error?.code === 'ETIMEDOUT') {
    // ...and then, for a release, this branch committed that same error in a new
    // direction. It read "stopped at the budget" as PROOF of catastrophic backtracking
    // and told the author to rewrite the named pattern. That is a property of the
    // MACHINE being asserted as a property of the PATTERN. A timeout bounds cost; it
    // does not establish cause. The accusation was falsifiable and false: this repo's
    // own fixture names `SAP path` — a literal, with no quantifier and no alternation,
    // structurally incapable of backtracking — and innocent scans were measured crossing
    // the budget from CPU contention alone under a 12-worker load.
    //
    // So report the measurement and leave the conclusion to the reader, as this engine's
    // other guards already do (envelope-ducking.mjs:418-420: "a guard that invents a
    // cause is worse than one that reports a difference"). Both causes get named, and
    // each gets an action, because a bound with no remedy is just a wall.
    //
    // The LAST marker, not the first. The child's stderr is a running log — `scanning 0`,
    // `scanning 1`, ... — so `exec` returns index 0 every time and the refusal names an
    // innocent pattern with complete confidence. Measured: a stall on pattern 1 was
    // reported as pattern 0.
    //
    // And the marker says REACHED, not `was executing`. validate-scene.mjs writes it
    // BEFORE running the pattern, and the loop is followed by unmarked work — building
    // the findings strings, JSON.stringify, console.log. A child that finished the last
    // pattern and was stopped while serialising produces exactly the same final marker.
    // So naming that index as where execution WAS is the same unmeasured-cause error this
    // branch exists to correct, pointed one step further in. It is the last position the
    // scan reported, and that is all it is.
    const started = [...(result.stderr ?? '').matchAll(/^scanning (\d+)$/gm)].at(-1);
    const where = started
      ? `The last position it reported reaching was project.noGoPatterns[${started[1]}]; it ` +
        `may have been in that pattern, or past it and finishing up`
      : 'It was stopped before it reported reaching any pattern';
    const { variable } = budget;
    throw new CliError(
      `the no-go scan did not finish within ${budget.ms} ms and was stopped. ${where}.\n` +
        `\n` +
        `THAT IS THE LAST POSITION REPORTED, NOT WHERE IT STOPPED OR WHY. This stage cannot ` +
        `tell the two causes apart, so it names both rather than picking one:\n` +
        `  - the machine was too busy for the budget — likely if the scan normally passes ` +
        `here, or if a build, a render or a parallel test run was in flight. Raise it: ` +
        `set ${variable} to a larger number of milliseconds and run again.\n` +
        `  - a pattern is genuinely expensive — likely if it stops at the same index on an ` +
        `idle machine with the budget raised. Read that pattern in the source file and look ` +
        `for a repeated group whose body can match the same text in more than one way, such ` +
        `as "(a|aa){30}$" or "(a+)+$". On text that ultimately does NOT match, the engine can ` +
        `be forced to try every combination, and the number of combinations grows with the ` +
        `repeat count far faster than the text does.\n` +
        `\n` +
        `The scan is not left unbounded either way: this stage exists to be cheap.`,
    );
  }
}
