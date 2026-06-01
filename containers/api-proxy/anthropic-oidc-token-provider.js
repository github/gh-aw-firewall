'use strict';

const { mintGitHubOidcToken, httpPost } = require('./github-oidc');
const {
  BaseOidcTokenProvider,
} = require('./oidc-token-provider-base');

function stringifyError(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

/**
 * @typedef {Object} AnthropicOidcTokenProviderConfig
 * @property {string} requestUrl - ACTIONS_ID_TOKEN_REQUEST_URL
 * @property {string} requestToken - ACTIONS_ID_TOKEN_REQUEST_TOKEN
 * @property {string} federationRuleId - Anthropic federation rule ID (e.g. fdrl_...)
 * @property {string} organizationId - Anthropic organization UUID
 * @property {string} serviceAccountId - Anthropic service account ID (e.g. svac_...)
 * @property {string} [workspaceId] - Anthropic workspace ID (required when the federation rule covers multiple workspaces)
 * @property {string} [oidcAudience] - Audience for GitHub OIDC token (default: https://api.anthropic.com)
 * @property {string} [tokenEndpoint] - Anthropic OAuth token exchange endpoint (default: https://api.anthropic.com/v1/oauth/token)
 * @property {number} [retryDelayMs] - Retry delay after failed refresh (default: 30000)
 * @property {number} [maxInitRetries] - Maximum retries for initial token acquisition (default: 3)
 */

class AnthropicOidcTokenProvider extends BaseOidcTokenProvider {
  /**
   * @param {AnthropicOidcTokenProviderConfig} config
   */
  constructor(config) {
    super('anthropic_oidc', config);

    if (!config.federationRuleId) {
      throw new Error('AnthropicOidcTokenProvider requires federationRuleId');
    }
    if (!config.organizationId) {
      throw new Error('AnthropicOidcTokenProvider requires organizationId');
    }
    if (!config.serviceAccountId) {
      throw new Error('AnthropicOidcTokenProvider requires serviceAccountId');
    }

    this._requestUrl = config.requestUrl;
    this._requestToken = config.requestToken;
    this._federationRuleId = config.federationRuleId;
    this._organizationId = config.organizationId;
    this._serviceAccountId = config.serviceAccountId;
    // Normalize empty strings to undefined so workspace_id is never sent as ""
    const ws = config.workspaceId != null ? config.workspaceId.trim() : undefined;
    this._workspaceId = ws || undefined;
    this._oidcAudience = config.oidcAudience || 'https://api.anthropic.com';
    const tokenEndpoint = config.tokenEndpoint != null ? config.tokenEndpoint.trim() : '';
    this._tokenEndpoint = tokenEndpoint || 'https://api.anthropic.com/v1/oauth/token';

    /** @type {string|null} */
    this._cachedToken = null;

    // Stored as instance method so tests can spy/stub without module-level mocking
    this._httpPost = httpPost;
  }

  /**
   * Exchange GitHub OIDC JWT for an Anthropic workload identity token.
   * @param {string} oidcJwt
   * @returns {Promise<{access_token: string, expires_in: number}>}
   */
  async _exchangeForAnthropicToken(oidcJwt) {
    const body = {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: oidcJwt,
      federation_rule_id: this._federationRuleId,
      organization_id: this._organizationId,
      service_account_id: this._serviceAccountId,
    };
    if (this._workspaceId !== undefined) {
      body.workspace_id = this._workspaceId;
    }

    const response = await this._httpPost(
      this._tokenEndpoint,
      JSON.stringify(body),
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
    let oidcJwt;
    try {
      oidcJwt = await mintGitHubOidcToken({
        requestUrl: this._requestUrl,
        requestToken: this._requestToken,
        audience: this._oidcAudience,
      });
    } catch (error) {
      throw new Error(`Anthropic upstream OIDC JWT mint failed: ${stringifyError(error)}`, {
        cause: error,
      });
    }

    let exchangeResponse;
    try {
      exchangeResponse = await this._exchangeForAnthropicToken(oidcJwt);
    } catch (error) {
      throw new Error(`Anthropic OAuth exchange failed after JWT mint: ${stringifyError(error)}`, {
        cause: error,
      });
    }

    const { access_token, expires_in } = exchangeResponse;

    this._storeAndScheduleRefresh(access_token, expires_in);
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
      audience: this._oidcAudience,
      federation_rule_id: this._federationRuleId,
      organization_id: this._organizationId,
      service_account_id: this._serviceAccountId,
      expires_in_secs: this._expiresAt - Math.floor(Date.now() / 1000),
    };
  }

  _getInitFailureLogContext() {
    return {
      audience: this._oidcAudience,
      federation_rule_id: this._federationRuleId,
      organization_id: this._organizationId,
      service_account_id: this._serviceAccountId,
    };
  }
}

module.exports = { AnthropicOidcTokenProvider };
