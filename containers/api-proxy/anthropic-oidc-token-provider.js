'use strict';

const { mintGitHubOidcToken, httpPost } = require('./github-oidc');
const {
  BaseOidcTokenProvider,
  REFRESH_FACTOR,
  MIN_REFRESH_MARGIN_SECS,
} = require('./oidc-token-provider-base');

/**
 * @typedef {Object} AnthropicOidcTokenProviderConfig
 * @property {string} requestUrl - ACTIONS_ID_TOKEN_REQUEST_URL
 * @property {string} requestToken - ACTIONS_ID_TOKEN_REQUEST_TOKEN
 * @property {string} [oidcAudience] - Audience for GitHub OIDC token (default: https://api.anthropic.com)
 * @property {string} [scope] - Optional OAuth scope
 * @property {number} [retryDelayMs] - Retry delay after failed refresh (default: 30000)
 * @property {number} [maxInitRetries] - Maximum retries for initial token acquisition (default: 3)
 */

class AnthropicOidcTokenProvider extends BaseOidcTokenProvider {
  /**
   * @param {AnthropicOidcTokenProviderConfig} config
   */
  constructor(config) {
    super('anthropic_oidc', config);
    this._requestUrl = config.requestUrl;
    this._requestToken = config.requestToken;
    this._oidcAudience = config.oidcAudience || 'https://api.anthropic.com';
    this._scope = config.scope;

    /** @type {string|null} */
    this._cachedToken = null;
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

  /**
   * Exchange GitHub OIDC JWT for an Anthropic workload identity token.
   * @param {string} oidcJwt
   * @returns {Promise<{access_token: string, expires_in: number}>}
   */
  async _exchangeForAnthropicToken(oidcJwt) {
    const response = await httpPost(
      'https://api.anthropic.com/v1/oauth/token',
      JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: oidcJwt,
        ...(this._scope !== undefined ? { scope: this._scope } : {}),
      }),
      {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      }
    );

    if (response.statusCode !== 200) {
      throw new Error(`Anthropic OAuth token exchange failed: HTTP ${response.statusCode} — ${response.body}`);
    }

    const data = JSON.parse(response.body);
    if (!data.access_token) {
      throw new Error('Anthropic OAuth response missing "access_token" field');
    }

    return {
      access_token: data.access_token,
      expires_in: data.expires_in || 3600,
    };
  }

  async _refreshToken() {
    const oidcJwt = await mintGitHubOidcToken({
      requestUrl: this._requestUrl,
      requestToken: this._requestToken,
      audience: this._oidcAudience,
    });

    const { access_token, expires_in } = await this._exchangeForAnthropicToken(oidcJwt);

    const now = Math.floor(Date.now() / 1000);
    this._cachedToken = access_token;
    this._expiresAt = now + expires_in;

    const refreshInSecs = Math.max(
      0,
      Math.min(
        expires_in * REFRESH_FACTOR,
        expires_in - MIN_REFRESH_MARGIN_SECS
      )
    );
    this._scheduleRefresh(Math.floor(refreshInSecs * 1000));
  }

  async _doRefresh() {
    await this._refreshToken();
  }

  _getCachedValue() {
    return this._cachedToken;
  }

  _getInitSuccessLogContext() {
    return {
      audience: this._oidcAudience,
      expires_in_secs: this._expiresAt - Math.floor(Date.now() / 1000),
    };
  }

  _getInitFailureLogContext() {
    return {
      audience: this._oidcAudience,
    };
  }
}

module.exports = { AnthropicOidcTokenProvider };
