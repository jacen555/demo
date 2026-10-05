// Shared fixtures for the behavioural suites.
//
// The engine's scripts are CLI entry points that execute on import, so they are
// exercised as subprocesses against a throwaway project directory and asserted on
// their exit code plus the observable filesystem — the contract callers actually rely on.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync, spawn, execFileSync } from 'node:child_process';
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

/**
 * A silent 16-bit mono PCM WAV that music-metadata, the engine's real probe, measures at
 * exactly `seconds`. remux-music decides whether the bed loops BEFORE its gain pin, so a
 * test that reaches the pin on --apply needs music whose length can actually be read.
 */
export function pcmWav(seconds, sampleRate = 8000) {
  const dataBytes = Math.round(seconds * sampleRate) * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40);
  return buf;
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
 * The loader that swaps `msedge-tts` and `playwright` for deterministic fakes in one child
 * process, so the voice/remix --apply paths run with no network and no browser. Pass it as
 * `nodeArgs: ['--import', FAKE_AUDIO]`. See tests/fixtures/fake-audio.mjs.
 */
export const FAKE_AUDIO = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-audio.mjs'),
).href;

/**
 * The --import URL of a preload that creates `target` (holding `body`) inside the child's
 * own console.log call for the first line containing `marker`, so it lands before the
 * script's next statement with no race. `target` must be in a makeProject/makeOutsideDir
 * directory. Pass it as `nodeArgs: ['--import', plantOnMarker({...})]`.
 * See tests/fixtures/plant-on-marker.mjs.
 */
export function plantOnMarker({ marker, target, body }) {
  const url = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'plant-on-marker.mjs'));
  url.search = new URLSearchParams({ marker, target, body }).toString();
  return url.href;
}

/**
 * The --import URL of a preload that makes fs.unlinkSync fail with EPERM for entries of
 * `dir` whose names contain `fragment`, announcing each refusal on stderr. `dir` must be a
 * makeProject/makeOutsideDir directory. See tests/fixtures/refuse-unlink.mjs.
 */
export function refuseUnlink({ dir, fragment }) {
  const url = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'refuse-unlink.mjs'));
  url.search = new URLSearchParams({ dir, fragment }).toString();
  return url.href;
}

/**
 * The --import URL of a preload that makes fs.closeSync fail with EIO, after really closing
 * the descriptor, for descriptors fs.openSync opened on entries of `dir` whose names contain
 * `fragment`, announcing each failure on stderr. `dir` must be a makeProject/makeOutsideDir
 * directory. See tests/fixtures/fail-close.mjs.
 */
export function failClose({ dir, fragment }) {
  const url = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fail-close.mjs'));
  url.search = new URLSearchParams({ dir, fragment }).toString();
  return url.href;
}

/**
 * The --import URL of a preload that makes every stat the engine reads report inode 0 for
 * the paths inside `dir`, as a volume with no file IDs does, announcing itself on stderr.
 * `dir` must be a makeProject/makeOutsideDir directory. See tests/fixtures/zero-file-ids.mjs.
 */
export function zeroFileIds({ dir }) {
  const url = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'zero-file-ids.mjs'));
  url.search = new URLSearchParams({ dir }).toString();
  return url.href;
}

/** The line zero-file-ids.mjs writes once armed, which a test asserts so the IDs were really withheld. */
export const ZERO_FILE_IDS_ARMED = /^zero-file-ids: armed — inode 0 for every path inside /m;

/**
 * The --import URL of a preload that makes fs.lstatSync fail with EPERM for the entries of
 * `dir` whose names are exactly one of `names`, announcing itself and each refusal on
 * stderr. `dir` must be a makeProject/makeOutsideDir directory. See tests/fixtures/fail-lstat.mjs.
 */
export function failLstat({ dir, names }) {
  const url = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fail-lstat.mjs'));
  url.search = new URLSearchParams([['dir', dir], ...names.map((name) => ['name', name])]).toString();
  return url.href;
}

/** The line fail-lstat.mjs writes once armed, which a test asserts so the failure was really staged. */
export const FAIL_LSTAT_ARMED = /^fail-lstat: armed — lstat fails for /m;

/**
 * The 8.3 short name Windows generated for `file`, or null when it has none. Generation is
 * per volume and can be switched off, so it is asked of the filesystem, never assumed.
 */
export function shortNameOf(file) {
  if (process.platform !== 'win32') return null;
  let out;
  try {
    out = execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"for %I in ("${file}") do @echo %~sI"`],
      { encoding: 'utf8', windowsVerbatimArguments: true });
  } catch {
    return null;
  }
  const alias = path.basename(out.trim());
  return alias !== '' && alias.toLowerCase() !== path.basename(file).toLowerCase() ? alias : null;
}

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

/**
 * contiguousSegments carrying the measured word boundaries voice.mjs records, for the
 * stages that read them (write-subtitles). The words are BARE, as TTS metadata delivers
 * them; punctuation lives only in voiceoverText.
 *
 * Cues this produces: "Hello there." 100..1100 and "Second segment here." 2100..3600.
 */
export const wordedSegments = [
  {
    id: 'one', startMs: 0, endMs: 2000, voiceoverText: 'Hello there.',
    audio: {
      file: 'segment_000.mp3', durationMs: 2000,
      words: [{ word: 'Hello', startMs: 100, endMs: 600 }, { word: 'there', startMs: 600, endMs: 1100 }],
    },
  },
  {
    id: 'two', startMs: 2000, endMs: 4000, voiceoverText: 'Second segment here.',
    audio: {
      file: 'segment_001.mp3', durationMs: 2000,
      words: [
        { word: 'Second', startMs: 2100, endMs: 2600 },
        { word: 'segment', startMs: 2600, endMs: 3100 },
        { word: 'here', startMs: 3100, endMs: 3600 },
      ],
    },
  },
];

/** A timing.json body that satisfies every stage's minimum expectations. */
export function timingFixture(segments = contiguousSegments, extra = {}) {
  return JSON.stringify({
    project: { name: 'demo', fps: 30, width: 1280, height: 720, lede: 'a lede' },
    durationMs: segments.at(-1).endMs,
    contentMs: segments.at(-1).endMs,
    outroMs: 2500,
    endCard: { enabled: true },
    builderVersion: '0.0.0-test',
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

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * Copies the engine into a throwaway directory INSIDE the package and installs a minimal
 * encoder page beside it.
 *
 * `src/encoder-page.html` ships on a sibling branch and is absent here, so the S7 apply
 * path throws on a missing prerequisite before it reaches any of the writes it guards. A
 * test run against `src/` therefore passes on that failure and establishes nothing about
 * the write stage. Copying the engine gives `scriptDir` an encoder page without writing a
 * fixture into `src/`, and keeping the copy inside the package means `node_modules` still
 * resolves for the `playwright` import.
 */
export function makeEngineCopy(t) {
  const engineDir = fs.mkdtempSync(path.join(path.dirname(srcDir), 'tests', '.engine-'));
  t.after(() => fs.rmSync(engineDir, { recursive: true, force: true }));
  for (const entry of fs.readdirSync(srcDir)) {
    if (entry.endsWith('.mjs') || entry.endsWith('.json')) {
      fs.copyFileSync(path.join(srcDir, entry), path.join(engineDir, entry));
    }
  }
  fs.copyFileSync(path.join(fixturesDir, 'encoder-page.html'), path.join(engineDir, 'encoder-page.html'));
  return engineDir;
}

/** A project the COPIED engine can actually encode: silent render, one frame, a muxer stub. */
export function operableProject(t, extra = {}) {
  return makeProject(t, {
    'timing.json': timingFixture(contiguousSegments, { intake: { toleranceMs: 750, silent: true } }),
    'frames/frame_00000.png': 'frame',
    'node_modules/mp4-muxer/build/mp4-muxer.js': '/* muxer stub — the fixture page does not load it */',
    ...extra,
  });
}

/**
 * A real 8x8 JPEG, produced by Chromium's own canvas encoder and embedded so the fixture
 * needs no browser to build.
 *
 * Frame files must be DECODABLE, not merely present. A text file named `.jpg` satisfies
 * the lineage digest perfectly — the digest is computed over bytes and does not care what
 * they mean — while every `new Image()` in the runtime fails. That is how a control can
 * pass over content that is not an image.
 */
const FIXTURE_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABh' +
    'Y3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAAB' +
    'UAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAA' +
    'AAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9Y' +
    'WVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAM' +
    'ZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUG' +
    'CQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQ' +
    'EBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/' +
    'xAAhEAABAgQHAAAAAAAAAAAAAAAABxICERMUFRYlMURhYv/EABQBAQAAAAAAAAAAAAAAAAAAAAf/xAAgEQABAwQDAQEAAAAAAAAA' +
    'AAABAgURAwQGIQASMRNB/9oADAMBAAIRAxEAPwCjUJQs+YfpFjY1eRVe9nmGUmd7gAXsex5txRtptDRT+dCnPVMqVHZRUdqKlGVK' +
    'J2T7A1wicnK5drlV5eK7VFRJgCYAA0AB4B+c/9k=',
  'base64',
);

/** How many frames the fixture clip contains. >1 so a "later in the clip" index exists. */
export const FOOTAGE_FRAME_COUNT = 4;

/**
 * An OPERABLE footage project: a segment that renders a real approved clip.
 *
 * Reproduces the full lineage contract write-build-html enforces (frame-set digest,
 * evidence-pack approval, and the manifest projection hash) because nothing less than a
 * working footage render can show the failure this exists to catch: the footage silently
 * dropping out while the build still exits 0. The digests are computed rather than
 * hardcoded, so a change to the lineage algorithm fails the positive control loudly
 * instead of leaving it quietly unfalsifiable.
 *
 * Two details are load-bearing and were wrong the first time:
 *   - frames are REAL JPEGs, because the runtime decodes them with `new Image()`;
 *   - frames are named ONE-BASED, because the runtime computes `idx = …+1` and requests
 *     `frame_00001.jpg` first (write-build-html.mjs, __setFootageFrame).
 * Zero-based text files satisfied every digest and loaded nothing.
 */
export function footageProject(t, { clipsJson, evidenceJson, manifestJson, frameBytes = FIXTURE_JPEG, gsapStub } = {}) {
  const fps = 30;
  const dir = makeProject(t, {
    'node_modules/gsap/dist/gsap.min.js': gsapStub ?? fs.readFileSync(path.join(fixturesDir, 'gsap-stub.js'), 'utf8'),
  });

  const clipRoot = path.join(dir, 'evidence-pack', 'footage', 'myclip');
  fs.mkdirSync(clipRoot, { recursive: true });
  for (let i = 1; i <= FOOTAGE_FRAME_COUNT; i++) {
    fs.writeFileSync(path.join(clipRoot, `frame_${String(i).padStart(5, '0')}.jpg`), frameBytes);
  }

  const frames = fs.readdirSync(clipRoot).filter((n) => /^frame_\d{5}\.jpg$/.test(n)).sort();
  const digest = crypto.createHash('sha256');
  digest.update(Buffer.from('sizzlecraft-frame-set-v1', 'utf8'));
  digest.update(Buffer.from([0]));
  for (const rel of frames) {
    const bytes = fs.readFileSync(path.join(clipRoot, rel));
    digest.update(Buffer.from(rel, 'utf8'));
    digest.update(Buffer.from([0]));
    digest.update(Buffer.from(String(bytes.length), 'ascii'));
    digest.update(Buffer.from([0]));
    digest.update(bytes);
    digest.update(Buffer.from([0]));
  }
  const frameSetSha = digest.digest('hex');
  const frameCount = frames.length;
  const redaction = 'clear';
  const projection = [{ id: 'myclip', frameSetSha, frameCount, fps, redaction }];
  const sha256 = crypto.createHash('sha256').update(Buffer.from(JSON.stringify(projection), 'utf8')).digest('hex');

  const write = (rel, body) => fs.writeFileSync(path.join(dir, rel), body);
  write(
    'evidence-pack/footage/clips.json',
    clipsJson ?? JSON.stringify({ clips: [{ id: 'myclip', approvedForUse: true, redaction, fps, frameCount, frameSetSha }] }),
  );
  write('evidence-pack/evidence-pack.json', evidenceJson ?? JSON.stringify({ assets: [{ kind: 'clip', id: 'myclip', approvedForUse: true }] }));
  write(
    'manifest.json',
    manifestJson ??
      JSON.stringify({
        stages: { 'materialize-footage': { derivedFootage: { kind: 'footage-frame-set-v1', producer: 'materialize-footage', sha256, clips: projection } } },
      }),
  );
  write(
    'timing.json',
    JSON.stringify({
      project: { name: 'demo', fps, width: 1280, height: 720, lede: 'l' },
      durationMs: 4000,
      contentMs: 4000,
      endCard: { enabled: true },
      segments: [
        { id: 'one', startMs: 0, endMs: 2000, voiceoverText: 'hello', visual: { mode: 'footage', footage: { clipId: 'myclip' } } },
        { id: 'two', startMs: 2000, endMs: 4000, voiceoverText: 'second segment here' },
      ],
    }),
  );
  return dir;
}

/**
 * Loads a built scene in Chromium and reports which footage frames actually decoded.
 *
 * The only way to tell "footage was refused" apart from "footage never rendered anyway"
 * is to watch a frame load. `__setFootageFrame` resolves false on a decode failure and
 * leaves the background unset, so it reports its own failure honestly — but only if
 * something asks.
 *
 * ANY page error fails this probe, unconditionally. The previous version recorded page
 * errors and examined them only when `__setFootageFrame` was undefined — a condition that
 * was true only while the stub was broken badly enough to kill the whole script block.
 * Repairing the stub far enough to define that function silently retired the check, and a
 * scene throwing on every trigger sailed through. A guard keyed on a symptom expires when
 * the symptom does, so this one is keyed on nothing.
 *
 * The scene is also driven through `fireTriggersUpTo` the way the capture path drives it,
 * so a scene that only breaks once triggers run cannot pass by never being asked to run.
 *
 * @returns {Promise<Array<{atMs: number, loaded: boolean, applied: string|null}>>}
 */
export async function probeFootageFrames(sceneHtml, atMsList) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--allow-file-access-from-files'] });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(pathToFileURL(sceneHtml).toString(), { waitUntil: 'load' });

    // The two failures are tagged and worded distinctly. They used to share the phrase
    // "page errors", so an assertion matching that was satisfied by either — which meant a
    // test written for the post-sampling check could be carried home by the init check and
    // nobody would know the later one had stopped being exercised.
    const failure = (stage, why) => {
      const seen = [...new Set(pageErrors)];
      const err = new Error(`${why}${seen.length ? ` — errors: ${seen.join(' | ')}` : ''}`);
      err.stage = stage;
      err.pageErrors = seen;
      return err;
    };

    if ((await page.evaluate(() => typeof window.__setFootageFrame)) !== 'function') {
      throw failure('init', 'the scene never initialised: __setFootageFrame was never defined');
    }

    const results = [];
    for (const atMs of atMsList) {
      try {
        await page.evaluate((ms) => window.fireTriggersUpTo(ms / 1000), atMs);
      } catch (err) {
        pageErrors.push(err.message); // same bucket; reported by the unconditional check below
      }
      const outcomes = await page.evaluate((ms) => window.__setFootageFrame(ms), atMs);
      const applied = await page.evaluate(() => document.querySelector('.footage-layer')?.dataset.cur ?? null);
      // An EMPTY outcome list is success, not absence. The runtime refuses to reload the URL
      // it is already showing (`if(el.dataset.cur===url)return`), so it returns no promises —
      // and driving fireTriggersUpTo first, which samples the same instant, makes that the
      // common case rather than a rare one. Scoring it as "no load" made this control
      // intermittently red for a reason that had nothing to do with the scene.
      results.push({
        atMs,
        loaded: outcomes.length > 0 ? outcomes.every(Boolean) : applied !== null,
        applied: applied ? applied.split('/').pop() : null,
      });
    }

    // Unconditional, and last: a scene that threw at any point is not operable, whatever
    // the frames did.
    if (pageErrors.length) {
      const err = failure('post-init', 'the scene threw while running, after it had initialised');
      err.frames = results;
      throw err;
    }
    return results;
  } finally {
    await browser.close();
  }
}

/**
 * The working gsap stub with exactly one method removed.
 *
 * Hand-authoring a second, smaller stub makes the broken fixture differ from the working
 * one in more ways than the method under test, so a resulting failure could come from
 * anywhere — including from a path other than the one the test means to pin. Deriving it
 * guarantees a single difference.
 *
 * Throws if the method is not found, because silently returning an unmodified stub would
 * make the alarm pass while testing nothing.
 */
export function gsapStubWithout(methodName) {
  const source = fs.readFileSync(path.join(fixturesDir, 'gsap-stub.js'), 'utf8');
  const pattern = new RegExp(String.raw`^[ \t]*${methodName}: function \([^)]*\) \{[^\n]*\},?[ \t]*\r?\n`, 'm');
  if (!pattern.test(source)) {
    throw new Error(`gsap-stub.js does not define ${methodName}() on a single line — cannot derive a broken variant from it`);
  }
  const broken = source.replace(pattern, '');
  if (broken === source) throw new Error(`removing ${methodName}() from gsap-stub.js changed nothing`);
  return broken;
}
export function runEngineScript(engineDir, script, args, cwd) {
  const r = spawnSync(process.execPath, [path.join(engineDir, script), ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', all: (r.stdout ?? '') + (r.stderr ?? '') };
}

/**
 * Runs a script and plants a fixture the moment `marker` appears, handing the callback the
 * child's PID.
 *
 * The encode temp file is named `<out>.part-<pid>`, so a collision cannot be staged before
 * the run — the PID is not knowable until the process exists. The marker gives a
 * synchronisation point inside the run, and `planted` is returned so a test can prove the
 * collision was actually staged rather than passing because it never happened.
 */
export function runScriptPlantingOnMarker(engineDir, script, args, cwd, marker, plant) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(engineDir, script), ...args], { cwd });
    let all = '';
    let planted = false;
    const onChunk = (chunk) => {
      all += chunk;
      if (!planted && all.includes(marker)) {
        planted = true;
        plant(child.pid);
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, all, planted }));
  });
}
