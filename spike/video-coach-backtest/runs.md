# Runs ledger

Each coach run's report is kept verbatim outside the repository (README, "What git holds").
This file fixes each report by its SHA-256 before any scoring. It also records how the runs
were dispatched, and that record was committed before the first run started.

## Dispatch (fixed before the first run)

- **The coach runs as itself.** `video-coach` was committed after the orchestrating session
  started, so that session cannot dispatch it by name. Instead, each run is its own app
  session:
  - started as the `video-coach` agent on `gpt-6-sol`;
  - in a fresh worktree of the branch that holds the frozen coach and rubric.

  The user chose this on 2026-09-28. The alternative was to send the agent file's text to a
  generic read-only agent, which would wrap the coach in a system prompt nobody has
  audited.
  - Every run uses the same method.
  - r2 pass 1 runs first, as a trial of the method. If it works, it is r2 pass 1's run.
  - The trial fails if the platform cannot start the agent, or if the agent cannot read
    its inputs. In that case the trial is recorded here, and no other run starts until the
    method is settled again.
- **What the coach is told.** The session's first message holds the four dispatch fields
  and nothing else: `PASS`, `RUBRIC`, `INPUT SET` and `AUTHOR-MODEL`.
  - There is no `BRIEF`. Under "What the coach may read", the script's header is the
    brief.
  - The session is not coordinated with the orchestrator, so no reply instructions are
    added to the message.
  - `INPUT SET` lists the files in the protocol's order: `script.md`, `timing.json`,
    `storyboard.html`, the stills in segment order, then `audit.txt`.
  - The message is kept beside the report, and its SHA-256 is recorded below.
- **`AUTHOR-MODEL: claude-opus-5`, measured.** In both demo sessions' logs, every tool call
  and every assistant message that records a model ran on `claude-opus-5`. Neither session
  started a sub-agent.
  - That is 155 of the plan session's 156 messages (`04ef1c2e`), and 948 of the build
    session's 952 (`13752b3b`).
  - The other five messages are empty and record no model.
- **Neutral paths.** Each run's files are copied to a fresh folder,
  `%TEMP%\coach\<8 hex>\`. The rubric sits beside them, and the stills go under `stills\`.
  Before the session starts, every copy is checked against its SHA-256 in `inputs.md`, and
  the rubric against the SHA-256 recorded there.
  - Why: the ledger's paths name the round and the pass, and the rubric's repository path
    names this spike. The extraction removes paths from `audit.txt` for the same reason, so
    that nothing "could tell the coach the round is not live".
  - What paths cannot hide: the rubric's own `[HOUSE]` section, frozen with it, says
    "Intentionally empty until the backtest completes."
- **The void check reads the session log too.**
  - Under the protocol, a run is void if its `FILES READ` goes outside its input set plus
    the rubric.
  - Each run's session log is also read. Every file its read and search tools touched is
    compared with the same set.
  - A touch outside the set voids the run, whether or not `FILES READ` lists it. The
    coach's own instructions say an incomplete list is not recoverable.
  - Listing or searching the run's own folder stays inside the set, because the folder
    holds nothing else.
- **Capture.** The report is the session's last assistant message. It is copied byte for
  byte from the session's event log to `%TEMP%\vcb\runs\<round>-p<pass>.md`.

## Runs

| Run | Round | Pass | Session | Model in log | Report bytes | Report SHA-256 | Prompt SHA-256 | `FILES READ` | Session log | Status |
|---|---|---|---|---|---|---|---|---|---|---|
