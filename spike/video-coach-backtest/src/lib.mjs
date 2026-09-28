// Shared plumbing for the backtest scripts: the fixed round table, process running,
// hashing, path guards, and rubric assembly.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT = Object.freeze({ OK: 0, FAILED: 1, USAGE: 2 });

export class UsageError extends Error {}

export const SPIKE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROJECT = 'tools/EvalLoopDemo';
export const ENGINE = 'tools/SizzleCraft';
export const INPUT_FILES = Object.freeze(['timing.json', 'script.md', 'storyboard.html']);

// The demo session's own branch, which holds every round's commits in order.
export const LINEAGE_REF = 'refs/heads/users/jonosace-microsoft/eval-loop-demo-build';
export const CHECKPOINT_NS = 'refs/copilot/checkpoints/13752b3b-8a8a-4931-841d-b63fc5f3964f/';

// The one camera (README, "Input sets"): the preview.mjs at all four commit-backed states.
export const CAMERA_BLOB = 'c5f34dd8a16560dc50befc9ae67324d2396e4b79';

// Fixed before any result (README, "Input sets"). `checkpoint` is the index of the demo
// session's last checkpoint before the round's first fix; it feeds the cross-check only.
export const ROUNDS = Object.freeze([
  { id: 'r4', kind: 'commit-backed', commit: '64f2cffd9852c479419faa96cbac5d478bf8c5bd', checkpoint: 20 },
  { id: 'r5', kind: 'commit-backed', commit: 'e0e73a850b092d6732bc0abb48ee024acf3f312c', checkpoint: 26 },
  { id: 'r6', kind: 'commit-backed', commit: '9e20f3cd55d709e0cacbdbd854689a17a9ff715f', checkpoint: 34 },
  { id: 'r7', kind: 'commit-backed', commit: 'fc8dece95dd903b14d9238aa266895fb01af387c', checkpoint: 43 },
]);

export const SENTINEL = '.vcb-extract';

export async function main(fn) {
  try {
    process.exitCode = (await fn()) ?? EXIT.OK;
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`usage: ${err.message}`);
      process.exitCode = EXIT.USAGE;
    } else {
      console.error(`FAILED: ${err?.message ?? err}`);
      if (process.env.VCB_DEBUG) console.error(err?.stack);
      process.exitCode = EXIT.FAILED;
    }
  }
}

export function run(cmd, args, { cwd, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
    child.on('close', (code, signal) =>
      resolve({ code: code ?? 1, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }),
    );
    if (input !== undefined) child.stdin.end(input);
  });
}

export async function git(repo, args, opts = {}) {
  const r = await run('git', ['-C', repo, ...args], opts);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${r.code}: ${r.stderr.toString('utf8').trim()}`);
  }
  return r.stdout;
}

export const gitText = async (repo, args) => (await git(repo, args)).toString('utf8').trim();

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export const gitBlobId = (buf) =>
  crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

export function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export async function pathExists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

export async function repoRoot() {
  const r = await run('git', ['-C', SPIKE_DIR, 'rev-parse', '--show-toplevel']);
  if (r.code !== 0) throw new Error('the spike is not inside a git repository');
  return path.resolve(r.stdout.toString('utf8').trim());
}

// Output must never land in a checkout of this repository — generated output stays out of
// git (README, "What git holds"), and a path inside any worktree could be committed.
export async function assertOutsideRepository(repo, dirs) {
  const listing = await gitText(repo, ['worktree', 'list', '--porcelain']);
  const trees = listing
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => path.resolve(l.slice('worktree '.length)));
  const common = path.resolve(repo, await gitText(repo, ['rev-parse', '--git-common-dir']));
  for (const [label, dir] of Object.entries(dirs)) {
    const real = await realpathOrSelf(dir);
    for (const tree of [...trees, common]) {
      if (isInside(real, await realpathOrSelf(tree))) {
        throw new UsageError(`--${label} ${dir} is inside ${tree}; it must be outside every checkout`);
      }
    }
  }
}

async function realpathOrSelf(p) {
  try {
    return await fs.realpath(p);
  } catch (err) {
    if (err.code === 'ENOENT') return path.resolve(p);
    throw err;
  }
}

// A folder this tool made carries a sentinel; only such a folder may be deleted, and only
// under --replace.
export async function prepareFreshDir(dir, replace) {
  if (await pathExists(dir)) {
    if (!replace) throw new UsageError(`${dir} already exists; pass --replace to rebuild it`);
    if (!(await pathExists(path.join(dir, SENTINEL)))) {
      throw new UsageError(`${dir} was not created by this tool (no ${SENTINEL}); refusing to delete it`);
    }
    await fs.rm(dir, { recursive: true });
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, SENTINEL), '');
}

export function pngSize(buf) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(signature) || buf.toString('latin1', 12, 16) !== 'IHDR') {
    throw new Error('not a PNG file');
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// ---- Rubric assembly ------------------------------------------------------------------
// The rubric arrived as transport pieces (README, "Contamination"). It is joined verbatim;
// only these transport lines are removed.
export const TRANSPORT_LINES = Object.freeze([/^PART \S+( of \d+)?$/, /^REGENERATED: /, /^NEXT: /, /^END PART /]);

export async function assembleRubric(partsDir) {
  const orderFile = path.join(partsDir, 'ORDER.txt');
  if (!(await pathExists(orderFile))) throw new UsageError(`${orderFile} not found`);
  const entries = (await fs.readFile(orderFile, 'utf8'))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (!entries.length) throw new UsageError('ORDER.txt lists no pieces');

  let text = '';
  const pieces = [];
  for (const entry of entries) {
    const m = /^(\d+\.md)(?: join=(space))?$/.exec(entry);
    if (!m) throw new UsageError(`ORDER.txt: unrecognised line "${entry}"`);
    const [, name, join] = m;
    const raw = await fs.readFile(path.join(partsDir, name));
    const removed = [];
    const kept = raw
      .toString('utf8')
      .split('\n')
      .filter((line) => {
        const hit = TRANSPORT_LINES.some((re) => re.test(line.trim()));
        if (hit) removed.push(line);
        return !hit;
      });
    while (kept.length && kept[0].trim() === '') kept.shift();
    while (kept.length && kept.at(-1).trim() === '') kept.pop();
    const body = kept.join('\n');
    const mode = !pieces.length ? 'start' : join === 'space' ? 'space' : 'blank-line';
    text += mode === 'start' ? body : mode === 'space' ? ` ${body}` : `\n\n${body}`;
    pieces.push({ name, bytes: raw.length, sha256: sha256(raw), join: mode, removed });
  }
  text += '\n';
  const ids = [...text.matchAll(/^### ((?:OBJ|CRAFT)-\d+)\b/gm)].map((m) => m[1]);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  return { text, pieces, ids, duplicates };
}
