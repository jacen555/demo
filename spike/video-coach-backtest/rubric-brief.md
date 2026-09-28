You are writing a review rubric from primary sources. A separate, read-only "content coach" agent will use it to review narrated explainer videos BEFORE they are rendered. Return the complete rubric as Markdown in your final response. Do NOT create, write or edit any file — the orchestrator saves your response verbatim.

## Blinding — read this first; it is the point of the exercise

This rubric will be tested against past review feedback on a real video, so it must be written without any knowledge of that video or its feedback. Therefore:

- Do NOT read, list or search any file in the local repository, and do not use GitHub code search, git history, commits, branches, pull requests or issues for the repository `jacen555/demo` (or any fork). In particular never open anything under `tools/`, `.github/`, `memory-bank/`, `docs/`, `spike/` or `specs/`.
- Do not search the web or GitHub for "SizzleCraft", "EvalLoopDemo", or "Forge" in connection with jacen555.
- Work only from the open web: peer-reviewed research, W3C standards, and practitioner sources.
- End your response with `SOURCES CONSULTED` (every URL you actually fetched) and `REPO FILES READ:` followed by `none`, or an honest list of anything you opened. An undisclosed read voids the test; an honest disclosure does not.

## What is being reviewed

Short (roughly 3–6 minute) narrated technical explainers for software engineers — how a system works, or what an experiment found.

- Visuals are animated diagrams, charts and text slides authored as HTML/CSS/SVG and rendered to video frames. No camera, no presenter on screen, no talking head, no live screen recording.
- Narration is synthetic (neural text-to-speech), one voice, read from a written script.
- A music bed sits under the narration and ducks under speech. Subtitles are generated from the script. Chapters are marked.
- Production is staged: script → TTS → timing solve → storyboard → frame capture → encode. The coach runs BEFORE the expensive stages.

## When the coach runs and what it can see

- **Pass 1 — script review, before TTS.** The narration script, split into segments (each with an id and heading), and sometimes a short brief (purpose, audience).
- **Pass 2 — storyboard review, before frame capture.** The script; a timing file with each segment's start/end, word-level timestamps for the narration, and the time at which each named visual element appears or animates (each visual step is keyed to a trigger word in the narration); the storyboard (per-segment HTML/CSS/SVG — the actual slide content and its animation steps); a handful of rendered stills (PNG frames at chosen instants); and the output of the pipeline's automated audits (below).

The coach cannot hear audio, watch motion, or see frames other than the stills. Every rule must be checkable against these inputs; anything that is not goes in the "Not evaluatable" section.

## Already automated — the rubric must NOT re-check these

The pipeline already measures and fails on:

- minimum rendered text size, and WCAG contrast of rendered text (4.5:1 normal text, 3:1 large text and graphics);
- elements overflowing or clipped by their container or the frame;
- visual events overlapping in time within a segment;
- subtitle line width and cue length;
- loudness, true peak, music-under-speech level, and audio/video drift.

List these in a "Covered by the pipeline" section so the coach can report them as NOT EVALUATED with owner "engine". If a source you find implies a stricter threshold than these, note it there as an open question — do not turn it into a coach rule.

## Authority model the rubric must support

- Each rule is either **objective** (a check whose procedure, applied by two careful reviewers to the same inputs, gives the same answer) or **craft** (a judgement).
- A rule is **block-eligible** only if it is objective AND either (a) backed by a [VERIFIED] source, or (b) it tests the video against itself — narration vs on-screen text vs numbers vs labels vs the brief — where a contradiction is wrong under any taste. Everything else is advisory.
- The coach can block but can never approve or waive. Write rules as defect detectors ("X is a defect when…"), never as quality scores or ratings.

## Tags — every rule gets exactly one, with a citation

- **[VERIFIED]** — peer-reviewed empirical research (for example multimedia-learning and cognitive-load research — Mayer, Sweller — and meta-analyses where they exist), or a W3C standard (WCAG 2.2 success criteria and techniques relevant to prerecorded synchronized media; cite exact SC and technique IDs from w3.org). Cite author, year, title and a URL you fetched. State the finding in one line and, where a meta-analysis gives them, the effect size and boundary conditions. Our viewers are experienced engineers and the video is system-paced (not learner-paced): say explicitly how expertise-reversal and pacing affect each rule.
- **[PRACTICE]** — guidance from people who make educational or explainer video (for example Crash Course's Creator Lab, other established educational creators, reputable production guides). Credit the real source with a URL you fetched.
- **[HOUSE]** — reserved for the user's own preferences. Include the section but leave it EMPTY with the note "intentionally empty until the backtest completes".

Do not upgrade a claim: a blog post summarising Mayer is [PRACTICE] unless you traced it to the primary study.

## Practitioner checklist supplied by the user (verbatim)

The user supplied the checklist below, presenting the Crash Course series as a possible gold standard. Only one of its links is Crash Course's own (https://thecrashcourse.com/creator-lab/), and that page describes a four-unit course (research, script, revise, produce) rather than these specific rules. The other links point to a university news post, YouTube videos, and third-party course or guide pages.

For each point: find a practitioner source that actually says it and credit that source. If you cannot, include the point tagged [PRACTICE] with source "user-supplied checklist (unsourced)". Where a point conflicts with [VERIFIED] research, research wins: say so explicitly in a Conflicts section, with both citations. Points that do not apply to this format (no camera, synthetic narration) go under "Not applicable", one line each saying why.

> 1. Research and Outline
> - **Pick a focused topic:** Choose a single, specific concept rather than a broad subject.
> - **Write a strong hook:** Start the video with an interesting question or surprising fact to grab attention immediately.
> - **Organize into modular sections:** Break your main topic into three to four smaller sub-topics or lessons. [1](https://esteem.nd.edu/news/7-step-guide-to-creating-online-video-courses/), [2](https://thecrashcourse.com/creator-lab/)
>
> 2. Write the Script
> - **Keep the tone conversational:** Write like you are talking to a smart friend, using humor and analogies.
> - **Pace your delivery:** Aim for an energetic, fast cadence, but leave room for emphasis on key terms.
> - **Plan your visuals:** Note where you will insert B-roll, graphics, or slide presentations alongside your talking-head footage. [1](https://www.youtube.com/watch?v=6xk4iUuL4IY&t=200), [2](https://www.youtube.com/watch?v=ArBS88h1r2Q)
>
> 3. Film Your Footage
> - **Set up clean lighting:** Use a three-point lighting setup or face a bright window to avoid harsh shadows.
> - **Prioritize good audio:** Record in a quiet room with a dedicated external microphone; clear sound is more important than expensive video gear.
> - **Frame your shots:** Use medium shots or close-ups to keep the viewer connected to your facial expressions and energy. [1](https://www.youtube.com/watch?v=8QCK_qEp_PI&t=18), [2](https://www.academyforvirtualteaching.com/courses/video-making-crash-course), [3](https://www.indie-film-making.com/how-to-make-a-video/)
>
> 4. Edit and Polish
> - **Do a rough cut:** Import your clips into an editor like Adobe Premiere Pro, DaVinci Resolve, or CapCut, then remove pauses, breaths, and dead air.
> - **Layer in multimedia:** Add relevant B-roll, stock footage, pop-up text graphics, and background music to maintain high visual engagement.
> - **Mix your audio:** Balance your voice track so it sits cleanly above the background music without straining the listener. [1](https://www.youtube.com/watch?v=K-FJIc93RqE), [2](https://www.youtube.com/watch?v=fDe7G8Tz6cA&t=7), [3](https://www.youtube.com/watch?v=6xk4iUuL4IY&t=200), [4](https://www.youtube.com/watch?v=8QCK_qEp_PI&t=18)

## Required format for every rule

```
### <ID> — <short name>
- Rule: one sentence, phrased as a defect condition.
- Class: objective | craft
- Block-eligible: yes | no — one-line reason.
- Pass: 1 | 2 | both
- Tag & source: [TAG] citation + URL; the finding in one line; boundary conditions.
- Inputs used: any of script, brief, timing, storyboard, stills, audit output.
- Check procedure: numbered steps a reviewer follows against the inputs, including any threshold and where the threshold comes from. No threshold without a source — if the source gives none, write "judgement", and the rule cannot be block-eligible.
- Evidence to cite: what a finding must quote (segment id, word and timestamp, still filename, the on-screen text).
- Not a defect: the near-misses that must NOT be reported (false-alarm guards).
- Blind spot: what this check cannot see from the inputs.
```

Use IDs `OBJ-nn` for objective rules and `CRAFT-nn` for craft rules. Group the rules under: Message and structure; Narration (script); Narration and visuals together; Visual design and density; Accessibility; Pacing.

## Also include, in this order after the rules

1. **Not evaluatable from these inputs**: things that matter but need listening or a full render (for example pronunciation, prosody, music character, motion smoothness, perceived pace). Name who should check each: "the user at the draft review".
2. **Conflicts**: every [PRACTICE] vs [VERIFIED] conflict and how it is resolved.
3. **Covered by the pipeline**: as above.
4. **[HOUSE]**: present and empty.
5. **Sources**: the full list with URLs, each marked fetched or not fetched.

## Quality bar

- Fewer, sharper rules: aim for 20–35. A rule a reviewer cannot apply to the inputs is not a rule; move it to "Not evaluatable".
- No numbers without a source, and no invented citations. If you could not fetch something, do not present it as fetched.
- State boundary conditions (expertise reversal, system pacing, TTS versus human narration — for example, what the "voice principle" research does and does not say about modern neural TTS).
- Do not include worked examples drawn from any real video. If an example helps, invent a neutral one about an unrelated topic (for example, how a dishwasher works).

## Return

Return the rubric Markdown, then `SOURCES CONSULTED`, then `REPO FILES READ`. Return nothing else: no preamble, and no offer of follow-ups.