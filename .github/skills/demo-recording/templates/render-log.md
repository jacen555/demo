# Render Log — `<project name>`

> Per-project memory. A session starting cold reads **this file and `knobs.json`**,
> and nothing else, to know where the project stands.
>
> Keep it short. This is a state file, not a changelog — prune superseded detail.

## Current state

| | |
|---|---|
| **Status** | `planning` \| `awaiting-approval` \| `rendered` \| `approved` \| `superseded` |
| **Duration** | _(measured, not target)_ |
| **Output** | `<path to the file to present>` |
| **Last render** | _(date, and what it cost in wall-clock)_ |
| **Approved by user** | yes / no — _(what exactly was approved)_ |

## Deliverables

| File | Size | Notes |
|---|---|---|
| `<name>.mp4` | | Dry — no music |
| `<name>-with-music.mp4` | | **Present this one** |
| `<name>-script.md` | | Narration text |
| `<name>-storyboard.html` | | Visual plan |

## Measured values

Record what was **measured on the finished artifact**, not what was targeted.
A later session compares against these rather than re-deriving them.

| Property | Value |
|---|---|
| Integrated loudness (whole file) | |
| True peak | |
| Narration-only loudness | |
| Lead-in (music only) | |
| Perceived gaps | |
| Frame count | |

## Series continuity

_Delete if not part of a series._

| | This part | Other parts must match |
|---|---|---|
| Voice / speed | | yes |
| Perceived gap | | yes |
| Narration loudness | | **yes — most noticeable if it drifts** |
| Music bed | | similar, deliberately not identical |

Played back-to-back or standalone? _(changes how much the opening re-establishes)_

## Render cost (measured)

Update on first real run so later sessions quote real numbers instead of guessing.

| Stage | Wall-clock |
|---|---|
| Synthesis | |
| Capture | |
| Encode | |
| Audio mix + remux | |
| **Full render** | |
| **Audio-only remux** | |

## Pending changes

Batch these — do **not** render for one tweak if more feedback is likely.

- [ ] _(change — and whether it is audio-only or timeline-affecting)_

## Project-specific gotchas

Anything true of *this* project only. General bugs belong in the skill's shared
bug ledger (`.github/skills/demo-recording/references/bug-ledger.md`) instead, so
every project benefits.

-
