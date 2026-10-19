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
  normalizeOllamaBaseUrl,
  readCustomOllamaModels,
  applyOllamaBaseUrl,
  restoreCustomOllamaModels,
  ollamaPrimaryModel,
  reconcileStaleOllamaPrimary,
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

// ── Ollama provider ─────────────────────────────────────────────────────────

console.log('ollama provider');

const QWEN = { id: 'qwen3.5:9b', name: 'Qwen 3.5 9B', contextWindow: 32768 };
const MISTRAL = { id: 'mistral', name: 'Mistral' };
const LLAMA = { id: 'llama3.3', name: 'Llama 3.3', contextWindow: 128000 };

eq(normalizeOllamaBaseUrl('http://host:11434/'), 'http://host:11434/v1', 'trailing slash gets /v1');
eq(normalizeOllamaBaseUrl('http://host:11434'), 'http://host:11434/v1', 'bare host gets /v1');
eq(normalizeOllamaBaseUrl('http://host:11434/v1'), 'http://host:11434/v1', 'existing /v1 is kept');
eq(normalizeOllamaBaseUrl('http://host:11434/v1/'), 'http://host:11434/v1', 'trailing slash after /v1 is stripped');
eq(normalizeOllamaBaseUrl(''), '', 'empty url stays empty');
eq(normalizeOllamaBaseUrl('///'), '', 'slash-only url stays empty');
eq(normalizeOllamaBaseUrl(undefined), '', 'missing url stays empty');

// Fresh install: no provider yet, env supplies the URL.
{
  const fresh = {};
  eq(
    applyOllamaBaseUrl(fresh, 'http://host.docker.internal:11434/'),
    'http://host.docker.internal:11434/v1',
    'fresh install returns normalized base url'
  );
  eq(fresh.models.providers.ollama, {
    api: 'openai-completions',
    baseUrl: 'http://host.docker.internal:11434/v1',
    models: [LLAMA],
  }, 'fresh install installs the default llama3.3 catalog');
  eq(ollamaPrimaryModel(fresh), 'ollama/llama3.3', 'fresh install primary is ollama/llama3.3');
}

// Default model objects are not shared across configs.
{
  const a = {};
  const b = {};
  applyOllamaBaseUrl(a, 'http://a:11434');
  applyOllamaBaseUrl(b, 'http://b:11434');
  a.models.providers.ollama.models.push({ id: 'extra' });
  eq(b.models.providers.ollama.models, [LLAMA], 'default catalog is not shared between configs');
}

// Custom JSON models are kept; OLLAMA_BASE_URL updates baseUrl only.
{
  const custom = {
    models: {
      providers: {
        ollama: {
          api: 'openai-completions',
          baseUrl: 'http://custom:11434/v1',
          apiKey: 'ollama',
          models: [QWEN],
        },
        anthropic: { api: 'anthropic' },
      },
    },
  };
  const customModels = readCustomOllamaModels(custom);
  applyOllamaBaseUrl(custom, 'http://ollama:11434');
  restoreCustomOllamaModels(custom, customModels);
  eq(custom.models.providers.ollama, {
    api: 'openai-completions',
    baseUrl: 'http://ollama:11434/v1',
    apiKey: 'ollama',
    models: [QWEN],
  }, 'custom models and apiKey survive a baseUrl override');
  eq(custom.models.providers.anthropic, { api: 'anthropic' }, 'other providers are left alone');
  eq(ollamaPrimaryModel(custom), 'ollama/qwen3.5:9b', 'automatic primary is the first custom model');
}

// Saved default catalog after deepMerge, then custom models win.
{
  const custom = {
    models: {
      providers: {
        ollama: {
          api: 'openai-completions',
          baseUrl: 'http://custom:11434/v1',
          apiKey: 'ollama',
          models: [QWEN, MISTRAL],
        },
      },
    },
  };
  const customModels = readCustomOllamaModels(custom);
  const merged = {
    models: {
      providers: {
        ollama: {
          api: 'openai-completions',
          baseUrl: 'http://saved:11434/v1',
          apiKey: 'ollama',
          models: [LLAMA],
        },
      },
    },
    agents: { defaults: { model: { primary: 'ollama/llama3.3' } } },
  };
  applyOllamaBaseUrl(merged, 'http://ollama:11434/');
  restoreCustomOllamaModels(merged, customModels);
  eq(merged.models.providers.ollama.models, [QWEN, MISTRAL], 'custom models replace the stale saved default');
  eq(merged.models.providers.ollama.baseUrl, 'http://ollama:11434/v1', 'env baseUrl still wins over the saved url');
  eq(merged.models.providers.ollama.apiKey, 'ollama', 'apiKey on the saved provider is kept');
  eq(
    reconcileStaleOllamaPrimary(merged, merged.agents.defaults.model.primary),
    'ollama/qwen3.5:9b',
    'stale ollama/llama3.3 primary follows the first custom model'
  );
  eq(ollamaPrimaryModel(merged), 'ollama/qwen3.5:9b', 'auto primary matches the first custom model');
}

// OLLAMA_BASE_URL override does not replace models the user saved directly.
{
  const saved = {
    models: {
      providers: {
        ollama: {
          api: 'openai-completions',
          baseUrl: 'http://old:11434/v1',
          apiKey: 'keep-me',
          models: [MISTRAL],
        },
      },
    },
  };
  applyOllamaBaseUrl(saved, 'http://10.0.0.5:11434/v1/');
  restoreCustomOllamaModels(saved, readCustomOllamaModels(null));
  eq(saved.models.providers.ollama, {
    api: 'openai-completions',
    baseUrl: 'http://10.0.0.5:11434/v1',
    apiKey: 'keep-me',
    models: [MISTRAL],
  }, 'baseUrl override keeps models saved without a custom JSON file');
  eq(
    reconcileStaleOllamaPrimary(saved, 'ollama/mistral'),
    'ollama/mistral',
    'a non-default saved primary is not rewritten'
  );
}

// Empty env does not invent a provider, and restore does not resurrect one.
{
  const untouched = { gateway: { port: 18789 } };
  eq(applyOllamaBaseUrl(untouched, ''), '', 'empty OLLAMA_BASE_URL leaves config unchanged');
  eq(untouched, { gateway: { port: 18789 } }, 'empty url does not add models');
  restoreCustomOllamaModels(untouched, [QWEN]);
  eq(untouched, { gateway: { port: 18789 } }, 'restore does not create an ollama provider');
}

eq(readCustomOllamaModels({}), null, 'missing ollama models are not a custom list');
eq(
  readCustomOllamaModels({ models: { providers: { ollama: { models: 'llama3.3' } } } }),
  null,
  'non-array models are not restored'
);
{
  const source = { models: { providers: { ollama: { models: [QWEN] } } } };
  const snapshot = readCustomOllamaModels(source);
  source.models.providers.ollama.models[0] = MISTRAL;
  eq(snapshot, [QWEN], 'custom model snapshot is a copy of the array');
}

eq(
  ollamaPrimaryModel({ models: { providers: { ollama: { models: [{ id: '  ' }, { id: 'qwen' }] } } } }),
  'ollama/qwen',
  'blank model ids are skipped'
);
eq(
  ollamaPrimaryModel({ models: { providers: { ollama: { models: [] } } } }),
  null,
  'empty model list has no automatic primary'
);
eq(
  reconcileStaleOllamaPrimary(
    { models: { providers: { ollama: { models: [LLAMA, QWEN] } } } },
    'ollama/llama3.3'
  ),
  'ollama/llama3.3',
  'stale primary stays when llama3.3 is still configured'
);
eq(
  reconcileStaleOllamaPrimary(
    { models: { providers: { ollama: { models: [QWEN] } } } },
    'anthropic/claude-opus-4-5'
  ),
  'anthropic/claude-opus-4-5',
  'non-ollama primary is unchanged'
);

function runConfigure(env, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-ollama-'));
  const configPath = path.join(dir, 'openclaw.json');
  const customPath = path.join(dir, 'custom.json');
  try {
    if (files.persisted !== undefined) {
      fs.writeFileSync(configPath, JSON.stringify(files.persisted));
    }
    if (files.custom !== undefined) {
      fs.writeFileSync(customPath, JSON.stringify(files.custom));
    }
    const result = spawnSync(process.execPath, [path.join(__dirname, 'configure.js')], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        OPENCLAW_STATE_DIR: dir,
        OPENCLAW_WORKSPACE_DIR: path.join(dir, 'workspace'),
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_CUSTOM_CONFIG: files.custom !== undefined
          ? customPath
          : path.join(dir, 'missing-custom.json'),
        ...env,
      },
    });
    assert(result.status === 0, `configure.js exits 0 (${JSON.stringify(env)})`);
    if (result.status !== 0) {
      console.error(result.stdout);
      console.error(result.stderr);
      return null;
    }
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function ollamaOf(config) {
  return config && config.models && config.models.providers && config.models.providers.ollama;
}

function primaryOf(config) {
  return config && config.agents && config.agents.defaults && config.agents.defaults.model
    && config.agents.defaults.model.primary;
}

console.log('configure.js ollama');

{
  const fresh = runConfigure({ OLLAMA_BASE_URL: 'http://host.docker.internal:11434/' });
  eq(ollamaOf(fresh), {
    api: 'openai-completions',
    baseUrl: 'http://host.docker.internal:11434/v1',
    models: [LLAMA],
  }, 'configure.js fresh install writes the default ollama provider');
  eq(primaryOf(fresh), 'ollama/llama3.3', 'configure.js fresh install primary is ollama/llama3.3');
}

{
  const written = runConfigure(
    { OLLAMA_BASE_URL: 'http://ollama:11434' },
    {
      custom: {
        models: {
          providers: {
            ollama: {
              api: 'openai-completions',
              baseUrl: 'http://custom:11434/v1',
              apiKey: 'ollama',
              models: [QWEN],
            },
          },
        },
      },
    }
  );
  eq(ollamaOf(written), {
    api: 'openai-completions',
    baseUrl: 'http://ollama:11434/v1',
    apiKey: 'ollama',
    models: [QWEN],
  }, 'configure.js custom JSON models survive and baseUrl comes from the env');
  eq(primaryOf(written), 'ollama/qwen3.5:9b', 'configure.js auto primary is the first custom model');
}

{
  const written = runConfigure(
    { OLLAMA_BASE_URL: 'http://ollama:11434' },
    {
      custom: {
        gateway: { port: 1111 },
        models: {
          providers: {
            ollama: {
              api: 'openai-completions',
              baseUrl: 'http://custom:11434/v1',
              apiKey: 'ollama',
              models: [QWEN, MISTRAL],
            },
          },
        },
      },
      persisted: {
        gateway: { port: 2222 },
        agents: { defaults: { model: { primary: 'ollama/llama3.3' } } },
        models: {
          providers: {
            ollama: {
              api: 'openai-completions',
              baseUrl: 'http://saved:11434/v1',
              models: [LLAMA],
            },
          },
        },
      },
    }
  );
  eq(ollamaOf(written).models, [QWEN, MISTRAL], 'configure.js custom models win over the saved llama3.3 list');
  eq(ollamaOf(written).baseUrl, 'http://ollama:11434/v1', 'configure.js env baseUrl wins over the saved url');
  eq(ollamaOf(written).apiKey, 'ollama', 'configure.js keeps apiKey from the custom provider');
  eq(written && written.gateway && written.gateway.port, 2222, 'persisted non-ollama keys still win the general merge');
  eq(primaryOf(written), 'ollama/qwen3.5:9b', 'configure.js retargets a saved ollama/llama3.3 primary');
}

{
  const written = runConfigure(
    { OLLAMA_BASE_URL: 'http://10.0.0.5:11434/v1/' },
    {
      persisted: {
        agents: { defaults: { model: { primary: 'ollama/mistral' } } },
        models: {
          providers: {
            ollama: {
              api: 'openai-completions',
              baseUrl: 'http://old:11434/v1',
              apiKey: 'keep-me',
              models: [MISTRAL],
            },
          },
        },
      },
    }
  );
  eq(ollamaOf(written), {
    api: 'openai-completions',
    baseUrl: 'http://10.0.0.5:11434/v1',
    apiKey: 'keep-me',
    models: [MISTRAL],
  }, 'configure.js OLLAMA_BASE_URL override keeps a saved model list');
  eq(primaryOf(written), 'ollama/mistral', 'configure.js keeps a saved primary that is not the stale default');
}

{
  const written = runConfigure(
    {
      OLLAMA_BASE_URL: 'http://ollama:11434',
      OPENCLAW_PRIMARY_MODEL: 'ollama/mistral',
    },
    {
      custom: { models: { providers: { ollama: { models: [QWEN] } } } },
      persisted: {
        agents: { defaults: { model: { primary: 'ollama/llama3.3' } } },
        models: { providers: { ollama: { models: [LLAMA] } } },
      },
    }
  );
  eq(primaryOf(written), 'ollama/mistral', 'OPENCLAW_PRIMARY_MODEL beats the stale ollama primary');
  eq(ollamaOf(written).models, [QWEN], 'primary override still restores custom models');
}

{
  const written = runConfigure(
    { OLLAMA_BASE_URL: 'http://ollama:11434', ANTHROPIC_API_KEY: 'test-key' },
    { custom: { models: { providers: { ollama: { models: [QWEN] } } } } }
  );
  eq(primaryOf(written), 'anthropic/claude-opus-4-5-20251101', 'a higher-priority provider still wins when no primary is set');
  eq(ollamaOf(written).models, [QWEN], 'ollama custom models stay when another provider is primary');
}

// ── Results ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
