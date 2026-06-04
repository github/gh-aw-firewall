'use strict';

/**
 * Parse a request/response body as a plain JSON object.
 *
 * Returns null on parse error, non-object, or array input.
 *
 * @param {Buffer|string} body
 * @returns {Record<string, unknown>|null}
 */
function parseBodyAsObject(body) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

module.exports = {
  parseBodyAsObject,
};
