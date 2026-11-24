'use strict';

const { mintGitHubOidcToken, httpPost } = require('./github-oidc');
const { BaseOidcTokenProvider, REFRESH_FACTOR } = require('./oidc-token-provider-base');

const MAX_TOKEN_LIFETIME_SECS = 300;

function validateDatabricksHost(host) {
  const value = typeof host === 'string' ? host.trim() : '';
  try {
    const url = new URL(value);
    if (host !== value || !/^https:\/\/[^/?#\\\s]+\/?$/i.test(value) || url.protocol !== 'https:'
      || !url.hostname || /[\[\]]/.test(url.hostname) || (url.port && Number(url.port) < 1)
      || url.username || url.password || url.pathname !== '/'
      || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {
    throw new Error('Databricks OIDC requires AWF_AUTH_DATABRICKS_HOST to be an HTTPS workspace origin without credentials, path, query, or fragment');
  }
}

function positiveLifetime(value) {
  const numeric = typeof value === 'number' ? value
    : typeof value === 'string' && /^\+?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(value.trim())
      ? Number(value.trim()) : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error('Databricks OIDC token exchange returned invalid expires_in');
  }
  return numeric;
}

function githubExpiry(jwt) {
  const parts = jwt.split('.');
  if (parts.length !== 3 || parts.some(part => !part)) {
    throw new Error('Databricks OIDC received an invalid GitHub JWT');
  }
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('Databricks OIDC received an invalid GitHub JWT payload');
  }
  if (!claims || typeof claims !== 'object') {
    throw new Error('Databricks OIDC received an invalid GitHub JWT payload');
  }
  if (!Object.prototype.hasOwnProperty.call(claims, 'exp')) return Infinity;
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= 0) {
    throw new Error('Databricks OIDC received an invalid GitHub JWT expiry');
  }
  return claims.exp;
}

class DatabricksOidcTokenProvider extends BaseOidcTokenProvider {
  constructor(config) {
    super('databricks_oidc', config);
    this._host = validateDatabricksHost(config.host);
    this._oidcAudience = typeof config.oidcAudience === 'string' ? config.oidcAudience.trim() : '';
    if (!this._oidcAudience) {
      throw new Error('Databricks OIDC requires AWF_AUTH_OIDC_AUDIENCE');
    }
    if (typeof config.requestUrl !== 'string' || !config.requestUrl.trim()
      || typeof config.requestToken !== 'string' || !config.requestToken.trim()) {
      throw new Error('Databricks OIDC requires ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN (permissions: id-token: write)');
    }
    this._requestUrl = config.requestUrl;
    this._requestToken = config.requestToken;
    this._clientId = typeof config.clientId === 'string' ? config.clientId.trim() : '';
    this._cachedToken = null;
  }

  async _doRefresh() {
    let jwt;
    try {
      jwt = await mintGitHubOidcToken({
        requestUrl: this._requestUrl,
        requestToken: this._requestToken,
        audience: this._oidcAudience,
      });
    } catch {
      // The shared transport may include response bodies or credentials in errors.
      throw new Error('Databricks OIDC GitHub token request failed');
    }
    if (typeof jwt !== 'string' || !jwt || /[\s\x00-\x1f\x7f]/.test(jwt)) {
      throw new Error('Databricks OIDC received an invalid GitHub token');
    }
    const subjectExpiresAt = githubExpiry(jwt);
    const startedAt = this._nowSeconds();
    if (subjectExpiresAt <= startedAt) {
      throw new Error('Databricks OIDC GitHub token has expired');
    }

    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      scope: 'all-apis',
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      subject_token: jwt,
      ...(this._clientId ? { client_id: this._clientId } : {}),
    }).toString();
    let response;
    try {
      response = await httpPost(`${this._host}/oidc/v1/token`, body, {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      });
    } catch {
      throw new Error('Databricks OIDC token exchange transport failed');
    }
    if (!response || response.statusCode !== 200) {
      const status = response?.statusCode;
      const safeStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? ` (HTTP ${status})` : '';
      throw new Error(`Databricks OIDC token exchange failed${safeStatus}`);
    }
    let data;
    try {
      data = JSON.parse(response.body);
    } catch {
      throw new Error('Databricks OIDC token exchange returned invalid JSON');
    }
    if (!data || typeof data.access_token !== 'string' || !data.access_token
      || /[^\x21-\x7e]/.test(data.access_token)) {
      throw new Error('Databricks OIDC token exchange returned an invalid access_token');
    }
    const expiresAt = Math.min(
      startedAt + positiveLifetime(data.expires_in),
      startedAt + MAX_TOKEN_LIFETIME_SECS,
      subjectExpiresAt,
    );
    const expiresIn = expiresAt - this._nowSeconds();
    if (expiresIn <= 0) {
      throw new Error('Databricks OIDC token exchange returned an expired token lifetime');
    }
    this._storeAndScheduleRefresh(data.access_token, expiresIn);
  }

  _nowSeconds() { return Date.now() / 1000; }
  _getRefreshDelayMs(expiresIn) { return Math.max(1, Math.floor(expiresIn * REFRESH_FACTOR * 1000)); }
  _getCachedValue() { return this._cachedToken; }
  _setCachedValue(value) { this._cachedToken = value; }
  _getInitSuccessLogContext() { return { expires_in_secs: this._expiresAt - this._nowSeconds() }; }
  _getInitFailureLogContext() { return {}; }
}

module.exports = { DatabricksOidcTokenProvider, validateDatabricksHost, MAX_TOKEN_LIFETIME_SECS };
