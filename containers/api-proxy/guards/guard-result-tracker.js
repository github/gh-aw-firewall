'use strict';

/**
 * AWF API Proxy — Guard Result Tracker.
 *
 * Tracks the evidence needed to distinguish a local AI-credits-limit
 * rejection (an AWF-enforced guard) from a real upstream 403 (a provider
 * authorization error). Both currently surface to the agent as a generic
 * HTTP 403, so this in-memory tracker records which one actually happened
 * while the proxy process is still alive.
 *
 * This state is intentionally proxy-internal: it is read by the trusted AWF
 * host process (via the `/guard-snapshot` management endpoint, see
 * `management.js`) after the agent has exited but before the proxy container
 * is removed. The agent itself has no route to this state — it is not
 * exposed on any provider-facing port.
 */

const crypto = require('crypto');
const metrics = require('../metrics');
const { getAiCreditsReflectState, getAiCreditsBlockState } = require('./ai-credits-guard');

/** Event name recorded by proxy-guards.js when the local AI-credits guard blocks a request. */
const LOCAL_AI_CREDITS_GUARD_EVENT = 'ai_credits_limit_exceeded';

/** Classification of the most recent guard-relevant event observed by the proxy. */
const FINAL_EVENT_LOCAL_LIMIT = 'local_ai_credits_limit';
const FINAL_EVENT_UPSTREAM_403 = 'upstream_403';

function createGuardResultState() {
  return {
    proxyId: crypto.randomUUID(),
    localAiCreditsLimitRejections: 0,
    upstream403Count: 0,
    finalEvent: null,
    finalEventAt: null,
  };
}

let state = createGuardResultState();

/**
 * Whether the host validated a caller-owned guard-result pipe
 * (`AWF_GUARD_RESULT_FD`) before starting the agent. Without it, this
 * tracker — and the `/guard-snapshot` endpoint that exposes it — must be
 * fully inert: no new code path is exercised on the request hot path when
 * the feature is unused. Read on every call (not cached at module load) so
 * tests can toggle it via `process.env`.
 *
 * @returns {boolean}
 */
function isGuardResultTrackingEnabled() {
  return process.env.AWF_GUARD_RESULT_ENABLED === '1';
}

/**
 * Records a local guard-block event. Only the AI-credits-limit event is
 * tracked here — other guards (max-runs, permission-denied, etc.) are not
 * relevant to the upstream-vs-local-403 ambiguity this tracker resolves.
 *
 * @param {string} eventName - The `eventName` passed to sendGuardBlockedResponse.
 */
function recordLocalGuardEvent(eventName) {
  if (!isGuardResultTrackingEnabled()) return;
  if (eventName !== LOCAL_AI_CREDITS_GUARD_EVENT) return;
  state.localAiCreditsLimitRejections += 1;
  state.finalEvent = FINAL_EVENT_LOCAL_LIMIT;
  state.finalEventAt = Date.now();
}

/**
 * Records an upstream response status code observed while relaying a
 * request to the real provider. Only 403 is tracked, matching the
 * ambiguity this tracker resolves (local rejection vs. upstream
 * authorization failure both surface as 403 to the agent).
 *
 * @param {number} statusCode
 */
function recordUpstreamStatus(statusCode) {
  if (!isGuardResultTrackingEnabled()) return;
  if (statusCode !== 403) return;
  state.upstream403Count += 1;
  state.finalEvent = FINAL_EVENT_UPSTREAM_403;
  state.finalEventAt = Date.now();
}

/**
 * Returns a point-in-time snapshot of the guard result state, safe to
 * serialize and return over the management endpoint. Contains only
 * classification facts — no prompts, credentials, headers, bodies, or
 * model content.
 *
 * @returns {object}
 */
function getGuardResultSnapshot() {
  const aiCredits = getAiCreditsReflectState();
  const blockState = getAiCreditsBlockState();
  return {
    proxy_id: state.proxyId,
    generated_at: Date.now(),
    active_requests: metrics.getSummary().active_requests,
    local_ai_credits_limit_rejections: state.localAiCreditsLimitRejections,
    upstream_403_count: state.upstream403Count,
    final_event: state.finalEvent,
    final_event_at: state.finalEventAt,
    ai_credits_total: aiCredits.total,
    ai_credits_max: blockState ? blockState.maxAiCredits : null,
  };
}

/** @internal Test-only reset. */
function resetGuardResultTrackerForTests() {
  state = createGuardResultState();
}

module.exports = {
  LOCAL_AI_CREDITS_GUARD_EVENT,
  FINAL_EVENT_LOCAL_LIMIT,
  FINAL_EVENT_UPSTREAM_403,
  isGuardResultTrackingEnabled,
  recordLocalGuardEvent,
  recordUpstreamStatus,
  getGuardResultSnapshot,
  resetGuardResultTrackerForTests,
};
