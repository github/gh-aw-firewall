'use strict';

const { logRequest } = require('./logging');
const { scheduleRefresh, sleep } = require('./oidc-refresh-utils');

const REFRESH_FACTOR = 0.75;
const MIN_REFRESH_MARGIN_SECS = 300;
const REFRESH_RETRY_DELAY_MS = 30_000;
const MAX_INIT_RETRIES = 3;

class BaseOidcTokenProvider {
  /**
   * @param {string} providerPrefix
   * @param {{retryDelayMs?: number, maxInitRetries?: number}} config
   */
  constructor(providerPrefix, config) {
    this._providerPrefix = providerPrefix;
    this._retryDelayMs = config.retryDelayMs ?? REFRESH_RETRY_DELAY_MS;
    this._maxInitRetries = config.maxInitRetries ?? MAX_INIT_RETRIES;

    this._expiresAt = 0;
    this._refreshTimer = null;
    this._refreshInFlight = null;
    this._initialized = false;
    this._initError = null;
  }

  /**
   * Initialize by acquiring the first token/credentials.
   * @returns {Promise<void>}
   */
  async initialize() {
    for (let attempt = 1; attempt <= this._maxInitRetries; attempt++) {
      try {
        await this._doRefresh();
        this._initialized = true;
        this._initError = null;
        logRequest('info', `${this._providerPrefix}_init_success`, this._getInitSuccessLogContext());
        return;
      } catch (err) {
        this._initError = err;
        logRequest('warn', `${this._providerPrefix}_init_retry`, {
          attempt,
          max_retries: this._maxInitRetries,
          error: err.message,
        });
        if (attempt < this._maxInitRetries) {
          await this._sleep(this._retryDelayMs * attempt);
        }
      }
    }
    logRequest('error', `${this._providerPrefix}_init_failed`, {
      error: this._initError?.message,
      ...this._getInitFailureLogContext(),
    });
  }

  /** @returns {boolean} */
  isReady() {
    const now = Math.floor(Date.now() / 1000);
    return !!(this._getCachedValue() && this._expiresAt > now);
  }

  shutdown() {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  /** @param {number} delayMs */
  _scheduleRefresh(delayMs) {
    scheduleRefresh(this, delayMs, () => this._doRefresh(), this._providerPrefix);
  }

  /** @param {number} ms */
  _sleep(ms) {
    return sleep(ms);
  }

  /**
   * @abstract
   * @returns {Promise<void>}
   */
  async _doRefresh() {
    throw new Error('_doRefresh() must be implemented by subclasses');
  }

  /**
   * @abstract
   * @returns {unknown}
   */
  _getCachedValue() {
    throw new Error('_getCachedValue() must be implemented by subclasses');
  }

  /**
   * @abstract
   * @returns {Record<string, unknown>}
   */
  _getInitSuccessLogContext() {
    throw new Error('_getInitSuccessLogContext() must be implemented by subclasses');
  }

  /**
   * @abstract
   * @returns {Record<string, unknown>}
   */
  _getInitFailureLogContext() {
    throw new Error('_getInitFailureLogContext() must be implemented by subclasses');
  }
}

module.exports = {
  BaseOidcTokenProvider,
  REFRESH_FACTOR,
  MIN_REFRESH_MARGIN_SECS,
  REFRESH_RETRY_DELAY_MS,
  MAX_INIT_RETRIES,
};
