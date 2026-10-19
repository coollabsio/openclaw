/**
 * OpenClaw Configuration Utilities
 * Shared utilities for parsing environment variables and configuration values.
 */

// ── Constants for Validation Patterns ───────────────────────────────────────
const REGEX = Object.freeze({
  INTEGER: /^-?\d+$/,
  FLOAT: /^-?\d+\.\d+$/,
  JSON_STARTS_WITH_ARRAY: /^\s*\[/,
});

const ENV_VAR = Object.freeze({
  DOT_NOTATION_PREFIX: 'OPENCLAW__',
  ARRAY_SUFFIX: '[]',
});

const EXIT_CODE = Object.freeze({
  INVALID_CONFIG: 1,
});

// ── Type Coercion Utilities ─────────────────────────────────────────────────

/**
 * Parses a string value into its appropriate JavaScript type.
 * @param {string} value - The string value to parse
 * @returns {boolean|number|string} - Parsed value
 */
function coerceType(value) {
  switch (true) {
    case value === 'true':
      return true;
    case value === 'false':
      return false;
    case REGEX.INTEGER.test(value):
      return parseInt(value, 10);
    case REGEX.FLOAT.test(value):
      return parseFloat(value);
    default:
      return value;
  }
}

/**
 * Parses a comma-separated string into an array of trimmed values.
 * @param {string} value - Comma-separated values
 * @returns {string[]} - Array of trimmed values
 */
function parseArrayValue(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

// ── Configuration Parsing ───────────────────────────────────────────────────

/**
 * Parses allowed origins from environment variable.
 * Supports comma-separated list or JSON array format.
 * @param {string} rawValue - The OPENCLAW_ALLOWED_ORIGINS value
 * @returns {string[]} - Array of allowed origins
 * @throws {Error} If JSON parsing fails or result is not an array
 */
function parseAllowedOrigins(rawValue) {
  const trimmed = rawValue.trim();

  if (REGEX.JSON_STARTS_WITH_ARRAY.test(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) {
        throw new Error('JSON value must be an array');
      }
      return parsed.filter(item => typeof item === 'string');
    } catch (error) {
      throw new Error(`Invalid JSON array: ${error.message}`);
    }
  }

  return parseArrayValue(trimmed);
}

/**
 * Converts one Coolify hostname or URL into the origin a browser sends.
 * Bare hosts (typical of COOLIFY_FQDN) get https://. `URL.origin` then
 * drops paths, fragments, and default ports (:80/:443), lowercases the
 * host, and removes trailing slashes so the value can match Origin exactly.
 * @param {string} rawValue - A single domain or URL, not a comma-separated list
 * @returns {string} - A normalized HTTP(S) origin, or '' when empty or invalid
 */
function normalizeCoolifyOrigin(rawValue) {
  if (typeof rawValue !== 'string') {
    return '';
  }

  const trimmed = rawValue.trim();
  if (!trimmed) {
    return '';
  }

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const origin = new URL(withScheme).origin;
    // Opaque results (for example `new URL('https:///')`) are the string "null".
    if (!origin || origin === 'null') {
      return '';
    }
    return origin;
  } catch {
    return '';
  }
}

/**
 * Splits a Coolify domain list. Coolify joins every configured domain with
 * "," — `a.com,b.com` on COOLIFY_FQDN, or `https://a.com,http://b.com` on
 * COOLIFY_URL. Each entry is trimmed and normalized; empties and duplicates
 * are dropped. Order is preserved.
 * @param {string} rawValue - COOLIFY_URL or COOLIFY_FQDN value
 * @returns {string[]}
 */
function normalizeCoolifyOrigins(rawValue) {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    return [];
  }

  const origins = [];
  for (const part of rawValue.split(',')) {
    const origin = normalizeCoolifyOrigin(part);
    if (origin && !origins.includes(origin)) {
      origins.push(origin);
    }
  }
  return origins;
}

/**
 * Origins to inject from Coolify's predefined application variables.
 *
 * Since v4.0.0-beta.420 (compose_parsing_version >= 3), Coolify's
 * ApplicationDeploymentJob sets COOLIFY_URL to the application URL(s)
 * including the real scheme, and COOLIFY_FQDN to the hostname(s) only.
 * generate_coolify_env_variables() writes the stored fqdn (scheme, and
 * sometimes a path) into COOLIFY_URL and a scheme-stripped copy into
 * COOLIFY_FQDN. Both are comma-separated when several domains are set.
 * Prefer COOLIFY_URL so http:// is not rewritten to https://, and fall
 * back to COOLIFY_FQDN when URL is unset or blank.
 *
 * Apps created before that correction still have the two variables swapped.
 * Those keep working when only one is set; when both are set, the URL
 * (bare host on those old apps) wins and a missing scheme becomes https://.
 *
 * @param {string|undefined} coolifyUrl - process.env.COOLIFY_URL
 * @param {string|undefined} coolifyFqdn - process.env.COOLIFY_FQDN
 * @returns {string[]}
 */
function coolifyAllowedOrigins(coolifyUrl, coolifyFqdn) {
  const raw = [coolifyUrl, coolifyFqdn].find(
    (value) => typeof value === 'string' && value.trim()
  );
  return raw ? normalizeCoolifyOrigins(raw) : [];
}

// ── OpenAI-compatible custom provider ───────────────────────────────────────
//
// OPENAI_COMPATIBLE_BASE_URL and OPENAI_COMPATIBLE_MODEL are required.
// There is no default URL or model: a key alone must not be sent to
// https://api.openai.com/v1.
//
// OPENAI_COMPATIBLE_API_KEY is optional. OpenClaw synthesizes a non-secret
// local credential when apiKey is omitted and baseUrl is loopback, a private
// LAN address, *.local, host.docker.internal, or a bare hostname (LM Studio,
// local vLLM). Public endpoints still need a real key.

const OPENAI_COMPATIBLE_PROVIDER_ID = 'openai-compatible';

function trimmedEnv(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPrivateIpv4Host(host) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return false;
  }
  const octets = host.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = octets;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * True when OpenClaw will accept a custom provider with no apiKey.
 * Mirrors the local-base-URL check used by OpenClaw's synthetic local auth,
 * plus bare hostnames (Docker service names such as `vllm`).
 * @param {string} baseUrl
 * @returns {boolean}
 */
function isLocalOpenAICompatibleBaseUrl(baseUrl) {
  try {
    let host = new URL(baseUrl).hostname.toLowerCase();
    if (host.startsWith('[') && host.endsWith(']')) {
      host = host.slice(1, -1);
    }
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host === '::ffff:7f00:1' ||
      host === '::ffff:127.0.0.1' ||
      host === 'docker.orb.internal' ||
      host === 'host.docker.internal' ||
      host === 'host.orb.internal' ||
      host.endsWith('.local') ||
      isPrivateIpv4Host(host) ||
      (host.length > 0 && !host.includes('.') && !host.includes(':'))
    );
  } catch {
    return false;
  }
}

/**
 * Build the `models.providers["openai-compatible"]` entry from env values.
 * Pure: does not read process.env and does not log.
 *
 * @param {{ apiKey?: string, baseUrl?: string, model?: string, existing?: object }} input
 * @returns {{
 *   action: 'absent' | 'incomplete' | 'apply',
 *   providerId: string,
 *   modelRef: string,
 *   provider?: object,
 *   warning?: string,
 * }}
 */
function resolveOpenAICompatibleProvider(input) {
  const source = input || {};
  const apiKey = trimmedEnv(source.apiKey);
  const baseUrl = trimmedEnv(source.baseUrl).replace(/\/+$/, '');
  const modelId = trimmedEnv(source.model);
  const providerId = OPENAI_COMPATIBLE_PROVIDER_ID;

  if (!apiKey && !baseUrl && !modelId) {
    return { action: 'absent', providerId, modelRef: '' };
  }

  const missing = [];
  if (!baseUrl) missing.push('OPENAI_COMPATIBLE_BASE_URL');
  if (!modelId) missing.push('OPENAI_COMPATIBLE_MODEL');
  if (missing.length > 0) {
    const noun = missing.length === 1 ? 'is' : 'are';
    return {
      action: 'incomplete',
      providerId,
      modelRef: '',
      warning:
        '[configure] WARNING: skipping OpenAI-compatible provider — ' +
        `${missing.join(' and ')} ${noun} required. ` +
        'Set OPENAI_COMPATIBLE_BASE_URL and OPENAI_COMPATIBLE_MODEL. ' +
        'OPENAI_COMPATIBLE_API_KEY is optional for local servers without auth.',
    };
  }

  const existing =
    source.existing && typeof source.existing === 'object' && !Array.isArray(source.existing)
      ? source.existing
      : null;
  const provider = existing ? { ...existing } : {};
  if (!trimmedEnv(provider.api)) {
    provider.api = 'openai-completions';
  }
  provider.baseUrl = baseUrl;
  if (apiKey) {
    provider.apiKey = apiKey;
  }

  const modelEntry = { id: modelId, name: modelId, contextWindow: 128000 };
  if (Array.isArray(provider.models)) {
    const models = provider.models.map((model) =>
      model && typeof model === 'object' ? { ...model } : model
    );
    if (!models.some((model) => model && model.id === modelId)) {
      models.push(modelEntry);
    }
    provider.models = models;
  } else {
    provider.models = [modelEntry];
  }

  const hasKey =
    apiKey !== '' ||
    (provider.apiKey != null && String(provider.apiKey).trim() !== '');
  let warning;
  if (!hasKey && !isLocalOpenAICompatibleBaseUrl(baseUrl)) {
    warning =
      '[configure] WARNING: OpenAI-compatible provider has no API key. ' +
      'Public endpoints need OPENAI_COMPATIBLE_API_KEY. ' +
      'Local servers (LM Studio, local vLLM) can omit it when the base URL is ' +
      'loopback, a private LAN address, *.local, host.docker.internal, or a bare hostname.';
  }

  return {
    action: 'apply',
    providerId,
    modelRef: `${providerId}/${modelId}`,
    provider,
    warning,
  };
}

// ── Ollama provider ─────────────────────────────────────────────────────────

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Strip trailing slashes and append `/v1` when it is not already there.
 * Empty input (including a URL made only of slashes) returns ''.
 * @param {string} ollamaUrl - OLLAMA_BASE_URL
 * @returns {string}
 */
function normalizeOllamaBaseUrl(ollamaUrl) {
  if (typeof ollamaUrl !== 'string') return '';
  const stripped = ollamaUrl.replace(/\/+$/, '');
  if (!stripped) return '';
  return stripped.endsWith('/v1') ? stripped : `${stripped}/v1`;
}

function defaultOllamaProvider(baseUrl) {
  return {
    api: 'openai-completions',
    baseUrl,
    models: [{ id: 'llama3.3', name: 'Llama 3.3', contextWindow: 128000 }],
  };
}

/**
 * Model list from a mounted custom config, copied so the later persisted
 * merge (which replaces arrays) cannot discard it. Null when unset.
 * @param {object|null|undefined} customConfig
 * @returns {object[]|null}
 */
function readCustomOllamaModels(customConfig) {
  const models = customConfig?.models?.providers?.ollama?.models;
  return Array.isArray(models) ? models.slice() : null;
}

/**
 * Apply OLLAMA_BASE_URL. An existing ollama provider keeps every field
 * except baseUrl. A missing provider gets the default llama3.3 catalog.
 * @param {object} config - Config after the custom + persisted merge
 * @param {string} ollamaUrl
 * @returns {string} Normalized base URL, or '' when the env var is unset
 */
function applyOllamaBaseUrl(config, ollamaUrl) {
  const base = normalizeOllamaBaseUrl(ollamaUrl);
  if (!base || !isPlainObject(config)) return '';
  if (!isPlainObject(config.models)) config.models = {};
  if (!isPlainObject(config.models.providers)) config.models.providers = {};
  if (!isPlainObject(config.models.providers.ollama)) {
    config.models.providers.ollama = defaultOllamaProvider(base);
  } else {
    config.models.providers.ollama.baseUrl = base;
  }
  return base;
}

/**
 * Put mounted custom ollama models back onto an existing provider.
 * No-op when the custom file did not define a models array, or when the
 * provider is absent (so a removed provider is not resurrected).
 * @param {object} config
 * @param {object[]|null} customModels - Result of readCustomOllamaModels
 * @returns {object} config
 */
function restoreCustomOllamaModels(config, customModels) {
  if (!Array.isArray(customModels)) return config;
  const provider = config?.models?.providers?.ollama;
  if (!isPlainObject(provider)) return config;
  provider.models = customModels.slice();
  return config;
}

/**
 * Ids of configured ollama models, in list order, skipping blank ids.
 * @param {object} config
 * @returns {string[]}
 */
function ollamaModelIds(config) {
  const models = config?.models?.providers?.ollama?.models;
  if (!Array.isArray(models)) return [];
  const ids = [];
  for (const model of models) {
    if (model && typeof model.id === 'string' && model.id.trim()) {
      ids.push(model.id.trim());
    }
  }
  return ids;
}

/**
 * Automatic primary ref for the Ollama provider.
 * First configured model, or ollama/llama3.3 when no models array is set.
 * Returns null when the array is present but has no usable id.
 * @param {object} config
 * @returns {string|null}
 */
function ollamaPrimaryModel(config) {
  const ids = ollamaModelIds(config);
  if (ids.length > 0) return `ollama/${ids[0]}`;
  const models = config?.models?.providers?.ollama?.models;
  return Array.isArray(models) ? null : 'ollama/llama3.3';
}

/**
 * A previous run stored primary "ollama/llama3.3" next to the default catalog.
 * Once custom models replace that catalog, point the stale primary at the
 * first configured model. Any other primary is left alone.
 * @param {object} config
 * @param {string} primary
 * @returns {string}
 */
function reconcileStaleOllamaPrimary(config, primary) {
  if (primary !== 'ollama/llama3.3') return primary;
  const ids = ollamaModelIds(config);
  if (ids.length === 0 || ids.includes('llama3.3')) return primary;
  return `ollama/${ids[0]}`;
}

// ── MiniMax provider catalog ────────────────────────────────────────────────
//
// Anthropic-compatible chat endpoints (platform.minimax.io text-anthropic API):
//   global: https://api.minimax.io/anthropic
//   China:  https://api.minimaxi.com/anthropic
//
// Model ids and context windows match that API. Upstream OpenClaw's bundled
// catalog (extensions/minimax) supplies the metadata below for M3 and M2.7:
// reasoning, input, maxTokens 131072, M3 cost, and M3 compat.codeMode.
//
// MiniMax-M3 returns empty content when thinking is disabled. OpenClaw picks
// adaptive thinking from the model id (`reasoning: true` is the catalog flag;
// this image does not write a thinking override). M2.x thinking stays off
// inside OpenClaw unless the user sets it, so reasoning_content is not leaked.
//
// MiniMax-M2.1 stays as a third entry. configure.js never overwrites a saved
// primary, so users on minimax/MiniMax-M2.1 keep that ref — it has to remain
// in the model list or the saved primary stops resolving. New installs with
// no primary still auto-select MiniMax-M3.

const MINIMAX_GLOBAL_BASE_URL = 'https://api.minimax.io/anthropic';
const MINIMAX_CN_BASE_URL = 'https://api.minimaxi.com/anthropic';
const MINIMAX_PRIMARY_MODEL = 'minimax/MiniMax-M3';
const MINIMAX_MAX_TOKENS = 131072;

const MINIMAX_MODEL_CATALOG = [
  {
    id: 'MiniMax-M3',
    name: 'MiniMax M3',
    reasoning: true,
    input: ['text', 'image'],
    compat: { codeMode: 'preferred' },
    cost: { input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: MINIMAX_MAX_TOKENS,
  },
  {
    id: 'MiniMax-M2.7',
    name: 'MiniMax M2.7',
    reasoning: true,
    input: ['text'],
    cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
    contextWindow: 204800,
    maxTokens: MINIMAX_MAX_TOKENS,
  },
  {
    id: 'MiniMax-M2.1',
    name: 'MiniMax M2.1',
    reasoning: true,
    input: ['text'],
    contextWindow: 204800,
    maxTokens: MINIMAX_MAX_TOKENS,
  },
];

/**
 * Anthropic-compatible MiniMax chat base URL.
 * Blank or non-string values use the global endpoint. Trailing slashes are removed.
 * @param {string|undefined|null} rawValue - MINIMAX_BASE_URL
 * @returns {string}
 */
function minimaxBaseUrl(rawValue) {
  const trimmed = typeof rawValue === 'string' ? rawValue.trim() : '';
  return (trimmed || MINIMAX_GLOBAL_BASE_URL).replace(/\/+$/, '');
}

/**
 * Fresh MiniMax model list: M3, M2.7, then legacy M2.1.
 * Each call returns new objects so a config write cannot mutate the catalog.
 * @returns {object[]}
 */
function minimaxModels() {
  return MINIMAX_MODEL_CATALOG.map((model) => {
    const copy = {
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input.slice(),
    };
    if (model.compat) copy.compat = { ...model.compat };
    if (model.cost) copy.cost = { ...model.cost };
    copy.contextWindow = model.contextWindow;
    copy.maxTokens = model.maxTokens;
    return copy;
  });
}

// ── Compose browser sidecar SSRF ────────────────────────────────────────────
//
// OpenClaw's browser SSRF policy blocks private and special-use addresses
// unless the operator opts in. The official Compose service name `browser`
// resolves to a private container address, so CDP at http://browser:9223 is
// rejected before any HTTP request. Allowing that exact hostname is the narrow
// exception OpenClaw honors (allowedHostnames skips the private-network check
// for that name only). dangerouslyAllowPrivateNetwork is never set here.

const COMPOSE_BROWSER_SIDECAR_HOSTNAME = 'browser';

/**
 * Lowercase exact host: trim, strip one pair of brackets, drop trailing dots.
 * @param {string} value
 * @returns {string}
 */
function normalizeExactHostname(value) {
  if (typeof value !== 'string') return '';
  let host = value.trim().toLowerCase().replace(/\.+$/, '');
  if (host.startsWith('[') && host.endsWith(']') && host.length > 2) {
    host = host.slice(1, -1);
  }
  return host;
}

/**
 * Hostname of a CDP URL, or '' when the value is empty or not a URL.
 * `browser:9223` (no scheme) does not count: WHATWG parses it as a scheme.
 * @param {string} cdpUrl
 * @returns {string}
 */
function cdpUrlHostname(cdpUrl) {
  if (typeof cdpUrl !== 'string' || !cdpUrl.trim()) return '';
  try {
    return normalizeExactHostname(new URL(cdpUrl.trim()).hostname);
  } catch {
    return '';
  }
}

/**
 * CDP URLs from the top-level browser block and from each profile.
 * @param {object|undefined|null} browserConfig
 * @returns {string[]}
 */
function browserCdpUrls(browserConfig) {
  if (!browserConfig || typeof browserConfig !== 'object' || Array.isArray(browserConfig)) {
    return [];
  }
  const urls = [];
  if (typeof browserConfig.cdpUrl === 'string') urls.push(browserConfig.cdpUrl);
  const profiles = browserConfig.profiles;
  if (profiles && typeof profiles === 'object' && !Array.isArray(profiles)) {
    for (const profile of Object.values(profiles)) {
      if (
        profile &&
        typeof profile === 'object' &&
        !Array.isArray(profile) &&
        typeof profile.cdpUrl === 'string'
      ) {
        urls.push(profile.cdpUrl);
      }
    }
  }
  return urls;
}

/**
 * Hostnames from an allow/block list. Accepts an array or a JSON-array string
 * (the dot-notation form without the `[]` suffix stores that string).
 * @param {unknown} value
 * @returns {string[]}
 */
function hostnameEntries(value) {
  let items = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (REGEX.JSON_STARTS_WITH_ARRAY.test(trimmed)) {
      try {
        const parsed = JSON.parse(trimmed);
        items = Array.isArray(parsed) ? parsed : [trimmed];
      } catch {
        items = [trimmed];
      }
    } else {
      items = [trimmed];
    }
  }
  if (!Array.isArray(items)) return [];

  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = normalizeExactHostname(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * True when blockedHostnames contains the exact hostname.
 * @param {object|undefined|null} policy
 * @param {string} hostname
 * @returns {boolean}
 */
function ssrfPolicyBlocksHostname(policy, hostname) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return false;
  const target = normalizeExactHostname(hostname);
  return hostnameEntries(policy.blockedHostnames).some(
    (host) => normalizeExactHostname(host) === target,
  );
}

/**
 * Copy of policy with the Compose sidecar hostname appended to allowedHostnames.
 * Other policy fields are kept. A list that already contains the hostname is
 * returned as-is, except a JSON-string list is rewritten to a real array so
 * the strict schema accepts it. Does not set dangerouslyAllowPrivateNetwork.
 * @param {object|undefined|null} policy
 * @returns {object}
 */
function allowComposeBrowserSidecar(policy) {
  const current = policy && typeof policy === 'object' && !Array.isArray(policy) ? policy : {};
  const allowed = hostnameEntries(current.allowedHostnames);
  const already = allowed.some(
    (host) => normalizeExactHostname(host) === COMPOSE_BROWSER_SIDECAR_HOSTNAME,
  );
  if (already && Array.isArray(current.allowedHostnames)) {
    return current;
  }
  return {
    ...current,
    allowedHostnames: already ? allowed : [...allowed, COMPOSE_BROWSER_SIDECAR_HOSTNAME],
  };
}

/**
 * Whether the effective browser config should trust the Compose sidecar host.
 * Opt out with BROWSER_SSRF_ALLOW_COMPOSE_SIDECAR=false or 0. Any other value,
 * including unset, still requires the CDP hostname to be exactly `browser`.
 * @param {object|undefined|null} browserConfig
 * @param {string|undefined} optOutValue
 * @returns {{action: 'skip'|'opt-out'|'blocked'|'already'|'allow', ssrfPolicy?: object}}
 */
function resolveComposeBrowserSidecarSsrF(browserConfig, optOutValue) {
  const targetsSidecar = browserCdpUrls(browserConfig).some(
    (url) => cdpUrlHostname(url) === COMPOSE_BROWSER_SIDECAR_HOSTNAME,
  );
  if (!targetsSidecar) return { action: 'skip' };
  if (optOutValue === 'false' || optOutValue === '0') return { action: 'opt-out' };

  const previous = browserConfig && browserConfig.ssrfPolicy;
  if (ssrfPolicyBlocksHostname(previous, COMPOSE_BROWSER_SIDECAR_HOSTNAME)) {
    return { action: 'blocked' };
  }
  const next = allowComposeBrowserSidecar(previous);
  if (next === previous) return { action: 'already', ssrfPolicy: next };
  return { action: 'allow', ssrfPolicy: next };
}

module.exports = {
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
  resolveOpenAICompatibleProvider,
  COMPOSE_BROWSER_SIDECAR_HOSTNAME,
  cdpUrlHostname,
  browserCdpUrls,
  allowComposeBrowserSidecar,
  resolveComposeBrowserSidecarSsrF,
};
