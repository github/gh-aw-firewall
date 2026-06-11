'use strict';

const { createCounterGuard } = require('./counter-guard');

const guard = createCounterGuard({
  envVar: 'AWF_MAX_PERMISSION_DENIED',
  countField: 'deniedCount',
});

function applyPermissionDenied() {
  guard.applyIncrement();
}

function getPermissionDeniedBlockState() {
  return guard.getBlockState('maxPermissionDenied');
}

function getPermissionDeniedReflectState() {
  const max = guard.getConfig();
  const state = guard.getState(max);
  if (!state) {
    return {
      enabled: false,
      max_permission_denied: null,
      denied_count: 0,
    };
  }
  return {
    enabled: true,
    max_permission_denied: max,
    denied_count: state.deniedCount,
  };
}

function resetPermissionDeniedGuardForTests() {
  guard.resetForTests();
}

function buildPermissionDeniedLimitError(state) {
  return {
    error: {
      type: 'permission_denied_limit_exceeded',
      message: `Permission denied limit exceeded (${state.deniedCount} / ${state.maxPermissionDenied}). ` +
        'The run has been stopped due to repeated permission errors — check that all API keys and tokens are correctly configured.',
      denied_count: state.deniedCount,
      max_permission_denied: state.maxPermissionDenied,
    },
  };
}

module.exports = {
  applyPermissionDenied,
  getPermissionDeniedBlockState,
  getPermissionDeniedReflectState,
  resetPermissionDeniedGuardForTests,
  buildPermissionDeniedLimitError,
};
