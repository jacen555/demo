// write-ledger — write inputs.md, the hash ledger, from the extraction manifests.
//
// inputs.md is the one file the extraction side writes into the repository. It names no
// local path: the input sets live outside the repository, and the ledger fixes them by
// hash before the answer key exists (README, "Protocol").
//
// It plans by default (printing the ledger) and writes nothing without --apply.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ALL_ROUNDS, EXIT, SPIKE_DIR, UsageError, assembleRubric, main, pathExists, sha256 } from './lib.mjs';

const USAGE = `
write-ledger — write inputs.md from the extraction manifests.

  node src/write-ledger.mjs --rubric-parts <dir>                      print the ledger
  node src/write-ledger.mjs --rubric-parts <dir> --apply [--replace]  write inputs.md

Options
  --work <dir>            the extraction's --work folder (default: <tmp>/vcb/work)
  --rubric-parts <dir>    the rubric's transport pieces and ORDER.txt
  --rubric-extra <file>   a rubric transport file kept but not assembled; repeatable
  --apply                 actually write inputs.md
  --replace               overwrite an existing inputs.md
  --help                  show this message

Exit codes: 0 success/plan · 1 failed · 2 bad usage
`.trimStart();

// The answer key leaves some of a round's items to be settled from its extraction, by rules
// it fixes, and asks for the result in this ledger before any coach run on the round
// (answer-key.md, "r1"). The judgement is committed beside the ledger, and checked here
// against the round's manifest.
const RESOLUTIONS = Object.freeze({ r1: 'r1-resolution.json' });
const RESOLVABLE = Object.freeze({
  r1: {
    'R1-04': ['objective', 'not catchable before render'],
    'R1-11': ['objective', 'craft', 'not in these inputs'],
  },
});

await main(async () => {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        work: { type: 'string' },
        'rubric-parts': { type: 'string' },
        'rubric-extra': { type: 'string', multiple: true, default: [] },
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
  if (!values['rubric-parts']) throw new UsageError(`--rubric-parts is required\n\n${USAGE}`);

  const work = path.resolve(values.work ?? path.join(os.tmpdir(), 'vcb', 'work'));
  // Each round folder holds a manifest (extracted) or a not-extracted record, never both.
  const records = [];
  for (const round of ALL_ROUNDS) {
    const [manifest, skipped] = ['manifest.json', 'not-extracted.json'].map((f) => path.join(work, round.id, f));
    const has = [await pathExists(manifest), await pathExists(skipped)];
    if (has[0] && has[1]) throw new Error(`${path.join(work, round.id)} holds both a manifest and a not-extracted record`);
    if (has[0] || has[1]) records.push(JSON.parse(await fs.readFile(has[0] ? manifest : skipped, 'utf8')));
  }
  const manifests = records.filter((m) => m.extracted !== false);
  if (!manifests.length) throw new UsageError(`no round manifests under ${work}; run extract-inputs.mjs --apply first`);
  const freshFile = path.join(work, 'freshness.json');
  const fresh = (await pathExists(freshFile)) ? JSON.parse(await fs.readFile(freshFile, 'utf8')) : null;
  const resolutions = new Map();
  for (const m of manifests) {
    if (!RESOLUTIONS[m.round]) continue;
    const file = path.join(SPIKE_DIR, RESOLUTIONS[m.round]);
    if (!(await pathExists(file))) {
      throw new Error(`${m.round} was extracted, and the answer key asks for its resolution in inputs.md before any coach run on it; write ${file} first`);
    }
    resolutions.set(m.round, JSON.parse(await fs.readFile(file, 'utf8')));
  }

  const isCommit = (m) => m.kind === 'commit-backed';
  const extractedSection = (m) => [reconstructedSection(m), ...(resolutions.has(m.round) ? [resolutionSection(m, resolutions.get(m.round))] : [])].join('\n');
  const sections = [
    ...records.filter(isCommit).map(roundSection),
    ...(fresh ? [freshnessSection(fresh, manifests)] : []),
    ...records.filter((m) => !isCommit(m)).map((m) => (m.extracted === false ? notExtractedSection(m) : extractedSection(m))),
  ];
  const text = [header(), environment(manifests), await rubricSection(values), ...sections].join('\n');
  const dest = path.join(SPIKE_DIR, 'inputs.md');
  if (!values.apply) {
    console.log(text);
    console.log(`\nplan only — would write ${dest}. Re-run with --apply.`);
    return EXIT.OK;
  }
  if ((await pathExists(dest)) && !values.replace) throw new UsageError(`${dest} exists; pass --replace to overwrite it`);
  await fs.writeFile(dest, text);
  const skippedIds = records.filter((m) => m.extracted === false).map((m) => m.round);
  console.log(
    `wrote ${dest} (rounds: ${manifests.map((m) => m.round).join(', ')}${skippedIds.length ? `; not extracted: ${skippedIds.join(', ')}` : ''}${fresh ? '; with freshness' : ''})`,
  );
  return EXIT.OK;
});

// Helpers are function declarations: the top-level await above runs before any const
// below it is initialised.
function code(s) {
  return s == null ? '—' : `\`${s}\``;
}

function table(head, rows) {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

function header() {
  return `# Inputs ledger

Written by \`src/write-ledger.mjs\` from the manifests \`src/extract-inputs.mjs\` leaves
beside each round's build. Do not edit it by hand; re-run the extraction and the ledger.

The files named here are kept outside the repository (README, "What git holds"). Paths
are relative to the extraction's output folder. A coach run reads exactly one of
\`<round>/pass1/\` or \`<round>/pass2/\`, plus \`rubric.md\`.

Git blob ids identify committed files. A file with no blob id was generated by the
extraction, and its SHA-256 is the only record of it.
`;
}

function environment(manifests) {
  const keys = ['node', 'npm', 'git', 'platform'];
  const first = manifests[0].tools;
  const differs = manifests.filter((m) => keys.some((k) => m.tools[k] !== first[k])).map((m) => m.round);
  if (differs.length) throw new Error(`rounds were extracted with different tools: ${differs.join(', ')}; re-extract them together`);
  return `## Environment

${table(['Tool', 'Version'], keys.map((k) => [k, code(first[k])]))}
`;
}

async function rubricSection(values) {
  const rubric = await assembleRubric(path.resolve(values['rubric-parts']));
  if (rubric.duplicates.length) throw new Error(`rubric has duplicate rule ids: ${rubric.duplicates.join(' ')}`);
  const file = path.join(SPIKE_DIR, 'rubric.md');
  if (!(await pathExists(file))) throw new Error('rubric.md does not exist; run assemble-rubric.mjs --apply first');
  const onDisk = await fs.readFile(file);
  const reproduces = onDisk.equals(Buffer.from(rubric.text, 'utf8'));
  if (!reproduces) throw new Error('rubric.md does not match its pieces; re-run assemble-rubric.mjs');

  const extras = [];
  for (const f of values['rubric-extra']) {
    const buf = await fs.readFile(path.resolve(f));
    extras.push([code(path.basename(f)), buf.length, code(sha256(buf))]);
  }
  const disclosures = rubric.pieces.flatMap((p) => p.removed.filter((l) => /^REGENERATED: /.test(l.trim())).map((l) => `- \`${p.name}\`: ${l.trim()}`));
  const briefFile = path.join(SPIKE_DIR, 'rubric-brief.md');
  if (!(await pathExists(briefFile))) throw new Error('rubric-brief.md does not exist');
  const brief = await fs.readFile(briefFile);
  return `## Rubric

\`rubric-brief.md\`: ${brief.length} bytes, SHA-256 ${code(sha256(brief))}. The rubric author's dispatch
prompt, verbatim.

\`rubric.md\`: ${onDisk.length} bytes, SHA-256 ${code(sha256(onDisk))}, ${rubric.ids.length} rules
(${rubric.ids.join(', ')}).

Joining the pieces below in this order, with transport lines removed, reproduces
\`rubric.md\` byte for byte. The ledger checks this each time it is written.

${table(['#', 'Piece', 'Bytes', 'SHA-256', 'Joined by'], rubric.pieces.map((p, i) => [i + 1, code(p.name), p.bytes, code(p.sha256), p.join]))}

A piece's name is the line of the session event log it was recovered from.

The author's disclosures, which travelled as transport lines and are not in \`rubric.md\`:

${disclosures.join('\n')}
${extras.length ? `\nKept, not assembled:\n\n${table(['File', 'Bytes', 'SHA-256'], extras)}\n` : ''}`;
}

function roundSection(m) {
  const pf = m.preFix;
  const ck = m.checkpoint;
  const diff = (c) => c.files.filter((f) => !f.same).map((f) => path.posix.basename(f.path));
  const nextLine = ck.next?.commit
    ? `Checkpoint #${ck.next.index} (${code(ck.next.commit)}) differs from the pre-fix state in: ${diff(ck.next).join(', ') || 'nothing'}.`
    : `Checkpoint #${ck.next?.index} does not exist.`;
  return `## Round ${m.round} (${m.kind})

- **Pre-fix state:** ${code(m.commit)}.
- **Pre-fix rule:** the first commit after it on ${code(m.lineage.ref)} (tip ${code(m.lineage.tip)}) that
  changes an input file is ${code(pf.firstFix)}, "${pf.firstFixSubject}". The last commit before that one
  to change an input file is ${code(pf.lastInputCommitBeforeFix)}: the rule **${pf.holds ? 'holds' : 'does not hold'}**.
- **Export:** ${m.export.files} files under ${m.export.roots.map(code).join(' and ')}, written from git's object
  store. ${m.export.verified} of ${m.export.files} re-hash to their blob ids.
- **Browser:** playwright ${code(m.tools.playwright)}, chromium ${code(m.tools.chromium)}, headless shell ${code(m.tools.headlessShell)}.
- **Layout audit:** ${m.layoutAudit}. **End card:** ${m.endCard}.

${table(['Engine file', 'Blob'], Object.entries(m.engine).map(([p, b]) => [code(p), code(b)]))}

${table(['Stage', 'Command', 'Exit'], m.stages.map((s) => [s.label, code(s.command), s.exitCode]))}

**Checkpoint cross-check.** Checkpoint #${ck.index} (${code(ck.commit)}):

${table(['File', 'Pre-fix blob', 'Checkpoint blob', 'Same'], ck.files.map((f) => [code(f.path), code(f.preFix), code(f.checkpoint), f.same ? 'yes' : '**no**']))}

${nextLine}

**Files.**

${table(['Pass', 'File', 'Git blob', 'SHA-256', 'Bytes', 'Note'], m.files.map((f) => [f.pass, code(`${m.round}/${f.file}`), code(f.blob), code(f.sha256), f.bytes, f.width ? `${f.width}×${f.height}` : (f.generated ?? '')]))}
`;
}

// A reconstructed round (README, "Input sets") is reported apart from the commit-backed
// ones, and its record is how it was rebuilt: the method's own evidence, the proof behind
// each regenerated file, and exactly what was written over the export.
function reconstructedSection(m) {
  const base = (p) => path.posix.basename(p);
  const state = statePart(m);
  const replaced = m.replaced.length
    ? table(['File', 'Why', 'Replaces blob', 'SHA-256', 'Bytes'], m.replaced.map((r) => [code(r.path), r.why, code(r.replacedBlob), code(r.sha256), r.bytes]))
    : "Nothing: every file the round uses is the tree's own.";
  const camera = !m.camera
    ? 'not run'
    : `${code(`preview.mjs`)} ${code(m.camera.preview)}; ${
        m.camera.overlay.length
          ? `given to the engine after its scene was built: ${m.camera.overlay.map((f) => `${code(base(f.path))} ${code(f.camera)} (the engine had ${f.engine ? code(f.engine) : 'none'})`).join(', ')}`
          : "the engine's own"
      }`;
  return `## Round ${m.round} (reconstructed: ${m.method})

${state}

**Regenerated files.** Each is made by the generator at the state, from the round's timing.json and the
state's observed files. It is used only if that generator first reproduces a real file byte for byte from
that file's own data files (README, "Regenerated files").

${regenerationTable(m)}

**Written over the export.**

${replaced}

- **Camera:** ${camera}.
- **Seek hook:** ${code(m.hook.pattern)} ${m.hook.found ? 'is' : '**is not**'} in ${code(m.hook.file)} after the scene build${m.hook.found ? '' : ', so the camera was not run'}.
- **Passes:** ${m.passes.join(' and ')}${m.passes.includes(2) ? '' : ' only'}.
- **Export:** ${m.export.files} files under ${m.export.roots.map(code).join(' and ')} at ${code(m.commit)}, written from
  git's object store. ${m.export.verified} of ${m.export.files} re-hash to their blob ids.
- **Browser:** playwright ${code(m.tools.playwright)}, chromium ${code(m.tools.chromium)}, headless shell ${code(m.tools.headlessShell)}.
- **Layout audit:** ${m.layoutAudit}. **End card:** ${m.endCard}.

${table(['Engine file', 'Blob'], Object.entries(m.engine).map(([p, b]) => [code(p), code(b)]))}

${table(['Stage', 'Command', 'Exit'], m.stages.map((s) => [s.label, code(s.command), s.exitCode]))}

**Files.** A file with a git blob is the tree's own; *regenerated* and *reconstructed* files have none.

${table(['Pass', 'File', 'Git blob', 'SHA-256', 'Bytes', 'Note'], m.files.map((f) => [f.pass, code(`${m.round}/${f.file}`), code(f.blob), code(f.sha256), f.bytes, f.width ? `${f.width}×${f.height}` : (f.generated ?? f.note ?? '')]))}
`;
}

function regenerationTable(m) {
  const base = (p) => path.posix.basename(p);
  return table(['File', 'Generator', 'Proof', 'Regenerated', 'Used by'], m.regeneration.map((f) => [code(f.file), `${code(base(f.generator))} ${code(f.generatorBlob)}`, proofCell(f), regeneratedCell(f), f.proof.provenAt ? `pass ${f.passes.join(', ')}` : '**no pass**']));
}

// A reconstructed round the protocol does not extract is still reported: why it was left
// out, and the same evidence an extracted round's section gives (README, "Amendment 6", 1).
function notExtractedSection(m) {
  const state = statePart(m);
  const regen = m.regeneration.length
    ? `
**Regenerated files.** The same proof an extracted round's files are given (README, "Regenerated files").
A round whose script.md has no proven generator has no pass 1, so it is not extracted (README,
"Amendments", 1).

${regenerationTable(m)}
`
    : '';
  return `## Round ${m.round} (reconstructed: ${m.method}): not extracted

**Not extracted:** ${m.why.join('; ')}. No input set was made for it, so it has no coach run and is not
scored.

${state}
${regen}`;
}

// Are the commit-backed rounds' generated inputs what their own pipeline makes from their
// own data? The inputs are the committed files either way (README, "Amendment 6", 2).
function freshnessSection(fresh, manifests) {
  const s8 = (x) => (x ? x.slice(0, 8) : null);
  const byRound = new Map(manifests.map((m) => [m.round, m]));
  for (const r of fresh.rounds) {
    const m = byRound.get(r.round);
    if (m && m.commit !== r.commit) throw new Error(`freshness.json checked ${r.round} at ${r.commit}, but it was extracted at ${m.commit}`);
  }
  const dataFiles = Object.keys(fresh.rounds[0]?.data ?? {});
  const rows = fresh.rounds.flatMap((r) =>
    r.files.map((f) => [r.round, code(f.file), `${code(path.posix.basename(f.generator))} ${code(s8(f.generatorBlob))}`, code(f.committed), f.made ? code(f.made) : `failed (${f.error})`, f.reproduces ? 'yes' : '**no**']),
  );
  const details = fresh.rounds.flatMap((r) =>
    r.files
      .filter((f) => !f.reproduces)
      .map((f) => {
        const size = (l) => `${l.committedOnly} line(s) only in the committed file, ${l.madeOnly} only in the one made`;
        const own = f.lines ? `${size(f.lines)}:\n\n${excerptBlock(f.lines)}` : 'no file was made.';
        let search = '';
        if (f.search) {
          const tried = `${f.search.tried} single change(s) to the state's data were tried`;
          if (f.search.exact.length) {
            search = `\n\n${tried}. Reproduced byte for byte by: ${f.search.exact.map((e) => `${e.change} (from ${e.from})`).join('; ')}.`;
          } else if (f.search.closest) {
            const c = f.search.closest;
            search = `\n\n${tried}, and none reproduces it. The closest is ${c.change} (from ${c.from}): ${size(c.lines)}:\n\n${excerptBlock(c.lines)}`;
          } else {
            search = `\n\n${tried}, and none makes a file.`;
          }
        }
        return `**${r.round} ${code(f.file)}.** Made from the state's own data: ${own}${search}`;
      }),
  );
  return `## Freshness of the commit-backed rounds

From \`freshness.json\`, which \`src/check-freshness.mjs\` writes beside the round folders (node
${code(fresh.node)}). At each round's pre-fix state, both generators were run on the state's own committed
data files, and what they made was compared with the state's committed file. A round's inputs are its
committed files whatever this finds: it records which of them the round's own pipeline would not have made.

${table(['Round', 'File', 'Generator', 'Committed', 'Made', 'Reproduces'], rows)}

The data files each state holds:

${table(['Round', ...dataFiles.map(code)], fresh.rounds.map((r) => [r.round, ...dataFiles.map((d) => code(r.data[d]) )]))}

A candidate change is one data file replaced by another version of it (from a commit up to the state, or a
session checkpoint up to the round's), an observed file removed, or timing.json replaced by the rebuilt
timeline of a reconstructed round based on the same commit. The generators are always the state's.
${details.length ? `\n${details.join('\n\n')}\n` : '\nEvery file reproduces.\n'}`;
}

// Excerpts are shown as code, in a fence longer than any backtick run inside them.
function excerptBlock(lines) {
  const body = lines.pairs.flatMap((p) => [`committed: ${p.committed ?? '(no line)'}`, `made:      ${p.made ?? '(no line)'}`]);
  const longest = Math.max(0, ...body.map((l) => Math.max(0, ...[...l.matchAll(/`+/g)].map((x) => x[0].length))));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${body.join('\n')}\n${fence}`;
}

function statePart(m) {
  if (m.method === 'restore-fields') return restoreFieldsPart(m);
  if (m.method === 'checkpoint') return checkpointPart(m);
  return snapshotRulePart(m);
}

function restoreFieldsPart(m) {
  const rec = m.reconstruction;
  const yes = (b) => (b ? 'yes' : '**no**');
  const mark = { before: 'before', after: 'after', other: '**other**' };
  const first = rec.checkpoints[0]?.index;
  return `- **State:** never committed. The base ${code(rec.base.commit)}, with the ${rec.fields.length} fields that
  ${code(rec.script.path)} (${code(rec.script.blob)}) writes put back from ${code(rec.restoreFrom.commit)}.
- **Method:** the base's timing.json (${code(rec.base.timingBlob)}) re-serialises unchanged: ${yes(rec.roundTrips)}.
  The script, run on the rebuilt file, gives back the base's byte for byte: ${yes(rec.scriptGivesBase)}${rec.script.error ? ` (${rec.script.error})` : ''}.
  Every field differs from the base: ${yes(rec.fields.every((f) => f.differs))}. The method **${rec.holds ? 'holds' : 'does not hold'}**.
- **Rebuilt timing.json:** ${rec.timing.bytes} bytes, SHA-256 ${code(rec.timing.sha256)}.

${table(['Field', 'Base value', 'Restored value', 'Differs'], rec.fields.map((f) => [code(f.field), code(f.baseSha), code(f.restoredSha), yes(f.differs)]))}

A value is shown as the first 12 hex digits of the git blob id of its canonical JSON.

**Checkpoint scan.** Where the fields stand in each checkpoint from #${first} on: *before* is the restored
value, *after* the base's, *other* neither.

${table(['Checkpoint', 'Commit', 'timing.json blob', ...rec.fields.map((f) => code(f.field))], rec.checkpoints.map((c) => [`#${c.index}`, code(c.commit), code(c.timingBlob), ...(c.timingBlob ? c.fields.map((v) => mark[v]) : rec.fields.map(() => '—'))]))}`;
}

function snapshotRulePart(m) {
  const rec = m.reconstruction;
  const present = (r) => {
    if (r.status === 'script fails') return r.error ?? '';
    if (!r.present) return '—';
    const n = `${r.present.length} of ${rec.live.length}`;
    return r.status === 'partial' ? `${n}: ${r.present.map(code).join(', ')}` : n;
  };
  const noop = rec.noop.length
    ? ` The script changes ${rec.noop.map(code).join(', ')} in no checkpoint, so ${rec.noop.length === 1 ? 'it cannot' : 'they cannot'} mark a state and ${rec.noop.length === 1 ? 'is' : 'are'} left out.`
    : '';
  const state = m.state
    ? `- **State:** checkpoint #${m.state.index} (${code(m.state.commit)}): the latest session checkpoint holding none of the
  edits ${code(rec.script.path)} (${code(rec.script.blob)}, at the lineage tip) makes, where the next one holds them
  all.`
    : `- **State:** none. No session checkpoint holding none of the edits ${code(rec.script.path)} (${code(rec.script.blob)},
  at the lineage tip) makes is followed by one holding them all.`;
  return `${state} Run on a checkpoint's timing.json, the script changes a field exactly when that field's edit is not there yet.
- **Fields:** ${rec.live.length} of ${rec.fields.length} change in some checkpoint.${noop}
- **Transitions** (a *none* checkpoint followed by an *all* one): after ${rec.transitions.map((i) => `#${i}`).join(', ') || 'none'}.
  The method **${rec.holds ? 'holds' : 'does not hold'}** (it needs exactly one).

${table(['Checkpoint', 'Commit', 'timing.json blob', 'Status', 'Edits present'], rec.rows.map((r) => [`#${r.index}`, code(r.commit), code(r.timingBlob), r.status, present(r)]))}`;
}

// The state is one session checkpoint as it stands (README, "Amendment 8").
function checkpointPart(m) {
  const rec = m.reconstruction;
  const ck = rec.checkpoint;
  const base = (p) => path.posix.basename(p);
  return `- **Descriptive only.** ${m.round} is reported on its own and counts toward neither bar (README, "Why r1 is
  descriptive only").
- **State:** checkpoint #${ck.index} (${code(ck.commit)}) as it stands: the checkpoint taken at the relay of the
  round's review (README, "Amendment 7", item 9). Its own timing.json (${code(ck.timingBlob)}) is the round's. The
  method **${rec.holds ? 'holds' : 'does not hold'}** (it needs the checkpoint to have a timing.json).
- **Proof of a stale file.** The state is a session checkpoint, so a generator that does not reproduce the state's
  own file may be proven at an earlier checkpoint, as a snapshot round's may (README, "Amendment 8").
- **Neighbouring checkpoints.** The input files and the scene builder at each checkpoint out from the state, on each
  side as far as the first that differs.

${table(['Checkpoint', 'Commit', ...rec.compared.map((p) => code(base(p))), 'Same as the state'], rec.rows.map((r) => [`#${r.index}`, code(r.commit), ...r.files.map(code), r.index === ck.index ? '(the state)' : r.same ? 'yes' : '**no**']))}`;
}

// How the answer key's rules for a round were settled from its extraction, checked against
// the round's manifest: every segment must be the round's, and every piece of evidence one of
// its input files, cited by the SHA-256 the ledger records for it.
function resolutionSection(m, res) {
  const allowed = RESOLVABLE[m.round];
  if (res.round !== m.round) throw new Error(`${RESOLUTIONS[m.round]} is for round ${res.round}, not ${m.round}`);
  if (res.state !== m.commit) throw new Error(`${RESOLUTIONS[m.round]} was written against ${res.state}, but ${m.round} was extracted at ${m.commit}`);
  const ids = res.items.map((i) => i.id);
  if (ids.join() !== Object.keys(allowed).join()) throw new Error(`${RESOLUTIONS[m.round]} must resolve ${Object.keys(allowed).join(', ')}, in that order; it has ${ids.join(', ')}`);
  const files = new Map(m.files.map((f) => [`${m.round}/${f.file}`, f]));
  const rows = res.items.map((item) => {
    if (!allowed[item.id].includes(item.class)) throw new Error(`${item.id}: "${item.class}" is not one of the key's classes for it: ${allowed[item.id].join(', ')}`);
    if (item.segment != null && !m.segments.includes(item.segment)) throw new Error(`${item.id}: ${item.segment} is not one of ${m.round}'s segments`);
    if (item.segment == null && item.class !== 'not in these inputs') throw new Error(`${item.id}: only "not in these inputs" may name no segment`);
    if (!item.evidence?.length) throw new Error(`${item.id}: no evidence named`);
    if (typeof item.shows !== 'string' || !item.shows.trim() || /[|\r\n]/.test(item.shows)) throw new Error(`${item.id}: "shows" must be one line of text, with no "|"`);
    const evidence = item.evidence.map((e) => {
      const f = files.get(e);
      if (!f) throw new Error(`${item.id}: ${e} is not one of ${m.round}'s input files`);
      return `${code(e)} (SHA-256 ${code(f.sha256.slice(0, 16))}…)`;
    });
    return [item.id, item.segment ? code(item.segment) : '—', item.class, evidence.join(', '), item.shows];
  });
  return `### The answer key's rules for ${m.round}, resolved

From \`${RESOLUTIONS[m.round]}\`, committed with this ledger and checked against the round's manifest. The answer key
fixes these rules, and asks for the result here before any coach run on ${m.round} (answer-key.md, "${m.round}").

**Segment numbers.** The user's segment numbers are the render's order:

${table(['Number', 'Segment'], m.segments.map((s, i) => [i + 1, code(s)]))}

${table(['Item', 'Segment', 'Class', 'Evidence', 'What the inputs show'], rows)}
`;
}

function proofCell(f) {
  const p = f.proof;
  const tried = p.tried.length ? ` Earlier checkpoints tried: ${p.tried.map((t) => `#${t.index} ${t.reproduces ? 'yes' : 'no'}`).join(', ')}.` : '';
  if (p.atState.reproduces) return `Reproduces the state's ${code(p.atState.committed)}.`;
  const atState = p.atState.output === null
    ? `At the state it fails (${p.atState.error}).`
    : `At the state it makes ${code(p.atState.output)}, not the state's ${code(p.atState.committed)}.`;
  if (p.provenAt) return `${atState} Reproduces checkpoint #${p.provenAt.index}'s ${code(p.provenAt.file)}.${tried}`;
  return `**Not proven.** ${atState}${tried}`;
}

function regeneratedCell(f) {
  const r = f.regenerated;
  if (r.blob === null) return `failed: exit ${r.exitCode} (${r.error})`;
  return `exit ${r.exitCode}; ${r.blob === f.committed ? "the same bytes as the state's file" : "differs from the state's file"}`;
}
