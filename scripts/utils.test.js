#!/usr/bin/env node
/**
 * Tests for scripts/utils.js and configure.js helpers.
 * No test framework — run with: node scripts/utils.test.js
 */

const {
  REGEX,
  ENV_VAR,
  EXIT_CODE,
  coerceType,
  parseArrayValue,
  parseAllowedOrigins,
  normalizeCoolifyOrigin,
} = require('./utils');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${label}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

function throws(fn, label) {
  try {
    fn();
    failed++;
    console.error(`  FAIL: ${label} (expected throw, got none)`);
  } catch {
    passed++;
  }
}

// ── coerceType ──────────────────────────────────────────────────────────────

console.log('coerceType');

eq(coerceType('true'), true, 'boolean true');
eq(coerceType('false'), false, 'boolean false');
eq(coerceType('42'), 42, 'positive integer');
eq(coerceType('-7'), -7, 'negative integer');
eq(coerceType('0'), 0, 'zero');
eq(coerceType('3.14'), 3.14, 'positive float');
eq(coerceType('-0.5'), -0.5, 'negative float');
eq(coerceType('hello'), 'hello', 'plain string');
eq(coerceType(''), '', 'empty string');
eq(coerceType('TRUE'), 'TRUE', 'uppercase TRUE stays string');
eq(coerceType('False'), 'False', 'capitalized False stays string');
eq(coerceType('007'), 7, 'leading zeros parsed as integer');
eq(coerceType('1.'), '1.', 'trailing dot stays string');
eq(coerceType('.5'), '.5', 'leading dot stays string');
eq(coerceType('1e5'), '1e5', 'scientific notation stays string');
eq(coerceType('  42  '), '  42  ', 'whitespace-padded number stays string');
eq(coerceType('null'), 'null', 'null stays string');
eq(coerceType('undefined'), 'undefined', 'undefined stays string');
eq(coerceType('Infinity'), 'Infinity', 'Infinity stays string');
eq(coerceType('-Infinity'), '-Infinity', '-Infinity stays string');

// ── parseArrayValue ─────────────────────────────────────────────────────────

console.log('parseArrayValue');

eq(parseArrayValue('a,b,c'), ['a', 'b', 'c'], 'simple csv');
eq(parseArrayValue('a, b , c'), ['a', 'b', 'c'], 'csv with spaces');
eq(parseArrayValue('a,,b'), ['a', 'b'], 'csv with empty segment');
eq(parseArrayValue(',a,'), ['a'], 'csv with leading/trailing commas');
eq(parseArrayValue('single'), ['single'], 'single value');
eq(parseArrayValue(''), [], 'empty string');
eq(parseArrayValue(' , , '), [], 'only whitespace and commas');

// ── parseAllowedOrigins (CSV mode) ──────────────────────────────────────────

console.log('parseAllowedOrigins (CSV)');

eq(
  parseAllowedOrigins('http://localhost:5173,http://localhost:3000'),
  ['http://localhost:5173', 'http://localhost:3000'],
  'comma-separated origins'
);
eq(
  parseAllowedOrigins('http://localhost:5173'),
  ['http://localhost:5173'],
  'single origin'
);
eq(
  parseAllowedOrigins('  http://a.com , http://b.com  '),
  ['http://a.com', 'http://b.com'],
  'origins with surrounding whitespace'
);

// ── parseAllowedOrigins (JSON mode) ─────────────────────────────────────────

console.log('parseAllowedOrigins (JSON)');

eq(
  parseAllowedOrigins('["http://a.com","http://b.com"]'),
  ['http://a.com', 'http://b.com'],
  'JSON array of strings'
);
eq(
  parseAllowedOrigins('  ["http://a.com"]  '),
  ['http://a.com'],
  'JSON array with surrounding whitespace'
);
eq(
  parseAllowedOrigins('[]'),
  [],
  'empty JSON array'
);

// Non-string elements should be filtered out
eq(
  parseAllowedOrigins('[123, "http://ok.com", null, false, "http://b.com"]'),
  ['http://ok.com', 'http://b.com'],
  'JSON array filters non-string elements'
);
eq(
  parseAllowedOrigins('[123, null, true]'),
  [],
  'JSON array with no strings returns empty'
);

// Invalid JSON starting with [ should throw
throws(
  () => parseAllowedOrigins('[not valid json'),
  'malformed JSON array throws'
);
throws(
  () => parseAllowedOrigins('['),
  'bare bracket throws'
);

// ── normalizeCoolifyOrigin ──────────────────────────────────────────────────

console.log('normalizeCoolifyOrigin');

eq(
  normalizeCoolifyOrigin('app.example.com'),
  'https://app.example.com',
  'bare hostname defaults to https'
);
eq(
  normalizeCoolifyOrigin('app.example.com/'),
  'https://app.example.com',
  'bare hostname drops trailing slash'
);
eq(
  normalizeCoolifyOrigin(' https://app.example.com/ '),
  'https://app.example.com',
  'https origin is preserved and trimmed'
);
eq(
  normalizeCoolifyOrigin('http://localhost:8080/'),
  'http://localhost:8080',
  'explicit http origin is preserved'
);
eq(
  normalizeCoolifyOrigin(''),
  '',
  'empty value stays empty'
);
eq(
  normalizeCoolifyOrigin(' / '),
  '',
  'slash-only value becomes empty'
);

// ── REGEX patterns ──────────────────────────────────────────────────────────

console.log('REGEX patterns');

assert(REGEX.INTEGER.test('42'), 'INTEGER matches 42');
assert(REGEX.INTEGER.test('-3'), 'INTEGER matches -3');
assert(REGEX.INTEGER.test('0'), 'INTEGER matches 0');
assert(!REGEX.INTEGER.test('3.14'), 'INTEGER rejects 3.14');
assert(!REGEX.INTEGER.test(''), 'INTEGER rejects empty');
assert(!REGEX.INTEGER.test('abc'), 'INTEGER rejects abc');

assert(REGEX.FLOAT.test('3.14'), 'FLOAT matches 3.14');
assert(REGEX.FLOAT.test('-0.5'), 'FLOAT matches -0.5');
assert(!REGEX.FLOAT.test('42'), 'FLOAT rejects 42');
assert(!REGEX.FLOAT.test('.5'), 'FLOAT rejects .5');
assert(!REGEX.FLOAT.test('1.'), 'FLOAT rejects 1.');

assert(REGEX.JSON_STARTS_WITH_ARRAY.test('['), 'JSON_STARTS_WITH_ARRAY matches [');
assert(REGEX.JSON_STARTS_WITH_ARRAY.test('  ['), 'JSON_STARTS_WITH_ARRAY matches leading space');
assert(!REGEX.JSON_STARTS_WITH_ARRAY.test('{'), 'JSON_STARTS_WITH_ARRAY rejects {');
assert(!REGEX.JSON_STARTS_WITH_ARRAY.test('hello'), 'JSON_STARTS_WITH_ARRAY rejects plain string');

// ── Constants ───────────────────────────────────────────────────────────────

console.log('constants');

eq(ENV_VAR.DOT_NOTATION_PREFIX, 'OPENCLAW__', 'DOT_NOTATION_PREFIX');
eq(ENV_VAR.ARRAY_SUFFIX, '[]', 'ARRAY_SUFFIX');
eq(EXIT_CODE.INVALID_CONFIG, 1, 'INVALID_CONFIG exit code');

// Frozen — should not be writable
try { ENV_VAR.DOT_NOTATION_PREFIX = 'X'; } catch {}
eq(ENV_VAR.DOT_NOTATION_PREFIX, 'OPENCLAW__', 'ENV_VAR is frozen');

// ── deepMerge (imported inline from configure.js pattern) ───────────────────

console.log('deepMerge');

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (UNSAFE_KEYS.has(key)) continue;
    if (
      source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
      target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
    ) {
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

// Basic merge
eq(deepMerge({ a: 1 }, { b: 2 }), { a: 1, b: 2 }, 'flat merge');

// Deep merge
eq(
  deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 3, z: 4 } }),
  { a: { x: 1, y: 3, z: 4 } },
  'nested merge preserves existing keys'
);

// Arrays replaced, not concatenated
eq(
  deepMerge({ a: [1, 2] }, { a: [3] }),
  { a: [3] },
  'arrays are replaced'
);

// Overwrite primitive with object
eq(
  deepMerge({ a: 'string' }, { a: { nested: true } }),
  { a: { nested: true } },
  'object overwrites primitive'
);

// Overwrite object with primitive
eq(
  deepMerge({ a: { nested: true } }, { a: 42 }),
  { a: 42 },
  'primitive overwrites object'
);

// Prototype pollution: __proto__
{
  const target = { safe: 1 };
  const malicious = JSON.parse('{"__proto__":{"polluted":"yes"}, "legit":"ok"}');
  deepMerge(target, malicious);
  eq(target.legit, 'ok', '__proto__ attack: legit key merged');
  eq(({}).polluted, undefined, '__proto__ attack: Object.prototype not polluted');
}

// Prototype pollution: constructor
{
  const target = {};
  const malicious = { constructor: { polluted: true }, safe: 1 };
  deepMerge(target, malicious);
  eq(target.safe, 1, 'constructor attack: safe key merged');
  assert(target.constructor === Object, 'constructor attack: constructor unchanged');
}

// Prototype pollution: prototype
{
  const target = {};
  const malicious = { prototype: { bad: true }, safe: 1 };
  deepMerge(target, malicious);
  eq(target.safe, 1, 'prototype attack: safe key merged');
  assert(!target.prototype, 'prototype attack: prototype key skipped');
}

// 3-level deep merge
eq(
  deepMerge(
    { a: { b: { c: 1, d: 2 } } },
    { a: { b: { d: 3, e: 4 } } }
  ),
  { a: { b: { c: 1, d: 3, e: 4 } } },
  '3-level deep merge'
);

// Empty source
eq(deepMerge({ a: 1 }, {}), { a: 1 }, 'empty source is no-op');

// Empty target
eq(deepMerge({}, { a: 1 }), { a: 1 }, 'empty target gets all keys');

// Null value in source
eq(deepMerge({ a: 1 }, { a: null }), { a: null }, 'null overwrites value');

// ── dot-notation path parsing simulation ────────────────────────────────────

console.log('dot-notation parsing');

function parseDotNotation(envKey) {
  if (!envKey.startsWith(ENV_VAR.DOT_NOTATION_PREFIX)) return null;
  const isArray = envKey.endsWith(ENV_VAR.ARRAY_SUFFIX);
  const pathPart = isArray
    ? envKey.slice(ENV_VAR.DOT_NOTATION_PREFIX.length, -ENV_VAR.ARRAY_SUFFIX.length)
    : envKey.slice(ENV_VAR.DOT_NOTATION_PREFIX.length);
  const segments = pathPart.split('__').filter(Boolean);
  if (segments.length === 0) return null;
  if (segments.some(s => UNSAFE_KEYS.has(s))) return 'UNSAFE';
  return { segments, isArray };
}

eq(
  parseDotNotation('OPENCLAW__channels__telegram__textChunkLimit'),
  { segments: ['channels', 'telegram', 'textChunkLimit'], isArray: false },
  'standard 3-level path'
);
eq(
  parseDotNotation('OPENCLAW__tags[]'),
  { segments: ['tags'], isArray: true },
  'array suffix detected'
);
eq(
  parseDotNotation('OPENCLAW__a__b__c[]'),
  { segments: ['a', 'b', 'c'], isArray: true },
  'nested array path'
);
eq(
  parseDotNotation('OPENCLAW__'),
  null,
  'empty path returns null'
);
eq(
  parseDotNotation('OPENCLAW____'),
  null,
  'only separators returns null'
);
eq(
  parseDotNotation('OTHER__key'),
  null,
  'wrong prefix returns null'
);
// __proto__ can't appear as a single segment because __ is the delimiter.
// OPENCLAW____proto____evil splits to ['proto', 'evil'] which is harmless.
eq(
  parseDotNotation('OPENCLAW____proto____evil'),
  { segments: ['proto', 'evil'], isArray: false },
  '__proto__ split by delimiter is harmless'
);
eq(
  parseDotNotation('OPENCLAW__constructor__pollute'),
  'UNSAFE',
  'constructor in path detected as unsafe'
);
eq(
  parseDotNotation('OPENCLAW__prototype__bad'),
  'UNSAFE',
  'prototype in path detected as unsafe'
);
eq(
  parseDotNotation('OPENCLAW__safe__constructor_name'),
  { segments: ['safe', 'constructor_name'], isArray: false },
  'partial match of unsafe key is allowed'
);

// ── Results ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
