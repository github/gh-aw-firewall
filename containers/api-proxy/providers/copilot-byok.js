'use strict';

const { parseBodyAsObject } = require('../body-utils');

/**
 * Header names that must never be overridden by caller-supplied extra headers.
 * These are the auth/proxy headers stripped or injected by the proxy itself.
 */
const PROTECTED_HEADER_NAMES = new Set([
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'proxy-authorization',
]);

/**
 * Parse the AWF_BYOK_EXTRA_HEADERS environment variable into a plain header map.
 *
 * The value must be a JSON object whose keys are valid HTTP header names and
 * whose values are strings.  Invalid entries are skipped with a console warning;
 * the function always returns a (possibly empty) object rather than throwing.
 *
 * Auth-critical header names (authorization, x-api-key, etc.) are rejected to
 * prevent accidental credential injection via this configuration path.
 *
 * @param {string|undefined} raw - Raw value of AWF_BYOK_EXTRA_HEADERS
 * @returns {Record<string, string>} Validated header map (may be empty)
 */
function parseByokExtraHeaders(raw) {
  if (!raw || !raw.trim()) return {};

  let parsed;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    console.warn('AWF_BYOK_EXTRA_HEADERS: invalid JSON; ignoring extra headers');
    return {};
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
    console.warn('AWF_BYOK_EXTRA_HEADERS: expected a JSON object; ignoring extra headers');
    return {};
  }

  const result = {};
  const http = require('http');
  for (const [name, value] of Object.entries(parsed)) {
    const lowerName = name.toLowerCase();

    // Prevent prototype pollution / special keys in header maps.
    if (lowerName === '__proto__' || lowerName === 'constructor' || lowerName === 'prototype') {
      console.warn(`AWF_BYOK_EXTRA_HEADERS: "${name}" is not an allowed header name; skipping`);
      continue;
    }

    if (PROTECTED_HEADER_NAMES.has(lowerName)) {
      console.warn(`AWF_BYOK_EXTRA_HEADERS: "${name}" is an auth-critical header and cannot be overridden; skipping`);
      continue;
    }
    try {
      http.validateHeaderName(name);
    } catch {
      console.warn(`AWF_BYOK_EXTRA_HEADERS: "${name}" is not a valid HTTP header name; skipping`);
      continue;
    }
    if (typeof value !== 'string') {
      console.warn(`AWF_BYOK_EXTRA_HEADERS: value for "${name}" must be a string; skipping`);
      continue;
    }
    result[name] = value;
  }

  return result;
}

/**
 * Parse AWF_BYOK_EXTRA_BODY_FIELDS into a plain string map.
 *
 * @param {string|undefined} raw - Raw value of AWF_BYOK_EXTRA_BODY_FIELDS
 * @returns {Record<string, string>} Validated body field map (may be empty)
 */
function parseByokExtraBodyFields(raw) {
  if (!raw || !raw.trim()) return {};

  let parsed;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    console.warn('AWF_BYOK_EXTRA_BODY_FIELDS: invalid JSON; ignoring extra body fields');
    return {};
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
    console.warn('AWF_BYOK_EXTRA_BODY_FIELDS: expected a JSON object; ignoring extra body fields');
    return {};
  }

  const result = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
      console.warn(`AWF_BYOK_EXTRA_BODY_FIELDS: "${name}" is not an allowed field name; skipping`);
      continue;
    }
    if (typeof value !== 'string') {
      console.warn(`AWF_BYOK_EXTRA_BODY_FIELDS: value for "${name}" must be a string; skipping`);
      continue;
    }
    result[name] = value;
  }

  return result;
}

/**
 * Inject non-overriding top-level JSON fields into a request body.
 *
 * @param {Buffer} body
 * @param {Record<string, string>} fields
 * @returns {Buffer|null}
 */
function injectByokExtraBodyFields(body, fields) {
  if (!fields || Object.keys(fields).length === 0) return null;

  const parsed = parseBodyAsObject(body);
  if (!parsed) return null;

  let changed = false;
  for (const [field, value] of Object.entries(fields)) {
    if (!Object.hasOwn(parsed, field)) {
      parsed[field] = value;
      changed = true;
    }
  }

  if (!changed) return null;
  return Buffer.from(JSON.stringify(parsed));
}

// AWF injects this sentinel value into the *agent* environment for credential isolation.
// The ghu_ prefix is intentional: it matches the GitHub token shape that Copilot CLI
// auth pre-checks expect, but the 36 repeated 'a' characters make it unambiguous as
// a non-real placeholder.  It is defined in src/constants/placeholders.ts and must
// stay in sync.
const COPILOT_PLACEHOLDER_TOKEN = 'ghu_' + 'a'.repeat(36);

module.exports = {
  parseByokExtraHeaders,
  parseByokExtraBodyFields,
  injectByokExtraBodyFields,
  COPILOT_PLACEHOLDER_TOKEN,
  // Exported for unit-test access only; not part of the public API.
  _testing: {
    parseByokExtraHeaders,
    parseByokExtraBodyFields,
    injectByokExtraBodyFields,
    COPILOT_PLACEHOLDER_TOKEN,
  },
};
