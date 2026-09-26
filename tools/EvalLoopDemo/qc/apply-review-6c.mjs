/*
 * Review round 6, part 3 — retire the on-screen copy that the narration change orphaned.
 *
 * Segment 8's subtitle still read "Every headline number said better. One line said less
 * safe." That sentence existed to set up the prompt-injection callout, which this round
 * removed. Two problems, and the second is the one that matters:
 *
 *   1. it describes content the video no longer contains;
 *   2. under G226 it is a claim on screen that narration never speaks, so a listener has
 *      no access to it at all.
 *
 * Worth noting how it survived: changing `voiceoverText` is the visible edit, and the
 * kicker/title/subtitle/note sit in a different object. Nothing links them, so a narration
 * rewrite leaves the framing copy behind silently. The renderer cannot catch it either —
 * the text is valid, it is just no longer true.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const timingPath = path.join(dir, 'timing.json');
const timing = JSON.parse(fs.readFileSync(timingPath, 'utf8'));
const seg = id => timing.segments.find(x => x.id === id);

const s8 = seg('loop');
s8.visual.subtitle = 'A regression shows up in the same report, on the same run.';
s8.visual.note =
  'The loop builds as it is narrated — deploy, run x3, read the delta, fix, re-run — and '
  + 'closes back on the suite. "Open the pull request" sits outside the cycle to the right, '
  + 'drawn from "fix", so it reads as the output of fixing rather than a step inside the '
  + 'loop. The three measured deltas land one per sentence on the left. The claim panel '
  + '"REGRESSIONS SURFACE ON THE SAME RUN" is marked with a sustained outline as the '
  + 'narration reaches it, then the closing triad lands as three separate beats.';

const s2 = seg('scenario');
s2.visual.note =
  'The real scenario object from scenarios.json, rendered as syntax-highlighted JSON. Six '
  + 'fields are outlined and the rest dimmed, one at a time, each landing on the word that '
  + 'names it: opening, targetPath, the facts array, the second fact, answerPool, '
  + 'assertions. Four authored facts are shown. Internal ids are removed and the 13 '
  + 'alternative phrasings are elided to a count, since they derive from real support data; '
  + 'the taxonomy description is kept to its first sentence and placed last.';

// A claim register that outlives the sentence it supported is how an unsupported figure
// survives a rewrite, so re-check that nothing on this segment cites the removed callout.
const orphaned = (s8.claims || []).filter(c => /injection|refus/i.test(JSON.stringify(c)));
if (orphaned.length) throw new Error(`segment "loop" still carries ${orphaned.length} claim(s) about the removed callout`);

fs.writeFileSync(timingPath, `${JSON.stringify(timing, null, 2)}\n`);
console.log('segment "loop": subtitle + note re-written for the new narration');
console.log(`  subtitle: ${s8.visual.subtitle}`);
console.log('segment "scenario": note updated for 4 facts + description');
console.log(`claims citing the removed callout: ${orphaned.length}`);
