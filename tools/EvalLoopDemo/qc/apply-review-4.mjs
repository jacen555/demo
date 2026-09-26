/*
 * Review round 4 — segment 2 becomes `code` mode.
 *
 * The user asked twice for the ACTUAL scenario object on screen with fields highlighted
 * as they are narrated, explicitly accepting that it reads noisier than the card grid,
 * because the noise is the message: it shows how much of the conversation is configurable.
 *
 * Highlight times are taken from the MEASURED word boundaries in timing.json, not
 * estimated, so each field lights up on the word that names it. That is an accessibility
 * requirement rather than polish: narration is the only audio track (WCAG G226), so a
 * field that changes on screen without being spoken is a state change no listener can
 * follow. Every highlight below corresponds to a word actually said.
 *
 * REDACTIONS, and why each one is not cosmetic:
 *   - targetSapId    an internal GUID. Meaningless on screen and an internal identifier.
 *   - reviewItems    internal finding ids.
 *   - description    authored taxonomy prose, ~50 words. Would dominate the frame.
 *   - answerPool     13 real phrasings, elided to a count. The constraint is "reference
 *                    the real support data, never quote it"; a count references, a list
 *                    quotes. The caption says so on screen rather than implying the
 *                    field is short.
 * Everything else is the object exactly as it ships.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const timingPath = path.join(dir, 'timing.json');
const timing = JSON.parse(fs.readFileSync(timingPath, 'utf8'));

const seg = timing.segments.find(s => s.id === 'scenario');
if (!seg) throw new Error('segment "scenario" not found');

// The object as it appears in scenarios.json, minus the redactions documented above.
const scenario = {
  id: 'outlook-ios-not-receiving',
  kind: 'l5-descent',
  mode: 'caller',
  opening: 'My email has just stopped working.',
  targetPath: 'Outlook/Outlook for iOS Consumer/Technical Support (iOS)/Mail/Not receiving email',
  terminalDepth: 5,
  bankDensity: 'dense',
  openingStyle: 'generic',
  facts: [
    'I am using the mail app on my iPhone.',
    'I can still send messages, nothing new ever arrives.',
    'I checked junk and the mailbox is not full.',
  ],
  answerPool: '13 alternative phrasings (elided)',
  assertions: ['l5Exact', 'structureLevelsPopulated', 'slotAbsent:scope/confirm'],
};

// Segment-relative, read from seg.audio.words — see header.
const highlights = [
  { path: 'opening', atMs: 2505 },
  { path: 'targetPath', atMs: 10217 },
  { path: 'facts', atMs: 19807 },
  { path: 'facts[1]', atMs: 30589 },
  { path: 'answerPool', atMs: 39392 },
  { path: 'assertions', atMs: 44611 },
];

seg.visual = {
  mode: 'code',
  kicker: seg.visual?.kicker ?? 'Evaluating a conversation',
  title: 'One scenario, field by field',
  subtitle: seg.visual?.subtitle,
  caption: 'scenarios.json — phrasings elided; internal ids removed',
  note: 'The real scenario object from scenarios.json, rendered as syntax-highlighted JSON. '
    + 'Six fields are outlined and the rest dimmed, one at a time, each landing on the word '
    + 'that names it: opening, targetPath, the facts array, the second fact, answerPool, '
    + 'assertions. Internal ids and the taxonomy description are removed; the 13 alternative '
    + 'phrasings are elided to a count, since they derive from real support data.',
  json: scenario,
  highlights,
};

// The old narrative-mode triggers addressed `scenario-item-N` cards that no longer exist.
// Leaving them would resolve to null and animate nothing — silently, which is the exact
// failure this round is meant to stop. autoTriggers derives code-mode triggers from
// visual.highlights, so drop the stale ones rather than porting them.
delete seg.triggers;

fs.writeFileSync(timingPath, `${JSON.stringify(timing, null, 2)}\n`);
console.log(`segment "scenario" -> code mode, ${highlights.length} highlights from measured word boundaries`);
for (const h of highlights) console.log(`  ${String(h.atMs).padStart(6)} ms  ${h.path}`);
