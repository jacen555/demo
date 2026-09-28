// assemble-rubric — join the rubric's transport pieces into rubric.md, verbatim.
//
// The rubric reached the orchestrator in pieces (README, "Contamination"). The pieces and
// their order live outside the repository, in a folder holding ORDER.txt. Only transport
// lines are removed; see TRANSPORT_LINES in lib.mjs.
//
// It plans by default and writes nothing without --apply.

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { EXIT, SPIKE_DIR, UsageError, assembleRubric, main, pathExists, sha256 } from './lib.mjs';

const USAGE = `
assemble-rubric — join the rubric's transport pieces into rubric.md, verbatim.

  node src/assemble-rubric.mjs --parts <dir>                     plan (writes nothing)
  node src/assemble-rubric.mjs --parts <dir> --apply             write rubric.md
  node src/assemble-rubric.mjs --parts <dir> --apply --replace   overwrite rubric.md

<dir> holds the pieces and ORDER.txt: one piece per line, in rubric order. A line
ending " join=space" joins that piece to the previous one with a single space (a cut
mid-sentence); every other boundary is a blank line.

Exit codes: 0 success/plan · 1 failed · 2 bad usage
`.trimStart();

await main(async () => {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        parts: { type: 'string' },
        apply: { type: 'boolean', default: false },
        replace: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (err) {
    throw new UsageError(`${err.message}\n\n${USAGE}`);
  }
  if (values.help) {
    console.log(USAGE);
    return EXIT.OK;
  }
  if (!values.parts) throw new UsageError(`--parts is required\n\n${USAGE}`);

  const rubric = await assembleRubric(path.resolve(values.parts));
  for (const p of rubric.pieces) {
    console.log(`${p.name.padEnd(10)} ${String(p.bytes).padStart(6)} bytes  sha256 ${p.sha256}  join=${p.join}`);
    for (const r of p.removed) console.log(`    removed: ${r.length > 100 ? `${r.slice(0, 100)}…` : r}`);
  }
  console.log(`\nassembled ${Buffer.byteLength(rubric.text)} bytes  sha256 ${sha256(Buffer.from(rubric.text, 'utf8'))}`);
  console.log(`rules (${rubric.ids.length}): ${rubric.ids.join(' ')}`);
  if (rubric.duplicates.length) throw new Error(`duplicate rule ids: ${rubric.duplicates.join(' ')}`);

  const dest = path.join(SPIKE_DIR, 'rubric.md');
  if (!values.apply) {
    console.log(`\nplan only — would write ${dest}. Re-run with --apply.`);
    return EXIT.OK;
  }
  if ((await pathExists(dest)) && !values.replace) throw new UsageError(`${dest} exists; pass --replace to overwrite it`);
  await fs.writeFile(dest, rubric.text);
  console.log(`\nwrote ${dest}`);
  return EXIT.OK;
});
