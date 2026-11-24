'use strict';
const { markCredentialHeaders, getHeaderCredentials } = require('../credential-protection');
const { validateHeaderValue } = require('http');

function validateAuthSchemeEnv(envVarName, value) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)) {
    throw new Error(`Invalid ${envVarName} value: expected an HTTP authentication scheme token`);
  }
  return value;
}

function buildStaticAuthHeaderFn({ headerName, scheme, defaultHeaderName, prefix = 'Bearer' } = {}) {
  const legacyBuilder = buildAuthHeaderFn({ headerName: headerName || defaultHeaderName, prefix });
  return (key, extraHeaders) => {
    if (!scheme) {
      const headers = legacyBuilder(key, extraHeaders);
      const rawKey = typeof key === 'string' ? key.replace(/^(?:Bearer|token)\s+/i, '') : key;
      return markCredentialHeaders(headers, [...getHeaderCredentials(headers), rawKey]);
    }
    const name = headerName || 'Authorization';
    const alreadyPrefixed = typeof key === 'string'
      && key.slice(0, scheme.length).toLowerCase() === scheme.toLowerCase()
      && /[ \t]/.test(key[scheme.length] || '');
    const value = alreadyPrefixed ? key : `${scheme} ${key}`;
    try {
      validateHeaderValue(name, value);
    } catch {
      throw new Error('Invalid static authentication credential: expected a safe HTTP header value');
    }
    const unprefixedKey = alreadyPrefixed ? key.slice(scheme.length + 1).trim() : key;
    return markCredentialHeaders({ ...extraHeaders, [name]: value }, [key, unprefixedKey, value]);
  };
}

/**
 * Shared auth-header construction helpers for provider adapters.
 *
 * Centralises the security-critical credential-injection patterns that appear
 * across multiple adapters so that changing an auth prefix, header name, or
 * integration-metadata key only requires a single edit.
 */

/**
 * Build an `Authorization` header using the given scheme prefix (e.g. `Bearer`,
 * `token`), optionally merged with extra headers.
 *
 * This is the single place that assembles an `Authorization` header value, so
 * every adapter that needs a non-default prefix (e.g. Copilot's Enterprise
 * `token <value>` scheme) composes it from here instead of concatenating the
 * prefix and token itself.
 *
 * @param {string} prefix - The auth scheme prefix (e.g. `Bearer`, `token`)
 * @param {string} token
 * @param {Record<string, string>} [extraHeaders]
 * @returns {Record<string, string>}
 */
function tokenAuthHeaders(prefix, token, extraHeaders) {
  return markCredentialHeaders({ ...extraHeaders, 'Authorization': prefix + ' ' + token }, [token]);
}

/**
 * Build a `Bearer` Authorization header, optionally merged with extra headers.
 *
 * @param {string} token
 * @param {Record<string, string>} [extraHeaders]
 * @returns {Record<string, string>}
 */
function bearerAuthHeaders(token, extraHeaders) {
  return tokenAuthHeaders('Bearer', token, extraHeaders);
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
  return markCredentialHeaders({ ...extraHeaders, [headerName]: token }, [token]);
}

/**
 * Build a reusable auth-header builder function that encapsulates the
 * "custom header name vs. Authorization prefix" branching shared by the
 * OpenAI and Copilot adapters.
 *
 * When `headerName` is set (e.g. Azure OpenAI BYOK's `api-key`, or a caller
 * override such as `AWF_OPENAI_AUTH_HEADER`), the returned function builds a
 * `providerKeyHeaders`-style header. Otherwise it falls back to
 * `tokenAuthHeaders` using `prefix` (defaulting to `Bearer`), so callers such
 * as Copilot can select the `token` or `Bearer` scheme when creating the
 * reusable builder.
 *
 * @param {{ headerName?: string, prefix?: string }} [options]
 * @returns {(token: string, extraHeaders?: Record<string, string>) => Record<string, string>}
 */
function buildAuthHeaderFn({ headerName, prefix = 'Bearer' } = {}) {
  return (token, extraHeaders) => (headerName
    ? providerKeyHeaders(headerName, token, extraHeaders)
    : tokenAuthHeaders(prefix, token, extraHeaders));
}

/**
 * Add a `Copilot-Integration-Id` entry to an existing header object.
 *
 * @param {Record<string, string>} headers - Base headers to extend
 * @param {string} integrationId
 * @returns {Record<string, string>}
 */
function withCopilotIntegration(headers, integrationId) {
  return markCredentialHeaders({ ...headers, 'Copilot-Integration-Id': integrationId }, getHeaderCredentials(headers));
}

module.exports = { tokenAuthHeaders, bearerAuthHeaders, providerKeyHeaders, withCopilotIntegration, buildAuthHeaderFn, validateAuthSchemeEnv, buildStaticAuthHeaderFn };
