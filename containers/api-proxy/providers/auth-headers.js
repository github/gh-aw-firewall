'use strict';

/**
 * Shared auth-header construction helpers for provider adapters.
 *
 * Centralises the security-critical credential-injection patterns that appear
 * across multiple adapters so that changing an auth prefix, header name, or
 * integration-metadata key only requires a single edit.
 */

/**
 * Build a `Bearer` Authorization header, optionally merged with extra headers.
 *
 * @param {string} token
 * @param {Record<string, string>} [extraHeaders]
 * @returns {Record<string, string>}
 */
function bearerAuthHeaders(token, extraHeaders) {
  return { ...extraHeaders, 'Authorization': 'Bearer ' + token };
}

/**
 * Build an auth header using a configurable HTTP header name (e.g. `x-api-key`,
 * `api-key`, `x-goog-api-key`), optionally merged with extra headers.
 *
 * @param {string} headerName - The HTTP header name to use
 * @param {string} token - The credential value
 * @param {Record<string, string>} [extraHeaders]
 * @returns {Record<string, string>}
 */
function providerKeyHeaders(headerName, token, extraHeaders) {
  return { ...extraHeaders, [headerName]: token };
}

/**
 * Add a `Copilot-Integration-Id` entry to an existing header object.
 *
 * @param {Record<string, string>} headers - Base headers to extend
 * @param {string} integrationId
 * @returns {Record<string, string>}
 */
function withCopilotIntegration(headers, integrationId) {
  return { ...headers, 'Copilot-Integration-Id': integrationId };
}

module.exports = { bearerAuthHeaders, providerKeyHeaders, withCopilotIntegration };
