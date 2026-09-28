// check-freshness — are the commit-backed rounds' generated inputs what their own pipeline
// makes from their own data? (README, "Amendment 6", 2)
//
// A reconstructed round may use a regenerated file only after its generator has reproduced a
// real file byte for byte (README, "Amendments", 1). This applies the same test to the
// commit-backed rounds, whose inputs are the committed files and stay so. At each round's
// state, both generators run on the state's committed data files, and the output is compared
// with the state's committed script.md and storyboard.html.
//
// Where a committed file is not reproduced, it looks for the data that do reproduce it. Each
// candidate makes one change: a data file replaced by another version of it (from any commit
// up to the state, or any session checkpoint up to the round's), an observed file removed, or
// timing.json replaced by the rebuilt timeline of a reconstructed round based on the same
// commit. The generators stay the state's.
//
// It plans by default and writes <work>/freshness.json only with --apply; write-ledger.mjs
// reports that file in inputs.md.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  EXIT,
  PROJECT,
  RECONSTRUCTED,
  ROUNDS,
  UsageError,
  assertOutsideRepository,
  gitBlobId,
  gitText,
  main,
  pathExists,
  repoRoot,
} from './lib.mjs';
import { DATA_FILES, GENERATED, blobOid, dataAt, listCheckpoints, planRestoreFields, readBlob, runGenerators } from './reconstruct.mjs';

const USAGE = `
check-freshness — check that each commit-backed round's script.md and storyboard.html are
what the round's own generators make from its own data files.

  node src/check-freshness.mjs                        print the report (writes nothing)
  node src/check-freshness.mjs --apply [--replace]    also write <work>/freshness.json

Options
  --work <dir>   the extraction's --work folder (default: <tmp>/vcb/work)
  --apply        write freshness.json
  --replace      overwrite an existing freshness.json
  --help         show this message

Exit codes: 0 success/plan · 1 failed · 2 bad usage
`.trimStart();

await main(async () => {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        work: { type: 'string' },
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
  const repo = await repoRoot();
  const work = path.resolve(values.work ?? path.join(os.tmpdir(), 'vcb', 'work'));
  await assertOutsideRepository(repo, { work });

  const checkpoints = await listCheckpoints(repo);
  const rounds = [];
  for (const round of ROUNDS) {
    const r = await checkRound(repo, round, checkpoints);
    printRound(r);
    rounds.push(r);
  }
  if (!values.apply) {
    console.log('\nplan only — nothing written. Re-run with --apply to write freshness.json.');
    return EXIT.OK;
  }
  const dest = path.join(work, 'freshness.json');
  if ((await pathExists(dest)) && !values.replace) throw new UsageError(`${dest} exists; pass --replace to overwrite it`);
  await fs.mkdir(work, { recursive: true });
  await fs.writeFile(dest, `${JSON.stringify({ node: process.version, rounds }, null, 2)}\n`);
  console.log(`\nwrote ${dest}`);
  return EXIT.OK;
});

// Helpers are function declarations: the top-level await above runs before any const
// below it is initialised.
async function checkRound(repo, round, checkpoints) {
  const own = await dataAt(repo, round.commit);
  const made = await runGenerators(repo, round.commit, own);
  const files = [];
  for (const g of GENERATED) {
    const committed = await blobOid(repo, round.commit, `${PROJECT}/${g.file}`);
    const m = made[g.file];
    const reproduces = m.blob !== null && m.blob === committed;
    files.push({
      file: g.file,
      generator: g.generator,
      generatorBlob: await blobOid(repo, round.commit, g.generator),
      committed,
      made: m.blob,
      error: m.error,
      reproduces,
      lines: !reproduces && committed && m.buf ? changedLines(await readBlob(repo, committed), m.buf) : null,
    });
  }

  const open = files.filter((f) => !f.reproduces && f.committed);
  if (open.length) {
    const committedBuf = new Map();
    for (const f of open) committedBuf.set(f.file, await readBlob(repo, f.committed));
    const tried = new Map(open.map((f) => [f.file, []]));
    for (const c of await candidatesFor(repo, round, checkpoints, own)) {
      const r = await runGenerators(repo, round.commit, c.data);
      for (const f of open) {
        const out = r[f.file];
        const lines = out.buf && out.blob !== f.committed ? changedLines(committedBuf.get(f.file), out.buf) : null;
        tried.get(f.file).push({ ...c.label, reproduces: out.blob === f.committed, lines });
      }
    }
    for (const f of open) {
      const all = tried.get(f.file);
      const exact = all.filter((t) => t.reproduces).map(({ lines, ...t }) => t);
      const size = (t) => t.lines.committedOnly + t.lines.madeOnly;
      const closest = exact.length ? null : (all.filter((t) => t.lines).sort((a, b) => size(a) - size(b))[0] ?? null);
      f.search = { tried: all.length, exact, closest };
    }
  }
  const data = Object.fromEntries(DATA_FILES.map((d) => [d, own[d] ? gitBlobId(own[d]) : null]));
  return { round: round.id, commit: round.commit, checkpoint: round.checkpoint, data, files };
}

// Every single change to the state's data that the search tries, deduplicated by blob.
async function candidatesFor(repo, round, checkpoints, own) {
  const out = [];
  const snapshots = checkpoints.filter((c) => c.index <= round.checkpoint).map((c) => ({ commit: c.commit, where: `checkpoint #${c.index}` }));
  for (const f of DATA_FILES) {
    const rel = `${PROJECT}/${f}`;
    const seen = new Set(own[f] ? [gitBlobId(own[f])] : []);
    const commits = (await gitText(repo, ['rev-list', round.commit, '--', rel]))
      .split('\n')
      .filter(Boolean)
      .map((c) => ({ commit: c, where: `commit ${c.slice(0, 8)}` }));
    for (const s of [...commits, ...snapshots]) {
      const oid = await blobOid(repo, s.commit, rel);
      if (!oid || seen.has(oid)) continue;
      seen.add(oid);
      out.push({ label: { change: `${f} replaced by ${oid.slice(0, 8)}`, file: f, blob: oid, from: s.where }, data: { ...own, [f]: await readBlob(repo, oid) } });
    }
    if (own[f] && f !== 'timing.json') out.push({ label: { change: `${f} removed`, file: f, blob: null, from: null }, data: { ...own, [f]: null } });
  }
  for (const rr of RECONSTRUCTED.filter((r) => r.method === 'restore-fields' && r.commit === round.commit)) {
    const rec = await planRestoreFields(repo, rr);
    if (!rec.holds) continue;
    const blob = gitBlobId(rec.timing.buf);
    out.push({
      label: { change: `timing.json replaced by ${blob.slice(0, 8)}`, file: 'timing.json', blob, from: `${rr.id}'s rebuilt timeline` },
      data: { ...own, 'timing.json': rec.timing.buf },
    });
  }
  return out;
}

// The lines only one of the two files has, counted as a multiset, with each pair cut down
// to where it differs.
function changedLines(committed, made) {
  const split = (buf) => buf.toString('utf8').split('\n').map((l) => l.replace(/\r$/, ''));
  const bag = new Map();
  for (const l of split(made)) bag.set(l, (bag.get(l) ?? 0) + 1);
  const committedOnly = [];
  for (const l of split(committed)) {
    const n = bag.get(l) ?? 0;
    if (n) bag.set(l, n - 1);
    else committedOnly.push(l);
  }
  const madeOnly = [...bag].flatMap(([l, n]) => Array(n).fill(l));
  const pairs = [];
  for (let i = 0; i < Math.max(committedOnly.length, madeOnly.length); i++) pairs.push(excerpt(committedOnly[i], madeOnly[i]));
  return { committedOnly: committedOnly.length, madeOnly: madeOnly.length, pairs };
}

function excerpt(a, b, context = 60, max = 320) {
  const clip = (s) => (s.length > max ? `${s.slice(0, max)}…` : s);
  if (a === undefined || b === undefined) return { committed: a === undefined ? null : clip(a), made: b === undefined ? null : clip(b) };
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const cut = (x) => {
    const from = Math.max(0, p - context);
    const to = Math.min(x.length, x.length - s + context);
    return `${from > 0 ? '…' : ''}${clip(x.slice(from, to))}${to < x.length ? '…' : ''}`;
  };
  return { committed: cut(a), made: cut(b) };
}

function printRound(r) {
  const s8 = (x) => (x ? x.slice(0, 8) : '—');
  const printLines = (lines) => {
    for (const p of lines.pairs) {
      console.log(`        committed: ${p.committed ?? '(no line)'}`);
      console.log(`        made:      ${p.made ?? '(no line)'}`);
    }
  };
  for (const f of r.files) {
    const head = `${r.round.padEnd(4)} ${s8(r.commit)}  ${f.file.padEnd(16)}`;
    if (f.reproduces) {
      console.log(`${head}reproduces ${s8(f.committed)}`);
      continue;
    }
    const size = f.lines ? `; ${f.lines.committedOnly} line(s) only committed, ${f.lines.madeOnly} only made` : '';
    console.log(`${head}DOES NOT REPRODUCE: committed ${s8(f.committed)}, made ${s8(f.made)}${f.error ? ` (${f.error})` : ''}${size}`);
    if (f.lines) printLines(f.lines);
    if (!f.search) continue;
    const s = f.search;
    if (s.exact.length) {
      console.log(`      reproduced byte for byte by: ${s.exact.map((e) => `${e.change} (from ${e.from})`).join('; ')}  [${s.tried} tried]`);
    } else if (s.closest) {
      const c = s.closest;
      console.log(`      nothing tried reproduces it [${s.tried} tried]; closest: ${c.change} (from ${c.from}), ${c.lines.committedOnly} line(s) only committed, ${c.lines.madeOnly} only made`);
      printLines(c.lines);
    } else {
      console.log(`      nothing tried makes a file [${s.tried} tried]`);
    }
  }
}
