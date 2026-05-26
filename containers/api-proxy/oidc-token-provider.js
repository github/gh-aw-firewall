'use strict';

/**
 * OIDC Token Provider for Azure Workload Identity Federation.
 *
 * Mints a GitHub Actions OIDC token, exchanges it for an Azure AD access token
 * via workload identity federation, caches the result, and proactively refreshes
 * before expiry.
 *
 * Token flow:
 *   1. Request GitHub OIDC JWT from Actions runtime (with audience for Azure)
 *   2. Exchange JWT for Azure AD access token via token endpoint
 *   3. Cache token, schedule refresh at 75% of lifetime
 *   4. Serve cached token synchronously via getToken()
 */

const { mintGitHubOidcToken, httpPost } = require('./github-oidc');
const {
  BaseOidcTokenProvider,
} = require('./oidc-token-provider-base');

/**
 * @typedef {Object} OidcTokenProviderConfig
 * @property {string} requestUrl - ACTIONS_ID_TOKEN_REQUEST_URL
 * @property {string} requestToken - ACTIONS_ID_TOKEN_REQUEST_TOKEN
 * @property {string} tenantId - Azure AD tenant ID
 * @property {string} clientId - Azure AD app/client ID (federated credential)
 * @property {string} [oidcAudience] - Audience for GitHub OIDC token (default: api://AzureADTokenExchange)
 * @property {string} [azureScope] - Azure token scope (default: https://cognitiveservices.azure.com/.default)
 * @property {string} [azureCloud] - Azure cloud (public, usgovernment, china) for login endpoint
 * @property {number} [retryDelayMs] - Retry delay after failed refresh (default: 30000)
 * @property {number} [maxInitRetries] - Maximum retries for initial token acquisition (default: 3)
 */

class OidcTokenProvider extends BaseOidcTokenProvider {
  /**
   * @param {OidcTokenProviderConfig} config
   */
  constructor(config) {
    super('oidc', config);
    this._requestUrl = config.requestUrl;
    this._requestToken = config.requestToken;
    this._tenantId = config.tenantId;
    this._clientId = config.clientId;
    this._oidcAudience = config.oidcAudience || 'api://AzureADTokenExchange';
    this._azureScope = config.azureScope || 'https://cognitiveservices.azure.com/.default';
    this._loginHost = this._resolveLoginHost(config.azureCloud);

    // Token state
    this._cachedToken = null;
  }

  /**
   * Resolve the Azure login endpoint for the specified cloud.
   * @param {string} [cloud]
   * @returns {string}
   */
  _resolveLoginHost(cloud) {
    switch (cloud) {
      case 'usgovernment': return 'login.microsoftonline.us';
      case 'china': return 'login.chinacloudapi.cn';
      default: return 'login.microsoftonline.com';
    }
  }

  /**
   * Get the current cached token synchronously.
   * Returns null if no valid token is available.
   * @returns {string|null}
   */
  getToken() {
    const now = Math.floor(Date.now() / 1000);
    if (this._cachedToken && this._expiresAt > now) {
      return this._cachedToken;
    }
    // Token expired and refresh hasn't replaced it — trigger emergency refresh
    if (!this._refreshInFlight) {
      this._scheduleRefresh(0);
    }
    return null;
  }

  /**
   * Mint a GitHub OIDC token with the specified audience.
   * @returns {Promise<string>} The GitHub-issued JWT
   */
  async _mintGitHubOidcToken() {
    return mintGitHubOidcToken({
      requestUrl: this._requestUrl,
      requestToken: this._requestToken,
      audience: this._oidcAudience,
    });
  }

  /**
   * Exchange a GitHub OIDC JWT for an Azure AD access token via workload identity federation.
   * @param {string} oidcJwt - The GitHub-issued JWT
   * @returns {Promise<{access_token: string, expires_in: number}>}
   */
  async _exchangeForAzureToken(oidcJwt) {
    const tokenEndpoint = `https://${this._loginHost}/${this._tenantId}/oauth2/v2.0/token`;

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this._clientId,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: oidcJwt,
      scope: this._azureScope,
    }).toString();

    let response;
    try {
      response = await this._httpPost(tokenEndpoint, body, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });
    } catch (err) {
      if (err?.message === 'Token exchange timeout') {
        throw new Error('Azure token exchange timeout');
      }
      throw err;
    }

    if (response.statusCode !== 200) {
      throw new Error(`Azure token exchange failed: HTTP ${response.statusCode} — ${response.body}`);
    }

    const data = JSON.parse(response.body);
    if (!data.access_token) {
      throw new Error('Azure token response missing "access_token" field');
    }
    return { access_token: data.access_token, expires_in: data.expires_in || 3600 };
  }

  /**
   * Perform full token refresh: mint GitHub OIDC → exchange for Azure AD.
   */
  async _refreshToken() {
    const oidcJwt = await this._mintGitHubOidcToken();
    const { access_token, expires_in } = await this._exchangeForAzureToken(oidcJwt);

    this._storeAndScheduleRefresh(access_token, expires_in);
  }

  /**
   * HTTP POST helper.
   * @param {string} url
   * @param {string} body
   * @param {Record<string, string>} headers
   * @returns {Promise<{statusCode: number, body: string}>}
   */
  _httpPost(url, body, headers) {
    return httpPost(url, body, headers);
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
      tenant_id: this._tenantId,
      client_id: this._clientId,
      scope: this._azureScope,
      expires_in_secs: this._expiresAt - Math.floor(Date.now() / 1000),
    };
  }

  _getInitFailureLogContext() {
    return {
      tenant_id: this._tenantId,
      client_id: this._clientId,
    };
  }
}

module.exports = { OidcTokenProvider };
