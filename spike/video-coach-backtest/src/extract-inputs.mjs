// extract-inputs — rebuild each round's pre-fix inputs for the coach, outside the repository.
//
// For each round it writes the round's engine and project trees from git's object store,
// byte for byte, and re-hashes every file against its blob id. A reconstructed round then
// has its rebuilt timing.json and its regenerated script.md and storyboard.html written over
// the export (src/reconstruct.mjs). It installs dependencies from the committed lockfiles,
// builds the scene with the round's own engine, and takes one still per segment with the
// single pinned camera. Last, it collects the two input sets and a manifest that
// write-ledger.mjs turns into inputs.md.
//
// It plans by default and writes nothing without --apply.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  ALL_ROUNDS,
  CAMERA_BLOB,
  CAMERA_FILES,
  CHECKPOINT_NS,
  ENGINE,
  EXIT,
  INPUT_FILES,
  LINEAGE_REF,
  PROJECT,
  UsageError,
  assertOutsideRepository,
  git,
  gitBlobId,
  gitText,
  listTree,
  main,
  pathExists,
  pngSize,
  prepareFreshDir,
  readBlobs,
  repoRoot,
  run,
  safeJoin,
  sha256,
} from './lib.mjs';
import { planCheckpoint, planRegeneration, planRestoreFields, planSnapshotRule, readBlob } from './reconstruct.mjs';

const USAGE = `
extract-inputs — rebuild each round's pre-fix inputs for the coach, outside the repository.

  node src/extract-inputs.mjs                           plan every round (writes nothing)
  node src/extract-inputs.mjs --apply                   extract every round
  node src/extract-inputs.mjs --apply --round r4 --round r7

Options
  --round <id>   round to extract; repeatable (default: every round): ${ALL_ROUNDS.map((r) => r.id).join(' ')}
  --out <dir>    where the coach's input sets go (default: <tmp>/vcb/inputs)
  --work <dir>   where each round is exported and built (default: <tmp>/vcb/work)
  --apply        actually extract. Without it nothing is written.
  --replace      rebuild a round folder this tool created earlier
  --help         show this message

Both folders must be outside every checkout of this repository.
Exit codes: 0 success/plan · 1 a stage failed · 2 bad usage
`.trimStart();

const SCENE_BUILD = ['../SizzleCraft/src/write-build-html.mjs', '--apply'];
const CAMERA = ['../SizzleCraft/src/preview.mjs', '--apply'];
const NPM_CI = ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'];
// The seek hook the camera drives (README, "Amendments", 3). Without it every still would
// show the same moment.
const SEEK_HOOK = /window\.masterTimeline\s*=/;

await main(async () => {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        round: { type: 'string', multiple: true, default: [] },
        out: { type: 'string' },
        work: { type: 'string' },
        apply: { type: 'boolean', default: false },
        replace: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
  } catch (err) {
    throw new UsageError(`${err.message}\n\n${USAGE}`);
  }
  const { values } = parsed;
  if (values.help) {
    console.log(USAGE);
    return EXIT.OK;
  }
  const unknown = values.round.filter((id) => !ALL_ROUNDS.some((r) => r.id === id));
  if (unknown.length) throw new UsageError(`unknown round(s): ${unknown.join(', ')}`);
  const rounds = values.round.length ? ALL_ROUNDS.filter((r) => values.round.includes(r.id)) : ALL_ROUNDS;

  const out = path.resolve(values.out ?? path.join(os.tmpdir(), 'vcb', 'inputs'));
  const work = path.resolve(values.work ?? path.join(os.tmpdir(), 'vcb', 'work'));
  const repo = await repoRoot();
  await assertOutsideRepository(repo, { out, work });

  const lineageTip = await gitText(repo, ['rev-parse', '--verify', `${LINEAGE_REF}^{commit}`]);
  const plans = [];
  for (const round of rounds) {
    plans.push(round.kind === 'commit-backed' ? await planRound(repo, round, lineageTip) : await planReconstructed(repo, round, lineageTip));
  }

  for (const p of plans) {
    if (p.round.kind === 'commit-backed') printCommitPlan(p);
    else printReconstructedPlan(p);
    console.log(`    work ${path.join(work, p.round.id)}${(await pathExists(path.join(work, p.round.id))) ? ' (exists)' : ''}`);
    console.log(`    out  ${path.join(out, p.round.id)}${(await pathExists(path.join(out, p.round.id))) ? ' (exists)' : ''}`);
  }
  // A commit-backed round that does not hold means the round table is wrong, and a state
  // without both lockfiles stops the extraction (README, "Amendments", 5). Any other
  // reconstructed round that does not hold is a result, not a fault: it is not extracted,
  // and its record says why (README, "Amendments", 1, and "Amendment 6", 1).
  const broken = plans.filter((p) => p.round.kind === 'commit-backed' && !p.holds);
  if (broken.length) {
    throw new Error(`round table disagrees with the protocol for: ${broken.map((p) => p.round.id).join(', ')}`);
  }
  const unlocked = plans.filter((p) => p.missingLocks?.length);
  if (unlocked.length) {
    const which = unlocked.map((p) => `${p.round.id} (${p.missingLocks.join(', ')})`).join('; ');
    throw new Error(`no package-lock.json at the state of: ${which}. The extraction stops (README, "Amendments", 5)`);
  }
  for (const p of plans.filter((x) => !x.holds)) console.log(`\n${p.round.id}: not extracted: ${notExtractedWhy(p).join('; ')}`);
  if (!values.apply) {
    console.log('\nplan only — nothing written. Re-run with --apply to extract.');
    return EXIT.OK;
  }

  const tools = await toolVersions();
  for (const p of plans) {
    if (p.holds) await extractRound(repo, p, { out, work, replace: values.replace, tools, lineageTip });
    else await recordNotExtracted(p, { out, work, replace: values.replace, lineageTip });
  }
  console.log(`\ndone. Next: node src/write-ledger.mjs --work ${work} ... --apply`);
  return EXIT.OK;
});

async function planRound(repo, round, lineageTip) {
  const inputs = INPUT_FILES.map((f) => `${PROJECT}/${f}`);
  const fixes = (await gitText(repo, ['rev-list', '--reverse', '--ancestry-path', `${round.commit}..${lineageTip}`, '--', ...inputs]))
    .split('\n')
    .filter(Boolean);
  const firstFix = fixes[0] ?? null;
  const lastInputCommitBeforeFix = firstFix ? await gitText(repo, ['rev-list', '-1', `${firstFix}^`, '--', ...inputs]) : null;
  const preFix = {
    firstFix,
    firstFixSubject: firstFix ? await gitText(repo, ['log', '-1', '--format=%s', firstFix]) : null,
    lastInputCommitBeforeFix,
    holds: firstFix !== null && lastInputCommitBeforeFix === round.commit,
  };
  const entries = await listTree(repo, round.commit, [ENGINE, PROJECT]);
  const cameraBlob = entries.find((e) => e.path === `${ENGINE}/src/preview.mjs`)?.oid ?? null;
  const checkpoint = await crossCheck(repo, round, entries);
  // A commit-backed round's engine is where the camera came from, so it must need nothing.
  const cameraOverlay = cameraOverlayFor(entries);
  return {
    round,
    preFix,
    entries,
    cameraBlob,
    checkpoint,
    stateCommit: round.commit,
    replace: [],
    cameraOverlay,
    passes: [1, 2],
    holds: preFix.holds && cameraBlob === CAMERA_BLOB && cameraOverlay.length === 0,
  };
}

function printCommitPlan(p) {
  console.log(`${p.round.id}  ${p.round.kind}  ${p.round.commit}`);
  console.log(`    pre-fix rule: ${p.preFix.holds ? 'holds' : 'DOES NOT HOLD'}` +
    ` (first fix ${p.preFix.firstFix ?? 'none'}${p.preFix.firstFixSubject ? ` "${p.preFix.firstFixSubject}"` : ''})`);
  console.log(`    export: ${p.entries.length} files; camera ${p.cameraBlob === CAMERA_BLOB && !p.cameraOverlay.length ? 'is' : 'IS NOT'} the pinned ${CAMERA_BLOB.slice(0, 8)}`);
  const same = (ck) => (ck.commit ? ck.files.map((f) => `${path.posix.basename(f.path)} ${f.same ? 'same' : 'DIFFERS'}`).join(', ') : 'absent');
  console.log(`    checkpoint #${p.checkpoint.index} ${p.checkpoint.commit.slice(0, 8)}: ${same(p.checkpoint)}`);
  console.log(`    checkpoint #${p.checkpoint.next.index} ${p.checkpoint.next.commit?.slice(0, 8) ?? ''}: ${same(p.checkpoint.next)}`);
}

// The camera's three files against the engine's (README, "Amendments", 2). Each one that
// differs is given to the engine after its own scene is built.
function cameraOverlayFor(entries) {
  return Object.entries(CAMERA_FILES)
    .map(([rel, oid]) => ({ path: `${ENGINE}/${rel}`, engine: entries.find((e) => e.path === `${ENGINE}/${rel}`)?.oid ?? null, camera: oid }))
    .filter((f) => f.engine !== f.camera);
}

async function planReconstructed(repo, round, lineageTip) {
  let rec;
  let state;
  if (round.method === 'restore-fields') {
    rec = await planRestoreFields(repo, round);
    state = { commit: round.commit, index: null, timing: rec.timing.buf };
  } else if (round.method === 'snapshot-rule') {
    rec = await planSnapshotRule(repo, round, lineageTip);
    if (!rec.chosen) return { round, rec, state: null, holds: false };
    state = { commit: rec.chosen.commit, index: rec.chosen.index, timing: await readBlob(repo, rec.chosen.timingBlob) };
  } else if (round.method === 'checkpoint') {
    rec = await planCheckpoint(repo, round);
    if (!rec.holds) return { round, rec, state: null, holds: false };
    state = { commit: rec.checkpoint.commit, index: rec.checkpoint.index, timing: await readBlob(repo, rec.checkpoint.timingBlob) };
  } else {
    throw new Error(`${round.id}: unknown method "${round.method}"`);
  }
  const regen = await planRegeneration(repo, round, state);
  const entries = await listTree(repo, state.commit, [ENGINE, PROJECT]);
  const committedBlob = (rel) => entries.find((e) => e.path === rel)?.oid ?? null;
  // Written over the export: the rebuilt timing.json and each proven regenerated file, where
  // its bytes differ from the state's own.
  const candidates = [
    { path: `${PROJECT}/timing.json`, buf: state.timing, why: 'reconstructed' },
    ...regen.files.filter((f) => f.buf).map((f) => ({ path: `${PROJECT}/${f.file}`, buf: f.buf, why: 'regenerated' })),
  ];
  const replace = candidates
    .map((c) => ({ ...c, blob: gitBlobId(c.buf), committed: committedBlob(c.path) }))
    .filter((c) => c.blob !== c.committed);
  const missingLocks = [ENGINE, PROJECT].filter((root) => !committedBlob(`${root}/package-lock.json`));
  return {
    round,
    rec,
    state,
    regen,
    entries,
    stateCommit: state.commit,
    replace,
    regenerated: regen.files.filter((f) => f.buf).map((f) => `${PROJECT}/${f.file}`),
    cameraOverlay: cameraOverlayFor(entries),
    missingLocks,
    passes: regen.passes,
    holds: rec.holds && regen.holds && missingLocks.length === 0,
  };
}

function printReconstructedPlan(p) {
  const { round, rec } = p;
  const s8 = (x) => (x ? x.slice(0, 8) : '—');
  const yes = (b) => (b ? 'yes' : 'NO');
  const where = p.state ? `${p.state.commit}${p.state.index != null ? ` = checkpoint #${p.state.index}` : ''}` : 'no state chosen';
  console.log(`${round.id}  reconstructed (${round.method})  ${where}`);
  if (round.method === 'restore-fields') {
    console.log(`    base ${s8(rec.base.commit)}; ${rec.fields.length} fields restored from ${s8(rec.restoreFrom.commit)}, ${rec.fields.filter((f) => f.differs).length} of them differ`);
    console.log(`    base re-serialises unchanged: ${yes(rec.roundTrips)}; ${round.script} turns the rebuilt file back into the base: ${yes(rec.scriptGivesBase)}${rec.script.error ? ` (${rec.script.error})` : ''}`);
    const mark = { before: 'b', after: 'a', other: 'o' };
    printWrapped('checkpoints (b = restored value, a = base value, o = other):', rec.checkpoints.map((c) => `#${c.index} ${c.timingBlob ? c.fields.map((f) => mark[f]).join('') : '-'}`));
  } else if (round.method === 'checkpoint') {
    printWrapped('input files against the state:', rec.rows.map((r) => `#${r.index} ${r.index === rec.checkpoint.index ? 'state' : r.same ? 'same' : 'DIFFER'}`));
  } else {
    console.log(`    ${round.script} (${s8(rec.script.blob)}): ${rec.live.length} of ${rec.fields.length} fields change somewhere${rec.noop.length ? `; no-op: ${rec.noop.join(', ')}` : ''}`);
    printWrapped('checkpoints:', rec.rows.map((r) => `#${r.index} ${r.status}`));
    console.log(`    transitions (none, then all): after #${rec.transitions.join(', #') || '(none)'}`);
  }
  console.log(`    method ${rec.holds ? 'holds' : 'DOES NOT HOLD'}`);
  if (!p.state) return;
  for (const f of p.regen.files) {
    const pr = f.proof;
    const proven = pr.provenAt
      ? pr.atState.reproduces
        ? 'reproduces the file at the state'
        : `stale at the state; reproduces checkpoint #${pr.provenAt.index}'s file`
      : `NOT PROVEN (at the state: ${pr.atState.error ?? 'output differs'}; ${pr.tried.length} earlier checkpoint(s) tried)`;
    const made = f.regenerated.blob === null
      ? `regeneration failed: ${f.regenerated.error}`
      : f.regenerated.blob === f.committed ? "regenerated: same bytes as the state's file" : "regenerated: differs from the state's file";
    console.log(`    ${f.file}: ${path.posix.basename(f.generator)} ${s8(f.generatorBlob)} ${proven}; ${made}`);
  }
  console.log(`    written over the export: ${p.replace.map((r) => `${path.posix.basename(r.path)} (${r.why})`).join(', ') || 'nothing'}`);
  console.log(`    passes: ${p.passes.join(', ') || 'none'}`);
  console.log(`    lockfiles: ${p.missingLocks.length ? `MISSING under ${p.missingLocks.join(', ')}` : 'engine and project'}`);
  const cam = p.cameraOverlay.length
    ? `${p.cameraOverlay.map((f) => path.posix.basename(f.path)).join(', ')} given to the engine after its scene is built`
    : "the engine's own";
  console.log(`    export: ${p.entries.length} files; camera: ${cam}`);
}

function printWrapped(label, items, width = 100) {
  let line = `    ${label}`;
  for (const it of items) {
    if (line.length + it.length + 2 > width) {
      console.log(line);
      line = '     ';
    }
    line += `  ${it}`;
  }
  console.log(line);
}

async function blobsAt(repo, commit, paths) {
  const raw = (await git(repo, ['ls-tree', '-z', '--full-tree', commit, '--', ...paths])).toString('utf8');
  const map = Object.fromEntries(paths.map((p) => [p, null]));
  for (const rec of raw.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    map[rec.slice(tab + 1)] = rec.slice(0, tab).split(' ')[2];
  }
  return map;
}

async function checkpointAt(repo, index) {
  const ns = `${CHECKPOINT_NS}${String(index).padStart(20, '0')}/`;
  const refs = (await gitText(repo, ['for-each-ref', '--format=%(objectname) %(refname)', ns])).split('\n').filter(Boolean);
  if (refs.length > 1) throw new Error(`expected one checkpoint under ${ns}, found ${refs.length}`);
  if (!refs.length) return null;
  const [commit, ref] = refs[0].split(' ');
  return { index, commit, ref };
}

// README, "Checkpoint cross-check": does the last checkpoint before the fix hold the same
// input files as the pre-fix state? The next checkpoint is recorded too, so the ledger shows
// whether the named one really is the last before the inputs changed.
async function crossCheck(repo, round, entries) {
  const compared = [...INPUT_FILES.map((f) => `${PROJECT}/${f}`), `${ENGINE}/src/write-build-html.mjs`];
  const at = Object.fromEntries(compared.map((p) => [p, entries.find((e) => e.path === p)?.oid ?? null]));
  const describe = async (index) => {
    const ck = await checkpointAt(repo, index);
    if (!ck) return { index, commit: null };
    const blobs = await blobsAt(repo, ck.commit, compared);
    return { ...ck, files: compared.map((p) => ({ path: p, preFix: at[p], checkpoint: blobs[p], same: blobs[p] === at[p] })) };
  };
  const named = await describe(round.checkpoint);
  if (!named.commit) throw new Error(`checkpoint #${round.checkpoint} for ${round.id} not found under ${CHECKPOINT_NS}`);
  return { ...named, next: await describe(round.checkpoint + 1) };
}

async function toolVersions() {
  const npmCli = npmCliPath();
  const npm = await run(process.execPath, [npmCli, '--version']);
  return {
    node: process.version,
    npm: npm.stdout.toString('utf8').trim(),
    git: (await run('git', ['--version'])).stdout.toString('utf8').trim().replace(/^git version /, ''),
    platform: `${process.platform} ${process.arch}`,
  };
}

function npmCliPath() {
  return path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

async function stage(label, cwd, args, display) {
  const r = await run(process.execPath, args, { cwd });
  return { label, display, exitCode: r.code, stdout: r.stdout.toString('utf8'), stderr: r.stderr.toString('utf8') };
}

// The coach must learn nothing from where the files were built: absolute paths become
// placeholders, and any local path that survives stops the round.
function makeScrubber(pairs) {
  const variants = [];
  for (const [abs, placeholder] of pairs) {
    for (const v of new Set([abs, abs.replace(/\\/g, '/'), abs.replace(/\\/g, '\\\\')])) variants.push([v, placeholder]);
  }
  variants.sort((a, b) => b[0].length - a[0].length);
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (text) => variants.reduce((t, [v, ph]) => t.replace(new RegExp(escape(v), 'gi'), ph), text);
}

function assertNoLocalPath(text, what) {
  const user = os.userInfo().username;
  const leaks = [];
  if (user && text.toLowerCase().includes(user.toLowerCase())) leaks.push(`the username "${user}"`);
  const drive = /\b[A-Za-z]:[\\/]/.exec(text);
  if (drive) leaks.push(`an absolute path near "${text.slice(Math.max(0, drive.index - 20), drive.index + 40)}"`);
  if (leaks.length) throw new Error(`${what} still contains ${leaks.join(' and ')} after scrubbing`);
}

function transcript(stages) {
  return stages
    .map((s) => {
      const lines = [`$ ${s.display}`];
      if (s.stdout.trim()) lines.push(s.stdout.replace(/\s+$/, ''));
      if (s.stderr.trim()) lines.push('--- stderr ---', s.stderr.replace(/\s+$/, ''));
      lines.push(`exit code: ${s.exitCode}`);
      return lines.join('\n');
    })
    .join('\n\n') + '\n';
}

async function extractRound(repo, plan, { out, work, replace, tools, lineageTip }) {
  const { round, entries } = plan;
  const reconstructed = round.kind !== 'commit-backed';
  console.log(`\n== ${round.id} (${plan.stateCommit.slice(0, 8)})`);
  const workRoot = path.join(work, round.id);
  const outRoot = path.join(out, round.id);
  await prepareFreshDir(workRoot, replace);
  await prepareFreshDir(outRoot, replace);

  // 1. Export, byte for byte from the object store; then prove it by re-hashing from disk.
  const blobs = await readBlobs(repo, entries.map((e) => e.oid));
  for (const e of entries) {
    const dest = safeJoin(workRoot, e.path);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, blobs.get(e.oid), { flag: 'wx' });
  }
  let verified = 0;
  for (const e of entries) if (gitBlobId(await fs.readFile(safeJoin(workRoot, e.path))) === e.oid) verified++;
  if (verified !== entries.length) throw new Error(`${round.id}: only ${verified}/${entries.length} exported files match their blob ids`);
  console.log(`    exported ${entries.length} files, ${verified} re-hashed against their blob ids`);

  // A reconstructed round's reconstructed timing.json and regenerated files go over the
  // export, and are re-hashed from disk the same way.
  for (const r of plan.replace) {
    const dest = safeJoin(workRoot, r.path);
    await fs.writeFile(dest, r.buf);
    if (gitBlobId(await fs.readFile(dest)) !== r.blob) throw new Error(`${round.id}: ${r.path} did not read back as written`);
  }
  if (plan.replace.length) {
    console.log(`    written over the export: ${plan.replace.map((r) => `${path.posix.basename(r.path)} (${r.why})`).join(', ')}`);
  }

  const projectDir = safeJoin(workRoot, PROJECT);
  const engineDir = safeJoin(workRoot, ENGINE);

  // 2. Dependencies, from the committed lockfiles. No install scripts run, and a tree without
  // a lockfile stops here: npm install would resolve today's versions (README, "Amendments", 5).
  for (const root of [ENGINE, PROJECT]) {
    if (!entries.some((e) => e.path === `${root}/package-lock.json`)) {
      throw new Error(`${round.id}: ${root}/package-lock.json is not in the tree, and npm install is never used in its place`);
    }
  }
  const installs = [];
  for (const [label, dir] of [['engine', engineDir], ['project', projectDir]]) {
    const s = await stage(`npm ci (${label})`, dir, [npmCliPath(), ...NPM_CI], `npm ${NPM_CI.join(' ')}`);
    installs.push({ label: s.label, command: s.display, exitCode: s.exitCode });
    if (s.exitCode !== 0) throw new Error(`${round.id}: ${s.label} exited ${s.exitCode}\n${s.stderr.trim().split('\n').slice(-15).join('\n')}`);
    console.log(`    ${s.label}: exit 0`);
  }

  // 3. Scene build with the round's own engine, then the one camera.
  const scene = await stage('scene build', projectDir, SCENE_BUILD, `node ${SCENE_BUILD.join(' ')}`);
  console.log(`    scene build: exit ${scene.exitCode}`);
  if (scene.exitCode !== 0) throw new Error(`${round.id}: scene build exited ${scene.exitCode}\n${scene.stderr.trim()}`);

  let passes = plan.passes;
  let hook = null;
  if (reconstructed) {
    const html = await fs.readFile(path.join(projectDir, 'video-auto.html'), 'utf8');
    hook = { file: `${PROJECT}/video-auto.html`, pattern: SEEK_HOOK.source, found: SEEK_HOOK.test(html) };
    if (!hook.found) passes = passes.filter((p) => p !== 2);
    console.log(`    seek hook: ${hook.found ? 'found' : 'NOT FOUND, so no camera and no pass 2'}`);
  }

  let camera = null;
  let overlay = [];
  if (passes.includes(2)) {
    // An engine older than the camera is given the camera's three files after its own scene
    // is built, so the build is the round's and the stills are the one camera's.
    if (plan.cameraOverlay.length) {
      const cam = await readBlobs(repo, plan.cameraOverlay.map((f) => f.camera));
      for (const f of plan.cameraOverlay) {
        const dest = safeJoin(workRoot, f.path);
        await fs.writeFile(dest, cam.get(f.camera));
        if (gitBlobId(await fs.readFile(dest)) !== f.camera) throw new Error(`${round.id}: ${f.path} did not read back as written`);
      }
      overlay = plan.cameraOverlay;
      console.log(`    camera files given to the engine: ${overlay.map((f) => path.posix.basename(f.path)).join(', ')}`);
    }
    camera = await stage('camera', projectDir, CAMERA, `node ${CAMERA.join(' ')}`);
    console.log(`    camera: exit ${camera.exitCode}`);
    // Exit 1 is the layout audit failing, and the stills are still written; the coach sees it
    // in audit.txt. Anything else is a broken stage.
    if (camera.exitCode !== 0 && camera.exitCode !== 1) {
      throw new Error(`${round.id}: camera exited ${camera.exitCode}\n${camera.stderr.trim()}`);
    }
  }

  // 4. Nothing the stages ran may have touched the inputs: each is still the file the round
  // was given, from the tree or written over it.
  const expected = Object.fromEntries(
    INPUT_FILES.map((f) => {
      const rel = `${PROJECT}/${f}`;
      return [f, plan.replace.find((r) => r.path === rel)?.blob ?? entries.find((e) => e.path === rel)?.oid ?? null];
    }),
  );
  const used = passes.includes(2) ? INPUT_FILES : ['script.md'];
  for (const f of INPUT_FILES) {
    if (!expected[f]) {
      if (used.includes(f)) throw new Error(`${round.id}: an input file is missing from the tree`);
      continue;
    }
    if (gitBlobId(await fs.readFile(path.join(projectDir, f))) !== expected[f]) throw new Error(`${round.id}: ${PROJECT}/${f} changed during the build`);
  }

  // 5. Collect the input sets the round has.
  // The answer key names r1's items by segment number, so every manifest keeps the order.
  const segments = JSON.parse(await fs.readFile(path.join(projectDir, 'timing.json'), 'utf8')).segments.map((s) => s.id);
  let endCardOn = null;
  let stillIds = [];
  let timing = null;
  let audit = null;
  if (passes.includes(2)) {
    timing = JSON.parse(await fs.readFile(path.join(projectDir, 'timing.json'), 'utf8'));
    endCardOn = timing.endCard != null && timing.endCard.enabled !== false;
    if (endCardOn && !Number.isFinite(timing.contentMs)) {
      throw new Error(`${round.id}: the end card is on but contentMs is missing, so its still would show no real moment`);
    }
    stillIds = [...timing.segments.map((s) => s.id), ...(endCardOn ? ['endcard'] : [])];
    const scrub = makeScrubber([[projectDir, '<project>'], [engineDir, '<engine>'], [workRoot, '<root>']]);
    audit = scrub(transcript([scene, camera]));
    assertNoLocalPath(audit, 'audit.txt');
  }

  const files = [];
  const put = async (pass, rel, buf, extra = {}) => {
    const dest = path.join(outRoot, ...rel.split('/'));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, buf, { flag: 'wx' });
    files.push({ pass, file: rel, blob: extra.blob ?? null, sha256: sha256(buf), bytes: buf.length, ...extra });
  };
  // A file keeps its blob id only when its bytes are the tree's own.
  const given = async (f) => {
    const rel = `${PROJECT}/${f}`;
    const buf = await fs.readFile(path.join(projectDir, f));
    const written = plan.replace.find((r) => r.path === rel);
    const extra = { blob: written ? null : expected[f] };
    if (reconstructed && plan.regenerated.includes(rel)) extra.note = 'regenerated';
    else if (written) extra.note = 'reconstructed';
    return { buf, extra };
  };
  const script = await given('script.md');
  await put(1, 'pass1/script.md', script.buf, script.extra);
  if (passes.includes(2)) {
    for (const f of INPUT_FILES) {
      const c = await given(f);
      await put(2, `pass2/${f}`, c.buf, c.extra);
    }
    await put(2, 'pass2/audit.txt', Buffer.from(audit, 'utf8'), { generated: 'stage transcript' });
    for (const id of stillIds) {
      const buf = await fs.readFile(path.join(projectDir, 'preview', `${id}.png`));
      const { width, height } = pngSize(buf);
      if (width !== timing.project.width || height !== timing.project.height) {
        throw new Error(`${round.id}: still ${id}.png is ${width}x${height}, not the project's ${timing.project.width}x${timing.project.height}`);
      }
      await put(2, `pass2/stills/${id}.png`, buf, { generated: 'camera', width, height });
    }
  }

  const manifest = {
    round: round.id,
    kind: round.kind,
    commit: plan.stateCommit,
    lineage: { ref: LINEAGE_REF, tip: lineageTip },
    segments,
    ...(reconstructed
      ? {
          method: round.method,
          state: { commit: plan.state.commit, index: plan.state.index, timingSha256: sha256(plan.state.timing) },
          reconstruction: withoutBuffers(plan.rec),
          regeneration: plan.regen.files.map(({ buf, ...f }) => f),
          replaced: plan.replace.map(({ buf, ...r }) => ({ path: r.path, why: r.why, replacedBlob: r.committed, sha256: sha256(buf), bytes: buf.length })),
          camera: passes.includes(2) ? { preview: CAMERA_BLOB, overlay } : null,
          hook,
          passes,
        }
      : { preFix: plan.preFix }),
    export: { roots: [ENGINE, PROJECT], files: entries.length, verified },
    engine: Object.fromEntries(
      ['src/write-build-html.mjs', 'src/preview.mjs', 'src/cli-support.mjs', 'package-lock.json']
        .map((f) => [`${ENGINE}/${f}`, entries.find((e) => e.path === `${ENGINE}/${f}`)?.oid ?? null])
        .concat([[`${PROJECT}/package-lock.json`, entries.find((e) => e.path === `${PROJECT}/package-lock.json`)?.oid ?? null]]),
    ),
    stages: [...installs, ...[scene, camera].filter(Boolean).map((s) => ({ label: s.label, command: s.display, exitCode: s.exitCode }))],
    layoutAudit: camera ? (camera.exitCode === 0 ? 'clean' : 'issues reported (see audit.txt)') : 'not run (no pass 2)',
    endCard: endCardOn === null ? 'not used (no pass 2)' : endCardOn ? 'on — endcard.png kept' : 'off (endCard.enabled is false) — endcard.png dropped',
    ...(reconstructed ? {} : { checkpoint: plan.checkpoint }),
    tools: { ...tools, ...(await browserVersions(engineDir)) },
    files,
  };
  await fs.writeFile(path.join(workRoot, 'manifest.json'), recordJson(manifest));
  console.log(`    collected ${files.length} files into ${outRoot}`);
}

// The reconstruction's record, with the rebuilt timing.json kept only by its hash.
function withoutBuffers(rec) {
  const { timing, ...rest } = rec;
  return timing ? { ...rest, timing: { sha256: sha256(timing.buf), bytes: timing.buf.length } } : rest;
}

// A record is JSON with no raw bytes in it: a Buffer that reached one would be written out
// as an array of numbers.
function recordJson(value) {
  return `${JSON.stringify(
    value,
    (key, v) => {
      if (v && v.type === 'Buffer' && Array.isArray(v.data)) throw new Error(`a Buffer reached the record at "${key}"`);
      return v;
    },
    2,
  )}\n`;
}

function notExtractedWhy(p) {
  const why = [];
  if (!p.rec.holds) why.push(`the ${p.round.method} method does not hold`);
  const script = p.regen?.files.find((f) => f.file === 'script.md');
  if (script && !script.buf) {
    why.push(
      script.proof.provenAt
        ? `script.md could not be regenerated (${script.regenerated.error})`
        : 'no generator of script.md is proven at its state (README, "Amendments", 1)',
    );
  }
  if (!why.length) throw new Error(`${p.round.id} does not hold, and no reason for it was found`);
  return why;
}

// A round the protocol does not extract leaves its evidence and no input set: the record
// takes the manifest's place, and write-ledger.mjs reports it.
async function recordNotExtracted(p, { out, work, replace, lineageTip }) {
  const { round } = p;
  const workRoot = path.join(work, round.id);
  const outRoot = path.join(out, round.id);
  await prepareFreshDir(workRoot, replace);
  if (await pathExists(outRoot)) {
    // prepareFreshDir refuses unless --replace is given and the folder is this tool's.
    await prepareFreshDir(outRoot, replace);
    await fs.rm(outRoot, { recursive: true });
  }
  const record = {
    round: round.id,
    kind: round.kind,
    method: round.method,
    extracted: false,
    why: notExtractedWhy(p),
    commit: p.stateCommit ?? null,
    lineage: { ref: LINEAGE_REF, tip: lineageTip },
    state: p.state ? { commit: p.state.commit, index: p.state.index, timingSha256: sha256(p.state.timing) } : null,
    reconstruction: withoutBuffers(p.rec),
    regeneration: p.regen ? p.regen.files.map(({ buf, ...f }) => f) : [],
  };
  const file = path.join(workRoot, 'not-extracted.json');
  await fs.writeFile(file, recordJson(record));
  console.log(`\n== ${round.id}: not extracted; the record is ${file}`);
}

async function browserVersions(engineDir) {
  const pw = JSON.parse(await fs.readFile(path.join(engineDir, 'node_modules', 'playwright', 'package.json'), 'utf8'));
  const browsers = JSON.parse(await fs.readFile(path.join(engineDir, 'node_modules', 'playwright-core', 'browsers.json'), 'utf8'));
  const rev = (name) => browsers.browsers.find((b) => b.name === name);
  const shell = rev('chromium-headless-shell');
  const full = rev('chromium');
  return {
    playwright: pw.version,
    chromium: full ? `${full.browserVersion ?? '?'} (revision ${full.revision})` : 'unknown',
    headlessShell: shell ? `revision ${shell.revision}` : 'unknown',
  };
}
