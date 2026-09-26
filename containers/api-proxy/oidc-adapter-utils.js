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
 *   getAwsOidcProvider: () => unknown,
 *   getRequestSigner: () => (((request: object) => Record<string,string>)|null)
 * }}
 */
function createOidcRuntimeAdapterMethods({ staticAuthToken, oidcProvider, awsOidcProvider }) {
  return {
    isEnabled() {
      if (oidcProvider || awsOidcProvider) {
        return !!oidcProvider?.isReady() || !!awsOidcProvider?.isReady();
      }
      return !!staticAuthToken;
    },
    getOidcProvider() { return oidcProvider; },
    getAwsOidcProvider() { return awsOidcProvider; },
    getRequestSigner() {
      return awsOidcProvider
        ? request => awsOidcProvider.signRequest(request)
        : null;
    },
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

/**
 * Resolve auth headers with automatic static-key fallback.
 *
 * Combines OIDC resolution with a static-key fallback into a single call,
 * encapsulating the repeated pattern across provider adapters:
 *   1. If OIDC provider has a token → use buildOidcHeaders(token)
 *   2. If OIDC is configured but no token yet → return empty {} (fail-safe)
 *   3. If no OIDC → return staticHeaders
 *
 * @param {object} opts
 * @param {{ getToken: () => (string|undefined|null) }|null|undefined} [opts.oidcProvider]
 * @param {unknown} [opts.awsOidcProvider]
 * @param {(token: string) => Record<string, string>} opts.buildOidcHeaders
 * @param {Record<string, string>} opts.staticHeaders - Headers to use when no OIDC is configured
 * @returns {Record<string, string>}
 */
function resolveAuthHeadersWithFallback({ oidcProvider, awsOidcProvider, buildOidcHeaders, staticHeaders }) {
  const oidcHeaders = resolveOidcAuthHeaders({ oidcProvider, awsOidcProvider, buildOidcHeaders });
  if (oidcHeaders !== null) {
    return oidcHeaders;
  }
  return staticHeaders;
}

/**
 * Build the shared "OIDC unavailable" response scaffold used by provider
 * adapters that support GitHub OIDC authentication.
 *
 * Centralises the repeated request-time (`unconfiguredResponseWhen`) and
 * health-check (`unavailableWhen`) callbacks so that OIDC retryability, error
 * wording, and the "requested vs configured" distinction stay in sync across
 * provider adapters instead of being re-implemented in each one.
 *
 * - When OIDC was requested and is configured (token infra initialised, but
 *   no token available yet), both callbacks report `unavailableMessage` and
 *   the request-time response is marked retryable.
 * - When OIDC was requested but could not be configured at all (e.g. missing
 *   required env vars), both callbacks report `unconfiguredMessage` (falling
 *   back to `unavailableMessage` when not provided) and the request-time
 *   response is not retryable.
 * - When OIDC was not requested, both callbacks return null so callers fall
 *   through to the provider's static-key not-configured/health messaging.
 *
 * @param {object} opts
 * @param {boolean} opts.requested - Whether the caller asked for OIDC auth for this provider
 * @param {boolean} opts.configured - Whether the OIDC provider was successfully initialised (the token itself may not be available yet)
 * @param {string} opts.unavailableMessage - Message once OIDC is configured but no token is available yet (retryable)
 * @param {string} [opts.unconfiguredMessage] - Message when OIDC was requested but could not be initialised at all. Defaults to unavailableMessage when omitted.
 * @returns {{
 *   unconfiguredResponseWhen: () => ({ kind: 'provider_not_configured', message: string, retryable: boolean }|null),
 *   unavailableWhen: () => ({ message: string, status: string }|null),
 * }}
 */
function buildOidcUnavailableScaffold({ requested, configured, unavailableMessage, unconfiguredMessage }) {
  const message = configured ? unavailableMessage : (unconfiguredMessage || unavailableMessage);
  return {
    unconfiguredResponseWhen: () => (requested
      ? { kind: 'provider_not_configured', message, retryable: !!configured }
      : null),
    unavailableWhen: () => (requested ? { message, status: 'unavailable' } : null),
  };
}

module.exports = {
  isValidHeaderName,
  validateAuthHeaderEnv,
  createOidcRuntimeAdapterMethods,
  resolveOidcAuthHeaders,
  resolveAuthHeadersWithFallback,
  buildOidcUnavailableScaffold,
};
