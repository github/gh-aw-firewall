'use strict';

/**
 * OIDC Token Provider for AWS Workload Identity Federation.
 *
 * Mints a GitHub Actions OIDC token, exchanges it for temporary AWS
 * credentials via STS AssumeRoleWithWebIdentity, caches the result,
 * and proactively refreshes before expiry.
 *
 * Token flow:
 *   1. Request GitHub OIDC JWT from Actions runtime (audience: sts.amazonaws.com)
 *   2. Exchange JWT for temporary AWS credentials via STS AssumeRoleWithWebIdentity
 *   3. Cache credentials, schedule refresh at 75% of lifetime
 *   4. Serve cached credentials synchronously via getCredentials()
 *
 * Note: AWS uses SigV4 request signing, not Bearer tokens. The consumer
 * must use getCredentials() and sign the complete request (method, path,
 * headers, body hash) with the returned access key, secret key, and
 * session token.
 */

const { mintGitHubOidcToken, httpGet } = require('./github-oidc');
const {
  BaseOidcTokenProvider,
} = require('./oidc-token-provider-base');

/**
 * @typedef {Object} AwsCredentials
 * @property {string} accessKeyId
 * @property {string} secretAccessKey
 * @property {string} sessionToken
 */

/**
 * @typedef {Object} AwsOidcTokenProviderConfig
 * @property {string} requestUrl - ACTIONS_ID_TOKEN_REQUEST_URL
 * @property {string} requestToken - ACTIONS_ID_TOKEN_REQUEST_TOKEN
 * @property {string} roleArn - AWS IAM role ARN to assume
 * @property {string} region - AWS region (e.g., us-east-1)
 * @property {string} [roleSessionName] - Session name (default: awf-oidc-session)
 * @property {string} [oidcAudience] - Audience for GitHub OIDC token (default: sts.amazonaws.com)
 * @property {number} [retryDelayMs] - Retry delay after failed refresh (default: 30000)
 * @property {number} [maxInitRetries] - Maximum retries for initial token acquisition (default: 3)
 */

class AwsOidcTokenProvider extends BaseOidcTokenProvider {
  /**
   * @param {AwsOidcTokenProviderConfig} config
   */
  constructor(config) {
    super('aws_oidc', config);
    this._requestUrl = config.requestUrl;
    this._requestToken = config.requestToken;
    this._roleArn = config.roleArn;
    this._region = config.region;
    this._roleSessionName = config.roleSessionName || 'awf-oidc-session';
    this._oidcAudience = config.oidcAudience || 'sts.amazonaws.com';

    /** @type {AwsCredentials|null} */
    this._cachedCredentials = null;
  }

  /**
   * Get the current cached AWS credentials synchronously.
   * Returns null if no valid credentials are available.
   * @returns {AwsCredentials|null}
   */
  getCredentials() {
    const now = Math.floor(Date.now() / 1000);
    if (this._cachedCredentials && this._expiresAt > now) {
      return this._cachedCredentials;
    }
    if (!this._refreshInFlight) {
      this._scheduleRefresh(0);
    }
    return null;
  }

  /**
   * Get the AWS region for this provider.
   * @returns {string}
   */
  getRegion() {
    return this._region;
  }

  /**
   * Exchange GitHub OIDC JWT for temporary AWS credentials via STS.
   * Uses the HTTPS query API (no SDK dependency).
   * @param {string} oidcJwt
   * @returns {Promise<{credentials: AwsCredentials, expires_in: number}>}
   */
  async _assumeRoleWithWebIdentity(oidcJwt) {
    const params = new URLSearchParams({
      Action: 'AssumeRoleWithWebIdentity',
      Version: '2011-06-15',
      RoleArn: this._roleArn,
      RoleSessionName: this._roleSessionName,
      WebIdentityToken: oidcJwt,
    });

    const stsHost = this._resolveStsHost();
    const url = `https://${stsHost}/?${params.toString()}`;

    const response = await httpGet(url, {
      'Accept': 'application/json',
    });

    if (response.statusCode !== 200) {
      throw new Error(`AWS STS AssumeRoleWithWebIdentity failed: HTTP ${response.statusCode} — ${response.body}`);
    }

    // STS returns XML by default, but JSON when Accept: application/json is set
    // Parse the response to extract credentials
    const data = JSON.parse(response.body);
    const result = data.AssumeRoleWithWebIdentityResponse?.AssumeRoleWithWebIdentityResult;
    if (!result?.Credentials) {
      throw new Error('AWS STS response missing Credentials');
    }

    const creds = result.Credentials;
    const expiration = new Date(creds.Expiration);
    const expiresIn = Math.floor((expiration.getTime() - Date.now()) / 1000);

    return {
      credentials: {
        accessKeyId: creds.AccessKeyId,
        secretAccessKey: creds.SecretAccessKey,
        sessionToken: creds.SessionToken,
      },
      expires_in: expiresIn > 0 ? expiresIn : 3600,
    };
  }

  /**
   * Resolve the STS endpoint for the configured region.
   * Uses regional STS endpoints for lower latency.
   * @returns {string}
   */
  _resolveStsHost() {
    // China regions use a separate partition
    if (this._region.startsWith('cn-')) {
      return `sts.${this._region}.amazonaws.com.cn`;
    }
    // GovCloud
    if (this._region.startsWith('us-gov-')) {
      return `sts.${this._region}.amazonaws.com`;
    }
    // Standard regions — use regional endpoint
    return `sts.${this._region}.amazonaws.com`;
  }

  /**
   * Full credential refresh: GitHub OIDC → AWS STS.
   */
  async _refreshCredentials() {
    const oidcJwt = await mintGitHubOidcToken({
      requestUrl: this._requestUrl,
      requestToken: this._requestToken,
      audience: this._oidcAudience,
    });

    const { credentials, expires_in } = await this._assumeRoleWithWebIdentity(oidcJwt);

    this._storeAndScheduleRefresh(credentials, expires_in);
  }

  async _doRefresh() {
    await this._refreshCredentials();
  }

  _getCachedValue() {
    return this._cachedCredentials;
  }

  _setCachedValue(value) {
    this._cachedCredentials = value;
  }

  _getInitSuccessLogContext() {
    return {
      role_arn: this._roleArn,
      region: this._region,
      expires_in_secs: this._expiresAt - Math.floor(Date.now() / 1000),
    };
  }

  _getInitFailureLogContext() {
    return {
      role_arn: this._roleArn,
    };
  }
}

module.exports = { AwsOidcTokenProvider };
