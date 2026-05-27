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
const {
  BaseOidcTokenProvider,
} = require('./oidc-token-provider-base');

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

class GcpOidcTokenProvider extends BaseOidcTokenProvider {
  /**
   * @param {GcpOidcTokenProviderConfig} config
   */
  constructor(config) {
    super('gcp_oidc', config);
    this._requestUrl = config.requestUrl;
    this._requestToken = config.requestToken;
    this._workloadIdentityProvider = config.workloadIdentityProvider;
    this._serviceAccount = config.serviceAccount || null;
    this._oidcAudience = config.oidcAudience || config.workloadIdentityProvider;
    this._scope = config.scope || 'https://www.googleapis.com/auth/cloud-platform';

    // Token state
    this._cachedToken = null;
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

    this._storeAndScheduleRefresh(accessToken, expiresIn);
  }

  async _doRefresh() {
    await this._refreshToken();
  }

  _getCachedValue() {
    return this._cachedToken;
  }

  _setCachedValue(value) {
    this._cachedToken = value;
  }

  _getInitSuccessLogContext() {
    return {
      workload_identity_provider: this._workloadIdentityProvider,
      service_account: this._serviceAccount || '(direct access)',
      expires_in_secs: this._expiresAt - Math.floor(Date.now() / 1000),
    };
  }

  _getInitFailureLogContext() {
    return {
      workload_identity_provider: this._workloadIdentityProvider,
    };
  }
}

module.exports = { GcpOidcTokenProvider };
