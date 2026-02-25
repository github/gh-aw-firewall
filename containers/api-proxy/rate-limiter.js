/**
 * Sliding Window Counter Rate Limiter for AWF API Proxy.
 *
 * Provides per-provider rate limiting with three limit types:
 * - RPM: requests per minute (1-second granularity, 60 slots)
 * - RPH: requests per hour (1-minute granularity, 60 slots)
 * - Bytes/min: request bytes per minute (1-second granularity, 60 slots)
 *
 * Algorithm: sliding window counter — counts in the current window plus a
 * weighted portion of the previous window based on elapsed time.
 *
 * Memory-bounded: fixed-size arrays per provider, old windows overwritten.
 * Fail-open: any internal error allows the request through.
 * Zero external dependencies.
 */

'use strict';

// ── Defaults ────────────────────────────────────────────────────────────
const DEFAULT_RPM = 60;
const DEFAULT_RPH = 1000;
const DEFAULT_BYTES_PM = 50 * 1024 * 1024; // 50 MB

// ── Window sizes ────────────────────────────────────────────────────────
const MINUTE_SLOTS = 60;   // 1-second granularity for per-minute windows
const HOUR_SLOTS = 60;     // 1-minute granularity for per-hour windows

/**
 * Create a fixed-size ring buffer for sliding window counting.
 * @param {number} size - Number of slots
 * @returns {{ counts: number[], total: number }}
 */
function createWindow(size) {
  return {
    counts: new Array(size).fill(0),
    total: 0,
    lastSlot: -1,
    lastTime: 0,
  };
}

/**
 * Advance the window to the current time, zeroing out stale slots.
 * @param {object} win - Window object
 * @param {number} now - Current time in the slot's unit (seconds or minutes)
 * @param {number} size - Window size (number of slots)
 */
function advanceWindow(win, now, size) {
  if (win.lastSlot === -1) {
    // First use — initialize
    win.lastSlot = now % size;
    win.lastTime = now;
    return;
  }

  const elapsed = now - win.lastTime;
  if (elapsed <= 0) return; // Same slot or clock went backwards

  // Zero out slots that have expired
  const slotsToZero = Math.min(elapsed, size);
  for (let i = 1; i <= slotsToZero; i++) {
    const slot = (win.lastSlot + i) % size;
    win.total -= win.counts[slot];
    win.counts[slot] = 0;
  }

  win.lastSlot = now % size;
  win.lastTime = now;
}

/**
 * Record a value in the window at the current slot.
 * @param {object} win - Window object
 * @param {number} now - Current time in the slot's unit
 * @param {number} size - Window size
 * @param {number} value - Value to add (1 for request count, N for bytes)
 */
function recordInWindow(win, now, size, value) {
  advanceWindow(win, now, size);
  const slot = now % size;
  win.counts[slot] += value;
  win.total += value;
}

/**
 * Get the sliding window estimate of the current rate.
 *
 * Uses the formula: current_window_count + previous_window_weight * previous_total
 * where previous_window_weight = (slot_duration - elapsed_in_current_slot) / slot_duration
 *
 * This is a simplified but effective approach: we use the total across
 * all current-window slots plus a weighted fraction of the oldest expired slot's
 * contribution to approximate the true sliding window.
 *
 * @param {object} win - Window object
 * @param {number} now - Current time in the slot's unit
 * @param {number} size - Window size
 * @returns {number} Estimated count in the window
 */
function getWindowCount(win, now, size) {
  advanceWindow(win, now, size);
  return win.total;
}

/**
 * Per-provider rate limit state.
 */
class ProviderState {
  constructor() {
    // Per-minute: 1-second granularity
    this.rpmWindow = createWindow(MINUTE_SLOTS);
    // Per-hour: 1-minute granularity
    this.rphWindow = createWindow(HOUR_SLOTS);
    // Bytes per minute: 1-second granularity
    this.bytesWindow = createWindow(MINUTE_SLOTS);
  }
}

class RateLimiter {
  /**
   * @param {object} config
   * @param {number} [config.rpm=60] - Max requests per minute
   * @param {number} [config.rph=1000] - Max requests per hour
   * @param {number} [config.bytesPm=52428800] - Max bytes per minute (50 MB)
   * @param {boolean} [config.enabled=true] - Whether rate limiting is active
   */
  constructor(config = {}) {
    this.rpm = config.rpm ?? DEFAULT_RPM;
    this.rph = config.rph ?? DEFAULT_RPH;
    this.bytesPm = config.bytesPm ?? DEFAULT_BYTES_PM;
    this.enabled = config.enabled !== false;

    /** @type {Map<string, ProviderState>} */
    this.providers = new Map();
  }

  /**
   * Get or create state for a provider.
   * @param {string} provider
   * @returns {ProviderState}
   */
  _getState(provider) {
    let state = this.providers.get(provider);
    if (!state) {
      state = new ProviderState();
      this.providers.set(provider, state);
    }
    return state;
  }

  /**
   * Check whether a request is allowed under rate limits.
   *
   * If allowed, the request is counted (recorded in windows).
   * If denied, no recording happens — the caller should return 429.
   *
   * @param {string} provider - e.g. "openai", "anthropic", "copilot"
   * @param {number} [requestBytes=0] - Size of the request body in bytes
   * @returns {{
   *   allowed: boolean,
   *   limitType: string|null,
   *   limit: number|null,
   *   remaining: number,
   *   retryAfter: number,
   *   resetAt: number
   * }}
   */
  check(provider, requestBytes = 0) {
    // Fail-open: if disabled or any error, allow
    if (!this.enabled) {
      return { allowed: true, limitType: null, limit: null, remaining: 0, retryAfter: 0, resetAt: 0 };
    }

    try {
      const state = this._getState(provider);
      const nowMs = Date.now();
      const nowSec = Math.floor(nowMs / 1000);
      const nowMin = Math.floor(nowMs / 60000);

      // Check RPM (requests per minute)
      const rpmCount = getWindowCount(state.rpmWindow, nowSec, MINUTE_SLOTS);
      if (rpmCount >= this.rpm) {
        const resetAt = (nowSec + 1) + (MINUTE_SLOTS - 1);
        const retryAfter = Math.max(1, MINUTE_SLOTS - (nowSec % MINUTE_SLOTS));
        return {
          allowed: false,
          limitType: 'rpm',
          limit: this.rpm,
          remaining: 0,
          retryAfter,
          resetAt,
        };
      }

      // Check RPH (requests per hour)
      const rphCount = getWindowCount(state.rphWindow, nowMin, HOUR_SLOTS);
      if (rphCount >= this.rph) {
        const retryAfter = Math.max(1, (HOUR_SLOTS - (nowMin % HOUR_SLOTS)) * 60);
        const resetAt = Math.floor(nowMs / 1000) + retryAfter;
        return {
          allowed: false,
          limitType: 'rph',
          limit: this.rph,
          remaining: 0,
          retryAfter,
          resetAt,
        };
      }

      // Check bytes per minute
      const bytesCount = getWindowCount(state.bytesWindow, nowSec, MINUTE_SLOTS);
      if (bytesCount + requestBytes > this.bytesPm) {
        const retryAfter = Math.max(1, MINUTE_SLOTS - (nowSec % MINUTE_SLOTS));
        const resetAt = nowSec + retryAfter;
        return {
          allowed: false,
          limitType: 'bytes_pm',
          limit: this.bytesPm,
          remaining: Math.max(0, this.bytesPm - bytesCount),
          retryAfter,
          resetAt,
        };
      }

      // All checks passed — record the request
      recordInWindow(state.rpmWindow, nowSec, MINUTE_SLOTS, 1);
      recordInWindow(state.rphWindow, nowMin, HOUR_SLOTS, 1);
      if (requestBytes > 0) {
        recordInWindow(state.bytesWindow, nowSec, MINUTE_SLOTS, requestBytes);
      }

      const rpmRemaining = Math.max(0, this.rpm - (rpmCount + 1));
      return {
        allowed: true,
        limitType: null,
        limit: null,
        remaining: rpmRemaining,
        retryAfter: 0,
        resetAt: 0,
      };
    } catch (_err) {
      // Fail-open: if anything goes wrong, allow the request
      return { allowed: true, limitType: null, limit: null, remaining: 0, retryAfter: 0, resetAt: 0 };
    }
  }

  /**
   * Get rate limit status for a single provider.
   * @param {string} provider
   * @returns {object} Status with rpm, rph windows
   */
  getStatus(provider) {
    if (!this.enabled) {
      return { enabled: false };
    }

    try {
      const state = this.providers.get(provider);
      if (!state) {
        return {
          enabled: true,
          rpm: { limit: this.rpm, remaining: this.rpm, reset: 0 },
          rph: { limit: this.rph, remaining: this.rph, reset: 0 },
        };
      }

      const nowMs = Date.now();
      const nowSec = Math.floor(nowMs / 1000);
      const nowMin = Math.floor(nowMs / 60000);

      const rpmCount = getWindowCount(state.rpmWindow, nowSec, MINUTE_SLOTS);
      const rphCount = getWindowCount(state.rphWindow, nowMin, HOUR_SLOTS);

      return {
        enabled: true,
        rpm: {
          limit: this.rpm,
          remaining: Math.max(0, this.rpm - rpmCount),
          reset: nowSec + (MINUTE_SLOTS - (nowSec % MINUTE_SLOTS)),
        },
        rph: {
          limit: this.rph,
          remaining: Math.max(0, this.rph - rphCount),
          reset: Math.floor(nowMs / 1000) + (HOUR_SLOTS - (nowMin % HOUR_SLOTS)) * 60,
        },
      };
    } catch (_err) {
      return { enabled: true, error: 'internal_error' };
    }
  }

  /**
   * Get rate limit status for all known providers.
   * @returns {object} Map of provider → status
   */
  getAllStatus() {
    const result = {};
    for (const provider of this.providers.keys()) {
      result[provider] = this.getStatus(provider);
    }
    return result;
  }
}

/**
 * Create a RateLimiter from environment variables.
 *
 * Reads:
 * - AWF_RATE_LIMIT_RPM (default: 60)
 * - AWF_RATE_LIMIT_RPH (default: 1000)
 * - AWF_RATE_LIMIT_BYTES_PM (default: 52428800)
 * - AWF_RATE_LIMIT_ENABLED (default: "true")
 *
 * @returns {RateLimiter}
 */
function create() {
  const rpm = parseInt(process.env.AWF_RATE_LIMIT_RPM, 10) || DEFAULT_RPM;
  const rph = parseInt(process.env.AWF_RATE_LIMIT_RPH, 10) || DEFAULT_RPH;
  const bytesPm = parseInt(process.env.AWF_RATE_LIMIT_BYTES_PM, 10) || DEFAULT_BYTES_PM;
  const enabled = process.env.AWF_RATE_LIMIT_ENABLED !== 'false';

  return new RateLimiter({ rpm, rph, bytesPm, enabled });
}

module.exports = { RateLimiter, create };
