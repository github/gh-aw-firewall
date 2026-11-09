'use strict';

const { mintGitHubOidcToken, httpPost } = require('./github-oidc');
const { BaseOidcTokenProvider } = require('./oidc-token-provider-base');

const OPENAI_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
const DEFAULT_OPENAI_OIDC_AUDIENCE = 'https://api.openai.com/v1';
const MAX_TOKEN_LIFETIME_SECS = 3600;

class OpenAIOidcTokenProvider extends BaseOidcTokenProvider {
  constructor(config) {
    super('openai_oidc', config);
    if (!config.identityProviderId) {
      throw new Error('OpenAIOidcTokenProvider requires identityProviderId');
    }
    if (!config.serviceAccountId) {
      throw new Error('OpenAIOidcTokenProvider requires serviceAccountId');
    }

    this._requestUrl = config.requestUrl;
    this._requestToken = config.requestToken;
    this._identityProviderId = config.identityProviderId;
    this._serviceAccountId = config.serviceAccountId;
    this._oidcAudience = config.oidcAudience || DEFAULT_OPENAI_OIDC_AUDIENCE;
    this._cachedToken = null;
    this._httpPost = httpPost;
  }

  async _exchangeForOpenAIToken(oidcJwt) {
    const body = {
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      subject_token: oidcJwt,
      identity_provider_id: this._identityProviderId,
      service_account_id: this._serviceAccountId,
    };
    const response = await this._httpPost(
      OPENAI_TOKEN_ENDPOINT,
      JSON.stringify(body),
      {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    );

    if (response.statusCode !== 200) {
      throw new Error(`OpenAI OAuth token exchange failed: HTTP ${response.statusCode}`);
    }

    const data = JSON.parse(response.body);
    if (typeof data.access_token !== 'string' || !data.access_token) {
      throw new Error('OpenAI OAuth response missing "access_token" field');
    }
    const expiresIn = Number.isFinite(data.expires_in) && data.expires_in > 0
      ? Math.min(data.expires_in, MAX_TOKEN_LIFETIME_SECS)
      : MAX_TOKEN_LIFETIME_SECS;
    return { access_token: data.access_token, expires_in: expiresIn };
  }

  async _refreshToken() {
    const oidcJwt = await mintGitHubOidcToken({
      requestUrl: this._requestUrl,
      requestToken: this._requestToken,
      audience: this._oidcAudience,
    });
    const { access_token, expires_in } = await this._exchangeForOpenAIToken(oidcJwt);
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
      identity_provider_id: this._identityProviderId,
      service_account_id: this._serviceAccountId,
      expires_in_secs: this._expiresAt - Math.floor(Date.now() / 1000),
    };
  }

  _getInitFailureLogContext() {
    return {
      audience: this._oidcAudience,
      identity_provider_id: this._identityProviderId,
      service_account_id: this._serviceAccountId,
    };
  }
}

module.exports = {
  OpenAIOidcTokenProvider,
  OPENAI_TOKEN_ENDPOINT,
  DEFAULT_OPENAI_OIDC_AUDIENCE,
  MAX_TOKEN_LIFETIME_SECS,
};
