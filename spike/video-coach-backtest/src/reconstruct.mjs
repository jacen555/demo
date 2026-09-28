// reconstruct — the two methods that rebuild a round nobody committed (README, "Input sets").
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
// Both methods run a review script on a copy of one timing.json, in a throwaway folder under
// the system temp directory that is deleted afterwards. Nothing else is written.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CHECKPOINT_NS, PROJECT, canonical, fieldValue, git, gitBlobId, gitText, run, setField } from './lib.mjs';

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
    const stderr = r.stderr.toString('utf8').trim();
    return {
      exitCode: r.code,
      error: r.code === 0 ? null : (stderr.split('\n').find((l) => /Error/.test(l)) ?? stderr.split('\n')[0] ?? '').trim(),
      after: r.code === 0 ? await fs.readFile(path.join(dir, 'timing.json')) : null,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
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
