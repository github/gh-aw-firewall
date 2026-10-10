'use strict';

const { ET_WARNING_THRESHOLDS } = require('./effective-token-guard');
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
  for (const threshold of ET_WARNING_THRESHOLDS) {
    if (percentElapsed >= threshold && !state.emittedThresholds.has(threshold)) {
      state.emittedThresholds.add(threshold);
      state.uninjectedThresholds.add(threshold);
    }
  }
}

function getPendingTimeoutSteeringWarning() {
  const timeoutMinutes = getTimeoutSteeringConfig();
  const state = getTimeoutSteeringState(timeoutMinutes);
  if (!state) return null;

  updateTimeoutSteeringThresholds(state, timeoutMinutes);
  if (state.uninjectedThresholds.size === 0) return null;

  const threshold = Math.max(...state.uninjectedThresholds);
  const text = TIMEOUT_STEERING_MESSAGES[threshold] ||
    `You have used ${threshold}% of your allotted run time.`;
  return { threshold, message: `[AWF TIME WARNING] ${text}` };
}

function acknowledgeTimeoutSteeringWarning(threshold) {
  timeoutSteeringState.uninjectedThresholds.delete(threshold);
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
    thresholds_pending: [...state.uninjectedThresholds].sort((a, b) => a - b),
  };
}

function resetTimeoutSteeringForTests() {
  timeoutSteeringState = createTimeoutSteeringState();
  timeoutSteeringConfigCache.rawMinutes = undefined;
  timeoutSteeringConfigCache.parsedMinutes = null;
}

module.exports = {
  getAndClearPendingTimeoutSteeringMessage,
  getPendingTimeoutSteeringWarning,
  acknowledgeTimeoutSteeringWarning,
  getTimeoutSteeringReflectState,
  resetTimeoutSteeringForTests,
};
