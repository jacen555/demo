// extract-inputs — rebuild each round's pre-fix inputs for the coach, outside the repository.
//
// For each round it writes the round's committed engine and project trees from git's
// object store, byte for byte, and re-hashes every file against its blob id. It installs
// dependencies from the committed lockfiles, builds the scene with the round's own engine,
// and takes one still per segment with the single pinned camera. Last, it collects the two
// input sets and a manifest that write-ledger.mjs turns into inputs.md.
//
// It plans by default and writes nothing without --apply.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  CAMERA_BLOB,
  CHECKPOINT_NS,
  ENGINE,
  EXIT,
  INPUT_FILES,
  LINEAGE_REF,
  PROJECT,
  ROUNDS,
  UsageError,
  assertOutsideRepository,
  git,
  gitBlobId,
  gitText,
  main,
  pathExists,
  pngSize,
  prepareFreshDir,
  repoRoot,
  run,
  sha256,
} from './lib.mjs';

const USAGE = `
extract-inputs — rebuild each round's pre-fix inputs for the coach, outside the repository.

  node src/extract-inputs.mjs                           plan every round (writes nothing)
  node src/extract-inputs.mjs --apply                   extract every round
  node src/extract-inputs.mjs --apply --round r4 --round r7

Options
  --round <id>   round to extract; repeatable (default: every round): ${ROUNDS.map((r) => r.id).join(' ')}
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
  const unknown = values.round.filter((id) => !ROUNDS.some((r) => r.id === id));
  if (unknown.length) throw new UsageError(`unknown round(s): ${unknown.join(', ')}`);
  const rounds = values.round.length ? ROUNDS.filter((r) => values.round.includes(r.id)) : ROUNDS;

  const out = path.resolve(values.out ?? path.join(os.tmpdir(), 'vcb', 'inputs'));
  const work = path.resolve(values.work ?? path.join(os.tmpdir(), 'vcb', 'work'));
  const repo = await repoRoot();
  await assertOutsideRepository(repo, { out, work });

  const lineageTip = await gitText(repo, ['rev-parse', '--verify', `${LINEAGE_REF}^{commit}`]);
  const plans = [];
  for (const round of rounds) plans.push(await planRound(repo, round, lineageTip));

  for (const p of plans) {
    console.log(`${p.round.id}  ${p.round.kind}  ${p.round.commit}`);
    console.log(`    pre-fix rule: ${p.preFix.holds ? 'holds' : 'DOES NOT HOLD'}` +
      ` (first fix ${p.preFix.firstFix ?? 'none'}${p.preFix.firstFixSubject ? ` "${p.preFix.firstFixSubject}"` : ''})`);
    console.log(`    export: ${p.entries.length} files; camera ${p.cameraBlob === CAMERA_BLOB ? 'is' : 'IS NOT'} the pinned ${CAMERA_BLOB.slice(0, 8)}`);
    const same = (ck) => (ck.commit ? ck.files.map((f) => `${path.posix.basename(f.path)} ${f.same ? 'same' : 'DIFFERS'}`).join(', ') : 'absent');
    console.log(`    checkpoint #${p.checkpoint.index} ${p.checkpoint.commit.slice(0, 8)}: ${same(p.checkpoint)}`);
    console.log(`    checkpoint #${p.checkpoint.next.index} ${p.checkpoint.next.commit?.slice(0, 8) ?? ''}: ${same(p.checkpoint.next)}`);
    console.log(`    work ${path.join(work, p.round.id)}${(await pathExists(path.join(work, p.round.id))) ? ' (exists)' : ''}`);
    console.log(`    out  ${path.join(out, p.round.id)}${(await pathExists(path.join(out, p.round.id))) ? ' (exists)' : ''}`);
  }
  const broken = plans.filter((p) => !p.preFix.holds || p.cameraBlob !== CAMERA_BLOB);
  if (broken.length) {
    throw new Error(`round table disagrees with the protocol for: ${broken.map((p) => p.round.id).join(', ')}`);
  }
  if (!values.apply) {
    console.log('\nplan only — nothing written. Re-run with --apply to extract.');
    return EXIT.OK;
  }

  const tools = await toolVersions();
  for (const p of plans) await extractRound(repo, p, { out, work, replace: values.replace, tools, lineageTip });
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
  return { round, preFix, entries, cameraBlob, checkpoint };
}

async function listTree(repo, commit, roots) {
  const raw = (await git(repo, ['ls-tree', '-r', '-z', '--full-tree', commit, '--', ...roots])).toString('utf8');
  const entries = [];
  for (const rec of raw.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, type, oid] = rec.slice(0, tab).split(' ');
    const p = rec.slice(tab + 1);
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) {
      throw new Error(`${commit.slice(0, 8)}:${p} is a ${type} (mode ${mode}); only regular files can be exported`);
    }
    entries.push({ mode, oid, path: p });
  }
  if (!entries.length) throw new Error(`${commit.slice(0, 8)} has no files under ${roots.join(', ')}`);
  return entries;
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

async function readBlobs(repo, oids) {
  const unique = [...new Set(oids)];
  const r = await run('git', ['-C', repo, 'cat-file', '--batch'], { input: `${unique.join('\n')}\n` });
  if (r.code !== 0) throw new Error(`git cat-file --batch exited ${r.code}: ${r.stderr.toString('utf8').trim()}`);
  const buf = r.stdout;
  const blobs = new Map();
  let pos = 0;
  for (const oid of unique) {
    const nl = buf.indexOf(0x0a, pos);
    const [hOid, type, size] = buf.toString('utf8', pos, nl).split(' ');
    if (hOid !== oid || type !== 'blob') throw new Error(`git cat-file: expected blob ${oid}, got "${buf.toString('utf8', pos, nl)}"`);
    const start = nl + 1;
    const end = start + Number(size);
    blobs.set(oid, buf.subarray(start, end));
    pos = end + 1;
  }
  return blobs;
}

function safeJoin(root, rel) {
  const segs = rel.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..' || /[:\\\0]/.test(s))) {
    throw new Error(`unsafe path in tree: ${JSON.stringify(rel)}`);
  }
  return path.join(root, ...segs);
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
  console.log(`\n== ${round.id} (${round.commit.slice(0, 8)})`);
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

  const projectDir = safeJoin(workRoot, PROJECT);
  const engineDir = safeJoin(workRoot, ENGINE);

  // 2. Dependencies, from the committed lockfiles. No install scripts run.
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
  const camera = await stage('camera', projectDir, CAMERA, `node ${CAMERA.join(' ')}`);
  console.log(`    camera: exit ${camera.exitCode}`);
  // Exit 1 is the layout audit failing, and the stills are still written; the coach sees it
  // in audit.txt. Anything else is a broken stage.
  if (camera.exitCode !== 0 && camera.exitCode !== 1) {
    throw new Error(`${round.id}: camera exited ${camera.exitCode}\n${camera.stderr.trim()}`);
  }

  // 4. Nothing the stages ran may have touched the committed inputs.
  const inputEntries = INPUT_FILES.map((f) => entries.find((e) => e.path === `${PROJECT}/${f}`));
  for (const e of inputEntries) {
    if (!e) throw new Error(`${round.id}: an input file is missing from the tree`);
    if (gitBlobId(await fs.readFile(safeJoin(workRoot, e.path))) !== e.oid) throw new Error(`${round.id}: ${e.path} changed during the build`);
  }

  // 5. Collect the two input sets.
  const timing = JSON.parse(await fs.readFile(path.join(projectDir, 'timing.json'), 'utf8'));
  const endCardOn = timing.endCard != null && timing.endCard.enabled !== false;
  if (endCardOn && !Number.isFinite(timing.contentMs)) {
    throw new Error(`${round.id}: the end card is on but contentMs is missing, so its still would show no real moment`);
  }
  const stillIds = [...timing.segments.map((s) => s.id), ...(endCardOn ? ['endcard'] : [])];

  const scrub = makeScrubber([[projectDir, '<project>'], [engineDir, '<engine>'], [workRoot, '<root>']]);
  const audit = scrub(transcript([scene, camera]));
  assertNoLocalPath(audit, 'audit.txt');

  const files = [];
  const put = async (pass, rel, buf, extra = {}) => {
    const dest = path.join(outRoot, ...rel.split('/'));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, buf, { flag: 'wx' });
    files.push({ pass, file: rel, blob: extra.blob ?? null, sha256: sha256(buf), bytes: buf.length, ...extra });
  };
  const committed = async (f) => {
    const e = inputEntries.find((x) => x.path === `${PROJECT}/${f}`);
    return { buf: await fs.readFile(path.join(projectDir, f)), blob: e.oid };
  };
  const script = await committed('script.md');
  await put(1, 'pass1/script.md', script.buf, { blob: script.blob });
  for (const f of INPUT_FILES) {
    const c = await committed(f);
    await put(2, `pass2/${f}`, c.buf, { blob: c.blob });
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

  const manifest = {
    round: round.id,
    kind: round.kind,
    commit: round.commit,
    lineage: { ref: LINEAGE_REF, tip: lineageTip },
    preFix: plan.preFix,
    export: { roots: [ENGINE, PROJECT], files: entries.length, verified },
    engine: Object.fromEntries(
      ['src/write-build-html.mjs', 'src/preview.mjs', 'src/cli-support.mjs', 'package-lock.json']
        .map((f) => [`${ENGINE}/${f}`, entries.find((e) => e.path === `${ENGINE}/${f}`)?.oid ?? null])
        .concat([[`${PROJECT}/package-lock.json`, entries.find((e) => e.path === `${PROJECT}/package-lock.json`)?.oid ?? null]]),
    ),
    stages: [...installs, ...[scene, camera].map((s) => ({ label: s.label, command: s.display, exitCode: s.exitCode }))],
    layoutAudit: camera.exitCode === 0 ? 'clean' : 'issues reported (see audit.txt)',
    endCard: endCardOn ? 'on — endcard.png kept' : 'off (endCard.enabled is false) — endcard.png dropped',
    checkpoint: plan.checkpoint,
    tools: { ...tools, ...(await browserVersions(engineDir)) },
    files,
  };
  await fs.writeFile(path.join(workRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`    collected ${files.length} files into ${outRoot}`);
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
