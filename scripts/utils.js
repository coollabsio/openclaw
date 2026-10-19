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
};
