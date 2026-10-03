// reconstruct — the methods that rebuild a round nobody committed (README, "Input sets").
//
// restore-fields (r6c): the base commit, with the fields its review script writes put back
// from the commit before the round. The script itself is the check: run on the result, it
// must give back the base commit's timing.json byte for byte.
//
// snapshot-rule (r2, r3): the latest session checkpoint that contains none of the round's
// scripted edits, provided the next checkpoint contains them. The script is the oracle for
// "contains". Run on a checkpoint's timing.json, it changes a field exactly when that
// field's edit is not there yet.
//
// checkpoint (r1): one session checkpoint as it stands, named in the round table after the
// log was read (README, "Amendment 7", item 9). Nothing is rebuilt but the regenerated files.
//
// The first two methods run a review script on a copy of one timing.json, in a throwaway
// folder under the system temp directory that is deleted afterwards. The regenerated files
// are made the same way, in a throwaway copy of the round's trees. Nothing else is written.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CHECKPOINT_NS,
  ENGINE,
  INPUT_FILES,
  PROJECT,
  canonical,
  fieldValue,
  git,
  gitBlobId,
  gitText,
  listTree,
  pathExists,
  readBlobs,
  run,
  safeJoin,
  setField,
} from './lib.mjs';

export async function listCheckpoints(repo) {
  const raw = await gitText(repo, ['for-each-ref', '--format=%(objectname) %(refname)', CHECKPOINT_NS]);
  const byIndex = new Map();
  for (const line of raw.split('\n').filter(Boolean)) {
    const [commit, ref] = line.split(' ');
    const m = /^(\d{20})\//.exec(ref.slice(CHECKPOINT_NS.length));
    if (!m) throw new Error(`unexpected checkpoint ref ${ref}`);
    const index = Number(m[1]);
    if (byIndex.has(index)) throw new Error(`two checkpoints share index ${index}`);
    byIndex.set(index, { index, commit, ref });
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

export async function blobOid(repo, commit, rel) {
  const raw = (await git(repo, ['ls-tree', '-z', '--full-tree', commit, '--', rel])).toString('utf8');
  const rec = raw.split('\0').find(Boolean);
  if (!rec) return null;
  const [, type, oid] = rec.slice(0, rec.indexOf('\t')).split(' ');
  if (type !== 'blob') throw new Error(`${commit.slice(0, 8)}:${rel} is a ${type}, not a file`);
  return oid;
}

export const readBlob = (repo, oid) => git(repo, ['cat-file', 'blob', oid]);

// Runs one review script against a copy of one timing.json. The script sits at the same
// place relative to timing.json as in the project, and the folder is the working directory,
// so both conventions the scripts use (cwd-relative and script-relative) find the copy.
export async function runReviewScript(scriptRel, scriptBuf, timingBuf) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vcb-script-'));
  try {
    const scriptPath = path.join(dir, ...scriptRel.split('/'));
    await fs.mkdir(path.dirname(scriptPath), { recursive: true });
    await fs.writeFile(scriptPath, scriptBuf);
    await fs.writeFile(path.join(dir, 'timing.json'), timingBuf);
    const r = await run(process.execPath, [scriptPath], { cwd: dir });
    return {
      exitCode: r.code,
      error: r.code === 0 ? null : firstError(r),
      after: r.code === 0 ? await fs.readFile(path.join(dir, 'timing.json')) : null,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function firstError(r) {
  const stderr = r.stderr.toString('utf8').trim();
  return (stderr.split('\n').find((l) => /Error/.test(l)) ?? stderr.split('\n')[0] ?? '').trim();
}

const serialise = (json) => Buffer.from(`${JSON.stringify(json, null, 2)}\n`, 'utf8');

// ---- restore-fields ---------------------------------------------------------------------
export async function planRestoreFields(repo, round) {
  const baseOid = await blobOid(repo, round.commit, `${PROJECT}/timing.json`);
  const fromOid = await blobOid(repo, round.restoreFrom, `${PROJECT}/timing.json`);
  const scriptOid = await blobOid(repo, round.commit, `${PROJECT}/${round.script}`);
  if (!baseOid || !fromOid || !scriptOid) throw new Error(`${round.id}: timing.json or ${round.script} is missing`);
  const baseBuf = await readBlob(repo, baseOid);
  const base = JSON.parse(baseBuf.toString('utf8'));
  const from = JSON.parse((await readBlob(repo, fromOid)).toString('utf8'));

  // Restoring fields re-serialises the file, so the base must already be in that format.
  const roundTrips = serialise(base).equals(baseBuf);
  const rebuilt = structuredClone(base);
  const fields = round.fields.map((field) => {
    const baseValue = fieldValue(base, field);
    const restored = fieldValue(from, field);
    setField(rebuilt, field, restored);
    return {
      field,
      differs: canonical(baseValue) !== canonical(restored),
      baseSha: sha(baseValue),
      restoredSha: sha(restored),
    };
  });
  const buf = serialise(rebuilt);
  const check = await runReviewScript(round.script, await readBlob(repo, scriptOid), buf);
  const scriptGivesBase = check.exitCode === 0 && check.after.equals(baseBuf);
  const checkpoints = await scanRestoreCheckpoints(repo, round, base, from);
  return {
    method: round.method,
    base: { commit: round.commit, timingBlob: baseOid },
    restoreFrom: { commit: round.restoreFrom, timingBlob: fromOid },
    script: { path: `${PROJECT}/${round.script}`, blob: scriptOid, exitCode: check.exitCode, error: check.error },
    roundTrips,
    fields,
    scriptGivesBase,
    timing: { buf, blob: gitBlobId(buf) },
    checkpoints,
    holds: roundTrips && scriptGivesBase && fields.every((f) => f.differs),
  };
}

// Where do the restored fields stand in each checkpoint from the round's start onward? A
// checkpoint holding round 6's other edits but the pre-6c fields would be a real snapshot
// of the reconstructed state (README, "r6c may not be scoreable").
async function scanRestoreCheckpoints(repo, round, base, from) {
  const rows = [];
  for (const ck of await listCheckpoints(repo)) {
    if (ck.index < round.checkpoint) continue;
    const oid = await blobOid(repo, ck.commit, `${PROJECT}/timing.json`);
    if (!oid) {
      rows.push({ index: ck.index, commit: ck.commit, timingBlob: null, fields: [] });
      continue;
    }
    const at = JSON.parse((await readBlob(repo, oid)).toString('utf8'));
    rows.push({
      index: ck.index,
      commit: ck.commit,
      timingBlob: oid,
      fields: round.fields.map((field) => {
        const v = canonical(fieldValue(at, field));
        return v === canonical(fieldValue(from, field)) ? 'before' : v === canonical(fieldValue(base, field)) ? 'after' : 'other';
      }),
    });
  }
  return rows;
}

// ---- snapshot-rule ----------------------------------------------------------------------
export async function planSnapshotRule(repo, round, lineageTip) {
  const scriptOid = await blobOid(repo, lineageTip, `${PROJECT}/${round.script}`);
  if (!scriptOid) throw new Error(`${round.id}: ${round.script} is not on the lineage`);
  const script = await readBlob(repo, scriptOid);

  const rows = [];
  let last = null;
  for (const ck of await listCheckpoints(repo)) {
    const timingBlob = await blobOid(repo, ck.commit, `${PROJECT}/timing.json`);
    const scriptHere = await blobOid(repo, ck.commit, `${PROJECT}/${round.script}`);
    let row;
    if (!timingBlob) row = { status: 'no timing.json' };
    else if (last && last.timingBlob === timingBlob) row = { ...last.result };
    else {
      const before = await readBlob(repo, timingBlob);
      const r = await runReviewScript(round.script, script, before);
      if (r.exitCode !== 0) row = { status: 'script fails', error: r.error };
      else {
        const a = JSON.parse(before.toString('utf8'));
        const b = JSON.parse(r.after.toString('utf8'));
        row = { changed: round.fields.map((f) => canonical(fieldValue(a, f)) !== canonical(fieldValue(b, f))) };
      }
    }
    if (timingBlob) last = { timingBlob, result: row };
    rows.push({ index: ck.index, commit: ck.commit, timingBlob, scriptBlob: scriptHere, ...row });
  }

  // A field the script changes in no checkpoint is a write that changes nothing; it cannot
  // mark a state, so it is reported and left out.
  const evaluable = rows.filter((r) => r.changed);
  const live = round.fields.filter((_, i) => evaluable.some((r) => r.changed[i]));
  const noop = round.fields.filter((f) => !live.includes(f));
  for (const r of evaluable) {
    r.present = round.fields.filter((f, i) => live.includes(f) && !r.changed[i]);
    r.status = r.present.length === 0 ? 'none' : r.present.length === live.length ? 'all' : 'partial';
  }
  const transitions = [];
  for (let i = 0; i + 1 < rows.length; i++) {
    if (rows[i].status === 'none' && rows[i + 1].status === 'all') transitions.push(rows[i].index);
  }
  const chosen = transitions.length ? rows.find((r) => r.index === transitions.at(-1)) : null;
  return {
    method: round.method,
    script: { path: `${PROJECT}/${round.script}`, blob: scriptOid },
    fields: round.fields,
    live,
    noop,
    rows: rows.map(({ changed, ...rest }) => rest),
    transitions,
    chosen: chosen ? { index: chosen.index, commit: chosen.commit, timingBlob: chosen.timingBlob } : null,
    holds: transitions.length === 1 && live.length > 0,
  };
}

function sha(v) {
  return gitBlobId(Buffer.from(canonical(v), 'utf8')).slice(0, 12);
}

// ---- checkpoint -------------------------------------------------------------------------
// The state is the named checkpoint, and its own timing.json is the round's. The record also
// walks out from it, on each side, to the first checkpoint whose input files differ, so the
// ledger shows which neighbouring states hold the same inputs (README, "Amendment 7", item 3).
export async function planCheckpoint(repo, round) {
  const all = await listCheckpoints(repo);
  const at = all.findIndex((ck) => ck.index === round.checkpoint);
  if (at < 0) throw new Error(`${round.id}: checkpoint #${round.checkpoint} not found under ${CHECKPOINT_NS}`);
  const compared = [...INPUT_FILES.map((f) => `${PROJECT}/${f}`), `${ENGINE}/src/write-build-html.mjs`];
  const filesAt = async (ck) => {
    const blobs = [];
    for (const p of compared) blobs.push(await blobOid(repo, ck.commit, p));
    return blobs;
  };
  const own = await filesAt(all[at]);
  const rows = [{ index: all[at].index, commit: all[at].commit, files: own, same: true }];
  for (const step of [-1, 1]) {
    for (let i = at + step; i >= 0 && i < all.length; i += step) {
      const files = await filesAt(all[i]);
      const row = { index: all[i].index, commit: all[i].commit, files, same: files.every((b, k) => b === own[k]) };
      if (step < 0) rows.unshift(row);
      else rows.push(row);
      if (!row.same) break;
    }
  }
  const timingBlob = own[0];
  return {
    method: round.method,
    checkpoint: { index: all[at].index, commit: all[at].commit, timingBlob },
    compared,
    rows,
    holds: timingBlob !== null,
  };
}

// ---- regenerated files ------------------------------------------------------------------
// A reconstructed round's script.md and storyboard.html are regenerated from the round's own
// timing.json by the generators at the round's own state (README, "Regenerated files"). The
// coach must see what the pipeline makes from the timeline the user watched, and a
// checkpoint can hold a file its author had not regenerated yet.
//
// A regenerated file is only as good as its generator, so each generator must first
// reproduce a real file byte for byte from that file's own data: the file at the round's
// own state, or, where the state is a session checkpoint and its file is stale, the latest
// earlier checkpoint's (README, "Amendments", 1, and "Amendment 8"). Without that proof a
// file is not used, and the passes that need it are dropped.
export const GENERATED = Object.freeze([
  { file: 'script.md', generator: `${PROJECT}/src/write-script.mjs`, args: [], passes: [1, 2] },
  { file: 'storyboard.html', generator: `${ENGINE}/src/write-storyboard.mjs`, args: ['--apply'], passes: [2] },
]);

// What the generators read, found by reading every version of both in the checkpoints and
// on the lineage (README, "Amendments", 4). write-script reads timing.json and, where
// present, the two observed files. write-storyboard reads timing.json.
export const DATA_FILES = Object.freeze(['timing.json', 'calibration-observed.json', 'silence-observed.json']);

export async function dataAt(repo, commit) {
  const data = {};
  for (const f of DATA_FILES) {
    const oid = await blobOid(repo, commit, `${PROJECT}/${f}`);
    data[f] = oid ? await readBlob(repo, oid) : null;
  }
  return data;
}

const dataKey = (data) => DATA_FILES.map((f) => (data[f] ? gitBlobId(data[f]) : '-')).join(',');

// Runs both generators with the code at `codeCommit` on the given data files, in a throwaway
// copy of that state's engine and project trees. qc/** is left out, because it holds the
// review scripts and screenshots and is never an input. Only the generated files are read
// back, and the copy is deleted. Every generator version is run the same way: its output is
// deleted first, then it runs from the project folder, so a version that writes
// unconditionally and one that plans unless given --apply both write the file.
export async function runGenerators(repo, codeCommit, data) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vcb-gen-'));
  try {
    const entries = (await listTree(repo, codeCommit, [ENGINE, PROJECT])).filter((e) => !e.path.startsWith(`${PROJECT}/qc/`));
    const blobs = await readBlobs(repo, entries.map((e) => e.oid));
    for (const e of entries) {
      const dest = safeJoin(dir, e.path);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, blobs.get(e.oid));
    }
    const projectDir = safeJoin(dir, PROJECT);
    for (const f of DATA_FILES) {
      const dest = path.join(projectDir, f);
      if (data[f]) await fs.writeFile(dest, data[f]);
      else await fs.rm(dest, { force: true });
    }
    for (const g of GENERATED) await fs.rm(path.join(projectDir, g.file), { force: true });
    const out = {};
    // A file that names the folder it was made in would tell the coach where it came from.
    const namesDir = (buf) => {
      const text = buf.toString('latin1').toLowerCase();
      return [dir, dir.replace(/\\/g, '/')].some((v) => text.includes(v.toLowerCase()));
    };
    for (const g of GENERATED) {
      const script = path.relative(projectDir, safeJoin(dir, g.generator));
      const r = await run(process.execPath, [script, ...g.args], { cwd: projectDir });
      const file = path.join(projectDir, g.file);
      let buf = r.code === 0 && (await pathExists(file)) ? await fs.readFile(file) : null;
      let error = buf ? null : firstError(r) || 'no output file';
      if (buf && namesDir(buf)) [buf, error] = [null, 'the output names the folder it was made in'];
      out[g.file] = { exitCode: r.code, buf, blob: buf ? gitBlobId(buf) : null, error };
    }
    return out;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// state: the round's code (`commit`), its checkpoint index where the state is a session
// checkpoint, and the timing.json the round is rebuilt from.
export async function planRegeneration(repo, round, state) {
  const own = await dataAt(repo, state.commit);
  const committed = {};
  const generatorBlob = {};
  for (const g of GENERATED) {
    committed[g.file] = await blobOid(repo, state.commit, `${PROJECT}/${g.file}`);
    generatorBlob[g.file] = await blobOid(repo, state.commit, g.generator);
    if (!generatorBlob[g.file]) throw new Error(`${round.id}: ${g.generator} does not exist at ${state.commit.slice(0, 8)}`);
  }

  const ownRun = await runGenerators(repo, state.commit, own);
  const proof = {};
  for (const g of GENERATED) {
    const r = ownRun[g.file];
    const reproduces = r.blob !== null && r.blob === committed[g.file];
    proof[g.file] = {
      atState: { reproduces, exitCode: r.exitCode, error: r.error, output: r.blob, committed: committed[g.file] },
      provenAt: reproduces ? { index: state.index, commit: state.commit, file: committed[g.file] } : null,
      tried: [],
    };
  }

  // Only a checkpoint state has earlier checkpoints to fall back to. It was a snapshot round
  // alone until "Amendment 8" added r1; r6c's state is a commit and has none.
  if (state.index != null) {
    const seen = new Set();
    const earlier = (await listCheckpoints(repo)).filter((ck) => ck.index < state.index).reverse();
    for (const ck of earlier) {
      const need = GENERATED.filter((g) => !proof[g.file].provenAt);
      if (!need.length) break;
      const data = await dataAt(repo, ck.commit);
      if (!data['timing.json']) continue;
      const files = {};
      for (const g of need) files[g.file] = await blobOid(repo, ck.commit, `${PROJECT}/${g.file}`);
      if (need.every((g) => !files[g.file])) continue;
      const key = `${dataKey(data)}|${need.map((g) => files[g.file] ?? '-').join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const r = await runGenerators(repo, state.commit, data);
      for (const g of need) {
        if (!files[g.file]) continue;
        const reproduces = r[g.file].blob === files[g.file];
        proof[g.file].tried.push({ index: ck.index, reproduces });
        if (reproduces) proof[g.file].provenAt = { index: ck.index, commit: ck.commit, file: files[g.file] };
      }
    }
  }

  const sameTiming = own['timing.json'] !== null && state.timing.equals(own['timing.json']);
  const regen = sameTiming ? ownRun : await runGenerators(repo, state.commit, { ...own, 'timing.json': state.timing });
  const files = GENERATED.map((g) => ({
    file: g.file,
    generator: g.generator,
    generatorBlob: generatorBlob[g.file],
    passes: g.passes,
    committed: committed[g.file],
    proof: proof[g.file],
    regenerated: { exitCode: regen[g.file].exitCode, error: regen[g.file].error, blob: regen[g.file].blob },
    buf: proof[g.file].provenAt ? regen[g.file].buf : null,
  }));
  const passes = [1, 2].filter((p) => files.filter((f) => f.passes.includes(p)).every((f) => f.buf !== null));
  return { files, passes, holds: passes.includes(1) };
}
