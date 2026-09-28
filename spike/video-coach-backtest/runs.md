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
    "Intentionally empty until the backtest completes." The agent file's "Status"
    section, frozen with it too, says "A backtest against past review rounds is testing
    whether its BLOCKING findings are good enough to gate a render."
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

### What the trial showed (recorded after run 1, before any other run started)

The trial worked, so it is r2 pass 1's run. The session log showed three things that the
rules above did not say. None of them changes how a run is started.

1. **Where the report is.** In autopilot, the agent ends by calling `task_complete`. Its
   last assistant message is empty.
   - The report is therefore the `summary` of the session's `session.task_complete`
     event.
   - The `task_complete` call's argument holds the same text, and so does the call's
     result. The capture compares the argument with the summary, and flags the run if
     they differ.
   - It replaces "the session's last assistant message" under "Capture". Nothing else
     about the capture changes.
2. **What the platform adds to the message.** The message sent is logged unchanged and
   matches the saved one. The model receives it with four blocks in front:
   - the current date and time;
   - a workspace block: the project and its repository, the session's name
     (`Coach run <n>`), the session's branch and worktree path, the branch it was based
     on, and the orchestrating session's id;
   - a working-context block: the working directory, and the repository's main checkout
     with its branch;
   - an artifacts block: the session's scratch folder, with an instruction to write notes
     there rather than in the repository. The coach has no tool that writes.

   None of these names the round or the backtest. The message itself names the pass, as
   the protocol intends.
   - The session's name says the run is one of a numbered series. That is a weak hint that
     the review is not live. The two frozen lines under "Neutral paths" say far more.
   - Correction: `2ab965a` said two blocks. The log held four; I had not read to the end
     of the prefix.
3. **What the system prompt holds.** Run 1's, as logged:
   - the platform's own instructions, which also list the tools, the repository's skills
     and the app's canvases, and name the session's folder;
   - the repository's custom instructions: the constitution, `copilot-instructions.md` and
     the single-agent workflow. The memory-bank protocol is not among them;
   - one user-level instruction from this machine's own setup, unrelated to the
     repository;
   - the agent file's body, with `$ARGUMENTS` left as literal text.

   "Backtest" appears once in the whole system prompt, in the agent's Status line quoted
   under "Neutral paths". The agent was started as `video-coach` with the tools `read` and
   `search`.

## Runs

| Run | Round | Pass | Session | Model in log | Report bytes | Report SHA-256 | Prompt SHA-256 | `FILES READ` | Session log | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | r2 | 1 | `eca9b13b` | `gpt-6-sol` | 5361 | `be1673ee48a3eec5997bb1255b849a4ae438315cf7b79812f83b8ca3e947ca09` | `a16865138be021c6c25747d9154c456585979ebb106ddd56720c8c1797831fe1` | inside the set | 11 tool calls, all inside the set | valid |
