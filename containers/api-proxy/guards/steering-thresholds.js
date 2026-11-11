'use strict';

const BUDGET_WARNING_THRESHOLDS = [80, 90, 95, 99];

/**
 * Select the next budget notice to deliver for one notice kind.
 *
 * A pending threshold is only eligible when it is higher than every notice of
 * the same kind that is still in flight, so an older notice never follows a
 * newer one and concurrent requests do not repeat an undelivered notice.
 *
 * @param {Set<number>} pending - Crossed thresholds not yet delivered
 * @param {Map<number, number>} inFlight - Threshold -> in-flight request count
 * @returns {number|null}
 */
function selectPendingSteeringThreshold(pending, inFlight) {
  const floor = inFlight.size > 0 ? Math.max(...inFlight.keys()) : -Infinity;
  let threshold = null;
  for (const candidate of pending) {
    if (candidate > floor && (threshold === null || candidate > threshold)) threshold = candidate;
  }
  return threshold;
}

/** Mark a notice as delivered and drop older pending notices it supersedes. */
function acknowledgeSteeringThreshold(pending, threshold) {
  for (const candidate of pending) {
    if (candidate <= threshold) pending.delete(candidate);
  }
}

/**
 * Reserve a notice for a request carrying it. The returned handle settles
 * once: `acknowledge()` after the request succeeds (dropping the notice and
 * any older pending ones), or `release()` after it fails, leaving the notice
 * pending for the next request.
 *
 * @param {Set<number>} pending
 * @param {Map<number, number>} inFlight
 * @param {number} threshold
 * @returns {{ acknowledge: () => void, release: () => void }}
 */
function claimSteeringThreshold(pending, inFlight, threshold) {
  inFlight.set(threshold, (inFlight.get(threshold) || 0) + 1);
  let settled = false;
  const settle = (delivered) => {
    if (settled) return;
    settled = true;
    const remaining = (inFlight.get(threshold) || 1) - 1;
    if (remaining > 0) inFlight.set(threshold, remaining);
    else inFlight.delete(threshold);
    if (delivered) acknowledgeSteeringThreshold(pending, threshold);
  };
  return Object.freeze({
    acknowledge: () => settle(true),
    release: () => settle(false),
  });
}

module.exports = {
  BUDGET_WARNING_THRESHOLDS,
  selectPendingSteeringThreshold,
  acknowledgeSteeringThreshold,
  claimSteeringThreshold,
};
