#!/usr/bin/env node
/**
 * Tests for scripts/utils.js and configure.js helpers.
 * No test framework — run with: node scripts/utils.test.js
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  REGEX,
  ENV_VAR,
  EXIT_CODE,
  coerceType,
  parseArrayValue,
  parseAllowedOrigins,
  normalizeCoolifyOrigin,
  normalizeCoolifyOrigins,
  coolifyAllowedOrigins,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  resolveOpenAICompatibleProvider,
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
eq(
  normalizeCoolifyOrigin('HTTPS://App.Example.COM:443/ui/'),
  'https://app.example.com',
  'explicit :443, path, and host case collapse to the browser origin'
);
eq(
  normalizeCoolifyOrigin('http://127.0.0.1:80/path'),
  'http://127.0.0.1',
  'default http port and path are removed'
);
eq(
  normalizeCoolifyOrigin('not a host'),
  '',
  'invalid entry becomes empty'
);

// ── normalizeCoolifyOrigins / coolifyAllowedOrigins ─────────────────────────

console.log('normalizeCoolifyOrigins');

eq(
  normalizeCoolifyOrigins('a.com,b.com'),
  ['https://a.com', 'https://b.com'],
  'comma-separated bare hosts are split, not joined into one origin'
);
eq(
  normalizeCoolifyOrigins(' a.com , b.com , '),
  ['https://a.com', 'https://b.com'],
  'comma list entries are trimmed and empty slots dropped'
);
eq(
  normalizeCoolifyOrigins('https://a.example.com/ui, http://b.example.com:8443/path'),
  ['https://a.example.com', 'http://b.example.com:8443'],
  'each URL keeps its scheme; paths are stripped'
);
eq(
  normalizeCoolifyOrigins('https://App.Example.com:443/,https://app.example.com/other'),
  ['https://app.example.com'],
  'port, case, and path variants collapse to one origin'
);
eq(
  normalizeCoolifyOrigins('https://ok.example.com, not a host, https://also.example.com'),
  ['https://ok.example.com', 'https://also.example.com'],
  'invalid list entries are skipped'
);
eq(normalizeCoolifyOrigins(''), [], 'empty list stays empty');
eq(normalizeCoolifyOrigins(' , '), [], 'comma-only list stays empty');

console.log('coolifyAllowedOrigins');

eq(
  coolifyAllowedOrigins('http://app.example.com/admin', 'app.example.com'),
  ['http://app.example.com'],
  'scheme comes from COOLIFY_URL when both variables are set'
);
eq(
  coolifyAllowedOrigins('https://A.Example.com:443/ui,http://b.example.com', 'ignored.example.com'),
  ['https://a.example.com', 'http://b.example.com'],
  'COOLIFY_URL comma list is normalized and COOLIFY_FQDN is not also used'
);
eq(
  coolifyAllowedOrigins(undefined, 'a.com, b.com'),
  ['https://a.com', 'https://b.com'],
  'bare COOLIFY_FQDN is the fallback and defaults to https'
);
eq(
  coolifyAllowedOrigins('   ', 'app.example.com'),
  ['https://app.example.com'],
  'blank COOLIFY_URL falls through to COOLIFY_FQDN'
);
eq(
  coolifyAllowedOrigins(undefined, undefined),
  [],
  'missing Coolify variables add nothing'
);

// configure.js wires the helper and must keep manual origins without duplicates.
console.log('configure.js Coolify origins');

function readConfiguredOrigins(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-origins-'));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'configure.js')], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ANTHROPIC_API_KEY: 'test-key',
        OPENCLAW_STATE_DIR: dir,
        OPENCLAW_WORKSPACE_DIR: path.join(dir, 'workspace'),
        OPENCLAW_CONFIG_PATH: path.join(dir, 'openclaw.json'),
        OPENCLAW_CUSTOM_CONFIG: path.join(dir, 'missing-custom.json'),
        ...env,
      },
    });
    assert(result.status === 0, `configure.js exits 0 (${env && JSON.stringify(env)})`);
    if (result.status !== 0) {
      console.error(result.stdout);
      console.error(result.stderr);
      return null;
    }
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'openclaw.json'), 'utf8'));
    const origins = written.gateway
      && written.gateway.controlUi
      && written.gateway.controlUi.allowedOrigins;
    return origins || [];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

eq(
  readConfiguredOrigins({
    COOLIFY_URL: 'http://app.example.com/ui, https://APP.Example.com:443/',
    COOLIFY_FQDN: 'ignored.example.com',
    OPENCLAW_ALLOWED_ORIGINS: 'http://localhost:5173,https://app.example.com',
  }),
  ['http://localhost:5173', 'https://app.example.com', 'http://app.example.com'],
  'manual origins are preserved, Coolify scheme/path/case applied, no duplicates'
);
eq(
  readConfiguredOrigins({
    COOLIFY_FQDN: 'a.com, b.com',
  }),
  ['https://a.com', 'https://b.com'],
  'configure.js falls back to a comma-separated COOLIFY_FQDN'
);
eq(
  readConfiguredOrigins({}),
  [],
  'configure.js adds no origins when Coolify variables are unset'
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

// ── OpenAI-compatible provider ──────────────────────────────────────────────

console.log('resolveOpenAICompatibleProvider');

const SECRET = 'sk-SUPERSECRET-do-not-log';

function providerResult(input) {
  return resolveOpenAICompatibleProvider(input);
}

{
  const result = providerResult({});
  eq(result.action, 'absent', 'no env vars leaves the provider absent');
  eq(result.modelRef, '', 'absent result has no model ref');
  assert(result.warning === undefined, 'absent result has no warning');
  assert(!JSON.stringify(result).includes('api.openai.com'), 'absent result does not default the base URL');
  assert(!JSON.stringify(result).includes('gpt-4'), 'absent result does not default the model');
}

{
  const result = providerResult({ apiKey: SECRET });
  eq(result.action, 'incomplete', 'API key alone does not enable the provider');
  assert(!result.provider, 'incomplete result has no provider to send anywhere');
  assert(result.warning.includes('OPENAI_COMPATIBLE_BASE_URL'), 'key-only warning names the base URL');
  assert(result.warning.includes('OPENAI_COMPATIBLE_MODEL'), 'key-only warning names the model');
  assert(!result.warning.includes(SECRET), 'key-only warning does not contain the key');
  assert(!JSON.stringify(result).includes(SECRET), 'key-only result does not contain the key');
  assert(!JSON.stringify(result).includes('api.openai.com'), 'key-only result does not default to OpenAI');
  assert(!JSON.stringify(result).includes('gpt-4'), 'key-only result does not default to gpt-4');
}

{
  const result = providerResult({ baseUrl: 'http://127.0.0.1:8000/v1' });
  eq(result.action, 'incomplete', 'base URL alone is incomplete');
  assert(result.warning.includes('OPENAI_COMPATIBLE_MODEL is required'), 'base-URL-only warning says the model is required');
  assert(!result.warning.includes('OPENAI_COMPATIBLE_BASE_URL is required'), 'base-URL-only warning does not say the URL is missing');
  assert(!result.warning.includes('OPENAI_COMPATIBLE_BASE_URL and OPENAI_COMPATIBLE_MODEL are required'), 'base-URL-only warning does not say both are missing');
}

{
  const result = providerResult({ model: 'llama' });
  eq(result.action, 'incomplete', 'model alone is incomplete');
  assert(result.warning.includes('OPENAI_COMPATIBLE_BASE_URL'), 'model-only warning names the base URL');
}

{
  const result = providerResult({
    apiKey: '   ',
    baseUrl: '   ',
    model: '  ',
  });
  eq(result.action, 'absent', 'whitespace-only values count as unset');
}

{
  const result = providerResult({
    baseUrl: 'http://127.0.0.1:8000/v1///',
    model: '  my-model  ',
  });
  eq(result.action, 'apply', 'local base URL and model enable the provider without a key');
  eq(result.provider.baseUrl, 'http://127.0.0.1:8000/v1', 'trailing slashes are stripped');
  eq(result.provider.api, 'openai-completions', 'new provider uses openai-completions');
  assert(result.provider.apiKey === undefined, 'local provider omits apiKey when unset');
  eq(result.provider.models, [
    { id: 'my-model', name: 'my-model', contextWindow: 128000 },
  ], 'model id, name, and context window are set');
  eq(result.modelRef, 'openai-compatible/my-model', 'model ref uses the provider id and model');
  eq(result.providerId, OPENAI_COMPATIBLE_PROVIDER_ID, 'provider id is openai-compatible');
  assert(result.warning === undefined, 'local base URL without a key does not warn');
}

{
  const localHosts = [
    'http://localhost:1234/v1',
    'http://host.docker.internal:4000/v1',
    'http://192.168.1.20:8000/v1',
    'http://10.1.2.3/v1',
    'http://172.16.0.5/v1',
    'http://vllm:8000/v1',
    'http://lmstudio.local:1234/v1',
    'http://[::1]:8000/v1',
  ];
  for (const baseUrl of localHosts) {
    const result = providerResult({ baseUrl, model: 'm' });
    assert(result.warning === undefined, `no key warning for local URL ${baseUrl}`);
    assert(result.provider.apiKey === undefined, `no apiKey written for ${baseUrl}`);
  }
}

{
  const result = providerResult({
    baseUrl: 'https://proxy.example.com/v1/',
    model: 'llama-3.1-405b',
  });
  eq(result.action, 'apply', 'public base URL still configures the provider');
  eq(result.provider.baseUrl, 'https://proxy.example.com/v1', 'public trailing slash stripped');
  assert(result.provider.apiKey === undefined, 'public provider omits apiKey when unset');
  assert(typeof result.warning === 'string' && result.warning.includes('OPENAI_COMPATIBLE_API_KEY'), 'public URL without a key warns');
  assert(!result.warning.includes('proxy.example.com'), 'public warning does not echo the URL');
}

{
  const result = providerResult({
    apiKey: `  ${SECRET}  `,
    baseUrl: 'https://proxy.example.com/openai',
    model: 'llama-3.1-405b',
  });
  eq(result.provider.apiKey, SECRET, 'API key is trimmed and stored on the provider');
  eq(result.provider.baseUrl, 'https://proxy.example.com/openai', 'explicit base URL is kept');
  eq(result.provider.models[0].id, 'llama-3.1-405b', 'explicit model is kept');
  assert(result.warning === undefined, 'public URL with a key does not warn');
  assert(!result.warning || !result.warning.includes(SECRET), 'apply warning does not contain the key');
}

{
  const existing = {
    api: 'openai-responses',
    baseUrl: 'http://old.example/v1',
    apiKey: 'old-key',
    timeoutSeconds: 300,
    headers: { 'X-Trace': '1' },
    models: [
      { id: 'kept-model', name: 'Kept', contextWindow: 4096 },
      { id: 'llama', name: 'Custom name', contextWindow: 8192 },
    ],
  };
  const existingModels = existing.models;
  const result = providerResult({
    apiKey: SECRET,
    baseUrl: 'http://litellm:4000/v1/',
    model: 'new-model',
    existing,
  });
  eq(result.provider.api, 'openai-responses', 'existing api adapter is preserved');
  eq(result.provider.baseUrl, 'http://litellm:4000/v1', 'env base URL replaces the mounted one');
  eq(result.provider.apiKey, SECRET, 'env API key replaces the mounted one');
  eq(result.provider.timeoutSeconds, 300, 'extra provider fields are preserved');
  eq(result.provider.headers, { 'X-Trace': '1' }, 'extra header fields are preserved');
  eq(result.provider.models.map((model) => model.id), ['kept-model', 'llama', 'new-model'], 'new model is appended');
  eq(result.provider.models[0], { id: 'kept-model', name: 'Kept', contextWindow: 4096 }, 'existing model is not rewritten');
  eq(result.provider.models[1].contextWindow, 8192, 'matching model keeps its context window');
  eq(existing.baseUrl, 'http://old.example/v1', 'existing provider object is not mutated');
  eq(existing.models, existingModels, 'existing models array is not mutated');
  eq(existing.models.length, 2, 'existing models keep their length');
  assert(!result.warning || !result.warning.includes(SECRET), 'merge warning does not contain the key');
}

{
  const result = providerResult({
    baseUrl: 'https://proxy.example.com/v1',
    model: 'llama',
    existing: {
      api: 'openai-completions',
      apiKey: 'mounted-key',
      models: [{ id: 'llama', name: 'Llama', contextWindow: 1000 }],
    },
  });
  eq(result.provider.apiKey, 'mounted-key', 'unset env key does not wipe a mounted key');
  eq(result.provider.models, [{ id: 'llama', name: 'Llama', contextWindow: 1000 }], 'existing model id is not duplicated');
  assert(result.warning === undefined, 'mounted key suppresses the public missing-key warning');
}

{
  const result = providerResult({
    baseUrl: 'http://172.15.0.1/v1',
    model: 'm',
  });
  assert(typeof result.warning === 'string', '172.15 is not treated as private LAN');
}

// configure.js must call the helper. These spawn the script instead of copying its logic.
console.log('configure.js OpenAI-compatible provider');

function runConfigure(env, customConfig) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-openai-compatible-'));
  const customPath = path.join(dir, 'custom.json');
  if (customConfig !== undefined) {
    fs.writeFileSync(customPath, JSON.stringify(customConfig));
  }
  const result = spawnSync(process.execPath, [path.join(__dirname, 'configure.js')], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      OPENCLAW_STATE_DIR: dir,
      OPENCLAW_WORKSPACE_DIR: path.join(dir, 'workspace'),
      OPENCLAW_CONFIG_PATH: path.join(dir, 'openclaw.json'),
      OPENCLAW_CUSTOM_CONFIG: customConfig === undefined ? path.join(dir, 'missing.json') : customPath,
      ...env,
    },
  });
  let written = null;
  const configPath = path.join(dir, 'openclaw.json');
  if (fs.existsSync(configPath)) {
    written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    status: result.status,
    output: `${result.stdout || ''}\n${result.stderr || ''}`,
    written,
  };
}

{
  const run = runConfigure({ OPENAI_COMPATIBLE_API_KEY: SECRET });
  eq(run.status, 1, 'configure.js rejects an API key without base URL and model');
  assert(run.output.includes('OPENAI_COMPATIBLE_BASE_URL'), 'configure.js warning names the missing base URL');
  assert(run.output.includes('OPENAI_COMPATIBLE_MODEL'), 'configure.js warning names the missing model');
  assert(!run.output.includes(SECRET), 'configure.js does not log the API key');
  assert(!run.output.includes('api.openai.com'), 'configure.js does not mention the OpenAI default URL');
  eq(run.written, null, 'configure.js does not write a provider when the key is the only variable');
}

{
  const run = runConfigure({
    OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1:8000/v1/',
    OPENAI_COMPATIBLE_MODEL: 'local-model',
  });
  eq(run.status, 0, 'configure.js accepts a local base URL and model without a key');
  const provider = run.written.models.providers['openai-compatible'];
  eq(provider.baseUrl, 'http://127.0.0.1:8000/v1', 'configure.js strips the trailing slash');
  eq(provider.api, 'openai-completions', 'configure.js sets openai-completions');
  assert(provider.apiKey === undefined, 'configure.js omits apiKey for a local server');
  eq(provider.models[0].id, 'local-model', 'configure.js writes the model id');
  eq(run.written.agents.defaults.model.primary, 'openai-compatible/local-model', 'configure.js auto-selects the custom model');
}

{
  const run = runConfigure({
    OPENAI_COMPATIBLE_API_KEY: SECRET,
    OPENAI_COMPATIBLE_BASE_URL: 'http://litellm:4000/v1',
    OPENAI_COMPATIBLE_MODEL: 'new-model',
  }, {
    models: {
      providers: {
        'openai-compatible': {
          api: 'openai-completions',
          baseUrl: 'http://old.example/v1',
          timeoutSeconds: 90,
          models: [
            { id: 'kept-model', name: 'Kept', contextWindow: 2048 },
          ],
        },
      },
    },
  });
  eq(run.status, 0, 'configure.js merges onto a mounted provider');
  const provider = run.written.models.providers['openai-compatible'];
  eq(provider.baseUrl, 'http://litellm:4000/v1', 'configure.js updates baseUrl from the env');
  eq(provider.apiKey, SECRET, 'configure.js updates apiKey from the env');
  eq(provider.timeoutSeconds, 90, 'configure.js keeps extra mounted fields');
  eq(provider.models.map((model) => model.id), ['kept-model', 'new-model'], 'configure.js keeps mounted models and adds the env model');
  eq(provider.models[0].contextWindow, 2048, 'configure.js does not rewrite the mounted model');
  assert(!run.output.includes(SECRET), 'configure.js does not log the API key while merging');
}

{
  const run = runConfigure({
    ANTHROPIC_API_KEY: 'test-key',
    OPENAI_COMPATIBLE_BASE_URL: 'https://proxy.example.com/v1',
    OPENAI_COMPATIBLE_MODEL: 'llama',
  });
  eq(run.status, 0, 'configure.js still starts when another provider is set');
  assert(run.output.includes('OPENAI_COMPATIBLE_API_KEY'), 'configure.js warns when a public URL has no key');
  assert(run.written.models.providers['openai-compatible'].apiKey === undefined, 'public provider is written without a key');
  eq(run.written.agents.defaults.model.primary, 'anthropic/claude-opus-4-5-20251101', 'Anthropic stays ahead of the custom provider');
}

// ── Results ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
