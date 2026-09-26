/*
 * Wires this project's no-go patterns into timing.json so `code` mode can enforce them.
 *
 * The audit found the guard was INERT for the one project that uses it: the frame-boundary
 * check read `timing.project.noGoPatterns`, the tests supplied patterns and passed, and the
 * real project supplied none — so the documented guarantee guaranteed nothing exactly where
 * source data actually reaches a frame.
 *
 * That is the failure I handed the other session a name for one round earlier: a check that
 * cannot fire is indistinguishable from a check that passed. The tests could not catch it,
 * because a test that supplies its own fixture proves the mechanism works, never that it is
 * switched on.
 *
 * These are the same regexes `tests/write-script.test.mjs` asserts against rendered copy.
 * They live in one place now so narration and on-screen data are held to one list.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const timingPath = path.join(dir, 'timing.json');
const timing = JSON.parse(fs.readFileSync(timingPath, 'utf8'));

// Source strings, not RegExp literals — timing.json is JSON, and the engine compiles each
// with the `i` flag. Anchored the same way the narration guard is.
timing.project.noGoPatterns = [
  'cortex-supportgraph',
  '[-.]ppe\\b',              // hostname-shaped PPE only; the bare release-stage word passes
  '\\bppe[-.]',
  '\\btest[12]\\b',          // deployment slot names
  'microsoft-ppe\\.com',
  'frontieragentcatalog',
  'https?://',
  '\\b[a-z0-9-]+\\.(com|net|io|azure|microsoft)\\b',
  '\\b!?16\\d{5}\\b',        // Azure DevOps pull-request ids
];

fs.writeFileSync(timingPath, `${JSON.stringify(timing, null, 2)}\n`);
console.log(`timing.project.noGoPatterns set — ${timing.project.noGoPatterns.length} patterns`);
for (const p of timing.project.noGoPatterns) console.log(`  /${p}/i`);
