# spike/video-coach-backtest

> **Spike — Tier 0.** Throwaway experiment. Nothing outside `spike/` may depend on this.
> Excluded from `Forge.sln` by design (constitution section XI).

## The question

> **Would a pre-render content coach, given only a round's pre-render artifacts (script,
> timing, storyboard, stills), have caught at least half of the objective defects the user
> reported across the EvalLoopDemo review rounds, with the user agreeing with at least 4 in
> 5 of its blocking findings?**

Both thresholds were fixed with the user before any coach output existed. Together they
are the bar for letting the coach **block** a render. If either is missed, the coach stays
advisory-only.

## Why a backtest

The review rounds on `tools/EvalLoopDemo` are an answer key that nobody wrote for this
purpose. In each round the user watched a draft and said what was wrong, and the fixes were
committed. Replaying the coach on each round's **pre-fix** inputs measures what it would
have caught, and when. A coach run happens at one of two moments: before TTS (pass 1), or
before frame capture (pass 2).

## Design (decided with the user, 2026-09-28)

| | |
|---|---|
| Coach | `.github/agents/video-coach.agent.md`: read-only and generic. Its knowledge comes only from the rubric named at dispatch, so the agent file never references this spike (§XI) |
| Rubric | `rubric.md` here, written by the built-in `research` agent **blind** to the reference project |
| Authority | Blocks on objective defects and advises on craft. It can block, but it can never approve or waive; only the user waives |
| Pass 1 | The script, before TTS |
| Pass 2 | Script, timing, storyboard, stills and engine audit output, before capture |
| Model | GPT family (`gpt-6-sol`), because the storyboards' author was Claude |
| Lanes | Code goes to the code reviewers, artifact well-formedness to the engine's audits, content to the coach. The coach lists what it did **not** evaluate, and who covers it |

## Protocol — the commit order is the proof

1. **Freeze.** Commit the rubric, the coach and this protocol before the answer key exists.
2. **Inputs.** Extract each round's pre-fix artifacts to a folder outside the repository.
   Commit `inputs.md`, which records where each file came from and its SHA-256.
3. **Answer key.** Draft it from **the user's own review messages**, which are the primary
   source. Each round's review script and commit message are only a cross-check, because
   they are the author's reading of what the user said.
   - Classify every finding as one of:
     - *objective*;
     - *craft*;
     - *not catchable before render*, because it needed listening or a full render;
     - *not in these inputs*, because the defect did not exist yet in the round's pre-fix
       state.
   - The user confirms the key, and it is committed **before any coach run**.
4. **Runs.** Run each round and pass in a fresh agent. Keep its output verbatim, outside
   the repository, and commit its SHA-256 to `runs.md` before any scoring.
   - A run is **void** if its `FILES READ` goes outside its input set plus the rubric.
   - A void run is re-run once. If it is void again, it is reported as void.
5. **Score.** The user matches coach findings to the key. Each unmatched coach finding is
   judged by the user as one of:
   - *valid* (the review missed it), which counts as agreed;
   - *false alarm*;
   - *taste*.

**What git holds** (decided with the user, 2026-09-28):

- **In git:** the learnings. That is the rubric with its brief and provenance record, the
  coach, this protocol, the answer key, the two hash ledgers (`inputs.md`, `runs.md`) and
  the result (`scoring.md`).
- **Not in git:** the extracted inputs, the stills and the coach reports. They are output,
  so they live outside the repository.
- **Why hashes are enough:** each committed hash fixes the output it names before the next
  step exists, which is all the commit order has to prove. What a hash cannot do is keep
  that output available, so the result must not depend on anyone re-reading it later.

### Input sets (fixed before results)

**Which state is "pre-fix".** A round's pre-fix state is the last commit before the round's
first fix commit that changed any input file (`timing.json`, `script.md`,
`storyboard.html`). That is the state the reviewed render was made from.

- The engine comes from the same commit, because engine commits made after it and before
  the fix did not draw the frames the user watched.
  - **That rule was tested, because the commit's engine is itself an inference.** The r4
    and r5 commits were rebased onto later engine work, so their `write-build-html.mjs`
    appears in none of the session's checkpoints. Each round's inputs were built into a
    scene (`video-auto.html`) with every candidate engine: the commit's own, and each
    version the session checkpoints show between the round's previous fix and its review.
  - r4, r5 and r6: every candidate builds a byte-identical scene, so the choice of engine
    cannot change their inputs.
  - r7: the candidates differ. The commit's engine matches checkpoints #35–#40. The version
    in checkpoints #41–#43 adds an outline and a shadow around marked elements that are
    not SVG (`.is-marked`).
  - r7 uses the commit's engine. If the log shows the reviewed r7 render was built after
    the engine changed, r7 is re-extracted with the later engine before any coach run, and
    `inputs.md` records the change.
- The rule gives:

| Round | Pre-fix state | Kind |
|---|---|---|
| r4 | `64f2cff` | commit-backed |
| r5 | `e0e73a8` | commit-backed |
| r6 | `9e20f3c` | commit-backed |
| r6c | `fc8dece`, with the three fields its own script writes restored from `9e20f3c` | reconstructed |
| r7 | `fc8dece` | commit-backed |
| r2, r3 | session checkpoints, chosen by the snapshot rule below | reconstructed |
| r1 | the checkpoint at its review message, identified after the freeze | descriptive only |

- **A round is scored only if the user's own review messages for it can be found** in the
  project's session log.
  - A defect the author found without a user report is not in the key, even if a review
    script fixed it.
  - The log is read for the key only after the freeze.
- **Checkpoint cross-check.** The session takes a checkpoint at each user message.
  `inputs.md` records whether the last checkpoint before a round's fix has the same input
  files as the pre-fix state above. Once the log has been read, it also records the
  checkpoint at the round's review message. A mismatch is disclosed, not silently resolved.

- **Why r6c needs rebuilding.** Round 6 was fixed in three parts, and all three were
  committed together as `fc8dece`. Part 3 ("6c") fixed a defect that parts 1 and 2 had
  introduced, so its pre-fix state never existed as a commit.
  - Parts 1 and 2 never write the three fields that part 3 writes (`loop.visual.subtitle`,
    `loop.visual.note` and `scenario.visual.note`).
  - So the pre-6c values of those fields are their `9e20f3c` values.
  - Any other edit in `fc8dece` is assumed to precede 6c.
  - **r6c may not be scoreable.** No checkpoint, and so no user message, falls between the
    start of round 6's fix and the first state that contains 6c's edits. That suggests the
    author found 6c's defect without a user report. The log decides it under the rule
    above. Its inputs are extracted regardless, so the extraction cannot depend on the key.
    - *Not extracted after all, under "Amendments", item 1: see "Amendment 6", item 1.*
- **How a reconstructed checkpoint round is chosen.** Its pre-fix state is the latest
  snapshot that contains none of that round's scripted edits, provided the next snapshot
  contains them. The check is recorded in `inputs.md`.
- **Why r1 is descriptive only.** Round 1 has no review script, so the snapshot rule has no
  edits to test. Its pre-fix state is instead the checkpoint taken at the user's round-1
  review message. That message can only be identified by reading the log, so r1's inputs
  are chosen after the answer key exists. r1 is reported on its own and counts toward
  neither bar.
- **Regenerated files.** Where a reconstructed round needs `script.md` or
  `storyboard.html`, they are regenerated with that commit's own generators. The generators
  must first reproduce the committed files byte for byte from the committed `timing.json`.
  - *Amended before the first reconstructed extraction: see "Amendments", items 1 and 4.*

**What the coach may read.**

| Pass | The coach may read |
|---|---|
| 1 | `script.md`. Its header carries the audience and a one-sentence thesis, and serves as the brief |
| 2 | `script.md`, `timing.json`, `storyboard.html`, the stills, and `audit.txt` |

- **Stills.** These are the engine's own pre-capture preview (`preview.mjs`): one frame per
  segment at 86 % of its window, where "everything is revealed". Nobody who knows where the
  defects are chose these frames.
  - The end-card frame is dropped when the project has no end card. `preview.mjs` then
    seeks to `NaN`, so the image shows no real moment of the video. This is an engine
    defect, recorded separately.
  - **One camera for every round.** Every still is taken with `preview.mjs` blob
    `c5f34dd8`, which is the version at all four commit-backed pre-fix states. It runs
    from each round's own project folder, which is its default `--project`, so it shoots
    that round's scene.
    - A checkpoint round whose scene lacks the seek hook the camera uses
      (`window.masterTimeline`) would give eight stills of the same moment. That round gets
      pass 1 only.
    - *Amended before the first reconstructed extraction: see "Amendments", items 2 and 3.*
  - **Deterministic to the eye, not to the byte.** Two runs on the r7 scene matched byte
    for byte on 6 of 8 stills.
    - `hard.png` differed on 721 pixels, by at most 13/255 in any channel.
    - `scenario.png` differed on 0.86 % of pixels, by at most 6/255.
    - `inputs.md` records each still's SHA-256, so a re-render is compared by pixel
      difference rather than by hash.
  - **Native resolution.** The stills stay at the project's 3840×2160, because they are
    kept out of git and nothing is gained by resizing them. The viewer resizes images
    itself: a 4K still reached the orchestrator's own viewer at 2000×1125.
    - *Recorded after the reconstructed extraction, changing no rule: r3's stills are
      1920×1080. The camera sizes its page from `timing.json`, and r3's state (checkpoint
      #18) sets the project to 1920×1080, as ten of the 43 checkpoints with a timeline
      do. Nothing was resized.*
- **`audit.txt`.** The output and exit codes of the two stages that produce the stills:
  - the scene build (`write-build-html.mjs`);
  - the preview, which runs the engine's layout audit.
  The legibility audit (text size and contrast) runs only during frame capture, which comes
  after pass 2, so it is not included.
  - The output is kept verbatim, except that absolute paths become `<project>`, `<engine>`
    and `<root>`. Where the files were built says nothing about the video, and it could
    tell the coach the round is not live. The extraction stops if a local path or the
    username survives the replacement.
- **Never inputs:**
  - `render-log.md`, the author's history;
  - the project `README.md`;
  - `qc/**`, which holds the review scripts;
  - `knobs.json`, `sync-mapping.md` and the subtitles, which are configuration or derived
    output.
- **A known engine defect is visible in the inputs.** With the end card off, every
  `storyboard.html` shows a `NaN:NaN` duration badge (engine finding C-12), and every
  `audit.txt` shows the camera shooting the end card at `t=NaNs`. That still is dropped;
  the line stays, because the transcript is verbatim. A coach finding about either is
  judged like any other unmatched finding.

### Amendments (2026-09-28, before any reconstructed round was extracted)

Wiring the three reconstructed rounds (r6c, r2, r3) turned up five cases that the rules
above do not settle. Each is decided here and committed before the extraction has run on
any of them, and `inputs.md` records how each applied. The two reconstruction methods in
`src/reconstruct.mjs` behave as committed in `921b2d8`: the only change to them moves the
review script's first error line into a helper.

1. **A checkpoint's generated files can be stale.** `script.md` and `storyboard.html` often
   keep one blob across checkpoints whose `timing.json` differs. So a checkpoint's copy may
   not be what its own generators make from its own timeline.
   - A reconstructed round therefore always uses `script.md` and `storyboard.html`
     regenerated from its own `timing.json`, by the generators at its own state.
   - Each generator is proven first at the state: from the state's committed data files,
     it must reproduce the state's committed file byte for byte.
   - For a snapshot round whose file fails that, the proof falls back to the latest earlier
     checkpoint whose file the same generator reproduces from that checkpoint's data
     files. The generator stays the round's; only the data are older.
     - *Extended to any round whose state is a session checkpoint: see "Amendment 8".*
   - With no proven `script.md`, the round is not extracted. With no proven
     `storyboard.html`, it gets pass 1 only.
   - A generated file that names the folder it was made in counts as a failed run.
2. **The camera's files.** The camera, `preview.mjs` `c5f34dd8`, imports `cli-support.mjs`
   and `canonical-json.mjs` from beside it.
   - Checkpoints before #20 have an older `preview.mjs` (`1aa7b03f`) and no
     `cli-support.mjs`. Those from #20 to #29 have the camera but an older
     `cli-support.mjs`. Every checkpoint has the camera's `canonical-json.mjs`.
   - Where the engine's `src/` differs from the camera's three files (`CAMERA_FILES` in
     `src/lib.mjs`), each file that differs is written over it **after** the round's own
     scene build. The build stays the round's, and the stills are the one camera's.
   - The camera then runs with the same command as in every other round, so `audit.txt`
     has the same shape.
   - `inputs.md` records each file given and what the engine had.
3. **The seek-hook check is static.** Whether a scene "lacks the seek hook" is decided by
   matching `/window\.masterTimeline\s*=/` against the built `video-auto.html`. Without a
   match, the camera is not run and the round gets pass 1 only.
4. **What the generators read.** "Regenerated files" says the proof is from the committed
   `timing.json`. Every version of both generators was read, in all 44 checkpoints and on
   the lineage:
   - `write-script.mjs` (two versions) also reads `calibration-observed.json`, and its
     later version reads `silence-observed.json`, each only where present;
   - `write-storyboard.mjs` (three versions) reads only `timing.json`.

   So the proof uses the state's committed copies of all three data files, and the
   regeneration uses them with `timing.json` replaced by the round's own. A data file
   absent from the state is absent from the run.
5. **A missing lockfile stops the round.** Checkpoints #1–#4 have no project
   `package-lock.json`, and #1–#2 have no engine one. A state without both stops the
   extraction with an error. `npm install` is never used instead, because it would resolve
   today's versions, not the round's.

### Amendment 6 (2026-09-28, after the first plan run of the reconstructed rounds)

The first plan run of r6c, r2 and r3 applied items 1–5 as written, and they are unchanged.
This amendment was written after that run, and before any reconstructed round was
extracted, before the answer key existed, and before any coach run. It adds no rule. It
records one outcome of item 1, applies item 1's test to the commit-backed rounds, and
changes how the code records an exclusion.

1. **r6c is not extracted, under item 1.** Its method holds. But neither generator is
   proven at its state (`fc8dece`), and item 1's fallback to an earlier checkpoint is for
   snapshot rounds only. With no proven `script.md`, r6c is not extracted. It has no coach
   run and is not scored. So "its inputs are extracted regardless" (under "Why r6c needs
   rebuilding") does not happen. What that sentence protected still holds: the rule that
   leaves r6c out was committed before the key existed.
   - **Why the proof fails.** `fc8dece`'s own `script.md` (`663d1142`) is stale. At that
     state, `qc/record-silence.mjs` had rewritten `silence-observed.json` in a new shape.
     The new shape lacks the fields `write-script.mjs` (`0bfacee4`) reads: `leadIn.targetMs`,
     `leadIn.decodedMs`, and the gaps' `decodedMinMs`, `decodedMaxMs` and `targetMs`. So
     the generator writes `NaN` five times into the "Measured pacing" line, where the
     committed file has numbers.
   - With `silence-observed.json` from `64f2cff` in its place, the state's generator and
     other data files reproduce `663d1142` byte for byte. The narration is not stale; only
     that line is.
   - **No fallback is added.** A fallback for restore-fields rounds, written now, would be
     post hoc. It would not help either: a proven generator run on the state's own data
     would still write the `NaN` line into r6c's `script.md`.
   - **What changed in the code.** `extract-inputs.mjs` used to stop the whole run when any
     round did not hold. A reconstructed round that does not hold now leaves a record,
     `not-extracted.json`, in place of a manifest, and `write-ledger.mjs` reports it. A
     commit-backed round that does not hold still stops the run, and so does a missing
     lockfile (item 5). This changes how an exclusion is recorded, not which rounds are
     excluded.
2. **The commit-backed rounds, given the same test.** Item 1 proves a generator before a
   reconstructed round uses what it makes. The commit-backed rounds use their committed
   files and never had that check. `src/check-freshness.mjs` now applies it:
   - at each pre-fix state, both generators run on the state's own committed data files,
     and what they make is compared with the committed file;
   - where a file is not reproduced, each single change to the data is tried: another
     version of one data file, an observed file removed, or a reconstructed round's
     rebuilt timeline on the same commit;
   - `inputs.md` records the result, under "Freshness of the commit-backed rounds".

   What it found:
   - **r4, r5 and r6:** both files reproduce.
   - **r7 `script.md`:** stale in the pacing line only, for the reason in item 1. Three
     older versions of `silence-observed.json` reproduce it byte for byte, one from
     `64f2cff` and two from checkpoints. So r7's pacing line reports an earlier render's
     measurements.
   - **r7 `storyboard.html`:** stale in two lines.
     - It shows the `loop` subtitle from before 6c, its `9e20f3c` value ("Every headline
       number said better. One line said less safe."). `fc8dece`'s timeline has 6c's
       fix: "A regression shows up in the same report, on the same run."
     - It has a claim, `c-caveat`, that `fc8dece`'s timeline does not.
     - No single change tried reproduces it. The closest is r6c's rebuilt timeline, which
       leaves only the `c-caveat` claim.
   - **The r7 inputs stay the committed files** the author reviewed with. So r7's pass-2
     storyboard shows a subtitle that 6c had already replaced in its own timeline, and so
     in its stills. A coach finding about either stale file is judged like any other
     unmatched finding, as with C-12.
3. **r6c's reconstruction is corroborated, not scored.** Between checkpoints #34 and #35, a
   storyboard was made from a timeline that no commit or checkpoint holds. It was not made
   again before `fc8dece`, so it is r7's.
   - That storyboard corroborates the subtitle r6c restores. The storyboard renders no
     `note`, so it says nothing about r6c's other two fields.
   - Apart from `c-caveat`, it also corroborates the assumption that every other edit in
     `fc8dece` precedes 6c.
   - Whether `c-caveat` was removed before or after 6c cannot be settled from the
     repository.
   - None of this makes r6c scoreable. It has no input set.

### Amendment 7 (2026-09-28, after reading the logs, before the answer key)

Step 3 reads the session logs for the key. This amendment was written after that reading,
and before any key entry was drafted and before any coach run. It records what the logs
show about sources and states, and one decision the user made about what is scored. It
changes which rounds are run, so each change says why.

1. **Where the user's own words are.** The user reviewed the video in the plan session
   ("Eval loop demo plan", `04ef1c2e`), which relayed each review to the build session
   (`13752b3b`).
   - The key's primary source is the plan log's user messages that the user typed: 21 of
     its 26, the rest being relays or notifications. They are cited as P1–P26, by their
     order among the log's user messages, with their line in the log.
   - `ask_user` answers in either log are also the user's own words. There are 13.
   - The build log holds none of the user's reviews. Its user messages are relays from the
     plan session, or short commands. A relay is the plan session's reading of the user,
     so, like a review script or a commit message, it is only a cross-check.
2. **What a checkpoint is.** Checkpoint #k is committed between 0.06 s before and 2.2 s
   after the build session's user message #k, and always before message #k+1. So it is
   the state as message #k arrived, before the agent acted on it. All 44 were measured;
   the three that precede their message do so by milliseconds.
3. **What the user watched.** Each review answers one render. The build log gives each
   render's command, and every file changed between the render and the checkpoint named
   below.

   | Render (UTC; build-log line) | Frame | State it was built from | Reviewed in | Fixed by |
   |---|---|---|---|---|
   | 09-25 02:55:05; L1860 | 1920×1080 | Checkpoints #5–#7, whose inputs are identical. Between the render and #5, no input or scene-engine file changed: only the render log, the skill's bug ledger, the audio stages and their output, `.gitignore`, the project README and the memory bank | P8, with P9, P13, P15 and P16 | r1 |
   | 09-25 23:04:52; L3227 | 3840×2160 | #16. Between the render and #16, only the render log, `knobs.json`, the bug ledger and the audio output changed. The scene build reads none of them, and none is an input | P20, and the answer at plan L1411 | r2, r3, r4 |
   | 09-26 17:20:38; L6035 | 3840×2160 | #27. The scene was built at L5989, after `apply-review-5`. Between the render and #27, only the render log, the audio output, the subtitles and the chapters changed. Neither subtitle nor chapter stage writes `timing.json` | P21 | r6 (and 6c) |
   | 09-26 22:56:00; L7859 | 3840×2160 | #36, which is `fc8dece`. The command rebuilt the scene, and nothing changed between #36 and it | P26; P24, on the audio | r7 |

   - No command in these windows checks out, merges, resets or restores files with git.
   - Nobody watched a render of r3's or r4's pre-fix state. Each already holds the fixes
     made before it for P20.
   - r5's pre-fix state was rendered as a draft, and the user chose not to watch it: build
     L5926, answered at 17:17 on 09-26, "Fix `many`'s pacing first, then run the 4K render
     (Recommended)" over "Hold — I want to watch the draft first".
   - P4 (01:29 on 09-25) is feedback on the script before the first render, so it falls
     in no round. There, the user acted once as the kind of pre-render reviewer this spike
     tests.
4. **One key per reviewed render.** This is the user's decision. Rounds r2, r3 and r4 fix
   one review, P20, in three batches. Asked how to key that, the user chose: *"One review,
   one key: score P20 once, on r2's input. r3 and r4 aren't run. The pass/fail bar is then
   decided by r6 and r7, with P20 reported alongside as reconstructed."*
   - P20 is keyed once, and scored on r2's input set, which is the state the user watched
     (item 6).
   - r3 and r4 are not run and not scored. Their input sets stay in `inputs.md`.
   - Rejected: a key per fix batch, which triples P20's weight in precision and scores
     states nobody watched; and a key per round covering all of P20, which counts each of
     P20's defects up to three times in recall.
   - "The commit-backed result governs" is unchanged. The commit-backed rounds scored are
     now r6 and r7, and r2 is the only reconstructed one. Two renders is a small base, so
     the result gives the counts behind every rate.
5. **r5 is not run and not scored.** Its defect is that segment 4's diagrams ran about
   5.5 s ahead of the narration describing them. r2 created it, by moving those diagrams
   earlier for P20 (`apply-review-2.mjs` sets their times), and the author's own canary
   found it (`apply-review-5.mjs`, header). No user message reports it, so the frozen
   rule already leaves it out of the key.
6. **r2's input set is the state P20 watched.** The snapshot rule chose checkpoint #17.
   - #17 differs from #16, the render's state, in two files. `write-build-html.mjs` gains
     a per-visual `arrowSize` option, whose default emits the old markup, and r2's timeline
     sets no `arrowSize`. `qc/apply-review-2.mjs` is created, but has not run.
   - Measured: #16's engine and #17's engine each build a scene byte-identical to r2's
     extracted `video-auto.html` (SHA-256 `278a7a08c39514d3…`, 154,607 bytes).
   - r2's `script.md` and `storyboard.html` are regenerated, as "Amendments" item 1
     requires. #16's own copies were made from #15's timeline.
7. **r6's input set differs from its render's state by two fields.** The render's timeline
   is #27's. r6's, at `9e20f3c`, adds `project.noGoPatterns` and `timingHash`, and changes
   nothing else.
   - The engine at `9e20f3c` reads `noGoPatterns` only as a guard that can refuse a build.
     `timingHash` is written by the voice and remix stages, and read by `cli-support.mjs`.
   - Measured: #27's timeline with #27's engine, and r6's timeline with `9e20f3c`'s
     engine, each build a scene byte-identical to r6's extracted one (SHA-256
     `c2c911746ac7b91c…`, 160,984 bytes).
   - Pass 2's `timing.json` shows the coach both fields. Neither describes the video.
8. **r7 keeps its commit's engine.** Its render was built at #36, before the engine that
   adds `.is-marked` (first in #41). So, under "Input sets", r7 is not re-extracted.
   - P24, "the background music needs to be a bit quieter", answers the same render: the
     relay calls it feedback "after listening to the 4K cut". It is keyed under r7 with
     P26.
9. **r1's state is checkpoint #7,** taken at the relay of P8 (build message #7). Its
   inputs are also #5's and #6's, and the render's (item 3).
   - It is extracted after the key, under "Amendments" item 1, so its `script.md` and
     `storyboard.html` are regenerated.
   - Its key comes from P8, P9, P13, P15 and P16, and from the three `ask_user` answers
     in the same window (plan L803, L919 and L1226).
   - The user also edited a copy of the storyboard during that review
     (`storyboard-edit.md`, in the plan session's files). The author edited the same file,
     and the log keeps neither its first version nor a diff, so the user's own edits
     cannot be told apart. They are not used. r1 stays descriptive only.
10. **A fifth class: not about this video.** The reviews also hold requests for things the
    render never attempted (chapters, subtitles), and feedback on the tooling or the
    process (P17, P18, P22, P25, and P21's two "Feedback for the demo generation scripts"
    items). None is a defect of the render reviewed, and none fits the four classes.
    - They are keyed with the class *not about this video*.
    - Like the classes other than *objective*, it is outside recall's denominator. A coach
      finding the user matches to one counts as agreed, as any match does.
    - The lane table under "Contamination" already says subtitles cannot change a score.
      This does not change that.
11. **The checkpoint at each review message.** This is the record that "Checkpoint
    cross-check" asks for. It is kept here because `inputs.md` is written from the
    extraction, and the review messages are not part of it.

    | Review | Relayed as (build log) | Checkpoint vs the scored input set |
    |---|---|---|
    | P8 (plan L768) | #7, L2298 | r1's state, by the rule for r1 |
    | P20 (plan L1375) | #16, L3422 | Its timeline, script and storyboard are #17's, the state r2 was extracted from. The engine differs only by the inert `arrowSize` option (item 6) |
    | P21 (plan L1441) | #33, L6934 | #33 is `9e20f3c`. All four files match r6 |
    | P24 (plan L1596) | #38, L8109 | #38 holds `fc8dece`'s four files. All match r7 |
    | P26 (plan L1654) | #43, L8618 | Timeline, script and storyboard match r7. The engine is the later `.is-marked` one (item 8) |

### Amendment 8 (2026-09-28, after r1's first plan run, before its extraction)

Amendment 7, item 9 extracts r1 under "Amendments" item 1. r1's first plan run met a case
that item 1 does not settle. This amendment was written after that run, after the answer
key was committed, and before r1 was extracted or any coach run on it. The decision is the
user's.

1. **What the plan run measured at r1's state, checkpoint #7.**
   - `write-script.mjs` (`0bfacee4`) reproduces #7's `script.md` (`2a4f3149`) byte for byte.
   - `write-storyboard.mjs` (`47e7e1da`) does not reproduce #7's `storyboard.html`
     (`643e796e`). That file is stale. It was made at checkpoint #4, from #4's timeline
     (`7060f0b6`). Between #4 and #5, every segment's triggers changed, and six segments'
     diagrams were laid out again, from a 1600×900 viewBox to 1600×520. Nothing else in
     any segment changed, so the narration, and with it `script.md`, still reproduces.
     #5, #6 and #7 all hold the render's timeline (`f9c98a98`).
2. **The rule it meets.** Item 1's fallback to an earlier checkpoint is written "for a
   snapshot round". r1's state is a checkpoint, but r1 is not a snapshot round. As written,
   its storyboard has no proof, so r1 gets pass 1 only, and R1-04 can never be *objective*:
   the answer key makes it objective only if r1's pass-2 inputs show it.
3. **The user's decision:** *"Apply the fallback to r1, since its state is a checkpoint, and
   disclose it as Amendment 8."* The fallback now applies wherever a round's state is a
   session checkpoint.
   - **r1:** the storyboard is proven at checkpoint #4, so r1 gets both passes.
   - **r2 and r3:** no change. Their states are checkpoints, and item 1 already covered them.
   - **r6c:** no change. Its state is a commit, with no earlier checkpoint to fall back to.
   - Measured: the full plan made with this amendment's code and with the code before it
     is the same for every round, except for r1's added lines.
4. **Disclosures.**
   - The fallback was measured before the user decided, so the user knew it gives r1 both
     passes.
   - It changes only whether pass 2 runs. The storyboard is the same file either way
     (`ccc154a9`): it is made by #7's generator from #7's timeline. Only the proof uses #4's
     data.
   - The question was not asked blind. The orchestrator who put it knew r1's key, including
     that R1-04 depends on pass 2's stills. r1 counts toward neither bar, so no bar can move
     on this decision.
   - Amendment 6, item 1 added no fallback for r6c. That state is a commit, and a fallback
     would not have removed its `NaN` line. r1's state is a checkpoint, the case item 1's
     fallback was written for, and the file it proves is the one used.
5. **What changed in the code.**
   - `src/lib.mjs`: r1's row, with the method `checkpoint` and state #7.
   - `src/reconstruct.mjs`: `planCheckpoint`, which records the state, and each
     neighbouring checkpoint out to the first whose input files or scene builder differ.
     The fallback's condition is now "the state is a checkpoint", in place of "the method
     is the snapshot rule".
   - `src/extract-inputs.mjs`: the checkpoint method. Every manifest now also records its
     segment order, because r1's key names segments by number.
   - `src/write-ledger.mjs`: reports the checkpoint method, and the answer key's rules for
     r1 as resolved from `r1-resolution.json`. It checks that file against r1's manifest,
     and refuses to write once r1 is extracted if the file is missing.

### Amendment 9 (2026-09-28, after coach runs 1–6, before any scoring)

Run 4, r6 pass 2, met a case that the capture rule does not settle. This amendment was
written after runs 1–6 had finished, and before any of their reports was scored or, past
run 1, recorded in `runs.md`. The decision is the user's.

1. **What run 4's session log shows.**
   - The coach wrote its report as an assistant message and ended its turn without calling
     `task_complete`. The message begins `COACH REPORT — pass 2`. Its `FILES READ` lists
     the rubric and the 12 files of its input set, and nothing else.
   - All 22 of its tool calls touched only its input set and the rubric.
   - Autopilot then added a user message. Its content is empty, its source is `autopilot`,
     and the platform expanded it into a reminder to call `task_complete`. The coach
     answered with a `task_complete` call whose summary is one sentence about the report.
   - `runs.md` takes the report from that summary ("What the trial showed", item 1). Here
     the summary is not a report: it has no findings and no `FILES READ`.
   - Runs 1, 2, 3, 5 and 6 match the trial run: one user message, no assistant message
     with text, and the report in the `task_complete` summary.
2. **The user's decision:** *"The full report message, by a rule for every run: the report
   is the one text that starts "COACH REPORT" and has FILES READ, and an empty autopilot
   nudge after it is not a second prompt."*
3. **The rule, as the capture applies it to every run.**
   - The candidates are every assistant message with text, and the `session.task_complete`
     summary.
   - The report is the candidate whose first line starts `COACH REPORT` and which has a
     `FILES READ:` line. If more than one candidate qualifies, they must be identical.
   - The first user message must still be the dispatch message. A later user message is
     not a second prompt if it is empty, its source is `autopilot`, and it comes after the
     report.
   - A run with no report, or one that breaks either rule, is flagged. Nothing from it is
     scored until the user decides.
   - Nothing else changes: the void check, the byte-for-byte copy, and the check that the
     `task_complete` argument equals its summary.
4. **Measured before this commit.**
   - Runs 1, 2, 3, 5 and 6, captured again under the rule, give the same reports byte for
     byte. Each has one candidate, the `task_complete` summary, and no later user message.
   - Ten synthetic logs cover the rule's branches: the report as a message and in
     `task_complete`, a later message with text, a later message not from autopilot, a
     nudge before the report, no report, a report without `FILES READ`, two reports that
     differ, two that are identical, and a read outside the set. Each comes out valid,
     flagged or void as the rule says.
   - Run 4 is captured under the rule only after this amendment is committed.
5. **Disclosures.**
   - The orchestrator read run 4's report while finding out why it was flagged, and knows
     r6's key, so it could have told how each option would score. The question put to the
     user described the report only by its structure.
   - This decision can move the bar. r6 is commit-backed, and its pass 2 is the only pass
     that reads the storyboard, which is R6-10's only route ("Counts" in `answer-key.md`).
   - The options the user declined:
     - re-running r6 pass 2 once, the protocol's remedy for a void run. Run 4 is not void
       as the protocol defines it, and a re-run would draw a second report after the first
       had been read;
     - recording r6 pass 2 as having no report. No pass of r6 could then reach R6-10, and
       the commit-backed bar could not be met.
   - Runs 7 and 8, r1's two passes, were dispatched before this amendment was committed,
     in the same way as runs 1–6. They are captured under it.

### Scoring (defined before results)

- **Recall** = objective defects the coach raised as **BLOCKING**, in any pass whose
  inputs could show them ÷ objective defects that were catchable from that round's inputs.
  Recall at any severity is also reported, but it is not part of the bar.
- **Precision** = BLOCKING findings the user agrees with ÷ all BLOCKING findings.
- **Bar**: recall ≥ 50 % **and** precision ≥ 80 %, pooled over all scored rounds and both
  passes.
- **Two kinds of rounds, reported separately.**
  - *Commit-backed* rounds take their inputs from ordinary commits.
  - *Reconstructed* rounds are states that were never committed. They are rebuilt from
    session checkpoints, or by undoing a committed review script's own edits. Either way,
    the mapping to the reviewed state is inferred.
  - The bar is evaluated on both sets. If they disagree, the commit-backed result governs.

### Contamination — disclosed, not eliminated

- **The orchestrator knew the answers.** It (Claude) read every round's fixes before
  writing the coach's instructions and the rubric brief.
  - The brief is committed verbatim as `rubric-brief.md`, recovered from the session
    event log. It names the genre, the audience ("experienced engineers", system-paced),
    the two passes and their inputs, the authority model, the lanes the engine was said
    to cover, and the user's practitioner checklist. It contains no example from any
    round.
  - The rubric author was told not to read the repository. What it did read is recorded
    in `rubric.md`, and the session's tool log agrees (see *The rubric was checked
    against its author's tool log*, below).
- **Excluded source.** The skill's `planning.md` holds lessons learned on the reference
  project, so the rubric does not draw on it.
- **Findable answers.** Most rounds' review scripts are public on `origin/main`, and the
  coach could in principle read them. `FILES READ` is the control: a read outside the
  input set voids the run.
- **One judge.** The user is both the source of the answer key and the judge of unmatched
  findings.
- **Pass 1 sees more than a true pre-TTS review would.** This project generates `script.md`
  *after* TTS, so it carries measured timings.
- **The inputs contain the author's revision notes.** The on-screen notes in
  `script.md`/`timing.json` include comments on earlier revisions. At round N's pre-fix
  state those describe only rounds before N, which is what a coach at that moment would
  have seen, so they are left in.
- **Most lanes the brief called covered were not, at the rounds' engines.** The brief
  told the rubric author the pipeline "already measures and fails on" five lanes, so the
  rubric leaves them to the engine. After the brief was sent, the engine at each round's
  pre-fix commit was checked:

  | Lane, as the brief put it | At the r4–r7 engines |
  |---|---|
  | Minimum rendered text size | Measured, but only logged as an advisory. `frame-capture.mjs` never fails on it |
  | WCAG contrast of text, 4.5:1 and 3:1 | Never computed. The colour regex is mangled by template-literal escaping (engine finding C-14), so every red channel parses as `NaN` and no ratio is ever below a threshold. Executed against all four rounds' scenes |
  | Contrast of graphics, 3:1 | Never measured. The audit selects text elements only |
  | Elements overflowing or clipped | Partly. The layout audit fails a slide whose safe area overflows after fitting. It does not check an element clipped by its own container |
  | Visual events overlapping in time within a segment | No check exists. `validate-timing.mjs` checks segments against each other, not events within one |
  | Subtitles; loudness, true peak, music level and A/V drift | Not checked here. Neither lane is visible in the coach's inputs, so neither can change a score. The engine's own comment says encoded true peak is never measured |

  - None of this is fed back into the blind rubric.
  - Pass 2 does not include legibility output, so the inputs are unaffected.
  - If a reported defect falls in one of the first five rows and the coach leaves it to
    the engine, it is scored as a miss. Those misses are also counted and reported
    separately: they are what the brief's error cost, and they point at engine fixes
    rather than coach fixes.
- **The rubric author is the same model family as the video's author.** The rubric was
  written by the built-in `research` agent on its default model, `claude-sonnet-5`. The
  storyboards were also written by Claude.
  - A shared family could bias the rubric either way. Shared blind spots would thin the
    rules that a Claude author's defects need. Shared habits could make those defects
    easier to anticipate. Which way it went is unknown.
  - The coach itself runs on the GPT family, as designed. That separation is the one the
    design relies on.
- **The rubric's first delivery was lost, and its body is regenerated.** The author's
  full answer hit an output limit, and only its closing sources section arrived. Its
  context was then compacted, so the draft was lost to its author too.
  - The same blind author re-sent the rubric in parts of 4,000 characters or fewer. It
    declared the body `REGENERATED`: rewritten from its research notes, with group
    structure, rule IDs, tags and citations preserved and the sentence wording new.
  - The re-send was cut off the same way once. That piece was re-sent from the author's
    own context, and each piece is recovered byte-exact from the session event log.
  - Nobody read the lost draft, so no version was chosen over another. Regeneration
    does not touch blindness: the author still read no repository file and saw no
    defect.
  - `rubric.md` is the re-sent text, joined verbatim by `src/assemble-rubric.mjs`. Only
    the transport lines (`PART …`, `REGENERATED: …`, `NEXT: …`, `END PART …`) are
    removed. The pieces and the tail that arrived first are kept outside the repository,
    with their SHA-256 in `inputs.md`. The `REGENERATED` lines are the author's own
    disclosures, so `inputs.md` quotes them.
- **The rubric was checked against its author's tool log.** The session event log records
  every tool call the author made. `rubric-provenance.md` lists its web calls and where
  each cited paper was read.
  - *Blindness holds.* The author made 134 calls: 69 web fetches (50 succeeded), 28 web
    searches and 37 PowerShell calls. It made no `view`, `grep` or `glob` call. Every
    PowerShell call only builds the text of a piece, and none touches a file or the
    network. No search or URL names the repository, its tools or the user. All web calls
    fall in the research pass, and the regeneration made none. So `REPO FILES READ: none`
    is true.
  - *Every block-eligible `[VERIFIED]` rule rests on text the author fetched.* There are
    ten: OBJ-03, OBJ-09 to OBJ-16, and OBJ-18. Each cites a page whose text was fetched,
    either directly, by redirect, or as a repository record of the same paper. Each
    stated finding is in that text. Three paraphrases go further than the text:
    - OBJ-03 says "inconsistent labeling undermines the very signal a cue is meant to
      send". That is the author's inference. The Richter abstract is about signals that
      highlight text–picture correspondences and says nothing about inconsistent names.
      It is the weakest of the ten.
    - OBJ-11 says seductive details "reliably reduce learning outcomes across the reviewed
      studies". The abstract reports a significant pooled effect, small to medium, with
      moderators.
    - OBJ-18 gives a working-memory mechanism. That comes from cognitive load theory, not
      from the fetched abstract. The finding itself is quoted there.
  - *The regenerated source lists name four pages that were never fetched.* `## Sources`
    and `## SOURCES CONSULTED` list the five papers by DOI and mark them fetched. Only
    Cowan's DOI was fetched.
    - The other four abstracts came from repository records: psycharchives.org,
      eric.ed.gov, asu.elsevierpure.com and ro.uow.edu.au. Those are the pages the first
      delivery listed.
    - The regeneration swapped in the DOIs, yet its `REGENERATED` line says every URL was
      "carried forward".
    - No claim rests on an unread paper, but the lists misstate which pages were read.
    - The rules cite the records they used, except OBJ-18, which gives Kalyuga's DOI, and
      `## Conflicts`, which gives Kalyuga's and Rey's.
    - Rey's author and journal are not in the fetched ERIC record, and the DOI appears
      only in a search result.
  - *The sources tail was not re-sent unchanged, although the author said it would be.*
    - It drops the Spanjers et al. (2011) entry, a fetched record that no rule cites.
    - It drops the "attempted via …" notes on the unfetched papers.
    - Three unfetched papers gain journal details that the first delivery did not give.
    - No rule is affected. The first delivery's tail is kept, with its hash in
      `inputs.md`.
  - *Smaller slips.*
    - OBJ-03 and OBJ-10 give the first author as "Richter, T.", but the record and the
      rubric's own list say "Richter, J.".
    - OBJ-17 says Cowan is "cited under OBJ-11", but Cowan is cited under CRAFT-02 and
      OBJ-09. The remark is an aside, in a rule that cannot block.
    - CRAFT-09 checks against a "brief". For these rounds, that is the header of
      `script.md`.
    - The brief asks for six group headings. Only the first, `## Message and structure`,
      is present, and the rules of the other five groups follow in the brief's order
      with no heading. The pieces contain no other group heading, so the assembly
      removed none.
  - None of this is corrected, because `rubric.md` is the author's text. Disclosing it is
    the correction.

## How to run

Requires Node 22 or later and git. The camera uses the Chromium that the engine's
lockfile names, from the local Playwright cache. Every script plans by default and
writes only under `--apply`.

1. **Extract the inputs.**

   ```powershell
   node src/extract-inputs.mjs --apply
   ```

   For each round, it:
   - writes the round's `tools/SizzleCraft` and `tools/EvalLoopDemo` trees from git's
     object store into `<tmp>/vcb/work/<round>`, then re-hashes every file against its
     blob id. It reads blobs directly because `git archive` applies attributes, and a
     direct read cannot;
   - installs dependencies from the committed lockfiles with `npm ci --ignore-scripts`;
   - builds the scene with the round's own `write-build-html.mjs`, and takes the stills
     with the one camera named under "Input sets";
   - collects `<tmp>/vcb/inputs/<round>/pass1/` and `pass2/`, and leaves a manifest
     beside the build.

   A reconstructed round is first rebuilt with `src/reconstruct.mjs`: its `timing.json`
   by its method, then `script.md` and `storyboard.html` by its generators (see
   "Amendments"). They are written over the export before anything is built. Without
   `--apply`, the plan shows each method's evidence: the fields and whether the script gives
   the base back (r6c), each checkpoint's status (r2, r3), the neighbouring checkpoints'
   input files (r1), and each generator's proof.

   It refuses an output folder inside any checkout of this repository. It deletes only
   folders it created, and only under `--replace`. `--round <id>` (repeatable) limits it
   to those rounds; `--work <dir>` and `--out <dir>` move the two folders. Because a round
   folder is never rebuilt without `--replace`, the reconstructed rounds can be extracted
   after r4–r7 without touching them: `--round r6c --round r2 --round r3`, and r1, after
   the answer key, with `--round r1`.

   A reconstructed round that does not hold is not extracted. It gets no input set, and
   its work folder holds `not-extracted.json`, which says why, in place of a manifest
   ("Amendment 6", 1). A commit-backed round that does not hold, or a state without both
   lockfiles, stops the run.
2. **Check the commit-backed rounds' freshness.** It writes `<tmp>/vcb/work/freshness.json`
   ("Amendment 6", 2), and touches no round folder.

   ```powershell
   node src/check-freshness.mjs --apply
   ```

3. **Assemble the rubric** from its transport pieces, which are kept outside the
   repository.

   ```powershell
   node src/assemble-rubric.mjs --parts <pieces> --apply
   ```

4. **Write the ledger**, `inputs.md`. It is the only file the extraction side writes into
   the repository.

   ```powershell
   node src/write-ledger.mjs --rubric-parts <pieces> --rubric-extra <file> --apply
   ```

   It names no local path. It refuses to write unless the pieces still reproduce
   `rubric.md` byte for byte. It reports every round folder it finds, extracted or not,
   and the freshness check if `freshness.json` exists. Once r1 is extracted, it also needs
   `r1-resolution.json`, the answer key's rules for r1 as resolved from its inputs
   ("Amendment 8"), and refuses to write without it.
5. **Score the runs**, which writes `scoring.md`.

   ```powershell
   node src/write-scoring.mjs --events <events.jsonl> --apply
   ```

   It reads the protocol files from `HEAD`, and refuses while any of them has uncommitted
   changes. It reads the coach reports from `<tmp>/vcb/runs` (`--runs <dir>` moves it) and
   checks each one's size and hash against `runs.md`. The user's answers come from the
   session's event log, `--events`. The scoring exchanges run from the question starting
   "1 of 19 · " to the one starting "r1 · Q26, the last one · ", and each of those must
   appear exactly once. Every declaration the script relies on is checked, and a failed
   check stops it. It will not overwrite `scoring.md` without `--replace`, and it will not
   write anything that names a profile path, a URL or the user's name.

Nothing under `tools/` is modified, and no git worktree is created.

## Answer

**No.** The coach stays advisory-only.

Every figure is in `scoring.md`, which `src/write-scoring.mjs` computes from the committed
records and the user's answers.

| Set | Rounds | Recall (BLOCKING) | Precision | Bar |
|---|---|---|---|---|
| Commit-backed (governs) | r6, r7 | 1/3 | 4/4 | not met |
| Reconstructed | r2 | 1/2 | 2/2 | met |
| Pooled | r2, r6, r7 | 2/5 | 6/6 | not met |

- **The Scoring rules can be read two ways.** They say the bar is "pooled over all scored
  rounds", and also that it "is evaluated on both sets", with the commit-backed result
  governing when the sets disagree. `scoring.md` reports both readings, and the bar is
  missed under either.
- **The misses are the ones the key predicted.** Before any run, "Counts" in
  `answer-key.md` said that R6-13 had no BLOCKING route, and that R2-06 and R6-10 could be
  blocked only by applying OBJ-07's check procedure rather than its rule text. The coach
  caught both items with a direct route (R2-11 and R7-01), and none of those three.
- **When it blocked, the user agreed**, 6 times out of 6 in the scored rounds. Four of the
  six are one observation in segment `many`, raised again in every round and judged each
  time a valid defect that the review had missed.
- **Counting ADVISORY findings changes no recall figure.**
- **The evidence is thin.** The governing set has three objective items, and one more
  catch would have met the bar. Run 4 does not affect the answer (Amendment 9).
- **r1 is descriptive only.** Precision there is 2/2 of the findings judged. Recall is
  0/2 certain, and at most 1/2.

## Disposition

- [x] **Graduate** — rebuild for real in `apps/`, `services/`, `libs/`, or `tools/`
      at its proper tier. Graduation is a **rewrite** under the gates this skipped, not a
      folder move.
- [ ] **Retire** — delete this folder; the finding lives in `docs/adr/`.
- [ ] **Park** — still a useful reference. Note what would unblock it.

**Graduate**, chosen by the user on 2026-09-30, as an **advisory-only** step in the demo
pipeline: pass 1 before TTS, pass 2 before frame capture. The coach never gates a render.
[ADR 0006](../../docs/adr/0006-keep-the-video-coach-advisory-only.md) records why.

The graduated step is rebuilt under Tier 2 gates, with its own reviewed rubric; nothing
outside `spike/` may point into this folder. It has not started. This folder stays as the
reference for the rubric and the protocol until it lands.
