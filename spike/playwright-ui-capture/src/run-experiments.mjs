/**
 * Runs every experiment in order and prints a summary table.
 *
 * Each experiment writes its own results/<name>.json; this only orchestrates and
 * summarises, so an individual experiment can still be run on its own.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { run as e1 } from './e1-record-video.mjs';
import { run as e2 } from './e2-determinism.mjs';
import { run as e3 } from './e3-cursor.mjs';
import { run as e4 } from './e4-speed.mjs';
import { run as e5 } from './e5-zoom.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = path.resolve(here, '..', 'results');

const EXPERIMENTS = [
  { id: 'e1', name: 'recordVideo (Option A)', fn: e1 },
  { id: 'e2', name: 'determinism (Option B)', fn: e2 },
  { id: 'e3', name: 'synthetic cursor', fn: e3 },
  { id: 'e4', name: 'speed control', fn: e4 },
  { id: 'e5', name: 'zoom', fn: e5 },
];

const summary = [];
let failed = 0;

for (const exp of EXPERIMENTS) {
  process.stdout.write(`running ${exp.id} — ${exp.name} ... `);
  const startedAt = Date.now();
  try {
    const result = await exp.fn();
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`done (${seconds}s)`);
    summary.push({ id: exp.id, name: exp.name, seconds: Number(seconds), verdict: result.verdict });
  } catch (err) {
    failed++;
    console.log('FAILED');
    console.error(`  ${err.message}`);
    summary.push({ id: exp.id, name: exp.name, error: err.message });
  }
}

await fs.mkdir(resultsDir, { recursive: true });
await fs.writeFile(
  path.join(resultsDir, 'summary.json'),
  JSON.stringify({ generatedBy: 'npm run experiments', experiments: summary }, null, 2)
);

console.log('\n--- verdicts ---');
for (const s of summary) {
  console.log(`\n${s.id}  ${s.name}`);
  if (s.error) {
    console.log(`  ERROR: ${s.error}`);
    continue;
  }
  for (const [k, v] of Object.entries(s.verdict)) {
    console.log(`  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
}

// Fail loud so a broken experiment cannot be mistaken for a passing spike.
if (failed > 0) {
  console.error(`\n${failed} experiment(s) failed`);
  process.exitCode = 1;
}
