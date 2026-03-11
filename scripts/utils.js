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
      return parsed;
    } catch (error) {
      throw new Error(`Invalid JSON array: ${error.message}`);
    }
  }

  return parseArrayValue(trimmed);
}

module.exports = {
  REGEX,
  ENV_VAR,
  EXIT_CODE,
  coerceType,
  parseArrayValue,
  parseAllowedOrigins,
};
