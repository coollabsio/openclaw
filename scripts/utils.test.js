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
  MINIMAX_GLOBAL_BASE_URL,
  MINIMAX_CN_BASE_URL,
  MINIMAX_PRIMARY_MODEL,
  minimaxBaseUrl,
  minimaxModels,
  normalizeOllamaBaseUrl,
  readCustomOllamaModels,
  applyOllamaBaseUrl,
  restoreCustomOllamaModels,
  ollamaPrimaryModel,
  reconcileStaleOllamaPrimary,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  DEFAULT_OPENAI_COMPATIBLE_CONTEXT_WINDOW,
  OPENAI_COMPATIBLE_BARE_HOST_API_KEY,
  resolveOpenAICompatibleProvider,
  resolveMemoryBackend,
  COMPOSE_BROWSER_SIDECAR_HOSTNAME,
  cdpUrlHostname,
  browserCdpUrls,
  allowComposeBrowserSidecar,
  resolveComposeBrowserSidecarSsrF,
  GATEWAY_TOKEN_PATTERN,
  GATEWAY_TOKEN_ALLOWED_CHARACTERS,
  classifyGatewayToken,
  gatewayTokenError,
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

// ── MiniMax catalog ─────────────────────────────────────────────────────────

console.log('minimax');

eq(MINIMAX_GLOBAL_BASE_URL, 'https://api.minimax.io/anthropic', 'global MiniMax base URL');
eq(MINIMAX_CN_BASE_URL, 'https://api.minimaxi.com/anthropic', 'China MiniMax base URL');
eq(MINIMAX_PRIMARY_MODEL, 'minimax/MiniMax-M3', 'auto primary is MiniMax-M3');

eq(minimaxBaseUrl(undefined), MINIMAX_GLOBAL_BASE_URL, 'missing base URL uses global');
eq(minimaxBaseUrl(null), MINIMAX_GLOBAL_BASE_URL, 'null base URL uses global');
eq(minimaxBaseUrl(''), MINIMAX_GLOBAL_BASE_URL, 'empty base URL uses global');
eq(minimaxBaseUrl('   '), MINIMAX_GLOBAL_BASE_URL, 'whitespace base URL uses global');
eq(minimaxBaseUrl(MINIMAX_CN_BASE_URL), MINIMAX_CN_BASE_URL, 'China base URL is kept');
eq(
  minimaxBaseUrl(`${MINIMAX_CN_BASE_URL}/`),
  MINIMAX_CN_BASE_URL,
  'one trailing slash is stripped'
);
eq(
  minimaxBaseUrl(`  ${MINIMAX_GLOBAL_BASE_URL}///  `),
  MINIMAX_GLOBAL_BASE_URL,
  'surrounding space and extra slashes are stripped'
);

const minimaxCatalog = minimaxModels();
eq(
  minimaxCatalog.map((model) => model.id),
  ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.1'],
  'catalog is M3, M2.7, and legacy M2.1'
);

const minimaxM3 = minimaxCatalog[0];
eq(minimaxM3.name, 'MiniMax M3', 'M3 display name');
eq(minimaxM3.reasoning, true, 'M3 is a reasoning model');
eq(minimaxM3.input, ['text', 'image'], 'M3 accepts text and image');
eq(minimaxM3.compat, { codeMode: 'preferred' }, 'M3 prefers code mode');
eq(
  minimaxM3.cost,
  { input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0 },
  'M3 cost matches upstream'
);
eq(minimaxM3.contextWindow, 1000000, 'M3 context window is 1,000,000');
eq(minimaxM3.maxTokens, 131072, 'M3 maxTokens is 131072');

const minimaxM27 = minimaxCatalog[1];
eq(minimaxM27.reasoning, true, 'M2.7 is a reasoning model');
eq(minimaxM27.input, ['text'], 'M2.7 is text only');
eq(minimaxM27.contextWindow, 204800, 'M2.7 context window is 204,800');
eq(minimaxM27.maxTokens, 131072, 'M2.7 maxTokens is 131072');
eq(
  minimaxM27.cost,
  { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
  'M2.7 cost matches upstream'
);
assert(minimaxM27.compat === undefined, 'M2.7 has no code-mode compat flag');

const minimaxM21 = minimaxCatalog[2];
eq(minimaxM21.name, 'MiniMax M2.1', 'M2.1 display name');
eq(minimaxM21.reasoning, true, 'M2.1 stays a reasoning model');
eq(minimaxM21.input, ['text'], 'M2.1 is text only');
eq(minimaxM21.contextWindow, 204800, 'M2.1 context window is 204,800');
eq(minimaxM21.maxTokens, 131072, 'M2.1 maxTokens is 131072');

const mutated = minimaxModels();
mutated[0].input.push('video');
mutated[0].cost.input = 0;
eq(minimaxModels()[0].input, ['text', 'image'], 'catalog input is copied per call');
eq(minimaxModels()[0].cost.input, 0.6, 'catalog cost is copied per call');

function readMinimaxConfig(env, persisted) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-minimax-'));
  const configPath = path.join(dir, 'openclaw.json');
  try {
    if (persisted) {
      fs.writeFileSync(configPath, JSON.stringify(persisted));
    }
    const result = spawnSync(process.execPath, [path.join(__dirname, 'configure.js')], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        OPENCLAW_STATE_DIR: dir,
        OPENCLAW_WORKSPACE_DIR: path.join(dir, 'workspace'),
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_CUSTOM_CONFIG: path.join(dir, 'missing-custom.json'),
        MINIMAX_API_KEY: 'test-minimax-key',
        ...env,
      },
    });
    assert(result.status === 0, `configure.js MiniMax exits 0 (${JSON.stringify(env || {})})`);
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

console.log('configure.js MiniMax provider');

const minimaxDefault = readMinimaxConfig();
eq(
  minimaxDefault && minimaxDefault.models.providers.minimax,
  {
    api: 'anthropic-messages',
    apiKey: 'test-minimax-key',
    baseUrl: MINIMAX_GLOBAL_BASE_URL,
    models: minimaxModels(),
  },
  'configure.js writes the MiniMax catalog and global base URL'
);
eq(
  minimaxDefault && minimaxDefault.agents.defaults.model.primary,
  MINIMAX_PRIMARY_MODEL,
  'configure.js auto-selects MiniMax-M3 when no primary is saved'
);

const minimaxChina = readMinimaxConfig({
  MINIMAX_BASE_URL: `${MINIMAX_CN_BASE_URL}/`,
});
eq(
  minimaxChina && minimaxChina.models.providers.minimax.baseUrl,
  MINIMAX_CN_BASE_URL,
  'configure.js applies a China MINIMAX_BASE_URL and strips the trailing slash'
);

const minimaxKept = readMinimaxConfig({}, {
  agents: { defaults: { model: { primary: 'minimax/MiniMax-M2.1' } } },
});
eq(
  minimaxKept && minimaxKept.agents.defaults.model.primary,
  'minimax/MiniMax-M2.1',
  'configure.js keeps a saved MiniMax-M2.1 primary'
);
assert(
  minimaxKept
    && minimaxKept.models.providers.minimax.models.some((model) => model.id === 'MiniMax-M2.1'),
  'saved M2.1 primary still has a catalog entry'
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
  assert(!result.warning.includes('OPENAI_COMPATIBLE_BASE_URL'), 'base-URL-only warning names only the missing model');
  assert(!result.warning.includes('OPENAI_COMPATIBLE_BASE_URL is required'), 'base-URL-only warning does not say the URL is missing');
  assert(!result.warning.includes('OPENAI_COMPATIBLE_BASE_URL and OPENAI_COMPATIBLE_MODEL are required'), 'base-URL-only warning does not say both are missing');
}

{
  const result = providerResult({ model: 'llama' });
  eq(result.action, 'incomplete', 'model alone is incomplete');
  assert(result.warning.includes('OPENAI_COMPATIBLE_BASE_URL is required'), 'model-only warning says the base URL is required');
  assert(!result.warning.includes('OPENAI_COMPATIBLE_MODEL'), 'model-only warning names only the missing base URL');
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

{
  const result = providerResult({
    baseUrl: 'http://vllm:8000/v1/',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    contextWindow: '32768',
  });
  eq(result.action, 'apply', 'vLLM base URL and served model apply without a key');
  eq(result.provider.baseUrl, 'http://vllm:8000/v1', 'vLLM trailing slash is stripped');
  eq(result.provider.api, 'openai-completions', 'vLLM uses the chat-completions adapter');
  eq(result.provider.apiKey, OPENAI_COMPATIBLE_BARE_HOST_API_KEY, 'bare vLLM hostname gets the non-secret placeholder key');
  eq(result.provider.models, [
    { id: 'Qwen/Qwen2.5-7B-Instruct', name: 'Qwen/Qwen2.5-7B-Instruct', contextWindow: 32768 },
  ], 'vLLM model keeps the slash and the env context window');
  eq(result.modelRef, 'openai-compatible/Qwen/Qwen2.5-7B-Instruct', 'vLLM model ref keeps the model id');
  assert(result.warning === undefined, 'bare vLLM hostname does not warn');
}

{
  const result = providerResult({
    baseUrl: 'http://vllm:8000/v1',
    model: 'm',
    existing: { apiKey: 'mounted-key', models: [{ id: 'm', name: 'm', contextWindow: 8192 }] },
  });
  eq(result.provider.apiKey, 'mounted-key', 'bare hostname keeps a mounted key when the env key is unset');
}

{
  const result = providerResult({
    apiKey: SECRET,
    baseUrl: 'http://litellm:4000/v1',
    model: 'gpt-4o-mini',
    contextWindow: '  128000  ',
  });
  eq(result.action, 'apply', 'LiteLLM proxy with a master key applies');
  eq(result.provider.apiKey, SECRET, 'LiteLLM master key is stored');
  eq(result.provider.models[0].id, 'gpt-4o-mini', 'LiteLLM model_name is the model id');
  eq(result.provider.models[0].contextWindow, 128000, 'LiteLLM context window is trimmed');
  assert(result.warning === undefined, 'LiteLLM with a key does not warn');
}

{
  const existing = {
    api: 'openai-completions',
    baseUrl: 'http://old.example/v1',
    models: [
      { id: 'kept-model', name: 'Kept', contextWindow: 4096, maxTokens: 1024 },
      { id: 'Qwen/Qwen2.5-7B-Instruct', name: 'Qwen', contextWindow: 8192 },
    ],
  };
  const result = providerResult({
    baseUrl: 'http://vllm:8000/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    contextWindow: '32768',
    existing,
  });
  eq(result.provider.models[0], { id: 'kept-model', name: 'Kept', contextWindow: 4096, maxTokens: 1024 }, 'context window env does not rewrite other models');
  eq(result.provider.models[1], {
    id: 'Qwen/Qwen2.5-7B-Instruct',
    name: 'Qwen',
    contextWindow: 32768,
  }, 'context window env overrides only the named model');
  eq(existing.models[1].contextWindow, 8192, 'existing model object is not mutated');
}

{
  const result = providerResult({
    baseUrl: 'http://vllm:8000/v1',
    model: 'llama',
    contextWindow: '8k',
    existing: {
      models: [{ id: 'llama', name: 'Llama', contextWindow: 8192 }],
    },
  });
  eq(result.action, 'apply', 'invalid context window still applies the provider');
  eq(result.provider.models[0].contextWindow, 8192, 'invalid context window leaves the existing model window');
  assert(result.warning.includes('OPENAI_COMPATIBLE_CONTEXT_WINDOW'), 'invalid context window is named in the warning');
  assert(result.warning.includes('positive integer'), 'invalid context window warning asks for a positive integer');
}

{
  const result = providerResult({
    baseUrl: 'http://vllm:8000/v1',
    model: 'llama',
    contextWindow: '0',
  });
  eq(result.provider.models[0].contextWindow, DEFAULT_OPENAI_COMPATIBLE_CONTEXT_WINDOW, 'zero context window falls back to the default on a new model');
  assert(result.warning.includes('OPENAI_COMPATIBLE_CONTEXT_WINDOW'), 'zero context window warns');
}

{
  const result = providerResult({
    baseUrl: 'http://vllm:8000/v1',
    model: 'llama',
    contextWindow: '   ',
  });
  eq(result.provider.models[0].contextWindow, DEFAULT_OPENAI_COMPATIBLE_CONTEXT_WINDOW, 'blank context window uses the new-model default');
  assert(result.warning === undefined, 'blank context window is treated as unset');
}

{
  const result = providerResult({ contextWindow: '32768' });
  eq(result.action, 'incomplete', 'context window alone does not enable the provider');
  assert(result.warning.includes('OPENAI_COMPATIBLE_BASE_URL'), 'context-window-only warning names the base URL');
  assert(result.warning.includes('OPENAI_COMPATIBLE_MODEL'), 'context-window-only warning names the model');
  assert(!result.provider, 'context-window-only result has no provider');
}

{
  const result = providerResult({ contextWindow: 'nope' });
  eq(result.action, 'incomplete', 'an invalid context window with nothing else is incomplete');
  assert(result.warning.includes('positive integer'), 'invalid context window alone explains the expected type');
}

console.log('resolveMemoryBackend');

{
  const result = resolveMemoryBackend(undefined);
  eq(result.action, 'absent', 'unset memory backend leaves the slot alone');
  assert(result.slot === undefined, 'unset memory backend has no slot');
  assert(result.warning === undefined, 'unset memory backend does not warn');
}

{
  const result = resolveMemoryBackend('   ');
  eq(result.action, 'absent', 'blank memory backend leaves the slot alone');
}

{
  const result = resolveMemoryBackend('memory-core');
  eq(result, { action: 'apply', slot: 'memory-core' }, 'memory-core selects the builtin slot');
}

{
  const result = resolveMemoryBackend('builtin');
  eq(result, { action: 'apply', slot: 'memory-core' }, 'builtin is the old name for memory-core');
}

{
  const result = resolveMemoryBackend('NONE');
  eq(result, { action: 'apply', slot: 'none' }, 'none disables the memory slot');
}

{
  const result = resolveMemoryBackend('memory-lancedb');
  eq(result, { action: 'apply', slot: 'memory-lancedb' }, 'memory-lancedb is passed through');
}

{
  const result = resolveMemoryBackend(' openclaw-honcho ');
  eq(result, { action: 'apply', slot: 'openclaw-honcho' }, 'honcho plugin id is trimmed');
}

{
  const result = resolveMemoryBackend('my-memory');
  eq(result, { action: 'apply', slot: 'my-memory' }, 'an unknown plugin id is passed through');
}

{
  const result = resolveMemoryBackend('qmd');
  eq(result.action, 'rejected', 'qmd is rejected');
  assert(result.slot === undefined, 'qmd does not produce a slot');
  assert(result.warning.includes('memory.backend'), 'qmd warning names the retired key');
  assert(result.warning.includes('plugins.slots.memory'), 'qmd warning names the current key');
  assert(result.warning.includes('memory-core'), 'qmd warning names the builtin plugin');
}

{
  const result = resolveMemoryBackend('QMD');
  eq(result.action, 'rejected', 'QMD is rejected regardless of case');
}

// configure.js must call the helper. These spawn the script instead of copying its logic.
console.log('configure.js OpenAI-compatible provider');

function runOpenAICompatibleConfigure(env, customConfig) {
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
  const run = runOpenAICompatibleConfigure({ OPENAI_COMPATIBLE_API_KEY: SECRET });
  eq(run.status, 1, 'configure.js rejects an API key without base URL and model');
  assert(run.output.includes('OPENAI_COMPATIBLE_BASE_URL'), 'configure.js warning names the missing base URL');
  assert(run.output.includes('OPENAI_COMPATIBLE_MODEL'), 'configure.js warning names the missing model');
  assert(!run.output.includes(SECRET), 'configure.js does not log the API key');
  assert(!run.output.includes('api.openai.com'), 'configure.js does not mention the OpenAI default URL');
  eq(run.written, null, 'configure.js does not write a provider when the key is the only variable');
}

{
  const run = runOpenAICompatibleConfigure({
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
  const run = runOpenAICompatibleConfigure({
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
  const run = runOpenAICompatibleConfigure({
    ANTHROPIC_API_KEY: 'test-key',
    OPENAI_COMPATIBLE_BASE_URL: 'https://proxy.example.com/v1',
    OPENAI_COMPATIBLE_MODEL: 'llama',
  });
  eq(run.status, 0, 'configure.js still starts when another provider is set');
  assert(run.output.includes('OPENAI_COMPATIBLE_API_KEY'), 'configure.js warns when a public URL has no key');
  assert(run.written.models.providers['openai-compatible'].apiKey === undefined, 'public provider is written without a key');
  eq(run.written.agents.defaults.model.primary, 'anthropic/claude-opus-4-5-20251101', 'Anthropic stays ahead of the custom provider');
}

{
  const run = runOpenAICompatibleConfigure({
    OPENAI_COMPATIBLE_BASE_URL: 'http://vllm:8000/v1',
    OPENAI_COMPATIBLE_MODEL: 'Qwen/Qwen2.5-7B-Instruct',
    OPENAI_COMPATIBLE_CONTEXT_WINDOW: '32768',
  });
  eq(run.status, 0, 'configure.js accepts a vLLM endpoint');
  const provider = run.written.models.providers['openai-compatible'];
  eq(provider.api, 'openai-completions', 'configure.js writes openai-completions for vLLM');
  eq(provider.baseUrl, 'http://vllm:8000/v1', 'configure.js writes the vLLM base URL');
  eq(provider.apiKey, OPENAI_COMPATIBLE_BARE_HOST_API_KEY, 'configure.js writes the bare-host placeholder key');
  eq(provider.models[0], {
    id: 'Qwen/Qwen2.5-7B-Instruct',
    name: 'Qwen/Qwen2.5-7B-Instruct',
    contextWindow: 32768,
  }, 'configure.js writes the vLLM context window');
  eq(run.written.agents.defaults.model.primary, 'openai-compatible/Qwen/Qwen2.5-7B-Instruct', 'configure.js selects the vLLM model');
  assert(run.written.memory === undefined, 'vLLM config does not write the retired memory.backend key');
}

console.log('configure.js DeepSeek');

{
  const run = runOpenAICompatibleConfigure({ DEEPSEEK_API_KEY: 'sk-deepseek-test' });
  eq(run.status, 0, 'configure.js accepts DEEPSEEK_API_KEY alone');
  eq(run.written.agents.defaults.model.primary, 'deepseek/deepseek-v4-pro', 'DeepSeek auto primary is deepseek-v4-pro');
  assert(
    !run.written.models || !run.written.models.providers || !run.written.models.providers.deepseek,
    'DeepSeek is not written under models.providers',
  );
  assert(run.output.includes('DeepSeek provider enabled'), 'configure.js logs that DeepSeek is enabled');
  assert(!run.output.includes('sk-deepseek-test'), 'configure.js does not log the DeepSeek key');
}

{
  const run = runOpenAICompatibleConfigure({
    OPENAI_COMPATIBLE_API_KEY: SECRET,
    OPENAI_COMPATIBLE_BASE_URL: 'http://litellm:4000/v1/',
    OPENAI_COMPATIBLE_MODEL: 'gpt-4o-mini',
    OPENAI_COMPATIBLE_CONTEXT_WINDOW: 'nope',
  }, {
    models: {
      providers: {
        'openai-compatible': {
          api: 'openai-completions',
          baseUrl: 'http://old.example/v1',
          models: [
            { id: 'claude-sonnet', name: 'Claude', contextWindow: 200000 },
            { id: 'gpt-4o-mini', name: 'GPT-4o mini', contextWindow: 128000 },
          ],
        },
      },
    },
  });
  eq(run.status, 0, 'configure.js accepts a LiteLLM proxy');
  const provider = run.written.models.providers['openai-compatible'];
  eq(provider.baseUrl, 'http://litellm:4000/v1', 'configure.js writes the LiteLLM base URL');
  eq(provider.apiKey, SECRET, 'configure.js writes the LiteLLM master key');
  eq(provider.models.map((model) => model.id), ['claude-sonnet', 'gpt-4o-mini'], 'configure.js keeps the extra LiteLLM model');
  eq(provider.models[0].contextWindow, 200000, 'configure.js leaves the extra model context window');
  eq(provider.models[1].contextWindow, 128000, 'invalid context window does not replace the LiteLLM model window');
  assert(run.output.includes('OPENAI_COMPATIBLE_CONTEXT_WINDOW'), 'configure.js warns on a bad context window');
  assert(!run.output.includes(SECRET), 'configure.js does not log the LiteLLM key');
}

console.log('configure.js memory slot');

{
  const run = runOpenAICompatibleConfigure({
    ANTHROPIC_API_KEY: 'test-key',
  });
  eq(run.status, 0, 'configure.js succeeds without a memory backend');
  assert(run.written.plugins === undefined, 'unset memory backend does not write plugins');
  assert(run.written.memory === undefined, 'unset memory backend does not write memory.backend');
}

{
  const run = runOpenAICompatibleConfigure({
    ANTHROPIC_API_KEY: 'test-key',
    OPENCLAW_MEMORY_BACKEND: 'memory-core',
  }, {
    plugins: {
      slots: { contextEngine: 'legacy' },
      entries: { 'memory-wiki': { enabled: true } },
    },
    memory: { citations: 'on' },
  });
  eq(run.status, 0, 'configure.js accepts memory-core');
  eq(run.written.plugins.slots.memory, 'memory-core', 'configure.js writes plugins.slots.memory');
  eq(run.written.plugins.slots.contextEngine, 'legacy', 'configure.js keeps the other slot');
  eq(run.written.plugins.entries['memory-wiki'], { enabled: true }, 'configure.js keeps plugin entries');
  eq(run.written.memory, { citations: 'on' }, 'configure.js does not replace memory.search settings');
  assert(run.written.memory.backend === undefined, 'configure.js does not write memory.backend');
}

{
  const run = runOpenAICompatibleConfigure({
    ANTHROPIC_API_KEY: 'test-key',
    OPENCLAW_MEMORY_BACKEND: 'builtin',
  });
  eq(run.written.plugins.slots.memory, 'memory-core', 'builtin maps to memory-core');
}

{
  const run = runOpenAICompatibleConfigure({
    ANTHROPIC_API_KEY: 'test-key',
    OPENCLAW_MEMORY_BACKEND: 'none',
  });
  eq(run.written.plugins.slots.memory, 'none', 'none is written as the memory slot');
}

{
  const run = runOpenAICompatibleConfigure({
    ANTHROPIC_API_KEY: 'test-key',
    OPENCLAW_MEMORY_BACKEND: 'qmd',
  }, {
    plugins: { slots: { memory: 'memory-lancedb' } },
  });
  eq(run.status, 0, 'retired qmd does not fail configure.js');
  eq(run.written.plugins.slots.memory, 'memory-lancedb', 'qmd leaves the existing memory slot');
  assert(run.written.memory === undefined || run.written.memory.backend === undefined, 'qmd does not write memory.backend');
  assert(run.output.includes('retired'), 'qmd warning says the backend is retired');
  assert(run.output.includes('plugins.slots.memory'), 'qmd warning names the current key');
}

{
  const run = runOpenAICompatibleConfigure({
    GEMINI_API_KEY: 'gemini-test',
    DEEPSEEK_API_KEY: 'sk-deepseek-test',
  });
  eq(run.status, 0, 'configure.js accepts Gemini and DeepSeek together');
  eq(run.written.agents.defaults.model.primary, 'google/gemini-3-pro', 'Gemini stays ahead of DeepSeek');
}

console.log('entrypoint DeepSeek provider gate');

function runEntrypointProviderLoop(env) {
  const entrypoint = fs.readFileSync(path.join(__dirname, 'entrypoint.sh'), 'utf8');
  const start = entrypoint.indexOf('HAS_PROVIDER=0\nfor key in');
  const end = entrypoint.indexOf('# Base URL and model are both required');
  if (start < 0 || end < 0) {
    throw new Error('provider loop markers missing from entrypoint.sh');
  }
  const result = spawnSync(
    'bash',
    ['-c', `set -euo pipefail\n${entrypoint.slice(start, end)}\nprintf 'HAS_PROVIDER=%s\\n' "$HAS_PROVIDER"\n`],
    { encoding: 'utf8', env: { ...env, PATH: process.env.PATH } },
  );
  return { status: result.status, output: `${result.stdout || ''}\n${result.stderr || ''}` };
}

{
  const run = runEntrypointProviderLoop({ DEEPSEEK_API_KEY: 'sk-deepseek-test' });
  eq(run.status, 0, 'entrypoint provider loop runs');
  assert(run.output.includes('HAS_PROVIDER=1'), 'DEEPSEEK_API_KEY alone counts as a provider');
  assert(!run.output.includes('sk-deepseek-test'), 'entrypoint provider loop does not print the key');
}

{
  const run = runEntrypointProviderLoop({});
  assert(run.output.includes('HAS_PROVIDER=0'), 'the provider loop stays closed with no keys');
}

// The entrypoint gate must use the helper, not a warning that always names both.
console.log('entrypoint OpenAI-compatible gate');

function runEntrypointOpenAIGate(env) {
  const entrypoint = fs.readFileSync(path.join(__dirname, 'entrypoint.sh'), 'utf8');
  const start = entrypoint.indexOf('# >>> openai-compatible-gate');
  const end = entrypoint.indexOf('# <<< openai-compatible-gate');
  if (start < 0 || end < 0) {
    throw new Error('openai-compatible gate markers missing from entrypoint.sh');
  }
  const result = spawnSync(
    'bash',
    ['-c', `set -euo pipefail\nHAS_PROVIDER=0\n${entrypoint.slice(start, end)}\nprintf 'HAS_PROVIDER=%s\\n' "$HAS_PROVIDER"\n`],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        OPENCLAW_UTILS_JS: path.join(__dirname, 'utils.js'),
        ...env,
      },
    },
  );
  return {
    status: result.status,
    output: `${result.stdout || ''}\n${result.stderr || ''}`,
  };
}

{
  const run = runEntrypointOpenAIGate({
    OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1:8000/v1',
  });
  eq(run.status, 0, 'entrypoint gate exits 0 when only the model is missing');
  assert(run.output.includes('[entrypoint] WARNING:'), 'entrypoint gate prints a warning');
  assert(run.output.includes('OPENAI_COMPATIBLE_MODEL is required'), 'entrypoint gate names the missing model');
  assert(!run.output.includes('OPENAI_COMPATIBLE_BASE_URL'), 'entrypoint gate does not name the set base URL');
  assert(run.output.includes('HAS_PROVIDER=0'), 'a missing model does not count as a provider');
}

{
  const run = runEntrypointOpenAIGate({
    OPENAI_COMPATIBLE_MODEL: 'llama',
  });
  eq(run.status, 0, 'entrypoint gate exits 0 when only the base URL is missing');
  assert(run.output.includes('OPENAI_COMPATIBLE_BASE_URL is required'), 'entrypoint gate names the missing base URL');
  assert(!run.output.includes('OPENAI_COMPATIBLE_MODEL'), 'entrypoint gate does not name the set model');
  assert(run.output.includes('HAS_PROVIDER=0'), 'a missing base URL does not count as a provider');
}

{
  const run = runEntrypointOpenAIGate({
    OPENAI_COMPATIBLE_API_KEY: SECRET,
  });
  eq(run.status, 0, 'entrypoint gate exits 0 when only the API key is set');
  assert(run.output.includes('OPENAI_COMPATIBLE_BASE_URL'), 'entrypoint gate names the missing base URL when only the key is set');
  assert(run.output.includes('OPENAI_COMPATIBLE_MODEL'), 'entrypoint gate names the missing model when only the key is set');
  assert(!run.output.includes(SECRET), 'entrypoint gate does not print the API key');
  assert(run.output.includes('HAS_PROVIDER=0'), 'an API key alone does not count as a provider');
}

{
  const run = runEntrypointOpenAIGate({
    OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1:8000/v1',
    OPENAI_COMPATIBLE_MODEL: 'local-model',
  });
  eq(run.status, 0, 'entrypoint gate exits 0 when base URL and model are set');
  assert(!run.output.includes('WARNING'), 'entrypoint gate does not warn when the provider is complete');
  assert(run.output.includes('HAS_PROVIDER=1'), 'base URL and model count as a provider');
}

{
  const run = runEntrypointOpenAIGate({});
  eq(run.status, 0, 'entrypoint gate exits 0 when no OpenAI-compatible var is set');
  assert(!run.output.includes('WARNING'), 'entrypoint gate stays quiet when the provider is absent');
  assert(run.output.includes('HAS_PROVIDER=0'), 'absent OpenAI-compatible vars do not count as a provider');
}

// ── Gateway token charset ───────────────────────────────────────────────────
// nginx interpolates the token into double quotes. The entrypoint rejects a
// value outside ^[A-Za-z0-9._~-]+$ before that config is generated.

console.log('gateway token charset');

const HEX_GATEWAY_TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

eq(GATEWAY_TOKEN_PATTERN.source, '^[A-Za-z0-9._~-]+$', 'gateway token pattern is the unreserved set');
eq(
  GATEWAY_TOKEN_ALLOWED_CHARACTERS,
  'A-Z, a-z, 0-9, and . _ ~ -',
  'allowed-character text names letters, digits, and . _ ~ -',
);
eq(classifyGatewayToken(HEX_GATEWAY_TOKEN), 'ok', '64-char hex token is valid');
eq(classifyGatewayToken('my-secret-token'), 'ok', 'documented placeholder my-secret-token is valid');
eq(classifyGatewayToken('Az9._~-'), 'ok', 'every allowed symbol is valid');
eq(classifyGatewayToken('bad"quote'), 'invalid', 'a double quote is rejected');
eq(classifyGatewayToken('bad token'), 'invalid', 'a space is rejected');
eq(classifyGatewayToken('bad$token'), 'invalid', 'a dollar sign is rejected');
eq(classifyGatewayToken(''), 'empty', 'an empty string is empty');
eq(classifyGatewayToken(undefined), 'empty', 'an unset token is empty');
eq(classifyGatewayToken('   '), 'invalid', 'whitespace is not trimmed into a valid token');
for (const bad of ['a\\b', 'a;b', 'a{b', 'a}b', "a'b", 'a`b', 'tok+en', 'tok/en', 'tok=en']) {
  eq(classifyGatewayToken(bad), 'invalid', `nginx-special or base64 character is rejected (${JSON.stringify(bad)})`);
}
assert(
  !gatewayTokenError('invalid', '[entrypoint]').includes('bad"quote'),
  'the charset error helper has no token parameter to leak',
);
assert(
  gatewayTokenError('invalid', '[entrypoint]').includes('OPENCLAW_GATEWAY_TOKEN'),
  'charset error names OPENCLAW_GATEWAY_TOKEN',
);
assert(
  gatewayTokenError('invalid', '[entrypoint]').includes(GATEWAY_TOKEN_ALLOWED_CHARACTERS),
  'charset error lists the allowed characters',
);
assert(
  gatewayTokenError('empty', '[entrypoint]').includes('openssl rand -hex 32'),
  'empty-token error suggests openssl rand -hex 32',
);

{
  const generated = spawnSync('openssl', ['rand', '-hex', '32'], { encoding: 'utf8' });
  eq(generated.status, 0, 'openssl rand -hex 32 runs');
  const hex = (generated.stdout || '').trim();
  eq(hex.length, 64, 'openssl rand -hex 32 is 64 hex characters');
  eq(/^[0-9a-f]+$/.test(hex), true, 'openssl hex output is only hex digits');
  eq(classifyGatewayToken(hex), 'ok', 'openssl rand -hex 32 matches the gateway token pattern');
}

function runEntrypointGatewayToken(token, { unset = false } = {}) {
  const entrypoint = fs.readFileSync(path.join(__dirname, 'entrypoint.sh'), 'utf8');
  const start = entrypoint.indexOf('# >>> gateway-token-gate');
  const end = entrypoint.indexOf('# <<< gateway-token-gate');
  const nginxStart = entrypoint.indexOf('# ── Generate nginx config');
  const storageStart = entrypoint.indexOf('setting up persistent tool storage');
  if (start < 0 || end < start) {
    throw new Error('gateway token gate markers missing from entrypoint.sh');
  }
  if (!(end < nginxStart)) {
    throw new Error('gateway token gate is not before nginx config generation');
  }
  if (!(end < storageStart)) {
    throw new Error('gateway token gate is not before volume setup');
  }
  const gate = entrypoint.slice(start, end);
  if (!gate.includes('^[A-Za-z0-9._~-]+$')) {
    throw new Error('entrypoint gate does not use the gateway token pattern');
  }
  const nginxEnd = entrypoint.indexOf('# ── Start nginx');
  const nginxSection = entrypoint.slice(nginxStart, nginxEnd);
  const insertions = nginxSection.match(/\$\{GATEWAY_TOKEN\}/g) || [];
  if (insertions.length !== 6) {
    throw new Error(`expected 6 nginx GATEWAY_TOKEN insertions, found ${insertions.length}`);
  }
  const outside = entrypoint.replace(nginxSection, '').match(/\$\{GATEWAY_TOKEN\}/g);
  if (outside) {
    throw new Error('GATEWAY_TOKEN is interpolated outside the nginx config section');
  }
  const healthzStart = nginxSection.indexOf('location = /healthz');
  const healthzEnd = nginxSection.indexOf('location @healthz_fallback');
  if (healthzStart < 0 || healthzEnd < healthzStart || nginxSection.slice(healthzStart, healthzEnd).includes('GATEWAY_TOKEN')) {
    throw new Error('healthz location interpolates the gateway token');
  }
  const env = { PATH: process.env.PATH };
  if (!unset) env.OPENCLAW_GATEWAY_TOKEN = token;
  const result = spawnSync(
    'bash',
    ['-c', `set -euo pipefail\n${gate}\nprintf 'GATEWAY_TOKEN_OK\\n'`],
    { encoding: 'utf8', env },
  );
  return {
    status: result.status,
    output: `${result.stdout || ''}\n${result.stderr || ''}`,
  };
}

{
  const run = runEntrypointGatewayToken(HEX_GATEWAY_TOKEN);
  eq(run.status, 0, 'entrypoint accepts a hex gateway token');
  assert(run.output.includes('GATEWAY_TOKEN_OK'), 'hex token continues past the gate');
  assert(!run.output.includes(HEX_GATEWAY_TOKEN), 'entrypoint does not print a valid gateway token');
  assert(!run.output.includes('ERROR'), 'hex token does not log an error');
}

{
  const token = 'bad"quote';
  const run = runEntrypointGatewayToken(token);
  assert(run.status !== 0, 'entrypoint rejects a gateway token that contains a quote');
  assert(
    run.output.includes(gatewayTokenError('invalid', '[entrypoint]')),
    'quote-token error names OPENCLAW_GATEWAY_TOKEN, lists allowed characters, and suggests openssl',
  );
  assert(!run.output.includes(token), 'entrypoint does not print a quoted gateway token');
  assert(!run.output.includes('GATEWAY_TOKEN_OK'), 'a quoted token exits before nginx config is generated');
  assert(!run.output.includes('unexpected'), 'a quoted token does not reach an nginx unexpected error');
}

{
  const token = 'bad token';
  const run = runEntrypointGatewayToken(token);
  assert(run.status !== 0, 'entrypoint rejects a gateway token that contains a space');
  assert(run.output.includes(gatewayTokenError('invalid', '[entrypoint]')), 'space-token error lists the allowed characters');
  assert(!run.output.includes(token), 'entrypoint does not print a gateway token that contains a space');
  assert(!run.output.includes('GATEWAY_TOKEN_OK'), 'a space token exits before nginx config is generated');
}

{
  const token = 'bad$token';
  const run = runEntrypointGatewayToken(token);
  assert(run.status !== 0, 'entrypoint rejects a gateway token that contains $');
  assert(run.output.includes(gatewayTokenError('invalid', '[entrypoint]')), 'dollar-token error lists the allowed characters');
  assert(!run.output.includes(token), 'entrypoint does not print a gateway token that contains $');
  assert(!run.output.includes('GATEWAY_TOKEN_OK'), 'a $ token exits before nginx config is generated');
}

{
  const run = runEntrypointGatewayToken('');
  assert(run.status !== 0, 'entrypoint rejects an empty gateway token');
  assert(
    run.output.includes(gatewayTokenError('empty', '[entrypoint]')),
    'empty-token error names OPENCLAW_GATEWAY_TOKEN and suggests openssl rand -hex 32',
  );
  assert(!run.output.includes('GATEWAY_TOKEN_OK'), 'an empty token exits before nginx config is generated');
}

{
  const run = runEntrypointGatewayToken(undefined, { unset: true });
  assert(run.status !== 0, 'entrypoint rejects an unset gateway token');
  assert(run.output.includes(gatewayTokenError('empty', '[entrypoint]')), 'unset token uses the required error');
}

{
  const token = 'bad"quote';
  const run = runOpenAICompatibleConfigure({
    ANTHROPIC_API_KEY: 'test-key',
    OPENCLAW_GATEWAY_TOKEN: token,
  });
  eq(run.status, 1, 'configure.js rejects a gateway token that contains a quote');
  assert(run.output.includes(gatewayTokenError('invalid', '[configure]')), 'configure.js names OPENCLAW_GATEWAY_TOKEN and the allowed characters');
  assert(!run.output.includes(token), 'configure.js does not print a quoted gateway token');
  eq(run.written, null, 'configure.js does not write a config for a quoted token');
}

{
  const token = 'bad token';
  const run = runOpenAICompatibleConfigure({ OPENCLAW_GATEWAY_TOKEN: token });
  eq(run.status, 1, 'configure.js rejects a space token before the provider check');
  assert(run.output.includes('OPENCLAW_GATEWAY_TOKEN'), 'space-token failure names the variable');
  assert(!run.output.includes('No AI provider'), 'a bad token is not reported as a missing provider');
  assert(!run.output.includes(token), 'configure.js does not print a gateway token that contains a space');
  eq(run.written, null, 'configure.js does not write a config for a space token');
}

{
  const token = 'bad$token';
  const run = runOpenAICompatibleConfigure({
    ANTHROPIC_API_KEY: 'test-key',
    OPENCLAW_GATEWAY_TOKEN: token,
  });
  eq(run.status, 1, 'configure.js rejects a gateway token that contains $');
  assert(!run.output.includes(token), 'configure.js does not print a gateway token that contains $');
  eq(run.written, null, 'configure.js does not write a config for a $ token');
}

{
  const run = runOpenAICompatibleConfigure({
    ANTHROPIC_API_KEY: 'test-key',
    OPENCLAW_GATEWAY_TOKEN: HEX_GATEWAY_TOKEN,
  });
  eq(run.status, 0, 'configure.js accepts a hex gateway token');
  eq(run.written.gateway.auth.token, HEX_GATEWAY_TOKEN, 'configure.js writes the hex token to gateway.auth.token');
  eq(run.written.gateway.auth.mode, 'token', 'configure.js keeps token auth mode');
  assert(!run.output.includes(HEX_GATEWAY_TOKEN), 'configure.js does not print a valid gateway token');
}

{
  const run = runOpenAICompatibleConfigure({
    ANTHROPIC_API_KEY: 'test-key',
    OPENCLAW_GATEWAY_TOKEN: '',
  });
  eq(run.status, 0, 'configure.js leaves an empty token for the entrypoint to reject');
  assert(
    !run.written.gateway.auth || run.written.gateway.auth.token === undefined,
    'configure.js does not invent a gateway token',
  );
}

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

// ── Compose browser sidecar SSRF ────────────────────────────────────────────

console.log('compose browser sidecar SSRF');

eq(COMPOSE_BROWSER_SIDECAR_HOSTNAME, 'browser', 'sidecar hostname is the Compose service name');

eq(cdpUrlHostname('http://browser:9223'), 'browser', 'compose CDP URL host');
eq(cdpUrlHostname('  http://Browser:9223/json/version  '), 'browser', 'host case, space, and path');
eq(cdpUrlHostname('http://browser.:9223'), 'browser', 'trailing dot on the sidecar host');
eq(cdpUrlHostname('ws://browser:9223/devtools/browser/abc'), 'browser', 'websocket CDP URL');
eq(cdpUrlHostname('http://user:pass@browser:9223'), 'browser', 'userinfo is not part of the host');
eq(cdpUrlHostname('http://browser.internal:9223'), 'browser.internal', 'suffixed name is a different host');
eq(cdpUrlHostname('http://192.168.1.10:9222'), '192.168.1.10', 'private IP literal stays an IP');
eq(cdpUrlHostname('http://[::1]:9223'), '::1', 'IPv6 brackets are stripped');
eq(cdpUrlHostname('https://chrome.example.com/json'), 'chrome.example.com', 'public CDP host');
eq(cdpUrlHostname('browser:9223'), '', 'scheme-less value is not a CDP URL');
eq(cdpUrlHostname(''), '', 'empty CDP URL');
eq(cdpUrlHostname(undefined), '', 'missing CDP URL');
eq(cdpUrlHostname('http://'), '', 'URL without a host');

eq(
  browserCdpUrls({
    cdpUrl: 'http://browser:9223',
    profiles: {
      openclaw: { cdpUrl: 'http://10.0.0.5:9222' },
      empty: {},
      skip: null,
    },
  }),
  ['http://browser:9223', 'http://10.0.0.5:9222'],
  'top-level and profile CDP URLs are both visible'
);
eq(browserCdpUrls(null), [], 'missing browser config has no CDP URLs');
eq(browserCdpUrls({ profiles: 'nope' }), [], 'non-object profiles are ignored');

eq(
  allowComposeBrowserSidecar(undefined),
  { allowedHostnames: ['browser'] },
  'new policy allowlists only the sidecar hostname'
);
assert(
  allowComposeBrowserSidecar({}).dangerouslyAllowPrivateNetwork === undefined,
  'new policy does not set dangerouslyAllowPrivateNetwork'
);
eq(
  allowComposeBrowserSidecar({
    allowRfc2544BenchmarkRange: true,
    allowedHostnames: ['keep.internal'],
  }),
  {
    allowRfc2544BenchmarkRange: true,
    allowedHostnames: ['keep.internal', 'browser'],
  },
  'existing policy fields and hostnames are kept'
);
{
  const existing = { allowedHostnames: ['Browser'] };
  eq(allowComposeBrowserSidecar(existing), existing, 'hostname match is case-insensitive and does not copy the policy');
}
eq(
  allowComposeBrowserSidecar({ allowedHostnames: '["keep.internal"]' }),
  { allowedHostnames: ['keep.internal', 'browser'] },
  'a JSON-string allowlist becomes a real array'
);
eq(
  allowComposeBrowserSidecar({ allowedHostnames: 'keep.internal' }),
  { allowedHostnames: ['keep.internal', 'browser'] },
  'a single hostname string is kept and the sidecar is appended'
);
eq(
  allowComposeBrowserSidecar({
    allowedHostnames: '["keep.internal"]',
    blockedHostnames: '["nope.internal"]',
    hostnameAllowlist: ['not-in-schema'],
    dangerouslyAllowPrivateNetwork: 'true',
  }),
  { allowedHostnames: ['keep.internal', 'browser'], blockedHostnames: ['nope.internal'] },
  'doctor-facing policy is schema keys only, with hostname lists as arrays'
);
{
  const strict = { allowedHostnames: ['browser'], blockedHostnames: [] };
  eq(allowComposeBrowserSidecar(strict), strict, 'a strict policy that already allows the sidecar is not copied');
}

eq(
  resolveComposeBrowserSidecarSsrF({ cdpUrl: 'http://10.1.2.3:9222' }, undefined),
  { action: 'skip' },
  'a private IP CDP URL does not auto-allow'
);
eq(
  resolveComposeBrowserSidecarSsrF({ cdpUrl: 'https://chrome.example.com' }, undefined),
  { action: 'skip' },
  'a public CDP URL does not auto-allow'
);
eq(
  resolveComposeBrowserSidecarSsrF({ cdpUrl: 'http://browser.internal:9223' }, undefined),
  { action: 'skip' },
  'a lookalike hostname does not auto-allow'
);
for (const [url, label] of [
  ['http://127.0.0.1:9222', 'loopback literal'],
  ['http://localhost:9222', 'localhost'],
  ['http://169.254.169.254/', 'cloud metadata address'],
  ['http://172.17.0.2:9223', 'RFC1918 literal'],
  ['http://100.64.1.5:9223', 'CGNAT literal'],
  ['http://[fd00::1]:9223', 'IPv6 ULA literal'],
  ['http://host.docker.internal:9223', 'host.docker.internal'],
  ['http://browser.local:9223', '.local name'],
  ['http://chrome:9223', 'a single-label name other than browser'],
  ['http://1.1.1.1:9222', 'public IP literal'],
  ['http://browser.lan:9223', 'dotted private name'],
]) {
  eq(
    resolveComposeBrowserSidecarSsrF({ cdpUrl: url }, undefined),
    { action: 'skip' },
    `${label} does not auto-allow`
  );
}
eq(
  resolveComposeBrowserSidecarSsrF(undefined, undefined),
  { action: 'skip' },
  'no browser config does not auto-allow'
);
eq(
  resolveComposeBrowserSidecarSsrF({ cdpUrl: 'http://browser:9223' }, 'false').action,
  'opt-out',
  'false opts out of the sidecar allowance'
);
eq(
  resolveComposeBrowserSidecarSsrF({ cdpUrl: 'http://browser:9223' }, '0').action,
  'opt-out',
  '0 opts out of the sidecar allowance'
);
eq(
  resolveComposeBrowserSidecarSsrF({ cdpUrl: 'http://browser:9223' }, 'FALSE').action,
  'allow',
  'only the exact values false and 0 opt out'
);
{
  const decision = resolveComposeBrowserSidecarSsrF({
    cdpUrl: 'http://browser:9223',
    ssrfPolicy: { blockedHostnames: ['Browser'], allowedHostnames: ['keep.internal'] },
  }, undefined);
  eq(decision, { action: 'blocked' }, 'blockedHostnames wins over the automatic allowance');
}
{
  const policy = { allowedHostnames: ['browser'], dangerouslyAllowPrivateNetwork: false };
  const decision = resolveComposeBrowserSidecarSsrF({
    profiles: { openclaw: { cdpUrl: 'http://browser:9223' } },
    ssrfPolicy: policy,
  }, undefined);
  eq(decision.action, 'already', 'a profile CDP URL counts, and an existing allowlist is kept');
  eq(decision.ssrfPolicy, policy, 'already-allowed policy object is unchanged');
}

// Same rule OpenClaw applies after an exact hostname is trusted: RFC1918 answers
// are usable, and link-local / metadata addresses stay blocked unless the broad
// private-network flag is set. This guards the config shape, not the upstream module.
function sidecarCdpDecision(hostname, address, policy) {
  const allowed = ((policy && policy.allowedHostnames) || []).map((host) =>
    String(host).trim().toLowerCase().replace(/\.+$/, '')
  );
  const broad = !!(policy && policy.dangerouslyAllowPrivateNetwork === true);
  const trusted = broad || allowed.includes(hostname);
  const metadataOrLinkLocal = address.startsWith('169.254.') || address === '169.254.169.254';
  const loopback = address === '127.0.0.1' || address === '::1';
  const rfc1918 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(address);
  if (!trusted) return (rfc1918 || metadataOrLinkLocal || loopback) ? 'blocked' : 'open';
  if (broad) return 'open';
  if (metadataOrLinkLocal || loopback) return 'blocked';
  return 'open';
}

{
  const policy = allowComposeBrowserSidecar(undefined);
  eq(sidecarCdpDecision('browser', '172.18.0.4', policy), 'open', 'sidecar RFC1918 address is reachable once the hostname is allowed');
  eq(sidecarCdpDecision('browser', '192.168.64.3', {}), 'blocked', 'without the allowlist the same private address is rejected');
  eq(sidecarCdpDecision('browser', '169.254.169.254', policy), 'blocked', 'metadata address stays blocked under the hostname allowance');
  eq(sidecarCdpDecision('other', '10.0.0.5', policy), 'blocked', 'a different private host is still blocked');
  assert(policy.dangerouslyAllowPrivateNetwork !== true, 'the decision fixture does not use the broad private-network flag');
}

function runBrowserConfigure(env, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-browser-ssrf-'));
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
        ANTHROPIC_API_KEY: 'test-key',
        OPENCLAW_STATE_DIR: dir,
        OPENCLAW_WORKSPACE_DIR: path.join(dir, 'workspace'),
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_CUSTOM_CONFIG: files.custom !== undefined
          ? customPath
          : path.join(dir, 'missing-custom.json'),
        ...env,
      },
    });
    assert(result.status === 0, `configure.js browser SSRF exits 0 (${JSON.stringify(env)})`);
    if (result.status !== 0) {
      console.error(result.stdout);
      console.error(result.stderr);
      return null;
    }
    return {
      config: JSON.parse(fs.readFileSync(configPath, 'utf8')),
      output: `${result.stdout || ''}\n${result.stderr || ''}`,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function browserPolicyOf(written) {
  return written && written.config && written.config.browser && written.config.browser.ssrfPolicy;
}

{
  const written = runBrowserConfigure({
    BROWSER_CDP_URL: 'http://browser:9223',
    BROWSER_DEFAULT_PROFILE: 'openclaw',
  });
  eq(written && written.config.browser.cdpUrl, 'http://browser:9223', 'configure.js writes the Compose CDP URL');
  eq(written && written.config.browser.defaultProfile, 'openclaw', 'configure.js keeps the default profile');
  eq(browserPolicyOf(written), { allowedHostnames: ['browser'] }, 'configure.js allowlists only hostname browser');
  assert(
    Array.isArray(browserPolicyOf(written).allowedHostnames),
    'configure.js writes allowedHostnames as an array so doctor --fix keeps it'
  );
  assert(
    written && written.output.includes('Compose sidecar hostname "browser" allowed'),
    'configure.js logs the narrow SSRF allowance',
  );
  assert(
    written && !written.output.includes('dangerouslyAllowPrivateNetwork'),
    'configure.js does not log the broad private-network flag',
  );
}

{
  const written = runBrowserConfigure({
    BROWSER_CDP_URL: 'http://browser:9223',
    BROWSER_EVALUATE_ENABLED: 'true',
  });
  eq(written && written.config.browser.evaluateEnabled, true, 'configure.js still writes evaluateEnabled');
  eq(browserPolicyOf(written), { allowedHostnames: ['browser'] }, 'evaluateEnabled does not change the SSRF allowance');
}
{
  const written = runBrowserConfigure({ BROWSER_CDP_URL: 'http://192.168.1.10:9222' });
  assert(browserPolicyOf(written) === undefined, 'a private IP CDP URL does not gain an SSRF policy');
}
{
  const written = runBrowserConfigure({ BROWSER_CDP_URL: 'http://169.254.169.254/' });
  assert(browserPolicyOf(written) === undefined, 'the metadata address does not gain an SSRF policy');
}
{
  const written = runBrowserConfigure({ BROWSER_CDP_URL: 'http://chrome:9223' });
  assert(browserPolicyOf(written) === undefined, 'another single-label Docker name does not gain an SSRF policy');
}
{
  const written = runBrowserConfigure({ BROWSER_CDP_URL: 'http://host.docker.internal:9223' });
  assert(browserPolicyOf(written) === undefined, 'host.docker.internal does not gain an SSRF policy');
}
{
  const written = runBrowserConfigure({ BROWSER_CDP_URL: 'https://chrome.browserless.io' });
  assert(browserPolicyOf(written) === undefined, 'a public CDP URL does not gain an SSRF policy');
}
{
  const written = runBrowserConfigure({ BROWSER_CDP_URL: 'http://browser.example.com:9223' });
  assert(browserPolicyOf(written) === undefined, 'a public lookalike host does not gain an SSRF policy');
}
{
  const written = runBrowserConfigure({});
  assert(!written || !written.config.browser, 'browser config stays absent when CDP is unset');
}

{
  const written = runBrowserConfigure({
    BROWSER_CDP_URL: 'http://Browser:9223/',
    'OPENCLAW__browser__ssrfPolicy__allowedHostnames[]': 'other.internal, browser',
    'OPENCLAW__browser__ssrfPolicy__allowRfc2544BenchmarkRange': 'true',
  });
  eq(
    browserPolicyOf(written),
    { allowedHostnames: ['other.internal', 'browser'], allowRfc2544BenchmarkRange: true },
    'dot-notation hostnames are kept and the broad flag is not added',
  );
}

{
  const written = runBrowserConfigure({
    BROWSER_CDP_URL: 'http://browser:9223',
    'OPENCLAW__browser__ssrfPolicy__allowedHostnames': '["keep.internal"]',
    'OPENCLAW__browser__ssrfPolicy__dangerouslyAllowPrivateNetwork': 'true',
  });
  eq(
    browserPolicyOf(written),
    { allowedHostnames: ['keep.internal', 'browser'], dangerouslyAllowPrivateNetwork: true },
    'a JSON-string allowlist is merged, and an explicit broad opt-in is preserved',
  );
  assert(
    Array.isArray(browserPolicyOf(written).allowedHostnames),
    'the merged allowlist is an array',
  );
}

{
  const written = runBrowserConfigure({}, {
    custom: {
      browser: {
        profiles: { openclaw: { cdpUrl: 'http://browser:9223' } },
        ssrfPolicy: { allowedHostnames: ['from-json'], dangerouslyAllowPrivateNetwork: false },
      },
    },
  });
  eq(
    written && written.config.browser.profiles.openclaw.cdpUrl,
    'http://browser:9223',
    'a profile-only CDP URL is preserved',
  );
  eq(
    browserPolicyOf(written),
    { allowedHostnames: ['from-json', 'browser'], dangerouslyAllowPrivateNetwork: false },
    'custom JSON policy is merged and an explicit false broad flag stays false',
  );
}

{
  const written = runBrowserConfigure({
    BROWSER_CDP_URL: 'http://browser:9223',
    OPENCLAW_CONFIG_JSON: JSON.stringify({ browser: { cdpUrl: 'http://203.0.113.5:9222' } }),
  });
  eq(written && written.config.browser.cdpUrl, 'http://203.0.113.5:9222', 'OPENCLAW_CONFIG_JSON cdpUrl overrides the env URL');
  assert(browserPolicyOf(written) === undefined, 'the sidecar allowance follows the effective CDP URL');
}

{
  const written = runBrowserConfigure({
    BROWSER_CDP_URL: 'http://browser:9223',
    BROWSER_SSRF_ALLOW_COMPOSE_SIDECAR: 'false',
  });
  eq(written && written.config.browser.cdpUrl, 'http://browser:9223', 'opt-out still writes the CDP URL');
  assert(browserPolicyOf(written) === undefined, 'opt-out does not write an SSRF policy');
  assert(
    written && written.output.includes('BROWSER_SSRF_ALLOW_COMPOSE_SIDECAR=false'),
    'opt-out is logged',
  );
}

{
  const written = runBrowserConfigure({
    BROWSER_CDP_URL: 'http://browser:9223',
    BROWSER_SSRF_ALLOW_COMPOSE_SIDECAR: '0',
  });
  assert(browserPolicyOf(written) === undefined, '0 opts out inside configure.js');
}

{
  const written = runBrowserConfigure(
    { BROWSER_CDP_URL: 'http://browser:9223' },
    { custom: { browser: { ssrfPolicy: { blockedHostnames: ['browser'] } } } },
  );
  eq(
    browserPolicyOf(written),
    { blockedHostnames: ['browser'] },
    'a blocked sidecar hostname is not added to allowedHostnames',
  );
  assert(
    written && written.output.includes('listed in blockedHostnames'),
    'the block is logged',
  );
}

{
  const first = {
    browser: {
      cdpUrl: 'http://browser:9223',
      ssrfPolicy: { allowedHostnames: ['browser', 'browser'] },
    },
  };
  const written = runBrowserConfigure(
    { BROWSER_CDP_URL: 'http://browser:9223' },
    { persisted: first },
  );
  eq(
    browserPolicyOf(written).allowedHostnames,
    ['browser', 'browser'],
    'a second start does not append another browser hostname',
  );
}

{
  const written = runBrowserConfigure(
    { BROWSER_CDP_URL: 'https://chrome.example.com' },
    {
      persisted: {
        browser: {
          cdpUrl: 'http://browser:9223',
          ssrfPolicy: { allowedHostnames: ['browser'] },
        },
      },
    },
  );
  eq(written && written.config.browser.cdpUrl, 'https://chrome.example.com', 'a later CDP URL replaces the sidecar URL');
  eq(
    browserPolicyOf(written),
    { allowedHostnames: ['browser'] },
    'a hostname saved on a previous start is left in place',
  );
}

// ── Results ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
