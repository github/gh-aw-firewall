'use strict';

const {
  BUDGET_WARNING_THRESHOLDS,
  STEERING_DIRECTIVE,
  LITTLE_LEFT_MIN_PERCENT,
  littleLeftSteeringRank,
  describeSteeringRank,
  steeringThresholdsOnly,
  createSteeringDeliveryState,
  selectSteeringThreshold,
  acknowledgeSteeringThreshold,
  claimSteeringThreshold,
  resetSteeringConversationSecretForTests,
} = require('./steering-thresholds');
const { parsePositiveInteger } = require('./guard-utils');
const fs = require('fs');

const MS_PER_MINUTE = 60 * 1000;
/** The "little left" time notice fires once about this many minutes remain. */
const LITTLE_LEFT_MINUTES = 5;

function createTimeoutSteeringState(configKey = null, startTimeMs = null) {
  return {
    configKey,
    startTimeMs,
    emittedThresholds: new Set(),
    littleLeftRank: null,
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
  const timeoutMs = timeoutMinutes * MS_PER_MINUTE;
  const percentElapsed = (elapsedMs / timeoutMs) * 100;
  for (const threshold of BUDGET_WARNING_THRESHOLDS) {
    if (percentElapsed >= threshold && !state.emittedThresholds.has(threshold)) {
      state.emittedThresholds.add(threshold);
      state.delivery.pending.add(threshold);
    }
  }
  // "Little left": about five minutes remain, once at least half the deadline
  // has passed; at most once per run.
  if (state.littleLeftRank === null && percentElapsed >= LITTLE_LEFT_MIN_PERCENT &&
    timeoutMs - elapsedMs <= LITTLE_LEFT_MINUTES * MS_PER_MINUTE) {
    state.littleLeftRank = littleLeftSteeringRank(state.emittedThresholds);
    state.emittedThresholds.add(state.littleLeftRank);
    state.delivery.pending.add(state.littleLeftRank);
  }
}

function minutes(count) {
  return `${count} ${count === 1 ? 'minute' : 'minutes'}`;
}

/**
 * Facts of a time notice, from the current time: "16 of 20 minutes have
 * passed; about 4 minutes remain."
 */
function buildTimeoutSteeringMessage(state, timeoutMinutes) {
  const elapsedMs = Math.max(0, Date.now() - state.startTimeMs);
  const remainingMs = Math.max(0, timeoutMinutes * MS_PER_MINUTE - elapsedMs);
  const elapsedMinutes = Math.min(timeoutMinutes, Math.floor(elapsedMs / MS_PER_MINUTE));
  const remainingMinutes = remainingMs < MS_PER_MINUTE ? 0 : Math.round(remainingMs / MS_PER_MINUTE);
  const remaining = remainingMinutes === 0
    ? 'less than a minute remains'
    : `about ${minutes(remainingMinutes)} ${remainingMinutes === 1 ? 'remains' : 'remain'}`;
  return `[AWF TIME WARNING] ${elapsedMinutes} of ${minutes(timeoutMinutes)} ` +
    `${elapsedMinutes === 1 ? 'has' : 'have'} passed; ${remaining}. ${STEERING_DIRECTIVE}`;
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
  const rank = selectSteeringThreshold(state.delivery, state.emittedThresholds, conversation);
  if (rank === null) return null;
  return { ...describeSteeringRank(rank), message: buildTimeoutSteeringMessage(state, timeoutMinutes) };
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

/** @param {number} rank - Notice rank (warning.rank) */
function acknowledgeTimeoutSteeringWarning(rank) {
  acknowledgeSteeringThreshold(timeoutSteeringState.delivery.pending, rank);
}

/** @param {number} rank - Notice rank (warning.rank) */
function claimTimeoutSteeringWarning(rank, conversation = null) {
  return claimSteeringThreshold(timeoutSteeringState.delivery, rank, conversation);
}

function getAndClearPendingTimeoutSteeringMessage() {
  const warning = getPendingTimeoutSteeringWarning();
  if (!warning) return null;
  acknowledgeTimeoutSteeringWarning(warning.rank);
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
      little_left_triggered: false,
    };
  }
  updateTimeoutSteeringThresholds(state, timeoutMinutes);
  const elapsedMs = Math.max(0, Date.now() - state.startTimeMs);
  const percentElapsed = Math.min(100, (elapsedMs / (timeoutMinutes * MS_PER_MINUTE)) * 100);
  return {
    enabled: true,
    timeout_minutes: timeoutMinutes,
    started_at_ms: state.startTimeMs,
    percent_elapsed: Math.round(percentElapsed * 100) / 100,
    thresholds_crossed: steeringThresholdsOnly(state.emittedThresholds),
    thresholds_pending: steeringThresholdsOnly(state.delivery.pending),
    little_left_triggered: state.littleLeftRank !== null,
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
