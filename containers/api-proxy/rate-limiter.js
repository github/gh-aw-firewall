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
const DEFAULT_RPM = 600;
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
  if (slotsToZero >= size) {
    // Full window expired — reset directly to avoid total drift
    win.counts.fill(0);
    win.total = 0;
  } else {
    for (let i = 1; i <= slotsToZero; i++) {
      const slot = (win.lastSlot + i) % size;
      win.total -= win.counts[slot];
      win.counts[slot] = 0;
    }
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
 * Get the current count in the sliding window.
 *
 * After advancing the window to zero out stale slots, returns the
 * sum of all active slot counts.
 *
 * @param {object} win - Window object
 * @param {number} now - Current time in the slot's unit
 * @param {number} size - Window size
 * @returns {number} Count of events in the current window
 */
function getWindowCount(win, now, size) {
  advanceWindow(win, now, size);
  return win.total;
}

/**
 * Estimate how many time-units until the window count drops below a threshold.
 *
 * Scans backwards from the oldest slot in the window to find the first
 * non-zero slot. That slot will expire in (its age remaining) time-units.
 *
 * @param {object} win - Window object (must be advanced to `now` first)
 * @param {number} now - Current time in the slot's unit
 * @param {number} size - Window size
 * @param {number} limit - The threshold to drop below
 * @returns {number} Estimated time-units until count < limit (minimum 1)
 */
function estimateRetryAfter(win, now, size, limit) {
  // Walk from the oldest slot (now - size + 1) forward, accumulating
  // how much capacity is freed as each slot expires.
  let freed = 0;
  for (let age = size - 1; age >= 0; age--) {
    const slot = ((now - age) % size + size) % size;
    freed += win.counts[slot];
    if (win.total - freed < limit) {
      // This slot expires in (age + 1) time-units from now
      return Math.max(1, age + 1);
    }
  }
  // Shouldn't happen if total >= limit, but fall back to full window
  return Math.max(1, size);
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
   * @param {number} [config.rpm=600] - Max requests per minute
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
        const retryAfter = estimateRetryAfter(state.rpmWindow, nowSec, MINUTE_SLOTS, this.rpm);
        const resetAt = nowSec + retryAfter;
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
        const retryAfterMin = estimateRetryAfter(state.rphWindow, nowMin, HOUR_SLOTS, this.rph);
        const retryAfter = retryAfterMin * 60; // convert minutes to seconds
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
        const retryAfter = estimateRetryAfter(state.bytesWindow, nowSec, MINUTE_SLOTS, this.bytesPm);
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

      const rpmRetry = rpmCount >= this.rpm
        ? estimateRetryAfter(state.rpmWindow, nowSec, MINUTE_SLOTS, this.rpm)
        : 0;
      const rphRetry = rphCount >= this.rph
        ? estimateRetryAfter(state.rphWindow, nowMin, HOUR_SLOTS, this.rph) * 60
        : 0;

      return {
        enabled: true,
        rpm: {
          limit: this.rpm,
          remaining: Math.max(0, this.rpm - rpmCount),
          reset: rpmRetry > 0 ? nowSec + rpmRetry : 0,
        },
        rph: {
          limit: this.rph,
          remaining: Math.max(0, this.rph - rphCount),
          reset: rphRetry > 0 ? Math.floor(nowMs / 1000) + rphRetry : 0,
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
 * - AWF_RATE_LIMIT_ENABLED (default: "false" — rate limiting is opt-in)
 *
 * @returns {RateLimiter}
 */
function create() {
  const rawRpm = parseInt(process.env.AWF_RATE_LIMIT_RPM, 10);
  const rawRph = parseInt(process.env.AWF_RATE_LIMIT_RPH, 10);
  const rawBytesPm = parseInt(process.env.AWF_RATE_LIMIT_BYTES_PM, 10);

  const rpm = (Number.isFinite(rawRpm) && rawRpm > 0) ? rawRpm : DEFAULT_RPM;
  const rph = (Number.isFinite(rawRph) && rawRph > 0) ? rawRph : DEFAULT_RPH;
  const bytesPm = (Number.isFinite(rawBytesPm) && rawBytesPm > 0) ? rawBytesPm : DEFAULT_BYTES_PM;
  const enabled = process.env.AWF_RATE_LIMIT_ENABLED === 'true';

  return new RateLimiter({ rpm, rph, bytesPm, enabled });
}

module.exports = { RateLimiter, create };
