'use strict';

const { ET_WARNING_THRESHOLDS } = require('./effective-token-guard');
const { parsePositiveInteger } = require('./guard-utils');

const TIMEOUT_STEERING_MESSAGES = {
  80: 'You have used 80% of your allotted run time. Begin planning to wrap up your current work.',
  90: 'You have used 90% of your allotted run time. Complete your current task and prepare final output.',
  95: 'You have used 95% of your allotted run time. Finalize and submit your work now.',
  99: 'You have used 99% of your allotted run time. You are about to time out. Submit immediately.',
};

function createTimeoutSteeringState(configKey = null, startTimeMs = Date.now()) {
  return {
    configKey,
    startTimeMs,
    emittedThresholds: new Set(),
    uninjectedThresholds: new Set(),
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

function getTimeoutSteeringState(timeoutMinutes) {
  if (!timeoutMinutes) return null;
  const configKey = String(timeoutMinutes);
  if (timeoutSteeringState.configKey !== configKey) {
    timeoutSteeringState = createTimeoutSteeringState(configKey);
  }
  return timeoutSteeringState;
}

function updateTimeoutSteeringThresholds(state, timeoutMinutes) {
  if (!state || !timeoutMinutes) return;
  const elapsedMs = Math.max(0, Date.now() - state.startTimeMs);
  const timeoutMs = timeoutMinutes * 60 * 1000;
  const percentElapsed = (elapsedMs / timeoutMs) * 100;
  for (const threshold of ET_WARNING_THRESHOLDS) {
    if (percentElapsed >= threshold && !state.emittedThresholds.has(threshold)) {
      state.emittedThresholds.add(threshold);
      state.uninjectedThresholds.add(threshold);
    }
  }
}

function getAndClearPendingTimeoutSteeringMessage() {
  const timeoutMinutes = getTimeoutSteeringConfig();
  const state = getTimeoutSteeringState(timeoutMinutes);
  if (!state) return null;

  updateTimeoutSteeringThresholds(state, timeoutMinutes);
  if (state.uninjectedThresholds.size === 0) return null;

  const maxThreshold = Math.max(...state.uninjectedThresholds);
  state.uninjectedThresholds.delete(maxThreshold);
  const text = TIMEOUT_STEERING_MESSAGES[maxThreshold] ||
    `You have used ${maxThreshold}% of your allotted run time.`;
  return `[AWF TIME WARNING] ${text}`;
}

function resetTimeoutSteeringForTests() {
  timeoutSteeringState = createTimeoutSteeringState();
  timeoutSteeringConfigCache.rawMinutes = undefined;
  timeoutSteeringConfigCache.parsedMinutes = null;
}

module.exports = {
  getAndClearPendingTimeoutSteeringMessage,
  resetTimeoutSteeringForTests,
};
