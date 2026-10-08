// The precedence rule for every `SIZZLECRAFT_*` knob, and the test that enforces it.
//
// Before this file there was no rule, only precedent. Three knobs read env first and
// two read config first, so the two that silently ignored the environment were
// indistinguishable from the three that honoured it. A consumer's half-fps draft
// rendered at 30 and nothing said why.
//
// The defect was never the inversion — it was the INCONSISTENCY. Three-out-of-five is
// exactly the ratio that makes copying a neighbour feel safe, so the next knob added was
// a coin flip. Inverting the two outliers would have fixed today's bug and left tomorrow's
// intact.
//
// So the rule is stated once, in cli-support.mjs, and enforced by
// `envKnobs_everySizzlecraftEnvRead_goesThroughTheSharedResolver` below: a new knob that
// hand-rolls `process.env.SIZZLECRAFT_*` fails this suite. A rule that is written but not
// enforceable decays back to precedent-by-proximity.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EXIT, resolveKnob, resolveBooleanKnob, CliError } from '../src/cli-support.mjs';
import { srcDir, makeProject, runScript, timingFixture, contiguousSegments, assertCleanExit, removeFixture } from './_helpers.mjs';

const captureProject = (t, project) =>
  makeProject(t, {
    'timing.json': timingFixture(contiguousSegments, { project: { name: 'demo', width: 1280, height: 720, ...project } }),
    'video-auto.html': '<html><body><div id="stage"></div></body></html>',
  });

// ---------------------------------------------------------------------------
// The enforcement. This is the test that makes the rule survive the next author.
// ---------------------------------------------------------------------------

/**
 * Every direct read of the environment in one file body, in ANY access form.
 *
 * Deliberately textual and deliberately unstripped. It matches inside comments and string
 * literals too, so naming the accessor in prose within `src/` fails this test and must be
 * reworded. That is the intended trade: a lexer that skipped comments could be fooled by a
 * quote inside a regex literal into swallowing a real read, and a guard that can be fooled
 * into silence is the exact defect this suite exists to prevent. A false positive costs a
 * reworded sentence; a false negative costs another silent knob.
 *
 * Scanned over the WHOLE body rather than line by line, and the exemption is recorded as a
 * character SPAN rather than a line. Both of those are corrections:
 *
 *   - a per-line scan could not see an access split across lines (`process` then `.env`);
 *   - a line-shaped exemption let an unrelated read ride along on the same line simply by
 *     quoting the allowed text in a trailing comment. That is file-shaped scoping wearing
 *     a narrower label, and both evasions are pinned below.
 *
 * An earlier version also walked only the top level of src/ and matched only dotted
 * access, so `process.env['SIZZLECRAFT_FPS']` sailed through. Those are pinned too.
 *
 * Access to the environment OBJECT may itself be computed — `process['env']['X']` contains
 * no dotted substring at all — so any indexing into `process` is flagged, not just the
 * dotted form. There is no legitimate computed access to `process` anywhere in this
 * source, which is what makes that safe to treat as categorical.
 *
 * KNOWN LIMIT, stated rather than papered over: aliasing the global first
 * (`const p = process; p.env.X`) defeats any purely textual rule. The guard's job is to
 * stop a knob being added by copying a neighbour, which is how every one of these arrived;
 * it is not a sandbox against a determined author.
 */
function directEnvReads(relPath, body) {
  // The ONLY exemption: the resolver's own default parameter, identified by the exact
  // offset of its accessor. Nothing else on that line inherits the exemption.
  const allowedStarts = new Set();
  if (relPath === 'cli-support.mjs') {
    const allowed = /\benv\s*=\s*(process\s*\.\s*env)\b/g;
    let a;
    while ((a = allowed.exec(body)) !== null) allowedStarts.add(a.index + a[0].indexOf(a[1]));
  }

  const lines = body.split('\n');
  const offenders = [];
  // `process.env` in any spacing, OR any indexing into `process` at all.
  const access = /process\s*(?:\.\s*env\b|\[)/g;
  let m;
  while ((m = access.exec(body)) !== null) {
    if (allowedStarts.has(m.index)) continue;
    const lineNo = body.slice(0, m.index).split('\n').length;
    offenders.push(`${relPath}:${lineNo}  ${lines[lineNo - 1].trim()}`);
  }
  return offenders;
}

/** The accessor spans the exemption is allowed to cover, so a third one is visible. */
function resolverAccessors(body) {
  return body.match(/\benv\s*=\s*process\s*\.\s*env\b/g) ?? [];
}

/** Every `.mjs` under `dir`, recursively — a future subdirectory must not escape the rule. */
function* walkMjs(dir, base = dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkMjs(full, base);
    else if (entry.name.endsWith('.mjs')) yield { full, rel: path.relative(base, full).replace(/\\/g, '/') };
  }
}

function scanTree(root) {
  const offenders = [];
  for (const { full, rel } of walkMjs(root)) {
    offenders.push(...directEnvReads(rel, fs.readFileSync(full, 'utf8')));
  }
  return offenders;
}

describe('env knob precedence is enforceable', () => {
  test('envKnobs_everyDirectEnvironmentRead_goesThroughTheSharedResolver', () => {
    assert.deepEqual(
      scanTree(srcDir),
      [],
      'Every environment knob must resolve through resolveKnob/resolveBooleanKnob in ' +
        'cli-support.mjs, which applies argv > env > config > default uniformly. Reading the ' +
        'environment directly is how the FPS and MODE knobs came to ignore it while three of ' +
        'their neighbours honoured it — and how SIZZLE_MUSIC_PRESET kept a non-conforming ' +
        'prefix. Pass a `legacy: [...]` name to the resolver if an existing variable must keep working.',
    );
  });

  // --- the three gaps the first version of this scanner had ---------------
  test('envKnobScanner_bracketAccess_isDetected', () => {
    const found = directEnvReads('sneaky.mjs', "const fps = process.env['SIZZLECRAFT_FPS'] ?? 30;");
    assert.equal(found.length, 1, 'bracket access is a direct read and must not evade the rule');
  });

  // The test above brackets the KNOB, so it still contains a literal `process.env`.
  // Bracketing the environment OBJECT contains no such substring, and is the form that
  // actually escapes a dotted-only scan.
  test('envKnobScanner_computedAccessToTheEnvObject_isDetected', () => {
    for (const src of [
      "const x = process['env']['SIZZLECRAFT_SNEAKY'];",
      'const x = process["env"].SIZZLECRAFT_SNEAKY;',
      "const x = process [ 'env' ].SIZZLECRAFT_SNEAKY;",
      'const x = process[`env`].SIZZLECRAFT_SNEAKY;',
    ]) {
      assert.equal(directEnvReads('sneaky.mjs', src).length, 1, `must be detected: ${src}`);
      assert.doesNotMatch(src, /process\s*\.\s*env/, 'and this form contains no dotted substring to match');
    }
  });

  // The categorical `process[` rule must not fire on ordinary process usage, which this
  // source is full of — a guard that cries wolf gets deleted.
  test('envKnobScanner_ordinaryProcessUsage_isNotFlagged', () => {
    const benign = 'process.exit(EXIT.OK); process.argv.slice(2); process.execPath; process.cwd(); process.exitCode = 1;';
    assert.deepEqual(directEnvReads('ordinary.mjs', benign), []);
  });

  test('envKnobScanner_dottedAccess_isDetected', () => {
    assert.equal(directEnvReads('sneaky.mjs', 'const m = process.env.SIZZLE_MUSIC_PRESET;').length, 1);
  });

  test('envKnobScanner_aliasedEnvironmentObject_isDetected', () => {
    // Aliasing would defeat any name-based rule, so the object itself is what is guarded.
    assert.equal(directEnvReads('sneaky.mjs', 'const e = process.env; const fps = e.SIZZLECRAFT_FPS;').length, 1);
  });

  test('envKnobScanner_destructuredEnvironment_isDetected', () => {
    assert.equal(directEnvReads('sneaky.mjs', 'const { SIZZLECRAFT_FPS } = process.env;').length, 1);
  });

  test('envKnobScanner_mentionInAComment_isDetectedRatherThanSkipped', () => {
    // Documented trade-off: prose in src/ must not name the accessor. A false positive
    // costs a reworded sentence; skipping comments risks a false negative.
    assert.equal(directEnvReads('sneaky.mjs', '// we used to read process.env.SIZZLECRAFT_FPS here').length, 1);
  });

  test('envKnobScanner_resolverDefaultParameter_isTheOnlyExemption', () => {
    const line = 'export function resolveKnob(knob, { argv, config, fallback, legacy = [], env = process.env } = {}) {';
    assert.deepEqual(directEnvReads('cli-support.mjs', line), [], 'the resolver may read the environment');
    assert.equal(
      directEnvReads('cli-support.mjs', 'const fps = process.env.SIZZLECRAFT_FPS;').length,
      1,
      'but the exemption is scoped to that access, NOT to the whole file',
    );
  });

  // The exemption is a character span, not a line. Quoting the allowed text in a trailing
  // comment must not launder a real read sitting beside it.
  test('envKnobScanner_readSharingALineWithTheExemption_isStillDetected', () => {
    const found = directEnvReads('cli-support.mjs', 'const fps = process.env.SIZZLECRAFT_FPS; // env = process.env');
    assert.equal(found.length, 1, 'a line-shaped exemption would have laundered this read');
  });

  // A per-line scan cannot see an access split across lines.
  test('envKnobScanner_accessSplitAcrossLines_isStillDetected', () => {
    const found = directEnvReads('frame-capture.mjs', 'const fps = process\n  .env.SIZZLECRAFT_FPS ?? 30;');
    assert.equal(found.length, 1, 'whitespace between `process` and `.env` must not evade the rule');
    assert.match(found[0], /frame-capture\.mjs:1/, 'and it is reported where the access begins');
  });

  test('envKnobScanner_cliSupportHasExactlyTwoResolverAccessors', () => {
    // resolveKnob and resolveBooleanKnob. A third door to the environment should be a
    // deliberate decision, not something that appears because the exemption pattern allows it.
    const support = fs.readFileSync(path.join(srcDir, 'cli-support.mjs'), 'utf8');
    assert.equal(resolverAccessors(support).length, 2, 'exactly two intended accessors are exempt');
  });

  test('envKnobScanner_offenderInASubdirectory_isFound', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-scan-'));
    t.after(() => removeFixture(root));
    fs.mkdirSync(path.join(root, 'nested', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(root, 'nested', 'deeper', 'knob.mjs'), 'const x = process.env.SIZZLECRAFT_FPS;\n');

    const found = scanTree(root);
    assert.equal(found.length, 1, 'the scan must recurse — src/ being flat today is not a guarantee');
    assert.match(found[0], /nested\/deeper\/knob\.mjs:1/);
  });

  test('envKnobs_theRuleIsStatedWhereTheNextAuthorWillReadIt', () => {
    const support = fs.readFileSync(path.join(srcDir, 'cli-support.mjs'), 'utf8');
    assert.match(
      support,
      /argv[^\n]*env[^\n]*config[^\n]*default/i,
      'the precedence order must be written down next to the helper that implements it',
    );
  });
});

// ---------------------------------------------------------------------------
// The resolver itself.
// ---------------------------------------------------------------------------
describe('resolveKnob', () => {
  test('resolveKnob_envAndConfigBothPresent_environmentWins', () => {
    const got = resolveKnob('FPS', { config: 30, fallback: 60, env: { SIZZLECRAFT_FPS: '12' } });
    assert.equal(got.value, '12');
    assert.equal(got.source, 'environment');
  });

  test('resolveKnob_argvPresent_beatsEnvironment', () => {
    const got = resolveKnob('FPS', { argv: '8', config: 30, fallback: 60, env: { SIZZLECRAFT_FPS: '12' } });
    assert.equal(got.value, '8');
    assert.equal(got.source, 'argument');
  });

  test('resolveKnob_envAbsent_fallsThroughToConfig', () => {
    const got = resolveKnob('FPS', { config: 30, fallback: 60, env: {} });
    assert.equal(got.value, 30);
    assert.equal(got.source, 'config');
  });

  test('resolveKnob_nothingPresent_usesTheDefault', () => {
    const got = resolveKnob('FPS', { fallback: 60, env: {} });
    assert.equal(got.value, 60);
    assert.equal(got.source, 'default');
  });

  // `||` treated a configured 0 as absent; `??` does not. A zero fps is not "unset",
  // it is a value that must reach validation and be refused there.
  test('resolveKnob_configZero_isPresentRatherThanFallingBack', () => {
    const got = resolveKnob('FPS', { config: 0, fallback: 30, env: {} });
    assert.equal(got.value, 0, 'a configured 0 must survive to be validated, not be silently replaced');
    assert.equal(got.source, 'config');
  });

  test('resolveKnob_emptyEnvValue_countsAsUnset', () => {
    const got = resolveKnob('FPS', { config: 30, fallback: 60, env: { SIZZLECRAFT_FPS: '' } });
    assert.equal(got.value, 30, 'an empty environment variable is how a shell unsets one');
    assert.equal(got.source, 'config');
  });

  test('resolveKnob_unprefixedName_isRefused', () => {
    // Guards the helper's own contract: the prefix is applied by the resolver, so a
    // caller passing the full name would silently look up SIZZLECRAFT_SIZZLECRAFT_FPS.
    assert.throws(() => resolveKnob('SIZZLECRAFT_FPS', { fallback: 1, env: {} }), CliError);
  });

  test('resolveKnob_legacyVariableName_stillWorksButCanonicalWins', () => {
    // SIZZLE_MUSIC_PRESET predates the SIZZLECRAFT_ convention. Routing it through the
    // resolver must not break a caller who already exports it.
    const legacyOnly = resolveKnob('MUSIC_PRESET', { fallback: 'warm', legacy: ['SIZZLE_MUSIC_PRESET'], env: { SIZZLE_MUSIC_PRESET: 'bright' } });
    assert.equal(legacyOnly.value, 'bright');
    assert.equal(legacyOnly.variable, 'SIZZLE_MUSIC_PRESET', 'the run must name the variable it actually read');

    const both = resolveKnob('MUSIC_PRESET', {
      fallback: 'warm',
      legacy: ['SIZZLE_MUSIC_PRESET'],
      env: { SIZZLECRAFT_MUSIC_PRESET: 'canonical', SIZZLE_MUSIC_PRESET: 'bright' },
    });
    assert.equal(both.value, 'canonical', 'the canonical name is consulted first');
  });

  test('resolveBooleanKnob_envTruthyString_readsAsTrue', () => {
    for (const raw of ['1', 'true', 'TRUE', 'yes', 'on']) {
      assert.equal(resolveBooleanKnob('RESUME', { env: { SIZZLECRAFT_RESUME: raw } }).value, true, raw);
    }
  });

  test('resolveBooleanKnob_envFalsyString_readsAsFalse', () => {
    for (const raw of ['0', 'false', 'no', 'off']) {
      assert.equal(resolveBooleanKnob('RESUME', { env: { SIZZLECRAFT_RESUME: raw } }).value, false, raw);
    }
  });

  // `''` against RESUME cannot discriminate: its default is false, so old (empty -> false)
  // and new (empty -> unset -> default) agree. DEDUP_HOLDS defaults to TRUE
  // (frame-capture.mjs), so it is the knob where the behaviour change is observable —
  // and therefore the only one that actually pins it.
  test('resolveBooleanKnob_emptyEnvValue_countsAsUnsetNotFalse', () => {
    const got = resolveBooleanKnob('DEDUP_HOLDS', { fallback: true, env: { SIZZLECRAFT_DEDUP_HOLDS: '' } });
    assert.equal(got.value, true, 'an empty variable is how a shell clears one, so the true default must stand');
    assert.equal(got.source, 'default', 'and it must be reported as unset, not as an environment answer');
  });

  test('resolveBooleanKnob_envUnparseable_isRefusedRatherThanReadAsFalse', () => {
    // `/^(1|true|yes)$/.test('ture')` is false, which is indistinguishable from the user
    // never having set it — a typo silently disabling a flag the user asked for.
    assert.throws(() => resolveBooleanKnob('RESUME', { env: { SIZZLECRAFT_RESUME: 'ture' } }), CliError);
  });
});

// ---------------------------------------------------------------------------
// The two knobs that silently did nothing, asserted through the CLI they belong to.
// ---------------------------------------------------------------------------
describe('frame-capture knob precedence', () => {
  test('frameCapture_envFpsOverConfigFps_environmentWins', (t) => {
    const dir = captureProject(t, { fps: 30 });
    const r = runScript('frame-capture.mjs', [], dir, { env: { SIZZLECRAFT_FPS: '12' } });

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(r.all, /at 12 fps/, `the environment must override the configured fps\n${r.all}`);
  });

  test('frameCapture_envFrameFormatOverConfigFormat_environmentWins', (t) => {
    const dir = captureProject(t, { fps: 30, frameFormat: 'png' });
    const r = runScript('frame-capture.mjs', [], dir, { env: { SIZZLECRAFT_FRAME_FORMAT: 'jpeg' } });

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(r.all, /jpeg/, r.all);
  });

  test('frameCapture_configFpsZero_isRefusedRatherThanDefaulted', (t) => {
    const dir = captureProject(t, { fps: 0 });
    const r = runScript('frame-capture.mjs', [], dir);

    assertCleanExit(r, EXIT.USAGE, 'a configured fps of 0 must be refused, not replaced: ');
    // A "must refuse" test passes for free when the subject refuses for an unrelated
    // reason, so the refusal has to name the knob it was about.
    assert.match(r.all, /fps/i, 'the refusal must name the value it rejected');
    assert.match(r.all, /\b0\b/, 'and show the value it received, so 0 is visibly not "unset"');
  });
});

describe('encode-mp4 knob precedence', () => {
  const encodeProject = (t, project) =>
    makeProject(t, {
      'timing.json': timingFixture(contiguousSegments, { project: { name: 'demo', width: 1280, height: 720, ...project } }),
      'voiceover.mp3': 'voice-bytes',
    });

  test('encodeMp4_envFpsOverConfigFps_environmentWins', (t) => {
    const dir = encodeProject(t, { fps: 30 });
    const r = runScript('encode-mp4.mjs', [], dir, { env: { SIZZLECRAFT_FPS: '12' } });

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(r.all, /at 12 fps/, `the environment must override the configured fps\n${r.all}`);
  });

  test('encodeMp4_envModeOverConfigMode_environmentWins', (t) => {
    const dir = encodeProject(t, { fps: 30, mode: 'live' });
    const r = runScript('encode-mp4.mjs', [], dir, { env: { SIZZLECRAFT_MODE: 'draft' } });

    assert.equal(r.code, EXIT.OK, r.all);
    assert.match(r.all, /\(draft\)/, `the environment must override the configured mode\n${r.all}`);
  });

  // The two files read the same knob with different operators, so a configured 0 was a
  // hard refusal in one and a silent 30 in the other. Same knob, same answer.
  test('encodeMp4_configFpsZero_isRefusedRatherThanDefaulted', (t) => {
    const dir = encodeProject(t, { fps: 0 });
    const r = runScript('encode-mp4.mjs', [], dir);

    assertCleanExit(r, EXIT.USAGE, 'a configured fps of 0 must be refused, not replaced: ');
    assert.match(r.all, /fps/i, 'the refusal must name the value it rejected');
    assert.match(r.all, /\b0\b/, 'and show the value it received');
  });

  // Dimensions were the unguarded half of the same knob site: `||` turned a configured 0
  // into 3840 and a non-numeric height into NaN, and the PLAN then printed that value and
  // exited 0. A plan that reports `1280xNaN` and succeeds is a false success.
  test('encodeMp4_configWidthZero_isRefusedRatherThanDefaulted', (t) => {
    const dir = encodeProject(t, { fps: 30, width: 0 });
    const r = runScript('encode-mp4.mjs', [], dir);

    assertCleanExit(r, EXIT.USAGE, 'a configured width of 0 must be refused, not replaced: ');
    assert.match(r.all, /width/i, 'the refusal must name the value it rejected');
    assert.doesNotMatch(r.all, /3840/, 'and must not have silently substituted the default');
  });

  test('encodeMp4_configHeightNonNumeric_isRefusedRatherThanPlanningNaN', (t) => {
    const dir = encodeProject(t, { fps: 30, height: 'tall' });
    const r = runScript('encode-mp4.mjs', [], dir);

    assertCleanExit(r, EXIT.USAGE, 'a non-numeric height must be refused before planning: ');
    assert.match(r.all, /height/i, 'the refusal must name the value it rejected');
    assert.doesNotMatch(r.all, /NaN/, 'a plan must never report NaN as a dimension');
  });

  test('encodeMp4_envFpsUnparseable_isRefusedRatherThanDefaulted', (t) => {
    const dir = encodeProject(t, { fps: 30 });
    const r = runScript('encode-mp4.mjs', [], dir, { env: { SIZZLECRAFT_FPS: 'thirty' } });

    assertCleanExit(r, EXIT.USAGE, 'an unparseable fps must be refused, not silently replaced: ');
    assert.match(r.all, /fps/i, 'the refusal must name the value it rejected');
    assert.match(r.all, /thirty/, 'and echo what it was given, so the typo is findable');
  });
});
