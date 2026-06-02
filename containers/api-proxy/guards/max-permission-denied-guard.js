'use strict';

const { parsePositiveInteger } = require('./guard-utils');

let permDeniedGuardState = {
  configKey: null,
  deniedCount: 0,
};

const permDeniedConfigCache = {
  rawMax: undefined,
  parsed: null,
};

function getPermDeniedConfig() {
  const rawMax = process.env.AWF_MAX_PERMISSION_DENIED;
  if (permDeniedConfigCache.rawMax === rawMax) {
    return permDeniedConfigCache.parsed;
  }
  permDeniedConfigCache.rawMax = rawMax;
  permDeniedConfigCache.parsed = parsePositiveInteger(rawMax);
  return permDeniedConfigCache.parsed;
}

function getPermDeniedState(max) {
  if (!max) return null;
  const configKey = String(max);
  if (permDeniedGuardState.configKey !== configKey) {
    permDeniedGuardState = { configKey, deniedCount: 0 };
  }
  return permDeniedGuardState;
}

function applyPermissionDenied() {
  const max = getPermDeniedConfig();
  const state = getPermDeniedState(max);
  if (!state) return;
  state.deniedCount += 1;
}

function getPermissionDeniedBlockState() {
  const max = getPermDeniedConfig();
  const state = getPermDeniedState(max);
  if (!state) return null;
  return {
    maxPermissionDenied: max,
    deniedCount: state.deniedCount,
    maxExceeded: state.deniedCount >= max,
  };
}

function getPermissionDeniedReflectState() {
  const max = getPermDeniedConfig();
  const state = getPermDeniedState(max);
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
  permDeniedGuardState = { configKey: null, deniedCount: 0 };
  permDeniedConfigCache.rawMax = undefined;
  permDeniedConfigCache.parsed = null;
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
