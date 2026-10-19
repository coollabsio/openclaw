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
  normalizeOllamaBaseUrl,
  readCustomOllamaModels,
  applyOllamaBaseUrl,
  restoreCustomOllamaModels,
  ollamaPrimaryModel,
  reconcileStaleOllamaPrimary,
};
