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
    this._isShutdown = false;
  }

  /**
   * Initialize by acquiring the first token/credentials.
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this._isShutdown) return;

    for (let attempt = 1; attempt <= this._maxInitRetries; attempt++) {
      if (this._isShutdown) return;
      try {
        await this._doRefresh();
        if (this._isShutdown) return;
        this._initialized = true;
        this._initError = null;
        logRequest('info', `${this._providerPrefix}_init_success`, this._getInitSuccessLogContext());
        return;
      } catch (err) {
        if (this._isShutdown) return;
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
    if (this._isShutdown) return;
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

  /**
   * Get the current cached token synchronously.
   * Returns null if no valid token is available.
   * @returns {unknown|null}
   */
  getToken() {
    const now = Math.floor(Date.now() / 1000);
    const cached = this._getCachedValue();
    if (cached && this._expiresAt > now) {
      return cached;
    }
    if (!this._refreshInFlight) {
      this._scheduleRefresh(0);
    }
    return null;
  }

  shutdown() {
    this._isShutdown = true;
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  /** @param {number} delayMs */
  _scheduleRefresh(delayMs) {
    if (this._isShutdown) return;
    scheduleRefresh(this, delayMs, () => this._doRefresh(), this._providerPrefix);
  }

  /**
   * Store the new cached value, record expiry, and schedule the next refresh.
   * @param {unknown} value - token string or credentials object to cache
   * @param {number} expiresIn - token lifetime in seconds
   */
  _storeAndScheduleRefresh(value, expiresIn) {
    const now = Math.floor(Date.now() / 1000);
    this._setCachedValue(value);
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
   * @param {unknown} value
   */
  _setCachedValue(value) {
    throw new Error('_setCachedValue() must be implemented by subclasses');
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
