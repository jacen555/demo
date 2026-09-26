// Shared fixtures for the behavioural suites.
//
// The engine's scripts are CLI entry points that execute on import, so they are
// exercised as subprocesses against a throwaway project directory and asserted on
// their exit code plus the observable filesystem — the contract callers actually rely on.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** An absolute path guaranteed not to be an executable, for the "ffmpeg never ran" cases. */
export const MISSING_FFMPEG = path.join(os.tmpdir(), 'sizzlecraft-no-such-dir', 'no-such-ffmpeg.exe');

/** Creates a throwaway project dir, removed when the test ends. */
export function makeProject(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sizzlecraft-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  return dir;
}

/** A throwaway directory OUTSIDE any project root, for path-escape tests. */
export function makeOutsideDir(t, files = {}) {
  return makeProject(t, files);
}

/** Runs an engine script as a real CLI in `cwd` and returns its exit code + streams. */
export function runScript(script, args, cwd, { env = {}, nodeArgs = [] } = {}) {
  const r = spawnSync(process.execPath, [...nodeArgs, path.join(srcDir, script), ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, ...env },
  });
  return {
    code: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    all: (r.stdout ?? '') + (r.stderr ?? ''),
  };
}

/** The loader that makes `import('playwright')` fail for one child process. */
export const BLOCK_PLAYWRIGHT = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'block-playwright.mjs'),
).href;

/**
 * Creates a file symlink, returning false when the platform refuses (symlink creation
 * needs Developer Mode or elevation on Windows), so a test can skip rather than fail.
 */
export function tryMakeFileLink(linkPath, target) {
  try {
    fs.symlinkSync(target, linkPath, 'file');
    return true;
  } catch {
    return false;
  }
}

export const contiguousSegments = [
  { id: 'one', startMs: 0, endMs: 2000, voiceoverText: 'hello there', audio: { file: 'segment_000.mp3', durationMs: 2000 } },
  { id: 'two', startMs: 2000, endMs: 4000, voiceoverText: 'second segment here', audio: { file: 'segment_001.mp3', durationMs: 2000 } },
];

/** A timing.json body that satisfies every stage's minimum expectations. */
export function timingFixture(segments = contiguousSegments, extra = {}) {
  return JSON.stringify({
    project: { name: 'demo', fps: 30, width: 1280, height: 720, lede: 'a lede' },
    durationMs: segments.at(-1).endMs,
    contentMs: segments.at(-1).endMs,
    outroMs: 2500,
    endCard: { enabled: true },
    intake: {
      leadInMs: 2000,
      perceivedGapMs: 2000,
      toleranceMs: 750,
      voice: 'en-US-AvaNeural',
      speed: 1,
      silenceMs: 2000,
    },
    segments,
    ...extra,
  });
}

/** The brand token file voice.mjs validates its TTS voice against (constraint C-11). */
export const brandTokens = JSON.stringify({ audio: { ttsVoices: ['en-US-AvaNeural'] } });

/**
 * Runs a script and deletes `victimPath` the moment `marker` appears in its output.
 *
 * For contracts that only exist between two points in a run — a preflight and a later
 * read. A fixture that is broken from the start cannot distinguish "checked twice" from
 * "checked once", so it proves nothing about the change under test.
 */
export function runScriptDeletingOnMarker(script, args, cwd, marker, victimPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(srcDir, script), ...args], { cwd });
    let all = '';
    let deleted = false;
    const onChunk = (chunk) => {
      all += chunk;
      if (!deleted && all.includes(marker)) {
        deleted = true;
        fs.rmSync(victimPath, { force: true });
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, all, deleted }));
  });
}

/**
 * Asserts a script exited with the exact documented code AND did not surface the failure
 * as an uncaught stack trace.
 *
 * `assert.notEqual(code, 0)` is too weak: a CliError escaping above the handler still
 * exits non-zero, so a test written that way passes while the script reports the wrong
 * code and prints a stack. That is how one of these defects survived a round.
 */
export function assertCleanExit(r, expected, message = '') {
  assert.equal(r.code, expected, `${message}expected exit ${expected}, got ${r.code}\n${r.all}`);
  assert.doesNotMatch(
    r.all,
    /^\s*at .*\(.*:\d+:\d+\)/m,
    `${message}failure surfaced as an uncaught stack trace rather than a handled error\n${r.all}`,
  );
}

export function tryMakeDirLink(linkPath, target) {
  try {
    fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}
