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
import { classifyGainPin, describeGainPinRefusal, describeGainPinPlan } from '../src/gain-pin.mjs';
import { MIX_PARAMETERS, NOT_IN_FORCE } from '../src/mix-parameters.mjs';
import { assertCleanExit, pcmWav } from './_helpers.mjs';

/**
 * What a pin records for the CONDITIONAL pinned parameters when they are not in force.
 *
 * The sidechain duck is opt-in, and the loop crossfade reaches the mix only when the bed
 * is shorter than the video, so on a run without them those knobs have no value — but a
 * pinned parameter must still be accounted for, or the pin records a partial set.
 * `mix-parameters.declareAbsent` writes NOT_IN_FORCE for exactly this, and these fixtures
 * have to record what the tool records or they stop describing it.
 *
 * DERIVED FROM THE REGISTRY, not written out: when the next conditional knob is added,
 * these fixtures must not quietly go on asserting a settled pin over a set that no longer
 * covers everything. That is the defect the pin exists to stop, and a hand-written
 * fixture is exactly how it would be reintroduced inside its own tests.
 */
const NOT_IN_FORCE_MIX = Object.freeze(
  Object.fromEntries(
    MIX_PARAMETERS.filter((p) => p.pinned && (p.name.startsWith('duck') || p.name === 'crossfade')).map((p) => [
      p.name,
      NOT_IN_FORCE,
    ]),
  ),
);

/**
 * Music remux-music can DECODE, and a timeline it can size the loop from: 10 s of bed
 * against a 5 s video, so nothing loops. An --apply run probes the bed before the gain
 * pin, because whether the bed loops decides whether the crossfade is in the mix the pin
 * covers — so a refusal from the pin is only reachable past a successful probe.
 */
const PROBEABLE_MEDIA = Object.freeze({
  'music.wav': pcmWav(10),
  'timing.json': JSON.stringify({ project: { fps: 30 }, durationMs: 4000 }),
});

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

/** Matches `text` however a help or refusal text happens to wrap it. */
const phrase = (text) =>
  new RegExp(
    text
      .split(/\s+/)
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s+'),
    'i',
  );

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
    assert.match(r.all, /no-go match/, 'and report that a no-go pattern matched');
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
    // Words recorded as voice.mjs records them: remix refuses a narrated segment whose
    // record holds none, because its clip cannot be narration voice produced for it.
    const segments = [
      { id: 'one', startMs: 0, endMs: 2000, voiceoverText: 'hello there', audio: { file: 'segment_000.mp3', durationMs: 2000, words: [{ word: 'hello', startMs: 100, endMs: 600 }, { word: 'there', startMs: 600, endMs: 1100 }] } },
      { id: 'two', startMs: 2000, endMs: 4000, voiceoverText: 'second segment here', audio: { file: 'segment_001.mp3', durationMs: 2000, words: [{ word: 'second', startMs: 2100, endMs: 2600 }, { word: 'segment', startMs: 2600, endMs: 3100 }, { word: 'here', startMs: 3100, endMs: 3600 }] } },
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
  const project = (t, files = {}) =>
    makeProject(t, {
      'ffmpeg-path.txt': MISSING_FFMPEG,
      'in.mp4': 'video bytes',
      'voiceover.mp3': 'voice bytes',
      'music.wav': 'music bytes',
      ...files,
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
  // Writes the registry-aware shape: a pin records the whole declared set of mix
  // parameters, not the music gain alone. A lock without a `mix` record predates the
  // registry and is refused outright — exercised on its own below, never used here as a
  // stand-in for a settled pin.
  const pinTo = (dir, sha256, musicGain = 1.5) =>
    fs.writeFileSync(
      lockPath(dir),
      JSON.stringify({
        source: 'music.wav',
        sha256,
        mix: { voiceGain: 1.14, musicGain, ceiling: 1, ...NOT_IN_FORCE_MIX },
        evidence: 'operator-confirmed',
      }),
    );

  test('remuxMusic_musicSourceChangedButGainDidNot_refusesAndNamesBothTracks', (t) => {
    const dir = project(t, PROBEABLE_MEDIA);
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

  // It used to assert only that the refusal text was absent — which a run that crashed
  // before reaching the pin satisfied just as well. It now asserts the run got PAST the
  // pin: the apply line prints, then the missing ffmpeg fails it.
  test('remuxMusic_changedSourceWithConfirmGain_passesTheGainCheck', (t) => {
    const dir = project(t, PROBEABLE_MEDIA);
    pinTo(dir, 'a'.repeat(64));

    const r = runScript(
      'remux-music.mjs',
      ['--video', 'in.mp4', '--voice', 'voiceover.mp3', '--music', 'music.wav', '--out', 'out.mp4',
        '--apply', '--confirm-gain'],
      dir,
    );

    assert.doesNotMatch(r.all, /music source CHANGED/, '--confirm-gain must clear the pin check');
    assertCleanExit(r, EXIT.FAILED, 'past the pin, the missing ffmpeg is what stops the run: ');
    assert.match(r.all, /^voice 1\.14 · music 1\.5/m, 'and the run must actually have reached the mix');
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
    // Was /source unchanged/. The pin now covers the GAIN as well as the source, so the
    // plan states both — asserting only the source would no longer be the whole status.
    assert.match(r.all, /confirmed for/, 'the plan must state the pin status in words');
    assert.match(r.all, /gain 1\.5/, 'and must name the gain that confirmation covers, not just the track');
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

// ---------------------------------------------------------------------------
// gain-pin.mjs — the pure classifier behind the pin, tested directly.
//
// It answers one question: has anyone confirmed THIS gain for THIS source? Every way of
// answering "no" must require a confirmation, because each of them is a way for a gain
// nobody agreed to to reach the mix.
// ---------------------------------------------------------------------------
describe('gain pin classifier', () => {
  // `mix` is the registered set of delivered-mix parameters (mix-parameters.mjs), not a
  // literal written here. A lock that records no `mix` at all predates the registry and
  // is refused — that state has its own tests rather than being smuggled in as a fixture.
  const current = {
    source: 'music.wav',
    sha256: 'b'.repeat(64),
    mix: { voiceGain: 1.14, musicGain: 1.5, ceiling: 1, ...NOT_IN_FORCE_MIX },
  };
  // Named `confirmed`, so it must actually BE confirmed. Without `evidence` this is the
  // self-pinned shape, and a fixture that quietly supplies the defective form is
  // how a test comes to assert the hole rather than the fix.
  const confirmed = {
    source: 'music.wav',
    sha256: 'b'.repeat(64),
    mix: { voiceGain: 1.14, musicGain: 1.5, ceiling: 1, ...NOT_IN_FORCE_MIX },
    evidence: 'operator-confirmed',
  };

  test('classifyGainPin_noLock_requiresConfirmationBecauseNothingHasBeenConfirmed', () => {
    const v = classifyGainPin(null, current);
    assert.equal(v.first, true);
    assert.equal(v.requiresConfirmation, true, 'a first run has no confirmation behind its gain');
  });

  test('classifyGainPin_sameSourceAndGain_requiresNothing', () => {
    const v = classifyGainPin(confirmed, current);
    assert.equal(v.requiresConfirmation, false);
    assert.equal(v.sourceChanged, false);
    assert.deepEqual(v.changedParameters, []);
  });

  test('classifyGainPin_sourceChanged_requiresConfirmation', () => {
    const v = classifyGainPin({ ...confirmed, sha256: 'a'.repeat(64) }, current);
    assert.equal(v.sourceChanged, true);
    assert.equal(v.requiresConfirmation, true);
  });

  test('classifyGainPin_gainChanged_requiresConfirmation', () => {
    const v = classifyGainPin({ ...confirmed, mix: { ...confirmed.mix, musicGain: 0.4 } }, current);
    assert.deepEqual(v.changedParameters.map((c) => c.name), ['musicGain']);
    assert.equal(v.requiresConfirmation, true);
  });

  // A lock that cannot be read as a pin is not a pin. Treating an absent or unparseable
  // field as "matches" would let a truncated or hand-edited file wave a gain through,
  // which is the permissive-default failure this whole check exists to avoid.
  test('classifyGainPin_lockMissingItsFields_requiresConfirmationRatherThanAssumingAMatch', () => {
    const locks = [
      {},
      { sha256: 'b'.repeat(64) },
      { mix: { voiceGain: 1.14, musicGain: 1.5, ceiling: 1 } },
      { sha256: 'b'.repeat(64), mix: { voiceGain: 1.14, musicGain: 'x', ceiling: 1 } },
      { sha256: 'b'.repeat(64), mix: { voiceGain: 1.14, musicGain: 1.5 } },
      { sha256: 'not-a-digest', mix: { voiceGain: 1.14, musicGain: 1.5, ceiling: 1 } },
    ];
    for (const lock of locks) {
      const v = classifyGainPin(lock, current);
      assert.equal(v.requiresConfirmation, true, `a lock of ${JSON.stringify(lock)} must not satisfy the pin`);
    }
  });

  // A LOCK IN THE REGISTRY SHAPE CAN STILL RECORD NO CONFIRMATION. It matches on every
  // value, and carries no marker saying anybody agreed to them. Reading that as confirmed
  // means the tool agreeing with itself, and a successful run would then rewrite it
  // stamped `operator-confirmed` — laundering a record into provenance it never had.
  //
  // NOTE THE SHAPE: this fixture carries a `mix` record, so it is NOT a pre-registry
  // pin, and the test is not named as though it were. The genuinely old shape
  // (`{source, sha256, musicGain}`) is a different state with its own tests below; a
  // fixture that claims one case while exercising another pins neither.
  test('classifyGainPin_registryShapedLockWithNoEvidence_requiresConfirmationRatherThanTrustingIt', () => {
    const noEvidence = {
      source: 'music.wav',
      sha256: 'b'.repeat(64),
      mix: { voiceGain: 1.14, musicGain: 1.5, ceiling: 1, ...NOT_IN_FORCE_MIX },
    };

    const v = classifyGainPin(noEvidence, current);

    assert.equal(v.sourceChanged, false, 'the values do match — that is precisely the trap');
    assert.deepEqual(v.changedParameters, []);
    assert.equal(v.preRegistryPin, false, 'it records a mix set, so nothing here says it predates the registry');
    assert.equal(v.unconfirmedPin, true, 'but it records no operator confirmation');
    assert.equal(v.requiresConfirmation, true, 'so it must be re-confirmed, not trusted');
  });

  test('classifyGainPin_evidenceIsNotTheOperatorKind_requiresConfirmation', () => {
    for (const evidence of ['self-pinned', 'measured', '', null, true]) {
      const v = classifyGainPin({ ...confirmed, evidence }, current);
      assert.equal(v.requiresConfirmation, true, `evidence ${JSON.stringify(evidence)} must not be trusted`);
    }
  });

  test('classifyGainPin_operatorConfirmedAndMatching_requiresNothing', () => {
    const v = classifyGainPin({ ...confirmed, evidence: 'operator-confirmed' }, current);
    assert.equal(v.requiresConfirmation, false);
  });

  // A PIN THAT IS BOTH STALE AND UNCONFIRMED IS STILL A PIN NOBODY CONFIRMED. Both cases
  // below are already refused — what is under test is the NARRATIVE. Describing the old
  // value as "confirmed against" asserts an agreement that never happened, in the one
  // feature built to stop a tool certifying what nobody confirmed. A reader who follows
  // that text reasons from a history that does not exist.
  //
  // Asserted on the line that DESCRIBES THE PIN, not on the whole message: the standing
  // explanation ("a gain is only meaningful for the track it was confirmed against") is a
  // true general statement and must not be mistaken for a claim about this lock.
  //
  // The fixture is in the REGISTRY shape without an `evidence` marker — an unconfirmed
  // pin, not a pre-registry one. The two are named apart because they are different
  // states with different refusals.
  const unconfirmed = {
    source: 'music.wav',
    sha256: 'a'.repeat(64),
    mix: { voiceGain: 1.14, musicGain: 1.5, ceiling: 1, ...NOT_IN_FORCE_MIX },
  };
  const pinLineOf = (text, sha) => text.split('\n').find((l) => l.includes(sha.slice(0, 12)));

  test('classifyGainPin_unconfirmedPinWithChangedSource_doesNotClaimTheOldPinWasConfirmed', () => {
    const v = classifyGainPin(unconfirmed, current);
    assert.equal(v.sourceChanged, true, 'it is stale');
    assert.equal(v.pinRecordsConfirmation, false, 'and it was never confirmed');

    const line = pinLineOf(describeGainPinRefusal(v, current), unconfirmed.sha256);
    assert.match(line, /NEVER CONFIRMED/, 'the pin line must name the absent confirmation');
    assert.doesNotMatch(line, /^\s*confirmed/, 'and must not present it as an agreement that happened');
  });

  test('classifyGainPin_unconfirmedPinWithChangedGain_doesNotClaimTheOldPinWasConfirmed', () => {
    const askingFor3 = { ...current, mix: { ...current.mix, musicGain: 3 } };
    const v = classifyGainPin({ ...unconfirmed, sha256: current.sha256 }, askingFor3);
    assert.deepEqual(v.changedParameters.map((c) => c.name), ['musicGain'], 'it is stale on the gain');
    assert.equal(v.pinRecordsConfirmation, false, 'and it was never confirmed');

    const line = pinLineOf(describeGainPinRefusal(v, askingFor3), current.sha256);
    assert.match(line, /NEVER CONFIRMED/, 'the pin line must name the absent confirmation');
    assert.doesNotMatch(line, /^\s*confirmed/, 'and must not present the old gain as one somebody agreed to');
  });

  test('classifyGainPin_confirmedPinThatIsStale_stillDescribesTheOldPinAsConfirmed', () => {
    const stale = { ...confirmed, sha256: 'a'.repeat(64) };
    const v = classifyGainPin(stale, current);
    assert.equal(v.pinRecordsConfirmation, true);

    const line = pinLineOf(describeGainPinRefusal(v, current), stale.sha256);
    assert.match(line, /^\s*confirmed against/, 'a genuinely confirmed pin must still be described as one');
    assert.doesNotMatch(line, /NEVER CONFIRMED/, 'and must not be slandered as unconfirmed');
  });
});

// ---------------------------------------------------------------------------
// remux-music.mjs — the gain pin (bug-ledger 16), re-audited.
//
// The pin exists so a gain calibrated against one track cannot be applied to another.
// It asked only whether the SOURCE had changed, which left three routes to an
// unconfirmed gain: a FIRST run pinned whatever was supplied with nobody confirming it,
// a changed --music-gain on an unchanged source was never questioned, and --confirm-gain
// was read as a blanket answer rather than an answer to a specific question.
//
// WHAT THE PIN RECORDS IS A CONFIRMATION, NOT A MEASUREMENT — see gain-pin.mjs. No
// measured bed level is reachable at pin time, so the honest contract is "a human was
// asked, and said yes to THIS gain for THIS source". These are the three occasions on
// which it must ask.
// ---------------------------------------------------------------------------
describe('remux-music gain pin', () => {
  // Decodable, so an --apply run gets as far as the pin (see PROBEABLE_MEDIA).
  const MUSIC_BYTES = PROBEABLE_MEDIA['music.wav'];
  const MUSIC_SHA = crypto.createHash('sha256').update(MUSIC_BYTES).digest('hex');

  const project = (t, files = {}) =>
    makeProject(t, {
      'ffmpeg-path.txt': MISSING_FFMPEG,
      'in.mp4': 'video bytes',
      'voiceover.mp3': 'voice bytes',
      ...PROBEABLE_MEDIA,
      ...files,
    });

  const lockFile = (dir) => path.join(dir, 'music-gain.lock.json');
  // Defaults to a CONFIRMED pin. A lock without `evidence` is the legacy self-pinned
  // shape and is deliberately exercised on its own below, not used as a stand-in for a
  // settled one — seeding the defective shape and asserting it passes is how the hole
  // stayed open through a round of review. `mix` carries the whole registered set: a
  // lock that omits it predates the registry and is refused, which has its own tests.
  const pin = (dir, { sha256 = MUSIC_SHA, voiceGain = 1.14, musicGain = 1.5, ceiling = 1,
    evidence = 'operator-confirmed' } = {}) =>
    fs.writeFileSync(
      lockFile(dir),
      JSON.stringify(evidence === null ? { source: 'music.wav', sha256, mix: { voiceGain, musicGain, ceiling, ...NOT_IN_FORCE_MIX } }
        : { source: 'music.wav', sha256, mix: { voiceGain, musicGain, ceiling, ...NOT_IN_FORCE_MIX }, evidence }),
    );

  const remux = (dir, extra = []) =>
    runScript(
      'remux-music.mjs',
      ['--video', 'in.mp4', '--voice', 'voiceover.mp3', '--music', 'music.wav', '--out', 'out.mp4', ...extra],
      dir,
    );

  // HOLE 1: with no lock there was nothing to compare against, so the check passed and
  // the run pinned its own default — manufacturing a calibration record for a gain that
  // no one had ever confirmed, let alone measured.
  test('remuxMusic_firstApplyWithoutConfirmGain_refusesRatherThanPinningAnUnconfirmedGain', (t) => {
    const dir = project(t);

    const r = remux(dir, ['--apply']);

    assert.equal(r.code, EXIT.USAGE, `expected a refusal on first use, got ${r.code}\n${r.all}`);
    assert.match(r.all, /never been confirmed/i, 'the refusal must say the gain has no confirmation behind it');
    assert.match(r.all, /--confirm-gain/, 'and name the flag that supplies one');
    assert.equal(fs.existsSync(lockFile(dir)), false, 'a refused run must not write a pin');
    assert.equal(fs.existsSync(path.join(dir, 'out.mp4')), false, 'and must not produce output');
  });

  // HOLE 2: the source is the same file, so the old check was satisfied — but the gain
  // being applied to it is not the gain anybody agreed to. -43.1 dB vs -11.4 dB was the
  // source moving; this is the multiplier moving, and it lands in the same place.
  test('remuxMusic_gainChangedOnUnchangedSource_refusesWithoutConfirmGain', (t) => {
    const dir = project(t);
    pin(dir, { musicGain: 1.5 });

    const r = remux(dir, ['--music-gain', '3.0', '--apply']);

    assert.equal(r.code, EXIT.USAGE, `expected a refusal when the gain moved, got ${r.code}\n${r.all}`);
    assert.match(r.all, /gain/i, 'the refusal must be about the gain');
    assert.match(r.all, /1\.5/, 'and must name the gain that was confirmed');
    assert.match(r.all, /3/, 'and the gain now being asked for');
    assert.equal(fs.existsSync(path.join(dir, 'out.mp4')), false);
  });

  // HOLE 3, restated: the source moving must still be caught. This is the case the pin
  // was originally built for and it must not regress while the other two are closed.
  test('remuxMusic_sourceChangedWithoutConfirmGain_refusesAndNamesBothTracks', (t) => {
    const dir = project(t);
    pin(dir, { sha256: 'a'.repeat(64) });

    const r = remux(dir, ['--apply']);

    assert.equal(r.code, EXIT.USAGE, `expected a refusal when the source moved, got ${r.code}\n${r.all}`);
    assert.match(r.all, /source/i, 'the refusal must say the source changed');
    assert.match(r.all, /--confirm-gain/, 'and name the flag that re-pins it');
    assert.equal(fs.existsSync(path.join(dir, 'out.mp4')), false);
  });

  test('remuxMusic_unchangedSourceAndGain_doesNotAskAgain', (t) => {
    const dir = project(t);
    pin(dir, { musicGain: 1.5 });

    const r = remux(dir);

    assert.equal(r.code, EXIT.OK, `a confirmed pin must plan cleanly, got ${r.code}\n${r.all}`);
    assert.doesNotMatch(r.all, /--confirm-gain/, 'a settled pin must not nag for a confirmation it already has');
  });

  // Planning writes nothing, so it must stay answerable — but it must also not imply the
  // gain is settled when --apply is going to refuse. Saying so is the whole value.
  test('remuxMusic_planWithUnconfirmedGain_stillPlansAndSaysConfirmationIsRequired', (t) => {
    const dir = project(t);

    const r = remux(dir);

    assert.equal(r.code, EXIT.OK, `planning must not require a confirmed gain, got ${r.code}\n${r.all}`);
    assert.match(r.all, /--confirm-gain/, 'the plan must say --apply will require a confirmation');
    assert.equal(fs.existsSync(lockFile(dir)), false, 'and planning must still write no pin');
  });

  // THE LAUNDERING CASE. A lock in the registry shape matches on every value the pin
  // compares and carries no confirmation marker. Trusting it would let a successful run
  // rewrite it stamped `operator-confirmed` with a fresh timestamp — turning a record
  // nobody made into provenance, and making the laundered copy look stronger than the
  // thing it came from. What WROTE the file is not knowable from it, and the refusal
  // does not guess; the missing marker is the whole fact.
  test('remuxMusic_pinWithNoEvidenceMarker_refusesAndDoesNotLaunderItIntoAConfirmation', (t) => {
    const dir = project(t);
    pin(dir, { evidence: null });
    const before = fs.readFileSync(lockFile(dir), 'utf8');

    const r = remux(dir, ['--apply']);

    assert.equal(r.code, EXIT.USAGE, `a pin recording no confirmation must be refused, got ${r.code}\n${r.all}`);
    assert.match(r.all, /RECORDS NO CONFIRMATION/, 'the refusal must say the pin carries no confirmation');
    assert.match(r.all, /--confirm-gain/, 'and name the flag that supplies one');
    assert.equal(fs.readFileSync(lockFile(dir), 'utf8'), before, 'and must not rewrite the pin it refused');
    assert.doesNotMatch(fs.readFileSync(lockFile(dir), 'utf8'), /operator-confirmed/, 'least of all stamping it');
  });

  // The refusal names check-levels.mjs, which measures a RENDERED FILE. On first use no
  // such file exists — the refusal is what stopped it being made — so an instruction to
  // measure BEFORE confirming cannot be followed. The order has to be stated correctly.
  test('remuxMusic_firstUseRefusal_givesAnOrderThatCanActuallyBeFollowed', (t) => {
    const dir = project(t);

    const r = remux(dir, ['--apply']);

    assert.match(r.all, /re-run with --confirm-gain/, 'step 1 must be the confirmation');
    assert.match(r.all, /check-levels\.mjs --file/, 'step 2 must be measuring the file it produces');
    assert.match(
      r.all,
      /nothing to measure yet/i,
      'and it must say why the measurement cannot come first, rather than asking for the impossible order',
    );
    // THE CONTRADICTION ITSELF, PINNED. Both claims shipped together, in three places:
    // "there is nothing to measure yet" and "--confirm-gain is the caller's assertion that a
    // person MEASURED or listened to the mix". On first use — the run where the flag is
    // mandatory — no mix exists, so nothing can have been measured. A consistent lie is worse
    // than an obvious contradiction because it stops looking wrong, so the PAIRING is guarded
    // here rather than either sentence alone.
    assert.doesNotMatch(
      r.all,
      /assertion that a person measured or listened/i,
      'it cannot say nothing is measurable yet and in the same breath that a measurement happened',
    );
  });
});

// ---------------------------------------------------------------------------
// THE PIN COVERS A DECLARED SET, NOT A HAND-WRITTEN LITERAL.
//
// `--ceiling` was added after the pin was written. It sets the limiter, so it moves the
// delivered loudness of the shipped mix — and the pin recorded `{source, sha256,
// musicGain}`, a literal written before that knob existed. So a ceiling change needed no
// renewed confirmation: the pin reported itself valid while the mix moved underneath it.
//
// The enumeration was not the mistake. The mistake was that the set was CLOSED BY
// CONSTRUCTION and nothing failed when it grew. These tests pin the two halves of the
// fix: registered parameters are compared INDIVIDUALLY, and each staleness reason names
// its own cause rather than being collapsed into "something changed".
// ---------------------------------------------------------------------------
describe('gain pin mix parameter coverage', () => {
  const SHA = 'b'.repeat(64);

  /** What is about to be mixed — the registry's pinned values, not a hand-written literal. */
  const applying = (mix = {}) => ({
    source: 'music.wav',
    sha256: SHA,
    mix: { voiceGain: 1.14, musicGain: 1.5, ceiling: 1, ...NOT_IN_FORCE_MIX, ...mix },
  });

  /** A pin that genuinely covers every registered parameter and records a confirmation. */
  const settled = (over = {}) => ({
    source: 'music.wav',
    sha256: SHA,
    mix: { voiceGain: 1.14, musicGain: 1.5, ceiling: 1, ...NOT_IN_FORCE_MIX },
    evidence: 'operator-confirmed',
    ...over,
  });

  test('classifyGainPin_settledPinCoveringEveryRegisteredParameter_requiresNothing', () => {
    const v = classifyGainPin(settled(), applying());

    assert.equal(v.requiresConfirmation, false, 'a pin that covers the whole declared set is settled');
    assert.deepEqual(v.changedParameters, [], 'and nothing in that set moved');
  });

  // THE DEFECT. The source is byte-identical and --music-gain never moved, so every
  // comparison the old pin made agreed — while the limiter, and therefore the delivered
  // loudness, changed.
  test('classifyGainPin_ceilingChangedOnAnUnchangedSourceAndGain_requiresConfirmation', () => {
    const v = classifyGainPin(settled(), applying({ ceiling: 2 }));

    assert.equal(v.sourceChanged, false, 'the source did not move — that is precisely the trap');
    assert.deepEqual(
      v.changedParameters.map((c) => c.name),
      ['ceiling'],
      'the ceiling is a registered member of the pinned set, so its movement must be seen',
    );
    assert.equal(v.requiresConfirmation, true, 'and must demand a renewed confirmation');
  });

  // REASONS MUST NOT COLLAPSE. Reporting a ceiling change as "the source changed" is the
  // same class of error as a stale legacy pin describing itself as confirmed: a reader
  // who follows the text reasons from a cause that did not occur.
  test('describeGainPinRefusal_ceilingChanged_namesTheCeilingAndDoesNotBlameTheSource', () => {
    const v = classifyGainPin(settled(), applying({ ceiling: 2 }));

    const text = describeGainPinRefusal(v, applying({ ceiling: 2 }));

    assert.match(text, /--ceiling CHANGED/, 'the refusal must name the knob that actually moved');
    assert.doesNotMatch(text, /source CHANGED/, 'and must not blame the source, which did not move');
    assert.match(text, /\bconfirmed\s+1\b/, 'it must state the ceiling that was confirmed');
    assert.match(text, /now asked\s+2\b/, 'and the one now being asked for');
  });

  // The `now` fixture used to omit the not-in-force sentinels, so it described a mix
  // remux-music never builds — and the classifier, seeing every duck knob go from 0 to
  // nothing, listed each one as CHANGED. The test could not assert their absence, so a
  // classifier inventing causes passed it. The fixture now records what the tool records.
  test('describeGainPinRefusal_sourceAndCeilingBothChanged_namesEachCauseSeparately', () => {
    const now = {
      source: 'other.wav',
      sha256: 'c'.repeat(64),
      mix: { voiceGain: 1.14, musicGain: 1.5, ceiling: 2, ...NOT_IN_FORCE_MIX },
    };
    const v = classifyGainPin(settled(), now);

    const text = describeGainPinRefusal(v, now);

    assert.match(text, /music source CHANGED/, 'the source cause must be named');
    assert.match(text, /--ceiling CHANGED/, 'and the ceiling cause must be named on its own');
    assert.doesNotMatch(text, /--music-gain CHANGED/, 'a gain that did not move must not be listed');
    assert.deepEqual(
      v.changedParameters.map((c) => c.name),
      ['ceiling'],
      'and nothing that stayed not-in-force may be listed as a cause',
    );
    assert.doesNotMatch(text, /--duck-\w+ CHANGED|--crossfade CHANGED/, 'in the text either');
  });

  test('classifyGainPin_musicGainChangedWhileTheCeilingHeld_namesOnlyTheGain', () => {
    const v = classifyGainPin(settled(), applying({ musicGain: 3 }));

    assert.deepEqual(v.changedParameters.map((c) => c.name), ['musicGain']);
    assert.doesNotMatch(describeGainPinRefusal(v, applying({ musicGain: 3 })), /--ceiling CHANGED/);
  });

  // THE VOICE GAIN IS PART OF THE DELIVERED LEVEL, AND WAS DECLARED NOT TO BE.
  //
  // It was registered `pinned: false` on the reasoning that the pin asks whether the BED
  // level was agreed to, so the narration bus is a separate question. That reasoning does
  // not survive contact with the graph it describes: the voice sets the other half of the
  // balance the bed is judged against, and it is the signal fed into the limiter — the
  // very knob this change made pinnable. Moving it alone moved the delivered mix while a
  // settled pin went on reporting valid, which is the identical defect --ceiling had.
  //
  // The incident behind this whole feature was a voice 1.40 / music 0.85 rebalance that
  // shipped a bed 24 dB above target. That is a voice-only change against an unmoved
  // source, and it is precisely the case below.
  test('classifyGainPin_voiceGainChangedWhileTheSourceAndBedHeld_requiresConfirmation', () => {
    const v = classifyGainPin(settled(), applying({ voiceGain: 1.4 }));

    assert.equal(v.sourceChanged, false, 'the source did not move — that is precisely the trap');
    assert.deepEqual(
      v.changedParameters.map((c) => c.name),
      ['voiceGain'],
      'the voice gain is a registered member of the pinned set, so its movement must be seen',
    );
    assert.equal(v.requiresConfirmation, true, 'and must demand a renewed confirmation');
  });

  test('describeGainPinRefusal_voiceGainChanged_namesTheVoiceGainAndBlamesNothingElse', () => {
    const now = applying({ voiceGain: 1.4 });

    const text = describeGainPinRefusal(classifyGainPin(settled(), now), now);

    assert.match(text, /--voice-gain CHANGED/, 'the refusal must name the knob that actually moved');
    assert.match(text, /\bconfirmed\s+1\.14\b/, 'it must state the voice gain that was confirmed');
    assert.match(text, /now asked\s+1\.4\b/, 'and the one now being asked for');
    assert.doesNotMatch(text, /source CHANGED/, 'and must not blame the source, which did not move');
    assert.doesNotMatch(text, /--music-gain CHANGED/, 'nor the bed multiplier, which did not move');
  });

  // EXISTING LOCKS ARE REFUSED, NOT UPGRADED. A pin written before the registry cannot
  // say which ceiling it covered, so trusting it would certify a delivered loudness
  // nobody agreed to — the same laundering the `evidence` marker was added to stop.
  // Silently back-filling today's default would be worse: it would mint agreement.
  test('classifyGainPin_pinPredatingTheMixRegistry_requiresConfirmationAndIsNotCalledUnreadable', () => {
    const preRegistry = { source: 'music.wav', sha256: SHA, musicGain: 1.5, evidence: 'operator-confirmed' };

    const v = classifyGainPin(preRegistry, applying());

    assert.equal(v.preRegistryPin, true, 'it must be diagnosed as predating the registry');
    assert.equal(v.requiresConfirmation, true, 'and refused rather than trusted');
    assert.equal(v.unreadablePin, false, 'it is not malformed — it is complete for the set that then existed');
    assert.equal(v.sourceChanged, false, 'and nothing about the source changed');
    assert.deepEqual(v.changedParameters, [], 'so no parameter may be reported as having moved');
  });

  test('describeGainPinRefusal_pinPredatingTheMixRegistry_saysSoRatherThanNamingAFalseCause', () => {
    const preRegistry = { source: 'music.wav', sha256: SHA, musicGain: 1.5, evidence: 'operator-confirmed' };

    const text = describeGainPinRefusal(classifyGainPin(preRegistry, applying()), applying());

    assert.match(text, /predates/i, 'the refusal must say the pin predates the registered set');
    assert.doesNotMatch(text, /CHANGED/, 'and must not invent a change to explain itself');
    assert.match(text, /--confirm-gain/, 'and must name the flag that supplies one fresh confirmation');
  });

  // A hand-edited or partially-written mix record is a THIRD, distinct state: the pin
  // knows about the registry but does not carry every member of it.
  test('classifyGainPin_mixRecordMissingARegisteredParameter_namesTheParameterItDoesNotCover', () => {
    const partial = {
      source: 'music.wav',
      sha256: SHA,
      mix: { voiceGain: 1.14, musicGain: 1.5, ...NOT_IN_FORCE_MIX },
      evidence: 'operator-confirmed',
    };

    const v = classifyGainPin(partial, applying());

    assert.deepEqual(v.unrecordedParameters.map((p) => p.name), ['ceiling']);
    assert.equal(v.preRegistryPin, false, 'it does carry a mix record — it is just incomplete');
    assert.equal(v.requiresConfirmation, true);
    assert.match(describeGainPinRefusal(v, applying()), /--ceiling/, 'and the refusal must name it');
  });

  test('classifyGainPin_mixRecordThatIsNotAnObject_isUnreadableRatherThanPreRegistry', () => {
    for (const mix of ['x', 42, [], null]) {
      const v = classifyGainPin({ source: 'music.wav', sha256: SHA, mix, evidence: 'operator-confirmed' }, applying());
      assert.equal(v.unreadablePin, true, `a mix record of ${JSON.stringify(mix)} cannot be read as one`);
      assert.equal(v.requiresConfirmation, true);
    }
  });

  // ---------------------------------------------------------------------------
  // A REFUSAL MAY SAY WHAT IS MISSING. IT MAY NOT SAY WHO WROTE THE FILE.
  //
  // This module has already made the stronger-claim mistake once, when collapsing
  // staleness and provenance let a stale pin describe itself as confirmed against a
  // source nobody agreed to. The same error came back one level down: a lock carrying
  // nothing but a valid digest was diagnosed "pre-registry" — a claim about WHEN it was
  // written — on evidence that only shows it has no mix record. The old shape also
  // carried `source` and `musicGain`, and this file has neither.
  //
  // Both refusals are correct. Only one of the diagnoses is supported.
  // ---------------------------------------------------------------------------
  test('classifyGainPin_lockCarryingOnlyADigest_isNotDiagnosedAsPreRegistry', () => {
    const v = classifyGainPin({ sha256: SHA }, applying());

    assert.equal(v.requiresConfirmation, true, 'it must still be refused — nothing here is a confirmation');
    assert.equal(
      v.preRegistryPin,
      false,
      'but it is not evidence of a pre-registry pin: the old shape carried source and musicGain, ' +
        'and this carries neither',
    );
    assert.equal(v.noMixRecord, true, 'it is simply a pin with no record of the mix it covered');
  });

  test('describeGainPinRefusal_lockCarryingOnlyADigest_saysWhatIsMissingWithoutDatingTheFile', () => {
    const text = describeGainPinRefusal(classifyGainPin({ sha256: SHA }, applying()), applying());

    assert.doesNotMatch(text, /predates/i, 'it must not claim an age it cannot establish');
    assert.match(text, /records no mix parameters/i, 'it must say what is actually missing');
    assert.doesNotMatch(text, /CHANGED/, 'and must not invent a change to explain itself');
    assert.match(text, /--confirm-gain/, 'and must name the flag that supplies a confirmation');
  });

  test('classifyGainPin_lockInTheOldRecordedShape_isDiagnosedAsPreRegistry', () => {
    // `{source, sha256, musicGain}` is the shape the pin actually used to write. Only
    // this supports the claim that a lock predates the registry.
    const v = classifyGainPin({ source: 'music.wav', sha256: SHA, musicGain: 1.5 }, applying());

    assert.equal(v.preRegistryPin, true, 'the complete old shape is what "pre-registry" is a claim about');
    assert.equal(v.noMixRecord, false, 'and it is the more specific of the two diagnoses');
    assert.equal(v.requiresConfirmation, true);
  });

  test('describeGainPinRefusal_pinRecordingNoConfirmation_doesNotAssertWhoWroteIt', () => {
    const noEvidence = { source: 'music.wav', sha256: SHA, mix: { voiceGain: 1.14, musicGain: 1.5, ceiling: 1, ...NOT_IN_FORCE_MIX } };

    const text = describeGainPinRefusal(classifyGainPin(noEvidence, applying()), applying());

    assert.match(text, /RECORDS NO CONFIRMATION/, 'the absent confirmation is the fact, and must be stated');
    assert.doesNotMatch(text, /written by/i, 'but who wrote the file is not established by its contents');
    assert.doesNotMatch(text, /self-pinning|pinned its own default/i, 'so no origin may be attributed to it');
  });

  test('describeGainPinRefusal_stalePinRecordingNoConfirmation_doesNotAssertWhoWroteIt', () => {
    const noEvidence = {
      source: 'music.wav',
      sha256: 'a'.repeat(64),
      mix: { voiceGain: 1.14, musicGain: 1.5, ceiling: 1, ...NOT_IN_FORCE_MIX },
    };

    const text = describeGainPinRefusal(classifyGainPin(noEvidence, applying()), applying());

    assert.match(text, /NEVER CONFIRMED/, 'the pin line must still name the absent confirmation');
    assert.doesNotMatch(text, /written by/i, 'without attributing the file to an author it cannot identify');
    assert.doesNotMatch(text, /self-pinning|old self-pinning code/i, 'least of all a specific version of this tool');
  });

  test('describeGainPinPlan_pinRecordingNoConfirmation_doesNotAssertWhoWroteIt', () => {
    const noEvidence = { source: 'music.wav', sha256: SHA, mix: { voiceGain: 1.14, musicGain: 1.5, ceiling: 1, ...NOT_IN_FORCE_MIX } };

    const line = describeGainPinPlan(classifyGainPin(noEvidence, applying()), applying(), false);

    assert.match(line, /records no confirmation/i, 'the plan must say the pin carries no confirmation');
    assert.doesNotMatch(line, /written by|self-pinning/i, 'and must not name an author it cannot establish');
  });

  // ---------------------------------------------------------------------------
  // TWO INDEPENDENT DIFFERENCES, BOTH NAMED.
  //
  // A pin can predate the registry AND be pinned to a different track. The pre-registry
  // refusal returned early and mentioned only the first, so an operator re-confirmed
  // against a source they had not been told had moved, and found out on the next run.
  // Naming the digest difference is not the same as calling the old values confirmed —
  // it reports that two readable facts differ, which is all that is known.
  // ---------------------------------------------------------------------------
  test('describeGainPinRefusal_preRegistryPinWhoseDigestAlsoDiffers_namesBothDifferences', () => {
    const preRegistry = { source: 'old.wav', sha256: 'a'.repeat(64), musicGain: 1.5 };

    const v = classifyGainPin(preRegistry, applying());
    const text = describeGainPinRefusal(v, applying());
    // The DIAGNOSIS, not the whole message: the standing explanation that follows it ("a
    // gain is only meaningful for the track it was confirmed against") is a true general
    // statement, and asserting against it would be testing the wrong sentence.
    const diagnosis = text.split('\n\n')[0];

    assert.equal(v.preRegistryPin, true);
    assert.equal(v.sourceChanged, true, 'the digest it does carry is not the one being supplied');
    assert.match(diagnosis, /predates/i, 'the first difference must be named');
    assert.match(diagnosis, new RegExp('a'.repeat(12)), 'and the second must name the digest that was pinned');
    assert.match(diagnosis, new RegExp(SHA.slice(0, 12)), 'and the digest now being supplied');
    assert.doesNotMatch(diagnosis, /confirmed against/, 'without describing the old values as agreed to');
  });

  test('describeGainPinPlan_preRegistryPinWhoseDigestAlsoDiffers_namesBothDifferences', () => {
    const preRegistry = { source: 'old.wav', sha256: 'a'.repeat(64), musicGain: 1.5 };

    const line = describeGainPinPlan(classifyGainPin(preRegistry, applying()), applying(), false);

    assert.match(line, /predates/i, 'the plan must say the pin predates the registered set');
    assert.match(line, /source changed/i, 'and must not omit that the track moved as well');
  });
});

// ---------------------------------------------------------------------------
// remux-music.mjs — the mix parameter registry, end to end.
// ---------------------------------------------------------------------------
describe('remux-music mix parameter pin', () => {
  // Decodable, so an --apply run gets as far as the pin (see PROBEABLE_MEDIA).
  const MUSIC_BYTES = PROBEABLE_MEDIA['music.wav'];
  const MUSIC_SHA = crypto.createHash('sha256').update(MUSIC_BYTES).digest('hex');

  // 4 s of bed against the same 5 s video: it loops, two copies and one wrap.
  const LOOPING_MUSIC = pcmWav(4);
  const LOOPING_SHA = crypto.createHash('sha256').update(LOOPING_MUSIC).digest('hex');

  const project = (t, files = {}) =>
    makeProject(t, {
      'ffmpeg-path.txt': MISSING_FFMPEG,
      'in.mp4': 'video bytes',
      'voiceover.mp3': 'voice bytes',
      ...PROBEABLE_MEDIA,
      ...files,
    });

  const lockFile = (dir) => path.join(dir, 'music-gain.lock.json');

  /** A settled pin in the registry-aware shape: it records every pinned parameter. */
  const pin = (dir, mix = {}, sha256 = MUSIC_SHA) =>
    fs.writeFileSync(
      lockFile(dir),
      JSON.stringify({
        source: 'music.wav',
        sha256,
        mix: { voiceGain: 1.14, musicGain: 1.5, ceiling: 1, ...NOT_IN_FORCE_MIX, ...mix },
        evidence: 'operator-confirmed',
      }),
    );

  const remux = (dir, extra = []) =>
    runScript(
      'remux-music.mjs',
      ['--video', 'in.mp4', '--voice', 'voiceover.mp3', '--music', 'music.wav', '--out', 'out.mp4', ...extra],
      dir,
    );

  test('remuxMusic_ceilingChangedAgainstASettledPin_refusesAndNamesTheCeiling', (t) => {
    const dir = project(t);
    pin(dir);

    const r = remux(dir, ['--ceiling', '2.0', '--apply']);

    assert.equal(r.code, EXIT.USAGE, `a moved ceiling must be refused, got ${r.code}\n${r.all}`);
    assert.match(r.all, /--ceiling CHANGED/, 'the refusal must name the ceiling');
    assert.doesNotMatch(r.all, /source CHANGED/, 'and must not blame the source, which did not move');
    assert.match(r.all, /--confirm-gain/, 'and must name the flag that re-confirms it');
    assert.equal(fs.existsSync(path.join(dir, 'out.mp4')), false, 'a refused remux writes nothing');
  });

  test('remuxMusic_settledPinCoveringTheCeiling_doesNotAskAgain', (t) => {
    const dir = project(t);
    pin(dir);

    const r = remux(dir);

    assert.equal(r.code, EXIT.OK, `a pin covering the whole set must plan cleanly, got ${r.code}\n${r.all}`);
    assert.doesNotMatch(r.all, /--confirm-gain/, 'a settled pin must not nag for a confirmation it already has');
  });

  // A VOICE-ONLY REBALANCE MUST STOP THE RUN. The source is byte-identical, --music-gain
  // and --ceiling never moved, so every comparison the pin made before this change agreed
  // — while the narration bus, and therefore both the voice-to-bed balance and the signal
  // entering the limiter, moved. 1.40 is the actual voice gain from the incident that
  // shipped a bed 24 dB above target.
  test('remuxMusic_voiceGainChangedAgainstASettledPin_refusesAndNamesTheVoiceGain', (t) => {
    const dir = project(t);
    pin(dir);

    const r = remux(dir, ['--voice-gain', '1.40', '--apply']);

    assert.equal(r.code, EXIT.USAGE, `a moved voice gain must be refused, got ${r.code}\n${r.all}`);
    assert.match(r.all, /--voice-gain CHANGED/, 'the refusal must name the voice gain');
    assert.doesNotMatch(r.all, /source CHANGED/, 'and must not blame the source, which did not move');
    assert.doesNotMatch(r.all, /--music-gain CHANGED/, 'nor the bed multiplier, which did not move');
    assert.match(r.all, /--confirm-gain/, 'and must name the flag that re-confirms it');
    assert.equal(fs.existsSync(path.join(dir, 'out.mp4')), false, 'a refused remux writes nothing');
  });

  // EVERY EXISTING LOCK NEEDS ONE RE-CONFIRMATION. That cost is accepted deliberately:
  // a pre-registry pin cannot state which ceiling it covered, and silently upgrading it
  // would record an agreement to a delivered loudness nobody was asked about.
  test('remuxMusic_pinPredatingTheMixRegistry_refusesAndDoesNotRestampIt', (t) => {
    const dir = project(t);
    fs.writeFileSync(
      lockFile(dir),
      JSON.stringify({
        source: 'music.wav',
        sha256: MUSIC_SHA,
        musicGain: 1.5,
        evidence: 'operator-confirmed',
        confirmedAt: '2025-01-01T00:00:00.000Z',
      }),
    );
    const before = fs.readFileSync(lockFile(dir), 'utf8');

    const r = remux(dir, ['--apply']);

    assert.equal(r.code, EXIT.USAGE, `a pre-registry pin must be refused, got ${r.code}\n${r.all}`);
    assert.match(r.all, /predates/i, 'the refusal must say the pin predates the registered set');
    assert.equal(fs.readFileSync(lockFile(dir), 'utf8'), before, 'and must not rewrite the pin it refused');
  });

  test('remuxMusic_planWithAMovedCeiling_saysApplyWillRefuseAndNamesTheCeiling', (t) => {
    const dir = project(t);
    pin(dir);

    const r = remux(dir, ['--ceiling', '2.0']);

    assert.equal(r.code, EXIT.OK, `planning must stay answerable, got ${r.code}\n${r.all}`);
    assert.match(r.all, /--ceiling changed/i, 'the plan must say which knob moved');
    assert.match(r.all, /REFUSE/, 'and that --apply will stop');
    assert.equal(fs.existsSync(path.join(dir, 'out.mp4')), false);
  });

  // The guidance number was a guess. It has since been measured on real encoded output,
  // post-AAC: --ceiling 2.0 delivered -1.1 dBTP. Nothing in this tool measures encoded
  // true peak, so the help must not imply the pipeline verifies the delivery target.
  test('remuxMusicHelp_ceilingGuidance_givesTheMeasuredValueWithoutClaimingTruePeakIsVerified', (t) => {
    const dir = project(t);

    const r = runScript('remux-music.mjs', ['--help'], dir);

    assert.equal(r.code, EXIT.OK, `--help must succeed, got ${r.code}\n${r.all}`);
    assert.match(r.all, /--ceiling 2\.0/, 'the measured starting point must be stated');
    assert.doesNotMatch(r.all, /about 2\.5/, 'the guessed rule of thumb must be gone');
    assert.match(r.all, /measured/i, 'and it must read as a measurement, not a rule of thumb');
    assert.match(
      r.all,
      /decod/i,
      'and it must say that verifying a dBTP target requires decoding the output, which this tool does not do',
    );
  });

  // A MODELLED NUMBER SITTING NEXT TO MEASURED ONES READS AS MEASURED — and a modelled
  // number called a bound reads as a guarantee. The help called the one-pole shortfall a
  // "PESSIMISTIC UPPER BOUND" and said sidechaincompress "recovers FASTER" than the model.
  // One render was measured, at three releases, with an 11 dB duck across a 1.82 s median
  // gap: smaller than modelled at 800 ms, LARGER at 1500 and 2500 ms. So the model bounds
  // nothing in either direction, and nothing at all was measured below 800 ms.
  test('remuxMusicHelp_gapsShortfall_isMarkedModelledAndClaimsOnlyWhatWasMeasured', (t) => {
    const dir = project(t);

    const r = runScript('remux-music.mjs', ['--help'], dir);

    assertCleanExit(r, EXIT.OK);
    assert.match(r.all, /MODELLED, NOT MEASURED/, 'the shortfall must be labelled as modelled');
    assert.match(r.all, phrase('NOT A BOUND in either direction'), 'and must not be offered as a bound');
    for (const [release, model, measured] of [
      ['800', '0.67', '0.05-0.12'],
      ['1500', '2.09', '2.0-3.5'],
      ['2500', '3.70', '6.1-8.7'],
    ]) {
      assert.match(
        r.all,
        new RegExp(`${release} ms\\s+${model.replace('.', '\\.')} dB\\s+${measured.replace(/\./g, '\\.')} dB`),
        `the measurement at ${release} ms must be stated beside the model`,
      );
    }
    assert.match(r.all, phrase('nothing was measured below 800 ms'), 'and must not be extended past its range');
    assert.match(
      r.all,
      phrase('NOT the coefficient to tune by this number'),
      'and it must say release is not the knob to tune by a modelled figure',
    );
    assert.doesNotMatch(r.all, /UPPER BOUND|PESSIMISTIC|recovers FASTER/i, 'the falsified claims must be gone');
    assert.doesNotMatch(r.all, /0\.66 dB/, 'and so must the figure that disagreed with the plan');
  });

  // --CROSSFADE MOVES THE DELIVERED LEVEL WHEN THE BED LOOPS (P-h2). Tri curves on
  // uncorrelated material dip up to -3.01 dB at each overlap's midpoint, about -1.76 dB
  // averaged over it — at 30 s, for a large share of the running time. It was unpinned,
  // so a changed crossfade reached the mix with a settled pin reporting valid.
  test('remuxMusic_crossfadeChangedOnALoopingBedAgainstASettledPin_refusesAndNamesTheCrossfade', (t) => {
    const dir = project(t, { 'music.wav': LOOPING_MUSIC });
    pin(dir, { crossfade: 3 }, LOOPING_SHA);

    const r = remux(dir, ['--crossfade', '2', '--apply']);

    assertCleanExit(r, EXIT.USAGE, 'a moved crossfade on a looping bed must be refused: ');
    assert.match(r.all, /--crossfade CHANGED/, 'the refusal must name the crossfade');
    assert.match(r.all, /\bconfirmed\s+3\b/, 'and the crossfade that was confirmed');
    assert.match(r.all, /now asked\s+2\b/, 'and the one now being asked for');
    assert.equal(fs.existsSync(path.join(dir, 'out.mp4')), false, 'a refused remux writes nothing');

    const settled = remux(dir);
    assertCleanExit(settled, EXIT.OK);
    assert.match(settled.all, /2 copies, 3s crossfade/, 'setup: the bed must actually loop');
    assert.match(settled.all, /confirmed for music\.wav .*--crossfade 3\b/, 'and the pin must cover the crossfade in force');
  });

  // No wrap, no crossfade in the mix: the pin records it NOT IN FORCE, as the duck is on a
  // run without --duck-db, so a --crossfade that reaches nothing asks for nothing.
  test('remuxMusic_bedThatDoesNotLoop_recordsTheCrossfadeAsNotInForceWhateverTheFlagSays', (t) => {
    const dir = project(t);
    pin(dir);

    const r = remux(dir, ['--crossfade', '2']);

    assertCleanExit(r, EXIT.OK);
    assert.match(r.all, /loop\s+not needed/, 'setup: the bed must not loop');
    assert.match(r.all, /confirmed for music\.wav .*--crossfade 0\b/, 'the pin must record the crossfade as not in force');
    assert.doesNotMatch(r.all, /--confirm-gain/, 'and a crossfade that reaches no wrap must not ask for a confirmation');
  });

  // THE CONSUMER COST, STATED AS A TEST. Every pin written before --crossfade was pinned
  // records every other member and not this one, and a pin that does not record a member
  // cannot certify it. One re-confirmation per project, whether or not the bed loops.
  test('remuxMusic_pinWrittenBeforeTheCrossfadeWasPinned_refusesAndSaysItDoesNotRecordIt', (t) => {
    const dir = project(t);
    const { crossfade: _unrecorded, ...recordedBefore } = { voiceGain: 1.14, musicGain: 1.5, ceiling: 1, ...NOT_IN_FORCE_MIX };
    fs.writeFileSync(
      lockFile(dir),
      JSON.stringify({ source: 'music.wav', sha256: MUSIC_SHA, mix: recordedBefore, evidence: 'operator-confirmed' }),
    );

    const r = remux(dir, ['--apply']);

    assertCleanExit(r, EXIT.USAGE, 'a pin that does not record the crossfade cannot certify it: ');
    assert.match(r.all, /DOES NOT RECORD --crossfade/, 'and the refusal must say which member it lacks');
  });

  // --CONFIRM-GAIN IS AN ASSERTION ABOUT A PERSON (P-m1). The tool cannot tell who passed
  // it, and it stamps `operator-confirmed` either way — so the text an agent reads at the
  // refusal, and in --help, has to say whose assertion it is.
  test('remuxMusic_gainPinRefusal_saysConfirmGainIsAPersonsAssertionThatNoAgentMayMake', (t) => {
    const dir = project(t);

    const r = remux(dir, ['--apply']);

    assertCleanExit(r, EXIT.USAGE);
    assert.match(r.all, phrase("the caller's assertion that a person has accepted these values"));
    assert.match(r.all, phrase('An agent must not pass it on its own authority'));
    assert.match(r.all, /re-run with --confirm-gain/, 'and the steps themselves are unchanged');
  });

  test('remuxMusicHelp_confirmGain_saysItIsAPersonsAssertionThatNoAgentMayMake', (t) => {
    const dir = project(t);

    const r = runScript('remux-music.mjs', ['--help'], dir);

    assertCleanExit(r, EXIT.OK);
    assert.match(r.all, phrase("the caller's assertion that a person has accepted these values"));
    assert.match(r.all, phrase('An agent must not pass it on its own authority'));
  });

  // A GAIN TOO SMALL TO WRITE AS A PLAIN DECIMAL (P-m2). String(1e-7) is "1e-7", which the
  // registry refuses as unauditable — rightly, but at exit 1, reporting the operator's
  // value as the tool failing. It is a value outside what the tool accepts: exit 2.
  for (const [flag, name] of [['--music-gain', 'musicGain'], ['--voice-gain', 'voiceGain']]) {
    test(`remuxMusic_${name}BelowTheSmallestRenderableValue_exitsUsageNamingTheRange`, (t) => {
      const dir = project(t);

      const r = remux(dir, [flag, '0.0000001']);

      assertCleanExit(r, EXIT.USAGE, 'a value outside the accepted range is bad usage: ');
      assert.ok(r.all.includes(flag), `the refusal must name ${flag}\n${r.all}`);
      assert.match(r.all, /0\.000001/, 'and the smallest nonzero value it accepts');
    });
  }

  test('remuxMusic_gainAtTheEdgesOfTheRenderableRange_isStillAccepted', (t) => {
    const dir = project(t);

    for (const value of ['0', '0.000001', '8']) {
      assertCleanExit(remux(dir, ['--music-gain', value]), EXIT.OK, `--music-gain ${value}: `);
    }
  });
});

// ---------------------------------------------------------------------------
// remux-music.mjs --video-seconds — documented, read, and absent from the parser, so
// the override could not be reached from the command line at all.
// ---------------------------------------------------------------------------
describe('remux-music video-seconds override', () => {
  const project = (t, files = {}) =>
    makeProject(t, {
      'ffmpeg-path.txt': MISSING_FFMPEG,
      'in.mp4': 'video bytes',
      'voiceover.mp3': 'voice bytes',
      'music.wav': 'music bytes',
      ...files,
    });

  const remux = (dir, extra = []) =>
    runScript(
      'remux-music.mjs',
      ['--video', 'in.mp4', '--voice', 'voiceover.mp3', '--music', 'music.wav', '--out', 'out.mp4', ...extra],
      dir,
    );

  test('remuxMusic_videoSecondsFlag_isAcceptedByTheParser', (t) => {
    const dir = project(t);

    const r = remux(dir, ['--video-seconds', '30']);

    assert.doesNotMatch(r.all, /Unknown option/, 'the documented override must be reachable from the CLI');
    assert.equal(r.code, EXIT.OK, `a valid override must plan, got ${r.code}\n${r.all}`);
  });

  // The case the override exists for: timing.json cannot be used, and the caller knows
  // the length anyway. Without the override this same project is refused.
  test('remuxMusic_videoSecondsOverrideWithUnreadableTiming_plansWithoutReadingTiming', (t) => {
    const dir = project(t, { 'timing.json': '{ this is not json' });

    const refused = remux(dir);
    assert.equal(refused.code, EXIT.USAGE, `malformed timing must be refused, got ${refused.code}\n${refused.all}`);

    const r = remux(dir, ['--video-seconds', '30']);
    assert.equal(r.code, EXIT.OK, `the override must bypass unreadable timing, got ${r.code}\n${r.all}`);
  });

  test('remuxMusic_videoSecondsOutsideAllowedRange_exitsUsageError', (t) => {
    const dir = project(t);

    const r = remux(dir, ['--video-seconds', '0']);

    assert.equal(r.code, EXIT.USAGE, `an out-of-range override must be refused, got ${r.code}\n${r.all}`);
    assert.match(r.all, /--video-seconds/, 'and must name the option it rejected');
  });
});

