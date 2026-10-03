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

### Where the report is, after run 4 (the README's Amendment 9)

Run 4 wrote its report as an assistant message, then called `task_complete` with a
one-sentence summary after an empty autopilot nudge. Amendment 9 replaces item 1 above for
every run: the report is the one text that starts `COACH REPORT` and has a `FILES READ:`
line, whether it is an assistant message or the `task_complete` summary. An empty autopilot
message after the report is not a second prompt.

## Runs

| Run | Round | Pass | Session | Model in log | Report bytes | Report SHA-256 | Prompt SHA-256 | `FILES READ` | Session log | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | r2 | 1 | `eca9b13b` | `gpt-6-sol` | 5361 | `be1673ee48a3eec5997bb1255b849a4ae438315cf7b79812f83b8ca3e947ca09` | `a16865138be021c6c25747d9154c456585979ebb106ddd56720c8c1797831fe1` | inside the set | 11 tool calls, all inside the set | valid |
| 2 | r2 | 2 | `b4b85cc5` | `gpt-6-sol` | 5019 | `b804ce9ce7c8c113fb707e5ff4fa02ae3c7a79a90de7416ca8f510354686cd47` | `d75f77770799fb2697a73b1e1ade93463dbe996e6b36ff3583e7f2ae93ab82bf` | inside the set | 34 tool calls, all inside the set | valid |
| 3 | r6 | 1 | `8172d51f` | `gpt-6-sol` | 4208 | `1e84f655b1f50182a9cfc6991b65e94e421b55fc42f108a49d370f0e95754d64` | `d4c97acb4290974af60b2079749325fb2a9db8ca41568762cb8c2a8865417f44` | inside the set | 7 tool calls, all inside the set | valid |
| 4 | r6 | 2 | `31a5bbed` | `gpt-6-sol` | 5017 | `da1eb3419e520fb3c41d4485cfcfc9224e9377e5d7242f09739ac0b8a0bfc639` | `3f918a6703552e01176a2c3aa8f5955284455fbdb4a1342af0b5c4a6a0582c59` | inside the set | 22 tool calls, all inside the set | valid (Amendment 9) |
| 5 | r7 | 1 | `8c36e980` | `gpt-6-sol` | 3569 | `4560fd16601b387e449cd5ab6f32564d6a440bee9549c5307654e2b5f2f7bd30` | `c94ec4ceb156afb9c3778d22d0210f74ad60669eb3591b908acbbaa51dac34cb` | inside the set | 7 tool calls, all inside the set | valid |
| 6 | r7 | 2 | `63b92b9d` | `gpt-6-sol` | 5234 | `b03cb9c3be39c68bdc9abfce0a5f91d80f0f7355bdabcd8605e557834d4b960c` | `633e90f9107708473b146894e068afb901fafffde35eee139d0fda6f0d64007a` | inside the set | 51 tool calls, all inside the set | valid |
| 7 | r1 | 1 | `b8a9a249` | `gpt-6-sol` | 4757 | `2304de740e76b026688f7e876bf3bddc940583f2a95c071cd1b880c51f442cc9` | `10396fb50326c8be159cc1ef1bafcfd72eb036881bb43e185a593efc0c9d9bf4` | inside the set | 9 tool calls, all inside the set | valid |
| 8 | r1 | 2 | `33afdd68` | `gpt-6-sol` | 4397 | `97f9abdf2e81444c395cc33445a521bc7260e04770415e072a0d36687bbddd45` | `d0f80547b391b4979f7df77d9b36645c0e014c7e1715f5ca9029f95731282bd0` | inside the set | 40 tool calls, all inside the set | valid |

- Every run's staged inputs and rubric still matched their SHA-256s after the run.
- **Run 4:** the report is the assistant message at line 140 of the session's log. Line
  151 is the empty autopilot message. The `task_complete` summary that the rule before
  Amendment 9 would have taken is 198 bytes (`c688426ccd225850dd334feb73022df21ccc2802b843a165969d5af65fb575c6`).
- **Runs 7 and 8** were dispatched before Amendment 9 was committed, and captured after it.
- **Every coach worktree, runs 1–8, was at `7ec4817`,** which does not hold the answer key.
  Each was made from `users/jonosace-microsoft/multi-agent-orchestration`. The local branch
  was ahead of `7ec4817` every time, at `f0e0312`, `2ab965a` and `0cab08a`, and the remote
  branch was at `7ec4817`. So the app evidently makes a worktree from the remote head.
