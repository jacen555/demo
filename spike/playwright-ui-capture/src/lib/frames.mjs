/**
 * Frame hashing + run comparison.
 *
 * Determinism claims in this spike are made against SHA-256 of the encoded PNG
 * bytes. That is the strict test: identical bytes implies identical pixels.
 * (The converse does not hold, so a byte mismatch is re-checked at pixel level
 * by `pixels.mjs` before it is reported as a real visual difference.)
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** SHA-256 of a buffer, hex. */
export function hashBuffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Hash every frame_*.png in a directory, ordered numerically by frame index. */
export async function hashFrameDir(dir) {
  const names = (await fs.readdir(dir))
    .filter((n) => /^frame_\d+\.png$/.test(n))
    .sort((a, b) => frameIndex(a) - frameIndex(b));

  const hashes = [];
  for (const name of names) {
    hashes.push(hashBuffer(await fs.readFile(path.join(dir, name))));
  }
  return { names, hashes };
}

export function frameIndex(name) {
  const m = name.match(/^frame_(\d+)\./);
  if (!m) throw new Error(`not a frame file: ${name}`);
  return Number(m[1]);
}

/**
 * Compare N hash sequences (one per run).
 * Returns the count of frames identical across every run, and the first index
 * where any run diverges (-1 when all runs agree).
 */
export function compareRuns(runs) {
  if (runs.length < 2) throw new Error('compareRuns needs at least 2 runs');
  const lengths = runs.map((r) => r.length);
  const minLen = Math.min(...lengths);

  let identical = 0;
  let firstDivergentFrame = -1;
  for (let i = 0; i < minLen; i++) {
    const allSame = runs.every((r) => r[i] === runs[0][i]);
    if (allSame) identical++;
    else if (firstDivergentFrame === -1) firstDivergentFrame = i;
  }

  return {
    runs: runs.length,
    frameCounts: lengths,
    frameCountStable: lengths.every((l) => l === lengths[0]),
    comparedFrames: minLen,
    identicalFrames: identical,
    divergentFrames: minLen - identical,
    firstDivergentFrame,
    allIdentical: identical === minLen && lengths.every((l) => l === lengths[0]),
  };
}

/** Distinct-hash count — how many genuinely different frames a sequence contains. */
export function dedupStats(hashes) {
  const distinct = new Set(hashes).size;
  let holdable = 0;
  for (let i = 1; i < hashes.length; i++) if (hashes[i] === hashes[i - 1]) holdable++;
  return {
    total: hashes.length,
    distinct,
    consecutiveDuplicates: holdable,
    dedupPercent: hashes.length ? Math.round((holdable / hashes.length) * 100) : 0,
  };
}
