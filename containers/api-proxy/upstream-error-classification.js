'use strict';

/**
 * Pattern matching the Copilot error for a model that is not yet visible in
 * the caller's entitlement catalogue.  The error is transient — the catalogue
 * is non-deterministic and often stabilises within seconds.
 */
const MODEL_NOT_SUPPORTED_PATTERN = /the requested model is not supported/i;

/**
 * Pattern matching the Copilot error for a model that exists in the catalogue
 * but is not accessible via the requested endpoint (e.g. /chat/completions).
 * This is a permanent per-endpoint restriction, not a transient catalogue issue.
 * Examples: "model \"gpt-5.4-mini\" is not accessible via the /chat/completions endpoint"
 */
const MODEL_ENDPOINT_BLOCKED_PATTERN = /not accessible via the .+? endpoint/i;

/**
 * Return true when the response body contains a Copilot "model not supported"
 * error message.
 *
 * @param {Buffer} body
 * @returns {boolean}
 */
function parseModelNotSupportedFromBody(body) {
  return MODEL_NOT_SUPPORTED_PATTERN.test(body.toString('utf8'));
}

/**
 * Return true when the response body indicates the model is not accessible
 * via the requested endpoint.
 *
 * @param {Buffer} body
 * @returns {boolean}
 */
function parseModelEndpointBlockedFromBody(body) {
  return MODEL_ENDPOINT_BLOCKED_PATTERN.test(body.toString('utf8'));
}

module.exports = {
  parseModelNotSupportedFromBody,
  parseModelEndpointBlockedFromBody,
};
