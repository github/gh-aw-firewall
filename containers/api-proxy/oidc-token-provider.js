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

const https = require('https');
const http = require('http');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { logRequest } = require('./logging');

// Refresh at 75% of token lifetime (Azure tokens typically last 3600s)
const REFRESH_FACTOR = 0.75;
// Minimum seconds before expiry to trigger refresh
const MIN_REFRESH_MARGIN_SECS = 300;
// Retry delay after failed refresh (ms)
const REFRESH_RETRY_DELAY_MS = 30_000;
// Maximum retries for initial token acquisition
const MAX_INIT_RETRIES = 3;

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

class OidcTokenProvider {
  /**
   * @param {OidcTokenProviderConfig} config
   */
  constructor(config) {
    this._requestUrl = config.requestUrl;
    this._requestToken = config.requestToken;
    this._tenantId = config.tenantId;
    this._clientId = config.clientId;
    this._oidcAudience = config.oidcAudience || 'api://AzureADTokenExchange';
    this._azureScope = config.azureScope || 'https://cognitiveservices.azure.com/.default';
    this._loginHost = this._resolveLoginHost(config.azureCloud);
    this._retryDelayMs = config.retryDelayMs ?? REFRESH_RETRY_DELAY_MS;
    this._maxInitRetries = config.maxInitRetries ?? MAX_INIT_RETRIES;

    // Token state
    this._cachedToken = null;
    this._expiresAt = 0; // Unix timestamp (seconds)
    this._refreshTimer = null;
    this._refreshInFlight = null;
    this._initialized = false;
    this._initError = null;
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
   * Initialize the token provider by acquiring the first token.
   * Must be called (and awaited) before getToken() is usable.
   * @returns {Promise<void>}
   */
  async initialize() {
    for (let attempt = 1; attempt <= this._maxInitRetries; attempt++) {
      try {
        await this._refreshToken();
        this._initialized = true;
        this._initError = null;
        logRequest('info', 'oidc_init_success', {
          tenant_id: this._tenantId,
          client_id: this._clientId,
          scope: this._azureScope,
          expires_in_secs: this._expiresAt - Math.floor(Date.now() / 1000),
        });
        return;
      } catch (err) {
        this._initError = err;
        logRequest('warn', 'oidc_init_retry', {
          attempt,
          max_retries: this._maxInitRetries,
          error: err.message,
        });
        if (attempt < this._maxInitRetries) {
          await this._sleep(this._retryDelayMs * attempt);
        }
      }
    }
    // All retries failed — log but don't throw; getToken() will return null
    logRequest('error', 'oidc_init_failed', {
      error: this._initError?.message,
      tenant_id: this._tenantId,
      client_id: this._clientId,
    });
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
   * Whether the provider has a usable token.
   * @returns {boolean}
   */
  isReady() {
    const now = Math.floor(Date.now() / 1000);
    return !!(this._cachedToken && this._expiresAt > now);
  }

  /**
   * Stop background refresh timers.
   */
  shutdown() {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  /**
   * Mint a GitHub OIDC token with the specified audience.
   * @returns {Promise<string>} The GitHub-issued JWT
   */
  async _mintGitHubOidcToken() {
    const url = new URL(this._requestUrl);
    url.searchParams.set('audience', this._oidcAudience);

    const response = await this._httpGet(url.toString(), {
      'Authorization': `Bearer ${this._requestToken}`,
      'Accept': 'application/json',
    });

    if (response.statusCode !== 200) {
      throw new Error(`GitHub OIDC token request failed: HTTP ${response.statusCode} — ${response.body}`);
    }

    const data = JSON.parse(response.body);
    if (!data.value) {
      throw new Error('GitHub OIDC response missing "value" field');
    }
    return data.value;
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

    const response = await this._httpPost(tokenEndpoint, body, {
      'Content-Type': 'application/x-www-form-urlencoded',
    });

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

    const now = Math.floor(Date.now() / 1000);
    this._cachedToken = access_token;
    this._expiresAt = now + expires_in;

    // Schedule proactive refresh
    const refreshInSecs = Math.max(
      0,
      Math.min(
      expires_in * REFRESH_FACTOR,
      expires_in - MIN_REFRESH_MARGIN_SECS
      )
    );
    this._scheduleRefresh(Math.floor(refreshInSecs * 1000));
  }

  /**
   * Schedule a background token refresh.
   * @param {number} delayMs
   */
  _scheduleRefresh(delayMs) {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => {
      this._refreshInFlight = this._refreshToken()
        .then(() => {
          logRequest('info', 'oidc_refresh_success', {
            expires_in_secs: this._expiresAt - Math.floor(Date.now() / 1000),
          });
        })
        .catch((err) => {
          logRequest('error', 'oidc_refresh_failed', { error: err.message });
          // Retry after delay if token is still valid
          const now = Math.floor(Date.now() / 1000);
          if (this._expiresAt > now) {
            this._scheduleRefresh(this._retryDelayMs);
          }
        })
        .finally(() => { this._refreshInFlight = null; });
    }, delayMs);
    // Don't let refresh timer keep the process alive
    if (this._refreshTimer.unref) this._refreshTimer.unref();
  }

  /**
   * HTTP GET helper.
   * @param {string} url
   * @param {Record<string, string>} headers
   * @returns {Promise<{statusCode: number, body: string}>}
   */
  _httpGet(url, headers) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const mod = parsedUrl.protocol === 'https:' ? https : http;
      const req = mod.get(url, {
        headers,
        agent: this._getProxyAgent(parsedUrl),
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      });
      req.on('error', reject);
      req.setTimeout(10_000, () => { req.destroy(new Error('OIDC request timeout')); });
    });
  }

  /**
   * HTTP POST helper.
   * @param {string} url
   * @param {string} body
   * @param {Record<string, string>} headers
   * @returns {Promise<{statusCode: number, body: string}>}
   */
  _httpPost(url, body, headers) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const options = {
        method: 'POST',
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        agent: this._getProxyAgent(parsedUrl),
      };

      const mod = parsedUrl.protocol === 'https:' ? https : http;
      const req = mod.request(options, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => { responseBody += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body: responseBody }));
      });
      req.on('error', reject);
      req.setTimeout(10_000, () => { req.destroy(new Error('Azure token exchange timeout')); });
      req.write(body);
      req.end();
    });
  }

  /**
   * Build proxy agent from env vars when configured.
   * @param {URL} parsedUrl
   * @returns {import('http').Agent|undefined}
   */
  _getProxyAgent(parsedUrl) {
    const proxyUrl = parsedUrl.protocol === 'https:'
      ? (process.env.HTTPS_PROXY || process.env.HTTP_PROXY)
      : (process.env.HTTP_PROXY || process.env.HTTPS_PROXY);
    return proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
  }

  /** @param {number} ms */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { OidcTokenProvider };
