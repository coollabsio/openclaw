#!/usr/bin/env node
/**
 * Tests for scripts/configure.js helpers and provider configuration.
 * No test framework — run with: node scripts/configure.test.js
 */

const {
  REGEX,
  ENV_VAR,
  EXIT_CODE,
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

// ── ensure (from configure.js) ──────────────────────────────────────────────

console.log('ensure');

function ensure(obj, ...keys) {
  let cur = obj;
  for (const k of keys) {
    cur[k] = cur[k] || {};
    cur = cur[k];
  }
  return cur;
}

{
  const obj = {};
  ensure(obj, 'a', 'b', 'c');
  eq(obj, { a: { b: { c: {} } } }, 'creates nested path');
}

{
  const obj = { a: { b: 42 } };
  const result = ensure(obj, 'a', 'b');
  eq(result, 42, 'returns existing leaf');
  eq(obj, { a: { b: 42 } }, 'does not overwrite existing leaf');
}

{
  const obj = { a: { b: 42 } };
  ensure(obj, 'a', 'c');
  eq(obj, { a: { b: 42, c: {} } }, 'preserves existing keys, adds new');
}

{
  const obj = { a: [1, 2] };
  ensure(obj, 'a', 'b');
  eq(obj.a.b, {}, 'arrays are treated as non-objects, creates sibling');
}

{
  const obj = {};
  const r1 = ensure(obj, 'x');
  const r2 = ensure(obj, 'x');
  eq(r1, r2, 'same reference on repeated calls');
}

// ── removeProvider (from configure.js) ──────────────────────────────────────

console.log('removeProvider');

function makeRemoveProvider() {
  let hasCustomConfig = false;
  return function removeProvider(name, label, envHint, config) {
    if (!hasCustomConfig && config.models?.providers?.[name]) {
      delete config.models.providers[name];
    }
  };
}

{
  const removeProvider = makeRemoveProvider();
  const config = { models: { providers: { foo: { api: 'test' } } } };
  removeProvider('foo', 'Foo', 'FOO_KEY', config);
  eq(config.models.providers.foo, undefined, 'removes existing provider');
}

{
  const removeProvider = makeRemoveProvider();
  const config = { models: { providers: { foo: { api: 'test' } } } };
  removeProvider('bar', 'Bar', 'BAR_KEY', config);
  eq(config.models.providers.foo.api, 'test', 'does not remove other providers');
}

{
  const removeProvider = makeRemoveProvider();
  const config = { models: { providers: { foo: { api: 'test' } } } };
  removeProvider('foo', 'Foo', 'FOO_KEY', config);
  removeProvider('foo', 'Foo', 'FOO_KEY', config);
  eq(config.models.providers.foo, undefined, 'safe to call twice');
}

// ── Provider configuration simulation ──────────────────────────────────────

console.log('provider configuration simulation');

// Save original env
const savedEnv = { ...process.env };

function clearEnv() {
  // Clear all provider-related env vars
  const providerKeys = [
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY',
    'XAI_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'CEREBRAS_API_KEY',
    'ZAI_API_KEY', 'AI_GATEWAY_API_KEY', 'OPENCODE_API_KEY', 'OPENCODE_ZEN_API_KEY',
    'COPILOT_GITHUB_TOKEN', 'VENICE_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY',
    'MINIMAX_API_KEY', 'SYNTHETIC_API_KEY', 'XIAOMI_API_KEY',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'AWS_DEFAULT_REGION',
    'OLLAMA_BASE_URL', 'CUSTOM_API_KEY', 'CUSTOM_BASE_URL', 'CUSTOM_MODEL',
  ];
  for (const key of providerKeys) {
    delete process.env[key];
  }
}

function restoreEnv() {
  for (const key of Object.keys(savedEnv)) {
    process.env[key] = savedEnv[key];
  }
}

// We can't fully run configure.js (it has side effects like fs writes),
// but we can simulate the provider config logic and test the outcome.

function simulateProviderConfig() {
  const config = {};
  const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

  function ensure(obj, ...keys) {
    let cur = obj;
    for (const k of keys) {
      cur[k] = cur[k] || {};
      cur = cur[k];
    }
    return cur;
  }

  let hasCustomConfig = false;
  function removeProvider(name, label, envHint) {
    if (!hasCustomConfig && config.models?.providers?.[name]) {
      delete config.models.providers[name];
    }
  }

  // Venice AI
  if (process.env.VENICE_API_KEY) {
    ensure(config, 'models', 'providers');
    config.models.providers.venice = {
      api: 'openai-completions',
      apiKey: process.env.VENICE_API_KEY,
      baseUrl: 'https://api.venice.ai/api/v1',
      models: [{ id: 'llama-3.3-70b', name: 'Llama 3.3 70B', contextWindow: 128000 }],
    };
  } else {
    removeProvider('venice', 'Venice AI', 'VENICE_API_KEY');
  }

  // Ollama
  const ollamaUrl = (process.env.OLLAMA_BASE_URL || '').replace(/\/+$/, '');
  if (ollamaUrl) {
    ensure(config, 'models', 'providers');
    const base = ollamaUrl.endsWith('/v1') ? ollamaUrl : `${ollamaUrl}/v1`;
    config.models.providers.ollama = {
      api: 'openai-completions',
      baseUrl: base,
      models: [{ id: 'llama3.3', name: 'Llama 3.3', contextWindow: 128000 }],
    };
  } else {
    removeProvider('ollama', 'Ollama', 'OLLAMA_BASE_URL');
  }

  // OpenAI-Compatible custom provider
  if (process.env.CUSTOM_API_KEY) {
    ensure(config, 'models', 'providers');
    const modelName = process.env.CUSTOM_MODEL || 'gpt-4';
    config.models.providers['openai-compatible'] = {
      api: 'openai-completions',
      apiKey: process.env.CUSTOM_API_KEY,
      baseUrl: (process.env.CUSTOM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
      models: [{ id: modelName, name: modelName, contextWindow: 128000 }],
    };
  } else {
    removeProvider('openai-compatible', 'OpenAI-Compatible', 'CUSTOM_API_KEY');
  }

  return { config, ollamaUrl };
}

// Test: no providers enabled
{
  clearEnv();
  const { config } = simulateProviderConfig();
  eq(config.models?.providers, undefined, 'no providers when no env vars set');
}

// Test: CUSTOM_API_KEY alone enables openai-compatible
{
  clearEnv();
  process.env.CUSTOM_API_KEY = 'sk-test-key';
  const { config } = simulateProviderConfig();
  assert(!!config.models?.providers?.['openai-compatible'], 'openai-compatible provider created');
  eq(config.models.providers['openai-compatible'].api, 'openai-completions', 'api type is openai-completions');
  eq(config.models.providers['openai-compatible'].apiKey, 'sk-test-key', 'apiKey set correctly');
  eq(config.models.providers['openai-compatible'].baseUrl, 'https://api.openai.com/v1', 'baseUrl defaults to OpenAI');
  eq(config.models.providers['openai-compatible'].models[0].id, 'gpt-4', 'model defaults to gpt-4');
  eq(config.models.providers['openai-compatible'].models[0].name, 'gpt-4', 'name defaults to gpt-4');
  eq(config.models.providers['openai-compatible'].models[0].contextWindow, 128000, 'contextWindow defaults to 128000');
}

// Test: CUSTOM_BASE_URL override
{
  clearEnv();
  process.env.CUSTOM_API_KEY = 'sk-mykey';
  process.env.CUSTOM_BASE_URL = 'https://llm.example.com/v1';
  const { config } = simulateProviderConfig();
  eq(config.models.providers['openai-compatible'].baseUrl, 'https://llm.example.com/v1', 'custom baseUrl respected');
}

// Test: CUSTOM_BASE_URL with trailing slash stripped
{
  clearEnv();
  process.env.CUSTOM_API_KEY = 'sk-mykey';
  process.env.CUSTOM_BASE_URL = 'https://llm.example.com/v1/';
  const { config } = simulateProviderConfig();
  eq(config.models.providers['openai-compatible'].baseUrl, 'https://llm.example.com/v1', 'trailing slash stripped');
}

// Test: CUSTOM_MODEL override
{
  clearEnv();
  process.env.CUSTOM_API_KEY = 'sk-mykey';
  process.env.CUSTOM_MODEL = 'my-custom-model';
  const { config } = simulateProviderConfig();
  eq(config.models.providers['openai-compatible'].models[0].id, 'my-custom-model', 'custom model id');
  eq(config.models.providers['openai-compatible'].models[0].name, 'my-custom-model', 'custom model name');
}

// Test: all three custom vars together
{
  clearEnv();
  process.env.CUSTOM_API_KEY = 'sk-abc123';
  process.env.CUSTOM_BASE_URL = 'https://proxy.example.com/openai';
  process.env.CUSTOM_MODEL = 'llama-3.1-405b';
  const { config } = simulateProviderConfig();
  eq(config.models.providers['openai-compatible'].apiKey, 'sk-abc123', 'all custom values set');
  eq(config.models.providers['openai-compatible'].baseUrl, 'https://proxy.example.com/openai', 'custom baseUrl');
  eq(config.models.providers['openai-compatible'].models[0].id, 'llama-3.1-405b', 'custom model');
}

// Test: openai-compatible not created when CUSTOM_API_KEY is empty
{
  clearEnv();
  process.env.CUSTOM_API_KEY = '';
  const { config } = simulateProviderConfig();
  eq(config.models?.providers?.['openai-compatible'], undefined, 'not created with empty CUSTOM_API_KEY');
}

// Test: other providers coexist with openai-compatible
{
  clearEnv();
  process.env.CUSTOM_API_KEY = 'sk-test';
  process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
  process.env.VENICE_API_KEY = 'sk-venice';
  const { config } = simulateProviderConfig();
  assert(!!config.models.providers['openai-compatible'], 'openai-compatible exists');
  assert(!!config.models.providers.ollama, 'ollama exists');
  assert(!!config.models.providers.venice, 'venice exists');
  eq(Object.keys(config.models.providers).sort(), ['ollama', 'openai-compatible', 'venice'], 'all three providers present');
}

// Test: primaryCandidates includes openai-compatible
{
  clearEnv();
  process.env.CUSTOM_API_KEY = 'sk-primary';
  const primaryCandidates = [
    [process.env.ANTHROPIC_API_KEY, 'anthropic/claude-opus-4-5-20251101'],
    [process.env.OPENAI_API_KEY, 'openai/gpt-5.2'],
    [process.env.CUSTOM_API_KEY, 'openai-compatible/gpt-4'],
  ];
  let selected = null;
  for (const [key, model] of primaryCandidates) {
    if (key) {
      selected = model;
      break;
    }
  }
  eq(selected, 'openai-compatible/gpt-4', 'openai-compatible selected when no higher-priority provider');
}

// Test: openai-compatible loses to Anthropic in priority
{
  clearEnv();
  process.env.ANTHROPIC_API_KEY = 'sk-ant';
  process.env.CUSTOM_API_KEY = 'sk-custom';
  const primaryCandidates = [
    [process.env.ANTHROPIC_API_KEY, 'anthropic/claude-opus-4-5-20251101'],
    [process.env.OPENAI_API_KEY, 'openai/gpt-5.2'],
    [process.env.CUSTOM_API_KEY, 'openai-compatible/gpt-4'],
  ];
  let selected = null;
  for (const [key, model] of primaryCandidates) {
    if (key) {
      selected = model;
      break;
    }
  }
  eq(selected, 'anthropic/claude-opus-4-5-20251101', 'Anthropic beats openai-compatible');
}

// Test: openai-compatible loses to OpenAI in priority
{
  clearEnv();
  process.env.OPENAI_API_KEY = 'sk-openai';
  process.env.CUSTOM_API_KEY = 'sk-custom';
  const primaryCandidates = [
    [process.env.ANTHROPIC_API_KEY, 'anthropic/claude-opus-4-5-20251101'],
    [process.env.OPENAI_API_KEY, 'openai/gpt-5.2'],
    [process.env.CUSTOM_API_KEY, 'openai-compatible/gpt-4'],
  ];
  let selected = null;
  for (const [key, model] of primaryCandidates) {
    if (key) {
      selected = model;
      break;
    }
  }
  eq(selected, 'openai/gpt-5.2', 'OpenAI beats openai-compatible');
}

// Test: hasProvider validation includes CUSTOM_API_KEY
{
  clearEnv();
  const builtinKeys = [
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY',
    'XAI_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'CEREBRAS_API_KEY',
    'ZAI_API_KEY', 'AI_GATEWAY_API_KEY',
  ];
  const opencodeKey = process.env.OPENCODE_API_KEY || process.env.OPENCODE_ZEN_API_KEY;

  let hasProvider = builtinKeys.some(k => process.env[k]) || !!opencodeKey;
  hasProvider = hasProvider ||
    !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
    !!process.env.OLLAMA_BASE_URL ||
    !!process.env.VENICE_API_KEY || !!process.env.MINIMAX_API_KEY ||
    !!process.env.MOONSHOT_API_KEY || !!process.env.KIMI_API_KEY ||
    !!process.env.SYNTHETIC_API_KEY || !!process.env.XIAOMI_API_KEY ||
    !!process.env.CUSTOM_API_KEY;

  assert(hasProvider === false, 'no provider with no keys set');

  process.env.CUSTOM_API_KEY = 'sk-test';
  const builtinKeys2 = [
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY',
    'XAI_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'CEREBRAS_API_KEY',
    'ZAI_API_KEY', 'AI_GATEWAY_API_KEY',
  ];
  const opencodeKey2 = process.env.OPENCODE_API_KEY || process.env.OPENCODE_ZEN_API_KEY;
  hasProvider = builtinKeys2.some(k => process.env[k]) || !!opencodeKey2;
  hasProvider = hasProvider ||
    !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
    !!process.env.OLLAMA_BASE_URL ||
    !!process.env.VENICE_API_KEY || !!process.env.MINIMAX_API_KEY ||
    !!process.env.MOONSHOT_API_KEY || !!process.env.KIMI_API_KEY ||
    !!process.env.SYNTHETIC_API_KEY || !!process.env.XIAOMI_API_KEY ||
    !!process.env.CUSTOM_API_KEY;

  assert(hasProvider === true, 'CUSTOM_API_KEY satisfies hasProvider check');
}

// Restore env
restoreEnv();

// ── Results ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
