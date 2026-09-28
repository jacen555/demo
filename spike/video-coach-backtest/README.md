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
  the result.
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
   the base back (r6c), each checkpoint's status (r2, r3), and each generator's proof.

   It refuses an output folder inside any checkout of this repository. It deletes only
   folders it created, and only under `--replace`. `--round <id>` (repeatable) limits it
   to those rounds; `--work <dir>` and `--out <dir>` move the two folders. Because a round
   folder is never rebuilt without `--replace`, the reconstructed rounds can be extracted
   after r4–r7 without touching them: `--round r6c --round r2 --round r3`.
2. **Assemble the rubric** from its transport pieces, which are kept outside the
   repository.

   ```powershell
   node src/assemble-rubric.mjs --parts <pieces> --apply
   ```

3. **Write the ledger**, `inputs.md`. It is the only file the extraction side writes into
   the repository.

   ```powershell
   node src/write-ledger.mjs --rubric-parts <pieces> --rubric-extra <file> --apply
   ```

   It names no local path. It refuses to write unless the pieces still reproduce
   `rubric.md` byte for byte.

Nothing under `tools/` is modified, and no git worktree is created. The scorer comes
later.

## Answer

_(pending)_

## Disposition

- [ ] **Graduate** — rebuild for real in `apps/`, `services/`, `libs/`, or `tools/`
      at its proper tier. Graduation is a **rewrite** under the gates this skipped, not a
      folder move.
- [ ] **Retire** — delete this folder; the finding lives in `docs/adr/`.
- [ ] **Park** — still a useful reference. Note what would unblock it.
