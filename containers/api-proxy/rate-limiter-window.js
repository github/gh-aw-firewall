/**
 * Sliding-window ring-buffer data structure for rate counting.
 *
 * Pure circular-buffer math with no knowledge of rate-limit policy.
 * Used by rate-limiter.js to implement per-provider RPM, RPH, and
 * bytes-per-minute limits.
 */

'use strict';

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

module.exports = { createWindow, advanceWindow, recordInWindow, getWindowCount, estimateRetryAfter };
