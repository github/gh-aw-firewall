'use strict';

let maxRunsGuardState = {
  configKey: null,
  invocationCount: 0,
};

const maxRunsConfigCache = {
  rawMax: undefined,
  parsed: null,
};

function parseMaxRuns(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function getMaxRunsConfig() {
  const rawMax = process.env.AWF_MAX_RUNS;
  if (maxRunsConfigCache.rawMax === rawMax) {
    return maxRunsConfigCache.parsed;
  }
  maxRunsConfigCache.rawMax = rawMax;
  maxRunsConfigCache.parsed = parseMaxRuns(rawMax);
  return maxRunsConfigCache.parsed;
}

function getMaxRunsState(max) {
  if (!max) return null;
  const configKey = String(max);
  if (maxRunsGuardState.configKey !== configKey) {
    maxRunsGuardState = { configKey, invocationCount: 0 };
  }
  return maxRunsGuardState;
}

function applyMaxRunsInvocation() {
  const max = getMaxRunsConfig();
  const state = getMaxRunsState(max);
  if (!state) return;
  state.invocationCount += 1;
}

function getMaxRunsBlockState() {
  const max = getMaxRunsConfig();
  const state = getMaxRunsState(max);
  if (!state) return null;
  return {
    maxRuns: max,
    invocationCount: state.invocationCount,
    maxExceeded: state.invocationCount >= max,
  };
}

function getMaxRunsReflectState() {
  const max = getMaxRunsConfig();
  const state = getMaxRunsState(max);
  if (!state) {
    return {
      enabled: false,
      max_runs: null,
      invocation_count: 0,
      remaining_runs: null,
    };
  }
  return {
    enabled: true,
    max_runs: max,
    invocation_count: state.invocationCount,
    remaining_runs: Math.max(0, max - state.invocationCount),
  };
}

function resetMaxRunsGuardForTests() {
  maxRunsGuardState = { configKey: null, invocationCount: 0 };
  maxRunsConfigCache.rawMax = undefined;
  maxRunsConfigCache.parsed = null;
}

function buildMaxRunsExceededError(state) {
  return {
    error: {
      type: 'max_runs_exceeded',
      message: `Maximum LLM invocations exceeded (${state.invocationCount} / ${state.maxRuns}).`,
      invocation_count: state.invocationCount,
      max_runs: state.maxRuns,
    },
  };
}

module.exports = {
  applyMaxRunsInvocation,
  getMaxRunsBlockState,
  getMaxRunsReflectState,
  resetMaxRunsGuardForTests,
  buildMaxRunsExceededError,
};
