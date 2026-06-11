'use strict';

const { createCounterGuard } = require('./counter-guard');

const guard = createCounterGuard({
  envVar: 'AWF_MAX_RUNS',
  countField: 'invocationCount',
});

function applyMaxRunsInvocation() {
  guard.applyIncrement();
}

function getMaxRunsBlockState() {
  return guard.getBlockState('maxRuns');
}

function getMaxRunsReflectState() {
  const max = guard.getConfig();
  const state = guard.getState(max);
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
  guard.resetForTests();
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
