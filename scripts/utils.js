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
  OPENAI_COMPATIBLE_PROVIDER_ID,
  resolveOpenAICompatibleProvider,
};
