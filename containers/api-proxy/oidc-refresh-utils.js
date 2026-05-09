'use strict';

/**
 * Shared refresh/scheduling utilities for OIDC token providers.
 *
 * Both AwsOidcTokenProvider and GcpOidcTokenProvider use identical logic for:
 * - Scheduling proactive credential/token refresh before expiry
 * - Retry on failed refresh while credentials/tokens are still valid
 * - Sleep helper for retry backoff
 *
 * Each provider passes a `refreshFn` and a `providerPrefix` (e.g., 'aws_oidc'
 * or 'gcp_oidc') so log events remain provider-specific.
 */

const { logRequest } = require('./logging');

/**
 * Schedule a proactive refresh of credentials/tokens.
 *
 * Clears any existing timer, schedules `refreshFn` after `delayMs`,
 * logs success/failure with provider-specific event names, and retries
 * on failure if credentials are still valid.
 *
 * @param {Object} state - Provider state object (must have _refreshTimer,
 *   _refreshInFlight, _expiresAt, _retryDelayMs properties)
 * @param {number} delayMs - Milliseconds before running the refresh
 * @param {Function} refreshFn - Async function that refreshes credentials/tokens
 * @param {string} providerPrefix - Log event prefix (e.g., 'aws_oidc' or 'gcp_oidc')
 */
function scheduleRefresh(state, delayMs, refreshFn, providerPrefix) {
  if (state._refreshTimer) clearTimeout(state._refreshTimer);
  state._refreshTimer = setTimeout(() => {
    state._refreshInFlight = refreshFn()
      .then(() => {
        logRequest('info', `${providerPrefix}_refresh_success`, {
          expires_in_secs: state._expiresAt - Math.floor(Date.now() / 1000),
        });
      })
      .catch((err) => {
        logRequest('error', `${providerPrefix}_refresh_failed`, { error: err.message });
        const now = Math.floor(Date.now() / 1000);
        if (state._expiresAt > now) {
          scheduleRefresh(state, state._retryDelayMs, refreshFn, providerPrefix);
        }
      })
      .finally(() => { state._refreshInFlight = null; });
  }, delayMs);
  if (state._refreshTimer.unref) state._refreshTimer.unref();
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { scheduleRefresh, sleep };
