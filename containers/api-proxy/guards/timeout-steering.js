'use strict';

const {
  BUDGET_WARNING_THRESHOLDS,
  createSteeringDeliveryState,
  selectSteeringThreshold,
  acknowledgeSteeringThreshold,
  claimSteeringThreshold,
  resetSteeringConversationSecretForTests,
} = require('./steering-thresholds');
const { parsePositiveInteger } = require('./guard-utils');
const fs = require('fs');

const TIMEOUT_STEERING_MESSAGES = {
  80: 'You have used 80% of your allotted run time. Begin planning to wrap up your current work.',
  90: 'You have used 90% of your allotted run time. Complete your current task and prepare final output.',
  95: 'You have used 95% of your allotted run time. Finalize and submit your work now.',
  99: 'You have used 99% of your allotted run time. You are about to time out. Submit immediately.',
};

function createTimeoutSteeringState(configKey = null, startTimeMs = null) {
  return {
    configKey,
    startTimeMs,
    emittedThresholds: new Set(),
    delivery: createSteeringDeliveryState(),
  };
}

let timeoutSteeringState = createTimeoutSteeringState();

const timeoutSteeringConfigCache = {
  rawMinutes: undefined,
  parsedMinutes: null,
};

function getTimeoutSteeringConfig() {
  const rawMinutes = process.env.AWF_AGENT_TIMEOUT_MINUTES;
  if (timeoutSteeringConfigCache.rawMinutes === rawMinutes) {
    return timeoutSteeringConfigCache.parsedMinutes;
  }
  timeoutSteeringConfigCache.rawMinutes = rawMinutes;
  timeoutSteeringConfigCache.parsedMinutes = parsePositiveInteger(rawMinutes);
  return timeoutSteeringConfigCache.parsedMinutes;
}

function readAgentStartTimeMs() {
  const startFile = process.env.AWF_AGENT_RUNTIME_START_FILE;
  if (!startFile) return null;
  try {
    const startTimeMs = Number(fs.readFileSync(startFile, 'utf8').trim());
    return Number.isFinite(startTimeMs) && startTimeMs > 0 ? startTimeMs : null;
  } catch {
    return null;
  }
}

function getTimeoutSteeringState(timeoutMinutes) {
  if (!timeoutMinutes) return null;
  const startTimeMs = readAgentStartTimeMs();
  if (startTimeMs === null) return null;
  const configKey = `${timeoutMinutes}|${startTimeMs}`;
  if (timeoutSteeringState.configKey !== configKey) {
    timeoutSteeringState = createTimeoutSteeringState(configKey, startTimeMs);
  }
  return timeoutSteeringState;
}

function updateTimeoutSteeringThresholds(state, timeoutMinutes) {
  if (!state || !timeoutMinutes) return;
  const elapsedMs = Math.max(0, Date.now() - state.startTimeMs);
  const timeoutMs = timeoutMinutes * 60 * 1000;
  const percentElapsed = (elapsedMs / timeoutMs) * 100;
  for (const threshold of BUDGET_WARNING_THRESHOLDS) {
    if (percentElapsed >= threshold && !state.emittedThresholds.has(threshold)) {
      state.emittedThresholds.add(threshold);
      state.delivery.pending.add(threshold);
    }
  }
}

/**
 * @param {string|null} [conversation] - Conversation key; omit for the
 *   run-level notice (each notice once per run).
 */
function getPendingTimeoutSteeringWarning(conversation = null) {
  const timeoutMinutes = getTimeoutSteeringConfig();
  const state = getTimeoutSteeringState(timeoutMinutes);
  if (!state) return null;

  updateTimeoutSteeringThresholds(state, timeoutMinutes);
  const threshold = selectSteeringThreshold(state.delivery, state.emittedThresholds, conversation);
  if (threshold === null) return null;

  const text = TIMEOUT_STEERING_MESSAGES[threshold] ||
    `You have used ${threshold}% of your allotted run time.`;
  return { threshold, message: `[AWF TIME WARNING] ${text}` };
}

/**
 * Whether any time threshold has been crossed in this run, updating the
 * crossed thresholds first. Unlike the run-level pending notices, this stays
 * true after a notice is delivered, since other conversations may still need it.
 */
function hasCrossedTimeoutSteeringThreshold() {
  const timeoutMinutes = getTimeoutSteeringConfig();
  const state = getTimeoutSteeringState(timeoutMinutes);
  if (!state) return false;
  updateTimeoutSteeringThresholds(state, timeoutMinutes);
  return state.emittedThresholds.size > 0;
}

function acknowledgeTimeoutSteeringWarning(threshold) {
  acknowledgeSteeringThreshold(timeoutSteeringState.delivery.pending, threshold);
}

function claimTimeoutSteeringWarning(threshold, conversation = null) {
  return claimSteeringThreshold(timeoutSteeringState.delivery, threshold, conversation);
}

function getAndClearPendingTimeoutSteeringMessage() {
  const warning = getPendingTimeoutSteeringWarning();
  if (!warning) return null;
  acknowledgeTimeoutSteeringWarning(warning.threshold);
  return warning.message;
}

function getTimeoutSteeringReflectState() {
  const timeoutMinutes = getTimeoutSteeringConfig();
  const state = getTimeoutSteeringState(timeoutMinutes);
  if (!state) {
    return {
      enabled: Boolean(timeoutMinutes),
      timeout_minutes: timeoutMinutes,
      started_at_ms: null,
      percent_elapsed: 0,
      thresholds_crossed: [],
      thresholds_pending: [],
    };
  }
  updateTimeoutSteeringThresholds(state, timeoutMinutes);
  const elapsedMs = Math.max(0, Date.now() - state.startTimeMs);
  const percentElapsed = Math.min(100, (elapsedMs / (timeoutMinutes * 60 * 1000)) * 100);
  return {
    enabled: true,
    timeout_minutes: timeoutMinutes,
    started_at_ms: state.startTimeMs,
    percent_elapsed: Math.round(percentElapsed * 100) / 100,
    thresholds_crossed: [...state.emittedThresholds].sort((a, b) => a - b),
    thresholds_pending: [...state.delivery.pending].sort((a, b) => a - b),
  };
}

function resetTimeoutSteeringForTests() {
  resetSteeringConversationSecretForTests();
  timeoutSteeringState = createTimeoutSteeringState();
  timeoutSteeringConfigCache.rawMinutes = undefined;
  timeoutSteeringConfigCache.parsedMinutes = null;
}

module.exports = {
  getAndClearPendingTimeoutSteeringMessage,
  getPendingTimeoutSteeringWarning,
  hasCrossedTimeoutSteeringThreshold,
  acknowledgeTimeoutSteeringWarning,
  claimTimeoutSteeringWarning,
  getTimeoutSteeringReflectState,
  resetTimeoutSteeringForTests,
};
