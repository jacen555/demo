import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2] || FIXED;
  const input = fs.readFileSync(0, 'utf8');
  const value = JSON.parse(input);
  process.stdout.write(canonicalBytes(value, mode));
}
