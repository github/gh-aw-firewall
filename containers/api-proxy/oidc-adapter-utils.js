'use strict';

/**
 * OIDC/auth adapter utilities shared by provider adapters.
 *
 * Isolated from proxy-utils.js so that the security-critical auth-header and
 * OIDC runtime wiring paths can be reviewed independently of the general proxy
 * URL/header/body helpers.
 */

/**
 * Validate that a string is a legal HTTP header name.
 * @param {string} name - The header name to validate
 * @returns {boolean} true if valid
 */
function isValidHeaderName(name) {
  try {
    require('http').validateHeaderName(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and validate a custom auth header from an env var.
 * @param {string} envVarName - The environment variable name (for error messages)
 * @param {string|undefined} rawValue - The raw env var value
 * @param {string} [defaultHeader] - Fallback if value is empty
 * @returns {string} The validated header name (or empty string if no value and no default)
 * @throws {Error} If the value is not a valid HTTP header name
 */
function validateAuthHeaderEnv(envVarName, rawValue, defaultHeader) {
  const header = (rawValue || '').trim() || defaultHeader || '';
  if (!header) return '';
  if (!isValidHeaderName(header)) {
    throw new Error(`Invalid ${envVarName} value: expected a valid HTTP header name`);
  }
  return header;
}

/**
 * Build common OIDC runtime adapter methods shared by provider adapters.
 *
 * @param {object} opts
 * @param {string|undefined} [opts.staticAuthToken]
 * @param {{ isReady?: () => boolean }|null|undefined} [opts.oidcProvider]
 * @param {{ isReady?: () => boolean }|null|undefined} [opts.awsOidcProvider]
 * @returns {{
 *   isEnabled: () => boolean,
 *   getOidcProvider: () => unknown,
 *   getAwsOidcProvider: () => unknown
 * }}
 */
function createOidcRuntimeAdapterMethods({ staticAuthToken, oidcProvider, awsOidcProvider }) {
  return {
    isEnabled() {
      return !!staticAuthToken || !!oidcProvider?.isReady() || !!awsOidcProvider?.isReady();
    },
    getOidcProvider() { return oidcProvider; },
    getAwsOidcProvider() { return awsOidcProvider; },
  };
}

/**
 * Resolve auth headers for OIDC-enabled adapters.
 *
 * Returns:
 * - OIDC headers object when a bearer-compatible OIDC provider has a token
 * - empty object when OIDC is configured but no token is available yet
 * - empty object for AWS OIDC (SigV4 is applied later by request signing)
 * - null when no OIDC provider is configured (caller should use static auth fallback)
 *
 * @param {object} opts
 * @param {{ getToken: () => (string|undefined|null) }|null|undefined} [opts.oidcProvider]
 * @param {unknown} [opts.awsOidcProvider]
 * @param {(token: string) => Record<string, string>} opts.buildOidcHeaders
 * @returns {Record<string, string>|null}
 */
function resolveOidcAuthHeaders({ oidcProvider, awsOidcProvider, buildOidcHeaders }) {
  if (oidcProvider) {
    const token = oidcProvider.getToken();
    return token ? buildOidcHeaders(token) : {};
  }
  if (awsOidcProvider) {
    return {};
  }
  return null;
}

module.exports = {
  isValidHeaderName,
  validateAuthHeaderEnv,
  createOidcRuntimeAdapterMethods,
  resolveOidcAuthHeaders,
};
