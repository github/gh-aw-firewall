'use strict';

const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,64}$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function selectErrorObject(value) {
  if (!isObject(value)) return null;
  if (isObject(value.error)) return value.error;
  if (isObject(value.response) && isObject(value.response.error)) return value.response.error;
  if (value.type === 'error') return value;
  return null;
}

/**
 * Extract identifier-shaped provider error fields from an already-parsed
 * error envelope. Reads only `code`, `type`, and `param` (never `message`,
 * which can echo request content) and omits any key without a valid value.
 *
 * @param {unknown} value
 * @returns {{ error_code?: string, error_type?: string, error_param?: string }}
 */
function extractProviderErrorFields(value) {
  const error = selectErrorObject(value);
  if (!error) return {};
  const fields = {};
  for (const [source, target] of [['code', 'error_code'], ['type', 'error_type'], ['param', 'error_param']]) {
    const candidate = error[source];
    if (typeof candidate === 'string' && IDENTIFIER.test(candidate)) fields[target] = candidate;
  }
  return fields;
}

module.exports = { extractProviderErrorFields };
