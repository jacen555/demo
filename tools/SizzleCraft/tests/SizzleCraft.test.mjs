import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  FIXED,
  DECLARED,
  canonicalNumber,
  canonicalText,
  canonicalBytes,
} from '../src/canonical-json.mjs';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

// canonical-json is the hashing backbone for remix.mjs and voice.mjs — a change in its
// output silently invalidates every cached timing hash, so its contract is pinned here.

test('canonicalText_fixedMode_sortsKeysByCodePoint', () => {
  assert.equal(canonicalText({ b: 1, a: 2, C: 3 }, FIXED), '{"C":3,"a":2,"b":1}');
});

test('canonicalText_declaredMode_preservesInsertionOrder', () => {
  assert.equal(canonicalText({ b: 1, a: 2 }, DECLARED), '{"b":1,"a":2}');
});

test('canonicalText_fixedMode_isOrderIndependent', () => {
  assert.equal(canonicalText({ x: 1, y: 2 }, FIXED), canonicalText({ y: 2, x: 1 }, FIXED));
});

test('canonicalText_nestedStructures_serializeRecursively', () => {
  assert.equal(
    canonicalText({ b: [3, { d: 1, c: 2 }], a: null }, FIXED),
    '{"a":null,"b":[3,{"c":2,"d":1}]}',
  );
});

test('canonicalText_declaredModeWithArrayIndexKey_throws', () => {
  assert.throws(() => canonicalText({ 0: 'a' }, DECLARED), /array-index property names/);
});

test('canonicalText_unknownMode_throws', () => {
  assert.throws(() => canonicalText({}, 'not-a-mode'), /unknown serializer/);
});

test('canonicalText_loneSurrogate_throws', () => {
  assert.throws(() => canonicalText({ k: '\ud800' }, FIXED), /lone Unicode surrogate/);
});

test('canonicalText_nonPlainObject_throws', () => {
  assert.throws(() => canonicalText({ d: new Date() }, FIXED), /only JSON objects/);
});

test('canonicalNumber_negativeZero_normalizesToZero', () => {
  assert.equal(canonicalNumber(-0), '0');
});

test('canonicalNumber_nonFinite_throws', () => {
  for (const value of [Infinity, -Infinity, NaN]) {
    assert.throws(() => canonicalNumber(value), /finite IEEE-754/);
  }
});

test('canonicalBytes_returnsUtf8BufferMatchingText', () => {
  const value = { k: 'café' };
  assert.deepEqual(canonicalBytes(value, FIXED), Buffer.from(canonicalText(value, FIXED), 'utf8'));
});

// Guard against a broken or truncated copy of any engine script. These are CLI scripts
// that execute on import, so they cannot be imported here — parse them instead.
test('engineScripts_allParseAsEsm', () => {
  const scripts = readdirSync(srcDir).filter(f => f.endsWith('.mjs'));
  assert.ok(scripts.length >= 9, `expected the full engine, found ${scripts.length} scripts`);

  for (const script of scripts) {
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ['--check', join(srcDir, script)], { stdio: 'pipe' }),
      `${script} failed to parse`,
    );
  }
});

// The first extraction shipped only the middle of the pipeline: script/storyboard generation
// (S1/S2) and the music + remux path (S8/S9) were left behind, so the documented cheap
// audio-only path had no implementation in the repo. This pins every stage so that a partial
// extraction fails loudly instead of silently.
test('engineScripts_coverEveryPipelineStage', () => {
  const required = {
    'S2 storyboard': 'write-storyboard.mjs',
    'S3 synthesis': 'voice.mjs',
    'S4 timing solve': 'remix.mjs',
    'S4 silence': 'silence-gen.mjs',
    'S4 measurement': 'silence-scan.mjs',
    'S5 scene build': 'write-build-html.mjs',
    'S6 capture': 'frame-capture.mjs',
    'S7 encode': 'encode-mp4.mjs',
    'S8 music': 'make-music.mjs',
    'S8/S9 remux': 'remux-music.mjs',
  };

  const present = new Set(readdirSync(srcDir));
  const missing = Object.entries(required)
    .filter(([, file]) => !present.has(file))
    .map(([stage, file]) => `${stage} (${file})`);

  assert.deepEqual(missing, [], `pipeline stages missing from the engine: ${missing.join(', ')}`);
});
