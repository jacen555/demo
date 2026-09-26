// Behavioural tests for the safety and honesty contract of the engine's CLI scripts.
//
// The property under test, across every case here:
//   "if a script exits 0, it did the job it was asked to do — and if it was not
//    explicitly told to destroy something, it destroyed nothing."
//
// These scripts execute on import (they are CLI entry points), so they are exercised
// as subprocesses in a throwaway project directory and asserted on their exit code
// plus the observable filesystem, which is the contract their callers actually rely on.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { EXIT, resolveWithinRoot, parseBoundedNumber, requirePositiveNumber, CliError } from '../src/cli-support.mjs';
import { normalizeEndCardFields } from '../src/end-card.mjs';
import { assertCleanExit } from './_helpers.mjs';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Creates a throwaway project dir, removed when the test ends. */
function makeProject(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sizzlecraft-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  return dir;
}

/** Runs an engine script as a real CLI in `cwd` and returns its exit code + streams. */
function runScript(script, args, cwd) {
  const r = spawnSync(process.execPath, [path.join(srcDir, script), ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', all: (r.stdout ?? '') + (r.stderr ?? '') };
}

const timingFixture = (segments, extra = {}) =>
  JSON.stringify({
    project: { name: 'demo', fps: 30, width: 1280, height: 720 },
    durationMs: segments.at(-1).endMs,
    contentMs: segments.at(-1).endMs,
    segments,
    ...extra,
  });

/** An absolute path that is guaranteed not to be an executable, for the "ffmpeg never ran" cases. */
const MISSING_FFMPEG = path.join(os.tmpdir(), 'sizzlecraft-no-such-dir', 'no-such-ffmpeg-binary.exe');

// Schema validation needs ajv. The contract holds either way — with ajv a bad shape must
// fail, without it the verifier must refuse to report a pass — so the suite asserts
// whichever half this environment can actually reach rather than assuming one.
const ajvAvailable = await import('ajv/dist/2020.js').then(() => true, () => false);

const contiguousSegments = [
  { id: 'one', startMs: 0, endMs: 2000, voiceoverText: 'hello there' },
  { id: 'two', startMs: 2000, endMs: 4000, voiceoverText: 'second segment here' },
];

// ---------------------------------------------------------------------------
// write-build-html.mjs, `code` visual mode.
//
// This is the only mode that renders SOURCE DATA rather than authored copy, so it carries
// two refusals nothing else needs: no-go patterns are enforced where the data reaches a
// frame, and a highlight addressing a field that does not exist fails the BUILD.
//
// The second one exists because of a defect this pipeline actually shipped: a trigger whose
// target did not resolve returned null, animated nothing, and reported success. A highlight
// that never fires is indistinguishable from one the viewer missed, so it must not degrade
// to a warning in a 25-minute render log — it has to stop the build.
// ---------------------------------------------------------------------------
describe('write-build-html code mode', () => {
  const OBJ = {
    id: 'demo-scenario',
    opening: 'My email has just stopped working.',
    facts: ['first fact', 'second fact', 'third fact'],
    assertions: ['l5Exact', 'slotAbsent:scope/confirm'],
  };

  const codeProject = (t, { highlights, json = OBJ, extra = {}, noGoPatterns, omitNoGo = false } = {}) => {
    const seg = {
      id: 'scenario', startMs: 0, endMs: 6000, voiceoverText: 'one scenario field by field',
      visual: { mode: 'code', title: 'One scenario', json, ...(highlights ? { highlights } : {}), ...extra },
    };
    const timing = JSON.parse(timingFixture([seg]));
    // code mode requires the key to be present; `[]` is the explicit opt-out. Tests that
    // are not about redaction supply it so they exercise what they actually name.
    if (!omitNoGo) timing.project.noGoPatterns = noGoPatterns ?? [];
    // gsap is resolved from the PROJECT, not the engine — a local-first render refuses a
    // CDN. Without this stub every case below exits non-zero on the missing dependency,
    // which silently turns the "must refuse" tests into false passes.
    return makeProject(t, {
      'timing.json': JSON.stringify(timing),
      'evidence-pack/.gitkeep': '',
      'node_modules/gsap/dist/gsap.min.js': '/* stub */',
    });
  };

  const build = (dir) => runScript('write-build-html.mjs', ['--apply'], dir);
  const html = (dir) => fs.readFileSync(path.join(dir, 'video-auto.html'), 'utf8');

  test('codeMode_rendersEachFieldWithAnAddressableId', (t) => {
    const dir = codeProject(t);
    const r = build(dir);

    assert.equal(r.code, EXIT.OK, r.all);
    const out = html(dir);
    assert.match(out, /id="scenario-path-opening"/, 'a top-level field must be addressable');
    assert.match(out, /id="scenario-path-facts-1"/, 'an array element must be addressable by index');
    assert.match(out, /class="j-key"/, 'keys must be marked up for highlighting, not rendered as flat text');
  });

  test('codeMode_highlightAddressingAMissingPath_failsTheBuildAndSuggestsRealOnes', (t) => {
    const dir = codeProject(t, { highlights: [{ path: 'factz', atMs: 100 }] });
    const r = build(dir);

    assert.notEqual(r.code, EXIT.OK, `a bad highlight path must fail the build, got ${r.code}\n${r.all}`);
    assert.match(r.all, /does not exist/, 'and say so plainly');
    assert.match(r.all, /facts/, 'and name the paths that do exist, so the author can fix it now');
    assert.doesNotMatch(r.all, /at ModuleJob|\bat async\b/, 'an authoring mistake is a refusal, not a crash');
    assert.equal(fs.existsSync(path.join(dir, 'video-auto.html')), false, 'nothing is written on refusal');
  });

  // THE END OF A LIST BEHAVES DIFFERENTLY FROM THE MIDDLE. An off-by-one in the path walk
  // shows up only on the final element, where there is no following sibling to mask it.
  test('codeMode_highlightOnTheLastElementOfTheLastArray_resolves', (t) => {
    const dir = codeProject(t, { highlights: [{ path: 'assertions[1]', atMs: 100 }] });
    const r = build(dir);

    assert.equal(r.code, EXIT.OK, `the last element of the last array must resolve, got ${r.code}\n${r.all}`);
    assert.match(html(dir), /id="scenario-path-assertions-1"/);
  });

  test('codeMode_highlightPastTheEndOfAnArray_failsRatherThanRenderingNothing', (t) => {
    const dir = codeProject(t, { highlights: [{ path: 'assertions[2]', atMs: 100 }] });
    const r = build(dir);

    assert.notEqual(r.code, EXIT.OK, `index past the end must fail, got ${r.code}\n${r.all}`);
    assert.match(r.all, /does not exist/, 'and fail for THAT reason, not an unrelated one');
  });

  test('codeMode_jsonMatchingANoGoPattern_refusesBeforeItReachesAFrame', (t) => {
    const dir = codeProject(t, {
      json: { ...OBJ, endpoint: 'https://test1.internal.example.com/api' },
      noGoPatterns: ['https?://', '\\btest1\\b'],
    });
    const r = build(dir);

    assert.notEqual(r.code, EXIT.OK, `a no-go match must refuse, got ${r.code}\n${r.all}`);
    assert.match(r.all, /no-go match/, 'and name the pattern that matched');
    assert.equal(fs.existsSync(path.join(dir, 'video-auto.html')), false);
  });

  // A GUARD MUST NOT DISCLOSE WHAT IT REFUSES. An earlier version printed 80 characters of
  // the matched value "so the author could see what tripped", which moves the very content
  // the pattern exists to contain into the console and the render log.
  test('codeMode_noGoRefusal_namesThePathButNeverTheMatchedValue', (t) => {
    const SECRET = 'https://sentinel-host-9f2c.example.com/api';
    const dir = codeProject(t, {
      json: { ...OBJ, endpoint: SECRET },
      noGoPatterns: ['https?://'],
    });
    const r = build(dir);

    assert.notEqual(r.code, EXIT.OK, r.all);
    assert.match(r.all, /endpoint/, 'the JSON path is what the author needs, and it is not sensitive');
    assert.ok(!r.all.includes('sentinel-host-9f2c'), 'the matched value must never be echoed');
    assert.ok(!r.all.includes(SECRET), 'nor any part of it');
  });

  // ABSENT IS NOT PERMISSION. Defaulting a missing list to "no patterns" made the
  // frame-boundary guarantee inert in exactly the project least likely to have reviewed
  // its source data — which is how the real consumer shipped with it switched off while
  // every test passed on its own fixture.
  test('codeMode_noGoPatternsMissingEntirely_refusesRatherThanAllowingEverything', (t) => {
    const dir = codeProject(t, { omitNoGo: true });   // no noGoPatterns key at all
    const r = build(dir);

    assert.notEqual(r.code, EXIT.OK, `a missing no-go list must refuse, got ${r.code}\n${r.all}`);
    assert.match(r.all, /requires timing\.project\.noGoPatterns/);
    assert.match(r.all, /\[\]/, 'and say how to opt out explicitly');
  });

  test('codeMode_noGoPatternsEmptyArray_isAnExplicitOptOutAndBuilds', (t) => {
    const dir = codeProject(t, { noGoPatterns: [] });
    const r = build(dir);

    assert.equal(r.code, EXIT.OK, `an explicit empty list must be accepted, got ${r.code}\n${r.all}`);
  });

  // `k in data` walks the prototype chain, so `__proto__` resolves without existing in the
  // JSON; and descending into a string throws a native error that can quote that string,
  // before the no-go guard has run.
  test('codeMode_pickTraversingPrototypeOrString_refusesWithoutEchoingContent', (t) => {
    for (const pick of ['__proto__', 'opening.length']) {
      const dir = codeProject(t, { extra: { json: undefined, jsonFile: 'data.json', pick } });
      fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ opening: 'SENTINEL-PICK-4a1b' }));
      const r = build(dir);

      assert.notEqual(r.code, EXIT.OK, `pick "${pick}" must not resolve, got ${r.code}\n${r.all}`);
      assert.ok(!r.all.includes('SENTINEL-PICK-4a1b'), `pick "${pick}" must not echo file contents`);
    }
  });

  test('codeMode_jsonFileEscapingTheProject_refuses', (t) => {
    const dir = codeProject(t, { extra: { json: undefined, jsonFile: '../../../etc/passwd' } });
    const r = build(dir);

    assert.notEqual(r.code, EXIT.OK, `a path escape must refuse, got ${r.code}\n${r.all}`);
    assert.match(r.all, /outside|escape/i);
  });

  // OUTSIDE-LINK VICTIM TEST. A lexical check passes here: the path stays inside the
  // project as text and only leaves once the link is followed. `code` mode renders file
  // contents straight into the frame, so an escaping read is not a log line someone might
  // notice — it is composited into the video and encoded.
  test('codeMode_jsonFileViaLinkPointingOutsideTheProject_refusesAndDoesNotDiscloseTheVictim', (t) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sizzlecraft-victim-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const SENTINEL = 'SENTINEL-SECRET-b7f3e1a9';
    const victim = path.join(outside, 'secret.json');
    fs.writeFileSync(victim, JSON.stringify({ token: SENTINEL }));

    const dir = codeProject(t, { extra: { json: undefined, jsonFile: 'linked.json' } });
    try {
      fs.symlinkSync(victim, path.join(dir, 'linked.json'), 'file');
    } catch {
      t.skip('symlink creation requires privilege on this platform');
      return;
    }

    const r = build(dir);

    assert.notEqual(r.code, EXIT.OK, `a link out of the project must refuse, got ${r.code}\n${r.all}`);
    assert.match(r.all, /passes through a link|outside the project root/i,
      'and refuse for THAT reason — a lexical check would have let this through');
    assert.doesNotMatch(r.all, /at ModuleJob|\bat async\b/, 'a refusal is not a crash; no stack trace');
    assert.ok(!r.all.includes(SENTINEL), 'the refusal must not echo the victim file contents');
    if (fs.existsSync(path.join(dir, 'video-auto.html'))) {
      const out = fs.readFileSync(path.join(dir, 'video-auto.html'), 'utf8');
      assert.ok(!out.includes(SENTINEL), 'and the victim must never reach a frame');
    }
  });

  // JSON.parse embeds the first bytes it parsed in its error message, so echoing the
  // parser's text discloses file contents on any read the guard did allow.
  test('codeMode_unparseableJsonFile_reportsWithoutEchoingFileContents', (t) => {
    const SENTINEL = 'SENTINEL-INSIDE-9f2c';
    const dir = codeProject(t, { extra: { json: undefined, jsonFile: 'broken.json' } });
    fs.writeFileSync(path.join(dir, 'broken.json'), `{ "leak": "${SENTINEL}" `);

    const r = build(dir);

    assert.notEqual(r.code, EXIT.OK, `unparseable JSON must fail, got ${r.code}\n${r.all}`);
    assert.match(r.all, /not valid JSON/);
    assert.ok(!r.all.includes(SENTINEL), 'the parser message must not be echoed verbatim');
  });

  // WCAG 1.4.1: the focused field must be distinguishable without relying on hue.
  // THE BLANK-SEGMENT CANARY. `.codewrap` carries `.el`, so it is hidden until revealed —
  // and codeFocus targets a FIELD, which cannot reveal its hidden ancestor. Without an
  // explicit reveal of the block the entire segment renders blank, with every trigger
  // resolving and "succeeding" against an invisible element. Frames came back
  // byte-identical across four different timestamps, which is the only way this shows up.
  test('codeMode_emitsAnExplicitRevealOfTheBlock_notOnlyFieldFocuses', (t) => {
    const dir = codeProject(t, { highlights: [{ path: 'opening', atMs: 100 }] });
    assert.equal(build(dir).code, EXIT.OK);

    const out = html(dir);
    const reveals = out.match(/"scenario-code"/g) || [];
    assert.ok(reveals.length >= 2,
      'the block needs its own reveal as well as the focus release — otherwise the segment is blank');
    assert.match(out, /codeFocus/, 'and the field focuses must still be emitted');
  });

  test('codeMode_focusStyling_usesOutlineAndDimmingNotColourAlone', (t) => {
    const dir = codeProject(t, { highlights: [{ path: 'opening', atMs: 100 }] });
    assert.equal(build(dir).code, EXIT.OK);

    const out = html(dir);
    assert.match(out, /\.j-entry\.is-focus\{[^}]*outline:/, 'focus must carry an outline');
    assert.match(out, /\.codeblock\.is-dim\s+\.j-entry\.is-off\{[^}]*opacity:/, 'and dim the rest');
  });
});

// ---------------------------------------------------------------------------
// frame-capture.mjs — the highest-value guard in this suite.
// A no-flag run used to recursively delete the project's frames/ directory before
// it had done a single useful thing.
// ---------------------------------------------------------------------------
describe('frame-capture safe default', () => {
  const project = (t) =>
    makeProject(t, {
      'timing.json': timingFixture(contiguousSegments),
      'video-auto.html': '<html><body><div id="stage"></div></body></html>',
      'frames/frame_00000.png': 'EXISTING FRAME ZERO',
      'frames/frame_00001.png': 'EXISTING FRAME ONE',
    });

  test('frameCapture_noFlags_preservesExistingFramesAndExitsZero', (t) => {
    const dir = project(t);
    const r = runScript('frame-capture.mjs', [], dir);

    assert.equal(r.code, EXIT.OK, `expected a clean plan exit, got ${r.code}\n${r.all}`);
    assert.equal(
      fs.readFileSync(path.join(dir, 'frames', 'frame_00000.png'), 'utf8'),
      'EXISTING FRAME ZERO',
      'a default (no-flag) run must not destroy existing frames',
    );
    assert.ok(fs.existsSync(path.join(dir, 'frames', 'frame_00001.png')));
  });

  test('frameCapture_noFlags_printsPlanAndDoesNotCapture', (t) => {
    const dir = project(t);
    const r = runScript('frame-capture.mjs', [], dir);

    assert.match(r.all, /plan/i, 'the default run must announce that it is only planning');
    assert.match(r.all, /--apply/, 'the plan must name the flag that would actually perform the capture');
  });

  test('frameCapture_applyWithLockHeldByLiveOwner_exitsSkippedNotZero', (t) => {
    const dir = project(t);
    // A live PID (this test process) owns the lock, so the capture must not run.
    fs.writeFileSync(path.join(dir, 'frames.lock'), String(process.pid));

    const r = runScript('frame-capture.mjs', ['--apply'], dir);

    assert.equal(r.code, EXIT.SKIPPED, `a skipped capture must not report success, got ${r.code}\n${r.all}`);
    assert.equal(
      fs.readFileSync(path.join(dir, 'frames', 'frame_00000.png'), 'utf8'),
      'EXISTING FRAME ZERO',
      'a capture that never ran must leave the existing frames alone',
    );
  });
});

// ---------------------------------------------------------------------------
// silence-gen.mjs — wrote to an unchecked, unconfined output path on any invocation.
// ---------------------------------------------------------------------------
describe('silence-gen safe default', () => {
  test('silenceGen_noFlags_doesNotWriteOutputAndExitsZero', (t) => {
    const dir = makeProject(t);
    const r = runScript('silence-gen.mjs', ['--out', 'silence.mp3', '--ms', '500'], dir);

    assert.equal(r.code, EXIT.OK, `planning is a success, got ${r.code}\n${r.all}`);
    assert.equal(fs.existsSync(path.join(dir, 'silence.mp3')), false, 'a default run must not write');
  });

  test('silenceGen_applyOverExistingFileWithoutReplace_refusesAndPreservesBytes', (t) => {
    const dir = makeProject(t, { 'silence.mp3': 'DO NOT CLOBBER ME' });
    const r = runScript('silence-gen.mjs', ['--out', 'silence.mp3', '--ms', '500', '--apply'], dir);

    assert.equal(r.code, EXIT.USAGE, `expected a refusal, got ${r.code}\n${r.all}`);
    assert.equal(fs.readFileSync(path.join(dir, 'silence.mp3'), 'utf8'), 'DO NOT CLOBBER ME');
    assert.match(r.all, /--replace/, 'the refusal must name the flag that would allow the overwrite');
  });

  test('silenceGen_applyReplace_writesFrameAlignedSilence', (t) => {
    const dir = makeProject(t, { 'silence.mp3': 'OLD' });
    const r = runScript('silence-gen.mjs', ['--out', 'silence.mp3', '--ms', '480', '--apply', '--replace'], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    const buf = fs.readFileSync(path.join(dir, 'silence.mp3'));
    // 480ms / 24ms per frame = 20 frames of 288 bytes.
    assert.equal(buf.length, 20 * 288);
    assert.deepEqual([...buf.subarray(0, 4)], [0xff, 0xf3, 0xa4, 0xc0], 'MPEG-2 L3 24kHz 96kbps mono header');
  });

  test('silenceGen_outPathEscapingProjectRoot_exitsUsageErrorAndWritesNothing', (t) => {
    const dir = makeProject(t);
    const escape = path.join('..', 'escaped-silence.mp3');
    const r = runScript('silence-gen.mjs', ['--out', escape, '--ms', '500', '--apply', '--replace'], dir);

    assert.equal(r.code, EXIT.USAGE, `expected a refusal, got ${r.code}\n${r.all}`);
    assert.equal(fs.existsSync(path.resolve(dir, escape)), false, 'must never write outside the project root');
  });

  test('silenceGen_nonNumericDuration_exitsUsageError', (t) => {
    const dir = makeProject(t);
    const r = runScript('silence-gen.mjs', ['--out', 'x.mp3', '--ms', '3500; rm -rf /', '--apply'], dir);

    assert.equal(r.code, EXIT.USAGE, r.all);
    assert.equal(fs.existsSync(path.join(dir, 'x.mp3')), false);
  });
});

// ---------------------------------------------------------------------------
// validate-timing.mjs — a verifier that printed failures and exited 0 is a green
// light nobody earned.
// ---------------------------------------------------------------------------
describe('validate-timing exit contract', () => {
  test('validateTiming_contiguousSegments_exitsZero', (t) => {
    const dir = makeProject(t, { 'timing.json': timingFixture(contiguousSegments) });
    const r = runScript('validate-timing.mjs', ['--no-schema'], dir);

    assert.equal(r.code, EXIT.OK, `a valid timing file must pass, got ${r.code}\n${r.all}`);
  });

  // REPLACES `validateTiming_segmentGap_exitsFailureNotZero`, which asserted that any GAP
  // must fail. That could never hold against real output: voice.mjs deliberately inserts
  // inter-segment silence — the perceived pause — plus a lead-in, so every timeline the
  // real pipeline produces is monotonic but NOT adjacent, and a correct timeline failed on
  // every segment. A test that pins a defect converts it into a requirement and makes the
  // correct fix arrive as a regression, so it is replaced rather than relaxed.
  //
  // An OVERLAP is the thing that is actually wrong, so that is what is asserted now.
  test('validateTiming_overlappingSegments_exitsFailureNotZero', (t) => {
    const overlapped = [
      { id: 'one', startMs: 0, endMs: 2000, voiceoverText: 'hello there' },
      { id: 'two', startMs: 1500, endMs: 4000, voiceoverText: 'i start before one ended' },
    ];
    const dir = makeProject(t, { 'timing.json': timingFixture(overlapped) });
    const r = runScript('validate-timing.mjs', ['--no-schema'], dir);

    assert.equal(r.code, EXIT.FAILED, `an overlap must fail the build, got ${r.code}\n${r.all}`);
    assert.match(r.all, /overlap/i);
  });

  test('validateTiming_uniformInterSegmentGaps_passAndAreReported', (t) => {
    const gapped = [
      { id: 'one', startMs: 0, endMs: 2000, voiceoverText: 'hello there' },
      { id: 'two', startMs: 2500, endMs: 4500, voiceoverText: 'gap before me' },
      { id: 'three', startMs: 5000, endMs: 7000, voiceoverText: 'and before me too' },
    ];
    const dir = makeProject(t, { 'timing.json': timingFixture(gapped) });
    const r = runScript('validate-timing.mjs', ['--no-schema'], dir);

    assert.equal(r.code, EXIT.OK, `deliberate perceived gaps must not fail, got ${r.code}\n${r.all}`);
    assert.match(r.all, /uniform 500 ms/, 'and the gap must be reported, not silently accepted');
  });

  // An uneven gap is still worth seeing — it usually means a hand-edited window.
  test('validateTiming_unevenGaps_passButAreCalledOut', (t) => {
    const uneven = [
      { id: 'one', startMs: 0, endMs: 2000, voiceoverText: 'hello there' },
      { id: 'two', startMs: 2500, endMs: 4500, voiceoverText: 'five hundred after' },
      { id: 'three', startMs: 5400, endMs: 7000, voiceoverText: 'nine hundred after' },
    ];
    const dir = makeProject(t, { 'timing.json': timingFixture(uneven) });
    const r = runScript('validate-timing.mjs', ['--no-schema'], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(r.all, /UNEVEN/, 'an uneven gap must be visible even though it passes');
  });

  // The lead-in is a gap before the FIRST segment — the same mechanism, and the case the
  // strict-adjacency check hit first on every real run.
  test('validateTiming_leadInBeforeFirstSegment_passesAndIsReported', (t) => {
    const withLeadIn = [
      { id: 'one', startMs: 2016, endMs: 4016, voiceoverText: 'after the lead in' },
      { id: 'two', startMs: 4016, endMs: 6016, voiceoverText: 'straight after' },
    ];
    const dir = makeProject(t, { 'timing.json': timingFixture(withLeadIn) });
    const r = runScript('validate-timing.mjs', ['--no-schema'], dir);

    assert.equal(r.code, EXIT.OK, `a lead-in is not a contiguity break, got ${r.code}\n${r.all}`);
    assert.match(r.all, /contiguity: OK/);
  });

  test('validateTiming_noSchemaFlag_marksShapeAsNotVerified', (t) => {
    const dir = makeProject(t, { 'timing.json': timingFixture(contiguousSegments) });
    const r = runScript('validate-timing.mjs', ['--no-schema'], dir);

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(r.all, /skipped/i, 'a skipped check must say it was skipped');
    assert.match(r.all, /NOT verified/i, 'and must not let the reader assume the shape was checked');
  });

  test('validateTiming_validTimingWithSchema_exitsZero', { skip: ajvAvailable ? false : 'ajv not installed' }, (t) => {
    const dir = makeProject(t, { 'timing.json': timingFixture(contiguousSegments) });
    const r = runScript('validate-timing.mjs', [], dir);

    assert.equal(r.code, EXIT.OK, `the shipped schema must accept a well-formed timing file\n${r.all}`);
    assert.match(r.all, /SCHEMA: valid/);
  });

  test('validateTiming_schemaViolation_exitsFailureNotZero', { skip: ajvAvailable ? false : 'ajv not installed' }, (t) => {
    // `voiceoverText` is required by the shipped schema; contiguity is intact, so this
    // isolates the schema check.
    const missingText = [
      { id: 'one', startMs: 0, endMs: 2000 },
      { id: 'two', startMs: 2000, endMs: 4000, voiceoverText: 'fine' },
    ];
    const dir = makeProject(t, { 'timing.json': timingFixture(missingText) });
    const r = runScript('validate-timing.mjs', [], dir);

    assert.equal(r.code, EXIT.FAILED, `a schema violation must fail the build, got ${r.code}\n${r.all}`);
    assert.match(r.all, /SCHEMA: INVALID/);
  });

  test('validateTiming_schemaUnavailable_exitsNonZeroRatherThanSkipping', { skip: ajvAvailable ? 'ajv is installed' : false }, (t) => {
    const dir = makeProject(t, { 'timing.json': timingFixture(contiguousSegments) });
    const r = runScript('validate-timing.mjs', [], dir);

    assertCleanExit(r, EXIT.USAGE, 'schema validation that did not happen must never look like a pass: ');
    assert.match(r.all, /ajv|--no-schema/i, 'the failure must tell the user what to do');
  });

  test('validateTiming_schemaFileMissing_exitsUsageError', (t) => {
    const dir = makeProject(t, { 'timing.json': timingFixture(contiguousSegments) });
    const r = runScript('validate-timing.mjs', ['--schema', 'no-such-schema.json'], dir);

    assert.equal(r.code, EXIT.USAGE, r.all);
  });
});

// ---------------------------------------------------------------------------
// The schema IS the rule, and a rule that cannot fail reads exactly like a rule that
// passed.
//
// As shipped, `required` listed only `segments`: `version` was unconstrained, `theme`
// was undeclared, and the end-card rule was absent entirely. Round 1 made the validator
// able to REPORT schema errors and then handed it a schema that barely checked anything,
// so a timing.json with four real violations validated clean.
// ---------------------------------------------------------------------------
describe('the shipped schema enforces the timing contract', { skip: ajvAvailable ? false : 'ajv not installed' }, () => {
  const validate = (t, extra) => {
    const dir = makeProject(t, { 'timing.json': timingFixture(contiguousSegments, extra) });
    return runScript('validate-timing.mjs', [], dir);
  };
  const assertRejected = (r, why) => {
    assert.equal(r.code, EXIT.FAILED, `${why}\n${r.all}`);
    assert.match(r.all, /SCHEMA: INVALID/, why);
  };
  const assertAccepted = (r, why) => {
    assert.equal(r.code, EXIT.OK, `${why}\n${r.all}`);
    assert.match(r.all, /SCHEMA: valid/, why);
  };

  test('validateTiming_numericVersion_isRejected', (t) => {
    assertRejected(validate(t, { version: 1 }), 'version must be a string, not a number');
  });

  test('validateTiming_floatVersion_isRejected', (t) => {
    // `1.0` in JSON is the number 1 — the version "1.10" and the version "1.1" are the
    // same value once a float has eaten them.
    assertRejected(validate(t, { version: 1.0 }), 'a float version must be rejected');
  });

  test('validateTiming_stringVersion_isAccepted', (t) => {
    assertAccepted(validate(t, { version: '1.0' }), 'a string version is the contract');
  });

  test('validateTiming_themeAsObject_isRejected', (t) => {
    // `THEMES[{}]` is undefined and the lookup falls back to midnight, so an object here
    // silently rendered the wrong theme rather than failing.
    assertRejected(validate(t, { theme: {} }), 'an object theme must be rejected');
  });

  test('validateTiming_unknownThemeName_isRejected', (t) => {
    assertRejected(validate(t, { theme: 'neon' }), 'an unknown theme silently becomes midnight');
  });

  test('validateTiming_knownThemeName_isAccepted', (t) => {
    assertAccepted(validate(t, { theme: 'slate' }), 'every shipped theme must still validate');
  });

  test('validateTiming_projectThemeAsObject_isRejected', (t) => {
    // project.theme is the FIRST lookup write-build-html tries, so constraining only the
    // top-level copy would leave the one that actually wins unchecked.
    assertRejected(
      validate(t, { project: { name: 'demo', fps: 30, width: 1280, height: 720, theme: {} } }),
      'project.theme is read before the top-level one',
    );
  });

  test('validateTiming_intakeThemeUnknown_isRejected', (t) => {
    assertRejected(validate(t, { intake: { theme: 'neon' } }), 'intake.theme is the third lookup and is read too');
  });

  test('validateTiming_disabledEndCardWithStrayBuilderVersion_isRejected', (t) => {
    assertRejected(
      validate(t, { endCard: { enabled: false }, contentMs: undefined, builderVersion: '1.2.3' }),
      'a disabled end card must not carry a builderVersion',
    );
  });

  test('validateTiming_disabledEndCardWithPresentButValidFields_isRejected', (t) => {
    // Isolates the absence rule: 4000/2500 satisfy every type constraint they have, so
    // the ONLY thing that can reject this timeline is "a disabled end card carries none
    // of its fields".
    assertRejected(
      validate(t, { endCard: { enabled: false }, contentMs: 4000, outroMs: 2500 }),
      'contentMs/outroMs must be ABSENT when the end card is off',
    );
  });

  test('validateTiming_disabledEndCardWithZeroedFields_isRejectedBySchema', (t) => {
    // Present-and-zero is not absent. Zero reads as "measured it, got nothing", which is
    // a different claim from "there is no end card".
    //
    // Asserted on the SCHEMA verdict rather than the exit code: zero additionally trips
    // the contentMs >= 1 range guard, which throws EXIT.USAGE before the verdict is
    // computed. The code is a symptom of the earlier guard; the schema's judgement is
    // the property under test.
    const r = validate(t, { endCard: { enabled: false }, contentMs: 0, outroMs: 0 });

    assert.match(r.all, /SCHEMA: INVALID/, `present-and-zero must not satisfy the rule\n${r.all}`);
    assert.notEqual(r.code, EXIT.OK, 'and it must never be reported as a pass');
  });

  test('validateTiming_disabledEndCardWithNoEndCardFields_isAccepted', (t) => {
    assertAccepted(
      validate(t, { endCard: { enabled: false }, contentMs: undefined }),
      'a correctly-stripped disabled end card must still validate',
    );
  });

  test('validateTiming_enabledEndCardWithItsFields_isAccepted', (t) => {
    // The rule must not misfire on the case it does not govern.
    assertAccepted(
      validate(t, { endCard: { enabled: true }, contentMs: 4000, outroMs: 2500, builderVersion: '1.2.3' }),
      'an enabled end card legitimately carries all three fields',
    );
  });
});

// ---------------------------------------------------------------------------
// Enforcing the end-card rule exposes a real defect rather than fixing one: voice.mjs
// stripped contentMs and outroMs when the end card was disabled and left builderVersion
// behind, so once the rule is enforced NO run could produce a schema-valid disabled
// end-card timeline. Enforcing the schema without this turns a silent defect into a
// broken pipeline for every consumer that disables the end card.
// ---------------------------------------------------------------------------
describe('end-card field normalisation', () => {
  const base = () => ({
    builderVersion: '1.2.3',
    contentMs: 999,
    outroMs: 999,
    durationMs: 999,
    endCard: { enabled: false },
  });

  test('normalizeEndCardFields_endCardDisabled_stripsEveryEndCardOnlyField', () => {
    const timing = normalizeEndCardFields(base(), { contentMs: 4000, outroMs: 2500 });

    assert.equal(Object.hasOwn(timing, 'builderVersion'), false, 'builderVersion is an end-card field too');
    assert.equal(Object.hasOwn(timing, 'contentMs'), false);
    assert.equal(Object.hasOwn(timing, 'outroMs'), false);
    assert.equal(timing.durationMs, 4000, 'a disabled end card ends at the content');
  });

  test('normalizeEndCardFields_endCardEnabled_populatesAllThreeFields', () => {
    const timing = normalizeEndCardFields({ ...base(), endCard: { enabled: true } }, { contentMs: 4000, outroMs: 2500 });

    assert.equal(timing.builderVersion, '1.2.3', 'an enabled end card keeps the version it displays');
    assert.equal(timing.contentMs, 4000);
    assert.equal(timing.outroMs, 2500);
    assert.equal(timing.durationMs, 6500, 'content plus outro');
  });

  test('normalizeEndCardFields_disabledEndCardResult_validatesAgainstTheShippedSchema', { skip: ajvAvailable ? false : 'ajv not installed' }, async () => {
    // The direction that matters: what a real run PRODUCES must satisfy the rule the
    // validator now enforces. Asserting the rejection alone would have shipped a schema
    // no pipeline output could pass.
    const { default: Ajv } = await import('ajv/dist/2020.js');
    const schema = JSON.parse(fs.readFileSync(path.join(srcDir, 'timing-schema.json'), 'utf8'));
    const validateSchema = new Ajv({ allErrors: true, strict: false }).compile(schema);

    const timing = normalizeEndCardFields({ ...base(), segments: contiguousSegments }, { contentMs: 4000, outroMs: 2500 });

    assert.equal(validateSchema(timing), true, `voice.mjs output must satisfy the schema: ${JSON.stringify(validateSchema.errors)}`);
  });
});

// ---------------------------------------------------------------------------
// remix is the OTHER producer of a timing file, and it wrote contentMs/outroMs
// unconditionally — so it exited 0 having produced a file the restored schema rejects.
//
// normalizeEndCardFields was extracted this round to be reusable and then applied to one
// of its two call sites. This domain's record: assertDistinctDestinations applied to one
// collection, resolveInternalArtifact to capture metadata only, and now this. The newest
// mechanism is the least applied.
// ---------------------------------------------------------------------------
describe('every producer of a timing file obeys the end-card rule', { skip: ajvAvailable ? false : 'ajv not installed' }, () => {
  /** Real, probeable MP3s built with the engine's own generator — remix measures them. */
  const remixableProject = (t, endCardEnabled) => {
    const dir = makeProject(t);
    for (const name of ['segment_000.mp3', 'segment_001.mp3']) {
      const g = runScript('silence-gen.mjs', ['--out', name, '--ms', '2000', '--apply'], dir);
      assert.equal(g.code, EXIT.OK, `fixture audio must build for this test to mean anything\n${g.all}`);
    }
    const segments = [
      { id: 'one', startMs: 0, endMs: 2000, voiceoverText: 'hello there', audio: { file: 'segment_000.mp3', durationMs: 2000 } },
      { id: 'two', startMs: 2000, endMs: 4000, voiceoverText: 'second segment here', audio: { file: 'segment_001.mp3', durationMs: 2000 } },
    ];
    fs.writeFileSync(
      path.join(dir, 'timing.json'),
      JSON.stringify({
        project: { name: 'demo', fps: 30, width: 320, height: 240 },
        durationMs: 4000,
        contentMs: 4000,
        outroMs: 2500,
        endCard: { enabled: endCardEnabled },
        builderVersion: '9.9.9',
        intake: { toleranceMs: 60_000, leadInMs: 0, perceivedGapMs: 0 },
        segments,
      }),
    );
    return dir;
  };

  test('remix_disabledEndCard_producesTimingTheShippedSchemaAccepts', (t) => {
    const dir = remixableProject(t, false);

    const remix = runScript('remix.mjs', ['--apply', '--replace'], dir);
    assert.equal(remix.code, EXIT.OK, `remix must succeed for its output to be judged\n${remix.all}`);

    // Judged by the shipped schema, not by an expectation restated here.
    const check = runScript('validate-timing.mjs', [], dir);
    assert.match(check.all, /SCHEMA: valid/, `remix produced a timing file its own validator rejects\n${check.all}`);

    const produced = JSON.parse(fs.readFileSync(path.join(dir, 'timing.json'), 'utf8'));
    assert.equal(Object.hasOwn(produced, 'builderVersion'), false, 'builderVersion is an end-card field');
    assert.equal(Object.hasOwn(produced, 'contentMs'), false);
    assert.equal(Object.hasOwn(produced, 'outroMs'), false);
  });

  test('remix_enabledEndCard_stillPopulatesTheEndCardFields', (t) => {
    // The rule must not misfire on the case it does not govern.
    const dir = remixableProject(t, true);

    const remix = runScript('remix.mjs', ['--apply', '--replace'], dir);
    assert.equal(remix.code, EXIT.OK, remix.all);

    const produced = JSON.parse(fs.readFileSync(path.join(dir, 'timing.json'), 'utf8'));
    assert.equal(produced.builderVersion, '9.9.9', 'an enabled end card keeps the version it displays');
    assert.equal(typeof produced.contentMs, 'number');
    assert.equal(typeof produced.outroMs, 'number');
  });
});

// ---------------------------------------------------------------------------
// check-levels.mjs — ignored ffmpeg's exit status and printed NaN as if measured.
// ---------------------------------------------------------------------------
describe('check-levels exit contract', () => {
  test('checkLevels_ffmpegFailsToRun_exitsNonZeroInsteadOfReportingNaN', (t) => {
    const dir = makeProject(t, {
      'ffmpeg-path.txt': MISSING_FFMPEG,
      'clip.mp4': 'not really an mp4',
    });
    const r = runScript('check-levels.mjs', ['--file', 'clip=clip.mp4'], dir);

    assertCleanExit(r, EXIT.FAILED, 'ffmpeg never ran, so this must not report success: ');
    assert.doesNotMatch(r.stdout, /NaN/, 'must not print NaN measurements as if they were real');
  });
});

// ---------------------------------------------------------------------------
// remux-music.mjs — unconditional -y overwrite, unvalidated gains interpolated
// straight into an ffmpeg filter graph, and a video-hash mismatch that only warned.
// ---------------------------------------------------------------------------
describe('remux-music safety', () => {
  const project = (t) =>
    makeProject(t, {
      'ffmpeg-path.txt': MISSING_FFMPEG,
      'in.mp4': 'video bytes',
      'voiceover.mp3': 'voice bytes',
      'music.wav': 'music bytes',
    });

  test('remuxMusic_noFlags_doesNotWriteOutputAndExitsZero', (t) => {
    const dir = project(t);
    const r = runScript(
      'remux-music.mjs',
      ['--video', 'in.mp4', '--voice', 'voiceover.mp3', '--music', 'music.wav', '--out', 'out.mp4'],
      dir,
    );

    assert.equal(r.code, EXIT.OK, `planning is a success, got ${r.code}\n${r.all}`);
    assert.equal(fs.existsSync(path.join(dir, 'out.mp4')), false, 'a default run must not produce output');
    assert.match(r.all, /--apply/, 'the plan must name the flag that would perform the remux');
  });

  test('remuxMusic_gainCarryingFilterGraphInjection_refusedBeforeFfmpegIsInvoked', (t) => {
    const dir = project(t);
    const r = runScript(
      'remux-music.mjs',
      [
        '--video', 'in.mp4', '--voice', 'voiceover.mp3', '--music', 'music.wav', '--out', 'out.mp4',
        '--voice-gain', '1.0,volume=40',
        '--apply',
      ],
      dir,
    );

    assert.equal(r.code, EXIT.USAGE, `a malformed gain must be refused, got ${r.code}\n${r.all}`);
    assert.equal(fs.existsSync(path.join(dir, 'out.mp4')), false);
  });

  test('remuxMusic_gainOutsideAllowedRange_exitsUsageError', (t) => {
    const dir = project(t);
    const r = runScript(
      'remux-music.mjs',
      [
        '--video', 'in.mp4', '--voice', 'voiceover.mp3', '--music', 'music.wav', '--out', 'out.mp4',
        '--music-gain', '9999',
        '--apply',
      ],
      dir,
    );

    assert.equal(r.code, EXIT.USAGE, r.all);
  });

  test('remuxMusic_applyOverExistingOutputWithoutReplace_refusesAndPreservesIt', (t) => {
    const dir = project(t);
    fs.writeFileSync(path.join(dir, 'out.mp4'), 'APPROVED DELIVERABLE');
    const r = runScript(
      'remux-music.mjs',
      ['--video', 'in.mp4', '--voice', 'voiceover.mp3', '--music', 'music.wav', '--out', 'out.mp4', '--apply'],
      dir,
    );

    assert.equal(r.code, EXIT.USAGE, `expected a refusal, got ${r.code}\n${r.all}`);
    assert.equal(fs.readFileSync(path.join(dir, 'out.mp4'), 'utf8'), 'APPROVED DELIVERABLE');
  });

  // A GAIN IS ONLY MEANINGFUL FOR THE TRACK IT WAS MEASURED AGAINST (bug-ledger 16).
  //
  // Bounding the gain VALUE cannot catch this: 1.50 is in range for both a bed generated
  // to length at -43.1 dB RMS and a licensed master at -11.4 dB, and those two are 31.7 dB
  // apart. The unchanged gain shipped a bed ~10 dB hot with every other check green,
  // because the narration-gap checks measure PRESENCE, not LEVEL. So the pin is on the
  // source, and it is asserted at the point the source changes.
  const lockPath = (dir) => path.join(dir, 'music-gain.lock.json');
  const pinTo = (dir, sha256, musicGain = 1.5) =>
    fs.writeFileSync(lockPath(dir), JSON.stringify({ source: 'music.wav', sha256, musicGain }));

  test('remuxMusic_musicSourceChangedButGainDidNot_refusesAndNamesBothTracks', (t) => {
    const dir = project(t);
    pinTo(dir, 'a'.repeat(64));

    const r = runScript(
      'remux-music.mjs',
      ['--video', 'in.mp4', '--voice', 'voiceover.mp3', '--music', 'music.wav', '--out', 'out.mp4', '--apply'],
      dir,
    );

    assert.equal(r.code, EXIT.USAGE, `expected a refusal, got ${r.code}\n${r.all}`);
    assert.match(r.all, /music source CHANGED/, 'the refusal must say what changed');
    assert.match(r.all, /--confirm-gain/, 'and name the flag that re-pins it');
    assert.equal(fs.existsSync(path.join(dir, 'out.mp4')), false, 'a refused remux writes nothing');
  });

  test('remuxMusic_changedSourceWithConfirmGain_passesTheGainCheck', (t) => {
    const dir = project(t);
    pinTo(dir, 'a'.repeat(64));

    const r = runScript(
      'remux-music.mjs',
      ['--video', 'in.mp4', '--voice', 'voiceover.mp3', '--music', 'music.wav', '--out', 'out.mp4',
        '--apply', '--confirm-gain'],
      dir,
    );

    assert.doesNotMatch(r.all, /music source CHANGED/, '--confirm-gain must clear the pin check');
  });

  test('remuxMusic_unchangedSource_doesNotRefuseAndPlanSaysSoWithoutColourAlone', (t) => {
    const dir = project(t);
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'music.wav'))).digest('hex');
    pinTo(dir, sha);

    const r = runScript(
      'remux-music.mjs',
      ['--video', 'in.mp4', '--voice', 'voiceover.mp3', '--music', 'music.wav', '--out', 'out.mp4'],
      dir,
    );

    assert.equal(r.code, EXIT.OK, `an unchanged source must plan cleanly, got ${r.code}\n${r.all}`);
    assert.match(r.all, /source unchanged/, 'the plan must state the pin status in words');
  });

  // Planning must stay answerable about inputs that are stubbed, absent or not yet
  // rendered. Probing durations unconditionally made a no-flag run exit non-zero on an
  // undecodable stub, which breaks the plan-by-default contract every stage now honours.
  test('remuxMusic_undecodableMediaWithoutApply_stillPlansAndSaysTheLoopIsUndecided', (t) => {
    const dir = project(t);
    const r = runScript(
      'remux-music.mjs',
      ['--video', 'in.mp4', '--voice', 'voiceover.mp3', '--music', 'music.wav', '--out', 'out.mp4'],
      dir,
    );

    assert.equal(r.code, EXIT.OK, `planning must not require decodable media, got ${r.code}\n${r.all}`);
    assert.match(r.all, /loop\s+UNDECIDED/, 'and must say the loop decision was not made, not imply none is needed');
  });
});

// ---------------------------------------------------------------------------
// encode-mp4.mjs — a lock-skip that exited 0 told the pipeline an encode happened.
// ---------------------------------------------------------------------------
describe('encode-mp4 exit contract', () => {
  test('encodeMp4_lockHeldByLiveOwner_exitsSkippedNotZero', (t) => {
    const dir = makeProject(t, {
      'timing.json': timingFixture(contiguousSegments),
      'demo.mp4.lock': String(process.pid),
      'frames/frame_00000.png': 'frame',
    });
    // --apply: a plan never takes the lock, because planning is read-only.
    const r = runScript('encode-mp4.mjs', ['--apply'], dir);

    assert.equal(r.code, EXIT.SKIPPED, `a skipped encode must not report success, got ${r.code}\n${r.all}`);
  });
});

// ---------------------------------------------------------------------------
// cli-support.mjs — the shared validation primitives.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// cli-support.mjs — numeric validation. Path confinement is covered in
// path-boundary.test.mjs, against real directories and real links.
// ---------------------------------------------------------------------------
describe('cli-support primitives', () => {
  test('parseBoundedNumber_plainDecimal_returnsNumber', () => {
    assert.equal(parseBoundedNumber('1.14', { name: 'voice gain', min: 0, max: 8 }), 1.14);
  });

  test('parseBoundedNumber_valueWithFilterGraphSuffix_throws', () => {
    for (const hostile of ['1.0,volume=40', '1.0[a]', '1;x', '1e3', '0x10', 'Infinity', '']) {
      assert.throws(
        () => parseBoundedNumber(hostile, { name: 'voice gain', min: 0, max: 8 }),
        CliError,
        `"${hostile}" must be refused`,
      );
    }
  });

  test('parseBoundedNumber_valueOutOfRange_throws', () => {
    assert.throws(() => parseBoundedNumber('9999', { name: 'music gain', min: 0, max: 8 }), CliError);
    assert.throws(() => parseBoundedNumber('-1', { name: 'music gain', min: 0, max: 8 }), CliError);
  });

  test('requirePositiveNumber_zeroNegativeOrNaN_throws', () => {
    for (const bad of [0, -5, 'thirty', NaN, Infinity, null, undefined]) {
      assert.throws(() => requirePositiveNumber(bad, { name: 'fps' }), CliError, `${bad} must be refused`);
    }
  });

  test('requirePositiveNumber_validValue_returnsNumber', () => {
    assert.equal(requirePositiveNumber('30', { name: 'fps' }), 30);
  });

  test('requirePositiveNumber_nonIntegerWhenIntegerRequired_throws', () => {
    assert.throws(() => requirePositiveNumber(12.5, { name: 'totalFrames', integer: true }), CliError);
  });
});
