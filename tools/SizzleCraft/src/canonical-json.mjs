import fs from 'node:fs';
import { parseCli, runCli } from './cli-support.mjs';
import { isEntryPoint } from './entry-point.mjs';

export const FIXED = 'fixed-key-order-json-utf8-v1';
export const DECLARED = 'declared-field-order-json-utf8-v1';

function fail(message) {
  throw new Error(`canonical JSON rejected: ${message}`);
}

function assertUnicode(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail('lone Unicode surrogate');
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail('lone Unicode surrogate');
    }
  }
}

function codePointCompare(left, right) {
  const a = Array.from(left, c => c.codePointAt(0));
  const b = Array.from(right, c => c.codePointAt(0));
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function isArrayIndexKey(key) {
  if (!/^(0|[1-9][0-9]*)$/.test(key)) return false;
  const value = Number(key);
  return Number.isInteger(value) && value >= 0 && value < 4294967295 && String(value) === key;
}

export function canonicalNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('numbers must be finite IEEE-754 binary64 values');
  }
  return Object.is(value, -0) ? '0' : JSON.stringify(value);
}

function serialize(value, mode) {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') return canonicalNumber(value);
  if (typeof value === 'string') {
    assertUnicode(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(item => serialize(item, mode)).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('only JSON objects, arrays, strings, booleans, null, and numbers are allowed');
  }

  let keys = Object.keys(value);
  for (const key of keys) assertUnicode(key);
  if (mode === FIXED) {
    keys = keys.sort(codePointCompare);
  } else if (mode === DECLARED) {
    if (keys.some(isArrayIndexKey)) fail('declared-order objects may not use array-index property names');
  } else {
    fail(`unknown serializer ${JSON.stringify(mode)}`);
  }
  return `{${keys.map(key => `${JSON.stringify(key)}:${serialize(value[key], mode)}`).join(',')}}`;
}

export function canonicalText(value, mode = FIXED) {
  return serialize(value, mode);
}

export function canonicalBytes(value, mode = FIXED) {
  return Buffer.from(canonicalText(value, mode), 'utf8');
}

const USAGE = `
canonical-json — serialise JSON deterministically. Reads stdin, writes stdout.

  node canonical-json.mjs < input.json                               fixed key order
  node canonical-json.mjs ${FIXED} < input.json
  node canonical-json.mjs ${DECLARED} < input.json

Options
  --project <dir>   project root (unused; accepted for a uniform CLI)
  --help            show this message

THE HASHING BACKBONE. Changing this output silently invalidates every stored timing hash.

Exit codes: 0 success · 1 the input is not canonicalisable · 2 bad usage`.trim();

// Argument parsing comes first. This block used to read stdin before looking at argv, so
// `--help` with no piped input died on `SyntaxError: Unexpected end of JSON input`.
if (isEntryPoint(import.meta.url)) {
  await runCli(() => {
    const { positionals } = parseCli({ usage: USAGE, allowPositionals: true });
    const mode = positionals[0] ?? FIXED;
    const value = JSON.parse(fs.readFileSync(0, 'utf8'));
    process.stdout.write(canonicalBytes(value, mode));
  });
}
