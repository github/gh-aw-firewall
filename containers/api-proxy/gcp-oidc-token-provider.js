'use strict';

/**
 * OIDC Token Provider for GCP Workload Identity Federation.
 *
 * Mints a GitHub Actions OIDC token, exchanges it for a GCP access token
 * via the Security Token Service, optionally impersonates a service account,
 * caches the result, and proactively refreshes before expiry.
 *
 * Token flow:
 *   1. Request GitHub OIDC JWT from Actions runtime
 *   2. Exchange JWT for GCP federated access token via STS
 *   3. (Optional) Impersonate service account for short-lived OAuth2 token
 *   4. Cache token, schedule refresh at 75% of lifetime
 *   5. Serve cached token synchronously via getToken()
 */

const { mintGitHubOidcToken, httpPost } = require('./github-oidc');
const { logRequest } = require('./logging');

// Refresh at 75% of token lifetime
const REFRESH_FACTOR = 0.75;
// Minimum seconds before expiry to trigger refresh
const MIN_REFRESH_MARGIN_SECS = 300;
// Retry delay after failed refresh (ms)
const REFRESH_RETRY_DELAY_MS = 30_000;
// Maximum retries for initial token acquisition
const MAX_INIT_RETRIES = 3;

/**
 * @typedef {Object} GcpOidcTokenProviderConfig
 * @property {string} requestUrl - ACTIONS_ID_TOKEN_REQUEST_URL
 * @property {string} requestToken - ACTIONS_ID_TOKEN_REQUEST_TOKEN
 * @property {string} workloadIdentityProvider - Full resource name of the WI provider
 * @property {string} [serviceAccount] - GCP service account email to impersonate (optional)
 * @property {string} [oidcAudience] - Audience for GitHub OIDC token (default: workloadIdentityProvider value)
 * @property {string} [scope] - OAuth2 scope (default: https://www.googleapis.com/auth/cloud-platform)
 * @property {number} [retryDelayMs] - Retry delay after failed refresh (default: 30000)
 * @property {number} [maxInitRetries] - Maximum retries for initial token acquisition (default: 3)
 */

class GcpOidcTokenProvider {
  /**
   * @param {GcpOidcTokenProviderConfig} config
   */
  constructor(config) {
    this._requestUrl = config.requestUrl;
    this._requestToken = config.requestToken;
    this._workloadIdentityProvider = config.workloadIdentityProvider;
    this._serviceAccount = config.serviceAccount || null;
    this._oidcAudience = config.oidcAudience || config.workloadIdentityProvider;
    this._scope = config.scope || 'https://www.googleapis.com/auth/cloud-platform';
    this._retryDelayMs = config.retryDelayMs ?? REFRESH_RETRY_DELAY_MS;
    this._maxInitRetries = config.maxInitRetries ?? MAX_INIT_RETRIES;

    // Token state
    this._cachedToken = null;
    this._expiresAt = 0;
    this._refreshTimer = null;
    this._refreshInFlight = null;
    this._initialized = false;
    this._initError = null;
  }

  /**
   * Initialize by acquiring the first token.
   * @returns {Promise<void>}
   */
  async initialize() {
    for (let attempt = 1; attempt <= this._maxInitRetries; attempt++) {
      try {
        await this._refreshToken();
        this._initialized = true;
        this._initError = null;
        logRequest('info', 'gcp_oidc_init_success', {
          workload_identity_provider: this._workloadIdentityProvider,
          service_account: this._serviceAccount || '(direct access)',
          expires_in_secs: this._expiresAt - Math.floor(Date.now() / 1000),
        });
        return;
      } catch (err) {
        this._initError = err;
        logRequest('warn', 'gcp_oidc_init_retry', {
          attempt,
          max_retries: this._maxInitRetries,
          error: err.message,
        });
        if (attempt < this._maxInitRetries) {
          await this._sleep(this._retryDelayMs * attempt);
        }
      }
    }
    logRequest('error', 'gcp_oidc_init_failed', {
      error: this._initError?.message,
      workload_identity_provider: this._workloadIdentityProvider,
    });
  }

  /** @returns {string|null} */
  getToken() {
    const now = Math.floor(Date.now() / 1000);
    if (this._cachedToken && this._expiresAt > now) {
      return this._cachedToken;
    }
    if (!this._refreshInFlight) {
      this._scheduleRefresh(0);
    }
    return null;
  }

  /** @returns {boolean} */
  isReady() {
    const now = Math.floor(Date.now() / 1000);
    return !!(this._cachedToken && this._expiresAt > now);
  }

  shutdown() {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  /**
   * Exchange GitHub OIDC JWT for a GCP federated access token via STS.
   * @param {string} oidcJwt
   * @returns {Promise<{access_token: string, expires_in: number}>}
   */
  async _exchangeForGcpToken(oidcJwt) {
    const stsUrl = 'https://sts.googleapis.com/v1/token';

    const body = JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience: `//iam.googleapis.com/${this._workloadIdentityProvider}`,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      subject_token: oidcJwt,
    });

    const response = await httpPost(stsUrl, body, {
      'Content-Type': 'application/json',
    });

    if (response.statusCode !== 200) {
      throw new Error(`GCP STS token exchange failed: HTTP ${response.statusCode} — ${response.body}`);
    }

    const data = JSON.parse(response.body);
    if (!data.access_token) {
      throw new Error('GCP STS response missing "access_token" field');
    }
    return {
      access_token: data.access_token,
      expires_in: data.expires_in || 3600,
    };
  }

  /**
   * Impersonate a service account to get a short-lived OAuth2 access token.
   * @param {string} federatedToken - The federated access token from STS
   * @returns {Promise<{access_token: string, expires_in: number}>}
   */
  async _impersonateServiceAccount(federatedToken) {
    const url = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${this._serviceAccount}:generateAccessToken`;

    const body = JSON.stringify({
      scope: [this._scope],
      lifetime: '3600s',
    });

    const response = await httpPost(url, body, {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${federatedToken}`,
    });

    if (response.statusCode !== 200) {
      throw new Error(`GCP service account impersonation failed: HTTP ${response.statusCode} — ${response.body}`);
    }

    const data = JSON.parse(response.body);
    if (!data.accessToken) {
      throw new Error('GCP impersonation response missing "accessToken" field');
    }

    // Parse expireTime (ISO 8601) to compute expires_in
    const expireTime = new Date(data.expireTime);
    const expiresIn = Math.floor((expireTime.getTime() - Date.now()) / 1000);

    return {
      access_token: data.accessToken,
      expires_in: expiresIn > 0 ? expiresIn : 3600,
    };
  }

  /**
   * Full token refresh: GitHub OIDC → GCP STS → (optional) SA impersonation.
   */
  async _refreshToken() {
    const oidcJwt = await mintGitHubOidcToken({
      requestUrl: this._requestUrl,
      requestToken: this._requestToken,
      audience: this._oidcAudience,
    });

    const { access_token: federatedToken, expires_in: federatedExpiresIn } =
      await this._exchangeForGcpToken(oidcJwt);

    let accessToken, expiresIn;
    if (this._serviceAccount) {
      const result = await this._impersonateServiceAccount(federatedToken);
      accessToken = result.access_token;
      expiresIn = result.expires_in;
    } else {
      accessToken = federatedToken;
      expiresIn = federatedExpiresIn;
    }

    const now = Math.floor(Date.now() / 1000);
    this._cachedToken = accessToken;
    this._expiresAt = now + expiresIn;

    const refreshInSecs = Math.max(
      0,
      Math.min(
        expiresIn * REFRESH_FACTOR,
        expiresIn - MIN_REFRESH_MARGIN_SECS
      )
    );
    this._scheduleRefresh(Math.floor(refreshInSecs * 1000));
  }

  /** @param {number} delayMs */
  _scheduleRefresh(delayMs) {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => {
      this._refreshInFlight = this._refreshToken()
        .then(() => {
          logRequest('info', 'gcp_oidc_refresh_success', {
            expires_in_secs: this._expiresAt - Math.floor(Date.now() / 1000),
          });
        })
        .catch((err) => {
          logRequest('error', 'gcp_oidc_refresh_failed', { error: err.message });
          const now = Math.floor(Date.now() / 1000);
          if (this._expiresAt > now) {
            this._scheduleRefresh(this._retryDelayMs);
          }
        })
        .finally(() => { this._refreshInFlight = null; });
    }, delayMs);
    if (this._refreshTimer.unref) this._refreshTimer.unref();
  }

  /** @param {number} ms */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { GcpOidcTokenProvider };
